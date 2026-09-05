/**
 * Get-Command — the catalogue, and the honesty feature this project exists for.
 *
 * WHAT pwsh DOES, MEASURED
 *
 *   (Get-Command Get-Date).GetType()   ->  System.Management.Automation.CmdletInfo
 *   typeNames                          ->  CmdletInfo | CommandInfo | System.Object
 *   (Get-Command gcm).GetType()        ->  AliasInfo, with Definition,
 *                                          ResolvedCommandName and
 *                                          DisplayName = "gcm -> Get-Command"
 *   default table                      ->  CommandType | Name | Version | Source
 *   Get-Command 'zzz-nope'             ->  CommandNotFoundException,
 *                                          Microsoft.PowerShell.Commands.GetCommandCommand
 *                                          ObjectNotFound / CommandNotFoundException
 *   Get-Command 'zzz-nope*'            ->  NOTHING, and no error
 *   Get-Command a,b,c                  ->  in the order requested
 *   Get-Command 'Out-*'                ->  sorted by name
 *   Get-Command GCM                    ->  Name is `gcm`, the alias itself
 *
 * The exact-name/wildcard split is the one that bites: a name with no wildcard
 * that matches nothing is an error, the same name with a `*` is an empty
 * result. An implementation that treated them alike would be wrong in one
 * direction or the other whichever way it chose.
 *
 * WHY -Detailed EXISTS, AND WHY IT IS HONEST TO ADD IT
 *
 * This project's whole claim is that a terminal which looks authoritative about
 * everything is lying about most of it, so every command declares a fidelity
 * and something has to print it. pwsh 7.6.5 has no `-Detailed` on Get-Command —
 * `(Get-Command Get-Command).Parameters.ContainsKey('Detailed')` is False — and,
 * measured, it does not reject one either: `-ArgumentList` is declared
 * `ValueFromRemainingArguments` at position 1, so `Get-Command Get-Date
 * -Detailed` silently swallows the token and returns Get-Date. (Cmdlets without
 * a collecting parameter DO reject it: `Get-Random -Detailed` is
 * NamedParameterNotFound.)
 *
 * So `-Detailed` here is a declared extension, not a claim about pwsh, and the
 * object it emits is named `BrowserShell.CommandFidelityInfo` — prefixed so it
 * cannot be mistaken for a .NET type.
 */

import { psObject } from '../../pipeline/psobject.ts';
import type { PSObject, PSValue } from '../../pipeline/psobject.ts';
import { throwIfCancelled } from '../../pipeline/pipeline.ts';
import { errorRecord } from '../../pipeline/streams.ts';
import type { BindingResult, CommandModule, InvocationContext } from '../invocation.ts';
import { FIDELITY_BADGE, FIDELITY_MEANING, boundParameters } from '../manifest.ts';
import type { CommandManifest, Fidelity } from '../manifest.ts';
import {
  INT,
  STRING_ARRAY,
  SWITCH,
  compareMemberNames,
  hasWildcard,
  manifest,
  numberValue,
  parameter,
  stringArray,
  switchValue,
  wildcardPattern,
} from '../powershell/support.ts';
import type { CatalogueEntry, CommandTypeName, NativeServices } from './services.ts';

const COMMAND = 'Microsoft.PowerShell.Commands.GetCommandCommand';

export const CMDLET_INFO_TYPE_NAMES: readonly string[] = [
  'System.Management.Automation.CmdletInfo',
  'System.Management.Automation.CommandInfo',
  'System.Object',
];
export const ALIAS_INFO_TYPE_NAMES: readonly string[] = [
  'System.Management.Automation.AliasInfo',
  'System.Management.Automation.CommandInfo',
  'System.Object',
];
export const APPLICATION_INFO_TYPE_NAMES: readonly string[] = [
  'System.Management.Automation.ApplicationInfo',
  'System.Management.Automation.CommandInfo',
  'System.Object',
];
/** Prefixed so nobody reads it as a type the .NET runtime has. */
export const FIDELITY_INFO_TYPE_NAMES: readonly string[] = [
  'BrowserShell.CommandFidelityInfo',
  'System.Object',
];

/** Where an implementation lives. Not a PowerShell module; it does not claim to be. */
const SOURCE = 'BrowserShell';

const GET_COMMAND_MANIFEST = manifest({
  display: 'Get-Command',
  aliases: ['gcm'],
  synopsis: 'Gets all commands.',
  notes:
    '-Detailed is an EXTENSION, not a pwsh parameter: pwsh 7.6.5 has no such parameter and does ' +
    'not reject one either, because Get-Command -ArgumentList is ValueFromRemainingArguments and ' +
    'swallows the token. It emits BrowserShell.CommandFidelityInfo, carrying the fidelity, the ' +
    'badge, the risk, the capabilities and the notes each manifest declares — which is the point ' +
    'of declaring them. Ordering is by command type then name; real pwsh orders by module ' +
    'discovery within a type, which a browser has no analogue for. -All is accepted and is a ' +
    'no-op: it asks for every command sharing a name across modules, and there is exactly one ' +
    'of each here. -Module, -FullyQualifiedModule, -ShowCommandInfo, -UseFuzzyMatching and ' +
    '-UseAbbreviationExpansion are not implemented.',
  parameters: [
    parameter('Name', STRING_ARRAY, { position: 0, valueFromPipeline: true }),
    parameter('CommandType', 'System.Management.Automation.CommandTypes', { aliases: ['Type'] }),
    parameter('Verb', STRING_ARRAY),
    parameter('Noun', STRING_ARRAY),
    parameter('ParameterName', STRING_ARRAY),
    parameter('TotalCount', INT),
    parameter('Syntax', SWITCH),
    parameter('All', SWITCH),
    parameter('Detailed', SWITCH),
  ],
  outputTypeNames: [
    'System.Management.Automation.AliasInfo',
    'System.Management.Automation.ApplicationInfo',
    'System.Management.Automation.CmdletInfo',
    'System.String',
    'BrowserShell.CommandFidelityInfo',
  ],
});

/** One resolvable name: the command itself, or one of its aliases. */
interface Resolved {
  readonly entry: CatalogueEntry;
  /** The name as it will be reported — the alias when reached through one. */
  readonly name: string;
  readonly commandType: CommandTypeName;
}

function expand(entries: readonly CatalogueEntry[]): readonly Resolved[] {
  const out: Resolved[] = [];
  for (const entry of entries) {
    out.push({ entry, name: entry.manifest.display, commandType: entry.commandType });
    for (const alias of entry.manifest.aliases) {
      out.push({ entry, name: alias, commandType: 'Alias' });
    }
  }
  return out;
}

/**
 * The type names for one resolved command.
 *
 * An alias reports AliasInfo even though the thing behind it is a cmdlet —
 * measured: `(Get-Command gcm).GetType()` is AliasInfo and its `Name` is `gcm`,
 * not `Get-Command`.
 */
export function commandTypeNames(commandType: CommandTypeName): readonly string[] {
  if (commandType === 'Alias') return ALIAS_INFO_TYPE_NAMES;
  if (commandType === 'Application') return APPLICATION_INFO_TYPE_NAMES;
  return CMDLET_INFO_TYPE_NAMES;
}

/** The one-line syntax `-Syntax` prints, built from the declared parameters. */
export function syntaxOf(manifestOf: CommandManifest, name: string): string {
  // What this engine BINDS, not what upstream declares. The syntax line is a
  // prompt to type something, and a syntax line offering `-Top <int>` for a
  // binder that rejects it is an instruction to get an error.
  const parts = boundParameters(manifestOf).map((p) => {
    const position = p.firstPosition;
    const head = position === null ? `-${p.name}` : `[-${p.name}]`;
    const body = p.isSwitch ? head : `${head} <${friendlyTypeName(p.type)}>`;
    return p.mandatoryInAnySet ? body : `[${body}]`;
  });
  return [name, ...parts, '[<CommonParameters>]'].join(' ');
}

/**
 * `System.String[]` reads as `string[]` in a syntax line, as pwsh prints it —
 * and in a help object's `parameterValue`, which is why this is exported.
 * Measured: `(Get-Help Get-Random -Parameter Count).parameterValue` is `int`.
 */
export function friendlyTypeName(type: string): string {
  const array = type.endsWith('[]');
  const base = array ? type.slice(0, -2) : type;
  const leaf = base.slice(base.lastIndexOf('.') + 1);
  // Read off `(Get-Help <cmd> -Parameter <p>).type.name`, which is where the
  // capitalisation stops being guessable: `string[]` is lower-case but
  // `Object[]` is not, and PSObject shortens all the way to `psobject`.
  const friendly: Record<string, string> = {
    String: 'string', Int32: 'int', Int64: 'long', Boolean: 'bool',
    Object: 'Object', SwitchParameter: 'switch', Double: 'double',
    PSObject: 'psobject', DateTime: 'datetime',
  };
  return `${friendly[leaf] ?? leaf}${array ? '[]' : ''}`;
}

function commandInfo(resolved: Resolved): PSObject {
  const m = resolved.entry.manifest;
  const properties: Record<string, PSValue> = {
    Name: resolved.name,
    CommandType: resolved.commandType,
    // Empty for everything, as pwsh reports for Functions and Aliases. A
    // version number here would be a claim about a module that does not exist.
    Version: '',
    Source: SOURCE,
    ModuleName: SOURCE,
    Definition: syntaxOf(m, m.display),
    Synopsis: m.synopsis,
  };
  if (resolved.commandType === 'Alias') {
    properties['ResolvedCommandName'] = m.display;
    properties['DisplayName'] = `${resolved.name} -> ${m.display}`;
    properties['ReferencedCommand'] = m.display;
  } else {
    const hyphen = m.display.indexOf('-');
    properties['Verb'] = hyphen === -1 ? '' : m.display.slice(0, hyphen);
    properties['Noun'] = hyphen === -1 ? '' : m.display.slice(hyphen + 1);
  }
  return psObject(properties, commandTypeNames(resolved.commandType));
}

/**
 * The fidelity report. This is the object the project's central claim rests on:
 * it says how real the command is, in the words the taxonomy defines, with the
 * note explaining why.
 */
export function fidelityInfo(resolved: Resolved): PSObject {
  const m = resolved.entry.manifest;
  return psObject(
    {
      Name: resolved.name,
      CommandType: resolved.commandType,
      Fidelity: m.fidelity,
      Badge: FIDELITY_BADGE[m.fidelity as Fidelity] ?? '',
      Meaning: FIDELITY_MEANING[m.fidelity as Fidelity] ?? '',
      Runtime: m.runtime,
      Risk: m.risk,
      Capabilities: [...m.capabilities],
      // Two different facts, side by side on purpose. ParameterSource says
      // where the PARAMETER METADATA came from -- it is about upstream, and
      // 'reference-implementation' means pwsh reported these names, never that
      // this engine binds them. Implementation says how much was built here.
      // Reading the first as the second is what let Where-Object be counted as
      // an implemented command while its manifest could not express its own
      // parameter sets.
      ParameterSource: m.parameterSource,
      Implementation: m.implementationStatus,
      Synopsis: m.synopsis,
      Notes: m.notes ?? '',
    },
    FIDELITY_INFO_TYPE_NAMES,
  );
}

/** Cmdlet before Function before Alias before Application, then by name. */
const TYPE_RANK: readonly CommandTypeName[] = [
  'Alias', 'Function', 'Filter', 'Cmdlet', 'ExternalScript',
  'Application', 'Script', 'Configuration', 'Variable',
];
function rank(type: CommandTypeName): number {
  const index = TYPE_RANK.indexOf(type);
  return index === -1 ? TYPE_RANK.length : index;
}

function matchesType(resolved: Resolved, wanted: readonly string[] | undefined): boolean {
  if (wanted === undefined) return true;
  return wanted.some((t) => {
    const lower = t.toLowerCase();
    return lower === 'all' || lower === resolved.commandType.toLowerCase();
  });
}

export function createGetCommand(services: NativeServices): CommandModule {
  return {
    manifest: GET_COMMAND_MANIFEST,

    async invoke(context: InvocationContext, bound: BindingResult): Promise<number> {
      throwIfCancelled(context.signal, 'Get-Command');
      const parameters = bound.parameters;
      const all = expand(services.catalogue.all());

      const requested = stringArray(parameters, 'Name');
      const types = stringArray(parameters, 'CommandType');
      const verbs = stringArray(parameters, 'Verb');
      const nouns = stringArray(parameters, 'Noun');
      const parameterNames = stringArray(parameters, 'ParameterName');
      const totalCount = numberValue(parameters, 'TotalCount');
      const syntax = switchValue(parameters, 'Syntax');
      const detailed = switchValue(parameters, 'Detailed');

      const passesFilters = (r: Resolved): boolean => {
        if (!matchesType(r, types)) return false;
        if (verbs !== undefined) {
          const hyphen = r.name.indexOf('-');
          const verb = hyphen === -1 ? '' : r.name.slice(0, hyphen);
          if (!verbs.some((v) => wildcardPattern(v).test(verb))) return false;
        }
        if (nouns !== undefined) {
          const hyphen = r.name.indexOf('-');
          const noun = hyphen === -1 ? '' : r.name.slice(hyphen + 1);
          if (!nouns.some((n) => wildcardPattern(n).test(noun))) return false;
        }
        if (parameterNames !== undefined) {
          // What BINDS. `-ParameterName Top` asking "which commands take
          // -Top?" and being handed Sort-Object, which rejects it, is the
          // same conflation as offering it in completion.
          const declared = boundParameters(r.entry.manifest);
          const ok = parameterNames.every((want) =>
            declared.some(
              (p) =>
                wildcardPattern(want).test(p.name) ||
                p.aliases.some((a) => wildcardPattern(want).test(a)),
            ),
          );
          if (!ok) return false;
        }
        return true;
      };

      const byRankThenName = (a: Resolved, b: Resolved): number =>
        rank(a.commandType) - rank(b.commandType) || compareMemberNames(a.name, b.name);

      let selected: Resolved[] = [];
      let failed = false;

      if (requested === undefined) {
        selected = all.filter(passesFilters).sort(byRankThenName);
      } else {
        // Requested names keep their REQUESTED order; each name's own matches
        // are sorted. Both measured.
        const seen = new Set<string>();
        for (const want of requested) {
          const isWildcard = hasWildcard(want);
          const pattern = wildcardPattern(want);
          const hits = all
            .filter((r) => pattern.test(r.name) && passesFilters(r))
            .sort(byRankThenName);
          if (hits.length === 0 && !isWildcard) {
            failed = true;
            await context.streams.error.write(
              errorRecord(
                `The term '${want}' is not recognized as a name of a cmdlet, function, script ` +
                  'file, or executable program.\nCheck the spelling of the name, or if a path ' +
                  'was included, verify that the path is correct and try again.',
                'CommandNotFoundException',
                COMMAND,
                'ObjectNotFound',
                {
                  exceptionType: 'System.Management.Automation.CommandNotFoundException',
                  targetObject: want,
                },
              ),
            );
            continue;
          }
          for (const hit of hits) {
            const key = `${hit.commandType} ${hit.name}`;
            if (seen.has(key)) continue;
            seen.add(key);
            selected.push(hit);
          }
        }
      }

      if (totalCount !== undefined) selected = selected.slice(0, Math.max(0, totalCount));

      for (const resolved of selected) {
        if (context.streams.success.closed) break;
        if (syntax) {
          await context.streams.success.write(syntaxOf(resolved.entry.manifest, resolved.name));
        } else if (detailed) {
          await context.streams.success.write(fidelityInfo(resolved));
        } else {
          await context.streams.success.write(commandInfo(resolved));
        }
      }
      return failed ? 1 : 0;
    },
  };
}
