const { createRequire } = require('node:module');

// Patch the renderer instance used by the pinned feishu-pages exporter.
const requireExporter = createRequire(require.resolve('feishu-pages'));
// The CLI searches the entire Markdown string, including code. Resolve actual
// links at build time when the complete Wiki tree and downloaded assets exist.
requireExporter('./utils').replaceLinks = content => content;
const { MarkdownRenderer } = requireExporter('feishu-docx/dist/markdown_renderer');
const { BlockType, CodeLanguage, getCodeLanguage, getAlignStyle } = requireExporter('feishu-docx/dist/types');
const { Buffer: TextBuffer } = requireExporter('feishu-docx/dist/string_buffer');
const rendererRequire = createRequire(requireExporter.resolve('feishu-docx/dist/markdown_renderer'));
const { marked } = rendererRequire('marked');
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
  if (block.block_type === BlockType.Text &&
      textBlock.elements.every(element => typeof element.text_run?.content === 'string' &&
        /^[ \t]*$/.test(element.text_run.content))) {
    const parent = this.blockMap?.[block.parent_id];
    // A sole empty text block is also how Feishu represents an empty table cell.
    const emptyCell = parent?.block_type === BlockType.TableCell && parent.children?.length === 1;
    const children = renderText.call(this, block, { ...textBlock, elements: [] }).toString();
    return (emptyCell ? '' : '<p class="feishu-empty-paragraph" aria-hidden="true"><br></p>\n\n') + children;
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

function explicitOrdinal(sequence) {
  return /^\d{1,9}$/.test(sequence) ? Number(sequence) : undefined;
}

// Feishu numbers siblings independently. "auto" resumes their last ordered
// item even across other block types; old documents may omit sequence entirely.
function orderedMarkers(blockMap) {
  const markers = new Map();
  for (const parent of Object.values(blockMap)) {
    let previous = 0;
    let adjacent = false;
    let delimiter = '.';
    for (const id of parent.children || []) {
      const item = blockMap[id];
      if (item?.block_type !== BlockType.Ordered) {
        adjacent = false;
        continue;
      }
      const sequence = item.ordered.style?.sequence;
      const number = explicitOrdinal(sequence) ?? (sequence === 'auto' || adjacent ? previous + 1 : 1);
      // Markdown ignores nonconsecutive markers inside a single <ol>.
      // A different delimiter starts a new semantic list at the requested value.
      if (!adjacent) delimiter = '.';
      else if (number !== previous + 1) delimiter = delimiter === '.' ? ')' : '.';
      markers.set(id, { number, delimiter, startsRun: !adjacent, quoted: parent.block_type === BlockType.QuoteContainer });
      previous = number;
      adjacent = true;
    }
  }
  return markers;
}

MarkdownRenderer.prototype.parseOrderedBlock = function (block, indent = 0) {
  this.orderedMarkers ??= orderedMarkers(this.blockMap);
  const { number, delimiter, startsRun, quoted } = this.orderedMarkers.get(block.block_id) ||
    { number: explicitOrdinal(block.ordered.style?.sequence) ?? 1, delimiter: '.', startsRun: true, quoted: false };
  // Only a list starting with 1 can interrupt a Markdown paragraph. Supply
  // a container-aware blank line for a resumed or manually numbered list.
  const gap = startsRun && number !== 1 ? '\n' + (quoted ? '> ' : '') + '    '.repeat(indent) : '';
  let text = this.parseTextBlock(block, block.ordered).toString();
  if (this.nextBlock?.block_type === BlockType.Ordered && this.nextBlock.parent_id === block.parent_id &&
      !block.children?.length) text = text.replace(/\n$/, '');
  let markdown = gap + number + delimiter + ' ' + text;
  if (block.children?.length && !markdown.endsWith('\n')) markdown += '\n';
  const extra = Math.max(0, String(number).length - 2);
  this.withSubIndent(() => {
    for (const id of block.children || []) {
      this.nextBlock = null;
      const child = this.parseBlock(this.blockMap[id], indent + 1);
      // Three or more digits make the marker wider than one four-space indent.
      markdown += extra ? child.replace(/^(?=.)/gm, ' '.repeat(extra)) : child;
    }
  });
  return markdown;
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
const textColors = [null, 'red', 'orange', 'yellow', 'green', 'blue', 'purple', 'gray'];
function inlineLiteral(value) {
  return value.replace(/[&<>"\[\]\\`*_~|{}]/g, c => `&#${c.charCodeAt(0)};`);
}
MarkdownRenderer.prototype.parseTextRun = function (buffer, run, literal = false) {
  const style = run.text_element_style || {};
  const tags = Object.keys(styleTags).filter(key => style[key]);
  const color = Number.isInteger(style.text_color) && textColors[style.text_color];
  if (!literal && !color && !style.link?.url && tags.length < 2) return renderRun.call(this, buffer, run);

  let label = inlineLiteral(run.content || '');
  if (color) label = `<span class="feishu-text-${color}">${label}</span>`;
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

MarkdownRenderer.prototype.parseFile = function ({ file }) {
  if (!/^[A-Za-z0-9_-]+$/.test(file.token || '')) throw new Error('Invalid attachment identifier.');
  this.addFileToken('file', file.token);
  const name = inlineLiteral(file.name);
  return `<a href="${file.token}" download="${name}">${name}</a>\n`;
};

// Paragraphs are typed by Feishu. Parse their rich text inline so a literal
// "-" stays text; let the upstream block parser handle actual lists and code.
function nativeCellHtml(renderer, children = []) {
  const parts = [];
  let markdown = '';
  function flushBlocks() {
    if (markdown) parts.push(renderer.markdownToHTML(markdown).trim());
    markdown = '';
  }
  for (const id of children) {
    const block = renderer.blockMap[id];
    if (block?.block_type !== BlockType.Text) {
      markdown += renderer.parseBlock(block, 0);
      continue;
    }
    flushBlocks();
    const elements = block.text.elements;
    const buffer = new TextBuffer();
    for (const element of elements) {
      if (element.text_run) renderer.parseTextRun(buffer, element.text_run, true);
      else renderer.parseTextElement(buffer, element, elements.length > 1);
    }
    const inline = marked.parseInline(buffer.toString(), { gfm: true, breaks: true });
    const nested = block.children?.length ? nativeCellHtml(renderer, block.children) : '';
    const text = inline.trim() ? inline : '';
    if (!text && !nested && children.length === 1) continue;
    const align = getAlignStyle(block.text.style?.align);
    parts.push(`<div class="feishu-cell-text" style="text-align:${align}">${text || (nested ? '' : '<br>')}${nested}</div>`);
  }
  flushBlocks();
  // Blank physical lines terminate an HTML block in Markdown. An encoded
  // newline preserves the same text in a multiline code sample inside a cell.
  return parts.join('').replace(/\n(?=[ \t]*\n)/g, '&#10;');
}

MarkdownRenderer.prototype.parseTable = function (table) {
  const { column_size: columns, header_row: header, header_column: headerColumn,
    column_width: widths = [], merge_info: merges = [] } = table.property;
  if (!Number.isInteger(columns) || columns < 1 || table.cells.length % columns !== 0) {
    throw new Error('Invalid Feishu table dimensions.');
  }
  const rows = Array.from({ length: table.cells.length / columns }, () => []);
  const covered = new Set();
  let headerSpansRows = false;
  this.withSubIndent(() => {
    table.cells.forEach((id, index) => {
      if (covered.has(index)) return;
      const row = Math.floor(index / columns);
      const col = index % columns;
      const { row_span: height = 1, col_span: width = 1 } = merges[index] || {};
      if (!Number.isInteger(height) || !Number.isInteger(width) || height < 1 || width < 1 ||
          row + height > rows.length || col + width > columns) throw new Error('Invalid Feishu table merge.');
      for (let dy = 0; dy < height; dy++) {
        for (let dx = 0; dx < width; dx++) covered.add(index + dy * columns + dx);
      }
      if (row === 0 && height > 1) headerSpansRows = true;
      const tag = (header && row === 0) || (headerColumn && col === 0) ? 'th' : 'td';
      const cell = nativeCellHtml(this, this.blockMap[id]?.children);
      rows[row].push(`<${tag}${this.tableCellAttrHTML(merges, index)}>${cell}</${tag}>`);
    });
  });
  const hasWidth = width => Number.isFinite(width) && width > 0;
  const sizes = Array.from({ length: columns }, (_, i) => hasWidth(widths[i]) ? widths[i] : 120);
  const total = sizes.reduce((sum, width) => sum + width, 0);
  // Stop shrinking when the narrowest column reaches 80px (or its smaller
  // authored width); summing per-column minima loses the original proportions.
  const narrowest = sizes.reduce((min, width) => Math.min(min, width));
  const minimum = Math.ceil(total * Math.min(1, 80 / narrowest));
  const preferred = widths.some(hasWidth) ? `${total}px` : '100%';
  const colgroup = sizes.map(width => `<col style="width:${(100 * width / total).toFixed(4)}%"/>`).join('');
  const htmlRows = rows.map(cells => '<tr>' + cells.join('') + '</tr>');
  // HTML rowspans cannot cross from thead into tbody.
  const thead = header && !headerSpansRows && htmlRows.length ? `<thead>${htmlRows.shift()}</thead>` : '';
  const attrs = (headerColumn ? ' header_column="1"' : '') + (header ? ' header_row="1"' : '');
  const tableHtml = `<div class="feishu-doc-table-scroll" tabindex="0" role="region" aria-label="文档表格"><table v-pre class="feishu-doc-table"${attrs} style="--table-width:${preferred};--table-min:${minimum}px"><colgroup>${colgroup}</colgroup>${thead}<tbody>${htmlRows.join('')}</tbody></table></div>`;
  return tableHtml.replace(/\n(?=\S)/g, '\n' + '    '.repeat(this.indent)) + '\n\n';
};

MarkdownRenderer.prototype.parse = function () {
  this.orderedMarkers = undefined;
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
