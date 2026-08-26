import { Desk } from './MemeDesk.js';

/**
 * SWING mode is the same desk restricted to the higher-timeframe ladder, because
 * a swing setup read off a 1-minute chart is not a swing setup.
 */
export function SwingDesk() {
  return <Desk defaultTimeframe="4h" title="Swing desk · 1D / 4H / 1H" timeframes={['1d', '4h', '1h']} />;
}
