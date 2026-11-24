// Meeting slides: one deck model rendered to PowerPoint (.pptx, which Google Slides and Keynote also open) and to PDF. No dependencies.
import { crc32, deflateRawSync } from 'node:zlib';
import { Pdf, textWidth, wrap } from './pdf.ts';

export interface SlideTable { head: string[]; rows: { cells: string[]; bold?: boolean }[]; widths: number[]; /** Columns after the first are right-aligned. */ }
export interface Slide { kind: 'title' | 'content'; title: string; subtitle?: string; lead?: string; bullets?: string[]; table?: SlideTable; note?: string }
export interface Deck { title: string; author: string; footer: string; slides: Slide[] }

// ---------- zip ----------
function zip(files: [string, string][]): Buffer {
  const parts: Buffer[] = [], central: Buffer[] = []; let off = 0;
  for (const [name, text] of files) { const data = Buffer.from(text, 'utf8'), comp = deflateRawSync(data), nm = Buffer.from(name, 'utf8'), crc = crc32(data);
    const h = Buffer.alloc(30); h.writeUInt32LE(0x04034b50, 0); h.writeUInt16LE(20, 4); h.writeUInt16LE(0x0800, 6); h.writeUInt16LE(8, 8); h.writeUInt32LE(0x00210000, 10); h.writeUInt32LE(crc, 14); h.writeUInt32LE(comp.length, 18); h.writeUInt32LE(data.length, 22); h.writeUInt16LE(nm.length, 26);
    const c = Buffer.alloc(46); c.writeUInt32LE(0x02014b50, 0); c.writeUInt16LE(20, 4); c.writeUInt16LE(20, 6); c.writeUInt16LE(0x0800, 8); c.writeUInt16LE(8, 10); c.writeUInt32LE(0x00210000, 12); c.writeUInt32LE(crc, 16); c.writeUInt32LE(comp.length, 20); c.writeUInt32LE(data.length, 24); c.writeUInt16LE(nm.length, 28); c.writeUInt32LE(off, 42);
    parts.push(h, nm, comp); central.push(c, nm); off += 30 + nm.length + comp.length; }
  const cd = Buffer.concat(central); const end = Buffer.alloc(22); end.writeUInt32LE(0x06054b50, 0); end.writeUInt16LE(files.length, 8); end.writeUInt16LE(files.length, 10); end.writeUInt32LE(cd.length, 12); end.writeUInt32LE(off, 16);
  return Buffer.concat([...parts, cd, end]);
}

// ---------- PowerPoint ----------
const W = 12192000, H = 6858000, M = 594360; const esc = (s: string) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
const NS = 'xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships" xmlns:p="http://schemas.openxmlformats.org/presentationml/2006/main"';
const X = '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>\n'; const INK = '1A1D21', MUTED = '5A6068', ACCENT = '1F4E79';
const run = (t: string, sz: number, o: { b?: boolean; color?: string } = {}) => `<a:r><a:rPr lang="en-US" sz="${Math.round(sz * 100)}"${o.b ? ' b="1"' : ''} dirty="0"><a:solidFill><a:srgbClr val="${o.color ?? INK}"/></a:solidFill><a:latin typeface="Calibri"/></a:rPr><a:t>${esc(t)}</a:t></a:r>`;
const para = (t: string, sz: number, o: { b?: boolean; color?: string; bullet?: boolean; algn?: string; after?: number } = {}) => `<a:p><a:pPr${o.bullet ? ' marL="342900" indent="-342900"' : ''}${o.algn ? ` algn="${o.algn}"` : ''}><a:spcAft><a:spcPts val="${(o.after ?? 0) * 100}"/></a:spcAft>${o.bullet ? '<a:buFont typeface="Arial"/><a:buChar char="&#8226;"/>' : '<a:buNone/>'}</a:pPr>${run(t, sz, o)}</a:p>`;
let sid = 0;
const box = (x: number, y: number, w: number, h: number, body: string, name: string, anchor = 't') => `<p:sp><p:nvSpPr><p:cNvPr id="${++sid}" name="${name}"/><p:cNvSpPr txBox="1"/><p:nvPr/></p:nvSpPr><p:spPr><a:xfrm><a:off x="${x}" y="${y}"/><a:ext cx="${w}" cy="${h}"/></a:xfrm><a:prstGeom prst="rect"><a:avLst/></a:prstGeom><a:noFill/></p:spPr><p:txBody><a:bodyPr wrap="square" lIns="0" tIns="0" rIns="0" bIns="0" anchor="${anchor}"><a:normAutofit/></a:bodyPr><a:lstStyle/>${body}</p:txBody></p:sp>`;
const line = (x: number, y: number, w: number) => `<p:cxnSp><p:nvCxnSpPr><p:cNvPr id="${++sid}" name="Rule"/><p:cNvCxnSpPr/><p:nvPr/></p:nvCxnSpPr><p:spPr><a:xfrm><a:off x="${x}" y="${y}"/><a:ext cx="${w}" cy="0"/></a:xfrm><a:prstGeom prst="line"><a:avLst/></a:prstGeom><a:ln w="19050"><a:solidFill><a:srgbClr val="${ACCENT}"/></a:solidFill></a:ln></p:spPr></p:cxnSp>`;
function table(t: SlideTable, x: number, y: number, w: number, sz: number): string {
  const tot = t.widths.reduce((a, b) => a + b, 0); const ws = t.widths.map((f) => Math.round((w * f) / tot)); const rh = Math.round(sz * 12700 * 2.1); const noLn = (k: string) => `<a:${k} w="0"><a:noFill/></a:${k}>`;
  const cell = (s: string, i: number, head: boolean, bold?: boolean) => `<a:tc><a:txBody><a:bodyPr/><a:lstStyle/>${para(s, sz, { b: head || bold, color: head ? 'FFFFFF' : INK, algn: i === 0 ? 'l' : 'r' })}</a:txBody><a:tcPr marL="91440" marR="91440" marT="45720" marB="45720" anchor="ctr">${noLn('lnL')}${noLn('lnR')}${noLn('lnT')}<a:lnB w="6350"><a:solidFill><a:srgbClr val="CFD3D8"/></a:solidFill></a:lnB>${head ? `<a:solidFill><a:srgbClr val="${ACCENT}"/></a:solidFill>` : '<a:noFill/>'}</a:tcPr></a:tc>`;
  const tr = (cells: string[], head: boolean, bold?: boolean) => `<a:tr h="${rh}">${cells.map((c, i) => cell(c, i, head, bold)).join('')}</a:tr>`;
  return `<p:graphicFrame><p:nvGraphicFramePr><p:cNvPr id="${++sid}" name="Table"/><p:cNvGraphicFramePr><a:graphicFrameLocks noGrp="1"/></p:cNvGraphicFramePr><p:nvPr/></p:nvGraphicFramePr><p:xfrm><a:off x="${x}" y="${y}"/><a:ext cx="${w}" cy="${rh * (t.rows.length + 1)}"/></p:xfrm><a:graphic><a:graphicData uri="http://schemas.openxmlformats.org/drawingml/2006/table"><a:tbl><a:tblPr firstRow="1"/><a:tblGrid>${ws.map((c) => `<a:gridCol w="${c}"/>`).join('')}</a:tblGrid>${tr(t.head, true)}${t.rows.map((r) => tr(r.cells, false, r.bold)).join('')}</a:tbl></a:graphicData></a:graphic></p:graphicFrame>`;
}
function slideXml(s: Slide, d: Deck, n: number, total: number): string {
  sid = 1; let body = ''; const cw = W - 2 * M;
  if (s.kind === 'title') { body += box(M, 2100000, cw, 1300000, para(s.title, 44, { b: true }), 'Title', 'b') + line(M, 3520000, 1800000) + box(M, 3700000, cw, 1400000, (s.subtitle ?? '').split('\n').map((l, i) => para(l, i === 0 ? 24 : 16, { color: MUTED, after: 6 })).join(''), 'Subtitle'); }
  else {
    body += box(M, 420000, cw, 640000, para(s.title, 30, { b: true }), 'Title', 'b') + line(M, 1120000, cw); let y = 1330000;
    if (s.lead) { const lines = Math.ceil(s.lead.length / 95); body += box(M, y, cw, lines * 330000, para(s.lead, 18, { b: true }), 'Lead'); y += lines * 330000 + 160000; }
    if (s.bullets?.length) { const chars = s.bullets.reduce((a, b) => a + b.length, 0); const sz = chars > 900 ? 14 : chars > 560 ? 16 : s.bullets.length > 5 ? 18 : 20; const h = s.table ? Math.min(2000000, s.bullets.length * 520000) : H - y - 900000; body += box(M, y, cw, h, s.bullets.map((b) => para(b, sz, { bullet: true, after: 9 })).join(''), 'Points'); y += h + 120000; }
    if (s.table) body += table(s.table, M, y, cw, s.table.rows.length > 9 ? 12 : s.table.rows.length > 6 ? 14 : 16);
    if (s.note) body += box(M, H - 1080000, cw, 300000, para(s.note, 12, { color: MUTED }), 'Note');
  }
  body += box(M, H - 520000, cw - 1200000, 260000, para(d.footer, 10, { color: MUTED }), 'Footer') + box(W - M - 1200000, H - 520000, 1200000, 260000, para(`${n} / ${total}`, 10, { color: MUTED, algn: 'r' }), 'Page');
  return `${X}<p:sld ${NS}><p:cSld><p:spTree><p:nvGrpSpPr><p:cNvPr id="1" name=""/><p:cNvGrpSpPr/><p:nvPr/></p:nvGrpSpPr><p:grpSpPr><a:xfrm><a:off x="0" y="0"/><a:ext cx="0" cy="0"/><a:chOff x="0" y="0"/><a:chExt cx="0" cy="0"/></a:xfrm></p:grpSpPr>${body}</p:spTree></p:cSld><p:clrMapOvr><a:masterClrMapping/></p:clrMapOvr></p:sld>`;
}
const REL = 'http://schemas.openxmlformats.org/officeDocument/2006/relationships'; const rels = (r: [string, string, string][]) => `${X}<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">${r.map(([id, type, target]) => `<Relationship Id="${id}" Type="${REL}/${type}" Target="${target}"/>`).join('')}</Relationships>`;
const EMPTY_TREE = '<p:cSld><p:spTree><p:nvGrpSpPr><p:cNvPr id="1" name=""/><p:cNvGrpSpPr/><p:nvPr/></p:nvGrpSpPr><p:grpSpPr><a:xfrm><a:off x="0" y="0"/><a:ext cx="0" cy="0"/><a:chOff x="0" y="0"/><a:chExt cx="0" cy="0"/></a:xfrm></p:grpSpPr></p:spTree></p:cSld>';
const FILL3 = '<a:solidFill><a:schemeClr val="phClr"/></a:solidFill>'.repeat(3); const LN3 = '<a:ln w="9525"><a:solidFill><a:schemeClr val="phClr"/></a:solidFill></a:ln>'.repeat(3); const EFF3 = '<a:effectStyle><a:effectLst/></a:effectStyle>'.repeat(3);
const clr = (n: string, v: string) => `<a:${n}><a:srgbClr val="${v}"/></a:${n}>`;
const THEME = `${X}<a:theme xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main" name="CFO Intelligence"><a:themeElements><a:clrScheme name="CFO"><a:dk1><a:sysClr val="windowText" lastClr="000000"/></a:dk1><a:lt1><a:sysClr val="window" lastClr="FFFFFF"/></a:lt1>${clr('dk2', INK)}${clr('lt2', 'F1F3F5')}${clr('accent1', ACCENT)}${clr('accent2', '2A78D6')}${clr('accent3', '1A7F37')}${clr('accent4', 'B7791F')}${clr('accent5', 'B42318')}${clr('accent6', MUTED)}${clr('hlink', ACCENT)}${clr('folHlink', MUTED)}</a:clrScheme><a:fontScheme name="CFO"><a:majorFont><a:latin typeface="Calibri"/><a:ea typeface=""/><a:cs typeface=""/></a:majorFont><a:minorFont><a:latin typeface="Calibri"/><a:ea typeface=""/><a:cs typeface=""/></a:minorFont></a:fontScheme><a:fmtScheme name="CFO"><a:fillStyleLst>${FILL3}</a:fillStyleLst><a:lnStyleLst>${LN3}</a:lnStyleLst><a:effectStyleLst>${EFF3}</a:effectStyleLst><a:bgFillStyleLst>${FILL3}</a:bgFillStyleLst></a:fmtScheme></a:themeElements></a:theme>`;
const CLRMAP = '<p:clrMap bg1="lt1" tx1="dk1" bg2="lt2" tx2="dk2" accent1="accent1" accent2="accent2" accent3="accent3" accent4="accent4" accent5="accent5" accent6="accent6" hlink="hlink" folHlink="folHlink"/>';
export function pptx(d: Deck): Buffer {
  const n = d.slides.length; const CT = 'application/vnd.openxmlformats-officedocument.presentationml';
  const files: [string, string][] = [
    ['[Content_Types].xml', `${X}<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Default Extension="xml" ContentType="application/xml"/><Override PartName="/ppt/presentation.xml" ContentType="${CT}.presentation.main+xml"/><Override PartName="/ppt/slideMasters/slideMaster1.xml" ContentType="${CT}.slideMaster+xml"/><Override PartName="/ppt/slideLayouts/slideLayout1.xml" ContentType="${CT}.slideLayout+xml"/><Override PartName="/ppt/theme/theme1.xml" ContentType="application/vnd.openxmlformats-officedocument.theme+xml"/><Override PartName="/docProps/core.xml" ContentType="application/vnd.openxmlformats-package.core-properties+xml"/>${d.slides.map((_, i) => `<Override PartName="/ppt/slides/slide${i + 1}.xml" ContentType="${CT}.slide+xml"/>`).join('')}</Types>`],
    ['_rels/.rels', `${X}<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="${REL}/officeDocument" Target="ppt/presentation.xml"/><Relationship Id="rId2" Type="http://schemas.openxmlformats.org/package/2006/relationships/metadata/core-properties" Target="docProps/core.xml"/></Relationships>`],
    ['docProps/core.xml', `${X}<cp:coreProperties xmlns:cp="http://schemas.openxmlformats.org/package/2006/metadata/core-properties" xmlns:dc="http://purl.org/dc/elements/1.1/"><dc:title>${esc(d.title)}</dc:title><dc:creator>${esc(d.author)}</dc:creator></cp:coreProperties>`],
    ['ppt/presentation.xml', `${X}<p:presentation ${NS}><p:sldMasterIdLst><p:sldMasterId id="2147483648" r:id="rId1"/></p:sldMasterIdLst><p:sldIdLst>${d.slides.map((_, i) => `<p:sldId id="${256 + i}" r:id="rId${i + 3}"/>`).join('')}</p:sldIdLst><p:sldSz cx="${W}" cy="${H}"/><p:notesSz cx="6858000" cy="9144000"/></p:presentation>`],
    ['ppt/_rels/presentation.xml.rels', rels([['rId1', 'slideMaster', 'slideMasters/slideMaster1.xml'], ['rId2', 'theme', 'theme/theme1.xml'], ...d.slides.map((_, i) => [`rId${i + 3}`, 'slide', `slides/slide${i + 1}.xml`] as [string, string, string])])],
    ['ppt/theme/theme1.xml', THEME],
    ['ppt/slideMasters/slideMaster1.xml', `${X}<p:sldMaster ${NS}>${EMPTY_TREE.replace('<p:cSld>', '<p:cSld><p:bg><p:bgPr><a:solidFill><a:srgbClr val="FFFFFF"/></a:solidFill><a:effectLst/></p:bgPr></p:bg>')}${CLRMAP}<p:sldLayoutIdLst><p:sldLayoutId id="2147483649" r:id="rId1"/></p:sldLayoutIdLst></p:sldMaster>`],
    ['ppt/slideMasters/_rels/slideMaster1.xml.rels', rels([['rId1', 'slideLayout', '../slideLayouts/slideLayout1.xml'], ['rId2', 'theme', '../theme/theme1.xml']])],
    ['ppt/slideLayouts/slideLayout1.xml', `${X}<p:sldLayout ${NS} type="blank" preserve="1"><p:cSld name="Blank">${EMPTY_TREE.slice(8)}<p:clrMapOvr><a:masterClrMapping/></p:clrMapOvr></p:sldLayout>`],
    ['ppt/slideLayouts/_rels/slideLayout1.xml.rels', rels([['rId1', 'slideMaster', '../slideMasters/slideMaster1.xml']])],
    ...d.slides.flatMap((s, i) => [[`ppt/slides/slide${i + 1}.xml`, slideXml(s, d, i + 1, n)], [`ppt/slides/_rels/slide${i + 1}.xml.rels`, rels([['rId1', 'slideLayout', '../slideLayouts/slideLayout1.xml']])]] as [string, string][]),
  ];
  return zip(files);
}

// ---------- PDF, same deck ----------
export function slidesPdf(d: Deck): Buffer {
  const PW = 960, PH = 540, L = 48, R = PW - 48; const pdf = new Pdf(PW, PH); const n = d.slides.length;
  d.slides.forEach((s, idx) => { pdf.addPage(); let y: number;
    if (s.kind === 'title') { wrap(s.title, 40, R - L, true).forEach((l, i) => pdf.text(L, 220 + i * 46, l, { size: 40, bold: true })); pdf.rule(L, 290, L + 140, 0.25, 2); (s.subtitle ?? '').split('\n').forEach((l, i) => pdf.text(L, 326 + i * 26, l, { size: i === 0 ? 20 : 13, gray: 0.35 })); }
    else { pdf.text(L, 70, s.title, { size: 26, bold: true }); pdf.rule(L, 88, R, 0.25, 1.5); y = 118;
      if (s.lead) { for (const l of wrap(s.lead, 15, R - L, true)) { pdf.text(L, y + 12, l, { size: 15, bold: true }); y += 21; } y += 10; }
      if (s.bullets?.length) { const chars = s.bullets.reduce((a, b) => a + b.length, 0); const sz = chars > 900 ? 11.5 : chars > 560 ? 13 : s.bullets.length > 5 ? 14.5 : 16; for (const b of s.bullets) { wrap(b, sz, R - L - 20).forEach((l, i) => { if (i === 0) pdf.text(L + 2, y + sz, '•', { size: sz }); pdf.text(L + 20, y + sz, l, { size: sz }); y += sz * 1.35; }); y += sz * 0.55; } y += 6; }
      if (s.table) { const t = s.table; const tot = t.widths.reduce((a, b) => a + b, 0); const ws = t.widths.map((f) => ((R - L) * f) / tot); const sz = t.rows.length > 9 ? 10.5 : t.rows.length > 6 ? 12 : 13.5; const rh = sz * 2.05; const xs: number[] = []; let x = L; for (const w of ws) { xs.push(x); x += w; }
        const draw = (cells: string[], bold: boolean, gray?: number) => cells.forEach((c, i) => { let v = c; while (i === 0 && v.length > 4 && textWidth(v, sz, bold) > ws[0] - 12) v = v.slice(0, -2); pdf.text(i === 0 ? xs[i] + 6 : xs[i] + ws[i] - 6, y + rh * 0.66, v, { size: sz, bold, align: i === 0 ? 'left' : 'right', gray }); });
        pdf.band(L, y, R - L, rh, 0.88); draw(t.head, true, 0.15); y += rh; for (const r of t.rows) { draw(r.cells, !!r.bold); y += rh; pdf.rule(L, y, R, 0.85, 0.4); } }
      if (s.note) pdf.text(L, PH - 62, s.note, { size: 10, gray: 0.4 }); }
    pdf.text(L, PH - 26, d.footer, { size: 8.5, gray: 0.45 }); pdf.text(R, PH - 26, `${idx + 1} / ${n}`, { size: 8.5, gray: 0.45, align: 'right' }); });
  return pdf.build({ title: d.title, author: d.author });
}
