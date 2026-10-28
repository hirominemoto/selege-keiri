"""
旧Excelから、アプリに取り込む「企業」と「継続中の契約」の候補を取り出す。

使い方:
  python3 tools/extract_import.py <売上表.xlsm> <社内申込書ツール.xlsm> <出力.xlsx>

出力は確認用のExcel（取引先の実データなのでリポジトリには入れない）。
ひろみが「正式名」「取り込む」などを確認・修正してから、取り込みに使う。
"""

import re
import sys
import unicodedata
from collections import OrderedDict

import openpyxl
from openpyxl.styles import Alignment, Font, PatternFill
from openpyxl.utils import get_column_letter
from openpyxl.worksheet.datavalidation import DataValidation

MONTH_SHEETS = ["11月", "12月", "1月", "2月", "3月", "4月", "5月", "6月", "7月", "8月", "9月"]
FIRST_ROW = 73  # 「アジア人材」の明細が始まる行
# 毎月請求している（＝契約にする）品名の目印
RECURRING = re.compile(r"在留サポート|定着サポート|コンサルタントサポート費|日本語教育サポート")


def z2h(s):
    return unicodedata.normalize("NFKC", s) if isinstance(s, str) else s


def base_name(name):
    """「興和工業株式会社1」→「興和工業株式会社」。末尾の数字は2枚目の請求書を分けるための目印"""
    n = z2h(name).strip()
    return re.sub(r"\d+$", "", n).strip()


def parse_count(desc):
    """「（13回目/全24回）」「26か月目」から回数を読む"""
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
    cohort = m.group(1) if m else ""
    return name, cohort


def main(sales_path, request_tool_path, out_path):
    wb = openpyxl.load_workbook(sales_path, data_only=True)

    variants = OrderedDict()  # 正式名候補 → 表記の集合
    last_seen = {}
    contracts = OrderedDict()

    for si, sheet in enumerate(MONTH_SHEETS):
        if sheet not in wb.sheetnames:
            continue
        ws = wb[sheet]
        billing_month = ws["H1"].value  # 請求日
        for r in range(FIRST_ROW, ws.max_row + 1):
            raw_name = ws[f"B{r}"].value
            desc = ws[f"D{r}"].value
            amount = ws[f"G{r}"].value
            if not raw_name or not desc or not isinstance(amount, (int, float)):
                continue
            raw_name = str(raw_name).strip()
            base = base_name(raw_name)
            variants.setdefault(base, OrderedDict())[raw_name] = True
            last_seen[base] = billing_month

            if not RECURRING.search(z2h(desc)):
                continue
            name, cohort = contract_key(desc)
            # 「2名分」「4名分」を人数として読む（個数の列より確か）
            qty = ws[f"F{r}"].value
            m = re.search(r"(\d+)\s*名", z2h(desc))
            if m:
                qty = int(m.group(1))
            try:
                qty = int(z2h(str(qty)))
            except (TypeError, ValueError):
                qty = None
            n, total, unit = parse_count(desc)
            svc = parse_service_month(desc)
            offset = None
            if svc and hasattr(billing_month, "month"):
                offset = (svc - billing_month.month) % 12
            unit_price = round(amount / qty) if qty else amount
            contracts[(base, name, cohort)] = {
                "company": base,
                "name": name,
                "cohort": cohort,
                "quantity": qty,
                "unit_price": unit_price,
                "monthly": amount,
                "offset": offset,
                "count": n,
                "total": total,
                "unit": unit or "回",
                "last_month": billing_month,
                "desc": z2h(str(desc)).replace("\n", ""),
                "sheet_order": si,
            }

    # 住所（社内申込書ツールの Sheet1。2021年時点の情報）
    addresses = {}
    try:
        wt = openpyxl.load_workbook(request_tool_path, data_only=True)
        ws = wt["Sheet1"]
        for r in range(3, ws.max_row + 1):
            n = ws[f"A{r}"].value
            if n:
                addresses[z2h(str(n)).strip()] = (ws[f"B{r}"].value, ws[f"C{r}"].value, ws[f"D{r}"].value)
    except Exception as e:  # noqa: BLE001
        print("社内申込書ツールの住所を読めませんでした:", e)

    # 似た名前（正木精密板金の工作所/製作所、渡邊/渡邉）をまとめる候補
    def similarity_key(n):
        k = re.sub(r"(株式会社|有限会社|\(株\)|㈱)", "", n)
        k = k.replace("渡邉", "渡邊").replace("渡辺", "渡邊")
        k = re.sub(r"(工作所|製作所|工業)$", "", k)
        return k

    groups = OrderedDict()
    for base in variants:
        groups.setdefault(similarity_key(base), []).append(base)

    # ---------------- 出力 ----------------
    out = openpyxl.Workbook()
    head_fill = PatternFill("solid", fgColor="E4F0EC")
    warn_fill = PatternFill("solid", fgColor="FBF0DC")
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

    # 説明
    guide = out.active
    guide.title = "はじめに"
    lines = [
        "アプリに取り込む前の確認用です（2026年度の売上表 11月〜9月から取り出しました）",
        "",
        "1. 「企業」シート：正式名を確かめてください。表記ゆれは同じ行にまとめてあります。",
        "   ・黄色の行は、似た名前が複数あり、同じ会社かどうかの確認が必要なものです。",
        "   ・住所は2021年の社内申込書ツールにあった分だけ入っています。空欄はアプリで入力してください。",
        "2. 「契約」シート：毎月の請求（在留サポートなど）を、企業・期ごとに1行にしました。",
        "   ・回数は最後の請求の品名から読み取っています。「次の回数」が合っているか確かめてください。",
        "   ・「◯月分の関係」は、請求月と品名の「◯月分」から判断しています。",
        "   ・終わった契約は「取り込む」を「いいえ」にしてください。",
        "",
        "成功報酬・航空券などの1回だけの請求は契約にせず、請求のときに明細として入れます。",
    ]
    for ln in lines:
        guide.append([ln])
    guide.column_dimensions["A"].width = 110
    for row in guide.iter_rows():
        for c in row:
            c.font = font
    guide["A1"].font = bold

    yes_no = DataValidation(type="list", formula1='"はい,いいえ"', allow_blank=False)

    ws = out.create_sheet("企業")
    setup(ws, ["正式名（確認してください）", "Excelでの表記", "最後に請求した月", "郵便番号", "住所", "担当者", "取り込む", "メモ"],
          [34, 46, 16, 12, 40, 30, 10, 40])
    ws.add_data_validation(yes_no)
    for key, bases in groups.items():
        all_variants = []
        for b in bases:
            all_variants += list(variants[b].keys())
        formal = max(bases, key=lambda b: len(variants[b]))  # 一番多く使われた表記
        last = max((last_seen[b] for b in bases if hasattr(last_seen[b], "year")), default=None)
        addr = next((addresses[b] for b in bases if b in addresses), (None, None, None))
        note = "似た表記があります。同じ会社か確認してください" if len(bases) > 1 else ""
        ws.append([formal, "、".join(dict.fromkeys(all_variants)), last.strftime("%Y年%m月") if last else "",
                   addr[0], (addr[1] or "").replace("\n", " ") or None, addr[2], "はい", note])
        yes_no.add(f"G{ws.max_row}")
        if len(bases) > 1:
            for c in ws[ws.max_row]:
                c.fill = warn_fill
    for row in ws.iter_rows(min_row=2):
        for c in row:
            c.font = font

    ws = out.create_sheet("契約")
    setup(ws, ["企業", "契約名", "期", "人数", "単価（税抜）", "月額（税抜）", "◯月分の関係", "最後の回数", "全回数",
               "次の回数", "最後に請求した月", "最後の品名（元の表記）", "取り込む"],
          [30, 26, 10, 8, 12, 12, 16, 10, 8, 10, 14, 60, 10])
    ws.add_data_validation(yes_no)
    for c in sorted(contracts.values(), key=lambda x: (x["company"], x["name"], x["cohort"])):
        relation = {0: "請求月と同じ月分", 1: "翌月分を前請求"}.get(c["offset"], "確認が必要")
        last = c["last_month"]
        stale = c["sheet_order"] < len(MONTH_SHEETS) - 1  # 9月に請求していない
        nxt = (c["count"] + 1) if c["count"] else None
        ws.append([c["company"], c["name"], c["cohort"] or None, c["quantity"], c["unit_price"], c["monthly"], relation,
                   c["count"], c["total"], nxt, last.strftime("%Y年%m月") if hasattr(last, "year") else "",
                   c["desc"], "いいえ" if stale or (c["total"] and c["count"] and c["count"] >= c["total"]) else "はい"])
        yes_no.add(f"M{ws.max_row}")
        if stale or relation == "確認が必要" or c["count"] is None:
            for cell in ws[ws.max_row]:
                cell.fill = warn_fill
    for row in ws.iter_rows(min_row=2):
        for cell in row:
            cell.font = font
            if cell.column in (5, 6):
                cell.number_format = "#,##0"

    out.save(out_path)
    print(f"企業 {len(groups)} 件、契約 {len(contracts)} 件を書き出しました → {out_path}")


if __name__ == "__main__":
    if len(sys.argv) != 4:
        print(__doc__)
        sys.exit(1)
    main(*sys.argv[1:])
