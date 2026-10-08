import { useState } from 'react'
import { useNavigate } from 'react-router-dom'
import UtilityBar from '@/components/arbitrage/UtilityBar'
import PulseMatrix from '@/components/arbitrage/PulseMatrix'
import SkillsCreator from '@/components/arbitrage/SkillsCreator'
import TradeLog from '@/components/arbitrage/TradeLog'
import SpreadDepthChart from '@/components/arbitrage/SpreadDepthChart'
import BotFleet from '@/components/arbitrage/BotFleet'
import WalletBootstrap from '@/components/arbitrage/WalletBootstrap'
import RuntimeControls from '@/components/arbitrage/RuntimeControls'
import { useLiveMarketData } from '@/hooks/useLiveMarketData'
import { useIsMobile } from '@/hooks/use-mobile'

const TABS = [
  { id: 'matrix', label: 'Matrix' }, { id: 'trades', label: 'Trades' },
  { id: 'skills', label: 'Skills' }, { id: 'bots', label: 'Bots' }, { id: 'wallets', label: 'Wallets' },
]

export default function Home() {
  const navigate = useNavigate()
  const isMobile = useIsMobile()
  const { routes, marketSnapshot, chainRpcHealth, signerHealth, trades, globalLatency, livePnl, executeRoute, status, connected, engineStatus, setEngineStatus, marketControls, setMarketControls, refreshMarket } = useLiveMarketData()
  const [selectedRoute, setSelectedRoute] = useState(null)
  const [mobileTab, setMobileTab] = useState('matrix')
  const toggleEngine = () => setEngineStatus((s) => s === 'ACTIVE' ? 'PAUSED' : 'ACTIVE')
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
            <div className="mb-2 flex items-center justify-between">
              <span className="font-mono text-xs font-semibold text-[#e0e4f0]">{s.pair}</span>
              <span className="font-mono text-[0.55rem] uppercase text-[#5a6080]">{s.chain} · {s.quote_count} feeds</span>
            </div>
            <div className="space-y-1">
              {(s.quotes || []).map((q) => (
                <div key={q.exchange} className="flex items-center justify-between font-mono text-[0.6rem]">
                  <span className="text-[#8a90b0]">{q.exchange.toUpperCase()}</span>
                  <span className="text-[#e0e4f0]">B {Number(q.bid).toFixed(4)} · A {Number(q.ask).toFixed(4)}</span>
                  <span className="text-[#5a6080]">{Number(q.latencyMs || 0)}ms</span>
                </div>
              ))}
            </div>
            <div className="mt-2 border-t border-[#1a1d2b] pt-2 font-mono text-[0.55rem] text-[#5a6080]">
              BEST BUY {s.best_buy ? Number(s.best_buy.price).toFixed(4) + ' @ ' + s.best_buy.exchange.toUpperCase() : '—'}
              {' · '}
              BEST SELL {s.best_sell ? Number(s.best_sell.price).toFixed(4) + ' @ ' + s.best_sell.exchange.toUpperCase() : '—'}
              {' · '}
              SPREAD {s.spread_pct == null ? '—' : Number(s.spread_pct).toFixed(3) + '%'}
            </div>
          </div>
        )) : (
          <div className="sm:col-span-2 rounded border border-[#232738] bg-[#090A0F] p-4 text-center font-mono text-[0.65rem] text-[#5a6080]">
            Waiting for live quote feeds…
          </div>
        )}
      </div>
      <div className="mt-3 grid gap-3 md:grid-cols-2">
        <div className="rounded border border-[#232738] bg-[#090A0F] p-3">
          <div className="mb-2 font-mono text-[0.55rem] font-semibold uppercase tracking-wider text-[#5a6080]">Chain RPC Health</div>
          <div className="grid grid-cols-2 gap-2">
            {chainRpcHealth.length ? chainRpcHealth.map((r) => (
              <div key={r.chain} className="flex items-center justify-between font-mono text-[0.58rem]">
                <span className="text-[#8a90b0]">{r.chain.toUpperCase()}</span>
                <span className={r.ok ? 'text-[#00FF87]' : 'text-[#FF4D4D]'}>{r.ok ? 'LIVE' : 'DOWN'} · {Number(r.latencyMs || 0)}ms</span>
              </div>
            )) : <span className="font-mono text-[0.58rem] text-[#5a6080]">Waiting for RPC checks…</span>}
          </div>
        </div>
        <div className="rounded border border-[#232738] bg-[#090A0F] p-3">
          <div className="mb-2 font-mono text-[0.55rem] font-semibold uppercase tracking-wider text-[#5a6080]">Signer Health</div>
          <div className="grid grid-cols-2 gap-2">
            {signerHealth.length ? signerHealth.map((s) => (
              <div key={s.chain} className="flex items-center justify-between font-mono text-[0.58rem]">
                <span className="text-[#8a90b0]">{s.chain.toUpperCase()}</span>
                <span className={s.healthy ? 'text-[#00FF87]' : 'text-[#FF4D4D]'}>{s.healthy ? 'READY' : 'NOT READY'}</span>
              </div>
            )) : <span className="font-mono text-[0.58rem] text-[#5a6080]">Waiting for signer checks…</span>}
          </div>
        </div>
      </div>
    </div>
  return <div className="min-h-screen bg-[#090A0F] text-[#e0e4f0]">
    <UtilityBar globalLatency={globalLatency} livePnl={livePnl} engineStatus={engineStatus} onToggleEngine={toggleEngine} status={status} connected={connected} onOpenWallets={() => navigate('/wallets')} />
    <div className="px-4 pt-4"><WalletBootstrap /></div>
    <div className="px-4 pt-4"><RuntimeControls controls={marketControls} latency={globalLatency} status={status} onChange={setMarketControls} onRefresh={refreshMarket} /></div>
    <div className="px-4 pt-4">{livePanel}</div>
    {isMobile ? <div className="flex flex-col gap-3 p-3"><div className="flex gap-1 overflow-x-auto rounded border border-[#232738] bg-[#0C0E16] p-1">{TABS.map((tab) => <button key={tab.id} onClick={() => tab.id === 'wallets' ? navigate('/wallets') : setMobileTab(tab.id)} className={`min-w-20 flex-1 rounded py-1.5 font-mono text-[0.6875rem] font-semibold uppercase tracking-wider ${mobileTab === tab.id ? 'bg-[#00F0FF]/10 text-[#00F0FF]' : 'text-[#5a6080]'}`}>{tab.label}</button>)}</div>
      {mobileTab === 'matrix' && <><div className="h-[22rem]"><PulseMatrix routes={routes} selectedRoute={activeRoute?.id} onSelectRoute={setSelectedRoute} /></div>{depthPanel}</>}
      {mobileTab === 'trades' && <div className="h-[26rem]"><TradeLog trades={trades} /></div>}
      {mobileTab === 'skills' && <div className="h-[32rem]"><SkillsCreator routes={routes} onExecute={executeRoute} /></div>}
      {mobileTab === 'bots' && <BotFleet />}
    </div> : <div className="space-y-4 p-4"><BotFleet /><div className="grid grid-cols-1 gap-4 lg:grid-cols-12"><div className="flex flex-col gap-4 lg:col-span-5"><div className="h-[26rem]"><PulseMatrix routes={routes} selectedRoute={activeRoute?.id} onSelectRoute={setSelectedRoute} /></div>{depthPanel}</div><div className="h-[34rem] lg:col-span-4"><TradeLog trades={trades} /></div><div className="h-[34rem] lg:col-span-3"><SkillsCreator routes={routes} onExecute={executeRoute} /></div></div></div>}
  </div>
}
