/**
 * index.ts — the operator table, and what a future parser will call.
 *
 * There is no expression evaluator yet. This exists so that when there is one it
 * has a single place to ask "what does `-inotmatch` mean", instead of every
 * caller re-deriving the case-prefix rule and getting a different subset of it.
 *
 * THE CASE-PREFIX RULE, MEASURED RATHER THAN ASSUMED
 *
 * Nearly every comparison and string operator has three spellings — bare, `c`
 * and `i` — and the bare one is the INSENSITIVE one. That was verified for each
 * operator individually rather than generalised from `-eq`, because a regex
 * engine's default is the opposite and copying it would be wrong everywhere.
 *
 * The exceptions are `-join`, `-split`'s unary form, `-is`, `-isnot`, `-as`,
 * `-not`, the arithmetic operators and the bitwise operators: none of them takes
 * a `c` or `i` prefix. `-cjoin` and `-ijoin` in particular are NOT operators,
 * measured by feeding every candidate spelling to `[Parser]::ParseInput` and
 * seeing which failed to parse. Exactly those two did.
 */

export {
  PSRuntimeError,
  raise,
  addHashTableToNonHashTableError,
  comparisonFailureError,
  convertToFinalInvalidCastError,
  decimalOverflowError,
  divideByZeroError,
  duplicateHashKeyError,
  invalidCastFromStringError,
  invalidRegularExpressionError,
  invalidWildcardPatternError,
  methodOnNullError,
  negativeArrayRepeatError,
  negativeStringRepeatError,
  notComparableError,
  operatorMethodNotFoundError,
  regexParseError,
  typeNotFoundError,
} from './errors.ts';

export {
  asTypedNumber,
  bitwiseTarget,
  numericAdd,
  numericDivide,
  numericMultiply,
  numericRemainder,
  numericSubtract,
  parseNumericString,
  requireNumber,
  roundHalfToEven,
  widen,
  type NumericTypeName,
  type TypedNumber,
} from './numeric.ts';

export {
  arithmetic,
  bitwise,
  bitwiseNot,
  negate,
  unaryPlus,
  type ArithmeticOp,
  type BitwiseOp,
  type TypedValue,
} from './arithmetic.ts';

export {
  comparisonOperator,
  isOrderingOperator,
  membershipOperator,
  type ComparisonOp,
  type MembershipOp,
} from './comparison.ts';

export {
  joinAll,
  joinOperator,
  likeOperator,
  matchOperator,
  parseSplitOptions,
  replaceOperator,
  splitOnWhitespace,
  splitOperator,
  SPLIT_OPTION_NAMES,
  type CaseFlag,
  type MatchesTable,
  type MatchResult,
  type ReplacementScriptBlock,
  type SplitOptionName,
  type SplitScriptBlock,
} from './strings.ts';

export {
  analyseGroups,
  expandReplacement,
  matchInfo,
  type GroupMap,
  type RegexMatchInfo,
} from './regex.ts';

export { escapeWildcard, wildcardMatches, wildcardToRegExp } from './wildcard.ts';

export { asOperator, invokeMethod, isOperator, notOperator, resolveTypeName } from './types.ts';

/**
 * Every operator that accepts a case prefix, in its BARE form.
 *
 * `-notlike` and friends are listed as themselves rather than derived from
 * `-like`, because the prefix goes in FRONT of the whole name: the sensitive
 * spelling is `-cnotlike`, not `-notclike`. That is measured — both `-cnotlike`
 * and `-cnotcontains` parse — and getting it backwards produces names that do
 * not exist.
 */
export const CASE_SENSITIVE_OPERATORS = [
  'eq',
  'ne',
  'lt',
  'le',
  'gt',
  'ge',
  'like',
  'notlike',
  'match',
  'notmatch',
  'replace',
  'split',
  'contains',
  'notcontains',
  'in',
  'notin',
] as const;

export type CaseSensitiveOperator = (typeof CASE_SENSITIVE_OPERATORS)[number];

/** An operator name split into its base and the case it asked for. */
export interface ParsedOperator {
  readonly name: string;
  readonly caseSensitive: boolean;
  /** True when the spelling carried an explicit `c` or `i`. */
  readonly explicit: boolean;
}

/**
 * Split `-cnotmatch` into `notmatch` + case-sensitive.
 *
 * Returns null for anything that is not an operator, which is what makes
 * `-cjoin` fail here as it fails in the reference implementation's parser rather
 * than quietly behaving like `-join`.
 */
export function parseOperator(spelling: string): ParsedOperator | null {
  const bare = spelling.startsWith('-') ? spelling.slice(1).toLowerCase() : spelling.toLowerCase();

  const isBase = (n: string): n is CaseSensitiveOperator =>
    (CASE_SENSITIVE_OPERATORS as readonly string[]).includes(n);

  if (isBase(bare)) return { name: bare, caseSensitive: false, explicit: false };

  const prefix = bare.slice(0, 1);
  const rest = bare.slice(1);
  if ((prefix === 'c' || prefix === 'i') && isBase(rest)) {
    return { name: rest, caseSensitive: prefix === 'c', explicit: true };
  }

  // Operators with no case forms at all. Listed rather than defaulted, so a
  // typo does not silently become one of them.
  if (
    ['join', 'is', 'isnot', 'as', 'not', 'band', 'bor', 'bxor', 'bnot', 'shl', 'shr'].includes(bare)
  ) {
    return { name: bare, caseSensitive: false, explicit: false };
  }
  return null;
}
