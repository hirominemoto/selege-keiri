// データベース設計のテスト（PGlite = ブラウザ・Node で動く本物の PostgreSQL）
// 実行: npm run test:db
//
// Supabase 固有の部分（auth スキーマ、auth.uid()、authenticated ロール）は小さな代役を用意する。
import { PGlite } from "@electric-sql/pglite";
import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import assert from "node:assert/strict";

const db = new PGlite();

await db.exec(`
  create schema auth;
  create table auth.users (id uuid primary key, email text);
  create function auth.uid() returns uuid language sql stable as
    $$ select nullif(current_setting('app.uid', true), '')::uuid $$;
  do $$ begin
    if not exists (select 1 from pg_roles where rolname = 'authenticated') then
      create role authenticated;
    end if;
  end $$;
`);

const dir = new URL("../supabase/migrations/", import.meta.url).pathname;
for (const f of readdirSync(dir).filter((f) => f.endsWith(".sql")).sort()) {
  await db.exec(readFileSync(join(dir, f), "utf8"));
}

let passed = 0;
async function test(name, fn) {
  try {
    await fn();
    passed++;
    console.log(`  ok  ${name}`);
  } catch (e) {
    console.error(`  NG  ${name}\n      ${e.message}`);
    process.exitCode = 1;
  }
}
async function rejects(sql, params, pattern) {
  await assert.rejects(() => db.query(sql, params), pattern);
}
const one = async (sql, params) => (await db.query(sql, params)).rows[0];
const as = (uid) => db.exec(`select set_config('app.uid', '${uid}', false)`);

const U1 = "00000000-0000-0000-0000-000000000001";
const U2 = "00000000-0000-0000-0000-000000000002";

console.log("データベース設計のテスト");

await test("最初の利用者は管理者、2人目は承認待ちになる", async () => {
  await db.query(`insert into auth.users values ($1, 'hiromi@example.com'), ($2, 'shacho@example.com')`, [U1, U2]);
  const r = await db.query(`select id, role from public.profiles order by email`);
  assert.equal(r.rows.find((x) => x.id === U1).role, "admin");
  assert.equal(r.rows.find((x) => x.id === U2).role, "pending");
});

await test("承認待ちの人はデータを見る権限がない", async () => {
  await as(U2);
  const r = await one(`select public.is_member() as m, public.is_admin() as a`);
  assert.deepEqual([r.m, r.a], [false, false]);
});

await as(U1);

let companyId, contractId;

await test("企業を登録すると作成者と版番号が入り、変更で版が上がる", async () => {
  const c = await one(`insert into public.companies (name) values ('株式会社テスト') returning *`);
  companyId = c.id;
  assert.equal(c.version, 1);
  assert.equal(c.created_by, U1);
  const u = await one(`update public.companies set phone = '06-0000-0000' where id = $1 returning *`, [companyId]);
  assert.equal(u.version, 2);
  assert.equal(u.updated_by, U1);
});

await test("変更履歴に、変更前と変更後が残る", async () => {
  const r = await db.query(
    `select action, old_data->>'phone' as old_phone, new_data->>'phone' as new_phone, actor
       from public.audit_log where table_name = 'companies' and row_id = $1 order by id`, [companyId]);
  assert.deepEqual(r.rows.map((x) => x.action), ["INSERT", "UPDATE"]);
  assert.equal(r.rows[1].old_phone, null);
  assert.equal(r.rows[1].new_phone, "06-0000-0000");
  assert.equal(r.rows[1].actor, U1);
});

await test("同じ企業名は2回登録できない", async () => {
  await rejects(`insert into public.companies (name) values ('株式会社テスト')`, [], /unique|duplicate/i);
});

await test("1つの企業に複数の契約を持てる（一期生・二期生）", async () => {
  const a = await one(`insert into public.contracts (company_id, name, cohort, quantity, unit_price, total_count)
                       values ($1, '在留サポートサービス', '一期生', 2, 38000, 12) returning id`, [companyId]);
  await one(`insert into public.contracts (company_id, name, cohort, quantity, unit_price)
             values ($1, '在留サポートサービス', '二期生', 2, 38000) returning id`, [companyId]);
  contractId = a.id;
  const n = await one(`select count(*)::int as n from public.contracts where company_id = $1`, [companyId]);
  assert.equal(n.n, 2);
});

await test("月の日付は1日しか入らない", async () => {
  await rejects(`insert into public.billing_requests (company_id, contract_id, billing_month)
                 values ($1, $2, '2026-10-31')`, [companyId, contractId], /check/i);
});

let requestId;

await test("同じ契約・同じ「◯月分」の請求依頼は1件だけ", async () => {
  const r = await one(`insert into public.billing_requests (company_id, contract_id, billing_month, service_month)
                       values ($1, $2, '2026-10-01', '2026-11-01') returning id`, [companyId, contractId]);
  requestId = r.id;
  await rejects(`insert into public.billing_requests (company_id, contract_id, billing_month, service_month)
                 values ($1, $2, '2026-10-01', '2026-11-01')`, [companyId, contractId], /unique|duplicate/i);
});

await test("取消した依頼は数に入らず、同じ月にもう一度作れる", async () => {
  const r = await one(`insert into public.billing_requests (company_id, contract_id, billing_month, service_month, status)
                       values ($1, $2, '2026-09-01', '2026-10-01', 'cancelled') returning id`, [companyId, contractId]);
  assert.ok(r.id);
  const r2 = await one(`insert into public.billing_requests (company_id, contract_id, billing_month, service_month)
                        values ($1, $2, '2026-09-01', '2026-10-01') returning id`, [companyId, contractId]);
  assert.ok(r2.id);
});

await test("明細の金額は 数量×単価 と一致しないと入らない（マイナス行は可）", async () => {
  await rejects(`insert into public.billing_request_lines (request_id, description, quantity, unit_price, amount)
                 values ($1, 'x', 2, 38000, 70000)`, [requestId], /check/i);
  await db.query(`insert into public.billing_request_lines (request_id, description, quantity, unit_price, amount)
                  values ($1, '2名分：在留サポートサービス：11月分', 2, 38000, 76000),
                         ($1, '相殺', 1, -10000, -10000)`, [requestId]);
});

await test("確定した依頼の明細は変更できない", async () => {
  await db.query(`update public.billing_requests set status = 'confirmed', confirmed_at = now(), confirmed_by = $2
                  where id = $1`, [requestId, U1]);
  await rejects(`update public.billing_request_lines set description = '変更' where request_id = $1`,
                [requestId], /確定済み/);
  await rejects(`insert into public.billing_request_lines (request_id, description, quantity, unit_price, amount)
                 values ($1, '追加', 1, 1000, 1000)`, [requestId], /確定済み/);
});

await test("確定には確定日時が必要", async () => {
  await rejects(`insert into public.billing_requests (company_id, billing_month, status)
                 values ($1, '2026-10-01', 'confirmed')`, [companyId], /check/i);
});

await test("1つの依頼から作れる売上は1件だけ", async () => {
  const s = await one(`insert into public.sales (company_id, billing_request_id, accounting_month, description, amount_taxable)
                       values ($1, $2, '2026-10-01', '在留サポート', 66000) returning id`, [companyId, requestId]);
  assert.ok(s.id);
  await rejects(`insert into public.sales (company_id, billing_request_id, accounting_month, description)
                 values ($1, $2, '2026-10-01', 'dup')`, [companyId, requestId], /unique|duplicate/i);
});

await test("請求書を作らない売上に請求書は結びつけられない", async () => {
  await rejects(`insert into public.sales (company_id, accounting_month, description, needs_invoice, invoice_id)
                 values ($1, '2026-10-01', 'x', false, gen_random_uuid())`, [companyId], /check|foreign/i);
});

await test("消費税：切り上げ・切り捨て・四捨五入", async () => {
  const r = await one(`select public.calc_tax(40416, 0.10, 'ceil') as c, public.calc_tax(40416, 0.10, 'floor') as f,
                              public.calc_tax(40415, 0.10, 'round') as r, public.calc_tax(36000, 0.10, 'ceil') as e`);
  assert.deepEqual([r.c, r.f, r.r, r.e], [4042, 4041, 4042, 3600]);
});

await test("請求書番号は頭が未設定だと採番できない", async () => {
  await rejects(`select public.next_invoice_no(null)`, [], /設定されていません/);
});

await test("請求書番号は重ならずに続く", async () => {
  const a = await one(`select public.next_invoice_no('26') as n`);
  const b = await one(`select public.next_invoice_no('26') as n`);
  assert.deepEqual([a.n, b.n], ["26-1", "26-2"]);
});

let invoiceId;
const invoiceSql = `insert into public.invoices
  (company_id, invoice_no, is_legacy, issue_date, bill_to_name, subtotal_taxable, subtotal_nontaxable, tax_rate, tax_amount, total)
  values ($1, $2, $3, '2026-10-31', '株式会社テスト', 66000, 39537, 0.10, 6600, 112137) returning id`;

await test("合計が合わない請求書は入らない", async () => {
  await rejects(invoiceSql.replace("112137", "999"), [companyId, "26-1", false], /check/i);
});

await test("アプリの番号は重複不可、旧Excelの番号は重複を許す", async () => {
  invoiceId = (await one(invoiceSql, [companyId, "26-1", false])).id;
  await rejects(invoiceSql, [companyId, "26-1", false], /unique|duplicate/i);
  await one(invoiceSql, [companyId, "26-8", true]);
  await one(invoiceSql, [companyId, "26-8", true]);
});

await test("発行済みの請求書は金額も宛名も変えられない", async () => {
  await rejects(`update public.invoices set total = 1 where id = $1`, [invoiceId], /変更できません/);
  await rejects(`update public.invoices set bill_to_name = '別名' where id = $1`, [invoiceId], /変更できません/);
});

await test("送付日とPDFの記録はあとから入れられる", async () => {
  const r = await one(`update public.invoices set sent_on = '2026-11-01', pdf_path = 'x.pdf' where id = $1 returning version`, [invoiceId]);
  assert.equal(r.version, 2);
});

await test("請求書は削除できず、取消には理由が必要", async () => {
  await rejects(`delete from public.invoices where id = $1`, [invoiceId], /削除できません/);
  await rejects(`update public.invoices set status = 'cancelled' where id = $1`, [invoiceId], /check/i);
  await db.query(`update public.invoices set status = 'cancelled', cancelled_at = now(), cancel_reason = '金額誤り'
                  where id = $1`, [invoiceId]);
  await rejects(`update public.invoices set status = 'issued' where id = $1`, [invoiceId], /元に戻せません/);
});

await test("請求書の明細は書き換えられない", async () => {
  const l = await one(`insert into public.invoice_lines (invoice_id, description, quantity, unit_price, amount, taxable)
                       values ($1, 'x', 1, 100, 100, true) returning id`, [invoiceId]);
  await rejects(`update public.invoice_lines set amount = 1 where id = $1`, [l.id], /変更できません/);
  await rejects(`delete from public.invoice_lines where id = $1`, [l.id], /変更できません/);
});

await test("1回の振込を複数の請求書に割り当てられ、入金額は超えられない", async () => {
  const i1 = (await one(invoiceSql, [companyId, "26-2", false])).id;
  const i2 = (await one(invoiceSql, [companyId, "26-3", false])).id;
  const rc = await one(`insert into public.receipts (company_id, received_on, amount) values ($1, '2026-11-30', 200000) returning id`, [companyId]);
  await db.query(`insert into public.receipt_allocations (receipt_id, invoice_id, amount) values ($1, $2, 112137), ($1, $3, 87863)`,
                 [rc.id, i1, i2]);
  const bal = await one(`select remaining from public.invoice_balances where invoice_id = $1`, [i2]);
  assert.equal(bal.remaining, 112137 - 87863);
  await rejects(`insert into public.receipt_allocations (receipt_id, invoice_id, amount) values ($1, $2, 1)`,
                [rc.id, i2], /超えています/);
});

await test("取消した請求書は残高一覧から外れる", async () => {
  const r = await one(`select count(*)::int as n from public.invoice_balances where invoice_id = $1`, [invoiceId]);
  assert.equal(r.n, 0);
});

await test("★の定例支払いは同じ月に2回作れない", async () => {
  const v = await one(`insert into public.vendors (name) values ('Liberte合同会社') returning id`);
  const rp = await one(`insert into public.recurring_payments (vendor_id, description, default_amount) values ($1, 'レンタルサーバー', 6072) returning id`, [v.id]);
  const ins = `insert into public.payables (vendor_id, description, amount, payment_month, recurring_id)
               values ($1, 'レンタルサーバー10月分', 6072, '2026-11-01', $2)`;
  await db.query(ins, [v.id, rp.id]);
  await rejects(ins, [v.id, rp.id], /unique|duplicate/i);
});

await test("支払済みには支払日と総務依頼日時が必要", async () => {
  const v = await one(`select id from public.vendors limit 1`);
  await rejects(`insert into public.payables (vendor_id, description, amount, payment_month, status)
                 values ($1, 'x', 1, '2026-11-01', 'paid')`, [v.id], /check/i);
  await one(`insert into public.payables (vendor_id, description, amount, payment_month, status, requested_at, requested_by, paid_on)
             values ($1, 'x', 1, '2026-11-01', 'paid', now(), $2, '2026-11-30') returning id`, [v.id, U1]);
});

await test("固定費は同じ月・同じ項目を2回入れられない（その他は可）", async () => {
  await db.query(`insert into public.monthly_costs (month, category, amount) values ('2026-10-01', '人件費', 1096000)`);
  await rejects(`insert into public.monthly_costs (month, category, amount) values ('2026-10-01', '人件費', 1)`,
                [], /unique|duplicate/i);
  await db.query(`insert into public.monthly_costs (month, category, amount) values ('2026-10-01', 'その他', 1), ('2026-10-01', 'その他', 2)`);
});

await test("設定の変更も履歴に残る", async () => {
  await db.query(`update public.app_settings set value = '"26"' where key = 'invoice_prefix'`);
  const r = await one(`select count(*)::int as n from public.audit_log where table_name = 'app_settings'`);
  assert.equal(r.n, 1);
});

await test("すべての業務テーブルでアクセス制御（RLS）が有効", async () => {
  const r = await db.query(`select relname from pg_class c join pg_namespace n on n.oid = c.relnamespace
                            where n.nspname = 'public' and c.relkind = 'r' and not c.relrowsecurity`);
  assert.deepEqual(r.rows.map((x) => x.relname), []);
});

console.log(`\n${passed} 件成功${process.exitCode ? "（失敗あり）" : ""}`);
