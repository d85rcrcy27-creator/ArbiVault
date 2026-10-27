import { useState } from 'react'
import { Link, useNavigate } from 'react-router-dom'
import UtilityBar from '@/components/arbitrage/UtilityBar'
import PulseMatrix from '@/components/arbitrage/PulseMatrix'
import SkillsCreator from '@/components/arbitrage/SkillsCreator'
import TradeLog from '@/components/arbitrage/TradeLog'
import SpreadDepthChart from '@/components/arbitrage/SpreadDepthChart'
import BotFleet from '@/components/arbitrage/BotFleet'
import WalletBootstrap from '@/components/arbitrage/WalletBootstrap'
import VerificationDashboard from '@/components/arbitrage/VerificationDashboard'
import RuntimeControls from '@/components/arbitrage/RuntimeControls'
import { useLiveMarketData } from '@/hooks/useLiveMarketData'
import { useIsMobile } from '@/hooks/use-mobile'

const TABS = [
  { id: 'matrix', label: 'Matrix' }, { id: 'trades', label: 'Trades' },
  { id: 'control', label: 'Trading Control' }, { id: 'skills', label: 'Skills' },
  { id: 'checks', label: 'System Checks' }, { id: 'wallets', label: 'Wallets' },
]

const PUBLIC_VENUES = [
  ['Binance', 'Public order books'], ['Bybit', 'Public order books'], ['OKX', 'Public order books'],
  ['Kraken', 'Public order books'], ['KuCoin', 'Public order books'], ['Gate.io', 'Public order books'],
  ['Coinbase', 'Public order books'], ['Bitget', 'Public order books'],
  ['Jupiter', 'Public Solana routing/quotes'], ['PancakeSwap', 'Public BNB RPC/quoter'],
  ['Uniswap', 'Public Ethereum RPC/quoter'], ['DexScreener', 'Public DEX market discovery'],
  ['CoinGecko', 'Public market pricing/volume'],
]

export default function Home() {
  const navigate = useNavigate()
  const isMobile = useIsMobile()
  const { routes, marketSnapshot, chainRpcHealth, signerHealth, testnetHealth, trades, globalLatency, livePnl, executeRoute, status, connected, engineStatus, engineStatusDetail, marketControls, setMarketControls, refreshMarket } = useLiveMarketData()
  const [selectedRoute, setSelectedRoute] = useState(null)
  const [mobileTab, setMobileTab] = useState('matrix')
  const activeRoute = routes.find((r) => r.id === selectedRoute) || routes[0] || null
  const depthPanel = activeRoute && <div className="rounded border border-[#232738] bg-[#0C0E16] p-4"><div className="mb-3 flex items-center justify-between"><span className="font-mono text-[0.6875rem] font-semibold uppercase tracking-wider text-[#8a90b0]">Spread Depth · {activeRoute.pair}</span><span className="font-mono text-[0.625rem] text-[#FFB800]">{activeRoute.spreadPct.toFixed(3)}%</span></div><div className="h-24 w-full"><SpreadDepthChart history={activeRoute.history} spread={activeRoute.spreadPct} /></div></div>
  const livePanel = <div className="rounded border border-[#232738] bg-[#0C0E16] p-4">
    <div className="mb-3 flex items-center justify-between">
      <div className="font-mono text-xs font-bold uppercase tracking-wider text-[#00F0FF]">Live Market Data</div>
      <div className="font-mono text-[0.6rem] uppercase text-[#00FF87]">{status} · {globalLatency ? globalLatency + 'ms' : '—'}</div>
    </div>
    <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
      {marketSnapshot.length ? marketSnapshot.map((s) => (
        <div key={s.chain + ':' + s.pair} className="rounded border border-[#232738] bg-[#090A0F] p-3">
          <div className="mb-2 flex items-center justify-between"><span className="font-mono text-xs font-semibold text-[#e0e4f0]">{s.pair}</span><span className="font-mono text-[0.55rem] uppercase text-[#5a6080]">{s.chain} · {s.quote_count} feeds</span></div>
          <div className="space-y-1">{(s.quotes || []).map((q) => <div key={q.exchange} className="flex items-center justify-between font-mono text-[0.6rem]"><span className="text-[#8a90b0]">{q.exchange.toUpperCase()}</span><span className="text-[#e0e4f0]">B {Number(q.bid).toFixed(4)} · A {Number(q.ask).toFixed(4)}</span><span className="text-[#5a6080]">{Number(q.latencyMs || 0)}ms</span></div>)}</div>
          <div className="mt-2 border-t border-[#1a1d2b] pt-2 font-mono text-[0.55rem] text-[#5a6080]">BEST BUY {s.best_buy ? Number(s.best_buy.price).toFixed(4) + ' @ ' + s.best_buy.exchange.toUpperCase() : '—'} · BEST SELL {s.best_sell ? Number(s.best_sell.price).toFixed(4) + ' @ ' + s.best_sell.exchange.toUpperCase() : '—'} · SPREAD {s.spread_pct == null ? '—' : Number(s.spread_pct).toFixed(3) + '%'}</div>
           {s.temporal_flux && <div className="mt-2 rounded border border-[#232738] bg-[#0C0E16] px-2 py-2 font-mono text-[0.55rem]">
             <div className="flex items-center justify-between"><span className="uppercase tracking-wider text-[#8a90b0]">Temporal flux · observed</span><span className={s.temporal_flux.status === 'expanding' ? 'text-[#00FF87]' : s.temporal_flux.status === 'decaying' ? 'text-[#FFB84D]' : 'text-[#8a90b0]'}>{String(s.temporal_flux.status || 'insufficient_history').replaceAll('_', ' ')}</span></div>
             <div className="mt-1 grid grid-cols-2 gap-1 text-[#8a90b0]">
               <span>Trend {s.temporal_flux.slope_pct_points_per_min == null ? '—' : Number(s.temporal_flux.slope_pct_points_per_min).toFixed(4) + ' pp/min'}</span>
               <span>Positive {s.temporal_flux.positive_spread_ratio == null ? '—' : Math.round(Number(s.temporal_flux.positive_spread_ratio) * 100) + '%'}</span>
               <span>Rotation {s.temporal_flux.route_rotation_count ?? '—'} changes</span>
               <span>History {s.temporal_flux.confidence || 'insufficient'}</span>
               <span>Feed latency {s.temporal_flux.median_feed_latency_ms == null ? '—' : Math.round(Number(s.temporal_flux.median_feed_latency_ms)) + 'ms'}</span>
               <span>Decay {s.temporal_flux.estimated_decay_to_zero_seconds == null ? '—' : Math.round(Number(s.temporal_flux.estimated_decay_to_zero_seconds)) + 's to zero'}</span>
             </div>
              <div className="mt-1 text-[#5a6080]">Collector timestamps only; this signal prioritizes route checks, not profit probability or trade authorization.</div>
           </div>}
        </div>
      )) : <div className="sm:col-span-2 rounded border border-[#232738] bg-[#090A0F] p-4 text-center font-mono text-[0.65rem] text-[#5a6080]">Waiting for live quote feeds…</div>}
    </div>
    <div className="mt-3 grid gap-3 md:grid-cols-2">
      <div className="rounded border border-[#232738] bg-[#090A0F] p-3">
        <div className="mb-2 font-mono text-[0.55rem] font-semibold uppercase tracking-wider text-[#5a6080]">Chain RPC Health</div>
        <div className="grid grid-cols-2 gap-2">{chainRpcHealth.length ? chainRpcHealth.map((r) => <div key={r.chain} className="flex items-center justify-between font-mono text-[0.58rem]"><span className="text-[#8a90b0]">{r.chain.toUpperCase()}</span><span className={r.ok ? 'text-[#00FF87]' : 'text-[#FF4D4D]'}>{r.ok ? 'LIVE' : 'DOWN'} · {Number(r.latencyMs || 0)}ms</span></div>) : <span className="font-mono text-[0.58rem] text-[#5a6080]">Waiting for RPC checks…</span>}</div>
      </div>
      <div className="rounded border border-[#232738] bg-[#090A0F] p-3">
        <div className="mb-2 font-mono text-[0.55rem] font-semibold uppercase tracking-wider text-[#5a6080]">Signer Health</div>
        <div className="grid grid-cols-2 gap-2">{signerHealth.length ? signerHealth.map((s) => <div key={s.chain} className="flex items-center justify-between font-mono text-[0.58rem]"><span className="text-[#8a90b0]">{s.chain.toUpperCase()}</span><span className={s.healthy ? 'text-[#00FF87]' : 'text-[#FF4D4D]'}>{s.healthy ? 'READY' : 'NOT READY'}</span></div>) : <span className="font-mono text-[0.58rem] text-[#5a6080]">Waiting for signer checks…</span>}</div>
      </div>
      <div className="rounded border border-[#232738] bg-[#090A0F] p-3">
        <div className="mb-2 font-mono text-[0.55rem] font-semibold uppercase tracking-wider text-[#5a6080]">Testnet Backend · BSC 97</div>
        <div className="flex items-center justify-between font-mono text-[0.58rem]"><span className="text-[#8a90b0]">RPC STATUS</span><span className={testnetHealth?.ok ? 'text-[#00FF87]' : 'text-[#FF4D4D]'}>{testnetHealth?.ok ? 'LIVE' : testnetHealth ? 'DOWN' : 'WAITING'}</span></div>
        <div className="mt-1 font-mono text-[0.58rem] text-[#e0e4f0]">LATEST BLOCK {Number.isFinite(Number(testnetHealth?.latest_block_number)) ? Number(testnetHealth.latest_block_number).toLocaleString() : '—'}</div>
        <div className="mt-1 font-mono text-[0.5rem] uppercase text-[#5a6080]">READ-ONLY PROBE · {testnetHealth?.transaction_broadcast_tested ? 'Broadcast tested' : 'No test transaction sent'}</div>
        <div className="mt-1 font-mono text-[0.5rem] text-[#5a6080]">{testnetHealth?.recorded_at ? new Date(testnetHealth.recorded_at).toLocaleTimeString() : ''}</div>
      </div>
    </div>
  </div>
  return <div className="min-h-screen bg-[#090A0F] text-[#e0e4f0]">
    <UtilityBar globalLatency={globalLatency} livePnl={livePnl} engineStatus={engineStatus} engineStatusDetail={engineStatusDetail} status={status} connected={connected} onOpenWallets={() => navigate('/wallets')} />

    <nav aria-label="Tools" className="grid grid-cols-1 gap-2 px-4 pt-4 sm:grid-cols-3">
      <Link to="/revenue-stream" className="rounded border border-[#232738] bg-[#0C0E16] p-3 hover:border-[#00F0FF]"><span className="block font-mono text-xs font-semibold uppercase tracking-wider text-[#00F0FF]">Mad Man Revenue Stream</span><span className="mt-1 block text-xs text-[#8a90b0]">Live paid-task activity and a separate confirmed-trading ledger</span></Link>
      <Link to="/flash-loans" className="rounded border border-[#232738] bg-[#0C0E16] p-3 hover:border-[#00F0FF]"><span className="block font-mono text-xs font-semibold uppercase tracking-wider text-[#00F0FF]">Flash Loan Explorer</span><span className="mt-1 block text-xs text-[#8a90b0]">Review recorded borrow, repayment and profit data</span></Link>
      <Link to="/key-backup" className="rounded border border-[#232738] bg-[#0C0E16] p-3 hover:border-[#00F0FF]"><span className="block font-mono text-xs font-semibold uppercase tracking-wider text-[#00F0FF]">Wallet Key Backup</span><span className="mt-1 block text-xs text-[#8a90b0]">Review secure backup and recovery guidance</span></Link>
    </nav>
    <div className="px-4 pt-4"><div className="max-w-xl rounded border border-[#232738] bg-[#0C0E16] p-4">
      <div className="mb-3 flex items-center justify-between"><div className="font-mono text-xs font-bold uppercase tracking-wider text-[#00F0FF]">Public Venue Feeds</div><div className="font-mono text-[0.55rem] uppercase text-[#00FF87]">MARKET DATA FEEDS</div></div>
      <div className="grid grid-cols-2 gap-2 sm:grid-cols-3">{PUBLIC_VENUES.map(([name, kind]) => <div key={name} className="rounded border border-[#232738] bg-[#090A0F] px-2.5 py-2"><div className="font-mono text-[0.62rem] font-semibold text-[#e0e4f0]">{name}</div><div className="mt-1 font-mono text-[0.48rem] uppercase tracking-wider text-[#5a6080]">{kind}</div></div>)}</div>
    </div></div>
    <div className="px-4 pt-4"><WalletBootstrap /></div>
    <div className="px-4 pt-4"><RuntimeControls controls={marketControls} latency={globalLatency} status={status} onChange={setMarketControls} onRefresh={refreshMarket} /></div>
    <div className="px-4 pt-4">{livePanel}</div>
    {isMobile ? <div className="flex flex-col gap-3 p-3">
      <div className="flex gap-1 overflow-x-auto rounded border border-[#232738] bg-[#0C0E16] p-1">{TABS.map((tab) => <button key={tab.id} onClick={() => tab.id === 'wallets' ? navigate('/wallets') : setMobileTab(tab.id)} className={`min-w-20 flex-1 rounded py-1.5 font-mono text-[0.6875rem] font-semibold uppercase tracking-wider ${mobileTab === tab.id ? 'bg-[#00F0FF]/10 text-[#00F0FF]' : 'text-[#5a6080]'}`}>{tab.label}</button>)}</div>
      {mobileTab === 'matrix' && <><div className="h-[22rem]"><PulseMatrix routes={routes} selectedRoute={activeRoute?.id} onSelectRoute={setSelectedRoute} minimumSpreadPct={marketControls.minSpreadPct} /></div>{depthPanel}</>}
      {mobileTab === 'trades' && <div className="h-[26rem]"><TradeLog trades={trades} /></div>}
      {mobileTab === 'control' && <div className="space-y-3"><BotFleet /><div className="h-[32rem]"><SkillsCreator routes={routes} onExecute={executeRoute} minimumSpreadPct={marketControls.minSpreadPct} /></div><div className="h-[26rem]"><TradeLog trades={trades} /></div></div>}
      {mobileTab === 'skills' && <div className="h-[32rem]"><SkillsCreator routes={routes} onExecute={executeRoute} minimumSpreadPct={marketControls.minSpreadPct} /></div>}
      {mobileTab === 'checks' && <VerificationDashboard routes={routes} marketSnapshot={marketSnapshot} chainRpcHealth={chainRpcHealth} signerHealth={signerHealth} testnetHealth={testnetHealth} onRefresh={refreshMarket} onOpenWallets={() => navigate('/wallets')} />}
    </div> : <div className="space-y-4 p-4">
      <div className="flex gap-1 overflow-x-auto rounded border border-[#232738] bg-[#0C0E16] p-1">{TABS.map((tab) => <button key={tab.id} onClick={() => tab.id === 'wallets' ? navigate('/wallets') : setMobileTab(tab.id)} className={`min-w-20 flex-1 rounded px-2 py-1.5 font-mono text-[0.6875rem] font-semibold uppercase tracking-wider ${mobileTab === tab.id ? 'bg-[#00F0FF]/10 text-[#00F0FF]' : 'text-[#5a6080]'}`}>{tab.label}</button>)}</div>
      {mobileTab === 'control' ? <div className="space-y-4"><BotFleet /><div className="grid grid-cols-1 gap-4 lg:grid-cols-2"><div className="h-[34rem]"><SkillsCreator routes={routes} onExecute={executeRoute} minimumSpreadPct={marketControls.minSpreadPct} /></div><div className="h-[34rem]"><TradeLog trades={trades} /></div></div></div> : <>
        <VerificationDashboard routes={routes} marketSnapshot={marketSnapshot} chainRpcHealth={chainRpcHealth} signerHealth={signerHealth} testnetHealth={testnetHealth} onRefresh={refreshMarket} onOpenWallets={() => navigate('/wallets')} />
        <div className="grid grid-cols-1 gap-4 lg:grid-cols-12"><div className="flex flex-col gap-4 lg:col-span-5"><div className="h-[26rem]"><PulseMatrix routes={routes} selectedRoute={activeRoute?.id} onSelectRoute={setSelectedRoute} minimumSpreadPct={marketControls.minSpreadPct} /></div>{depthPanel}</div><div className="h-[34rem] lg:col-span-4"><TradeLog trades={trades} /></div><div className="h-[34rem] lg:col-span-3"><SkillsCreator routes={routes} onExecute={executeRoute} minimumSpreadPct={marketControls.minSpreadPct} /></div></div>
      </>}
    </div>}
  </div>
}
