/**
 * Excel（.xlsx / .xlsm）に行を書き足す小さな部品。ブラウザの中で動く（ファイルはサーバーに送らない）
 *
 * 書き方の決まり（docs/decisions.md「フォームとExcelの対応」）
 *   - ファイルの中（zip）の、書き足すシートの XML だけを書きかえる。ほかのシート・書式・画像・マクロはそのまま
 *   - 書くのは「キーの列（例：B 社名）が空いている、いちばん上の行」から。行の高さ・セルの書式は今のまま使う
 *   - セルの書式は、同じ列で、上にある同じ種類（数字／文字）の値のセルにそろえる（日付が数字のまま出ないように）
 *   - 文字はセルに直接書く（共有文字列の表は触らない）。式・日付も書ける
 *   - 式の計算は、Excel で開いたときに計算し直す（calcChain は消し、開いたときに全部計算する印を付ける）
 * 外部のライブラリは使わない：zip はブラウザ標準の CompressionStream / DecompressionStream で読み書きする
 */

export type WriteValue = string | number | { date: string } | { formula: string } | null;
/** 1行ぶん：列（"A"…）→ 書く値。null や書かない列は今のまま */
export type WriteRow = Record<string, WriteValue>;
export type SheetEdit = {
  sheet: string;
  /** この行より下に書く（見出しの行の次） */
  startRow: number;
  /** この列が空いている行を「空いている行」とみなす */
  keyCol: string;
  rows: WriteRow[];
};
export type SheetWritten = { sheet: string; firstRow: number; lastRow: number };

// ---------------------------------------------------------------- zip

type Entry = {
  name: Uint8Array;
  method: number;
  flags: number;
  time: number;
  date: number;
  crc: number;
  compSize: number;
  size: number;
  extAttr: number;
  data: Uint8Array; // 圧縮されたまま
};

function readZip(buf: Uint8Array): Entry[] {
  const dv = new DataView(buf.buffer, buf.byteOffset, buf.byteLength);
  let eocd = -1;
  for (let i = buf.length - 22; i >= Math.max(0, buf.length - 65557); i--) {
    if (dv.getUint32(i, true) === 0x06054b50) {
      eocd = i;
      break;
    }
  }
  if (eocd < 0) throw new Error("Excelファイルとして開けませんでした");
  const count = dv.getUint16(eocd + 10, true);
  let p = dv.getUint32(eocd + 16, true);
  const out: Entry[] = [];
  for (let i = 0; i < count; i++) {
    if (dv.getUint32(p, true) !== 0x02014b50) throw new Error("Excelファイルの中身が読めませんでした");
    const flags = dv.getUint16(p + 8, true);
    const method = dv.getUint16(p + 10, true);
    const time = dv.getUint16(p + 12, true);
    const date = dv.getUint16(p + 14, true);
    const crc = dv.getUint32(p + 16, true);
    const compSize = dv.getUint32(p + 20, true);
    const size = dv.getUint32(p + 24, true);
    const nameLen = dv.getUint16(p + 28, true);
    const extraLen = dv.getUint16(p + 30, true);
    const commentLen = dv.getUint16(p + 32, true);
    const extAttr = dv.getUint32(p + 38, true);
    const local = dv.getUint32(p + 42, true);
    if (compSize === 0xffffffff || size === 0xffffffff || local === 0xffffffff) {
      throw new Error("大きすぎるExcelファイルには書き込めません");
    }
    const name = buf.slice(p + 46, p + 46 + nameLen);
    const lNameLen = dv.getUint16(local + 26, true);
    const lExtraLen = dv.getUint16(local + 28, true);
    const start = local + 30 + lNameLen + lExtraLen;
    out.push({ name, method, flags, time, date, crc, compSize, size, extAttr, data: buf.slice(start, start + compSize) });
    p += 46 + nameLen + extraLen + commentLen;
  }
  return out;
}

const CRC_TABLE = (() => {
  const t = new Uint32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    t[n] = c >>> 0;
  }
  return t;
})();
export function crc32(data: Uint8Array): number {
  let c = 0xffffffff;
  for (let i = 0; i < data.length; i++) c = CRC_TABLE[(c ^ data[i]) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

async function pipe(data: Uint8Array, t: TransformStream<Uint8Array, Uint8Array>): Promise<Uint8Array> {
  const stream = new Blob([data as BlobPart]).stream().pipeThrough(t);
  return new Uint8Array(await new Response(stream).arrayBuffer());
}
const inflate = (d: Uint8Array) => pipe(d, new DecompressionStream("deflate-raw") as TransformStream<Uint8Array, Uint8Array>);
const deflate = (d: Uint8Array) => pipe(d, new CompressionStream("deflate-raw") as TransformStream<Uint8Array, Uint8Array>);

async function entryText(e: Entry): Promise<string> {
  const bytes = e.method === 0 ? e.data : await inflate(e.data);
  return new TextDecoder().decode(bytes);
}

async function setEntryText(e: Entry, text: string): Promise<void> {
  const raw = new TextEncoder().encode(text);
  e.crc = crc32(raw);
  e.size = raw.length;
  e.data = await deflate(raw);
  e.compSize = e.data.length;
  e.method = 8;
  e.flags = (e.flags & ~0x0008) | 0x0800; // データ記述子なし・名前は UTF-8
}

function writeZip(entries: Entry[]): Uint8Array {
  const parts: Uint8Array[] = [];
  const central: Uint8Array[] = [];
  let offset = 0;
  for (const e of entries) {
    const flags = e.flags & ~0x0008; // 大きさは前に書くので、データ記述子は使わない
    const lh = new Uint8Array(30 + e.name.length);
    const l = new DataView(lh.buffer);
    l.setUint32(0, 0x04034b50, true);
    l.setUint16(4, 20, true);
    l.setUint16(6, flags, true);
    l.setUint16(8, e.method, true);
    l.setUint16(10, e.time, true);
    l.setUint16(12, e.date, true);
    l.setUint32(14, e.crc, true);
    l.setUint32(18, e.compSize, true);
    l.setUint32(22, e.size, true);
    l.setUint16(26, e.name.length, true);
    l.setUint16(28, 0, true);
    lh.set(e.name, 30);

    const ch = new Uint8Array(46 + e.name.length);
    const c = new DataView(ch.buffer);
    c.setUint32(0, 0x02014b50, true);
    c.setUint16(4, 20, true);
    c.setUint16(6, 20, true);
    c.setUint16(8, flags, true);
    c.setUint16(10, e.method, true);
    c.setUint16(12, e.time, true);
    c.setUint16(14, e.date, true);
    c.setUint32(16, e.crc, true);
    c.setUint32(20, e.compSize, true);
    c.setUint32(24, e.size, true);
    c.setUint16(28, e.name.length, true);
    c.setUint32(38, e.extAttr, true);
    c.setUint32(42, offset, true);
    ch.set(e.name, 46);

    parts.push(lh, e.data);
    central.push(ch);
    offset += lh.length + e.data.length;
  }
  const cdSize = central.reduce((s, x) => s + x.length, 0);
  const end = new Uint8Array(22);
  const d = new DataView(end.buffer);
  d.setUint32(0, 0x06054b50, true);
  d.setUint16(8, entries.length, true);
  d.setUint16(10, entries.length, true);
  d.setUint32(12, cdSize, true);
  d.setUint32(16, offset, true);
  const all = [...parts, ...central, end];
  const out = new Uint8Array(all.reduce((s, x) => s + x.length, 0));
  let p = 0;
  for (const x of all) {
    out.set(x, p);
    p += x.length;
  }
  return out;
}

// ---------------------------------------------------------------- XML

const esc = (s: string) =>
  s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
const unesc = (s: string) =>
  s.replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&quot;/g, '"').replace(/&apos;/g, "'").replace(/&amp;/g, "&");
const attr = (tag: string, name: string) => {
  const m = tag.match(new RegExp(`\\s${name}="([^"]*)"`));
  return m ? unesc(m[1]) : null;
};

export function colNumber(col: string): number {
  let n = 0;
  for (const ch of col) n = n * 26 + (ch.charCodeAt(0) - 64);
  return n;
}
function colLetters(n: number): string {
  let s = "";
  while (n > 0) {
    const r = (n - 1) % 26;
    s = String.fromCharCode(65 + r) + s;
    n = Math.floor((n - 1) / 26);
  }
  return s;
}

/** "2026-11-30" → Excel のシリアル値（46356） */
export function serialDate(iso: string): number {
  const [y, m, d] = iso.slice(0, 10).split("-").map(Number);
  return Math.round((Date.UTC(y, m - 1, d) - Date.UTC(1899, 11, 30)) / 86400000);
}

type Cell = { col: number; xml: string; style: string | null; kind: "empty" | "num" | "str" | "formula" };
type Row = { r: number; open: string; cells: Cell[]; selfClosing: boolean };

function parseCells(inner: string): Cell[] {
  const cells: Cell[] = [];
  for (const m of inner.matchAll(/<c\b([^>]*?)(?:\/>|>([\s\S]*?)<\/c>)/g)) {
    const tag = m[1];
    const body = m[2] ?? "";
    const ref = attr(tag, "r") ?? "";
    const col = colNumber(ref.match(/^[A-Z]+/)?.[0] ?? "A");
    const t = attr(tag, "t");
    let kind: Cell["kind"] = "empty";
    if (/<f\b/.test(body)) kind = "formula";
    else if (t === "s" || t === "inlineStr" || t === "str") kind = /<v>|<t\b/.test(body) ? "str" : "empty";
    else if (/<v>[^<]+<\/v>/.test(body)) kind = "num";
    cells.push({ col, xml: m[0], style: attr(tag, "s"), kind });
  }
  return cells;
}

function cellXml(ref: string, style: string | null, v: Exclude<WriteValue, null>): string {
  const s = style ? ` s="${style}"` : "";
  if (typeof v === "number") return `<c r="${ref}"${s}><v>${v}</v></c>`;
  if (typeof v === "string") {
    const space = /^\s|\s$/.test(v) ? ' xml:space="preserve"' : "";
    return `<c r="${ref}"${s} t="inlineStr"><is><t${space}>${esc(v)}</t></is></c>`;
  }
  if ("date" in v) return `<c r="${ref}"${s}><v>${serialDate(v.date)}</v></c>`;
  return `<c r="${ref}"${s}><f>${esc(v.formula.replace(/^=/, ""))}</f></c>`;
}

const kindOf = (v: Exclude<WriteValue, null>): "num" | "str" | "formula" =>
  typeof v === "string" ? "str" : typeof v === "number" || "date" in v ? "num" : "formula";

/** シートの XML に行を書き足す。書いた行の範囲を返す */
export function appendToSheetXml(xml: string, edit: Omit<SheetEdit, "sheet">): { xml: string; firstRow: number; lastRow: number } {
  const sdStart = xml.indexOf("<sheetData");
  const sdOpenEnd = xml.indexOf(">", sdStart) + 1;
  const selfClosingSheetData = xml[sdOpenEnd - 2] === "/";
  const sdEnd = selfClosingSheetData ? sdOpenEnd : xml.indexOf("</sheetData>", sdOpenEnd);
  if (sdStart < 0 || sdEnd < 0) throw new Error("シートの中身が読めませんでした");
  const body = selfClosingSheetData ? "" : xml.slice(sdOpenEnd, sdEnd);

  const rows: Row[] = [];
  for (const m of body.matchAll(/<row\b([^>]*?)(\/>|>([\s\S]*?)<\/row>)/g)) {
    const r = Number(attr(m[1], "r"));
    rows.push({ r, open: `<row${m[1]}`, cells: m[2] === "/>" ? [] : parseCells(m[3] ?? ""), selfClosing: m[2] === "/>" });
  }
  const byR = new Map(rows.map((r) => [r.r, r]));
  const key = colNumber(edit.keyCol);

  // キーの列が空いている、いちばん上の行（その下もすべて空いている前提ではなく、最後に値がある行の次）
  let lastUsed = edit.startRow - 1;
  for (const row of rows) {
    if (row.r < edit.startRow) continue;
    const c = row.cells.find((x) => x.col === key);
    if (c && c.kind !== "empty") lastUsed = Math.max(lastUsed, row.r);
  }
  const firstRow = lastUsed + 1;

  // 書式を合わせる元：同じ列で、上にある同じ種類の値のセル
  const styleAbove = (col: number, kind: "num" | "str" | "formula", before: number): string | null => {
    for (let r = before - 1; r >= edit.startRow; r--) {
      const c = byR.get(r)?.cells.find((x) => x.col === col);
      if (!c || c.kind === "empty") continue;
      const numeric = (k: Cell["kind"]) => k === "num" || k === "formula"; // 式のセルも数字として扱う
      if (c.kind === kind || (numeric(c.kind) && numeric(kind))) return c.style;
    }
    return null;
  };

  edit.rows.forEach((values, i) => {
    const r = firstRow + i;
    let row = byR.get(r);
    if (!row) {
      const tmpl = byR.get(r - 1);
      const open = tmpl ? tmpl.open.replace(/\sr="\d+"/, ` r="${r}"`).replace(/\sspans="[^"]*"/, "") : `<row r="${r}"`;
      row = { r, open, cells: [], selfClosing: false };
      byR.set(r, row);
      rows.push(row);
    }
    for (const [col, v] of Object.entries(values)) {
      if (v === null || v === undefined) continue;
      const n = colNumber(col);
      const existing = row.cells.find((c) => c.col === n);
      if (existing && existing.kind !== "empty") {
        throw new Error(`${colLetters(n)}${r} にはもう値が入っています。書き込みをやめました`);
      }
      const kind = kindOf(v);
      const style =
        styleAbove(n, kind, r) ?? existing?.style ?? byR.get(r - 1)?.cells.find((c) => c.col === n)?.style ?? null;
      const cell: Cell = { col: n, xml: cellXml(`${colLetters(n)}${r}`, style, v), style, kind };
      if (existing) row.cells[row.cells.indexOf(existing)] = cell;
      else row.cells.push(cell);
    }
    row.cells.sort((a, b) => a.col - b.col);
    row.selfClosing = false;
  });
  const lastRow = firstRow + edit.rows.length - 1;

  rows.sort((a, b) => a.r - b.r);
  const newBody = rows
    .map((row) => (row.cells.length === 0 && row.selfClosing ? `${row.open}/>` : `${row.open}>${row.cells.map((c) => c.xml).join("")}</row>`))
    .join("");
  const sheetData = `<sheetData>${newBody}</sheetData>`;
  let out = xml.slice(0, sdStart) + sheetData + xml.slice(selfClosingSheetData ? sdOpenEnd : sdEnd + "</sheetData>".length);

  // 使っている範囲（dimension）を広げる
  out = out.replace(/<dimension ref="([A-Z]+)(\d+)(?::([A-Z]+)(\d+))?"\/>/, (m, c1, r1, c2, r2) => {
    const endCol = c2 ?? c1;
    const endRow = Math.max(Number(r2 ?? r1), lastRow);
    return `<dimension ref="${c1}${r1}:${endCol}${endRow}"/>`;
  });
  return { xml: out, firstRow, lastRow };
}

// ---------------------------------------------------------------- ブック

/** ブックの、名前で選んだシートに行を書き足す。書き足したブックを返す（元のデータは変えない） */
export async function appendRows(
  data: ArrayBuffer | Uint8Array,
  edits: SheetEdit[],
): Promise<{ data: Uint8Array; written: SheetWritten[] }> {
  const buf = data instanceof Uint8Array ? data : new Uint8Array(data);
  const entries = readZip(buf);
  const dec = new TextDecoder();
  const byName = new Map(entries.map((e) => [dec.decode(e.name), e]));
  const need = (path: string) => {
    const e = byName.get(path);
    if (!e) throw new Error("Excelファイルとして開けませんでした");
    return e;
  };

  const wbEntry = need("xl/workbook.xml");
  const relsEntry = need("xl/_rels/workbook.xml.rels");
  let workbook = await entryText(wbEntry);
  let rels = await entryText(relsEntry);

  const targets = new Map<string, string>();
  for (const m of rels.matchAll(/<Relationship\b([^>]*)\/?>/g)) {
    const id = attr(m[1], "Id");
    const target = attr(m[1], "Target");
    if (id && target) targets.set(id, target.startsWith("/") ? target.slice(1) : `xl/${target}`);
  }
  const sheetPath = new Map<string, string>();
  for (const m of workbook.matchAll(/<sheet\b([^>]*)\/?>/g)) {
    const name = attr(m[1], "name");
    const rid = attr(m[1], "r:id");
    const path = rid ? targets.get(rid) : undefined;
    if (name && path) sheetPath.set(name, path);
  }

  const written: SheetWritten[] = [];
  for (const edit of edits) {
    if (edit.rows.length === 0) continue;
    const path = sheetPath.get(edit.sheet);
    if (!path) throw new Error(`シート「${edit.sheet}」が見つかりません`);
    const e = need(path);
    const res = appendToSheetXml(await entryText(e), edit);
    await setEntryText(e, res.xml);
    written.push({ sheet: edit.sheet, firstRow: res.firstRow, lastRow: res.lastRow });
  }

  // 式の計算：calcChain（計算の順番の覚え書き）は消す。開いたときに全部計算し直す
  const calcIdx = entries.findIndex((e) => dec.decode(e.name) === "xl/calcChain.xml");
  if (calcIdx >= 0) {
    entries.splice(calcIdx, 1);
    rels = rels.replace(/<Relationship\b[^>]*Target="[^"]*calcChain\.xml"[^>]*\/>/g, "");
    await setEntryText(relsEntry, rels);
    const ct = byName.get("[Content_Types].xml");
    if (ct) await setEntryText(ct, (await entryText(ct)).replace(/<Override\b[^>]*PartName="\/xl\/calcChain\.xml"[^>]*\/>/g, ""));
  }
  if (/<calcPr\b/.test(workbook)) {
    workbook = workbook.replace(/<calcPr\b([^>]*?)\/>/, (m, a: string) =>
      /fullCalcOnLoad=/.test(a) ? m : `<calcPr${a} fullCalcOnLoad="1"/>`,
    );
  } else {
    // calcPr は definedNames（なければ sheets）のすぐあとに置く決まり
    const at = workbook.includes("</definedNames>") ? "</definedNames>" : "</sheets>";
    workbook = workbook.replace(at, `${at}<calcPr fullCalcOnLoad="1"/>`);
  }
  await setEntryText(wbEntry, workbook);

  return { data: writeZip(entries), written };
}
