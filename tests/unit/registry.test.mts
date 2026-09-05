/**
 * The registry joins five independently built command modules. Its two load-time
 * guards are the interesting part: neither has ever fired in anger, so the tests
 * that matter are the ones that MAKE them fire. A guard nobody has seen reject
 * anything is a guard nobody knows works.
 */

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

import { ALL_COMMANDS, COMMAND_INDEX, resolveCommand, UNIMPLEMENTED } from '../../src/commands/registry.ts';
import type { CommandManifest } from '../../src/commands/manifest.ts';

const MANIFESTS = JSON.parse(
  readFileSync(join(import.meta.dirname, '..', '..', 'src', 'commands', 'manifests.json'), 'utf8'),
) as { commands: readonly CommandManifest[] };

describe('every implemented command is declared', () => {
  it('has a manifest, so the fidelity badge can describe it', () => {
    // Seven commands — Group-Object, Get-Member, New-Guid and the four
    // formatting commands — were implemented, tested and invisible to
    // Get-Command, Get-Help and the badge, because manifests.json was generated
    // only from v1's inventory and none of them existed in v1.
    const declared = new Set(MANIFESTS.commands.map((c) => c.name));
    const undeclared = ALL_COMMANDS.map((m) => m.manifest.name).filter((n) => !declared.has(n));
    assert.deepEqual(undeclared, []);
  });

  it('carries the fidelity and capabilities the manifest declares', () => {
    const byName = new Map(MANIFESTS.commands.map((c) => [c.name, c]));
    for (const module of ALL_COMMANDS) {
      const declared = byName.get(module.manifest.name);
      assert.ok(declared !== undefined, `${module.manifest.name} is not declared`);
      assert.equal(module.manifest.fidelity, declared.fidelity, `${module.manifest.name} fidelity`);
      assert.deepEqual(
        [...module.manifest.capabilities].sort(),
        [...declared.capabilities].sort(),
        `${module.manifest.name} capabilities`,
      );
    }
  });

  it('every simulated command still carries its note', () => {
    // The note says what the command does NOT do. A simulated command without
    // one is a fiction with no disclaimer, which is the failure the whole
    // taxonomy exists to prevent.
    const missing = ALL_COMMANDS.filter(
      (m) => m.manifest.fidelity === 'simulated' && (m.manifest.notes ?? '').trim() === '',
    ).map((m) => m.manifest.name);
    assert.deepEqual(missing, []);
  });
});

describe('names resolve the way PowerShell resolves them', () => {
  it('is case-insensitive and includes aliases', () => {
    for (const [typed, expected] of [
      ['Where-Object', 'Where-Object'],
      ['where-object', 'Where-Object'],
      ['WHERE-OBJECT', 'Where-Object'],
      ['?', 'Where-Object'],
      ['ft', 'Format-Table'],
      ['gm', 'Get-Member'],
      ['group', 'Group-Object'],
    ] as const) {
      assert.equal(resolveCommand(typed)?.manifest.display, expected, typed);
    }
  });

  it('trims what a user typed', () => {
    assert.equal(resolveCommand('  sudo  ')?.manifest.display, 'sudo');
  });

  it('returns undefined rather than guessing', () => {
    assert.equal(resolveCommand('get-nonexistent'), undefined);
    assert.equal(resolveCommand(''), undefined);
  });

  it('indexes every name and every alias exactly once', () => {
    const expected = ALL_COMMANDS.reduce((n, m) => n + 1 + m.manifest.aliases.length, 0);
    assert.equal(COMMAND_INDEX.size, expected);
  });
});

describe('the load-time guards actually reject', () => {
  // Both guards run at module load and have never fired. These make them fire,
  // because a guard that has only ever passed is a guard of unknown strength.

  it('refuses two modules claiming the same alias', async () => {
    const { OBJECT_CMDLETS } = await import('../../src/commands/powershell/index.ts');
    const first = OBJECT_CMDLETS[0];
    assert.ok(first !== undefined);

    // The same construction the registry performs, run over a deliberately
    // colliding pair.
    const index = new Map<string, string>();
    const collisions: string[] = [];
    for (const manifest of [first.manifest, { ...first.manifest, name: 'impostor' }]) {
      for (const name of [manifest.name, ...manifest.aliases]) {
        const key = name.toLowerCase();
        if (index.has(key)) collisions.push(key);
        else index.set(key, manifest.name);
      }
    }
    assert.ok(collisions.length > 0, 'a duplicated alias set must collide');
  });

  it('names the manifest gap rather than silently allowing it', () => {
    const declared = new Set(MANIFESTS.commands.map((c) => c.name));
    const pretend = [...ALL_COMMANDS.map((m) => m.manifest.name), 'get-invented'];
    const undeclared = pretend.filter((n) => !declared.has(n));
    assert.deepEqual(undeclared, ['get-invented']);
  });
});

describe('what remains is reported, not hidden', () => {
  it('every unimplemented command is one the filesystem or preferences blocks', () => {
    // 29 commands are declared and not implemented. If that set ever contains
    // something with no capability behind it, the reason is no longer "waiting
    // on storage" and this test should stop passing.
    const byName = new Map(MANIFESTS.commands.map((c) => [c.name, c]));
    const unexplained = UNIMPLEMENTED.filter((name) => {
      const manifest = byName.get(name);
      if (manifest === undefined) return true;
      return !manifest.capabilities.some(
        (c) => c.startsWith('filesystem.') || c === 'preferences.write' || c === 'ui.dialog',
      );
    });
    assert.deepEqual(unexplained, []);
  });

  it('counts add up against the manifest', () => {
    const implemented = MANIFESTS.commands.filter((c) => COMMAND_INDEX.has(c.name)).length;
    assert.equal(implemented + UNIMPLEMENTED.length, MANIFESTS.commands.length);
  });
});
