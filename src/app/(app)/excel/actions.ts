"use server";

import { revalidatePath } from "next/cache";
import { requireAdmin } from "@/lib/auth";
import { dbErrorMessage, text, type FormState } from "@/lib/form";
import { createClient } from "@/lib/supabase/server";

export type ExcelBook = "sales" | "ledger" | "company";
export type WrittenItem = { bill_id: string; issued_at: string; sheet: string; first_row: number; last_row: number };

const BOOKS: ExcelBook[] = ["sales", "ledger", "company"];

/** Excelに書いた記録を残す（ファイルそのものは受け取らない。書いた行の場所だけ） */
export async function markExcelWritten(book: ExcelBook, fileName: string, items: WrittenItem[]): Promise<FormState> {
  await requireAdmin();
  if (!BOOKS.includes(book)) return { ok: false, message: "ブックの種類が正しくありません" };
  const bad = items.find(
    (i) =>
      typeof i.bill_id !== "string" ||
      typeof i.issued_at !== "string" ||
      typeof i.sheet !== "string" ||
      !Number.isInteger(i.first_row) ||
      !Number.isInteger(i.last_row) ||
      i.first_row < 1 ||
      i.last_row < i.first_row,
  );
  if (items.length === 0 || bad) return { ok: false, message: "記録する内容を受け取れませんでした。もう一度ファイルを選んでください" };
  const supabase = await createClient();
  const { data, error } = await supabase.rpc("bill_excel_mark", {
    p_book: book,
    p_file_name: fileName.slice(0, 200),
    p_items: items,
  });
  if (error) {
    return { ok: false, message: error.code === "P0001" || error.code === "40001" ? error.message : dbErrorMessage(error) };
  }
  revalidatePath("/excel");
  revalidatePath("/bills", "layout");
  return { ok: true, message: `${data}件を記録しました` };
}

/** 書いた記録を取り消す。もう一度書けるようになる */
export async function unmarkExcelWritten(fd: FormData): Promise<void> {
  await requireAdmin();
  const billId = text(fd, "bill_id");
  const book = text(fd, "book") as ExcelBook | null;
  if (!billId || !book || !BOOKS.includes(book)) return;
  const supabase = await createClient();
  await supabase.rpc("bill_excel_unmark", { p_bill_id: billId, p_book: book });
  revalidatePath("/excel");
  revalidatePath(`/bills/${billId}`);
}
