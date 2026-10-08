import { Activity, TrendingUp, Cpu, Zap } from 'lucide-react';

const FEEDS = [
  { id: 'binance', name: 'BIN' },
  { id: 'bybit', name: 'BYB' },
  { id: 'okx', name: 'OKX' },
  { id: 'kraken', name: 'KRK' },
  { id: 'kucoin', name: 'KUC' },
  { id: 'gateio', name: 'GAT' },
];

export default function UtilityBar({ globalLatency, livePnl = 0, engineStatus, onToggleEngine, status, connected, onOpenWallets }) {
  const latencyColor = globalLatency === 0 ? 'text-[#5a6080]' : globalLatency < 60 ? 'text-[#00FF87]' : globalLatency < 120 ? 'text-[#FFB800]' : 'text-[#FF4D4D]';
  const pnlPositive = Number(livePnl) >= 0;

  return (
    <header className="sticky top-0 z-30 border-b border-[#232738] bg-[#090A0F]/95 backdrop-blur">
      <div className="flex items-center justify-between gap-4 px-4 py-3 md:px-6">
        <div className="flex items-center gap-3">
          <div className="flex items-center gap-2">
            <div className="relative flex h-2.5 w-2.5">
              <span className={`absolute inline-flex h-full w-full rounded-full bg-[#00F0FF] opacity-60 ${status === 'live' ? 'animate-pulse-ping' : ''}`} />
              <span className={`relative inline-flex h-2.5 w-2.5 rounded-full ${status === 'live' ? 'bg-[#00F0FF]' : status === 'error' ? 'bg-[#FF4D4D]' : 'bg-[#FFB800]'}`} />
            </div>
            <span className="font-mono text-sm font-bold tracking-wider text-[#00F0FF] text-glow-cyan">
              ARBITRAGE PULSE
            </span>
          </div>
          <div className="hidden items-center gap-1.5 sm:flex">
            {FEEDS.filter((f) => connected?.[f.id]).map((f) => (
              <span
                key={f.id}
                className={`rounded px-1.5 py-0.5 font-mono text-[0.5625rem] tracking-wider ${
                  connected?.[f.id]
                    ? 'bg-[#00FF87]/10 text-[#00FF87]'
                    : 'bg-[#FF4D4D]/10 text-[#FF4D4D]'
                }`}
              >
                {f.name}
              </span>
            ))}
          </div>
        </div>

        <div className="flex items-center gap-3 md:gap-6">
          <div className="flex items-center gap-2">
            <Activity className="h-3.5 w-3.5 text-[#5a6080]" />
            <div className="flex flex-col">
              <span className="font-mono text-[0.625rem] uppercase tracking-wider text-[#5a6080]">Latency</span>
              <span className={`font-mono text-sm font-semibold ${latencyColor}`}>
                {globalLatency ? `${globalLatency}ms` : '—'}
              </span>
            </div>
          </div>

          <div className="hidden items-center gap-2 sm:flex">
            <TrendingUp className="h-3.5 w-3.5 text-[#5a6080]" />
            <div className="flex flex-col">
              <span className="font-mono text-[0.625rem] uppercase tracking-wider text-[#5a6080]">Session PnL</span>
              <span className={`font-mono text-sm font-semibold ${pnlPositive ? 'text-[#00FF87]' : 'text-[#FF4D4D]'}`}>
                {pnlPositive ? '+' : '-'}${Math.abs(Number(livePnl)).toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}
              </span>
            </div>
          </div>

          <div className="flex items-center gap-2">
          <button
            onClick={onOpenWallets}
            className="hidden rounded border border-[#232738] bg-[#12141D] px-2.5 py-1.5 font-mono text-[0.6rem] font-semibold uppercase text-[#8a90b0] hover:border-[#00F0FF]/40 hover:text-[#00F0FF] sm:block"
          >
            Wallets
          </button>
          <button
            onClick={onToggleEngine}
            className="group flex items-center gap-2 rounded border border-[#232738] bg-[#12141D] px-3 py-1.5 transition-colors hover:border-[#00F0FF]/40 hover:bg-[#1A1D2B]"
          >
            <Cpu className={`h-3.5 w-3.5 ${engineStatus === 'ACTIVE' ? 'text-[#00FF87]' : 'text-[#5a6080]'}`} />
            <div className="flex flex-col items-start">
              <span className="font-mono text-[0.625rem] uppercase tracking-wider text-[#5a6080]">Engine</span>
              <span className={`font-mono text-xs font-semibold ${engineStatus === 'ACTIVE' ? 'text-[#00FF87]' : 'text-[#FFB800]'}`}>
                {engineStatus}
              </span>
            </div>
            <Zap className={`h-3 w-3 ${engineStatus === 'ACTIVE' ? 'text-[#00FF87] glow-emerald' : 'text-[#5a6080]'}`} />
          </button>
          </div>
        </div>
      </div>
    </header>
  );
}