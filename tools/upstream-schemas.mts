/**
 * upstream-schemas.mts — runtime contracts for the third-party payloads
 * verify-release-truth.mts depends on.
 *
 * Why this exists
 * ---------------
 * `JSON.parse(text) as T` is a lie told to the compiler. TypeScript checks that
 * OUR code is consistent with a shape we declared; it cannot check that GitHub or
 * Microsoft still send that shape. Every `as T` at a network boundary is an
 * unvalidated assumption that silently becomes false when upstream renames a
 * field.
 *
 * That failure is not hypothetical or cosmetic — it is the exact bug this whole
 * project exists to prevent, one level up the stack. Concretely: if .NET renamed
 * `latest-runtime`, then `parseVersion(undefined)` coerces to the string
 * "undefined", fails its regex, returns null, and the caller's `if (!latest)
 * continue` skips the version-lag check. No error, no discrepancy, exit 0. The
 * tool would confidently report everything was fine while having checked nothing.
 *
 * So: validate at the trust boundary, narrow from `unknown`, and treat a shape
 * change as a hard failure rather than a reason to skip a check. These schemas
 * describe ONLY the fields actually consumed — additional properties are allowed,
 * because upstream is free to add fields and that must not break us.
 *
 * A note on what is deliberately NOT required:
 *   - `eol-date` is absent (not null) on preview .NET channels, verified against
 *     the live 11.0 entry. Requiring it would reject valid upstream data.
 *   - `runtime-version` on an SDK entry is optional in the schema but preferred
 *     by the caller, which falls back to the release's runtime version.
 */

import Ajv2020 from 'ajv/dist/2020.js';
import type { ErrorObject, ValidateFunction } from 'ajv';

// ajv is CommonJS; under Node's ESM loader the default import is module.exports,
// which is the constructor, while the NodeNext type view models it as a namespace
// carrying `.default`. Normalise once.
const AjvCtor = ((Ajv2020 as unknown as { default?: unknown }).default ??
  Ajv2020) as unknown as new (opts: Record<string, unknown>) => {
  compile: <T>(schema: object) => ValidateFunction<T>;
};

const ajv = new AjvCtor({ allErrors: true, strict: false });

// ---------------------------------------------------------------------------
// consumed shapes
// ---------------------------------------------------------------------------

/** GitHub Releases list. Only the four fields the verifier reads are required. */
export interface GhRelease {
  tag_name: string;
  draft: boolean;
  prerelease: boolean;
  published_at: string;
  created_at?: string;
}

/**
 * PowerShell/PowerShell master:tools/metadata.json — the project's own statement
 * of which tags occupy which channel.
 *
 * LTSReleaseTag is an ARRAY: more than one LTS is supported concurrently (today
 * v7.4.19 and v7.6.5). It is typed as array-or-string because a single-LTS
 * period is plausible and must not crash the tool.
 *
 * NextReleaseTag names a tag that does NOT yet exist. This file is the richest
 * source of "a version with no release behind it" in the whole pipeline and must
 * never be read as evidence of existence.
 */
export interface PowerShellMetadata {
  StableReleaseTag?: string;
  PreviewReleaseTag?: string;
  ServicingReleaseTag?: string;
  ReleaseTag?: string;
  LTSReleaseTag: string[] | string;
  NextReleaseTag?: string;
}

/**
 * GitHub pull request — the object behind an `upstreamPr:` citation.
 *
 * `merged_at` is null for an open or closed-unmerged PR, so it is the field
 * that distinguishes "this number names a real, merged change" from "this
 * number names something". `merge_commit_sha` can also be null on an open PR,
 * and GitHub sets it to the test-merge commit rather than the merge commit
 * while a PR is open — which is exactly why the caller reads merged_at first.
 */
export interface GhPullRequest {
  number: number;
  title: string;
  state: string;
  merged_at: string | null;
  merge_commit_sha: string | null;
  html_url: string;
}

export interface DotnetIndexEntry {
  'channel-version': string;
  'latest-release': string;
  'latest-runtime': string;
  'latest-sdk': string;
  'release-type': string;
  'support-phase': string;
  'releases.json': string;
  /** Absent on preview channels — verified against the live 11.0 entry. */
  'eol-date'?: string | null;
}

export interface DotnetIndex {
  'releases-index': DotnetIndexEntry[];
}

export interface DotnetSdkEntry {
  version: string;
  /** The authoritative SDK -> runtime link. Preferred over the release runtime. */
  'runtime-version'?: string;
}

export interface DotnetChannelRelease {
  'release-version': string;
  runtime?: { version: string };
  sdk?: DotnetSdkEntry;
  sdks?: DotnetSdkEntry[];
}

export interface DotnetChannelFile {
  'channel-version'?: string;
  releases: DotnetChannelRelease[];
}

// ---------------------------------------------------------------------------
// schemas
// ---------------------------------------------------------------------------

const ghReleaseListSchema = {
  $schema: 'https://json-schema.org/draft/2020-12/schema',
  type: 'array',
  items: {
    type: 'object',
    required: ['tag_name', 'draft', 'prerelease', 'published_at'],
    properties: {
      tag_name: { type: 'string', minLength: 1 },
      draft: { type: 'boolean' },
      prerelease: { type: 'boolean' },
      // Must match the TypeScript interface, which declares `string`. Allowing
      // null here made this module lie in the one place it exists to stop
      // lying: a null sailed through narrow() and then threw a TypeError deep
      // in the report, blamed on "a bug in this file" rather than diagnosed at
      // the trust boundary where it belongs.
      published_at: { type: 'string', minLength: 1 },
      created_at: { type: 'string' },
    },
  },
} as const;

const powerShellMetadataSchema = {
  $schema: 'https://json-schema.org/draft/2020-12/schema',
  type: 'object',
  required: ['LTSReleaseTag'],
  properties: {
    StableReleaseTag: { type: 'string' },
    PreviewReleaseTag: { type: 'string' },
    ServicingReleaseTag: { type: 'string' },
    ReleaseTag: { type: 'string' },
    LTSReleaseTag: {
      oneOf: [
        { type: 'string', minLength: 1 },
        { type: 'array', minItems: 1, items: { type: 'string', minLength: 1 } },
      ],
    },
    NextReleaseTag: { type: 'string' },
  },
} as const;

const ghPullRequestSchema = {
  $schema: 'https://json-schema.org/draft/2020-12/schema',
  type: 'object',
  required: ['number', 'title', 'state', 'merged_at', 'merge_commit_sha', 'html_url'],
  properties: {
    number: { type: 'integer', minimum: 1 },
    title: { type: 'string', minLength: 1 },
    state: { type: 'string', minLength: 1 },
    merged_at: { type: ['string', 'null'] },
    merge_commit_sha: { type: ['string', 'null'] },
    html_url: { type: 'string', minLength: 1 },
  },
} as const;

const dotnetIndexSchema = {
  $schema: 'https://json-schema.org/draft/2020-12/schema',
  type: 'object',
  required: ['releases-index'],
  properties: {
    'releases-index': {
      type: 'array',
      minItems: 1,
      items: {
        type: 'object',
        // eol-date deliberately absent from `required`: preview channels omit it.
        required: [
          'channel-version',
          'latest-release',
          'latest-runtime',
          'latest-sdk',
          'release-type',
          'support-phase',
          'releases.json',
        ],
        properties: {
          'channel-version': { type: 'string', minLength: 1 },
          'latest-release': { type: 'string', minLength: 1 },
          'latest-runtime': { type: 'string', minLength: 1 },
          'latest-sdk': { type: 'string', minLength: 1 },
          'release-type': { type: 'string', minLength: 1 },
          'support-phase': { type: 'string', minLength: 1 },
          'releases.json': { type: 'string', minLength: 1 },
          'eol-date': { type: ['string', 'null'] },
        },
      },
    },
  },
} as const;

const dotnetSdkEntrySchema = {
  type: 'object',
  required: ['version'],
  properties: {
    version: { type: 'string', minLength: 1 },
    'runtime-version': { type: 'string', minLength: 1 },
  },
} as const;

const dotnetChannelFileSchema = {
  $schema: 'https://json-schema.org/draft/2020-12/schema',
  type: 'object',
  required: ['releases'],
  properties: {
    'channel-version': { type: 'string' },
    releases: {
      type: 'array',
      minItems: 1,
      items: {
        type: 'object',
        required: ['release-version'],
        properties: {
          'release-version': { type: 'string', minLength: 1 },
          runtime: {
            type: 'object',
            required: ['version'],
            properties: { version: { type: 'string', minLength: 1 } },
          },
          sdk: dotnetSdkEntrySchema,
          sdks: { type: 'array', items: dotnetSdkEntrySchema },
        },
      },
    },
  },
} as const;

// ---------------------------------------------------------------------------
// validators
// ---------------------------------------------------------------------------

export const VALIDATORS = {
  'github-releases': ajv.compile<GhRelease[]>(ghReleaseListSchema),
  'github-pull-request': ajv.compile<GhPullRequest>(ghPullRequestSchema),
  'powershell-metadata': ajv.compile<PowerShellMetadata>(powerShellMetadataSchema),
  'dotnet-index': ajv.compile<DotnetIndex>(dotnetIndexSchema),
  'dotnet-channel': ajv.compile<DotnetChannelFile>(dotnetChannelFileSchema),
} as const;

export type UpstreamShape = keyof typeof VALIDATORS;

export function describeErrors(errors: readonly ErrorObject[] | null | undefined): string {
  return (errors ?? [])
    .slice(0, 8)
    .map((e) => `    ${e.instancePath || '/'} ${e.message ?? 'invalid'}`)
    .join('\n');
}

/**
 * Narrow an untrusted payload to a consumed shape, or explain precisely why it
 * cannot be narrowed. Returns a discriminated result rather than throwing, so
 * the caller decides the failure mode.
 */
export function narrow<K extends UpstreamShape>(
  shape: K,
  data: unknown,
):
  | { ok: true; value: (typeof VALIDATORS)[K] extends ValidateFunction<infer T> ? T : never }
  | { ok: false; problem: string } {
  const validate = VALIDATORS[shape] as ValidateFunction<unknown>;
  if (validate(data)) {
    return {
      ok: true,
      value: data as (typeof VALIDATORS)[K] extends ValidateFunction<infer T> ? T : never,
    };
  }
  return {
    ok: false,
    problem: `payload does not match the expected "${shape}" shape:\n${describeErrors(validate.errors)}`,
  };
}
