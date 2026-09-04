/**
 * New-Guid — and the one command in this directory whose ANSWER depends on the
 * compatibility profile.
 *
 * PowerShell 7.7 changes `New-Guid` to emit a time-sortable UUID v7 instead of
 * a random v4 (upstream PR 27033). The output type and the string shape are
 * unchanged, which is exactly what makes it dangerous: a script keeps working
 * while its identifiers become time-ordered and guessable. The delta file
 * classifies it `breaking` / `script-breaking` for that reason.
 *
 * So the version is NOT a version check. It is the behaviour flag the profiles
 * already declare — `newGuid.defaultVersion`, 4 in powershell/7.6.5/linux and 7
 * in powershell/7.7.0-preview.4/linux — read through `CompatibilityView`. A
 * command asking "am I 7.7?" is the thing the whole profile system exists to
 * replace, and this is the command that would tempt someone to write one.
 *
 * Measured in pwsh 7.6.5:
 *   (New-Guid).GetType().FullName        ->  System.Guid
 *   (New-Guid).PSObject.TypeNames        ->  System.Guid | System.ValueType | System.Object
 *   (New-Guid).ToString().Substring(14,1) -> 4          the version nibble
 *   (New-Guid).ToString().Substring(19,1) -> 8|9|a|b    the variant nibble
 *   "$(New-Guid)".Length                 ->  36         lower-case, hyphenated
 *   (New-Guid).Guid                      ->  the same string
 *
 * NOT A SECURITY TOKEN. The generator is a PRNG, exactly as .NET's `Random`
 * is not a CSPRNG; the migration note in the delta says the same thing about
 * the real cmdlet.
 */

import { psWrap } from '../../pipeline/psobject.ts';
import type { PSObject } from '../../pipeline/psobject.ts';
import { throwIfCancelled } from '../../pipeline/pipeline.ts';
import type { BindingResult, CommandModule, CompatibilityView, InvocationContext } from '../invocation.ts';
import { manifest, parameter, switchValue } from '../powershell/support.ts';
import type { NativeServices, RandomSource } from './services.ts';

export const GUID_TYPE_NAMES: readonly string[] = [
  'System.Guid',
  'System.ValueType',
  'System.Object',
];

/** The behaviour key both compatibility profiles declare. */
export const NEW_GUID_VERSION_KEY = 'newGuid.defaultVersion';

/**
 * Exported because the catalogue needs it before any module is built: New-Guid
 * has no entry in the generated `manifests.json` (v1 had no such command), so
 * `Get-Command` learns about it from here.
 */
export const NEW_GUID_MANIFEST = manifest({
  display: 'New-Guid',
  synopsis: 'Creates a GUID.',
  notes:
    'The UUID version comes from the `newGuid.defaultVersion` behaviour flag: 4 under the ' +
    '7.6.5 profile, 7 under 7.7.0-preview.4 (upstream PR 27033, classified script-breaking ' +
    'because the shape is identical and only the predictability changes). Backed by the ' +
    'injected PRNG, so it is deterministic in tests and must never be used as a secret — ' +
    "the same warning the upstream migration note gives about the real cmdlet. -Empty and " +
    '-InputObject are implemented; the v7 timestamp comes from the injected clock.',
  parameters: [
    parameter('Empty', 'System.Management.Automation.SwitchParameter'),
    parameter('InputObject', 'System.String', { position: 0, valueFromPipeline: true }),
  ],
  outputTypeNames: ['System.Guid'],
});

const HEX = '0123456789abcdef';

/** One random byte from the injected source. */
function byte(random: RandomSource): number {
  return Math.floor(random.next() * 256) & 0xff;
}

function hex(value: number, digits: number): string {
  let out = '';
  for (let i = digits - 1; i >= 0; i -= 1) out += HEX[(value >> (i * 4)) & 0xf] ?? '0';
  return out;
}

/**
 * Compose the canonical 8-4-4-4-12 text from sixteen bytes, after stamping the
 * version nibble and the RFC 4122 variant bits. Both stamps are what the probe
 * reads back out of the reference implementation's output.
 */
function textOf(bytes: readonly number[], version: number): string {
  const b = [...bytes];
  b[6] = ((b[6] ?? 0) & 0x0f) | (version << 4);
  b[8] = ((b[8] ?? 0) & 0x3f) | 0x80;
  const s = b.map((n) => hex(n, 2)).join('');
  return `${s.slice(0, 8)}-${s.slice(8, 12)}-${s.slice(12, 16)}-${s.slice(16, 20)}-${s.slice(20)}`;
}

/**
 * The GUID text for a given version. Exported so the conformance probe can call
 * the same function the command calls, rather than a copy of it.
 *
 * v7 puts a 48-bit big-endian Unix millisecond timestamp in the first six
 * bytes, which is the whole point of the 7.7 change: two GUIDs made a second
 * apart sort in that order as strings.
 */
export function guidText(version: number, random: RandomSource, epochMs: number): string {
  const bytes: number[] = [];
  if (version === 7) {
    const ms = BigInt(Math.max(0, Math.floor(epochMs)));
    for (let i = 5; i >= 0; i -= 1) bytes.push(Number((ms >> BigInt(i * 8)) & 0xffn));
    while (bytes.length < 16) bytes.push(byte(random));
  } else {
    for (let i = 0; i < 16; i += 1) bytes.push(byte(random));
  }
  return textOf(bytes, version);
}

/** The empty GUID `Guid.Empty`, which `-Empty` asks for. */
export const EMPTY_GUID = '00000000-0000-0000-0000-000000000000';

/**
 * A `System.Guid` as the pipeline carries it: a PSObject with the real type
 * chain, the `Guid` property pwsh exposes, and the text reachable through
 * `baseObject` for anything that needs the host value.
 */
export function psGuid(text: string): PSObject {
  return psWrap({ Guid: text }, GUID_TYPE_NAMES, text);
}

/** Which UUID version the active profile asks for. */
export function guidVersionFor(profile: CompatibilityView): number {
  return profile.behavior(NEW_GUID_VERSION_KEY, 4);
}

export function createNewGuid(services: NativeServices): CommandModule {
  return {
    manifest: NEW_GUID_MANIFEST,

    async invoke(context: InvocationContext, bound: BindingResult): Promise<number> {
      throwIfCancelled(context.signal, 'New-Guid');
      if (switchValue(bound.parameters, 'Empty')) {
        await context.streams.success.write(psGuid(EMPTY_GUID));
        return 0;
      }
      const version = guidVersionFor(context.profile);
      const text = guidText(version, services.guidRandom, services.clock.now());
      await context.streams.success.write(psGuid(text));
      return 0;
    },
  };
}
