// scripts/exam-lessons.ts — 試験の外れから統括の学び（conductor_lessons）を作る（KB 56691196・既定 off）
//
// 2026-11-21 作業員H。使い方:
//   LLM_TEST_MODE=deepseek-all npx tsx --env-file=.env.local scripts/exam-lessons.ts --label=<試験の依頼の label> [--write]
//   --write かつ CONDUCTOR_LESSONS_BUILD=on の時だけ表に書く（既定は下書きを並べるだけ）。lesson の文だけ DeepSeek（flash）・埋め込みは OpenAI。
//   正解は竹内さん本人の番だけ（問題の番の次のスタッフの通の staff_writer=takeuchi・exam-cache/problem-writers.json に控える）。
//   伏せ: 問題の写し（problems.json）は申込の手前で切って名前を伏せた物・lesson の問いにはお客様の文を渡さない（型・一手・why だけ）。
import { readFileSync, existsSync } from "node:fs";
import { join } from "node:path";
import { setupLlmTest } from "./lib/llm-test-harness";
import { examCacheRoot } from "./lib/llm-cassette";
import { atomicWriteJson } from "./lib/exam-shared-file";
import { buildLessonDrafts, lessonPrompt, cleanLesson, lessonsBuildOn, type LessonRow, type LessonProblem } from "./lib/exam-lessons";

const args = process.argv.slice(2);
const arg = (k: string) => args.find((a) => a.startsWith(`--${k}=`))?.slice(k.length + 3) ?? "";
const LABEL = arg("label");
const WRITE = args.includes("--write") && lessonsBuildOn();
const ROOT_DIR = arg("root") || "."; // 答案と問題を読む作業ツリー（既定は今の所）
const RESULTS = join(ROOT_DIR, "scripts/brain-exam/results");

async function main() {
  if (!LABEL) throw new Error("--label=<試験の依頼の label> が要る");
  // 2026-11-23 作業員L（conductor_lessons が0行の調べ）: service の鍵が無いと supabase-server は公開キーに落ち、表の RLS で「書けない」の警告だけで0行のまま続いた → 書く時は先に止める
  if (WRITE) { const { lessonWriteKeyProblem } = await import("./lib/conductor-lessons-write"); const p = lessonWriteKeyProblem(process.env); if (p) throw new Error(p); }
  const h = await setupLlmTest(`exam-lessons-${LABEL}`.slice(0, 60));
  try {
    const { supabase } = await import("../app/lib/supabase-server");
    const rows = readFileSync(join(RESULTS, `${LABEL}.jsonl`), "utf8").trim().split("\n").filter(Boolean).map((l) => JSON.parse(l) as LessonRow);
    const spec = JSON.parse(readFileSync(join(ROOT_DIR, "scripts/brain-exam/spec.json"), "utf8")) as Array<LessonProblem & { at: string }>;
    const probs = existsSync(join(ROOT_DIR, "scripts/brain-exam/problems.json")) ? (JSON.parse(readFileSync(join(ROOT_DIR, "scripts/brain-exam/problems.json"), "utf8")) as Array<{ id: string; customer?: string }>) : [];
    const custOf = new Map(probs.map((p) => [p.id, p.customer ?? ""]));
    const ids = [...new Set(rows.map((r) => r.id))];
    // 竹内さん本人の番か（控え: 会話×時刻 → 書き手）
    const cacheF = join(examCacheRoot(), "problem-writers.json");
    const cache = existsSync(cacheF) ? (JSON.parse(readFileSync(cacheF, "utf8")) as Record<string, string>) : {};
    const takeuchi = new Set<string>();
    for (const id of ids) {
      const p = spec.find((x) => x.id === id); if (!p) continue;
      const key = `${p.conv}@${p.at}`;
      if (!(key in cache)) {
        const { data } = await supabase.from("messages").select("staff_writer").eq("conversation_id", p.conv).neq("sender", "customer").gte("created_at", p.at).order("created_at").limit(1);
        cache[key] = String(((data ?? [])[0] as { staff_writer?: string } | undefined)?.staff_writer ?? "unknown");
      }
      if (cache[key] === "takeuchi") takeuchi.add(id);
    }
    atomicWriteJson(cacheF, cache, true);
    const drafts = buildLessonDrafts(LABEL, rows, spec.map((p) => ({ ...p, customer: custOf.get(p.id) ?? "" })), takeuchi);
    console.log(`学びの下書き ${drafts.length}件（外れ・竹内さんの番だけ・問題 ${ids.length}・竹内さんの番 ${takeuchi.size}）${WRITE ? "" : "（書かない: --write と CONDUCTOR_LESSONS_BUILD=on の時だけ書く）"}`);
    if (!drafts.length) return;
    // 2026-11-23 作業員H（統括役・L の bd3736e2a と同じ形）: api.deepseek.com を直に叩いていて llm_usage_logs に残らなかった（費用の記録の穴）
    //   → 本番と同じ口（vision-alt-provider.callDeepSeek・推論なし）で呼び、本番と同じ費用の記録（llm-usage-recorder.recordAltUsage）に1行ずつ残す
    const [{ callDeepSeek }, { DEEPSEEK_FLASH_MODEL }, { recordAltUsage }] = await Promise.all([import("../app/lib/vision-alt-provider"), import("../app/lib/llm-alt-provider"), import("../app/lib/llm-usage-recorder")]);
    const model = String(process.env.LESSON_MODEL ?? DEEPSEEK_FLASH_MODEL).trim();
    const { embedTexts } = await import("../app/lib/design-knowledge-rag-server");
    for (const d of drafts) {
      let lesson: string | null = null;
      const t0 = Date.now();
      const res = await callDeepSeek(null, lessonPrompt(d), { model, maxTokens: 400, timeoutMs: 60_000, thinking: false, temperature: 0 }).catch(() => null);
      if (res) {
        lesson = cleanLesson(res.text);
        recordAltUsage({ model: res.model, action: "exam_lesson", conversationId: null,
          usage: { input_tokens: Math.max(0, res.usage.input - res.usage.cacheHit), output_tokens: res.usage.output, cache_read_input_tokens: res.usage.cacheHit },
          status: 200, errorType: lesson ? null : "dropped", durationMs: Date.now() - t0, sysHead: "【試験の外れの学び】exam-lessons", sysKeyFull: null, maxTokens: 400 });
      }
      console.log(`- ${d.source}｜${d.scene ?? "-"}｜竹内 ${d.expected_act} ／ こちら ${d.got_act ?? "-"}｜段 ${d.changed_stage ?? "-"}｜${d.miss_kind ?? "要確認"}｜${lesson ?? "（学びの文を作れない）"}`);
      if (!WRITE || !lesson) continue;
      const emb = (await embedTexts([d.situation_text])).vectors[0];
      if (!emb) { console.warn("  埋め込みが作れない→書かない"); continue; }
      const { data: cur } = await supabase.from("conductor_lessons").select("id, hits").eq("dedupe_key", d.dedupe_key).maybeSingle();
      const { seed: _seed, ...row } = d;
      void _seed;
      const r = cur
        ? await supabase.from("conductor_lessons").update({ hits: (Number((cur as { hits?: number }).hits) || 1) + 1, lesson, source: d.source, updated_at: new Date().toISOString(), is_current: true }).eq("id", (cur as { id: string }).id)
        : await supabase.from("conductor_lessons").insert({ ...row, lesson, embedding: emb });
      if (r.error) console.warn(`  書けない: ${r.error.message}`);
    }
  } finally {
    await h.finish();
  }
}
main().catch((e) => { console.error(e instanceof Error ? e.message : e); process.exitCode = 1; });
