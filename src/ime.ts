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
    if (box.length > sent.length) emit(box.slice(sent.length));
    sent = box;
    if (box.length > 200) {
      ta.value = "";
      sent = "";
    }
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
  };
  ta.addEventListener("input", onInput);

  const onCompositionStart = () => {
    native = true;
    sent = "";
  };
  ta.addEventListener("compositionstart", onCompositionStart);

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
    },
  };
}
