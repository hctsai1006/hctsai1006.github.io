/**
 * Every expectation here was read off pwsh 7.6.5, under en-US, de-DE and zh-TW
 * where culture could plausibly matter. The probe output is quoted beside each
 * case so a future change has to argue with the reference implementation rather
 * than with an opinion.
 */

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

import { toPSString, DEFAULT_OFS } from '../../src/formatting/to-string.ts';
import { INVARIANT } from '../../src/formatting/culture.ts';
import { formatGeneral } from '../../src/formatting/numeric.ts';
import { formatOperator } from '../../src/formatting/format-operator.ts';
import { cellText } from '../../src/formatting/render.ts';
import { compareForSorting, getProperty, psObject, psWrap } from '../../src/pipeline/psobject.ts';
import type { PSValue } from '../../src/pipeline/psobject.ts';

/**
 * These used to call a `formatDouble` exported from psobject.ts. It is gone —
 * it was a second G15 that disagreed with `formatGeneral` on three of forty
 * doubles — so the same cases now go through the public conversion, which is
 * where every caller actually meets it.
 */
describe('doubles use .NET G15, not JavaScript round-trip', () => {
  // This is the case that makes the whole file necessary: String(0.1 + 0.2) is
  // 0.30000000000000004 in JavaScript and 0.3 in PowerShell.
  it('0.1 + 0.2 prints as 0.3', () => {
    assert.equal(toPSString(0.1 + 0.2), '0.3');
    assert.notEqual(String(0.1 + 0.2), '0.3');
  });

  it('1/3 keeps fifteen significant digits, not seventeen', () => {
    assert.equal(toPSString(1 / 3), '0.333333333333333');
  });

  it('a whole double loses its point', () => {
    assert.equal(toPSString(1.0), '1');
    assert.equal(toPSString(-2.0), '-2');
  });

  it('goes exponential where .NET does, in .NET notation', () => {
    assert.equal(toPSString(1e21), '1E+21');
  });

  it('names the non-finite values the way .NET does', () => {
    assert.equal(toPSString(NaN), 'NaN');
    assert.equal(toPSString(Infinity), 'Infinity');
    assert.equal(toPSString(-Infinity), '-Infinity');
  });

  it('keeps ordinary decimals intact', () => {
    assert.equal(toPSString(1.5), '1.5');
    assert.equal(toPSString(1234.5), '1234.5');
  });

  it('switches to exponential at 1e-5, not 1e-6', () => {
    // pwsh 7.6.5 on LINUX (docker pwsh-linux:7.6.5, .NET 10.0.11):
    //   "$(0.0001)"   0.0001
    //   "$(0.00001)"  1E-05
    //   "$(0.000001)" 1E-06
    // The deleted formatDouble answered `0.00001` for the middle one, because
    // its threshold was `exponent < -5` where .NET's is `< -4`.
    assert.equal(toPSString(0.0001), '0.0001');
    assert.equal(toPSString(0.00001), '1E-05');
    assert.equal(toPSString(0.000001), '1E-06');
  });

  it('keeps the sign on negative zero', () => {
    // pwsh 7.6.5 on LINUX: "$([double]::NegativeZero)" is -0, not 0.
    assert.equal(toPSString(-0), '-0');
    assert.equal(toPSString(0), '0');
  });

  it('is the same function the formatter uses for G15', () => {
    // One implementation, asserted rather than hoped for. `"$x"` IS
    // ToString("G15", InvariantCulture); if these ever diverge, one of them is
    // a second engine again.
    for (const value of [0.1 + 0.2, 1 / 3, 1e21, 0.00001, -0, 1234.5, NaN, -Infinity]) {
      assert.equal(toPSString(value), formatGeneral(value, 15, INVARIANT, true));
    }
  });
});

describe('"$x" — the culture-invariant conversion', () => {
  it('turns $null into an empty string, not "null"', () => {
    assert.equal(toPSString(null), '');
  });

  it('capitalises booleans', () => {
    // pwsh: "$true" => True
    assert.equal(toPSString(true), 'True');
    assert.equal(toPSString(false), 'False');
  });

  it('joins an array with $OFS, defaulting to a space', () => {
    // pwsh: "$(@(1,2,3))" => 1 2 3
    assert.equal(toPSString([1, 2, 3]), '1 2 3');
    assert.equal(DEFAULT_OFS, ' ');
  });

  it('honours a changed $OFS', () => {
    // pwsh: $OFS = '-'; "$(@(1,2,3))" => 1-2-3
    assert.equal(toPSString([1, 2, 3], '-'), '1-2-3');
  });

  it('gives an empty array an empty string', () => {
    // pwsh: "[$(@())]" => []
    assert.equal(toPSString([]), '');
  });

  it('keeps the separator around a null element', () => {
    // pwsh: "$(@($null,1))" => " 1" — the null becomes "", the space remains
    assert.equal(toPSString([null, 1]), ' 1');
  });

  it('prints a PSCustomObject as @{...}', () => {
    // pwsh: "$([pscustomobject]@{a=1})" => @{a=1}
    assert.equal(toPSString(psObject({ a: 1 })), '@{a=1}');
  });

  it('gives an empty PSCustomObject an empty string, not @{}', () => {
    // pwsh: $e = [pscustomobject]@{}; "$e".Length  =>  0
    assert.equal(toPSString(psObject({})), '');
  });

  it('prints a wrapped host type as its type name, never as a property bag', () => {
    // `@{...}` is the shape pwsh reserves for a PSCustomObject. It never
    // produces it for anything else, so a Version rendering as
    // `@{Major=1; Minor=2}` was wrong in a way that could be mistaken for a
    // hashtable literal. Measured:
    //   "$PSVersionTable"  =>  System.Management.Automation.PSVersionHashTable
    //   "$(@{a=1})"        =>  System.Collections.Hashtable
    //   "$([ordered]@{a=1})" => System.Collections.Specialized.OrderedDictionary
    assert.equal(
      toPSString(psObject({ PSVersion: '7.6.5' }, [
        'System.Management.Automation.PSVersionHashTable',
        'System.Collections.Hashtable',
        'System.Object',
      ])),
      'System.Management.Automation.PSVersionHashTable',
    );
    // The residual gap, asserted so it is visible rather than assumed: pwsh
    // prints `1.2.3` for a Version and `01:30:00` for a TimeSpan, because it
    // has the host type's ToString and this does not. `versionText` and
    // `timeSpanText` exist for the formatter, which is where that belongs.
    assert.equal(
      toPSString(psWrap({ Major: 1, Minor: 2, Build: 3 }, ['System.Version', 'System.Object'], null)),
      'System.Version',
    );
  });

  it('unravels exactly one level, as pwsh does', () => {
    // This test previously asserted `'1 2 3'` under the title "recurses into
    // nested values" — the one claim in this file with no probe output beside
    // it, and the one that was wrong. Measured on pwsh 7.6.5:
    //
    //   $j = New-Object 'object[]' 2; $j[0] = @(1,2); $j[1] = 3
    //   "$j"                      =>  System.Object[] 3
    //   $j2[0] = 1; $j2[1] = @(2,3)
    //   "$j2"                     =>  1 System.Object[]
    //
    // An inner collection reports its .NET type; it is not joined a second
    // time. Nothing constructs a jagged array by writing `@(@(1,2),3)` in
    // PowerShell — that flattens — which is why the wrong answer survived.
    assert.equal(toPSString([[1, 2], 3]), 'System.Object[] 3');
    assert.equal(toPSString([1, [2, 3]]), '1 System.Object[]');
    // $OFS applies to the level that unravels and to nothing below it.
    // pwsh: $OFS = '-'; "$j"  =>  System.Object[]-3
    assert.equal(toPSString([[1, 2], 3], '-'), 'System.Object[]-3');
  });

  it('passes a string through unchanged', () => {
    assert.equal(toPSString('already text'), 'already text');
  });

  it('flattens bytes the same way as any other array', () => {
    // pwsh: "$([byte[]](1,2))" => 1 2
    assert.equal(toPSString(new Uint8Array([1, 2])), '1 2');
  });

  it('formats a date in the invariant form', () => {
    // pwsh: "$(Get-Date '2020-03-04T05:06:07')" => 03/04/2020 05:06:07
    assert.equal(toPSString(new Date(2020, 2, 4, 5, 6, 7)), '03/04/2020 05:06:07');
  });
});

// ---------------------------------------------------------------------------
// cycles
// ---------------------------------------------------------------------------

/**
 * THE ATTACK. Before the one-level rule, every case below threw
 *
 *     RangeError: Maximum call stack size exceeded
 *
 * from `toPSString`, and with it from `-f`, from Sort-Object's fallback, from
 * Format-Table's cell text and from anything else that turns a value into a
 * string. A cycle is not exotic: any parent/child or sibling link makes one,
 * `structuredClone` supports cycles, so nothing upstream rejects them, and the
 * value need only reach a renderer once.
 *
 * pwsh does not have the problem because it does not recurse, so this asserts
 * the reference implementation's OUTPUT rather than merely "does not throw".
 * Every expectation was read off pwsh 7.6.5.
 */
describe('a cyclic object renders instead of exhausting the stack', () => {
  /** `$c = [pscustomobject]@{n=1}; $c | Add-Member NoteProperty self $c` */
  function selfReferencing(): PSValue {
    const c = psObject({ n: 1 }) as { properties: Record<string, PSValue> };
    c.properties['self'] = c as unknown as PSValue;
    return c as unknown as PSValue;
  }

  it('renders a self-referencing object one level deep', () => {
    // pwsh: "$c"              =>  @{n=1; self=}
    // pwsh: "$($c.self)"      =>  @{n=1; self=}
    // pwsh: "$($c.self.self)" =>  @{n=1; self=}
    const c = selfReferencing();
    assert.equal(toPSString(c), '@{n=1; self=}');
    assert.equal(toPSString(getProperty(c, 'self') as PSValue), '@{n=1; self=}');
  });

  it('renders a two-object cycle', () => {
    // pwsh: $a = [pscustomobject]@{name='A'}; $b = [pscustomobject]@{name='B'}
    //       $a | Add-Member NoteProperty peer $b
    //       $b | Add-Member NoteProperty peer $a
    //       "$a"  =>  @{name=A; peer=}
    const a = psObject({ name: 'A' }) as { properties: Record<string, PSValue> };
    const b = psObject({ name: 'B' }) as { properties: Record<string, PSValue> };
    a.properties['peer'] = b as unknown as PSValue;
    b.properties['peer'] = a as unknown as PSValue;
    assert.equal(toPSString(a as unknown as PSValue), '@{name=A; peer=}');
    assert.equal(toPSString(b as unknown as PSValue), '@{name=B; peer=}');
  });

  it('renders a self-referencing array', () => {
    // pwsh: $oa = New-Object 'object[]' 2; $oa[0] = 1; $oa[1] = $oa
    //       "$oa"  =>  1 System.Object[]
    const oa: PSValue[] = [1];
    oa.push(oa as unknown as PSValue);
    assert.equal(toPSString(oa), '1 System.Object[]');
  });

  it('renders a cycle that runs through an array and back', () => {
    // pwsh: $cy = New-Object 'object[]' 2
    //       $op = [pscustomobject]@{ back = $cy }; $cy[0] = $op; $cy[1] = 1
    //       "$cy"  =>  " 1"                        (the object slot is empty)
    //       "$op"  =>  @{back=System.Object[]}
    const cy: PSValue[] = [];
    const op = psObject({ back: cy });
    cy.push(op, 1);
    assert.equal(toPSString(cy), ' 1');
    assert.equal(toPSString(op), '@{back=System.Object[]}');
  });

  it('renders a deep non-cyclic chain the same way, so no depth limit is needed', () => {
    // pwsh: 60 nested [pscustomobject]s  =>  @{v=1; down=}
    // The chain and the cycle produce the same text because neither recurses.
    let node: PSValue = psObject({ v: 60 });
    for (let i = 59; i >= 1; i -= 1) node = psObject({ v: i, down: node });
    assert.equal(toPSString(node), '@{v=1; down=}');
  });

  it('survives a cycle everywhere a value becomes text', () => {
    // The RangeError was not confined to `"$x"`: these are the other callers.
    const c = selfReferencing();
    // pwsh: "{0}" -f $c            =>  @{n=1; self=}
    assert.equal(formatOperator('{0}', [c], INVARIANT), '@{n=1; self=}');
    // pwsh: ($c | Format-Table | Out-String) cell  =>  @{n=1; self=}
    assert.equal(cellText(c), '@{n=1; self=}');
    // pwsh: @($c,'a') | Sort-Object  =>  the object first, then 'a'
    assert.doesNotThrow(() => compareForSorting(c, 'a'));
  });
});
