/**
 * nano, vi and vim — the three commands that need a person.
 *
 * The behaviour that has to be right, and is easy to get wrong: `editText`
 * resolving to NULL is the visitor quitting without saving, and that is a
 * NORMAL outcome. Nothing written, nothing on stream 2, exit 0. Every other
 * shape of the interaction is tested beside it — a save, a host that throws,
 * and a host that is not there at all — because a stub that only ever returns
 * text proves nothing about the two paths people actually take.
 */

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

import { nano, vi, vim } from '../../src/commands/fs-manage/index.ts';
import { StubDialog, TEST_HOME, firstError, rig } from './fs-manage-harness.mts';

describe('an editor saves what came back', () => {
  it('reads the file, hands it over, and writes the result', async () => {
    const dialog = new StubDialog({ edit: 'edited\ntext' });
    const r = await rig({ tree: { files: { [`${TEST_HOME}/notes.txt`]: 'original' } }, dialog });

    const code = await r.run(nano, { remaining: ['notes.txt'] });

    assert.equal(code, 0);
    assert.deepEqual(r.errors, []);
    assert.equal(await r.read(`${TEST_HOME}/notes.txt`), 'edited\ntext');
    assert.deepEqual(dialog.edits, [
      // The RESOLVED path: a host cannot reconstruct one from '../notes.txt'.
      { path: `${TEST_HOME}/notes.txt`, contents: 'original', editor: 'nano' },
    ]);
  });

  it('says nothing on stream 1 — the status line is a diagnostic', async () => {
    // v1 shows `[ Wrote 2 lines ]` in nano's own status bar, which is the
    // host's surface here. On stream 1 it would be an object in the pipeline.
    const r = await rig({
      tree: { files: { [`${TEST_HOME}/notes.txt`]: 'x' } },
      dialog: new StubDialog({ edit: 'one\ntwo' }),
    });
    await r.run(nano, { remaining: ['notes.txt'] });

    assert.deepEqual(r.values, []);
    assert.deepEqual(r.verbose, ['[ Wrote 2 lines ]']);
  });

  it('reports vim\'s status line in vim\'s words, with the real byte count', async () => {
    // v1's `edBytes()` sums UTF-16 code units plus one per line; this is
    // `WriteReceipt.size`, the UTF-8 length of what was stored. For anything
    // outside ASCII v1's number was not a byte count.
    const r = await rig({
      tree: { files: { [`${TEST_HOME}/f.txt`]: 'x' } },
      dialog: new StubDialog({ edit: '蔡\nb' }),
    });
    await r.run(vim, { remaining: ['f.txt'] });

    // '蔡' is three UTF-8 bytes, '\n' one, 'b' one.
    assert.deepEqual(r.verbose, ['"f.txt" 2L, 5B written']);
  });
});

describe('the cancel path', () => {
  it('is not an error: quitting without saving changes nothing', async () => {
    const dialog = new StubDialog({ edit: null });
    const r = await rig({ tree: { files: { [`${TEST_HOME}/notes.txt`]: 'original' } }, dialog });

    const code = await r.run(nano, { remaining: ['notes.txt'] });

    assert.equal(code, 0);
    assert.deepEqual(r.errors, []);
    assert.deepEqual(r.values, []);
    assert.deepEqual(r.verbose, []);
    assert.equal(await r.read(`${TEST_HOME}/notes.txt`), 'original');
    assert.equal(dialog.edits.length, 1);
  });

  it('creates nothing when a NEW file is opened and then abandoned', async () => {
    const r = await rig({ dialog: new StubDialog({ edit: null }) });
    const code = await r.run(vim, { remaining: ['fresh.txt'] });

    assert.equal(code, 0);
    assert.deepEqual(r.errors, []);
    assert.equal(await r.exists(`${TEST_HOME}/fresh.txt`), false);
  });
});

describe('a host that fails', () => {
  it('reports the editor failure and writes nothing', async () => {
    const dialog = new StubDialog({ edit: new Error('the editor pane was destroyed') });
    const r = await rig({ tree: { files: { [`${TEST_HOME}/notes.txt`]: 'original' } }, dialog });

    const code = await r.run(nano, { remaining: ['notes.txt'] });

    assert.equal(code, 1);
    const error = firstError(r.errors);
    assert.equal(error.fullyQualifiedErrorId, 'EditorHostFailed,nano');
    assert.match(error.message, /the editor pane was destroyed/u);
    assert.match(error.message, /Nothing was written/u);
    assert.equal(await r.read(`${TEST_HOME}/notes.txt`), 'original');
  });

  it('says so when there is no dialog at all — the headless case', async () => {
    // `invocation.ts`: null in a headless run is normal, "so a command that
    // needs it has to say so rather than crash".
    const r = await rig({ tree: { files: { [`${TEST_HOME}/notes.txt`]: 'original' } }, dialog: null });

    const code = await r.run(vi, { remaining: ['notes.txt'] });

    assert.equal(code, 1);
    const error = firstError(r.errors);
    assert.equal(error.fullyQualifiedErrorId, 'DialogUnavailable,vi');
    assert.equal(error.category, 'ResourceUnavailable');
    assert.match(error.message, /cannot open an editor/u);
    assert.equal(await r.read(`${TEST_HOME}/notes.txt`), 'original');
  });

  it('says so when there is no filesystem', async () => {
    const r = await rig({ dialog: new StubDialog({ edit: 'x' }), withFileSystem: false });
    const code = await r.run(nano, { remaining: ['notes.txt'] });

    assert.equal(code, 1);
    assert.equal(firstError(r.errors).fullyQualifiedErrorId, 'FileSystemUnavailable,nano');
  });

  it('reports a ui.dialog denial without opening anything', async () => {
    const dialog = new StubDialog({ edit: 'x' });
    const r = await rig({
      tree: { files: { [`${TEST_HOME}/notes.txt`]: 'original' } },
      dialog,
      granted: ['filesystem.read', 'filesystem.write'],
    });

    const code = await r.run(nano, { remaining: ['notes.txt'] });

    assert.equal(code, 1);
    assert.equal(firstError(r.errors).fullyQualifiedErrorId, 'CapabilityDenied,nano');
    assert.match(firstError(r.errors).message, /ui\.dialog/u);
    assert.equal(dialog.edits.length, 0);
    assert.equal(await r.read(`${TEST_HOME}/notes.txt`), 'original');
  });
});

describe('opening something that is not there', () => {
  it('gives an EMPTY buffer for a missing file, as real nano does', async () => {
    const dialog = new StubDialog({ edit: 'brand new' });
    const r = await rig({ dialog });

    const code = await r.run(nano, { remaining: ['fresh.txt'] });

    assert.equal(code, 0);
    assert.equal(dialog.edits[0]?.contents, '');
    assert.equal(await r.read(`${TEST_HOME}/fresh.txt`), 'brand new');
  });

  it('refuses when the PARENT is missing, which is v1\'s check', async () => {
    const dialog = new StubDialog({ edit: 'x' });
    const r = await rig({ dialog });

    const code = await r.run(nano, { remaining: ['nowhere/fresh.txt'] });

    assert.equal(code, 1);
    assert.equal(
      firstError(r.errors).message,
      'nano: nowhere/fresh.txt: No such file or directory',
    );
    assert.equal(dialog.edits.length, 0);
  });

  it('reports a directory in each editor\'s own words', async () => {
    const forNano = await rig({
      tree: { directories: [`${TEST_HOME}/docs`] },
      dialog: new StubDialog({ edit: 'x' }),
    });
    assert.equal(await forNano.run(nano, { remaining: ['docs'] }), 1);
    assert.equal(firstError(forNano.errors).message, 'Error reading docs: Is a directory');

    const forVim = await rig({
      tree: { directories: [`${TEST_HOME}/docs`] },
      dialog: new StubDialog({ edit: 'x' }),
    });
    assert.equal(await forVim.run(vim, { remaining: ['docs'] }), 1);
    assert.equal(firstError(forVim.errors).message, '"docs" is a directory');
  });
});

describe('vi and vim are one editor with two names', () => {
  it('reports vim\'s name from vi, which is what v1 does', async () => {
    // v1: `'vi': run: edStart('vim', …)`. The message prefix is the FLAVOUR,
    // and there is only one flavour behind both names.
    const r = await rig({ dialog: new StubDialog({ edit: 'x' }) });
    assert.equal(await r.run(vi, { remaining: ['nowhere/f.txt'] }), 1);
    assert.equal(firstError(r.errors).message, 'vim: nowhere/f.txt: No such file or directory');
  });

  it('still tells the host WHICH name was typed', async () => {
    // `ports.ts`: "Which editor was typed, so the host can match its chrome and
    // key map." The message prefix and the request are answering two different
    // questions and do not have to agree.
    const dialog = new StubDialog({ edit: null });
    const r = await rig({ tree: { files: { [`${TEST_HOME}/f.txt`]: 'x' } }, dialog });
    await r.run(vi, { remaining: ['f.txt'] });

    assert.equal(dialog.edits[0]?.editor, 'vi');
  });
});

describe('a buffer with no name', () => {
  it('opens, because v1 opens one', async () => {
    const dialog = new StubDialog({ edit: null });
    const r = await rig({ dialog });

    assert.equal(await r.run(nano), 0);
    assert.deepEqual(dialog.edits, [{ path: '', contents: '', editor: 'nano' }]);
  });

  it('reports E32 rather than silently dropping what was typed into it', async () => {
    // `DialogPort` has no way to ask for a filename, so v1's `^O` and `:w foo`
    // cannot be reproduced. Losing the text quietly is the one outcome that
    // would cost someone work, so it is reported instead.
    const r = await rig({ dialog: new StubDialog({ edit: 'some work' }) });
    const code = await r.run(vim);

    assert.equal(code, 1);
    const error = firstError(r.errors);
    assert.equal(error.fullyQualifiedErrorId, 'NoFileName,vim');
    assert.match(error.message, /^E32: No file name/u);
  });
});

describe('a write that the filesystem refuses', () => {
  it('names the reason for nano and collapses it for vim, as both really do', async () => {
    const forNano = await rig({
      tree: { files: { [`${TEST_HOME}/ro.txt`]: 'original' } },
      dialog: new StubDialog({ edit: 'changed' }),
    });
    assert.ok((await forNano.vfs.chmod(`${TEST_HOME}/ro.txt`, 0o444)).ok);
    assert.equal(await forNano.run(nano, { remaining: ['ro.txt'] }), 1);
    assert.equal(
      firstError(forNano.errors).message,
      'Error writing ro.txt: Permission denied',
    );
    assert.equal(firstError(forNano.errors).category, 'PermissionDenied');
    assert.equal(await forNano.read(`${TEST_HOME}/ro.txt`), 'original');

    const forVim = await rig({
      tree: { files: { [`${TEST_HOME}/ro.txt`]: 'original' } },
      dialog: new StubDialog({ edit: 'changed' }),
    });
    assert.ok((await forVim.vfs.chmod(`${TEST_HOME}/ro.txt`, 0o444)).ok);
    assert.equal(await forVim.run(vim, { remaining: ['ro.txt'] }), 1);
    assert.equal(firstError(forVim.errors).message, "E212: Can't open file for writing");
  });
});
