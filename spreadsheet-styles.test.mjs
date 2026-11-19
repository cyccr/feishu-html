import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createRequire } from 'node:module';
import ExcelJS from 'exceljs';
import { parseSpreadsheetStyles, renderStyledSpreadsheet } from './spreadsheet-styles.mjs';
import { completeExport } from './feishu-source.mjs';

async function workbookBytes(color = 'FF647E2F') {
  const workbook = new ExcelJS.Workbook();
  const sheet = workbook.addWorksheet('Selected');
  sheet.getColumn(1).width = 18;
  sheet.getColumn(2).width = 24;
  sheet.getRow(1).height = 28;
  sheet.getCell('A1').value = '基本信息';
  sheet.getCell('A1').font = { bold: true, name: 'Microsoft YaHei', size: 12, color: { argb: 'FFFFFFFF' } };
  sheet.getCell('A1').fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: color } };
  sheet.getCell('A1').alignment = { horizontal: 'center', vertical: 'middle', wrapText: true };
  sheet.mergeCells('A1:B1');
  sheet.getCell('A2').value = '项目';
  sheet.getCell('B2').value = { richText: [
    { text: '蓝牙', font: { bold: true, color: { argb: 'FFFF0000' } } },
    { text: '设备', font: { italic: true, underline: true } },
  ] };
  sheet.getCell('A3').value = '金额';
  sheet.getCell('B3').value = 1234.5;
  sheet.getCell('B3').numFmt = '¥#,##0.00';
  sheet.getCell('B3').border = { bottom: { style: 'double', color: { argb: 'FF0000FF' } } };
  workbook.addWorksheet('Unreferenced').getCell('A1').value = 'UNREFERENCED_PRIVATE_CONTENT';
  return workbook.xlsx.writeBuffer();
}

const selectedSheet = {
  sheet_id: 'selected', title: 'Selected', index: 0,
  grid_properties: { row_count: 3, column_count: 2 },
  merges: [{ start_row_index: 0, end_row_index: 0, start_column_index: 0, end_column_index: 1 }],
};
const selectedValues = [['基本信息', ''], ['项目', '蓝牙设备'], ['金额', '¥1,234.50']];

test('XLSX colors, fonts, rich text, merged headers, borders and dimensions appear in the selected HTML table', async () => {
  const styles = await parseSpreadsheetStyles(await workbookBytes());
  const html = renderStyledSpreadsheet(selectedValues, 2, selectedSheet, styles, false);
  assert.match(html, /colspan="2"/);
  assert.match(html, /background-color:#647e2f/);
  assert.match(html, /color:#ffffff/);
  assert.match(html, /font-size:12pt/);
  assert.match(html, /font-weight:700/);
  assert.match(html, /text-align:center;vertical-align:middle;white-space:pre-wrap/);
  assert.match(html, /<col style="width:131px">/);
  assert.match(html, /<tr style="height:28pt">/);
  assert.match(html, /border-bottom:3px double #0000ff/);
  assert.match(html, /<span[^>]*font-weight:700[^>]*color:#ff0000[^>]*>蓝牙<\/span>/);
  assert.match(html, /<span[^>]*font-style:italic[^>]*text-decoration:underline[^>]*>设备<\/span>/);
  assert.match(html, /¥1,234\.50/);
  assert.equal((html.match(/<td\b/g) || []).length, 5);
  assert.equal(html.includes('UNREFERENCED_PRIVATE_CONTENT'), false);
});

test('two-dimensional merges preserve the outer borders and extend across trailing empty cells', async () => {
  const workbook = new ExcelJS.Workbook();
  const sheet = workbook.addWorksheet('Merged');
  sheet.getCell('A1').value = '跨行跨列';
  sheet.getCell('B2').border = {
    right: { style: 'thick', color: { argb: 'FFFF0000' } },
    bottom: { style: 'thin', color: { argb: 'FF00FF00' } },
  };
  const metadata = { title: 'Merged', grid_properties: { row_count: 2, column_count: 2 },
    merges: [{ start_row_index: 0, end_row_index: 1, start_column_index: 0, end_column_index: 1 }] };
  const styles = await parseSpreadsheetStyles(await workbook.xlsx.writeBuffer());
  const html = renderStyledSpreadsheet([['跨行跨列']], 1, metadata, styles, true);
  assert.match(html, /rowspan="2" colspan="2"/);
  assert.equal((html.match(/<td\b/g) || []).length, 1);
  assert.equal((html.match(/scope="row"/g) || []).length, 2);
  assert.match(html, /border-right:3px solid #ff0000/);
  assert.match(html, /border-bottom:1px solid #00ff00/);
});

test('theme and indexed colors are resolved and cell text cannot become executable HTML', async () => {
  const workbook = new ExcelJS.Workbook();
  const sheet = workbook.addWorksheet('Colors');
  sheet.getCell('A1').value = '<script>{{value}}</script>';
  sheet.getCell('A1').font = { color: { theme: 1, tint: 0.5 }, name: 'Arial";background:url(x)' };
  sheet.getCell('A1').fill = { type: 'pattern', pattern: 'solid', fgColor: { indexed: 2 } };
  sheet.getCell('A2').value = { text: 'link', hyperlink: 'javascript:alert(1)' };
  const styles = await parseSpreadsheetStyles(await workbook.xlsx.writeBuffer());
  const metadata = { title: 'Colors', grid_properties: { row_count: 2, column_count: 1 } };
  const html = renderStyledSpreadsheet([['<script>{{value}}</script>'], ['link']], 1, metadata, styles, false);
  assert.match(html, /background-color:#ff0000/);
  assert.match(html, /color:#808080/);
  assert.match(html, /&lt;script&gt;\{\{value\}\}&lt;\/script&gt;/);
  assert.equal(html.includes('href="javascript:'), false);
  assert.equal(html.includes('background:url'), false);
  assert.throws(() => renderStyledSpreadsheet([['x']], 1, { ...metadata, title: 'Missing' }, styles, false), /worksheet name/);
});

test('Feishu shared strings can mix empty or nonempty plain text with styled runs', async () => {
  const require = createRequire(import.meta.url);
  const requireExcel = createRequire(require.resolve('exceljs'));
  const JSZip = requireExcel('jszip');
  const workbook = new ExcelJS.Workbook();
  const sheet = workbook.addWorksheet('Mixed');
  sheet.getCell('A1').value = 'first';
  sheet.getCell('B1').value = 'second';
  const zip = await JSZip.loadAsync(await workbook.xlsx.writeBuffer());
  let strings = await zip.file('xl/sharedStrings.xml').async('string');
  strings = strings.replace('<si><t>first</t></si>', '<si><t>leading </t><r><rPr><b/></rPr><t>styled</t></r><t> trailing</t></si>')
    .replace('<si><t>second</t></si>', '<si><t></t><r><rPr><i/></rPr><t>body</t></r></si>');
  zip.file('xl/sharedStrings.xml', strings);
  const styles = await parseSpreadsheetStyles(await zip.generateAsync({ type: 'nodebuffer' }));
  const selected = styles.workbook.getWorksheet('Mixed');
  assert.equal(selected.getCell('A1').text, 'leading styled trailing');
  assert.equal(selected.getCell('B1').text, 'body');
  const html = renderStyledSpreadsheet([['leading styled trailing', 'body']], 2,
    { title: 'Mixed', grid_properties: { row_count: 1, column_count: 2 } }, styles, false);
  assert.match(html, /font-weight:700[^>]*>styled/);
  assert.match(html, /font-style:italic[^>]*>body/);
});

async function exportFixture(t, options = {}) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'feishu-styled-export-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  fs.mkdirSync(path.join(root, 'docs'));
  const file = path.join(root, 'docs', 'article.md');
  const original = '# 测试\n\n<!-- feishu-embedded-sheet:workbook_selected -->\n### 表格后的标题\n\n' +
    '<!-- feishu-embedded-sheet:workbook_selected -->\n```js\nconst x = 1;\n```\n';
  fs.writeFileSync(file, original);
  const requests = [];
  options.bytes = await workbookBytes();
  t.mock.method(globalThis, 'fetch', async (input, request = {}) => {
    const url = new URL(input);
    requests.push({ url, request });
    if (url.pathname.endsWith('/tenant_access_token/internal')) return Response.json({ code: 0, tenant_access_token: 'token' });
    if (url.pathname.endsWith('/nodes')) return Response.json({ code: 0, data: { items: [{ node_token: 'article', obj_type: 'docx', title: '测试' }] } });
    if (url.pathname.endsWith('/sheets/query')) return Response.json({ code: 0, data: { sheets: [selectedSheet] } });
    if (url.pathname.endsWith('/export_tasks')) {
      assert.equal(request.method, 'POST');
      assert.deepEqual(JSON.parse(request.body), { token: 'workbook', type: 'sheet', file_extension: 'xlsx' });
      return Response.json({ code: 0, data: { ticket: 'ticket' } });
    }
    if (url.pathname.endsWith('/export_tasks/ticket')) {
      assert.equal(url.searchParams.get('token'), 'workbook');
      return Response.json({ code: 0, data: { result: { job_status: options.failed ? 3 : 0, file_token: 'export-file' } } });
    }
    if (url.pathname.endsWith('/export-file/download')) return new Response(options.bytes, { headers: { 'Content-Type': 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet' } });
    if (url.pathname.includes('/values/')) return Response.json({ code: 0, data: { valueRange: { values: selectedValues } } });
    throw new Error(`Unexpected API request: ${url.pathname}`);
  });
  return { root, file, original, requests, environment: { FEISHU_SPACE_ID: 'space', FEISHU_SHEET_STYLES: '1' } };
}

test('a workbook is exported once per sync and style-only edits change generated publication content', async t => {
  const options = {};
  const { root, file, original, requests, environment } = await exportFixture(t, options);
  await completeExport(root, { mode: 'space' }, environment);
  const first = fs.readFileSync(file, 'utf8');
  assert.equal((first.match(/class="feishu-sheet"/g) || []).length, 2);
  assert.match(first, /background-color:#647e2f/);
  assert.match(first, /<\/div>\n\n### 表格后的标题/);
  assert.equal(requests.filter(({ url }) => url.pathname.endsWith('/export_tasks')).length, 1);
  options.bytes = await workbookBytes('FF112233');
  fs.writeFileSync(file, original);
  await completeExport(root, { mode: 'space' }, environment);
  const second = fs.readFileSync(file, 'utf8');
  assert.match(second, /background-color:#112233/);
  assert.notEqual(first, second);
  assert.equal(requests.filter(({ url }) => url.pathname.endsWith('/export_tasks')).length, 2);
});

test('failed style exports abort the publication instead of silently dropping all formatting', async t => {
  const { root, environment } = await exportFixture(t, { failed: true });
  await assert.rejects(completeExport(root, { mode: 'space' }, environment), /style export failed/);
  assert.equal(fs.existsSync(path.join(root, 'docs.json')), false);
});
