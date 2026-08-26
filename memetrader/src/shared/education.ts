/**
 * Plain-language explanations attached to every technical concept the UI shows.
 * Each entry is deliberately short: the goal is that a beginner can read one
 * while looking at the chart, not that it replaces a textbook.
 */
export interface Explanation {
  term: string;
  short: string;
  long: string;
}

export const EXPLANATIONS: Record<string, Explanation> = {
  breakout: {
    term: 'Breakout',
    short: 'Price closes beyond a level that previously held it back.',
    long:
      'A breakout is when price trades and closes past a level (usually a prior high or the top of a range) that repeatedly rejected it before. A breakout on its own proves nothing - it only becomes interesting when volume expands and the level holds when price comes back to test it. A breakout that immediately falls back inside the range is a failed breakout, which often runs the other way.',
  },
  retest: {
    term: 'Retest',
    short: 'Price returns to the broken level to see whether it now acts as support.',
    long:
      'After a breakout, price often drifts back to the level it broke. If that old resistance now holds as support, buyers have defended it and the breakout is confirmed. If price slices back through, the breakout has failed. A retest gives a much tighter stop than chasing the initial breakout candle, which is why it usually produces a better risk/reward.',
  },
  confirmation: {
    term: 'Confirmation',
    short: 'A close that shows the retest held before you commit.',
    long:
      'Confirmation is any objective event that has to occur before an entry is valid - typically a candle closing back above the broken level after a retest, ideally with volume above its recent average. Waiting for confirmation gives up some of the move in exchange for filtering out failed breakouts.',
  },
  'liquidity-sweep': {
    term: 'Liquidity sweep',
    short: 'Price pokes past an obvious high or low, then immediately reverses back.',
    long:
      'Stop orders cluster just beyond obvious swing highs and lows. A liquidity sweep is when price briefly trades through that cluster - triggering those stops - and then closes back on the original side. On a chart it looks like a long wick past a prior extreme. It is only identifiable after the reversal candle closes; before that it is indistinguishable from a genuine breakout.',
  },
  support: {
    term: 'Support',
    short: 'A price area where buying has repeatedly stopped a decline.',
    long:
      'Support is a price region where demand previously overwhelmed supply and stopped price falling. The more times it has been touched and held, the more traders are watching it. Support is an area, not an exact number, and it fails regularly - which is exactly why a stop belongs below it.',
  },
  resistance: {
    term: 'Resistance',
    short: 'A price area where selling has repeatedly stopped an advance.',
    long:
      'Resistance is where supply previously overwhelmed demand. It often comes from prior swing highs, round numbers, or the price where a large group of holders first bought and now want to break even. Once broken and retested, resistance frequently behaves as support.',
  },
  supply: {
    term: 'Supply zone',
    short: 'The area a sharp drop originated from - sellers were waiting there.',
    long:
      'A supply zone is the price band immediately before a strong impulsive move down. The assumption is that unfilled sell orders remain there, so price returning to it often stalls. It is a heuristic, not a rule, and it degrades every time price revisits it.',
  },
  demand: {
    term: 'Demand zone',
    short: 'The area a sharp rally originated from - buyers were waiting there.',
    long:
      'A demand zone is the price band immediately before a strong impulsive move up, on the assumption unfilled buy orders remain. Like supply zones it weakens with each revisit, and it means nothing if the broader structure has already broken down.',
  },
  'higher-highs-higher-lows': {
    term: 'Higher highs / higher lows',
    short: 'Each pullback bottoms higher and each push tops higher - an uptrend.',
    long:
      'Market structure is read from swing points. A sequence of higher highs and higher lows means buyers are stepping in earlier each time - the definition of an uptrend. The trend is intact until price makes a lower low; that break is the objective invalidation, not a feeling.',
  },
  'lower-highs-lower-lows': {
    term: 'Lower highs / lower lows',
    short: 'Each bounce tops lower and each drop bottoms lower - a downtrend.',
    long:
      'A sequence of lower highs and lower lows means sellers are getting more aggressive each time. Buying into this expects the structure to change first; until a prior swing high is reclaimed, every bounce is inside a downtrend.',
  },
  consolidation: {
    term: 'Consolidation',
    short: 'Price is moving sideways in a range with no clear trend.',
    long:
      'Consolidation is a balance area where neither buyers nor sellers can push price out. Ranges resolve eventually, and the direction is not knowable in advance. The tradable edges are the range boundaries; the middle is the worst place to enter because the stop has to be far away.',
  },
  reclaim: {
    term: 'Reclaim',
    short: 'Price falls below a level, then closes back above it.',
    long:
      'A reclaim is a failed breakdown: price loses a level, trapping sellers, then closes back above it. Traders who shorted the break become forced buyers. The invalidation is tight - a close back under the reclaimed level - which is what makes the setup attractive when it works.',
  },
  'failed-breakout': {
    term: 'Failed breakout',
    short: 'Price broke a level, could not hold it, and closed back inside.',
    long:
      'A failed breakout traps everyone who bought the break. Because those positions are underwater immediately, the move back through the range often accelerates. It is one of the few setups where being wrong is obvious quickly: a close back above the level invalidates it.',
  },
  atr: {
    term: 'ATR (Average True Range)',
    short: 'The average distance price travels in one bar, including gaps.',
    long:
      'ATR measures typical volatility per bar. It is used for stop placement: a stop closer than roughly 1 ATR from entry is likely to be hit by ordinary noise rather than by the setup being wrong. On meme coins ATR can be an enormous percentage of price, which is precisely why position size must shrink.',
  },
  rsi: {
    term: 'RSI',
    short: 'A 0-100 momentum gauge comparing recent gains to recent losses.',
    long:
      'RSI compares the size of recent up moves to recent down moves over 14 bars. Readings above 70 mean price has advanced quickly, and below 30 mean it has fallen quickly. It is not a reversal signal: in a strong trend RSI can stay "overbought" for a long time. It is most useful as a note on how extended a move already is.',
  },
  vwap: {
    term: 'VWAP',
    short: 'The average price paid so far in the session, weighted by volume.',
    long:
      'Volume-Weighted Average Price is the session average price weighted by how much traded at each price. It is the reference many intraday participants measure against: above VWAP, buyers who entered today are on average in profit. It is only meaningful with genuine volume data and resets each session.',
  },
  'relative-volume': {
    term: 'Relative volume',
    short: 'Current volume compared to what is normal for this market.',
    long:
      'Relative volume divides the current bar volume by the average of recent bars. Above 2x means unusual participation. Volume confirmation matters because a breakout on below-average volume means very few people actually took the level - those breaks fail more often.',
  },
  'volume-confirmation': {
    term: 'Volume confirmation',
    short: 'The breakout bar traded meaningfully more than recent bars.',
    long:
      'Volume confirmation means the move happened with participation rather than in a vacuum. It is checked by comparing the breakout bar volume to the average of the preceding bars. Green candles without volume mean price drifted up on nobody trading, which is easy to reverse.',
  },
  'r-multiple': {
    term: 'R multiple',
    short: '1R is the money you risked. +2R means you made twice what you risked.',
    long:
      'R normalises every trade to the amount risked. If your stop is 5% away and you risk $100, then 1R = $100 regardless of position size or asset. This makes a meme-coin trade and a stock trade directly comparable, and it is why performance here is reported in R rather than dollars.',
  },
  expectancy: {
    term: 'Expectancy',
    short: 'The average R you have historically made per trade.',
    long:
      'Expectancy = (win rate x average win in R) - (loss rate x average loss in R). It answers "what has one trade of this type been worth on average". A positive expectancy over a small sample is not evidence of an edge - the sample size and the distribution of outcomes matter more than the headline number.',
  },
  'profit-factor': {
    term: 'Profit factor',
    short: 'Gross profit divided by gross loss.',
    long:
      'Profit factor above 1.0 means winners outweighed losers in total. It is sensitive to a single outlier win, so read it alongside the number of trades and the largest win. With fewer than about 30 trades it says very little.',
  },
  drawdown: {
    term: 'Maximum drawdown',
    short: 'The worst peak-to-trough decline the equity curve suffered.',
    long:
      'Max drawdown is the largest fall from a high-water mark to a subsequent low. It is the number that determines whether a strategy is survivable in practice: a system with good expectancy and a 20R drawdown will be abandoned by most people before it recovers.',
  },
  sharpe: {
    term: 'Sharpe ratio',
    short: 'Return per unit of volatility of returns.',
    long:
      'Sharpe divides mean return by the standard deviation of returns. It is meaningful for a series of many comparable periods; computed over a handful of trades it is noise. This app reports it only when the sample is large enough and labels the assumptions it used.',
  },
  'setup-score': {
    term: 'Setup score',
    short: 'How many of the predefined conditions this setup currently satisfies.',
    long:
      'The setup score counts objective conditions - structure, volume confirmation, level quality, retest quality, risk/reward, volatility, liquidity. It is a checklist total out of 100, not a prediction and not a probability. A high score means the conditions you defined are present right now; it says nothing about what price will do next.',
  },
  'risk-score': {
    term: 'Risk score',
    short: 'How hazardous this specific market is to trade, 0-100.',
    long:
      'The risk score aggregates liquidity, pair age, volatility, volume behaviour, and price extension into a single hazard rating where higher is worse. It is not a probability of loss and not a scam detector. It exists to make you size smaller - or walk away - when the market itself is fragile.',
  },
  'timeframe-alignment': {
    term: 'Timeframe alignment',
    short: 'Whether the higher and lower timeframes agree on direction.',
    long:
      'A setup on the 5m inside a 1D downtrend is fighting the larger flow. Alignment simply reports whether the evaluated timeframes point the same way. HIGH means they agree; MIXED means they conflict, which usually means smaller size or no trade rather than a better entry.',
  },
  fdv: {
    term: 'FDV',
    short: 'Price multiplied by the total supply, including tokens not yet circulating.',
    long:
      'Fully Diluted Valuation prices every token that will ever exist at the current price. When FDV is far above market cap, a large amount of supply has yet to unlock - future selling pressure that is not visible in the current chart.',
  },
  liquidity: {
    term: 'Liquidity',
    short: 'How much money sits in the pool you would trade against.',
    long:
      'On a decentralised exchange, liquidity is the value locked in the trading pool. It determines slippage: on a $20k pool, a $2k order moves the price substantially against you. Low liquidity also means the quoted price is easy for one participant to move, so chart patterns are far less reliable.',
  },
  'pair-age': {
    term: 'Pair age',
    short: 'How long this trading pair has existed.',
    long:
      'Very new pairs have no established structure, no reliable levels, and the highest incidence of liquidity being withdrawn. Technical analysis needs history; a pair a few hours old does not have any. This app flags young pairs rather than pretending its levels mean the same thing there.',
  },
  'holder-concentration': {
    term: 'Holder concentration',
    short: 'How much of the supply a small number of wallets control.',
    long:
      'If a handful of wallets hold most of the supply, one of them selling can end the move regardless of the chart. Reliable holder data requires an on-chain data source this app is not connected to, so it is reported as unavailable rather than estimated.',
  },
  slippage: {
    term: 'Slippage',
    short: 'The difference between the price you expected and the price you got.',
    long:
      'Slippage comes from the order book or pool moving while your order executes. It is largest exactly when you least want it: thin liquidity, fast moves, large size. Backtests that ignore it overstate results, which is why slippage and fees are explicit inputs to the backtester here.',
  },
  'look-ahead-bias': {
    term: 'Look-ahead bias',
    short: 'Using information in a backtest that was not knowable at the time.',
    long:
      'Look-ahead bias is the most common way a backtest lies. Examples: entering at a bar\'s low because you can see it, or using an indicator computed over the whole series. This backtester only ever passes bars up to and including the current index to a strategy, and fills entries on the next bar open.',
  },
  'out-of-sample': {
    term: 'Out-of-sample data',
    short: 'Data the strategy rules were not chosen on.',
    long:
      'If you tune rules until they look good on a stretch of data, the result describes that stretch, not the strategy. Splitting the series into in-sample (where you experiment) and out-of-sample (which you check once) is the minimum defence. Results that hold in-sample but collapse out-of-sample were curve fitting.',
  },
  expectancy_vs_probability: {
    term: 'Historical frequency vs probability',
    short: 'What happened before is a count, not a forecast.',
    long:
      'When this app says a rule set produced a 63% win rate across 243 observations, that is a measurement of the past under those exact rules. It is not a statement that your next trade has a 63% chance of winning - that would require the future to be drawn from the same distribution, which markets do not guarantee.',
  },
};

export function explain(key: string): Explanation | null {
  return EXPLANATIONS[key] ?? null;
}
