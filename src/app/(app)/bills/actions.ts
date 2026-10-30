"use server";

import { revalidatePath } from "next/cache";
import { redirect } from "next/navigation";
import { requireAdmin } from "@/lib/auth";
import { hasAtMost2Decimals, readNumber } from "@/lib/bills";
import { CONFLICT_MESSAGE, FieldErrors, dbErrorMessage, text, type FormState } from "@/lib/form";
import { createClient } from "@/lib/supabase/server";

type LineIn = {
  description?: unknown;
  unit_price?: unknown;
  quantity?: unknown;
  taxable?: unknown;
  note?: unknown;
  contract_id?: unknown;
  count_no?: unknown;
  service_month?: unknown;
};

const isDate = (v: string | null): v is string => !!v && /^\d{4}-\d{2}-\d{2}$/.test(v);

/** 請求の保存（新規・入力中の修正）。明細は画面から JSON で受け取る */
export async function saveBill(_prev: FormState, fd: FormData): Promise<FormState> {
  await requireAdmin();
  const errs = new FieldErrors();

  const id = text(fd, "id");
  const version = text(fd, "version");
  const companyId = text(fd, "company_id");
  const issueDate = text(fd, "issue_date");
  const month = text(fd, "accounting_month");
  const due = text(fd, "payment_due_date");
  const sendMethod = text(fd, "send_method") === "email" ? "email" : "post";

  if (!companyId) errs.add("company_id", "企業を選んでください");
  if (!isDate(issueDate)) errs.add("issue_date", "請求日をカレンダーから選んでください");
  if (!month || !/^\d{4}-\d{2}$/.test(month)) errs.add("accounting_month", "計上月を選んでください");
  if (!isDate(due)) errs.add("payment_due_date", "支払期限をカレンダーから選んでください");
  if (isDate(issueDate) && isDate(due) && due < issueDate) {
    errs.add("payment_due_date", "支払期限が請求日より前になっています");
  }

  let raw: LineIn[] = [];
  try {
    raw = JSON.parse(text(fd, "lines") ?? "[]");
  } catch {
    return { ok: false, message: "明細を読み取れませんでした。画面を読み込み直してください" };
  }
  const lines = raw
    .map((l) => ({
      description: String(l.description ?? "").trim(),
      unit_price: readNumber(String(l.unit_price ?? "")),
      quantity: readNumber(String(l.quantity ?? "")),
      taxable: l.taxable !== false,
      note: String(l.note ?? "").trim(),
      contract_id: typeof l.contract_id === "string" && l.contract_id ? l.contract_id : null,
      count_no: readNumber(String(l.count_no ?? "")),
      service_month: typeof l.service_month === "string" && /^\d{4}-\d{2}-01$/.test(l.service_month) ? l.service_month : null,
    }))
    // 何も入れていない行は無視する
    .filter((l) => l.description || l.unit_price !== null || l.note || l.contract_id);

  if (lines.length === 0) errs.add("lines", "明細を1行以上入れてください");
  lines.forEach((l, i) => {
    const n = i + 1;
    if (!l.description) errs.add(`line-${i}-description`, `${n}行目の内訳を入れてください`);
    if (l.unit_price === null) errs.add(`line-${i}-unit_price`, `${n}行目の単価を入れてください`);
    else if (!Number.isInteger(l.unit_price)) errs.add(`line-${i}-unit_price`, `${n}行目の単価は円単位の整数にしてください`);
    if (l.quantity === null || l.quantity === 0) errs.add(`line-${i}-quantity`, `${n}行目の個数を入れてください`);
    else if (!hasAtMost2Decimals(l.quantity)) {
      errs.add(`line-${i}-quantity`, `${n}行目の個数は小数第2位までにしてください`);
    }
    if (l.contract_id && (l.count_no === null || !Number.isInteger(l.count_no) || l.count_no < 1)) {
      errs.add(`line-${i}-count_no`, `${n}行目の回数を1以上の整数で入れてください`);
    }
  });
  if (errs.any) return errs.state();

  const supabase = await createClient();
  const { data, error } = await supabase.rpc("bill_save", {
    p_id: id,
    p_version: version ? Number(version) : null,
    p_bill: {
      company_id: companyId,
      issue_date: issueDate,
      accounting_month: `${month}-01`,
      payment_due_date: due,
      staff_name: text(fd, "staff_name"),
      send_method: sendMethod,
      memo: text(fd, "memo"),
    },
    p_lines: lines.map((l) => ({ ...l, quantity: l.quantity ?? 1, count_no: l.contract_id ? l.count_no : null })),
  });
  if (error) {
    if (error.code === "40001") return { ok: false, message: CONFLICT_MESSAGE };
    return { ok: false, message: error.code === "P0001" ? (error.message ?? "保存できませんでした") : dbErrorMessage(error) };
  }

  revalidatePath("/bills");
  redirect(`/bills/${data as string}?saved=1`);
}

/** 入力中の請求を消す */
export async function deleteBill(fd: FormData): Promise<void> {
  await requireAdmin();
  const id = text(fd, "id");
  if (!id) return;
  const supabase = await createClient();
  const { error } = await supabase.rpc("bill_delete_draft", { p_id: id });
  if (error) throw new Error(error.message);
  revalidatePath("/bills");
  redirect("/bills?deleted=1");
}
