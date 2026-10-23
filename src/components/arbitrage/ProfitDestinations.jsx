import { useEffect, useMemo, useState } from 'react'
import { Copy, RefreshCw, ShieldCheck, Wallet } from 'lucide-react'
import { supabase } from '@/lib/supabase'
import { useAuth } from '@/lib/AuthContext'

const CHAINS = [
  { id: 'ethereum', label: 'Ethereum Mainnet', asset: 'ETH' },
  { id: 'bnb', label: 'BNB Smart Chain', asset: 'BNB' },
]

function short(value) {
  if (!value) return '—'
  return value.length > 24 ? value.slice(0, 12) + '…' + value.slice(-8) : value
}

function formatDate(value) {
  if (!value) return '—'
  const date = new Date(value)
  return Number.isNaN(date.getTime()) ? '—' : date.toLocaleString()
}

export default function ProfitDestinations() {
  const { user, isLoading: authLoading } = useAuth()
  const [recipients, setRecipients] = useState([])
  const [loading, setLoading] = useState(false)
  const [busyChain, setBusyChain] = useState('')
  const [error, setError] = useState('')
  const [message, setMessage] = useState('')

  const invoke = async (body) => {
    const { data, error: invokeError } = await supabase.functions.invoke('arbivault-profit-recipients', { body })
    if (invokeError) {
      let detail = invokeError.message || 'Profit destination request failed'
      try {
        const payload = await invokeError.context?.json?.()
        if (payload?.error) detail = payload.error
      } catch { /* Keep the original request error when response JSON is unavailable. */ }
      throw new Error(detail)
    }
    if (!data?.ok) throw new Error(data?.error || 'Profit destination request failed')
    return data
  }

  const load = async () => {
    if (authLoading || !user) return
    setLoading(true)
    setError('')
    try {
      const data = await invoke({ action: 'list' })
      setRecipients(data.recipients || [])
    } catch (e) {
      setError(e.message || 'Unable to load profit destinations')
    } finally {
      setLoading(false)
    }
  }

  useEffect(() => {
    if (!authLoading && user) load()
  }, [authLoading, user?.id])

  const currentByChain = useMemo(() => {
    const result = {}
    for (const chain of CHAINS) {
      const candidates = recipients
        .filter((r) => r.chain === chain.id && r.asset === 'ALL' && ['pending', 'active'].includes(r.status))
        .sort((a, b) => new Date(b.created_at || 0).getTime() - new Date(a.created_at || 0).getTime())
      result[chain.id] = candidates[0] || null
    }
    return result
  }, [recipients])

  const createDestination = async (chain) => {
    setBusyChain(chain)
    setError('')
    setMessage('')
    try {
      const data = await invoke({ action: 'create', chain, asset: 'ALL' })
      const recipient = data.recipient
      setMessage(data.existing
        ? 'A destination for this chain already exists.'
        : 'New chain-specific destination generated and secured. The 24-hour activation delay must pass before it can be activated.')
      if (recipient) setRecipients((previous) => [recipient, ...previous.filter((r) => r.id !== recipient.id)])
      await load()
    } catch (e) {
      setError(e.message || 'Unable to create profit destination')
    } finally {
      setBusyChain('')
    }
  }

  const activateDestination = async (chain, recipientId) => {
    setBusyChain(chain)
    setError('')
    setMessage('')
    try {
      await invoke({ action: 'activate', recipient_id: recipientId })
      setMessage('Destination activated in the recipient registry. Flash-loan payouts still require a deployed and verified executor configured for this address.')
      await load()
    } catch (e) {
      setError(e.message || 'Destination is not ready for activation')
    } finally {
      setBusyChain('')
    }
  }

  const copyAddress = async (address) => {
    try {
      await navigator.clipboard.writeText(address)
      setMessage('Destination address copied.')
    } catch {
      setMessage('Destination address: ' + address)
    }
  }

  return (
    <section className="rounded border border-[#232738] bg-[#0C0E16] p-4">
      <div className="flex items-start justify-between gap-3">
        <div>
          <div className="flex items-center gap-2 font-mono text-xs font-bold uppercase tracking-wider text-[#00F0FF]">
            <Wallet className="h-3.5 w-3.5" /> Chain Profit Destinations
          </div>
          <p className="mt-1 max-w-3xl font-mono text-[0.58rem] text-[#8a90b0]">
            Create a separate server-vault address for each flash-loan chain. “ALL” means the same address may receive any profit asset supported by that chain’s executor. Private keys are never shown.
          </p>
        </div>
        <button onClick={load} disabled={loading || authLoading || !user} className="text-[#5a6080] hover:text-[#00F0FF] disabled:opacity-40" title="Refresh destinations">
          <RefreshCw className="h-4 w-4" />
        </button>
      </div>

      {(error || message) && (
        <div className={`mt-3 rounded border p-2 font-mono text-[0.58rem] ${error ? 'border-[#FF4D4D]/30 bg-[#FF4D4D]/5 text-[#FF4D4D]' : 'border-[#00F0FF]/30 bg-[#00F0FF]/5 text-[#8a90b0]'}`}>
          {error || message}
        </div>
      )}

      <div className="mt-3 grid gap-3 md:grid-cols-2">
        {CHAINS.map((chain) => {
          const recipient = currentByChain[chain.id]
          const address = recipient?.wallet?.address || ''
          const canActivate = recipient?.status === 'pending' && recipient.activation_at && new Date(recipient.activation_at).getTime() <= Date.now()
          return (
            <div key={chain.id} className="rounded border border-[#232738] bg-[#090A0F] p-3">
              <div className="flex items-center justify-between gap-2">
                <span className="font-mono text-xs font-semibold uppercase">{chain.label}</span>
                {recipient?.status === 'active'
                  ? <ShieldCheck className="h-4 w-4 text-[#00F0FF]" />
                  : <Wallet className="h-4 w-4 text-[#8a90b0]" />}
              </div>
              {recipient ? (
                <>
                  <div className="mt-3 break-all font-mono text-[0.62rem] text-[#e0e4f0]">{address || 'Address unavailable'}</div>
                  <div className="mt-2 flex flex-wrap items-center justify-between gap-2 font-mono text-[0.55rem] text-[#8a90b0]">
                    <span>Status: {recipient.status}</span>
                    <span>Activation: {formatDate(recipient.activation_at)}</span>
                  </div>
                  <div className="mt-2 flex flex-wrap gap-2">
                    <button onClick={() => copyAddress(address)} disabled={!address} className="rounded border border-[#232738] px-2 py-1.5 font-mono text-[0.55rem] text-[#8a90b0] hover:border-[#00F0FF]/40 disabled:opacity-40">
                      <Copy className="mr-1 inline h-3 w-3" /> Copy address
                    </button>
                    {canActivate && (
                      <button onClick={() => activateDestination(chain.id, recipient.id)} disabled={!!busyChain} className="rounded border border-[#00F0FF]/40 bg-[#00F0FF]/5 px-2 py-1.5 font-mono text-[0.55rem] font-bold uppercase text-[#00F0FF] disabled:opacity-40">
                        {busyChain === chain.id ? 'Activating…' : 'Activate destination'}
                      </button>
                    )}
                  </div>
                </>
              ) : (
                <>
                  <div className="mt-3 font-mono text-[0.58rem] text-[#5a6080]">No profit destination registered for this chain.</div>
                  <button onClick={() => createDestination(chain.id)} disabled={!!busyChain || loading || authLoading || !user} className="mt-3 w-full rounded border border-[#00F0FF]/40 bg-[#00F0FF]/5 px-3 py-2 font-mono text-[0.6rem] font-bold uppercase tracking-wider text-[#00F0FF] disabled:opacity-40">
                    {busyChain === chain.id ? 'Generating and securing…' : `Generate ${chain.asset} destination`}
                  </button>
                </>
              )}
              {recipient?.status === 'active' && (
                <div className="mt-3 font-mono text-[0.55rem] text-[#FFB800]">
                  Registered only. This destination will receive flash-loan profits only after a verified executor is deployed/configured for this address.
                </div>
              )}
              {recipient?.status === 'pending' && !canActivate && (
                <div className="mt-3 font-mono text-[0.55rem] text-[#5a6080]">
                  Waiting for the required activation delay.
                </div>
              )}
            </div>
          )
        })}
      </div>
      <p className="mt-3 font-mono text-[0.55rem] text-[#5a6080]">
        Scope: Ethereum and BNB Smart Chain currently have flash-loan routes in ArbiVault. This does not move funds or enable signing, trading, or payout broadcasts.
      </p>
    </section>
  )
}
