const { test } = require('node:test');
const assert = require('node:assert/strict');
const { createRequire } = require('node:module');

const requireExporter = createRequire(require.resolve('feishu-pages'));
const { MarkdownRenderer } = requireExporter('feishu-docx/dist/markdown_renderer');
const { BlockType, CodeLanguage } = requireExporter('feishu-docx/dist/types');
const { JSDOM } = requireExporter('jsdom');
const originalRenderText = MarkdownRenderer.prototype.parseTextBlock;
require('./feishu-code-preload.cjs');

test('code blocks preserve literal source and ignore text formatting styles', () => {
  const renderer = Object.create(MarkdownRenderer.prototype);
  const code = {
    style: { language: 1 },
    elements: [
      { text_run: { content: '#include <stdint.h>\n', text_element_style: { bold: true } } },
      { text_run: { content: '// comment\n', text_element_style: { italic: true } } },
      { text_run: { content: 'const char *tag = "<em>literal</em>";\n', text_element_style: {} } },
    ],
  };
  const markdown = renderer.parseBlock({ block_type: BlockType.Code, code }, 0).toString();
  assert.ok(markdown.includes('#include <stdint.h>\n// comment\nconst char *tag = "<em>literal</em>";'));
  assert.equal(markdown.includes('<b>#include'), false);
  assert.equal(markdown.includes('<em>// comment'), false);
});

test('regular paragraph formatting continues to use the original renderer', () => {
  const renderer = Object.create(MarkdownRenderer.prototype);
  const block = { block_type: BlockType.Text };
  const text = { elements: [
    { text_run: { content: '普通正文', text_element_style: { italic: true } } },
    { text_run: { content: '加粗正文', text_element_style: { bold: true } } },
  ] };
  const expected = originalRenderText.call(renderer, block, text).toString();
  assert.equal(renderer.parseTextBlock(block, text).toString(), expected);
});

test('embedded sheets retain a worksheet marker in document order even when unsupported blocks are hidden', () => {
  const renderer = Object.create(MarkdownRenderer.prototype);
  renderer.outputUnsupported = false;
  const paragraph = content => renderer.parseBlock({
    block_type: BlockType.Text,
    text: { elements: [{ text_run: { content, text_element_style: {} } }] },
  }, 0).toString();
  const markdown = paragraph('表格前的说明') + renderer.parseBlock({
    block_type: BlockType.Sheet,
    sheet: { token: 'workbook_first' },
  }, 0).toString() + paragraph('表格后的说明');
  assert.match(markdown, /表格前的说明[\s\S]*<!-- feishu-embedded-sheet:workbook_first -->[\s\S]*表格后的说明/);
});

test('an embedded sheet without a valid identifier fails instead of disappearing', () => {
  const renderer = Object.create(MarkdownRenderer.prototype);
  for (const sheet of [{}, { token: 'invalid' }, { token: '<script>_sheet' }]) {
    assert.throws(() => renderer.parseBlock({ block_type: BlockType.Sheet, sheet }, 0), /Invalid embedded spreadsheet identifier/);
  }
});

function textRun(content, style = {}) {
  return { elements: [{ text_run: { content, text_element_style: style } }] };
}

function page(blocks, children = blocks.map(block => block.block_id)) {
  const root = { block_id: 'sample', block_type: BlockType.Page, children, page: textRun('SDK') };
  const renderer = new MarkdownRenderer({ document: { document_id: 'sample' }, blocks: [root, ...blocks] });
  return { markdown: renderer.parse(), meta: renderer.meta };
}

function codeBlock(block_id, content, language = CodeLanguage.PlainText) {
  return { block_id, block_type: BlockType.Code, code: { ...textRun(content), style: { language } } };
}

async function renderHtml(markdown) {
  const { createMarkdownRenderer } = await import('vitepress');
  const { preserveCodeWhitespace } = await import('./template/.vitepress/code-whitespace.mjs');
  const md = await createMarkdownRenderer(process.cwd(), { config: preserveCodeWhitespace }, '/');
  return new JSDOM(md.render(markdown, { cleanUrls: false })).window.document;
}

function tablePage(values, columns, merge = {}, options = {}) {
  const cells = values.map((_, i) => 'cell' + i);
  const table = {
    block_id: 'table', block_type: BlockType.Table, table: { cells, property: {
      row_size: values.length / columns, column_size: columns, column_width: Array(columns).fill(90),
      merge_info: cells.map((_, i) => merge[i] || { row_span: 1, col_span: 1 }), ...options,
    } },
  };
  const blocks = values.flatMap((value, i) => [
    { block_id: cells[i], block_type: BlockType.TableCell, children: ['text' + i] },
    { block_id: 'text' + i, block_type: BlockType.Text, text: textRun(value) },
  ]);
  return page([table, ...blocks], ['table']).markdown;
}

test('native table cells keep literal pipes and adjacent column contents', async () => {
  const html = await renderHtml(tablePage(['模式', '说明', 'A | B', '启用标志'], 2, {}, { header_row: true }));
  assert.deepEqual([...html.querySelectorAll('tbody td')].map(cell => cell.textContent), ['A | B', '启用标志']);
});

test('rectangular merges cover their interiors and span within one HTML row group', async () => {
  const values = ['组', '', '模式', '', '', 'BLE', 'A', 'B', 'C'];
  const html = await renderHtml(tablePage(values, 3, { 0: { row_span: 2, col_span: 2 } }, { header_row: true }));
  const rows = [...html.querySelector('table').rows];
  assert.deepEqual(rows.map(row => [...row.cells].map(cell => cell.textContent.trim())), [['组', '模式'], ['BLE'], ['A', 'B', 'C']]);
  assert.equal(rows[0].cells[0].tagName, 'TH');
  assert.equal(rows[0].cells[0].rowSpan, 2);
  assert.equal(rows[0].cells[0].colSpan, 2);
  assert.equal(rows[0].parentNode, rows[1].parentNode);
});

test('code fences keep indentation, nested backticks, trailing whitespace and the next paragraph', async () => {
  const source = '\n    first();\n````\n    last();  \t\n\n';
  const html = await renderHtml(page([codeBlock('example', source),
    { block_id: 'after', block_type: BlockType.Text, text: textRun('后续正文') }]).markdown);
  assert.deepEqual([...html.querySelectorAll('pre code')].map(code => code.textContent), [source]);
  assert.equal(html.querySelector('p:last-child')?.textContent, '后续正文');
  assert.ok(html.querySelector('button.copy'));
});

test('only explicitly marked top-level opening YAML is consumed as page metadata', async () => {
  const example = page([codeBlock('yaml', 'speed: 115200', CodeLanguage.YAML)]);
  assert.equal(example.meta, undefined);
  assert.equal((await renderHtml(example.markdown)).querySelector('pre code')?.textContent, 'speed: 115200');
  const meta = page([codeBlock('meta', '# feishu-page-meta\ndescription: SDK', CodeLanguage.YAML)]);
  assert.deepEqual(meta.meta, { description: 'SDK' });
  assert.doesNotMatch(meta.markdown, /feishu-page-meta/);
  const nested = page([
    { block_id: 'parent', block_type: BlockType.Text, text: textRun('说明'), children: ['sample-yaml'] },
    codeBlock('sample-yaml', '# feishu-page-meta\ntitle: nested', CodeLanguage.YAML),
  ], ['parent']);
  assert.equal(nested.meta, undefined);
  assert.match(nested.markdown, /title: nested/);
  assert.equal(page([codeBlock('legacy', 'hide: true', CodeLanguage.YAML)]).meta.hide, true);
  const invalidExample = page([codeBlock('invalid', 'speed: [', CodeLanguage.YAML)]);
  assert.match(invalidExample.markdown, /speed: \[/);
});

test('a styled link preserves its destination, literal label and each style', async () => {
  const label = 'SDK [A] & B';
  const url = 'https://example.org/sdk?q=a%2Fb#install';
  const html = await renderHtml(page([{ block_id: 'ref', block_type: BlockType.Text,
    text: textRun(label, { bold: true, italic: true, underline: true, link: { url } }) }]).markdown);
  const link = html.querySelector('p a');
  assert.equal(link?.getAttribute('href'), url);
  assert.equal(link.textContent, label);
  for (const tag of ['b', 'em', 'u']) assert.equal(link.querySelector(tag)?.textContent, label);
});

test('unsupported components have a visible fallback and a per-document type count', async t => {
  const warnings = t.mock.method(console, 'warn', () => {});
  const blocks = ['one', 'two'].map(block_id => ({
    block_id, block_type: BlockType.Bitable, bitable: { token: 'not-public' },
  }));
  const { markdown } = page(blocks);
  const html = await renderHtml(markdown);
  assert.equal(html.body.textContent.match(/多维表格/g)?.length, 2);
  assert.deepEqual(warnings.mock.calls.map(call => call.arguments[0]), ['Feishu conversion: document=sample type=Bitable count=2']);
  assert.doesNotMatch(markdown, /not-public/);
});
