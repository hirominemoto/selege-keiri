"use server";

import { revalidatePath } from "next/cache";
import { redirect } from "next/navigation";
import { requireAdmin } from "@/lib/auth";
import { createClient } from "@/lib/supabase/server";
import {
  CONFLICT_MESSAGE,
  FieldErrors,
  choice,
  dbErrorMessage,
  decimal,
  integer,
  month,
  normalizePostal,
  requiredText,
  text,
  type FormState,
} from "@/lib/form";

// ---------------------------------------------------------------------
// 企業
// ---------------------------------------------------------------------

export async function saveCompany(_prev: FormState, fd: FormData): Promise<FormState> {
  await requireAdmin();
  const errs = new FieldErrors();

  const values = {
    name: requiredText(fd, "name", "企業名", errs),
    honorific: text(fd, "honorific") ?? "御中",
    postal_code: text(fd, "postal_code"),
    address1: text(fd, "address1"),
    address2: text(fd, "address2"),
    department: text(fd, "department"),
    contact_name: text(fd, "contact_name"),
    phone: text(fd, "phone"),
    email: text(fd, "email"),
    send_method: choice(fd, "send_method", ["post", "email"] as const, "post"),
    payment_due_months: integer(fd, "payment_due_months", "入金予定の月", errs, { required: true, min: 0, max: 6 }) ?? 1,
    payment_due_day: integer(fd, "payment_due_day", "入金予定の日", errs, { min: 1, max: 31 }),
    note: text(fd, "note"),
    is_active: fd.get("is_active") !== "false",
  };

  if (values.postal_code) {
    const pc = normalizePostal(values.postal_code);
    if (pc) values.postal_code = pc;
    else errs.add("postal_code", "郵便番号は「530-0001」の形で入力してください");
  }
  if (values.send_method === "email" && !values.email) {
    errs.add("email", "メールで送る企業は、送付先メールアドレスを入力してください");
  }
  if (values.email && !/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(values.email)) {
    errs.add("email", "メールアドレスの形が正しくありません");
  }
  if (errs.any) return errs.state();

  const supabase = await createClient();
  const id = text(fd, "id");

  if (!id) {
    const { data, error } = await supabase.from("companies").insert(values).select("id").single();
    if (error) {
      if (error.code === "23505") return { ok: false, errors: { name: "同じ名前の企業がすでに登録されています" } };
      return { ok: false, message: dbErrorMessage(error) };
    }
    revalidatePath("/companies");
    redirect(`/companies/${data.id}`);
  }

  const version = Number(fd.get("version"));
  const { data, error } = await supabase
    .from("companies")
    .update(values)
    .eq("id", id)
    .eq("version", version)
    .select("id");
  if (error) {
    if (error.code === "23505") return { ok: false, errors: { name: "同じ名前の企業がすでに登録されています" } };
    return { ok: false, message: dbErrorMessage(error) };
  }
  if (!data || data.length === 0) return { ok: false, message: CONFLICT_MESSAGE };

  revalidatePath("/companies");
  revalidatePath(`/companies/${id}`);
  redirect(`/companies/${id}`);
}

// ---------------------------------------------------------------------
// 契約
// ---------------------------------------------------------------------

export async function saveContract(_prev: FormState, fd: FormData): Promise<FormState> {
  await requireAdmin();
  const errs = new FieldErrors();

  const companyId = text(fd, "company_id");
  if (!companyId) return { ok: false, message: "企業が指定されていません" };

  const kind = choice(fd, "kind", ["monthly", "on_demand", "one_time"] as const, "monthly");
  const values = {
    company_id: companyId,
    name: requiredText(fd, "name", "契約名", errs),
    cohort: text(fd, "cohort"),
    kind,
    quantity: decimal(fd, "quantity", "人数・個数", errs) ?? 1,
    unit_price: integer(fd, "unit_price", "単価", errs, { required: true }) ?? 0,
    taxable: fd.get("taxable") !== "false",
    service_month_offset: Number(choice(fd, "service_month_offset", ["0", "1"] as const, "0")) as 0 | 1,
    total_count: integer(fd, "total_count", "全回数", errs, { min: 1 }),
    count_unit: choice(fd, "count_unit", ["回", "か月"] as const, "回"),
    base_count: integer(fd, "base_count", "請求済みの回数", errs, { min: 0 }) ?? 0,
    start_month: month(fd, "start_month", "開始月", errs),
    end_month: month(fd, "end_month", "終了月", errs),
    status: choice(fd, "status", ["active", "paused", "ended"] as const, "active"),
    description_template: text(fd, "description_template"),
    note: text(fd, "note"),
  };

  if (values.quantity <= 0) errs.add("quantity", "人数・個数は0より大きくしてください");
  if (values.total_count !== null && values.base_count > values.total_count) {
    errs.add("base_count", "請求済みの回数が全回数を超えています");
  }
  if (values.start_month && values.end_month && values.end_month < values.start_month) {
    errs.add("end_month", "終了月が開始月より前になっています");
  }
  if (errs.any) return errs.state();

  const supabase = await createClient();
  const id = text(fd, "id");

  if (!id) {
    const { error } = await supabase.from("contracts").insert(values);
    if (error) return { ok: false, message: dbErrorMessage(error) };
  } else {
    const version = Number(fd.get("version"));
    const { data, error } = await supabase
      .from("contracts")
      .update(values)
      .eq("id", id)
      .eq("version", version)
      .select("id");
    if (error) return { ok: false, message: dbErrorMessage(error) };
    if (!data || data.length === 0) return { ok: false, message: CONFLICT_MESSAGE };
  }

  revalidatePath(`/companies/${companyId}`);
  redirect(`/companies/${companyId}`);
}
