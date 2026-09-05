/**
 * simulated-determinism.test.mts — the same seed prints the same fiction.
 *
 * Two of these twenty-six commands would otherwise vary between runs, and both
 * for the same reason: they reach for something ambient. `uptime` reads the
 * clock; `ping` and `Test-Connection` draw latencies that were never measured.
 * v1 read `new Date()` and `Math.random()` directly, so its ping printed
 * different fake numbers every time — which is no more honest than printing the
 * same fake numbers, and considerably harder to test.
 *
 * So the clock and the generator are injected, and this file asserts the three
 * things that makes true:
 *
 *   1. the same environment produces byte-identical output, for all 26;
 *   2. a DIFFERENT seed produces different latencies, so the injection is real
 *      and not a constant hiding behind a parameter;
 *   3. the twenty-three commands that should not vary at all do not vary even
 *      when the clock and the seed both change.
 *
 * The third is the one that catches a future `fortune` that started drawing at
 * random, or a `df` that started reporting a real storage estimate.
 */

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

import { isPSObject } from '../../src/pipeline/psobject.ts';
import type { PSObject } from '../../src/pipeline/psobject.ts';
import {
  createSimulatedCommands,
  defaultEnvironment,
  fixedEnvironment,
  freshPackageState,
  seededRandom,
} from '../../src/commands/simulated/index.ts';
import { grantedSession, moduleNamed } from './simulated-harness.mts';
import type { RunOptions } from './simulated-harness.mts';

const AT = Date.parse('2026-09-05T09:12:00Z');

interface Invocation extends RunOptions {
  readonly name: string;
}

/** Every command, at least once. The two that vary appear with a target. */
const EVERY_COMMAND: readonly Invocation[] = [
  { name: 'uname', args: ['-a'] },
  { name: 'lsb_release' },
  { name: 'hostname' },
  { name: 'df' },
  { name: 'free' },
  { name: 'uptime' },
  { name: 'exit' },
  { name: 'ping', args: ['nycu.edu.tw'] },
  { name: 'traceroute', args: ['nycu.edu.tw'] },
  { name: 'test-connection', parameters: { TargetName: 'nycu.edu.tw' } },
  { name: 'ifconfig' },
  { name: 'ip', args: ['addr'] },
  { name: 'ps', args: ['aux'] },
  { name: 'get-process' },
  { name: 'git', args: ['log'] },
  { name: 'sudo', args: ['ls'] },
  { name: 'bash' },
  { name: 'classic' },
  { name: 'coffee' },
  { name: 'fortune' },
  { name: 'konami' },
  { name: 'matrix' },
  { name: 'rocket' },
  { name: 'secret' },
  { name: 'sl' },
  { name: 'thc1006' },
];

/**
 * Everything that came out, in a form `deepEqual` can compare.
 *
 * `unknown` rather than `PSValue` because a PSObject is flattened to its
 * properties first: comparing the objects themselves would also compare the
 * shared `typeNames` array, which is the same array instance every time and so
 * would pass whatever the properties said.
 */
async function transcript(options: {
  readonly seed: number;
  readonly now: number;
  readonly only?: readonly string[];
}): Promise<readonly (readonly [string, readonly unknown[], readonly string[], number])[]> {
  const modules = createSimulatedCommands(
    fixedEnvironment({ seed: options.seed, now: options.now, packages: freshPackageState() }),
  );
  const session = grantedSession();
  const wanted =
    options.only === undefined
      ? EVERY_COMMAND
      : EVERY_COMMAND.filter((invocation) => options.only?.includes(invocation.name) === true);

  const out: (readonly [string, readonly unknown[], readonly string[], number])[] = [];
  for (const invocation of wanted) {
    const result = await session.run(moduleNamed(modules, invocation.name), invocation);
    const values: unknown[] = result.values.map((value) =>
      isPSObject(value) ? { ...(value as PSObject).properties } : value,
    );
    out.push([invocation.name, values, result.errorMessages, result.exitCode]);
  }
  return out;
}

describe('determinism under an injected clock and seed', () => {
  it('every command is byte-identical across two runs of the same environment', async () => {
    const first = await transcript({ seed: 1006, now: AT });
    const second = await transcript({ seed: 1006, now: AT });
    assert.deepEqual(first, second);
    assert.equal(first.length, 26, 'the transcript must cover all 26 commands');
  });

  it('the twenty-three fixed commands do not vary with the clock or the seed', async () => {
    const varying = ['uptime', 'ping', 'test-connection'];
    const fixedNames = EVERY_COMMAND.map((invocation) => invocation.name).filter(
      (name) => !varying.includes(name),
    );
    assert.equal(fixedNames.length, 23, 'ping appears once, and so does each of the others');

    const first = await transcript({ seed: 1, now: AT, only: fixedNames });
    const second = await transcript({
      seed: 999999,
      now: Date.parse('1999-12-31T23:59:59Z'),
      only: fixedNames,
    });
    assert.deepEqual(first, second);
  });

  it('a different seed really does change the latencies', async () => {
    const one = await transcript({ seed: 1, now: AT, only: ['ping'] });
    const other = await transcript({ seed: 2, now: AT, only: ['ping'] });
    assert.notDeepEqual(one, other, 'the seed is not reaching the generator');

    // And the same seed reaches it the same way through Test-Connection.
    const a = await transcript({ seed: 7, now: AT, only: ['test-connection'] });
    const b = await transcript({ seed: 7, now: AT, only: ['test-connection'] });
    assert.deepEqual(a, b);
    const c = await transcript({ seed: 8, now: AT, only: ['test-connection'] });
    assert.notDeepEqual(a, c);
  });

  it('a different clock really does change uptime, and nothing else', async () => {
    const morning = await transcript({ seed: 1, now: AT, only: ['uptime'] });
    const evening = await transcript({
      seed: 1,
      now: AT + 7 * 60 * 60 * 1000,
      only: ['uptime'],
    });
    assert.notDeepEqual(morning, evening);
  });

  it('the latencies stay inside the range v1 drew from', async () => {
    for (const seed of [0, 1, 1006, 65535, 2 ** 31]) {
      const run = await transcript({ seed, now: AT, only: ['ping'] });
      const lines = (run[0]?.[1] ?? []).filter(
        (value): value is string => typeof value === 'string',
      );
      const replies = lines.filter((line) => line.includes('icmp_seq='));
      assert.equal(replies.length, 4);
      for (const reply of replies) {
        const match = /time=(\d+\.\d) ms/u.exec(reply);
        assert.ok(match !== null, reply);
        const value = Number(match[1]);
        // v1 draws `Math.random() * 8 + 3`, so [3, 11).
        assert.ok(value >= 3 && value < 11, `${value} is outside v1's range`);
      }
    }
  });
});

describe('the generator itself', () => {
  it('is reproducible and pinned, so a change to it is visible here', () => {
    const first = seededRandom(1006);
    const second = seededRandom(1006);
    const drawn = [first(), first(), first(), first()];
    assert.deepEqual(drawn, [second(), second(), second(), second()]);
    for (const value of drawn) {
      assert.ok(value >= 0 && value < 1, `${value} is not in [0, 1)`);
    }
    // Not a property of good randomness — a tripwire. If mulberry32 is ever
    // swapped for something else, the seeded output changes and this says so
    // instead of the change sliding through as "still random".
    assert.deepEqual(
      drawn.map((value) => Number(value.toFixed(6))),
      [0.352557, 0.22053, 0.932802, 0.966076],
    );
  });

  it('different seeds diverge immediately', () => {
    const a = seededRandom(1);
    const b = seededRandom(2);
    assert.notEqual(a(), b());
  });
});

describe('the default environment', () => {
  it('keeps v1s behaviour: the real clock and a real generator', () => {
    const environment = defaultEnvironment();
    const before = Date.now();
    const now = environment.now();
    assert.ok(now >= before, 'the default clock is not the real one');
    const draw = environment.random();
    assert.ok(draw >= 0 && draw < 1);
  });

  it('gives each session its own package state, so two terminals do not share a joke', () => {
    const first = defaultEnvironment();
    const second = defaultEnvironment();
    first.packages.netToolsInstalled = true;
    assert.equal(second.packages.netToolsInstalled, false);
  });

  it('the exported default command set is built once and is complete', async () => {
    const { SIMULATED_COMMANDS, SIMULATED_COMMAND_INDEX } = await import(
      '../../src/commands/simulated/index.ts'
    );
    assert.equal(SIMULATED_COMMANDS.length, 26);
    // `gps` is Get-Process's alias and the only one in this family.
    assert.equal(SIMULATED_COMMAND_INDEX.get('gps')?.manifest.name, 'get-process');
    assert.equal(SIMULATED_COMMAND_INDEX.get('sl')?.manifest.name, 'sl');
    for (const module of SIMULATED_COMMANDS) {
      assert.equal(SIMULATED_COMMAND_INDEX.get(module.manifest.name), module);
    }
  });
});
