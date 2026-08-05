# Korean input in a WKWebView terminal, and why OmniAgent left Tauri

A day of measurement, written down so nobody has to repeat it. Short version:
**a terminal built on xterm.js inside WKWebView loses Korean syllables, the
failure is a timing race so it differs per user and per launch, and the only
structural fix is a Chromium-based host.**

If you are here because Korean (or Vietnamese, or any inline-committing IME)
types as broken jamo in your Tauri app, skip to
[What to do about it](#what-to-do-about-it).

## The symptom

Typing `한글` into a pod put `ㅎㄱ` on the pty — first jamo of each syllable,
composed syllables gone. English was fine. The same tmux session, attached from
Terminal.app, took Korean perfectly, so neither tmux nor the pty was involved.

It was also *intermittent*: it worked before a reboot and not after, worked for
one user and not another, and flipped back and forth on the same machine across
app restarts. That intermittency is the interesting part — see
[Why it is not reproducible](#why-it-is-not-reproducible).

## What is actually happening

WKWebView fires **no composition events** for the macOS Korean IME. Instead the
IME rewrites the hidden textarea and reports each edit through `inputType`:

```
input  insertText            data="ㅎ"  isComposing=false  box="ㅎ"     ← new character
input  insertReplacementText data="하"  isComposing=false  box="하"     ← composing tail revised
input  insertReplacementText data="한"  isComposing=false  box="한"
input  insertText            data="ㄱ"  isComposing=false  box="한ㄱ"    ← previous char is final
```

xterm.js acts only on `insertText`, so every composed syllable is dropped and
only the jamo reach the pty. The textarea always holds the correct text — the
information is there, xterm.js just isn't looking at that signal.

The same page in Chrome, same machine, same IME, same minute:

```
keydown           key="ㅎ" keyCode=229
compositionstart  data=""
compositionupdate data="ㅎ"
input             insertCompositionText data="ㅎ" isComposing=true
...
compositionend    data="한"
```

Chromium models it as composition. WebKit models it as insert-and-replace. Both
receive the same calls from the OS.

## Why WebKit does this

Not an oversight. The macOS Korean IME never calls `setMarkedText:` — Hangul has
no candidate window, so each syllable is committed inline and revised in place.
WebKit recognizes this explicitly ([`WebViewImpl.mm`][webviewimpl]):

> If the input method only produced `insertText:` commands (no `setMarkedText:`,
> no other commands) AND there is no existing composition, this is a modeless
> insertion — e.g. Simple Telex or **Korean Hangul typing a character that
> commits inline**.

## Why it is not reproducible

This is the part that makes it expensive to debug. From the same file:

> When the IME calls `insertText:` during its `handleEventByInputMethod:`
> callback and then polls `selectedRange` to verify, **the queued `insertText:`
> hasn't reached the web process yet**, so the cursor appears not to have
> advanced. Modeless input methods (Vietnamese Simple Telex, Korean Hangul)
> interpret that stale cursor as "my insertion didn't stick" and **fall back to
> `setMarkedText:` for the rest of the session**.

So:

1. The IME inserts a syllable and immediately asks "did that land?"
2. WebKit has to ask the **WebContent process** — `hasMarkedText`,
   `selectedRange`, `markedRange` are all cross-process and asynchronous, with
   key events parked in a holding tank meanwhile.
3. If the answer reflects state the insertion hasn't reached yet, the IME
   concludes it failed and switches modes.
4. **That decision sticks for the whole session.**

Which mode a session lands in therefore depends on how fast the first few
keystrokes round-trip — process load at startup, machine speed, luck. Hence:
different per user, different per launch, sometimes different between Safari and
an app on the same machine at the same moment. It is not a state you can find
and fix; it is a race.

Chromium does not have this race: `RenderWidgetHostViewCocoa` implements
`NSTextInputClient` **in the browser process** against a cached copy of the text
and selection, so IME queries are answered immediately and consistently. That is
why the terminal in VS Code — same xterm.js — always works.

WebKit is actively reworking this area ([`310826@main`][fix], July 2025, plus
Korean/Vietnamese/Hindi/Zhuyin regression fixes through mid-2026). A fix ships
with macOS, so it does not help users on today's systems.

## What to do about it

**If you can choose your host: use Chromium (Electron).** It removes the class
of bug rather than working around it. This project ships both shells over one
frontend — `electron/` and `src-tauri/` — precisely so the choice is per
machine rather than per project.

**If you must stay on WKWebView:** `src/ime.ts` is a self-contained bridge —
MIT like the rest — that:

- emits from the textarea instead of xterm's key path — everything except a
  trailing character that could still be composing, released once it is final;
- claims composed text only, leaving ASCII, space and control keys on xterm's
  own path (taking those over breaks English and doubles spaces — ask how we
  know);
- stands down when composition events arrive, and takes over again when they
  stop, since a session can flip either way mid-run;
- treats paste (`insertFromPaste`) as text, not composition;
- echoes the held syllable at the cursor, because the terminal cannot draw
  something it has not been sent.

`tests/ime.test.mjs` replays the recorded WebKit event trace, xterm's
interleaved emissions included (`npm run test:ime`). The Electron build
carries the bridge too, inertly: composition events fire there, so it stands
down on the first one.

**Diagnostic:** `public/ime-check.html` reports in one screen whether a given
webview fires composition events. Open it in the app (⌘⇧I) and in Safari and
Chrome to see the split for yourself.

## Upstream

Reported by others before us; the diagnosis matches ours:

| | |
|---|---|
| [xterm.js#5704][5704] | PR: handle `insertReplacementText` for Korean IME on WKWebView/Safari |
| [xterm.js#6045][6045] | Deferred textarea diff duplicates or drops characters on key rollover |
| [xterm.js#5887][5887] | Second character lost when the IME reports keyCode 229 |
| [xterm.js#6065][6065] | `Ctrl+<letter>` and `Escape` dropped under a CJK IME — Chromium too |

[webviewimpl]: https://github.com/WebKit/WebKit/blob/main/Source/WebKit/UIProcess/mac/WebViewImpl.mm
[fix]: https://bugs.webkit.org/show_bug.cgi?id=295763
[5704]: https://github.com/xtermjs/xterm.js/pull/5704
[6045]: https://github.com/xtermjs/xterm.js/issues/6045
[5887]: https://github.com/xtermjs/xterm.js/issues/5887
[6065]: https://github.com/xtermjs/xterm.js/issues/6065
