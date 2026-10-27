import { useCallback, useEffect, useMemo, useState } from 'react'
import { Link } from 'react-router-dom'
import { supabase } from '@/lib/supabase'

const PANEL = 'rounded border border-[#232738] bg-[#0C0E16]'
const MUTED = 'text-[#8a90b0]'
const MONO = 'font-mono'
const money = (value, currency = 'USD') => {
  const n = Number(value)
  if (!Number.isFinite(n)) return '—'
  const code = String(currency || '').toUpperCase()
  if (['USD', 'EUR', 'GBP', 'CAD', 'AUD', 'JPY', 'CHF'].includes(code)) {
    return new Intl.NumberFormat('en-US', { style: 'currency', currency: code, maximumFractionDigits: 4 }).format(n)
  }
  return n.toLocaleString('en-US', { maximumFractionDigits: 8 }) + (code ? ' ' + code : ' (currency not set)')
}
const date = (value) => value ? new Date(value).toLocaleString() : '—'
const asTime = (row, fields) => fields.map((field) => row?.[field]).find(Boolean) || null
const isConfirmedTrade = (trade) => String(trade.status || '').toLowerCase() === 'confirmed' && Boolean(trade.tx_hash) && Boolean(trade.confirmed_at)
const isPaidPayment = (payment) => String(payment.status || '').toLowerCase() === 'paid' && Boolean(payment.paid_at)

function Metric({ label, value, note }) {
  return <div className={PANEL + ' p-4'}>
    <div className={MONO + ' text-[0.6rem] uppercase tracking-wider ' + MUTED}>{label}</div>
    <div className={MONO + ' mt-2 text-xl font-bold text-[#e0e4f0]'}>{value}</div>
    <div className={MONO + ' mt-2 text-[0.58rem] ' + MUTED}>{note}</div>
  </div>
}

function ActivityTable({ title, rows, kind }) {
  return <section className={PANEL + ' overflow-hidden'}>
    <div className="flex items-center justify-between border-b border-[#232738] px-4 py-3">
      <h2 className={MONO + ' text-xs font-bold uppercase tracking-wider text-[#00F0FF]'}>{title}</h2>
      <span className={MONO + ' text-[0.6rem] ' + MUTED}>{rows.length} records loaded</span>
    </div>
    <div className="max-h-[28rem] overflow-auto">
      {rows.length === 0 ? <div className={MONO + ' p-6 text-center text-xs ' + MUTED}>No matching records returned by the connected backend.</div> : <table className="w-full min-w-[640px] text-left">
        <thead className="sticky top-0 bg-[#090A0F]">
          <tr className={MONO + ' text-[0.58rem] uppercase ' + MUTED}>
            <th className="px-4 py-2 font-normal">Time</th><th className="px-4 py-2 font-normal">Activity</th><th className="px-4 py-2 font-normal">Status</th><th className="px-4 py-2 font-normal">Value / P&amp;L</th><th className="px-4 py-2 font-normal">Proof / reference</th>
          </tr>
        </thead>
        <tbody>
          {rows.map((row) => <tr key={kind + ':' + row.id} className="border-t border-[#1a1d2b]">
            <td className={MONO + ' px-4 py-3 text-[0.62rem] ' + MUTED}>{date(row.time)}</td>
            <td className="px-4 py-3"><div className="text-xs text-[#e0e4f0]">{row.title || row.name || row.workflow || kind}</div><div className={MONO + ' mt-1 text-[0.56rem] ' + MUTED}>{row.subtitle || row.source || row.pair || row.chain || ''}</div></td>
            <td className="px-4 py-3"><span className={MONO + ' text-[0.6rem] ' + (['paid','confirmed','completed'].includes(String(row.status).toLowerCase()) ? 'text-[#00FF87]' : ['failed','blocked','rejected'].includes(String(row.status).toLowerCase()) ? 'text-[#FF4D4D]' : 'text-[#FFB84D]')}>{row.status || 'unknown'}</span></td>
            <td className={MONO + ' px-4 py-3 text-[0.65rem] text-[#e0e4f0]'}>{row.amountLabel || '—'}</td>
            <td className="px-4 py-3">
              {row.proofUrl ? <a className="font-mono text-[0.6rem] text-[#00F0FF] underline" href={row.proofUrl} target="_blank" rel="noreferrer">{row.proofLabel || 'Open proof'}</a> : <span className={MONO + ' text-[0.58rem] ' + MUTED}>{row.proofLabel || 'No payment / chain proof'}</span>}
            </td>
          </tr>)}
        </tbody>
      </table>}
    </div>
  </section>
}

export default function RevenueStream() {
  const [userId, setUserId] = useState(null)
  const [data, setData] = useState({ payments: [], tasks: [], opportunities: [], trades: [], runs: [] })
  const [sourceStatus, setSourceStatus] = useState({ arbivault: { connected: false }, quantum: { connected: false, reason: 'Not checked yet' } })
  const [sourceWarnings, setSourceWarnings] = useState([])
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState('')
  const [lastUpdated, setLastUpdated] = useState(null)
  const [tab, setTab] = useState('all')

  const load = useCallback(async (id, quiet = false) => {
    if (!id) return
    if (!quiet) setLoading(true)
    const { data: response, error: invokeError } = await supabase.functions.invoke('mad-man-revenue-stream')
    if (invokeError) {
      setError('Revenue stream endpoint unavailable: ' + invokeError.message)
      setLoading(false)
      return
    }
    if (!response?.ok || !response?.data) {
      setError(response?.error || 'Revenue stream returned no verified data.')
      setLoading(false)
      return
    }
    setData({
      payments: response.data.payments || [],
      tasks: response.data.tasks || [],
      opportunities: response.data.opportunities || [],
      trades: response.data.trades || [],
      runs: response.data.runs || [],
    })
    setSourceStatus(response.sourceStatus || { arbivault: { connected: true }, quantum: { connected: false, reason: 'Source status unavailable' } })
    setSourceWarnings(response.warnings || [])
    const quantumStatus = response.sourceStatus?.quantum
    setError(quantumStatus?.connected ? '' : (quantumStatus?.reason || 'Quantum Lead AI is not connected to the shared stream yet.'))
    setLastUpdated(response.generatedAt || new Date().toISOString())
    setLoading(false)
  }, [])

  useEffect(() => {
    let alive = true
    let channel
    supabase.auth.getUser().then(({ data: authData, error: authError }) => {
      if (!alive) return
      if (authError || !authData.user) {
        setError('Sign in to view your revenue activity.')
        setLoading(false)
        return
      }
      const id = authData.user.id
      setUserId(id)
      load(id)
      channel = supabase.channel('mad-man-revenue-' + id)
        .on('postgres_changes', { event: '*', schema: 'public', table: 'trades', filter: 'owner_id=eq.' + id }, () => load(id, true))
        .on('postgres_changes', { event: '*', schema: 'public', table: 'bot_execution_runs', filter: 'owner_id=eq.' + id }, () => load(id, true))
        .on('postgres_changes', { event: '*', schema: 'public', table: 'payments', filter: 'owner_id=eq.' + id }, () => load(id, true))
        .on('postgres_changes', { event: '*', schema: 'public', table: 'tasks', filter: 'owner_id=eq.' + id }, () => load(id, true))
        .on('postgres_changes', { event: '*', schema: 'public', table: 'opportunities', filter: 'owner_id=eq.' + id }, () => load(id, true))
        .subscribe()
    }).catch((e) => {
      if (alive) { setError(e?.message || 'Could not authenticate with the backend.'); setLoading(false) }
    })
    return () => {
      alive = false
      if (channel) supabase.removeChannel(channel)
    }
  }, [load])

  // Refresh the read-only view periodically in case some source tables are not
  // enabled in the project's Realtime publication yet.
  useEffect(() => {
    if (!userId) return undefined
    const timer = window.setInterval(() => load(userId, true), 60000)
    return () => window.clearInterval(timer)
  }, [userId, load])

  const confirmedPayments = useMemo(() => data.payments.filter(isPaidPayment), [data.payments])
  const confirmedTrades = useMemo(() => data.trades.filter(isConfirmedTrade), [data.trades])
  const confirmedUsdPayments = confirmedPayments.filter((row) => String(row.currency || '').toUpperCase() === 'USD')
  const taskRevenue = confirmedUsdPayments.reduce((sum, row) => sum + Number(row.amount || 0), 0)
  const confirmedUsdTrades = confirmedTrades.filter((row) => String(row.pnl_currency || '').toUpperCase() === 'USD')
  const tradePnl = confirmedUsdTrades.reduce((sum, row) => sum + Number(row.net_profit || 0), 0)
  const activity = useMemo(() => {
    const paymentRows = data.payments.map((p) => ({
      id: p.id, time: asTime(p, ['paid_at', 'created_at']), title: 'Task payment',
      subtitle: [p.source_app === 'quantum_lead_ai' ? 'Quantum Lead AI' : 'ArbiVault', p.provider, p.asset, p.network].filter(Boolean).join(' · '),
      status: p.status, amountLabel: money(p.amount, p.currency),
      proofLabel: p.tx_hash ? p.tx_hash.slice(0, 14) + '…' : p.provider_payment_id || 'Payment not verified',
      proofUrl: p.tx_hash && p.network ? (String(p.network).toLowerCase().includes('sol') ? 'https://solscan.io/tx/' + p.tx_hash : String(p.network).toLowerCase().includes('bitcoin') ? 'https://mempool.space/tx/' + p.tx_hash : /^0x/.test(p.tx_hash) ? 'https://etherscan.io/tx/' + p.tx_hash : null) : null,
      bucket: 'tasks',
    }))
    const taskRows = data.tasks.map((t) => ({
      id: t.id, time: asTime(t, ['updated_at', 'created_at']), title: t.title || 'Paid work task',
      subtitle: [t.source_app === 'quantum_lead_ai' ? 'Quantum Lead AI' : 'ArbiVault', t.description || 'Task record'].filter(Boolean).join(' · '), status: t.status,
      amountLabel: t.payment_confirmed_at ? money(t.price, t.currency) : 'Unpaid / unverified',
      proofLabel: t.payment_confirmed_at ? 'Payment timestamp recorded' : 'No confirmed payment',
      bucket: 'tasks',
    }))
    const opportunityRows = data.opportunities.map((o) => ({
      id: o.id, time: asTime(o, ['updated_at', 'discovered_at']), title: o.title,
      subtitle: [o.source_app === 'quantum_lead_ai' ? 'Quantum Lead AI' : 'ArbiVault', o.source, o.opportunity_type].filter(Boolean).join(' · '),
      status: o.status, amountLabel: 'Potential only: ' + money(o.estimated_value, 'USD'),
      proofLabel: o.compliance_status === 'eligible' ? 'Eligibility marked; payment not implied' : 'Not verified as paid',
      proofUrl: o.source_url || null, bucket: 'tasks',
    }))
    const tradeRows = data.trades.map((t) => ({
      id: t.id, time: asTime(t, ['confirmed_at', 'updated_at', 'created_at']),
      title: t.pair || 'Trading execution', subtitle: [t.source_app === 'quantum_lead_ai' ? 'Quantum Lead AI' : 'ArbiVault', t.chain, t.strategy, t.execution_mode].filter(Boolean).join(' · '),
      status: t.status, amountLabel: isConfirmedTrade(t) ? (t.pnl_currency ? 'Net P&L ' + money(t.net_profit, t.pnl_currency) : 'Net P&L ' + String(t.net_profit ?? '—') + ' (currency not set)') : 'Not confirmed',
      proofLabel: t.tx_hash ? t.tx_hash.slice(0, 16) + '…' : 'No transaction hash',
      proofUrl: t.explorer_url || null, bucket: 'trading',
    }))
    const runRows = data.runs.map((r) => ({
      id: r.id, time: asTime(r, ['completed_at', 'started_at']), title: r.workflow || 'Bot run',
      subtitle: [r.source_app === 'quantum_lead_ai' ? 'Quantum Lead AI' : 'ArbiVault', r.error ? 'Error: ' + r.error.slice(0, 120) : 'Execution telemetry; not revenue by itself'].join(' · '),
      status: r.status, amountLabel: 'Not revenue', proofLabel: 'Run ' + String(r.id).slice(0, 12), bucket: 'trading',
    }))
    return [...paymentRows, ...taskRows, ...opportunityRows, ...tradeRows, ...runRows].sort((a, b) => new Date(b.time || 0) - new Date(a.time || 0))
  }, [data])
  const visibleActivity = activity.filter((row) => tab === 'all' || row.bucket === tab)
  const taskLedger = activity.filter((row) => row.bucket === 'tasks')
  const tradingLedger = activity.filter((row) => row.bucket === 'trading')

  return <main className="min-h-screen bg-[#090A0F] p-4 text-[#e0e4f0] sm:p-6">
    <div className="mx-auto max-w-[1600px] space-y-5">
      <header className="flex flex-col gap-3 border-b border-[#232738] pb-4 sm:flex-row sm:items-end sm:justify-between">
        <div>
          <div className={MONO + ' text-[0.62rem] uppercase tracking-[0.2em] text-[#00F0FF]'}>ArbiVault + Quantum Lead AI / Mad Man</div>
          <h1 className="mt-2 text-2xl font-bold">Revenue Stream</h1>
          <p className={MONO + ' mt-2 max-w-3xl text-xs leading-5 ' + MUTED}>Live backend activity. Task income and trading P&amp;L are kept separate. Potential opportunities and unconfirmed executions never count as earned revenue.</p>
        </div>
        <div className="flex flex-wrap items-center gap-3">
          <span className={MONO + ' text-[0.62rem] ' + MUTED}>{loading ? 'LOADING' : 'LAST READ ' + date(lastUpdated)}</span>
          <button type="button" onClick={() => userId && load(userId)} className="rounded border border-[#232738] px-3 py-2 font-mono text-xs text-[#00F0FF] hover:border-[#00F0FF]">Refresh now</button>
          <Link to="/" className="rounded border border-[#232738] px-3 py-2 font-mono text-xs text-[#e0e4f0] hover:border-[#00F0FF]">Back to matrix</Link>
        </div>
      </header>

      <div className="flex flex-wrap gap-2 font-mono text-[0.62rem]">
        <span className={'rounded border px-3 py-2 ' + (sourceStatus.arbivault?.connected ? 'border-[#00FF87]/40 text-[#00FF87]' : 'border-[#FF4D4D]/40 text-[#FF4D4D]')}>ArbiVault: {sourceStatus.arbivault?.connected ? 'CONNECTED' : 'NOT CONNECTED'}</span>
        <span className={'rounded border px-3 py-2 ' + (sourceStatus.quantum?.connected ? 'border-[#00FF87]/40 text-[#00FF87]' : 'border-[#FFB84D]/40 text-[#FFB84D]')}>Quantum Lead AI: {sourceStatus.quantum?.connected ? 'CONNECTED' : 'NEEDS SERVER CREDENTIALS'}</span>
      </div>
      {error && <div role="alert" className="rounded border border-[#FFB84D]/50 bg-[#2a2010] p-3 font-mono text-xs text-[#ffcf83]">Source connection warning: {error}</div>}
      {sourceWarnings.length > 0 && <div className="rounded border border-[#FFB84D]/40 p-3 font-mono text-xs text-[#ffcf83]">Partial data warning: {sourceWarnings.join(' · ')}</div>}

      <div className="grid grid-cols-1 gap-3 sm:grid-cols-2 xl:grid-cols-4">
        <Metric label="Confirmed task payments" value={money(taskRevenue, 'USD')} note={confirmedUsdPayments.length + ' USD payment records marked paid with paid_at; other currencies excluded from total'} />
        <Metric label="Confirmed trading net P&L" value={money(tradePnl, 'USD')} note={confirmedUsdTrades.length + ' USD-denominated trades with confirmed status, timestamp and transaction hash; other currencies excluded'} />
        <Metric label="Open work opportunities" value={data.opportunities.filter((o) => ['new','qualified','contacted','contracted','in_progress'].includes(String(o.status).toLowerCase())).length.toLocaleString()} note="Opportunity count only; not revenue" />
        <Metric label="Recent bot execution runs" value={data.runs.length.toLocaleString()} note="Latest run records returned; run status is not proof of profit" />
      </div>

      <div className="grid grid-cols-1 gap-3 xl:grid-cols-2">
        <section className={PANEL + ' p-4'}>
          <div className={MONO + ' text-xs font-bold uppercase tracking-wider text-[#00F0FF]'}>Paid task ledger</div>
          <div className="mt-2 text-2xl font-bold">{money(taskRevenue, 'USD')}</div>
          <p className={MONO + ' mt-2 text-[0.62rem] leading-5 ' + MUTED}>Counts only payment records marked paid with a paid_at timestamp and currency = USD. Other currencies, estimates, and unpaid task prices are excluded from this total.</p>
        </section>
        <section className={PANEL + ' p-4'}>
          <div className={MONO + ' text-xs font-bold uppercase tracking-wider text-[#00F0FF]'}>Trading ledger</div>
          <div className="mt-2 text-2xl font-bold">{money(tradePnl, 'USD')}</div>
          <p className={MONO + ' mt-2 text-[0.62rem] leading-5 ' + MUTED}>Counts USD-denominated net_profit only for trades marked confirmed that also have a confirmation timestamp and transaction hash. Other currencies are excluded from the USD total; fees must already be included in stored net_profit.</p>
        </section>
      </div>

      <div className="flex flex-wrap gap-2">
        {[['all','All activity'],['tasks','Paid tasks'],['trading','Trading & bots']].map(([id, label]) => <button key={id} type="button" onClick={() => setTab(id)} className={'rounded border px-3 py-2 font-mono text-xs ' + (tab === id ? 'border-[#00F0FF] bg-[#00F0FF]/10 text-[#00F0FF]' : 'border-[#232738] text-[#8a90b0]')}>{label}</button>)}
      </div>

      {tab === 'tasks' ? <ActivityTable title="Paid tasks and opportunity activity" rows={taskLedger} kind="tasks" /> : tab === 'trading' ? <ActivityTable title="Trading executions and bot telemetry" rows={tradingLedger} kind="trading" /> : <ActivityTable title="Live activity stream" rows={visibleActivity} kind="all" />}

      <div className={PANEL + ' p-4'}>
        <div className={MONO + ' text-[0.62rem] font-bold uppercase tracking-wider text-[#FFB84D]'}>Verification rules</div>
        <ul className={MONO + ' mt-2 list-disc space-y-1 pl-5 text-[0.6rem] leading-5 ' + MUTED}>
          <li>ArbiVault changes trigger Supabase Realtime refreshes. Quantum Lead AI is checked periodically because it uses a separate Supabase project.</li>
          <li>Opportunity estimates, task prices, bot runs, quotes, and unconfirmed trades are not counted as revenue.</li>
          <li>Chain transactions are linked only when the stored record supplies a transaction hash and explorer URL.</li>
          <li>Quantum Lead AI data is joined by matching the signed-in email to an account in that project; its service-role key must remain server-side in the ArbiVault Edge Function secrets.</li>
          <li>Values are read from stored backend records; this screen does not initiate trades, submit tasks, or move funds.</li>
        </ul>
      </div>
    </div>
  </main>
}
