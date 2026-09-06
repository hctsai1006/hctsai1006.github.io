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
import type { ProviderRegistry } from '../providers/index.ts';
import type { DialogPort, FileSystemPort, PreferencesPort } from './ports.ts';

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
 * Everything a command is allowed to touch — and the exact sense of "allowed".
 *
 * A command in this repository never imports a browser API, never reaches the
 * DOM and never opens a file itself. It asks through this, and every request is
 * decided by the broker against the command's own manifest, so the capability
 * declarations there are enforceable rather than decorative.
 *
 * THE SENTENCE ABOVE USED TO BEGIN "A command never", WITHOUT "in this
 * repository", and that was a claim the code cannot keep. Nothing prevents a
 * module registered with `Kernel.register` from calling `fetch`, opening
 * IndexedDB or reaching `document` directly: it shares this Worker's global,
 * needs no import from here, and the broker never hears about it — the audit
 * log would show nothing, because nothing was asked. For the commands shipped
 * here it is true and reviewable in a diff. For anything else it is a
 * convention, not a boundary.
 *
 * The enforceable claim is therefore narrower and worth stating exactly: what
 * comes THROUGH this interface cannot exceed what the manifest declared and the
 * session granted, and what it did obtain is on the record. Actual isolation —
 * a separate Worker or sandboxed iframe with a message-only API and no shared
 * global — is ROADMAP 14.3 and does not exist yet. See `kernel/inspect.ts`.
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

  /**
   * The filesystem, already brokered — every call requires the matching
   * capability, so a command that declared none cannot read one byte. Null when
   * the host runs without storage, which the pure pipeline commands do not care
   * about and the filesystem commands must check rather than assume.
   */
  readonly fs: FileSystemPort | null;

  /**
   * Which drive belongs to which provider, and the dispatch for the ones that
   * are not files.
   *
   * SEPARATE FROM `fs`, and not a member of it, because `Env:` is not a
   * filesystem — that is the whole reason PR-10 exists. It is not brokered
   * either, and the reason is worth stating rather than leaving to inference:
   * the FileSystem provider inside it wraps the SAME `FileSystemPort` above, so
   * every filesystem call still passes the broker; the other four read session
   * state, which `InvocationContext.env` already hands over unguarded.
   *
   * Null when the host wired no providers, which is the case a rewired command
   * has to keep handling — the filesystem-only path is the one that runs then.
   */
  readonly providers: ProviderRegistry | null;

  /** Durable settings that are not files. Gated by `preferences.write`. */
  readonly preferences: PreferencesPort | null;

  /**
   * Asking the host for something only a UI can do — the editors need it. Null
   * in a headless run, which is the normal case for tests, so a command that
   * needs it has to say so rather than crash.
   */
  readonly dialog: DialogPort | null;
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
  /**
   * Look up a behaviour flag, e.g. `newGuid.defaultVersion`.
   *
   * The key MUST be declared by the profile or something it inherits. Absence is
   * treated as a mistake — almost always a typo — and reported, because the
   * alternative is a command silently behaving like an older version forever.
   */
  behavior<T extends boolean | number | string>(key: string, fallback: T): T;
  /**
   * Look up a behaviour that is declared ONLY where it applies.
   *
   * The difference from `behavior` is what absence MEANS. A profile declares
   * `switchParameter.New-Guid.Empty.honourExplicitFalse` because upstream PR
   * #26140 fixed that one parameter on that one cmdlet; it declares nothing for
   * `Test-Diff -Force` because no upstream PR ever touched it, and measurement
   * says pwsh 7.6.5 honours an explicit `:$false` there in both lines. So an
   * undeclared scoped key is a fact — "this pair was never buggy" — not a typo,
   * and must not be reported as one.
   *
   * Keeping the two lookups apart is what lets behaviour keys be command- and
   * parameter-scoped at all. The engine-wide boolean they replaced applied one
   * cmdlet's bug to every switch parameter in the binder.
   */
  scopedBehavior<T extends boolean | number | string>(key: string, whenUndeclared: T): T;
}

/**
 * A command implementation.
 *
 * `invoke` writes to streams rather than returning output, because a command
 * can emit on six of them and must be able to emit progressively — returning a
 * value would force everything to be buffered and would lose the distinction
 * between an object and an error.
 *
 * ---------------------------------------------------------------------------
 * WHAT THE NUMBER IS, AND WHAT IT IS NOT
 * ---------------------------------------------------------------------------
 *
 * It is the command's STATUS: 0 means it succeeded, and any other value means
 * it failed. It is NOT `$LASTEXITCODE`, which this docstring used to claim.
 *
 * Measured in pwsh 7.6.5, in one session, reading both variables after each
 * command:
 *
 *   (fresh session)                       $LASTEXITCODE is UNSET, $? True
 *   cmd /c "exit 42"                      $LASTEXITCODE 42, $? False
 *   Get-Date                              $LASTEXITCODE 42, $? True
 *   cmd /c "exit 7"; Get-Item nosuch      $LASTEXITCODE  7, $? False
 *   cmd /c "exit 5"; Write-Error boom     $LASTEXITCODE  5, $? False
 *   cmd /c "exit 13"; No-Such-Command     $LASTEXITCODE 13, $? False
 *   & script.ps1  (which does `exit 33`)  $LASTEXITCODE 33, $? False
 *
 * A cmdlet NEVER touches `$LASTEXITCODE` — not when it fails, not when it
 * cannot be found. Only a native program or a script PowerShell launched sets
 * it, and its previous value survives every cmdlet in between. A cmdlet's
 * success or failure shows in `$?`, and `$?` is False even when the command
 * produced output, as long as it wrote an error record:
 *
 *   Get-Item 'C:\nope','C:\Windows' -ErrorAction SilentlyContinue
 *     -> 1 object emitted, $? False
 *
 * So the two are modelled separately. The kernel keeps `$?` and
 * `$LASTEXITCODE` per terminal, derives `$?` from this number AND from whether
 * anything was written to stream 2, and updates `$LASTEXITCODE` only for a
 * process whose manifest says a separate runtime executed it.
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
