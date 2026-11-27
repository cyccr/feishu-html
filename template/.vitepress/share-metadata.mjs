export const SITE_NAME = process.env.SITE_NAME?.trim() || '飞书文档中心';
export const DEFAULT_DESCRIPTION = '公开指南、使用说明与常见问题。';
export const ICON_VERSION = '49e7fc5205f5';

export function createDescription(markdown, title) {
  const lines = [];
  let fenceCharacter = '';
  let fenceLength = 0;
  for (const line of String(markdown).split(/\r?\n/)) {
    const fence = line.match(/^\s*(`{3,}|~{3,})(.*)$/);
    if (fenceCharacter) {
      if (fence && fence[1][0] === fenceCharacter && fence[1].length >= fenceLength && !fence[2].trim()) {
        fenceCharacter = '';
      }
      continue;
    }
    if (fence) {
      fenceCharacter = fence[1][0];
      fenceLength = fence[1].length;
      continue;
    }
    if (/^## 下级文档\s*$/.test(line)) break;
    if (/^\s{0,3}#{1,6}(?:\s|$)/.test(line) || /^\s*\[[^\]]+\]:/.test(line)) continue;
    lines.push(line.replace(/^\s*(?:>\s*|[-*+]\s+|\d+[.)]\s+)/, ''));
  }

  const entities = { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", '#39': "'", nbsp: ' ' };
  const text = lines.join(' ')
    .replace(/<script\b[^>]*>[\s\S]*?<\/script>|<style\b[^>]*>[\s\S]*?<\/style>/gi, ' ')
    .replace(/!\[[^\]]*\]\([^)]*\)/g, ' ')
    .replace(/<[^>]*>/g, ' ')
    .replace(/\[([^\]]+)\]\([^)]*\)/g, '$1')
    .replace(/\[([^\]]+)\]\[[^\]]*\]/g, '$1')
    .replace(/(\*\*|__|~~)(.*?)\1/g, '$2')
    .replace(/(?<![\p{L}\p{N}_])([*_])(\S(?:.*?\S)?)\1(?![\p{L}\p{N}_])/gu, '$2')
    .replace(/`/g, '')
    .replace(/&(amp|lt|gt|quot|apos|nbsp|#\d{1,3});/g, (entity, name) => {
      if (name[0] !== '#') return entities[name];
      const code = Number(name.slice(1));
      return code >= 32 && code <= 126 ? String.fromCharCode(code) : entity;
    })
    .replace(/\s+/g, ' ')
    .trim();
  if (!text) return `${title || '文档'}的相关说明与参考资料。`;
  const characters = [...text];
  return characters.length > 120 ? characters.slice(0, 120).join('') + '…' : text;
}

export function createShareHead(pageData, origin) {
  const route = pageData.relativePath.replace(/(^|\/)index\.md$/, '$1').replace(/\.md$/, '.html');
  const url = new URL('/' + route, origin).href;
  const title = pageData.title && pageData.title !== SITE_NAME ? `${pageData.title} | ${SITE_NAME}` : SITE_NAME;
  const description = pageData.description?.trim() || DEFAULT_DESCRIPTION;
  const properties = {
    'og:title': title,
    'og:description': description,
    'og:type': pageData.relativePath.startsWith('articles/') ? 'article' : 'website',
    'og:url': url,
    'og:site_name': SITE_NAME,
    'og:locale': 'zh_CN',
    'og:image': new URL(`/share-logo.png?v=${ICON_VERSION}`, origin).href,
    'og:image:type': 'image/png',
    'og:image:width': '512',
    'og:image:height': '512',
    'og:image:alt': `${SITE_NAME}图标`,
  };
  return [
    ['link', { rel: 'canonical', href: url }],
    ...Object.entries(properties).map(([property, content]) => ['meta', { property, content }]),
  ];
}
