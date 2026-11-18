import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { normalizeExport } from './normalize-export.mjs';

function fixture(t, tree) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'feishu-export-test-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const exported = path.join(root, 'export');
  fs.mkdirSync(path.join(exported, 'docs', 'assets'), { recursive: true });
  fs.writeFileSync(path.join(exported, 'docs.json'), JSON.stringify(tree));
  fs.writeFileSync(path.join(exported, 'docs', 'SUMMARY.md'), '- generated summary');
  return { exported, source: path.join(root, 'source') };
}

test('copies real document tree and mirrors root asset URLs without publishing exporter metadata', t => {
  const tree = [{ filename: 'node-a.md', title: '第一篇', children: [{ filename: 'node-b.md', title: '第二篇', children: [] }] }];
  const { exported, source } = fixture(t, tree);
  fs.writeFileSync(path.join(exported, 'docs', 'node-a.md'), '# 第一篇\n\n![图](/assets/photo.png)\n\n[第二篇](/articles/node-b)');
  fs.writeFileSync(path.join(exported, 'docs', 'node-b.md'), '# 第二篇');
  fs.writeFileSync(path.join(exported, 'docs', 'assets', 'photo.png'), 'image bytes');
  const result = normalizeExport(exported, source);
  assert.equal(result.pages.length, 2);
  assert.equal(result.navigation[0].items[0].link, '/articles/node-b.html');
  assert.equal(fs.readFileSync(path.join(source, 'public', 'assets', 'photo.png'), 'utf8'), 'image bytes');
  assert.equal(fs.existsSync(path.join(source, 'articles', 'SUMMARY.md')), false);
  assert.equal(fs.existsSync(path.join(source, 'docs.json')), false);
});

test('rejects an empty export even when SUMMARY.md exists', t => {
  const { exported, source } = fixture(t, []);
  assert.throws(() => normalizeExport(exported, source), /No documents/);
});

test('rejects missing document output rather than publishing an incomplete tree', t => {
  const { exported, source } = fixture(t, [{ filename: 'missing.md', title: 'missing' }]);
  assert.throws(() => normalizeExport(exported, source), /ENOENT/);
});

test('rejects exporter metadata pointing outside the document directory', t => {
  const { exported, source } = fixture(t, [{ filename: '../escape.md', title: 'escape' }]);
  assert.throws(() => normalizeExport(exported, source), /Invalid document filename/);
});

test('HTML links preserve query strings and anchors without rewriting code, assets or external URLs', async () => {
  const { createMarkdownRenderer } = await import('vitepress');
  const markdown = await createMarkdownRenderer(process.cwd(), {}, '/');
  const html = markdown.render([
    '[站内页面](/articles/node-b?from=manual#section)',
    '[Markdown 页面](/articles/node-c.md#code)',
    '[附件](/assets/manual.pdf)',
    '[外部网站](https://example.org/articles/node-b)',
    '```text\n/articles/node-b\n```',
  ].join('\n\n'), { cleanUrls: false });
  assert.match(html, /href="\/articles\/node-b\.html\?from=manual#section"/);
  assert.match(html, /href="\/articles\/node-c\.html#code"/);
  assert.match(html, /href="\/assets\/manual\.pdf"/);
  assert.match(html, /href="https:\/\/example.org\/articles\/node-b"/);
  assert.match(html, />\/articles\/node-b<\//);
});
