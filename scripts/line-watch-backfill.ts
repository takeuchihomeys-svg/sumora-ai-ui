// scripts/line-watch-backfill.ts — 見張り（line_watch_turns）の過去の番を埋め戻す（LLM なし・費用 0）
//
// 2026-10-08 竹内さんの決定 10/08 の1「見張りの一致の判定（10/01〜）を過去1〜3ヶ月分埋める」→ 場面ごとの一致率を1ヶ月単位で（scripts/line-watch-monthly.ts）
//   番の切り方・申込以降の外し方 … scripts/audit-r10-path-truth.ts（10巡目の正解の表）と同じ（app/lib/line-watch-backfill.pastTurnsOf）
//   その時の AI の案              … ai_reply_examples（line_reply）の ai_draft（返事のまとまりの文と送った時刻が合う物だけ）
//   ブレインの判断                … brain_decision_logs（9/05〜）
//   判定                          … app/lib/line-watch-turn-eval.evalWatchTurn（毎晩の cron と同じ関数・JUDGE_VERSION も同じ）
//
// 書き込みの決まり:
//   ・新しい行を足すだけ（upsert ignoreDuplicates＝既にある (conversation_id, customer_turn_at) は触らない）。控えが動き始めた時刻（--until 既定・10/01 00:01Z）より前に始まった番だけ
//   ・印は verdict_detail.backfill（'ai_reply_examples'｜'brain_decision_logs'）・backfill_at・bf_example・bf_decision・bf_scene_src。
//     列（backfill_source）を足す形と比べて JSON にした: ①DDL を流す前でも足せる ②読む側（解禁の線 sceneStats・自動返信の関所）が列の有無で落ちない
//     ③毎晩の cron は verdict_detail を読み直さない（下の④）ので印が消えない ④行数は数千で、印で絞る索引は要らない（月ごとの集計は全件を読む）
//   ・毎晩の cron（line-watch-eval）に読み直されない: 読むのは「直近4日の番」と「evaluated_at が空の30日の番」だけ → evaluated_at・judge_version・final を入れる
//   ・created_at・updated_at は番の時刻（今の時刻にすると「控えの様子（24時間の控えの数）」と auto-reply-readiness の30日に入る）
//   ・トリガーが今後この鍵で控えないよう、番の後にスタッフの発言がある番だけ（最後の番が開いたままの会話は入れない）
//
// 実行: npx tsx --env-file=.env.local scripts/line-watch-backfill.ts [--since=2026-07-01T00:00:00+09:00] [--until=<控えが動き始めた時刻＝今の控えの一番古い created_at>] [--apply] [--samples=10]
//   既定は dry（書かない）。--apply で足す。40日以内の番を足す時は --readers-deployed（読む側が埋め戻しを外す版の本番が出た後だけ）
//   --compare-live: 控えのある番に同じ作り方を当てて控えの判定と比べる（書かない・物差しの校正）
import { createClient } from "@supabase/supabase-js";
import { isTestConversation } from "../app/lib/test-conversations";
import { APPLY_FORM_RE } from "../app/lib/customer-sim-shadow";
import { STAFF_FAIL_RE } from "../app/lib/post-apply-brain-gate";
import { pastTurnsOf, planBackfillTurn, guardBackfillJudgement, jstMonthOf, BACKFILL_KEY, type BfMsg, type BfPress, type BfExample, type BfDecision, type SkipReason } from "../app/lib/line-watch-backfill";
import { evalWatchTurn } from "../app/lib/line-watch-turn-eval";
import { sceneStatsByMonth, type StatTurn } from "../app/lib/line-watch-daily";
import { VERDICT_JA, JUDGE_VERSION, type Verdict } from "../app/lib/line-watch-judge";

const sb = createClient(process.env.NEXT_PUBLIC_SUPABASE_URL ?? "", process.env.SUPABASE_SERVICE_ROLE_KEY ?? process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY ?? "");
const arg = (k: string, d = "") => process.argv.find((a) => a.startsWith(`--${k}=`))?.slice(k.length + 3) ?? d;
const APPLY = process.argv.includes("--apply");
// 物差しの校正（書かない）: 控えのある番（10/01〜）にも同じ埋め戻しの作り方を当て、控えの判定と比べる（--since=2026-10-01T09:00:00+09:00 --until=<今> と一緒に）
const COMPARE_LIVE = process.argv.includes("--compare-live");
const SINCE = arg("since", "2026-07-01T00:00:00+09:00");
const SAMPLES = Number(arg("samples", "10"));
const SAMPLE_REASON = arg("sample-reason"); // 見本をこの理由だけに（例 fact_conflict）
const DAY = 86_400_000;
const ms = (s: string) => Date.parse(s);
const iso = (n: number) => new Date(n).toISOString();
const mask = (s: string) => s.replace(/0\d{1,3}-?\d{2,4}-?\d{3,4}/g, "〈電話〉").replace(/[\w.+-]+@[\w-]+\.[\w.]+/g, "〈メール〉").replace(/https?:\/\/\S+/g, "〈URL〉");

async function readAll<T>(q: (f: number, t: number) => PromiseLike<{ data: unknown; error: { message: string } | null }>): Promise<T[]> {
  const out: T[] = [];
  for (let i = 0; i < 2_000_000; i += 1000) { const r = await q(i, i + 999); if (r.error) throw new Error(r.error.message); const d = (r.data ?? []) as T[]; out.push(...d); if (d.length < 1000) break; }
  return out;
}

(async () => {
  const nowMs = Date.now();
  // 控え（トリガー）が動き始めた時刻＝今の控えの一番古い created_at（10/01 00:01Z）→ それより前に始まった番だけ埋める。
  //   ※ 番の鍵は連投の最初の発言なので、10/01 より前に始まって開いたままだった番の控えもある（5/25〜9/30 に 36行）→ 同じ鍵は exists で飛ばす
  const live = await readAll<{ conversation_id: string; customer_turn_at: string; created_at: string; verdict: string | null; scene_key: string | null; verdict_detail: Record<string, unknown> | null }>((f, t) => sb.from("line_watch_turns").select("conversation_id, customer_turn_at, created_at, verdict, scene_key, verdict_detail").order("id").range(f, t));
  const liveOnly = live.filter((r) => !r.verdict_detail?.[BACKFILL_KEY]);
  const minLive = liveOnly.reduce((m, r) => Math.min(m, ms(r.created_at)), Infinity);
  const UNTIL = arg("until", Number.isFinite(minLive) ? iso(minLive) : "2026-10-01T00:00:00Z");
  const existing = new Set(live.map((r) => `${r.conversation_id}|${ms(r.customer_turn_at)}`));
  const liveByKey = new Map(liveOnly.map((r) => [`${r.conversation_id}|${ms(r.customer_turn_at)}`, r]));
  const pairs: Array<{ live: string; bf: string; liveScene: string; bfScene: string; liveReason: string; bfReason: string }> = [];
  const sinceMs = ms(SINCE), untilMs = ms(UNTIL);
  console.log(`# 見張りの埋め戻し（${APPLY ? "書く" : "dry"}）番 ${SINCE} 〜 ${UNTIL}（未満）｜判定 ${JUDGE_VERSION}｜既にある行 ${live.length}（埋め戻し済み ${live.length - liveOnly.length}）`);

  type Msg = BfMsg & { id: number; conversation_id: string };
  type Press = BfPress & { conversation_id: string };
  type Ex = BfExample & { reply_context_snapshot?: unknown };
  type Dec = BfDecision & { conversation_id: string; suggested_check_pattern: string | null; scene_evidence: string | null };
  const [msgs, presses, exs, decs, convs] = await Promise.all([
    readAll<Msg>((f, t) => sb.from("messages").select("id, conversation_id, sender, created_at, text, is_aix_generated").gte("created_at", iso(sinceMs - 120 * DAY)).lt("created_at", iso(untilMs + 2 * DAY)).order("created_at").order("id").range(f, t)),
    readAll<Press>((f, t) => sb.from("aix_usage_logs").select("conversation_id, aix_type, check_pattern, app_sub_mode, created_at").gte("created_at", iso(sinceMs - 120 * DAY)).lt("created_at", iso(untilMs + 2 * DAY)).not("aix_type", "is", null).order("created_at").order("id").range(f, t)),
    readAll<Ex>((f, t) => sb.from("ai_reply_examples").select("id, conversation_id, sent_at, created_at, ai_draft, entry_source, pii_redacted_at, customer_intent, tpo_label:reply_context_snapshot->>tpo_label, draft_head:reply_context_snapshot->>draftHead, snap_stance:reply_context_snapshot->>stance_sent_lite").eq("entry_source", "line_reply").not("conversation_id", "is", null).gte("created_at", iso(sinceMs - DAY)).lt("created_at", iso(untilMs + 2 * DAY)).order("created_at").order("id").range(f, t)),
    readAll<Dec>((f, t) => sb.from("brain_decision_logs").select("id, conversation_id, created_at, analyzed_msg_ts, suggested_action, suggested_reply_mode, suggested_check_pattern, scene_evidence, conversation_status, intent:digest->>intent").lt("created_at", iso(untilMs + 2 * DAY)).order("created_at").order("id").range(f, t)),
    readAll<{ id: string }>((f, t) => sb.from("conversations").select("id").order("id").range(f, t)),
  ]);
  const convSet = new Set(convs.map((c) => c.id));
  // snapshot の有無（どれかの鍵があれば有る。jsonb を丸ごと読まない。下書きの空の手本の snapshot の多くは送った時に付ける stance_sent_lite だけ＝送信の時点の下書きの記録が無い）
  for (const e of exs as Array<Ex & { snap_stance?: string | null }>) e.has_snapshot = e.tpo_label != null || e.draft_head != null || e.snap_stance != null;
  const by = <T extends { conversation_id: string }>(rows: T[]) => { const m = new Map<string, T[]>(); for (const r of rows) { if (!m.has(r.conversation_id)) m.set(r.conversation_id, []); m.get(r.conversation_id)!.push(r); } return m; };
  const mBy = by(msgs), pBy = by(presses), eBy = by(exs), dBy = by(decs);
  // 申込以降の始まり（申込フォーム・申込へ）は古い物も要るので、メッセージと押下は120日前から読む（pastTurnsOf が使う）
  console.log(`読んだ: メッセージ ${msgs.length}・押下 ${presses.length}・手本（line_reply）${exs.length}・ブレインの判断 ${decs.length}`);

  const skips: Record<string, number> = {};
  const skip = (k: SkipReason | "test" | "exists" | "no_conversation" | "out_of_range") => { skips[k] = (skips[k] ?? 0) + 1; };
  const rows: Array<Record<string, unknown>> = [];
  const stat: StatTurn[] = [];
  const usedExamples = new Set<string>();
  let staleN = 0;
  const guarded: Record<string, number> = {};
  for (const [conv, mm] of mBy) {
    if (isTestConversation(conv)) { skip("test"); continue; }
    if (!convSet.has(conv)) { skip("no_conversation"); continue; }
    const ps = pBy.get(conv) ?? [];
    for (const turn of pastTurnsOf(mm, ps, { applyFormRe: APPLY_FORM_RE, staffFailRe: STAFF_FAIL_RE })) {
      const tMs = ms(turn.turnAt);
      if (tMs < sinceMs || tMs >= untilMs) { skip("out_of_range"); continue; }
      if (!COMPARE_LIVE && existing.has(`${conv}|${tMs}`)) { skip("exists"); continue; }
      if (COMPARE_LIVE && !liveByKey.has(`${conv}|${tMs}`)) { skip("exists"); continue; }
      const plan = planBackfillTurn({ conversationId: conv, turn, msgs: mm, presses: ps, examples: eBy.get(conv) ?? [], decisions: dBy.get(conv) ?? [], nowMs });
      if ("skip" in plan) { skip(plan.skip); continue; }
      const ev = evalWatchTurn(plan.input, { msgs: mm, presses: ps, decisions: dBy.get(conv) ?? [], nowMs, intentFallback: plan.intentFallback });
      const dec = plan.decision as Dec | null;
      if (plan.example) usedExamples.add(plan.example.id);
      if (plan.staleExample) staleN++;
      // 材料が残っていない所は na（元の判定は bf_raw）
      const g = guardBackfillJudgement(ev.judgement, { hasDraft: !!plan.example || plan.draftKnownAbsent, hasBrain: (plan.input.brain_versions ?? 0) > 0 });
      if (g.bfNa) guarded[g.bfNa] = (guarded[g.bfNa] ?? 0) + 1;
      ev.patch.verdict = g.verdict;
      const detail = { ...g.detail, [BACKFILL_KEY]: plan.source, backfill_at: iso(nowMs), bf_example: plan.example?.id ?? null, bf_stale_example: plan.staleExample, bf_draft_absent: plan.draftKnownAbsent || undefined, bf_decision: dec?.id ?? null, bf_scene_src: plan.sceneSrc, ...(g.bfNa ? { bf_na: g.bfNa } : {}) };
      const row: Record<string, unknown> = {
        ...plan.input,
        draft_first: plan.input.draft_last,
        customer_last_at: plan.customerLastAt,
        created_at: turn.turnAt,
        updated_at: turn.turnAt,
        brain_check_pattern: dec?.suggested_check_pattern ?? null,
        brain_analyzed_msg_ts: dec?.analyzed_msg_ts ?? null,
        scene_evidence: dec?.scene_evidence ? String(dec.scene_evidence).slice(0, 500) : null,
        brain_at: dec?.created_at ?? null,
        ...ev.patch,
        verdict_detail: detail,
      };
      rows.push(row);
      if (COMPARE_LIVE) { const lv = liveByKey.get(`${conv}|${tMs}`)!; pairs.push({ live: String(lv.verdict), bf: String(g.verdict), liveScene: String(lv.scene_key), bfScene: ev.scene.key, liveReason: String(lv.verdict_detail?.reason ?? ""), bfReason: String(detail.reason) }); }
      stat.push({ conversation_id: conv, customer_turn_at: turn.turnAt, scene_key: ev.scene.key, verdict: g.verdict, verdict_detail: detail as unknown as StatTurn["verdict_detail"] });
    }
  }

  // ─── 内訳 ───
  const count = <T>(xs: T[], f: (x: T) => string) => { const m = new Map<string, number>(); for (const x of xs) { const k = f(x); m.set(k, (m.get(k) ?? 0) + 1); } return [...m].sort((a, b) => b[1] - a[1]); };
  console.log(`\n足す行 ${rows.length}｜入れない番: ${Object.entries(skips).map(([k, v]) => `${k} ${v}`).join("・")}`);
  console.log(`使った手本 ${usedExamples.size}/${exs.length}・前の番の下書きのままで使わなかった手本 ${staleN}｜材料が無く na にした判定: ${Object.entries(guarded).map(([k, v]) => `${k} ${v}`).join("・") || "0"}`);
  for (const [mo, n] of count(rows, (r) => jstMonthOf(String(r.customer_turn_at))).sort()) {
    const rs = rows.filter((r) => jstMonthOf(String(r.customer_turn_at)) === mo);
    console.log(`  ${mo}: ${n}行｜印 ${count(rs, (r) => String((r.verdict_detail as Record<string, unknown>)[BACKFILL_KEY])).map(([k, v]) => `${k} ${v}`).join("・")}｜判定 ${count(rs, (r) => String(r.verdict)).map(([k, v]) => `${k} ${v}`).join("・")}｜場面の材料 ${count(rs, (r) => String((r.verdict_detail as Record<string, unknown>).bf_scene_src)).map(([k, v]) => `${k} ${v}`).join("・")}`);
  }
  console.log(`\n理由: ${count(rows, (r) => String((r.verdict_detail as Record<string, unknown>).reason)).map(([k, v]) => `${k} ${v}`).join("・")}`);
  console.log(`下書きの欄: ${count(rows, (r) => String((r.verdict_detail as Record<string, unknown>).draft_src)).map(([k, v]) => `${k} ${v}`).join("・")}`);
  console.log(`final=false（窓が閉じていない）: ${rows.filter((r) => (r.verdict_detail as Record<string, unknown>).final !== true).length}・verdict=null: ${rows.filter((r) => r.verdict == null).length}`);

  console.log(`\n## 場面ごとの一致率（1ヶ月単位・足す行だけ）`);
  for (const r of sceneStatsByMonth(stat).filter((x) => x.win.n >= 5 || x.scene.includes("全体"))) {
    console.log(`  ${r.month} ${r.scene.padEnd(24)} n=${String(r.win.n).padStart(4)} 一致 ${r.win.rate == null ? "—" : `${Math.round(r.win.rate * 100)}%`}｜そのまま ${r.win.same}・別の事 ${r.win.different}・事実違い ${r.win.factDiff}｜文 ${r.win.textAgree}/${r.win.textN}`);
  }

  // 見本（判定ごとに散らす・目で読む）
  console.log(`\n## 見本 ${SAMPLES}件`);
  const order: Array<Verdict | "null"> = ["different", "partial", "same_meaning", "same", "na"];
  const picked: Array<Record<string, unknown>> = [];
  for (let k = 0; picked.length < SAMPLES && k < 50; k++) {
    for (const v of order) {
      const pool = rows.filter((r) => String(r.verdict) === v && !picked.includes(r) && (!SAMPLE_REASON || (r.verdict_detail as Record<string, unknown>).reason === SAMPLE_REASON));
      if (pool.length && picked.length < SAMPLES) picked.push(pool[(k * 37 + 11) % pool.length]);
    }
  }
  for (const r of picked) {
    const d = r.verdict_detail as Record<string, unknown>;
    const st = ((r.staff_texts as Array<{ burst: boolean; text: string }>) ?? []).filter((x) => x.burst).map((x) => x.text).join(" / ");
    const msgsC = (mBy.get(String(r.conversation_id)) ?? []).filter((m) => m.sender === "customer" && ms(m.created_at) >= ms(String(r.customer_turn_at)) && ms(m.created_at) <= ms(String(r.customer_last_at)));
    console.log(`--- ${String(r.customer_turn_at).slice(0, 16)} ${String(r.conversation_id).slice(0, 8)} 場面=${r.scene_key} 判定=${VERDICT_JA[r.verdict as Verdict] ?? r.verdict}（${d.reason}）印=${d[BACKFILL_KEY]} brain=${r.brain_action ?? "-"}/${r.brain_reply_mode ?? "-"} 押下=${((r.staff_aix as Array<{ aix_type: string; burst: boolean }>) ?? []).map((p) => `${p.aix_type}${p.burst ? "" : "(後)"}`).join(",") || "-"}`);
    console.log(`    客「${mask(msgsC.map((m) => m.text ?? "").join(" ")).replace(/\n/g, " ").slice(0, 110)}」`);
    console.log(`    案「${mask(String(r.draft_last ?? "")).replace(/\n/g, " ").slice(0, 150)}」`);
    console.log(`    人「${mask(st).replace(/\n/g, " ").slice(0, 150)}」${d.facts ? `  事実=${JSON.stringify(d.facts)}` : ""}`);
  }

  if (COMPARE_LIVE) {
    const agree = (v: string) => v === "same" || v === "same_meaning";
    const counted = pairs.filter((p) => p.live !== "na" && p.live !== "null" && p.bf !== "na");
    console.log(`
## 校正: 控えの判定 × 埋め戻しの作り方（同じ番 ${pairs.length}・両方数えた番 ${counted.length}）`);
    console.log(`  一致率 控え ${counted.filter((p) => agree(p.live)).length}/${counted.length}・埋め戻し ${counted.filter((p) => agree(p.bf)).length}/${counted.length}｜判定が同じ ${counted.filter((p) => p.live === p.bf).length}・一致/不一致が同じ ${counted.filter((p) => agree(p.live) === agree(p.bf)).length}｜場面が同じ ${pairs.filter((p) => p.liveScene === p.bfScene).length}/${pairs.length}`);
    for (const [k, v] of count(pairs, (p) => `控え ${p.live}(${p.liveReason}) → 埋め戻し ${p.bf}(${p.bfReason})`).slice(0, 25)) console.log(`  ${k.padEnd(70)} ${v}`);
    return;
  }
  if (!APPLY) { console.log(`\n（dry: 書いていない。--apply で ${rows.length}行を足す）`); return; }
  // 40日以内の番は、本番の読む側（解禁の線 sceneStats・自動返信の関所・画面の集計）が埋め戻しを外す版になってから足す（古い版は35日・30日を読み、外さずに数える）
  const recent = rows.filter((r) => nowMs - ms(String(r.customer_turn_at)) < 40 * DAY).length;
  if (recent && !process.argv.includes("--readers-deployed")) {
    console.error(`
止めた: 40日以内の番 ${recent}行。本番に line-watch-daily.sceneStats・watch-aix-match の埋め戻しを外す版が出てから --readers-deployed を付けて流す`);
    process.exit(2);
  }
  let ok = 0, dup = 0, fail = 0;
  for (let i = 0; i < rows.length; i += 200) {
    const chunk = rows.slice(i, i + 200);
    const r = await sb.from("line_watch_turns").upsert(chunk, { onConflict: "conversation_id,customer_turn_at", ignoreDuplicates: true }).select("id");
    if (r.error) { fail += chunk.length; console.error(`  失敗 ${i}: ${r.error.message}`); continue; }
    ok += (r.data ?? []).length; dup += chunk.length - (r.data ?? []).length;
  }
  console.log(`\n書いた: 足した ${ok}・既にあって飛ばした ${dup}・失敗 ${fail}`);
})().catch((e) => { console.error(e); process.exit(1); });
