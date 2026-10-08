import { createClient } from 'npm:@supabase/supabase-js@2.117.2'

const supabase = createClient(
  Deno.env.get('SUPABASE_URL')!,
  Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!,
)

const PAIRS = [
  { chain: 'solana', pair: 'SOL/USDT', symbol: 'SOLUSDT', okx: 'SOL-USDT' },
  { chain: 'bnb', pair: 'BNB/USDT', symbol: 'BNBUSDT', okx: 'BNB-USDT' },
]

const QUALIFYING_SPREAD_PCT = 0.5

async function authorized(req: Request) {
  const token = req.headers.get('x-arbivault-cron-token')
  if (!token) return false
  const { data } = await supabase.rpc('get_bot_cron_token')
  return !!data && token === data
}

async function fetchWithTimeout(url: string) {
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), 1800)
  try {
    const response = await fetch(url, {
      signal: controller.signal,
      headers: { accept: 'application/json' },
    })
    if (!response.ok) throw new Error(`market_http_${response.status}`)
    return await response.json()
  } finally {
    clearTimeout(timer)
  }
}

async function quoteBinance(symbol: string) {
  try {
    const value = await fetchWithTimeout(`https://api.binance.com/api/v3/ticker/bookTicker?symbol=${symbol}`)
    return { exchange: 'binance', bid: Number(value.bidPrice), ask: Number(value.askPrice) }
  } catch {
    return null
  }
}

async function quoteBybit(symbol: string) {
  try {
    const value = await fetchWithTimeout(`https://api.bybit.com/v5/market/tickers?category=spot&symbol=${symbol}`)
    const ticker = value?.result?.list?.[0]
    return ticker
      ? { exchange: 'bybit', bid: Number(ticker.bid1Price), ask: Number(ticker.ask1Price) }
      : null
  } catch {
    return null
  }
}

async function quoteOkx(instId: string) {
  try {
    const value = await fetchWithTimeout(`https://www.okx.com/api/v5/market/ticker?instId=${instId}`)
    const ticker = value?.data?.[0]
    return ticker
      ? { exchange: 'okx', bid: Number(ticker.bidPx), ask: Number(ticker.askPx) }
      : null
  } catch {
    return null
  }
}

async function spreadFor(pair: typeof PAIRS[number]) {
  const quotes = (
    await Promise.all([
      quoteBinance(pair.symbol),
      quoteBybit(pair.symbol),
      quoteOkx(pair.okx),
    ])
  ).filter((quote: any) =>
    quote &&
    Number.isFinite(quote.bid) &&
    Number.isFinite(quote.ask) &&
    quote.ask > 0
  )

  if (quotes.length < 2) return null

  let buy: any = quotes[0]
  let sell: any = quotes[0]
  for (const quote of quotes) {
    if (quote.ask < buy.ask) buy = quote
    if (quote.bid > sell.bid) sell = quote
  }

  if (sell.exchange === buy.exchange) return null

  const spreadPct = ((sell.bid - buy.ask) / buy.ask) * 100
  if (!Number.isFinite(spreadPct)) return null

  return {
    chain: pair.chain,
    pair: pair.pair,
    buy_exchange: buy.exchange,
    sell_exchange: sell.exchange,
    buy_ask: buy.ask,
    sell_bid: sell.bid,
    spread_pct: spreadPct,
    qualifying: spreadPct >= QUALIFYING_SPREAD_PCT,
  }
}

async function sha256(value: string) {
  const bytes = await crypto.subtle.digest(
    'SHA-256',
    new TextEncoder().encode(value),
  )
  return Array.from(new Uint8Array(bytes))
    .map((byte) => byte.toString(16).padStart(2, '0'))
    .join('')
}

export default {
  fetch: async (req: Request) => {
    if (req.method !== 'POST' || !(await authorized(req))) {
      return Response.json({ error: 'unauthorized' }, { status: 401 })
    }

    const { data: policy, error: policyError } = await supabase
      .from('arbivault_execution_policy')
      .select('*')
      .eq('policy_key', 'primary')
      .maybeSingle()

    if (policyError) return Response.json({ error: policyError.message }, { status: 500 })

    const now = new Date()
    const policyActive = !!policy &&
      policy.enabled === true &&
      new Date(policy.starts_at) <= now &&
      (!policy.ends_at || new Date(policy.ends_at) > now)

    const capitalAllowance = policyActive ? Number(policy.capital_allowance || 0) : 0
    const zeroCapitalWindow = policyActive &&
      policy.mode === 'zero_capital' &&
      capitalAllowance === 0

    const { data: bots, error: botError } = await supabase
      .from('bot_configs')
      .select('*')
      .eq('bot_role', 'execution')
      .eq('enabled', true)

    if (botError) return Response.json({ error: botError.message }, { status: 500 })

    const { data: strategyBots, error: strategyBotError } = await supabase
      .from('arbivault_strategy_bots')
      .select('id,strategy,enabled,execution_enabled')
      .eq('enabled', true)
      .eq('execution_enabled', true)

    if (strategyBotError) return Response.json({ error: strategyBotError.message }, { status: 500 })

    const { data: routes, error: routeError } = await supabase
      .from('arbivault_strategy_routes')
      .select('id,strategy,strategy_bot_id,chain,pair,route_type,enabled,discovery_only')
      .eq('enabled', true)

    if (routeError) return Response.json({ error: routeError.message }, { status: 500 })

    const { data: adapters, error: adapterError } = await supabase
      .from('execution_adapters')
      .select('*')
      .eq('configured', true)

    if (adapterError) return Response.json({ error: adapterError.message }, { status: 500 })

    // These adapters are signing/broadcast boundaries, not exchange trading venues.
    // Do not treat them as a CEX/Dex market execution adapter.
    const signerAdapters = (adapters || []).filter((adapter: any) =>
      adapter.health_status === 'healthy' &&
      adapter.can_broadcast === true &&
      adapter.read_only === false &&
      adapter.signer_provider === 'internal_vault' &&
      !!adapter.allowed_wallet_id
    )

    const results: any[] = []

    for (const bot of bots || []) {
      const run = await supabase
        .from('bot_execution_runs')
        .insert({
          owner_id: bot.owner_id,
          bot_config_id: bot.id,
          workflow: 'execution',
          idempotency_key: crypto.randomUUID(),
          input: {
            role: 'execution',
            priority: 'early_bird',
            research_layer: 'A Deep Mind',
            capital_policy: policy?.mode || 'unconfigured',
          },
        })
        .select('id')
        .single()

      try {
        const chains = bot.chains?.length ? bot.chains : ['solana', 'bnb']
        const opportunities: any[] = []

        for (const pair of PAIRS.filter((candidate) => chains.includes(candidate.chain))) {
          const quote = await spreadFor(pair)
          if (!quote?.qualifying) continue

          const route = (routes || [])
            .filter((candidate: any) =>
              candidate.chain === quote.chain &&
              candidate.pair === quote.pair &&
              candidate.route_type === 'orderbook' &&
              candidate.strategy_bot_id
            )
            .sort((a: any, b: any) =>
              Number(b.discovery_only) - Number(a.discovery_only)
            )[0] || null

          const strategyBot = route?.strategy_bot_id
            ? (strategyBots || []).find((candidate: any) => candidate.id === route.strategy_bot_id)
            : null

          const research = {
            ...quote,
            route_id: route?.id || null,
            strategy_bot_id: strategyBot?.id || null,
            strategy: strategyBot?.strategy || route?.strategy || null,
            research_layer: 'A Deep Mind',
          }

          const observationInsert = await supabase
            .from('strategy_observations')
            .insert({
              owner_id: bot.owner_id,
              bot_skill_id: null,
              source_key: 'crypto_exchanges',
              domain: 'execution_scout',
              symbol: quote.pair,
              metric: 'spread_pct',
              value: quote.spread_pct,
              observed_at: now.toISOString(),
              metadata: research,
            })

          opportunities.push({
            ...research,
            observation_saved: !observationInsert.error,
          })

          const venueExecutionAdapterConfigured = false
          const executionGate = !zeroCapitalWindow
            ? 'zero_capital_policy_not_active'
            : !strategyBot
              ? 'strategy_bot_not_linked'
              : !route
                ? 'strategy_route_not_linked'
                : route.discovery_only
                  ? 'strategy_route_discovery_only'
                  : !venueExecutionAdapterConfigured
                    ? 'market_execution_adapter_missing'
                    : !signerAdapters.length
                      ? 'internal_signer_unavailable'
                      : 'eligible'

          if (executionGate !== 'eligible') {
            const payloadHash = await sha256(JSON.stringify(research))
            await supabase.from('execution_attempts').insert({
              owner_id: bot.owner_id,
              adapter_id: null,
              strategy_bot_id: strategyBot?.id || null,
              chain: quote.chain,
              execution_mode: 'cex',
              status: 'blocked',
              opportunity_payload_hash: payloadHash,
              capital_used: 0,
              failure_reason: executionGate,
              validated_at: now.toISOString(),
            })
          }
        }

        const output = {
          ok: true,
          execution_mode: zeroCapitalWindow ? 'research_validated' : 'blocked_policy',
          research_layer: 'A Deep Mind',
          opportunities,
          controls: {
            withdrawal_path_available_to_bot: false,
            real_trade_claims_disabled_until_tx_hash: true,
            market_execution_adapter_present: false,
            internal_signers_present: signerAdapters.length > 0,
          },
        }

        if (run?.data?.id) {
          await supabase
            .from('bot_execution_runs')
            .update({
              status: 'completed',
              completed_at: new Date().toISOString(),
              output,
            })
            .eq('id', run.data.id)
        }

        await supabase
          .from('bot_configs')
          .update({
            last_run_at: new Date().toISOString(),
            last_success_at: new Date().toISOString(),
            last_error: opportunities.some((item) => item.route_id)
              ? null
              : 'no_qualifying_research_route',
          })
          .eq('id', bot.id)

        results.push({
          bot: bot.id,
          ...output,
        })
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error)

        if (run?.data?.id) {
          await supabase
            .from('bot_execution_runs')
            .update({
              status: 'failed',
              completed_at: new Date().toISOString(),
              error: message,
            })
            .eq('id', run.data.id)
        }

        results.push({
          bot: bot.id,
          status: 'failed',
          error: message,
        })
      }
    }

    return Response.json({
      ok: true,
      worker: 'execution',
      priority: 'early_bird',
      research_layer: 'A Deep Mind',
      live_execution_policy: zeroCapitalWindow ? 'zero_capital_for_initial_24h' : 'policy_blocked',
      actual_broadcasts: 0,
      confirmed_profits: 0,
      results,
    })
  },
}
