// scripts/line-watch-capture-gap-backfill.ts — 見張りの控えが止まった区間の番を、送信の記録（ai_reply_examples）とブレインの記録から埋める（LLM なし・費用 0）
//
// 2026-10-20: トリガー capture_line_watch_turn が失敗を WARNING で飲み（EXCEPTION WHEN OTHERS）、10/12 12:34Z〜10/15 00:01Z の約60時間、
//   番の行（line_watch_turns）はできたが下書き・ブレインの欄が1つも入らなかった（ブレインも下書きも実際は動いていた＝ai_reply_examples に下書き 45件）。
//   この区間の番が「下書きなし（手打ち）」に数えられている（63番）。scripts/line-watch-backfill.ts（過去の番の埋め戻し）と同じ作り方で埋める:
//     その時の AI の案 … ai_reply_examples（line_reply）の ai_draft（返事のまとまりの文と送った時刻が合う物・前の番の下書きのままの物は使わない）
//     ブレインの判断 … brain_decision_logs（番の中の判断で、スタッフの最初の行動より前の最後の物）
//     判定         … line-watch-turn-eval.evalWatchTurn（毎晩の cron と同じ関数）＋ guardBackfillJudgement（材料が無い所は na）
//     申込以降     … line-watch-scope.postApplyAtTurn（下書きの関所と同じ resolvePostApply・番の時点の記録）→ 埋めない
//
// 書き込みの決まり（--apply の時だけ・既定は dry＝読むだけ）:
//   ・新しい行は作らない。区間の中の「控えの欄が全部空」（brain_at・draft_first・draft_last・draft_sentinel・final_check が null）の行だけを update する
//     （update にも同じ条件を付ける＝その間にトリガーが埋めた行は触らない）
//   ・1段目の欄（下書き・ブレイン）＋2段目の欄（判定）を書く。印は verdict_detail.backfill（手本 or ブレインの判断）と bf_capture_gap=true
//     → 埋め戻しの行は解禁の線（sceneStats）・自動返信の関所から外れる（下書きを作った時刻が残っていないので「今の控え」と同じには数えない）。
//       月ごとの一致率（sceneStatsByMonth）・下書きの差の型の集計（audit-draft-diff-types）には「埋め戻し」として別に出る
//   ・created_at・updated_at は触らない（控えの様子の数・auto-reply-readiness の30日は今のまま）
//   ・⚠ DB に書く。流すのは竹内さんの OK の後だけ
//
// 実行: npx tsx --env-file=.env.local scripts/line-watch-capture-gap-backfill.ts [--from=2026-10-12T12:34:00Z] [--to=2026-10-15T00:01:00Z] [--samples=8] [--apply]
import { createClient } from "@supabase/supabase-js";
import { isTestConversation } from "../app/lib/test-conversations";
import { planBackfillTurn, guardBackfillJudgement, BACKFILL_KEY, type BfMsg, type BfPress, type BfExample, type BfDecision, type PastTurn } from "../app/lib/line-watch-backfill";
import { evalWatchTurn } from "../app/lib/line-watch-turn-eval";
import { postApplyAtTurn, type PostApplyTimeline } from "../app/lib/line-watch-scope";
import { loadPostApplyTimelines } from "../app/lib/line-watch-eval-server";
import { cleanDraft } from "../app/lib/line-watch-judge";

const sb = createClient(process.env.NEXT_PUBLIC_SUPABASE_URL ?? "", process.env.SUPABASE_SERVICE_ROLE_KEY ?? process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY ?? "");
const arg = (k: string, d = "") => process.argv.find((a) => a.startsWith(`--${k}=`))?.slice(k.length + 3) ?? d;
const APPLY = process.argv.includes("--apply");
const FROM = arg("from", "2026-10-12T12:34:00Z");
const TO = arg("to", "2026-10-15T00:01:00Z");
const SAMPLES = Number(arg("samples", "8"));
const DAY = 86_400_000;
const ms = (s: string) => Date.parse(s);
const iso = (n: number) => new Date(n).toISOString();
const mask = (s: string) => s.replace(/0\d{1,3}-?\d{2,4}-?\d{3,4}/g, "〈電話〉").replace(/[\w.+-]+@[\w-]+\.[\w.]+/g, "〈メール〉").replace(/https?:\/\/\S+/g, "〈URL〉").replace(/\d{3,}/g, "〈数〉");

async function readAll<T>(q: (f: number, t: number) => PromiseLike<{ data: unknown; error: { message: string } | null }>): Promise<T[]> {
  const out: T[] = [];
  for (let i = 0; i < 1_000_000; i += 1000) { const r = await q(i, i + 999); if (r.error) throw new Error(r.error.message); const d = (r.data ?? []) as T[]; out.push(...d); if (d.length < 1000) break; }
  return out;
}

type Row = { id: number; conversation_id: string; customer_turn_at: string; customer_last_at: string | null; conv_status: string | null; verdict: string | null; verdict_detail: Record<string, unknown> | null };

(async () => {
  const nowMs = Date.now();
  const fromMs = ms(FROM), toMs = ms(TO);
  if (!Number.isFinite(fromMs) || !Number.isFinite(toMs) || toMs <= fromMs) throw new Error("--from / --to が読めない");
  console.log(`# 見張りの控えの止まりの埋め戻し（${APPLY ? "書く" : "dry＝読むだけ"}）番 ${FROM} 〜 ${TO}`);

  const all = await readAll<Row & { brain_at: string | null; draft_first: string | null; draft_last: string | null; draft_sentinel: string | null; final_check: unknown }>((f, t) =>
    sb.from("line_watch_turns").select("id, conversation_id, customer_turn_at, customer_last_at, conv_status, verdict, verdict_detail, brain_at, draft_first, draft_last, draft_sentinel, final_check")
      .gte("customer_turn_at", FROM).lt("customer_turn_at", TO).order("customer_turn_at").order("id").range(f, t));
  const empty = all.filter((r) => !r.brain_at && !r.draft_first && !r.draft_last && !r.draft_sentinel && !r.final_check && !r.verdict_detail?.[BACKFILL_KEY]);
  const target = empty.filter((r) => !isTestConversation(r.conversation_id));
  console.log(`区間の行 ${all.length}・控えの欄が全部空 ${empty.length}（テスト用の会話を除いて ${target.length}）`);
  if (!target.length) return;

  const convIds = [...new Set(target.map((r) => r.conversation_id))];
  type Msg = BfMsg & { conversation_id: string };
  type Press = BfPress & { conversation_id: string };
  type Ex = BfExample;
  type Dec = BfDecision & { conversation_id: string; suggested_check_pattern: string | null; scene_evidence: string | null };
  const msgs: Msg[] = [], presses: Press[] = [], exs: Ex[] = [], decs: Dec[] = [];
  const since = iso(fromMs - 5 * DAY), until = iso(toMs + 3 * DAY);
  for (let i = 0; i < convIds.length; i += 40) {
    const ch = convIds.slice(i, i + 40);
    msgs.push(...await readAll<Msg>((f, t) => sb.from("messages").select("conversation_id, sender, created_at, text, is_aix_generated").in("conversation_id", ch).gte("created_at", since).lt("created_at", until).order("created_at").order("id").range(f, t)));
    presses.push(...await readAll<Press>((f, t) => sb.from("aix_usage_logs").select("conversation_id, aix_type, check_pattern, app_sub_mode, created_at").in("conversation_id", ch).gte("created_at", since).lt("created_at", until).not("aix_type", "is", null).order("created_at").order("id").range(f, t)));
    const ex = await readAll<Ex & { snap_stance?: string | null }>((f, t) => sb.from("ai_reply_examples").select("id, conversation_id, sent_at, created_at, ai_draft, entry_source, pii_redacted_at, customer_intent, tpo_label:reply_context_snapshot->>tpo_label, draft_head:reply_context_snapshot->>draftHead, snap_stance:reply_context_snapshot->>stance_sent_lite").in("conversation_id", ch).eq("entry_source", "line_reply").gte("created_at", since).lt("created_at", until).order("created_at").order("id").range(f, t));
    for (const e of ex) e.has_snapshot = e.tpo_label != null || e.draft_head != null || e.snap_stance != null;
    exs.push(...ex);
    decs.push(...await readAll<Dec>((f, t) => sb.from("brain_decision_logs").select("id, conversation_id, created_at, analyzed_msg_ts, suggested_action, suggested_reply_mode, suggested_check_pattern, scene_evidence, conversation_status, intent:digest->>intent").in("conversation_id", ch).gte("created_at", since).lt("created_at", until).order("created_at").order("id").range(f, t)));
  }
  let timelines: Map<string, PostApplyTimeline> | null = null;
  try { timelines = await loadPostApplyTimelines(sb, convIds); } catch (e) { console.warn(`申込の記録が読めない（status だけで判定）: ${e instanceof Error ? e.message : String(e)}`); }
  const by = <T extends { conversation_id: string }>(rows: T[]) => { const m = new Map<string, T[]>(); for (const r of rows) { const k = String(r.conversation_id); if (!m.has(k)) m.set(k, []); m.get(k)!.push(r); } return m; };
  const mBy = by(msgs), pBy = by(presses), eBy = by(exs as Array<Ex & { conversation_id: string }>), dBy = by(decs);
  console.log(`読んだ: メッセージ ${msgs.length}・押下 ${presses.length}・手本（line_reply）${exs.length}（下書きの文あり ${exs.filter((e) => cleanDraft(e.ai_draft).text).length}）・ブレインの判断 ${decs.length}`);

  const skips: Record<string, number> = {};
  const plans: Array<{ row: Row; patch: Record<string, unknown>; source: string; verdict: string | null; reason: string; scene: string; draft: string; staff: string }> = [];
  for (const row of target) {
    const mm = mBy.get(row.conversation_id) ?? [];
    // 番を控えの行から作る（連投の最後のお客様の発言・その後にスタッフの発言があるか）
    const tAt = ms(row.customer_turn_at);
    const startIdx = mm.findIndex((m) => m.sender === "customer" && Math.abs(ms(m.created_at) - tAt) <= 1000);
    if (startIdx < 0) { skips.turn_key_missing = (skips.turn_key_missing ?? 0) + 1; continue; }
    let j = startIdx;
    while (j + 1 < mm.length && mm[j + 1].sender === "customer") j++;
    const custLastAt = mm[j].created_at;
    const pa = postApplyAtTurn(row.conv_status, timelines?.get(row.conversation_id) ?? null, custLastAt);
    const turn: PastTurn = { turnAt: row.customer_turn_at, custLastAt, post: pa.postApply, laterStaff: j + 1 < mm.length };
    const plan = planBackfillTurn({ conversationId: row.conversation_id, turn, msgs: mm, presses: pBy.get(row.conversation_id) ?? [], examples: eBy.get(row.conversation_id) ?? [], decisions: dBy.get(row.conversation_id) ?? [], nowMs });
    if ("skip" in plan) { skips[plan.skip] = (skips[plan.skip] ?? 0) + 1; continue; }
    plan.input.conv_status = row.conv_status ?? plan.input.conv_status;
    const ev = evalWatchTurn(plan.input, { msgs: mm, presses: pBy.get(row.conversation_id) ?? [], decisions: dBy.get(row.conversation_id) ?? [], nowMs, intentFallback: plan.intentFallback, postApplyTimeline: timelines?.get(row.conversation_id) ?? null });
    const g = guardBackfillJudgement(ev.judgement, { hasDraft: !!plan.example || plan.draftKnownAbsent, hasBrain: (plan.input.brain_versions ?? 0) > 0 });
    const dec = plan.decision as Dec | null;
    const detail = { ...g.detail, [BACKFILL_KEY]: plan.source, bf_capture_gap: true, backfill_at: iso(nowMs), bf_example: plan.example?.id ?? null, bf_stale_example: plan.staleExample, bf_draft_absent: plan.draftKnownAbsent || undefined, bf_decision: dec?.id ?? null, bf_scene_src: plan.sceneSrc, ...(g.bfNa ? { bf_na: g.bfNa } : {}) };
    const patch: Record<string, unknown> = {
      draft_last: plan.input.draft_last, draft_first: plan.input.draft_last, draft_versions: plan.input.draft_versions, draft_sentinel: plan.input.draft_sentinel,
      brain_action: plan.input.brain_action, brain_reply_mode: plan.input.brain_reply_mode, brain_versions: plan.input.brain_versions, tpo_label: plan.input.tpo_label,
      brain_check_pattern: dec?.suggested_check_pattern ?? null, brain_analyzed_msg_ts: dec?.analyzed_msg_ts ?? null,
      scene_evidence: dec?.scene_evidence ? String(dec.scene_evidence).slice(0, 500) : null, brain_at: dec?.created_at ?? null,
      ...(row.customer_last_at ? {} : { customer_last_at: plan.customerLastAt }),
      ...ev.patch, verdict: g.verdict, verdict_detail: detail,
    };
    const st = ev.window.texts.filter((x) => x.burst).map((x) => x.text).join(" / ");
    plans.push({ row, patch, source: plan.source, verdict: g.verdict, reason: String(detail.reason), scene: ev.scene.key, draft: cleanDraft(plan.input.draft_last).text ?? "", staff: st });
  }

  const count = (xs: string[]) => { const m = new Map<string, number>(); for (const x of xs) m.set(x, (m.get(x) ?? 0) + 1); return [...m].sort((a, b) => b[1] - a[1]).map(([k, v]) => `${k} ${v}`).join("・"); };
  console.log(`\n埋める行 ${plans.length}｜埋めない: ${Object.entries(skips).map(([k, v]) => `${k} ${v}`).join("・") || "なし"}`);
  console.log(`  材料: ${count(plans.map((p) => p.source))}｜下書きの文あり ${plans.filter((p) => p.draft).length}・ブレインの判断あり ${plans.filter((p) => p.patch.brain_at).length}`);
  console.log(`  場面: ${count(plans.map((p) => p.scene.split(":")[0]))}`);
  console.log(`  判定: ${count(plans.map((p) => String(p.verdict)))}`);
  console.log(`  理由: ${count(plans.map((p) => p.reason))}`);
  console.log(`  返信の道で下書きの文あり（今「下書きなし」に数えている番が下書きありになる）: ${plans.filter((p) => p.scene.startsWith("返信") && p.draft && p.staff).length}`);
  for (const p of plans.filter((x) => x.draft).slice(0, SAMPLES)) {
    console.log(`--- #${p.row.id} ${p.row.customer_turn_at.slice(0, 16)} ${p.row.conversation_id.slice(0, 8)} ${p.scene} ${p.verdict}（${p.reason}）\n    案「${mask(p.draft).replace(/\n/g, " ").slice(0, 80)}」\n    人「${mask(p.staff).replace(/\n/g, " ").slice(0, 80)}」`);
  }

  if (!APPLY) { console.log(`\n（dry: 書いていない。竹内さんの OK の後に --apply で ${plans.length}行を update する）`); return; }
  let ok = 0, raced = 0, fail = 0;
  for (const p of plans) {
    const r = await sb.from("line_watch_turns").update(p.patch).eq("id", p.row.id)
      .is("brain_at", null).is("draft_first", null).is("draft_last", null).is("draft_sentinel", null).is("final_check", null).select("id");
    if (r.error) { fail++; console.error(`  失敗 #${p.row.id}: ${r.error.message}`); continue; }
    if ((r.data ?? []).length) ok++; else raced++;
  }
  console.log(`\n書いた: ${ok}・その間に控えが埋まっていて飛ばした ${raced}・失敗 ${fail}`);
})().catch((e) => { console.error(e); process.exit(1); });
