import type { ImportWatchlistRequest } from '../../shared/workspace-records';

/** Select from structural separators, never delimiters inside quoted field content. */
function importDelimiter(source: string): ',' | '\t' {
  let quoted = false;
  let content = false;
  for (let index = 0; index < source.length; index++) {
    const char = source[index];
    if (char === '"') {
      if (quoted && source[index + 1] === '"') {
        index++;
        content = true;
      } else quoted = !quoted;
    } else if (quoted) {
      // Match finishRow: quoted whitespace-only records are empty too.
      if (char.trim()) content = true;
    } else {
      if (char === ',' || char === '\t') return char;
      if (char === '\n' || char === '\r') {
        if (content) return ','; // A one-column first record defaults to CSV.
      } else if (char.trim()) content = true;
    }
  }
  return ',';
}

/** A bounded CSV/TSV parser: supports quoted delimiters, escaped quotes, and quoted line breaks. */
export function parseWatchlistImport(text: string): ImportWatchlistRequest['items'] {
  if (new TextEncoder().encode(text).length > 512 * 1024) throw new Error('导入内容不能超过 512 KiB');
  const source = text.replace(/^\uFEFF/, '');
  const delimiter = importDelimiter(source);
  const rows: string[][] = [];
  let row: string[] = [],
    cell = '',
    quoted = false,
    closed = false;
  const finishCell = () => {
    row.push(cell.trim());
    cell = '';
    closed = false;
  };
  const finishRow = () => {
    finishCell();
    if (row.some(Boolean)) rows.push(row);
    row = [];
    if (rows.length > 201) throw new Error('每次最多导入 200 条证券');
  };
  for (let index = 0; index < source.length; index++) {
    const char = source[index];
    if (quoted) {
      if (char === '"' && source[index + 1] === '"') {
        cell += '"';
        index++;
      } else if (char === '"') {
        quoted = false;
        closed = true;
      } else cell += char;
    } else if (char === delimiter) finishCell();
    else if (char === '\n' || char === '\r') {
      if (char === '\r' && source[index + 1] === '\n') index++;
      finishRow();
    } else if (char === '"' && !cell && !closed) quoted = true;
    else if (closed && char.trim()) throw new Error('引号结束后只能是分隔符或换行');
    else if (char === '"') throw new Error('字段内的引号必须以双引号转义');
    else if (!closed) cell += char;
  }
  if (quoted) throw new Error('导入内容有未闭合的引号');
  finishRow();
  if (rows[0] && /^(symbol|代码|证券代码|股票代码)$/i.test(rows[0][0])) {
    const header = rows.shift()!;
    const expected = [
      /^(symbol|代码|证券代码|股票代码)$/i,
      /^(market|市场)$/i,
      /^(name|名称)$/i,
      /^(notes|备注)$/i,
    ];
    if (header.length > 4 || header.some((value, index) => !expected[index].test(value)))
      throw new Error('表头顺序应为 symbol,market,name,notes');
  }
  if (!rows.length || rows.length > 200) throw new Error('请提供 1–200 条证券');
  return rows.map((columns, index) => {
    if (columns.length > 4) throw new Error(`第 ${index + 1} 条超过四列；含逗号的名称或备注请加双引号`);
    const [symbol, market = '', name = '', notes = ''] = columns;
    if (!symbol || !/^[A-Z0-9^][A-Z0-9.^:_/-]{0,39}$/i.test(symbol) || symbol.includes('//'))
      throw new Error(`第 ${index + 1} 条证券代码格式无效`);
    if (market && !/^[A-Z0-9][A-Z0-9._-]{0,31}$/i.test(market))
      throw new Error(`第 ${index + 1} 条市场格式无效`);
    return { symbol: symbol.toUpperCase(), market: market.toUpperCase() || 'UNSPECIFIED', name, notes };
  });
}

