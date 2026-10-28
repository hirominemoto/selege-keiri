"""
旧Excelから、アプリに取り込む「企業」と「継続中の契約」の候補を取り出す。

使い方:
  python3 tools/extract_import.py <社内申込書.xlsm> <売上表.xlsm> <出力.xlsx>

  社内申込書（企業ごとの請求シートと住所一覧）を正とする。
  売上表は、旧Excelでの表記ゆれ（「興和工業株式会社1」など）を拾うためだけに使う。

出力は確認用のExcel（取引先の実データなのでリポジトリには入れない）。
ひろみが確認・修正してから、取り込みに使う。
"""

import datetime as dt
import re
import sys
import unicodedata
from collections import OrderedDict

import openpyxl
from openpyxl.styles import Alignment, Font, PatternFill
from openpyxl.utils import get_column_letter
from openpyxl.worksheet.datavalidation import DataValidation

NOT_COMPANY_SHEETS = {"目次", "申込書", "Sheet1", "データ"}
SALES_MONTH_SHEETS = ["11月", "12月", "1月", "2月", "3月", "4月", "5月", "6月", "7月", "8月", "9月"]

# 正式な表記（ひろみ確認済み）
FORMAL_NAMES = {
    "正木精密板金": "有限会社正木精密板金工作所",
}

# 毎月請求している（＝契約にする）品名の目印
RECURRING = re.compile(r"在留サポート|定着サポート|コンサルタントサポート費|日本語教育サポート")


def z2h(s):
    return unicodedata.normalize("NFKC", s) if isinstance(s, str) else s


def strip_month(name):
    """「株式会社渡邊金属（5月）」→「株式会社渡邊金属」"""
    n = re.sub(r"[（(]\s*[0-9０-９]+\s*月分?\s*[）)]\s*$", "", str(name)).strip()
    return n


def name_key(n):
    """表記ゆれを同じにみなすための鍵"""
    k = z2h(n)
    k = re.sub(r"\s+", "", k)
    k = re.sub(r"\d+$", "", k)  # 末尾の「1」「2」（同じ月の2枚目を分ける目印）
    k = re.sub(r"(株式会社|株式會社|有限会社|合同会社|\(株\)|\(有\)|㈱|㈲)", "", k)
    k = k.replace("渡邉", "渡邊").replace("渡辺", "渡邊").replace("ー", "ー").replace("―", "ー")
    k = re.sub(r"(工作所|製作所|工業)$", "", k)
    return k


def formal_override(name):
    for key, formal in FORMAL_NAMES.items():
        if key in name:
            return formal
    return None


def parse_count(desc):
    d = z2h(desc)
    m = re.search(r"(\d+)回目\s*/\s*全\s*(\d+)\s*回", d)
    if m:
        return int(m.group(1)), int(m.group(2)), "回"
    m = re.search(r"(\d+)\s*(?:か月|ヶ月|ケ月)目", d)
    if m:
        return int(m.group(1)), None, "か月"
    return None, None, None


def parse_service_month(desc):
    m = re.search(r"(\d{1,2})月分", z2h(desc))
    return int(m.group(1)) if m else None


def contract_key(desc):
    d = z2h(desc)
    if "教材提供型日本語" in d:
        name = "教材提供型日本語教育サポート"
    elif "定着サポート" in d:
        name = "受入・定着サポート費"
    elif "コンサルタントサポート" in d:
        name = "コンサルタントサポート費"
    else:
        name = "在留サポートサービス"
    m = re.search(r"([一二三四五六七八九十\d]+期生)", d)
    return name, (m.group(1) if m else "")


def to_int(v):
    try:
        return int(z2h(str(v)).replace(",", ""))
    except (TypeError, ValueError):
        return None


def main(request_tool_path, sales_path, out_path, today=None):
    today = today or dt.date.today()
    active_since = dt.date(today.year - 1, today.month, 1)       # 1年以内に請求があれば取引中
    contract_since = dt.date(today.year, today.month, 1) - dt.timedelta(days=62)  # 2か月以内の請求を契約候補に
    issues_since = dt.date(2025, 11, 1)  # 移行する範囲（2026年度の売上表）より前の気になる点は出さない

    wb = openpyxl.load_workbook(request_tool_path, data_only=True)

    # 住所一覧
    addresses = {}
    ws = wb["Sheet1"]
    for r in range(3, ws.max_row + 1):
        n = ws[f"A{r}"].value
        if n:
            addresses[name_key(str(n))] = {
                "name": z2h(str(n)).strip(),
                "postal": z2h(str(ws[f"B{r}"].value or "")).strip() or None,
                "address": z2h(str(ws[f"C{r}"].value or "")).replace("\n", " ").strip() or None,
                "contact": z2h(str(ws[f"D{r}"].value or "")).strip() or None,
            }

    companies = OrderedDict()
    contracts = OrderedDict()
    issues = []

    for ws in wb.worksheets:
        if ws.title in NOT_COMPANY_SHEETS:
            continue
        rows = []
        for r in range(7, ws.max_row + 1):
            a = ws[f"A{r}"].value
            if not isinstance(a, dt.datetime):
                continue
            rows.append({
                "row": r,
                "date": a.date(),
                "client": ws[f"B{r}"].value,
                "desc": z2h(str(ws[f"C{r}"].value or "")).replace("\n", ""),
                "unit": ws[f"D{r}"].value,
                "qty": ws[f"E{r}"].value,
                "amount": ws[f"F{r}"].value,
                "acct": z2h(str(ws[f"H{r}"].value or "")),
            })
        if not rows:
            continue

        latest = max(rows, key=lambda x: x["date"])
        raw_name = z2h(strip_month(latest["client"] or ws.title))
        key = name_key(raw_name)
        addr = addresses.get(key)
        formal = formal_override(raw_name) or (addr["name"] if addr else raw_name)
        companies[key] = {
            "formal": formal,
            "sheet": ws.title,
            "variants": OrderedDict({formal: True}),
            "last": latest["date"],
            "count": len(rows),
            "addr": addr,
        }

        for x in rows:
            if x["date"] < issues_since and x["date"] <= today:
                continue
            # 未来の請求日（年の入れ間違い）
            if x["date"] > today + dt.timedelta(days=40):
                issues.append([formal, f"{ws.title} {x['row']}行目", f"請求日が {x['date']:%Y年%m月%d日} になっています",
                               "年の入れ間違いの可能性"])
            # 計上月と請求日の月のずれ
            m = re.match(r"(\d{1,2})月", x["acct"])
            if m and int(m.group(1)) != x["date"].month:
                issues.append([formal, f"{ws.title} {x['row']}行目",
                               f"請求日は{x['date'].month}月なのに計上月が「{x['acct']}」", "どちらが正しいか確認"])
            # 金額が空
            if x["desc"] and (not isinstance(x["amount"], (int, float)) or x["amount"] == 0):
                issues.append([formal, f"{ws.title} {x['row']}行目", f"金額が空です：{x['desc'][:40]}",
                               "売上表には金額があるか確認"])

        # 契約候補：直近2か月の、毎月の請求
        for x in sorted(rows, key=lambda x: x["date"]):
            if x["date"] < contract_since or not RECURRING.search(x["desc"]):
                continue
            name, cohort = contract_key(x["desc"])
            n, total, unit = parse_count(x["desc"])
            svc = parse_service_month(x["desc"])
            offset = (svc - x["date"].month) % 12 if svc else None
            qty = to_int(x["qty"])
            unit_price = to_int(x["unit"])
            ck = (key, name, cohort)
            prev = contracts.get(ck)
            if prev and prev["date"] == x["date"]:
                # 同じ請求日に同じ契約が2行（追いつき請求など）→ 後の「◯月分」を残し、注意を出す
                issues.append([formal, f"{ws.title} {x['row']}行目",
                               f"同じ日に「{name}{cohort}」の請求が2行あります", "まとめて請求した月がないか確認"])
            contracts[ck] = {
                "company": formal, "name": name, "cohort": cohort, "qty": qty, "unit_price": unit_price,
                "amount": x["amount"] if isinstance(x["amount"], (int, float)) else None,
                "offset": offset, "count": n, "total": total, "unit": unit or "回",
                "date": x["date"], "desc": x["desc"],
            }

    # 売上表の表記ゆれを足す
    try:
        sb = openpyxl.load_workbook(sales_path, data_only=True)
        for sname in SALES_MONTH_SHEETS:
            if sname not in sb.sheetnames:
                continue
            s = sb[sname]
            sheet_date = s["H1"].value.date() if isinstance(s["H1"].value, dt.datetime) else None
            for r in range(73, s.max_row + 1):
                v = s[f"B{r}"].value
                if not v:
                    continue
                v = str(v).strip()
                k = name_key(v)
                if k in companies:
                    companies[k]["variants"][v] = True
                    if sheet_date and (companies[k]["last"] is None or companies[k]["sheet"] == "（社内申込書になし）"):
                        companies[k]["last"] = max(filter(None, [companies[k]["last"], sheet_date]))
                else:
                    a = addresses.get(k)
                    companies[k] = {"formal": formal_override(v) or (a["name"] if a else re.sub(r"\d+$", "", z2h(v)).strip()),
                                    "sheet": "（社内申込書になし）", "variants": OrderedDict({v: True}),
                                    "last": sheet_date, "count": 0, "addr": a}
    except Exception as e:  # noqa: BLE001
        print("売上表を読めませんでした:", e)

    # ---------------- 出力 ----------------
    out = openpyxl.Workbook()
    head_fill = PatternFill("solid", fgColor="E4F0EC")
    warn_fill = PatternFill("solid", fgColor="FBF0DC")
    gray = Font(name="Meiryo", size=10, color="888888")
    font = Font(name="Meiryo", size=10)
    bold = Font(name="Meiryo", size=10, bold=True)

    def setup(ws, headers, widths):
        ws.append(headers)
        for i, w in enumerate(widths, 1):
            ws.column_dimensions[get_column_letter(i)].width = w
            c = ws.cell(row=1, column=i)
            c.font = bold
            c.fill = head_fill
            c.alignment = Alignment(wrap_text=True, vertical="center")
        ws.freeze_panes = "A2"

    guide = out.active
    guide.title = "はじめに"
    for ln in [
        "アプリに取り込む前の確認用です（最新の社内申込書から取り出しました）",
        "",
        "1. 「企業」シート：社内申込書にある企業すべてです。住所は Sheet1 の一覧から入れています。",
        f"   ・{active_since:%Y年%m月}以降に請求がある企業を「取引中」、それより前の企業を「取引終了」にしています。",
        "   ・黄色の行は、住所が見つからなかった企業です。",
        "2. 「契約」シート：直近2か月に毎月の請求（在留サポートなど）がある契約を、企業・期ごとに1行にしました。",
        "   ・人数と単価は、社内申込書の「単価」「個数」の列から読んでいます。",
        "   ・回数は最後の請求の品名から読み取っています。「次の回数」が合っているか確かめてください。",
        "   ・回数が品名にない契約（「10月分」だけのもの）は、次の回数が空になります。",
        "3. 「要確認」シート：Excelの中で見つかった、日付や金額の気になるところです。",
        "",
        "成功報酬・航空券などの1回だけの請求は契約にせず、請求のときに明細として入れます。",
    ]:
        guide.append([ln])
    guide.column_dimensions["A"].width = 110
    for row in guide.iter_rows():
        for c in row:
            c.font = font
    guide["A1"].font = bold

    yes_no = DataValidation(type="list", formula1='"はい,いいえ"', allow_blank=False)
    state_dv = DataValidation(type="list", formula1='"取引中,取引終了"', allow_blank=False)

    ws = out.create_sheet("企業")
    setup(ws, ["正式名", "取引の状態", "最後の請求日", "郵便番号", "住所", "部署・担当者", "Excelでの表記", "社内申込書のシート名", "メモ"],
          [36, 11, 14, 11, 46, 40, 46, 22, 30])
    ws.add_data_validation(state_dv)
    ordered = sorted(companies.values(), key=lambda c: (c["last"] is None, -(c["last"].toordinal() if c["last"] else 0)))
    for c in ordered:
        active = c["last"] is not None and c["last"] >= active_since
        a = c["addr"] or {}
        ws.append([c["formal"], "取引中" if active else "取引終了", f"{c['last']:%Y/%m/%d}" if c["last"] else "",
                   a.get("postal"), a.get("address"), a.get("contact"), "、".join(c["variants"].keys()), c["sheet"],
                   "" if a else "住所が見つかりません"])
        state_dv.add(f"B{ws.max_row}")
        if not a and active:
            for cell in ws[ws.max_row]:
                cell.fill = warn_fill
        if not active:
            for cell in ws[ws.max_row]:
                cell.font = gray
    for row in ws.iter_rows(min_row=2):
        for cell in row:
            if cell.font != gray:
                cell.font = font

    ws = out.create_sheet("契約")
    setup(ws, ["企業", "契約名", "期", "人数", "単価（税抜）", "月額（税抜）", "◯月分の関係", "最後の回数", "全回数",
               "次の回数", "最後の請求日", "最後の品名（元の表記）", "取り込む"],
          [32, 26, 10, 7, 12, 12, 16, 10, 8, 10, 13, 62, 10])
    ws.add_data_validation(yes_no)
    for c in sorted(contracts.values(), key=lambda x: (x["company"], x["name"], x["cohort"])):
        relation = {0: "請求月と同じ月分", 1: "翌月分を前請求"}.get(c["offset"], "品名に◯月分なし")
        finished = c["total"] and c["count"] and c["count"] >= c["total"]
        ws.append([c["company"], c["name"], c["cohort"] or None, c["qty"], c["unit_price"], c["amount"], relation,
                   c["count"], c["total"], (c["count"] + 1) if c["count"] else None, f"{c['date']:%Y/%m/%d}", c["desc"],
                   "いいえ" if finished else "はい"])
        yes_no.add(f"M{ws.max_row}")
        if finished or c["count"] is None and c["offset"] is None:
            for cell in ws[ws.max_row]:
                cell.fill = warn_fill
    for row in ws.iter_rows(min_row=2):
        for cell in row:
            cell.font = font
            if cell.column in (5, 6):
                cell.number_format = "#,##0"

    ws = out.create_sheet("要確認")
    setup(ws, ["企業", "場所", "内容", "確認すること"], [32, 30, 60, 30])
    for i in issues:
        ws.append(i)
    for row in ws.iter_rows(min_row=2):
        for cell in row:
            cell.font = font

    out.save(out_path)
    n_active = sum(1 for c in companies.values() if c["last"] and c["last"] >= active_since)
    print(f"企業 {len(companies)} 件（取引中 {n_active} 件）、契約 {len(contracts)} 件、要確認 {len(issues)} 件 → {out_path}")


if __name__ == "__main__":
    if len(sys.argv) not in (4, 5):
        print(__doc__)
        sys.exit(1)
    today = dt.date.fromisoformat(sys.argv[4]) if len(sys.argv) == 5 else None
    main(sys.argv[1], sys.argv[2], sys.argv[3], today)
