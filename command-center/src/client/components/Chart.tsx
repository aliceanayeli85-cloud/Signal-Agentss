import { CandlestickSeries, ColorType, createChart, HistogramSeries, LineSeries, LineStyle, type IChartApi, type UTCTimestamp } from 'lightweight-charts';
import { useEffect, useRef } from 'react';

export interface ChartCandle {
  t: number;
  o: number;
  h: number;
  l: number;
  c: number;
  v: number;
  complete: boolean;
}

export interface ChartLine {
  price: number;
  label: string;
  color: string;
  dashed?: boolean;
}

interface Props {
  candles: ChartCandle[];
  ema9: (number | null)[];
  ema20: (number | null)[];
  vwap: (number | null)[] | null;
  lines: ChartLine[];
  height?: number;
}

/**
 * Candles with the 9/20 EMA (and VWAP intraday). The candle still forming is
 * drawn grey so it is never mistaken for a finished one.
 */
export function PriceChart({ candles, ema9, ema20, vwap, lines, height = 320 }: Props) {
  const ref = useRef<HTMLDivElement | null>(null);
  const chartRef = useRef<IChartApi | null>(null);

  useEffect(() => {
    const el = ref.current;
    if (!el || !candles.length) return;
    const chart = createChart(el, {
      height,
      width: el.clientWidth,
      layout: { background: { type: ColorType.Solid, color: '#121821' }, textColor: '#8b98a9', fontSize: 11 },
      grid: { vertLines: { color: '#1b2430' }, horzLines: { color: '#1b2430' } },
      rightPriceScale: { borderColor: '#243041' },
      timeScale: { borderColor: '#243041', timeVisible: true, secondsVisible: false },
      crosshair: { mode: 0 },
    });
    chartRef.current = chart;
    const time = (t: number) => Math.floor(t / 1000) as UTCTimestamp;

    const series = chart.addSeries(CandlestickSeries, { upColor: '#2fd07a', downColor: '#ff5c5c', borderVisible: false, wickUpColor: '#2fd07a', wickDownColor: '#ff5c5c' });
    series.setData(
      candles.map((c) => ({
        time: time(c.t),
        open: c.o,
        high: c.h,
        low: c.l,
        close: c.c,
        ...(c.complete ? {} : { color: '#6b7685', wickColor: '#6b7685', borderColor: '#6b7685' }),
      })),
    );
    const vol = chart.addSeries(HistogramSeries, { priceScaleId: 'vol', priceFormat: { type: 'volume' }, lastValueVisible: false, priceLineVisible: false });
    chart.priceScale('vol').applyOptions({ scaleMargins: { top: 0.82, bottom: 0 } });
    vol.setData(candles.map((c) => ({ time: time(c.t), value: c.v, color: !c.complete ? '#6b768555' : c.c >= c.o ? '#2fd07a44' : '#ff5c5c44' })));

    const line = (values: (number | null)[], color: string, title: string) => {
      const s = chart.addSeries(LineSeries, { color, lineWidth: 2, priceLineVisible: false, lastValueVisible: false, title });
      s.setData(candles.flatMap((c, i) => (values[i] == null ? [] : [{ time: time(c.t), value: values[i]! }])));
    };
    line(ema9, '#ffb020', 'EMA 9');
    line(ema20, '#4aa8ff', 'EMA 20');
    if (vwap) line(vwap, '#c084fc', 'VWAP');

    for (const l of lines) {
      series.createPriceLine({ price: l.price, color: l.color, lineWidth: 1, lineStyle: l.dashed ? LineStyle.Dashed : LineStyle.Solid, axisLabelVisible: true, title: l.label });
    }
    chart.timeScale().fitContent();

    const resize = new ResizeObserver(() => chart.applyOptions({ width: el.clientWidth }));
    resize.observe(el);
    return () => {
      resize.disconnect();
      chart.remove();
      chartRef.current = null;
    };
  }, [candles, ema9, ema20, vwap, lines, height]);

  if (!candles.length) return <div className="flex h-40 items-center justify-center rounded-lg border border-line text-sm text-dim">No chart data available.</div>;
  return (
    <div>
      <div ref={ref} className="w-full overflow-hidden rounded-lg" />
      <div className="mt-1 flex flex-wrap gap-3 text-[11px] text-dim">
        <span><span className="text-warn">━</span> EMA 9</span>
        <span><span className="text-info">━</span> EMA 20</span>
        {vwap && <span><span className="text-[#c084fc]">━</span> VWAP</span>}
        <span><span className="text-[#6b7685]">■</span> candle still forming</span>
      </div>
    </div>
  );
}
