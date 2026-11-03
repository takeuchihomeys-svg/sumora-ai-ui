// app/lib/flow-signals.ts — 会話の流れの合図（決まった計算・候補だけ・純関数）
//
// 2026-11-03 竹内さん（KB P1「お客様の潜在意識と要点を読む部分を6つで強化」③）: 次の合図を数えて状況のまとめに材料として渡す。読むのはブレイン（P0）。
//   repeat_q＝同じ質問の繰り返し／sent_ignored・sent_reacted＝送った物件への反応と無視／slower＝返信の間隔が遅くなった／
//   shorter＝返信が短くなった／emoji_gone＝絵文字が消えた／consult＝相談相手の気配（同棲の相手・親）
// 切替: BRAIN_FLOW_SIGNALS（既定 off・記録だけ→ digest.fs）。テスト: app/lib/__tests__/flow-signals.test.ts
type Env = Record<string, string | undefined>;
export const flowSignalsOn = (env: Env = typeof process !== "undefined" ? process.env : {}) => (env.BRAIN_FLOW_SIGNALS ?? "").trim().toLowerCase() === "on";

export type FlowMsg = { sender: string; text: string | null; created_at: string };
export type FlowRoom = { name: string; sentByUs: boolean; events: ReadonlyArray<{ kind: string; at: string }> };
export type FlowSignalKind = "repeat_q" | "sent_ignored" | "sent_reacted" | "slower" | "shorter" | "emoji_gone" | "consult";
export type FlowSignals = { kinds: FlowSignalKind[]; notes: string[] };

const ms = (s: string) => Date.parse(s);
const EMOJI = /\p{Extended_Pictographic}/u;
const QUESTION = /[?？]|ですか|ますか|でしょうか|かな|どう(?:です|なり)/;
const CONSULT = /(彼氏|彼女|パートナー|相方|旦那|主人|夫|妻|嫁|婚約者|同棲(?:相手|する人)?|親|母|父|両親|家族)(?:と|に|が|も)?.{0,8}(相談|話|確認|聞いて|決め)/;
const norm = (s: string) => s.replace(/[\s、。！!？?〜~ー・「」『』（）()😊-🙏]/gu, "").replace(/(です|ます|でしょう|か|ね|よ)+$/u, "");
function bigrams(s: string): Set<string> { const t = norm(s); const o = new Set<string>(); for (let i = 0; i < t.length - 1; i++) o.add(t.slice(i, i + 2)); return o; }
function jaccard(a: Set<string>, b: Set<string>) { if (!a.size || !b.size) return 0; let n = 0; for (const x of a) if (b.has(x)) n++; return n / (a.size + b.size - n); }
const median = (xs: number[]) => { const s = [...xs].sort((a, b) => a - b); return s.length ? s[Math.floor(s.length / 2)] : 0; };

/** messages は新しい順（brain-core の typedMessages と同じ） */
export function detectFlowSignals(input: { messages: ReadonlyArray<FlowMsg>; rooms?: ReadonlyArray<FlowRoom> }): FlowSignals {
  const msgs = [...input.messages].filter((m) => !!m.created_at).sort((a, b) => ms(a.created_at) - ms(b.created_at)).slice(-60); // 古い順
  const cust = msgs.filter((m) => m.sender === "customer" && (m.text ?? "").trim() && !/^\s*\[(?:スタンプ|画像)\]\s*$/.test(m.text ?? ""));
  const kinds: FlowSignalKind[] = []; const notes: string[] = [];
  if (!cust.length) return { kinds, notes };
  // 今の番（最後の連投）
  let k = msgs.length - 1; const turn: FlowMsg[] = [];
  while (k >= 0 && msgs[k].sender === "customer") { if ((msgs[k].text ?? "").trim()) turn.unshift(msgs[k]); k--; }
  const turnText = turn.map((m) => m.text ?? "").join("\n");
  const turnStart = turn.length ? ms(turn[0].created_at) : Infinity;
  // 1. 同じ質問の繰り返し（今の番の質問が、前のお客様の質問と近い）
  if (QUESTION.test(turnText)) {
    const tq = turnText.split(/\n|。/).filter((x) => QUESTION.test(x) && norm(x).length >= 4);
    const prevQ = cust.filter((m) => ms(m.created_at) < turnStart && QUESTION.test(m.text ?? ""));
    for (const q of tq) {
      const hit = prevQ.find((p) => jaccard(bigrams(q), bigrams(p.text ?? "")) >= 0.5);
      if (hit) { kinds.push("repeat_q"); notes.push(`同じ質問の繰り返し（前にも ${(hit.created_at ?? "").slice(5, 10).replace("-", "/")} に「${(hit.text ?? "").replace(/\s+/g, " ").slice(0, 24)}」）`); break; }
    }
  }
  // 2. 送った物件への反応と無視（最後に送った束の後に、お客様の発言があるか・名前に触れたか）
  const sentRooms = (input.rooms ?? []).filter((r) => r.sentByUs).map((r) => ({ r, at: Math.max(...r.events.filter((e) => e.kind === "sent").map((e) => ms(e.at)).filter(Number.isFinite), -Infinity) })).filter((x) => Number.isFinite(x.at));
  if (sentRooms.length) {
    const lastAt = Math.max(...sentRooms.map((x) => x.at));
    const bundle = sentRooms.filter((x) => lastAt - x.at <= 30 * 60_000);
    const after = cust.filter((m) => ms(m.created_at) > lastAt);
    if (after.length) {
      const reacted = bundle.some((x) => x.r.events.some((e) => (e.kind === "customer_mentioned" || e.kind === "customer_shared") && ms(e.at) > lastAt));
      if (reacted) { kinds.push("sent_reacted"); notes.push(`送った物件（${bundle.length}件）に触れた`); }
      else { kinds.push("sent_ignored"); notes.push(`送った物件（${bundle.length}件）に触れずに${after.length}回発言`); }
    }
  }
  // 3. 返信の間隔（こちらの送信 → お客様の次の発言）が遅くなった
  const lat: number[] = [];
  for (let i = 1; i < msgs.length; i++) if (msgs[i].sender === "customer" && msgs[i - 1].sender !== "customer") lat.push(ms(msgs[i].created_at) - ms(msgs[i - 1].created_at));
  if (lat.length >= 4) {
    const last = lat[lat.length - 1], base = median(lat.slice(0, -1));
    if (last > 6 * 3_600_000 && last > 3 * Math.max(base, 600_000)) { kinds.push("slower"); notes.push(`返信の間隔が遅くなった（今回 ${Math.round(last / 3_600_000)}時間・いつもは ${Math.max(1, Math.round(base / 60_000))}分ほど）`); }
  }
  // 4. 返信が短くなった・絵文字が消えた（直近3通と、その前の10通）
  if (cust.length >= 6) {
    const recent = cust.slice(-3), before = cust.slice(-13, -3);
    const avg = (xs: FlowMsg[]) => xs.reduce((a, m) => a + (m.text ?? "").length, 0) / xs.length;
    if (before.length >= 3 && avg(recent) < 0.5 * avg(before) && avg(before) >= 20) { kinds.push("shorter"); notes.push(`返信が短くなった（平均 ${Math.round(avg(before))}字→${Math.round(avg(recent))}字）`); }
    const emoRate = (xs: FlowMsg[]) => xs.filter((m) => EMOJI.test(m.text ?? "")).length / xs.length;
    if (before.length >= 3 && emoRate(before) >= 0.5 && emoRate(recent) === 0) { kinds.push("emoji_gone"); notes.push("絵文字が消えた"); }
  }
  // 5. 相談相手の気配
  const c = [...cust].reverse().find((m) => CONSULT.test(m.text ?? ""));
  if (c) { kinds.push("consult"); notes.push(`相談相手の気配（「${(c.text ?? "").match(CONSULT)?.[0] ?? ""}」）`); }
  return { kinds, notes };
}
export const flowSignalsLine = (f: FlowSignals) => (f.notes.length ? `【会話の流れの合図（決まった計算・候補）】${f.notes.join("／")}。意味はあなたが会話から読む（合図だけで決めない）` : "");
export const flowDigest = (f: FlowSignals | null | undefined) => (f && f.kinds.length ? f.kinds.join(",") : null);
