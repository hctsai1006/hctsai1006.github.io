/**
 * catalogue.ts — the list of commands `Get-Command` and `Get-Help` report on.
 *
 * There are two facts about a command and they live in two generated files, so
 * this is where they meet:
 *
 *   src/commands/manifests.json     what the command IS — fidelity, risk,
 *                                   capabilities, notes, and the parameters
 *                                   captured from the reference implementation
 *   src/commands/v1-inventory.json  what KIND of thing it is — Cmdlet,
 *                                   Application or Variable, extracted from the
 *                                   archived v1 terminal
 *
 * Neither is edited here. `Get-Command` reporting a set that disagrees with the
 * completion engine's set would be the exact drift `inventory.ts` was written
 * to make impossible, and both read the same generated file.
 *
 * The extras are commands implemented in this directory that predate no v1
 * entry — `New-Guid`, which a conformance case needs. They are appended rather
 * than merged in so it stays visible that they are ours.
 */

import manifestsJson from '../manifests.json' with { type: 'json' };
import inventoryJson from '../v1-inventory.json' with { type: 'json' };
import type { CommandManifest } from '../manifest.ts';
import type { CatalogueEntry, CommandTypeName } from './services.ts';
import { catalogueOf } from './services.ts';
import type { CommandCatalogue } from './services.ts';

interface InventoryEntry {
  readonly name: string;
  readonly kind: string;
}

const KNOWN_TYPES: readonly CommandTypeName[] = [
  'Alias', 'Function', 'Filter', 'Cmdlet', 'ExternalScript',
  'Application', 'Script', 'Configuration', 'Variable',
];

const INVENTORY_KIND = new Map<string, string>(
  (inventoryJson as { commands: readonly InventoryEntry[] }).commands.map((c) => [c.name, c.kind]),
);

/**
 * The kind a command reports.
 *
 * The v1 inventory is consulted first because it is extracted data. The
 * fallback is the SHAPE of the name — `Verb-Noun` is a cmdlet, a bare word is
 * an application — which is the same rule v1 applied by hand and the only rule
 * available for a command the inventory has never seen.
 */
export function commandTypeOf(manifest: CommandManifest): CommandTypeName {
  const declared = INVENTORY_KIND.get(manifest.name);
  if (declared !== undefined) {
    const match = KNOWN_TYPES.find((t) => t === declared);
    if (match !== undefined) return match;
  }
  return manifest.display.includes('-') ? 'Cmdlet' : 'Application';
}

/**
 * Every declared command, plus the ones implemented here that no generated file
 * knows about yet.
 */
export function defaultCatalogue(extras: readonly CommandManifest[] = []): CommandCatalogue {
  const declared = (manifestsJson as { commands: readonly CommandManifest[] }).commands;
  const known = new Set(declared.map((m) => m.name));
  const entries: CatalogueEntry[] = declared.map((manifest) => ({
    manifest,
    commandType: commandTypeOf(manifest),
  }));
  for (const manifest of extras) {
    if (known.has(manifest.name)) continue;
    entries.push({ manifest, commandType: commandTypeOf(manifest) });
  }
  return catalogueOf(entries);
}
