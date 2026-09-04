/**
 * datetime.ts — PowerShell's DateTime, and the two format languages it speaks.
 *
 * WHY THERE IS A Date SUBCLASS HERE
 *
 * `Get-Date` has to satisfy four things at once, and they pull in different
 * directions. Measured in pwsh 7.6.5:
 *
 *   (Get-Date -Date '2026-03-04T05:06:07').Year        ->  2026
 *   (Get-Date -Date '2026-03-04T05:06:07').GetType()   ->  System.DateTime
 *   "$(Get-Date -Date '2026-03-04T05:06:07')"          ->  03/04/2026 05:06:07
 *   Get-Date | Sort-Object                             ->  ordered by instant
 *
 * A bare JavaScript `Date` gives the last two and loses `.Year`, because
 * property access in this engine goes through `PSObject.properties`. A plain
 * `psWrap` PSObject gives the first two and loses the other two, because
 * `toPSString` and `compareValues` both branch on `instanceof Date`.
 *
 * So `PSDateTime` is both: a `Date` that structurally satisfies `PSObject`.
 * That is not a trick to get around the type system — it is what a .NET
 * DateTime already is in PowerShell, a value with a numeric identity AND a
 * member surface, and the two engine files that already exist both key off
 * exactly one of those halves.
 *
 * THE ONE INVARIANT THAT MAKES IT DETERMINISTIC
 *
 * A .NET DateTime is a CIVIL time with no zone attached; its `Kind` says how to
 * interpret it, not what it is. The instant stored underneath here is
 * `Date.UTC(...)` of the civil components, and the eight local accessors are
 * overridden to return the UTC ones. So:
 *
 *   getHours() === getUTCHours()          always, on every machine
 *
 * That is what keeps `toPSString` — which reads local fields — from shifting a
 * date by the runner's timezone. Constructing with `new Date(y, m, d, ...)`
 * instead would have been shorter and is wrong: in a zone with a spring-forward
 * gap, `new Date(2026, 2, 8, 2, 30)` is 03:30, so the value would not even
 * round-trip on the machine that built it.
 */

import { psObject } from '../../pipeline/psobject.ts';
import type { PSObject, PSValue } from '../../pipeline/psobject.ts';

/** `System.DateTimeKind`, as pwsh reports it. */
export type DateTimeKind = 'Unspecified' | 'Utc' | 'Local';

/** What `Get-Date -DisplayHint` accepts, read off the DisplayHintType enum. */
export type DisplayHint = 'Date' | 'Time' | 'DateTime';

export const DATETIME_TYPE_NAMES: readonly string[] = [
  'System.DateTime',
  'System.ValueType',
  'System.Object',
];

/** Invariant English names. The culture is pinned, exactly as psobject.ts pins
 *  its collator: a differential test must not depend on the runner's locale. */
const MONTHS = [
  'January', 'February', 'March', 'April', 'May', 'June',
  'July', 'August', 'September', 'October', 'November', 'December',
] as const;
const DAYS = [
  'Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday',
] as const;

const monthName = (index: number): string => MONTHS[index] ?? '';
const dayName = (index: number): string => DAYS[index] ?? '';
const pad = (n: number, width = 2): string => String(Math.abs(n)).padStart(width, '0');

/** .NET ticks at the Unix epoch: 1970-01-01 is 621355968000000000 ticks after 0001-01-01. */
const EPOCH_TICKS = 621355968000000000n;

// ---------------------------------------------------------------------------
// the value
// ---------------------------------------------------------------------------

export interface PSDateTimeOptions {
  readonly kind?: DateTimeKind;
  readonly displayHint?: DisplayHint | null;
  /** Minutes to ADD to UTC for local time. Used by `zzz`, `%Z`, `K` and `%s`. */
  readonly offsetMinutes?: number;
  /** Ticks below the millisecond, 0..9999. `Get-Date` never produces any. */
  readonly subMillisecondTicks?: number;
}

/**
 * A PowerShell DateTime.
 *
 * `properties` is built eagerly and frozen, because `PSObject.properties` is a
 * plain record and the pipeline reads it directly. `Date` inside it is a plain
 * `PSDateTime` with no `Date` of its own would recurse forever, so the midnight
 * value is a sibling instance built with `withoutDateProperty`.
 */
export class PSDateTime extends Date implements PSObject {
  readonly typeNames: readonly string[] = DATETIME_TYPE_NAMES;
  readonly properties: Readonly<Record<string, PSValue>>;
  readonly kind: DateTimeKind;
  readonly displayHint: DisplayHint | null;
  readonly offsetMinutes: number;
  readonly subMillisecondTicks: number;

  constructor(civilUtcMs: number, options: PSDateTimeOptions = {}, includeDateProperty = true) {
    super(civilUtcMs);
    this.kind = options.kind ?? 'Unspecified';
    this.displayHint = options.displayHint ?? null;
    this.offsetMinutes = options.offsetMinutes ?? 0;
    this.subMillisecondTicks = options.subMillisecondTicks ?? 0;

    const bag: Record<string, PSValue> = {};
    // Order is the one pwsh reports from `(Get-Date).PSObject.Properties`:
    // DisplayHint first (Get-Date adds it as a NoteProperty; a bare [datetime]
    // has none), then the DateTime ScriptProperty, then the CLR properties.
    if (this.displayHint !== null) bag['DisplayHint'] = this.displayHint;
    bag['DateTime'] = longDateTimeString(this, this.displayHint ?? 'DateTime');
    if (includeDateProperty) {
      bag['Date'] = new PSDateTime(
        Date.UTC(this.getUTCFullYear(), this.getUTCMonth(), this.getUTCDate()),
        { kind: this.kind, offsetMinutes: this.offsetMinutes },
        false,
      );
    }
    bag['Day'] = this.getUTCDate();
    bag['DayOfWeek'] = dayName(this.getUTCDay());
    bag['DayOfYear'] = dayOfYear(this);
    bag['Hour'] = this.getUTCHours();
    bag['Kind'] = this.kind;
    bag['Millisecond'] = this.getUTCMilliseconds();
    bag['Microsecond'] = Math.floor(this.subMillisecondTicks / 10);
    bag['Nanosecond'] = (this.subMillisecondTicks % 10) * 100;
    bag['Minute'] = this.getUTCMinutes();
    bag['Month'] = this.getUTCMonth() + 1;
    bag['Second'] = this.getUTCSeconds();
    // Int64 in pwsh, and 6.4e17 is far past Number.MAX_SAFE_INTEGER, so this
    // has to be a bigint or it would silently lose its low digits.
    bag['Ticks'] = BigInt(civilUtcMs) * 10000n + BigInt(this.subMillisecondTicks) + EPOCH_TICKS;
    bag['TimeOfDay'] = psTimeSpan(
      civilUtcMs - Date.UTC(this.getUTCFullYear(), this.getUTCMonth(), this.getUTCDate()),
    );
    bag['Year'] = this.getUTCFullYear();
    this.properties = Object.freeze(bag);
  }

  // The eight overrides that keep the civil fields out of the host's timezone.
  override getFullYear(): number { return this.getUTCFullYear(); }
  override getMonth(): number { return this.getUTCMonth(); }
  override getDate(): number { return this.getUTCDate(); }
  override getDay(): number { return this.getUTCDay(); }
  override getHours(): number { return this.getUTCHours(); }
  override getMinutes(): number { return this.getUTCMinutes(); }
  override getSeconds(): number { return this.getUTCSeconds(); }
  override getMilliseconds(): number { return this.getUTCMilliseconds(); }
}

/** Build one from civil components. */
export function psDateTime(
  parts: {
    year: number; month: number; day: number;
    hour?: number; minute?: number; second?: number; millisecond?: number;
  },
  options: PSDateTimeOptions = {},
): PSDateTime {
  return new PSDateTime(
    Date.UTC(
      parts.year, parts.month - 1, parts.day,
      parts.hour ?? 0, parts.minute ?? 0, parts.second ?? 0, parts.millisecond ?? 0,
    ),
    options,
  );
}

/**
 * Read the clock.
 *
 * `Kind` is Local, matching pwsh: a bare `Get-Date` reports Local, while
 * `Get-Date -Date '2026-03-04T05:06:07'` reports Unspecified. The civil time is
 * the instant SHIFTED by the session offset, because that is what a local
 * DateTime's components are.
 */
export function nowAsLocal(epochMs: number, offsetMinutes: number): PSDateTime {
  return new PSDateTime(epochMs + offsetMinutes * 60_000, { kind: 'Local', offsetMinutes });
}

function dayOfYear(value: Date): number {
  const start = Date.UTC(value.getUTCFullYear(), 0, 1);
  const here = Date.UTC(value.getUTCFullYear(), value.getUTCMonth(), value.getUTCDate());
  return Math.round((here - start) / 86_400_000) + 1;
}

/**
 * Epoch seconds, which depend on the Kind. Measured:
 *   -Date '2026-03-04T05:06:07'  -UFormat %s  ->  1772571967   (Unspecified: local)
 *   -Date '2026-03-04T05:06:07Z' -UFormat %s  ->  1772600767   (Utc)
 * The 28800-second gap is exactly the +08:00 the capture host was in.
 */
export function epochSeconds(value: PSDateTime): number {
  const civil = value.getTime();
  const instant = value.kind === 'Utc' ? civil : civil - value.offsetMinutes * 60_000;
  return Math.floor(instant / 1000);
}

// ---------------------------------------------------------------------------
// TimeSpan
// ---------------------------------------------------------------------------

export const TIMESPAN_TYPE_NAMES: readonly string[] = [
  'System.TimeSpan',
  'System.ValueType',
  'System.Object',
];

/**
 * A TimeSpan with the property set pwsh reports, in its order. Read off
 * `([timespan]::FromSeconds(3725.5)).PSObject.Properties`:
 *
 *   Ticks Days Hours Milliseconds Microseconds Nanoseconds Minutes Seconds
 *   TotalDays TotalHours TotalMilliseconds TotalMicroseconds TotalNanoseconds
 *   TotalMinutes TotalSeconds
 *
 * KNOWN GAP, stated rather than hidden: `"$ts"` in pwsh is `01:02:05.5000000`,
 * while `toPSString` on this object yields `System.TimeSpan`, because
 * to-string.ts prints the type name for any PSObject that is not a
 * PSCustomObject. Rendering a TimeSpan as text is a formatter's job and the
 * formatter is a separate component, so `timeSpanText` below is exported for it
 * rather than smuggled in as an extra property — a `Text` member that pwsh does
 * not have would make this object's shape a lie about a type it names.
 */
export function psTimeSpan(totalMilliseconds: number): PSObject {
  const sign = totalMilliseconds < 0 ? -1 : 1;
  const ms = Math.abs(totalMilliseconds);
  const ticks = BigInt(Math.round(ms)) * 10000n * BigInt(sign);
  const days = Math.floor(ms / 86_400_000);
  const hours = Math.floor(ms / 3_600_000) % 24;
  const minutes = Math.floor(ms / 60_000) % 60;
  const seconds = Math.floor(ms / 1000) % 60;
  const milliseconds = Math.floor(ms) % 1000;
  return psObject(
    {
      Ticks: ticks,
      Days: days * sign,
      Hours: hours * sign,
      Milliseconds: milliseconds * sign,
      Microseconds: 0,
      Nanoseconds: 0,
      Minutes: minutes * sign,
      Seconds: seconds * sign,
      TotalDays: totalMilliseconds / 86_400_000,
      TotalHours: totalMilliseconds / 3_600_000,
      TotalMilliseconds: totalMilliseconds,
      TotalMicroseconds: totalMilliseconds * 1000,
      TotalNanoseconds: totalMilliseconds * 1_000_000,
      TotalMinutes: totalMilliseconds / 60_000,
      TotalSeconds: totalMilliseconds / 1000,
    },
    TIMESPAN_TYPE_NAMES,
  );
}

/**
 * `[timespan]::ToString()`. Measured: whole seconds print `00:00:01`, a
 * fractional span prints all seven tick digits — `01:02:05.5000000`.
 */
export function timeSpanText(totalMilliseconds: number): string {
  const negative = totalMilliseconds < 0;
  const ms = Math.abs(totalMilliseconds);
  const days = Math.floor(ms / 86_400_000);
  const hours = Math.floor(ms / 3_600_000) % 24;
  const minutes = Math.floor(ms / 60_000) % 60;
  const seconds = Math.floor(ms / 1000) % 60;
  const fraction = Math.round(ms % 1000) * 10000;
  const head = days > 0 ? `${String(days)}.` : '';
  const tail = fraction > 0 ? `.${pad(fraction, 7)}` : '';
  return `${negative ? '-' : ''}${head}${pad(hours)}:${pad(minutes)}:${pad(seconds)}${tail}`;
}

// ---------------------------------------------------------------------------
// the offset, as the two format languages spell it
// ---------------------------------------------------------------------------

function offsetText(minutes: number, separator: string): string {
  const sign = minutes < 0 ? '-' : '+';
  const total = Math.abs(minutes);
  return `${sign}${pad(Math.floor(total / 60))}${separator}${pad(total % 60)}`;
}

/** The offset a given Kind reports. Unspecified has none; Utc is always zero. */
function kindOffset(value: PSDateTime): number | null {
  if (value.kind === 'Utc') return 0;
  if (value.kind === 'Local') return value.offsetMinutes;
  return null;
}

// ---------------------------------------------------------------------------
// -Format: the .NET format language
// ---------------------------------------------------------------------------

/** Raised for a format string .NET rejects. Mirrors the exception pwsh surfaces. */
export class DateFormatError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'DateFormatError';
  }
}

/**
 * .NET's standard date format specifiers, en-US. Every one measured against
 * pwsh 7.6.5 on 2026-03-04T05:06:07.0089:
 *
 *   d  3/4/2026                              D  Wednesday, March 4, 2026
 *   f  Wednesday, March 4, 2026 5:06 AM      F  Wednesday, March 4, 2026 5:06:07 AM
 *   g  3/4/2026 5:06 AM                      G  3/4/2026 5:06:07 AM
 *   m  March 4                               M  March 4
 *   o  2026-03-04T05:06:07.0089000           O  same
 *   r  Wed, 04 Mar 2026 05:06:07 GMT         R  same
 *   s  2026-03-04T05:06:07                   t  5:06 AM
 *   T  5:06:07 AM                            u  2026-03-04 05:06:07Z
 *   U  Tuesday, March 3, 2026 9:06:07 PM     y  March 2026
 *   Y  March 2026
 *
 * Plus PowerShell's own four:
 *   FileDate 20260304                        FileDateUniversal 20260303Z
 *   FileDateTime 20260304T0506070089         FileDateTimeUniversal 20260303T2106070089Z
 *
 * `U` and the Universal forms convert to UTC first, which is why they land on
 * the PREVIOUS day for a +08:00 session.
 */
const STANDARD_PATTERNS: Readonly<Record<string, string>> = {
  d: 'M/d/yyyy',
  D: 'dddd, MMMM d, yyyy',
  f: 'dddd, MMMM d, yyyy h:mm tt',
  F: 'dddd, MMMM d, yyyy h:mm:ss tt',
  g: 'M/d/yyyy h:mm tt',
  G: 'M/d/yyyy h:mm:ss tt',
  m: 'MMMM d',
  M: 'MMMM d',
  s: "yyyy-MM-ddTHH:mm:ss",
  t: 'h:mm tt',
  T: 'h:mm:ss tt',
  y: 'MMMM yyyy',
  Y: 'MMMM yyyy',
};

/** Convert to UTC for the specifiers that are defined in UTC terms. */
function toUtc(value: PSDateTime): PSDateTime {
  const offset = kindOffset(value) ?? value.offsetMinutes;
  return new PSDateTime(value.getTime() - offset * 60_000, {
    kind: 'Utc',
    offsetMinutes: value.offsetMinutes,
    subMillisecondTicks: value.subMillisecondTicks,
  });
}

export function formatDotNet(value: PSDateTime, format: string): string {
  if (format.length === 0) return formatDotNet(value, 'G');

  // A single character is a STANDARD specifier, never a custom one. This is the
  // trap the probe caught: `-Format 'd'` is 3/4/2026, not the day number, and
  // `-Format 'H'` is not the hour — it throws, because H is not a standard
  // specifier and a lone custom one is not accepted.
  if (format.length === 1) {
    const expanded = STANDARD_PATTERNS[format];
    if (expanded !== undefined) return expandCustom(value, expanded);
    if (format === 'o' || format === 'O') return roundTrip(value);
    // `R` does NOT convert to UTC; it formats the value as-is and appends GMT.
    // Measured: 2026-03-04T05:06:07 (Unspecified, +08:00 session) formats as
    // `Wed, 04 Mar 2026 05:06:07 GMT`, not as the 21:06 of the previous day.
    // Converting first was the obvious guess and it was wrong.
    if (format === 'r' || format === 'R') return rfc1123(value);
    if (format === 'u') return `${expandCustom(value, 'yyyy-MM-dd HH:mm:ss')}Z`;
    if (format === 'U') return expandCustom(toUtc(value), 'dddd, MMMM d, yyyy h:mm:ss tt');
    throw new DateFormatError('Input string was not in a correct format.');
  }

  if (format === 'FileDate') return expandCustom(value, 'yyyyMMdd');
  if (format === 'FileDateUniversal') return `${expandCustom(toUtc(value), 'yyyyMMdd')}Z`;
  if (format === 'FileDateTime') return expandCustom(value, "yyyyMMdd'T'HHmmssffff");
  if (format === 'FileDateTimeUniversal') {
    return `${expandCustom(toUtc(value), "yyyyMMdd'T'HHmmssffff")}Z`;
  }
  return expandCustom(value, format);
}

/** `o`/`O`. Measured: Unspecified has no suffix, Utc has `Z`, Local has the offset. */
function roundTrip(value: PSDateTime): string {
  const body = expandCustom(value, 'yyyy-MM-ddTHH:mm:ss.fffffff');
  if (value.kind === 'Utc') return `${body}Z`;
  if (value.kind === 'Local') return `${body}${offsetText(value.offsetMinutes, ':')}`;
  return body;
}

function rfc1123(value: PSDateTime): string {
  return (
    `${dayName(value.getUTCDay()).slice(0, 3)}, ${pad(value.getUTCDate())} ` +
    `${monthName(value.getUTCMonth()).slice(0, 3)} ${pad(value.getUTCFullYear(), 4)} ` +
    `${pad(value.getUTCHours())}:${pad(value.getUTCMinutes())}:${pad(value.getUTCSeconds())} GMT`
  );
}

/**
 * The custom format language, including its three quoting forms — `'x'`, `"x"`
 * and `\x` — all measured:
 *   yyyy\-MM   ->  2026-03      "lit" yyyy  ->  lit 2026     yyyy'T'MM -> 2026T03
 */
function expandCustom(value: PSDateTime, format: string): string {
  const hour12 = value.getUTCHours() % 12 === 0 ? 12 : value.getUTCHours() % 12;
  const fractionDigits = String(value.getUTCMilliseconds() * 10000 + value.subMillisecondTicks)
    .padStart(7, '0');

  let out = '';
  let i = 0;
  while (i < format.length) {
    const ch = format[i] ?? '';

    if (ch === '\\') {
      out += format[i + 1] ?? '';
      i += 2;
      continue;
    }
    if (ch === "'" || ch === '"') {
      const close = format.indexOf(ch, i + 1);
      if (close === -1) throw new DateFormatError('Input string was not in a correct format.');
      out += format.slice(i + 1, close);
      i = close + 1;
      continue;
    }

    let run = 1;
    while (format[i + run] === ch) run += 1;
    const token = ch.repeat(run);

    switch (ch) {
      case 'y':
        out += run === 1 ? String(value.getUTCFullYear() % 100)
          : run === 2 ? pad(value.getUTCFullYear() % 100)
          : pad(value.getUTCFullYear(), run);
        break;
      case 'M':
        out += run === 1 ? String(value.getUTCMonth() + 1)
          : run === 2 ? pad(value.getUTCMonth() + 1)
          : run === 3 ? monthName(value.getUTCMonth()).slice(0, 3)
          : monthName(value.getUTCMonth());
        break;
      case 'd':
        out += run === 1 ? String(value.getUTCDate())
          : run === 2 ? pad(value.getUTCDate())
          : run === 3 ? dayName(value.getUTCDay()).slice(0, 3)
          : dayName(value.getUTCDay());
        break;
      case 'H':
        out += run === 1 ? String(value.getUTCHours()) : pad(value.getUTCHours());
        break;
      case 'h':
        out += run === 1 ? String(hour12) : pad(hour12);
        break;
      case 'm':
        out += run === 1 ? String(value.getUTCMinutes()) : pad(value.getUTCMinutes());
        break;
      case 's':
        out += run === 1 ? String(value.getUTCSeconds()) : pad(value.getUTCSeconds());
        break;
      case 'f':
        out += fractionDigits.slice(0, Math.min(run, 7));
        break;
      case 'F': {
        // `F` is `f` with trailing zeros removed. Measured: FFF on .008 is 008.
        out += fractionDigits.slice(0, Math.min(run, 7)).replace(/0+$/, '');
        break;
      }
      case 't':
        out += run === 1
          ? (value.getUTCHours() < 12 ? 'A' : 'P')
          : (value.getUTCHours() < 12 ? 'AM' : 'PM');
        break;
      case 'g':
        out += 'AD';
        break;
      case 'z': {
        const offset = value.offsetMinutes;
        if (run === 1) throw new DateFormatError('Input string was not in a correct format.');
        out += run === 2 ? offsetText(offset, '').slice(0, 3) : offsetText(offset, ':');
        break;
      }
      case 'K': {
        const offset = kindOffset(value);
        if (run > 1) throw new DateFormatError('Input string was not in a correct format.');
        out += offset === null ? '' : value.kind === 'Utc' ? 'Z' : offsetText(offset, ':');
        break;
      }
      default:
        out += token;
    }
    i += run;
  }
  return out;
}

/**
 * The `DateTime` ScriptProperty every DateTime carries, which honours
 * DisplayHint. Measured on 2026-03-04T05:06:07:
 *   DisplayHint DateTime  ->  Wednesday, March 4, 2026 5:06:07 AM
 *   DisplayHint Date      ->  Wednesday, March 4, 2026
 *   DisplayHint Time      ->  5:06:07 AM
 */
export function longDateTimeString(value: PSDateTime, hint: DisplayHint): string {
  if (hint === 'Date') return expandCustom(value, 'dddd, MMMM d, yyyy');
  if (hint === 'Time') return expandCustom(value, 'h:mm:ss tt');
  return expandCustom(value, 'dddd, MMMM d, yyyy h:mm:ss tt');
}

// ---------------------------------------------------------------------------
// -UFormat: the strftime-shaped language
// ---------------------------------------------------------------------------

/**
 * Every specifier measured against pwsh 7.6.5 on 2026-03-04T05:06:07 (+08:00):
 *
 *   %a Wed        %A Wednesday   %b Mar        %B March      %C 20
 *   %c Wed 04 Mar 2026 05:06:07  %d 04         %D 03/04/26   %e " 4"
 *   %F 2026-03-04 %g 26          %G 2026       %h Mar        %H 05
 *   %I 05         %j 063         %k " 5"       %l " 5"       %m 03
 *   %M 06         %n newline     %p AM         %r 05:06:07 AM
 *   %R 05:06      %s 1772571967  %S 07         %t tab        %T 05:06:07
 *   %u 3          %U 9           %V 10         %w 3          %W 9
 *   %x 03/04/26   %X 05:06:07    %y 26         %Y 2026       %Z +08
 *   %% %
 *
 * An UNRECOGNISED specifier drops the `%` and keeps the letter: `%q` -> `q`.
 * That is measured, not assumed, and it is why the default branch below is not
 * an error. A trailing bare `%` throws IndexOutOfRangeException in pwsh — a
 * genuine upstream bug — which is NOT reproduced: it is recorded in the
 * manifest notes instead, because reproducing a crash buys nothing.
 */
export function formatUnix(value: PSDateTime, format: string): string {
  const hours = value.getUTCHours();
  const hour12 = hours % 12 === 0 ? 12 : hours % 12;
  const meridiem = hours < 12 ? 'AM' : 'PM';
  const year = value.getUTCFullYear();

  let out = '';
  let i = 0;
  while (i < format.length) {
    if (format[i] !== '%') {
      out += format[i] ?? '';
      i += 1;
      continue;
    }
    const spec = format[i + 1];
    if (spec === undefined) {
      // pwsh throws here. Emitting the stray percent is the conservative
      // choice; the note in the manifest says so.
      out += '%';
      i += 1;
      continue;
    }
    i += 2;
    switch (spec) {
      case 'a': out += dayName(value.getUTCDay()).slice(0, 3); break;
      case 'A': out += dayName(value.getUTCDay()); break;
      case 'b': case 'h': out += monthName(value.getUTCMonth()).slice(0, 3); break;
      case 'B': out += monthName(value.getUTCMonth()); break;
      case 'C': out += pad(Math.floor(year / 100)); break;
      case 'c':
        out += `${dayName(value.getUTCDay()).slice(0, 3)} ${pad(value.getUTCDate())} ` +
          `${monthName(value.getUTCMonth()).slice(0, 3)} ${pad(year, 4)} ` +
          `${pad(hours)}:${pad(value.getUTCMinutes())}:${pad(value.getUTCSeconds())}`;
        break;
      case 'd': out += pad(value.getUTCDate()); break;
      case 'D': case 'x':
        out += `${pad(value.getUTCMonth() + 1)}/${pad(value.getUTCDate())}/${pad(year % 100)}`;
        break;
      case 'e': out += String(value.getUTCDate()).padStart(2, ' '); break;
      case 'F': out += `${pad(year, 4)}-${pad(value.getUTCMonth() + 1)}-${pad(value.getUTCDate())}`; break;
      case 'g': out += pad(isoWeekYear(value) % 100); break;
      case 'G': out += String(isoWeekYear(value)); break;
      case 'H': out += pad(hours); break;
      case 'I': out += pad(hour12); break;
      case 'j': out += pad(dayOfYear(value), 3); break;
      case 'k': out += String(hours).padStart(2, ' '); break;
      case 'l': out += String(hour12).padStart(2, ' '); break;
      case 'm': out += pad(value.getUTCMonth() + 1); break;
      case 'M': out += pad(value.getUTCMinutes()); break;
      case 'n': out += '\n'; break;
      case 'p': out += meridiem; break;
      case 'r':
        out += `${pad(hour12)}:${pad(value.getUTCMinutes())}:${pad(value.getUTCSeconds())} ${meridiem}`;
        break;
      case 'R': out += `${pad(hours)}:${pad(value.getUTCMinutes())}`; break;
      case 's': out += String(epochSeconds(value)); break;
      case 'S': out += pad(value.getUTCSeconds()); break;
      case 't': out += '\t'; break;
      case 'T': case 'X':
        out += `${pad(hours)}:${pad(value.getUTCMinutes())}:${pad(value.getUTCSeconds())}`;
        break;
      // %u is ISO (Monday = 1, Sunday = 7); %w is C (Sunday = 0). Both measured
      // as 3 on a Wednesday, which is the one weekday where they agree — so the
      // discriminating case is a Sunday, and it is in the tests.
      case 'u': out += String(value.getUTCDay() === 0 ? 7 : value.getUTCDay()); break;
      case 'U': out += String(weekOfYear(value, 0)); break;
      case 'V': out += String(isoWeekNumber(value)); break;
      case 'w': out += String(value.getUTCDay()); break;
      case 'W': out += String(weekOfYear(value, 1)); break;
      case 'y': out += pad(year % 100); break;
      case 'Y': out += String(year); break;
      case 'Z': out += offsetText(value.offsetMinutes, '').slice(0, 3); break;
      case '%': out += '%'; break;
      default: out += spec;
    }
  }
  return out;
}

/** Weeks since the first `startDay` of the year. `%U` counts Sundays, `%W` Mondays. */
function weekOfYear(value: PSDateTime, startDay: number): number {
  const jan1 = new Date(Date.UTC(value.getUTCFullYear(), 0, 1));
  const offsetToFirst = (startDay - jan1.getUTCDay() + 7) % 7;
  const doy = dayOfYear(value);
  return Math.floor((doy - 1 - offsetToFirst + 7) / 7);
}

function isoWeekParts(value: PSDateTime): { year: number; week: number } {
  const target = new Date(Date.UTC(value.getUTCFullYear(), value.getUTCMonth(), value.getUTCDate()));
  // ISO weeks run Monday..Sunday and belong to the year holding their Thursday.
  const dayNumber = (target.getUTCDay() + 6) % 7;
  target.setUTCDate(target.getUTCDate() - dayNumber + 3);
  const isoYear = target.getUTCFullYear();
  const firstThursday = new Date(Date.UTC(isoYear, 0, 4));
  const firstDayNumber = (firstThursday.getUTCDay() + 6) % 7;
  firstThursday.setUTCDate(firstThursday.getUTCDate() - firstDayNumber + 3);
  const week = 1 + Math.round((target.getTime() - firstThursday.getTime()) / (7 * 86_400_000));
  return { year: isoYear, week };
}

const isoWeekYear = (value: PSDateTime): number => isoWeekParts(value).year;
const isoWeekNumber = (value: PSDateTime): number => isoWeekParts(value).week;
