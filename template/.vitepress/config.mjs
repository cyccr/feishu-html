import { defineConfig } from 'vitepress';
import fs from 'node:fs';
import { createShareHead, ICON_VERSION, SITE_NAME } from './share-metadata.mjs';
import { preserveCodeWhitespace } from './code-whitespace.mjs';

const docs = JSON.parse(fs.readFileSync(new URL('./sidebar.json', import.meta.url), 'utf8'));
const origin = new URL(process.env.SITE_URL || 'http://localhost:4173').origin;

function sidebarItems(items) {
  return items.map(item => {
    const label = String(item.text || '').replace(/[&<>"']/g, character => ({
      '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;',
    })[character]);
    const entry = { ...item, text: `<span class="sidebar-label" title="${label}">${label}</span>` };
    if (item.items?.length) {
      entry.items = sidebarItems(item.items);
      entry.collapsed = true;
    }
    return entry;
  });
}

// Keep the knowledge base homepage beside its categories in the navigation.
let navigation = docs;
if (docs.length === 1 && docs[0].items?.length) {
  const { items, ...homepage } = docs[0];
  navigation = [homepage, ...items];
}

export default defineConfig({
  lang: 'zh-CN',
  title: SITE_NAME,
  description: '公开指南、使用说明与常见问题。',
  cleanUrls: false,
  markdown: { config: preserveCodeWhitespace },
  lastUpdated: false,
  sitemap: { hostname: origin },
  head: [
    ['meta', { name: 'theme-color', content: '#285b51' }],
    ['link', { rel: 'icon', type: 'image/x-icon', href: `/favicon.ico?v=${ICON_VERSION}` }],
    ['link', { rel: 'icon', type: 'image/png', sizes: '32x32', href: `/favicon-32.png?v=${ICON_VERSION}` }],
    ['link', { rel: 'apple-touch-icon', sizes: '180x180', href: `/apple-touch-icon.png?v=${ICON_VERSION}` }],
  ],
  transformHead({ pageData }) {
    return createShareHead(pageData, origin);
  },
  themeConfig: {
    siteTitle: SITE_NAME,
    nav: [{ text: '首页', link: '/' }],
    sidebar: navigation.length ? [{ items: sidebarItems(navigation) }] : [],
    search: docs.length ? { provider: 'local', options: { translations: { button: { buttonText: '搜索文档', buttonAriaLabel: '搜索文档' } } } } : undefined,
    outline: { label: '本页目录', level: [2, 3] },
    docFooter: { prev: '上一篇', next: '下一篇' },
    returnToTopLabel: '返回顶部',
    sidebarMenuLabel: '目录',
    darkModeSwitchLabel: '外观',
    footer: { message: '知识，随时可读。' },
  },
});
