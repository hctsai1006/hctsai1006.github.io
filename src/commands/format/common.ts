/**
 * common.ts — what the four formatting cmdlets share.
 *
 * The interesting rule here is the PASS-THROUGH one. Format directives already
 * on the pipeline are not re-formatted:
 *
 *   pwsh: [pscustomobject]@{A=1} | Format-Table | Format-Table
 *     (identical to a single Format-Table)
 *
 * So a Format-* that receives records forwards them untouched. A stream mixing
 * records with ordinary objects does not arise from any real pipeline — nothing
 * produces one — so the ordering chosen for it is stated rather than
 * discovered: records keep their positions, and the document built from the
 * ordinary objects takes the position of the first of them.
 */

import { cultureByName, DEFAULT_CULTURE, type CultureData } from '../../formatting/culture.ts';
import { formatRecord, isFormatRecord } from '../../formatting/records.ts';
import type { FormatDocument } from '../../formatting/views.ts';
import { throwIfCancelled } from '../../pipeline/pipeline.ts';
import type { PSValue } from '../../pipeline/psobject.ts';
import type { BindingResult, CommandModule, InvocationContext } from '../invocation.ts';
import {
  OBJECT,
  STRING,
  SWITCH,
  manifest,
  parameter,
  rawValue,
  stringValue,
  switchValue,
} from '../powershell/support.ts';
import { buildViewDocument, viewOptions, type ViewOptions } from './build.ts';

/**
 * Which culture the formatter renders under.
 *
 * Read through the compatibility profile rather than from the host, because a
 * differential test must not depend on the machine's regional settings — the
 * same reason psobject.ts pins its collator. The default is en-US, which is the
 * culture the conformance fixtures were captured under
 * (`capture.pinnedCulture`).
 */
export function cultureFor(context: InvocationContext): CultureData {
  const name = context.profile.behavior('formatting.culture', 'en-US');
  try {
    return cultureByName(name);
  } catch {
    return DEFAULT_CULTURE;
  }
}

/** Marks where the built document goes among the passed-through records. */
const DOCUMENT_SLOT: unique symbol = Symbol('format-document-slot');

export interface Collected {
  readonly values: readonly PSValue[];
  /** The output order, with `DOCUMENT_SLOT` standing in for the document. */
  readonly layout: readonly (PSValue | typeof DOCUMENT_SLOT)[];
}

export async function collect(context: InvocationContext, command: string): Promise<Collected> {
  const values: PSValue[] = [];
  const layout: (PSValue | typeof DOCUMENT_SLOT)[] = [];
  let placed = false;

  for await (const item of context.input) {
    throwIfCancelled(context.signal, command);
    if (isFormatRecord(item)) {
      layout.push(item);
      continue;
    }
    values.push(item);
    if (!placed) {
      layout.push(DOCUMENT_SLOT);
      placed = true;
    }
  }
  return { values, layout };
}

/** Emit the collected layout, substituting the document where it belongs. */
export async function emitDocument(
  context: InvocationContext,
  collected: Collected,
  build: () => FormatDocument,
): Promise<void> {
  const sink = context.streams.success;
  for (const item of collected.layout) {
    if (sink.closed || context.signal.aborted) return;
    if (item === DOCUMENT_SLOT) {
      // An empty stream produces NO document at all: `@() | Format-Table`
      // prints nothing, not a pair of blank lines. Measured.
      if (collected.values.length === 0) continue;
      await sink.write(formatRecord(build()));
      continue;
    }
    await sink.write(item);
  }
}

/**
 * The parameters the three view cmdlets share, declared with the types
 * `(Get-Command Format-Table).Parameters` reports in pwsh 7.6.5:
 * `-Property` is Object[] at position 0, `-GroupBy` is a bare Object.
 */
export const VIEW_PARAMETERS = [
  parameter('Property', 'System.Object[]', { position: 0 }),
  parameter('GroupBy', OBJECT),
  parameter('View', STRING),
  parameter('InputObject', OBJECT, { valueFromPipeline: true }),
  parameter('Force', SWITCH),
  parameter('Expand', STRING),
  parameter('DisplayError', SWITCH),
  parameter('ShowError', SWITCH),
] as const;

/** Unimplemented switches, named in one place so every manifest says the same. */
export const UNIMPLEMENTED_VIEW_NOTE =
  '-View, -Expand, -Force, -DisplayError and -ShowError are accepted by the binder and ' +
  'ignored: each needs the format-data subsystem (custom views, enumerable expansion) ' +
  'that this engine does not model, and approximating them would be worse than saying so.';

export function readViewOptions(
  context: InvocationContext,
  bound: BindingResult,
  overrides: Partial<ViewOptions> = {},
): ViewOptions {
  const properties = rawValue(bound.parameters, 'Property');
  const groupBy = stringValue(bound.parameters, 'GroupBy');
  return viewOptions(cultureFor(context), {
    properties:
      properties === undefined || properties === null
        ? null
        : Array.isArray(properties)
          ? (properties as readonly PSValue[])
          : [properties],
    groupBy: groupBy === undefined ? null : groupBy,
    ...overrides,
  });
}

/** Build one of the three view cmdlets; they differ only in their manifest. */
export function viewCommand(spec: {
  display: string;
  aliases: readonly string[];
  synopsis: string;
  notes: string;
  parameters: readonly ReturnType<typeof parameter>[];
  view: 'table' | 'list' | 'wide';
  options?: (context: InvocationContext, bound: BindingResult) => Partial<ViewOptions>;
}): CommandModule {
  return {
    manifest: manifest({
      display: spec.display,
      aliases: spec.aliases,
      synopsis: spec.synopsis,
      notes: spec.notes,
      parameters: spec.parameters,
      outputTypeNames: ['Microsoft.PowerShell.Commands.Internal.Format.FormatEntryData'],
    }),
    async invoke(context: InvocationContext, bound: BindingResult): Promise<number> {
      const collected = await collect(context, spec.display);
      const options = readViewOptions(context, bound, spec.options?.(context, bound) ?? {});
      await emitDocument(context, collected, () => buildViewDocument(collected.values, options, spec.view));
      return 0;
    },
  };
}

/** Re-exported so the three view modules import their shared pieces from here. */
export { switchValue };
