/**
 * Tests for the trust boundary between a kernel-local value and a wire value.
 *
 * Two claims are pinned here, and both were broken before.
 *
 * The two halves of the boundary AGREE about cycles. `cloneSafetyProblems`
 * deliberately permits one, because structured clone preserves one; the
 * sanitiser recursed with no visited set and threw `RangeError: Maximum call
 * stack size exceeded` on the same value. A checker that says yes and a
 * converter that dies is not one boundary, it is two.
 *
 * The sanitiser is a BOUNDARY and not a tidy-up. It used to return the input by
 * reference whenever nothing needed stripping, which meant every guarantee it
 * appeared to give — shared subgraphs, no host object escaping, no getter
 * invoked — held only for inputs that were already clean.
 */

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

import { psObject, psWrap } from '../../src/pipeline/psobject.ts';
import type { PSObject, PSValue } from '../../src/pipeline/psobject.ts';
import { errorRecord } from '../../src/pipeline/streams.ts';
import {
  DEFAULT_WIRE_LIMITS,
  WireValueError,
  sanitizeErrorRecord,
  sanitizeInformationRecord,
  sanitizePSValue,
} from '../../src/kernel/wire.ts';
import { cloneSafetyProblems, isCloneSafe } from '../../src/kernel/protocol.ts';

/** A PSObject whose property bag is writable, for building malformed graphs. */
interface MutablePSObject {
  readonly typeNames: readonly string[];
  readonly properties: Record<string, PSValue>;
}

function mutable(
  properties: Record<string, PSValue>,
  typeNames: readonly string[] = ['T', 'System.Object'],
): MutablePSObject {
  return { typeNames, properties };
}

describe('cycles', () => {
  it('survives a self-reference through a property', () => {
    // The exact value from the review: `const c = psObject({n:1}); c.properties.self = c;`
    const cyclic = mutable({ n: 1 });
    cyclic.properties['self'] = cyclic;

    // The clone checker already accepted this, which is what made the
    // disagreement a defect rather than a missing feature.
    assert.deepEqual(cloneSafetyProblems(cyclic), []);

    const safe = sanitizePSValue(cyclic) as PSObject;
    assert.equal(safe.properties['n'], 1);
    assert.equal(safe.properties['self'], safe, 'the cycle is preserved, not cut');
    // structuredClone is the algorithm this is preparing for; it handles cycles.
    const cloned = structuredClone(safe) as PSObject;
    assert.equal(cloned.properties['self'], cloned);
  });

  it('survives a cycle reached through an ARRAY rather than a property', () => {
    // The adversarial variant: the visited set has to cover array elements too,
    // and a fix that only memoised PSObjects would still blow the stack here.
    const list: PSValue[] = [];
    const holder = mutable({ items: list });
    list.push(holder);

    const safe = sanitizePSValue(holder) as PSObject;
    const items = safe.properties['items'] as readonly PSValue[];
    assert.equal(items[0], safe);
  });

  it('survives a cycle that only closes through a stripped object', () => {
    // baseObject is dropped, so the node is rebuilt; the memo has to be
    // recorded BEFORE descending or this recurses forever.
    const wrapped = psWrap({}, ['T'], { host: true }) as PSObject;
    (wrapped.properties as Record<string, PSValue>)['back'] = wrapped;

    const safe = sanitizePSValue(wrapped) as PSObject;
    assert.equal(safe.properties['back'], safe);
    assert.equal(Object.hasOwn(safe, 'baseObject'), false);
  });
});

describe('shared subgraphs', () => {
  it('two properties pointing at one object still point at one object', () => {
    const shared = psObject({ Id: 7 });
    const parent = psObject({ left: shared, right: shared });

    const safe = sanitizePSValue(parent) as PSObject;
    assert.notEqual(safe.properties['left'], shared, 'the graph is rebuilt, not aliased');
    assert.equal(safe.properties['left'], safe.properties['right']);
  });

  it('holds even when something in the graph needed stripping', () => {
    // This is the case that used to fail. Sharing came from returning the input
    // by reference, so the first `baseObject` anywhere in the graph split every
    // shared node below it into two copies.
    const shared = psWrap({ Id: 7 }, ['T'], new Map());
    const parent = psObject({ left: shared, right: shared });

    const safe = sanitizePSValue(parent) as PSObject;
    assert.equal(safe.properties['left'], safe.properties['right']);
    assert.equal(isCloneSafe(safe), true);
  });

  it('shares a Date the same way', () => {
    const when = new Date(1_700_000_000_000);
    const safe = sanitizePSValue(psObject({ a: when, b: when })) as PSObject;
    assert.equal(safe.properties['a'], safe.properties['b']);
    assert.notEqual(safe.properties['a'], when, 'a mutable Date is copied, not shared with the kernel');
    assert.deepEqual(safe.properties['a'], when);
  });
});

describe('what the boundary refuses', () => {
  it('never invokes a getter', () => {
    let invoked = 0;
    const bag: Record<string, PSValue> = {};
    Object.defineProperty(bag, 'Trap', {
      enumerable: true,
      configurable: true,
      get(): PSValue {
        invoked += 1;
        return 'harmless-looking';
      },
    });

    assert.throws(() => sanitizePSValue(mutable(bag)), (error: unknown) => {
      assert.ok(error instanceof WireValueError);
      assert.match(error.message, /accessor property/u);
      assert.equal(error.path, 'value.properties.Trap');
      return true;
    });
    assert.equal(invoked, 0, 'the getter must not run at the boundary');
  });

  it('refuses a Proxy standing in for a plain object', () => {
    // JavaScript gives no portable "is this a Proxy?". The guarantee is
    // structural instead: every container is rebuilt, so a Proxy cannot be
    // carried by reference — and here the trap is caught outright because a
    // rebuilt bag reads through descriptors.
    let trapped = 0;
    const target = psObject({ Name: 'real' });
    const proxy = new Proxy(target, {
      get(t, key, receiver): unknown {
        trapped += 1;
        return Reflect.get(t, key, receiver);
      },
    });

    const safe = sanitizePSValue(psObject({ child: proxy })) as PSObject;
    const child = safe.properties['child'] as PSObject;
    assert.notEqual(child, proxy, 'the Proxy itself must not reach the far side');
    assert.equal(child.properties['Name'], 'real');
    assert.equal(trapped, 0, 'values are read from descriptors, never through [[Get]]');
  });

  it('refuses a Proxy standing in for a Date, which structuredClone would reject', () => {
    const proxied = new Proxy(new Date(0), {}) as unknown as PSValue;
    // The reason this matters: postMessage would throw on it.
    assert.throws(() => structuredClone(proxied));
    assert.throws(() => sanitizePSValue(psObject({ when: proxied })), WireValueError);
  });

  it('refuses a function, naming the path', () => {
    const value = psObject({ nested: psObject({ fn: (() => 1) as unknown as PSValue }) });
    assert.throws(() => sanitizePSValue(value), (error: unknown) => {
      assert.ok(error instanceof WireValueError);
      assert.equal(error.path, 'value.properties.nested.properties.fn');
      return true;
    });
  });

  it('refuses undefined, a symbol, and a sparse array', () => {
    assert.throws(() => sanitizePSValue(psObject({ a: undefined as unknown as PSValue })), WireValueError);
    const symbolKeyed = { typeNames: ['T'], properties: { [Symbol('x')]: 1, a: 1 } };
    assert.throws(() => sanitizePSValue(symbolKeyed as unknown as PSValue), WireValueError);
    // eslint-disable-next-line no-sparse-arrays
    const sparse = [1, , 3] as unknown as PSValue;
    assert.throws(() => sanitizePSValue(sparse), /sparse/u);
  });

  it('refuses an extra own key on a PSObject rather than smuggling it', () => {
    const smuggled = { typeNames: ['T'], properties: {}, handle: () => 1 } as unknown as PSValue;
    assert.throws(() => sanitizePSValue(smuggled), /typeNames, properties and baseObject/u);
  });
});

describe('limits', () => {
  it('rejects a graph deeper than the limit instead of overflowing the stack', () => {
    let deep: PSValue = psObject({ leaf: 1 });
    for (let i = 0; i < DEFAULT_WIRE_LIMITS.maxDepth; i += 1) deep = psObject({ child: deep });
    assert.throws(() => sanitizePSValue(deep), /nests deeper than/u);
  });

  it('rejects too many nodes', () => {
    const many = Array.from({ length: 40 }, (_unused, i) => i) as PSValue;
    assert.throws(
      () => sanitizePSValue(many, { ...DEFAULT_WIRE_LIMITS, maxNodes: 10 }),
      /more than 10 nodes/u,
    );
  });

  it('rejects a value that is merely enormous', () => {
    const big = psObject({ text: 'x'.repeat(4096) });
    assert.throws(
      () => sanitizePSValue(big, { ...DEFAULT_WIRE_LIMITS, maxBytes: 1024 }),
      /larger than 1024 bytes/u,
    );
  });

  it('counts a shared node once, because it is copied once', () => {
    const shared = psObject({ a: 1, b: 2, c: 3, d: 4 });
    const budget = { ...DEFAULT_WIRE_LIMITS, maxNodes: 20 };

    const withSharing = psObject({ one: shared, two: shared, three: shared });
    assert.doesNotThrow(() => sanitizePSValue(withSharing, budget));

    // The same shape without sharing, so the assertion above is about sharing
    // and not about the budget happening to be generous.
    const withoutSharing = psObject({
      one: psObject({ a: 1, b: 2, c: 3, d: 4 }),
      two: psObject({ a: 1, b: 2, c: 3, d: 4 }),
      three: psObject({ a: 1, b: 2, c: 3, d: 4 }),
    });
    assert.throws(() => sanitizePSValue(withoutSharing, budget), /more than 20 nodes/u);
  });
});

describe('what the boundary keeps', () => {
  it('keeps an own __proto__ key as an own property, without re-parenting the bag', () => {
    // The property bag is built with fromEntries, which DEFINES rather than
    // assigns. `bag['__proto__'] = x` would invoke the inherited setter: the key
    // would vanish from Object.keys while getProperty still found it through the
    // chain, and the bag's prototype would become attacker-supplied data on the
    // way out of the kernel.
    //
    // Object.create(null) is NOT the fix, and this test is why it cannot be
    // asserted here: structuredClone NORMALISES a null prototype back to
    // Object.prototype, so the guarantee would not survive the boundary this
    // function exists to prepare for.
    const hostile = mutable(Object.fromEntries([['__proto__', psObject({ polluted: true })]]));

    const safe = sanitizePSValue(hostile) as PSObject;
    const bag = safe.properties;
    assert.deepEqual(Object.keys(bag), ['__proto__']);
    assert.equal(Object.hasOwn(bag, '__proto__'), true);
    assert.equal(Object.getPrototypeOf(bag), Object.prototype, 'the bag was not re-parented');
    assert.equal(({} as Record<string, unknown>)['polluted'], undefined, 'nothing global was touched');

    // And it survives the algorithm this is all preparing for.
    const cloned = structuredClone(safe) as PSObject;
    assert.equal(Object.hasOwn(cloned.properties, '__proto__'), true);
    assert.equal(Object.getPrototypeOf(cloned.properties), Object.prototype);
  });

  it('keeps a null-prototype bag sendable, because Select-Object builds one', () => {
    const bag = Object.create(null) as Record<string, PSValue>;
    bag['Name'] = 'x';
    const safe = sanitizePSValue(mutable(bag)) as PSObject;
    assert.equal(safe.properties['Name'], 'x');
    assert.equal(isCloneSafe(safe), true);
  });

  it('keeps bytes as the same bytes', () => {
    const bytes = new Uint8Array([1, 2, 3]);
    const safe = sanitizePSValue(psObject({ Raw: bytes })) as PSObject;
    assert.equal(safe.properties['Raw'], bytes);
  });

  it('strips baseObject from a PSObject, nested and in arrays', () => {
    const nested = psObject({
      Child: psWrap({ X: 1 }, ['T'], new Map()),
      List: [psWrap({ Y: 2 }, ['T'], new Map())],
    });
    const safe = sanitizePSValue(nested);
    assert.equal(isCloneSafe(safe), true);
    assert.deepEqual(structuredClone(safe), safe);
  });
});

describe('the records that carry a PSValue', () => {
  it('sanitises ErrorRecord.targetObject rather than only checking it', () => {
    const record = errorRecord('bad', 'Boom', 'Test', 'InvalidData', {
      targetObject: psWrap({ X: 1 }, ['T'], new WeakMap()) as PSValue,
    });
    assert.equal(isCloneSafe(record), false);
    const safe = sanitizeErrorRecord(record);
    assert.deepEqual(cloneSafetyProblems(safe), []);
    assert.deepEqual(structuredClone(safe), safe);
  });

  it('sanitises InformationRecord.message the same way', () => {
    const safe = sanitizeInformationRecord({
      message: psWrap({ X: 1 }, ['T'], new WeakMap()),
      tags: ['host'],
      source: 'Write-Host',
      timestamp: 1,
    });
    assert.deepEqual(cloneSafetyProblems(safe), []);
  });

  it('leaves an absent targetObject absent rather than present-and-undefined', () => {
    const safe = sanitizeErrorRecord(errorRecord('bad', 'Boom', 'Test'));
    assert.equal(Object.hasOwn(safe, 'targetObject'), false);
    assert.equal(Object.hasOwn(safe, 'invocation'), false);
  });
});
