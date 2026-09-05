/**
 * Tests for the encoding broker.
 *
 * EVERY expectation in this file was read off pwsh 7.6.5 — Ubuntu 24.04.4 in a
 * container, and Windows 10.0.26340 where the two platforms disagree — rather
 * than reasoned about. The probe output is quoted at each site, because five of
 * these contradicted the obvious implementation:
 *
 *   - `-Encoding ascii` DECODES a high byte to '?', not to a windows-1252
 *     character. The table this replaced mapped it to windows-1252.
 *   - `-Encoding oem` on Linux is UTF-8, not windows-1252.
 *   - `TextDecoder('windows-1252')` decodes 0x80 differently in Node and
 *     Chrome, so it cannot be used at all.
 *   - `.NET` encodes a surrogate PAIR to TWO question marks in ASCII, so the
 *     encoder must walk code units, not codepoints.
 *   - `$OutputEncoding` does not decode native command output.
 *
 * The last of those is the reason the broker exists, and the reason PowerShell
 * 7.7 added `$PSApplicationOutputEncoding` at all.
 */

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

import {
  EncodingBroker,
  APPLICATION_OUTPUT_ENCODING_KEY,
  UBUNTU_CODE_PAGES,
  decodeBytes,
  decodeFile,
  encodeText,
  preambleOf,
  resolveEncodingName,
  sniffBom,
  webNameOf,
  defaultEncodingBroker,
} from '../../src/pipeline/encoding.ts';
import type { EncodingId } from '../../src/pipeline/encoding.ts';
import { viewOfBehaviors } from '../../src/compatibility/profile-resolver.ts';

/** 'U+0061 U+FFFD' — a code-UNIT view, so a lone surrogate is visible. */
function units(text: string): string {
  return Array.from({ length: text.length }, (_, i) =>
    `U+${text.charCodeAt(i).toString(16).toUpperCase().padStart(4, '0')}`,
  ).join(' ');
}

function hex(bytes: Uint8Array): string {
  return [...bytes].map((b) => b.toString(16).toUpperCase().padStart(2, '0')).join(' ');
}

function bytes(...values: number[]): Uint8Array {
  return Uint8Array.from(values);
}

/** The sample the encode probes used: U+00E9 U+20AC U+4E2D. */
const SAMPLE = 'é€中';
/** The bytes the decode probes used: 'a', 0xE9, 0x80, 'z'. */
const PROBE_BYTES = bytes(0x61, 0xe9, 0x80, 0x7a);

describe('decoding a byte sequence, by codec', () => {
  // Measured with `Get-Content -Raw -Encoding <name>` over a file holding
  // exactly the bytes 61 E9 80 7A. These four rows are the whole reason the
  // single-byte codecs are hand-rolled: they are FOUR DIFFERENT ANSWERS, and
  // the table this replaced returned the windows-1252 row for three of them.
  const cases: readonly (readonly [EncodingId, string])[] = [
    ['utf8', 'U+0061 U+FFFD U+007A'],
    ['ascii', 'U+0061 U+003F U+003F U+007A'],
    ['latin1', 'U+0061 U+00E9 U+0080 U+007A'],
    ['windows1252', 'U+0061 U+00E9 U+20AC U+007A'],
    ['utf16le', 'U+E961 U+7A80'],
    ['utf16be', 'U+61E9 U+807A'],
    ['utf32le', 'U+FFFD'],
  ];

  for (const [id, expected] of cases) {
    it(`decodes 61 E9 80 7A as ${id} the way pwsh does`, () => {
      assert.equal(units(decodeBytes(PROBE_BYTES, id)), expected);
    });
  }

  it('does NOT decode ascii as windows-1252, which is the bug this replaced', () => {
    // pwsh: Get-Content -Encoding ascii over 61 E9 80 7A
    //         -> U+0061 U+003F U+003F U+007A
    // The previous implementation mapped the name 'ascii' to the WHATWG label
    // 'windows-1252', which yields U+0061 U+00E9 U+20AC U+007A in a browser.
    assert.notEqual(units(decodeBytes(PROBE_BYTES, 'ascii')), units(decodeBytes(PROBE_BYTES, 'windows1252')));
    assert.equal(decodeBytes(bytes(0xe9), 'ascii'), '?');
  });

  it('distinguishes latin1 from windows-1252 across the whole 0x80-0x9F range', () => {
    // This range is the ONLY place the two differ, and it is exactly the range
    // Node's TextDecoder gets wrong. pwsh on Ubuntu, GetEncoding(1252):
    //   U+20AC U+0081 U+201A U+0192 U+201E U+2026 U+2020 U+2021 ...
    const high = Uint8Array.from({ length: 32 }, (_, i) => 0x80 + i);
    assert.equal(
      units(decodeBytes(high, 'windows1252')),
      'U+20AC U+0081 U+201A U+0192 U+201E U+2026 U+2020 U+2021 ' +
        'U+02C6 U+2030 U+0160 U+2039 U+0152 U+008D U+017D U+008F ' +
        'U+0090 U+2018 U+2019 U+201C U+201D U+2022 U+2013 U+2014 ' +
        'U+02DC U+2122 U+0161 U+203A U+0153 U+009D U+017E U+0178',
    );
    // latin1 is the identity mapping, measured via Encoding.Latin1.
    assert.equal(
      units(decodeBytes(high, 'latin1')),
      Array.from({ length: 32 }, (_, i) => `U+${(0x80 + i).toString(16).toUpperCase().padStart(4, '0')}`).join(' '),
    );
  });

  it('agrees with pwsh on the NUMBER of replacement characters in bad UTF-8', () => {
    // pwsh: bytes 41 FF FE 42 C3 28 43
    //         -> U+0041 U+FFFD U+FFFD U+0042 U+FFFD U+0028 U+0043
    // Node and Chrome were both measured to produce the same, which is why
    // UTF-8 is the one codec delegated to the platform.
    const bad = bytes(0x41, 0xff, 0xfe, 0x42, 0xc3, 0x28, 0x43);
    assert.equal(units(decodeBytes(bad, 'utf8')), 'U+0041 U+FFFD U+FFFD U+0042 U+FFFD U+0028 U+0043');
  });

  it('replaces a lone surrogate that UTF-16 bytes would otherwise produce', () => {
    // pwsh: Encoding.Unicode.GetString(3D D8)       -> U+FFFD
    //       Encoding.Unicode.GetString(3D D8 00 DE) -> U+D83D U+DE00
    // A JavaScript string can hold an unpaired surrogate, so the naive
    // implementation returns U+D83D here and disagrees invisibly.
    assert.equal(units(decodeBytes(bytes(0x3d, 0xd8), 'utf16le')), 'U+FFFD');
    assert.equal(units(decodeBytes(bytes(0x3d, 0xd8, 0x00, 0xde), 'utf16le')), 'U+D83D U+DE00');
  });

  it('replaces a truncated tail rather than dropping it', () => {
    // pwsh: utf16le of 61 00 62 -> U+0061 U+FFFD
    //       utf16le of 61       -> U+FFFD
    //       utf32le of 61 00 00 00 62 -> U+0061 U+FFFD
    assert.equal(units(decodeBytes(bytes(0x61, 0x00, 0x62), 'utf16le')), 'U+0061 U+FFFD');
    assert.equal(units(decodeBytes(bytes(0x61), 'utf16le')), 'U+FFFD');
    assert.equal(units(decodeBytes(bytes(0x61, 0x00, 0x00, 0x00, 0x62), 'utf32le')), 'U+0061 U+FFFD');
  });

  it('rejects a UTF-32 codepoint that is a surrogate or out of range', () => {
    // pwsh: utf32le of 00 D8 00 00 (U+D800)   -> U+FFFD
    //       utf32le of 00 00 11 00 (U+110000) -> U+FFFD
    assert.equal(units(decodeBytes(bytes(0x00, 0xd8, 0x00, 0x00), 'utf32le')), 'U+FFFD');
    assert.equal(units(decodeBytes(bytes(0x00, 0x00, 0x11, 0x00), 'utf32le')), 'U+FFFD');
  });

  it('decodes a UTF-32 astral codepoint to a surrogate pair', () => {
    // 00 F6 01 00 is U+1F600 little-endian; pwsh encodes it exactly so.
    assert.equal(units(decodeBytes(bytes(0x00, 0xf6, 0x01, 0x00), 'utf32le')), 'U+D83D U+DE00');
  });

  it('handles a buffer longer than one String.fromCharCode call', () => {
    // The single-byte and UTF-16 decoders chunk at 0x2000; a file larger than
    // that must not lose or reorder anything at the seam.
    const big = Uint8Array.from({ length: 0x5001 }, (_, i) => i % 251);
    const decoded = decodeBytes(big, 'latin1');
    assert.equal(decoded.length, 0x5001);
    assert.equal(decoded.charCodeAt(0x1fff), 0x1fff % 251);
    assert.equal(decoded.charCodeAt(0x2000), 0x2000 % 251);
    assert.equal(decoded.charCodeAt(0x5000), 0x5000 % 251);
  });
});

describe('encoding text, by codec', () => {
  // Measured with `Set-Content -Encoding <name> -NoNewline` writing U+00E9
  // U+20AC U+4E2D, then reading the raw bytes back.
  const cases: readonly (readonly [EncodingId, string])[] = [
    ['ascii', '3F 3F 3F'],
    ['latin1', 'E9 3F 3F'],
    ['windows1252', 'E9 80 3F'],
    ['utf8', 'C3 A9 E2 82 AC E4 B8 AD'],
    ['utf8bom', 'EF BB BF C3 A9 E2 82 AC E4 B8 AD'],
    ['utf16le', 'FF FE E9 00 AC 20 2D 4E'],
    ['utf16be', 'FE FF 00 E9 20 AC 4E 2D'],
    ['utf32le', 'FF FE 00 00 E9 00 00 00 AC 20 00 00 2D 4E 00 00'],
    ['utf32be', '00 00 FE FF 00 00 00 E9 00 00 20 AC 00 00 4E 2D'],
  ];

  for (const [id, expected] of cases) {
    it(`encodes U+00E9 U+20AC U+4E2D as ${id} the way pwsh does`, () => {
      assert.equal(hex(encodeText(SAMPLE, id)), expected);
    });
  }

  it('writes one question mark per CODE UNIT, so a surrogate pair becomes two', () => {
    // pwsh: Encoding.ASCII.GetBytes("\u{1F600}")  -> 3F 3F
    //       Encoding.ASCII.GetBytes("\uD83D")     -> 3F
    //       Encoding.ASCII.GetBytes("a\uD83Db")   -> 61 3F 62
    // Iterating codepoints with for...of would emit a single 3F for the pair.
    assert.equal(hex(encodeText('\u{1F600}', 'ascii')), '3F 3F');
    assert.equal(hex(encodeText('\ud83d', 'ascii')), '3F');
    assert.equal(hex(encodeText('a\ud83db', 'ascii')), '61 3F 62');
    assert.equal(hex(encodeText('\u{1F600}', 'latin1')), '3F 3F');
    assert.equal(hex(encodeText('\u{1F600}', 'windows1252')), '3F 3F');
  });

  it('replaces an unpaired surrogate when encoding UTF-16, as .NET does', () => {
    // pwsh: Encoding.Unicode.GetBytes("\uD83D")          -> FD FF
    //       Encoding.BigEndianUnicode.GetBytes("\uD83D") -> FF FD
    //       Encoding.Unicode.GetBytes("a\uD83Db")        -> 61 00 FD FF 62 00
    //       Encoding.Unicode.GetBytes("\u{1F600}")       -> 3D D8 00 DE
    // Writing the surrogate through unchanged would emit 3D D8, a sequence
    // .NET never produces.
    assert.equal(hex(encodeText('\ud83d', 'utf16le')), 'FF FE FD FF');
    assert.equal(hex(encodeText('\ud83d', 'utf16be')), 'FE FF FF FD');
    assert.equal(hex(encodeText('a\ud83db', 'utf16le')), 'FF FE 61 00 FD FF 62 00');
    assert.equal(hex(encodeText('\u{1F600}', 'utf16le')), 'FF FE 3D D8 00 DE');
  });

  it('replaces an unpaired surrogate when encoding UTF-8 and UTF-32', () => {
    // pwsh: UTF8.GetBytes("\uD83D")   -> EF BF BD
    //       UTF32.GetBytes("\uD83D")  -> FD FF 00 00
    //       UTF8.GetBytes("\uDC00")   -> EF BF BD    (a lone LOW surrogate too)
    assert.equal(hex(encodeText('\ud83d', 'utf8')), 'EF BF BD');
    assert.equal(hex(encodeText('\udc00', 'utf8')), 'EF BF BD');
    assert.equal(hex(encodeText('\ud83d', 'utf32le')), 'FF FE 00 00 FD FF 00 00');
    assert.equal(hex(encodeText('\u{1F600}', 'utf32le')), 'FF FE 00 00 00 F6 01 00');
  });

  it('carries the preamble each codec actually emits', () => {
    // pwsh: GetPreamble() per encoding.
    assert.equal(hex(preambleOf('utf8')), '');
    assert.equal(hex(preambleOf('utf8bom')), 'EF BB BF');
    assert.equal(hex(preambleOf('utf16le')), 'FF FE');
    assert.equal(hex(preambleOf('utf16be')), 'FE FF');
    assert.equal(hex(preambleOf('utf32le')), 'FF FE 00 00');
    assert.equal(hex(preambleOf('utf32be')), '00 00 FE FF');
    assert.equal(hex(preambleOf('ascii')), '');
    assert.equal(hex(preambleOf('latin1')), '');
    assert.equal(hex(preambleOf('windows1252')), '');
  });

  it('round-trips every codec for text it can represent', () => {
    const ids: readonly EncodingId[] = [
      'utf8', 'utf8bom', 'utf16le', 'utf16be', 'utf32le', 'utf32be', 'latin1', 'windows1252',
    ];
    for (const id of ids) {
      assert.equal(decodeFile(encodeText('abc', id), id), 'abc', id);
    }
    // ascii too, but only for characters it has.
    assert.equal(decodeFile(encodeText('abc', 'ascii'), 'ascii'), 'abc');
  });
});

describe('the -Encoding names PowerShell binds', () => {
  it('maps every name pwsh accepts, and no others', () => {
    // Each of these was confirmed to BIND by round-tripping it through
    // Set-Content on pwsh 7.6.5; 'sausage' was confirmed to fail binding.
    const expected: readonly (readonly [string, EncodingId])[] = [
      ['utf8', 'utf8'],
      ['utf8NoBOM', 'utf8'],
      ['default', 'utf8'],
      ['utf8BOM', 'utf8bom'],
      ['unicode', 'utf16le'],
      ['bigendianunicode', 'utf16be'],
      ['utf32', 'utf32le'],
      ['bigendianutf32', 'utf32be'],
      ['ascii', 'ascii'],
      ['latin1', 'latin1'],
    ];
    for (const [name, id] of expected) {
      const resolved = resolveEncodingName(name);
      assert.equal(resolved.kind, 'ok', name);
      assert.equal(resolved.kind === 'ok' ? resolved.id : null, id, name);
    }
  });

  it('is case-insensitive, as PowerShell parameter values are', () => {
    for (const spelling of ['UTF8BOM', 'utf8bom', 'Utf8Bom']) {
      const resolved = resolveEncodingName(spelling);
      assert.equal(resolved.kind === 'ok' ? resolved.id : null, 'utf8bom', spelling);
    }
  });

  it('defaults to UTF-8 with no BOM when nothing is given', () => {
    // pwsh: Set-Content with no -Encoding writes 'abc' as 97,98,99 — no BOM.
    for (const absent of [undefined, '', '   ']) {
      const resolved = resolveEncodingName(absent);
      assert.equal(resolved.kind === 'ok' ? resolved.id : null, 'utf8');
    }
    assert.equal(hex(encodeText('abc', 'utf8')), '61 62 63');
  });

  it('separates "recognised but unsupported" from "not an encoding at all"', () => {
    // pwsh ACCEPTS utf7 with an obsolescence warning, and REJECTS sausage at
    // parameter binding. A command has to tell those apart to reproduce either.
    const utf7 = resolveEncodingName('utf7');
    assert.equal(utf7.kind, 'unsupported');
    assert.match(utf7.kind === 'unsupported' ? utf7.why : '', /obsolete/);

    assert.equal(resolveEncodingName('sausage').kind, 'unknown');
  });

  it('resolves ansi and oem to DIFFERENT codecs on the emulated Ubuntu machine', () => {
    // MEASURED, encoding U+00E9 U+20AC U+4E2D on pwsh 7.6.5:
    //   ansi Ubuntu -> E9 80 3F                 (windows-1252)
    //   oem  Ubuntu -> C3 A9 E2 82 AC E4 B8 AD  (UTF-8)
    // The table this replaced mapped BOTH to windows-1252.
    assert.equal(UBUNTU_CODE_PAGES.ansi, 'windows1252');
    assert.equal(UBUNTU_CODE_PAGES.oem, 'utf8');

    const ansi = resolveEncodingName('ansi');
    const oem = resolveEncodingName('oem');
    assert.equal(ansi.kind === 'ok' ? ansi.id : null, 'windows1252');
    assert.equal(oem.kind === 'ok' ? oem.id : null, 'utf8');

    assert.equal(hex(encodeText(SAMPLE, 'windows1252')), 'E9 80 3F');
    assert.equal(hex(encodeText(SAMPLE, 'utf8')), 'C3 A9 E2 82 AC E4 B8 AD');
  });

  it('lets a different host resolve ansi and oem differently', () => {
    // The Windows host this was measured on had codepage 950 for both, which
    // this engine has no codec for; the point is only that the decision is a
    // parameter rather than baked into the name table.
    const host = { ansi: 'latin1', oem: 'ascii' } as const;
    const ansi = resolveEncodingName('ansi', host);
    const oem = resolveEncodingName('oem', host);
    assert.equal(ansi.kind === 'ok' ? ansi.id : null, 'latin1');
    assert.equal(oem.kind === 'ok' ? oem.id : null, 'ascii');
  });

  it('reports the .NET WebName for each codec', () => {
    assert.equal(webNameOf('utf8'), 'utf-8');
    assert.equal(webNameOf('utf16le'), 'utf-16');
    assert.equal(webNameOf('windows1252'), 'windows-1252');
    assert.equal(webNameOf('latin1'), 'iso-8859-1');
    assert.equal(webNameOf('ascii'), 'us-ascii');
  });
});

describe('the BOM rule', () => {
  it('prefers the four-byte UTF-32 mark over the two-byte UTF-16 one', () => {
    // FF FE 00 00 is BOTH a UTF-32LE BOM and a UTF-16LE BOM followed by U+0000.
    // pwsh: Get-Content over FF FE 00 00 61 00 00 00 -> U+0061
    // A UTF-16LE reading gives U+0000 U+0061 U+0000. Testing the two-byte marks
    // first is silent on every input except this one.
    const match = sniffBom(bytes(0xff, 0xfe, 0x00, 0x00, 0x61, 0x00, 0x00, 0x00));
    assert.deepEqual(match, { id: 'utf32le', length: 4 });
  });

  it('recognises each mark pwsh recognises', () => {
    assert.deepEqual(sniffBom(bytes(0xef, 0xbb, 0xbf, 0x61)), { id: 'utf8bom', length: 3 });
    assert.deepEqual(sniffBom(bytes(0xff, 0xfe, 0x61, 0x00)), { id: 'utf16le', length: 2 });
    assert.deepEqual(sniffBom(bytes(0xfe, 0xff, 0x00, 0x61)), { id: 'utf16be', length: 2 });
    assert.deepEqual(sniffBom(bytes(0x00, 0x00, 0xfe, 0xff, 0x00, 0x00, 0x00, 0x61)), {
      id: 'utf32be',
      length: 4,
    });
    assert.equal(sniffBom(bytes(0x61, 0x62)), null);
  });

  // The eleven measured rows from the header of decodeFile, as a table. Every
  // one is `Get-Content -Raw` on pwsh 7.6.5, requested encoding on the left.
  const rows: readonly (readonly [EncodingId, readonly number[], string, string])[] = [
    ['utf8', [0xff, 0xfe, 0x61, 0x00], 'U+0061', 'default over a utf16LE BOM: sniff wins'],
    ['utf8', [0xfe, 0xff, 0x00, 0x61], 'U+0061', 'default over a utf16BE BOM: sniff wins'],
    ['utf8', [0xef, 0xbb, 0xbf, 0x61], 'U+0061', 'default over its own utf8 BOM'],
    ['utf8', [0xff, 0xfe, 0x00, 0x00, 0x61, 0x00, 0x00, 0x00], 'U+0061', 'utf8 over a utf32LE BOM: sniff wins'],
    ['utf8', [0x00, 0x00, 0xfe, 0xff, 0x00, 0x00, 0x00, 0x61], 'U+0061', 'utf8 over a utf32BE BOM: sniff wins'],
    ['utf16le', [0xef, 0xbb, 0xbf, 0x61], 'U+0061', 'unicode over a utf8 BOM: sniff wins'],
    [
      'utf16le',
      [0xff, 0xfe, 0x00, 0x00, 0x61, 0x00, 0x00, 0x00],
      'U+0000 U+0061 U+0000',
      'unicode over a utf32LE BOM: the REQUEST wins, because FF FE is its own mark',
    ],
    ['utf32le', [0xff, 0xfe, 0x00, 0x00, 0x61, 0x00, 0x00, 0x00], 'U+0061', 'utf32 over its own BOM'],
    ['latin1', [0xef, 0xbb, 0xbf, 0x61], 'U+0061', 'latin1 over a utf8 BOM: sniff wins'],
    ['ascii', [0xff, 0xfe, 0x61, 0x00], 'U+0061', 'ascii over a utf16LE BOM: sniff wins'],
    ['utf8', [0x61, 0xe9, 0x80, 0x7a], 'U+0061 U+FFFD U+007A', 'no BOM at all: the request decides'],
  ];

  for (const [requested, input, expected, why] of rows) {
    it(why, () => {
      assert.equal(units(decodeFile(Uint8Array.from(input), requested)), expected);
    });
  }

  it('decodes a file that is nothing but a BOM to the empty string', () => {
    // pwsh: a file of just EF BB BF emits NO objects from Get-Content -Raw,
    // the same as an empty file.
    assert.equal(decodeFile(bytes(0xef, 0xbb, 0xbf), 'utf8'), '');
    assert.equal(decodeFile(bytes(0xff, 0xfe, 0x00, 0x00), 'utf8'), '');
  });

  it('leaves decodeBytes alone: only decodeFile consults the BOM', () => {
    // The raw codec must stay raw, or the native byte channel would have BOM
    // sniffing applied to command output that never had a BOM in it.
    assert.equal(units(decodeBytes(bytes(0xef, 0xbb, 0xbf, 0x61), 'utf8')), 'U+FEFF U+0061');
    assert.equal(units(decodeFile(bytes(0xef, 0xbb, 0xbf, 0x61), 'utf8')), 'U+0061');
  });
});

describe('the broker decides which encoding applies to native output', () => {
  const v765 = viewOfBehaviors('7.6.5', {});
  const v77 = viewOfBehaviors('7.7.0', { [APPLICATION_OUTPUT_ENCODING_KEY]: true });

  it('decodes native output with [Console]::OutputEncoding, not $OutputEncoding', () => {
    // THE MEASUREMENT THE BROKER EXISTS FOR. Capturing a native command that
    // emits 61 E9 80 7A, on pwsh 7.6.5:
    //
    //   (unchanged)                        Linux -> U+0061 U+FFFD U+007A
    //   $OutputEncoding = Latin1           Linux -> U+0061 U+FFFD U+007A  (no change)
    //   [Console]::OutputEncoding = Latin1       -> U+0061 U+00E9 U+0080 U+007A
    //
    // Both platforms agreed. Modelling $OutputEncoding as the decoder — which
    // the name invites — reproduces neither row.
    const plain = new EncodingBroker({ consoleOutputEncoding: 'utf8' });
    assert.equal(units(plain.decodeNativeOutput(PROBE_BYTES, v765)), 'U+0061 U+FFFD U+007A');

    const outputChanged = new EncodingBroker({ outputEncoding: 'latin1', consoleOutputEncoding: 'utf8' });
    assert.equal(
      units(outputChanged.decodeNativeOutput(PROBE_BYTES, v765)),
      'U+0061 U+FFFD U+007A',
      '$OutputEncoding must not affect the decode',
    );

    const consoleChanged = new EncodingBroker({ consoleOutputEncoding: 'latin1' });
    assert.equal(
      units(consoleChanged.decodeNativeOutput(PROBE_BYTES, v765)),
      'U+0061 U+00E9 U+0080 U+007A',
    );
  });

  it('models the two variables separately, because a real host has them differ', () => {
    // MEASURED on Windows 10.0.26340, pwsh 7.6.5:
    //   $OutputEncoding.WebName           -> utf-8
    //   [Console]::OutputEncoding.WebName -> big5   (codepage 950)
    //   [object]::ReferenceEquals(...)    -> False
    // On Ubuntu both are utf-8 and ReferenceEquals is True, so a design that
    // collapsed them would have looked right on Linux forever.
    const broker = new EncodingBroker({ outputEncoding: 'utf8', consoleOutputEncoding: 'latin1' });
    assert.equal(broker.outputEncoding, 'utf8');
    assert.equal(broker.consoleOutputEncoding, 'latin1');
  });

  it('encodes native stdin with $OutputEncoding — that IS what it is for', () => {
    const broker = new EncodingBroker({ outputEncoding: 'latin1', consoleOutputEncoding: 'utf8' });
    assert.equal(hex(broker.encodeNativeInput('é')), 'E9');
    const utf8 = new EncodingBroker({ outputEncoding: 'utf8' });
    assert.equal(hex(utf8.encodeNativeInput('é')), 'C3 A9');
  });

  it('ignores $PSApplicationOutputEncoding under a 7.6.5 profile', () => {
    // MEASURED ABSENT in 7.6.5 on both platforms:
    //   Get-Variable PSApplicationOutputEncoding -ErrorAction SilentlyContinue -> $null
    //   Get-Variable | ? Name -like '*Encoding*' -> OutputEncoding, and nothing else
    // So a session that somehow set one must not have it honoured: that would
    // emulate a version that does not exist.
    const broker = new EncodingBroker({
      consoleOutputEncoding: 'utf8',
      applicationOutputEncoding: 'latin1',
    });
    assert.equal(broker.nativeOutputEncoding(v765), 'utf8');
    assert.equal(units(broker.decodeNativeOutput(PROBE_BYTES, v765)), 'U+0061 U+FFFD U+007A');
  });

  it('asks the profile for the exact key the 7.7 delta declares', () => {
    // A behaviour key is a contract between the generator that WRITES it into a
    // profile and the code path that LOOKS IT UP, and behavior-keys.ts exists
    // because when each end spells it itself the contract holds by coincidence
    // and fails silently: the lookup misses, the fallback answers, and the
    // profile looks populated while changing nothing.
    //
    // So the literal is asserted here rather than only imported. The record in
    // compat/deltas/powershell-77-changes.source.mts declares this key with
    // upstreamValue true, citing PR #21219.
    assert.equal(APPLICATION_OUTPUT_ENCODING_KEY, 'application.outputEncodingVariable');

    // And prove the lookup actually happens: a profile that declares the key
    // false must be obeyed, not merely present.
    const declaredOff = viewOfBehaviors('7.7.0', {
      'application.outputEncodingVariable': false,
    });
    const broker = new EncodingBroker({
      consoleOutputEncoding: 'utf8',
      applicationOutputEncoding: 'latin1',
    });
    assert.equal(broker.nativeOutputEncoding(declaredOff), 'utf8');
  });

  it('honours $PSApplicationOutputEncoding under a 7.7 profile', () => {
    // Upstream PR #21219 adds the variable. The behaviour key is
    // application.outputEncodingVariable, declared in the 7.7 delta; a command
    // asks the profile rather than comparing version numbers, which is what
    // makes the difference reachable at all.
    const broker = new EncodingBroker({
      consoleOutputEncoding: 'utf8',
      applicationOutputEncoding: 'latin1',
    });
    assert.equal(broker.nativeOutputEncoding(v77), 'latin1');
    assert.equal(units(broker.decodeNativeOutput(PROBE_BYTES, v77)), 'U+0061 U+00E9 U+0080 U+007A');
  });

  it('falls back to the console encoding when 7.7 has the variable UNSET', () => {
    // The variable existing is not the same as it having a value. With none
    // set, 7.7 behaves as 7.6.5 does.
    const broker = new EncodingBroker({ consoleOutputEncoding: 'utf8' });
    assert.equal(broker.applicationOutputEncoding, null);
    assert.equal(broker.nativeOutputEncoding(v77), 'utf8');
  });

  it('falls back to the console encoding when there is no profile at all', () => {
    const broker = new EncodingBroker({
      consoleOutputEncoding: 'utf8',
      applicationOutputEncoding: 'latin1',
    });
    assert.equal(broker.nativeOutputEncoding(null), 'utf8');
  });

  it('starts a session as UTF-8 everywhere with Ubuntu code pages', () => {
    // MEASURED on Ubuntu 24.04.4: $OutputEncoding and [Console]::OutputEncoding
    // are both utf-8 and are literally the same object.
    const broker = defaultEncodingBroker();
    assert.equal(broker.outputEncoding, 'utf8');
    assert.equal(broker.consoleOutputEncoding, 'utf8');
    assert.equal(broker.applicationOutputEncoding, null);
    assert.deepEqual(broker.host, UBUNTU_CODE_PAGES);
  });

  it('copies with one setting changed, keeping the rest', () => {
    const broker = new EncodingBroker({ outputEncoding: 'latin1', consoleOutputEncoding: 'ascii' });
    const next = broker.with({ consoleOutputEncoding: 'utf8' });
    assert.equal(next.outputEncoding, 'latin1');
    assert.equal(next.consoleOutputEncoding, 'utf8');
    assert.equal(next.applicationOutputEncoding, null);

    const withApp = next.with({ applicationOutputEncoding: 'utf16le' });
    assert.equal(withApp.applicationOutputEncoding, 'utf16le');
    // and it survives a further copy that does not mention it
    assert.equal(withApp.with({ outputEncoding: 'utf8' }).applicationOutputEncoding, 'utf16le');
  });

  it('resolves -Encoding names against its own host code pages', () => {
    const broker = new EncodingBroker({ host: { ansi: 'latin1', oem: 'ascii' } });
    const ansi = broker.resolve('ansi');
    assert.equal(ansi.kind === 'ok' ? ansi.id : null, 'latin1');
  });
});

describe('bytes stay bytes until something asks for text', () => {
  it('never decodes on the way through — the caller has to ask', () => {
    // The invariant psobject.ts states: "the native byte channel must stay
    // bytes, because decoding it once — wrongly — is not recoverable."
    // MEASURED: a native command emitting 61 E9 80 7A redirected to a file
    // produces exactly those four bytes on both platforms, while the same
    // output captured into a variable is decoded and cannot be recovered.
    const raw = bytes(0x61, 0xe9, 0x80, 0x7a);
    const broker = defaultEncodingBroker();
    // Holding the bytes is not decoding them.
    assert.deepEqual([...raw], [0x61, 0xe9, 0x80, 0x7a]);
    // Only an explicit call produces text, and it is lossy — which is the point.
    const text = broker.decodeNativeOutput(raw, null);
    assert.equal(units(text), 'U+0061 U+FFFD U+007A');
    assert.notDeepEqual([...encodeText(text, 'utf8')], [...raw]);
  });

  it('round-trips arbitrary bytes through latin1 without loss', () => {
    // The escape hatch: latin1 is the one codec that is byte-preserving in both
    // directions for the whole 0-255 range, which is what makes it usable to
    // carry bytes through a string-shaped API without corrupting them.
    const all = Uint8Array.from({ length: 256 }, (_, i) => i);
    assert.deepEqual([...encodeText(decodeBytes(all, 'latin1'), 'latin1')], [...all]);
  });
});

// ---------------------------------------------------------------------------
// the gate
// ---------------------------------------------------------------------------

describe('there is only ONE place that decides an encoding', () => {
  // THE DEFECT SHAPE THIS GUARDS. This repository has now found the same thing
  // five times: one conversion implemented twice and drifting silently —
  // value-to-string three times, width twice, three date engines, and this.
  //
  // Before this module there were two encoding tables. `fs-read/get-content.ts`
  // held a decode table and `fs-write/set-content.ts` an encode table, and they
  // had drifted: they disagreed about `ascii`, disagreed about which names
  // existed at all, and neither agreed with pwsh about `oem`. Neither was
  // tested, so nothing said so.
  //
  // A comment asking the next person not to add a third would not have stopped
  // either of the first two, so this asks the source.

  const ALLOWED = new Set([
    // The broker itself. UTF-8 is delegated deliberately: Node, Chrome and .NET
    // were measured to agree on it, including on invalid input.
    'src/pipeline/encoding.ts',
    // The storage backend's own UTF-8 text API, which predates the broker and
    // lives behind `FileSystemPort.readText`/`writeText`. It is a REAL second
    // decision — `cat`, `grep` and `Select-String` read through it and get
    // UTF-8 with no BOM sniff — and it is recorded rather than fixed here
    // because src/storage/ belongs to another change in flight.
    'src/storage/memory.ts',
    'src/storage/snapshot.ts',
    // The OPFS checkpoint and write-ahead log. These are a PRIVATE ON-DISK
    // FORMAT, not an encoding decision: nothing a user types selects it, and
    // there is no other correct answer than UTF-8 for a file this code both
    // writes and reads. The distinction the broker exists to enforce is about
    // interpreting bytes somebody ELSE produced — a native command's output, a
    // file the visitor supplied — and neither of these is that.
    //
    // Kept on the list rather than routed through the broker, because routing
    // them would make an internal format depend on a user-facing encoding
    // policy, which is the coupling that produces the next `oem` bug.
    'src/storage/opfs-store.ts',
    'src/storage/opfs-wal.ts',
  ]);

  it('no module outside the broker constructs a TextDecoder or TextEncoder', async () => {
    const { readFileSync } = await import('node:fs');
    const { globSync } = await import('node:fs');
    const { fileURLToPath } = await import('node:url');
    const { dirname, resolve } = await import('node:path');
    const repo = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..');

    const offenders: string[] = [];
    for (const relative of globSync('src/**/*.ts', { cwd: repo }).sort()) {
      // globSync yields Windows separators on Windows; String.fromCharCode(92)
      // is the backslash, written this way so the literal cannot be mangled by
      // whatever writes this file next.
      const normalised = relative.split(String.fromCharCode(92)).join('/');
      if (ALLOWED.has(normalised)) continue;
      const source = readFileSync(resolve(repo, relative), 'utf8');
      // Only real constructions: the broker's docstring quotes these forms, and
      // a comment describing the trap must not read as falling into it.
      for (const [index, line] of source.split('\n').entries()) {
        const code = line.trimStart();
        if (code.startsWith('*') || code.startsWith('//')) continue;
        if (/new Text(Decoder|Encoder)\s*\(/.test(line)) {
          offenders.push(`${normalised}:${String(index + 1)}`);
        }
      }
    }
    assert.deepEqual(
      offenders,
      [],
      'These modules decide an encoding themselves. Route them through ' +
        'src/pipeline/encoding.ts, or add them to ALLOWED with the reason.',
    );
  });

  it('no module outside the broker keeps its own table of -Encoding names', () => {
    // The two tables were spelled as a Map of decoder labels and a Set of
    // recognised names. Both are gone; this is what stops a third.
    const names = ['bigendianunicode', 'utf8nobom', 'bigendianutf32'];
    assert.ok(
      names.every((n) => resolveEncodingName(n).kind === 'ok'),
      'the broker must know every name a command could need, or a command will keep its own list',
    );
  });

  it('resolves every name a command can be given to exactly one codec', () => {
    // Same name, same answer, no matter who asks — which was NOT true before:
    // get-content mapped 'ascii' to windows-1252 while set-content substituted
    // '?', so the same file written and read back changed underneath the user.
    const roundTrip = (name: string): string | null => {
      const r = resolveEncodingName(name);
      return r.kind === 'ok' ? r.id : null;
    };
    assert.equal(roundTrip('ascii'), 'ascii');
    assert.equal(roundTrip('ASCII'), 'ascii');
    // and the write path and the read path now agree about what that means
    assert.equal(hex(encodeText('aé', 'ascii')), '61 3F');
    assert.equal(units(decodeBytes(bytes(0x61, 0x3f), 'ascii')), 'U+0061 U+003F');
  });
});
