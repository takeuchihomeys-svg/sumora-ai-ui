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
import { writeFileSync, mkdirSync, readFileSync, rmSync } from "node:fs";
import { dirname, join } from "node:path";
import { tmpdir } from "node:os";
import { POINTER_KIND_JA, type PointerKind } from "../app/lib/owner-pointers";
import { pointersForExam } from "../app/lib/owner-pointers-server";
import { LINKAGE_SWITCH_DEFAULTS } from "../app/lib/linkage-switch-defaults";
import { runChecks, gapRowsOf } from "./owner-feedback-check";
import { isTestConversation, isNoLineTestConversation } from "../app/lib/test-conversations";
import { checkLinkage } from "./check-linkage";
import { loadLinkStatus } from "./audit-conductor-duty";
import { LINKAGE_MAP } from "../app/lib/linkage-map";
import { CONDUCTOR_DUTY, conductorDutyOf, conductorDutySummary, conductorDutyGapsToAdd, dutyGapLinks, dutyDoneCount, dutyChanges, type DutyLedgerItem } from "./lib/conductor-duty";
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
import { flexMetricsOf, trustMetricsOf, routeSgMatchRowsOf, tsunagiRowsOf, type OffPatternJson, type PromiseKeptRow, type RouteProgressRow, type TsunagiCensusJson } from "./lib/flex-daily";
import { stationStatsOf, stationMetricRowsOf, weakStationsOf, type RouteStationRow } from "../app/lib/route-station-trust";
import { misreadMetricRowsOf, type MisreadRow } from "../app/lib/route-station-misread";
import { comboDaily } from "./lib/combo-daily";
import { foundationFill } from "./foundation-fill";
import { fillNotShrinking } from "./lib/foundation-fill";
import { groupOf, FIRST_MOVE_GROUPS, aixEditOfDay, writerLinkageNow, needsFix, GROWTH_OWNERS, pointersOfItems, pickupUnderstandingNow, runTsx, appealViaToolNow, estimateDoneUnsentNow, lastJsonLine, writerMetricRowsForQd } from "./lib/self-improve-growth";
import { existsSync as existsSyncPU } from "node:fs";
import { inOriginMain } from "./check-foundation";
import { mapDaily, type QdOut } from "./lib/metric-map-server";
import { orderSheetLines } from "./lib/sheet-order";
import { isHoleReachDay, holesNotReached, holesMaxNew, type HoleRow } from "./lib/hole-reach-weekly";

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
  let linkNextWhy = ""; // 2026-11-26 作業員A: 次に何をなぜ に連携の切れ目の1位
  const mapQd: QdOut[] = []; // 芯 ⑤ 数ごとの地図（map:* / forecast:*・detail 付きで別に書く）
  if (doCore) {
    const cl = await checkLinkage().catch(() => null);
    if (cl) {
      // 2026-11-28 作業員L（#858）: core:linkage の分母から親が off（on 待ち）の行を外した（この日から % の線が上がる・数え方の変わり目）。on 待ちの数は core:on_wait
      coreRows.push({ metric: "core:linkage", value: cl.score, n: cl.measured }, { metric: "core:no_denominator", value: cl.noDenominator.length, n: cl.measured + cl.noDenominator.length }, { metric: "core:on_wait", value: cl.onWait.length, n: cl.measured + cl.onWait.length });
      if (cl.noDenominator.length) { lines.push(`### 芯: 記録に残らない（分母が無い・地図の行 ${cl.noDenominator.length}）`, ...cl.noDenominator.slice(0, 8).map((x) => `- ${x.id}｜${currentOwnerOf(x.owner, x.id)}｜${x.why.slice(0, 70)}`)); for (const x of cl.noDenominator.slice(0, 3)) coreFix.push(`記録に残らない（分母が無い）: ${x.id} → ${currentOwnerOf(x.owner, x.id)}`); }
      lines.push(`### 芯: 連携が弱い（地図のつながり ${cl.score ?? "—"}%＝${cl.connected}/${cl.measured}・弱い所 ${cl.weak.length}・on 待ち ${cl.onWait.length}）`, ...cl.weak.slice(0, 8).map((w) => `- ${w.kind === "not_delivered" ? "届いていない" : "使われていない"}｜${w.label}｜${w.rate ?? "—"}%｜${currentOwnerOf(w.owner, w.id)}｜${w.why.slice(0, 70)}`));
      for (const w of cl.weak.slice(0, 5)) coreFix.push(`連携が弱い: ${w.label}（${w.kind === "not_delivered" ? "届いていない" : "使われていない"}・${w.rate ?? "—"}%）→ ${currentOwnerOf(w.owner, w.id)}`);
    }
    // 2026-11-23 作業員A（竹内さん 11/23・P0・#662「統括は全部管理して細かく細分化して反映できるように」）: 統括の受け持ち（土台ごとに 持つ／使う／反映）。
    //   段の状態は連携の地図の見張りの最新（無ければ今回す）。欠けのある土台は台帳へ（同じ土台の行が開いていれば足さない・--write の時だけ）
    try {
      const st = await loadLinkStatus(sb);
      const dr = conductorDutyOf(CONDUCTOR_DUTY, new Set(LINKAGE_MAP.map((r) => r.id)), st);
      const ds = conductorDutySummary(dr);
      coreRows.push({ metric: "core:conductor_duty:have", value: ds.have, n: ds.n }, { metric: "core:conductor_duty:use", value: ds.use, n: ds.n }, { metric: "core:conductor_duty:reflect", value: ds.reflect, n: ds.n });
      lines.push(`- ${ds.line}（作業員A・#662）`);
      // 2026-11-26 作業員A（#662・統括役の決め「受け持ち表は1つの題に」）: 土台の段の下に部品ごとの番の数（判断の記録 digest.mk・mpr・USED_MARKERS×AIX・1日・軽い読み・記録だけ）
      try {
        const co = await import("../app/lib/conductor-ownership");
        const since1 = new Date(now - 864e5).toISOString();
        const { data: dl } = await sb.from("brain_decision_logs").select("conversation_id,created_at,digest").gte("created_at", since1).limit(3000);
        const { data: al } = await sb.from("aix_usage_logs").select("conversation_id,created_at,aix_type").gte("created_at", since1).limit(3000);
        const cs = co.ownershipTable(((dl ?? []) as Array<{ conversation_id: string; created_at: string; digest: Record<string, unknown> | null }>).map((r) => ({ conv: r.conversation_id, at: r.created_at, digest: r.digest ?? {} })), ((al ?? []) as Array<{ conversation_id: string; created_at: string; aix_type: string | null }>).map((r) => ({ conv: r.conversation_id, at: r.created_at, type: String(r.aix_type ?? "") })));
        for (const r of CONDUCTOR_DUTY) { const pl = co.dutyPartLine(r.partKeys, cs); if (pl) lines.push(`  - ${r.name}`, pl); }
      } catch (e) { lines.push(`  - 部品の数: 失敗（${String(e).slice(0, 60)}）`); }
      // 2026-11-26 作業員A（竹内さん 11/26「ほかのも連携したらより質上がる部分を連携させていく」）: 連携の切れ目の値打ちの高い順 上位3つ（linkage-gap-matrix・上から1つずつ既定 off でつなぐ→試験→on）
      try {
        const lg = await import("../app/lib/linkage-gap-matrix");
        lines.push("### 連携・連鎖（作業員A・竹内さん 11/26「仕組化」）", ...lg.gapTopLines());
        const top = lg.rankGaps()[0]; if (top) linkNextWhy = `- 連携の切れ目の1位「${top.name} → ${lg.SINK_JA[top.sink]}」（値打ち ${top.value}%）から既定 off でつなぐ（竹内さん 11/26「パズルのように組み合わせて連鎖させていく」）`;
        const { data: cq } = await sb.from("quality_daily").select("day,metric,value,n,detail").in("metric", ["chain:patterns", "chain:brain_match_hit", "chain:table_candidates"]).order("day", { ascending: false }).limit(9);
        const cr = (cq ?? []) as Array<{ day: string; metric: string; value: number | null; n: number | null; detail: { miss_rate?: number | null } | null }>;
        const pat = cr.filter((r) => r.metric === "chain:patterns"), hit = cr.filter((r) => r.metric === "chain:brain_match_hit");
        lines.push(`- 連鎖の型: ${pat[0]?.value ?? "—"}型（${pat[0]?.day ?? "まだ"}${pat[1] ? `・前の日 ${pat[1].value}` : ""}）・型が当てはまった番のブレインの一致 ${hit[0]?.value ?? "—"}%（${hit[0]?.n ?? 0}番・当てはまらない番 ${hit[0]?.detail?.miss_rate ?? "—"}%${hit[1]?.value != null && hit[0]?.value != null ? `・前の日との差 ${Math.round((hit[0].value - hit[1].value) * 10) / 10}pt` : ""}）`);
        { const tc = cr.filter((r) => r.metric === "chain:table_candidates")[0] as { value: number | null; day: string; detail: { added?: string[]; gone?: string[] } | null } | undefined; if (tc) lines.push(`- 連鎖の型の表に足す候補 ${tc.value ?? 0}（${tc.day}・消えた型 ${tc.detail?.gone?.length ?? 0}・表の書き足しは週1回・作業員がテスト付きで）${tc.detail?.added?.length ? `: ${tc.detail.added.slice(0, 3).join("・")}` : ""}`); }
        lines.push(`- 次の晩の試験の候補（作ったが off の切れ目・値打ちの順）: ${lg.gapBundleCandidates().join("・") || "なし"}`);
        const { data: openGap } = await sb.from("work_items").select("title").like("title", "連携の切れ目: %").not("stage", "in", "(done,dropped)").limit(300);
        for (const g of lg.gapLedgerItems(((openGap ?? []) as Array<{ title: string }>).map((x) => x.title))) ledger.push({ title: g.title, owner: g.owner, next: g.next, area: "統括" });
      } catch (e) { lines.push(`- 連携の切れ目: 失敗（${String(e).slice(0, 60)}）`); }
      // 2026-11-24 作業員A（#662）: 土台ごとの済んだ段の数（core:conductor_duty:f:<id>）と、前に書いた日からの変わり（増えた・減った土台）
      for (const r of dr) coreRows.push({ metric: `core:conductor_duty:f:${r.id}`, value: dutyDoneCount(r), n: 3 });
      {
        const { data: pq } = await sb.from("quality_daily").select("day,metric,value").like("metric", "core:conductor_duty:f:%").lt("day", jstDay(now)).order("day", { ascending: false }).limit(60);
        const rowsPq = (pq ?? []) as Array<{ day: string; metric: string; value: number | null }>;
        const lastDay = rowsPq[0]?.day ?? null;
        const prevMap: Record<string, number> = {}; for (const x of rowsPq.filter((y) => y.day === lastDay)) if (x.value != null) prevMap[x.metric.replace("core:conductor_duty:f:", "")] = x.value;
        const ch = dutyChanges(dr, prevMap);
        lines.push(lastDay ? `  - ${lastDay} からの変わり: 増えた ${ch.up.join("・") || "なし"}／減った ${ch.down.join("・") || "なし"}` : "  - 前の日の土台ごとの数がまだ無い（今日から書く）");
        const { data: wi } = await sb.from("work_items").select("id, switch_name, stage, title").not("stage", "in", "(done,dropped)").limit(1000);
        const links = dutyGapLinks(dr, LINKAGE_MAP, (wi ?? []) as DutyLedgerItem[]);
        const none = links.filter((l) => !l.items.length);
        lines.push(`  - 欠けた段 ${links.length}・次の直しが台帳にある ${links.length - none.length}${none.length ? `・台帳に無い ${none.map((l) => `${l.duty}の${l.row}`).join("・")}` : ""}`);
      }
      const { data: openDuty } = await sb.from("work_items").select("title").like("title", "統括の受け持ち %").not("stage", "in", "(done,dropped)").limit(200);
      for (const g of conductorDutyGapsToAdd(dr, ((openDuty ?? []) as Array<{ title: string }>).map((x) => x.title))) ledger.push({ title: g.title, owner: g.owner, next: g.next, area: "統括" });
    } catch (e) { lines.push(`- 統括の受け持ち: 失敗（${String(e).slice(0, 60)}・作業員A）`); }
    // 2026-11-24 作業員A（統括役の決め・新しい cron は作らない）: 今どこの読み違い（判断の駅×その後の一手・7日・軽い読み）をここで数えて quality_daily に（--write の時だけ書く）
    try { const { runMisreadMove } = await import("./audit-route-misread-move"); await runMisreadMove({ sb: sb as never, days: 7, write: process.argv.includes("--write"), quiet: true }); } catch (e) { lines.push(`- 今どこの読み違いの数え: 失敗（${String(e).slice(0, 60)}・作業員A）`); }
    // 2026-11-25 作業員A（台帳 #687・竹内さん「今どこかちゃんと把握して申込に向かって進んでいるのか・地図を細分化して強化」）: 駅ごとの物差しと一番弱い駅（軽い読み・
    //   数は夜の scripts/audit-route-station-daily.ts --write が quality_daily に書いた最新の日の物＝ここは読むだけ）
    try {
      const { data: wq } = await sb.from("quality_daily").select("day,metric,value,n,source").like("metric", "route:weak_station:%").order("day", { ascending: false }).limit(9);
      const w = ((wq ?? []) as Array<{ day: string; metric: string; value: number | null; n: number | null; source: string | null }>);
      const d0 = w[0]?.day; const top = w.filter((x) => x.day === d0).sort((a, b) => a.metric.localeCompare(b.metric));
      if (top.length) lines.push(`- 一番弱い駅（${d0}・竹内さん本人の番）: ${top.map((x) => `${x.metric.slice(-1)}. ${String(x.source ?? "").split("・").pop()}（弱さ ${x.value}・番 ${x.n}）`).join("　")}（#687・細分化は audit-route-station-daily）`);
    } catch (e) { lines.push(`- 一番弱い駅: 読めない（${String(e).slice(0, 60)}・作業員A）`); }
    // 2026-11-25 作業員A（台帳 #688・竹内さん「なんで AIX の一致がこんなに弱いのか」・統括役の頼み）: スタッフが AIX を押した番でブレインが外した番を組ごとに（30日）。
    //   ④ スタッフだけが知る番（ブレインが知りようのない番）は弱さの数から外して別に数える。quality_daily は --write の時だけ（aix_miss:*_30d）
    try {
      const { runAixMissCauses } = await import("./audit-aix-miss-causes");
      const ms = await runAixMissCauses({ days: 30, write: process.argv.includes("--write"), quiet: true });
      const g = (k: string) => ms.find((m) => m.metric === k);
      const pairs = ms.filter((m) => m.metric.startsWith("aix_miss:pair:")).slice(0, 4).map((m) => `${m.metric.slice(14)} ${m.value}`).join("・");
      const rva = ms.filter((m) => m.metric.startsWith("aix_miss:reply_vs_aix:")).slice(0, 3).map((m) => `${m.metric.slice(22)} ${m.value}`).join("・");
      lines.push(`- AIX の外れ（30日・スタッフが押した番）: 弱さ ${g("aix_miss:weak_rate")?.value ?? "—"}%（${g("aix_miss:weak_rate")?.n ?? 0}番・④ スタッフだけが知る ${g("aix_miss:staff_only")?.value ?? 0}番は外す）・種類違いの組 ${pairs || "—"}・返信と取り違え ${rva || "—"}（#688・n≥10 の組だけ直しの候補）`);
    } catch (e) { lines.push(`- AIX の外れの数え: 失敗（${String(e).slice(0, 60)}・作業員A）`); }
    // 2026-11-24 作業員A（台帳 #608・統括役の頼み）: ブレインは地図をどこまで使えているか（地図の根2つ・今どこの読み違い・組の本当の一致の、最新の数と前の日からの変わり・軽い読み）
    try {
      const ms = ["map:route:progress_60d:value", "map:route:next_match_60d:value", "route:station_misread_move", "growth:combo:本当の一致"];
      const { data: q } = await sb.from("quality_daily").select("day,metric,value,n").in("metric", ms).order("day", { ascending: false }).limit(60);
      const rq = (q ?? []) as Array<{ day: string; metric: string; value: number | null; n: number | null }>;
      const pick = (m: string) => { const r = rq.filter((x) => x.metric === m); const a = r[0], b = r[1]; if (!a) return `—`; const d = a.value != null && b?.value != null ? Math.round((a.value - b.value) * 10) / 10 : null; return `${a.value ?? "—"}%（${a.n ?? "—"}番${d != null ? `・前の日から ${d >= 0 ? "+" : ""}${d}` : ""}）`; };
      lines.push(`- ブレインは地図をどこまで使えているか: 進み ${pick(ms[0])}・候補と一手の一致 ${pick(ms[1])}・今どこの読み違い ${pick(ms[2])}・組の本当の一致 ${pick(ms[3])}（作業員A・#608・次の直し #646／#650／#657／#624）`);
    } catch (e) { lines.push(`- 地図の使い方の数: 失敗（${String(e).slice(0, 60)}・作業員A）`); }
    // 2026-11-25 作業員A（竹内さん 18時台「地図の土台を整えて細分化・統括と連携」・#687）: 駅ごとの土台の欠け（決まり・材料・物差し・試験・統括）と連携の届き（audit-route-foundation --write の最新・軽い読み）
    try {
      const { data: fq } = await sb.from("quality_daily").select("day,metric,value,n,detail").like("metric", "route:foundation:%").gte("day", new Date(Date.parse(dayStart) - 3 * 86_400_000).toISOString().slice(0, 10)).order("day", { ascending: false }).limit(200);
      const fr = (fq ?? []) as Array<{ day: string; metric: string; value: number | null; n: number | null; detail: { gaps?: string[]; next?: { ok: number; n: number } } | null }>;
      const d0 = fr[0]?.day; const latest = fr.filter((r) => r.day === d0 && (r.value ?? 0) > 0).sort((a, b) => (b.n ?? 0) - (a.n ?? 0));
      for (const r of latest.slice(0, 6)) lines.push(`  - 駅 ${r.metric.replace("route:foundation:", "")}: 欠け ${(r.detail?.gaps ?? []).join("・")}${r.detail?.next ? `（次の一手 ${r.detail.next.ok}/${r.detail.next.n}）` : ""}`);
      const { data: lq } = await sb.from("quality_daily").select("value,n,detail").eq("metric", "route:link:brain_ar").order("day", { ascending: false }).limit(1);
      const l0 = (lq ?? [])[0] as { value: number | null; n: number | null; detail?: { empty?: number } } | undefined;
      if (latest.length || l0) lines.push(`- 地図の連携の届き: 判断の記録に駅 ${l0?.value ?? "—"}%（${l0?.n ?? 0}番・空 ${l0?.detail?.empty ?? 0}＝#676）・指示書に地図＝ROUTE_TO_BRIEF（会話の最新の記録で数える）・入口の統括の読みには駅が届いていない（作業員A・#687）`);
    } catch (e) { lines.push(`- 地図の駅ごとの土台: 失敗（${String(e).slice(0, 60)}・作業員A）`); }
    // 2026-11-25 作業員A（#745・竹内さん「2手先・逆算」）: 逆算の計画の この先 の駅が竹内さん本人の会話で当たった割合（audit-route-backplan-hit --write の最新）
    try {
      const { data: bq } = await sb.from("quality_daily").select("metric,value,n").in("metric", ["route:backplan_hit1", "route:backplan_hit2", "route:backplan_takeuchi_match"]).order("day", { ascending: false }).limit(6);
      const bh = (bq ?? []) as Array<{ metric: string; value: number | null; n: number | null }>;
      const b1 = bh.find((x) => x.metric === "route:backplan_hit1"), b2 = bh.find((x) => x.metric === "route:backplan_hit2");
      const bt = bh.find((x) => x.metric === "route:backplan_takeuchi_match");
      if (b1 || b2 || bt) lines.push(`- 地図の先読み: 竹内さんの先読みとの一致（竹内さんの仕込みの狙いが太い道の この先 に入っている）${bt?.value ?? "—"}%（${bt?.n ?? 0}番）／並べて見る: 本線の1手先 ${b1?.value ?? "—"}%（${b1?.n ?? 0}番）・2手先 ${b2?.value ?? "—"}%（${b2?.n ?? 0}番）（作業員A・#745）`);
    } catch (e) { lines.push(`- 地図の先読みの数: 失敗（${String(e).slice(0, 60)}・作業員A）`); }
    // 2026-11-24 作業員A（統括役の決め・COMPOSE_PLAN_REUSE=shadow 既定）: 前の日の返信の番で、設計図が作られた番・使い回しで作れた番（shadow の印）・作られなかった番（軽い読み・日付で絞る）
    try {
      const from = new Date(Date.parse(dayStart)).toISOString(), to = new Date(Date.parse(dayStart) + 86_400_000).toISOString();
      const { data: wt } = await sb.from("line_watch_turns").select("cp:materials->reply->compose_plan, sh:materials->reply->compose_plan_reuse_shadow, sk:materials->reply->compose_plan_skip").gte("created_at", from).lt("created_at", to).limit(3000);
      const w = (wt ?? []) as Array<{ cp: unknown; sh: { built?: boolean } | null; sk: { reason?: string } | null }>;
      const made = w.filter((x) => x.cp).length, shadowBuilt = w.filter((x) => x.sh?.built).length, skip = w.filter((x) => x.sk).length;
      const reasons = new Map<string, number>(); for (const x of w) if (x.sk?.reason) reasons.set(x.sk.reason, (reasons.get(x.sk.reason) ?? 0) + 1);
      coreRows.push({ metric: "core:compose_plan_made", value: made, n: w.length }, { metric: "core:compose_plan_reuse_shadow", value: shadowBuilt, n: w.length });
      lines.push(`- 設計図（前の日の番 ${w.length}）: 作られた ${made}・使い回しで作れた（shadow・書き手には渡さない）${shadowBuilt}・作られなかった ${skip}（${[...reasons.entries()].sort((a, b) => b[1] - a[1]).map(([k, v]) => `${k} ${v}`).join("・") || "理由の記録なし"}）（作業員A・#673）`);
    } catch (e) { lines.push(`- 設計図の数: 失敗（${String(e).slice(0, 60)}・作業員A）`); }
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
      // 2026-11-23 統括役の決め（作業員A の照らし）: 竹内さんの番を端末の記録（messages.staff_writer）で選び直した数を、今の数（文の癖で選ぶ）と並べる（2週間並べて実物で確かめてから既定の切り替えを竹内さんに聞く）。
      //   欄は作業員A が checkConductor に足す（scoreDevice・nDevice・aixScoreDevice・aixTurnsDevice）。まだ無い版では出さない
      const dv = cc as unknown as { scoreDevice?: number | null; nDevice?: number | null; aixScoreDevice?: number | null; aixTurnsDevice?: number | null };
      if (dv.nDevice != null || dv.aixTurnsDevice != null) {
        coreRows.push({ metric: "core:conductor_device", value: dv.scoreDevice ?? null, n: dv.nDevice ?? null }, { metric: "core:conductor_aix_device", value: dv.aixScoreDevice ?? null, n: dv.aixTurnsDevice ?? null });
        lines.push(`- 端末の記録で竹内さんの番を選んだ時: 道の一致 ${dv.scoreDevice ?? "—"}%（${dv.nDevice ?? "—"}番）・AIX の番 ${dv.aixScoreDevice ?? "—"}%（${dv.aixTurnsDevice ?? "—"}番）｜今の数（文の癖）: ${cc.score ?? "—"}%（${cc.n}番）・AIX ${cc.aixScore ?? "—"}%（${cc.aixTurns}番）（作業員A・2週間並べる）`);
      }
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
    // 芯 ⑤ 数ごとの地図と見込みの突き合わせ（2026-11-23 作業員P・台帳 #610・竹内さん「この予測と今の部分と次の部分を把握するように連携するように」）:
    //   木（数 → AIX の種類 → 場面 → 外れの型 → 原因）は夜に1日1回だけ作る（60日の重い読み）・昼は前の木を読む。葉の順位＝次の一手・穴・子の合計の食い違い・見込みの外れを要確認へ。
    //   止める: SELF_IMPROVE_MAP=off
    if ((process.env.SELF_IMPROVE_MAP ?? "on").toLowerCase() !== "off") {
      const mp = await mapDaily(sb, { now, write: flag("write"), night: isNightJst(now) }).catch((e) => { lines.push(`### 芯: 数ごとの地図（止まった: ${e instanceof Error ? e.message.slice(0, 120) : e}）`); return null; });
      if (mp) {
        lines.push("### 芯: 数ごとの地図と見込みの突き合わせ（#610）", ...mp.lines);
        coreFix.push(...mp.fix.slice(0, 8));
        mapQd.push(...mp.qd);
        // 2026-11-23 統括役: 1回に新しく足す地図の穴は上限まで（外れの多い順・初めての夜は5行・翌晩から残り＝holesMaxNew）。題で重ねる物は先に外して数える
        const maxNew = holesMaxNew(now);
        const { data: openHoles } = await sb.from("work_items").select("title").eq("origin", "found_gap").like("title", "地図の穴:%").not("stage", "in", "(done,dropped)").limit(2000);
        const openT = new Set(((openHoles ?? []) as Array<{ title: string }>).map((x) => x.title));
        const newHoles = mp.holes.filter((h) => !openT.has(h.title)).sort((a, b) => b.misses - a.misses);
        const takeHoles = maxNew > 0 ? newHoles.slice(0, maxNew) : newHoles;
        if (takeHoles.length < newHoles.length) lines.push(`- 地図の穴: 新しい穴 ${newHoles.length}のうち今回は外れの多い ${takeHoles.length}行だけ台帳へ（残りは次の回・MAP_HOLES_MAX_NEW）`);
        ledger.push(...takeHoles.map(({ misses: _m, ...h }) => ({ ...h, owner: currentOwnerOf(h.owner) })));
      }
      // 2026-11-23 統括役の決め: 試験の学び（conductor_lessons）に地図の葉の印（leaf_keys）を毎晩付ける＝「統括に届いているか」の学びの道（LLM なし・止める EXAM_LEAF_LESSONS=off）
      if (flag("write") && (process.env.EXAM_LEAF_LESSONS ?? "on").toLowerCase() !== "off") {
        try { const o = runTsx(["scripts/exam-leaf.ts", "--lessons", "--write"], 180_000); lines.push(`- 学びの葉の印: ${o.trim().split("\n").pop() ?? ""}`); }
        catch (e) { lines.push(`- 学びの葉の印: 止まった（${e instanceof Error ? e.message.slice(0, 80) : e}）`); }
      }
      // 2026-11-23 作業員N2（竹内さんの決定 KB 0f38f47f）: 週に1回（JST の月曜の回）、開いている地図の穴の行のうち統括に届いていない物を統括役に出す（読むだけ・軽い読み）
      if (isHoleReachDay(now)) {
        const sel = async (cols: string): Promise<{ data: unknown[] | null; error: { message: string } | null }> => (await sb.from("work_items").select(cols).eq("origin", "found_gap").like("title", "地図の穴:%").not("stage", "in", "(done,dropped)").limit(500)) as unknown as { data: unknown[] | null; error: { message: string } | null };
        let hq = await sel("id,title,owner,stage,next_step,conductor_reach");
        if (hq.error && /conductor_reach/.test(hq.error.message)) hq = await sel("id,title,owner,stage,next_step");
        const nr = holesNotReached((hq.data ?? []) as unknown as HoleRow[]);
        lines.push(`### 芯: 地図の穴で統括に届いていない物（週1回・${nr.length}行）`, ...nr.slice(0, 20).map((r) => `- #${r.id} ${r.title.replace(/^地図の穴: /, "")}（${r.owner ?? "統括役"}・${r.reach}）`));
        if (nr.length) coreFix.push(`地図の穴で統括に届いていない ${nr.length}行（${nr.slice(0, 5).map((r) => `#${r.id}`).join("・")}）→ 統括役が持ち主と統括の学び（conductor_lessons の leaf_keys）を決める`);
      }
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
    if (wl.notBuilt?.length) lines.push(`- 書き手への届きで作っていない欄（配線が無い・スイッチ off＝数えない）: ${wl.notBuilt.join("・")}（作業員L・台帳 #466）`);
    growthRows.push({ metric: "growth:writer_link:in_draft", value: wl.inDraftRate, n: wl.n, key: "writer_link", higherIsBetter: true, label: `決めた事の欄が下書きに入った割合（直近24時間・AIX の2通目に配線のある欄 ${wl.aix2Wired}）` });
  }
  const ptrs = await pointersOfItems(sb, [469, 466]).catch(() => ({} as Record<number, number[]>));
  const growthFix: string[] = [];
  if (doMetrics) lines.push("### 伸びしろ（毎朝追う・下がった／上がらない日は直しの候補へ）");
  for (const r of growthRows) {
    // 2026-11-26 作業員L（#466）: 書き手への届きは番が少ない（1日 5〜8番）ので、⚠ は 10番以上の日だけ
    const d = needsFix(r.value, prev2(r.metric, prevDay), prev2(r.metric, prevWeek), r.n, r.key === "writer_link" ? 10 : 3, r.higherIsBetter);
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
  // 2026-11-23 作業員A（台帳 #624・統括役の決め）: 本当の一致（combo_net）の印の元: 試験の問題（竹内さんの決定で正解を改めた番）と、P の地図の割れ・少数側の印（夜の地図が書いた時だけ・無ければ空）
  const netOpts = (() => {
    const read = (p: string) => { try { return existsSyncPU(p) ? JSON.parse(readFileSync(p, "utf8")) : null; } catch { return null; } };
    const spec = read("scripts/brain-exam/spec.json");
    const sides = read(process.env.COMBO_NET_SIDES_FILE ?? "scripts/.replay-out/aix-turn-sides.json");
    return { spec: Array.isArray(spec) ? spec : [], sides: Array.isArray(sides) ? sides : [] };
  })();
  const cd = doMetrics ? await comboDaily(sb, day, 14, netOpts).catch(() => null) : null;
  if (cd) {
    growthRows.push({ metric: "growth:combo:組の一致", value: cd.sameRate, n: cd.n, key: "first_move", higherIsBetter: true, label: `返信と AIX の組の一致（竹内さん本人の番・14日）` });
    const dc = needsFix(cd.sameRate, prev2("growth:combo:組の一致", prevDay), prev2("growth:combo:組の一致", prevWeek), cd.n, 3, true);
    lines.push(`- 返信と AIX の組の一致（竹内さん本人の番・14日）: ${cd.sameRate ?? "—"}%（${cd.n}番）${dc ? (dc === "down" ? "｜⚠ 下がった" : "｜上がっていない") : ""}`);
    // 2026-11-23 作業員A（#624）: 本当の一致（combo_net・今の数は変えずに並べる・竹内さんに出す数は2週間並べてから切り替えを聞く）
    if (cd.net) {
      const x = cd.net;
      // 2026-11-24 作業員A（統括役の頼み）: 今の組の一致と本当の一致を並べた1行・本当の外れの分け（並び・組の形・数え方の誤り）
      lines.push(`  - 組の一致 ${cd.sameRate ?? "—"}%（今の数え方・${cd.n}番）｜本当の一致 ${x.rate ?? "—"}%（${x.n}番）｜本当の外れ ${x.real.length}: 並び ${x.realKinds?.order ?? 0}・組の形 ${x.realKinds?.shape ?? 0}・数え方の誤り ${x.realKinds?.counting ?? 0}`);
      for (const k of ["order", "shape", "counting"] as const) growthRows.push({ metric: `growth:combo:本当の外れ:${k}`, value: x.realKinds?.[k] ?? 0, n: x.n, key: "first_move", higherIsBetter: false, label: `返信と AIX の組の本当の外れ（${k}）` });
      growthRows.push({ metric: "growth:combo:本当の一致", value: x.rate, n: x.n, key: "first_move", higherIsBetter: true, label: "返信と AIX の組の本当の一致（端末で竹内さん本人・2段の一致を一致に・決定／割れ／少数側／時刻で送る物を外す・14日）" });
      lines.push(`  - 本当の一致（combo_net）: ${x.rate ?? "—"}%（${x.same}/${x.n}・2段の一致 ${x.twoStageFirst}・外した 端末でない ${x.excluded.writer}／決定 ${x.excluded.decided}／割れ ${x.excluded.split}／少数側 ${x.excluded.minority}／時刻 ${x.excluded.timed}・本当の外れ ${x.real.length}${x.real.length ? `（${x.real.slice(0, 5).map((r) => r.conv).join("・")}）` : ""}）`);
    }
    if (dc) growthFix.push(`返信と AIX の組の一致が${dc === "down" ? "前の日より下がった" : "前の週から上がっていない"}（${cd.sameRate}%）→ 作業員A・台帳 #405・#32・#624`);
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
  // 土台「臨機応変」の本番の数（台帳 #512・#158・2026-11-22 作業員N2）: audit-off-pattern（30日・竹内さん本人の番）を夜の回だけ流す（DB を読むので 22〜9時）
  const flexRows: Array<{ metric: string; value: number | null; n: number | null }> = [];
  const foundRows: Array<{ metric: string; value: number | null; n: number | null }> = []; // 土台の表の本番の数（scope=all・作った日）
  if (doMetrics && isNightJst(now) && existsSyncPU("scripts/audit-off-pattern.ts")) {
    const fo = join(tmpdir(), `off-pattern-${process.pid}.json`);
    try {
      runTsx(["scripts/audit-off-pattern.ts", "--days=30", `--out=${fo}`], 240_000);
      const fm = flexMetricsOf(JSON.parse(readFileSync(fo, "utf8")) as OffPatternJson);
      flexRows.push({ metric: "growth:flex:off_rate", value: fm.offRate, n: fm.turns }, { metric: "growth:flex:off_match", value: fm.offMatch, n: fm.off }, { metric: "growth:flex:normal_match", value: fm.normalMatch, n: fm.turns - fm.off });
      lines.push(`- 臨機応変（30日・竹内さん本人の番 ${fm.turns}）: 型外の番 ${fm.off}（${fm.offRate ?? "—"}%）・型外の一致 ${fm.offMatch ?? "—"}%・普段の一致 ${fm.normalMatch ?? "—"}%（台帳 #512）`);
      if (fm.offMatch != null && fm.normalMatch != null && fm.off >= 5 && fm.offMatch + 15 < fm.normalMatch) growthFix.push(`臨機応変: 型外の番の一致（${fm.offMatch}%）が普段（${fm.normalMatch}%）より15点以上低い＝決まりに無理に当てている疑い → 作業員N2・台帳 #158`);
    } catch { lines.push("- 臨機応変: audit-off-pattern が失敗（台帳 #512）"); } finally { try { rmSync(fo); } catch { /* 無し */ } }
  }
  // 土台「信頼」の本番の数（台帳 #514・#55 の B1・2026-11-22 作業員N2）: audit-promise-kept（30日）を夜の回だけ（会話ごとに読むので 22〜9時）
  if (doMetrics && isNightJst(now) && existsSyncPU("scripts/audit-promise-kept.ts")) {
    const to = join(tmpdir(), `promise-kept-${process.pid}.json`);
    try {
      runTsx(["scripts/audit-promise-kept.ts", "--days=30", `--out=${to}`], 300_000);
      const tm = trustMetricsOf(((JSON.parse(readFileSync(to, "utf8")) as { rows?: PromiseKeptRow[] }).rows ?? []));
      // 全体の数は scope=all（書き手を問わない）・竹内さん本人の数だけ scope=takeuchi（11/22 夜の確かめで全体が takeuchi に入っていたのを直した）
      foundRows.push({ metric: "growth:trust:promise_kept", value: tm.rate, n: tm.judged });
      flexRows.push({ metric: "growth:trust:promise_kept_takeuchi", value: tm.tkRate, n: tm.tkJudged });
      // 2026-11-22 作業員L の名前（台帳 #519・土台の表 n.promise の metric）: in_time ÷（in_time＋late＋overdue）＝上の promise_kept と同じ数（scope=all）
      foundRows.push({ metric: "foundation:promise:kept_in_time", value: tm.rate, n: tm.judged });
      lines.push(`- 信頼（30日・約束を期限内に果たした割合）: ${tm.rate ?? "—"}%（${tm.inTime}/${tm.judged}・期限切れ ${tm.overdue}）・竹内さん本人 ${tm.tkRate ?? "—"}%（${tm.tkJudged}）（台帳 #514）`);
    } catch { lines.push("- 信頼: audit-promise-kept が失敗（台帳 #514）"); } finally { try { rmSync(to); } catch { /* 無し */ } }
  }
  // AIX の土台の数（作業員K2・台帳 #541・#546・#537・2026-11-22 K2 の頼み・軽い読み）: 最初のピックアップの揃い・AIX の鮮度・受けの返し
  if (doMetrics) {
    const pr = existsSyncPU("scripts/audit-pickup-ready-daily.ts") ? (() => { try { return lastJsonLine<{ n?: number; ready?: number; rate?: number | null }>(runTsx(["scripts/audit-pickup-ready-daily.ts", "--days=7", "--json"], 180_000)); } catch { return null; } })() : null;
    if (pr && typeof pr.n === "number") { avRows.push({ metric: "growth:pickup_ready:最初", value: pr.rate ?? null, n: pr.n }); lines.push(`- 最初のピックアップが揃っていた割合（7日）: ${pr.rate ?? "—"}%（${pr.ready ?? 0}/${pr.n}）（作業員K2・台帳 #541）`); }
    // 2026-11-22 K2 の頼みの2本目（台帳 #541 系・軽い読み・台本が手元に無い日は飛ばす）: ピックアップを選んだ理由の結び付け・物件確認の名前の埋まり
    const jsonOf = <T,>(script: string): T | null => (existsSyncPU(script) ? (() => { try { return lastJsonLine<T>(runTsx([script, "--days=7", "--json"], 180_000)); } catch { return null; } })() : null);
    const ps = jsonOf<{ n?: number; why?: number; rate?: number | null; no_pickup_row?: number }>("scripts/audit-pickup-select-link.ts");
    if (ps && typeof ps.n === "number") { avRows.push({ metric: "growth:pickup_select:理由あり", value: ps.rate ?? null, n: ps.n }); lines.push(`- ピックアップを選んだ理由が結び付いた割合（7日）: ${ps.rate ?? "—"}%（${ps.why ?? 0}/${ps.n}・ピックアップの行が無い ${ps.no_pickup_row ?? "—"}）（作業員K2）`); }
    const cn = jsonOf<{ total?: number; empty?: number; filled_rate?: number | null }>("scripts/audit-check-name-fill.ts");
    if (cn && typeof cn.total === "number") { avRows.push({ metric: "growth:check_name:埋まり", value: cn.filled_rate ?? null, n: cn.total }); lines.push(`- 物件確認の名前の埋まり（7日）: ${cn.filled_rate ?? "—"}%（空 ${cn.empty ?? 0}/${cn.total}）（作業員K2）`); }
    // 2026-11-22 K2 の頼みの3本目: 番が来た時だけ書く記録（カウンターキッチンの画像の読み・刺さった点）が「番が来ていない0」か「来たのに書いていない0」か（on にした時刻より後の番だけ）
    const ew = jsonOf<{ ck?: { came?: number; wrote?: number }; hook?: { came?: number; wrote?: number } }>("scripts/audit-event-write-gaps.ts");
    if (ew && (ew.ck || ew.hook)) {
      avRows.push({ metric: "growth:event_write:ck_came", value: Number(ew.ck?.came ?? 0), n: null }, { metric: "growth:event_write:ck_wrote", value: Number(ew.ck?.wrote ?? 0), n: Number(ew.ck?.came ?? 0) },
        { metric: "growth:event_write:hook_came", value: Number(ew.hook?.came ?? 0), n: null }, { metric: "growth:event_write:hook_wrote", value: Number(ew.hook?.wrote ?? 0), n: Number(ew.hook?.came ?? 0) });
      lines.push(`- 番が来た時だけ書く記録（7日）: カウンターキッチン 来た ${ew.ck?.came ?? 0}・書いた ${ew.ck?.wrote ?? 0}｜刺さった点 来た ${ew.hook?.came ?? 0}・書いた ${ew.hook?.wrote ?? 0}（作業員K2）`);
      if ((ew.ck?.came ?? 0) > (ew.ck?.wrote ?? 0) || (ew.hook?.came ?? 0) > (ew.hook?.wrote ?? 0)) growthFix.push(`番が来たのに書いていない記録がある（カウンターキッチン ${ew.ck?.wrote ?? 0}/${ew.ck?.came ?? 0}・刺さった点 ${ew.hook?.wrote ?? 0}/${ew.hook?.came ?? 0}）→ 作業員K2`);
    }
    if (existsSyncPU("scripts/audit-aix-ack-and-fresh.ts")) {
      const ao = join(tmpdir(), `aix-ack-fresh-${process.pid}.json`);
      try {
        runTsx(["scripts/audit-aix-ack-and-fresh.ts", "--days=7", `--json=${ao}`], 180_000);
        const aj = JSON.parse(readFileSync(ao, "utf8")) as { ack?: { total?: number; other?: number }; fresh?: Record<string, { n: number; fresh: number }> };
        for (const [k, v] of Object.entries(aj.fresh ?? {})) avRows.push({ metric: `growth:aix_fresh:${k}`, value: v.n ? Math.round((v.fresh / v.n) * 1000) / 10 : null, n: v.n });
        if (aj.ack) avRows.push({ metric: "growth:aix_ack:other", value: Number(aj.ack.other ?? 0), n: Number(aj.ack.total ?? 0) });
        lines.push(`- AIX の鮮度（7日）: ${Object.entries(aj.fresh ?? {}).map(([k, v]) => `${k} ${v.fresh}/${v.n}`).join("・") || "—"}｜受けの返しのうち代表以外 ${aj.ack?.other ?? "—"}/${aj.ack?.total ?? "—"}（作業員K2・台帳 #546・#537）`);
      } catch { lines.push("- AIX の鮮度・受けの返し: audit-aix-ack-and-fresh が失敗（作業員K2）"); } finally { try { rmSync(ao); } catch { /* 無し */ } }
    }
  }
  // 土台「時系列」の本番の数（作業員L・台帳 #518・土台の表 n.chrono の metric）: audit-timeline-coverage --json=（24時間・軽い読み）。--json の無い古い台本の日は飛ばす
  if (doMetrics && existsSyncPU("scripts/audit-timeline-coverage.ts") && readFileSync("scripts/audit-timeline-coverage.ts", "utf8").includes("foundation:chrono:timeline_reach")) {
    const tlo = join(tmpdir(), `timeline-coverage-${process.pid}.json`);
    try {
      runTsx(["scripts/audit-timeline-coverage.ts", "--hours=24", "--max=60", `--json=${tlo}`], 180_000);
      const tj = JSON.parse(readFileSync(tlo, "utf8")) as { metric?: string; value?: number | null; n?: number | null };
      if (tj.metric === "foundation:chrono:timeline_reach") {
        foundRows.push({ metric: tj.metric, value: tj.value ?? null, n: tj.n ?? null });
        lines.push(`- 時系列: 時の言葉が帳面に届いた割合（24時間）${tj.value ?? "—"}%（${tj.n ?? 0}語）（作業員L・台帳 #518）`);
      }
    } catch { lines.push("- 時系列: audit-timeline-coverage が失敗（作業員L・台帳 #518）"); } finally { try { rmSync(tlo); } catch { /* 無し */ } }
  }
  // 統括→書き手の欄ごとの数（作業員L・台帳 #466・作業員P の地図 #610 の葉・2026-11-23 統括役の頼み）: audit-writer-linkage --hours=72 --max=60 --metrics=（読むだけ・判断の60番まで）
  //   --metrics の無い古い台本（L の 60b98dfb2 が main に入る前）の日は飛ばす。既定の数（growth:writer_link:*）は変えない
  const wmRows: Array<{ metric: string; scope: string; value: number | null; n: number | null; detail?: Record<string, unknown> }> = [];
  if (doMetrics && existsSyncPU("scripts/audit-writer-linkage.ts") && readFileSync("scripts/audit-writer-linkage.ts", "utf8").includes("metricRowsOf")) {
    const wmo = join(tmpdir(), `writer-metrics-${process.pid}.json`);
    try {
      runTsx(["scripts/audit-writer-linkage.ts", "--hours=72", "--max=60", `--metrics=${wmo}`], 240_000);
      wmRows.push(...writerMetricRowsForQd(JSON.parse(readFileSync(wmo, "utf8")) as Array<{ metric: string; scope?: string; value: number | null; n: number | null; detail?: Record<string, unknown> }>));
      const low = wmRows.filter((r) => r.metric.endsWith(":in_draft") && r.value != null && r.value < 50 && (r.n ?? 0) >= 3).map((r) => `${r.metric.replace("writer_link:", "")} ${r.value}%（${r.n}）`);
      lines.push(`- 統括→書き手の欄（72時間）: ${wmRows.length}行・下書きに入ったのが半分より少ない欄 ${low.slice(0, 6).join("・") || "なし"}（作業員L・台帳 #466）`);
    } catch { lines.push("- 統括→書き手の欄: audit-writer-linkage --metrics が失敗（作業員L・台帳 #466）"); } finally { try { rmSync(wmo); } catch { /* 無し */ } }
  }
  // 時系列の帳面の届き方（作業員L・台帳 #7・作業員P の地図 #610 の葉・2026-11-23 統括役の頼み）: audit-timeline-delivery --hours=72 --max=80 --metrics=（読むだけ）
  //   writer_link:timeline:<欄>:to_brain／:to_writer。--metrics の無い古い台本（L の bea219c08 が main に入る前）の日は飛ばす。scope は draft（be8c8cfe0 と同じ読み替え）
  if (doMetrics && existsSyncPU("scripts/audit-timeline-delivery.ts") && readFileSync("scripts/audit-timeline-delivery.ts", "utf8").includes("--metrics")) {
    const tdo = join(tmpdir(), `timeline-delivery-${process.pid}.json`);
    try {
      runTsx(["scripts/audit-timeline-delivery.ts", "--hours=72", "--max=80", `--metrics=${tdo}`], 240_000);
      const tdRows = writerMetricRowsForQd(JSON.parse(readFileSync(tdo, "utf8")) as Array<{ metric: string; scope?: string; value: number | null; n: number | null; detail?: Record<string, unknown> }>);
      wmRows.push(...tdRows);
      const low = tdRows.filter((r) => r.value != null && r.value < 50 && (r.n ?? 0) >= 3).map((r) => `${r.metric.replace("writer_link:timeline:", "")} ${r.value}%（${r.n}）`);
      lines.push(`- 時系列の帳面の届き方（72時間）: ${tdRows.length}行・半分より少ない所 ${low.slice(0, 6).join("・") || "なし"}（作業員L・台帳 #7）`);
    } catch { lines.push("- 時系列の帳面の届き方: audit-timeline-delivery --metrics が失敗（作業員L・台帳 #7）"); } finally { try { rmSync(tdo); } catch { /* 無し */ } }
  }
  // 行動台帳の約束（作業員L・台帳 #519・作業員N の土台の表 n.promise・2026-11-23 統括役の頼み）: audit-promise-ledger --days=14 --metrics=（sent_facts の約束と済みの行だけ・軽い読み）
  //   foundation:promise:open（開いている約束の数）・foundation:promise:overdue_rate（うち期日超えの %）・foundation:promise:kept_72h（72時間の内に閉じた %）。行の scope は all のまま
  if (doMetrics && existsSyncPU("scripts/audit-promise-ledger.ts") && readFileSync("scripts/audit-promise-ledger.ts", "utf8").includes("--metrics")) {
    const plo = join(tmpdir(), `promise-ledger-${process.pid}.json`);
    try {
      runTsx(["scripts/audit-promise-ledger.ts", "--days=14", `--metrics=${plo}`], 180_000);
      const pl = (JSON.parse(readFileSync(plo, "utf8")) as Array<{ metric: string; scope?: string; value: number | null; n: number | null; detail?: Record<string, unknown> }>).filter((r) => typeof r.metric === "string" && r.metric.startsWith("foundation:promise:"));
      for (const r of pl) foundRows.push({ metric: r.metric, value: r.value ?? null, n: r.n ?? null });
      const g = (m: string) => pl.find((r) => r.metric === m);
      lines.push(`- 行動台帳の約束（14日）: 開いている ${g("foundation:promise:open")?.value ?? "—"}・うち期日超え ${g("foundation:promise:overdue_rate")?.value ?? "—"}%・72時間の内に閉じた ${g("foundation:promise:kept_72h")?.value ?? "—"}%（${g("foundation:promise:kept_72h")?.n ?? "—"}）（作業員L・台帳 #519）`);
    } catch { lines.push("- 行動台帳の約束: audit-promise-ledger --metrics が失敗（作業員L・台帳 #519）"); } finally { try { rmSync(plo); } catch { /* 無し */ } }
  }
  // 申込までの地図の駅ごとの一致（作業員R の audit-route-progress-takeuchi・作業員P の地図 route:sg_match・2026-11-23 統括役の頼み）: 会話ごとに customer-state を読む重い台本なので
  //   夜の回（22〜9時）だけ。sg の時代（11/03 05:42Z〜）の番しか数えないので --days=21 で足りる（60日でも同じ番）・会話は 150 まで。scope は takeuchi
  if (doMetrics && isNightJst(now) && existsSyncPU("scripts/audit-route-progress-takeuchi.ts")) {
    const rpo = join(tmpdir(), `route-progress-${process.pid}.json`);
    try {
      runTsx(["scripts/audit-route-progress-takeuchi.ts", "--days=21", "--max-conv=150", `--json=${rpo}`], 420_000);
      const rpoRows = JSON.parse(readFileSync(rpo, "utf8")) as RouteProgressRow[];
      const rr = routeSgMatchRowsOf(rpoRows);
      flexRows.push(...rr);
      // 2026-11-23 作業員A（竹内さん 11/23・#650／#653・決定 2d1c4c74「地図は道筋・一手を決めるのはブレイン」・置き場と名前は N2・P と決めた）:
      //   駅ごとの 地図の一致（:map・並べて見るだけ）と、竹内さん本人の一手の後の進み（:progress＝進んだ＋分かれ道から本線に戻った）。弱い駅は進みで見て台帳へ（同じ駅の行が開いていれば足さない）
      // 2026-11-23 作業員A（竹内さん 11/23・P0・#657「いまどこなのか現状把握」）: 「今どこ」の読み違いの型ごとの数（route:station_misread:<型>・同じ json）
      try {
        const mr = misreadMetricRowsOf(rpoRows as unknown as MisreadRow[]);
        flexRows.push(...mr);
        lines.push(`  - 「今どこ」の読み違い（決まった線・#657）: ${mr[0].value ?? "—"}%（${mr[0].n}番）・${mr.slice(1).filter((x) => (x.value ?? 0) > 0).map((x) => `${x.metric.replace("route:station_misread:", "")} ${x.value}`).join("・") || "型ごとに 0"}（作業員A）`);
      } catch (e) { lines.push(`  - 「今どこ」の読み違い: 失敗（${String(e).slice(0, 60)}・作業員A）`); }
      let stationLine = "";
      try {
        const ss = stationStatsOf(rpoRows as unknown as RouteStationRow[]);
        flexRows.push(...stationMetricRowsOf(ss));
        const { data: prevRows } = await sb.from("quality_daily").select("metric, value, n").like("metric", "route:station:%:progress").eq("scope", "takeuchi").eq("day", jstDay(now - 7 * 864e5)).limit(200);
        const prev = ((prevRows ?? []) as Array<{ metric: string; value: number | null; n: number | null }>).map((r) => ({ station: r.metric.replace(/^route:station:/, "").replace(/:progress$/, ""), n: r.n ?? 0, progressRate: r.value }));
        const weak = weakStationsOf(ss, prev);
        // 2026-11-23 統括役の決め: 弱い駅を台帳に足すのは N2 の「地図の穴」の自動の台帳に一本化（同じ駅が2回上がるため）。ここは数と一覧だけ（線は N2 が穴の理由に取り込む）
        stationLine = `  - 駅ごとの進み（竹内さん本人の一手の後に申込へ近づいた番）: ${ss.filter((s) => s.n >= 10).map((s) => `${s.station} ${s.progressRate}%（${s.n}）`).join("・") || "n10 以上の駅なし"}｜弱い駅 ${weak.map((w) => w.station).join("・") || "なし"}（台帳へは N2 の地図の穴から・作業員A・#650）`;
      } catch (e) { stationLine = `  - 駅ごとの進み: 失敗（${String(e).slice(0, 60)}・作業員A）`; }
      const all = rr[0];
      const low = rr.slice(1).filter((r) => r.n >= 5 && r.value != null && r.value < 50).map((r) => `${r.metric.replace("route:sg_match:", "")} ${r.value}%（${r.n}）`);
      lines.push(`- 申込までの地図の駅と判断の記録の段の一致（sg の時代・21日）: ${all?.value ?? "—"}%（${all?.n ?? 0}番）・半分より低い駅 ${low.slice(0, 6).join("・") || "なし"}（作業員R・M・#620）`);
      if (stationLine) lines.push(stationLine); // N2 の照らし③: 親の行の後に
    } catch { lines.push("- 申込までの地図の駅ごとの一致: audit-route-progress-takeuchi が失敗（作業員R）"); } finally { try { rmSync(rpo); } catch { /* 無し */ } }
  }
  // 土台「つなぎ」の本番の数（作業員H の tsunagi-census・土台の表 n.link・2026-11-23 統括役の頼み）: 竹内さん本人の送信（takeuchi_compose_examples・30日で絞る・--brain は使わない＝軽い読み）
  if (doMetrics && existsSyncPU("scripts/tsunagi-census.ts")) {
    const tso = join(tmpdir(), `tsunagi-census-${process.pid}.json`);
    try {
      runTsx(["scripts/tsunagi-census.ts", "--days=30", `--json=${tso}`], 180_000);
      const tr = tsunagiRowsOf(JSON.parse(readFileSync(tso, "utf8")) as TsunagiCensusJson);
      flexRows.push(...tr);
      const top = tr.filter((r) => r.metric.startsWith("foundation:link:kind:") && !r.metric.endsWith(":none")).sort((a, b) => Number(b.value) - Number(a.value)).slice(0, 4).map((r) => `${r.metric.replace("foundation:link:kind:", "")} ${r.value}%`);
      lines.push(`- つなぎ（30日・竹内さん本人の送信 ${tr[0]?.n ?? 0}通）: つなぎの入った通 ${tr[0]?.value ?? "—"}%｜多い型 ${top.join("・") || "—"}（作業員H）`);
    } catch { lines.push("- つなぎ: tsunagi-census が失敗（作業員H）"); } finally { try { rmSync(tso); } catch { /* 無し */ } }
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
  const fillRows: Array<{ metric: string; value: number | null; n: number | null; detail?: Record<string, unknown> }> = [];
  if (ff) {
    const T = ff.totals;
    // 土台の葉（作業員P の #610 の地図が読む・found:<土台id>:<場面>:<欄>・value 1=埋まっている/0=空き・detail に持ち主と原因）
    for (const l of ff.leaves) fillRows.push({ metric: l.key, value: l.filled ? 1 : 0, n: null, detail: { owner: l.owner, cause: l.cause, writer_select: l.writer_select } });
    fillRows.push({ metric: "found:full", value: T.full, n: T.n }, { metric: "found:scene_rule_gap", value: T.sceneGap, n: T.sceneCells }, { metric: "found:scene_rule_gap_strict", value: T.sceneStrict, n: T.sceneCells }, { metric: "found:no_measure", value: T.noMeasure, n: T.n }, { metric: "found:correct_rate", value: T.correctRate, n: T.correctMeasured });
    const { data: qf } = await sb.from("quality_daily").select("metric,value").eq("day", jstDay(now - 86_400_000)).like("metric", "found:%").limit(50);
    const pv = (m: string) => ((qf ?? []) as Array<{ metric: string; value: number | null }>).find((r) => r.metric === m)?.value ?? null;
    const own = (f: (typeof ff.fill)[number]) => currentOwnerOf(f.cells[0]?.owner ?? "統括役");
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
  // 2026-11-27 作業員L（作業員A の #817 の欄に渡す）: 晩の空き枠の1行
  let nightCapLine: string | null = null;
  // 2026-11-24 作業員L（台帳 #686・竹内さん「試験の費用も抑えて、質も上げていく仕組み」）: 試験の効率の物差し（scripts/audit-night-cost.ts --write が書いた test:efficiency:*）を1行で
  if (!only || doCandidates) {
    // 一番新しい日の分（audit-night-cost は晩の翌日の日付で書く・この1枚の day とずれるので日で絞らず新しい順）
    const { data: ef0 } = await sb.from("quality_daily").select("day, metric, value, detail").eq("scope", "all").like("metric", "test:efficiency:%").lte("day", jstDay(now)).order("day", { ascending: false }).limit(20);
    const ef = ((ef0 ?? []) as Array<{ day: string }>).filter((r, _i, a) => r.day === a[0]?.day);
    const ev = new Map((ef as unknown as Array<{ metric: string; value: number | null; detail: { why?: string[]; reason?: string | null } | null }>).map((r) => [r.metric.replace("test:efficiency:", ""), r]));
    if (ev.size) {
      const v = (k: string) => (ev.get(k)?.value == null ? null : Number(ev.get(k)!.value));
      const wn = ev.get("worse_night");
      lines.push(`- 試験の効率: 費用 $${(v("usd") ?? 0).toFixed(2)}（DeepSeek $${(v("usd_deepseek") ?? 0).toFixed(2)}・OpenAI $${(v("usd_openai") ?? 0).toFixed(2)}・Claude $${(v("usd_claude") ?? 0).toFixed(2)}）・on にできた直し ${v("fixes_on") ?? 0}本${v("usd_per_fix") != null ? `（1本あたり $${v("usd_per_fix")!.toFixed(2)}）` : ""}・確かな悪化を見つけた ${v("sure_worse") ?? 0}本・差なしの組の $ ${v("nodiff_share") != null ? `${Math.round(v("nodiff_share")! * 100)}%` : "—"}・止めた $${(v("stopped_usd") ?? 0).toFixed(2)}${v("worse_night") ? `・⚠ 効率が悪くなった（${(wn?.detail?.why ?? []).join("・")}）` : ""}`, "");
      // 2026-11-27 作業員L（#803・統括役の決め）: 晩の空き枠（上限 $10 の内）と流れ残った組（朝に列に残った試験の組）
      try { const { nightCapacity, leftoverJobs } = await import("./lib/night-capacity"); const { nightJobsOf } = await import("./build-exam-dictionary"); const { examCacheRoot } = await import("./lib/llm-cassette"); const { readdirSync: rd, readFileSync: rf } = await import("node:fs"); const Q = `${examCacheRoot()}/exam-queue`; const last = nightJobsOf(`${Q}/results`, 1); const spent = last.reduce((a, j) => a + j.usd, 0); const d0 = new Date(now + 9 * 3_600_000 - 864e5).toISOString().slice(0, 10); const ns = Date.parse(`${d0}T22:00:00+09:00`); const q = rd(Q).filter((f) => f.endsWith(".json") && !["config.json", "scene-map.json", "prod-env.json"].includes(f)).map((f) => { try { return JSON.parse(rf(`${Q}/${f}`, "utf8")); } catch { return {}; } }); const nc = nightCapacity({ spentUsd: spent, jobs: last.length, leftover: leftoverJobs(q, ns), openaiUsd: v("usd_openai") }); nightCapLine = nc.line; lines.push(nc.line, ""); } catch (e) { console.warn("[self-improve] 晩の空き枠を出せない:", e instanceof Error ? e.message : String(e)); }
    }
  }
  // 2026-11-25 作業員L（台帳 #727）: 約束の一生の段ごとの数（audit-promise-lifecycle --write の promise_life:*・一番新しい日）
  if (!only || doCandidates) {
    const { data: pl0 } = await sb.from("quality_daily").select("day, metric, value").eq("scope", "all").like("metric", "promise_life:%").lte("day", jstDay(now)).order("day", { ascending: false }).limit(20);
    const pl = ((pl0 ?? []) as Array<{ day: string; metric: string; value: number | null }>).filter((r, _i, a) => r.day === a[0]?.day);
    if (pl.length) {
      const g = (k: string) => { const r = pl.find((x) => x.metric === `promise_life:${k}`); return r?.value == null ? "—" : `${Number(r.value)}%`; };
      lines.push(`- 約束の一生（${pl[0].day}）: 見つけるの外れ ${g("find_miss")}・文に期限 ${g("due_words")}・台帳 ${g("record_fact")}・期限内に果たした ${g("kept_in_time")}・閉じた時刻 ${g("closed_with_time")}・試験の約束の依頼の扱い ${g("exam_promise_covered")}（答え方 ${g("exam_promise_route")}）`, "");
      // 2026-11-28 作業員L（#664）: 晩に数え直していないと古い数が出続ける（11/25 に1回書いたきりだった）＝2日より古ければ印
      if (now - Date.parse(`${pl[0].day}T00:00:00+09:00`) > 2 * 86_400_000) lines.push(`  - ⚠ 約束の一生の数が古い（${pl[0].day}・晩の費用0の仕事の audit-promise-lifecycle が書いていない）`);
    }
  }
  // 2026-11-27 作業員L（台帳 #816 スイッチの一生の台帳）: 晩の費用0の仕事（scripts/switch-life.ts --write）が書いた <exam-cache>/switch-life.json の1行（36時間より古ければ出さない）
  if (!only || doCandidates) {
    try { const { examCacheRoot } = await import("./lib/llm-cassette"); const { readFileSync: rf } = await import("node:fs"); const j = JSON.parse(rf(`${examCacheRoot()}/switch-life.json`, "utf8")) as { at?: string; line?: string }; if (j.line && j.at && now - Date.parse(j.at) < 36 * 3600_000) lines.push(`- ${j.line}`); } catch { /* 無い晩は出さない */ }
  }
  // 2026-11-28 作業員L（統括役の決め・試験の費用は llm_usage_logs の名札で数えるのが正）: 一番新しい晩の exam_cost:* と夜の上限 $10・手元の試験が $1 を超えたら ⚠ 係の外の試験
  if (!only || doCandidates) {
    const { data: ec0 } = await sb.from("quality_daily").select("day, metric, value, detail").eq("scope", "all").like("metric", "exam_cost:%").lte("day", jstDay(now)).order("day", { ascending: false }).limit(8);
    const ec = ((ec0 ?? []) as Array<{ day: string; metric: string; value: number | null; detail?: unknown }>).filter((r, _i, a) => r.day === a[0]?.day);
    if (ec.length) lines.push(...(await import("./lib/exam-cost-daily")).examCostMorningLines(ec));
  }
  // 2026-11-28 作業員L（台帳 #806 お客様のカルテ）: 晩の費用0の仕事（scripts/audit-customer-karte.ts --write）が書いた quality_daily karte:*（一番新しい日）の1行
  if (!only || doCandidates) {
    const { data: kq0 } = await sb.from("quality_daily").select("day, metric, value, n").eq("scope", "all").like("metric", "karte:%").lte("day", jstDay(now)).order("day", { ascending: false }).limit(20);
    const kq = ((kq0 ?? []) as Array<{ day: string; metric: string; value: number | null; n: number | null }>).filter((r, _i, a) => r.day === a[0]?.day);
    if (kq.length) { const lines2 = (await import("./lib/karte-morning")).karteMorningLine(kq); if (lines2) lines.push(lines2); }
  }
  // 2026-11-25 作業員L（台帳 #664 の④・統括役の決め）: 統括に渡す期日超えの約束の「今」の差（OVERDUE_NOW_CLOCK=shadow の記録 digest.odn・前の24時間・日付で絞った軽い読み）。
  //   渡った数（最後の通の時刻で読んだ）より本当の今の数が多い番＝統括に渡り損ねた番。数日見て on を決める
  if (!only || doCandidates) {
    const { parseOverdueNowDigest } = await import("../app/lib/conductor-overdue-promises");
    const { data: odn } = await sb.from("brain_decision_logs").select("odn:digest->odn").gte("created_at", new Date(now - 86_400_000).toISOString()).not("digest->odn", "is", null).limit(2000);
    const rs = ((odn ?? []) as Array<{ odn: unknown }>).map((r) => parseOverdueNowDigest(r.odn)).filter((x): x is NonNullable<typeof x> => !!x);
    if (rs.length) {
      const miss = rs.filter((r) => r.nNow > (r.nTurn ?? 0));
      lines.push(`- 統括に渡す期日超えの約束（本当の今で読んだ記録・前の24時間）: 記録 ${rs.length}番・渡り損ねた番 ${miss.length}（足りなかった約束 ${miss.reduce((a, r) => a + r.nNow - (r.nTurn ?? 0), 0)}件・時間切れで渡らなかった番 ${rs.filter((r) => r.nTurn == null).length}）`, "");
    }
  }

  // 2026-11-26 作業員L（台帳 #505・土台の帳面）: 入口の読みが間に合った割合を毎日の数に（core:intake_reach:in_time・入口を呼ぶ番が分母）
  const intakeReachRows: Array<{ metric: string; value: number | null; n: number }> = [];
  // 2026-11-26 作業員L（台帳 #747 MATERIAL_PRIORITY・統括役の物差し）: 統括の入口が選んだ「まず見る」の行が ①材料の先頭に来た割合 ②その行をブレインが使った割合（前の24時間・digest.mpr・日付で絞った軽い読み）。
  //   あわせて入口の読みが判断に間に合った割合（digest.ci のある番）。mpr の無い日（off）は間に合った割合だけ
  if (!only || doCandidates) {
    try {
      const { materialPriorityMeasures } = await import("../app/lib/material-priority");
      const { data: dg } = await sb.from("brain_decision_logs").select("conversation_id, created_at, conversation_status, digest").gte("created_at", new Date(now - 86_400_000).toISOString()).neq("source", "test").limit(2000);
      const rowsD = (dg ?? []) as Array<{ conversation_id: string; created_at: string; conversation_status: string | null; digest: Record<string, unknown> | null }>;
      const ds = rowsD.map((r) => r.digest ?? {});
      if (ds.length) {
        // 2026-11-26 作業員L（#749）: 分母は入口を呼ぶ番だけ（申込以降は呼ばない決まり・最後の通がこちらの番はお客様の番でない）。会話と時刻で1件ずつの軽い読み
        const POST = new Set(["applying", "application", "screening", "approved", "contract", "closed_won"]);
        let elig = 0, eligCi = 0;
        for (const r of rowsD) {
          if (POST.has(String(r.conversation_status ?? ""))) continue;
          const { data: lm } = await sb.from("messages").select("sender").eq("conversation_id", r.conversation_id).lte("created_at", r.created_at).order("created_at", { ascending: false }).limit(1);
          if (((lm ?? [])[0] as { sender?: string } | undefined)?.sender !== "customer") continue;
          elig++; if (typeof r.digest?.ci === "string") eligCi++;
        }
        intakeReachRows.push({ metric: "core:intake_reach:in_time", value: elig ? Math.round((eligCi / elig) * 1000) / 10 : null, n: elig });
        // 2026-11-26 作業員L（#795 ②）: 決め手の残りが読めた割合は「決めに行く場面の状態」だけで数える（記録・既定 on・mindset:decide_gap_readable）
        { const { readChainCounts } = await import("./audit-customer-read-chain"); const rc = readChainCounts(ds); intakeReachRows.push({ metric: "mindset:decide_gap_readable", value: rc.decideN ? Math.round((rc.decideBlocker / rc.decideN) * 1000) / 10 : null, n: rc.decideN }); lines.push(`- 決め手の残りが読めた（決めに行く場面の状態だけ・前の24時間）: ${rc.decideN ? Math.round((rc.decideBlocker / rc.decideN) * 100) : "—"}%（${rc.decideBlocker}/${rc.decideN}）`); }
        const ci = ds.filter((d) => typeof d.ci === "string").length;
        const m = materialPriorityMeasures(ds);
        lines.push(`- 統括の入口→ブレイン（前の24時間・判断 ${ds.length}番・入口を呼ぶ番 ${elig}）: 入口の読みが間に合った ${elig ? Math.round((eligCi / elig) * 100) : "—"}%（${eligCi}/${elig}・全部の判断では ${ci}）${m.picked ? `｜まず見る: 選んだ番 ${m.picked}（入口の答えあり ${m.ready}）・①先頭に来た ${m.headShare ?? "—"}%・②使った ${m.usedOf ? `${Math.round((m.used / m.usedOf) * 100)}%（${m.used}/${m.usedOf}）` : "—"}` : "｜まず見る: off"}`, "");
        // 2026-11-26 作業員L（竹内さん「統括の連携と優先度・かなり重要」）: MATERIAL_PRIORITY の shadow の当たり（入口が選んだ3つ × 竹内さん本人の一手 × USED_MARKERS・記録は晩の費用0の仕事 mp:shadow_hit）
        try { const { measurePriorityHits } = await import("./audit-material-priority-hit"); const ph = await measurePriorityHits(sb, new Date(now - 86_400_000).toISOString(), new Date(now).toISOString()); lines.push(`- MATERIAL_PRIORITY の shadow の当たり（mpr のある判断 ${ph.withMpr}・竹内さん本人の番 ${ph.turns}）: 当たり ${ph.hit}・外れ ${ph.miss}・決められない ${ph.undecided}${ph.rate != null ? `（${ph.rate}%）` : ""}${Object.keys(ph.byKey).length ? `・目印ごと ${Object.entries(ph.byKey).map(([k, v]) => `${k} ${v.hit}/${v.of}`).join("・")}` : ""}`); } catch (e) { console.warn("[self-improve] shadow の当たりを数えられない:", e instanceof Error ? e.message : String(e)); }
      }
    } catch (e) { console.warn("[self-improve] 入口→ブレインの行を作れない:", e instanceof Error ? e.message : String(e)); }
  }

  // 2026-11-26 作業員L（統括役の決め・今月の昼の試験 $161 が晩の関所の外だった）: 前の日の昼（JST 8〜22時）に流れた試験の DeepSeek の額（0 でなければ ⚠）。日付と route で絞った軽い読み
  if (!only || doCandidates) {
    try {
      const { altUsageUsd } = await import("../app/lib/llm-price");
      const d0 = new Date(now + 9 * 3_600_000 - 24 * 3_600_000).toISOString().slice(0, 10);
      const a = new Date(Date.parse(`${d0}T08:00:00+09:00`)).toISOString(), b = new Date(Date.parse(`${d0}T22:00:00+09:00`)).toISOString();
      let usd = 0, n = 0, lastId = 0;
      for (let page = 0; page < 50; page++) {
        const { data } = await sb.from("llm_usage_logs").select("id, created_at, model, input_uncached, cache_read, output_tokens").gte("created_at", a).lt("created_at", b).like("route", "script:brain-exam%").ilike("model", "deepseek%").gt("id", lastId).order("id").limit(1000);
        const rs = (data ?? []) as Array<{ id: number }>;
        for (const r of rs) { usd += altUsageUsd(r as never); n++; lastId = r.id; }
        if (rs.length < 1000) break;
      }
      lines.push(`- 昼の試験（${d0} の 8〜22時・DeepSeek）: ${n ? `⚠ $${usd.toFixed(2)}（${n}回）＝晩の上限の外で流れた（EXAM_DAY_HOLD）` : "0"}`, "");
    } catch (e) { console.warn("[self-improve] 昼の試験の行を作れない:", e instanceof Error ? e.message : String(e)); }
    // 2026-11-26 作業員L（台帳 #799 ①）: 晩の煙の1問（係の印 conductor-marks/night-smoke-last.json・止めた晩は ⚠）
    try {
      const { smokeMorningLine, SMOKE_MARK_FILE } = await import("./lib/exam-night-smoke");
      const { examCacheRoot } = await import("./lib/llm-cassette");
      const { existsSync: ex, readFileSync: rf } = await import("node:fs");
      const p = `${examCacheRoot()}/conductor-marks/${SMOKE_MARK_FILE}`;
      lines.push(smokeMorningLine(ex(p) ? JSON.parse(rf(p, "utf8")) : null, now), "");
    } catch (e) { console.warn("[self-improve] 晩の煙の1問の行を作れない:", e instanceof Error ? e.message : String(e)); }
  }

  // 2026-11-24 作業員L（台帳 #670・竹内さん 11/24: Claude の月の特典 $200・OpenAI $100）: 今月の API の使用額と月末の見込み（llm_usage_logs×llm-price・月初から・朝の夜の窓で読む）
  const spendRows: Array<{ metric: string; value: number; n: number | null }> = [];
  let healthSpendLs: Array<{ provider: string; spendUsd: number | string; forecastUsd: number | string; creditUsd?: number | string | null; overCredit?: boolean }> = []; // #817 ブレインの健康の費用（下の欄で使う）
  try {
    const [{ monthSums, resetBudgetCache }, { monthSpendLine, readBudgetConfig, spendWindowStart, claudeMonthSpendUsd }] = await Promise.all([import("../app/lib/llm-budget-route-server"), import("../app/lib/llm-budget-route")]);
    resetBudgetCache();
    // 2026-11-25 作業員L（統括役の頼み）: 月の全部の行を読む（前は 50頁＝5万行で止まり $142 と出た・audit-llm-month-cost は $291）。基準（CLAUDE_SPEND_BASE_*）も本番と同じ式で足す
    // 2026-11-25 18:43 の 1枚で「LLM_BUDGET_ROUTE=off・Claude 142.29」と出た（手元の env で読んだ）→ 使用額と切り替えの名前は本番のスイッチの組（prod-env.json）で読む
    const { budgetEnvFrom, readBudgetProdEnv } = await import("./lib/budget-prod-env");
    const pe = readBudgetProdEnv();
    const be = budgetEnvFrom(process.env, pe?.env ?? null);
    const bc = readBudgetConfig(be.env);
    const ms = await monthSums(sb as never, now, be.env, { maxPages: 500 });
    if (ms) {
      const ls = [
        monthSpendLine({ provider: "Claude", spendUsd: claudeMonthSpendUsd(bc, { useBase: spendWindowStart(bc, now).useBase, sinceUsd: ms.claudeUsd }), creditUsd: bc.claudeCreditUsd, nowMs: now }),
        monthSpendLine({ provider: "OpenAI", spendUsd: ms.openaiUsd, creditUsd: bc.openaiCreditUsd, nowMs: now }),
        monthSpendLine({ provider: "DeepSeek", spendUsd: ms.deepseekUsd, creditUsd: 0, nowMs: now }),
      ];
      healthSpendLs = ls as unknown as typeof healthSpendLs;
      if (!only || doCandidates) lines.push(`### API の使用額（今月・llm_usage_logs の記録から・Console と合わない分は CLAUDE_COST_FACTOR）${ms.partial ? "（⚠ 行が多く途中まで）" : ""}`,
        ...ls.map((l) => `- ${l.provider}: ${l.spendUsd}・月末の見込み ${l.forecastUsd}${l.creditUsd ? `（特典 ${l.creditUsd}${l.overCredit ? "・超える見込み" : ""}）` : ""}`),
        // 2026-11-25 統括役の頼み: 本番（route が script: でない）と試験を分けて出す（前は混ぜて「本番のブレインは DeepSeek」と読み違えた）
        `- うち本番（試験を除く）: Claude ${(ms.prod?.claudeUsd ?? 0).toFixed(2)}・OpenAI ${(ms.prod?.openaiUsd ?? 0).toFixed(2)}・DeepSeek ${(ms.prod?.deepseekUsd ?? 0).toFixed(2)}／試験: Claude ${(ms.claudeUsd - (ms.prod?.claudeUsd ?? 0)).toFixed(2)}・OpenAI ${(ms.openaiUsd - (ms.prod?.openaiUsd ?? 0)).toFixed(2)}・DeepSeek ${(ms.deepseekUsd - (ms.prod?.deepseekUsd ?? 0)).toFixed(2)}（Claude は基準より後の行だけ）`,
        `- 切り替え: LLM_BUDGET_ROUTE=${bc.mode}・線 ${bc.switchAtUsd == null ? "未設定" : `${bc.switchAtUsd}`}（${be.from === "prod" ? `本番のスイッチの組 ${pe?.hash.slice(0, 8)}・無い名前はコードの既定` : "⚠ 本番の控えが無く手元の env"}${be.dropped.length ? `・手元の env と違うので捨てた: ${be.dropped.join(" ")}` : ""}）`);
      for (const l of ls) spendRows.push({ metric: `cost:${l.provider.toLowerCase()}_month_usd`, value: l.spendUsd, n: null }, { metric: `cost:${l.provider.toLowerCase()}_month_forecast_usd`, value: l.forecastUsd, n: null });
    }
  } catch (e) { console.warn("[self-improve] API の使用額を読めない:", e instanceof Error ? e.message : String(e)); }

  // 2026-11-27 作業員A（#817・統括役の頼み「朝の1枚にブレインの健康」）: 今ある物差しを1つの欄に束ねる（新しく数えない）。悪い所→変わらない所→分からない所。
  //   悪い所は BRAIN_HEALTH_LEDGER=on かつ --write の時だけ台帳（work_items・origin=found_gap）に積む（既定 off・記録だけから・題で重ねない）
  if (!only || doCandidates) {
    try {
      const bh = await import("./lib/brain-health");
      const items: import("./lib/brain-health").HealthItem[] = [];
      const lk = coreRows.find((r) => r.metric === "core:linkage");
      if (lk) items.push(bh.shareItem({ label: "連携の地図のつながり（core:linkage）", pct: lk.value, n: lk.n }));
      // 効き: on の部品の前後比べ（switch-regress-watch・本番の鍵で版の記録を読む）と夜の見張りの最後の決定（cron_run_logs）
      try {
        const srw = await import("../app/lib/switch-regress-watch");
        const { data: vers } = await sb.from("brain_switch_versions").select("switches, first_seen_at").order("first_seen_at", { ascending: true }).limit(200);
        const { data: qd } = await sb.from("quality_daily").select("day, metric, scope, value, n, source").in("metric", [...srw.WATCH_METRICS]).gte("day", jstDay(now - 70 * 86_400_000)).limit(2000);
        const watch = srw.groupByOnDay(srw.switchesToWatch(srw.switchOnDays((vers ?? []) as never), jstDay(now)));
        items.push(...bh.regressItems(watch.map((w) => srw.decideSwitchRegress({ ...w, rows: (qd ?? []) as never, todayYmd: jstDay(now) }))));
      } catch (e) { items.push({ area: "効き", label: "on の部品の前後比べ", status: "unknown", owner: "作業員A", why: `読めない（${e instanceof Error ? e.message.slice(0, 60) : e}）` }); }
      try {
        const { data: rw } = await sb.from("cron_run_logs").select("result_json").eq("cron_name", "rollout-watch").order("started_at", { ascending: false }).limit(1);
        const ds = ((rw?.[0] as { result_json?: { decisions?: unknown[] } } | undefined)?.result_json?.decisions ?? []) as never[];
        if (ds.length) items.push(...bh.rolloutItems(ds));
        else items.push({ area: "効き", label: "段階の夜の見張り（rollout-watch）", status: "unknown", owner: "作業員A", why: "最後の回の決定が無い（ROLLOUT_WATCH が off か、見張る段が無い）" });
      } catch { /* 見張りの記録なし */ }
      // 2026-11-27 作業員L（A の頼み）: 前の晩の組の届きの関所（dictReachGate・辞書の手の印で）を届きの欄へ・晩の空き枠の行を費用の欄へ
      try {
        const de = await import("./build-exam-dictionary"); const { dictReachGate } = await import("./lib/exam-dictionary"); const { examCacheRoot } = await import("./lib/llm-cassette");
        const dict = de.loadExamDictionary();
        if (dict) {
          const jobs = de.nightJobsOf(`${examCacheRoot()}/exam-queue/results`, 1);
          const rowsOf = new Map(de.readRunsWithMarks(join(process.cwd(), "scripts", "brain-exam", "results")).runs.map((r) => [r.label, r.rowsFull]));
          const reach: Array<{ sw: string; verdict: "比べる" | "届かず" | "印なし"; reached: number; targets: number }> = [];
          for (const j of jobs) { const targets = j.ids.filter((x) => !j.guards.includes(x)); for (const sw of j.switches) { const g = dictReachGate(dict, sw, rowsOf.get(j.label) ?? [], targets); reach.push({ sw: `${sw}（${j.label}）`, verdict: g.verdict, reached: g.reached.length, targets: targets.length }); } }
          items.push(...bh.reachItems(reach));
        } else items.push({ area: "届き", label: "辞書の届きの関所", status: "unknown", owner: "作業員L", why: "試験の辞書が無い（build-exam-dictionary を先に）" });
      } catch (e) { items.push({ area: "届き", label: "辞書の届きの関所", status: "unknown", owner: "作業員L", why: `読めない（${e instanceof Error ? e.message.slice(0, 60) : e}）` }); }
      items.push(...bh.examCostItems({ runs: runs.length, costUsd: cost, worseLabels: worse.map((r) => r.label), capacityLine: nightCapLine }), ...bh.spendItems(healthSpendLs));
      items.push(bh.countItem({ area: "行き止まり", label: "地図の行き止まりの節（#804）", now: null, noRecordWhy: "本番の記録が無い（数えるのは手元の照らしの json・夜の広げの後に quality_daily に載せる）" }));
      items.push(bh.countItem({ area: "答え漏れ", label: "まだ答えていない事（#814）", now: null, noRecordWhy: "UNANSWERED_ASKS_LINE が off（on の後に material_marks.unanswered で数える）" }));
      lines.push(...bh.brainHealthLines(items), "");
      if (flag("write") && bh.brainHealthLedgerOn()) {
        const { data: openH } = await sb.from("work_items").select("title").like("title", "ブレインの健康: %").not("stage", "in", "(done,dropped)").limit(300);
        for (const r of bh.brainHealthLedger(items, ((openH ?? []) as Array<{ title: string }>).map((x) => x.title))) ledger.push({ title: r.title, owner: r.owner, next: r.next, area: r.area, priority: r.priority });
      }
    } catch (e) { console.warn("[self-improve] ブレインの健康の欄を作れない:", e instanceof Error ? e.message : String(e)); }
  }

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
    `- 試験中のスイッチ: ${((testing ?? []) as Array<{ id: number; switch_name: string; owner: string | null }>).map((r) => `#${r.id} ${r.switch_name}（${currentOwnerOf(r.owner)}）`).join("・") || "なし"}`,
    `### ③ on の候補（悪化0 済み）`, ...((passed ?? []) as Array<{ id: number; switch_name: string | null; owner: string | null }>).map((r) => `- #${r.id} ${r.switch_name ?? "-"}（${currentOwnerOf(r.owner)}）`),
    `### ④ 竹内さんへの確認（open ${((oq ?? []) as unknown[]).length}件の上位・KB の下書き ${drafts.length}）`,
    ...((oq ?? []) as Array<{ topic: string; question: string; recommended: string | null }>).map((q) => `- ${q.topic}: ${q.question.slice(0, 60)}${q.recommended ? `（推奨: ${q.recommended.slice(0, 40)}）` : ""}`),
    ...drafts.slice(0, 5).map((p) => `- 下書き P${p.id}: ${String(p.kb_draft).slice(0, 80)}`), "",
    "## 4. 次に何をなぜ（決まった計算）",
    `- 重点の型「${POINTER_KIND_JA[(kinds[0] ?? "other") as PointerKind] ?? "-"}」の穴から直す（竹内さんの指摘の重みが一番大きい）`,
    `- 本番の一致が前の日より下がった物差しがあれば、その日の on のコミットを先に疑う（③の on は一致の線が戻ってから）`, ...(linkNextWhy ? [linkNextWhy] : []));
  // 2026-11-28 作業員L（台帳 #473 の 作業員の割り振り）: 組んだ物を誰が次に取るか（持ち主ごとに todo/building を priority の小さい順・止まっている・次の手が空・芯の直しの宛先）
  if (doCandidates) {
    const { data: openWi, error: owe } = await sb.from("work_items").select("id,title,owner,stage,priority,updated_at,next_step,switch_name,blocker").in("stage", ["todo", "building"]).limit(1000);
    if (owe) lines.push(`### 作業員ごとの割り振り`, `- 台帳が読めない: ${owe.message}`);
    else { const { workerPlans, workerPlanLines } = await import("./lib/worker-assign"); lines.push(...workerPlanLines(workerPlans((openWi ?? []) as import("./lib/worker-assign").AssignItem[], coreFix, now), now)); }
  }

  // 2026-11-23 作業員N2（台帳 #473・統括役の頼み）: 竹内さんが朝に読む順に並べ直す（中身は変えない・止める SELF_IMPROVE_SHEET_ORDER=off）
  const sheet = (process.env.SELF_IMPROVE_SHEET_ORDER ?? "").trim().toLowerCase() === "off" ? lines : orderSheetLines(lines);
  const md = sheet.join("\n") + "\n";
  const out = arg("out", `${MEMORY_DIR}/${day}.md`);
  if (flag("write")) {
    if (!only) { mkdirSync(dirname(out), { recursive: true }); writeFileSync(out, md); }
    const rows = [
      { day, metric: "reply_match", scope: "takeuchi", value: mTk.match, n: mTk.n }, { day, metric: "reply_match", scope: "all", value: mAll.match, n: mAll.n },
      { day, metric: "aix_first_match", scope: "takeuchi", value: mMain.firstTk.rate, n: mMain.firstTk.n }, { day, metric: "aix_first_match", scope: "all", value: mMain.firstAll.rate, n: mMain.firstAll.n },
      ...spendRows.map((r) => ({ day: jstDay(now), metric: r.metric, scope: "all", value: r.value, n: r.n })),
      ...intakeReachRows.map((r) => ({ day: jstDay(now), metric: r.metric, scope: "all", value: r.value, n: r.n })),
      { day, metric: "exam_cost_usd", scope: "all", value: cost, n: runs.length }, { day, metric: "exam_worse_runs", scope: "all", value: worse.length, n: runs.length },
      ...outs.map((o) => ({ day, metric: `check_gaps:${o.kind}`, scope: "all", value: o.gaps.length, n: null })),
      // 2026-11-23 作業員N2（統括役の頼み）: 穴のまとまりの数（上）は残し、まとまりが表す行の数を並べる（not_subdivided の 8 は地図の7行＋設計知見 89行＋欄4つ）
      ...outs.map((o) => ({ day, metric: `check_gaps_rows:${o.kind}`, scope: "all", value: gapRowsOf(o.gaps), n: o.gaps.length })),
      ...growthRows.map((r) => ({ day, metric: r.metric, scope: r.key === "writer_link" ? "all" : "takeuchi", value: r.value, n: r.n })),
      ...Object.entries(ed.features).map(([k, n]) => ({ day, metric: `growth:pickup_edit_feature:${k}`, scope: "takeuchi", value: n, n: null })),
      ...coreRows.map((r) => ({ day: jstDay(now), metric: r.metric, scope: "all", value: r.value, n: r.n })),
      ...puRows.map((r) => ({ day: jstDay(now - 86_400_000), metric: r.metric, scope: "all", value: r.value, n: r.n })),
      ...fillRows.map((r) => ({ day: jstDay(now), metric: r.metric, scope: "all", value: r.value, n: r.n, ...(r.detail ? { detail: r.detail } : {}) })),
      ...flexRows.map((r) => ({ day: jstDay(now), metric: r.metric, scope: "takeuchi", value: r.value, n: r.n })),
      ...foundRows.map((r) => ({ day: jstDay(now), metric: r.metric, scope: "all", value: r.value, n: r.n })),
      ...wmRows.map((r) => ({ day: jstDay(now), metric: r.metric, scope: r.scope, value: r.value, n: r.n, ...(r.detail ? { detail: r.detail } : {}) })),
      ...avRows.map((r) => ({ day: jstDay(now - 86_400_000), metric: r.metric, scope: "all", value: r.value, n: r.n })),
      ...(cd ? [{ day, metric: "growth:combo:AIX→返信の外れ", scope: "takeuchi", value: cd.aixToReply, n: cd.n }, { day, metric: "growth:combo:返信→AIX の外れ", scope: "takeuchi", value: cd.replyToAix, n: cd.n }, { day, metric: "growth:combo:2つ目の AIX の取りこぼし", scope: "takeuchi", value: cd.secondAixMiss, n: cd.n }, ...Object.entries(cd.aixToReplyByKind).map(([k, v]) => ({ day, metric: `growth:combo:AIX→返信の外れ:${k}`, scope: "takeuchi", value: v, n: cd.n })),
        // 2026-11-22 作業員N2（作業員M の頼み・台帳 #520）: 要件の帳面の分け（combo-daily の同じ番・14日・記録なしは分母外）。合うは合う率（%）
        { day, metric: "growth:ask:取りこぼし", scope: "takeuchi", value: cd.ask.取りこぼし, n: cd.ask.n }, { day, metric: "growth:ask:重ね", scope: "takeuchi", value: cd.ask.重ね, n: cd.ask.n },
        { day, metric: "growth:ask:取り違え", scope: "takeuchi", value: cd.ask.取り違え, n: cd.ask.n }, { day, metric: "growth:ask:合う", scope: "takeuchi", value: cd.ask.合う率, n: cd.ask.n }] : []),
    ].filter((r) => (r.metric.startsWith("core:") ? doCore : true) && (doMetrics || r.metric.startsWith("core:") || !/^(?:reply_match|aix_first_match|growth:)/.test(r.metric)) && (doChecks || !/^check_gaps(?:_rows)?:/.test(r.metric)) && (!only || only === "metrics" || !/^exam_/.test(r.metric) || doCandidates))
     .filter((r) => !only || only === "metrics" || (only === "core" && r.metric.startsWith("core:")))
     .map((r) => ({ ...r, source: only ? `scripts/self-improve.ts --only=${only}` : "scripts/self-improve.ts" }));
    if (rows.length) { const { error } = await sb.from("quality_daily").upsert(rows, { onConflict: "day,metric,scope" }); if (error) throw new Error(`quality_daily: ${error.message}`); }
    if (mapQd.length) { const { error } = await sb.from("quality_daily").upsert(mapQd.map((r) => ({ ...r, source: "scripts/self-improve.ts（芯 ⑤ 地図・#610）" })), { onConflict: "day,metric,scope" }); if (error) console.log(`quality_daily（地図）: ${error.message}`); }
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
