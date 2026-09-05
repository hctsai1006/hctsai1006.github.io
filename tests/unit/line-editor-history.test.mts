/**
 * Tests for history provenance, ranking and inline prediction.
 *
 * The centrepiece is `an ai entry never outranks a user entry`. That is not a
 * nice-to-have: PSReadLine issue #5123 reports precisely this — agent-executed
 * commands entering the same undifferentiated history and skewing what gets
 * recommended back to the human. The upstream data model has no field to fix it
 * with. Ours does, so the guarantee is testable, and this is the test that keeps
 * it true when someone later "simplifies" the scoring function.
 *
 * Every case injects `now`. A ranker that read `Date.now()` could not be tested
 * at all, which is why the clock is a parameter.
 */

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

import {
  DEFAULT_NAVIGATION_ORIGINS,
  DEFAULT_RANKING_WEIGHTS,
  HistoryEngine,
  type HistoryOrigin,
  type HistoryRecord,
} from '../../src/line-editor/history.ts';
import { PredictionEngine } from '../../src/line-editor/prediction.ts';

const NOW = Date.UTC(2026, 8, 5, 12, 0, 0);
const MINUTE = 60_000;
const HOUR = 60 * MINUTE;
const DAY = 24 * HOUR;

interface EntryShape {
  readonly source: string;
  readonly origin?: HistoryOrigin;
  readonly cwd?: string;
  readonly ago?: number;
  readonly exitCode?: number;
}

function record(shape: EntryShape): HistoryRecord {
  return {
    source: shape.source,
    cwd: shape.cwd ?? '/home/thc1006',
    compatibilityProfile: '7.6.5',
    origin: shape.origin ?? 'user',
    exitCode: shape.exitCode ?? 0,
    durationMs: 12,
    createdAt: NOW - (shape.ago ?? 0),
  };
}

function engineWith(...shapes: EntryShape[]): HistoryEngine {
  const engine = new HistoryEngine();
  for (const shape of shapes) engine.append(record(shape));
  return engine;
}

describe('the log', () => {
  it('carries provenance on every entry', () => {
    const engine = new HistoryEngine();
    const entry = engine.append(record({ source: 'Get-ChildItem' }));
    assert.ok(entry !== null);
    assert.deepEqual(
      { ...entry },
      {
        id: 1,
        source: 'Get-ChildItem',
        cwd: '/home/thc1006',
        compatibilityProfile: '7.6.5',
        origin: 'user',
        exitCode: 0,
        durationMs: 12,
        createdAt: NOW,
      },
    );
  });

  it('refuses blank lines and trims what it stores, as v1 did', () => {
    const engine = new HistoryEngine();
    assert.equal(engine.append(record({ source: '   ' })), null);
    assert.equal(engine.append(record({ source: '' })), null);
    assert.equal(engine.append(record({ source: '  Get-Date  ' }))?.source, 'Get-Date');
    assert.equal(engine.size, 1);
  });

  it('learns the outcome after the fact without reordering anything', () => {
    // `durationMs` cannot be known when the line is submitted. A history that
    // always reported null there would make the field a lie.
    const engine = new HistoryEngine();
    const first = engine.append(record({ source: 'a' }));
    const second = engine.append(record({ source: 'b' }));
    assert.ok(first !== null && second !== null);
    const settled = engine.settle(first.id, { exitCode: 1, durationMs: 940 });
    assert.equal(settled?.exitCode, 1);
    assert.equal(settled?.durationMs, 940);
    assert.deepEqual(
      engine.entries.map((e) => e.id),
      [1, 2],
      'position is unchanged',
    );
    assert.equal(engine.settle(999, { exitCode: 0, durationMs: 0 }), null);
  });

  it('evicts the oldest past capacity', () => {
    const engine = new HistoryEngine({ capacity: 3 });
    for (const source of ['a', 'b', 'c', 'd']) engine.append(record({ source }));
    assert.deepEqual(
      engine.entries.map((e) => e.source),
      ['b', 'c', 'd'],
    );
  });
});

describe('ranking', () => {
  it('never lets an ai entry outrank a user entry, however often the agent ran it', () => {
    const engine = new HistoryEngine();
    // The agent hammered this seconds ago, a hundred and one times.
    engine.append(record({ source: 'kubectl get pods', origin: 'ai', ago: 30 * MINUTE }));
    for (let i = 0; i < 100; i += 1) {
      engine.append(record({ source: 'kubectl get pods', origin: 'ai', ago: MINUTE }));
    }
    // The human typed this once, a day ago.
    engine.append(record({ source: 'kubectl get nodes', origin: 'user', ago: DAY }));

    const ranked = engine.recall({ now: NOW, cwd: '/home/thc1006' });
    assert.deepEqual(
      ranked.map((m) => m.source),
      ['kubectl get nodes', 'kubectl get pods'],
    );
    assert.equal(ranked[0]?.origin, 'user');
    assert.equal(ranked[1]?.occurrences, 101);
    assert.ok(
      (ranked[0]?.score ?? 0) > (ranked[1]?.score ?? 0),
      'recency and frequency must not be able to buy their way past provenance',
    );
  });

  it('still prefers user when the hard precedence rule is switched off', () => {
    // Precedence is data. With it off the origin weights remain, so the
    // preference is a nudge rather than a promise — and the test says which.
    const weights = { ...DEFAULT_RANKING_WEIGHTS, userPrecedence: false };
    const engine = engineWith(
      { source: 'terraform apply', origin: 'ai', ago: MINUTE },
      { source: 'terraform plan', origin: 'user', ago: MINUTE },
    );
    const ranked = engine.recall({ now: NOW, weights });
    assert.equal(ranked[0]?.source, 'terraform plan');
    assert.ok((ranked[0]?.score ?? 0) > (ranked[1]?.score ?? 0));
  });

  it('counts frequency by origin weight, so agent repetition cannot inflate it', () => {
    const engine = new HistoryEngine();
    for (let i = 0; i < 10; i += 1) {
      engine.append(record({ source: 'npm test', origin: 'ai', ago: MINUTE }));
    }
    engine.append(record({ source: 'npm test', origin: 'user', ago: MINUTE }));
    const match = engine.recall({ now: NOW })[0];
    assert.equal(match?.occurrences, 11);
    // 10 * 0.15 + 1 * 1.0, not 11.
    assert.equal(Math.round((match?.weightedFrequency ?? 0) * 100) / 100, 2.5);
    assert.equal(match?.origin, 'user', 'a line you typed once is still yours');
  });

  it('deduplicates on recall but keeps every occurrence in the log', () => {
    const engine = engineWith(
      { source: 'Get-Date', ago: 3 * MINUTE },
      { source: 'Get-Date', ago: 2 * MINUTE },
      { source: 'get-date', ago: MINUTE },
    );
    assert.equal(engine.size, 3, 'the log is append-only');
    const ranked = engine.recall({ now: NOW });
    assert.equal(ranked.length, 1, 'matching is case-insensitive, as PowerShell is');
    assert.equal(ranked[0]?.occurrences, 3);
  });

  it('prefers the current directory, then an ancestor, then anywhere', () => {
    const engine = engineWith(
      { source: 'build here', cwd: '/work/app', ago: MINUTE },
      { source: 'build above', cwd: '/work', ago: MINUTE },
      { source: 'build elsewhere', cwd: '/tmp', ago: MINUTE },
    );
    assert.deepEqual(
      engine.recall({ now: NOW, cwd: '/work/app' }).map((m) => m.source),
      ['build here', 'build above', 'build elsewhere'],
    );
    // A trailing slash is not a different directory, under any rule.
    assert.equal(engine.recall({ now: NOW, cwd: '/work/app/' })[0]?.source, 'build here');
  });

  it('compares paths the way the filesystem actually does, which is exactly', () => {
    // This suite asserted the opposite -- that `\WORK\App\` matched `/work/app`
    // -- under the comment "paths are compared the way the emulated filesystem
    // compares them". It is not how it compares them. MEASURED against this
    // repository's own storage:
    //
    //   mkdir /tmp/Docs; stat /tmp/docs      -> not found
    //   mkdir /tmp/docs alongside /tmp/Docs  -> CREATED; /tmp holds both
    //   mkdir '/tmp/we\ird'                  -> created a file NAMED `we\ird`
    //   stat '/tmp\a'                        -> not found; `\` is not a separator
    //
    // This emulates Ubuntu. `Docs` and `docs` are two directories and a
    // backslash is an ordinary character in a name, so folding case and
    // rewriting separators merged directories that genuinely differ. The
    // symptom is not an error: it is history recalling a command from a
    // directory the user has never been in, ranked as if it were local.
    const engine = engineWith(
      { source: 'build upper', cwd: '/work/Docs', ago: MINUTE },
      { source: 'build lower', cwd: '/work/docs', ago: MINUTE },
    );

    assert.equal(engine.recall({ now: NOW, cwd: '/work/Docs' })[0]?.source, 'build upper');
    assert.equal(engine.recall({ now: NOW, cwd: '/work/docs' })[0]?.source, 'build lower');

    // A backslash is part of the NAME, so `\work\Docs` is a third directory
    // unrelated to both -- which means neither entry gets an affinity bonus and
    // they score EQUALLY. Asserting an order here would be asserting a
    // tie-break, and the point is that there is a tie: under the old rule this
    // path matched `/work/docs` outright.
    const unrelated = engine.recall({ now: NOW, cwd: '\\work\\Docs' });
    assert.equal(unrelated.length, 2);
    assert.equal(
      unrelated[0]?.score,
      unrelated[1]?.score,
      'an unrelated cwd favours neither, because it matches neither',
    );
    assert.ok(
      (unrelated[0]?.score ?? 0) < (engine.recall({ now: NOW, cwd: '/work/Docs' })[0]?.score ?? 0),
      'and both score below the entry whose directory really is the current one',
    );
  });

  it('deduplicates the command name but not its arguments', () => {
    // PowerShell resolves command NAMES case-insensitively, so `Get-Date` and
    // `get-date` are one line -- pinned by the test above. Arguments are not:
    // on a case-sensitive filesystem `cat README` and `cat readme` name
    // different files, and the whole line used to fold, so they were one entry
    // and recall could return the wrong one.
    const engine = engineWith(
      { source: 'cat README', ago: 2 * MINUTE },
      { source: 'cat readme', ago: MINUTE },
      { source: 'Cat README', ago: MINUTE },
    );

    const ranked = engine.recall({ now: NOW });
    assert.equal(ranked.length, 2, 'two files, two entries');

    // The group's `source` is the best-scoring OCCURRENCE, so it carries the
    // capitalisation actually typed -- `Cat README` here, because it is the
    // most recent of the two that folded together. That is the same property
    // the inline-prediction suite pins; the group key and the displayed text
    // are deliberately not the same string.
    assert.deepEqual(ranked.map((m) => m.source).sort(), ['Cat README', 'cat readme']);
    assert.equal(
      ranked.find((m) => m.source === 'Cat README')?.occurrences,
      2,
      '`cat README` and `Cat README` are one line: only the command name folds',
    );
    assert.equal(ranked.find((m) => m.source === 'cat readme')?.occurrences, 1, 'a different file');
  });

  it('prefers the recent, with an hour half-life', () => {
    const engine = engineWith(
      { source: 'old', ago: 8 * HOUR },
      { source: 'fresh', ago: MINUTE },
    );
    assert.equal(engine.recall({ now: NOW })[0]?.source, 'fresh');
  });

  it('demotes a line whose last run failed', () => {
    const engine = engineWith(
      { source: 'that worked', ago: MINUTE, exitCode: 0 },
      { source: 'that failed', ago: MINUTE, exitCode: 1 },
    );
    assert.deepEqual(
      engine.recall({ now: NOW }).map((m) => m.source),
      ['that worked', 'that failed'],
    );
  });

  it('filters by prefix, by substring and by origin', () => {
    const engine = engineWith(
      { source: 'Get-ChildItem -Recurse', ago: MINUTE },
      { source: 'Set-Location /tmp', ago: MINUTE },
      { source: 'Get-Process', origin: 'ai', ago: MINUTE },
    );
    assert.deepEqual(
      engine.recall({ now: NOW, prefix: 'get-' }).map((m) => m.source),
      ['Get-ChildItem -Recurse', 'Get-Process'],
    );
    assert.deepEqual(
      engine.recall({ now: NOW, contains: 'location' }).map((m) => m.source),
      ['Set-Location /tmp'],
    );
    assert.deepEqual(
      engine.recall({ now: NOW, origins: ['ai'] }).map((m) => m.source),
      ['Get-Process'],
    );
    assert.equal(engine.recall({ now: NOW, limit: 1 }).length, 1);
  });
});

describe('arrow-key navigation', () => {
  it('walks backwards and forwards chronologically', () => {
    const engine = engineWith({ source: 'first' }, { source: 'second' }, { source: 'third' });
    assert.equal(engine.previousIndex(3), 2);
    assert.equal(engine.previousIndex(2), 1);
    assert.equal(engine.previousIndex(0), -1, 'nothing further back');
    assert.equal(engine.nextIndex(0), 1);
    assert.equal(engine.nextIndex(2), -1, 'nothing newer');
  });

  it('leaves agent commands out by default', () => {
    // Roadmap task 5.4, stated as an acceptance condition: "AI-issued commands
    // cannot pollute the user's arrow-key history".
    assert.equal(DEFAULT_NAVIGATION_ORIGINS.includes('ai'), false);
    const engine = engineWith(
      { source: 'mine' },
      { source: 'the agent did this', origin: 'ai' },
      { source: 'a script did this', origin: 'script' },
    );
    assert.equal(engine.entries[engine.previousIndex(3)]?.source, 'a script did this');
    assert.equal(engine.entries[engine.previousIndex(2)]?.source, 'mine');
    // Still reachable when a host asks for it — hidden, not deleted.
    assert.equal(engine.entries[engine.previousIndex(3, '', ['ai'])]?.source, 'the agent did this');
  });

  it('can filter by a typed prefix', () => {
    const engine = engineWith({ source: 'git status' }, { source: 'npm test' }, { source: 'git log' });
    assert.equal(engine.entries[engine.previousIndex(3, 'git')]?.source, 'git log');
    assert.equal(engine.entries[engine.previousIndex(2, 'git')]?.source, 'git status');
  });
});

describe('inline prediction', () => {
  const corpus = ['Get-ChildItem', 'Get-Command', 'Get-Content'];

  it('preserves the capitalisation the user typed', () => {
    // v1 rendered `stored.slice(typed.length)` and accepted the STORED line, so
    // typing `WHO` against a history of `whoami` silently rewrote the buffer to
    // `whoami`. The ghost must be a tail, never a replacement.
    const engine = engineWith({ source: 'whoami', ago: MINUTE });
    const prediction = new PredictionEngine(engine).predict('WHO', { now: NOW });
    assert.equal(prediction?.completion, 'ami');
    assert.equal(prediction?.suggestion, 'WHOami');
  });

  it('shows nothing for an empty prefix or an exact match', () => {
    const engine = engineWith({ source: 'whoami', ago: MINUTE });
    const predictor = new PredictionEngine(engine);
    assert.equal(predictor.predict('', { now: NOW }), null);
    assert.equal(predictor.predict('whoami', { now: NOW }), null, 'no empty ghost');
    assert.equal(predictor.predict('nothing like it', { now: NOW }), null);
  });

  it('predicts what the user runs, not what the agent ran', () => {
    const engine = new HistoryEngine();
    for (let i = 0; i < 50; i += 1) {
      engine.append(record({ source: 'git push --force', origin: 'ai', ago: MINUTE }));
    }
    engine.append(record({ source: 'git status', origin: 'user', ago: 3 * DAY }));
    const prediction = new PredictionEngine(engine).predict('git ', { now: NOW });
    assert.equal(prediction?.suggestion, 'git status');
    assert.equal(prediction?.entry?.origin, 'user');
  });

  it('falls back to the command corpus when history has nothing', () => {
    const predictor = new PredictionEngine(new HistoryEngine(), { corpus });
    const prediction = predictor.predict('Get-Ch', { now: NOW });
    assert.equal(prediction?.suggestion, 'Get-ChildItem');
    assert.equal(prediction?.source, 'corpus');
    assert.equal(prediction?.entry, null);
  });

  it('prefers history over the corpus', () => {
    const engine = engineWith({ source: 'Get-Content notes.md', ago: MINUTE });
    const prediction = new PredictionEngine(engine, { corpus }).predict('Get-C', { now: NOW });
    assert.equal(prediction?.source, 'history');
    assert.equal(prediction?.suggestion, 'Get-Content notes.md');
  });

  it('can hand over one word at a time', () => {
    assert.equal(PredictionEngine.firstWordOf('ildItem -Recurse -Force'), 'ildItem');
    assert.equal(PredictionEngine.firstWordOf(' -Recurse -Force'), ' -Recurse');
    assert.equal(PredictionEngine.firstWordOf(''), '');
  });

  it('scopes prediction to the working directory when one is given', () => {
    const engine = engineWith(
      { source: 'make deploy', cwd: '/srv/prod', ago: MINUTE },
      { source: 'make test', cwd: '/home/thc1006', ago: MINUTE },
    );
    const predictor = new PredictionEngine(engine);
    assert.equal(predictor.predict('make ', { now: NOW, cwd: '/srv/prod' })?.suggestion, 'make deploy');
    assert.equal(predictor.predict('make ', { now: NOW, cwd: '/home/thc1006' })?.suggestion, 'make test');
  });
});
