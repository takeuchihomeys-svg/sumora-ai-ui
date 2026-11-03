// scripts/exam-answer-sets.ts — 正解の組と問題の地図（土台の8つ ④・下書き・2026-11-03 作業員1）
//   試験の問題（scripts/brain-exam/spec.json）が、見張りの場面（line_watch_turns.scene_key＝「返信:〇〇」「AIX:〇〇」）のどこを覆っているかを数え、
//   薄い場面には「竹内さん本人が送った番」（verdict_detail.staff_writer=takeuchi・判定あり）から問題の候補を出す（id と場面と道だけ・本文は出さない）。
//   候補を問題にするのは今まで通り scripts/brain-exam-add.ts（正解は人が決める）。試験の統括の --pick=map の地図を埋める元にもなる
//   読むだけ・LLM なし・費用 0。重い読み（60日の見張り）なので夜に: exam-conductor.ts --add --runner=cmd --night --label=answer-sets --cmd="scripts/exam-answer-sets.ts"
//   出力: .claude/exam-cache/answer-sets/<日付>.md / .json
import { existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { createClient } from "@supabase/supabase-js";
import { isTestConversation } from "../app/lib/test-conversations";
import { examCacheRoot } from "./lib/llm-cassette";
import { monthWordKinds } from "./lib/exam-month-words";

const sb = createClient(process.env.NEXT_PUBLIC_SUPABASE_URL ?? "", process.env.SUPABASE_SERVICE_ROLE_KEY ?? process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY ?? "");
const arg = (k: string, d = "") => process.argv.find((a) => a.startsWith(`--${k}=`))?.slice(k.length + 3) ?? d;
const DAYS = Number(arg("days", "60")), THIN = Number(arg("thin", "3")), PER = Number(arg("per", "3"));
type Turn = { id: number; conversation_id: string; customer_turn_at: string; scene_key: string | null; verdict: string | null; verdict_detail: Record<string, unknown> | null };

(async () => {
  const spec = JSON.parse(readFileSync("scripts/brain-exam/spec.json", "utf8")) as Array<{ id: string; type: string; conv: string; at: string }>;
  // 問題の番の場面: 同じ会話の見張りの番のうち、問題の時刻に一番近い番（12時間以内）
  const convs = [...new Set(spec.map((p) => p.conv))];
  const near: Turn[] = [];
  for (let i = 0; i < convs.length; i += 50) {
    const { data, error } = await sb.from("line_watch_turns").select("id, conversation_id, customer_turn_at, scene_key, verdict, verdict_detail").in("conversation_id", convs.slice(i, i + 50)).limit(5000);
    if (error) throw new Error(error.message);
    near.push(...((data ?? []) as Turn[]));
  }
  const sceneOf = new Map<string, string>();
  for (const p of spec) {
    const at = Date.parse(p.at);
    const best = near.filter((t) => t.conversation_id === p.conv).map((t) => ({ t, d: Math.abs(Date.parse(t.customer_turn_at) - at) })).sort((a, b) => a.d - b.d)[0];
    sceneOf.set(p.id, best && best.d <= 12 * 3600_000 ? best.t.scene_key ?? "（場面なし）" : "（見張りの番が無い）");
  }
  // 竹内さんの番（直近 DAYS 日・判定あり・テストの会話は除く）
  const since = new Date(Date.now() - DAYS * 86_400_000).toISOString();
  const ts: Turn[] = [];
  for (let i = 0; ; i += 1000) {
    const { data, error } = await sb.from("line_watch_turns").select("id, conversation_id, customer_turn_at, scene_key, verdict, verdict_detail").gte("customer_turn_at", since).order("id").range(i, i + 999);
    if (error) throw new Error(error.message);
    ts.push(...((data ?? []) as Turn[]));
    if ((data ?? []).length < 1000) break;
  }
  const own = ts.filter((t) => !isTestConversation(t.conversation_id) && t.verdict && t.verdict !== "na" && (t.verdict_detail ?? {}).staff_writer === "takeuchi");
  const scenes = new Map<string, { problems: string[]; takeuchi: Turn[]; all: number }>();
  const get = (s: string) => { let x = scenes.get(s); if (!x) { x = { problems: [], takeuchi: [], all: 0 }; scenes.set(s, x); } return x; };
  for (const [id, s] of sceneOf) get(s).problems.push(id);
  for (const t of ts) if (!isTestConversation(t.conversation_id) && t.verdict && t.verdict !== "na") get(t.scene_key ?? "（場面なし）").all++;
  for (const t of own) get(t.scene_key ?? "（場面なし）").takeuchi.push(t);
  const rows = [...scenes].map(([scene, x]) => ({ scene, problems: x.problems.length, all: x.all, takeuchi: x.takeuchi.length, cands: x.problems.length < THIN ? x.takeuchi.filter((t) => !spec.some((p) => p.conv === t.conversation_id && Math.abs(Date.parse(p.at) - Date.parse(t.customer_turn_at)) < 12 * 3600_000)).slice(-PER).map((t) => ({ id: t.id, conv: t.conversation_id, at: t.customer_turn_at, path: String((t.verdict_detail ?? {}).path ?? "-"), verdict: t.verdict })) : [] }))
    .sort((a, b) => b.all - a.all);
  const day = new Date(Date.now() + 9 * 3600_000).toISOString().slice(0, 10);
  const L = [`# 正解の組と問題の地図（${day}・見張りの直近 ${DAYS}日）`, "", `問題 ${spec.length}問・場面 ${rows.length}・薄い（問題 ${THIN} 未満）場面 ${rows.filter((r) => r.problems < THIN && r.all > 0).length}`, "",
    "| 場面 | 問題 | 見張りの番 | 竹内さんの番 | 候補（見張りの id・道） |", "|---|---|---|---|---|",
    ...rows.map((r) => `| ${r.scene} | ${r.problems} | ${r.all} | ${r.takeuchi} | ${r.cands.map((c) => `#${c.id}(${c.path}・${c.verdict})`).join(" ") || "-"} |`)];
  // 11/03 指揮役: 試験の時計の弱さの見張り＝月だけの言い方（入居・支払い）がある問題（共有の問題の置き場の全部の問題を読む）。新しく出たら noDateShift を付けるか決める
  const probDir = join(examCacheRoot(), "brain-exam-problems");
  const monthHits: string[] = [];
  if (existsSync(probDir)) for (const d of readdirSync(probDir)) {
    const dd = join(probDir, d);
    let txt = ""; try { for (const f of readdirSync(dd)) txt += readFileSync(join(dd, f), "utf8"); } catch { continue; }
    const k = monthWordKinds(txt);
    if (k.length) monthHits.push(`${d}（${k.join("・")}）`);
  }
  // 入居の月の言い方は条件（move_in_time）にほぼ全部ある（11/03 実測 136/189）＝数だけ。月の時計（monthClockNowIso）で読むので、同じ読みを通す決まりが増えたら見直す
  const payHits = monthHits.filter((x) => x.includes("支払い")), moveN = monthHits.filter((x) => x.includes("入居")).length;
  L.push("", `## 月だけの言い方（試験の時計の弱さ）`, `- 入居: ${moveN}問（条件の入居時期にほぼ全部ある・月の時計で直した＝数だけ）`, `- 支払い: ${payHits.length}問（payment-timing は未対応＝出たら noDateShift を付けるか決める）`, ...payHits.map((x) => `  - ${x}`));
  const out = join(examCacheRoot(), "answer-sets");
  mkdirSync(out, { recursive: true });
  writeFileSync(join(out, `${day}.md`), L.join("\n") + "\n");
  writeFileSync(join(out, `${day}.json`), JSON.stringify({ day, rows, sceneOf: Object.fromEntries(sceneOf) }, null, 1));
  console.log(L.slice(0, 40).join("\n"));
})().catch((e) => { console.error(e); process.exit(1); });
