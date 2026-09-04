/**
 * Format-Table — the view everything defaults to.
 *
 * WHAT THE PROBE CORRECTED, in the order the mistakes would have been made:
 *
 * 1. IT BUFFERS. Column widths come from every object in the stream, not from
 *    the first. Twenty-one narrow rows followed by a wide one still produce a
 *    wide column, at 30 objects and at 1000, WITHOUT -AutoSize.
 *
 * 2. -AutoSize DID NOTHING on every input tried. That is not a claim that it is
 *    a no-op in general — it exists to override the widths declared in a type's
 *    format data, and nothing here has format data — but the manifest says so
 *    rather than pretending the switch is implemented.
 *
 * 3. A FLOATING-POINT CELL IS `ToString("F")`, so 1.5 prints as 1.500 under
 *    en-US. Format-List prints 1.5 for the same value. See render.ts.
 *
 * 4. -Wrap WORD-WRAPS, and the algorithm is not the textbook one. See
 *    `wrapText` in render.ts for the four measurements that pin it down.
 */

import type { BindingResult, InvocationContext } from '../invocation.ts';
import { SWITCH, parameter } from '../powershell/support.ts';
import { UNIMPLEMENTED_VIEW_NOTE, VIEW_PARAMETERS, switchValue, viewCommand } from './common.ts';

export const formatTable = viewCommand({
  display: 'Format-Table',
  aliases: ['ft'],
  synopsis: 'Formats the output as a table.',
  view: 'table',
  parameters: [
    ...VIEW_PARAMETERS,
    parameter('AutoSize', SWITCH),
    parameter('HideTableHeaders', SWITCH),
    parameter('Wrap', SWITCH),
    parameter('RepeatHeader', SWITCH),
  ],
  notes:
    '-Property (including wildcards and calculated properties), -GroupBy, -HideTableHeaders and ' +
    '-Wrap are implemented and measured against pwsh 7.6.5, including the header/underline ' +
    'padding asymmetry and the last-column rule. -AutoSize is accepted and changes nothing, ' +
    'because widths already come from the whole stream — the switch exists upstream to override ' +
    'widths declared in format data, which this engine has none of. -RepeatHeader is not ' +
    'implemented: it repeats the header per screenful, which needs a pager this host does not ' +
    'have. ' +
    UNIMPLEMENTED_VIEW_NOTE,
  options: (_context: InvocationContext, bound: BindingResult) => ({
    hideHeaders: switchValue(bound.parameters, 'HideTableHeaders'),
    wrap: switchValue(bound.parameters, 'Wrap'),
    autoSize: switchValue(bound.parameters, 'AutoSize'),
  }),
});
