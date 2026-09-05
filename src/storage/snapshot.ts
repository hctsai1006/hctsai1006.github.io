/**
 * snapshot.ts — export before people can lose work, and the overlay graft.
 *
 * PR-09's risk section is unambiguous: "OPFS is deleted on site-data clear with
 * no warning from the browser; export/import must land in the same PR." Not a
 * later PR. A user clears cookies for an unrelated reason, and everything they
 * wrote in `nano` is gone, with no dialog, no undo, and nothing that even tells
 * them it happened. So this exists before the storage it protects does.
 *
 * ---------------------------------------------------------------------------
 * ONE MECHANISM, TWO JOBS
 * ---------------------------------------------------------------------------
 *
 * The export a user downloads and the overlay the page persists on every write
 * are the SAME format at two scopes:
 *
 *   'full'     every node UNDER the root, with its bytes. Survives a cleared
 *              origin, an OPFS that never comes back, a move to another
 *              browser. The mount root itself is not an entry: it always exists,
 *              and its ownership is the seed's to set, not a restore's.
 *   'overlay'  only what the user changed. Seed files contribute at most their
 *              mode and mtime, never their content, because the content comes
 *              from re-running the seed on the next boot — which is what makes
 *              a portfolio update visible to a returning visitor.
 *
 * Two formats would be two parsers, two version fields and two ways to be
 * subtly wrong about the same tree. v1 has exactly one serialiser (`fsSer`) and
 * uses it only for the overlay; the full export is what it is missing.
 *
 * ---------------------------------------------------------------------------
 * WRITTEN AGAINST THE INTERFACE, NOT AGAINST THE MEMORY BACKEND
 * ---------------------------------------------------------------------------
 *
 * Every read here is `readdir`, `stat` or `readBytes`, and every write is
 * `mkdir`, `writeBytes`, `chmod` or `utimes`. Nothing reaches into a backend's
 * internals. That is the reason `origin` is a field of `FileStat` rather than a
 * private of `MemoryStorage`: without it in the interface, the overlay scope
 * would need one implementation per backend, and the first thing to diverge
 * would be the export that exists to prevent data loss.
 *
 * ---------------------------------------------------------------------------
 * REFUSING TO RESTORE
 * ---------------------------------------------------------------------------
 *
 * Three refusals, all before a single node is touched:
 *
 *   1. wrong `format` — the bytes are not a snapshot at all;
 *   2. unknown `version` — a newer build wrote it, and guessing at a format
 *      from the future is how you silently drop the fields you do not know
 *      about. A refusal is recoverable; a lossy restore is not;
 *   3. checksum mismatch — the payload was truncated or corrupted.
 *
 * The checksum is FNV-1a 32-bit. It detects CORRUPTION and nothing else: it is
 * not a MAC, it stops no one who wants to edit the file, and it is not claimed
 * to. v1 already learned to validate this blob's metadata on the way back in
 * (`applyMeta` regex-checks the mode string before trusting it) because
 * localStorage is user-editable; every field here is validated on the same
 * reasoning.
 */

import { err, ok } from './types.ts';
import type {
  FileStat,
  NodeOrigin,
  Result,
  SeedSpec,
  StatKind,
  StorageBackend,
  StorageError,
} from './types.ts';

// ---------------------------------------------------------------------------
// the format
// ---------------------------------------------------------------------------

export const SNAPSHOT_FORMAT = 'browsershell.fs.snapshot';

/**
 * Bumped when the ENTRY SHAPE or the INTEGRITY ENVELOPE changes, never for a
 * content change.
 *
 * Version 2 widened what the checksum covers. Version 1 hashed `entries` alone,
 * which left `scope` unauthenticated — and `scope` is what decides whether an
 * `s: 1` entry means "restore the metadata, the seed owns the content" or
 * "materialise this, content included". MEASURED on a version 1 document:
 * changing the single word `overlay` to `full` in a stored overlay truncated a
 * 63-byte seed file to 0 bytes, was accepted with `failures: []`, and the two
 * documents hashed identically (`f0c15aeb === f0c15aeb`). The checksum now
 * covers every field except itself, so that edit is a refusal.
 *
 * Neither version has tombstones, which is the known limitation of the
 * seed/overlay split recorded in `vfs.ts`: deleting a seed file does not
 * persist. Adding them is a third entry kind and therefore a later version
 * still, and the refusal below is what makes that upgrade safe to make — an
 * older reader declines a newer file rather than silently ignoring its
 * tombstones and resurrecting every deleted file.
 */
export const SNAPSHOT_VERSION = 2;

export type SnapshotScope = 'full' | 'overlay';

/**
 * One node. Short keys because the overlay is written on every mutation and
 * v1's blob lives in localStorage, where the 5 MB ceiling is real.
 */
export interface SnapshotEntry {
  /** 'f' file, 'd' directory. */
  readonly t: 'f' | 'd';
  /** Absolute path. */
  readonly p: string;
  /** Base64 file content. Absent for a directory, and for a seed node in an overlay. */
  readonly c?: string;
  /**
   * 1 when this node's origin is `seed`.
   *
   * It records ORIGIN and nothing else. Whether the content is carried is
   * decided by the document's SCOPE: an overlay omits seed content because the
   * next boot rebuilds it, a full export carries everything because there may
   * be no next seed. Letting this one flag mean both is how a full restore of a
   * seeded tree silently drops every seed file — which it did, until a test
   * caught it.
   */
  readonly s?: 1;
  /** Mode, when it deviates from what the seed declared (or always, when full). */
  readonly m?: number;
  /** mtime, when it deviates from the seed time (or always, when full). */
  readonly mt?: number;
}

export interface SnapshotDocument {
  readonly format: typeof SNAPSHOT_FORMAT;
  readonly version: number;
  readonly scope: SnapshotScope;
  /** Epoch ms, from the caller's clock. */
  readonly createdAt: number;
  /** The seed timestamp this overlay was taken against. Null for a full export. */
  readonly seedTime: number | null;
  /** FNV-1a 32-bit of the canonical entries JSON, lower-case hex. */
  readonly checksum: string;
  readonly entries: readonly SnapshotEntry[];
  /** Subtrees the export could not read. Empty is the good case. */
  readonly skipped: readonly string[];
}

// ---------------------------------------------------------------------------
// base64
// ---------------------------------------------------------------------------

const ALPHABET = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/';

/**
 * Hand-rolled rather than `btoa` or `Uint8Array.prototype.toBase64`.
 *
 * `btoa` takes a latin-1 STRING, so a byte array has to be turned into one
 * first, and the obvious `String.fromCharCode(...bytes)` blows the argument
 * limit on a file of any size. `toBase64` is the right API and is too new to
 * depend on — it is not in the baseline this project targets, and a storage
 * export that throws on an older browser fails at exactly the moment it was
 * built to help. Twenty lines with a test is the cheaper end of that trade.
 */
export function toBase64(bytes: Uint8Array): string {
  let out = '';
  for (let i = 0; i < bytes.length; i += 3) {
    const a = bytes[i] ?? 0;
    const b = bytes[i + 1];
    const c = bytes[i + 2];
    const triple = (a << 16) | ((b ?? 0) << 8) | (c ?? 0);
    out += ALPHABET[(triple >> 18) & 0x3f] ?? '';
    out += ALPHABET[(triple >> 12) & 0x3f] ?? '';
    out += b === undefined ? '=' : (ALPHABET[(triple >> 6) & 0x3f] ?? '');
    out += c === undefined ? '=' : (ALPHABET[triple & 0x3f] ?? '');
  }
  return out;
}

/** Null on anything that is not well-formed base64 — the blob is user-editable. */
export function fromBase64(text: string): Uint8Array | null {
  if (text.length % 4 !== 0) return null;
  const body = text.endsWith('==') ? text.slice(0, -2) : text.endsWith('=') ? text.slice(0, -1) : text;
  const padding = text.length - body.length;
  const out = new Uint8Array((text.length / 4) * 3 - padding);

  let index = 0;
  for (let i = 0; i < body.length; i += 4) {
    let triple = 0;
    let bits = 0;
    for (let j = 0; j < 4 && i + j < body.length; j += 1) {
      const value = ALPHABET.indexOf(body[i + j] ?? '');
      if (value === -1) return null;
      triple = (triple << 6) | value;
      bits += 6;
    }
    triple <<= 24 - bits;
    for (let shift = 16; shift >= 0 && index < out.length; shift -= 8) {
      out[index] = (triple >> shift) & 0xff;
      index += 1;
    }
  }
  return out;
}

// ---------------------------------------------------------------------------
// checksum
// ---------------------------------------------------------------------------

const ENCODER = new TextEncoder();

/**
 * FNV-1a, 32-bit. Corruption detection, NOT authentication.
 *
 * Chosen because it needs no dependency, runs in a worker, and is deterministic
 * across every engine — the three things a format-integrity check has to be.
 * Anyone editing the file can recompute it; that is not the threat model. The
 * threat is a truncated download and a half-written localStorage value, both of
 * which this catches.
 */
export function fnv1a32(text: string): string {
  let hash = 0x811c9dc5;
  const bytes = ENCODER.encode(text);
  for (const byte of bytes) {
    hash ^= byte;
    hash = Math.imul(hash, 0x01000193) >>> 0;
  }
  return hash.toString(16).padStart(8, '0');
}

// ---------------------------------------------------------------------------
// export
// ---------------------------------------------------------------------------

export interface SnapshotOptions {
  readonly scope: SnapshotScope;
  /** Epoch ms for `createdAt`. Injected, so a snapshot is reproducible in a test. */
  readonly now: number;
  /**
   * The seed this overlay is taken against.
   *
   * With it, a seed node is recorded only when its mode or mtime DEVIATES —
   * which is v1's `fsSer` rule (`if(n.mode!==DEFMODE[n.t]) o.m=n.mode`) and the
   * reason a freshly booted, untouched filesystem serialises to almost nothing.
   * Without it, every seed node is recorded, which is correct but larger.
   */
  readonly seed?: SeedSpec;
  /** Where to start. Defaults to the mount root. */
  readonly root?: string;
}

interface SeedExpectation {
  readonly mode: number;
  readonly mtime: number;
}

function seedExpectations(spec: SeedSpec | undefined): Map<string, SeedExpectation> | null {
  if (spec === undefined) return null;
  const map = new Map<string, SeedExpectation>();
  for (const entry of spec.entries) {
    if (entry.mode === undefined) continue;
    map.set(entry.path, { mode: entry.mode, mtime: spec.time });
  }
  return map;
}

/**
 * Every path this build's seed OWNS, and what kind it puts there.
 *
 * Not just the spec's own entries: `installImage` creates a missing ancestor
 * of a seed entry as a seed DIRECTORY, so `/usr/share` can be a seed node that
 * the spec never names. Leaving those out would demote real seed directories
 * to 'user' on every restore, which is the bug this map exists to avoid while
 * closing the forged-claim hole.
 *
 * An explicit entry always wins over an inferred ancestor.
 */
function seedKinds(spec: SeedSpec | undefined): Map<string, StatKind> | null {
  if (spec === undefined) return null;
  const map = new Map<string, StatKind>();
  map.set('/', 'directory');
  // Explicit entries first, so an inferred ancestor can never overwrite one.
  for (const entry of spec.entries) map.set(entry.path, entry.kind);
  for (const entry of spec.entries) {
    const segments = entry.path.split('/').filter((segment) => segment !== '');
    segments.pop();
    let walked = '';
    for (const segment of segments) {
      walked = `${walked}/${segment}`;
      if (!map.has(walked)) map.set(walked, 'directory');
    }
  }
  return map;
}

/**
 * Walk the tree through the interface and build the document.
 *
 * A subtree the caller cannot read is SKIPPED and named, not an error. That is
 * what a user-level backup does — `/root` is 0o700 and root-owned, so a visitor
 * genuinely cannot read it, and failing the whole export over a directory whose
 * contents are seed data anyway would mean nobody ever gets an export.
 */
export async function createSnapshot(
  backend: StorageBackend,
  options: SnapshotOptions,
): Promise<Result<SnapshotDocument>> {
  const entries: SnapshotEntry[] = [];
  const skipped: string[] = [];
  const expectations = seedExpectations(options.seed);
  const seedTime = options.seed?.time ?? null;
  const full = options.scope === 'full';

  const record = async (stat: FileStat): Promise<Result<void>> => {
    const isSeed = stat.origin === 'seed';

    if (isSeed && !full) {
      // A seed node carries no content. It is recorded only when the user
      // changed something about it that the next boot would otherwise lose.
      const expected = expectations?.get(stat.path);
      const modeChanged = expected === undefined || stat.mode !== expected.mode;
      const timeChanged = seedTime === null || stat.mtime !== seedTime;
      if (expectations !== null && !modeChanged && !timeChanged) return ok(undefined);
      entries.push({
        t: stat.kind === 'directory' ? 'd' : 'f',
        p: stat.path,
        s: 1,
        ...(modeChanged ? { m: stat.mode } : {}),
        ...(timeChanged ? { mt: stat.mtime } : {}),
      });
      return ok(undefined);
    }

    if (stat.kind === 'directory') {
      entries.push({
        t: 'd',
        p: stat.path,
        m: stat.mode,
        mt: stat.mtime,
        ...(isSeed ? { s: 1 as const } : {}),
      });
      return ok(undefined);
    }

    const bytes = await backend.readBytes(stat.path);
    if (!bytes.ok) {
      skipped.push(stat.path);
      return ok(undefined);
    }
    entries.push({
      t: 'f',
      p: stat.path,
      c: toBase64(bytes.value),
      m: stat.mode,
      mt: stat.mtime,
      ...(isSeed ? { s: 1 as const } : {}),
    });
    return ok(undefined);
  };

  const walk = async (path: string): Promise<Result<void>> => {
    const rows = await backend.readdir(path);
    if (!rows.ok) {
      skipped.push(path);
      return ok(undefined);
    }
    // Sorted so two exports of the same tree are byte-identical. A snapshot
    // whose bytes depend on insertion order cannot be diffed or compared.
    const sorted = [...rows.value].sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
    for (const row of sorted) {
      const written = await record(row.stat);
      if (!written.ok) return written;
      if (row.stat.kind === 'directory') {
        const descended = await walk(row.stat.path);
        if (!descended.ok) return descended;
      }
    }
    return ok(undefined);
  };

  const walked = await walk(options.root ?? '/');
  if (!walked.ok) return walked;

  const unsigned = {
    format: SNAPSHOT_FORMAT,
    version: SNAPSHOT_VERSION,
    scope: options.scope,
    createdAt: saneTime(options.now) ?? 0,
    seedTime: saneTime(seedTime),
    entries,
    skipped,
  } as const;
  return ok({ ...unsigned, checksum: fnv1a32(snapshotPayload(unsigned)) });
}

/**
 * Exactly the bytes the checksum covers: the whole document except the
 * checksum field itself, in a fixed key order.
 *
 * Exported because a document is only as trustworthy as the thing that signs
 * it, and every writer — this file, a test building a fixture, an OPFS backend
 * later — has to agree on the input. Version 1 hashed `entries` alone; see
 * `SNAPSHOT_VERSION` for the truncation that bought.
 *
 * Still FNV-1a, and still only a corruption check: it is not a MAC, it stops
 * nobody who edits the file and recomputes it, and it is not claimed to. What
 * it now does is make an edit that flips one field an obvious refusal rather
 * than a silent change of meaning.
 */
export function snapshotPayload(document: Omit<SnapshotDocument, 'checksum'>): string {
  return JSON.stringify({
    format: document.format,
    version: document.version,
    scope: document.scope,
    createdAt: document.createdAt,
    seedTime: document.seedTime,
    entries: document.entries,
    skipped: document.skipped,
  });
}

export function encodeSnapshot(document: SnapshotDocument): Uint8Array {
  return ENCODER.encode(JSON.stringify(document));
}

/** Build and serialise in one call. What a `Export-FileSystem` command runs. */
export async function exportSnapshot(
  backend: StorageBackend,
  options: SnapshotOptions,
): Promise<Result<Uint8Array>> {
  const document = await createSnapshot(backend, options);
  if (!document.ok) return document;
  return ok(encodeSnapshot(document.value));
}

// ---------------------------------------------------------------------------
// import
// ---------------------------------------------------------------------------

const DECODER = new TextDecoder('utf-8', { fatal: false });

function refuse(reason: string, message: string): Result<never> {
  return err({
    code: 'EINVAL',
    path: '<snapshot>',
    syscall: 'restore',
    message,
    reason,
  });
}

function isEntry(value: unknown): value is SnapshotEntry {
  if (typeof value !== 'object' || value === null) return false;
  const row = value as Record<string, unknown>;
  if (row['t'] !== 'f' && row['t'] !== 'd') return false;
  if (typeof row['p'] !== 'string' || !row['p'].startsWith('/')) return false;
  if (row['c'] !== undefined && typeof row['c'] !== 'string') return false;
  if (row['s'] !== undefined && row['s'] !== 1) return false;
  if (row['m'] !== undefined && !isSaneMode(row['m'])) return false;
  if (row['mt'] !== undefined && !isSaneTime(row['mt'])) return false;
  return true;
}

/** 0 to 0o7777. v1 regex-checks the same field; the reasoning is identical. */
function isSaneMode(value: unknown): boolean {
  return typeof value === 'number' && Number.isInteger(value) && value >= 0 && value <= 0o7777;
}

function isSaneTime(value: unknown): boolean {
  return typeof value === 'number' && Number.isFinite(value) && value > 0;
}

/**
 * The one place a timestamp is made presentable, applied by the SIGNER and the
 * VERIFIER so the two are literally the same function.
 *
 * They were not. `decodeSnapshot` normalised before hashing and
 * `createSnapshot` signed the raw value, and `SnapshotOptions.now` and
 * `SeedSpec.time` are unconstrained `number`s — so a NaN clock, a negative
 * one, or a seed time of 0 produced a document THIS BUILD's own decoder then
 * refused as corrupt. MEASURED: `now=-1`, `now=NaN`, `now=Infinity` and
 * `seed.time=0` each exported happily and came back "the snapshot is corrupt",
 * sending anyone debugging a broken clock to look for bit rot instead.
 */
function saneTime(value: unknown): number | null {
  return isSaneTime(value) ? (value as number) : null;
}

/**
 * Parse and validate. Nothing is written before all three refusals have passed.
 */
export function decodeSnapshot(bytes: Uint8Array): Result<SnapshotDocument> {
  let parsed: unknown;
  try {
    parsed = JSON.parse(DECODER.decode(bytes));
  } catch {
    return refuse('not-json', 'the snapshot is not valid JSON');
  }
  if (typeof parsed !== 'object' || parsed === null) {
    return refuse('not-an-object', 'the snapshot is not an object');
  }
  const doc = parsed as Record<string, unknown>;

  if (doc['format'] !== SNAPSHOT_FORMAT) {
    return refuse(
      'wrong-format',
      `these bytes are not a ${SNAPSHOT_FORMAT}; the format field says ${JSON.stringify(doc['format'])}`,
    );
  }
  if (doc['version'] !== SNAPSHOT_VERSION) {
    return refuse(
      'unsupported-version',
      `this build understands snapshot version ${String(SNAPSHOT_VERSION)}, and the file is ` +
        `version ${String(doc['version'])}. Refusing rather than guessing: a restore that ` +
        'ignores the fields it does not recognise loses them silently.',
    );
  }
  const scope = doc['scope'];
  if (scope !== 'full' && scope !== 'overlay') {
    return refuse('unknown-scope', `unknown snapshot scope ${JSON.stringify(scope)}`);
  }
  const raw = doc['entries'];
  if (!Array.isArray(raw)) return refuse('no-entries', 'the snapshot has no entries array');

  const entries: SnapshotEntry[] = [];
  for (const row of raw) {
    if (!isEntry(row)) return refuse('bad-entry', `a snapshot entry is malformed: ${JSON.stringify(row)}`);
    entries.push(row);
  }

  // The list of subtrees the export could not read. It used to be hard-coded
  // to `[]` right here, which threw away the one field that says "this backup
  // is not everything" — an importer could never learn their `/root` or their
  // 0o000 directory had been left out, and would restore a partial tree
  // believing it was whole. Absent is tolerated (it means nothing was skipped);
  // present but malformed is refused, because guessing is how the information
  // got lost the first time.
  const rawSkipped = doc['skipped'];
  let skipped: readonly string[] = [];
  if (rawSkipped !== undefined) {
    if (!Array.isArray(rawSkipped) || rawSkipped.some((row) => typeof row !== 'string')) {
      return refuse('bad-skipped', 'the snapshot skipped list is not an array of paths');
    }
    skipped = rawSkipped as readonly string[];
  }

  const checksum = doc['checksum'];
  if (typeof checksum !== 'string') return refuse('no-checksum', 'the snapshot has no checksum');

  // Verified over the NORMALISED document, and `createSnapshot` signs the
  // normalised document too — both call `saneTime` and then `snapshotPayload`,
  // so signer and verifier are the same function rather than two functions
  // that happen to agree on the values anyone thought to try.
  const unsigned = {
    format: SNAPSHOT_FORMAT,
    version: SNAPSHOT_VERSION,
    scope,
    createdAt: saneTime(doc['createdAt']) ?? 0,
    seedTime: saneTime(doc['seedTime']),
    entries,
    skipped,
  } as const;
  const actual = fnv1a32(snapshotPayload(unsigned));
  if (actual !== checksum) {
    return refuse(
      'checksum-mismatch',
      `the snapshot is corrupt: checksum ${checksum} does not match the document (${actual})`,
    );
  }

  return ok({ ...unsigned, checksum });
}

export interface RestoreReport {
  /** Nodes written or updated. */
  readonly restored: number;
  /**
   * Seed entries whose path no longer exists in this version's seed.
   *
   * DROPPED, not materialised. v1 creates a file whose content reads
   * "(seed content unavailable)", which puts a broken file in the user's home
   * directory forever; if the site removed the file, it is gone.
   */
  readonly dropped: readonly string[];
  /**
   * Paths where the seed now has a different kind than the overlay recorded.
   * The seed wins — v1 makes the same call, and it is the right one: the site's
   * shape is authoritative and the overlay is a patch on top of it.
   */
  readonly conflicts: readonly string[];
  /** Entries that failed to write, with the reason. */
  readonly failures: readonly { readonly path: string; readonly error: StorageError }[];
}

export interface RestoreOptions {
  /** Where to put restored nodes. Defaults to the mount root. */
  readonly root?: string;
  /**
   * This build's seed, and the AUTHORITY on which paths may claim `s: 1`.
   *
   * A snapshot is a file someone can hand you, and `s: 1` is a claim inside it.
   * Believed unchecked, a crafted full-scope document marks the user's own
   * files as seed nodes; the next overlay export then omits their content
   * (a seed node's content is the next boot's job to rebuild), the next boot
   * finds no such path in the real seed, and the file lands in `dropped`. The
   * user's own data, deleted two boots later, by one flag.
   *
   * `bootStorage` always passes it, so the route a hostile file actually
   * travels is checked. A caller that omits it and restores into a store with
   * no seed installed has NO evidence either way and takes the claim at face
   * value — that is the disaster-recovery shape (a full snapshot is all that
   * survived a site-data clear), where dropping origin would make the very
   * next overlay carry the entire seed back again.
   */
  readonly seed?: SeedSpec;
}

/**
 * Graft a snapshot onto whatever is already mounted.
 *
 * For an overlay this runs straight after `installImage`, and the rules are
 * v1's `graftUser`, preserved and enumerated in `vfs.ts`. For a full snapshot
 * it runs against an empty mount and every entry carries its own content.
 *
 * Runs AS THE USER, through the ordinary write API. That is deliberate: a
 * snapshot is a file someone can hand you, and a restore that bypassed
 * permission checks would let a crafted file write into `/etc`. The seed is
 * installed privileged because it is the image; the overlay is not.
 */
export async function restoreSnapshot(
  backend: StorageBackend,
  document: SnapshotDocument,
  options: RestoreOptions = {},
): Promise<Result<RestoreReport>> {
  const prefix = options.root ?? '/';
  const seeded = seedKinds(options.seed);
  let restored = 0;
  const dropped: string[] = [];
  const conflicts: string[] = [];
  const failures: { path: string; error: StorageError }[] = [];

  // TWO PASSES, and both orderings are load-bearing.
  //
  // Pass 1 creates, parents before children, so a nested directory is never
  // created implicitly and left with a mode nobody chose.
  //
  // Pass 2 applies mode and mtime, CHILDREN BEFORE PARENTS, for two reasons
  // that both bite in one pass. A directory restored to 0o500 before its
  // contents are written locks the restore out of its own tree. And adding a
  // child moves the parent's mtime, so a directory stamped before its children
  // exist gets that stamp overwritten seconds later — which is how a restored
  // tree quietly ends up with every directory dated "now". v1's `graftUser`
  // sets mode and mtime before it recurses and has the second bug.
  const byDepth = [...document.entries].sort(
    (a, b) => depth(a.p) - depth(b.p) || (a.p < b.p ? -1 : 1),
  );
  const created: { path: string; entry: SnapshotEntry }[] = [];

  for (const entry of byDepth) {
    const path = prefix === '/' ? entry.p : `${prefix}${entry.p}`;
    const existing = await backend.stat(path);
    const wantedKind = entry.t === 'd' ? 'directory' : 'file';
    // `s: 1` is a CLAIM, not a fact. See `RestoreOptions.seed` for what it
    // costs to believe one. Two authorities, in order:
    //
    //   1. the seed spec, when the caller supplied one. It is the only
    //      authority that works before `installImage` has run, and it is what
    //      `bootStorage` passes;
    //   2. failing that, what the mount already holds — a genuine seed node,
    //      put there by `installImage` before this graft.
    //
    // With neither, there is no evidence, and the claim stands. The failure
    // direction is chosen: an unrecognised claim degrades to 'user', which at
    // worst carries content in an overlay that did not need it. The other
    // direction loses the file.
    const claimsSeed = entry.s === 1;
    // `path`, NOT `entry.p`. Under a `root` prefix the node lands somewhere the
    // seed does not own, and keying the lookup on the document's own path
    // granted `origin: 'seed'` to it: restoring a document that legitimately
    // claims `/etc/hostname` with `root: '/tmp'` produced a seed-origin
    // `/tmp/etc/hostname`. With no prefix the two strings are identical, so
    // this costs the boot path nothing.
    const seedKind = seeded?.get(path);
    const origin: NodeOrigin =
      !claimsSeed
        ? 'user'
        : seeded !== null
          ? seedKind === wantedKind
            ? 'seed'
            : 'user'
          : existing.ok && existing.value.origin !== 'seed'
            ? 'user'
            : 'seed';
    // Only an OVERLAY leaves seed content to the next boot. A full snapshot may
    // be all that is left after a site-data clear, so it materialises everything.
    // A FILE entry with no `c` is NEVER materialised, whatever the scope says.
    //
    // `createSnapshot` writes `c` for every file it exports — an empty file
    // gets `c: ""`, not an absent field — so a contentless file entry is
    // either corrupt or an overlay entry being read under the wrong scope.
    // Materialising it meant `new Uint8Array(0)`, which turns "the seed owns
    // this content" into "truncate it": flipping one word in a stored overlay
    // took a 63-byte seed file to 0 bytes with `failures: []`.
    //
    // Widening the checksum in this same commit-series raised the cost of that
    // edit to one line — `snapshotPayload` is exported and FNV-1a is not a MAC,
    // so re-signing is trivial, and MEASURED, the re-signed document truncated
    // the file again. This guard is what actually closes it, and it does not
    // depend on the integrity of the document at all. Treat such an entry the
    // way an overlay treats a seed node: metadata only, and `dropped` if the
    // path is not there.
    const contentless = entry.t === 'f' && entry.c === undefined;
    const metadataOnly = (document.scope === 'overlay' && claimsSeed) || contentless;

    if (metadataOnly) {
      // Only its metadata is ours to restore, and only if this version's seed
      // still has it, with the same kind.
      if (!existing.ok) {
        dropped.push(path);
        continue;
      }
      if (existing.value.kind !== wantedKind) {
        conflicts.push(path);
        continue;
      }
      created.push({ path, entry });
      continue;
    }

    if (existing.ok && existing.value.kind !== wantedKind) {
      // The seed replaced a user path with a node of the other kind. Seed wins.
      conflicts.push(path);
      continue;
    }

    if (entry.t === 'd') {
      if (!existing.ok) {
        const made = await backend.mkdir(path, { recursive: true, origin });
        if (!made.ok) {
          failures.push({ path, error: made.error });
          continue;
        }
      }
    } else {
      const content = entry.c === undefined ? new Uint8Array(0) : fromBase64(entry.c);
      if (content === null) {
        failures.push({
          path,
          error: {
            code: 'EINVAL',
            path,
            syscall: 'restore',
            message: 'the entry content is not valid base64',
            reason: 'bad-base64',
          },
        });
        continue;
      }
      const written = await backend.writeBytes(path, content, {
        createParents: true,
        origin,
        ...(entry.m === undefined ? {} : { mode: entry.m }),
      });
      if (!written.ok) {
        failures.push({ path, error: written.error });
        continue;
      }
    }
    created.push({ path, entry });
  }

  for (const { path, entry } of created.reverse()) {
    if (await applyMeta(backend, path, entry, failures)) restored += 1;
  }

  return ok({ restored, dropped, conflicts, failures });
}

async function applyMeta(
  backend: StorageBackend,
  path: string,
  entry: SnapshotEntry,
  failures: { path: string; error: StorageError }[],
): Promise<boolean> {
  if (entry.m !== undefined) {
    const changed = await backend.chmod(path, entry.m);
    if (!changed.ok) {
      failures.push({ path, error: changed.error });
      return false;
    }
  }
  if (entry.mt !== undefined) {
    const stamped = await backend.utimes(path, { mtime: entry.mt }, false);
    if (!stamped.ok) {
      failures.push({ path, error: stamped.error });
      return false;
    }
  }
  return true;
}

/** Decode and restore in one call. What `Import-FileSystem` runs. */
export async function importSnapshot(
  backend: StorageBackend,
  bytes: Uint8Array,
  options: RestoreOptions = {},
): Promise<Result<RestoreReport>> {
  const document = decodeSnapshot(bytes);
  if (!document.ok) return document;
  return restoreSnapshot(backend, document.value, options);
}

function depth(path: string): number {
  let count = 0;
  for (const character of path) if (character === '/') count += 1;
  return count;
}
