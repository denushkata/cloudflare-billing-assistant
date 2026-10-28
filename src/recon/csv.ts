// Minimal RFC 4180 CSV reader: quoted fields, escaped quotes, CRLF or LF.

export type CsvRow = Record<string, string> & { __line: string };

export function parseCsv(text: string, requiredColumns: string[], fileName: string): CsvRow[] {
  const records = splitRecords(text.charCodeAt(0) === 0xfeff ? text.slice(1) : text); // drop a UTF-8 BOM (Excel exports)
  const header = records.shift()?.fields.map((h) => h.trim());
  if (!header) throw new Error(`${fileName}: file is empty`);
  const missing = requiredColumns.filter((c) => !header.includes(c));
  if (missing.length) throw new Error(`${fileName}: missing column(s) ${missing.join(", ")}`);

  return records.map(({ fields, line }) => {
    if (fields.length !== header.length) {
      throw new Error(`${fileName} line ${line}: expected ${header.length} fields, found ${fields.length}`);
    }
    const row = { __line: `${fileName} line ${line}` } as CsvRow;
    header.forEach((h, i) => (row[h] = fields[i]!.trim()));
    return row;
  });
}

function splitRecords(text: string) {
  const out: { fields: string[]; line: number }[] = [];
  let fields: string[] = [];
  let field = "";
  let quoted = false;
  let line = 1;
  let startLine = 1;

  const endRecord = () => {
    fields.push(field);
    if (fields.length > 1 || fields[0] !== "") out.push({ fields, line: startLine });
    fields = [];
    field = "";
  };

  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (quoted) {
      if (c === '"' && text[i + 1] === '"') { field += '"'; i++; }
      else if (c === '"') quoted = false;
      else { if (c === "\n") line++; field += c; }
    } else if (c === '"') quoted = true;
    else if (c === ",") { fields.push(field); field = ""; }
    else if (c === "\n" || c === "\r") {
      if (c === "\r" && text[i + 1] === "\n") i++;
      endRecord();
      line++;
      startLine = line;
    } else field += c;
  }
  if (field !== "" || fields.length) endRecord();
  return out;
}
