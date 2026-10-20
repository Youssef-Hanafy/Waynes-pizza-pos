/*
 * The counter register is an Elo tablet whose Android 10 WebView is older than
 * CSS cascade layers (`@layer`, Chrome 99+).  Tailwind puts every style inside
 * `@layer`, so that WebView threw them all away and fell back to a hand-kept
 * copy of the CSS from 2026-10-08 (legacy-webview.css).  That copy also beat
 * the real styles on newer screens, so the POS flipped between the old and the
 * new look (owner, 2026-10-20).
 *
 * Instead, the layers are unwrapped here, after Tailwind, on every build: the
 * contents stay in the same order (theme, base, components, utilities, then
 * our own rules), which is the same priority the layers gave them.  Every
 * browser — the old Elo and anything newer — now reads the one, current CSS.
 */
const flattenCascadeLayers = {
  postcssPlugin: "wayne-flatten-cascade-layers",
  OnceExit(root) {
    let found = true;
    while (found) {
      found = false;
      root.walkAtRules("layer", (rule) => {
        found = true;
        // `@layer a, b;` only names the order; `@layer x { … }` keeps its contents in place.
        if (rule.nodes && rule.nodes.length) rule.replaceWith(rule.nodes);
        else rule.remove();
      });
    }
  },
};

const postcssConfig = {
  plugins: ["@tailwindcss/postcss", flattenCascadeLayers],
};

export default postcssConfig;
