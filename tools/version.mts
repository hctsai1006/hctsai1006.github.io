/**
 * version.mts — comparing PowerShell and .NET version strings correctly.
 *
 * Extracted from the release verifier so it can be tested in isolation, because
 * every bug this module has had was silent and produced a confident wrong answer.
 *
 * Three things make naive comparison wrong:
 *
 *   1. String order is not version order. "preview.10" sorts before "preview.6".
 *
 *   2. `rc` outranks `preview`, and folding them together is not a rounding
 *      error. PowerShell ships an rc before every GA (v7.6.0-rc.1, v7.5.0-rc.1,
 *      v7.4.0-rc.1, v7.3.0-rc.1). If rc and preview share a rank, 7.6.0-rc.1
 *      compares as OLDER than 7.6.0-preview.4 — during exactly the window when
 *      "what is the latest PowerShell" is genuinely in flux.
 *
 *   3. Build metadata participates. Two builds of the same preview are ordered
 *      by their trailing build components: 11.0.0-preview.6.26359.118.
 *
 * And one thing that is NOT a version comparison at all: SDK feature bands.
 * .NET release 10.0.11 ships SDKs 10.0.400, 10.0.303 and 10.0.111 at the same
 * time, all carrying runtime-version 10.0.11. The 4xx/3xx/1xx bands are
 * parallel, independently-serviced trains of one runtime. Ordering them with
 * `<` produces the false statement "10.0.303 is behind 10.0.400".
 */

export type PreKind = 'preview' | 'rc';

/** preview < rc < stable. A stable release outranks any pre-release of the triple. */
const PRE_RANK: Record<PreKind, number> = { preview: 0, rc: 1 };
const STABLE_RANK = 2;

export interface ParsedVersion {
  major: number;
  minor: number;
  patch: number;
  pre: { kind: PreKind; n: number } | null;
  /** Trailing build components, compared numerically, e.g. [26359, 118]. */
  build: number[];
  raw: string;
}

/**
 * Parse a PowerShell or .NET version. Returns null rather than throwing or
 * guessing: callers must decide what an unparseable version means, and none of
 * them may treat it as "probably fine".
 */
export function parseVersion(v: string | null | undefined): ParsedVersion | null {
  if (typeof v !== 'string') return null;
  // 11.0.100-preview.6.26359.118 | 7.7.0-preview.4 | 7.6.0-rc.1 | 10.0.303 | 7.6.5
  //
  // The build group is `\d+(?:\.\d+)*`, not `\d[\d.]*`: the looser form accepts
  // trailing and doubled dots, and because Number('') === 0 they parsed as real
  // components. "1.2.3.4.." became build [4,0,0] instead of null, which
  // contradicts this function's contract of returning null rather than guessing.
  const m = /^(\d+)\.(\d+)\.(\d+)(?:-(preview|rc)\.(\d+))?(?:\.(\d+(?:\.\d+)*))?$/.exec(v);
  if (m === null) return null;
  const [, ma, mi, pa, kind, num, bd] = m;
  if (ma === undefined || mi === undefined || pa === undefined) return null;
  return {
    major: Number(ma),
    minor: Number(mi),
    patch: Number(pa),
    pre:
      kind === undefined || num === undefined
        ? null
        : { kind: kind as PreKind, n: Number(num) },
    build: bd === undefined ? [] : bd.split('.').map(Number),
    raw: v,
  };
}

export const rankOf = (p: ParsedVersion): number =>
  p.pre === null ? STABLE_RANK : PRE_RANK[p.pre.kind];

/** -1 if a < b, 0 if equal, 1 if a > b. */
export function compareVersions(a: ParsedVersion, b: ParsedVersion): number {
  for (const k of ['major', 'minor', 'patch'] as const) {
    if (a[k] !== b[k]) return a[k] < b[k] ? -1 : 1;
  }
  const ra = rankOf(a);
  const rb = rankOf(b);
  if (ra !== rb) return ra < rb ? -1 : 1;
  if (a.pre !== null && b.pre !== null && a.pre.n !== b.pre.n) {
    return a.pre.n < b.pre.n ? -1 : 1;
  }
  const n = Math.max(a.build.length, b.build.length);
  for (let i = 0; i < n; i++) {
    const x = a.build[i] ?? 0;
    const y = b.build[i] ?? 0;
    if (x !== y) return x < y ? -1 : 1;
  }
  return 0;
}

/**
 * SDK feature band, e.g. "3xx". Recorded for display; NEVER ordered — see the
 * header note. Returns null for anything unparseable.
 */
export function featureBand(sdk: string): string | null {
  const p = parseVersion(sdk);
  return p === null ? null : `${Math.floor(p.patch / 100)}xx`;
}

/**
 * Do two version strings refer to the same version, allowing one to be an
 * abbreviation of the other?
 *
 * Documentation abbreviates: "11.0.100-preview.6" for the SDK
 * "11.0.100-preview.6.26359.118". So a component-wise prefix counts as agreement.
 * But the pre-release KIND must match exactly — accepting "-rc.2" as agreeing
 * with "-preview.2" would suppress a genuine mismatch between two different
 * .NET releases.
 */
export function versionsAgree(a: string, b: string): boolean {
  if (a === b) return true;
  const pa = parseVersion(a);
  const pb = parseVersion(b);
  if (pa === null || pb === null) return false;
  if (pa.major !== pb.major || pa.minor !== pb.minor || pa.patch !== pb.patch) return false;
  if (pa.pre?.kind !== pb.pre?.kind) return false;
  if (pa.pre?.n !== pb.pre?.n) return false;
  const n = Math.min(pa.build.length, pb.build.length);
  for (let i = 0; i < n; i++) if (pa.build[i] !== pb.build[i]) return false;
  return true;
}

/**
 * Codepoint ordering. Deliberately not localeCompare: its result is
 * locale-dependent, and it feeds both a content hash and a drift comparison, so
 * a machine with different ICU collation could produce a different lockfile from
 * identical upstream data.
 */
export const byCodepoint = (a: string, b: string): number => (a < b ? -1 : a > b ? 1 : 0);
