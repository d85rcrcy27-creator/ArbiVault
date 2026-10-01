const NOTIONAL = 10000;

export default function PulseMatrix({ routes = [], selectedRoute, onSelectRoute }) {
  const maxSpread = Math.max(...routes.map((r) => r.spreadPct), 0.01);

  return (
    <div className="flex h-full flex-col rounded border border-[#232738] bg-[#0C0E16]">
      <div className="flex items-center justify-between border-b border-[#232738] px-4 py-3">
        <span className="font-mono text-xs font-bold uppercase tracking-wider text-[#00F0FF]">Pulse Matrix</span>
        <span className="font-mono text-[0.625rem] text-[#5a6080]">{routes.length} live routes</span>
      </div>
      <div className="scrollbar-thin min-h-0 flex-1 overflow-y-auto">
        {routes.map((r) => {
          const profit = (NOTIONAL * r.spreadPct) / 100;
          const active = selectedRoute === r.id;
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
                </div>
                <span className="font-mono text-xs font-semibold text-[#FFB800]">{r.spreadPct.toFixed(3)}%</span>
              </div>
              <div className="mt-2 flex items-center gap-3">
                <div className="h-1 flex-1 overflow-hidden rounded-full bg-[#1a1d2b]">
                  <div
                    className="h-full rounded-full bg-gradient-to-r from-[#00F0FF] to-[#00FF87]"
                    style={{ width: `${Math.min(100, (r.spreadPct / maxSpread) * 100)}%` }}
                  />
                </div>
                <span className="w-16 shrink-0 text-right font-mono text-[0.625rem] text-[#00FF87]">
                  +${profit.toFixed(2)}
                </span>
                <span className="w-12 shrink-0 text-right font-mono text-[0.625rem] text-[#5a6080]">
                  {r.latency}ms
                </span>
              </div>
            </button>
          );
        })}
      </div>
    </div>
  );
}
