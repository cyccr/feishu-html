import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createHash } from 'node:crypto';
import matter from 'gray-matter';
import { createDescription, createShareHead } from './template/.vitepress/share-metadata.mjs';
import { normalizeExport } from './normalize-export.mjs';

test('article summaries omit code, images, headings and generated child directories', () => {
  const body = '# 文章标题\r\n\r\n```c\r\nprivate_code();\r\n```\r\n' +
    '![截图](/assets/photo.png)\r\n修改 **example_audio_sdk** 配置，参见[使用说明](https://example.com)。\r\n' +
    '\r\n## 下级文档\r\n\r\n- [其他内容](/articles/child.html)';
  assert.equal(createDescription(body, '标题'), '修改 example_audio_sdk 配置，参见使用说明。');
  assert.match(createDescription('# 空文档\n\n![图片](/assets/a.png)', '空文档'), /空文档/);
});

test('long summaries end at a Unicode character boundary', () => {
  const summary = createDescription('😀'.repeat(130), '标题');
  assert.equal([...summary].length, 121);
  assert.equal(summary, '😀'.repeat(120) + '…');
});

test('share metadata uses each article title, canonical HTML URL and absolute PNG URL', () => {
  const head = createShareHead({ title: '蓝牙说明', description: '蓝牙配置方法。', relativePath: 'articles/node.md' }, 'https://example.com');
  const properties = Object.fromEntries(head.filter(entry => entry[0] === 'meta').map(entry => [entry[1].property, entry[1].content]));
  assert.equal(head[0][1].href, 'https://example.com/articles/node.html');
  assert.equal(properties['og:url'], head[0][1].href);
  assert.equal(properties['og:title'], '蓝牙说明 | 飞书文档中心');
  assert.equal(properties['og:description'], '蓝牙配置方法。');
  assert.equal(properties['og:type'], 'article');
  const image = new URL(properties['og:image']);
  const version = createHash('sha256').update(fs.readFileSync(new URL('./template/public/share-logo.png', import.meta.url))).digest('hex').slice(0, 12);
  assert.equal(image.origin, 'https://example.com');
  assert.equal(image.pathname, '/share-logo.png');
  assert.equal(image.searchParams.get('v'), version);
  assert.equal(properties['og:image:alt'], '飞书文档中心图标');
  assert.equal(properties['og:image:width'], '512');
  const homepage = createShareHead({ title: '飞书文档中心', description: '', relativePath: 'index.md' }, 'https://example.com');
  assert.equal(homepage[0][1].href, 'https://example.com/');
  assert.equal(homepage.find(entry => entry[1].property === 'og:title')[1].content, '飞书文档中心');
});

test('normalization creates per-document summaries while preserving existing summaries and article bodies', t => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'feishu-share-test-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const exported = path.join(root, 'export');
  fs.mkdirSync(path.join(exported, 'docs'), { recursive: true });
  const tree = [{ filename: 'auto.md', title: '自动摘要' }, { filename: 'custom.md', title: '自定义摘要' }];
  fs.writeFileSync(path.join(exported, 'docs.json'), JSON.stringify(tree));
  const body = '# 自动摘要\n\n配置 BLE 参数。\n\n```c\n#define VALUE 1\n```\n';
  const custom = '---\ntitle: 自定义摘要\ndescription: 保留这段自定义说明。\n---\n\n原始内容。\n';
  fs.writeFileSync(path.join(exported, 'docs', 'auto.md'), body);
  fs.writeFileSync(path.join(exported, 'docs', 'custom.md'), custom);
  const source = path.join(root, 'source');
  normalizeExport(exported, source);
  const normalized = matter(fs.readFileSync(path.join(source, 'articles', 'auto.md'), 'utf8'));
  assert.equal(normalized.data.description, '配置 BLE 参数。');
  assert.equal(normalized.content.trim(), body.trim());
  assert.equal(fs.readFileSync(path.join(source, 'articles', 'custom.md'), 'utf8'), custom);
});
