/**
 * simulated.test.mts — every simulated command, against the archive.
 *
 * The standard is: a visitor who used the old page must not see the output
 * change. So each expectation comes from `legacy/terminal-v1.html` itself, run
 * at test time by `simulated-v1-archive.mts`, not from a string somebody typed
 * twice. If the archive and the implementation ever disagree, this file says
 * which command and on which line.
 *
 * TWO COMMANDS DELIBERATELY DIVERGE, AND THE DIVERGENCE IS ASSERTED RATHER THAN
 * WAIVED
 *
 * `Get-Process` and `Test-Connection` are cmdlets. v1 had one output channel,
 * so both of them returned rendered text, and `Get-Process | Sort-Object CPU`
 * sorted padded strings while `Test-Connection` produced no `Latency` to filter
 * on at all — v1's own dispatcher refuses to put ping-shaped commands in a
 * pipeline rather than pretend. The rewrite emits objects from both. What is
 * checked here is that the objects carry EXACTLY the facts v1's text stated:
 * the same six processes with the same four columns, and the same four replies
 * with the same latencies. Nothing new is claimed and nothing is dropped.
 *
 * `ps`, `ping` and `traceroute` are Applications — native binaries — and their
 * text is compared byte for byte.
 */

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

import { isPSObject } from '../../src/pipeline/psobject.ts';
import type { PSObject, PSValue } from '../../src/pipeline/psobject.ts';
import type { CommandModule } from '../../src/commands/invocation.ts';
import {
  SIMULATED_MANIFEST_NAMES,
  createSimulatedCommands,
  freshPackageState,
} from '../../src/commands/simulated/index.ts';
import type {
  PackageState,
  SimulatedEnvironment,
} from '../../src/commands/simulated/index.ts';
import { PROCESS_TYPE_NAMES, MEBIBYTE } from '../../src/commands/simulated/processes.ts';
import { PING_STATUS_TYPE } from '../../src/commands/simulated/network.ts';
import { TIMELINE } from '../../src/commands/simulated/portfolio.ts';
import { MATRIX_ALPHABET } from '../../src/commands/simulated/jokes.ts';
import {
  V1_HOSTNAME,
  V1_USER,
  v1Cmdlet,
  v1Egg,
  v1RedRows,
  v1Texts,
  v1Timeline,
} from './simulated-v1-archive.mts';
import type { V1Options, V1Run } from './simulated-v1-archive.mts';
import { bindParameters, tryBindParameters } from '../../src/binding/index.ts';
import type { CompatibilityView } from '../../src/commands/invocation.ts';
import { grantedSession, moduleNamed } from './simulated-harness.mts';
import type { RunOptions, RunResult } from './simulated-harness.mts';

// ---------------------------------------------------------------------------
// harness
// ---------------------------------------------------------------------------

const FIXED_NOW = Date.parse('2026-09-05T13:07:09');

function environment(options: {
  readonly randoms?: readonly number[];
  readonly packages?: PackageState;
} = {}): SimulatedEnvironment {
  const randoms = options.randoms ?? [];
  let drawn = 0;
  return {
    now: () => FIXED_NOW,
    random: (): number => {
      const value = randoms[drawn];
      drawn += 1;
      if (value === undefined) throw new Error('the implementation drew more randoms than v1');
      return value;
    },
    packages: options.packages ?? freshPackageState(),
  };
}

function command(name: string, environmentOptions: Parameters<typeof environment>[0] = {}): CommandModule {
  return moduleNamed(createSimulatedCommands(environment(environmentOptions)), name);
}

async function run(module: CommandModule, options: RunOptions = {}): Promise<RunResult> {
  return grantedSession().run(module, options);
}

/**
 * The whole assertion for a text command: every line v1 printed arrives, in
 * order, on the stream this rewrite chose for it.
 *
 * `errorTexts` is EXPLICIT rather than derived from v1's CSS classes, and the
 * first version of this helper got that wrong. It routed every row v1 classed
 * `err` to stream 2, which put `rocket`'s three exhaust flames in `$Error` —
 * `err` is v1's red class, not its error channel. So a line only moves to
 * stream 2 when this file names it, and naming one that v1 did not paint red is
 * itself a failure: the rewrite may reclassify colour as an error, but it may
 * not invent an error out of a line v1 showed as ordinary output.
 */
function assertMatchesArchive(
  result: RunResult,
  archive: V1Run,
  label: string,
  errorTexts: readonly string[] = [],
): void {
  const red = v1RedRows(archive);
  for (const text of errorTexts) {
    assert.ok(red.includes(text), `${label}: '${text}' was not a red row in v1`);
  }
  const expectedOutput = v1Texts(archive).filter((text) => !errorTexts.includes(text));
  assert.deepEqual(result.lines, expectedOutput, `${label}: stream 1 differs from v1`);
  assert.deepEqual(result.errorMessages, errorTexts, `${label}: stream 2 differs`);
}

/** Run the same input through both and compare. The common case. */
async function compare(
  name: string,
  args: readonly string[],
  archive: V1Run,
  environmentOptions: Parameters<typeof environment>[0] = {},
  errorTexts: readonly string[] = [],
): Promise<RunResult> {
  const result = await run(command(name, environmentOptions), { args });
  assertMatchesArchive(result, archive, `${name} ${args.join(' ')}`.trim(), errorTexts);
  return result;
}

const cmdlet = (name: string, args: readonly string[], options?: V1Options): V1Run =>
  v1Cmdlet(name, [name, ...args], options);

const properties = (value: PSValue): Readonly<Record<string, PSValue>> => {
  assert.ok(isPSObject(value), 'expected a PSObject on the success stream');
  return (value as PSObject).properties;
};

// ---------------------------------------------------------------------------
// the set itself
// ---------------------------------------------------------------------------

describe('the simulated command set', () => {
  it('implements every command manifests.json classifies simulated', () => {
    const implemented = createSimulatedCommands(environment())
      .map((module) => module.manifest.name)
      .sort();
    // Both directions. A missing implementation is the drift this guards
    // against; an extra one would mean a module claiming a classification the
    // generated manifests do not give it, which `simulatedManifest` already
    // refuses but which is worth stating as a set equality.
    assert.deepEqual(implemented, [...SIMULATED_MANIFEST_NAMES]);
    assert.equal(implemented.length, 26);
  });

  it('re-declares nothing: every manifest is the generated one, note and all', () => {
    for (const module of createSimulatedCommands(environment())) {
      const { manifest } = module;
      assert.equal(manifest.fidelity, 'simulated', `${manifest.name} fidelity`);
      assert.ok(
        manifest.notes !== undefined && manifest.notes.trim() !== '',
        `${manifest.name} must carry a note saying what it does not do`,
      );
      // `Get-Help` and `Get-Command -Detailed` read these fields; a command
      // that built its own manifest could disagree with the classification a
      // reviewer read, which is the whole failure mode the generator exists to
      // prevent.
      assert.equal(manifest.runtime, 'semantic', `${manifest.name} runtime`);
    }
  });

  it('declares only the three capabilities the classification gives this family', () => {
    const declared = new Set(
      createSimulatedCommands(environment()).flatMap((module) => [
        ...module.manifest.capabilities,
      ]),
    );
    assert.deepEqual(
      [...declared].sort(),
      ['portfolio.read', 'process.read', 'virtual.policy.elevate'],
    );
  });
});

// ---------------------------------------------------------------------------
// the invented machine
// ---------------------------------------------------------------------------

describe('uname', () => {
  for (const flags of [[], ['-a'], ['--all'], ['-r'], ['-m'], ['-n'], ['-m', '-a']]) {
    it(`matches v1 for ${flags.length === 0 ? '(no flags)' : flags.join(' ')}`, async () => {
      await compare('uname', flags, cmdlet('uname', flags));
    });
  }

  it('reports the simulated hostname the archive declares, not a real one', async () => {
    const result = await compare('uname', ['-n'], cmdlet('uname', ['-n']));
    assert.deepEqual(result.lines, [V1_HOSTNAME]);
  });
});

describe('lsb_release, hostname, df, free', () => {
  for (const name of ['lsb_release', 'hostname', 'df', 'free']) {
    it(`${name} matches v1`, async () => {
      await compare(name, [], cmdlet(name, []));
    });
  }

  it('df reports invented figures, not the origin storage estimate', async () => {
    const result = await compare('df', [], cmdlet('df', []));
    // The point of the note: these are not `navigator.storage.estimate()`.
    assert.ok(result.lines.some((line) => line.includes('/dev/root')));
    assert.equal(result.requested.length, 0, 'df must request no capability');
  });
});

describe('uptime', () => {
  it('matches v1 under the same clock', async () => {
    await compare('uptime', [], cmdlet('uptime', [], { now: FIXED_NOW }));
  });

  it('is the injected clock, not the wall clock', async () => {
    const first = await run(command('uptime'), {});
    const second = await run(command('uptime'), {});
    assert.deepEqual(first.lines, second.lines);
    const at = new Date(FIXED_NOW);
    const expected = [at.getHours(), at.getMinutes(), at.getSeconds()]
      .map((part) => String(part).padStart(2, '0'))
      .join(':');
    assert.ok(first.lines[0]?.startsWith(expected), first.lines[0]);
  });
});

describe('exit', () => {
  it('matches v1 and explains rather than pretending', async () => {
    const result = await compare('exit', [], cmdlet('exit', []));
    assert.deepEqual(result.lines, ['Close the tab to exit. Thanks for stopping by :)']);
    assert.equal(result.exitCode, 0);
  });

  it('says in its note why a tab cannot close itself', () => {
    const notes = command('exit').manifest.notes ?? '';
    assert.match(notes, /cannot close itself/u);
    assert.match(notes, /no session ends/u);
  });
});

// ---------------------------------------------------------------------------
// the network that is not there
// ---------------------------------------------------------------------------

describe('ping', () => {
  const RANDOMS = [0.1, 0.9, 0.35, 0.62];

  for (const args of [[], ['nycu.edu.tw'], ['-c', '2', 'example.com']]) {
    it(`matches v1 for '${args.join(' ')}' given the same draws`, async () => {
      await compare('ping', args, cmdlet('ping', args, { randoms: RANDOMS }), {
        randoms: RANDOMS,
      });
    });
  }

  it('draws exactly four values, as v1 does', async () => {
    // The environment throws on a fifth draw, so completing the run is the
    // assertion. A fifth reply would also be visible in the statistics line.
    const result = await compare('ping', [], cmdlet('ping', [], { randoms: RANDOMS }), {
      randoms: RANDOMS,
    });
    assert.equal(result.lines.filter((line) => line.includes('icmp_seq=')).length, 4);
  });

  it('computes the statistics from the unrounded values, as v1 does', async () => {
    // Not a restatement of v1's arithmetic: v1's own output is the expectation,
    // and this only names why the two agree. Rounding first would change mdev.
    const archive = cmdlet('ping', [], { randoms: RANDOMS });
    const result = await compare('ping', [], archive, { randoms: RANDOMS });
    const summary = result.lines.at(-1) ?? '';
    assert.match(summary, /^rtt min\/avg\/max\/mdev = /u);
    assert.ok(!summary.includes('NaN'), summary);
  });
});

describe('traceroute', () => {
  for (const args of [[], ['example.com'], ['-n', 'example.com']]) {
    it(`matches v1 for '${args.join(' ')}'`, async () => {
      await compare('traceroute', args, cmdlet('traceroute', args));
    });
  }

  it('is fixed, not sampled: the same four hops with the same nine times', async () => {
    const first = await run(command('traceroute'), {});
    const second = await run(command('traceroute'), { args: [] });
    assert.deepEqual(first.lines, second.lines);
  });
});

describe('Test-Connection', () => {
  const RANDOMS = [0.2, 0.44, 0.71, 0.08];
  /** v1's formula, restated once and then validated against v1's own output. */
  const LATENCIES = RANDOMS.map((value) => value * 8 + 3);

  it('carries exactly the replies v1 printed, as objects', async () => {
    const archive = cmdlet('test-connection', ['-TargetName', 'nycu.edu.tw'], {
      randoms: RANDOMS,
    });
    const archiveLines = v1Texts(archive);

    // The restatement above is only trustworthy if v1 agrees with it, so check
    // that first: every reply line v1 printed carries the value this test
    // derived from the same draws.
    LATENCIES.forEach((latency, index) => {
      assert.ok(
        archiveLines.some(
          (line) =>
            line.includes(`icmp_seq=${index + 1} `) &&
            line.includes(`time=${latency.toFixed(1)} ms`),
        ),
        `v1 did not print reply ${index + 1} with ${latency.toFixed(1)} ms`,
      );
    });

    const result = await run(
      command('test-connection', { randoms: RANDOMS }),
      { parameters: { TargetName: 'nycu.edu.tw' } },
    );

    assert.equal(result.values.length, 4, 'four replies, as v1 sent four');
    result.values.forEach((value, index) => {
      const fields = properties(value);
      assert.equal(fields['Ping'], index + 1);
      assert.equal(fields['Destination'], 'nycu.edu.tw');
      // v1's own address, taken from the line it printed rather than retyped.
      assert.ok(
        (archiveLines[0] ?? '').includes(`(${String(fields['DisplayAddress'])})`),
        'DisplayAddress is not the address v1 printed',
      );
      assert.equal(fields['Source'], V1_HOSTNAME);
      assert.equal(fields['Status'], 'Success');
      assert.equal(fields['BufferSize'], 32);
      // Int64 in pwsh 7.6.5, so the tenths v1 displayed have no home here.
      assert.equal(fields['Latency'], Math.round(LATENCIES[index] ?? 0));
    });
  });

  it('reports the type name pwsh reports, and omits the two host objects', async () => {
    const result = await run(command('test-connection', { randoms: [0.5, 0.5, 0.5, 0.5] }), {
      parameters: { TargetName: 'x' },
    });
    const first = result.values[0];
    assert.ok(isPSObject(first));
    assert.equal((first as PSObject).typeNames[0], PING_STATUS_TYPE);
    const names = Object.keys(properties(first as PSValue));
    // `Address` (System.Net.IPAddress) and `Reply` (PingReply) exist only
    // because a real echo came back. Nothing came back.
    assert.ok(!names.includes('Address'), 'Address must be omitted, not faked');
    assert.ok(!names.includes('Reply'), 'Reply must be omitted, not faked');
    assert.deepEqual(names, [
      'Ping',
      'Source',
      'Destination',
      'DisplayAddress',
      'Latency',
      'Status',
      'BufferSize',
    ]);
  });

  it('-Quiet collapses to a Boolean', async () => {
    const result = await run(command('test-connection', { randoms: [0.5, 0.5, 0.5, 0.5] }), {
      parameters: { TargetName: 'x', Quiet: true },
    });
    assert.deepEqual(result.values, [true]);
  });

  it('warns about the parameters that bind but cannot do anything', async () => {
    // Silently ignoring `-TimeoutSeconds 1` is indistinguishable from honouring
    // it, and a user would reasonably conclude the reply arrived inside a
    // second. The warning stream is where that belongs: the command still
    // works, and the output on stream 1 is unchanged.
    const quiet = await run(command('test-connection', { randoms: [0.5, 0.5, 0.5, 0.5] }), {
      parameters: { TargetName: 'x' },
    });
    assert.equal(quiet.values.length, 4);
    assert.deepEqual(quiet.warnings, [], 'nothing inert was passed, so nothing to warn about');

    const result = await run(command('test-connection', { randoms: [0.5, 0.5, 0.5, 0.5] }), {
      parameters: { TargetName: 'x', TimeoutSeconds: 1, DontFragment: true },
    });
    assert.equal(result.values.length, 4, 'the command still answers');
    assert.equal(result.errors.length, 0, 'an ignored parameter is not an error');
    assert.equal(result.warnings.length, 1);
    assert.match(result.warnings[0] ?? '', /DontFragment/u);
    assert.match(result.warnings[0] ?? '', /TimeoutSeconds/u);
    assert.match(result.warnings[0] ?? '', /accepted and ignored/u);
    // Stream 1 is untouched by the warning, so v1 parity is unaffected.
    assert.deepEqual(
      result.values.map((value) => properties(value)['Ping']),
      [1, 2, 3, 4],
    );
  });

  it('refuses the parameter sets it cannot answer instead of inventing a route', async () => {
    for (const parameter of ['Traceroute', 'MtuSize', 'TcpPort', 'Repeat']) {
      const result = await run(command('test-connection', { randoms: [] }), {
        parameters: { TargetName: 'x', [parameter]: true },
      });
      assert.equal(result.values.length, 0, `${parameter} must emit nothing`);
      assert.equal(result.errors.length, 1, `${parameter} must report the limit`);
      assert.match(result.errorMessages[0] ?? '', /not implemented by BrowserShell/u);
      assert.equal(result.exitCode, 1);
    }
  });
});

describe('ifconfig and the net-tools joke', () => {
  it('says the package is missing before sudo installs it', async () => {
    await compare('ifconfig', [], cmdlet('ifconfig', []));
  });

  it('fails vaguely once and then with the errno, as v1 does', async () => {
    const packages = freshPackageState();
    packages.netToolsInstalled = true;
    const ifconfig = moduleNamed(createSimulatedCommands(environment({ packages })), 'ifconfig');

    const first = await run(ifconfig);
    assertMatchesArchive(
      first,
      cmdlet('ifconfig', [], { netToolsInstalled: true, ifconfigFailures: 0 }),
      'ifconfig (first failure)',
      ['ifconfig: command failed'],
    );
    assert.equal(first.exitCode, 1);

    const second = await run(ifconfig);
    assertMatchesArchive(
      second,
      cmdlet('ifconfig', [], { netToolsInstalled: true, ifconfigFailures: 1 }),
      'ifconfig (second failure)',
      ['ifconfig: SIOCGIFCONF: Function not implemented'],
    );

    const third = await run(ifconfig);
    assertMatchesArchive(
      third,
      cmdlet('ifconfig', [], { netToolsInstalled: true, ifconfigFailures: 2 }),
      'ifconfig (third failure)',
      ['ifconfig: SIOCGIFCONF: Function not implemented'],
    );
  });

  it('is driven end to end by sudo, as the secret egg advertises', async () => {
    const packages = freshPackageState();
    const modules = createSimulatedCommands(environment({ packages }));
    const sudo = moduleNamed(modules, 'sudo');
    const ifconfig = moduleNamed(modules, 'ifconfig');

    await run(ifconfig);
    assert.equal(packages.netToolsInstalled, false);

    await run(sudo, { args: ['apt', 'install', 'net-tools'] });
    assert.equal(packages.netToolsInstalled, true, 'sudo must flip the package flag');

    const after = await run(ifconfig);
    assertMatchesArchive(
      after,
      cmdlet('ifconfig', [], { netToolsInstalled: true, ifconfigFailures: 0 }),
      'ifconfig after install',
      ['ifconfig: command failed'],
    );
  });
});

describe('ip', () => {
  for (const args of [[], ['addr'], ['a'], ['address'], ['route'], ['link']]) {
    it(`matches v1 for 'ip ${args.join(' ')}'`, async () => {
      await compare('ip', args, cmdlet('ip', args));
    });
  }
});

// ---------------------------------------------------------------------------
// processes that do not exist
// ---------------------------------------------------------------------------

describe('ps', () => {
  for (const args of [[], ['aux'], ['-ef'], ['-e'], ['--sort=-rss']]) {
    it(`matches v1 for 'ps ${args.join(' ')}'`, async () => {
      await compare('ps', args, cmdlet('ps', args));
    });
  }

  it('names the archive user rather than a real one', async () => {
    const result = await compare('ps', ['aux'], cmdlet('ps', ['aux']));
    assert.ok(result.lines[1]?.startsWith(V1_USER), result.lines[1]);
  });

  it('asks the broker for the process.read it declares', async () => {
    const result = await compare('ps', [], cmdlet('ps', []));
    assert.deepEqual(result.requested, ['process.read']);
  });
});

describe('Get-Process', () => {
  /** v1's table, unrendered: headers plus six rows of strings. */
  const archiveTable = (): { headers: readonly string[]; rows: readonly (readonly string[])[] } => {
    const table = cmdlet('get-process', []).tables[0];
    assert.ok(table !== undefined, 'v1 Get-Process no longer builds a table');
    return table;
  };

  it('carries exactly the four facts v1 tabulated, for the same six processes', async () => {
    const { headers, rows } = archiveTable();
    assert.deepEqual([...headers], ['Id', 'CPU(s)', 'RSS(M)', 'ProcessName']);

    const result = await run(command('get-process'));
    assert.equal(result.values.length, rows.length);

    result.values.forEach((value, index) => {
      const row = rows[index] ?? [];
      const fields = properties(value);
      assert.equal(fields['Id'], Number(row[0]), `row ${index} Id`);
      assert.equal(fields['CPU'], Number(row[1]), `row ${index} CPU`);
      assert.equal(fields['ProcessName'], row[3], `row ${index} ProcessName`);
      assert.equal(fields['Name'], row[3], `row ${index} Name`);
      // `WS` is v1's RSS(M) in bytes, and the conversion round-trips exactly —
      // which is the whole reason it is allowed to exist at all.
      assert.equal(fields['WS'], Number(row[2]) * MEBIBYTE, `row ${index} WS`);
      assert.equal(Number(fields['WS']) / MEBIBYTE, Number(row[2]), `row ${index} WS round trip`);
    });
  });

  it('omits every property v1 states nothing about', async () => {
    const result = await run(command('get-process'));
    const names = Object.keys(properties(result.values[0] as PSValue));
    assert.deepEqual(names, ['Id', 'Name', 'ProcessName', 'CPU', 'WS']);
    // The named ones are the plausible inventions this command must not make.
    for (const absent of [
      'NPM',
      'PM',
      'VM',
      'Handles',
      'SI',
      'Path',
      'CommandLine',
      'StartTime',
      'Threads',
      'WorkingSet64',
      'PagedMemorySize64',
    ]) {
      assert.ok(!names.includes(absent), `${absent} must be omitted, not invented`);
    }
  });

  it('reports the type chain pwsh reports', async () => {
    const result = await run(command('get-process'));
    const first = result.values[0];
    assert.ok(isPSObject(first));
    assert.deepEqual([...(first as PSObject).typeNames], [...PROCESS_TYPE_NAMES]);
  });

  it('filters by name and by id over the invented list', async () => {
    const byName = await run(command('get-process'), { parameters: { Name: 'pwsh' } });
    assert.equal(byName.values.length, 1);
    assert.equal(properties(byName.values[0] as PSValue)['Id'], 1006);

    const byWildcard = await run(command('get-process'), { parameters: { Name: 'c*' } });
    assert.deepEqual(
      byWildcard.values.map((value) => properties(value)['ProcessName']),
      ['code-server', 'chromium', 'containerd'],
    );

    const byId = await run(command('get-process'), { parameters: { Id: '4471' } });
    assert.equal(properties(byId.values[0] as PSValue)['ProcessName'], 'sshd');
  });

  it("uses pwsh's own message when nothing matches", async () => {
    const missing = await run(command('get-process'), { parameters: { Name: 'nosuch' } });
    assert.equal(missing.values.length, 0);
    assert.equal(
      missing.errorMessages[0],
      'Cannot find a process with the name "nosuch". Verify the process name and call the cmdlet again.',
    );
    assert.equal(missing.errors[0]?.category, 'ObjectNotFound');

    const missingId = await run(command('get-process'), { parameters: { Id: '999999' } });
    assert.equal(
      missingId.errorMessages[0],
      'Cannot find a process with the process identifier 999999.',
    );
  });

  it('refuses the parameters whose answers do not exist rather than inventing them', async () => {
    for (const parameter of ['Module', 'FileVersionInfo', 'IncludeUserName', 'InputObject']) {
      const result = await run(command('get-process'), { parameters: { [parameter]: true } });
      assert.equal(result.values.length, 0, parameter);
      assert.match(result.errorMessages[0] ?? '', /not implemented by BrowserShell/u);
    }
  });
});

// ---------------------------------------------------------------------------
// git
// ---------------------------------------------------------------------------

describe('git', () => {
  for (const args of [[], ['status'], ['remote'], ['nonsense']]) {
    it(`matches v1 for 'git ${args.join(' ')}'`, async () => {
      await compare('git', args, cmdlet('git', args));
    });
  }

  it('log renders the portfolio timeline as commits, and matches v1', async () => {
    const result = await compare('git', ['log'], cmdlet('git', ['log']));
    assert.equal(result.lines.length, 4);
    assert.ok(result.lines.every((line) => line.startsWith('* ')));
  });

  it('the extracted timeline still says what the archive said', () => {
    // `git log` reads src/data/projects.json; v1 held the array inline. If the
    // extractor ever drifts, this is where it shows up rather than in the page.
    assert.deepEqual(
      TIMELINE.map((entry) => [entry.year, entry.highlights]),
      v1Timeline().map((entry) => [entry[0], entry[1]]),
    );
  });

  it('asks for portfolio.read only where it reads the portfolio', async () => {
    const status = await run(command('git'), { args: ['status'] });
    assert.deepEqual(status.requested, [], 'git status reads nothing');
    const log = await run(command('git'), { args: ['log'] });
    assert.deepEqual(log.requested, ['portfolio.read']);
  });
});

// ---------------------------------------------------------------------------
// sudo
// ---------------------------------------------------------------------------

describe('sudo', () => {
  const egg = (args: readonly string[], options?: V1Options): V1Run =>
    v1Egg('sudo', ['sudo', ...args], options);

  it('reports command not found, exactly as v1 does', async () => {
    const result = await run(command('sudo'), { args: ['ls'] });
    assertMatchesArchive(result, egg(['ls']), 'sudo ls', ['sudo: command not found']);
    assert.equal(result.exitCode, 127);
  });

  it('answers rm -rf / with v1s joke and deletes nothing', async () => {
    for (const target of ['/', '/*']) {
      const result = await run(command('sudo'), { args: ['rm', '-rf', target] });
      assertMatchesArchive(result, egg(['rm', '-rf', target]), `sudo rm -rf ${target}`);
      assert.equal(result.exitCode, 0);
    }
  });

  it('installs the simulated package once, then says it is current', async () => {
    const packages = freshPackageState();
    const sudo = moduleNamed(createSimulatedCommands(environment({ packages })), 'sudo');

    const install = await run(sudo, { args: ['apt', 'install', 'net-tools'] });
    assertMatchesArchive(install, egg(['apt', 'install', 'net-tools']), 'sudo apt install');

    const again = await run(sudo, { args: ['apt', 'install', 'net-tools'] });
    assertMatchesArchive(
      again,
      egg(['apt', 'install', 'net-tools'], { netToolsInstalled: true }),
      'sudo apt install (again)',
    );
  });

  it('matches v1 whatever the spacing and case, as v1 normalises the line', async () => {
    const result = await run(command('sudo'), { args: ['RM', '-RF', '/'] });
    assertMatchesArchive(result, egg(['RM', '-RF', '/']), 'sudo RM -RF /');
  });
});

// ---------------------------------------------------------------------------
// through the real binder
// ---------------------------------------------------------------------------

/**
 * The two commands with captured parameters, bound from raw tokens.
 *
 * Everywhere else in this file the parameters are handed in already bound,
 * which is the right shape for testing a command body but leaves one thing
 * unproven: that the generated manifests and these bodies agree about what a
 * parameter is called and where it sits. `Get-Process pwsh` has to reach
 * `-Name` by position, and it does so through the same binder the kernel uses.
 *
 * The default parameter sets are read off `compat/upstream/v7.6.5/`, not
 * guessed: `CommandManifest` has no field for them, which `BindOptions` says in
 * so many words.
 */
describe('binding, from the tokens a user types', () => {
  const PROFILE: CompatibilityView = {
    displayVersion: '7.6.5',
    behavior: <T extends boolean | number | string>(_key: string, fallback: T): T => fallback,
  };

  const capture = JSON.parse(
    readFileSync(new URL('../../compat/upstream/v7.6.5/command-metadata.json', import.meta.url), 'utf8'),
  ) as { commands: Record<string, { defaultParameterSet?: string }> };

  const bindFor = (module: CommandModule, args: readonly string[]): RunOptions => {
    const declared = capture.commands[module.manifest.display]?.defaultParameterSet;
    const bound = bindParameters(
      args,
      module.manifest,
      PROFILE,
      declared === undefined ? {} : { defaultParameterSet: declared },
    );
    return { parameters: bound.parameters, parameterSet: bound.parameterSet, args: bound.remaining };
  };

  it('Get-Process pwsh binds -Name by position', async () => {
    const module = command('get-process');
    const result = await run(module, bindFor(module, ['pwsh']));
    assert.equal(result.values.length, 1);
    assert.equal(properties(result.values[0] as PSValue)['Id'], 1006);
  });

  /**
   * A BINDER DEFECT, recorded here because `Get-Process` is where it shows.
   *
   * pwsh 7.6.5 accepts `Get-Process -Id 4471` and resolves the `Id` set. This
   * engine's binder refuses it, because phase 4 asks only "is there exactly one
   * candidate set, or is the default among them?" — and `-Id` puts two sets in
   * play, `Id` and `IdWithUserName`, with the default (`Name`) in neither. The
   * rule it is missing is the one pwsh applies next: prefer the candidate whose
   * mandatory parameters are all satisfied. Read off the reference
   * implementation:
   *
   *   Id                {Id}                    <- satisfied by -Id alone
   *   IdWithUserName    {Id, IncludeUserName}   <- not satisfied
   *
   * `src/binding/` is not this change's to edit, so this asserts the CURRENT
   * behaviour and says plainly that it is wrong. When the binder learns the
   * rule, this test fails, and the fix is to turn it into the positive
   * assertion two lines below it.
   *
   * The command body is unaffected and is proven correct against `-Id`
   * elsewhere in this file, where the parameters are supplied already bound.
   */
  it('records that the binder cannot yet deliver Get-Process -Id, which pwsh accepts', () => {
    const module = command('get-process');
    const outcome = tryBindParameters(['-Id', '4471'], module.manifest, PROFILE, {
      defaultParameterSet: 'Name',
    });
    assert.equal(outcome.ok, false, 'the binder now resolves -Id: make this the positive test');
    // `-IncludeUserName` disambiguates, which is what shows the rule is the
    // thing missing rather than the parameter metadata.
    const disambiguated = tryBindParameters(
      ['-Id', '4471', '-IncludeUserName'],
      module.manifest,
      PROFILE,
      { defaultParameterSet: 'Name' },
    );
    assert.equal(disambiguated.ok, true);
  });

  it('Test-Connection nycu.edu.tw binds -TargetName by position', async () => {
    const module = command('test-connection', { randoms: [0.1, 0.2, 0.3, 0.4] });
    const result = await run(module, bindFor(module, ['nycu.edu.tw']));
    assert.equal(result.values.length, 4);
    assert.equal(properties(result.values[0] as PSValue)['Destination'], 'nycu.edu.tw');
  });

  it('Test-Connection -Count 2 is honoured, where v1 rejected the parameter', async () => {
    // v1 declared only -TargetName and refused everything else with "A
    // parameter cannot be found that matches parameter name 'Count'". The
    // generated manifest carries the real seventeen, so this now binds — an
    // addition rather than a change: the four-reply default is still v1's, and
    // it is the cmdlet's own default, read off the class in pwsh 7.6.5.
    const module = command('test-connection', { randoms: [0.1, 0.2] });
    const result = await run(module, bindFor(module, ['nycu.edu.tw', '-Count', '2']));
    assert.equal(result.values.length, 2);
  });

  it('a command with no declared parameters passes everything through', async () => {
    const module = command('uname');
    const bound = bindFor(module, ['-a']);
    assert.deepEqual(bound.parameters, {});
    assert.deepEqual(bound.args, ['-a']);
    const result = await run(module, bound);
    assertMatchesArchive(result, cmdlet('uname', ['-a']), 'uname -a (bound)');
  });
});

// ---------------------------------------------------------------------------
// the jokes
// ---------------------------------------------------------------------------

describe('the jokes', () => {
  for (const name of [
    'bash',
    'classic',
    'coffee',
    'fortune',
    'konami',
    'matrix',
    'rocket',
    'secret',
    'thc1006',
  ]) {
    it(`${name} matches v1`, async () => {
      const result = await run(command(name));
      assertMatchesArchive(result, v1Egg(name, [name]), name);
    });
  }

  it('bash and classic print the same line, as v1 aliases one to the other', async () => {
    const bash = await run(command('bash'));
    const classic = await run(command('classic'));
    assert.deepEqual(bash.lines, classic.lines);
    assert.match(bash.lines[0] ?? '', /classic\.html$/u);
  });

  it('matrix is computed, not baked, and the computation reproduces v1', async () => {
    const result = await run(command('matrix'));
    assertMatchesArchive(result, v1Egg('matrix', ['matrix']), 'matrix');
    // The alphabet contains `{`, `}`, `[` and `]`, which is why the archive
    // slicer has to understand string literals.
    assert.ok(MATRIX_ALPHABET.includes('{') && MATRIX_ALPHABET.includes('['));
  });

  it('sl prints the train for the bare word', async () => {
    const result = await run(command('sl'));
    assertMatchesArchive(result, v1Egg('sl', ['sl']), 'sl');
  });

  it('sl with an argument refuses instead of swallowing a Set-Location', async () => {
    // v1 routes `sl /tmp` to Set-Location and only the bare word to the joke.
    // This module implements the joke half; the dispatcher owns the other.
    const result = await run(command('sl'), { args: ['/tmp'] });
    assert.deepEqual(result.lines, []);
    assert.match(result.errorMessages[0] ?? '', /Set-Location/u);
    assert.equal(result.exitCode, 1);
  });
});
