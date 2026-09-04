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
 */

import { CapabilityDeniedError } from '../commands/invocation.ts';
import type { Capability, CommandManifest, Fidelity, Risk } from '../commands/manifest.ts';
import type { ProcessId } from './ids.ts';

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
export const RISK_AUDITED: Record<Risk, boolean> = {
  read: false,
  // Network. Named for what it is from the user's side: it leaves the page.
  'query-external': true,
  write: true,
  destructive: true,
  device: true,
  'privileged-simulation': true,
};

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

/** Every capability that reaches outside the simulation. */
export const REAL_CAPABILITIES: ReadonlySet<Capability> = new Set(
  (Object.keys(CAPABILITY_REALITY) as Capability[]).filter((c) => CAPABILITY_REALITY[c]),
);

/** Every capability that exists only inside it. */
export const VIRTUAL_CAPABILITIES: ReadonlySet<Capability> = new Set(
  (Object.keys(CAPABILITY_REALITY) as Capability[]).filter((c) => !CAPABILITY_REALITY[c]),
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

/** Append-only. Nothing removes an entry except an explicit `clear`. */
export class AuditLog {
  #sequence = 1;
  readonly #records: AuditRecord[] = [];
  readonly #listeners = new Set<AuditListener>();

  append(record: Omit<AuditRecord, 'sequence'>): AuditRecord {
    const stamped: AuditRecord = Object.freeze({ sequence: this.#sequence, ...record });
    this.#sequence += 1;
    this.#records.push(stamped);
    for (const listener of [...this.#listeners]) listener(stamped);
    return stamped;
  }

  get records(): readonly AuditRecord[] {
    return this.#records;
  }

  /** Just the denials — the query a reviewer actually runs. */
  denials(): readonly AuditRecord[] {
    return this.#records.filter((r) => !isGranted(r.decision));
  }

  onAppend(listener: AuditListener): () => void {
    this.#listeners.add(listener);
    return () => {
      this.#listeners.delete(listener);
    };
  }

  clear(): void {
    // The sequence deliberately does NOT reset: a cleared log must not be able
    // to produce a second entry numbered 1, or two exports cannot be compared.
    this.#records.length = 0;
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
  #user: string;
  readonly #elevatedUser: string;

  constructor(user = 'visitor', elevatedUser = 'root') {
    this.#user = user;
    this.#elevatedUser = elevatedUser;
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
  readonly #policy: VirtualPolicy;
  readonly #audit: AuditLog;
  readonly #clock: () => number;

  constructor(options: CapabilityBrokerOptions = {}) {
    this.#granted = new Set(options.grants ?? []);
    this.#policy = options.policy ?? new VirtualPolicy();
    this.#audit = options.audit ?? new AuditLog();
    this.#clock = options.clock ?? Date.now;
  }

  get grants(): ReadonlySet<Capability> {
    return this.#granted;
  }

  get policy(): VirtualPolicy {
    return this.#policy;
  }

  get audit(): AuditLog {
    return this.#audit;
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
