/**
 * Out-String — where objects finally become text.
 *
 * WHAT IT DOES THAT "JUST LETTING IT RENDER" DOES NOT
 *
 * Nothing, to the text — and that is the point. `$x | Out-String` produces
 * exactly the characters the host would have shown, which is why it is the
 * honest place to test the formatter. What changes is the TYPE: the result is a
 * `System.String` back on the pipeline instead of ink on a terminal, so it can
 * be matched, split, or written to a file.
 *
 *   pwsh: ($two | Out-String).GetType().FullName          System.String
 *   pwsh: ($two | Out-String).Length                      64
 *   pwsh: ($two | Out-String -Stream).Count               7
 *
 * `-Stream` is the difference that matters: without it the whole rendering is
 * ONE string with a terminator after every line, including the last. With it,
 * each line is a separate object and no terminators appear at all. The seven
 * against the sixty-four above is the same table counted both ways.
 *
 * `-NoNewline` is a third thing again: the lines are concatenated with nothing
 * between them, so `'a','b' | Out-String -NoNewline` is `ab`, not `a\nb`.
 *
 * THE WIDTH IS DECIDED HERE, NOT IN Format-Table. That is why the two stages
 * are split: `Format-Table -Wrap | Out-String -Width 30` lays out at 30 columns
 * and the identical Format-Table output lays out differently at 120. Measured
 * both ways.
 *
 * An empty stream still produces a String — `(@() | Out-String).Length` is 0 and
 * its type is System.String, not $null.
 */

import { DEFAULT_RENDER_WIDTH, MIN_OUT_STRING_WIDTH } from '../../formatting/render.ts';
import { recordDocument } from '../../formatting/records.ts';
import { renderDocument, type FormatSection } from '../../formatting/views.ts';
import { throwIfCancelled } from '../../pipeline/pipeline.ts';
import { errorRecord } from '../../pipeline/streams.ts';
import type { PSValue } from '../../pipeline/psobject.ts';
import type { BindingResult, CommandModule, InvocationContext } from '../invocation.ts';
import { INT, OBJECT, SWITCH, manifest, numberValue, parameter, switchValue } from '../powershell/support.ts';
import { buildDefaultDocument } from './build.ts';
import { cultureFor } from './common.ts';

/**
 * The line terminator.
 *
 * LF, not the CRLF the capture machine emits. The conformance harness has a
 * `line-endings` normalisation rule for precisely this reason — "the capture
 * host is Windows and emits CRLF; the compatibility profile targets Linux and
 * the runtime is a browser" — so producing CRLF here would be wrong on both
 * targets this engine actually runs on.
 */
export const NEWLINE = '\n';

const COMMAND = 'Microsoft.PowerShell.Commands.OutStringCommand';

/**
 * Render a stream to lines: the reusable half of this command, so a test or a
 * host renderer can call it without going through the binder.
 */
export function renderStream(
  values: readonly PSValue[],
  width: number,
  context: InvocationContext,
): string[] {
  const culture = cultureFor(context);
  const sections: FormatSection[] = [];
  let pending: PSValue[] = [];

  const flush = (): void => {
    if (pending.length === 0) return;
    sections.push(...buildDefaultDocument(pending, culture).sections);
    pending = [];
  };

  for (const value of values) {
    const document = recordDocument(value);
    if (document === undefined) {
      pending.push(value);
      continue;
    }
    flush();
    sections.push(...document.sections);
  }
  flush();

  return renderDocument({ sections }, { width, culture });
}

const OUT_STRING_MANIFEST = manifest({
  display: 'Out-String',
  synopsis: 'Sends objects to the host as a series of strings.',
  notes:
    '-Stream, -NoNewline and -Width are implemented. -Width defaults to 120, which is what a ' +
    'redirected pwsh reports for the console width and what the conformance capture ran at; ' +
    'the host terminal is not consulted, so a test cannot depend on the window it runs in. ' +
    'Lines are terminated with LF rather than the capture host\'s CRLF, matching the ' +
    "harness's own line-endings normalisation rule.",
  parameters: [
    parameter('InputObject', OBJECT, { valueFromPipeline: true }),
    parameter('Stream', SWITCH),
    parameter('NoNewline', SWITCH),
    parameter('Width', INT, { validation: ['ValidateRangeAttribute'] }),
  ],
  outputTypeNames: ['System.String'],
});

export const outString: CommandModule = {
  manifest: OUT_STRING_MANIFEST,

  async invoke(context: InvocationContext, bound: BindingResult): Promise<number> {
    const requested = numberValue(bound.parameters, 'Width');
    if (requested !== undefined && requested < MIN_OUT_STRING_WIDTH) {
      // pwsh rejects this in the binder, via ValidateRange. Reported here too so
      // a caller that bypasses the binder still cannot render at width 1, which
      // would silently produce a table with no content.
      await context.streams.error.write(
        errorRecord(
          `Cannot validate argument on parameter 'Width'. The ${requested} argument is less than ` +
            `the minimum allowed range of ${MIN_OUT_STRING_WIDTH}. Supply an argument that is ` +
            `greater than or equal to ${MIN_OUT_STRING_WIDTH} and then try the command again.`,
          'ParameterArgumentValidationError',
          COMMAND,
          'InvalidData',
          { exceptionType: 'System.Management.Automation.ParameterBindingException' },
        ),
      );
      return 1;
    }

    const width = requested ?? DEFAULT_RENDER_WIDTH;
    const values: PSValue[] = [];
    for await (const item of context.input) {
      throwIfCancelled(context.signal, 'Out-String');
      values.push(item);
    }

    const lines = renderStream(values, width, context);
    const sink = context.streams.success;

    if (switchValue(bound.parameters, 'Stream')) {
      for (const line of lines) {
        if (sink.closed || context.signal.aborted) return 0;
        await sink.write(line);
      }
      return 0;
    }

    const noNewline = switchValue(bound.parameters, 'NoNewline');
    await sink.write(noNewline ? lines.join('') : lines.map((line) => line + NEWLINE).join(''));
    return 0;
  },
};
