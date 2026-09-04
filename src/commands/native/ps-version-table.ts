/**
 * $PSVersionTable — the version claim, and the one place it must not be retyped.
 *
 * v1 hardcoded `['PSVersion','7.6.5']` in a table literal. This repository has a
 * tool devoted to release truth (`tools/verify-release-truth.mts`, whose output
 * is `compat/upstream/releases.lock.json` with a fetch digest per source), and a
 * second hand-written copy of the version would be a place for the two to
 * disagree silently — which is precisely the failure that tool exists to catch.
 *
 * So the version comes from two places and neither is a literal here:
 *
 *   PSVersion    the RESOLVED COMPATIBILITY PROFILE, through
 *                `context.profile.displayVersion` — because the answer is
 *                "which semantics is this session running", not "what did
 *                someone type"
 *   GitCommitId  the release lock entry for that version. If the lock has no
 *                such release the table says so out loud rather than inventing
 *                a commit id, because a version the truth file has never heard
 *                of is a real problem and not a formatting detail.
 *
 * Measured in pwsh 7.6.5 — the keys, their ORDER, and their types:
 *
 *   PSVersion                  SemanticVersion   7.6.5
 *   PSEdition                  String            Core
 *   GitCommitId                String            7.6.5
 *   OS                         String            (the host)
 *   Platform                   String            (Win32NT / Unix)
 *   PSCompatibleVersions       Version[]         1.0 2.0 3.0 4.0 5.0 5.1 6.0 7.0
 *   PSRemotingProtocolVersion  Version           2.4
 *   SerializationVersion       Version           1.1.0.1
 *   WSManStackVersion          Version           3.0
 *
 * OS and Platform describe the SIMULATED machine, not the visitor's computer.
 * That is stated in the generated manifest for this command and it is the
 * reason `MachineIdentity` is a declared fiction rather than something read.
 *
 * A KNOWN RENDERING GAP, recorded once for all of them: `SemanticVersion` and
 * `Version` are PSObjects with a real type chain, so `toPSString` prints the
 * type name where pwsh prints `7.6.5`. Turning a structured value into its
 * canonical text is a formatter's job and the formatter is a separate component
 * (see to-string.ts, which says formatting is the last step); `versionText`
 * below is exported for it.
 */

import { psObject, psWrap } from '../../pipeline/psobject.ts';
import type { PSObject } from '../../pipeline/psobject.ts';
import { throwIfCancelled } from '../../pipeline/pipeline.ts';
import type { BindingResult, CommandModule, InvocationContext } from '../invocation.ts';
import { manifest } from '../powershell/support.ts';
import type { MachineIdentity, NativeServices } from './services.ts';

import releasesLock from '../../../compat/upstream/releases.lock.json' with { type: 'json' };

export const SEMANTIC_VERSION_TYPE_NAMES: readonly string[] = [
  'System.Management.Automation.SemanticVersion',
  'System.Object',
];
export const VERSION_TYPE_NAMES: readonly string[] = ['System.Version', 'System.Object'];
export const VERSION_TABLE_TYPE_NAMES: readonly string[] = [
  'System.Management.Automation.PSVersionHashTable',
  'System.Collections.Hashtable',
  'System.Object',
];

/** The slice of the lock this file reads. Declared locally so widening the lock
 *  cannot silently widen what the version table depends on. */
interface LockRelease {
  readonly version: string;
  readonly tag: string;
  readonly channel: string;
  readonly commitSha: string;
}

const RELEASES = (releasesLock as { releases: readonly LockRelease[] }).releases;

/** `System.Version`, with the six members pwsh reports for `[version]'1.1.0.1'`. */
export function psVersion(text: string): PSObject {
  const parts = text.split('.').map((n) => Number.parseInt(n, 10));
  const revision = parts[3] ?? -1;
  return psWrap(
    {
      Major: parts[0] ?? 0,
      Minor: parts[1] ?? 0,
      Build: parts[2] ?? -1,
      Revision: revision,
      MajorRevision: revision < 0 ? -1 : (revision >> 16) & 0xffff,
      MinorRevision: revision < 0 ? -1 : revision & 0xffff,
    },
    VERSION_TYPE_NAMES,
    text,
  );
}

/** `System.Management.Automation.SemanticVersion`, whose third part is Patch. */
export function psSemanticVersion(text: string): PSObject {
  const match = /^(\d+)\.(\d+)\.(\d+)(?:-([0-9A-Za-z.-]+))?(?:\+([0-9A-Za-z.-]+))?$/.exec(text);
  return psWrap(
    {
      Major: Number(match?.[1] ?? 0),
      Minor: Number(match?.[2] ?? 0),
      Patch: Number(match?.[3] ?? 0),
      PreReleaseLabel: match?.[4] ?? '',
      BuildLabel: match?.[5] ?? '',
    },
    SEMANTIC_VERSION_TYPE_NAMES,
    text,
  );
}

/** The canonical text of a version-shaped object, for the formatter. */
export function versionText(value: PSObject): string {
  return typeof value.baseObject === 'string' ? value.baseObject : '';
}

/**
 * The engine constants. Read off pwsh 7.6.5, and deliberately NOT derived from
 * the profile: they are protocol and serialisation versions of the engine, not
 * the PowerShell release, and pretending to compute them from the release would
 * be a fabricated derivation.
 */
const PS_COMPATIBLE_VERSIONS = ['1.0', '2.0', '3.0', '4.0', '5.0', '5.1', '6.0', '7.0'] as const;
const PS_REMOTING_PROTOCOL_VERSION = '2.4';
const SERIALIZATION_VERSION = '1.1.0.1';
const WSMAN_STACK_VERSION = '3.0';

/**
 * What the release lock says about a version, or a sentence saying it says
 * nothing. Exported so a test can assert the lock and the profile agree.
 */
export function gitCommitIdFor(displayVersion: string): string {
  const release = RELEASES.find((r) => r.version === displayVersion);
  if (release === undefined) {
    return `(no release for ${displayVersion} in releases.lock.json)`;
  }
  // Official builds report the version string, not the sha — measured: pwsh
  // 7.6.5 reports GitCommitId 7.6.5, while the lock's commitSha for that tag is
  // 7acb29279dd64e646d821f75d1cc8ad59455a9a6. The lock is consulted so that an
  // unknown version cannot pass unnoticed, not to substitute a different value.
  return release.version;
}

export function psVersionTable(displayVersion: string, machine: MachineIdentity): PSObject {
  return psObject(
    {
      PSVersion: psSemanticVersion(displayVersion),
      PSEdition: 'Core',
      GitCommitId: gitCommitIdFor(displayVersion),
      OS: machine.os,
      Platform: machine.platform,
      PSCompatibleVersions: PS_COMPATIBLE_VERSIONS.map(psVersion),
      PSRemotingProtocolVersion: psVersion(PS_REMOTING_PROTOCOL_VERSION),
      SerializationVersion: psVersion(SERIALIZATION_VERSION),
      WSManStackVersion: psVersion(WSMAN_STACK_VERSION),
    },
    VERSION_TABLE_TYPE_NAMES,
  );
}

const PS_VERSION_TABLE_MANIFEST = manifest({
  display: '$PSVersionTable',
  synopsis: 'PowerShell version information.',
  notes:
    'PSVersion comes from the resolved compatibility profile and GitCommitId is checked against ' +
    'compat/upstream/releases.lock.json, so no version string is written here; a version the ' +
    'lock has never heard of says so in the table instead of being invented. OS and Platform ' +
    'describe the simulated Ubuntu machine — the same fiction uname and hostname report — and ' +
    'are not your computer. PSCompatibleVersions, PSRemotingProtocolVersion, ' +
    'SerializationVersion and WSManStackVersion are engine constants read off pwsh 7.6.5.',
  parameters: [],
  outputTypeNames: ['System.Management.Automation.PSVersionHashTable'],
});

export function createPSVersionTable(services: NativeServices): CommandModule {
  return {
    manifest: PS_VERSION_TABLE_MANIFEST,

    invoke(context: InvocationContext, _bound: BindingResult): Promise<number> {
      throwIfCancelled(context.signal, '$PSVersionTable');
      return context.streams.success
        .write(psVersionTable(context.profile.displayVersion, services.machine))
        .then(() => 0);
    },
  };
}
