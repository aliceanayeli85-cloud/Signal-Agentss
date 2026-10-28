import { useState, type ReactNode } from 'react';

export function Card({ title, right, children, className = '' }: { title?: ReactNode; right?: ReactNode; children: ReactNode; className?: string }) {
  return (
    <section className={`rounded-xl border border-line bg-panel p-3 ${className}`}>
      {(title || right) && (
        <div className="mb-2 flex items-center justify-between gap-2">
          <h2 className="text-sm font-semibold tracking-wide text-dim uppercase">{title}</h2>
          {right}
        </div>
      )}
      {children}
    </section>
  );
}

const TONES = {
  up: 'bg-up/15 text-up border-up/30',
  down: 'bg-down/15 text-down border-down/30',
  warn: 'bg-warn/15 text-warn border-warn/30',
  info: 'bg-info/15 text-info border-info/30',
  paper: 'bg-paper/15 text-paper border-paper/30',
  dim: 'bg-panel2 text-dim border-line',
} as const;
export type Tone = keyof typeof TONES;

export function Badge({ tone = 'dim', children }: { tone?: Tone; children: ReactNode }) {
  return <span className={`inline-flex items-center rounded-md border px-1.5 py-0.5 text-[11px] font-semibold uppercase ${TONES[tone]}`}>{children}</span>;
}

export function Banner({ tone, title, children }: { tone: Tone; title: ReactNode; children?: ReactNode }) {
  return (
    <div className={`rounded-xl border p-3 text-sm ${TONES[tone]}`} role="status">
      <div className="font-semibold">{title}</div>
      {children && <div className="mt-1 text-ink/85">{children}</div>}
    </div>
  );
}

export function Stat({ label, value, sub, className = '' }: { label: ReactNode; value: ReactNode; sub?: ReactNode; className?: string }) {
  return (
    <div className="min-w-0">
      <div className="text-[11px] text-dim uppercase">{label}</div>
      <div className={`num truncate text-base font-semibold ${className}`}>{value}</div>
      {sub && <div className="text-[11px] text-dim">{sub}</div>}
    </div>
  );
}

export function Button({ children, onClick, tone = 'default', disabled, type = 'button', className = '' }: { children: ReactNode; onClick?: () => void; tone?: 'default' | 'primary' | 'danger' | 'ghost'; disabled?: boolean; type?: 'button' | 'submit'; className?: string }) {
  const styles = {
    default: 'bg-panel2 border-line text-ink',
    primary: 'bg-info text-bg border-info font-semibold',
    danger: 'bg-down text-bg border-down font-semibold',
    ghost: 'bg-transparent border-transparent text-info',
  }[tone];
  return (
    <button type={type} onClick={onClick} disabled={disabled} className={`min-h-11 rounded-lg border px-3 text-sm active:opacity-80 disabled:opacity-40 ${styles} ${className}`}>
      {children}
    </button>
  );
}

export function Field({ label, children, hint }: { label: string; children: ReactNode; hint?: ReactNode }) {
  return (
    <label className="block text-sm">
      <span className="mb-1 block text-dim">{label}</span>
      {children}
      {hint && <span className="mt-1 block text-[11px] text-dim">{hint}</span>}
    </label>
  );
}

export const inputClass = 'w-full rounded-lg border border-line bg-bg px-3 py-2 text-ink outline-none focus:border-info';

/** A tap-to-expand plain-English explanation of a trading term. */
export function Explain({ term, children }: { term: string; children: ReactNode }) {
  const [open, setOpen] = useState(false);
  return (
    <span className="inline">
      <button type="button" onClick={() => setOpen(!open)} className="ml-1 inline-flex h-5 w-5 items-center justify-center rounded-full border border-line text-[11px] text-dim" aria-label={`What is ${term}?`} aria-expanded={open}>
        ?
      </button>
      {open && <span className="mt-1 block rounded-lg border border-line bg-panel2 p-2 text-xs text-ink/90">{children}</span>}
    </span>
  );
}

export function ErrorBox({ error }: { error: { message: string } | null }) {
  if (!error) return null;
  return <Banner tone="down" title="Problem">{error.message}</Banner>;
}

export function Row({ label, children }: { label: ReactNode; children: ReactNode }) {
  return (
    <div className="flex items-start justify-between gap-3 border-b border-line/60 py-1.5 text-sm last:border-0">
      <span className="text-dim">{label}</span>
      <span className="num text-right">{children}</span>
    </div>
  );
}

export function Segmented<T extends string>({ value, options, onChange }: { value: T; options: { value: T; label: string }[]; onChange: (v: T) => void }) {
  return (
    <div className="flex rounded-lg border border-line bg-bg p-0.5">
      {options.map((o) => (
        <button key={o.value} type="button" onClick={() => onChange(o.value)} className={`min-h-9 flex-1 rounded-md px-2 text-xs ${value === o.value ? 'bg-panel2 font-semibold text-ink' : 'text-dim'}`}>
          {o.label}
        </button>
      ))}
    </div>
  );
}
