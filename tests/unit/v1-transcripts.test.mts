/**
 * The v1 golden transcripts, checked WITHOUT a browser.
 *
 * There are two gates over `tests/conformance/fixtures/v1`, and they answer
 * different questions:
 *
 *   this file            are the committed transcripts internally coherent, do
 *                        they cover every command v1 has, and has anyone edited
 *                        one by hand? Hermetic, part of `npm test`.
 *   npm run test:browser do they still match what v1 PRINTS? Needs Chromium,
 *                        re-executes the archive, and is the only thing that can
 *                        answer that.
 *
 * Neither is redundant. A digest cannot notice that v1 changed; a replay cannot
 * run on a machine with no browser, which is where `npm run verify` runs. The
 * failure this repository has been bitten by most — a check that reports success
 * because it never ran — is closed here by asserting the SHAPE of the evidence
 * as well as its content: how many cases there are, that they cover a command
 * list derived independently of the fixtures, and that the transcripts are not
 * all empty.
 *
 * WHY THE COVERAGE LIST IS NOT READ FROM THE MANIFEST. The acceptance criterion
 * is "every command name reachable from CORPUS has a captured transcript". The
 * manifest records the CORPUS it saw, and checking the manifest against itself
 * would pass for any CORPUS at all, including an empty one. So CORPUS is
 * rebuilt here from `legacy/terminal-v1.html`'s own `CMDLETS`/`ALIAS`/`DISP`
 * literals, with v1's algorithm, and the fixtures are checked against THAT.
 */

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { globSync, readFileSync, readdirSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { join, sep } from 'node:path';

import {
  ARCHIVE,
  FIXTURES,
  INVENTORY,
  REPO,
  buildCases,
  corpusFromLiterals,
  lf,
  manifestDigest,
  readArchiveLiterals,
  readManifest,
  sha256,
  sha256Bytes,
  slugFor,
} from '../../tools/v1-fixtures.mts';

/**
 * The commit legacy/PROVENANCE.md records the archive as having been taken from.
 * Asserted below to still be what that document says, so this constant cannot
 * quietly become a different claim from the published one.
 */
const ARCHIVE_COMMIT = '0838080474d7e34d45cff9f242d2cdb7adde3380';
const PROVENANCE = join(REPO, 'legacy', 'PROVENANCE.md');

const manifest = readManifest();
const archiveBytes = readFileSync(ARCHIVE);
const archiveText = archiveBytes.toString('utf8');
const literals = readArchiveLiterals(archiveText);
const corpus = corpusFromLiterals(literals.cmdlets, literals.alias, literals.disp, literals.apps);

const files = readdirSync(FIXTURES).sort();
const transcripts = files.filter((f) => f.endsWith('.txt'));

describe('v1 golden transcripts: the archive they were taken from', () => {
  it('is the document index.html was at the commit it was archived from', () => {
    // ACCEPTANCE CRITERION 1, mechanised — and it is NOT a byte comparison.
    //
    // MEASURED: the two files are not byte-identical and cannot be. index.html
    // is stored and checked out with LF (141,316 bytes); legacy/terminal-v1.html
    // is declared `-text` in .gitattributes ON PURPOSE so the archive keeps the
    // exact CRLF bytes it was taken with (143,429 bytes). Their git blobs differ
    // — 21794ce2 against 234cdfda — and legacy/PROVENANCE.md's claim that "both
    // currently hash to 21794ce2" was false when this test was written.
    //
    // The property that does hold is that the archive is the same DOCUMENT:
    // identical after newline normalisation.
    //
    // AT THE RECORDED COMMIT, not at the working copy. This compared the
    // archive against whatever index.html says today, which made it a test that
    // fails the first time the page is edited for any reason at all — and it
    // did, on a routine refresh of the contribution counts.
    //
    // An archive exists to be FROZEN. The 128 transcripts were captured from
    // it, so it cannot chase the living page without invalidating them, and the
    // roadmap task says as much in its own title: "pin the commit sha it came
    // from". A gate that breaks whenever someone updates their own portfolio is
    // one that gets deleted the first time it does.
    //
    // Comparing against the pinned commit is stable for ever and still catches
    // the thing worth catching: the archive being edited after the fact.
    const pinned = spawnSync('git', ['show', `${ARCHIVE_COMMIT}:index.html`], {
      encoding: 'utf8',
      maxBuffer: 32 * 1024 * 1024,
    });
    assert.equal(
      pinned.status,
      0,
      `could not read index.html at ${ARCHIVE_COMMIT}, the commit PROVENANCE.md pins:\n${pinned.stderr}`,
    );
    const index = lf(pinned.stdout);
    const archive = lf(archiveText);
    assert.equal(
      sha256(archive),
      sha256(index),
      `legacy/terminal-v1.html is no longer the document index.html was at ${ARCHIVE_COMMIT}`,
    );
    assert.equal(archive.split('\n').length, index.split('\n').length);
  });

  it('pins the commit PROVENANCE.md records, so the two cannot drift apart', () => {
    // The constant is the whole basis for the comparison above, so it has to be
    // the one the document publishes rather than one this test picked.
    assert.ok(
      readFileSync(PROVENANCE, 'utf8').includes(ARCHIVE_COMMIT),
      `PROVENANCE.md does not record ${ARCHIVE_COMMIT} as the archived commit`,
    );
  });

  it('is the archive the fixtures were captured from', () => {
    assert.equal(manifest.archive.sha256Normalised, sha256(lf(archiveText)));
    assert.equal(manifest.archive.sha256, sha256Bytes(archiveBytes));
    assert.equal(manifest.archive.bytes, archiveBytes.byteLength);
    assert.equal(manifest.archive.path, 'legacy/terminal-v1.html');
  });

  it('still defines the five literals the capture reads', () => {
    // If the archive stopped parsing, readArchiveLiterals would throw at import
    // time; this asserts the shapes are non-degenerate rather than merely present.
    assert.equal(Object.keys(literals.cmdlets).length, 67);
    assert.equal(Object.keys(literals.alias).length, 46);
    assert.equal(Object.keys(literals.eggs).length, 11);
    assert.deepEqual([...literals.apps], ['tree']);
    assert.equal(corpus.length, 113);
  });
});

describe('v1 golden transcripts: the seal', () => {
  it('has a manifest digest that recomputes', () => {
    // Catches a hand-edited manifest: change any recorded row count, style,
    // reason or sensitivity flag and this fails.
    assert.equal(manifest.digest, manifestDigest(manifest));
  });

  it('has a transcript on disk for every case, matching its recorded digest', () => {
    // Catches a hand-edited .txt. This is the attack the conformance fixture
    // was already hardened against: editing a recorded answer must be reported
    // as tampering, not as a defect in the code that disagrees with it.
    assert.ok(manifest.cases.length > 0, 'the manifest records no cases at all');
    for (const record of manifest.cases) {
      const path = join(FIXTURES, record.file);
      const text = lf(readFileSync(path, 'utf8'));
      assert.equal(sha256(text), record.sha256, `${record.file} does not match its recorded digest`);
      assert.equal(
        text === '' ? 0 : text.split('\n').length - 1,
        record.rows,
        `${record.file} has a different number of rows than the manifest records`,
      );
      assert.equal(record.styles.length, record.rows, `${record.file}: one style per row`);
      assert.equal(record.file, `${record.slug}.txt`);
    }
  });

  it('has no transcript that no case claims', () => {
    // A stale .txt is a fixture for a command that no longer exists. It would
    // never fail, and it would make the directory listing lie about coverage.
    const claimed = new Set(manifest.cases.map((c) => c.file));
    const orphans = transcripts.filter((f) => !claimed.has(f));
    assert.deepEqual(orphans, [], 'transcripts on disk that the manifest does not account for');
    assert.deepEqual(
      files.filter((f) => !f.endsWith('.txt') && f !== 'manifest.json'),
      [],
      'unexpected files in the fixture directory',
    );
  });
});

describe('v1 golden transcripts: the hermetic gate stays hermetic', () => {
  it('has no test in the hermetic suite that can reach a browser', () => {
    // `npm run verify` must run where there is no Chromium. One `.test.mts`
    // file importing Playwright — directly, or through the harness, or through
    // the capture tool — makes the required gate depend on a 130MB download,
    // and it fails as an import error that names none of that.
    //
    // THIS ASSERTION EXISTS BECAUSE THE FIRST ATTEMPT AT IT DID NOT WORK.
    // tools/run-browser-tests.mts guarded the same property by filtering its
    // own glob results for `.test.mts` — a list every entry of which ends in
    // `.browser.mts`, so it could never match. An adversarial pass dropped a
    // `leak.test.mts` into tests/browser/ and that gate reported success. This
    // one reads the files the hermetic runner will actually execute.
    const hermetic = globSync('tests/**/*.test.mts', { cwd: REPO })
      .map((f) => f.split(sep).join('/'))
      .sort();
    assert.ok(hermetic.length > 40, `only ${String(hermetic.length)} hermetic test files found`);
    assert.ok(hermetic.includes('tests/unit/v1-transcripts.test.mts'), 'this file was not found');

    // Module SPECIFIERS, extracted and then judged — not a pattern run over the
    // whole source. Two versions of this test failed on themselves before this
    // one worked: a regex naming the forbidden modules matched its own
    // definition, and so did the assertion that quoted `playwright`. The
    // trailing semicolon is what separates a real import from a mention of one,
    // and the module names below are never written here as whole literals.
    const BROWSER_MODULES = ['play' + 'wright', '/browser-' + 'harness.mts', '/capture-' + 'v1.mts'];
    const importsOf = (source: string): string[] =>
      [...source.matchAll(/from\s+'([^']+)';/g)].map((m) => m[1] ?? '');
    const needsBrowser = (source: string): boolean =>
      importsOf(source).some((s) => BROWSER_MODULES.some((m) => s === m || s.endsWith(m)));

    const offenders = hermetic.filter((f) => needsBrowser(readFileSync(join(REPO, f), 'utf8')));
    assert.deepEqual(offenders, [], 'these hermetic tests would need a browser to run');

    // Transitively: tools/v1-fixtures.mts is what the hermetic gate imports, so
    // it must not reach Playwright either. That is the whole reason it is a
    // separate file from tools/browser-harness.mts.
    assert.equal(
      needsBrowser(readFileSync(join(REPO, 'tools', 'v1-fixtures.mts'), 'utf8')),
      false,
      'tools/v1-fixtures.mts now needs a browser, so every hermetic test that uses it does too',
    );
    // And the check is not vacuous: the browser suite must trip it.
    assert.equal(
      needsBrowser(readFileSync(join(REPO, 'tests', 'browser', 'v1-transcripts.browser.mts'), 'utf8')),
      true,
      'the browser suite no longer looks like it needs a browser, so this check proves nothing',
    );
  });
});

describe('v1 golden transcripts: coverage', () => {
  it('covers every command name reachable from CORPUS', () => {
    // ACCEPTANCE CRITERION 2. `corpus` is derived from the archive here, not
    // read out of the manifest, so this cannot be satisfied by recording a
    // shorter CORPUS.
    const captured = new Set(manifest.cases.map((c) => c.command));
    const missing = corpus.filter((name) => !captured.has(name));
    assert.deepEqual(missing, [], `no transcript for ${String(missing.length)} CORPUS command(s)`);
  });

  it('covers every easter egg, including the one reached through an alias', () => {
    const captured = new Set(manifest.cases.map((c) => c.command));
    const missing = Object.keys(literals.eggs).filter((egg) => !captured.has(egg));
    assert.deepEqual(missing, [], 'easter eggs with no transcript');

    // `sl` is both an ALIAS entry (-> set-location) and an EGGS entry, and
    // reading execOne alone says the egg is shadowed: CMDLETS is consulted
    // first. It is not. index.html:789 special-cases a bare `sl` inside
    // Set-Location and calls EGGS.sl() itself. The capture MEASURED the train,
    // which is how the misreading was caught; this pins it so the transcript
    // cannot quietly become a Set-Location no-op.
    const sl = manifest.cases.find((c) => c.command === 'sl');
    assert.ok(sl !== undefined, 'sl has no transcript');
    assert.deepEqual([...sl.reasons].sort(), ['alias:sl', 'egg:sl']);
    assert.ok(
      lf(readFileSync(join(FIXTURES, sl.file), 'utf8')).includes('choo choo!'),
      'the sl easter egg is no longer reached',
    );
  });

  it('records the boot banner and the four seeded history entries', () => {
    // Task 1.5. The seeded history prints nothing, so without a fixture of its
    // own there would be no evidence of it anywhere.
    const boot = manifest.cases.find((c) => c.slug === '__boot');
    assert.ok(boot !== undefined);
    assert.deepEqual(boot.reasons, ['boot-banner']);
    assert.equal(
      lf(readFileSync(join(FIXTURES, boot.file), 'utf8')),
      'PowerShell 7.6.5\n\nType help to explore, or try whoami / Get-Contribution -Foundation CNCF\nThemes: Set-Theme pi / campbell / blue\n\n',
    );

    assert.deepEqual(manifest.seededHistory, [
      'whoami',
      'Get-Contribution -Foundation CNCF',
      'Get-Publication -Full',
      'Get-Award -Year 2023',
    ]);
    assert.equal(
      lf(readFileSync(join(FIXTURES, '__history.txt'), 'utf8')),
      `${manifest.seededHistory.join('\n')}\n`,
    );

    // And each of the four is itself a captured command, not just a string.
    const captured = new Set(manifest.cases.map((c) => c.command));
    for (const entry of manifest.seededHistory) {
      assert.ok(captured.has(entry), `the seeded history entry ${entry} has no transcript`);
    }
    const reasons = manifest.cases.flatMap((c) => c.reasons);
    for (let i = 1; i <= 4; i += 1) {
      assert.ok(reasons.includes(`seeded-history:${String(i)}`), `seeded-history:${String(i)} lost`);
    }
  });

  it('agrees with src/commands/v1-inventory.json about what v1 implements', () => {
    // The inventory is extracted from index.html; the literals here come from
    // the archive. Two independent readings, so a divergence between the live
    // page and its archive shows up as a test failure rather than as a
    // coverage number that quietly means less than it says.
    const inventory = JSON.parse(lf(readFileSync(INVENTORY, 'utf8'))) as {
      counts: Record<string, number>;
      commands: { name: string; display: string }[];
      easterEggs: string[];
      applications: string[];
    };
    assert.deepEqual(
      inventory.commands.map((c) => c.name).sort(),
      Object.keys(literals.cmdlets).sort(),
    );
    assert.deepEqual(inventory.easterEggs.slice().sort(), Object.keys(literals.eggs).sort());
    assert.deepEqual(inventory.applications.slice().sort(), [...literals.apps].sort());
    assert.equal(inventory.counts['aliases'], Object.keys(literals.alias).length);
  });

  it('builds the same case list from the archive that the capture recorded', () => {
    // buildCases is the enumeration. Running it here from archive-derived data
    // and comparing against the manifest is what stops the enumeration silently
    // skipping a command: a skipped command changes this list.
    const title = (n: string): string =>
      n
        .split('-')
        .map((w) => (w ? w.charAt(0).toUpperCase() + w.slice(1) : w))
        .join('-');
    const rebuilt = buildCases({
      cmdlets: Object.keys(literals.cmdlets)
        .sort()
        .map((name) => {
          const c = literals.cmdlets[name] ?? {};
          return {
            name,
            display:
              c.disp ??
              literals.disp[name] ??
              (name.indexOf('-') > 0 && !literals.apps.includes(name) ? title(name) : name),
            kind: c.type ?? (literals.apps.includes(name) ? 'Application' : 'Cmdlet'),
            params: c.params ?? [],
            help: c.help ?? '',
            asyncOut: c.asyncOut === true,
            paths: c.paths === true,
            hidden: c.hidden === true,
          };
        }),
      aliases: Object.keys(literals.alias)
        .sort()
        .map((a) => [a, literals.alias[a] ?? ''] as const),
      eggs: Object.keys(literals.eggs).sort(),
      apps: [...literals.apps].sort(),
      corpus,
      seededHistory: manifest.seededHistory,
      reducedMotion: true,
      localStorageWorks: true,
    });
    assert.deepEqual(
      rebuilt.map((c) => c.slug),
      manifest.cases.map((c) => c.slug),
    );
    assert.deepEqual(
      rebuilt.map((c) => c.command),
      manifest.cases.map((c) => c.command),
    );
    for (const c of rebuilt) {
      if (c.command !== null) assert.equal(slugFor(c.command), c.slug);
    }
  });
});

describe('v1 golden transcripts: the evidence is not degenerate', () => {
  it('has enough transcripts, and enough content in them, to mean anything', () => {
    // The whole point of this guard: every assertion above passes vacuously for
    // an empty fixture set. 67 commands + 46 aliases + 11 eggs, deduplicated,
    // plus the boot banner, the seeded history and the three seeded history
    // commands that are not bare command names, is 128.
    assert.equal(manifest.cases.length, 128, 'the number of captured cases changed');
    assert.equal(manifest.counts['rows'], 1102);
    assert.equal(
      manifest.cases.reduce((n, c) => n + c.rows, 0),
      manifest.counts['rows'],
      'the recorded row total disagrees with the cases',
    );

    // Only three transcripts are legitimately empty, and they are empty for a
    // reason that is recorded rather than assumed: Clear-Host wipes `#out`, so
    // the honest transcript of `clear` is nothing at all. Distinguishing that
    // from "the capture never ran" is exactly what bootPrefixIntact is for.
    const empty = manifest.cases.filter((c) => c.rows === 0);
    assert.deepEqual(
      empty.map((c) => c.slug).sort(),
      ['clear', 'clear-host', 'cls'],
      'a transcript is empty for a reason nobody wrote down',
    );
    // bootPrefixIntact is false for EXACTLY those three, and it is what makes
    // "printed nothing" distinguishable from "wiped the screen".
    assert.deepEqual(
      manifest.cases.filter((c) => !c.bootPrefixIntact).map((c) => c.slug).sort(),
      ['clear', 'clear-host', 'cls'],
    );
  });

  it('records no unstable case, and would have to name one to have it', () => {
    // A case whose two identical runs disagree is NOT written as a fixture. If
    // that ever happens the entry lands here with a reason, and these two
    // assertions together make it impossible to add one silently: the first
    // demands a written reason, the second demands the list be reviewed.
    for (const u of manifest.unstable) {
      assert.ok(
        u.reason.length > 0 && u.detail.length > 0,
        `${u.slug} is recorded unstable for no stated reason`,
      );
    }
    assert.deepEqual(
      manifest.unstable.map((u) => u.slug),
      [],
      'a command that used to be captured is now recorded as unstable',
    );
  });
});

describe('v1 golden transcripts: what depends on the environment', () => {
  it('names exactly the commands that read the clock', () => {
    // MEASURED by re-running each case with a different frozen clock. These are
    // the three that call `new Date()`: Get-Date, its `date` alias, and uptime.
    assert.deepEqual(
      manifest.cases.filter((c) => c.clockSensitive).map((c) => c.slug),
      ['get-date', 'date', 'uptime'],
    );
  });

  it('names exactly the commands that read the random source', () => {
    // Get-Random, and the two that print round-trip times from Math.random.
    assert.deepEqual(
      manifest.cases.filter((c) => c.seedSensitive).map((c) => c.slug),
      ['get-random', 'test-connection', 'ping'],
    );
  });

  it('names the commands that render a stored time in local time', () => {
    // Get-ChildItem and its two aliases render `psTime(mt)` with getMonth() and
    // getHours(), which are LOCAL: the same stored mtime prints 7/19/2026 12:00
    // under UTC and 7/19/2026 20:00 under Asia/Taipei. This is why the capture
    // pins a timezone, and it is a genuine v1 behaviour rather than an artefact
    // of the harness.
    assert.deepEqual(
      manifest.cases.filter((c) => c.timezoneSensitive).map((c) => c.slug).sort(),
      ['date', 'dir', 'gci', 'get-childitem', 'get-date', 'uptime'].sort(),
    );
  });

  it('names the two commands whose output the locale changes', () => {
    // This one was expected to be empty and MEASURED not to be. V8 localises
    // the zone name inside Date.prototype.toString(), so Get-Date prints
    // "(Coordinated Universal Time)" under en-US and "(Koordinierte Weltzeit)"
    // under de-DE from the same frozen instant. Nothing in v1 calls a
    // toLocale* method; the dependency comes from the engine.
    assert.deepEqual(
      manifest.cases.filter((c) => c.localeSensitive).map((c) => c.slug),
      ['get-date', 'date'],
    );
  });

  it('records the environment every transcript is conditional on', () => {
    assert.equal(manifest.environment.timezoneId, 'UTC');
    assert.equal(manifest.environment.locale, 'en-US');
    assert.equal(manifest.environment.reducedMotion, 'reduce');
    assert.equal(manifest.environment.seed, 1006);
    // Deliberately NOT v1's own SEEDTIME: if the frozen clock equalled it, a
    // node v1 stamped and a node v1 shipped would be indistinguishable in
    // `ls -la`, and fsSer's `mt !== SEEDTIME` branch would never be exercised.
    assert.notEqual(manifest.environment.clockMs, Date.parse('2026-07-19T12:00:00Z'));
  });

  it('shows the streaming commands captured whole rather than truncated', () => {
    // ping and traceroute print through asyncPrint, one row per setTimeout,
    // unless prefers-reduced-motion is set. If the harness ever stopped setting
    // it, these transcripts would silently shrink to their first row.
    const ping = lf(readFileSync(join(FIXTURES, 'ping.txt'), 'utf8')).split('\n');
    assert.ok(ping.some((l) => l.includes('icmp_seq=4')), 'ping lost its later rows');
    assert.ok(ping.some((l) => l.includes('rtt min/avg/max/mdev')), 'ping lost its summary');
    const trace = lf(readFileSync(join(FIXTURES, 'traceroute.txt'), 'utf8')).split('\n');
    assert.equal(trace.filter((l) => / ms$/.test(l)).length, 4, 'traceroute lost hops');
  });

  it('keeps the error stream distinguishable from ordinary output', () => {
    // The styles are in the manifest rather than the .txt, so this is what
    // stops that being a place where information quietly stops being checked.
    const unknown = manifest.cases.find((c) => c.command === 'which');
    assert.ok(unknown !== undefined);
    const sudo = manifest.cases.find((c) => c.command === 'sudo');
    assert.ok(sudo !== undefined);
    assert.ok(sudo.styles.includes('span.err'), 'sudo no longer reports through the error style');
    assert.ok(
      manifest.cases.some((c) => c.styles.some((s) => s.includes('a.cmd['))),
      'no transcript records a link href any more',
    );
  });
});
