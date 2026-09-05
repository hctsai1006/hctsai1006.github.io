/**
 * `Get-Content -Encoding`, against what pwsh 7.6.5 actually did.
 *
 * A SEPARATE FILE BECAUSE THIS BEHAVIOUR HAD NO TESTS AT ALL. `get-content.ts`
 * shipped a decoder table mapping the PowerShell names `ascii`, `ansi` and
 * `oem` all onto the single WHATWG label `windows-1252`, and nothing in
 * `tests/` ever passed `-Encoding` to it. Measured on pwsh 7.6.5 over the bytes
 * 61 E9 80 7A, those three names are three different answers, and the file's
 * BOM handling was absent entirely.
 *
 * The fixture files here are written as RAW BYTES rather than through the
 * harness's `files` map, which writes UTF-8 text — a test that cannot express a
 * byte that is not valid UTF-8 cannot test a decoder.
 */

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

import { getContent } from '../../src/commands/fs-read/index.ts';
import { isErr } from '../../src/storage/index.ts';
import { HOME, errorIds, harness, run } from './fs-read-harness.mts';
import type { Harness } from './fs-read-harness.mts';

/** 'U+0061 U+FFFD' — a code-UNIT view, so a lone surrogate stays visible. */
function units(text: string): string {
  return Array.from({ length: text.length }, (_, i) =>
    `U+${text.charCodeAt(i).toString(16).toUpperCase().padStart(4, '0')}`,
  ).join(' ');
}

/** A harness whose files are exact byte sequences. */
async function withBytes(files: Readonly<Record<string, readonly number[]>>): Promise<Harness> {
  const h = await harness();
  for (const [name, bytes] of Object.entries(files)) {
    const written = await h.vfs.writeBytes(`${HOME}/${name}`, Uint8Array.from(bytes));
    if (isErr(written)) throw new Error(`fixture write failed: ${written.error.code}`);
  }
  return h;
}

/** The single string `Get-Content -Raw` emitted. */
function onlyText(values: readonly unknown[]): string {
  assert.equal(values.length, 1, 'expected exactly one emitted value');
  const first = values[0];
  assert.equal(typeof first, 'string');
  return first as string;
}

/** 'a', 0xE9, 0x80, 'z' — the byte sequence every decode probe used. */
const PROBE = [0x61, 0xe9, 0x80, 0x7a];

describe('Get-Content -Encoding names each mean a different thing', () => {
  // pwsh 7.6.5, Ubuntu 24.04.4, over a file holding exactly 61 E9 80 7A:
  //
  //   -Encoding ascii   ->  U+0061 U+003F U+003F U+007A
  //   -Encoding latin1  ->  U+0061 U+00E9 U+0080 U+007A
  //   -Encoding ansi    ->  U+0061 U+00E9 U+20AC U+007A
  //   -Encoding oem     ->  U+0061 U+FFFD U+007A
  //   -Encoding utf8    ->  U+0061 U+FFFD U+007A
  //   (none)            ->  U+0061 U+FFFD U+007A
  //
  // The implementation this replaced returned the `ansi` row for `ascii` and
  // for `oem` as well, and under Node it would not even have returned that —
  // TextDecoder('windows-1252') decodes 0x80 as U+0080 there and U+20AC in a
  // browser.
  const rows: readonly (readonly [string | undefined, string])[] = [
    [undefined, 'U+0061 U+FFFD U+007A'],
    ['utf8', 'U+0061 U+FFFD U+007A'],
    ['ascii', 'U+0061 U+003F U+003F U+007A'],
    ['latin1', 'U+0061 U+00E9 U+0080 U+007A'],
    ['ansi', 'U+0061 U+00E9 U+20AC U+007A'],
    ['oem', 'U+0061 U+FFFD U+007A'],
  ];

  for (const [encoding, expected] of rows) {
    it(`decodes 61 E9 80 7A as ${encoding ?? '(default)'} the way pwsh does`, async () => {
      const h = await withBytes({ 'probe.bin': PROBE });
      const result = await run(
        getContent,
        { Path: 'probe.bin', Raw: true, ...(encoding === undefined ? {} : { Encoding: encoding }) },
        { port: h.port },
      );
      assert.deepEqual(result.errors, []);
      assert.equal(units(onlyText(result.values)), expected);
    });
  }

  it('gives ascii, ansi and oem three DIFFERENT answers', async () => {
    // The regression this file exists for, stated as one assertion: the three
    // names shared a single decoder label before, so all three agreed.
    const h = await withBytes({ 'probe.bin': PROBE });
    const read = async (encoding: string): Promise<string> => {
      const r = await run(getContent, { Path: 'probe.bin', Raw: true, Encoding: encoding }, { port: h.port });
      return units(onlyText(r.values));
    };
    const [ascii, ansi, oem] = [await read('ascii'), await read('ansi'), await read('oem')];
    assert.notEqual(ascii, ansi);
    assert.notEqual(ansi, oem);
    assert.notEqual(ascii, oem);
  });

  it('decodes UTF-16 and UTF-32 names, which previously had no decoder at all', async () => {
    // pwsh: unicode over 61 E9 80 7A          -> U+E961 U+7A80
    //       bigendianunicode over the same    -> U+61E9 U+807A
    //       utf32 over the same               -> U+FFFD
    // The table this replaced had no entry for utf32 or bigendianutf32 and
    // reported them as "accepted by PowerShell but has no decoder here".
    const h = await withBytes({ 'probe.bin': PROBE });
    const read = async (encoding: string): Promise<string> => {
      const r = await run(getContent, { Path: 'probe.bin', Raw: true, Encoding: encoding }, { port: h.port });
      assert.deepEqual(r.errors, [], encoding);
      return units(onlyText(r.values));
    };
    assert.equal(await read('unicode'), 'U+E961 U+7A80');
    assert.equal(await read('bigendianunicode'), 'U+61E9 U+807A');
    assert.equal(await read('utf32'), 'U+FFFD');
    assert.equal(await read('bigendianutf32'), 'U+FFFD');
  });
});

describe('Get-Content sniffs the BOM, and the BOM wins', () => {
  it('reads a UTF-16LE file correctly even when told -Encoding utf8', async () => {
    // pwsh: a file of FF FE 61 00 62 00 read with -Encoding utf8 -> 'ab'.
    // Decoding it as UTF-8 gives U+FFFD U+FFFD U+0061 U+0000 U+0062 U+0000,
    // which is what this command used to return.
    const h = await withBytes({ 'u16.txt': [0xff, 0xfe, 0x61, 0x00, 0x62, 0x00] });
    const result = await run(
      getContent,
      { Path: 'u16.txt', Raw: true, Encoding: 'utf8' },
      { port: h.port },
    );
    assert.deepEqual(result.errors, []);
    assert.equal(onlyText(result.values), 'ab');
  });

  it('strips a UTF-8 BOM rather than emitting U+FEFF', async () => {
    // pwsh: EF BB BF 61 62 -> 'ab', with no leading zero-width space. A decoder
    // that keeps the BOM produces a string that LOOKS right and compares wrong.
    const h = await withBytes({ 'bom.txt': [0xef, 0xbb, 0xbf, 0x61, 0x62] });
    const result = await run(getContent, { Path: 'bom.txt', Raw: true }, { port: h.port });
    assert.equal(onlyText(result.values), 'ab');
    assert.equal(units(onlyText(result.values)), 'U+0061 U+0062');
  });

  it('strips a BOM even when an unrelated single-byte encoding was asked for', async () => {
    // pwsh: EF BB BF 61 with -Encoding latin1 -> U+0061, not U+00EF U+00BB U+00BF U+0061.
    const h = await withBytes({ 'bom.txt': [0xef, 0xbb, 0xbf, 0x61] });
    const result = await run(
      getContent,
      { Path: 'bom.txt', Raw: true, Encoding: 'latin1' },
      { port: h.port },
    );
    assert.equal(units(onlyText(result.values)), 'U+0061');
  });

  it('resolves FF FE 00 00 as UTF-32LE, not UTF-16LE', async () => {
    // pwsh: FF FE 00 00 61 00 00 00 with no -Encoding -> U+0061.
    // A UTF-16LE reading gives U+0000 U+0061 U+0000.
    const h = await withBytes({ 'u32.txt': [0xff, 0xfe, 0x00, 0x00, 0x61, 0x00, 0x00, 0x00] });
    const result = await run(getContent, { Path: 'u32.txt', Raw: true }, { port: h.port });
    assert.equal(units(onlyText(result.values)), 'U+0061');
  });

  it('emits nothing for a file that is only a BOM, as for an empty file', async () => {
    // pwsh: @(Get-Content bomonly.txt -Raw).Count -> 0. -Raw on an EMPTY file
    // emits nothing, and a BOM-only file is empty once the BOM is consumed.
    const h = await withBytes({ 'bomonly.txt': [0xef, 0xbb, 0xbf] });
    const result = await run(getContent, { Path: 'bomonly.txt', Raw: true }, { port: h.port });
    assert.deepEqual(result.values, []);
    assert.deepEqual(result.errors, []);
  });
});

describe('Get-Content -AsByteStream still bypasses every decoder', () => {
  it('returns the exact bytes, including ones no encoding could round-trip', async () => {
    // The invariant the broker exists to protect: bytes stay bytes. pwsh:
    // Get-Content -AsByteStream -Raw over 61 E9 80 7A -> one System.Byte[] of
    // exactly those four values.
    const h = await withBytes({ 'probe.bin': PROBE });
    const result = await run(
      getContent,
      { Path: 'probe.bin', AsByteStream: true, Raw: true },
      { port: h.port },
    );
    assert.equal(result.values.length, 1);
    assert.ok(result.values[0] instanceof Uint8Array);
    assert.deepEqual([...(result.values[0] as Uint8Array)], PROBE);
  });

  it('is unaffected by -Encoding, because there is nothing to decode', async () => {
    const h = await withBytes({ 'probe.bin': PROBE });
    const result = await run(
      getContent,
      { Path: 'probe.bin', AsByteStream: true, Raw: true, Encoding: 'ascii' },
      { port: h.port },
    );
    assert.deepEqual([...(result.values[0] as Uint8Array)], PROBE);
  });
});

describe('Get-Content -Encoding failures', () => {
  it('reports an unknown encoding as a binding transformation failure', async () => {
    // MEASURED: Get-Content -Encoding sausage
    //   -> ParameterArgumentTransformationError,Microsoft.PowerShell.Commands.GetContentCommand
    //      InvalidData, ParameterBindingArgumentTransformationException
    // It used to report EncodingNotImplemented / NotImplemented here, which
    // claimed the engine was the thing refusing when pwsh refuses too.
    const h = await withBytes({ 'probe.bin': PROBE });
    const result = await run(
      getContent,
      { Path: 'probe.bin', Raw: true, Encoding: 'sausage' },
      { port: h.port },
    );
    assert.deepEqual(errorIds(result.errors), [
      'ParameterArgumentTransformationError,Microsoft.PowerShell.Commands.GetContentCommand',
    ]);
    assert.equal(result.errors[0]?.category, 'InvalidData');
    assert.equal(result.exitCode, 1);
    assert.deepEqual(result.values, []);
  });

  it('fails before opening any file, as a binding failure does', async () => {
    // pwsh rejects the argument during binding, so the provider is never
    // reached. A per-file check would have emitted this once per path AND only
    // after the first file had already been read and emitted.
    const h = await withBytes({ 'a.bin': [0x61], 'b.bin': [0x62] });
    const result = await run(
      getContent,
      { Path: ['a.bin', 'b.bin'], Raw: true, Encoding: 'sausage' },
      { port: h.port },
    );
    assert.equal(result.errors.length, 1, 'one binding failure, not one per path');
    assert.deepEqual(result.values, [], 'nothing was read');
  });

  it('separates "recognised but not implemented" from "not an encoding"', async () => {
    // pwsh ACCEPTS -Encoding utf7 (with an obsolescence warning) and REJECTS
    // -Encoding sausage at binding. utf7 is modified base64 rather than a byte
    // mapping and is not implemented here, so it is refused BY NAME with a
    // different error — claiming pwsh rejects it would be false.
    const h = await withBytes({ 'probe.bin': PROBE });
    const result = await run(
      getContent,
      { Path: 'probe.bin', Raw: true, Encoding: 'utf7' },
      { port: h.port },
    );
    assert.deepEqual(errorIds(result.errors), [
      'EncodingNotImplemented,Microsoft.PowerShell.Commands.GetContentCommand',
    ]);
    assert.equal(result.errors[0]?.category, 'NotImplemented');
  });
});

describe('every command that reads text sniffs the BOM, not just Get-Content', () => {
  // MEASURED on pwsh 7.6.5 against a UTF-16LE file (FF FE 68 00 65 00 ...)
  // holding "hello world":
  //
  //   Select-String -Pattern world  ->  MATCHED: [hello world]
  //   Get-Content -Raw              ->  hello world
  //
  // This engine's cat, grep and Select-String read through
  // FileSystemPort.readText, which decodes UTF-8 unconditionally and has no
  // sniff, so all three saw replacement characters interleaved with NULs and
  // Select-String matched nothing. That was the last path by which bytes
  // became text without the broker.

  /** 'hello world' as UTF-16LE with a BOM. */
  const UTF16_HELLO = [
    0xff, 0xfe,
    0x68, 0x00, 0x65, 0x00, 0x6c, 0x00, 0x6c, 0x00, 0x6f, 0x00, 0x20, 0x00,
    0x77, 0x00, 0x6f, 0x00, 0x72, 0x00, 0x6c, 0x00, 0x64, 0x00,
  ];

  it('Select-String matches inside a UTF-16LE file', async () => {
    const { selectString } = await import('../../src/commands/fs-read/index.ts');
    const h = await withBytes({ 'u16.txt': UTF16_HELLO });
    const result = await run(
      selectString,
      { Path: 'u16.txt', Pattern: 'world' },
      { port: h.port },
    );
    assert.deepEqual(result.errors, []);
    assert.equal(result.values.length, 1, 'expected one MatchInfo');
  });

  it('cat prints a UTF-16LE file as text', async () => {
    const { cat } = await import('../../src/commands/fs-read/index.ts');
    const h = await withBytes({ 'u16.txt': UTF16_HELLO });
    const result = await run(cat, {}, { port: h.port, remaining: ['u16.txt'] });
    assert.deepEqual(result.errors, []);
    assert.deepEqual(result.values, ['hello world']);
  });

  it('grep matches inside a UTF-16LE file', async () => {
    const { grep } = await import('../../src/commands/fs-read/index.ts');
    const h = await withBytes({ 'u16.txt': UTF16_HELLO });
    const result = await run(grep, {}, { port: h.port, remaining: ['world', 'u16.txt'] });
    assert.deepEqual(result.values, ['hello world']);
  });

  it('still reads a plain UTF-8 file unchanged', async () => {
    // The regression guard for the change itself: swapping readText for
    // readBytes + decodeFile must not move the ordinary case.
    const { cat } = await import('../../src/commands/fs-read/index.ts');
    const h = await withBytes({ 'plain.txt': [0x68, 0x69, 0x0a, 0x74, 0x68, 0x65, 0x72, 0x65] });
    const result = await run(cat, {}, { port: h.port, remaining: ['plain.txt'] });
    assert.deepEqual(result.values, ['hi', 'there']);
  });
});
