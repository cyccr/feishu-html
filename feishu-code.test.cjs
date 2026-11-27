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

function ordered(id, sequence, children) {
  return {
    block_id: id, block_type: BlockType.Ordered, children,
    ordered: { ...textRun(id), style: sequence === undefined ? {} : { sequence } },
  };
}

function displayedNumbers(list) {
  let next = list.start;
  return Array.from(list.children, li => {
    if (li.hasAttribute('value')) next = li.value;
    return next++;
  });
}

test('Feishu auto numbering continues across explanations, code and bullet lists', async () => {
  const blocks = [
    ordered('stepOne', '1'),
    { block_id: 'intro', block_type: BlockType.Text, text: textRun('修改文件位置') },
    codeBlock('code', '#define LIB_DEBUG 1'),
    { block_id: 'after', block_type: BlockType.Text, text: textRun('修改点') },
    ordered('stepTwo', 'auto'),
    { block_id: 'bullet', block_type: BlockType.Bullet, bullet: textRun('相关模块') },
    { block_id: 'note', block_type: BlockType.Text, text: textRun('继续配置') },
    ordered('stepThree', 'auto'),
    { block_id: 'section', block_type: BlockType.Heading3, heading3: textRun('2.2 后续章节') },
    ordered('newStep', '1'),
  ];
  const doc = await renderHtml(page(blocks).markdown);
  assert.deepEqual([...doc.querySelectorAll('body > ol')].flatMap(displayedNumbers), [1, 2, 3, 1]);
  assert.equal(doc.querySelector('pre code').textContent, '#define LIB_DEBUG 1');
  assert.ok(doc.querySelector('h3').textContent.startsWith('2.2 后续章节'));
});

test('manual starts, jumps, adjacent restarts and nested auto items keep their own ordinals', async () => {
  const children = ['nestedStart', 'nestedNote', 'nestedNext'];
  const blocks = [
    ordered('outer', '4', children),
    ordered('nestedStart', '7'),
    { block_id: 'nestedNote', block_type: BlockType.Text, text: textRun('嵌套说明') },
    ordered('nestedNext', 'auto'),
    ordered('outerNext', 'auto'), ordered('restart', '1'), ordered('jump', '8'), ordered('nine', 'auto'),
  ];
  const doc = await renderHtml(page(blocks, ['outer', 'outerNext', 'restart', 'jump', 'nine']).markdown);
  assert.deepEqual([...doc.querySelectorAll('body > ol')].flatMap(displayedNumbers), [4, 5, 1, 8, 9]);
  assert.deepEqual([...doc.querySelectorAll('body > ol > li > ol')].flatMap(displayedNumbers), [7, 8]);
});

test('legacy ordered blocks without sequence only continue immediately adjoining items', async () => {
  const blocks = [ordered('a'), ordered('b'), { block_id: 'gap', block_type: BlockType.Text, text: textRun('间隔') },
    ordered('c'), ordered('d')];
  const doc = await renderHtml(page(blocks).markdown);
  assert.deepEqual([...doc.querySelectorAll('body > ol')].map(displayedNumbers), [[1, 2], [1, 2]]);
});

test('numbered items in quotes and table cells use separate sequences', async () => {
  const textBlock = (id, value) => ({ block_id: id, block_type: BlockType.Text, text: textRun(value) });
  const blocks = [
    { block_id: 'q', block_type: BlockType.QuoteContainer, quote_container: {}, children: ['q1', 'qnote', 'q2'] },
    ordered('q1', '5'), textBlock('qnote', '引用内说明'), ordered('q2', 'auto'),
    { block_id: 't', block_type: BlockType.Table, table: { cells: ['left', 'right'], property: { column_size: 2 } } },
    { block_id: 'left', block_type: BlockType.TableCell, children: ['t1', 'note', 't2', 't3'] },
    ordered('t1', '3'), textBlock('note', '单元格说明'), ordered('t2', 'auto'), ordered('t3', '1'),
    { block_id: 'right', block_type: BlockType.TableCell, children: ['independent'] },
    ordered('independent', 'auto'),
    ordered('outer', '100', ['sub']), ordered('sub', '3'),
  ];
  for (const parent of blocks) for (const id of parent.children || []) {
    blocks.find(block => block.block_id === id).parent_id = parent.block_id;
  }
  const doc = await renderHtml(page(blocks, ['q', 't', 'outer']).markdown);
  assert.deepEqual([...doc.querySelectorAll('blockquote ol')].flatMap(displayedNumbers), [5, 6]);
  const cells = doc.querySelectorAll('td');
  assert.deepEqual([...cells[0].querySelectorAll('ol')].flatMap(displayedNumbers), [3, 4, 1]);
  assert.deepEqual([...cells[1].querySelectorAll('ol')].flatMap(displayedNumbers), [1]);
  assert.deepEqual([...doc.querySelectorAll('body > ol > li > ol')].flatMap(displayedNumbers), [3]);
});

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

test('every native table uses its own column widths and keeps paragraph alignment and punctuation', async () => {
  for (const widths of [[60, 90], [205, 125, 250, 250], [150, undefined, 75]]) {
    const n = widths.length;
    const cells = Array.from({ length: n }, (_, i) => 'c' + i);
    const blocks = [{
      block_id: 't', block_type: BlockType.Table, table: { cells, property: { column_size: n, column_width: widths } },
    }];
    for (const [i, id] of cells.entries()) {
      const children = i === 0 ? ['center', 'right'] : [id + 'value'];
      blocks.push({ block_id: id, block_type: BlockType.TableCell, children });
      if (i) blocks.push({ block_id: children[0], block_type: BlockType.Text, text: textRun('-') });
    }
    blocks.push(
      { block_id: 'center', block_type: BlockType.Text, text: { ...textRun('标题', { bold: true }), style: { align: 2 } } },
      { block_id: 'right', block_type: BlockType.Text, text: { ...textRun('# 参数 | **原文**'), style: { align: 3 } } },
    );
    const doc = await renderHtml(page(blocks, ['t']).markdown);
    const table = doc.querySelector('.feishu-doc-table-scroll > table.feishu-doc-table');
    assert.ok(table);
    assert.equal(table.rows.length, 1);
    assert.equal(table.querySelectorAll('th').length, 0);
    const texts = table.rows[0].cells[0].children;
    assert.equal(texts[0].style.textAlign, 'center');
    assert.equal(texts[0].querySelector('b').textContent, '标题');
    assert.equal(texts[1].style.textAlign, 'right');
    assert.equal(texts[1].textContent, '# 参数 | **原文**');
    assert.equal(table.rows[0].cells[1].textContent, '-');
    assert.equal(table.querySelectorAll('ul,hr,h1').length, 0);
    const resolved = Array.from(widths, w => w || 120);
    const total = resolved.reduce((sum, w) => sum + w, 0);
    const cols = [...table.querySelectorAll('col')];
    assert.equal(cols.length, n);
    const minimum = parseFloat(table.style.getPropertyValue('--table-min'));
    for (const width of resolved) assert.ok(minimum * width / total >= Math.min(width, 80) - 0.01);
    for (const [i, col] of cols.entries()) assert.ok(Math.abs(parseFloat(col.style.width) - resolved[i] / total * 100) < 0.01);
  }
});

test('native cells retain real lists, file downloads, blank cells and following headings', async () => {
  const blocks = [
    { block_id: 't', block_type: BlockType.Table, table: { cells: ['a', 'b'], property: { column_size: 2 } } },
    { block_id: 'a', block_type: BlockType.TableCell, children: ['one', 'two', 'parent'] },
    { block_id: 'one', block_type: BlockType.Bullet, bullet: textRun('第一项') },
    { block_id: 'two', block_type: BlockType.Bullet, bullet: textRun('第二项') },
    { block_id: 'parent', block_type: BlockType.Text, text: { ...textRun(''), style: { align: 3 } }, children: ['f'] },
    { block_id: 'f', block_type: BlockType.File, file: { token: 'asset', name: 'guide.pdf' } },
    { block_id: 'b', block_type: BlockType.TableCell, children: ['empty'] },
    { block_id: 'empty', block_type: BlockType.Text, text: textRun('') },
    { block_id: 'after', block_type: BlockType.Heading3, heading3: textRun('后续章节') },
  ];
  const doc = await renderHtml(page(blocks, ['t', 'after']).markdown);
  assert.deepEqual([...doc.querySelectorAll('td li')].map(li => li.textContent.trim()), ['第一项', '第二项']);
  const link = doc.querySelector('td a[download]');
  assert.equal(link.getAttribute('href'), 'asset');
  assert.equal(link.closest('[style*="text-align"]').style.textAlign, 'right');
  assert.equal(doc.querySelectorAll('td')[1].innerHTML, '');
  assert.equal(doc.querySelectorAll('h3').length, 1);
  assert.ok(!doc.querySelector('table h3'));
});

test('native table rich text, code and embedded sheet markers keep their own semantics', async () => {
  const style = { bold: true, text_color: 5, link: { url: 'https://example.org/sdk' } };
  const source = 'int a;\n\n  int b;';
  const blocks = [
    { block_id: 't', block_type: BlockType.Table, table: { cells: ['a', 'b'], property: { column_size: 2 } } },
    { block_id: 'a', block_type: BlockType.TableCell, children: ['styled', 'blank', 'code'] },
    { block_id: 'styled', block_type: BlockType.Text, text: textRun('A | B', style) },
    { block_id: 'blank', block_type: BlockType.Text, text: textRun('   ') },
    codeBlock('code', source),
    { block_id: 'b', block_type: BlockType.TableCell, children: ['sheet'] },
    { block_id: 'sheet', block_type: BlockType.Sheet, sheet: { token: 'book_first' } },
  ];
  const markdown = page(blocks, ['t']).markdown;
  assert.match(markdown, /<!-- feishu-embedded-sheet:book_first -->/);
  const doc = await renderHtml(markdown);
  const first = doc.querySelector('table').rows[0].cells[0];
  assert.equal(first.querySelector('a b .feishu-text-blue').textContent, 'A | B');
  assert.equal(first.querySelector('a').getAttribute('href'), 'https://example.org/sdk');
  assert.ok(first.querySelector('.feishu-cell-text br'));
  assert.equal(first.querySelector('pre code').textContent.replace(/\n$/, ''), source);
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

test('run colors, consecutive blank paragraphs and trailing whitespace survive publication', async () => {
  const text = (id, value) => ({ block_id: id, block_type: BlockType.Text, text: textRun(value) });
  const mixed = text('mixed', '默认');
  mixed.text.elements.push(...textRun('紫色', { text_color: 6, bold: true, link: { url: 'https://example.org/' } }).elements);
  const html = await renderHtml(page([mixed, text('gap1', ''), text('gap2', ' '), text('after', '下一段'), text('end', '')]).markdown);
  assert.equal(html.querySelector('p a b .feishu-text-purple')?.textContent, '紫色');
  const paragraphs = [...html.querySelectorAll('p')];
  assert.deepEqual(paragraphs.map(p => p.textContent), ['默认紫色', '', '', '下一段', '']);
  assert.equal(html.querySelectorAll('p.feishu-empty-paragraph > br').length, 3);
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
