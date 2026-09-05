/**
 * The four formatting cmdlets, driven through the real pipeline.
 *
 * format-render.test.mts checks the TEXT byte for byte. This file checks the
 * things only a cmdlet can be wrong about:
 *
 *   that Format-* emits opaque directives rather than objects, so formatting
 *   cannot be reached from the middle of a pipeline
 *   that Out-String, not Format-Table, decides the width
 *   that -Stream, -NoNewline and the default form are three different answers
 *   that a Format-* receiving directives passes them through untouched
 */

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

import { getProperty, propertyNames, psObject, typeNameOf } from '../../src/pipeline/psobject.ts';
import type { PSValue } from '../../src/pipeline/psobject.ts';
import { collectingStreams } from '../../src/pipeline/streams.ts';
import type { ErrorRecord } from '../../src/pipeline/streams.ts';
import { collectPipeline, commandStage, fromValues } from '../../src/pipeline/pipeline.ts';
import type { PipelineHost, PipelineStage } from '../../src/pipeline/pipeline.ts';
import type { BindingResult, BoundParameters, CommandModule } from '../../src/commands/invocation.ts';
import {
  FORMAT_CMDLETS,
  FORMAT_CMDLET_INDEX,
  NEWLINE,
  formatList,
  formatTable,
  formatWide,
  outString,
} from '../../src/commands/format/index.ts';
import { FORMAT_ENTRY_TYPE, isFormatRecord } from '../../src/formatting/records.ts';
import { UnknownCultureError } from '../../src/formatting/culture.ts';
import { viewOfBehaviors } from '../../src/compatibility/profile-resolver.ts';

// ---------------------------------------------------------------------------
// harness
// ---------------------------------------------------------------------------

function makeHost(culture = 'en-US'): PipelineHost & { readonly errors: readonly ErrorRecord[] } {
  const streams = collectingStreams();
  return {
    profile: viewOfBehaviors('7.6.5', { 'formatting.culture': culture }),
    streams,
    errors: streams.collected.error.values,
    native: null,
    cwd: '/',
    env: new Map<string, string>(),
    signal: new AbortController().signal,
    requireCapability: (): void => {},
  };
}

const bind = (parameters: BoundParameters): BindingResult => ({
  parameters,
  parameterSet: 'Default',
  remaining: [],
});

async function runChain(
  input: readonly PSValue[],
  steps: readonly (readonly [CommandModule, BoundParameters])[],
  culture = 'en-US',
): Promise<{ values: PSValue[]; errors: readonly ErrorRecord[] }> {
  const host = makeHost(culture);
  const stages: PipelineStage[] = steps.map(([module, parameters]) =>
    commandStage(module, bind(parameters)),
  );
  const values = await collectPipeline(fromValues(input), stages, host);
  return { values, errors: host.errors };
}

const o = (bag: Record<string, PSValue>): PSValue => psObject(bag);
const two = [o({ Name: 'alpha', Size: 1 }), o({ Name: 'beta', Size: 22 })];

/** Everything Out-String produced, as one string. */
const text = (values: readonly PSValue[]): string => values.map(String).join('');

// ---------------------------------------------------------------------------

describe('formatting is the last stage', () => {
  it('emits ONE opaque directive, not objects', async () => {
    // pwsh emits five records (FormatStartData … FormatEndData); one is enough
    // here because the column widths need the whole stream anyway, and the type
    // name is the one pwsh reports.
    const { values } = await runChain(two, [[formatTable, {}]]);
    assert.equal(values.length, 1);
    assert.equal(typeNameOf(values[0] as PSValue), FORMAT_ENTRY_TYPE);
    assert.ok(isFormatRecord(values[0] as PSValue));
  });

  it('exposes NO properties, so a later stage learns nothing from it', async () => {
    // This is what makes "formatting cannot be reached from the middle of a
    // pipeline" structural rather than a convention: `... | Format-Table |
    // Sort-Object Name` has no Name to sort on, which is exactly pwsh's
    // situation with its own format records.
    const { values } = await runChain(two, [[formatTable, {}]]);
    const record = values[0] as PSValue;
    assert.deepEqual(propertyNames(record), []);
    assert.equal(getProperty(record, 'Name'), undefined);
    assert.equal(getProperty(record, 'Size'), undefined);
  });

  it('passes directives through a second Format-*, as pwsh does', async () => {
    // pwsh: `$x | Format-Table | Format-Table` renders identically to one.
    const once = await runChain(two, [[formatTable, {}], [outString, { Stream: true }]]);
    const twice = await runChain(two, [
      [formatTable, {}],
      [formatTable, {}],
      [outString, { Stream: true }],
    ]);
    assert.deepEqual(twice.values, once.values);
  });

  it('produces nothing at all for an empty stream', async () => {
    // pwsh: `@() | Format-Table` prints nothing — not a pair of blank lines.
    const { values } = await runChain([], [[formatTable, {}], [outString, { Stream: true }]]);
    assert.deepEqual(values, []);
  });
});

describe('Out-String decides the width, not Format-Table', () => {
  it('lays the same directives out differently at two widths', async () => {
    const wide = await runChain(two, [
      [formatTable, {}],
      [outString, { Stream: true, Width: 120 }],
    ]);
    const narrow = await runChain(two, [
      [formatTable, {}],
      [outString, { Stream: true, Width: 8 }],
    ]);
    assert.deepEqual(wide.values, ['', 'Name  Size', '----  ----', 'alpha    1', 'beta    22', '']);
    assert.deepEqual(narrow.values, [
      '',
      'Name  Si',
      '      ze',
      '----  --',
      'alpha  1',
      'beta  22',
      '',
    ]);
  });

  it('defaults to 120, the width the capture ran at', async () => {
    const { values } = await runChain(two, [[outString, { Stream: true }]]);
    assert.deepEqual(values, ['', 'Name  Size', '----  ----', 'alpha    1', 'beta    22', '']);
  });

  it('refuses a width below two, the way the binder’s ValidateRange does', async () => {
    // pwsh: "Cannot validate argument on parameter 'Width'. The 1 argument is
    // less than the minimum allowed range of 2."
    const { values, errors } = await runChain(two, [[outString, { Width: 1 }]]);
    assert.deepEqual(values, []);
    assert.equal(errors.length, 1);
    assert.match(errors[0]?.message ?? '', /minimum allowed range of 2/);
  });
});

describe('-Stream, -NoNewline and the default are three answers', () => {
  it('returns ONE string with a terminator after every line by default', async () => {
    // pwsh: ($two | Out-String).Length counts the terminators, and there is one
    // after the last line as well as between.
    const { values } = await runChain(two, [[outString, {}]]);
    assert.equal(values.length, 1);
    assert.equal(
      values[0],
      ['', 'Name  Size', '----  ----', 'alpha    1', 'beta    22', ''].map((l) => l + NEWLINE).join(''),
    );
  });

  it('returns one object per line with -Stream, and no terminators', async () => {
    const { values } = await runChain(two, [[outString, { Stream: true }]]);
    assert.equal(values.length, 6);
    assert.ok(values.every((line) => typeof line === 'string' && !line.includes('\n')));
  });

  it('concatenates with nothing at all under -NoNewline', async () => {
    // pwsh: 'a','b' | Out-String -NoNewline  ->  ab
    const { values } = await runChain(['a', 'b'], [[outString, { NoNewline: true }]]);
    assert.equal(text(values), 'ab');
  });

  it('still returns a String for an empty stream', async () => {
    // pwsh: (@() | Out-String).Length is 0 and its type is System.String.
    const { values } = await runChain([], [[outString, {}]]);
    assert.deepEqual(values, ['']);
  });
});

describe('the view cmdlets', () => {
  it('Format-List overrides the property-count default', async () => {
    // Two properties would be a table by default; -List says otherwise.
    const { values } = await runChain(two, [[formatList, {}], [outString, { Stream: true }]]);
    assert.deepEqual(values, [
      '',
      'Name : alpha',
      'Size : 1',
      '',
      'Name : beta',
      'Size : 22',
      '',
    ]);
  });

  it('Format-Wide lays out its single property in two columns', async () => {
    const { values } = await runChain(two, [
      [formatWide, {}],
      [outString, { Stream: true, Width: 20 }],
    ]);
    // pwsh: 15 characters. Column widths sum to width + 1 — eleven and ten at a
    // width of twenty — and the last column is not padded, so "alpha" plus six
    // spaces plus "beta" is the whole line.
    assert.deepEqual(values, ['', 'alpha      beta', '']);
  });

  it('Format-Table -HideTableHeaders drops the header but not its width', async () => {
    const { values } = await runChain(two, [
      [formatTable, { HideTableHeaders: true }],
      [outString, { Stream: true }],
    ]);
    assert.deepEqual(values, ['', 'alpha    1', 'beta    22', '']);
  });

  it('Format-Table -Property picks and orders the columns', async () => {
    const { values } = await runChain(two, [
      [formatTable, { Property: ['Size', 'Name'] }],
      [outString, { Stream: true }],
    ]);
    assert.deepEqual(values, ['', 'Size Name', '---- ----', '   1 alpha', '  22 beta', '']);
  });

  it('Format-Table -GroupBy starts a new heading per adjacent run', async () => {
    // pwsh does NOT sort: a, b, a is three groups.
    const { values } = await runChain(
      [o({ G: 'a', V: 1 }), o({ G: 'b', V: 2 }), o({ G: 'a', V: 3 })],
      [[formatTable, { GroupBy: 'G' }], [outString, { Stream: true }]],
    );
    assert.deepEqual(values, [
      '',
      '   G: a',
      '',
      'G V',
      '- -',
      'a 1',
      '',
      '   G: b',
      '',
      'G V',
      '- -',
      'b 2',
      '',
      '   G: a',
      '',
      'G V',
      '- -',
      'a 3',
      '',
    ]);
  });

  it('leaves a scalar as a bare line even when asked for a table', async () => {
    // pwsh: 'hello' | Format-Table  ->  hello, with no header and no blanks.
    const { values } = await runChain(['hello'], [[formatTable, {}], [outString, { Stream: true }]]);
    assert.deepEqual(values, ['hello']);
  });
});

describe('the culture comes from the compatibility profile', () => {
  it('formats a table cell with the profile’s culture, not the host’s', async () => {
    // The same object under two cultures. Reading the host's regional settings
    // instead would make this test depend on the machine running it.
    //
    // pwsh 7.6.5, LINUX, with CurrentCulture pinned:
    //   [pscustomobject]@{V=1.5} | Format-Table | Out-String -Width 120
    //     en-US  '', '    V', '    -', '1.500', ''
    //     zh-TW  '', '    V', '    -', '1.500', ''
    //     de-DE  '', '    V', '    -', '1,500', ''
    // zh-TW used to be asserted as `1.50` in a four-wide column. It is three
    // decimals, like the other two — only the separator differs, and zh-TW
    // shares en-US's.
    const value = [o({ V: 1.5 })];
    const enUS = await runChain(value, [[outString, { Stream: true }]], 'en-US');
    const zhTW = await runChain(value, [[outString, { Stream: true }]], 'zh-TW');
    const deDE = await runChain(value, [[outString, { Stream: true }]], 'de-DE');
    assert.deepEqual(enUS.values, ['', '    V', '    -', '1.500', '']);
    assert.deepEqual(zhTW.values, ['', '    V', '    -', '1.500', '']);
    assert.deepEqual(deDE.values, ['', '    V', '    -', '1,500', '']);
  });

  it('refuses a culture with no measured data instead of quietly using en-US', async () => {
    // The fallback this used to assert printed US separators and a US date
    // order for a profile that declared itself French, which is the exact
    // substitution culture.ts's own header says the project refuses. Nothing
    // downstream could detect it, so the error has to come from here.
    await assert.rejects(
      () => runChain([o({ V: 1.5 })], [[outString, { Stream: true }]], 'fr-FR'),
      (error: unknown) =>
        error instanceof UnknownCultureError &&
        /no measured culture data for 'fr-FR'/.test(error.message),
    );
  });
});

describe('the registry', () => {
  it('exports the four cmdlets and resolves their aliases', () => {
    assert.equal(FORMAT_CMDLETS.length, 4);
    assert.equal(FORMAT_CMDLET_INDEX.get('ft'), formatTable);
    assert.equal(FORMAT_CMDLET_INDEX.get('fl'), formatList);
    assert.equal(FORMAT_CMDLET_INDEX.get('fw'), formatWide);
    assert.equal(FORMAT_CMDLET_INDEX.get('out-string'), outString);
  });

  it('declares every command native-semantic with a note about its limits', () => {
    for (const module of FORMAT_CMDLETS) {
      assert.equal(module.manifest.fidelity, 'native-semantic');
      assert.equal(module.manifest.risk, 'read');
      assert.deepEqual(module.manifest.capabilities, []);
      assert.ok((module.manifest.notes ?? '').length > 40, module.manifest.display);
    }
  });

  it('gives -Property position zero, as pwsh does', () => {
    for (const module of [formatTable, formatList, formatWide]) {
      const property = module.manifest.parameters.find((p) => p.name === 'Property');
      assert.equal(property?.firstPosition, 0, module.manifest.display);
      assert.equal(property?.type, 'System.Object[]', module.manifest.display);
    }
  });
});
