// Dependency-free readers for .xlsx (zip + XML) and .csv. Read-only; formulas are never executed —
// only the cached cell values are read, and spreadsheet error values (#REF!, #DIV/0!) surface as text for validation to catch.
import { inflateRawSync } from 'node:zlib';

export type Cell = string | number | null;
export interface Sheet { name: string; rows: Cell[][] }

function unzip(buf: Buffer): Map<string, Buffer> {
  const files = new Map<string, Buffer>();
  let eocd = -1;
  for (let i = buf.length - 22; i >= Math.max(0, buf.length - 65_557); i--) if (buf.readUInt32LE(i) === 0x06054b50) { eocd = i; break; }
  if (eocd < 0) throw new Error('This file is not a valid .xlsx workbook.');
  const count = buf.readUInt16LE(eocd + 10); let p = buf.readUInt32LE(eocd + 16);
  let total = 0;
  for (let n = 0; n < count; n++) {
    if (buf.readUInt32LE(p) !== 0x02014b50) throw new Error('This workbook is damaged (bad directory entry).');
    const method = buf.readUInt16LE(p + 10), csize = buf.readUInt32LE(p + 20), usize = buf.readUInt32LE(p + 24);
    const nlen = buf.readUInt16LE(p + 28), elen = buf.readUInt16LE(p + 30), clen = buf.readUInt16LE(p + 32), off = buf.readUInt32LE(p + 42);
    const name = buf.toString('utf8', p + 46, p + 46 + nlen);
    p += 46 + nlen + elen + clen;
    if (!/^xl\/(workbook\.xml|_rels\/workbook\.xml\.rels|sharedStrings\.xml|styles\.xml|worksheets\/[^/]+\.xml)$/.test(name)) continue;
    total += usize; if (total > 200_000_000) throw new Error('This workbook is too large to import.'); // zip-bomb guard
    const lnlen = buf.readUInt16LE(off + 26), lelen = buf.readUInt16LE(off + 28); const start = off + 30 + lnlen + lelen;
    const data = buf.subarray(start, start + csize);
    files.set(name, method === 0 ? data : inflateRawSync(data, { maxOutputLength: 200_000_000 }));
  }
  return files;
}
const unescape = (s: string) => s.replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"').replace(/&apos;/g, "'").replace(/&#(\d+);/g, (_, d) => String.fromCodePoint(Number(d))).replace(/&#x([0-9a-f]+);/gi, (_, h) => String.fromCodePoint(parseInt(h, 16))).replace(/&amp;/g, '&');
const attr = (tag: string, name: string) => new RegExp(`\\b${name}="([^"]*)"`).exec(tag)?.[1];
function colIndex(ref: string): number { let n = 0; for (const ch of ref) { if (ch < 'A' || ch > 'Z') break; n = n * 26 + (ch.charCodeAt(0) - 64); } return n - 1; }
const serialToIso = (v: number) => new Date(Math.round((v - 25569) * 86_400_000)).toISOString().slice(0, 10);

export function readXlsx(buf: Buffer): Sheet[] {
  const files = unzip(buf);
  const wb = files.get('xl/workbook.xml')?.toString('utf8'); const rels = files.get('xl/_rels/workbook.xml.rels')?.toString('utf8');
  if (!wb || !rels) throw new Error('This file is not a valid .xlsx workbook.');
  const strings: string[] = [];
  const ss = files.get('xl/sharedStrings.xml')?.toString('utf8');
  if (ss) for (const m of ss.matchAll(/<si>([\s\S]*?)<\/si>/g)) strings.push(unescape([...m[1].matchAll(/<t[^>]*>([\s\S]*?)<\/t>/g)].map((t) => t[1]).join('')));
  // Which cell styles are dates?
  const dateStyles = new Set<number>();
  const st = files.get('xl/styles.xml')?.toString('utf8');
  if (st) {
    const custom = new Map<number, string>();
    for (const m of st.matchAll(/<numFmt\b[^>]*>/g)) custom.set(Number(attr(m[0], 'numFmtId')), unescape(attr(m[0], 'formatCode') ?? ''));
    const xfs = /<cellXfs[^>]*>([\s\S]*?)<\/cellXfs>/.exec(st)?.[1] ?? '';
    [...xfs.matchAll(/<xf\b[^>]*>/g)].forEach((m, i) => {
      const id = Number(attr(m[0], 'numFmtId') ?? 0); const code = custom.get(id);
      if ((id >= 14 && id <= 22) || (id >= 45 && id <= 47) || (code && /[dy]/i.test(code.replace(/\[[^\]]*\]|"[^"]*"/g, '')))) dateStyles.add(i);
    });
  }
  const targets = new Map<string, string>();
  for (const m of rels.matchAll(/<Relationship\b[^>]*>/g)) targets.set(attr(m[0], 'Id')!, attr(m[0], 'Target')!);
  const sheets: Sheet[] = [];
  for (const m of wb.matchAll(/<sheet\b[^>]*>/g)) {
    const name = unescape(attr(m[0], 'name') ?? ''); const target = targets.get(attr(m[0], 'r:id') ?? '') ?? '';
    const xml = files.get(`xl/${target.replace(/^\/?xl\//, '').replace(/^\//, '')}`)?.toString('utf8');
    if (!xml) continue;
    const rows: Cell[][] = [];
    for (const rm of xml.matchAll(/<row\b([^>]*)>([\s\S]*?)<\/row>/g)) {
      const r = Number(attr(rm[1], 'r') ?? rows.length + 1) - 1;
      if (r > 20_000) break;
      const row: Cell[] = [];
      for (const cm of rm[2].matchAll(/<c\b([^>]*?)(?:\/>|>([\s\S]*?)<\/c>)/g)) {
        const ref = attr(cm[1], 'r') ?? ''; const t = attr(cm[1], 't'); const s = Number(attr(cm[1], 's') ?? -1);
        const body = cm[2] ?? ''; const v = /<v>([\s\S]*?)<\/v>/.exec(body)?.[1];
        let val: Cell = null;
        if (t === 's') val = v === undefined ? null : strings[Number(v)] ?? null;
        else if (t === 'inlineStr') val = unescape([...body.matchAll(/<t[^>]*>([\s\S]*?)<\/t>/g)].map((x) => x[1]).join(''));
        else if (t === 'str' || t === 'e') val = v === undefined ? null : unescape(v);
        else if (t === 'b') val = v === '1' ? 1 : 0;
        else if (v !== undefined && v !== '') { const n = Number(v); val = dateStyles.has(s) ? serialToIso(n) : n; }
        const c = colIndex(ref); if (c >= 0 && c < 500) { while (row.length < c) row.push(null); row[c] = val; }
      }
      while (rows.length < r) rows.push([]);
      rows[r] = row;
    }
    sheets.push({ name, rows });
  }
  return sheets;
}

export function readCsv(text: string): Cell[][] {
  const rows: Cell[][] = []; let row: Cell[] = []; let cur = ''; let q = false; let quoted = false;
  const src = text.replace(/^﻿/, '');
  const push = () => { row.push(cur === '' && !quoted ? null : cur); cur = ''; quoted = false; };
  for (let i = 0; i < src.length; i++) {
    const ch = src[i];
    if (q) { if (ch === '"') { if (src[i + 1] === '"') { cur += '"'; i++; } else q = false; } else cur += ch; }
    else if (ch === '"') { q = true; quoted = true; }
    else if (ch === ',') push();
    else if (ch === '\n' || ch === '\r') { if (ch === '\r' && src[i + 1] === '\n') i++; push(); rows.push(row); row = []; }
    else cur += ch;
  }
  if (cur !== '' || row.length) { push(); rows.push(row); }
  return rows;
}

const MONTHS: Record<string, number> = { jan: 1, feb: 2, mar: 3, apr: 4, may: 5, jun: 6, jul: 7, aug: 8, sep: 9, oct: 10, nov: 11, dec: 12 };
const ym = (y: number, m: number) => (m >= 1 && m <= 12 && y >= 1990 && y <= 2100 ? `${y}-${String(m).padStart(2, '0')}` : null);
/** Recognize a column heading as a month: 2025-01, 2025-01-31, Jan 2025, January 2025, Jan-25, 1/2025, 01/31/2025. */
export function parsePeriod(c: Cell): string | null {
  if (c === null || typeof c === 'number') return null;
  const s = String(c).trim(); let m: RegExpExecArray | null;
  if ((m = /^(\d{4})-(\d{1,2})(?:-\d{1,2})?(?:[T ].*)?$/.exec(s))) return ym(Number(m[1]), Number(m[2]));
  if ((m = /^([A-Za-z]{3})[A-Za-z]*\.?[\s\-,/]+(\d{2}|\d{4})$/.exec(s))) { const mo = MONTHS[m[1].toLowerCase()]; const y = Number(m[2]); return mo ? ym(y < 100 ? 2000 + y : y, mo) : null; }
  if ((m = /^(\d{1,2})\/(\d{4})$/.exec(s))) return ym(Number(m[2]), Number(m[1]));
  if ((m = /^(\d{1,2})\/\d{1,2}\/(\d{2}|\d{4})$/.exec(s))) { const y = Number(m[2]); return ym(y < 100 ? 2000 + y : y, Number(m[1])); }
  return null;
}
/** Parse a money cell into cents. Returns 'blank' for empty cells and 'invalid' for anything that is not a number. */
export function parseAmount(c: Cell): number | 'blank' | 'invalid' {
  if (c === null) return 'blank';
  if (typeof c === 'number') return Number.isFinite(c) ? Math.round(c * 100) : 'invalid';
  let s = c.trim(); if (s === '' || s === '-' || s === '—') return 'blank';
  let neg = false;
  if (/^\(.*\)$/.test(s)) { neg = true; s = s.slice(1, -1); }
  s = s.replace(/[$,\s]/g, ''); if (s.startsWith('-')) { neg = !neg; s = s.slice(1); }
  if (!/^\d+(\.\d+)?$|^\.\d+$/.test(s)) return 'invalid';
  const n = Math.round(Number(s) * 100);
  return neg ? -n : n;
}
