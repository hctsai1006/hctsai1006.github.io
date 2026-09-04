/**
 * manifest.ts — what a command IS, declared rather than implied.
 *
 * This project makes two separate honesty claims, and they need two separate
 * mechanisms:
 *
 *   compatibility profile  →  which PowerShell version's semantics we claim
 *   fidelity (this file)   →  how real any individual command actually is
 *
 * A profile alone is not enough. A page can faithfully model PowerShell 7.6.5's
 * `Get-Content` while its `ping` invents round-trip times and its `sudo` grants
 * nothing at all. Without a per-command declaration, a visitor cannot tell those
 * apart, and a terminal that looks authoritative about everything is lying about
 * most of it.
 *
 * So every command declares its fidelity, and `Get-Command -Detailed` prints it.
 * Being visibly honest about which parts are simulated makes the parts that are
 * real more credible, not less.
 */

/**
 * How real is this command?
 *
 * Note on the taxonomy: the originating design document lists four levels in its
 * prose table but only three in its interface sketch. All four are kept here —
 * `external-runtime` is a genuinely different claim from the other three (it
 * says "a downloaded runtime executed this", which is neither our semantics nor
 * a browser API nor a fiction) and dropping it would force WebContainer or VM
 * commands to misdeclare themselves.
 */
export type Fidelity =
  /**
   * Implemented by us, aiming at real PowerShell semantics. The behaviour is
   * ours, but it is measured against the reference implementation and the
   * divergences are recorded.
   */
  | 'native-semantic'
  /**
   * Really calls a browser capability. The effect is genuine: bytes are stored,
   * the clipboard changes, a request goes out.
   */
  | 'browser-backed'
  /**
   * The output is invented or fixed, and nothing outside this page is read or
   * changed. `sudo` grants nothing; `ping` sends no packet; `free` reports
   * memory figures the browser cannot see.
   *
   * Deliberately wider than "pretends to be a Linux machine", because most of
   * the commands carrying this label are not doing that. Eight of them are
   * jokes, `classic` is a link to the archived v1, and `exit` explains why a
   * tab cannot close itself. An earlier version of this comment described only
   * the Linux facade, which left the majority of its own members undescribed —
   * and a taxonomy that does not describe its members cannot be applied
   * consistently. What actually unites them is the absence of real effect and
   * real information, which is the thing a visitor needs to be told.
   */
  | 'simulated'
  /**
   * Executed by a separately downloaded runtime — WebContainer, a WASM VM.
   * Real execution, but not ours and not the browser's.
   */
  | 'external-runtime';

/** Where the work happens. */
export type Runtime = 'semantic' | 'browser' | 'wasm' | 'vm';

/**
 * A permission the command needs. Capabilities are brokered: a command never
 * touches a browser API directly, it asks the kernel, and the kernel decides.
 * Declaring them here is what makes that enforceable rather than aspirational.
 */
export type Capability =
  | 'filesystem.read'
  | 'filesystem.write'
  | 'filesystem.delete'
  | 'portfolio.read'
  | 'preferences.write'
  | 'terminal.control'
  | 'ui.dialog'
  | 'process.read'
  | 'process.control'
  | 'network.fetch'
  | 'clipboard.read'
  | 'clipboard.write'
  | 'device.request'
  /**
   * Elevates privilege inside the VIRTUAL policy engine only. It confers
   * nothing on the browser, the origin, or the host — and the UI must say so
   * every time it is used.
   */
  | 'virtual.policy.elevate';

/** How dangerous is running this? Drives confirmation and AI approval gates. */
export type Risk =
  | 'read'
  | 'query-external'
  | 'write'
  | 'destructive'
  | 'device'
  | 'privileged-simulation';

/** What one parameter set says about a parameter. */
export interface ParameterSetBinding {
  position: number | null;
  mandatory: boolean;
  valueFromPipeline: boolean;
}

export interface ParameterMetadata {
  name: string;
  aliases: readonly string[];
  /** .NET type name as the reference implementation reports it. */
  type: string;
  /**
   * A switch is not a boolean. `-Switch` and `-Switch:$false` differ, and a
   * whole family of PowerShell 7.7 fixes is exactly that distinction.
   */
  isSwitch: boolean;
  /**
   * Per parameter set, as captured. The binder needs this: a parameter can be
   * mandatory in one set and optional in another, and collapsing that loses the
   * distinction. `New-Item -Path` is mandatory only in its Path set, so a
   * flattened "mandatory" would make the binder reject
   * `New-Item -Name x -ItemType File`, which real pwsh accepts.
   */
  sets: Readonly<Record<string, ParameterSetBinding>>;
  /**
   * DERIVED summaries, not captured facts. Named so nobody mistakes them for
   * the reference implementation's own answer — `verified` below covers only
   * the fields that were read directly.
   */
  mandatoryInAnySet: boolean;
  mandatoryInEverySet: boolean;
  firstPosition: number | null;
  valueFromPipelineInAnySet: boolean;
  /** Validation attributes, as captured from the reference implementation. */
  validation: readonly string[];
  /**
   * True when `type`, `isSwitch`, `aliases`, `validation` and `sets` came from
   * real pwsh. It does NOT vouch for the derived summaries above, which are
   * this project's flattening of the captured sets rather than pwsh's own view.
   */
  verified: boolean;
}

export interface CommandManifest {
  name: string;
  /** The canonical display form, e.g. `Get-ChildItem`. */
  display: string;
  aliases: readonly string[];
  runtime: Runtime;
  fidelity: Fidelity;
  risk: Risk;
  capabilities: readonly Capability[];
  parameters: readonly ParameterMetadata[];
  outputTypeNames: readonly string[];
  /** One line, shown by `Get-Help`. */
  synopsis: string;
  /**
   * Why this fidelity, when the answer is not obvious. Required for anything
   * `simulated`, so that a fiction is never undocumented.
   */
  notes?: string;
  /**
   * Whether the parameter metadata was captured from a real PowerShell, or is
   * a declaration with nothing behind it yet.
   */
  parameterSource: 'reference-implementation' | 'declared' | 'none';
}

/**
 * The badge shown beside a command in the UI. Kept next to the taxonomy so the
 * two cannot drift: a new fidelity level without a badge would render blank.
 */
export const FIDELITY_BADGE: Record<Fidelity, string> = {
  'native-semantic': 'SEMANTIC',
  'browser-backed': 'BROWSER',
  simulated: 'SIMULATED',
  'external-runtime': 'RUNTIME',
};

/** One-line explanation of each level, for `Get-Help about_Fidelity`. */
export const FIDELITY_MEANING: Record<Fidelity, string> = {
  'native-semantic': 'Implemented here, measured against real PowerShell.',
  'browser-backed': 'Really calls a browser capability; the effect is genuine.',
  simulated: 'Imitates a Linux machine. Reads and changes nothing outside this page.',
  'external-runtime': 'Executed by a separately downloaded runtime.',
};
