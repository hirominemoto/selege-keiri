/** 請求まわりの共通の計算（画面の表示用。送付OKのときの正式な計算はデータベースが行う） */

/** "2026-11-01" に n か月足した "2026-12-01" */
export function addMonths(month: string, n: number): string {
  const [y, m] = month.split("-").map(Number);
  const d = new Date(Date.UTC(y, m - 1 + n, 1));
  return `${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, "0")}-01`;
}

/** その月の末日 "2026-11-30" */
export function monthEnd(month: string): string {
  const next = addMonths(month, 1);
  const d = new Date(`${next}T00:00:00Z`);
  d.setUTCDate(0);
  return d.toISOString().slice(0, 10);
}

/** "2026-11" や "2026-11-01" を "2026-11-01" にそろえる。形が違えば null */
export function parseMonth(raw: string | null | undefined): string | null {
  if (!raw) return null;
  const m = /^(\d{4})-(\d{2})/.exec(raw);
  if (!m) return null;
  const month = Number(m[2]);
  if (month < 1 || month > 12) return null;
  return `${m[1]}-${m[2]}-01`;
}

export type TaxRounding = "ceil" | "floor" | "round";

/** 消費税（データベースの calc_tax と同じ考え方） */
export function calcTax(taxable: number, rate: number, mode: TaxRounding): number {
  const raw = (taxable * Math.round(rate * 100)) / 100;
  if (mode === "floor") return Math.floor(raw);
  if (mode === "round") return Math.round(raw);
  return Math.ceil(raw);
}

export type LineForTotal = { amount: number; taxable: boolean };

export type Totals = {
  taxable: number;
  nontaxable: number;
  tax: number;
  total: number;
};

export function invoiceTotals(lines: LineForTotal[], rate: number, mode: TaxRounding): Totals {
  const taxable = lines.filter((l) => l.taxable).reduce((s, l) => s + l.amount, 0);
  const nontaxable = lines.filter((l) => !l.taxable).reduce((s, l) => s + l.amount, 0);
  const tax = calcTax(taxable, rate, mode);
  return { taxable, nontaxable, tax, total: taxable + nontaxable + tax };
}

/** 請求状況（contract_billing_status の state）の表示 */
export const billingStateLabel: Record<string, string> = {
  invoiced: "請求済み",
  correcting: "訂正中",
  draft: "下書きあり",
  legacy: "Excelで請求済み",
  out_of_scope: "対象外",
  none: "請求なし（都度）",
  unbilled: "未請求",
};

export const invoiceStatusLabel: Record<string, string> = {
  draft: "下書き",
  send_ok: "送付OK",
  sent: "送付済み",
  superseded: "訂正済み（旧版）",
  cancelled: "取消",
};

/** 請求書に印字する自社の情報（app_settings の issuer） */
export type Issuer = {
  name?: string;
  postal_code?: string;
  address?: string; // 改行で区切って複数行
  phone?: string;
  registration_no?: string;
  bank?: string; // 改行で区切って複数行
  seal?: string; // 角印の画像（data:image/png;base64,...）
};
