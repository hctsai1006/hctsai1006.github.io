/**
 * records.ts — what a Format-* cmdlet actually puts on the pipeline, and the
 * form in which it survives a `postMessage`.
 *
 * FORMATTING IS THE LAST STAGE, and this file is what enforces it.
 *
 * `Format-Table` does not emit text and it does not emit objects a later
 * command can work with. It emits format DIRECTIVES, and so does the real
 * thing — measured:
 *
 *   pwsh: [pscustomobject]@{A=1} | Format-Table | ForEach-Object { $_.GetType().FullName }
 *     Microsoft.PowerShell.Commands.Internal.Format.FormatStartData
 *     Microsoft.PowerShell.Commands.Internal.Format.GroupStartData
 *     Microsoft.PowerShell.Commands.Internal.Format.FormatEntryData
 *     Microsoft.PowerShell.Commands.Internal.Format.GroupEndData
 *     Microsoft.PowerShell.Commands.Internal.Format.FormatEndData
 *
 * So `... | Format-Table | Sort-Object Name` is not blocked by an error in
 * PowerShell; it is defeated by there being no `Name` to sort on — measured,
 * `$entry.Name` is `$null` and the five records sort into their original order.
 * That is the behaviour reproduced here.
 *
 * ── WHERE THE DOCUMENT LIVES, AND WHY IT MOVED ────────────────────────────
 *
 * It used to ride in `baseObject`, which psobject.ts describes as "the
 * underlying host value, when there is one. Never serialised". That last
 * sentence was the problem: `src/kernel/wire.ts` DROPS `baseObject`, so a
 * format record crossing the kernel boundary arrived declaring its type with an
 * empty property bag — measured, `{"typeNames":["…FormatEntryData","System.Object"],
 * "properties":{}}` — and a renderer on the far side would identify it
 * confidently and draw nothing. The wire grew a structural refusal for exactly
 * that shape ("everything it had is in the slot the boundary drops"), which
 * made the failure loud but left `Format-Table` unable to reach a host at all.
 *
 * So the document is now CARRIED, in the property bag, as JSON text. Three
 * things had to be true and all three were checked:
 *
 *   1. A `FormatDocument` is plain data — strings, numbers, booleans, nulls and
 *      arrays. No Date, no cycles, no host value. It is therefore serialisable,
 *      unlike a script block's closure, which is why records.ts got the easier
 *      of the two fixes wire.ts named.
 *   2. TEXT, not the object graph. `PSObject.properties` is
 *      `Record<string, PSValue>`, and a `FormatSection` is not a `PSValue` —
 *      PSValue's object arm is `PSObject`, which has `typeNames`. Putting the
 *      raw graph there needs a cast, and the value it produces flows into
 *      `toPSString`, `compareValues` and `Get-Member` typed as something it is
 *      not. A string is a `PSValue` with nothing asserted about it.
 *   3. It costs something, and the number is here rather than assumed. On a
 *      200,000-row table (node 24.13): stringify 27ms, parse 200ms, against
 *      build 71ms and render 401ms for the same document. So the round trip
 *      adds about half again to the work `Format-Table | Out-String` already
 *      does, on the largest table anyone would type.
 *
 * A RECORD IS STILL OPAQUE. `Sort-Object Name` finds nothing, because `Name` is
 * not what it carries. It is not property-FREE, and it never was in pwsh
 * either — measured, `[pscustomobject]@{A=1} | Format-Table` yields a
 * FormatEntryData whose `Get-Member -MemberType Property` reports
 * `ClassId2e4f51ef21dd47e99d3c952918aff9cd`, `formatEntryInfo`, `outOfBand` and
 * `writeStream`. One internal-looking property here against four there is a
 * closer model than zero was.
 *
 * ONE RECORD, not five, because the column widths depend on every object in the
 * stream (see render.ts note 2) and a per-entry record could not know them.
 */

import { isPSObject, psObject, type PSObject, type PSValue } from '../pipeline/psobject.ts';
import type { Alignment } from './render.ts';
import type {
  FormatDocument,
  FormatSection,
  ListGroup,
  ListItem,
  TableColumn,
  TableGroup,
} from './views.ts';

/** The type name pwsh reports for a format directive. */
export const FORMAT_ENTRY_TYPE = 'Microsoft.PowerShell.Commands.Internal.Format.FormatEntryData';

/**
 * The property the document rides in.
 *
 * Lower-cased first letter, like pwsh's own `formatEntryInfo`, `outOfBand` and
 * `writeStream`: these are the record's internals rather than something a user
 * asked for, and the spelling says so. `Json` is in the name because the value
 * really is text — a reader that expected an object would otherwise find a
 * string and have to guess why.
 */
export const FORMAT_DOCUMENT_PROPERTY = 'formatDocumentJson';

/**
 * A format record that carries something other than a document.
 *
 * Thrown rather than returned, and that is the whole point. The script block
 * taught this: an UNRESOLVABLE handle had to be an ERROR rather than a silent
 * pass, or `Where-Object` let every object through. A record that says
 * FormatEntryData and cannot produce a document is the same silent pass — it
 * would fall through `renderStream`'s "not a record" branch and be rendered as
 * an ordinary object, which is a blank-looking table nobody could explain.
 */
export class FormatRecordError extends Error {
  constructor(reason: string) {
    super(`a ${FORMAT_ENTRY_TYPE} carries no readable document: ${reason}`);
    this.name = 'FormatRecordError';
  }
}

export function formatRecord(document: FormatDocument): PSObject {
  return psObject({ [FORMAT_DOCUMENT_PROPERTY]: JSON.stringify(document) }, [
    FORMAT_ENTRY_TYPE,
    'System.Object',
  ]);
}

export function isFormatRecord(value: PSValue): boolean {
  return isPSObject(value) && value.typeNames[0] === FORMAT_ENTRY_TYPE;
}

/**
 * The document inside a record, or undefined for anything that is not one.
 *
 * `undefined` means "this was not a format record" and nothing else. A record
 * whose payload is missing, unparseable or not a document THROWS, because those
 * three are indistinguishable from a working record to every caller and none of
 * them is a thing a caller can do anything sensible with.
 */
export function recordDocument(value: PSValue): FormatDocument | undefined {
  if (!isFormatRecord(value) || !isPSObject(value)) return undefined;
  const payload = value.properties[FORMAT_DOCUMENT_PROPERTY];
  if (typeof payload !== 'string') {
    throw new FormatRecordError(
      `${FORMAT_DOCUMENT_PROPERTY} is ${payload === undefined ? 'absent' : typeof payload}, not a string`,
    );
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(payload);
  } catch (error: unknown) {
    throw new FormatRecordError(error instanceof Error ? error.message : String(error));
  }
  const document = asDocument(parsed);
  if (document === null) {
    throw new FormatRecordError('the parsed value is not a FormatDocument');
  }
  return document;
}

// ---------------------------------------------------------------------------
// the decoder
// ---------------------------------------------------------------------------

/**
 * VALIDATED, not cast.
 *
 * The encoder is `JSON.stringify` and could have been paired with a cast, which
 * would be right exactly as long as the string was written by this build of
 * this file. Across the kernel boundary that is not something the reader knows:
 * `structuredClone` carries the string verbatim from wherever it came from, and
 * `PSObject.properties` is writable by anything that can build a PSObject. A
 * cast would turn "someone put the wrong text here" into a render of garbage,
 * or a crash inside `renderDocument` naming a line of the renderer.
 *
 * Total, therefore: every field of every section kind is checked, and anything
 * unrecognised produces `null` rather than a partially trusted document.
 */
function asDocument(value: unknown): FormatDocument | null {
  const record = asRecord(value);
  if (record === null) return null;
  const sections = asArray(record['sections'], asSection);
  return sections === null ? null : { sections };
}

function asSection(value: unknown): FormatSection | null {
  const s = asRecord(value);
  if (s === null) return null;
  switch (s['kind']) {
    case 'table': {
      const columns = asArray(s['columns'], asColumn);
      const groups = asArray(s['groups'], asTableGroup);
      const hideHeaders = s['hideHeaders'];
      const wrap = s['wrap'];
      if (columns === null || groups === null) return null;
      if (typeof hideHeaders !== 'boolean' || typeof wrap !== 'boolean') return null;
      return { kind: 'table', columns, groups, hideHeaders, wrap };
    }
    case 'list': {
      const groups = asArray(s['groups'], asListGroup);
      return groups === null ? null : { kind: 'list', groups };
    }
    case 'wide': {
      const groups = asArray(s['groups'], asWideGroup);
      const columns = s['columns'];
      const autoSize = s['autoSize'];
      if (groups === null) return null;
      if (columns !== null && typeof columns !== 'number') return null;
      if (typeof autoSize !== 'boolean') return null;
      return { kind: 'wide', groups, columns, autoSize };
    }
    case 'custom': {
      const groups = asArray(s['groups'], asCustomGroup);
      return groups === null ? null : { kind: 'custom', groups };
    }
    case 'raw': {
      const lines = asArray(s['lines'], asString);
      return lines === null ? null : { kind: 'raw', lines };
    }
    default:
      return null;
  }
}

function asColumn(value: unknown): TableColumn | null {
  const c = asRecord(value);
  if (c === null) return null;
  const header = c['header'];
  const alignment = c['alignment'];
  if (typeof header !== 'string') return null;
  if (alignment !== 'left' && alignment !== 'right') return null;
  return { header, alignment: alignment satisfies Alignment };
}

function asTableGroup(value: unknown): TableGroup | null {
  const g = asRecord(value);
  if (g === null) return null;
  const label = asLabel(g['label']);
  const rows = asArray(g['rows'], (row) => asArray(row, asString));
  if (label === undefined || rows === null) return null;
  return { label, rows };
}

function asListGroup(value: unknown): ListGroup | null {
  const g = asRecord(value);
  if (g === null) return null;
  const label = asLabel(g['label']);
  const entries = asArray(g['entries'], (entry) => asArray(entry, asListItem));
  if (label === undefined || entries === null) return null;
  return { label, entries };
}

function asListItem(value: unknown): ListItem | null {
  const item = asRecord(value);
  if (item === null) return null;
  const label = item['label'];
  const text = item['value'];
  if (typeof label !== 'string' || typeof text !== 'string') return null;
  return { label, value: text };
}

function asWideGroup(value: unknown): { label: string | null; items: readonly string[] } | null {
  const g = asRecord(value);
  if (g === null) return null;
  const label = asLabel(g['label']);
  const items = asArray(g['items'], asString);
  if (label === undefined || items === null) return null;
  return { label, items };
}

function asCustomGroup(value: unknown): { label: string | null; lines: readonly string[] } | null {
  const g = asRecord(value);
  if (g === null) return null;
  const label = asLabel(g['label']);
  const lines = asArray(g['lines'], asString);
  if (label === undefined || lines === null) return null;
  return { label, lines };
}

/**
 * `undefined` is the failure here, not `null` — a group label really is
 * `string | null`, and `null` means "no grouping". Using `null` for "invalid"
 * as the other decoders do would make a missing label read as a valid one.
 */
function asLabel(value: unknown): string | null | undefined {
  if (value === null || typeof value === 'string') return value;
  return undefined;
}

function asString(value: unknown): string | null {
  return typeof value === 'string' ? value : null;
}

/**
 * A plain JSON object, read through `Object.hasOwn` semantics.
 *
 * `JSON.parse` never produces a prototype-poisoned object for `__proto__` — it
 * defines the key as an own property — so a plain `typeof` check is enough
 * here, and the result is indexed rather than destructured so
 * `noUncheckedIndexedAccess` keeps every field `unknown`.
 */
function asRecord(value: unknown): Record<string, unknown> | null {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return null;
  return value as Record<string, unknown>;
}

/** Every element, or null if any one of them fails. Never a partial array. */
function asArray<T>(value: unknown, item: (element: unknown) => T | null): readonly T[] | null {
  if (!Array.isArray(value)) return null;
  const out: T[] = [];
  for (const element of value as readonly unknown[]) {
    const decoded = item(element);
    if (decoded === null) return null;
    out.push(decoded);
  }
  return out;
}
