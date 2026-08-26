import type { ReactNode } from 'react';
import { EXPLANATIONS } from '../../shared/education.js';
import { fmtAgo } from '../lib/format.js';
import { useNow } from '../lib/useApi.js';

export function Panel({
  title,
  subtitle,
  actions,
  children,
  className = '',
  explainKey,
}: {
  title: string;
  subtitle?: ReactNode;
  actions?: ReactNode;
  children: ReactNode;
  className?: string;
  explainKey?: string;
}) {
  return (
    <section
      // shrink-0 matters: these sit inside scrolling flex columns, and without it
      // the flexbox default shrinks them and silently clips their content.
      className={`flex min-h-0 shrink-0 flex-col rounded border border-term-border bg-term-panel ${className}`}
    >
      <header className="flex shrink-0 items-center justify-between gap-3 border-b border-term-border px-3 py-2">
        <div className="min-w-0">
          <div className="flex items-center gap-2">
            <h2 className="truncate text-[11px] font-semibold uppercase tracking-widest text-term-muted">
              {title}
            </h2>
            {explainKey ? <Explain termKey={explainKey} /> : null}
          </div>
          {subtitle ? <div className="mt-0.5 truncate text-[11px] text-term-dim">{subtitle}</div> : null}
        </div>
        {actions ? <div className="flex shrink-0 items-center gap-2">{actions}</div> : null}
      </header>
      <div className="min-h-0 flex-1 overflow-auto p-3">{children}</div>
    </section>
  );
}

/**
 * The educational explainer. Every technical term in the UI can carry one; it
 * expands in place so the user never has to leave the chart to find out what a
 * word means.
 */
export function Explain({ termKey }: { termKey: string }) {
  const entry = EXPLANATIONS[termKey];
  if (!entry) return null;
  // Built entirely from inline elements. An explainer must be safe to drop next
  // to any piece of text, including inside a <p>, and <details>/<div> there is
  // invalid HTML that browsers silently restructure - which breaks the layout.
  return (
    <span className="group relative inline-block align-middle">
      <button
        type="button"
        className="inline-flex h-4 w-4 items-center justify-center rounded-full border border-term-border-bright text-[9px] font-bold leading-none text-term-dim transition hover:border-term-info hover:text-term-info focus:border-term-info focus:text-term-info focus:outline-none"
        title={`What is ${entry.term}?`}
        aria-label={`Explain ${entry.term}`}
      >
        ?
      </button>
      <span
        role="tooltip"
        className="invisible absolute left-0 top-6 z-50 w-80 rounded border border-term-border-bright bg-term-panel-2 p-3 text-left opacity-0 shadow-xl transition group-focus-within:visible group-focus-within:opacity-100 group-hover:visible group-hover:opacity-100"
      >
        <span className="mb-1 block text-[11px] font-semibold uppercase tracking-wider text-term-info">
          {entry.term}
        </span>
        <span className="mb-2 block text-xs font-medium text-term-text">{entry.short}</span>
        <span className="block text-[11px] leading-relaxed text-term-muted">{entry.long}</span>
      </span>
    </span>
  );
}

/**
 * The DATA UNAVAILABLE state. Used everywhere a provider could not supply a
 * value, and never styled to look like an empty-but-fine panel.
 */
export function DataUnavailable({ reason, compact = false }: { reason: string; compact?: boolean }) {
  if (compact) {
    return (
      <span className="inline-flex items-center gap-1.5 text-[11px] text-term-warn" title={reason}>
        <span className="inline-block h-1.5 w-1.5 rounded-full bg-term-warn" />
        DATA UNAVAILABLE
      </span>
    );
  }
  return (
    <div className="rounded border border-term-warn/40 bg-term-warn/5 p-3">
      <div className="mb-1 text-[11px] font-bold uppercase tracking-widest text-term-warn">
        Data unavailable
      </div>
      <p className="text-xs leading-relaxed text-term-muted">{reason}</p>
    </div>
  );
}

export function Loading({ label = 'Loading' }: { label?: string }) {
  return (
    <div className="flex items-center gap-2 py-4 text-xs text-term-dim">
      <span className="inline-block h-2 w-2 animate-pulse rounded-full bg-term-info" />
      {label}…
    </div>
  );
}

/** "Last updated: 4 seconds ago", with a stale badge once data ages. */
export function Freshness({
  fetchedAt,
  staleAfterMs = 60_000,
  source,
}: {
  fetchedAt: number | null;
  staleAfterMs?: number;
  source?: string;
}) {
  const now = useNow();
  if (fetchedAt === null) {
    return <span className="text-[11px] text-term-dim">Last updated: {'—'}</span>;
  }
  const stale = now - fetchedAt > staleAfterMs;
  return (
    <span className={`text-[11px] ${stale ? 'text-term-warn' : 'text-term-dim'}`}>
      {source ? `${source} · ` : ''}Last updated: {fmtAgo(fetchedAt, now)}
      {stale ? ' · STALE' : ''}
    </span>
  );
}

export function Button({
  children,
  onClick,
  variant = 'default',
  disabled,
  type = 'button',
  className = '',
  title,
}: {
  children: ReactNode;
  onClick?: () => void;
  variant?: 'default' | 'primary' | 'danger' | 'ghost';
  disabled?: boolean;
  type?: 'button' | 'submit';
  className?: string;
  title?: string;
}) {
  const variants: Record<string, string> = {
    default:
      'border-term-border-bright bg-term-panel-2 text-term-text hover:border-term-info hover:text-term-info',
    primary: 'border-term-info/60 bg-term-info/10 text-term-info hover:bg-term-info/20',
    danger: 'border-term-down/60 bg-term-down/10 text-term-down hover:bg-term-down/20',
    ghost: 'border-transparent bg-transparent text-term-muted hover:text-term-text',
  };
  return (
    <button
      type={type}
      title={title}
      onClick={onClick}
      disabled={disabled}
      className={`rounded border px-2.5 py-1 text-[11px] font-medium uppercase tracking-wide transition disabled:cursor-not-allowed disabled:opacity-40 ${variants[variant]} ${className}`}
    >
      {children}
    </button>
  );
}

export function Field({
  label,
  children,
  hint,
}: {
  label: string;
  children: ReactNode;
  hint?: string;
}) {
  return (
    <label className="block">
      <span className="mb-1 block text-[10px] font-semibold uppercase tracking-widest text-term-dim">
        {label}
      </span>
      {children}
      {hint ? <span className="mt-1 block text-[10px] text-term-dim">{hint}</span> : null}
    </label>
  );
}

export function TextInput({
  value,
  onChange,
  placeholder,
  type = 'text',
  step,
  disabled,
}: {
  value: string | number;
  onChange: (value: string) => void;
  placeholder?: string;
  type?: 'text' | 'number';
  step?: string;
  disabled?: boolean;
}) {
  return (
    <input
      type={type}
      step={step}
      value={value}
      disabled={disabled}
      placeholder={placeholder}
      onChange={(event) => onChange(event.target.value)}
      className="num w-full rounded border border-term-border bg-term-bg px-2 py-1.5 text-xs text-term-text outline-none transition placeholder:text-term-dim focus:border-term-info disabled:opacity-50"
    />
  );
}

export function Select<T extends string>({
  value,
  onChange,
  options,
  disabled,
}: {
  value: T;
  onChange: (value: T) => void;
  options: { value: T; label: string }[];
  disabled?: boolean;
}) {
  return (
    <select
      value={value}
      disabled={disabled}
      onChange={(event) => onChange(event.target.value as T)}
      className="w-full rounded border border-term-border bg-term-bg px-2 py-1.5 text-xs text-term-text outline-none transition focus:border-term-info disabled:opacity-50"
    >
      {options.map((option) => (
        <option key={option.value} value={option.value} className="bg-term-panel">
          {option.label}
        </option>
      ))}
    </select>
  );
}

export function Badge({
  children,
  tone = 'neutral',
  title,
}: {
  children: ReactNode;
  tone?: 'neutral' | 'up' | 'down' | 'warn' | 'info';
  title?: string;
}) {
  const tones: Record<string, string> = {
    neutral: 'border-term-border-bright text-term-muted',
    up: 'border-term-up/50 bg-term-up/10 text-term-up',
    down: 'border-term-down/50 bg-term-down/10 text-term-down',
    warn: 'border-term-warn/50 bg-term-warn/10 text-term-warn',
    info: 'border-term-info/50 bg-term-info/10 text-term-info',
  };
  return (
    <span
      title={title}
      className={`inline-block rounded border px-1.5 py-0.5 text-[10px] font-semibold uppercase tracking-wider ${tones[tone]}`}
    >
      {children}
    </span>
  );
}

export function WarningList({ warnings, tone = 'warn' }: { warnings: string[]; tone?: 'warn' | 'down' }) {
  if (warnings.length === 0) return null;
  const border = tone === 'down' ? 'border-term-down/40 bg-term-down/5' : 'border-term-warn/40 bg-term-warn/5';
  const text = tone === 'down' ? 'text-term-down' : 'text-term-warn';
  return (
    <ul className={`space-y-1.5 rounded border ${border} p-2.5`}>
      {warnings.map((warning) => (
        <li key={warning} className={`flex gap-2 text-[11px] leading-relaxed ${text}`}>
          <span aria-hidden>▲</span>
          <span>{warning}</span>
        </li>
      ))}
    </ul>
  );
}

export function StatRow({
  label,
  value,
  tone,
  explainKey,
  title,
}: {
  label: string;
  value: ReactNode;
  tone?: string;
  explainKey?: string;
  title?: string;
}) {
  return (
    <div className="flex items-baseline justify-between gap-3 border-b border-term-border/60 py-1 last:border-0">
      <span className="flex items-center gap-1.5 text-[11px] text-term-muted" title={title}>
        {label}
        {explainKey ? <Explain termKey={explainKey} /> : null}
      </span>
      <span className={`num text-xs ${tone ?? 'text-term-text'}`}>{value}</span>
    </div>
  );
}
