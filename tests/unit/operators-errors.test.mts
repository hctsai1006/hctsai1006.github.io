/**
 * The ErrorRecords the operators produce, and the unary/type operators.
 *
 * Two conformance corpus cases depend on this file's records:
 *
 *   error.divide-by-zero   1 / 0        FullyQualifiedErrorId = RuntimeException
 *   error.method-on-null   $null.Foo()  FullyQualifiedErrorId = InvokeMethodOnNull
 *
 * Both are ENGINE errors: the id stands alone, with no `,<CommandName>` suffix,
 * which is why they are built directly rather than through `errorRecord()` in
 * streams.ts. That composer is right for a cmdlet and wrong here, and the
 * difference is measurable — see the first suite.
 *
 * Predictions that were wrong and are tested as such:
 *
 *   P35/P52  right about the message, wrong about the CATEGORY: `1 / 0` is
 *            NotSpecified, not InvalidOperation
 *   "the same bad regex gives the same error"  — `-replace` wraps it and
 *            `-match`/`-split` do not, so the ids differ
 *   P18      `[!a]` negates (tested in operators-strings)
 */

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

import {
  arithmetic,
  asOperator,
  divideByZeroError,
  invokeMethod,
  isOperator,
  matchOperator,
  methodOnNullError,
  notOperator,
  PSRuntimeError,
  replaceOperator,
  resolveTypeName,
} from '../../src/operators/index.ts';
import { errorRecord, type ErrorRecord } from '../../src/pipeline/streams.ts';
import { psObject } from '../../src/pipeline/psobject.ts';

// ---------------------------------------------------------------------------
// the two corpus errors
// ---------------------------------------------------------------------------

describe('operator failures produce real ErrorRecords, not bare JavaScript Errors', () => {
  it('1 / 0 matches the fixture exactly', () => {
    // pwsh: 1 / 0
    //   FullyQualifiedErrorId : RuntimeException
    //   CategoryInfo.Category : NotSpecified
    //   CategoryInfo.Reason   : RuntimeException
    //   Exception type        : System.Management.Automation.RuntimeException
    //   InnerException        : System.DivideByZeroException
    //   Message               : Attempted to divide by zero.
    const record: ErrorRecord = divideByZeroError();
    assert.equal(record.fullyQualifiedErrorId, 'RuntimeException');
    assert.equal(record.category, 'NotSpecified');
    assert.equal(record.exceptionType, 'System.Management.Automation.RuntimeException');
    assert.equal(record.message, 'Attempted to divide by zero.');
  });

  it('WRONG BEFORE PROBING: the divide-by-zero CATEGORY is NotSpecified', () => {
    // Predicted InvalidOperation, which is what the name suggests and what the
    // sibling `$null.Foo()` error actually uses.
    assert.notEqual(divideByZeroError().category, 'InvalidOperation');
    assert.equal(divideByZeroError().category, 'NotSpecified');
    assert.equal(methodOnNullError().category, 'InvalidOperation');
  });

  it('$null.Foo() matches the fixture exactly', () => {
    // pwsh: $null.Foo()
    //   FullyQualifiedErrorId : InvokeMethodOnNull
    //   CategoryInfo.Category : InvalidOperation
    //   Exception type        : System.Management.Automation.RuntimeException
    //   Message               : You cannot call a method on a null-valued expression.
    const record = methodOnNullError('Foo');
    assert.equal(record.fullyQualifiedErrorId, 'InvokeMethodOnNull');
    assert.equal(record.category, 'InvalidOperation');
    assert.equal(record.exceptionType, 'System.Management.Automation.RuntimeException');
    assert.equal(record.message, 'You cannot call a method on a null-valued expression.');
  });

  it('an ENGINE error id has no command name appended, unlike a cmdlet error', () => {
    // pwsh: Get-Command NoSuchCommandXyz
    //   -> CommandNotFoundException,Microsoft.PowerShell.Commands.GetCommandCommand
    // pwsh: $null.Foo()
    //   -> InvokeMethodOnNull                                   <- no comma
    // Using errorRecord() here would emit 'InvokeMethodOnNull,' and break every
    // script that matches the real id.
    assert.equal(methodOnNullError().fullyQualifiedErrorId.includes(','), false);
    assert.equal(
      errorRecord('m', 'CommandNotFoundException', 'Microsoft.PowerShell.Commands.GetCommandCommand')
        .fullyQualifiedErrorId,
      'CommandNotFoundException,Microsoft.PowerShell.Commands.GetCommandCommand',
    );
  });

  it('invokeMethod raises on $null and carries the record up as a PSRuntimeError', () => {
    assert.throws(
      () => invokeMethod(null, 'Foo'),
      (error: unknown) => {
        assert.ok(error instanceof PSRuntimeError, 'must carry an ErrorRecord');
        assert.equal(error.record.fullyQualifiedErrorId, 'InvokeMethodOnNull');
        assert.equal(error.message, error.record.message, 'the Error message mirrors the record');
        return true;
      },
    );
  });

  it('the arithmetic path really produces the record, not just the factory', () => {
    // The corpus compares the id an EXPRESSION produces, so the record has to
    // come out of the operator rather than out of a constructor a test called.
    assert.throws(
      () => arithmetic('/', 1, 0),
      (error: unknown) => {
        assert.ok(error instanceof PSRuntimeError);
        assert.deepEqual(error.record, divideByZeroError());
        return true;
      },
    );
  });
});

describe('the same malformed regex produces two different error ids', () => {
  it('-replace wraps it and -match does not', () => {
    // pwsh: 'abc' -replace '[','X'
    //   id  = InvalidRegularExpression
    //   type= System.Management.Automation.RuntimeException
    //   msg = The regular expression pattern [ is not valid.
    // pwsh: 'abc' -match '['
    //   id  = System.Text.RegularExpressions.RegexParseException
    //   type= System.Text.RegularExpressions.RegexParseException
    //   msg = Invalid pattern '[' at offset 1. Unterminated [] set.
    const wrapped = expectError(() => replaceOperator('abc', '[', 'X'));
    assert.equal(wrapped.record.fullyQualifiedErrorId, 'InvalidRegularExpression');
    assert.equal(wrapped.record.exceptionType, 'System.Management.Automation.RuntimeException');
    assert.equal(wrapped.record.message, 'The regular expression pattern [ is not valid.');

    const raw = expectError(() => matchOperator('abc', '['));
    assert.equal(
      raw.record.fullyQualifiedErrorId,
      'System.Text.RegularExpressions.RegexParseException',
    );
    assert.equal(raw.record.exceptionType, 'System.Text.RegularExpressions.RegexParseException');
    assert.notEqual(raw.record.fullyQualifiedErrorId, wrapped.record.fullyQualifiedErrorId);
  });
});

// ---------------------------------------------------------------------------
// -is / -isnot
// ---------------------------------------------------------------------------

describe('-is and -isnot', () => {
  it('accepts an accelerator, its long form, or a bare string', () => {
    // pwsh: 1 -is [int]           ->  True
    // pwsh: 1 -is [int32]         ->  True
    // pwsh: 1 -is 'System.Int32'  ->  True
    // pwsh: 1 -is [string]        ->  False
    // pwsh: 1 -isnot [string]     ->  True
    assert.equal(isOperator(1, 'int'), true);
    assert.equal(isOperator(1, 'int32'), true);
    assert.equal(isOperator(1, 'System.Int32'), true);
    assert.equal(isOperator(1, 'string'), false);
    assert.equal(isOperator(1, 'string', true), true);
  });

  it('walks the hierarchy', () => {
    // pwsh: 1 -is [object]      ->  True     1 -is [valuetype]   ->  True
    // pwsh: @(1) -is [array]    ->  True     @(1) -is [object[]] ->  True
    // pwsh: 1.5 -is [double]    ->  True     'a' -is [string]    ->  True
    assert.equal(isOperator(1, 'object'), true);
    assert.equal(isOperator(1, 'valuetype'), true);
    assert.equal(isOperator([1], 'array'), true);
    assert.equal(isOperator([1], 'object[]'), true);
    assert.equal(isOperator(1.5, 'double'), true);
    assert.equal(isOperator('a', 'string'), true);
    assert.equal(isOperator(new Date(), 'datetime'), true);
  });

  it('says $null is an instance of NOTHING, including [object]', () => {
    // pwsh: $null -is [object]  ->  False
    // pwsh: $null -is [string]  ->  False
    // This is the one place -is must not reuse typeNameOf, which deliberately
    // answers System.Object for null so that callers never have to guard it.
    assert.equal(isOperator(null, 'object'), false);
    assert.equal(isOperator(null, 'string'), false);
    assert.equal(isOperator(null, 'object', true), true);
  });

  it('answers a single boolean even for an array left operand', () => {
    // pwsh: @(1,2) -is [array]  ->  True     (it does NOT filter)
    assert.equal(isOperator([1, 2], 'array'), true);
  });

  it('raises TypeNotFound for an unknown type', () => {
    // pwsh: 1 -is [nosuchtype]  ->  id = TypeNotFound
    //                               msg = Unable to find type [nosuchtype].
    const err = expectError(() => isOperator(1, 'nosuchtype'));
    assert.equal(err.record.fullyQualifiedErrorId, 'TypeNotFound');
    assert.equal(err.record.message, 'Unable to find type [nosuchtype].');
    assert.equal(resolveTypeName('int'), 'System.Int32');
  });
});

// ---------------------------------------------------------------------------
// -as
// ---------------------------------------------------------------------------

describe('-as returns $null where a cast throws', () => {
  it('is the difference this operator exists for', () => {
    // pwsh: 'abc' -as [int]  ->  $null, and no error at all
    // pwsh: [int]'abc'       ->  THROWS InvalidCastFromStringToInteger
    assert.equal(asOperator('abc', 'int'), null);
    assert.throws(() => arithmetic('+', 0, 'abc'), PSRuntimeError);
  });

  it('rounds half to even rather than truncating', () => {
    // pwsh: 1.9 -as [int]    ->  2
    // pwsh: 2.5 -as [int]    ->  2      <- not 3
    // pwsh: '1.5' -as [int]  ->  2
    // pwsh: '2.5' -as [int]  ->  2
    assert.equal(asOperator(1.9, 'int'), 2);
    assert.equal(asOperator(2.5, 'int'), 2);
    assert.equal(asOperator('1.5', 'int'), 2);
    assert.equal(asOperator('2.5', 'int'), 2);
  });

  it('accepts the string forms PowerShell accepts', () => {
    // pwsh: '1' -as [int]      ->  1
    // pwsh: '1e3' -as [int]    ->  1000
    // pwsh: '0x10' -as [int]   ->  16
    // pwsh: ' 1 ' -as [int]    ->  1
    // pwsh: '1,000' -as [int]  ->  1000
    // pwsh: $true -as [int]    ->  1
    // pwsh: $null -as [int]    ->  0
    assert.equal(asOperator('1', 'int'), 1);
    assert.equal(asOperator('1e3', 'int'), 1000);
    assert.equal(asOperator('0x10', 'int'), 16);
    assert.equal(asOperator(' 1 ', 'int'), 1);
    assert.equal(asOperator('1,000', 'int'), 1000);
    assert.equal(asOperator(true, 'int'), 1);
    assert.equal(asOperator(null, 'int'), 0);
  });

  it('converts to string through the invariant conversion', () => {
    // pwsh: 1 -as [string]        ->  1
    // pwsh: 1.5 -as [string]      ->  1.5
    // pwsh: @(1,2) -as [string]   ->  '1 2'      <- joined with $OFS
    // pwsh: $null -as [string]    ->  '' (empty, not the word null)
    assert.equal(asOperator(1, 'string'), '1');
    assert.equal(asOperator(1.5, 'string'), '1.5');
    assert.equal(asOperator([1, 2], 'string'), '1 2');
    assert.equal(asOperator(null, 'string'), '');
  });

  it('still raises for an unknown TYPE — the null is for a failed conversion only', () => {
    // pwsh: 'abc' -as [nosuchtype]  ->  id = TypeNotFound
    assert.equal(expectError(() => asOperator('abc', 'nosuchtype')).record.fullyQualifiedErrorId, 'TypeNotFound');
  });

  it('parses a date', () => {
    // pwsh: '2020-03-04' -as [datetime]  ->  03/04/2020 00:00:00
    const parsed = asOperator('2020-03-04', 'datetime');
    assert.ok(parsed instanceof Date);
    assert.equal(parsed.getUTCFullYear(), 2020);
    assert.equal(asOperator('not a date', 'datetime'), null);
  });
});

// ---------------------------------------------------------------------------
// -not
// ---------------------------------------------------------------------------

describe('-not uses PowerShell truthiness, which is not JavaScript`s', () => {
  it('agrees with the measured truth table', () => {
    // pwsh: -not 0        ->  True       -not 1         ->  False
    // pwsh: -not ''       ->  True       -not '0'       ->  False   <- non-empty string
    // pwsh: -not @()      ->  True       -not @(0)      ->  True    <- takes the element
    // pwsh: -not @(0,0)   ->  False      <- two elements is truthy whatever they are
    // pwsh: -not $null    ->  True       -not @{}       ->  False   <- empty hashtable is TRUE
    assert.equal(notOperator(0), true);
    assert.equal(notOperator(1), false);
    assert.equal(notOperator(''), true);
    assert.equal(notOperator('0'), false);
    assert.equal(notOperator([]), true);
    assert.equal(notOperator([0]), true);
    assert.equal(notOperator([0, 0]), false);
    assert.equal(notOperator(null), true);
    assert.equal(notOperator(psObject({})), false);
    assert.equal(notOperator(new Date()), false);
  });

  it("disagrees with JavaScript on '0' and on a one-element array", () => {
    // The two places a JavaScript habit gets it wrong:
    //   '0' is truthy in PowerShell (a non-empty string) and truthy in JS too,
    //   but @(0) is FALSY in PowerShell and truthy in JS.
    assert.equal(notOperator([0]), true);
    const jsTruthiness = (value: unknown): boolean => !value;
    assert.equal(jsTruthiness([0]), false, 'JavaScript says the array is truthy');
  });
});

function expectError(run: () => unknown): PSRuntimeError {
  try {
    run();
  } catch (error) {
    assert.ok(error instanceof PSRuntimeError, 'expected a PSRuntimeError');
    return error;
  }
  assert.fail('expected a throw');
}
