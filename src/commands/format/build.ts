/**
 * build.ts — turning a stream of objects into a format document.
 *
 * This is the half of formatting that decides WHAT to show. views.ts decides
 * how wide it is. The split matters because the width is not known until
 * Out-String runs, and `Format-Table -Wrap | Out-String -Width 30` really does
 * lay out at 30 columns.
 *
 * THE DEFAULT-VIEW RULE, WHICH IS A COUNT AND NOT A HEURISTIC
 *
 * With no `Format-*` in the pipeline, pwsh picks table or list from the number
 * of properties on the FIRST object. Measured one property at a time:
 *
 *   1..4 properties  ->  table
 *   5+ properties    ->  list
 *
 * The boundary really is four; five is the first count that goes to a list.
 * Nothing else — not the terminal width, not the value lengths — moves it.
 *
 * A STREAM CAN CHANGE SHAPE MID-WAY, and pwsh starts over when it does:
 *
 *   pwsh: @('a', [pscustomobject]@{X=1}) | Out-String
 *     a                       <- a bare line, no blank around it
 *                             <- then a fresh table, skeleton and all
 *     X
 *     -
 *     1
 *
 * But two objects with DIFFERENT properties share one table, built from the
 * first object's columns: `@(o{A=1}, o{B=2})` prints a single `A` column with an
 * empty cell in the second row. So the split is between "has a view" and "does
 * not", not between property sets.
 */

import type { CultureData } from '../../formatting/culture.ts';
import { formatDateFull } from '../../formatting/datetime.ts';
import { cellAlignment, cellText } from '../../formatting/render.ts';
import { toPSString } from '../../formatting/to-string.ts';
import type {
  CustomSection,
  FormatDocument,
  FormatSection,
  ListGroup,
  ListItem,
  TableColumn,
  TableGroup,
  WideGroup,
} from '../../formatting/views.ts';
import { isPSObject, type PSValue } from '../../pipeline/psobject.ts';
import {
  asScriptBlock,
  hasWildcard,
  matchPropertyNames,
  resolvablePropertyNames,
  resolveProperty,
} from '../powershell/support.ts';

/** Raised for a `-Property` specification this formatter cannot evaluate. */
export class PropertySpecError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'PropertySpecError';
  }
}

export interface ViewOptions {
  readonly culture: CultureData;
  /** `-Property`, unrendered, so a calculated-property hashtable survives. */
  readonly properties: readonly PSValue[] | null;
  readonly groupBy: string | null;
  readonly hideHeaders: boolean;
  readonly wrap: boolean;
  readonly columns: number | null;
  readonly autoSize: boolean;
}

export const viewOptions = (culture: CultureData, overrides: Partial<ViewOptions> = {}): ViewOptions => ({
  culture,
  properties: null,
  groupBy: null,
  hideHeaders: false,
  wrap: false,
  columns: null,
  autoSize: false,
  ...overrides,
});

/**
 * Above this many properties the default view is a list. Four, measured, and
 * not to be adjusted without re-measuring.
 */
export const MAX_TABLE_PROPERTIES = 4;

// ---------------------------------------------------------------------------
// property specifications
// ---------------------------------------------------------------------------

/** A resolved column: a display name plus a way to get the value. */
interface Resolved {
  readonly name: string;
  readonly read: (source: PSValue) => PSValue;
}

const byName = (name: string): Resolved => ({
  name,
  read: (source) => resolveProperty(source, name) ?? null,
});

/**
 * A calculated property, `@{ Name = 'Doubled'; Expression = { $_.A * 2 } }`.
 *
 * Supported because it costs little and is genuinely common. The one limit is
 * stated rather than hidden: the expression must answer SYNCHRONOUSLY. A
 * document is built in one pass so its column widths can see every row, and an
 * awaited expression would turn that pass async all the way up through
 * `renderDocument`. An async script block raises rather than silently rendering
 * `[object Promise]`.
 */
function calculated(spec: PSValue): Resolved | null {
  if (!isPSObject(spec)) return null;
  const label = resolveProperty(spec, 'Label') ?? resolveProperty(spec, 'Name');
  const expression = resolveProperty(spec, 'Expression');
  if (expression === undefined || expression === null) return null;

  const name = label === undefined || label === null ? 'Expression' : toPSString(label);
  const block = asScriptBlock(expression);
  if (block !== undefined) {
    return {
      name,
      read: (source) => {
        const result = block(source);
        if (result instanceof Promise) {
          throw new PropertySpecError(
            `the calculated property '${name}' returned a promise; ` +
              'formatting builds its column widths in one synchronous pass, so an ' +
              'asynchronous expression cannot be used here',
          );
        }
        return result;
      },
    };
  }
  if (typeof expression === 'string') return { name, read: (source) => resolveProperty(source, expression) ?? null };
  throw new PropertySpecError(
    `the calculated property '${name}' has an Expression that is neither a script block nor a property name`,
  );
}

/**
 * Expand `-Property` against the first object.
 *
 * Wildcards resolve in the source object's DECLARATION order, matching
 * Select-Object. A name no object carries still becomes a column — measured:
 * `-Property Name,Nope` prints a `Nope` header with an underline and empty
 * cells beneath it.
 */
function resolveSpecs(specs: readonly PSValue[], sample: PSValue): Resolved[] {
  const out: Resolved[] = [];
  for (const spec of specs) {
    const computed = calculated(spec);
    if (computed !== null) {
      out.push(computed);
      continue;
    }
    const text = toPSString(spec);
    if (hasWildcard(text)) {
      for (const name of matchPropertyNames(sample, text)) out.push(byName(name));
      continue;
    }
    out.push(byName(text));
  }
  return out;
}

function columnsFor(objects: readonly PSValue[], options: ViewOptions): Resolved[] {
  const sample = objects[0] ?? null;
  if (options.properties !== null) return resolveSpecs(options.properties, sample);
  return resolvablePropertyNames(sample).map(byName);
}

// ---------------------------------------------------------------------------
// grouping
// ---------------------------------------------------------------------------

interface Run {
  readonly label: string | null;
  readonly objects: readonly PSValue[];
}

/**
 * `-GroupBy` splits ADJACENT runs and does not sort. Measured: values a, b, a
 * produce three groups, not two, so a script that wants two must sort first.
 *
 * The label is three spaces, the property name, a colon and a space. When the
 * value is null the NAME disappears too and the heading is bare `   : ` —
 * which looks like a bug and is what the reference implementation prints, so it
 * is reproduced rather than improved.
 */
function groupRuns(objects: readonly PSValue[], options: ViewOptions): Run[] {
  if (options.groupBy === null) return [{ label: null, objects }];
  const name = options.groupBy;
  const runs: Run[] = [];
  let current: PSValue[] = [];
  let key: string | null = null;
  let label = '';

  for (const object of objects) {
    const value = resolveProperty(object, name) ?? null;
    // A heading uses the PLAIN numeric style even above a table: a group on 1.5
    // is headed `   G: 1.5` over cells that read `1.500`. Measured.
    const text = cellText(value, options.culture, 'plain');
    const heading = value === null ? '   : ' : `   ${name}: ${text}`;
    if (key === null || text !== key) {
      if (current.length > 0) runs.push({ label, objects: current });
      current = [];
      key = text;
      label = heading;
    }
    current.push(object);
  }
  if (current.length > 0) runs.push({ label, objects: current });
  return runs;
}

// ---------------------------------------------------------------------------
// sections
// ---------------------------------------------------------------------------

export function buildTableSection(objects: readonly PSValue[], options: ViewOptions): FormatSection {
  const resolved = columnsFor(objects, options);
  const sample = objects[0] ?? null;
  const columns: TableColumn[] = resolved.map((column) => ({
    header: column.name,
    // Alignment is decided once, from the first object's value. A later row
    // holding a string does not move a numeric column back to the left.
    alignment: cellAlignment(column.read(sample)),
  }));

  const groups: TableGroup[] = groupRuns(objects, options).map((run) => ({
    label: run.label,
    rows: run.objects.map((object) =>
      resolved.map((column) => cellText(column.read(object), options.culture, 'table')),
    ),
  }));

  return { kind: 'table', columns, groups, hideHeaders: options.hideHeaders, wrap: options.wrap };
}

export function buildListSection(objects: readonly PSValue[], options: ViewOptions): FormatSection {
  const groups: ListGroup[] = groupRuns(objects, options).map((run) => ({
    label: run.label,
    entries: run.objects.map((object) => {
      // A list sizes its label column PER ENTRY, so each object contributes its
      // own properties rather than the first object's. Measured.
      const resolved =
        options.properties === null ? resolvablePropertyNames(object).map(byName) : columnsFor([object], options);
      const items: ListItem[] = resolved.map((column) => ({
        label: column.name,
        value: cellText(column.read(object), options.culture),
      }));
      return items;
    }),
  }));
  return { kind: 'list', groups };
}

export function buildWideSection(objects: readonly PSValue[], options: ViewOptions): FormatSection {
  const resolved = columnsFor(objects, options);
  const first = resolved[0];
  const groups: WideGroup[] = groupRuns(objects, options).map((run) => ({
    label: run.label,
    items: run.objects.map((object) =>
      first === undefined ? '' : cellText(first.read(object), options.culture),
    ),
  }));
  return { kind: 'wide', groups, columns: options.columns, autoSize: options.autoSize };
}

// ---------------------------------------------------------------------------
// values with no view
// ---------------------------------------------------------------------------

/**
 * A bare value's line.
 *
 * `"$x"` for everything except a DateTime, which follows the CULTURE here as it
 * does in a table cell:
 *
 *   pwsh (zh-TW): [datetime]'2020-03-04T05:06:07' | Out-String
 *     2020/3/4 上午 05:06:07
 *   "$([datetime]'2020-03-04T05:06:07')"
 *     03/04/2020 05:06:07        <- invariant, see to-string.ts
 *
 * Numbers do NOT get the table's `F` treatment: `1.5 | Out-String` is `1.5`,
 * not `1.500`.
 */
export function scalarText(value: PSValue, culture: CultureData): string {
  if (typeof value === 'number' || value instanceof Date) return cellText(value, culture, 'plain');
  return toPSString(value);
}

/**
 * How a value is rendered at the top level.
 *
 *   'object'  a property table or list
 *   'custom'  its type has a view of its own — DateTime is the one modelled
 *   'raw'     a bare line
 */
type Shape = 'object' | 'custom' | 'raw';

const shapeOf = (value: PSValue): Shape =>
  isPSObject(value) ? 'object' : value instanceof Date ? 'custom' : 'raw';

/**
 * Split a stream into runs that share a rendering, dropping `$null` — measured:
 * `$null | Out-String` is the empty string, not a blank line.
 */
function partition(values: readonly PSValue[]): { shape: Shape; values: PSValue[] }[] {
  const runs: { shape: Shape; values: PSValue[] }[] = [];
  for (const value of values) {
    if (value === null || value === undefined) continue;
    const shape = shapeOf(value);
    const last = runs[runs.length - 1];
    if (last !== undefined && last.shape === shape) last.values.push(value);
    else runs.push({ shape, values: [value] });
  }
  return runs;
}

/**
 * DateTime's own view.
 *
 * It uses the FULL date pattern, not the general one a table cell uses, and it
 * carries the blank-line skeleton a raw string does not:
 *
 *   pwsh: [datetime]'2020-03-04T15:06:07' | Out-String -Stream
 *     '', 'Wednesday, March 4, 2020 3:06:07 PM', ''
 *
 * KNOWN DIVERGENCE: pwsh's `Format-Table`/`Format-List` on a bare DateTime
 * reflect over its .NET members instead — Date, Day, DayOfWeek, Ticks and the
 * rest — which this value model does not carry, so those two produce this same
 * custom view here. Stated rather than faked: inventing a Ticks column would be
 * a fabrication, and the default view, which is what anyone actually sees, is
 * right.
 */
function customSection(values: readonly PSValue[], culture: CultureData): CustomSection {
  return {
    kind: 'custom',
    groups: [
      { label: null, lines: values.map((value) => formatDateFull(value as Date, culture)) },
    ],
  };
}

function rawSection(values: readonly PSValue[], culture: CultureData): FormatSection {
  return {
    kind: 'raw',
    lines: values.flatMap((value) => scalarText(value, culture).split(/\r\n|\r|\n/)),
  };
}

/**
 * The document a stream produces with no `Format-*` asked for: the default view.
 *
 * Objects get a table or a list by the property count; everything else gets
 * bare lines. Both appear in one document when the stream changes shape.
 */
export function buildDefaultDocument(values: readonly PSValue[], culture: CultureData): FormatDocument {
  const sections: FormatSection[] = [];
  for (const run of partition(values)) {
    if (run.shape === 'raw') {
      sections.push(rawSection(run.values, culture));
      continue;
    }
    if (run.shape === 'custom') {
      sections.push(customSection(run.values, culture));
      continue;
    }
    const count = resolvablePropertyNames(run.values[0] ?? null).length;
    const options = viewOptions(culture);
    sections.push(
      count > MAX_TABLE_PROPERTIES
        ? buildListSection(run.values, options)
        : buildTableSection(run.values, options),
    );
  }
  return { sections };
}

/**
 * The document an explicit `Format-Table` / `-List` / `-Wide` produces.
 *
 * A scalar is still a bare line even here: `'hello' | Format-Table` prints
 * `hello` with no header and no blank lines at all. Measured, and the obvious
 * implementation — a one-column table — would be visibly wrong.
 */
export function buildViewDocument(
  values: readonly PSValue[],
  options: ViewOptions,
  view: 'table' | 'list' | 'wide',
): FormatDocument {
  const sections: FormatSection[] = [];
  for (const run of partition(values)) {
    if (run.shape === 'raw') {
      sections.push(rawSection(run.values, options.culture));
      continue;
    }
    if (run.shape === 'custom') {
      sections.push(customSection(run.values, options.culture));
      continue;
    }
    sections.push(
      view === 'table'
        ? buildTableSection(run.values, options)
        : view === 'list'
          ? buildListSection(run.values, options)
          : buildWideSection(run.values, options),
    );
  }
  return { sections };
}
