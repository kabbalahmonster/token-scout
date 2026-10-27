import { useEffect, useRef } from 'react';
import { ColorType, createChart, LineSeries, type LineData, type Time, type WhitespaceData } from 'lightweight-charts';
import type { MarketSnapshot } from '@doomscout/domain';

export function PriceChart({ snapshots }: { snapshots: MarketSnapshot[] }) {
  const ref = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (!ref.current) return;
    const chart = createChart(ref.current, { height: 300, layout: { background: { type: ColorType.Solid, color: 'transparent' }, textColor: '#91a3aa' }, grid: { vertLines: { color: '#172126' }, horzLines: { color: '#172126' } }, rightPriceScale: { borderColor: '#25353c' }, timeScale: { borderColor: '#25353c', timeVisible: true } });
    const series = chart.addSeries(LineSeries, { color: '#50f0b6', lineWidth: 2, priceFormat: { type: 'price', precision: 12, minMove: 1e-12 } });
    const points: Array<LineData | WhitespaceData> = [];
    let previous = 0;
    let previousExpected = 60;
    for (const snapshot of snapshots) {
      const timestamp = Math.floor(Date.parse(snapshot.ingestedAt) / 1000);
      const value = Number(snapshot.priceUsd ?? snapshot.priceNative);
      if (!Number.isFinite(timestamp) || !Number.isFinite(value)) continue;
      const expected = snapshot.source === 'doomscout_1h_aggregate' || snapshot.source === 'geckoterminal_1h_candle' ? 3600 : snapshot.source === 'doomscout_5m_aggregate' ? 300 : 60;
      // Aggregated history has a lower expected cadence than raw observations;
      // break only when a gap exceeds three intervals for either adjacent tier.
      if (previous && timestamp - previous > Math.max(previousExpected, expected) * 3) points.push({ time: (previous + previousExpected) as Time });
      points.push({ time: timestamp as Time, value }); previous = timestamp; previousExpected = expected;
    }
    series.setData(points); chart.timeScale().fitContent();
    const observer = new ResizeObserver(() => chart.applyOptions({ width: ref.current?.clientWidth ?? 600 })); observer.observe(ref.current);
    return () => { observer.disconnect(); chart.remove(); };
  }, [snapshots]);
  return <div ref={ref} className="chart" aria-label="Retained price history chart"/>;
}
