/**
 * machine.ts — the commands that answer "what computer is this?" with a lie.
 *
 *   uname  lsb_release  hostname  df  free  uptime  exit
 *
 * Six of these describe an Ubuntu box that does not exist, and the browser
 * could not answer any of them truthfully even if it wanted to: a page cannot
 * read the host's kernel version, its disks, its memory or its boot time, and
 * the ones it can approximate — `navigator.deviceMemory` buckets RAM into
 * powers of two and is not implemented in every engine — would be a different
 * number about a different thing. So the answer is invented, it is v1's
 * invention unchanged, and the manifest note says so where a visitor can read
 * it with `Get-Help`.
 *
 * `exit` is here because it is the same kind of claim in reverse: it is the one
 * command a visitor most reasonably expects to DO something, and the honest
 * answer is that it cannot. `window.close()` is ignored for any tab a script
 * did not itself open — that has been the rule since it was tightened in the
 * browsers, and it is not a permission that can be requested. A terminal that
 * printed "logout" and left you sitting at the prompt would be lying about the
 * one thing the user just asked for, so it says what it cannot do instead.
 *
 * WHAT WAS KEPT AND WHY
 *
 * Every string below is v1's, to the space. `df` reports 48G because v1 said
 * 48G; `free` reports 15Gi because v1 said 15Gi. The figures are not better or
 * worse than any other made-up figures, and a returning visitor seeing the
 * machine's story change under them would learn nothing except that the numbers
 * were never real — which the badge and the note already say, out loud, without
 * breaking anything.
 */

import type { SimulatedEnvironment } from './environment.ts';
import { MACHINE } from './environment.ts';
import type { CommandModule } from '../invocation.ts';
import { argumentsOf, fixedTextCommand } from './support.ts';

// ---------------------------------------------------------------------------
// uname
// ---------------------------------------------------------------------------

/**
 * v1 matches its flags with a regex over the whole argument string, so
 * `uname -a` and `uname --all` are the same branch and the first match wins in
 * source order: -a, then -r, -m, -n, then bare. That precedence is reproduced,
 * including the consequence that `uname -m -a` answers as `-a`.
 *
 * Real `uname` composes flags — `uname -rm` prints release AND machine on one
 * line — and v1 does not. The divergence is v1's and is left alone here; a
 * command in this directory is measured against the archive, not against
 * coreutils, and quietly improving it would be an unannounced change to what a
 * returning visitor sees.
 */
function uname(): CommandModule {
  return fixedTextCommand('uname', (_context, bound) => {
    const flags = argumentsOf(bound).join(' ');
    if (/-a|--all/u.test(flags)) {
      return [
        `${MACHINE.operatingSystem} ${MACHINE.hostname} ${MACHINE.kernelRelease} ` +
          `${MACHINE.kernelBuild} ${MACHINE.machineHardware} ${MACHINE.machineHardware} ` +
          `${MACHINE.machineHardware} GNU/Linux`,
      ];
    }
    if (/-r/u.test(flags)) return [MACHINE.kernelRelease];
    if (/-m/u.test(flags)) return [MACHINE.machineHardware];
    if (/-n/u.test(flags)) return [MACHINE.hostname];
    return [MACHINE.operatingSystem];
  });
}

// ---------------------------------------------------------------------------
// lsb_release
// ---------------------------------------------------------------------------

/**
 * v1 ignores its arguments entirely and always prints the `-a` block. Real
 * `lsb_release` with no flag prints a usage line, and `lsb_release -c` prints
 * only the codename. Left as v1 wrote it, for the same reason as `uname` above.
 *
 * The tabs are real tab characters, as they are in the archive and in the tool.
 */
function lsbRelease(): CommandModule {
  return fixedTextCommand('lsb_release', () => [
    `Distributor ID:\t${MACHINE.distributorId}`,
    `Description:\t${MACHINE.distributorDescription}`,
    `Release:\t${MACHINE.distributorRelease}`,
    `Codename:\t${MACHINE.distributorCodename}`,
  ]);
}

// ---------------------------------------------------------------------------
// hostname
// ---------------------------------------------------------------------------

/**
 * The name of the machine that does not exist. A page can read
 * `location.hostname` — the SERVER it was served from — and that is a different
 * fact about a different thing, so it is not what this prints.
 */
function hostname(): CommandModule {
  return fixedTextCommand('hostname', () => [MACHINE.hostname]);
}

// ---------------------------------------------------------------------------
// df
// ---------------------------------------------------------------------------

/**
 * Invented disk figures, unrelated to anything.
 *
 * There IS a real number available — `navigator.storage.estimate()` reports the
 * origin's quota and usage — and this deliberately does not report it. That
 * would make `df` browser-backed while its manifest says simulated, and it
 * would answer a question nobody asked: the quota for one origin is not the
 * free space on a disk. The manifest note names `Get-StorageStatus` as the
 * command for the real figure, which is where that answer belongs.
 */
function df(): CommandModule {
  return fixedTextCommand('df', () => [
    'Filesystem      Size  Used Avail Use% Mounted on',
    '/dev/root        48G   19G   27G  42% /',
    'tmpfs           7.8G     0  7.8G   0% /dev/shm',
  ]);
}

// ---------------------------------------------------------------------------
// free
// ---------------------------------------------------------------------------

/**
 * Invented memory figures. The browser does not expose host memory;
 * `navigator.deviceMemory` reports a coarse bucket where it exists at all, and
 * `performance.memory` is a non-standard measure of this tab's JS heap. Neither
 * is what `free` means, so neither is used.
 */
function free(): CommandModule {
  return fixedTextCommand('free', () => [
    '               total        used        free      shared  buff/cache   available',
    'Mem:            15Gi       4.2Gi       6.1Gi       220Mi       5.1Gi        10Gi',
    'Swap:          4.0Gi          0B       4.0Gi',
  ]);
}

// ---------------------------------------------------------------------------
// uptime
// ---------------------------------------------------------------------------

function twoDigits(value: number): string {
  return String(value).padStart(2, '0');
}

/**
 * The only command in this file that varies, and the reason `SimulatedEnvironment`
 * has a clock.
 *
 * v1 prints the CURRENT wall-clock time followed by a fixed "up 7 days, 3:24" —
 * so the leading time is real and everything after it is not, on one line, with
 * nothing to tell them apart. That is preserved rather than fixed, because the
 * note says the whole line describes the simulated machine and the badge says
 * SIMULATED; changing the text would be an unannounced change and reporting a
 * real uptime is impossible anyway (a page cannot see the host's boot time, and
 * `performance.timeOrigin` measures this document, not the computer).
 *
 * The time is formatted from the injected clock with local-time getters, as v1
 * did. It is deliberately NOT `toPSString`'s date format: that is PowerShell's
 * culture-invariant `MM/dd/yyyy HH:mm:ss` and this is `uptime`'s own `HH:MM:SS`.
 */
function uptime(environment: SimulatedEnvironment): CommandModule {
  return fixedTextCommand('uptime', () => {
    const at = new Date(environment.now());
    const clock =
      `${twoDigits(at.getHours())}:${twoDigits(at.getMinutes())}:${twoDigits(at.getSeconds())}`;
    return [`${clock}  up 7 days,  3:24,  1 user,  load average: 0.18, 0.24, 0.21`];
  });
}

// ---------------------------------------------------------------------------
// exit
// ---------------------------------------------------------------------------

/**
 * Explains, rather than pretends.
 *
 * A tab cannot close itself unless a script opened it: `window.close()` is
 * ignored otherwise, and no permission unlocks it. There is also nothing here
 * for `exit` to end — the terminal is not a session with a login, and there is
 * no shell process to leave. v1's single line says exactly that, and the
 * manifest note says the rest.
 *
 * The exit code is 0. `exit` in a real shell takes one and reports it, and
 * modelling that would mean claiming a session ended, which is the thing this
 * command exists not to claim.
 */
function exit(): CommandModule {
  return fixedTextCommand('exit', () => [
    'Close the tab to exit. Thanks for stopping by :)',
  ]);
}

// ---------------------------------------------------------------------------

export function machineCommands(environment: SimulatedEnvironment): readonly CommandModule[] {
  return [uname(), lsbRelease(), hostname(), df(), free(), uptime(environment), exit()];
}
