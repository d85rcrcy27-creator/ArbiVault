import { useState } from 'react'
import { Copy, Check } from 'lucide-react'

export default function TradeRow({ trade }) {
  const [copied, setCopied] = useState(false)
  const win = trade.pnl >= 0
  const time = new Date(trade.ts).toLocaleTimeString('en-US', { hour12: false })
  const txHash = trade.txid

  const copy = () => {
    if (!txHash) return
    navigator.clipboard?.writeText(txHash)
    setCopied(true)
    setTimeout(() => setCopied(false), 1500)
  }

  return (
    <div className="border-b border-[#1a1d2b] px-3 py-2.5">
      <div className="flex items-center justify-between gap-2">
        <div className="flex min-w-0 items-center gap-2">
          <span className={`h-1.5 w-1.5 shrink-0 rounded-full ${win ? 'bg-[#00FF87]' : 'bg-[#FF4D4D]'}`} />
          <span className="truncate font-mono text-xs font-semibold text-[#e0e4f0]">{trade.pair}</span>
          <span className="shrink-0 rounded bg-[#12141D] px-1.5 py-0.5 font-mono text-[0.5625rem] text-[#5a6080]">{trade.buyExchange}→{trade.sellExchange}</span>
        </div>
        <span className={`shrink-0 font-mono text-xs font-semibold ${win ? 'text-[#00FF87]' : 'text-[#FF4D4D]'}`}>{win ? '+' : '-'}${Math.abs(trade.pnl).toFixed(2)}</span>
      </div>
      <div className="mt-1 flex items-center justify-between gap-2 pl-3.5">
        <div className="flex items-center gap-2 font-mono text-[0.625rem] text-[#5a6080]"><span>{time}</span><span className="text-[#FFB800]">{trade.spreadPct.toFixed(3)}%</span><span className="truncate">{trade.strategy}</span></div>
        {txHash ? (
          <button onClick={copy} className="flex shrink-0 items-center gap-1 font-mono text-[0.625rem] text-[#3a4060] hover:text-[#00F0FF]" title={txHash}>{copied ? <Check className="h-2.5 w-2.5" /> : <Copy className="h-2.5 w-2.5" />}{txHash.slice(0, 6)}…{txHash.slice(-4)}</button>
        ) : (
          <span className="shrink-0 rounded border border-[#FFB800]/20 bg-[#FFB800]/5 px-1.5 py-0.5 font-mono text-[0.55rem] text-[#FFB800]">SIMULATED · NO TX HASH</span>
        )}
      </div>
    </div>
  )
}
