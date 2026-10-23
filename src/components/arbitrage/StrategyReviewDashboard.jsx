import { useCallback, useEffect, useState } from 'react'
import { AlertTriangle, CheckCircle2, Clock3, RefreshCw, ShieldCheck, Sparkles, XCircle } from 'lucide-react'
import { getAuthenticatedSession, supabase } from '@/lib/supabase'
import { useAuth } from '@/lib/AuthContext'

const CATEGORY_OPTIONS = [
  {
    id: 'dex_arbitrage',
    label: 'DEX arbitrage',
    description: 'Compare executable DEX routes after swap fees, gas, slippage and flash-loan premium.',
  },
  {
    id: 'collateral_swap',
    label: 'Collateral swaps',
    description: 'Propose collateral migration while checking health factor, liquidity and unwind risk.',
  },
  {
    id: 'liquidation',
    label: 'Liquidations',
    description: 'Evaluate protocol-defined liquidation opportunities against eligibility, close-factor and repayment rules.',
  },
  {
    id: 'debt_refinancing',
    label: 'Debt refinancing',
    description: 'Compare repayment and replacement-borrow routes including fees, collateral risk and rate variability.',
  },
]

const PIPELINE_STAGES = [
  'AI proposal',
  'Human review',
  'Builder',
  'Simulator',
  'Signer approval',
  'Atomic executor',
  'Verified proof',
]

const CATEGORY_LABELS = Object.fromEntries(CATEGORY_OPTIONS.map((item) => [item.id, item.label]))

function formatDate(value) {
  if (!value) return '—'
  const date = new Date(value)
  return Number.isNaN(date.getTime()) ? '—' : date.toLocaleString()
}

function formatUsd(value) {
  const number = Number(value)
  return Number.isFinite(number)
    ? number.toLocaleString('en-US', { style: 'currency', currency: 'USD', maximumFractionDigits: 2 })
    : '—'
}

function StatusPill({ status }) {
  const styles = {
    pending_review: 'border-[#FFB800]/40 text-[#FFB800]',
    approved_for_preflight: 'border-[#00F0FF]/40 text-[#00F0FF]',
    rejected: 'border-[#FF4D4D]/40 text-[#FF8A8A]',
    archived: 'border-[#5a6080] text-[#8a90b0]',
  }
  const label = {
    pending_review: 'Pending human review',
    approved_for_preflight: 'Approved for preflight only',
    rejected: 'Rejected',
    archived: 'Archived',
  }[status] || status || 'Unknown'
  return <span className={`rounded border px-2 py-1 font-mono text-[0.54rem] uppercase ${styles[status] || 'border-[#5a6080] text-[#8a90b0]'}`}>{label}</span>
}

function ProposalCard({ proposal, busy, reviewNotes, onNotesChange, onReview }) {
  const config = proposal.strategy_config || {}
  const risk = config.risk_controls || {}
  const reviewed = proposal.status !== 'pending_review'
  const steps = Array.isArray(config.route_steps) ? config.route_steps : []
  const riskNotes = Array.isArray(config.risk_notes) ? config.risk_notes : []
  const assumptions = Array.isArray(config.assumptions) ? config.assumptions : []
  const missing = Array.isArray(config.missing_integrations) ? config.missing_integrations : []
  const limitations = Array.isArray(config.limitations) ? config.limitations : []

  return (
    <article className="rounded border border-[#232738] bg-[#090A0F] p-3 sm:p-4">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div className="min-w-0 flex-1">
          <div className="mb-1 font-mono text-[0.52rem] uppercase tracking-wider text-[#5a6080]">
            {CATEGORY_LABELS[proposal.category] || proposal.category} · {formatDate(proposal.created_at)}
          </div>
          <h3 className="font-mono text-sm font-semibold text-[#e0e4f0]">{proposal.title}</h3>
          <p className="mt-1 text-xs leading-relaxed text-[#8a90b0]">{proposal.summary}</p>
        </div>
        <StatusPill status={proposal.status} />
      </div>

      <div className="mt-3 grid grid-cols-2 gap-2 sm:grid-cols-4">
        <div className="rounded border border-[#232738] p-2">
          <div className="font-mono text-[0.48rem] uppercase text-[#5a6080]">Proposal cap</div>
          <div className="mt-1 font-mono text-xs text-[#e0e4f0]">{formatUsd(risk.max_trade_notional_usd)}</div>
        </div>
        <div className="rounded border border-[#232738] p-2">
          <div className="font-mono text-[0.48rem] uppercase text-[#5a6080]">Minimum target</div>
          <div className="mt-1 font-mono text-xs text-[#e0e4f0]">{formatUsd(risk.min_net_profit_usd)}</div>
        </div>
        <div className="rounded border border-[#232738] p-2">
          <div className="font-mono text-[0.48rem] uppercase text-[#5a6080]">Slippage cap</div>
          <div className="mt-1 font-mono text-xs text-[#e0e4f0]">{Number.isFinite(Number(risk.max_slippage_bps)) ? `${risk.max_slippage_bps} bps` : '—'}</div>
        </div>
        <div className="rounded border border-[#232738] p-2">
          <div className="font-mono text-[0.48rem] uppercase text-[#5a6080]">Gas budget</div>
          <div className="mt-1 font-mono text-xs text-[#e0e4f0]">{formatUsd(risk.max_gas_cost_usd)}</div>
        </div>
      </div>

      {steps.length > 0 && (
        <div className="mt-3">
          <div className="mb-1.5 font-mono text-[0.55rem] uppercase tracking-wider text-[#8a90b0]">Proposed high-level route</div>
          <div className="space-y-1.5">
            {steps.map((step, index) => (
              <div key={`${proposal.id}-step-${index}`} className="grid gap-1 rounded border border-[#232738] p-2 sm:grid-cols-[5rem_1fr] sm:items-start">
                <span className="font-mono text-[0.55rem] uppercase text-[#00F0FF]">{index + 1}. {String(step.action || 'step').replaceAll('_', ' ')}</span>
                <div>
                  <div className="font-mono text-[0.6rem] text-[#e0e4f0]">{step.protocol || 'Protocol TBD'} · {step.input_asset || 'Asset TBD'} → {step.output_asset || 'Asset TBD'}</div>
                  <p className="mt-0.5 text-[0.66rem] leading-relaxed text-[#8a90b0]">{step.rationale}</p>
                </div>
              </div>
            ))}
          </div>
        </div>
      )}

      <div className="mt-3 grid gap-3 lg:grid-cols-2">
        <div>
          <div className="mb-1 font-mono text-[0.55rem] uppercase tracking-wider text-[#FFB800]">Risks</div>
          <ul className="list-disc space-y-1 pl-4 text-[0.65rem] leading-relaxed text-[#8a90b0]">
            {riskNotes.length ? riskNotes.slice(0, 5).map((item, index) => <li key={index}>{item}</li>) : <li>No detailed risk notes were returned.</li>}
          </ul>
        </div>
        <div>
          <div className="mb-1 font-mono text-[0.55rem] uppercase tracking-wider text-[#8a90b0]">Missing integrations / limitations</div>
          <ul className="list-disc space-y-1 pl-4 text-[0.65rem] leading-relaxed text-[#8a90b0]">
            {[...missing, ...limitations].slice(0, 6).map((item, index) => <li key={index}>{item}</li>)}
            {!missing.length && !limitations.length && <li>Protocol-specific validation is still required.</li>}
          </ul>
        </div>
      </div>

      {assumptions.length > 0 && (
        <details className="mt-3 rounded border border-[#232738] p-2">
          <summary className="cursor-pointer font-mono text-[0.56rem] uppercase text-[#8a90b0]">Assumptions and confidence: {config.confidence || 'unrated'}</summary>
          <ul className="mt-2 list-disc space-y-1 pl-4 text-[0.65rem] leading-relaxed text-[#8a90b0]">
            {assumptions.slice(0, 8).map((item, index) => <li key={index}>{item}</li>)}
          </ul>
        </details>
      )}

      <div className="mt-3 flex flex-wrap items-center gap-2 border-t border-[#232738] pt-3">
        {proposal.proven ? (
          <span className="inline-flex items-center gap-1 font-mono text-[0.58rem] uppercase text-[#00FF87]"><CheckCircle2 className="h-3 w-3" /> Proven from {proposal.proof_profitable_run_count} verified profitable runs</span>
        ) : (
          <span className="inline-flex items-center gap-1 font-mono text-[0.55rem] uppercase text-[#5a6080]"><Clock3 className="h-3 w-3" /> Not proven · {proposal.proof_profitable_run_count || 0}/5 verified profitable runs</span>
        )}
        {reviewed && proposal.reviewed_at && <span className="font-mono text-[0.52rem] text-[#5a6080]">Reviewed {formatDate(proposal.reviewed_at)}</span>}
      </div>

      {proposal.status === 'pending_review' ? (
        <div className="mt-3 space-y-2">
          <textarea
            value={reviewNotes}
            onChange={(event) => onNotesChange(proposal.id, event.target.value)}
            maxLength={1200}
            rows={2}
            placeholder="Review notes (optional)"
            className="w-full resize-y rounded border border-[#232738] bg-[#0C0E16] px-2.5 py-2 font-mono text-xs text-[#e0e4f0] outline-none focus:border-[#00F0FF]/50"
          />
          <div className="flex flex-wrap gap-2">
            <button
              type="button"
              onClick={() => onReview(proposal.id, 'approve_for_preflight')}
              disabled={busy}
              className="flex items-center gap-1.5 rounded border border-[#00F0FF]/40 px-3 py-2 font-mono text-[0.58rem] font-semibold uppercase text-[#00F0FF] disabled:opacity-40"
            >
              <ShieldCheck className="h-3.5 w-3.5" /> Approve for preflight
            </button>
            <button
              type="button"
              onClick={() => onReview(proposal.id, 'reject')}
              disabled={busy}
              className="flex items-center gap-1.5 rounded border border-[#FF4D4D]/40 px-3 py-2 font-mono text-[0.58rem] font-semibold uppercase text-[#FF8A8A] disabled:opacity-40"
            >
              <XCircle className="h-3.5 w-3.5" /> Reject
            </button>
          </div>
        </div>
      ) : (
        <div className="mt-3 rounded border border-[#232738] bg-[#0C0E16] p-2.5 font-mono text-[0.55rem] leading-relaxed text-[#8a90b0]">
          {proposal.status === 'approved_for_preflight'
            ? 'Human review passed. This approval is not an on-chain registry approval and does not enable a bot. Current state: blocked pending a verified category-specific builder, simulator, signer policy, and atomic executor.'
            : 'This proposal is not authorized for preflight or execution.'}
          {proposal.review_notes && <div className="mt-1 normal-case">Review notes: {proposal.review_notes}</div>}
        </div>
      )}
    </article>
  )
}

export default function StrategyReviewDashboard() {
  const { user, isLoading: authLoading } = useAuth()
  const [category, setCategory] = useState('dex_arbitrage')
  const [objective, setObjective] = useState('')
  const [proposals, setProposals] = useState([])
  const [notesById, setNotesById] = useState({})
  const [loading, setLoading] = useState(true)
  const [busyAction, setBusyAction] = useState('')
  const [error, setError] = useState('')
  const [notice, setNotice] = useState('')

  const load = useCallback(async () => {
    if (!user) {
      setProposals([])
      setLoading(false)
      return
    }
    setLoading(true)
    try {
      await getAuthenticatedSession()
      const { data, error: queryError } = await supabase
        .from('strategy_proposals')
        .select('id,owner_id,category,title,summary,objective,strategy_config,risk_assessment,status,execution_status,model,reviewed_at,review_notes,proven,proof_profitable_run_count,proof_net_profit_usd,created_at')
        .order('created_at', { ascending: false })
        .limit(20)
      if (queryError) throw queryError
      setProposals(data || [])
      setError('')
    } catch (e) {
      setError(e.message || 'Unable to load strategy proposals')
    } finally {
      setLoading(false)
    }
  }, [user])

  useEffect(() => {
    if (!authLoading) load()
  }, [authLoading, load])

  const generate = async (event) => {
    event.preventDefault()
    setBusyAction('generate')
    setError('')
    setNotice('')
    try {
      await getAuthenticatedSession()
      const { data, error: invokeError } = await supabase.functions.invoke('arbivault-strategy-proposals', {
        body: { action: 'generate', category, objective: objective.trim() },
      })
      if (invokeError) throw invokeError
      if (!data?.ok) throw new Error(data?.error || 'Unable to generate proposal')
      setObjective('')
      setNotice('Proposal saved for human review. No bot was enabled and no transaction was built or sent.')
      await load()
    } catch (e) {
      const message = e.message || 'Unable to generate strategy proposal'
      setError(message.includes('openai_secret_missing')
        ? 'AI secret is not configured. Add OPENAI_API_KEY under Supabase Edge Function Secrets, then retry.'
        : message)
    } finally {
      setBusyAction('')
    }
  }

  const review = async (proposalId, decision) => {
    setBusyAction(proposalId)
    setError('')
    setNotice('')
    try {
      await getAuthenticatedSession()
      const { data, error: invokeError } = await supabase.functions.invoke('arbivault-strategy-proposals', {
        body: {
          action: 'review',
          proposal_id: proposalId,
          decision,
          review_notes: (notesById[proposalId] || '').trim() || null,
        },
      })
      if (invokeError) throw invokeError
      if (!data?.ok) throw new Error(data?.error || 'Unable to save human review')
      setNotice(data.message || 'Review saved.')
      setNotesById((prev) => ({ ...prev, [proposalId]: '' }))
      await load()
    } catch (e) {
      setError(e.message || 'Unable to save human review')
    } finally {
      setBusyAction('')
    }
  }

  const pendingCount = proposals.filter((proposal) => proposal.status === 'pending_review').length
  const approvedCount = proposals.filter((proposal) => proposal.status === 'approved_for_preflight').length

  return (
    <section className="rounded border border-[#232738] bg-[#0C0E16] p-4">
      <div className="mb-4 flex flex-wrap items-start justify-between gap-3">
        <div>
          <div className="flex items-center gap-2 font-mono text-xs font-bold uppercase tracking-wider text-[#00F0FF]">
            <Sparkles className="h-3.5 w-3.5" /> AI Strategy Generator · Human Review
          </div>
          <p className="mt-1 max-w-3xl text-[0.68rem] leading-relaxed text-[#8a90b0]">
            Generate candidate strategies for DEX arbitrage, collateral swaps, liquidations and debt refinancing. Each candidate is stored as a proposal only; approval does not register a contract or start live execution.
          </p>
        </div>
        <button onClick={load} disabled={loading || busyAction !== '' || authLoading} className="inline-flex items-center gap-1 rounded border border-[#232738] px-2.5 py-1.5 font-mono text-[0.58rem] uppercase text-[#8a90b0] hover:border-[#00F0FF]/40 disabled:opacity-40">
          <RefreshCw className={`h-3 w-3 ${loading ? 'animate-spin' : ''}`} /> Refresh
        </button>
      </div>

      {(error || notice) && (
        <div className={`mb-3 flex gap-2 rounded border p-3 text-[0.66rem] leading-relaxed ${error ? 'border-[#FF4D4D]/30 bg-[#FF4D4D]/5 text-[#FF8A8A]' : 'border-[#00FF87]/30 bg-[#00FF87]/5 text-[#8de9bb]'}`}>
          {error ? <AlertTriangle className="mt-0.5 h-3.5 w-3.5 shrink-0" /> : <CheckCircle2 className="mt-0.5 h-3.5 w-3.5 shrink-0" />}
          <span>{error || notice}</span>
        </div>
      )}

      <div className="mb-4 grid grid-cols-1 gap-2 sm:grid-cols-3">
        <div className="rounded border border-[#232738] bg-[#090A0F] p-3">
          <div className="font-mono text-[0.52rem] uppercase text-[#5a6080]">Saved proposals</div>
          <div className="mt-1 font-mono text-lg text-[#e0e4f0]">{proposals.length}</div>
        </div>
        <div className="rounded border border-[#232738] bg-[#090A0F] p-3">
          <div className="font-mono text-[0.52rem] uppercase text-[#5a6080]">Awaiting review</div>
          <div className="mt-1 font-mono text-lg text-[#FFB800]">{pendingCount}</div>
        </div>
        <div className="rounded border border-[#232738] bg-[#090A0F] p-3">
          <div className="font-mono text-[0.52rem] uppercase text-[#5a6080]">Approved for preflight</div>
          <div className="mt-1 font-mono text-lg text-[#00F0FF]">{approvedCount}</div>
        </div>
      </div>

      <form onSubmit={generate} className="space-y-3 rounded border border-[#232738] bg-[#090A0F] p-3 sm:p-4">
        <div className="grid gap-3 sm:grid-cols-[minmax(0,0.8fr)_minmax(0,1.2fr)]">
          <label className="block">
            <span className="mb-1.5 block font-mono text-[0.55rem] uppercase tracking-wider text-[#8a90b0]">Strategy category</span>
            <select value={category} onChange={(event) => setCategory(event.target.value)} className="w-full rounded border border-[#232738] bg-[#0C0E16] px-2.5 py-2 font-mono text-xs text-[#e0e4f0]">
              {CATEGORY_OPTIONS.map((option) => <option key={option.id} value={option.id}>{option.label}</option>)}
            </select>
            <span className="mt-1.5 block text-[0.62rem] leading-relaxed text-[#5a6080]">{CATEGORY_OPTIONS.find((item) => item.id === category)?.description}</span>
          </label>
          <label className="block">
            <span className="mb-1.5 block font-mono text-[0.55rem] uppercase tracking-wider text-[#8a90b0]">Objective and constraints</span>
            <textarea
              value={objective}
              onChange={(event) => setObjective(event.target.value)}
              maxLength={1200}
              rows={3}
              placeholder="Describe the market condition, target pair/protocol, constraints and risk tolerance. Do not include secrets or private keys."
              className="w-full resize-y rounded border border-[#232738] bg-[#0C0E16] px-2.5 py-2 font-mono text-xs text-[#e0e4f0] outline-none focus:border-[#00F0FF]/50"
            />
          </label>
        </div>
        <div className="flex flex-wrap items-center justify-between gap-3">
          <p className="max-w-2xl text-[0.6rem] leading-relaxed text-[#5a6080]">
            Fixed proposal guardrails: up to $1,000 notional, up to 30 bps slippage and up to $100 gas budget. These are proposal caps, not execution permissions or profitability guarantees.
          </p>
          <button disabled={busyAction !== '' || loading || authLoading} className="inline-flex items-center justify-center gap-1.5 rounded border border-[#00F0FF]/50 bg-[#00F0FF]/5 px-4 py-2 font-mono text-[0.62rem] font-bold uppercase text-[#00F0FF] disabled:opacity-40">
            <Sparkles className="h-3.5 w-3.5" /> {busyAction === 'generate' ? 'Generating…' : 'Generate proposal'}
          </button>
        </div>
      </form>

      <div className="mt-4 rounded border border-[#232738] bg-[#090A0F] p-3">
        <div className="mb-2 font-mono text-[0.55rem] uppercase tracking-wider text-[#8a90b0]">Execution pipeline gates</div>
        <div className="grid grid-cols-2 gap-2 sm:grid-cols-4 xl:grid-cols-7">
          {PIPELINE_STAGES.map((stage, index) => {
            const complete = index === 0 && proposals.length > 0
            const humanGate = index === 1
            return (
              <div key={stage} className="rounded border border-[#232738] p-2">
                <div className="font-mono text-[0.5rem] text-[#5a6080]">0{index + 1}</div>
                <div className="mt-1 font-mono text-[0.56rem] text-[#c6cbe0]">{stage}</div>
                <div className={`mt-1 font-mono text-[0.48rem] uppercase ${complete ? 'text-[#00FF87]' : humanGate ? 'text-[#FFB800]' : 'text-[#5a6080]'}`}>
                  {complete ? 'proposal stored' : humanGate ? 'required' : 'gated'}
                </div>
              </div>
            )
          })}
        </div>
        <p className="mt-3 flex gap-2 text-[0.63rem] leading-relaxed text-[#8a90b0]">
          <ShieldCheck className="mt-0.5 h-3.5 w-3.5 shrink-0 text-[#00F0FF]" />
          Only the proposal and human-review stages are implemented here. Builder/simulator support must be added and verified per protocol before the signer or atomic executor can be authorized. Nothing in this panel broadcasts transactions.
        </p>
      </div>

      <div className="mt-4">
        <div className="mb-2 font-mono text-[0.58rem] font-semibold uppercase tracking-wider text-[#8a90b0]">Proposal review queue</div>
        {loading ? (
          <div className="font-mono text-[0.62rem] text-[#5a6080]">Loading strategy proposals…</div>
        ) : proposals.length ? (
          <div className="space-y-3">
            {proposals.map((proposal) => (
              <ProposalCard
                key={proposal.id}
                proposal={proposal}
                busy={busyAction !== ''}
                reviewNotes={notesById[proposal.id] || ''}
                onNotesChange={(id, value) => setNotesById((prev) => ({ ...prev, [id]: value }))}
                onReview={review}
              />
            ))}
          </div>
        ) : (
          <div className="rounded border border-[#232738] bg-[#090A0F] p-4 text-center font-mono text-[0.62rem] leading-relaxed text-[#5a6080]">
            No strategy proposals yet. Generate a proposal to add it to the human review queue.
          </div>
        )}
      </div>
    </section>
  )
}
