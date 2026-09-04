/**
 * Get-Help — and the two findings that changed the design.
 *
 * 1. THE VIEW IS A TYPE NAME, NOT A DIFFERENT OBJECT.
 *
 * `-Full`, `-Detailed` and `-Examples` were expected to return progressively
 * larger objects. They do not. Every call returns the same property set, in the
 * same order, and differs only in the type-name chain — each base name gains a
 * `#<View>View` twin, prepended:
 *
 *   Get-Help Get-Random         ExtendedCmdletHelpInfo,CmdletHelpInfo,HelpInfo
 *   Get-Help Get-Random -Full   ExtendedCmdletHelpInfo#FullView,CmdletHelpInfo#FullView,
 *                               HelpInfo#FullView,ExtendedCmdletHelpInfo,CmdletHelpInfo,HelpInfo
 *
 * That is this project's pipeline design stated by the reference implementation
 * itself: the object is the object, and how much of it you SEE is a formatting
 * decision keyed off the type name. Anything that filtered properties per switch
 * would have been a different command from pwsh's.
 *
 * 2. THERE ARE TWO HELP SHAPES, AND OURS IS THE SECOND ONE.
 *
 * This one cost a rewrite. A command with a MAML help file produces
 * `MamlCommandHelpInfo | HelpInfo`; a command with NO help file produces
 * auto-generated help built from the command metadata, and that object is
 * `ExtendedCmdletHelpInfo | CmdletHelpInfo | HelpInfo` with a DIFFERENT
 * parameter descriptor:
 *
 *   MAML       parameterValue description type defaultValue name required
 *              globbing pipelineInput position
 *   generated  name required pipelineInput isDynamic globbing parameterSetName
 *              parameterValue type position aliases
 *
 * Both measured in pwsh 7.6.5. The first implementation here picked the MAML
 * shape, which was wrong for what this command actually is: our help is
 * generated from the command manifests, exactly as pwsh generates help from
 * command metadata when no help file exists. So the generated shape is the one
 * modelled, and the values follow it too — `position` is `Named` (capital) for
 * a non-positional parameter, `aliases` is the string `None` when there are
 * none, and `parameterValue` is the friendly type name (`string`, `int`) rather
 * than the .NET one — except for a switch, where it is EMPTY while the nested
 * `type.name` still says `switch`.
 *
 * Also measured:
 *   Get-Help gcm      ->  Name is Get-Command; an alias resolves to its target
 *   Get-Help zzz-nope ->  HelpNotFound,Microsoft.PowerShell.Commands.GetHelpCommand
 *                         ResourceUnavailable / HelpNotFoundException
 *   Get-Help 'Get-Wi*'->  every match, no error
 */

import { psObject } from '../../pipeline/psobject.ts';
import type { PSObject, PSValue } from '../../pipeline/psobject.ts';
import { throwIfCancelled } from '../../pipeline/pipeline.ts';
import { errorRecord } from '../../pipeline/streams.ts';
import type { BindingResult, CommandModule, InvocationContext } from '../invocation.ts';
import type { CommandManifest, ParameterMetadata } from '../manifest.ts';
import {
  DEFAULT_PARAMETER_SET,
  STRING,
  SWITCH,
  compareMemberNames,
  manifest,
  parameter,
  stringValue,
  switchValue,
  wildcardPattern,
} from '../powershell/support.ts';
import { friendlyTypeName, syntaxOf } from './get-command.ts';
import type { CatalogueEntry, NativeServices } from './services.ts';

const COMMAND = 'Microsoft.PowerShell.Commands.GetHelpCommand';

/**
 * The chain pwsh reports for AUTO-GENERATED help — help built from command
 * metadata rather than read from a MAML file, which is what this command does.
 */
export const HELP_INFO_TYPE_NAMES: readonly string[] = [
  'ExtendedCmdletHelpInfo',
  'CmdletHelpInfo',
  'HelpInfo',
];
export const HELP_PARAMETER_TYPE_NAMES: readonly string[] = ['ExtendedCmdletHelpInfo#parameter'];

const GET_HELP_MANIFEST = manifest({
  display: 'Get-Help',
  aliases: ['man'],
  synopsis: 'Displays information about commands.',
  notes:
    '-Full, -Detailed and -Examples change the TYPE-NAME chain and nothing else, which is what ' +
    'pwsh does: the view is a formatting decision keyed off #FullView/#DetailedView/' +
    "#ExamplesView, not a different object. The shape modelled is pwsh's AUTO-GENERATED help " +
    '(ExtendedCmdletHelpInfo | CmdletHelpInfo | HelpInfo), not the MAML one, because this help ' +
    'is built from the command manifests exactly as pwsh builds help from command metadata ' +
    'when no help file exists. Two things pwsh carries are omitted rather than faked: ' +
    'PSSnapIn, and the three xmlns:* MAML namespace declarations. -Online, -ShowWindow and ' +
    '-Path are not implemented.',
  parameters: [
    parameter('Name', STRING, { position: 0 }),
    parameter('Category', 'System.String[]'),
    parameter('Parameter', 'System.String[]'),
    parameter('Detailed', SWITCH),
    parameter('Examples', SWITCH),
    parameter('Full', SWITCH),
    parameter('Online', SWITCH),
    parameter('ShowWindow', SWITCH),
  ],
  outputTypeNames: ['ExtendedCmdletHelpInfo'],
});

/**
 * The type-name chain for a view.
 *
 * Exported because it IS the Get-Help finding: -Full, -Detailed and -Examples
 * change nothing but this, so the conformance probe compares this function's
 * answer against the chain pwsh reports.
 */
export function helpViewTypeNames(view: 'Full' | 'Detailed' | 'Examples' | null): readonly string[] {
  if (view === null) return HELP_INFO_TYPE_NAMES;
  // EVERY base name gains a twin, in the same order, and the plain chain
  // follows. Measured: six entries for -Full, not two.
  return [...HELP_INFO_TYPE_NAMES.map((name) => `${name}#${view}View`), ...HELP_INFO_TYPE_NAMES];
}

/** Which view the bound switches select, in the order pwsh resolves them. */
function viewTypeNames(bound: BindingResult): readonly string[] {
  const view = switchValue(bound.parameters, 'Full')
    ? 'Full'
    : switchValue(bound.parameters, 'Detailed')
      ? 'Detailed'
      : switchValue(bound.parameters, 'Examples')
        ? 'Examples'
        : null;
  return helpViewTypeNames(view);
}

/**
 * One parameter descriptor, with the member names, ORDER and value shapes pwsh
 * puts on auto-generated help. Every one of these was read off
 * `(Get-Help Get-Random -Parameter Count).PSObject.Properties`:
 *
 *   name             Count
 *   required         false                   a STRING, not a boolean
 *   pipelineInput    false | true (ByValue)
 *   isDynamic        false
 *   globbing         false
 *   parameterSetName (All) | a comma-joined list of set names
 *   parameterValue   int                     the friendly name, not System.Int32
 *   type             @{name=int}             a nested #type object
 *   position         Named | 0               capital N when not positional
 *   aliases          None                    the string None, not an empty list
 *
 * Two of those are traps. `parameterValue` is the EMPTY STRING for a switch —
 * `(Get-Help Get-Location -Parameter Stack).parameterValue` is blank while its
 * `type.name` is `switch`, so the two members disagree by design. And
 * `parameterSetName` is the real set name, not a placeholder: pwsh reports
 * `Stack` for -Stack and `Location` for -PSProvider, which this reproduces
 * because the catalogue carries the sets captured from the reference
 * implementation rather than a flattened single set.
 *
 * KNOWN GAP: pwsh distinguishes `true (ByValue)`, `true (ByPropertyName)` and
 * `true (ByValue, FromRemainingArguments)`. The captured manifests record only
 * whether a parameter takes pipeline input by value, so the other two forms are
 * reported as `true (ByValue)` or `false`. Widening the capture is the fix; a
 * guess here would be worse than the gap.
 */
export function helpParameter(p: ParameterMetadata): PSObject {
  const setNames = Object.keys(p.sets);
  const single = setNames.length === 1 && setNames[0] === DEFAULT_PARAMETER_SET;
  const typeName = friendlyTypeName(p.type);
  return psObject(
    {
      name: p.name,
      required: p.mandatoryInAnySet ? 'true' : 'false',
      pipelineInput: p.valueFromPipelineInAnySet ? 'true (ByValue)' : 'false',
      isDynamic: 'false',
      globbing: 'false',
      parameterSetName: single ? '(All)' : setNames.join(', '),
      parameterValue: p.isSwitch ? '' : typeName,
      type: psObject({ name: typeName }, ['ExtendedCmdletHelpInfo#type']),
      position: p.firstPosition === null ? 'Named' : String(p.firstPosition),
      aliases: p.aliases.length === 0 ? 'None' : p.aliases.join(', '),
    },
    HELP_PARAMETER_TYPE_NAMES,
  );
}

/**
 * The help object for one command.
 *
 * Exported so a test can assert the shape without going through the pipeline,
 * and so the property ORDER is stated in one place — the order is part of what
 * was measured, and `Format-List` follows declaration order.
 */
export function helpInfo(
  entry: CatalogueEntry,
  typeNames: readonly string[],
): PSObject {
  const m = entry.manifest;
  return psObject(
    {
      // The order pwsh reports for auto-generated help, minus two things that
      // would be a claim rather than a fact: `PSSnapIn` (there is no snap-in)
      // and the three `xmlns:*` MAML namespace declarations (this help is built
      // from command manifests, not from a MAML file, and declaring the schema
      // would say otherwise). Both omissions are named in the manifest notes.
      CommonParameters: false,
      details: psObject({ name: m.display, description: m.synopsis }),
      Syntax: syntaxOf(m, m.display),
      parameters: m.parameters.map(helpParameter),
      inputTypes: '',
      relatedLinks: '',
      returnValues: m.outputTypeNames.join(', '),
      aliases: m.aliases.length === 0 ? 'None' : m.aliases.join(', '),
      remarks: 'None',
      alertSet: fidelityAlert(m),
      description: m.notes ?? '',
      examples: '',
      Synopsis: m.synopsis,
      ModuleName: 'BrowserShell',
      nonTerminatingErrors: '',
      Name: m.display,
      Category: entry.commandType,
      Component: '',
      Role: '',
      Functionality: '',
    },
    typeNames,
  );
}

/**
 * The NOTES section carries the fidelity.
 *
 * `Get-Help` is where a user asks "what does this do", and the answer has to
 * include "and how much of it is real". Putting it in `alertSet` — pwsh's own
 * home for the NOTES block — means it prints without a special-case in the
 * formatter.
 */
function fidelityAlert(m: CommandManifest): PSValue {
  const parts = [`Fidelity: ${m.fidelity}`, `Risk: ${m.risk}`];
  if (m.capabilities.length > 0) parts.push(`Capabilities: ${m.capabilities.join(', ')}`);
  if (m.notes !== undefined && m.notes !== '') parts.push(m.notes);
  return parts.join('\n');
}

/** Resolve a name — including an alias, which reports its TARGET. */
function resolve(entries: readonly CatalogueEntry[], name: string): readonly CatalogueEntry[] {
  const pattern = wildcardPattern(name);
  const hits: CatalogueEntry[] = [];
  for (const entry of entries) {
    const names = [entry.manifest.display, entry.manifest.name, ...entry.manifest.aliases];
    if (names.some((n) => pattern.test(n))) hits.push(entry);
  }
  return hits.sort((a, b) => compareMemberNames(a.manifest.display, b.manifest.display));
}

export function createGetHelp(services: NativeServices): CommandModule {
  return {
    manifest: GET_HELP_MANIFEST,

    async invoke(context: InvocationContext, bound: BindingResult): Promise<number> {
      throwIfCancelled(context.signal, 'Get-Help');
      const name = stringValue(bound.parameters, 'Name');
      const entries = services.catalogue.all();

      if (name === undefined || name === '') {
        // pwsh shows the about_ topic here. Saying nothing would be a silent
        // failure, so the quick-start command is named instead.
        await context.streams.success.write(
          'Get-Help <command>. Run Get-Command for the full list, or help for a quick start.',
        );
        return 0;
      }

      const hits = resolve(entries, name);
      if (hits.length === 0) {
        await context.streams.error.write(
          errorRecord(
            `Get-Help could not find ${name} in a help file in this session.`,
            'HelpNotFound',
            COMMAND,
            'ResourceUnavailable',
            {
              exceptionType: 'Microsoft.PowerShell.Commands.HelpNotFoundException',
              targetObject: name,
            },
          ),
        );
        return 1;
      }

      const wantParameter = stringValue(bound.parameters, 'Parameter');
      const typeNames = viewTypeNames(bound);

      for (const entry of hits) {
        if (context.streams.success.closed) break;
        if (wantParameter !== undefined) {
          const pattern = wildcardPattern(wantParameter);
          for (const p of entry.manifest.parameters) {
            if (pattern.test(p.name)) await context.streams.success.write(helpParameter(p));
          }
          continue;
        }
        await context.streams.success.write(helpInfo(entry, typeNames));
      }
      return 0;
    },
  };
}
