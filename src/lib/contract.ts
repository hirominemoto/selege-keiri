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

/**
 * 次に請求するときの回数の候補
 * （アプリ導入前の回数と、アプリで請求した最大の回数の大きいほう + 1。データベースの next_count_no と同じ考え方）
 */
export function nextCount(baseCount: number, maxCountInApp: number | null): number {
  return Math.max(baseCount, maxCountInApp ?? 0) + 1;
}
