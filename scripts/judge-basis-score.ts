// scripts/judge-basis-score.ts — 重点の物差し＋判断の根拠のメモの物差し（AI を呼ばない・費用0。--prod の時だけ DB を読む）
//
// 2026-11-12 作業員17。試験の答案（scripts/brain-exam/results/<label>.jsonl）と問題の spec から、
//   竹内さんがその番で一番大切にした事（重点）とブレインの重点の当たり・外れた段（読み・選び・深さ・優先・重点・順番・道）・選んだ順番が竹内さんと合ったかを、場面別・深さ別に出す。
//   正解の足し方: spec.json の問題に "basis": {"focus":"answer|promise_make|promise_keep|ease|close|propose|relation","priority":["answer_question",…],"depth":"shallow|normal|deep","order":["judge","fetch",…],"by":"誰が・いつ・どの番から"} を足す
//     （型の名前は app/lib/judge-basis-types.ts の1か所。人が付けた物は source=human・無い問題は accept の AIX 型から重点だけ推定）。
//     決まり: ① 竹内さんの実際の番（送った文・AIX の種類）を読んで人が付ける（AI の推測だけで付けない）② 申込の門より前の番だけ ③ by に根拠の番号を書く ④ 迷う番は付けずに空にする（推定に任せる）
// 2026-11-15 作業員L（統括の土台①）: 本番の記録でも数える（--prod）。BRAIN_JUDGE_BASIS=shadow の番は brain_decision_logs.digest.jbr に判断の根拠の短い形が残る。
//   正解はスタッフが窓（次の判断か24時間）の中で押した AIX から重点だけ推定・道はブレインの AIX と押した AIX が同じか（brain-aix-feedback.pairBrainDecisions）。
//   答案は judge_basis（on）・judge_basis_rec（shadow）・jbr（本番の短い形）のどれでも読む。
// 実行: npx tsx scripts/judge-basis-score.ts --results=<jsonl かフォルダ,…> [--spec=scripts/brain-exam/spec.json] [--json=<出力>] [--show]
//       npx tsx --env-file=.env.local scripts/judge-basis-score.ts --prod [--days=7] [--conv=<会話 id>] [--json=<出力>] [--show]
//       （--prod は jbr のある判断の行と、その会話の押した AIX だけを読む。営業時間の全件読みはしない＝日数と行数に上限 --max=2000）
import { readFileSync, readdirSync, statSync, existsSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { buildReport, formatReport, prodRowsOf, type AnswerRow, type SpecLite, type ProdPair } from "./lib/judge-basis-score";

const args = process.argv.slice(2);
const arg = (k: string, d = "") => args.find((a) => a.startsWith(`--${k}=`))?.slice(k.length + 3) ?? d;
const ROOT = resolve(__dirname, "..");

async function loadProd(): Promise<{ specs: SpecLite[]; rows: AnswerRow[]; note: string }> {
  const { createClient } = await import("@supabase/supabase-js");
  const { pairBrainDecisions } = await import("../app/lib/brain-aix-feedback");
  const sb = createClient(process.env.NEXT_PUBLIC_SUPABASE_URL ?? "", process.env.SUPABASE_SERVICE_ROLE_KEY ?? process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY ?? "");
  const days = Number(arg("days", "7")) || 7, max = Number(arg("max", "2000")) || 2000;
  const since = new Date(Date.now() - days * 86_400_000).toISOString();
  let q = sb.from("brain_decision_logs").select("id, conversation_id, created_at, suggested_action, suggested_check_pattern, decision_source, scene_evidence, digest")
    .gte("created_at", since).not("digest->jbr", "is", null).order("created_at", { ascending: true }).limit(max);
  if (arg("conv")) q = q.eq("conversation_id", arg("conv"));
  const { data: decs, error } = await q;
  if (error) throw new Error(`brain_decision_logs: ${error.message}`);
  const list = (decs ?? []) as Array<{ id: string; conversation_id: string; created_at: string; suggested_action: string | null; suggested_check_pattern: string | null; decision_source: string | null; scene_evidence: string | null; digest: Record<string, unknown> | null }>;
  const convs = [...new Set(list.map((d) => d.conversation_id))];
  const presses: Array<{ conversation_id: string; aix_type: string | null; check_pattern: string | null; created_at: string }> = [];
  for (let i = 0; i < convs.length; i += 50) {
    const { data, error: e2 } = await sb.from("aix_usage_logs").select("conversation_id, aix_type, check_pattern, created_at").in("conversation_id", convs.slice(i, i + 50)).gte("created_at", since).limit(5000);
    if (e2) throw new Error(`aix_usage_logs: ${e2.message}`);
    presses.push(...((data ?? []) as typeof presses));
  }
  const paired = pairBrainDecisions(list, presses);
  const byId = new Map(list.map((d) => [d.id, d]));
  const sceneOf = (s: string | null) => { try { return s ? ((JSON.parse(s) as { scene?: string }).scene ?? null) : null; } catch { return null; } };
  const pairs: ProdPair[] = paired.map((p) => ({ id: p.decision.id, scene: sceneOf(p.decision.scene_evidence ?? null), jbr: byId.get(p.decision.id)?.digest?.jbr ?? null, pressAix: p.press?.aix_type ?? null, matched: p.matched, pending: p.pending }));
  const r = prodRowsOf(pairs);
  return { specs: r.specs, rows: r.rows, note: `本番の記録 ${days}日・jbr のある判断 ${list.length} 行（会話 ${convs.length}）・判定保留 ${r.pending}・押した AIX ${presses.length}` };
}

async function main() {
  let specs: SpecLite[], rows: AnswerRow[], head: string;
  if (args.includes("--prod")) {
    const p = await loadProd();
    specs = p.specs; rows = p.rows; head = p.note;
  } else {
    const specRaw = JSON.parse(readFileSync(resolve(ROOT, arg("spec", "scripts/brain-exam/spec.json")), "utf8")) as unknown;
    specs = (Array.isArray(specRaw) ? specRaw : Object.values(specRaw as object)) as SpecLite[];
    const files: string[] = [];
    for (const p of arg("results", "").split(",").filter(Boolean)) {
      const abs = resolve(process.cwd(), p);
      const abs2 = existsSync(abs) ? abs : resolve(ROOT, p);
      if (!existsSync(abs2)) { console.error(`無い: ${p}`); continue; }
      if (statSync(abs2).isDirectory()) for (const f of readdirSync(abs2)) { if (f.endsWith(".jsonl")) files.push(join(abs2, f)); } else files.push(abs2);
    }
    if (!files.length) { console.error("--results=<jsonl かフォルダ> か --prod を指定してください"); process.exit(1); }
    rows = files.flatMap((f) => readFileSync(f, "utf8").split("\n").filter(Boolean).flatMap((l) => { try { return [JSON.parse(l) as AnswerRow]; } catch { return []; } }));
    head = `答案 ${files.length} ファイル・${rows.length} 行`;
  }
  const rep = buildReport(specs, rows);
  console.log(head);
  console.log(formatReport(rep));
  if (args.includes("--show")) for (const v of rep.verdicts.filter((x) => x.missStage)) console.log(`${v.id}#${v.rep} 外れた段=${v.missStage} 重点=${v.focusHit} 優先=${v.priorityHit} 深さ=${v.depthHit} 順番=${v.orderExact}/${v.orderHead} 道=${v.pathOk}`);
  if (arg("json")) writeFileSync(resolve(process.cwd(), arg("json")), JSON.stringify(rep, null, 1));
}
main().catch((e) => { console.error(e instanceof Error ? e.message : String(e)); process.exit(1); });
