/**
 * network.ts — five commands that look like they touched the network.
 *
 *   ping  traceroute  Test-Connection  ifconfig  ip
 *
 * NOT ONE OF THEM SENDS ANYTHING. There is no `fetch`, no `XMLHttpRequest`, no
 * `WebSocket`, no `navigator.sendBeacon` and no image-tag trick anywhere in
 * this file, and a test in `tests/unit/simulated-effects.test.mts` fails if any
 * of them is called during any command in this directory.
 *
 * That is not a design preference, it is the shape of the platform. ICMP is not
 * reachable from a web page at all: there is no browser API that emits an echo
 * request, and there never has been. Neither is a raw socket, which is what
 * traceroute needs to set a TTL and read the ICMP time-exceeded back. The
 * closest a page can get is timing an HTTP request to a URL that happens to be
 * on the same host, which measures TLS setup, DNS, HTTP and the server's
 * disposition — a different quantity about a different layer, arriving with a
 * cross-origin request nobody asked for.
 *
 * So the round-trip times are invented, and the honest thing is to say so in
 * the manifest note (which `Get-Help` prints) rather than to make the number
 * slightly more real. What this file adds to v1 is that the invented numbers
 * are now REPRODUCIBLE: the generator is injected, so the same seed prints the
 * same latencies, and a test can assert on them instead of on a regex.
 *
 * `ifconfig` and `ip` describe an interface that does not exist. A page cannot
 * enumerate network interfaces; the nearest real API, `RTCPeerConnection`'s ICE
 * candidates, leaks local addresses as a side effect of WebRTC and browsers
 * have spent years narrowing exactly that. Reaching for it to make `ip addr`
 * "more real" would turn a joke into a fingerprinting vector.
 */

import { psObject } from '../../pipeline/psobject.ts';
import type { PSValue } from '../../pipeline/psobject.ts';
import type { CommandModule } from '../invocation.ts';
import { isBound, numberValue, stringValue, switchValue } from '../powershell/support.ts';
import type { SimulatedEnvironment } from './environment.ts';
import { MACHINE } from './environment.ts';
import {
  EXIT_FAILURE,
  EXIT_SUCCESS,
  argumentsOf,
  firstArgument,
  fixedTextCommand,
  simulatedCommand,
  simulatedManifest,
  subcommandOf,
  writeError,
  writeLines,
  writeValues,
} from './support.ts';

// ---------------------------------------------------------------------------
// the shared fiction
// ---------------------------------------------------------------------------

/**
 * v1's `pingRun`: four replies, `Math.random() * 8 + 3` milliseconds each, from
 * the eth0 address `ip addr` invents — whatever host you asked for.
 *
 * That last part is v1's, and it is worth naming rather than smoothing over:
 * `ping example.com` reports replies from 10.6.10.6, the simulated machine's
 * OWN address, because no name was resolved and none could be. It is internally
 * consistent with `ip addr` and it is visibly not a measurement, which is
 * better than a plausible-looking address that would invite belief.
 *
 * Returned as numbers rather than formatted strings: `ping` rounds to one
 * decimal for display while the statistics line is computed from the full
 * values, and rounding first would give a different mdev.
 */
function pingLatencies(environment: SimulatedEnvironment, count: number): readonly number[] {
  const values: number[] = [];
  for (let index = 0; index < count; index += 1) {
    values.push(environment.random() * 8 + 3);
  }
  return values;
}

/**
 * `Test-Connection`'s `-Count` default in pwsh 7.6.5, read off the cmdlet class
 * rather than the documentation. v1's `ping` sends four replies because it was
 * written against the same number; one constant, so the two cannot drift.
 */
const PING_COUNT = 4;

// ---------------------------------------------------------------------------
// ping
// ---------------------------------------------------------------------------

/**
 * `ping`, as the native binary v1 declared it to be: text on stream 1.
 *
 * The statistics use the unrounded latencies, as v1 does, so `mdev` is the
 * standard deviation of the real (invented) values rather than of the displayed
 * ones. `time 3005ms` is fixed and does not follow from `count` — v1's number,
 * kept.
 *
 * One v1 quirk is deliberately not reproduced. `pingRun` was shared with
 * `Test-Connection` and read `-TargetName` out of the parsed arguments, so
 * `ping -TargetName` with no value pinged a host called "true". Here the target
 * is v1's `firstArg` alone, which agrees with v1 on every input where v1's own
 * answer was sane.
 */
function ping(environment: SimulatedEnvironment): CommandModule {
  return fixedTextCommand('ping', (_context, bound) => {
    const target = firstArgument(argumentsOf(bound)) || 'localhost';
    return pingText(target, pingLatencies(environment, PING_COUNT));
  });
}

function pingText(target: string, latencies: readonly number[]): readonly string[] {
  const lines: string[] = [`PING ${target} (${MACHINE.address}) 56(84) bytes of data.`];
  latencies.forEach((value, index) => {
    lines.push(
      `64 bytes from ${MACHINE.address}: icmp_seq=${index + 1} ttl=64 ` +
        `time=${value.toFixed(1)} ms`,
    );
  });

  const minimum = Math.min(...latencies);
  const maximum = Math.max(...latencies);
  const average = latencies.reduce((sum, value) => sum + value, 0) / latencies.length;
  const deviation = Math.sqrt(
    latencies.reduce((sum, value) => sum + (value - average) ** 2, 0) / latencies.length,
  );

  lines.push(
    '',
    `--- ${target} ping statistics ---`,
    `${latencies.length} packets transmitted, ${latencies.length} received, ` +
      '0% packet loss, time 3005ms',
    `rtt min/avg/max/mdev = ${minimum.toFixed(3)}/${average.toFixed(3)}/` +
      `${maximum.toFixed(3)}/${deviation.toFixed(3)} ms`,
  );
  return lines;
}

// ---------------------------------------------------------------------------
// traceroute
// ---------------------------------------------------------------------------

/**
 * A fixed four-hop route through TWAREN. Not a measurement, and not even a
 * random one: the same four hops with the same nine times every run, whatever
 * host you name. The final hop takes the name you typed and pairs it with a
 * fixed address, which is the one place a reader might mistake it for a lookup.
 */
const TRACEROUTE_HOPS: readonly (readonly [string, string, string, string])[] = [
  ['_gateway (10.6.1.1)', '1.204', '1.118', '1.083'],
  ['140.113.1.254', '3.912', '3.845', '4.201'],
  ['tpe-core.twaren.net (211.79.48.1)', '8.774', '9.012', '8.660'],
  ['', '12.331', '11.907', '12.114'],
];

const TRACEROUTE_FINAL_ADDRESS = '140.113.207.85';

function traceroute(): CommandModule {
  return fixedTextCommand('traceroute', (_context, bound) => {
    const target = firstArgument(argumentsOf(bound)) || 'nycu.edu.tw';
    const lines = [
      `traceroute to ${target} (${TRACEROUTE_FINAL_ADDRESS}), 30 hops max, 60 byte packets`,
    ];
    TRACEROUTE_HOPS.forEach(([label, first, second, third], index) => {
      const host = label === '' ? `${target} (${TRACEROUTE_FINAL_ADDRESS})` : label;
      const number = String(index + 1).padStart(2, ' ');
      lines.push(`${number}  ${host}  ${first} ms  ${second} ms  ${third} ms`);
    });
    return lines;
  });
}

// ---------------------------------------------------------------------------
// Test-Connection
// ---------------------------------------------------------------------------

/**
 * The .NET type name real `Test-Connection` reports, read off pwsh 7.6.5:
 * `[Microsoft.PowerShell.Commands.TestConnectionCommand+PingStatus]`. The `+`
 * is the CLR's nested-type separator and is part of the name.
 */
const PING_STATUS_TYPE = 'Microsoft.PowerShell.Commands.TestConnectionCommand+PingStatus';

/**
 * The properties that type really carries, probed rather than remembered:
 *
 *   Ping            System.UInt32
 *   Source          System.String
 *   Destination     System.String
 *   Address         System.Net.IPAddress
 *   DisplayAddress  System.String
 *   Latency         System.Int64
 *   Status          System.Net.NetworkInformation.IPStatus
 *   BufferSize      System.Int32
 *   Reply           System.Net.NetworkInformation.PingReply
 *
 * WHICH ARE FILLED, AND WHICH ARE OMITTED ON PURPOSE
 *
 * Filled: `Ping` (the sequence, 1-based), `Destination` (what you typed),
 * `DisplayAddress` and `Source` (v1's own invented address and hostname),
 * `Latency`, `Status`, `BufferSize`.
 *
 * OMITTED: `Address` and `Reply`. Both are host objects that exist only because
 * a real ICMP echo came back — an `IPAddress` parsed from the reply, and a
 * `PingReply` holding the buffer, the options and the round-trip. There was no
 * reply. A string stuffed into `Address` would report `System.String` from
 * `Get-Member` where pwsh reports `System.Net.IPAddress`, and a fabricated
 * `Reply` would be a fake object describing a packet that was never sent. The
 * same address is available as `DisplayAddress`, which really is a String.
 *
 * `Latency` is `System.Int64` in pwsh, because it comes from
 * `PingReply.RoundtripTime`, which is already whole milliseconds. The invented
 * latency is fractional, so it is rounded — the tenths `ping` displays have no
 * counterpart in the real type, and widening the property to a Double to keep
 * them would be inventing a shape the reference implementation does not have.
 *
 * BufferSize defaults to 32 and Count to 4 — both read off the cmdlet's own
 * property defaults in pwsh 7.6.5, not from documentation. v1 sending exactly
 * four pings is that default showing through.
 */
function pingStatus(options: {
  readonly sequence: number;
  readonly destination: string;
  readonly latency: number;
  readonly bufferSize: number;
}): PSValue {
  return psObject(
    {
      Ping: options.sequence,
      Source: MACHINE.hostname,
      Destination: options.destination,
      DisplayAddress: MACHINE.address,
      Latency: Math.round(options.latency),
      Status: 'Success',
      BufferSize: options.bufferSize,
    },
    [PING_STATUS_TYPE, 'System.Object'],
  );
}

/**
 * The two manifests this file names in ErrorRecords, read once at module load.
 * `errorRecord` composes `FullyQualifiedErrorId` as `<ErrorId>,<CommandName>`,
 * so the display name has to come from the generated manifest rather than from
 * a literal that a rename would leave stale.
 */
const TEST_CONNECTION_MANIFEST = simulatedManifest('test-connection');
const IFCONFIG_MANIFEST = simulatedManifest('ifconfig');

/**
 * Parameters that bind correctly and then have nothing to act on.
 *
 * Not an oversight list — every one of them describes a packet, a wait or a
 * lookup, and there is no packet, no wait and no lookup. They are accepted
 * because the captured metadata says they are real parameters of this cmdlet,
 * and a warning is written naming them, because silently ignoring `-DontFragment`
 * is indistinguishable from honouring it.
 *
 * `BufferSize` is NOT here: it is reported back on every PingStatus, which is
 * the only thing the real cmdlet does with it that is observable in the output.
 *
 * `-Source` IS here, and is not the same thing as the `Source` property on the
 * reply. The parameter names the machine to ping FROM, which needs a second
 * machine and a remoting session; the property names the machine that answered,
 * which here is the simulated one. Passing the parameter warns and changes
 * nothing, and the property keeps saying what it always said.
 */
const INERT_PARAMETERS: readonly string[] = [
  'Delay',
  'DontFragment',
  'IPv4',
  'IPv6',
  'MaxHops',
  'ResolveDestination',
  'Source',
  'TimeoutSeconds',
];

/** Parameter sets this command does not implement, and the set each belongs to. */
const UNIMPLEMENTED_SETS: readonly (readonly [string, string])[] = [
  ['Traceroute', 'TraceRoute'],
  ['MtuSize', 'MtuSizeDetect'],
  ['TcpPort', 'TcpPort'],
  ['Repeat', 'RepeatPing'],
];

/**
 * `Test-Connection` is a cmdlet, so it emits OBJECTS.
 *
 * This is the one place where v1's output shape is not reproduced, and the
 * reason is that v1's was wrong in the specific way this rewrite exists to fix.
 * v1 aliased `Test-Connection` to its `ping` implementation and printed
 * ping(8)'s text, so the manifest's `outputTypeNames` — captured from real
 * pwsh, which reports `PingStatus` — described something the command never
 * produced, and `Test-Connection host | Where-Object Latency -lt 5` could not
 * work because there was no `Latency`, only a line of text. v1 knew: its
 * dispatcher refuses to put ping or traceroute in a pipeline at all rather than
 * pretend to support it.
 *
 * The invented numbers are unchanged — same four replies, same address, same
 * distribution — so nothing a visitor was told becomes a different fiction. The
 * test asserts exactly that: the objects carry the values v1's text encoded.
 */
function testConnection(environment: SimulatedEnvironment): CommandModule {
  return simulatedCommand('test-connection', async (context, bound) => {
    const parameters = bound.parameters;

    for (const [parameter, setName] of UNIMPLEMENTED_SETS) {
      if (!isBound(parameters, parameter)) continue;
      await writeError(
        context,
        TEST_CONNECTION_MANIFEST,
        `The ${setName} parameter set is recognised but not implemented by BrowserShell. ` +
          'Nothing here sends a packet, so there is no route, no MTU and no TCP connection ' +
          'to report; a fabricated one would be indistinguishable from a measurement.',
        'NotImplemented',
        'NotImplemented',
      );
      return EXIT_FAILURE;
    }

    // Parameters that bind, are correct PowerShell, and cannot do anything
    // here. Saying so on stream 3 is the difference between a limit and a
    // silent lie: `-TimeoutSeconds 1` looks like it was honoured otherwise, and
    // a user could reasonably conclude the reply arrived inside a second.
    const inert = INERT_PARAMETERS.filter((name) => isBound(parameters, name));
    if (inert.length > 0) {
      await context.streams.warning.write(
        `Test-Connection: ${inert.join(', ')} ${inert.length === 1 ? 'was' : 'were'} accepted ` +
          'and ignored. Nothing is sent, so there is no packet to size, delay, time out or ' +
          'route, and no name to resolve.',
      );
    }

    const destination = stringValue(parameters, 'TargetName') ?? 'localhost';
    // The cmdlet's own default, and the reason v1 printed exactly four replies.
    const count = numberValue(parameters, 'Count') ?? PING_COUNT;
    const bufferSize = numberValue(parameters, 'BufferSize') ?? 32;
    const latencies = pingLatencies(environment, Math.max(0, count));

    // `-Quiet` collapses the whole run to a Boolean. Every simulated reply
    // succeeds — there is no failure to model when nothing was sent — so this
    // is always $true, which the note's "mirrors the shape only" covers.
    if (switchValue(parameters, 'Quiet')) {
      await writeValues(context, [latencies.length > 0]);
      return EXIT_SUCCESS;
    }

    await writeValues(
      context,
      latencies.map((latency, index) =>
        pingStatus({ sequence: index + 1, destination, latency, bufferSize }),
      ),
    );
    return EXIT_SUCCESS;
  });
}

// ---------------------------------------------------------------------------
// ifconfig
// ---------------------------------------------------------------------------

/**
 * The one command here with state, and the punchline of a three-step joke:
 * `ifconfig` says the package is missing, `sudo apt install net-tools` pretends
 * to install it, and `ifconfig` then fails anyway — vaguely the first time,
 * with a real errno message the second.
 *
 * The failures are real ErrorRecords on stream 2, because that is what v1's
 * `err` class meant and v1 had nowhere to put it. The not-installed case is NOT
 * an error in v1 — it is the plain "can be installed with" text Ubuntu's
 * command-not-found handler prints — so it stays on stream 1 and exits 0. That
 * differs from real Ubuntu, which sends that text to stderr and exits 127; v1's
 * classification is kept because these commands are measured against v1.
 */
function ifconfig(environment: SimulatedEnvironment): CommandModule {
  return simulatedCommand('ifconfig', async (context) => {
    const state = environment.packages;
    if (!state.netToolsInstalled) {
      await writeLines(context, [
        "Command 'ifconfig' not found, but can be installed with:",
        '  sudo apt install net-tools',
      ]);
      return EXIT_SUCCESS;
    }

    state.ifconfigFailures += 1;
    const message =
      state.ifconfigFailures >= 2
        ? 'ifconfig: SIOCGIFCONF: Function not implemented'
        : 'ifconfig: command failed';
    await writeError(context, IFCONFIG_MANIFEST, message, 'NotImplemented', 'NotImplemented');
    return EXIT_FAILURE;
  });
}

// ---------------------------------------------------------------------------
// ip
// ---------------------------------------------------------------------------

/**
 * `ip addr` over an interface that does not exist. Any other subcommand says so
 * rather than inventing a routing table — v1's own restraint, kept.
 */
function ip(): CommandModule {
  return fixedTextCommand('ip', (_context, bound) => {
    const sub = subcommandOf(argumentsOf(bound));
    if (sub !== '' && sub !== 'a' && sub !== 'addr' && sub !== 'address') {
      return ['Usage: ip addr   (only addr is implemented in this sandbox)'];
    }
    return [
      '1: lo: <LOOPBACK,UP,LOWER_UP> mtu 65536 qdisc noqueue state UNKNOWN',
      '    inet 127.0.0.1/8 scope host lo',
      '2: eth0: <BROADCAST,MULTICAST,UP,LOWER_UP> mtu 1500 qdisc fq_codel state UP',
      `    inet ${MACHINE.address}/24 brd 10.6.10.255 scope global eth0`,
      '    inet6 fe80::216:3eff:fe74:1006/64 scope link',
    ];
  });
}

// ---------------------------------------------------------------------------

export function networkCommands(environment: SimulatedEnvironment): readonly CommandModule[] {
  return [
    ping(environment),
    traceroute(),
    testConnection(environment),
    ifconfig(environment),
    ip(),
  ];
}

/** Exported for the parity test, which checks it against pwsh's own type name. */
export { PING_STATUS_TYPE };
