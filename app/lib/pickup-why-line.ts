// app/lib/pickup-why-line.ts — 送った物件を「なぜ選んだか」（売上サポの判定の札）を、送った後の番のブレインの材料に1行で渡す（純関数・LLM なし）
//
// 2026-11-21 作業員K2（台帳 #469・竹内さん「物件選定と LINE の部分の連携がちゃんとできていればより質は高くなる」・統括役の頼み）。
//   物件選び → LINE の穴: 判定（property-brain.judgeProperty）は物件ごとに合う点・合わない点の札（reason_codes）を property_pickups に残し、
//   AIX の1通目・2通目はそれを読むが、ブレイン（と返信の書き手）には「送れる候補の有無」しか届かない（pickupReadyMaterial）。
//   そのため送った後の番で、お客様の反応（広い・遠い・高い…）を、選んだ理由と照らして読めない（送った理由と食い違う返信も止められない）。
// 形: 72時間以内に送った物件（status=sent）を、👑（recommended）→ 点の順に最大3件。物件ごとに 合う点（点が正の札）最大3・気になる点（点が負の札）最大2。
//   社内の判断の札（AD・利益・検索のやり方・決め手の像・学びの加点・家賃の帯）は入れない（お客様に言う事ではない）。
//   材料だけ（次の一手・押す言葉は入れない＝判断はブレイン・P0 9eb6aa9c）。
// ■ スイッチ PICKUP_WHY_TO_BRAIN: 既定 off（読まない・プロンプトは1バイトも変わらない）／on（材料に1行）
// テスト: app/lib/__tests__/pickup-why-line.test.ts
import { reasonJa, reasonPoints } from "@/app/lib/property-brain";

type Env = Record<string, string | undefined>;
export function pickupWhyToBrainOn(env: Env = typeof process !== "undefined" ? process.env : {}): boolean {
  return String(env.PICKUP_WHY_TO_BRAIN ?? "").trim().toLowerCase() === "on";
}

export type SentPickupRow = { property_name: string | null; room_no: string | null; recommended: number | boolean | null; score: number | null; reason_codes: string[] | null; sent_at: string | null };

/** お客様に向けた合う・合わないの札ではない物（社内の判断） */
const INTERNAL = /^(?:AD_|PROFIT|SEARCH_|CLOSING_|HOOK_|RENT_BAND_|FIT_ALL|SCORE_|LEARN|PREF_|STAR_|NEW_ARRIVAL|SENT_|DEDUPE|DUP_)/;

export function pickupWhyOf(rows: ReadonlyArray<SentPickupRow>, o: { nowMs: number; windowH?: number; max?: number }): Array<{ name: string; crown: boolean; good: string[]; bad: string[] }> {
  const winMs = (o.windowH ?? 72) * 36e5;
  const seen = new Set<string>();
  const sent = rows.filter((r) => r.sent_at && o.nowMs - Date.parse(r.sent_at) <= winMs && o.nowMs >= Date.parse(r.sent_at) && (r.property_name ?? "").trim())
    .sort((a, b) => Number(b.recommended ?? 0) - Number(a.recommended ?? 0) || (b.score ?? 0) - (a.score ?? 0));
  const out: Array<{ name: string; crown: boolean; good: string[]; bad: string[] }> = [];
  for (const r of sent) {
    const name = `${String(r.property_name ?? "").trim()}${r.room_no ? ` ${String(r.room_no).trim()}` : ""}`;
    if (seen.has(name)) continue; seen.add(name);
    const codes = (r.reason_codes ?? []).filter((c) => !INTERNAL.test(c));
    const good = codes.filter((c) => reasonPoints(c) > 0).sort((a, b) => reasonPoints(b) - reasonPoints(a)).slice(0, 3).map(reasonJa);
    const bad = codes.filter((c) => reasonPoints(c) < 0).sort((a, b) => reasonPoints(a) - reasonPoints(b)).slice(0, 2).map(reasonJa);
    if (!good.length && !bad.length) continue;
    out.push({ name, crown: Number(r.recommended ?? 0) > 0, good, bad });
    if (out.length >= (o.max ?? 3)) break;
  }
  return out;
}

/** ブレインに渡す1行（無ければ ""） */
export function pickupWhyLine(items: ReturnType<typeof pickupWhyOf>): string {
  if (!items.length) return "";
  const parts = items.map((x) => `${x.crown ? "🌟" : ""}${x.name}: 合う点 ${x.good.join("・") || "なし"}${x.bad.length ? `／気になる点 ${x.bad.join("・")}` : ""}`);
  return `【送った物件を選んだ理由（売上サポの判定の札・72時間以内に送った物）】${parts.join(" ／ ")}。お客様の今の反応をこの理由と照らして読む（理由と食い違う事を言わない・札の言葉をそのまま文に写さない）。`;
}
