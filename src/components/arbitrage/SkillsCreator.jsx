import { useEffect, useRef, useState } from 'react';
import { Plus, Trash2, ArrowRight, FlaskConical, GripVertical } from 'lucide-react';

const CONDITION_BLOCKS = [
  { id: 'spread', label: 'IF Spread >', type: 'condition', unit: '%', placeholder: '0.50' },
  { id: 'latency', label: 'IF Latency <', type: 'condition', unit: 'ms', placeholder: '60' },
  { id: 'volume', label: 'IF Volume >', type: 'condition', unit: 'USD', placeholder: '10000' },
  { id: 'profit', label: 'IF Profit >', type: 'condition', unit: 'USD', placeholder: '5.00' },
];

const ACTION_BLOCKS = [
  { id: 'execute', label: 'THEN Execute Order', type: 'action' },
  { id: 'notify', label: 'THEN Send Alert', type: 'action' },
  { id: 'hedge', label: 'THEN Open Hedge', type: 'action' },
];

const NOTIONAL = 10000;
const FEE_PCT = 0.1;

const DEFAULT_STRATEGIES = [
  {
    id: 's1',
    name: 'High Spread Snipe',
    active: true,
    blocks: [
      { type: 'condition', label: 'IF Spread >', value: '0.03', unit: '%' },
      { type: 'action', label: 'THEN Execute Order' },
    ],
    backtest: null,
  },
  {
    id: 's2',
    name: 'Low Latency Scalp',
    active: true,
    blocks: [
      { type: 'condition', label: 'IF Latency <', value: '400', unit: 'ms' },
      { type: 'condition', label: 'IF Spread >', value: '0.015', unit: '%' },
      { type: 'action', label: 'THEN Execute Order' },
    ],
    backtest: null,
  },
  {
    id: 's3',
    name: 'Volume Surge',
    active: false,
    blocks: [
      { type: 'condition', label: 'IF Volume >', value: '25000', unit: 'USD' },
      { type: 'action', label: 'THEN Send Alert' },
    ],
    backtest: null,
  },
];

function blockMatches(block, route) {
  const value = parseFloat(block.value);
  if (Number.isNaN(value)) return false;
  if (block.label.includes('Spread')) return route.spreadPct > value;
  if (block.label.includes('Latency')) return route.latency < value;
  if (block.label.includes('Volume')) return route.volume > value;
  if (block.label.includes('Profit')) return route.profit > value;
  return false;
}

function LogicBlock({ block, onRemove, index }) {
  const isCondition = block.type === 'condition';
  return (
    <div className="group flex items-center gap-2 rounded border border-[#232738] bg-[#12141D] px-2.5 py-2">
      <GripVertical className="h-3.5 w-3.5 shrink-0 cursor-grab text-[#3a4060] group-hover:text-[#5a6080]" />
      <span className={`shrink-0 font-mono text-[0.6875rem] font-semibold uppercase tracking-wide ${isCondition ? 'text-[#FFB800]' : 'text-[#00F0FF]'}`}>
        {block.label}
      </span>
      {isCondition && (
        <div className="flex items-center gap-1">
          <input
            defaultValue={block.value}
            className="w-16 rounded border border-[#232738] bg-[#090A0F] px-1.5 py-0.5 font-mono text-[0.6875rem] text-[#e0e4f0] outline-none focus:border-[#00F0FF]"
          />
          <span className="font-mono text-[0.625rem] text-[#5a6080]">{block.unit}</span>
        </div>
      )}
      <button onClick={() => onRemove(index)} className="ml-auto text-[#3a4060] transition-colors hover:text-[#FF4D4D]">
        <Trash2 className="h-3 w-3" />
      </button>
    </div>
  );
}

export default function SkillsCreator({ routes = [], onExecute }) {
  const [strategies, setStrategies] = useState(DEFAULT_STRATEGIES);
  const [draftBlocks, setDraftBlocks] = useState([]);
  const [draftName, setDraftName] = useState('');
  const cooldownRef = useRef({});

  const addBlock = (block) => {
    setDraftBlocks((prev) => [...prev, {
      type: block.type,
      label: block.label,
      value: block.placeholder || '',
      unit: block.unit || '',
    }]);
  };

  const removeBlock = (index) => {
    setDraftBlocks((prev) => prev.filter((_, i) => i !== index));
  };

  const saveStrategy = () => {
    if (!draftName.trim() || draftBlocks.length === 0) return;
    const newStrategy = {
      id: `s${Date.now()}`,
      name: draftName.trim(),
      active: true,
      blocks: draftBlocks,
      backtest: null,
    };
    setStrategies((prev) => [...prev, newStrategy]);
    setDraftBlocks([]);
    setDraftName('');
  };

  const toggleStrategy = (id) => {
    setStrategies((prev) => prev.map((s) => (s.id === id ? { ...s, active: !s.active } : s)));
  };

  const deleteStrategy = (id) => {
    setStrategies((prev) => prev.filter((s) => s.id !== id));
  };

  const runBacktest = (id) => {
    const strat = strategies.find((s) => s.id === id);
    if (!strat) return;
    const thresholdBlock = strat.blocks.find((b) => b.label.includes('Spread'));
    const threshold = thresholdBlock ? parseFloat(thresholdBlock.value) || 0 : 0;
    const samples = routes.flatMap((r) => r.history || []);
    const trades = samples.filter((s) => s >= threshold);
    const wins = trades.filter((s) => s - FEE_PCT > 0);
    const pnl = trades.reduce((sum, s) => sum + (NOTIONAL * (s - FEE_PCT)) / 100, 0);
    const result = {
      winRate: trades.length ? Math.round((wins.length / trades.length) * 100) : 0,
      trades: trades.length,
      pnl,
      samples: samples.length,
    };
    setStrategies((prev) => prev.map((s) => (s.id === id ? { ...s, backtest: result } : s)));
  };

  // Active strategies fire automatically against live routes (30s cooldown per strategy/route).
  useEffect(() => {
    if (!onExecute) return;
    const now = Date.now();
    strategies.forEach((s) => {
      if (!s.active) return;
      if (!s.blocks.some((b) => b.label.includes('Execute'))) return;
      const conditions = s.blocks.filter((b) => b.type === 'condition');
      if (!conditions.length) return;
      routes.forEach((r) => {
        if (r.spreadPct <= 0) return;
        if (!conditions.every((c) => blockMatches(c, r))) return;
        const key = `${s.id}:${r.id}`;
        if (now - (cooldownRef.current[key] || 0) < 30000) return;
        cooldownRef.current[key] = now;
        onExecute(r.id, s.name);
      });
    });
  }, [routes, strategies, onExecute]);

  return (
    <div className="flex h-full flex-col rounded border border-[#232738] bg-[#0C0E16]">
      <div className="border-b border-[#232738] px-4 py-3">
        <div className="flex items-center gap-2">
          <span className="font-mono text-xs font-bold uppercase tracking-wider text-[#00F0FF]">
            Skills Creator
          </span>
          <span className="rounded bg-[#00F0FF]/10 px-1.5 py-0.5 font-mono text-[0.625rem] text-[#00F0FF]">
            BUILDER
          </span>
        </div>
      </div>

      <div className="scrollbar-thin min-h-0 flex-1 overflow-y-auto">
        {/* Strategy Builder Draft */}
        <div className="border-b border-[#232738] p-4">
          <div className="mb-3 flex items-center gap-2">
            <Plus className="h-3.5 w-3.5 text-[#00F0FF]" />
            <span className="font-mono text-[0.6875rem] font-semibold uppercase tracking-wider text-[#8a90b0]">
              New Strategy
            </span>
          </div>
          <input
            value={draftName}
            onChange={(e) => setDraftName(e.target.value)}
            placeholder="Strategy name…"
            className="mb-3 w-full rounded border border-[#232738] bg-[#090A0F] px-2.5 py-1.5 font-mono text-xs text-[#e0e4f0] outline-none placeholder:text-[#3a4060] focus:border-[#00F0FF]"
          />

          {/* Block Palette */}
          <div className="mb-3">
            <span className="mb-1.5 block font-mono text-[0.625rem] uppercase tracking-wider text-[#5a6080]">Conditions</span>
            <div className="flex flex-wrap gap-1.5">
              {CONDITION_BLOCKS.map((b) => (
                <button
                  key={b.id}
                  onClick={() => addBlock(b)}
                  className="flex items-center gap-1 rounded border border-[#FFB800]/30 bg-[#FFB800]/5 px-2 py-1 font-mono text-[0.625rem] text-[#FFB800] transition-colors hover:bg-[#FFB800]/15"
                >
                  <Plus className="h-2.5 w-2.5" />
                  {b.label}
                </button>
              ))}
            </div>
          </div>
          <div className="mb-3">
            <span className="mb-1.5 block font-mono text-[0.625rem] uppercase tracking-wider text-[#5a6080]">Actions</span>
            <div className="flex flex-wrap gap-1.5">
              {ACTION_BLOCKS.map((b) => (
                <button
                  key={b.id}
                  onClick={() => addBlock(b)}
                  className="flex items-center gap-1 rounded border border-[#00F0FF]/30 bg-[#00F0FF]/5 px-2 py-1 font-mono text-[0.625rem] text-[#00F0FF] transition-colors hover:bg-[#00F0FF]/15"
                >
                  <Plus className="h-2.5 w-2.5" />
                  {b.label}
                </button>
              ))}
            </div>
          </div>

          {/* Draft Logic Chain */}
          {draftBlocks.length > 0 && (
            <div className="mb-3 space-y-1.5 rounded border border-[#232738] bg-[#090A0F] p-2.5">
              {draftBlocks.map((b, i) => (
                <div key={i}>
                  <LogicBlock block={b} onRemove={removeBlock} index={i} />
                  {i < draftBlocks.length - 1 && (
                    <div className="flex justify-center py-0.5">
                      <ArrowRight className="h-2.5 w-2.5 rotate-90 text-[#3a4060]" />
                    </div>
                  )}
                </div>
              ))}
            </div>
          )}

          <button
            onClick={saveStrategy}
            disabled={!draftName.trim() || draftBlocks.length === 0}
            className="w-full rounded border border-[#00F0FF] bg-[#00F0FF]/10 py-2 font-mono text-[0.6875rem] font-semibold uppercase tracking-wider text-[#00F0FF] transition-all hover:bg-[#00F0FF]/20 disabled:cursor-not-allowed disabled:border-[#232738] disabled:bg-transparent disabled:text-[#3a4060]"
          >
            Deploy Strategy
          </button>
        </div>

        {/* Active Strategies */}
        <div className="p-4">
          <span className="mb-3 block font-mono text-[0.6875rem] font-semibold uppercase tracking-wider text-[#8a90b0]">
            Active Strategies
          </span>
          <div className="space-y-2">
            {strategies.map((s) => (
              <div
                key={s.id}
                className={`rounded border p-3 transition-colors ${
                  s.active ? 'border-[#00FF87]/30 bg-[#00FF87]/5' : 'border-[#232738] bg-[#12141D]'
                }`}
              >
                <div className="mb-2 flex items-center justify-between">
                  <div className="flex items-center gap-2">
                    <button
                      onClick={() => toggleStrategy(s.id)}
                      className={`flex h-4 w-7 items-center rounded-full p-0.5 transition-colors ${
                        s.active ? 'bg-[#00FF87]/30' : 'bg-[#232738]'
                      }`}
                    >
                      <span className={`h-3 w-3 rounded-full transition-transform ${s.active ? 'translate-x-3 bg-[#00FF87] glow-emerald' : 'translate-x-0 bg-[#5a6080]'}`} />
                    </button>
                    <span className="font-mono text-xs font-semibold text-[#e0e4f0]">{s.name}</span>
                  </div>
                  <button onClick={() => deleteStrategy(s.id)} className="text-[#3a4060] hover:text-[#FF4D4D]">
                    <Trash2 className="h-3 w-3" />
                  </button>
                </div>

                <div className="mb-2 flex flex-wrap gap-1">
                  {s.blocks.map((b, i) => (
                    <span
                      key={i}
                      className={`rounded border px-1.5 py-0.5 font-mono text-[0.5625rem] ${
                        b.type === 'condition'
                          ? 'border-[#FFB800]/30 text-[#FFB800]'
                          : 'border-[#00F0FF]/30 text-[#00F0FF]'
                      }`}
                    >
                      {b.label}{b.value ? ` ${b.value}${b.unit}` : ''}
                    </span>
                  ))}
                </div>

                <div className="flex items-center justify-between">
                  {s.backtest ? (
                    <div className="flex flex-wrap gap-x-3 gap-y-1 font-mono text-[0.625rem]">
                      <span className="text-[#5a6080]">WR: <span className="text-[#00FF87]">{s.backtest.winRate}%</span></span>
                      <span className="text-[#5a6080]">Trades: <span className="text-[#8a90b0]">{s.backtest.trades}</span></span>
                      <span className="text-[#5a6080]">PnL: <span className={s.backtest.pnl >= 0 ? 'text-[#00FF87]' : 'text-[#FF4D4D]'}>${s.backtest.pnl.toFixed(1)}</span></span>
                      <span className="text-[#5a6080]">Samples: <span className="text-[#8a90b0]">{s.backtest.samples}</span></span>
                    </div>
                  ) : (
                    <span className="font-mono text-[0.625rem] text-[#3a4060]">Run backtest on live spreads</span>
                  )}
                  <button
                    onClick={() => runBacktest(s.id)}
                    disabled={routes.length === 0}
                    className="flex items-center gap-1 rounded border border-[#232738] px-2 py-1 font-mono text-[0.625rem] text-[#8a90b0] transition-colors hover:border-[#FFB800]/40 hover:text-[#FFB800] disabled:opacity-50"
                  >
                    <FlaskConical className="h-3 w-3" />
                    Backtest
                  </button>
                </div>
              </div>
            ))}
          </div>
        </div>
      </div>
    </div>
  );
}
