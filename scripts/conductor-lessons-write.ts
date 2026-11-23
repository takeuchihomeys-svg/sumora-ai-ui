// scripts/conductor-lessons-write.ts — 見た学びの下書きを統括の学び（conductor_lessons）に書く（2026-11-23 作業員L・統括役の頼み）
//   入力: 下書きの json（scripts/prod-lessons.ts の exam-cache/prod-lessons/<日>.json の drafts、か同じ形の配列。lesson が要る）
//   実行: npx tsx --env-file=.env.local scripts/conductor-lessons-write.ts --json=<下書き> [--only=<dedupe_key,…>]          … 書く行を全部並べるだけ
//         npx tsx --env-file=.env.local scripts/conductor-lessons-write.ts --json=<下書き> [--only=…] --write                … 書く（埋め込みは OpenAI・1行1回）
//   service の鍵が無い時は書かずに止まる（公開キーは RLS で落ちる）。同じ dedupe_key の行があれば lesson・hits を更新する。
//   ⚠ 表に1行でも入ると、本番のブレインの入口が番ごとに学びを読む（CONDUCTOR_LESSONS 既定 shadow＝埋め込み1回＋RPC・材料には渡さない）
import { readFileSync } from "node:fs";
import { createClient } from "@supabase/supabase-js";
import { lessonRowProblems, lessonInsertRow, lessonWriteKeyProblem, type LessonToWrite } from "./lib/conductor-lessons-write";

const args = process.argv.slice(2);
const arg = (k: string) => args.find((a) => a.startsWith(`--${k}=`))?.slice(k.length + 3) ?? "";
(async () => {
  if (!arg("json")) throw new Error("--json=<下書き> が要る");
  const raw = JSON.parse(readFileSync(arg("json"), "utf8")) as LessonToWrite[] | { drafts: LessonToWrite[] };
  let rows = Array.isArray(raw) ? raw : raw.drafts ?? [];
  const only = arg("only") ? new Set(arg("only").split(",")) : null;
  if (only) rows = rows.filter((r) => only.has(r.dedupe_key));
  let bad = 0;
  for (const r of rows) {
    const p = lessonRowProblems(r);
    if (p.length) bad++;
    console.log(`${p.length ? "✗" : "○"} ${r.dedupe_key}｜${r.source}｜${r.scene ?? "-"}｜竹内 ${r.expected_act} ／ こちら ${r.got_act ?? "-"}｜${r.miss_kind ?? "-"}｜${r.lesson}${p.length ? `｜書けない: ${p.join("・")}` : ""}`);
  }
  console.log(`行 ${rows.length}・書けない ${bad}`);
  if (!args.includes("--write")) { console.log("（書いていない。行を全部見てから --write）"); return; }
  const keyProblem = lessonWriteKeyProblem(process.env);
  if (keyProblem) throw new Error(keyProblem);
  if (bad) throw new Error("書けない行がある（直すか --only で外す）");
  const sb = createClient(process.env.NEXT_PUBLIC_SUPABASE_URL ?? "", process.env.SUPABASE_SERVICE_ROLE_KEY ?? "", { auth: { persistSession: false } });
  const { embedTexts } = await import("../app/lib/design-knowledge-rag-server");
  let ok = 0;
  for (const r of rows) {
    const emb = (await embedTexts([r.situation_text])).vectors[0];
    if (!emb) { console.log(`  埋め込みが作れない→書かない ${r.dedupe_key}`); continue; }
    const { data: cur } = await sb.from("conductor_lessons").select("id, hits").eq("dedupe_key", r.dedupe_key).maybeSingle();
    const res = cur
      ? await sb.from("conductor_lessons").update({ lesson: r.lesson, hits: (Number((cur as { hits?: number }).hits) || 1) + 1, updated_at: new Date().toISOString(), is_current: true }).eq("id", (cur as { id: string }).id)
      : await sb.from("conductor_lessons").insert({ ...lessonInsertRow(r), embedding: JSON.stringify(emb) });
    if (res.error) console.log(`  書けない ${r.dedupe_key}: ${res.error.message}`); else ok++;
  }
  const { count } = await sb.from("conductor_lessons").select("id", { count: "exact", head: true }).eq("is_current", true);
  console.log(`書いた ${ok}/${rows.length}・表の今の行 ${count ?? "?"}`);
})().catch((e) => { console.error(e instanceof Error ? e.message : String(e)); process.exit(1); });
