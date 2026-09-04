/**
 * invocation.ts — the contract between the binder, the commands and the kernel.
 *
 * This file exists to be written ONCE, before the three layers that depend on
 * it are built. Each of them needs to agree on what a bound command looks like,
 * and if they each invent it, the pieces will not fit and the mismatch will only
 * surface at integration time.
 *
 * The split of responsibility is deliberate:
 *
 *   the binder    turns raw argument tokens into BoundParameters, applying
 *                 positional rules, aliases, switch semantics and validation —
 *                 all of which are version-dependent
 *   a command     receives BoundParameters already correct for the active
 *                 profile, and never parses `raw[]` itself
 *   the kernel    supplies the context: streams, cancellation, the profile,
 *                 and the capability broker
 *
 * The reason the binder is separate at all is empirical: the majority of
 * PowerShell 7.7's breaking changes land in binding, not in command bodies —
 * ValidateNotNullOrEmpty on -Property, explicit `-Switch:$false`, positional
 * binding fixes. Thirteen separate upstream PRs fixed one design mistake about
 * switch parameters. If each command parsed its own arguments, modelling that
 * would mean thirteen forks instead of one flag.
 */

import type { PSValue } from '../pipeline/psobject.ts';
import type { NativeStreams, PowerShellStreams } from '../pipeline/streams.ts';
import type { Capability, CommandManifest } from './manifest.ts';

/**
 * The values a command receives, already bound.
 *
 * A parameter that was not supplied is ABSENT, not present-and-undefined. That
 * distinction is what lets a command tell "the user did not pass -Force" from
 * "the user passed -Force:$false", which PowerShell 7.7 made observable.
 */
export interface BoundParameters {
  readonly [name: string]: PSValue;
}

/** Which parameter set the binder resolved, and how it decided. */
export interface BindingResult {
  readonly parameters: BoundParameters;
  /** The resolved parameter set name, e.g. 'Path' vs 'LiteralPath'. */
  readonly parameterSet: string;
  /** Arguments left over after binding. Non-empty is usually an error. */
  readonly remaining: readonly string[];
}

/**
 * Everything a command is allowed to touch.
 *
 * A command never imports a browser API, never reaches the DOM, and never opens
 * a file itself. It asks through this. That is what makes the capability
 * declarations in the manifest enforceable rather than decorative.
 */
export interface InvocationContext {
  /** Which PowerShell version's semantics apply to this invocation. */
  readonly profile: CompatibilityView;
  readonly streams: PowerShellStreams;
  readonly native: NativeStreams | null;
  /** Objects arriving from the previous stage. Empty when first in a pipeline. */
  readonly input: AsyncIterable<PSValue>;
  readonly cwd: string;
  readonly env: ReadonlyMap<string, string>;
  /** Aborted on Ctrl+C. Every long-running loop must check it. */
  readonly signal: AbortSignal;
  /** Throws if the command was not granted the capability it is asking for. */
  requireCapability(capability: Capability): void;
}

/**
 * The slice of a compatibility profile a command actually reads.
 *
 * Deliberately narrow. A command should ask "is this behaviour on?", never
 * "which version am I?" — version checks scattered through command bodies are
 * exactly what the profile system exists to replace.
 */
export interface CompatibilityView {
  readonly displayVersion: string;
  /** Look up a behaviour flag, e.g. `newGuid.defaultVersion`. */
  behavior<T extends boolean | number | string>(key: string, fallback: T): T;
}

/**
 * A command implementation.
 *
 * `invoke` writes to streams rather than returning output, because a command
 * can emit on six of them and must be able to emit progressively — returning a
 * value would force everything to be buffered and would lose the distinction
 * between an object and an error.
 *
 * The number returned is the exit code, which `$LASTEXITCODE` reports.
 */
export interface CommandModule {
  readonly manifest: CommandManifest;
  invoke(context: InvocationContext, bound: BindingResult): Promise<number>;
}

/** Raised when a command asks for a capability it was not granted. */
export class CapabilityDeniedError extends Error {
  readonly capability: Capability;
  constructor(capability: Capability, commandName: string) {
    super(`${commandName} requires the ${capability} capability, which was not granted`);
    this.name = 'CapabilityDeniedError';
    this.capability = capability;
  }
}

/**
 * Raised for syntax the engine recognises but does not implement.
 *
 * This is a distinct failure from "that is not valid PowerShell". Saying so
 * precisely is the difference between an honest limit and a silently wrong
 * result, and the message is expected to name the construct and the profile.
 */
export class NotImplementedSyntaxError extends Error {
  readonly construct: string;
  readonly profileVersion: string;
  constructor(construct: string, profileVersion: string, source?: string) {
    super(
      `The syntax was recognised but is not implemented by BrowserShell.\n` +
        `  Compatibility profile : PowerShell ${profileVersion}\n` +
        `  Construct             : ${construct}` +
        (source === undefined ? '' : `\n  Source                : ${source}`),
    );
    this.name = 'NotImplementedSyntaxError';
    this.construct = construct;
    this.profileVersion = profileVersion;
  }
}
