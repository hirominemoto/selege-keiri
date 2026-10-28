"""
確認済みの「取り込み確認_企業と契約.xlsx」から、Supabase に流し込む SQL を作る。

使い方:
  python3 tools/build_seed.py <確認済み.xlsx> <出力.sql>

出力した SQL は、Supabase の SQL Editor に貼って Run する（0001_init.sql の実行後）。
取引先の実データなので、出力はリポジトリに入れない（data/private/ に置く）。

・企業：「企業」シートのすべての行。取引の状態が「取引終了」なら取引終了として入れる
・旧Excelの表記ゆれ：正式名と違う表記を company_aliases に入れる
・契約：「契約」シートで「取り込む」が「はい」の行。全回数に達しているものは「終了」で入れる
・同じ名前の企業・同じ企業の同じ契約（契約名と期）がすでにあれば入れない（何度実行しても重複しない）
"""

import datetime as dt
import re
import sys
import unicodedata

import openpyxl


def q(v):
    """SQL の文字列リテラル。空なら null"""
    if v is None:
        return "null"
    s = str(v).strip()
    if s == "":
        return "null"
    return "'" + s.replace("'", "''") + "'"


def num(v):
    if v is None or str(v).strip() == "":
        return "null"
    return str(int(round(float(unicodedata.normalize("NFKC", str(v)).replace(",", "")))))


def date_text(v):
    if isinstance(v, (dt.datetime, dt.date)):
        return f"{v:%Y/%m/%d}"
    return str(v or "")


def to_fullwidth_punct(s):
    """取り出すときに半角にした記号を、請求書らしい全角に戻す"""
    return s.replace("(", "（").replace(")", "）").replace(":", "：")


def make_template(desc, has_month):
    """最後の品名から、品名のひな形を作る"""
    t = unicodedata.normalize("NFKC", desc)
    t = re.sub(r"(\d+)回目\s*/\s*全\s*(\d+)\s*回", "{回数}回目/全{全回数}回", t)
    t = re.sub(r"(\d+)\s*(?:か月|ヶ月|ケ月)目", "{回数}か月目", t)
    if has_month:
        t = re.sub(r"(\d{1,2})月分", "{対象月}分", t)
    t = re.sub(r"(\d+)\s*名", "{人数}名", t, count=1)
    return to_fullwidth_punct(t.strip())


def main(src, out_path):
    wb = openpyxl.load_workbook(src, data_only=True)
    lines = [
        "-- セレッジ管理システム：旧Excelからの取り込み（企業・表記ゆれ・契約）",
        "-- 0001_init.sql を実行したあとに、SQL Editor で実行する",
        "begin;",
        "",
    ]

    # ---- 企業 ----
    ws = wb["企業"]
    head = [c.value for c in ws[1]]
    idx = {h: i for i, h in enumerate(head)}
    n_company = n_alias = 0
    for row in ws.iter_rows(min_row=2, values_only=True):
        name = row[idx["正式名"]]
        if not name:
            continue
        name = str(name).strip()
        active = (row[idx["取引の状態"]] or "取引中") != "取引終了"
        lines.append(
            "insert into public.companies (name, postal_code, address1, contact_name, is_active) values "
            f"({q(name)}, {q(row[idx['郵便番号']])}, {q(row[idx['住所']])}, {q(row[idx['部署・担当者']])}, "
            f"{'true' if active else 'false'}) on conflict (name) do nothing;"
        )
        n_company += 1
        variants = [v.strip() for v in str(row[idx["Excelでの表記"]] or "").split("、") if v.strip()]
        for v in dict.fromkeys(variants):
            if v != name:
                lines.append(
                    "insert into public.company_aliases (company_id, alias) "
                    f"select id, {q(v)} from public.companies where name = {q(name)} on conflict (alias) do nothing;"
                )
                n_alias += 1
    lines.append("")

    # ---- 契約 ----
    ws = wb["契約"]
    head = [c.value for c in ws[1]]
    idx = {h: i for i, h in enumerate(head)}
    n_contract = 0
    for row in ws.iter_rows(min_row=2, values_only=True):
        if not row[idx["企業"]] or (row[idx["取り込む"]] or "はい") != "はい":
            continue
        company = str(row[idx["企業"]]).strip()
        relation = row[idx["◯月分の関係"]] or ""
        offset = 1 if "翌月" in relation else 0
        has_month = "なし" not in relation
        last = row[idx["最後の回数"]]
        total = row[idx["全回数"]]
        desc = str(row[idx["最後の品名（元の表記）"]] or "")
        count_unit = "か月" if re.search(r"(か月|ヶ月|ケ月)目", desc) else "回"
        finished = last is not None and total is not None and int(last) >= int(total)
        cohort = row[idx["期"]]
        lines.append(
            "insert into public.contracts (company_id, name, cohort, kind, quantity, unit_price, taxable, "
            "service_month_offset, total_count, count_unit, base_count, status, description_template, note) "
            f"select co.id, {q(row[idx['契約名']])}, {q(cohort)}, 'monthly', {num(row[idx['人数']]) if row[idx['人数']] else 1}, "
            f"{num(row[idx['単価（税抜）']])}, true, {offset}, {num(total)}, {q(count_unit)}, {num(last) if last else 0}, "
            f"{q('ended' if finished else 'active')}, {q(make_template(desc, has_month))}, "
            f"{q('旧Excelから取り込み。最後の請求：' + date_text(row[idx['最後の請求日']]))} "
            f"from public.companies co where co.name = {q(company)} "
            "and not exists (select 1 from public.contracts c where c.company_id = co.id "
            f"and c.name = {q(row[idx['契約名']])} and coalesce(c.cohort, '') = coalesce({q(cohort)}, ''));"
        )
        n_contract += 1

    lines += ["", "commit;", ""]
    with open(out_path, "w", encoding="utf-8") as f:
        f.write("\n".join(lines))
    print(f"企業 {n_company} 件、表記ゆれ {n_alias} 件、契約 {n_contract} 件の SQL を書き出しました → {out_path}")


if __name__ == "__main__":
    if len(sys.argv) != 3:
        print(__doc__)
        sys.exit(1)
    main(sys.argv[1], sys.argv[2])
