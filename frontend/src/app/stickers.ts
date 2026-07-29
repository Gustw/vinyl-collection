/**
 * Sticker sheets: turns the *filtered* collection into a printable PDF of
 * shelf/sleeve labels, so the keys and BPMs you've worked out in here are
 * readable in a dark room without a phone.
 *
 * One sticker holds 2 or 4 tracks; a record with more tracks than that simply
 * spills onto consecutive stickers ("1/2", "2/2"), which is what you want when
 * a 12" has an A and B side worth labelling separately.
 */

import { Rec, Track } from './models';
import { A4, MM, PdfDoc, Rgb, ellipsize, hsl, textWidth } from './pdf';

// --- Sheet geometry --------------------------------------------------------

/** The physical layout of one brand/format of 24-per-A4 label sheet. */
export interface SheetSpec {
  id: string;
  label: string;
  /** Labels across / down. */
  cols: number;
  rows: number;
  /** Label size, mm. */
  labelW: number;
  labelH: number;
  /** Distance from the page edge to the first label, mm. */
  marginLeft: number;
  marginTop: number;
  /** Gap between labels, mm. */
  gapX: number;
  gapY: number;
}

/**
 * The two 24-up A4 sheets you actually meet in the wild. Cheap own-brand packs
 * are almost always the gapless 70 × 37 mm; Avery's L7159/J8159 family is
 * 63.5 × 33.9 mm with a 2.54 mm gutter.
 */
export const SHEETS: SheetSpec[] = [
  {
    id: 'a4-24-70x37',
    label: '24 up · 70 × 37 mm (no gaps)',
    cols: 3,
    rows: 8,
    labelW: 70,
    labelH: 37,
    marginLeft: 0,
    marginTop: 0.5,
    gapX: 0,
    gapY: 0,
  },
  {
    id: 'a4-24-avery-l7159',
    label: '24 up · 63.5 × 33.9 mm (Avery L7159 / J8159)',
    cols: 3,
    rows: 8,
    labelW: 63.5,
    labelH: 33.9,
    marginLeft: 7.2,
    marginTop: 12.9,
    gapX: 2.54,
    gapY: 0,
  },
];

export function sheetById(id: string): SheetSpec {
  return SHEETS.find((s) => s.id === id) ?? SHEETS[0];
}

/** How many tracks share one sticker. */
export type PerSticker = 2 | 4;

/**
 * The sticker settings, as remembered in localStorage. The sheet is stored by
 * id rather than by value so a future tweak to a sheet's measurements reaches
 * everyone instead of being frozen into their browser.
 */
export interface StickerPrefs {
  perSticker: PerSticker;
  sheetId: string;
  /**
   * Safety margin inside each label, mm. Sheets vary by a millimetre or two
   * between brands and printers rarely register perfectly, so nothing is drawn
   * this close to the die-cut edge.
   */
  safeMm: number;
  /** Labels to leave blank at the start — lets you finish a part-used sheet. */
  skip: number;
  /** Colour-code the key badges by Camelot wheel position. */
  colour: boolean;
  /** Draw the label outlines (for a test print on plain paper). */
  outlines: boolean;
}

export function defaultStickerPrefs(): StickerPrefs {
  return {
    perSticker: 4,
    sheetId: SHEETS[0].id,
    safeMm: 2,
    skip: 0,
    colour: true,
    outlines: false,
  };
}

/** Prefs resolved into everything the renderer needs. */
export interface StickerOptions {
  sheet: SheetSpec;
  /**
   * Track slots per sticker. Every sticker is laid out to this many rows even
   * when it holds fewer tracks, so type size stays constant across the sheet.
   */
  perSticker: PerSticker;
  safeMm: number;
  skip: number;
  outlines: boolean;
  colour: boolean;
}

export function stickerOptions(p: StickerPrefs): StickerOptions {
  return {
    sheet: sheetById(p.sheetId),
    perSticker: p.perSticker,
    safeMm: p.safeMm,
    skip: p.skip,
    outlines: p.outlines,
    colour: p.colour,
  };
}

// --- Building the stickers -------------------------------------------------

export interface StickerTrack {
  title: string;
  artist: string;
  camelot: string;
  keyName: string;
  bpm: string;
}

export interface Sticker {
  recordTitle: string;
  /** Record label(s) — the imprint, not the sticker. */
  labels: string[];
  year: number;
  /** 1-based index of this sticker within its record, and the total. */
  part: number;
  parts: number;
  tracks: StickerTrack[];
}

/** A record together with the tracks that survived the current filters. */
export interface StickerSource {
  record: Rec;
  tracks: Track[];
}

/**
 * Chunks each record's matching tracks into stickers of at most `perSticker`.
 * Records are kept in the order the list shows them, and a record never shares
 * a sticker with another — a label has to make sense stuck on one sleeve.
 */
export function buildStickers(rows: StickerSource[], perSticker: PerSticker): Sticker[] {
  const out: Sticker[] = [];
  for (const row of rows) {
    if (!row.tracks.length) continue;
    const parts = Math.ceil(row.tracks.length / perSticker);
    for (let i = 0; i < parts; i++) {
      out.push({
        recordTitle: row.record.title,
        labels: row.record.labels,
        year: row.record.year,
        part: i + 1,
        parts,
        tracks: row.tracks.slice(i * perSticker, (i + 1) * perSticker).map((t) => ({
          title: t.title,
          artist: t.artist,
          camelot: t.camelot,
          keyName: t.keyName,
          bpm: t.bpm,
        })),
      });
    }
  }
  return out;
}

/** Pages the sheet will take, including any labels skipped at the start. */
export function pageCount(stickers: number, opts: StickerOptions): number {
  const perPage = opts.sheet.cols * opts.sheet.rows;
  const skip = Math.max(0, Math.min(opts.skip, perPage - 1));
  return stickers ? Math.ceil((stickers + skip) / perPage) : 0;
}

// --- Rendering -------------------------------------------------------------

/** Camelot wheel number → hue, matching the on-screen key badge colours. */
const CAMELOT_HUE: Record<number, number> = {
  1: 0, 2: 30, 3: 52, 4: 80, 5: 120, 6: 155,
  7: 180, 8: 205, 9: 230, 10: 265, 11: 300, 12: 330,
};

const GREY: Rgb = { r: 0.42, g: 0.42, b: 0.42 };
const RULE: Rgb = { r: 0.78, g: 0.78, b: 0.78 };
const OUTLINE: Rgb = { r: 0.85, g: 0.85, b: 0.85 };

/** Helvetica's descender, as a fraction of the point size. */
const DESCENDER = 0.212;

function keyColours(camelot: string, colour: boolean): { fill: Rgb; text: Rgb } {
  const m = /^(\d{1,2})([AB])$/.exec((camelot || '').trim());
  if (!m || !colour) return { fill: { r: 0.93, g: 0.93, b: 0.93 }, text: { r: 0.2, g: 0.2, b: 0.2 } };
  const hue = CAMELOT_HUE[Number(m[1])] ?? 0;
  // Light fill / dark ink: legible on white label stock and kind to the toner.
  return { fill: hsl(hue, 70, 84), text: hsl(hue, 70, 26) };
}

/**
 * The provenance in front of the record name: "1997 · Transient Records".
 * Only the first imprint is used — a co-release listing three labels would eat
 * the whole line, and the record's own name is what you're scanning for.
 */
function provenance(s: Sticker): string {
  return [s.year ? String(s.year) : '', s.labels[0] || ''].filter(Boolean).join(' · ');
}

/**
 * Draws the sticker's top line: year and label in grey, then the record name in
 * bold. The artist is deliberately absent — on a sleeve you already know whose
 * record it is, and the space buys a readable title.
 *
 * The two runs are fitted rather than simply concatenated and clipped: the
 * provenance is capped at 45% of the line so a long imprint can never crowd out
 * the record name, which is the part that identifies the sleeve.
 */
function drawHeader(doc: PdfDoc, s: Sticker, x: number, baseline: number, w: number, size: number): void {
  const prefix = provenance(s);
  const title = s.recordTitle || '';
  const sep = prefix && title ? '  ' : '';

  const prefixW = textWidth(prefix, size, false);
  const titleW = textWidth(title, size, true);
  const sepW = textWidth(sep, size, false);

  let shownPrefix = prefix;
  let shownTitle = title;
  if (prefixW + sepW + titleW > w) {
    shownPrefix = ellipsize(prefix, Math.min(prefixW, w * 0.45), size, false);
    const used = textWidth(shownPrefix, size, false) + sepW;
    shownTitle = ellipsize(title, w - used, size, true);
  }

  if (shownPrefix) doc.text(x, baseline, shownPrefix, { size, color: GREY });
  const titleX = x + (shownPrefix ? textWidth(shownPrefix, size, false) + sepW : 0);
  if (shownTitle) doc.text(titleX, baseline, shownTitle, { size, bold: true });
}

/**
 * Renders one sticker inside the given (already inset) box.
 *
 * `slots` is the *configured* tracks-per-sticker, not the number this sticker
 * happens to carry. Row height and every type size are derived from it, so the
 * last sticker of a record — the one with a single leftover track — is set in
 * exactly the same type as a full one instead of ballooning to fill the label.
 * A sheet of labels that don't match each other looks like a bug.
 */
function drawSticker(
  doc: PdfDoc,
  s: Sticker,
  x: number,
  y: number,
  w: number,
  h: number,
  slots: number,
  colour: boolean
): void {
  const headSize = Math.min(7.5, h * 0.09);
  const partLabel = s.parts > 1 ? `${s.part}/${s.parts}` : '';
  const partW = partLabel ? textWidth(partLabel, headSize, false) + 4 : 0;

  drawHeader(doc, s, x, y + headSize, w - partW, headSize);
  if (partLabel) {
    doc.text(x + w, y + headSize, partLabel, { size: headSize, color: GREY, align: 'right' });
  }

  const top = y + headSize + 2.5;
  doc.line(x, top, x + w, top, RULE, 0.4);

  const listTop = top + 2;
  const rowH = (y + h - listTop) / Math.max(slots, s.tracks.length);
  const titleSize = Math.max(6, Math.min(11, rowH * 0.4));
  // The artist line was set far too small to read at arm's length in a dark
  // room; it now sits just under the title rather than a third of its size.
  const artistSize = Math.max(6.5, Math.min(9.5, rowH * 0.34));
  const keySize = Math.max(6, Math.min(10, rowH * 0.36));
  const badgeW = Math.max(textWidth('12A', keySize, true) + 6, 16);
  const badgeH = keySize + 3;
  const bpmW = textWidth('188', keySize, true) + 2;
  /** Leading between the track title and the artist beneath it. */
  const subGap = 1.5;
  s.tracks.forEach((t, i) => {
    const rowY = listTop + i * rowH;
    if (i > 0) doc.line(x, rowY - 1, x + w, rowY - 1, RULE, 0.25);

    // The block is centred in its row: with two tracks per sticker the rows are
    // much taller than their content, and a partly-filled sticker leaves its
    // unused rows blank at the bottom rather than stretching into them.
    //
    // The artist line's descender counts towards the block height. Leaving it
    // out over-estimates the free space and the centring pushes the row's tails
    // down onto the rule below it — with the larger artist type there is only
    // about a point of slack to play with.
    const sub = [t.artist, t.keyName].filter(Boolean).join(' · ');
    const blockH = titleSize + (sub ? subGap + artistSize * (1 + DESCENDER) : 0);
    const pad = Math.max(0, (rowH - blockH - 1) / 2);
    const titleBase = rowY + pad + titleSize;
    const subBase = titleBase + artistSize + subGap;

    // Key badge, left.
    const badgeY = rowY + (rowH - badgeH) / 2 - 1;
    const { fill, text } = keyColours(t.camelot, colour);
    doc.rect(x, badgeY, badgeW, badgeH, { fill });
    doc.text(x + badgeW / 2, badgeY + badgeH - 3, t.camelot || '—', {
      size: keySize,
      bold: true,
      color: text,
      align: 'center',
    });

    // BPM, right.
    doc.text(x + w, titleBase, t.bpm || '—', { size: keySize, bold: true, align: 'right' });

    // Title + artist, between the two.
    const textX = x + badgeW + 4;
    const textW = w - (badgeW + 4) - bpmW - 3;
    doc.text(textX, titleBase, ellipsize(t.title, textW, titleSize, true), {
      size: titleSize,
      bold: true,
    });
    if (sub && subBase <= y + h) {
      doc.text(textX, subBase, ellipsize(sub, textW + bpmW, artistSize), {
        size: artistSize,
        color: GREY,
      });
    }
  });
}

/** Lays the stickers onto A4 sheets and returns the finished PDF. */
export function renderStickerPdf(stickers: Sticker[], opts: StickerOptions): Blob {
  const doc = new PdfDoc(A4.width, A4.height);
  const sheet = opts.sheet;
  const perPage = sheet.cols * sheet.rows;
  const skip = Math.max(0, Math.min(opts.skip, perPage - 1));
  const inset = Math.max(0, opts.safeMm) * MM;

  const labelW = sheet.labelW * MM;
  const labelH = sheet.labelH * MM;

  doc.addPage();
  let slot = skip;

  for (const sticker of stickers) {
    if (slot >= perPage) {
      doc.addPage();
      slot = 0;
    }
    const col = slot % sheet.cols;
    const row = Math.floor(slot / sheet.cols);
    const x = (sheet.marginLeft + col * (sheet.labelW + sheet.gapX)) * MM;
    const y = (sheet.marginTop + row * (sheet.labelH + sheet.gapY)) * MM;

    if (opts.outlines) {
      doc.rect(x, y, labelW, labelH, { stroke: OUTLINE, lineWidth: 0.3, dash: [2, 2] });
    }
    drawSticker(
      doc,
      sticker,
      x + inset,
      y + inset,
      labelW - inset * 2,
      labelH - inset * 2,
      opts.perSticker,
      opts.colour
    );
    slot++;
  }

  return doc.toBlob();
}

/** "vinyl-stickers-2026-07-29.pdf" */
export function stickerFilename(): string {
  const d = new Date();
  const p = (n: number) => String(n).padStart(2, '0');
  return `vinyl-stickers-${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}.pdf`;
}



