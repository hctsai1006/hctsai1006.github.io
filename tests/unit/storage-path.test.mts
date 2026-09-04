/**
 * Tests for path resolution and the mount table.
 *
 * These are the adversarial cases, not the happy path. `/a/b` resolving to
 * `/a/b` proves nothing; what breaks a resolver is `..` at the root, a name
 * that is only separators, a NUL byte, a case difference, and a second drive.
 *
 * Two properties are checked against a reference rather than against examples,
 * because a resolver is exactly the kind of code where the twentieth hand-picked
 * case is the one nobody thought of:
 *
 *   IDEMPOTENCE    normalising twice equals normalising once
 *   ASSOCIATIVITY  resolve(resolve(base, a), b) equals resolve(base, join(a, b))
 *
 * The second one is what makes tab-completion, `Push-Location` and relative
 * globbing safe to build on: it says a path can be assembled in pieces without
 * the pieces changing the answer.
 */

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

import {
  FILESYSTEM_DRIVE,
  MountTable,
  MemoryStorage,
  NAME_MAX,
  PATH_MAX,
  VirtualFileSystem,
  basename,
  dirname,
  isDescendant,
  joinPath,
  normalizePath,
  normalizeTracked,
  resolvePath,
  splitSegments,
  validatePath,
} from '../../src/storage/index.ts';
import type { ResolveContext, ResolvedPath, Result } from '../../src/storage/index.ts';

const HOME = '/home/thc1006';

function at(path: string, drive = FILESYSTEM_DRIVE): ResolvedPath {
  return { drive, path, full: path, clampedAtRoot: false };
}

function context(cwd = HOME, drives: readonly string[] = [FILESYSTEM_DRIVE]): ResolveContext {
  return {
    cwd: at(cwd),
    home: HOME,
    drives: (name) => drives.find((d) => d.toLowerCase() === name.toLowerCase()) ?? null,
  };
}

function resolved(input: string, cwd = HOME, drives?: readonly string[]): ResolvedPath {
  const outcome = resolvePath(input, context(cwd, drives));
  assert.ok(outcome.ok, `expected ${input} to resolve, got ${JSON.stringify(outcome)}`);
  return outcome.value;
}

function failed(outcome: Result<unknown>): { code: string; reason?: string } {
  assert.ok(!outcome.ok, 'expected a failure');
  return outcome.error as unknown as { code: string; reason?: string };
}

// ---------------------------------------------------------------------------

describe('normalisation', () => {
  it('collapses repeated, trailing and dot separators', () => {
    assert.equal(normalizePath('/a//b///c/'), '/a/b/c');
    assert.equal(normalizePath('/a/./b/./'), '/a/b');
    assert.equal(normalizePath('/'), '/');
  });

  it('treats a path that is only separators as the root', () => {
    // The tempting bug is to return '' here, which then joins into a relative
    // path and silently reads the wrong directory.
    assert.equal(normalizePath('///'), '/');
    assert.equal(normalizePath('//'), '/');
    assert.deepEqual(splitSegments('///'), []);
  });

  it('clamps `..` at the root instead of escaping it', () => {
    assert.equal(normalizePath('/..'), '/');
    assert.equal(normalizePath('/../../../../etc/passwd'), '/etc/passwd');
    assert.equal(resolved('../../../../../../etc/passwd').path, '/etc/passwd');
    assert.equal(resolved('..', '/').path, '/');
  });

  it('reports the clamp, because Resolve-Path does', () => {
    // MEASURED in pwsh 7.6.5: `(Resolve-Path 'C:\..\..')` prints
    // "referred to an item that was outside the base 'C:'" AND returns 'C:\'.
    // Both halves, so the one command that reports it can.
    assert.equal(normalizeTracked(['..']).clampedAtRoot, true);
    assert.equal(normalizeTracked(['a', '..']).clampedAtRoot, false);
    assert.equal(resolved('/../..').clampedAtRoot, true);
    assert.equal(resolved('/etc/../etc').clampedAtRoot, false);
  });

  it('splits dirname and basename without losing the root', () => {
    assert.equal(dirname('/a/b'), '/a');
    assert.equal(dirname('/a'), '/');
    assert.equal(dirname('/'), '/');
    assert.equal(basename('/a/b'), 'b');
    assert.equal(basename('/'), '');
  });

  it('does not call a directory its own descendant', () => {
    assert.equal(isDescendant('/a/b', '/a'), true);
    assert.equal(isDescendant('/a', '/a'), false);
    assert.equal(isDescendant('/ab', '/a'), false);
    assert.equal(isDescendant('/a', '/'), true);
    assert.equal(isDescendant('/', '/'), false);
  });
});

describe('resolution', () => {
  it('refuses an empty path rather than silently meaning the cwd', () => {
    // v1 returns CWD here, which turns `cat ""` into `cat .`.
    assert.equal(failed(resolvePath('', context())).code, 'EINVAL');
    assert.equal(failed(resolvePath('', context())).reason, 'empty-path');
  });

  it('expands ~ to the home directory, on the filesystem drive', () => {
    assert.equal(resolved('~').path, HOME);
    assert.equal(resolved('~/projects').path, `${HOME}/projects`);
    assert.equal(resolved('~', '/etc').drive, FILESYSTEM_DRIVE);
  });

  it('treats ~ inside a name as an ordinary character', () => {
    assert.equal(resolved('a~b').path, `${HOME}/a~b`);
    assert.equal(resolved('./~').path, `${HOME}/~`);
  });

  it('does not strip quotes; a quoted name is a name', () => {
    // PR-10 task 10.4: paths arrive already lexed. v1's resolvePath does
    // `p.replace(/^["']|["']$/g,'')`, which makes a file whose name really
    // starts with a quote unaddressable.
    assert.equal(resolved('"notes.txt"').path, `${HOME}/"notes.txt"`);
    assert.equal(resolved("'a b'").path, `${HOME}/'a b'`);
  });

  it('is case-sensitive for paths and case-insensitive for drive names', () => {
    // Both rules in one test, because they are opposite and both are correct:
    // Linux filenames are case-sensitive, PowerShell drive names are not.
    assert.notEqual(resolved('README.md').path, resolved('readme.md').path);
    assert.equal(resolved('Env:/PATH', HOME, ['/', 'Env']).drive, 'Env');
    assert.equal(resolved('env:/PATH', HOME, ['/', 'Env']).drive, 'Env');
    assert.equal(resolved('ENV:/PATH', HOME, ['/', 'Env']).drive, 'Env');
  });

  it('accepts / and \\ inside a drive-qualified path, and neither is stripped', () => {
    // MEASURED in pwsh 7.6.5: Env:/PATH, Env:\PATH and Env:PATH all work.
    const drives = ['/', 'Env'];
    assert.equal(resolved('Env:/PATH', HOME, drives).path, '/PATH');
    assert.equal(resolved('Env:\\PATH', HOME, drives).path, '/PATH');
    assert.equal(resolved('Env:PATH', HOME, drives).path, '/PATH');
  });

  it('renders a provider drive with backslashes, as PowerShell does', () => {
    // MEASURED: `Set-Location Env:` then `Get-Location` gives `Env:\`.
    assert.equal(resolved('Env:/PATH', HOME, ['/', 'Env']).full, 'Env:\\PATH');
    assert.equal(resolved('/etc/hosts').full, '/etc/hosts');
  });

  it('treats a backslash on the filesystem drive as an ordinary character', () => {
    // On Linux `\` is legal in a filename. Splitting on it would make one file
    // into two directories, which is the kind of wrong that only shows up when
    // somebody finally creates such a file.
    const target = resolved('a\\b');
    assert.equal(target.path, `${HOME}/a\\b`);
    assert.equal(splitSegments(target.path).length, 3);
  });

  it('rejects an unknown drive by name', () => {
    // MEASURED: pwsh reports DriveNotFound / ObjectNotFound for `Nope:/x`.
    const failure = failed(resolvePath('Nope:/x', context()));
    assert.equal(failure.code, 'EINVAL');
    assert.equal(failure.reason, 'unknown-drive');
  });

  it('rejects a NUL byte and accepts a newline', () => {
    // POSIX forbids exactly two characters in a filename: NUL and '/'. A
    // newline is legal, and rejecting it would invent a rule Linux does not
    // have — `touch $'a\nb'` really does make one file.
    const withNul = failed(resolvePath('a\u0000b', context()));
    assert.equal(withNul.code, 'EINVAL');
    assert.equal(withNul.reason, 'nul-in-name');
    assert.equal(resolved('a\nb').path, `${HOME}/a\nb`);
    assert.equal(resolved('a\tb').path, `${HOME}/a\tb`);
  });

  it('enforces NAME_MAX per component and PATH_MAX for the whole path', () => {
    const longName = 'x'.repeat(NAME_MAX + 1);
    const nameFailure = failed(validatePath(`/${longName}`, 'resolve'));
    assert.equal(nameFailure.code, 'ENAMETOOLONG');

    assert.ok(validatePath(`/${'x'.repeat(NAME_MAX)}`, 'resolve').ok);

    const deep = `/${Array.from({ length: 900 }, () => 'abcd').join('/')}`;
    assert.ok(deep.length > PATH_MAX);
    assert.equal(failed(validatePath(deep, 'resolve')).code, 'ENAMETOOLONG');
  });

  it('resolves very deep nesting that stays inside the limits', () => {
    const depth = 500;
    const path = `/${Array.from({ length: depth }, (_, i) => `d${String(i)}`).join('/')}`;
    assert.ok(path.length < PATH_MAX);
    assert.equal(splitSegments(resolved(path).path).length, depth);
  });
});

// ---------------------------------------------------------------------------
// properties
// ---------------------------------------------------------------------------

/**
 * A seeded LCG. Not for cryptography — for a failing case that reproduces.
 * A property test with `Math.random()` reports a bug you cannot then rerun.
 */
function lcg(seed: number): () => number {
  let state = seed >>> 0;
  return () => {
    state = (Math.imul(state, 1664525) + 1013904223) >>> 0;
    return state / 0x100000000;
  };
}

const TOKENS = ['a', 'b', 'c', '.', '..', '', 'x y', 'README.md', '~ish', 'a\\b'] as const;

function randomPath(random: () => number, rooted: boolean): string {
  const count = 1 + Math.floor(random() * 6);
  const parts: string[] = [];
  for (let i = 0; i < count; i += 1) {
    parts.push(TOKENS[Math.floor(random() * TOKENS.length)] ?? 'a');
  }
  const body = parts.join('/');
  // Never the empty string: that is EINVAL by design and is tested on its own.
  if (!rooted && body === '') return '.';
  return rooted ? `/${body}` : body;
}

describe('path properties', () => {
  it('normalising twice equals normalising once', () => {
    const random = lcg(0x5eed);
    for (let i = 0; i < 3000; i += 1) {
      const path = randomPath(random, random() < 0.5);
      const once = normalizePath(path);
      const twice = normalizePath(once);
      assert.equal(twice, once, `not idempotent for ${JSON.stringify(path)}`);
    }
  });

  it('a normalised path has no empty, dot or dot-dot segment', () => {
    const random = lcg(0xc0ffee);
    for (let i = 0; i < 3000; i += 1) {
      const normalised = normalizePath(randomPath(random, random() < 0.5));
      assert.ok(normalised.startsWith('/'), normalised);
      for (const segment of normalised.split('/').slice(1)) {
        if (normalised === '/') continue;
        assert.notEqual(segment, '');
        assert.notEqual(segment, '.');
        assert.notEqual(segment, '..');
      }
    }
  });

  it('resolving in two steps equals joining then resolving', () => {
    const random = lcg(0xd15ea5e);
    const bases = ['/', '/a', '/a/b', HOME];
    for (let i = 0; i < 3000; i += 1) {
      const base = bases[Math.floor(random() * bases.length)] ?? '/';
      const a = randomPath(random, random() < 0.3);
      const b = randomPath(random, random() < 0.3);

      const first = resolvePath(a, context(base));
      assert.ok(first.ok);
      const staged = resolvePath(b, context(first.value.path));
      assert.ok(staged.ok);

      const combined = resolvePath(joinPath(a, b), context(base));
      assert.ok(combined.ok);

      assert.equal(
        staged.value.path,
        combined.value.path,
        `not associative for base=${base} a=${JSON.stringify(a)} b=${JSON.stringify(b)}`,
      );
    }
  });

  it('a resolved path never leaves the mount root', () => {
    const random = lcg(0xbadc0de);
    for (let i = 0; i < 3000; i += 1) {
      const outcome = resolvePath(randomPath(random, random() < 0.5), context('/a/b'));
      assert.ok(outcome.ok);
      assert.ok(outcome.value.path.startsWith('/'), outcome.value.path);
      assert.ok(!outcome.value.path.includes('/../'), outcome.value.path);
      assert.ok(!outcome.value.path.endsWith('/..'), outcome.value.path);
    }
  });
});

// ---------------------------------------------------------------------------
// the mount table
// ---------------------------------------------------------------------------

describe('the mount table', () => {
  const clock = (): number => 1_700_000_000_000;

  function table(): MountTable {
    return new MountTable(new MemoryStorage({ clock }));
  }

  it('starts with the filesystem drive and nothing else', () => {
    assert.deepEqual(table().drives, [FILESYSTEM_DRIVE]);
  });

  it('looks drive names up case-insensitively but keeps the canonical spelling', () => {
    const mounts = table();
    mounts.mount('Env', new MemoryStorage({ clock }));
    assert.equal(mounts.resolveDriveName('env'), 'Env');
    assert.equal(mounts.resolveDriveName('ENV'), 'Env');
    assert.notEqual(mounts.backend('eNv'), null);
    assert.equal(mounts.resolveDriveName('Variable'), null);
  });

  it('refuses to unmount the filesystem drive', () => {
    assert.throws(() => table().unmount(FILESYSTEM_DRIVE), /cannot be unmounted/);
  });

  it('unmounts a provider drive and forgets its alias', () => {
    const mounts = table();
    mounts.mount('Env', new MemoryStorage({ clock }));
    assert.equal(mounts.unmount('env'), true);
    assert.equal(mounts.resolveDriveName('Env'), null);
    assert.equal(mounts.unmount('Env'), false);
  });

  it('routes a drive-qualified path to the second mount, not the first', async () => {
    const filesystem = new MemoryStorage({ clock, name: 'fs' });
    const second = new MemoryStorage({ clock, name: 'second' });
    const mounts = new MountTable(filesystem);
    mounts.mount('Scratch', second);
    const vfs = new VirtualFileSystem(mounts, { home: HOME, cwd: '/' });

    const written = await vfs.writeText('Scratch:/note.txt', 'hello', { createParents: true });
    assert.ok(written.ok);

    // On the second mount, and NOT on the first. Checking only the first half
    // would pass even if both mounts were the same object.
    assert.equal(await second.exists('/note.txt'), true);
    assert.equal(await filesystem.exists('/note.txt'), false);

    const read = await vfs.readText('Scratch:/note.txt');
    assert.ok(read.ok);
    assert.equal(read.value, 'hello');
  });

  it('reports a backend error against the drive-qualified path', async () => {
    const mounts = new MountTable(new MemoryStorage({ clock }));
    mounts.mount('Scratch', new MemoryStorage({ clock }));
    const vfs = new VirtualFileSystem(mounts, { home: HOME, cwd: '/' });

    const missing = await vfs.stat('Scratch:/nope');
    assert.ok(!missing.ok);
    // Without the relabel the user is told to look for a file called '/nope'.
    assert.equal(missing.error.path, 'Scratch:\\nope');
  });
});
