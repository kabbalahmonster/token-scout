import { useEffect, useRef, useState } from 'react';
import { ColorType, createChart, createSeriesMarkers, LineSeries, type ISeriesMarkersPluginApi, type LineData, type MouseEventParams, type SeriesMarker, type Time, type WhitespaceData } from 'lightweight-charts';
import type { MarketSnapshot } from '@doomscout/domain';

interface SelectedPoint { snapshot: MarketSnapshot; time: Time; price: number }
interface MarketCapPoint { value: number; estimated: boolean }

function money(value: string | null): string {
  if (value === null) return 'unknown';
  const number = Number(value);
  return Number.isFinite(number) ? new Intl.NumberFormat(undefined, { style: 'currency', currency: 'USD', notation: 'compact', maximumFractionDigits: 2 }).format(number) : 'unknown';
}

function price(value: number): string {
  return new Intl.NumberFormat(undefined, { style: 'currency', currency: 'USD', maximumSignificantDigits: 8 }).format(value);
}

function observedAt(snapshot: MarketSnapshot): string { return snapshot.sourceTime ?? snapshot.ingestedAt; }

function finitePositive(value: string | null | undefined): number | null {
  if (value === null || value === undefined) return null;
  const parsed = Number(value);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : null;
}

/**
 * Historical candle providers expose price/volume but generally not historical
 * market cap. When a provider-reported market cap exists elsewhere in the
 * retained history, use its implied circulating supply as the nearest temporal
 * anchor. This remains an estimate because circulating supply can change.
 */
export function historicalMarketCap(snapshot: MarketSnapshot, history: MarketSnapshot[]): MarketCapPoint | null {
  const reported = finitePositive(snapshot.marketCapUsd);
  if (reported !== null) return { value: reported, estimated: false };
  const pointPrice = finitePositive(snapshot.priceUsd);
  const pointAt = Date.parse(observedAt(snapshot));
  if (pointPrice === null || !Number.isFinite(pointAt)) return null;
  let anchor: { marketCap: number; anchorPrice: number; distance: number } | null = null;
  for (const candidate of history) {
    const marketCap = finitePositive(candidate.marketCapUsd);
    const anchorPrice = finitePositive(candidate.priceUsd);
    const at = Date.parse(observedAt(candidate));
    if (marketCap === null || anchorPrice === null || !Number.isFinite(at)) continue;
    const distance = Math.abs(at - pointAt);
    if (!anchor || distance < anchor.distance) anchor = { marketCap, anchorPrice, distance };
  }
  if (!anchor) return null;
  return { value: pointPrice * (anchor.marketCap / anchor.anchorPrice), estimated: true };
}

export function PriceChart({ snapshots }: { snapshots: MarketSnapshot[] }) {
  const ref = useRef<HTMLDivElement>(null);
  const markerRef = useRef<ISeriesMarkersPluginApi<Time> | null>(null);
  const [selected, setSelected] = useState<SelectedPoint[]>([]);
  const selectedRef = useRef(selected); selectedRef.current = selected;

  useEffect(() => {
    if (!ref.current) return;
    const chart = createChart(ref.current, { height: 300, layout: { background: { type: ColorType.Solid, color: 'transparent' }, textColor: '#91a3aa' }, grid: { vertLines: { color: '#172126' }, horzLines: { color: '#172126' } }, rightPriceScale: { borderColor: '#25353c' }, timeScale: { borderColor: '#25353c', timeVisible: true } });
    const series = chart.addSeries(LineSeries, { color: '#50f0b6', lineWidth: 2, crosshairMarkerVisible: true, priceFormat: { type: 'price', precision: 12, minMove: 1e-12 } });
    const points: Array<LineData | WhitespaceData> = [];
    const snapshotByTime = new Map<number, MarketSnapshot>();
    const normalizedByTime = new Map<number, { snapshot: MarketSnapshot; value: number; expected: number }>();
    for (const snapshot of snapshots) {
      const timestamp = Math.floor(Date.parse(observedAt(snapshot)) / 1000);
      const value = Number(snapshot.priceUsd ?? snapshot.priceNative);
      if (!Number.isFinite(timestamp) || !Number.isFinite(value)) continue;
      const expected = snapshot.source === 'doomscout_1h_aggregate' || snapshot.source === 'geckoterminal_1h_candle' ? 3600 : snapshot.source === 'doomscout_5m_aggregate' ? 300 : 60;
      normalizedByTime.set(timestamp, { snapshot, value, expected });
    }
    let previous = 0;
    let previousExpected = 60;
    for (const [timestamp, { snapshot, value, expected }] of [...normalizedByTime].sort(([left], [right]) => left - right)) {
      if (previous && timestamp - previous > Math.max(previousExpected, expected) * 3) points.push({ time: (previous + previousExpected) as Time });
      points.push({ time: timestamp as Time, value }); snapshotByTime.set(timestamp, snapshot); previous = timestamp; previousExpected = expected;
    }
    series.setData(points); chart.timeScale().fitContent();
    const markerApi = createSeriesMarkers(series, selectedRef.current.map((point, index) => ({ time: point.time, position: 'atPriceTop', price: point.price, color: index === 0 ? '#56a8ff' : '#f0c45b', shape: 'circle', text: index === 0 ? 'A' : 'B' } satisfies SeriesMarker<Time>)));
    markerRef.current = markerApi;
    const clickHandler = (event: MouseEventParams<Time>) => {
      if (typeof event.time !== 'number') return;
      const snapshot = snapshotByTime.get(event.time);
      const seriesPoint = event.seriesData.get(series);
      if (!snapshot || !seriesPoint || !('value' in seriesPoint) || !Number.isFinite(seriesPoint.value)) return;
      const point = { snapshot, time: event.time, price: seriesPoint.value };
      setSelected((current) => current.length >= 2 ? [point] : [...current, point]);
    };
    chart.subscribeClick(clickHandler);
    const observer = new ResizeObserver(() => chart.applyOptions({ width: ref.current?.clientWidth ?? 600 })); observer.observe(ref.current);
    return () => { observer.disconnect(); chart.unsubscribeClick(clickHandler); markerRef.current = null; chart.remove(); };
  }, [snapshots]);

  useEffect(() => {
    markerRef.current?.setMarkers(selected.map((point, index) => ({ time: point.time, position: 'atPriceTop', price: point.price, color: index === 0 ? '#56a8ff' : '#f0c45b', shape: 'circle', text: index === 0 ? 'A' : 'B' })));
  }, [selected]);

  const change = selected.length === 2 && selected[0]!.price !== 0 ? (selected[1]!.price - selected[0]!.price) / selected[0]!.price * 100 : null;
  const marketCaps = selected.map((point) => historicalMarketCap(point.snapshot, snapshots));
  const firstMarketCap = marketCaps[0];
  const secondMarketCap = marketCaps[1];
  const marketCapChange = selected.length === 2 && firstMarketCap && secondMarketCap
    ? (secondMarketCap.value - firstMarketCap.value) / firstMarketCap.value * 100
    : null;
  return <div className="chart-explorer">
    <div ref={ref} className="chart" aria-label="Retained price history chart; click two data points to compare them"/>
    <div className="chart-instructions"><span>{selected.length === 0 ? 'Click a point to select A.' : selected.length === 1 ? 'Now click a second point to compare B.' : 'Click another point to start a new comparison.'}</span>{selected.length ? <button type="button" onClick={() => setSelected([])}>Clear comparison</button> : null}</div>
    {selected.length ? <div className="chart-selection" aria-live="polite">
      {selected.map((point, index) => {
        const marketCap = marketCaps[index];
        return <article key={`${point.snapshot.fingerprint}:${index}`} className={`chart-point point-${index === 0 ? 'a' : 'b'}`}><strong>Point {index === 0 ? 'A' : 'B'}</strong><span>{new Date(observedAt(point.snapshot)).toLocaleString()}</span><dl><dt>Price</dt><dd>{price(point.price)}</dd><dt>Market cap</dt><dd>{marketCap ? `${marketCap.estimated ? '≈ ' : ''}${money(String(marketCap.value))}${marketCap.estimated ? ' estimated' : ''}` : 'unknown'}</dd><dt>Liquidity</dt><dd>{money(point.snapshot.liquidityUsd)}</dd><dt>24h volume</dt><dd>{money(point.snapshot.volume24hUsd)}</dd></dl></article>;
      })}
      {change !== null ? <article className={`chart-comparison ${change >= 0 ? 'positive' : 'negative'}`}><strong>{change >= 0 ? 'Up' : 'Down'} {Math.abs(change).toFixed(2)}%</strong><span>Price change from A → B</span>{marketCapChange !== null ? <small>{firstMarketCap?.estimated || secondMarketCap?.estimated ? 'Estimated m' : 'M'}arket cap {marketCapChange >= 0 ? 'up' : 'down'} {Math.abs(marketCapChange).toFixed(2)}%</small> : <small>Historical market cap unavailable for one or both points</small>}</article> : null}
    </div> : null}
  </div>;
}
