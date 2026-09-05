/**
 * classification.data.mts — how real each command is.
 *
 * This is a judgement, so it is hand-authored and reviewable rather than
 * inferred. The generator refuses to emit a manifest for a command that is not
 * classified here, and refuses to accept a `simulated` entry with no note: an
 * undocumented fiction is the thing this whole taxonomy exists to prevent.
 *
 * The distinction that matters most is between `browser-backed` and
 * `simulated`. `Set-Content` really writes bytes that survive a reload, so it
 * is browser-backed. `ping` prints plausible round-trip times having sent
 * nothing, so it is simulated — and says so.
 */

import type { Capability, Fidelity, Risk, Runtime } from './manifest.ts';

export interface Classification {
  runtime: Runtime;
  fidelity: Fidelity;
  risk: Risk;
  capabilities: readonly Capability[];
  /** Required whenever fidelity is `simulated`. Says what it does NOT do. */
  notes?: string;
}

const fsRead = {
  runtime: 'browser',
  fidelity: 'browser-backed',
  risk: 'read',
  capabilities: ['filesystem.read'],
} as const satisfies Classification;

const fsWrite = {
  runtime: 'browser',
  fidelity: 'browser-backed',
  risk: 'write',
  capabilities: ['filesystem.read', 'filesystem.write'],
} as const satisfies Classification;

const fsDelete = {
  runtime: 'browser',
  fidelity: 'browser-backed',
  risk: 'destructive',
  capabilities: ['filesystem.read', 'filesystem.delete'],
} as const satisfies Classification;

const portfolio = {
  runtime: 'semantic',
  fidelity: 'native-semantic',
  risk: 'read',
  capabilities: ['portfolio.read'],
} as const satisfies Classification;

const pipeline = {
  runtime: 'semantic',
  fidelity: 'native-semantic',
  risk: 'read',
  capabilities: [],
} as const satisfies Classification;

/** A fabricated view of a machine that does not exist. */
const fiction = (notes: string): Classification => ({
  runtime: 'semantic',
  fidelity: 'simulated',
  risk: 'read',
  capabilities: [],
  notes,
});

export const CLASSIFICATION: Record<string, Classification> = {
  // ---------------------------------------------------------------- files
  // These really persist. A file written here survives a reload, so the claim
  // is browser-backed rather than simulated — the storage is a browser API even
  // while the directory tree above it is invented.
  'get-childitem': fsRead,
  'get-content': fsRead,
  'test-path': fsRead,
  'select-string': fsRead,
  ls: fsRead,
  cat: fsRead,
  tree: fsRead,
  grep: fsRead,
  which: fsRead,

  'set-content': fsWrite,
  'add-content': fsWrite,
  'new-item': fsWrite,
  'copy-item': fsWrite,
  'move-item': fsWrite,
  'rename-item': fsWrite,
  mkdir: fsWrite,
  cp: fsWrite,
  mv: fsWrite,
  touch: fsWrite,
  chmod: fsWrite,
  chown: fsWrite,

  'remove-item': fsDelete,
  rm: fsDelete,

  'get-location': {
    runtime: 'semantic',
    fidelity: 'native-semantic',
    risk: 'read',
    capabilities: [],
  },
  'set-location': {
    // Reads the virtual tree to validate the path, but changes only in-memory
    // state — nothing survives a reload, so it does not meet this file's own
    // definition of browser-backed.
    runtime: 'semantic',
    fidelity: 'native-semantic',
    risk: 'write',
    capabilities: ['filesystem.read'],
    notes: 'Changes the working directory for this session only; the location is not persisted.',
  },

  // Real editors over the real virtual filesystem: what they save is kept.
  vim: {
    runtime: 'browser',
    fidelity: 'browser-backed',
    risk: 'write',
    capabilities: ['filesystem.read', 'filesystem.write', 'ui.dialog'],
  },
  vi: {
    runtime: 'browser',
    fidelity: 'browser-backed',
    risk: 'write',
    capabilities: ['filesystem.read', 'filesystem.write', 'ui.dialog'],
  },
  nano: {
    runtime: 'browser',
    fidelity: 'browser-backed',
    risk: 'write',
    capabilities: ['filesystem.read', 'filesystem.write', 'ui.dialog'],
  },

  // ------------------------------------------------------------ portfolio
  // Invented commands with no upstream equivalent, over real data. They are
  // PowerShell-shaped by choice, so they are held to PowerShell semantics.
  'get-advisory': portfolio,
  'get-award': portfolio,
  'get-contribution': portfolio,
  'get-project': portfolio,
  'get-publication': portfolio,
  'get-source': portfolio,
  'get-timeline': portfolio,
  // Not the shared `portfolio` preset, because this one needs to say something
  // the others do not. The profile it prints is real data, so native-semantic
  // is right — but every sibling that answers a question about the machine
  // (hostname, uname, uptime, free, df, ps, lsb_release) is `simulated` and
  // says so, while this one would have been badged SEMANTIC with no note on
  // precisely the command whose Unix name promises to identify the person
  // running it. A browser has no effective user, and the badge should not be
  // the one place a visitor is left to assume otherwise.
  whoami: {
    ...portfolio,
    notes:
      'Prints the profile owner, not you. A page has no effective user, so unlike ' +
      'the Unix command this reports a fixed identity; the profile summary beside ' +
      'it is real data.',
  },

  // ------------------------------------------------------------- pipeline
  // The one command carrying `implementationStatus: 'partial'`, and therefore
  // the one that must say what is missing. Its status is not a gap in features
  // -- both limits produce WRONG ANSWERS, which is why it is held back rather
  // than shipped with a caveat.
  'where-object': {
    ...pipeline,
    notes:
      'Held back from the session registry: -Match uses JavaScript regular expressions where ' +
      'PowerShell uses .NET, and four measured patterns give the opposite answer while four more ' +
      'raise a SyntaxError, so a filter that looks like it worked can have matched nothing. ' +
      '-Is compares against a type model covering only a handful of types. Parameter-set binding ' +
      'now matches pwsh on every measured case; these two do not.',
  },
  'select-object': pipeline,
  'sort-object': pipeline,
  'measure-object': pipeline,
  'out-null': pipeline,

  // Added by the rewrite, not present in v1. They were implemented and tested
  // while being invisible to Get-Command, Get-Help and the fidelity badge,
  // because manifests.json was generated only from v1's inventory. See
  // rewrite-inventory.data.mts.
  'group-object': pipeline,
  'get-member': pipeline,
  'new-guid': pipeline,

  // Formatting is the LAST stage of the pipeline: it turns objects into text and
  // nothing downstream can put them back. native-semantic with no capabilities —
  // it reads no state and changes none, it only renders what it was handed.
  'format-table': pipeline,
  'format-list': pipeline,
  'format-wide': pipeline,
  'out-string': pipeline,
  'write-output': pipeline,
  'get-date': pipeline,
  'get-random': pipeline,

  // ----------------------------------------------------------------- meta
  'get-command': pipeline,
  'get-help': pipeline,
  help: pipeline,
  'get-history': pipeline,
  $psversiontable: {
    runtime: 'semantic',
    fidelity: 'native-semantic',
    risk: 'read',
    capabilities: [],
    notes:
      'PSVersion and GitCommitId report the compatibility profile the session is running, not a real engine build. OS and Platform describe the simulated Ubuntu machine — the same fiction uname and hostname report — and are not your computer.',
  },
  'clear-host': {
    runtime: 'semantic',
    fidelity: 'native-semantic',
    risk: 'read',
    capabilities: ['terminal.control'],
  },
  'set-theme': {
    runtime: 'browser',
    fidelity: 'browser-backed',
    risk: 'write',
    capabilities: ['preferences.write'],
  },
  'reset-filesystem': {
    runtime: 'browser',
    fidelity: 'browser-backed',
    risk: 'destructive',
    capabilities: ['filesystem.delete'],
  },
  exit: fiction(
    'A browser tab cannot close itself unless it opened itself. This prints a farewell and returns you to the prompt; no session ends.',
  ),

  // -------------------------------------------------------------- network
  // Nothing here opens a socket. ICMP is not reachable from a web page at all,
  // so any round-trip figure shown is invented and must be labelled.
  ping: fiction('No packet is sent. ICMP is not reachable from a browser; the timings are illustrative.'),
  traceroute: fiction('No packet is sent. The hops are a fixed, plausible route, not a measurement.'),
  'test-connection': fiction('No packet is sent. Mirrors the shape of the real cmdlet output only.'),
  ifconfig: fiction('Not present until the simulated net-tools package is installed, after which it reports that the call is not implemented. The browser cannot enumerate real network interfaces at all.'),
  ip: fiction('Reports an invented interface. The browser cannot enumerate real network interfaces.'),

  // --------------------------------------------------------- machine info
  uname: fiction('Describes the simulated Ubuntu environment, not the machine you are using.'),
  lsb_release: fiction('Describes the simulated Ubuntu environment, not the machine you are using.'),
  hostname: fiction('The hostname of the simulated machine.'),
  df: fiction('Invented disk figures. Real browser storage usage is reported by Get-StorageStatus instead.'),
  free: fiction('Invented memory figures. The browser does not expose host memory.'),
  uptime: fiction('Uptime of the simulated machine, not of your computer or this tab.'),
  ps: {
    runtime: 'semantic',
    fidelity: 'simulated',
    risk: 'read',
    capabilities: ['process.read'],
    notes:
      'Lists invented Unix processes. It does not show this page workers or browser tasks — that is what the kernel process table will report once it exists.',
  },
  'get-process': {
    runtime: 'semantic',
    fidelity: 'simulated',
    risk: 'read',
    capabilities: ['process.read'],
    notes: 'Lists invented processes. No host or browser process is enumerated.',
  },
  git: {
    runtime: 'semantic',
    fidelity: 'simulated',
    risk: 'read',
    // `git log` renders the real portfolio timeline, so it does read portfolio
    // data even though no repository is involved.
    capabilities: ['portfolio.read'],
    notes:
      'No repository is read and no git runs. status and remote are fixed text; log renders the portfolio timeline formatted as commits.',
  },

  // ---------------------------------------------------------- easter eggs
  sudo: {
    runtime: 'semantic',
    fidelity: 'simulated',
    risk: 'privileged-simulation',
    capabilities: ['virtual.policy.elevate'],
    notes:
      'Grants nothing in the browser, the origin, or your computer, and never can. In the v1 terminal it does not even elevate anything virtual — it reports command not found, and the only state it touches is whether the simulated net-tools package has been installed. The capability is declared so the broker has something to refuse once a policy engine exists.',
  },
  bash: fiction('Acknowledges the request and stays in PowerShell. No second shell exists.'),
  classic: fiction('Links to the archived v1 terminal.'),
  sl: fiction('A joke response to a common typo for ls.'),
  coffee: fiction('A joke.'),
  rocket: fiction('A joke.'),
  matrix: fiction('A joke.'),
  fortune: fiction('A joke.'),
  thc1006: fiction('A joke.'),
  konami: fiction('A joke.'),
  secret: fiction('A joke.'),
};
