import { useState } from 'react'
import { Activity, CheckCircle2, CircleAlert, RefreshCw, Wallet } from 'lucide-react'

function CheckRow({ label, detail, state }) {
  const good = state === 'pass'
  const waiting = state === 'waiting'
  const Icon = good ? CheckCircle2 : CircleAlert
  return <div className="flex items-start gap-2 border-b border-[#232738] py-2 last:border-0">
    <Icon className={`mt-0.5 h-4 w-4 shrink-0 ${good ? 'text-[#00FF87]' : waiting ? 'text-[#8a90b0]' : 'text-[#FFB800]'}`} />
    <div className="min-w-0 flex-1"><div className="font-mono text-[0.65rem] font-semibold uppercase text-[#e0e4f0]">{label}</div><div className="mt-0.5 text-[0.62rem] leading-relaxed text-[#8a90b0]">{detail}</div></div>
    <span className={`font-mono text-[0.52rem] uppercase ${good ? 'text-[#00FF87]' : waiting ? 'text-[#8a90b0]' : 'text-[#FFB800]'}`}>{good ? 'Pass' : waiting ? 'Waiting' : 'Check'}</span>
  </div>
}

export default function VerificationDashboard({ routes = [], marketSnapshot = [], chainRpcHealth = [], signerHealth = [], testnetHealth, onRefresh, onOpenWallets }) {
  const [refreshing, setRefreshing] = useState(false)
  const quoteCount = marketSnapshot.reduce((sum, item) => sum + Number(item.quote_count || 0), 0)
  const rpcReady = chainRpcHealth.length > 0 && chainRpcHealth.every((item) => item.ok === true)
  const signerReady = signerHealth.length > 0 && signerHealth.every((item) => item.healthy === true)
  const signerBlockers = signerHealth.filter((item) => item.healthy !== true).map((item) => `${String(item.chain || 'unknown').toUpperCase()}: ${String(item.reason || 'health_not_verified').replaceAll('_', ' ')}`)
  const bscMainnetHealth = chainRpcHealth.find((item) => item.chain === 'bnb')
  const hasQuotes = marketSnapshot.length > 0 && marketSnapshot.every((item) => Array.isArray(item.quotes) && item.quotes.length > 0)
  const handleRefresh = async () => {
    if (!onRefresh || refreshing) return
    setRefreshing(true)
    try { await onRefresh() } finally { setRefreshing(false) }
  }
  return <section className="rounded border border-[#232738] bg-[#0C0E16] p-4">
    <div className="mb-3 flex flex-wrap items-start justify-between gap-3">
      <div><div className="flex items-center gap-2 font-mono text-xs font-bold uppercase tracking-wider text-[#00F0FF]"><Activity className="h-4 w-4" /> System Checks & Verified Actions</div><p className="mt-1 max-w-3xl text-[0.65rem] leading-relaxed text-[#8a90b0]">Live status from the connected app runtime. A passing connectivity check does not certify profitability or authorize a transaction.</p></div>
      <button type="button" onClick={handleRefresh} disabled={refreshing} className="inline-flex items-center gap-1.5 rounded border border-[#232738] px-3 py-2 font-mono text-[0.58rem] uppercase text-[#8a90b0] disabled:opacity-50"><RefreshCw className={`h-3 w-3 ${refreshing ? 'animate-spin' : ''}`} /> Refresh checks</button>
    </div>
    <div className="grid gap-4 lg:grid-cols-2">
      <div className="rounded border border-[#232738] bg-[#090A0F] p-3">
        <div className="mb-1 font-mono text-[0.58rem] uppercase tracking-wider text-[#8a90b0]">Connection checks</div>
        <CheckRow label="Market quotes" state={hasQuotes ? 'pass' : 'check'} detail={hasQuotes ? `${marketSnapshot.length} market pairs · ${quoteCount} reported feeds. Quotes are current observations, not guaranteed executable prices.` : 'No complete quote set is currently available.'} />
        <CheckRow label="Chain RPC endpoints" state={rpcReady ? 'pass' : chainRpcHealth.length ? 'check' : 'waiting'} detail={rpcReady ? `${chainRpcHealth.length} reported chain endpoints responded successfully.` : 'At least one endpoint is down or has not returned a health result.'} />
        <CheckRow label="Signer adapter health" state={signerReady ? 'pass' : signerHealth.length ? 'check' : 'waiting'} detail={signerReady ? 'All listed signer adapters passed the runtime policy checks; this does not authorize a transaction by itself.' : signerHealth.length ? `Not ready: ${signerBlockers.join('; ') || 'one or more adapters are blocked'}. Signing stays disabled until the actual wallet, key binding, and adapter policy pass.` : 'No signer health result has been returned by the runtime yet.'} />
        <CheckRow label="BSC mainnet RPC (chain 56)" state={bscMainnetHealth?.ok ? 'pass' : bscMainnetHealth ? 'check' : 'waiting'} detail={bscMainnetHealth?.ok ? `Mainnet RPC responded via ${bscMainnetHealth.provider || 'configured provider'} in ${Number(bscMainnetHealth.latencyMs || 0)} ms. Read-only connectivity only; signer health is checked separately.` : bscMainnetHealth ? `Mainnet RPC check failed: ${bscMainnetHealth.last_error || 'provider unavailable'}.` : 'No BSC mainnet RPC result has been returned yet.'} />
      </div>
      <div className="rounded border border-[#232738] bg-[#090A0F] p-3">
        <div className="mb-1 font-mono text-[0.58rem] uppercase tracking-wider text-[#8a90b0]">Available operational actions</div>
        <div className="flex items-start gap-2 border-b border-[#232738] py-3"><CheckCircle2 className="mt-0.5 h-4 w-4 shrink-0 text-[#8a90b0]" /><div><div className="font-mono text-[0.65rem] font-semibold uppercase text-[#e0e4f0]">Refresh runtime checks</div><p className="mt-0.5 text-[0.62rem] text-[#8a90b0]">Re-query the app's current market and health state.</p><button type="button" onClick={handleRefresh} disabled={refreshing} className="mt-2 rounded border border-[#232738] px-2.5 py-1.5 font-mono text-[0.55rem] uppercase text-[#00F0FF] disabled:opacity-50">{refreshing ? 'Refreshing…' : 'Run checks'}</button></div></div>
        <div className="flex items-start gap-2 border-b border-[#232738] py-3"><Wallet className="mt-0.5 h-4 w-4 shrink-0 text-[#8a90b0]" /><div><div className="font-mono text-[0.65rem] font-semibold uppercase text-[#e0e4f0]">Open wallet verification</div><p className="mt-0.5 text-[0.62rem] text-[#8a90b0]">Review wallet records and their recorded verification metadata. This does not reveal signing secrets.</p><button type="button" onClick={onOpenWallets} className="mt-2 rounded border border-[#232738] px-2.5 py-1.5 font-mono text-[0.55rem] uppercase text-[#00F0FF]">Open wallets</button></div></div>
        <div className="py-3"><div className="font-mono text-[0.65rem] font-semibold uppercase text-[#e0e4f0]">Route candidates</div><p className="mt-0.5 text-[0.62rem] text-[#8a90b0]">{routes.length} route candidates are currently present in the runtime. Review them in Matrix; no transaction is sent by this count.</p></div>
      </div>
    </div>
  </section>
}
