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
import { checkLinkage } from "./check-linkage";
import { checkConductor, CAUSE_JA, type Cause } from "./check-conductor";
import { checkFoundation } from "./check-foundation";
import { checkStale } from "./check-stale";
import { checkWindows, isNightJst } from "./check-windows";
import { isWindowGap } from "./lib/read-windows";
import { checkCountVerified } from "./check-count-verified";
import { UNVERIFIED_JA, countGapsForLedger } from "./lib/count-verified";
import { checkOffPath, isOffPathGap } from "./check-off-path";
import { addFoundGaps, type FoundGap } from "./lib/found-gap-ledger";
import { currentOwnerOf } from "./lib/live-owner";
import { superviseProLine, type QdRow } from "./lib/supervise-pro-line";
import { comboDaily } from "./lib/combo-daily";
import { foundationFill } from "./foundation-fill";
import { fillNotShrinking } from "./lib/foundation-fill";
import { groupOf, FIRST_MOVE_GROUPS, aixEditOfDay, writerLinkageNow, needsFix, GROWTH_OWNERS, pointersOfItems, pickupUnderstandingNow, runTsx, appealViaToolNow, estimateDoneUnsentNow } from "./lib/self-improve-growth";
import { existsSync as existsSyncPU } from "node:fs";
import { inOriginMain } from "./check-foundation";

const argv = process.argv.slice(2);
const arg = (k: string, d = "") => argv.find((a) => a.startsWith(`--${k}=`))?.slice(k.length + 3) ?? d;
const flag = (k: string) => argv.includes(`--${k}`);
const sb = createClient(process.env.NEXT_PUBLIC_SUPABASE_URL ?? "", process.env.SUPABASE_SERVICE_ROLE_KEY ?? "");
const MEMORY_DIR = "C:/Users/竹内 悠馬/sumora-ai-ui/memory/self_improve_daily";

const jstDay = (ms: number) => new Date(ms + 9 * 3600e3).toISOString().slice(0, 10);
const pct = (a: number, b: number) => (b ? Math.round((a / b) * 1000) / 10 : null);

/** 1 方針（純関数）: 指摘の型・分野の重み（7日以内は2倍・主の型は1.5倍） */
export function focusOf(rows: Array<{ kinds: string[]; areas: string[]; said_at: string; source?: string | null }>, nowMs: number) {
  const kw: Record<string, number> = {}, aw: Record<string, number> = {};
  for (const r of rows) {
    // 竹内さんの言葉そのまま（chat・work_item）を重く・設計知見から埋めた決定（meeting）は 0.5倍（統括役 11/21）
    const w = (nowMs - Date.parse(r.said_at) <= 7 * 86_400_000 ? 2 : 1) * (r.source === "meeting" ? 0.5 : 1);
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
  const first: Array<{ writer: string | null; kind: "same" | "other" | "reply"; group: string }> = [];
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
      first.push({ writer: w, group: groupOf(u.aix_type), kind: b.suggested_reply_mode === "aix" && famOf(b.suggested_action) === famOf(u.aix_type) ? "same" : b.suggested_reply_mode === "aix" ? "other" : "reply" });
    }
  }
  const f = (rs: typeof first) => ({ n: rs.length, rate: pct(rs.filter((r) => r.kind === "same").length, rs.length), reply: rs.filter((r) => r.kind === "reply").length, other: rs.filter((r) => r.kind === "other").length });
  const byGroup = Object.fromEntries([...FIRST_MOVE_GROUPS.map(([g]) => g), "その他"].map((g) => [g, f(first.filter((r) => r.writer === "takeuchi" && r.group === g))]));
  return { all: m(turns), takeuchi: m(turns.filter((r) => r.vd_writer === "takeuchi")), firstAll: f(first), firstTk: f(first.filter((r) => r.writer === "takeuchi")), byGroup, s0, e0 };
}

async function main() {
  const now = Date.now();
  const day = arg("day", jstDay(now - 2 * 86_400_000));
  const dayStart = new Date(`${day}T00:00:00+09:00`).toISOString(), dayEnd = new Date(Date.parse(dayStart) + 86_400_000).toISOString();
  // 2026-11-21 竹内さん「次の朝ではなく、そのまま連携することはできないのか」: 出来事のたびに軽い所だけ回す（--only）
  //   policy … 新しい指摘を台帳に入れた時（work-items.ts --add --origin=owner_request の後）／candidates … 試験の1本が終わった時（H の recordPointerExam の後）／
  //   metrics … 見張りの判定が付いた時（その日の quality_daily を足し直す）。--only の時は毎朝の1枚（md）は書かない
  const only = arg("only", "");
  if (only && !["policy", "candidates", "metrics", "core"].includes(only)) throw new Error(`--only は policy・candidates・metrics・core のどれか: ${only}`);
  const doPolicy = !only || only === "policy", doMetrics = !only || only === "metrics", doChecks = !only, doCandidates = !only || only === "candidates", doCore = !only || only === "core";
  const lines: string[] = [`# 自己改善の統括 毎朝の1枚（${day} の分・${new Date(now + 9 * 3600e3).toISOString().slice(0, 16).replace("T", " ")} JST に作った・LLM なし）`, ""];

  // 1 方針
  const { data: ptr } = await sb.from("owner_pointers").select("id,kinds,areas,said_at,state,quote,kb_draft,source").neq("state", "closed").limit(2000);
  const pointers = (ptr ?? []) as Array<{ id: number; kinds: string[]; areas: string[]; said_at: string; state: string; quote: string; kb_draft: string | null; source: string | null }>;
  const focus = focusOf(pointers, now);
  if (doPolicy) lines.push("## 1. 方針（竹内さんの指摘から・閉じていない " + pointers.length + "行）",
    `- 重点の型: ${focus.kinds.map((x) => `${POINTER_KIND_JA[x.k as PointerKind] ?? x.k}（${x.w}）`).join("・") || "なし"}`,
    `- 重点の分野: ${focus.areas.map((x) => `${x.k}（${x.w}）`).join("・") || "なし"}`,
    `- 新しい指摘（主の日）: ${pointers.filter((p) => p.said_at >= dayStart && p.said_at < dayEnd).map((p) => `P${p.id}「${p.quote.slice(0, 30)}」`).join(" ／ ") || "なし"}`, "");

  // 2 外れ: 本番の物差し。主＝前の前の日（判定がそろった日）・前の日は速報（統括役 11/21）
  const prelimDay = jstDay(Date.parse(dayStart) + 86_400_000);
  const emptyM = { all: { n: 0, match: null }, takeuchi: { n: 0, match: null }, firstAll: { n: 0, rate: null, reply: 0, other: 0 }, firstTk: { n: 0, rate: null, reply: 0, other: 0 }, byGroup: {} as Record<string, { n: number; rate: number | null; reply: number; other: number }>, s0: dayStart, e0: dayEnd };
  const mMain = doMetrics ? await measureDay(day) : emptyM;
  const mPre = doMetrics && prelimDay < jstDay(now) ? await measureDay(prelimDay) : null;
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
  if (doMetrics) lines.push("## 2. 外れ", `### 本番の物差し（主: ${day}・判定がそろった日）`,
    `- 返信の一致（竹内さんの番）: ${mTk.match ?? "—"}%（${mTk.n}番）｜${diff(mTk.match, "reply_match", "takeuchi")}`,
    `- 返信の一致（全体）: ${mAll.match ?? "—"}%（${mAll.n}番）｜${diff(mAll.match, "reply_match", "all")}`,
    `- AIX の最初の一手の一致（竹内さんの番・audit-aix-first-move と同じ数え方）: ${mMain.firstTk.rate ?? "—"}%（${mMain.firstTk.n}番・ブレインは返信 ${mMain.firstTk.reply}・別の AIX ${mMain.firstTk.other}）｜${diff(mMain.firstTk.rate, "aix_first_match", "takeuchi")}`,
    `- AIX の最初の一手の一致（全体）: ${mMain.firstAll.rate ?? "—"}%（${mMain.firstAll.n}番）｜${diff(mMain.firstAll.rate, "aix_first_match", "all")}`,
    ...(mPre ? [`- 速報（${prelimDay}・判定が途中）: 返信の一致 竹内さん ${mPre.takeuchi.match ?? "—"}%（${mPre.takeuchi.n}番）・全体 ${mPre.all.match ?? "—"}%（${mPre.all.n}番）／AIX の最初の一手 竹内さん ${mPre.firstTk.rate ?? "—"}%（${mPre.firstTk.n}番）`] : []));

  // 2 外れ: 重点の型の点検（軽い物だけ・unread は1日）
  const kinds = focus.kinds.map((x) => x.k as PointerKind);
  const checkKinds = [...new Set<PointerKind>([...kinds, "unread", "no_measure", "left_off"])];
  const outs = doChecks ? await runChecks(checkKinds, 1) : [];
  // 物差しが無いスイッチは多いので、台帳の priority と本番で on の物から上位だけ（統括役 11/21）
  const { data: wi } = await sb.from("work_items").select("id,switch_name,priority,stage").not("switch_name", "is", null).not("stage", "in", "(done,dropped)").limit(3000);
  const prio = new Map(((wi ?? []) as Array<{ switch_name: string; priority: number | null }>).map((r) => [r.switch_name, r.priority ?? 999]));
  if (doChecks) lines.push("### 点検（重点の型＋読めていない・物差し・off のまま）");
  for (const o of outs) {
    if (o.kind === "no_measure" && o.gaps[0]) {
      const names = o.gaps[0].detail.split(",");
      const ranked = names.sort((a, b) => (LINKAGE_SWITCH_DEFAULTS[b] === "on" ? 1 : 0) - (LINKAGE_SWITCH_DEFAULTS[a] === "on" ? 1 : 0) || (prio.get(a) ?? 999) - (prio.get(b) ?? 999)).slice(0, 8);
      lines.push(`- ${POINTER_KIND_JA[o.kind]}: ${o.gaps[0].title}｜上位（本番で on・台帳の優先の順）${ranked.join("・")}`);
    } else lines.push(`- ${POINTER_KIND_JA[o.kind]}: 穴 ${o.gaps.length}${o.gaps.length ? `（${o.gaps.slice(0, 3).map((g) => g.title).join("／")}）` : ""}${o.note ? `｜今ある点検 ${o.note}` : ""}`);
  }

  // 2 外れ: 自己改善の芯の4つの点検（竹内さん 11/21「土台・細分化・連携・統括の判断を自己改善の仕組で特に強化」・memory/self_improve_cycle_1121.md）
  //   ③ 連携が弱い（check-linkage）。①土台・②細分化・④統括の判断は順に足す。--only=core で2時間おきに軽く回す（統括役の見回り）
  const coreRows: Array<{ metric: string; value: number | null; n: number | null }> = [];
  const coreFix: string[] = [];
  const ledger: FoundGap[] = []; // 穴の型③〜⑤の穴（--write の時に台帳へ・題で重ねない）
  if (doCore) {
    const cl = await checkLinkage().catch(() => null);
    if (cl) {
      coreRows.push({ metric: "core:linkage", value: cl.score, n: cl.measured }, { metric: "core:no_denominator", value: cl.noDenominator.length, n: cl.measured + cl.noDenominator.length });
      if (cl.noDenominator.length) { lines.push(`### 芯: 記録に残らない（分母が無い・地図の行 ${cl.noDenominator.length}）`, ...cl.noDenominator.slice(0, 8).map((x) => `- ${x.id}｜${currentOwnerOf(x.owner, x.id)}｜${x.why.slice(0, 70)}`)); for (const x of cl.noDenominator.slice(0, 3)) coreFix.push(`記録に残らない（分母が無い）: ${x.id} → ${currentOwnerOf(x.owner, x.id)}`); }
      lines.push(`### 芯: 連携が弱い（地図のつながり ${cl.score ?? "—"}%＝${cl.connected}/${cl.measured}・弱い所 ${cl.weak.length}）`, ...cl.weak.slice(0, 8).map((w) => `- ${w.kind === "not_delivered" ? "届いていない" : "使われていない"}｜${w.label}｜${w.rate ?? "—"}%｜${currentOwnerOf(w.owner, w.id)}｜${w.why.slice(0, 70)}`));
      for (const w of cl.weak.slice(0, 5)) coreFix.push(`連携が弱い: ${w.label}（${w.kind === "not_delivered" ? "届いていない" : "使われていない"}・${w.rate ?? "—"}%）→ ${currentOwnerOf(w.owner, w.id)}`);
    }
  }

  if (doCore) {
    // 芯 ① 土台が無い（check-foundation・土台の表の4列: 決まり・物差し・本番の数字・担当の部品）
    const cf = await checkFoundation().catch(() => null);
    if (cf) {
      coreRows.push({ metric: "core:foundation", value: cf.score, n: cf.n });
      lines.push(`### 芯: 土台が無い（表 ${cf.tables.join("・")}・4列そろった ${cf.full}/${cf.n}＝${cf.score ?? "—"}%）`, ...cf.gaps.slice(0, 8).map((g) => `- ${g.name}（${currentOwnerOf(g.owner, g.id)}）: 欠け ${g.missing.join("・")}｜${g.detail.slice(0, 80)}`));
      for (const g of cf.gaps.slice(0, 5)) coreFix.push(`土台が無い: ${g.name}（欠け ${g.missing.join("・")}）→ ${currentOwnerOf(g.owner, g.id)}`);
    }
    // 芯 ① の穴の型①「作ったのに回っていない」（check-stale・cron の最後の記録・毎日の数の最後の日・統括役 11/21 の5つの型）
    const st = await checkStale(sb, now).catch(() => null);
    if (st) {
      const never = st.stale.filter((x) => x.kind === "cron_never");
      const rest = st.stale.filter((x) => x.kind !== "cron_never");
      coreRows.push({ metric: "core:stale", value: rest.length, n: st.crons + st.metrics }, { metric: "core:cron_no_log", value: never.length, n: st.crons });
      lines.push(`### 芯: 作ったのに回っていない（止まっている・一度も無い ${rest.length}・cron の記録が一度も無い ${never.length}/${st.crons}）`, ...rest.slice(0, 10).map((x) => `- ${x.name}｜最後 ${x.last ?? "—"}｜${currentOwnerOf(x.owner)}｜${x.why.slice(0, 70)}`));
      for (const x of rest.slice(0, 5)) coreFix.push(`作ったのに回っていない: ${x.name}（${x.why.slice(0, 40)}）→ ${currentOwnerOf(x.owner)}`);
    }
    // 穴の型③「読む窓が狭くて届かない」（check-windows・作業員N2 11/21）: 発言の本文を読む重い読み＝夜（JST 22〜9時）の回だけ（--only=core の2時間おきの夜の回で毎日1回以上入る）
    if (isNightJst(now)) {
      const cw = await checkWindows(sb, { hours: 72, max: 40 }).catch(() => null);
      if (cw) {
        coreRows.push({ metric: "core:window_miss", value: cw.gaps.length, n: cw.misses.length }, ...cw.misses.map((m) => ({ metric: `core:window_miss:${m.id}`, value: m.rate, n: m.n })));
        lines.push(`### 芯: 読む窓が狭くて届かない（会話 ${cw.n}・窓 ${cw.misses.length}・穴 ${cw.gaps.length}・線 5% 以上かつ2会話）`, ...[...cw.misses].sort((a, b) => (b.rate ?? 0) - (a.rate ?? 0)).slice(0, 6).map((m) => `- ${isWindowGap(m) ? "穴" : "　"}｜${m.label}（${m.limit}）｜窓の外 ${m.outside}/${m.n}＝${m.rate ?? "—"}%`));
        for (const m of cw.gaps) { coreFix.push(`読む窓が狭くて届かない: ${m.label}（${m.rate}%）→ ${currentOwnerOf(m.stage)}`); ledger.push({ title: `読む窓が狭くて届かない: ${m.label}（${m.limit}）`, owner: m.stage, next: `check-windows（穴の型③）: 窓の外 ${m.outside}/${m.n}（${m.rate}%）・${m.why}・場所 ${m.where}・会話 ${m.convs.slice(0, 5).join(",")}・窓を広げるか別読み・要約で補い、試験で悪化0を確かめる（台帳 #505）` }); }
      }
    } else lines.push("### 芯: 読む窓が狭くて届かない（昼は回さない・夜の回で書く）");
    // 穴の型④「数え方の誤りで低く見える」（check-count-verified）: 数えの台本ごとに実物1件で照らした日の記録（quality_daily count_verified）
    const cv = await checkCountVerified(sb, now).catch(() => null);
    if (cv) {
      coreRows.push({ metric: "core:count_unverified", value: cv.unverified.length, n: cv.units });
      const byKind = cv.unverified.reduce<Record<string, number>>((a, u) => ({ ...a, [u.kind]: (a[u.kind] ?? 0) + 1 }), {});
      lines.push(`### 芯: 数え方を実物で照らしていない（単位 ${cv.units}・穴 ${cv.unverified.length}＝${Object.entries(byKind).map(([k, n]) => `${UNVERIFIED_JA[k as keyof typeof UNVERIFIED_JA]} ${n}`).join("・") || "なし"}）`, ...cv.unverified.filter((u) => u.kind !== "never").slice(0, 6).map((u) => `- ${UNVERIFIED_JA[u.kind]}｜${u.key}｜${u.owner}`));
      for (const u of cv.unverified.filter((x) => x.kind === "mismatch").slice(0, 3)) coreFix.push(`数え方のズレを直していない: ${u.key} → ${currentOwnerOf(u.owner)}`);
      ledger.push(...countGapsForLedger(cv.unverified));
    }
    // 穴の型⑤「主な道の外から来る物の割合」（check-off-path）: 分野ごと（物件オススメ・返信・送信・内覧・見積）
    const op = await checkOffPath(sb, now).catch(() => null);
    if (op) {
      const og = op.filter(isOffPathGap);
      coreRows.push({ metric: "core:off_path", value: og.length, n: op.length }, ...op.map((o) => ({ metric: `core:off_path:${o.id}`, value: o.rate, n: o.n })));
      lines.push(`### 芯: 主な道の外から来る物（分野 ${op.length}・穴 ${og.length}・線 10% 以上かつ3件）`, ...op.map((o) => `- ${isOffPathGap(o) ? "穴" : "　"}｜${o.label}｜${o.off}/${o.n}＝${o.rate ?? "—"}%｜${o.owner}`));
      for (const o of og) { coreFix.push(`主な道の外から来る: ${o.label}（${o.rate}%）→ ${currentOwnerOf(o.owner)}`); ledger.push({ title: `主な道の外から来る: ${o.label}`, owner: o.owner, next: `check-off-path（穴の型⑤）: ${o.off}/${o.n}（${o.rate}%）・${o.why}${o.note ? `・${o.note}` : ""}・会話 ${o.convs.slice(0, 5).join(",")}・なぜ主な道を通らないかを実物で確かめる（台帳 #505）` }); }
    }
    // 芯 ② 細分化が足りない（owner-feedback-check の not_subdivided・ファイルと設計知見の札だけ）: 数は穴の項目の合計（少ないほど良い）
    const sd = (await runChecks(["not_subdivided"], 1).catch(() => []))[0];
    if (sd) {
      const items = sd.gaps.reduce((acc, g) => acc + Number((g.title.match(/(\d+)(?:行|欄)?\s*$/) ?? [])[1] ?? 0), 0); // 題の最後の数（行・欄の数）の合計
      coreRows.push({ metric: "core:subdivide", value: items, n: sd.gaps.length });
      lines.push(`### 芯: 細分化が足りない（項目 ${items}・${sd.gaps.length}種）`, ...sd.gaps.filter((g) => !g.title.startsWith("連携の地図の段")).map((g) => `- ${g.title}`), `- 連携の地図で値の来る所が決まっていない行: ${sd.gaps.filter((g) => g.title.startsWith("連携の地図の段")).reduce((x, g) => x + g.detail.split(",").length, 0)}`);
      for (const g of sd.gaps.filter((g) => !g.title.startsWith("連携の地図の段"))) coreFix.push(`細分化が足りない: ${g.title} → 統括役が割り振る（決まりは持ち主の分野・欄は連携の地図の持ち主）`);
    }
    // 芯 ④ 統括の判断（check-conductor・竹内さんの番・7日）: 外れを原因の3つに分け、試験の問題の候補（作業員H）と教訓（作業員L）へ
    const cc = await checkConductor(7).catch(() => null);
    if (cc) {
      coreRows.push({ metric: "core:conductor", value: cc.score, n: cc.n });
      coreRows.push({ metric: "core:conductor_aix", value: cc.aixScore, n: cc.aixTurns }, { metric: "core:conductor_sway", value: cc.swayRate, n: cc.n });
      lines.push(`### 芯: 統括の判断（竹内さんの番 7日 ${cc.n}・送る直前の判断で道の一致 ${cc.score ?? "—"}%・AIX の番 ${cc.aixTurns} で ${cc.aixScore ?? "—"}%・揺れ ${cc.swayRate ?? "—"}%）`, `- 外れの種類: ${JSON.stringify(cc.byType)}`, `- 原因: ${Object.entries(cc.byCause).map(([k, n]) => `${CAUSE_JA[k as Cause]} ${n}`).join("・") || "なし"}`, ...Object.entries(cc.ids).map(([k, xs]) => `- 試験の問題の候補（${k}）: 見張りの番 ${xs.slice(0, 8).join(",")}`));
      const top = Object.entries(cc.byCause).sort((x, y) => y[1] - x[1])[0];
      // 2026-11-22 作業員N2（統括役・#433 の D）: 統括の学び（conductor_lessons の今の行の数）と、それを読んだ番（7日の brain_decision_logs で digest に ls がある番）。今は 0 行＝0 を書く（回っていると分かるように）
      const lc = await sb.from("conductor_lessons").select("id", { count: "exact", head: true }).eq("is_current", true);
      const lr = await sb.from("brain_decision_logs").select("id", { count: "exact", head: true }).gte("created_at", new Date(now - 7 * 86_400_000).toISOString()).not("digest->ls", "is", null);
      const lrAll = await sb.from("brain_decision_logs").select("id", { count: "exact", head: true }).gte("created_at", new Date(now - 7 * 86_400_000).toISOString());
      if (!lc.error) coreRows.push({ metric: "core:conductor_lessons", value: lc.count ?? 0, n: lc.count ?? 0 });
      if (!lr.error) coreRows.push({ metric: "core:lessons_read", value: lr.count ?? 0, n: lrAll.count ?? null });
      lines.push(`- 統括の学び: conductor_lessons の今の行 ${lc.error ? "読めない" : lc.count ?? 0}・読んだ番（7日・digest の ls）${lr.error ? "読めない" : `${lr.count ?? 0}/${lrAll.count ?? "—"}`}（#433）`);
      if (top) coreFix.push(`統括の判断: 外れの原因で一番多いのは「${CAUSE_JA[top[0] as Cause]}」${top[1]}番 → 問題の候補を作業員H（brain-exam-add）・教訓を作業員L（conductor_lessons）へ`);
    }
  }

  // 2 外れ: 伸びしろの3つ（竹内さん 11/21「伸びしろの部分は自己改善で改善されるようになっているのか」）
  const { data: qd2 } = await sb.from("quality_daily").select("day,metric,scope,value").in("day", [prevDay, prevWeek]).like("metric", "growth:%").limit(500);
  const prev2 = (metric: string, d: string) => ((qd2 ?? []) as Array<{ day: string; metric: string; value: number | null }>).find((r) => r.day === d && r.metric === metric)?.value ?? null;
  const growthRows: Array<{ metric: string; value: number | null; n: number | null; key: "first_move" | "aix_edit" | "writer_link"; higherIsBetter: boolean; label: string }> = [];
  // 2026-11-21: 番が0の日も n=0・値なしで書く（回っていると分かるように・check-stale）
  for (const [g, c] of Object.entries(mMain.byGroup)) growthRows.push({ metric: `growth:first_move:${g}`, value: c.rate, n: c.n, key: "first_move", higherIsBetter: true, label: `AIX の最初の一手の一致（${g}・竹内さんの番）` });
  const ed = doMetrics ? await aixEditOfDay(sb, mMain.s0, mMain.e0) : { byType: {} as Record<string, { n: number; edited: number; withAi: number }>, features: {} as Record<string, number> };
  for (const [g, c] of Object.entries(ed.byType)) growthRows.push({ metric: `growth:aix_edit:${g}`, value: c.n ? Math.round((c.edited / c.n) * 1000) / 10 : null, n: c.n, key: "aix_edit", higherIsBetter: false, label: `AIX の文を竹内さんが直した割合（${g}・AI の元の文あり ${c.withAi}）` });
  const wl = doMetrics ? writerLinkageNow() : null;
  if (wl) {
    growthRows.push({ metric: "growth:writer_link:brief_used", value: wl.briefRate, n: wl.n, key: "writer_link", higherIsBetter: true, label: "統括の指示書の欄が下書きに入った割合（直近24時間）" });
    growthRows.push({ metric: "growth:writer_link:delivered", value: wl.deliverRate, n: wl.n, key: "writer_link", higherIsBetter: true, label: "決めた事の欄が書き手の注記に届いた割合（直近24時間）" });
    growthRows.push({ metric: "growth:writer_link:in_draft", value: wl.inDraftRate, n: wl.n, key: "writer_link", higherIsBetter: true, label: `決めた事の欄が下書きに入った割合（直近24時間・AIX の2通目に配線のある欄 ${wl.aix2Wired}）` });
  }
  const ptrs = await pointersOfItems(sb, [469, 466]).catch(() => ({} as Record<number, number[]>));
  const growthFix: string[] = [];
  if (doMetrics) lines.push("### 伸びしろ（毎朝追う・下がった／上がらない日は直しの候補へ）");
  for (const r of growthRows) {
    const d = needsFix(r.value, prev2(r.metric, prevDay), prev2(r.metric, prevWeek), r.n, 3, r.higherIsBetter);
    lines.push(`- ${r.label}: ${r.value ?? "—"}%（${r.n ?? "—"}番）｜前の日 ${prev2(r.metric, prevDay) ?? "—"}・前の週 ${prev2(r.metric, prevWeek) ?? "—"}${d ? (d === "down" ? "｜⚠ 下がった" : "｜上がっていない") : ""}`);
    if (d) { const o = GROWTH_OWNERS[r.key]; growthFix.push(`${r.label} が${d === "down" ? "前の日より下がった" : "前の週から上がっていない"}（${r.value}%）→ ${o.owner}・台帳 #${o.item}・指摘 ${(ptrs[o.item] ?? []).map((x) => "P" + x).join(" ") || "（つないだ指摘なし）"}`); }
  }
  if (only === "core" && coreFix.length) lines.push("### 直しの候補（芯）", ...coreFix.map((x) => `- ${x}`));
  // ピックアップで送る物件の「物件の理解」の欄（作業員K2 の頼み・台帳 #469・送った行のうち埋まっている割合と、元はあるのに空の数）
  const pu = doMetrics ? pickupUnderstandingNow((x) => existsSyncPU(x) || inOriginMain(x)) : null;
  const puRows: Array<{ metric: string; value: number | null; n: number | null }> = [];
  if (pu) {
    const low: string[] = [];
    for (const [k, f] of Object.entries(pu.fields)) {
      const tot = f.filled + f.gap + f.none;
      const rate = tot ? Math.round((f.filled / tot) * 1000) / 10 : null;
      puRows.push({ metric: `growth:pickup_field:${k}`, value: rate, n: tot }, { metric: `growth:pickup_field_gap:${k}`, value: f.gap, n: tot });
      if (rate != null && rate < 90) low.push(`${k} ${rate}%（元はあるのに空 ${f.gap}）`);
    }
    lines.push(`- ピックアップの物件の理解（前の日・送った ${pu.n}行）: 90% に届かない欄 ${low.join("・") || "なし"}`);
    if (low.length) growthFix.push(`ピックアップの物件の理解の欄が低い: ${low.slice(0, 3).join("・")} → 作業員K2・台帳 #469`);
  }
  // 返信と AIX の組（作業員M の頼み・台帳 #405・#32 の物差し・竹内さん本人の番は少ないので14日の窓）
  const cd = doMetrics ? await comboDaily(sb, day, 14).catch(() => null) : null;
  if (cd) {
    growthRows.push({ metric: "growth:combo:組の一致", value: cd.sameRate, n: cd.n, key: "first_move", higherIsBetter: true, label: `返信と AIX の組の一致（竹内さん本人の番・14日）` });
    const dc = needsFix(cd.sameRate, prev2("growth:combo:組の一致", prevDay), prev2("growth:combo:組の一致", prevWeek), cd.n, 3, true);
    lines.push(`- 返信と AIX の組の一致（竹内さん本人の番・14日）: ${cd.sameRate ?? "—"}%（${cd.n}番）${dc ? (dc === "down" ? "｜⚠ 下がった" : "｜上がっていない") : ""}`);
    if (dc) growthFix.push(`返信と AIX の組の一致が${dc === "down" ? "前の日より下がった" : "前の週から上がっていない"}（${cd.sameRate}%）→ 作業員M・台帳 #405・#32`);
    lines.push(`- 組の外れ（14日・竹内さん本人の番 ${cd.n}）: AIX→返信の外れ ${cd.aixToReply}（${Object.entries(cd.aixToReplyByKind).map(([k, n]) => `${k} ${n}`).join("・") || "—"}）・返信→AIX の外れ ${cd.replyToAix}・2つ目の AIX の取りこぼし ${cd.secondAixMiss}｜会話 ${cd.examples.comboMiss.join(",") || "—"}`);
    lines.push(`- 要件の帳面（14日・竹内さん本人の番・記録なしを除く ${cd.ask.n}）: 合う ${cd.ask.合う率 ?? "—"}%・取りこぼし ${cd.ask.取りこぼし}・重ね ${cd.ask.重ね}・取り違え ${cd.ask.取り違え}・種類違い ${cd.ask.種類違い}｜外れの会話 ${cd.ask.misses.slice(0, 8).map((x) => `${x.conv}（${x.cls}）`).join(",") || "—"}（作業員M・台帳 #520）`);
  }
  // 物件オススメが売上サポ（AIX ツール）を通っているか（作業員K2 の audit-appeal-vs-codes・台帳 #479・竹内さん 11/21「ここもちゃんと自己改善のところにいれる」・前の1日・書き手 all）
  const av = doMetrics ? appealViaToolNow(1, (x) => existsSyncPU(x)) : null;
  const avRows: Array<{ metric: string; value: number | null; n: number | null }> = [];
  if (av) {
    avRows.push({ metric: "growth:pickup_via_tool", value: av.rate, n: av.n }, ...Object.entries(av.textOnly).map(([k, v]) => ({ metric: `growth:appeal_text_only:${k}`, value: v, n: av.n })));
    // 書く日は前の日（jstDay(now-1日)）＝比べる前の日はその前の日
    const { data: qv } = await sb.from("quality_daily").select("value").eq("day", jstDay(now - 2 * 86_400_000)).eq("metric", "growth:pickup_via_tool").eq("scope", "all").limit(1);
    const pv = ((qv ?? []) as Array<{ value: number | null }>)[0]?.value ?? null;
    const notUp = av.rate != null && av.n > 0 && av.rate < 100 && pv != null && av.rate <= pv;
    lines.push(`- 物件オススメが売上サポを通った割合（前の1日・書き手 all）: ${av.rate ?? "—"}%（${av.matched}/${av.n}）｜前の日 ${pv ?? "—"}${notUp ? "｜上がっていない" : ""}｜文に書いたのに AIX の札に無い: ${Object.entries(av.textOnly).sort((a, b) => b[1] - a[1]).slice(0, 5).map(([k, v]) => `${k} ${v}`).join("・") || "—"}`);
    if (notUp) growthFix.push(`物件オススメが売上サポ（AIX ツール）を通った割合が前の日から上がらない（${av.rate}%・前の日 ${pv}%）→ 作業員K2・台帳 #479`);
  }
  // 済みなのに見積を送っていない見積の予定・同じ会話・同じ時刻の重複（作業員K2 の audit-estimate-done-unsent・台帳 #580・#596・ESTIMATE_EVENT_GUARD の確かめ・2026-11-22 統括役の中継）
  //   書く日は前の日（avRows と同じ）。前の日より増えた日は直しの候補へ（作業員K2・台帳 #580）。on の前は 18（9会話）・15
  const ed2 = doMetrics ? estimateDoneUnsentNow((x) => existsSyncPU(x)) : null;
  if (ed2) {
    avRows.push({ metric: "growth:estimate:done_unsent", value: ed2.unsent, n: ed2.done }, { metric: "growth:estimate:dup", value: ed2.dup, n: ed2.done });
    const { data: qe } = await sb.from("quality_daily").select("metric, value").eq("day", jstDay(now - 2 * 86_400_000)).in("metric", ["growth:estimate:done_unsent", "growth:estimate:dup"]).eq("scope", "all").limit(2);
    const pe = (m: string) => ((qe ?? []) as Array<{ metric: string; value: number | null }>).find((r) => r.metric === m)?.value ?? null;
    const pu = pe("growth:estimate:done_unsent"), pd = pe("growth:estimate:dup");
    lines.push(`- 見積の予定（30日）: 済みなのに見積を送っていない ${ed2.unsent}（${ed2.unsentConvs}会話・済み ${ed2.done}）｜前の日 ${pu ?? "—"}・同じ会話・同じ時刻の重複 ${ed2.dup}｜前の日 ${pd ?? "—"}｜会話 ${ed2.convs.slice(0, 6).join(",") || "—"}`);
    if (pu != null && ed2.unsent > pu) growthFix.push(`済みなのに見積を送っていない見積の予定が前の日より増えた（${pu}→${ed2.unsent}）→ 作業員K2・台帳 #580`);
    if (pd != null && ed2.dup > pd) growthFix.push(`同じ会話・同じ時刻の見積の予定の重複が前の日より増えた（${pd}→${ed2.dup}）→ 作業員K2・台帳 #580`);
  }
  // 統括Pro の数（作業員G・台帳 #474・supervisor-think の cron が毎晩 quality_daily に書く・2026-11-22 G の頼み）: 最新の日を前の日・前の週と比べる1行。下がった・増えた日は直しの候補（作業員G）
  if (doMetrics) {
    const { data: qs } = await sb.from("quality_daily").select("day, metric, value").like("metric", "search_%").eq("scope", "all").gte("day", jstDay(now - 9 * 86_400_000)).limit(1000);
    const sp = superviseProLine((qs ?? []) as QdRow[]);
    if (sp.line) { lines.push(sp.line); growthFix.push(...sp.fixes); }
  }
  // 画像の種類×欄の埋まり（作業員G の scripts/image-field-fill-daily.ts・台帳 #509・前の日 JST を --write で quality_daily へ・新しい cron は足さない）
  //   台本が手元に無い（main に入る前）の日は飛ばす。90% に届かない欄を直しの候補に
  if (doMetrics && existsSyncPU("scripts/image-field-fill-daily.ts")) {
    const imgDay = jstDay(now - 86_400_000);
    try { runTsx(["scripts/image-field-fill-daily.ts", ...(flag("write") ? ["--write"] : []), `--day=${imgDay}`], 180_000); } catch { lines.push("- 画像の欄の埋まり: 台本が失敗（作業員G・台帳 #509）"); }
    const { data: qi } = await sb.from("quality_daily").select("metric,value,n").eq("day", imgDay).like("metric", "image_fill:%").limit(500);
    const low = ((qi ?? []) as Array<{ metric: string; value: number | null; n: number | null }>).filter((r) => r.value != null && r.value < 0.9).sort((a, b) => Number(a.value) - Number(b.value));
    lines.push(`- 画像の欄の埋まり（${imgDay}・${(qi ?? []).length}欄）: 90% に届かない ${low.length}${low.length ? `（${low.slice(0, 6).map((r) => `${r.metric.replace("image_fill:", "")} ${Math.round(Number(r.value) * 100)}%`).join("・")}）` : ""}`);
    if (low.length) growthFix.push(`画像の欄の埋まりが 90% に届かない ${low.length}欄（${low.slice(0, 3).map((r) => `${r.metric.replace("image_fill:", "")} ${Math.round(Number(r.value) * 100)}%`).join("・")}）→ 作業員G・台帳 #509`);
  }
  // 土台の埋まり（竹内さん 11/21「土台足りていない部分あればちゃんといれていき、細部までもととのえていく」・土台の統括＝作業員N・scripts/foundation-fill.ts）
  const ff = doMetrics ? await foundationFill(sb).catch(() => null) : null;
  const fillRows: Array<{ metric: string; value: number | null; n: number | null }> = [];
  if (ff) {
    const T = ff.totals;
    fillRows.push({ metric: "found:full", value: T.full, n: T.n }, { metric: "found:scene_rule_gap", value: T.sceneGap, n: T.sceneCells }, { metric: "found:scene_rule_gap_strict", value: T.sceneStrict, n: T.sceneCells }, { metric: "found:no_measure", value: T.noMeasure, n: T.n }, { metric: "found:correct_rate", value: T.correctRate, n: T.correctMeasured });
    const { data: qf } = await sb.from("quality_daily").select("metric,value").eq("day", jstDay(now - 86_400_000)).like("metric", "found:%").limit(50);
    const pv = (m: string) => ((qf ?? []) as Array<{ metric: string; value: number | null }>).find((r) => r.metric === m)?.value ?? null;
    const own = (f: (typeof ff.fill)[number]) => f.cells[0]?.owner ?? "統括役";
    lines.push(`### 土台の埋まり（欄が全部そろった ${T.full}/${T.n}・場面の決まりの空き ${T.sceneGap}/${T.sceneCells}・物差しの無い土台 ${T.noMeasure}（${T.noMeasureNames.join("・") || "—"}）・正しさ ${T.correctRate ?? "—"}%）`,
      ...ff.fill.filter((f) => f.depth !== "—").map((f) => `- ${f.name}（${own(f)}）: 細かさの段 ${f.depth}・正しさ ${f.correctOk}/${f.correctMeasured}${f.emptyScenes.length ? `・決まりの無い場面 ${f.emptyScenes.length}` : ""}`));
    for (const x of fillNotShrinking(T, { full: pv("found:full"), sceneGap: pv("found:scene_rule_gap"), noMeasure: pv("found:no_measure") }, {
      sceneGap: ff.fill.filter((f) => f.cells.some((c) => c.col === "scene_rules" && !c.filled)).map(own),
      noMeasure: ff.fill.filter((f) => f.cells.some((c) => c.col === "measures" && !c.filled)).map(own),
      notFull: ff.fill.filter((f) => f.cells.some((c) => !c.filled)).map(own),
    })) growthFix.push(`土台の埋まり: ${x}・表 memory/foundation_fill.md`);
  }
  if (only === "metrics" && growthFix.length) lines.push("### 直しの候補（伸びしろが下がった・上がらない）", ...growthFix.map((x) => `- ${x}`));
  if (Object.keys(ed.features).length) lines.push(`- ピックアップの直しの中身（竹内さん）: ${Object.entries(ed.features).sort((a, b) => b[1] - a[1]).map(([k, n]) => `${k} ${n}`).join("・")}`);

  // 2 外れ: 試験（前の24時間の exam_runs）
  const { data: er } = await sb.from("exam_runs").select("label,cost_usd,summary").gte("created_at", new Date(now - 86_400_000).toISOString()).limit(300);
  const runs = (er ?? []) as Array<{ label: string; cost_usd: number | null; summary: string | null }>;
  const worse = runs.filter((r) => /確かな悪化 [1-9]/.test(String(r.summary ?? "")));
  const cost = Math.round(runs.reduce((a, r) => a + Number(r.cost_usd ?? 0), 0) * 100) / 100;
  if (!only || doCandidates) lines.push("### 試験（前の24時間）", `- 本 ${runs.length}・費用 $${cost}・確かな悪化のあった本 ${worse.length}${worse.length ? `（${worse.slice(0, 5).map((r) => r.label).join("・")}）` : ""}`, "");

  // 3 組む
  const gaps = [...coreFix.map((x) => `芯: ${x}`), ...growthFix.map((x) => `伸びしろ: ${x}`), ...outs.flatMap((o) => o.gaps.map((g) => `${POINTER_KIND_JA[o.kind]}: ${g.title}`))];
  const examPtr = await pointersForExam(sb).catch(() => []);
  const { data: passed } = await sb.from("work_items").select("id,switch_name,priority,owner").eq("stage", "passed").order("priority", { ascending: true, nullsFirst: false }).limit(10);
  const { data: testing } = await sb.from("work_items").select("id,switch_name,priority,owner").eq("stage", "testing").not("switch_name", "is", null).order("priority", { ascending: true, nullsFirst: false }).limit(10);
  const { data: oq } = await sb.from("owner_questions").select("id,topic,question,recommended,priority").eq("status", "open").eq("kind", "question").order("priority", { ascending: true }).limit(5);
  const drafts = pointers.filter((p) => p.kb_draft);
  if (doCandidates) lines.push("## 3. 組む",
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
    if (!only) { mkdirSync(dirname(out), { recursive: true }); writeFileSync(out, md); }
    const rows = [
      { day, metric: "reply_match", scope: "takeuchi", value: mTk.match, n: mTk.n }, { day, metric: "reply_match", scope: "all", value: mAll.match, n: mAll.n },
      { day, metric: "aix_first_match", scope: "takeuchi", value: mMain.firstTk.rate, n: mMain.firstTk.n }, { day, metric: "aix_first_match", scope: "all", value: mMain.firstAll.rate, n: mMain.firstAll.n },
      { day, metric: "exam_cost_usd", scope: "all", value: cost, n: runs.length }, { day, metric: "exam_worse_runs", scope: "all", value: worse.length, n: runs.length },
      ...outs.map((o) => ({ day, metric: `check_gaps:${o.kind}`, scope: "all", value: o.gaps.length, n: null })),
      ...growthRows.map((r) => ({ day, metric: r.metric, scope: r.key === "writer_link" ? "all" : "takeuchi", value: r.value, n: r.n })),
      ...Object.entries(ed.features).map(([k, n]) => ({ day, metric: `growth:pickup_edit_feature:${k}`, scope: "takeuchi", value: n, n: null })),
      ...coreRows.map((r) => ({ day: jstDay(now), metric: r.metric, scope: "all", value: r.value, n: r.n })),
      ...puRows.map((r) => ({ day: jstDay(now - 86_400_000), metric: r.metric, scope: "all", value: r.value, n: r.n })),
      ...fillRows.map((r) => ({ day: jstDay(now), metric: r.metric, scope: "all", value: r.value, n: r.n })),
      ...avRows.map((r) => ({ day: jstDay(now - 86_400_000), metric: r.metric, scope: "all", value: r.value, n: r.n })),
      ...(cd ? [{ day, metric: "growth:combo:AIX→返信の外れ", scope: "takeuchi", value: cd.aixToReply, n: cd.n }, { day, metric: "growth:combo:返信→AIX の外れ", scope: "takeuchi", value: cd.replyToAix, n: cd.n }, { day, metric: "growth:combo:2つ目の AIX の取りこぼし", scope: "takeuchi", value: cd.secondAixMiss, n: cd.n }, ...Object.entries(cd.aixToReplyByKind).map(([k, v]) => ({ day, metric: `growth:combo:AIX→返信の外れ:${k}`, scope: "takeuchi", value: v, n: cd.n })),
        // 2026-11-22 作業員N2（作業員M の頼み・台帳 #520）: 要件の帳面の分け（combo-daily の同じ番・14日・記録なしは分母外）。合うは合う率（%）
        { day, metric: "growth:ask:取りこぼし", scope: "takeuchi", value: cd.ask.取りこぼし, n: cd.ask.n }, { day, metric: "growth:ask:重ね", scope: "takeuchi", value: cd.ask.重ね, n: cd.ask.n },
        { day, metric: "growth:ask:取り違え", scope: "takeuchi", value: cd.ask.取り違え, n: cd.ask.n }, { day, metric: "growth:ask:合う", scope: "takeuchi", value: cd.ask.合う率, n: cd.ask.n }] : []),
    ].filter((r) => (r.metric.startsWith("core:") ? doCore : true) && (doMetrics || r.metric.startsWith("core:") || !/^(?:reply_match|aix_first_match|growth:)/.test(r.metric)) && (doChecks || !/^check_gaps:/.test(r.metric)) && (!only || only === "metrics" || !/^exam_/.test(r.metric) || doCandidates))
     .filter((r) => !only || only === "metrics" || (only === "core" && r.metric.startsWith("core:")))
     .map((r) => ({ ...r, source: only ? `scripts/self-improve.ts --only=${only}` : "scripts/self-improve.ts" }));
    if (rows.length) { const { error } = await sb.from("quality_daily").upsert(rows, { onConflict: "day,metric,scope" }); if (error) throw new Error(`quality_daily: ${error.message}`); }
    if (ledger.length) { const added = await addFoundGaps(sb, ledger, "self-improve").catch(() => []); if (added.length) console.log(`台帳に足した（穴の型③〜⑤）${added.length}行: #${added.join("・#")}`); }
    await sb.from("cron_run_logs").insert({ cron_name: "self-improve", started_at: new Date(now).toISOString(), finished_at: new Date().toISOString(), ok: true, result_json: { day, only: only || null, focus, match: mMain, gaps: gaps.length, exam: { runs: runs.length, cost, worse: worse.length }, file: out } });
    console.log(`書いた: ${only ? `--only=${only}` : out}・quality_daily ${rows.length}行・cron_run_logs`);
  }
  console.log(md);
}

if (process.argv[1]?.endsWith("self-improve.ts")) main().catch(async (e) => {
  const msg = e instanceof Error ? e.message : String(e);
  if (flag("write")) await sb.from("cron_run_logs").insert({ cron_name: "self-improve", started_at: new Date().toISOString(), finished_at: new Date().toISOString(), ok: false, error_message: msg.slice(0, 500) });
  console.error(msg); process.exit(1);
});
