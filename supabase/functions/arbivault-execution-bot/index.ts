import { createClient } from 'npm:@supabase/supabase-js@2.117.2'

const supabase = createClient(
  Deno.env.get('SUPABASE_URL')!,
  Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!,
)

const PAIRS = [
  {
    chain: 'solana',
    pair: 'SOL/USDC',
    symbol: 'SOLUSDC',
    okx: 'SOL-USDC',
    probe: { sell: '10000000', buy: '100000000' }, // 0.01 SOL / 100 USDC
  },
  {
    chain: 'bnb',
    pair: 'BNB/USDT',
    symbol: 'BNBUSDT',
    okx: 'BNB-USDT',
    probe: { sell: '1000000000000000', buy: '1000000000000000000' }, // 0.001 BNB / 1 USDT
  },
]

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
  }
}

async function builderToken() {
  const { data } = await supabase.rpc('get_bot_cron_token')
  return data ? String(data) : null
}

async function callTransactionBuilder(input: Record<string, unknown>) {
  const token = await builderToken()
  if (!token) throw new Error('transaction_builder_auth_unavailable')

  const endpoint = `${Deno.env.get('SUPABASE_URL')}/functions/v1/arbivault-transaction-builder`
  const response = await fetch(endpoint, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      'x-arbivault-cron-token': token,
    },
    body: JSON.stringify(input),
  })

  const body = await response.json().catch(() => ({}))
  if (!response.ok) {
    throw new Error(body?.error || `transaction_builder_http_${response.status}`)
  }
  return body
}

function dexQuotePrice(build: any, side: 'buy' | 'sell') {
  const input = Number(build?.in_amount || build?.input_amount || 0)
  const output = Number(build?.out_amount || build?.expected_out || 0)
  if (!(input > 0) || !(output > 0)) return null

  return side === 'sell'
    ? output / input
    : input / output
}

async function buildDexPreflight(
  route: any,
  walletId: string,
  walletAddress: string,
  probe: { sell: string; buy: string },
) {
  if (!route?.transaction_builder) return null

  const [sell, buy] = await Promise.all([
    callTransactionBuilder({
      route_id: route.id,
      source_wallet_id: walletId,
      side: 'sell',
      amount_raw: probe.sell,
      slippage_bps: 50,
      price_impact_pct: 0,
    }),
    callTransactionBuilder({
      route_id: route.id,
      source_wallet_id: walletId,
      side: 'buy',
      amount_raw: probe.buy,
      slippage_bps: 50,
      price_impact_pct: 0,
    }),
  ])

  return {
    wallet: walletAddress,
    builder: route.transaction_builder,
    sell: {
      price: dexQuotePrice(sell, 'sell'),
      out_amount: sell?.out_amount || sell?.expected_out || null,
      transaction_payload_hash: sell?.transaction_payload_hash || null,
      executable_unsigned: sell?.executable === true,
    },
    buy: {
      price: dexQuotePrice(buy, 'buy'),
      out_amount: buy?.out_amount || buy?.expected_out || null,
      transaction_payload_hash: buy?.transaction_payload_hash || null,
      executable_unsigned: buy?.executable === true,
    },
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
      .select('id,strategy,strategy_bot_id,chain,pair,route_type,enabled,discovery_only,transaction_builder,builder_enabled,builder_status')
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

        const wallets = await supabase
          .from('wallets')
          .select('id,chain,address,status,is_hot,wallet_role')
          .eq('owner_id', bot.owner_id)
          .eq('status', 'active')
          .eq('is_hot', true)
          .eq('wallet_role', 'trading_hot')

        if (wallets.error) throw wallets.error

        // Execution consumes only explicitly executable strategy routes.
        // Research/observer observations are never an execution trigger.
        const executionCandidates = (routes || []).filter((candidate: any) =>
          chains.includes(candidate.chain) &&
          candidate.enabled === true &&
          candidate.strategy_bot_id &&
          candidate.builder_enabled === true &&
          !!candidate.transaction_builder &&
          candidate.discovery_only !== true &&
          ['dex_cex', 'cyclic', 'multi_venue'].includes(candidate.route_type)
        )

        for (const executionRoute of executionCandidates) {
          const pair = PAIRS.find((candidate) => candidate.chain === executionRoute.chain && candidate.pair === executionRoute.pair)
          if (!pair) continue
          const strategyBot = (strategyBots || []).find((candidate: any) => candidate.id === executionRoute.strategy_bot_id) || null
          const wallet = (wallets.data || []).find((candidate: any) => candidate.chain === executionRoute.chain) || null
          const research: any = {
            chain: executionRoute.chain, pair: executionRoute.pair, execution_route_id: executionRoute.id,
            strategy_bot_id: strategyBot?.id || null, strategy: strategyBot?.strategy || executionRoute.strategy || null,
            research_layer: null, builder: executionRoute.transaction_builder, execution_source: 'explicit_execution_route',
          }
          let dexPreflight: any = null
          let builderError: string | null = null
          if (wallet) {
            try {
              dexPreflight = await buildDexPreflight(executionRoute, wallet.id, wallet.address, pair.probe)
              research.dex_preflight = dexPreflight
            } catch (e) {
              builderError = e instanceof Error ? e.message : String(e)
              research.dex_preflight_error = builderError
            }
          }
          const cexExecutionAdapterConfigured = false
          const transactionBuilt = !!dexPreflight?.sell?.transaction_payload_hash && !!dexPreflight?.buy?.transaction_payload_hash
          const executionGate = !zeroCapitalWindow ? 'zero_capital_policy_not_active'
            : !strategyBot ? 'strategy_bot_not_linked'
            : executionRoute.discovery_only ? 'strategy_route_discovery_only'
            : !executionRoute.builder_enabled || !executionRoute.transaction_builder ? 'transaction_builder_not_configured'
            : builderError ? 'transaction_builder_preflight_failed'
            : !['dex_cex', 'cyclic', 'multi_venue'].includes(executionRoute.route_type) ? 'route_requires_atomic_multileg_builder'
            : !transactionBuilt ? 'transaction_builder_incomplete'
            : !cexExecutionAdapterConfigured ? 'cex_execution_adapter_missing'
            : !signerAdapters.length ? 'internal_signer_unavailable' : 'eligible'
          const payloadHash = await sha256(JSON.stringify(research))
          const txPayloadHash = dexPreflight?.sell?.transaction_payload_hash || dexPreflight?.buy?.transaction_payload_hash || null
          await supabase.from('execution_attempts').insert({
            owner_id: bot.owner_id, adapter_id: null, strategy_bot_id: strategyBot?.id || null, observation_id: null,
            observed_route_id: null, execution_route_id: executionRoute.id, chain: executionRoute.chain, execution_mode: 'cex',
            status: executionGate === 'eligible' ? 'validated' : 'blocked', opportunity_payload_hash: payloadHash,
            transaction_payload_hash: txPayloadHash, capital_used: 0, failure_reason: executionGate === 'eligible' ? null : executionGate,
            validated_at: now.toISOString(),
          })
          opportunities.push({ ...research, execution_gate: executionGate, execution_route_id: executionRoute.id, observation_saved: false })

        }

        const output = {
          ok: true,
          execution_mode: zeroCapitalWindow ? 'builder_preflighted' : 'blocked_policy',
          research_layer: null,
          opportunities,
          controls: {
            withdrawal_path_available_to_bot: false,
            real_trade_claims_disabled_until_tx_hash: true,
            transaction_builder_present: true,
            transaction_builder_preflighted: opportunities.some((item) => item.dex_preflight),
            cex_execution_adapter_present: false,
            atomic_multileg_builder_present: false,
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
            last_error: opportunities.length ? null : 'no_explicit_execution_route',
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
      research_layer: null,
      live_execution_policy: zeroCapitalWindow ? 'zero_capital_for_initial_24h' : 'policy_blocked',
      actual_broadcasts: 0,
      confirmed_profits: 0,
      results,
    })
  },
}
