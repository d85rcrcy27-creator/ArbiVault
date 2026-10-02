import { useState } from 'react';
import {
  ArrowUpFromLine,
  ArrowDownToLine,
  ArrowLeftRight,
  TrendingUp,
  Landmark,
  CreditCard,
  Banknote,
  Hash,
} from 'lucide-react';

import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';

// Simulated wallet actions — same demo nature as the rest of the live feed:
// no keys are handled and nothing touches a real chain.
const VAULT_ADDRESS = '0x7A2f4b91Ce3D58aA0192Ee4C5566B1dD9fF2A0cB';
const TOKENS = ['BTC', 'ETH', 'SOL', 'USDT'];
const PRICES = { BTC: 67250, ETH: 3480, SOL: 152, USDT: 1 };
const CHAINS = ['Ethereum', 'Arbitrum', 'Base', 'BSC'];

const ACTIONS = [
  { id: 'send', label: 'Send', icon: ArrowUpFromLine },
  { id: 'receive', label: 'Receive', icon: ArrowDownToLine },
  { id: 'swap', label: 'Swap', icon: ArrowLeftRight },
  { id: 'trade', label: 'Trade', icon: TrendingUp },
  { id: 'bridge', label: 'Bridge', icon: Landmark },
  { id: 'buy', label: 'Buy', icon: CreditCard },
  { id: 'withdraw', label: 'Withdraw', icon: Banknote },
  { id: 'tx', label: 'TX Hash', icon: Hash },
];

const fakeTxId = () =>
  `0x${Math.random().toString(16).slice(2, 10)}${Math.random().toString(16).slice(2, 10)}`;

const btnCls =
  'flex flex-col items-center justify-center gap-1.5 rounded border border-[#232738] bg-[#0C0E16] py-2.5 font-mono text-[0.625rem] font-semibold uppercase tracking-wider text-[#8a90b0] transition-colors hover:border-[#00F0FF]/40 hover:text-[#00F0FF]';
const labelCls =
  'mb-1 block font-mono text-[0.625rem] font-semibold uppercase tracking-wider text-[#5a6080]';
const inputCls = 'border-[#232738] bg-[#090A0F] font-mono text-xs text-[#e0e4f0]';
const confirmBtnCls =
  'bg-[#00F0FF] font-mono text-[0.6875rem] font-semibold uppercase tracking-wider text-[#090A0F] hover:bg-[#00F0FF]/80';

function Field({ label, children }) {
  return (
    <div>
      <span className={labelCls}>{label}</span>
      {children}
    </div>
  );
}

function TokenSelect({ value, onChange, options = TOKENS }) {
  return (
    <select
      value={value}
      onChange={(e) => onChange(e.target.value)}
      className={`${inputCls} h-9 w-full rounded border px-2`}
    >
      {options.map((t) => (
        <option key={t} value={t}>
          {t}
        </option>
      ))}
    </select>
  );
}

function Confirmed({ message, onDone }) {
  const [copied, setCopied] = useState(false);
  const txid = fakeTxId();
  return (
    <div className="flex flex-col gap-3">
      <div className="rounded border border-[#00FF87]/30 bg-[#00FF87]/5 p-3 font-mono text-xs text-[#00FF87]">
        {message} · simulated
      </div>
      <button
        onClick={() => {
          navigator.clipboard?.writeText(txid);
          setCopied(true);
          setTimeout(() => setCopied(false), 1500);
        }}
        className="truncate text-left font-mono text-[0.625rem] text-[#5a6080] transition-colors hover:text-[#00F0FF]"
        title={txid}
      >
        TX: {copied ? 'copied!' : `${txid.slice(0, 18)}…${txid.slice(-6)}`}
      </button>
      <Button onClick={onDone} className={confirmBtnCls}>
        Done
      </Button>
    </div>
  );
}

export default function WalletActions() {
  const [active, setActive] = useState(null);
  const [done, setDone] = useState(null);
  const [address, setAddress] = useState('');
  const [amount, setAmount] = useState('');
  const [fromToken, setFromToken] = useState('USDT');
  const [toToken, setToToken] = useState('BTC');
  const [fromChain, setFromChain] = useState('Ethereum');
  const [toChain, setToChain] = useState('Arbitrum');
  const [side, setSide] = useState('BUY');
  const [hash, setHash] = useState('');
  const [error, setError] = useState('');

  const close = () => {
    setActive(null);
    setDone(null);
    setError('');
  };

  const num = parseFloat(amount);
  const requireAmount = (message) => {
    if (!num || num <= 0) {
      setError(message);
      return false;
    }
    return true;
  };

  const confirm = (message) => {
    setError('');
    setDone(message);
  };

  const swapRate = PRICES[fromToken] / PRICES[toToken];

  const content = () => {
    if (done) return <Confirmed message={done} onDone={close} />;

    switch (active) {
      case 'send':
        return (
          <div className="flex flex-col gap-3">
            <Field label="Recipient address">
              <Input
                value={address}
                onChange={(e) => setAddress(e.target.value)}
                placeholder="0x…"
                className={inputCls}
              />
            </Field>
            <Field label="Amount">
              <Input
                value={amount}
                onChange={(e) => setAmount(e.target.value)}
                placeholder="0.00"
                className={inputCls}
              />
            </Field>
            <Field label="Token">
              <TokenSelect value={toToken} onChange={setToToken} />
            </Field>
            {error && <p className="font-mono text-[0.625rem] text-[#FF4D4D]">{error}</p>}
            <Button
              onClick={() => {
                if (address.trim().length < 8) return setError('Enter a valid recipient address.');
                if (!requireAmount('Enter an amount greater than 0.')) return;
                confirm(`Sent ${num} ${toToken} to ${address.slice(0, 8)}…`);
              }}
              className={confirmBtnCls}
            >
              Confirm send
            </Button>
          </div>
        );
      case 'receive':
        return (
          <div className="flex flex-col gap-3">
            <p className="font-mono text-[0.625rem] text-[#5a6080]">
              Share your vault address to receive funds.
            </p>
            <code className="break-all rounded border border-[#232738] bg-[#090A0F] p-3 font-mono text-xs text-[#00F0FF]">
              {VAULT_ADDRESS}
            </code>
            <Button
              onClick={() => navigator.clipboard?.writeText(VAULT_ADDRESS)}
              variant="outline"
              className="border-[#232738] bg-transparent font-mono text-[0.6875rem] uppercase tracking-wider text-[#8a90b0] hover:text-[#00F0FF]"
            >
              Copy address
            </Button>
          </div>
        );
      case 'swap':
        return (
          <div className="flex flex-col gap-3">
            <Field label="From">
              <TokenSelect value={fromToken} onChange={setFromToken} />
            </Field>
            <Field label="To">
              <TokenSelect value={toToken} onChange={setToToken} />
            </Field>
            <Field label="Amount">
              <Input
                value={amount}
                onChange={(e) => setAmount(e.target.value)}
                placeholder="0.00"
                className={inputCls}
              />
            </Field>
            <p className="font-mono text-[0.625rem] text-[#FFB800]">
              1 {fromToken} ≈ {swapRate.toFixed(6)} {toToken}
            </p>
            {error && <p className="font-mono text-[0.625rem] text-[#FF4D4D]">{error}</p>}
            <Button
              onClick={() => {
                if (fromToken === toToken) return setError('Pick two different tokens.');
                if (!requireAmount('Enter an amount greater than 0.')) return;
                confirm(`Swapped ${num} ${fromToken} → ${(num * swapRate).toFixed(6)} ${toToken}`);
              }}
              className={confirmBtnCls}
            >
              Confirm swap
            </Button>
          </div>
        );
      case 'trade':
        return (
          <div className="flex flex-col gap-3">
            <div className="flex gap-1 rounded border border-[#232738] bg-[#0C0E16] p-1">
              {['BUY', 'SELL'].map((s) => (
                <button
                  key={s}
                  onClick={() => setSide(s)}
                  className={`flex-1 rounded py-1.5 font-mono text-[0.6875rem] font-semibold uppercase tracking-wider transition-colors ${
                    side === s
                      ? s === 'BUY'
                        ? 'bg-[#00FF87]/10 text-[#00FF87]'
                        : 'bg-[#FF4D4D]/10 text-[#FF4D4D]'
                      : 'text-[#5a6080]'
                  }`}
                >
                  {s}
                </button>
              ))}
            </div>
            <Field label="Pair">
              <select
                value={toToken}
                onChange={(e) => setToToken(e.target.value)}
                className={`${inputCls} h-9 w-full rounded border px-2`}
              >
                {TOKENS.map((t) => (
                  <option key={t} value={t}>
                    {t}/USDT
                  </option>
                ))}
              </select>
            </Field>
            <Field label={`Amount (${toToken})`}>
              <Input
                value={amount}
                onChange={(e) => setAmount(e.target.value)}
                placeholder="0.00"
                className={inputCls}
              />
            </Field>
            {error && <p className="font-mono text-[0.625rem] text-[#FF4D4D]">{error}</p>}
            <Button
              onClick={() => {
                if (!requireAmount('Enter an amount greater than 0.')) return;
                confirm(`${side} ${num} ${toToken}/USDT @ $${PRICES[toToken].toLocaleString()}`);
              }}
              className={confirmBtnCls}
            >
              Confirm {side.toLowerCase()}
            </Button>
          </div>
        );
      case 'bridge':
        return (
          <div className="flex flex-col gap-3">
            <Field label="From chain">
              <TokenSelect value={fromChain} onChange={setFromChain} options={CHAINS} />
            </Field>
            <Field label="To chain">
              <TokenSelect value={toChain} onChange={setToChain} options={CHAINS} />
            </Field>
            <Field label="Amount (USDT)">
              <Input
                value={amount}
                onChange={(e) => setAmount(e.target.value)}
                placeholder="0.00"
                className={inputCls}
              />
            </Field>
            {error && <p className="font-mono text-[0.625rem] text-[#FF4D4D]">{error}</p>}
            <Button
              onClick={() => {
                if (fromChain === toChain) return setError('Pick two different chains.');
                if (!requireAmount('Enter an amount greater than 0.')) return;
                confirm(`Bridged ${num} USDT ${fromChain} → ${toChain}`);
              }}
              className={confirmBtnCls}
            >
              Confirm bridge
            </Button>
          </div>
        );
      case 'buy':
        return (
          <div className="flex flex-col gap-3">
            <Field label="Token">
              <TokenSelect value={toToken} onChange={setToToken} />
            </Field>
            <Field label={`Amount (USD → ${toToken})`}>
              <Input
                value={amount}
                onChange={(e) => setAmount(e.target.value)}
                placeholder="0.00"
                className={inputCls}
              />
            </Field>
            <p className="font-mono text-[0.625rem] text-[#FFB800]">
              ≈ {(num / PRICES[toToken]).toFixed(6)} {toToken}
            </p>
            {error && <p className="font-mono text-[0.625rem] text-[#FF4D4D]">{error}</p>}
            <Button
              onClick={() => {
                if (!requireAmount('Enter a USD amount greater than 0.')) return;
                confirm(`Bought ${(num / PRICES[toToken]).toFixed(6)} ${toToken} with $${num}`);
              }}
              className={confirmBtnCls}
            >
              Pay with card
            </Button>
          </div>
        );
      case 'withdraw':
        return (
          <div className="flex flex-col gap-3">
            <Field label="Destination address">
              <Input
                value={address}
                onChange={(e) => setAddress(e.target.value)}
                placeholder="0x…"
                className={inputCls}
              />
            </Field>
            <Field label="Amount (USDT)">
              <Input
                value={amount}
                onChange={(e) => setAmount(e.target.value)}
                placeholder="0.00"
                className={inputCls}
              />
            </Field>
            {error && <p className="font-mono text-[0.625rem] text-[#FF4D4D]">{error}</p>}
            <Button
              onClick={() => {
                if (address.trim().length < 8) return setError('Enter a valid destination address.');
                if (!requireAmount('Enter an amount greater than 0.')) return;
                confirm(`Withdrew ${num} USDT to ${address.slice(0, 8)}…`);
              }}
              className={confirmBtnCls}
            >
              Confirm withdraw
            </Button>
          </div>
        );
      case 'tx': {
        const valid = /^0x[0-9a-fA-F]{16,64}$/.test(hash.trim());
        return (
          <div className="flex flex-col gap-3">
            <Field label="Transaction hash">
              <Input
                value={hash}
                onChange={(e) => setHash(e.target.value)}
                placeholder="0x…"
                className={inputCls}
              />
            </Field>
            {error && <p className="font-mono text-[0.625rem] text-[#FF4D4D]">{error}</p>}
            {valid && (
              <div className="rounded border border-[#232738] bg-[#0C0E16] p-3 font-mono text-[0.625rem] text-[#8a90b0]">
                <div className="flex justify-between">
                  <span>Status</span>
                  <span className="text-[#00FF87]">Confirmed</span>
                </div>
                <div className="mt-1 flex justify-between">
                  <span>Block</span>
                  <span className="text-[#e0e4f0]">
                    #{(parseInt(hash.slice(2, 10), 16) % 9_000_000) + 20_000_000}
                  </span>
                </div>
                <div className="mt-1 flex justify-between">
                  <span>Fee</span>
                  <span className="text-[#FFB800]">
                    ${((parseInt(hash.slice(-6), 16) % 40) / 10 + 0.4).toFixed(2)}
                  </span>
                </div>
              </div>
            )}
            <Button
              onClick={() => {
                if (!valid) return setError('Enter a valid transaction hash (0x + hex).');
              }}
              variant="outline"
              className="border-[#232738] bg-transparent font-mono text-[0.6875rem] uppercase tracking-wider text-[#8a90b0] hover:text-[#00F0FF]"
            >
              Look up
            </Button>
          </div>
        );
      }
      default:
        return null;
    }
  };

  return (
    <div className="px-3 pt-3 lg:px-4 lg:pt-0">
      <div className="grid grid-cols-4 gap-2 lg:grid-cols-8">
        {ACTIONS.map(({ id, label, icon: Icon }) => (
          <button key={id} onClick={() => setActive(id)} className={btnCls}>
            <Icon className="h-4 w-4" />
            {label}
          </button>
        ))}
      </div>
      <Dialog open={!!active} onOpenChange={(open) => !open && close()}>
        <DialogContent className="border-[#232738] bg-[#0C0E16] text-[#e0e4f0]">
          <DialogHeader>
            <DialogTitle className="font-mono text-sm font-semibold uppercase tracking-wider">
              {ACTIONS.find((a) => a.id === active)?.label ?? ''}
            </DialogTitle>
          </DialogHeader>
          {content()}
        </DialogContent>
      </Dialog>
    </div>
  );
}
