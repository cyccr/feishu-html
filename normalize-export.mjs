import * as fs from 'node:fs';
import path from 'node:path';
import matter from 'gray-matter';
import { createDescription } from './template/.vitepress/share-metadata.mjs';

export function normalizeExport(exportDirectory, source) {
  const root = path.resolve(exportDirectory, 'docs');
  const tree = JSON.parse(fs.readFileSync(path.join(exportDirectory, 'docs.json'), 'utf8'));
  const pages = [];
  const documents = new Map();
  const media = new Map();
  function walk(nodes, depth = 0) {
    return nodes.map(node => {
      const relative = String(node.filename || '');
      const input = path.resolve(root, relative);
      if (!relative.endsWith('.md') || !input.startsWith(root + path.sep)) {
        throw new Error('Invalid document filename in Feishu export.');
      }
      if (fs.lstatSync(input).isSymbolicLink()) throw new Error('Export contains a symbolic link.');
      const output = path.join(source, 'articles', relative);
      fs.mkdirSync(path.dirname(output), { recursive: true });
      const markdown = fs.readFileSync(input, 'utf8');
      const parsed = matter(markdown);
      if (typeof parsed.data.description === 'string' && parsed.data.description.trim()) {
        fs.copyFileSync(input, output);
      } else {
        parsed.data.description = createDescription(parsed.content, parsed.data.title || node.title || node.node_token);
        fs.writeFileSync(output, matter.stringify(parsed.content, parsed.data));
      }
      const link = '/articles/' + relative.split(path.sep).join('/').replace(/\.md$/, '.html').replace(/\/index\.html$/, '/');
      const item = { text: String(node.title || node.node_token), link };
      if (node.node_token) documents.set(node.node_token, link);
      if (node.obj_token && !documents.has(node.obj_token)) documents.set(node.obj_token, link);
      pages.push({ ...item, depth });
      if (node.children?.length) item.items = walk(node.children, depth + 1);
      return item;
    });
  }
  const navigation = walk(tree);
  if (!pages.length) throw new Error('No documents were exported. The current website is preserved.');
  const assets = path.join(root, 'assets');
  if (fs.existsSync(assets)) {
    function rejectSymlinks(directory) {
      for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
        if (entry.isSymbolicLink()) throw new Error('Export contains a symbolic link.');
        if (entry.isDirectory()) rejectSymlinks(path.join(directory, entry.name));
      }
    }
    rejectSymlinks(assets);
    // The pinned exporter names downloads <token>.<ext> and boards <token>-board.<ext>.
    for (const entry of fs.readdirSync(assets, { withFileTypes: true })) {
      if (!entry.isFile()) continue;
      const token = path.parse(entry.name).name.replace(/-board$/, '');
      media.set(token, '/assets/' + encodeURIComponent(entry.name));
    }
    fs.cpSync(assets, path.join(source, 'public', 'assets'), { recursive: true });
  }
  const config = path.join(source, '.vitepress');
  fs.mkdirSync(config, { recursive: true });
  fs.writeFileSync(path.join(config, 'feishu-links.json'), JSON.stringify({
    documents: Object.fromEntries(documents), assets: Object.fromEntries(media),
  }));
  return { pages, navigation };
}
