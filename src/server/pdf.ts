// Minimal PDF writer: US Letter pages, Helvetica and Helvetica-Bold, text, rules and shaded bands. No dependencies.
// Enough for a statements packet; it is not a general layout engine.
const W = [278,278,355,556,556,889,667,191,333,333,389,584,278,333,278,278,556,556,556,556,556,556,556,556,556,556,278,278,584,584,584,556,1015,667,667,722,722,667,611,778,722,278,500,667,556,833,722,778,667,778,722,667,611,722,667,944,667,667,611,278,278,278,469,556,333,556,556,500,556,556,278,556,556,222,222,500,222,833,556,556,556,556,333,500,278,556,500,722,500,500,500,334,260,334,584];
const ANSI: Record<string, number> = { '—': 0x97, '–': 0x96, '−': 0x2d, '×': 0xd7, '·': 0xb7, '’': 0x92, '‘': 0x91, '“': 0x93, '”': 0x94, '•': 0x95, '÷': 0xf7, '…': 0x85, '≥': 0x3e, '≤': 0x3c };
const code = (ch: string) => { const c = ch.charCodeAt(0); return c >= 32 && c < 127 ? c : ANSI[ch] ?? (c >= 0xa0 && c <= 0xff ? c : 0x3f); };
export function textWidth(s: string, size: number, bold = false): number { let w = 0; for (const ch of s) { const c = code(ch); w += c >= 32 && c < 127 ? W[c - 32] : 556; } return (w * size * (bold && /[A-Za-z]/.test(s) ? 1.06 : 1)) / 1000; }
const lit = (s: string) => { let o = ''; for (const ch of s) { const c = code(ch); o += c === 0x28 || c === 0x29 || c === 0x5c ? '\\' + String.fromCharCode(c) : String.fromCharCode(c); } return o; };
export function wrap(s: string, size: number, maxWidth: number, bold = false): string[] {
  const out: string[] = []; for (const para of s.split('\n')) { let line = ''; for (const word of para.split(/\s+/).filter(Boolean)) { const t = line ? `${line} ${word}` : word; if (line && textWidth(t, size, bold) > maxWidth) { out.push(line); line = word; } else line = t; } out.push(line); } return out;
}
export interface TextOpts { size?: number; bold?: boolean; align?: 'left' | 'right'; gray?: number }
export class Pdf {
  static readonly width = 612; static readonly height = 792; private pages: string[] = []; private cur = '';
  addPage() { if (this.pages.length || this.cur) this.pages.push(this.cur); this.cur = ''; if (!this.pages.length && !this.cur) this.cur = ' '; }
  get pageCount() { return this.pages.length + 1; }
  /** Draw on an earlier page (0-based), e.g. to add "Page n of N" footers once the page count is known. */
  onPage(i: number, f: () => void) { const all = [...this.pages, this.cur]; const keep = this.cur; this.cur = all[i]; f(); all[i] = this.cur; this.pages = all.slice(0, -1); this.cur = i === all.length - 1 ? all[i] : keep; }
  text(x: number, y: number, s: string, o: TextOpts = {}) { const size = o.size ?? 10; const tx = o.align === 'right' ? x - textWidth(s, size, o.bold) : x; this.cur += `BT /${o.bold ? 'F2' : 'F1'} ${size} Tf ${o.gray ?? 0} g ${tx.toFixed(2)} ${(Pdf.height - y).toFixed(2)} Td (${lit(s)}) Tj ET\n`; }
  rule(x1: number, y: number, x2: number, gray = 0.75, width = 0.5) { this.cur += `${gray} G ${width} w ${x1.toFixed(2)} ${(Pdf.height - y).toFixed(2)} m ${x2.toFixed(2)} ${(Pdf.height - y).toFixed(2)} l S\n`; }
  band(x: number, y: number, w: number, h: number, gray = 0.95) { this.cur += `${gray} g ${x.toFixed(2)} ${(Pdf.height - y - h).toFixed(2)} ${w.toFixed(2)} ${h.toFixed(2)} re f\n`; }
  build(info: { title: string; author: string }): Buffer {
    const pages = [...this.pages, this.cur]; const objs: string[] = []; const add = (s: string) => objs.push(s); const n = pages.length;
    add('<< /Type /Catalog /Pages 2 0 R >>'); add(`<< /Type /Pages /Count ${n} /Kids [${pages.map((_, i) => `${5 + i * 2} 0 R`).join(' ')}] >>`);
    add('<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica /Encoding /WinAnsiEncoding >>'); add('<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica-Bold /Encoding /WinAnsiEncoding >>');
    pages.forEach((c, i) => { add(`<< /Type /Page /Parent 2 0 R /MediaBox [0 0 ${Pdf.width} ${Pdf.height}] /Resources << /Font << /F1 3 0 R /F2 4 0 R >> >> /Contents ${6 + i * 2} 0 R >>`); add(`<< /Length ${Buffer.byteLength(c, 'latin1')} >>\nstream\n${c}\nendstream`); });
    add(`<< /Title (${lit(info.title)}) /Author (${lit(info.author)}) /Producer (CFO Intelligence) >>`);
    let out = '%PDF-1.4\n%\xe2\xe3\xcf\xd3\n'; const offs: number[] = []; objs.forEach((o, i) => { offs.push(Buffer.byteLength(out, 'latin1')); out += `${i + 1} 0 obj\n${o}\nendobj\n`; });
    const xref = Buffer.byteLength(out, 'latin1'); out += `xref\n0 ${objs.length + 1}\n0000000000 65535 f \n${offs.map((o) => `${String(o).padStart(10, '0')} 00000 n \n`).join('')}trailer\n<< /Size ${objs.length + 1} /Root 1 0 R /Info ${objs.length} 0 R >>\nstartxref\n${xref}\n%%EOF\n`;
    return Buffer.from(out, 'latin1');
  }
}
/** Flowing layout on top of Pdf: headings, wrapped paragraphs and simple tables, breaking to a new page when the current one is full. */
export interface Col { label: string; width: number; align?: 'left' | 'right' }
export class Flow {
  readonly pdf = new Pdf(); y = 0; readonly left = 48; readonly right = Pdf.width - 48; private top: number; private bottom = Pdf.height - 56; private onNew: (f: Flow) => void;
  constructor(top: number, onNew: (f: Flow) => void) { this.top = top; this.onNew = onNew; this.pdf.addPage(); this.y = top; onNew(this); }
  newPage() { this.pdf.addPage(); this.y = this.top; this.onNew(this); }
  need(h: number) { if (this.y + h > this.bottom) this.newPage(); }
  heading(s: string, size = 13) { this.need(size + 26); this.y += 8; this.pdf.text(this.left, this.y + size, s, { size, bold: true }); this.y += size + 9; }
  para(s: string, o: TextOpts & { indent?: number; gap?: number } = {}) { const size = o.size ?? 10; const x = this.left + (o.indent ?? 0); for (const l of wrap(s, size, this.right - x, o.bold)) { this.need(size + 4); this.pdf.text(x, this.y + size, l, o); this.y += size + 4; } this.y += o.gap ?? 3; }
  bullet(s: string, size = 10) { const lines = wrap(s, size, this.right - this.left - 14); lines.forEach((l, i) => { this.need(size + 4); if (i === 0) this.pdf.text(this.left + 2, this.y + size, '•', { size }); this.pdf.text(this.left + 14, this.y + size, l, { size }); this.y += size + 4; }); this.y += 2; }
  table(cols: Col[], rows: { cells: string[]; bold?: boolean; rule?: boolean; note?: string; gray?: number }[], size = 9.5) {
    const xs: number[] = []; let x = this.left; for (const c of cols) { xs.push(x); x += c.width; }
    const head = () => { this.pdf.band(this.left, this.y, this.right - this.left, size + 8, 0.93); cols.forEach((c, i) => this.pdf.text(c.align === 'right' ? xs[i] + c.width - 4 : xs[i] + 4, this.y + size + 2, c.label, { size: size - 1, bold: true, align: c.align, gray: 0.25 })); this.y += size + 10; };
    this.need((size + 8) * 3); head();
    for (const r of rows) {
      const note = r.note ? wrap(r.note, size - 1, this.right - this.left - 16) : []; const h = size + 7 + note.length * (size + 2);
      if (this.y + h > this.bottom) { this.newPage(); head(); }
      if (r.rule) this.pdf.rule(this.left, this.y, this.right, 0.45);
      r.cells.forEach((cell, i) => { const c = cols[i]; let s = cell; if (c.align !== 'right') while (s.length > 4 && textWidth(s, size, r.bold) > c.width - 8) s = s.slice(0, -2); this.pdf.text(c.align === 'right' ? xs[i] + c.width - 4 : xs[i] + 4, this.y + size + 2, s === cell ? s : s + '…', { size, bold: r.bold, align: c.align, gray: r.gray }); });
      this.y += size + 7; note.forEach((l) => { this.pdf.text(this.left + 12, this.y + size - 3, l, { size: size - 1, gray: 0.35 }); this.y += size + 2; });
      this.pdf.rule(this.left, this.y, this.right, 0.88, 0.3);
    }
    this.y += 8;
  }
}
