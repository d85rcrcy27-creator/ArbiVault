import { createClient } from 'npm:@supabase/supabase-js@2.117.2'

const url = Deno.env.get('SUPABASE_URL')!
const anonKey = Deno.env.get('SUPABASE_ANON_KEY')!
const admin = createClient(url, Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!)
const corsHeaders = {
  'Access-Control-Allow-Origin': 'https://arbivault.vercel.app',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
  'Access-Control-Allow-Methods': 'POST, OPTIONS',
  'Vary': 'Origin',
}

const json = (value: unknown, status = 200) =>
  Response.json(value, { status, headers: { ...corsHeaders, 'cache-control': 'no-store' } })

const PAIRS = [
  { chain: 'solana', pair: 'SOL/USDT', symbol: 'SOLUSDT', okx: 'SOL-USDT' },
  { chain: 'bnb', pair: 'BNB/USDT', symbol: 'BNBUSDT', okx: 'BNB-USDT' },
]

const EXCHANGES = ['binance', 'bybit', 'okx']
const QUALIFYING_SPREAD_PCT = 0.5

async function fetchJson(input: string) {
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), 1800)
  try {
    const response = await fetch(input, {
      signal: controller.signal,
      headers: { accept: 'application/json' },
    })
    if (!response.ok) throw new Error(`market_http_${response.status}`)
    return await response.json()
  } finally {
    clearTimeout(timer)
  }
}

async function quote(exchange: string, pair: typeof PAIRS[number]) {
  const started = performance.now()
  try {
    if (exchange === 'binance') {
      const j = await fetchJson(`https://api.binance.com/api/v3/ticker/bookTicker?symbol=${pair.symbol}`)
      return { exchange, bid: Number(j.bidPrice), ask: Number(j.askPrice), latencyMs: Math.round(performance.now() - started) }
    }
    if (exchange === 'bybit') {
      const j = await fetchJson(`https://api.bybit.com/v5/market/tickers?category=spot&symbol=${pair.symbol}`)
      const t = j?.result?.list?.[0]
      return t ? { exchange, bid: Number(t.bid1Price), ask: Number(t.ask1Price), latencyMs: Math.round(performance.now() - started) } : null
    }
    const j = await fetchJson(`https://www.okx.com/api/v5/market/ticker?instId=${pair.okx}`)
    const t = j?.data?.[0]
    return t ? { exchange, bid: Number(t.bidPx), ask: Number(t.askPx) } : null
  } catch {
    return null
  }
}

async function buildRoute(pair: typeof PAIRS[number]) {
  const quotes = (await Promise.all(EXCHANGES.map((exchange) => quote(exchange, pair))))
    .filter((item): item is { exchange: string; bid: number; ask: number; latencyMs: number } =>
      !!item && Number.isFinite(item.bid) && Number.isFinite(item.ask) && item.ask > 0
    )
  if (quotes.length < 2) return null

  const bestBuy = quotes.reduce((best, item) => item.ask < best.ask ? item : best)
  const bestSell = quotes.reduce((best, item) => item.bid > best.bid ? item : best)
  if (bestBuy.exchange === bestSell.exchange) return null

  const spreadPct = ((bestSell.bid - bestBuy.ask) / bestBuy.ask) * 100
  if (!Number.isFinite(spreadPct)) return null

  return {
    id: `${pair.chain}-${bestBuy.exchange}-${bestSell.exchange}`,
    chain: pair.chain,
    pair: pair.pair,
    buyExchange: bestBuy.exchange,
    sellExchange: bestSell.exchange,
    buyPrice: bestBuy.ask,
    sellPrice: bestSell.bid,
    spreadPct,
    qualifying: spreadPct >= QUALIFYING_SPREAD_PCT,
    latency: Math.max(...quotes.map((quote) => quote.latencyMs)),
    history: [{ t: Date.now(), v: spreadPct }],
    quotes,
  }
}

Deno.serve(async (req) => {
  if (req.method === 'OPTIONS') return new Response('ok', { status: 200, headers: corsHeaders })
  if (req.method !== 'POST') return json({ error: 'method_not_allowed' }, 405)

  try {
    const authHeader = req.headers.get('Authorization') ?? ''
    const client = createClient(url, anonKey, { global: { headers: { Authorization: authHeader } } })
    const { data: { user }, error } = await client.auth.getUser()
    if (error || !user) return json({ error: 'authentication_required' }, 401)

    const body = await req.json().catch(() => ({}))
    const requestedThreshold = Number(body?.qualifying_spread_pct)
    const qualifyingThreshold = Number.isFinite(requestedThreshold)
      ? Math.max(0.05, Math.min(10, requestedThreshold))
      : QUALIFYING_SPREAD_PCT

    const routeResults = await Promise.all(PAIRS.map(buildRoute))
    const routes = routeResults.filter(Boolean).map((route) => ({
      ...route,
      qualifying: route.spreadPct >= qualifyingThreshold,
    }))
    const successfulQuotes = routes.flatMap((route) => route.quotes || [])
    const averageLatency = successfulQuotes.length
      ? Math.round(successfulQuotes.reduce((sum, quote) => sum + Number(quote.latencyMs || 0), 0) / successfulQuotes.length)
      : 0
    const feeds = [...new Set(successfulQuotes.map((quote) => quote.exchange))]
    return json({
      ok: true,
      timestamp_ms: Date.now(),
      qualifying_spread_pct: qualifyingThreshold,
      latency_ms: averageLatency,
      routes,
      feeds,
      source: 'public_exchange_order_books',
    })
  } catch (error) {
    await admin.from('security_alerts').insert({
      owner_id: null,
      alert_type: 'security',
      severity: 'warning',
      dedupe_key: `market-scout:${new Date().toISOString().slice(0, 16)}`,
      title: 'Market scout failure',
      message: error instanceof Error ? error.message : 'market_scout_failed',
      requires_user_authorization: false,
    }).then(() => undefined).catch(() => undefined)
    return json({ error: error instanceof Error ? error.message : 'market_scout_failed' }, 500)
  }
})
