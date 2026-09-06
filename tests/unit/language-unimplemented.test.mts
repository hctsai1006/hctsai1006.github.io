/**
 * The list of AST nodes this engine refuses, and the profile field that is
 * supposed to declare the same list.
 *
 * `compat/profiles/*.json` carries
 *
 *     engineLimits: {
 *       nativePowerShellEngine: false,
 *       unimplementedAstNodes: [ ...40 names... ],
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
 * `tools/generate-compatibility-profile.mts` imports `unimplementedAstNodes()`
 * — which is itself derived from what `parseForExecution` consults — so the
 * declaration cannot drift from the behaviour without the generator's output
 * changing. What this file asserts:
 *
 *   1. The engine's answer is real: every name is a node pwsh 7.6.5 has, and
 *      every keyword in the table is genuinely refused by the parser.
 *   2. It is DERIVED from those declarations and not written beside them.
 *   3. The profiles declare exactly it, in both directions. A subset check
 *      alone would pass on `[]` again, which is the state this replaced.
 *   4. Nothing in it appears in a tree the execution parser ACCEPTS. That is
 *      the check that stops the list from over-claiming, and it earned its
 *      place immediately: the first derivation published `CommandAst` as
 *      unimplemented, because `&` is mapped to it for the message, while every
 *      command the engine runs is one.
 *
 * BEING DERIVED IS NOT THE SAME AS BEING RIGHT. The first derivation read three
 * tables and missed two refusals written in code — a variable reference and an
 * ErrorExpressionAst — while inheriting one name that was never a limit. The
 * profiles shipped understating by two and overstating by one, and nothing here
 * said so, because every test compared the field against the same derivation.
 */

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';

import { PWSH_AST_NODES, walk } from '../../src/language/ast.ts';
import {
  EXECUTION_REFUSED_NODES,
  MESSAGE_ONLY_NODES,
  REFUSED_WITHOUT_A_TABLE,
  UNIMPLEMENTED_KEYWORDS,
  UNIMPLEMENTED_SYNTAX,
  unimplementedAstNodes,
} from '../../src/language/unimplemented.ts';
import { parseForExecution } from '../../src/language/parse.ts';

const HERE = dirname(fileURLToPath(import.meta.url));
const PROFILES = resolve(HERE, '../../compat/profiles');
const corpus = JSON.parse(
  readFileSync(resolve(HERE, 'fixtures/lexer-corpus.json'), 'utf8'),
) as readonly string[];

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

  it('derives the list from the declarations that drive the behaviour', () => {
    // Not a hand-maintained list beside them: every entry must come from
    // something the parser actually consults, or the declaration could say one
    // thing while the parser did another.
    //
    // FOUR sources. This asserted three, and the two the parser refuses from
    // code — a variable reference, which cannot join the blanket walk because
    // `$true` must survive it, and the ErrorExpressionAst it names for a token
    // with no better name — were simply missing from the published profile.
    const declared = new Set<string>([
      ...EXECUTION_REFUSED_NODES,
      ...[...UNIMPLEMENTED_KEYWORDS.values()].map((e) => e.node),
      ...[...UNIMPLEMENTED_SYNTAX.values()].map((e) => e.node),
      ...REFUSED_WITHOUT_A_TABLE,
    ]);
    for (const node of MESSAGE_ONLY_NODES) declared.delete(node);
    assert.deepEqual([...unimplementedAstNodes()].sort(), [...declared].sort());
  });

  it('refuses a variable reference by name, and declares that it does', () => {
    // The one the first derivation missed. `$x` is refused as
    // VariableExpressionAst — there is no variable table — while `$true` is a
    // literal the binder reads by spelling, so the node cannot join the blanket
    // walk. That exemption is why it needs its own declaration rather than a
    // row in EXECUTION_REFUSED_NODES.
    const refused = parseForExecution('Remove-Item $target');
    assert.equal(refused.ok, false);
    if (!refused.ok) {
      assert.ok(refused.refusals.some((r) => r.nodeType === 'VariableExpressionAst'));
    }
    assert.ok(unimplementedAstNodes().includes('VariableExpressionAst'));
    // And the exemption still holds, or `-Switch:$false` would stop parsing.
    assert.equal(parseForExecution('Sort-Object -Descending:$false').ok, true);
  });

  it('never declares a node that appears in a tree the parser ACCEPTS', () => {
    // THE CHECK THAT FOUND `CommandAst`. `UNIMPLEMENTED_SYNTAX` maps the call
    // operator `&` to CommandAst — correctly, because that is the node pwsh
    // builds for `& 'Get-Location'` and a message naming anything else would
    // not be lookupable — and deriving the published list straight from the
    // message names therefore declared that this engine does not implement
    // CommandAst. Every command it runs is one.
    //
    // Derived independently of `MESSAGE_ONLY_NODES` rather than asserting it:
    // walk every tree the execution parser accepts and take the node kinds that
    // really occur. Nothing in that set may be published as a limit.
    const declared = new Set<string>(unimplementedAstNodes());
    const real = new Set<string>(PWSH_AST_NODES);
    const executable = new Map<string, string>();
    let accepted = 0;
    for (const source of corpus) {
      const parsed = parseForExecution(source);
      if (!parsed.ok) continue;
      accepted += 1;
      for (const node of walk(parsed.ast)) {
        if (real.has(node.kind) && !executable.has(node.kind)) executable.set(node.kind, source);
      }
    }
    assert.ok(accepted > 50, `only ${accepted} corpus lines were accepted; the check proved nothing`);
    for (const [kind, source] of executable) {
      assert.ok(
        !declared.has(kind),
        `the profiles declare ${kind} unimplemented, but ${JSON.stringify(source)} parses to a ` +
          'tree containing one and the execution parser accepts it',
      );
    }
    // The engine really does run commands, which is the claim the exclusion
    // rests on. If this ever stops holding, the exclusion has to go too.
    assert.ok(executable.has('CommandAst'));
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
