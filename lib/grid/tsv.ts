export function parseTsv(raw: string): string[][] {
  const cleaned = String(raw ?? "").replace(/\r/g, "");
  if (!cleaned) return [];
  const rows = cleaned
    .split("\n")
    .filter((line, idx, arr) => !(idx === arr.length - 1 && line === ""));
  return rows.map((line) => line.split("\t"));
}

export function toTsv(rows: string[][]): string {
  return rows.map((r) => r.join("\t")).join("\n");
}
