/**
 * capabilities.ts — the broker that makes the manifest enforceable.
 *
 * `manifest.ts` says a command declares what it needs, and `invocation.ts` says
 * a command "never touches a browser API directly, it asks the kernel, and the
 * kernel decides". This file is that decision. Without it, `capabilities: []`
 * on a manifest is documentation — and documentation that nothing checks is
 * eventually wrong.
 *
 * Two gates, both required, in this order:
 *
 *   1. DECLARED.  The capability must appear in the command's own manifest.
 *      A command asking for something it did not declare is denied even when
 *      the user has granted it. This is what stops the manifest drifting: the
 *      only way to gain a capability is to declare it, and a declaration is
 *      visible in `Get-Command -Detailed` and reviewable in a diff.
 *
 *   2. GRANTED.  The user (or the profile, or the package trust level) must
 *      have granted it. Declaration is a request, never an entitlement.
 *
 * ---------------------------------------------------------------------------
 * WHY `virtual.policy.elevate` CANNOT CONFER ANYTHING REAL
 * ---------------------------------------------------------------------------
 *
 * `sudo` in this emulator is `simulated` fidelity: it changes a prompt and a
 * virtual uid, and grants nothing. That claim is easy to make in a comment and
 * easy to break in code — someone adds `if (elevated) return true` to a
 * permission check because it "obviously" should work that way, and the page
 * now has a privilege model that lies.
 *
 * So the scope of elevation is data, not judgement:
 *
 *   CAPABILITY_REALITY   classifies every capability as real or virtual, as an
 *                        exhaustive Record over the union — adding a capability
 *                        to `manifest.ts` fails to compile until it is
 *                        classified, so nothing can be introduced unclassified.
 *
 *   ELEVATION_CONFERS    what holding an elevation adds. Empty, and checked
 *                        against CAPABILITY_REALITY at module load AND on every
 *                        grant computation, so a future edit that makes it
 *                        non-empty with anything real throws instead of
 *                        shipping.
 *
 * And the check itself has a distinct denial code — `denied:elevation-not-transferable`
 * — so "I was root and it still said no" is an observable, testable outcome
 * rather than an absence of behaviour.
 *
 * ---------------------------------------------------------------------------
 * WHAT THIS FILE DOES NOT CLAIM
 * ---------------------------------------------------------------------------
 *
 * A capability broker is NOT a sandbox. It decides what a command gets when it
 * ASKS; it cannot stop code that does not ask. Anything sharing this Worker's
 * global can call `fetch`, IndexedDB, `localStorage`, `navigator` and every
 * other browser API directly, with no import and no manifest, and nothing here
 * observes it — the audit log would show nothing, because nothing was asked.
 *
 * So the guarantee is exactly: a command reached through `InvocationContext`
 * cannot obtain an undeclared or ungranted capability, and what it did obtain
 * is on the record. Isolation is a different mechanism — a separate Worker or
 * sandboxed iframe with a message-only API and no shared global, ROADMAP 14.3 —
 * and it does not exist yet. `inspect.ts` states the same limit at the surface
 * where a reader meets it.
 */

import { CapabilityDeniedError } from '../commands/invocation.ts';
import type { Capability, CommandManifest, Fidelity, Risk } from '../commands/manifest.ts';
import type { ProcessId } from './ids.ts';
import { frozenList, readonlySetView } from './inspect.ts';
import type { AuditView, CapabilityView, PolicyView } from './inspect.ts';

// ---------------------------------------------------------------------------
// the classification tables
// ---------------------------------------------------------------------------

/**
 * Does exercising this capability reach anything outside the simulated policy
 * engine — the browser, the origin, persisted state, the network, a device?
 *
 * Everything is real except the one capability that exists to be virtual. That
 * asymmetry is the point: it means "elevation confers only virtual
 * capabilities" reduces to "elevation confers only itself", which is a
 * statement a machine can check.
 *
 * `Record<Capability, boolean>` rather than a Set, so the compiler requires an
 * entry for every member of the union.
 */
export const CAPABILITY_REALITY: Record<Capability, boolean> = Object.freeze({
  'filesystem.read': true,
  'filesystem.write': true,
  'filesystem.delete': true,
  'portfolio.read': true,
  'preferences.write': true,
  'terminal.control': true,
  'ui.dialog': true,
  'process.read': true,
  'process.control': true,
  'network.fetch': true,
  'clipboard.read': true,
  'clipboard.write': true,
  'device.request': true,
  // The only virtual one. It moves a number inside a policy engine we wrote.
  'virtual.policy.elevate': false,
});

/**
 * Which capabilities always produce an audit record.
 *
 * Covers writes, deletes, network and device, plus the privileged simulation
 * itself. `clipboard.read` is audited despite writing nothing: reading the
 * user's clipboard is a disclosure, and an audit log that records only
 * modifications would miss the most privacy-sensitive thing a page can do.
 * `process.control` is audited because stopping someone else's job is a state
 * change the user should be able to review after the fact.
 */
export const CAPABILITY_AUDITED: Record<Capability, boolean> = Object.freeze({
  'filesystem.read': false,
  'filesystem.write': true,
  'filesystem.delete': true,
  'portfolio.read': false,
  'preferences.write': true,
  'terminal.control': false,
  'ui.dialog': false,
  'process.read': false,
  'process.control': true,
  'network.fetch': true,
  'clipboard.read': true,
  'clipboard.write': true,
  'device.request': true,
  'virtual.policy.elevate': true,
});

/**
 * The same question asked of the command's declared risk.
 *
 * Both directions are checked, because they fail differently. A command that
 * under-declares its capabilities is still caught by its risk level, and a
 * command that under-declares its risk is still caught by the capability it
 * actually asked for. Relying on either alone leaves a gap that a single wrong
 * line in one manifest opens.
 */
/*
 * FROZEN, like its two siblings above. Two independent reviews arrived at this
 * table from opposite directions and both flagged it: it was the one capability
 * table that was not frozen, so anything holding a reference could flip
 * `RISK_AUDITED.destructive` to false at runtime and silently stop auditing
 * every destructive command -- and the audit record is the only thing that makes
 * the simulated policy engine's claims checkable at all.
 */
export const RISK_AUDITED: Record<Risk, boolean> = Object.freeze({
  read: false,
  // Network. Named for what it is from the user's side: it leaves the page.
  'query-external': true,
  write: true,
  destructive: true,
  device: true,
  'privileged-simulation': true,
});

/**
 * What an elevation adds to a grant set. DELIBERATELY EMPTY.
 *
 * If this ever becomes non-empty, every entry must be virtual — enforced by
 * `assertElevationCannotConferReality` below, which runs at module load and
 * again on every grant computation.
 */
export const ELEVATION_CONFERS: readonly Capability[] = Object.freeze([]);

/** What the UI must show, every time, when something elevates. */
export const ELEVATION_DISCLOSURE =
  'Elevated inside the simulated policy engine only. This grants nothing to the ' +
  'browser, the origin, or the host: no file, no network request and no device ' +
  'becomes reachable that was not already.';

/** Raised when the elevation scope invariant is violated. Never caught. */
export class ElevationScopeError extends Error {
  readonly capability: Capability;
  constructor(capability: Capability) {
    super(
      `virtual.policy.elevate cannot confer ${capability}, which is a real capability. ` +
        'Simulated elevation grants nothing outside the virtual policy engine; if this ' +
        'capability is genuinely meant to be virtual, classify it in CAPABILITY_REALITY.',
    );
    this.name = 'ElevationScopeError';
    this.capability = capability;
  }
}

/**
 * The invariant, as a callable so the tests can assert on it directly rather
 * than inferring it from an import side effect.
 */
export function assertElevationCannotConferReality(): void {
  for (const capability of ELEVATION_CONFERS) {
    if (CAPABILITY_REALITY[capability]) throw new ElevationScopeError(capability);
  }
}

// Runs at import. A build that violates the invariant fails on first load
// rather than on the first `sudo`.
assertElevationCannotConferReality();

/**
 * Every capability that reaches outside the simulation.
 *
 * Wrapped rather than exported as a bare Set: `Object.freeze` does NOT stop
 * `Set.add`, so a module constant typed `ReadonlySet` was `(REAL_CAPABILITIES
 * as Set).delete('filesystem.write')` away from misreporting reality to every
 * reader. The decision path reads `CAPABILITY_REALITY` and would not have been
 * fooled, but a UI listing what is real would have been, and the next reader to
 * reach for this set for a decision would have inherited a live hole.
 */
export const REAL_CAPABILITIES: ReadonlySet<Capability> = readonlySetView(
  new Set((Object.keys(CAPABILITY_REALITY) as Capability[]).filter((c) => CAPABILITY_REALITY[c])),
);

/** Every capability that exists only inside it. Read-only for the same reason. */
export const VIRTUAL_CAPABILITIES: ReadonlySet<Capability> = readonlySetView(
  new Set((Object.keys(CAPABILITY_REALITY) as Capability[]).filter((c) => !CAPABILITY_REALITY[c])),
);

// ---------------------------------------------------------------------------
// decisions and the audit record
// ---------------------------------------------------------------------------

export type CapabilityDecision =
  | 'granted'
  /** Not in the command's own manifest. Gate 1. */
  | 'denied:undeclared'
  /** Declared, but not granted to this session. Gate 2. */
  | 'denied:not-granted'
  /**
   * Declared, not granted, and the caller holds a simulated elevation that
   * does not help. Its own code so that the honesty claim is observable.
   */
  | 'denied:elevation-not-transferable';

export function isGranted(decision: CapabilityDecision): boolean {
  return decision === 'granted';
}

/**
 * One line of the audit log. Plain data, so it can be shown in a UI, exported,
 * or sent across the worker boundary under the rules in `protocol.ts`.
 */
export interface AuditRecord {
  /**
   * Monotonic, from a counter rather than a clock. Two records written in the
   * same millisecond must still have an order, and an audit log whose entries
   * can tie is one whose ordering cannot be argued from.
   */
  readonly sequence: number;
  readonly at: number;
  readonly pid: ProcessId;
  readonly command: string;
  readonly capability: Capability;
  readonly risk: Risk;
  readonly fidelity: Fidelity;
  readonly decision: CapabilityDecision;
  /** What was acted on — a path, a URL, a device name. Null when there is none. */
  readonly target: string | null;
  /**
   * Did anything outside this page actually become reachable?
   *
   * False for every `virtual.policy.elevate` record, always. This is the field
   * a reviewer scans, and it is what makes a log full of `sudo` lines readable
   * as "nothing happened" rather than alarming.
   */
  readonly real: boolean;
  /** The disclosure the UI must show, or null when none is required. */
  readonly disclosure: string | null;
}

export type AuditListener = (record: AuditRecord) => void;

/**
 * Append-only. Nothing removes an entry, and there is nothing that can.
 *
 * `clear()` USED TO EXIST HERE and is deliberately gone. A log with a public
 * `clear` is not append-only, it is append-mostly, and the difference is the
 * whole value of the thing: the question an audit log answers is "did anything
 * try?", which a log that can be emptied cannot answer. Nothing in `src/` ever
 * called it — its only caller was a test asserting that the sequence did not
 * restart afterwards — so it was a hole with no user, and the property that
 * test defended is now covered by the counter test beside it.
 *
 * `records` hands back a FROZEN COPY on every read rather than the container.
 * Returning `this.#records` was a live array: `(audit.records as unknown[])
 * .push(fake)` appended a fabricated line and `.length = 0` erased the log,
 * both measured against the real class. The copy costs O(n) per read, which is
 * the right trade for something a UI reads occasionally and a reviewer reads
 * once.
 *
 * THE LOG GROWS WITH THE SESSION and nothing trims it, which is a real limit
 * now that `clear` is gone. That is deliberate rather than overlooked: a
 * bounded log silently drops the oldest evidence, which is the evidence most
 * worth keeping. If a tab open for days ever makes this matter, the answer is a
 * VIEW that pages or filters, or a trim that writes a tamper-evident marker
 * record saying what it dropped — not a method that removes entries quietly.
 */
export class AuditLog {
  #sequence = 1;
  readonly #records: AuditRecord[] = [];
  readonly #listeners = new Set<AuditListener>();
  #view: AuditView | null = null;

  constructor() {
    // Blocks property injection onto the log object itself. Private fields live
    // in internal slots, so `#records.push` and `#sequence += 1` still work —
    // verified on Node 24.13.0 rather than assumed.
    Object.freeze(this);
  }

  append(record: Omit<AuditRecord, 'sequence'>): AuditRecord {
    const stamped: AuditRecord = Object.freeze({ sequence: this.#sequence, ...record });
    this.#sequence += 1;
    this.#records.push(stamped);
    for (const listener of [...this.#listeners]) listener(stamped);
    return stamped;
  }

  get size(): number {
    return this.#records.length;
  }

  get records(): readonly AuditRecord[] {
    return frozenList(this.#records);
  }

  /** Just the denials — the query a reviewer actually runs. */
  denials(): readonly AuditRecord[] {
    return frozenList(this.#records.filter((r) => !isGranted(r.decision)));
  }

  onAppend(listener: AuditListener): () => void {
    this.#listeners.add(listener);
    return () => {
      this.#listeners.delete(listener);
    };
  }

  /**
   * The reader's half of this object: everything above except `append`.
   *
   * Memoised, so the same frozen view comes back every time and a caller
   * comparing two reads by identity gets the answer it expects.
   */
  view(): AuditView {
    // `const log = this` rather than `this` inside the literal: a getter in an
    // object literal is not an arrow, so its `this` would be the view itself.
    const log = this;
    this.#view ??= Object.freeze({
      get size(): number {
        return log.size;
      },
      get records(): readonly AuditRecord[] {
        return log.records;
      },
      denials: (): readonly AuditRecord[] => log.denials(),
      onAppend: (listener: AuditListener): (() => void) => log.onAppend(listener),
    });
    return this.#view;
  }
}

// ---------------------------------------------------------------------------
// the virtual policy engine
// ---------------------------------------------------------------------------

/**
 * The privilege state `sudo` and `whoami` see, and the only thing elevation
 * moves.
 *
 * Separate from the broker so the relationship is one-way and visible: the
 * broker READS this, and this can never write to the broker's grants.
 */
export class VirtualPolicy {
  #elevated = false;
  readonly #user: string;
  readonly #elevatedUser: string;
  #view: PolicyView | null = null;

  constructor(user = 'visitor', elevatedUser = 'root') {
    this.#user = user;
    this.#elevatedUser = elevatedUser;
    // The proven attack was `(broker.policy as Record<string, unknown>)
    // ['injected'] = true`, which succeeded because the getter handed back this
    // object. `broker.policy` is a view now, and freezing here closes the same
    // door for whoever CONSTRUCTED the policy and passed it in.
    Object.freeze(this);
  }

  get elevated(): boolean {
    return this.#elevated;
  }

  /** What `whoami` prints. A string in a simulation, and nothing more. */
  get user(): string {
    return this.#elevated ? this.#elevatedUser : this.#user;
  }

  /** Returns the disclosure the caller is required to surface. */
  elevate(): string {
    this.#elevated = true;
    return ELEVATION_DISCLOSURE;
  }

  drop(): void {
    this.#elevated = false;
  }

  /**
   * The readable half: `elevated` and `user`, live, with no `elevate`/`drop`.
   *
   * Live getters rather than a snapshot, so a view taken before a `sudo`
   * reports the elevation after it. A frozen snapshot would be correct once and
   * wrong from then on, in the one display whose job is to say whether you are
   * elevated.
   */
  view(): PolicyView {
    const policy = this;
    this.#view ??= Object.freeze({
      get elevated(): boolean {
        return policy.elevated;
      },
      get user(): string {
        return policy.user;
      },
    });
    return this.#view;
  }
}

// ---------------------------------------------------------------------------
// the broker
// ---------------------------------------------------------------------------

export interface CapabilityBrokerOptions {
  /** What this session may do. Absent means nothing is granted. */
  readonly grants?: Iterable<Capability>;
  readonly policy?: VirtualPolicy;
  readonly audit?: AuditLog;
  readonly clock?: () => number;
}

/** Everything a single command invocation is allowed to ask for. */
export interface ScopedCapabilities {
  /**
   * Ask. Throws `CapabilityDeniedError` if the answer is no.
   *
   * Signature-compatible with `InvocationContext.requireCapability`, which takes
   * only the capability; `target` is how a command names the file or URL it is
   * about to touch so the audit record says what happened rather than only that
   * something did.
   */
  require(capability: Capability, target?: string | null): void;
  /** Ask without consequences. For `Get-Command -Detailed` and dry runs. */
  check(capability: Capability): CapabilityDecision;
  /** What `sudo` calls. Confers nothing; produces an audit record saying so. */
  elevate(): ElevationResult;
}

export interface ElevationResult {
  /** Whether the command was allowed to elevate the SIMULATION. */
  readonly granted: boolean;
  /** Capabilities gained. Always empty — see `ELEVATION_CONFERS`. */
  readonly conferred: readonly Capability[];
  readonly disclosure: string;
}

/**
 * Decides capability requests and records what happened.
 *
 * One broker per session; `forCommand` produces the per-invocation view, which
 * is what the kernel puts behind `InvocationContext.requireCapability`. The
 * split exists because a decision needs the session's grants AND the command's
 * manifest AND the pid, and a command must not be able to supply the first.
 */
export class CapabilityBroker {
  readonly #granted: ReadonlySet<Capability>;
  /** The runtime-immutable wrapper handed out by `grants`. Built once. */
  readonly #grantsView: ReadonlySet<Capability>;
  readonly #policy: VirtualPolicy;
  readonly #audit: AuditLog;
  readonly #clock: () => number;
  #view: CapabilityView | null = null;

  constructor(options: CapabilityBrokerOptions = {}) {
    this.#granted = new Set(options.grants ?? []);
    this.#grantsView = readonlySetView(this.#granted);
    this.#policy = options.policy ?? new VirtualPolicy();
    this.#audit = options.audit ?? new AuditLog();
    this.#clock = options.clock ?? Date.now;
    Object.freeze(this);
  }

  /**
   * What this session may do — and cannot be talked into doing more of.
   *
   * This getter used to `return this.#granted`, and `ReadonlySet` is erased, so
   *
   *     (broker.grants as Set<Capability>).add('filesystem.write')
   *
   * granted a real capability the kernel was never given. It is a view now:
   * `.add` is not a function on it, so the same line throws instead of
   * succeeding. Internal decisions read `#granted` directly, so the wrapper is
   * on the way OUT only and costs nothing on the hot path.
   */
  get grants(): ReadonlySet<Capability> {
    return this.#grantsView;
  }

  /**
   * The privilege state, readable. NOT the policy object.
   *
   * Handing the instance back let a caller inject properties into it —
   * `policy['injected'] = true` succeeded — and call `elevate()`/`drop()` on
   * the session's own privilege state from outside the kernel. Neither confers
   * anything real, but both make the UI say something that did not happen.
   */
  get policy(): PolicyView {
    return this.#policy.view();
  }

  /** The log, readable. NOT the log object: `append` stays inside the kernel. */
  get audit(): AuditView {
    return this.#audit.view();
  }

  /**
   * The grants actually in force.
   *
   * Recomputed on every call rather than cached at construction, because the
   * invariant it enforces is about a code change, and a cached answer would let
   * a violating build run until something happened to invalidate the cache.
   */
  #effectiveGrants(): ReadonlySet<Capability> {
    if (!this.#policy.elevated) return this.#granted;
    if (ELEVATION_CONFERS.length === 0) return this.#granted;

    const withElevation = new Set(this.#granted);
    for (const capability of ELEVATION_CONFERS) {
      // Not an assertion for a reviewer to read — a throw that stops execution.
      if (CAPABILITY_REALITY[capability]) throw new ElevationScopeError(capability);
      withElevation.add(capability);
    }
    return withElevation;
  }

  /** Decide, without auditing or throwing. */
  evaluate(manifest: CommandManifest, capability: Capability): CapabilityDecision {
    if (!manifest.capabilities.includes(capability)) return 'denied:undeclared';
    if (this.#effectiveGrants().has(capability)) return 'granted';
    if (this.#policy.elevated && CAPABILITY_REALITY[capability]) {
      return 'denied:elevation-not-transferable';
    }
    return 'denied:not-granted';
  }

  /** Should this request leave a trace, whatever the answer? */
  shouldAudit(manifest: CommandManifest, capability: Capability, decision: CapabilityDecision): boolean {
    // A denial is always recorded. It is the single most useful line in the log
    // and the cheapest one to produce, and a log that shows only successes
    // cannot answer "did anything try?".
    if (!isGranted(decision)) return true;
    return CAPABILITY_AUDITED[capability] || RISK_AUDITED[manifest.risk];
  }

  /**
   * The broker as everything outside the kernel sees it.
   *
   * `forCommand` is not on it. The scoped object it returns writes audit
   * records carrying a caller-supplied manifest, display name and pid, so
   * anything holding a broker could fill the log with plausible lines for
   * commands that never ran. It grants nothing — both gates still run — but
   * forging a record and deleting one are the same integrity failure from
   * opposite sides, and only the kernel has a real invocation to attribute.
   */
  view(): CapabilityView {
    const broker = this;
    this.#view ??= Object.freeze({
      get grants(): ReadonlySet<Capability> {
        return broker.grants;
      },
      get policy(): PolicyView {
        return broker.policy;
      },
      get audit(): AuditView {
        return broker.audit;
      },
      evaluate: (manifest: CommandManifest, capability: Capability): CapabilityDecision =>
        broker.evaluate(manifest, capability),
      shouldAudit: (
        manifest: CommandManifest,
        capability: Capability,
        decision: CapabilityDecision,
      ): boolean => broker.shouldAudit(manifest, capability, decision),
    });
    return this.#view;
  }

  forCommand(manifest: CommandManifest, pid: ProcessId): ScopedCapabilities {
    const broker = this;

    const record = (
      capability: Capability,
      decision: CapabilityDecision,
      target: string | null,
      disclosure: string | null,
    ): void => {
      if (!broker.shouldAudit(manifest, capability, decision)) return;
      broker.#audit.append({
        at: broker.#clock(),
        pid,
        command: manifest.display,
        capability,
        risk: manifest.risk,
        fidelity: manifest.fidelity,
        decision,
        target,
        // The one place `real` is computed. A granted virtual capability is
        // still not real, which is the whole claim `sudo` has to keep.
        //
        // The command's fidelity is the second half of that, and leaving it out
        // was a bug the simulated-command work found: `process.read` is a real
        // capability, so a granted `ps` was audited `real: true` for a command
        // that reads nothing and never will. This field's own doc comment says
        // it is "the field a reviewer scans" — so it has to be true of the
        // command, not only of the capability's category.
        real:
          isGranted(decision) &&
          CAPABILITY_REALITY[capability] &&
          manifest.fidelity !== 'simulated',
        disclosure,
      });
    };

    return {
      check(capability: Capability): CapabilityDecision {
        return broker.evaluate(manifest, capability);
      },

      require(capability: Capability, target: string | null = null): void {
        const decision = broker.evaluate(manifest, capability);
        record(capability, decision, target, null);
        if (isGranted(decision)) return;
        // The contract's error type, so `catch (e) { if (e instanceof
        // CapabilityDeniedError) }` written against invocation.ts matches.
        throw new CapabilityDeniedError(capability, manifest.display);
      },

      elevate(): ElevationResult {
        const decision = broker.evaluate(manifest, 'virtual.policy.elevate');
        record('virtual.policy.elevate', decision, null, ELEVATION_DISCLOSURE);
        if (!isGranted(decision)) {
          throw new CapabilityDeniedError('virtual.policy.elevate', manifest.display);
        }
        broker.#policy.elevate();
        return {
          granted: true,
          // Not `ELEVATION_CONFERS` passed through — a copy, so a caller cannot
          // mutate the module constant and change what elevation means.
          conferred: [...ELEVATION_CONFERS],
          disclosure: ELEVATION_DISCLOSURE,
        };
      },
    };
  }
}
