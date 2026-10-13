// scripts/line-watch-rejudge.ts — 見張り（line_watch_turns）の直近の番を今の判定の版（JUDGE_VERSION）で付け直す（LLM なし・費用 0）
//
// 2026-10-13 竹内さんの承認「見張りは採点係なので決定論のまま・物差しを直して直近30日の判定を付け直す」（v7「手打ちでも AIX の番」）。
//   毎晩の cron（/api/cron/line-watch-eval?days=30）でも付け直せるが、cron は埋め戻しの行（verdict_detail.backfill）の印を上書きして消す
//   （evalWatchTurn の patch に印が無い）＝ここでは印と材料の無い所の na（guardBackfillJudgement）を残したまま付け直す。
//   判定は cron と同じ関数（line-watch-turn-eval.evalWatchTurn）・読み方も cron と同じ（メッセージは番の4日前から・押下とブレインの判断は番の1時間前から）
//
// 実行: npx tsx --env-file=.env.local scripts/line-watch-rejudge.ts [--days=30] [--apply] [--samples=12] [--reason=aix_by_text_staff_fact]
//   既定は dry（書かない・前後の判定の移り変わりと一致率を出す）。--apply で書く（本番 DB への書き戻しは親／竹内さんが流す）
import { createClient } from "@supabase/supabase-js";
import { isTestConversation } from "../app/lib/test-conversations";
import { evalWatchTurn, type WatchTurnInput } from "../app/lib/line-watch-turn-eval";
import { guardBackfillJudgement, BACKFILL_KEY } from "../app/lib/line-watch-backfill";
import { JUDGE_VERSION, isAgree, type Verdict, type WindowMsg, type WindowPress } from "../app/lib/line-watch-judge";
import { maskPII } from "../app/lib/pii-mask";

const sb = createClient(process.env.NEXT_PUBLIC_SUPABASE_URL ?? "", process.env.SUPABASE_SERVICE_ROLE_KEY ?? process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY ?? "");
const arg = (k: string, d = "") => process.argv.find((a) => a.startsWith(`--${k}=`))?.slice(k.length + 3) ?? d;
const APPLY = process.argv.includes("--apply");
const DAYS = Number(arg("days", "30"));
const SAMPLES = Number(arg("samples", "12"));
const ONLY_REASON = arg("reason");
const DAY = 86_400_000, HOUR = 3_600_000;
const P = (s: string) => Date.parse(s);
const iso = (n: number) => new Date(n).toISOString();

async function readAll<T>(q: (f: number, t: number) => PromiseLike<{ data: unknown; error: { message: string } | null }>): Promise<T[]> {
  const out: T[] = [];
  for (let i = 0; i < 2_000_000; i += 1000) { const r = await q(i, i + 999); if (r.error) throw new Error(r.error.message); const d = (r.data ?? []) as T[]; out.push(...d); if (d.length < 1000) break; }
  return out;
}

type Row = WatchTurnInput & { id: number; verdict: Verdict | null; verdict_detail: Record<string, unknown> | null; judge_version: string | null; evaluated_at: string | null };
type Msg = WindowMsg & { conversation_id: string };
type Press = WindowPress & { conversation_id: string };
type Dec = { id: string; conversation_id: string; created_at: string; analyzed_msg_ts: string | null; intent: string | null };

(async () => {
  const nowMs = Date.now();
  const rows = await readAll<Row>((f, t) => sb.from("line_watch_turns").select("id, conversation_id, customer_turn_at, conv_status, draft_last, draft_last_at, draft_first, draft_first_at, draft_versions, draft_sentinel, brain_action, brain_reply_mode, brain_versions, tpo_label, verdict, verdict_detail, judge_version, evaluated_at")
    .gte("customer_turn_at", iso(nowMs - DAYS * DAY)).order("customer_turn_at").order("id").range(f, t));
  const turns = rows.filter((r) => !isTestConversation(r.conversation_id));
  console.log(`# 見張りの付け直し（${APPLY ? "書く" : "dry"}）直近 ${DAYS}日｜判定 ${JUDGE_VERSION}｜行 ${rows.length}（テスト会話を除いて ${turns.length}・埋め戻しの行 ${turns.filter((r) => r.verdict_detail?.[BACKFILL_KEY]).length}）`);
  const convIds = [...new Set(turns.map((t) => t.conversation_id))];
  const since = iso(Math.min(...turns.map((t) => P(t.customer_turn_at))) - HOUR);
  const msgs: Msg[] = [], presses: Press[] = [], decs: Dec[] = [];
  for (let i = 0; i < convIds.length; i += 50) {
    const chunk = convIds.slice(i, i + 50);
    msgs.push(...await readAll<Msg>((f, t) => sb.from("messages").select("conversation_id, sender, created_at, text, is_aix_generated").in("conversation_id", chunk).gte("created_at", iso(P(since) - 4 * DAY)).order("created_at").order("id").range(f, t)));
    presses.push(...await readAll<Press>((f, t) => sb.from("aix_usage_logs").select("conversation_id, aix_type, check_pattern, created_at").in("conversation_id", chunk).gte("created_at", since).not("aix_type", "is", null).order("created_at").order("id").range(f, t)));
    decs.push(...await readAll<Dec>((f, t) => sb.from("brain_decision_logs").select("id, conversation_id, created_at, analyzed_msg_ts, intent:digest->>intent").in("conversation_id", chunk).gte("created_at", since).order("created_at").order("id").range(f, t)));
  }
  const group = <T extends { conversation_id: string }>(xs: T[]) => { const m = new Map<string, T[]>(); for (const x of xs) { if (!m.has(x.conversation_id)) m.set(x.conversation_id, []); m.get(x.conversation_id)!.push(x); } return m; };
  const mBy = group(msgs), pBy = group(presses), dBy = group(decs);

  const moves = new Map<string, number>();
  const updates: Array<{ id: number; patch: Record<string, unknown> }> = [];
  const samples: string[] = [];
  let beforeN = 0, beforeAgree = 0, afterN = 0, afterAgree = 0, takBN = 0, takBA = 0, takAN = 0, takAA = 0, changed = 0;
  for (const t of turns) {
    const ev = evalWatchTurn(t, { msgs: mBy.get(t.conversation_id) ?? [], presses: pBy.get(t.conversation_id) ?? [], decisions: dBy.get(t.conversation_id) ?? [], nowMs });
    const old = t.verdict_detail ?? {};
    let verdict = ev.judgement.verdict;
    let detail: Record<string, unknown> = ev.patch.verdict_detail as Record<string, unknown>;
    if (old[BACKFILL_KEY]) {
      // 埋め戻しの行: 印を残し、材料の無い所は na（line-watch-backfill.ts と同じ）
      const g = guardBackfillJudgement(ev.judgement, { hasDraft: !!old.bf_example || !!old.bf_draft_absent, hasBrain: (t.brain_versions ?? 0) > 0 });
      verdict = g.verdict;
      const keep = Object.fromEntries(Object.entries(old).filter(([k]) => k === BACKFILL_KEY || k.startsWith("bf_") || k === "backfill_at"));
      delete (keep as Record<string, unknown>).bf_na; delete (keep as Record<string, unknown>).bf_raw;
      detail = { ...g.detail, ...keep, ...(g.bfNa ? { bf_na: g.bfNa } : {}) };
    }
    const oldReason = String(old.reason ?? "-"), newReason = String(detail.reason ?? "-");
    const key = `${t.verdict ?? "null"}(${oldReason}) → ${verdict ?? "null"}(${newReason})`;
    if (t.verdict !== verdict || oldReason !== newReason) { moves.set(key, (moves.get(key) ?? 0) + 1); changed++; }
    const tak = (detail.staff_writer ?? old.staff_writer) === "takeuchi";
    if (t.verdict && t.verdict !== "na") { beforeN++; if (isAgree(t.verdict)) beforeAgree++; if (tak) { takBN++; if (isAgree(t.verdict)) takBA++; } }
    if (verdict && verdict !== "na") { afterN++; if (isAgree(verdict)) afterAgree++; if (tak) { takAN++; if (isAgree(verdict)) takAA++; } }
    if (samples.length < SAMPLES && (ONLY_REASON ? newReason === ONLY_REASON : (t.verdict !== verdict || oldReason !== newReason))) {
      const st = ev.window.texts.filter((x) => x.burst).map((x) => x.text).join(" / ");
      samples.push(`--- ${t.customer_turn_at.slice(0, 16)} ${t.conversation_id.slice(0, 8)} ${key}\n    brain=${t.brain_action ?? "-"}/${t.brain_reply_mode ?? "-"} 中身=${JSON.stringify(detail.staff_fact ?? [])}\n    案「${maskPII(String(t.draft_last ?? t.draft_first ?? "")).replace(/\n/g, " ").slice(0, 140)}」\n    人「${maskPII(st).replace(/\n/g, " ").slice(0, 160)}」`);
    }
    updates.push({ id: t.id, patch: { ...ev.patch, verdict, verdict_detail: detail } });
  }
  const pct = (a: number, n: number) => (n ? `${Math.round((a / n) * 1000) / 10}%` : "—");
  console.log(`\n変わる行 ${changed}/${turns.length}`);
  console.log(`一致率（na を除く）: 前 ${beforeAgree}/${beforeN}＝${pct(beforeAgree, beforeN)} → 後 ${afterAgree}/${afterN}＝${pct(afterAgree, afterN)}｜竹内さんの番: 前 ${takBA}/${takBN}＝${pct(takBA, takBN)} → 後 ${takAA}/${takAN}＝${pct(takAA, takAN)}`);
  console.log(`\n## 移り変わり（前 → 後）`);
  for (const [k, v] of [...moves].sort((a, b) => b[1] - a[1])) console.log(`  ${String(v).padStart(4)}  ${k}`);
  console.log(`\n## 見本（変わった番）`);
  for (const s of samples) console.log(s);
  if (!APPLY) { console.log(`\n（dry: 書いていない。--apply で ${updates.length}行を付け直す）`); return; }
  let ok = 0, fail = 0;
  for (let i = 0; i < updates.length; i += 8) {
    await Promise.all(updates.slice(i, i + 8).map(async (u) => { const { error } = await sb.from("line_watch_turns").update(u.patch).eq("id", u.id); if (error) { fail++; console.error(error.message); } else ok++; }));
  }
  console.log(`\n書いた: ${ok}・失敗 ${fail}`);
})().catch((e) => { console.error(e); process.exit(1); });
