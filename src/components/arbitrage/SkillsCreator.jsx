import { useEffect, useRef, useState } from 'react'
import { Plus, Trash2, ArrowRight, FlaskConical, GripVertical } from 'lucide-react'
import { createBotSkill, deleteBotSkill, listBotSkills, updateBotSkill, runBacktest } from '@/lib/arbivault'
import { supabase } from '@/lib/supabase'

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
  { id: 'legacy_liquidity_fragmentation', name: 'Liquidity Fragmentation', description: 'Compare fragmented liquidity across venues and route executable spreads.' },
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

const PUBLIC_STRATEGY_PRESETS = [
  { id:'cross_venue_crypto', family:'exchange_arbitrage', name:'Cross-Venue Crypto', description:'Compare live public exchange books for cross-venue price dislocations.', dataSources:['crypto_exchanges'], observationOnly:true, discoveryEnabled:true, blocks:[] },
  { id:'btc_mempool_pressure', family:'bitcoin_network', name:'BTC Mempool Pressure', description:'Monitor Bitcoin mempool size and fee pressure for congestion regimes.', dataSources:['bitcoin_mempool'], observationOnly:true, discoveryEnabled:true, blocks:[] },
  { id:'solana_network_regime', family:'solana_network', name:'Solana Network Regime', description:'Track finalized slots and epoch progression for network-state signals.', dataSources:['solana_network'], observationOnly:true, discoveryEnabled:true, blocks:[] },
  { id:'sec_filing_signal', family:'stock_research', name:'SEC Filing Signal', description:'Watch public SEC filing activity for company-level research signals.', dataSources:['sec_edgar'], observationOnly:true, discoveryEnabled:true, blocks:[] },
  { id:'macro_regime', family:'macro_research', name:'Macro Regime', description:'Use FRED macro series as strategy context when a server-side key is configured.', dataSources:['fred'], observationOnly:true, discoveryEnabled:true, blocks:[] },
  { id:'equity_data_link', family:'stock_research', name:'Equity Data Link', description:'Use Nasdaq Data Link datasets for stock research when a server-side key is configured.', dataSources:['nasdaq_data_link'], observationOnly:true, discoveryEnabled:true, blocks:[] },
  { id:'weather_demand', family:'alternative_data', name:'Weather Demand', description:'Correlate public weather observations with demand or operational signals.', dataSources:['open_meteo'], observationOnly:true, discoveryEnabled:true, blocks:[] },
  { id:'public_opportunity_flow', family:'opportunity_intelligence', name:'Public Opportunity Flow', description:'Rank existing public opportunities by value, score, and status.', dataSources:['internal_opportunities'], observationOnly:true, discoveryEnabled:true, blocks:[] },
]

// Supabase JSONB should contain arrays, but older/migrated rows may contain
// a single object. Normalize before any spread/iteration so one bad row
// cannot blank the entire dashboard.
function asBlockArray(value) {
  const items = Array.isArray(value)
    ? value
    : (value && typeof value === 'object' ? [value] : [])
  return items.filter((item) => item && typeof item === 'object' && typeof item.label === 'string')
}

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
  const [draftSources, setDraftSources] = useState([])
  const [draftFamily, setDraftFamily] = useState(null)
  const [draftObservationOnly, setDraftObservationOnly] = useState(true)
  const [draftDiscoveryEnabled, setDraftDiscoveryEnabled] = useState(false)
  const [sourceStatus, setSourceStatus] = useState({})
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState('')
  const cooldownRef = useRef({})

  useEffect(() => {
    let active = true
    listBotSkills().then((rows) => {
      if (!active) return
      setStrategies(rows)
      setLoading(false)
      const emptyBacktests = rows.filter((skill) => !skill.backtest?.samples)
      if (emptyBacktests.length) {
        Promise.all(emptyBacktests.map(async (skill) => {
          try {
            const thresholdBlock = asBlockArray(skill.conditions).find((b) => b.label?.includes('Spread'))
            const threshold = thresholdBlock ? Number.parseFloat(thresholdBlock.value) || 0 : 0
            const result = await runBacktest({ skillId: skill.id, threshold, days: 30 })
            return { skillId: skill.id, backtest: { ...result, ranAt: new Date().toISOString() } }
          } catch {
            return null
          }
        })).then(async (results) => {
          const valid = results.filter(Boolean)
          await Promise.all(valid.map((item) => updateBotSkill(item.skillId, { backtest: item.backtest })))
          if (active && valid.length) {
            setStrategies((prev) => prev.map((skill) => {
              const update = valid.find((item) => item.skillId === skill.id)
              return update ? { ...skill, backtest: update.backtest } : skill
            }))
          }
        }).catch(() => {})
      }
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
    setDraftBlocks((preset.blocks || []).map((b) => ({ ...b })))
    setDraftSources(preset.dataSources || [])
    setDraftFamily(preset.family || null)
    setDraftObservationOnly(preset.observationOnly ?? false)
    setDraftDiscoveryEnabled(preset.discoveryEnabled ?? false)
  }
  const removeBlock = (index) => setDraftBlocks((prev) => prev.filter((_, i) => i !== index))

  const saveStrategy = async () => {
    if (!draftName.trim() || (!draftBlocks.length && !draftDiscoveryEnabled)) return
    try {
      setError('')
      const saved = await createBotSkill({
        name: draftName.trim(),
        description: draftPreset?.description || '',
        conditions: draftBlocks.filter((b) => b.type === 'condition'),
        actions: draftBlocks.filter((b) => b.type === 'action'),
        riskLimits: { maxNotional: NOTIONAL },
        cooldownSeconds: 30,
        strategyFamily: draftFamily,
        dataSources: draftSources,
        observationOnly: draftObservationOnly,
        discoveryEnabled: draftDiscoveryEnabled,
      })
      setStrategies((prev) => [...prev, saved])
      setDraftBlocks([])
      setDraftName('')
      setDraftPreset(null)
      setDraftSources([])
      setDraftFamily(null)
      setDraftObservationOnly(true)
      setDraftDiscoveryEnabled(false)
    } catch (e) { setError(e.message || 'Unable to save skill') }
  }

  const toggleStrategy = async (skill) => {
    try {
      const saved = await updateBotSkill(skill.id, { active: !skill.active })
      setStrategies((prev) => prev.map((s) => s.id === skill.id ? saved : s))
    } catch (e) { setError(e.message || 'Unable to update skill') }
  }

  const runDiscovery = async (skill) => {
    try {
      setError('')
      const result = await scoutPublicData({
        sources: Array.isArray(skill.data_sources) ? skill.data_sources : [],
        skillId: skill.id,
        persist: true,
      })
      const status = (result.results || []).map((r) => `${r.source}: ${r.status} (${r.count ?? 0})`).join(' · ')
      setSourceStatus((prev) => ({ ...prev, [skill.id]: status || 'No observations returned' }))
    } catch (e) {
      setError(e.message || 'Unable to scout public data')
    }
  }

  const removeStrategy = async (id) => {
    try {
      await deleteBotSkill(id)
      setStrategies((prev) => prev.filter((s) => s.id !== id))
    } catch (e) { setError(e.message || 'Unable to delete skill') }
  }

  const runSkillBacktest = async (skill) => {
    const blocks = asBlockArray(skill.conditions)
    const thresholdBlock = blocks.find((b) => b.label?.includes('Spread'))
    const threshold = thresholdBlock ? Number.parseFloat(thresholdBlock.value) || 0 : 0
    try {
      setError('')
      const backtest = await runBacktest({ skillId: skill.id, threshold, days: 30 })
      const saved = await updateBotSkill(skill.id, { backtest: { ...backtest, ranAt: new Date().toISOString() } })
      setStrategies((prev) => prev.map((s) => s.id === skill.id ? saved : s))
    } catch (e) { setError(e.message || 'Unable to save backtest') }
  }

  useEffect(() => {
    if (!onExecute) return
    const now = Date.now()
    strategies.forEach((skill) => {
      if (!skill.active) return
      const actions = asBlockArray(skill.actions)
      if (!actions.some((a) => a.label?.includes('Execute'))) return
      const conditions = asBlockArray(skill.conditions)
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
          <div className="mb-3"><span className="mb-1.5 block font-mono text-[0.625rem] uppercase tracking-wider text-[#5a6080]">Public Data Strategy Packs</span><div className="flex flex-wrap gap-1.5">{PUBLIC_STRATEGY_PRESETS.map((p) => <button key={p.id} onClick={() => applyPreset(p)} title={p.description} className={`rounded border px-2 py-1 font-mono text-[0.625rem] ${draftPreset?.id === p.id ? 'border-[#00FF87]/50 bg-[#00FF87]/10 text-[#00FF87]' : 'border-[#232738] text-[#8a90b0] hover:border-[#00FF87]/40'}`}>{p.name}</button>)}</div>{draftSources.length > 0 && <div className="mt-2 font-mono text-[0.5625rem] text-[#5a6080]">Sources: {draftSources.join(' · ')} · {draftObservationOnly ? 'OBSERVE-ONLY' : 'EXECUTION-CAPABLE'}</div>}</div>
          <div className="mb-3"><span className="mb-1.5 block font-mono text-[0.625rem] uppercase tracking-wider text-[#5a6080]">Conditions</span><div className="flex flex-wrap gap-1.5">{CONDITION_BLOCKS.map((b) => <button key={b.id} onClick={() => addBlock(b)} className="flex items-center gap-1 rounded border border-[#FFB800]/30 bg-[#FFB800]/5 px-2 py-1 font-mono text-[0.625rem] text-[#FFB800]"><Plus className="h-2.5 w-2.5" />{b.label}</button>)}</div></div>
          <div className="mb-3"><span className="mb-1.5 block font-mono text-[0.625rem] uppercase tracking-wider text-[#5a6080]">Actions</span><div className="flex flex-wrap gap-1.5">{ACTION_BLOCKS.map((b) => <button key={b.id} onClick={() => addBlock(b)} className="flex items-center gap-1 rounded border border-[#00F0FF]/30 bg-[#00F0FF]/5 px-2 py-1 font-mono text-[0.625rem] text-[#00F0FF]"><Plus className="h-2.5 w-2.5" />{b.label}</button>)}</div></div>
          {draftBlocks.length > 0 && <div className="mb-3 space-y-1.5 rounded border border-[#232738] bg-[#090A0F] p-2.5">{draftBlocks.map((b, i) => <div key={i}><LogicBlock block={b} onRemove={removeBlock} index={i} />{i < draftBlocks.length - 1 && <div className="flex justify-center py-0.5"><ArrowRight className="h-2.5 w-2.5 rotate-90 text-[#3a4060]" /></div>}</div>)}</div>}
          <button onClick={saveStrategy} disabled={!draftName.trim() || (!draftBlocks.length && !draftDiscoveryEnabled) || loading} className="w-full rounded border border-[#00F0FF] bg-[#00F0FF]/10 py-2 font-mono text-[0.6875rem] font-semibold uppercase text-[#00F0FF] disabled:opacity-40">Deploy Skill</button>
        </div>
        <div className="p-4"><span className="mb-3 block font-mono text-[0.6875rem] font-semibold uppercase tracking-wider text-[#8a90b0]">Saved Skills</span><div className="space-y-2">
          {strategies.map((s) => <div key={s.id} className={`rounded border p-3 ${s.active ? 'border-[#00FF87]/30 bg-[#00FF87]/5' : 'border-[#232738] bg-[#12141D]'}`}>
            <div className="mb-2 flex items-center justify-between"><div className="flex items-center gap-2"><button onClick={() => toggleStrategy(s)} className={`flex h-4 w-7 items-center rounded-full p-0.5 ${s.active ? 'bg-[#00FF87]/30' : 'bg-[#232738]'}`}><span className={`h-3 w-3 rounded-full ${s.active ? 'translate-x-3 bg-[#00FF87]' : 'bg-[#5a6080]'}`} /></button><span className="font-mono text-xs font-semibold text-[#e0e4f0]">{s.name}</span></div><button onClick={() => removeStrategy(s.id)} className="text-[#3a4060] hover:text-[#FF4D4D]"><Trash2 className="h-3 w-3" /></button></div>
            <div className="mb-2 flex flex-wrap gap-1">{[...asBlockArray(s.conditions), ...asBlockArray(s.actions)].map((b, i) => <span key={i} className={`rounded border px-1.5 py-0.5 font-mono text-[0.5625rem] ${b.type === 'condition' ? 'border-[#FFB800]/30 text-[#FFB800]' : 'border-[#00F0FF]/30 text-[#00F0FF]'}`}>{b.label}{b.value ? ` ${b.value}${b.unit || ''}` : ''}</span>)}</div>
            {Array.isArray(s.data_sources) && s.data_sources.length > 0 && <div className="mb-2 font-mono text-[0.55rem] uppercase tracking-wider text-[#5a6080]">DATA: {s.data_sources.join(' · ')} · {s.discovery_enabled ? 'DISCOVERY' : 'STRATEGY'}</div>}
            <div className="flex items-center justify-between"><div className="font-mono text-[0.625rem] text-[#5a6080]">{s.backtest ? <>WR: <span className="text-[#00FF87]">{s.backtest.winRate}%</span> · Trades: {s.backtest.trades} · PnL: <span className={s.backtest.pnl >= 0 ? 'text-[#00FF87]' : 'text-[#FF4D4D]'}>${Number(s.backtest.pnl).toFixed(1)}</span></> : 'No backtest yet'}</div><button onClick={() => runSkillBacktest(s)} disabled={loading} className="flex items-center gap-1 rounded border border-[#232738] px-2 py-1 font-mono text-[0.625rem] text-[#8a90b0] disabled:opacity-40"><FlaskConical className="h-3 w-3" />Backtest</button></div>
          </div>)}
          {!strategies.length && <p className="font-mono text-[0.65rem] text-[#3a4060]">No saved skills yet.</p>}
        </div></div>
      </div>
    </div>
  )
}
