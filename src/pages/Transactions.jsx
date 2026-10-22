import { useCallback, useEffect, useMemo, useState } from 'react'
import { ArrowLeft, ExternalLink, RefreshCw, Search, ShieldCheck, Clock3, CheckCircle2, XCircle } from 'lucide-react'
import { Link, useNavigate } from 'react-router-dom'
import { getAuthenticatedSession, supabase } from '@/lib/supabase'
import { useAuth } from '@/lib/AuthContext'

const FILTERS = [
  { id: 'all', label: 'All activity' },
  { id: 'attempted', label: 'Attempted' },
  { id: 'approved', label: 'Approved' },
  { id: 'broadcast', label: 'Broadcast / on-chain' },
  { id: 'failed', label: 'Failed / rejected' },
]
const TERMINAL_FAILURES = new Set(['failed', 'rejected', 'cancelled', 'canceled', 'expired', 'reverted'])
const APPROVED_STATES = new Set(['approved', 'authorized', 'approved_for_signing', 'human_approved', 'verified'])

function short(value) {
  if (!value) return '—'
  return value.length > 24 ? value.slice(0, 12) + '…' + value.slice(-8) : value
}
function amount(value) {
  if (value === null || value === undefined || value === '') return '—'
  const n = Number(value)
  return Number.isFinite(n) ? n.toLocaleString('en-US', { maximumFractionDigits: 8 }) : '—'
}
function stateOf(value) {
  return String(value || '').toLowerCase().replace(/[\s-]+/g, '_')
}
function explorerUrl(chain, hash) {
  if (!hash) return null
  if (chain === 'solana') return `https://solscan.io/tx/${encodeURIComponent(hash)}`
  if (chain === 'ethereum') return `https://etherscan.io/tx/${encodeURIComponent(hash)}`
  if (chain === 'bnb') return `https://bscscan.com/tx/${encodeURIComponent(hash)}`
  if (chain === 'bitcoin') return `https://mempool.space/tx/${encodeURIComponent(hash)}`
  return null
}
function tone(status) {
  const value = stateOf(status)
  if (TERMINAL_FAILURES.has(value)) return 'text-[#FF4D4D] border-[#FF4D4D]/30'
  if (APPROVED_STATES.has(value) || ['confirmed', 'finalized'].includes(value)) return 'text-[#00FF87] border-[#00FF87]/30'
  if (['broadcast', 'submitted', 'pending_confirmation', 'processing'].includes(value)) return 'text-[#00F0FF] border-[#00F0FF]/30'
  return 'text-[#FFB800] border-[#FFB800]/30'
}

export default function Transactions() {
  const navigate = useNavigate()
  const { user, isLoading: authLoading } = useAuth()
  const [rows, setRows] = useState([])
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState('')
  const [filter, setFilter] = useState('all')
  const [search, setSearch] = useState('')

  const load = useCallback(async () => {
    if (authLoading || !user?.id) return
    setLoading(true)
    setError('')
    try {
      const session = await getAuthenticatedSession()
      const ownerId = session.user.id
      const [txResult, authResult, signResult] = await Promise.all([
        supabase.from('wallet_transactions')
          .select('id,chain,asset,amount,status,destination_address,source_wallet_id,requested_at,activated_at,confirmed_at,tx_hash,failure_reason,transaction_class,created_at')
          .eq('owner_id', ownerId)
          .in('transaction_class', ['withdrawal', 'transfer'])
          .order('created_at', { ascending: false })
          .limit(200),
        supabase.from('transfer_authorizations')
          .select('id,wallet_transaction_id,authorization_status,expires_at,created_at')
          .eq('owner_id', ownerId)
          .order('created_at', { ascending: false })
          .limit(200),
        supabase.from('signing_requests')
          .select('id,wallet_transaction_id,status,approval_expires_at,created_at')
          .eq('owner_id', ownerId)
          .order('created_at', { ascending: false })
          .limit(200),
      ])
      if (txResult.error) throw txResult.error
      if (authResult.error) throw authResult.error
      if (signResult.error) throw signResult.error
      const authByTx = new Map((authResult.data || []).map((item) => [item.wallet_transaction_id, item]))
      const signByTx = new Map((signResult.data || []).map((item) => [item.wallet_transaction_id, item]))
      setRows((txResult.data || []).map((tx) => ({
        ...tx,
        authorization: authByTx.get(tx.id) || null,
        signing: signByTx.get(tx.id) || null,
      })))
    } catch (e) {
      setError(e.message || 'Unable to load transaction activity')
    } finally {
      setLoading(false)
    }
  }, [authLoading, user?.id])

  useEffect(() => { load() }, [load])

  const filtered = useMemo(() => {
    const query = search.trim().toLowerCase()
    return rows.filter((row) => {
      const txState = stateOf(row.status)
      const authState = stateOf(row.authorization?.authorization_status)
      const signState = stateOf(row.signing?.status)
      const approved = APPROVED_STATES.has(txState) || APPROVED_STATES.has(authState) || APPROVED_STATES.has(signState)
      const failed = TERMINAL_FAILURES.has(txState) || TERMINAL_FAILURES.has(authState) || TERMINAL_FAILURES.has(signState)
      const onChain = Boolean(row.tx_hash) || ['broadcast', 'confirmed', 'finalized', 'reverted'].includes(txState)
      const matchesFilter = filter === 'all'
        || (filter === 'attempted' && !approved && !failed && !onChain)
        || (filter === 'approved' && approved && !failed)
        || (filter === 'broadcast' && onChain)
        || (filter === 'failed' && failed)
      if (!matchesFilter) return false
      if (!query) return true
      return [row.chain, row.asset, row.status, row.transaction_class, row.destination_address, row.tx_hash, row.failure_reason, row.authorization?.authorization_status, row.signing?.status]
        .some((value) => String(value || '').toLowerCase().includes(query))
    })
  }, [rows, filter, search])

  const counts = useMemo(() => ({
    all: rows.length,
    attempted: rows.filter((r) => !APPROVED_STATES.has(stateOf(r.status)) && !APPROVED_STATES.has(stateOf(r.authorization?.authorization_status)) && !APPROVED_STATES.has(stateOf(r.signing?.status)) && !TERMINAL_FAILURES.has(stateOf(r.status)) && !r.tx_hash && !['broadcast', 'confirmed', 'finalized', 'reverted'].includes(stateOf(r.status))).length,
    approved: rows.filter((r) => APPROVED_STATES.has(stateOf(r.status)) || APPROVED_STATES.has(stateOf(r.authorization?.authorization_status)) || APPROVED_STATES.has(stateOf(r.signing?.status))).length,
    broadcast: rows.filter((r) => Boolean(r.tx_hash) || ['broadcast', 'confirmed', 'finalized', 'reverted'].includes(stateOf(r.status))).length,
    failed: rows.filter((r) => TERMINAL_FAILURES.has(stateOf(r.status)) || TERMINAL_FAILURES.has(stateOf(r.authorization?.authorization_status)) || TERMINAL_FAILURES.has(stateOf(r.signing?.status))).length,
  }), [rows])

  return (
    <div className="min-h-screen bg-[#090A0F] text-[#e0e4f0]">
      <header className="sticky top-0 z-30 flex items-center justify-between gap-3 border-b border-[#232738] bg-[#090A0F]/95 px-4 py-3 backdrop-blur md:px-6">
        <div className="flex items-center gap-3">
          <button onClick={() => navigate('/wallets')} className="rounded border border-[#232738] p-2 text-[#8a90b0] hover:border-[#00F0FF]/40 hover:text-[#00F0FF]" title="Back to wallets"><ArrowLeft className="h-3.5 w-3.5" /></button>
          <div>
            <div className="font-mono text-sm font-bold uppercase tracking-wider text-[#00F0FF]">Transaction Activity</div>
            <div className="mt-0.5 font-mono text-[0.58rem] text-[#5a6080]">Attempted · approval status · network settlement</div>
          </div>
        </div>
        <div className="flex items-center gap-3">
          <Link to="/security/passkeys" className="rounded border border-[#232738] px-3 py-2 font-mono text-[0.58rem] uppercase text-[#00F0FF] hover:border-[#00F0FF]/40">Passkey approval</Link>
          <button onClick={load} disabled={loading || authLoading} className="text-[#5a6080] hover:text-[#00F0FF] disabled:opacity-40" title="Refresh activity"><RefreshCw className="h-4 w-4" /></button>
        </div>
      </header>
      <main className="space-y-4 p-4 md:p-6">
        {error && <div className="rounded border border-[#FF4D4D]/30 bg-[#FF4D4D]/5 p-3 font-mono text-xs text-[#FF4D4D]">{error}</div>}
        <div className="grid grid-cols-2 gap-2 md:grid-cols-5">
          {FILTERS.map((item) => (
            <button key={item.id} onClick={() => setFilter(item.id)} className={`rounded border p-3 text-left ${filter === item.id ? 'border-[#00F0FF]/50 bg-[#00F0FF]/5' : 'border-[#232738] bg-[#0C0E16]'}`}>
              <div className="font-mono text-[0.58rem] uppercase text-[#8a90b0]">{item.label}</div>
              <div className="mt-1 font-mono text-lg text-[#e0e4f0]">{counts[item.id]}</div>
            </button>
          ))}
        </div>
        <section className="rounded border border-[#232738] bg-[#0C0E16] p-3 md:p-4">
          <div className="flex items-center gap-2 rounded border border-[#232738] bg-[#090A0F] px-3 py-2">
            <Search className="h-3.5 w-3.5 text-[#5a6080]" />
            <input value={search} onChange={(e) => setSearch(e.target.value)} placeholder="Search chain, asset, status, destination or hash" className="w-full bg-transparent font-mono text-xs text-[#e0e4f0] outline-none placeholder:text-[#3a4060]" />
          </div>
          <div className="mt-3 space-y-2">
            {filtered.map((row) => {
              const authStatus = row.authorization?.authorization_status
              const signingStatus = row.signing?.status
              const explorer = explorerUrl(row.chain, row.tx_hash)
              const when = row.requested_at || row.created_at
              return (
                <article key={row.id} className="rounded border border-[#232738] bg-[#090A0F] p-3">
                  <div className="flex flex-wrap items-start justify-between gap-2">
                    <div>
                      <div className="font-mono text-xs font-semibold uppercase text-[#e0e4f0]">{row.transaction_class === 'transfer' ? 'Internal transfer' : 'External withdrawal'} · {String(row.chain || 'unknown').toUpperCase()}</div>
                      <div className="mt-1 font-mono text-sm">{amount(row.amount)} {row.asset || ''}</div>
                    </div>
                    <span className={`rounded border px-2 py-1 font-mono text-[0.56rem] uppercase ${tone(row.status)}`}>{row.status || 'unknown'}</span>
                  </div>
                  <div className="mt-3 grid gap-3 text-[0.58rem] md:grid-cols-2 xl:grid-cols-4">
                    <div><div className="font-mono uppercase text-[#5a6080]">Destination</div><div className="mt-1 break-all font-mono text-[#8a90b0]">{short(row.destination_address)}</div></div>
                    <div><div className="font-mono uppercase text-[#5a6080]">Requested</div><div className="mt-1 font-mono text-[#8a90b0]">{when ? new Date(when).toLocaleString() : '—'}</div></div>
                    <div><div className="font-mono uppercase text-[#5a6080]">Human authorization</div><div className={`mt-1 font-mono uppercase ${tone(authStatus)}`}>{authStatus || 'not recorded'}</div></div>
                    <div><div className="font-mono uppercase text-[#5a6080]">Signing request</div><div className={`mt-1 font-mono uppercase ${tone(signingStatus)}`}>{signingStatus || 'not recorded'}</div></div>
                  </div>
                  {row.failure_reason && <div className="mt-3 rounded border border-[#FF4D4D]/20 bg-[#FF4D4D]/5 p-2 font-mono text-[0.58rem] text-[#FF4D4D]">Failure: {row.failure_reason}</div>}
                  <div className="mt-3 flex flex-wrap items-center justify-between gap-2 border-t border-[#232738] pt-2">
                    <div className="font-mono text-[0.55rem] text-[#5a6080]">{row.tx_hash ? `Network transaction: ${short(row.tx_hash)}` : 'No network hash — transaction may not have been broadcast'}</div>
                    {explorer && <a href={explorer} target="_blank" rel="noreferrer" className="inline-flex items-center gap-1 font-mono text-[0.56rem] text-[#00F0FF] hover:underline">View on explorer <ExternalLink className="h-3 w-3" /></a>}
                    {!explorer && row.tx_hash && <span className="font-mono text-[0.55rem] text-[#8a90b0]">Explorer unavailable for this chain</span>}
                  </div>
                  {stateOf(row.status) === 'requested' && stateOf(signingStatus) === 'pending' && <div className="mt-2 flex items-center gap-1 font-mono text-[0.55rem] text-[#FFB800]"><Clock3 className="h-3 w-3" /> Waiting for required approval; no broadcast is implied.</div>}
                  {TERMINAL_FAILURES.has(stateOf(row.status)) && <div className="mt-2 flex items-center gap-1 font-mono text-[0.55rem] text-[#FF4D4D]"><XCircle className="h-3 w-3" /> Request did not complete successfully.</div>}
                  {(APPROVED_STATES.has(stateOf(authStatus)) || APPROVED_STATES.has(stateOf(signingStatus))) && <div className="mt-2 flex items-center gap-1 font-mono text-[0.55rem] text-[#00FF87]"><ShieldCheck className="h-3 w-3" /> Approval recorded. This is separate from network confirmation.</div>}
                  {['confirmed', 'finalized'].includes(stateOf(row.status)) && <div className="mt-2 flex items-center gap-1 font-mono text-[0.55rem] text-[#00FF87]"><CheckCircle2 className="h-3 w-3" /> Network confirmation recorded.</div>}
                </article>
              )
            })}
            {!loading && !filtered.length && <div className="py-10 text-center font-mono text-xs text-[#5a6080]">No transaction records match this view.</div>}
            {loading && <div className="py-10 text-center font-mono text-xs text-[#5a6080]">Loading transaction records…</div>}
          </div>
          <div className="mt-4 border-t border-[#232738] pt-3 font-mono text-[0.55rem] text-[#5a6080]">Approval status and blockchain settlement are shown separately. A transaction hash is displayed only when one is recorded by the backend after broadcast.</div>
        </section>
      </main>
    </div>
  )
}
