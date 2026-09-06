/**
 * from-ast.ts — binding a `CommandAst` without re-parsing anything.
 *
 * ── THE BUG THIS REMOVES, MEASURED ────────────────────────────────────────
 *
 * The binder used to take `readonly string[]`. Once the parser exists, handing
 * it strings means flattening the lexer's answer and then re-deriving it —
 * which is the same defect this whole roadmap item is about, at one remove.
 *
 * It is not theoretical. Measured on pwsh 7.6.5:
 *
 *     function Test-Q {
 *       [CmdletBinding()]
 *       param([switch] $Force, [Parameter(Position=0)][string] $Path)
 *     }
 *
 *     Test-Q -Force      ->  bound=[Force]   Path=[]
 *     Test-Q '-Force'    ->  bound=[Path]    Path=[-Force]
 *     Test-Q "-Force"    ->  bound=[Path]    Path=[-Force]
 *
 * A QUOTED `-Force` is an ARGUMENT, not the switch. pwsh's lexer says so
 * directly — `Parameter("-Force")` versus `StringLiteral("'-Force'")` — and so
 * does ours. Serialising to `['-Force']` throws that distinction away, and the
 * binder, asked to re-derive it from the string, binds the switch. The command
 * then does something the user did not ask for, quietly.
 *
 * So this module maps AST elements straight onto `BindArgument`, where a
 * `CommandParameterAst` is a parameter and every expression is a value, and
 * nothing re-reads a dash.
 */

import type { CommandAst, CommandElementAst } from '../language/ast.ts';
// The decoded text of an expression, from the AST module rather than from a
// copy here. There WAS a copy here, character for character the same as
// `parse.ts`'s, and once the kernel stopped calling `commandArguments` the
// other one had no production caller left to keep it honest.
import { expressionText } from '../language/ast.ts';
import type { CommandManifest } from '../commands/manifest.ts';
import type { CompatibilityView } from '../commands/invocation.ts';

import {
  bindParameters,
  tryBindParameters,
  type BindArgument,
  type BindOptions,
  type BindingOutcome,
  type BindingSuccess,
} from './binder.ts';

/**
 * A command's arguments, classified the way the LEXER classified them.
 *
 * The head element is dropped: it is the command name, and the binder binds
 * only what follows it.
 */
export function bindCommandArguments(command: CommandAst): readonly BindArgument[] {
  const args: BindArgument[] = [];
  for (const element of command.elements.slice(1)) {
    args.push(argumentOf(element));
  }
  return args;
}

function argumentOf(element: CommandElementAst): BindArgument {
  if (element.kind === 'CommandParameterAst') {
    return {
      kind: 'parameter',
      name: element.parameterName,
      // `-Name:` with nothing after it never reaches here as an empty string by
      // accident: the parser records MissingArgument and leaves `argument` null,
      // and a null attached is "no colon", which is a different thing. The
      // empty-string case the binder still checks comes from the string path.
      attached: element.argument === null ? null : expressionText(element.argument),
      text: element.extent.text,
    };
  }
  return { kind: 'value', text: expressionText(element) };
}

/** Bind a parsed command. Throws `ParameterBindingError` on failure. */
export function bindCommand(
  command: CommandAst,
  manifest: CommandManifest,
  profile: CompatibilityView,
  options: BindOptions = {},
): BindingSuccess {
  return bindParameters(bindCommandArguments(command), manifest, profile, options);
}

/** Bind a parsed command, returning the failure instead of throwing it. */
export function tryBindCommand(
  command: CommandAst,
  manifest: CommandManifest,
  profile: CompatibilityView,
  options: BindOptions = {},
): BindingOutcome {
  return tryBindParameters(bindCommandArguments(command), manifest, profile, options);
}
