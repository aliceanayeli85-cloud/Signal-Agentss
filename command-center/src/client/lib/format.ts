export const usd = (x: number | null | undefined, digits = 2) => (x === null || x === undefined || !Number.isFinite(x) ? '—' : `${x < 0 ? '-' : ''}$${Math.abs(x).toFixed(digits)}`);

export const price = (x: number | null | undefined) => (x === null || x === undefined ? '—' : x >= 1000 ? `$${x.toFixed(2)}` : `$${x.toFixed(x < 1 ? 4 : 2)}`);

export const signedUsd = (x: number | null | undefined) => (x === null || x === undefined ? '—' : `${x > 0 ? '+' : ''}${usd(x)}`);

export const pct = (x: number | null | undefined, digits = 1) => (x === null || x === undefined ? '—' : `${(x * 100).toFixed(digits)}%`);

export const shares = (x: number | null | undefined) => (x === null || x === undefined ? '—' : Number.isInteger(x) ? String(x) : x.toFixed(6).replace(/0+$/, ''));

export function timeAgo(t: number | null | undefined, now = Date.now()): string {
  if (!t) return 'never';
  const s = Math.round((now - t) / 1000);
  if (s < 0) return 'just now';
  if (s < 60) return `${s}s ago`;
  if (s < 3600) return `${Math.round(s / 60)}m ago`;
  if (s < 86400) return `${Math.round(s / 3600)}h ago`;
  return `${Math.round(s / 86400)}d ago`;
}

export function clockTime(t: number | null | undefined): string {
  if (!t) return '—';
  return new Date(t).toLocaleString(undefined, { month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' });
}

export const pnlColor = (x: number | null | undefined) => (!x ? 'text-dim' : x > 0 ? 'text-up' : 'text-down');
