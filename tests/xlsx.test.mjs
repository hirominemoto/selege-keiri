// Excelに行を書き足す部品（src/lib/xlsxWrite.ts）のテスト。実データは使わず、小さなブックを作って確かめる
// 実行: npm run test:xlsx（Node 22 以降。TypeScript の型はそのまま外して読む）
import assert from "node:assert/strict";
import { appendRows, crc32, serialDate } from "../src/lib/xlsxWrite.ts";
import { readWorkbook, excelDate } from "../src/lib/xlsx.ts";
import { findCompanySheet, alreadyInCompanySheet, companySheetEdit, clientLabel, planCompanySheets, newSheetName } from "../src/lib/companySheet.ts";

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

// ---------------------------------------------------------------- 企業シート（実データではなく、同じ形の小さなシート）
const is = (ref, t, s = "") => `<c r="${ref}"${s} t="inlineStr"><is><t>${t}</t></is></c>`;
const head = `<row r="2">${is("A2", "クライアント名")}${is("B2", "株式会社テスト工業（9月）")}</row>`
  + `<row r="6">${["請求日", "クライアント名", "案件名", "単価", "個数", "売上金額（税抜）", "備考", "計上月", "支払期限"].map((t, i) => is(`${"ABCDEFGHI"[i]}6`, t)).join("")}</row>`;
const dataRow = (r, b, c, date = 46326) => `<row r="${r}"><c r="A${r}" s="11"><v>${date}</v></c>${b ? is(`B${r}`, b) : `<c r="B${r}" s="12"/>`}${is(`C${r}`, c)}<c r="D${r}" s="3"><v>28000</v></c>${is(`E${r}`, "２")}<c r="F${r}" s="7"><f>D${r}*E${r}</f><v>56000</v></c>${is(`H${r}`, "10月")}<c r="I${r}" s="11"><v>46356</v></c></row>`;
const emptyRow = (r, f) => `<row r="${r}"><c r="A${r}" s="11"/><c r="B${r}" s="12"/><c r="C${r}" s="13"/><c r="F${r}" s="7">${f}<v>0</v></c><c r="I${r}" s="11"/></row>`;
const companySheetXml = `<?xml version="1.0" encoding="UTF-8"?><worksheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main"><dimension ref="A2:I14"/><sheetData>`
  + head
  + dataRow(7, "株式会社テスト工業（9月）", "２名：在留サポート（4回目/全24回）", 46295)
  + dataRow(8, "", "２名：在留サポート（5回目/全24回）") // B が空いている明細の行もある
  + emptyRow(9, `<f t="shared" ref="F9:F10" si="0">D9*E9</f>`)
  + emptyRow(10, `<f t="shared" si="0"/>`)
  + emptyRow(11, `<f>D10*E11</f>`) // 前もって入っている式が1行ずれている
  + emptyRow(12, `<f>D12*E12</f>`)
  + `<row r="13">${is("F13", "売上合計")}</row>`
  + `<row r="14"><c r="F14"><f>SUM(F7:F12)</f><v>112000</v></c></row>`
  + `</sheetData></worksheet>`;
const companyBook = storedZip({
  "[Content_Types].xml": `<?xml version="1.0"?><Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"/>`,
  "xl/workbook.xml": `<?xml version="1.0"?><workbook xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships"><sheets><sheet name="目次" sheetId="1" r:id="rId1"/><sheet name="テスト工業" sheetId="2" r:id="rId2"/></sheets></workbook>`,
  "xl/_rels/workbook.xml.rels": `<?xml version="1.0"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="ws" Target="worksheets/sheet1.xml"/><Relationship Id="rId2" Type="ws" Target="worksheets/sheet2.xml"/></Relationships>`,
  "xl/worksheets/sheet1.xml": `<?xml version="1.0"?><worksheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main"><sheetData><row r="1">${is("A1", "目次")}</row></sheetData></worksheet>`,
  "xl/worksheets/sheet2.xml": companySheetXml,
});
const companyBill = (lines, issue = "2026-11-30") => ({
  company_name: "テスト工業株式会社", aliases: [], sheet_hint: null,
  issue_date: issue, accounting_month: "2026-11-01", payment_due_date: "2026-12-31", lines,
});
const line = (description, unit_price, quantity, note = null) => ({ description, unit_price, quantity, amount: unit_price * quantity, note });

await test("企業シート：表記ゆれがあっても企業のシートを見つける。ないときは null", async () => {
  const sheets = await readWorkbook(companyBook);
  assert.equal(findCompanySheet(sheets, companyBill([])).name, "テスト工業");
  assert.equal(findCompanySheet(sheets, { company_name: "株式会社べつの会社", aliases: [], sheet_hint: null }), null);
});

await test("企業シート：A請求日かC案件名のある最後の行の次から書き、前もってある式は使う・ずれた式は直す", async () => {
  const sheets = await readWorkbook(companyBook);
  const s = findCompanySheet(sheets, companyBill([]));
  const edit = companySheetEdit(s, companyBill([
    line("２名：在留サポート（6回目/全24回）", 28000, 2),
    line("調整金", 49896, 1, "メモ"),
    line("内訳が\n2行", 1000, 3),
  ]));
  assert.equal(edit.beforeRow, 13);
  const { data, written } = await appendRows(companyBook, [edit]);
  assert.deepEqual(written, [{ sheet: "テスト工業", firstRow: 9, lastRow: 11 }]);
  const r = (await readWorkbook(data)).find((x) => x.name === "テスト工業").rows;
  assert.equal(excelDate(r.get(9).get(1)), "2026-11-30");
  assert.equal(r.get(9).get(2), "株式会社テスト工業（11月）");
  assert.equal(r.get(10).get(3), "調整金");
  assert.equal(r.get(10).get(7), "メモ");
  assert.equal(r.get(11).get(3), "内訳が2行");
  assert.equal(r.get(9).get(5), 2);
  assert.equal(r.get(9).get(8), "11月");
  assert.equal(excelDate(r.get(9).get(9)), "2026-12-31");
  const xml = await sheetXml(data, "xl/worksheets/sheet2.xml");
  assert.match(xml, /<c r="F9" s="7"><f t="shared" ref="F9:F10" si="0">D9\*E9<\/f>/); // 共有の式はそのまま
  assert.match(xml, /<c r="F10" s="7"><f t="shared" si="0"\/>/);
  assert.match(xml, /<c r="F11"[^>]*><f>D11\*E11<\/f>/); // ずれていた式を直す
  assert.match(xml, /<c r="A9" s="11"><v>46356<\/v><\/c>/); // 日付の書式は上の行にそろえる
});

await test("企業シート：「売上合計」の行まで足りなければ書かない", async () => {
  const sheets = await readWorkbook(companyBook);
  const s = findCompanySheet(sheets, companyBill([]));
  const edit = companySheetEdit(s, companyBill([1, 2, 3, 4, 5].map((i) => line(`行${i}`, 1, 1))));
  await assert.rejects(() => appendRows(companyBook, [edit]), /13行目より上に、空いている行が足りません/);
});

await test("企業シート：同じ請求日・案件名の行があれば「もうある」とみなす", async () => {
  const sheets = await readWorkbook(companyBook);
  const s = findCompanySheet(sheets, companyBill([]));
  assert.equal(alreadyInCompanySheet(s, companyBill([line("２名：在留サポート（5回目/全24回）", 28000, 2)], "2026-10-31")), true);
  assert.equal(alreadyInCompanySheet(s, companyBill([line("２名：在留サポート（5回目/全24回）", 28000, 2)], "2026-11-30")), false);
});

await test("企業シート：クライアント名は、そのシートの社名の書き方＋（◯月）。「分」付きのシートは「分」を付ける", () => {
  assert.equal(clientLabel("株式会社　ミクニ（５月）", "株式会社ミクニ", 11), "株式会社　ミクニ（11月）");
  assert.equal(clientLabel("株式会社ノーリツ（11月分）", "株式会社ノーリツ", 12), "株式会社ノーリツ（12月分）");
  assert.equal(clientLabel(null, "新しい会社", 1), "新しい会社（1月）");
});

await test("企業シート：同じ企業の請求が2件あると、1つのシートにつなげて書き、請求ごとの行数は別に持つ", async () => {
  const sheets = await readWorkbook(companyBook);
  const a = { id: "a", companyBill: companyBill([line("請求A", 1, 1)]) };
  const b = { id: "b", companyBill: companyBill([line("請求B-1", 1, 1), line("請求B-2", 1, 1)]) };
  const c = { id: "c", companyBill: { ...companyBill([line("x", 1, 1)]), company_name: "株式会社べつの会社" } };
  const { plan, noSheet, newSheets } = planCompanySheets(sheets, [a, b, c]);
  assert.deepEqual(noSheet, []);
  assert.deepEqual(newSheets.map((n) => n.name), ["株式会社べつの会社"]);
  assert.equal(plan.length, 2);
  assert.equal(plan[0].edit.rows.length, 3);
  assert.deepEqual(plan[0].items.map((x) => [x.item.id, x.rowCount]), [["a", 1], ["b", 2]]);
  const { written } = await appendRows(companyBook, plan.map((p) => p.edit), newSheets);
  assert.deepEqual(written, [{ sheet: "テスト工業", firstRow: 9, lastRow: 11 }, { sheet: "株式会社べつの会社", firstRow: 7, lastRow: 7 }]);
});

await test("企業シート：シートのない企業は、いつもの形のシートを写して新しいシートを足して書く", async () => {
  const book = storedZip({
    "[Content_Types].xml": `<?xml version="1.0"?><Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Override PartName="/xl/worksheets/sheet2.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.worksheet+xml"/></Types>`,
    "xl/workbook.xml": `<?xml version="1.0"?><workbook xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships"><bookViews><workbookView activeTab="2"/></bookViews><sheets><sheet name="目次" sheetId="1" r:id="rId1"/><sheet name="テスト工業" sheetId="2" r:id="rId2"/><sheet name="データ" sheetId="5" r:id="rId3"/></sheets><definedNames><definedName name="x" localSheetId="1">#REF!</definedName><definedName name="x" localSheetId="2">#REF!</definedName></definedNames></workbook>`,
    "xl/_rels/workbook.xml.rels": `<?xml version="1.0"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="ws" Target="worksheets/sheet1.xml"/><Relationship Id="rId2" Type="ws" Target="worksheets/sheet2.xml"/><Relationship Id="rId3" Type="ws" Target="worksheets/sheet3.xml"/></Relationships>`,
    "xl/worksheets/sheet1.xml": `<?xml version="1.0"?><worksheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main"><sheetData/></worksheet>`,
    "xl/worksheets/sheet2.xml": companySheetXml.replace("<sheetData>", `<sheetPr codeName="Sheet9"/><sheetViews><sheetView tabSelected="1" workbookViewId="0"/></sheetViews><sheetData>`)
      .replace(`<row r="6">`, `<row r="4">${is("A4", "申込書ページはこちらをクリック")}</row><row r="6">`)
      .replace("</worksheet>", `<hyperlinks><hyperlink ref="A4" location="申込書!A1"/></hyperlinks><drawing r:id="rId1"/></worksheet>`),
    "xl/worksheets/sheet3.xml": `<?xml version="1.0"?><worksheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main"><sheetData/></worksheet>`,
  });
  const sheets = await readWorkbook(book);
  const bill = { ...companyBill([line("人材紹介", 500000, 1), line("交通費", 3200, 1)]), company_name: "株式会社あたらしい" };
  const { plan, newSheets } = planCompanySheets(sheets, [{ companyBill: bill }]);
  assert.deepEqual(newSheets.map((n) => [n.name, n.copyOf, n.after]), [["株式会社あたらしい", "テスト工業", "テスト工業"]]);
  const { data, written } = await appendRows(book, plan.map((p) => p.edit), newSheets);
  assert.deepEqual(written, [{ sheet: "株式会社あたらしい", firstRow: 7, lastRow: 8 }]);
  const after = await readWorkbook(data);
  assert.deepEqual(after.map((x) => x.name), ["目次", "テスト工業", "株式会社あたらしい", "データ"]);
  const r = after.find((x) => x.name === "株式会社あたらしい").rows;
  assert.equal(r.get(2).get(2), "株式会社あたらしい（11月）");
  assert.equal(r.get(4)?.get(1) ?? null, null); // 申込書へのリンクの文字は写さない
  assert.equal(r.get(6).get(3), "案件名");
  assert.equal(r.get(7).get(3), "人材紹介");
  assert.equal(r.get(8).get(2), "株式会社あたらしい（11月）");
  assert.equal(r.get(13).get(6), "売上合計");
  // 元のシートの明細は写さない
  assert.ok(![...r.values()].some((row) => String(row.get(3) ?? "").includes("在留サポート")));
  const xml = await sheetXml(data, "xl/worksheets/sheet4.xml");
  assert.match(xml, /<c r="F7" s="7"><f>D7\*E7<\/f><\/c>/);
  assert.match(xml, /<c r="F12" s="7"><f>D12\*E12<\/f><\/c>/);
  assert.match(xml, /<c r="F14"><f>SUM\(F7:F12\)<\/f><\/c>/); // 計算結果は消して、開いたときに計算し直す
  assert.doesNotMatch(xml, /codeName|tabSelected|hyperlink|<drawing|r:id/);
  const wb = await sheetXml(data, "xl/workbook.xml");
  assert.match(wb, /<sheet name="株式会社あたらしい" sheetId="6" r:id="rId4"\/>/);
  assert.match(wb, /localSheetId="1">#REF!<\/definedName><definedName name="x" localSheetId="3">/); // 後ろのシートの番号はずれる
  assert.match(wb, /activeTab="3"/);
  assert.match(await sheetXml(data, "[Content_Types].xml"), /PartName="\/xl\/worksheets\/sheet4\.xml"/);
  assert.match(await sheetXml(data, "xl/_rels/workbook.xml.rels"), /Id="rId4"[^>]*Target="worksheets\/sheet4\.xml"/);
});

await test("企業シート：新しいシートの名前は、使えない文字を除いて31文字まで。同じ名前があれば数字を付ける", () => {
  assert.equal(newSheetName("サンプル/合同会社", []), "サンプル合同会社");
  assert.equal(newSheetName("テスト工業", ["テスト工業"]), "テスト工業2");
  assert.equal(newSheetName("あ".repeat(40), []).length, 31);
  assert.equal(newSheetName("/ 'Acme", []), "Acme"); // 前の「'」や空白は外す（止まらなくならない）
  assert.equal(newSheetName("' ' /", []), "新しい企業");
  assert.equal(newSheetName("Acme", ["Acme"]), "Acme2");
});

await test("企業シート：似た名前の新しい企業のシートに、今ある企業の請求を入れない", async () => {
  const sheets = await readWorkbook(companyBook);
  const nw = { id: "new", companyBill: { ...companyBill([line("新しい会社の請求", 1, 1)]), company_name: "テスト/工業" } };
  const old = { id: "old", companyBill: { ...companyBill([line("今ある会社の請求", 1, 1)]), sheet_hint: "テスト工業" } };
  const { plan, newSheets } = planCompanySheets(sheets, [nw, old]);
  assert.deepEqual(newSheets.map((n) => n.name), ["テスト工業2"]);
  assert.deepEqual(plan.map((p) => [p.edit.sheet, p.items.map((x) => x.item.id)]), [["テスト工業2", ["new"]], ["テスト工業", ["old"]]]);
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
