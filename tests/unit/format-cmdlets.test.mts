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
import {
  FORMAT_DOCUMENT_PROPERTY,
  FORMAT_ENTRY_TYPE,
  formatRecord,
  isFormatRecord,
  recordDocument,
} from '../../src/formatting/records.ts';
import { DEFAULT_CULTURE, UnknownCultureError } from '../../src/formatting/culture.ts';
import { renderDocument } from '../../src/formatting/views.ts';
import type { FormatDocument } from '../../src/formatting/views.ts';
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

  it('exposes nothing a later stage can use, and one thing the renderer can', async () => {
    // What makes "formatting cannot be reached from the middle of a pipeline"
    // structural rather than a convention: `... | Format-Table | Sort-Object
    // Name` has no Name to sort on. MEASURED in pwsh 7.6.5 — `$entry.Name` on a
    // FormatEntryData is `$null`, and sorting the five records by Name leaves
    // them in their original order.
    //
    // This asserted `propertyNames(record)` was EMPTY, on the reasoning that
    // pwsh's records carry no readable properties either. That reasoning was
    // wrong, and the same probe says so: `[pscustomobject]@{A=1} | Format-Table`
    // yields a FormatEntryData whose `Get-Member -MemberType Property` reports
    //
    //   ClassId2e4f51ef21dd47e99d3c952918aff9cd, formatEntryInfo,
    //   outOfBand, writeStream
    //
    // — four internal properties, none of them the user's. The record here
    // carries one, for the same reason pwsh carries `formatEntryInfo`: the
    // document has to reach the renderer, and after the kernel boundary the
    // renderer is in another realm.
    const { values } = await runChain(two, [[formatTable, {}]]);
    const record = values[0] as PSValue;
    assert.deepEqual(propertyNames(record), [FORMAT_DOCUMENT_PROPERTY]);
    assert.equal(getProperty(record, 'Name'), undefined);
    assert.equal(getProperty(record, 'Size'), undefined);
    // And the one property is the document, not something a user typed.
    assert.notEqual(recordDocument(record), undefined);
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

// ---------------------------------------------------------------------------
// the record as something that can be SENT
// ---------------------------------------------------------------------------

describe('a format record survives a structured clone with its document', () => {
  /**
   * The document used to ride in `baseObject`, which `src/kernel/wire.ts` drops
   * — so a `Format-Table` at the end of a pipeline could not reach a host at
   * all. It is serialised into the property bag instead. These assert the pair
   * of properties that makes that a REPRESENTATION rather than a place to put
   * it: what goes in comes back out, and what comes back out is checked.
   */
  const document = {
    sections: [
      {
        kind: 'table' as const,
        columns: [
          { header: 'Name', alignment: 'left' as const },
          { header: 'Size', alignment: 'right' as const },
        ],
        groups: [{ label: null, rows: [['a', '1'], ['b', '22']] }],
        hideHeaders: false,
        wrap: false,
      },
      { kind: 'raw' as const, lines: ['tail'] },
    ],
  };

  it('round-trips through structuredClone unchanged', () => {
    // The real transport is `postMessage`, which is this algorithm. Class
    // identity does not survive it; a JSON string does.
    const clone = structuredClone(formatRecord(document)) as PSValue;
    assert.equal(isFormatRecord(clone), true);
    assert.deepEqual(recordDocument(clone), document);
  });

  it('renders identically before and after the clone', () => {
    // Equality of the decoded object is not quite the claim; equality of the
    // OUTPUT is, because that is what a host renderer produces.
    const before = renderDocument(document, { width: 40, culture: DEFAULT_CULTURE });
    const after = renderDocument(
      recordDocument(structuredClone(formatRecord(document)) as PSValue) as FormatDocument,
      { width: 40, culture: DEFAULT_CULTURE },
    );
    assert.deepEqual(after, before);
    assert.ok(before.length > 3, 'the fixture renders something worth comparing');
  });

  it('says nothing about a value that is not a format record', () => {
    // `undefined` means "not one of these" and nothing else, which is what
    // `Out-String` branches on to tell a record from an ordinary object.
    assert.equal(recordDocument('hello'), undefined);
    assert.equal(recordDocument(psObject({ Name: 'a' })), undefined);
    assert.equal(recordDocument(42), undefined);
  });

  it('THROWS on a record whose payload is not a document, rather than skipping it', () => {
    // The script block's lesson, one layer down: an unresolvable handle had to
    // be an error rather than a silent pass. A record that says FormatEntryData
    // and cannot produce a document would otherwise fall through Out-String's
    // "not a record" branch and be rendered as an ordinary object.
    const broken = (payload: PSValue): PSValue =>
      psObject({ [FORMAT_DOCUMENT_PROPERTY]: payload }, [FORMAT_ENTRY_TYPE, 'System.Object']);

    assert.throws(() => recordDocument(psObject({}, [FORMAT_ENTRY_TYPE, 'System.Object'])), {
      name: 'FormatRecordError',
    });
    assert.throws(() => recordDocument(broken(42)), { name: 'FormatRecordError' });
    assert.throws(() => recordDocument(broken('{not json')), { name: 'FormatRecordError' });
    assert.throws(() => recordDocument(broken('null')), { name: 'FormatRecordError' });
  });

  it('refuses a document that parses but is not one, field by field', () => {
    // The decoder is total rather than a cast: across the boundary the string
    // came from wherever it came from, and `renderDocument` reading a number
    // where it expects a cell would produce garbage or throw inside the
    // renderer, naming a line of the renderer rather than the cause.
    const rejected = [
      '{}', // no sections
      '{"sections":{}}', // sections is not an array
      '{"sections":[{"kind":"nope"}]}', // unknown section kind
      '{"sections":[{"kind":"raw","lines":[1]}]}', // a line that is not a string
      '{"sections":[{"kind":"raw"}]}', // no lines at all
      // a table missing its booleans
      '{"sections":[{"kind":"table","columns":[],"groups":[]}]}',
      // an alignment that is not one of the two
      '{"sections":[{"kind":"table","columns":[{"header":"A","alignment":"middle"}],' +
        '"groups":[],"hideHeaders":false,"wrap":false}]}',
      // a group label that is neither a string nor null
      '{"sections":[{"kind":"wide","groups":[{"label":7,"items":[]}],"columns":null,' +
        '"autoSize":false}]}',
    ];
    for (const payload of rejected) {
      assert.throws(
        () =>
          recordDocument(
            psObject({ [FORMAT_DOCUMENT_PROPERTY]: payload }, [FORMAT_ENTRY_TYPE, 'System.Object']),
          ),
        { name: 'FormatRecordError' },
        payload,
      );
    }
  });

  it('accepts every section kind the formatter can build', () => {
    // A decoder that refused a kind would make that view unrenderable after the
    // boundary and nowhere else, which is the hardest bug shape to find.
    const all = {
      sections: [
        { kind: 'raw' as const, lines: ['x'] },
        {
          kind: 'table' as const,
          columns: [{ header: 'A', alignment: 'right' as const }],
          groups: [{ label: 'g', rows: [['1']] }],
          hideHeaders: true,
          wrap: true,
        },
        { kind: 'list' as const, groups: [{ label: null, entries: [[{ label: 'A', value: '1' }]] }] },
        { kind: 'wide' as const, groups: [{ label: null, items: ['a'] }], columns: 3, autoSize: true },
        { kind: 'custom' as const, groups: [{ label: null, lines: ['one'] }] },
      ],
    };
    assert.deepEqual(recordDocument(structuredClone(formatRecord(all)) as PSValue), all);
  });
});
