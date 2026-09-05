/**
 * set-theme.ts — `Set-Theme`, the one command here that touches no file.
 *
 * `preferences.write` is its own capability, and a theme is deliberately not a
 * file: `ports.ts` puts it behind `PreferencesPort` "because it is separate in
 * the capability taxonomy … and because a theme is not a file a visitor should
 * be able to `rm`". This command therefore never sees `context.fs` at all, and
 * declares no filesystem capability.
 *
 * There is NO REFERENCE IMPLEMENTATION for it. Measured: `Get-Command Set-Theme`
 * and `Get-Command theme` in pwsh 7.6.5 both report nothing — it is v1's
 * invention, so v1 is the only specification there is, and it was read rather
 * than remembered:
 *
 *     const THEMES=['campbell','pi','blue'];
 *     const THEME_ALIAS={windows:'campbell',dark:'campbell',default:'campbell'};
 *     function setTheme(t){ t=THEME_ALIAS[t]||t; if(THEMES.indexOf(t)<0) return false;
 *       … try{ localStorage.setItem('thc1006.theme',t); }catch(e){} return true; }
 *
 *     'set-theme': run: function(a,raw){
 *       let t=String(argOf(a,'Name')||firstArg(raw)||'').toLowerCase();
 *       if(setTheme(t)) return [line('ok','Theme set to '+t)];
 *       return [line('muted','Available themes: '+THEMES.join(' · ')+'  (e.g. Set-Theme pi)')]; }
 *
 * Four facts fall straight out of that and are kept: three schemes, three
 * aliases, the name is lower-cased before anything else, and the preference key
 * is `thc1006.theme` — the same key v1 wrote, so a returning visitor's theme
 * survives the rewrite instead of silently reverting.
 *
 * ── TWO DECLARED DIVERGENCES ──────────────────────────────────────────────
 *
 *   AN UNKNOWN NAME IS AN ERROR. v1 prints the available list as a `muted`
 *   line — informational, not red — so `Set-Theme nonsense` reports success and
 *   `$?` would be true for a command that did nothing. The list is still shown,
 *   in the same words, but as an ErrorRecord on stream 2 with exit 1. This is
 *   the judgement `simulated/support.ts` describes: which lines are errors is
 *   decided per command by what they MEAN, not by which CSS class v1 painted
 *   them with, and "I was asked to set a theme and did not" is a failure.
 *
 *   THE RESOLVED NAME IS REPORTED. v1 echoes what was TYPED — `Set-Theme dark`
 *   prints `Theme set to dark` while storing `campbell`, because `setTheme`
 *   resolves the alias in its own local copy of the argument. What is stored is
 *   what happened, so that is what is reported.
 */

import type { CommandModule } from '../invocation.ts';
import { stringValue } from '../powershell/support.ts';
import {
  EXIT_FAILURE,
  EXIT_SUCCESS,
  argumentsOf,
  firstArgument,
  fsManageCommand,
  needPreferences,
  writeError,
  writeValues,
} from './support.ts';

/**
 * The key v1 wrote, kept byte for byte.
 *
 * Changing it would not be a rename: a visitor who chose `pi` in the shipped
 * terminal would come back to `campbell` and nothing would explain why.
 */
export const THEME_PREFERENCE_KEY = 'thc1006.theme';

/** campbell is the terminal default's real name; the other two are v1's. */
export const THEMES: readonly string[] = ['campbell', 'pi', 'blue'];

/** Older names v1 kept working. `windows` and `dark` both meant campbell. */
export const THEME_ALIASES: Readonly<Record<string, string>> = {
  windows: 'campbell',
  dark: 'campbell',
  default: 'campbell',
};

/** v1's own sentence, reused so the two terminals answer the same question the same way. */
const AVAILABLE = `Available themes: ${THEMES.join(' · ')}  (e.g. Set-Theme pi)`;

/** Lower-case, then resolve an alias. Null when it is not a scheme. */
export function resolveTheme(name: string): string | null {
  const lowered = name.trim().toLowerCase();
  const resolved = THEME_ALIASES[lowered] ?? lowered;
  return THEMES.includes(resolved) ? resolved : null;
}

export const setTheme: CommandModule = fsManageCommand(
  'set-theme',
  async (context, bound, manifest) => {
    // Declared, audited, and not brokered — `PreferencesPort` is handed over
    // whole — so the command asks. A denial arrives as an ErrorRecord.
    context.requireCapability('preferences.write');

    const preferences = await needPreferences(context, manifest);
    if (preferences === null) return EXIT_FAILURE;

    // v1's `argOf(a,'Name') || firstArg(raw)`. The bound parameter first, then
    // the bare positional form the boot banner advertises (`Set-Theme pi`).
    // `||` and not `??`: v1 falls through on an EMPTY -Name as well as an
    // absent one, and `-Name '' pi` is a shape a person can type.
    const named = stringValue(bound.parameters, 'Name');
    const typed =
      named !== undefined && named.trim() !== '' ? named : firstArgument(argumentsOf(bound));

    if (typed.trim() === '') {
      await writeError(context, manifest, {
        message: `Cannot set the theme: no name was given. ${AVAILABLE}`,
        errorId: 'ThemeNameRequired',
        category: 'InvalidArgument',
        exceptionType: 'System.ArgumentException',
      });
      return EXIT_FAILURE;
    }

    const resolved = resolveTheme(typed);
    if (resolved === null) {
      await writeError(context, manifest, {
        message: `Cannot set the theme: '${typed}' is not a colour scheme. ${AVAILABLE}`,
        errorId: 'UnknownTheme',
        category: 'InvalidArgument',
        exceptionType: 'System.ArgumentException',
        target: typed,
      });
      return EXIT_FAILURE;
    }

    try {
      preferences.set(THEME_PREFERENCE_KEY, resolved);
    } catch (reason) {
      // v1 swallows this (`try{ localStorage.setItem(…) }catch(e){}`), which is
      // the coupling `storage/types.ts` objects to: a preference that silently
      // did not persist is invisible to `$?` and to a script.
      await writeError(context, manifest, {
        message:
          `The theme could not be saved: ${reason instanceof Error ? reason.message : String(reason)}. ` +
          'Nothing was changed.',
        errorId: 'PreferenceWriteFailed',
        category: 'WriteError',
        exceptionType: 'System.InvalidOperationException',
        target: THEME_PREFERENCE_KEY,
      });
      return EXIT_FAILURE;
    }

    await writeValues(context, [`Theme set to ${resolved}`]);
    return EXIT_SUCCESS;
  },
);
