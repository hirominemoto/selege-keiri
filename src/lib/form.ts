/** フォーム入力の読み取りとチェック。間違いは日本語で、どの項目かわかる形で返す */

export type FormState = {
  ok?: boolean;
  message?: string;
  errors?: Record<string, string>;
};

export class FieldErrors {
  errors: Record<string, string> = {};
  add(field: string, message: string) {
    if (!this.errors[field]) this.errors[field] = message;
  }
  get any() {
    return Object.keys(this.errors).length > 0;
  }
  state(): FormState {
    return { ok: false, message: "入力内容を確認してください", errors: this.errors };
  }
}

export function text(fd: FormData, name: string): string | null {
  const v = fd.get(name);
  if (typeof v !== "string") return null;
  const t = v.trim();
  return t === "" ? null : t;
}

export function requiredText(fd: FormData, name: string, label: string, errs: FieldErrors): string {
  const v = text(fd, name);
  if (!v) errs.add(name, `${label}を入力してください`);
  return v ?? "";
}

/** 全角の数字・ハイフンを半角にする */
export function toHalfWidthDigits(raw: string): string {
  return raw
    .replace(/[０-９]/g, (c) => String.fromCharCode(c.charCodeAt(0) - 0xfee0))
    .replace(/[－ー−‐]/g, "-");
}

/** 郵便番号を「530-0001」の形にそろえる。形が違えば null */
export function normalizePostal(raw: string): string | null {
  const digits = toHalfWidthDigits(raw).replace(/[^\d]/g, "");
  return digits.length === 7 ? `${digits.slice(0, 3)}-${digits.slice(3)}` : null;
}

/** 全角数字・カンマ・円を許して整数にする。「２」「76,000円」も読める */
export function normalizeNumber(raw: string): string {
  return raw
    .replace(/[０-９]/g, (c) => String.fromCharCode(c.charCodeAt(0) - 0xfee0))
    .replace(/[，,円\s]/g, "")
    .replace(/[－ー−]/g, "-");
}

export function integer(
  fd: FormData,
  name: string,
  label: string,
  errs: FieldErrors,
  opts: { required?: boolean; min?: number; max?: number } = {},
): number | null {
  const raw = text(fd, name);
  if (raw === null) {
    if (opts.required) errs.add(name, `${label}を入力してください`);
    return null;
  }
  const n = Number(normalizeNumber(raw));
  if (!Number.isInteger(n)) {
    errs.add(name, `${label}は整数で入力してください`);
    return null;
  }
  if (opts.min !== undefined && n < opts.min) errs.add(name, `${label}は${opts.min}以上にしてください`);
  if (opts.max !== undefined && n > opts.max) errs.add(name, `${label}は${opts.max}以下にしてください`);
  return n;
}

export function decimal(fd: FormData, name: string, label: string, errs: FieldErrors): number | null {
  const raw = text(fd, name);
  if (raw === null) return null;
  const n = Number(normalizeNumber(raw));
  if (!Number.isFinite(n)) {
    errs.add(name, `${label}は数字で入力してください`);
    return null;
  }
  return n;
}

/** <input type="month"> の "2026-11" を "2026-11-01" にする */
export function month(fd: FormData, name: string, label: string, errs: FieldErrors): string | null {
  const raw = text(fd, name);
  if (raw === null) return null;
  if (!/^\d{4}-\d{2}$/.test(raw)) {
    errs.add(name, `${label}は年と月をカレンダーから選んでください`);
    return null;
  }
  return `${raw}-01`;
}

export function choice<T extends string>(
  fd: FormData,
  name: string,
  allowed: readonly T[],
  fallback: T,
): T {
  const v = text(fd, name);
  return v && (allowed as readonly string[]).includes(v) ? (v as T) : fallback;
}

/** データベースのエラーを、利用者にわかる言葉にする */
export function dbErrorMessage(err: { code?: string; message?: string } | null): string {
  if (!err) return "保存できませんでした";
  if (err.code === "23505") return "同じ内容がすでに登録されています";
  if (err.code === "23514") return "入力内容がルールに合っていません";
  if (err.code === "42501") return "この操作をする権限がありません";
  return `保存できませんでした（${err.message ?? "不明なエラー"}）`;
}

export const CONFLICT_MESSAGE =
  "ほかの人（または別の画面）が先に更新しました。画面を読み直してから、もう一度入力してください";
