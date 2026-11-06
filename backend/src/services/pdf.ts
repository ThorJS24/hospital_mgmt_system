/**
 * Minimal dependency-free PDF writer (text, tables, key/value rows) used for invoices, discharge summaries
 * and report exports. Uses the built-in Helvetica fonts, so no font files are embedded.
 */

// Helvetica advance widths (1/1000 em) for ASCII 32..126, used for wrapping and truncation.
const W = [278, 278, 355, 556, 556, 889, 667, 191, 333, 333, 389, 584, 278, 333, 278, 278, 556, 556, 556, 556, 556, 556, 556, 556, 556, 556, 278, 278, 584, 584, 584, 556,
  1015, 667, 667, 722, 722, 667, 611, 778, 722, 278, 500, 667, 556, 833, 722, 778, 667, 778, 722, 667, 611, 722, 667, 944, 667, 667, 611, 278, 278, 278, 469, 556,
  333, 556, 556, 500, 556, 556, 278, 556, 556, 222, 222, 500, 222, 833, 556, 556, 556, 556, 333, 500, 278, 556, 500, 722, 500, 500, 500, 334, 260, 334, 584];

const PAGE_W = 595;
const PAGE_H = 842;
const MARGIN = 48;

export const textWidth = (s: string, size: number, bold = false) => {
  let w = 0;
  for (const ch of s) {
    const c = ch.charCodeAt(0);
    w += c >= 32 && c <= 126 ? W[c - 32] : 556;
  }
  return (w / 1000) * size * (bold ? 1.06 : 1);
};

/** Map to WinAnsi-safe text: keep Latin-1, replace anything else. */
const clean = (s: unknown) => String(s ?? '').replace(/[\r\t]/g, ' ').replace(/[^\n\x20-\x7e\xa0-\xff]/g, '?');
const esc = (s: string) => s.replace(/\\/g, '\\\\').replace(/\(/g, '\\(').replace(/\)/g, '\\)');

function wrap(text: string, maxW: number, size: number, bold = false): string[] {
  const out: string[] = [];
  for (const para of clean(text).split('\n')) {
    let line = '';
    for (const word of para.split(' ')) {
      const cand = line ? `${line} ${word}` : word;
      if (textWidth(cand, size, bold) <= maxW) { line = cand; continue; }
      if (line) out.push(line);
      let w = word;
      while (textWidth(w, size, bold) > maxW && w.length > 1) { // hard-split very long tokens
        let n = w.length;
        while (n > 1 && textWidth(w.slice(0, n), size, bold) > maxW) n--;
        out.push(w.slice(0, n));
        w = w.slice(n);
      }
      line = w;
    }
    out.push(line);
  }
  return out;
}

function fit(text: string, maxW: number, size: number, bold = false): string {
  let s = clean(text).replace(/\n/g, ' ');
  if (textWidth(s, size, bold) <= maxW) return s;
  while (s.length > 1 && textWidth(`${s}...`, size, bold) > maxW) s = s.slice(0, -1);
  return `${s}...`;
}

export type PdfBlock =
  | { type: 'heading'; text: string }
  | { type: 'paragraph'; text: string }
  | { type: 'kv'; rows: [string, string][] }
  | { type: 'table'; columns: { label: string; width: number; align?: 'left' | 'right' }[]; rows: string[][] }
  | { type: 'spacer'; height?: number };

export interface PdfDoc { title: string; subtitle?: string; footer?: string; blocks: PdfBlock[] }

class Page {
  ops: string[] = [];
}

export function buildPdf(doc: PdfDoc): Buffer {
  const pages: Page[] = [];
  let page = new Page();
  let y = PAGE_H - MARGIN;
  const bottom = MARGIN + 24;
  const newPage = () => { pages.push(page); page = new Page(); y = PAGE_H - MARGIN; };
  const ensure = (h: number) => { if (y - h < bottom) newPage(); };
  const text = (s: string, x: number, size: number, bold = false, gray = 0) => {
    page.ops.push(`BT /${bold ? 'F2' : 'F1'} ${size} Tf ${gray} g ${x.toFixed(2)} ${y.toFixed(2)} Td (${esc(s)}) Tj ET`);
  };
  const rule = (gray = 0.8) => { page.ops.push(`${gray} G 0.6 w ${MARGIN} ${y.toFixed(2)} m ${PAGE_W - MARGIN} ${y.toFixed(2)} l S`); };
  const usable = PAGE_W - 2 * MARGIN;

  // title block
  text(clean(doc.title), MARGIN, 20, true); y -= 22;
  if (doc.subtitle) { text(clean(doc.subtitle), MARGIN, 10, false, 0.35); y -= 14; }
  y -= 2; rule(0.6); y -= 16;

  for (const b of doc.blocks) {
    if (b.type === 'spacer') { y -= b.height ?? 10; continue; }
    if (b.type === 'heading') {
      ensure(34); y -= 6; text(clean(b.text), MARGIN, 12, true); y -= 6; rule(0.85); y -= 12;
    } else if (b.type === 'paragraph') {
      const lines = wrap(b.text || '-', usable, 10);
      for (const ln of lines) { ensure(14); text(ln, MARGIN, 10); y -= 13; }
      y -= 4;
    } else if (b.type === 'kv') {
      const labelW = 130;
      for (const [k, v] of b.rows) {
        const lines = wrap(v || '-', usable - labelW, 10);
        ensure(13 * lines.length + 2);
        text(clean(k), MARGIN, 9, true, 0.3);
        lines.forEach((ln, i) => { text(ln, MARGIN + labelW, 10); if (i < lines.length - 1) y -= 13; });
        y -= 14;
      }
      y -= 2;
    } else if (b.type === 'table') {
      const total = b.columns.reduce((s, c) => s + c.width, 0);
      const scale = usable / total;
      const xs: number[] = [];
      let acc = MARGIN;
      for (const c of b.columns) { xs.push(acc); acc += c.width * scale; }
      const header = () => {
        ensure(30);
        b.columns.forEach((c, i) => {
          const w = c.width * scale - 6;
          const t = fit(c.label, w, 9, true);
          const x = c.align === 'right' ? xs[i] + w - textWidth(t, 9, true) : xs[i];
          text(t, x, 9, true, 0.25);
        });
        y -= 4; rule(0.5); y -= 11;
      };
      header();
      for (const row of b.rows) {
        if (y - 14 < bottom) { newPage(); header(); }
        b.columns.forEach((c, i) => {
          const w = c.width * scale - 6;
          const t = fit(row[i] ?? '', w, 9);
          const x = c.align === 'right' ? xs[i] + w - textWidth(t, 9) : xs[i];
          text(t, x, 9);
        });
        y -= 13;
      }
      if (!b.rows.length) { text('No records', MARGIN, 9, false, 0.45); y -= 13; }
      y -= 6;
    }
  }
  pages.push(page);

  // assemble objects
  const objs: string[] = [];
  const total = pages.length;
  const FONT1 = 3, FONT2 = 4;
  const firstPageObj = 5;
  objs[1] = '<< /Type /Catalog /Pages 2 0 R >>';
  objs[2] = `<< /Type /Pages /Kids [${pages.map((_, i) => `${firstPageObj + i * 2} 0 R`).join(' ')}] /Count ${total} >>`;
  objs[FONT1] = '<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica /Encoding /WinAnsiEncoding >>';
  objs[FONT2] = '<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica-Bold /Encoding /WinAnsiEncoding >>';
  pages.forEach((p, i) => {
    const footer = `BT /F1 8 Tf 0.45 g ${MARGIN} ${MARGIN - 6} Td (${esc(clean(doc.footer ?? 'MediCore HMS - synthetic data only - not for clinical use'))}) Tj ET ` +
      `BT /F1 8 Tf 0.45 g ${PAGE_W - MARGIN - 50} ${MARGIN - 6} Td (Page ${i + 1} of ${total}) Tj ET`;
    const content = [...p.ops, footer].join('\n');
    const pageObj = firstPageObj + i * 2;
    objs[pageObj] = `<< /Type /Page /Parent 2 0 R /MediaBox [0 0 ${PAGE_W} ${PAGE_H}] /Resources << /Font << /F1 ${FONT1} 0 R /F2 ${FONT2} 0 R >> >> /Contents ${pageObj + 1} 0 R >>`;
    objs[pageObj + 1] = `<< /Length ${Buffer.byteLength(content, 'latin1')} >>\nstream\n${content}\nendstream`;
  });

  let out = '%PDF-1.4\n';
  const offsets: number[] = [];
  for (let i = 1; i < objs.length; i++) {
    offsets[i] = Buffer.byteLength(out, 'latin1');
    out += `${i} 0 obj\n${objs[i]}\nendobj\n`;
  }
  const xref = Buffer.byteLength(out, 'latin1');
  out += `xref\n0 ${objs.length}\n0000000000 65535 f \n`;
  for (let i = 1; i < objs.length; i++) out += `${String(offsets[i]).padStart(10, '0')} 00000 n \n`;
  out += `trailer\n<< /Size ${objs.length} /Root 1 0 R >>\nstartxref\n${xref}\n%%EOF\n`;
  return Buffer.from(out, 'latin1');
}
