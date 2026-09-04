/**
 * Format-Wide — one property, many columns.
 *
 * The geometry is arithmetic nobody would guess and it was read back by
 * recording the character position of every item at seven terminal widths
 * against two, three and four columns. The column widths sum to `width + 1`,
 * and the surplus goes to the leftmost columns one at a time: at 120 columns,
 * two columns are 61 and 60, three are 41/40/40, four are 31/30/30/30. See
 * `wideWidths` in views.ts.
 *
 * The DEFAULT is two columns however narrow the items are. That surprised the
 * implementation — a content-driven count looks obviously right — but a stream
 * of two-character values still lays out two per line at 120 columns. Only
 * `-AutoSize` packs them.
 *
 * A KNOWN DIVERGENCE, recorded rather than reproduced: pwsh's `-GroupBy` output
 * emits the blank line that closes a group BEFORE the group's last partial row
 * rather than after it, so groups holding a single item print
 * `label, '', '', row` while the final group prints `label, '', row`. That is
 * a flush-ordering artefact in the reference implementation's wide writer, it is
 * not self-consistent between groups, and reproducing it would mean encoding a
 * bug as a rule. This emits `label, '', row` for every group.
 */

import type { BindingResult, InvocationContext } from '../invocation.ts';
import { INT, SWITCH, numberValue, parameter } from '../powershell/support.ts';
import { UNIMPLEMENTED_VIEW_NOTE, VIEW_PARAMETERS, switchValue, viewCommand } from './common.ts';

export const formatWide = viewCommand({
  display: 'Format-Wide',
  aliases: ['fw'],
  synopsis: 'Formats objects as a wide table showing one property per object.',
  view: 'wide',
  parameters: [...VIEW_PARAMETERS, parameter('AutoSize', SWITCH), parameter('Column', INT)],
  notes:
    '-Property, -Column, -AutoSize and -GroupBy are implemented; the column arithmetic was ' +
    'measured at seven widths. The -GroupBy blank-line order diverges from pwsh deliberately: ' +
    "the reference implementation flushes a group's last partial row after the blank line that " +
    'closes the group, inconsistently between groups, and that is reproduced as the consistent ' +
    'order instead. ' +
    UNIMPLEMENTED_VIEW_NOTE,
  options: (_context: InvocationContext, bound: BindingResult) => {
    const column = numberValue(bound.parameters, 'Column');
    return {
      columns: column === undefined ? null : column,
      autoSize: switchValue(bound.parameters, 'AutoSize'),
    };
  },
});
