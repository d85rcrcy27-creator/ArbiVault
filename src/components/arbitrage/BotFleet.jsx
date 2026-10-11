import { useEffect, useState } from 'react'
import { Activity, RefreshCw, ShieldCheck } from 'lucide-react'
import { useAuth } from '@/lib/AuthContext'
import { getAuthenticatedSession, supabase } from '@/lib/supabase'

export default function BotFleet() {
  const [strategy, setStrategy] = useState(null)
  const [routes, setRoutes] = useState([])
  const [loading, setLoading] = useState(true)
  const [saving, setSaving] = useState(false)
  const [error, setError] = useState('')
  const { user, isLoading: authLoading } = useAuth()

  const load = async () => {
    setLoading(true)
    try {
      await getAuthenticatedSession()
      const { data: authData, error: authError } = await supabase.auth.getUser()
      if (authError || !authData?.user?.id) {
        throw new Error(`Auth session missing: ${authError?.message || 'please sign in again'}`)
      }

      const { data, error: strategyError } = await supabase
        .from('arbivault_strategy_bots')
        .select('id,owner_id,name,strategy,enabled,execution_enabled,flash_loan_enabled,chains,wallet_state,updated_at')
        .eq('owner_id', authData.user.id)
        .eq('strategy', 'flash_loan_arbitrage')
        .order('created_at', { ascending: true })
        .limit(1)

      if (strategyError) throw strategyError
      const selected = data?.[0] || null
      setStrategy(selected)

      if (selected) {
        const { data: routeData, error: routeError } = await supabase
          .from('arbivault_strategy_routes')
          .select('id,chain,pair,enabled,builder_enabled,builder_status')
          .eq('strategy_bot_id', selected.id)
          .eq('route_type', 'flash_liquidity')
          .order('chain', { ascending: true })

        if (routeError) throw routeError
        setRoutes(routeData || [])
      } else {
        setRoutes([])
      }
      setError('')
    } catch (e) {
      setStrategy(null)
      setRoutes([])
      setError(e.message || 'Unable to load flash-loan strategy')
    } finally {
      setLoading(false)
    }
  }

  useEffect(() => {
    if (!authLoading) load()
  }, [authLoading, user?.id])

  const toggle = async () => {
    if (!strategy || saving) return
    const nextEnabled = !(strategy.enabled && strategy.execution_enabled)

    if (nextEnabled && strategy.flash_loan_enabled !== true) {
      setError('Flash-loan execution is not enabled for this strategy configuration.')
      return
    }

    setSaving(true)
    try {
      await getAuthenticatedSession()
      const { data: authData, error: authError } = await supabase.auth.getUser()
      if (authError || !authData?.user?.id) {
        throw new Error(`Auth session missing: ${authError?.message || 'please sign in again'}`)
      }

      const { data, error: updateError } = await supabase
        .from('arbivault_strategy_bots')
        .update({
          enabled: nextEnabled,
          execution_enabled: nextEnabled,
          updated_at: new Date().toISOString(),
        })
        .eq('id', strategy.id)
        .eq('owner_id', authData.user.id)
        .select('id,owner_id,name,strategy,enabled,execution_enabled,flash_loan_enabled,chains,wallet_state,updated_at')
        .single()

      if (updateError) throw updateError
      setStrategy(data)
      setError('')
    } catch (e) {
      setError(e.message || 'Unable to update flash-loan strategy')
    } finally {
      setSaving(false)
    }
  }

  const isEnabled = strategy?.enabled === true &&
    strategy?.execution_enabled === true &&
    strategy?.flash_loan_enabled === true
  const executorReady = routes.some(route =>
    route.enabled === true &&
    route.builder_enabled === true &&
    route.builder_status === 'ready_for_explicit_preflight'
  )

  const chainLabel = (chain) => ({
    bnb: 'BNB Smart Chain',
    ethereum: 'Ethereum',
  }[chain] || chain)

  return (
    <div className="rounded border border-[#232738] bg-[#0C0E16] p-4">
      <div className="mb-4 flex items-center justify-between">
        <div>
          <div className="flex items-center gap-2 font-mono text-xs font-bold uppercase tracking-wider text-[#00F0FF]">
            <ShieldCheck className="h-3.5 w-3.5" /> Flash-Loan Strategy
          </div>
          <p className="mt-1 text-[0.65rem] text-[#5a6080]">
            One strategy owns route selection, live quotes, transaction preflight and the signing handoff. Separate execution, sync and payment bots are retired.
          </p>
        </div>
        <button
          onClick={load}
          disabled={authLoading || loading || saving}
          aria-label="Refresh flash-loan strategy"
          className="text-[#5a6080] hover:text-[#00F0FF] disabled:opacity-50"
        >
          <RefreshCw className="h-3.5 w-3.5" />
        </button>
      </div>

      {error && (
        <div className="mb-3 rounded border border-[#FF4D4D]/30 bg-[#FF4D4D]/5 p-2 font-mono text-[0.6rem] text-[#FF4D4D]">
          {error}
        </div>
      )}

      {loading ? (
        <div className="font-mono text-[0.6rem] text-[#5a6080]">
          {authLoading ? 'Waiting for Supabase session…' : 'Loading flash-loan strategy…'}
        </div>
      ) : !strategy ? (
        <div className="rounded border border-[#232738] bg-[#090A0F] p-3 font-mono text-[0.65rem] text-[#8a90b0]">
          No flash-loan strategy is assigned to this account.
        </div>
      ) : (
        <div className="rounded border border-[#232738] bg-[#090A0F] p-3">
          <div className="flex flex-wrap items-start justify-between gap-3">
            <div>
              <div className="flex items-center gap-2 font-mono text-[0.7rem] font-semibold uppercase text-[#e0e4f0]">
                <Activity className="h-3.5 w-3.5 text-[#00F0FF]" />
                {strategy.name}
              </div>
              <p className="mt-1 font-mono text-[0.58rem] text-[#5a6080]">
                Strategy: flash_loan_arbitrage · Chains: {(strategy.chains || []).map(chainLabel).join(', ') || 'not configured'}
              </p>
            </div>
            <button
              onClick={toggle}
              disabled={saving || loading}
              className={`rounded border px-3 py-1.5 font-mono text-[0.6rem] font-semibold uppercase disabled:opacity-50 ${isEnabled ? 'border-[#FF4D4D]/40 text-[#FF8A8A]' : 'border-[#00FF87]/40 text-[#00FF87]'}`}
            >
              {saving ? 'Saving…' : isEnabled ? 'Pause Strategy' : 'Resume Strategy'}
            </button>
          </div>

          <div className="mt-3 flex items-center gap-2 border-t border-[#232738] pt-3">
            <span className={`h-2 w-2 rounded-full ${isEnabled ? 'bg-[#00FF87]' : 'bg-[#5a6080]'}`} />
            <span className={`font-mono text-[0.58rem] font-semibold uppercase ${isEnabled ? 'text-[#00FF87]' : 'text-[#8a90b0]'}`}>
              {isEnabled ? 'Strategy enabled' : 'Strategy paused'}
            </span>
            <span className="font-mono text-[0.58rem] text-[#5a6080]">
              · {executorReady ? 'Executor preflight is ready' : 'Live execution blocked until an executor is verified'}
            </span>
          </div>

          <div className="mt-3">
            <div className="mb-2 font-mono text-[0.58rem] font-semibold uppercase tracking-wider text-[#8a90b0]">
              Flash-loan route status
            </div>
            {routes.length ? (
              <div className="space-y-1.5">
                {routes.map(route => (
                  <div key={route.id} className="flex flex-wrap items-center justify-between gap-2 rounded border border-[#232738] px-2 py-1.5">
                    <span className="font-mono text-[0.58rem] text-[#c6cbe0]">
                      {chainLabel(route.chain)} · {route.pair}
                    </span>
                    <span className="font-mono text-[0.55rem] text-[#FFBD69]">
                      {route.enabled !== true
                        ? 'route disabled'
                        : route.builder_enabled !== true
                          ? route.builder_status || 'builder disabled'
                          : route.builder_status || 'executor preflight pending'}
                    </span>
                  </div>
                ))}
              </div>
            ) : (
              <div className="font-mono text-[0.58rem] text-[#5a6080]">No flash-loan routes configured.</div>
            )}
          </div>

          <p className="mt-3 border-t border-[#232738] pt-3 font-mono text-[0.58rem] leading-relaxed text-[#8a90b0]">
            No transaction is broadcast until a chain-specific executor is deployed, its bytecode and payout recipient are verified, a live quote is profitable after flash-loan premium and gas, and signing authorization passes. Quotes and backtests are not realized profits.
          </p>
        </div>
      )}
    </div>
  )
}
