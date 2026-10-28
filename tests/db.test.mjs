// データベース設計のテスト（PGlite = ブラウザ・Node で動く本物の PostgreSQL）
// 実行: npm run test:db
//
// Supabase 固有の部分（auth スキーマ、auth.uid()、authenticated ロール）は小さな代役を用意する。
// 後半の「ペチちゃんの条件」は、レビューで出た6つの設計条件をそのまま確かめる。
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
const all = async (sql, params) => (await db.query(sql, params)).rows;
const as = (uid) => db.exec(`select set_config('app.uid', '${uid}', false)`);

const U1 = "00000000-0000-0000-0000-000000000001"; // 根元
const U2 = "00000000-0000-0000-0000-000000000002"; // 社長（見るだけ）
const U3 = "00000000-0000-0000-0000-000000000003"; // 南條さん

// ---- 便利な関数 ----
const fp = async (inv) => (await one(`select public.invoice_fingerprint($1) as f`, [inv])).f;
const sendOk = async (inv) => one(`select * from public.invoice_send_ok($1, $2)`, [inv, await fp(inv)]);
const invoice = (id) => one(`select * from public.invoices where id = $1`, [id]);
async function request(companyId, contractId, billingMonth, serviceMonth, lines, extra = {}) {
  const r = await one(
    `insert into public.billing_requests (company_id, contract_id, billing_month, service_month, count_no, needs_invoice)
     values ($1, $2, $3, $4, $5, $6) returning id`,
    [companyId, contractId, billingMonth, serviceMonth, extra.count ?? null, extra.needsInvoice ?? true]);
  for (const [i, l] of lines.entries()) {
    await db.query(
      `insert into public.billing_request_lines (request_id, sort, description, quantity, unit_price, amount, taxable, contract_amount)
       values ($1, $2, $3, $4, $5, $6, $7, $8)`,
      [r.id, i, l.d, l.q ?? 1, l.p, Math.round((l.q ?? 1) * l.p), l.t ?? true, l.c ?? null]);
  }
  return r.id;
}
const draft = async (companyId, month, ids) =>
  (await one(`select * from public.invoice_create_draft($1, $2, $3)`, [companyId, month, ids])).id;

console.log("データベース設計のテスト");

// =====================================================================
// 利用者・企業・契約
// =====================================================================

await test("最初の利用者は管理者、2人目からは承認待ちになる", async () => {
  await db.query(`insert into auth.users values ($1, 'hiromi@example.com'), ($2, 'shacho@example.com'), ($3, 'nanjo@example.com')`,
    [U1, U2, U3]);
  const r = await all(`select id, role from public.profiles`);
  assert.equal(r.find((x) => x.id === U1).role, "admin");
  assert.equal(r.find((x) => x.id === U2).role, "pending");
  assert.equal(r.find((x) => x.id === U3).role, "pending");
});

await test("承認待ちの人はデータを見る権限がない", async () => {
  await as(U2);
  const r = await one(`select public.is_member() as m, public.is_admin() as a`);
  assert.deepEqual([r.m, r.a], [false, false]);
});

await as(U1);
await db.query(`update public.profiles set role = 'admin' where id = $1`, [U3]);
await db.query(`update public.profiles set role = 'viewer' where id = $1`, [U2]);

let companyId, emailCompanyId, contractId, contract2Id;

await test("企業を登録すると作成者と版番号が入り、変更で版が上がる", async () => {
  const c = await one(`insert into public.companies (name, postal_code, address1) values ('株式会社テスト', '590-0000', '大阪府堺市1-1') returning *`);
  companyId = c.id;
  assert.equal(c.version, 1);
  assert.equal(c.created_by, U1);
  const u = await one(`update public.companies set phone = '06-0000-0000' where id = $1 returning *`, [companyId]);
  assert.equal(u.version, 2);
  assert.equal(u.updated_by, U1);
  emailCompanyId = (await one(`insert into public.companies (name, send_method, email) values ('メール株式会社', 'email', 'a@example.com') returning id`)).id;
});

await test("変更履歴に、変更前と変更後が残る", async () => {
  const r = await all(
    `select action, old_data->>'phone' as old_phone, new_data->>'phone' as new_phone, actor
       from public.audit_log where table_name = 'companies' and row_id = $1 order by id`, [companyId]);
  assert.deepEqual(r.map((x) => x.action), ["INSERT", "UPDATE"]);
  assert.equal(r[1].old_phone, null);
  assert.equal(r[1].new_phone, "06-0000-0000");
  assert.equal(r[1].actor, U1);
});

await test("同じ企業名は2回登録できない", async () => {
  await rejects(`insert into public.companies (name) values ('株式会社テスト')`, [], /unique|duplicate/i);
});

await test("1つの企業に複数の契約を持てる（一期生・二期生）", async () => {
  const a = await one(`insert into public.contracts (company_id, name, cohort, quantity, unit_price, total_count, base_count, legacy_last_service_month)
                       values ($1, '在留サポートサービス', '一期生', 2, 38000, 12, 3, '2026-10-01') returning id`, [companyId]);
  const b = await one(`insert into public.contracts (company_id, name, cohort, quantity, unit_price, start_month)
                       values ($1, '在留サポートサービス', '二期生', 2, 38000, '2026-12-01') returning id`, [companyId]);
  contractId = a.id;
  contract2Id = b.id;
  const n = await one(`select count(*)::int as n from public.contracts where company_id = $1`, [companyId]);
  assert.equal(n.n, 2);
});

await test("月の日付は1日しか入らない", async () => {
  await rejects(`insert into public.billing_requests (company_id, contract_id, billing_month)
                 values ($1, $2, '2026-10-31')`, [companyId, contractId], /check/i);
});

// =====================================================================
// 請求依頼
// =====================================================================

let reqNov;

await test("同じ契約・同じ「◯月分」の通常の依頼は1件だけ", async () => {
  reqNov = await request(companyId, contractId, "2026-11-01", "2026-12-01",
    [{ d: "一期生2名分：在留サポートサービス：12月分", q: 2, p: 38000, c: 76000 }], { count: 4 });
  await rejects(`insert into public.billing_requests (company_id, contract_id, billing_month, service_month)
                 values ($1, $2, '2026-11-01', '2026-12-01')`, [companyId, contractId], /unique|duplicate/i);
});

await test("追加・訂正の依頼は、元の依頼と理由があれば同じ月にも作れる", async () => {
  await rejects(`insert into public.billing_requests (company_id, contract_id, kind, billing_month, service_month)
                 values ($1, $2, 'additional', '2026-11-01', '2026-12-01')`, [companyId, contractId], /check/i);
  await rejects(`insert into public.billing_requests (company_id, contract_id, kind, origin_request_id, billing_month, service_month)
                 values ($1, $2, 'additional', $3, '2026-11-01', '2026-12-01')`, [companyId, contractId, reqNov], /check/i);
  const r = await one(`insert into public.billing_requests (company_id, contract_id, kind, origin_request_id, reason, billing_month, service_month)
                       values ($1, $2, 'additional', $3, '航空券の立替', '2026-11-01', '2026-12-01') returning id`,
                      [companyId, contractId, reqNov]);
  assert.ok(r.id);
  await db.query(`update public.billing_requests set status = 'cancelled' where id = $1`, [r.id]);
});

await test("取消した依頼は数に入らず、同じ月にもう一度作れる", async () => {
  const r = await one(`insert into public.billing_requests (company_id, contract_id, billing_month, service_month, status)
                       values ($1, $2, '2026-09-01', '2026-10-01', 'cancelled') returning id`, [companyId, contract2Id]);
  assert.ok(r.id);
  const r2 = await one(`insert into public.billing_requests (company_id, contract_id, billing_month, service_month)
                        values ($1, $2, '2026-09-01', '2026-10-01') returning id`, [companyId, contract2Id]);
  await db.query(`update public.billing_requests set status = 'cancelled' where id = $1`, [r2.id]);
  await rejects(`update public.billing_requests set status = 'active' where id = $1`, [r2.id], /取消した/);
});

await test("同じ契約で同じ回数は1回だけ。次の回数の候補は、取り込み時の回数とアプリの最大の大きいほう＋1", async () => {
  await rejects(`insert into public.billing_requests (company_id, contract_id, billing_month, service_month, count_no)
                 values ($1, $2, '2026-12-01', '2027-01-01', 4)`, [companyId, contractId], /unique|duplicate/i);
  const n = await one(`select public.next_count_no($1) as n, public.next_count_no($2) as m`, [contractId, contract2Id]);
  assert.deepEqual([n.n, n.m], [5, 1]);
});

await test("明細は 数量×単価 と一致し、0円は入らない（マイナス行は可）", async () => {
  await rejects(`insert into public.billing_request_lines (request_id, description, quantity, unit_price, amount)
                 values ($1, 'x', 2, 38000, 70000)`, [reqNov], /check/i);
  await rejects(`insert into public.billing_request_lines (request_id, description, quantity, unit_price, amount)
                 values ($1, 'x', 0, 38000, 0)`, [reqNov], /check/i);
});

// =====================================================================
// 請求書番号
// =====================================================================

await test("請求書番号の頭は「年度2桁＋月2桁」。年度は8月始まり", async () => {
  const r = await one(`select public.invoice_no_prefix('2026-11-01') a, public.invoice_no_prefix('2027-07-01') b,
                              public.invoice_no_prefix('2027-08-01') c, public.invoice_no_prefix('2026-08-01') d`);
  assert.deepEqual([r.a, r.b, r.c, r.d], ["2711", "2707", "2808", "2708"]);
});

await test("請求書番号は月ごとに 01 から重ならずに続く", async () => {
  const a = await one(`select public.next_invoice_no('2026-09-01') as n`);
  const b = await one(`select public.next_invoice_no('2026-09-01') as n`);
  const c = await one(`select public.next_invoice_no('2026-10-01') as n`);
  assert.deepEqual([a.n, b.n, c.n], ["2709-01", "2709-02", "2710-01"]);
});

await test("請求書番号は100枚目からも桁を落とさない（2710-10 と重ならない）", async () => {
  await db.query(`insert into public.invoice_counters (prefix, last_seq) values ('2705', 99)`);
  const a = await one(`select public.next_invoice_no('2027-05-01') as n`);
  const b = await one(`select public.next_invoice_no('2027-05-01') as n`);
  assert.deepEqual([a.n, b.n], ["2705-100", "2705-101"]);
});

await test("下書きの請求書に番号は付けられない（番号は送付OKで自動）", async () => {
  await rejects(`insert into public.invoices (company_id, billing_month, invoice_no) values ($1, '2026-11-01', '2711-99')`,
                [companyId], /送付OKのときに自動/);
});

// =====================================================================
// ペチちゃんの条件 1：入力途中は自由に保存・修正できる
// =====================================================================

let inv1, reqNov2;

await test("条件1：下書きのあいだは、明細・依頼・請求書を自由に直せる", async () => {
  reqNov2 = await request(companyId, null, "2026-11-01", null,
    [{ d: "航空券代（非課税）", p: 39537, t: false }]);
  inv1 = await draft(companyId, "2026-11-01", [reqNov, reqNov2]);
  await db.query(`update public.billing_request_lines set description = '一期生2名分：在留サポートサービス：12月分（4回目）' where request_id = $1`, [reqNov]);
  await db.query(`insert into public.billing_request_lines (request_id, sort, description, quantity, unit_price, amount)
                  values ($1, 9, '仮の行', 1, 100, 100)`, [reqNov]);
  await db.query(`delete from public.billing_request_lines where request_id = $1 and sort = 9`, [reqNov]);
  await db.query(`update public.billing_requests set note = 'メモ' where id = $1`, [reqNov]);
  await db.query(`update public.invoices set note = '下書きのメモ', issue_date = '2026-11-30' where id = $1`, [inv1]);
  // 請求書から外して、また載せる
  await db.query(`update public.billing_requests set invoice_id = null where id = $1`, [reqNov2]);
  await db.query(`update public.billing_requests set invoice_id = $2 where id = $1`, [reqNov2, inv1]);
  const i = await invoice(inv1);
  assert.equal(i.status, "draft");
  assert.equal(i.invoice_no, null);
  assert.equal(i.send_method, "post");
});

await test("条件1：別の企業・別の月の請求書には載せられない", async () => {
  const other = await draft(emailCompanyId, "2026-11-01", []);
  await rejects(`update public.billing_requests set invoice_id = $2 where id = $1`, [reqNov2, other], /別の企業/);
  const dec = await draft(companyId, "2026-12-01", []);
  await rejects(`update public.billing_requests set invoice_id = $2 where id = $1`, [reqNov2, dec], /請求月/);
  await db.query(`delete from public.invoices where id in ($1, $2)`, [other, dec]);  // 番号のない下書きは消せる
});

await test("条件1：載ったまま依頼の企業・請求月を変えたり、請求書の月だけ変えたりはできない", async () => {
  await rejects(`update public.billing_requests set company_id = $2 where id = $1`, [reqNov2, emailCompanyId], /別の企業/);
  await rejects(`update public.billing_requests set billing_month = '2026-12-01' where id = $1`, [reqNov2], /請求月/);
  await rejects(`update public.billing_requests set needs_invoice = false where id = $1`, [reqNov2], /check|載せられません/);
  await rejects(`update public.invoices set billing_month = '2026-12-01' where id = $1`, [inv1], /請求月は変えられません/);
});

// =====================================================================
// 条件 2：送付OK時点の内容を固定し、変更時は再確認が必要
// =====================================================================

await test("条件2：確認したあとに内容が変わっていたら、送付OKは止まる", async () => {
  const f = await fp(inv1);
  await db.query(`update public.billing_request_lines set unit_price = 38000, amount = 76000, quantity = 2 where request_id = $1`, [reqNov]);
  const f2 = await fp(inv1);
  assert.equal(f, f2, "同じ内容に書き直しただけなら指紋は同じ");
  await db.query(`update public.companies set address1 = '大阪府堺市2-2' where id = $1`, [companyId]);
  await rejects(`select public.invoice_send_ok($1, $2)`, [inv1, f], /もう一度確認/);
  await rejects(`select public.invoice_send_ok($1, null)`, [inv1], /もう一度確認/);
});

await test("条件2：確認したあとに税率・端数処理の設定が変わっても、送付OKは止まる", async () => {
  const f = await fp(inv1);
  await db.query(`update public.app_settings set value = '"floor"' where key = 'tax_rounding'`);
  await rejects(`select public.invoice_send_ok($1, $2)`, [inv1, f], /もう一度確認/);
  await db.query(`update public.app_settings set value = '"ceil"' where key = 'tax_rounding'`);
  assert.equal(await fp(inv1), f, "元に戻せば同じ指紋");
});

let no1;

await test("条件2：送付OKで番号・宛名・金額が固まる（税は切り上げ、立替金は税の外）", async () => {
  const i = await sendOk(inv1);
  no1 = i.invoice_no;
  assert.equal(i.status, "send_ok");
  assert.equal(no1, "2711-01");
  assert.equal(i.issue_date.toISOString().slice(0, 10), "2026-11-30");
  assert.equal(i.payment_due_date.toISOString().slice(0, 10), "2026-12-31");
  assert.equal(i.address1, "大阪府堺市2-2");
  assert.deepEqual([i.subtotal_taxable, i.subtotal_nontaxable, i.tax_amount, i.total], [76000, 39537, 7600, 123137]);
  const lines = await all(`select description, amount, taxable, sale_id from public.invoice_lines where invoice_id = $1 order by amount desc`, [inv1]);
  assert.equal(lines.length, 2);
  assert.ok(lines.every((l) => l.sale_id));
});

await test("条件2：送付OKのあとは、明細・依頼・請求書の中身を変えられない", async () => {
  await rejects(`update public.billing_request_lines set amount = 1, unit_price = 1, quantity = 1 where request_id = $1`, [reqNov], /送付OKのあと/);
  await rejects(`insert into public.billing_request_lines (request_id, description, unit_price, amount) values ($1, 'x', 1, 1)`, [reqNov], /送付OKのあと/);
  await rejects(`update public.billing_requests set note = '変更' where id = $1`, [reqNov], /送付OKのあと/);
  await rejects(`update public.billing_requests set invoice_id = null where id = $1`, [reqNov], /付け替え|送付OKのあと/);
  await rejects(`delete from public.billing_requests where id = $1`, [reqNov], /削除できません/);
  await rejects(`update public.invoices set total = 1 where id = $1`, [inv1], /変更できません/);
  await rejects(`update public.invoices set address1 = '別' where id = $1`, [inv1], /変更できません/);
  await rejects(`update public.invoice_lines set amount = 1 where invoice_id = $1`, [inv1], /変更できません/);
  await rejects(`delete from public.invoice_lines where invoice_id = $1`, [inv1], /変更できません/);
  await rejects(`delete from public.invoices where id = $1`, [inv1], /削除できません/);
  // PDFの記録だけはあとから入れられる
  await db.query(`update public.invoices set pdf_path = 'invoices/2711-01.pdf' where id = $1`, [inv1]);
});

await test("条件2：直すときは送付OKを取り消す（理由が必要）。番号はそのまま、売上は外れる", async () => {
  await rejects(`select public.invoice_reopen($1, '')`, [inv1], /理由/);
  const r = await one(`select * from public.invoice_reopen($1, '人数が1名に変わった')`, [inv1]);
  assert.equal(r.status, "draft");
  assert.equal(r.invoice_no, no1);
  assert.equal(r.total, null);
  const s = await one(`select count(*)::int as n from public.sales where invoice_id = $1 and status = 'active'`, [inv1]);
  assert.equal(s.n, 0);
  const l = await one(`select count(*)::int as n from public.invoice_lines where invoice_id = $1`, [inv1]);
  assert.equal(l.n, 0);
  // 直せるようになる
  await db.query(`update public.billing_request_lines set quantity = 1, unit_price = 38000, amount = 38000 where request_id = $1`, [reqNov]);
});

await test("条件2：直したあとは、もう一度確認しないと送付OKにできない。番号は同じまま", async () => {
  const stale = "0".repeat(32);
  await rejects(`select public.invoice_send_ok($1, $2)`, [inv1, stale], /もう一度確認/);
  const i = await sendOk(inv1);
  assert.equal(i.invoice_no, no1);
  assert.deepEqual([i.subtotal_taxable, i.tax_amount, i.total], [38000, 3800, 38000 + 3800 + 39537]);
  const n = await one(`select last_seq from public.invoice_counters where prefix = '2711'`);
  assert.equal(n.last_seq, 1, "番号を使い直したので、連番は進まない");
});

// =====================================================================
// 条件 3：送付OKを2回押しても、請求書・売上は二重にならない
// =====================================================================

await test("条件3：送付OKを2回押しても、売上・明細・番号は1回分", async () => {
  const before = await invoice(inv1);
  const again = await one(`select * from public.invoice_send_ok($1, 'どんな値でも')`, [inv1]);
  assert.equal(again.version, before.version, "2回目は何も変えない");
  const s = await one(`select count(*)::int as n from public.sales where invoice_id = $1 and status = 'active'`, [inv1]);
  const l = await one(`select count(*)::int as n from public.invoice_lines where invoice_id = $1`, [inv1]);
  assert.deepEqual([s.n, l.n], [2, 2]);
});

await test("条件3：同じ依頼の売上を直接もう1件入れることも、別の請求書に載せることもできない", async () => {
  await rejects(`insert into public.sales (company_id, billing_request_id, accounting_month, description, needs_invoice)
                 values ($1, $2, '2026-11-01', 'dup', false)`, [companyId, reqNov], /unique|duplicate/i);
  const other = await draft(companyId, "2026-11-01", []);
  await rejects(`update public.billing_requests set invoice_id = $2 where id = $1`, [reqNov, other], /付け替え|送付OKのあと/);
  await db.query(`delete from public.invoices where id = $1`, [other]);
});

await test("条件3：売上を作れるのは送付OKの処理だけ（送付OKの請求書に売上を足せない）", async () => {
  await rejects(`insert into public.sales (company_id, accounting_month, description, invoice_id)
                 values ($1, '2026-11-01', 'x', $2)`, [companyId, inv1], /送付OKのときに作られます/);
});

// =====================================================================
// 条件 4：請求書なしの売上は送付OKを必要としない
// =====================================================================

let noInvReq;

await test("条件4：請求書を作らない依頼は、送付OKなしで売上になる（2回押しても1件）", async () => {
  const koka = await one(`insert into public.companies (name) values ('甲賀市') returning id`);
  noInvReq = await request(koka.id, null, "2026-11-01", null, [{ d: "研修費（税込で受領）", p: 110000 }], { needsInvoice: false });
  const s1 = await one(`select * from public.request_record_sale($1)`, [noInvReq]);
  const s2 = await one(`select * from public.request_record_sale($1)`, [noInvReq]);
  assert.equal(s1.id, s2.id);
  assert.equal(s1.needs_invoice, false);
  assert.equal(s1.invoice_id, null);
  assert.equal(s1.amount_taxable, 110000);
});

await test("条件4：請求書を作らない依頼は請求書に載せられず、売上にしたあとは固まる", async () => {
  const koka = await one(`select id from public.companies where name = '甲賀市'`);
  const d = await draft(koka.id, "2026-11-01", []);
  await rejects(`update public.billing_requests set invoice_id = $2 where id = $1`, [noInvReq, d], /check|送付OKのあと|載せられません/);
  await rejects(`update public.billing_request_lines set description = 'x' where request_id = $1`, [noInvReq], /送付OKのあと/);
  await db.query(`delete from public.invoices where id = $1`, [d]);
});

await test("条件4：請求書を作る依頼は、request_record_sale では売上にできない", async () => {
  const r = await request(companyId, null, "2026-11-01", null, [{ d: "x", p: 1000 }]);
  await rejects(`select public.request_record_sale($1)`, [r], /送付OKで売上/);
  await db.query(`update public.billing_requests set status = 'cancelled' where id = $1`, [r]);
});

// =====================================================================
// 条件 5：郵送と、セレッジ担当のメール送付を分ける
// =====================================================================

let invMail;

await test("条件5：送り方は企業から引き継がれ、送付待ちの一覧で郵送とメールに分かれる", async () => {
  const r = await request(emailCompanyId, null, "2026-11-01", null, [{ d: "在留サポートサービス：11月分", p: 36000 }]);
  invMail = await draft(emailCompanyId, "2026-11-01", [r]);
  const i = await sendOk(invMail);
  assert.equal(i.send_method, "email");
  assert.equal(i.send_to_email, "a@example.com");
  assert.equal(i.invoice_no, "2711-02");
  const rows = await all(`select invoice_no, send_method from public.invoices_to_send order by invoice_no`);
  assert.deepEqual(rows, [{ invoice_no: "2711-01", send_method: "post" }, { invoice_no: "2711-02", send_method: "email" }]);
});

await test("条件5：送り方は下書きのうちなら請求書ごとに変えられ、送付OKのあとは変えられない", async () => {
  await rejects(`update public.invoices set send_method = 'post' where id = $1`, [invMail], /変更できません/);
});

// =====================================================================
// 条件 6：操作した人と日時を記録する
// =====================================================================

await test("条件6：送付OK・送付済み・取り消しの、誰がいつが残る", async () => {
  await as(U3);   // 南條さんが郵送分を送付済みにする
  const sent = await one(`select * from public.invoice_mark_sent($1, '2026-12-01')`, [inv1]);
  const again = await one(`select * from public.invoice_mark_sent($1, '2026-12-05')`, [inv1]);
  await as(U1);
  assert.equal(sent.status, "sent");
  assert.equal(sent.sent_by, U3);
  assert.ok(sent.sent_at);
  assert.equal(again.sent_on.toISOString().slice(0, 10), "2026-12-01", "2回押しても最初の記録のまま");
  assert.equal(sent.send_ok_by, U1);
  assert.ok(sent.send_ok_at);
  assert.equal(sent.reopened_by, U1);
  assert.equal(sent.reopen_reason, "人数が1名に変わった");
  const log = await all(`select new_data->>'status' as st, actor from public.audit_log
                          where table_name = 'invoices' and row_id = $1 and action = 'UPDATE' order by id`, [inv1]);
  assert.deepEqual(log.map((x) => x.st).filter((s, i, a) => s !== a[i - 1]),
                   ["draft", "send_ok", "draft", "send_ok", "sent"]);
  assert.ok(log.some((x) => x.actor === U3));
});

await test("条件6：送付済みのあとは送付OKの取り消しはできない（訂正版へ）", async () => {
  await rejects(`select public.invoice_reopen($1, 'x')`, [inv1], /訂正版/);
});

// =====================================================================
// 送付済みのあとの訂正（同じ番号の訂正版）
// =====================================================================

let inv1v2;

await test("訂正版：同じ番号の第2版を下書きで作り、依頼が移る。前の版は送付済みのまま", async () => {
  await rejects(`select public.invoice_start_correction($1, '')`, [inv1], /理由/);
  const c = await one(`select * from public.invoice_start_correction($1, '航空券代の金額違い')`, [inv1]);
  const c2 = await one(`select * from public.invoice_start_correction($1, '航空券代の金額違い')`, [inv1]);
  inv1v2 = c.id;
  assert.equal(c2.id, c.id, "2回押しても訂正版は1枚");
  assert.deepEqual([c.invoice_no, c.revision, c.status], [no1, 2, "draft"]);
  const moved = await one(`select count(*)::int as n from public.billing_requests where invoice_id = $1`, [inv1v2]);
  assert.equal(moved.n, 2);
  assert.equal((await invoice(inv1)).status, "sent");
  const s = await one(`select count(*)::int as n from public.sales where invoice_id = $1 and status = 'active'`, [inv1]);
  assert.equal(s.n, 2, "訂正版が送付OKになるまで、前の版の売上は生きている");
});

await test("訂正版：請求状況は「訂正中」と出る", async () => {
  const st = await one(`select state, invoice_no from public.contract_billing_status('2026-12-01', '2026-12-01')
                         where contract_id = $1`, [contractId]);
  assert.deepEqual([st.state, st.invoice_no], ["correcting", no1]);
});

await test("訂正版：作りかけの訂正版をやめると、明細も依頼も前の版に戻る", async () => {
  await db.query(`update public.billing_request_lines set unit_price = 1, amount = 1 where request_id = $1`, [reqNov2]);
  await rejects(`update public.billing_requests set invoice_id = null where id = $1`, [reqNov2], /訂正版から依頼は外せません/);
  const x = await one(`select * from public.invoice_cancel($1, 'やっぱり直さない')`, [inv1v2]);
  assert.equal(x.status, "cancelled");
  const r = await one(`select invoice_id from public.billing_requests where id = $1`, [reqNov2]);
  assert.equal(r.invoice_id, inv1);
  const l = await one(`select amount from public.billing_request_lines where request_id = $1`, [reqNov2]);
  assert.equal(l.amount, 39537);
});

await test("訂正版：入金の割り当ては、新しい版が送付OKになると新しい版へ移る", async () => {
  const rc = await one(`insert into public.receipts (company_id, received_on, amount) values ($1, '2026-12-25', 50000) returning id`, [companyId]);
  await db.query(`insert into public.receipt_allocations (receipt_id, invoice_id, amount) values ($1, $2, 50000)`, [rc.id, inv1]);
  const c = await one(`select * from public.invoice_start_correction($1, '航空券代の金額違い')`, [inv1]);
  inv1v2 = c.id;
  await db.query(`update public.billing_request_lines set unit_price = 40000, amount = 40000 where request_id = $1`, [reqNov2]);
  const v2 = await sendOk(inv1v2);
  // やめた訂正版が第2版として残っているので、これは第3版
  assert.deepEqual([v2.invoice_no, v2.revision, v2.status, v2.total], [no1, 3, "send_ok", 38000 + 3800 + 40000]);
  assert.equal((await invoice(inv1)).status, "superseded");
  const oldSales = await one(`select count(*)::int as n from public.sales where invoice_id = $1 and status = 'active'`, [inv1]);
  const newSales = await one(`select count(*)::int as n from public.sales where invoice_id = $1 and status = 'active'`, [inv1v2]);
  assert.deepEqual([oldSales.n, newSales.n], [0, 2]);
  const a = await one(`select invoice_id from public.receipt_allocations where receipt_id = $1`, [rc.id]);
  assert.equal(a.invoice_id, inv1v2);
  const bal = await one(`select remaining from public.invoice_balances where invoice_id = $1`, [inv1v2]);
  assert.equal(bal.remaining, 38000 + 3800 + 40000 - 50000);
  const gone = await one(`select count(*)::int as n from public.invoice_balances where invoice_id = $1`, [inv1]);
  assert.equal(gone.n, 0, "旧版は残高一覧から外れる");
});

await test("訂正版：前の版の明細は、送ったときの内容のまま残る", async () => {
  const l = await one(`select amount from public.invoice_lines where invoice_id = $1 and taxable = false`, [inv1]);
  assert.equal(l.amount, 39537);
});

await test("訂正版：入金が割り当てられた請求書は、取り消しも取消もできない", async () => {
  await rejects(`select public.invoice_reopen($1, 'x')`, [inv1v2], /入金が割り当て/);
  await rejects(`select public.invoice_cancel($1, 'x')`, [inv1v2], /入金が割り当て/);
});

// =====================================================================
// 取消
// =====================================================================

await test("取消：理由が必要。売上が取消され、依頼は請求書から外れて作り直せる（番号は新しく付く）", async () => {
  await rejects(`select public.invoice_cancel($1, '')`, [invMail], /理由/);
  const x = await one(`select * from public.invoice_cancel($1, '宛先違い')`, [invMail]);
  assert.equal(x.status, "cancelled");
  assert.equal(x.cancelled_by, U1);
  const s = await one(`select count(*)::int as n from public.sales where invoice_id = $1 and status = 'active'`, [invMail]);
  assert.equal(s.n, 0);
  const r = await one(`select id from public.billing_requests where company_id = $1 and status = 'active'`, [emailCompanyId]);
  const d = await draft(emailCompanyId, "2026-11-01", [r.id]);
  const i = await sendOk(d);
  assert.equal(i.invoice_no, "2711-03");
  await rejects(`update public.invoices set status = 'send_ok' where id = $1`, [invMail], /にはできません/);
});

await test("取消：請求書は削除できない。旧版は取消せない", async () => {
  await rejects(`delete from public.invoices where id = $1`, [invMail], /削除できません/);
  await rejects(`select public.invoice_cancel($1, 'x')`, [inv1], /旧版/);
});

await test("訂正版も、送付OKを取り消して直せる。訂正版ごと取消すと依頼は請求書から外れる", async () => {
  const baba = (await one(`insert into public.companies (name) values ('株式会社ババ') returning id`)).id;
  const r = await request(baba, null, "2026-11-01", null, [{ d: "2名分：在留サポートサービス：12月分", q: 2, p: 38000 }]);
  const v1 = await draft(baba, "2026-11-01", [r]);
  await sendOk(v1);
  await one(`select * from public.invoice_mark_sent($1)`, [v1]);
  const v2 = (await one(`select * from public.invoice_start_correction($1, '人数違い')`, [v1])).id;
  await db.query(`update public.billing_request_lines set quantity = 3, amount = 114000 where request_id = $1`, [r]);
  await sendOk(v2);
  const back = await one(`select * from public.invoice_reopen($1, 'もう一度直す')`, [v2]);
  assert.equal(back.status, "draft");
  assert.equal((await invoice(v1)).status, "superseded");
  await db.query(`update public.billing_request_lines set quantity = 4, amount = 152000 where request_id = $1`, [r]);
  const again = await sendOk(v2);
  assert.equal(again.total, 152000 + 15200);
  const x = await one(`select * from public.invoice_cancel($1, '請求自体をやめる')`, [v2]);
  assert.equal(x.status, "cancelled");
  const req = await one(`select invoice_id from public.billing_requests where id = $1`, [r]);
  assert.equal(req.invoice_id, null);
  const s = await one(`select count(*)::int as n from public.sales where billing_request_id = $1 and status = 'active'`, [r]);
  assert.equal(s.n, 0);
});

await test("状態は決まった順にしか動かない（下書きから送付済みへ飛べない）", async () => {
  const r = await request(companyId, contract2Id, "2026-12-01", "2026-12-01", [{ d: "x", p: 1000 }]);
  const d = await draft(companyId, "2026-12-01", [r]);
  await rejects(`select public.invoice_mark_sent($1)`, [d], /送付OKになっていない/);
  await rejects(`update public.invoices set status = 'sent', sent_on = current_date where id = $1`, [d], /にはできません/);
  await rejects(`update public.invoices set status = 'send_ok' where id = $1`, [d], /check/i);
});

// =====================================================================
// 請求状況（対象月ごと）
// =====================================================================

await test("請求状況：Excelで請求済み／請求済み（番号つき）／下書き／未請求／対象外を自動で判定する", async () => {
  const rows = await all(`select service_month, state, invoice_no from public.contract_billing_status('2026-09-01', '2027-01-01')
                           where contract_id = $1 order by service_month`, [contractId]);
  const map = Object.fromEntries(rows.map((r) => [r.service_month.toISOString().slice(0, 7), [r.state, r.invoice_no]]));
  assert.deepEqual(map["2026-09"], ["legacy", null]);
  assert.deepEqual(map["2026-10"], ["legacy", null]);
  assert.deepEqual(map["2026-11"], ["unbilled", null]);
  assert.deepEqual(map["2026-12"], ["invoiced", no1]);
  assert.deepEqual(map["2027-01"], ["unbilled", null]);
  const two = await all(`select service_month, state from public.contract_billing_status('2026-11-01', '2026-12-01')
                          where contract_id = $1 order by service_month`, [contract2Id]);
  assert.deepEqual(two.map((r) => r.state), ["out_of_scope", "draft"]);
});

// =====================================================================
// 入金・支払い・固定費・設定
// =====================================================================

await test("入金は下書き・取消の請求書には割り当てられない。1回の振込より多くは割り当てられない", async () => {
  const d = await draft(companyId, "2027-01-01", []);
  const rc = await one(`insert into public.receipts (company_id, received_on, amount) values ($1, '2027-01-31', 100000) returning id`, [companyId]);
  await rejects(`insert into public.receipt_allocations (receipt_id, invoice_id, amount) values ($1, $2, 1)`, [rc.id, d], /送付OK・送付済み/);
  await rejects(`insert into public.receipt_allocations (receipt_id, invoice_id, amount) values ($1, $2, 1)`, [rc.id, invMail], /送付OK・送付済み/);
  await db.query(`insert into public.receipt_allocations (receipt_id, invoice_id, amount) values ($1, $2, 31800)`, [rc.id, inv1v2]);
  await rejects(`insert into public.receipt_allocations (receipt_id, invoice_id, amount) values ($1, $2, 70000)`, [rc.id, inv1v2], /超えています/);
});

await test("★の定例支払いは同じ月に2回作れない", async () => {
  const v = await one(`insert into public.vendors (name) values ('Liberte合同会社') returning id`);
  const rp = await one(`insert into public.recurring_payments (vendor_id, description, default_amount) values ($1, 'レンタルサーバー', 6072) returning id`, [v.id]);
  const ins = `insert into public.payables (vendor_id, description, amount, payment_month, recurring_id)
               values ($1, 'レンタルサーバー10月分', 6072, '2026-11-01', $2)`;
  await db.query(ins, [v.id, rp.id]);
  await rejects(ins, [v.id, rp.id], /unique|duplicate/i);
});

await test("支払い：総務を通すものは依頼日時と支払日が必要。通さないもの（カード等）は支払日だけでよい", async () => {
  const v = await one(`select id from public.vendors limit 1`);
  await rejects(`insert into public.payables (vendor_id, description, amount, payment_month, status, paid_on)
                 values ($1, 'x', 1, '2026-11-01', 'paid', '2026-11-30')`, [v.id], /check/i);
  await one(`insert into public.payables (vendor_id, description, amount, payment_month, status, requested_at, requested_by, paid_on)
             values ($1, 'x', 1, '2026-11-01', 'paid', now(), $2, '2026-11-30') returning id`, [v.id, U1]);
  await one(`insert into public.payables (vendor_id, description, amount, payment_month, via_soumu, status, paid_on)
             values ($1, 'カード払い', 1, '2026-11-01', false, 'paid', '2026-11-10') returning id`, [v.id]);
  await rejects(`insert into public.payables (vendor_id, description, amount, payment_month, via_soumu, status, requested_at)
                 values ($1, 'x', 1, '2026-11-01', false, 'requested', now())`, [v.id], /check/i);
});

await test("固定費は同じ月・同じ項目を2回入れられない（その他は可）", async () => {
  await db.query(`insert into public.monthly_costs (month, category, amount) values ('2026-10-01', '人件費', 1096000)`);
  await rejects(`insert into public.monthly_costs (month, category, amount) values ('2026-10-01', '人件費', 1)`,
                [], /unique|duplicate/i);
  await db.query(`insert into public.monthly_costs (month, category, amount) values ('2026-10-01', 'その他', 1), ('2026-10-01', 'その他', 2)`);
});

await test("消費税：切り上げ・切り捨て・四捨五入", async () => {
  const r = await one(`select public.calc_tax(40416, 0.10, 'ceil') as c, public.calc_tax(40416, 0.10, 'floor') as f,
                              public.calc_tax(40415, 0.10, 'round') as r, public.calc_tax(36000, 0.10, 'ceil') as e`);
  assert.deepEqual([r.c, r.f, r.r, r.e], [4042, 4041, 4042, 3600]);
});

await test("設定の変更も履歴に残る。暦年に切り替えると番号の頭も変わる", async () => {
  const before = (await one(`select count(*)::int as n from public.audit_log where table_name = 'app_settings'`)).n;
  await db.query(`update public.app_settings set value = '"calendar"' where key = 'invoice_no_year'`);
  const r = await one(`select public.invoice_no_prefix('2026-11-01') as p`);
  assert.equal(r.p, "2611");
  await db.query(`update public.app_settings set value = '"fiscal_end"' where key = 'invoice_no_year'`);
  const n = await one(`select count(*)::int as n from public.audit_log where table_name = 'app_settings'`);
  assert.equal(n.n - before, 2);
});

await test("すべての業務テーブルでアクセス制御（RLS）が有効", async () => {
  const r = await all(`select relname from pg_class c join pg_namespace n on n.oid = c.relnamespace
                        where n.nspname = 'public' and c.relkind = 'r' and not c.relrowsecurity`);
  assert.deepEqual(r.map((x) => x.relname), []);
});

console.log(`\n${passed} 件成功${process.exitCode ? "（失敗あり）" : ""}`);
