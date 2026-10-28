/** 契約から請求書の品名を組み立てる */

export const DEFAULT_TEMPLATE = "{人数}名分：{契約名}：{対象月}分（{回数}回目/全{全回数}回）";

export const TEMPLATE_KEYS = ["人数", "契約名", "期", "対象月", "回数", "全回数"] as const;

export type TemplateValues = {
  人数: number | string;
  契約名: string;
  期: string;
  対象月: string; // 例：11月
  回数: number | string;
  全回数: number | string;
};

export function renderTemplate(template: string | null | undefined, v: TemplateValues): string {
  const t = template && template.trim() !== "" ? template : DEFAULT_TEMPLATE;
  let out = t;
  for (const key of TEMPLATE_KEYS) {
    out = out.split(`{${key}}`).join(String(v[key] ?? ""));
  }
  // 全回数がない契約で「/全回」だけ残らないようにする
  return out.replace(/\/全回/g, "").replace(/（\s*）/g, "").trim();
}

/** "2026-11-01" に offset か月足した月の "11月" */
export function monthName(billingMonth: string, offset: number): string {
  const [y, m] = billingMonth.split("-").map(Number);
  const d = new Date(Date.UTC(y, m - 1 + offset, 1));
  return `${d.getUTCMonth() + 1}月`;
}

/** 次に請求するときの回数（アプリ導入前の回数 + アプリで確定した数 + 1） */
export function nextCount(baseCount: number, confirmedInApp: number): number {
  return baseCount + confirmedInApp + 1;
}
