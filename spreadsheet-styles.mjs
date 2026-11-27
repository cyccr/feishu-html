import ExcelJS from 'exceljs';
import SharedStringXform from 'exceljs/lib/xlsx/xform/strings/shared-string-xform.js';
import FontXform from 'exceljs/lib/xlsx/xform/style/font-xform.js';

// ExcelJS treats a boolean font tag as enabled even when Feishu exports val="false".
// Keep explicit false values so rich-text runs can also override their cell's font.
const parseFontOpen = FontXform.prototype.parseOpen;
const booleanFontTags = new Set(['b', 'i', 'strike', 'outline', 'shadow', 'condense', 'extend', 'u']);
FontXform.prototype.parseOpen = function (node) {
  const property = !this.parser && booleanFontTags.has(node.name) && this.map[node.name];
  const value = String(node.attributes?.val ?? '').toLowerCase();
  const disabled = property && (value === '0' || value === 'false' || (node.name === 'u' && value === 'none'));
  const result = parseFontOpen.call(this, node);
  if (disabled) {
    this.parser.model = false;
    this.model[property.prop] = false;
  }
  return result;
};

// Feishu mixes plain <t> children and rich <r> children in exported shared strings.
// ExcelJS 4.4.0 assumes each shared string uses only one of those representations.
const parseSharedStringClose = SharedStringXform.prototype.parseClose;
SharedStringXform.prototype.parseClose = function (name) {
  if (name === 'r' && typeof this.model === 'string') {
    this.model = { richText: this.model ? [{ text: this.model }] : [] };
  }
  if (name === 't' && this.parser === this.map.t && this.model?.richText) {
    const combined = this.model;
    const result = parseSharedStringClose.call(this, name);
    combined.richText.push({ text: this.model });
    this.model = combined;
    return result;
  }
  return parseSharedStringClose.call(this, name);
};

const DEFAULT_THEME = ['FFFFFF', '000000', 'EEECE1', '1F497D', '4F81BD', 'C0504D', '9BBB59', '8064A2', '4BACC6', 'F79646', '0000FF', '800080'];
const THEME_NAMES = ['lt1', 'dk1', 'lt2', 'dk2', 'accent1', 'accent2', 'accent3', 'accent4', 'accent5', 'accent6', 'hlink', 'folHlink'];
const INDEXED_COLORS = [
  '000000', 'FFFFFF', 'FF0000', '00FF00', '0000FF', 'FFFF00', 'FF00FF', '00FFFF',
  '000000', 'FFFFFF', 'FF0000', '00FF00', '0000FF', 'FFFF00', 'FF00FF', '00FFFF',
  '800000', '008000', '000080', '808000', '800080', '008080', 'C0C0C0', '808080',
  '9999FF', '993366', 'FFFFCC', 'CCFFFF', '660066', 'FF8080', '0066CC', 'CCCCFF',
  '000080', 'FF00FF', 'FFFF00', '00FFFF', '800080', '800000', '008080', '0000FF',
  '00CCFF', 'CCFFFF', 'CCFFCC', 'FFFF99', '99CCFF', 'FF99CC', 'CC99FF', 'FFCC99',
  '3366FF', '33CCCC', '99CC00', 'FFCC00', 'FF9900', 'FF6600', '666699', '969696',
  '003366', '339966', '003300', '333300', '993300', '993366', '333399', '333333',
];
const BORDER_STYLES = {
  hair: '0.5px solid', thin: '1px solid', medium: '2px solid', thick: '3px solid',
  dotted: '1px dotted', dashed: '1px dashed', dashDot: '1px dashed', dashDotDot: '1px dashed',
  mediumDashed: '2px dashed', mediumDashDot: '2px dashed', mediumDashDotDot: '2px dashed',
  slantDashDot: '1px dashed', double: '3px double',
};

function escapeHtml(value) {
  return String(value).replace(/[&<>"']/g, character => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[character]);
}

function cssAttribute(styles) {
  return ` style="${escapeHtml(styles.filter(Boolean).join(';'))}"`;
}

function positive(value, fallback) {
  return Number.isFinite(value) && value > 0 ? value : fallback;
}

function themeColors(xml = '') {
  return THEME_NAMES.map((name, index) => {
    const section = xml.match(new RegExp(`<(?:\\w+:)?${name}\\b[^>]*>([\\s\\S]*?)<\\/(?:\\w+:)?${name}>`, 'i'));
    const value = section?.[1].match(/<(?:\w+:)?srgbClr\b[^>]*\bval="([a-f\d]{6})"/i)?.[1]
      || section?.[1].match(/<(?:\w+:)?sysClr\b[^>]*\blastClr="([a-f\d]{6})"/i)?.[1];
    return value || DEFAULT_THEME[index];
  });
}

function tintedColor(hex, tint) {
  const rgb = [0, 2, 4].map(offset => parseInt(hex.slice(offset, offset + 2), 16) / 255);
  const maximum = Math.max(...rgb);
  const minimum = Math.min(...rgb);
  const difference = maximum - minimum;
  const lightness = (maximum + minimum) / 2;
  const saturation = difference === 0 ? 0 : difference / (1 - Math.abs(2 * lightness - 1));
  let hue = 0;
  if (difference) {
    if (maximum === rgb[0]) hue = ((rgb[1] - rgb[2]) / difference + 6) % 6;
    else if (maximum === rgb[1]) hue = (rgb[2] - rgb[0]) / difference + 2;
    else hue = (rgb[0] - rgb[1]) / difference + 4;
  }
  const adjusted = tint < 0 ? lightness * (1 + tint) : lightness * (1 - tint) + tint;
  const chroma = (1 - Math.abs(2 * adjusted - 1)) * saturation;
  const secondary = chroma * (1 - Math.abs(hue % 2 - 1));
  const sectors = [[chroma, secondary, 0], [secondary, chroma, 0], [0, chroma, secondary],
    [0, secondary, chroma], [secondary, 0, chroma], [chroma, 0, secondary]];
  return sectors[Math.floor(hue)].map(channel => Math.round((channel + adjusted - chroma / 2) * 255)
    .toString(16).padStart(2, '0')).join('');
}

function colorCss(color, palette, fallback = '') {
  if (!color) return fallback;
  let hex;
  if (typeof color.argb === 'string' && /^(?:[a-f\d]{8}|[a-f\d]{6})$/i.test(color.argb)) hex = color.argb.slice(-6);
  else if (Number.isInteger(color.theme)) hex = palette[color.theme];
  else if (Number.isInteger(color.indexed)) hex = INDEXED_COLORS[color.indexed];
  if (!hex) return fallback;
  if (Number.isFinite(color.tint) && color.tint >= -1 && color.tint <= 1) hex = tintedColor(hex, color.tint);
  return '#' + hex.toLowerCase();
}

function fontCss(font, palette, defaults = false) {
  const styles = [];
  const family = String(font.name || '').replace(/[^\p{L}\p{N} ._-]/gu, '').slice(0, 120);
  if (family) {
    const fallback = /mono|consolas|menlo|monaco|courier|cascadia/i.test(family)
      ? 'ui-monospace,Consolas,"Liberation Mono",monospace' : 'sans-serif';
    styles.push(`font-family:"${family}",${fallback}`);
  }
  if (font.size || defaults) styles.push(`font-size:${positive(font.size, 11)}pt`);
  if (font.bold !== undefined || defaults) styles.push(`font-weight:${font.bold ? '700' : '400'}`);
  if (font.italic !== undefined || defaults) styles.push(`font-style:${font.italic ? 'italic' : 'normal'}`);
  const decorations = [font.underline && font.underline !== 'none' ? 'underline' : '', font.strike ? 'line-through' : ''].filter(Boolean);
  if (decorations.length || defaults || font.underline !== undefined || font.strike !== undefined) {
    styles.push('text-decoration:' + (decorations.join(' ') || 'none'));
  }
  const color = colorCss(font.color, palette, defaults ? '#000000' : '');
  if (color) styles.push('color:' + color);
  return styles;
}

function cellMarkup(text, cell, palette, richText) {
  let content = escapeHtml(text).replace(/\r?\n/g, '<br>');
  if (richText) {
    content = richText.map(run => {
      const font = { ...cell.font, ...run.font };
      return `<span${cssAttribute(fontCss(font, palette, true))}>${escapeHtml(run.text).replace(/\r?\n/g, '<br>')}</span>`;
    }).join('');
  }
  const hyperlink = cell.hyperlink;
  if (typeof hyperlink === 'string' && /^(?:https?:|mailto:|tel:)/i.test(hyperlink)) {
    content = `<a href="${escapeHtml(hyperlink)}">${content}</a>`;
  }
  return content;
}

function borderCss(border, palette) {
  if (!border?.style || !BORDER_STYLES[border.style]) return '';
  return BORDER_STYLES[border.style] + ' ' + colorCss(border.color, palette, '#000000');
}

function cellCss(cell, palette, worksheet, row, column, span, richText) {
  // Decorations on the td would cross out even runs that explicitly disable them.
  const font = richText ? { ...cell.font, underline: false, strike: false } : cell.font || {};
  const styles = fontCss(font, palette, true);
  const fill = cell.fill;
  const background = fill?.type === 'pattern' && fill.pattern === 'solid'
    ? colorCss(fill.fgColor, palette, '#ffffff') : '#ffffff';
  styles.push('background-color:' + background);
  const alignment = cell.alignment || {};
  const horizontal = { left: 'left', center: 'center', right: 'right', justify: 'justify', distributed: 'justify', centerContinuous: 'center' };
  const vertical = { top: 'top', middle: 'middle', bottom: 'bottom', justify: 'middle', distributed: 'middle' };
  styles.push('text-align:' + (horizontal[alignment.horizontal] || (typeof cell.value === 'number' ? 'right' : 'left')));
  styles.push('vertical-align:' + (vertical[alignment.vertical] || 'bottom'));
  styles.push('white-space:' + (alignment.wrapText ? 'pre-wrap' : 'pre'));
  if (positive(alignment.indent, 0)) styles.push(`padding-left:${alignment.indent}em`);
  if (alignment.textRotation === 'vertical') styles.push('writing-mode:vertical-rl');
  const edges = {
    top: Array.from({ length: span.columns }, (_, offset) => worksheet.getCell(row + 1, column + offset + 1).border?.top).find(border => border?.style),
    left: Array.from({ length: span.rows }, (_, offset) => worksheet.getCell(row + offset + 1, column + 1).border?.left).find(border => border?.style),
    right: Array.from({ length: span.rows }, (_, offset) => worksheet.getCell(row + offset + 1, column + span.columns).border?.right).find(border => border?.style),
    bottom: Array.from({ length: span.columns }, (_, offset) => worksheet.getCell(row + span.rows, column + offset + 1).border?.bottom).find(border => border?.style),
  };
  for (const [edge, border] of Object.entries(edges)) {
    styles.push(`border-${edge}:` + (borderCss(border, palette) || '0 none transparent'));
  }
  return styles;
}

export async function parseSpreadsheetStyles(bytes) {
  const workbook = new ExcelJS.Workbook();
  // Keep styles on covered cells so a merged cell can retain all four outer borders.
  await workbook.xlsx.load(bytes, { ignoreNodes: ['mergeCells', 'drawing', 'picture'] });
  return { workbook, palette: themeColors(workbook.model.themes?.theme1) };
}

export function renderStyledSpreadsheet(rows, width, sheet, styles, includeCoordinates) {
  const worksheet = styles.workbook.getWorksheet(sheet.title);
  if (!worksheet) throw new Error('Exported worksheet name does not match the selected Feishu worksheet.');
  const merges = sheet.merges || [];
  const origins = new Map();
  const covered = new Set();
  let height = rows.length;
  for (const merge of merges) {
    const { start_row_index: top, end_row_index: bottom, start_column_index: left, end_column_index: right } = merge;
    if (![top, bottom, left, right].every(Number.isInteger) || top < 0 || left < 0 || bottom < top || right < left ||
        bottom >= sheet.grid_properties.row_count || right >= sheet.grid_properties.column_count) {
      throw new Error('Invalid spreadsheet merge range.');
    }
    if (top >= rows.length || left >= width) continue;
    origins.set(`${top}:${left}`, { rows: bottom - top + 1, columns: right - left + 1 });
    height = Math.max(height, bottom + 1);
    width = Math.max(width, right + 1);
    for (let row = top; row <= bottom; row++) {
      for (let column = left; column <= right; column++) {
        if (row !== top || column !== left) covered.add(`${row}:${column}`);
      }
    }
  }
  const columnWidths = Array.from({ length: width }, (_, column) => {
    const excelWidth = worksheet.getColumn(column + 1).width || worksheet.properties.defaultColWidth;
    return excelWidth ? Math.round(excelWidth * 7 + 5) : 120;
  });
  const responsiveDescription = !includeCoordinates && width === 2 &&
    !positive(worksheet.getColumn(1).width, 0) && !positive(worksheet.properties.defaultColWidth, 0);
  const colgroup = (includeCoordinates ? '<col style="width:48px">' : '') + columnWidths
    .map((value, index) => responsiveDescription && index === 1 ? '<col>' : `<col style="width:${value}px">`).join('');
  const header = includeCoordinates ? '<thead><tr><th>行</th>' + columnWidths
    .map((_, index) => `<th>${worksheet.getColumn(index + 1).letter}</th>`).join('') + '</tr></thead>' : '';
  const body = Array.from({ length: height }, (_, row) => {
    const excelRow = worksheet.getRow(row + 1);
    const rowHeight = positive(excelRow.height, positive(worksheet.properties.defaultRowHeight, 16));
    const cells = includeCoordinates ? [`<th scope="row">${row + 1}</th>`] : [];
    for (let column = 0; column < width; column++) {
      const key = `${row}:${column}`;
      if (covered.has(key)) continue;
      const span = origins.get(key) || { rows: 1, columns: 1 };
      const cell = worksheet.getCell(row + 1, column + 1);
      const text = rows[row]?.[column] || '';
      const runs = cell.value?.richText;
      const richText = Array.isArray(runs) && runs.map(run => run.text).join('') === text ? runs : null;
      const attributes = (span.rows > 1 ? ` rowspan="${span.rows}"` : '') + (span.columns > 1 ? ` colspan="${span.columns}"` : '');
      const css = cellCss(cell, styles.palette, worksheet, row, column, span, richText);
      cells.push(`<td${attributes}${cssAttribute(css)}>${cellMarkup(text, cell, styles.palette, richText)}</td>`);
    }
    return `<tr style="height:${rowHeight}pt">${cells.join('')}</tr>`;
  }).join('');
  const tableWidth = columnWidths.reduce((sum, value) => sum + value, includeCoordinates ? 48 : 0);
  const tableStyle = responsiveDescription ? `width:100%;min-width:${Math.max(480, tableWidth)}px` : `width:${tableWidth}px`;
  return `<div class="feishu-sheet-scroll" role="region" aria-label="电子表格" tabindex="0"><table v-pre class="feishu-sheet" style="${tableStyle}"><colgroup>${colgroup}</colgroup>${header}<tbody>${body}</tbody></table></div>`;
}
