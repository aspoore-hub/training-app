export function parseTsv(raw: string): string[][] {
  const cleaned = String(raw ?? "").replace(/\r\n/g, "\n").replace(/\r/g, "\n");
  if (!cleaned) return [];

  const rows: string[][] = [];
  let row: string[] = [];
  let field = "";
  let inQuotes = false;

  for (let i = 0; i < cleaned.length; i += 1) {
    const char = cleaned[i];
    if (inQuotes) {
      if (char === "\"") {
        if (cleaned[i + 1] === "\"") {
          field += "\"";
          i += 1;
        } else {
          inQuotes = false;
        }
      } else {
        field += char;
      }
      continue;
    }

    if (char === "\"" && field.length === 0) {
      inQuotes = true;
      continue;
    }
    if (char === "\t") {
      row.push(field);
      field = "";
      continue;
    }
    if (char === "\n") {
      row.push(field);
      rows.push(row);
      row = [];
      field = "";
      continue;
    }
    field += char;
  }

  row.push(field);
  if (!(rows.length > 0 && row.length === 1 && row[0] === "" && cleaned.endsWith("\n"))) {
    rows.push(row);
  }
  return rows;
}

export function toTsv(rows: string[][]): string {
  return rows
    .map((r) =>
      r
        .map((value) => {
          const text = String(value ?? "");
          if (!/[\t\n\r"]/.test(text)) return text;
          return `"${text.replace(/"/g, "\"\"")}"`;
        })
        .join("\t")
    )
    .join("\n");
}
