/**
 * Set-Location (cd, chdir, sl) — move the shell.
 *
 * ── ONE v1 BEHAVIOUR THIS DOES NOT REPRODUCE, RECORDED WHERE IT BELONGS ───
 *
 * In v1 this command's own `run(a, raw)` opens with
 *
 *     if(String(raw[0]).toLowerCase()==='sl' && raw.length===1) return EGGS.sl();
 *
 * (`legacy/terminal-v1.html:789`). So `sl` prints a steam locomotive, `sl /tmp`
 * changes directory, and bare `cd` goes home — three different answers keyed on
 * WHICH NAME the command was invoked by.
 *
 * This cannot be written here yet, and the blocker is ours rather than v1's:
 * `InvocationContext` carries no invocation name, so nothing reaching this
 * function can distinguish bare `sl` from bare `Set-Location`. The train is
 * implemented and tested in `src/commands/simulated/jokes.ts` against the
 * captured v1 archive — that is the evidence of what it should print — but it
 * owns no token, and `sl` resolves here. When the context can say how it was
 * typed, the branch belongs at the top of this command, where v1 puts it.
 * See `SHADOWED_V1_TOKENS` in `src/commands/rewrite-inventory.data.mts`.
 *
 * WHAT THE PROBE CORRECTED, and this one is genuinely strange:
 *
 *   THE ERROR FOR A FILE SAYS THE FILE DOES NOT EXIST, AND NAMES THE PATH THE
 *   USER TYPED RATHER THAN THE RESOLVED ONE.
 *
 *     pwsh: Set-Location alpha.txt        (the file exists)
 *           -> PathNotFound,...SetLocationCommand, ObjectNotFound,
 *              ItemNotFoundException,
 *              "Cannot find path 'alpha.txt' because it does not exist."
 *     pwsh: Set-Location ./alpha.txt
 *           -> "Cannot find path './alpha.txt' because it does not exist."
 *     pwsh: Set-Location <absolute>/alpha.txt
 *           -> "Cannot find path '<absolute>/alpha.txt' because it does not exist."
 *
 *   versus a target that really is absent, which reports the RESOLVED path:
 *
 *     pwsh: Set-Location nowhere
 *           -> "Cannot find path '<cwd>/nowhere' because it does not exist."
 *
 * So the same error id and the same sentence carry two different path forms,
 * decided by whether the item exists. v1 said `'<p>' is not a directory.` for
 * the first case, which is clearer and is NOT what the reference implementation
 * does; pwsh is followed here because pwsh defines this command.
 *
 * THE OTHER MEASUREMENTS:
 *
 *   pwsh: Set-Location sub               ->  emits NOTHING
 *   pwsh: Set-Location .. -PassThru      ->  System.Management.Automation.PathInfo
 *                                            (Drive, Path, Provider, ProviderPath)
 *   pwsh: Set-Location                   ->  goes to the home directory
 *   pwsh: Set-Location 's*b'             ->  works; one container is fine
 *   pwsh: Set-Location '*'               ->  Argument,...SetLocationCommand,
 *         "Cannot set the location because path '*' resolved to multiple
 *          containers. You can only set the location to a single container at a
 *          time."
 *
 * NOT IMPLEMENTED, and why. `cd -` and `cd +` work in pwsh 7 (they walk the
 * location history) and `-StackName` selects a named location stack. Both need
 * per-SESSION state, and a command module here is a module-level singleton
 * shared by every session the host runs — putting the history in a closure would
 * make one tab's `cd -` follow another tab's `cd`. `InvocationContext` has no
 * place to keep it, so the honest answer is to say so rather than to keep a
 * global that is wrong the moment there are two sessions. v1 had neither.
 */

import { throwIfCancelled } from '../../pipeline/pipeline.ts';
import type { BindingResult, CommandModule, InvocationContext } from '../invocation.ts';
import { pathInfo, providerLocationOf } from '../native/index.ts';
import { isBound, stringValue, switchValue } from '../powershell/support.ts';
import {
  SET_LOCATION,
  commandError,
  emit,
  fsReadManifest,
  globPath,
  requirePort,
  storageErrorRecord,
} from './support.ts';
import type { FsErrorIds } from './support.ts';

const MANIFEST = fsReadManifest('set-location');

export const SET_LOCATION_ERROR_IDS: FsErrorIds = {
  notFound: 'PathNotFound',
  // NOT MEASURED. Windows' traverse ACL could not be made to produce a
  // Set-Location denial in the probe, so the id is the generic one; the message
  // and the PermissionDenied/UnauthorizedAccessException pair ARE measured, from
  // Get-Content and Get-ChildItem on a denied path.
  accessDenied: 'UnauthorizedAccessError',
};
const IDS = SET_LOCATION_ERROR_IDS;

export const setLocation: CommandModule = {
  manifest: MANIFEST,

  async invoke(context: InvocationContext, bound: BindingResult): Promise<number> {
    const parameters = bound.parameters;
    throwIfCancelled(context.signal, 'Set-Location');

    if (isBound(parameters, 'StackName')) {
      await context.streams.error.write(
        commandError(
          SET_LOCATION,
          '-StackName is not implemented: location stacks are per-session state, and a command ' +
            'module here is shared by every session the host runs. Push-Location and Pop-Location ' +
            'are where that state would belong.',
          'ParameterNotImplemented',
          'NotImplemented',
          'System.NotImplementedException',
        ),
      );
      return 1;
    }

    const literal = stringValue(parameters, 'LiteralPath');
    const typed = literal ?? stringValue(parameters, 'Path');

    if (typed === '-' || typed === '+') {
      await context.streams.error.write(
        commandError(
          SET_LOCATION,
          `'${typed}' is not implemented: it walks the session's location history, which this ` +
            'engine has nowhere to keep — a command module is shared by every session, so a ' +
            'history kept here would let one session move another.',
          'NotImplemented',
          'NotImplemented',
          'System.NotImplementedException',
          typed,
        ),
      );
      return 1;
    }

    const fs = await requirePort(context, SET_LOCATION);
    if (fs === null) return 1;

    // No argument at all goes home. Measured, and it is also what v1 did
    // (`if(!t){ CWD=HOME; ... }`).
    const request = typed === undefined || typed === '' ? '~' : typed;

    // A wildcard has to resolve to exactly one container before anything moves
    // — on the FILESYSTEM. A flat provider has exactly one container, its drive
    // root, so a wildcard there can never resolve to more than one and globbing
    // it would mean reading every item to answer a question whose answer is
    // fixed. The resolve is cheap and touches no storage.
    let destination = request;
    const registry = context.providers;
    const target = fs.resolve(request);
    const onFileSystem = registry === null || !target.ok || !registry.handles(target.value.drive);
    if (literal === undefined && onFileSystem) {
      const globbed = await globPath(fs, request);
      if (!globbed.ok) {
        await context.streams.error.write(
          storageErrorRecord(SET_LOCATION, globbed.error, request, IDS),
        );
        return 1;
      }
      const containers: string[] = [];
      for (const candidate of globbed.value) {
        const stat = await fs.stat(candidate.full);
        if (stat.ok && stat.value.kind === 'directory') containers.push(candidate.full);
      }
      if (containers.length > 1) {
        await context.streams.error.write(
          commandError(
            SET_LOCATION,
            `Cannot set the location because path '${request}' resolved to multiple containers. ` +
              'You can only set the location to a single container at a time.',
            'Argument',
            'InvalidArgument',
            'System.ArgumentException',
            request,
          ),
        );
        return 1;
      }
      // One container: use it. Zero: fall through to `setLocation` so the
      // failure comes from the filesystem with the right path in the message.
      destination = containers[0] ?? (globbed.value[0]?.full ?? request);
    }

    const moved = await fs.setLocation(destination);
    if (!moved.ok) {
      // The path form in the message is decided by whether the item exists —
      // see the header. ENOTDIR is the storage layer's way of saying "it is
      // there, but it is a file", which is the case pwsh reports with the raw
      // argument.
      //
      // THE SAME SPLIT HOLDS ON A PROVIDER DRIVE, which is why nothing here
      // changed for PR-10. MEASURED, pwsh 7.6.5:
      //
      //   Set-Location Env:zzLeaf             (the item EXISTS)
      //     -> "Cannot find path 'Env:zzLeaf' because it does not exist."
      //   Set-Location Env:zzTotallyMissing   (it does not)
      //     -> "Cannot find path 'Env:\zzTotallyMissing' because it does not exist."
      //
      // raw argument for the first, resolved path for the second — exactly the
      // filesystem's rule. `ProviderRegistry.canEnter` returns ENOTDIR for a
      // leaf and ENOENT for a miss so that both fall out of this one line.
      const displayPath = moved.error.code === 'ENOTDIR' ? request : moved.error.path;
      await context.streams.error.write(
        storageErrorRecord(SET_LOCATION, moved.error, displayPath, IDS),
      );
      return 1;
    }

    // Nothing is emitted unless -PassThru. Measured: `@(Set-Location sub).Count`
    // is 0.
    if (!switchValue(parameters, 'PassThru')) return 0;

    const home = fs.resolve('~');
    const location = providerLocationOf(context.providers, moved.value);
    await emit(
      context.streams.success,
      context.signal,
      location === null
        ? pathInfo(moved.value.full, home.ok ? home.value.full : moved.value.full)
        : pathInfo(moved.value.full, home.ok ? home.value.full : moved.value.full, location),
    );
    return 0;
  },
};
