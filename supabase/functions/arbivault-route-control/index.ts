import { createClient } from 'npm:@supabase/supabase-js@2.117.2'

const supabaseUrl = Deno.env.get('SUPABASE_URL')!
const anonKey = Deno.env.get('SUPABASE_ANON_KEY')!
const serviceRoleKey = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!
const admin = createClient(supabaseUrl, serviceRoleKey)

const ROUTE_FIELDS = 'id,strategy,strategy_family,strategy_bot_id,chain,pair,dex_venue,reference_venue,route_type,enabled,discovery_only,transaction_builder,builder_enabled,builder_status,updated_at'
const BOT_FIELDS = 'id,owner_id,name,strategy,enabled,execution_enabled,flash_loan_enabled,chains,max_trade_size,min_profit_threshold,slippage_tolerance,max_gas_budget,cooldown_ms,updated_at'

function corsHeaders(req: Request) {
  const origin = req.headers.get('origin') || ''
  const allowed = origin === 'https://arbivault.vercel.app' ||
    origin === 'http://localhost:5173' ||
    /^https:\/\/arbivault[^/]*\.vercel\.app$/.test(origin)
  return {
    'Access-Control-Allow-Origin': allowed ? origin : 'https://arbivault.vercel.app',
    'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
    'Access-Control-Allow-Methods': 'POST, OPTIONS',
    'Vary': 'Origin',
  }
}

function json(req: Request, value: unknown, status = 200) {
  return Response.json(value, {
    status,
    headers: { ...corsHeaders(req), 'Cache-Control': 'no-store' },
  })
}

function supportedFlashRoute(route: any) {
  return route?.route_type === 'flash_liquidity' &&
    route?.transaction_builder === 'aave_v3_atomic_flash_loan_v1' &&
    ((route.chain === 'bnb' && route.pair === 'BNB/USDT') ||
      (route.chain === 'ethereum' && route.pair === 'ETH/USDC'))
}

async function listOwnerRoutes(ownerId: string) {
  const { data: bots, error: botError } = await admin
    .from('arbivault_strategy_bots')
    .select(BOT_FIELDS)
    .eq('owner_id', ownerId)
    .in('strategy', ['flash_loan', 'flash_loan_arbitrage'])
    .order('created_at', { ascending: true })
  if (botError) throw botError

  const botIds = (bots || []).map((bot: any) => bot.id)
  if (!botIds.length) return { strategy: null, routes: [] }

  const { data: allRoutes, error: routeError } = await admin
    .from('arbivault_strategy_routes')
    .select(ROUTE_FIELDS)
    .in('strategy_bot_id', botIds)
    .eq('route_type', 'flash_liquidity')
    .order('chain', { ascending: true })
  if (routeError) throw routeError

  const routes = (allRoutes || []).filter(supportedFlashRoute)
  const strategy = (bots || []).find((bot: any) =>
    routes.some((route: any) => route.strategy_bot_id === bot.id)
  ) || (bots || [])[0] || null

  return {
    strategy,
    routes: strategy ? routes.filter((route: any) => route.strategy_bot_id === strategy.id) : [],
  }
}

Deno.serve(async (req: Request) => {
  if (req.method === 'OPTIONS') return new Response('ok', { status: 200, headers: corsHeaders(req) })
  if (req.method !== 'POST') return json(req, { ok: false, error: 'method_not_allowed' }, 405)

  try {
    const authorization = req.headers.get('Authorization') || ''
    if (!authorization.startsWith('Bearer ')) {
      return json(req, { ok: false, error: 'authentication_required' }, 401)
    }

    const userClient = createClient(supabaseUrl, anonKey, {
      global: { headers: { Authorization: authorization } },
    })
    const { data: authData, error: authError } = await userClient.auth.getUser()
    const user = authData?.user
    if (authError || !user) return json(req, { ok: false, error: 'authentication_required' }, 401)

    const body = await req.json().catch(() => ({}))
    const action = String(body?.action || 'list')

    if (action === 'list') {
      const result = await listOwnerRoutes(user.id)
      return json(req, { ok: true, ...result })
    }

    if (!['arm', 'pause'].includes(action)) {
      return json(req, { ok: false, error: 'unsupported_action' }, 400)
    }

    const routeId = String(body?.route_id || '')
    if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(routeId)) {
      return json(req, { ok: false, error: 'valid_route_id_required' }, 400)
    }

    const { data: route, error: routeError } = await admin
      .from('arbivault_strategy_routes')
      .select(ROUTE_FIELDS)
      .eq('id', routeId)
      .maybeSingle()
    if (routeError) throw routeError
    if (!route || !supportedFlashRoute(route)) {
      return json(req, { ok: false, error: 'supported_flash_route_not_found' }, 404)
    }

    const { data: strategy, error: strategyError } = await admin
      .from('arbivault_strategy_bots')
      .select(BOT_FIELDS)
      .eq('id', route.strategy_bot_id)
      .eq('owner_id', user.id)
      .maybeSingle()
    if (strategyError) throw strategyError
    if (!strategy || !['flash_loan', 'flash_loan_arbitrage'].includes(strategy.strategy)) {
      return json(req, { ok: false, error: 'route_not_owned_by_authenticated_user' }, 404)
    }

    const timestamp = new Date().toISOString()

    // Pause the worker before changing route flags. If a later update fails,
    // the strategy stays paused rather than running a partially selected route.
    const { error: pauseError } = await admin
      .from('arbivault_strategy_bots')
      .update({ enabled: false, execution_enabled: false, updated_at: timestamp })
      .eq('id', strategy.id)
      .eq('owner_id', user.id)
    if (pauseError) throw new Error('could_not_pause_strategy_before_route_change')

    if (action === 'pause') {
      const { error: disarmError } = await admin
        .from('arbivault_strategy_routes')
        .update({ enabled: false, discovery_only: true, updated_at: timestamp })
        .eq('strategy_bot_id', strategy.id)
        .eq('route_type', 'flash_liquidity')
      if (disarmError) throw new Error('could_not_disarm_flash_routes')

      const { data: pausedStrategy, error: finalPauseError } = await admin
        .from('arbivault_strategy_bots')
        .select(BOT_FIELDS)
        .eq('id', strategy.id)
        .single()
      if (finalPauseError) throw finalPauseError

      const result = await listOwnerRoutes(user.id)
      return json(req, {
        ok: true,
        action,
        strategy: result.strategy?.id === strategy.id ? result.strategy : pausedStrategy,
        routes: result.routes,
        live_execution: false,
        message: 'Strategy paused and flash-loan routes disarmed. Existing broadcast transactions may still confirm on-chain.',
      })
    }

    // Arming is a route selection, not a claim that the executor is live. Only
    // one flash route remains active for this strategy; the worker still verifies
    // executor bytecode/payout, a profitable live quote, gas, signer binding and
    // signing authorization before any broadcast.
    const { error: disarmOthersError } = await admin
      .from('arbivault_strategy_routes')
      .update({ enabled: false, discovery_only: true, updated_at: timestamp })
      .eq('strategy_bot_id', strategy.id)
      .eq('route_type', 'flash_liquidity')
    if (disarmOthersError) throw new Error('could_not_disarm_other_flash_routes')

    const { error: armRouteError } = await admin
      .from('arbivault_strategy_routes')
      .update({
        enabled: true,
        discovery_only: false,
        builder_enabled: true,
        updated_at: timestamp,
      })
      .eq('id', route.id)
      .eq('strategy_bot_id', strategy.id)
    if (armRouteError) throw new Error('could_not_arm_selected_route')

    const { error: enableStrategyError } = await admin
      .from('arbivault_strategy_bots')
      .update({
        enabled: true,
        execution_enabled: true,
        flash_loan_enabled: true,
        updated_at: new Date().toISOString(),
      })
      .eq('id', strategy.id)
      .eq('owner_id', user.id)
    if (enableStrategyError) throw new Error('route_armed_but_strategy_activation_failed; strategy_is_paused')

    const result = await listOwnerRoutes(user.id)
    return json(req, {
      ok: true,
      action,
      strategy: result.strategy,
      routes: result.routes,
      selected_route_id: route.id,
      live_execution: false,
      message: 'Route armed. The worker will run its live quote and preflight loop. This is not a live trade: the UI reports a live execution only after a real transaction hash is recorded.',
    })
  } catch (error) {
    const message = error instanceof Error ? error.message : 'route_control_failed'
    return json(req, { ok: false, error: message }, 500)
  }
})
