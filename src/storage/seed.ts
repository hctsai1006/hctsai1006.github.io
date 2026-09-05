/**
 * seed.ts — the disk image, as data.
 *
 * Every structural fact here was read off `legacy/terminal-v1.html`'s
 * `buildSeed()` rather than invented, because the emulation is only worth
 * anything if `cat /etc/os-release` prints what an actual Ubuntu 24.04 box
 * prints. The parts that are portfolio CONTENT are parameters, not constants:
 * they are generated from `src/data/*.json` by the layer that owns that data,
 * and hard-coding them here would give the repo a second copy to keep in sync —
 * which is the failure mode `tools/check-numbers.mts` exists to catch.
 *
 * What is preserved verbatim from v1, with the reasoning v1 recorded:
 *
 *   HOME is `/home/thc1006`, mode 0o750 — `adduser`'s `HOME_MODE` default on
 *   Ubuntu 24.04, which is 750 and not 755.
 *
 *   `/root` is 0o700 and root-owned, `/tmp` is 0o1777 (sticky, world-writable).
 *   Everything under `/` belongs to root. v1 arrived at this after noticing
 *   that a depth-based ownership heuristic got `rm -rf ~` wrong: on a real
 *   machine that fails because `/home` is root-owned and not writable, not
 *   because of anything about the home directory itself.
 *
 *   `/bin` and `/usr/bin` both hold the same executables. Ubuntu's usr-merge
 *   makes `/bin` a symlink to `usr/bin`; v1 models it as two real directories
 *   with the same contents and says so, because modelling the symlink would
 *   mean modelling symlinks. `/etc/shells` names `/bin/sh` and `/usr/bin/pwsh`,
 *   so both paths have to resolve or `cat /etc/shells` describes a machine the
 *   emulator is not.
 *
 *   `SEED_TIME` is a fixed constant in the past. Fixed, so the snapshot can
 *   store only the mtimes that deviate from it; in the past, so a seed file
 *   never looks newer than something the user just created.
 */

import { DEFAULT_DIRECTORY_MODE, DEFAULT_FILE_MODE } from './types.ts';
import type { SeedEntry, SeedSpec } from './types.ts';

export const USERNAME = 'thc1006';
export const GROUPNAME = 'thc1006';
export const HOSTNAME = 'thc1006-dev';
export const HOME = `/home/${USERNAME}`;

/** v1's `SEEDTIME`, to the millisecond. */
export const SEED_TIME = Date.parse('2026-07-19T12:00:00Z');

/** `adduser`'s HOME_MODE on Ubuntu 24.04 is 750, not 755. */
export const HOME_MODE = 0o750;
export const ROOT_HOME_MODE = 0o700;
/** Sticky plus world-writable: `drwxrwxrwt`. */
export const TMP_MODE = 0o1777;
export const EXECUTABLE_MODE = 0o755;

/** v1's FHS top level. `cd /` showing only `etc` and `home` breaks the illusion. */
export const FHS_DIRECTORIES = [
  '/bin',
  '/boot',
  '/dev',
  '/etc',
  '/home',
  '/lib',
  '/media',
  '/mnt',
  '/opt',
  '/proc',
  '/root',
  '/run',
  '/sbin',
  '/srv',
  '/sys',
  '/tmp',
  '/usr',
  '/var',
] as const;

/** The shells v1 lists beyond the emulator's own command inventory. */
export const BASE_BINARIES = ['bash', 'dash', 'pwsh', 'rbash', 'sh'] as const;

const OS_RELEASE = `PRETTY_NAME="Ubuntu 24.04.4 LTS"
NAME="Ubuntu"
VERSION_ID="24.04"
VERSION="24.04.4 LTS (Noble Numbat)"
ID=ubuntu
ID_LIKE=debian
HOME_URL="https://www.ubuntu.com/"
`;

const SHELLS = `# /etc/shells: valid login shells
/bin/sh
/usr/bin/sh
/bin/bash
/usr/bin/bash
/bin/rbash
/usr/bin/rbash
/usr/bin/dash
/usr/bin/pwsh
`;

/** Static in v1 too — it is a profile, not portfolio data. */
const PROFILE_PS1 = `# ~/.config/powershell/Microsoft.PowerShell_profile.ps1
Set-PSReadLineOption -PredictionSource HistoryAndPlugin
Set-PSReadLineOption -EditMode Emacs
Set-Alias k kubectl
Set-Alias g git

# On Linux the ls/cat/rm aliases are gone; the native commands run instead.
Set-Alias ll "/bin/ls -l"

# Check every morning whether anything was merged.
function Get-MergedPRs { gh search prs --author thc1006 --merged }

Write-Host "Welcome back, thc1006." -ForegroundColor Cyan
`;

/** A file whose content comes from portfolio data. */
export interface SeedDocument {
  /** Relative to HOME, e.g. `contributions/kubernetes.md`. */
  readonly path: string;
  readonly content: string;
}

export interface SeedOptions {
  /**
   * Executables in `/bin` and `/usr/bin`.
   *
   * Passed in rather than derived here: the real list is the command inventory
   * filtered to `runtime: 'native'`, and importing that would make the storage
   * layer depend on the command layer it exists to unblock.
   */
  readonly binaries?: readonly string[];
  /** `~/README.md`. Portfolio data; a placeholder when not supplied. */
  readonly readme?: string;
  /** Everything else under HOME — contributions, publications, awards, projects. */
  readonly documents?: readonly SeedDocument[];
  readonly time?: number;
}

/**
 * Build the image.
 *
 * Order is load-bearing: a directory has to be declared before anything inside
 * it, or `installImage` creates it implicitly with the default mode and the
 * later declaration has to correct it. Declaring them explicitly and in order
 * means the mode a directory gets is the mode it was given, once.
 */
export function buildSeed(options: SeedOptions = {}): SeedSpec {
  const time = options.time ?? SEED_TIME;
  const binaries = [...new Set([...(options.binaries ?? []), ...BASE_BINARIES])].sort();
  const entries: SeedEntry[] = [];

  const directory = (path: string, mode: number, owner: string): void => {
    entries.push({ path, kind: 'directory', mode, owner, group: owner });
  };
  const file = (path: string, content: string, mode: number, owner: string): void => {
    entries.push({ path, kind: 'file', content, mode, owner, group: owner });
  };

  // `/` first, and root-owned. This is what makes `rm -rf ~` fail the way it
  // fails on a real Ubuntu box: not because of anything about the home
  // directory, but because its parent `/home` belongs to root and is not
  // writable by the visitor. v1 reaches the same state with `markOwn(ROOT,'root')`.
  directory('/', DEFAULT_DIRECTORY_MODE, 'root');
  for (const path of FHS_DIRECTORIES) directory(path, DEFAULT_DIRECTORY_MODE, 'root');
  // The two that differ from 0o755 on a real Ubuntu box.
  directory('/root', ROOT_HOME_MODE, 'root');
  directory('/tmp', TMP_MODE, 'root');

  file('/etc/os-release', OS_RELEASE, DEFAULT_FILE_MODE, 'root');
  file('/etc/hostname', `${HOSTNAME}\n`, DEFAULT_FILE_MODE, 'root');
  file('/etc/shells', SHELLS, DEFAULT_FILE_MODE, 'root');

  for (const directoryPath of ['/usr/bin', '/bin']) {
    directory(directoryPath, DEFAULT_DIRECTORY_MODE, 'root');
    for (const binary of binaries) {
      file(`${directoryPath}/${binary}`, '', EXECUTABLE_MODE, 'root');
    }
  }

  directory(HOME, HOME_MODE, USERNAME);
  for (const name of ['contributions', 'publications', 'awards', 'projects']) {
    directory(`${HOME}/${name}`, DEFAULT_DIRECTORY_MODE, USERNAME);
  }

  file(
    `${HOME}/README.md`,
    options.readme ?? `# ${USERNAME}\n\nRun Get-Contribution, Get-Publication or Get-Award.\n`,
    DEFAULT_FILE_MODE,
    USERNAME,
  );
  file(`${HOME}/profile.ps1`, PROFILE_PS1, DEFAULT_FILE_MODE, USERNAME);

  for (const document of options.documents ?? []) {
    file(`${HOME}/${document.path}`, document.content, DEFAULT_FILE_MODE, USERNAME);
  }

  return { time, entries };
}
