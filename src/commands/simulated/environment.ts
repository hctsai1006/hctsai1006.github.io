/**
 * environment.ts — the machine that does not exist, and the two sources of
 * variation that would otherwise make it untestable.
 *
 * Every command in this directory is `simulated`: its output is invented or
 * fixed, and nothing outside the page is read or changed. Three of them would
 * still vary between runs, from the two ambient globals v1 reached for
 * directly:
 *
 *   uptime                  `new Date()`      the clock
 *   ping, Test-Connection   `Math.random()`   round-trips never measured
 *
 * A terminal that prints a different fake latency every second is no more
 * honest than one that prints the same fake latency every time; it is only
 * harder to test. So both are injected. The default environment keeps v1's
 * behaviour exactly — the real clock, the real `Math.random` — and a test hands
 * in a fixed clock and a seeded generator and gets byte-identical output.
 *
 * THE FICTION HAS ONE SOURCE
 *
 * `MACHINE` below is it. In v1 the hostname was a `const` but the kernel
 * string, the distro version and the eth0 address were typed out separately
 * inside `uname`, `lsb_release` and `ip`, so `uname -a` and `hostname` agreed
 * only because someone kept them agreeing by hand. They are one record here.
 * The values are v1's, unchanged: a visitor who used the old page must not see
 * the machine's story change under them.
 *
 * WHAT `PackageState` IS, AND WHY IT IS THE ONLY MUTABLE THING HERE
 *
 * v1 has one piece of cross-command state in this whole family: two module
 * variables recording whether the joke `apt install net-tools` has run and how
 * many times `ifconfig` has failed since. `sudo` writes them and `ifconfig`
 * reads them. It is session-scoped, never persisted, and reaches nothing — it
 * is a counter in a closure. It lives here so that the pair is visible as a
 * pair, and so a test can construct a session at any point in the chain instead
 * of having to replay it.
 */

// ---------------------------------------------------------------------------
// the invented machine
// ---------------------------------------------------------------------------

/**
 * The Ubuntu box the Linux-facade commands describe.
 *
 * Not your computer, not the browser, and not a machine that exists. Every
 * value is transcribed from `legacy/terminal-v1.html`; the tests re-extract
 * them from that archive at runtime rather than trusting this comment.
 */
export const MACHINE = {
  hostname: 'thc1006-dev',
  user: 'thc1006',
  kernelRelease: '6.8.0-51-generic',
  kernelBuild: '#52-Ubuntu SMP PREEMPT_DYNAMIC',
  machineHardware: 'x86_64',
  operatingSystem: 'Linux',
  distributorId: 'Ubuntu',
  distributorDescription: 'Ubuntu 24.04.4 LTS',
  distributorRelease: '24.04',
  distributorCodename: 'noble',
  /** eth0, as `ip addr` reports it — and the address `ping` claims to reach. */
  address: '10.6.10.6',
} as const;

// ---------------------------------------------------------------------------
// package state
// ---------------------------------------------------------------------------

/**
 * The one thing a command in this directory may change: whether the simulated
 * `net-tools` package has been "installed", and how many times `ifconfig` has
 * been run since.
 *
 * Mutable by design and by nothing else. It is not persisted, not shared
 * between tabs, and not readable from outside the session — reloading the page
 * puts it back to `false`, exactly as v1's module variables did.
 */
export interface PackageState {
  /** Set by `sudo apt install net-tools`. Read by `ifconfig`. */
  netToolsInstalled: boolean;
  /**
   * How many times `ifconfig` has been run since the package was installed.
   * v1 escalates its excuse on the second failure, and reproducing that needs
   * the count rather than a boolean.
   */
  ifconfigFailures: number;
}

export function freshPackageState(): PackageState {
  return { netToolsInstalled: false, ifconfigFailures: 0 };
}

// ---------------------------------------------------------------------------
// determinism
// ---------------------------------------------------------------------------

/**
 * A seeded generator, so a fake latency is reproducible.
 *
 * mulberry32: 32 bits of state, one multiply-xor round. Chosen because it is
 * short enough to read in full and has no dependencies — NOT because it is a
 * good generator. It seeds a joke. Nothing here is, or may become, a source of
 * randomness for anything that matters; `Get-Random` is a separate command with
 * its own semantics, and a cryptographic need must reach for `crypto`.
 */
export function seededRandom(seed: number): () => number {
  let state = seed >>> 0;
  return (): number => {
    state = (state + 0x6d2b79f5) >>> 0;
    let t = state;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/**
 * Everything in this directory that is not a constant.
 *
 * Deliberately three fields. A command that needs a fourth is a command that
 * has grown a dependency on something ambient, and that is the moment to say so
 * out loud rather than to reach for a global.
 */
export interface SimulatedEnvironment {
  /** Epoch milliseconds. `uptime` is the only reader. */
  readonly now: () => number;
  /** `[0, 1)`. `ping` and `Test-Connection` are the only readers. */
  readonly random: () => number;
  readonly packages: PackageState;
}

/**
 * The environment the page runs with: the real clock and `Math.random`, which
 * is what v1 used. Nothing here is deterministic, and that is correct for the
 * page — the determinism exists so a test can ask for it, not so the terminal
 * prints the same fiction forever.
 */
export function defaultEnvironment(): SimulatedEnvironment {
  return {
    now: () => Date.now(),
    random: () => Math.random(),
    packages: freshPackageState(),
  };
}

/** A fully pinned environment. What every test in this family constructs. */
export function fixedEnvironment(options: {
  readonly now?: number;
  readonly seed?: number;
  readonly packages?: PackageState;
}): SimulatedEnvironment {
  const at = options.now ?? Date.parse('2026-09-05T09:12:00Z');
  const random = seededRandom(options.seed ?? 1006);
  return {
    now: () => at,
    random,
    packages: options.packages ?? freshPackageState(),
  };
}
