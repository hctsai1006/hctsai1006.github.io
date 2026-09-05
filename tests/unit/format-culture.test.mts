/**
 * The formatter against the reference implementation's OWN OUTPUT, case by case.
 *
 * Every other test in this directory quotes a measurement in a comment. This one
 * asserts against the measurement itself: `tools/capture-pwsh-culture.ps1` runs
 * a corpus of values through `.ToString(format, culture)` in a real PowerShell
 * and writes what came back, and this file replays it.
 *
 *   compat/upstream/v7.6.5/culture-samples-linux.json
 *     pwsh 7.6.5, .NET 10.0.11, Ubuntu 24.04, UTC, ICU with CLDR 42+
 *
 * The LINUX capture, because the compatibility profiles this project publishes
 * are `powershell-7.6.5-linux`. The Windows capture is committed beside it and
 * differs in two places, both asserted at the bottom of this file so the
 * divergence is a fact under test rather than a remark in a comment.
 *
 * WHY THIS FILE EXISTS AT ALL
 *
 * src/formatting/culture.ts used to be four hand-transcribed tables. A
 * transcription cannot be re-run, so nothing could tell anyone it was wrong —
 * and it was wrong in at least nine places, including every zh-TW date pattern.
 * A mutation test made the same point about the date engine: replacing the `y`
 * arm of the old expander with `'MUTANT'` changed no coverage at all, because
 * every date in the conformance corpus went through a different engine. A
 * generated corpus is the answer to both: it grows when the capture grows, and
 * it cannot agree with a belief.
 */

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

import { cultureByName, type CultureData } from '../../src/formatting/culture.ts';
import { formatDate } from '../../src/formatting/datetime.ts';
import { formatValue } from '../../src/formatting/format-operator.ts';
import { toPSString } from '../../src/formatting/to-string.ts';
import { psDateTime, type DateTimeKind } from '../../src/commands/native/datetime.ts';

// ---------------------------------------------------------------------------
// the capture
// ---------------------------------------------------------------------------

interface Sample {
  readonly format: string;
  readonly text?: string;
  readonly error?: string;
}

interface Capture {
  readonly engine: {
    readonly psVersion: string;
    readonly osPlatform: string;
    readonly localUtcOffsetMinutes: number;
    readonly narrowNoBreakSpaceInEnUsTimePattern: boolean;
    readonly globalizationInvariantMode: boolean;
  };
  readonly corpus: {
    readonly numbers: Readonly<Record<string, { readonly roundTrip: string }>>;
    readonly integers: Readonly<Record<string, { readonly roundTrip: string; readonly type: string }>>;
    readonly dates: Readonly<
      Record<
        string,
        {
          readonly year: number; readonly month: number; readonly day: number;
          readonly hour: number; readonly minute: number; readonly second: number;
          readonly millisecond: number; readonly subMillisecondTicks: number;
          readonly kind: string;
        }
      >
    >;
  };
  readonly interpolation: {
    readonly numbers: Readonly<Record<string, { readonly interpolated: string; readonly g15Invariant: string }>>;
    readonly dates: Readonly<Record<string, string>>;
  };
  readonly cultures: Readonly<
    Record<
      string,
      {
        readonly numbers: Readonly<Record<string, readonly Sample[]>>;
        readonly integers: Readonly<Record<string, readonly Sample[]>>;
        readonly dates: Readonly<Record<string, readonly Sample[]>>;
      }
    >
  >;
}

const load = (platform: string): Capture =>
  JSON.parse(
    readFileSync(
      new URL(`../../compat/upstream/v7.6.5/culture-samples-${platform}.json`, import.meta.url),
      'utf8',
    ),
  ) as Capture;

const linux = load('linux');
const windows = load('windows');

const CULTURE_KEYS = ['en-US', 'de-DE', 'zh-TW', 'Invariant'] as const;
const cultureFor = (key: string): CultureData => cultureByName(key === 'Invariant' ? 'invariant' : key);

const numberValue = (key: string): number => Number(linux.corpus.numbers[key]?.roundTrip);
const integerValue = (key: string): number | bigint => {
  const entry = linux.corpus.integers[key];
  if (entry === undefined) throw new Error(`no integer '${key}' in the capture`);
  return entry.type === 'System.Int64' ? BigInt(entry.roundTrip) : Number(entry.roundTrip);
};
const dateValue = (key: string): ReturnType<typeof psDateTime> => {
  const d = linux.corpus.dates[key];
  if (d === undefined) throw new Error(`no date '${key}' in the capture`);
  return psDateTime(
    {
      year: d.year, month: d.month, day: d.day,
      hour: d.hour, minute: d.minute, second: d.second, millisecond: d.millisecond,
    },
    { kind: d.kind as DateTimeKind, subMillisecondTicks: d.subMillisecondTicks },
  );
};

/**
 * The cases this engine does NOT reproduce, named one at a time.
 *
 * An exclusion list is only honest if it is short, specific and says WHY, so
 * each entry carries the pwsh answer, this engine's answer, and the reason the
 * gap is recorded rather than closed. A wildcard here would defeat the file.
 */
const KNOWN_DIVERGENCES: ReadonlyMap<string, string> = new Map([
  [
    'numbers/negzero/0.0;(0.0)',
    // pwsh `-0.0`, this engine `(0.0)`. .NET picks a custom format's SECTION
    // before rounding and then re-picks it if the rounded digits are all zero:
    // a value that rounds to zero uses the third (zero) section, and when there
    // is none it falls back to the FIRST — carrying the sign with it. Modelling
    // that re-entry is a change to the section chooser, not to the rounding,
    // and no captured case outside this corner depends on it.
    'two-section custom format whose negative value rounds to zero',
  ],
  ['numbers/-0.001/0.0;(0.0)', 'two-section custom format whose negative value rounds to zero'],
]);

const skipReason = (bucket: string, key: string, format: string): string | undefined =>
  KNOWN_DIVERGENCES.get(`${bucket}/${key}/${format}`);

// ---------------------------------------------------------------------------
// the capture describes what it claims to describe
// ---------------------------------------------------------------------------

describe('the capture this suite replays', () => {
  it('came from pwsh 7.6.5 on Linux, not in invariant globalization mode', () => {
    assert.equal(linux.engine.psVersion, '7.6.5');
    assert.equal(linux.engine.osPlatform, 'linux');
    // In invariant globalization mode every culture collapses onto the
    // invariant one and the file would look plausible while describing nothing.
    assert.equal(linux.engine.globalizationInvariantMode, false);
  });

  it('ran in UTC, which is what makes the U specifier comparable', () => {
    // `U` and `u` are defined in UTC terms, so their expected strings encode the
    // capture host's zone as well as its culture. At offset zero they do not,
    // and the corpus can be replayed against a DateTime with no offset. If this
    // ever fails, `U` needs excluding rather than the test needs relaxing.
    assert.equal(linux.engine.localUtcOffsetMinutes, 0);
  });
});

// ---------------------------------------------------------------------------
// dates
// ---------------------------------------------------------------------------

describe('every captured date format, under every captured culture', () => {
  for (const cultureKey of CULTURE_KEYS) {
    const culture = cultureFor(cultureKey);
    const samples = linux.cultures[cultureKey];
    if (samples === undefined) throw new Error(`the capture has no culture '${cultureKey}'`);

    for (const [dateKey, cases] of Object.entries(samples.dates)) {
      it(`${cultureKey} — ${dateKey} (${String(cases.length)} formats)`, () => {
        const value = dateValue(dateKey);
        for (const sample of cases) {
          const reason = skipReason('dates', dateKey, sample.format);
          if (reason !== undefined) continue;
          if (sample.text === undefined) {
            assert.throws(
              () => formatDate(value, sample.format, culture),
              `${cultureKey} ${dateKey} ${JSON.stringify(sample.format)} should throw, as pwsh does`,
            );
            continue;
          }
          assert.equal(
            formatDate(value, sample.format, culture),
            sample.text,
            `${cultureKey} ${dateKey} ${JSON.stringify(sample.format)}`,
          );
        }
      });
    }
  }
});

// ---------------------------------------------------------------------------
// numbers
// ---------------------------------------------------------------------------

describe('every captured numeric format, under every captured culture', () => {
  for (const cultureKey of CULTURE_KEYS) {
    const culture = cultureFor(cultureKey);
    const samples = linux.cultures[cultureKey];
    if (samples === undefined) throw new Error(`the capture has no culture '${cultureKey}'`);

    for (const [numberKey, cases] of Object.entries(samples.numbers)) {
      it(`${cultureKey} — ${numberKey} (${String(cases.length)} formats)`, () => {
        const value = numberValue(numberKey);
        for (const sample of cases) {
          if (skipReason('numbers', numberKey, sample.format) !== undefined) continue;
          if (sample.text === undefined) {
            assert.throws(
              () => formatValue(value, sample.format, culture),
              `${cultureKey} ${numberKey} ${JSON.stringify(sample.format)} should throw, as pwsh does`,
            );
            continue;
          }
          assert.equal(
            formatValue(value, sample.format, culture),
            sample.text,
            `${cultureKey} ${numberKey} ${JSON.stringify(sample.format)}`,
          );
        }
      });
    }

    for (const [integerKey, cases] of Object.entries(samples.integers)) {
      it(`${cultureKey} — integer ${integerKey}`, () => {
        const value = integerValue(integerKey);
        for (const sample of cases) {
          if (skipReason('integers', integerKey, sample.format) !== undefined) continue;
          if (sample.text === undefined) {
            assert.throws(() => formatValue(value, sample.format, culture));
            continue;
          }
          assert.equal(
            formatValue(value, sample.format, culture),
            sample.text,
            `${cultureKey} ${integerKey} ${JSON.stringify(sample.format)}`,
          );
        }
      });
    }
  }
});

// ---------------------------------------------------------------------------
// "$x"
// ---------------------------------------------------------------------------

describe('"$x" against the captured interpolation', () => {
  it('matches pwsh for every double in the corpus', () => {
    for (const [key, expected] of Object.entries(linux.interpolation.numbers)) {
      if (linux.corpus.numbers[key] === undefined) continue;
      assert.equal(toPSString(numberValue(key)), expected.interpolated, `"$(${key})"`);
    }
  });

  it('is exactly ToString("G15", InvariantCulture), which is why it is one function', () => {
    // The capture records both. They agree on all forty values, including
    // negative zero (`-0`) and the 1e-5 threshold (`1E-05`) — the two the
    // deleted `formatDouble` got wrong.
    for (const [, expected] of Object.entries(linux.interpolation.numbers)) {
      assert.equal(expected.interpolated, expected.g15Invariant);
    }
  });

  it('matches pwsh for every DateTime in the corpus', () => {
    // `"$date"` is the invariant culture's G pattern. psobject.ts writes that
    // pattern out by hand because the engine imports it and would close a
    // cycle; this is the weld that keeps the two from drifting.
    const invariant = cultureByName('invariant');
    for (const [key, expected] of Object.entries(linux.interpolation.dates)) {
      const value = dateValue(key);
      assert.equal(toPSString(value), expected, `"$(${key})"`);
      assert.equal(toPSString(value), formatDate(value, 'G', invariant), `${key} via the engine`);
    }
  });
});

// ---------------------------------------------------------------------------
// the two places the platforms disagree
// ---------------------------------------------------------------------------

describe('Windows and Linux disagree, and Linux is the one loaded', () => {
  interface CulturePatterns {
    readonly cultures: Readonly<
      Record<
        string,
        {
          readonly numberFormat: Readonly<Record<string, unknown>>;
          readonly dateTimeFormat: Readonly<Record<string, unknown>>;
        }
      >
    >;
  }
  const metadata = (platform: string): CulturePatterns =>
    JSON.parse(
      readFileSync(
        new URL(`../../compat/upstream/v7.6.5/culture-metadata-${platform}.json`, import.meta.url),
        'utf8',
      ),
    ) as CulturePatterns;
  const linuxData = metadata('linux');
  const windowsData = metadata('windows');

  it('agrees on every NumberFormatInfo field, for every culture', () => {
    // Not one numeric field differs between the two hosts. Everything culture.ts
    // reads on the numeric side is therefore platform-independent, and the
    // choice of capture only matters for dates.
    for (const key of CULTURE_KEYS) {
      assert.deepEqual(
        linuxData.cultures[key]?.numberFormat,
        windowsData.cultures[key]?.numberFormat,
        `${key} numberFormat`,
      );
    }
  });

  it('differs on exactly two DateTimeFormatInfo things, both named', () => {
    const differing: string[] = [];
    for (const key of CULTURE_KEYS) {
      const a = linuxData.cultures[key]?.dateTimeFormat ?? {};
      const b = windowsData.cultures[key]?.dateTimeFormat ?? {};
      for (const field of new Set([...Object.keys(a), ...Object.keys(b)])) {
        if (JSON.stringify(a[field]) !== JSON.stringify(b[field])) differing.push(`${key}.${field}`);
      }
    }
    assert.deepEqual(differing.sort(), [
      // en-US's time patterns, whose designator separator is U+202F on a CLDR
      // 42+ ICU and U+0020 on this Windows host. `standardPatterns` carries the
      // same difference for f, F, g, G, t, T and U.
      'de-DE.shortestDayNames',
      'en-US.fullDateTimePattern',
      'en-US.longTimePattern',
      'en-US.shortTimePattern',
      'en-US.shortestDayNames',
      'en-US.standardPatterns',
      // ShortestDayNames: CLDR's narrow forms (`Su`, `So.`) against Windows's
      // single letters (`S`). Captured and never read — no .NET format specifier
      // uses them — so they are recorded here rather than modelled.
    ].sort());
  });

  it('separates en-US’s AM/PM designator with U+202F on Linux and U+0020 on Windows', () => {
    const linuxG = linux.cultures['en-US']?.dates['afternoon']?.find((s) => s.format === 'G')?.text;
    const windowsG = windows.cultures['en-US']?.dates['afternoon']?.find((s) => s.format === 'G')?.text;
    assert.equal(linuxG, '3/4/2020 3:06:07\u202fPM');
    assert.equal(windowsG, '3/4/2020 3:06:07 PM');
    assert.equal(linux.engine.narrowNoBreakSpaceInEnUsTimePattern, true);
    assert.equal(windows.engine.narrowNoBreakSpaceInEnUsTimePattern, false);
    // and the loaded culture is the Linux one
    assert.equal(formatDate(dateValue('afternoon'), 'G', cultureByName('en-US')), linuxG);
  });

  it('agrees on everything the formatter reads except that separator', () => {
    // The `U` specifier is excluded because it is defined in UTC and the two
    // hosts are in different zones — a timezone difference, not a culture one.
    // ShortestDayNames also differ (CLDR narrow forms against single letters)
    // and are captured but unread: no .NET format specifier uses them.
    const differing: string[] = [];
    for (const cultureKey of CULTURE_KEYS) {
      for (const [dateKey, cases] of Object.entries(linux.cultures[cultureKey]?.dates ?? {})) {
        const other = windows.cultures[cultureKey]?.dates[dateKey] ?? [];
        cases.forEach((sample, index) => {
          if (sample.format === 'U') return;
          if (sample.text !== other[index]?.text) differing.push(`${cultureKey}/${dateKey}/${sample.format}`);
        });
      }
      for (const [numberKey, cases] of Object.entries(linux.cultures[cultureKey]?.numbers ?? {})) {
        const other = windows.cultures[cultureKey]?.numbers[numberKey] ?? [];
        cases.forEach((sample, index) => {
          if (sample.text !== other[index]?.text) differing.push(`${cultureKey}/${numberKey}/${sample.format}`);
        });
      }
    }
    // Only en-US's designator-bearing formats, and only for the date corpus:
    // every standard specifier whose pattern contains `tt`. No numeric format
    // differs at all, on any culture.
    assert.deepEqual(
      [...new Set(differing.map((d) => d.split('/').slice(-1)[0] ?? ''))].sort(),
      ['F', 'G', 'T', 'f', 'g', 't'].sort(),
    );
    assert.ok(differing.every((d) => d.startsWith('en-US/')), differing.join(', '));
  });
});
