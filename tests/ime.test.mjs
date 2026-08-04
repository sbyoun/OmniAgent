import { setupImeInput } from "../dist-test/ime.mjs";

/**
 * Stand-in for the textarea and terminal the bridge talks to.
 *
 * `step` reproduces one WebKit keystroke in the order measured in the app:
 * the textarea is updated, xterm's own listener emits first (routed through
 * the bridge, as TerminalPod does), then the bridge's input listener runs.
 */
function harness() {
  const listeners = {};
  const ta = {
    value: "",
    addEventListener: (t, f) => (listeners[t] = f),
    removeEventListener: () => {},
  };
  const pty = [];
  let keyHandler = () => true;
  const term = {
    textarea: ta,
    attachCustomKeyEventHandler: (h) => (keyHandler = h),
  };
  const ime = setupImeInput(term, (d) => pty.push(d));
  const route = (data) => {
    const out = ime.route(data);
    if (out) pty.push(out);
  };
  return {
    pty,
    step: (box, xtermData) => {
      ta.value = box;
      if (xtermData !== undefined) route(xtermData);
      listeners.input({ inputType: "insertText" });
    },
    /** ⌘V: WebKit inserts into the textarea; xterm may also emit the text. */
    paste: (box, xtermData) => {
      if (xtermData !== undefined) route(xtermData);
      ta.value = box;
      listeners.input({ inputType: "insertFromPaste" });
    },
    xterm: route,
    compose: () => listeners.compositionstart(),
    key: (k) => keyHandler({ type: "keydown", key: k }),
  };
}

let failures = 0;
const check = (name, got, want) => {
  const ok = JSON.stringify(got) === JSON.stringify(want);
  if (!ok) failures++;
  console.log(
    `${ok ? "PASS" : "FAIL"}  ${name}\n      got  ${JSON.stringify(got)}\n      want ${JSON.stringify(want)}`,
  );
};

// 1. The trace measured in the app for "한글 " + Enter — box contents and
//    xterm emissions taken verbatim from the instrumented build's log.
{
  const h = harness();
  h.step("ㅎ", "ㅎ");
  h.step("하");
  h.step("한");
  h.step("한");
  h.step("한ㄱ", "ㄱ");
  h.step("한그");
  h.step("한글");
  h.step("한글");
  h.step("한글 ", " "); // xterm's space arrives before the bridge sees 글
  h.xterm("\r");
  check("recorded 한글 trace", h.pty.join(""), "한글 \r");
}

// 2. English is xterm's alone: it never reaches the textarea, so the bridge
//    must not interfere with it.
{
  const h = harness();
  "ls -l".split("").forEach(h.xterm);
  h.xterm("\r");
  check("ascii untouched", h.pty.join(""), "ls -l\r");
}

// 3. A held syllable is committed before whatever follows it.
{
  const h = harness();
  h.step("ㅎ", "ㅎ");
  h.step("한");
  check("tail held while composing", h.pty.join(""), "");
  h.xterm("\r");
  check("Enter commits it first", h.pty.join(""), "한\r");
}

// 4. Paste is not composition: spaces survive and nothing is held back.
{
  const h = harness();
  h.paste("한글 붙여넣기");
  check("paste kept whole", h.pty.join(""), "한글 붙여넣기");
}

// 4b. When xterm's paste handler delivers the text itself, it must land once.
{
  const h = harness();
  h.paste("한글 붙여넣기", "\x1b[200~한글 붙여넣기\x1b[201~");
  check("bracketed paste, no echo", h.pty.join(""), "\x1b[200~한글 붙여넣기\x1b[201~");
}

// 4c. Pasting on top of a composing syllable commits it first.
{
  const h = harness();
  h.step("ㅎ", "ㅎ");
  h.step("한");
  h.paste("한붙여넣기");
  check("paste after composing", h.pty.join(""), "한붙여넣기");
}

// 5. Backspace: the IME owns it while composing, xterm otherwise.
{
  const h = harness();
  h.step("ㅎ", "ㅎ");
  h.step("한");
  check("composing → xterm must not send \\x7f", h.key("Backspace"), false);
  h.step("하");
  h.step("");
  check("nothing emitted while composing", h.pty.join(""), "");
  check("idle → xterm handles Backspace", h.key("Backspace"), true);
  check("other keys untouched", h.key("Enter"), true);
}

// 6. Where composition events fire, xterm's own IME path is correct and the
//    bridge stands down entirely.
{
  const h = harness();
  h.compose();
  h.step("ㅎ", "ㅎ");
  h.step("한");
  h.xterm("한");
  check("native IME → bridge silent", h.pty.join(""), "ㅎ한");
  check("native IME → Backspace is xterm's", h.key("Backspace"), true);
}

// 7. Successive lines: each syllable lands once, in order.
{
  const h = harness();
  h.step("ㅎ", "ㅎ");
  h.step("한ㄱ", "ㄱ");
  h.step("한글");
  h.xterm("\r");
  h.step("한글ㄱ", "ㄱ");
  h.step("한글가");
  h.xterm("\r");
  check("across lines", h.pty.join(""), "한글\r가\r");
}

console.log(failures ? `\n${failures} FAILURE(S)` : "\nall checks passed");
process.exit(failures ? 1 : 0);
