// scripts/self-improve.ts — 自己改善の統括の毎朝の1枚（LLM なし・作業員N・2026-11-21・台帳 #473）
//
// 竹内さん 11/21「自己改善できるように、そこを統括するものも作る。俺からの指示や思考がそこで構築され自動化される仕組み」。
//   memory/self_improve_cycle_1121.md のサイクルを毎朝1回、決まった計算で回す（統括役が手で回していた物の自動化）。新しい Vercel の cron は足さない＝毎朝の見回りから呼ぶ。
//   1 方針: 竹内さんの指摘（owner_pointers・閉じていない行）を型と分野で重み付け（7日以内は2倍）→ 今の重点の型・分野
//   2 外れ: 前の日（JST）の本番の物差し（line_watch_turns の一致・AIX の最初の一手の一致・竹内さんの番／全体）・重点の型の点検（owner-feedback-check）・試験（exam_runs の前の24時間）
//   3 組む: ①直しの候補（点検の穴）②今夜の試験の候補（指摘の直し中の問題・悪化0待ちのスイッチ）③on の候補（passed）④竹内さんへの確認（owner_questions の open・KB の下書き）
//   4 出す: memory/self_improve_daily/<日>.md・quality_daily（--write）・cron_run_logs（cron_name=self-improve）
//   5 学ぶ: 方針は毎回 owner_pointers から作る＝竹内さんの新しい指摘が入れば次の朝に自動で変わる
// 実行: npx tsx --env-file=.env.local scripts/self-improve.ts [--day=2026-11-20] [--write] [--out=<md>]
import { createClient } from "@supabase/supabase-js";
import { writeFileSync, mkdirSync } from "node:fs";
import { dirname } from "node:path";
import { POINTER_KIND_JA, type PointerKind } from "../app/lib/owner-pointers";
import { pointersForExam } from "../app/lib/owner-pointers-server";
import { LINKAGE_SWITCH_DEFAULTS } from "../app/lib/linkage-switch-defaults";
import { runChecks } from "./owner-feedback-check";
import { isTestConversation, isNoLineTestConversation } from "../app/lib/test-conversations";

const argv = process.argv.slice(2);
const arg = (k: string, d = "") => argv.find((a) => a.startsWith(`--${k}=`))?.slice(k.length + 3) ?? d;
const flag = (k: string) => argv.includes(`--${k}`);
const sb = createClient(process.env.NEXT_PUBLIC_SUPABASE_URL ?? "", process.env.SUPABASE_SERVICE_ROLE_KEY ?? "");
const MEMORY_DIR = "C:/Users/竹内 悠馬/sumora-ai-ui/memory/self_improve_daily";

const jstDay = (ms: number) => new Date(ms + 9 * 3600e3).toISOString().slice(0, 10);
const pct = (a: number, b: number) => (b ? Math.round((a / b) * 1000) / 10 : null);

/** 1 方針（純関数）: 指摘の型・分野の重み（7日以内は2倍・主の型は1.5倍） */
export function focusOf(rows: Array<{ kinds: string[]; areas: string[]; said_at: string }>, nowMs: number) {
  const kw: Record<string, number> = {}, aw: Record<string, number> = {};
  for (const r of rows) {
    const w = nowMs - Date.parse(r.said_at) <= 7 * 86_400_000 ? 2 : 1;
    (r.kinds ?? []).forEach((k, i) => { if (k !== "other") kw[k] = (kw[k] ?? 0) + w * (i === 0 ? 1.5 : 1); });
    for (const a of r.areas ?? []) if (a !== "other") aw[a] = (aw[a] ?? 0) + w;
  }
  const top = (o: Record<string, number>, n: number) => Object.entries(o).sort((a, b) => b[1] - a[1]).slice(0, n).map(([k, v]) => ({ k, w: Math.round(v * 10) / 10 }));
  return { kinds: top(kw, 3), areas: top(aw, 3) };
}

const famOf = (t: string | null | undefined) => (t === "property_send" || t === "property_recommendation" ? "property" : String(t ?? ""));
/** 1日の本番の物差し: 返信の一致（line_watch_turns の verdict）と、AIX の最初の一手（scripts/audit-aix-first-move.ts と同じ数え方:
 *  押した AIX の直前24時間のブレインの判断の後に、お客様の新しい発言もスタッフの手打ちも無い番・ブレインが aix で同じ系統なら一致）。竹内さんの番は messages.staff_writer */
async function measureDay(d: string) {
  const s0 = new Date(`${d}T00:00:00+09:00`).toISOString(), e0 = new Date(Date.parse(s0) + 86_400_000).toISOString();
  const { data: wt } = await sb.from("line_watch_turns").select("verdict,vd_writer:verdict_detail->>staff_writer").gte("customer_turn_at", s0).lt("customer_turn_at", e0).not("verdict", "is", null).neq("verdict", "na").limit(3000);
  const turns = (wt ?? []) as Array<{ verdict: string; vd_writer: string | null }>;
  const isMatch = (v: string) => v === "same" || v === "same_meaning";
  const m = (rs: typeof turns) => ({ n: rs.length, match: pct(rs.filter((r) => isMatch(r.verdict)).length, rs.length) });
  const { data: us } = await sb.from("aix_usage_logs").select("conversation_id,aix_type,sent_at,created_at,line_message_id").gte("sent_at", s0).lt("sent_at", e0).not("aix_type", "is", null).limit(3000);
  const presses = ((us ?? []) as Array<{ conversation_id: string; aix_type: string; sent_at: string | null; created_at: string; line_message_id: string | null }>).filter((u) => !isTestConversation(u.conversation_id) && !isNoLineTestConversation(u.conversation_id));
  const byConv = new Map<string, typeof presses>();
  for (const u of presses) byConv.set(u.conversation_id, [...(byConv.get(u.conversation_id) ?? []), u]);
  const first: Array<{ writer: string | null; kind: "same" | "other" | "reply" }> = [];
  for (const [c, list] of byConv) {
    const from = new Date(Date.parse(s0) - 86_400_000).toISOString();
    const [mq, bq] = await Promise.all([
      sb.from("messages").select("sender,created_at,is_aix_generated,staff_writer,line_message_id").eq("conversation_id", c).gte("created_at", from).lt("created_at", e0).order("created_at").limit(3000),
      sb.from("brain_decision_logs").select("created_at,suggested_action,suggested_reply_mode").eq("conversation_id", c).gte("created_at", from).lt("created_at", e0).order("created_at").limit(2000),
    ]);
    const ms = (mq.data ?? []) as Array<{ sender: string; created_at: string; is_aix_generated: boolean | null; staff_writer: string | null; line_message_id: string | null }>;
    const bs = (bq.data ?? []) as Array<{ created_at: string; suggested_action: string | null; suggested_reply_mode: string | null }>;
    for (const u of list) {
      const at = Date.parse(u.sent_at ?? u.created_at);
      const b = [...bs].reverse().find((x) => Date.parse(x.created_at) <= at && at - Date.parse(x.created_at) <= 86_400_000);
      if (!b) continue;
      const bt = Date.parse(b.created_at);
      if (ms.some((x) => Date.parse(x.created_at) > bt && Date.parse(x.created_at) < at - 5000 && (x.sender === "customer" || (x.sender === "staff" && !x.is_aix_generated)))) continue;
      const w = ms.find((x) => x.line_message_id && x.line_message_id === u.line_message_id)?.staff_writer ?? null;
      first.push({ writer: w, kind: b.suggested_reply_mode === "aix" && famOf(b.suggested_action) === famOf(u.aix_type) ? "same" : b.suggested_reply_mode === "aix" ? "other" : "reply" });
    }
  }
  const f = (rs: typeof first) => ({ n: rs.length, rate: pct(rs.filter((r) => r.kind === "same").length, rs.length), reply: rs.filter((r) => r.kind === "reply").length, other: rs.filter((r) => r.kind === "other").length });
  return { all: m(turns), takeuchi: m(turns.filter((r) => r.vd_writer === "takeuchi")), firstAll: f(first), firstTk: f(first.filter((r) => r.writer === "takeuchi")) };
}

async function main() {
  const now = Date.now();
  const day = arg("day", jstDay(now - 2 * 86_400_000));
  const dayStart = new Date(`${day}T00:00:00+09:00`).toISOString(), dayEnd = new Date(Date.parse(dayStart) + 86_400_000).toISOString();
  const lines: string[] = [`# 自己改善の統括 毎朝の1枚（${day} の分・${new Date(now + 9 * 3600e3).toISOString().slice(0, 16).replace("T", " ")} JST に作った・LLM なし）`, ""];

  // 1 方針
  const { data: ptr } = await sb.from("owner_pointers").select("id,kinds,areas,said_at,state,quote,kb_draft").neq("state", "closed").limit(2000);
  const pointers = (ptr ?? []) as Array<{ id: number; kinds: string[]; areas: string[]; said_at: string; state: string; quote: string; kb_draft: string | null }>;
  const focus = focusOf(pointers, now);
  lines.push("## 1. 方針（竹内さんの指摘から・閉じていない " + pointers.length + "行）",
    `- 重点の型: ${focus.kinds.map((x) => `${POINTER_KIND_JA[x.k as PointerKind] ?? x.k}（${x.w}）`).join("・") || "なし"}`,
    `- 重点の分野: ${focus.areas.map((x) => `${x.k}（${x.w}）`).join("・") || "なし"}`,
    `- 新しい指摘（主の日）: ${pointers.filter((p) => p.said_at >= dayStart && p.said_at < dayEnd).map((p) => `P${p.id}「${p.quote.slice(0, 30)}」`).join(" ／ ") || "なし"}`, "");

  // 2 外れ: 本番の物差し。主＝前の前の日（判定がそろった日）・前の日は速報（統括役 11/21）
  const prelimDay = jstDay(Date.parse(dayStart) + 86_400_000);
  const mMain = await measureDay(day);
  const mPre = prelimDay < jstDay(now) ? await measureDay(prelimDay) : null;
  const mAll = mMain.all, mTk = mMain.takeuchi;
  // 前の日・前の週の同じ物（quality_daily・主の日どうしで比べる）
  const prevDay = jstDay(Date.parse(dayStart) - 1), prevWeek = jstDay(Date.parse(dayStart) - 7 * 86_400_000 + 1);
  const { data: qd } = await sb.from("quality_daily").select("day,metric,scope,value").in("day", [prevDay, prevWeek]).limit(500);
  const prev = (metric: string, scope: string, d: string) => ((qd ?? []) as Array<{ day: string; metric: string; scope: string; value: number | null }>).find((r) => r.day === d && r.metric === metric && r.scope === scope)?.value ?? null;
  const diff = (v: number | null, metric: string, scope: string) => {
    const x = prev(metric, scope, prevDay), y = prev(metric, scope, prevWeek);
    const f = (q: number | null) => (v == null || q == null ? "—" : `${v - q >= 0 ? "+" : ""}${Math.round((v - q) * 10) / 10}`);
    return `前の日 ${f(x)}・前の週 ${f(y)}`;
  };
  lines.push("## 2. 外れ", `### 本番の物差し（主: ${day}・判定がそろった日）`,
    `- 返信の一致（竹内さんの番）: ${mTk.match ?? "—"}%（${mTk.n}番）｜${diff(mTk.match, "reply_match", "takeuchi")}`,
    `- 返信の一致（全体）: ${mAll.match ?? "—"}%（${mAll.n}番）｜${diff(mAll.match, "reply_match", "all")}`,
    `- AIX の最初の一手の一致（竹内さんの番・audit-aix-first-move と同じ数え方）: ${mMain.firstTk.rate ?? "—"}%（${mMain.firstTk.n}番・ブレインは返信 ${mMain.firstTk.reply}・別の AIX ${mMain.firstTk.other}）｜${diff(mMain.firstTk.rate, "aix_first_match", "takeuchi")}`,
    `- AIX の最初の一手の一致（全体）: ${mMain.firstAll.rate ?? "—"}%（${mMain.firstAll.n}番）｜${diff(mMain.firstAll.rate, "aix_first_match", "all")}`,
    ...(mPre ? [`- 速報（${prelimDay}・判定が途中）: 返信の一致 竹内さん ${mPre.takeuchi.match ?? "—"}%（${mPre.takeuchi.n}番）・全体 ${mPre.all.match ?? "—"}%（${mPre.all.n}番）／AIX の最初の一手 竹内さん ${mPre.firstTk.rate ?? "—"}%（${mPre.firstTk.n}番）`] : []));

  // 2 外れ: 重点の型の点検（軽い物だけ・unread は1日）
  const kinds = focus.kinds.map((x) => x.k as PointerKind);
  const checkKinds = [...new Set<PointerKind>([...kinds, "unread", "no_measure", "left_off"])];
  const outs = await runChecks(checkKinds, 1);
  // 物差しが無いスイッチは多いので、台帳の priority と本番で on の物から上位だけ（統括役 11/21）
  const { data: wi } = await sb.from("work_items").select("id,switch_name,priority,stage").not("switch_name", "is", null).not("stage", "in", "(done,dropped)").limit(3000);
  const prio = new Map(((wi ?? []) as Array<{ switch_name: string; priority: number | null }>).map((r) => [r.switch_name, r.priority ?? 999]));
  lines.push("### 点検（重点の型＋読めていない・物差し・off のまま）");
  for (const o of outs) {
    if (o.kind === "no_measure" && o.gaps[0]) {
      const names = o.gaps[0].detail.split(",");
      const ranked = names.sort((a, b) => (LINKAGE_SWITCH_DEFAULTS[b] === "on" ? 1 : 0) - (LINKAGE_SWITCH_DEFAULTS[a] === "on" ? 1 : 0) || (prio.get(a) ?? 999) - (prio.get(b) ?? 999)).slice(0, 8);
      lines.push(`- ${POINTER_KIND_JA[o.kind]}: ${o.gaps[0].title}｜上位（本番で on・台帳の優先の順）${ranked.join("・")}`);
    } else lines.push(`- ${POINTER_KIND_JA[o.kind]}: 穴 ${o.gaps.length}${o.gaps.length ? `（${o.gaps.slice(0, 3).map((g) => g.title).join("／")}）` : ""}${o.note ? `｜今ある点検 ${o.note}` : ""}`);
  }

  // 2 外れ: 試験（前の24時間の exam_runs）
  const { data: er } = await sb.from("exam_runs").select("label,cost_usd,summary").gte("created_at", new Date(now - 86_400_000).toISOString()).limit(300);
  const runs = (er ?? []) as Array<{ label: string; cost_usd: number | null; summary: string | null }>;
  const worse = runs.filter((r) => /確かな悪化 [1-9]/.test(String(r.summary ?? "")));
  const cost = Math.round(runs.reduce((a, r) => a + Number(r.cost_usd ?? 0), 0) * 100) / 100;
  lines.push("### 試験（前の24時間）", `- 本 ${runs.length}・費用 $${cost}・確かな悪化のあった本 ${worse.length}${worse.length ? `（${worse.slice(0, 5).map((r) => r.label).join("・")}）` : ""}`, "");

  // 3 組む
  const gaps = outs.flatMap((o) => o.gaps.map((g) => `${POINTER_KIND_JA[o.kind]}: ${g.title}`));
  const examPtr = await pointersForExam(sb).catch(() => []);
  const { data: passed } = await sb.from("work_items").select("id,switch_name,priority,owner").eq("stage", "passed").order("priority", { ascending: true, nullsFirst: false }).limit(10);
  const { data: testing } = await sb.from("work_items").select("id,switch_name,priority,owner").eq("stage", "testing").not("switch_name", "is", null).order("priority", { ascending: true, nullsFirst: false }).limit(10);
  const { data: oq } = await sb.from("owner_questions").select("id,topic,question,recommended,priority").eq("status", "open").eq("kind", "question").order("priority", { ascending: true }).limit(5);
  const drafts = pointers.filter((p) => p.kb_draft);
  lines.push("## 3. 組む",
    `### ① 直しの候補（点検の穴・${gaps.length}）`, ...gaps.slice(0, 10).map((g) => `- ${g}`),
    `### ② 今夜の試験の候補`,
    `- 指摘の直し中で問題のある行: ${examPtr.length ? examPtr.map((p) => `P${p.id}（${p.exam_qids.join(",")}）`).join("・") : "なし"}`,
    `- 試験中のスイッチ: ${((testing ?? []) as Array<{ id: number; switch_name: string; owner: string | null }>).map((r) => `#${r.id} ${r.switch_name}（${r.owner ?? "-"}）`).join("・") || "なし"}`,
    `### ③ on の候補（悪化0 済み）`, ...((passed ?? []) as Array<{ id: number; switch_name: string | null; owner: string | null }>).map((r) => `- #${r.id} ${r.switch_name ?? "-"}（${r.owner ?? "-"}）`),
    `### ④ 竹内さんへの確認（open ${((oq ?? []) as unknown[]).length}件の上位・KB の下書き ${drafts.length}）`,
    ...((oq ?? []) as Array<{ topic: string; question: string; recommended: string | null }>).map((q) => `- ${q.topic}: ${q.question.slice(0, 60)}${q.recommended ? `（推奨: ${q.recommended.slice(0, 40)}）` : ""}`),
    ...drafts.slice(0, 5).map((p) => `- 下書き P${p.id}: ${String(p.kb_draft).slice(0, 80)}`), "",
    "## 4. 次に何をなぜ（決まった計算）",
    `- 重点の型「${POINTER_KIND_JA[(kinds[0] ?? "other") as PointerKind] ?? "-"}」の穴から直す（竹内さんの指摘の重みが一番大きい）`,
    `- 本番の一致が前の日より下がった物差しがあれば、その日の on のコミットを先に疑う（③の on は一致の線が戻ってから）`);

  const md = lines.join("\n") + "\n";
  const out = arg("out", `${MEMORY_DIR}/${day}.md`);
  if (flag("write")) {
    mkdirSync(dirname(out), { recursive: true });
    writeFileSync(out, md);
    const rows = [
      { day, metric: "reply_match", scope: "takeuchi", value: mTk.match, n: mTk.n }, { day, metric: "reply_match", scope: "all", value: mAll.match, n: mAll.n },
      { day, metric: "aix_first_match", scope: "takeuchi", value: mMain.firstTk.rate, n: mMain.firstTk.n }, { day, metric: "aix_first_match", scope: "all", value: mMain.firstAll.rate, n: mMain.firstAll.n },
      { day, metric: "exam_cost_usd", scope: "all", value: cost, n: runs.length }, { day, metric: "exam_worse_runs", scope: "all", value: worse.length, n: runs.length },
      ...outs.map((o) => ({ day, metric: `check_gaps:${o.kind}`, scope: "all", value: o.gaps.length, n: null })),
    ].map((r) => ({ ...r, source: "scripts/self-improve.ts" }));
    const { error } = await sb.from("quality_daily").upsert(rows, { onConflict: "day,metric,scope" });
    if (error) throw new Error(`quality_daily: ${error.message}`);
    await sb.from("cron_run_logs").insert({ cron_name: "self-improve", started_at: new Date(now).toISOString(), finished_at: new Date().toISOString(), ok: true, result_json: { day, focus, match: mMain, gaps: gaps.length, exam: { runs: runs.length, cost, worse: worse.length }, file: out } });
    console.log(`書いた: ${out}・quality_daily ${rows.length}行・cron_run_logs`);
  }
  console.log(md);
}

if (process.argv[1]?.endsWith("self-improve.ts")) main().catch(async (e) => {
  const msg = e instanceof Error ? e.message : String(e);
  if (flag("write")) await sb.from("cron_run_logs").insert({ cron_name: "self-improve", started_at: new Date().toISOString(), finished_at: new Date().toISOString(), ok: false, error_message: msg.slice(0, 500) });
  console.error(msg); process.exit(1);
});
