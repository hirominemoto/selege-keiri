/** 表示用の整形。金額・日付はすべてここを通す */

export function yen(n: number | null | undefined): string {
  if (n === null || n === undefined) return "—";
  return `${n.toLocaleString("ja-JP")}円`;
}

/** "2026-11-01" → "2026年11月" */
export function monthLabel(d: string | null | undefined): string {
  if (!d) return "—";
  const [y, m] = d.split("-");
  return `${Number(y)}年${Number(m)}月`;
}

/** "2026-11-01" → "2026-11"（<input type="month"> 用） */
export function toMonthInput(d: string | null | undefined): string {
  return d ? d.slice(0, 7) : "";
}

/** "2026-10-31" → "2026年10月31日" */
export function dateLabel(d: string | null | undefined): string {
  if (!d) return "—";
  const [y, m, day] = d.slice(0, 10).split("-");
  return `${Number(y)}年${Number(m)}月${Number(day)}日`;
}

export function dateTimeLabel(ts: string | null | undefined): string {
  if (!ts) return "—";
  return new Date(ts).toLocaleString("ja-JP", {
    timeZone: "Asia/Tokyo",
    year: "numeric",
    month: "numeric",
    day: "numeric",
    hour: "2-digit",
    minute: "2-digit",
  });
}

/** 契約の回数表示："13回目／全24回"、"26か月目" */
export function countLabel(n: number, total: number | null, unit: string): string {
  const head = unit === "か月" ? `${n}か月目` : `${n}回目`;
  return total ? `${head}／全${total}${unit === "か月" ? "か月" : "回"}` : head;
}

export const sendMethodLabel: Record<string, string> = { post: "郵送", email: "メール" };
export const contractStatusLabel: Record<string, string> = {
  active: "継続中",
  paused: "休止中",
  ended: "終了",
};
export const contractKindLabel: Record<string, string> = { monthly: "毎月", one_time: "1回だけ" };
