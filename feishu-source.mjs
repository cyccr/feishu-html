import * as fs from 'node:fs';
import path from 'node:path';
import { Readable } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import { spawnSync } from 'node:child_process';
import matter from 'gray-matter';
import { parseSpreadsheetStyles, renderStyledSpreadsheet } from './spreadsheet-styles.mjs';

export function resolvePublicationScope(environment) {
  const mode = environment.PUBLISH_SCOPE || 'subtree';
  if (!['space', 'subtree'].includes(mode)) throw new Error('PUBLISH_SCOPE must be space or subtree.');
  if (mode === 'subtree' && !environment.ROOT_NODE_TOKEN?.trim()) {
    throw new Error('ROOT_NODE_TOKEN is required for subtree publication.');
  }
  const scope = { mode, rootNodeToken: mode === 'space' ? '' : environment.ROOT_NODE_TOKEN.trim() };
  if (mode === 'space' && environment.SPACE_HOME_NODE_TOKEN?.trim()) {
    scope.homeNodeToken = environment.SPACE_HOME_NODE_TOKEN.trim();
  }
  return scope;
}

function markdownLabel(text) { return String(text).replace(/[\\[\]`*_<>]/g, '\\$&').replace(/[\r\n]+/g, ' '); }
function html(text) { return String(text).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]); }

function tool(program, args) {
  const result = spawnSync(program, args, { encoding: 'utf8', timeout: 120000, maxBuffer: 64 * 1024 * 1024 });
  if (result.status !== 0) throw new Error(`${program} failed while processing a published attachment.`);
  return result.stdout;
}

function textFence(text) {
  const longest = Math.max(2, ...(text.match(/`+/g) || []).map(value => value.length));
  const fence = '`'.repeat(longest + 1);
  return `${fence}text\n${text}\n${fence}`;
}

function columnLabel(number) {
  let label = '';
  while (number > 0) {
    number--;
    label = String.fromCharCode(65 + number % 26) + label;
    number = Math.floor(number / 26);
  }
  return label;
}

function cellText(value) {
  if (value == null) return '';
  if (Array.isArray(value)) return value.map(cellText).join('');
  if (typeof value === 'object') return cellText(value.text ?? value.value ?? value.link ?? JSON.stringify(value));
  return String(value);
}

async function spreadsheetTable(spreadsheetToken, sheet, api, includeCoordinates = true, styles = null) {
  const { row_count: rowCount, column_count: columnCount } = sheet.grid_properties || {};
  if (!/^[A-Za-z0-9_-]+$/.test(sheet.sheet_id) ||
      !Number.isInteger(rowCount) || rowCount < 0 || !Number.isInteger(columnCount) || columnCount < 0) {
    throw new Error('Invalid spreadsheet worksheet metadata.');
  }
  const rows = [];
  let width = 0;
  // Read the entire grid in bounded requests, including columns beyond Z.
  const batchRows = Math.max(1, Math.floor(5000 / Math.max(1, Math.min(columnCount, 100))));
  for (let startRow = 1; startRow <= rowCount; startRow += batchRows) {
    for (let startColumn = 1; startColumn <= columnCount; startColumn += 100) {
      const endRow = Math.min(rowCount, startRow + batchRows - 1);
      const endColumn = Math.min(columnCount, startColumn + 99);
      const range = `${sheet.sheet_id}!${columnLabel(startColumn)}${startRow}:${columnLabel(endColumn)}${endRow}`;
      const data = await api(`sheets/v2/spreadsheets/${spreadsheetToken}/values/${encodeURIComponent(range)}`, {
        valueRenderOption: 'FormattedValue', dateTimeRenderOption: 'FormattedString',
      });
      if (!Array.isArray(data.valueRange?.values)) throw new Error('Missing spreadsheet cell values.');
      for (const [rowOffset, cells] of data.valueRange.values.entries()) {
        for (const [columnOffset, value] of (cells || []).entries()) {
          const text = cellText(value);
          if (text === '') continue;
          const row = startRow - 1 + rowOffset;
          const column = startColumn - 1 + columnOffset;
          rows[row] ||= [];
          rows[row][column] = text;
          width = Math.max(width, column + 1);
        }
      }
    }
  }
  if (!rows.length) return '此工作表暂无内容。';
  if (styles) return renderStyledSpreadsheet(rows, width, sheet, styles, includeCoordinates);
  const headings = Array.from({ length: width }, (_, column) => `<th scope="col">${columnLabel(column + 1)}</th>`).join('');
  const body = Array.from({ length: rows.length }, (_, row) => {
    const cells = Array.from({ length: width }, (_, column) => `<td>${html(rows[row]?.[column] || '').replace(/\r?\n/g, '<br>')}</td>`).join('');
    const rowHeading = includeCoordinates ? `<th scope="row">${row + 1}</th>` : '';
    return `<tr>${rowHeading}${cells}</tr>`;
  }).join('\n');
  // v-pre also prevents cell text such as {{value}} from becoming Vue code.
  const header = includeCoordinates ? `<thead><tr><th scope="col">行</th>${headings}</tr></thead>\n` : '';
  return `<table v-pre>\n${header}<tbody>\n${body}\n</tbody>\n</table>`;
}

async function spreadsheetMarkdown(node, title, api, styles) {
  const metadata = await api(`sheets/v3/spreadsheets/${node.obj_token}/sheets/query`);
  if (!Array.isArray(metadata.sheets)) throw new Error('Missing spreadsheet worksheets.');
  const sections = [`# ${markdownLabel(title)}`];
  for (const sheet of metadata.sheets.sort((a, b) => a.index - b.index)) {
    sections.push(`## ${markdownLabel(sheet.title || '未命名工作表')}`);
    sections.push(await spreadsheetTable(node.obj_token, sheet, api, true, styles));
  }
  return sections.join('\n\n') + '\n';
}

export async function completeExport(exportDirectory, scope, environment = process.env) {
  const base = environment.FEISHU_ENDPOINT || 'https://open.feishu.cn';
  const space = environment.FEISHU_SPACE_ID;
  const authResponse = await fetch(`${base}/open-apis/auth/v3/tenant_access_token/internal`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ app_id: environment.FEISHU_APP_ID, app_secret: environment.FEISHU_APP_SECRET }),
    signal: AbortSignal.timeout(30000),
  });
  const auth = await authResponse.json();
  if (auth.code !== 0 || !auth.tenant_access_token) throw new Error(`Feishu app authentication failed: ${auth.code}`);
  const headers = { Authorization: `Bearer ${auth.tenant_access_token}` };
  let lastRequest = 0;
  async function api(endpoint, params = {}, body) {
    for (let attempt = 0; attempt < 4; attempt++) {
      const wait = Math.max(0, 300 - (Date.now() - lastRequest));
      if (wait) await new Promise(resolve => setTimeout(resolve, wait));
      lastRequest = Date.now();
      const url = new URL(`${base}/open-apis/${endpoint}`);
      for (const [key, value] of Object.entries(params)) if (value !== undefined && value !== '') url.searchParams.set(key, value);
      const response = await fetch(url, {
        method: body === undefined ? 'GET' : 'POST',
        headers: body === undefined ? headers : { ...headers, 'Content-Type': 'application/json' },
        body: body === undefined ? undefined : JSON.stringify(body),
        signal: AbortSignal.timeout(30000),
      });
      const result = await response.json();
      if (response.status === 429 || result.code === 99991400) {
        await new Promise(resolve => setTimeout(resolve, 2000 * (attempt + 1)));
        continue;
      }
      if (!response.ok || result.code !== 0) throw new Error(`Feishu ${endpoint.split('/').slice(0, 2).join('/')} failed: ${result.code ?? response.status}`);
      return result.data;
    }
    throw new Error('Feishu API rate limit persists; existing site is preserved.');
  }
  const workbookStyles = new Map();
  async function spreadsheetStyles(token) {
    if (environment.FEISHU_SHEET_STYLES !== '1') return null;
    if (workbookStyles.has(token)) return workbookStyles.get(token);
    const { ticket } = await api('drive/v1/export_tasks', {}, { file_extension: 'xlsx', token, type: 'sheet' });
    if (!/^[A-Za-z0-9_-]+$/.test(ticket || '')) throw new Error('Missing spreadsheet export ticket.');
    let exported;
    for (let attempt = 0; attempt < 45; attempt++) {
      const { result } = await api(`drive/v1/export_tasks/${ticket}`, { token });
      if (result?.job_status === 0) {
        exported = result;
        break;
      }
      if (![1, 2].includes(result?.job_status)) throw new Error('Spreadsheet style export failed.');
      await new Promise(resolve => setTimeout(resolve, 1500));
    }
    if (!/^[A-Za-z0-9_-]+$/.test(exported?.file_token || '')) throw new Error('Spreadsheet style export timed out or returned no file.');
    const response = await fetch(`${base}/open-apis/drive/v1/export_tasks/file/${exported.file_token}/download`, {
      headers, signal: AbortSignal.timeout(120000),
    });
    if (!response.ok || response.headers.get('content-type')?.includes('application/json')) {
      throw new Error('Spreadsheet style file download failed.');
    }
    const chunks = [];
    let size = 0;
    for await (const chunk of response.body) {
      size += chunk.length;
      if (size > 64 * 1024 * 1024) throw new Error('Spreadsheet style file exceeds the 64 MiB processing limit.');
      chunks.push(chunk);
    }
    const bytes = Buffer.concat(chunks);
    if (bytes[0] !== 0x50 || bytes[1] !== 0x4b) throw new Error('Spreadsheet style export is not an XLSX file.');
    const styles = await parseSpreadsheetStyles(bytes);
    workbookStyles.set(token, styles);
    return styles;
  }
  async function children(parent = '') {
    let page = '';
    const result = [];
    do {
      const data = await api(`wiki/v2/spaces/${space}/nodes`, { parent_node_token: parent, page_size: 50, page_token: page });
      result.push(...data.items || []);
      page = data.has_more ? data.page_token : '';
    } while (page);
    return result;
  }
  const embeddedSheetMetadata = new Map();
  const embeddedSheetTables = new Map();
  const sheetMarker = environment.FEISHU_SHEET_MARKER || 'feishu-embedded-sheet';
  if (!/^[a-zA-Z0-9-]+$/.test(sheetMarker)) throw new Error('Invalid embedded sheet marker.');
  async function completeEmbeddedSheets(markdown) {
    const markers = [...markdown.matchAll(new RegExp(`<!-- ${sheetMarker}:([^<>]*?) -->`, 'g'))];
    for (const [marker, token] of markers) {
      const identifier = token.match(/^([A-Za-z0-9_-]+)_([A-Za-z0-9]+)$/);
      if (!identifier) throw new Error('Invalid embedded spreadsheet identifier.');
      const [, spreadsheetToken, sheetId] = identifier;
      if (!embeddedSheetTables.has(token)) {
        if (!embeddedSheetMetadata.has(spreadsheetToken)) {
          const metadata = await api(`sheets/v3/spreadsheets/${spreadsheetToken}/sheets/query`);
          if (!Array.isArray(metadata.sheets)) throw new Error('Missing spreadsheet worksheets.');
          embeddedSheetMetadata.set(spreadsheetToken, metadata.sheets);
        }
        const sheet = embeddedSheetMetadata.get(spreadsheetToken).find(item => item.sheet_id === sheetId);
        if (!sheet) throw new Error('Embedded spreadsheet worksheet was not found.');
        const styles = await spreadsheetStyles(spreadsheetToken);
        const table = await spreadsheetTable(spreadsheetToken, sheet, api, false, styles);
        // One HTML line preserves quote/list prefixes added by the document renderer.
        embeddedSheetTables.set(token, table.replaceAll('\n', ''));
      }
      const table = embeddedSheetTables.get(token);
      const markerLine = new RegExp(`^([ \\t]*(?:>[ \\t]*)*)${marker}[ \\t]*\\r?$`, 'gm');
      // HTML table blocks need a blank line on both sides for following Markdown to render.
      markdown = markdown.replace(markerLine, (_, prefix) => `${prefix}\n${prefix}${table}\n${prefix}`);
      // Markers inside HTML table cells already have an enclosing block.
      markdown = markdown.replaceAll(marker, () => table);
    }
    return markdown;
  }
  let roots;
  if (scope.mode === 'space') roots = await children();
  else {
    const { node } = await api('wiki/v2/spaces/get_node', { token: scope.rootNodeToken });
    if (node.space_id !== space) throw new Error('Selected node belongs to a different knowledge base.');
    roots = [node];
  }
  const listedTokens = new Set();
  async function expand(nodes) {
    for (const node of nodes) {
      listedTokens.add(node.node_token);
      node.children = node.has_child ? await expand(await children(node.node_token)) : [];
    }
    return nodes;
  }
  await expand(roots);
  if (scope.mode === 'space' && scope.homeNodeToken) {
    const { node: home } = await api('wiki/v2/spaces/get_node', { token: scope.homeNodeToken });
    if (home.space_id !== space) throw new Error('Knowledge base homepage belongs to a different knowledge base.');
    // Feishu can return the space homepage separately from its directory tree.
    if (!listedTokens.has(home.node_token)) roots = [{ ...home, children: roots }];
  }

  const docsDirectory = path.join(exportDirectory, 'docs');
  const assets = path.join(docsDirectory, 'assets');
  fs.mkdirSync(assets, { recursive: true });
  let documents = 0;
  let spreadsheets = 0;
  let files = 0;
  let pdfs = 0;
  async function materialize(nodes) {
    const result = [];
    for (const node of nodes) {
      if (!/^[A-Za-z0-9_-]+$/.test(node.node_token)) throw new Error('Invalid wiki node identifier.');
      const title = node.title?.trim() || (node.obj_type === 'sheet' ? '未命名表格' : '未命名文档');
      const filename = `${node.node_token}.md`;
      const destination = path.join(docsDirectory, filename);
      let parsed;
      if (['doc', 'docx'].includes(node.obj_type)) {
        if (!fs.existsSync(destination)) throw new Error(`Missing document output: ${node.node_token}`);
        // Each export must resolve fresh worksheet values, including identical document bodies.
        parsed = matter(fs.readFileSync(destination, 'utf8'), {});
        parsed.data.title ||= title;
        parsed.content = await completeEmbeddedSheets(parsed.content);
        documents++;
      } else if (node.obj_type === 'sheet') {
        if (!/^[A-Za-z0-9_-]+$/.test(node.obj_token)) throw new Error('Invalid spreadsheet identifier.');
        parsed = {
          content: await spreadsheetMarkdown(node, title, api, await spreadsheetStyles(node.obj_token)),
          data: { title, description: `${title}，电子表格内容。` },
        };
        spreadsheets++;
      } else if (node.obj_type === 'file') {
        if (!/^[A-Za-z0-9_-]+$/.test(node.obj_token)) throw new Error('Invalid file identifier.');
        const extension = path.extname(title).toLowerCase().replace(/[^.a-z0-9]/g, '') || '.bin';
        const basename = `file-${node.obj_token}`;
        const file = path.join(assets, basename + extension);
        const url = `/assets/${basename}${extension}`;
        const response = await fetch(`${base}/open-apis/drive/v1/files/${node.obj_token}/download`, { headers, signal: AbortSignal.timeout(120000) });
        if (!response.ok || response.headers.get('content-type')?.includes('application/json')) {
          throw new Error(`File download failed (HTTP ${response.status}); check file download permissions.`);
        }
        await pipeline(Readable.fromWeb(response.body), fs.createWriteStream(file));
        let body = `# ${markdownLabel(title)}\n\n[打开或下载原文件](${url})\n`;
        if (extension === '.pdf') {
          const signature = Buffer.alloc(5);
          const fd = fs.openSync(file, 'r');
          fs.readSync(fd, signature, 0, 5, 0); fs.closeSync(fd);
          if (signature.toString() !== '%PDF-') throw new Error('Downloaded PDF has an invalid signature.');
          const text = tool('pdftotext', ['-layout', '-enc', 'UTF-8', file, '-']).replace(/\f/g, '\n\n').replace(/[\x00-\x08\x0B\x0E-\x1F]/g, '').trim();
          const cover = path.join(assets, basename + '-cover');
          tool('pdftoppm', ['-f', '1', '-singlefile', '-scale-to', '1200', '-png', file, cover]);
          body += `\n<a href="${url}" target="_blank" rel="noopener"><img src="/assets/${basename}-cover.png" alt="${html(title)} 封面，点击查看完整 PDF" loading="lazy" /></a>\n\n## 文字正文\n\n图表和排版请以原始 PDF 为准。\n\n`;
          body += text ? textFence(text) + '\n' : '此 PDF 未提取到文字，请打开原文件查看。\n';
          pdfs++;
        }
        parsed = { content: body, data: { title, description: `${title}，原文件预览、下载与文档正文。` } };
        files++;
      } else throw new Error(`Unsupported knowledge node type: ${node.obj_type}`);
      const childNodes = await materialize(node.children);
      if (childNodes.length) {
        parsed.content += '\n\n## 下级文档\n\n' + childNodes.map(child => `- [${markdownLabel(child.title)}](/articles/${child.node_token}.html)`).join('\n') + '\n';
      }
      fs.writeFileSync(destination, matter.stringify(parsed.content, parsed.data));
      result.push({ title, filename, node_token: node.node_token, obj_token: node.obj_token, obj_type: node.obj_type, children: childNodes });
    }
    return result;
  }
  const complete = await materialize(roots);
  fs.writeFileSync(path.join(exportDirectory, 'docs.json'), JSON.stringify(complete, null, 2));
  return { documents, spreadsheets, files, pdfs };
}
