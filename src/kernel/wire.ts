/**
 * wire.ts — the value types that may cross the kernel boundary, and the one
 * function that turns a kernel-local value into one.
 *
 * ---------------------------------------------------------------------------
 * WHY THIS IS A SEPARATE TYPE FROM `PSValue`
 * ---------------------------------------------------------------------------
 *
 * `PSValue` is the KERNEL-LOCAL object model. A `PSObject` in it may carry a
 * `baseObject` — a File handle, a Response, a JavaScript closure — precisely so
 * a command can reach the host value behind a pipeline object.
 *
 * None of that can cross a `postMessage`. `structuredClone` throws
 * `DataCloneError` on a function and drops the prototype of everything else, so
 * "this is a pipeline value" and "this can be sent" are two different claims.
 * Letting one type mean both is how a closure ends up typed as if it were data:
 * the unit tests pass because everything runs in one JS realm, and the boundary
 * destroys the value the moment the boundary exists.
 *
 * So there are two types, and exactly one function converts between them:
 *
 *     PSValue   (kernel-local, may hold baseObject)
 *        |
 *        |  sanitizePSValue()      <- the trust boundary
 *        v
 *     WireValue (structured-clone safe by construction)
 *
 * `WireValue` is assignable to `PSValue` — a value that can be sent is still a
 * perfectly good pipeline value — but not the other way round, which is the
 * direction that matters.
 *
 * ---------------------------------------------------------------------------
 * WHAT `sanitizePSValue` GUARANTEES
 * ---------------------------------------------------------------------------
 *
 *   TERMINATION ON CYCLES.  It is a memoised graph copy, not a tree walk. The
 *   previous version recursed with no visited set and blew the stack on
 *   `c.properties.self = c` — while `cloneSafetyProblems` in protocol.ts
 *   DELIBERATELY permits cycles, because structured clone preserves them. The
 *   two halves of one boundary disagreed; they no longer do.
 *
 *   SHARED SUBGRAPHS SURVIVE.  Two properties pointing at one object still
 *   point at one object afterwards. That held before only by accident — an
 *   unchanged value was returned by reference — so it stopped holding the
 *   moment anything in the graph needed stripping. The WeakMap makes it a
 *   property rather than a coincidence, and it is what `structuredClone` does.
 *
 *   NO HOST OBJECT ESCAPES.  Every container is REBUILT. Nothing from the input
 *   graph is carried by reference except values whose internal slots were
 *   checked, so a Proxy standing in for a plain object cannot reach the far
 *   side even though JavaScript gives no portable way to ask "is this a Proxy?".
 *   Its traps see `[[OwnPropertyKeys]]` and `[[GetOwnProperty]]` and never
 *   `[[Get]]`, because values are read from property DESCRIPTORS. An accessor
 *   property is rejected rather than invoked: the boundary must not run
 *   attacker-chosen code to decide what to send.
 *
 *   BOUNDED WORK.  Depth, node count and an approximate byte size are all
 *   capped. Without them a value that is merely enormous rather than malformed
 *   is a denial of service against the UI thread, and the effective limit would
 *   be "whatever the stack happened to allow".
 *
 * Everything it rejects raises `WireValueError`, which names the PATH. A
 * rejection three levels inside a property bag is useless without one.
 */

import type { PSObject, PSValue } from '../pipeline/psobject.ts';
import type { ErrorRecord, InformationRecord } from '../pipeline/streams.ts';

// ---------------------------------------------------------------------------
// the wire value type
// ---------------------------------------------------------------------------

/**
 * A `PSObject` with no `baseObject`.
 *
 * The absence is the whole point, and it is spelled `never` rather than simply
 * omitted so a `WireObject` built by hand cannot quietly acquire one:
 * `exactOptionalPropertyTypes` makes `baseObject?: never` mean "this key must
 * not be present", not "this key may be present and undefined".
 */
export interface WireObject {
  readonly typeNames: readonly string[];
  readonly properties: Readonly<Record<string, WireValue>>;
  readonly baseObject?: never;
}

/** A value that survives `structuredClone` with its meaning intact. */
export type WireValue =
  | null
  | boolean
  | number
  | bigint
  | string
  | Date
  | Uint8Array
  | WireObject
  | readonly WireValue[];

/** An `ErrorRecord` whose `targetObject` has been through the boundary. */
export interface WireErrorRecord extends ErrorRecord {
  targetObject?: WireValue;
}

/** An `InformationRecord` whose `message` has been through the boundary. */
export interface WireInformationRecord extends InformationRecord {
  message: WireValue;
}

// ---------------------------------------------------------------------------
// limits
// ---------------------------------------------------------------------------

/**
 * The ceilings the boundary imposes on ONE value.
 *
 * These are TRANSPORT limits, not PowerShell semantics, and are named that way
 * so nobody reads them as something pwsh was measured to do. The depth is the
 * one number with an anchor: `ConvertTo-Json -Depth` accepts at most 100 in
 * pwsh 7.6.5, so a value too deep for the reference implementation's own
 * serialiser is too deep for this one.
 */
export interface WireLimits {
  /** Nesting levels. Deeper than this is rejected, never truncated. */
  readonly maxDepth: number;
  /** Nodes visited. A shared node is counted once, because it is copied once. */
  readonly maxNodes: number;
  /**
   * Approximate size in bytes. Approximate because an exact answer needs the
   * serialiser this limit exists to protect.
   */
  readonly maxBytes: number;
}

export const DEFAULT_WIRE_LIMITS: WireLimits = {
  maxDepth: 100,
  maxNodes: 1_000_000,
  maxBytes: 8 * 1024 * 1024,
};

/** Thrown when a value cannot be made safe to send. Names the path. */
export class WireValueError extends Error {
  readonly path: string;
  readonly reason: string;
  constructor(path: string, reason: string) {
    super(`${path} cannot cross the kernel boundary: ${reason}`);
    this.name = 'WireValueError';
    this.path = path;
    this.reason = reason;
  }
}

// ---------------------------------------------------------------------------
// internal-slot checks a Proxy cannot pass
// ---------------------------------------------------------------------------

/**
 * The `[[DateValue]]` of a real Date, or null.
 *
 * `instanceof` is not enough on its own: a Proxy wrapping a Date passes it, and
 * so does `{ [Symbol.toStringTag]: 'Date' }`. `Date.prototype.valueOf` reads
 * the internal slot, which a Proxy does not have and cannot forge — internal
 * slots are not proxied. It also answers correctly for a Date from another
 * realm, which `instanceof` gets wrong in the other direction, so it is the
 * check used on the slow path below where a cross-realm Date would otherwise be
 * rejected as a class instance.
 */
function dateValueOf(value: object): number | null {
  try {
    return Date.prototype.valueOf.call(value as Date);
  } catch {
    return null;
  }
}

/**
 * `ArrayBuffer.isView` IS the internal-slot check: the spec defines it as "has
 * a [[ViewedArrayBuffer]] internal slot", so a Proxy wrapping a Uint8Array
 * returns FALSE here. No extra probe is needed.
 */
function isUint8Array(value: object): value is Uint8Array {
  return ArrayBuffer.isView(value) && value instanceof Uint8Array;
}

// ---------------------------------------------------------------------------
// the copy
// ---------------------------------------------------------------------------

interface CopyState {
  readonly memo: WeakMap<object, WireValue>;
  readonly limits: WireLimits;
  nodes: number;
  bytes: number;
}

/** Rough in-memory cost of a container, used only to bound the total. */
const OVERHEAD_PER_NODE = 32;

/** One node of the output graph, plus its approximate size. */
function charge(state: CopyState, path: string, bytes: number): void {
  state.nodes += 1;
  if (state.nodes > state.limits.maxNodes) {
    throw new WireValueError(path, `the value has more than ${state.limits.maxNodes} nodes`);
  }
  chargeBytes(state, path, bytes);
}

/**
 * Size without a node. A property NAME costs memory but is not a value, and
 * counting it as one would make the node budget depend on how long the keys
 * happen to be.
 */
function chargeBytes(state: CopyState, path: string, bytes: number): void {
  state.bytes += bytes;
  if (state.bytes > state.limits.maxBytes) {
    throw new WireValueError(path, `the value is larger than ${state.limits.maxBytes} bytes`);
  }
}

interface OwnProperty {
  readonly present: boolean;
  readonly value: unknown;
}

const ABSENT: OwnProperty = { present: false, value: undefined };

/**
 * Read one own property WITHOUT invoking anything.
 *
 * Returns the descriptor's `value`, and throws when the property is an
 * accessor. A getter at the boundary is code the sender chose and the receiver
 * did not, and running it to find out what to send is exactly backwards.
 */
function ownValue(container: object, key: string, path: string): OwnProperty {
  const descriptor = Object.getOwnPropertyDescriptor(container, key);
  if (descriptor === undefined) return ABSENT;
  if (!('value' in descriptor)) {
    throw new WireValueError(
      path,
      'it is an accessor property; the boundary will not invoke a getter to decide what to send',
    );
  }
  return { present: true, value: descriptor.value };
}

function copy(value: unknown, path: string, depth: number, state: CopyState): WireValue {
  if (value === null) {
    charge(state, path, 8);
    return null;
  }

  switch (typeof value) {
    case 'boolean':
      charge(state, path, 8);
      return value;
    case 'number':
      charge(state, path, 8);
      return value;
    case 'bigint':
      charge(state, path, 8 + Math.ceil(value.toString(16).length / 2));
      return value;
    case 'string':
      charge(state, path, 8 + value.length * 2);
      return value;
    case 'undefined':
      throw new WireValueError(path, 'it is undefined; use null so "absent" has one encoding');
    case 'function':
      throw new WireValueError(
        path,
        'it is a function; structured clone throws DataCloneError on one, so a closure ' +
          'crosses as an opaque handle or it does not cross',
      );
    case 'symbol':
      throw new WireValueError(path, 'it is a symbol; structured clone cannot carry one');
    default:
      break;
  }

  const object = value as object;

  // Cycles and shared subgraphs are the SAME mechanism. Recording the copy
  // before descending is what makes a self-reference terminate; returning the
  // recorded copy on a second visit is what keeps two properties that pointed
  // at one object pointing at one object.
  const seen = state.memo.get(object);
  if (seen !== undefined) return seen;

  if (depth >= state.limits.maxDepth) {
    throw new WireValueError(path, `it nests deeper than ${state.limits.maxDepth} levels`);
  }

  if (object instanceof Date) return copyDate(object, path, state);

  if (isUint8Array(object)) {
    charge(state, path, object.byteLength);
    // Kept by reference. This is the byte channel, the copy at `postMessage` is
    // the one that matters, and duplicating a megabyte here to prevent a
    // mutation nothing in the kernel performs would be a real cost for a
    // theoretical risk.
    state.memo.set(object, object);
    return object;
  }

  if (ArrayBuffer.isView(object) || object instanceof ArrayBuffer) {
    throw new WireValueError(
      path,
      'a PSValue carries bytes as Uint8Array; another view type would arrive as a different one',
    );
  }

  if (Array.isArray(object)) return copyArray(object as readonly unknown[], path, depth, state);

  const proto: unknown = Object.getPrototypeOf(object);
  // null is allowed as well as Object.prototype: Select-Object builds its bag
  // with a null prototype so `-Property __proto__` cannot re-parent it, and
  // that bag has to be sendable. structuredClone normalises the null back to
  // Object.prototype on the far side, which is why the ownership guarantee
  // lives in getProperty/hasProperty rather than in the prototype.
  if (proto !== Object.prototype && proto !== null) {
    // A Date from another realm fails `instanceof` above and lands here. The
    // internal-slot read is the authority, and this is the error path, so the
    // try/catch costs nothing on the path that matters.
    const time = dateValueOf(object);
    if (time !== null) return copyDate(object as Date, path, state);
    const name: unknown = (object as { constructor?: { name?: unknown } }).constructor?.name;
    throw new WireValueError(
      path,
      `it is an instance of ${typeof name === 'string' && name.length > 0 ? name : 'a class'}; ` +
        'structured clone drops the prototype and every instanceof on the far side would stop matching',
    );
  }

  return copyPSObjectOrBag(object, path, depth, state);
}

function copyDate(source: Date, path: string, state: CopyState): WireValue {
  const time = dateValueOf(source);
  if (time === null) {
    throw new WireValueError(
      path,
      'it claims to be a Date but has no [[DateValue]]; a Proxy standing in for one ' +
        'would throw DataCloneError at postMessage',
    );
  }
  charge(state, path, 16);
  // Copied, not shared: a Date is mutable, and handing the far side a reference
  // into the kernel's own graph is the one way a value can still change after
  // it was sent.
  const cloned = new Date(time);
  state.memo.set(source, cloned);
  return cloned;
}

function copyArray(
  source: readonly unknown[],
  path: string,
  depth: number,
  state: CopyState,
): readonly WireValue[] {
  charge(state, path, OVERHEAD_PER_NODE);
  const out: WireValue[] = [];
  state.memo.set(source, out);
  for (let index = 0; index < source.length; index += 1) {
    const element = ownValue(source, String(index), `${path}[${index}]`);
    if (!element.present) {
      throw new WireValueError(
        `${path}[${index}]`,
        'the array is sparse; a hole clones as undefined, which has no encoding here',
      );
    }
    out.push(copy(element.value, `${path}[${index}]`, depth + 1, state));
  }
  return out;
}

/** The three keys a `PSObject` has. Anything else on it is not part of it. */
const PS_OBJECT_KEYS: ReadonlySet<string> = new Set(['typeNames', 'properties', 'baseObject']);

function copyPSObjectOrBag(
  source: object,
  path: string,
  depth: number,
  state: CopyState,
): WireValue {
  if (Object.getOwnPropertySymbols(source).length > 0) {
    throw new WireValueError(
      path,
      'it has symbol-keyed properties, which structured clone silently drops',
    );
  }

  const typeNames = ownValue(source, 'typeNames', `${path}.typeNames`);
  const properties = ownValue(source, 'properties', `${path}.properties`);
  const psObjectShaped =
    typeNames.present &&
    Array.isArray(typeNames.value) &&
    properties.present &&
    typeof properties.value === 'object' &&
    properties.value !== null;

  // A plain record that is not a PSObject. Not a `PSValue` by the type, but the
  // sanitiser is a boundary rather than a validator of its own callers, so it
  // is rebuilt under the same rules instead of being either trusted or refused.
  // The cast is the honest half of that: what comes back is clone-safe, and it
  // is not a WireObject, because it was never a PSObject.
  if (!psObjectShaped) return copyBag(source, path, depth, state) as unknown as WireObject;

  for (const key of Object.keys(source)) {
    if (!PS_OBJECT_KEYS.has(key)) {
      throw new WireValueError(
        `${path}.${key}`,
        'a PSObject carries typeNames, properties and baseObject and nothing else',
      );
    }
  }

  charge(state, path, OVERHEAD_PER_NODE);
  const out = { typeNames: [] as readonly WireValue[], properties: {} as Record<string, WireValue> };
  state.memo.set(source, out as unknown as WireObject);

  out.typeNames = copyArray(
    typeNames.value as readonly unknown[],
    `${path}.typeNames`,
    depth + 1,
    state,
  );
  for (const name of out.typeNames) {
    if (typeof name !== 'string') {
      throw new WireValueError(`${path}.typeNames`, 'a type name must be a string');
    }
  }

  // `baseObject` is DROPPED, not rejected. It exists so a command can reach the
  // underlying host value, which is useful inside the kernel and meaningless
  // outside it — banning it from the object model would be the wrong fix.
  out.properties = copyBag(properties.value as object, `${path}.properties`, depth + 1, state);

  return out as unknown as WireObject;
}

function copyBag(
  source: object,
  path: string,
  depth: number,
  state: CopyState,
): Record<string, WireValue> {
  if (Object.getOwnPropertySymbols(source).length > 0) {
    throw new WireValueError(
      path,
      'it has symbol-keyed properties, which structured clone silently drops',
    );
  }
  const proto: unknown = Object.getPrototypeOf(source);
  if (proto !== Object.prototype && proto !== null) {
    throw new WireValueError(path, 'a property bag must be a plain object');
  }
  charge(state, path, OVERHEAD_PER_NODE);

  // Built with fromEntries, which DEFINES each key rather than assigning it.
  // `bag['__proto__'] = x` on a plain object invokes the inherited setter: the
  // key vanishes from Object.keys while getProperty still finds it through the
  // chain, and the bag's prototype becomes attacker-supplied data on the way
  // out of the kernel. fromEntries rather than Object.create(null) because
  // structuredClone NORMALISES a null prototype back to Object.prototype, so
  // the guarantee would not survive the boundary this function prepares for —
  // and the envelope would stop round-tripping identically.
  const out = Object.fromEntries([] as [string, WireValue][]);
  state.memo.set(source, out as unknown as WireObject);

  for (const key of Object.keys(source)) {
    const property = ownValue(source, key, `${path}.${key}`);
    if (!property.present) continue;
    chargeBytes(state, `${path}.${key}`, key.length * 2);
    // defineProperty for the same reason fromEntries was chosen: assignment
    // through `out[key] = ...` would invoke Object.prototype's __proto__ setter.
    Object.defineProperty(out, key, {
      value: copy(property.value, `${path}.${key}`, depth + 1, state),
      writable: true,
      enumerable: true,
      configurable: true,
    });
  }
  return out;
}

/**
 * Make a `PSValue` safe to send.
 *
 * Returns a NEW graph. It used to return the same reference when nothing needed
 * stripping, and that was where the shared-subgraph property came from — by
 * accident, and only while nothing in the graph needed stripping. A boundary
 * whose guarantees depend on the input already being clean is not a boundary,
 * so every container is rebuilt and identity is preserved by the WeakMap.
 */
export function sanitizePSValue(
  value: PSValue,
  limits: WireLimits = DEFAULT_WIRE_LIMITS,
): WireValue {
  const state: CopyState = { memo: new WeakMap(), limits, nodes: 0, bytes: 0 };
  return copy(value, 'value', 0, state);
}

/**
 * Sanitise a whole `ErrorRecord`.
 *
 * `targetObject` is a `PSValue`, so an ErrorRecord naming the object that
 * failed is a hole exactly as wide as the success stream's. It was previously
 * only CHECKED on the way out, so a command that put a host value there failed
 * instead of being carried correctly.
 */
export function sanitizeErrorRecord(
  record: ErrorRecord,
  limits: WireLimits = DEFAULT_WIRE_LIMITS,
): WireErrorRecord {
  return {
    message: record.message,
    fullyQualifiedErrorId: record.fullyQualifiedErrorId,
    category: record.category,
    exceptionType: record.exceptionType,
    ...(record.targetObject === undefined
      ? {}
      : { targetObject: sanitizePSValue(record.targetObject, limits) }),
    ...(record.invocation === undefined
      ? {}
      : {
          invocation: {
            line: record.invocation.line,
            column: record.invocation.column,
            source: record.invocation.source,
          },
        }),
  };
}

/** Same reasoning as `sanitizeErrorRecord`: `message` is a `PSValue`. */
export function sanitizeInformationRecord(
  record: InformationRecord,
  limits: WireLimits = DEFAULT_WIRE_LIMITS,
): WireInformationRecord {
  return {
    message: sanitizePSValue(record.message, limits),
    tags: [...record.tags],
    source: record.source,
    timestamp: record.timestamp,
  };
}

/** A `WireObject` is a `PSObject`; this is the widening, written once. */
export function asPSValue(value: WireValue): PSValue {
  return value as PSObject | PSValue;
}
