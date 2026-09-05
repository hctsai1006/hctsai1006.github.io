/**
 * history.ts — an append-only command log that knows WHO typed each line.
 *
 * v1 stored history as bare strings in an array capped at 300 (`hist.push(cmd)`),
 * with no dedup, no ranking and no provenance. That is also, near enough, what
 * PSReadLine stores, and it is the reason for PSReadLine issue #5123 (open,
 * un-triaged at the time of writing): once an AI agent or a script runs commands
 * through the same shell, its lines enter the same undifferentiated list. The
 * user's arrow-key history fills with commands they never typed, and — worse,
 * because it is silent — frequency-based ranking starts recommending the agent's
 * habits back to the human.
 *
 * Retrofitting provenance onto a `string[]` is impossible: the information was
 * never captured. So every entry carries it from the start, and two separate
 * mechanisms use it:
 *
 *   1. `recall()` ranks, and by default refuses to let a non-`user` entry
 *      outrank a `user` one no matter how often the agent repeated it
 *      (`userPrecedence`). Frequency is also WEIGHTED by origin, so a thousand
 *      agent invocations cannot outvote the one time you typed it yourself.
 *   2. `DEFAULT_NAVIGATION_ORIGINS` excludes `ai` from plain arrow-key recall,
 *      which is the pollution half of the same complaint.
 *
 * Both are data, not policy baked into the algorithm; a host that wants the
 * upstream behaviour can pass different weights.
 *
 * Nothing in here reads a clock. `createdAt` arrives on the record and `now`
 * arrives on the query, because a ranking function that calls `Date.now()`
 * cannot be tested and cannot be replayed.
 */

/**
 * Who caused this line to run.
 *
 * `completion` is still the human — it marks a line accepted from the completion
 * menu rather than typed character by character, which is worth keeping separate
 * because those lines are systematically longer and would otherwise skew
 * prediction. `script` is a line executed from a file. `ai` is an agent.
 */
export type HistoryOrigin = 'user' | 'completion' | 'ai' | 'script';

export const HISTORY_ORIGINS: readonly HistoryOrigin[] = ['user', 'completion', 'ai', 'script'];

/** What the host knows at the moment a line is submitted or finishes. */
export interface HistoryRecord {
  /** The command line exactly as it will be replayed. */
  readonly source: string;
  readonly cwd: string;
  /** Which compatibility profile was active, e.g. `7.6.5`. */
  readonly compatibilityProfile: string;
  readonly origin: HistoryOrigin;
  /** `null` while the command is still running or was never executed. */
  readonly exitCode: number | null;
  readonly durationMs: number | null;
  /** Epoch milliseconds. Supplied, never sampled here. */
  readonly createdAt: number;
}

export interface HistoryEntry extends HistoryRecord {
  /** Monotonic, assigned on append. Stable across settling and eviction. */
  readonly id: number;
}

/** The outcome of a command, learned after `append`. */
export interface HistoryOutcome {
  readonly exitCode: number | null;
  readonly durationMs: number | null;
}

/**
 * Weights for `recall`. All of it is data so a Vi-style or upstream-compatible
 * host can swap the policy without forking the ranker.
 */
export interface RankingWeights {
  readonly recency: number;
  readonly frequency: number;
  readonly cwd: number;
  /**
   * Half-life of the recency term. An entry this old scores 0.5 on recency.
   * One hour suits a session-scoped shell: within a session recency dominates,
   * across sessions frequency does.
   */
  readonly recencyHalfLifeMs: number;
  /**
   * Occurrences needed for the frequency term to reach 0.5. Saturating rather
   * than linear, so a runaway loop cannot pin every other entry to zero.
   */
  readonly frequencyMidpoint: number;
  /**
   * Per-origin multiplier, and the weight one occurrence contributes to the
   * frequency count. `ai` is deliberately low: this is the #5123 fix.
   */
  readonly origin: Readonly<Record<HistoryOrigin, number>>;
  /**
   * Multiplier for a line whose last run failed. A command that errored is a
   * worse suggestion than one that worked, and the manifest already made us
   * record the exit code.
   */
  readonly failurePenalty: number;
  /**
   * When true, `user` lines rank strictly above every non-`user` line, whatever
   * the blended score says. A multiplier alone cannot promise that — enough
   * repetitions always win — and the promise is the point of the feature.
   */
  readonly userPrecedence: boolean;
}

export const DEFAULT_RANKING_WEIGHTS: RankingWeights = {
  recency: 1,
  frequency: 0.8,
  cwd: 0.6,
  recencyHalfLifeMs: 60 * 60 * 1000,
  frequencyMidpoint: 3,
  origin: { user: 1, completion: 0.9, script: 0.4, ai: 0.15 },
  failurePenalty: 0.6,
  userPrecedence: true,
};

/**
 * Origins offered to plain Up/Down arrow recall.
 *
 * `ai` is absent on purpose: roadmap task 5.4 exists so that agent-issued
 * commands "cannot pollute the user's arrow-key history". They remain in the
 * log, remain visible to `Get-History`, and remain reachable through Ctrl+R
 * search — they just are not what Up-arrow hands you.
 */
export const DEFAULT_NAVIGATION_ORIGINS: readonly HistoryOrigin[] = ['user', 'completion', 'script'];

export interface RecallOptions {
  /** Epoch milliseconds. Required, because the ranker must not read a clock. */
  readonly now: number;
  /** Case-insensitive prefix, as PSReadLine's history prediction matches. */
  readonly prefix?: string;
  /** Case-insensitive substring, as Ctrl+R reverse search matches. */
  readonly contains?: string;
  /** Working directory to score proximity against. */
  readonly cwd?: string;
  readonly limit?: number;
  readonly origins?: readonly HistoryOrigin[];
  readonly weights?: RankingWeights;
}

/** One deduplicated command line, with the evidence behind its rank. */
export interface HistoryMatch {
  /** The best-scoring occurrence; its provenance represents the group. */
  readonly entry: HistoryEntry;
  readonly source: string;
  readonly score: number;
  /** How many times this exact line appears in the log. */
  readonly occurrences: number;
  /** Occurrences summed with each origin's weight — the ranking input. */
  readonly weightedFrequency: number;
  /** The strongest origin present among the occurrences. */
  readonly origin: HistoryOrigin;
}

export interface HistoryEngineOptions {
  /** Oldest entries are dropped past this. v1 used 300; PSReadLine uses 4096. */
  readonly capacity?: number;
  readonly weights?: RankingWeights;
}

const DEFAULT_CAPACITY = 4096;

/** Higher wins. Used for both the precedence tier and group representation. */
const ORIGIN_TIER: Readonly<Record<HistoryOrigin, number>> = {
  user: 3,
  completion: 2,
  script: 1,
  ai: 0,
};

/**
 * Compare two paths the way this shell compares them: EXACTLY, apart from a
 * trailing slash.
 *
 * This used to lower-case the path and rewrite `\` to `/`, justified as
 * "because the emulated filesystem is [case-insensitive], and because a history
 * entry recorded as `C:/Users/x` must still match a cwd of `C:\Users\x\`".
 * BOTH HALVES WERE FALSE, and both were measured against this repository's own
 * storage rather than argued about:
 *
 *   mkdir /tmp/Docs; stat /tmp/docs      -> not found
 *   mkdir /tmp/docs alongside /tmp/Docs  -> CREATED; /tmp holds both
 *   mkdir '/tmp/we\ird'                  -> created a file NAMED `we\ird`
 *   stat '/tmp\a'                        -> not found; `\` is not a separator
 *
 * The mount is `/`, not `C:`. This emulates Ubuntu, where a path is a sequence
 * of bytes: `Docs` and `docs` are two directories, and a backslash is an
 * ordinary character in a name.
 *
 * So the old normalisation merged two real directories into one, and merged a
 * directory literally called `we\ird` with the path `we/ird`. Neither shows up
 * as an error — it comes out as history recalling a command from somewhere the
 * user has never been, ranked as though it came from where they are.
 *
 * The trailing-slash trim stays: `/tmp` and `/tmp/` are the same directory
 * under any rule, and a cwd may or may not carry one.
 */
function normalizePath(path: string): string {
  return path.length > 1 && path.endsWith('/') ? path.slice(0, -1) : path;
}

/**
 * The key two history lines are the SAME line under.
 *
 * PowerShell resolves command names case-insensitively — `Get-ChildItem` and
 * `get-childitem` are one command — so the name folds. Nothing after it does:
 * the filesystem is case-sensitive (measured above), so `cat README` and
 * `cat readme` name different files and merging them recalls the wrong one.
 * The whole line used to fold, so they were one entry.
 *
 * Parameter names are case-insensitive too, so `ls -Recurse` and `ls -recurse`
 * stay two groups where PowerShell would call them one. That is deliberate:
 * telling a parameter from a value needs the binder, and this errs toward
 * keeping two entries that could be one rather than merging two that are not.
 * A redundant history line is untidy; a merged one is a wrong answer.
 */
function groupKey(source: string): string {
  const match = /^(\s*)(\S+)([\s\S]*)$/.exec(source);
  if (match === null) return source;
  return `${match[1] ?? ''}${(match[2] ?? '').toLowerCase()}${match[3] ?? ''}`;
}

/** 1 for the same directory, 0.5 for an ancestor/descendant, 0 for unrelated. */
function cwdAffinity(entryCwd: string, queryCwd: string): number {
  const a = normalizePath(entryCwd);
  const b = normalizePath(queryCwd);
  if (a === b) return 1;
  if (a.startsWith(`${b}/`) || b.startsWith(`${a}/`)) return 0.5;
  return 0;
}

export class HistoryEngine {
  #entries: HistoryEntry[] = [];
  #nextId = 1;
  readonly capacity: number;
  readonly weights: RankingWeights;

  constructor(options: HistoryEngineOptions = {}) {
    this.capacity = options.capacity ?? DEFAULT_CAPACITY;
    this.weights = options.weights ?? DEFAULT_RANKING_WEIGHTS;
  }

  /** Oldest first, which is the order Get-History prints. */
  get entries(): readonly HistoryEntry[] {
    return this.#entries;
  }

  get size(): number {
    return this.#entries.length;
  }

  /**
   * Append a line. Blank and whitespace-only lines are refused, as in v1.
   * The stored `source` is trimmed; the caller keeps the raw text for echoing.
   */
  append(record: HistoryRecord): HistoryEntry | null {
    const source = record.source.trim();
    if (source === '') return null;
    const entry: HistoryEntry = { ...record, source, id: this.#nextId++ };
    this.#entries.push(entry);
    if (this.#entries.length > this.capacity) {
      this.#entries.splice(0, this.#entries.length - this.capacity);
    }
    return entry;
  }

  /**
   * Record the outcome of an already-appended line.
   *
   * The log stays append-only in the sense that matters — nothing is removed or
   * reordered — but `durationMs` cannot be known when the line is submitted, and
   * a history whose duration is always `null` would make that field a lie.
   */
  settle(id: number, outcome: HistoryOutcome): HistoryEntry | null {
    const index = this.#entries.findIndex((e) => e.id === id);
    if (index < 0) return null;
    const existing = this.#entries[index];
    if (existing === undefined) return null;
    const settled: HistoryEntry = {
      ...existing,
      exitCode: outcome.exitCode,
      durationMs: outcome.durationMs,
    };
    this.#entries[index] = settled;
    return settled;
  }

  byId(id: number): HistoryEntry | null {
    return this.#entries.find((e) => e.id === id) ?? null;
  }

  /**
   * Chronological walk backwards from `fromIndex` (exclusive), newest first.
   * This is Up-arrow: sequential, not ranked, because a recall order that
   * reshuffles under you is unusable for stepping through what you just ran.
   * Returns -1 when there is nothing further back.
   */
  previousIndex(
    fromIndex: number,
    prefix = '',
    origins: readonly HistoryOrigin[] = DEFAULT_NAVIGATION_ORIGINS,
  ): number {
    const needle = prefix.toLowerCase();
    for (let i = Math.min(fromIndex, this.#entries.length) - 1; i >= 0; i -= 1) {
      const e = this.#entries[i];
      if (e === undefined) continue;
      if (!origins.includes(e.origin)) continue;
      if (needle !== '' && !e.source.toLowerCase().startsWith(needle)) continue;
      return i;
    }
    return -1;
  }

  /** Forward counterpart of `previousIndex`. Returns -1 past the newest entry. */
  nextIndex(
    fromIndex: number,
    prefix = '',
    origins: readonly HistoryOrigin[] = DEFAULT_NAVIGATION_ORIGINS,
  ): number {
    const needle = prefix.toLowerCase();
    for (let i = Math.max(fromIndex, -1) + 1; i < this.#entries.length; i += 1) {
      const e = this.#entries[i];
      if (e === undefined) continue;
      if (!origins.includes(e.origin)) continue;
      if (needle !== '' && !e.source.toLowerCase().startsWith(needle)) continue;
      return i;
    }
    return -1;
  }

  /**
   * Ranked, deduplicated recall. Feeds Ctrl+R and the prediction engine.
   *
   * Deduplication happens here and not on append: collapsing at write time would
   * destroy the provenance of every occurrence but the last, which is exactly
   * the evidence the origin weighting needs.
   */
  recall(options: RecallOptions): HistoryMatch[] {
    const weights = options.weights ?? this.weights;
    const origins = options.origins ?? HISTORY_ORIGINS;
    const prefix = (options.prefix ?? '').toLowerCase();
    const contains = (options.contains ?? '').toLowerCase();
    const cwd = options.cwd;

    interface Group {
      best: HistoryEntry;
      bestBlend: number;
      occurrences: number;
      weightedFrequency: number;
      origin: HistoryOrigin;
    }

    const groups = new Map<string, Group>();

    for (const entry of this.#entries) {
      if (!origins.includes(entry.origin)) continue;
      const lower = entry.source.toLowerCase();
      if (prefix !== '' && !lower.startsWith(prefix)) continue;
      if (contains !== '' && !lower.includes(contains)) continue;

      const originWeight = weights.origin[entry.origin];
      const blend = this.#blend(entry, options.now, cwd, weights);
      // SEARCHING and GROUPING are different questions and used to share one
      // string. Matching a prefix stays case-insensitive, because a person
      // typing `get-c` means to find `Get-ChildItem`. Deciding two lines are
      // the SAME line does not: see `groupKey`.
      const key = groupKey(entry.source);
      const existing = groups.get(key);

      if (existing === undefined) {
        groups.set(key, {
          best: entry,
          bestBlend: blend,
          occurrences: 1,
          weightedFrequency: originWeight,
          origin: entry.origin,
        });
        continue;
      }

      existing.occurrences += 1;
      existing.weightedFrequency += originWeight;
      // The group speaks with its strongest voice: a line you typed once and an
      // agent ran fifty times is still a line you typed.
      if (ORIGIN_TIER[entry.origin] > ORIGIN_TIER[existing.origin]) {
        existing.origin = entry.origin;
      }
      if (blend >= existing.bestBlend) {
        existing.best = entry;
        existing.bestBlend = blend;
      }
    }

    const matches: HistoryMatch[] = [];
    for (const group of groups.values()) {
      const frequency =
        group.weightedFrequency / (group.weightedFrequency + weights.frequencyMidpoint);
      // Recompute the blend with the group's folded frequency rather than the
      // single-entry value used to pick a representative.
      const base = this.#blend(group.best, options.now, cwd, weights, frequency);
      const scaled = base * weights.origin[group.origin];
      const score = weights.userPrecedence && group.origin === 'user' ? scaled + 2 : scaled;
      matches.push({
        entry: group.best,
        source: group.best.source,
        score,
        occurrences: group.occurrences,
        weightedFrequency: group.weightedFrequency,
        origin: group.origin,
      });
    }

    matches.sort(
      (a, b) => b.score - a.score || b.entry.createdAt - a.entry.createdAt || b.entry.id - a.entry.id,
    );

    const limit = options.limit;
    return limit === undefined ? matches : matches.slice(0, limit);
  }

  /**
   * Blended score in [0, 1]: recency, frequency and cwd affinity, normalised by
   * the weights so the result stays bounded. Bounding is what lets
   * `userPrecedence` be implemented as a constant offset rather than a hack.
   */
  #blend(
    entry: HistoryEntry,
    now: number,
    cwd: string | undefined,
    weights: RankingWeights,
    frequencyOverride?: number,
  ): number {
    const age = Math.max(0, now - entry.createdAt);
    const recency = Math.pow(0.5, age / weights.recencyHalfLifeMs);
    const frequency = frequencyOverride ?? 1 / (1 + weights.frequencyMidpoint);
    const affinity = cwd === undefined ? 0 : cwdAffinity(entry.cwd, cwd);
    const total = weights.recency + weights.frequency + weights.cwd;
    const blended =
      (weights.recency * recency + weights.frequency * frequency + weights.cwd * affinity) / total;
    const failed = entry.exitCode !== null && entry.exitCode !== 0;
    return failed ? blended * weights.failurePenalty : blended;
  }
}
