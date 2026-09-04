/**
 * simulated-harness.mts — running a simulated command the way the kernel would.
 *
 * The point of the harness is that it does NOT stub the capability broker. A
 * test whose `requireCapability` is `() => {}` proves the command printed the
 * right thing and nothing at all about what it was allowed to touch, which is
 * the half that matters most for this family of commands. So every run here
 * goes through a real `CapabilityBroker` with a real `VirtualPolicy` and a real
 * `AuditLog`, and the harness additionally records every capability the command
 * asked for — including the ones the broker does not audit, because
 * `process.read` granted on a `read`-risk command leaves no audit line and the
 * test still needs to see that it was requested.
 */

import { collectingStreams } from '../../src/pipeline/streams.ts';
import type { ErrorRecord } from '../../src/pipeline/streams.ts';
import { collectPipeline, commandStage, noInput } from '../../src/pipeline/pipeline.ts';
import type { PipelineHost } from '../../src/pipeline/pipeline.ts';
import type { PSValue } from '../../src/pipeline/psobject.ts';
import type {
  BindingResult,
  BoundParameters,
  CommandModule,
} from '../../src/commands/invocation.ts';
import type { Capability } from '../../src/commands/manifest.ts';
import { AuditLog, CapabilityBroker, VirtualPolicy } from '../../src/kernel/capabilities.ts';

const TEST_PID = 42;

export interface RunResult {
  /** Everything written to stream 1, as objects. */
  readonly values: readonly PSValue[];
  /** The string values, which is what the text commands emit. */
  readonly lines: readonly string[];
  readonly errors: readonly ErrorRecord[];
  /** The messages only — what v1 would have shown as `err` rows. */
  readonly errorMessages: readonly string[];
  /** Stream 3. Where a parameter that bound but could do nothing is reported. */
  readonly warnings: readonly string[];
  readonly exitCode: number;
  /** Every capability requested, in order, granted or not. */
  readonly requested: readonly Capability[];
}

export interface RunOptions {
  /** Tokens after the command name. Becomes `BindingResult.remaining`. */
  readonly args?: readonly string[];
  /** Already-bound parameters, for the two commands that declare any. */
  readonly parameters?: BoundParameters;
  readonly parameterSet?: string;
}

export class Session {
  readonly broker: CapabilityBroker;
  readonly policy: VirtualPolicy;
  readonly audit: AuditLog;

  constructor(options: { readonly grants?: Iterable<Capability>; readonly elevated?: boolean } = {}) {
    this.policy = new VirtualPolicy();
    this.audit = new AuditLog();
    this.broker = new CapabilityBroker({
      grants: options.grants ?? [],
      policy: this.policy,
      audit: this.audit,
      // A fixed clock, so an audit record is comparable between runs.
      clock: () => 0,
    });
    if (options.elevated === true) this.policy.elevate();
  }

  async run(module: CommandModule, options: RunOptions = {}): Promise<RunResult> {
    const streams = collectingStreams();
    const scoped = this.broker.forCommand(module.manifest, TEST_PID);
    const requested: Capability[] = [];

    const host: PipelineHost = {
      profile: {
        displayVersion: '7.6.5',
        behavior: <T extends boolean | number | string>(_key: string, fallback: T): T => fallback,
      },
      streams,
      native: null,
      cwd: '/home/thc1006',
      env: new Map<string, string>(),
      signal: new AbortController().signal,
      requireCapability: (capability: Capability): void => {
        requested.push(capability);
        scoped.require(capability);
      },
    };

    const bound: BindingResult = {
      parameters: options.parameters ?? {},
      parameterSet: options.parameterSet ?? '__AllParameterSets',
      remaining: options.args ?? [],
    };

    const stage = commandStage(module, bound);
    const values = await collectPipeline(noInput(), [stage], host);
    const errors = streams.collected.error.values;

    return {
      values,
      lines: values.filter((value): value is string => typeof value === 'string'),
      errors,
      errorMessages: errors.map((record) => record.message),
      warnings: streams.collected.warning.values,
      exitCode: stage.exitCode,
      requested,
    };
  }
}

/**
 * A session that grants everything any simulated command declares.
 *
 * Deliberately the permissive one for the parity tests: a command failing
 * because a capability was withheld would look like a formatting difference,
 * and the capability behaviour is asserted separately where it can be seen.
 */
export function grantedSession(): Session {
  return new Session({ grants: ['process.read', 'portfolio.read', 'virtual.policy.elevate'] });
}

export function moduleNamed(
  modules: readonly CommandModule[],
  name: string,
): CommandModule {
  const found = modules.find((module) => module.manifest.name === name);
  if (found === undefined) throw new Error(`no simulated command named '${name}'`);
  return found;
}
