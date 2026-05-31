// @vitest-environment jsdom
import { describe, expect, it } from "vitest";
import { parseBlocks, parseTable } from "./surya-html";

const SAMPLE = `
<div data-bbox="48 38 314 68" data-label="Section-Header"><h1><b>Acme Pty Ltd</b></h1></div>
<div data-bbox="48 72 347 97" data-label="Text"><p>ABN: 12 345 678 901</p></div>
<div data-bbox="48 289 717 351" data-label="Text"><table><thead><tr><th>Description</th><th>Qty</th><th>Unit</th><th>Total</th></tr></thead><tbody><tr><td>Web design</td><td>1</td><td>1,234.56</td><td>1,234.56</td></tr></tbody></table></div>
`;

describe("parseBlocks", () => {
  it("extracts every data-bbox element with bbox, label, text", () => {
    const blocks = parseBlocks(SAMPLE, 0);
    expect(blocks).toHaveLength(3);
    expect(blocks[0]!.label).toBe("Section-Header");
    expect(blocks[0]!.bbox).toEqual({ x0: 48, y0: 38, x1: 314, y1: 68 });
    expect(blocks[0]!.text).toBe("Acme Pty Ltd");
    expect(blocks[0]!.pageIndex).toBe(0);
    expect(blocks[1]!.text).toBe("ABN: 12 345 678 901");
  });

  it("preserves innerHTML in block.html for table walks", () => {
    const blocks = parseBlocks(SAMPLE, 0);
    expect(blocks[2]!.html).toContain("<table>");
    expect(blocks[2]!.html).toContain("<thead>");
  });

  it("defaults label to 'Text' when data-label is missing", () => {
    const blocks = parseBlocks(`<div data-bbox="0 0 10 10">hi</div>`, 0);
    expect(blocks[0]!.label).toBe("Text");
  });

  it("returns empty array for HTML with no data-bbox elements", () => {
    expect(parseBlocks(`<p>no bboxes here</p>`, 0)).toEqual([]);
  });
});

describe("parseTable", () => {
  it("extracts headers and rows from <table>", () => {
    const html = `<table><thead><tr><th>Description</th><th>Qty</th><th>Unit</th><th>Total</th></tr></thead><tbody><tr><td>Web design</td><td>1</td><td>1,234.56</td><td>1,234.56</td></tr><tr><td>Hosting</td><td>2</td><td>10.00</td><td>20.00</td></tr></tbody></table>`;
    const t = parseTable(html);
    expect(t.headers).toEqual(["Description", "Qty", "Unit", "Total"]);
    expect(t.rows).toHaveLength(2);
    expect(t.rows[0]!).toEqual(["Web design", "1", "1,234.56", "1,234.56"]);
    expect(t.rows[1]!).toEqual(["Hosting", "2", "10.00", "20.00"]);
  });

  it("ignores <tfoot>", () => {
    const html = `<table><thead><tr><th>A</th></tr></thead><tbody><tr><td>1</td></tr></tbody><tfoot><tr><td>Total</td></tr></tfoot></table>`;
    expect(parseTable(html).rows).toEqual([["1"]]);
  });

  it("returns empty headers + rows when no <table>", () => {
    const t = parseTable(`<p>nope</p>`);
    expect(t.headers).toEqual([]);
    expect(t.rows).toEqual([]);
  });

  it("handles thead missing — first row treated as data", () => {
    const html = `<table><tr><td>a</td><td>b</td></tr><tr><td>c</td><td>d</td></tr></table>`;
    const t = parseTable(html);
    expect(t.headers).toEqual([]);
    expect(t.rows).toEqual([["a", "b"], ["c", "d"]]);
  });
});
