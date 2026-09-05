/**
 * support.ts — the pieces every object cmdlet needs, written once.
 *
 * Nothing here is a new semantic. It is the plumbing between `BoundParameters`
 * (which is a `Record<string, PSValue>` and therefore says nothing about
 * switches, arrays or script blocks) and the typed values a command body wants,
 * plus the two conversions PowerShell performs constantly and differently from
 * JavaScript:
 *
 *   renderValue  the string PowerShell shows for a value ("True", not "true";
 *                "@{A=1; B=x}", not "[object Object]")
 *   toNumber     PowerShell's numeric coercion, which accepts numeric STRINGS —
 *                verified: `@('2','10') | Measure-Object -Sum` reports 12
 *
 * Both were checked against pwsh 7.6.5 rather than assumed.
 */

import {
  compareValues,
  toPSString,
  getProperty,
  hasProperty,
  isPSObject,
  psObject,
  typeNameOf,
} from '../../pipeline/psobject.ts';
import type { PSObject, PSValue } from '../../pipeline/psobject.ts';
import type { BoundParameters } from '../invocation.ts';
import type {
  Capability,
  CommandManifest,
  ParameterMetadata,
  Risk,
} from '../manifest.ts';

// ---------------------------------------------------------------------------
// script blocks
// ---------------------------------------------------------------------------

export const SCRIPT_BLOCK_TYPE = 'System.Management.Automation.ScriptBlock';

/**
 * A script block, as far as a command is concerned: something you hand `$_` to
 * and get a value back.
 *
 * Deliberately a callback and not a source string. `Where-Object` must not
 * contain an interpreter, and it must never reach for `eval` or `new Function`
 * — the parser is a separate component, and a command that could evaluate
 * arbitrary text would make the capability broker in invocation.ts a fiction.
 */
export type ScriptBlockFn = (current: PSValue) => PSValue | Promise<PSValue>;

/**
 * What a script block IS on the wire: a name, not a thing.
 *
 * This used to be `psWrap({}, [SCRIPT_BLOCK_TYPE], fn)` — a JavaScript closure
 * in `PSObject.baseObject`, typed as a `PSValue` and therefore as if it could
 * be sent. It cannot. `structuredClone` throws `DataCloneError` on a function,
 * and the protocol strips `baseObject` before emitting anyway, so `Where-Object`
 * needed the closure and the boundary destroyed it. The unit tests passed only
 * because everything ran in one JS realm.
 *
 * There is no parser yet — PR-08 owns lexing and the AST — so a SERIALISABLE
 * script block is not available: there is nothing to serialise. What is
 * reachable today is an opaque handle. The closure stays in the realm that
 * created it, the handle crosses, and looking one up in the wrong realm returns
 * nothing rather than silently resolving to somebody else's block.
 *
 * When the parser lands, the same object gains an `Ast` property and the handle
 * stops being the only content — a `WireValue` throughout, either way.
 */
export interface ScriptBlockHandle {
  readonly kind: 'script-block-handle';
  readonly id: string;
}

export const SCRIPT_BLOCK_HANDLE_KIND = 'script-block-handle';

/** The two properties a script-block object carries in place of a closure. */
const HANDLE_KIND_PROPERTY = 'Kind';
const HANDLE_ID_PROPERTY = 'Id';

/**
 * An identifier for the registry this process's script blocks live in.
 *
 * Part of every handle id, and the reason a foreign handle FAILS instead of
 * resolving. Two realms both counting from 1 would otherwise hand out the same
 * ids, so a handle minted in a Worker would resolve on the UI thread to
 * whatever block happened to be first there — a wrong answer rather than a
 * missing one, which is the failure this whole change exists to prevent.
 */
function newRealmId(): string {
  const source: unknown = globalThis.crypto;
  if (typeof source === 'object' && source !== null && 'randomUUID' in source) {
    return (source as Crypto).randomUUID().slice(0, 8);
  }
  // No crypto (an old host, a stripped test runner). Still per-instance, which
  // is what the id is for; it is not a security token.
  return Math.random().toString(36).slice(2, 10);
}

/**
 * Where the closures live. One per realm, and never sent.
 *
 * A registry is unavoidably a leak unless something releases entries, so it
 * says so rather than hiding it: `size` is public, `release` and `clear` exist,
 * and the only producer of handles today is a test or the future parser, which
 * owns the lifetime of the blocks it creates.
 */
export class ScriptBlockRegistry {
  readonly #realm: string;
  readonly #blocks = new Map<string, ScriptBlockFn>();
  #next = 1;

  constructor(realm: string = newRealmId()) {
    this.#realm = realm;
  }

  get realm(): string {
    return this.#realm;
  }

  /** How many closures are still held. Public so a leak is measurable. */
  get size(): number {
    return this.#blocks.size;
  }

  register(fn: ScriptBlockFn): ScriptBlockHandle {
    const id = `${this.#realm}:${this.#next}`;
    this.#next += 1;
    this.#blocks.set(id, fn);
    return { kind: SCRIPT_BLOCK_HANDLE_KIND, id };
  }

  /** The closure, or undefined when the handle is foreign, stale or released. */
  resolve(handle: ScriptBlockHandle): ScriptBlockFn | undefined {
    return this.#blocks.get(handle.id);
  }

  release(handle: ScriptBlockHandle): boolean {
    return this.#blocks.delete(handle.id);
  }

  clear(): void {
    this.#blocks.clear();
  }
}

/** This realm's registry. Module state on purpose: a realm has exactly one. */
export const scriptBlocks = new ScriptBlockRegistry();

/**
 * Carry a script block through `BoundParameters`, which is typed as `PSValue`.
 *
 * The object is ordinary data — two string properties and a type-name chain —
 * so `$sb.GetType().FullName` and `-is [scriptblock]` still work without a
 * special case, and `structuredClone` carries it without complaint.
 */
export function scriptBlock(fn: ScriptBlockFn, registry: ScriptBlockRegistry = scriptBlocks): PSObject {
  const handle = registry.register(fn);
  return psObject(
    { [HANDLE_KIND_PROPERTY]: handle.kind, [HANDLE_ID_PROPERTY]: handle.id },
    [SCRIPT_BLOCK_TYPE, 'System.Object'],
  );
}

/**
 * Is this a script block, and which one?
 *
 * Separate from `asScriptBlock` because the two answers are different: "that is
 * not a script block" is a binding question, and "that is a script block whose
 * closure is not in this realm" is a transport failure. A command that cannot
 * tell them apart treats the second as the first and silently does nothing —
 * which for `Where-Object` means passing every object through.
 */
export function scriptBlockHandleOf(value: PSValue | undefined): ScriptBlockHandle | undefined {
  if (value === undefined || !isPSObject(value)) return undefined;
  if (value.typeNames[0] !== SCRIPT_BLOCK_TYPE) return undefined;
  const kind = getProperty(value, HANDLE_KIND_PROPERTY);
  const id = getProperty(value, HANDLE_ID_PROPERTY);
  if (kind !== SCRIPT_BLOCK_HANDLE_KIND || typeof id !== 'string' || id.length === 0) {
    return undefined;
  }
  return { kind: SCRIPT_BLOCK_HANDLE_KIND, id };
}

export function asScriptBlock(
  value: PSValue | undefined,
  registry: ScriptBlockRegistry = scriptBlocks,
): ScriptBlockFn | undefined {
  const handle = scriptBlockHandleOf(value);
  return handle === undefined ? undefined : registry.resolve(handle);
}

/** Let go of a script block's closure. The other half of `scriptBlock`. */
export function releaseScriptBlock(
  value: PSValue | undefined,
  registry: ScriptBlockRegistry = scriptBlocks,
): boolean {
  const handle = scriptBlockHandleOf(value);
  return handle === undefined ? false : registry.release(handle);
}

// ---------------------------------------------------------------------------
// reading bound parameters
// ---------------------------------------------------------------------------

/**
 * Parameter names are case-insensitive in PowerShell (`-property` binds
 * `-Property`). The binder normalises, but a command must not BREAK when handed
 * a differently-cased name, or every test would have to know the canonical
 * casing of every parameter.
 */
function lookup(bound: BoundParameters, name: string): PSValue | undefined {
  if (Object.hasOwn(bound, name)) return bound[name];
  const lower = name.toLowerCase();
  for (const key of Object.keys(bound)) {
    if (key.toLowerCase() === lower) return bound[key];
  }
  return undefined;
}

export function isBound(bound: BoundParameters, name: string): boolean {
  if (Object.hasOwn(bound, name)) return true;
  const lower = name.toLowerCase();
  return Object.keys(bound).some((key) => key.toLowerCase() === lower);
}

/**
 * A switch is not a boolean.
 *
 * `-Force` and `-Force:$false` are different things, and absent is a third.
 * Presence alone means true; an explicit `false` means false. Collapsing that
 * is the design mistake thirteen upstream PRs went on to fix, so it is modelled
 * here even though this file does nothing else with the distinction.
 */
export function switchValue(bound: BoundParameters, name: string): boolean {
  const value = lookup(bound, name);
  if (value === undefined) return isBound(bound, name);
  return value !== false;
}

export function stringValue(bound: BoundParameters, name: string): string | undefined {
  const value = lookup(bound, name);
  if (value === undefined || value === null) return undefined;
  return typeof value === 'string' ? value : renderValue(value);
}

export function numberValue(bound: BoundParameters, name: string): number | undefined {
  const value = lookup(bound, name);
  if (value === undefined || value === null) return undefined;
  const n = toNumber(value);
  return n === undefined ? undefined : Math.trunc(n);
}

/** `-Property A,B` and `-Property A` bind to the same shape here. */
export function stringArray(bound: BoundParameters, name: string): readonly string[] | undefined {
  const value = lookup(bound, name);
  if (value === undefined || value === null) return undefined;
  if (Array.isArray(value)) return value.map((item) => renderValue(item as PSValue));
  return [renderValue(value)];
}

export function rawValue(bound: BoundParameters, name: string): PSValue | undefined {
  return lookup(bound, name);
}

// ---------------------------------------------------------------------------
// property resolution, including the members a .NET value has intrinsically
// ---------------------------------------------------------------------------

/**
 * `getProperty` handles PSObjects. This adds the handful of intrinsic .NET
 * members the object cmdlets are actually asked for, because they are:
 *
 *   pwsh: @('abc','de') | Measure-Object -Property Length -Sum   ->  Sum 5
 *   pwsh: 'abc' | Select-Object -ExpandProperty Length           ->  3
 *
 * Without them both of those become errors, which would be a wrong answer
 * rather than a missing feature. The full .NET member surface is NOT modelled —
 * `Get-Member` on a string reports 54 members in pwsh and 5 here — and that
 * limit is declared in the Get-Member manifest rather than hidden.
 */
export function resolveProperty(target: PSValue, name: string): PSValue | undefined {
  if (isPSObject(target)) return getProperty(target, name);
  const key = name.toLowerCase();
  if (typeof target === 'string') return key === 'length' ? target.length : undefined;
  if (Array.isArray(target)) {
    return key === 'length' || key === 'count' ? target.length : undefined;
  }
  if (target instanceof Uint8Array) {
    return key === 'length' || key === 'count' ? target.length : undefined;
  }
  return undefined;
}

/** Does the value carry this property at all? Distinct from "holds null". */
export function hasResolvableProperty(target: PSValue, name: string): boolean {
  if (isPSObject(target)) return hasProperty(target, name);
  return resolveProperty(target, name) !== undefined;
}

/** Property names in declaration order, including the intrinsic ones. */
export function resolvablePropertyNames(target: PSValue): readonly string[] {
  if (isPSObject(target)) return Object.keys(target.properties);
  if (typeof target === 'string') return ['Length'];
  if (Array.isArray(target) || target instanceof Uint8Array) return ['Length', 'Count'];
  return [];
}

/**
 * Expand `-Property A*` against one object.
 *
 * Verified: `[pscustomobject]@{Alpha=1;Beta=2;Alt=3} | Select-Object -Property A*`
 * yields Alpha and Alt, in the source object's DECLARATION order rather than
 * alphabetically.
 */
export function matchPropertyNames(target: PSValue, pattern: string): readonly string[] {
  if (!hasWildcard(pattern)) return [pattern];
  const regexp = wildcardPattern(pattern);
  return resolvablePropertyNames(target).filter((name) => regexp.test(name));
}

// ---------------------------------------------------------------------------
// wildcards
// ---------------------------------------------------------------------------

export function hasWildcard(pattern: string): boolean {
  return /[*?[]/.test(pattern);
}

/**
 * PowerShell wildcards, which are not globs and not regexes: `*`, `?`, and
 * `[abc]` / `[a-z]` character classes, with `` ` `` as the escape.
 *
 * Case-insensitive because `-like` is; `-clike` builds the sensitive form.
 * Verified: `Where-Object Name -like '[ab]'` matches 'a' and 'b' but not 'c'.
 */
export function wildcardPattern(pattern: string, caseSensitive = false): RegExp {
  let out = '';
  let index = 0;
  while (index < pattern.length) {
    const char = pattern[index] ?? '';
    if (char === '`' && index + 1 < pattern.length) {
      out += escapeRegExp(pattern[index + 1] ?? '');
      index += 2;
      continue;
    }
    if (char === '*') out += '[\\s\\S]*';
    else if (char === '?') out += '[\\s\\S]';
    else if (char === '[') {
      const close = pattern.indexOf(']', index + 1);
      if (close === -1) {
        out += '\\[';
      } else {
        // The class body keeps PowerShell's meaning for ranges and `!`/`^`.
        const body = pattern.slice(index + 1, close);
        out += `[${body.startsWith('!') ? `^${body.slice(1)}` : body}]`;
        index = close + 1;
        continue;
      }
    } else out += escapeRegExp(char);
    index += 1;
  }
  return new RegExp(`^${out}$`, caseSensitive ? 'u' : 'iu');
}

function escapeRegExp(text: string): string {
  return text.replace(/[.*+?^${}()|[\]\\]/gu, '\\$&');
}

// ---------------------------------------------------------------------------
// numbers
// ---------------------------------------------------------------------------

/**
 * PowerShell's numeric conversion, which is far more permissive than a JS
 * habit expects. Each of these was read off pwsh 7.6.5:
 *
 *   @('2','10')  | Measure-Object -Sum  ->  12     numeric strings convert
 *   @(' 5 ','3') | Measure-Object -Sum  ->   8     surrounding space is fine
 *   @('1e3')     | Measure-Object -Sum  ->  1000   exponent notation converts
 *   @('')        | Measure-Object -Sum  ->     0   the EMPTY string is zero
 *   @($true,$false) | Measure-Object -Sum -> 1     booleans are 1 and 0
 *   @('a')       | Measure-Object -Sum  ->  error  NonNumericInputObject
 *
 * JavaScript's `Number()` agrees with every one of those, which is a piece of
 * luck rather than a design: it is spelled out here so a future "tidy-up" to
 * `parseFloat` (which would take 5 from '5abc') is visibly wrong.
 *
 * Dates and arrays are excluded deliberately. `Number(new Date())` is epoch
 * milliseconds and `Number([7])` is 7; PowerShell treats neither as numeric,
 * and inheriting JavaScript's answer would silently invent data.
 */
export function toNumber(value: PSValue): number | undefined {
  if (typeof value === 'number') return Number.isNaN(value) ? undefined : value;
  if (typeof value === 'bigint') return Number(value);
  if (typeof value === 'boolean') return value ? 1 : 0;
  if (typeof value === 'string') {
    const n = Number(value);
    return Number.isNaN(n) ? undefined : n;
  }
  return undefined;
}

// ---------------------------------------------------------------------------
// rendering
// ---------------------------------------------------------------------------


/**
 * The string PowerShell produces for a value — what `"$x"` shows, what
 * `Group-Object` uses for `Name`, and what `Get-Member` puts after the `=`.
 *
 * Read off pwsh 7.6.5:
 *
 *   $true            ->  True          (not "true")
 *   $null            ->  <empty>       (not "null")
 *   @(1,2)           ->  1 2           (space-joined, not "1,2")
 *   [pscustomobject]@{A=1;B='x'}  ->  @{A=1; B=x}
 *
 * Dates are the one deliberate divergence: pwsh renders them in the HOST's
 * culture, so the same script prints a different string on a different machine.
 * The locale is pinned here for the same reason psobject.ts pins its collator —
 * a differential test must not depend on the runner's regional settings.
 */
export function renderValue(value: PSValue): string {
  // Delegates. This was a second implementation of the same conversion, and it
  // disagreed with the object model's on the case that matters most: it used
  // String(value) for numbers, so 0.1 + 0.2 rendered as 0.30000000000000004
  // where pwsh prints 0.3. An adversarial review found three renderings in the
  // repository at once; there is now one, in psobject.ts, next to the value
  // model it describes.
  return toPSString(value);
}

// ---------------------------------------------------------------------------
// emitting
// ---------------------------------------------------------------------------

/**
 * Write values out, stopping the moment the consumer stops caring.
 *
 * The `closed` check is what makes `... | Select-Object -First 3` cheap for a
 * command that has already buffered its results: Sort-Object holding a million
 * rows should emit three and stop, not write a million into a dead channel.
 */
export async function emitAll(
  sink: { write(value: PSValue): Promise<void>; readonly closed: boolean },
  values: Iterable<PSValue>,
  signal: AbortSignal,
): Promise<void> {
  for (const value of values) {
    if (sink.closed || signal.aborted) return;
    await sink.write(value);
  }
}

// ---------------------------------------------------------------------------
// object construction helpers shared by the cmdlets
// ---------------------------------------------------------------------------

/**
 * The type-name chain `Select-Object -Property` produces.
 *
 * Verified: `[pscustomobject]@{A=1} | Select-Object -Property A` reports
 * `Selected.System.Management.Automation.PSCustomObject`, then the source's own
 * chain underneath it, and `'x' | Select-Object -Property Length` reports
 * `Selected.System.String`. The prefix is not decoration: the formatter keys
 * off it, which is how a selected object gets a table rather than the source
 * type's custom view.
 */
export function selectedTypeNames(source: PSValue): readonly string[] {
  const base = isPSObject(source) ? source.typeNames : [typeNameOf(source), 'System.Object'];
  return [`Selected.${base[0] ?? 'System.Object'}`, ...base];
}

/** A PSCustomObject with an explicit type chain. */
export function typedObject(
  properties: Readonly<Record<string, PSValue>>,
  typeNames: readonly string[],
): PSObject {
  return psObject(properties, typeNames);
}

/**
 * How `Get-Member` orders names.
 *
 * Delegates to `compareValues` on purpose. There is one ordering rule in this
 * engine, it is culture-aware and case-insensitive, and it was pinned to a
 * fixed locale so it cannot vary by machine. A second, subtly different
 * comparison for member names would be a place for the two to drift apart.
 * Verified: `[pscustomobject]@{Zed=1;Alpha=2;mid=3} | Get-Member` reports
 * Alpha, mid, Zed — case-insensitive, not code point.
 */
export function compareMemberNames(a: string, b: string): number {
  return compareValues(a, b);
}

// ---------------------------------------------------------------------------
// manifests
// ---------------------------------------------------------------------------

/**
 * What a hand-written manifest can say about a parameter.
 *
 * Flat on purpose: these cmdlets are declared here, not captured, and a
 * hand-written declaration describes exactly one parameter set. The captured
 * shape is per-set because real cmdlets have several — `New-Item -Path` is
 * mandatory in its Path set and optional in the other — and that distinction is
 * not ours to invent.
 */
export interface ParameterOptions {
  aliases?: readonly string[];
  isSwitch?: boolean;
  position?: number | null;
  mandatory?: boolean;
  valueFromPipeline?: boolean;
  validation?: readonly string[];
}

/**
 * The name real PowerShell gives the implicit set when a cmdlet declares none.
 * Taken from the captured metadata rather than invented: it is the only
 * underscore-prefixed set name pwsh 7.6.5 reports across all 43 commands.
 */
export const DEFAULT_PARAMETER_SET = '__AllParameterSets';

export function parameter(
  name: string,
  type: string,
  extra: ParameterOptions = {},
): ParameterMetadata {
  const position = extra.position ?? null;
  const mandatory = extra.mandatory ?? false;
  const valueFromPipeline = extra.valueFromPipeline ?? false;

  return {
    name,
    aliases: extra.aliases ?? [],
    type,
    isSwitch: extra.isSwitch ?? type === 'System.Management.Automation.SwitchParameter',
    sets: { [DEFAULT_PARAMETER_SET]: { position, mandatory, valueFromPipeline } },
    // Derived from the single set above, and named so they are not mistaken for
    // something pwsh said. With one set, "in any" and "in every" coincide.
    mandatoryInAnySet: mandatory,
    mandatoryInEverySet: mandatory,
    firstPosition: position,
    valueFromPipelineInAnySet: valueFromPipeline,
    validation: extra.validation ?? [],
    // False, not true: these names were read off `(Get-Command X).Parameters`
    // in pwsh 7.6.5, but the full attribute metadata was not captured through
    // tools/capture-pwsh-metadata.ps1, and claiming otherwise would make the
    // `verified` flag mean nothing.
    verified: false,
  };
}

export const SWITCH = 'System.Management.Automation.SwitchParameter';
export const STRING_ARRAY = 'System.String[]';
export const STRING = 'System.String';
export const INT = 'System.Int32';
export const OBJECT = 'System.Object';

export function manifest(spec: {
  display: string;
  aliases?: readonly string[];
  synopsis: string;
  notes: string;
  parameters: readonly ParameterMetadata[];
  outputTypeNames: readonly string[];
  risk?: Risk;
  capabilities?: readonly Capability[];
}): CommandManifest {
  return {
    name: spec.display.toLowerCase(),
    display: spec.display,
    aliases: spec.aliases ?? [],
    runtime: 'semantic',
    fidelity: 'native-semantic',
    risk: spec.risk ?? 'read',
    capabilities: spec.capabilities ?? [],
    parameters: spec.parameters,
    outputTypeNames: spec.outputTypeNames,
    synopsis: spec.synopsis,
    notes: spec.notes,
    parameterSource: 'declared',
  };
}
