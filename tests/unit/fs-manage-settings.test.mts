/**
 * `Set-Theme` and `Reset-FileSystem`: the preference and the point of no return.
 *
 * `Reset-FileSystem` is the reason this file is longer than it looks. Its
 * classification declares one capability, `filesystem.delete`, and that set
 * cannot express the command — the mount root refuses removal, `/home` and
 * `/tmp` are root-owned, and the only reachable targets are found by READING.
 * So the tests come in pairs: what the command does when the capability it
 * needs is granted, and what it says when it is not. The second is the state
 * the repository is actually in, and it is pinned rather than worked around.
 */

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

import type { SeedSpec } from '../../src/storage/index.ts';
import type { CommandModule } from '../../src/commands/invocation.ts';
import {
  THEMES,
  THEME_PREFERENCE_KEY,
  declares,
  resetFileSystem,
  setTheme,
} from '../../src/commands/fs-manage/index.ts';
import {
  StubDialog,
  StubPreferences,
  TEST_EPOCH_MS,
  TEST_HOME,
  firstError,
  rig,
} from './fs-manage-harness.mts';

// ---------------------------------------------------------------------------
// Set-Theme
// ---------------------------------------------------------------------------

describe('Set-Theme writes a preference and nothing else', () => {
  it('stores the scheme under the key v1 used', async () => {
    // The key is `thc1006.theme` byte for byte, so a visitor who chose `pi` in
    // the shipped terminal does not silently come back to `campbell`.
    const r = await rig();
    const code = await r.run(setTheme, { parameters: { Name: 'pi' } });

    assert.equal(code, 0);
    assert.deepEqual(r.errors, []);
    assert.deepEqual(r.values, ['Theme set to pi']);
    assert.deepEqual(r.preferences?.writes, [{ key: THEME_PREFERENCE_KEY, value: 'pi' }]);
  });

  it('accepts the bare positional form the boot banner advertises', async () => {
    // v1: `argOf(a,'Name') || firstArg(raw)`, which is what makes `Set-Theme pi`
    // and `theme pi` work.
    const r = await rig();
    assert.equal(await r.run(setTheme, { remaining: ['pi'] }), 0);
    assert.equal(r.preferences?.get(THEME_PREFERENCE_KEY), 'pi');
  });

  it('lower-cases before anything else, as v1 does', async () => {
    const r = await rig();
    assert.equal(await r.run(setTheme, { parameters: { Name: 'PI' } }), 0);
    assert.equal(r.preferences?.get(THEME_PREFERENCE_KEY), 'pi');
  });

  it('resolves an alias and reports the RESOLVED name', async () => {
    // Divergence, declared: v1 echoes what was typed — `Theme set to dark` —
    // while storing `campbell`. What is stored is what happened.
    const r = await rig();
    assert.equal(await r.run(setTheme, { parameters: { Name: 'dark' } }), 0);
    assert.equal(r.preferences?.get(THEME_PREFERENCE_KEY), 'campbell');
    assert.deepEqual(r.values, ['Theme set to campbell']);
  });

  it('never touches the filesystem', async () => {
    // `ports.ts` puts a theme behind PreferencesPort "because a theme is not a
    // file a visitor should be able to `rm`". The manifest declares no
    // filesystem capability, so any such call would be denied outright; the
    // audit log is the evidence that none was made.
    const r = await rig();
    await r.run(setTheme, { parameters: { Name: 'blue' } });

    assert.deepEqual(
      r.audit.map((record) => record.capability),
      ['preferences.write'],
    );
    assert.equal(r.audit[0]?.decision, 'granted');
  });
});

describe('Set-Theme and a name it does not know', () => {
  it('is an ERROR, where v1 printed an informational line', async () => {
    // v1 returns a `muted` row and reports success, so `$?` was true for a
    // command that did nothing. Which lines are errors is a judgement per
    // command; "I was asked to set a theme and did not" is a failure.
    const r = await rig();
    const code = await r.run(setTheme, { parameters: { Name: 'nonsense' } });

    assert.equal(code, 1);
    const error = firstError(r.errors);
    assert.equal(error.fullyQualifiedErrorId, 'UnknownTheme,Set-Theme');
    assert.equal(error.category, 'InvalidArgument');
    assert.match(error.message, /'nonsense' is not a colour scheme/u);
    // v1's own sentence, kept, so both terminals answer the question the same way.
    assert.match(error.message, /Available themes: campbell · pi · blue {2}\(e\.g\. Set-Theme pi\)/u);
    assert.deepEqual(r.preferences?.writes, []);
  });

  it('reports a missing name separately, so a script can tell them apart', async () => {
    const r = await rig();
    const code = await r.run(setTheme);

    assert.equal(code, 1);
    assert.equal(firstError(r.errors).fullyQualifiedErrorId, 'ThemeNameRequired,Set-Theme');
    assert.deepEqual(r.preferences?.writes, []);
  });

  it('knows exactly the three schemes v1 shipped', () => {
    assert.deepEqual([...THEMES], ['campbell', 'pi', 'blue']);
  });

  it('falls through an EMPTY -Name to the positional, as v1\'s `||` does', async () => {
    const r = await rig();
    assert.equal(await r.run(setTheme, { parameters: { Name: '' }, remaining: ['blue'] }), 0);
    assert.equal(r.preferences?.get(THEME_PREFERENCE_KEY), 'blue');
  });
});

describe('Set-Theme without somewhere to write', () => {
  it('says so when the host provided no preferences store', async () => {
    const r = await rig({ preferences: null });
    const code = await r.run(setTheme, { parameters: { Name: 'pi' } });

    assert.equal(code, 1);
    const error = firstError(r.errors);
    assert.equal(error.fullyQualifiedErrorId, 'PreferencesUnavailable,Set-Theme');
    assert.equal(error.category, 'ResourceUnavailable');
  });

  it('reports a store that refuses, where v1 swallowed the exception', async () => {
    // v1: `try{ localStorage.setItem(…) }catch(e){}`. A preference that
    // silently did not persist is invisible to `$?` and to a script, which is
    // the coupling `storage/types.ts` objects to.
    const preferences = new StubPreferences();
    preferences.failure = new Error('QuotaExceededError');
    const r = await rig({ preferences });

    const code = await r.run(setTheme, { parameters: { Name: 'pi' } });

    assert.equal(code, 1);
    const error = firstError(r.errors);
    assert.equal(error.fullyQualifiedErrorId, 'PreferenceWriteFailed,Set-Theme');
    assert.match(error.message, /QuotaExceededError/u);
    assert.match(error.message, /Nothing was changed/u);
  });

  it('reports a preferences.write denial and stores nothing', async () => {
    const r = await rig({ granted: [] });
    const code = await r.run(setTheme, { parameters: { Name: 'pi' } });

    assert.equal(code, 1);
    assert.equal(firstError(r.errors).fullyQualifiedErrorId, 'CapabilityDenied,Set-Theme');
    assert.match(firstError(r.errors).message, /preferences\.write/u);
    assert.deepEqual(r.preferences?.writes, []);
  });
});

// ---------------------------------------------------------------------------
// Reset-FileSystem
// ---------------------------------------------------------------------------

/** A tiny disk image: a seeded home with one file that came with the page. */
const SEED: SeedSpec = {
  time: TEST_EPOCH_MS - 86_400_000,
  entries: [
    { path: '/home', kind: 'directory', owner: 'root', group: 'root', mode: 0o755 },
    { path: TEST_HOME, kind: 'directory', owner: 'thc1006', group: 'thc1006', mode: 0o750 },
    { path: `${TEST_HOME}/README.md`, kind: 'file', content: 'shipped with the page' },
  ],
};

/**
 * The same body, under a manifest that declares what the command actually needs.
 *
 * This is not a workaround: it is how the two halves are told apart. With the
 * capability granted the logic is shown to work; with the shipped manifest the
 * refusal is shown to be exact. Only `classification.data.mts` can close the
 * gap, and it is not this change's to edit.
 */
const RESET_WITH_READ: CommandModule = {
  manifest: {
    ...resetFileSystem.manifest,
    capabilities: ['filesystem.read', 'filesystem.delete', 'ui.dialog'],
  },
  invoke: (context, bound) => resetFileSystem.invoke(context, bound),
};

describe('Reset-FileSystem refuses to act unasked', () => {
  it('will not proceed when the host supplied no way to confirm', async () => {
    // v1 requires NOTHING — `fsReset()` runs on the bare command. Proceeding
    // because nobody was there to object is the one behaviour that cannot be
    // justified for something irreversible.
    const r = await rig({
      tree: { files: { [`${TEST_HOME}/mine.txt`]: 'mine' } },
      dialog: null,
    });

    const code = await r.run(RESET_WITH_READ);

    assert.equal(code, 1);
    const error = firstError(r.errors);
    assert.equal(error.fullyQualifiedErrorId, 'DialogUnavailable,Reset-FileSystem');
    assert.equal(error.category, 'ResourceUnavailable');
    assert.match(error.message, /confirm that everything you created here will be deleted/u);
    assert.equal(await r.read(`${TEST_HOME}/mine.txt`), 'mine');
  });

  it('does nothing, and does not fail, when the answer is no', async () => {
    // Declining is not an error. PowerShell's ShouldProcess says no the same
    // way: nothing happens, nothing is written, exit 0.
    const dialog = new StubDialog({ confirm: false });
    const r = await rig({ tree: { files: { [`${TEST_HOME}/mine.txt`]: 'mine' } }, dialog });

    const code = await r.run(RESET_WITH_READ);

    assert.equal(code, 0);
    assert.deepEqual(r.errors, []);
    assert.deepEqual(r.values, []);
    assert.equal(await r.read(`${TEST_HOME}/mine.txt`), 'mine');
    assert.equal(dialog.confirms.length, 1);
  });

  it('asks a question that says it cannot be undone', async () => {
    const dialog = new StubDialog({ confirm: false });
    const r = await rig({ dialog });
    await r.run(RESET_WITH_READ);

    const asked = dialog.confirms[0];
    assert.match(asked?.title ?? '', /Delete everything/u);
    assert.match(asked?.detail ?? '', /cannot be undone/u);
    assert.match(asked?.detail ?? '', /copied out of the terminal first/u);
  });

  it('reports a confirmation that failed, and removes nothing', async () => {
    const dialog = new StubDialog({ confirm: new Error('the dialog was dismissed by the host') });
    const r = await rig({ tree: { files: { [`${TEST_HOME}/mine.txt`]: 'mine' } }, dialog });

    const code = await r.run(RESET_WITH_READ);

    assert.equal(code, 1);
    assert.equal(firstError(r.errors).fullyQualifiedErrorId, 'ConfirmationFailed,Reset-FileSystem');
    assert.equal(await r.read(`${TEST_HOME}/mine.txt`), 'mine');
  });
});

describe('Reset-FileSystem, once it has been told yes', () => {
  it('takes what the visitor made and leaves what came with the page', async () => {
    const r = await rig({
      seed: SEED,
      tree: { files: { [`${TEST_HOME}/mine.txt`]: 'mine', [`${TEST_HOME}/dir/deep.txt`]: 'deep' } },
      dialog: new StubDialog({ confirm: true }),
    });

    const code = await r.run(RESET_WITH_READ);

    assert.equal(code, 0);
    assert.deepEqual(r.errors, []);
    assert.equal(await r.exists(`${TEST_HOME}/mine.txt`), false);
    assert.equal(await r.exists(`${TEST_HOME}/dir`), false);
    assert.equal(await r.read(`${TEST_HOME}/README.md`), 'shipped with the page');
    assert.deepEqual(r.values, ['File system restored to its initial state.']);
    assert.deepEqual(r.verbose, ['Removed 3 items.']);
  });

  it('returns the prompt to HOME, as v1 does', async () => {
    const r = await rig({
      seed: SEED,
      tree: { files: { [`${TEST_HOME}/dir/deep.txt`]: 'deep' } },
      cwd: `${TEST_HOME}/dir`,
      dialog: new StubDialog({ confirm: true }),
    });

    assert.equal(await r.run(RESET_WITH_READ), 0);
    assert.equal(r.vfs.location.path, TEST_HOME);
  });

  it('removes an EDITED seed file and warns that the original returns on reload', async () => {
    // This test asserted the opposite until the storage layer was corrected
    // under it, and the inversion is the point rather than an inconvenience.
    //
    // It was written against a MEASURED defect: overwriting a seed file left
    // `origin: 'seed'`, so the sweep could not see it and the visitor's edit
    // survived a reset. What that same flag also did was throw the edit away
    // on the next boot — `createSnapshot` records a seed node's metadata and
    // not its content — so the edit was unreachable by reset AND lost on
    // reload. Content writes now claim the node, which fixes both.
    //
    // So the file is the visitor's, the reset takes it, and the path is empty
    // until `bootStorage` reinstalls the image. That is the full truth and all
    // three parts are asserted: gone, said out loud, and reported as removed.
    const r = await rig({
      seed: SEED,
      dialog: new StubDialog({ confirm: true }),
    });
    assert.ok((await r.vfs.writeText(`${TEST_HOME}/README.md`, 'I changed this')).ok);
    assert.equal(
      (await r.vfs.stat(`${TEST_HOME}/README.md`) as { value: { origin: string } }).value.origin,
      'user',
      'editing a shipped file makes it the visitor’s — this is what the sweep acts on',
    );

    assert.equal(await r.run(RESET_WITH_READ), 0);

    assert.equal(await r.exists(`${TEST_HOME}/README.md`), false, 'removed, not kept');
    assert.deepEqual(r.verbose, ['Removed 1 item.']);
    assert.equal(r.warnings.length, 1);
    assert.match(r.warnings[0] ?? '', /rebuilt when the page loads/u);
    assert.match(r.warnings[0] ?? '', /original comes back\s+on the next reload/u);
  });

  it('stops on Ctrl+C and says what is still standing', async () => {
    const r = await rig({
      seed: SEED,
      tree: { files: { [`${TEST_HOME}/a.txt`]: 'a', [`${TEST_HOME}/b.txt`]: 'b' } },
      dialog: new StubDialog({ confirm: true }),
    });

    let seen = 0;
    r.vfs.onRemove = () => {
      seen += 1;
      if (seen === 1) r.abort.abort();
    };

    const code = await r.run(RESET_WITH_READ);

    assert.equal(code, 1);
    const error = firstError(r.errors);
    assert.equal(error.fullyQualifiedErrorId, 'ResetStopped,Reset-FileSystem');
    assert.equal(error.category, 'OperationStopped');
    assert.match(error.message, /stopped after removing 1 item/u);
    assert.match(error.message, /Run it again to finish/u);
    // Describable: one went, the other did not, and nothing claimed success.
    assert.equal(await r.exists(`${TEST_HOME}/b.txt`), true);
    assert.deepEqual(r.values, []);
  });
});

describe('Reset-FileSystem under the manifest it actually ships with', () => {
  it('cannot enumerate the tree, and says exactly why', async () => {
    // The shipped classification is `capabilities: ['filesystem.delete']`. The
    // sweep needs `filesystem.read`, which gate 1 refuses because the manifest
    // does not declare it. Nothing is removed, and the message names both the
    // capability and the file that has to change.
    const r = await rig({
      seed: SEED,
      tree: { files: { [`${TEST_HOME}/mine.txt`]: 'mine' } },
      dialog: new StubDialog({ confirm: true }),
    });

    const code = await r.run(resetFileSystem);

    assert.equal(code, 1);
    const error = firstError(r.errors);
    assert.equal(error.fullyQualifiedErrorId, 'CapabilityDenied,Reset-FileSystem');
    assert.equal(error.category, 'PermissionDenied');
    assert.match(error.message, /filesystem\.read/u);
    assert.match(error.message, /classification\.data\.mts/u);
    assert.equal(await r.read(`${TEST_HOME}/mine.txt`), 'mine');
  });

  it('declares filesystem.delete and nothing else, which is the defect', () => {
    // Pinned so that fixing the classification breaks this test and the note
    // above gets revisited, rather than the two silently disagreeing.
    assert.deepEqual([...resetFileSystem.manifest.capabilities], ['filesystem.delete']);
    assert.equal(resetFileSystem.manifest.risk, 'destructive');
  });

  it('says so when there is no filesystem at all', async () => {
    const r = await rig({ withFileSystem: false, dialog: new StubDialog({ confirm: true }) });
    const code = await r.run(resetFileSystem);

    assert.equal(code, 1);
    assert.equal(firstError(r.errors).fullyQualifiedErrorId, 'FileSystemUnavailable,Reset-FileSystem');
  });

  it('still asks the person even when the session grants nothing at all', async () => {
    // The command does NOT put `ui.dialog` through the broker, because gate 1
    // checks its own manifest and would refuse — leaving a destructive command
    // unable to confirm anything. Asking a person before destroying their work
    // is not a power a gate should be able to withhold, so the question is
    // asked and the deletion is what gets refused.
    const dialog = new StubDialog({ confirm: false });
    const r = await rig({ dialog, granted: [] });

    assert.equal(await r.run(resetFileSystem), 0);
    assert.equal(dialog.confirms.length, 1);
    assert.deepEqual(r.errors, []);
  });

  it('will start putting it through the broker the moment it is declared', () => {
    // The self-correcting half, tested where it lives: `declares` reads the
    // command's own manifest, so fixing the classification turns the gate on
    // with no further change here. (It cannot be shown end to end, because the
    // body reads the manifest `fsManageCommand` looked up, and a test can only
    // substitute the one the broker sees.)
    assert.equal(declares(resetFileSystem.manifest, 'ui.dialog'), false);
    assert.equal(declares(resetFileSystem.manifest, 'filesystem.read'), false);
    assert.equal(declares(resetFileSystem.manifest, 'filesystem.delete'), true);
    assert.equal(declares(RESET_WITH_READ.manifest, 'ui.dialog'), true);
  });
});
