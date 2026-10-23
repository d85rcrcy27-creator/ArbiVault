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
  {
    chain: 'solana',
    pair: 'SOL/USDT',
    symbol: 'SOLUSDT',
    okx: 'SOL-USDT',
    probe: { sell: '10000000', buy: '100000000' }, // 0.01 SOL / 100 USDT (six decimal stablecoin)
  },
  {
    chain: 'ethereum',
    pair: 'ETH/USDC',
    symbol: 'ETHUSDC',
    okx: 'ETH-USDC',
    probe: { sell: '1000000000000000', buy: '100000000' }, // 0.001 ETH / 100 USDC
  },
]

async function authorized(req: Request) {
  const token = req.headers.get('x-arbivault-cron-token')
  if (!token) return false
  const { data } = await supabase.rpc('get_bot_cron_token')
  return !!data && token === data
}


async function testnetBackendDiagnostic() {
  const endpoint = Deno.env.get('BSC_TESTNET_RPC_URL') || 'https://bsc-testnet-dataseed.bnbchain.org'
  const checkedAt = new Date().toISOString()
  try {
    const response = await fetch(endpoint, {
      method: 'POST',
      headers: { 'content-type': 'application/json', accept: 'application/json' },
      body: JSON.stringify({ jsonrpc: '2.0', id: crypto.randomUUID(), method: 'eth_chainId', params: [] }),
      signal: AbortSignal.timeout(6000),
    })
    if (!response.ok) throw new Error(`rpc_http_${response.status}`)
    const body = await response.json()
    if (body.error || typeof body.result !== 'string') throw new Error('rpc_chain_id_unavailable')
    const chainId = String(body.result).toLowerCase()
    if (chainId !== '0x61') {
      return {
        ok: false, network: 'BNB Smart Chain Testnet', expected_chain_id: 97,
        chain_id_hex: chainId, reason: 'testnet_rpc_wrong_chain', checked_at: checkedAt,
        transaction_broadcast_tested: false,
      }
    }
    const blockResponse = await fetch(endpoint, {
      method: 'POST',
      headers: { 'content-type': 'application/json', accept: 'application/json' },
      body: JSON.stringify({ jsonrpc: '2.0', id: crypto.randomUUID(), method: 'eth_blockNumber', params: [] }),
      signal: AbortSignal.timeout(6000),
    })
    if (!blockResponse.ok) throw new Error(`rpc_block_http_${blockResponse.status}`)
    const blockBody = await blockResponse.json()
    if (blockBody.error || typeof blockBody.result !== 'string') throw new Error('rpc_block_number_unavailable')
    return {
      ok: true, network: 'BNB Smart Chain Testnet', chain_id: 97, chain_id_hex: chainId,
      latest_block_number: Number(BigInt(blockBody.result)), checked_at: checkedAt,
      rpc_source: Deno.env.get('BSC_TESTNET_RPC_URL') ? 'configured_testnet_rpc' : 'public_testnet_rpc',
      transaction_broadcast_tested: false,
      live_market_prices_are_separate: true,
      mainnet_signing_unchanged: true,
    }
  } catch (error) {
    return {
      ok: false, network: 'BNB Smart Chain Testnet', expected_chain_id: 97,
      reason: error instanceof Error ? error.message : 'testnet_rpc_check_failed',
      checked_at: checkedAt, transaction_broadcast_tested: false,
      mainnet_signing_unchanged: true,
    }
  }
}

async function confirmBroadcastAttempt(attemptId: string, txHash: string) {
  const token = (await supabase.rpc('get_bot_cron_token')).data
  const response = await fetch(`${Deno.env.get('SUPABASE_URL')}/functions/v1/arbivault-execution-confirm`, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      'x-arbivault-cron-token': String(token || ''),
    },
    body: JSON.stringify({ execution_attempt_id: attemptId, tx_hash: txHash }),
  })
  const body = await response.json().catch(() => ({}))
  return { ok: response.ok, status: response.status, ...body }
}


async function runWalletRotationSafety() {
  const token = (await supabase.rpc('get_bot_cron_token')).data
  if (!token) {
    return {
      ok: false,
      worker: 'wallet-rotation',
      blocked_chains: ['bnb', 'ethereum'],
      errors: [{ error: 'cron_token_unavailable' }],
      rotated_wallets: [],
    }
  }

  try {
    const response = await fetch(
      `${Deno.env.get('SUPABASE_URL')}/functions/v1/arbivault-wallet-rotation`,
      {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          'x-arbivault-cron-token': String(token),
        },
        body: JSON.stringify({ trigger: 'execution_bot_preflight' }),
        signal: AbortSignal.timeout(15000),
      },
    )
    const body = await response.json().catch(() => ({}))
    let blocked = Array.isArray(body?.blocked_chains)
      ? body.blocked_chains.map((chain: unknown) => String(chain))
      : []
    if (!response.ok && blocked.length === 0) blocked = ['bnb', 'ethereum']
    return {
      ...body,
      ok: response.ok && body?.ok === true,
      blocked_chains: blocked,
      http_status: response.status,
    }
  } catch (error) {
    return {
      ok: false,
      worker: 'wallet-rotation',
      blocked_chains: ['bnb', 'ethereum'],
      rotated_wallets: [],
      errors: [{ error: error instanceof Error ? error.message : 'wallet_rotation_unreachable' }],
    }
  }
}

async function settleExistingBroadcasts() {
  const { data: attempts, error } = await supabase
    .from('execution_attempts')
    .select('id,tx_hash,status')
    .eq('execution_mode', 'on_chain')
    .eq('status', 'broadcast')
    .not('tx_hash', 'is', null)
    .order('broadcast_at', { ascending: true })
    .limit(20)
  if (error) throw error
  const results = []
  for (const attempt of attempts || []) {
    if (!attempt.tx_hash) continue
    results.push({ execution_attempt_id: attempt.id, ...(await confirmBroadcastAttempt(attempt.id, attempt.tx_hash)) })
  }
  return results
}

async function invokeAuthorizedSigners(skipChains: Set<string> = new Set<string>()) {
  const { data: requests, error } = await supabase
    .from('signing_requests')
    .select('id,owner_id,execution_attempt_id,source_wallet_id,chain,unsigned_transaction,execution_authorization_id,approval_expires_at')
    .eq('status','authorized')
    .eq('biometric_required',true)
    .eq('biometric_verified',true)
    .gt('approval_expires_at', new Date().toISOString())
    .limit(10)
  if (error) throw error

  const signerUrl = `${Deno.env.get('SUPABASE_URL')}/functions/v1/arbivault-signer`
  const cronToken = (await supabase.rpc('get_bot_cron_token')).data
  const results = []

  for (const request of requests || []) {
    if (skipChains.has(String(request.chain || ""))) {
      results.push({
        signing_request_id: request.id,
        invoked: false,
        reason: "wallet_contract_code_check_unavailable",
      })
      continue
    }

    const { data: attempt } = await supabase
      .from('execution_attempts')
      .select('id,adapter_id,chain,wallet_id,status,execution_route_id,strategy_bot_id,fee_breakdown')
      .eq('id', request.execution_attempt_id)
      .maybeSingle()

    if (!attempt || attempt.status !== 'validated' || !attempt.adapter_id || !attempt.wallet_id) {
      results.push({ signing_request_id: request.id, invoked: false, reason: 'execution_attempt_not_ready' })
      continue
    }

    // This signer queue is scoped to one strategy only. Never broadcast stale
    // authorizations from another bot or a discovery-only route.
    const { data: route } = await supabase
      .from('arbivault_strategy_routes')
      .select('id,route_type,enabled,discovery_only,builder_enabled,strategy_bot_id,payout_test_authorized,payout_test_used_at,payout_test_execution_attempt_id')
      .eq('id', attempt.execution_route_id)
      .maybeSingle()
    const { data: strategyBot } = await supabase
      .from('arbivault_strategy_bots')
      .select('enabled,execution_enabled,flash_loan_enabled')
      .eq('id', attempt.strategy_bot_id)
      .maybeSingle()
    const chainDiagnostic: any = String(attempt.chain) === 'ethereum'
      ? flashExecutorDiagnostic?.ethereum
      : flashExecutorDiagnostic?.bnb
    const feeBreakdown = attempt.fee_breakdown && typeof attempt.fee_breakdown === 'object'
      ? attempt.fee_breakdown
      : {}
    const payoutTestAttempt = feeBreakdown.payout_test_mode === true &&
      route?.payout_test_authorized === true &&
      route?.payout_test_used_at != null &&
      String(route?.payout_test_execution_attempt_id || '') === String(attempt.id)
    const normalExecutionReady = route?.discovery_only !== true &&
      route?.builder_enabled === true &&
      chainDiagnostic?.ready_for_live_trading === true
    const payoutTestReady = payoutTestAttempt &&
      route?.discovery_only === true &&
      chainDiagnostic?.ready_for_flash_transaction_test === true
    if (
      !route ||
      route.route_type !== 'flash_liquidity' ||
      route.enabled !== true ||
      route.strategy_bot_id !== attempt.strategy_bot_id ||
      !strategyBot ||
      strategyBot.enabled !== true ||
      strategyBot.execution_enabled !== true ||
      strategyBot.flash_loan_enabled !== true ||
      (!normalExecutionReady && !payoutTestReady)
    ) {
      results.push({
        signing_request_id: request.id,
        invoked: false,
        reason: !route ? 'flash_route_not_found'
          : payoutTestAttempt && !payoutTestReady ? 'flash_payout_test_executor_not_ready'
          : 'single_style_atomic_flash_route_not_execution_ready',
        payout_test_attempt: payoutTestAttempt,
        live_trading_ready: chainDiagnostic?.ready_for_live_trading === true,
        payout_test_ready: chainDiagnostic?.ready_for_flash_transaction_test === true,
      })
      continue
    }

    const response = await fetch(signerUrl, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        'x-arbivault-cron-token': String(cronToken || ''),
      },
      body: JSON.stringify({
        adapter_id: attempt.adapter_id,
        source_wallet_id: attempt.wallet_id,
        signing_request_id: request.id,
        chain: request.chain,
        unsigned_transaction: request.unsigned_transaction,
        mode: 'trade',
      }),
    })
    const body = await response.json().catch(() => ({}))
    const broadcastAt = new Date().toISOString()
    if (response.ok && body?.tx_hash) {
      await supabase.from('execution_attempts').update({
        status: 'broadcast',
        tx_hash: String(body.tx_hash),
        signed_at: broadcastAt,
        broadcast_at: broadcastAt,
        updated_at: broadcastAt,
        failure_reason: null,
      }).eq('id', attempt.id).eq('status', 'validated')
    }
    results.push({
      signing_request_id: request.id,
      execution_attempt_id: attempt.id,
      invoked: response.ok,
      signer_status: response.status,
      tx_hash: body?.tx_hash || null,
      broadcast: response.ok === true && !!body?.tx_hash,
      error: body?.error || null,
    })
  }
  return results
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
  for (const candidate of quotes) {
    if (!candidate) continue
    const quote = candidate
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

  const sell = await callTransactionBuilder({
    route_id: route.id,
    source_wallet_id: walletId,
    side: 'sell',
    amount_raw: probe.sell,
    slippage_bps: 50,
    price_impact_pct: 0,
  })
  const buy = await callTransactionBuilder({
    route_id: route.id,
    source_wallet_id: walletId,
    side: 'buy',
    amount_raw: probe.buy,
    slippage_bps: 50,
    price_impact_pct: 0,
  })

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


// Fee policy for flash-loan routes: amounts are valued in the stablecoin profit
// asset (USDT/USDC) and represented as USD-equivalent amounts for accounting.
function rawStablecoinUsd(raw: unknown, decimals: number): number | null {
  if (typeof raw !== 'string' || !/^-?\d+$/.test(raw)) return null
  const amount = Number(BigInt(raw)) / (10 ** decimals)
  return Number.isFinite(amount) ? amount : null
}

function makeFlashFeeAccounting(chain: string, best: any): Record<string, unknown> {
  const decimals = chain === 'ethereum' ? 6 : 18
  const gross = rawStablecoinUsd(best?.gross_profit_raw, decimals)
  const premium = rawStablecoinUsd(best?.flash_premium_raw, decimals)
  const networkFee = rawStablecoinUsd(best?.estimated_gas_cost_raw, decimals)
  const net = rawStablecoinUsd(best?.estimated_net_profit_raw, decimals)
  return {
    pnl_currency: 'USD',
    gross_profit_usd: gross,
    flash_loan_fee_usd: premium,
    estimated_network_fee_usd: networkFee,
    estimated_net_profit_usd: net,
    estimated_total_cost_usd: premium === null || networkFee === null ? null : premium + networkFee,
    x402_resource_fee_usd: 0,
    x402_fee_source: 'no_paid_x402_request_in_flash_execution_path',
    gas_asset: chain === 'bnb' ? 'BNB' : chain === 'ethereum' ? 'ETH' : null,
    network_fee_valuation_asset: chain === 'bnb' ? 'USDT' : chain === 'ethereum' ? 'USDC' : null,
    fee_estimate_source: 'transaction-builder-live-router-quote',
    fee_accounting_status: gross !== null && premium !== null && networkFee !== null && net !== null
      ? 'preflight_estimate'
      : 'fee_or_pnl_estimate_unavailable',
  }
}

async function maximumTransactionFeeUsd(transactionPayload: unknown, chain: string): Promise<number | null> {
  if (typeof transactionPayload !== 'string' || !['bnb', 'ethereum'].includes(chain)) return null
  let transaction: any
  try { transaction = JSON.parse(transactionPayload) } catch { return null }
  const parseRaw = (value: unknown): bigint | null => {
    try {
      if (typeof value !== 'string' && typeof value !== 'number') return null
      const text = String(value)
      if (!/^(0x[0-9a-f]+|[0-9]+)$/i.test(text)) return null
      return BigInt(text)
    } catch { return null }
  }
  const gas = parseRaw(transaction?.gas)
  const gasPrice = parseRaw(transaction?.gasPrice)
  if (gas === null || gasPrice === null || gas <= 0n || gasPrice <= 0n) return null
  const feeNative = Number(gas * gasPrice) / 1e18
  if (!Number.isFinite(feeNative) || feeNative <= 0) return null
  const symbol = chain === 'bnb' ? 'BNBUSDT' : 'ETHUSDT'
  try {
    const response = await fetch('https://api.binance.com/api/v3/ticker/price?symbol=' + symbol, {
      headers: { accept: 'application/json' },
      signal: AbortSignal.timeout(5000),
    })
    if (!response.ok) return null
    const body = await response.json()
    const spot = Number(body?.price)
    if (!Number.isFinite(spot) || spot <= 0) return null
    // Include 10% headroom for USD valuation movement during broadcast/confirmation.
    return feeNative * spot * 1.10
  } catch {
    return null
  }
}

function maxNetworkFeeBudgetUsd(strategyBot: any): number {
  const configured = strategyBot?.max_gas_budget
  if (configured !== null && configured !== undefined && configured !== '') {
    const value = Number(configured)
    if (Number.isFinite(value) && value >= 0) return value
  }
  const envValue = Number(Deno.env.get('ARBIVAULT_MAX_NETWORK_FEE_USD') || '5')
  return Number.isFinite(envValue) && envValue >= 0 ? envValue : 5
}

export default {
  fetch: async (req: Request) => {
    if (req.method !== 'POST' || !(await authorized(req))) {
      return Response.json({ error: 'unauthorized' }, { status: 401 })
    }

    // Broadcast settlement and wallet safety take priority over market scanning.
    // Existing receipts are read-only checks; rotation quarantines unsafe EVM wallets
    // before the signer queue is invoked.
    const settledBroadcasts = await settleExistingBroadcasts().catch((error) => [{
      invoked: false,
      reason: error instanceof Error ? error.message : String(error),
    }])
    const [walletRotationSafety, testnetBackend] = await Promise.all([
      runWalletRotationSafety(),
      testnetBackendDiagnostic(),
    ])
    const walletSafetyBlockedChains = new Set<string>(
      Array.isArray(walletRotationSafety.blocked_chains)
        ? walletRotationSafety.blocked_chains.map((chain: unknown) => String(chain))
        : ['bnb', 'ethereum'],
    )

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

    // Capital allowance is not an execution eligibility gate. Actual wallet
    // balances, transaction-builder preflight, gas availability, route readiness,
    // and signer authorization remain enforced before any broadcast.
    const executionWindowActive = policyActive
    const signerInvocations = executionWindowActive
      ? await invokeAuthorizedSigners(walletSafetyBlockedChains).catch((error) => [{
          invoked: false,
          reason: error instanceof Error ? error.message : String(error),
        }])
      : [{ invoked: false, reason: 'execution_policy_not_active' }]

    const flashExecutorDiagnostic = await callTransactionBuilder({ mode: 'diagnostic' }).catch((error) => ({
      diagnostic_only: true,
      ready_for_flash_transaction_test: false,
      payout_behavior_verified: false,
      diagnostic_error: error instanceof Error ? error.message : 'flash_executor_diagnostic_failed',
    }))

    // Each strategy owns its execution loop; this runtime selects flash-loan strategies only.
    const { data: strategyBots, error: strategyBotError } = await supabase
      .from('arbivault_strategy_bots')
      .select('id,owner_id,name,strategy,enabled,execution_enabled,flash_loan_enabled,max_trade_size,min_profit_threshold,slippage_tolerance,max_gas_budget,cooldown_ms,chains')
      .eq('enabled', true)
      .eq('execution_enabled', true)
      .eq('flash_loan_enabled', true)
      .in('strategy', ['flash_loan', 'flash_loan_arbitrage'])

    if (strategyBotError) return Response.json({ error: strategyBotError.message }, { status: 500 })
    const bots = strategyBots || []

    const { data: routes, error: routeError } = await supabase
      .from('arbivault_strategy_routes')
      .select('id,strategy,strategy_bot_id,chain,pair,route_type,enabled,discovery_only,transaction_builder,builder_enabled,builder_status,payout_test_authorized,payout_test_authorized_by,payout_test_authorized_at,payout_test_used_at,payout_test_execution_attempt_id,payout_test_tx_hash')
      .eq('enabled', true)
      .eq('route_type', 'flash_liquidity')

    if (routeError) return Response.json({ error: routeError.message }, { status: 500 })

    const { data: adapters, error: adapterError } = await supabase
      .from('execution_adapters')
      .select('*')
      .eq('configured', true)

    if (adapterError) return Response.json({ error: adapterError.message }, { status: 500 })

    // Public market adapters are valid execution venues only when their catalog
    // explicitly marks them executable. Public quote access alone does not prove
    // order-placement capability; private-auth metadata alone does not grant it.
    const { data: marketAdapters, error: marketAdapterError } = await supabase
      .from('arbivault_market_adapters')
      .select('id,name,venue_type,base_url,public_api,private_auth_required,enabled,read_only,chains')
      .eq('enabled', true)

    if (marketAdapterError) return Response.json({ error: marketAdapterError.message }, { status: 500 })

    // These adapters are signing/broadcast boundaries, not exchange trading venues.
    const signerAdapters = (adapters || []).filter((adapter: any) =>
      adapter.health_status === 'healthy' &&
      adapter.can_broadcast === true &&
      adapter.read_only === false &&
      adapter.signer_provider === 'internal_vault' &&
      !!adapter.allowed_wallet_id
    )
    const cexExecutionAdapters = (adapters || []).filter((adapter: any) =>
      adapter.health_status === 'healthy' &&
      adapter.configured === true &&
      adapter.can_broadcast === true &&
      adapter.read_only === false &&
      ['cex','exchange_execution'].includes(String(adapter.adapter_type || '').toLowerCase())
    )

    // Public CEX quote feeds are data-only. This worker currently has no authenticated
    // CEX order submission/fill-reconciliation implementation, so neither a public feed
    // nor a manually toggled read_only flag may qualify a CEX venue for execution.
    const publicCexExecutionAdapters: any[] = []
    const cexExecutionBlocker = cexExecutionAdapters.length > 0
      ? 'cex_order_submission_not_implemented_in_worker'
      : 'private_cex_order_adapter_not_configured'
    const cexExecutionConfigured = false


    const results: any[] = []

    for (const bot of bots || []) {
      const run = await supabase
        .from('bot_execution_runs')
        .insert({
          owner_id: bot.owner_id,
          bot_config_id: null,
          workflow: 'flash_loan_strategy',
          idempotency_key: crypto.randomUUID(),
          input: {
            role: 'strategy',
            priority: 'early_bird',
            execution_policy_mode: policy?.mode || 'unconfigured',
            strategy_bot_id: bot.id,
            strategy_name: bot.name,
            flash_loan_only: true,
            capital_allowance_used_as_trade_limit: false,
          },
        })
        .select('id')
        .single()

      try {
        const chains = bot.chains?.length ? bot.chains : ['solana', 'bnb']
        const opportunities: any[] = []

        const wallets = await supabase
          .from('wallets')
          .select('id,chain,address,status,is_hot,wallet_role,data_quality_status')
          .eq('owner_id', bot.owner_id)
          .eq('status', 'active')
          .eq('is_hot', true)
          .eq('wallet_role', 'trading_hot')

        if (wallets.error) throw wallets.error

        const { data: approvedWalletRows, error: approvedWalletError } = await supabase
          .from('approved_wallets')
          .select('wallet_id')
          .eq('owner_id', bot.owner_id)
          .eq('status', 'approved')
        if (approvedWalletError) throw approvedWalletError
        const approvedWalletIds = new Set((approvedWalletRows || []).map((row: any) => row.wallet_id))
        const executionEligibleWallets = (wallets.data || []).filter((wallet: any) =>
          wallet.data_quality_status === 'verified' && approvedWalletIds.has(wallet.id)
        )

        // Execution wallets must be explicitly bound to this strategy bot on the
        // same chain. An owner's other approved wallets are not interchangeable.
        const { data: strategyWalletBindings, error: strategyWalletBindingError } = await supabase
          .from('arbivault_strategy_wallets')
          .select('wallet_id,chain,purpose,status')
          .eq('owner_id', bot.owner_id)
          .eq('strategy_bot_id', bot.id)
          .eq('status', 'assigned')
        if (strategyWalletBindingError) throw strategyWalletBindingError
        const botWalletBindings = (strategyWalletBindings || []).filter((binding: any) =>
          binding.purpose === 'strategy_execution' &&
          binding.wallet_id &&
          binding.chain
        )
        const botWalletIdsByChain = new Map<string, Set<string>>()
        for (const binding of botWalletBindings) {
          const chainWalletIds = botWalletIdsByChain.get(binding.chain) || new Set<string>()
          chainWalletIds.add(binding.wallet_id)
          botWalletIdsByChain.set(binding.chain, chainWalletIds)
        }

        const flashRouteDiagnostics = (routes || [])
          .filter((candidate: any) =>
            candidate.enabled === true &&
            candidate.route_type === 'flash_liquidity'
          )
          .map((candidate: any) => {
            const diagnostic: any = flashExecutorDiagnostic || {}
            const networkDiagnostic: any = candidate.chain === 'ethereum'
              ? diagnostic.ethereum
              : diagnostic.bnb
            const executor: any = networkDiagnostic?.executor || {}
            const routeBot: any = (strategyBots || []).find((item: any) => item.id === candidate.strategy_bot_id) || null
            const boundWalletIds = botWalletIdsByChain.get(candidate.chain) || new Set<string>()
            const boundWallet: any = executionEligibleWallets.find((item: any) =>
              item.chain === candidate.chain && boundWalletIds.has(item.id)
            ) || null
            let blocker = 'flash_executor_payout_unverified'

            if (!networkDiagnostic?.rpc_chain_ok) {
              blocker = candidate.chain === 'ethereum'
                ? 'ethereum_rpc_unhealthy'
                : 'bsc_rpc_unhealthy'
            } else if (!networkDiagnostic?.aave_pool_resolved) {
              blocker = candidate.chain === 'ethereum'
                ? 'ethereum_aave_pool_unresolved'
                : 'bsc_aave_pool_unresolved'
            } else if (!executor.configured) {
              blocker = candidate.chain === 'ethereum'
                ? 'ethereum_flash_executor_not_configured'
                : 'flash_executor_not_configured'
            } else if (!executor.code_deployed) {
              blocker = 'flash_executor_bytecode_missing'
            } else if (!executor.payout_recipient_address) {
              blocker = 'flash_executor_payout_recipient_unreadable'
            } else if (!executor.payout_recipient_matches_generated_hot_wallet) {
              blocker = 'flash_executor_payout_wallet_not_generated_hot_wallet'
            } else if (executor.source_verification?.verified !== true) {
              blocker = 'flash_executor_source_unverified'
            } else if (!candidate.transaction_builder || candidate.builder_enabled !== true) {
              blocker = candidate.chain === 'ethereum'
                ? 'ethereum_flash_builder_not_configured'
                : 'flash_executor_builder_not_configured'
            } else if (networkDiagnostic?.payout_behavior_verified !== true) {
              blocker = 'flash_executor_payout_not_end_to_end_verified'
            } else if (networkDiagnostic?.ready_for_flash_transaction_test !== true) {
              blocker = 'flash_executor_preflight_not_ready'
            } else {
              blocker = 'ready_for_explicit_preflight'
            }
            const blockers: string[] = []
            if (networkDiagnostic?.rpc_chain_ok !== true) blockers.push(candidate.chain === 'ethereum' ? 'ethereum_rpc_unhealthy' : 'bsc_rpc_unhealthy')
            if (networkDiagnostic?.aave_pool_resolved !== true) blockers.push(candidate.chain === 'ethereum' ? 'ethereum_aave_pool_unresolved' : 'bsc_aave_pool_unresolved')
            if (executor.configured !== true) blockers.push(candidate.chain === 'ethereum' ? 'ethereum_flash_executor_not_configured' : 'flash_executor_not_configured')
            if (executor.code_deployed !== true) blockers.push('flash_executor_bytecode_missing')
            if (executor.pool_matches_expected !== true) blockers.push('flash_executor_pool_mismatch')
            if (!executor.payout_recipient_address) blockers.push('flash_executor_payout_recipient_unreadable')
            if (executor.payout_recipient_matches_generated_hot_wallet !== true) blockers.push('flash_executor_payout_wallet_not_verified')
            if (executor.source_verification?.verified !== true) blockers.push('flash_executor_source_unverified')
            if (networkDiagnostic?.payout_audited !== true) blockers.push('flash_executor_payout_configuration_not_audited')
            if (networkDiagnostic?.payout_behavior_verified !== true) blockers.push('flash_executor_payout_behavior_not_verified')
            if (!boundWallet) blockers.push('strategy_wallet_binding_missing_or_unverified')
            else if (executor.payout_recipient_address &&
              String(executor.payout_recipient_address).toLowerCase() !== String(boundWallet.address).toLowerCase()) {
              blockers.push('flash_executor_hot_wallet_does_not_match_strategy_wallet')
            }
            if (!candidate.transaction_builder) blockers.push('flash_transaction_builder_missing')
            if (candidate.builder_enabled !== true && candidate.payout_test_authorized !== true) blockers.push('flash_transaction_builder_disabled')
            if (candidate.discovery_only === true) blockers.push('strategy_route_discovery_only')
            if (!routeBot || routeBot.enabled !== true || routeBot.execution_enabled !== true || routeBot.flash_loan_enabled !== true) {
              blockers.push('flash_strategy_bot_not_execution_enabled')
            }
            if (networkDiagnostic?.ready_for_flash_transaction_test !== true) blockers.push('flash_executor_not_ready_for_payout_test')
            if (networkDiagnostic?.ready_for_live_trading !== true) blockers.push('flash_executor_not_ready_for_live_trading')
            const primaryBlocker = blockers[0] || blocker
            return {
              id: candidate.id,
              chain: candidate.chain,
              pair: candidate.pair,
              builder: candidate.transaction_builder,
              builder_enabled: candidate.builder_enabled === true,
              discovery_only: candidate.discovery_only === true,
              payout_test_authorized: candidate.payout_test_authorized === true,
              payout_test_used_at: candidate.payout_test_used_at || null,
              bound_wallet_id: boundWallet?.id || null,
              bound_wallet_address: boundWallet?.address || null,
              payout_recipient_address: executor.payout_recipient_address || null,
              payout_recipient_matches_generated_hot_wallet: executor.payout_recipient_matches_generated_hot_wallet === true,
              payout_behavior_verified: networkDiagnostic?.payout_behavior_verified === true,
              blockers,
              ready_for_transaction_test: networkDiagnostic?.ready_for_flash_transaction_test === true && !!boundWallet && String(executor.payout_recipient_address || '').toLowerCase() === String(boundWallet.address || '').toLowerCase(),
              ready_for_live_trading: networkDiagnostic?.ready_for_live_trading === true && candidate.enabled === true && candidate.discovery_only !== true && candidate.builder_enabled === true && !!boundWallet && String(executor.payout_recipient_address || '').toLowerCase() === String(boundWallet.address || '').toLowerCase(),
              blocker: primaryBlocker,
            }
          })

        // Keep the route catalogue honest without creating fake execution attempts.
        for (const diagnostic of flashRouteDiagnostics) {
          const routeRow = (routes || []).find((candidate: any) => candidate.id === diagnostic.id)
          const statusText = (diagnostic.blockers || []).length
            ? diagnostic.blockers.join(';').slice(0, 500)
            : diagnostic.blocker
          if (routeRow && routeRow.builder_status !== statusText) {
            await supabase.from('arbivault_strategy_routes')
              .update({ builder_status: statusText, updated_at: new Date().toISOString() })
              .eq('id', diagnostic.id)
              .eq('builder_status', routeRow.builder_status)
          }
        }

        // Execution consumes only explicitly executable strategy routes.
        // Research/observer observations are never an execution trigger.
        const executionCandidates = (routes || []).filter((candidate: any) =>
          chains.includes(candidate.chain) &&
          candidate.enabled === true &&
          candidate.strategy_bot_id === bot.id &&
          candidate.route_type === 'flash_liquidity' &&
          candidate.transaction_builder === 'aave_v3_atomic_flash_loan_v1' &&
          (
            // Discovery-only atomic flash routes may obtain real quotes and cost
            // estimates, but the downstream execution gate must keep them from
            // creating attempts or signing requests.
            candidate.discovery_only === true ||
            (candidate.builder_enabled === true && candidate.discovery_only !== true) ||
            (candidate.payout_test_authorized === true && candidate.payout_test_used_at == null && candidate.discovery_only === true)
          )
        )

        for (const executionRoute of executionCandidates) {
          const pair = PAIRS.find((candidate) => candidate.chain === executionRoute.chain && candidate.pair === executionRoute.pair)
          if (!pair) continue
          const strategyBot = (strategyBots || []).find((candidate: any) => candidate.id === executionRoute.strategy_bot_id) || null
          const botWalletIds = botWalletIdsByChain.get(executionRoute.chain) || new Set<string>()
          const wallet = executionEligibleWallets.find((candidate: any) =>
            candidate.chain === executionRoute.chain && botWalletIds.has(candidate.id)
          ) || null
          const payoutTestMode = executionRoute.payout_test_authorized === true && executionRoute.payout_test_used_at == null
          let payoutTestClaimed = false
          const executionContext: any = {
            payout_test_mode: payoutTestMode,
            payout_test_used_at: executionRoute.payout_test_used_at || null,
            chain: executionRoute.chain, pair: executionRoute.pair, execution_route_id: executionRoute.id,
            strategy_bot_id: strategyBot?.id || null, strategy: strategyBot?.strategy || executionRoute.strategy || null,
            builder: executionRoute.transaction_builder,
            execution_source: executionRoute.route_type === 'flash_liquidity' ? 'flash_skill_to_atomic_execution_pipeline' : 'explicit_execution_route',
            cex_execution: executionRoute.route_type === 'dex_cex'
              ? {
                  private_adapter_available: cexExecutionAdapters.length > 0,
                  public_order_adapter_available: false,
                  available: cexExecutionConfigured,
                  blocker: cexExecutionBlocker,
                }
              : null,
          }
          let dexPreflight: any = null
          let flashQuote: any = null
          let flashBuild: any = null
          let flashFeeAccounting: any = null
          let builderError: string | null = null
          const multiLegBuilderConfigured =
            executionRoute.transaction_builder === 'aave_v3_atomic_flash_loan_v1' &&
            executionRoute.builder_enabled === true &&
            (executionRoute.chain === 'ethereum'
              ? flashExecutorDiagnostic?.ethereum?.ready_for_flash_transaction_test === true
              : flashExecutorDiagnostic?.bnb?.ready_for_flash_transaction_test === true)
          if (wallet && executionRoute.route_type === 'dex_cex') {
            if (!cexExecutionConfigured) {
              // Removed the read-only DEX probe. Do not build probe payloads when
              // there is no order-placement adapter for the other arbitrage leg.
              executionContext.dex_preflight = {
                quote_only: false,
                executable_unsigned: false,
                reason: 'cex_order_placement_adapter_unavailable; read_only_probe_removed',
              }
              builderError = cexExecutionBlocker
            } else {
              try {
                dexPreflight = await buildDexPreflight(
                  executionRoute, wallet.id, wallet.address, pair.probe,
                )
                executionContext.dex_preflight = dexPreflight
              } catch (e) {
                builderError = e instanceof Error ? e.message : String(e)
                executionContext.dex_preflight_error = builderError
              }
            }
          }

          if (executionRoute.route_type === 'flash_liquidity') {
            try {
              if (!wallet && executionRoute.discovery_only !== true) throw new Error('flash_source_wallet_unavailable')
              if (payoutTestMode && !wallet) throw new Error('flash_payout_test_wallet_unavailable')
              const isBnbFlash = executionRoute.chain === 'bnb' && executionRoute.pair === 'BNB/USDT'
              const isEthereumFlash = executionRoute.chain === 'ethereum' && executionRoute.pair === 'ETH/USDC'
              if (!isBnbFlash && !isEthereumFlash) {
                throw new Error('flash_live_quote_route_not_supported')
              }
              if (strategyBot?.flash_loan_enabled !== true) {
                throw new Error('flash_loan_strategy_disabled')
              }
              // Use the strategy's configured notional for quote screening. This is a flash-loan amount, not wallet principal; chain liquidity, slippage, net-profit, gas, executor verification, and signer policy remain enforced.
              const configuredNotional = Number(strategyBot?.max_trade_size)
              const normalNotionalUsd = Number.isFinite(configuredNotional) && configuredNotional > 0
                ? configuredNotional
                : 100
              const notionalUsd = payoutTestMode ? Math.min(normalNotionalUsd, 25) : normalNotionalUsd
              const slippageBps = Math.max(1, Math.min(100, Math.round(Number(strategyBot?.slippage_tolerance ?? 0.5) * 100)))
              const flashAsset = isBnbFlash
                ? '0x55d398326f99059fF775485246999027B3197955'
                : '0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48'
              // BNB-chain USDT uses 18 decimals; Ethereum USDC uses 6 decimals.
              const amountRaw = isBnbFlash
                ? (BigInt(Math.round(notionalUsd * 100000000)) * 10000000000n).toString()
                : BigInt(Math.round(notionalUsd * 1000000)).toString()
              const networkFlashDiagnostic = isEthereumFlash
                ? flashExecutorDiagnostic?.ethereum
                : flashExecutorDiagnostic?.bnb
              flashQuote = await callTransactionBuilder({
                mode: 'flash_quote',
                route_id: executionRoute.id,
                source_wallet_id: wallet?.id || undefined,
                side: 'sell',
                amount_raw: amountRaw,
                flash_loan_asset: flashAsset,
                slippage_bps: slippageBps,
                price_impact_pct: 0,
              })
              executionContext.flash_live_quote = {
                source: flashQuote.source || (isEthereumFlash ? 'live_ethereum_router_quotes' : 'live_bsc_router_quotes'),
                quoted_at: flashQuote.quoted_at || null,
                notional_usd: notionalUsd,
                profitable: flashQuote.profitable === true,
                best: flashQuote.best || null,
                candidate_count: flashQuote.candidate_count || 0,
                executor_configured: flashQuote.executor_configured === true,
              }

              flashFeeAccounting = makeFlashFeeAccounting(executionRoute.chain, flashQuote.best)
              const configuredMinProfit = Number(strategyBot?.min_profit_threshold)
              const minNetProfitUsd = Number.isFinite(configuredMinProfit) && configuredMinProfit > 0
                ? configuredMinProfit
                : 1
              const maxGasBudgetUsd = maxNetworkFeeBudgetUsd(strategyBot)
              flashFeeAccounting.stop_loss_usd = -maxGasBudgetUsd
              flashFeeAccounting.max_network_fee_budget_usd = maxGasBudgetUsd
              flashFeeAccounting.minimum_net_profit_usd = minNetProfitUsd
              flashFeeAccounting.profit_evidence_policy = 'do_not_record_gross_or_net_profit_above_confirmed_executor_settlement_evidence'
              executionContext.flash_fee_accounting = {
                ...flashFeeAccounting,
                fee_policy: 'reject_if_gas_estimate_missing_over_budget_or_net_profit_below_threshold',
              }
              if (flashFeeAccounting.estimated_network_fee_usd == null || flashFeeAccounting.estimated_net_profit_usd == null) {
                builderError = 'flash_network_fee_or_net_profit_estimate_unavailable'
              } else if (Number(flashFeeAccounting.estimated_network_fee_usd) > maxGasBudgetUsd) {
                builderError = 'flash_network_fee_exceeds_max_gas_budget_usd'
              } else if (Number(flashFeeAccounting.estimated_net_profit_usd) < minNetProfitUsd) {
                builderError = 'flash_net_profit_below_min_profit_threshold'
              }

              if (
                (payoutTestMode || (executionRoute.discovery_only !== true && networkFlashDiagnostic?.ready_for_live_trading === true)) &&
                !builderError &&
                flashQuote.profitable === true &&
                (payoutTestMode ? networkFlashDiagnostic?.ready_for_flash_transaction_test === true : networkFlashDiagnostic?.ready_for_live_trading === true) &&
                flashQuote.best?.executor_configured === true &&
                Array.isArray(flashQuote.best?.data) &&
                flashQuote.best.data.length === 2
              ) {
                const gasCostRaw = String(flashQuote.best.estimated_gas_cost_raw || '')
                if (!/^\d+$/.test(gasCostRaw)) throw new Error('flash_network_fee_raw_invalid')
                const decimals = isEthereumFlash ? 6 : 18
                const minNetRaw = BigInt(Math.ceil(minNetProfitUsd * (10 ** decimals)))
                const contractMinProfitRaw = (BigInt(gasCostRaw) + minNetRaw).toString()
                flashBuild = await callTransactionBuilder({
                  mode: payoutTestMode ? 'flash_payout_test_build' : 'flash_build',
                  route_id: executionRoute.id,
                  source_wallet_id: wallet.id,
                  side: 'sell',
                  amount_raw: amountRaw,
                  flash_loan_asset: flashQuote.best.asset,
                  min_profit_raw: contractMinProfitRaw,
                  targets: flashQuote.best.targets,
                  values_raw: flashQuote.best.values_raw,
                  data: flashQuote.best.data,
                  slippage_bps: slippageBps,
                  price_impact_pct: 0,
                })
                executionContext.flash_transaction = {
                  executable: flashBuild?.executable === true,
                  transaction_payload_hash: flashBuild?.transaction_payload_hash || null,
                  estimated_net_profit_raw: flashQuote.best.estimated_net_profit_raw || null,
                }
                if (flashBuild?.executable !== true || typeof flashBuild?.transaction !== 'string') {
                  builderError = 'flash_atomic_transaction_builder_incomplete'
                } else {
                  const transactionFeeCapUsd = await maximumTransactionFeeUsd(
                    flashBuild.transaction,
                    executionRoute.chain,
                  )
                  flashFeeAccounting.transaction_fee_cap_usd = transactionFeeCapUsd
                  flashFeeAccounting.transaction_fee_cap_includes_price_buffer = true
                  executionContext.flash_fee_accounting = {
                    ...(executionContext.flash_fee_accounting || {}),
                    transaction_fee_cap_usd: transactionFeeCapUsd,
                    transaction_fee_cap_includes_price_buffer: true,
                    stop_loss_usd: -maxGasBudgetUsd,
                  }
                  if (transactionFeeCapUsd === null) {
                    builderError = 'flash_transaction_max_fee_valuation_unavailable'
                  } else if (transactionFeeCapUsd > maxGasBudgetUsd) {
                    builderError = 'flash_transaction_max_fee_exceeds_network_fee_budget'
                  }
                }
              }
            } catch (e) {
              builderError = e instanceof Error ? e.message : String(e)
              executionContext.flash_pipeline_error = builderError
            }
          }

          const executionAdapter = wallet
            ? signerAdapters.find((adapter: any) =>
                adapter.allowed_wallet_id === wallet.id &&
                adapter.chain === executionRoute.chain &&
                adapter.automatic_signing === true
              ) || null
            : null
          const executionAdapterConfigured = !!executionAdapter
          const dexSellBuilt = !!dexPreflight?.sell?.transaction_payload_hash && dexPreflight?.sell?.executable_unsigned === true
          const dexBuyBuilt = !!dexPreflight?.buy?.transaction_payload_hash && dexPreflight?.buy?.executable_unsigned === true
          const transactionBuilt = executionRoute.route_type === 'flash_liquidity'
            ? flashBuild?.executable === true && typeof flashBuild?.transaction === 'string'
            : dexSellBuilt && dexBuyBuilt
          // A DEX/CEX arbitrage is two execution legs. A single DEX swap is never
          // sufficient to claim an arbitrage execution or realized PnL.
          const twoLegExecutionReady = executionRoute.route_type === 'flash_liquidity'
            ? transactionBuilt
            : transactionBuilt && cexExecutionConfigured
          const cexOrderExecutionAvailable = executionRoute.route_type !== 'dex_cex' || cexExecutionConfigured
          const chainDiagnostic: any = executionRoute.chain === 'ethereum'
            ? flashExecutorDiagnostic?.ethereum
            : flashExecutorDiagnostic?.bnb
          const liveTradingReady = chainDiagnostic?.ready_for_live_trading === true
          const payoutTestReady = payoutTestMode &&
            chainDiagnostic?.ready_for_flash_transaction_test === true &&
            executionRoute.payout_test_authorized === true &&
            !builderError &&
            flashQuote?.profitable === true &&
            transactionBuilt
          const executionBlockers: string[] = []
          if (!strategyBot) executionBlockers.push('strategy_bot_not_linked')
          if (walletSafetyBlockedChains.has(executionRoute.chain)) executionBlockers.push('wallet_contract_code_check_unavailable')
          if (executionRoute.discovery_only && !payoutTestReady) executionBlockers.push('strategy_route_discovery_only')
          if ((!executionRoute.builder_enabled || !executionRoute.transaction_builder) && !payoutTestReady) executionBlockers.push('transaction_builder_not_configured')
          if (executionRoute.route_type === 'flash_liquidity' && !(payoutTestReady ? chainDiagnostic?.ready_for_flash_transaction_test === true : liveTradingReady)) {
            executionBlockers.push(payoutTestReady ? 'flash_executor_not_ready_for_payout_test' : 'flash_executor_not_ready_for_live_trading')
          }
          if (executionRoute.route_type === 'flash_liquidity' && builderError) executionBlockers.push(builderError)
          if (executionRoute.route_type === 'flash_liquidity' && flashQuote?.profitable !== true) executionBlockers.push('flash_no_profitable_live_opportunity')
          if (executionRoute.route_type === 'flash_liquidity' && !transactionBuilt) executionBlockers.push('flash_atomic_transaction_not_built')
          if (!executionWindowActive && !payoutTestReady) executionBlockers.push('execution_policy_not_active')
          if (['cyclic', 'multi_venue'].includes(executionRoute.route_type) && !multiLegBuilderConfigured) executionBlockers.push('atomic_multileg_builder_required')
          if (executionRoute.route_type === 'dex_cex' && !cexOrderExecutionAvailable) executionBlockers.push(cexExecutionBlocker)
          if (builderError && executionRoute.route_type !== 'flash_liquidity') executionBlockers.push('transaction_builder_preflight_failed')
          if (executionRoute.route_type === 'dex_cex' && !twoLegExecutionReady) executionBlockers.push('two_leg_execution_not_ready')
          if (!transactionBuilt) executionBlockers.push('transaction_builder_incomplete')
          if (!executionAdapterConfigured) executionBlockers.push('execution_signer_adapter_missing')
          if (!signerAdapters.length) executionBlockers.push('internal_signer_unavailable')
          if (payoutTestMode && !payoutTestReady) executionBlockers.push('flash_payout_test_not_claimed_or_not_ready')
          // One primary blocker is retained for old clients; all causes are preserved alongside it.
          const executionGate = executionBlockers.length ? executionBlockers[0] : 'eligible'
          executionContext.execution_blockers = executionBlockers
          executionContext.execution_readiness = {
            payout_test_mode: payoutTestMode,
            payout_test_claimed: payoutTestClaimed,
            payout_test_ready: payoutTestReady,
            live_trading_ready: liveTradingReady,
            chain: executionRoute.chain,
          }
          let opportunityHash = await sha256(JSON.stringify(executionContext))
          const unsignedTransaction = executionRoute.route_type === 'flash_liquidity'
            ? (flashBuild?.transaction || null)
            : twoLegExecutionReady ? (dexPreflight?.sell?.transaction || null) : null
          const txPayloadHash = unsignedTransaction ? await sha256(String(unsignedTransaction)) : null
          const executionAdapterId = executionAdapter?.id || null
          const attemptReady = executionGate === 'eligible' &&
            !!unsignedTransaction && !!txPayloadHash && !!executionAdapterId && !!wallet?.id

          // A blocked route is a diagnostic, not an execution attempt. Keep it in
          // bot_execution_runs.output, but reserve execution_attempts for payloads
          // that actually passed the safety gates and can enter the signing queue.
          if (!attemptReady) {
            opportunities.push({
              ...executionContext,
              execution_gate: executionGate === 'eligible' ? 'signing_payload_incomplete' : executionGate,
              execution_blockers: executionBlockers,
              execution_route_id: executionRoute.id,
              execution_attempt_id: null,
              adapter_id: executionAdapterId,
              signing_request_id: null,
              attempt_created: false,
              signing: 'not_created',
              broadcast: 'not_attempted',
              observation_saved: false,
            })
            continue
          }

          // Idempotency guard: do not create a second active attempt for the same
          // chain-specific unsigned transaction payload. The database unique index
          // remains the final race-safe enforcement point.
          const { data: existingPayloadAttempt, error: duplicateLookupError } = await supabase
            .from('execution_attempts')
            .select('id,status,tx_hash')
            .eq('chain', executionRoute.chain)
            .eq('transaction_payload_hash', txPayloadHash)
            .in('status', ['validated', 'signed', 'broadcast', 'confirmed'])
            .limit(1)
            .maybeSingle()
          if (duplicateLookupError) throw new Error('duplicate_active_transaction_payload_lookup_failed')
          if (existingPayloadAttempt) {
            opportunities.push({
              ...executionContext,
              execution_gate: 'duplicate_active_transaction_payload',
              execution_route_id: executionRoute.id,
              execution_attempt_id: existingPayloadAttempt.id,
              adapter_id: executionAdapterId,
              signing_request_id: null,
              attempt_created: false,
              signing: 'not_created',
              broadcast: 'not_attempted',
              duplicate_of_status: existingPayloadAttempt.status,
              duplicate_of_tx_hash: existingPayloadAttempt.tx_hash || null,
              observation_saved: false,
            })
            continue
          }

          // Consume the human authorization only after all preflight gates and duplicate checks.
          if (payoutTestMode) {
            const { data: claimedRoute, error: claimError } = await supabase
              .from('arbivault_strategy_routes')
              .update({ payout_test_used_at: now.toISOString(), updated_at: now.toISOString() })
              .eq('id', executionRoute.id)
              .eq('strategy_bot_id', bot.id)
              .eq('payout_test_authorized', true)
              .eq('payout_test_authorized_by', bot.owner_id)
              .is('payout_test_used_at', null)
              .is('payout_test_execution_attempt_id', null)
              .select('id')
              .maybeSingle()
            if (claimError || !claimedRoute) {
              opportunities.push({
                ...executionContext,
                execution_gate: claimError ? 'flash_payout_test_claim_failed' : 'flash_payout_test_already_claimed',
                execution_route_id: executionRoute.id,
                execution_attempt_id: null,
                adapter_id: executionAdapterId,
                signing_request_id: null,
                attempt_created: false,
                signing: 'not_created',
                broadcast: 'not_attempted',
              })
              continue
            }
            payoutTestClaimed = true
            executionContext.payout_test_claimed = true
            if (executionContext.execution_readiness) executionContext.execution_readiness.payout_test_claimed = true
            opportunityHash = await sha256(JSON.stringify(executionContext))
          }

          const { data: attempt, error: attemptError } = await supabase.from('execution_attempts').insert({
            owner_id: bot.owner_id, adapter_id: executionAdapterId, strategy_bot_id: strategyBot?.id || null, observation_id: null,
            observed_route_id: null, execution_route_id: executionRoute.id, chain: executionRoute.chain,
            execution_mode: 'on_chain', status: 'validated',
            opportunity_payload_hash: opportunityHash, transaction_payload_hash: txPayloadHash,
            capital_used: 0,
            gross_profit: flashFeeAccounting?.gross_profit_usd ?? null,
            net_profit: flashFeeAccounting?.estimated_net_profit_usd ?? null,
            gas_fee: null,
            gas_asset: flashFeeAccounting?.gas_asset ?? (executionRoute.chain === 'bnb' ? 'BNB' : executionRoute.chain === 'ethereum' ? 'ETH' : null),
            estimated_network_fee_usd: flashFeeAccounting?.estimated_network_fee_usd ?? null,
            network_fee_usd: null,
            flash_loan_fee_usd: flashFeeAccounting?.flash_loan_fee_usd ?? null,
            x402_resource_fee_usd: 0,
            pnl_currency: 'USD',
            fee_breakdown: {
              ...(flashFeeAccounting || {
                pnl_currency: 'USD',
                x402_resource_fee_usd: 0,
                x402_fee_source: 'no_paid_x402_request_attributed_to_execution',
                fee_accounting_status: 'no_flash_fee_quote',
              }),
              payout_test_mode: payoutTestMode,
              payout_test_claimed: payoutTestClaimed,
              stop_loss_usd: -maxNetworkFeeBudgetUsd(strategyBot),
              profit_evidence_policy: 'realized_flash_profit_requires_confirmed_settlement_event',
            },
            failure_reason: null,
            validated_at: now.toISOString(), wallet_id: wallet.id,
          }).select('id').single()
          if (attemptError) throw attemptError

          if (payoutTestMode) {
            const { data: boundRoute, error: bindError } = await supabase
              .from('arbivault_strategy_routes')
              .update({
                payout_test_execution_attempt_id: attempt.id,
                updated_at: new Date().toISOString(),
              })
              .eq('id', executionRoute.id)
              .eq('payout_test_authorized', true)
              .not('payout_test_used_at', 'is', null)
              .is('payout_test_execution_attempt_id', null)
              .select('id')
              .maybeSingle()
            if (bindError || !boundRoute) {
              await supabase.from('arbivault_strategy_routes')
                .update({ payout_test_authorized: false, updated_at: new Date().toISOString() })
                .eq('id', executionRoute.id)
                .eq('payout_test_execution_attempt_id', null)
                .eq('payout_test_used_at', now.toISOString())
              await supabase.from('execution_attempts').update({
                status: 'failed',
                failure_reason: 'flash_payout_test_attempt_binding_failed',
                updated_at: new Date().toISOString(),
              }).eq('id', attempt.id).eq('status', 'validated')
              opportunities.push({
                ...executionContext,
                execution_gate: 'flash_payout_test_attempt_binding_failed',
                execution_attempt_id: attempt.id,
                adapter_id: executionAdapterId,
                signing_request_id: null,
                attempt_created: true,
                signing: 'not_created',
                broadcast: 'not_attempted',
              })
              continue
            }
          }

          let signingRequestId: string | null = null
          if (executionGate === 'eligible' && unsignedTransaction && txPayloadHash && executionAdapterId && wallet?.id) {
            const { data: sr, error: srError } = await supabase.from('signing_requests').insert({
              owner_id: bot.owner_id,
              execution_attempt_id: attempt.id,
              signer_type: 'hot_wallet_signer',
              chain: executionRoute.chain,
              source_wallet_id: wallet.id,
              payload_hash: txPayloadHash,
              unsigned_transaction: String(unsignedTransaction),
              status: 'pending',
              biometric_required: true,
              biometric_verified: false,
              approval_method: 'passkey_qr',
              execution_authorization_id: null,
              expires_at: new Date(Date.now() + 5 * 60 * 1000).toISOString(),
              approval_expires_at: new Date(Date.now() + 5 * 60 * 1000).toISOString(),
            }).select('id').single()
            if (srError) throw srError
            signingRequestId = sr.id
          }
          opportunities.push({
            ...executionContext,
            execution_gate: executionGate,
            execution_route_id: executionRoute.id,
            execution_attempt_id: attempt.id,
            adapter_id: executionAdapterId,
            signing_request_id: signingRequestId,
            signing: signingRequestId ? 'pending_human_authorization' : 'not_created',
            broadcast: 'awaiting_authorized_signing',
            observation_saved: false
          })

        }

        const output = {
          ok: true,
          execution_mode: executionWindowActive ? 'live_preflighted' : 'blocked_policy',
          opportunities,
          controls: {
            wallet_rotation_safety: walletRotationSafety,
            testnet_backend_diagnostic: testnetBackend,
            withdrawal_path_available_to_bot: false,
            real_trade_claims_disabled_until_tx_hash: true,
            transaction_builder_present: true,
            transaction_builder_preflighted: opportunities.some((item) => item.dex_preflight),
            execution_signer_adapter_present: opportunities.some((item) => item.execution_gate === 'eligible'),
            atomic_multileg_builder_present: flashExecutorDiagnostic?.bnb?.ready_for_flash_transaction_test === true || flashExecutorDiagnostic?.ethereum?.ready_for_flash_transaction_test === true,
            flash_executor_diagnostic: flashExecutorDiagnostic,
            flash_routes: flashRouteDiagnostics,
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
          .from('arbivault_strategy_bots')
          .update({ updated_at: new Date().toISOString() })
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
      worker: 'flash-loan-strategy',
      settled_broadcasts: settledBroadcasts,
      signer_invocations: signerInvocations,
      wallet_rotation_safety: walletRotationSafety,
      testnet_backend_diagnostic: testnetBackend,
      priority: 'flash_loan_strategy_execution',
      live_execution_policy: executionWindowActive ? String(policy?.mode || 'configured') : 'policy_blocked',
      actual_broadcasts: signerInvocations.filter((item: any) => item.broadcast === true).length,
      confirmed_profits: 0,
      flash_executor_diagnostic: flashExecutorDiagnostic,
      results,
    })
  },
}
