import { RefreshCw, SlidersHorizontal } from 'lucide-react'

const SPREAD_OPTIONS = [0.1, 0.25, 0.5, 0.75, 1, 2]
const POLL_OPTIONS = [2000, 5000, 10000, 15000]
const ROUTE_OPTIONS = [4, 8, 12, 24]

export default function RuntimeControls({ controls, latency, status, onChange, onRefresh }) {
  return (
    <div className="rounded border border-[#232738] bg-[#0C0E16] p-4">
      <div className="mb-3 flex items-center justify-between gap-3">
        <div>
          <div className="flex items-center gap-2 font-mono text-xs font-bold uppercase tracking-wider text-[#00F0FF]">
            <SlidersHorizontal className="h-3.5 w-3.5" /> Runtime Controls
          </div>
          <p className="mt-1 text-[0.6rem] text-[#5a6080]">These controls change the live market hook and server-side scout request.</p>
        </div>
        <button onClick={onRefresh} title="Refresh market data" className="text-[#5a6080] hover:text-[#00F0FF]">
          <RefreshCw className="h-3.5 w-3.5" />
        </button>
      </div>

      <div className="grid gap-3 md:grid-cols-4">
        <label className="rounded border border-[#232738] bg-[#090A0F] p-2.5">
          <span className="block font-mono text-[0.55rem] uppercase tracking-wider text-[#5a6080]">Min Spread</span>
          <select
            value={controls.minSpreadPct}
            onChange={(e) => onChange({ minSpreadPct: Number(e.target.value) })}
            className="mt-1 w-full bg-transparent font-mono text-xs text-[#e0e4f0] outline-none"
          >
            {SPREAD_OPTIONS.map((v) => <option key={v} value={v}>{v.toFixed(2)}%</option>)}
          </select>
        </label>

        <label className="rounded border border-[#232738] bg-[#090A0F] p-2.5">
          <span className="block font-mono text-[0.55rem] uppercase tracking-wider text-[#5a6080]">Refresh</span>
          <select
            value={controls.pollMs}
            onChange={(e) => onChange({ pollMs: Number(e.target.value) })}
            className="mt-1 w-full bg-transparent font-mono text-xs text-[#e0e4f0] outline-none"
          >
            {POLL_OPTIONS.map((v) => <option key={v} value={v}>{v / 1000}s</option>)}
          </select>
        </label>

        <label className="rounded border border-[#232738] bg-[#090A0F] p-2.5">
          <span className="block font-mono text-[0.55rem] uppercase tracking-wider text-[#5a6080]">Live Routes</span>
          <select
            value={controls.maxRoutes}
            onChange={(e) => onChange({ maxRoutes: Number(e.target.value) })}
            className="mt-1 w-full bg-transparent font-mono text-xs text-[#e0e4f0] outline-none"
          >
            {ROUTE_OPTIONS.map((v) => <option key={v} value={v}>{v}</option>)}
          </select>
        </label>

        <div className="rounded border border-[#232738] bg-[#090A0F] p-2.5">
          <span className="block font-mono text-[0.55rem] uppercase tracking-wider text-[#5a6080]">Feed Health</span>
          <span className="mt-1 block font-mono text-xs text-[#00FF87]">{latency ? `${latency}ms` : '—'} · {status}</span>
        </div>
      </div>
    </div>
  )
}
