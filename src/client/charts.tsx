// Small SVG chart set (no charting dependency). One y-axis per chart, thin marks, recessive grid,
// legend for 2+ series, hover tooltip, and a table view for every chart.
import React, { useEffect, useRef, useState } from 'react';
import { fmt } from './ui.tsx';

export const C = { s1: '#2a78d6', s2: '#eb6834', s3: '#1baf7a', neutral: '#898781', ink: '#0b0b0b', muted: '#898781', grid: '#e6e5e0', axis: '#c3c2b7', bad: '#d03b3b', good: '#0ca30c', surface: '#ffffff' };
export interface Series { name: string; values: (number | null)[]; color?: string; dashed?: boolean }

function useWidth(): [React.RefObject<HTMLDivElement | null>, number] {
  const ref = useRef<HTMLDivElement>(null); const [w, setW] = useState(600);
  useEffect(() => { if (!ref.current) return; const ro = new ResizeObserver((e) => setW(Math.max(240, Math.floor(e[0].contentRect.width)))); ro.observe(ref.current); return () => ro.disconnect(); }, []);
  return [ref, w];
}
function ticks(lo: number, hi: number, n = 4): number[] {
  if (lo === hi) { hi = lo + 1; }
  const span = hi - lo; const raw = span / n; const mag = 10 ** Math.floor(Math.log10(raw)); const step = [1, 2, 2.5, 5, 10].map((m) => m * mag).find((s) => s >= raw)!;
  const out: number[] = []; for (let v = Math.floor(lo / step) * step; v <= hi + step * 0.5; v += step) out.push(Math.abs(v) < step * 1e-9 ? 0 : v);
  return out;
}
const axisFmt = (v: number, kind: string) => (kind === 'money' ? fmt(v, 'money', true) : kind === 'pct' ? `${Math.round(v * 100)}%` : kind === 'ratio' ? `${v.toFixed(1)}x` : kind === 'months' ? v.toFixed(1) : String(v));

export function Spark({ values, color = C.s1, width = 96, height = 28 }: { values: (number | null)[]; color?: string; width?: number; height?: number }) {
  const pts = values.map((v, i) => ({ v, i })).filter((p): p is { v: number; i: number } => p.v !== null);
  if (pts.length < 2) return <svg width={width} height={height} aria-hidden="true" />;
  const lo = Math.min(...pts.map((p) => p.v)), hi = Math.max(...pts.map((p) => p.v)); const span = hi - lo || 1;
  const x = (i: number) => 3 + (i / (values.length - 1)) * (width - 8), y = (v: number) => height - 4 - ((v - lo) / span) * (height - 8);
  const last = pts[pts.length - 1];
  return <svg width={width} height={height} role="img" aria-label="12-period trend"><polyline fill="none" stroke={color} strokeWidth="1.5" strokeLinejoin="round" strokeLinecap="round" points={pts.map((p) => `${x(p.i)},${y(p.v)}`).join(' ')} /><circle cx={x(last.i)} cy={y(last.v)} r="2.5" fill={color} /></svg>;
}

function Frame({ title, series, labels, kind, children }: { title?: string; series: Series[]; labels: string[]; kind: string; children: React.ReactNode }) {
  return <figure className="chart">
    {title && <figcaption>{title}</figcaption>}
    {series.length > 1 && <div className="legend">{series.map((s) => <span key={s.name}><i style={{ background: s.color, opacity: s.dashed ? 0.55 : 1 }} />{s.name}</span>)}</div>}
    {children}
    <details className="chart-table"><summary>View as table</summary><div className="tbl-wrap"><table className="tbl"><thead><tr><th></th>{series.map((s) => <th key={s.name} className="num">{s.name}</th>)}</tr></thead><tbody>{labels.map((l, i) => <tr key={l + i}><td>{l}</td>{series.map((s) => <td key={s.name} className="num">{fmt(s.values[i], kind)}</td>)}</tr>)}</tbody></table></div></details>
  </figure>;
}

interface Props { labels: string[]; series: Series[]; kind: string; height?: number; title?: string; reference?: { value: number; label: string }; zeroBased?: boolean; bars?: boolean; highlight?: (i: number) => boolean }
export function Chart({ labels, series, kind, height = 220, title, reference, zeroBased, bars, highlight }: Props) {
  const [ref, W] = useWidth(); const [hover, setHover] = useState<number | null>(null);
  const colored = series.map((s, i) => ({ ...s, color: s.color ?? [C.s1, C.neutral, C.s2, C.s3][i % 4] }));
  const all = colored.flatMap((s) => s.values).filter((v): v is number => v !== null); if (reference) all.push(reference.value);
  const m = { l: 52, r: 14, t: 10, b: 24 }; const iw = W - m.l - m.r, ih = height - m.t - m.b;
  if (!all.length) return <Frame title={title} series={colored} labels={labels} kind={kind}><div ref={ref} className="empty">No data to chart for this period.</div></Frame>;
  let lo = Math.min(...all), hi = Math.max(...all); if (zeroBased || bars) { lo = Math.min(0, lo); hi = Math.max(0, hi); }
  if (hi - lo < 1e-9) hi = lo + (kind === 'money' ? 100_000 : 1); // flat series: give the axis a sensible span
  const tk = ticks(lo, hi); lo = Math.min(lo, tk[0]); hi = Math.max(hi, tk[tk.length - 1]);
  const n = labels.length; const band = iw / Math.max(n, 1);
  const x = (i: number) => m.l + (bars ? band * (i + 0.5) : n === 1 ? iw / 2 : (i / (n - 1)) * iw), y = (v: number) => m.t + ih - ((v - lo) / (hi - lo || 1)) * ih;
  const every = Math.ceil(n / Math.max(2, Math.floor(iw / 62)));
  const bw = Math.max(3, Math.min(24, (band - 6) / colored.length - 2));
  const onMove = (e: React.MouseEvent<SVGSVGElement>) => { const r = e.currentTarget.getBoundingClientRect(); const px = e.clientX - r.left; const i = bars ? Math.floor((px - m.l) / band) : Math.round(((px - m.l) / iw) * (n - 1)); setHover(i >= 0 && i < n ? i : null); };
  return <Frame title={title} series={colored} labels={labels} kind={kind}>
    <div ref={ref} className="chart-box">
      <svg width={W} height={height} onMouseMove={onMove} onMouseLeave={() => setHover(null)} role="img" aria-label={title ?? colored.map((s) => s.name).join(', ')}>
        {tk.map((t) => <g key={t}><line x1={m.l} x2={W - m.r} y1={y(t)} y2={y(t)} stroke={t === 0 ? C.axis : C.grid} strokeWidth="1" /><text x={m.l - 8} y={y(t) + 4} textAnchor="end" className="tick">{axisFmt(t, kind)}</text></g>)}
        {labels.map((l, i) => (i % every === 0 || i === n - 1) && (i === n - 1 || n - 1 - i >= every * (bars ? 0.6 : 1)) ? <text key={i} x={i === n - 1 && !bars ? W - m.r : x(i)} y={height - 6} textAnchor={i === n - 1 && !bars ? 'end' : 'middle'} className="tick">{l}</text> : null)}
        {reference && <g><line x1={m.l} x2={W - m.r} y1={y(reference.value)} y2={y(reference.value)} stroke={C.ink} strokeWidth="1" strokeDasharray="4 3" /><text x={m.l + 6} y={y(reference.value) - 5} textAnchor="start" className="ref">{reference.label}</text></g>}
        {bars ? colored.map((s, si) => s.values.map((v, i) => { if (v === null) return null; const x0 = x(i) - (colored.length * (bw + 2) - 2) / 2 + si * (bw + 2); const y0 = y(Math.max(v, 0)), h = Math.abs(y(v) - y(0)); const bad = highlight?.(i) && si === colored.length - 1; return <path key={`${si}-${i}`} d={v >= 0 ? `M${x0},${y0 + h} V${y0 + Math.min(4, h)} Q${x0},${y0} ${x0 + Math.min(4, bw / 2)},${y0} H${x0 + bw - Math.min(4, bw / 2)} Q${x0 + bw},${y0} ${x0 + bw},${y0 + Math.min(4, h)} V${y0 + h} Z` : `M${x0},${y0} H${x0 + bw} V${y0 + h} H${x0} Z`} fill={bad ? C.bad : s.color} opacity={hover === null || hover === i ? 1 : 0.55} />; }))
          : colored.map((s) => { const segs: string[] = []; let cur = ''; s.values.forEach((v, i) => { if (v === null) { if (cur) segs.push(cur); cur = ''; } else cur += `${cur ? 'L' : 'M'}${x(i)},${y(v)} `; }); if (cur) segs.push(cur); const li = s.values.reduce((a: number, v, i) => (v !== null ? i : a), -1);
            return <g key={s.name}>{segs.map((d, k) => <path key={k} d={d} fill="none" stroke={s.color} strokeWidth="2" strokeLinejoin="round" strokeLinecap="round" strokeDasharray={s.dashed ? '5 4' : undefined} />)}{li >= 0 && <circle cx={x(li)} cy={y(s.values[li]!)} r="4" fill={s.color} stroke={C.surface} strokeWidth="2" />}</g>; })}
        {hover !== null && !bars && <line x1={x(hover)} x2={x(hover)} y1={m.t} y2={m.t + ih} stroke={C.axis} strokeWidth="1" />}
        {hover !== null && !bars && colored.map((s) => s.values[hover] !== null && <circle key={s.name} cx={x(hover)} cy={y(s.values[hover]!)} r="4" fill={s.color} stroke={C.surface} strokeWidth="2" />)}
      </svg>
      {hover !== null && <div className="tt" style={{ left: Math.min(Math.max(x(hover), 80), W - 80) }}><b>{labels[hover]}</b>{colored.map((s) => <span key={s.name}><i style={{ background: s.color }} />{s.name}<em>{fmt(s.values[hover], kind)}</em></span>)}</div>}
    </div>
  </Frame>;
}
