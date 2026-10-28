// Minimal RFC 4180 CSV reader: quoted fields, escaped quotes, CRLF or LF.
// Problems with the file as a whole throw; problems with one row are returned
// alongside the good rows, so one bad row does not hide the rest of the file.

export type CsvRow = Record<string, string> & { __line: string };
export interface CsvRowError {
  line: string;
  reason: string;
  /** The row's customer_id as written, when the row is too broken to parse but that column can still be read. */
  customerId?: string;
}

export function parseCsv(text: string, requiredColumns: string[], fileName: string): { rows: CsvRow[]; errors: CsvRowError[] } {
  const records = splitRecords(text.charCodeAt(0) === 0xfeff ? text.slice(1) : text); // drop a UTF-8 BOM (Excel exports)
  const header = records.shift()?.fields.map((h) => h.trim().toLowerCase());
  if (!header) throw new Error(`${fileName}: file is empty`);
  const missing = requiredColumns.filter((c) => !header.includes(c));
  if (missing.length) throw new Error(`${fileName}: missing column(s) ${missing.join(", ")}`);

  const rows: CsvRow[] = [];
  const errors: CsvRowError[] = [];
  const customerCol = header.indexOf("customer_id");
  for (const { fields, line } of records) {
    const where = `${fileName} line ${line}`;
    if (fields.length !== header.length) {
      errors.push({ line: where, reason: `expected ${header.length} fields, found ${fields.length}`, customerId: fields[customerCol]?.trim() });
    } else if (fields.every((f, i) => f.trim().toLowerCase() === header[i])) {
      errors.push({ line: where, reason: "repeats the header row" });
    } else {
      const row = { __line: where } as CsvRow;
      header.forEach((h, i) => (row[h] = fields[i]!.trim()));
      rows.push(row);
    }
  }
  return { rows, errors };
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
    if (fields.length > 1 || fields[0]!.trim() !== "") out.push({ fields, line: startLine });
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
