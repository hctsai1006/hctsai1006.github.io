/**
 * Tests for the tokenizer, the completion context and the ranking.
 *
 * v1's completion had two positions (start-of-line-or-after-a-pipe, and
 * everything else) resolved by `lastIndexOf(' ')`. Most of the cases below are
 * ones it got wrong: a quoted argument, a value after a non-switch parameter, a
 * negative number that looks like a flag, and a pipeline segment after `{`.
 *
 * The inventory is loaded from the real `src/commands/manifests.json`, not a
 * fixture. A fixture would let completion drift away from what the shell can
 * actually run, which is the drift the manifests exist to prevent.
 */

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

import {
  CompletionEngine,
  fuzzyScore,
  matchCandidate,
  resolveCompletionContext,
  type ArgumentSuggestion,
  type CompletionContext,
} from '../../src/line-editor/completion.ts';
import {
  CommandInventory,
  COMMON_PARAMETERS,
  MANIFEST_COMMANDS,
  manifestInventory,
} from '../../src/line-editor/inventory.ts';
import { TextBuffer } from '../../src/line-editor/text-buffer.ts';
import { quoteIfNeeded, tokenize } from '../../src/line-editor/tokenize.ts';

const inventory = manifestInventory();

const contextOf = (line: string, caret = line.length): CompletionContext =>
  resolveCompletionContext(line, caret, inventory);

const displaysOf = (line: string, caret = line.length): string[] =>
  new CompletionEngine().complete(TextBuffer.of(line, caret)).candidates.map((c) => c.display);

describe('tokenizer', () => {
  it('keeps quoted runs whole and resolves the escapes inside them', () => {
    assert.deepEqual(
      tokenize("Get-Content 'a''b' \"c`\"d\"").map((t) => [t.kind, t.value]),
      [
        ['word', 'Get-Content'],
        ['word', "a'b"],
        ['word', 'c"d'],
      ],
    );
  });

  it('reports an unterminated quote instead of losing the token', () => {
    const token = tokenize("Get-Content 'my fi")[1];
    assert.equal(token?.value, 'my fi');
    assert.equal(token?.quote, "'");
    assert.equal(token?.unterminated, true);
    assert.equal(token?.start, 12);
  });

  it('tells a parameter from a negative number', () => {
    // v1's rule, kept: `只有 -Name 這種才算參數;-1 是負數值` — only `-Name` counts.
    assert.deepEqual(
      tokenize('Get-Random -Minimum -5 -Maximum 10').map((t) => [t.kind, t.value]),
      [
        ['word', 'Get-Random'],
        ['parameter', '-Minimum'],
        ['word', '-5'],
        ['parameter', '-Maximum'],
        ['word', '10'],
      ],
    );
  });

  it('tells a parameter from an operator that is spelled like one', () => {
    const kinds = tokenize('Where-Object { $_.Length -gt 10 }').map((t) => t.kind);
    assert.deepEqual(kinds, ['word', 'separator', 'word', 'operator', 'word', 'separator']);
  });

  it('recognises the separators that start a new command, and redirection', () => {
    assert.deepEqual(
      tokenize('a | b && c ; d > e 2>&1').map((t) => [t.kind, t.value]),
      [
        ['word', 'a'],
        ['separator', '|'],
        ['word', 'b'],
        ['separator', '&&'],
        ['word', 'c'],
        ['separator', ';'],
        ['word', 'd'],
        ['redirection', '>'],
        ['word', 'e'],
        ['redirection', '2>&1'],
      ],
    );
  });

  it('does not break on a comma, which is the array operator', () => {
    // Breaking there would put the caret in command position after every comma.
    assert.deepEqual(
      tokenize('Get-ChildItem -Path a,b').map((t) => t.value),
      ['Get-ChildItem', '-Path', 'a,b'],
    );
  });

  it('quotes only what needs it, and prefers single quotes', () => {
    assert.equal(quoteIfNeeded('plain'), 'plain');
    assert.equal(quoteIfNeeded('my file.txt'), "'my file.txt'");
    assert.equal(quoteIfNeeded("it's"), "'it''s'");
    assert.equal(quoteIfNeeded('a b', '"'), '"a b"');
    assert.equal(quoteIfNeeded(''), "''");
  });
});

describe('completion context', () => {
  it('knows the four positions apart', () => {
    assert.equal(contextOf('Get-Ch').kind, 'command');
    assert.equal(contextOf('Get-ChildItem -Rec').kind, 'parameter');
    assert.equal(contextOf('Get-ChildItem -Path ').kind, 'parameter-value');
    assert.equal(contextOf('Get-ChildItem ').kind, 'argument');
  });

  it('uses `isSwitch` to tell a value from the next argument', () => {
    // This is the whole reason the manifest records isSwitch separately from a
    // boolean type: `-Path <TAB>` wants a value, `-Recurse <TAB>` does not.
    const value = contextOf('Get-ChildItem -Path ');
    assert.equal(value.kind, 'parameter-value');
    assert.equal(value.parameterName, 'Path');
    assert.equal(contextOf('Get-ChildItem -Recurse ').kind, 'argument');
    // An unknown parameter is assumed to be a switch, which keeps the caret in
    // argument position rather than inventing a value context.
    assert.equal(contextOf('Get-ChildItem -NoSuchThing ').kind, 'argument');
  });

  it('restarts at command position after every pipeline separator', () => {
    for (const line of ['Get-ChildItem | Where-Ob', 'a; Where-Ob', 'a && Where-Ob', 'a | b | Where-Ob']) {
      assert.equal(contextOf(line).kind, 'command', line);
      assert.equal(contextOf(line).word, 'Where-Ob', line);
    }
    assert.equal(contextOf('Where-Object { $_.Length -gt 10 } ').kind, 'command');
  });

  it('counts positional arguments per command', () => {
    assert.equal(contextOf('Copy-Item ').argumentIndex, 0);
    assert.equal(contextOf('Copy-Item a ').argumentIndex, 1);
    assert.equal(contextOf('Copy-Item a b ').argumentIndex, 2);
    // A parameter and its value are not positional arguments.
    assert.equal(contextOf('Copy-Item -Destination x a ').argumentIndex, 1);
    // ...but a switch is followed by one.
    assert.equal(contextOf('Copy-Item -Force a ').argumentIndex, 1);
  });

  it('sees through quotes to the word being typed', () => {
    const ctx = contextOf("Get-Content 'my fi");
    assert.equal(ctx.kind, 'argument');
    assert.equal(ctx.word, 'my fi', 'the quote is not part of the query');
    assert.equal(ctx.quote, "'");
    assert.equal(ctx.replaceStart, 12, 'but it IS part of what gets replaced');
  });

  it('completes the prefix before the caret and leaves the suffix alone', () => {
    // v1's convention: `replaceWord(start, pick, caret)`.
    const ctx = contextOf('Get-Ch | Sort-Object', 6);
    assert.equal(ctx.word, 'Get-Ch');
    assert.equal(ctx.replaceStart, 0);
    assert.equal(ctx.replaceEnd, 6);
  });

  it('starts a fresh word when the caret sits in whitespace', () => {
    const ctx = contextOf('Get-ChildItem ');
    assert.equal(ctx.word, '');
    assert.equal(ctx.replaceStart, 14);
    assert.equal(ctx.replaceEnd, 14);
  });
});

describe('command inventory', () => {
  it('is projected from the generated manifests, not a fixture', () => {
    // 78 until the rewrite's own commands were declared. manifests.json was
    // generated from v1's inventory alone, so Group-Object, Get-Member, New-Guid
    // and the four formatting commands were implemented and invisible to
    // completion, Get-Command and the fidelity badge alike.
    assert.equal(MANIFEST_COMMANDS.length, 85);
    // 85 canonical names plus 51 aliases, less the one collision below.
    assert.equal(inventory.commands.length, 135);
  });

  it('lets a real command shadow an alias of the same name', () => {
    // `sl` is both the steam-locomotive joke command and Set-Location's alias.
    // The dispatcher runs the command, so completion must offer the command.
    const sl = inventory.resolve('sl');
    assert.equal(sl?.kind, 'command');
    assert.equal(sl?.canonical, 'sl');
    assert.equal(inventory.resolve('gci')?.canonical, 'Get-ChildItem');
    assert.equal(inventory.resolve('GCI')?.canonical, 'Get-ChildItem');
    assert.equal(inventory.resolve('no-such-command'), null);
  });

  it('resolves a parameter through its alias', () => {
    assert.equal(inventory.findParameter('gci', '-lp')?.name, 'LiteralPath');
    assert.equal(inventory.findParameter('Get-ChildItem', 'PSPath')?.name, 'LiteralPath');
    assert.equal(inventory.isSwitch('gci', 'Recurse'), true);
    assert.equal(inventory.isSwitch('gci', 'Path'), false);
  });

  it('adds common parameters only where real metadata was captured', () => {
    // Offering `-Verbose` on a command whose parameters nobody ever captured
    // would be inventing metadata, which is the one thing this repo will not do.
    const captured = inventory.parametersOf('Get-ChildItem').map((p) => p.name);
    assert.ok(captured.includes('Recurse'), 'declared');
    assert.ok(captured.includes('Verbose'), 'common');
    assert.deepEqual(inventory.parametersOf('Ls'), [], 'parameterSource: none');
    // -WhatIf and -Confirm are absent: nothing records SupportsShouldProcess.
    assert.equal(COMMON_PARAMETERS.some((p) => p.name === 'WhatIf'), false);
    assert.equal(COMMON_PARAMETERS.some((p) => p.name === 'Confirm'), false);
  });

  it('can be built from any manifest-shaped list, for tests and for hosts', () => {
    const custom = new CommandInventory([
      {
        name: 'do-thing',
        display: 'Do-Thing',
        aliases: ['dt'],
        synopsis: 'does the thing',
        parameters: [
          { name: 'Force', aliases: [], isSwitch: true, mandatory: false, type: 'Switch' },
        ],
        parameterSource: 'declared',
      },
    ]);
    assert.deepEqual(
      custom.commands.map((c) => c.name),
      ['Do-Thing', 'dt'],
    );
    assert.equal(custom.resolve('dt')?.canonical, 'Do-Thing');
  });
});

describe('matching', () => {
  it('puts every prefix hit above every fuzzy hit', () => {
    assert.equal(matchCandidate('Get-ChildItem', 'Get-ChildItem')?.kind, 'exact');
    assert.equal(matchCandidate('Get-ChildItem', 'Get-Ch')?.kind, 'prefix');
    assert.equal(matchCandidate('Get-ChildItem', 'get-ch')?.kind, 'prefix-ci');
    assert.equal(matchCandidate('Get-ChildItem', 'gchi')?.kind, 'fuzzy');
    assert.equal(matchCandidate('Get-ChildItem', 'zzz'), null);
    assert.equal(matchCandidate('anything', '')?.kind, 'prefix', 'an empty query matches all');
  });

  it('scores a fuzzy match by where the letters landed', () => {
    const contiguous = fuzzyScore('Get-ChildItem', 'chi') ?? 0;
    const scattered = fuzzyScore('Get-ChildItem', 'gti') ?? 0;
    assert.ok(contiguous > scattered, 'a contiguous run beats scattered letters');
    assert.ok((fuzzyScore('Get-ChildItem', 'gc') ?? 0) > 0, 'word starts score well');
    assert.equal(fuzzyScore('Get-ChildItem', 'xyz'), null);
  });

  it('ranks prefix hits ahead of fuzzy ones in a real completion', () => {
    const results = displaysOf('Get-C');
    const prefixed = results.filter((d) => d.startsWith('Get-C'));
    assert.ok(prefixed.length >= 3);
    assert.deepEqual(results.slice(0, prefixed.length), prefixed, 'no fuzzy hit jumps the queue');
    assert.equal(results[0], 'Get-Command');
  });

  it('lists alphabetically when nothing has been typed', () => {
    // Shortest-first is the right tiebreak for a query and unreadable without
    // one, so the comparator only applies it when there is a query.
    const all = displaysOf('');
    assert.deepEqual([...all].sort((a, b) => (a.toLowerCase() < b.toLowerCase() ? -1 : 1)), all);
    assert.equal(all.length, 135);
  });
});

describe('candidates', () => {
  it('completes a command name, and an alias as itself', () => {
    assert.deepEqual(displaysOf('Get-Ch'), ['Get-ChildItem']);
    assert.ok(displaysOf('gc').includes('gci'));
    assert.ok(displaysOf('gchi').includes('Get-ChildItem'), 'fuzzy reaches it too');
  });

  it('completes parameters of the command in this pipeline segment', () => {
    assert.equal(displaysOf('Get-ChildItem -Rec')[0], '-Recurse');
    assert.ok(displaysOf('Get-ChildItem | Sort-Object -Desc').includes('-Descending'));
    assert.ok(displaysOf('Get-ChildItem -Verb').includes('-Verbose'));
  });

  it('offers nothing rather than nonsense for a command with no metadata', () => {
    // v1 fell back to the whole command corpus here, so `-` answered `Get-Date`.
    assert.deepEqual(displaysOf('Ls -'), []);
  });

  it('takes arguments from the injected source, and quotes what it inserts', () => {
    const paths: readonly ArgumentSuggestion[] = [
      { value: 'my file.txt', detail: 'File' },
      { value: 'notes.md', detail: 'File' },
    ];
    const engine = new CompletionEngine({
      argumentSource: (ctx) => (ctx.parameterName === 'Path' ? paths : []),
    });
    const buffer = TextBuffer.of('Get-Content -Path ');
    const result = engine.complete(buffer);
    assert.equal(result.context.kind, 'parameter-value');
    assert.deepEqual(result.candidates.map((c) => c.text), ["'my file.txt'", 'notes.md']);
    assert.equal(engine.applyTo(buffer, result.context, result.candidates[0]!).text, "Get-Content -Path 'my file.txt'");
  });

  it('falls back to command names in argument position, as v1 did', () => {
    // The commonest argument in this shell is another command name.
    assert.ok(displaysOf('Get-Help Get-Child').includes('Get-ChildItem'));
    assert.deepEqual(displaysOf('Get-Help '), [], 'but not for an empty word');
  });

  it('writes over the caret span and keeps the rest of the line', () => {
    const engine = new CompletionEngine();
    const buffer = TextBuffer.of('Get-Ch | Sort-Object', 6);
    const result = engine.complete(buffer);
    const applied = engine.applyTo(buffer, result.context, result.candidates[0]!);
    assert.equal(applied.text, 'Get-ChildItem | Sort-Object');
    assert.equal(applied.caret, 13, 'the caret follows the insertion, not the line');
  });

  it('replaces the whole quoted token when completing inside quotes', () => {
    const engine = new CompletionEngine({
      argumentSource: () => [{ value: 'my file.txt' }],
    });
    const buffer = TextBuffer.of("Get-Content 'my fi");
    const result = engine.complete(buffer);
    assert.equal(engine.applyTo(buffer, result.context, result.candidates[0]!).text, "Get-Content 'my file.txt'");
  });
});
