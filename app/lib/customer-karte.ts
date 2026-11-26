// app/lib/customer-karte.ts — 台帳 #806 お客様のカルテ（一人ごとに毎番ブレインが読める1枚）（純関数・DB/LLM なし・既定 off）
// 2026-11-27 作業員L（竹内さん 11/27「1 2 4 の地図は特に強化する」・統括役の割り振り・葉×出す側の穴「お客様が待っている物」「送った物と反応」）:
//   新しく作るより先に、今ある物をつなぐ: 登録の条件（preferences・ng_points・希望・初期費用の上限）・会話の通（決める人・返事の速さ・言葉づかい・費用の感じ方）・
//   物件の台帳（送った物件×お客様の反応＝reaction-negatives.buildReactionNegatives の「見送り」と訳）。
//   入れない物: 審査の事情（screeningSensitiveSignal に当たる欄は落とす）・申込以降（呼ぶ側で出さない）・個人情報（名前・電話・勤め先＝maskPII を通す）。
//   切替: CUSTOMER_KARTE=on（既定 off）・印 customer_karte（material_marks・SWITCH_TARGET_MARK）。事実の数だけ・決めるのはブレイン
import { screeningSensitiveSignal } from "./screening-sensitive";
import { maskPII } from "./pii-mask";
import { buildReactionNegatives, REACTION_ATTR_JA, type RxSend, type RxMsg } from "./reaction-negatives";

type Env = Record<string, string | undefined>;
export const customerKarteOn = (env: Env = typeof process !== "undefined" ? process.env : {}) => (env.CUSTOMER_KARTE ?? "").trim().toLowerCase() === "on";
export type KarteMsg = { sender: string; text: string | null; created_at: string };
export type KartePc = { preferences?: string | null; ng_points?: string | null; desired_area?: string | null; floor_plan?: string | null; rent_max?: number | null; initial_cost_limit?: number | null } | null;
export type KarteSent = { property_name: string; room_no?: string | null; sent_at: string; rent?: number | null };
export type Karte = { priorities: string | null; noGo: string | null; decider: string | null; replySpeed: string | null; wording: string | null; cost: string | null; declined: string | null; dropped: string[] };

const DECIDER_RE = /(家族|主人|夫|妻|旦那|嫁|彼氏|彼女|パートナー|親|両親|母|父|同居人)(?:と|に|へ|が)?(?:相談|確認|聞いて|話して|決め|見せ)/;
const COST_RE = /初期費用|費用|安く|値下|割引|予算|高い|お得|抑え/;
const clip = (s: string, n = 60) => (s.length > n ? `${s.slice(0, n)}…` : s);
const median = (xs: number[]) => { if (!xs.length) return null; const s = [...xs].sort((a, b) => a - b); return s[Math.floor(s.length / 2)]; };
/** カルテ（純関数）。msgs は会話の通（新旧どちらの並びでもよい）・sent は送った物件・names は伏せる名前 */
export function karteOf(i: { pc: KartePc; msgs: readonly KarteMsg[]; sent?: readonly KarteSent[]; nowIso: string; names?: ReadonlyArray<string | null | undefined> }): Karte {
  const ms = [...i.msgs].sort((a, b) => a.created_at.localeCompare(b.created_at));
  const cust = ms.filter((m) => m.sender === "customer" && String(m.text ?? "").trim());
  const dropped: string[] = [];
  const safe = (label: string, s: string | null): string | null => {
    if (!s) return null;
    const masked = maskPII(s, [...(i.names ?? [])]);
    if (screeningSensitiveSignal(masked)) { dropped.push(label); return null; } // 審査の事情は入れない（欄ごと落とす）
    return masked;
  };
  const pc = i.pc ?? {};
  const pri = [pc.desired_area, pc.floor_plan, pc.rent_max ? `家賃 ${Math.round(pc.rent_max / 1000) / 10}万まで` : null, pc.preferences].filter(Boolean).join("・");
  const decHits = cust.map((m) => String(m.text ?? "").match(DECIDER_RE)?.[1]).filter((x): x is string => !!x);
  const decCount = new Map<string, number>(); for (const d of decHits) decCount.set(d, (decCount.get(d) ?? 0) + 1);
  const dec = [...decCount].sort((a, b) => b[1] - a[1])[0];
  // 返事の速さ: こちらの最後の通（続けて送った時は最後の1通）から、お客様の次の通までの分（30日・中央）
  const since = Date.parse(i.nowIso) - 30 * 864e5; const gaps: number[] = [];
  for (let k = 0; k < ms.length; k++) { if (ms[k].sender === "customer" || Date.parse(ms[k].created_at) < since) continue; const nx = ms.slice(k + 1).find((m) => m.sender === "customer"); if (nx && !ms.slice(k + 1, ms.indexOf(nx)).some((m) => m.sender !== "customer")) gaps.push((Date.parse(nx.created_at) - Date.parse(ms[k].created_at)) / 60000); }
  const g = median(gaps.filter((x) => x >= 0 && x < 7 * 1440));
  const speed = g == null ? null : g < 30 ? `すぐ返す（中央 ${Math.round(g)}分）` : g < 360 ? `数時間で返す（中央 ${Math.round(g / 60)}時間）` : `間が空く（中央 ${Math.round(g / 60)}時間）`;
  // 言葉づかい: 丁寧・長さ・絵文字
  const ct = cust.map((m) => String(m.text ?? ""));
  const polite = ct.filter((t) => /です|ます|ございます|下さい|ください/.test(t)).length, emoji = ct.filter((t) => /[\u{1F300}-\u{1FAFF}☀-➿]|[!！]{2,}|笑|ｗ/u.test(t)).length;
  const avgLen = ct.length ? Math.round(ct.reduce((a, t) => a + t.length, 0) / ct.length) : 0;
  const wording = ct.length >= 3 ? `${polite / ct.length >= 0.5 ? "丁寧" : "くだけた"}・${avgLen <= 20 ? "短め" : avgLen <= 60 ? "ふつう" : "長め"}${emoji / ct.length >= 0.3 ? "・絵文字や笑いあり" : ""}` : null;
  const costN = ct.filter((t) => COST_RE.test(t)).length;
  const cost = costN || pc.initial_cost_limit ? `${pc.initial_cost_limit ? `初期費用は ${Math.round(pc.initial_cost_limit / 10000)}万まで・` : ""}費用の話 ${costN}回${costN >= 3 ? "（費用を気にする）" : ""}` : null;
  // 前に断った物件とその訳（送った物件×お客様の反応）
  let declined: string | null = null;
  if (i.sent?.length) {
    const sends: RxSend[] = i.sent.map((p) => ({ conv: "c", at: p.sent_at, props: [{ key: `${p.property_name}|${p.room_no ?? ""}`, name: p.property_name, floor: null, rentTotal: p.rent ?? null, areaSqm: null, walk: null, age: null }] }));
    const rx: RxMsg[] = cust.map((m) => ({ conv: "c", at: m.created_at, text: m.text }));
    const st = buildReactionNegatives({ sends, msgs: rx, now: i.nowIso });
    const dec2 = Object.entries(st.perProperty).filter(([, v]) => v.declined).slice(0, 3).map(([k, v]) => `${k.split("|")[0]}${v.attrs.length ? `（${v.attrs.map((a) => REACTION_ATTR_JA[a]).join("・")}）` : ""}`);
    if (dec2.length) declined = dec2.join("／");
  }
  return {
    priorities: safe("優先する条件", pri ? clip(pri) : null), noGo: safe("譲れない線", pc.ng_points ? clip(String(pc.ng_points)) : null),
    decider: dec ? `${dec[0]}と相談して決める（${dec[1]}回）` : null, replySpeed: speed, wording, cost, declined: safe("前に断った物件", declined), dropped,
  };
}
/** 材料の1枚（無い欄は出さない・全部無ければ空） */
export function karteBlock(k: Karte): string {
  const rows = [["優先する条件", k.priorities], ["譲れない線", k.noGo], ["決める人", k.decider], ["返事の速さ", k.replySpeed], ["言葉づかい", k.wording], ["費用の感じ方", k.cost], ["前に断った物件と訳", k.declined]].filter(([, v]) => v) as Array<[string, string]>;
  return rows.length ? `【お客様のカルテ（記録と会話から・事実だけ）】\n${rows.map(([a, b]) => `- ${a}: ${b}`).join("\n")}` : "";
}
