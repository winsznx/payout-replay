export class CsvSyntaxError extends Error {
  constructor(
    message: string,
    readonly line: number,
  ) {
    super(`CSV line ${line}: ${message}`);
    this.name = 'CsvSyntaxError';
  }
}

export interface CsvTable {
  headers: string[];
  /** Each record keeps the physical line number it started on, for error reporting. */
  records: { line: number; values: string[] }[];
}

/**
 * Strict RFC 4180 parser. Quoted fields may contain commas, quotes ("") and
 * newlines. Stray quotes inside unquoted fields and ragged rows are errors,
 * because a silently misparsed payout row is worse than a rejected file.
 */
export function parseCsv(text: string): CsvTable {
  const source = text.charCodeAt(0) === 0xfeff ? text.slice(1) : text;
  const rows: { line: number; values: string[] }[] = [];
  let field = '';
  let row: string[] = [];
  let rowStartLine = 1;
  let line = 1;
  let inQuotes = false;
  let fieldWasQuoted = false;
  let i = 0;

  const endField = () => {
    row.push(field);
    field = '';
    fieldWasQuoted = false;
  };
  const endRow = () => {
    endField();
    const isBlank = row.length === 1 && row[0] === '';
    if (!isBlank) rows.push({ line: rowStartLine, values: row });
    row = [];
  };

  while (i < source.length) {
    const ch = source[i]!;
    if (inQuotes) {
      if (ch === '"') {
        if (source[i + 1] === '"') {
          field += '"';
          i += 2;
          continue;
        }
        inQuotes = false;
        i += 1;
        const next = source[i];
        if (next !== undefined && next !== ',' && next !== '\n' && next !== '\r') {
          throw new CsvSyntaxError('unexpected character after closing quote', line);
        }
        continue;
      }
      if (ch === '\n') line += 1;
      field += ch;
      i += 1;
      continue;
    }
    if (ch === '"') {
      if (field.length > 0 || fieldWasQuoted) {
        throw new CsvSyntaxError('quote inside an unquoted field', line);
      }
      inQuotes = true;
      fieldWasQuoted = true;
      i += 1;
      continue;
    }
    if (ch === ',') {
      endField();
      i += 1;
      continue;
    }
    if (ch === '\r' || ch === '\n') {
      endRow();
      i += ch === '\r' && source[i + 1] === '\n' ? 2 : 1;
      line += 1;
      rowStartLine = line;
      continue;
    }
    field += ch;
    i += 1;
  }
  if (inQuotes) throw new CsvSyntaxError('unterminated quoted field', rowStartLine);
  if (field.length > 0 || fieldWasQuoted || row.length > 0) endRow();

  const [header, ...records] = rows;
  if (!header) throw new CsvSyntaxError('file has no header row', 1);
  const headers = header.values.map((h) => h.trim().toLowerCase());
  for (const record of records) {
    if (record.values.length !== headers.length) {
      throw new CsvSyntaxError(
        `expected ${headers.length} fields but found ${record.values.length}`,
        record.line,
      );
    }
  }
  return { headers, records };
}

const FORMULA_TRIGGER = /^[=+\-@\t\r]/;

/**
 * Neutralises values that spreadsheet software would evaluate as formulas
 * (OWASP CSV injection guidance) by prefixing a single quote.
 */
export function sanitizeCsvCell(value: string): string {
  return FORMULA_TRIGGER.test(value) ? `'${value}` : value;
}

function quoteCsvCell(value: string): string {
  return /[",\r\n]/.test(value) ? `"${value.replace(/"/g, '""')}"` : value;
}

export function serializeCsv(headers: readonly string[], rows: readonly (readonly string[])[]): string {
  const lines = [headers, ...rows].map((cells) =>
    cells.map((cell) => quoteCsvCell(sanitizeCsvCell(cell))).join(','),
  );
  return `${lines.join('\r\n')}\r\n`;
}
