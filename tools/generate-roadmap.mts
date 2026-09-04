/**
 * generate-roadmap.mts — renders ROADMAP.md and roadmap/pr/*.md from
 * roadmap/roadmap.data.mts, and refuses to let them drift.
 *
 * The plan is data. Prose copies of a plan rot the moment someone edits one copy,
 * which is the same failure the release verifier exists to prevent, one level up.
 * So the markdown is generated, `--check` fails if the generated files differ from
 * what the data says, and CI runs `--check`.
 *
 * It also validates the plan itself, because a roadmap can be internally
 * incoherent in ways that are invisible when reading it:
 *   - a work item depending on one that does not exist
 *   - a dependency cycle
 *   - an item marked done whose tasks are not
 *   - a task numbered for a different item than the one containing it
 *   - a phase no item belongs to, or an item in a phase that is not declared
 *
 * Usage:
 *   node tools/generate-roadmap.mts            write the files
 *   node tools/generate-roadmap.mts --check    verify, exit 1 on drift
 */

import { readFileSync, writeFileSync, existsSync, mkdirSync, readdirSync, rmSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { PHASES, WORK, CORRECTIONS } from '../roadmap/roadmap.data.mts';
import type { Status, Task, WorkItem } from '../roadmap/roadmap.data.mts';

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO = resolve(HERE, '..');
const ROADMAP_MD = join(REPO, 'ROADMAP.md');
const PR_DIR = join(REPO, 'roadmap', 'pr');

const MARKS = {
  done: '[x]',
  'in-progress': '[~]',
  todo: '[ ]',
  blocked: '[!]',
  deferred: '[-]',
} as const satisfies Record<Status, string>;

const LABELS = {
  done: 'done',
  'in-progress': 'in progress',
  todo: 'todo',
  blocked: 'blocked',
  deferred: 'deferred',
} as const satisfies Record<Status, string>;

// ---------------------------------------------------------------------------
// plan validation — a roadmap can be incoherent in ways reading it will not show
// ---------------------------------------------------------------------------

function validatePlan(items: readonly WorkItem[]): string[] {
  const problems: string[] = [];
  const byNumber = new Map<number, WorkItem>();
  // Widened to string deliberately: WorkItem.phase is already constrained to
  // PhaseName at compile time, and this stays as a belt-and-braces guard.
  const phaseNames = new Set<string>(PHASES.map((p) => p.name));

  for (const item of items) {
    if (byNumber.has(item.n)) problems.push(`duplicate work item number ${item.n}`);
    byNumber.set(item.n, item);
    if (!phaseNames.has(item.phase)) {
      problems.push(`item ${item.n} is in phase "${item.phase}", which PHASES does not declare`);
    }
    for (const task of item.tasks) {
      const [prefix] = task.id.split('.');
      if (prefix !== String(item.n)) {
        problems.push(`task ${task.id} is numbered for item ${prefix ?? '?'} but lives in item ${item.n}`);
      }
    }
    // An item is only done when its tasks are. Anything else is a status that
    // reads as progress but is not.
    if (item.status === 'done') {
      const open = item.tasks.filter((t) => t.status !== 'done');
      if (open.length > 0) {
        problems.push(
          `item ${item.n} is marked done but ${open.length} task(s) are not: ${open.map((t) => t.id).join(', ')}`,
        );
      }
    }
  }

  for (const item of items) {
    for (const dep of item.dependsOn) {
      if (!byNumber.has(dep)) problems.push(`item ${item.n} depends on ${dep}, which does not exist`);
    }
  }

  // Advertised in this file's header and previously not implemented: a declared
  // phase with no items renders as an empty row, which reads like a gap in the
  // plan rather than a mistake in the data.
  const occupied = new Set<string>(items.map((i) => i.phase));
  for (const phase of PHASES) {
    if (!occupied.has(phase.name)) problems.push(`phase "${phase.name}" has no work items`);
  }

  // Item numbers were checked for uniqueness; task ids inside an item were not.
  for (const item of items) {
    const seen = new Set<string>();
    for (const task of item.tasks) {
      if (seen.has(task.id)) problems.push(`item ${item.n} has two tasks numbered ${task.id}`);
      seen.add(task.id);
    }
  }

  // Cycle detection by DFS colouring. A cyclic plan cannot be executed in any
  // order, and no amount of reading will reveal that.
  const state = new Map<number, 'visiting' | 'done'>();
  const walk = (n: number, trail: number[]): void => {
    const seen = state.get(n);
    if (seen === 'done') return;
    if (seen === 'visiting') {
      problems.push(`dependency cycle: ${[...trail, n].join(' -> ')}`);
      return;
    }
    state.set(n, 'visiting');
    for (const dep of byNumber.get(n)?.dependsOn ?? []) walk(dep, [...trail, n]);
    state.set(n, 'done');
  };
  for (const item of items) walk(item.n, []);

  return problems;
}

/** Dependency-respecting order, tie-broken by item number for determinism. */
function topoOrder(items: readonly WorkItem[]): WorkItem[] {
  const byNumber = new Map(items.map((i) => [i.n, i]));
  const out: WorkItem[] = [];
  const placed = new Set<number>();
  const visit = (n: number, guard: Set<number>): void => {
    if (placed.has(n) || guard.has(n)) return;
    guard.add(n);
    const item = byNumber.get(n);
    if (!item) return;
    for (const dep of [...item.dependsOn].sort((a, b) => a - b)) visit(dep, guard);
    if (!placed.has(n)) {
      placed.add(n);
      out.push(item);
    }
  };
  for (const item of [...items].sort((a, b) => a.n - b.n)) visit(item.n, new Set());
  return out;
}

/**
 * Escape a value for a markdown table cell. An unescaped pipe in a title
 * splits the row into extra columns and swallows the link, corrupting the
 * generated page in a way that still renders, and so goes unnoticed.
 */
const cell = (s: string): string => s.split('|').join('\\|');

interface Progress {
  done: number;
  total: number;
}

function taskProgress(tasks: readonly Task[]): Progress {
  return { done: tasks.filter((t) => t.status === 'done').length, total: tasks.length };
}

function bar(p: Progress, width = 18): string {
  if (p.total === 0) return '-'.repeat(width);
  const filled = Math.round((p.done / p.total) * width);
  return '#'.repeat(filled) + '.'.repeat(width - filled);
}

// ---------------------------------------------------------------------------
// rendering
// ---------------------------------------------------------------------------

function prFileName(item: WorkItem): string {
  return `PR-${String(item.n).padStart(2, '0')}-${item.slug}.md`;
}

function renderMaster(items: readonly WorkItem[]): string {
  const L: string[] = [];
  const overall = taskProgress(items.flatMap((i) => i.tasks));

  L.push('# HCTSai Browser Workstation — roadmap');
  L.push('');
  L.push('> Generated from `roadmap/roadmap.data.mts` by `tools/generate-roadmap.mts`.');
  L.push('> Do not edit this file. Edit the data and run `npm run roadmap`.');
  L.push('');
  L.push(
    'Turning a single-file PowerShell-flavoured web terminal into a browser workstation with a ' +
      'versioned PowerShell compatibility layer, a real object pipeline, durable state, a trusted ' +
      'package model and an audited AI surface.',
  );
  L.push('');
  L.push(`**${overall.done} of ${overall.total} tasks complete.**  \`${bar(overall, 32)}\``);
  L.push('');
  L.push('Legend: `[x]` done · `[~]` in progress · `[ ]` todo · `[!]` blocked · `[-]` deferred');
  L.push('');

  // --- phases -------------------------------------------------------------
  L.push('## Phases');
  L.push('');
  L.push('| Phase | Goal | Items | Progress |');
  L.push('| --- | --- | --- | --- |');
  for (const phase of PHASES) {
    const inPhase = items.filter((i) => i.phase === phase.name);
    const p = taskProgress(inPhase.flatMap((i) => i.tasks));
    const nums = inPhase.map((i) => i.n).join(', ');
    L.push(`| **${cell(phase.name)}** | ${cell(phase.goal)} | ${nums} | \`${bar(p)}\` ${p.done}/${p.total} |`);
  }
  L.push('');

  // --- suggested order ----------------------------------------------------
  L.push('## Execution order');
  L.push('');
  L.push('Dependency-respecting. An item cannot start before everything it depends on is done.');
  L.push('');
  L.push('| # | Item | Phase | Status | Depends on | Tasks |');
  L.push('| --- | --- | --- | --- | --- | --- |');
  for (const item of topoOrder(items)) {
    const p = taskProgress(item.tasks);
    const deps = item.dependsOn.length > 0 ? item.dependsOn.join(', ') : '—';
    L.push(
      `| ${item.n} | [${cell(item.title)}](roadmap/pr/${prFileName(item)}) | ${cell(item.phase)} | ` +
        `${MARKS[item.status]} ${LABELS[item.status]} | ${deps} | ${p.done}/${p.total} |`,
    );
  }
  L.push('');

  // --- the corrections ----------------------------------------------------
  L.push('## Corrections to the originating design');
  L.push('');
  L.push(
    'Every claim below was checked against a primary source on 2026-09-04. These are recorded ' +
      'rather than quietly fixed, because several of them change what the plan should *do*.',
  );
  L.push('');
  for (const c of CORRECTIONS) {
    L.push(`### ${c.verdict.replace(/-/g, ' ')} — ${c.claim}`);
    L.push('');
    L.push(`**Correction.** ${c.correction}`);
    L.push('');
    L.push(`**Impact on the plan.** ${c.impact}`);
    L.push('');
    L.push(`\`${c.source}\``);
    L.push('');
  }

  // --- full checklist -----------------------------------------------------
  L.push('## All tasks');
  L.push('');
  for (const phase of PHASES) {
    const inPhase = items.filter((i) => i.phase === phase.name).sort((a, b) => a.n - b.n);
    if (inPhase.length === 0) continue;
    L.push(`### ${phase.name}`);
    L.push('');
    for (const item of inPhase) {
      L.push(`- ${MARKS[item.status]} **${item.n}. ${item.title}** — [detail](roadmap/pr/${prFileName(item)})`);
      for (const task of item.tasks) {
        L.push(`  - ${MARKS[task.status]} ${task.id} ${task.title}`);
      }
    }
    L.push('');
  }

  return L.join('\n') + '\n';
}

function renderItem(item: WorkItem, items: readonly WorkItem[]): string {
  const byNumber = new Map(items.map((i) => [i.n, i]));
  const p = taskProgress(item.tasks);
  const L: string[] = [];

  L.push(`# ${item.n}. ${item.title}`);
  L.push('');
  L.push('> Generated from `roadmap/roadmap.data.mts`. Do not edit; edit the data.');
  L.push('');
  L.push(`**Phase** ${item.phase}  `);
  L.push(`**Status** ${MARKS[item.status]} ${LABELS[item.status]}  `);
  L.push(`**Tasks** ${p.done}/${p.total} \`${bar(p)}\``);
  L.push('');

  L.push('## Why');
  L.push('');
  L.push(item.why);
  L.push('');

  L.push('## Depends on');
  L.push('');
  if (item.dependsOn.length === 0) {
    L.push('Nothing. This can start immediately.');
  } else {
    for (const dep of item.dependsOn) {
      const d = byNumber.get(dep);
      L.push(
        d
          ? `- ${MARKS[d.status]} **${dep}. ${d.title}** — [detail](${prFileName(d)})`
          : `- **${dep}** (missing — the plan is inconsistent)`,
      );
    }
  }
  L.push('');

  L.push('## Tasks');
  L.push('');
  for (const task of item.tasks) {
    L.push(`- ${MARKS[task.status]} **${task.id}** ${task.title}`);
    if (task.detail !== undefined) L.push(`  - ${task.detail}`);
  }
  L.push('');

  L.push('## Acceptance');
  L.push('');
  L.push('Observable conditions. Not opinions — each of these can be checked.');
  L.push('');
  for (const a of item.acceptance) L.push(`- ${a}`);
  L.push('');

  if (item.risks !== undefined && item.risks.length > 0) {
    L.push('## Risks');
    L.push('');
    for (const r of item.risks) L.push(`- ${r}`);
    L.push('');
  }

  L.push('---');
  L.push('');
  L.push('[Back to the roadmap](../../ROADMAP.md)');
  L.push('');

  return L.join('\n');
}

// ---------------------------------------------------------------------------
// write / check
//
// The working tree is CRLF (core.autocrlf=true) while generated content is LF.
// Comparing raw bytes would report drift on every checkout — the exact class of
// bug that silently disabled a check in tools/check-numbers.js. Normalise first.
// ---------------------------------------------------------------------------

const normalise = (s: string): string => s.replace(/\r\n/g, '\n');

interface Artifact {
  path: string;
  content: string;
}

function collectArtifacts(): Artifact[] {
  const items = WORK as readonly WorkItem[];
  return [
    { path: ROADMAP_MD, content: renderMaster(items) },
    ...items.map((item) => ({
      path: join(PR_DIR, prFileName(item)),
      content: renderItem(item, items),
    })),
  ];
}

const KNOWN_FLAGS = new Set(['--check']);

function main(): void {
  const argv = process.argv.slice(2);
  // A closed set. The default action here is to WRITE, so a mistyped `--chekc`
  // silently regenerated the files and exited 0 — in CI that means the gate
  // rewrote the very thing it was meant to be verifying. The sibling tool
  // already had this fix; it was not carried across.
  const unknown = argv.filter((a) => !KNOWN_FLAGS.has(a));
  if (unknown.length > 0) {
    process.stderr.write(
      `\n  unknown option(s): ${unknown.join(', ')}\n  known: ${[...KNOWN_FLAGS].join(', ')}\n\n`,
    );
    process.exitCode = 2;
    return;
  }
  const check = argv.includes('--check');

  const problems = validatePlan(WORK as readonly WorkItem[]);
  if (problems.length > 0) {
    process.stderr.write('\n  the roadmap data is internally inconsistent:\n');
    for (const p of problems) process.stderr.write(`    - ${p}\n`);
    process.stderr.write('\n');
    process.exitCode = 2;
    return;
  }

  const artifacts = collectArtifacts();

  if (check) {
    const drift: string[] = [];
    for (const a of artifacts) {
      if (!existsSync(a.path)) {
        drift.push(`missing: ${a.path}`);
        continue;
      }
      if (normalise(readFileSync(a.path, 'utf8')) !== normalise(a.content)) {
        drift.push(`stale: ${a.path}`);
      }
    }
    // A generated file with no data behind it is drift too, or the rename of a
    // slug would leave an orphan claiming to be current.
    const expected = new Set(artifacts.map((a) => a.path));
    if (existsSync(PR_DIR)) {
      // Anything here the data did not produce is drift. The previous check was
      // case-sensitive and non-recursive, so PR-99-GHOST.MD and
      // archive/PR-99-ghost.md both survived --check AND the cleanup, and both
      // would be served by GitHub Pages claiming to be current.
      for (const entry of readdirSync(PR_DIR, { withFileTypes: true, recursive: true })) {
        const full = join(entry.parentPath, entry.name);
        if (entry.isDirectory()) drift.push(`unexpected directory: ${full}`);
        else if (!expected.has(full)) drift.push(`orphan: ${full}`);
      }
    }
    if (drift.length > 0) {
      process.stderr.write('\n  generated roadmap files are out of date:\n');
      for (const d of drift) process.stderr.write(`    - ${d}\n`);
      process.stderr.write('\n  run: npm run roadmap\n\n');
      process.exitCode = 1;
      return;
    }
    const p = taskProgress((WORK as readonly WorkItem[]).flatMap((i) => i.tasks));
    process.stdout.write(`  roadmap is in sync (${p.done}/${p.total} tasks done).\n`);
    return;
  }

  mkdirSync(PR_DIR, { recursive: true });
  const expected = new Set(artifacts.map((a) => a.path));
  for (const entry of readdirSync(PR_DIR, { withFileTypes: true, recursive: true })) {
    if (entry.isDirectory()) continue;
    const full = join(entry.parentPath, entry.name);
    if (!expected.has(full)) rmSync(full);
  }
  for (const a of artifacts) {
    mkdirSync(dirname(a.path), { recursive: true });
    writeFileSync(a.path, a.content, 'utf8');
  }

  const p = taskProgress((WORK as readonly WorkItem[]).flatMap((i) => i.tasks));
  process.stdout.write(
    `  wrote ROADMAP.md and ${artifacts.length - 1} item files (${p.done}/${p.total} tasks done).\n`,
  );
}

main();
