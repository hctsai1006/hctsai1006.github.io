/**
 * index.ts — the public surface, and the boot sequence.
 *
 * A command imports from here and from nowhere else in `src/storage/`. That is
 * the whole point of the PR: the 28 browser-backed commands are written against
 * `VirtualFileSystem` and `StorageError`, and the day an OPFS backend replaces
 * `MemoryStorage` in `bootStorage` below, not one of them changes.
 *
 * What is deliberately NOT exported: `MutationStep`, `MutationPlan` and
 * `MutationJournal` are exported as TYPES because the OPFS backend has to
 * implement them, but nothing in the command layer should ever construct one.
 * If a command ever needs to, the layering is wrong.
 */

export type {
  CopyOptions,
  DirectoryEntry,
  Err,
  FileStat,
  MkdirOptions,
  MutationJournal,
  MutationPlan,
  MutationStep,
  NodeOrigin,
  Ok,
  Permission,
  QuotaUsage,
  RemoveOptions,
  RenameOptions,
  Result,
  SeedEntry,
  SeedSpec,
  StatKind,
  StorageBackend,
  StorageError,
  StorageErrorCode,
  StorageSyscall,
  Times,
  WriteOptions,
  WriteReceipt,
} from './types.ts';

export {
  DEFAULT_DIRECTORY_MODE,
  DEFAULT_FILE_MODE,
  DIRECTORY_SIZE,
  NAME_MAX,
  PATH_MAX,
  STORAGE_ERROR_CODES,
  StorageFailure,
  err,
  formatMode,
  hasCode,
  isErr,
  isOk,
  ok,
  parseMode,
  unwrap,
} from './types.ts';

export { MemoryStorage, NullJournal } from './memory.ts';
export type { MemoryStorageOptions } from './memory.ts';

export {
  FILESYSTEM_DRIVE,
  MountTable,
  SEED_OVERLAY_NOTE,
  SEPARATOR,
  VirtualFileSystem,
  basename,
  dirname,
  formatResolved,
  isDescendant,
  joinPath,
  normalizePath,
  normalizeSegments,
  normalizeTracked,
  resolvePath,
  splitSegments,
  validatePath,
} from './vfs.ts';
export type { ResolveContext, ResolvedPath, VirtualFileSystemOptions } from './vfs.ts';

export {
  SNAPSHOT_FORMAT,
  SNAPSHOT_VERSION,
  createSnapshot,
  decodeSnapshot,
  encodeSnapshot,
  exportSnapshot,
  fnv1a32,
  fromBase64,
  importSnapshot,
  restoreSnapshot,
  toBase64,
} from './snapshot.ts';
export type {
  RestoreOptions,
  RestoreReport,
  SnapshotDocument,
  SnapshotEntry,
  SnapshotOptions,
  SnapshotScope,
} from './snapshot.ts';

export {
  BASE_BINARIES,
  EXECUTABLE_MODE,
  FHS_DIRECTORIES,
  GROUPNAME,
  HOME,
  HOME_MODE,
  HOSTNAME,
  ROOT_HOME_MODE,
  SEED_TIME,
  TMP_MODE,
  USERNAME,
  buildSeed,
} from './seed.ts';
export type { SeedDocument, SeedOptions } from './seed.ts';

import { MemoryStorage } from './memory.ts';
import { importSnapshot } from './snapshot.ts';
import type { RestoreReport } from './snapshot.ts';
import { HOME, USERNAME, buildSeed } from './seed.ts';
import { ok } from './types.ts';
import type { Result, SeedSpec, StorageBackend } from './types.ts';
import { MountTable, VirtualFileSystem } from './vfs.ts';

export interface BootOptions {
  readonly clock: () => number;
  /** The image to install. `buildSeed()` when not supplied. */
  readonly seed?: SeedSpec;
  /** A previously persisted overlay. Restored on top of the seed. */
  readonly overlay?: Uint8Array;
  /** Swap in a different backend — this is where OPFS lands. */
  readonly backend?: StorageBackend;
  readonly capacity?: number | null;
  readonly user?: string;
  readonly cwd?: string;
}

export interface BootReport {
  readonly vfs: VirtualFileSystem;
  readonly backend: StorageBackend;
  readonly seed: SeedSpec;
  /** Null when there was no overlay to restore. */
  readonly restore: RestoreReport | null;
}

/**
 * The boot sequence, in the order v1 established and for its reasons.
 *
 *   1. RESET. Whatever is there is not authoritative.
 *   2. INSTALL THE SEED, privileged. This is the disk image, rebuilt from
 *      scratch every time so a portfolio update reaches a returning visitor.
 *   3. GRAFT THE OVERLAY, as the user. Their files come back on top.
 *
 * v1's `fsInit()` is `buildSeed(); fsLoad(); if(!fsGet(HOME)) buildSeed();` —
 * the third clause is a repair for an overlay that damaged the tree. It is not
 * needed here: the graft runs through the ordinary write API as the user, so it
 * cannot delete a seed node, and `decodeSnapshot` refuses a malformed document
 * before anything is written. Both of those are what replace the repair.
 */
export async function bootStorage(options: BootOptions): Promise<Result<BootReport>> {
  const seed = options.seed ?? buildSeed();
  const backend =
    options.backend ??
    new MemoryStorage({
      clock: options.clock,
      user: options.user ?? USERNAME,
      group: options.user ?? USERNAME,
      capacity: options.capacity ?? null,
    });

  const cleared = await backend.reset();
  if (!cleared.ok) return cleared;

  const installed = await backend.installImage(seed);
  if (!installed.ok) return installed;

  let restore: RestoreReport | null = null;
  if (options.overlay !== undefined) {
    const grafted = await importSnapshot(backend, options.overlay);
    if (!grafted.ok) return grafted;
    restore = grafted.value;
  }

  const mounts = new MountTable(backend);
  const vfs = new VirtualFileSystem(mounts, {
    home: HOME,
    ...(options.cwd === undefined ? {} : { cwd: options.cwd }),
  });

  return ok({ vfs, backend, seed, restore });
}
