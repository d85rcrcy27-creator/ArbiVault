import { useCallback, useEffect, useState } from 'react'
import { Link } from 'react-router-dom'
import { ArrowLeft, ExternalLink, RefreshCw, ShieldAlert } from 'lucide-react'
import { supabase } from '@/lib/supabase'

const FIELDS = 'id,chain,strategy,pair,borrowed_amount,notional_amount,gross_profit,fees_paid,net_profit,network_fee_usd,estimated_network_fee_usd,flash_loan_fee_usd,x402_resource_fee_usd,pnl_currency,fee_breakdown,status,execution_mode,tx_hash,explorer_url,metadata,created_at,confirmed_at'

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
  const [routes, setRoutes] = useState([])
  const [routesError, setRoutesError] = useState('')

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
      const { data: routeData, error: routeError } = await supabase
        .from('arbivault_strategy_routes')
        .select('id,strategy,strategy_family,chain,pair,dex_venue,route_type,enabled,discovery_only,builder_enabled,transaction_builder')
        .in('route_type', ['flash_liquidity', 'dex_cex', 'cyclic', 'multi_venue'])
        .order('chain', { ascending: true })
        .order('pair', { ascending: true })
        .limit(200)
      if (routeError) {
        setRoutes([])
        setRoutesError('Strategy routes could not be loaded: ' + routeError.message)
      } else {
        setRoutes(routeData || [])
        setRoutesError('')
      }
      setLastUpdated(new Date())
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Could not load flash-loan records.')
      setRows([])
      setRoutes([])
      setRoutesError('Could not load strategy route configuration.')
    } finally {
      setLoading(false)
    }
  }, [])

  useEffect(() => { load() }, [load])

  const feeBreakdown = (trade) => {
    if (trade.fee_breakdown && typeof trade.fee_breakdown === 'object') return trade.fee_breakdown
    return trade.metadata && typeof trade.metadata === 'object' ? trade.metadata : {}
  }
  const settlementEvidenceBacked = (trade) => {
    const fees = feeBreakdown(trade)
    const basis = String(fees.pnl_basis || '')
    return Boolean(trade.tx_hash) &&
      String(trade.status || '').toLowerCase() === 'executed' &&
      basis.startsWith('confirmed_flash_loan_settled_event') &&
      trade.gross_profit != null &&
      trade.flash_loan_fee_usd != null &&
      trade.network_fee_usd != null &&
      trade.net_profit != null
  }
  const profitEvidenceLabel = (trade) => {
    if (settlementEvidenceBacked(trade)) return 'Settlement + actual fee evidence'
    if (trade.net_profit == null) return 'Net profit not recorded'
    return 'Not evidence-verified'
  }
  const totalNet = rows.reduce((sum, row) => sum + (settlementEvidenceBacked(row) && Number.isFinite(Number(row.net_profit)) ? Number(row.net_profit) : 0), 0)
  const evidenceBackedCount = rows.filter(settlementEvidenceBacked).length
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
          <section className="rounded border border-[#232738] bg-[#0C0E16] p-4"><p className="font-mono text-[10px] uppercase text-[#8a90b0]">Evidence-backed net profit</p><p className="mt-2 text-2xl font-mono">{loading ? '…' : formatAmount(totalNet)}</p><p className="mt-1 text-[10px] text-[#5a6080]">USD only; counts rows with settlement-event and actual fee evidence ({evidenceBackedCount}).</p></section>
        </div>

        {error && <div role="alert" className="rounded border border-red-500/40 bg-red-950/20 p-4 text-sm text-red-200">{error}</div>}
        <section className="overflow-hidden rounded border border-[#232738] bg-[#0C0E16]">
          <div className="flex items-center justify-between border-b border-[#232738] px-4 py-3"><h2 className="font-mono text-xs font-semibold uppercase tracking-wider">Trade ledger</h2><span className="font-mono text-[10px] text-[#5a6080]">{lastUpdated ? 'Updated ' + lastUpdated.toLocaleTimeString() : 'Not yet updated'}</span></div>
          {loading ? <p className="p-6 text-sm text-[#8a90b0]">Loading real trade records…</p> : rows.length === 0 ? <div className="p-8 text-center"><ShieldAlert className="mx-auto mb-3 text-[#8a90b0]" size={24} /><p className="text-sm">No flash-loan trade records found for this account.</p><p className="mt-2 text-xs text-[#5a6080]">No sample rows are shown. Records appear when the execution pipeline writes them to Supabase.</p></div> : <div className="overflow-x-auto"><table className="w-full min-w-[1450px] text-left text-xs"><thead className="bg-[#090A0F] font-mono uppercase text-[#8a90b0]"><tr>{['Time / chain','Strategy / pair','Borrowed','Repayment','Gross profit','Network fee','Flash premium','x402 cost','Net profit / evidence','Status','Transaction'].map((h) => <th key={h} className="px-4 py-3 font-medium">{h}</th>)}</tr></thead><tbody>{rows.map((trade) => <tr key={trade.id} className="border-t border-[#232738] align-top"><td className="px-4 py-3"><div>{trade.created_at ? new Date(trade.created_at).toLocaleString() : '—'}</div><div className="mt-1 uppercase text-[#5a6080]">{trade.chain || '—'}</div></td><td className="px-4 py-3"><div>{trade.strategy || '—'}</div><div className="mt-1 text-[#8a90b0]">{trade.pair || '—'}</div></td><td className="px-4 py-3 font-mono">{formatAmount(trade.borrowed_amount)}</td><td className="px-4 py-3"><span className={repaymentLabel(trade) === 'Repaid' ? 'text-[#00FF87]' : 'text-[#FFB800]'}>{repaymentLabel(trade)}</span></td><td className="px-4 py-3 font-mono">{settlementEvidenceBacked(trade) ? formatAmount(trade.gross_profit) : 'Unverified'}</td><td className="px-4 py-3 font-mono">{trade.network_fee_usd == null ? (trade.estimated_network_fee_usd == null ? 'Unknown' : 'Est. ' + formatAmount(trade.estimated_network_fee_usd)) : formatAmount(trade.network_fee_usd)}</td><td className="px-4 py-3 font-mono">{trade.flash_loan_fee_usd == null ? 'Unknown' : formatAmount(trade.flash_loan_fee_usd)}</td><td className="px-4 py-3 font-mono">{formatAmount(trade.x402_resource_fee_usd ?? 0)}</td><td className="px-4 py-3 font-mono"><div>{settlementEvidenceBacked(trade) ? formatAmount(trade.net_profit) : 'Unverified'}</div><div className="mt-1 max-w-[180px] text-[10px] leading-4 text-[#8a90b0]">{profitEvidenceLabel(trade)}</div></td><td className="px-4 py-3"><div>{trade.status || '—'}</div><div className="mt-1 text-[#5a6080]">{trade.execution_mode || '—'}</div></td><td className="px-4 py-3">{trade.explorer_url ? <a className="inline-flex items-center gap-1 text-[#00F0FF] hover:underline" href={trade.explorer_url} target="_blank" rel="noreferrer">{trade.tx_hash ? trade.tx_hash.slice(0, 12) + '…' : 'Open explorer'} <ExternalLink size={12} /></a> : trade.tx_hash ? <span className="font-mono text-[#8a90b0]">{trade.tx_hash.slice(0, 16)}…</span> : 'No tx hash recorded'}</td></tr>)}</tbody></table></div>}
        </section>
        <section className="overflow-hidden rounded border border-[#232738] bg-[#0C0E16]">
          <div className="border-b border-[#232738] px-4 py-3">
            <h2 className="font-mono text-xs font-semibold uppercase tracking-wider">Liquidity pairs & atomic-builder route registry</h2>
            <p className="mt-2 text-xs text-[#8a90b0]">Live route configuration from Supabase. Pool contract addresses and live reserves are not stored in this registry, so they are not guessed or presented as verified liquidity.</p>
          </div>
          {routesError && <div role="alert" className="border-b border-red-500/30 px-4 py-3 text-xs text-red-200">{routesError}</div>}
          {routes.length === 0 ? <p className="p-6 text-sm text-[#8a90b0]">No route configuration is available for this account.</p> : <div className="overflow-x-auto"><table className="w-full min-w-[1050px] text-left text-xs"><thead className="bg-[#090A0F] font-mono uppercase text-[#8a90b0]"><tr>{['Chain / pair','Venue','Route type','Atomic / transaction builder','Route status','Pool evidence'].map((h) => <th key={h} className="px-4 py-3 font-medium">{h}</th>)}</tr></thead><tbody>{routes.map((route) => {
            const isFlash = route.route_type === 'flash_liquidity'
            const routeStatus = route.enabled && !route.discovery_only ? 'Enabled in registry' : route.discovery_only ? 'Discovery only' : 'Disabled'
            const builderStatus = route.transaction_builder ? (route.builder_enabled ? 'Configured in registry' : 'Builder disabled') : 'No builder assigned'
            return <tr key={route.id} className="border-t border-[#232738] align-top">
              <td className="px-4 py-3"><div className="uppercase">{route.chain || '—'}</div><div className="mt-1 font-mono text-[#00F0FF]">{route.pair || '—'}</div><div className="mt-1 text-[10px] text-[#5a6080]">{route.strategy || '—'}</div></td>
              <td className="px-4 py-3">{route.dex_venue || '—'}</td>
              <td className="px-4 py-3">{route.route_type || '—'}</td>
              <td className="px-4 py-3"><div>{route.transaction_builder || '—'}</div><div className={route.builder_enabled ? 'mt-1 text-[#00FF87]' : 'mt-1 text-[#FFB800]'}>{builderStatus}</div></td>
              <td className="px-4 py-3"><div>{routeStatus}</div><div className="mt-1 text-[#5a6080]">{route.enabled ? 'enabled=true' : 'enabled=false'}</div></td>
              <td className="px-4 py-3"><div>{isFlash ? 'Flash liquidity source' : 'DEX pair / route'}</div><div className="mt-1 text-[#8a90b0]">Pool address and reserves: not recorded</div></td>
            </tr>
          })}</tbody></table></div>}
          <p className="border-t border-[#232738] px-4 py-3 text-[11px] leading-5 text-[#8a90b0]">A configured builder does not prove that a route is executable. The transaction builder must resolve the live pool, validate chain and token addresses, estimate fees, and pass wallet, signer, and approval checks. This explorer does not enable strategies or broadcast transactions.</p>
        </section>
        <p className="text-[11px] leading-5 text-[#5a6080]">Repayment is shown as verified only when the stored record explicitly contains repayment evidence. A transaction hash and a positive profit field are not independently re-verified on-chain by this page.</p>
      </div>
    </main>
  )
}
