import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createRequire } from 'node:module';
import { completeExport } from './feishu-source.mjs';
import { normalizeExport } from './normalize-export.mjs';

function fixture(t, readValues) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'feishu-sheet-test-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const exported = path.join(root, 'export');
  fs.mkdirSync(path.join(exported, 'docs'), { recursive: true });
  fs.writeFileSync(path.join(exported, 'docs', 'existing.md'), '# 现有文档\n\n更新后的正文');
  const requests = [];
  t.mock.method(globalThis, 'fetch', async input => {
    const url = new URL(input);
    requests.push(url);
    let data;
    if (url.pathname.endsWith('/tenant_access_token/internal')) {
      return Response.json({ code: 0, tenant_access_token: 'test-token' });
    }
    if (url.pathname.endsWith('/nodes')) {
      data = { items: [
        { node_token: 'existing', obj_type: 'docx', title: '现有文档' },
        { node_token: 'spreadsheet', obj_token: 'sheet-token', obj_type: 'sheet', title: '' },
      ] };
    } else if (url.pathname.endsWith('/sheets/query')) {
      data = { sheets: [
        { sheet_id: 'first', title: 'Sheet1', index: 0, grid_properties: { row_count: 51, column_count: 101 } },
        { sheet_id: 'empty', title: '空工作表', index: 1, grid_properties: { row_count: 1, column_count: 1 } },
      ] };
    } else {
      data = readValues(decodeURIComponent(url.pathname.split('/values/')[1]));
    }
    return Response.json({ code: 0, data });
  });
  const environment = {
    FEISHU_APP_ID: 'test-app', FEISHU_APP_SECRET: 'test-secret', FEISHU_SPACE_ID: 'test-space',
    SITE_URL: 'https://example.com',
  };
  return { root, exported, requests, environment };
}

test('a new spreadsheet publishes alongside existing documents and reads every grid batch', async t => {
  const { root, exported, requests, environment } = fixture(t, range => {
    const values = {
      'first!A1:CV50': [['<script>{{value}}</script>', 0, false, [{ text: '富' }, { text: '文本' }]], null, ['第三行\n第二段']],
      'first!CW51:CW51': [['末列末行']],
    }[range] || [];
    return { valueRange: { values } };
  });
  const counts = await completeExport(exported, { mode: 'space', rootNodeToken: '' }, environment);
  assert.deepEqual(counts, { documents: 1, spreadsheets: 1, files: 0, pdfs: 0 });
  const markdown = fs.readFileSync(path.join(exported, 'docs', 'spreadsheet.md'), 'utf8');
  assert.match(markdown, /title: 未命名表格/);
  assert.match(markdown, /<table v-pre>/);
  assert.match(markdown, /&lt;script&gt;\{\{value\}\}&lt;\/script&gt;/);
  assert.match(markdown, /<td>0<\/td><td>false<\/td><td>富文本<\/td>/);
  assert.match(markdown, /第三行<br>第二段/);
  assert.match(markdown, /<th scope="col">CW<\/th>/);
  assert.match(markdown, /<th scope="row">51<\/th>/);
  assert.match(markdown, /末列末行/);
  assert.match(markdown, /空工作表\n\n此工作表暂无内容。/);
  const result = normalizeExport(exported, path.join(root, 'source'));
  assert.equal(result.pages.length, 2);
  assert.equal(result.pages[1].link, '/articles/spreadsheet.html');
  assert.match(fs.readFileSync(path.join(root, 'source', 'articles', 'existing.md'), 'utf8'), /更新后的正文/);
  const cellRequests = requests.filter(url => url.pathname.includes('/values/'));
  assert.equal(cellRequests.length, 5);
  assert.ok(cellRequests.every(url => url.searchParams.get('valueRenderOption') === 'FormattedValue'));
});

test('a failed sheet read cannot be mistaken for an empty spreadsheet', async t => {
  const { exported, environment } = fixture(t, () => ({}));
  await assert.rejects(completeExport(exported, { mode: 'space', rootNodeToken: '' }, environment), /Missing spreadsheet cell values/);
  assert.equal(fs.existsSync(path.join(exported, 'docs.json')), false);
});

function embeddedFixture(t, options = {}) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'feishu-embedded-sheet-test-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const exported = path.join(root, 'export');
  fs.mkdirSync(path.join(exported, 'docs'), { recursive: true });
  const document = path.join(exported, 'docs', 'article.md');
  const markdown = '# 文章\n\n| 原生表格 | 内容 |\n| --- | --- |\n| 保留 | 原内容 |\n\n' +
    '## 第一张表\n\n<!-- feishu-embedded-sheet:workbook_first -->\n\n' +
    '## 第二张表\n\n<!-- feishu-embedded-sheet:workbook_second -->\n\n' +
    '> <!-- feishu-embedded-sheet:workbook_first -->\n\n表格后的正文\n';
  fs.writeFileSync(document, markdown);
  const requests = [];
  t.mock.method(globalThis, 'fetch', async input => {
    const url = new URL(input);
    requests.push(url);
    if (url.pathname.endsWith('/tenant_access_token/internal')) {
      return Response.json({ code: 0, tenant_access_token: 'test-token' });
    }
    let data;
    if (url.pathname.endsWith('/nodes')) {
      data = { items: [{ node_token: 'article', obj_type: 'docx', title: '文章' }] };
    } else if (url.pathname.endsWith('/sheets/query')) {
      const sheetIds = options.missingSheet ? ['first'] : ['first', 'second', 'unreferenced'];
      data = { sheets: sheetIds.map(sheet_id => ({
        sheet_id, title: sheet_id, grid_properties: { row_count: 3, column_count: 2 },
      })) };
    } else if (url.pathname.includes('/values/')) {
      const range = decodeURIComponent(url.pathname.split('/values/')[1]);
      const values = range.startsWith('first!')
        ? [['项目', '说明'], ['适用场景', [{ text: options.currentValue || '蓝牙' }, { text: '设备' }]], ['标签', '<script>{{value}}</script> $&']]
        : [['计数', 0], ['开关', false], ['备注', '第一行\n第二行']];
      data = options.failedRead ? {} : { valueRange: { values } };
    } else {
      throw new Error(`Unexpected API request: ${url.pathname}`);
    }
    return Response.json({ code: 0, data });
  });
  return { root, exported, document, markdown, requests, environment: { FEISHU_SPACE_ID: 'space' } };
}

test('embedded worksheets publish at their original positions with rich text, escaping and repeated references', async t => {
  const { root, exported, document, requests, environment } = embeddedFixture(t);
  const counts = await completeExport(exported, { mode: 'space' }, environment);
  assert.deepEqual(counts, { documents: 1, spreadsheets: 0, files: 0, pdfs: 0 });
  const markdown = fs.readFileSync(document, 'utf8');
  assert.match(markdown, /\| 保留 \| 原内容 \|/);
  assert.match(markdown, /第一张表\n+<table v-pre>[\s\S]*蓝牙设备[\s\S]*第二张表\n+<table v-pre>/);
  assert.match(markdown, /&lt;script&gt;\{\{value\}\}&lt;\/script&gt; \$&amp;/);
  assert.match(markdown, /<td>0<\/td>/);
  assert.match(markdown, /<td>false<\/td>/);
  assert.match(markdown, /第一行<br>第二行/);
  assert.match(markdown, /> <table v-pre>[^\n]*蓝牙设备[^\n]*<\/table>\n> \n+表格后的正文/);
  assert.equal(markdown.includes('feishu-embedded-sheet:'), false);
  assert.equal(markdown.includes('scope="row"'), false);
  assert.equal(requests.filter(url => url.pathname.endsWith('/sheets/query')).length, 1);
  assert.equal(requests.filter(url => url.pathname.includes('/values/')).length, 2);
  assert.equal(requests.some(url => url.pathname.includes('unreferenced!')), false);
  const output = path.join(root, 'source');
  normalizeExport(exported, output);
  assert.match(fs.readFileSync(path.join(output, 'articles', 'article.md'), 'utf8'), /蓝牙设备/);
});

test('embedded sheet values are read again on the next export so changes enter publication content', async t => {
  const options = { currentValue: '旧版' };
  const { exported, document, markdown, environment } = embeddedFixture(t, options);
  await completeExport(exported, { mode: 'space' }, environment);
  assert.match(fs.readFileSync(document, 'utf8'), /旧版设备/);
  options.currentValue = '新版';
  fs.writeFileSync(document, markdown);
  await completeExport(exported, { mode: 'space' }, environment);
  assert.match(fs.readFileSync(document, 'utf8'), /新版设备/);
  assert.equal(fs.readFileSync(document, 'utf8').includes('旧版设备'), false);
});

test('missing embedded worksheets and failed cell reads abort export instead of publishing incomplete content', async t => {
  for (const options of [{ missingSheet: true }, { failedRead: true }]) {
    await t.test(JSON.stringify(options), async t => {
      const { exported, environment } = embeddedFixture(t, options);
      await assert.rejects(completeExport(exported, { mode: 'space' }, environment), /worksheet was not found|Missing spreadsheet cell values/);
      assert.equal(fs.existsSync(path.join(exported, 'docs.json')), false);
    });
  }
});

test('the document exporter and Markdown renderer preserve headings, code blocks and quotes directly after embedded sheets', async t => {
  const require = createRequire(import.meta.url);
  const exporter = createRequire(require.resolve('feishu-pages'));
  const { MarkdownRenderer } = exporter('feishu-docx/dist/markdown_renderer');
  const { BlockType } = exporter('feishu-docx/dist/types');
  require('./feishu-code-preload.cjs');
  const renderer = Object.create(MarkdownRenderer.prototype);
  const text = content => ({ elements: [{ text_run: { content, text_element_style: {} } }] });
  const blocks = [
    { block_type: BlockType.Heading3, heading3: text('1.1 SPP + BLE') },
    { block_type: BlockType.Sheet, sheet: { token: 'workbook_first' } },
    { block_type: BlockType.Heading3, heading3: text('1.2 HID') },
    { block_type: BlockType.Sheet, sheet: { token: 'workbook_second' } },
    { block_type: BlockType.Code, code: { ...text('#include <stdint.h>\n// ### literal code\nconst char *name = "<table>";'), style: { language: 1 } } },
    { block_type: BlockType.Heading2, heading2: text('工程结构') },
  ];
  const exportedBody = blocks.map(block => renderer.parseBlock(block, 0).toString()).join('\n');
  assert.match(exportedBody, /workbook_first -->\n### 1\.2 HID/);
  const { root, exported, document, environment } = embeddedFixture(t);
  fs.writeFileSync(document, '# 文章\n\n' + exportedBody +
    '\n\n> <!-- feishu-embedded-sheet:workbook_first -->\n> ### 引用内的标题\n>\n> 引用内的说明\n\n' +
    '- 列表项目\n\n  <!-- feishu-embedded-sheet:workbook_second -->\n  ### 列表内的标题\n');
  await completeExport(exported, { mode: 'space' }, environment);
  const { createMarkdownRenderer } = await import('vitepress');
  const markdownRenderer = await createMarkdownRenderer(root, {}, '/');
  const html = markdownRenderer.render(fs.readFileSync(document, 'utf8'), { cleanUrls: false });
  assert.match(html, /<h3\b[^>]*>1\.1 SPP \+ BLE/);
  assert.match(html, /<h3\b[^>]*>1\.2 HID/);
  assert.match(html, /<h2\b[^>]*>工程结构/);
  assert.match(html, /<div class="language-text[\s\S]*<pre\b/);
  assert.match(html, /(?:&lt;|&#x3C;|&#60;)stdint\.h(?:&gt;|>)/);
  assert.match(html, /### literal code/);
  assert.match(html, /(?:&lt;|&#x3C;|&#60;)table(?:&gt;|>)/);
  assert.match(html, /<blockquote>[\s\S]*<table\b[\s\S]*<h3\b[^>]*>引用内的标题[\s\S]*引用内的说明[\s\S]*<\/blockquote>/);
  assert.match(html, /<li>[\s\S]*列表项目[\s\S]*<table\b[\s\S]*<h3\b[^>]*>列表内的标题[\s\S]*<\/li>/);
  assert.equal(html.includes('feishu-embedded-sheet:'), false);
});
