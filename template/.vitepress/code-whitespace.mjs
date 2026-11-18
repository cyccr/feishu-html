// Feishu fences add one delimiter newline after the literal source. VitePress
// trims all trailing whitespace before highlighting, including authored spaces.
export function preserveCodeWhitespace(md) {
  const highlight = md.options.highlight;
  md.options.highlight = (source, ...args) => {
    const html = highlight(source, ...args);
    const literal = source.replace(/\n$/, '');
    const tail = literal.slice(literal.trimEnd().length);
    return tail ? html.replace('</code></pre>', () => tail + '</code></pre>') : html;
  };
}
