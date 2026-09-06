/**
 * index.ts — the public surface of the renderer, and where the default is set.
 *
 * `createTerminal` exists so that "the semantic renderer is the default" is a
 * line of code rather than a convention. A host that wants ANSI has to name it;
 * a host that says nothing gets the accessible one, synchronously, with no
 * module to load.
 */

export {
  AnsiParser,
  applySgr,
  DEFAULT_COLOR,
  DEFAULT_STYLE,
  hasEscape,
  OMITTED,
  parseAnsi,
  stripAnsi,
  styleEquals,
  type AnsiColor,
  type AnsiEvent,
  type AnsiParam,
  type TextStyle,
} from './ansi.ts';

export {
  MAX_ROWS,
  rowText,
  runsOf,
  TAB_WIDTH,
  TerminalBuffer,
  type StyledRun,
  type TerminalCell,
  type UnsupportedSequence,
} from './grid.ts';

export type { TerminalPort, TerminalRendererKind } from './port.ts';

export {
  createSemanticTerminal,
  DEFAULT_LOG_LABEL,
  LOG_REGION_ATOMIC,
  LOG_REGION_LIVE,
  LOG_REGION_ROLE,
  ROW_CLASS,
  styleAttribute,
  styleClasses,
  type SemanticTerminalOptions,
  type TerminalDocument,
  type TerminalElement,
  type TerminalNode,
} from './semantic.ts';

export {
  activateUnicode,
  createPropertyValue,
  createXtermTerminal,
  extractShouldJoin,
  extractWidth,
  terminalOptions,
  unicodeProvider,
  UNICODE_VERSION,
  XTERM_SPECIFIER,
  type XtermModuleLike,
  type XtermTerminalLike,
  type XtermTerminalOptions,
  type XtermUnicodeHandling,
  type XtermUnicodeVersionProvider,
} from './xterm.ts';

import { createSemanticTerminal, type SemanticTerminalOptions } from './semantic.ts';
import type { TerminalPort } from './port.ts';
import { createXtermTerminal, type XtermTerminalOptions } from './xterm.ts';

/**
 * Pick a renderer.
 *
 * The semantic one is returned already built; the ANSI one is a promise,
 * because it has a module to fetch. The asymmetry in the return type is
 * deliberate and is the API telling the truth: only one of these two can be
 * had for free, and it is the default.
 */
export function createTerminal(
  options: SemanticTerminalOptions & { readonly renderer?: 'semantic' },
): TerminalPort;
export function createTerminal(
  options: XtermTerminalOptions & { readonly renderer: 'xterm' },
): Promise<TerminalPort>;
export function createTerminal(
  options:
    | (SemanticTerminalOptions & { readonly renderer?: 'semantic' })
    | (XtermTerminalOptions & { readonly renderer: 'xterm' }),
): TerminalPort | Promise<TerminalPort> {
  if (options.renderer === 'xterm') return createXtermTerminal(options);
  return createSemanticTerminal(options);
}
