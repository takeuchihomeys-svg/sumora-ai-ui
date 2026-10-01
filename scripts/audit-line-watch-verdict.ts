// scripts/audit-line-watch-verdict.ts
// 見張り 2段目の判定（app/lib/line-watch-judge.ts）を過去の実送信に当てて、当たり外れを目で読む（読むだけ・書き込みなし・LLM なし）。
//   番は messages から作り直す（控えの表 line_watch_turns は 10/01 から溜まるので、過去はこの形で代わりにする）:
//     AI の案 = その番の窓で送られた ai_reply_examples（line_reply）の ai_draft（＝スタッフが送る時に入力欄にあった下書き）
//     ブレイン = 番の中（お客様の発言〜スタッフの最初の行動）の一番新しい brain_decision_logs
//     実際 = 窓の中のスタッフの文（AIX の文を除く）と押した AIX（aix_usage_logs）
//   ※ 手打ちの番（下書きを使わなかった番）は過去の下書きが残っていないので na（no_draft）になる。本番の控えではここも比べられる
//
// 実行: npx tsx --env-file=.env.local scripts/audit-line-watch-verdict.ts [--days=60] [--samples=6] [--out=<file>] [--reason=<理由>] [--all]
//   --out に判定ごとの実物（案／実際／差）を書き出す。件数だけでなく中身を読む（CLAUDE.md「おかしな文を1通見つけた時」7）
import { createClient } from "@supabase/supabase-js";
import { writeFileSync } from "node:fs";
import { staffWindowOf, judgeTurn, VERDICT_REASON_JA, isAgree, type WindowMsg, type WindowPress, type Verdict } from "../app/lib/line-watch-judge";
import { sceneKeyOf } from "../app/lib/line-watch-turn";
import { isTestConversation } from "../app/lib/test-conversations";
import { STAFF_ACT_JA } from "../app/lib/customer-sim-shadow";

const arg = (k: string, d: string) => process.argv.find((a) => a.startsWith(`--${k}=`))?.slice(k.length + 3) ?? d;
const DAYS = Number(arg("days", "60"));
const SAMPLES = Number(arg("samples", "6"));
const OUT = arg("out", "");
const ONLY_REASON = arg("reason", "");
const ALL = process.argv.includes("--all");
/** ブレインの判断の記録がある番だけ（9/05〜）。本番の控えは毎番ブレインがあるので、こちらが本番に近い */
const BRAIN_ONLY = process.argv.includes("--brain-only");

const sb = createClient(process.env.NEXT_PUBLIC_SUPABASE_URL!, process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY!);

async function readAll<T>(q: (from: number, to: number) => PromiseLike<{ data: unknown; error: { message: string } | null }>, cap = 200_000): Promise<T[]> {
  const out: T[] = [];
  for (let i = 0; i < cap; i += 1000) {
    const r = await q(i, i + 999);
    if (r.error) throw new Error(r.error.message);
    const d = (r.data ?? []) as T[];
    out.push(...d);
    if (d.length < 1000) break;
  }
  return out;
}

type Msg = WindowMsg & { conversation_id: string };
type Press = WindowPress & { conversation_id: string };
type Decision = { id: string; conversation_id: string; created_at: string; analyzed_msg_ts: string | null; suggested_action: string | null; suggested_reply_mode: string | null; conversation_status: string | null; intent: string | null; matched: boolean | null };
type Example = { conversation_id: string; sent_at: string | null; created_at: string; ai_draft: string | null; sent_reply: string | null; tpo: string | null; conversation_state: string | null };

const clip = (s: string | null | undefined, n = 220) => { const t = String(s ?? "").replace(/\n+/g, " ⏎ ").trim(); return t.length > n ? `${t.slice(0, n)}…` : t; };

async function main() {
  const nowMs = Date.now();
  const since = new Date(nowMs - (DAYS + 2) * 86_400_000).toISOString();
  const judgeFrom = new Date(nowMs - DAYS * 86_400_000).toISOString();
  console.log(`読む: ${since.slice(0, 10)} 以降`);
  const msgs = await readAll<Msg>((f, t) => sb.from("messages").select("conversation_id, sender, created_at, text, is_aix_generated").gte("created_at", since).order("created_at").order("id").range(f, t));
  const presses = await readAll<Press>((f, t) => sb.from("aix_usage_logs").select("conversation_id, aix_type, check_pattern, created_at").gte("created_at", since).not("aix_type", "is", null).order("created_at").order("id").range(f, t));
  const decisions = await readAll<Decision>((f, t) => sb.from("brain_decision_logs").select("id, conversation_id, created_at, analyzed_msg_ts, suggested_action, suggested_reply_mode, conversation_status, intent:digest->>intent, matched").gte("created_at", since).order("created_at").order("id").range(f, t));
  const examples = await readAll<Example>((f, t) => sb.from("ai_reply_examples").select("conversation_id, sent_at, created_at, ai_draft, sent_reply, tpo:reply_context_snapshot->>tpo_label, conversation_state").eq("entry_source", "line_reply").gte("created_at", since).order("created_at").order("id").range(f, t));
  console.log(`messages ${msgs.length}・AIX ${presses.length}・判断 ${decisions.length}・送信例 ${examples.length}`);

  const group = <T extends { conversation_id: string }>(rows: T[]) => { const m = new Map<string, T[]>(); for (const r of rows) { if (!m.has(r.conversation_id)) m.set(r.conversation_id, []); m.get(r.conversation_id)!.push(r); } return m; };
  const mBy = group(msgs), pBy = group(presses), dBy = group(decisions), eBy = group(examples);

  type Row = { cid: string; turnAt: string; scene: string; verdict: Verdict | null; reason: string; draft: string; staff: string; brain: string; staffAix: string; detail: string; factDiff: boolean; textVerdict: Verdict | null; hasDec: boolean; uncertain: boolean };
  const rows: Row[] = [];
  for (const [cid, list] of mBy) {
    if (isTestConversation(cid)) continue;
    for (let i = 0; i < list.length; i++) {
      const m = list[i];
      if (m.sender !== "customer" || (i > 0 && list[i - 1].sender === "customer")) continue;
      if (m.created_at < judgeFrom) continue;
      const w = staffWindowOf({ customerTurnAt: m.created_at, msgs: list, presses: pBy.get(cid) ?? [], nowMs });
      const until = w.staffFirstAt ?? w.endAt;
      // ブレインの判断: この番のお客様の発言を読んだ判断（analyzed_msg_ts が番の中）で、スタッフの最初の行動より前の一番新しい物
      const P = Date.parse;
      const dec = (dBy.get(cid) ?? []).filter((d) => {
        const inTurn = d.analyzed_msg_ts ? P(d.analyzed_msg_ts) >= P(m.created_at) - 1000 && P(d.analyzed_msg_ts) <= P(w.customerLastAt) + 1000 : P(d.created_at) >= P(m.created_at);
        return inTurn && P(d.created_at) <= P(until);
      }).pop() ?? null;
      // 送った例: 返事のまとまりの中で送られた物（まとまりの外の後の連絡は比べない）
      const burstEnd = Math.max(...w.texts.filter((t) => t.burst).map((t) => P(t.at)), 0) + 60_000;
      const ex = (eBy.get(cid) ?? []).find((e) => { const at = P(e.sent_at ?? e.created_at); return at > P(w.customerLastAt) && at <= burstEnd && (e.ai_draft ?? "").trim(); }) ?? null;
      if (BRAIN_ONLY && !dec) continue;
      const status = dec?.conversation_status ?? ex?.conversation_state ?? null;
      const j = judgeTurn({ draft: ex?.ai_draft ?? null, hasBrain: !!dec, brainAction: dec?.suggested_action ?? null, brainReplyMode: dec?.suggested_reply_mode ?? null, convStatus: status, window: w });
      const scene = sceneKeyOf({ brainAction: dec?.suggested_action, brainReplyMode: dec?.suggested_reply_mode, tpoLabel: ex?.tpo, intent: dec?.intent, convStatus: status });
      const d = j.detail;
      const acts = [...(d.missing_acts ?? []).map((a) => `＋${STAFF_ACT_JA[a]}`), ...(d.extra_acts ?? []).map((a) => `－${STAFF_ACT_JA[a]}`)].join(" ");
      rows.push({
        cid, turnAt: m.created_at, scene: scene.key, verdict: j.verdict, reason: d.reason,
        draft: ex?.ai_draft ?? "", staff: w.texts.map((t) => (t.burst ? t.text : `〔後〕${t.text}`)).join("\n"),
        brain: dec ? `${dec.suggested_reply_mode ?? "-"}/${dec.suggested_action ?? "-"}` : "（判断なし）", staffAix: (d.staff_aix ?? []).join(","),
        detail: [d.sim != null ? `似${d.sim}` : "", d.kept != null ? `残${d.kept}` : "", acts, d.facts ? `事実 衝${d.facts.conflict.join("")}/AI${d.facts.draftOnly.join("")}/人${d.facts.staffOnly.join("")}` : "", d.ask ? `問${d.ask.map((x) => (x ? 1 : 0)).join("")}` : ""].filter(Boolean).join(" "),
        factDiff: !!d.fact_diff, textVerdict: d.text_verdict ?? null, hasDec: !!dec, uncertain: !!d.uncertain,
      });
    }
  }

  // ── 集計 ──
  const judged = rows.filter((r) => r.verdict && r.verdict !== "na");
  const cnt = (f: (r: Row) => boolean, src = rows) => src.filter(f).length;
  console.log(`\n番 ${rows.length}（判定待ち ${cnt((r) => !r.verdict)}）・比べられた ${judged.length}・一致 ${cnt((r) => isAgree(r.verdict), judged)}（${judged.length ? Math.round((cnt((r) => isAgree(r.verdict), judged) / judged.length) * 100) : 0}%）・事実違い ${cnt((r) => r.factDiff)}`);
  const byVR = new Map<string, number>();
  for (const r of rows) byVR.set(`${r.verdict ?? "待ち"}|${r.reason}`, (byVR.get(`${r.verdict ?? "待ち"}|${r.reason}`) ?? 0) + 1);
  console.log("\n■ 判定 × 理由");
  for (const [k, n] of [...byVR.entries()].sort((a, b) => b[1] - a[1])) { const [v, r] = k.split("|"); console.log(`  ${v.padEnd(13)} ${String(n).padStart(5)}  ${VERDICT_REASON_JA[r] ?? r}`); }
  // 文の比べ（下書きと返事のまとまりの両方がある番）
  const textRows = rows.filter((r) => r.textVerdict);
  const tv = new Map<string, number>();
  for (const r of textRows) tv.set(r.textVerdict!, (tv.get(r.textVerdict!) ?? 0) + 1);
  console.log(`\n■ 下書きと返事の文を比べた番 ${textRows.length}: ${[...tv.entries()].map(([k, n]) => `${k} ${n}`).join("・")}・割り切れない（uncertain）${textRows.filter((r) => r.uncertain).length}・文の一致 ${textRows.length ? Math.round((textRows.filter((r) => isAgree(r.textVerdict)).length / textRows.length) * 100) : 0}%`);
  const withDec = rows.filter((r) => r.hasDec);
  const jd = withDec.filter((r) => r.verdict && r.verdict !== "na");
  console.log(`■ ブレインの判断がある番（9/05〜の記録）${withDec.length}・比べられた ${jd.length}・一致 ${jd.length ? Math.round((jd.filter((r) => isAgree(r.verdict)).length / jd.length) * 100) : 0}%`);
  const byScene = new Map<string, Row[]>();
  for (const r of judged) { if (!byScene.has(r.scene)) byScene.set(r.scene, []); byScene.get(r.scene)!.push(r); }
  console.log("\n■ 場面ごと（比べられた番）");
  for (const [s, list] of [...byScene.entries()].sort((a, b) => b[1].length - a[1].length)) {
    const ag = list.filter((r) => isAgree(r.verdict)).length;
    console.log(`  ${s.padEnd(34)} n=${String(list.length).padStart(4)} 一致 ${String(Math.round((ag / list.length) * 100)).padStart(3)}% 事実違い ${list.filter((r) => r.factDiff).length} 別 ${list.filter((r) => r.verdict === "different").length}`);
  }

  // ── 実物 ──
  const L: string[] = [];
  const keys = [...byVR.keys()].filter((k) => !ONLY_REASON || k.endsWith(`|${ONLY_REASON}`));
  for (const k of keys) {
    const [v, reason] = k.split("|");
    const list = rows.filter((r) => `${r.verdict ?? "待ち"}|${r.reason}` === k && (ALL || r.draft || r.staff));
    if (!list.length) continue;
    L.push(`\n════ ${v} ／ ${VERDICT_REASON_JA[reason] ?? reason}（${byVR.get(k)}番）`);
    // 偏らないよう等間隔で抜く
    const step = Math.max(1, Math.floor(list.length / SAMPLES));
    for (let i = 0; i < list.length && L.length < 100_000; i += step) {
      const r = list[i];
      L.push(`── ${r.cid.slice(0, 8)} ${r.turnAt.slice(0, 16)} ${r.scene} ブレイン ${r.brain}${r.staffAix ? ` 押した ${r.staffAix}` : ""} ${r.detail}`);
      if (r.draft) L.push(`   案: ${clip(r.draft)}`);
      L.push(`   実: ${clip(r.staff) || "（文なし）"}`);
      if (list.length / step > SAMPLES && i / step >= SAMPLES - 1) break;
    }
  }
  if (OUT) { writeFileSync(OUT, L.join("\n"), "utf8"); console.log(`\n実物を書き出した: ${OUT}`); }
  else console.log(L.join("\n"));
}
main().catch((e) => { console.error(e); process.exit(1); });
