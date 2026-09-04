/**
 * Get-Member — what is actually on this object.
 *
 * This is the command that makes an object pipeline visible. In the v1 terminal
 * it could not exist: by the time output reached the user it was text, and text
 * has no members.
 *
 * OUTPUT SHAPE, read off pwsh 7.6.5 rather than assumed:
 *
 *   type      Microsoft.PowerShell.Commands.MemberDefinition
 *   members   Name (string), MemberType, Definition, TypeName
 *
 *   [pscustomobject]@{Name='x'; Size=42} | Get-Member
 *     Equals       Method        bool Equals(System.Object obj)
 *     GetHashCode  Method        int GetHashCode()
 *     GetType      Method        type GetType()
 *     ToString     Method        string ToString()
 *     Name         NoteProperty  string Name=x
 *     Size         NoteProperty  int Size=42
 *
 * TWO CORRECTIONS
 *
 * 1. ONLY THE FIRST OBJECT OF EACH TYPE CONTRIBUTES. Get-Member is not a union:
 *      @(o{A=1}, o{B=2}, o{A=1;C=3}) | Get-Member  ->  Equals..ToString, A
 *    B and C never appear. All three are PSCustomObject, the first one defined
 *    the member list, and the rest were skipped without a word. A "merge every
 *    object's members" implementation would report A, B and C — more useful,
 *    and not what PowerShell does.
 *
 * 2. NOTHING TO INSPECT IS AN ERROR, not empty output:
 *      @()      | Get-Member  ->  NoObjectInGetMember,...GetMemberCommand
 *      @($null) | Get-Member  ->  same
 *      'You must specify an object for the Get-Member cmdlet.'
 *    But a null followed by a real object is fine and reports no error.
 *
 * ORDERING is by MemberType name and then by Name, case-insensitively. That is
 * what puts every Method before every NoteProperty and, for a string, Length
 * (Property) after all of them — "Method" < "NoteProperty" < "ParameterizedProperty"
 * < "Property" as text. Sorting by Name alone would interleave them, which pwsh
 * does not do.
 *
 * DECLARED LIMIT: the .NET member surface of primitives is not modelled. pwsh
 * reports 54 members for a string; this reports the four universal methods plus
 * Length. The members that ARE reported are real; the list is not exhaustive,
 * and the manifest says so rather than letting the output imply completeness.
 */

import { isPSObject, typeNameOf } from '../../pipeline/psobject.ts';
import type { PSValue } from '../../pipeline/psobject.ts';
import { throwIfCancelled } from '../../pipeline/pipeline.ts';
import { errorRecord } from '../../pipeline/streams.ts';
import type { BindingResult, CommandModule, InvocationContext } from '../invocation.ts';
import {
  STRING_ARRAY,
  SWITCH,
  compareMemberNames,
  emitAll,
  manifest,
  parameter,
  renderValue,
  stringArray,
  switchValue,
  typedObject,
  wildcardPattern,
} from './support.ts';

const COMMAND = 'Microsoft.PowerShell.Commands.GetMemberCommand';

const MEMBER_DEFINITION_TYPE = [
  'Microsoft.PowerShell.Commands.MemberDefinition',
  'System.Object',
] as const;

/**
 * PowerShell prints C# keyword aliases in a Definition, not .NET type names —
 * `int Size=42`, never `System.Int32 Size=42`. Arrays get the short form
 * (`Object[] Arr=...`) while everything else keeps its full name
 * (`System.DateTime Dt=...`). All observed directly.
 */
const TYPE_ALIASES: Readonly<Record<string, string>> = {
  'System.String': 'string',
  'System.Int32': 'int',
  'System.Int64': 'long',
  'System.Double': 'double',
  'System.Boolean': 'bool',
  'System.Object': 'object',
  'System.Object[]': 'Object[]',
  'System.Byte[]': 'byte[]',
};

function definitionTypeName(value: PSValue): string {
  const full = typeNameOf(value);
  return TYPE_ALIASES[full] ?? full;
}

/**
 * The value half of a Definition, which uses a THIRD string conversion —
 * neither `"$x"` nor the empty-string-for-custom-objects one Select-Object
 * -Unique compares on. Read off pwsh 7.6.5:
 *
 *   object N=null                          $null is the word "null", not ''
 *   Object[] Arr=System.Object[]           an array is its TYPE, not "1 2"
 *   ...PSCustomObject Nested=@{Q=1}        a custom object IS expanded
 *   string S=x   int I=1   bool B=True     scalars render normally
 *
 * The array line is the surprising one: `"$(@(1,2))"` is "1 2" everywhere else
 * in PowerShell, and reusing that here would have been a plausible wrong answer.
 */
function definitionValue(value: PSValue): string {
  if (value === null) return 'null';
  if (Array.isArray(value) || value instanceof Uint8Array) return typeNameOf(value);
  return renderValue(value);
}

interface Member {
  readonly name: string;
  readonly memberType: string;
  readonly definition: string;
}

/** Present on every object, whatever it is. Definitions copied verbatim. */
const UNIVERSAL_METHODS: readonly Member[] = [
  { name: 'Equals', memberType: 'Method', definition: 'bool Equals(System.Object obj)' },
  { name: 'GetHashCode', memberType: 'Method', definition: 'int GetHashCode()' },
  { name: 'GetType', memberType: 'Method', definition: 'type GetType()' },
  { name: 'ToString', memberType: 'Method', definition: 'string ToString()' },
];

function membersOf(value: PSValue): readonly Member[] {
  const members: Member[] = [...UNIVERSAL_METHODS];

  if (isPSObject(value)) {
    for (const [name, item] of Object.entries(value.properties)) {
      members.push({
        name,
        memberType: 'NoteProperty',
        definition: `${definitionTypeName(item)} ${name}=${definitionValue(item)}`,
      });
    }
    return members;
  }

  if (typeof value === 'string') {
    members.push({ name: 'Length', memberType: 'Property', definition: 'int Length {get;}' });
    return members;
  }
  if (Array.isArray(value) || value instanceof Uint8Array) {
    members.push({ name: 'Count', memberType: 'Property', definition: 'int Count {get;}' });
    members.push({ name: 'Length', memberType: 'Property', definition: 'int Length {get;}' });
  }
  return members;
}

const GET_MEMBER_MANIFEST = manifest({
  display: 'Get-Member',
  aliases: ['gm'],
  synopsis: 'Gets the properties and methods of objects.',
  notes:
    'Reports the members this engine actually models: note properties of a PSObject, the ' +
    'four universal methods, and Length/Count on strings and arrays. It is NOT the full ' +
    '.NET member surface — pwsh lists 54 members for a string where this lists 5 — so a ' +
    'member missing from this output may still exist on the real type. -Static, -Force and ' +
    '-View are not implemented.',
  parameters: [
    parameter('Name', STRING_ARRAY, { position: 0 }),
    parameter('MemberType', STRING_ARRAY),
    parameter('Static', SWITCH),
    parameter('Force', SWITCH),
    parameter('InputObject', 'System.Management.Automation.PSObject', {
      valueFromPipeline: true,
    }),
  ],
  outputTypeNames: ['Microsoft.PowerShell.Commands.MemberDefinition'],
});

export const getMember: CommandModule = {
  manifest: GET_MEMBER_MANIFEST,

  async invoke(context: InvocationContext, bound: BindingResult): Promise<number> {
    const parameters = bound.parameters;
    const nameFilters = stringArray(parameters, 'Name');
    const memberTypeFilters = stringArray(parameters, 'MemberType');
    if (switchValue(parameters, 'Static')) {
      await context.streams.error.write(
        errorRecord(
          '-Static is not implemented by BrowserShell; static members are not modelled.',
          'NotImplemented',
          COMMAND,
          'NotImplemented',
        ),
      );
      return 1;
    }

    // Insertion-ordered: types report in the order they were first seen, and
    // only the first object of each type is inspected.
    const byType = new Map<string, readonly Member[]>();
    let sawObject = false;

    for await (const item of context.input) {
      throwIfCancelled(context.signal, 'Get-Member');
      if (item === null) continue;
      sawObject = true;
      const typeName = typeNameOf(item);
      if (byType.has(typeName)) continue;
      byType.set(typeName, membersOf(item));
    }

    if (!sawObject) {
      await context.streams.error.write(
        errorRecord(
          'You must specify an object for the Get-Member cmdlet.',
          'NoObjectInGetMember',
          COMMAND,
          'InvalidArgument',
          { exceptionType: 'System.InvalidOperationException' },
        ),
      );
      return 1;
    }

    const nameMatchers = nameFilters?.map((pattern) => wildcardPattern(pattern));
    const wantedTypes = memberTypeFilters?.map((type) => type.toLowerCase());

    const results: PSValue[] = [];
    for (const [typeName, members] of byType) {
      const visible = members
        .filter((member) => nameMatchers?.some((m) => m.test(member.name)) ?? true)
        .filter((member) => wantedTypes?.includes(member.memberType.toLowerCase()) ?? true)
        .toSorted(
          (a, b) =>
            compareMemberNames(a.memberType, b.memberType) || compareMemberNames(a.name, b.name),
        );
      for (const member of visible) {
        results.push(
          typedObject(
            {
              // Declaration order is the DISPLAY order: pwsh's formatter shows
              // Name/MemberType/Definition and promotes TypeName to a group
              // header, which this engine has no formatter for yet.
              Name: member.name,
              MemberType: member.memberType,
              Definition: member.definition,
              TypeName: typeName,
            },
            MEMBER_DEFINITION_TYPE,
          ),
        );
      }
    }

    await emitAll(context.streams.success, results, context.signal);
    return 0;
  },
};
