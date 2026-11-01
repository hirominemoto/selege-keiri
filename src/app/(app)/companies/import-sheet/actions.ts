"use server";

import { revalidatePath } from "next/cache";
import { requireAdmin } from "@/lib/auth";
import { dbErrorMessage, type FormState } from "@/lib/form";
import type { LegacyRow } from "@/lib/legacySheet";
import { createClient } from "@/lib/supabase/server";

const isDate = (v: unknown): v is string => typeof v === "string" && /^\d{4}-\d{2}-\d{2}$/.test(v);
const isInt = (v: unknown) => typeof v === "number" && Number.isInteger(v);

/** 企業シートから読んだ行を、取り込み済みの行と入れ替える（Excelファイルそのものは受け取らない） */
export async function importLegacyRows(_prev: FormState, fd: FormData): Promise<FormState> {
  await requireAdmin();
  const raw = fd.get("rows");
  let rows: LegacyRow[];
  try {
    rows = JSON.parse(typeof raw === "string" ? raw : "[]");
  } catch {
    return { ok: false, message: "読み込んだ内容を受け取れませんでした。もう一度ファイルを選んでください" };
  }
  if (!Array.isArray(rows) || rows.length === 0) {
    return { ok: false, message: "取り込む行がありません" };
  }
  const bad = rows.find(
    (r) =>
      !r ||
      typeof r.company_id !== "string" ||
      !r.company_id ||
      typeof r.sheet_name !== "string" ||
      !isInt(r.row_no) ||
      !isDate(r.issue_date) ||
      typeof r.description !== "string" ||
      !isInt(r.amount) ||
      (r.unit_price !== null && !isInt(r.unit_price)) ||
      (r.quantity !== null && typeof r.quantity !== "number") ||
      (r.payment_due_date !== null && !isDate(r.payment_due_date)),
  );
  if (bad) {
    return { ok: false, message: `読めない行がありました（${bad?.sheet_name ?? "?"} の ${bad?.row_no ?? "?"} 行目）` };
  }

  const supabase = await createClient();
  const { data, error } = await supabase.rpc("legacy_sheet_import", { p_rows: rows });
  if (error) return { ok: false, message: dbErrorMessage(error) };

  revalidatePath("/bills/new");
  revalidatePath("/companies", "layout");
  return { ok: true, message: `${data} 行を取り込みました` };
}
