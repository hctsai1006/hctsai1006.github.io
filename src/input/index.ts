/**
 * index.ts — the input seam.
 *
 * The counterpart of `src/line-editor/index.ts`, which is the core, and the
 * opposite end of the terminal from the render seam. The dependency runs one
 * way: this module knows about `LineEditor`, and nothing in `src/line-editor/`
 * knows this exists.
 *
 * `keyCode` is named here and nowhere else in `src/`. That is deliberate — the
 * headlessness gate in tests/unit/line-editor.test.mts forbids the core from
 * naming a DOM identifier, so the third leg of v1's IME guard has to live on
 * this side of the seam. See `ime.ts` for what each leg catches.
 */

export {
  IME_SENTINEL_KEYCODE,
  imeGuardLeg,
  toEditorKeyEvent,
  type ImeGuardLeg,
  type KeydownLike,
} from './ime.ts';

export {
  TextareaInputAdapter,
  type CompositionLike,
  type InputAdapter,
  type KeydownOutcome,
  type PassThroughReason,
  type TextInputLike,
  type TextareaInputOptions,
  type TextareaLike,
} from './textarea.ts';
