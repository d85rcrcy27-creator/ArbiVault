import { useEffect, useState } from 'react'
import { Activity, RefreshCw, ShieldCheck, CreditCard } from 'lucide-react'
import { ensureBotFleet, listBotFleet, updateBotConfig } from '@/lib/arbivault'
import { useAuth } from '@/lib/AuthContext'
import { getAuthenticatedSession } from '@/lib/supabase'

const META = {
  execution: { label: 'Execution Bot', icon: Activity, desc: 'Scans qualifying spreads and records bounded executions.' },
  sync: { label: 'Sync Bot', icon: RefreshCw, desc: 'Reconciles wallet balances and verification state.' },
  payment: { label: 'Payment Processing Bot', icon: CreditCard, desc: 'Processes payment lifecycle and crypto-payment reconciliation.' },
}

export default function BotFleet() {
  const [bots, setBots] = useState([])
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState('')
  const { user, isLoading: authLoading } = useAuth()

  const load = async () => {
    setLoading(true)
    try {
      await getAuthenticatedSession()
      await ensureBotFleet()
      setBots(await listBotFleet())
      setError('')
    } catch (e) {
      setBots([])
      setError(e.message || 'Unable to load bot fleet')
    } finally {
      setLoading(false)
    }  }

  useEffect(() => {
    if (!authLoading) load()
  }, [authLoading, user?.id])

  const toggle = async (bot) => {
    try {
      const saved = await updateBotConfig(bot.id, { enabled: !bot.enabled })
      setBots((prev) => prev.map((b) => b.id === saved.id ? saved : b))
    } catch (e) {
      setError(e.message || 'Unable to update bot')
    }
  }

  return (
    <div className="rounded border border-[#232738] bg-[#0C0E16] p-4">
      <div className="mb-4 flex items-center justify-between">
        <div>
          <div className="flex items-center gap-2 font-mono text-xs font-bold uppercase tracking-wider text-[#00F0FF]"><ShieldCheck className="h-3.5 w-3.5" /> Bot Fleet</div>
          <p className="mt-1 text-[0.65rem] text-[#5a6080]">Three dedicated workers share the same audited wallet, trade and payment state.</p>
        </div>
        <button onClick={load} disabled={authLoading} className="text-[#5a6080] hover:text-[#00F0FF] disabled:opacity-50"><RefreshCw className="h-3.5 w-3.5" /></button>
      </div>
      {error && <div className="mb-3 rounded border border-[#FF4D4D]/30 bg-[#FF4D4D]/5 p-2 font-mono text-[0.6rem] text-[#FF4D4D]">{error}</div>}
      <div className="grid gap-2 md:grid-cols-3">
        {bots.map((bot) => {
          const meta = META[bot.bot_role] || META.execution
          const Icon = meta.icon
          return <div key={bot.id} className="rounded border border-[#232738] bg-[#090A0F] p-3">
            <div className="flex items-center gap-2"><Icon className="h-3.5 w-3.5 text-[#00F0FF]" /><span className="font-mono text-[0.65rem] font-semibold uppercase text-[#e0e4f0]">{meta.label}</span></div>
            <p className="mt-2 min-h-8 text-[0.58rem] text-[#5a6080]">{meta.desc}</p>
            <div className="mt-3 flex items-center justify-between border-t border-[#232738] pt-2">
              <span className={`font-mono text-[0.55rem] ${bot.enabled ? 'text-[#00FF87]' : 'text-[#5a6080]'}`}>{bot.enabled ? 'ACTIVE' : 'PAUSED'}</span>
              <button onClick={() => toggle(bot)} className={`h-4 w-7 rounded-full p-0.5 ${bot.enabled ? 'bg-[#00FF87]/30' : 'bg-[#232738]'}`}><span className={`block h-3 w-3 rounded-full ${bot.enabled ? 'translate-x-3 bg-[#00FF87]' : 'bg-[#5a6080]'}`} /></button>
            </div>
            {bot.last_error && <p className="mt-2 truncate font-mono text-[0.5rem] text-[#FF4D4D]" title={bot.last_error}>{bot.last_error}</p>}
          </div>
        })}
      </div>
      {loading && <div className="mt-3 font-mono text-[0.6rem] text-[#5a6080]">{authLoading ? 'Waiting for Supabase session…' : 'Loading bot fleet…'}</div>}
    </div>
  )
}
