"use server";

import { revalidatePath } from "next/cache";
import { redirect } from "next/navigation";
import { requireAdmin } from "@/lib/auth";
import { addMonths, parseMonth } from "@/lib/billing";
import { monthName, nextCount, renderTemplate } from "@/lib/contract";
import { createClient } from "@/lib/supabase/server";
import {
  CONFLICT_MESSAGE,
  FieldErrors,
  choice,
  dbErrorMessage,
  decimal,
  integer,
  requiredText,
  text,
  type FormState,
} from "@/lib/form";
import type { Contract } from "@/lib/types";

// ---------------------------------------------------------------------
// 契約を選んで、下書きをまとめて作る
// ---------------------------------------------------------------------

export async function createDrafts(_prev: FormState, fd: FormData): Promise<FormState> {
  await requireAdmin();
  const billingMonth = parseMonth(text(fd, "billing_month"));
  if (!billingMonth) return { ok: false, message: "請求月がわかりません。画面を読み込み直してください" };
  const ids = fd.getAll("contract_id").filter((v): v is string => typeof v === "string" && v !== "");
  if (ids.length === 0) return { ok: false, message: "下書きを作る契約にチェックを入れてください" };

  const supabase = await createClient();
  // 画面から送られた値は使わず、品名・回数・金額は契約から組み立て直す
  const [{ data: contractData, error }, { data: reqData }] = await Promise.all([
    supabase.from("contracts").select("*").in("id", ids),
    supabase
      .from("billing_requests")
      .select("contract_id, count_no")
      .in("contract_id", ids)
      .eq("kind", "normal")
      .eq("status", "active"),
  ]);
  if (error) return { ok: false, message: dbErrorMessage(error) };
  const maxCount = new Map<string, number>();
  for (const r of reqData ?? []) {
    if (r.contract_id && r.count_no !== null) {
      maxCount.set(r.contract_id, Math.max(maxCount.get(r.contract_id) ?? 0, r.count_no));
    }
  }

  const items = ((contractData ?? []) as Contract[]).map((c) => {
    const n = nextCount(c.base_count, maxCount.get(c.id) ?? null);
    const hasCount = (c.description_template ?? "").includes("{回数}") || !c.description_template;
    return {
      contract_id: c.id,
      service_month: addMonths(billingMonth, c.service_month_offset),
      count_no: hasCount ? n : null,
      description: renderTemplate(c.description_template, {
        人数: Number(c.quantity),
        契約名: c.name,
        期: c.cohort ?? "",
        対象月: monthName(billingMonth, c.service_month_offset),
        回数: n,
        全回数: c.total_count ?? "",
      }),
      quantity: Number(c.quantity),
      unit_price: c.unit_price,
      taxable: c.taxable,
    };
  });

  const { data, error: rpcError } = await supabase.rpc("billing_create_drafts", {
    p_billing_month: billingMonth,
    p_items: items,
  });
  if (rpcError) return { ok: false, message: dbErrorMessage(rpcError) };

  const result = data as { created: number; skipped: number; invoices: string[] };
  revalidatePath("/billing");
  if (result.invoices.length === 1) redirect(`/billing/invoices/${result.invoices[0]}`);
  return {
    ok: true,
    message:
      `${result.created}件の下書きを作りました（請求書 ${result.invoices.length}枚）` +
      (result.skipped ? `。${result.skipped}件はすでに依頼があったので飛ばしました` : ""),
  };
}

// ---------------------------------------------------------------------
// 下書きの請求書：送り方・日付
// ---------------------------------------------------------------------

export async function saveInvoiceSettings(_prev: FormState, fd: FormData): Promise<FormState> {
  await requireAdmin();
  const errs = new FieldErrors();
  const id = text(fd, "id");
  if (!id) return { ok: false, message: "請求書が指定されていません" };

  const sendRaw = text(fd, "send_method");
  const values = {
    send_method: sendRaw ? choice(fd, "send_method", ["post", "email"] as const, "post") : null,
    send_to_email: text(fd, "send_to_email"),
    issue_date: dateValue(fd, "issue_date", "請求日", errs),
    payment_due_date: dateValue(fd, "payment_due_date", "入金予定日", errs),
    note: text(fd, "note"),
  };
  if (values.send_method === "email" && !values.send_to_email) {
    errs.add("send_to_email", "メールで送るときは、送付先メールアドレスを入れてください");
  }
  if (values.send_to_email && !/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(values.send_to_email)) {
    errs.add("send_to_email", "メールアドレスの形が正しくありません");
  }
  if (errs.any) return errs.state();

  const supabase = await createClient();
  const { data, error } = await supabase
    .from("invoices")
    .update(values)
    .eq("id", id)
    .eq("status", "draft")
    .eq("version", Number(fd.get("version")))
    .select("id");
  if (error) return { ok: false, message: dbErrorMessage(error) };
  if (!data || data.length === 0) return { ok: false, message: CONFLICT_MESSAGE };

  revalidatePath(`/billing/invoices/${id}`);
  return { ok: true, message: "保存しました" };
}

function dateValue(fd: FormData, name: string, label: string, errs: FieldErrors): string | null {
  const raw = text(fd, name);
  if (raw === null) return null;
  if (!/^\d{4}-\d{2}-\d{2}$/.test(raw)) {
    errs.add(name, `${label}はカレンダーから選んでください`);
    return null;
  }
  return raw;
}

// ---------------------------------------------------------------------
// 下書きの明細
// ---------------------------------------------------------------------

export async function saveLine(_prev: FormState, fd: FormData): Promise<FormState> {
  await requireAdmin();
  const errs = new FieldErrors();
  const id = text(fd, "line_id");
  const invoiceId = text(fd, "invoice_id");
  if (!id || !invoiceId) return { ok: false, message: "明細が指定されていません" };

  const description = requiredText(fd, "description", "品名", errs);
  const quantity = decimal(fd, "quantity", "数量", errs);
  const unitPrice = integer(fd, "unit_price", "単価", errs, { required: true });
  if (quantity !== null && quantity <= 0) errs.add("quantity", "数量は0より大きくしてください");
  if (errs.any) return errs.state();

  const q = quantity ?? 1;
  const amount = Math.round(q * (unitPrice ?? 0));
  if (amount === 0) return { ok: false, errors: { unit_price: "金額が0円になります。単価を確かめてください" } };

  const supabase = await createClient();
  const { data, error } = await supabase
    .from("billing_request_lines")
    .update({ description, quantity: q, unit_price: unitPrice, amount })
    .eq("id", id)
    .select("id");
  if (error) return { ok: false, message: dbErrorMessage(error) };
  if (!data || data.length === 0) return { ok: false, message: CONFLICT_MESSAGE };

  revalidatePath(`/billing/invoices/${invoiceId}`);
  return { ok: true, message: "保存しました" };
}

/** 依頼を1件外す（その契約はまた「未請求」に戻る） */
export async function removeRequest(fd: FormData): Promise<void> {
  await requireAdmin();
  const id = text(fd, "request_id");
  const invoiceId = text(fd, "invoice_id");
  if (!id || !invoiceId) return;
  const supabase = await createClient();
  const { error } = await supabase.from("billing_requests").delete().eq("id", id);
  if (error) throw new Error(dbErrorMessage(error));
  revalidatePath(`/billing/invoices/${invoiceId}`);
  revalidatePath("/billing");
}

/** 下書きを片付ける（載っている依頼ごと） */
export async function discardDraft(fd: FormData): Promise<void> {
  await requireAdmin();
  const id = text(fd, "invoice_id");
  const month = text(fd, "billing_month");
  if (!id) return;
  const supabase = await createClient();
  const { error } = await supabase.rpc("invoice_discard_draft", { p_invoice_id: id });
  if (error) throw new Error(dbErrorMessage(error));
  revalidatePath("/billing");
  redirect(`/billing${month ? `?month=${month.slice(0, 7)}` : ""}`);
}
