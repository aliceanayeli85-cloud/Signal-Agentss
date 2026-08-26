/** Formatting helpers. Every one returns an explicit dash for missing data. */

export const MISSING = '—';

export function fmtPrice(value: number | null | undefined): string {
  if (value === null || value === undefined || !Number.isFinite(value)) return MISSING;
  if (value === 0) return '0';
  const abs = Math.abs(value);
  // Meme-coin prices routinely have eight or more leading zeros; a fixed number
  // of decimals would render them all as "0.00".
  if (abs < 0.00001) return value.toExponential(4);
  if (abs < 1) return value.toPrecision(4);
  if (abs < 1000) return value.toLocaleString('en-US', { maximumFractionDigits: 4 });
  return value.toLocaleString('en-US', { maximumFractionDigits: 2 });
}

export function fmtUsd(value: number | null | undefined): string {
  if (value === null || value === undefined || !Number.isFinite(value)) return MISSING;
  const abs = Math.abs(value);
  if (abs >= 1_000_000_000) return `$${(value / 1_000_000_000).toFixed(2)}B`;
  if (abs >= 1_000_000) return `$${(value / 1_000_000).toFixed(2)}M`;
  if (abs >= 1_000) return `$${(value / 1_000).toFixed(1)}K`;
  return `$${value.toFixed(2)}`;
}

export function fmtPct(value: number | null | undefined, digits = 2): string {
  if (value === null || value === undefined || !Number.isFinite(value)) return MISSING;
  return `${value > 0 ? '+' : ''}${value.toFixed(digits)}%`;
}

export function fmtNum(value: number | null | undefined, digits = 2): string {
  if (value === null || value === undefined || !Number.isFinite(value)) return MISSING;
  return value.toFixed(digits);
}

export function fmtR(value: number | null | undefined): string {
  if (value === null || value === undefined || !Number.isFinite(value)) return MISSING;
  return `${value > 0 ? '+' : ''}${value.toFixed(2)}R`;
}

export function fmtInt(value: number | null | undefined): string {
  if (value === null || value === undefined || !Number.isFinite(value)) return MISSING;
  return Math.round(value).toLocaleString('en-US');
}

export function fmtAgo(timestampMs: number | null | undefined, now = Date.now()): string {
  if (timestampMs === null || timestampMs === undefined || !Number.isFinite(timestampMs)) {
    return MISSING;
  }
  const seconds = Math.max(0, Math.round((now - timestampMs) / 1000));
  if (seconds < 60) return `${seconds} second${seconds === 1 ? '' : 's'} ago`;
  const minutes = Math.round(seconds / 60);
  if (minutes < 60) return `${minutes} minute${minutes === 1 ? '' : 's'} ago`;
  const hours = Math.round(minutes / 60);
  if (hours < 48) return `${hours} hour${hours === 1 ? '' : 's'} ago`;
  return `${Math.round(hours / 24)} days ago`;
}

export function fmtDateTime(timestampMs: number | null | undefined): string {
  if (timestampMs === null || timestampMs === undefined || !Number.isFinite(timestampMs)) {
    return MISSING;
  }
  return new Date(timestampMs).toLocaleString('en-US', {
    month: 'short',
    day: 'numeric',
    hour: '2-digit',
    minute: '2-digit',
  });
}

export function fmtDuration(minutes: number | null | undefined): string {
  if (minutes === null || minutes === undefined || !Number.isFinite(minutes)) return MISSING;
  if (minutes < 60) return `${Math.round(minutes)}m`;
  if (minutes < 1440) return `${(minutes / 60).toFixed(1)}h`;
  return `${(minutes / 1440).toFixed(1)}d`;
}

export function directionClass(value: number | null | undefined): string {
  if (value === null || value === undefined || !Number.isFinite(value)) return 'text-term-muted';
  if (value > 0) return 'text-term-up';
  if (value < 0) return 'text-term-down';
  return 'text-term-muted';
}
