/**
 * A very small PDF writer — just enough to lay text and filled boxes onto
 * fixed-size pages using the standard (non-embedded) Helvetica fonts.
 *
 * Why hand-rolled rather than jsPDF/pdfmake: the whole app is a static,
 * dependency-light Angular bundle served off GitHub Pages, and the only thing
 * we need is "put this string at this coordinate". A full PDF library would be
 * ~300 kB of bundle for a feature that fits in one file.
 *
 * Coordinates are given in points (1/72"), with the origin at the **top-left**
 * of the page, because that is how the sticker layout thinks. The y axis is
 * flipped on the way out to PDF's bottom-left origin.
 */

/** Points per millimetre — sticker sheets are all specified in mm. */
export const MM = 72 / 25.4;

/** A4 in points. */
export const A4 = { width: 210 * MM, height: 297 * MM };

/** Colour with components in 0..1. */
export interface Rgb {
  r: number;
  g: number;
  b: number;
}

export const BLACK: Rgb = { r: 0, g: 0, b: 0 };

export type Align = 'left' | 'right' | 'center';

export interface TextOptions {
  size?: number;
  bold?: boolean;
  color?: Rgb;
  align?: Align;
}

export interface BoxOptions {
  fill?: Rgb;
  stroke?: Rgb;
  lineWidth?: number;
  /** Dash pattern in points, e.g. [2, 2]. Omitted = solid. */
  dash?: number[];
}

// --- Font metrics ----------------------------------------------------------
//
// Widths (per 1000 units of font size) for the ASCII range of the two base-14
// fonts we use. Anything outside the table falls back to a plausible average,
// which only ever affects where a title gets truncated — never correctness.

const HELVETICA_WIDTHS: number[] = [
  278, 278, 355, 556, 556, 889, 667, 191, 333, 333, 389, 584, 278, 333, 278, 278,
  556, 556, 556, 556, 556, 556, 556, 556, 556, 556, 278, 278, 584, 584, 584, 556,
  1015, 667, 667, 722, 722, 667, 611, 778, 722, 278, 500, 667, 556, 833, 722, 778,
  667, 778, 722, 667, 611, 722, 667, 944, 667, 667, 611, 278, 278, 278, 469, 556,
  333, 556, 556, 500, 556, 556, 278, 556, 556, 222, 222, 500, 222, 833, 556, 556,
  556, 556, 333, 500, 278, 556, 500, 722, 500, 500, 500, 334, 260, 334, 584,
];

const HELVETICA_BOLD_WIDTHS: number[] = [
  278, 333, 474, 556, 556, 889, 722, 238, 333, 333, 389, 584, 278, 333, 278, 278,
  556, 556, 556, 556, 556, 556, 556, 556, 556, 556, 333, 333, 584, 584, 584, 611,
  975, 722, 722, 722, 722, 667, 611, 778, 722, 278, 556, 722, 611, 833, 722, 778,
  667, 778, 722, 667, 611, 722, 667, 944, 667, 667, 611, 333, 278, 333, 584, 556,
  333, 556, 611, 556, 611, 556, 333, 611, 611, 278, 278, 556, 278, 889, 611, 611,
  611, 611, 389, 556, 333, 611, 556, 778, 556, 556, 500, 389, 280, 389, 584,
];

/** Width of `text` at `size` pt, in points. */
export function textWidth(text: string, size: number, bold = false): number {
  const table = bold ? HELVETICA_BOLD_WIDTHS : HELVETICA_WIDTHS;
  let units = 0;
  for (const ch of encodeWinAnsi(text)) {
    const code = ch.charCodeAt(0);
    units += code >= 32 && code <= 126 ? table[code - 32] : 556;
  }
  return (units * size) / 1000;
}

/**
 * Shortens `text` with a trailing ellipsis until it fits `maxWidth`.
 * Track titles on a 70 mm label routinely need this.
 */
export function ellipsize(text: string, maxWidth: number, size: number, bold = false): string {
  if (maxWidth <= 0) return '';
  if (textWidth(text, size, bold) <= maxWidth) return text;
  let s = text;
  while (s.length > 1 && textWidth(s + '…', size, bold) > maxWidth) {
    s = s.slice(0, -1);
  }
  return s.trimEnd() + '…';
}

// --- Text encoding ---------------------------------------------------------

/** Characters WinAnsi puts in 0x80–0x9F, where Latin-1 has controls. */
const WIN_ANSI_HIGH: Record<string, number> = {
  '\u20AC': 0x80, '\u201A': 0x82, '\u0192': 0x83, '\u201E': 0x84, '\u2026': 0x85,
  '\u2020': 0x86, '\u2021': 0x87, '\u02C6': 0x88, '\u2030': 0x89, '\u0160': 0x8a,
  '\u2039': 0x8b, '\u0152': 0x8c, '\u017D': 0x8e, '\u2018': 0x91, '\u2019': 0x92,
  '\u201C': 0x93, '\u201D': 0x94, '\u2022': 0x95, '\u2013': 0x96, '\u2014': 0x97,
  '\u02DC': 0x98, '\u2122': 0x99, '\u0161': 0x9a, '\u203A': 0x9b, '\u0153': 0x9c,
  '\u017E': 0x9e, '\u0178': 0x9f,
};

/**
 * Folds a JS string down to WinAnsiEncoding bytes (as a binary string).
 * Accented characters that WinAnsi lacks are stripped to their base letter
 * rather than dropped, so "Bjørk" stays readable.
 */
function encodeWinAnsi(text: string): string {
  let out = '';
  for (const ch of text.normalize('NFC')) {
    const code = ch.charCodeAt(0);
    if (code >= 32 && code <= 126) {
      out += ch;
    } else if (code >= 0xa0 && code <= 0xff) {
      out += ch;
    } else if (WIN_ANSI_HIGH[ch] !== undefined) {
      out += String.fromCharCode(WIN_ANSI_HIGH[ch]);
    } else {
      const base = ch.normalize('NFD').replace(/[\u0300-\u036f]/g, '');
      const ok = base && base.charCodeAt(0) >= 32 && base.charCodeAt(0) <= 0xff;
      out += ok ? base : '';
    }
  }
  return out;
}

function pdfString(text: string): string {
  return '(' + encodeWinAnsi(text).replace(/([\\()])/g, '\\$1').replace(/[\r\n]/g, ' ') + ')';
}

function num(n: number): string {
  return (Math.round(n * 1000) / 1000).toString();
}

// --- Document --------------------------------------------------------------

/** A page's content stream, built up as PDF operators. */
type Page = string[];

export class PdfDoc {
  private readonly pages: Page[] = [];
  private page: Page | null = null;

  constructor(
    readonly width = A4.width,
    readonly height = A4.height
  ) {}

  addPage(): void {
    this.page = [];
    this.pages.push(this.page);
  }


  private get current(): Page {
    if (!this.page) this.addPage();
    return this.page!;
  }

  /** Draws `text` with its baseline at `y` (measured down from the page top). */
  text(x: number, y: number, text: string, opts: TextOptions = {}): void {
    const value = encodeWinAnsi(text);
    if (!value) return;
    const size = opts.size ?? 8;
    const bold = opts.bold ?? false;
    const c = opts.color ?? BLACK;
    let tx = x;
    if (opts.align === 'right') tx = x - textWidth(text, size, bold);
    else if (opts.align === 'center') tx = x - textWidth(text, size, bold) / 2;

    this.current.push(
      `BT ${num(c.r)} ${num(c.g)} ${num(c.b)} rg /${bold ? 'F2' : 'F1'} ${num(size)} Tf ` +
        `1 0 0 1 ${num(tx)} ${num(this.height - y)} Tm ${pdfString(text)} Tj ET`
    );
  }

  /** Filled and/or stroked rectangle, `y` measured down from the page top. */
  rect(x: number, y: number, w: number, h: number, opts: BoxOptions = {}): void {
    if (!opts.fill && !opts.stroke) return;
    const ops: string[] = ['q'];
    if (opts.dash?.length) ops.push(`[${opts.dash.map(num).join(' ')}] 0 d`);
    if (opts.fill) ops.push(`${num(opts.fill.r)} ${num(opts.fill.g)} ${num(opts.fill.b)} rg`);
    if (opts.stroke) {
      ops.push(`${num(opts.stroke.r)} ${num(opts.stroke.g)} ${num(opts.stroke.b)} RG`);
      ops.push(`${num(opts.lineWidth ?? 0.5)} w`);
    }
    ops.push(`${num(x)} ${num(this.height - y - h)} ${num(w)} ${num(h)} re`);
    ops.push(opts.fill && opts.stroke ? 'B' : opts.fill ? 'f' : 'S');
    ops.push('Q');
    this.current.push(ops.join(' '));
  }

  /** Horizontal/diagonal hairline, `y` measured down from the page top. */
  line(x1: number, y1: number, x2: number, y2: number, color: Rgb = BLACK, width = 0.4): void {
    this.current.push(
      `q ${num(color.r)} ${num(color.g)} ${num(color.b)} RG ${num(width)} w ` +
        `${num(x1)} ${num(this.height - y1)} m ${num(x2)} ${num(this.height - y2)} l S Q`
    );
  }

  /** Serialises the document. */
  toBlob(): Blob {
    return new Blob([this.toBytes()], { type: 'application/pdf' });
  }

  private toBytes(): Uint8Array {
    if (!this.pages.length) this.addPage();

    // Object ids: 1 catalog, 2 pages, 3/4 fonts, then page+content pairs.
    const firstPageId = 5;
    const pageIds = this.pages.map((_, i) => firstPageId + i * 2);
    const objects: string[] = [];

    objects.push('<< /Type /Catalog /Pages 2 0 R >>');
    objects.push(
      `<< /Type /Pages /Count ${this.pages.length} /Kids [${pageIds
        .map((id) => `${id} 0 R`)
        .join(' ')}] >>`
    );
    objects.push('<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica /Encoding /WinAnsiEncoding >>');
    objects.push(
      '<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica-Bold /Encoding /WinAnsiEncoding >>'
    );

    this.pages.forEach((ops, i) => {
      const contentId = pageIds[i] + 1;
      objects.push(
        `<< /Type /Page /Parent 2 0 R /MediaBox [0 0 ${num(this.width)} ${num(this.height)}] ` +
          `/Resources << /Font << /F1 3 0 R /F2 4 0 R >> >> /Contents ${contentId} 0 R >>`
      );
      const stream = ops.join('\n');
      objects.push(`<< /Length ${stream.length} >>\nstream\n${stream}\nendstream`);
    });

    let out = '%PDF-1.4\n%\xE2\xE3\xCF\xD3\n';
    const offsets: number[] = [];
    objects.forEach((body, i) => {
      offsets.push(out.length);
      out += `${i + 1} 0 obj\n${body}\nendobj\n`;
    });

    const xrefAt = out.length;
    out += `xref\n0 ${objects.length + 1}\n0000000000 65535 f \n`;
    for (const off of offsets) {
      out += `${String(off).padStart(10, '0')} 00000 n \n`;
    }
    out +=
      `trailer\n<< /Size ${objects.length + 1} /Root 1 0 R >>\n` +
      `startxref\n${xrefAt}\n%%EOF\n`;

    const bytes = new Uint8Array(out.length);
    for (let i = 0; i < out.length; i++) bytes[i] = out.charCodeAt(i) & 0xff;
    return bytes;
  }
}

/** hsl (h in degrees, s/l in percent) to the 0..1 rgb triple PDF wants. */
export function hsl(h: number, s: number, l: number): Rgb {
  const sat = s / 100;
  const lig = l / 100;
  const c = (1 - Math.abs(2 * lig - 1)) * sat;
  const hp = (((h % 360) + 360) % 360) / 60;
  const x = c * (1 - Math.abs((hp % 2) - 1));
  const [r, g, b] =
    hp < 1 ? [c, x, 0] :
    hp < 2 ? [x, c, 0] :
    hp < 3 ? [0, c, x] :
    hp < 4 ? [0, x, c] :
    hp < 5 ? [x, 0, c] : [c, 0, x];
  const m = lig - c / 2;
  return { r: r + m, g: g + m, b: b + m };
}

/** Triggers a browser download for `blob`. */
export function downloadBlob(blob: Blob, filename: string): void {
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 10_000);
}

