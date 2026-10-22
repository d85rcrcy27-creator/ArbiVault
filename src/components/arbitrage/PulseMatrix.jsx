const ESTIMATED_NOTIONAL_USD = 10000
const ESTIMATED_ROUND_TRIP_FEE_PCT = 0.1
const money = (value) => new Intl.NumberFormat('en-US', { style: 'currency', currency: 'USD', maximumFractionDigits: 2 }).format(value)

export default function PulseMatrix({ routes = [], selectedRoute, onSelectRoute }) {
  const maxSpread = Math.max(...routes.map((r) => Number(r.spreadPct) || 0), 0.01);

  return (
    <div className="flex h-full flex-col rounded border border-[#232738] bg-[#0C0E16]">
      <div className="flex items-center justify-between border-b border-[#232738] px-4 py-3">
        <span className="font-mono text-xs font-bold uppercase tracking-wider text-[#00F0FF]">Pulse Matrix</span>
        <span className="font-mono text-[0.625rem] text-[#5a6080]">{routes.length} live routes</span>
      </div>
      <div className="scrollbar-thin min-h-0 flex-1 overflow-y-auto">
        {routes.map((r) => {
          const active = selectedRoute === r.id;
          const spreadPct = Number(r.spreadPct)
          const potentialNetProfit = Number.isFinite(spreadPct) && spreadPct > 0
            ? ESTIMATED_NOTIONAL_USD * (spreadPct - ESTIMATED_ROUND_TRIP_FEE_PCT) / 100
            : null
          return (
            <button
              key={r.id}
              onClick={() => onSelectRoute?.(r.id)}
              className={`w-full border-b border-[#1a1d2b] px-4 py-3 text-left transition-colors ${
                active ? 'bg-[#00F0FF]/5' : 'hover:bg-[#12141D]'
              }`}
            >
              <div className="flex items-center justify-between gap-2">
                <div className="flex items-center gap-2">
                  <span className="font-mono text-xs font-semibold text-[#e0e4f0]">{r.pair}</span>
                  <span className="rounded bg-[#12141D] px-1.5 py-0.5 font-mono text-[0.5625rem] text-[#5a6080]">
                    {r.buyExchange}→{r.sellExchange}
                  </span>
                  <span className="rounded bg-[#12141D] px-1.5 py-0.5 font-mono text-[0.5625rem] uppercase text-[#5a6080]">
                    {r.chain}
                  </span>
                </div>
                <span className="font-mono text-xs font-semibold text-[#FFB800]">{r.spreadPct.toFixed(3)}%</span>
              </div>
              <div className="mt-2 flex items-center justify-between gap-2 rounded border border-[#1a1d2b] bg-[#090A0F] px-2 py-1.5">
                <div className="min-w-0">
                  <div className="font-mono text-[0.5rem] uppercase tracking-wider text-[#5a6080]">Potential Profit · Est. Net</div>
                  <div className={`font-mono text-xs font-semibold ${potentialNetProfit != null && potentialNetProfit > 0 ? 'text-[#00FF87]' : 'text-[#FFB800]'}`}>
                    {potentialNetProfit == null ? '—' : money(potentialNetProfit)}
                  </div>
                </div>
                <div className="shrink-0 text-right font-mono text-[0.5rem] text-[#5a6080]">${ESTIMATED_NOTIONAL_USD.toLocaleString()} size<br />− {ESTIMATED_ROUND_TRIP_FEE_PCT}% fee assumption</div>
              </div>
              <div className="mt-2 grid grid-cols-2 gap-x-4 gap-y-1 font-mono text-[0.55rem] text-[#5a6080]">
                <span>BUY {Number(r.buyPrice || 0).toFixed(4)}</span>
                <span>SELL {Number(r.sellPrice || 0).toFixed(4)}</span>
              </div>
              <div className="mt-2 flex items-center gap-3">
                <div className="h-1 flex-1 overflow-hidden rounded-full bg-[#1a1d2b]">
                  <div
                    className="h-full rounded-full bg-gradient-to-r from-[#00F0FF] to-[#00FF87]"
                    style={{ width: `${Math.min(100, (r.spreadPct / maxSpread) * 100)}%` }}
                  />
                </div>
                <span className="w-24 shrink-0 text-right font-mono text-[0.55rem] text-[#FFB800]">
                  GROSS SPREAD
                </span>
                <span className="w-auto shrink-0 text-right font-mono text-[0.55rem] text-[#5a6080]">
                  QUOTE · {Number(r.latency || 0)}ms
                </span>
              </div>
            </button>
          );
        })}
      </div>
    </div>
  );
}
