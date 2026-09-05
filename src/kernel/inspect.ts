/**
 * inspect.ts — the read-only half of the kernel, and the reason it has to exist.
 *
 * ---------------------------------------------------------------------------
 * `readonly` IS A COMPILER OPINION, NOT A RUNTIME BOUNDARY
 * ---------------------------------------------------------------------------
 *
 * The broker used to hand its own state back through getters typed as
 * read-only:
 *
 *     get grants(): ReadonlySet<Capability> { return this.#granted; }
 *     get policy(): VirtualPolicy           { return this.#policy;  }
 *     get audit(): AuditLog                 { return this.#audit;   }
 *
 * Every one of those returns the LIVE object. `ReadonlySet<T>` and `readonly`
 * are erased before a single byte runs, so this worked against the real kernel:
 *
 *     grants before                       => filesystem.read
 *     cast ReadonlySet -> Set and add()   => filesystem.read,filesystem.write
 *     policy object mutable?              => ["injected"]
 *     audit.records push / truncate       => 1 / 0
 *
 * A caller granted itself a capability the kernel was never given, injected a
 * property into the privilege object, and both forged and erased audit lines.
 * That breaks two claims this project makes out loud: that elevation cannot
 * obtain a real capability, and that the audit log is a reliable append-only
 * record. Neither survives `as Set`.
 *
 * `Object.freeze` on the Set is NOT the fix, and believing it is would be worse
 * than the bug. Measured on Node 24.13.0:
 *
 *     const s = new Set(['a']); Object.freeze(s); s.add('b');
 *     => a,b   (Object.isFrozen(s) === true)
 *
 * Set mutation goes through internal slots, not properties, so freezing changes
 * nothing at all. The same is true of Map and of a Date's timestamp.
 *
 * WHAT ACTUALLY WORKS, and what this file is built out of:
 *
 *   1. Hand back a DIFFERENT OBJECT that has no mutator on it. `(view as Set)
 *      .add(x)` then fails with `view.add is not a function` — a loud failure
 *      rather than a silent no-op, which matters because a caller who thinks a
 *      mutation succeeded is worse off than one who gets an error.
 *   2. Freeze that object, so nothing can be bolted onto it either. Measured:
 *      assignment to a frozen object's property throws TypeError under the
 *      module strict mode every file here runs in.
 *   3. Read THROUGH to the live state rather than copying it once, so a view
 *      cannot go stale and start lying in the other direction.
 *   4. Copy — and freeze the copy — for anything that hands out a container:
 *      `records` returns a fresh frozen array on every read, so the same
 *      reference is never shared twice and `push` throws.
 *
 * ---------------------------------------------------------------------------
 * THE LIMIT, STATED PLAINLY: A CAPABILITY BROKER IS NOT A SANDBOX
 * ---------------------------------------------------------------------------
 *
 * Everything in this file bounds what code reaches THROUGH THE KERNEL. It does
 * not, and cannot, bound what code reaches around it. Anything sharing this
 * Worker's global object can call `fetch`, open IndexedDB, read
 * `localStorage`, use `navigator` and touch every other browser API directly,
 * whatever the broker decides — no import is needed and no manifest is
 * consulted. The broker's guarantee is therefore precisely this and no more:
 *
 *   - a command that goes through `InvocationContext` cannot obtain a
 *     capability it did not declare and was not granted, and
 *   - what it did obtain is on the record.
 *
 * That is worth having: it makes the manifest enforceable and it makes `sudo`
 * honest. It is NOT isolation, and no wording anywhere should suggest it is.
 * The real boundary is a separate Worker or a sandboxed iframe with a
 * message-only API and no shared global — ROADMAP 14.3, "run third-party
 * modules in a sandboxed worker behind a capability broker" — and it is future
 * work. Until it exists, "the kernel decides" describes commands that ASK.
 */

import type { Capability, CommandManifest } from '../commands/manifest.ts';
import type { AuditListener, AuditRecord, CapabilityDecision } from './capabilities.ts';
import type { JobId, ProcessGroupId, ProcessId, RequestId, TerminalId } from './ids.ts';
import type { JobListener, JobOutput, JobSnapshot } from './process/jobs.ts';
import type { ProcessSnapshot } from './process/snapshot.ts';
import type { ProcessListener } from './process/table.ts';
import type { VirtualSignal } from './signals.ts';

// ---------------------------------------------------------------------------
// the primitives the views are built from
// ---------------------------------------------------------------------------

/**
 * A `ReadonlySet` that is read-only at RUNTIME, reading through to `inner`.
 *
 * `add`, `delete` and `clear` are absent rather than present-and-throwing, so
 * `(x as Set<T>).add(v)` dies on the lookup with `x.add is not a function`.
 * Present-and-throwing would work too; absent is better because it also fails
 * a `typeof x.add === 'function'` probe, so code that feature-detects gets the
 * right answer instead of a surprise at call time.
 *
 * It is NOT a `Set` — `instanceof Set` is false — which is the price. Nothing
 * should be branching on that for a value typed `ReadonlySet`, and a caller who
 * wants a real Set can build one from the iterator, which is exactly the copy
 * it should have been making anyway.
 */
export function readonlySetView<T>(inner: ReadonlySet<T>): ReadonlySet<T> {
  return Object.freeze({
    get size(): number {
      return inner.size;
    },
    has: (value: T): boolean => inner.has(value),
    keys: () => inner.keys(),
    values: () => inner.values(),
    entries: () => inner.entries(),
    forEach: (
      callback: (value: T, value2: T, set: ReadonlySet<T>) => void,
      thisArg?: unknown,
    ): void => {
      inner.forEach(callback, thisArg);
    },
    [Symbol.iterator]: () => inner[Symbol.iterator](),
  });
}

/**
 * A frozen copy of a list.
 *
 * A copy, not the live array, because the array is the container the caller
 * would otherwise be able to splice; and frozen, so `push` throws instead of
 * appending to a snapshot the caller then believes is the log. Both halves are
 * load-bearing: the live array alone was mutable, and an unfrozen copy would
 * have let a caller believe a fabricated record had been recorded.
 */
export function frozenList<T>(items: Iterable<T>): readonly T[] {
  return Object.freeze([...items]);
}

// ---------------------------------------------------------------------------
// the views
// ---------------------------------------------------------------------------

/** Processes, without the ability to create, transition, exit or reap one. */
export interface ProcessView {
  /** The pid the next `create` will return. For tests and for a UI, not logic. */
  readonly nextPid: ProcessId;
  get(pid: ProcessId): ProcessSnapshot | undefined;
  list(): readonly ProcessSnapshot[];
  live(): readonly ProcessSnapshot[];
  membersOf(pgid: ProcessGroupId): readonly ProcessSnapshot[];
  byTerminal(terminalId: TerminalId): readonly ProcessSnapshot[];
  byRequest(requestId: RequestId): readonly ProcessSnapshot[];
  /**
   * Subscribing is not mutating. The listener receives frozen snapshots and the
   * returned closure removes only that listener, so the worst a subscriber can
   * do is stop listening.
   */
  onChange(listener: ProcessListener): () => void;
}

/** Jobs, without the ability to start, buffer, drain, finish or remove one. */
export interface JobView {
  readonly nextId: JobId;
  get(id: JobId): JobSnapshot | undefined;
  byPid(pid: ProcessId): JobSnapshot | undefined;
  list(): readonly JobSnapshot[];
  /**
   * What `Receive-Job -Keep` would return, WITHOUT the drain.
   *
   * `receive` is deliberately not here. Its default is destructive — PowerShell's
   * is, so a second `Receive-Job` returns nothing — which makes it a mutator
   * wearing a getter's name: anything holding a JobView could empty a job's
   * buffer and the output would be gone before `Receive-Job` ever ran.
   */
  peek(id: JobId): JobOutput;
  onChange(listener: JobListener): () => void;
}

/** Signal routing, without the ability to deliver one. */
export interface SignalView {
  groupOf(pid: ProcessId): ProcessGroupId | undefined;
  members(pgid: ProcessGroupId): readonly ProcessId[];
  deliveredTo(pid: ProcessId): VirtualSignal | undefined;
  foregroundGroup(terminalId: TerminalId): ProcessGroupId | undefined;
}

/**
 * The audit log as a reader sees it: append-only, and with no append on it.
 *
 * `append` and the listener set stay inside `AuditLog`. `clear` no longer
 * exists anywhere — see the note on `AuditLog` itself.
 */
export interface AuditView {
  readonly size: number;
  /** A fresh frozen array each read. Never the log's own container. */
  readonly records: readonly AuditRecord[];
  /** Just the denials — the query a reviewer actually runs. */
  denials(): readonly AuditRecord[];
  onAppend(listener: AuditListener): () => void;
}

/**
 * The privilege state, readable and not writable.
 *
 * Reads THROUGH to the live policy rather than copying it, so a view taken
 * before a `sudo` reports the elevation afterwards. A snapshot would have been
 * a second kind of lie: correct at the moment it was taken and wrong from then
 * on, in a UI whose whole job is to show whether you are elevated.
 */
export interface PolicyView {
  readonly elevated: boolean;
  /** What `whoami` prints. A string in a simulation, and nothing more. */
  readonly user: string;
}

/**
 * The broker as everything outside the kernel sees it.
 *
 * `forCommand` is NOT here, and that is the sharpest edge on this interface.
 * The scoped object it returns can `require` and `elevate`, and `require`
 * WRITES AN AUDIT RECORD carrying a caller-supplied manifest, display name and
 * pid. It cannot grant anything — both gates still run — but it can fill the
 * log with plausible lines attributed to commands that never ran, which is the
 * same integrity failure as being able to delete lines, approached from the
 * other side. Issuing scoped capabilities is the kernel's job, at the one place
 * a real invocation happens.
 */
export interface CapabilityView {
  /** What this session may do. Runtime-immutable; see `readonlySetView`. */
  readonly grants: ReadonlySet<Capability>;
  readonly policy: PolicyView;
  readonly audit: AuditView;
  /** Decide, without auditing and without throwing. */
  evaluate(manifest: CommandManifest, capability: Capability): CapabilityDecision;
  /** Would this request leave a trace, whatever the answer? */
  shouldAudit(
    manifest: CommandManifest,
    capability: Capability,
    decision: CapabilityDecision,
  ): boolean;
}
