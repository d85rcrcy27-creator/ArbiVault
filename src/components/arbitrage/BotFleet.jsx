import { useCallback, useEffect, useMemo, useState } from 'react'
import { Activity, ExternalLink, RefreshCw, ShieldCheck } from 'lucide-react'
import { useAuth } from '@/lib/AuthContext'
import { getAuthenticatedSession, supabase } from '@/lib/supabase'

const BLOCKER_COPY = {
  flash_executor_not_configured: 'BNB executor is not deployed or registered',
  ethereum_flash_executor_not_configured: 'Ethereum executor is not deployed or registered',
  flash_executor_bytecode_missing: 'Executor bytecode is not verified on-chain',
  flash_executor_payout_recipient_unreadable: 'Executor payout recipient could not be read',
  flash_executor_payout_wallet_not_generated_hot_wallet: 'Executor payout wallet does not match the authorized trading wallet',
  flash_executor_source_unverified: 'Executor source verification is incomplete',
  flash_executor_builder_not_configured: 'Atomic transaction builder is not configured',
  ethereum_flash_builder_not_configured: 'Ethereum atomic builder is not configured',
  flash_executor_payout_not_end_to_end_verified: 'Executor payout path has not passed end-to-end verification',
  flash_executor_preflight_not_ready: 'Executor preflight has not passed',
  ready_for_explicit_preflight: 'Executor checks passed; live quote, profit, gas and signer checks still run',
  flash_executor_not_ready: 'Executor is not ready for a transaction',
  flash_no_profitable_live_opportunity: 'The latest live quote did not meet the net-profit requirement',
  flash_atomic_transaction_not_built: 'The atomic transaction could not be built',
  flash_source_wallet_unavailable: 'No eligible source wallet is assigned',
  execution_signer_adapter_missing: 'The matching automatic signing adapter is unavailable',
  internal_signer_unavailable: 'No healthy internal signer is available',
  wallet_contract_code_check_unavailable: 'Wallet contract/signer safety check is unavailable',
  strategy_route_discovery_only: 'Route is still marked discovery-only',
  transaction_builder_not_configured: 'Transaction builder is disabled or missing',
  execution_policy_not_active: 'Global execution policy is not active',
  duplicate_active_transaction_payload: 'The same transaction payload is already active',
}

function blockerLabel(value) {
  if (!value) return 'Readiness has not been checked yet'
  if (BLOCKER_COPY[value]) return BLOCKER_COPY[value]
  return String(value).replace(/_/g, ' ')
}

function chainLabel(chain) {
  return ({ bnb: 'BNB Smart Chain', ethereum: 'Ethereum' })[chain] || String(chain || 'Unknown chain')
}

function isRouteArmed(route, strategy) {
  return Boolean(
    strategy?.enabled === true &&
    strategy?.execution_enabled === true &&
    strategy?.flash_loan_enabled === true &&
    route?.enabled === true &&
    route?.discovery_only !== true &&
    route?.builder_enabled === true,
  )
}

function executionState(route, strategy, attempt, opportunity) {
  if (attempt?.tx_hash && attempt.status === 'broadcast') {
    return {
      label: 'TX BROADCAST · AWAITING CONFIRMATION',
      tone: 'green',
      detail: 'A real transaction hash is recorded. The chain confirmation check is still pending.',
    }
  }
  if (attempt?.tx_hash && attempt.status === 'confirmed') {
    return {
      label: 'LAST TX CONFIRMED ON-CHAIN',
      tone: 'green',
      detail: 'The latest recorded route transaction has a hash and a confirmed status.',
    }
  }
  if (attempt?.tx_hash) {
    return {
      label: `TX HASH RECORDED · ${String(attempt.status || 'status pending').toUpperCase()}`,
      tone: 'amber',
      detail: 'Open the transaction explorer to verify its current chain status.',
    }
  }
  if (attempt?.status === 'failed') {
    return {
      label: 'LAST ATTEMPT FAILED · NO TX HASH',
      tone: 'red',
      detail: attempt.failure_reason || 'The recorded attempt has no broadcast transaction hash.',
    }
  }
  if (attempt?.status === 'validated' || attempt?.status === 'signed') {
    return {
      label: `${String(attempt.status).toUpperCase()} · NOT BROADCAST`,
      tone: 'amber',
      detail: 'A prepared execution is not a live trade until a transaction hash is recorded.',
    }
  }
  if (opportunity?.broadcast === 'awaiting_authorized_signing' || opportunity?.signing === 'pending_human_authorization') {
    return {
      label: 'AWAITING SIGNING AUTHORIZATION · NOT LIVE',
      tone: 'amber',
      detail: 'The worker prepared the route, but no transaction has been broadcast.',
    }
  }
  if (opportunity?.execution_gate && opportunity.execution_gate !== 'eligible') {
    return {
      label: 'BLOCKED BEFORE BROADCAST',
      tone: 'red',
      detail: blockerLabel(opportunity.execution_gate),
    }
  }
  if (!isRouteArmed(route, strategy)) {
    return {
      label: route?.discovery_only === true ? 'DISCOVERY ONLY · NOT ARMED' : 'PAUSED · NOT ARMED',
      tone: 'muted',
      detail: 'Select this route and arm it to hand it to the flash-loan worker.',
    }
  }
  if (route?.builder_status && route.builder_status !== 'ready_for_explicit_preflight') {
    return {
      label: 'ARMED · BLOCKED BEFORE BROADCAST',
      tone: 'amber',
      detail: blockerLabel(route.builder_status),
    }
  }
  return {
    label: 'ARMED · WAITING FOR A QUALIFYING LIVE QUOTE',
    tone: 'amber',
    detail: 'The worker is configured to check the route. This does not mean a transaction has been sent.',
  }
}

function statusTone(tone) {
  if (tone === 'green') return 'text-[#00FF87]'
  if (tone === 'red') return 'text-[#FF6B6B]'
  if (tone === 'amber') return 'text-[#FFBD69]'
  return 'text-[#8a90b0]'
}

function explorerUrl(chain, txHash) {
  if (!txHash) return null
  if (chain === 'bnb') return `https://bscscan.com/tx/${txHash}`
  if (chain === 'ethereum') return `https://etherscan.io/tx/${txHash}`
  return null
}

export default function BotFleet() {
  const [strategy, setStrategy] = useState(null)
  const [routes, setRoutes] = useState([])
  const [selectedRouteId, setSelectedRouteId] = useState(null)
  const [latestAttempts, setLatestAttempts] = useState({})
  const [latestWorkerRun, setLatestWorkerRun] = useState(null)
  const [loading, setLoading] = useState(true)
  const [acting, setActing] = useState(false)
  const [actionRouteId, setActionRouteId] = useState(null)
  const [error, setError] = useState('')
  const [activityError, setActivityError] = useState('')
  const [notice, setNotice] = useState('')
  const { user, isLoading: authLoading } = useAuth()

  const load = useCallback(async ({ quiet = false } = {}) => {
    if (!quiet) setLoading(true)
    try {
      await getAuthenticatedSession()
      const { data: authData, error: authError } = await supabase.auth.getUser()
      if (authError || !authData?.user?.id) {
        throw new Error(`Auth session missing: ${authError?.message || 'please sign in again'}`)
      }

      const { data: routeResponse, error: routeError } = await supabase.functions.invoke('arbivault-route-control', {
        body: { action: 'list' },
      })
      if (routeError) throw routeError
      if (!routeResponse?.ok) throw new Error(routeResponse?.error || 'Unable to load route configuration')

      const selectedStrategy = routeResponse.strategy || null
      const configuredRoutes = Array.isArray(routeResponse.routes) ? routeResponse.routes : []
      setStrategy(selectedStrategy)
      setRoutes(configuredRoutes)
      setSelectedRouteId((current) =>
        configuredRoutes.some((route) => route.id === current)
          ? current
          : (configuredRoutes.find((route) => isRouteArmed(route, selectedStrategy)) || configuredRoutes[0])?.id || null
      )

      const routeIds = configuredRoutes.map((route) => route.id)
      if (routeIds.length) {
        const { data: attempts, error: attemptsError } = await supabase
          .from('execution_attempts')
          .select('id,execution_route_id,status,tx_hash,failure_reason,created_at,validated_at,signed_at,broadcast_at,confirmed_at,net_profit')
          .eq('owner_id', authData.user.id)
          .eq('execution_mode', 'on_chain')
          .in('execution_route_id', routeIds)
          .order('created_at', { ascending: false })
          .limit(100)

        if (attemptsError) {
          setActivityError('Live transaction status could not be read: ' + attemptsError.message)
          setLatestAttempts({})
        } else {
          const byRoute = {}
          for (const attempt of attempts || []) {
            if (attempt.execution_route_id && !byRoute[attempt.execution_route_id]) {
              byRoute[attempt.execution_route_id] = attempt
            }
          }
          setLatestAttempts(byRoute)
          setActivityError('')
        }
      } else {
        setLatestAttempts({})
        setActivityError('')
      }

      const { data: runs, error: runError } = await supabase
        .from('bot_execution_runs')
        .select('id,started_at,completed_at,status,output,error')
        .eq('owner_id', authData.user.id)
        .eq('workflow', 'execution')
        .order('started_at', { ascending: false })
        .limit(1)
      if (runError) {
        setActivityError((current) => current || ('Worker heartbeat could not be read: ' + runError.message))
        setLatestWorkerRun(null)
      } else {
        setLatestWorkerRun(runs?.[0] || null)
      }

      setError('')
    } catch (e) {
      if (!quiet) {
        setStrategy(null)
        setRoutes([])
      }
      setError(e.message || 'Unable to load flash-loan route status')
    } finally {
      if (!quiet) setLoading(false)
    }
  }, [])

  useEffect(() => {
    if (!authLoading) load()
  }, [authLoading, user?.id, load])

  useEffect(() => {
    if (authLoading || !user?.id) return undefined
    const timer = window.setInterval(() => load({ quiet: true }), 10000)
    return () => window.clearInterval(timer)
  }, [authLoading, user?.id, load])

  const selectedRoute = useMemo(
    () => routes.find((route) => route.id === selectedRouteId) || null,
    [routes, selectedRouteId],
  )

  const workerOpportunity = useMemo(() => {
    if (!latestWorkerRun?.output || !selectedRoute) return null
    const results = Array.isArray(latestWorkerRun.output.results) ? latestWorkerRun.output.results : []
    for (const result of results) {
      const opportunities = Array.isArray(result?.opportunities) ? result.opportunities : []
      const found = opportunities.find((item) => item?.execution_route_id === selectedRoute.id)
      if (found) return found
    }
    return null
  }, [latestWorkerRun, selectedRoute])

  const selectedAttempt = selectedRoute ? latestAttempts[selectedRoute.id] : null
  const strategyActive = strategy?.enabled === true &&
    strategy?.execution_enabled === true &&
    strategy?.flash_loan_enabled === true
  const selectedRouteArmed = selectedRoute ? isRouteArmed(selectedRoute, strategy) : false
  const liveState = selectedRoute
    ? executionState(selectedRoute, strategy, selectedAttempt, workerOpportunity)
    : null

  const controlSelectedRoute = async () => {
    if (!selectedRoute || acting) return
    const action = selectedRouteArmed ? 'pause' : 'arm'
    setActing(true)
    setActionRouteId(selectedRoute.id)
    setError('')
    setNotice('')
    try {
      const { data, error: invokeError } = await supabase.functions.invoke('arbivault-route-control', {
        body: { action, route_id: selectedRoute.id },
      })
      if (invokeError) throw invokeError
      if (!data?.ok) throw new Error(data?.error || 'Route control action failed')
      setStrategy(data.strategy || null)
      setRoutes(Array.isArray(data.routes) ? data.routes : [])
      setSelectedRouteId(selectedRoute.id)
      setNotice(data.message || (action === 'arm' ? 'Route armed.' : 'Route paused.'))
      await load({ quiet: true })
    } catch (e) {
      setError(e.message || 'Unable to update the selected route')
    } finally {
      setActing(false)
      setActionRouteId(null)
    }
  }

  const readyForPreflight = selectedRoute?.builder_status === 'ready_for_explicit_preflight'
  const chainSummary = (strategy?.chains || []).map(chainLabel).join(', ') || 'not configured'
  const workerTime = latestWorkerRun?.started_at
    ? new Date(latestWorkerRun.started_at).toLocaleString()
    : 'No worker run recorded'

  return (
    <section className="rounded border border-[#232738] bg-[#0C0E16] p-4">
      <div className="mb-4 flex items-start justify-between gap-3">
        <div>
          <div className="flex items-center gap-2 font-mono text-xs font-bold uppercase tracking-wider text-[#00F0FF]">
            <ShieldCheck className="h-3.5 w-3.5" /> Flash-Loan Route Control
          </div>
          <p className="mt-1 max-w-3xl text-[0.65rem] text-[#8a90b0]">
            Choose one route; the worker owns quote collection, atomic transaction preflight and the signing handoff.
            A live trade is only reported after a real transaction hash is recorded.
          </p>
        </div>
        <button
          onClick={() => load()}
          disabled={authLoading || loading || acting}
          aria-label="Refresh flash-loan route status"
          className="text-[#5a6080] hover:text-[#00F0FF] disabled:opacity-50"
        >
          <RefreshCw className={`h-3.5 w-3.5 ${loading ? 'animate-spin' : ''}`} />
        </button>
      </div>

      {error && (
        <div role="alert" className="mb-3 rounded border border-[#FF4D4D]/30 bg-[#FF4D4D]/5 p-2 font-mono text-[0.62rem] text-[#FF8A8A]">
          {error}
        </div>
      )}
      {notice && (
        <div role="status" className="mb-3 rounded border border-[#00F0FF]/20 bg-[#00F0FF]/5 p-2 font-mono text-[0.62rem] text-[#c6cbe0]">
          {notice}
        </div>
      )}

      {loading ? (
        <div className="font-mono text-[0.65rem] text-[#5a6080]">Loading route configuration and execution history…</div>
      ) : !strategy ? (
        <div className="rounded border border-[#232738] bg-[#090A0F] p-3 font-mono text-[0.65rem] text-[#8a90b0]">
          No flash-loan strategy is assigned to this account.
        </div>
      ) : (
        <>
          <div className="mb-3 flex flex-wrap items-center justify-between gap-3 rounded border border-[#232738] bg-[#090A0F] p-3">
            <div>
              <div className="flex items-center gap-2 font-mono text-[0.7rem] font-semibold uppercase text-[#e0e4f0]">
                <Activity className="h-3.5 w-3.5 text-[#00F0FF]" /> {strategy.name}
              </div>
              <p className="mt-1 font-mono text-[0.58rem] text-[#5a6080]">
                Strategy: {strategy.strategy} · Chains: {chainSummary}
              </p>
            </div>
            <div className={`font-mono text-[0.6rem] font-semibold uppercase ${strategyActive ? 'text-[#00FF87]' : 'text-[#FFBD69]'}`}>
              {strategyActive ? 'Worker enabled' : 'Worker paused'}
            </div>
          </div>

          <div className="mb-3">
            <div className="mb-2 font-mono text-[0.58rem] font-semibold uppercase tracking-wider text-[#8a90b0]">
              Select the route the worker should use
            </div>
            {routes.length ? (
              <div className="grid gap-2 md:grid-cols-2">
                {routes.map((route) => {
                  const active = route.id === selectedRouteId
                  const armed = isRouteArmed(route, strategy)
                  const attempt = latestAttempts[route.id]
                  const state = executionState(route, strategy, attempt, null)
                  return (
                    <button
                      key={route.id}
                      type="button"
                      onClick={() => setSelectedRouteId(route.id)}
                      className={`rounded border p-3 text-left transition-colors ${active ? 'border-[#00F0FF]/60 bg-[#00F0FF]/5' : 'border-[#232738] bg-[#090A0F] hover:border-[#3b4562]'}`}
                    >
                      <div className="flex items-start justify-between gap-2">
                        <div>
                          <div className="font-mono text-xs font-semibold text-[#e0e4f0]">{chainLabel(route.chain)}</div>
                          <div className="mt-1 font-mono text-sm text-[#00F0FF]">{route.pair}</div>
                        </div>
                        <span className={`rounded border px-1.5 py-0.5 font-mono text-[0.52rem] uppercase ${armed ? 'border-[#00FF87]/30 text-[#00FF87]' : 'border-[#30364b] text-[#8a90b0]'}`}>
                          {armed ? 'Armed' : route.discovery_only ? 'Discovery' : 'Paused'}
                        </span>
                      </div>
                      <div className="mt-2 font-mono text-[0.55rem] text-[#5a6080]">
                        Builder: {route.transaction_builder || 'not configured'} · {route.builder_enabled ? 'enabled' : 'disabled'}
                      </div>
                      <div className={`mt-2 font-mono text-[0.58rem] font-semibold ${statusTone(state.tone)}`}>
                        {state.label}
                      </div>
                    </button>
                  )
                })}
              </div>
            ) : (
              <div className="rounded border border-[#232738] bg-[#090A0F] p-3 font-mono text-[0.63rem] text-[#8a90b0]">
                No supported BNB or Ethereum flash-liquidity routes are configured for this strategy.
              </div>
            )}
          </div>

          {selectedRoute && liveState && (
            <div className="rounded border border-[#232738] bg-[#090A0F] p-3">
              <div className="flex flex-wrap items-start justify-between gap-3">
                <div>
                  <div className="font-mono text-[0.58rem] uppercase tracking-wider text-[#5a6080]">Selected route · live execution state</div>
                  <div className="mt-1 font-mono text-sm font-semibold text-[#e0e4f0]">{chainLabel(selectedRoute.chain)} · {selectedRoute.pair}</div>
                  <div className={`mt-2 font-mono text-[0.65rem] font-semibold uppercase ${statusTone(liveState.tone)}`}>{liveState.label}</div>
                  <p className="mt-1 max-w-3xl text-[0.63rem] leading-relaxed text-[#8a90b0]">{liveState.detail}</p>
                </div>
                {selectedAttempt?.tx_hash && (
                  <a
                    href={explorerUrl(selectedRoute.chain, selectedAttempt.tx_hash) || '#'}
                    target="_blank"
                    rel="noreferrer"
                    className="inline-flex items-center gap-1 font-mono text-[0.58rem] text-[#00F0FF] hover:underline"
                  >
                    {selectedAttempt.tx_hash.slice(0, 12)}… <ExternalLink className="h-3 w-3" />
                  </a>
                )}
              </div>

              <div className="mt-3 grid gap-2 sm:grid-cols-3">
                <div className="rounded border border-[#232738] px-2.5 py-2">
                  <div className="font-mono text-[0.52rem] uppercase text-[#5a6080]">Executor readiness</div>
                  <div className={`mt-1 font-mono text-[0.58rem] ${readyForPreflight ? 'text-[#00FF87]' : 'text-[#FFBD69]'}`}>
                    {blockerLabel(selectedRoute.builder_status)}
                  </div>
                </div>
                <div className="rounded border border-[#232738] px-2.5 py-2">
                  <div className="font-mono text-[0.52rem] uppercase text-[#5a6080]">Last worker check</div>
                  <div className="mt-1 font-mono text-[0.58rem] text-[#c6cbe0]">{workerTime}</div>
                </div>
                <div className="rounded border border-[#232738] px-2.5 py-2">
                  <div className="font-mono text-[0.52rem] uppercase text-[#5a6080]">Latest attempt</div>
                  <div className="mt-1 font-mono text-[0.58rem] text-[#c6cbe0]">
                    {selectedAttempt?.created_at
                      ? `${String(selectedAttempt.status || 'unknown').toUpperCase()} · ${new Date(selectedAttempt.created_at).toLocaleString()}`
                      : 'No attempt recorded'}
                  </div>
                </div>
              </div>

              {activityError && <p className="mt-2 text-[0.58rem] text-[#FFBD69]">{activityError}</p>}

              <div className="mt-3 flex flex-wrap items-center gap-2 border-t border-[#232738] pt-3">
                <button
                  type="button"
                  onClick={controlSelectedRoute}
                  disabled={acting || !selectedRoute}
                  className={`rounded border px-3 py-2 font-mono text-[0.6rem] font-semibold uppercase disabled:opacity-50 ${selectedRouteArmed ? 'border-[#FF4D4D]/40 text-[#FF8A8A] hover:bg-[#FF4D4D]/5' : 'border-[#00FF87]/40 text-[#00FF87] hover:bg-[#00FF87]/5'}`}
                >
                  {acting
                    ? 'Updating route…'
                    : actionRouteId === selectedRoute.id
                      ? 'Updating route…'
                      : selectedRouteArmed
                        ? 'Pause selected route'
                        : 'Arm selected route'}
                </button>
                <span className="font-mono text-[0.55rem] leading-relaxed text-[#5a6080]">
                  Arming selects only this flash route and enables its worker. It does not bypass executor, profitability, gas, wallet-binding or signing checks.
                </span>
              </div>
            </div>
          )}
        </>
      )}

      <div className="mt-3 border-t border-[#232738] pt-3 font-mono text-[0.58rem] leading-relaxed text-[#8a90b0]">
        A quote, armed route, prepared payload, or backtest is not a live trade. Look for a transaction hash marked broadcast or confirmed to verify an on-chain execution.
      </div>
    </section>
  )
}
