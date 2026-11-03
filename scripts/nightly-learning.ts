// scripts/nightly-learning.ts — 毎晩の自動の学び（土台の7つ ⑤・2026-11-03 作業員1）
//
// 前の日（JST）の外れの番（見張り line_watch_turns の partial／different）を1番ずつ読み、
// 竹内さんの絶対の考え方（P0・feedback_aix_reply_split）の3つの原因のどれかに分け、直し方の案を出す:
//   ① 材料が AI に届いていない ② 場面や決まりを読み違えている ③ 本来 AIX で送るべき番を返信にしている（返信か AIX かの判断の誤り）
//   「人の揺れ」「AI が知り得ない」で片付けない（P0）。分からない時も捨てずに「分からない所」と竹内さんに聞く事を出す。
// 決まった分け（line-watch-miss-cause.ts の F1〜F4・C・D・N）を先に当て、DeepSeek にはその結果も渡す（決まりで分かる所は LLM に頼らない）。
// 出口（読むだけ・本番は変えない）:
//   .claude/exam-cache/nightly-learning/<日付>.md / .json … 原因の数・直し方の案（場面ごと）・分からない所
//   .claude/exam-cache/nightly-learning/owner-questions.md … 竹内さんに聞く事（同じ問いは足さない）＝指揮役が「竹内さんへの確認事項」の Docs に写す
//   会話の文は伏せて（名前・号室・URL・電話）この倉庫の外（exam-cache は git に入らない）にだけ置く
// 費用: 外れは1日 5〜15番 × DeepSeek 1回（約 $0.001）＝1日 $0.01〜0.02 前後。llm_usage_logs に route=script:nightly-learning で1行残す
// 実行: npx tsx --env-file=.env.local scripts/nightly-learning.ts [--date=2026-11-02] [--max=20] [--dry]（--dry は LLM を呼ばず決まった分けだけ）
//   毎晩は試験の統括の列で流す（安い時間）: exam-conductor.ts --add --runner=cmd --label=nightly-<日付> --cmd="scripts/nightly-learning.ts"
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { sb, deepseekJson, cost, maskForLlm } from "./lib/aix-eval-common";
import { classifyMiss, MISS_CAUSE_JA, type MissRow } from "../app/lib/line-watch-miss-cause";
import { isTestConversation } from "../app/lib/test-conversations";
import { examCacheRoot } from "./lib/llm-cassette";
import { mergeQuestions } from "./lib/nightly-learning-core";

const arg = (k: string, d = "") => process.argv.find((a) => a.startsWith(`--${k}=`))?.slice(k.length + 3) ?? d;
const DRY = process.argv.includes("--dry");
const MAX = Number(arg("max", "20"));
const OUT = join(examCacheRoot(), "nightly-learning");
const jstDate = (d: Date) => new Date(d.getTime() + 9 * 3600_000).toISOString().slice(0, 10);
const DAY = arg("date") || jstDate(new Date(Date.now() - 86_400_000));

type Turn = MissRow & { id: number; conversation_id: string; customer_turn_at: string; brain_action: string | null; brain_check_pattern: string | null; brain_reply_mode: string | null; materials: Record<string, unknown> | null };
export type Lesson = { cause: string; missing: string; rule: string; fix_kind: string; fix: string; owner_question: string; unknown: string; confidence: number };
export const P0_CAUSES = ["材料が届いていない", "場面・決まりの読み違い", "AIXの番を返信にした"] as const;

const SYS = `あなたは不動産仲介の LINE 返信 AI（ブレイン＝次の一手を決める・返信の下書き＝文）の外れを読み解く係です。
竹内さん（社長）の絶対の考え方:
- スタッフだけが知る情報（管理会社に確認して分かった事・募集状況・交渉の結果・撮った写真・見積の金額・内覧の日程の確定）は AIX（スタッフが確認して送るボタン）で送る。
- 返信は AI が知り得る材料（会話・資料・会社の事実・物件の記録）だけで書ける番。スタッフの文と100%一致が目標。
- 外れを「人の揺れ」「AI が知り得ない」で片付けない。原因は必ず次の3つのどれか:
  ① 材料が届いていない ② 場面・決まりの読み違い ③ AIXの番を返信にした（本来 AIX で送る番）
入力: 場面・ブレインの判断・下書き・スタッフが実際に送った文と AIX・決まった分けの結果。
JSON だけを返す:
{"cause":"材料が届いていない|場面・決まりの読み違い|AIXの番を返信にした","missing":"届いていなかった材料（何がどこにあれば当たったか・無ければ空）","rule":"読み違えた場面・決まり（無ければ空）","fix_kind":"材料|指示|AIXの判断|設計知見|分からない","fix":"直し方の案（1〜2文・具体的に）","unknown":"分からない所（無ければ空）","owner_question":"竹内さんに聞かないと決まらない事（決まりが無い時だけ・無ければ空）","confidence":0.0}`;

function turnText(t: Turn, custText: string, names: string[]): string {
  const staff = (t.staff_texts ?? []).filter((x) => x.burst).map((x) => x.text).join("\n");
  const aix = (t.staff_aix ?? []).filter((x) => x.burst).map((x) => x.aix_type).filter(Boolean).join(",");
  const auto = classifyMiss(t);
  const m = (s: string, n = 600) => maskForLlm(s, names).slice(0, n);
  return [
    `場面: ${t.scene_key ?? "-"}`,
    `お客様の発言（直近）:\n${m(custText, 500)}`,
    `ブレインの判断: ${t.brain_action ?? "-"}／確認の型 ${t.brain_check_pattern ?? "-"}／返信の型 ${t.brain_reply_mode ?? "-"}`,
    `AI の下書き:\n${m(t.draft_last ?? "（無し）")}`,
    `スタッフが送った文:\n${m(staff || "（無し）")}`,
    `スタッフが押した AIX: ${aix || "なし"}`,
    `見張りの判定: ${t.verdict}・${JSON.stringify(t.verdict_detail ?? {}).slice(0, 300)}`,
    `決まった分け: ${MISS_CAUSE_JA[auto.cause]}（${auto.why}）`,
  ].join("\n");
}

async function main() {
  mkdirSync(OUT, { recursive: true });
  const from = new Date(`${DAY}T00:00:00+09:00`).toISOString(), to = new Date(Date.parse(from) + 86_400_000).toISOString();
  const { data, error } = await sb.from("line_watch_turns")
    .select("id, conversation_id, customer_turn_at, scene_key, verdict, verdict_detail, draft_last, staff_texts, staff_aix, brain_action, brain_check_pattern, brain_reply_mode, materials")
    .gte("customer_turn_at", from).lt("customer_turn_at", to).in("verdict", ["partial", "different"]).order("customer_turn_at").limit(200);
  if (error) throw new Error(error.message);
  const turns = ((data ?? []) as Turn[]).filter((t) => !isTestConversation(t.conversation_id));
  console.log(`=== 毎晩の自動の学び ${DAY}: 外れ ${turns.length}番（読む ${Math.min(MAX, turns.length)}）${DRY ? "・--dry（LLM なし）" : ""} ===`);
  const rows: Array<{ id: number; scene: string; auto: string; path: string; lesson: Lesson | null }> = [];
  for (const t of turns.slice(0, MAX)) {
    const auto = classifyMiss(t);
    let lesson: Lesson | null = null;
    if (!DRY) {
      const [{ data: msgs }, { data: conv }] = await Promise.all([
        sb.from("messages").select("text, sender, created_at").eq("conversation_id", t.conversation_id).lte("created_at", t.customer_turn_at).order("created_at", { ascending: false }).limit(4),
        sb.from("conversations").select("customer_name, call_name").eq("id", t.conversation_id).maybeSingle(),
      ]);
      const names = [conv?.customer_name, conv?.call_name].filter((x): x is string => !!x && x.length >= 2);
      const cust = ((msgs ?? []) as Array<{ text: string | null; sender: string }>).reverse().filter((x) => x.sender === "customer").map((x) => x.text ?? "").join("\n");
      const j = await deepseekJson(SYS, turnText(t, cust, names), 500);
      if (j) lesson = { cause: String(j.cause ?? ""), missing: String(j.missing ?? ""), rule: String(j.rule ?? ""), fix_kind: String(j.fix_kind ?? ""), fix: String(j.fix ?? ""), owner_question: String(j.owner_question ?? ""), unknown: String(j.unknown ?? ""), confidence: Number(j.confidence ?? 0) };
    }
    rows.push({ id: t.id, scene: t.scene_key ?? "-", auto: auto.cause, path: String((t.verdict_detail ?? {}).path ?? "-"), lesson });
  }
  // 集計
  const count = (f: (r: (typeof rows)[number]) => string) => { const m = new Map<string, number>(); for (const r of rows) { const k = f(r); m.set(k, (m.get(k) ?? 0) + 1); } return [...m].sort((a, b) => b[1] - a[1]); };
  const L: string[] = [`# 毎晩の自動の学び ${DAY}`, "", `外れ ${turns.length}番（読んだ ${rows.length}）・DeepSeek ${cost.calls}回 $${cost.usd.toFixed(4)}${cost.fail ? `・失敗／伏せで止めた ${cost.fail}` : ""}`, ""];
  L.push("## 原因（P0 の3つ）", ...count((r) => r.lesson?.cause || "（読めなかった）").map(([k, n]) => `- ${k}: ${n}`), "");
  L.push("## 決まった分け", ...count((r) => MISS_CAUSE_JA[r.auto as keyof typeof MISS_CAUSE_JA] ?? r.auto).map(([k, n]) => `- ${k}: ${n}`), "");
  L.push("## 直し方の案（場面ごと）");
  for (const [scene] of count((r) => r.scene)) {
    L.push(`### ${scene}`);
    for (const r of rows.filter((x) => x.scene === scene)) {
      const l = r.lesson;
      L.push(`- #${r.id}（${r.path}・${r.auto}）${l ? `${l.cause}／${l.fix_kind}: ${l.fix}${l.missing ? `（届いていない: ${l.missing}）` : ""}${l.rule ? `（読み違い: ${l.rule}）` : ""}${l.unknown ? `（分からない: ${l.unknown}）` : ""}・自信 ${l.confidence}` : "（LLM なし）"}`);
    }
  }
  const qs = rows.filter((r) => r.lesson?.owner_question?.trim()).map((r) => ({ q: r.lesson!.owner_question, scene: r.scene }));
  if (qs.length) L.push("", "## 竹内さんに聞く事", ...qs.map((x) => `- ${x.q}（場面: ${x.scene}）`));
  const unknowns = rows.filter((r) => r.lesson?.unknown?.trim());
  if (unknowns.length) L.push("", "## 分からない所（捨てずに次の分析へ）", ...unknowns.map((r) => `- #${r.id} ${r.scene}: ${r.lesson!.unknown}`));
  writeFileSync(join(OUT, `${DAY}.md`), L.join("\n") + "\n");
  writeFileSync(join(OUT, `${DAY}.json`), JSON.stringify({ day: DAY, turns: turns.length, cost: { ...cost }, rows }, null, 1));
  const qf = join(OUT, "owner-questions.md");
  const mq = mergeQuestions(existsSync(qf) ? readFileSync(qf, "utf8") : "", DAY, qs);
  if (mq.added) writeFileSync(qf, mq.md);
  // 費用の記録（1回の実行で1行・script: の行は本番の見張りに数えない）
  if (!DRY && cost.calls) {
    const { error: e } = await sb.from("llm_usage_logs").insert({ route: "script:nightly-learning", model: process.env.DEEPSEEK_MODEL ?? "deepseek", status: 200, input_uncached: cost.miss, cache_read: cost.hit, output_tokens: 0, env: "script", action: `nightly-learning ${DAY} calls=${cost.calls} usd=${cost.usd.toFixed(4)}` });
    if (e) console.warn(`  費用の記録に失敗: ${e.message}`);
  }
  console.log(L.slice(0, 14).join("\n"));
  console.log(`\n保存: ${join(OUT, `${DAY}.md`)}・竹内さんに聞く事 +${mq.added}（${qf}）`);
}
if (/nightly-learning\.ts$/.test(process.argv[1] ?? "")) main().catch((e) => { console.error(e); process.exit(1); });
