/**
 * The agent's default scan universe: liquid US stocks and ETFs across every
 * sector — deliberately not just large technology companies. The user can add
 * or remove symbols (stored in settings); the screener adds discovered names
 * each scan when they pass the liquidity filter below.
 */
export const UNIVERSE_SECTORS: Record<string, string[]> = {
  'Broad-market & international ETFs': ['SPY', 'QQQ', 'IWM', 'DIA', 'MDY', 'EFA', 'EEM'],
  'Sector & asset ETFs': ['XLF', 'XLE', 'XLK', 'XLV', 'XLI', 'XLY', 'XLP', 'XLU', 'XLB', 'XLRE', 'XLC', 'SMH', 'GLD', 'TLT', 'HYG'],
  Technology: ['AAPL', 'MSFT', 'NVDA', 'AMD', 'AVGO', 'ORCL', 'CRM', 'ADBE', 'INTC', 'CSCO', 'QCOM', 'TXN', 'MU', 'PLTR'],
  Communication: ['GOOGL', 'META', 'NFLX', 'DIS', 'T', 'VZ', 'CMCSA'],
  'Consumer discretionary': ['AMZN', 'TSLA', 'HD', 'LOW', 'MCD', 'NKE', 'SBUX', 'TGT', 'BKNG', 'GM', 'F', 'UBER'],
  'Consumer staples': ['KO', 'PEP', 'PG', 'WMT', 'COST', 'CL', 'MDLZ'],
  'Health care': ['UNH', 'JNJ', 'LLY', 'PFE', 'MRK', 'ABBV', 'TMO', 'ABT', 'CVS', 'AMGN'],
  Financials: ['JPM', 'BAC', 'WFC', 'GS', 'MS', 'C', 'SCHW', 'V', 'MA', 'AXP', 'BLK', 'SOFI', 'HOOD'],
  Energy: ['XOM', 'CVX', 'COP', 'SLB', 'OXY'],
  Industrials: ['CAT', 'DE', 'BA', 'GE', 'HON', 'UPS', 'UNP', 'LMT', 'RTX'],
  Materials: ['LIN', 'FCX', 'NEM', 'DOW'],
  Utilities: ['NEE', 'DUK', 'SO'],
  'Real estate': ['AMT', 'PLD', 'O'],
};

export const DEFAULT_UNIVERSE: string[] = Object.values(UNIVERSE_SECTORS).flat();

export const ETFS = new Set([...UNIVERSE_SECTORS['Broad-market & international ETFs']!, ...UNIVERSE_SECTORS['Sector & asset ETFs']!]);

export function sectorOf(symbol: string): string {
  for (const [sector, list] of Object.entries(UNIVERSE_SECTORS)) if (list.includes(symbol)) return sector;
  return 'Discovered by screener';
}

/**
 * Liquidity filter for every symbol, including screener discoveries:
 * price ≥ $5 (no penny stocks), 20-day average dollar volume ≥ $20M, and at
 * least 220 completed daily candles so every model feature exists.
 */
export const LIQUIDITY = { minPrice: 5, minAvgDollarVolume: 20_000_000, minHistory: 220 };

/** Ticker shapes we refuse from the screener: warrants, units, rights, preferreds. */
export function plausibleCommonTicker(symbol: string): boolean {
  return /^[A-Z]{1,5}$/.test(symbol) && !/(W|WS|U|R)$/.test(symbol.length === 5 ? symbol : '');
}
