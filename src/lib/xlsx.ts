/**
 * Excel（.xlsx / .xlsm）を読むだけの小さな部品。ブラウザの中で動く（ファイルはサーバーに送らない）
 * 外部のライブラリは使わない：zip は ブラウザ標準の DecompressionStream で開き、XML は必要なところだけ読む
 * 計算式のセルは、Excel が最後に保存したときの値を読む
 */

export type CellValue = string | number | boolean | null;
/** シートの中身：rows[行番号][列番号]（どちらも 1 から） */
export type SheetData = { name: string; rows: Map<number, Map<number, CellValue>> };

type ZipEntry = { name: string; method: number; compSize: number; offset: number };

function readZipEntries(buf: Uint8Array): ZipEntry[] {
  const dv = new DataView(buf.buffer, buf.byteOffset, buf.byteLength);
  // 末尾の「中央ディレクトリの終わり」を探す
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
  const dec = new TextDecoder();
  const entries: ZipEntry[] = [];
  for (let i = 0; i < count; i++) {
    if (dv.getUint32(p, true) !== 0x02014b50) throw new Error("Excelファイルの中身が読めませんでした");
    const method = dv.getUint16(p + 10, true);
    const compSize = dv.getUint32(p + 20, true);
    const nameLen = dv.getUint16(p + 28, true);
    const extraLen = dv.getUint16(p + 30, true);
    const commentLen = dv.getUint16(p + 32, true);
    const localOffset = dv.getUint32(p + 42, true);
    const name = dec.decode(buf.subarray(p + 46, p + 46 + nameLen));
    entries.push({ name, method, compSize, offset: localOffset });
    p += 46 + nameLen + extraLen + commentLen;
  }
  return entries;
}

async function inflateRaw(data: Uint8Array): Promise<Uint8Array> {
  const stream = new Blob([data as BlobPart]).stream().pipeThrough(new DecompressionStream("deflate-raw"));
  return new Uint8Array(await new Response(stream).arrayBuffer());
}

async function readEntry(buf: Uint8Array, e: ZipEntry): Promise<string> {
  const dv = new DataView(buf.buffer, buf.byteOffset, buf.byteLength);
  const nameLen = dv.getUint16(e.offset + 26, true);
  const extraLen = dv.getUint16(e.offset + 28, true);
  const start = e.offset + 30 + nameLen + extraLen;
  const raw = buf.subarray(start, start + e.compSize);
  const bytes = e.method === 0 ? raw : await inflateRaw(raw);
  return new TextDecoder().decode(bytes);
}

const unescapeXml = (s: string) =>
  s
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'")
    .replace(/&#(\d+);/g, (_, d) => String.fromCodePoint(Number(d)))
    .replace(/&#x([0-9a-fA-F]+);/g, (_, h) => String.fromCodePoint(parseInt(h, 16)))
    .replace(/&amp;/g, "&");

const attr = (tag: string, name: string) => {
  const m = tag.match(new RegExp(`\\s${name}="([^"]*)"`));
  return m ? unescapeXml(m[1]) : null;
};

/** <t> の文字をつなげる（ふりがな <rPh> は外す） */
function textOf(xml: string): string {
  const body = xml.replace(/<rPh\b[\s\S]*?<\/rPh>/g, "");
  let out = "";
  for (const m of body.matchAll(/<t(?:\s[^>]*)?>([\s\S]*?)<\/t>|<t(?:\s[^>]*)?\/>/g)) out += unescapeXml(m[1] ?? "");
  return out;
}

function colNumber(ref: string): number {
  const letters = ref.match(/^[A-Z]+/)?.[0] ?? "A";
  let n = 0;
  for (const ch of letters) n = n * 26 + (ch.charCodeAt(0) - 64);
  return n;
}

function parseSheet(name: string, xml: string, shared: string[]): SheetData {
  const rows = new Map<number, Map<number, CellValue>>();
  for (const m of xml.matchAll(/<c\b([^>]*?)(?:\/>|>([\s\S]*?)<\/c>)/g)) {
    const tag = m[1];
    const inner = m[2] ?? "";
    const ref = attr(tag, "r");
    if (!ref) continue;
    const t = attr(tag, "t");
    const v = inner.match(/<v>([\s\S]*?)<\/v>/)?.[1];
    let value: CellValue = null;
    if (t === "s") value = v !== undefined ? (shared[Number(v)] ?? null) : null;
    else if (t === "inlineStr") value = textOf(inner);
    else if (t === "str" || t === "e") value = v !== undefined ? unescapeXml(v) : null;
    else if (t === "b") value = v === "1";
    else if (v !== undefined && v !== "") value = Number(v);
    if (value === null || value === "") continue;
    const row = Number(ref.match(/\d+$/)?.[0]);
    const col = colNumber(ref);
    if (!rows.has(row)) rows.set(row, new Map());
    rows.get(row)!.set(col, value);
  }
  return { name, rows };
}

/** ブックのすべてのシートを読む（並びはExcelのシートの順） */
export async function readWorkbook(data: ArrayBuffer | Uint8Array): Promise<SheetData[]> {
  const buf = data instanceof Uint8Array ? data : new Uint8Array(data);
  const entries = new Map(readZipEntries(buf).map((e) => [e.name, e]));
  const get = async (path: string) => {
    const e = entries.get(path);
    return e ? readEntry(buf, e) : null;
  };

  const workbook = await get("xl/workbook.xml");
  const rels = await get("xl/_rels/workbook.xml.rels");
  if (!workbook || !rels) throw new Error("Excelファイルとして開けませんでした");

  const sharedXml = await get("xl/sharedStrings.xml");
  const shared = sharedXml ? [...sharedXml.matchAll(/<si>([\s\S]*?)<\/si>/g)].map((m) => textOf(m[1])) : [];

  const targets = new Map<string, string>();
  for (const m of rels.matchAll(/<Relationship\b([^>]*)\/?>/g)) {
    const id = attr(m[1], "Id");
    const target = attr(m[1], "Target");
    if (id && target) targets.set(id, target.startsWith("/") ? target.slice(1) : `xl/${target}`);
  }

  const sheets: SheetData[] = [];
  for (const m of workbook.matchAll(/<sheet\b([^>]*)\/?>/g)) {
    const name = attr(m[1], "name");
    const rid = attr(m[1], "r:id");
    const path = rid ? targets.get(rid) : undefined;
    if (!name || !path) continue;
    const xml = await get(path);
    if (xml) sheets.push(parseSheet(name, xml, shared));
  }
  return sheets;
}

/** Excel の日付（シリアル値 46356 や「2026/10/31」の文字）を "2026-10-31" に。読めなければ null */
export function excelDate(v: CellValue): string | null {
  if (typeof v === "number" && v > 20000 && v < 80000) {
    const d = new Date(Date.UTC(1899, 11, 30) + Math.floor(v) * 86400000);
    return d.toISOString().slice(0, 10);
  }
  if (typeof v === "string") {
    const m = v.normalize("NFKC").trim().match(/^(\d{4})[/\-.年](\d{1,2})[/\-.月](\d{1,2})日?$/);
    if (m) return `${m[1]}-${m[2].padStart(2, "0")}-${m[3].padStart(2, "0")}`;
  }
  return null;
}
