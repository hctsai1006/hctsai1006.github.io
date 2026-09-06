/**
 * roadmap.data.mts — the single source of truth for what this project is doing
 * and in what order.
 *
 * This file is DATA, not prose. ROADMAP.md and roadmap/pr/*.md are generated
 * from it by tools/generate-roadmap.mts and must never be hand-edited: the same
 * discipline this repo already applies to contribution counts via
 * tools/check-numbers.js, applied to the plan itself. `npm run roadmap -- --check`
 * fails if the generated files drift from this file.
 *
 * Every claim about upstream in here was verified against a primary source on
 * 2026-09-04. Where the original design document was wrong, the correction is
 * recorded inline rather than quietly fixed — the reasoning is the valuable part.
 */

export type Status = 'done' | 'in-progress' | 'partial' | 'todo' | 'blocked' | 'deferred';

/**
 * A citation that something else can resolve.
 *
 * Statuses in this file were once opinions. On 2026-09-06 the file was consulted
 * to answer "is everything built?", answered "34 of 104", and was wrong in the
 * pessimistic direction — a dozen tasks marked `todo` had shipped months
 * earlier, including TerminalMetrics, the kernel protocol, the Format-*
 * directives and the Result-based storage API. Nothing was checking, because
 * every check the roadmap had was about its own internal coherence.
 *
 * So a status now costs a citation, and `tools/check-roadmap-evidence.mts`
 * re-derives every one of them from the tree. See that file for what each kind
 * proves and, more importantly, for what none of them can.
 */
export type Evidence =
  /** `file` exports `symbol`. Read off the TypeScript AST, not grepped. */
  | { kind: 'export'; file: string; symbol: string }
  /** A test with this exact name exists, is not skipped, asserts, and passes. */
  | { kind: 'test'; file: string; name: string }
  /** A dotted path into a JSON file resolves to a non-empty value. */
  | { kind: 'json'; file: string; path: string }
  /**
   * `pattern` occurs in `file`, with comments blanked first. Supporting
   * evidence only: it cannot carry a `done` on its own.
   */
  | { kind: 'code'; file: string; pattern: string }
  /** package.json declares this script. Supporting evidence only. */
  | { kind: 'script'; name: string }
  /**
   * `pattern` matches NOTHING under `glob`. This is how a `todo` states its
   * claim, and it is one of the two evidence shapes that fail in the direction
   * this file actually failed: the day the work lands, the search finds
   * something and the gate goes red until the status is corrected.
   */
  | { kind: 'absent'; glob: string; pattern: string }
  /**
   * `glob` matches no files, and `within` — the area it is searched in — does.
   * The second half is not ceremony: a glob that matches nothing because the
   * directory above it was renamed proves nothing at all, and would be the
   * check-that-never-ran wearing an evidence badge.
   */
  | { kind: 'no-files'; glob: string; within: string };

export interface Task {
  id: string;
  title: string;
  /** Why this task exists, when that is not obvious from the title. */
  detail?: string;
  status: Status;
  /**
   * Required for `done` (at least one of export/test/json/absent) and for
   * `partial`. Optional elsewhere, but always verified when present, so a
   * citation left behind on a task that regressed is caught too.
   */
  evidence?: readonly Evidence[];
}

export interface WorkItem {
  n: number;
  phase: PhaseName;
  slug: string;
  title: string;
  /** The problem this solves. If this cannot be stated, the item is not ready. */
  why: string;
  status: Status;
  dependsOn: number[];
  tasks: Task[];
  /** Observable conditions that make this item done. Not opinions. */
  acceptance: string[];
  risks?: string[];
}

export interface Phase {
  name: string;
  goal: string;
}

export const PHASES = [
  {
    name: 'Ground truth',
    goal:
      'Make it impossible to be wrong about upstream by accident. Nothing downstream is trustworthy until version truth is mechanised.',
  },
  {
    name: 'Core',
    goal:
      'A real execution engine: one lexer, one AST, a version-aware binder, and a typed object pipeline. This is where the current site is weakest.',
  },
  {
    name: 'State',
    goal:
      'Durable, inspectable, recoverable virtual machine state — filesystem, providers, transactions, migrations.',
  },
  {
    name: 'Compatibility',
    goal:
      'Prove the emulation is faithful by differential-testing against real pwsh, and express version differences as data.',
  },
  {
    name: 'Declarative',
    goal: 'The workstation as a configuration that can be exported, diffed, tested and restored.',
  },
  {
    name: 'Supply chain',
    goal: 'Packages with identity, integrity, capabilities and trust — from the first line, not retrofitted.',
  },
  {
    name: 'AI',
    goal: 'One command metadata source feeding help, completion, MCP tools and the AI planner, behind an approval gate.',
  },
  {
    name: 'Rendering',
    goal: 'Optional ANSI/TUI rendering path alongside the semantic DOM terminal.',
  },
  {
    name: 'Future runtime',
    goal: 'Keep the door open to a real .NET/WASM PowerShell without betting the architecture on it.',
  },
  {
    name: 'Desktop',
    goal: 'The apps that make it feel like a machine rather than a prompt.',
  },
] as const satisfies readonly Phase[];

/**
 * The declared phase names, derived from PHASES rather than restated. Typing
 * WorkItem.phase as this makes a mistyped phase a compile error instead of
 * something only the plan validator would catch.
 */
export type PhaseName = (typeof PHASES)[number]['name'];

/**
 * Corrections to the originating design document, each verified against a
 * primary source on 2026-09-04. These are load-bearing: several of them change
 * what the plan should do, not merely what it should say.
 */
export interface Correction {
  claim: string;
  verdict: 'wrong' | 'partially-correct' | 'confirmed-with-caveat';
  correction: string;
  source: string;
  impact: string;
}

export const CORRECTIONS = [
  {
    claim: 'The docs page says PowerShell 7.7.0-preview.6 while releases show preview.4, proving docs/release desync.',
    verdict: 'wrong',
    correction:
      'Docs and Releases API agree at 7.7.0-preview.4. The "preview.6" is the .NET SDK version in the sentence "built on the .NET 11.0.100-preview.6 runtime" — a different axis, misread as the PowerShell version.',
    source:
      'raw.githubusercontent.com/MicrosoftDocs/PowerShell-Docs/main/reference/docs-conceptual/whats-new/What-s-New-in-PowerShell-77.md',
    impact:
      'The conclusion survives and is strengthened: the real desync is PowerShell pinning SDK 11.0.100-preview.6 while .NET has shipped preview.7. But the verifier must model SDK and runtime as separate axes, which the original single-string design could not express.',
  },
  {
    claim: 'PowerShell 7.7 should be the forward-looking track, implicitly becoming the next stable.',
    verdict: 'partially-correct',
    correction:
      '.NET 11 is STS (release-type "sts", 2 years support), not LTS. PowerShell inherits its support class from .NET, so the 7.7 line will never become the LTS track. 7.6 holds LTS until a PowerShell built on .NET 12.',
    source: 'builds.dotnet.microsoft.com/dotnet/release-metadata/releases-index.json',
    impact:
      'Strongly validates the three-track design, and settles which track owns persistence: durable state follows LTS, never preview.',
  },
  {
    claim: 'Hardcoding which PowerShell version is LTS is unavoidable.',
    verdict: 'wrong',
    correction:
      'PowerShell publishes master:tools/metadata.json with LTSReleaseTag as an array (currently ["v7.4.19","v7.6.5"]), plus Stable/Preview/Next release tags. First-party and machine-readable.',
    source: 'raw.githubusercontent.com/PowerShell/PowerShell/master/tools/metadata.json',
    impact:
      'The verifier reads this instead of hardcoding. TRAP: aka.ms/pwsh-buildinfo-lts looks authoritative but returns v7.4.19 — it tracks an install channel, not LTS membership, and would be wrong by a full cycle.',
  },
  {
    claim: '.NET 11 brings WASM improvements that make a real PowerShell-in-browser near.',
    verdict: 'partially-correct',
    correction:
      'Mono remains the Blazor/WASM runtime through .NET 11; CoreCLR-on-WASM is an opt-in early preview targeting stability in .NET 12. Separately, PowerShell has ZERO WASM support in-tree (RIDs are linux-x64;osx-x64). There is also no WASM multithreading in .NET 11.',
    source: 'devblogs.microsoft.com/dotnet/coreclr-progress-and-mono-timeline-dotnet-maui/ + dotnet/runtime#121511',
    impact:
      'RuntimeAdapter stays, and its value goes UP — but the .NET/WASM branch is a research spike, not a scheduled milestone. All concurrency must be browser-side (SharedWorker + Web Locks + OPFS), not .NET threads.',
  },
  {
    claim: 'SharedWorker is unavailable on some modern browsers, so a dedicated-worker fallback is needed.',
    verdict: 'partially-correct',
    correction:
      'Chrome Android shipped SharedWorker in 148 (stable 2026-05-05); Safari has had it since 16.0 (not 16.4 — that is the OPFS milestone). MDN Baseline: "Newly available" since May 2026. But Samsung Internet and Opera Mobile still have none.',
    source: 'MDN browser-compat-data api/SharedWorker.json + developer.chrome.com/release-notes/148',
    impact:
      'The Android-Chrome fallback branch is dead code. Keep a fallback anyway, for Samsung Internet and for the young Baseline floor.',
  },
  {
    claim: 'A SharedWorker can act as the storage coordination hub.',
    verdict: 'confirmed-with-caveat',
    correction:
      'It can coordinate, but it can never hold the files. The WHATWG spec marks createSyncAccessHandle [Exposed=DedicatedWorker], which excludes both Window AND SharedWorker.',
    source: 'fs.spec.whatwg.org/#filesystemfilehandle',
    impact:
      'Confirms the split already in the design: SharedWorker elects and coordinates, a dedicated StorageWorker owns sync handles. Worth stating as a hard constraint so nobody "simplifies" it later.',
  },
  {
    claim: 'The PowerShell team maintains an MCP server to integrate against.',
    verdict: 'wrong',
    correction:
      'The 2026 investments post commits to building one ("we plan to develop a team supported MCP server"), with security as the initial focus. No such repo exists in github.com/PowerShell as of 2026-09-04; all existing PowerShell MCP servers are third-party. PowerShell/AIShell was archived 2026-01-30.',
    source: 'GitHub org enumeration and code search across github.com/PowerShell (106 public repos, 0 matching mcp)',
    impact:
      'The MCP work must define its own tool schema from our command metadata. Do not plan to conform to an upstream schema that does not exist.',
  },
  {
    claim: 'PSReadLine 2026 roadmap items (context-aware prediction, input/render decoupling) justify designing for them now.',
    verdict: 'confirmed-with-caveat',
    correction:
      'Both items are in the post verbatim, but both are exploratory — "We are exploring ways", and the decoupling is called "a fundamental change that will take time". PSReadLine is idle since 2026-04-08 (default branch master, not main) with no PR touching either.',
    source: 'devblogs.microsoft.com/powershell/powershell-openssh-and-dsc-team-investments-for-2026/',
    impact:
      'Headless LineEditorCore is still right — it is good architecture on its own merits. But it must not be justified as "matching what upstream is shipping", because upstream is not shipping it.',
  },
  {
    claim: 'DSC v3.2 is the current release to model against.',
    verdict: 'partially-correct',
    correction:
      'DSC 3.2.0 GA\'d 2026-04-29 with all four cited features (version pinning, --what-if, expression language with map/filter, adapters). But latest stable is v3.2.3 and v3.3.0-rc.2 shipped 2026-08-24.',
    source: 'api.github.com/repos/PowerShell/DSC/releases',
    impact: 'Model the 3.2 feature set; pin the exact version in the profile rather than saying "3.2".',
  },
  {
    claim: 'PSResourceGet supports OCI/ORAS registries.',
    verdict: 'partially-correct',
    correction:
      'OCI/ACR ships today; ORAS is explicitly future work — "we are working to adopt the .NET ORAS library", with 0 code hits for ORAS in the repo. MAR-as-trusted-source, explicit trust config, concurrent install and discovery/consumption separation are all confirmed. 1.3.0-preview1 is real (2026-05-20); latest stable is 1.2.0.',
    source: 'devblogs.microsoft.com/powershell/powershell-psresource-roadmap-and-best-practices/',
    impact: 'Model the trust/promotion pipeline, which is the actually-shipped idea. Do not claim ORAS.',
  },
  {
    claim: 'Use the wharflab/tree-sitter-powershell grammar as the PowerShell syntax front end.',
    verdict: 'partially-correct',
    correction:
      'That repo is real and MIT, but it is 5 months old with 2 stars and a commit history of Renovate bumps. The established grammar is airbus-cert/tree-sitter-powershell (85 stars, MIT), which is what nvim-treesitter actually pins; wharflab is a detached derivative of it. PowerShell/tree-sitter-PowerShell has been archived since 2024-01-09.',
    source: 'api.github.com/repos/{wharflab,airbus-cert}/tree-sitter-powershell + nvim-treesitter parser pins',
    impact: 'Point the syntax spike at airbus-cert. All the claimed grammar features were verified present in its derivative, so the capability argument holds either way.',
  },
  {
    claim: 'VS Code issue #328110 proves tree-sitter parse success cannot be trusted as a safety boundary.',
    verdict: 'wrong',
    correction:
      'It shows the opposite. #328110 documents fail-CLOSED behaviour: an unparsable command resolves to noMatch and the user gets a confirmation prompt. Its 8% also rests on a hand-picked n=36. The argument needs microsoft/vscode#294010 (closed 2026-04-16), where "--flag=value" parses SUCCESSFULLY but wrongly as an assignment and truncates the command.',
    source: 'github.com/microsoft/vscode/issues/328110 and /294010',
    impact:
      'The design conclusion survives and is arguably stronger — a confident wrong parse is worse than a refused one — but the citation must be corrected or the argument collapses under review.',
  },
  {
    claim: 'ZenFS is LGPL-3.0 and therefore conflicts with this MIT repo.',
    verdict: 'wrong',
    correction:
      'The licence is LGPL-3.0-or-later, but the repo ships a supplemental grant in COPYING.md that expressly waives section 4(d) for software accessed over a network, i.e. exactly a web app. LGPL is weak copyleft designed to be linked from differently-licensed code. ZenFS was also plain MIT through 2.3.x (relicensed at 2.4.0, 2025-09-01).',
    source: 'github.com/zen-fs/core/blob/main/COPYING.md',
    impact:
      'Keeping FileSystemPort independent of any vendor stays good architecture, but it must not be justified by a licence conflict that does not exist. If ZenFS is ever adopted, the obligation is to offer the library Corresponding Source.',
  },
  {
    claim: 'Vitest 5 requires Node >= 22.12.',
    verdict: 'partially-correct',
    correction:
      'Its engines field is ^22.12.0 || ^24.0.0 || >=26.0.0, which EXCLUDES Node 23 and Node 25. A plain >=22.12 hides that. Vitest 5.0.0 did ship 2026-09-03 as claimed. Vite is at 8.2.2, not 8.1.',
    source: 'registry.npmjs.org/vitest and /vite',
    impact: 'Pin the CI Node version to an even-numbered line; an odd-numbered one silently fails to install.',
  },
  {
    claim: 'Advanced runtimes must be hosted off GitHub Pages because it cannot set COOP/COEP headers.',
    verdict: 'partially-correct',
    correction:
      'Pages genuinely cannot set those headers, and the 1 GB site and 100 GB/month bandwidth limits are exact. But cross-origin isolation is achievable there via a same-origin service worker that synthesises the headers (coi-serviceworker), at the cost of one extra reload on first visit.',
    source: 'docs.github.com/pages limits + github.com/gzuidhof/coi-serviceworker',
    impact: 'A separate lab origin is a tradeoff to choose, not a constraint to obey. Large VM and model assets still must not sit in the Pages artifact.',
  },
  {
    claim: 'WebLLM verifies model artifact integrity.',
    verdict: 'partially-correct',
    correction:
      'The verification code is real (src/integrity.ts, SRI hashes) but OPT-IN: the field is an optional ModelIntegrity on the model record, and nothing is checked unless hashes are supplied. Realistic cold download for the smallest conversationally useful model is roughly 290-700 MB, which is separate from the vram_required_MB figure the docs list.',
    source: 'github.com/mlc-ai/web-llm/blob/main/src/integrity.ts',
    impact: 'If AI is ever enabled, this project must supply the hashes itself and state the download size before starting it.',
  },
] as const satisfies readonly Correction[];

export const WORK = [
  // ------------------------------------------------------------------ Ground truth
  {
    n: 1,
    phase: 'Ground truth',
    slug: 'archive-and-golden-transcripts',
    title: 'Archive the single-file terminal and capture golden transcripts',
    why:
      'The current index.html is the only specification of how this site behaves. Before any refactor, its behaviour must be frozen as executable expectations, or the rewrite has nothing to be correct against.',
    status: 'done',
    dependsOn: [],
    tasks: [
      {
        id: '1.1',
        title: 'Copy index.html to legacy/terminal-v1.html, unmodified, and pin the commit sha it came from',
        detail:
          'The stated criterion was false as written, and was corrected rather than rounded to done. ' +
          '.gitattributes marks BOTH files `-text` on purpose, so git stores each verbatim and never ' +
          'normalises: index.html was committed with LF and the archive with CRLF, giving blobs ' +
          '21794ce2 and 234cdfda. PROVENANCE.md used to print a `git hash-object` comparison asserting ' +
          '"both currently hash to 21794ce2"; running it failed. Two independent reviews found this ' +
          'separately. The document now states both blobs and names the identity that DOES hold — the ' +
          'same content once CRLF is folded, dc9570a7 — with a verification command that passes and a ' +
          'test asserting it. The archive itself was not touched: recommitting a frozen artifact to ' +
          'change its line endings is a change to the thing being preserved.',
        status: 'done',
        evidence: [
          { kind: 'code', file: 'legacy/PROVENANCE.md', pattern: 'dc9570a7' },
          {
            kind: 'test',
            file: 'tests/unit/v1-transcripts.test.mts',
            name: 'is the document index.html was at the commit it was archived from',
          },
        ],
      },
      {
        id: '1.2',
        title: 'Keep the live site serving the v1 file until the rewrite reaches parity',
        detail: 'GitHub Pages serves / from index.html. The rewrite must not touch it until conformance passes.',
        status: 'done',
        evidence: [
          { kind: 'absent', glob: 'index.html', pattern: 'type="module"' },
          {
            kind: 'test',
            file: 'tests/unit/js-literal.test.mts',
            name: 'extracts a script whose text really is inside the file',
          },
        ],
      },
      {
        id: '1.3',
        title: 'Script a headless capture of every command in CMDLETS + ALIAS + EGGS against v1',
        detail:
          '67 cmdlets, 46 aliases and 11 easter eggs, deduplicated to 126 distinct invocations. ' +
          'tools/capture-v1.mts drives real headless Chromium. The command list is read from the ' +
          'RUNNING page and cross-checked against the archive literals and v1-inventory.json, because ' +
          'an enumeration that reads the same file the coverage check reads cannot detect a command ' +
          'that file is missing. All three readings agree exactly.',
        status: 'done',
        evidence: [
          { kind: 'export', file: 'tools/capture-v1.mts', symbol: 'runCapture' },
          { kind: 'code', file: 'tools/browser-harness.mts', pattern: 'chromium' },
          {
            kind: 'test',
            file: 'tests/unit/v1-transcripts.test.mts',
            name: 'still defines the five literals the capture reads',
          },
        ],
      },
      {
        id: '1.4',
        title: 'Store transcripts as tests/conformance/fixtures/v1/*.txt keyed by command',
        detail:
          '128 files, 1102 printed rows, one row per line and nothing else. Sealed by a manifest of ' +
          'per-file sha256 digests over newline-normalised content, so a hand-edited transcript fails ' +
          'the hermetic gate without needing a browser to notice.',
        status: 'done',
        evidence: [
          {
            kind: 'test',
            file: 'tests/unit/v1-transcripts.test.mts',
            name: 'has a transcript on disk for every case, matching its recorded digest',
          },
          {
            kind: 'test',
            file: 'tests/unit/v1-transcripts.test.mts',
            name: 'has no transcript that no case claims',
          },
        ],
      },
      {
        id: '1.5',
        title: 'Record the 4 seeded history entries and the boot banner as fixtures too',
        detail:
          '__boot.txt and __history.txt. The seeded history prints nothing, so without a fixture of ' +
          'its own there would be no evidence of it anywhere.',
        status: 'done',
        evidence: [
          {
            kind: 'test',
            file: 'tests/unit/v1-transcripts.test.mts',
            name: 'has a manifest digest that recomputes',
          },
        ],
      },
      {
        id: '1.6',
        title: 'Classify every source of nondeterminism by measurement, not by reading',
        detail:
          'Each case runs twice under one pinned environment and once under each of four single-axis ' +
          'variants. 3 commands read the clock, 3 the random source, 6 render a stored time in local ' +
          'time, and 2 change with the LOCALE — that last axis was expected to be inert and is not: ' +
          'nothing in v1 calls toLocale*, but V8 localises the zone name inside Date.prototype.' +
          'toString(), so one frozen instant prints "(Coordinated Universal Time)" or ' +
          '"(Koordinierte Weltzeit)". Reduced motion is load-bearing too: ping is 11 rows with it and ' +
          '2 without.',
        status: 'done',
        evidence: [
          { kind: 'code', file: 'tools/capture-v1.mts', pattern: 'prefers-reduced-motion' },
          {
            kind: 'test',
            file: 'tests/unit/v1-transcripts.test.mts',
            name: 'is the archive the fixtures were captured from',
          },
        ],
      },
    ],
    acceptance: [
      'legacy/terminal-v1.html is the same document as index.html at the recorded sha — MEASURED as identical after newline normalisation, not byte for byte: .gitattributes declares both -text on purpose, so the archive keeps its original CRLF and the two git blobs differ permanently',
      'Every command name reachable from CORPUS has a captured transcript — CORPUS rebuilt from the archive literals, never read back from the fixtures',
      'A test can replay a transcript and diff it — npm run test:browser re-executes all 128 cases against real Chromium',
    ],
    risks: ['Easter eggs and async commands (ping/traceroute) stream over time; capture must be deterministic or explicitly excluded — RESOLVED by taking the prefers-reduced-motion branch v1 already has, which prints the batch synchronously, and proving it with a settle check rather than assuming it'],
  },
  {
    n: 2,
    phase: 'Ground truth',
    slug: 'verify-release-truth',
    title: 'Mechanise version truth across five axes',
    why:
      'A hardcoded banner string is a rumour. Version truth is five independently-drifting axes, and conflating any two of them produces confident wrong answers.',
    status: 'done',
    dependsOn: [],
    tasks: [
      {
        id: '2.1',
        title: 'Resolve which releases exist from the GitHub Releases API',
        status: 'done',
        evidence: [
          { kind: 'json', file: 'compat/upstream/releases.lock.json', path: 'releases.0.tag' },
          { kind: 'code', file: 'tools/verify-release-truth.mts', pattern: 'canonicaliseReleases' },
        ],
      },
      {
        id: '2.2',
        title: 'Dereference annotated tags to real commit shas',
        detail: 'PowerShell uses annotated tags; the naive ref sha points at a tag object, not a commit.',
        status: 'done',
        evidence: [
          { kind: 'json', file: 'compat/upstream/releases.lock.json', path: 'releases.0.tagObjectSha' },
          { kind: 'json', file: 'compat/upstream/releases.lock.json', path: 'releases.0.commitSha' },
          { kind: 'code', file: 'tools/verify-release-truth.mts', pattern: 'resolveTagToCommit' },
        ],
      },
      {
        id: '2.3',
        title: 'Read the SDK pin from global.json at each tag',
        status: 'done',
        evidence: [
          { kind: 'json', file: 'compat/upstream/releases.lock.json', path: 'releases.0.dotnet.sdk' },
          { kind: 'code', file: 'tools/verify-release-truth.mts', pattern: 'global.json' },
        ],
      },
      {
        id: '2.4',
        title: 'Resolve SDK to the runtime it ships via .NET per-channel releases.json',
        detail: 'TRAP A: SDK 10.0.303 ships runtime 10.0.11. The two are different version spaces and cannot be compared.',
        status: 'done',
        evidence: [
          { kind: 'json', file: 'compat/upstream/releases.lock.json', path: 'releases.0.dotnet.runtime' },
          { kind: 'code', file: 'tools/verify-release-truth.mts', pattern: 'runtimeForSdk' },
        ],
      },
      {
        id: '2.5',
        title: 'Record SDK feature band without ordering it',
        detail: 'TRAP B: .NET 10.0.11 ships SDKs 10.0.400, 10.0.303 and 10.0.111 simultaneously. Bands are parallel trains, not a sequence.',
        status: 'done',
        evidence: [
          { kind: 'export', file: 'tools/version.mts', symbol: 'featureBand' },
          { kind: 'json', file: 'compat/upstream/releases.lock.json', path: 'releases.0.dotnet.featureBand' },
          { kind: 'test', file: 'tests/unit/version.test.mts', name: 'extracts the band from real SDK versions' },
        ],
      },
      {
        id: '2.6',
        title: 'Read LTS membership from PowerShell master:tools/metadata.json',
        detail: 'Replaces a hardcode. Avoids the aka.ms/pwsh-buildinfo-lts trap, which returns the previous LTS.',
        status: 'done',
        evidence: [
          { kind: 'json', file: 'compat/upstream/releases.lock.json', path: 'channels.lts' },
          { kind: 'json', file: 'compat/upstream/releases.lock.json', path: 'channels.ltsPrevious.0' },
          { kind: 'code', file: 'tools/verify-release-truth.mts', pattern: 'LTSReleaseTag' },
        ],
      },
      {
        id: '2.7',
        title: 'Cross-check the declared LTS against the .NET release-type rule',
        status: 'done',
        evidence: [
          { kind: 'json', file: 'compat/upstream/releases.lock.json', path: 'releases.0.dotnet.releaseType' },
          { kind: 'code', file: 'tools/verify-release-truth.mts', pattern: 'lts-derivation-disagrees' },
        ],
      },
      {
        id: '2.8',
        title: 'Cross-check the docs prose and classify which axis it names',
        detail: 'TRAP C: the 7.7 doc calls an SDK version a runtime.',
        status: 'done',
        evidence: [
          { kind: 'export', file: 'tools/docs-claim.mts', symbol: 'parseDocsClaim' },
          { kind: 'test', file: 'tests/unit/docs-claim.test.mts', name: 'reads the 7.7 claim, which names an SDK while calling it a runtime' },
          { kind: 'json', file: 'compat/upstream/releases.lock.json', path: 'discrepancies.0.code' },
        ],
      },
      {
        id: '2.9',
        title: 'Fail loudly when the docs parser stops matching',
        detail: 'A verifier that goes green because its own parser broke is worse than no verifier.',
        status: 'done',
        evidence: [
          { kind: 'test', file: 'tests/unit/docs-claim.test.mts', name: 'reports null rather than a wrong answer when the shape changes' },
          { kind: 'code', file: 'tools/verify-release-truth.mts', pattern: 'docs-parse-failed' },
        ],
      },
      {
        id: '2.10',
        title: 'Digest a canonical projection, not raw bytes',
        detail: 'The Releases API body carries download_count and reactions, which tick constantly; digesting raw bytes made --check report drift on every run.',
        status: 'done',
        evidence: [
          { kind: 'json', file: 'compat/upstream/releases.lock.json', path: 'releases.0.snapshotDigest' },
          { kind: 'code', file: 'tools/verify-release-truth.mts', pattern: 'canonicaliseDotnetChannel' },
        ],
      },
      {
        id: '2.11',
        title: 'Enforce the lockfile against its JSON schema with ajv',
        detail: 'A schema nothing validates against is decoration. This caught the v1 schema encoding the wrong SDK/runtime model.',
        status: 'done',
        evidence: [
          { kind: 'json', file: 'compat/schemas/release-truth.schema.json', path: 'properties.releases' },
          { kind: 'code', file: 'tools/verify-release-truth.mts', pattern: 'validateAgainstSchema' },
          { kind: 'script', name: 'truth:verify' },
        ],
      },
      {
        id: '2.12',
        title: 'Distinguish exit codes: 0 clean, 1 drift/error, 2 could-not-run',
        status: 'done',
        evidence: [
          { kind: 'export', file: 'tools/upstream-sync.mts', symbol: 'classifyExit' },
          { kind: 'test', file: 'tests/unit/upstream-sync.test.mts', name: 'maps the four documented codes to their documented meanings' },
          { kind: 'test', file: 'tests/unit/upstream-sync.test.mts', name: 'fails closed on the codes that used to go green' },
        ],
      },
      {
        id: '2.13',
        title: 'Wire into CI on a daily schedule, opening a PR rather than auto-merging',
        detail: 'The workflow never auto-merges and never switches the production profile. A tool that silently retargets the site when upstream ships is the hardcoded version string again, only faster.',
        status: 'done',
        evidence: [
          { kind: 'test', file: 'tests/unit/workflows.test.mts', name: 'upstream-sync.yml grants write to one job, not to the whole workflow' },
          { kind: 'test', file: 'tests/unit/workflows.test.mts', name: 'the sync branch is a constant, not a date' },
          { kind: 'code', file: '.github/workflows/upstream-sync.yml', pattern: 'cron' },
        ],
      },
      {
        id: '2.14',
        title: 'Rank rc above preview, and test it',
        detail: 'PowerShell ships an rc before every GA. Folding rc into preview made 7.6.0-rc.1 compare as older than a preview, flipping an error/warning branch during the one window when the answer matters most.',
        status: 'done',
        evidence: [
          { kind: 'export', file: 'tools/version.mts', symbol: 'compareVersions' },
          { kind: 'export', file: 'tools/version.mts', symbol: 'rankOf' },
          { kind: 'test', file: 'tests/unit/version.test.mts', name: 'TRAP D: rc outranks preview' },
        ],
      },
      {
        id: '2.15',
        title: 'Validate every upstream payload shape at the trust boundary',
        detail: 'JSON.parse(x) as T is an unchecked assertion about a third party. A renamed .NET field would have made parseVersion(undefined) return null and the lag check silently skip, leaving the run green.',
        status: 'done',
        evidence: [
          { kind: 'export', file: 'tools/upstream-schemas.mts', symbol: 'VALIDATORS' },
          { kind: 'export', file: 'tools/upstream-schemas.mts', symbol: 'narrow' },
          { kind: 'code', file: 'tools/verify-release-truth.mts', pattern: 'getShape' },
        ],
      },
      {
        id: '2.16',
        title: 'Fetch timeouts, retry with backoff, and distinct exit codes',
        detail: '0 clean, 1 drift, 2 could-not-run, 3 internal bug. CI must not treat a rate limit as though upstream moved.',
        status: 'done',
        evidence: [
          { kind: 'test', file: 'tests/unit/upstream-sync.test.mts', name: 'never describes a tool error as upstream drift' },
          { kind: 'code', file: 'tools/verify-release-truth.mts', pattern: 'AbortSignal.timeout' },
        ],
      },
      {
        id: '2.17',
        title: 'Cross-check the support-lifecycle doc as an independent LTS assertion',
        detail: 'Its table gives LTS status and end-of-support per line, derived independently of the .NET metadata. It also surfaced that v7.4.19 loses support in 66 days.',
        status: 'done',
        evidence: [
          { kind: 'export', file: 'tools/docs-claim.mts', symbol: 'parseLifecycleTable' },
          { kind: 'test', file: 'tests/unit/docs-claim.test.mts', name: 'recognises LTS rows and reads their end-of-support date' },
          { kind: 'json', file: 'compat/upstream/releases.lock.json', path: 'discrepancies.1.code' },
        ],
      },
    ],
    acceptance: [
      'npm run truth:check passes twice in a row with no false drift',
      'npx tsc --noEmit is clean under strict + noUncheckedIndexedAccess + exactOptionalPropertyTypes + erasableSyntaxOnly',
      'The lockfile records both SDK and runtime for every release',
      'No PowerShell version string is hardcoded anywhere in the tool',
    ],
  },
  {
    n: 3,
    phase: 'Ground truth',
    slug: 'compatibility-profiles',
    title: 'Express 7.6.5 and 7.7.0-preview.4 as compatibility profiles',
    why:
      'Adding a PowerShell version must never mean forking a command. Version differences belong in data that commands read, not in branches commands contain.',
    status: 'in-progress',
    dependsOn: [2],
    tasks: [
      {
        id: '3.1',
        title: 'Author compat/profiles/powershell-7.6.5-linux.json from the lockfile',
        detail: 'Generated from the release lockfile plus the metadata captured from real pwsh 7.6.5. No version string is typed by hand.',
        status: 'done',
        evidence: [
          { kind: 'json', file: 'compat/profiles/powershell-7.6.5-linux.json', path: 'displayVersion' },
          { kind: 'script', name: 'profiles' },
        ],
      },
      {
        id: '3.2',
        title: 'Author powershell-7.7.0-preview.4-linux.json inheriting from it',
        detail: 'Baseline values are derived as the inverse of the 7.7 values rather than written separately, so the two profiles cannot silently agree and turn the compatibility layer into a no-op.',
        status: 'done',
        evidence: [
          { kind: 'json', file: 'compat/profiles/powershell-7.7.0-preview.4-linux.json', path: 'inherits' },
          { kind: 'export', file: 'tools/compat-curation.mts', symbol: 'buildBehaviorTables' },
        ],
      },
      {
        id: '3.3',
        title: 'Populate behaviors for every 7.7 breaking change, each with a behaviorDocs entry citing its upstream PR',
        detail: 'CI rejects a behavior key with no doc entry: an undocumented flag is a guess.',
        status: 'done',
        evidence: [
          { kind: 'json', file: 'compat/profiles/powershell-7.7.0-preview.4-linux.json', path: 'behaviorDocs' },
          { kind: 'export', file: 'tools/compat-curation.mts', symbol: 'primaryPr' },
          { kind: 'code', file: 'tools/generate-compatibility-profile.mts', pattern: 'assertBehaviorsDocumented' },
        ],
      },
      {
        id: '3.4',
        title: 'Generate compat/deltas/7.6.5__7.7.0-preview.4.json',
        status: 'done',
        evidence: [
          { kind: 'json', file: 'compat/deltas/7.6.5__7.7.0-preview.4.json', path: 'changes.0.upstreamPr' },
          { kind: 'script', name: 'profiles' },
        ],
      },
      {
        id: '3.5',
        title: 'Mark each delta entry implemented:false until a conformance fixture proves it',
        detail:
          'MISSING: the fixture link, which is the whole mechanism. `implemented` is derived from a hand-curated four-state `implementation` field (isEmulated in tools/compat-curation.mts), and `conformanceFixture` is hardcoded null on all 22 entries. Five are implemented:true with no fixture behind any of them — proven instead by unit tests against a synthetic behaviour view, which is a different and weaker claim than agreement with a real pwsh. The reason is real (7.7.0-preview.4 is installed nowhere to capture from) and the honest half is delivered: unemulated changes are labelled "documented, not emulated" in the explorer and cannot reach execution. But the rule this task states is not the rule the code applies.',
        status: 'partial',
        evidence: [
          { kind: 'export', file: 'tools/compat-curation.mts', symbol: 'isEmulated' },
          { kind: 'json', file: 'compat/deltas/7.6.5__7.7.0-preview.4.json', path: 'changes.0.implementation' },
          { kind: 'test', file: 'tests/unit/native-commands.test.mts', name: 'follows the newGuid.defaultVersion behaviour flag, never a version check' },
        ],
      },
      {
        id: '3.6',
        title: 'Record engineLimits.nativePowerShellEngine=false and the unimplemented AST node list',
        detail:
          'MISSING: the list. `nativePowerShellEngine: false` is genuinely recorded in both profiles, and that is the half that protects a visitor from believing a real pwsh is running. `unimplementedAstNodes` is a literal [] in the generator with nothing populating it, and an empty list reads as "every AST node is implemented" — the exact opposite of the truth, since item 8 has not written a parser at all. It cannot be filled honestly until there is an AST to enumerate.',
        status: 'partial',
        evidence: [
          { kind: 'json', file: 'compat/profiles/powershell-7.6.5-linux.json', path: 'engineLimits.nativePowerShellEngine' },
          { kind: 'json', file: 'compat/profiles/powershell-7.6.5-linux.json', path: 'engineLimits.notes' },
          { kind: 'absent', glob: 'src/**/*.{ts,mts}', pattern: 'AstNodeKind' },
        ],
      },
      {
        id: '3.7',
        title: 'Record bundled module versions',
        detail: 'All six modules verified from src/Modules/PSGalleryModules.csproj at each tag. PSResourceGet is the only one that differs (1.2.0 vs 1.3.0-preview1); the rest are pinned identically, so a behaviour difference cannot be blamed on a module version unless it is that one.',
        status: 'done',
        evidence: [
          { kind: 'json', file: 'compat/profiles/powershell-7.6.5-linux.json', path: 'bundledModules' },
          { kind: 'export', file: 'compat/deltas/powershell-77-changes.source.mts', symbol: 'BUNDLED_MODULES' },
        ],
      },
      {
        id: '3.8',
        title: 'Build the profile resolver with deep-merge inheritance and cycle detection',
        detail: 'A stored profile is a delta, so nothing can read one directly. Resolution merges parent-first, detects inheritance cycles (undetected they hang the session at start with no message), and distinguishes an undeclared behaviour key from one declared null — strict mode throws on the former, because a mistyped key would otherwise make a command behave like an older version forever.',
        status: 'done',
        evidence: [
          { kind: 'export', file: 'src/compatibility/profile-resolver.ts', symbol: 'resolveProfile' },
          { kind: 'export', file: 'src/compatibility/profile-resolver.ts', symbol: 'compatibilityView' },
          { kind: 'export', file: 'src/compatibility/profile-resolver.ts', symbol: 'ProfileResolutionError' },
          { kind: 'test', file: 'tests/unit/profile-resolver.test.mts', name: 'lets the child override the parameter it does mention' },
        ],
      },
    ],
    acceptance: [
      'Both profiles validate against compatibility-profile.schema.json',
      'Every behavior key has a behaviorDocs entry with an upstream PR number',
      'Profiles are generated from the lockfile, with no hand-typed version strings',
      'Every delta entry marked implemented names the fixture that proved it (3.5 — not yet true)',
      'engineLimits enumerates the AST nodes the engine will refuse (3.6 — not yet true)',
    ],
  },

  // ------------------------------------------------------------------------ Core
  {
    n: 4,
    phase: 'Core',
    slug: 'extract-data-and-manifests',
    title: 'Extract portfolio data and command manifests out of index.html',
    why:
      'D (portfolio data) and CMDLETS (67 command entries) are trapped in a 2113-line script. Nothing can be tested or reused while they are.',
    status: 'in-progress',
    dependsOn: [1],
    tasks: [
      {
        id: '4.1',
        title: 'Extract D into typed JSON under src/data',
        detail: 'Evaluated out of index.html in an isolated VM rather than regex-scraped, because regex-scraping structure is how the 115-to-148 count drift went unnoticed. check-numbers.js now reads src/data/profile.json instead of matching D.stats, and the extractor asserts pubTotal equals pubsFull.length so two counts of one thing can never disagree silently.',
        status: 'done',
        evidence: [
          { kind: 'json', file: 'src/data/profile.json', path: 'stats' },
          { kind: 'test', file: 'tests/unit/check-numbers.test.mts', name: 'fails when the snapshot disagrees with src/data instead of trusting the snapshot' },
        ],
      },
      {
        id: '4.7',
        title: 'Extract the authoritative v1 command inventory',
        detail: 'Brace-matched out of index.html: 67 commands, 46 aliases, 11 easter eggs, independently reproducing the architecture survey figures. This is the coverage target the rewrite has to clear.',
        status: 'done',
        evidence: [
          { kind: 'json', file: 'src/commands/v1-inventory.json', path: 'counts.commands' },
          { kind: 'json', file: 'src/commands/v1-inventory.json', path: 'counts.aliases' },
          { kind: 'script', name: 'inventory' },
        ],
      },
      {
        id: '4.8',
        title: 'Declare a fidelity level for every command',
        detail:
          'native-semantic / browser-backed / simulated / external-runtime, with capabilities and a risk class. The generator refuses to emit a manifest for an unclassified command, and refuses any simulated entry with no note saying what it does NOT do. The split was 23/29/26 when this was written and is 31 native-semantic, 28 browser-backed, 26 simulated across 85 commands today — the number is read from src/commands/manifests.json, not from this sentence.',
        status: 'done',
        evidence: [
          { kind: 'export', file: 'src/commands/manifest.ts', symbol: 'Fidelity' },
          { kind: 'export', file: 'src/commands/classification.data.mts', symbol: 'CLASSIFICATION' },
          { kind: 'script', name: 'manifests' },
        ],
      },
      {
        id: '4.9',
        title: 'Derive parameter metadata from the reference implementation',
        detail: 'v1 declares 36 parameters across 67 commands; real pwsh reports 398 across 43. Manifests take types, positions, switch semantics and validation attributes from the capture where one exists, and mark everything else unverified rather than inventing it.',
        status: 'done',
        evidence: [
          { kind: 'json', file: 'compat/upstream/v7.6.5/command-metadata.json', path: 'commands' },
          { kind: 'export', file: 'src/commands/manifest.ts', symbol: 'ParameterMetadata' },
          { kind: 'test', file: 'tests/unit/binder-manifests.test.mts', name: 'validation attributes recovered from the capture' },
        ],
      },
      {
        id: '4.2',
        title: 'Remove the load-time mutation of D.profile (the __STATS__ sentinel patch)',
        detail: 'STALE todo, corrected 2026-09-06. The rewrite substitutes the sentinel per call instead of patching the array at load, and a test asserts the placeholder never reaches output. index.html still does it the old way, but item 1.2 freezes that file until parity, so the task can only mean "do not reproduce it in the rewrite".',
        status: 'done',
        evidence: [
          { kind: 'export', file: 'src/commands/portfolio/data.ts', symbol: 'STATS_SENTINEL' },
          { kind: 'export', file: 'src/commands/portfolio/data.ts', symbol: 'statsLine' },
          { kind: 'test', file: 'tests/unit/native-portfolio.test.mts', name: 'composes the stats line rather than storing it' },
        ],
      },
      {
        id: '4.3',
        title: 'Convert each CMDLETS entry into a declarative manifest + separate implementation',
        detail: 'STALE todo, corrected 2026-09-06. 85 declarative manifests in src/commands/manifests.json, each resolved to a separate implementation module through the registry; nothing is declared without an implementation behind it.',
        status: 'done',
        evidence: [
          { kind: 'export', file: 'src/commands/manifest.ts', symbol: 'CommandManifest' },
          { kind: 'export', file: 'src/commands/registry.ts', symbol: 'ALL_COMMANDS' },
          { kind: 'test', file: 'tests/unit/registry.test.mts', name: 'names the manifest gap rather than silently allowing it' },
        ],
      },
      {
        id: '4.4',
        title: 'Break the command-table/filesystem cycle',
        detail: 'STALE todo, corrected 2026-09-06. src/storage/seed.ts takes an explicit `binaries` list and imports nothing from the command layer it exists to unblock, which is exactly the binNames list this task asks for.',
        status: 'done',
        evidence: [
          { kind: 'export', file: 'src/storage/seed.ts', symbol: 'SeedOptions' },
          { kind: 'absent', glob: 'src/storage/**/*.{ts,mts}', pattern: 'commands/registry' },
          { kind: 'export', file: 'src/storage/seed.ts', symbol: 'buildSeed' },
        ],
      },
      {
        id: '4.5',
        title: 'Unify command resolution so aliases and easter eggs share one lookup order',
        detail: 'STALE todo, corrected 2026-09-06. One index covers every command name and alias; the former easter eggs are ordinary simulated-fidelity entries in it, and v1\'s sl collision is an explicit documented shadow rather than a second lookup path.',
        status: 'done',
        evidence: [
          { kind: 'export', file: 'src/commands/registry.ts', symbol: 'resolveCommand' },
          { kind: 'export', file: 'src/commands/rewrite-inventory.data.mts', symbol: 'SHADOWED_V1_TOKENS' },
          { kind: 'test', file: 'tests/unit/registry.test.mts', name: 'is case-insensitive and includes aliases' },
        ],
      },
      {
        id: '4.6',
        title: 'Delete the dead `hidden` flag that no entry ever sets, and the unused GROUPNAME/ED.path/ED.wantCol',
        detail: 'Two of the four are gone from the rewrite (ED.path, ED.wantCol have no occurrence in src/). GROUPNAME was not deleted but repurposed as a live exported constant in src/storage/seed.ts, and `hidden` is still declared in tools/extract-command-inventory.mts because the v1 extractor models v1 faithfully.',
        status: 'todo',
        evidence: [
          { kind: 'absent', glob: 'src/**/*.{ts,mts}', pattern: 'wantCol' },
          { kind: 'code', file: 'tools/extract-command-inventory.mts', pattern: 'hidden' },
        ],
      },
    ],
    acceptance: ['check-numbers.js still passes', 'No module-level mutation of portfolio data', 'Command manifests are serialisable'],
  },
  {
    n: 5,
    phase: 'Core',
    slug: 'headless-line-editor',
    title: 'Extract a headless LineEditorCore behind input and render adapters',
    why:
      'The editor currently owns shell state, history, completion AND rendering, and measures DOM geometry inline. None of it can be tested without a browser.',
    status: 'in-progress',
    dependsOn: [4],
    tasks: [
      {
        id: '5.1',
        title: 'Lift TextBuffer, HistoryEngine, CompletionEngine, PredictionEngine, KeyBindingEngine into pure modules',
        status: 'done',
        evidence: [
          { kind: 'export', file: 'src/line-editor/text-buffer.ts', symbol: 'TextBuffer' },
          { kind: 'export', file: 'src/line-editor/history.ts', symbol: 'HistoryEngine' },
          { kind: 'export', file: 'src/line-editor/completion.ts', symbol: 'CompletionEngine' },
          { kind: 'export', file: 'src/line-editor/prediction.ts', symbol: 'PredictionEngine' },
          { kind: 'export', file: 'src/line-editor/keys.ts', symbol: 'KeyBindingEngine' },
          { kind: 'test', file: 'tests/unit/line-editor.test.mts', name: 'names no browser global in any module' },
        ],
      },
      {
        id: '5.2',
        title: 'Keep the real textarea as an input adapter only',
        detail:
          'It earns its place for IME, soft keyboards and selection; it must stop owning state. The core defines the seam (EditorKeyEvent, insertText, setComposing) but no adapter has been written, and the live textarea is still the untouched v1 one in index.html.',
        status: 'todo',
        evidence: [{ kind: 'absent', glob: 'src/**/*.{ts,mts}', pattern: 'InputAdapter' }],
      },
      {
        id: '5.3',
        title: 'Define a TerminalMetrics port so width is injected, not measured via a probe span in #out',
        status: 'done',
        evidence: [
          { kind: 'export', file: 'src/line-editor/metrics.ts', symbol: 'TerminalMetrics' },
          { kind: 'export', file: 'src/line-editor/metrics.ts', symbol: 'monospaceMetrics' },
          { kind: 'export', file: 'src/line-editor/metrics.ts', symbol: 'DEFAULT_METRICS' },
          { kind: 'test', file: 'tests/unit/line-editor.test.mts', name: 'is a port, so a host can inject any measurement it likes' },
          { kind: 'test', file: 'tests/unit/line-editor-keys.test.mts', name: 'takes its page size from the injected metrics, never from a measurement' },
        ],
      },
      {
        id: '5.4',
        title: 'Tag every history entry with origin (user | completion | ai | script), cwd and profile',
        detail: 'So AI-issued commands cannot pollute the user\'s arrow-key history.',
        status: 'done',
        evidence: [
          { kind: 'export', file: 'src/line-editor/history.ts', symbol: 'HistoryOrigin' },
          { kind: 'export', file: 'src/line-editor/history.ts', symbol: 'DEFAULT_NAVIGATION_ORIGINS' },
          { kind: 'test', file: 'tests/unit/line-editor-history.test.mts', name: 'carries provenance on every entry' },
          { kind: 'test', file: 'tests/unit/line-editor-history.test.mts', name: 'leaves agent commands out by default' },
        ],
      },
      {
        id: '5.5',
        title: 'Preserve the IME triple-guard (isComposing || composing || keyCode===229)',
        detail:
          'MISSING: the third leg. The sticky `composing` state and the per-event `isComposing` flag are both in the core and tested; `keyCode === 229` occurs nowhere in src/ because the core deliberately leaves it to an input adapter that task 5.2 has not built. Two of three legs is not the guard — v1 carries all three precisely because neither of the other two was reliable alone on old Safari and Android IMEs.',
        status: 'partial',
        evidence: [
          { kind: 'test', file: 'tests/unit/line-editor-keys.test.mts', name: 'hands every key back while a composition is in progress' },
          { kind: 'test', file: 'tests/unit/line-editor-keys.test.mts', name: 'honours a per-event isComposing flag as well as the sticky one' },
          { kind: 'absent', glob: 'src/**/*.{ts,mts}', pattern: 'keyCode' },
        ],
      },
    ],
    acceptance: ['LineEditorCore has zero DOM imports', 'Completion and prediction are unit-testable headlessly', 'CJK/IME input still works on mobile'],
    risks: ['The IME and mobile-selection behaviour of the current textarea is subtle and hard-won; regressions here are user-visible'],
  },
  {
    n: 6,
    phase: 'Core',
    slug: 'worker-kernel-protocol',
    title: 'Move execution into a worker behind a typed kernel protocol',
    why: 'run() is a god function: parse, history, prompt echo, pipeline policy, execution, DOM print and scroll, all inline.',
    status: 'in-progress',
    dependsOn: [5],
    tasks: [
      {
        id: '6.1',
        title: 'Define the kernel protocol: submit, cancel, signal, event stream',
        status: 'done',
        evidence: [
          { kind: 'export', file: 'src/kernel/protocol.ts', symbol: 'KERNEL_REQUEST_KINDS' },
          { kind: 'export', file: 'src/kernel/protocol.ts', symbol: 'KERNEL_EVENT_KINDS' },
          { kind: 'export', file: 'src/kernel/protocol.ts', symbol: 'KernelRequest' },
          { kind: 'test', file: 'tests/unit/kernel.test.mts', name: 'lists exactly the request kinds the protocol defines' },
          { kind: 'test', file: 'tests/unit/kernel.test.mts', name: 'covers every event kind and every stream' },
        ],
      },
      {
        id: '6.2',
        title: 'Split run() into parse -> execute -> render with no DOM access in the middle',
        detail:
          'MISSING: two of the three stages. Execute is real, DOM-free and heavily tested. Parse is a placeholder — splitPipeline plus a whitespace split that the kernel itself labels DELIBERATELY NOT A PARSER and marks for deletion, pending item 8. Render is not a kernel stage at all: the kernel stops at emitting events, and formatting happens inside Out-String and the Format-* commands rather than at the pipeline tail. The "no DOM in the middle" half holds, but trivially, because nothing in src/ touches the DOM yet.',
        status: 'partial',
        evidence: [
          { kind: 'export', file: 'src/kernel/kernel.ts', symbol: 'Kernel' },
          { kind: 'export', file: 'src/kernel/kernel.ts', symbol: 'splitPipeline' },
          { kind: 'test', file: 'tests/unit/kernel.test.mts', name: 'creates a process, emits its objects, and exits 0' },
          { kind: 'absent', glob: 'src/**/*.{ts,mts}', pattern: 'document.querySelector' },
        ],
      },
      {
        id: '6.3',
        title: 'Model async commands as event streams instead of the asyncOut/busy globals',
        detail: 'ping/traceroute returned null and printed themselves in v1, forcing a pipeline pre-flight hack. They are ordinary commands now, writing values that the kernel turns into events and that honour cancellation between writes.',
        status: 'done',
        evidence: [
          { kind: 'absent', glob: 'src/**/*.{ts,mts}', pattern: 'asyncOut' },
          { kind: 'export', file: 'src/commands/simulated/network.ts', symbol: 'networkCommands' },
          { kind: 'test', file: 'tests/unit/simulated.test.mts', name: 'draws exactly four values, as v1 does' },
          { kind: 'test', file: 'tests/unit/kernel.test.mts', name: 'Ctrl+C stops the foreground pipeline and leaves the background job alone' },
        ],
      },
      {
        id: '6.4',
        title: 'Stop commands mutating prompt chrome; return a CWD change instead',
        detail:
          'MISSING: the return channel. No command touches prompt chrome or the DOM any more — that half is real. But nothing carries a location change back either: Set-Location mutates the filesystem object\'s own location while the kernel\'s per-terminal cwd is set once at startup and never refreshed, and the protocol has no event for it. Get-Location and $env:PWD therefore read a value that a cd does not update.',
        status: 'partial',
        evidence: [
          { kind: 'export', file: 'src/commands/ports.ts', symbol: 'FileSystemPort' },
          { kind: 'export', file: 'src/commands/fs-read/set-location.ts', symbol: 'setLocation' },
          { kind: 'absent', glob: 'src/kernel/**/*.{ts,mts}', pattern: 'location-changed' },
        ],
      },
    ],
    acceptance: ['No command implementation touches document', 'Cancellation works mid-pipeline', 'asyncOut special-casing is gone'],
  },
  {
    n: 7,
    phase: 'Core',
    slug: 'object-pipeline',
    title: 'Build the typed object pipeline and stream model',
    why:
      'Today every command returns pre-formatted rows, so `gci | Sort-Object` sorts rendered text including the UnixMode prefix. Without objects, Get-Member, Select-Object, ConvertTo-Json, property completion and structured AI results are all impossible.',
    status: 'in-progress',
    dependsOn: [6],
    tasks: [
      {
        id: '7.1',
        title: 'Define PSObject with typed properties and a type name',
        detail: 'Case-insensitive property access, a type-name hierarchy for -is and formatting, PowerShell truthiness, and one-level pipeline unrolling. Every semantic was read off pwsh 7.6.5 rather than assumed, which corrected three of them: enumeration is one level not recursive, string ordering is culture-aware not codepoint, and it is Measure-Object that skips nulls rather than the pipeline dropping them.',
        status: 'done',
        evidence: [
          { kind: 'export', file: 'src/pipeline/psobject.ts', symbol: 'PSObject' },
          { kind: 'export', file: 'src/pipeline/psobject.ts', symbol: 'psObject' },
          { kind: 'export', file: 'src/pipeline/psobject.ts', symbol: 'typeNameOf' },
          { kind: 'test', file: 'tests/unit/psobject.test.mts', name: 'is case-insensitive, as PowerShell is' },
          { kind: 'test', file: 'tests/unit/psobject.test.mts', name: 'unrolls exactly one level' },
          { kind: 'test', file: 'tests/unit/psobject.test.mts', name: 'orders strings by culture, not by code point' },
        ],
      },
      {
        id: '7.2',
        title: 'Implement the six PowerShell streams plus a separate native byte pipeline',
        detail: 'Numbered 1-6 as users type them, with Progress deliberately unnumbered because there is no 7> in PowerShell. ErrorRecord carries the fields scripts actually branch on (FullyQualifiedErrorId, CategoryInfo). Sinks are async so a slow terminal can push back on a fast producer.',
        status: 'done',
        evidence: [
          { kind: 'export', file: 'src/pipeline/streams.ts', symbol: 'STREAM_NUMBER' },
          { kind: 'export', file: 'src/pipeline/streams.ts', symbol: 'PowerShellStreams' },
          { kind: 'export', file: 'src/pipeline/streams.ts', symbol: 'NativeStreams' },
          { kind: 'export', file: 'src/pipeline/streams.ts', symbol: 'ErrorRecord' },
          { kind: 'test', file: 'tests/unit/kernel.test.mts', name: 'preserves the true interleaving of four independent channels' },
        ],
      },
      {
        id: '7.3',
        title: 'Move formatting to the end of the pipeline as Format-* directives',
        detail: 'STALE todo, corrected 2026-09-06. Format-Table/-List/-Wide emit one opaque record carrying a FormatDocument in baseObject and no public properties, so a later stage can learn nothing from it; only Out-String and the default renderer turn one into text.',
        status: 'done',
        evidence: [
          { kind: 'export', file: 'src/formatting/records.ts', symbol: 'formatRecord' },
          { kind: 'export', file: 'src/formatting/records.ts', symbol: 'isFormatRecord' },
          { kind: 'export', file: 'src/formatting/records.ts', symbol: 'FORMAT_ENTRY_TYPE' },
          { kind: 'test', file: 'tests/unit/format-cmdlets.test.mts', name: 'emits ONE opaque directive, not objects' },
          { kind: 'test', file: 'tests/unit/format-cmdlets.test.mts', name: 'exposes NO properties, so a later stage learns nothing from it' },
        ],
      },
      {
        id: '7.4',
        title: 'Reimplement Get-ChildItem to emit objects, with formatting applied last',
        detail: 'STALE todo, corrected 2026-09-06. Get-ChildItem emits FileInfo and DirectoryInfo PSObjects with a numeric Length and Date timestamps, and renders nothing itself.',
        status: 'done',
        evidence: [
          { kind: 'export', file: 'src/commands/fs-read/get-childitem.ts', symbol: 'getChildItem' },
          { kind: 'export', file: 'src/commands/fs-read/support.ts', symbol: 'fileSystemInfo' },
          { kind: 'test', file: 'tests/unit/fs-read.test.mts', name: 'emits FileInfo and DirectoryInfo with the measured type chains' },
          { kind: 'test', file: 'tests/unit/fs-read.test.mts', name: 'gives a directory no Length property at all' },
        ],
      },
      {
        id: '7.5',
        title: 'Make Sort/Select/Where/Measure/Group operate on properties, not on rendered text',
        detail: 'STALE todo, corrected 2026-09-06. All five resolve properties off PSValues and compare with compareValues, never on rendered rows. Where-Object is still held back from the default session, but for an unrelated reason: -match uses JavaScript RegExp rather than .NET, and its -is type table is narrow.',
        status: 'done',
        evidence: [
          { kind: 'export', file: 'src/commands/powershell/sort-object.ts', symbol: 'sortObject' },
          { kind: 'export', file: 'src/commands/powershell/group-object.ts', symbol: 'groupObject' },
          { kind: 'export', file: 'src/pipeline/psobject.ts', symbol: 'compareValues' },
          { kind: 'test', file: 'tests/unit/psobject.test.mts', name: 'reproduces the reference implementation Sort-Object result' },
        ],
      },
      {
        id: '7.6',
        title: 'Keep an EncodingBroker so native byte streams are not corrupted by UTF-16 round-trips',
        detail:
          'Built. One place decides an encoding and one place applies it: the two tables that ' +
          'existed before disagreed about `ascii`, disagreed about which names existed at all, ' +
          'and neither matched pwsh on `oem`. Legacy single-byte codecs are hand-rolled rather ' +
          'than delegated to TextDecoder, because Node and Chrome disagree across the whole ' +
          '0x80-0x9F range for windows-1252 and .NET agrees with Chrome — using TextDecoder ' +
          'would have pinned one answer in the tests and shipped the other. UTF-8 is delegated, ' +
          'measured to agree across Node, Chrome and .NET even on invalid input. A structural ' +
          'gate now fails on any TextDecoder or TextEncoder constructed in src/ outside it.',
        status: 'done',
        evidence: [
          { kind: 'export', file: 'src/pipeline/encoding.ts', symbol: 'EncodingBroker' },
          { kind: 'export', file: 'src/pipeline/encoding.ts', symbol: 'resolveEncodingName' },
          {
            kind: 'test',
            file: 'tests/unit/encoding.test.mts',
            name: 'does NOT decode ascii as windows-1252, which is the bug this replaced',
          },
          {
            kind: 'test',
            file: 'tests/unit/encoding.test.mts',
            name: 'distinguishes latin1 from windows-1252 across the whole 0x80-0x9F range',
          },
        ],
      },
    ],
    acceptance: [
      'gci | Sort-Object Length sorts numerically',
      'Get-Member reports real properties',
      'ConvertTo-Json emits structure, not text — no ConvertTo-Json exists yet, so this one is still open',
    ],
  },
  {
    n: 8,
    phase: 'Core',
    slug: 'version-aware-binder',
    title: 'Build one lexer, one AST and a version-aware parameter binder',
    why:
      'There are currently FOUR independent tokenizers — splitPipe, the execOne regex, parseArgsOf, and the highlighter (which colours >, >> and < that nothing can execute) — plus ad-hoc flag re-parsing inside nine command bodies. Most 7.7 breaking changes are binder-level, so the binder must be a first-class component.',
    status: 'in-progress',
    dependsOn: [3, 7],
    tasks: [
      {
        id: '8.1',
        title: 'Write one lexer with real quote and escape handling',
        detail:
          'MISSING: the "one". A real lexer exists — tokenize() handles quoting, doubled-quote escaping and backticks — but it only serves line-editor completion. Execution still runs on the kernel\'s splitTokens, which splits on whitespace with no quote handling at all, and the binder carries a third parameter-token classifier of its own. Three token recognisers, which is the defect item 8 was opened about, one short of v1\'s four.',
        status: 'partial',
        evidence: [
          { kind: 'export', file: 'src/line-editor/tokenize.ts', symbol: 'tokenize' },
          { kind: 'test', file: 'tests/unit/kernel.test.mts', name: 'does not split inside quotes' },
          { kind: 'code', file: 'src/kernel/kernel.ts', pattern: 'splitTokens' },
        ],
      },
      {
        id: '8.2',
        title: 'Separate the editing parser (incremental, error-tolerant) from the execution parser (strict)',
        detail: 'Error-tolerant parsing must never feed the evaluator. Only the tolerant half exists; there is no strict execution parser to separate it from.',
        status: 'todo',
      },
      {
        id: '8.3',
        title: 'Refuse to execute recognised-but-unimplemented syntax with an explicit error naming the AST node',
        detail: 'There is no AST, so there is no node to name. Both the kernel and the PowerShell command support module say so in as many words.',
        status: 'todo',
        evidence: [{ kind: 'absent', glob: 'src/**/*.{ts,mts}', pattern: 'AstNodeKind' }],
      },
      {
        id: '8.4',
        title: 'Implement ParameterBinder with validation, parameter sets and positional binding',
        detail: 'STALE todo, corrected 2026-09-06. Named and positional binding, parameter-set narrowing, mandatory checks, coercion and validation attributes are all implemented and are among the most heavily tested code in the repository.',
        status: 'done',
        evidence: [
          { kind: 'export', file: 'src/binding/binder.ts', symbol: 'bindParameters' },
          { kind: 'export', file: 'src/binding/binder.ts', symbol: 'tryBindParameters' },
          { kind: 'export', file: 'src/binding/validation.ts', symbol: 'validate' },
          { kind: 'test', file: 'tests/unit/binder-manifests.test.mts', name: 'binds positional Path then Filter' },
          { kind: 'test', file: 'tests/unit/binder-manifests.test.mts', name: 'rejects -Path together with -LiteralPath' },
        ],
      },
      {
        id: '8.5',
        title: 'Support switchSemantics so -Switch:$false differs from -Switch absent',
        detail: 'STALE todo, corrected 2026-09-06. The mechanism is not named switchSemantics — it is honourExplicitFalse, a per-command, per-parameter behaviour key resolved from the active profile — but it is exactly this, and thirty-odd command/parameter pairs declare it.',
        status: 'done',
        evidence: [
          { kind: 'export', file: 'src/compatibility/behavior-keys.ts', symbol: 'switchBehaviorKey' },
          { kind: 'json', file: 'compat/profiles/powershell-7.7.0-preview.4-linux.json', path: 'behaviors' },
          { kind: 'test', file: 'tests/unit/binder-switch-scope.test.mts', name: 'binds New-Guid -Empty:$false as PRESENT under 7.6 and as FALSE under 7.7' },
        ],
      },
      {
        id: '8.6',
        title: 'Apply profile parameterPatches over base metadata rather than forking commands',
        detail:
          'MISSING: the applying. The merge machinery is real and tested — CommandPatch.parameterPatches deep-merges parent-first — but nothing uses it. No shipped profile declares a single parameterPatches entry, and CompatibilityView, the interface the binder and commands actually consume, exposes only behaviour lookups, so no code path reads a patch and overrides parameter metadata before binding.',
        status: 'partial',
        evidence: [
          { kind: 'export', file: 'src/compatibility/profile-resolver.ts', symbol: 'CommandPatch' },
          { kind: 'test', file: 'tests/unit/profile-resolver.test.mts', name: 'lets the child override the parameter it does mention' },
          { kind: 'absent', glob: 'compat/profiles/*.json', pattern: 'parameterPatches' },
        ],
      },
      {
        id: '8.7',
        title: 'Make the highlighter share the real lexer so it cannot colour syntax the engine rejects',
        detail: 'No highlighter has been ported yet, and it is moot until 8.1 leaves one tokenizer to share.',
        status: 'todo',
      },
    ],
    acceptance: [
      'One tokenizer in the codebase — three exist today: tokenize, splitTokens and the binder\'s parameter-token classifier',
      'Where-Object -Not:$false behaves per the active profile',
      'Format-Table -Property "" errors on 7.7 and not on 7.6, from data alone',
    ],
  },

  // ----------------------------------------------------------------------- State
  {
    n: 9,
    phase: 'State',
    slug: 'storage-layer',
    title: 'OPFS-backed filesystem with overlay, WAL, snapshots and migrations',
    why:
      'State currently lives in one localStorage key with no transactions, no snapshots and no migration path. It also cannot survive a schema change.',
    status: 'in-progress',
    dependsOn: [6],
    tasks: [
      {
        id: '9.1',
        title: 'Implement OPFS backend with sync access handles inside a dedicated StorageWorker',
        detail:
          'Built. The constraint held: createSyncAccessHandle is [Exposed=DedicatedWorker], which ' +
          'excludes Window AND SharedWorker, so the coordinator never holds the handle. Verified ' +
          'end to end in real Chromium inside a dedicated worker, not against the fake alone. The ' +
          'store is a checkpoint plus a write-ahead log over five fixed ASCII filenames rather ' +
          'than a mirrored tree, and two measurements ruled the mirror out: a lone surrogate in an ' +
          'OPFS name is SILENTLY replaced with U+FFFD, so two distinct virtual names collide into ' +
          'one entry with no error anywhere; and the sync-handle lock is per file entry with no ' +
          'directory lock, so a mirrored tree cannot make a multi-file recursive copy exclusive ' +
          'against another tab.',
        status: 'done',
        evidence: [
          { kind: 'export', file: 'src/storage/opfs.ts', symbol: 'OpfsStorage' },
          { kind: 'code', file: 'src/storage/opfs-platform.ts', pattern: 'createSyncAccessHandle' },
          {
            kind: 'test',
            file: 'tests/unit/opfs-worker.test.mts',
            name: 'names every callable member of StorageBackend',
          },
          {
            kind: 'test',
            file: 'tests/unit/opfs-conformance.test.mts',
            name: 'refuses a second sync access handle with NoModificationAllowedError',
          },
        ],
      },
      {
        id: '9.2',
        title: 'Keep the seed/overlay split that already works: rebuild seed each boot, graft user changes',
        detail: 'STALE todo, corrected 2026-09-06. bootStorage rebuilds the seed image and grafts the overlay over it, with v1\'s graft rules — seed wins on a kind conflict, seed content is always re-rendered, user content survives, mode and mtime are preserved — each separately tested.',
        status: 'done',
        evidence: [
          { kind: 'export', file: 'src/storage/index.ts', symbol: 'bootStorage' },
          { kind: 'test', file: 'tests/unit/storage-snapshot.test.mts', name: 'shows a returning visitor the NEW seed while keeping their files' },
          { kind: 'test', file: 'tests/unit/storage-snapshot.test.mts', name: 'carries user files and not seed content' },
          { kind: 'test', file: 'tests/unit/storage-snapshot.test.mts', name: 'lets the seed win when it replaced a user path with the other kind' },
        ],
      },
      {
        id: '9.3',
        title: 'Add a write-ahead log and snapshot/restore',
        detail:
          'MISSING: the log. Two things were bundled into one task and they are at different stages. Snapshot/restore is fully built — create, export, import, restore, checksummed, version 2, refusing every malformed shape — and heavily tested. The WAL is an interface and a NullJournal that writes nothing; the memory backend does not need one and a real log only attaches to a durable backend, which task 9.1 has not built. There is no write-ahead log today.',
        status: 'partial',
        evidence: [
          { kind: 'export', file: 'src/storage/snapshot.ts', symbol: 'createSnapshot' },
          { kind: 'export', file: 'src/storage/snapshot.ts', symbol: 'restoreSnapshot' },
          { kind: 'export', file: 'src/storage/memory.ts', symbol: 'NullJournal' },
          { kind: 'test', file: 'tests/unit/storage-snapshot.test.mts', name: 'survives losing the store entirely' },
          { kind: 'test', file: 'tests/unit/storage-memory.test.mts', name: 'journals the whole plan before applying it, and commits after' },
        ],
      },
      {
        id: '9.4',
        title: 'Add versioned migrations with rollback',
        detail:
          'Built alongside the OPFS store, which is what gave migrations something to migrate. Up ' +
          'and down are separate entry points, so a rollback is a declared operation rather than a ' +
          'hope.',
        status: 'done',
        evidence: [
          { kind: 'export', file: 'src/storage/opfs-migrate.ts', symbol: 'migrateUp' },
          { kind: 'export', file: 'src/storage/opfs-migrate.ts', symbol: 'migrateDown' },
          {
            kind: 'test',
            file: 'tests/unit/opfs-store.test.mts',
            name: 'a write survives a clean close and a remount',
          },
        ],
      },
      {
        id: '9.5',
        title: 'Elect a storage leader with Web Locks; use SharedWorker for coordination where available',
        detail:
          'Built, with the fallback the availability data called for: Web Locks has been widely ' +
          'available since March 2022, while SharedWorker is only Baseline "newly available" and ' +
          'absent on Samsung Internet and Opera Mobile, so coordination degrades rather than ' +
          'requiring it. Cross-tab lock behaviour was measured in a real browser, not modelled.',
        status: 'done',
        evidence: [
          { kind: 'export', file: 'src/storage/opfs.ts', symbol: 'createCoordinator' },
          { kind: 'code', file: 'src/storage/opfs.ts', pattern: 'SharedWorker' },
          {
            kind: 'test',
            file: 'tests/unit/opfs-worker.test.mts',
            name: 'round-trips a write and a read across the boundary',
          },
        ],
      },
      {
        id: '9.6',
        title: 'Surface quota via navigator.storage.estimate() and warn before the ceiling',
        detail:
          'MISSING: the measurement and the warning. OPFS shares the origin quota and is deleted when the user clears site data, so export must exist before people can lose work — and it does (9.3). The QuotaUsage shape is defined and plumbed end to end through the backend and the filesystem, and it is tested. But navigator.storage.estimate() is never called, nothing warns near the ceiling, and Get-StorageStatus — the command df\'s own note points at — does not exist.',
        status: 'done',
        evidence: [
          { kind: 'export', file: 'src/storage/types.ts', symbol: 'QuotaUsage' },
          { kind: 'code', file: 'src/storage/opfs.ts', pattern: 'storage.estimate' },
          {
            kind: 'test',
            file: 'tests/unit/storage-memory.test.mts',
            name: 'reports the directory size as 4096, as ext4 and v1 both do',
          },
          {
            kind: 'test',
            file: 'tests/unit/opfs-store.test.mts',
            name: 'keeps every operation but the last, and says which',
          },
        ],
      },
      {
        id: '9.7',
        title: 'Return Result<void, StorageError> instead of a rendered error row',
        detail: 'STALE todo, corrected 2026-09-06. Every backend and filesystem method returns Result<T, StorageError>, and the command layer maps the POSIX-shaped error into a PowerShell ErrorRecord with its own FullyQualifiedErrorId — which is exactly the rendered-view-object pattern this task asks to remove.',
        status: 'done',
        evidence: [
          { kind: 'export', file: 'src/storage/types.ts', symbol: 'Result' },
          { kind: 'export', file: 'src/storage/types.ts', symbol: 'StorageError' },
          { kind: 'export', file: 'src/commands/fs-read/support.ts', symbol: 'storageErrorRecord' },
          { kind: 'test', file: 'tests/unit/storage-memory.test.mts', name: 'reports ENOTDIR when a path component is a file' },
        ],
      },
    ],
    acceptance: ['A migration can be rolled back', 'Two tabs cannot corrupt the tree', 'Clearing site data is survivable via export'],
    risks: ['OPFS is deleted on site-data clear with no warning from the browser; export/import must land in the same PR'],
  },
  {
    n: 10,
    phase: 'State',
    slug: 'provider-model',
    title: 'PowerShell provider model over the mount table',
    why: 'Env, Variable, Function, Process and Package are not files. Forcing them into /proc and /dev is less faithful than modelling providers.',
    status: 'in-progress',
    dependsOn: [9],
    tasks: [
      {
        id: '10.1',
        title: 'Define the provider interface (drive, item, child-item, content)',
        detail:
          'MISSING: the interface. The seam a provider model would sit on is built and tested — a mount table that routes drive-qualified paths, and one path resolver already proven generic by mounting a second backend at a made-up drive. But every mount is typed as the same POSIX-shaped StorageBackend, and there is no item/child-item/content abstraction. vfs.ts says so itself: the seam exists so PR-10 can add Env:, Variable: and Function:, and none of them is implemented there.',
        status: 'partial',
        evidence: [
          { kind: 'export', file: 'src/storage/vfs.ts', symbol: 'MountTable' },
          { kind: 'export', file: 'src/storage/vfs.ts', symbol: 'VirtualFileSystem' },
          { kind: 'test', file: 'tests/unit/storage-path.test.mts', name: 'routes a drive-qualified path to the second mount, not the first' },
          { kind: 'test', file: 'tests/unit/storage-path.test.mts', name: 'unmounts a provider drive and forgets its alias' },
        ],
      },
      {
        id: '10.2',
        title: 'Implement FileSystem, Env, Variable, Function, Alias providers',
        detail: 'Environment variables are ordinary simulated commands with invented output, never a mounted Env: drive.',
        status: 'todo',
        evidence: [{ kind: 'no-files', glob: 'src/providers/**/*', within: 'src/**/*' }],
      },
      {
        id: '10.3',
        title: 'Implement Portfolio, Process, Package and Browser providers',
        status: 'todo',
        evidence: [{ kind: 'no-files', glob: 'src/providers/**/*', within: 'src/**/*' }],
      },
      {
        id: '10.4',
        title: 'Move quote-stripping out of resolvePath; paths should arrive already lexed',
        detail: 'STALE todo, corrected 2026-09-06. resolvePath touches no quotes at all: a file whose name literally contains quote characters is addressable, and a test pins it.',
        status: 'done',
        evidence: [
          { kind: 'export', file: 'src/storage/vfs.ts', symbol: 'resolvePath' },
          { kind: 'test', file: 'tests/unit/storage-path.test.mts', name: 'does not strip quotes; a quoted name is a name' },
        ],
      },
    ],
    acceptance: ['Get-ChildItem Env:/ works', 'Set-Location Portfolio:/ works', 'One path resolver, used by every provider'],
  },

  // --------------------------------------------------------------- Compatibility
  {
    n: 11,
    phase: 'Compatibility',
    slug: 'differential-conformance',
    title: 'Differential conformance against real pwsh 7.6.5',
    why:
      'Fidelity claims need evidence. pwsh 7.6.5 on .NET 10.0.11 is installed on the dev machine, so the LTS track can be differential-tested today without CI or Docker.',
    status: 'in-progress',
    dependsOn: [8],
    tasks: [
      {
        id: '11.1',
        title: 'Write generate-conformance-fixtures.ps1 to capture real pwsh output for a command corpus',
        detail: 'STALE todo, corrected 2026-09-06. It captures the 115-case corpus against real pwsh, runs each case twice to prove determinism, and seals every case and the document with a sha256 over a canonical projection so an edited recording is reported as tampering rather than as a defect in the project.',
        status: 'done',
        evidence: [
          { kind: 'json', file: 'tests/conformance/fixtures/pwsh-7.6.5.json', path: 'cases' },
          { kind: 'json', file: 'tests/conformance/fixtures/pwsh-7.6.5.json', path: 'integrity' },
          { kind: 'script', name: 'capture:conformance' },
          { kind: 'test', file: 'tests/conformance/conformance.test.mts', name: 'actually compared something' },
        ],
      },
      {
        id: '11.2',
        title: 'Normalise machine-specific output (paths, times, pids, widths) before comparison',
        detail: 'STALE todo, corrected 2026-09-06. Nine normalisation rules cover line endings, machine paths, username, hostname, pid, guid, ISO timestamp, clock time and trailing space, with residue detectors for what normalisation cannot fix.',
        status: 'done',
        evidence: [
          { kind: 'json', file: 'tests/conformance/fixtures/pwsh-7.6.5.json', path: 'normalisation' },
          { kind: 'code', file: 'tools/generate-conformance-fixtures.ps1', pattern: 'NormalisationRules' },
        ],
      },
      {
        id: '11.3',
        title: 'Capture Get-Command metadata from real pwsh to validate our manifests',
        detail: 'Done for 7.6.5 via tools/capture-pwsh-metadata.ps1: 43 commands, 398 declared parameters, with types, parameter sets, positions, pipeline binding and validation attributes. It already proves four 7.7 deltas against the reference implementation — Format-Table -Property carries no attributes in 7.6.5, and -ExcludeProperty and Join-Path -Extension do not exist there.',
        status: 'done',
        evidence: [
          { kind: 'json', file: 'compat/upstream/v7.6.5/command-metadata.json', path: 'commands' },
          { kind: 'json', file: 'compat/upstream/v7.6.5/command-metadata.json', path: 'requested' },
          { kind: 'script', name: 'capture:metadata' },
          { kind: 'test', file: 'tests/unit/binder-differential.test.mts', name: 'reproduces the reference exactly under the 7.6 profile too, with no exceptions' },
        ],
      },
      {
        id: '11.4',
        title: 'Record known-differences.yml for deliberate divergences, with a reason for each',
        detail: 'STALE todo, corrected 2026-09-06. The file is not merely present: a narrow YAML reader parses it, every entry needs a reason of at least twenty characters and a case id that exists in the corpus, and a test proves the file was really read rather than silently coming back empty.',
        status: 'done',
        evidence: [
          { kind: 'export', file: 'tools/conformance.mts', symbol: 'runConformance' },
          { kind: 'test', file: 'tests/conformance/conformance.test.mts', name: 'does not count a known gap as evidence of fidelity' },
          { kind: 'code', file: 'tests/conformance/known-differences.yml', pattern: 'reason' },
        ],
      },
      {
        id: '11.5',
        title: 'Report per-profile conformance coverage as a number the site can display',
        detail:
          'MISSING: the per-profile part, and the display. The number itself is real and hard to forge — coverage is credited only where the connection between a case and a command can be established mechanically, after relabelling twenty-four cases was shown to move it from 38.7% to 100% with zero problems reported — and `npm run conformance -- --check` gates it. But there is exactly one fixture, for 7.6.5, so "per-profile" is aspirational; and nothing renders it: the explorer page never mentions coverage, and no other page in the repository does either.',
        status: 'partial',
        evidence: [
          { kind: 'json', file: 'tests/conformance/report.json', path: 'coverage.behaviouralCoveragePercent' },
          { kind: 'test', file: 'tests/conformance/conformance.test.mts', name: 'counts coverage from established credits, never from the corpus label' },
          { kind: 'no-files', glob: 'tests/conformance/fixtures/pwsh-7.7*', within: 'tests/conformance/**/*' },
        ],
      },
    ],
    acceptance: ['A fixture mismatch fails CI', 'Every divergence is either fixed or listed with a reason', 'Coverage is a measured number, not a claim'],
    risks: ['7.7-preview.4 needs a side-by-side install or CI container; the 7.6.5 track works locally today'],
  },
  {
    n: 12,
    phase: 'Compatibility',
    slug: 'behavior-delta-ui',
    title: 'Ship the version-difference explorer',
    why: 'The whole point of profiles is being able to answer "what would this script do differently on 7.7?" without reading a changelog.',
    status: 'in-progress',
    dependsOn: [11],
    tasks: [
      {
        id: '12.1',
        title: 'Add a command that diffs a script across two profiles',
        detail: 'Nothing runs a script under two profiles. The profile resolver is not even reachable from the command layer yet.',
        status: 'todo',
        evidence: [{ kind: 'absent', glob: 'src/**/*.{ts,mts}', pattern: 'compareProfiles' }],
      },
      {
        id: '12.2',
        title: 'Show, per difference, whether BrowserShell actually emulates it or merely documents it',
        detail: 'STALE todo, corrected 2026-09-06. The generated explorer page labels every documented difference either emulated or "documented, not emulated", sorts the emulated ones first, and prints the ratio. Delivered as a generated static page rather than as in-session UI, which is what 12.1 and 12.3 would add.',
        status: 'done',
        evidence: [
          { kind: 'json', file: 'compat/deltas/7.6.5__7.7.0-preview.4.json', path: 'summary' },
          { kind: 'code', file: 'tools/generate-compat-explorer.mts', pattern: 'documented, not emulated' },
          { kind: 'script', name: 'explorer' },
        ],
      },
      {
        id: '12.3',
        title: 'Let the session switch profiles without losing the filesystem',
        detail: 'There is no concept of an active profile in a session at all, so there is nothing to switch.',
        status: 'todo',
        evidence: [{ kind: 'absent', glob: 'src/**/*.{ts,mts}', pattern: 'activeProfile' }],
      },
    ],
    acceptance: ['New-Guid shows v4 vs v7 across profiles', 'Unemulated differences are labelled as such'],
  },

  // ------------------------------------------------------------------ Declarative
  {
    n: 13,
    phase: 'Declarative',
    slug: 'workstation-state',
    title: 'DSC-style declarative workstation state',
    why: 'A machine you cannot export, diff and restore is a pile of implicit localStorage, not a machine.',
    status: 'todo',
    dependsOn: [10],
    tasks: [
      {
        id: '13.1',
        title: 'Define the resource schema and registry',
        detail: 'The only registry in the repository is the command-name lookup table, which is a different thing entirely.',
        status: 'todo',
        evidence: [{ kind: 'no-files', glob: 'src/dsc/**/*', within: 'src/**/*' }],
      },
      {
        id: '13.2',
        title: 'Implement Get/Test/Set with WhatIf planning',
        detail: 'Model the DSC 3.2 feature set — version pinning, --what-if, map/filter expressions, adapters — and pin the exact DSC version modelled (3.2.3 stable; 3.3.0-rc.2 exists). Nothing in the command set records SupportsShouldProcess, so -WhatIf does not exist anywhere yet.',
        status: 'todo',
        evidence: [{ kind: 'absent', glob: 'src/**/*.{ts,mts}', pattern: 'WhatIf' }],
      },
      {
        id: '13.3',
        title: 'Implement Export/Import of the whole workstation',
        detail: 'The filesystem can be exported and restored (9.3); the machine as a configuration cannot.',
        status: 'todo',
        evidence: [{ kind: 'absent', glob: 'src/**/*.{ts,mts}', pattern: 'Set-WorkstationState' }],
      },
      {
        id: '13.4',
        title: 'Report configuration drift',
        detail: 'The word drift is used throughout this repository for a different thing — two hand-maintained counts disagreeing — and none of it is DSC-style resource drift.',
        status: 'todo',
        evidence: [{ kind: 'no-files', glob: 'src/dsc/**/*', within: 'src/**/*' }],
      },
    ],
    acceptance: ['Set-WorkstationState -WhatIf previews without mutating', 'An exported config rebuilds an equivalent machine'],
  },

  // ----------------------------------------------------------------- Supply chain
  {
    n: 14,
    phase: 'Supply chain',
    slug: 'package-trust',
    title: 'Package identity, integrity, capabilities and trust promotion',
    why:
      'A browser package manager that downloads and evaluates JavaScript is an XSS engine with a friendly prompt. Trust has to be in the design from the first line.',
    status: 'in-progress',
    dependsOn: [10],
    tasks: [
      {
        id: '14.1',
        title: 'Define the package manifest with publisher, capabilities and integrity digest',
        detail: 'The only digest verification in the repository guards conformance fixtures against tampering, which is a different trust boundary.',
        status: 'todo',
        evidence: [{ kind: 'absent', glob: 'src/**/*.{ts,mts}', pattern: 'PackageManifest' }],
      },
      {
        id: '14.2',
        title: 'Verify digests before execution; refuse on mismatch',
        status: 'todo',
        evidence: [{ kind: 'no-files', glob: 'src/packages/**/*', within: 'src/**/*' }],
      },
      {
        id: '14.3',
        title: 'Run third-party modules in a sandboxed worker behind a capability broker',
        detail:
          'MISSING: the sandbox. The capability broker is real, enforced on every command today and thoroughly tested — two gates, declared and granted, with an append-only audit log that records denials and elevations. The isolation half does not exist, and src/kernel/inspect.ts says so itself: the real boundary is a separate Worker or a sandboxed iframe with a message-only API and no shared global, and that is future work. Without it the broker guards a boundary that a module could simply step around.',
        status: 'partial',
        evidence: [
          { kind: 'export', file: 'src/kernel/capabilities.ts', symbol: 'CapabilityBroker' },
          { kind: 'export', file: 'src/kernel/capabilities.ts', symbol: 'AuditLog' },
          { kind: 'test', file: 'tests/unit/kernel-capabilities.test.mts', name: 'denies a capability that is declared but not granted' },
          { kind: 'test', file: 'tests/unit/kernel-capabilities.test.mts', name: 'records a denial, which is the line a reviewer actually looks for' },
          { kind: 'absent', glob: 'src/**/*.{ts,mts}', pattern: 'new Worker' },
        ],
      },
      {
        id: '14.4',
        title: 'Implement a lockfile and a discovery -> review -> promotion flow',
        detail: 'Models the actually-shipped PSResourceGet idea: discovery separated from trusted production consumption. Do NOT claim ORAS support — it is explicitly future work upstream. The only lockfile here is the upstream release lockfile from item 2, which is unrelated.',
        status: 'todo',
        evidence: [{ kind: 'no-files', glob: 'src/packages/**/*', within: 'src/**/*' }],
      },
    ],
    acceptance: ['A tampered package fails to install', 'A module cannot reach OPFS except through granted capabilities'],
  },

  // -------------------------------------------------------------------------- AI
  {
    n: 15,
    phase: 'AI',
    slug: 'mcp-and-approval',
    title: 'MCP tool schema generation and the approval gate',
    why:
      'Command metadata already has to exist for help, completion and the binder. MCP tools and the AI planner should be consumers of it, not a parallel definition.',
    status: 'in-progress',
    dependsOn: [8, 14],
    tasks: [
      {
        id: '15.1',
        title: 'Generate MCP tool schemas from command manifests',
        detail: 'No upstream schema to conform to: the team-maintained PowerShell MCP server is a stated 2026 intention with no public code. Define ours from our metadata. Nothing is built; MCP appears only in two comments naming it as a future consumer.',
        status: 'todo',
        evidence: [{ kind: 'absent', glob: 'src/**/*.{ts,mts}', pattern: 'mcp' }],
      },
      {
        id: '15.2',
        title: 'Classify every command by risk: read / query-external / write / destructive / device / privileged-simulation',
        detail:
          'STALE todo, corrected 2026-09-06. Delivered as a by-product of the command-manifest work in item 4, not as MCP work: the Risk union is exactly the six the task names, the classification table requires one on every entry, the generator refuses to emit a manifest without it, and all 85 commands carry one. Two of the six categories have no members yet, which is a fact about the command set rather than a gap in the classification.',
        status: 'done',
        evidence: [
          { kind: 'export', file: 'src/commands/manifest.ts', symbol: 'Risk' },
          { kind: 'export', file: 'src/commands/classification.data.mts', symbol: 'Classification' },
          { kind: 'test', file: 'tests/unit/kernel-capabilities.test.mts', name: 'classify every risk the contract declares' },
          { kind: 'test', file: 'tests/unit/kernel-capabilities.test.mts', name: 'audit every write, delete, network, device and privileged simulation' },
        ],
      },
      {
        id: '15.3',
        title: 'Route AI plans through schema validation, AST validation, capability analysis and WhatIf preview before approval',
        detail: 'Blocked twice over: there is no AST to validate against (8.3) and no -WhatIf to preview with (13.2).',
        status: 'todo',
        evidence: [{ kind: 'absent', glob: 'src/**/*.{ts,mts}', pattern: 'approval' }],
      },
      {
        id: '15.4',
        title: 'Deny the AI direct handles: no OPFS, clipboard, device, package token or storage key',
        detail: 'The broker is generic per-session infrastructure that could carry this, but nothing distinguishes an AI-issued command from a user one at the gate, and there is no AI execution path to deny. The only place the codebase knows about an AI origin is the history tag from 5.4, which is a display concern.',
        status: 'todo',
        evidence: [{ kind: 'no-files', glob: 'src/ai/**/*', within: 'src/**/*' }],
      },
      {
        id: '15.5',
        title: 'Audit-log every AI-originated action with its plan and approval',
        detail: 'The audit log is real and append-only, but its records carry no plan and no approval field, and nothing writes to it from an AI origin.',
        status: 'todo',
        evidence: [{ kind: 'absent', glob: 'src/**/*.{ts,mts}', pattern: 'approval' }],
      },
    ],
    acceptance: ['A destructive AI plan cannot execute without explicit approval', 'Every AI action is reconstructable from the audit log'],
  },

  // ------------------------------------------------------------------- Rendering
  {
    n: 16,
    phase: 'Rendering',
    slug: 'ansi-renderer',
    title: 'Optional xterm.js ANSI renderer alongside the semantic DOM terminal',
    why:
      'The semantic DOM terminal is what makes this accessible to screen readers and is the better default. ANSI is for TUI fidelity, and must be a second adapter rather than a replacement.',
    status: 'in-progress',
    dependsOn: [7],
    tasks: [
      {
        id: '16.1',
        title: 'Define TerminalPort with both a semantic DOM and an xterm adapter',
        detail:
          'The port carries write/clear/snapshot/unsupported and no input surface at all, so the xterm adapter cannot become a second input owner beside the line editor and the real textarea. LEFT OPEN on purpose, because it is not this task\'s to settle: xterm\'s own `open()` installs its helper textarea and key listeners, and whether the host suppresses them belongs to the input seam. No dependency was added — the module is injected, so every adapter test runs with no xterm installed.',
        status: 'done',
        evidence: [
          { kind: 'export', file: 'src/renderer/port.ts', symbol: 'TerminalPort' },
          { kind: 'export', file: 'src/renderer/semantic.ts', symbol: 'createSemanticTerminal' },
          { kind: 'export', file: 'src/renderer/xterm.ts', symbol: 'createXtermTerminal' },
          { kind: 'test', file: 'tests/unit/renderer-semantic.test.mts', name: 'names itself the semantic renderer' },
          { kind: 'test', file: 'tests/unit/renderer-xterm.test.mts', name: 'builds a port that writes through to xterm' },
          { kind: 'test', file: 'tests/unit/renderer-xterm.test.mts', name: 'never touches xterm\'s input surface' },
        ],
      },
      {
        id: '16.2',
        title: 'Separate the ANSI parser from plain-text formatting',
        detail:
          'A resumable VT500 state machine in src/renderer/ansi.ts, and the separation is a direction that is now checked: nothing under src/formatting/ imports the renderer. The reason, measured with this repository\'s own Format-Table: a cell holding an SGR-wrapped `foo` sizes its column to 10 and draws 3, so the plain row beside it lands seven columns further right. The parser is resumable because a regex over one chunk emits a half-written sequence as visible text — which is what "VT Reset sequences appearing mid-string" looks like from the outside.',
        status: 'done',
        evidence: [
          { kind: 'export', file: 'src/renderer/ansi.ts', symbol: 'AnsiParser' },
          { kind: 'export', file: 'src/renderer/ansi.ts', symbol: 'stripAnsi' },
          { kind: 'test', file: 'tests/unit/renderer-ansi.test.mts', name: 'is resumable: a sequence split one character at a time parses identically' },
          { kind: 'test', file: 'tests/unit/renderer-ansi.test.mts', name: 'discards a malformed CSI whole rather than printing its tail' },
          { kind: 'test', file: 'tests/unit/renderer-ansi.test.mts', name: 'a coloured cell misaligns the table by the printable length of its sequences' },
          { kind: 'test', file: 'tests/unit/renderer-ansi.test.mts', name: 'nothing under src/formatting imports the renderer' },
        ],
      },
      {
        id: '16.3',
        title: 'Use cell width rather than string length everywhere',
        detail:
          'MISSING: "everywhere", which is now down to two DELIBERATE exceptions and nothing else. The port that gave this task its point exists: the renderer places characters with the same cellWidthOfCodePoint the formatter and the line editor use, and the xterm adapter hands xterm a Unicode provider backed by it rather than letting xterm measure — a sweep of all 1 112 064 scalar values asserts the provider and the table never disagree. What still pads by character count: ls, which models raw POSIX ls piped to a file, and the -f operator, whose alignment is .NET String.Format\'s and really does pad "中文" to four columns with two spaces. Both are measured divergences documented at their call sites, so the honest status is partial rather than done.',
        status: 'partial',
        evidence: [
          { kind: 'export', file: 'src/line-editor/cells.ts', symbol: 'displayWidth' },
          { kind: 'export', file: 'src/formatting/width.ts', symbol: 'truncateToWidth' },
          { kind: 'export', file: 'src/renderer/grid.ts', symbol: 'runsOf' },
          { kind: 'test', file: 'tests/unit/cell-width.test.mts', name: 'agrees with the UCD on all 1 114 112 code points, not just the corpus' },
          { kind: 'test', file: 'tests/unit/cell-width.test.mts', name: 'renderer and line editor answer identically, on every sample' },
          { kind: 'test', file: 'tests/unit/renderer-grid.test.mts', name: 'puts the letter after two ideographs in column 4, not column 2' },
          { kind: 'test', file: 'tests/unit/renderer-xterm.test.mts', name: 'answers with this project\'s own table, code point for code point' },
        ],
      },
      {
        id: '16.4',
        title: 'Keep the semantic renderer the default and keep aria-live output intact',
        detail:
          'createTerminal returns the semantic renderer synchronously and the xterm one only when asked for by name, so the accessible renderer is the one you get by saying nothing. role/aria-live/aria-atomic/aria-label are asserted against the values read out of legacy/terminal-v1.html rather than restated. All 1102 captured v1 rows are replayed and compared as accessible text; 1098 are byte-identical. THE FOUR THAT ARE NOT are the tab-bearing rows of lsb_release: v1 put a raw TAB in a text node, and a terminal advances to the next stop at a multiple of eight, which is also what xterm does with the same bytes. Keeping the raw tab would make the two renderers disagree about every line containing one.',
        status: 'done',
        evidence: [
          { kind: 'export', file: 'src/renderer/index.ts', symbol: 'createTerminal' },
          { kind: 'export', file: 'src/renderer/semantic.ts', symbol: 'LOG_REGION_LIVE' },
          { kind: 'test', file: 'tests/unit/renderer-semantic.test.mts', name: 'carries exactly the attributes v1 puts on #out' },
          { kind: 'test', file: 'tests/unit/renderer-semantic.test.mts', name: 'reproduces every captured row byte for byte, but for expanded tabs' },
          { kind: 'test', file: 'tests/unit/renderer-semantic.test.mts', name: 'puts unstyled text in a text node, with no wrapper element' },
          { kind: 'test', file: 'tests/unit/renderer-semantic.test.mts', name: 'keeps an escape sequence out of the accessible text entirely' },
        ],
      },
    ],
    acceptance: ['CJK and emoji align in both renderers', 'Screen-reader output is unchanged in the default renderer'],
  },

  // -------------------------------------------------------------- Future runtime
  {
    n: 17,
    phase: 'Future runtime',
    slug: 'dotnet-wasm-spike',
    title: 'Research spike: real PowerShell parser via .NET WASM',
    why:
      'The honest sequencing is to use real pwsh in CI to generate golden ASTs first, and only move the real parser into the browser when the runtime substrate is ready.',
    status: 'deferred',
    dependsOn: [8, 11],
    tasks: [
      {
        id: '17.1',
        title: 'Define RuntimeAdapter so UI, VFS, AI and terminal never depend on which engine runs',
        status: 'todo',
        evidence: [{ kind: 'absent', glob: 'src/**/*.{ts,mts}', pattern: 'RuntimeAdapter' }],
      },
      {
        id: '17.2',
        title: 'Generate golden ASTs from real pwsh in CI and validate our parser against them',
        detail: 'This is the near-term win and needs no WASM at all — but it still needs a parser of ours to validate, and item 8 has not written one.',
        status: 'todo',
        evidence: [{ kind: 'absent', glob: 'src/**/*.{ts,mts}', pattern: 'AstNodeKind' }],
      },
      { id: '17.3', title: 'Spike loading a real PowerShell parser under .NET WASM', detail: 'BLOCKED on substrate: Mono is still the Blazor WASM runtime through .NET 11; CoreCLR-on-WASM is opt-in early preview targeting .NET 12. PowerShell itself has ZERO WASM support in-tree (RIDs linux-x64;osx-x64). This is a spike, not a milestone.', status: 'blocked' },
    ],
    acceptance: ['RuntimeAdapter exists and the semantic engine implements it', 'Golden AST tests run against real pwsh'],
    risks: ['Do not schedule the WASM branch as a deliverable. The substrate stabilises in .NET 12, and the PowerShell port does not exist — we would be writing it.'],
  },

  // -------------------------------------------------------------------- Desktop
  {
    n: 18,
    phase: 'Desktop',
    slug: 'desktop-apps',
    title: 'File manager, task manager, settings and window management',
    why: 'These are what turn a prompt into a workstation, and they are cheap once providers and the object pipeline exist.',
    status: 'in-progress',
    dependsOn: [10, 13],
    tasks: [
      {
        id: '18.1',
        title: 'Rebuild the nano/vim editor on the extracted core rather than on global ED state',
        detail: 'STALE todo, corrected 2026-09-06. nano, vi and vim are one command factory going through a ui.dialog capability and a DialogPort, with no dependency on any global editor state — the only mention of v1\'s ED is a comment citing the behaviour being reproduced.',
        status: 'done',
        evidence: [
          { kind: 'export', file: 'src/commands/fs-manage/editors.ts', symbol: 'nano' },
          { kind: 'export', file: 'src/commands/fs-manage/editors.ts', symbol: 'vim' },
          { kind: 'test', file: 'tests/unit/fs-manage-editors.test.mts', name: 'reads the file, hands it over, and writes the result' },
          { kind: 'test', file: 'tests/unit/fs-manage-editors.test.mts', name: 'reports a ui.dialog denial without opening anything' },
          { kind: 'absent', glob: 'src/**/*.{ts,mts}', pattern: 'wantCol' },
        ],
      },
      {
        id: '18.2',
        title: 'File manager over the provider model',
        detail: 'Blocked on item 10: there is no provider model to build over.',
        status: 'todo',
        evidence: [{ kind: 'no-files', glob: 'src/apps/**/*', within: 'src/**/*' }],
      },
      {
        id: '18.3',
        title: 'Task manager over the process/job model',
        detail: 'The kernel process table and job model exist, but nothing consumes them: ps and Get-Process are simulated commands printing an invented list, disconnected from the real table by design until an app reads it.',
        status: 'todo',
        evidence: [{ kind: 'no-files', glob: 'src/apps/**/*', within: 'src/**/*' }],
      },
      {
        id: '18.4',
        title: 'Settings backed by declarative workstation state',
        detail: 'PreferencesPort and Set-Theme are real, but that is one flat key, not a settings surface, and the declarative state it is meant to sit on (item 13) does not exist.',
        status: 'todo',
        evidence: [{ kind: 'no-files', glob: 'src/apps/**/*', within: 'src/**/*' }],
      },
    ],
    acceptance: ['The editor no longer reaches back into console internals', 'Apps use providers, not direct filesystem access'],
  },
] as const satisfies readonly WorkItem[];
