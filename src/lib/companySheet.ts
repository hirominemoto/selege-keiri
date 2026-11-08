/**
 * 企業シート（企業ごとのシートが並ぶブック）に、アプリで作った請求の行を書き足すための部品
 * ブラウザの中で、読んだブック（SheetData）を見て、どのシートの何行目に何を書くかを決める（書くのは xlsxWrite）
 *
 * シートの形（11/08 企業シート 11/01 保存版で全シートを確かめた。docs/excel-structure.md）
 *   6行目が見出し、7行目から明細。A 請求日｜B クライアント名｜C 案件名｜D 単価｜E 個数｜F 売上金額（税抜）｜G 備考｜H 計上月｜I 支払期限
 *   - 列は見出しの言葉で探す（ユニテクノのシートだけ H 粗利金額・I 計上月で、支払期限がない）
 *   - 明細の下の空いている行には、F に =D×E の式が前もって入っている。その下（77〜81行目）に「売上合計」の行
 *   - B クライアント名が空いている明細の行もあるので、A 請求日か C 案件名のある、いちばん下の行の次から書く
 */
import { excelDate, type CellValue, type SheetData } from "./xlsx";
import { NOT_COMPANY_SHEETS, nameKey, stripMonth } from "./legacySheet";
import { oneLine } from "./excelRows";
import { isValidSheetName, type NewSheet, type SheetEdit, type WriteRow } from "./xlsxWrite";

export const COMPANY_HEADER_ROW = 6;
export const COMPANY_FIRST_ROW = 7;

export type CompanySheetBill = {
  company_name: string;
  /** 企業の別名（シート名やクライアント名の表記ゆれを見分けるため） */
  aliases: string[];
  /** 企業シートの取り込みで、この企業の行があったシートの名前 */
  sheet_hint: string | null;
  issue_date: string; // "2026-11-30"
  accounting_month: string; // "2026-11-01"
  payment_due_date: string;
  lines: { description: string; unit_price: number; quantity: number; amount: number; note: string | null }[];
};

type ColKey = "issue" | "client" | "desc" | "unit" | "qty" | "amount" | "note" | "month" | "due";
const LABELS: Record<ColKey, string> = {
  issue: "請求日",
  client: "クライアント名",
  desc: "案件名",
  unit: "単価",
  qty: "個数",
  amount: "売上金額",
  note: "備考",
  month: "計上月",
  due: "支払期限",
};

const str = (v: CellValue | undefined): string => (v === null || v === undefined ? "" : String(v)).trim();
const norm = (s: string) => s.normalize("NFKC").replace(/\s+/g, "");
const letters = (n: number) => {
  let s = "";
  while (n > 0) {
    const r = (n - 1) % 26;
    s = String.fromCharCode(65 + r) + s;
    n = Math.floor((n - 1) / 26);
  }
  return s;
};

/** 企業のシートの形（6行目の A が「請求日」）か */
export function isCompanySheet(s: SheetData): boolean {
  return !NOT_COMPANY_SHEETS.has(s.name) && str(s.rows.get(COMPANY_HEADER_ROW)?.get(1)).includes("請求日");
}

/** 見出しの言葉から、項目 → 列（"A"…）。見出しにない項目は入らない */
export function headerColumns(s: SheetData): Partial<Record<ColKey, string>> {
  const head = s.rows.get(COMPANY_HEADER_ROW) ?? new Map<number, CellValue>();
  const out: Partial<Record<ColKey, string>> = {};
  for (const [col, v] of [...head.entries()].sort((a, b) => a[0] - b[0])) {
    const label = norm(str(v));
    for (const key of Object.keys(LABELS) as ColKey[]) {
      if (!out[key] && label.startsWith(norm(LABELS[key]))) out[key] = letters(col);
    }
  }
  return out;
}

/** 「売上合計」の行（なければ null） */
export function totalRow(s: SheetData): number | null {
  const rows = [...s.rows.keys()].filter((r) => r >= COMPANY_FIRST_ROW).sort((a, b) => a - b);
  for (const r of rows) {
    for (const v of s.rows.get(r)!.values()) if (str(v) === "売上合計") return r;
  }
  return null;
}

/** 明細のいちばん下の行で使っているクライアント名（B）。なければ B2 */
function lastClientName(s: SheetData, clientCol: number, before: number | null): string | null {
  let last: string | null = null;
  for (const r of [...s.rows.keys()].sort((a, b) => a - b)) {
    if (r < COMPANY_FIRST_ROW || (before && r >= before)) continue;
    const v = str(s.rows.get(r)!.get(clientCol));
    if (v) last = v;
  }
  return last ?? (str(s.rows.get(2)?.get(2)) || null);
}

/**
 * B クライアント名：そのシートで今まで使ってきた書き方（社名）＋「（11月）」
 * 「（5月分）」のように「分」を付けてきたシートは、「（11月分）」にそろえる
 */
export function clientLabel(previous: string | null, companyName: string, month: number): string {
  const base = previous ? stripMonth(previous) : companyName;
  const withBun = previous ? /月分\s*[）)]\s*$/.test(previous) : false;
  return `${base || companyName}（${month}月${withBun ? "分" : ""}）`;
}

/**
 * この企業のシートを探す
 *   1. 取り込みのときにこの企業の行があったシート（名前がそのまま見つかれば）
 *   2. シート名・B2・明細の B クライアント名を、企業名と別名の鍵（表記ゆれを吸収）で突き合わせる
 */
export function findCompanySheet(sheets: SheetData[], bill: Pick<CompanySheetBill, "company_name" | "aliases" | "sheet_hint">): SheetData | null {
  const candidates = sheets.filter(isCompanySheet);
  if (bill.sheet_hint) {
    const hit = candidates.find((s) => s.name === bill.sheet_hint);
    if (hit) return hit;
  }
  const keys = new Set([bill.company_name, ...bill.aliases].map((n) => nameKey(stripMonth(n))).filter(Boolean));
  const names = (s: SheetData) => {
    const out = [s.name, str(s.rows.get(2)?.get(2))];
    const clientCol = headerColumns(s).client;
    if (clientCol) {
      const c = clientCol.charCodeAt(0) - 64;
      for (const [r, row] of s.rows) if (r >= COMPANY_FIRST_ROW) out.push(str(row.get(c)));
    }
    return out.filter(Boolean);
  };
  // シート名・B2 が合うものを先に。なければ明細の社名で
  return (
    candidates.find((s) => names(s).slice(0, 2).some((n) => keys.has(nameKey(stripMonth(n))))) ??
    candidates.find((s) => names(s).some((n) => keys.has(nameKey(stripMonth(n))))) ??
    null
  );
}

/** 同じ請求日・案件名の行が、もうシートにあるか（二重に書かないため。docs/decisions.md） */
export function alreadyInCompanySheet(s: SheetData, bill: Pick<CompanySheetBill, "issue_date" | "lines">): boolean {
  const cols = headerColumns(s);
  if (!cols.issue || !cols.desc) return false;
  const a = cols.issue.charCodeAt(0) - 64;
  const c = cols.desc.charCodeAt(0) - 64;
  const descs = new Set(bill.lines.map((l) => norm(oneLine(l.description))));
  for (const [r, row] of s.rows) {
    if (r < COMPANY_FIRST_ROW) continue;
    if (excelDate(row.get(a) ?? null) === bill.issue_date && descs.has(norm(str(row.get(c))))) return true;
  }
  return false;
}

/** その請求の行を、企業シートの1枚に書き足す形にする */
export function companySheetEdit(s: SheetData, bill: CompanySheetBill): SheetEdit {
  const cols = headerColumns(s);
  if (!cols.issue || !cols.desc) throw new Error(`「${s.name}」シートの見出し（6行目）に「請求日」「案件名」が見つかりません`);
  const before = totalRow(s);
  const month = Number(bill.accounting_month.slice(5, 7));
  const client = cols.client
    ? clientLabel(lastClientName(s, cols.client.charCodeAt(0) - 64, before), bill.company_name, month)
    : null;

  const rows: WriteRow[] = bill.lines.map((l) => {
    const row: WriteRow = {};
    const put = (key: ColKey, v: WriteRow[string]) => {
      const col = cols[key];
      if (col && v !== null && v !== "") row[col] = v;
    };
    put("issue", { date: bill.issue_date });
    put("client", client);
    put("desc", oneLine(l.description));
    put("unit", l.unit_price);
    put("qty", l.quantity);
    // 売上金額は今までどおり =単価×個数 の式（空いている行に前もって入っている式は、そのまま使う）
    put("amount", cols.unit && cols.qty ? { formula: `${cols.unit}{r}*${cols.qty}{r}`, fix: true } : l.amount);
    put("note", l.note);
    put("month", `${month}月`);
    put("due", { date: bill.payment_due_date });
    return row;
  });

  return {
    sheet: s.name,
    startRow: COMPANY_FIRST_ROW,
    keyCol: [cols.issue, cols.desc],
    beforeRow: before ?? undefined,
    rows,
  };
}

const STANDARD_HEADER = ["請求日", "クライアント名", "案件名", "単価", "個数", "売上金額", "備考", "計上月", "支払期限"];

/**
 * 新しい企業のシートの元にするシート：見出しが A〜I のいつもの並びで、「売上合計」の行があるもの
 * そのうち、明細を書ける行がいちばん多いもの（同じなら、ブックの中で先にあるもの）
 */
export function chooseTemplateSheet(sheets: SheetData[]): SheetData | null {
  let best: { s: SheetData; total: number } | null = null;
  for (const s of sheets) {
    if (!isCompanySheet(s)) continue;
    const head = s.rows.get(COMPANY_HEADER_ROW)!;
    if (!STANDARD_HEADER.every((label, i) => norm(str(head.get(i + 1))).startsWith(norm(label)))) continue;
    const total = totalRow(s);
    if (!total) continue;
    if (!best || total > best.total) best = { s, total };
  }
  return best?.s ?? null;
}

/** 新しいシートの名前：企業名（シート名に使えない文字は除き、31文字まで）。同じ名前があれば末尾に 2, 3… */
export function newSheetName(companyName: string, existing: Iterable<string>): string {
  const taken = new Set([...existing].map((n) => n.toLowerCase()));
  const base = companyName.replace(/[:\\/?*[\]]/g, "").replace(/^'+|'+$/g, "").trim().slice(0, 31) || "新しい企業";
  let name = base;
  for (let i = 2; taken.has(name.toLowerCase()) || !isValidSheetName(name); i++) {
    name = `${base.slice(0, 31 - String(i).length)}${i}`;
  }
  return name;
}

/**
 * 元のシートを写した、新しい企業のシートを用意する
 *   - spec：xlsxWrite で写すときの指示（明細の行と上の欄は値を消す。F には =D×E を入れ直す。B2 は新しい企業名）
 *   - sheet：写したあとのシートの中身（書く行を決めるために使う）
 */
export function prepareNewCompanySheet(
  template: SheetData,
  name: string,
  bill: Pick<CompanySheetBill, "company_name" | "accounting_month">,
  after?: string,
): { spec: NewSheet; sheet: SheetData } {
  const total = totalRow(template);
  if (!total) throw new Error(`「${template.name}」シートに「売上合計」の行がありません`);
  const cols = headerColumns(template);
  const client = clientLabel(null, bill.company_name, Number(bill.accounting_month.slice(5, 7)));
  const formulas = cols.amount && cols.unit && cols.qty ? { [cols.amount]: `${cols.unit}{r}*${cols.qty}{r}` } : undefined;
  const spec: NewSheet = {
    name,
    copyOf: template.name,
    after,
    clear: [
      { from: 1, to: COMPANY_HEADER_ROW - 1, keep: ["A2"] },
      { from: COMPANY_FIRST_ROW, to: total - 1, formulas },
    ],
    set: { B2: client },
  };
  const rows = new Map<number, Map<number, CellValue>>();
  for (const [r, row] of template.rows) {
    if (r >= COMPANY_FIRST_ROW && r < total) continue;
    if (r < COMPANY_HEADER_ROW) {
      if (r === 2) rows.set(2, new Map<number, CellValue>([[1, row.get(1) ?? "クライアント名"], [2, client]]));
      continue;
    }
    rows.set(r, new Map(row));
  }
  if (!rows.has(2)) rows.set(2, new Map<number, CellValue>([[2, client]]));
  return { spec, sheet: { name, rows } };
}

/**
 * 請求ごとに企業のシートを探し、シートごとにまとめて書く形にする
 * 同じシートに書く請求が2件以上あるときは、行をつなげて1つの SheetEdit にする（請求ごとの行数は rowCount で別に持つ）
 * その企業のシートがなければ、いつもの形のシートを写して新しいシートを足す（newSheets）
 */
export function planCompanySheets<T extends { companyBill?: CompanySheetBill }>(sheets: SheetData[], items: T[]) {
  const inFile: T[] = [];
  const noSheet: T[] = [];
  const newSheets: NewSheet[] = [];
  const added: SheetData[] = [];
  // 新しく足すシートは、同じ企業名の請求だけで使い回す（表記ゆれで、今ある別の企業の請求を入れないため）
  const addedFor = new Map<string, SheetData>();
  const template = chooseTemplateSheet(sheets);
  const lastCompany = [...sheets].reverse().find(isCompanySheet)?.name;
  const plan = new Map<string, { edit: SheetEdit; items: { item: T; rowCount: number }[] }>();
  for (const item of items) {
    const bill = item.companyBill;
    if (!bill) {
      noSheet.push(item);
      continue;
    }
    let sheet = findCompanySheet(sheets, bill) ?? addedFor.get(bill.company_name) ?? null;
    if (!sheet) {
      if (!template) {
        noSheet.push(item);
        continue;
      }
      const name = newSheetName(bill.company_name, [...sheets, ...added].map((x) => x.name));
      const after = added.length ? added[added.length - 1].name : lastCompany;
      const prepared = prepareNewCompanySheet(template, name, bill, after);
      newSheets.push(prepared.spec);
      added.push(prepared.sheet);
      addedFor.set(bill.company_name, prepared.sheet);
      sheet = prepared.sheet;
    } else if (alreadyInCompanySheet(sheet, bill)) {
      inFile.push(item);
      continue;
    }
    const edit = companySheetEdit(sheet, bill);
    const rowCount = edit.rows.length;
    const p = plan.get(sheet.name);
    if (p) {
      p.edit.rows = [...p.edit.rows, ...edit.rows];
      p.items.push({ item, rowCount });
    } else {
      plan.set(sheet.name, { edit: { ...edit, rows: [...edit.rows] }, items: [{ item, rowCount }] });
    }
  }
  return { inFile, noSheet, newSheets, plan: [...plan.values()] };
}
