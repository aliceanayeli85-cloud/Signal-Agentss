import * as z from 'zod/v4';
import { TIMEFRAMES } from '../../shared/types.js';
import { ValidationError } from './errors.js';

export const timeframeSchema = z.enum(TIMEFRAMES);

/** Asset ids are `provider:...`; keep the charset tight so nothing odd reaches a URL. */
export const assetIdSchema = z
  .string()
  .min(3)
  .max(160)
  .regex(/^[A-Za-z0-9_.:\-]+$/, 'Asset id contains characters that are not allowed.');

export const directionSchema = z.enum(['long', 'short']);

/** Parses and rethrows as ValidationError so the error middleware returns a 400. */
export function parse<T>(schema: z.ZodType<T>, value: unknown, label: string): T {
  const result = schema.safeParse(value);
  if (!result.success) {
    const detail = result.error.issues
      .map((issue) => `${issue.path.join('.') || label}: ${issue.message}`)
      .join('; ');
    throw new ValidationError(`Invalid ${label}. ${detail}`);
  }
  return result.data;
}

/** Finite, non-negative and not absurd - guards the sizing maths from bad input. */
export const positiveFinite = z
  .number()
  .refine((v) => Number.isFinite(v), 'Must be a finite number.')
  .refine((v) => v > 0, 'Must be greater than zero.')
  .refine((v) => v < 1e15, 'Value is implausibly large.');

export const nonNegativeFinite = z
  .number()
  .refine((v) => Number.isFinite(v), 'Must be a finite number.')
  .refine((v) => v >= 0, 'Must not be negative.')
  .refine((v) => v < 1e15, 'Value is implausibly large.');
