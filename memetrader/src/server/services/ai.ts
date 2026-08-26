import Anthropic from '@anthropic-ai/sdk';
import {
  APIConnectionError,
  APIError,
  AuthenticationError,
  RateLimitError,
} from '@anthropic-ai/sdk/core/error';
import { zodOutputFormat } from '@anthropic-ai/sdk/helpers/zod';
// The SDK's zod helper is built against the `zod/v4` entry point; importing from
// the same entry keeps the schema types identical to what it expects.
import * as z from 'zod/v4';
import type {
  AiAnalysisResult,
  AnalysisReport,
  HistoricalSetupStats,
  TokenReport,
} from '../../shared/types.js';
import { env } from '../lib/env.js';
import { logger } from '../lib/logger.js';

/**
 * The structure the model must return. Constraining the output shape is what
 * stops this being a chat box that says "looks bullish": the model is required to
 * argue all three cases and to name what would invalidate its own reasoning.
 */
const AnalysisSchema = z.object({
  what_is_happening: z.string(),
  why_it_matters: z.string(),
  no_trade_conditions: z.array(z.string()),
  bull_case: z.object({
    summary: z.string(),
    requirements: z.array(z.string()),
  }),
  bear_case: z.object({
    summary: z.string(),
    invalidations: z.array(z.string()),
  }),
  neutral_case: z.object({
    summary: z.string(),
    implications: z.array(z.string()),
  }),
  setup_quality: z.number(),
  evidence_confidence: z.enum(['low', 'medium', 'high']),
  evidence_confidence_reason: z.string(),
  key_risks: z.array(z.string()),
  missing_data: z.array(z.string()),
});

const SYSTEM_PROMPT = `You are a market-structure analyst inside a trading research tool. You are given structured, machine-computed measurements of one market - not raw opinion, not news, not sentiment.

Your job is to interpret those measurements. You must:
- Answer WHAT IS HAPPENING: describe the current market structure in plain language, using the classification and levels supplied.
- Answer WHY IT MATTERS: explain what the volume, momentum, liquidity and structure readings mean together for someone deciding whether to trade this.
- Argue the bull case, the bear case, and the range-bound case, every time. Never present only the direction the numbers currently favour.
- List NO-TRADE CONDITIONS: the specific things about this market that would make taking a position a bad idea - thin liquidity, a pair too new to have structure, concentrated ownership, deteriorating volume, an already-extended move, missing data. Be concrete and use the supplied figures.
- State what would have to HAPPEN for the bull case, and what would INVALIDATE the setup for the bear case. Be specific, and use the price levels supplied.
- Rate setup quality 0-100 based only on how many of the supplied conditions are satisfied.
- Rate evidence_confidence by the COMPLETENESS AND QUALITY OF THE SUPPLIED DATA, never by how likely you think a price move is. "high" means the important fields were present and the sample of bars was adequate. If liquidity, volume, or pair age were missing, confidence cannot be high.
- List every field that was reported as unavailable in missing_data.

Hard rules:
- Never state or imply a probability that price will go up or down. You have no calibrated model of that.
- Never say "buy", "sell", or give a recommendation. Describe conditions and invalidations; the human decides.
- Never invent a number. If a figure is not in the input, say it is unavailable.
- Never claim a token is safe or is a scam. Mint/freeze authority figures come from a data provider, not an audit.
- Refer only to the levels, structure and figures supplied to you.
- If a HISTORICAL EVIDENCE section is present, you may reference it using the exact phrasing "current conditions match N historical setups, which produced X average R". If it is absent or marked insufficient, say that there is not yet enough recorded history to compare against - do NOT estimate one.`;

let client: Anthropic | null = null;

function getClient(): Anthropic | null {
  if (!env.anthropicApiKey) return null;
  if (!client) client = new Anthropic({ apiKey: env.anthropicApiKey });
  return client;
}

export function aiConfigured(): boolean {
  return env.anthropicApiKey !== null;
}

export const AI_UNAVAILABLE_REASON =
  'AI analysis is not configured. Set ANTHROPIC_API_KEY in .env to enable it. Every other feature in this application works without it.';

const DISCLAIMER =
  'This is a structured reading of the measurements above, not a forecast. Setup quality counts satisfied conditions; confidence rates how complete the underlying data was. Neither is a probability that the trade wins.';

/**
 * AI ANALYSIS ENGINE.
 *
 * Feeds the computed report - structure, levels, indicators, scores, warnings -
 * to Claude and requires a structured response. The model never sees raw prices
 * without the derived context, and it is never asked to predict direction.
 */
export async function analyseWithAi(
  report: AnalysisReport | TokenReport,
  historicalEvidence: HistoricalSetupStats | null = null,
): Promise<AiAnalysisResult> {
  const anthropic = getClient();
  if (!anthropic) {
    return { available: false, reason: AI_UNAVAILABLE_REASON };
  }
  if (report.candles.length === 0) {
    return {
      available: false,
      reason: 'AI analysis needs chart data, and none could be loaded for this market.',
    };
  }

  try {
    const response = await anthropic.messages.parse({
      model: env.anthropicModel,
      max_tokens: 16_000,
      system: SYSTEM_PROMPT,
      thinking: { type: 'adaptive' },
      output_config: {
        effort: 'medium',
        format: zodOutputFormat(AnalysisSchema),
      },
      messages: [{ role: 'user', content: buildPrompt(report, historicalEvidence) }],
    });

    if (response.stop_reason === 'refusal') {
      return {
        available: false,
        reason: 'The model declined to analyse this input.',
      };
    }

    const parsed = response.parsed_output;
    if (!parsed) {
      return {
        available: false,
        reason: 'The model returned a response that did not match the required analysis structure.',
      };
    }

    const quality = Number.isFinite(parsed.setup_quality)
      ? Math.max(0, Math.min(100, Math.round(parsed.setup_quality)))
      : 0;

    return {
      available: true,
      model: response.model,
      whatIsHappening: parsed.what_is_happening,
      whyItMatters: parsed.why_it_matters,
      bullCase: { summary: parsed.bull_case.summary, requirements: parsed.bull_case.requirements },
      bearCase: { summary: parsed.bear_case.summary, invalidations: parsed.bear_case.invalidations },
      neutralCase: {
        summary: parsed.neutral_case.summary,
        implications: parsed.neutral_case.implications,
      },
      noTradeConditions: parsed.no_trade_conditions,
      // Returned from the app's own recorded observations, never from the model.
      historicalEvidence: historicalEvidence?.sufficient ? historicalEvidence : null,
      setupQuality: quality,
      evidenceConfidence: parsed.evidence_confidence,
      evidenceConfidenceReason: parsed.evidence_confidence_reason,
      keyRisks: parsed.key_risks,
      missingData: parsed.missing_data,
      disclaimer: DISCLAIMER,
      generatedAt: Date.now(),
    };
  } catch (error) {
    logger.error('ai analysis failed', { error });
    // Most specific first: a 401 and a network failure need different fixes from
    // the user, so they must not collapse into one generic message.
    if (error instanceof AuthenticationError) {
      return { available: false, reason: 'The configured ANTHROPIC_API_KEY was rejected.' };
    }
    if (error instanceof RateLimitError) {
      return { available: false, reason: 'Anthropic API rate limit reached. Try again shortly.' };
    }
    if (error instanceof APIConnectionError) {
      return { available: false, reason: 'Could not reach the Anthropic API from this machine.' };
    }
    if (error instanceof APIError) {
      return { available: false, reason: `Anthropic API error (${error.status ?? 'unknown status'}): ${error.message}` };
    }
    return {
      available: false,
      reason: `AI analysis failed: ${error instanceof Error ? error.message : 'unknown error'}.`,
    };
  }
}

/**
 * Renders the computed report as text. Only measured values go in; anything the
 * providers did not return is written out as "unavailable" so the model cannot
 * mistake a missing field for a zero.
 */
function buildPrompt(
  report: AnalysisReport | TokenReport,
  historicalEvidence: HistoricalSetupStats | null,
): string {
  const s = report.snapshot;
  const i = report.indicators;
  const lines: string[] = [];

  lines.push(`MARKET: ${s?.symbol ?? 'unknown'} (${s?.name ?? 'name unavailable'})`);
  lines.push(`Asset class: ${s?.assetClass ?? 'unknown'}; source: ${report.candleSource}`);
  lines.push(`Analysis timeframe: ${report.timeframe}; bars available: ${report.candles.length}`);
  lines.push('');

  lines.push('MARKET DATA');
  lines.push(`- Price: ${fmt(s?.priceUsd)}`);
  lines.push(`- Liquidity (USD): ${fmt(s?.liquidityUsd)}`);
  lines.push(`- Market cap: ${fmt(s?.marketCapUsd)}`);
  lines.push(`- FDV: ${fmt(s?.fdvUsd)}`);
  lines.push(`- Volume 24h: ${fmt(s?.volume.h24)}; 1h: ${fmt(s?.volume.h1)}`);
  lines.push(`- Price change 24h: ${fmt(s?.priceChangePct.h24)}%; 1h: ${fmt(s?.priceChangePct.h1)}%`);
  lines.push(
    `- Transactions 1h: ${s?.txns.h1 ? `${s.txns.h1.buys} buys / ${s.txns.h1.sells} sells` : 'unavailable'}`,
  );
  lines.push(
    `- Pair created: ${s?.pairCreatedAt ? new Date(s.pairCreatedAt).toISOString() : 'unavailable'}`,
  );
  lines.push('- Holder concentration: unavailable (no on-chain holder data source is connected)');
  lines.push('');

  lines.push('INDICATORS');
  lines.push(`- ATR(14): ${fmt(i.atr14)}`);
  lines.push(`- RSI(14): ${fmt(i.rsi14)}`);
  lines.push(`- Session VWAP: ${fmt(i.vwapSession)}`);
  lines.push(`- Relative volume (vs 20-bar average): ${fmt(i.relativeVolume)}`);
  lines.push(`- EMA20 / EMA50 / EMA200: ${fmt(i.ema20)} / ${fmt(i.ema50)} / ${fmt(i.ema200)}`);
  lines.push('');

  lines.push('MARKET STRUCTURE');
  // A token report can legitimately have no structure at all when the pair is
  // too new to classify; the model must be told that rather than shown blanks.
  const structure = report.structure;
  if (!structure) {
    lines.push('- Unavailable: not enough price history to classify structure.');
  } else {
    lines.push(`- Classification: ${structure.label} (bias: ${structure.bias})`);
    for (const note of structure.notes) lines.push(`- ${note}`);
    const levels = structure.levels.slice(0, 8);
    if (levels.length > 0) {
      lines.push('- Levels:');
      for (const level of levels) {
        lines.push(`  * ${level.kind} at ${level.price.toPrecision(6)} (${level.touches} touches)`);
      }
    } else {
      lines.push('- Levels: none identified');
    }
    for (const sweep of structure.sweeps.slice(-3)) {
      lines.push(`- Liquidity sweep ${sweep.direction} at ${sweep.price.toPrecision(6)}`);
    }
  }
  lines.push('');

  lines.push('TIMEFRAME ALIGNMENT');
  lines.push(`- Overall: ${report.alignment.alignment} - ${report.alignment.detail}`);
  for (const view of report.alignment.views) {
    lines.push(
      view.status === 'ok'
        ? `- ${view.timeframe}: ${view.bias} (${view.structure}, ${view.candleCount} bars)`
        : `- ${view.timeframe}: unavailable - ${view.reason ?? 'no data'}`,
    );
  }
  lines.push('');

  lines.push('DETECTED SETUPS');
  if (report.detections.length === 0) {
    lines.push('- None of the five predefined strategies currently satisfies its conditions.');
  } else {
    for (const detection of report.detections) {
      lines.push(
        `- ${detection.strategyName} (${detection.direction}): entry ${detection.entry.toPrecision(6)}, stop ${detection.stop.toPrecision(6)}`,
      );
      lines.push(`  invalidation: ${detection.invalidationReason}`);
      for (const note of detection.notes) lines.push(`  * ${note}`);
    }
  }
  lines.push('');

  lines.push('TRADE PLAN');
  if (report.plan.available) {
    lines.push(
      `- Entry ${report.plan.entry.toPrecision(6)}, stop ${report.plan.stop.toPrecision(6)}, risk/unit ${report.plan.riskPerUnit.toPrecision(6)}`,
    );
    lines.push(
      `- TP1 ${report.plan.targets.tp1.toPrecision(6)} (${report.plan.rr.tp1.toFixed(2)}R), TP2 ${report.plan.targets.tp2.toPrecision(6)} (${report.plan.rr.tp2.toFixed(2)}R), TP3 ${report.plan.targets.tp3.toPrecision(6)} (${report.plan.rr.tp3.toFixed(2)}R)`,
    );
  } else {
    lines.push(`- ${report.plan.reason}`);
  }
  lines.push('');

  if (report.setupScore) {
    lines.push(
      `SETUP SCORE: ${report.setupScore.score}/100 (${report.setupScore.evaluatedMax} of 100 checklist points evaluable)`,
    );
    for (const factor of report.setupScore.factors) {
      lines.push(
        factor.evaluated
          ? `- ${factor.label}: ${factor.points.toFixed(1)}/${factor.max} - ${factor.detail}`
          : `- ${factor.label}: NOT EVALUATED - ${factor.detail}`,
      );
    }
    lines.push('');
  }

  if (report.risk) {
    lines.push(
      `RISK SCORE: ${report.risk.score}/100 (${report.risk.band}); ${report.risk.evaluatedMax} of ${report.risk.totalMax} hazard points evaluable`,
    );
    for (const factor of report.risk.factors) {
      lines.push(
        factor.evaluated
          ? `- ${factor.label}: ${factor.points.toFixed(1)}/${factor.max} - ${factor.detail}`
          : `- ${factor.label}: NOT EVALUATED - ${factor.detail}`,
      );
    }
    if (report.risk.warnings.length > 0) {
      lines.push('Warnings:');
      for (const warning of report.risk.warnings) lines.push(`- ${warning}`);
    }
    lines.push('');
  }

  // Token-level sections, present only for a watchlist token report.
  if ('tokenInfo' in report) {
    const info = report.tokenInfo;
    lines.push('HOLDER AND CONTRACT DATA');
    if (!info) {
      lines.push(`- Unavailable: ${report.tokenInfoReason ?? 'no provider returned it'}`);
    } else {
      lines.push(`- Holders: ${info.holderCount ?? 'unavailable'}`);
      lines.push(`- Top 10 wallets hold: ${info.topTenPct !== null ? `${info.topTenPct.toFixed(2)}%` : 'unavailable'}`);
      lines.push(`- Creator holding: ${info.creatorHoldingPct !== null ? `${info.creatorHoldingPct.toFixed(2)}%` : 'unavailable'}`);
      lines.push(`- Mint authority: ${info.mintAuthority ?? 'unavailable'}; freeze authority: ${info.freezeAuthority ?? 'unavailable'}`);
      lines.push(`- Provider honeypot flag: ${info.honeypot ?? 'unavailable'} (this is not an audit)`);
    }
    lines.push('');
    lines.push('VOLUME ANALYSIS');
    lines.push(`- ${report.volume.headline}`);
    for (const reason of report.volume.reasons) lines.push(`  * ${reason}`);
    lines.push('');
    lines.push('LIQUIDITY TREND');
    lines.push(`- ${report.liquidity.label}: ${report.liquidity.detail}`);
    lines.push('');
    lines.push('MOMENTUM LADDER');
    for (const reading of report.momentum.readings) {
      lines.push(
        reading.status === 'ok'
          ? `- ${reading.timeframe}: ${(reading.changePct ?? 0) > 0 ? '+' : ''}${(reading.changePct ?? 0).toFixed(2)}% over ${reading.barsUsed} bars`
          : `- ${reading.timeframe}: ${reading.status} (${reading.reason ?? 'no detail'})`,
      );
    }
    lines.push('');
  }

  lines.push('HISTORICAL EVIDENCE');
  if (historicalEvidence && historicalEvidence.sufficient) {
    lines.push(`- ${historicalEvidence.statement}`);
    lines.push(`- Matching observations: ${historicalEvidence.matchingSetups}`);
    lines.push(`- Average outcome: ${historicalEvidence.averageR?.toFixed(3) ?? 'unavailable'}R; median ${historicalEvidence.medianR?.toFixed(3) ?? 'unavailable'}R`);
    lines.push(`- Worst observed: ${historicalEvidence.worstR?.toFixed(2) ?? 'unavailable'}R`);
  } else {
    lines.push(
      `- INSUFFICIENT: ${historicalEvidence?.statement ?? 'no matching recorded observations yet'}. Do not estimate a win rate.`,
    );
  }
  lines.push('');

  if (report.dataNotes.length > 0) {
    lines.push('DATA GAPS');
    for (const note of report.dataNotes) lines.push(`- ${note}`);
  }

  return lines.join('\n');
}

function fmt(value: number | null | undefined): string {
  if (value === null || value === undefined || !Number.isFinite(value)) return 'unavailable';
  if (Math.abs(value) >= 1000) return value.toLocaleString('en-US', { maximumFractionDigits: 2 });
  return value.toPrecision(6);
}
