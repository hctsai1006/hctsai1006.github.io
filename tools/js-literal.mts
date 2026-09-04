/**
 * js-literal.mts — locate a JavaScript object or array literal, with a parser.
 *
 * Why this is not a brace matcher any more
 * ----------------------------------------
 * It was one, for a while: a hand-written lexer tracking the states that can
 * hold an unbalanced brace — three kinds of string, template substitutions, both
 * comment forms, and regex literals. It worked on index.html. It was still the
 * wrong tool, in a repository whose whole argument is that structure should not
 * be parsed by hand, and the argument applied to it as much as to anything else.
 *
 * A differential test against the TypeScript parser settled it. Two constructs
 * of perfectly ordinary JavaScript made the matcher refuse valid input:
 *
 *   { m(){ if (a) /}/.test(b) } }      regex after `)`
 *   { m(){ throw /}/ } }               regex after `throw`
 *
 * Regex-versus-division is genuinely ambiguous without a parser: `)` can precede
 * either, and no list of preceding characters decides it. The matcher failed
 * closed, which is the good failure — but it failed on code a person could
 * reasonably write, and the fix for each case would have been another entry in a
 * list that can never be complete.
 *
 * TypeScript is already a dependency here; `tsc --noEmit` gates every commit.
 * So the parser that type-checks this repo is now also the one that reads it,
 * and an entire category of lexing bug is gone rather than mitigated. oxc and
 * swc parse faster, but both ship platform-specific native binaries, and this
 * runs for about a tenth of a second at build time. Speed was never the
 * constraint; correctness was.
 *
 * HTML is not JavaScript
 * ---------------------
 * The old version searched raw HTML for `const NAME=`, which happened to work.
 * A parser cannot pretend that way, and should not: `inlineScript` takes the
 * script element out first, and the offsets it returns are translated back to
 * whole-file coordinates so callers still index into the original file.
 */

import ts from 'typescript';

export interface LiteralSpan {
  /** The literal text, including its outer delimiters. */
  text: string;
  start: number;
  end: number;
}

/**
 * The text of index.html's single inline script, and where it starts.
 *
 * Deliberately narrow: it takes the first `<script>` that has no `src`, and
 * throws if there is none. index.html has exactly one, and a second one
 * appearing is a change worth failing on rather than guessing about.
 */
export function inlineScript(html: string): { text: string; offset: number } {
  const open = /<script(?![^>]*\bsrc=)[^>]*>/i.exec(html);
  if (open === null) throw new Error('no inline <script> element found');
  const start = open.index + open[0].length;
  const end = html.indexOf('</script>', start);
  if (end === -1) throw new Error('inline <script> element is never closed');
  return { text: html.slice(start, end), offset: start };
}

/**
 * Parse `js` and return the span of the initialiser of `const name = ...`.
 *
 * Throws unless the source parses cleanly and the initialiser is an object or
 * array literal. The syntax check matters: TypeScript's parser recovers from
 * errors and still hands back a tree, so without it a broken script would yield
 * a plausible span for a declaration the file does not really contain.
 */
export function readNamedLiteral(js: string, name: string): LiteralSpan {
  const file = ts.createSourceFile('extracted.js', js, ts.ScriptTarget.Latest, true, ts.ScriptKind.JS);

  // parseDiagnostics is not in TypeScript's public .d.ts. It is stable in
  // practice and this is build-time tooling, but a silent disappearance would
  // turn the guarantee above into a no-op, so its absence is an error rather
  // than a skipped check.
  const diagnostics = (file as unknown as { parseDiagnostics?: readonly ts.Diagnostic[] })
    .parseDiagnostics;
  if (diagnostics === undefined) {
    throw new Error(
      `cannot read parse diagnostics from TypeScript ${ts.version}; ` +
        'the syntax check this function promises is unavailable, so it refuses to guess',
    );
  }
  if (diagnostics.length > 0) {
    const first = diagnostics[0];
    const where = first === undefined ? 'unknown position' : `offset ${first.start ?? 0}`;
    const what =
      first === undefined ? 'unknown error' : ts.flattenDiagnosticMessageText(first.messageText, ' ');
    throw new Error(
      `the source does not parse (${diagnostics.length} error(s), first at ${where}: ${what})`,
    );
  }

  let initializer: ts.Expression | undefined;
  const visit = (node: ts.Node): void => {
    if (
      initializer === undefined &&
      ts.isVariableDeclaration(node) &&
      ts.isIdentifier(node.name) &&
      node.name.text === name
    ) {
      initializer = node.initializer;
    }
    if (initializer === undefined) ts.forEachChild(node, visit);
  };
  visit(file);

  if (initializer === undefined) {
    throw new Error(`could not find \`const ${name}=\` in the source`);
  }
  if (!ts.isObjectLiteralExpression(initializer) && !ts.isArrayLiteralExpression(initializer)) {
    throw new Error(
      `\`${name}\` is initialised with ${ts.SyntaxKind[initializer.kind]}, ` +
        'not an object or array literal',
    );
  }

  const start = initializer.getStart(file);
  const end = initializer.getEnd();
  return { text: js.slice(start, end), start, end };
}

/**
 * What the extractors actually want: the literal `const name = ...` inside an
 * HTML file's inline script, with offsets into the whole file.
 */
export function readNamedLiteralFromHtml(html: string, name: string): LiteralSpan {
  const script = inlineScript(html);
  const span = readNamedLiteral(script.text, name);
  return {
    text: span.text,
    start: span.start + script.offset,
    end: span.end + script.offset,
  };
}
