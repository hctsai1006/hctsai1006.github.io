/**
 * The list of AST nodes this engine refuses, and the profile field that is
 * supposed to declare the same list.
 *
 * `compat/profiles/*.json` carries
 *
 *     engineLimits: {
 *       nativePowerShellEngine: false,
 *       unimplementedAstNodes: [ ...37 names... ],
 *       notes: "... Recognised-but-unimplemented syntax must fail with an
 *               explicit error naming the AST node rather than silently doing
 *               something approximate."
 *     }
 *
 * The notes state the rule this project runs on. The LIST beside them used to
 * be `[]`, in both profiles, which is not true of an engine that says in the
 * same object that it does not execute PowerShell.
 *
 * THE FIX WAS NOT TO TYPE THE NAMES INTO THE PROFILES. They are generated, and
 * `tools/generate-compatibility-profile.mts` now imports
 * `unimplementedAstNodes()` — which is itself derived from the three tables
 * `parseForExecution` consults — so the declaration cannot drift from the
 * behaviour without the generator's output changing. What this file asserts:
 *
 *   1. The engine's answer is real: every name is a node pwsh 7.6.5 has, and
 *      every keyword in the table is genuinely refused by the parser.
 *   2. It is DERIVED from those tables and not declared beside them.
 *   3. The profiles declare exactly it, in both directions. A subset check
 *      alone would pass on `[]` again, which is the state this replaced.
 */

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';

import { PWSH_AST_NODES } from '../../src/language/ast.ts';
import {
  EXECUTION_REFUSED_NODES,
  UNIMPLEMENTED_KEYWORDS,
  UNIMPLEMENTED_SYNTAX,
  unimplementedAstNodes,
} from '../../src/language/unimplemented.ts';
import { parseForExecution } from '../../src/language/parse.ts';

const HERE = dirname(fileURLToPath(import.meta.url));
const PROFILES = resolve(HERE, '../../compat/profiles');

interface Profile {
  readonly profile: string;
  readonly engineLimits?: {
    readonly nativePowerShellEngine: boolean;
    readonly unimplementedAstNodes?: readonly string[];
    readonly notes?: string;
  };
}

const profiles: readonly Profile[] = [
  'powershell-7.6.5-linux.json',
  'powershell-7.7.0-preview.4-linux.json',
].map((name) => JSON.parse(readFileSync(resolve(PROFILES, name), 'utf8')) as Profile);

describe('the engine names what it will not run', () => {
  it('refuses a real, non-empty set of AST nodes', () => {
    const nodes = unimplementedAstNodes();
    assert.ok(nodes.length >= 15, `only ${nodes.length} node types are refused`);
    const real = new Set<string>(PWSH_AST_NODES);
    for (const node of nodes) {
      assert.ok(real.has(node), `${node} is not a node the reference implementation has`);
    }
  });

  it('derives the list from the tables that drive the behaviour', () => {
    // Not a hand-maintained list beside them: every entry must come from a
    // table something actually consults, or the declaration could say one thing
    // while the parser did another.
    const fromTables = new Set<string>([
      ...EXECUTION_REFUSED_NODES,
      ...[...UNIMPLEMENTED_KEYWORDS.values()].map((e) => e.node),
      ...[...UNIMPLEMENTED_SYNTAX.values()].map((e) => e.node),
    ]);
    assert.deepEqual([...unimplementedAstNodes()].sort(), [...fromTables].sort());
  });

  it('every keyword in the table is genuinely refused by the parser', () => {
    // The table could name a keyword the parser never reaches. Each one is
    // exercised.
    for (const [keyword, entry] of UNIMPLEMENTED_KEYWORDS) {
      const parsed = parseForExecution(`${keyword} whatever`);
      assert.equal(parsed.ok, false, `"${keyword}" was accepted`);
      if (parsed.ok) continue;
      assert.ok(
        parsed.refusals.some((r) => r.nodeType === entry.node),
        `"${keyword}" was refused, but not as ${entry.node}: ` +
          JSON.stringify(parsed.refusals.map((r) => r.nodeType)),
      );
    }
  });

  it('keyword matching is case-insensitive, as PowerShell keywords are', () => {
    for (const source of ['IF ($x) { 1 }', 'ForEach ($i in 1) { }', 'FUNCTION f { }']) {
      assert.equal(parseForExecution(source).ok, false, source);
    }
  });
});

describe('the profile field meant to declare the same list', () => {
  it('still says the engine executes no PowerShell', () => {
    for (const profile of profiles) {
      assert.equal(
        profile.engineLimits?.nativePowerShellEngine,
        false,
        `${profile.profile} changed its engine claim`,
      );
    }
  });

  it('states the rule this project runs on', () => {
    for (const profile of profiles) {
      assert.match(
        profile.engineLimits?.notes ?? '',
        /naming the AST node/u,
        `${profile.profile} lost the rule from its notes`,
      );
    }
  });

  it('declares a SUBSET of what the engine refuses, never something extra', () => {
    // The direction that must never break: a profile promising a node is
    // refused when it is not would be a lie a user could act on. A profile that
    // under-declares is merely incomplete.
    const engine = new Set<string>(unimplementedAstNodes());
    for (const profile of profiles) {
      for (const declared of profile.engineLimits?.unimplementedAstNodes ?? []) {
        assert.ok(
          engine.has(declared),
          `${profile.profile} declares ${declared} unimplemented, but the engine does not refuse it`,
        );
      }
    }
  });

  it('declares EXACTLY what the engine refuses, in both profiles', () => {
    // This test used to assert `[[], []]` and explain why the gap was still
    // open: the profiles are generated, and filling the field meant changing
    // `tools/generate-compatibility-profile.mts`. It has been changed — it
    // imports `unimplementedAstNodes` and writes what it returns — so the
    // assertion that stood here has become the equality its own comment said to
    // replace it with.
    //
    // Equality in BOTH directions, deliberately. Subset-only (the test above)
    // would pass on an empty declaration again, which is the state this replaced.
    const engine = [...unimplementedAstNodes()];
    assert.ok(engine.length > 0, 'the engine refuses nothing, which contradicts nativePowerShellEngine: false');
    for (const profile of profiles) {
      assert.deepEqual(
        [...(profile.engineLimits?.unimplementedAstNodes ?? [])],
        engine,
        `${profile.profile} declares a different set from the one the parser refuses; ` +
          'regenerate with `npm run profiles`',
      );
    }
  });
});
