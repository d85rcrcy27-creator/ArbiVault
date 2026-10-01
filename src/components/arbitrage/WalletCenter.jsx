import { useEffect, useState } from 'react'
import { Check, Clock, Copy, Plus, RefreshCw, ShieldCheck, Wallet } from 'lucide-react'
import { CHAIN_LIST } from '@/lib/strategies'
import { addApprovedWallet, activateApprovedWallet, listApprovedWallets, listWallets } from '@/lib/arbivault'

const formatDate = (value) => value ? new Date(value).toLocaleString() : '—'

export default function WalletCenter() {
  const [wallets, setWallets] = useState([])
  const [approved, setApproved] = useState([])
  const [chain, setChain] = useState('solana')
  const [address, setAddress] = useState('')
  const [label, setLabel] = useState('')
  const [loading, setLoading] = useState(true)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')

  const load = async () => {
    setLoading(true)
    try {
      const [w, a] = await Promise.all([listWallets(), listApprovedWallets()])
      setWallets(w)
      setApproved(a)
      setError('')
    } catch (e) {
      setError(e.message || 'Unable to load wallet data')
    } finally {
      setLoading(false)
    }
  }

  useEffect(() => { load() }, [])

  const addDestination = async (event) => {
    event.preventDefault()
    setBusy(true)
    setError('')
    try {
      await addApprovedWallet({ chain, address: address.trim(), label: label.trim() })
      setAddress('')
      setLabel('')
      await load()
    } catch (e) {
      setError(e.message || 'Unable to add destination')
    } finally {
      setBusy(false)
    }
  }

  const activate = async (id) => {
    setBusy(true)
    setError('')
    try {
      await activateApprovedWallet(id, true)
      await load()
    } catch (e) {
      setError(e.message || 'Destination is not yet eligible for activation')
    } finally {
      setBusy(false)
    }
  }

  return (
    <div className="rounded border border-[#232738] bg-[#0C0E16] p-4">
      <div className="mb-4 flex items-center justify-between">
        <div>
          <div className="flex items-center gap-2 font-mono text-xs font-bold uppercase tracking-wider text-[#00F0FF]">
            <Wallet className="h-3.5 w-3.5" /> Wallet Center
          </div>
          <p className="mt-1 text-[0.65rem] text-[#5a6080]">Hot-wallet inventory and controlled payout destinations</p>
        </div>
        <button onClick={load} className="text-[#5a6080] hover:text-[#00F0FF]" title="Refresh">
          <RefreshCw className="h-3.5 w-3.5" />
        </button>
      </div>

      {error && <div className="mb-3 rounded border border-[#FF4D4D]/30 bg-[#FF4D4D]/5 p-2 font-mono text-[0.65rem] text-[#FF4D4D]">{error}</div>}

      <div className="mb-4 grid gap-2 sm:grid-cols-3">
        {CHAIN_LIST.map((c) => {
          const w = wallets.find((item) => item.chain === c.key && item.is_hot)
          return (
            <div key={c.key} className="rounded border border-[#232738] bg-[#090A0F] p-3">
              <div className="flex items-center justify-between">
                <span className="font-mono text-[0.65rem] uppercase text-[#8a90b0]">{c.label}</span>
                <span className={`text-[0.55rem] ${w?.status === 'active' ? 'text-[#00FF87]' : 'text-[#5a6080]'}`}>{w ? w.status.toUpperCase() : 'NOT SET'}</span>
              </div>
              <p className="mt-2 break-all font-mono text-[0.62rem] text-[#5a6080]">{w?.address || 'No hot wallet registered'}</p>
              {w?.custody_type === 'vault' && <p className="mt-1 text-[0.55rem] text-[#00FF87]">SERVER CUSTODY · VAULT</p>}
            </div>
          )
        })}
      </div>

      <div className="grid gap-4 lg:grid-cols-2">
        <form onSubmit={addDestination} className="rounded border border-[#232738] bg-[#090A0F] p-3">
          <div className="mb-3 flex items-center gap-2 font-mono text-[0.65rem] font-semibold uppercase tracking-wider text-[#8a90b0]"><Plus className="h-3 w-3 text-[#00F0FF]" /> Add approved destination</div>
          <div className="grid gap-2">
            <select value={chain} onChange={(e) => setChain(e.target.value)} className="rounded border border-[#232738] bg-[#12141D] px-2 py-1.5 font-mono text-xs text-[#e0e4f0]">
              {CHAIN_LIST.map((c) => <option key={c.key} value={c.key}>{c.label}</option>)}
            </select>
            <input value={label} onChange={(e) => setLabel(e.target.value)} placeholder="Destination label" className="rounded border border-[#232738] bg-[#12141D] px-2 py-1.5 font-mono text-xs text-[#e0e4f0]" />
            <input required value={address} onChange={(e) => setAddress(e.target.value)} placeholder="Destination address" className="rounded border border-[#232738] bg-[#12141D] px-2 py-1.5 font-mono text-xs text-[#e0e4f0]" />
            <button disabled={busy} className="rounded border border-[#00F0FF]/30 bg-[#00F0FF]/5 px-3 py-2 font-mono text-[0.65rem] font-semibold uppercase text-[#00F0FF] disabled:opacity-40">{busy ? 'Saving…' : 'Add · 24h activation delay'}</button>
          </div>
        </form>

        <div className="rounded border border-[#232738] bg-[#090A0F] p-3">
          <div className="mb-3 flex items-center gap-2 font-mono text-[0.65rem] font-semibold uppercase tracking-wider text-[#8a90b0]"><ShieldCheck className="h-3 w-3 text-[#00FF87]" /> Approved destinations</div>
          <div className="space-y-2">
            {approved.length === 0 && <p className="font-mono text-[0.65rem] text-[#3a4060]">No destinations configured.</p>}
            {approved.map((item) => {
              const ready = item.status === 'pending' && item.activation_at && new Date(item.activation_at) <= new Date()
              return (
                <div key={item.id} className="rounded border border-[#232738] p-2">
                  <div className="flex items-center gap-2">
                    {item.status === 'approved' ? <Check className="h-3 w-3 text-[#00FF87]" /> : <Clock className="h-3 w-3 text-[#FFB800]" />}
                    <span className="font-mono text-[0.65rem] text-[#e0e4f0]">{item.label || 'Destination'}</span>
                    {item.is_primary && <span className="ml-auto text-[0.5rem] text-[#00FF87]">PRIMARY</span>}
                  </div>
                  <div className="mt-1 flex items-center gap-2">
                    <span className="truncate font-mono text-[0.58rem] text-[#5a6080]">{item.address}</span>
                    <button onClick={() => navigator.clipboard?.writeText(item.address)} className="shrink-0 text-[#3a4060] hover:text-[#00F0FF]"><Copy className="h-2.5 w-2.5" /></button>
                  </div>
                  <div className="mt-1 flex items-center justify-between font-mono text-[0.52rem] text-[#3a4060]">
                    <span>{item.status === 'approved' ? `Approved ${formatDate(item.approved_at)}` : `Activates ${formatDate(item.activation_at)}`}</span>
                    {ready && <button onClick={() => activate(item.id)} disabled={busy} className="text-[#00FF87] hover:underline">ACTIVATE</button>}
                  </div>
                </div>
              )
            })}
          </div>
        </div>
      </div>

      {loading && <div className="mt-3 font-mono text-[0.6rem] text-[#5a6080]">Loading wallet state…</div>}
    </div>
  )
}
