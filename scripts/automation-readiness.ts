// scripts/automation-readiness.ts — 週ごとの「自動化できる度合い」の表（読むだけ・DB に書かない）
// 実行: npx tsx --env-file=.env.local scripts/automation-readiness.ts [--weeks=5] [--json=out.json] [--examples=3]
// 2026-09-27 竹内「テスト繰り返して質上げていくために足りない部分等見つけていく／そうすれば完全自動化できるから」
//   → 提案「週ごとの自動化できる度合いを1つの表で見られるようにする」に「それ行う／設計知見と協力しておこなう」
// 中身の決め方は app/lib/automation-readiness.ts（純関数）・判断の後の行動は app/lib/brain-outcome.ts・手直しの型は app/lib/edit-diff.ts。
// YUMA（テスト用の会話）は除く。過去の記録の穴（ブレインの予想）は推定で埋め、推定である事を表に出す。
import { writeFileSync } from "node:fs";
import { createClient } from "@supabase/supabase-js";
import { excludeTestConversations } from "../app/lib/test-conversations";
import { resolveBrainOutcomes, BRAIN_OUTCOME_JA, type BrainOutcome } from "../app/lib/brain-outcome";
import {
  judgeAix, judgeDrafts, aixCell, draftCell, groupCells, brainWeeks, brainSceneCells, nextCandidates, sceneOf, jstWeek, pct,
  READY_RATE, READY_MIN_N, type ReadinessAixRow, type ReadinessExample, type ReadinessDecision, type Cell,
} from "../app/lib/automation-readiness";
import { EDIT_AMOUNT_JA, EDIT_KIND_JA, type EditAmount } from "../app/lib/edit-diff";

const sb = createClient(process.env.NEXT_PUBLIC_SUPABASE_URL ?? "", process.env.SUPABASE_SERVICE_ROLE_KEY ?? process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY ?? "");
const arg = (k: string, d = "") => (process.argv.find((a) => a.startsWith(`--${k}=`)) ?? `--${k}=${d}`).split("=").slice(1).join("=");
const WEEKS = Number(arg("weeks", "5"));
const JSON_OUT = arg("json");
const EXAMPLES = Number(arg("examples", "0"));
/**
 * aix_usage_logs.suggested_action を「ブレインの予想」として記録し始めた時刻（log-aix-usage の直しのデプロイ）。
 * これより前の行は suggest-next-action の予想なので使わず、brain_decision_logs から推定する。
 * デプロイが遅れたら環境変数 READINESS_PREDICTION_RECORDED_FROM で上書きする。
 */
const PREDICTION_RECORDED_FROM = process.env.READINESS_PREDICTION_RECORDED_FROM ?? "2026-09-28T00:00:00+09:00";

async function all<T>(build: (f: number, t: number) => PromiseLike<{ data: T[] | null; error: { message: string } | null }>): Promise<T[]> {
  const out: T[] = [];
  for (let f = 0; f < 200_000; f += 1000) {
    const { data, error } = await build(f, f + 999);
    if (error) throw new Error(error.message);
    out.push(...(data ?? []));
    if ((data ?? []).length < 1000) break;
  }
  return out;
}

function startOfWeeksAgo(n: number): string {
  const thisMon = jstWeek(new Date().toISOString());
  const d = new Date(`${thisMon}T00:00:00+09:00`);
  d.setUTCDate(d.getUTCDate() - 7 * (n - 1));
  return d.toISOString();
}

const fmtAmounts = (a: Partial<Record<EditAmount, number>>) =>
  (["none", "tiny", "small", "large", "rewrite"] as EditAmount[]).map((k) => `${EDIT_AMOUNT_JA[k]}${a[k] ?? 0}`).join("/");

async function main() {
  const since = startOfWeeksAgo(WEEKS);
  // 判断の窓は24時間なので、送信の方は少し前から・判断は少し後まで読む
  const sinceEarly = new Date(new Date(since).getTime() - 48 * 3600_000).toISOString();

  const aixRows = excludeTestConversations(await all<ReadinessAixRow>((f, t) => sb.from("aix_usage_logs")
    .select("id, conversation_id, created_at, aix_type, check_pattern, suggested_action, was_edited, conversation_status")
    .gte("created_at", since).order("created_at").range(f, t)));
  const decisions = excludeTestConversations(await all<ReadinessDecision>((f, t) => sb.from("brain_decision_logs")
    .select("id, conversation_id, created_at, suggested_action, suggested_reply_mode, scene_evidence, conversation_status, outcome, digest")
    .gte("created_at", sinceEarly).order("created_at").range(f, t)));
  const examples = excludeTestConversations(await all<ReadinessExample>((f, t) => sb.from("ai_reply_examples")
    .select("conversation_id, sent_at, created_at, entry_source, conversation_state, aix_action, ai_draft, sent_reply")
    .in("entry_source", ["line_reply", "aix_action"]).gte("created_at", sinceEarly).order("created_at").range(f, t)));
  const convIds = [...new Set([...decisions.map((d) => d.conversation_id), ...aixRows.map((a) => a.conversation_id)])];
  const staffMsgs: Array<{ conversation_id: string; created_at: string; text: string | null; is_aix_generated: boolean | null }> = [];
  for (let i = 0; i < convIds.length; i += 80) {
    staffMsgs.push(...await all<{ conversation_id: string; created_at: string; text: string | null; is_aix_generated: boolean | null }>((f, t) => sb.from("messages")
      .select("conversation_id, created_at, text, is_aix_generated")
      .in("conversation_id", convIds.slice(i, i + 80)).eq("sender", "staff").gte("created_at", sinceEarly).order("created_at").range(f, t)));
  }

  // ── 判定 ──
  const aixJ = judgeAix(aixRows, examples, decisions, PREDICTION_RECORDED_FROM, staffMsgs);
  const draftJ = judgeDrafts(examples, decisions).filter((j) => (j.ex.sent_at ?? j.ex.created_at)! >= since);
  const resolvedAll = resolveBrainOutcomes({ decisions, presses: aixRows, staffMessages: staffMsgs, replyExamples: examples });
  const decById = new Map(decisions.map((d) => [d.id, d]));
  const resolved = resolvedAll.filter((r) => r.decision.created_at >= since).map((r) => ({ ...r, scene: sceneOf(decById.get(r.decision.id)) }));

  const weeks = [...new Set([...aixJ.map((j) => j.week), ...draftJ.map((j) => j.week), ...resolved.map((r) => jstWeek(r.decision.created_at))])].sort();

  const L: string[] = [];
  L.push(`# 自動化の度合い（${weeks[0]} の週〜・YUMA 除く・作成 ${new Date().toISOString().slice(0, 16)}Z）`);
  L.push(`「届いている」＝手直しなし ${Math.round(READY_RATE * 100)}% 以上かつ ${READY_MIN_N} 件以上。手直し＝生成された文と送った文が1文字でも違う（絵文字・空白も含む）。`);
  L.push(`ブレインの予想: ${PREDICTION_RECORDED_FROM} より前の AIX は brain_decision_logs の「押す前の一番新しい判断（48時間以内）」から**推定**（旧 suggested_action は別の仕組みの予想で使えない）。`);

  // ── ①週ごと（全体） ──
  L.push(`\n## ① 週ごと`);
  L.push(`| 週(月) | AIX 件数 | AIX 予想一致（推定を含む） | AIX 手直しなし | 下書きの送信 | 下書きそのまま | 手打ち（下書きなし） | ブレイン: 同じAIX / 下書き使用 / 別AIX / 手打ち / 次の判断が先 / 何もしない |`);
  L.push(`|---|---|---|---|---|---|---|---|`);
  for (const w of weeks) {
    const a = aixCell(w, aixJ.filter((j) => j.week === w));
    const d = draftCell(w, draftJ.filter((j) => j.week === w));
    const bw = brainWeeks(resolved.filter((r) => jstWeek(r.decision.created_at) === w))[0];
    const b = (k: BrainOutcome) => bw?.byOutcome[k] ?? 0;
    const bt = bw?.n ?? 0;
    L.push(`| ${w} | ${a.n} | ${pct(a.matchRate)}（予想 ${a.predictedN}・うち推定 ${a.estimatedN}） | ${pct(a.untouchedRate)}（${a.untouchedN}/${a.judgedN}） | ${d.n} | ${pct(d.untouchedRate)}（${d.untouchedN}/${d.judgedN}） | ${pct(d.manualRate)} | ${bt}件: ${b("aix_followed")} / ${b("draft_followed") + b("draft_modified")} / ${b("aix_different")} / ${b("manual") + b("draft_rewritten") + b("reply_unknown")} / ${b("superseded")} / ${b("no_action")}${bw?.byOutcome.pending ? `（窓が開いている ${bw.byOutcome.pending}）` : ""} |`);
  }

  // ── ②AIX の種類ごと ──
  const aixCells = groupCells(aixJ, (j) => j.key, aixCell);
  L.push(`\n## ② AIX の種類ごと（全期間）`);
  L.push(`| AIX | 件数 | 予想一致 | 手直しなし | 量（${Object.values(EDIT_AMOUNT_JA).join("/")}） | 手直しの型の上位 | 届いた |`);
  L.push(`|---|---|---|---|---|---|---|`);
  for (const c of aixCells) L.push(`| ${c.label} | ${c.n} | ${pct(c.matchRate)}（${c.predictedN}） | ${pct(c.untouchedRate)}（${c.untouchedN}/${c.judgedN}） | ${fmtAmounts(c.amounts)} | ${c.kinds.slice(0, 4).map((k) => `${k.label}${k.count}`).join("・") || "—"} | ${c.reached ? "✅" : ""} |`);

  // ── ③返信の下書き（段階ごと） ──
  const draftCells = groupCells(draftJ, (j) => j.stage, draftCell);
  L.push(`\n## ③ 返信の下書き（送った時の段階ごと・全期間）`);
  L.push(`| 段階 | 送信 | 手打ち | 下書きそのまま | 量 | 手直しの型の上位 | 届いた |`);
  L.push(`|---|---|---|---|---|---|---|`);
  for (const c of draftCells) L.push(`| ${c.label} | ${c.n} | ${pct(c.manualRate)} | ${pct(c.untouchedRate)}（${c.untouchedN}/${c.judgedN}） | ${fmtAmounts(c.amounts)} | ${c.kinds.slice(0, 4).map((k) => `${k.label}${k.count}`).join("・") || "—"} | ${c.reached ? "✅" : ""} |`);

  const intentCells = groupCells(draftJ, (j) => j.intent, draftCell);
  L.push(`\n## ③b 返信の下書き（ブレインが読んだ「お客様の発言の意図」ごと・判断の記録がある 9/5 以降）`);
  L.push(`| 意図 | 送信 | 手打ち | 下書きそのまま | 量 | 手直しの型の上位 | 届いた |`);
  L.push(`|---|---|---|---|---|---|---|`);
  for (const c of intentCells.slice(0, 15)) L.push(`| ${c.label} | ${c.n} | ${pct(c.manualRate)} | ${pct(c.untouchedRate)}（${c.untouchedN}/${c.judgedN}） | ${fmtAmounts(c.amounts)} | ${c.kinds.slice(0, 4).map((k) => `${k.label}${k.count}`).join("・") || "—"} | ${c.reached ? "✅" : ""} |`);

  // ── ④ブレイン: 判断の後の行動（場面ごと） ──
  const sceneCells = brainSceneCells(resolved);
  L.push(`\n## ④ ブレインの判断の後の行動（場面ごと・全期間・窓が閉じた判断）`);
  L.push(`「ブレインどおり」＝AIX の判断→同じ AIX／AIX なしの判断→下書きを使った（そのまま・直して）。分母は何か送った判断。`);
  const OUTS: BrainOutcome[] = ["aix_followed", "aix_different", "draft_followed", "draft_modified", "draft_rewritten", "manual", "reply_unknown", "superseded", "no_action"];
  L.push(`| 場面 | 判断 | ブレインどおり | ${OUTS.map((o) => BRAIN_OUTCOME_JA[o]).join(" | ")} |`);
  L.push(`|---|---|---|${OUTS.map(() => "---").join("|")}|`);
  for (const s of sceneCells.slice(0, 20)) L.push(`| ${s.scene} | ${s.n} | ${pct(s.followRate)} | ${OUTS.map((o) => s.byOutcome[o] ?? 0).join(" | ")} |`);

  // ── ⑤届いている所・届いていない所・次に直す候補 ──
  const cells: Array<Cell & { area: string }> = [
    ...aixCells.map((c) => ({ ...c, area: "AIX" })),
    ...intentCells.map((c) => ({ ...c, area: "下書き（意図）" })),
  ];
  L.push(`\n## ⑤ 自動化に届いている所`);
  const reached = cells.filter((c) => c.reached);
  L.push(reached.length ? reached.map((c) => `- ${c.area}【${c.label}】手直しなし ${pct(c.untouchedRate)}（${c.untouchedN}/${c.judgedN}）`).join("\n") : "- （まだ無い）");
  L.push(`\n## ⑥ 届いていない所 — 次に直す候補（手直し${"＋"}手打ちの件数順）`);
  L.push(`| # | 所 | 手直しの件数 | 手直しなし | 型の上位 |`);
  L.push(`|---|---|---|---|---|`);
  nextCandidates(cells, 12).forEach((c, i) => L.push(`| ${i + 1} | ${c.area}【${c.label}】(n=${c.n}) | ${c.fixCount} | ${pct(c.untouchedRate)} | ${c.topKinds || "—"} |`));

  // 型の全体（AIX と下書き）
  const kindTotal = new Map<string, number>();
  for (const e of [...aixJ.map((j) => j.edit), ...draftJ.map((j) => j.edit)]) if (e && e.amount !== "none") for (const k of e.kinds) kindTotal.set(EDIT_KIND_JA[k], (kindTotal.get(EDIT_KIND_JA[k]) ?? 0) + 1);
  L.push(`\n手直しの型（全体・重なりあり）: ${[...kindTotal].sort((a, b) => b[1] - a[1]).map(([k, n]) => `${k} ${n}`).join("・")}`);

  // 過去の outcome（画面が書いた値）と事実からの推定の食い違い（書き換えはしない・OUTCOME_RESOLVED_FROM 以降だけ cron が書く）
  const storedBy = new Map(decisions.map((d) => [d.id, d.outcome ?? null]));
  const cross = new Map<string, number>();
  for (const r of resolved) {
    if (!r.outcome) continue;
    const k = `${storedBy.get(r.decision.id) ?? "（空）"} → ${r.outcome}`;
    cross.set(k, (cross.get(k) ?? 0) + 1);
  }
  L.push(`\n## 過去の outcome（画面が書いた値）→ 事実からの推定（書き換えていない）`);
  L.push(`| 記録 → 推定 | 件数 |`);
  L.push(`|---|---|`);
  for (const [k, n] of [...cross].sort((a, b) => b[1] - a[1]).slice(0, 25)) L.push(`| ${k} | ${n} |`);

  // 記録の穴の残り
  const unk = resolved.filter((r) => r.outcome === "reply_unknown").length;
  const noPred = aixJ.filter((j) => j.predicted == null).length;
  L.push(`\n## 記録の穴（残り）`);
  L.push(`- 文を送ったのに下書きの記録（ai_reply_examples）が結べない判断: ${unk}件`);
  L.push(`- AIX を押す前48時間にブレインの判断が無い: ${noPred}/${aixJ.length}件（お客様の発言が無いままこちらから送った AIX 等）`);
  L.push(`- AIX の生成文の記録（aix_action の下書き）が結べない: ${aixJ.filter((j) => !j.edit).length}/${aixJ.length}件（固定文・画像だけの AIX は生成文が無い。その時は was_edited を使う）`);

  if (EXAMPLES > 0) {
    L.push(`\n## 実物（候補の上位ごとに ${EXAMPLES} 件）`);
    for (const c of nextCandidates(cells, 5)) {
      L.push(`\n### ${c.area}【${c.label}】`);
      const pairs = c.area === "AIX"
        ? aixJ.filter((j) => j.key === c.label && j.edit && j.edit.amount !== "none").map((j) => ({ e: j.edit!, ex: examples.find((x) => x.entry_source === "aix_action" && x.conversation_id === j.row.conversation_id && Math.abs(new Date(x.sent_at ?? x.created_at ?? 0).getTime() - new Date(j.row.created_at).getTime()) < 180_000) }))
        : draftJ.filter((j) => j.intent === c.label && j.edit && j.edit.amount !== "none").map((j) => ({ e: j.edit!, ex: j.ex }));
      for (const p of pairs.slice(-EXAMPLES)) {
        L.push(`- [${EDIT_AMOUNT_JA[p.e.amount]}・${p.e.kinds.map((k) => EDIT_KIND_JA[k]).join("/")}]`);
        L.push(`  - 生成: ${String(p.ex?.ai_draft ?? "").replace(/\n/g, "⏎").slice(0, 200)}`);
        L.push(`  - 送信: ${String(p.ex?.sent_reply ?? "").replace(/\n/g, "⏎").slice(0, 200)}`);
      }
    }
  }

  console.log(L.join("\n"));
  if (JSON_OUT) {
    writeFileSync(JSON_OUT, JSON.stringify({ weeks, aixCells, draftCells, sceneCells, candidates: nextCandidates(cells, 20), predictionRecordedFrom: PREDICTION_RECORDED_FROM }, null, 2));
    console.log(`\n（JSON を ${JSON_OUT} に書いた）`);
  }
}
main().catch((e) => { console.error(e); process.exit(1); });
