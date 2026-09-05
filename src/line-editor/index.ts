/**
 * index.ts — the public surface of the headless line editor.
 *
 * Everything reachable from here is pure: no `document`, no `window`, no
 * `KeyboardEvent`, no `HTMLElement`. Geometry arrives through `TerminalMetrics`
 * and time through an injected clock. That is the acceptance condition for
 * roadmap PR-05 ("LineEditorCore has zero DOM imports"), and it is checkable —
 * the test suite greps this directory for DOM identifiers.
 *
 * The input and render adapters live outside this module and depend on it, never
 * the other way round.
 */

export {
  graphemeBoundaries,
  graphemeIndexAt,
  graphemeLength,
  hasIntlSegmenter,
  nextBoundary,
  prevBoundary,
  segmentGraphemes,
  segmentGraphemesFallback,
  snapToBoundary,
  snapWithin,
} from './graphemes.ts';

export {
  charClassOf,
  DEFAULT_WORD_DELIMITERS,
  TextBuffer,
  visibleLength,
  type CharClass,
} from './text-buffer.ts';

export {
  DEFAULT_NAVIGATION_ORIGINS,
  DEFAULT_RANKING_WEIGHTS,
  HISTORY_ORIGINS,
  HistoryEngine,
  type HistoryEngineOptions,
  type HistoryEntry,
  type HistoryMatch,
  type HistoryOrigin,
  type HistoryOutcome,
  type HistoryRecord,
  type RankingWeights,
  type RecallOptions,
} from './history.ts';

export { quoteIfNeeded, tokenize, type Token, type TokenKind } from './tokenize.ts';

export {
  CommandInventory,
  COMMON_PARAMETERS,
  MANIFEST_COMMANDS,
  declaredInventory,
  manifestInventory,
  type CommandEntry,
  type InventoryOptions,
  type ManifestLike,
  type ParameterEntry,
} from './inventory.ts';

export {
  CompletionEngine,
  fuzzyScore,
  matchCandidate,
  resolveCompletionContext,
  type ArgumentSource,
  type ArgumentSuggestion,
  type CompletionCandidate,
  type CompletionContext,
  type CompletionContextKind,
  type CompletionEngineOptions,
  type CompletionResult,
  type MatchKind,
} from './completion.ts';

export {
  chordOf,
  EMACS_BINDINGS,
  isPrintableKey,
  KeyBindingEngine,
  normalizeKey,
  type EditorAction,
  type EditorKeyEvent,
  type KeyBindingMap,
} from './keys.ts';

export {
  PredictionEngine,
  type PredictionEngineOptions,
  type Prediction,
  type PredictOptions,
} from './prediction.ts';

export {
  cellWidthOf,
  DEFAULT_METRICS,
  displayWidth,
  monospaceMetrics,
  type TerminalMetrics,
} from './metrics.ts';

export {
  LineEditor,
  type CompletionMenuView,
  type EditorEffect,
  type LineEditorOptions,
  type LineEditorView,
  type ReverseSearchView,
} from './editor.ts';
