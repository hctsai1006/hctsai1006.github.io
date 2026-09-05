/**
 * services.ts — the ambient things a native command is not allowed to reach for.
 *
 * Three of the commands in this directory are non-deterministic by nature:
 * `Get-Date` reads a clock, `Get-Random` and `New-Guid` read entropy. A test
 * that calls `Date.now()` or `Math.random()` through them can assert almost
 * nothing, and a differential harness that compared such a command against a
 * recording would fail for a reason that has nothing to do with fidelity.
 *
 * So the ambient state is an argument. Every command module in this directory
 * is produced by a factory taking `NativeServices`; `NATIVE_COMMANDS` binds the
 * real ones, and a test binds a fixed clock and a counting RNG. There is no
 * `Date.now()` and no `Math.random()` anywhere else in this directory, and the
 * unit tests assert that by grepping — see native-services.test.mts.
 *
 * `InvocationContext` was deliberately NOT widened to carry these. It is the
 * contract three layers already agreed on, and a clock is not something every
 * command needs; adding it there would make every future command's context
 * depend on the two that read one.
 */

import type { CommandManifest } from '../manifest.ts';

// ---------------------------------------------------------------------------
// the clock
// ---------------------------------------------------------------------------

/**
 * A wall clock, with its offset from UTC.
 *
 * The offset is a separate reading rather than something derived from the
 * timestamp because PowerShell's DateTime carries a `Kind` (Unspecified, Utc,
 * Local) and several of its formats depend on the local offset without
 * depending on the instant:
 *
 *   pwsh 7.6.5, host at UTC+08:00
 *     Get-Date -Date '2026-03-04T05:06:07' -UFormat '%Z'   ->  +08
 *     Get-Date -Date '2026-03-04T05:06:07' -Format 'zzz'   ->  +08:00
 *     Get-Date -Date '2026-03-04T05:06:07' -UFormat '%s'   ->  1772571967
 *     Get-Date -Date '2026-03-04T05:06:07Z' -UFormat '%s'  ->  1772600767
 *
 * The last pair is the whole reason: the same civil time yields two different
 * epoch seconds depending on the Kind, and the gap is exactly the offset. A
 * clock that only reported an instant could not reproduce either line.
 */
export interface Clock {
  /** Milliseconds since the Unix epoch. */
  now(): number;
  /**
   * Minutes to ADD to UTC to reach local time. `+480` is UTC+08:00.
   *
   * Note the sign: this is the opposite of JavaScript's
   * `Date.prototype.getTimezoneOffset()`, which returns `-480` for UTC+08:00.
   * The sign here is the one humans and .NET write, so `+08:00` renders from a
   * positive number rather than from a negation nobody remembers to apply.
   */
  offsetMinutes(): number;
}

/** The real clock. The only place in this directory that reads ambient time. */
export function systemClock(): Clock {
  return {
    now: () => Date.now(),
    offsetMinutes: () => -new Date().getTimezoneOffset(),
  };
}

/**
 * A clock that does not move. Every test in this directory uses one.
 *
 * @param instant  an ISO 8601 timestamp, interpreted as UTC
 * @param offsetMinutes  the session's offset from UTC, in the .NET sign
 */
export function fixedClock(instant: string, offsetMinutes = 0): Clock {
  const epoch = Date.parse(instant);
  if (Number.isNaN(epoch)) throw new RangeError(`fixedClock: unparseable instant ${instant}`);
  return { now: () => epoch, offsetMinutes: () => offsetMinutes };
}

// ---------------------------------------------------------------------------
// randomness
// ---------------------------------------------------------------------------

/**
 * A source of uniform doubles in [0, 1).
 *
 * `-SetSeed` is part of Get-Random's contract — `Get-Random -SetSeed 1` twice
 * in pwsh 7.6.5 yields 42389573 both times — so the source has to be seedable.
 * The SEQUENCE is not reproduced: it comes from .NET's `Random`, whose exact
 * algorithm is an implementation detail this project has no way to mirror and
 * no business pretending to. What is reproduced is that seeding is idempotent
 * and that a seeded session replays, which is the observable a script depends
 * on. The divergence is declared in the Get-Random manifest rather than hidden.
 */
export interface RandomSource {
  /** A double in [0, 1). */
  next(): number;
  /** Restart the sequence. Must make `next()` replay exactly. */
  setSeed(seed: number): void;
}

/**
 * A seedable PRNG: mulberry32, chosen because it is eight lines, deterministic
 * across engines, and has no dependency. It is NOT a CSPRNG and must never be
 * used for anything that needs one — which is also true of .NET's `Random`, and
 * is why `New-Guid` takes its own source rather than borrowing this one.
 */
export function seededRandom(seed = 0): RandomSource {
  let state = seed >>> 0;
  return {
    next(): number {
      state = (state + 0x6d2b79f5) >>> 0;
      let t = state;
      t = Math.imul(t ^ (t >>> 15), t | 1);
      t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
      return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
    },
    setSeed(next: number): void {
      state = next >>> 0;
    },
  };
}

/** The real one: unseeded, and reseedable only through `-SetSeed`. */
export function systemRandom(): RandomSource {
  let seeded: RandomSource | null = null;
  return {
    next: () => (seeded === null ? Math.random() : seeded.next()),
    setSeed: (seed: number) => {
      seeded = seededRandom(seed);
    },
  };
}

// ---------------------------------------------------------------------------
// history
// ---------------------------------------------------------------------------

/**
 * One entry as `Get-History` reports it. The field names and their order are
 * the ones pwsh 7.6.5 puts on `Microsoft.PowerShell.Commands.HistoryInfo`:
 *
 *   Id CommandLine ExecutionStatus StartExecutionTime EndExecutionTime Duration
 *
 * `Duration` is derived, not stored, for the same reason profile.json's counts
 * are never re-derived: two numbers that must agree are exactly where drift
 * starts.
 */
export interface HistoryEntry {
  readonly id: number;
  readonly commandLine: string;
  /** A `System.Management.Automation.Runspaces.PipelineState` name. */
  readonly executionStatus: PipelineStateName;
  /** Epoch milliseconds. */
  readonly startedAt: number;
  readonly endedAt: number;
}

/**
 * The PipelineState names pwsh reports, read off
 * `[enum]::GetNames([System.Management.Automation.Runspaces.PipelineState])`.
 */
export type PipelineStateName =
  | 'NotStarted'
  | 'Running'
  | 'Stopping'
  | 'Stopped'
  | 'Completed'
  | 'Failed'
  | 'Disconnected';

export interface HistoryStore {
  /** Oldest first, which is the order Get-History emits. */
  entries(): readonly HistoryEntry[];
}

/** A history that is whatever you hand it. Used by the session and by tests. */
export function historyOf(entries: readonly HistoryEntry[]): HistoryStore {
  const snapshot = [...entries];
  return { entries: () => snapshot };
}

// ---------------------------------------------------------------------------
// the terminal
// ---------------------------------------------------------------------------

/**
 * What `Clear-Host` is allowed to do.
 *
 * A command never touches the DOM, so clearing the screen is a request the host
 * grants — and `Clear-Host` must ask the capability broker for
 * `terminal.control` before making it. The broker is the enforcement; this is
 * the effect it is enforcing access to.
 */
export interface TerminalControl {
  clear(): void;
}

/** Records the calls instead of making them. The default, and what tests use. */
export function recordingTerminal(): TerminalControl & { readonly clears: number } {
  let clears = 0;
  return {
    clear: (): void => {
      clears += 1;
    },
    get clears(): number {
      return clears;
    },
  };
}

// ---------------------------------------------------------------------------
// the machine identity
// ---------------------------------------------------------------------------

/**
 * The simulated machine `$PSVersionTable` and `whoami` describe.
 *
 * FLAGGED AS FICTION ON PURPOSE. The `$PSVersionTable` manifest already says
 * that OS and Platform "describe the simulated Ubuntu machine — the same
 * fiction uname and hostname report — and are not your computer", and this is
 * the value that sentence is about. The version fields are NOT here: they come
 * from the release lock and the resolved compatibility profile, because this
 * repository has a whole tool devoted to version truth and a second copy of a
 * version string would be a place for the two to disagree.
 */
export interface MachineIdentity {
  readonly userName: string;
  readonly hostName: string;
  readonly homeDirectory: string;
  /** What `$PSVersionTable.OS` reports. Simulated. */
  readonly os: string;
  /** What `$PSVersionTable.Platform` reports. Simulated. */
  readonly platform: string;
}

/** The identity v1 presented, kept so the two terminals describe one machine. */
export const SIMULATED_MACHINE: MachineIdentity = {
  userName: 'thc1006',
  hostName: 'thc1006-dev',
  homeDirectory: '/home/thc1006',
  os: 'Linux 6.8.0-51-generic #52-Ubuntu SMP PREEMPT_DYNAMIC',
  platform: 'Unix',
};

// ---------------------------------------------------------------------------
// the command catalogue
// ---------------------------------------------------------------------------

/**
 * `System.Management.Automation.CommandTypes`, plus the one label that is not a
 * member of it.
 *
 * `Variable` is v1's word for `$PSVersionTable`, carried through
 * `src/commands/v1-inventory.json`. Real PowerShell would answer
 * CommandNotFound for it, because a variable is not a command — but this
 * terminal does run it as one, and calling it a Cmdlet would be a worse lie
 * than using a label that is visibly not a CommandTypes member.
 */
export type CommandTypeName =
  | 'Alias'
  | 'Function'
  | 'Filter'
  | 'Cmdlet'
  | 'ExternalScript'
  | 'Application'
  | 'Script'
  | 'Configuration'
  | 'Variable';

export interface CatalogueEntry {
  readonly manifest: CommandManifest;
  readonly commandType: CommandTypeName;
}

/**
 * What `Get-Command` and `Get-Help` are allowed to know.
 *
 * Deliberately every declared command rather than only the modules in this
 * directory: the catalogue has to contain commands that are declared but
 * implemented elsewhere — the browser-backed filesystem ones, the simulated
 * ones — because `Get-Command` reporting only what this directory implements
 * would be a wrong answer wearing an honest face.
 */
export interface CommandCatalogue {
  all(): readonly CatalogueEntry[];
}

export function catalogueOf(entries: readonly CatalogueEntry[]): CommandCatalogue {
  const snapshot = [...entries];
  return { all: () => snapshot };
}

// ---------------------------------------------------------------------------
// everything at once
// ---------------------------------------------------------------------------

export interface NativeServices {
  readonly clock: Clock;
  readonly random: RandomSource;
  readonly guidRandom: RandomSource;
  readonly history: HistoryStore;
  readonly terminal: TerminalControl;
  readonly machine: MachineIdentity;
  readonly catalogue: CommandCatalogue;
}
