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
  { chain: 'bitcoin', pair: 'BTC/USDT', symbol: 'BTCUSDT', okx: 'BTC-USDT', kraken: 'XBTUSDT', kucoin: 'BTC-USDT', gateio: 'BTC_USDT' },
  { chain: 'ethereum', pair: 'ETH/USDT', symbol: 'ETHUSDT', okx: 'ETH-USDT', kraken: 'ETHUSDT', kucoin: 'ETH-USDT', gateio: 'ETH_USDT' },
  { chain: 'solana', pair: 'SOL/USDT', symbol: 'SOLUSDT', okx: 'SOL-USDT', kraken: 'SOLUSDT', kucoin: 'SOL-USDT', gateio: 'SOL_USDT' },
  { chain: 'bnb', pair: 'BNB/USDT', symbol: 'BNBUSDT', okx: 'BNB-USDT', kraken: 'BNBUSDT', kucoin: 'BNB-USDT', gateio: 'BNB_USDT' },
  { chain: 'ethereum', pair: 'XRP/USDT', symbol: 'XRPUSDT', okx: 'XRP-USDT', kraken: 'XRPUSDT', kucoin: 'XRP-USDT', gateio: 'XRP_USDT' },
  { chain: 'ethereum', pair: 'ADA/USDT', symbol: 'ADAUSDT', okx: 'ADA-USDT', kraken: 'ADAUSDT', kucoin: 'ADA-USDT', gateio: 'ADA_USDT' },
  { chain: 'ethereum', pair: 'AVAX/USDT', symbol: 'AVAXUSDT', okx: 'AVAX-USDT', kraken: 'AVAXUSDT', kucoin: 'AVAX-USDT', gateio: 'AVAX_USDT' },
  { chain: 'ethereum', pair: 'LINK/USDT', symbol: 'LINKUSDT', okx: 'LINK-USDT', kraken: 'LINKUSDT', kucoin: 'LINK-USDT', gateio: 'LINK_USDT' },
  { chain: 'ethereum', pair: 'DOGE/USDT', symbol: 'DOGEUSDT', okx: 'DOGE-USDT', kraken: 'DOGEUSDT', kucoin: 'DOGE-USDT', gateio: 'DOGE_USDT' },
]

const EXCHANGES = ['binance', 'bybit', 'okx', 'kraken', 'kucoin', 'gateio']
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
    if (exchange === 'okx') {
      const j = await fetchJson(`https://www.okx.com/api/v5/market/ticker?instId=${pair.okx}`)
      const t = j?.data?.[0]
      return t ? { exchange, bid: Number(t.bidPx), ask: Number(t.askPx), latencyMs: Math.round(performance.now() - started) } : null
    }
    if (exchange === 'kraken') {
      const j = await fetchJson(`https://api.kraken.com/0/public/Ticker?pair=${pair.kraken}`)
      const t = Object.values(j?.result || {})[0] as any
      return t ? { exchange, bid: Number(t.b?.[0]), ask: Number(t.a?.[0]), latencyMs: Math.round(performance.now() - started) } : null
    }
    if (exchange === 'kucoin') {
      const j = await fetchJson(`https://api.kucoin.com/api/v1/market/orderbook/level1?symbol=${pair.kucoin}`)
      const t = j?.data
      return t ? { exchange, bid: Number(t.bestBid), ask: Number(t.bestAsk), latencyMs: Math.round(performance.now() - started) } : null
    }
    const j = await fetchJson(`https://api.gateio.ws/api/v4/spot/tickers?currency_pair=${pair.gateio}`)
    const t = j?.[0]
    return t ? { exchange, bid: Number(t.highest_bid), ask: Number(t.lowest_ask), latencyMs: Math.round(performance.now() - started) } : null
  } catch {
    return null
  }
}

async function rpcHealth() {
  const checks = await Promise.all([
    (async () => {
      const started = performance.now()
      try {
        const response = await fetch('https://cloudflare-eth.com', {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ jsonrpc: '2.0', id: Date.now(), method: 'eth_blockNumber', params: [] }),
        })
        const j = await response.json()
        return { chain: 'ethereum', ok: response.ok && typeof j?.result === 'string', latencyMs: Math.round(performance.now() - started), transport: 'json-rpc' }
      } catch { return { chain: 'ethereum', ok: false, latencyMs: Math.round(performance.now() - started), transport: 'json-rpc' } }
    })(),
    (async () => {
      const started = performance.now()
      try {
        const controller = new AbortController()
        const timer = setTimeout(() => controller.abort(), 1800)
        const response = await fetch('https://bsc-dataseed.binance.org', {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ jsonrpc: '2.0', id: Date.now(), method: 'eth_blockNumber', params: [] }),
          signal: controller.signal,
        })
        clearTimeout(timer)
        const j = await response.json()
        return { chain: 'bnb', ok: response.ok && !!j?.result, latencyMs: Math.round(performance.now() - started), transport: 'json-rpc' }
      } catch { return { chain: 'bnb', ok: false, latencyMs: Math.round(performance.now() - started), transport: 'json-rpc' } }
    })(),
    (async () => {
      const started = performance.now()
      try {
        const j = await fetch('https://api.mainnet-beta.solana.com', {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ jsonrpc: '2.0', id: Date.now(), method: 'getLatestBlockhash', params: [] }),
        }).then((r) => r.json())
        return { chain: 'solana', ok: !!j?.result?.value?.blockhash, latencyMs: Math.round(performance.now() - started), transport: 'json-rpc' }
      } catch { return { chain: 'solana', ok: false, latencyMs: Math.round(performance.now() - started), transport: 'json-rpc' } }
    })(),
    (async () => {
      const started = performance.now()
      try {
        const response = await fetch('https://mempool.space/api/blocks/tip/height')
        return { chain: 'bitcoin', ok: response.ok, latencyMs: Math.round(performance.now() - started), transport: 'rest-rpc' }
      } catch { return { chain: 'bitcoin', ok: false, latencyMs: Math.round(performance.now() - started), transport: 'rest-rpc' } }
    })(),
  ])
  return checks
}

async function buildRoute(pair: typeof PAIRS[number]) {
  const quotes = (await Promise.all(EXCHANGES.map((exchange) => quote(exchange, pair))))
    .filter((item): item is { exchange: string; bid: number; ask: number; latencyMs: number } =>
      !!item && Number.isFinite(item.bid) && Number.isFinite(item.ask) && item.ask > 0
    )

  const snapshot = {
    chain: pair.chain,
    pair: pair.pair,
    quotes,
    quote_count: quotes.length,
    timestamp_ms: Date.now(),
    best_buy: null as { exchange: string; price: number } | null,
    best_sell: null as { exchange: string; price: number } | null,
    spread_pct: null as number | null,
    latency: quotes.length ? Math.max(...quotes.map((quote) => quote.latencyMs)) : 0,
  }

  if (quotes.length < 1) return { route: null, snapshot }

  const bestBuy = quotes.reduce((best, item) => item.ask < best.ask ? item : best)
  const bestSell = quotes.reduce((best, item) => item.bid > best.bid ? item : best)
  snapshot.best_buy = { exchange: bestBuy.exchange, price: bestBuy.ask }
  snapshot.best_sell = { exchange: bestSell.exchange, price: bestSell.bid }

  if (quotes.length < 2 || bestBuy.exchange === bestSell.exchange) {
    return { route: null, snapshot }
  }

  const spreadPct = ((bestSell.bid - bestBuy.ask) / bestBuy.ask) * 100
  if (!Number.isFinite(spreadPct)) return { route: null, snapshot }
  snapshot.spread_pct = spreadPct

  return {
    route: {
      id: `${pair.chain}-${bestBuy.exchange}-${bestSell.exchange}`,
      chain: pair.chain,
      pair: pair.pair,
      buyExchange: bestBuy.exchange,
      sellExchange: bestSell.exchange,
      buyPrice: bestBuy.ask,
      sellPrice: bestSell.bid,
      spreadPct,
      qualifying: spreadPct >= QUALIFYING_SPREAD_PCT,
      latency: snapshot.latency,
      history: [{ t: Date.now(), v: spreadPct }],
      quotes,
    },
    snapshot,
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
    const snapshots = routeResults.map((item) => item.snapshot)
    const marketRoutes = routeResults
      .map((item) => item.route)
      .filter(Boolean)
      .map((route) => ({
        ...route,
        qualifying: route.spreadPct >= qualifyingThreshold,
      }))

    // Persist observed market routes and explicitly link them to the strategy
    // bot plus a separate executable strategy route. Observation never grants
    // permission to trade; downstream builder/signer gates remain authoritative.
    const [{ data: routeCatalog }, { data: strategyBots }, { data: executionBots }] = await Promise.all([
      admin.from('arbivault_strategy_routes')
        .select('id,strategy,strategy_bot_id,chain,pair,route_type,enabled,discovery_only,transaction_builder,builder_enabled,builder_status')
        .eq('enabled', true),
      admin.from('arbivault_strategy_bots')
        .select('id,strategy,enabled,execution_enabled')
        .eq('enabled', true)
        .eq('execution_enabled', true),
      admin.from('bot_configs')
        .select('id,owner_id,bot_role,enabled,autonomy_enabled,autonomy_mode')
        .eq('owner_id', user.id)
        .eq('bot_role', 'execution')
        .eq('enabled', true),
    ])

    const strategyBotIds = new Set((strategyBots || []).map((bot: any) => bot.id))
    const executionBot = (executionBots || [])[0] || null

    const linkedRoutes = marketRoutes.map((route: any) => {
      const observedRoute = (routeCatalog || []).find((candidate: any) =>
        candidate.chain === route.chain &&
        candidate.pair === route.pair &&
        candidate.route_type === 'orderbook' &&
        candidate.strategy_bot_id &&
        strategyBotIds.has(candidate.strategy_bot_id)
      ) || null

      const executionRoute = (routeCatalog || [])
        .filter((candidate: any) =>
          candidate.chain === route.chain &&
          candidate.pair === route.pair &&
          candidate.enabled === true &&
          candidate.strategy_bot_id &&
          strategyBotIds.has(candidate.strategy_bot_id) &&
          candidate.builder_enabled === true &&
          !!candidate.transaction_builder &&
          ['dex_cex', 'cyclic', 'multi_venue'].includes(candidate.route_type)
        )
        .sort((a: any, b: any) => Number(b.builder_enabled) - Number(a.builder_enabled))[0] || null

      return {
        ...route,
        observed_route_id: observedRoute?.id || null,
        execution_route_id: executionRoute?.id || null,
        strategy_bot_id: executionRoute?.strategy_bot_id || observedRoute?.strategy_bot_id || null,
        execution_bot_config_id: executionBot?.id || null,
      }
    })

    const observations = linkedRoutes
      .filter((route: any) => route.qualifying === true)
      .map((route: any) => ({
        owner_id: user.id,
        bot_skill_id: null,
        source_key: 'public_exchange_order_books',
        domain: 'execution_scout',
        symbol: route.pair,
        metric: 'spread_pct',
        value: route.spreadPct,
        observed_at: new Date().toISOString(),
        metadata: {
          chain: route.chain,
          pair: route.pair,
          buy_exchange: route.buyExchange,
          sell_exchange: route.sellExchange,
          buy_price: route.buyPrice,
          sell_price: route.sellPrice,
          spread_pct: route.spreadPct,
          latency_ms: route.latency,
          quotes: route.quotes,
          source: 'public_exchange_order_books',
        },
        observed_route_id: route.observed_route_id,
        execution_route_id: route.execution_route_id,
        strategy_bot_id: route.strategy_bot_id,
        execution_bot_config_id: route.execution_bot_config_id,
        qualifying: true,
      }))

    let observation_persisted = 0
    if (observations.length > 0) {
      const { data: savedObservations, error: observationError } = await admin
        .from('strategy_observations')
        .insert(observations)
        .select('id')
      if (!observationError) observation_persisted = savedObservations?.length || 0
    }

    const routes = linkedRoutes
    const successfulQuotes = snapshots.flatMap((snapshot) => snapshot.quotes || [])
    const averageLatency = successfulQuotes.length
      ? Math.round(successfulQuotes.reduce((sum, quote) => sum + Number(quote.latencyMs || 0), 0) / successfulQuotes.length)
      : 0
    const feeds = [...new Set(successfulQuotes.map((quote) => quote.exchange))]
    const { data: signerAdapters } = await admin
      .from('execution_adapters')
      .select('id,signer_provider,health_status,configured,can_broadcast,can_withdraw,automatic_signing,read_only,allowed_wallet_id')
      .eq('signer_provider', 'internal_vault')

    const { data: signerWallets } = await admin
      .from('wallets')
      .select('id,chain,status,is_hot,wallet_role')
      .eq('status', 'active')
      .eq('is_hot', true)
      .eq('wallet_role', 'trading_hot')

    const signer_health = ['bitcoin', 'ethereum', 'bnb', 'solana'].map((chain) => {
      const walletIds = new Set((signerWallets || []).filter((wallet: any) => wallet.chain === chain).map((wallet: any) => wallet.id))
      const matches = (signerAdapters || []).filter((adapter: any) =>
        walletIds.has(adapter.allowed_wallet_id) &&
        adapter.configured === true &&
        adapter.health_status === 'healthy' &&
        adapter.read_only === false &&
        adapter.can_broadcast === true
      )
      return {
        chain,
        configured: matches.length > 0,
        healthy: matches.length > 0,
        broadcast_capable: matches.length > 0,
        automatic_signing: matches.some((adapter: any) => adapter.automatic_signing === true),
      }
    })

    const rpc = await rpcHealth()
    return json({
      ok: true,
      timestamp_ms: Date.now(),
      qualifying_spread_pct: qualifyingThreshold,
      latency_ms: averageLatency,
      routes,
      observer_execution_links: {
        observation_persisted,
        execution_bot_config_id: executionBot?.id || null,
        linked_route_count: linkedRoutes.filter((route: any) => route.observed_route_id || route.execution_route_id).length,
      },
      market_snapshot: snapshots,
      live_quote_count: successfulQuotes.length,
      live_pair_count: snapshots.filter((snapshot) => snapshot.quote_count > 0).length,
      feeds,
      feed_health: EXCHANGES.map((exchange) => ({
        exchange,
        live_pairs: snapshots.filter((snapshot: any) => (snapshot.quotes || []).some((quote: any) => quote.exchange === exchange)).length,
      })),
      chain_rpc_health: rpc,
      signer_health,
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
