import katex from "katex";
import type { MarkedExtension, TokenizerAndRendererExtension } from "marked";
import "katex/dist/katex.min.css";

/**
 * TeX math in the markdown preview, rendered by KaTeX.
 *
 * Four delimiters, because files written by agents use all of them:
 * `$$…$$` and `\[…\]` for display math, `$…$` and `\(…\)` inline. These
 * tokenizers run before marked's own, which matters for the backslash forms —
 * left to marked, `\(` is an escaped parenthesis and the delimiter is gone
 * before anything could see it.
 *
 * `$` follows pandoc's rule so prices are not formulas: the opening `$` is not
 * followed by a space, the closing one is not preceded by a space nor followed
 * by a digit. `$5 and $10` stays text.
 *
 * A formula KaTeX cannot parse is shown as its source in red rather than
 * throwing, so one typo does not blank the whole preview.
 */

function render(tex: string, displayMode: boolean): string {
  return katex.renderToString(tex, {
    displayMode,
    throwOnError: false,
    output: "html",
  });
}

const DISPLAY_START = /^ {0,3}(\$\$|\\\[)/;

const blockMath: TokenizerAndRendererExtension = {
  name: "blockMath",
  level: "block",
  start(src) {
    return src.match(/(^|\n) {0,3}(\$\$|\\\[)/)?.index;
  },
  tokenizer(src) {
    const m =
      /^ {0,3}\$\$([\s\S]+?)\$\$[ \t]*(?:\n|$)/.exec(src) ??
      /^ {0,3}\\\[([\s\S]+?)\\\][ \t]*(?:\n|$)/.exec(src);
    if (!m || !DISPLAY_START.test(src)) return;
    return { type: "blockMath", raw: m[0], text: m[1].trim() };
  },
  renderer(token) {
    return `<div class="math-display">${render(token.text, true)}</div>\n`;
  },
};

const inlineMath: TokenizerAndRendererExtension = {
  name: "inlineMath",
  level: "inline",
  start(src) {
    return src.match(/\$|\\[([]/)?.index;
  },
  tokenizer(src) {
    let m = /^\$\$([\s\S]+?)\$\$/.exec(src) ?? /^\\\[([\s\S]+?)\\\]/.exec(src);
    if (m) return { type: "inlineMath", raw: m[0], text: m[1].trim(), display: true };
    m = /^\\\(([\s\S]+?)\\\)/.exec(src) ?? /^\$(?!\s)((?:\\\$|[^$\n])+?)(?<!\s)\$(?!\d)/.exec(src);
    if (m) return { type: "inlineMath", raw: m[0], text: m[1], display: false };
  },
  renderer(token) {
    return render(token.text, Boolean(token.display));
  },
};

export const markedMath: MarkedExtension = { extensions: [blockMath, inlineMath] };
