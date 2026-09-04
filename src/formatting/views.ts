/**
 * views.ts — the document a formatter produces, and how it becomes lines.
 *
 * Formatting is the LAST stage of the pipeline, and it is two stages inside
 * that one. `Format-Table` decides WHAT to show — which columns, which cells,
 * which groups — and produces the document below. `Out-String` decides how WIDE
 * it is and turns it into text. Splitting them there is not tidiness: it is the
 * only way `Format-Table -Wrap | Out-String -Width 30` can mean anything, and
 * measurement says it does mean something — the same Format-Table output lays
 * out differently at 30 columns and at 120.
 *
 * THE BLANK LINES ARE THE HARD PART, and they are not the same for the three
 * views. Every skeleton below was derived from output that was counted line by
 * line rather than eyeballed:
 *
 *   Format-Table, ungrouped      '' hdr und rows… ''
 *   Format-Table, three groups   '' [label '' hdr und rows] '' [ … ] '' [ … ] ''
 *   Format-List,  ungrouped      '' [entry ''] [entry ''] [entry '']
 *   Format-List,  three groups   '' [label '' entry '' ] '' [ … ] '' [ … ]
 *
 * The list ends its own group block with a blank and the table does not, which
 * is why a grouped list shows TWO blank lines between groups and a grouped
 * table shows one. That difference is real, it is reproduced, and getting it
 * wrong is exactly the kind of thing that makes emulated output look emulated.
 */

import { DEFAULT_CULTURE, type CultureData } from './culture.ts';
import {
  MIN_TABLE_WIDTH,
  type Alignment,
  fitColumns,
  padCell,
  sizingWidth,
  trimEnd,
  truncateAtNewline,
  truncateCell,
  wrapLines,
  wrapText,
} from './render.ts';

// ---------------------------------------------------------------------------
// the document
// ---------------------------------------------------------------------------

export interface TableColumn {
  readonly header: string;
  readonly alignment: Alignment;
}

export interface TableGroup {
  /** The `-GroupBy` heading, already composed. Null when there is no grouping. */
  readonly label: string | null;
  readonly rows: readonly (readonly string[])[];
}

export interface TableSection {
  readonly kind: 'table';
  readonly columns: readonly TableColumn[];
  readonly groups: readonly TableGroup[];
  readonly hideHeaders: boolean;
  readonly wrap: boolean;
}

export interface ListItem {
  readonly label: string;
  readonly value: string;
}

export interface ListGroup {
  readonly label: string | null;
  readonly entries: readonly (readonly ListItem[])[];
}

export interface ListSection {
  readonly kind: 'list';
  readonly groups: readonly ListGroup[];
}

export interface WideGroup {
  readonly label: string | null;
  readonly items: readonly string[];
}

export interface WideSection {
  readonly kind: 'wide';
  readonly groups: readonly WideGroup[];
  /** `-Column`, or null for the default. */
  readonly columns: number | null;
  readonly autoSize: boolean;
}

/**
 * Values with no view of their own — a string, a number, a date. They print as
 * bare lines with none of the blank-line skeleton around them:
 *
 *   pwsh: 'hello' | Out-String   ->  "hello\r\n"      no leading blank
 *   pwsh: @(1,2,3) | Out-String  ->  "1\r\n2\r\n3\r\n"
 *
 * A mixed stream really does switch between the two: `@('a', $object)` emits
 * the bare line `a` and then starts a fresh table, blank line and all.
 */
export interface RawSection {
  readonly kind: 'raw';
  readonly lines: readonly string[];
}

/**
 * A value whose TYPE has a view of its own, rendered as one line per object
 * inside the usual blank-line skeleton.
 *
 * DateTime is the case that forces this to exist. A bare date is not a raw
 * value — measured:
 *
 *   pwsh: [datetime]'2020-03-04T15:06:07' | Out-String -Stream
 *     ''
 *     'Wednesday, March 4, 2020 3:06:07 PM'
 *     ''
 *
 * A string in the same position gets no blank lines at all, so the two really
 * are different sections rather than one with a flag.
 */
export interface CustomSection {
  readonly kind: 'custom';
  readonly groups: readonly { readonly label: string | null; readonly lines: readonly string[] }[];
}

export type FormatSection = TableSection | ListSection | WideSection | CustomSection | RawSection;

export interface FormatDocument {
  readonly sections: readonly FormatSection[];
}

/** Interleave a separator between blocks: `[a] [b] [c]` -> `a sep b sep c`. */
function joinBlocks(blocks: readonly (readonly string[])[], separator: readonly string[]): string[] {
  const out: string[] = [];
  blocks.forEach((block, index) => {
    if (index > 0) out.push(...separator);
    out.push(...block);
  });
  return out;
}

// ---------------------------------------------------------------------------
// table
// ---------------------------------------------------------------------------

/**
 * The natural width of each column: the widest of the header and every cell in
 * every group.
 *
 * Every cell, not the first object's — see note 2 in render.ts. The header
 * counts even under `-HideTableHeaders`, which is why hiding the headers of a
 * `Name`/`Size` table still leaves `Size` four columns wide.
 */
function naturalWidths(section: TableSection): number[] {
  const widths = section.columns.map((column) => sizingWidth(column.header));
  for (const group of section.groups) {
    for (const row of group.rows) {
      row.forEach((cell, index) => {
        const current = widths[index] ?? 0;
        const candidate = sizingWidth(cell);
        if (candidate > current) widths[index] = candidate;
      });
    }
  }
  return widths;
}

/** Assemble one physical line from per-column texts, skipping hidden columns. */
function assemble(
  cells: readonly string[],
  widths: readonly number[],
  alignments: readonly Alignment[],
  columnCount: number,
): string {
  let line = '';
  let emitted = 0;
  for (let index = 0; index < columnCount; index++) {
    const width = widths[index] ?? 0;
    if (width <= 0) continue;
    if (emitted > 0) line += ' ';
    emitted += 1;
    line += padCell(
      cells[index] ?? '',
      width,
      alignments[index] ?? 'left',
      index === columnCount - 1,
    );
  }
  return line;
}

function renderTable(section: TableSection, width: number): string[] {
  const columnCount = section.columns.length;
  const alignments = section.columns.map((c) => c.alignment);
  const widths =
    width < MIN_TABLE_WIDTH ? section.columns.map(() => 0) : fitColumns(naturalWidths(section), width);

  const blocks = section.groups.map((group) => {
    const block: string[] = [];
    // The heading is NOT right-trimmed: a null grouping value produces the
    // bare `   : ` heading, trailing space and all, which pwsh really prints.
    if (group.label !== null) block.push(...wrapLines(group.label, width), '');
    // Below five columns pwsh emits the skeleton and nothing else — measured at
    // widths 2, 3 and 4 for one column and for two.
    if (width < MIN_TABLE_WIDTH) return block;

    if (!section.hideHeaders) {
      // The header goes through the WRAPPING writer, so it wraps to the column
      // and its trailing padding is trimmed away.
      const wrapped = section.columns.map((column, index) =>
        wrapText(column.header, widths[index] ?? 0),
      );
      const height = wrapped.reduce((max, lines) => Math.max(max, lines.length), 1);
      for (let line = 0; line < height; line++) {
        block.push(trimEnd(assemble(wrapped.map((lines) => lines[line] ?? ''), widths, alignments, columnCount)));
      }
      // The underline goes through the SINGLE-LINE writer, so it keeps its
      // padding. Its length is the header's, capped by the column.
      const dashes = section.columns.map((column, index) =>
        '-'.repeat(Math.max(0, Math.min(widths[index] ?? 0, sizingWidth(column.header)))),
      );
      block.push(assemble(dashes, widths, alignments, columnCount));
    }

    for (const row of group.rows) {
      if (section.wrap) {
        const wrapped = row.map((cell, index) => wrapLines(cell, widths[index] ?? 0));
        const height = wrapped.reduce((max, lines) => Math.max(max, lines.length), 1);
        for (let line = 0; line < height; line++) {
          block.push(trimEnd(assemble(wrapped.map((lines) => lines[line] ?? ''), widths, alignments, columnCount)));
        }
      } else {
        const cells = row.map((cell, index) =>
          truncateCell(truncateAtNewline(cell), widths[index] ?? 0, alignments[index] ?? 'left'),
        );
        block.push(assemble(cells, widths, alignments, columnCount));
      }
    }
    return block;
  });

  return ['', ...joinBlocks(blocks, ['']), ''];
}

// ---------------------------------------------------------------------------
// list
// ---------------------------------------------------------------------------

/**
 * One `Name : value` entry.
 *
 * The label column is sized PER ENTRY, not across the whole stream — an object
 * with only `A` prints `A : 1` even when the next object has a ten-character
 * property. Measured, and the opposite is the natural implementation.
 *
 * A value never truncates; it wraps, and its continuation lines are indented to
 * line up under the value rather than under the label.
 */
function renderEntry(entry: readonly ListItem[], width: number): string[] {
  const labelWidth = entry.reduce((max, item) => Math.max(max, sizingWidth(item.label)), 0);
  const indent = labelWidth + 3;
  const valueWidth = Math.max(1, width - indent);
  const out: string[] = [];
  for (const item of entry) {
    const lines = wrapLines(item.value, valueWidth);
    const head = lines[0] ?? '';
    out.push(`${item.label}${' '.repeat(Math.max(0, labelWidth - sizingWidth(item.label)))} : ${head}`);
    for (const line of lines.slice(1)) out.push(' '.repeat(indent) + line);
  }
  return out;
}

function renderList(section: ListSection, width: number): string[] {
  const blocks = section.groups.map((group) => {
    const block: string[] = [];
    if (group.label !== null) block.push(...wrapLines(group.label, width), '');
    // Each entry is followed by a blank, which is what gives an ungrouped list
    // its trailing blank line without a separate group-end rule.
    for (const entry of group.entries) block.push(...renderEntry(entry, width), '');
    return block;
  });
  return ['', ...joinBlocks(blocks, [''])];
}

// ---------------------------------------------------------------------------
// wide
// ---------------------------------------------------------------------------

/**
 * Format-Wide's geometry, which is arithmetic nobody would guess.
 *
 * The column widths sum to `width + 1`, not to `width`: at 120 columns two
 * columns are 61 and 60, three are 41/40/40, four are 31/30/30/30. The extra
 * column goes to the leftmost columns, one each, until the remainder runs out.
 * Verified at widths 20, 21, 39, 40, 41, 60 and 120 against 2, 3 and 4 columns
 * by reading back the character position of every item.
 *
 * The DEFAULT is two columns regardless of how narrow the items are — a stream
 * of two-character values still lays out two per line at 120 columns. Only
 * `-AutoSize` packs them, and it packs to `(width + 1) / (widest + 1)` columns,
 * which reproduces the measured 118-character line for five two-character items.
 */
function wideWidths(count: number, width: number): number[] {
  const total = width + 1;
  const base = Math.floor(total / count);
  const remainder = total % count;
  return Array.from({ length: count }, (_, index) => base + (index < remainder ? 1 : 0));
}

function renderWide(section: WideSection, width: number): string[] {
  const blocks = section.groups.map((group) => {
    const block: string[] = [];
    if (group.label !== null) block.push(...wrapLines(group.label, width), '');

    const widest = group.items.reduce((max, item) => Math.max(max, sizingWidth(item)), 1);
    const count = Math.max(
      1,
      section.columns ?? (section.autoSize ? Math.floor((width + 1) / (widest + 1)) : 2),
    );
    const widths = wideWidths(count, width);

    for (let start = 0; start < group.items.length; start += count) {
      let line = '';
      for (let column = 0; column < count; column++) {
        const item = group.items[start + column] ?? '';
        const cellWidth = widths[column] ?? 0;
        const text = truncateCell(truncateAtNewline(item), cellWidth);
        line += padCell(text, cellWidth, 'left', column === count - 1);
      }
      block.push(line);
    }
    return block;
  });
  return ['', ...joinBlocks(blocks, ['']), ''];
}

// ---------------------------------------------------------------------------
// the document
// ---------------------------------------------------------------------------

export interface RenderOptions {
  readonly width: number;
  readonly culture: CultureData;
}

export const defaultRenderOptions = (width: number): RenderOptions => ({
  width,
  culture: DEFAULT_CULTURE,
});

/**
 * Turn a document into lines.
 *
 * The lines carry no line terminator. Choosing one is the host's job — the
 * capture machine emits CRLF and the compatibility profile targets a browser,
 * so baking either in here would make the output wrong somewhere.
 */
export function renderDocument(document: FormatDocument, options: RenderOptions): string[] {
  const lines: string[] = [];
  for (const section of document.sections) {
    switch (section.kind) {
      case 'raw':
        lines.push(...section.lines);
        break;
      case 'table':
        lines.push(...renderTable(section, options.width));
        break;
      case 'list':
        lines.push(...renderList(section, options.width));
        break;
      case 'wide':
        lines.push(...renderWide(section, options.width));
        break;
      case 'custom':
        lines.push(
          '',
          ...joinBlocks(
            section.groups.map((group) => [
              ...(group.label === null ? [] : [...wrapLines(group.label, options.width), '']),
              ...group.lines,
            ]),
            [''],
          ),
          '',
        );
        break;
    }
  }
  return lines;
}
