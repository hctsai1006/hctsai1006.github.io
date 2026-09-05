/**
 * privilege.ts — `sudo`, which confers nothing and must be seen not to.
 *
 * This is the command in the whole set most likely to mislead, because it is
 * the one whose real counterpart changes what you are allowed to do. So the
 * claim has to be exact:
 *
 *   sudo here grants NOTHING in the browser, nothing at the origin, and nothing
 *   on your computer, and it never can. No file becomes writable, no request
 *   becomes permitted, no device becomes reachable, and no policy is bypassed.
 *
 * That is not a promise this file makes on its own — a promise in a comment is
 * worth nothing. It is enforced in `src/kernel/capabilities.ts`, where
 * `CAPABILITY_REALITY` classifies `virtual.policy.elevate` as the one capability
 * that is not real, `ELEVATION_CONFERS` is empty, and
 * `assertElevationCannotConferReality` throws at module load and again on every
 * grant computation if anyone ever makes it non-empty with something real. A
 * denial that happens while elevated even gets its own decision code,
 * `denied:elevation-not-transferable`, so "I was root and it still said no" is
 * an observable outcome rather than an absence of behaviour.
 *
 * WHAT THIS COMMAND ACTUALLY DOES
 *
 * It asks the broker, through `context.requireCapability`, and then prints v1's
 * text. It goes THROUGH the broker rather than around it precisely because the
 * asking is the point: the answer changes nothing a visitor can see, and the
 * record of the ask lands in the audit log with `real: false`. A `sudo` that
 * quietly did nothing would be honest by accident; one that asks and is refused
 * is honest by construction, and a reviewer can read the log and see it.
 *
 * It never calls `VirtualPolicy.elevate()`. v1's `sudo` does not elevate even
 * the simulated uid — it reports command not found — and the manifest note says
 * so. Elevating the virtual policy would change what `whoami` prints, which is
 * a behaviour change v1 never had, dressed up as fidelity.
 *
 * THE ONE THING IT CHANGES
 *
 * `sudo apt install net-tools` flips a boolean that `ifconfig` reads, so the
 * three-step joke works. That boolean lives in this session's memory, is not
 * persisted, and is not reachable from anywhere else. It is the entirety of
 * `sudo`'s effect on the world.
 */

import { CapabilityDeniedError } from '../invocation.ts';
import type { CommandModule, InvocationContext } from '../invocation.ts';
import type { SimulatedEnvironment } from './environment.ts';
import { MACHINE } from './environment.ts';
import {
  EXIT_COMMAND_NOT_FOUND,
  EXIT_SUCCESS,
  argumentsOf,
  simulatedCommand,
  simulatedManifest,
  writeError,
  writeLines,
} from './support.ts';

const SUDO_MANIFEST = simulatedManifest('sudo');

/**
 * Ask the broker for the elevation this command declares, and carry on either
 * way.
 *
 * Swallowing the denial is deliberate and is not the same as not asking. The
 * ask produces the audit record; the denial produces the same output as the
 * grant, because a granted `virtual.policy.elevate` confers an empty set. If
 * this command behaved differently when elevated, `sudo` would have become a
 * privilege model — the exact thing the kernel's comment warns someone will one
 * day add "because it obviously should work that way".
 *
 * Only `CapabilityDeniedError` is caught. Anything else is a bug in the broker
 * and must not be hidden behind a joke.
 */
function askForElevation(context: InvocationContext): void {
  try {
    context.requireCapability('virtual.policy.elevate');
  } catch (reason) {
    if (reason instanceof CapabilityDeniedError) return;
    throw reason;
  }
}

/** v1 normalises the whole line before matching, so quoting and spacing vary. */
function commandLine(args: readonly string[]): string {
  return ['sudo', ...args].join(' ').toLowerCase().replace(/\s+/gu, ' ');
}

const APT_INSTALL_NET_TOOLS = 'sudo apt install net-tools';

function sudo(environment: SimulatedEnvironment): CommandModule {
  return simulatedCommand('sudo', async (context, bound) => {
    askForElevation(context);

    const line = commandLine(argumentsOf(bound));

    // The joke everyone tries first. Nothing is deleted, because there is
    // nothing here that a shell could delete and no shell to delete it with.
    if (line === 'sudo rm -rf /' || line === 'sudo rm -rf /*') {
      await writeLines(context, [
        `[sudo] password for ${MACHINE.user}: `,
        '',
        'Whew! That was a close one.',
        '這是網頁,不是真的伺服器 — 我的檔案安全,你的也是。',
      ]);
      return EXIT_SUCCESS;
    }

    if (line.startsWith(APT_INSTALL_NET_TOOLS)) {
      const state = environment.packages;
      if (state.netToolsInstalled) {
        await writeLines(context, [
          'net-tools is already the newest version (2.10-alpha-2).',
        ]);
        return EXIT_SUCCESS;
      }
      await writeLines(context, [
        'Reading package lists... Done',
        'Building dependency tree... Done',
        'The following NEW packages will be installed:',
        '  net-tools',
        'Unpacking net-tools (2.10-alpha-2) ...',
        'Setting up net-tools (2.10-alpha-2) ...',
      ]);
      // v1 flips both of these in the callback that runs after its typing
      // animation finishes. There is no animation here — line-by-line reveal is
      // the renderer's business, not the command's — so the state moves when
      // the output is written.
      state.netToolsInstalled = true;
      state.ifconfigFailures = 0;
      return EXIT_SUCCESS;
    }

    // Everything else. v1 marked the first line `err`, so it is stream 2; the
    // second is the hint and stays on stream 1. 127 is POSIX's "command not
    // found", which is the claim the message makes.
    await writeError(
      context,
      SUDO_MANIFEST,
      'sudo: command not found',
      'CommandNotFoundException',
      'ObjectNotFound',
    );
    await writeLines(context, [
      'PowerShell elevates with Start-Process -Verb RunAs. (nice try)',
    ]);
    return EXIT_COMMAND_NOT_FOUND;
  });
}

export function privilegeCommands(environment: SimulatedEnvironment): readonly CommandModule[] {
  return [sudo(environment)];
}
