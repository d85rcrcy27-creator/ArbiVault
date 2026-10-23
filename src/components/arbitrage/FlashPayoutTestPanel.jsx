import { useCallback, useEffect, useState } from 'react'
import { RefreshCw, ShieldAlert, ShieldCheck } from 'lucide-react'
import { supabase } from '@/lib/supabase'

const CHAINS = [
  { id: 'bnb', label: 'BNB Smart Chain', asset: 'BNB' },
  { id: 'ethereum', label: 'Ethereum Mainnet', asset: 'ETH' },
]

function humanize(value) {
  return String(value || 'unknown')
    .replaceAll('_', ' ')
    .replaceAll(';', ' · ')
}

async function invokePayoutTest(body) {
  const { data, error } = await supabase.functions.invoke('arbivault-flash-payout-test', { body })
  if (error) {
    let message = error.message || 'Payout-test request failed'
    try {
      const detail = await error.context?.json?.()
      if (detail?.error) message = detail.error
      if (Array.isArray(detail?.blockers) && detail.blockers.length) {
        message += ': ' + detail.blockers.map(humanize).join(', ')
      }
    } catch {
      // Preserve the request error when the response is not JSON.
    }
    throw new Error(message)
  }
  if (!data?.ok) {
    const blockers = Array.isArray(data?.blockers) ? data.blockers.map(humanize).join(', ') : ''
    throw new Error([data?.error || 'Payout-test request failed', blockers].filter(Boolean).join(': '))
  }
  return data
}

export default function FlashPayoutTestPanel() {
  const [statusByChain, setStatusByChain] = useState({})
  const [loading, setLoading] = useState(false)
  const [busyChain, setBusyChain] = useState('')
  const [error, setError] = useState('')
  const [message, setMessage] = useState('')

  const refresh = useCallback(async () => {
    setLoading(true)
    setError('')
    try {
      const { data: { user }, error: authError } = await supabase.auth.getUser()
      if (authError) throw authError
      if (!user) throw new Error('Sign in again to inspect flash-execution readiness.')
      const results = await Promise.all(CHAINS.map(async (chain) => {
        try {
          const result = await invokePayoutTest({ action: 'status', chain: chain.id })
          return [chain.id, result]
        } catch (err) {
          return [chain.id, { ok: false, error: err instanceof Error ? err.message : 'Status unavailable' }]
        }
      }))
      setStatusByChain(Object.fromEntries(results))
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Could not load flash-execution readiness.')
    } finally {
      setLoading(false)
    }
  }, [])

  useEffect(() => { refresh() }, [refresh])

  const authorize = async (chain) => {
    const confirmed = window.confirm(
      'Authorize one capped atomic flash-loan payout test on ' + chain.toUpperCase() + '?\n\n' +
      'Notional is capped at $25 and estimated network fees at the configured $5 budget. ' +
      'A favorable live quote must still appear, and a separate passkey/biometric approval is required before signing. ' +
      'Failed or ambiguous test attempts are consumed and require reconciliation. This does not enable normal live trading.'
    )
    if (!confirmed) return
    setBusyChain(chain)
    setError('')
    setMessage('')
    try {
      const result = await invokePayoutTest({
        action: 'authorize',
        chain,
        confirmation: 'AUTHORIZE_ONE_FLASH_PAYOUT_TEST',
      })
      setMessage(result.next_step || 'One-time payout-test authorization saved.')
      await refresh()
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Could not authorize payout test.')
      await refresh()
    } finally {
      setBusyChain('')
    }
  }

  return (
    <section className="overflow-hidden rounded border border-[#30364b] bg-[#0C0E16]">
      <div className="flex flex-col gap-3 border-b border-[#232738] px-4 py-3 sm:flex-row sm:items-center sm:justify-between">
        <div>
          <h2 className="font-mono text-xs font-semibold uppercase tracking-wider">Atomic flash execution readiness</h2>
          <p className="mt-2 max-w-3xl text-xs leading-5 text-[#8a90b0]">
            Quote discovery, payout-test readiness and live-trading readiness are separate states. The one-time test path does not enable autonomous trading.
          </p>
        </div>
        <button onClick={refresh} disabled={loading || !!busyChain} className="inline-flex shrink-0 items-center justify-center gap-2 rounded border border-[#30364b] px-3 py-2 font-mono text-[10px] hover:border-[#00F0FF] disabled:opacity-50">
          <RefreshCw size={13} className={loading ? 'animate-spin' : ''} /> CHECK READINESS
        </button>
      </div>
      {error && <div role="alert" className="border-b border-red-500/30 px-4 py-3 text-xs text-red-200">{error}</div>}
      {message && <div role="status" className="border-b border-[#00F0FF]/20 px-4 py-3 text-xs leading-5 text-[#a8d8df]">{message}</div>}
      <div className="grid gap-px bg-[#232738] md:grid-cols-2">
        {CHAINS.map((chain) => {
          const status = statusByChain[chain.id]
          const blockers = Array.isArray(status?.blockers) ? status.blockers : []
          const authorized = status?.payout_test_authorized === true
          const canAuthorize = status?.can_authorize === true && !authorized
          const ready = blockers.length === 0 && status?.ok === true
          return (
            <div key={chain.id} className="bg-[#0C0E16] p-4">
              <div className="flex items-start justify-between gap-3">
                <div>
                  <p className="font-mono text-xs font-semibold">{chain.label}</p>
                  <p className="mt-1 text-[10px] text-[#5a6080]">Chain: {chain.id} · Profit asset: {chain.asset} / stablecoin</p>
                </div>
                {ready
                  ? <ShieldCheck size={17} className="shrink-0 text-[#00FF87]" />
                  : <ShieldAlert size={17} className="shrink-0 text-[#FFB800]" />}
              </div>
              <p className={'mt-3 text-xs ' + (authorized ? 'text-[#00F0FF]' : ready ? 'text-[#00FF87]' : 'text-[#FFB800]')}>
                {authorized
                  ? 'One-time authorization recorded; waiting for a profitable quote and manual passkey approval.'
                  : status?.status === 'payout_test_already_claimed_requires_reconciliation'
                    ? 'A prior test was claimed and needs reconciliation.'
                    : ready
                      ? 'Preflight passed; one-time payout test can be authorized.'
                      : status?.error
                        ? humanize(status.error)
                        : 'Blocked by readiness checks.'}
              </p>
              {blockers.length > 0 && (
                <div className="mt-3 space-y-1">
                  {blockers.map((blocker) => <p key={blocker} className="text-[10px] leading-4 text-[#a5aaca]">• {humanize(blocker)}</p>)}
                </div>
              )}
              {status?.executor?.address && <p className="mt-3 break-all font-mono text-[10px] text-[#5a6080]">Executor: {status.executor.address}</p>}
              {status?.wallet_address && <p className="mt-1 break-all font-mono text-[10px] text-[#5a6080]">Payout wallet: {status.wallet_address}</p>}
              <button
                onClick={() => authorize(chain.id)}
                disabled={!canAuthorize || loading || !!busyChain}
                className="mt-4 w-full rounded border border-[#3a4055] px-3 py-2 font-mono text-[10px] uppercase tracking-wider hover:border-[#00F0FF] disabled:cursor-not-allowed disabled:opacity-40"
              >
                {busyChain === chain.id ? 'SAVING AUTHORIZATION…' : authorized ? 'TEST ALREADY AUTHORIZED' : 'AUTHORIZE ONE-TIME PAYOUT TEST'}
              </button>
              <p className="mt-2 text-[10px] leading-4 text-[#5a6080]">Capped at $25 notional and the configured network-fee budget. A test still requires a profitable quote and separate biometric/passkey signing.</p>
            </div>
          )
        })}
      </div>
    </section>
  )
}
