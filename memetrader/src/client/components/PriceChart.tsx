import {
  CandlestickSeries,
  ColorType,
  HistogramSeries,
  PriceScaleMode,
  createChart,
  createSeriesMarkers,
  type CandlestickData,
  type IChartApi,
  type ISeriesApi,
  type IPriceLine,
  type SeriesMarker,
  type Time,
  type UTCTimestamp,
} from 'lightweight-charts';
import { useEffect, useMemo, useRef, useState } from 'react';
import type { Candle, ChartAnnotation } from '../../shared/types.js';
import { fmtPrice } from '../lib/format.js';
import { DataUnavailable } from './primitives.js';

/**
 * How each annotation kind is drawn. Price-level kinds become horizontal lines
 * with a label; event kinds become markers pinned to a bar. Colours are
 * consistent across the app so the chart teaches the vocabulary by repetition.
 */
const STYLE: Record<
  ChartAnnotation['kind'],
  { colour: string; line: boolean; dash: 0 | 1 | 2; marker?: 'above' | 'below'; shape?: 'arrowUp' | 'arrowDown' | 'circle' | 'square' }
> = {
  support: { colour: '#2fd07a', line: true, dash: 2 },
  resistance: { colour: '#ff5c5c', line: true, dash: 2 },
  demand: { colour: '#2fd07a', line: true, dash: 1 },
  supply: { colour: '#ff5c5c', line: true, dash: 1 },
  breakout: { colour: '#4aa8ff', line: false, dash: 0, marker: 'below', shape: 'arrowUp' },
  retest: { colour: '#ffb020', line: false, dash: 0, marker: 'below', shape: 'circle' },
  confirmation: { colour: '#8b5cf6', line: false, dash: 0, marker: 'below', shape: 'arrowUp' },
  'liquidity-sweep': { colour: '#ffb020', line: false, dash: 0, marker: 'above', shape: 'square' },
  entry: { colour: '#8b5cf6', line: true, dash: 0 },
  stop: { colour: '#ff5c5c', line: true, dash: 0 },
  tp1: { colour: '#2fd07a', line: true, dash: 1 },
  tp2: { colour: '#2fd07a', line: true, dash: 1 },
  tp3: { colour: '#2fd07a', line: true, dash: 1 },
};

export interface PriceChartProps {
  candles: Candle[];
  annotations: ChartAnnotation[];
  unavailableReason?: string | null;
  height?: number;
}

export function PriceChart({ candles, annotations, unavailableReason, height = 420 }: PriceChartProps) {
  const containerRef = useRef<HTMLDivElement | null>(null);
  const chartRef = useRef<IChartApi | null>(null);
  const seriesRef = useRef<ISeriesApi<'Candlestick'> | null>(null);
  const volumeRef = useRef<ISeriesApi<'Histogram'> | null>(null);
  const linesRef = useRef<IPriceLine[]>([]);
  const [hovered, setHovered] = useState<ChartAnnotation | null>(null);

  const hasVolume = useMemo(() => candles.some((c) => c.volume !== null && c.volume > 0), [candles]);

  /**
   * Meme coins routinely move an order of magnitude or more within one series.
   * A linear scale squashes almost all of that history into a flat line at the
   * bottom, and its tick marks extrapolate through the bottom margin down to
   * zero or below - which reads as negative prices.
   *
   * The threshold is deliberately low. With a 12% bottom margin the axis starts
   * extrapolating past zero once the high/low ratio exceeds roughly 8, so
   * switching at 6 keeps every linear chart's axis strictly positive.
   */
  const LOG_SCALE_RATIO = 6;
  const logScale = useMemo(() => {
    const lows = candles.map((c) => c.low).filter((v) => Number.isFinite(v) && v > 0);
    const highs = candles.map((c) => c.high).filter((v) => Number.isFinite(v) && v > 0);
    if (lows.length === 0 || highs.length === 0) return false;
    return Math.max(...highs) / Math.min(...lows) > LOG_SCALE_RATIO;
  }, [candles]);

  useEffect(() => {
    const container = containerRef.current;
    if (!container) return;

    const chart = createChart(container, {
      height,
      layout: {
        background: { type: ColorType.Solid, color: '#0a0d12' },
        textColor: '#7f8b9e',
        fontSize: 11,
        attributionLogo: false,
      },
      grid: {
        vertLines: { color: '#161b24' },
        horzLines: { color: '#161b24' },
      },
      // The bottom margin reserves room for the volume overlay. Keep it small:
      // on a linear axis the tick marks extrapolate through that margin, and a
      // wide margin pushes the lowest ticks to zero or below, which reads as
      // negative prices.
      rightPriceScale: { borderColor: '#232a36', scaleMargins: { top: 0.08, bottom: 0.12 } },
      timeScale: { borderColor: '#232a36', timeVisible: true, secondsVisible: false },
      crosshair: { mode: 1 },
      localization: {
        priceFormatter: (price: number) => fmtPrice(price),
      },
    });

    const series = chart.addSeries(CandlestickSeries, {
      upColor: '#2fd07a',
      downColor: '#ff5c5c',
      borderUpColor: '#2fd07a',
      borderDownColor: '#ff5c5c',
      wickUpColor: '#2fd07a',
      wickDownColor: '#ff5c5c',
      priceFormat: { type: 'price', precision: 8, minMove: 0.00000001 },
      priceLineVisible: false,
    });

    const volume = chart.addSeries(HistogramSeries, {
      priceFormat: { type: 'volume' },
      priceScaleId: 'volume',
      color: '#232a36',
      // Without these the histogram still draws a last-value badge and a dashed
      // line across the price pane, which reads as a price level that is not one.
      lastValueVisible: false,
      priceLineVisible: false,
    });
    // The volume series needs its own scale, but that scale must not draw its own
    // axis labels - they render alongside the price labels and read as negative
    // prices.
    chart.priceScale('volume').applyOptions({
      scaleMargins: { top: 0.9, bottom: 0 },
      visible: false,
    });

    chartRef.current = chart;
    seriesRef.current = series;
    volumeRef.current = volume;

    const observer = new ResizeObserver(() => {
      chart.applyOptions({ width: container.clientWidth });
    });
    observer.observe(container);
    chart.applyOptions({ width: container.clientWidth });

    return () => {
      observer.disconnect();
      chart.remove();
      chartRef.current = null;
      seriesRef.current = null;
      volumeRef.current = null;
      linesRef.current = [];
    };
  }, [height]);

  useEffect(() => {
    const series = seriesRef.current;
    const volume = volumeRef.current;
    const chart = chartRef.current;
    if (!series || !volume || !chart) return;

    const data: CandlestickData<Time>[] = candles.map((candle) => ({
      time: candle.time as UTCTimestamp,
      open: candle.open,
      high: candle.high,
      low: candle.low,
      close: candle.close,
    }));
    series.setData(data);

    volume.setData(
      hasVolume
        ? candles.map((candle) => ({
            time: candle.time as UTCTimestamp,
            value: candle.volume ?? 0,
            color: candle.close >= candle.open ? 'rgba(47,208,122,0.28)' : 'rgba(255,92,92,0.28)',
          }))
        : [],
    );

    // Rebuild overlays from scratch: annotations change wholesale when the
    // timeframe or asset changes, and a stale line would mislabel the chart.
    for (const line of linesRef.current) series.removePriceLine(line);
    linesRef.current = [];

    const markers: SeriesMarker<Time>[] = [];
    for (const annotation of annotations) {
      const style = STYLE[annotation.kind];
      if (!style) continue;

      if (style.line && annotation.price !== null && Number.isFinite(annotation.price)) {
        // Only the plan's own levels get an axis label. Labelling every zone as
        // well stacks a dozen tags on the right edge and hides the ones that
        // actually matter for the trade.
        const isPlanLevel =
          annotation.kind === 'entry' ||
          annotation.kind === 'stop' ||
          annotation.kind === 'tp1' ||
          annotation.kind === 'tp2' ||
          annotation.kind === 'tp3';
        linesRef.current.push(
          series.createPriceLine({
            price: annotation.price,
            color: style.colour,
            lineWidth: annotation.kind === 'entry' || annotation.kind === 'stop' ? 2 : 1,
            lineStyle: style.dash,
            axisLabelVisible: isPlanLevel,
            title: annotation.label,
          }),
        );
      }

      if (!style.line && annotation.time !== null && Number.isFinite(annotation.time)) {
        markers.push({
          time: annotation.time as UTCTimestamp,
          position: style.marker === 'above' ? 'aboveBar' : 'belowBar',
          color: style.colour,
          shape: style.shape ?? 'circle',
          text: annotation.label,
        });
      }
    }
    markers.sort((a, b) => (a.time as number) - (b.time as number));
    createSeriesMarkers(series, markers);

    chart.priceScale('right').applyOptions({
      mode: logScale ? PriceScaleMode.Logarithmic : PriceScaleMode.Normal,
    });

    if (data.length > 0) chart.timeScale().fitContent();
  }, [candles, annotations, hasVolume, logScale]);

  if (unavailableReason) {
    return <DataUnavailable reason={unavailableReason} />;
  }

  if (candles.length === 0) {
    return (
      <DataUnavailable reason="No candles were returned for this market and timeframe, so there is nothing to chart." />
    );
  }

  // The legend doubles as the educational key: hovering a label explains the term.
  const legend = annotations.filter(
    (annotation, index, all) => all.findIndex((a) => a.label === annotation.label) === index,
  );

  return (
    <div className="flex flex-col gap-2">
      <div ref={containerRef} className="w-full" />
      {!hasVolume ? (
        <p className="text-[11px] text-term-warn">
          Volume unavailable for this series — the volume pane is empty and volume confirmation was
          not scored.
        </p>
      ) : null}
      {logScale ? (
        <p className="text-[11px] text-term-dim">
          Price axis is logarithmic: this series spans more than 20x, and a linear axis would
          flatten most of its history into an unreadable line.
        </p>
      ) : null}
      <div className="flex flex-wrap gap-1.5">
        {legend.map((annotation) => {
          const style = STYLE[annotation.kind];
          return (
            <button
              key={`${annotation.kind}-${annotation.label}-${annotation.price ?? annotation.time}`}
              type="button"
              onMouseEnter={() => setHovered(annotation)}
              onFocus={() => setHovered(annotation)}
              onMouseLeave={() => setHovered(null)}
              onBlur={() => setHovered(null)}
              className="rounded border px-1.5 py-0.5 text-[10px] font-semibold uppercase tracking-wider transition"
              style={{ borderColor: `${style?.colour ?? '#333d4e'}66`, color: style?.colour ?? '#7f8b9e' }}
            >
              {annotation.label}
              {annotation.price !== null ? (
                <span className="num ml-1.5 opacity-70">{fmtPrice(annotation.price)}</span>
              ) : null}
            </button>
          );
        })}
      </div>
      <div className="min-h-[34px] rounded border border-term-border bg-term-panel-2 px-2.5 py-1.5 text-[11px] leading-relaxed text-term-muted">
        {hovered ? (
          <>
            <span className="font-semibold text-term-text">{hovered.label}:</span> {hovered.explain}
          </>
        ) : (
          'Hover a marker above to read what it means. The sequence to look for is BREAKOUT → RETEST → CONFIRMATION → ENTRY ZONE → STOP / INVALIDATION → TARGET.'
        )}
      </div>
    </div>
  );
}
