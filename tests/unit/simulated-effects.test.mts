/**
 * simulated-effects.test.mts — proving the absence of an effect.
 *
 * `simulated` is defined as "the output is invented or fixed, and nothing
 * outside this page is read or changed". Every other test in this family checks
 * the first half. This one checks the second, which is harder, because absence
 * does not show up in output: a `ping` that quietly fired a cross-origin request
 * before printing its invented latencies would pass every parity assertion.
 *
 * Three angles, because each catches what the others miss:
 *
 *   RUNTIME    every network, storage and DOM global is replaced with a trap
 *              that records and throws, and all twenty-six commands are run
 *              across their branches. Catches anything reached at run time,
 *              including through a helper.
 *
 *   STATIC     the source of `src/commands/simulated/` is scanned with comments
 *              stripped. Catches a branch the runtime pass did not enter — the
 *              one that only runs on a Tuesday — and it is the half that would
 *              have caught a `localStorage` write behind a condition.
 *
 *   BROKER     every capability request goes through a real `CapabilityBroker`,
 *              and no command may ask for one it did not declare. The broker's
 *              first gate denies an undeclared capability even when the session
 *              granted it, so this asserts the commands never get near that
 *              gate rather than that the gate works — which is
 *              `kernel-capabilities.test.mts`'s job.
 *
 * And then `sudo`, at length, because it is the claim most worth attacking.
 */

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync } from 'node:fs';

import type { CommandModule } from '../../src/commands/invocation.ts';
import { CapabilityDeniedError } from '../../src/commands/invocation.ts';
import type { Capability, CommandManifest } from '../../src/commands/manifest.ts';
import {
  CAPABILITY_REALITY,
  ELEVATION_CONFERS,
  assertElevationCannotConferReality,
} from '../../src/kernel/capabilities.ts';
import {
  createSimulatedCommands,
  freshPackageState,
} from '../../src/commands/simulated/index.ts';
import type { SimulatedEnvironment } from '../../src/commands/simulated/index.ts';
import { Session, grantedSession, moduleNamed } from './simulated-harness.mts';
import type { RunOptions } from './simulated-harness.mts';

// ---------------------------------------------------------------------------
// every branch of every command, in one list
// ---------------------------------------------------------------------------

interface Invocation extends RunOptions {
  readonly name: string;
}

/**
 * Enough invocations to reach every branch that exists.
 *
 * Kept as data rather than as twenty-six tests because all three passes below
 * drive the same list, and a branch added to a command should be added here
 * once rather than three times.
 */
const INVOCATIONS: readonly Invocation[] = [
  { name: 'uname' },
  { name: 'uname', args: ['-a'] },
  { name: 'uname', args: ['-r'] },
  { name: 'uname', args: ['-m'] },
  { name: 'uname', args: ['-n'] },
  { name: 'lsb_release' },
  { name: 'hostname' },
  { name: 'df' },
  { name: 'free' },
  { name: 'uptime' },
  { name: 'exit' },
  { name: 'ping' },
  { name: 'ping', args: ['nycu.edu.tw'] },
  { name: 'traceroute' },
  { name: 'traceroute', args: ['example.com'] },
  { name: 'test-connection', parameters: { TargetName: 'example.com' } },
  { name: 'test-connection', parameters: { TargetName: 'x', Quiet: true } },
  { name: 'test-connection', parameters: { TargetName: 'x', Traceroute: true } },
  { name: 'test-connection', parameters: { TargetName: 'x', TimeoutSeconds: 1 } },
  { name: 'ifconfig' },
  { name: 'ip' },
  { name: 'ip', args: ['addr'] },
  { name: 'ip', args: ['route'] },
  { name: 'ps' },
  { name: 'ps', args: ['aux'] },
  { name: 'get-process' },
  { name: 'get-process', parameters: { Name: 'pwsh' } },
  { name: 'get-process', parameters: { Name: 'nosuch' } },
  { name: 'get-process', parameters: { Id: '1006' } },
  { name: 'get-process', parameters: { Module: true } },
  { name: 'get-process', parameters: { InputObject: 'anything' } },
  { name: 'git' },
  { name: 'git', args: ['status'] },
  { name: 'git', args: ['log'] },
  { name: 'git', args: ['remote'] },
  { name: 'sudo', args: ['ls'] },
  { name: 'sudo', args: ['rm', '-rf', '/'] },
  { name: 'sudo', args: ['apt', 'install', 'net-tools'] },
  // After the install above flips the flag, so the failure branch is reached.
  { name: 'ifconfig' },
  { name: 'ifconfig' },
  { name: 'bash' },
  { name: 'classic' },
  { name: 'coffee' },
  { name: 'fortune' },
  { name: 'konami' },
  { name: 'matrix' },
  { name: 'rocket' },
  { name: 'secret' },
  { name: 'sl' },
  { name: 'sl', args: ['/tmp'] },
  { name: 'thc1006' },
];

function environment(): SimulatedEnvironment {
  // Enough draws for every ping and Test-Connection in the list above.
  const randoms = Array.from({ length: 64 }, (_value, index) => ((index * 37) % 100) / 100);
  let drawn = 0;
  return {
    now: () => Date.parse('2026-09-05T09:12:00Z'),
    random: (): number => randoms[drawn++ % randoms.length] ?? 0,
    packages: freshPackageState(),
  };
}

async function runAll(session: Session): Promise<readonly Capability[]> {
  const modules = createSimulatedCommands(environment());
  const requested: Capability[] = [];
  for (const invocation of INVOCATIONS) {
    const module = moduleNamed(modules, invocation.name);
    const result = await session.run(module, invocation);
    requested.push(...result.requested);
  }
  return requested;
}

// ---------------------------------------------------------------------------
// 1. runtime
// ---------------------------------------------------------------------------

/**
 * The globals a command would have to reach for to have a real effect.
 *
 * `Math.random` and `Date.now` are NOT trapped here, even though they are the
 * two ambient sources this family is not allowed to touch. Node's test runner
 * uses both between awaits, so trapping them would fail on the harness rather
 * than on the code. They are covered by the static pass instead, which is the
 * stronger check for them anyway: it proves no branch reaches for them, not
 * just no branch that ran.
 */
const TRAPPED = [
  'fetch',
  'XMLHttpRequest',
  'WebSocket',
  'EventSource',
  'Worker',
  'SharedWorker',
  'BroadcastChannel',
  'localStorage',
  'sessionStorage',
  'indexedDB',
  'caches',
  'document',
  'window',
  'navigator',
  'importScripts',
] as const;

interface Trap {
  readonly touched: string[];
  restore(): void;
}

function installTraps(): Trap {
  const touched: string[] = [];
  const saved = new Map<string, PropertyDescriptor | undefined>();

  for (const name of TRAPPED) {
    saved.set(name, Object.getOwnPropertyDescriptor(globalThis, name));
    // A Proxy so that reading ANY member counts, not only calling the thing.
    // `localStorage.getItem` and `navigator.sendBeacon` are property reads
    // before they are calls, and a command that merely looked would be a
    // command that could.
    const trap = new Proxy(
      function trapped(): never {
        touched.push(`${name}()`);
        throw new Error(`a simulated command called ${name}()`);
      },
      {
        get(_target, property): never {
          touched.push(`${name}.${String(property)}`);
          throw new Error(`a simulated command read ${name}.${String(property)}`);
        },
        apply(): never {
          touched.push(`${name}()`);
          throw new Error(`a simulated command called ${name}()`);
        },
      },
    );
    Object.defineProperty(globalThis, name, {
      value: trap,
      configurable: true,
      writable: true,
    });
  }

  return {
    touched,
    restore(): void {
      for (const [name, descriptor] of saved) {
        if (descriptor === undefined) {
          Reflect.deleteProperty(globalThis, name);
        } else {
          Object.defineProperty(globalThis, name, descriptor);
        }
      }
    },
  };
}

describe('no simulated command performs a real effect', () => {
  it('touches no network, storage or DOM global across every branch', async () => {
    const trap = installTraps();
    try {
      await runAll(grantedSession());
    } finally {
      trap.restore();
    }
    assert.deepEqual(
      trap.touched,
      [],
      `simulated commands touched: ${trap.touched.join(', ')}`,
    );
  });

  it('the trap really fires, so an empty list means something', async () => {
    // A test that proves absence has to prove it could have detected presence.
    const trap = installTraps();
    let threw = false;
    try {
      await (globalThis as unknown as { fetch: () => Promise<unknown> }).fetch();
    } catch {
      threw = true;
    } finally {
      trap.restore();
    }
    assert.ok(threw, 'the fetch trap did not throw');
    assert.deepEqual(trap.touched, ['fetch()']);
  });
});

// ---------------------------------------------------------------------------
// 2. static
// ---------------------------------------------------------------------------

const SIMULATED_DIRECTORY = new URL('../../src/commands/simulated/', import.meta.url);

/**
 * Strip comments, leaving strings and regular expressions intact.
 *
 * Needed because the comments in this directory deliberately NAME the APIs that
 * are not used — "`navigator.deviceMemory` buckets RAM into powers of two",
 * "`window.close()` is ignored for any tab a script did not open" — and those
 * explanations are the most useful part of the file. A scanner that could not
 * tell prose from code would force them out.
 *
 * Regular-expression literals are tracked because `support.ts` contains
 * `/^["']|["']$/`, whose quotes would otherwise open a string state that ran to
 * the end of the file and hid everything after it.
 */
function stripComments(source: string): string {
  let out = '';
  let index = 0;
  let previousSignificant = '';

  while (index < source.length) {
    const char = source[index] ?? '';
    const next = source[index + 1] ?? '';

    if (char === '/' && next === '/') {
      while (index < source.length && source[index] !== '\n') index += 1;
      continue;
    }
    if (char === '/' && next === '*') {
      index += 2;
      while (index < source.length && !(source[index] === '*' && source[index + 1] === '/')) {
        index += 1;
      }
      index += 2;
      continue;
    }
    if (char === '"' || char === "'" || char === '`') {
      const quote = char;
      out += char;
      index += 1;
      while (index < source.length) {
        const inner = source[index] ?? '';
        out += inner;
        index += 1;
        if (inner === '\\') {
          out += source[index] ?? '';
          index += 1;
          continue;
        }
        if (inner === quote) break;
      }
      previousSignificant = quote;
      continue;
    }
    // A `/` here is a regex only if an operand cannot precede it.
    if (char === '/' && '(,=:[!&|?{};+-*%~^<>'.includes(previousSignificant)) {
      out += char;
      index += 1;
      let inClass = false;
      while (index < source.length) {
        const inner = source[index] ?? '';
        out += inner;
        index += 1;
        if (inner === '\\') {
          out += source[index] ?? '';
          index += 1;
          continue;
        }
        if (inner === '[') inClass = true;
        else if (inner === ']') inClass = false;
        else if (inner === '/' && !inClass) break;
      }
      previousSignificant = '/';
      continue;
    }
    out += char;
    if (!/\s/u.test(char)) previousSignificant = char;
    index += 1;
  }
  return out;
}

/** Patterns that must not appear in code anywhere in this directory. */
const FORBIDDEN: readonly (readonly [RegExp, string])[] = [
  [/(?<![\w.$])fetch\s*\(/u, 'fetch()'],
  [
    /new\s+(?:XMLHttpRequest|WebSocket|EventSource|Worker|SharedWorker|BroadcastChannel|Image|Audio)\b/u,
    'a network or media constructor',
  ],
  [
    /(?<![\w.$])(?:localStorage|sessionStorage|indexedDB|caches)\s*[.[]/u,
    'browser storage',
  ],
  [/(?<![\w.$])(?:document|window|navigator|location)\s*[.[]/u, 'the DOM or the host'],
  [/sendBeacon\s*\(/u, 'sendBeacon()'],
  [/(?<![\w.$])eval\s*\(/u, 'eval()'],
  [/new\s+Function\s*\(/u, 'new Function()'],
  [/(?<![\w.$])import\s*\(/u, 'a dynamic import'],
  [/(?<![\w.$])(?:setTimeout|setInterval|queueMicrotask|requestAnimationFrame)\s*\(/u, 'a timer'],
  [/(?<![\w.$])postMessage\s*\(/u, 'postMessage()'],
];

/** The two ambient sources of variation, allowed in exactly one file. */
const AMBIENT: readonly (readonly [RegExp, string])[] = [
  [/(?<![\w.$])Math\s*\.\s*random\b/u, 'Math.random'],
  [/(?<![\w.$])Date\s*\.\s*now\b/u, 'Date.now'],
  [/new\s+Date\s*\(\s*\)/u, 'new Date() with no argument'],
];

function sourceFiles(): readonly { readonly name: string; readonly code: string }[] {
  return readdirSync(SIMULATED_DIRECTORY)
    .filter((name) => name.endsWith('.ts'))
    .map((name) => ({
      name,
      code: stripComments(readFileSync(new URL(name, SIMULATED_DIRECTORY), 'utf8')),
    }));
}

describe('the source of src/commands/simulated/', () => {
  it('was read at all, and is the whole directory', () => {
    const names = sourceFiles().map((file) => file.name).sort();
    assert.deepEqual(names, [
      'environment.ts',
      'index.ts',
      'jokes.ts',
      'machine.ts',
      'network.ts',
      'portfolio.ts',
      'privilege.ts',
      'processes.ts',
      'support.ts',
    ]);
  });

  it('reaches for no browser API in any file', () => {
    for (const file of sourceFiles()) {
      for (const [pattern, description] of FORBIDDEN) {
        const match = pattern.exec(file.code);
        assert.equal(
          match,
          null,
          `${file.name} reaches for ${description}: ${JSON.stringify(match?.[0])}`,
        );
      }
    }
  });

  it('confines the clock and the generator to environment.ts', () => {
    for (const file of sourceFiles()) {
      if (file.name === 'environment.ts') continue;
      for (const [pattern, description] of AMBIENT) {
        const match = pattern.exec(file.code);
        assert.equal(
          match,
          null,
          `${file.name} uses ${description}; it must take it from the injected environment`,
        );
      }
    }
  });

  it('the comment stripper leaves code alone and prose out', () => {
    // Guards the scanner itself: without this, a stripper that ate everything
    // would make the two tests above pass vacuously.
    const sample = [
      "const a = '// not a comment';",
      '// a real comment mentioning fetch(',
      'const b = /^["\']|["\']$/gu;',
      '/* block mentioning localStorage. */',
      'const c = fetch;',
    ].join('\n');
    const stripped = stripComments(sample);
    assert.ok(stripped.includes("'// not a comment'"), stripped);
    assert.ok(stripped.includes('const c = fetch;'), stripped);
    assert.ok(stripped.includes('["\']$/gu'), stripped);
    assert.ok(!stripped.includes('a real comment'), stripped);
    assert.ok(!stripped.includes('block mentioning'), stripped);
  });
});

// ---------------------------------------------------------------------------
// 3. the broker
// ---------------------------------------------------------------------------

describe('capabilities', () => {
  it('no command asks for anything it did not declare', async () => {
    const modules = createSimulatedCommands(environment());
    // Grant EVERYTHING, so a command asking for something extra would succeed
    // rather than throw — the failure has to come from this assertion, not from
    // the broker refusing and making the run look broken.
    const everything = Object.keys(CAPABILITY_REALITY) as Capability[];
    for (const invocation of INVOCATIONS) {
      const module = moduleNamed(modules, invocation.name);
      const session = new Session({ grants: everything });
      const result = await session.run(module, invocation);
      for (const capability of result.requested) {
        assert.ok(
          module.manifest.capabilities.includes(capability),
          `${module.manifest.display} asked for ${capability}, which it does not declare`,
        );
      }
    }
  });

  it('asks for nothing at all except in the four places that declare something', async () => {
    const requested = await runAll(grantedSession());
    const unique = [...new Set(requested)].sort();
    assert.deepEqual(unique, ['portfolio.read', 'process.read', 'virtual.policy.elevate']);
  });

  it('never asks for a filesystem, network, clipboard or device capability', async () => {
    const requested = new Set(await runAll(grantedSession()));
    for (const capability of [
      'filesystem.read',
      'filesystem.write',
      'filesystem.delete',
      'network.fetch',
      'clipboard.read',
      'clipboard.write',
      'device.request',
      'preferences.write',
      'process.control',
    ] as const) {
      assert.ok(!requested.has(capability), `a simulated command asked for ${capability}`);
    }
  });
});

// ---------------------------------------------------------------------------
// 4. sudo
// ---------------------------------------------------------------------------

/** A stand-in for a command that really would write a file. */
const WRITER: CommandManifest = {
  name: 'set-content',
  display: 'Set-Content',
  aliases: [],
  runtime: 'browser',
  fidelity: 'browser-backed',
  risk: 'write',
  capabilities: ['filesystem.read', 'filesystem.write'],
  parameters: [],
  outputTypeNames: [],
  synopsis: 'Writes new content in a file.',
  parameterSource: 'declared',
  implementationStatus: 'implemented',
};

function sudoModule(): CommandModule {
  return moduleNamed(createSimulatedCommands(environment()), 'sudo');
}

describe('sudo confers nothing', () => {
  it('a root session still cannot obtain filesystem.write', async () => {
    // The session is elevated and `sudo` has run. Nothing else is granted.
    const session = new Session({ grants: ['virtual.policy.elevate'], elevated: true });
    assert.equal(session.policy.user, 'root', 'the virtual policy says root');
    await session.run(sudoModule(), { args: ['ls'] });

    assert.equal(
      session.broker.evaluate(WRITER, 'filesystem.write'),
      'denied:elevation-not-transferable',
      'being root in the simulation must not confer a real capability',
    );

    const scoped = session.broker.forCommand(WRITER, 1);
    assert.throws(
      () => scoped.require('filesystem.write'),
      (error: unknown) =>
        error instanceof CapabilityDeniedError && error.capability === 'filesystem.write',
    );

    // And the refusal is on the record, not merely thrown.
    const denials = session.audit.denials();
    assert.ok(
      denials.some(
        (record) =>
          record.capability === 'filesystem.write' &&
          record.decision === 'denied:elevation-not-transferable',
      ),
      'the denial was not audited',
    );
  });

  it('elevation confers the empty set, and cannot be made to confer a real one', () => {
    assert.deepEqual([...ELEVATION_CONFERS], []);
    assert.equal(CAPABILITY_REALITY['virtual.policy.elevate'], false);
    assert.doesNotThrow(() => {
      assertElevationCannotConferReality();
    });
  });

  it('does not even move the virtual uid, as v1 does not', async () => {
    const session = new Session({ grants: ['virtual.policy.elevate'] });
    await session.run(sudoModule(), { args: ['ls'] });
    assert.equal(session.policy.elevated, false);
    assert.equal(session.policy.user, 'visitor');
  });

  it('goes through the broker: the ask is audited and marked not real', async () => {
    const session = new Session({ grants: ['virtual.policy.elevate'] });
    const result = await session.run(sudoModule(), { args: ['ls'] });
    assert.deepEqual(result.requested, ['virtual.policy.elevate']);

    const record = session.audit.records.find(
      (entry) => entry.capability === 'virtual.policy.elevate',
    );
    assert.ok(record !== undefined, 'the elevation request left no audit record');
    assert.equal(record.decision, 'granted');
    // The field a reviewer scans. A granted virtual capability is still not
    // real, which is the whole claim.
    assert.equal(record.real, false);
    assert.equal(record.fidelity, 'simulated');
    assert.equal(record.risk, 'privileged-simulation');
  });

  it('prints the same thing whether the elevation is granted or refused', async () => {
    const granted = await new Session({ grants: ['virtual.policy.elevate'] }).run(
      sudoModule(),
      { args: ['ls'] },
    );
    const refusedSession = new Session({ grants: [] });
    const refused = await refusedSession.run(sudoModule(), { args: ['ls'] });

    assert.deepEqual(refused.lines, granted.lines);
    assert.deepEqual(refused.errorMessages, granted.errorMessages);
    assert.equal(refused.exitCode, granted.exitCode);
    // The difference is in the log, which is where it belongs.
    assert.ok(
      refusedSession.audit.denials().some((r) => r.capability === 'virtual.policy.elevate'),
      'the refusal was not recorded',
    );
  });

  it('says in its note that it grants nothing, and never can', () => {
    const notes = sudoModule().manifest.notes ?? '';
    assert.match(notes, /Grants nothing/u);
    assert.match(notes, /never can/u);
  });
});
