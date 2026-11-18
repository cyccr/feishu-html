// Feishu fences add one delimiter newline after the literal source. VitePress
// trims all trailing whitespace before highlighting, including authored spaces.
export function preserveCodeWhitespace(md) {
  const highlight = md.options.highlight;
  md.options.highlight = (source, ...args) => {
    const literal = source.replace(/\n$/, '');
    // VitePress interprets [!code ...] comments as display directives. In an
    // exported example they are part of the source and must remain visible.
    if (/\[!code\b/i.test(literal)) {
      return '<pre v-pre class="vp-code" tabindex="0"><code>' + md.utils.escapeHtml(literal) + '</code></pre>';
    }
    const html = highlight(source, ...args);
    const tail = literal.slice(literal.trimEnd().length);
    return tail ? html.replace('</code></pre>', () => tail + '</code></pre>') : html;
  };
}
