export interface Block {
  bbox: { x0: number; y0: number; x1: number; y1: number };
  label: string;
  pageIndex: number;
  text: string;
  html: string;
}

export interface ParsedTable {
  headers: string[];
  rows: string[][];
}

function parseBbox(raw: string | null): { x0: number; y0: number; x1: number; y1: number } {
  const parts = (raw ?? "").split(/\s+/).map(Number);
  return {
    x0: parts[0] ?? 0,
    y0: parts[1] ?? 0,
    x1: parts[2] ?? 0,
    y1: parts[3] ?? 0,
  };
}

export function parseBlocks(htmlPage: string, pageIndex: number): Block[] {
  const doc = new DOMParser().parseFromString(`<root>${htmlPage}</root>`, "text/html");
  return [...doc.querySelectorAll("[data-bbox]")].map((el) => ({
    bbox: parseBbox(el.getAttribute("data-bbox")),
    label: el.getAttribute("data-label") ?? "Text",
    pageIndex,
    text: el.textContent?.trim() ?? "",
    html: el.innerHTML,
  }));
}

export function parseTable(blockHtml: string): ParsedTable {
  const doc = new DOMParser().parseFromString(`<root>${blockHtml}</root>`, "text/html");
  const table = doc.querySelector("table");
  if (!table) return { headers: [], rows: [] };

  const thead = table.querySelector("thead");
  const headers = thead
    ? [...thead.querySelectorAll("th")].map((th) => th.textContent?.trim() ?? "")
    : [];

  const bodyRows = table.querySelector("tbody")
    ? [...table.querySelector("tbody")!.querySelectorAll("tr")]
    : [...table.querySelectorAll("tr")].filter((tr) => !thead || !thead.contains(tr));

  const rows = bodyRows.map((tr) => [...tr.querySelectorAll("td")].map((td) => td.textContent?.trim() ?? ""));

  return { headers, rows };
}
