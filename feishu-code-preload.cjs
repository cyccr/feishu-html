const { createRequire } = require('node:module');

// Patch the renderer instance used by the pinned feishu-pages exporter.
const requireExporter = createRequire(require.resolve('feishu-pages'));
// The CLI searches the entire Markdown string, including code. Resolve actual
// links at build time when the complete Wiki tree and downloaded assets exist.
requireExporter('./utils').replaceLinks = content => content;
const { MarkdownRenderer } = requireExporter('feishu-docx/dist/markdown_renderer');
const { BlockType, CodeLanguage, getCodeLanguage } = requireExporter('feishu-docx/dist/types');
const yaml = requireExporter('js-yaml');
const renderPage = MarkdownRenderer.prototype.parse;
const renderBlock = MarkdownRenderer.prototype.parseBlock;
const renderRun = MarkdownRenderer.prototype.parseTextRun;
const renderText = MarkdownRenderer.prototype.parseTextBlock;

MarkdownRenderer.prototype.parseTextBlock = function (block, textBlock) {
  if (block.block_type === BlockType.Code &&
      textBlock.elements.every(element => typeof element.text_run?.content === 'string')) {
    return textBlock.elements.map(element => element.text_run.content).join('');
  }
  return renderText.apply(this, arguments);
};

MarkdownRenderer.prototype.parseBlock = function (block, indent) {
  if (block?.block_type !== BlockType.Code) {
    const markdown = renderBlock.call(this, block, indent);
    if (block && block.block_type >= BlockType.Heading1 && block.block_type <= BlockType.Heading6 &&
        typeof block.block_id === 'string' && /^[A-Za-z0-9_-]+$/.test(block.block_id)) {
      // Keep VitePress's title-based ID for existing bookmarks, alongside the
      // original block ID used by Feishu's "copy link to block" action.
      return markdown.replace(/^[^\n]*/, line =>
        line + `<span class="feishu-block-anchor" id="${block.block_id}" aria-hidden="true"></span>`);
    }
    return markdown;
  }
  this.indent = indent;
  this.currentBlock = block;
  const source = this.parseTextBlock(block, block.code).toString();
  let length = 3;
  for (const match of source.matchAll(/`+/g)) length = Math.max(length, match[0].length + 1);
  const fence = '`'.repeat(length);
  const language = getCodeLanguage(block.code.style?.language);
  const prefix = '    '.repeat(indent);
  return [fence + language, ...source.split('\n'), fence].map(line => prefix + line).join('\n') + '\n';
};

MarkdownRenderer.prototype.parsePageMeta = function (block) {
  // Older exports also recognized hide in the first descendant's YAML.
  // Keep that publication setting when migrating already-authored documents.
  let first = block;
  while (first && first.block_type !== BlockType.Code) first = this.blockMap[first.children?.[0]];
  if (first?.code.style?.language !== CodeLanguage.YAML) return false;
  const source = this.parseTextBlock(first, first.code).toString();
  const explicit = first === block && /^# feishu-page-meta[ \t]*\r?(?:\n|$)/.test(source);
  let meta;
  try { meta = yaml.load(source); } catch {
    if (explicit) throw new Error('Invalid YAML in Feishu page metadata.');
    return false;
  }
  if (!explicit && !meta?.hide) return false;
  if (Object.prototype.toString.call(meta) !== '[object Object]') throw new Error('Expected a mapping in Feishu page metadata.');
  this.meta = meta;
  return true;
};

// Leave URLs as Markdown destinations until VitePress parses their context.
const styleTags = { bold: 'b', italic: 'em', underline: 'u', strikethrough: 'del', inline_code: 'code' };
MarkdownRenderer.prototype.parseTextRun = function (buffer, run) {
  const style = run.text_element_style || {};
  const tags = Object.keys(styleTags).filter(key => style[key]);
  if (!style.link?.url && tags.length < 2) return renderRun.call(this, buffer, run);

  let label = (run.content || '').replace(/[&<>\[\]\\`*_~|{}]/g, c => `&#${c.charCodeAt(0)};`);
  for (const key of tags) label = `<${styleTags[key]}>${label}</${styleTags[key]}>`;
  if (style.link?.url) {
    let url = style.link.url;
    // Feishu may encode an entire URL. Escapes inside ordinary URLs are significant.
    if (/^(?:[a-z][a-z0-9+.-]*%3a|%2f|%23)/i.test(url)) {
      try { url = decodeURIComponent(url); } catch { buffer.write(label); return; }
    }
    const parsed = URL.parse(url, 'https://example.invalid');
    if (parsed && !['javascript:', 'vbscript:', 'file:', 'data:'].includes(parsed.protocol)) {
      const destination = url.replaceAll('&', '&amp;').replace(/[()<>\\\s]/gu, c =>
        c === '(' ? '%28' : c === ')' ? '%29' : encodeURIComponent(c));
      label = `[${label}](${destination})`;
    }
  }
  buffer.write(label);
};

MarkdownRenderer.prototype.parseTable = function (table) {
  const { column_size: columns, header_row: header, header_column: headerColumn,
    column_width: widths = [], merge_info: merges = [] } = table.property;
  if (!Number.isInteger(columns) || columns < 1 || table.cells.length % columns !== 0) {
    throw new Error('Invalid Feishu table dimensions.');
  }
  const rows = Array.from({ length: table.cells.length / columns }, () => []);
  const useHtml = headerColumn || widths.some(width => width > 100) ||
    merges.some(span => span?.row_span > 1 || span?.col_span > 1);
  const covered = new Set();
  let headerSpansRows = false;
  this.withSubIndent(() => {
    table.cells.forEach((id, index) => {
      if (covered.has(index)) return;
      const row = Math.floor(index / columns);
      const col = index % columns;
      const cell = this.parseBlock(this.blockMap[id], 0);
      if (!useHtml) {
        rows[row].push(cell.replace(/\n$/, '').replaceAll('\n', '<br/>').replaceAll('|', '\\|'));
        return;
      }
      const { row_span: height = 1, col_span: width = 1 } = merges[index] || {};
      if (!Number.isInteger(height) || !Number.isInteger(width) || height < 1 || width < 1 ||
          row + height > rows.length || col + width > columns) throw new Error('Invalid Feishu table merge.');
      for (let dy = 0; dy < height; dy++) {
        for (let dx = 0; dx < width; dx++) covered.add(index + dy * columns + dx);
      }
      if (row === 0 && height > 1) headerSpansRows = true;
      const tag = (header && row === 0) || (headerColumn && col === 0) ? 'th' : 'td';
      rows[row].push(`<${tag}${this.tableCellAttrHTML(merges, index)}>${this.markdownToHTML(cell).trim()}</${tag}>`);
    });
  });
  if (!useHtml) {
    const headings = header && rows.length ? rows.shift() : Array(columns).fill(' ');
    return [headings, Array(columns).fill('---'), ...rows].map(row => '|' + row.join('|') + '|').join('\n') + '\n';
  }
  const colgroup = Array.from({ length: columns }, (_, index) =>
    Number.isFinite(widths[index]) && widths[index] > 0 ? `<col width="${widths[index]}"/>` : '<col/>').join('');
  const htmlRows = rows.map(cells => '<tr>' + cells.join('') + '</tr>');
  // HTML rowspans cannot cross from thead into tbody.
  const thead = header && !headerSpansRows && htmlRows.length ? `<thead>${htmlRows.shift()}</thead>` : '';
  const attrs = (headerColumn ? ' header_column="1"' : '') + (header ? ' header_row="1"' : '');
  const tableHtml = `<table${attrs}>\n<colgroup>${colgroup}</colgroup>\n${thead}<tbody>${htmlRows.join('\n')}</tbody>\n</table>\n`;
  return tableHtml.replace(/\n(?=\S)/g, '\n' + '    '.repeat(this.indent));
};

MarkdownRenderer.prototype.parse = function () {
  this.unsupportedCounts = new Map();
  const markdown = renderPage.call(this);
  for (const [type, count] of this.unsupportedCounts) {
    console.warn(`Feishu conversion: document=${this.documentId} type=${type} count=${count}`);
  }
  return markdown;
};

// Keep each embedded worksheet's position until its cells are fetched by completeExport.
MarkdownRenderer.prototype.parseUnsupport = function (block) {
  if (block.block_type === BlockType.Sheet) {
    const token = block.sheet?.token;
    if (typeof token !== 'string' || !/^[A-Za-z0-9_-]+_[A-Za-z0-9]+$/.test(token)) {
      throw new Error('Invalid embedded spreadsheet identifier.');
    }
    const marker = process.env.FEISHU_SHEET_MARKER || 'feishu-embedded-sheet';
    return `<!-- ${marker}:${token} -->`;
  }
  const type = BlockType[block.block_type] || `Block${Number(block.block_type)}`;
  if (this.unsupportedCounts) this.unsupportedCounts.set(type, (this.unsupportedCounts.get(type) || 0) + 1);
  const label = type === 'Bitable' ? '多维表格' : type;
  return `〔飞书${label}，网页暂未展示此组件〕\n`;
};
