import { useEffect, useRef, useState } from 'react'
import { Plus, Trash2, ArrowRight, FlaskConical, GripVertical } from 'lucide-react'
import { createBotSkill, deleteBotSkill, listBotSkills, updateBotSkill } from '@/lib/arbivault'

const CONDITION_BLOCKS = [
  { id: 'spread', label: 'IF Spread >', type: 'condition', unit: '%', placeholder: '0.50' },
  { id: 'latency', label: 'IF Latency <', type: 'condition', unit: 'ms', placeholder: '60' },
  { id: 'volume', label: 'IF Volume >', type: 'condition', unit: 'USD', placeholder: '10000' },
  { id: 'profit', label: 'IF Profit >', type: 'condition', unit: 'USD', placeholder: '5.00' },
]

const ACTION_BLOCKS = [
  { id: 'execute', label: 'THEN Execute Order', type: 'action' },
  { id: 'notify', label: 'THEN Send Alert', type: 'action' },
  { id: 'hedge', label: 'THEN Open Hedge', type: 'action' },
]

// Deployable strategy presets. Picking one drops its condition/action blocks
// into the draft so the strategy can be deployed in a single click.

// Legacy ArbiVault strategy catalog recovered from the pre-migration BotConfig export.
// These are listed separately from the newer skill presets so the migration does not
// silently discard the strategies that existed in the original app.
const LEGACY_STRATEGY_PRESETS = [
  { id: 'legacy_cross_chain_latency', name: 'Cross-Chain Latency', description: 'Exploit measurable cross-chain price/latency dislocations with bounded inventory and timing checks.' },
  { id: 'legacy_liquidity_fragmentation', name: 'Liquidity Fragmentation', description: 'Compare fragmented liquidity across venues and route qualifying spreads.' },
  { id: 'legacy_mempool_sandwich', name: 'Mempool Sandwich', description: 'Detect mempool ordering opportunities subject to strict MEV and risk controls.' },
  { id: 'legacy_flash_swap', name: 'Flash Swap', description: 'Atomic flash-swap route with repayment and profitability checks.' },
  { id: 'legacy_flash_loan', name: 'Flash Loan', description: 'Atomic borrow → arbitrage → repay strategy with profitability and gas checks.' },
]

const STRATEGY_PRESETS = [
  {
    id: 'snipe',
    name: 'Snipe',
    description: 'Front-runs new pool listings and thin-book dislocations.',
    blocks: [
      { type: 'condition', label: 'IF Spread >', value: '0.80', unit: '%' },
      { type: 'condition', label: 'IF Latency <', value: '40', unit: 'ms' },
      { type: 'action', label: 'THEN Execute Order' },
    ],
  },
  {
    id: 'flash_loan',
    name: 'Flash Loan',
    description: 'Atomic borrow → arbitrage → repay inside one transaction.',
    blocks: [
      { type: 'condition', label: 'IF Spread >', value: '0.25', unit: '%' },
      { type: 'condition', label: 'IF Profit >', value: '5.00', unit: 'USD' },
      { type: 'action', label: 'THEN Execute Order' },
      { type: 'action', label: 'THEN Send Alert' },
    ],
  },
  {
    id: 'latency_automation',
    name: 'Latency Automation',
    description: 'Cross-venue latency arbitrage between exchange feeds.',
    blocks: [
      { type: 'condition', label: 'IF Latency <', value: '60', unit: 'ms' },
      { type: 'condition', label: 'IF Volume >', value: '10000', unit: 'USD' },
      { type: 'action', label: 'THEN Execute Order' },
      { type: 'action', label: 'THEN Open Hedge' },
    ],
  },
]

const NOTIONAL = 10000
const FEE_PCT = 0.1

function blockMatches(block, route) {
  const value = Number.parseFloat(block.value)
  if (Number.isNaN(value)) return false
  if (block.label.includes('Spread')) return route.spreadPct > value
  if (block.label.includes('Latency')) return route.latency < value
  if (block.label.includes('Volume')) return route.volume > value
  if (block.label.includes('Profit')) return route.profit > value
  return false
}

function LogicBlock({ block, onRemove, index }) {
  const isCondition = block.type === 'condition'
  return (
    <div className="group flex items-center gap-2 rounded border border-[#232738] bg-[#12141D] px-2.5 py-2">
      <GripVertical className="h-3.5 w-3.5 shrink-0 cursor-grab text-[#3a4060]" />
      <span className={`shrink-0 font-mono text-[0.6875rem] font-semibold uppercase tracking-wide ${isCondition ? 'text-[#FFB800]' : 'text-[#00F0FF]'}`}>{block.label}</span>
      {isCondition && <><input value={block.value || ''} onChange={() => {}} readOnly className="w-16 rounded border border-[#232738] bg-[#090A0F] px-1.5 py-0.5 font-mono text-[0.6875rem] text-[#e0e4f0]" /><span className="font-mono text-[0.625rem] text-[#5a6080]">{block.unit}</span></>}
      <button onClick={() => onRemove(index)} className="ml-auto text-[#3a4060] hover:text-[#FF4D4D]"><Trash2 className="h-3 w-3" /></button>
    </div>
  )
}

export default function SkillsCreator({ routes = [], onExecute }) {
  const [strategies, setStrategies] = useState([])
  const [draftBlocks, setDraftBlocks] = useState([])
  const [draftName, setDraftName] = useState('')
  const [draftPreset, setDraftPreset] = useState(null)
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState('')
  const cooldownRef = useRef({})

  useEffect(() => {
    let active = true
    listBotSkills().then((rows) => {
      if (!active) return
      setStrategies(rows)
      setLoading(false)
    }).catch((e) => {
      if (!active) return
      setError(e.message || 'Unable to load skills')
      setLoading(false)
    })
    return () => { active = false }
  }, [])

  const addBlock = (block) => setDraftBlocks((prev) => [...prev, { type: block.type, label: block.label, value: block.placeholder || '', unit: block.unit || '' }])
  const applyPreset = (preset) => {
    setDraftPreset(preset)
    setDraftName(preset.name)
    setDraftBlocks(preset.blocks.map((b) => ({ ...b })))
  }
  const removeBlock = (index) => setDraftBlocks((prev) => prev.filter((_, i) => i !== index))

  const saveStrategy = async () => {
    if (!draftName.trim() || draftBlocks.length === 0) return
    try {
      setError('')
      const saved = await createBotSkill({ name: draftName.trim(), description: draftPreset?.description || '', conditions: draftBlocks.filter((b) => b.type === 'condition'), actions: draftBlocks.filter((b) => b.type === 'action'), riskLimits: { maxNotional: NOTIONAL }, cooldownSeconds: 30 })
      setStrategies((prev) => [...prev, saved])
      setDraftBlocks([])
      setDraftName('')
      setDraftPreset(null)
    } catch (e) { setError(e.message || 'Unable to save skill') }
  }

  const toggleStrategy = async (skill) => {
    try {
      const saved = await updateBotSkill(skill.id, { active: !skill.active })
      setStrategies((prev) => prev.map((s) => s.id === skill.id ? saved : s))
    } catch (e) { setError(e.message || 'Unable to update skill') }
  }

  const removeStrategy = async (id) => {
    try {
      await deleteBotSkill(id)
      setStrategies((prev) => prev.filter((s) => s.id !== id))
    } catch (e) { setError(e.message || 'Unable to delete skill') }
  }

  const runBacktest = async (skill) => {
    const blocks = [...(skill.conditions || [])]
    const thresholdBlock = blocks.find((b) => b.label?.includes('Spread'))
    const threshold = thresholdBlock ? Number.parseFloat(thresholdBlock.value) || 0 : 0
    const samples = routes.flatMap((r) => r.history || [])
    const trades = samples.filter((s) => s >= threshold)
    const wins = trades.filter((s) => s - FEE_PCT > 0)
    const pnl = trades.reduce((sum, s) => sum + (NOTIONAL * (s - FEE_PCT)) / 100, 0)
    const backtest = { winRate: trades.length ? Math.round((wins.length / trades.length) * 100) : 0, trades: trades.length, pnl, samples: samples.length, ranAt: new Date().toISOString() }
    try {
      const saved = await updateBotSkill(skill.id, { backtest })
      setStrategies((prev) => prev.map((s) => s.id === skill.id ? saved : s))
    } catch (e) { setError(e.message || 'Unable to save backtest') }
  }

  useEffect(() => {
    if (!onExecute) return
    const now = Date.now()
    strategies.forEach((skill) => {
      if (!skill.active) return
      const actions = skill.actions || []
      if (!actions.some((a) => a.label?.includes('Execute'))) return
      const conditions = skill.conditions || []
      if (!conditions.length) return
      routes.forEach((route) => {
        if (route.spreadPct <= 0 || !conditions.every((c) => blockMatches(c, route))) return
        const key = `${skill.id}:${route.id}`
        if (now - (cooldownRef.current[key] || 0) < (skill.cooldown_seconds || 30) * 1000) return
        cooldownRef.current[key] = now
        onExecute(route.id, skill.name, skill.id)
      })
    })
  }, [routes, strategies, onExecute])

  return (
    <div className="flex h-full flex-col rounded border border-[#232738] bg-[#0C0E16]">
      <div className="border-b border-[#232738] px-4 py-3"><div className="flex items-center gap-2 font-mono text-xs font-bold uppercase tracking-wider text-[#00F0FF]">Skills Creator <span className="rounded bg-[#00F0FF]/10 px-1.5 py-0.5 text-[0.625rem]">PERSISTED</span></div></div>
      {error && <div className="mx-4 mt-3 rounded border border-[#FF4D4D]/30 bg-[#FF4D4D]/5 p-2 font-mono text-[0.6rem] text-[#FF4D4D]">{error}</div>}
      <div className="scrollbar-thin min-h-0 flex-1 overflow-y-auto">
        <div className="border-b border-[#232738] p-4">
          <input value={draftName} onChange={(e) => setDraftName(e.target.value)} placeholder="Strategy name…" className="mb-3 w-full rounded border border-[#232738] bg-[#090A0F] px-2.5 py-1.5 font-mono text-xs text-[#e0e4f0]" />
          <div className="mb-3"><span className="mb-1.5 block font-mono text-[0.625rem] uppercase tracking-wider text-[#5a6080]">Current Strategy Presets</span><div className="flex flex-wrap gap-1.5">{STRATEGY_PRESETS.map((p) => <button key={p.id} onClick={() => applyPreset(p)} title={p.description} className={`rounded border px-2 py-1 font-mono text-[0.625rem] ${draftPreset?.id === p.id ? 'border-[#00FF87]/50 bg-[#00FF87]/10 text-[#00FF87]' : 'border-[#232738] text-[#8a90b0] hover:border-[#00FF87]/40'}`}>{p.name}</button>)}</div></div>
          <div className="mb-3"><span className="mb-1.5 block font-mono text-[0.625rem] uppercase tracking-wider text-[#5a6080]">Conditions</span><div className="flex flex-wrap gap-1.5">{CONDITION_BLOCKS.map((b) => <button key={b.id} onClick={() => addBlock(b)} className="flex items-center gap-1 rounded border border-[#FFB800]/30 bg-[#FFB800]/5 px-2 py-1 font-mono text-[0.625rem] text-[#FFB800]"><Plus className="h-2.5 w-2.5" />{b.label}</button>)}</div></div>
          <div className="mb-3"><span className="mb-1.5 block font-mono text-[0.625rem] uppercase tracking-wider text-[#5a6080]">Actions</span><div className="flex flex-wrap gap-1.5">{ACTION_BLOCKS.map((b) => <button key={b.id} onClick={() => addBlock(b)} className="flex items-center gap-1 rounded border border-[#00F0FF]/30 bg-[#00F0FF]/5 px-2 py-1 font-mono text-[0.625rem] text-[#00F0FF]"><Plus className="h-2.5 w-2.5" />{b.label}</button>)}</div></div>
          {draftBlocks.length > 0 && <div className="mb-3 space-y-1.5 rounded border border-[#232738] bg-[#090A0F] p-2.5">{draftBlocks.map((b, i) => <div key={i}><LogicBlock block={b} onRemove={removeBlock} index={i} />{i < draftBlocks.length - 1 && <div className="flex justify-center py-0.5"><ArrowRight className="h-2.5 w-2.5 rotate-90 text-[#3a4060]" /></div>}</div>)}</div>}
          <button onClick={saveStrategy} disabled={!draftName.trim() || !draftBlocks.length || loading} className="w-full rounded border border-[#00F0FF] bg-[#00F0FF]/10 py-2 font-mono text-[0.6875rem] font-semibold uppercase text-[#00F0FF] disabled:opacity-40">Deploy Skill</button>
        </div>
        <div className="p-4"><span className="mb-3 block font-mono text-[0.6875rem] font-semibold uppercase tracking-wider text-[#8a90b0]">Saved Skills</span><div className="space-y-2">
          {strategies.map((s) => <div key={s.id} className={`rounded border p-3 ${s.active ? 'border-[#00FF87]/30 bg-[#00FF87]/5' : 'border-[#232738] bg-[#12141D]'}`}>
            <div className="mb-2 flex items-center justify-between"><div className="flex items-center gap-2"><button onClick={() => toggleStrategy(s)} className={`flex h-4 w-7 items-center rounded-full p-0.5 ${s.active ? 'bg-[#00FF87]/30' : 'bg-[#232738]'}`}><span className={`h-3 w-3 rounded-full ${s.active ? 'translate-x-3 bg-[#00FF87]' : 'bg-[#5a6080]'}`} /></button><span className="font-mono text-xs font-semibold text-[#e0e4f0]">{s.name}</span></div><button onClick={() => removeStrategy(s.id)} className="text-[#3a4060] hover:text-[#FF4D4D]"><Trash2 className="h-3 w-3" /></button></div>
            <div className="mb-2 flex flex-wrap gap-1">{[...(s.conditions || []), ...(s.actions || [])].map((b, i) => <span key={i} className={`rounded border px-1.5 py-0.5 font-mono text-[0.5625rem] ${b.type === 'condition' ? 'border-[#FFB800]/30 text-[#FFB800]' : 'border-[#00F0FF]/30 text-[#00F0FF]'}`}>{b.label}{b.value ? ` ${b.value}${b.unit || ''}` : ''}</span>)}</div>
            <div className="flex items-center justify-between"><div className="font-mono text-[0.625rem] text-[#5a6080]">{s.backtest ? <>WR: <span className="text-[#00FF87]">{s.backtest.winRate}%</span> · Trades: {s.backtest.trades} · PnL: <span className={s.backtest.pnl >= 0 ? 'text-[#00FF87]' : 'text-[#FF4D4D]'}>${Number(s.backtest.pnl).toFixed(1)}</span></> : 'No backtest yet'}</div><button onClick={() => runBacktest(s)} disabled={!routes.length} className="flex items-center gap-1 rounded border border-[#232738] px-2 py-1 font-mono text-[0.625rem] text-[#8a90b0] disabled:opacity-40"><FlaskConical className="h-3 w-3" />Backtest</button></div>
          </div>)}
          {!strategies.length && <p className="font-mono text-[0.65rem] text-[#3a4060]">No saved skills yet.</p>}
        </div></div>
      </div>
    </div>
  )
}
