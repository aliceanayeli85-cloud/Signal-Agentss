import { clockTime, price } from '../lib/format.js';
import { Badge } from './ui.js';

const CATEGORY: Record<string, { tone: 'info' | 'paper' | 'warn'; label: string }> = {
  PRICE_ALERT: { tone: 'info', label: 'Price alert — not an order' },
  SIMULATED_ORDER: { tone: 'paper', label: 'Simulated order (paper)' },
  SYSTEM: { tone: 'warn', label: 'System' },
  AGENT: { tone: 'info', label: 'Agent research — not an order' },
};

export function AlertItem({ a }: { a: any }) {
  const c = CATEGORY[a.category] ?? CATEGORY.SYSTEM!;
  return (
    <div className={`rounded-lg border border-line p-2 ${a.read_at ? 'bg-panel' : 'bg-panel2'}`}>
      <div className="flex flex-wrap items-center gap-1.5">
        <Badge tone={c.tone}>{c.label}</Badge>
        {a.mode === 'live' && <Badge tone="warn">real position</Badge>}
      </div>
      <div className="mt-1 text-sm font-semibold">{a.title}</div>
      <div className="text-xs text-ink/85">{a.reason}</div>
      <div className="mt-1 text-[10px] text-dim">
        Recorded {clockTime(a.created_at)}
        {a.price !== null && ` · price ${price(a.price)} at ${clockTime(a.price_at)}`}
      </div>
    </div>
  );
}
