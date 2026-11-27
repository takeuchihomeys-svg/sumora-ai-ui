// scripts/lib/karte-morning.ts — 朝の1枚の「お客様のカルテ」の1行（純関数・台帳 #806）
// 2026-11-28 作業員L: quality_daily の karte:*（scripts/audit-customer-karte.ts --write が晩に書く・一番新しい日の行）から1行を作る
export type KarteRow = { day: string; metric: string; value: number | null; n?: number | null };
const FIELD_JA: Record<string, string> = { priorities: "優先", noGo: "譲れない線", decider: "決める人", replySpeed: "返事の速さ", wording: "言葉づかい", cost: "費用", declined: "断った物件" };
export function karteMorningLine(rows: readonly KarteRow[]): string | null {
  if (!rows.length) return null;
  const v = (m: string) => rows.find((r) => r.metric === m)?.value ?? null;
  const has = v("karte:has_block"); if (has == null) return null;
  const n = rows.find((r) => r.metric === "karte:has_block")?.n ?? null;
  const fields = Object.keys(FIELD_JA).map((k) => { const x = v(`karte:field:${k}`); return x == null ? null : `${FIELD_JA[k]} ${x}%`; }).filter(Boolean).join("・");
  const dropped = v("karte:dropped");
  return `- お客様のカルテ（#806・${rows[0].day}・前の7日${n != null ? `・${n}会話` : ""}）: 出る ${has}%・平均 ${v("karte:avg_len") ?? "—"}字・${fields}${dropped ? `・審査の事情で落とした欄 ${dropped}` : ""}（CUSTOMER_KARTE は既定 off）`;
}
