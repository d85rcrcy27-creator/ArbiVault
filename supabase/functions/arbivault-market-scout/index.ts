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
  { chain: 'bitcoin', pair: 'BTC/USDT', symbol: 'BTCUSDT', okx: 'BTC-USDT', kraken: 'XBTUSDT', kucoin: 'BTC-USDT', gateio: 'BTC_USDT', coinbase: 'BTC-USDT', bitget: 'BTCUSDT' },
  { chain: 'ethereum', pair: 'ETH/USDT', symbol: 'ETHUSDT', okx: 'ETH-USDT', kraken: 'ETHUSDT', kucoin: 'ETH-USDT', gateio: 'ETH_USDT', coinbase: 'ETH-USDT', bitget: 'ETHUSDT' },
  { chain: 'solana', pair: 'SOL/USDT', symbol: 'SOLUSDT', okx: 'SOL-USDT', kraken: 'SOLUSDT', kucoin: 'SOL-USDT', gateio: 'SOL_USDT', coinbase: 'SOL-USDT', bitget: 'SOLUSDT' },
  { chain: 'bnb', pair: 'BNB/USDT', symbol: 'BNBUSDT', okx: 'BNB-USDT', kraken: 'BNBUSDT', kucoin: 'BNB-USDT', gateio: 'BNB_USDT', coinbase: 'BNB-USDT', bitget: 'BNBUSDT' },
  { chain: 'xrp', pair: 'XRP/USDT', symbol: 'XRPUSDT', okx: 'XRP-USDT', kraken: 'XRPUSDT', kucoin: 'XRP-USDT', gateio: 'XRP_USDT', coinbase: 'XRP-USDT', bitget: 'XRPUSDT' },
  { chain: 'ethereum', pair: 'ADA/USDT', symbol: 'ADAUSDT', okx: 'ADA-USDT', kraken: 'ADAUSDT', kucoin: 'ADA-USDT', gateio: 'ADA_USDT', coinbase: 'ADA-USDT', bitget: 'ADAUSDT' },
  { chain: 'ethereum', pair: 'AVAX/USDT', symbol: 'AVAXUSDT', okx: 'AVAX-USDT', kraken: 'AVAXUSDT', kucoin: 'AVAX-USDT', gateio: 'AVAX_USDT', coinbase: 'AVAX-USDT', bitget: 'AVAXUSDT' },
  { chain: 'ethereum', pair: 'LINK/USDT', symbol: 'LINKUSDT', okx: 'LINK-USDT', kraken: 'LINKUSDT', kucoin: 'LINK-USDT', gateio: 'LINK_USDT', coinbase: 'LINK-USDT', bitget: 'LINKUSDT' },
  { chain: 'ethereum', pair: 'DOGE/USDT', symbol: 'DOGEUSDT', okx: 'DOGE-USDT', kraken: 'DOGEUSDT', kucoin: 'DOGE-USDT', gateio: 'DOGE_USDT', coinbase: 'DOGE-USDT', bitget: 'DOGEUSDT' },
]

const EXCHANGES = ['binance', 'bybit', 'okx', 'kraken', 'kucoin', 'gateio', 'coinbase', 'bitget']

const PUBLIC_MARKET_ASSETS = [
  { chain: 'ethereum', symbol: 'BTC', coingecko: 'bitcoin' },
  { chain: 'ethereum', symbol: 'ETH', coingecko: 'ethereum' },
  { chain: 'solana', symbol: 'SOL', coingecko: 'solana' },
  { chain: 'bnb', symbol: 'BNB', coingecko: 'binancecoin' },
  { chain: 'xrp', symbol: 'XRP', coingecko: 'ripple' },
  { chain: 'ethereum', symbol: 'ADA', coingecko: 'cardano' },
  { chain: 'ethereum', symbol: 'AVAX', coingecko: 'avalanche-2' },
  { chain: 'ethereum', symbol: 'LINK', coingecko: 'chainlink' },
  { chain: 'ethereum', symbol: 'DOGE', coingecko: 'dogecoin' },
]

async function publicApiData() {
  const [cg, dex] = await Promise.all([
    (async () => {
      try {
        const ids = PUBLIC_MARKET_ASSETS.map((a) => a.coingecko).join(',')
        const j = await fetchJson(`https://api.coingecko.com/api/v3/simple/price?ids=${encodeURIComponent(ids)}&vs_currencies=usd&include_24hr_vol=true&include_24hr_change=true`)
        return PUBLIC_MARKET_ASSETS.map((a) => ({
          source: 'coingecko',
          chain: a.chain,
          symbol: a.symbol,
          usd: Number(j?.[a.coingecko]?.usd),
          volume24h: Number(j?.[a.coingecko]?.usd_24h_vol),
          change24h: Number(j?.[a.coingecko]?.usd_24h_change),
        })).filter((x) => Number.isFinite(x.usd) && x.usd > 0)
      } catch { return [] }
    })(),
    (async () => {
      try {
        const results = await Promise.all(PUBLIC_MARKET_ASSETS.map(async (a) => {
          const j = await fetchJson(`https://api.dexscreener.com/latest/dex/search?q=${encodeURIComponent(a.symbol + '/USDT')}`)
          const pairs = Array.isArray(j?.pairs) ? j.pairs : []
          return pairs
            .filter((p: any) => Number(p?.priceUsd) > 0)
            .sort((x: any, y: any) => Number(y?.liquidity?.usd || 0) - Number(x?.liquidity?.usd || 0))
            .slice(0, 3)
            .map((p: any) => ({
              source: 'dexscreener',
              chain: a.chain,
              symbol: a.symbol,
              dex_chain: p.chainId,
              dex: p.dexId,
              pair_address: p.pairAddress,
              priceUsd: Number(p.priceUsd),
              liquidityUsd: Number(p.liquidity?.usd || 0),
              volume24hUsd: Number(p.volume?.h24 || 0),
              url: p.url,
            }))
        }))
        return results.flat()
      } catch { return [] }
    })(),
  ])
  return { coingecko: cg, dexscreener: dex }
}
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

type CexQuote = { exchange: string; bid: number; ask: number; latencyMs: number }
type CexQuoteResult = CexQuote | { exchange: string; error: string; latencyMs: number }

function makeCexQuote(exchange: string, bidValue: unknown, askValue: unknown, started: number): CexQuote {
  const bid = Number(bidValue)
  const ask = Number(askValue)
  if (!Number.isFinite(bid) || !Number.isFinite(ask) || bid <= 0 || ask <= 0) {
    throw new Error("invalid_bid_ask")
  }
  // Crossed/invalid quotes must never be allowed to create a false arbitrage edge.
  if (bid > ask) throw new Error("crossed_bid_ask")
  return { exchange, bid, ask, latencyMs: Math.round(performance.now() - started) }
}

function requireCexApiSuccess(exchange: string, body: any) {
  if (exchange === 'bybit' && Number(body?.retCode) !== 0) {
    throw new Error("bybit_api_error_" + String(body?.retCode ?? "missing_code"))
  }
  if (exchange === 'okx' && String(body?.code) !== "0") {
    throw new Error("okx_api_error_" + String(body?.code ?? "missing_code"))
  }
  if (exchange === 'bitget' && body?.code !== undefined &&
      !["00000", "0", 0].includes(body.code)) {
    throw new Error("bitget_api_error_" + String(body.code).slice(0, 24))
  }
  if (exchange === 'kucoin' && body?.code !== undefined &&
      String(body.code) !== "200000") {
    throw new Error("kucoin_api_error_" + String(body.code).slice(0, 24))
  }
  if (exchange === 'binance' && body?.code !== undefined && Number(body.code) !== 0) {
    throw new Error("binance_api_error_" + String(body.code).slice(0, 24))
  }
  if (exchange === 'kraken' && Array.isArray(body?.error) && body.error.length > 0) {
    throw new Error("kraken_api_error")
  }
}

async function quote(exchange: string, pair: typeof PAIRS[number]): Promise<CexQuoteResult> {
  const started = performance.now()
  try {
    if (exchange === 'binance') {
      // Binance recommends its market-data-only host for unauthenticated public feeds.
      const j = await fetchJson(`https://data-api.binance.vision/api/v3/ticker/bookTicker?symbol=${pair.symbol}`)
      requireCexApiSuccess(exchange, j)
      return makeCexQuote(exchange, j.bidPrice, j.askPrice, started)
    }
    if (exchange === 'bybit') {
      const j = await fetchJson(`https://api.bybit.com/v5/market/tickers?category=spot&symbol=${pair.symbol}`)
      requireCexApiSuccess(exchange, j)
      const t = j?.result?.list?.[0]
      if (!t) throw new Error("bybit_ticker_missing")
      return makeCexQuote(exchange, t.bid1Price, t.ask1Price, started)
    }
    if (exchange === 'okx') {
      const j = await fetchJson(`https://www.okx.com/api/v5/market/ticker?instId=${pair.okx}`)
      requireCexApiSuccess(exchange, j)
      const t = j?.data?.[0]
      if (!t) throw new Error("okx_ticker_missing")
      return makeCexQuote(exchange, t.bidPx, t.askPx, started)
    }
    if (exchange === 'coinbase') {
      const j = await fetchJson(`https://api.exchange.coinbase.com/products/${pair.coinbase}/ticker`)
      return makeCexQuote(exchange, j.bid, j.ask, started)
    }
    if (exchange === 'bitget') {
      // UTA market-data endpoint. It remains read-only; it is not an order executor.
      const j = await fetchJson(`https://api.bitget.com/api/v3/market/tickers?category=SPOT&symbol=${pair.bitget}`)
      requireCexApiSuccess(exchange, j)
      const t = Array.isArray(j?.data) ? j.data[0] : null
      if (!t) throw new Error("bitget_ticker_missing")
      return makeCexQuote(exchange, t.bidPr, t.askPr, started)
    }
    if (exchange === 'kraken') {
      const j = await fetchJson(`https://api.kraken.com/0/public/Ticker?pair=${pair.kraken}`)
      requireCexApiSuccess(exchange, j)
      const t = Object.values(j?.result || {})[0] as any
      if (!t) throw new Error("kraken_ticker_missing")
      return makeCexQuote(exchange, t.b?.[0], t.a?.[0], started)
    }
    if (exchange === 'kucoin') {
      const j = await fetchJson(`https://api.kucoin.com/api/v1/market/orderbook/level1?symbol=${pair.kucoin}`)
      requireCexApiSuccess(exchange, j)
      const t = j?.data
      if (!t) throw new Error("kucoin_ticker_missing")
      return makeCexQuote(exchange, t.bestBid, t.bestAsk, started)
    }
    if (exchange === 'gateio') {
      const j = await fetchJson(`https://api.gateio.ws/api/v4/spot/tickers?currency_pair=${pair.gateio}`)
      const t = j?.[0]
      if (!t) throw new Error("gateio_ticker_missing")
      return makeCexQuote(exchange, t.highest_bid, t.lowest_ask, started)
    }
    throw new Error("unsupported_exchange_adapter")
  } catch (error) {
    const message = error instanceof Error ? error.message : "adapter_request_failed"
    return {
      exchange,
      error: message.slice(0, 80),
      latencyMs: Math.round(performance.now() - started),
    }
  }
}
async function timedFetchJson(url: string, body?: unknown, timeoutMs = 2200) {
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), timeoutMs)
  try {
    const response = await fetch(url, body === undefined
      ? { signal: controller.signal, headers: { accept: 'application/json' } }
      : {
          method: 'POST',
          signal: controller.signal,
          headers: { 'content-type': 'application/json', accept: 'application/json' },
          body: JSON.stringify(body),
        })
    if (!response.ok) throw new Error(`http_${response.status}`)
    return await response.json()
  } finally {
    clearTimeout(timer)
  }
}

async function probeJsonRpc(endpoint: string, method: string, params: unknown[] = []) {
  const result = await timedFetchJson(endpoint, {
    jsonrpc: '2.0',
    id: crypto.randomUUID(),
    method,
    params,
  })
  if (result?.error) throw new Error(`rpc_${String(result.error.code ?? 'error')}`)
  if (result?.result === undefined || result?.result === null) throw new Error('rpc_result_missing')
  return result.result
}

async function probeEvmEndpoint(provider: string, endpoint: string, expectedChainId: string, chain: string) {
  const started = performance.now()
  try {
    const chainId = String(await probeJsonRpc(endpoint, 'eth_chainId')).toLowerCase()
    if (chainId !== expectedChainId) throw new Error('wrong_chain_id')
    const blockNumber = String(await probeJsonRpc(endpoint, 'eth_blockNumber'))
    if (!/^0x[0-9a-f]+$/i.test(blockNumber)) throw new Error('invalid_block_number')
    return { chain, provider, endpoint, ok: true, latencyMs: Math.round(performance.now() - started), transport: 'json-rpc', error: null }
  } catch (error) {
    return {
      chain, provider, endpoint, ok: false,
      latencyMs: Math.round(performance.now() - started), transport: 'json-rpc',
      error: error instanceof Error ? error.message.slice(0, 160) : 'rpc_probe_failed',
    }
  }
}

async function probeSolanaEndpoint(provider: string, endpoint: string) {
  const started = performance.now()
  try {
    const result = await probeJsonRpc(endpoint, 'getLatestBlockhash', [{ commitment: 'confirmed' }])
    if (!result?.value?.blockhash) throw new Error('blockhash_missing')
    return { chain: 'solana', provider, endpoint, ok: true, latencyMs: Math.round(performance.now() - started), transport: 'json-rpc', error: null }
  } catch (error) {
    return {
      chain: 'solana', provider, endpoint, ok: false,
      latencyMs: Math.round(performance.now() - started), transport: 'json-rpc',
      error: error instanceof Error ? error.message.slice(0, 160) : 'rpc_probe_failed',
    }
  }
}

async function probeBitcoinEndpoint(provider: string, endpoint: string) {
  const started = performance.now()
  try {
    const response = await fetch(endpoint, { signal: AbortSignal.timeout(2200), headers: { accept: 'text/plain,application/json' } })
    if (!response.ok) throw new Error(`http_${response.status}`)
    const body = (await response.text()).trim()
    if (!/^\d+$/.test(body)) throw new Error('block_height_invalid')
    return { chain: 'bitcoin', provider, endpoint, ok: true, latencyMs: Math.round(performance.now() - started), transport: 'rest-rpc', error: null }
  } catch (error) {
    return {
      chain: 'bitcoin', provider, endpoint, ok: false,
      latencyMs: Math.round(performance.now() - started), transport: 'rest-rpc',
      error: error instanceof Error ? error.message.slice(0, 160) : 'rpc_probe_failed',
    }
  }
}

async function rpcHealth() {
  // The Home screen polls this response directly. Probe multiple mainnet endpoints
  // in parallel so a single provider outage no longer paints Ethereum as DOWN.
  const ethereumProviders = [
    { provider: 'Ethereum PublicNode', endpoint: 'https://ethereum-rpc.publicnode.com' },
    { provider: 'Ethereum Cloudflare', endpoint: 'https://cloudflare-eth.com' },
    { provider: 'Ethereum LlamaRPC', endpoint: 'https://eth.llamarpc.com' },
  ]
  const bnbProviders = [
    { provider: 'BNB Official RPC', endpoint: 'https://bsc-dataseed.binance.org' },
    { provider: 'BNB Public RPC 2', endpoint: 'https://bsc-dataseed1.defibit.io' },
    { provider: 'BNB Public RPC 3', endpoint: 'https://bsc-dataseed-public.bnbchain.org' },
  ]
  const solanaProviders = [
    { provider: 'Solana Mainnet', endpoint: 'https://api.mainnet-beta.solana.com' },
    { provider: 'Solana PublicNode', endpoint: 'https://solana-rpc.publicnode.com' },
  ]
  const bitcoinProviders = [
    { provider: 'Mempool.space', endpoint: 'https://mempool.space/api/blocks/tip/height' },
    { provider: 'Blockstream', endpoint: 'https://blockstream.info/api/blocks/tip/height' },
  ]

  const [ethResults, bnbResults, solResults, btcResults] = await Promise.all([
    Promise.all(ethereumProviders.map(p => probeEvmEndpoint(p.provider, p.endpoint, '0x1', 'ethereum'))),
    Promise.all(bnbProviders.map(p => probeEvmEndpoint(p.provider, p.endpoint, '0x38', 'bnb'))),
    Promise.all(solanaProviders.map(p => probeSolanaEndpoint(p.provider, p.endpoint))),
    Promise.all(bitcoinProviders.map(p => probeBitcoinEndpoint(p.provider, p.endpoint))),
  ])

  const summarize = (chain: string, results: any[]) => {
    const successful = results.filter(item => item.ok).sort((a, b) => a.latencyMs - b.latencyMs)
    const chosen = successful[0] || results.slice().sort((a, b) => a.latencyMs - b.latencyMs)[0]
    return {
      chain,
      ok: successful.length > 0,
      latencyMs: chosen?.latencyMs || 0,
      transport: chosen?.transport || 'rpc',
      provider: chosen?.provider || null,
      endpoint: chosen?.ok ? chosen.endpoint : null,
      providers_checked: results.length,
      provider_results: results,
      last_error: successful.length ? null : (chosen?.error || 'all_rpc_providers_failed'),
    }
  }

  const checks = [
    summarize('ethereum', ethResults),
    summarize('bnb', bnbResults),
    summarize('solana', solResults),
    summarize('bitcoin', btcResults),
  ]
  const checkedAt = new Date().toISOString()

  // Keep the RPC registry in sync with actual probes. Database writes are best
  // effort and must never take the live market response down.
  await Promise.all(checks.map(async (check: any) => {
    const chainPayload: Record<string, unknown> = {
      health_status: check.ok ? 'healthy' : 'down',
      last_health_check_at: checkedAt,
      last_latency_ms: check.latencyMs,
      updated_at: checkedAt,
    }
    if (check.ok && check.endpoint && ['ethereum', 'bnb', 'solana'].includes(check.chain)) {
      chainPayload.rpc_url = check.endpoint
    }
    try {
      const chainAliases = check.chain === 'ethereum' ? ['ethereum', 'evm'] : [check.chain]
      await admin.from('arbivault_chain_rpc')
        .update(chainPayload)
        .in('chain', chainAliases)
        .eq('enabled', true)
    } catch {
      // Status persistence must not fail the live health response.
    }
  }))

  const allProviderResults = [...ethResults, ...bnbResults, ...solResults, ...btcResults]
  await Promise.all(allProviderResults.map(async (item: any) => {
    try {
      await admin.from('arbivault_rpc_endpoints').update({
        health_status: item.ok ? 'healthy' : 'down',
        last_health_check_at: checkedAt,
        last_error: item.ok ? null : item.error,
        updated_at: checkedAt,
      }).eq('endpoint', item.endpoint)
    } catch {
      // Endpoint-level status is supplemental; keep health checks available.
    }
  }))

  return checks
}

async function buildRoute(pair: typeof PAIRS[number]) {
  const quoteResults = await Promise.all(EXCHANGES.map((exchange) => quote(exchange, pair)))
  const quotes = quoteResults.filter((item): item is CexQuote => !("error" in item))
  const feedErrors = quoteResults
    .filter((item): item is Extract<CexQuoteResult, { error: string }> => "error" in item)
    .map(({ exchange, error }) => ({ exchange, error }))

  const snapshot = {
    chain: pair.chain,
    pair: pair.pair,
    quotes,
    feed_errors: feedErrors,
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
      latency: Math.max(Number(bestBuy.latencyMs || 0), Number(bestSell.latencyMs || 0)),
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
    const routeResults = await Promise.all(PAIRS.map(buildRoute))
    const snapshots = routeResults.map((item) => item.snapshot)
    const marketRoutes = routeResults.map((item) => item.route).filter(Boolean)

    // Persist research observations only. Research observations have no execution eligibility state.
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

    const publicApis = await publicApiData()
    const publicResearch = [
      ...publicApis.coingecko.map((item: any) => ({
        owner_id: user.id, bot_skill_id: null, source_key: item.source, domain: 'market_research',
        symbol: item.symbol + '/USD', metric: 'public_market_price', value: item.usd,
        observed_at: new Date().toISOString(), metadata: item, observed_route_id: null,
        execution_route_id: null, strategy_bot_id: null, execution_bot_config_id: null,
      })),
      ...publicApis.dexscreener.map((item: any) => ({
        owner_id: user.id, bot_skill_id: null, source_key: item.source, domain: 'dex_research',
        symbol: item.symbol + '/USDT', metric: 'dex_liquidity_usd', value: item.liquidityUsd,
        observed_at: new Date().toISOString(), metadata: item, observed_route_id: null,
        execution_route_id: null, strategy_bot_id: null, execution_bot_config_id: null,
      })),
    ]
    let public_observation_persisted = 0
    if (publicResearch.length) {
      const { data: saved } = await admin.from('strategy_observations').insert(publicResearch).select('id')
      public_observation_persisted = saved?.length || 0
    }

    const linkedRoutes = marketRoutes.map((route: any) => {
      const observedRoute = (routeCatalog || []).find((candidate: any) =>
        candidate.chain === route.chain &&
        candidate.pair === route.pair &&
        candidate.route_type === 'orderbook' &&
        candidate.strategy_bot_id &&
        strategyBotIds.has(candidate.strategy_bot_id)
      ) || null
      const assetSymbol = String(route.pair || '').split('/')[0]
      const liveAssetMetrics = publicApis.coingecko.find((item: any) => item.symbol === assetSymbol) || null
      const volume24hUsd = Number(liveAssetMetrics?.volume24h)
      const selectedQuotes = [route.buyExchange, route.sellExchange]
        .map((exchange: string) => (route.quotes || []).find((quote: any) => quote.exchange === exchange))
        .filter(Boolean)
      const routeLatencyMs = selectedQuotes.length === 2
        ? Math.max(...selectedQuotes.map((quote: any) => Number(quote.latencyMs || 0)))
        : Number(route.latency || 0)

      return {
        ...route,
        latency: routeLatencyMs,
        volume: Number.isFinite(volume24hUsd) ? volume24hUsd : null,
        volume24hUsd: Number.isFinite(volume24hUsd) ? volume24hUsd : null,
        live_metrics_at: liveAssetMetrics ? new Date().toISOString() : null,
        live_metrics_source: liveAssetMetrics ? 'coingecko_24h_volume' : null,
        observed_route_id: observedRoute?.id || null,
        execution_route_id: null,
        strategy_bot_id: observedRoute?.strategy_bot_id || null,
        execution_bot_config_id: null,
      }
    })

    const observations = linkedRoutes.map((route: any) => ({
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
          public_market_data: {
            coingecko: publicApis.coingecko.length,
            dexscreener: publicApis.dexscreener.length,
            persisted: public_observation_persisted,
          },
          source: 'public_exchange_order_books',
        },
        observed_route_id: route.observed_route_id,
        execution_route_id: null,
        strategy_bot_id: route.strategy_bot_id,
        execution_bot_config_id: null,
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
      .select('id,chain,signer_provider,health_status,configured,can_broadcast,can_withdraw,automatic_signing,read_only,allowed_wallet_id,signer_key_ref,signing_boundary,allowed_contracts')
      .eq('signer_provider', 'internal_vault')

    const { data: signerWallets } = await admin
      .from('wallets')
      .select('id,chain,status,is_hot,wallet_role,address,secret_ref')
      .eq('status', 'active')
      .eq('is_hot', true)
      .eq('wallet_role', 'trading_hot')

    const signer_health = ['bitcoin', 'ethereum', 'bnb', 'solana'].map((chain) => {
      const activeWallets = (signerWallets || []).filter((wallet: any) =>
        wallet.chain === chain &&
        wallet.status === 'active' &&
        wallet.is_hot === true &&
        wallet.wallet_role === 'trading_hot'
      )
      const walletsWithStoredSecrets = activeWallets.filter((wallet: any) =>
        typeof wallet.secret_ref === 'string' && wallet.secret_ref.length > 0
      )
      const mappedAdapters = (signerAdapters || []).filter((adapter: any) =>
        adapter.chain === chain &&
        walletsWithStoredSecrets.some((wallet: any) =>
          wallet.id === adapter.allowed_wallet_id &&
          String(wallet.address || '').toLowerCase() === String(adapter.signer_key_ref || '').toLowerCase()
        )
      )
      const healthyBindings = mappedAdapters.filter((adapter: any) => {
        const contracts = Array.isArray(adapter.allowed_contracts)
          ? adapter.allowed_contracts.map((value: unknown) => String(value).toLowerCase())
          : []
        const expectedRouter = chain === 'ethereum'
          ? '0x7a250d5630b4cf539739df2c5dacb4c659f2488d'
          : chain === 'bnb' ? '0x10ed43c718714eb63d5aa57b78b54704e256024e' : null
        const routePolicyReady = !expectedRouter || contracts.includes(expectedRouter)
        return adapter.configured === true &&
          adapter.health_status === 'healthy' &&
          adapter.read_only === false &&
          adapter.signing_boundary === 'internal_vault' &&
          routePolicyReady
      })
      // A valid signer can be healthy while execution remains disabled.
      // Report identity/binding health separately from broadcast readiness.
      const executableAdapters = healthyBindings.filter((adapter: any) =>
        adapter.can_broadcast === true && adapter.automatic_signing === true
      )
      const reason = executableAdapters.length > 0 ? 'ready'
        : activeWallets.length === 0 ? 'no_active_trading_hot_wallet'
        : walletsWithStoredSecrets.length === 0 ? 'active_wallet_secret_not_registered'
        : mappedAdapters.length === 0 ? 'signer_not_bound_to_active_wallet'
        : healthyBindings.length > 0 ? 'signer_healthy_execution_not_ready'
        : 'signer_adapter_policy_or_health_failed'
      return {
        chain,
        configured: healthyBindings.length > 0,
        healthy: healthyBindings.length > 0,
        broadcast_capable: healthyBindings.some((adapter: any) => adapter.can_broadcast === true),
        automatic_signing: healthyBindings.some((adapter: any) => adapter.automatic_signing === true),
        execution_ready: executableAdapters.length > 0,
        active_wallet_count: activeWallets.length,
        wallet_with_secret_count: walletsWithStoredSecrets.length,
        reason,
      }
    })

    const rpc = await rpcHealth()
    return json({
      ok: true,
      timestamp_ms: Date.now(),
      latency_ms: averageLatency,
      routes,
      observer_execution_links: {
        observation_persisted,
        execution_bot_config_id: null,
        linked_route_count: linkedRoutes.filter((route: any) => route.observed_route_id || route.execution_route_id).length,
      },
      market_snapshot: snapshots,
      live_quote_count: successfulQuotes.length,
      live_pair_count: snapshots.filter((snapshot) => snapshot.quote_count > 0).length,
      feeds,
      feed_health: EXCHANGES.map((exchange) => {
        const exchangeErrors = snapshots
          .flatMap((snapshot: any) => snapshot.feed_errors || [])
          .filter((item: any) => item.exchange === exchange)
        return {
          exchange,
          live_pairs: snapshots.filter((snapshot: any) => (snapshot.quotes || []).some((quote: any) => quote.exchange === exchange)).length,
          failed_pairs: exchangeErrors.length,
          sample_error: exchangeErrors[0]?.error || null,
          mode: 'public_market_data_read_only',
        }
      }),
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
