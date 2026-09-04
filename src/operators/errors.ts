/**
 * errors.ts — the errors PowerShell's operators raise, as real ErrorRecords.
 *
 * WHY THIS IS NOT `throw new Error(...)`
 *
 * Scripts branch on `$_.FullyQualifiedErrorId` and on `$_.CategoryInfo.Category`,
 * and `catch [System.Management.Automation.RuntimeException]` filters on the
 * exception type. A JavaScript `Error` carrying only a message throws all of
 * that away: the failure is still visible, but it is no longer *catchable in the
 * ways the language allows*. So every operator failure here carries an
 * `ErrorRecord` from `../pipeline/streams.ts`, and `PSRuntimeError` is only the
 * JavaScript-level vehicle that gets it up the stack.
 *
 * WHY THE IDS ARE NOT BUILT WITH `errorRecord()`
 *
 * `errorRecord()` composes `fullyQualifiedErrorId` as `<ErrorId>,<CommandName>`,
 * which is right for a cmdlet and wrong for the engine. Measured in pwsh 7.6.5:
 *
 *   1 / 0          FullyQualifiedErrorId : RuntimeException
 *   $null.Foo()    FullyQualifiedErrorId : InvokeMethodOnNull
 *
 * No comma, no command name — because no command ran. An operator error is
 * raised by the engine evaluating an expression, so the id stands alone. Using
 * the cmdlet composer here would produce `RuntimeException,` and quietly fail
 * every script that matches on the real id.
 *
 * EVERY RECORD BELOW WAS READ OFF pwsh 7.6.5
 *
 * The probe printed FullyQualifiedErrorId, CategoryInfo.Category,
 * Exception.GetType().FullName and Exception.Message for each source, and the
 * values are quoted at each site. Two of them are also in the conformance
 * fixture (`error.divide-by-zero`, `error.method-on-null`), so a drift here
 * fails the differential run rather than only the unit tests.
 */

import type { ErrorRecord, ErrorCategory } from '../pipeline/streams.ts';
import type { PSValue } from '../pipeline/psobject.ts';

/**
 * A terminating PowerShell error, carrying the ErrorRecord a `catch` would see.
 *
 * Operators are expressions: they cannot write to the error stream and carry on,
 * because there is no value to carry on with. So they throw — but they throw
 * something that still has the whole record on it.
 */
export class PSRuntimeError extends Error {
  readonly record: ErrorRecord;

  constructor(record: ErrorRecord) {
    super(record.message);
    this.name = 'PSRuntimeError';
    this.record = record;
  }
}

/**
 * Build an engine-level ErrorRecord: the id stands alone, with no command name
 * appended. See the file docstring for why this does not call `errorRecord()`.
 */
function engineError(
  message: string,
  errorId: string,
  category: ErrorCategory,
  exceptionType = 'System.Management.Automation.RuntimeException',
  targetObject?: PSValue,
): ErrorRecord {
  return {
    message,
    fullyQualifiedErrorId: errorId,
    category,
    exceptionType,
    ...(targetObject !== undefined ? { targetObject } : {}),
  };
}

/** Raise an engine error. Never returns. */
export function raise(record: ErrorRecord): never {
  throw new PSRuntimeError(record);
}

// ---------------------------------------------------------------------------
// the measured records
// ---------------------------------------------------------------------------

/**
 * `1 / 0`, `1 % 0`, `1 / $null`, `1d / 0`.
 *
 * Measured:
 *   FullyQualifiedErrorId : RuntimeException
 *   CategoryInfo.Category : NotSpecified
 *   Exception type        : System.Management.Automation.RuntimeException
 *   InnerException        : System.DivideByZeroException
 *   Message               : Attempted to divide by zero.
 *
 * Note what is NOT here: the category is `NotSpecified`, not the
 * `InvalidOperation` the name would suggest, and the id is the bare exception
 * name rather than something like `DivideByZero`. Both were guessed wrong before
 * the probe.
 *
 * Note also which cases do NOT reach this: `1.0 / 0` is `Infinity` and
 * `1.0 % 0` is `NaN`. Only integer and decimal division by zero throws.
 */
export function divideByZeroError(): ErrorRecord {
  return engineError('Attempted to divide by zero.', 'RuntimeException', 'NotSpecified');
}

/**
 * `$null.Foo()`.
 *
 * Measured:
 *   FullyQualifiedErrorId : InvokeMethodOnNull
 *   CategoryInfo.Category : InvalidOperation
 *   Exception type        : System.Management.Automation.RuntimeException
 *   Message               : You cannot call a method on a null-valued expression.
 *
 * PROPERTY access on null is NOT an error: `$null.Length` succeeds and yields
 * nothing. Only a method invocation raises, which is why this takes a method
 * name and there is no property-on-null counterpart.
 */
export function methodOnNullError(methodName?: string): ErrorRecord {
  return engineError(
    'You cannot call a method on a null-valued expression.',
    'InvokeMethodOnNull',
    'InvalidOperation',
    'System.Management.Automation.RuntimeException',
    methodName,
  );
}

/**
 * `1 + 'abc'`, `'a' - 'b'`, `-'a'`, `1 -lt 'a'`, `'abc' -band 3`.
 *
 * Measured:
 *   FullyQualifiedErrorId : InvalidCastFromStringToInteger
 *   CategoryInfo.Category : InvalidOperation
 *   Message               : Cannot convert value "abc" to type "System.Int32".
 *                           Error: "The input string 'abc' was not in a correct format."
 *
 * THE ID FOLLOWS THE TARGET TYPE, which was not expected. Measured:
 *   1 -lt 'a'                        InvalidCastFromStringToInteger  (Int32)
 *   9223372036854775807 -lt 'a'      InvalidCastFromStringToInteger  (Int64)
 *   1.5 -lt 'a'                      InvalidCastFromStringToDoubleOrSingle
 *
 * so the id is not one constant. Only those two ids were observed; a Decimal
 * target has not been probed and falls back to the integer id rather than
 * inventing a third name.
 */
export function invalidCastFromStringError(value: string, targetType: string): ErrorRecord {
  const id =
    targetType === 'System.Double' || targetType === 'System.Single'
      ? 'InvalidCastFromStringToDoubleOrSingle'
      : 'InvalidCastFromStringToInteger';
  return engineError(
    `Cannot convert value "${value}" to type "${targetType}". ` +
      `Error: "The input string '${value}' was not in a correct format."`,
    id,
    'InvalidOperation',
    'System.Management.Automation.RuntimeException',
    value,
  );
}

/**
 * An ordering comparison whose right operand cannot become the left's type at
 * all — as opposed to a string that merely fails to parse.
 *
 * Measured:
 *   1 -lt @(2)
 *     id  = ComparisonFailure
 *     msg = Could not compare "1" to "2". Error: "Cannot convert the
 *           "System.Object[]" value of type "System.Object[]" to type "System.Int32"."
 *   1 -lt @{a=1}
 *     msg = Could not compare "1" to "System.Collections.Hashtable". Error: ...
 *
 * A DIFFERENT ID from the string case above, for what looks like the same
 * failure. `1 -lt 'a'` is InvalidCastFromStringToInteger; `1 -lt @(2)` is
 * ComparisonFailure. The distinction is whether a conversion was attempted and
 * failed, or was never possible.
 */
export function comparisonFailureError(
  leftText: string,
  rightText: string,
  rightType: string,
  leftType: string,
): ErrorRecord {
  return engineError(
    `Could not compare "${leftText}" to "${rightText}". ` +
      `Error: "Cannot convert the "${rightText}" value of type "${rightType}" to type "${leftType}"."`,
    'ComparisonFailure',
    'InvalidOperation',
  );
}

/**
 * Ordering two reference values that are not the same reference.
 *
 * Measured: `@{a=1} -lt @{b=2}` gives id `NotIcomparable` and the message
 * "Cannot compare "System.Collections.Hashtable" because it is not IComparable."
 *
 * The id's spelling — a lowercase `c` in `Icomparable` — is the reference
 * implementation's own, and is reproduced rather than corrected, because a
 * script matching the real id would not match a tidied one.
 *
 * Note what does NOT raise this: comparing a reference to ITSELF succeeds.
 * `$h -lt $h` is False and `$h -le $h` is True.
 */
export function notComparableError(typeName: string): ErrorRecord {
  return engineError(
    `Cannot compare "${typeName}" because it is not IComparable.`,
    'NotIcomparable',
    'InvalidOperation',
  );
}

/**
 * `3 + @(1,2)`, `@(1,2) - 1`, `-@(1,2)`.
 *
 * Measured:
 *   FullyQualifiedErrorId : MethodNotFound
 *   Message               : Method invocation failed because [System.Object[]]
 *                           does not contain a method named 'op_Addition'.
 *
 * The type named is the type the engine gave up on, and the method name is the
 * .NET operator method — `op_Addition`, `op_Subtraction`, `op_Multiply`. That
 * detail leaks the CLR into the message, and reproducing it is the point: a
 * script that greps the message would otherwise not match.
 */
export function operatorMethodNotFoundError(typeName: string, opMethod: string): ErrorRecord {
  return engineError(
    `Method invocation failed because [${typeName}] does not contain a method named '${opMethod}'.`,
    'MethodNotFound',
    'InvalidOperation',
  );
}

/**
 * `@{a=1} + @(1)`.
 *
 * Measured:
 *   FullyQualifiedErrorId : AddHashTableToNonHashTable
 *   Message               : A hash table can only be added to another hash table.
 */
export function addHashTableToNonHashTableError(): ErrorRecord {
  return engineError(
    'A hash table can only be added to another hash table.',
    'AddHashTableToNonHashTable',
    'InvalidOperation',
  );
}

/**
 * `@{a=1} + @{a=2}`.
 *
 * Measured, and it is the odd one out:
 *   FullyQualifiedErrorId : System.ArgumentException     <- the TYPE NAME, as the id
 *   Exception type        : System.ArgumentException     <- NOT a RuntimeException
 *   Message               : Item has already been added. Key in dictionary: 'a'  Key being added: 'a'
 *
 * A raw .NET exception escapes here rather than being wrapped, so both the id
 * and the exception type differ in kind from every other error in this file.
 * The double space before "Key being added" is in the reference implementation's
 * message and is reproduced deliberately.
 */
export function duplicateHashKeyError(key: string): ErrorRecord {
  return engineError(
    `Item has already been added. Key in dictionary: '${key}'  Key being added: '${key}'`,
    'System.ArgumentException',
    'InvalidOperation',
    'System.ArgumentException',
    key,
  );
}

/**
 * `'abc' -replace '[','X'`.
 *
 * Measured:
 *   FullyQualifiedErrorId : InvalidRegularExpression
 *   Exception type        : System.Management.Automation.RuntimeException
 *   Message               : The regular expression pattern [ is not valid.
 *
 * AND THE ASYMMETRY THAT WAS NOT EXPECTED: only `-replace` wraps the failure.
 * `-match`, `-notmatch` and `-split` let the raw .NET exception through —
 *
 *   'abc' -match '['    id=System.Text.RegularExpressions.RegexParseException
 *                       msg=Invalid pattern '[' at offset 1. Unterminated [] set.
 *
 * so the same malformed pattern produces two different error ids depending on
 * which operator saw it. Both forms are reproduced; see `regexParseError`.
 */
export function invalidRegularExpressionError(pattern: string): ErrorRecord {
  return engineError(
    `The regular expression pattern ${pattern} is not valid.`,
    'InvalidRegularExpression',
    'InvalidOperation',
    'System.Management.Automation.RuntimeException',
    pattern,
  );
}

/**
 * `'abc' -match '['`, `'abc' -split '['`.
 *
 * The unwrapped form: the id IS the exception type name. See
 * `invalidRegularExpressionError` for the operator that wraps instead.
 *
 * The message text comes from .NET's own parser and cannot be reproduced
 * character-for-character from JavaScript's RegExp, whose diagnostics are
 * differently worded. The id, the category and the exception type — the parts a
 * script can branch on — are exact; the message is a faithful paraphrase and is
 * marked as such rather than pretending otherwise.
 */
export function regexParseError(pattern: string, offset: number, detail: string): ErrorRecord {
  return engineError(
    `Invalid pattern '${pattern}' at offset ${String(offset)}. ${detail}`,
    'System.Text.RegularExpressions.RegexParseException',
    'InvalidOperation',
    'System.Text.RegularExpressions.RegexParseException',
    pattern,
  );
}

/**
 * `'abc' -like '[abc'`.
 *
 * Measured:
 *   FullyQualifiedErrorId : RuntimeException
 *   Message               : The specified wildcard character pattern is not valid: [abc
 *
 * A wildcard is not a regex and does not fail like one: the id is the generic
 * `RuntimeException`, not `InvalidRegularExpression`.
 */
export function invalidWildcardPatternError(pattern: string): ErrorRecord {
  return engineError(
    `The specified wildcard character pattern is not valid: ${pattern}`,
    'RuntimeException',
    'InvalidOperation',
    'System.Management.Automation.RuntimeException',
    pattern,
  );
}

/**
 * `-bnot 1e20`, `1e20 -shl 1`.
 *
 * Measured:
 *   FullyQualifiedErrorId : ConvertToFinalInvalidCastException
 *   Message               : Cannot convert the "1E+20" value of type "System.Double"
 *                           to type "System.UInt64".
 *
 * The target being UInt64 is the tell: bitwise operators route non-integer
 * operands through an unsigned 64-bit conversion. See numeric.ts.
 */
export function convertToFinalInvalidCastError(
  rendered: string,
  fromType: string,
  toType: string,
): ErrorRecord {
  return engineError(
    `Cannot convert the "${rendered}" value of type "${fromType}" to type "${toType}".`,
    'ConvertToFinalInvalidCastException',
    'InvalidOperation',
  );
}

/**
 * `[decimal]::MaxValue + 1`.
 *
 * Measured:
 *   FullyQualifiedErrorId : RuntimeException
 *   Message               : Value was either too large or too small for a Decimal.
 */
export function decimalOverflowError(): ErrorRecord {
  return engineError(
    'Value was either too large or too small for a Decimal.',
    'RuntimeException',
    'NotSpecified',
  );
}

/**
 * `'ab' * -1`.
 *
 * Measured:
 *   FullyQualifiedErrorId : System.ArgumentOutOfRangeException
 *   Message               : times ('-1') must be a non-negative value. (Parameter 'times')
 *
 * `@(1) * -1` fails differently — `InvalidCastIConvertible`, converting to
 * UInt32 — so string repetition and array repetition do not share an error even
 * though they share an operator. Both are reproduced.
 */
export function negativeStringRepeatError(times: number): ErrorRecord {
  return engineError(
    `times ('${String(times)}') must be a non-negative value. (Parameter 'times')`,
    'System.ArgumentOutOfRangeException',
    'InvalidOperation',
    'System.ArgumentOutOfRangeException',
    times,
  );
}

/** `@(1) * -1`. Measured: id `InvalidCastIConvertible`, target type UInt32. */
export function negativeArrayRepeatError(times: number): ErrorRecord {
  return engineError(
    `Cannot convert value "${String(times)}" to type "System.UInt32". ` +
      'Error: "Value was either too large or too small for a UInt32."',
    'InvalidCastIConvertible',
    'InvalidOperation',
    'System.Management.Automation.RuntimeException',
    times,
  );
}

/**
 * `1 -is [nosuchtype]`, `'abc' -as [nosuchtype]`.
 *
 * Measured: id `TypeNotFound`, message `Unable to find type [nosuchtype].`
 */
export function typeNotFoundError(typeName: string): ErrorRecord {
  return engineError(`Unable to find type [${typeName}].`, 'TypeNotFound', 'InvalidOperation', 'System.Management.Automation.RuntimeException', typeName);
}
