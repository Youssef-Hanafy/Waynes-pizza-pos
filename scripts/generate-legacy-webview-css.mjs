import { readFile, writeFile } from "node:fs/promises";

function closingBrace(source, opening) {
  let depth = 0; let quote = null; let comment = false;
  for (let i = opening; i < source.length; i += 1) {
    const character = source[i]; const next = source[i + 1];
    if (comment) { if (character === "*" && next === "/") { comment = false; i += 1; } continue; }
    if (quote) { if (character === "\\") i += 1; else if (character === quote) quote = null; continue; }
    if (character === "/" && next === "*") { comment = true; i += 1; }
    else if (character === '"' || character === "'") quote = character;
    else if (character === "{") depth += 1;
    else if (character === "}" && --depth === 0) return i;
  }
  return -1;
}

function flatten(source) {
  const expression = /@layer\s+[^;{]+([;{])/g;
  let cursor = 0; let output = ""; let match;
  while ((match = expression.exec(source))) {
    output += source.slice(cursor, match.index);
    if (match[1] === ";") { cursor = expression.lastIndex; continue; }
    const opening = expression.lastIndex - 1;
    const closing = closingBrace(source, opening);
    if (closing < 0) throw new Error("Unclosed CSS cascade layer.");
    output += flatten(source.slice(opening + 1, closing));
    cursor = closing + 1; expression.lastIndex = cursor;
  }
  return output + source.slice(cursor);
}

function removeFontFaces(source) {
  const expression = /@font-face\s*\{/g;
  let cursor = 0; let output = ""; let match;
  while ((match = expression.exec(source))) {
    output += source.slice(cursor, match.index);
    const opening = expression.lastIndex - 1;
    const closing = closingBrace(source, opening);
    if (closing < 0) throw new Error("Unclosed @font-face rule.");
    cursor = closing + 1;
    expression.lastIndex = cursor;
  }
  return output + source.slice(cursor);
}

const [input, output] = process.argv.slice(2);
if (!input || !output) throw new Error("Usage: node generate-legacy-webview-css.mjs INPUT OUTPUT");
const css = await readFile(input, "utf8");
await writeFile(
  output,
  `/* Generated legacy WebView fallback. Do not hand-edit. */\n:root{--wayne-legacy-webview-fallback:1}\n${removeFontFaces(flatten(css))}`,
);
