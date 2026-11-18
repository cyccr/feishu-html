import { parseFragment } from 'parse5';

// Resolve only published Wiki or document identities. Leave external URLs,
// unpublished documents, and already-local paths to the normal renderer.
function localDestination(url, attr, documents, assets) {
  const bare = /^([A-Za-z0-9_-]+)([?#].*)?$/.exec(url);
  if (bare) {
    const path = attr === 'src' ? assets.get(bare[1]) : documents.get(bare[1]) ?? assets.get(bare[1]);
    return path ? path + (bare[2] || '') : url;
  }
  if (attr !== 'href' || !/^(?:https?:)?\/\//i.test(url)) return url;
  const parsed = URL.parse(url, 'https://feishu.cn');
  if (!parsed || parsed.username || parsed.password || !/(^|\.)(feishu\.cn|larksuite\.com|larkoffice\.com)$/i.test(parsed.hostname)) return url;
  const match = /^\/(?:wiki|docx?|docs|sheets|base|slides|mindnotes|file|drive\/file)\/([A-Za-z0-9_-]+)\/?$/.exec(parsed.pathname);
  const path = match && documents.get(match[1]);
  return path ? path + parsed.search + parsed.hash : url;
}

// Native tables, boards and callouts can already be HTML when they reach
// VitePress. Change attribute source ranges only; preserve all other bytes.
function rewriteHtml(html, resolve) {
  if (!/<(?:a|img)\s/i.test(html)) return html;
  const changes = [];
  function visit(node) {
    if (['pre', 'code', 'script', 'style'].includes(node.tagName)) return;
    const name = node.tagName === 'a' ? 'href' : node.tagName === 'img' ? 'src' : null;
    const attr = name && node.attrs.find(attr => attr.name === name);
    const location = attr && node.sourceCodeLocation?.attrs?.[name];
    if (location) {
      const url = resolve(attr.value, name);
      if (url !== attr.value) {
        const { startOffset, endOffset } = location;
        const escaped = url.replaceAll('&', '&amp;').replaceAll('"', '&quot;').replaceAll('<', '&lt;');
        changes.push({ startOffset, endOffset, text: name + '="' + escaped + '"' });
      }
    }
    node.childNodes?.forEach(visit);
  }
  visit(parseFragment(html, { sourceCodeLocationInfo: true }));
  for (const change of changes.sort((a, b) => b.startOffset - a.startOffset)) {
    html = html.slice(0, change.startOffset) + change.text + html.slice(change.endOffset);
  }
  return html;
}

export function installFeishuLinks(md, index) {
  const documents = new Map(Object.entries(index.documents));
  const assets = new Map(Object.entries(index.assets));
  const resolve = (url, attr) => localDestination(url, attr, documents, assets);
  const renderLink = md.renderer.rules.link_open;
  md.renderer.rules.link_open = (tokens, i, options, env, renderer) => {
    const token = tokens[i];
    const url = token.attrGet('href');
    const dest = url && resolve(url, 'href');
    if (!dest || dest === url) return renderLink(tokens, i, options, env, renderer);
    // These paths are already final. VitePress normalizes repeated slashes,
    // including those inside a query parameter such as ?next=https://...
    token.attrSet('href', dest);
    const pathname = dest.split(/[?#]/, 1)[0];
    if (pathname.startsWith('/assets/') && (!pathname.includes('.') || /\.(?:md|html)$/i.test(pathname))) {
      token.attrSet('download', '');
    }
    return renderer.renderToken(tokens, i, options);
  };
  md.core.ruler.after('inline', 'feishu_links', state => {
    // The anchor plugin also uses inline.content for the accessible label.
    // Keep the alias in the rendered tokens but out of the heading's title.
    for (let i = 0; i < state.tokens.length - 1; i++) {
      if (state.tokens[i].type === 'heading_open') {
        const inline = state.tokens[i + 1];
        inline.content = inline.content.replace(/<span class="feishu-block-anchor" id="[A-Za-z0-9_-]+" aria-hidden="true"><\/span>$/, '');
      }
    }
    function visit(token) {
      if (token.type === 'image') {
        const src = token.attrGet('src');
        if (src) token.attrSet('src', resolve(src, 'src'));
      } else if (token.type === 'html_inline' || token.type === 'html_block') {
        token.content = rewriteHtml(token.content, resolve);
      }
      token.children?.forEach(visit);
    }
    state.tokens.forEach(visit);
  });
}
