// Minimal PDF writer: Helvetica and Helvetica-Bold text, rules, shaded bands, coloured lines and shapes, and one kind of image (PNG). No dependencies.
// Enough for a statements packet and slides; it is not a general layout engine.
import { deflateSync, inflateSync } from 'node:zlib';
const W = [278,278,355,556,556,889,667,191,333,333,389,584,278,333,278,278,556,556,556,556,556,556,556,556,556,556,278,278,584,584,584,556,1015,667,667,722,722,667,611,778,722,278,500,667,556,833,722,778,667,778,722,667,611,722,667,944,667,667,611,278,278,278,469,556,333,556,556,500,556,556,278,556,556,222,222,500,222,833,556,556,556,556,333,500,278,556,500,722,500,500,500,334,260,334,584];
const ANSI: Record<string, number> = { '—': 0x97, '–': 0x96, '−': 0x2d, '×': 0xd7, '·': 0xb7, '’': 0x92, '‘': 0x91, '“': 0x93, '”': 0x94, '•': 0x95, '÷': 0xf7, '…': 0x85, '≥': 0x3e, '≤': 0x3c };
const code = (ch: string) => { const c = ch.charCodeAt(0); return c >= 32 && c < 127 ? c : ANSI[ch] ?? (c >= 0xa0 && c <= 0xff ? c : 0x3f); };
export function textWidth(s: string, size: number, bold = false): number { let w = 0; for (const ch of s) { const c = code(ch); w += c >= 32 && c < 127 ? W[c - 32] : 556; } return (w * size * (bold && /[A-Za-z]/.test(s) ? 1.06 : 1)) / 1000; }
const lit = (s: string) => { let o = ''; for (const ch of s) { const c = code(ch); o += c === 0x28 || c === 0x29 || c === 0x5c ? '\\' + String.fromCharCode(c) : String.fromCharCode(c); } return o; };
export function wrap(s: string, size: number, maxWidth: number, bold = false): string[] {
  const out: string[] = []; for (const para of s.split('\n')) { let line = ''; for (const word of para.split(/\s+/).filter(Boolean)) { const t = line ? `${line} ${word}` : word; if (line && textWidth(t, size, bold) > maxWidth) { out.push(line); line = word; } else line = t; } out.push(line); } return out;
}
export type RGB = [number, number, number];
export const hex = (h: string): RGB => [1, 3, 5].map((i) => Math.round((parseInt(h.slice(i, i + 2), 16) / 255) * 1000) / 1000) as RGB;
export interface TextOpts { size?: number; bold?: boolean; align?: 'left' | 'right'; gray?: number; color?: RGB }
/** Decode an 8-bit RGB or RGBA, non-interlaced PNG. Returns null for anything else, so a logo that cannot be read is left out rather than breaking the packet. */
export function decodePng(buf: Buffer): { w: number; h: number; rgb: Buffer; alpha: Buffer | null } | null {
  try {
    if (buf.length < 33 || buf.readUInt32BE(0) !== 0x89504e47 || buf.readUInt32BE(4) !== 0x0d0a1a0a) return null; let o = 8, w = 0, h = 0, ct = -1; const idat: Buffer[] = [];
    while (o + 12 <= buf.length) { const len = buf.readUInt32BE(o); const type = buf.toString('latin1', o + 4, o + 8); const d = buf.subarray(o + 8, o + 8 + len);
      if (type === 'IHDR') { w = d.readUInt32BE(0); h = d.readUInt32BE(4); ct = d[9]; if (d[8] !== 8 || (ct !== 2 && ct !== 6) || d[12] !== 0) return null; } else if (type === 'IDAT') idat.push(d); else if (type === 'IEND') break; o += 12 + len; }
    if (!w || !h || w > 4000 || h > 4000 || !idat.length) return null; const bpp = ct === 6 ? 4 : 3; const stride = w * bpp; const raw = inflateSync(Buffer.concat(idat)); if (raw.length < (stride + 1) * h) return null;
    const px = Buffer.alloc(stride * h);
    for (let y = 0; y < h; y++) { const f = raw[y * (stride + 1)]; const src = y * (stride + 1) + 1; const dst = y * stride;
      for (let x = 0; x < stride; x++) { const a = x >= bpp ? px[dst + x - bpp] : 0; const b = y ? px[dst + x - stride] : 0; const c = y && x >= bpp ? px[dst + x - stride - bpp] : 0; let v = raw[src + x];
        if (f === 1) v += a; else if (f === 2) v += b; else if (f === 3) v += (a + b) >> 1; else if (f === 4) { const p = a + b - c; const pa = Math.abs(p - a), pb = Math.abs(p - b), pc = Math.abs(p - c); v += pa <= pb && pa <= pc ? a : pb <= pc ? b : c; } else if (f !== 0) return null;
        px[dst + x] = v & 255; } }
    if (bpp === 3) return { w, h, rgb: px, alpha: null }; const rgb = Buffer.alloc(w * h * 3), alpha = Buffer.alloc(w * h);
    for (let i = 0; i < w * h; i++) { rgb[i * 3] = px[i * 4]; rgb[i * 3 + 1] = px[i * 4 + 1]; rgb[i * 3 + 2] = px[i * 4 + 2]; alpha[i] = px[i * 4 + 3]; } return { w, h, rgb, alpha };
  } catch { return null; }
}
export class Pdf {
  static readonly width = 612; static readonly height = 792; private pages: string[] = []; private cur = ''; private images: { w: number; h: number; rgb: Buffer; alpha: Buffer | null }[] = [];
  /** Page size in points. Defaults to US Letter portrait; slides use a 16:9 page. */
  readonly w: number; readonly h: number; constructor(w = 612, h = 792) { this.w = w; this.h = h; }
  addPage() { if (this.pages.length || this.cur) this.pages.push(this.cur); this.cur = ''; if (!this.pages.length && !this.cur) this.cur = ' '; }
  get pageCount() { return this.pages.length + 1; }
  /** Draw on an earlier page (0-based), e.g. to add "Page n of N" footers once the page count is known. */
  onPage(i: number, f: () => void) { const all = [...this.pages, this.cur]; const keep = this.cur; this.cur = all[i]; f(); all[i] = this.cur; this.pages = all.slice(0, -1); this.cur = i === all.length - 1 ? all[i] : keep; }
  text(x: number, y: number, s: string, o: TextOpts = {}) { const size = o.size ?? 10; const tx = o.align === 'right' ? x - textWidth(s, size, o.bold) : x; this.cur += `BT /${o.bold ? 'F2' : 'F1'} ${size} Tf ${o.color ? `${o.color.join(' ')} rg` : `${o.gray ?? 0} g`} ${tx.toFixed(2)} ${(this.h - y).toFixed(2)} Td (${lit(s)}) Tj ET\n`; }
  rule(x1: number, y: number, x2: number, gray = 0.75, width = 0.5) { this.cur += `${gray} G ${width} w ${x1.toFixed(2)} ${(this.h - y).toFixed(2)} m ${x2.toFixed(2)} ${(this.h - y).toFixed(2)} l S\n`; }
  band(x: number, y: number, w: number, h: number, gray = 0.95) { this.cur += `${gray} g ${x.toFixed(2)} ${(this.h - y - h).toFixed(2)} ${w.toFixed(2)} ${h.toFixed(2)} re f\n`; }
  private pt(x: number, y: number) { return `${x.toFixed(2)} ${(this.h - y).toFixed(2)}`; }
  /** A connected line through the points, e.g. a chart series or sparkline. */
  line(pts: [number, number][], color: RGB, width = 1) { if (pts.length < 2) return; this.cur += `${color.join(' ')} RG ${width} w 1 J 1 j ${pts.map(([x, y], i) => `${this.pt(x, y)} ${i ? 'l' : 'm'}`).join(' ')} S\n`; }
  /** A filled shape, e.g. the up or down marker beside a change. */
  poly(pts: [number, number][], color: RGB) { if (pts.length < 3) return; this.cur += `${color.join(' ')} rg ${pts.map(([x, y], i) => `${this.pt(x, y)} ${i ? 'l' : 'm'}`).join(' ')} h f\n`; }
  dot(x: number, y: number, r: number, color: RGB) { const k = r * 0.5523; const Y = this.h - y; const n = (v: number) => v.toFixed(2); this.cur += `${color.join(' ')} rg ${n(x + r)} ${n(Y)} m ${n(x + r)} ${n(Y + k)} ${n(x + k)} ${n(Y + r)} ${n(x)} ${n(Y + r)} c ${n(x - k)} ${n(Y + r)} ${n(x - r)} ${n(Y + k)} ${n(x - r)} ${n(Y)} c ${n(x - r)} ${n(Y - k)} ${n(x - k)} ${n(Y - r)} ${n(x)} ${n(Y - r)} c ${n(x + k)} ${n(Y - r)} ${n(x + r)} ${n(Y - k)} ${n(x + r)} ${n(Y)} c f\n`; }
  /** A box with an optional fill and outline, e.g. a figure tile. */
  box(x: number, y: number, w: number, h: number, o: { fill?: RGB; stroke?: RGB; width?: number } = {}) { const r = `${x.toFixed(2)} ${(this.h - y - h).toFixed(2)} ${w.toFixed(2)} ${h.toFixed(2)} re`; if (o.fill) this.cur += `${o.fill.join(' ')} rg ${r} f\n`; if (o.stroke) this.cur += `${o.stroke.join(' ')} RG ${o.width ?? 0.5} w ${r} S\n`; }
  /** Register a decoded PNG once and get back a handle to draw it on any page. */
  addImage(img: { w: number; h: number; rgb: Buffer; alpha: Buffer | null }) { this.images.push(img); return { id: this.images.length, w: img.w, h: img.h }; }
  image(im: { id: number }, x: number, y: number, w: number, h: number) { this.cur += `q ${w.toFixed(2)} 0 0 ${h.toFixed(2)} ${x.toFixed(2)} ${(this.h - y - h).toFixed(2)} cm /Im${im.id} Do Q\n`; }
  build(info: { title: string; author: string }): Buffer {
    const pages = [...this.pages, this.cur]; const objs: string[] = []; const add = (s: string) => objs.push(s); const n = pages.length;
    add('<< /Type /Catalog /Pages 2 0 R >>'); add(`<< /Type /Pages /Count ${n} /Kids [${pages.map((_, i) => `${5 + i * 2} 0 R`).join(' ')}] >>`);
    add('<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica /Encoding /WinAnsiEncoding >>'); add('<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica-Bold /Encoding /WinAnsiEncoding >>');
    const imgAt: number[] = []; { let k = 5 + n * 2; for (const im of this.images) { imgAt.push(k); k += im.alpha ? 2 : 1; } } const xo = imgAt.length ? ` /XObject << ${imgAt.map((o, i) => `/Im${i + 1} ${o} 0 R`).join(' ')} >>` : '';
    pages.forEach((c, i) => { add(`<< /Type /Page /Parent 2 0 R /MediaBox [0 0 ${this.w} ${this.h}] /Resources << /Font << /F1 3 0 R /F2 4 0 R >>${xo} >> /Contents ${6 + i * 2} 0 R >>`); add(`<< /Length ${Buffer.byteLength(c, 'latin1')} >>\nstream\n${c}\nendstream`); });
    this.images.forEach((im, i) => { const z = deflateSync(im.rgb).toString('latin1');
      add(`<< /Type /XObject /Subtype /Image /Width ${im.w} /Height ${im.h} /ColorSpace /DeviceRGB /BitsPerComponent 8 /Filter /FlateDecode${im.alpha ? ` /SMask ${imgAt[i] + 1} 0 R` : ''} /Length ${z.length} >>\nstream\n${z}\nendstream`);
      if (im.alpha) { const a = deflateSync(im.alpha).toString('latin1'); add(`<< /Type /XObject /Subtype /Image /Width ${im.w} /Height ${im.h} /ColorSpace /DeviceGray /BitsPerComponent 8 /Filter /FlateDecode /Length ${a.length} >>\nstream\n${a}\nendstream`); } });
    add(`<< /Title (${lit(info.title)}) /Author (${lit(info.author)}) /Producer (CFO Intelligence) >>`);
    let out = '%PDF-1.4\n%\xe2\xe3\xcf\xd3\n'; const offs: number[] = []; objs.forEach((o, i) => { offs.push(Buffer.byteLength(out, 'latin1')); out += `${i + 1} 0 obj\n${o}\nendobj\n`; });
    const xref = Buffer.byteLength(out, 'latin1'); out += `xref\n0 ${objs.length + 1}\n0000000000 65535 f \n${offs.map((o) => `${String(o).padStart(10, '0')} 00000 n \n`).join('')}trailer\n<< /Size ${objs.length + 1} /Root 1 0 R /Info ${objs.length} 0 R >>\nstartxref\n${xref}\n%%EOF\n`;
    return Buffer.from(out, 'latin1');
  }
}
/** Flowing layout on top of Pdf: headings, wrapped paragraphs and simple tables, breaking to a new page when the current one is full. */
export interface Col { label: string; width: number; align?: 'left' | 'right' }
export class Flow {
  readonly pdf: Pdf; y = 0; readonly left: number; readonly right: number; private top: number; readonly bottom: number; private onNew: (f: Flow) => void;
  /** Defaults to US Letter portrait; pass a width and height for another page, e.g. 792 by 612 for landscape. */
  constructor(top: number, onNew: (f: Flow) => void, o: { w?: number; h?: number; margin?: number; first?: boolean } = {}) { this.pdf = new Pdf(o.w ?? 612, o.h ?? 792); this.left = o.margin ?? 48; this.right = this.pdf.w - this.left; this.bottom = this.pdf.h - 56; this.top = top; this.onNew = onNew; this.pdf.addPage(); this.y = top; if (o.first !== false) onNew(this); }
  /** Draw the page header on the current page (used when the first page's header waits for something, such as a logo). */
  header() { this.onNew(this); }
  newPage() { this.pdf.addPage(); this.y = this.top; this.onNew(this); }
  need(h: number) { if (this.y + h > this.bottom) this.newPage(); }
  heading(s: string, size = 13) { this.need(size + 26); this.y += 8; this.pdf.text(this.left, this.y + size, s, { size, bold: true }); this.y += size + 9; }
  para(s: string, o: TextOpts & { indent?: number; gap?: number } = {}) { const size = o.size ?? 10; const x = this.left + (o.indent ?? 0); for (const l of wrap(s, size, this.right - x, o.bold)) { this.need(size + 4); this.pdf.text(x, this.y + size, l, o); this.y += size + 4; } this.y += o.gap ?? 3; }
  bullet(s: string, size = 10) { const lines = wrap(s, size, this.right - this.left - 14); lines.forEach((l, i) => { this.need(size + 4); if (i === 0) this.pdf.text(this.left + 2, this.y + size, '•', { size }); this.pdf.text(this.left + 14, this.y + size, l, { size }); this.y += size + 4; }); this.y += 2; }
  table(cols: Col[], rows: { cells: string[]; bold?: boolean; rule?: boolean; note?: string; gray?: number; /** Text colour per cell, e.g. for a favorable or unfavorable difference. */ colors?: (RGB | undefined)[] }[], size = 9.5) {
    const xs: number[] = []; let x = this.left; for (const c of cols) { xs.push(x); x += c.width; }
    const head = () => { this.pdf.band(this.left, this.y, this.right - this.left, size + 8, 0.93); cols.forEach((c, i) => this.pdf.text(c.align === 'right' ? xs[i] + c.width - 4 : xs[i] + 4, this.y + size + 2, c.label, { size: size - 1, bold: true, align: c.align, gray: 0.25 })); this.y += size + 10; };
    this.need((size + 8) * 3); head();
    for (const r of rows) {
      const note = r.note ? wrap(r.note, size - 1, this.right - this.left - 16) : []; const h = size + 7 + note.length * (size + 2);
      if (this.y + h > this.bottom) { this.newPage(); head(); }
      if (r.rule) this.pdf.rule(this.left, this.y, this.right, 0.45);
      r.cells.forEach((cell, i) => { const c = cols[i]; let s = cell; if (c.align !== 'right') while (s.length > 4 && textWidth(s, size, r.bold) > c.width - 8) s = s.slice(0, -2); this.pdf.text(c.align === 'right' ? xs[i] + c.width - 4 : xs[i] + 4, this.y + size + 2, s === cell ? s : s + '…', { size, bold: r.bold, align: c.align, gray: r.gray, color: r.colors?.[i] }); });
      this.y += size + 7; note.forEach((l) => { this.pdf.text(this.left + 12, this.y + size - 3, l, { size: size - 1, gray: 0.35 }); this.y += size + 2; });
      this.pdf.rule(this.left, this.y, this.right, 0.88, 0.3);
    }
    this.y += 8;
  }
}
