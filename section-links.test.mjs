import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createRequire } from 'node:module';
import { createMarkdownRenderer } from 'vitepress';
import { normalizeExport } from './normalize-export.mjs';
import { installFeishuLinks } from './template/.vitepress/feishu-links.mjs';
import { preserveCodeWhitespace } from './template/.vitepress/code-whitespace.mjs';
import { installCodeCopy } from './template/.vitepress/theme/code-copy.mjs';

const require = createRequire(import.meta.url);
const exporter = createRequire(require.resolve('feishu-pages'));
const { MarkdownRenderer, BlockType, CodeLanguage } = exporter('feishu-docx');
const { JSDOM } = exporter('jsdom');
require('./feishu-code-preload.cjs');
const exporterUtils = exporter('./utils');

function run(content, style = {}) {
  return { elements: [{ text_run: { content, text_element_style: style } }] };
}

function linkBlock(id, label, url) {
  return { block_id: id, block_type: BlockType.Text, text: run(label, { link: { url }, bold: true }) };
}

function codeBlock(id, content, language) {
  return { block_id: id, block_type: BlockType.Code, code: { ...run(content), style: { language } } };
}

function page(id, blocks) {
  const root = { block_id: id, block_type: BlockType.Page, page: run('SDK'), children: blocks.map(b => b.block_id) };
  return new MarkdownRenderer({ document: { document_id: id }, blocks: [root, ...blocks] }).parse();
}

test('exporter links reach the exact source heading; code and assets survive the same export', async t => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'feishu-section-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const docs = path.join(dir, 'docs');
  fs.mkdirSync(path.join(docs, 'assets'), { recursive: true });
  const suffix = '?from=guide&next=https://example.org/a%2Fb#hidSecond';
  const url = 'https://demo.feishu.cn/wiki/targetNode' + suffix;
  const external = 'https://example.org/wiki/targetNode' + suffix;
  const literal = '[HID](' + url + ')\n<img src="photoToken">\n[附件](fileToken)';
  const original = page('guideObj', [
    linkBlock('a', 'HID 参数', url),
    linkBlock('b', 'Docx', 'https://demo.larksuite.com/docx/targetObj' + suffix),
    linkBlock('c', '外部链接', external),
    codeBlock('sample', literal, CodeLanguage.Markdown),
    { block_id: 'photo', block_type: BlockType.Image, image: { token: 'photoToken' } },
    { block_id: 'file', block_type: BlockType.File, file: { token: 'fileToken', name: 'manual.pdf' } },
  ]);
  // Same calls as the CLI: first Wiki nodes, then successfully downloaded files.
  let source = exporterUtils.replaceLinks(original, 'targetNode', '/articles/targetNode');
  source = exporterUtils.replaceLinks(source, 'photoToken', '/assets/photoToken.png');
  source = exporterUtils.replaceLinks(source, 'fileToken', '/assets/fileToken.pdf');
  fs.writeFileSync(path.join(docs, 'guide.md'), source);
  const headings = ['hidFirst', 'hidSecond'].map(id => ({
    block_id: id, block_type: BlockType.Heading3, heading3: run('HID 参数'),
  }));
  fs.writeFileSync(path.join(docs, 'targetNode.md'), page('targetObj', headings));
  for (const file of ['photoToken.png', 'fileToken.pdf', 'boardToken-board.png', 'readmeToken.md']) {
    fs.writeFileSync(path.join(docs, 'assets', file), 'fixture');
  }
  fs.writeFileSync(path.join(dir, 'docs.json'), JSON.stringify([
    { title: '指南', node_token: 'guide', obj_token: 'guideObj', filename: 'guide.md' },
    { title: '目标', node_token: 'targetNode', obj_token: 'targetObj', filename: 'targetNode.md' },
  ]));
  const output = path.join(dir, 'site');
  normalizeExport(dir, output);
  const index = JSON.parse(fs.readFileSync(path.join(output, '.vitepress', 'feishu-links.json'), 'utf8'));
  const md = await createMarkdownRenderer(output, {
    config(md) { preserveCodeWhitespace(md); installFeishuLinks(md, index); },
  }, '/');
  const render = markdown => new JSDOM(md.render(markdown, { cleanUrls: false })).window.document;
  const guide = render(fs.readFileSync(path.join(output, 'articles', 'guide.md'), 'utf8'));
  const target = render(fs.readFileSync(path.join(output, 'articles', 'targetNode.md'), 'utf8'));
  const links = [...guide.querySelectorAll('p a')].map(a => a.getAttribute('href'));
  const expected = '/articles/targetNode.html' + suffix;
  assert.deepEqual(links.slice(0, 3), [expected, expected, external]);
  assert.equal(target.getElementById('hidSecond')?.closest('h3'), target.querySelectorAll('h3')[1]);
  assert.deepEqual([...target.querySelectorAll('h3')].map(h => h.id), ['hid-参数', 'hid-参数-1']);
  assert.doesNotMatch(target.querySelector('h3 .header-anchor').getAttribute('aria-label'), /<span/);
  assert.equal(guide.querySelector('pre code').textContent, literal);
  assert.equal(guide.querySelector('img').getAttribute('src'), '/assets/photoToken.png');
  assert.ok(links.includes('/assets/fileToken.pdf'));

  const mixed = render([
    '<table><tr><td><a href="' + url + '">参数</a><code>&lt;img src="photoToken"&gt;</code></td></tr></table>',
    '`[HID](' + url + ')` [库外](https://demo.feishu.cn/wiki/other#keep)',
    '<img src="boardToken"/>',
    '[源文件](readmeToken)',
  ].join('\n\n'));
  assert.equal(mixed.querySelector('td a').getAttribute('href'), expected);
  assert.equal(mixed.querySelector('td code').textContent, '<img src="photoToken">');
  assert.equal(mixed.querySelector('p code').textContent, '[HID](' + url + ')');
  assert.equal(mixed.querySelector('p a').getAttribute('href'), 'https://demo.feishu.cn/wiki/other#keep');
  assert.equal(mixed.querySelector('img').getAttribute('src'), '/assets/boardToken-board.png');
  assert.equal(mixed.querySelector('a[download]').getAttribute('href'), '/assets/readmeToken.md');
});

test('clicking Copy keeps literal Shell, C/C++, Makefile and Markdown source', async t => {
  const slash = String.fromCharCode(92);
  const examples = [
    [CodeLanguage.Bash, '  $ printf ok ' + slash + '\n>   tail  \n\n'],
    [CodeLanguage.C, '#define ADD(x) ' + slash + '\n\t((x) + 1)'],
    [CodeLanguage.CPlusPlus, '#define TWICE(x) ' + slash + '\n    ((x) * 2)'],
    [CodeLanguage.Makefile, 'build:\n\tcc main.c -o main'],
    [CodeLanguage.C, 'int enabled = 1; // [!code ++]\n'],
    [CodeLanguage.Markdown, '```\n[HID](https://demo.feishu.cn/wiki/targetNode#hidSecond)\n```'],
  ];
  const md = await createMarkdownRenderer(process.cwd(), { config: preserveCodeWhitespace }, '/');
  const blocks = examples.map(([language, source], i) => codeBlock('c' + i, source, language));
  const dom = new JSDOM(md.render(page('samples', blocks), {}));
  t.after(() => dom.window.close());
  const { document, navigator } = dom.window;
  const clipboard = [];
  Object.defineProperty(navigator, 'clipboard', { value: { writeText: async value => clipboard.push(value) } });
  installCodeCopy(document);
  let defaultClicks = 0;
  dom.window.addEventListener('click', () => defaultClicks++);
  for (const [i, button] of [...document.querySelectorAll('button.copy')].entries()) {
    assert.equal(button.parentElement.querySelector('pre code').textContent, examples[i][1]);
    button.click();
    await Promise.resolve();
    assert.ok(button.classList.contains('copied'));
  }
  assert.deepEqual(clipboard, examples.map(([, source]) => source));
  assert.equal(defaultClicks, 0);
});
