/**
 * Research configuration, fixed BEFORE any candidate strategy was evaluated.
 * Changing anything here after results exist invalidates the comparison —
 * record a new version instead.
 */

/** Liquid US ETFs and large caps across sectors: broad market, small caps, financials, energy, tech, defensive. */
export const RESEARCH_TICKERS = ['SPY', 'QQQ', 'IWM', 'DIA', 'XLF', 'XLE', 'AAPL', 'MSFT', 'JPM', 'KO'] as const;

/** Consolidated (SIP) daily bars. The free Alpaca plan serves SIP history older than 15 minutes. */
export const DATA_RANGE = { start: '2016-01-01T00:00:00Z', end: '2026-10-28T00:00:00Z' };

/**
 * Chronological split. Rules are defined in advance, so "train" is only used
 * to look for defects and to warm up indicators — nothing is fitted on it.
 * Validation compares candidates. The final test is evaluated ONCE, after the
 * advancing candidates are chosen and committed.
 */
export const PERIODS = [
  { id: 'train', label: 'Training 2016–2019', start: '2016-01-01', end: '2019-12-31', regimes: 'Low-volatility bull 2016–17, Feb 2018 volatility spike, Q4 2018 sell-off, 2019 recovery' },
  { id: 'validation', label: 'Validation 2020–2022', start: '2020-01-01', end: '2022-12-31', regimes: 'COVID crash and rebound 2020, 2021 bull, 2022 bear market (rates)' },
  { id: 'test', label: 'Final test 2023–2026', start: '2023-01-01', end: '2026-10-27', regimes: '2023–24 bull led by large-cap tech, 2025 tariff sell-off and recovery, 2026' },
] as const;
export type PeriodId = (typeof PERIODS)[number]['id'];

/** Slippage used for the main results, and a stressed level every candidate must also survive. */
export const SLIPPAGE_BPS = { base: 5, stressed: 15 };

export const BOOTSTRAP = { resamples: 5000, seed: 20261029, confidence: 0.9 };
