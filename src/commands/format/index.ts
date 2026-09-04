/**
 * The formatting cmdlets, as one registry.
 *
 * Kept apart from the object cmdlets on purpose. Those transform the pipeline;
 * these END it — a Format-* emits directives that only a renderer can read, and
 * Out-String turns those into text. Nothing downstream of here is a pipeline
 * stage, which is the invariant the whole object model exists to protect.
 *
 * The shape mirrors src/commands/powershell/index.ts: modules keyed by the
 * lower-case name the resolver looks up, with aliases in the same namespace,
 * because `ft` really is `Format-Table` rather than a display convenience.
 */

import type { CommandModule } from '../invocation.ts';
import { formatList } from './format-list.ts';
import { formatTable } from './format-table.ts';
import { formatWide } from './format-wide.ts';
import { outString } from './out-string.ts';

export { formatList } from './format-list.ts';
export { formatTable } from './format-table.ts';
export { formatWide } from './format-wide.ts';
export { outString, renderStream, NEWLINE } from './out-string.ts';
export {
  buildDefaultDocument,
  buildListSection,
  buildTableSection,
  buildViewDocument,
  buildWideSection,
  scalarText,
  viewOptions,
  MAX_TABLE_PROPERTIES,
  PropertySpecError,
} from './build.ts';
export type { ViewOptions } from './build.ts';
export { cultureFor } from './common.ts';

export const FORMAT_CMDLETS: readonly CommandModule[] = [
  formatTable,
  formatList,
  formatWide,
  outString,
];

/** Canonical name and every alias, all lower-cased, to one module. */
export const FORMAT_CMDLET_INDEX: ReadonlyMap<string, CommandModule> = new Map(
  FORMAT_CMDLETS.flatMap((module) => [
    [module.manifest.name, module] as const,
    ...module.manifest.aliases.map((alias) => [alias.toLowerCase(), module] as const),
  ]),
);
