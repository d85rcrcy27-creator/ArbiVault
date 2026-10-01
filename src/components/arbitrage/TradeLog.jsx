import TradeRow from './TradeRow';

export default function TradeLog({ trades = [] }) {
  return (
    <div className="flex h-full flex-col rounded border border-[#232738] bg-[#0C0E16]">
      <div className="flex items-center justify-between border-b border-[#232738] px-4 py-3">
        <span className="font-mono text-xs font-bold uppercase tracking-wider text-[#00F0FF]">Trade Log</span>
        <span className="font-mono text-[0.625rem] text-[#5a6080]">{trades.length} filled</span>
      </div>
      <div className="scrollbar-thin min-h-0 flex-1 overflow-y-auto">
        {trades.length === 0 ? (
          <div className="flex h-full items-center justify-center px-4 py-10 text-center font-mono text-[0.6875rem] text-[#3a4060]">
            No executions yet — waiting for a qualifying spread.
          </div>
        ) : (
          trades.map((t) => <TradeRow key={t.id} trade={t} />)
        )}
      </div>
    </div>
  );
}
