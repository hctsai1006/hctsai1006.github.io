/**
 * renderer-dom-fake.mts — enough DOM to check what a screen reader would read.
 *
 * WHY A FAKE AND NOT A BROWSER. The thing under test is the accessible text of
 * the rendered rows, and the ground truth for it is 128 committed transcripts
 * captured from a real browser (`tests/conformance/fixtures/v1/`). Replaying
 * 1102 rows through Chromium to compare them against files a browser already
 * produced would make a hermetic assertion depend on a 130MB download for no
 * extra truth. What a browser could add — that Chromium's own `textContent`
 * agrees with this one — is covered by `tests/browser/` for v1 itself.
 *
 * WHY IT IS THIS SMALL. `src/renderer/semantic.ts` declares the narrow slice of
 * the DOM it uses, and this implements exactly that slice: five members on an
 * element, two on a document. A fake with more in it can drift from the browser
 * in ways nothing notices; a fake with less cannot host the renderer at all.
 *
 * THE ONE PIECE OF REAL BEHAVIOUR is `textContent`, which is recursive over
 * descendants and is the whole point of the file. Everything else is storage.
 */

import type { TerminalDocument, TerminalElement, TerminalNode } from '../../src/renderer/semantic.ts';

export interface FakeNode extends TerminalNode {
  readonly nodeName: string;
}

class FakeText implements FakeNode {
  readonly nodeName = '#text';
  readonly data: string;

  // Written out rather than as a parameter property: `erasableSyntaxOnly` is
  // on, and Node's type stripping refuses one outright.
  constructor(data: string) {
    this.data = data;
  }

  get textContent(): string {
    return this.data;
  }
}

export class FakeElement implements TerminalElement, FakeNode {
  className = '';
  readonly attributes = new Map<string, string>();
  readonly children: FakeNode[] = [];

  readonly nodeName: string;

  constructor(nodeName: string) {
    this.nodeName = nodeName;
  }

  /**
   * The DOM's definition: the concatenated text of every descendant, in order.
   *
   * Not `children.map(c => c.data).join('')` — that would only be right for a
   * flat row, and a styled row is not flat. The test that matters here compares
   * this against a transcript line, so a shallow reading would pass while the
   * text inside every `<span>` went missing.
   */
  get textContent(): string {
    let out = '';
    for (const child of this.children) out += child.textContent ?? '';
    return out;
  }

  setAttribute(name: string, value: string): void {
    this.attributes.set(name, value);
  }

  append(...nodes: (TerminalNode | string)[]): void {
    for (const node of nodes) {
      this.children.push(typeof node === 'string' ? new FakeText(node) : (node as FakeNode));
    }
  }

  removeChild(child: TerminalNode): unknown {
    const at = this.children.indexOf(child as FakeNode);
    if (at >= 0) this.children.splice(at, 1);
    return child;
  }

  get firstChild(): TerminalNode | null {
    return this.children[0] ?? null;
  }

  /** Every descendant element, for tests that ask about the shape rather than the text. */
  elements(): FakeElement[] {
    const out: FakeElement[] = [];
    for (const child of this.children) {
      if (child instanceof FakeElement) {
        out.push(child);
        out.push(...child.elements());
      }
    }
    return out;
  }
}

export class FakeDocument implements TerminalDocument {
  createElement(tag: string): FakeElement {
    return new FakeElement(tag);
  }
  createTextNode(data: string): FakeNode {
    return new FakeText(data);
  }
}

/** A document, a container, and the rows the container currently holds. */
export function fakeHost(): {
  document: FakeDocument;
  container: FakeElement;
  rows: () => FakeElement[];
} {
  const document = new FakeDocument();
  const container = new FakeElement('div');
  return {
    document,
    container,
    rows: () => container.children.filter((c): c is FakeElement => c instanceof FakeElement),
  };
}
