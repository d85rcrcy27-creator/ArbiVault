import { useCallback, useEffect, useState } from 'react'
import { Link } from 'react-router-dom'
import { ArrowLeft, ExternalLink, RefreshCw, ShieldAlert } from 'lucide-react'
import { supabase } from '@/lib/supabase'

const FIELDS = 'id,chain,strategy,pair,borrowed_amount,notional_amount,gross_profit,fees_paid,net_profit,status,execution_mode,tx_hash,explorer_url,metadata,created_at,confirmed_at'

function formatAmount(value, digits = 6) {
  if (value === null || value === undefined || value === '') return '—'
  const number = Number(value)
  return Number.isFinite(number) ? number.toLocaleString(undefined, { maximumFractionDigits: digits }) : '—'
}

function repaymentLabel(trade) {
  const metadata = trade.metadata && typeof trade.metadata === 'object' ? trade.metadata : {}
  const value = metadata.repayment_status ?? metadata.repaymentStatus ?? metadata.loan_repaid
  if (value === true || value === 'repaid' || value === 'confirmed') return 'Repaid'
  if (value === false || value === 'unpaid' || value === 'failed') return 'Not repaid'
  return 'Not recorded'
}

export default function FlashLoans() {
  const [rows, setRows] = useState([])
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState('')
  const [lastUpdated, setLastUpdated] = useState(null)

  const load = useCallback(async () => {
    setLoading(true)
    setError('')
    try {
      const { data: { user }, error: authError } = await supabase.auth.getUser()
      if (authError) throw authError
      if (!user) throw new Error('Your Supabase session is unavailable. Please sign in again.')
      const { data, error: queryError } = await supabase
        .from('trades')
        .select(FIELDS)
        .eq('owner_id', user.id)
        .order('created_at', { ascending: false })
        .limit(200)
      if (queryError) throw queryError
      setRows((data || []).filter((trade) => {
        const metadata = trade.metadata && typeof trade.metadata === 'object' ? trade.metadata : {}
        const description = [trade.strategy, trade.execution_mode, metadata.execution_type, metadata.loan_provider].join(' ')
        return /flash/i.test(String(description)) || (trade.borrowed_amount !== null && trade.borrowed_amount !== undefined)
      }))
      setLastUpdated(new Date())
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Could not load flash-loan records.')
      setRows([])
    } finally {
      setLoading(false)
    }
  }, [])

  useEffect(() => { load() }, [load])

  const totalNet = rows.reduce((sum, row) => sum + (row.net_profit != null && Number.isFinite(Number(row.net_profit)) ? Number(row.net_profit) : 0), 0)
  const confirmed = rows.filter((row) => Boolean(row.tx_hash) && /confirm|success|executed/i.test(String(row.status || ''))).length

  return (
    <main className="min-h-screen bg-[#090A0F] px-4 py-6 text-[#e0e4f0] sm:px-8">
      <div className="mx-auto max-w-7xl space-y-6">
        <Link to="/" className="inline-flex items-center gap-2 font-mono text-xs text-[#8a90b0] hover:text-[#00F0FF]"><ArrowLeft size={14} /> BACK TO ARBIVAULT</Link>
        <header className="flex flex-col gap-4 border-b border-[#232738] pb-5 sm:flex-row sm:items-end sm:justify-between">
          <div><p className="font-mono text-[10px] uppercase tracking-[.22em] text-[#00F0FF]">Execution records</p><h1 className="mt-2 text-2xl font-semibold sm:text-3xl">Flash Loan Explorer</h1><p className="mt-2 max-w-2xl text-sm text-[#8a90b0]">Review recorded borrow amounts, repayment evidence, transaction references and realized net profit. This page displays database records only; it does not initiate loans.</p></div>
          <button onClick={load} disabled={loading} className="inline-flex items-center justify-center gap-2 rounded border border-[#30364b] px-4 py-2 font-mono text-xs hover:border-[#00F0FF] disabled:opacity-50"><RefreshCw size={14} className={loading ? 'animate-spin' : ''} /> REFRESH</button>
        </header>

        <div className="grid gap-3 sm:grid-cols-3">
          <section className="rounded border border-[#232738] bg-[#0C0E16] p-4"><p className="font-mono text-[10px] uppercase text-[#8a90b0]">Recorded flash-loan trades</p><p className="mt-2 text-2xl font-mono">{loading ? '…' : rows.length}</p></section>
          <section className="rounded border border-[#232738] bg-[#0C0E16] p-4"><p className="font-mono text-[10px] uppercase text-[#8a90b0]">Rows with confirmed tx reference</p><p className="mt-2 text-2xl font-mono">{loading ? '…' : confirmed}</p></section>
          <section className="rounded border border-[#232738] bg-[#0C0E16] p-4"><p className="font-mono text-[10px] uppercase text-[#8a90b0]">Sum of recorded net profit</p><p className="mt-2 text-2xl font-mono">{loading ? '…' : formatAmount(totalNet)}</p><p className="mt-1 text-[10px] text-[#5a6080]">Mixed assets are not converted to a common currency.</p></section>
        </div>

        {error && <div role="alert" className="rounded border border-red-500/40 bg-red-950/20 p-4 text-sm text-red-200">{error}</div>}
        <section className="overflow-hidden rounded border border-[#232738] bg-[#0C0E16]">
          <div className="flex items-center justify-between border-b border-[#232738] px-4 py-3"><h2 className="font-mono text-xs font-semibold uppercase tracking-wider">Trade ledger</h2><span className="font-mono text-[10px] text-[#5a6080]">{lastUpdated ? 'Updated ' + lastUpdated.toLocaleTimeString() : 'Not yet updated'}</span></div>
          {loading ? <p className="p-6 text-sm text-[#8a90b0]">Loading real trade records…</p> : rows.length === 0 ? <div className="p-8 text-center"><ShieldAlert className="mx-auto mb-3 text-[#8a90b0]" size={24} /><p className="text-sm">No flash-loan trade records found for this account.</p><p className="mt-2 text-xs text-[#5a6080]">No sample rows are shown. Records appear when the execution pipeline writes them to Supabase.</p></div> : <div className="overflow-x-auto"><table className="w-full min-w-[1000px] text-left text-xs"><thead className="bg-[#090A0F] font-mono uppercase text-[#8a90b0]"><tr>{['Time / chain','Strategy / pair','Borrowed amount','Repayment','Net profit','Status','Transaction'].map((h) => <th key={h} className="px-4 py-3 font-medium">{h}</th>)}</tr></thead><tbody>{rows.map((trade) => <tr key={trade.id} className="border-t border-[#232738] align-top"><td className="px-4 py-3"><div>{trade.created_at ? new Date(trade.created_at).toLocaleString() : '—'}</div><div className="mt-1 uppercase text-[#5a6080]">{trade.chain || '—'}</div></td><td className="px-4 py-3"><div>{trade.strategy || '—'}</div><div className="mt-1 text-[#8a90b0]">{trade.pair || '—'}</div></td><td className="px-4 py-3 font-mono">{formatAmount(trade.borrowed_amount)}</td><td className="px-4 py-3"><span className={repaymentLabel(trade) === 'Repaid' ? 'text-[#00FF87]' : 'text-[#FFB800]'}>{repaymentLabel(trade)}</span></td><td className="px-4 py-3 font-mono">{trade.net_profit == null ? 'Not recorded' : formatAmount(trade.net_profit)}</td><td className="px-4 py-3"><div>{trade.status || '—'}</div><div className="mt-1 text-[#5a6080]">{trade.execution_mode || '—'}</div></td><td className="px-4 py-3">{trade.explorer_url ? <a className="inline-flex items-center gap-1 text-[#00F0FF] hover:underline" href={trade.explorer_url} target="_blank" rel="noreferrer">{trade.tx_hash ? trade.tx_hash.slice(0, 12) + '…' : 'Open explorer'} <ExternalLink size={12} /></a> : trade.tx_hash ? <span className="font-mono text-[#8a90b0]">{trade.tx_hash.slice(0, 16)}…</span> : 'No tx hash recorded'}</td></tr>)}</tbody></table></div>}
        </section>
        <p className="text-[11px] leading-5 text-[#5a6080]">Repayment is shown as verified only when the stored record explicitly contains repayment evidence. A transaction hash and a positive profit field are not independently re-verified on-chain by this page.</p>
      </div>
    </main>
  )
}
