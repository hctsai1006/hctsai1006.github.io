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

export type Status = 'done' | 'in-progress' | 'todo' | 'blocked' | 'deferred';

export interface Task {
  id: string;
  title: string;
  /** Why this task exists, when that is not obvious from the title. */
  detail?: string;
  status: Status;
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
      { id: '1.1', title: 'Copy index.html to legacy/terminal-v1.html, unmodified, and pin the commit sha it came from', detail: 'Identity is the git blob hash, not raw bytes: core.autocrlf=true means the working tree is CRLF while git stores LF, so a byte comparison against git show fails on an unchanged file.', status: 'done' },
      { id: '1.2', title: 'Keep the live site serving the v1 file until the rewrite reaches parity', detail: 'GitHub Pages serves / from index.html. The rewrite must not touch it until conformance passes.', status: 'done' },
      { id: '1.3', title: 'Script a headless capture of every command in CMDLETS + ALIAS + EGGS against v1', detail: '67 cmdlets, 46 aliases, 11 easter eggs, deduplicated to 126 distinct invocations. tools/capture-v1.mts drives real headless Chromium; the command list is read from the RUNNING page and cross-checked against the archive literals and v1-inventory.json, because an enumeration that reads the file the coverage check reads cannot detect a command that file is missing.', status: 'done' },
      { id: '1.4', title: 'Store transcripts as tests/conformance/fixtures/v1/*.txt keyed by command', detail: '128 files, 1102 rows, one printed row per line. Sealed by a manifest of per-file sha256 digests over newline-normalised content, so a hand-edited transcript fails the hermetic gate without needing a browser.', status: 'done' },
      { id: '1.5', title: 'Record the 4 seeded history entries and the boot banner as fixtures too', detail: '__boot.txt and __history.txt. The seeded history prints nothing, so without a fixture of its own there is no evidence of it anywhere.', status: 'done' },
      { id: '1.6', title: 'Classify every source of nondeterminism by measurement, not by reading', detail: 'Each case runs twice under one pinned environment and once under each of four single-axis variants. 3 commands read the clock, 3 the random source, 6 render a stored time in local time, and 2 change with the LOCALE — that last one was expected to be empty and was not: V8 localises the zone name inside Date.prototype.toString().', status: 'done' },
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
      { id: '2.1', title: 'Resolve which releases exist from the GitHub Releases API', status: 'done' },
      { id: '2.2', title: 'Dereference annotated tags to real commit shas', detail: 'PowerShell uses annotated tags; the naive ref sha points at a tag object, not a commit.', status: 'done' },
      { id: '2.3', title: 'Read the SDK pin from global.json at each tag', status: 'done' },
      { id: '2.4', title: 'Resolve SDK to the runtime it ships via .NET per-channel releases.json', detail: 'TRAP A: SDK 10.0.303 ships runtime 10.0.11. The two are different version spaces and cannot be compared.', status: 'done' },
      { id: '2.5', title: 'Record SDK feature band without ordering it', detail: 'TRAP B: .NET 10.0.11 ships SDKs 10.0.400, 10.0.303 and 10.0.111 simultaneously. Bands are parallel trains, not a sequence.', status: 'done' },
      { id: '2.6', title: 'Read LTS membership from PowerShell master:tools/metadata.json', detail: 'Replaces a hardcode. Avoids the aka.ms/pwsh-buildinfo-lts trap, which returns the previous LTS.', status: 'done' },
      { id: '2.7', title: 'Cross-check the declared LTS against the .NET release-type rule', status: 'done' },
      { id: '2.8', title: 'Cross-check the docs prose and classify which axis it names', detail: 'TRAP C: the 7.7 doc calls an SDK version a runtime.', status: 'done' },
      { id: '2.9', title: 'Fail loudly when the docs parser stops matching', detail: 'A verifier that goes green because its own parser broke is worse than no verifier.', status: 'done' },
      { id: '2.10', title: 'Digest a canonical projection, not raw bytes', detail: 'The Releases API body carries download_count and reactions, which tick constantly; digesting raw bytes made --check report drift on every run.', status: 'done' },
      { id: '2.11', title: 'Enforce the lockfile against its JSON schema with ajv', detail: 'A schema nothing validates against is decoration. This caught the v1 schema encoding the wrong SDK/runtime model.', status: 'done' },
      { id: '2.12', title: 'Distinguish exit codes: 0 clean, 1 drift/error, 2 could-not-run', status: 'done' },
      { id: '2.13', title: 'Wire into CI on a daily schedule, opening a PR rather than auto-merging', detail: 'The workflow never auto-merges and never switches the production profile. A tool that silently retargets the site when upstream ships is the hardcoded version string again, only faster.', status: 'done' },
      { id: '2.14', title: 'Rank rc above preview, and test it', detail: 'PowerShell ships an rc before every GA. Folding rc into preview made 7.6.0-rc.1 compare as older than a preview, flipping an error/warning branch during the one window when the answer matters most.', status: 'done' },
      { id: '2.15', title: 'Validate every upstream payload shape at the trust boundary', detail: 'JSON.parse(x) as T is an unchecked assertion about a third party. A renamed .NET field would have made parseVersion(undefined) return null and the lag check silently skip, leaving the run green.', status: 'done' },
      { id: '2.16', title: 'Fetch timeouts, retry with backoff, and distinct exit codes', detail: '0 clean, 1 drift, 2 could-not-run, 3 internal bug. CI must not treat a rate limit as though upstream moved.', status: 'done' },
      { id: '2.17', title: 'Cross-check the support-lifecycle doc as an independent LTS assertion', detail: 'Its table gives LTS status and end-of-support per line, derived independently of the .NET metadata. It also surfaced that v7.4.19 loses support in 66 days.', status: 'done' },
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
      { id: '3.1', title: 'Author compat/profiles/powershell-7.6.5-linux.json from the lockfile', detail: 'Generated from the release lockfile plus the metadata captured from real pwsh 7.6.5. No version string is typed by hand.', status: 'done' },
      { id: '3.2', title: 'Author powershell-7.7.0-preview.4-linux.json inheriting from it', detail: 'Baseline values are derived as the inverse of the 7.7 values rather than written separately, so the two profiles cannot silently agree and turn the compatibility layer into a no-op.', status: 'done' },
      { id: '3.3', title: 'Populate behaviors for every 7.7 breaking change, each with a behaviorDocs entry citing its upstream PR', detail: 'CI rejects a behavior key with no doc entry: an undocumented flag is a guess.', status: 'done' },
      { id: '3.4', title: 'Generate compat/deltas/7.6.5__7.7.0-preview.4.json', status: 'done' },
      { id: '3.5', title: 'Mark each delta entry implemented:false until a conformance fixture proves it', detail: 'The UI must say "documented, not emulated" rather than imply fidelity.', status: 'done' },
      { id: '3.6', title: 'Record engineLimits.nativePowerShellEngine=false and the unimplemented AST node list', status: 'done' },
      { id: '3.7', title: 'Record bundled module versions', detail: 'All six modules verified from src/Modules/PSGalleryModules.csproj at each tag. PSResourceGet is the only one that differs (1.2.0 vs 1.3.0-preview1); the rest are pinned identically, so a behaviour difference cannot be blamed on a module version unless it is that one.', status: 'done' },
      { id: '3.8', title: 'Build the profile resolver with deep-merge inheritance and cycle detection', detail: 'A stored profile is a delta, so nothing can read one directly. Resolution merges parent-first, detects inheritance cycles (undetected they hang the session at start with no message), and distinguishes an undeclared behaviour key from one declared null — strict mode throws on the former, because a mistyped key would otherwise make a command behave like an older version forever.', status: 'done' },
    ],
    acceptance: [
      'Both profiles validate against compatibility-profile.schema.json',
      'Every behavior key has a behaviorDocs entry with an upstream PR number',
      'Profiles are generated from the lockfile, with no hand-typed version strings',
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
      { id: '4.1', title: 'Extract D into typed JSON under src/data', detail: 'Evaluated out of index.html in an isolated VM rather than regex-scraped, because regex-scraping structure is how the 115-to-148 count drift went unnoticed. check-numbers.js now reads src/data/profile.json instead of matching D.stats, and the extractor asserts pubTotal equals pubsFull.length so two counts of one thing can never disagree silently.', status: 'done' },
      { id: '4.7', title: 'Extract the authoritative v1 command inventory', detail: 'Brace-matched out of index.html: 67 commands, 46 aliases, 11 easter eggs, independently reproducing the architecture survey figures. This is the coverage target the rewrite has to clear.', status: 'done' },
      { id: '4.8', title: 'Declare a fidelity level for every command', detail: 'native-semantic / browser-backed / simulated / external-runtime, with capabilities and a risk class. The generator refuses to emit a manifest for an unclassified command, and refuses any simulated entry with no note saying what it does NOT do. Result: 23 native-semantic, 29 browser-backed, 26 simulated.', status: 'done' },
      { id: '4.9', title: 'Derive parameter metadata from the reference implementation', detail: 'v1 declares 36 parameters across 67 commands; real pwsh reports 398 across 43. Manifests take types, positions, switch semantics and validation attributes from the capture where one exists, and mark everything else unverified rather than inventing it.', status: 'done' },
      { id: '4.2', title: 'Remove the load-time mutation of D.profile (the __STATS__ sentinel patch)', status: 'todo' },
      { id: '4.3', title: 'Convert each CMDLETS entry into a declarative manifest + separate implementation', status: 'todo' },
      { id: '4.4', title: 'Break the command-table/filesystem cycle', detail: 'buildSeed enumerates CMDLETS to populate /usr/bin, and which queries both. Pass an explicit binNames list instead.', status: 'todo' },
      { id: '4.5', title: 'Unify command resolution so aliases and easter eggs share one lookup order', detail: 'set-location currently reaches into EGGS because sl is both an alias and an egg.', status: 'todo' },
      { id: '4.6', title: 'Delete the dead `hidden` flag that no entry ever sets, and the unused GROUPNAME/ED.path/ED.wantCol', status: 'todo' },
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
    status: 'todo',
    dependsOn: [4],
    tasks: [
      { id: '5.1', title: 'Lift TextBuffer, HistoryEngine, CompletionEngine, PredictionEngine, KeyBindingEngine into pure modules', status: 'todo' },
      { id: '5.2', title: 'Keep the real textarea as an input adapter only', detail: 'It earns its place for IME, soft keyboards and selection; it must stop owning state.', status: 'todo' },
      { id: '5.3', title: 'Define a TerminalMetrics port so width is injected, not measured via a probe span in #out', status: 'todo' },
      { id: '5.4', title: 'Tag every history entry with origin (user | completion | ai | script), cwd and profile', detail: 'So AI-issued commands cannot pollute the user\'s arrow-key history.', status: 'todo' },
      { id: '5.5', title: 'Preserve the IME triple-guard (isComposing || composing || keyCode===229)', status: 'todo' },
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
    status: 'todo',
    dependsOn: [5],
    tasks: [
      { id: '6.1', title: 'Define the kernel protocol: submit, cancel, signal, event stream', status: 'todo' },
      { id: '6.2', title: 'Split run() into parse -> execute -> render with no DOM access in the middle', status: 'todo' },
      { id: '6.3', title: 'Model async commands as event streams instead of the asyncOut/busy globals', detail: 'ping/traceroute currently return null and print themselves, forcing a pipeline pre-flight hack.', status: 'todo' },
      { id: '6.4', title: 'Stop commands mutating prompt chrome; return a CWD change instead', status: 'todo' },
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
      { id: '7.1', title: 'Define PSObject with typed properties and a type name', detail: 'Case-insensitive property access, a type-name hierarchy for -is and formatting, PowerShell truthiness, and one-level pipeline unrolling. Every semantic was read off pwsh 7.6.5 rather than assumed, which corrected three of them: enumeration is one level not recursive, string ordering is culture-aware not codepoint, and it is Measure-Object that skips nulls rather than the pipeline dropping them.', status: 'done' },
      { id: '7.2', title: 'Implement the six PowerShell streams plus a separate native byte pipeline', detail: 'Numbered 1-6 as users type them, with Progress deliberately unnumbered because there is no 7> in PowerShell. ErrorRecord carries the fields scripts actually branch on (FullyQualifiedErrorId, CategoryInfo). Sinks are async so a slow terminal can push back on a fast producer.', status: 'done' },
      { id: '7.3', title: 'Move formatting to the end of the pipeline as Format-* directives', status: 'todo' },
      { id: '7.4', title: 'Reimplement Get-ChildItem to emit objects, with formatting applied last', status: 'todo' },
      { id: '7.5', title: 'Make Sort/Select/Where/Measure/Group operate on properties, not on rendered text', status: 'todo' },
      { id: '7.6', title: 'Keep an EncodingBroker so native byte streams are not corrupted by UTF-16 round-trips', status: 'todo' },
    ],
    acceptance: ['gci | Sort-Object Length sorts numerically', 'Get-Member reports real properties', 'ConvertTo-Json emits structure, not text'],
  },
  {
    n: 8,
    phase: 'Core',
    slug: 'version-aware-binder',
    title: 'Build one lexer, one AST and a version-aware parameter binder',
    why:
      'There are currently FOUR independent tokenizers — splitPipe, the execOne regex, parseArgsOf, and the highlighter (which colours >, >> and < that nothing can execute) — plus ad-hoc flag re-parsing inside nine command bodies. Most 7.7 breaking changes are binder-level, so the binder must be a first-class component.',
    status: 'todo',
    dependsOn: [3, 7],
    tasks: [
      { id: '8.1', title: 'Write one lexer with real quote and escape handling', status: 'todo' },
      { id: '8.2', title: 'Separate the editing parser (incremental, error-tolerant) from the execution parser (strict)', detail: 'Error-tolerant parsing must never feed the evaluator.', status: 'todo' },
      { id: '8.3', title: 'Refuse to execute recognised-but-unimplemented syntax with an explicit error naming the AST node', status: 'todo' },
      { id: '8.4', title: 'Implement ParameterBinder with validation, parameter sets and positional binding', status: 'todo' },
      { id: '8.5', title: 'Support switchSemantics so -Switch:$false differs from -Switch absent', detail: 'A whole class of 7.7 fixes is exactly this.', status: 'todo' },
      { id: '8.6', title: 'Apply profile parameterPatches over base metadata rather than forking commands', status: 'todo' },
      { id: '8.7', title: 'Make the highlighter share the real lexer so it cannot colour syntax the engine rejects', status: 'todo' },
    ],
    acceptance: [
      'One tokenizer in the codebase',
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
    status: 'todo',
    dependsOn: [6],
    tasks: [
      { id: '9.1', title: 'Implement OPFS backend with sync access handles inside a dedicated StorageWorker', detail: 'HARD CONSTRAINT: the WHATWG spec marks createSyncAccessHandle [Exposed=DedicatedWorker], which excludes Window AND SharedWorker. The coordinator can never hold the handle.', status: 'todo' },
      { id: '9.2', title: 'Keep the seed/overlay split that already works: rebuild seed each boot, graft user changes', status: 'todo' },
      { id: '9.3', title: 'Add a write-ahead log and snapshot/restore', status: 'todo' },
      { id: '9.4', title: 'Add versioned migrations with rollback', status: 'todo' },
      { id: '9.5', title: 'Elect a storage leader with Web Locks; use SharedWorker for coordination where available', detail: 'Web Locks is widely available since March 2022 and MDN documents leader election explicitly. SharedWorker is only Baseline "newly available" (May 2026) and absent on Samsung Internet and Opera Mobile, so the fallback stays.', status: 'todo' },
      { id: '9.6', title: 'Surface quota via navigator.storage.estimate() and warn before the ceiling', detail: 'OPFS shares the origin quota and is deleted when the user clears site data. Export must exist before people can lose work.', status: 'todo' },
      { id: '9.7', title: 'Return Result<void, StorageError> instead of a rendered error row', detail: 'fsSave currently returns a view object consumed by 13 command bodies.', status: 'todo' },
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
    status: 'todo',
    dependsOn: [9],
    tasks: [
      { id: '10.1', title: 'Define the provider interface (drive, item, child-item, content)', status: 'todo' },
      { id: '10.2', title: 'Implement FileSystem, Env, Variable, Function, Alias providers', status: 'todo' },
      { id: '10.3', title: 'Implement Portfolio, Process, Package and Browser providers', status: 'todo' },
      { id: '10.4', title: 'Move quote-stripping out of resolvePath; paths should arrive already lexed', status: 'todo' },
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
      { id: '11.1', title: 'Write generate-conformance-fixtures.ps1 to capture real pwsh output for a command corpus', status: 'todo' },
      { id: '11.2', title: 'Normalise machine-specific output (paths, times, pids, widths) before comparison', status: 'todo' },
      { id: '11.3', title: 'Capture Get-Command metadata from real pwsh to validate our manifests', detail: 'Done for 7.6.5 via tools/capture-pwsh-metadata.ps1: 43 commands, 398 declared parameters, with types, parameter sets, positions, pipeline binding and validation attributes. It already proves four 7.7 deltas against the reference implementation — Format-Table -Property carries no attributes in 7.6.5, and -ExcludeProperty and Join-Path -Extension do not exist there.', status: 'done' },
      { id: '11.4', title: 'Record known-differences.yml for deliberate divergences, with a reason for each', status: 'todo' },
      { id: '11.5', title: 'Report per-profile conformance coverage as a number the site can display', status: 'todo' },
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
    status: 'todo',
    dependsOn: [11],
    tasks: [
      { id: '12.1', title: 'Add a command that diffs a script across two profiles', status: 'todo' },
      { id: '12.2', title: 'Show, per difference, whether BrowserShell actually emulates it or merely documents it', status: 'todo' },
      { id: '12.3', title: 'Let the session switch profiles without losing the filesystem', status: 'todo' },
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
      { id: '13.1', title: 'Define the resource schema and registry', status: 'todo' },
      { id: '13.2', title: 'Implement Get/Test/Set with WhatIf planning', detail: 'Model the DSC 3.2 feature set — version pinning, --what-if, map/filter expressions, adapters — and pin the exact DSC version modelled (3.2.3 stable; 3.3.0-rc.2 exists).', status: 'todo' },
      { id: '13.3', title: 'Implement Export/Import of the whole workstation', status: 'todo' },
      { id: '13.4', title: 'Report configuration drift', status: 'todo' },
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
    status: 'todo',
    dependsOn: [10],
    tasks: [
      { id: '14.1', title: 'Define the package manifest with publisher, capabilities and integrity digest', status: 'todo' },
      { id: '14.2', title: 'Verify digests before execution; refuse on mismatch', status: 'todo' },
      { id: '14.3', title: 'Run third-party modules in a sandboxed worker behind a capability broker', status: 'todo' },
      { id: '14.4', title: 'Implement a lockfile and a discovery -> review -> promotion flow', detail: 'Models the actually-shipped PSResourceGet idea: discovery separated from trusted production consumption. Do NOT claim ORAS support — it is explicitly future work upstream.', status: 'todo' },
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
    status: 'todo',
    dependsOn: [8, 14],
    tasks: [
      { id: '15.1', title: 'Generate MCP tool schemas from command manifests', detail: 'No upstream schema to conform to: the team-maintained PowerShell MCP server is a stated 2026 intention with no public code. Define ours from our metadata.', status: 'todo' },
      { id: '15.2', title: 'Classify every command by risk: read / query-external / write / destructive / device / privileged-simulation', status: 'todo' },
      { id: '15.3', title: 'Route AI plans through schema validation, AST validation, capability analysis and WhatIf preview before approval', status: 'todo' },
      { id: '15.4', title: 'Deny the AI direct handles: no OPFS, clipboard, device, package token or storage key', status: 'todo' },
      { id: '15.5', title: 'Audit-log every AI-originated action with its plan and approval', status: 'todo' },
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
    status: 'todo',
    dependsOn: [7],
    tasks: [
      { id: '16.1', title: 'Define TerminalPort with both a semantic DOM and an xterm adapter', status: 'todo' },
      { id: '16.2', title: 'Separate the ANSI parser from plain-text formatting', detail: '7.7 fixes VT Reset sequences appearing mid-string; that only makes sense with a real ANSI parser.', status: 'todo' },
      { id: '16.3', title: 'Use cell width rather than string length everywhere', detail: 'The existing dw() double-width counter is correct and must survive the port; 7.7 also fixes double-width progress rendering.', status: 'todo' },
      { id: '16.4', title: 'Keep the semantic renderer the default and keep aria-live output intact', status: 'todo' },
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
      { id: '17.1', title: 'Define RuntimeAdapter so UI, VFS, AI and terminal never depend on which engine runs', status: 'todo' },
      { id: '17.2', title: 'Generate golden ASTs from real pwsh in CI and validate our parser against them', detail: 'This is the near-term win and needs no WASM at all.', status: 'todo' },
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
    status: 'todo',
    dependsOn: [10, 13],
    tasks: [
      { id: '18.1', title: 'Rebuild the nano/vim editor on the extracted core rather than on global ED state', status: 'todo' },
      { id: '18.2', title: 'File manager over the provider model', status: 'todo' },
      { id: '18.3', title: 'Task manager over the process/job model', status: 'todo' },
      { id: '18.4', title: 'Settings backed by declarative workstation state', status: 'todo' },
    ],
    acceptance: ['The editor no longer reaches back into console internals', 'Apps use providers, not direct filesystem access'],
  },
] as const satisfies readonly WorkItem[];
