/**
 * encoding.ts — the ONE place that decides an encoding, and the ONE place that
 * applies it.
 *
 * `psobject.ts` says why the native byte channel is modelled as `Uint8Array`:
 * "the native byte channel must stay bytes, because decoding it once — wrongly —
 * is not recoverable." That states the invariant. This file is what keeps it:
 * bytes stay bytes until a caller ASKS for text, and when it asks, exactly one
 * table decides what the bytes mean.
 *
 * ---------------------------------------------------------------------------
 * WHY THE CODECS ARE HAND-ROLLED INSTEAD OF DELEGATED TO TextDecoder
 * ---------------------------------------------------------------------------
 *
 * Because `TextDecoder` is not the same function in the two runtimes this
 * project targets. Measured, same code, same label, same reported `.encoding`:
 *
 *   new TextDecoder('windows-1252').decode(new Uint8Array([0x80]))
 *     node 24.13.0 (ICU 77.1, full-icu)  ->  U+0080
 *     Chrome 152                         ->  U+20AC
 *
 * The whole 0x80-0x9F range differs: Node returns the ISO-8859-1 identity
 * mapping, Chrome returns the WHATWG windows-1252 index. Both call themselves
 * `windows-1252`. So a test suite running under Node would have pinned one
 * answer while the shipped browser produced the other, and nothing would have
 * said so — the exact shape of defect this repository has now found five times.
 *
 * Which one is right? Measured against the reference implementation, pwsh 7.6.5
 * on Ubuntu 24.04.4 — the platform the compatibility profile targets and the
 * platform the conformance fixture was captured on:
 *
 *   [System.Text.Encoding]::GetEncoding(1252).GetString([byte[]](0x80..0x9F))
 *     -> U+20AC U+0081 U+201A U+0192 U+201E U+2026 U+2020 U+2021 ...
 *
 * Chrome is right and Node is wrong. Delegating would therefore have been wrong
 * in the test suite and right in production, which is worse than being wrong in
 * both. WINDOWS_1252_HIGH below is that measured table, and it is the same
 * sequence .NET, Chrome and the WHATWG index all produce.
 *
 * The three WHATWG label traps, all measured, none of them survivable:
 *
 *   TextDecoder('latin1').encoding      -> 'windows-1252'   (NOT ISO-8859-1)
 *   TextDecoder('iso-8859-1').encoding  -> 'windows-1252'
 *   TextDecoder('ascii').encoding       -> 'windows-1252'
 *
 * All three are aliases of one decoder, and PowerShell means three different
 * things by those names. `-Encoding ascii` in pwsh maps every byte >= 0x80 to
 * `?`; `-Encoding latin1` maps byte to codepoint. Neither is windows-1252.
 *
 * UTF-8 is the exception and is delegated: Node and Chrome were measured to
 * agree with each other and with .NET on invalid input, including the
 * replacement-character COUNT, which is the part naive implementations get
 * wrong.
 *
 *   bytes 41 FF FE 42 C3 28 43
 *     pwsh 7.6.5   -> U+0041 U+FFFD U+FFFD U+0042 U+FFFD U+0028 U+0043
 *     node/Chrome  -> U+0041 U+FFFD U+FFFD U+0042 U+FFFD U+0028 U+0043
 *
 * ---------------------------------------------------------------------------
 * THE MEASURED SEMANTICS THIS FILE ENCODES
 * ---------------------------------------------------------------------------
 *
 * Every number below was read off pwsh 7.6.5 rather than assumed. The probe
 * scripts and their output are quoted at each site.
 *
 *   1. `$OutputEncoding` DOES NOT DECODE NATIVE OUTPUT. This is the single most
 *      important fact here and it is the reason 7.7 needed a new variable at
 *      all. Measured on both platforms, capturing a native command that emits
 *      the bytes 61 E9 80 7A:
 *
 *        (unchanged)                     Linux -> U+0061 U+FFFD U+007A
 *        $OutputEncoding = Latin1        Linux -> U+0061 U+FFFD U+007A   (no change)
 *        [Console]::OutputEncoding = Latin1    -> U+0061 U+00E9 U+0080 U+007A
 *
 *      `$OutputEncoding` is the ENCODER for text PowerShell pipes INTO a native
 *      command's stdin. `[Console]::OutputEncoding` is what decodes what comes
 *      back. Modelling `$OutputEncoding` as the decoder — which reads as the
 *      obvious thing, given the name — reproduces neither measurement.
 *
 *   2. THE TWO VARIABLES GENUINELY DIVERGE IN PRACTICE. On the Windows host
 *      this was measured on, they are not even the same object:
 *
 *        $OutputEncoding.WebName            -> utf-8
 *        [Console]::OutputEncoding.WebName  -> big5      (codepage 950)
 *        [object]::ReferenceEquals(...)     -> False
 *
 *      On Ubuntu both are utf-8 and ReferenceEquals is True. A design that
 *      collapsed them would have looked correct on Linux forever.
 *
 *   3. A BOM OVERRIDES `-Encoding`, WITH ONE EXCEPTION, AND THE EXCEPTION IS
 *      DERIVABLE. Eleven cases were measured; a single rule reproduces all
 *      eleven — see `decodeFile`.
 *
 *   4. `ansi` AND `oem` ARE PLATFORM-DEPENDENT AND ARE NOT THE SAME. Measured
 *      encoding the string U+00E9 U+20AC U+4E2D:
 *
 *        ansi   Ubuntu -> E9 80 3F                    (windows-1252)
 *        ansi   Windows(cp950 host) -> 65 A3 E1 A4 A4 (big5)
 *        oem    Ubuntu -> C3 A9 E2 82 AC E4 B8 AD     (UTF-8)
 *        oem    Windows(cp950 host) -> 65 A3 E1 A4 A4 (big5)
 *
 *      So on Linux `ansi` and `oem` are DIFFERENT encodings, and the emulated
 *      machine is Ubuntu. The pre-existing table in `fs-read/get-content.ts`
 *      mapped both to windows-1252, which was right for `ansi` and wrong for
 *      `oem`.
 */

import type { CompatibilityView } from '../commands/invocation.ts';

// ---------------------------------------------------------------------------
// the encodings, as identities rather than labels
// ---------------------------------------------------------------------------

/**
 * A codec this engine can actually perform, byte-exactly.
 *
 * Deliberately NOT the PowerShell parameter names: several of those are aliases
 * for the same codec (`utf8`, `utf8NoBOM` and `default` are one thing) and two
 * of them (`ansi`, `oem`) resolve differently per platform. Keeping the codec
 * identity apart from the spelling is what lets `resolveEncodingName` be the
 * only place a platform decision is made.
 */
export type EncodingId =
  | 'utf8'
  | 'utf8bom'
  | 'utf16le'
  | 'utf16be'
  | 'utf32le'
  | 'utf32be'
  | 'ascii'
  | 'latin1'
  | 'windows1252';

/** The byte-order marks each codec WRITES, measured via `Encoding.GetPreamble()`. */
const PREAMBLE: Readonly<Record<EncodingId, readonly number[]>> = {
  utf8: [],
  utf8bom: [0xef, 0xbb, 0xbf],
  utf16le: [0xff, 0xfe],
  utf16be: [0xfe, 0xff],
  utf32le: [0xff, 0xfe, 0x00, 0x00],
  utf32be: [0x00, 0x00, 0xfe, 0xff],
  ascii: [],
  latin1: [],
  windows1252: [],
};

/** `Encoding.WebName` for each codec, for error messages and Get-Member-ish output. */
const WEB_NAME: Readonly<Record<EncodingId, string>> = {
  utf8: 'utf-8',
  utf8bom: 'utf-8',
  utf16le: 'utf-16',
  utf16be: 'utf-16BE',
  utf32le: 'utf-32',
  utf32be: 'utf-32BE',
  ascii: 'us-ascii',
  latin1: 'iso-8859-1',
  windows1252: 'windows-1252',
};

export function webNameOf(id: EncodingId): string {
  return WEB_NAME[id];
}

export function preambleOf(id: EncodingId): Uint8Array {
  return Uint8Array.from(PREAMBLE[id]);
}

/**
 * The windows-1252 high range, 0x80-0x9F.
 *
 * MEASURED three ways and identical in all three: pwsh 7.6.5 on Ubuntu via
 * `[System.Text.Encoding]::GetEncoding(1252)`, the same via `Get-Content
 * -Encoding ansi`, and Chrome 152's `TextDecoder('windows-1252')`. Node
 * disagrees with all three, which is why this table is written out.
 *
 * 0xA0-0xFF is the identity mapping — measured `GetEncoding(1252)` and
 * `Encoding.Latin1` produce byte-identical output across that whole range — so
 * only the 32 exceptional entries are stored.
 */
const WINDOWS_1252_HIGH: readonly number[] = [
  0x20ac, 0x0081, 0x201a, 0x0192, 0x201e, 0x2026, 0x2020, 0x2021,
  0x02c6, 0x2030, 0x0160, 0x2039, 0x0152, 0x008d, 0x017d, 0x008f,
  0x0090, 0x2018, 0x2019, 0x201c, 0x201d, 0x2022, 0x2013, 0x2014,
  0x02dc, 0x2122, 0x0161, 0x203a, 0x0153, 0x009d, 0x017e, 0x0178,
];

/** The reverse map, built once. Codepoints that windows-1252 can represent. */
const WINDOWS_1252_REVERSE: ReadonlyMap<number, number> = (() => {
  const map = new Map<number, number>();
  for (let i = 0; i < WINDOWS_1252_HIGH.length; i += 1) {
    const codepoint = WINDOWS_1252_HIGH[i];
    if (codepoint !== undefined) map.set(codepoint, 0x80 + i);
  }
  return map;
})();

/**
 * What .NET substitutes for a character an encoding cannot represent.
 *
 * MEASURED: `Encoding.ASCII.GetBytes('é')` is `3F`, and so is
 * `Encoding.Latin1.GetBytes('€')` and `GetEncoding(1252).GetBytes('中')`. It is
 * the literal question mark, not U+FFFD.
 */
const QUESTION_MARK = 0x3f;

/** U+FFFD, what a DECODER substitutes for input it cannot represent. */
const REPLACEMENT = 0xfffd;

// ---------------------------------------------------------------------------
// PowerShell's `-Encoding` names
// ---------------------------------------------------------------------------

/**
 * How a `-Encoding` argument resolves.
 *
 * `unsupported` is a real and separate answer from `unknown`, and conflating
 * them was one of the divergences between the two tables this file replaces.
 * pwsh ACCEPTS `-Encoding utf7` (with an obsolescence warning) and REJECTS
 * `-Encoding sausage` at parameter binding with a transformation error. A
 * command has to be able to tell those apart to reproduce either.
 */
export type EncodingResolution =
  | { readonly kind: 'ok'; readonly id: EncodingId; readonly name: string }
  | { readonly kind: 'unsupported'; readonly name: string; readonly why: string }
  | { readonly kind: 'unknown'; readonly name: string };

/**
 * The host platform whose ANSI and OEM code pages `ansi`/`oem` follow.
 *
 * A parameter rather than a constant because it is the ONLY platform-dependent
 * thing in this file, and because the divergence is real: `oem` is UTF-8 on
 * Ubuntu and big5 on the Windows host this was measured on. The emulated
 * machine is Ubuntu — `fs-write/set-content.ts` says so and the conformance
 * fixture records `"os": "Ubuntu 24.04.4 LTS"` — so that is the default.
 */
export interface HostCodePages {
  /** What `-Encoding ansi` means. MEASURED on Ubuntu: windows-1252. */
  readonly ansi: EncodingId;
  /** What `-Encoding oem` means. MEASURED on Ubuntu: UTF-8, NOT windows-1252. */
  readonly oem: EncodingId;
}

/** The emulated machine. Measured, not assumed — see the header, point 4. */
export const UBUNTU_CODE_PAGES: HostCodePages = { ansi: 'windows1252', oem: 'utf8' };

/**
 * Every `-Encoding` name pwsh 7.6.5 BINDS, and what this engine does with it.
 *
 * The names were confirmed to bind by round-tripping each through
 * `Set-Content -Encoding <name>`; `sausage` was confirmed to fail binding with
 * ParameterArgumentTransformationError / InvalidData.
 *
 * `utf7` binds in pwsh (emitting "Encoding 'UTF-7' is obsolete, please use
 * UTF-8") but is not implemented here. Refusing it by name is a smaller lie
 * than decoding modified-base64 wrongly, and it is the answer pwsh itself is
 * steering callers away from.
 */
export function resolveEncodingName(
  raw: string | undefined,
  host: HostCodePages = UBUNTU_CODE_PAGES,
): EncodingResolution {
  if (raw === undefined || raw.trim() === '') {
    // PowerShell 7's default is utf8NoBOM everywhere. Measured: `Set-Content`
    // with no -Encoding writes 'abc' as 97,98,99 with no preamble.
    return { kind: 'ok', id: 'utf8', name: 'utf8NoBOM' };
  }
  const name = raw.trim();
  switch (name.toLowerCase()) {
    case 'utf8':
    case 'utf8nobom':
    case 'default':
      return { kind: 'ok', id: 'utf8', name };
    case 'utf8bom':
      return { kind: 'ok', id: 'utf8bom', name };
    case 'unicode':
      return { kind: 'ok', id: 'utf16le', name };
    case 'bigendianunicode':
      return { kind: 'ok', id: 'utf16be', name };
    case 'utf32':
      return { kind: 'ok', id: 'utf32le', name };
    case 'bigendianutf32':
      return { kind: 'ok', id: 'utf32be', name };
    case 'ascii':
      return { kind: 'ok', id: 'ascii', name };
    case 'latin1':
      return { kind: 'ok', id: 'latin1', name };
    case 'ansi':
      return { kind: 'ok', id: host.ansi, name };
    case 'oem':
      return { kind: 'ok', id: host.oem, name };
    case 'utf7':
      return {
        kind: 'unsupported',
        name,
        why:
          'UTF-7 is modified base64, not a byte mapping, and PowerShell itself reports it as ' +
          "obsolete when it is used ('Encoding \"UTF-7\" is obsolete, please use UTF-8'). " +
          'It is recognised here so that it fails as a named limitation rather than as an ' +
          'unknown encoding.',
      };
    default:
      return { kind: 'unknown', name };
  }
}

/** The names `resolveEncodingName` accepts, for error messages. */
export const RECOGNISED_ENCODING_NAMES: readonly string[] = [
  'ascii', 'ansi', 'bigendianunicode', 'bigendianutf32', 'oem', 'unicode',
  'utf7', 'utf8', 'utf8BOM', 'utf8NoBOM', 'utf32', 'latin1', 'default',
];

// ---------------------------------------------------------------------------
// decoding
// ---------------------------------------------------------------------------

/**
 * UTF-8 is the one codec delegated to the platform.
 *
 * `fatal: false` and `ignoreBOM: true` are both deliberate. Replacement rather
 * than throwing is what pwsh does — measured, invalid input yields U+FFFD and
 * no error. `ignoreBOM: true` stops TextDecoder consuming a leading BOM behind
 * this module's back: BOM handling is `decodeFile`'s decision and has to happen
 * in one place, not two. `decodeBytes` is the RAW codec.
 */
const UTF8_DECODER = new TextDecoder('utf-8', { fatal: false, ignoreBOM: true });
const UTF8_ENCODER = new TextEncoder();

/**
 * Decode bytes with a known codec. No BOM handling — see `decodeFile` for that.
 *
 * Every branch below reproduces a measured pwsh answer for the byte sequence
 * `61 E9 80 7A`:
 *
 *   utf8         U+0061 U+FFFD U+007A
 *   ascii        U+0061 U+003F U+003F U+007A     <- '?', not windows-1252
 *   latin1       U+0061 U+00E9 U+0080 U+007A     <- byte == codepoint
 *   windows1252  U+0061 U+00E9 U+20AC U+007A     <- 0x80 is the euro sign
 *   utf16le      U+E961 U+7A80
 *   utf16be      U+61E9 U+807A
 *   utf32le      U+FFFD
 *
 * The three single-byte answers being three DIFFERENT strings is the point: the
 * table this replaced returned the windows-1252 row for all three names.
 */
export function decodeBytes(bytes: Uint8Array, id: EncodingId): string {
  switch (id) {
    case 'utf8':
    case 'utf8bom':
      return UTF8_DECODER.decode(bytes);
    case 'ascii':
      return decodeSingleByte(bytes, (b) => (b < 0x80 ? b : QUESTION_MARK));
    case 'latin1':
      return decodeSingleByte(bytes, (b) => b);
    case 'windows1252':
      return decodeSingleByte(bytes, (b) =>
        b < 0x80 || b > 0x9f ? b : (WINDOWS_1252_HIGH[b - 0x80] ?? REPLACEMENT),
      );
    case 'utf16le':
      return decodeUtf16(bytes, true);
    case 'utf16be':
      return decodeUtf16(bytes, false);
    case 'utf32le':
      return decodeUtf32(bytes, true);
    case 'utf32be':
      return decodeUtf32(bytes, false);
  }
}

function decodeSingleByte(bytes: Uint8Array, map: (byte: number) => number): string {
  // Chunked so a large file cannot blow the argument limit of String.fromCharCode.
  const CHUNK = 0x2000;
  let out = '';
  for (let start = 0; start < bytes.length; start += CHUNK) {
    const end = Math.min(start + CHUNK, bytes.length);
    const codes: number[] = [];
    for (let i = start; i < end; i += 1) codes.push(map(bytes[i] ?? 0));
    out += String.fromCharCode(...codes);
  }
  return out;
}

/**
 * UTF-16, with the two things .NET does that a naive JS port would not.
 *
 * MEASURED on pwsh 7.6.5:
 *
 *   utf16le of 61 00 62        -> U+0061 U+FFFD   (odd tail is replaced)
 *   utf16le of 61              -> U+FFFD
 *   utf16le of 3D D8           -> U+FFFD          (a LONE surrogate is replaced)
 *   utf16le of 3D D8 00 DE     -> U+D83D U+DE00   (a valid pair survives)
 *
 * The lone-surrogate case is the one that matters. A JavaScript string can hold
 * an unpaired surrogate perfectly happily, so the obvious implementation —
 * pair the bytes, `String.fromCharCode` — returns U+D83D and disagrees with the
 * reference implementation. Worse, it disagrees INVISIBLY: the value looks like
 * a string, compares like a string, and only misbehaves once something encodes
 * it again.
 */
function decodeUtf16(bytes: Uint8Array, littleEndian: boolean): string {
  const units: number[] = [];
  let i = 0;
  for (; i + 1 < bytes.length; i += 2) {
    const a = bytes[i] ?? 0;
    const b = bytes[i + 1] ?? 0;
    units.push(littleEndian ? a | (b << 8) : (a << 8) | b);
  }
  const out: number[] = [];
  for (let u = 0; u < units.length; u += 1) {
    const unit = units[u] ?? 0;
    if (unit >= 0xd800 && unit <= 0xdbff) {
      const next = units[u + 1];
      if (next !== undefined && next >= 0xdc00 && next <= 0xdfff) {
        out.push(unit, next);
        u += 1;
      } else {
        out.push(REPLACEMENT);
      }
    } else if (unit >= 0xdc00 && unit <= 0xdfff) {
      out.push(REPLACEMENT);
    } else {
      out.push(unit);
    }
  }
  // A trailing odd byte is one replacement character, measured above.
  if (i < bytes.length) out.push(REPLACEMENT);
  return fromCharCodes(out);
}

/**
 * UTF-32. MEASURED:
 *
 *   utf32le of 61 00 00 00 62  -> U+0061 U+FFFD   (short tail replaced)
 *   utf32le of 00 D8 00 00     -> U+FFFD          (a surrogate codepoint is invalid)
 *   utf32le of 00 00 11 00     -> U+FFFD          (> U+10FFFF is invalid)
 */
function decodeUtf32(bytes: Uint8Array, littleEndian: boolean): string {
  const out: number[] = [];
  let i = 0;
  for (; i + 3 < bytes.length; i += 4) {
    const b0 = bytes[i] ?? 0;
    const b1 = bytes[i + 1] ?? 0;
    const b2 = bytes[i + 2] ?? 0;
    const b3 = bytes[i + 3] ?? 0;
    const codepoint = littleEndian
      ? b0 | (b1 << 8) | (b2 << 16) | (b3 << 24)
      : (b0 << 24) | (b1 << 16) | (b2 << 8) | b3;
    const value = codepoint >>> 0;
    if (value > 0x10ffff || (value >= 0xd800 && value <= 0xdfff)) {
      out.push(REPLACEMENT);
    } else if (value > 0xffff) {
      const shifted = value - 0x10000;
      out.push(0xd800 + (shifted >> 10), 0xdc00 + (shifted & 0x3ff));
    } else {
      out.push(value);
    }
  }
  if (i < bytes.length) out.push(REPLACEMENT);
  return fromCharCodes(out);
}

function fromCharCodes(codes: readonly number[]): string {
  const CHUNK = 0x2000;
  let out = '';
  for (let start = 0; start < codes.length; start += CHUNK) {
    out += String.fromCharCode(...codes.slice(start, start + CHUNK));
  }
  return out;
}

// ---------------------------------------------------------------------------
// encoding
// ---------------------------------------------------------------------------

/**
 * Encode text with a known codec, INCLUDING the codec's preamble.
 *
 * MEASURED, encoding U+00E9 U+20AC U+4E2D:
 *
 *   ascii        3F 3F 3F
 *   latin1       E9 3F 3F
 *   windows1252  E9 80 3F
 *   utf8         C3 A9 E2 82 AC E4 B8 AD
 *   utf8bom      EF BB BF C3 A9 E2 82 AC E4 B8 AD
 *   utf16le      FF FE E9 00 AC 20 2D 4E
 *   utf16be      FE FF 00 E9 20 AC 4E 2D
 *   utf32le      FF FE 00 00 E9 00 00 00 AC 20 00 00 2D 4E 00 00
 *
 * Note that the UTF-16 and UTF-32 forms carry a BOM and the single-byte ones do
 * not — that is `GetPreamble()`, measured, not a choice made here.
 */
export function encodeText(text: string, id: EncodingId): Uint8Array {
  const preamble = PREAMBLE[id];
  const body = encodeBody(text, id);
  if (preamble.length === 0) return body;
  const out = new Uint8Array(preamble.length + body.length);
  out.set(preamble, 0);
  out.set(body, preamble.length);
  return out;
}

function encodeBody(text: string, id: EncodingId): Uint8Array {
  switch (id) {
    case 'utf8':
    case 'utf8bom':
      // MEASURED: .NET and JS agree that a lone surrogate encodes to EF BF BD.
      //   .NET  UTF8.GetBytes("\uD83D")          -> EF BF BD
      //   JS    new TextEncoder().encode("\uD83D") -> EF BF BD
      // So this one needs no correction, unlike the UTF-16 case below.
      return UTF8_ENCODER.encode(text);
    case 'ascii':
      return encodeSingleByte(text, (cp) => (cp < 0x80 ? cp : QUESTION_MARK));
    case 'latin1':
      return encodeSingleByte(text, (cp) => (cp < 0x100 ? cp : QUESTION_MARK));
    case 'windows1252':
      return encodeSingleByte(text, (cp) =>
        cp < 0x80 || (cp >= 0xa0 && cp < 0x100) ? cp : (WINDOWS_1252_REVERSE.get(cp) ?? QUESTION_MARK),
      );
    case 'utf16le':
      return encodeUtf16(text, true);
    case 'utf16be':
      return encodeUtf16(text, false);
    case 'utf32le':
      return encodeUtf32(text, true);
    case 'utf32be':
      return encodeUtf32(text, false);
  }
}

/**
 * One byte per UTF-16 CODE UNIT, not per codepoint.
 *
 * MEASURED, and it is the counter-intuitive half: a surrogate PAIR becomes TWO
 * question marks, not one.
 *
 *   Encoding.ASCII.GetBytes("\u{1F600}")  -> 3F 3F
 *   Encoding.ASCII.GetBytes("\uD83D")     -> 3F
 *   Encoding.ASCII.GetBytes("a\uD83Db")   -> 61 3F 62
 *
 * Iterating with `for...of` — which walks codepoints and would emit one `3F`
 * for the pair — disagrees with the reference implementation. So this walks
 * `charCodeAt`, which is what .NET's char-based encoders do.
 */
function encodeSingleByte(text: string, map: (codeUnit: number) => number): Uint8Array {
  const out = new Uint8Array(text.length);
  for (let i = 0; i < text.length; i += 1) out[i] = map(text.charCodeAt(i));
  return out;
}

/**
 * UTF-16, replacing unpaired surrogates as .NET does.
 *
 * MEASURED:
 *   Encoding.Unicode.GetBytes("\uD83D")        -> FD FF        (U+FFFD, LE)
 *   Encoding.BigEndianUnicode.GetBytes("\uD83D") -> FF FD
 *   Encoding.Unicode.GetBytes("a\uD83Db")      -> 61 00 FD FF 62 00
 *   Encoding.Unicode.GetBytes("\u{1F600}")     -> 3D D8 00 DE  (a pair survives)
 *
 * The naive implementation writes the surrogate through unchanged, producing
 * `3D D8` for the first case. That is a byte sequence .NET would never emit,
 * and it round-trips back into a lone surrogate rather than U+FFFD.
 */
function encodeUtf16(text: string, littleEndian: boolean): Uint8Array {
  const out = new Uint8Array(text.length * 2);
  for (let i = 0; i < text.length; i += 1) {
    const unit = wellFormedUnitAt(text, i);
    const offset = i * 2;
    if (littleEndian) {
      out[offset] = unit & 0xff;
      out[offset + 1] = unit >> 8;
    } else {
      out[offset] = unit >> 8;
      out[offset + 1] = unit & 0xff;
    }
  }
  return out;
}

/**
 * UTF-32. MEASURED:
 *   Encoding.UTF32.GetBytes("\uD83D")      -> FD FF 00 00
 *   Encoding.UTF32.GetBytes("\u{1F600}")   -> 00 F6 01 00
 */
function encodeUtf32(text: string, littleEndian: boolean): Uint8Array {
  const codepoints: number[] = [];
  for (let i = 0; i < text.length; i += 1) {
    const unit = text.charCodeAt(i);
    if (unit >= 0xd800 && unit <= 0xdbff) {
      const next = i + 1 < text.length ? text.charCodeAt(i + 1) : Number.NaN;
      if (next >= 0xdc00 && next <= 0xdfff) {
        codepoints.push(0x10000 + ((unit - 0xd800) << 10) + (next - 0xdc00));
        i += 1;
        continue;
      }
      codepoints.push(REPLACEMENT);
    } else if (unit >= 0xdc00 && unit <= 0xdfff) {
      codepoints.push(REPLACEMENT);
    } else {
      codepoints.push(unit);
    }
  }
  const out = new Uint8Array(codepoints.length * 4);
  for (let i = 0; i < codepoints.length; i += 1) {
    const value = codepoints[i] ?? 0;
    const offset = i * 4;
    if (littleEndian) {
      out[offset] = value & 0xff;
      out[offset + 1] = (value >> 8) & 0xff;
      out[offset + 2] = (value >> 16) & 0xff;
      out[offset + 3] = (value >> 24) & 0xff;
    } else {
      out[offset] = (value >> 24) & 0xff;
      out[offset + 1] = (value >> 16) & 0xff;
      out[offset + 2] = (value >> 8) & 0xff;
      out[offset + 3] = value & 0xff;
    }
  }
  return out;
}

/** The code unit at `index`, or U+FFFD when it is half of a broken pair. */
function wellFormedUnitAt(text: string, index: number): number {
  const unit = text.charCodeAt(index);
  if (unit >= 0xd800 && unit <= 0xdbff) {
    const next = index + 1 < text.length ? text.charCodeAt(index + 1) : Number.NaN;
    return next >= 0xdc00 && next <= 0xdfff ? unit : REPLACEMENT;
  }
  if (unit >= 0xdc00 && unit <= 0xdfff) {
    const previous = index > 0 ? text.charCodeAt(index - 1) : Number.NaN;
    return previous >= 0xd800 && previous <= 0xdbff ? unit : REPLACEMENT;
  }
  return unit;
}

// ---------------------------------------------------------------------------
// byte-order marks
// ---------------------------------------------------------------------------

export interface BomMatch {
  readonly id: EncodingId;
  readonly length: number;
}

/**
 * Which BOM, if any, these bytes start with.
 *
 * ORDER IS LOAD-BEARING and was measured, not reasoned about. `FF FE 00 00` is
 * both a UTF-32LE BOM and a UTF-16LE BOM followed by U+0000, and pwsh resolves
 * it as UTF-32LE:
 *
 *   bytes FF FE 00 00 61 00 00 00, no -Encoding  ->  U+0061
 *
 * A UTF-16LE reading would have produced U+0000 U+0061 U+0000. So the four-byte
 * marks are tested before the two-byte ones. Testing in the other order is the
 * obvious mistake and it is silent on every input except this one.
 */
export function sniffBom(bytes: Uint8Array): BomMatch | null {
  const at = (i: number): number => bytes[i] ?? -1;
  // Four-byte marks FIRST. See above.
  if (at(0) === 0xff && at(1) === 0xfe && at(2) === 0x00 && at(3) === 0x00) {
    return { id: 'utf32le', length: 4 };
  }
  if (at(0) === 0x00 && at(1) === 0x00 && at(2) === 0xfe && at(3) === 0xff) {
    return { id: 'utf32be', length: 4 };
  }
  if (at(0) === 0xef && at(1) === 0xbb && at(2) === 0xbf) return { id: 'utf8bom', length: 3 };
  if (at(0) === 0xff && at(1) === 0xfe) return { id: 'utf16le', length: 2 };
  if (at(0) === 0xfe && at(1) === 0xff) return { id: 'utf16be', length: 2 };
  return null;
}

function startsWith(bytes: Uint8Array, prefix: readonly number[]): boolean {
  if (prefix.length === 0 || bytes.length < prefix.length) return false;
  for (let i = 0; i < prefix.length; i += 1) {
    if (bytes[i] !== prefix[i]) return false;
  }
  return true;
}

/**
 * Decode a FILE: the BOM participates, unlike in `decodeBytes`.
 *
 * ---------------------------------------------------------------------------
 * THE RULE, AND THE ELEVEN MEASUREMENTS IT REPRODUCES
 * ---------------------------------------------------------------------------
 *
 * A BOM overrides `-Encoding` — except that an explicitly requested codec gets
 * first claim on a BOM that is its OWN. One rule, stated once:
 *
 *   if the requested codec's own preamble is present, consume it and use the
 *   requested codec; otherwise sniff, and let the sniff win.
 *
 * Measured with `Get-Content -Raw`, requested encoding on the left:
 *
 *   (none)   FF FE 61 00                 -> U+0061              utf16le
 *   (none)   FE FF 00 61                 -> U+0061              utf16be
 *   (none)   EF BB BF 61                 -> U+0061              utf8
 *   (none)   FF FE 00 00 61 00 00 00     -> U+0061              utf32le, not utf16le
 *   (none)   00 00 FE FF 00 00 00 61     -> U+0061              utf32be
 *   (none)   FF FE 00 00                 -> (nothing at all)    BOM-only file
 *   utf8     FF FE 00 00 61 00 00 00     -> U+0061              sniff wins
 *   utf8     00 00 FE FF 00 00 00 61     -> U+0061              sniff wins
 *   utf8     FE FF 00 61                 -> U+0061              sniff wins
 *   unicode  EF BB BF 61                 -> U+0061              sniff wins
 *   unicode  FF FE 00 00 61 00 00 00     -> U+0000 U+0061 U+0000  REQUEST wins
 *   latin1   EF BB BF 61                 -> U+0061              sniff wins
 *   ascii    FF FE 61 00                 -> U+0061              sniff wins
 *   utf32    FF FE 00 00 61 00 00 00     -> U+0061              request wins (same answer)
 *
 * The one case where the request wins is `unicode` over a UTF-32LE BOM, and the
 * rule above is what makes it fall out rather than being special-cased: UTF-16LE's
 * preamble is `FF FE`, those bytes are present, so it claims them and never
 * reaches the sniff. Every other row has a requested codec whose preamble is
 * absent, so the sniff decides.
 *
 * A file that is NOTHING BUT a BOM decodes to the empty string — measured to
 * emit no objects at all from Get-Content, the same as an empty file.
 */
export function decodeFile(bytes: Uint8Array, requested: EncodingId): string {
  const own = PREAMBLE[requested];
  if (startsWith(bytes, own)) {
    return decodeBytes(bytes.subarray(own.length), requested);
  }
  const sniffed = sniffBom(bytes);
  if (sniffed !== null) {
    return decodeBytes(bytes.subarray(sniffed.length), sniffed.id);
  }
  return decodeBytes(bytes, requested);
}

// ---------------------------------------------------------------------------
// the broker
// ---------------------------------------------------------------------------

/**
 * The behaviour key for PowerShell 7.7's `$PSApplicationOutputEncoding`.
 *
 * Declared in `compat/deltas/powershell-77-changes.source.mts` citing upstream
 * PR #21219. MEASURED ABSENT in 7.6.5 on both platforms:
 *
 *   Get-Variable PSApplicationOutputEncoding -ErrorAction SilentlyContinue
 *     -> $null   (Windows 10.0.26340 and Ubuntu 24.04.4)
 *
 * and `Get-Variable | Where-Object Name -like '*Encoding*'` lists exactly one
 * variable there, `OutputEncoding`.
 */
export const APPLICATION_OUTPUT_ENCODING_KEY = 'application.outputEncodingVariable';

export interface EncodingBrokerOptions {
  /**
   * `$OutputEncoding`. The ENCODER for text piped INTO a native command.
   *
   * It is NOT the decoder for what comes back, however much the name suggests
   * otherwise. Measured: setting it to Latin1 changed nothing about captured
   * native output on either platform. See the header, point 1.
   */
  readonly outputEncoding?: EncodingId;
  /**
   * `[Console]::OutputEncoding`. The decoder for native command output in
   * 7.6.5, measured on both platforms.
   */
  readonly consoleOutputEncoding?: EncodingId;
  /**
   * `$PSApplicationOutputEncoding`, added in 7.7 by PR #21219. Ignored unless
   * the active profile declares the behaviour — a 7.6.5 session has no such
   * variable to set, so honouring it there would emulate a version that does
   * not exist.
   */
  readonly applicationOutputEncoding?: EncodingId;
  readonly host?: HostCodePages;
}

/**
 * The one thing that decides an encoding, and the one thing that applies it.
 *
 * Two questions this class exists to make answerable in one place:
 *
 *   "can bytes be corrupted by a path that bypasses the broker?"  — only if a
 *   caller constructs a TextDecoder itself. `decodeBytes` is the only decoder
 *   in the pipeline, and `native` bytes reach text ONLY through
 *   `decodeNativeOutput`.
 *
 *   "is there more than one place that decides an encoding?" — there was. This
 *   file replaced a decode table in `fs-read/get-content.ts` and an encode
 *   table in `fs-write/set-content.ts` which had drifted apart: they disagreed
 *   about `ascii` (windows-1252 versus '?' substitution), disagreed about which
 *   names existed at all (`latin1` was in one and not the other), and neither
 *   agreed with the reference implementation about `oem`.
 */
export class EncodingBroker {
  readonly #host: HostCodePages;
  readonly #outputEncoding: EncodingId;
  readonly #consoleOutputEncoding: EncodingId;
  readonly #applicationOutputEncoding: EncodingId | null;

  constructor(options: EncodingBrokerOptions = {}) {
    this.#host = options.host ?? UBUNTU_CODE_PAGES;
    // MEASURED on Ubuntu 24.04.4, pwsh 7.6.5: $OutputEncoding and
    // [Console]::OutputEncoding are both utf-8 and are the SAME OBJECT
    // (ReferenceEquals -> True). On the Windows host they are utf-8 and big5
    // respectively and ReferenceEquals is False, which is why they are two
    // fields here rather than one.
    this.#outputEncoding = options.outputEncoding ?? 'utf8';
    this.#consoleOutputEncoding = options.consoleOutputEncoding ?? 'utf8';
    this.#applicationOutputEncoding = options.applicationOutputEncoding ?? null;
  }

  /** `$OutputEncoding` — what text piped to a native command's stdin becomes. */
  get outputEncoding(): EncodingId {
    return this.#outputEncoding;
  }

  /** `[Console]::OutputEncoding`. */
  get consoleOutputEncoding(): EncodingId {
    return this.#consoleOutputEncoding;
  }

  /** `$PSApplicationOutputEncoding`, or null when the session has not set one. */
  get applicationOutputEncoding(): EncodingId | null {
    return this.#applicationOutputEncoding;
  }

  get host(): HostCodePages {
    return this.#host;
  }

  /**
   * Which codec decodes native command output, under the given profile.
   *
   * The precedence is MEASURED for the 7.6.5 half and cited for the 7.7 half:
   *
   *   1. `$PSApplicationOutputEncoding`, if the profile has it AND it is set.
   *      7.7 only — upstream PR #21219. A 7.6.5 profile does not declare the
   *      behaviour, so `behavior()` returns the false fallback and this branch
   *      is unreachable there, which is the whole point of routing it through
   *      the profile rather than through a version comparison.
   *   2. `[Console]::OutputEncoding`. MEASURED to be the decoder in 7.6.5:
   *      setting it to Latin1 changed captured native output on both platforms,
   *      and setting `$OutputEncoding` to Latin1 changed nothing.
   *
   * `$OutputEncoding` is deliberately not consulted. It is the stdin encoder.
   */
  nativeOutputEncoding(profile: CompatibilityView | null): EncodingId {
    if (this.#applicationOutputEncoding !== null && profile !== null) {
      const honoured = profile.behavior(APPLICATION_OUTPUT_ENCODING_KEY, false);
      if (honoured) return this.#applicationOutputEncoding;
    }
    return this.#consoleOutputEncoding;
  }

  /**
   * Turn native command output into text. THE ONLY WAY BYTES BECOME TEXT.
   *
   * A caller that wants the bytes themselves must simply not call this: the
   * `Uint8Array` is already a `PSValue`, and `Get-Content -AsByteStream` and a
   * redirect to a file both keep it. MEASURED: a native command emitting
   * 61 E9 80 7A redirected to a file produces exactly those four bytes, while
   * the same output captured into a variable is decoded and cannot be recovered.
   */
  decodeNativeOutput(bytes: Uint8Array, profile: CompatibilityView | null): string {
    return decodeBytes(bytes, this.nativeOutputEncoding(profile));
  }

  /** Encode text for a native command's stdin. This IS `$OutputEncoding`. */
  encodeNativeInput(text: string): Uint8Array {
    return encodeText(text, this.#outputEncoding);
  }

  /** Resolve a `-Encoding` argument against this broker's host code pages. */
  resolve(name: string | undefined): EncodingResolution {
    return resolveEncodingName(name, this.#host);
  }

  /** Read a file's bytes as text, honouring the BOM rule in `decodeFile`. */
  decodeFile(bytes: Uint8Array, requested: EncodingId): string {
    return decodeFile(bytes, requested);
  }

  /** Write text as a file's bytes, including the codec's preamble. */
  encodeFile(text: string, requested: EncodingId): Uint8Array {
    return encodeText(text, requested);
  }

  /** A copy with one or more settings changed, for `$OutputEncoding = ...`. */
  with(changes: EncodingBrokerOptions): EncodingBroker {
    return new EncodingBroker({
      host: changes.host ?? this.#host,
      outputEncoding: changes.outputEncoding ?? this.#outputEncoding,
      consoleOutputEncoding: changes.consoleOutputEncoding ?? this.#consoleOutputEncoding,
      ...(changes.applicationOutputEncoding !== undefined
        ? { applicationOutputEncoding: changes.applicationOutputEncoding }
        : this.#applicationOutputEncoding !== null
          ? { applicationOutputEncoding: this.#applicationOutputEncoding }
          : {}),
    });
  }
}

/** The broker a session starts with: UTF-8 everywhere, Ubuntu code pages. */
export function defaultEncodingBroker(): EncodingBroker {
  return new EncodingBroker();
}
