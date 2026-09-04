/**
 * processes.ts — `ps` and `Get-Process`, listing processes that do not exist.
 *
 * WHAT THESE DO NOT SHOW
 *
 * Not your computer's processes: a page cannot enumerate them, and nothing it
 * can reach comes close. Not this tab's either — the kernel in `src/kernel/`
 * has a real process table with real pids for the commands you run here, and
 * neither of these reads it. That is what the manifest note for `ps` means by
 * "that is what the kernel process table will report once it exists": the honest
 * list is a separate command over `ProcessTable`, not a quiet rewiring of this
 * one, because `ps` claiming to show six Unix daemons and then showing two
 * pipeline stages would be a third thing that is true of neither.
 *
 * Both declare `process.read` and both ask the broker for it. The list they
 * return is invented, so the grant buys nothing; asking anyway is what makes
 * the declaration in the manifest enforceable rather than decorative, and it
 * puts a line in the audit log that a reviewer can see.
 *
 * ---------------------------------------------------------------------------
 * WHY `Get-Process` EMITS OBJECTS AND `ps` EMITS TEXT
 * ---------------------------------------------------------------------------
 *
 * They are different kinds of command and v1 said so: `ps` is declared
 * `Application` — the native binary, which PowerShell on Linux deliberately
 * stops aliasing so the real one runs — while `Get-Process` is a Cmdlet. A
 * native command's output is text. A cmdlet's output is objects, and formatting
 * is the last step, never something the command does to itself.
 *
 * v1 could not make that distinction: it had one output channel and both
 * commands returned rendered rows, so `Get-Process | Sort-Object CPU` sorted
 * strings including the column padding. The text `ps` prints is byte-identical
 * to v1's; the objects `Get-Process` emits carry exactly the four facts v1's
 * table stated, and the parity test checks them against v1's own table cells.
 */

import { psObject } from '../../pipeline/psobject.ts';
import type { PSValue } from '../../pipeline/psobject.ts';
import type { CommandModule } from '../invocation.ts';
import { isBound, stringArray, switchValue, wildcardPattern } from '../powershell/support.ts';
import { MACHINE } from './environment.ts';
import {
  EXIT_FAILURE,
  EXIT_SUCCESS,
  argumentsOf,
  simulatedCommand,
  simulatedManifest,
  writeError,
  writeLines,
  writeValues,
} from './support.ts';

// ---------------------------------------------------------------------------
// the invented process list
// ---------------------------------------------------------------------------

/**
 * v1's six rows, transcribed from its `Get-Process` table.
 *
 * `rssMegabytes` is the `RSS(M)` column exactly as v1 printed it. There is no
 * finer figure anywhere in v1 for all six — its `ps aux` view lists only five
 * of them, in kibibytes, and omits `kubectl` entirely — so this is the whole of
 * what the archive states about their memory.
 */
interface SimulatedProcess {
  readonly id: number;
  readonly name: string;
  readonly cpuSeconds: number;
  readonly rssMegabytes: number;
}

const PROCESSES: readonly SimulatedProcess[] = [
  { id: 1006, name: 'pwsh', cpuSeconds: 12.83, rssMegabytes: 182 },
  { id: 1142, name: 'code-server', cpuSeconds: 48.21, rssMegabytes: 1204 },
  { id: 2612, name: 'chromium', cpuSeconds: 96.44, rssMegabytes: 2048 },
  { id: 8890, name: 'kubectl', cpuSeconds: 0.77, rssMegabytes: 96 },
  { id: 3120, name: 'containerd', cpuSeconds: 2.15, rssMegabytes: 154 },
  { id: 4471, name: 'sshd', cpuSeconds: 0.31, rssMegabytes: 42 },
];

const MEBIBYTE = 1024 * 1024;

// ---------------------------------------------------------------------------
// Get-Process
// ---------------------------------------------------------------------------

/**
 * The type chain real `Get-Process` reports, read off pwsh 7.6.5 with
 * `(Get-Process | Select-Object -First 1).PSObject.TypeNames`.
 */
const PROCESS_TYPE_NAMES: readonly string[] = [
  'System.Diagnostics.Process',
  'System.ComponentModel.Component',
  'System.MarshalByRefObject',
  'System.Object',
];

/**
 * WHICH PROPERTIES ARE FILLED, AND WHY THE REST ARE NOT.
 *
 * `Get-Process | Select-Object -First 1 | Format-List *` in pwsh 7.6.5 reports
 * seventy-odd properties. This emits five:
 *
 *   Id           v1 states it
 *   Name         v1 states it (real Process exposes the same string twice)
 *   ProcessName  v1 states it
 *   CPU          v1 states it, as seconds — which is what the real property is,
 *                `TotalProcessorTime.TotalSeconds`
 *   WS           v1's RSS(M) column expressed in bytes
 *
 * Everything else is OMITTED rather than filled: NPM, PM, VM, Handles, SI,
 * Path, CommandLine, Company, Description, Product, StartTime, Threads,
 * Modules, MainWindowTitle, Responding, and the rest. v1 states nothing about
 * any of them, so a value here would be a fact this project made up — and a
 * plausible `PagedMemorySize64` is worse than a missing one, because the
 * missing one is visibly missing while the plausible one is indistinguishable
 * from a measurement. `Get-Member` reporting five members where pwsh reports
 * seventy is the honest report of that, and it is the same limit
 * `powershell/support.ts` already declares for the intrinsic members of a
 * string.
 *
 * `WS` is a unit conversion of a stated figure rather than a new one, and it
 * round-trips: 182 -> 190840832 bytes -> 182 MiB exactly, so a formatter
 * rendering the real `WS(M)` column reproduces v1's number to the digit. That
 * is the whole reason it is derived from `Get-Process`'s own `RSS(M)` column
 * and not from the kibibyte figures in `ps aux` — those are v1's too, but they
 * are 181.95 MiB rather than 182, they exist for only five of the six, and
 * mixing the two sources would put a number in `Get-Process` that `Get-Process`
 * never said.
 */
function processObject(process: SimulatedProcess): PSValue {
  return psObject(
    {
      Id: process.id,
      Name: process.name,
      ProcessName: process.name,
      CPU: process.cpuSeconds,
      WS: process.rssMegabytes * MEBIBYTE,
    },
    PROCESS_TYPE_NAMES,
  );
}

/**
 * Parameters whose answers do not exist here at all.
 *
 * `-Module` and `-FileVersionInfo` ask for the loaded modules and the version
 * resource of an executable file. There is no executable and no file. Real
 * pwsh returns different OBJECT TYPES for these — the manifest's
 * `outputTypeNames` lists `ProcessModule` and `FileVersionInfo` for exactly
 * that reason — so answering with a Process would be the wrong type, and
 * answering with a fabricated module list would be inventing a load map.
 *
 * `-IncludeUserName` asks for the owning user. A page has no effective user;
 * `whoami` in this project says so in its own note, and the same is true here.
 */
const UNANSWERABLE: readonly (readonly [string, string])[] = [
  ['Module', 'there is no loaded module list to report'],
  ['FileVersionInfo', 'there is no executable file to read a version resource from'],
  ['IncludeUserName', 'a page has no effective user, so no process has an owner here'],
  [
    'InputObject',
    'there is no System.Diagnostics.Process anywhere in this page to hand back in',
  ],
];

const GET_PROCESS_MANIFEST = simulatedManifest('get-process');

function getProcess(): CommandModule {
  return simulatedCommand('get-process', async (context, bound) => {
    context.requireCapability('process.read');
    const parameters = bound.parameters;

    for (const [parameter, why] of UNANSWERABLE) {
      if (!isBound(parameters, parameter) || !switchValue(parameters, parameter)) continue;
      await writeError(
        context,
        GET_PROCESS_MANIFEST,
        `-${parameter} is not implemented by BrowserShell: ${why}. The process list this ` +
          'command returns is invented and describes no real or simulated program.',
        'NotImplemented',
        'NotImplemented',
      );
      return EXIT_FAILURE;
    }

    const names = stringArray(parameters, 'Name');
    const ids = stringArray(parameters, 'Id');

    if (ids !== undefined) {
      let failed = false;
      for (const raw of ids) {
        const id = Number(raw);
        const found = PROCESSES.filter((process) => process.id === id);
        if (found.length === 0) {
          // The real message and error id, read off pwsh 7.6.5. pwsh composes
          // the fully qualified id with the CMDLET CLASS name
          // (`...,Microsoft.PowerShell.Commands.GetProcessCommand`); this
          // engine's `errorRecord` composes it with the command's display name,
          // which is a difference in the shared helper rather than here.
          await writeError(
            context,
            GET_PROCESS_MANIFEST,
            `Cannot find a process with the process identifier ${raw}.`,
            'NoProcessFoundForGivenId',
            'ObjectNotFound',
          );
          failed = true;
          continue;
        }
        await writeValues(context, found.map(processObject));
      }
      return failed ? EXIT_FAILURE : EXIT_SUCCESS;
    }

    if (names !== undefined) {
      let failed = false;
      for (const pattern of names) {
        const regexp = wildcardPattern(pattern);
        const found = PROCESSES.filter((process) => regexp.test(process.name));
        if (found.length === 0) {
          await writeError(
            context,
            GET_PROCESS_MANIFEST,
            `Cannot find a process with the name "${pattern}". Verify the process name and ` +
              'call the cmdlet again.',
            'NoProcessFoundForGivenName',
            'ObjectNotFound',
          );
          failed = true;
          continue;
        }
        await writeValues(context, found.map(processObject));
      }
      return failed ? EXIT_FAILURE : EXIT_SUCCESS;
    }

    await writeValues(context, PROCESSES.map(processObject));
    return EXIT_SUCCESS;
  });
}

// ---------------------------------------------------------------------------
// ps
// ---------------------------------------------------------------------------

/**
 * v1's two views, byte for byte.
 *
 * The wide view is chosen by `/aux|-e|-f/` over the joined arguments, which is
 * v1's own test and is looser than the real `ps` — `ps --sort=-rss` contains no
 * `aux`, `-e` or `-f` and gets the narrow view, and `ps -x` matches nothing so
 * it does too. Kept as v1 wrote it.
 *
 * The wide view lists five processes and the narrow view lists two, and neither
 * matches the six `Get-Process` returns: `ps` invents a `ps` process for itself
 * (pid 9021) and omits `kubectl`, while `Get-Process` includes `kubectl` and
 * not `ps`. That inconsistency is v1's. It is preserved rather than
 * reconciled — these are two independent fictions and making them agree would
 * make them look like two views of one measurement.
 */
function ps(): CommandModule {
  return simulatedCommand('ps', async (context, bound) => {
    context.requireCapability('process.read');
    const flags = argumentsOf(bound).join(' ');
    const wide = /aux|-e|-f/u.test(flags);

    await writeLines(
      context,
      wide
        ? [
            'USER         PID %CPU %MEM    RSS TTY      STAT START   TIME COMMAND',
            `${MACHINE.user}      1006  0.4  1.1 186320 pts/0    Ss   09:12   0:12 pwsh`,
            `${MACHINE.user}      1142  2.1  7.6 1232400 ?       Sl   09:12   0:48 code-server`,
            `${MACHINE.user}      2612  6.8 12.8 2097664 ?       Sl   09:13   1:36 chromium`,
            'root         3120  0.2  0.9 157696 ?        Ssl  09:10   0:02 containerd',
            'root         4471  0.0  0.2  43008 ?        Ss   09:10   0:00 sshd',
          ]
        : [
            '    PID TTY          TIME CMD',
            '   1006 pts/0    00:00:12 pwsh',
            '   9021 pts/0    00:00:00 ps',
          ],
    );
    return EXIT_SUCCESS;
  });
}

// ---------------------------------------------------------------------------

export function processCommands(): readonly CommandModule[] {
  return [getProcess(), ps()];
}

/** Exported for the parity test, which compares these against v1's table cells. */
export { PROCESS_TYPE_NAMES, MEBIBYTE };
