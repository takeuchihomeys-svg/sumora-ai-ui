// scripts/audit-emoji-scene-rates.ts — 絵文字の場面ごとの「絵文字なし」の割合: スタッフの手打ち／AI の下書き（出口の前）／AI の下書き（出口の後）（読むだけ・LLM なし）
// 2026-10-02 竹内「スタッフのを基に構成する」（絵文字を外す割合を一律にしない）:
//   場面は app/lib/emoji-situational.ts emojiSceneOf（下書きの出口と同じ関数）。
//   スタッフ: ai_reply_examples line_reply の手打ち（AI の下書きを使っていない・6/15〜）／2通目だけ messages の「手打ちの10分以内に続けた手打ち」
//   AI: 同じ期間の AI の下書き（ai_draft）を出口 applySituationalEmoji に通す前と後
//   --json で EMOJI_SCENE_RATES に貼る形も出す
// 実行: npx tsx --env-file=.env.local scripts/audit-emoji-scene-rates.ts [--since=2026-06-15] [--json]
import { createClient } from "@supabase/supabase-js";
import { emojiSceneOf, applySituationalEmoji, EMOJI_SCENE_RATES, type EmojiScene } from "../app/lib/emoji-situational";
import { isTestConversation } from "../app/lib/test-conversations";
import { draftToSendableText } from "../app/lib/draft-text";

const SINCE = process.argv.find((a) => a.startsWith("--since="))?.slice(8) ?? "2026-06-15";
const sb = createClient(process.env.NEXT_PUBLIC_SUPABASE_URL!, process.env.SUPABASE_SERVICE_ROLE_KEY ?? process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY!);
const EMO = /\p{Extended_Pictographic}/u;
async function readAll<T>(q: (f: number, t: number) => PromiseLike<{ data: unknown; error: { message: string } | null }>): Promise<T[]> {
  const out: T[] = [];
  for (let i = 0; ; i += 1000) { const r = await q(i, i + 999); if (r.error) throw new Error(r.error.message); const d = (r.data ?? []) as T[]; out.push(...d); if (d.length < 1000) break; }
  return out;
}
type Cnt = { n: number; no: number };
const add = (m: Map<EmojiScene, Cnt>, s: EmojiScene, no: boolean) => { const c = m.get(s) ?? { n: 0, no: 0 }; c.n++; if (no) c.no++; m.set(s, c); };
const pct = (c?: Cnt) => (c && c.n ? `${(c.no / c.n * 100).toFixed(0)}%` : "—");

async function main() {
  const ex = await readAll<{ conversation_id: string; ai_draft: string | null; sent_reply: string | null; was_ai_used: boolean | null }>((f, t) => sb.from("ai_reply_examples").select("conversation_id, ai_draft, sent_reply, was_ai_used").eq("entry_source", "line_reply").gte("created_at", SINCE).range(f, t));
  const staff = new Map<EmojiScene, Cnt>(), aiBefore = new Map<EmojiScene, Cnt>(), aiAfter = new Map<EmojiScene, Cnt>();
  for (const r of ex) {
    if (isTestConversation(r.conversation_id)) continue;
    if (r.was_ai_used === false && r.sent_reply && !/【お申込者様記入欄】|（ご希望のお部屋探しご条件）/.test(r.sent_reply)) add(staff, emojiSceneOf(r.sent_reply), !EMO.test(r.sent_reply));
    const d = draftToSendableText(r.ai_draft);
    if (d) {
      const sc = emojiSceneOf(d);
      add(aiBefore, sc, !EMO.test(d));
      add(aiAfter, sc, !EMO.test(applySituationalEmoji(d, { seed: r.conversation_id }).text));
    }
  }
  // 2通目（連投の位置は messages にしか無い）: こちらの手打ちの10分以内に続けた手打ち
  const msgs = await readAll<{ conversation_id: string; sender: string; created_at: string; text: string | null; is_aix_generated: boolean | null }>((f, t) => sb.from("messages").select("conversation_id, sender, created_at, text, is_aix_generated").gte("created_at", SINCE).order("conversation_id").order("created_at").range(f, t));
  for (let i = 1; i < msgs.length; i++) {
    const m = msgs[i], p = msgs[i - 1];
    if (m.sender !== "staff" || m.is_aix_generated || !m.text || isTestConversation(m.conversation_id) || p.conversation_id !== m.conversation_id) continue;
    if (p.sender !== "staff" || p.is_aix_generated || Date.parse(m.created_at) - Date.parse(p.created_at) > 10 * 60_000) continue;
    if (/^\[(?:画像|動画|スタンプ|ファイル|通話)/.test(m.text)) continue;
    const sc = emojiSceneOf(m.text, { afterStaffSend: true });
    if (sc === "second_message") add(staff, sc, !EMO.test(m.text));
  }
  console.log(`=== 絵文字なしの割合（${SINCE}〜）: 場面｜スタッフの手打ち｜AI の下書き（出口の前）｜AI の下書き（出口の後）｜表の値`);
  const scenes = Object.keys(EMOJI_SCENE_RATES) as EmojiScene[];
  for (const s of scenes) {
    console.log(`  ${EMOJI_SCENE_RATES[s].ja.padEnd(14, "　")}｜ ${pct(staff.get(s)).padStart(4)}（${staff.get(s)?.n ?? 0}）｜ ${pct(aiBefore.get(s)).padStart(4)}（${aiBefore.get(s)?.n ?? 0}）｜ ${pct(aiAfter.get(s)).padStart(4)}｜ ${Math.round(EMOJI_SCENE_RATES[s].rate * 100)}%`);
  }
  const tot = (m: Map<EmojiScene, Cnt>) => [...m.values()].reduce((a, c) => ({ n: a.n + c.n, no: a.no + c.no }), { n: 0, no: 0 });
  const st = tot(staff); const sec = staff.get("second_message"); const stNo2 = { n: st.n - (sec?.n ?? 0), no: st.no - (sec?.no ?? 0) };
  console.log(`  全体（2通目を除く）｜ ${pct(stNo2)}（${stNo2.n}）｜ ${pct(tot(aiBefore))}（${tot(aiBefore).n}）｜ ${pct(tot(aiAfter))}`);
  if (process.argv.includes("--json")) {
    const o: Record<string, unknown> = {};
    for (const s of scenes) { const c = staff.get(s); const b = aiBefore.get(s); o[s] = { staff: c ? +(c.no / c.n).toFixed(2) : null, n: c?.n ?? 0, aiBefore: b ? +(b.no / b.n).toFixed(2) : null }; }
    console.log(JSON.stringify(o));
  }
}
main().catch((e) => { console.error(e); process.exit(1); });
