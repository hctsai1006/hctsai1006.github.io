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
  readonly parameters: readonly {
    readonly name: string;
    readonly aliases: readonly string[];
    readonly isSwitch: boolean;
    readonly mandatory: boolean;
    readonly type: string;
  }[];
  /** `none` means nobody ever captured this command's real parameters. */
  readonly parameterSource: string;
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

  constructor(manifests: readonly ManifestLike[]) {
    const byName = new Map<string, CommandEntry>();
    const parameters = new Map<string, readonly ParameterEntry[]>();

    for (const m of manifests) {
      byName.set(m.display.toLowerCase(), {
        name: m.display,
        canonical: m.display,
        kind: 'command',
        synopsis: m.synopsis,
      });
      // A command with no captured parameters gets no common parameters either:
      // claiming `Ls -Verbose` works would be inventing metadata.
      const declared: ParameterEntry[] = m.parameters.map((p) => ({
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

    for (const m of manifests) {
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

/** Lazily built so importing the module does not cost the whole projection. */
export function manifestInventory(): CommandInventory {
  defaultInventory ??= new CommandInventory(MANIFEST_COMMANDS);
  return defaultInventory;
}
