import { useState } from 'react';
import { Copy, Check } from 'lucide-react';

export default function TradeRow({ trade }) {
  const [copied, setCopied] = useState(false);
  const win = trade.pnl >= 0;
  const time = new Date(trade.ts).toLocaleTimeString('en-US', { hour12: false });

  const copy = () => {
    navigator.clipboard?.writeText(trade.txid);
    setCopied(true);
    setTimeout(() => setCopied(false), 1500);
  };

  return (
    <div className="border-b border-[#1a1d2b] px-3 py-2.5">
      <div className="flex items-center justify-between gap-2">
        <div className="flex min-w-0 items-center gap-2">