/**
 * Tests for the script block as an opaque handle.
 *
 * The claim being pinned is narrow and load-bearing: a script block is DATA on
 * the wire and a closure only in the realm that made it.
 *
 * Before this, a script block was `psWrap({}, [SCRIPT_BLOCK_TYPE], fn)` — a
 * JavaScript function in `PSObject.baseObject`, typed as `PSValue` and therefore
 * as if it could be sent. `structuredClone` throws `DataCloneError` on a
 * function, and the kernel's sanitiser strips `baseObject` before emitting, so
 * `Where-Object` needed the closure and the boundary destroyed it. Every test
 * passed anyway, because everything ran in one JS realm.
 */

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

import {
  SCRIPT_BLOCK_TYPE,
  ScriptBlockRegistry,
  asScriptBlock,
  releaseScriptBlock,
  scriptBlock,
  scriptBlockHandleOf,
  scriptBlocks,
} from '../../src/commands/powershell/support.ts';
import { whereObject } from '../../src/commands/powershell/where-object.ts';
import { psObject } from '../../src/pipeline/psobject.ts';
import type { PSValue } from '../../src/pipeline/psobject.ts';
import { collectingStreams } from '../../src/pipeline/streams.ts';
import type { BindingResult, InvocationContext } from '../../src/commands/invocation.ts';
import { cloneSafetyProblems, sanitizePSValue } from '../../src/kernel/protocol.ts';

describe('a script block on the wire', () => {
  it('carries no function, so it survives structuredClone', () => {
    const block = scriptBlock((current) => current);
    assert.deepEqual(cloneSafetyProblems(block, 'scriptblock'), []);
    assert.deepEqual(structuredClone(block), block);
    assert.equal(Object.hasOwn(block, 'baseObject'), false);
  });

  it('survives the kernel sanitiser unchanged, which the old shape did not', () => {
    const block = scriptBlock(() => true);
    const safe = sanitizePSValue(block);
    assert.deepEqual(safe, block);
    // And the handle still resolves after the round trip, because the handle is
    // the whole content.
    assert.equal(typeof asScriptBlock(safe as PSValue), 'function');
  });

  it('keeps the type name, so -is [scriptblock] still works without a special case', () => {
    assert.equal(scriptBlock(() => 1).typeNames[0], SCRIPT_BLOCK_TYPE);
  });

  it('round-trips through structuredClone and still runs', async () => {
    const block = scriptBlock((current) => (current as number) * 2);
    const cloned = structuredClone(block);
    const fn = asScriptBlock(cloned);
    assert.notEqual(fn, undefined);
    assert.equal(await fn?.(21), 42);
  });
});

describe('a handle is only good in its own realm', () => {
  it('does not resolve against a different registry', () => {
    // The Worker case, modelled: the block was made over there and the handle
    // arrived here. It must fail, not resolve to a local block.
    const there = new ScriptBlockRegistry();
    const block = scriptBlock(() => 'from the worker', there);

    assert.equal(asScriptBlock(block, there)?.(null), 'from the worker');
    assert.equal(asScriptBlock(block, new ScriptBlockRegistry()), undefined);
    assert.equal(asScriptBlock(block), undefined, 'and not against the default registry either');
  });

  it('does not collide with a same-numbered handle from another realm', () => {
    // The failure this guards is a WRONG answer rather than a missing one: two
    // registries both counting from 1 would hand out the same id, and the first
    // block registered here would run in place of the one that was asked for.
    const here = new ScriptBlockRegistry();
    const there = new ScriptBlockRegistry();
    const mine = scriptBlock(() => 'mine', here);
    scriptBlock(() => 'theirs', there);

    assert.notEqual(
      scriptBlockHandleOf(mine)?.id,
      scriptBlockHandleOf(scriptBlock(() => 'theirs2', there))?.id,
    );
    assert.equal(asScriptBlock(mine, there), undefined);
  });

  it('does not resolve a handle that outlived its registry entry', () => {
    const registry = new ScriptBlockRegistry();
    const block = scriptBlock(() => 'alive', registry);
    assert.equal(registry.size, 1);

    assert.equal(releaseScriptBlock(block, registry), true);
    assert.equal(registry.size, 0);
    assert.equal(asScriptBlock(block, registry), undefined, 'a released handle is dead, not stale');
    assert.equal(releaseScriptBlock(block, registry), false, 'releasing twice is not an error');

    // The id must not be reused, or a later block would answer to a handle the
    // caller still holds.
    const later = scriptBlock(() => 'later', registry);
    assert.notEqual(scriptBlockHandleOf(later)?.id, scriptBlockHandleOf(block)?.id);
  });

  it('clear() drops everything and the handles stop resolving', () => {
    const registry = new ScriptBlockRegistry();
    const a = scriptBlock(() => 1, registry);
    const b = scriptBlock(() => 2, registry);
    registry.clear();
    assert.equal(registry.size, 0);
    assert.equal(asScriptBlock(a, registry), undefined);
    assert.equal(asScriptBlock(b, registry), undefined);
  });
});

describe('telling a non-script-block from an unresolvable one', () => {
  it('scriptBlockHandleOf answers for a handle that cannot resolve', () => {
    const there = new ScriptBlockRegistry();
    const block = scriptBlock(() => 1, there);
    assert.notEqual(scriptBlockHandleOf(block), undefined, 'it IS a script block');
    assert.equal(asScriptBlock(block), undefined, 'whose closure is not here');
  });

  it('answers undefined for things that are not script blocks at all', () => {
    for (const value of [undefined, null, 7, 'text', psObject({ A: 1 })]) {
      assert.equal(scriptBlockHandleOf(value as PSValue | undefined), undefined);
    }
    // Right type name, no handle: a hand-built impostor is not a script block.
    const impostor = psObject({ Kind: 'script-block-handle' }, [SCRIPT_BLOCK_TYPE, 'System.Object']);
    assert.equal(scriptBlockHandleOf(impostor), undefined);
  });
});

// ---------------------------------------------------------------------------
// the command that consumes one
// ---------------------------------------------------------------------------

async function* from(values: readonly PSValue[]): AsyncGenerator<PSValue> {
  for (const value of values) yield value;
}

function host(input: readonly PSValue[]): {
  context: InvocationContext;
  collected: ReturnType<typeof collectingStreams>['collected'];
} {
  const streams = collectingStreams();
  return {
    collected: streams.collected,
    context: {
      profile: {
        displayVersion: '7.6.5',
        behavior: (_key, fallback) => fallback,
        scopedBehavior: (_key, whenUndeclared) => whenUndeclared,
      },
      streams,
      native: null,
      input: from(input),
      cwd: '/',
      env: new Map(),
      signal: new AbortController().signal,
      requireCapability: () => undefined,
      fs: null,
      preferences: null,
      dialog: null,
    },
  };
}

function bind(parameters: Record<string, PSValue>): BindingResult {
  return { parameters, parameterSet: '__AllParameterSets', remaining: [] };
}

describe('Where-Object with a handle it cannot resolve', () => {
  it('runs the filter normally when the closure is in this realm', async () => {
    const { context, collected } = host([1, 2, 3, 4]);
    const filter = scriptBlock((current) => (current as number) % 2 === 0);
    const code = await whereObject.invoke(context, bind({ FilterScript: filter }));
    assert.equal(code, 0);
    assert.deepEqual(collected.success.values, [2, 4]);
  });

  it('fails loudly instead of passing every object through', async () => {
    // The silent-wrong-answer this exists to prevent: an unresolvable handle
    // would leave `filter` undefined, and Where-Object's no-filter branch keeps
    // everything. A filter that stops filtering is worse than one that errors.
    const elsewhere = new ScriptBlockRegistry();
    const filter = scriptBlock(() => false, elsewhere);

    const { context, collected } = host([1, 2, 3]);
    const code = await whereObject.invoke(context, bind({ FilterScript: filter }));

    assert.notEqual(code, 0);
    assert.deepEqual(collected.success.values, [], 'nothing was passed through');
    assert.equal(collected.error.values.length, 1);
    assert.match(
      collected.error.values[0]?.fullyQualifiedErrorId as string,
      /^ScriptBlockNotInThisRuntime,Where-Object$/u,
    );
  });
});

describe('the default registry', () => {
  it('exists and is realm-scoped', () => {
    assert.equal(typeof scriptBlocks.realm, 'string');
    assert.ok(scriptBlocks.realm.length > 0);
    const before = scriptBlocks.size;
    const block = scriptBlock(() => 1);
    assert.equal(scriptBlocks.size, before + 1);
    releaseScriptBlock(block);
    assert.equal(scriptBlocks.size, before);
  });
});
