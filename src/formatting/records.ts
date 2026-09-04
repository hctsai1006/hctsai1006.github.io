/**
 * records.ts — what a Format-* cmdlet actually puts on the pipeline.
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
 * PowerShell; it is defeated by there being no `Name` to sort on. That is the
 * behaviour reproduced here: a record carries NO public properties, so
 * `getProperty` finds nothing on it, `Where-Object` can filter it but learns
 * nothing from it, and the only thing that can read it is the renderer.
 *
 * The document rides in `baseObject`, which psobject.ts describes as "the
 * underlying host value, when there is one. Never serialised" — exactly this
 * case. One record carries the whole document rather than five, because the
 * column widths depend on every object in the stream (see render.ts note 2) and
 * a per-entry record could not know them.
 */

import { isPSObject, psWrap, type PSObject, type PSValue } from '../pipeline/psobject.ts';
import type { FormatDocument } from './views.ts';

/** The type name pwsh reports for a format directive. */
export const FORMAT_ENTRY_TYPE = 'Microsoft.PowerShell.Commands.Internal.Format.FormatEntryData';

export function formatRecord(document: FormatDocument): PSObject {
  return psWrap({}, [FORMAT_ENTRY_TYPE, 'System.Object'], document);
}

export function isFormatRecord(value: PSValue): boolean {
  return isPSObject(value) && value.typeNames[0] === FORMAT_ENTRY_TYPE;
}

/** The document inside a record, or undefined for anything else. */
export function recordDocument(value: PSValue): FormatDocument | undefined {
  if (!isFormatRecord(value) || !isPSObject(value)) return undefined;
  const base = value.baseObject;
  if (typeof base !== 'object' || base === null) return undefined;
  return base as FormatDocument;
}
