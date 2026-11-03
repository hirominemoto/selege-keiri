// Excelに行を書き足す部品（src/lib/xlsxWrite.ts）のテスト。実データは使わず、小さなブックを作って確かめる
// 実行: npm run test:xlsx（Node 22 以降。TypeScript の型はそのまま外して読む）
import assert from "node:assert/strict";
import { appendRows, crc32, serialDate } from "../src/lib/xlsxWrite.ts";
import { readWorkbook, excelDate } from "../src/lib/xlsx.ts";

/** 圧縮なしの zip を作る（テスト用） */
function storedZip(files) {
  const enc = new TextEncoder();
  const parts = [], central = [];
  let off = 0;
  for (const [name, text] of Object.entries(files)) {
    const n = enc.encode(name), d = enc.encode(text), crc = crc32(d);
    const lh = new Uint8Array(30 + n.length), l = new DataView(lh.buffer);
    l.setUint32(0, 0x04034b50, true); l.setUint16(4, 20, true); l.setUint32(14, crc, true);
    l.setUint32(18, d.length, true); l.setUint32(22, d.length, true); l.setUint16(26, n.length, true); lh.set(n, 30);
    const ch = new Uint8Array(46 + n.length), c = new DataView(ch.buffer);
    c.setUint32(0, 0x02014b50, true); c.setUint16(4, 20, true); c.setUint16(6, 20, true); c.setUint32(16, crc, true);
    c.setUint32(20, d.length, true); c.setUint32(24, d.length, true); c.setUint16(28, n.length, true); c.setUint32(42, off, true); ch.set(n, 46);
    parts.push(lh, d); central.push(ch); off += lh.length + d.length;
  }
  const size = central.reduce((s, x) => s + x.length, 0);
  const end = new Uint8Array(22), e = new DataView(end.buffer);
  e.setUint32(0, 0x06054b50, true); e.setUint16(8, central.length, true); e.setUint16(10, central.length, true);
  e.setUint32(12, size, true); e.setUint32(16, off, true);
  const all = [...parts, ...central, end], out = new Uint8Array(all.reduce((s, x) => s + x.length, 0));
  let p = 0; for (const x of all) { out.set(x, p); p += x.length; }
  return out;
}

const sheet = `<?xml version="1.0" encoding="UTF-8"?><worksheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main"><dimension ref="A1:N4"/><sheetData>`
  + `<row r="1"><c r="A1" t="inlineStr"><is><t>担当</t></is></c><c r="B1" t="inlineStr"><is><t>社名</t></is></c></row>`
  + `<row r="2" ht="33" customHeight="1"><c r="A2" s="1" t="inlineStr"><is><t>柏木</t></is></c><c r="B2" s="2" t="inlineStr"><is><t>前の会社</t></is></c><c r="G2" s="3"><v>1000</v></c><c r="H2" s="3"><f>G2*1.1</f><v>1100</v></c><c r="N2" s="5"><v>46295</v></c></row>`
  + `<row r="3" ht="33" customHeight="1"><c r="A3" s="1"/><c r="B3" s="2"/><c r="N3" s="9"/></row>`
  + `<row r="4" ht="33" customHeight="1"><c r="A4" s="1"/><c r="B4" s="2"/><c r="H4" s="3"><f>G4*1.1</f><v>0</v></c></row>`
  + `</sheetData><pageMargins left="0.7" right="0.7" top="0.75" bottom="0.75" header="0.3" footer="0.3"/></worksheet>`;
const book = storedZip({
  "[Content_Types].xml": `<?xml version="1.0"?><Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Override PartName="/xl/workbook.xml" ContentType="x"/><Override PartName="/xl/calcChain.xml" ContentType="y"/></Types>`,
  "xl/workbook.xml": `<?xml version="1.0"?><workbook xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships"><sheets><sheet name="11月" sheetId="1" r:id="rId1"/><sheet name="12月" sheetId="2" r:id="rId2"/></sheets><calcPr calcId="191029"/></workbook>`,
  "xl/_rels/workbook.xml.rels": `<?xml version="1.0"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="ws" Target="worksheets/sheet1.xml"/><Relationship Id="rId2" Type="ws" Target="worksheets/sheet2.xml"/><Relationship Id="rId9" Type="cc" Target="calcChain.xml"/></Relationships>`,
  "xl/worksheets/sheet1.xml": sheet,
  "xl/worksheets/sheet2.xml": sheet.replace("前の会社", "12月の会社"),
  "xl/calcChain.xml": `<calcChain xmlns="x"><c r="H2" i="1"/></calcChain>`,
});

let passed = 0;
async function test(name, fn) {
  try { await fn(); passed++; console.log(`  ok  ${name}`); }
  catch (e) { console.error(`  NG  ${name}\n      ${e.stack}`); process.exitCode = 1; }
}
await test("空いている行（B列）から書き、文字・数字・日付・「〃」が入る。ほかのシートは変わらない", async () => {
  const { data, written } = await appendRows(book, [{ sheet: "11月", startRow: 2, keyCol: "B", rows: [
    { A: "社長", B: "テスト工業", C: "2711-01", G: 76000, H: 83600, N: { date: "2026-12-31" } },
    { A: "社長", B: "テスト工業", C: "2711-01", G: 30000, N: "〃" },
  ] }]);
  assert.deepEqual(written, [{ sheet: "11月", firstRow: 3, lastRow: 4 }]);
  const sheets = await readWorkbook(data);
  const s11 = sheets.find((s) => s.name === "11月");
  assert.equal(s11.rows.get(2).get(2), "前の会社");
  assert.equal(s11.rows.get(3).get(2), "テスト工業");
  assert.equal(s11.rows.get(3).get(3), "2711-01");
  assert.equal(s11.rows.get(3).get(7), 76000);
  assert.equal(excelDate(s11.rows.get(3).get(14)), "2026-12-31");
  assert.equal(s11.rows.get(4).get(14), "〃");
  const s12 = sheets.find((s) => s.name === "12月");
  assert.equal(s12.rows.get(3), undefined);
});

await test("日付はシリアル値になる（2026/11/30 = 46356）", () => {
  assert.equal(serialDate("2026-11-30"), 46356);
});

await test("書式は、同じ列の上にある同じ種類の値のセルにそろえる（日付の列は日付の書式）", async () => {
  const { data } = await appendRows(book, [{ sheet: "11月", startRow: 2, keyCol: "B", rows: [{ B: "x", N: { date: "2026-12-31" } }] }]);
  const xml = await sheetXml(data, "xl/worksheets/sheet1.xml");
  assert.match(xml, /<c r="N3" s="5"><v>46387<\/v><\/c>/); // N3 にもとからあった s="9" ではなく、上の日付の s="5"
  assert.match(xml, /<row r="3" ht="33" customHeight="1">/); // 行の高さは今のまま
});

await test("表より下にはみ出したら、行を足して書く", async () => {
  const rows = Array.from({ length: 4 }, (_, i) => ({ B: `会社${i}`, G: i }));
  const { data, written } = await appendRows(book, [{ sheet: "11月", startRow: 2, keyCol: "B", rows }]);
  assert.deepEqual(written[0], { sheet: "11月", firstRow: 3, lastRow: 6 });
  const s = (await readWorkbook(data)).find((x) => x.name === "11月");
  assert.equal(s.rows.get(6).get(2), "会社3");
  const xml = await sheetXml(data, "xl/worksheets/sheet1.xml");
  assert.match(xml, /<dimension ref="A1:N6"\/>/);
});

await test("書いたファイルにもう一度書くと、続きの行に書く", async () => {
  const first = await appendRows(book, [{ sheet: "11月", startRow: 2, keyCol: "B", rows: [{ B: "1社目" }] }]);
  const second = await appendRows(first.data, [{ sheet: "11月", startRow: 2, keyCol: "B", rows: [{ B: "2社目" }] }]);
  assert.equal(second.written[0].firstRow, 4);
});

await test("値や式が入っているセルには書かない（書き込みをやめる）", async () => {
  await assert.rejects(
    () => appendRows(book, [{ sheet: "11月", startRow: 2, keyCol: "B", rows: [{ B: "a" }, { B: "b", H: 1 }] }]),
    /H4 にはもう値が入っています/,
  );
});

await test("ないシートには書かない", async () => {
  await assert.rejects(() => appendRows(book, [{ sheet: "13月", startRow: 2, keyCol: "B", rows: [{ B: "a" }] }]), /シート「13月」が見つかりません/);
});

await test("開いたときに計算し直す印が付き、calcChain は消える", async () => {
  const { data } = await appendRows(book, [{ sheet: "11月", startRow: 2, keyCol: "B", rows: [{ B: "a" }] }]);
  const wb = await sheetXml(data, "xl/workbook.xml");
  assert.match(wb, /<calcPr calcId="191029" fullCalcOnLoad="1"\/>/);
  assert.equal(await sheetXml(data, "xl/calcChain.xml"), null);
  assert.doesNotMatch(await sheetXml(data, "xl/_rels/workbook.xml.rels"), /calcChain/);
  assert.doesNotMatch(await sheetXml(data, "[Content_Types].xml"), /calcChain/);
});

await test("もとが fullCalcOnLoad=\"0\" でも、計算し直す印は \"1\" になる", async () => {
  const off = storedZip({
    "[Content_Types].xml": `<Types/>`,
    "xl/workbook.xml": `<workbook xmlns:r="r"><sheets><sheet name="11月" sheetId="1" r:id="rId1"/></sheets><calcPr calcId="1" fullCalcOnLoad="0"/></workbook>`,
    "xl/_rels/workbook.xml.rels": `<Relationships><Relationship Id="rId1" Type="ws" Target="worksheets/sheet1.xml"/></Relationships>`,
    "xl/worksheets/sheet1.xml": sheet,
  });
  const { data } = await appendRows(off, [{ sheet: "11月", startRow: 2, keyCol: "B", rows: [{ B: "a" }] }]);
  assert.match(await sheetXml(data, "xl/workbook.xml"), /<calcPr calcId="1" fullCalcOnLoad="1"\/>/);
});

/** zip の中のファイルを文字で読む（テスト用。なければ null） */
async function sheetXml(data, path) {
  const dv = new DataView(data.buffer, data.byteOffset, data.byteLength);
  let eocd = data.length - 22;
  while (dv.getUint32(eocd, true) !== 0x06054b50) eocd--;
  let p = dv.getUint32(eocd + 16, true);
  for (let i = 0; i < dv.getUint16(eocd + 10, true); i++) {
    const method = dv.getUint16(p + 10, true), comp = dv.getUint32(p + 20, true);
    const nl = dv.getUint16(p + 28, true), xl = dv.getUint16(p + 30, true), cl = dv.getUint16(p + 32, true), off = dv.getUint32(p + 42, true);
    const name = new TextDecoder().decode(data.subarray(p + 46, p + 46 + nl));
    if (name === path) {
      const start = off + 30 + dv.getUint16(off + 26, true) + dv.getUint16(off + 28, true);
      let bytes = data.subarray(start, start + comp);
      if (method === 8) bytes = new Uint8Array(await new Response(new Blob([bytes]).stream().pipeThrough(new DecompressionStream("deflate-raw"))).arrayBuffer());
      return new TextDecoder().decode(bytes);
    }
    p += 46 + nl + xl + cl;
  }
  return null;
}

console.log(`\n${passed} 件成功${process.exitCode ? "（失敗あり）" : ""}`);
