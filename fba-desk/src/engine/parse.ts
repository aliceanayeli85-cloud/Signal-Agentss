import type { FieldKind } from './types';

/** Upper bound to catch typos (e.g. an extra row of zeros). */
export const MAX_AMOUNT = 1_000_000_000;

export type ParseResult = { ok: true; value: number | null } | { ok: false; message: string };

const NUMBER_PATTERN = /^-?(\d+\.?\d*|\.\d+)$/;

/**
 * Parses one user-entered value. Blank (empty string, null, undefined) means "no value"
 * and returns { ok: true, value: null } — it is never converted to zero.
 */
export function parseAmount(raw: string | number | null | undefined, kind: FieldKind): ParseResult {
  if (raw === null || raw === undefined) return { ok: true, value: null };

  let value: number;
  if (typeof raw === 'number') {
    if (!Number.isFinite(raw)) return { ok: false, message: 'must be a finite number' };
    value = raw;
  } else {
    let text = raw.trim();
    if (text === '') return { ok: true, value: null };
    if (kind === 'money' && text.startsWith('$')) text = text.slice(1).trim();
    if (kind === 'percent' && text.endsWith('%')) text = text.slice(0, -1).trim();
    if (text.includes(',')) {
      return { ok: false, message: 'use a period for decimals and no thousands separators (e.g. 1234.56)' };
    }
    if (!NUMBER_PATTERN.test(text)) return { ok: false, message: `"${raw}" is not a number` };
    value = Number(text);
  }

  if (value < 0) return { ok: false, message: 'cannot be negative' };
  if (kind === 'percent' && value > 100) return { ok: false, message: 'must be between 0 and 100' };
  if (kind === 'count' && !Number.isInteger(value)) return { ok: false, message: 'must be a whole number' };
  if (value > MAX_AMOUNT) return { ok: false, message: `must be at most ${MAX_AMOUNT.toLocaleString('en-US')}` };

  return { ok: true, value: value === 0 ? 0 : value };
}

/** Rounds half away from zero to `dp` decimal places, avoiding binary float artifacts (1.005 -> 1.01). */
export function roundTo(value: number, dp = 2): number {
  const factor = 10 ** dp;
  // toPrecision(15) strips float noise such as 1.005 * 100 = 100.49999999999999.
  const scaled = Number((Math.abs(value) * factor).toPrecision(15));
  const rounded = (Math.sign(value) * Math.round(scaled)) / factor;
  return rounded === 0 ? 0 : rounded;
}
