/**
 * Group-Object.
 *
 * WHAT THE PROBE SETTLED
 *
 * The emitted object is `Microsoft.PowerShell.Commands.GroupInfo` with four
 * members, read off `Get-Member` rather than guessed:
 *
 *   Count   int
 *   Name    string                                  <- a STRING, always
 *   Group   Collection[psobject]
 *   Values  ArrayList                               <- the raw key values
 *
 * `Name` being a string matters: `@(1,1,2) | Group-Object` gives Name "1" of
 * type System.String while `Values[0]` stays System.Int32. Code that groups
 * numbers and then compares `$g.Name -eq 1` is comparing against a string.
 *
 * THREE CORRECTIONS
 *
 * 1. `-NoElement` does NOT remove the Group property. It emits a DIFFERENT
 *    type, `GroupInfoNoElement`, which still has Group — empty:
 *      ($g | Group-Object K -NoElement)[0].Group.Count   ->  0
 *      typenames: GroupInfoNoElement | GroupInfo | System.Object
 *    Dropping the property would break anything that reads `.Group.Count`.
 *
 * 2. GROUPS COME OUT IN KEY ORDER, NOT FIRST-APPEARANCE ORDER:
 *      @('z','m','b','a') | Group-Object   ->  a, b, m, z
 *      @('m','z','a','b') | Group-Object   ->  a, b, m, z
 *    Same output from different inputs. And the ordering is by the VALUE, not
 *    by the Name string: `@(10,9,2) | Group-Object` gives 2, 9, 10, where
 *    ordering the names as text would give 10, 2, 9.
 *
 * 3. NULL INPUT OBJECTS ARE DROPPED, like Sort-Object and Select-Object:
 *      @($null,1) | Group-Object   ->  one group, Name "1", Count 1
 *    A null *property* is different: it forms a group whose Name is the EMPTY
 *    STRING, and `$null -eq $group.Name` is False.
 *
 * -AsHashTable AND -AsString, MEASURED AND REFUSED
 *
 *   ($g | Group-Object K -AsHashTable).GetType().FullName
 *     ->  System.Collections.Hashtable                       ONE object, not
 *                                                            a stream of groups
 *   (@(1,1,2) | Group-Object -AsHashTable).Keys[0].GetType().Name
 *     ->  Int32                                              keys keep their type
 *   (@(1,1,2) | Group-Object -AsHashTable -AsString).Keys[0].GetType().Name
 *     ->  String                                             -AsString is what
 *                                                            makes them strings
 *   $g | Group-Object K -AsString
 *     ->  ArgumentException,...GroupObjectCommand
 *         'The command cannot be run because the AsString parameter requires
 *          that you specify the AsHashtable parameter.'
 *
 * Both were in the manifest and neither was read: -AsHashTable produced the
 * ordinary GroupInfo stream and -AsString did nothing at all. The first is
 * REFUSED rather than approximated, because the answer is a
 * System.Collections.Hashtable and this engine's value model has no hashtable
 * in it -- anything emitted would be a different type, with different member
 * access, under a name that says otherwise. The second reproduces pwsh's own
 * error, which is the same refusal pwsh makes.
 *
 * KNOWN DIVERGENCE. pwsh inserts each new group into a list by binary search,
 * so when the keys are of mixed types — and the comparison is therefore not a
 * consistent ordering — the result is neither sorted nor input order:
 *   @(2,'apple',10,'Banana') | Group-Object  ->  2, apple, 10, Banana
 * That is an artifact of searching an unsorted list, not a rule. This
 * implementation sorts, so it reports 2, 10, apple, Banana for that input.
 * Every homogeneous case — which is every realistic one — agrees.
 */

import { compareForSorting } from '../../pipeline/psobject.ts';
import type { PSValue } from '../../pipeline/psobject.ts';
import { throwIfCancelled } from '../../pipeline/pipeline.ts';
import { errorRecord } from '../../pipeline/streams.ts';
import type { BindingResult, CommandModule, InvocationContext } from '../invocation.ts';
import {
  OBJECT,
  STRING_ARRAY,
  SWITCH,
  commandInput,
  emitAll,
  manifest,
  parameter,
  renderValue,
  resolveProperty,
  stringArray,
  switchValue,
  typedObject,
} from './support.ts';

const COMMAND = 'Microsoft.PowerShell.Commands.GroupObjectCommand';

const GROUP_INFO_TYPE = ['Microsoft.PowerShell.Commands.GroupInfo', 'System.Object'] as const;

const GROUP_INFO_NO_ELEMENT_TYPE = [
  'Microsoft.PowerShell.Commands.GroupInfoNoElement',
  'Microsoft.PowerShell.Commands.GroupInfo',
  'System.Object',
] as const;

interface Group {
  readonly name: string;
  readonly values: PSValue[];
  readonly members: PSValue[];
  /** First-seen position, so equal keys keep a deterministic order. */
  readonly order: number;
}

const GROUP_OBJECT_MANIFEST = manifest({
  display: 'Group-Object',
  aliases: ['group'],
  synopsis: 'Groups objects that contain the same value for specified properties.',
  notes:
    'Emits GroupInfo (or GroupInfoNoElement for -NoElement) with Count, Name, Group and ' +
    'Values, verified against pwsh 7.6.5. -AsHashTable is REFUSED with a named error rather ' +
    'than ignored: it returns a System.Collections.Hashtable in pwsh and this value model ' +
    'has no hashtable, so any object emitted under that name would answer differently. ' +
    '-AsString without -AsHashTable reproduces pwsh\'s own ArgumentException. -Culture is ' +
    'upstream-only and is not accepted. Group ordering is sorted by key; pwsh sorts by key ' +
    'too, except for mixed-type keys where its binary-search insertion produces an ' +
    'arbitrary order.',
  parameters: [
    parameter('Property', STRING_ARRAY, { position: 0 }),
    parameter('NoElement', SWITCH),
    parameter('CaseSensitive', SWITCH),
    parameter('AsHashTable', SWITCH, { aliases: ['AHT'] }),
    parameter('AsString', SWITCH),
    parameter('InputObject', OBJECT, { valueFromPipeline: true }),
  ],
  outputTypeNames: ['Microsoft.PowerShell.Commands.GroupInfo'],
});

export const groupObject: CommandModule = {
  manifest: GROUP_OBJECT_MANIFEST,

  async invoke(context: InvocationContext, bound: BindingResult): Promise<number> {
    const parameters = bound.parameters;
    const properties = stringArray(parameters, 'Property');
    const noElement = switchValue(parameters, 'NoElement');
    const caseSensitive = switchValue(parameters, 'CaseSensitive');
    const asHashTable = switchValue(parameters, 'AsHashTable');
    const asString = switchValue(parameters, 'AsString');

    // pwsh's own message and error id, word for word. -AsString is meaningless
    // without -AsHashTable because all it does is stringify the hashtable KEYS.
    if (asString && !asHashTable) {
      await context.streams.error.write(
        errorRecord(
          'The command cannot be run because the AsString parameter requires that you ' +
            'specify the AsHashtable parameter.',
          'ArgumentException',
          COMMAND,
          'InvalidArgument',
          { exceptionType: 'System.ArgumentException' },
        ),
      );
      return 1;
    }

    // Refused, not approximated. See the header note.
    if (asHashTable) {
      await context.streams.error.write(
        errorRecord(
          '-AsHashTable is not supported by BrowserShell. In PowerShell it emits a single ' +
            'System.Collections.Hashtable whose keys are the group keys; this engine has no ' +
            'hashtable in its value model, and an object emitted under that name would not ' +
            'answer .Keys or an index the way the real one does. Use the default GroupInfo ' +
            'output, whose Name and Group carry the same information.',
          'ParameterNotSupported',
          COMMAND,
          'NotImplemented',
          { exceptionType: 'System.NotSupportedException' },
        ),
      );
      return 1;
    }

    const groups = new Map<string, Group>();

    for await (const item of commandInput(context, parameters, COMMAND)) {
      throwIfCancelled(context.signal, 'Group-Object');
      if (item === null) continue;

      const values: PSValue[] =
        properties === undefined
          ? [item]
          : properties.map((name) => resolveProperty(item, name) ?? null);

      // The key is the RENDERED value, which is why 1 and '1' land in the same
      // group and why a missing or null property groups under ''. NUL joins the
      // parts so `@('a','b')` and `@('a b')` cannot collide.
      const rendered = values.map((value) => renderValue(value));
      const key = (caseSensitive ? rendered : rendered.map((r) => r.toLowerCase())).join('\u0000');

      const existing = groups.get(key);
      if (existing === undefined) {
        groups.set(key, {
          // Multiple properties render as "1, x" — comma AND space, verified.
          name: rendered.join(', '),
          values,
          members: [item],
          order: groups.size,
        });
      } else {
        existing.members.push(item);
      }
    }

    const ordered = [...groups.values()].sort((a, b) => {
      const width = Math.max(a.values.length, b.values.length);
      for (let index = 0; index < width; index += 1) {
        const result = compareForSorting(a.values[index] ?? null, b.values[index] ?? null);
        if (result !== 0) return result;
      }
      return a.order - b.order;
    });

    await emitAll(
      context.streams.success,
      ordered.map((group) =>
        typedObject(
          {
            Count: group.members.length,
            Name: group.name,
            // Present even with -NoElement, holding nothing. See correction 1.
            Group: noElement ? [] : group.members,
            Values: group.values,
          },
          noElement ? GROUP_INFO_NO_ELEMENT_TYPE : GROUP_INFO_TYPE,
        ),
      ),
      context.signal,
    );
    return 0;
  },
};
