/**
 * prediction.ts — the grey text after the caret.
 *
 * v1 had this, and it worked, with two flaws worth naming because they are the
 * reason this is a separate module rather than a copied function:
 *
 *   1. It scanned history newest-first and returned the first prefix match, so
 *      one stray command permanently outranked the one you run every day. There
 *      was no ranking at all, and therefore no way for provenance to matter.
 *   2. It matched case-insensitively but rendered `suggestion.slice(typed.length)`
 *      from the STORED line. Type `WHO`, have `whoami` in history, and the ghost
 *      showed `ami`; accepting it replaced the buffer with `whoami` and silently
 *      rewrote your capitalisation.
 *
 * The fix for (1) is to ask `HistoryEngine.recall`, which is where recency,
 * frequency, cwd affinity and origin weighting already live — so an agent's
 * commands cannot become your ghost text. The fix for (2) is to build the
 * suggestion from what the user actually typed plus the stored tail.
 *
 * The corpus fallback is kept: when history has nothing, completing a command
 * name from the inventory is still the most useful thing to show.
 */

import type { HistoryEngine, HistoryEntry, HistoryOrigin } from './history.ts';

export interface Prediction {
  /** The full line if accepted: what the user typed, plus the tail. */
  readonly suggestion: string;
  /** Just the tail — this is the ghost text to render after the caret. */
  readonly completion: string;
  /** The history entry behind it, or `null` when the corpus supplied it. */
  readonly entry: HistoryEntry | null;
  readonly source: 'history' | 'corpus';
}

export interface PredictOptions {
  /** Epoch milliseconds, injected so ranking is reproducible. */
  readonly now: number;
  readonly cwd?: string;
  readonly origins?: readonly HistoryOrigin[];
}

export interface PredictionEngineOptions {
  /**
   * Command names offered when history has no match, in the order they should
   * be tried. v1 used its sorted `CORPUS` here.
   */
  readonly corpus?: readonly string[];
  /** Turn the corpus fallback off entirely. */
  readonly useCorpus?: boolean;
}

export class PredictionEngine {
  readonly #history: HistoryEngine;
  readonly #corpus: readonly string[];
  readonly #useCorpus: boolean;

  constructor(history: HistoryEngine, options: PredictionEngineOptions = {}) {
    this.#history = history;
    this.#corpus = options.corpus ?? [];
    this.#useCorpus = options.useCorpus ?? true;
  }

  /**
   * The best continuation of `prefix`, or `null` when there is nothing to show.
   *
   * A prediction must be strictly longer than the prefix — v1's `h.length >
   * v.length` — otherwise the ghost is empty and the caret appears to have
   * grown a decoration.
   */
  predict(prefix: string, options: PredictOptions): Prediction | null {
    if (prefix === '') return null;

    const recallOptions =
      options.cwd === undefined
        ? { now: options.now, prefix, limit: 1 }
        : { now: options.now, prefix, cwd: options.cwd, limit: 1 };
    const ranked = this.#history.recall(
      options.origins === undefined ? recallOptions : { ...recallOptions, origins: options.origins },
    );

    const best = ranked[0];
    if (best !== undefined && best.source.length > prefix.length) {
      return {
        suggestion: prefix + best.source.slice(prefix.length),
        completion: best.source.slice(prefix.length),
        entry: best.entry,
        source: 'history',
      };
    }

    if (!this.#useCorpus) return null;
    const lower = prefix.toLowerCase();
    for (const name of this.#corpus) {
      if (name.length > prefix.length && name.toLowerCase().startsWith(lower)) {
        return {
          suggestion: prefix + name.slice(prefix.length),
          completion: name.slice(prefix.length),
          entry: null,
          source: 'corpus',
        };
      }
    }
    return null;
  }

  /**
   * The first word of a suggestion, for PSReadLine's accept-one-word gesture.
   * Takes the leading run of separators plus the following run of non-separators
   * so that repeated presses walk the suggestion instead of stalling on a space.
   */
  static firstWordOf(completion: string): string {
    const m = /^\s*\S+/.exec(completion);
    return m === null ? completion : m[0];
  }
}
