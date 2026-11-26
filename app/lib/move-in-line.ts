// app/lib/move-in-line.ts — 入居の時期と期限の1行（ブレインの材料・既定 off・印 move_in_line）と、入居の時期の読み（作業員A の時間の地図の入力）（純関数・DB/LLM なし）
// 2026-11-27 作業員L（竹内さん 11/27「現状の把握…細分化」・葉×出す側の表の穴の4位: 入居の札は登録の条件に 63/90 番あるのに、ブレインに入居の時期の葉が無い＝判断の欄に一度も出ない）:
//   分け目（作業員A と決めた）: L＝入居の時期の読み（moveInFor）と材料の1行・A＝その読みを入力にした予定表（time-map）・逆算への渡し・葉の物差し。予定表は読み取りをやり直さない。
//   読み: 登録の条件（property_customers.move_in_time・parseMoveInWant）を先に、会話の新しいお客様の言い直し（入居・引越の語がある通・resolveMoveInStart）があれば上書き。
//   切替: MOVE_IN_LINE=on（既定 off）。申込以降は呼ぶ側で出さない。事実だけ（道の言葉は書かない）
import { parseMoveInWant } from "./move-in-want";
import { resolveMoveInStart } from "./contact-promise";

type Env = Record<string, string | undefined>;
export const moveInLineOn = (env: Env = typeof process !== "undefined" ? process.env : {}) => (env.MOVE_IN_LINE ?? "").trim().toLowerCase() === "on";
/** 作業員A の時間の地図の入力の形 */
export type MoveInInput = { kind: "date" | "range" | "unknown"; startYmd?: string | null; endYmd?: string | null; source?: "registered" | "conversation" | null; label?: string | null };
const pad = (n: number) => String(n).padStart(2, "0");
const ymdOf = (p: { y: number; m: number; d: number }) => `${p.y}-${pad(p.m)}-${pad(p.d)}`;
const MOVE_WORD_RE = /入居|引越|引っ越|住み始め|退去|更新/;
/** 入居の時期（純関数）。会話の言い直しは、登録の条件より後のお客様の通で入居・引越の語がある物だけ（内覧の日などを入居と取り違えない） */
export function moveInFor(i: { registered?: string | null; registeredAt?: string | null; customerMsgs?: ReadonlyArray<{ text: string | null; created_at: string }>; nowIso: string }): MoveInInput {
  const msgs = [...(i.customerMsgs ?? [])].filter((m) => MOVE_WORD_RE.test(String(m.text ?? "")) && (!i.registeredAt || m.created_at > i.registeredAt)).sort((a, b) => b.created_at.localeCompare(a.created_at));
  for (const m of msgs) {
    const s = resolveMoveInStart(m.text, m.created_at);
    if (s && ymdOf(s.ymd) >= i.nowIso.slice(0, 10)) return { kind: "date", startYmd: ymdOf(s.ymd), endYmd: null, source: "conversation", label: s.label };
  }
  const w = parseMoveInWant(i.registered ?? null, { registeredAt: i.registeredAt ?? null, today: i.nowIso });
  if ((w.kind === "by" || w.kind === "asap") && w.wantBy) return { kind: "date", startYmd: w.wantBy, endYmd: null, source: "registered", label: w.label };
  if (w.kind === "after" || w.kind === "vague") return { kind: "unknown", startYmd: null, endYmd: null, source: "registered", label: w.label };
  return { kind: "unknown", startYmd: null, endYmd: null, source: null, label: null };
}
/** 材料の1行（事実だけ・日にちが読めない時は空）。あと何日・申込の目安（入居の3〜4週間前＝作業員A の逆算の計画と同じ目安） */
export function moveInLine(mi: MoveInInput, nowIso: string): string {
  if (mi.kind === "unknown" || !mi.startYmd) return "";
  const days = Math.round((Date.parse(`${mi.startYmd}T00:00:00+09:00`) - Date.parse(`${nowIso.slice(0, 10)}T00:00:00+09:00`)) / 864e5);
  const [, m, d] = mi.startYmd.split("-").map(Number);
  const from = mi.source === "conversation" ? "お客様の会話" : "登録の条件";
  return `【入居の時期と期限】${m}/${d}${mi.label ? `（${mi.label}）` : ""}・あと ${days}日（${from}）・申込の目安は入居の3〜4週間前`;
}
