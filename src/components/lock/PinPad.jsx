import { Delete } from 'lucide-react';
import { cn } from '@/lib/utils';
import { PIN_LENGTH } from '@/lib/security';

const KEYS = ['1', '2', '3', '4', '5', '6', '7', '8', '9', '', '0', 'del'];

export default function PinPad({ value, onKey, disabled = false }) {
  return (
    <div className="space-y-6">
      <div className="flex justify-center gap-2" aria-label={`${value.length} of ${PIN_LENGTH} digits entered`}>
        {Array.from({ length: PIN_LENGTH }).map((_, i) => (
          <span
            key={i}
            className={cn(
              'h-3 w-3 rounded-full transition-all',
              i < value.length ? 'bg-primary glow-cyan' : 'bg-secondary'
            )}
          />
        ))}
      </div>

      <div className="grid grid-cols-3 gap-2">
        {KEYS.map((key, i) => (
          <button
            key={i}
            type="button"
            aria-label={key === 'del' ? 'Delete' : key || undefined}
            onClick={() => key && onKey(key)}
            disabled={disabled || !key}
            className={cn(
              'flex h-14 items-center justify-center rounded-xl border border-border bg-secondary text-lg font-mono font-semibold text-foreground transition-all',
              'hover:border-primary/40 hover:bg-primary/5 disabled:opacity-0'
            )}
          >
            {key === 'del' ? <Delete className="h-5 w-5" /> : key}
          </button>
        ))}
      </div>
    </div>
  );
}
