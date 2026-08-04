import { Terminal } from "@xterm/xterm";

/** Characters an IME composes — everything else belongs to xterm. */
function isComposable(cp: number): boolean {
  return (
    (cp >= 0x1100 && cp <= 0x11ff) || // Hangul Jamo
    (cp >= 0x3130 && cp <= 0x318f) || // Compatibility Jamo
    (cp >= 0xac00 && cp <= 0xd7a3) || // Hangul syllables
    (cp >= 0x3040 && cp <= 0x30ff) || // Kana
    (cp >= 0x4e00 && cp <= 0x9fff) // CJK ideographs
  );
}

const composedOnly = (s: string) =>
  s.length > 0 && [...s].every((c) => isComposable(c.codePointAt(0) ?? 0));

/**
 * Composed (Hangul/CJK) input for xterm under WKWebView.
 *
 * Where composition events fire, xterm's own IME handling is correct and this
 * bridge stands down on the first `compositionstart`. Where they never fire —
 * WKWebView on some macOS setups — the IME instead rewrites xterm's hidden
 * textarea and reports the edit through `inputType`:
 *
 *     insertText            "ㅎ"   box "ㅎ"      ← a new character starts
 *     insertReplacementText "하"   box "하"      ← the composing tail changes
 *     insertReplacementText "한"   box "한"
 *     insertText            "ㄱ"   box "한ㄱ"     ← previous char is final now
 *
 * xterm acts only on `insertText`, so the terminal gets lone jamo (ㅎㄱ) and
 * the composed syllables never arrive. The textarea, though, always holds the
 * right text — so the bridge emits from the box: everything except a trailing
 * character that could still be composing, released once it is finalized.
 *
 * It claims composed text and nothing else. ASCII — letters, space,
 * punctuation, control keys — stays on xterm's own path, which never routes
 * through the textarea. The caller passes every xterm emission through
 * `route()`, which drops the jamo and orders a held syllable ahead of
 * whatever comes next.
 *
 * Held text is drawn at the cursor while it waits — see `paint` — because
 * nothing else will: it has not reached the pty, so the shell cannot echo it,
 * and xterm's composition view never activates without composition events.
 */
export function setupImeInput(term: Terminal, send: (data: string) => void) {
  const ta = term.textarea;
  if (!ta) return { route: (d: string) => d, dispose: () => {} };

  /** Prefix of the box already handed to the pty. */
  let sent = "";
  /** Composition events fire here — xterm handles the IME by itself. */
  let native = false;
  /** Text xterm emitted a moment ago, to recognize a paste it already sent. */
  let justRouted = "";
  let justRoutedAt = 0;
  /** Held back, not yet sent — kept for when the box is cleared under us. */
  let held = "";

  /**
   * The held character, drawn where the cursor is.
   *
   * It has not reached the pty, so nothing echoes it back, and xterm's own
   * `.composition-view` would show it but only lights up on composition
   * events — the very events this webview never sends. Without this the
   * syllable being typed is invisible until something finalizes it.
   *
   * xterm parks the textarea on the cursor cell so the IME's candidate window
   * lands in the right place; borrowing its box puts the view exactly there,
   * with no second measurement of the cell grid to drift out of step.
   */
  const helpers = ta.parentElement;
  const view = helpers ? ta.ownerDocument.createElement("div") : null;
  if (view && helpers) {
    view.className = "composition-view"; // xterm's own placement rules
    view.style.pointerEvents = "none";
    view.style.textDecoration = "underline";
    helpers.appendChild(view);
  }

  const paint = () => {
    held = native ? "" : ta.value.slice(sent.length);
    if (!view) return;
    // Before xterm has parked the textarea there is no cursor cell to sit on.
    if (!held || !ta.style.left) {
      view.classList.remove("active");
      return;
    }
    view.textContent = held;
    view.style.left = ta.style.left;
    view.style.top = ta.style.top;
    view.style.height = ta.style.height;
    view.style.lineHeight = ta.style.lineHeight;
    view.style.fontFamily = term.options.fontFamily ?? "monospace";
    view.style.fontSize = `${term.options.fontSize ?? 15}px`;
    view.style.backgroundColor = term.options.theme?.background ?? "#000";
    view.style.color = term.options.theme?.foreground ?? "#fff";
    view.classList.add("active");
  };

  /** Re-align with a box that was cleared or edited behind our back. */
  const resync = (box: string) => {
    if (box.startsWith(sent)) return;
    let i = 0;
    while (i < Math.min(box.length, sent.length) && box[i] === sent[i]) i++;
    // Only ever rewind our bookkeeping — never synthesize deletions. xterm
    // still turns Backspace into \x7f itself, and it clears the box on its
    // own between lines; emitting here would delete text the user kept.
    sent = sent.slice(0, i);
  };

  /** Send the composed characters of a finalized slice; skip xterm's. */
  const emit = (slice: string) => {
    const mine = [...slice]
      .filter((c) => isComposable(c.codePointAt(0) ?? 0))
      .join("");
    if (mine) send(mine);
  };

  /**
   * Emit everything pending, composing tail included. The box is left alone —
   * clearing it here races the IME, which may rewrite it right after and make
   * the bridge re-send text it already delivered.
   */
  const flush = () => {
    if (native) return;
    const box = ta.value;
    resync(box);
    // Enter and Ctrl-C empty the textarea before xterm fires them (its
    // `_keyDown`, so screen readers announce the deleted line), which takes
    // the held character with it. `held` is what the box had.
    const pending = box.length > sent.length ? box.slice(sent.length) : held;
    if (pending) emit(pending);
    sent = box;
    if (box.length > 200) {
      ta.value = "";
      sent = "";
    }
    paint();
  };

  const onInput = (e: Event) => {
    if (native) return;
    const box = ta.value;
    resync(box);
    // Pasted and dropped text is not composition: none of it is pending and
    // none of it is xterm's, so it goes out whole — holding the tail would
    // swallow the last character and filtering would drop the spaces.
    if (/^insertFrom(Paste|Drop|Yank)/.test((e as InputEvent).inputType ?? "")) {
      const added = box.slice(sent.length);
      // ...unless xterm's paste handler already delivered it, which it does
      // just before this event.
      const echo = added === justRouted && Date.now() - justRoutedAt < 100;
      if (added && !echo) send(added);
      sent = box;
      paint();
      return;
    }
    const last = box.codePointAt(box.length - 1) ?? 0;
    // Hold a trailing composable character: the IME may still replace it.
    const upTo = isComposable(last) ? box.length - 1 : box.length;
    if (upTo > sent.length) {
      emit(box.slice(sent.length, upTo));
      sent = box.slice(0, upTo);
    }
    // Nothing pending: trim so the box cannot grow without bound.
    if (sent === box && box.length > 200) {
      ta.value = "";
      sent = "";
    }
    paint();
  };
  ta.addEventListener("input", onInput);

  const onCompositionStart = () => {
    native = true;
    sent = "";
    paint();
  };
  ta.addEventListener("compositionstart", onCompositionStart);

  // Losing focus finalizes whatever was composing, and xterm empties the box
  // on blur — which would take the held character with it. `held` is read
  // instead of the box because xterm's own blur handler runs first.
  const onBlur = () => {
    if (native || !held) return;
    emit(held);
    held = "";
    sent = "";
    view?.classList.remove("active");
  };
  ta.addEventListener("blur", onBlur);

  // xterm re-parks the textarea whenever the cursor moves; follow it, so the
  // view stays on the cell the character will land in.
  const cursorSub = term.onCursorMove(paint);

  // While a syllable is composing, Backspace edits the IME buffer. Returning
  // false keeps xterm from consuming the key (and from sending \x7f for text
  // the terminal never received).
  term.attachCustomKeyEventHandler((e) => {
    if (native || e.type !== "keydown" || e.key !== "Backspace") return true;
    return ta.value.length <= sent.length;
  });

  return {
    /**
     * Route one xterm emission: returns what should reach the pty, or null
     * when the bridge already handled it.
     *
     * xterm emits from the same `input` event, running just before the
     * bridge's own listener — with the textarea already updated. So its jamo
     * is recognizable as composed text sitting at the end of the box, and
     * anything else must be preceded by a flush: xterm's space for `한글 `
     * arrives before the bridge has seen `글`.
     */
    route: (data: string): string | null => {
      if (!native && composedOnly(data) && ta.value.endsWith(data)) return null;
      flush();
      // Bracketed-paste markers wrap the text xterm pastes; compare bare.
      justRouted = data.replace(/\x1b\[20[01]~/g, "");
      justRoutedAt = Date.now();
      return data;
    },
    dispose: () => {
      ta.removeEventListener("input", onInput);
      ta.removeEventListener("compositionstart", onCompositionStart);
      ta.removeEventListener("blur", onBlur);
      cursorSub.dispose();
      view?.remove();
    },
  };
}
