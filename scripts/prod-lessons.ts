// scripts/prod-lessons.ts — 本番の外れ（自己改善の芯④ check-conductor・竹内さん本人の番）から統括の学びの下書きを作る（DB に書かない・既定は LLM なし）
//
// 2026-11-22 作業員L（台帳 #433 の案 B・統括役の決め・KB 56691196）:
//   ① check-conductor（作業員N）で直近の竹内さんの番の外れ（返信か AIX かの取り違え・種類違い・中身違い）を取る
//   ② 申込の門（turn-application-gate）で申込以降の番を外す・お客様の文と竹内さんの文は名前を伏せる（maskExamText）
//   ③ 学びの下書き（scripts/lib/exam-lessons.ts と同じ形）を exam-cache/prod-lessons/<日付>.json に置く。conductor_lessons には書かない
//      （統括役が試験の下書きと一緒に見て書く・案 E）
//   ④ --llm の時だけ、lesson（型となぜの1行）を DeepSeek（flash）で足す。夜（JST 22時〜翌8時）だけ・LLM_TEST_MODE=deepseek-all で起動（手順書 memory/test_protocol_brain.md）
//   2026-11-22 統括役の頼み: ①場面（line_watch_turns.scene_key）を渡す ②竹内さんの返信とこちらの下書き（draft_last）の要点を伏せて両方渡す
//     ③ DeepSeek は本番と同じ口（vision-alt-provider.callDeepSeek）で呼び、本番と同じ費用の記録（llm-usage-recorder.recordAltUsage）に1行ずつ残す
//     （初版は api.deepseek.com を直に叩き llm_usage_logs に残らなかった＝費用の記録の穴）
// 実行: npx tsx --env-file=.env.local scripts/prod-lessons.ts [--days=7] [--max=40] [--llm]
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { createClient } from "@supabase/supabase-js";
import { checkConductor, type MissType } from "./check-conductor";
import { prodLessonDraft, dedupeDrafts, isNightJst, prodLessonPrompt, keepProdLesson, type ProdCause, type ProdMissTurn } from "./lib/prod-lessons";
import { cleanLesson, type LessonDraft } from "./lib/exam-lessons";
import { examCacheRoot } from "./lib/llm-cassette";
import { maskExamText, addressNamesOf } from "../app/lib/text-mask-names";
import { loadTurnApplicationRecords } from "../app/lib/turn-application-gate-server";
import { turnApplicationReason } from "../app/lib/turn-application-gate";

const args = process.argv.slice(2);
const arg = (k: string, d: string) => args.find((a) => a.startsWith(`--${k}=`))?.slice(k.length + 3) ?? d;
const DAYS = Number(arg("days", "7")) || 7, MAX = Number(arg("max", "40")) || 40, LLM = args.includes("--llm");

type W = { id: number; conversation_id: string; customer_turn_at: string; staff_first_at: string | null; brain_reply_mode: string | null; brain_action: string | null; scene_key: string | null; draft_last: string | null;
  verdict_detail: { staff_writer?: string; staff_aix?: string[] | null; reason?: string; facts?: { staffOnly?: string[]; conflict?: string[] } | null } | null };
type Msg = { sender: string; text: string | null; created_at: string; is_aix_generated: boolean | null; staff_writer: string | null };

const causeOf = (type: MissType, vd: W["verdict_detail"]): ProdCause =>
  type === "reply_not_aix" ? "aix_turn_as_reply" : type === "reply_content" && (vd?.reason === "fact_conflict" || (vd?.facts?.staffOnly ?? []).length > 0 || (vd?.facts?.conflict ?? []).length > 0) ? "material" : "misread";

async function main() {
  if (LLM && !isNightJst()) throw new Error("--llm は夜（JST 22時〜翌8時）だけ（試験の時間の決まり）");
  const h = LLM ? await (await import("./lib/llm-test-harness")).setupLlmTest("prod-lessons") : null;
  try {
    const sb = createClient(process.env.NEXT_PUBLIC_SUPABASE_URL ?? "", process.env.SUPABASE_SERVICE_ROLE_KEY ?? "", { auth: { persistSession: false } });
    const cc = await checkConductor(DAYS);
    const typeOf = new Map<number, MissType>();
    for (const [t, xs] of Object.entries(cc.ids)) for (const x of xs) typeOf.set(x, t as MissType);
    const ids = [...typeOf.keys()].slice(0, MAX);
    console.log(`芯④の外れ（${DAYS}日・竹内さんの番 ${cc.n}・外れ ${typeOf.size}）→ 読む ${ids.length}`);
    if (!ids.length) return;
    const { data, error } = await sb.from("line_watch_turns").select("id,conversation_id,customer_turn_at,staff_first_at,brain_reply_mode,brain_action,scene_key,draft_last,verdict_detail").in("id", ids);
    if (error) throw new Error(error.message);
    const gate = new Map<string, Awaited<ReturnType<typeof loadTurnApplicationRecords>>>();
    const drafts: LessonDraft[] = [];
    const heads = new Map<string, { scene: string | null; staff: string | null; draft: string | null }>();
    let gated = 0, notTakeuchi = 0;
    for (const w of (data ?? []) as W[]) {
      if (!gate.has(w.conversation_id)) gate.set(w.conversation_id, await loadTurnApplicationRecords(sb, w.conversation_id));
      if (turnApplicationReason(gate.get(w.conversation_id), w.customer_turn_at)) { gated++; continue; } // 申込以降の番は渡さない
      if (w.verdict_detail?.staff_writer !== "takeuchi") { notTakeuchi++; continue; }
      const lo = new Date(Date.parse(w.customer_turn_at) - 12 * 36e5).toISOString(), hi = new Date(Date.parse(w.staff_first_at ?? w.customer_turn_at) + 30 * 60_000).toISOString();
      const [{ data: ms }, { data: cv }, { data: dl }] = await Promise.all([
        sb.from("messages").select("sender,text,created_at,is_aix_generated,staff_writer").eq("conversation_id", w.conversation_id).gte("created_at", lo).lte("created_at", hi).order("created_at").limit(60),
        sb.from("conversations").select("customer_name").eq("id", w.conversation_id).maybeSingle(),
        sb.from("brain_decision_logs").select("digest").eq("conversation_id", w.conversation_id).lte("created_at", w.staff_first_at ?? w.customer_turn_at).order("created_at", { ascending: false }).limit(1),
      ]);
      const msgs = (ms ?? []) as Msg[];
      const names = addressNamesOf(msgs.filter((m) => m.sender !== "customer").map((m) => m.text ?? ""));
      const mask = (s: string | null) => maskExamText(s, ((cv as { customer_name?: string | null } | null)?.customer_name) ?? null, names);
      const t0 = Date.parse(w.customer_turn_at);
      const cust: string[] = [];
      for (const m of [...msgs].reverse()) { if (Date.parse(m.created_at) > t0 + 60_000) continue; if (m.sender !== "customer") { if (cust.length) break; continue; } cust.unshift(m.text ?? ""); if (cust.length >= 4) break; }
      const staff = msgs.find((m) => m.sender !== "customer" && !m.is_aix_generated && m.staff_writer === "takeuchi" && Date.parse(m.created_at) >= t0);
      const dg = ((dl ?? [])[0] as { digest?: Record<string, unknown> } | undefined)?.digest ?? {};
      const type = typeOf.get(w.id)!;
      const t: ProdMissTurn = {
        watchId: w.id, conv: w.conversation_id, at: w.customer_turn_at, type, cause: causeOf(type, w.verdict_detail),
        staffWriter: w.verdict_detail?.staff_writer ?? null, staffAix: (w.verdict_detail?.staff_aix ?? []).filter(Boolean) as string[],
        brainMode: w.brain_reply_mode, brainAction: w.brain_action,
        stage: typeof dg.sg === "string" ? dg.sg : null, scene: w.scene_key ?? null, mood: null,
        customerMasked: mask(cust.join("\n")).slice(0, 300), staffHeadMasked: staff ? mask(staff.text).replace(/\s+/g, " ").slice(0, 120) : null,
        draftHeadMasked: w.draft_last ? mask(w.draft_last).replace(/\s+/g, " ").slice(0, 120) : null,
      };
      const d = prodLessonDraft(t);
      if (d) { drafts.push(d); heads.set(d.dedupe_key, { scene: t.scene, staff: t.staffHeadMasked, draft: t.draftHeadMasked ?? null }); }
    }
    const out = dedupeDrafts(drafts);
    console.log(`下書き ${out.length}（申込の門で外した ${gated}・竹内さん以外 ${notTakeuchi}）${LLM ? "・lesson を DeepSeek で足す" : "・lesson なし（--llm は夜）"}`);
    const withLesson: Array<LessonDraft & { lesson: string | null }> = [];
    for (const d of out) {
      let lesson: string | null = null;
      if (LLM) {
        const hd = heads.get(d.dedupe_key) ?? { scene: d.scene, staff: null, draft: null };
        const [{ callDeepSeek }, { DEEPSEEK_FLASH_MODEL }, { recordAltUsage }] = await Promise.all([import("../app/lib/vision-alt-provider"), import("../app/lib/llm-alt-provider"), import("../app/lib/llm-usage-recorder")]);
        const t0 = Date.now();
        const res = await callDeepSeek(null, prodLessonPrompt(d, { sceneJa: hd.scene, staffHead: hd.staff, draftHead: hd.draft }), { model: String(process.env.LESSON_MODEL ?? DEEPSEEK_FLASH_MODEL).trim(), maxTokens: 400, timeoutMs: 60_000, thinking: false, temperature: 0 }).catch(() => null);
        if (res) {
          lesson = keepProdLesson(cleanLesson(res.text));
          recordAltUsage({ model: res.model, action: "prod_lesson", conversationId: null,
            usage: { input_tokens: Math.max(0, res.usage.input - res.usage.cacheHit), output_tokens: res.usage.output, cache_read_input_tokens: res.usage.cacheHit },
            status: 200, errorType: lesson ? null : "dropped", durationMs: Date.now() - t0, sysHead: "【本番の外れの学び】prod-lessons", sysKeyFull: null, maxTokens: 400 });
        }
      }
      withLesson.push({ ...d, lesson });
      console.log(`- ${d.source}｜${d.stage ?? "-"}｜竹内 ${d.expected_act} ／ こちら ${d.got_act ?? "-"}｜${d.miss_kind ?? "要確認"}｜${lesson ?? "（lesson なし）"}`);
    }
    const dir = join(examCacheRoot(), "prod-lessons");
    mkdirSync(dir, { recursive: true });
    const f = join(dir, `${new Date(Date.now() + 9 * 36e5).toISOString().slice(0, 10)}.json`);
    writeFileSync(f, JSON.stringify({ at: new Date().toISOString(), days: DAYS, n: cc.n, drafts: withLesson.map(({ seed: _s, ...r }) => r) }, null, 1));
    console.log(`置いた: ${f}（conductor_lessons には書かない・統括役が見て書く）`);
  } finally {
    if (h) await h.finish();
  }
}
main().catch((e) => { console.error(e instanceof Error ? e.message : e); process.exitCode = 1; });
