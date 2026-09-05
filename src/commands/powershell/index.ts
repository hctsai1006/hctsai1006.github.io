/**
 * The object cmdlets, as one registry.
 *
 * Keyed by the lower-case name the resolver looks up, because PowerShell
 * command names are case-insensitive (`where-object`, `Where-Object` and
 * `WHERE-OBJECT` are one command) and the aliases are part of the name space,
 * not a display convenience: `?` and `where` really are `Where-Object`.
 */

import type { CommandModule } from '../invocation.ts';
import { getMember } from './get-member.ts';
import { groupObject } from './group-object.ts';
import { measureObject } from './measure-object.ts';
import { selectObject } from './select-object.ts';
import { sortObject } from './sort-object.ts';
import { whereObject } from './where-object.ts';

export { getMember } from './get-member.ts';
export { groupObject } from './group-object.ts';
export { measureObject } from './measure-object.ts';
export { selectObject } from './select-object.ts';
export { sortObject } from './sort-object.ts';
export { whereObject } from './where-object.ts';
export { scriptBlock, asScriptBlock, SCRIPT_BLOCK_TYPE } from './support.ts';
export type { ScriptBlockFn } from './support.ts';

export const OBJECT_CMDLETS: readonly CommandModule[] = [
  whereObject,
  selectObject,
  sortObject,
  measureObject,
  groupObject,
  getMember,
];

/** Canonical name and every alias, all lower-cased, to one module. */
export const OBJECT_CMDLET_INDEX: ReadonlyMap<string, CommandModule> = new Map(
  OBJECT_CMDLETS.flatMap((module) => [
    [module.manifest.name, module] as const,
    ...module.manifest.aliases.map((alias) => [alias.toLowerCase(), module] as const),
  ]),
);
