/**
 * Tests for the DateTime value and its two format languages.
 *
 * EVERY expectation here was READ OFF pwsh 7.6.5 with a probe script run
 * against `2026-03-04T05:06:07` on a host at +08:00, en-US. The probe is
 * reproducible: `Get-Date -Date '2026-03-04T05:06:07' -Format <f>` and
 * `-UFormat <u>` for each specifier below.
 *
 * The three that contradicted a confident guess, kept at the top so they are
 * not lost among the rest:
 *
 *   -Format 'd' is 3/4/2026, NOT the day of the month. A one-character format
 *   is a STANDARD specifier, and 'H' — which is not one — throws.
 *
 *   -Format 'r' does NOT convert to UTC. It formats the value as it stands and
 *   appends GMT, so an Unspecified 05:06 at +08:00 renders as 05:06 GMT and not
 *   as the previous evening. 'U' and the *Universal forms DO convert.
 *
 *   %u and %w are different numbering schemes that agree on a Wednesday. The
 *   discriminating case is a Sunday: %u is 7, %w is 0.
 */

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

import { toPSString } from '../../src/formatting/to-string.ts';
import { compareValues, getProperty, isPSObject, typeNameOf } from '../../src/pipeline/psobject.ts';
import {
  DateFormatError,
  PSDateTime,
  epochSeconds,
  formatDotNet,
  formatUnix,
  longDateTimeString,
  nowAsLocal,
  psDateTime,
  psTimeSpan,
  timeSpanText,
} from '../../src/commands/native/index.ts';
import { TEST_EPOCH_MS, TEST_OFFSET_MINUTES } from './native-harness.mts';

/** The probe's instant, as an Unspecified DateTime in a +08:00 session. */
const probe = (): PSDateTime =>
  psDateTime(
    { year: 2026, month: 3, day: 4, hour: 5, minute: 6, second: 7 },
    { offsetMinutes: TEST_OFFSET_MINUTES, displayHint: 'DateTime' },
  );

describe('PSDateTime is both a Date and a PSObject', () => {
  it('reports System.DateTime and carries pwsh\'s property set in pwsh\'s order', () => {
    const d = probe();
    // pwsh: (Get-Date).GetType().FullName -> System.DateTime
    assert.equal(typeNameOf(d), 'System.DateTime');
    assert.deepEqual(d.typeNames, ['System.DateTime', 'System.ValueType', 'System.Object']);
    assert.ok(isPSObject(d));
    // pwsh: (Get-Date).PSObject.Properties, in order
    assert.deepEqual(Object.keys(d.properties), [
      'DisplayHint', 'DateTime', 'Date', 'Day', 'DayOfWeek', 'DayOfYear', 'Hour', 'Kind',
      'Millisecond', 'Microsecond', 'Nanosecond', 'Minute', 'Month', 'Second', 'Ticks',
      'TimeOfDay', 'Year',
    ]);
  });

  it('stringifies the way "$x" does, not the way the host timezone would', () => {
    // pwsh: "$(Get-Date -Date '2026-03-04T05:06:07')" -> 03/04/2026 05:06:07
    assert.equal(toPSString(probe()), '03/04/2026 05:06:07');
  });

  it('reads its civil fields identically through the UTC and local accessors', () => {
    // The invariant that keeps a runner's timezone out of every expectation.
    const d = probe();
    assert.equal(d.getHours(), d.getUTCHours());
    assert.equal(d.getDate(), d.getUTCDate());
    assert.equal(d.getMonth(), d.getUTCMonth());
    assert.equal(d.getFullYear(), d.getUTCFullYear());
    assert.equal(d.getDay(), d.getUTCDay());
  });

  it('computes Ticks as an Int64-sized bigint', () => {
    // pwsh: ([datetime]'2026-03-04T05:06:07').Ticks -> 639081975670000000
    // 6.39e17 is past Number.MAX_SAFE_INTEGER, so a number would lose digits.
    assert.equal(getProperty(probe(), 'Ticks'), 639081975670000000n);
    assert.equal(typeNameOf(getProperty(probe(), 'Ticks') as bigint), 'System.Int64');
  });

  it('exposes the components pwsh reports', () => {
    const d = probe();
    assert.equal(getProperty(d, 'Year'), 2026);          // pwsh: 2026
    assert.equal(getProperty(d, 'Month'), 3);            // pwsh: 3
    assert.equal(getProperty(d, 'Day'), 4);              // pwsh: 4
    assert.equal(getProperty(d, 'Hour'), 5);             // pwsh: 5
    assert.equal(getProperty(d, 'DayOfWeek'), 'Wednesday'); // pwsh: Wednesday
    assert.equal(getProperty(d, 'DayOfYear'), 63);       // pwsh: 63
    assert.equal(getProperty(d, 'Kind'), 'Unspecified'); // pwsh: Unspecified
  });

  it('splits sub-millisecond precision into Microsecond and Nanosecond', () => {
    // pwsh: ([datetime]'2026-03-04T05:06:07.0084567') -> ms 8, us 456, ns 700
    const d = new PSDateTime(Date.UTC(2026, 2, 4, 5, 6, 7, 8), { subMillisecondTicks: 4567 });
    assert.equal(getProperty(d, 'Millisecond'), 8);
    assert.equal(getProperty(d, 'Microsecond'), 456);
    assert.equal(getProperty(d, 'Nanosecond'), 700);
  });

  it('sorts by instant, because compareValues sees a Date', () => {
    const january = psDateTime({ year: 2026, month: 1, day: 1 });
    const june = psDateTime({ year: 2026, month: 6, day: 1 });
    assert.equal(compareValues(january, june), -1);
    assert.equal(compareValues(june, january), 1);
    assert.equal(compareValues(january, january), 0);
  });

  it('honours DisplayHint in the DateTime script property', () => {
    const d = probe();
    // pwsh: (Get-Date -Date '2026-03-04T05:06:07' -DisplayHint Date).DateTime
    assert.equal(longDateTimeString(d, 'Date'), 'Wednesday, March 4, 2026');
    assert.equal(longDateTimeString(d, 'Time'), '5:06:07 AM');
    assert.equal(longDateTimeString(d, 'DateTime'), 'Wednesday, March 4, 2026 5:06:07 AM');
    assert.equal(getProperty(d, 'DateTime'), 'Wednesday, March 4, 2026 5:06:07 AM');
  });

  it('reads the injected clock as a Local DateTime', () => {
    const d = nowAsLocal(TEST_EPOCH_MS, TEST_OFFSET_MINUTES);
    assert.equal(getProperty(d, 'Kind'), 'Local');
    assert.equal(formatDotNet(d, 'yyyy-MM-ddTHH:mm:ss'), '2026-03-04T05:06:07');
  });
});

describe('-Format: the standard specifiers', () => {
  const cases: readonly (readonly [string, string])[] = [
    ['d', '3/4/2026'],
    ['D', 'Wednesday, March 4, 2026'],
    ['f', 'Wednesday, March 4, 2026 5:06 AM'],
    ['F', 'Wednesday, March 4, 2026 5:06:07 AM'],
    ['g', '3/4/2026 5:06 AM'],
    ['G', '3/4/2026 5:06:07 AM'],
    ['m', 'March 4'],
    ['M', 'March 4'],
    ['o', '2026-03-04T05:06:07.0000000'],
    ['O', '2026-03-04T05:06:07.0000000'],
    ['r', 'Wed, 04 Mar 2026 05:06:07 GMT'],
    ['R', 'Wed, 04 Mar 2026 05:06:07 GMT'],
    ['s', '2026-03-04T05:06:07'],
    ['t', '5:06 AM'],
    ['T', '5:06:07 AM'],
    ['u', '2026-03-04 05:06:07Z'],
    ['U', 'Tuesday, March 3, 2026 9:06:07 PM'],
    ['y', 'March 2026'],
    ['Y', 'March 2026'],
    ['FileDate', '20260304'],
    ['FileDateUniversal', '20260303Z'],
    ['FileDateTime', '20260304T0506070000'],
    ['FileDateTimeUniversal', '20260303T2106070000Z'],
  ];

  for (const [format, expected] of cases) {
    it(`-Format '${format}' is ${expected}`, () => {
      // pwsh: Get-Date -Date '2026-03-04T05:06:07' -Format '<format>'
      assert.equal(formatDotNet(probe(), format), expected);
    });
  }

  it('throws for a one-character specifier that is not a standard one', () => {
    // pwsh: -Format 'H' / 'h' / 'K' / 'z' -> "Input string was not in a correct format."
    for (const bad of ['H', 'h', 'K', 'z']) {
      assert.throws(() => formatDotNet(probe(), bad), DateFormatError, `expected ${bad} to throw`);
    }
  });
});

describe('-Format: the custom language', () => {
  const cases: readonly (readonly [string, string])[] = [
    ['yyyy', '2026'],
    ['yyy', '2026'],
    ['yy', '26'],
    ['MMMM', 'March'],
    ['MMM', 'Mar'],
    ['MM', '03'],
    ['dddd', 'Wednesday'],
    ['ddd', 'Wed'],
    ['dd', '04'],
    ['HH', '05'],
    ['hh', '05'],
    ['mm', '06'],
    ['ss', '07'],
    ['tt', 'AM'],
    ['zzz', '+08:00'],
    ['zz', '+08'],
    ['gg', 'AD'],
    ['yyyy-MM-dd HH:mm:ss', '2026-03-04 05:06:07'],
    ['yyyy\\-MM', '2026-03'],
    ['"lit" yyyy', 'lit 2026'],
    ["'lit' yyyy", 'lit 2026'],
    ["yyyy'T'MM", '2026T03'],
    ['\\y yyyy', 'y 2026'],
  ];
  for (const [format, expected] of cases) {
    it(`-Format '${format}' is ${expected}`, () => {
      assert.equal(formatDotNet(probe(), format), expected);
    });
  }

  it('formats the fractional second at every width', () => {
    // pwsh on 2026-03-04T05:06:07.0089000
    const d = new PSDateTime(Date.UTC(2026, 2, 4, 5, 6, 7, 8), {
      offsetMinutes: TEST_OFFSET_MINUTES,
      subMillisecondTicks: 9000,
    });
    assert.equal(formatDotNet(d, 'fffffff'), '0089000');
    assert.equal(formatDotNet(d, 'ffffff'), '008900');
    assert.equal(formatDotNet(d, 'fff'), '008');
    assert.equal(formatDotNet(d, 'ff'), '00');
    assert.equal(formatDotNet(d, 'FFF'), '008');
    assert.equal(formatDotNet(d, 'o'), '2026-03-04T05:06:07.0089000');
    assert.equal(formatDotNet(d, 'FileDateTime'), '20260304T0506070089');
    assert.equal(formatDotNet(d, 'FileDateTimeUniversal'), '20260303T2106070089Z');
  });

  it('renders K and o per Kind', () => {
    // pwsh: -Format 'o' is bare for Unspecified, Z for Utc, +08:00 for Local.
    const unspecified = probe();
    const utc = new PSDateTime(unspecified.getTime(), { kind: 'Utc', offsetMinutes: 480 });
    const local = new PSDateTime(unspecified.getTime(), { kind: 'Local', offsetMinutes: 480 });
    assert.equal(formatDotNet(unspecified, 'o'), '2026-03-04T05:06:07.0000000');
    assert.equal(formatDotNet(utc, 'o'), '2026-03-04T05:06:07.0000000Z');
    assert.equal(formatDotNet(local, 'o'), '2026-03-04T05:06:07.0000000+08:00');
    assert.equal(formatDotNet(unspecified, 'yyyyK'), '2026');
    assert.equal(formatDotNet(utc, 'yyyyK'), '2026Z');
    assert.equal(formatDotNet(local, 'yyyyK'), '2026+08:00');
  });
});

describe('-UFormat', () => {
  const cases: readonly (readonly [string, string])[] = [
    ['%a', 'Wed'], ['%A', 'Wednesday'], ['%b', 'Mar'], ['%B', 'March'],
    ['%c', 'Wed 04 Mar 2026 05:06:07'], ['%C', '20'], ['%d', '04'], ['%D', '03/04/26'],
    ['%e', ' 4'], ['%F', '2026-03-04'], ['%g', '26'], ['%G', '2026'], ['%h', 'Mar'],
    ['%H', '05'], ['%I', '05'], ['%j', '063'], ['%k', ' 5'], ['%l', ' 5'], ['%m', '03'],
    ['%M', '06'], ['%p', 'AM'], ['%r', '05:06:07 AM'], ['%R', '05:06'], ['%S', '07'],
    ['%T', '05:06:07'], ['%u', '3'], ['%U', '9'], ['%V', '10'], ['%w', '3'], ['%W', '9'],
    ['%x', '03/04/26'], ['%X', '05:06:07'], ['%y', '26'], ['%Y', '2026'], ['%Z', '+08'],
    ['%%', '%'], ['%q', 'q'], ['Year: %Y!', 'Year: 2026!'],
  ];
  for (const [format, expected] of cases) {
    it(`-UFormat '${format}' is ${JSON.stringify(expected)}`, () => {
      // pwsh: Get-Date -Date '2026-03-04T05:06:07' -UFormat '<format>'
      assert.equal(formatUnix(probe(), format), expected);
    });
  }

  it('emits a real newline for %n and a tab for %t', () => {
    // pwsh: -UFormat 'a%nb%tc' -> "a\nb\tc"
    assert.equal(formatUnix(probe(), 'a%nb%tc'), 'a\nb\tc');
  });

  it('distinguishes %u from %w on a Sunday, which a Wednesday cannot', () => {
    // pwsh: 2026-03-08 is a Sunday. %u -> 7 (ISO), %w -> 0 (C).
    const sunday = psDateTime({ year: 2026, month: 3, day: 8 }, { offsetMinutes: 480 });
    assert.equal(formatUnix(sunday, '%u'), '7');
    assert.equal(formatUnix(sunday, '%w'), '0');
    assert.equal(formatUnix(sunday, '%a'), 'Sun');
  });

  it('gives %s a different answer for Utc and Unspecified, exactly as pwsh does', () => {
    // pwsh: -Date '2026-03-04T05:06:07'  -UFormat %s -> 1772571967
    //       -Date '2026-03-04T05:06:07Z' -UFormat %s -> 1772600767
    const unspecified = probe();
    const utc = new PSDateTime(unspecified.getTime(), { kind: 'Utc', offsetMinutes: 480 });
    assert.equal(formatUnix(unspecified, '%s'), '1772571967');
    assert.equal(formatUnix(utc, '%s'), '1772600767');
    assert.equal(epochSeconds(utc) - epochSeconds(unspecified), 28800);
  });
});

describe('TimeSpan', () => {
  it('carries the property set pwsh reports, in its order', () => {
    // pwsh: ([timespan]::FromSeconds(3725.5)).PSObject.Properties
    const ts = psTimeSpan(3_725_500);
    assert.deepEqual(ts.typeNames, ['System.TimeSpan', 'System.ValueType', 'System.Object']);
    assert.deepEqual(Object.keys(ts.properties), [
      'Ticks', 'Days', 'Hours', 'Milliseconds', 'Microseconds', 'Nanoseconds', 'Minutes',
      'Seconds', 'TotalDays', 'TotalHours', 'TotalMilliseconds', 'TotalMicroseconds',
      'TotalNanoseconds', 'TotalMinutes', 'TotalSeconds',
    ]);
    assert.equal(ts.properties['Ticks'], 37255000000n); // pwsh: 37255000000
    assert.equal(ts.properties['Hours'], 1);            // pwsh: 1
    assert.equal(ts.properties['Minutes'], 2);          // pwsh: 2
    assert.equal(ts.properties['Seconds'], 5);          // pwsh: 5
    assert.equal(ts.properties['Milliseconds'], 500);   // pwsh: 500
    assert.equal(ts.properties['TotalSeconds'], 3725.5);// pwsh: 3725.5
  });

  it('renders its text the way ToString does', () => {
    // pwsh: "$([timespan]::FromSeconds(3725.5))" -> 01:02:05.5000000
    //       "$([timespan]::FromSeconds(1))"      -> 00:00:01
    assert.equal(timeSpanText(3_725_500), '01:02:05.5000000');
    assert.equal(timeSpanText(1000), '00:00:01');
  });
});
