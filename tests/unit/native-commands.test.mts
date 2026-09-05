/**
 * Tests for the system commands.
 *
 * Every `// pwsh:` line is a reading from pwsh 7.6.5, not a recollection. The
 * clock and the RNG are injected by native-harness.mts, so nothing here depends
 * on the wall clock or on `Math.random()`.
 *
 * THE FINDINGS THAT CONTRADICTED THE OBVIOUS IMPLEMENTATION
 *
 *   Get-Random   -Maximum is EXCLUSIVE, and Minimum == Maximum is an ERROR
 *                rather than a degenerate one-value range
 *   Get-Random   -SetSeed still EMITS a value
 *   Get-Random   -Count larger than the list returns the whole list, once each
 *   Get-Help     -Full/-Detailed/-Examples change the TYPE NAME and nothing
 *                else; the property set is identical in all four calls
 *   Get-Command  an exact name that matches nothing is an ERROR; the same name
 *                with a wildcard is an empty result and no error
 *   Get-Command  an alias reports its own name, and type AliasInfo
 *   Get-History  -Count n returns the n MOST RECENT entries
 *   Write-Output -NoEnumerate does nothing to pipeline input
 *   Out-Null     discards stream 1 only; errors still reach the error stream
 */

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

import { psObject } from '../../src/pipeline/psobject.ts';
import type { PSValue } from '../../src/pipeline/psobject.ts';
import { CapabilityDeniedError } from '../../src/commands/invocation.ts';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

import { errorRecord } from '../../src/pipeline/streams.ts';
import {
  EMPTY_GUID,
  NEW_GUID_MANIFEST,
  NEW_GUID_VERSION_KEY,
  defaultCatalogue,
  fixedClock,
  guidText,
  historyOf,
  pathInfo,
  psVersionTable,
  quickStartRows,
  seededRandom,
  syntaxOf,
  SIMULATED_MACHINE,
  gitCommitIdFor,
} from '../../src/commands/native/index.ts';
import { HELP_INFO_TYPE_NAMES, helpInfo } from '../../src/commands/native/get-help.ts';
import type { CommandManifest } from '../../src/commands/manifest.ts';
import type { PSObject } from '../../src/pipeline/psobject.ts';

/**
 * One manifest straight out of the generated file.
 *
 * Read at runtime rather than through the registry: these assertions are about
 * what the GENERATED manifest says, which is the thing help and syntax read,
 * and Where-Object is not in the registry at all.
 */
const GENERATED_MANIFESTS = (
  JSON.parse(
    readFileSync(
      join(import.meta.dirname, '..', '..', 'src', 'commands', 'manifests.json'),
      'utf8',
    ),
  ) as { commands: readonly CommandManifest[] }
).commands;

function MANIFEST_OF(name: string): CommandManifest {
  const found = GENERATED_MANIFESTS.find((m) => m.name === name);
  assert.ok(found !== undefined, `${name} is not in manifests.json`);
  return found;
}
import {
  TEST_HISTORY,
  TEST_INSTANT,
  column,
  commandsFor,
  prop,
  run,
  runChain,
  testServices,
  typeNamesOf,
} from './native-harness.mts';

const commands = commandsFor();
const need = (name: string): NonNullable<ReturnType<typeof commands.get>> => {
  const module = commands.get(name);
  assert.ok(module !== undefined, `no module named ${name}`);
  return module;
};

// ---------------------------------------------------------------------------
// Get-Date
// ---------------------------------------------------------------------------

describe('Get-Date', () => {
  const getDate = need('get-date');

  it('emits a DateTime into the pipeline, not a string', async () => {
    // pwsh: Get-Date | ForEach-Object { $_.GetType().FullName } -> System.DateTime
    const result = await run(getDate);
    assert.equal(result.values.length, 1);
    assert.deepEqual(typeNamesOf(result.values[0]), [
      'System.DateTime', 'System.ValueType', 'System.Object',
    ]);
  });

  it('emits a String when -Format is given', async () => {
    // pwsh: (Get-Date -Format 'yyyy-MM-dd').GetType().FullName -> System.String
    const result = await run(getDate, { Date: '2026-03-04T05:06:07Z', Format: 'yyyy-MM-dd' });
    assert.deepEqual(result.values, ['2026-03-04']);
  });

  it('replaces one component at a time with -Year/-Month/-Day', async () => {
    // pwsh: Get-Date -Date '2026-03-04T05:06:07' -Year 2000 -> 2000-03-04T05:06:07
    const year = await run(getDate, { Date: '2026-03-04T05:06:07Z', Year: 2000, Format: 'o' });
    assert.deepEqual(year.values, ['2000-03-04T05:06:07.0000000']);
    // pwsh: -Month 12 -Day 25 -> 2026-12-25T05:06:07
    const md = await run(getDate, { Date: '2026-03-04T05:06:07Z', Month: 12, Day: 25, Format: 'o' });
    assert.deepEqual(md.values, ['2026-12-25T05:06:07.0000000']);
    // pwsh: -Hour 1 -Minute 2 -Second 3 -Millisecond 4 -> 2026-03-04T01:02:03.0040000
    const hms = await run(getDate, {
      Date: '2026-03-04T05:06:07Z', Hour: 1, Minute: 2, Second: 3, Millisecond: 4, Format: 'o',
    });
    assert.deepEqual(hms.values, ['2026-03-04T01:02:03.0040000']);
  });

  it('reads the injected clock when no -Date is given', async () => {
    const result = await run(getDate, { Format: 'yyyy-MM-ddTHH:mm:ss' });
    assert.deepEqual(result.values, ['2026-03-04T05:06:07']);
  });

  it('is deterministic across two calls, because the clock is injected', async () => {
    const a = await run(getDate, { UFormat: '%s' });
    const b = await run(getDate, { UFormat: '%s' });
    assert.deepEqual(a.values, b.values);
  });

  it('rejects -Format with -UFormat as an ambiguous parameter set', async () => {
    // pwsh: AmbiguousParameterSet,Microsoft.PowerShell.Commands.GetDateCommand
    //       InvalidArgument / ParameterBindingException
    const result = await run(getDate, { Format: 'yyyy', UFormat: '%Y' });
    assert.equal(result.values.length, 0);
    assert.equal(result.errors.length, 1);
    assert.equal(
      result.errors[0]?.fullyQualifiedErrorId,
      'AmbiguousParameterSet,Microsoft.PowerShell.Commands.GetDateCommand',
    );
    assert.equal(result.errors[0]?.category, 'InvalidArgument');
    assert.equal(result.exitCode, 1);
  });

  it('converts, not relabels, for -AsUTC', async () => {
    // pwsh: (Get-Date -Date '2026-03-04T05:06:07' -AsUTC).Kind -> Utc, and the
    // value moves back by the session offset.
    const result = await run(getDate, { Date: '2026-03-04T05:06:07Z', AsUTC: true, Format: 'o' });
    assert.deepEqual(result.values, ['2026-03-03T21:06:07.0000000Z']);
  });

  it('changes only the DateTime property for -DisplayHint', async () => {
    // pwsh: (Get-Date -DisplayHint Date).GetType() is still System.DateTime and
    //       Hour is still populated; only .DateTime loses the time.
    const result = await run(getDate, { Date: '2026-03-04T05:06:07Z', DisplayHint: 'Date' });
    assert.equal(prop(result.values[0], 'DateTime'), 'Wednesday, March 4, 2026');
    assert.equal(prop(result.values[0], 'Hour'), 5);
    assert.equal(prop(result.values[0], 'DisplayHint'), 'Date');
  });
});

// ---------------------------------------------------------------------------
// Get-Random
// ---------------------------------------------------------------------------

describe('Get-Random', () => {
  const getRandom = need('get-random');

  it('treats -Maximum as EXCLUSIVE', async () => {
    // pwsh: Get-Random -Minimum 0 -Maximum 1, twenty times -> 0 every time
    for (let i = 0; i < 20; i += 1) {
      const result = await run(getRandom, { Minimum: 0, Maximum: 1 });
      assert.deepEqual(result.values, [0]);
    }
    // pwsh: -Minimum 0 -Maximum 2 -> only 0 and 1 ever appear
    for (let i = 0; i < 40; i += 1) {
      const result = await run(getRandom, { Minimum: 0, Maximum: 2 });
      const value = result.values[0] as number;
      assert.ok(value === 0 || value === 1, `unexpected ${String(value)}`);
    }
  });

  it('errors when Minimum is not below Maximum, rather than answering', async () => {
    // pwsh: MinGreaterThanOrEqualMax,Microsoft.PowerShell.Commands.GetRandomCommand
    //       InvalidArgument / System.ArgumentException
    //       "The Minimum value (5) cannot be greater than or equal to the Maximum value (5)."
    for (const [minimum, maximum] of [[5, 5], [5, 4], [0, 0]] as const) {
      const result = await run(getRandom, { Minimum: minimum, Maximum: maximum });
      assert.deepEqual(result.values, []);
      assert.equal(
        result.errors[0]?.fullyQualifiedErrorId,
        'MinGreaterThanOrEqualMax,Microsoft.PowerShell.Commands.GetRandomCommand',
      );
      assert.equal(result.errors[0]?.category, 'InvalidArgument');
      assert.equal(result.errors[0]?.exceptionType, 'System.ArgumentException');
      assert.equal(
        result.errors[0]?.message,
        `The Minimum value (${String(minimum)}) cannot be greater than or equal to the ` +
          `Maximum value (${String(maximum)}).`,
      );
    }
  });

  it('defaults to [0, [int]::MaxValue)', async () => {
    // pwsh: from the same seed, `Get-Random` and
    //       `Get-Random -Maximum ([int]::MaxValue)` both gave 988011271.
    const bare = await run(getRandom, {}, [], {});
    const explicit = await run(getRandom, { Maximum: 2147483647 });
    const a = bare.values[0] as number;
    const b = explicit.values[0] as number;
    assert.ok(Number.isInteger(a) && a >= 0 && a < 2147483647);
    assert.ok(Number.isInteger(b) && b >= 0 && b < 2147483647);
  });

  it('EMITS a value when -SetSeed is given, and replays', async () => {
    // pwsh: Get-Random -SetSeed 1 -> 42389573, twice.
    const first = await run(getRandom, { SetSeed: 7, Minimum: 0, Maximum: 1000 });
    const second = await run(getRandom, { SetSeed: 7, Minimum: 0, Maximum: 1000 });
    assert.equal(first.values.length, 1);
    assert.deepEqual(first.values, second.values);
  });

  it('picks from -InputObject without replacement, capped at the list length', async () => {
    // pwsh: Get-Random -InputObject 'a','b','c' -Count 5 -> three items, one each
    const result = await run(getRandom, { InputObject: ['a', 'b', 'c'], Count: 5 });
    assert.equal(result.values.length, 3);
    assert.deepEqual([...result.values].sort(), ['a', 'b', 'c']);
  });

  it('picks one item by default from a list', async () => {
    // pwsh: Get-Random -InputObject 'a','b','c' -> one item
    const result = await run(getRandom, { InputObject: ['a', 'b', 'c'] });
    assert.equal(result.values.length, 1);
    assert.ok(['a', 'b', 'c'].includes(result.values[0] as string));
  });

  it('shuffles the whole list for -Shuffle', async () => {
    // pwsh: Get-Random -InputObject 1,2,3,4,5 -Shuffle -> all five, reordered
    const result = await run(getRandom, { InputObject: [1, 2, 3, 4, 5], Shuffle: true });
    assert.equal(result.values.length, 5);
    assert.deepEqual([...(result.values as number[])].sort((x, y) => x - y), [1, 2, 3, 4, 5]);
  });

  it('emits -Count independent numbers for a numeric range', async () => {
    // pwsh: Get-Random -Minimum 0 -Maximum 100 -Count 3 -> 63, 7, 43
    const result = await run(getRandom, { Minimum: 0, Maximum: 100, Count: 3 });
    assert.equal(result.values.length, 3);
    for (const value of result.values) {
      assert.ok(Number.isInteger(value) && (value as number) >= 0 && (value as number) < 100);
    }
  });

  it('gives a Double for double bounds and an Int32 for integer bounds', async () => {
    // pwsh: (Get-Random -Minimum 1 -Maximum 10).GetType()      -> System.Int32
    //       (Get-Random -Minimum 1.0 -Maximum 10.0).GetType()  -> System.Double
    const whole = await run(getRandom, { Minimum: 1, Maximum: 10 });
    assert.ok(Number.isInteger(whole.values[0] as number));
    const fractional = await run(getRandom, { Minimum: 1.5, Maximum: 2.5 });
    const value = fractional.values[0] as number;
    assert.ok(value >= 1.5 && value < 2.5);
  });

  it('picks from pipeline input', async () => {
    // pwsh: 'a','b','c' | Get-Random -> one of them
    const result = await run(getRandom, {}, ['a', 'b', 'c']);
    assert.equal(result.values.length, 1);
    assert.ok(['a', 'b', 'c'].includes(result.values[0] as string));
  });
});

// ---------------------------------------------------------------------------
// New-Guid
// ---------------------------------------------------------------------------

describe('New-Guid', () => {
  it('emits a System.Guid in canonical form', async () => {
    // pwsh: (New-Guid).GetType().FullName -> System.Guid; "$(New-Guid)".Length -> 36
    const result = await run(need('new-guid'));
    assert.deepEqual(typeNamesOf(result.values[0]), [
      'System.Guid', 'System.ValueType', 'System.Object',
    ]);
    const text = prop(result.values[0], 'Guid') as string;
    assert.match(text, /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/);
    assert.equal(text.length, 36);
  });

  it('follows the newGuid.defaultVersion behaviour flag, never a version check', async () => {
    // pwsh 7.6.5: (New-Guid).ToString().Substring(14,1) -> 4
    // The 7.7 profile declares newGuid.defaultVersion = 7 (upstream PR 27033).
    const v4 = await run(need('new-guid'), {}, [], { behaviors: { [NEW_GUID_VERSION_KEY]: 4 } });
    assert.equal((prop(v4.values[0], 'Guid') as string).charAt(14), '4');

    const v7 = await run(need('new-guid'), {}, [], {
      behaviors: { [NEW_GUID_VERSION_KEY]: 7 },
      displayVersion: '7.7.0-preview.4',
    });
    assert.equal((prop(v7.values[0], 'Guid') as string).charAt(14), '7');
  });

  it('stamps the RFC 4122 variant nibble', () => {
    // pwsh: (New-Guid).ToString().Substring(19,1) is one of 8 9 a b
    const random = seededRandom(99);
    for (let i = 0; i < 50; i += 1) {
      const text = guidText(4, random, 0);
      assert.ok('89ab'.includes(text.charAt(19)), `variant nibble was ${text.charAt(19)}`);
    }
  });

  it('makes v7 GUIDs sort by creation time as strings, which is the point of the change', () => {
    const random = seededRandom(5);
    const early = guidText(7, random, Date.parse('2026-01-01T00:00:00Z'));
    const later = guidText(7, random, Date.parse('2026-06-01T00:00:00Z'));
    assert.ok(early < later, `${early} should sort before ${later}`);
  });

  it('returns Guid.Empty for -Empty', async () => {
    const result = await run(need('new-guid'), { Empty: true });
    assert.equal(prop(result.values[0], 'Guid'), EMPTY_GUID);
  });

  it('is deterministic under a seeded source', () => {
    assert.equal(guidText(4, seededRandom(3), 0), guidText(4, seededRandom(3), 0));
  });
});

// ---------------------------------------------------------------------------
// Get-Location
// ---------------------------------------------------------------------------

describe('Get-Location', () => {
  it('emits a PathInfo whose Path is the working directory verbatim', async () => {
    // pwsh: (Get-Location).GetType().FullName -> System.Management.Automation.PathInfo
    //       properties, in order -> Drive, Provider, ProviderPath, Path
    const result = await run(need('get-location'), {}, [], { cwd: '/home/thc1006/work' });
    assert.deepEqual(typeNamesOf(result.values[0]), [
      'System.Management.Automation.PathInfo', 'System.Object',
    ]);
    assert.deepEqual(Object.keys((result.values[0] as { properties: object }).properties), [
      'Drive', 'Provider', 'ProviderPath', 'Path',
    ]);
    assert.equal(prop(result.values[0], 'Path'), '/home/thc1006/work');
    assert.equal(prop(result.values[0], 'ProviderPath'), '/home/thc1006/work');
  });

  it('describes the FileSystem provider and the drive', () => {
    // pwsh: (Get-Location).Provider.Name -> FileSystem
    //       (Get-Location).Drive.Root    -> the root of the drive
    //       (Get-Location).Drive.CurrentLocation -> the path relative to Root
    const info = pathInfo('/home/thc1006/work');
    const provider = prop(info, 'Provider');
    assert.equal(prop(provider, 'Name'), 'FileSystem');
    assert.equal(prop(provider, 'ItemSeparator'), '/');
    const drive = prop(info, 'Drive');
    assert.equal(prop(drive, 'Name'), '/');
    assert.equal(prop(drive, 'Root'), '/');
    assert.equal(prop(drive, 'CurrentLocation'), 'home/thc1006/work');
  });

  it('derives the drive from a Windows-shaped path too', () => {
    // The conformance probe hands this a real host path so the capture's
    // machine-path rule can match it; a hardcoded '/' would report nonsense.
    const info = pathInfo('C:\\Users\\thc1006\\repo');
    assert.equal(prop(info, 'Path'), 'C:\\Users\\thc1006\\repo');
    assert.equal(prop(prop(info, 'Drive'), 'Name'), 'C');
    assert.equal(prop(prop(info, 'Drive'), 'Root'), 'C:\\');
    assert.equal(prop(prop(info, 'Provider'), 'ItemSeparator'), '\\');
  });
});

// ---------------------------------------------------------------------------
// Get-Command
// ---------------------------------------------------------------------------

describe('Get-Command', () => {
  const getCommand = need('get-command');

  it('emits CmdletInfo with the columns the default table shows', async () => {
    // pwsh: (Get-Command Get-Date).PSObject.TypeNames
    //       -> CmdletInfo | CommandInfo | System.Object
    //       default table -> CommandType | Name | Version | Source
    const result = await run(getCommand, { Name: 'Get-Date' });
    assert.equal(result.values.length, 1);
    assert.deepEqual(typeNamesOf(result.values[0]), [
      'System.Management.Automation.CmdletInfo',
      'System.Management.Automation.CommandInfo',
      'System.Object',
    ]);
    assert.equal(prop(result.values[0], 'Name'), 'Get-Date');
    assert.equal(prop(result.values[0], 'CommandType'), 'Cmdlet');
  });

  it('reports an alias as AliasInfo under its own name', async () => {
    // pwsh: (Get-Command gcm).GetType() -> AliasInfo
    //       (Get-Command gcm).Name -> gcm
    //       (Get-Command gcm).DisplayName -> "gcm -> Get-Command"
    const result = await run(getCommand, { Name: 'gcm' });
    assert.deepEqual(typeNamesOf(result.values[0]), [
      'System.Management.Automation.AliasInfo',
      'System.Management.Automation.CommandInfo',
      'System.Object',
    ]);
    assert.equal(prop(result.values[0], 'Name'), 'gcm');
    assert.equal(prop(result.values[0], 'CommandType'), 'Alias');
    assert.equal(prop(result.values[0], 'ResolvedCommandName'), 'Get-Command');
    assert.equal(prop(result.values[0], 'DisplayName'), 'gcm -> Get-Command');
  });

  it('errors for an exact name that matches nothing', async () => {
    // pwsh: CommandNotFoundException,Microsoft.PowerShell.Commands.GetCommandCommand
    //       ObjectNotFound / System.Management.Automation.CommandNotFoundException
    const result = await run(getCommand, { Name: 'zzz-nope' });
    assert.deepEqual(result.values, []);
    assert.equal(
      result.errors[0]?.fullyQualifiedErrorId,
      'CommandNotFoundException,Microsoft.PowerShell.Commands.GetCommandCommand',
    );
    assert.equal(result.errors[0]?.category, 'ObjectNotFound');
    assert.equal(result.exitCode, 1);
  });

  it('returns nothing and NO error for a wildcard that matches nothing', async () => {
    // pwsh: @(Get-Command 'zzz-nope*').Count -> 0, no error raised
    const result = await run(getCommand, { Name: 'zzz-nope*' });
    assert.deepEqual(result.values, []);
    assert.deepEqual(result.errors, []);
    assert.equal(result.exitCode, 0);
  });

  it('keeps the requested order for several exact names', async () => {
    // pwsh: (Get-Command 'Get-Random','Get-Date','Get-Location').Name
    //       -> Get-Random | Get-Date | Get-Location
    const result = await run(getCommand, { Name: ['Get-Random', 'Get-Date', 'Get-Location'] });
    assert.deepEqual(column(result.values, 'Name'), ['Get-Random', 'Get-Date', 'Get-Location']);
  });

  it('filters by -CommandType and by -Verb/-Noun', async () => {
    const aliasOnly = await run(getCommand, { Name: 'g*', CommandType: 'Alias' });
    assert.ok(aliasOnly.values.length > 0);
    for (const value of aliasOnly.values) assert.equal(prop(value, 'CommandType'), 'Alias');

    const byVerbNoun = await run(getCommand, { Verb: 'Get', Noun: 'Random' });
    assert.deepEqual(column(byVerbNoun.values, 'Name'), ['Get-Random']);
  });

  it('caps the result with -TotalCount', async () => {
    const result = await run(getCommand, { Name: 'Get-*', TotalCount: 3 });
    assert.equal(result.values.length, 3);
  });

  it('emits a syntax string for -Syntax', async () => {
    // pwsh: (Get-Command Get-Random -Syntax).GetType().FullName -> System.String
    const result = await run(getCommand, { Name: 'Get-Location', Syntax: true });
    assert.equal(typeof result.values[0], 'string');
    assert.match(result.values[0] as string, /^Get-Location /);
    assert.match(result.values[0] as string, /\[<CommonParameters>\]$/);
  });

  it('surfaces fidelity, capabilities and notes for -Detailed', async () => {
    // -Detailed is an EXTENSION. pwsh has no such parameter and does not reject
    // one either: Get-Command -ArgumentList is ValueFromRemainingArguments, so
    // `Get-Command Get-Date -Detailed` silently returns Get-Date there.
    const result = await run(getCommand, { Name: 'Get-Date', Detailed: true });
    assert.deepEqual(typeNamesOf(result.values[0]), [
      'BrowserShell.CommandFidelityInfo', 'System.Object',
    ]);
    assert.equal(prop(result.values[0], 'Fidelity'), 'native-semantic');
    assert.equal(prop(result.values[0], 'Badge'), 'SEMANTIC');
    assert.equal(prop(result.values[0], 'Risk'), 'read');

    // The point of the feature: a simulated command says so.
    const ping = await run(getCommand, { Name: 'ping', Detailed: true });
    assert.equal(prop(ping.values[0], 'Fidelity'), 'simulated');
    assert.equal(prop(ping.values[0], 'Badge'), 'SIMULATED');
    assert.ok(String(prop(ping.values[0], 'Notes')).length > 0);
  });

  it('reports the capabilities a command declares', async () => {
    const result = await run(getCommand, { Name: 'Clear-Host', Detailed: true });
    assert.deepEqual(prop(result.values[0], 'Capabilities'), ['terminal.control']);
  });

  it('builds a syntax line from the declared parameters', () => {
    const module = need('get-location');
    const syntax = syntaxOf(module.manifest, 'Get-Location');
    assert.equal(
      syntax,
      'Get-Location [-PSProvider <string[]>] [-PSDrive <string[]>] [-Stack] ' +
        '[-StackName <string[]>] [<CommonParameters>]',
    );
  });

  it('builds it from what BINDS, not from what upstream declares', () => {
    // The generated manifest's `parameters` describe pwsh, so the syntax line
    // for Sort-Object used to offer -Top, -Bottom and -Culture. Measured, this
    // engine binds six of upstream's nine, and the binder answers
    // NamedParameterNotFound for the other three -- a syntax line that offers
    // them is an instruction to produce an error.
    const declared = MANIFEST_OF('sort-object');
    const syntax = syntaxOf(declared, 'Sort-Object');
    for (const upstreamOnly of ['-Top', '-Bottom', '-Culture']) {
      assert.ok(!syntax.includes(upstreamOnly), `${upstreamOnly} must not be offered`);
    }
    for (const ours of ['-Descending', '-Stable', '-Unique']) {
      assert.ok(syntax.includes(ours), `${ours} must be offered`);
    }
    // And a BrowserShell extension upstream has never had is still offered,
    // because the command really does bind it. `-Detailed` on Get-Command used
    // to vanish here: captured metadata replaced the module's declaration.
    assert.ok(syntaxOf(MANIFEST_OF('get-command'), 'Get-Command').includes('-Detailed'));
  });
});

// ---------------------------------------------------------------------------
// Get-Help
// ---------------------------------------------------------------------------

describe('Get-Help says what runs, and names what does not', () => {
  it('documents the parameters the binder accepts', () => {
    // Help that documents a parameter the binder rejects is worse than help
    // that omits it: the omission is a gap, the documentation is a wrong
    // instruction.
    const info = helpInfo(
      { manifest: MANIFEST_OF('sort-object'), commandType: 'Cmdlet' },
      HELP_INFO_TYPE_NAMES,
    );
    const names = (info.properties['parameters'] as readonly PSObject[]).map((p) =>
      String(p.properties['name']),
    );
    assert.ok(names.includes('Descending'));
    assert.ok(names.includes('Stable'));
    for (const upstreamOnly of ['Top', 'Bottom', 'Culture']) {
      assert.ok(!names.includes(upstreamOnly), `-${upstreamOnly} must not be documented`);
    }
  });

  it('names the upstream parameters it does not accept, in NOTES', () => {
    // Filtering alone leaves a user who knows `Sort-Object -Top 5` to discover
    // the gap as a parse error. NOTES is where pwsh puts this kind of remark.
    const info = helpInfo(
      { manifest: MANIFEST_OF('sort-object'), commandType: 'Cmdlet' },
      HELP_INFO_TYPE_NAMES,
    );
    const alert = String(info.properties['alertSet']);
    assert.match(alert, /NOT accepted here/u);
    assert.match(alert, /-Top/u);
    assert.match(alert, /-Bottom/u);
    assert.match(alert, /-Culture/u);
  });

  it('reports a partial implementation as partial', () => {
    // Where-Object is declared, built, and not registered. Help still describes
    // it -- a visitor asking why it is unavailable has to get an answer -- and
    // the status is part of that answer.
    const info = helpInfo(
      { manifest: MANIFEST_OF('where-object'), commandType: 'Cmdlet' },
      HELP_INFO_TYPE_NAMES,
    );
    assert.match(String(info.properties['alertSet']), /Implementation: partial/u);
  });
});

describe('Get-Help', () => {
  const getHelp = need('get-help');

  it('changes only the TYPE NAME for -Full, -Detailed and -Examples', async () => {
    // pwsh, for a command with no MAML help file — which is what all of ours are:
    //   default   ExtendedCmdletHelpInfo,CmdletHelpInfo,HelpInfo
    //   -Full     ExtendedCmdletHelpInfo#FullView,CmdletHelpInfo#FullView,
    //             HelpInfo#FullView,ExtendedCmdletHelpInfo,CmdletHelpInfo,HelpInfo
    //   -Detailed / -Examples the same with #DetailedView / #ExamplesView
    // EVERY base name gains a twin — six entries, not two. The PROPERTY SET is
    // identical in all four, which is exactly this project's pipeline design.
    const plain = await run(getHelp, { Name: 'Get-Date' });
    const full = await run(getHelp, { Name: 'Get-Date', Full: true });
    const detailed = await run(getHelp, { Name: 'Get-Date', Detailed: true });
    const examples = await run(getHelp, { Name: 'Get-Date', Examples: true });

    const base = ['ExtendedCmdletHelpInfo', 'CmdletHelpInfo', 'HelpInfo'];
    assert.deepEqual(typeNamesOf(plain.values[0]), base);
    assert.deepEqual(typeNamesOf(full.values[0]), [
      'ExtendedCmdletHelpInfo#FullView', 'CmdletHelpInfo#FullView', 'HelpInfo#FullView', ...base,
    ]);
    assert.deepEqual(typeNamesOf(detailed.values[0]), [
      'ExtendedCmdletHelpInfo#DetailedView', 'CmdletHelpInfo#DetailedView',
      'HelpInfo#DetailedView', ...base,
    ]);
    assert.deepEqual(typeNamesOf(examples.values[0]), [
      'ExtendedCmdletHelpInfo#ExamplesView', 'CmdletHelpInfo#ExamplesView',
      'HelpInfo#ExamplesView', ...base,
    ]);

    const keys = (value: PSValue | undefined): readonly string[] =>
      Object.keys((value as { properties: Record<string, PSValue> }).properties);
    assert.deepEqual(keys(plain.values[0]), keys(full.values[0]));
    assert.deepEqual(keys(plain.values[0]), keys(detailed.values[0]));
    assert.deepEqual(keys(plain.values[0]), keys(examples.values[0]));
  });

  it('carries the members pwsh puts on a help object, in its order', async () => {
    // pwsh, for auto-generated help:
    //   CommonParameters,details,Syntax,parameters,inputTypes,relatedLinks,
    //   returnValues,aliases,remarks,PSSnapIn,alertSet,description,examples,
    //   Synopsis,ModuleName,nonTerminatingErrors,xmlns:command,xmlns:dev,
    //   xmlns:maml,Name,Category,Component,Role,Functionality
    // PSSnapIn and the three xmlns:* are deliberately absent: there is no
    // snap-in, and this help is built from manifests rather than from MAML.
    const result = await run(getHelp, { Name: 'Get-Date' });
    assert.deepEqual(
      Object.keys((result.values[0] as { properties: object }).properties),
      [
        'CommonParameters', 'details', 'Syntax', 'parameters', 'inputTypes', 'relatedLinks',
        'returnValues', 'aliases', 'remarks', 'alertSet', 'description', 'examples', 'Synopsis',
        'ModuleName', 'nonTerminatingErrors', 'Name', 'Category', 'Component', 'Role',
        'Functionality',
      ],
    );
    assert.equal(prop(result.values[0], 'Name'), 'Get-Date');
    assert.equal(prop(result.values[0], 'Category'), 'Cmdlet');
  });

  it('resolves an alias to its target, as pwsh does', async () => {
    // pwsh: (Get-Help gcm).Name -> Get-Command
    const result = await run(getHelp, { Name: 'gcm' });
    assert.equal(prop(result.values[0], 'Name'), 'Get-Command');
  });

  it('puts the fidelity in the NOTES section', async () => {
    const result = await run(getHelp, { Name: 'ping' });
    const alert = String(prop(result.values[0], 'alertSet'));
    assert.match(alert, /Fidelity: simulated/);
    assert.match(alert, /Risk: /);
  });

  it('errors with HelpNotFound for a name that matches nothing', async () => {
    // pwsh: HelpNotFound,Microsoft.PowerShell.Commands.GetHelpCommand
    //       ResourceUnavailable / Microsoft.PowerShell.Commands.HelpNotFoundException
    const result = await run(getHelp, { Name: 'zzz-nope' });
    assert.deepEqual(result.values, []);
    assert.equal(
      result.errors[0]?.fullyQualifiedErrorId,
      'HelpNotFound,Microsoft.PowerShell.Commands.GetHelpCommand',
    );
    assert.equal(result.errors[0]?.category, 'ResourceUnavailable');
    assert.equal(
      result.errors[0]?.exceptionType,
      'Microsoft.PowerShell.Commands.HelpNotFoundException',
    );
  });

  it('matches many for a wildcard, with no error', async () => {
    // pwsh: Get-Help 'Get-Wi*' returned every match, no error
    const result = await run(getHelp, { Name: 'Get-C*' });
    assert.ok(result.values.length > 1);
    assert.deepEqual(result.errors, []);
  });

  it('returns the parameter descriptor for -Parameter', async () => {
    // pwsh: (Get-Help Get-Random -Parameter Count).PSObject.TypeNames
    //       -> ExtendedCmdletHelpInfo#parameter
    //   members: name required pipelineInput isDynamic globbing parameterSetName
    //            parameterValue type position aliases
    //   values : required/globbing/isDynamic are STRINGS, position is `Named`
    //            with a capital N, aliases is the string `None`, and
    //            parameterValue is the friendly type name (`int`, not Int32).
    const result = await run(getHelp, { Name: 'Get-Location', Parameter: 'Stack' });
    assert.deepEqual(typeNamesOf(result.values[0]), ['ExtendedCmdletHelpInfo#parameter']);
    assert.deepEqual(Object.keys((result.values[0] as { properties: object }).properties), [
      'name', 'required', 'pipelineInput', 'isDynamic', 'globbing', 'parameterSetName',
      'parameterValue', 'type', 'position', 'aliases',
    ]);
    // pwsh: Get-Location -Stack ->
    //   setName=[Stack] value=[] position=[Named] required=[false] aliases=[None]
    // parameterValue is EMPTY for a switch while type.name is `switch`; the two
    // members genuinely disagree.
    assert.equal(prop(result.values[0], 'name'), 'Stack');
    assert.equal(prop(result.values[0], 'parameterValue'), '');
    assert.equal(prop(prop(result.values[0], 'type'), 'name'), 'switch');
    assert.equal(prop(result.values[0], 'required'), 'false');
    assert.equal(prop(result.values[0], 'position'), 'Named');
    assert.equal(prop(result.values[0], 'aliases'), 'None');
    assert.equal(prop(result.values[0], 'parameterSetName'), 'Stack');

    // pwsh: Get-Location -PSProvider -> setName=[Location] value=[string[]].
    // The set names come from the captured metadata, not from a flattened
    // single set, which is why they are the REAL ones.
    const named = await run(getHelp, { Name: 'Get-Location', Parameter: 'PSProvider' });
    assert.equal(prop(named.values[0], 'parameterValue'), 'string[]');
    assert.equal(prop(named.values[0], 'parameterSetName'), 'Location');
    assert.equal(prop(named.values[0], 'position'), 'Named');
  });
});

// ---------------------------------------------------------------------------
// Get-History
// ---------------------------------------------------------------------------

describe('Get-History', () => {
  const getHistory = need('get-history');

  it('emits HistoryInfo with pwsh\'s property set and order', async () => {
    // pwsh: typeNames -> Microsoft.PowerShell.Commands.HistoryInfo | System.Object
    //       properties -> Id CommandLine ExecutionStatus StartExecutionTime
    //                     EndExecutionTime Duration
    const result = await run(getHistory);
    assert.equal(result.values.length, 2);
    assert.deepEqual(typeNamesOf(result.values[0]), [
      'Microsoft.PowerShell.Commands.HistoryInfo', 'System.Object',
    ]);
    assert.deepEqual(Object.keys((result.values[0] as { properties: object }).properties), [
      'Id', 'CommandLine', 'ExecutionStatus', 'StartExecutionTime', 'EndExecutionTime', 'Duration',
    ]);
    assert.deepEqual(column(result.values, 'Id'), [1, 2]);
    assert.deepEqual(column(result.values, 'CommandLine'), ['Get-Date', 'Get-Location']);
    assert.equal(prop(result.values[0], 'ExecutionStatus'), 'Completed');
  });

  it('derives Duration from the two timestamps', async () => {
    // pwsh: an entry one second long reports Duration 00:00:01
    const result = await run(getHistory);
    assert.equal(prop(prop(result.values[0], 'Duration'), 'TotalSeconds'), 1);
  });

  it('returns the MOST RECENT entries for -Count, not the first', async () => {
    // pwsh: with [Get-Date, Get-Location] in the history,
    //       (Get-History -Count 1).CommandLine -> Get-Location
    const result = await run(getHistory, { Count: 1 });
    assert.deepEqual(column(result.values, 'CommandLine'), ['Get-Location']);
  });

  it('returns nothing for -Count 0', async () => {
    // pwsh: @(Get-History -Count 0).Count -> 0
    const result = await run(getHistory, { Count: 0 });
    assert.deepEqual(result.values, []);
  });

  it('errors for an unknown -Id', async () => {
    // pwsh: GetHistoryNoHistoryForId,Microsoft.PowerShell.Commands.GetHistoryCommand
    //       ObjectNotFound / System.ArgumentException
    //       "Cannot locate the history for Id 99."
    const result = await run(getHistory, { Id: 99 });
    assert.deepEqual(result.values, []);
    assert.equal(
      result.errors[0]?.fullyQualifiedErrorId,
      'GetHistoryNoHistoryForId,Microsoft.PowerShell.Commands.GetHistoryCommand',
    );
    assert.equal(result.errors[0]?.category, 'ObjectNotFound');
    assert.equal(result.errors[0]?.message, 'Cannot locate the history for Id 99.');
  });

  it('selects by -Id', async () => {
    // pwsh: (Get-History -Id 1).CommandLine -> Get-Date
    const result = await run(getHistory, { Id: 1 });
    assert.deepEqual(column(result.values, 'CommandLine'), ['Get-Date']);
  });

  it('reads whatever history the session injects', async () => {
    const empty = commandsFor({ history: historyOf([]) }).get('get-history');
    assert.ok(empty !== undefined);
    const result = await run(empty);
    assert.deepEqual(result.values, []);
    assert.equal(TEST_HISTORY.length, 2);
  });
});

// ---------------------------------------------------------------------------
// Write-Output and Out-Null
// ---------------------------------------------------------------------------

describe('Write-Output', () => {
  const writeOutput = need('write-output');

  it('unrolls an array, and does not with -NoEnumerate', async () => {
    // pwsh: @(Write-Output @(1,2,3)).Count               -> 3
    //       @(Write-Output @(1,2,3) -NoEnumerate).Count  -> 1, System.Object[]
    const enumerated = await run(writeOutput, { InputObject: [1, 2, 3] });
    assert.deepEqual(enumerated.values, [1, 2, 3]);
    const whole = await run(writeOutput, { InputObject: [1, 2, 3], NoEnumerate: true });
    assert.equal(whole.values.length, 1);
    assert.deepEqual(whole.values[0], [1, 2, 3]);
  });

  it('does NOTHING to pipeline input when -NoEnumerate is given', async () => {
    // pwsh: @(1,2,3 | Write-Output -NoEnumerate).Count -> 3, not 1.
    // -NoEnumerate suppresses unrolling of the -InputObject VALUE; pipeline
    // binding has already delivered three separate objects.
    const result = await run(writeOutput, { NoEnumerate: true }, [1, 2, 3]);
    assert.deepEqual(result.values, [1, 2, 3]);
  });

  it('unrolls ONE level, leaving a nested array intact', async () => {
    // pwsh: @(Write-Output @(1,@(2,3))) | ForEach-Object { $_.GetType().Name }
    //       -> Int32, Object[]
    const result = await run(writeOutput, { InputObject: [1, [2, 3]] });
    assert.equal(result.values.length, 2);
    assert.equal(result.values[0], 1);
    assert.deepEqual(result.values[1], [2, 3]);
  });

  it('passes $null through, unlike Select-Object', async () => {
    // pwsh: @(Write-Output $null).Count -> 1
    const result = await run(writeOutput, { InputObject: null });
    assert.deepEqual(result.values, [null]);
  });

  it('preserves the type names of what it is handed', async () => {
    // pwsh: (Write-Output ([pscustomobject]@{A=1})).PSObject.TypeNames
    //       -> System.Management.Automation.PSCustomObject | System.Object
    const source = psObject({ A: 1 });
    const result = await run(writeOutput, { InputObject: source });
    assert.deepEqual(typeNamesOf(result.values[0]), [
      'System.Management.Automation.PSCustomObject', 'System.Object',
    ]);
  });
});

describe('Out-Null', () => {
  const outNullModule = need('out-null');

  it('emits nothing', async () => {
    // pwsh: @(1,2,3 | Out-Null).Count -> 0
    const result = await run(outNullModule, {}, [1, 2, 3]);
    assert.deepEqual(result.values, []);
    assert.equal(result.exitCode, 0);
  });

  it('discards stream 1 ONLY', async () => {
    // pwsh: an ErrorVariable still fills in behind an Out-Null.
    const emitter = {
      manifest: need('write-output').manifest,
      async invoke(context: Parameters<typeof outNullModule.invoke>[0]): Promise<number> {
        await context.streams.success.write('kept quiet');
        await context.streams.error.write(errorRecord('loud', 'X', 'test'));
        return 0;
      },
    };
    const result = await runChain([], [[emitter, {}], [outNullModule, {}]]);
    assert.deepEqual(result.values, []);
    assert.equal(result.errors.length, 1);
    assert.equal(result.errors[0]?.message, 'loud');
  });

  it('drains its input rather than abandoning the upstream', async () => {
    // A stage that returned without reading would park the producer forever.
    const seen: PSValue[] = [];
    const source = {
      manifest: need('write-output').manifest,
      async invoke(context: Parameters<typeof outNullModule.invoke>[0]): Promise<number> {
        for (const value of [1, 2, 3, 4, 5]) {
          seen.push(value);
          await context.streams.success.write(value);
        }
        return 0;
      },
    };
    await runChain([], [[source, {}], [outNullModule, {}]]);
    assert.deepEqual(seen, [1, 2, 3, 4, 5]);
  });
});

// ---------------------------------------------------------------------------
// Clear-Host
// ---------------------------------------------------------------------------

describe('Clear-Host', () => {
  it('asks the broker before clearing, and emits nothing', async () => {
    const services = testServices();
    const module = commandsFor({ terminal: services.terminal }).get('clear-host');
    assert.ok(module !== undefined);
    const result = await run(module, {}, [], { granted: ['terminal.control'] });
    assert.deepEqual(result.values, []);
    assert.equal(services.terminal.clears, 1);
  });

  it('declares terminal.control', () => {
    const module = need('clear-host');
    assert.deepEqual(module.manifest.capabilities, ['terminal.control']);
    assert.deepEqual([...module.manifest.aliases], ['clear', 'cls']);
  });

  it('does not clear when the capability is withheld', async () => {
    const services = testServices();
    const module = commandsFor({ terminal: services.terminal }).get('clear-host');
    assert.ok(module !== undefined);
    await assert.rejects(
      () => run(module, {}, [], { granted: [] }),
      (error: unknown) => error instanceof CapabilityDeniedError,
    );
    assert.equal(services.terminal.clears, 0);
  });
});

// ---------------------------------------------------------------------------
// $PSVersionTable
// ---------------------------------------------------------------------------

describe('$PSVersionTable', () => {
  it('carries the keys pwsh reports, in pwsh\'s order', async () => {
    // pwsh: $PSVersionTable.Keys ->
    //   PSVersion PSEdition GitCommitId OS Platform PSCompatibleVersions
    //   PSRemotingProtocolVersion SerializationVersion WSManStackVersion
    const result = await run(need('$psversiontable'));
    assert.deepEqual(typeNamesOf(result.values[0]), [
      'System.Management.Automation.PSVersionHashTable',
      'System.Collections.Hashtable',
      'System.Object',
    ]);
    assert.deepEqual(Object.keys((result.values[0] as { properties: object }).properties), [
      'PSVersion', 'PSEdition', 'GitCommitId', 'OS', 'Platform', 'PSCompatibleVersions',
      'PSRemotingProtocolVersion', 'SerializationVersion', 'WSManStackVersion',
    ]);
    assert.equal(prop(result.values[0], 'PSEdition'), 'Core');
  });

  it('takes the version from the profile, never from a literal', async () => {
    const seventySix = await run(need('$psversiontable'), {}, [], { displayVersion: '7.6.5' });
    assert.equal(prop(prop(seventySix.values[0], 'PSVersion'), 'Major'), 7);
    assert.equal(prop(prop(seventySix.values[0], 'PSVersion'), 'Minor'), 6);
    assert.equal(prop(prop(seventySix.values[0], 'PSVersion'), 'Patch'), 5);

    const preview = await run(need('$psversiontable'), {}, [], {
      displayVersion: '7.7.0-preview.4',
    });
    assert.equal(prop(prop(preview.values[0], 'PSVersion'), 'Patch'), 0);
    assert.equal(prop(prop(preview.values[0], 'PSVersion'), 'PreReleaseLabel'), 'preview.4');
  });

  it('checks GitCommitId against the release lock', () => {
    // pwsh reports the version string for an official build, and the lock is
    // consulted so an unknown version cannot pass unnoticed.
    assert.equal(gitCommitIdFor('7.6.5'), '7.6.5');
    assert.equal(gitCommitIdFor('7.7.0-preview.4'), '7.7.0-preview.4');
    assert.match(gitCommitIdFor('9.9.9'), /no release for 9\.9\.9 in releases\.lock\.json/);
  });

  it('reports the simulated machine, and says which fields those are', () => {
    const table = psVersionTable('7.6.5', SIMULATED_MACHINE);
    assert.equal(table.properties['OS'], SIMULATED_MACHINE.os);
    assert.equal(table.properties['Platform'], 'Unix');
  });

  it('lists PSCompatibleVersions as Version objects', async () => {
    // pwsh: 1.0 2.0 3.0 4.0 5.0 5.1 6.0 7.0
    const result = await run(need('$psversiontable'));
    const versions = prop(result.values[0], 'PSCompatibleVersions') as readonly PSValue[];
    assert.equal(versions.length, 8);
    assert.deepEqual(typeNamesOf(versions[0]), ['System.Version', 'System.Object']);
    assert.equal(prop(versions[5], 'Major'), 5);
    assert.equal(prop(versions[5], 'Minor'), 1);
  });
});

// ---------------------------------------------------------------------------
// help
// ---------------------------------------------------------------------------

describe('help', () => {
  it('emits grouped rows rather than lines', async () => {
    const result = await run(need('help'));
    assert.ok(result.values.length > 10);
    assert.deepEqual(typeNamesOf(result.values[0]), [
      'BrowserShell.QuickStartEntry', 'System.Object',
    ]);
    const groups = new Set(column(result.values, 'Group').map(String));
    assert.ok(groups.has('Portfolio'));
    assert.ok(groups.has('Honesty'));
  });

  it('names only commands the catalogue actually has', () => {
    // The guide is the first thing a visitor reads. Naming a command that does
    // not exist is the same drift the generated inventory exists to prevent, so
    // every row is checked against the catalogue rather than trusted.
    const known = new Set<string>();
    for (const entry of defaultCatalogue([NEW_GUID_MANIFEST]).all()) {
      known.add(entry.manifest.name);
      known.add(entry.manifest.display.toLowerCase());
      for (const alias of entry.manifest.aliases) known.add(alias.toLowerCase());
    }
    for (const row of quickStartRows()) {
      // `Get-Command -Detailed` and `Get-Help <command>` name a command plus an
      // example argument; the command is the first token.
      const named = String(row.properties['Command']).split(' ')[0]?.toLowerCase() ?? '';
      assert.ok(known.has(named), `help names ${named}, which the catalogue does not have`);
    }
  });
});

// ---------------------------------------------------------------------------
// determinism
// ---------------------------------------------------------------------------

describe('the injected services', () => {
  it('make every clock-reading command reproducible', async () => {
    const first = commandsFor({ clock: fixedClock(TEST_INSTANT, 480) }).get('get-date');
    const second = commandsFor({ clock: fixedClock(TEST_INSTANT, 480) }).get('get-date');
    assert.ok(first !== undefined && second !== undefined);
    const a = await run(first, { Format: 'o' });
    const b = await run(second, { Format: 'o' });
    assert.deepEqual(a.values, b.values);
  });

  it('make every entropy-reading command reproducible', async () => {
    const first = commandsFor({ guidRandom: seededRandom(11) }).get('new-guid');
    const second = commandsFor({ guidRandom: seededRandom(11) }).get('new-guid');
    assert.ok(first !== undefined && second !== undefined);
    const a = await run(first);
    const b = await run(second);
    assert.deepEqual(prop(a.values[0], 'Guid'), prop(b.values[0], 'Guid'));
  });
});
