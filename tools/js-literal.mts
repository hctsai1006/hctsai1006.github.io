/**
 * js-literal.mts — locate a JavaScript object or array literal, with a parser.
 *
 * Why this is not a brace matcher any more
 * ----------------------------------------
 * It was one, for a while: a hand-written lexer tracking the states that can
 * hold an unbalanced brace. It worked on index.html, and it was still the wrong
 * tool in a repository whose argument is that structure should not be parsed by
 * hand. A differential test against the TypeScript parser found two constructs
 * of ordinary JavaScript it refused — `if (a) /}/.test(b)` and `throw /}/` —
 * and a fuzz run found inputs where it returned a WRONG span rather than
 * throwing. Regex-versus-division cannot be decided without a parser, so the
 * parser does it now.
 *
 * TypeScript is already a dependency; `tsc --noEmit` gates every commit. oxc and
 * swc parse several times faster but ship platform-specific native binaries for
 * a step that takes a fraction of a second.
 *
 * HTML is not JavaScript, and a regex is not an HTML parser
 * --------------------------------------------------------
 * The first version of `inlineScript` found the element with
 * `/<script(?![^>]*\bsrc=)[^>]*>/i`, which is the very technique this file
 * exists to argue against, one layer up — and unlike the lexer it replaced, it
 * failed OPEN. An adversarial review demonstrated the consequence end to end:
 *
 *     <!-- old build
 *     <script>const D={stats:{merged:115}};</script>
 *     -->
 *     <script>const D={stats:{merged:276}};</script>
 *
 * It returned the commented-out block. The extractor wrote 115 merged PRs into
 * src/data, `--check` then agreed the data was in sync, and nothing threw. An
 * uppercase `</SCRIPT>` did the same, because the open tag was matched with /i
 * and the close tag was found with a case-sensitive indexOf. Two more inputs —
 * `data-src="…"` and an attribute containing `>` — failed closed, which is
 * luck rather than design.
 *
 * So the element is found by scanning, not matching: comments are skipped,
 * tags are walked with their quoted attribute values, and the end tag is the
 * one HTML actually defines. On top of that the file must contain EXACTLY ONE
 * inline script, which is what the old doc comment claimed and never enforced.
 * Both halves matter: skipping comments makes it correct, and the count makes
 * it loud when the page changes shape in a way this scanner has not been taught.
 */

import ts from 'typescript';

export interface LiteralSpan {
  /** The literal text, including its outer delimiters. */
  text: string;
  start: number;
  end: number;
}

// ---------------------------------------------------------------------------
// finding the script element
// ---------------------------------------------------------------------------

interface ScriptElement {
  text: string;
  offset: number;
  hasSrc: boolean;
}

/** End of the tag that starts at `open`, honouring quoted attribute values. */
function endOfTag(html: string, open: number): number {
  let i = open + 1;
  while (i < html.length) {
    const ch = html[i];
    if (ch === '"' || ch === "'") {
      const close = html.indexOf(ch, i + 1);
      if (close === -1) throw new Error(`unterminated attribute value at offset ${i}`);
      i = close + 1;
      continue;
    }
    if (ch === '>') return i + 1;
    i++;
  }
  throw new Error(`unterminated tag at offset ${open}`);
}

/**
 * Does this start tag carry a `src` attribute?
 *
 * Parsed rather than searched: `\bsrc=` also matches `data-src=`, because `-`
 * is a word boundary, and it matches `src=` inside another attribute's value.
 * Both made the old version refuse a perfectly good inline script.
 */
function hasSrcAttribute(tag: string): boolean {
  const ws = /\s/;
  let i = tag.search(ws);
  if (i === -1) return false;

  while (i < tag.length) {
    while (i < tag.length && (ws.test(tag[i] ?? '') || tag[i] === '/')) i++;
    if (i >= tag.length || tag[i] === '>') return false;

    const nameStart = i;
    while (i < tag.length && !/[\s=/>]/.test(tag[i] ?? '')) i++;
    const name = tag.slice(nameStart, i).toLowerCase();

    while (i < tag.length && ws.test(tag[i] ?? '')) i++;
    if (tag[i] === '=') {
      i++;
      while (i < tag.length && ws.test(tag[i] ?? '')) i++;
      const quote = tag[i];
      if (quote === '"' || quote === "'") {
        i++;
        while (i < tag.length && tag[i] !== quote) i++;
        i++;
      } else {
        while (i < tag.length && !/[\s>]/.test(tag[i] ?? '')) i++;
      }
    }
    if (name === 'src') return true;
  }
  return false;
}

/**
 * Every script element in the document, in order.
 *
 * Not a general HTML parser, and does not pretend to be: it knows comments,
 * markup declarations, tags with quoted attributes, and the rule that script
 * data ends at the first `</script` followed by whitespace, `/` or `>`. That is
 * the subset needed to answer one question correctly, and anything it cannot
 * account for shows up as a wrong element count rather than as wrong data.
 */
function scanScripts(html: string): ScriptElement[] {
  const found: ScriptElement[] = [];
  let i = 0;

  while (i < html.length) {
    const lt = html.indexOf('<', i);
    if (lt === -1) break;

    if (html.startsWith('<!--', lt)) {
      const end = html.indexOf('-->', lt + 4);
      if (end === -1) throw new Error(`unterminated HTML comment at offset ${lt}`);
      i = end + 3;
      continue;
    }
    if (html.startsWith('<!', lt) || html.startsWith('<?', lt)) {
      i = endOfTag(html, lt);
      continue;
    }

    const name = /^<(\/?)([a-zA-Z][^\s/>]*)/.exec(html.slice(lt, lt + 64));
    if (name === null) {
      i = lt + 1;
      continue;
    }

    const tagEnd = endOfTag(html, lt);
    const isClosing = name[1] === '/';

    if (!isClosing && (name[2] ?? '').toLowerCase() === 'script') {
      const contentStart = tagEnd;
      const close = /<\/script[\s/>]/i.exec(html.slice(contentStart));
      if (close === null) throw new Error('a <script> element is never closed');
      const contentEnd = contentStart + close.index;
      found.push({
        text: html.slice(contentStart, contentEnd),
        offset: contentStart,
        hasSrc: hasSrcAttribute(html.slice(lt, tagEnd)),
      });
      i = contentEnd;
      continue;
    }

    i = tagEnd;
  }

  return found;
}

/**
 * The text of the document's one inline script, and where it starts.
 *
 * Throws unless there is exactly one. A second inline script is not something
 * to disambiguate by position — whichever one this picked would be a guess, and
 * a guess is how a commented-out block came to be extracted as truth.
 */
export function inlineScript(html: string): { text: string; offset: number } {
  const inline = scanScripts(html).filter((s) => !s.hasSrc);

  if (inline.length === 0) throw new Error('no inline <script> element found');
  if (inline.length > 1) {
    throw new Error(
      `expected exactly one inline <script>, found ${inline.length} ` +
        `(at offsets ${inline.map((s) => s.offset).join(', ')}). ` +
        'Which one holds the data is not something this tool may guess at.',
    );
  }

  const only = inline[0] as ScriptElement;
  return { text: only.text, offset: only.offset };
}

// ---------------------------------------------------------------------------
// reading the literal
// ---------------------------------------------------------------------------

/**
 * Diagnostic codes for JavaScript EARLY ERRORS — the ones that make a browser
 * refuse to run the whole script, so a literal extracted from it would describe
 * code that never executes.
 *
 * A whitelist, because the alternative does not work. Requiring TypeScript's
 * semantic diagnostics to be empty was suggested and measured: with `noLib` the
 * real index.html script reports 426 errors, all "Cannot find name 'document'";
 * with the DOM lib loaded it still reports 61, all type-inference opinions
 * (2339 property-does-not-exist, 2769 overload) about hand-written JavaScript
 * that was never meant to satisfy a checker. Either way the gate would reject
 * the file it exists to read.
 *
 * These eight are grammar, not opinion. Each was confirmed against tsc 5.9.2 to
 * be reported for the corresponding early error and for nothing else here.
 */
const EARLY_ERROR_CODES = new Set([
  1104, // 'continue' outside an enclosing iteration statement
  1105, // 'break' outside an enclosing iteration statement
  1108, // 'return' outside a function body
  1117, // an object literal with duplicate properties (__proto__)
  1155, // 'const' declaration without an initializer
  2300, // duplicate identifier (a repeated function parameter)
  2451, // cannot redeclare a block-scoped variable
  2703, // 'delete' applied to something that is not a property reference
]);

interface ParsedSource {
  file: ts.SourceFile;
  problems: readonly string[];
}

/** Parsing the same 118 KB script six times is the common case; cache it. */
const parseCache = new Map<string, ParsedSource>();

function parseSource(js: string): ParsedSource {
  const cached = parseCache.get(js);
  if (cached !== undefined) return cached;

  const name = 'extracted.js';
  const file = ts.createSourceFile(name, js, ts.ScriptTarget.Latest, true, ts.ScriptKind.JS);

  // A one-file Program over the SourceFile already parsed. `noLib` keeps it
  // fast and means unresolved globals surface as 2584, which the whitelist
  // above ignores. Public API throughout: the first version reached for
  // `(file as ...).parseDiagnostics`, which is absent from TypeScript's .d.ts
  // and, worse, sees none of the early errors listed above.
  const options: ts.CompilerOptions = {
    allowJs: true,
    checkJs: true,
    noLib: true,
    noResolve: true,
    types: [],
  };
  const host: ts.CompilerHost = {
    getSourceFile: (f) => (f === name ? file : undefined),
    getDefaultLibFileName: () => 'lib.d.ts',
    writeFile: () => {},
    getCurrentDirectory: () => '',
    getDirectories: () => [],
    getCanonicalFileName: (f) => f,
    useCaseSensitiveFileNames: () => true,
    getNewLine: () => '\n',
    fileExists: (f) => f === name,
    readFile: () => undefined,
  };
  const program = ts.createProgram([name], options, host);

  const describe = (d: ts.Diagnostic): string =>
    `offset ${d.start ?? 0}: ${ts.flattenDiagnosticMessageText(d.messageText, ' ')}`;

  const problems = [
    ...program.getSyntacticDiagnostics(file).map(describe),
    ...program
      .getSemanticDiagnostics(file)
      .filter((d) => EARLY_ERROR_CODES.has(d.code))
      .map(describe),
  ];

  const parsed: ParsedSource = { file, problems };
  parseCache.set(js, parsed);
  return parsed;
}

/**
 * Parse `js` and return the span of the initialiser of `const name = ...`.
 *
 * Throws unless the source is free of syntax and early errors and the
 * initialiser is an object or array literal. The check matters because
 * TypeScript's parser recovers from errors and still hands back a tree: without
 * it, a broken script yields a confident span for a declaration that never runs.
 */
export function readNamedLiteral(js: string, name: string): LiteralSpan {
  const { file, problems } = parseSource(js);

  if (problems.length > 0) {
    throw new Error(
      `the source does not parse or would not run (${problems.length} error(s), ` +
        `first at ${problems[0]})`,
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
 * What the extractors want: the literal `const name = ...` inside the document's
 * one inline script, with offsets into the whole file.
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
