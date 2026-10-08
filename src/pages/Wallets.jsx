import { useEffect, useMemo, useState } from 'react'
import { ArrowLeft, ArrowUpRight, CheckCircle2, Clock3, Copy, Plus, RefreshCw, Send, ShieldCheck } from 'lucide-react'
import WalletBootstrap from '@/components/arbitrage/WalletBootstrap'
import { addApprovedDestination, activateApprovedDestination, createWithdrawal } from '@/lib/arbivault'
import { getAuthenticatedSession, supabase } from '@/lib/supabase'
import { useAuth } from '@/lib/AuthContext'
import { useNavigate } from 'react-router-dom'

const CHAINS = [
  { id: 'bnb', label: 'BNB Smart Chain', asset: 'BNB' },
  { id: 'ethereum', label: 'Ethereum', asset: 'ETH' },
  { id: 'solana', label: 'Solana', asset: 'SOL' },
  { id: 'bitcoin', label: 'Bitcoin', asset: 'BTC' },
]

function short(value) {
  if (!value) return '—'
  return value.length > 18 ? `${value.slice(0, 10)}…${value.slice(-8)}` : value
}

function formatAmount(value) {
  if (value === null || value === undefined || value === '') return '—'
  const n = Number(value)
  return Number.isFinite(n) ? n.toLocaleString('en-US', { maximumFractionDigits: 8 }) : '—'
}

export default function Wallets() {
  const navigate = useNavigate()
  const { user, isLoading: authLoading } = useAuth()
  const [wallets, setWallets] = useState([])
  const [destinations, setDestinations] = useState([])
  const [requests, setRequests] = useState([])
  const [loading, setLoading] = useState(true)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')
  const [message, setMessage] = useState('')
  const [destinationForm, setDestinationForm] = useState({ chain: 'bnb', address: '', label: '' })
  const [withdrawForm, setWithdrawForm] = useState({ sourceWalletId: '', destinationId: '', amount: '' })
  const [approvalUri, setApprovalUri] = useState('')

  const load = async () => {
    if (authLoading || !user) return
    setLoading(true)
    setError('')
    try {
      const session = await getAuthenticatedSession()
      const ownerId = session.user.id
      const [walletResult, destinationResult, requestResult] = await Promise.all([
        supabase.from('wallets')
          .select('id,chain,address,status,is_hot,custody_type,wallet_role,last_balance,balance_usd,last_verified_at,verification_source,data_quality_status')
          .eq('owner_id', ownerId)
          .order('chain'),
        supabase.from('approved_wallets')
          .select('id,chain,address,label,status,approved_at,activation_at,is_primary,approval_note')
          .eq('owner_id', ownerId)
          .order('created_at', { ascending: false }),
        supabase.from('wallet_transactions')
          .select('id,chain,asset,amount,status,destination_address,requested_at,activated_at,confirmed_at,tx_hash,failure_reason,transaction_class')
          .eq('owner_id', ownerId)
          .eq('transaction_class', 'withdrawal')
          .order('created_at', { ascending: false })
          .limit(25),
      ])
      if (walletResult.error) throw walletResult.error
      if (destinationResult.error) throw destinationResult.error
      if (requestResult.error) throw requestResult.error
      setWallets(walletResult.data || [])
      setDestinations(destinationResult.data || [])
      setRequests(requestResult.data || [])
      setWithdrawForm((prev) => ({
        ...prev,
        sourceWalletId: prev.sourceWalletId || (walletResult.data || []).find((w) => w.is_hot && w.wallet_role === 'trading_hot' && w.status === 'active')?.id || '',
      }))
    } catch (e) {
      setError(e.message || 'Unable to load wallets')
    } finally {
      setLoading(false)
    }
  }

  useEffect(() => { load() }, [authLoading, user?.id])

  const eligibleWallets = useMemo(
    () => wallets.filter((w) => w.is_hot && w.wallet_role === 'trading_hot' && w.status === 'active'),
    [wallets],
  )

  const selectedSource = wallets.find((w) => w.id === withdrawForm.sourceWalletId)
  const eligibleDestinations = destinations.filter(
    (d) => d.status === 'approved' && (!selectedSource || d.chain === selectedSource.chain),
  )

  const handleAddDestination = async (event) => {
    event.preventDefault()
    setBusy(true)
    setError('')
    setMessage('')
    try {
      const result = await addApprovedDestination(destinationForm)
      setDestinationForm((prev) => ({ ...prev, address: '', label: '' }))
      setMessage(result.existing ? 'Destination already exists.' : 'Destination added. It must pass the activation delay before withdrawal.')
      await load()
    } catch (e) {
      setError(e.message || 'Unable to add destination')
    } finally {
      setBusy(false)
    }
  }

  const handleActivate = async (id) => {
    setBusy(true)
    setError('')
    setMessage('')
    try {
      await activateApprovedDestination(id, false)
      setMessage('Destination activated and available for withdrawals.')
      await load()
    } catch (e) {
      setError(e.message || 'Destination is not ready for activation')
    } finally {
      setBusy(false)
    }
  }

  const handleWithdraw = async (event) => {
    event.preventDefault()
    setBusy(true)
    setError('')
    setMessage('')
    setApprovalUri('')
    try {
      const source = wallets.find((w) => w.id === withdrawForm.sourceWalletId)
      const asset = CHAINS.find((c) => c.id === source?.chain)?.asset
      const result = await createWithdrawal({
        sourceWalletId: withdrawForm.sourceWalletId,
        destinationId: withdrawForm.destinationId,
        amount: withdrawForm.amount,
        asset,
      })
      setApprovalUri(result.approval_uri || '')
      setMessage('Withdrawal request created. Human approval is required before signing or broadcast.')
      setWithdrawForm((prev) => ({ ...prev, amount: '' }))
      await load()
    } catch (e) {
      setError(e.message || 'Unable to create withdrawal')
    } finally {
      setBusy(false)
    }
  }

  const copyAddress = async (address) => {
    try {
      await navigator.clipboard.writeText(address)
      setMessage('Address copied.')
    } catch {
      setMessage('Address: ' + address)
    }
  }

  return (
    <div className="min-h-screen bg-[#090A0F] text-[#e0e4f0]">
      <header className="sticky top-0 z-30 flex items-center justify-between border-b border-[#232738] bg-[#090A0F]/95 px-4 py-3 backdrop-blur md:px-6">
        <div className="flex items-center gap-3">
          <button onClick={() => navigate('/')} className="rounded border border-[#232738] p-2 text-[#8a90b0] hover:border-[#00F0FF]/40 hover:text-[#00F0FF]" title="Back">
            <ArrowLeft className="h-3.5 w-3.5" />
          </button>
          <div>
            <div className="font-mono text-sm font-bold uppercase tracking-wider text-[#00F0FF]">Wallets & Transfers</div>
            <div className="mt-0.5 font-mono text-[0.58rem] text-[#5a6080]">Real wallet inventory · approved destinations · withdrawal requests</div>
          </div>
        </div>
        <button onClick={load} disabled={loading || authLoading} className="text-[#5a6080] hover:text-[#00F0FF] disabled:opacity-40" title="Refresh">
          <RefreshCw className="h-4 w-4" />
        </button>
      </header>

      <main className="space-y-4 p-4 md:p-6">
        <WalletBootstrap />

        {(error || message) && (
          <div className={`rounded border p-3 font-mono text-[0.62rem] ${error ? 'border-[#FF4D4D]/30 bg-[#FF4D4D]/5 text-[#FF4D4D]' : 'border-[#00FF87]/30 bg-[#00FF87]/5 text-[#00FF87]'}`}>
            {error || message}
          </div>
        )}

        <section className="rounded border border-[#232738] bg-[#0C0E16] p-4">
          <div className="mb-4 flex items-center gap-2 font-mono text-xs font-bold uppercase tracking-wider text-[#00F0FF]">
            <ShieldCheck className="h-3.5 w-3.5" /> Trading Wallet Inventory
          </div>
          <div className="grid gap-3 md:grid-cols-3">
            {CHAINS.map((chain) => {
              const wallet = wallets.find((w) => w.chain === chain.id && w.wallet_role === 'trading_hot' && w.status === 'active')
              return (
                <div key={chain.id} className="rounded border border-[#232738] bg-[#090A0F] p-3">
                  <div className="flex items-center justify-between">
                    <span className="font-mono text-xs font-semibold uppercase">{chain.asset}</span>
                    {wallet ? <CheckCircle2 className="h-3.5 w-3.5 text-[#00FF87]" /> : <Clock3 className="h-3.5 w-3.5 text-[#FFB800]" />}
                  </div>
                  <div className="mt-2 font-mono text-[0.57rem] text-[#8a90b0]">{short(wallet?.address)}</div>
                  <div className="mt-2 flex items-center justify-between font-mono text-[0.55rem] text-[#5a6080]">
                    <span>Balance</span>
                    <span>{formatAmount(wallet?.last_balance)} {wallet ? chain.asset : ''}</span>
                  </div>
                  <button
                    onClick={() => wallet?.address && copyAddress(wallet.address)}
                    disabled={!wallet}
                    className="mt-2 flex w-full items-center justify-center gap-1 rounded border border-[#232738] px-2 py-1.5 font-mono text-[0.57rem] text-[#8a90b0] hover:border-[#00F0FF]/30 disabled:opacity-30"
                  >
                    <Copy className="h-3 w-3" /> Copy address
                  </button>
                </div>
              )
            })}
          </div>
        </section>

        <div className="grid gap-4 xl:grid-cols-2">
          <section className="rounded border border-[#232738] bg-[#0C0E16] p-4">
            <div className="mb-4 flex items-center gap-2 font-mono text-xs font-bold uppercase tracking-wider text-[#00F0FF]">
              <Plus className="h-3.5 w-3.5" /> Withdrawal Destinations
            </div>
            <form onSubmit={handleAddDestination} className="space-y-2">
              <select value={destinationForm.chain} onChange={(e) => setDestinationForm({ ...destinationForm, chain: e.target.value })} className="w-full rounded border border-[#232738] bg-[#090A0F] px-2.5 py-2 font-mono text-xs text-[#e0e4f0]">
                {CHAINS.map((c) => <option key={c.id} value={c.id}>{c.label}</option>)}
              </select>
              <input required value={destinationForm.address} onChange={(e) => setDestinationForm({ ...destinationForm, address: e.target.value })} placeholder="External wallet address" className="w-full rounded border border-[#232738] bg-[#090A0F] px-2.5 py-2 font-mono text-xs text-[#e0e4f0]" />
              <input value={destinationForm.label} onChange={(e) => setDestinationForm({ ...destinationForm, label: e.target.value })} placeholder="Label (optional)" className="w-full rounded border border-[#232738] bg-[#090A0F] px-2.5 py-2 font-mono text-xs text-[#e0e4f0]" />
              <button disabled={busy} className="flex w-full items-center justify-center gap-1.5 rounded border border-[#00F0FF]/40 bg-[#00F0FF]/5 px-3 py-2 font-mono text-[0.62rem] font-bold uppercase text-[#00F0FF] disabled:opacity-40">
                Add destination
              </button>
            </form>
            <div className="mt-4 space-y-2">
              {destinations.map((d) => {
                const ready = d.activation_at && new Date(d.activation_at) <= new Date()
                return (
                  <div key={d.id} className="rounded border border-[#232738] bg-[#090A0F] p-3">
                    <div className="flex items-center justify-between gap-2">
                      <div>
                        <div className="font-mono text-[0.62rem] font-semibold">{d.label || 'External destination'}</div>
                        <div className="mt-1 font-mono text-[0.55rem] text-[#5a6080]">{d.chain.toUpperCase()} · {short(d.address)}</div>
                      </div>
                      <span className={`font-mono text-[0.55rem] uppercase ${d.status === 'approved' ? 'text-[#00FF87]' : 'text-[#FFB800]'}`}>{d.status}</span>
                    </div>
                    {d.status === 'pending' && (
                      <div className="mt-2 flex items-center justify-between gap-2 font-mono text-[0.53rem] text-[#5a6080]">
                        <span>Activates {new Date(d.activation_at).toLocaleString()}</span>
                        <button onClick={() => handleActivate(d.id)} disabled={!ready || busy} className="rounded border border-[#00FF87]/30 px-2 py-1 text-[#00FF87] disabled:opacity-30">Activate</button>
                      </div>
                    )}
                  </div>
                )
              })}
              {!destinations.length && <p className="font-mono text-[0.58rem] text-[#3a4060]">No withdrawal destinations configured.</p>}
            </div>
          </section>

          <section className="rounded border border-[#232738] bg-[#0C0E16] p-4">
            <div className="mb-4 flex items-center gap-2 font-mono text-xs font-bold uppercase tracking-wider text-[#00F0FF]">
              <Send className="h-3.5 w-3.5" /> Withdraw Crypto
            </div>
            <form onSubmit={handleWithdraw} className="space-y-2">
              <select required value={withdrawForm.sourceWalletId} onChange={(e) => setWithdrawForm({ ...withdrawForm, sourceWalletId: e.target.value, destinationId: '' })} className="w-full rounded border border-[#232738] bg-[#090A0F] px-2.5 py-2 font-mono text-xs text-[#e0e4f0]">
                <option value="">Select source wallet</option>
                {eligibleWallets.map((w) => {
                  const asset = CHAINS.find((c) => c.id === w.chain)?.asset || w.chain
                  return <option key={w.id} value={w.id}>{asset} · {short(w.address)}</option>
                })}
              </select>
              <select required value={withdrawForm.destinationId} onChange={(e) => setWithdrawForm({ ...withdrawForm, destinationId: e.target.value })} className="w-full rounded border border-[#232738] bg-[#090A0F] px-2.5 py-2 font-mono text-xs text-[#e0e4f0]">
                <option value="">Select approved destination</option>
                {eligibleDestinations.map((d) => <option key={d.id} value={d.id}>{d.chain.toUpperCase()} · {short(d.address)}{d.is_primary ? ' · PRIMARY' : ''}</option>)}
              </select>
              <input required min="0.00000001" step="any" type="number" value={withdrawForm.amount} onChange={(e) => setWithdrawForm({ ...withdrawForm, amount: e.target.value })} placeholder="Amount" className="w-full rounded border border-[#232738] bg-[#090A0F] px-2.5 py-2 font-mono text-xs text-[#e0e4f0]" />
              <button disabled={busy || !eligibleDestinations.length || !withdrawForm.sourceWalletId} className="flex w-full items-center justify-center gap-1.5 rounded border border-[#FFB800]/40 bg-[#FFB800]/5 px-3 py-2 font-mono text-[0.62rem] font-bold uppercase text-[#FFB800] disabled:opacity-40">
                <ArrowUpRight className="h-3.5 w-3.5" /> Request withdrawal approval
              </button>
            </form>
            <div className="mt-3 rounded border border-[#232738] bg-[#090A0F] p-2.5 font-mono text-[0.55rem] text-[#5a6080]">
              Withdrawals do not bypass signer controls. A request must be approved before signing or broadcast.
            </div>
            {approvalUri && (
              <div className="mt-3 rounded border border-[#00F0FF]/30 bg-[#00F0FF]/5 p-3">
                <div className="font-mono text-[0.56rem] uppercase text-[#00F0FF]">Approval challenge created</div>
                <div className="mt-1 break-all font-mono text-[0.5rem] text-[#8a90b0]">{approvalUri}</div>
                <button onClick={() => copyAddress(approvalUri)} className="mt-2 flex items-center gap-1 rounded border border-[#232738] px-2 py-1 font-mono text-[0.55rem] text-[#8a90b0]">
                  <Copy className="h-3 w-3" /> Copy approval payload
                </button>
              </div>
            )}
          </section>
        </div>

        <section className="rounded border border-[#232738] bg-[#0C0E16] p-4">
          <div className="mb-3 font-mono text-xs font-bold uppercase tracking-wider text-[#00F0FF]">Withdrawal History</div>
          <div className="space-y-2">
            {requests.map((r) => (
              <div key={r.id} className="grid gap-2 rounded border border-[#232738] bg-[#090A0F] p-3 md:grid-cols-5 md:items-center">
                <div className="font-mono text-[0.58rem] text-[#e0e4f0]">{r.chain.toUpperCase()} · {formatAmount(r.amount)} {r.asset}</div>
                <div className="font-mono text-[0.55rem] text-[#5a6080]">{short(r.destination_address)}</div>
                <div className={`font-mono text-[0.55rem] uppercase ${r.status === 'confirmed' ? 'text-[#00FF87]' : r.status === 'failed' ? 'text-[#FF4D4D]' : 'text-[#FFB800]'}`}>{r.status}</div>
                <div className="font-mono text-[0.53rem] text-[#5a6080]">{r.requested_at ? new Date(r.requested_at).toLocaleString() : '—'}</div>
                <div className="text-right font-mono text-[0.5rem] text-[#5a6080]">{r.tx_hash ? short(r.tx_hash) : 'No tx hash yet'}</div>
              </div>
            ))}
            {!requests.length && <p className="font-mono text-[0.58rem] text-[#3a4060]">No withdrawals requested.</p>}
          </div>
        </section>
      </main>
    </div>
  )
}
