/**
 * Format-List — one `Name : value` line per property.
 *
 * Three things it does NOT share with Format-Table, all measured:
 *
 *   - it sizes its label column PER ENTRY, so an object with only `A` prints
 *     `A : 1` even when the next object has a ten-character property name;
 *   - it never truncates. A long value wraps, indented under the value rather
 *     than under the label, and keeps the space it broke at — where the table's
 *     wrapping writer trims that space away;
 *   - it does not apply the table's `ToString("F")` rule to floats, so 1.5
 *     prints as `1.5` here and `1.500` there.
 *
 * Its blank lines differ too: a list's group block ends with a blank of its own,
 * which is why a grouped list shows two blank lines between groups where a
 * grouped table shows one.
 */

import { UNIMPLEMENTED_VIEW_NOTE, VIEW_PARAMETERS, viewCommand } from './common.ts';

export const formatList = viewCommand({
  display: 'Format-List',
  aliases: ['fl'],
  synopsis: 'Formats the output as a list of properties, one per line.',
  view: 'list',
  parameters: [...VIEW_PARAMETERS],
  notes:
    '-Property (including wildcards and calculated properties) and -GroupBy are implemented and ' +
    'measured against pwsh 7.6.5, including the per-entry label width and the wrapping indent. ' +
    UNIMPLEMENTED_VIEW_NOTE,
});
