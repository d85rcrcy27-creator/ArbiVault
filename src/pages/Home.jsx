import { useState } from 'react';
import UtilityBar from '@/components/arbitrage/UtilityBar';
import PulseMatrix from '@/components/arbitrage/PulseMatrix';
import SkillsCreator from '@/components/arbitrage/SkillsCreator';
import TradeLog from '@/components/arbitrage/TradeLog';
import SpreadDepthChart from '@/components/arbitrage/SpreadDepthChart';
import { useLiveMarketData } from '@/hooks/useLiveMarketData';
import { useIsMobile } from '@/hooks/use-mobile';

const TABS = [
  { id: 'matrix', label: 'Matrix' },
  { id: 'trades', label: 'Trades' },
  { id: 'skills', label: 'Skills' },
];

export default function Home() {
  const isMobile = useIsMobile();
  const {
    routes,
    trades,
    globalLatency,
    sessionPnL,
    executeRoute,
    status,
    connected,
    engineStatus,
    setEngineStatus,
  } = useLiveMarketData();
  const [selectedRoute, setSelectedRoute] = useState(null);
  const [mobileTab, setMobileTab] = useState('matrix');

  const toggleEngine = () => setEngineStatus((s) => (s === 'ACTIVE' ? 'PAUSED' : 'ACTIVE'));
  const activeRoute = routes.find((r) => r.id === selectedRoute) || routes[0] || null;

  const depthPanel = activeRoute && (
    <div className="rounded border border-[#232738] bg-[#0C0E16] p-4">
      <div className="mb-3 flex items-center justify-between">
        <span className="font-mono text-[0.6875rem] font-semibold uppercase tracking-wider text-[#8a90b0]">
          Spread Depth · {activeRoute.pair}
        </span>
        <span className="font-mono text-[0.625rem] text-[#FFB800]">{activeRoute.spreadPct.toFixed(3)}%</span>
      </div>
      <div className="h-24 w-full">
        <SpreadDepthChart history={activeRoute.history} spread={activeRoute.spreadPct} />
      </div>
    </div>
  );

  return (
    <div className="min-h-screen bg-[#090A0F] text-[#e0e4f0]">
      <UtilityBar
        globalLatency={globalLatency}
        sessionPnL={sessionPnL}
        engineStatus={engineStatus}
        onToggleEngine={toggleEngine}
        status={status}
        connected={connected}
      />

      {isMobile ? (
        <div className="flex flex-col gap-3 p-3">
          <div className="flex gap-1 rounded border border-[#232738] bg-[#0C0E16] p-1">
            {TABS.map((tab) => (
              <button
                key={tab.id}
                onClick={() => setMobileTab(tab.id)}
                className={`flex-1 rounded py-1.5 font-mono text-[0.6875rem] font-semibold uppercase tracking-wider transition-colors ${
                  mobileTab === tab.id ? 'bg-[#00F0FF]/10 text-[#00F0FF]' : 'text-[#5a6080]'
                }`}
              >
                {tab.label}
              </button>
            ))}
          </div>

          {mobileTab === 'matrix' && (
            <>
              <div className="h-[22rem]">
                <PulseMatrix routes={routes} selectedRoute={activeRoute?.id} onSelectRoute={setSelectedRoute} />
              </div>
              {depthPanel}
            </>
          )}
          {mobileTab === 'trades' && (
            <div className="h-[26rem]">
              <TradeLog trades={trades} />
            </div>
          )}
          {mobileTab === 'skills' && (
            <div className="h-[32rem]">
              <SkillsCreator routes={routes} onExecute={executeRoute} />
            </div>
          )}
        </div>
      ) : (
        <div className="grid grid-cols-1 gap-4 p-4 lg:grid-cols-12">
          <div className="flex flex-col gap-4 lg:col-span-5">
            <div className="h-[26rem]">
              <PulseMatrix routes={routes} selectedRoute={activeRoute?.id} onSelectRoute={setSelectedRoute} />
            </div>
            {depthPanel}
          </div>
          <div className="h-[34rem] lg:col-span-4">
            <TradeLog trades={trades} />
          </div>
          <div className="h-[34rem] lg:col-span-3">
            <SkillsCreator routes={routes} onExecute={executeRoute} />
          </div>
        </div>
      )}
    </div>
  );
}
