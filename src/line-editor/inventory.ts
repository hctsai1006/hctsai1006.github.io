/**
 * inventory.ts — what the completion engine is allowed to know about commands.
 *
 * v1 built its `CORPUS` by walking a `CMDLETS` object that lived in the same
 * file as the renderer, so the set of completable names and the set of runnable
 * commands were two hand-maintained lists that could disagree. They are one list
 * now: `src/commands/manifests.json`, generated from the reference
 * implementation. Completion offering a name that cannot run — or failing to
 * offer one that can — is a drift bug this makes structurally impossible.
 *
 * The inventory is a projection, not a copy. Completion needs names, aliases,
 * parameter names and one bit per parameter (switch or not, because a switch
 * takes no value and therefore never puts the caret in value position). It has
 * no business seeing capabilities, risk or fidelity.
 *
 * WHAT THE CLAIM ABOVE DID NOT COVER
 *
 * "One list" closed the drift between two hand-maintained lists, and then a
 * second kind of drift opened underneath it, because one list was being asked
 * three questions:
 *
 *   does upstream PowerShell have this?     manifests.json `parameters`
 *   did we implement it?                    `implementationStatus`
 *   can it be typed in this session?        the registry, which is a runtime
 *                                           fact and lives in registry.ts
 *
 * Reading the first as an answer to the third is how completion came to offer
 * `Sort-Object -Top`, `Measure-Object -AllStats` and `Select-Object -Index`:
 * upstream has all three, the generated manifest lists them because it
 * describes upstream, and the binder rejects every one with
 * NamedParameterNotFound. The generator now writes the second answer too —
 * `implementedParameters` and `implementationStatus` — and this file defaults
 * to it.
 *
 * The third question is still not answered here, and cannot be: `registry.ts`
 * is outside the line-editor core (there is a test that asserts nothing here
 * imports anything but the generated manifests, and that boundary is worth
 * more than the convenience). A caller that has a session hands its registered
 * names to the constructor; the default is the closest honest approximation,
 * which is "everything a module implements".
 */

import manifestsJson from '../commands/manifests.json' with { type: 'json' };

/**
 * The slice of a manifest completion reads. Declared locally rather than
 * imported so that widening `CommandManifest` cannot silently widen what
 * completion depends on.
 */
export interface ManifestLike {
  readonly name: string;
  readonly display: string;
  readonly aliases: readonly string[];
  readonly synopsis: string;
  /**
   * UPSTREAM's parameters. Present for a command nothing here implements, and
   * wider than what the binder accepts for several that are implemented.
   */
  readonly parameters: readonly {
    readonly name: string;
    readonly aliases: readonly string[];
    readonly isSwitch: boolean;
    readonly mandatory: boolean;
    readonly type: string;
  }[];
  /** `none` means nobody ever captured this command's real parameters. */
  readonly parameterSource: string;
  /** `declared` | `partial` | `implemented` | `verified`. See manifest.ts. */
  readonly implementationStatus?: string;
  /** The names a module in this engine binds, when it hand-writes its surface. */
  readonly implementedParameters?: readonly string[];
}

export interface InventoryOptions {
  /**
   * Offer commands nothing implements, and every upstream parameter rather
   * than the implemented subset.
   *
   * Off by default: a completion that offers a name or a flag the binder will
   * reject has told the user something false, and it is worse than silence
   * because it looks like confirmation. On for anything DESCRIBING the command
   * set rather than helping someone type into it — a coverage report, a
   * roadmap, `Get-Command -All`.
   */
  readonly includeUnimplemented?: boolean;
  /**
   * The names reachable in THIS session, when the caller knows them.
   *
   * The registry is the only thing that does, and it is outside this core. A
   * caller that has one passes it; without it the inventory falls back to
   * implementation status, which is the same answer for every command except
   * one whose token another command shadows.
   */
  readonly registeredNames?: Iterable<string>;
}

/** A name the user can actually type at command position. */
export interface CommandEntry {
  /** The typed form: `Get-ChildItem`, or the alias `gci`. */
  readonly name: string;
  /** The command this resolves to. Equal to `name` for a non-alias. */
  readonly canonical: string;
  readonly kind: 'command' | 'alias';
  readonly synopsis: string;
}

export interface ParameterEntry {
  readonly name: string;
  readonly aliases: readonly string[];
  /**
   * A switch takes no value. This one bit is what lets the context resolver
   * tell `-Recurse <TAB>` (a new argument) from `-Path <TAB>` (a value).
   */
  readonly isSwitch: boolean;
  readonly mandatory: boolean;
  readonly type: string;
  /** True for the cmdlet common parameters, which no manifest lists. */
  readonly common: boolean;
}

/**
 * PowerShell's cmdlet common parameters, with their real aliases.
 *
 * The manifests do not carry these — the capture recorded declared parameters
 * only — but every advanced cmdlet accepts them, so leaving them out would make
 * completion wrong in the other direction.
 *
 * `-WhatIf` and `-Confirm` are NOT here. They exist only on cmdlets that declare
 * `SupportsShouldProcess`, the manifests do not record that, and offering them
 * everywhere would be a claim this project cannot back.
 */
const SWITCH_TYPE = 'System.Management.Automation.SwitchParameter';

function commonParameter(name: string, alias: string, type: string): ParameterEntry {
  return { name, aliases: [alias], isSwitch: type === SWITCH_TYPE, mandatory: false, type, common: true };
}

export const COMMON_PARAMETERS: readonly ParameterEntry[] = [
  commonParameter('Verbose', 'vb', SWITCH_TYPE),
  commonParameter('Debug', 'db', SWITCH_TYPE),
  commonParameter('ErrorAction', 'ea', 'System.Management.Automation.ActionPreference'),
  commonParameter('WarningAction', 'wa', 'System.Management.Automation.ActionPreference'),
  commonParameter('InformationAction', 'infa', 'System.Management.Automation.ActionPreference'),
  commonParameter('ProgressAction', 'proga', 'System.Management.Automation.ActionPreference'),
  commonParameter('ErrorVariable', 'ev', 'System.String'),
  commonParameter('WarningVariable', 'wv', 'System.String'),
  commonParameter('InformationVariable', 'iv', 'System.String'),
  commonParameter('OutVariable', 'ov', 'System.String'),
  commonParameter('OutBuffer', 'ob', 'System.Int32'),
  commonParameter('PipelineVariable', 'pv', 'System.String'),
];

export class CommandInventory {
  /** Every typeable name, sorted case-insensitively, as v1's CORPUS was. */
  readonly commands: readonly CommandEntry[];

  readonly #byName: ReadonlyMap<string, CommandEntry>;
  readonly #parameters: ReadonlyMap<string, readonly ParameterEntry[]>;

  /** Names offered at command position, and why the rest were not. */
  readonly excluded: ReadonlyMap<string, string>;

  constructor(manifests: readonly ManifestLike[], options: InventoryOptions = {}) {
    const byName = new Map<string, CommandEntry>();
    const parameters = new Map<string, readonly ParameterEntry[]>();
    const excluded = new Map<string, string>();

    const everything = options.includeUnimplemented ?? false;
    const registered =
      options.registeredNames === undefined
        ? null
        : new Set([...options.registeredNames].map((n) => n.toLowerCase()));

    /**
     * Can this be typed?
     *
     * The session's own list wins when there is one. Otherwise implementation
     * status is the honest stand-in: `declared` means nobody built it and
     * `partial` means it was built and deliberately held back, and offering
     * either is offering a name that will not resolve.
     */
    const offerable = (m: ManifestLike): true | string => {
      if (everything) return true;
      if (registered !== null) {
        return registered.has(m.name.toLowerCase()) ? true : 'not registered in this session';
      }
      // ABSENT is not the same as 'declared'. A host or a test passing its own
      // manifest-shaped list has no reason to know this field exists, and
      // treating silence as "unimplemented" would hide every command it
      // offered. Only an explicit status excludes. The generated manifests
      // always carry one, so the real path is never the silent one.
      const status = m.implementationStatus;
      if (status === 'declared') return 'declared upstream; nothing here implements it';
      if (status === 'partial') return 'implemented only partially, and held back';
      return true;
    };

    const usable = manifests.filter((m) => {
      const verdict = offerable(m);
      if (verdict === true) return true;
      excluded.set(m.name, verdict);
      return false;
    });

    for (const m of usable) {
      byName.set(m.display.toLowerCase(), {
        name: m.display,
        canonical: m.display,
        kind: 'command',
        synopsis: m.synopsis,
      });
      /**
       * The parameters this engine BINDS, not the ones upstream declares.
       *
       * `implementedParameters` is a subset of `parameters` when a module
       * hand-writes its surface. Measured: upstream `Sort-Object` has nine
       * parameters and this engine binds six, so `-Top`, `-Bottom` and
       * `-Culture` were being offered for a binder that answers
       * NamedParameterNotFound.
       */
      const binds =
        !everything && m.implementedParameters !== undefined
          ? new Set(m.implementedParameters.map((n) => n.toLowerCase()))
          : null;
      // A command with no captured parameters gets no common parameters either:
      // claiming `Ls -Verbose` works would be inventing metadata.
      const declared: ParameterEntry[] = m.parameters
        .filter((p) => binds === null || binds.has(p.name.toLowerCase()))
        .map((p) => ({
          name: p.name,
          aliases: p.aliases,
          isSwitch: p.isSwitch,
          mandatory: p.mandatory,
          type: p.type,
          common: false,
        }));
      const all =
        m.parameterSource === 'none' ? declared : [...declared, ...COMMON_PARAMETERS];
      parameters.set(m.display.toLowerCase(), all);
    }

    for (const m of usable) {
      for (const alias of m.aliases) {
        const key = alias.toLowerCase();
        // A real command shadows an alias: `sl` is both the joke command and
        // Set-Location's alias, and the command is what the dispatcher runs.
        if (byName.has(key)) continue;
        byName.set(key, {
          name: alias,
          canonical: m.display,
          kind: 'alias',
          synopsis: m.synopsis,
        });
      }
    }

    this.#byName = byName;
    this.#parameters = parameters;
    this.excluded = excluded;
    this.commands = [...byName.values()].sort((a, b) =>
      a.name.toLowerCase() < b.name.toLowerCase()
        ? -1
        : a.name.toLowerCase() > b.name.toLowerCase()
          ? 1
          : 0,
    );
  }

  /** Resolve a typed name or alias to its canonical command, case-insensitively. */
  resolve(nameOrAlias: string): CommandEntry | null {
    return this.#byName.get(nameOrAlias.trim().toLowerCase()) ?? null;
  }

  /** Empty for an unknown command, and for one whose parameters were never captured. */
  parametersOf(nameOrAlias: string): readonly ParameterEntry[] {
    const entry = this.resolve(nameOrAlias);
    if (entry === null) return [];
    return this.#parameters.get(entry.canonical.toLowerCase()) ?? [];
  }

  /** Look a parameter up by name or by alias, e.g. `-lp` for `-LiteralPath`. */
  findParameter(nameOrAlias: string, parameterName: string): ParameterEntry | null {
    const needle = parameterName.replace(/^-+/, '').toLowerCase();
    for (const p of this.parametersOf(nameOrAlias)) {
      if (p.name.toLowerCase() === needle) return p;
      if (p.aliases.some((a) => a.toLowerCase() === needle)) return p;
    }
    return null;
  }

  /**
   * Unknown parameters count as switches. That is the conservative answer: it
   * keeps the caret in argument position rather than inventing a value context
   * for a parameter we have no metadata for.
   */
  isSwitch(nameOrAlias: string, parameterName: string): boolean {
    return this.findParameter(nameOrAlias, parameterName)?.isSwitch ?? true;
  }
}

interface ManifestsFile {
  readonly commands: readonly ManifestLike[];
}

/**
 * The inventory built from the generated manifests.
 *
 * The cast is narrow by design: it asserts only the fields `ManifestLike`
 * declares, all of which the generator's schema guarantees.
 */
export const MANIFEST_COMMANDS: readonly ManifestLike[] = (manifestsJson as unknown as ManifestsFile)
  .commands;

let defaultInventory: CommandInventory | null = null;
let fullInventory: CommandInventory | null = null;

/**
 * The default: what a visitor can actually type.
 *
 * Lazily built so importing the module does not cost the whole projection.
 */
export function manifestInventory(): CommandInventory {
  defaultInventory ??= new CommandInventory(MANIFEST_COMMANDS);
  return defaultInventory;
}

/**
 * Everything declared, implemented or not — for describing the command set
 * rather than completing into it.
 *
 * Separate function rather than a parameter on the one above, so that reaching
 * for the wider view is a visible decision at the call site.
 */
export function declaredInventory(): CommandInventory {
  fullInventory ??= new CommandInventory(MANIFEST_COMMANDS, { includeUnimplemented: true });
  return fullInventory;
}
