// scripts/brain-self-review.ts — LINE のブレインの自己点検: 落ちた問題・大きく直された番について「なぜ外れたか」を説明し、直しの案を出す（案は自動で入れない）
//
// 2026-10-18 竹内さん 10/16 OK「ブレイン同士で会話させて自己改善する輪」の一歩目（設計知見 f633495b「原因を見つけて深く直す」）:
//   毎日拾うブレイン（scripts/edited-turn-miner.ts）→ 試験のブレイン（scripts/exam-brain.ts）→ ★ここ（説明する・直しの案を出す）→ 試験のブレインが確かめる。
//   決め方は scripts/lib/brain-self-review.ts（純関数・単体テスト）、読み書きは scripts/lib/brain-self-review-io.ts。
//
// 使い方:
//   npx tsx --env-file=.env.local scripts/brain-self-review.ts [--from=exam|miner|both] [--max=10]
//     --from=exam  … 試験の台帳（ledger.jsonl・直近 --days=14 日）の落ちた問題・前より悪くなった問題
//     --from=miner … 毎日拾った弱い所（edited-turns/<日付>/weak-spots.json・竹内さんの番がある所か数3以上）
//     --label=dg1016-b [--results=<dir|file>] [--ids=q157,q158] … その実行の答案の落ちた問題（作業ツリーの scripts/brain-exam/results から探す）
//     --dry … LLM を呼ばず、渡す材料の大きさと見込みだけ ／ --show-packet=q157 … 渡す材料（伏せた物）をそのまま出す（手元だけ）
//     --report … 今日の説明から一覧（report.md）と朝の報告の1行だけ作り直す（LLM なし）
//     --allow-peak … 平日 JST 10〜13・15〜19（DeepSeek が2倍）でも流す ／ --usd-max=1 … この実行の上限
//     --post-apply=claude … 今申込以降の会話の問題（既定は出さない）を Claude（Sonnet 5・1件 約 $0.07）で説明する。DeepSeek には出さない
// 費用: DeepSeek（試験の判定と同じ: DEEPSEEK_MODEL か deepseek-v4-pro・温度0・推論なし・json・固定の前置き）1件 約 $0.02（数円）。
//   1日の上限は試験のブレインと同じ EXAM_DAILY_CAP_USD（既定 $10）＝ llm_usage_logs の試験 env ＋ local-llm-spend.jsonl（ここで書く）。
// 個人情報: DeepSeek に出す物は maskExamText → maskForEmbedding → 部屋番号 の2重。申込以降の会話（deepseek の線）は出さない・申込の書類の印の行は落とす・
//   伏せた後も個人の値が残る（alt-pii-gate）時は出さない。止める: BRAIN_SELF_REVIEW=off
// 2026-10-18 竹内さん 10/18 OK「毎晩の自己点検を朝の報告に載せる」: 結果（朝の1行・案の数・竹内さんに聞く事）を表 brain_self_review_runs／_proposals に書く
//   （scripts/lib/brain-self-review-db.ts・表は scripts/brain-self-review-migration.sql＝親が流す。表が無い間は書かずに進む）。書く物は原因・案・問題の id だけ。
//   --no-db で書かない・BRAIN_SELF_REVIEW_DB=off で止める。
//   --nightly … 毎晩の口（exam-brain.ts --run-queue の最後から）。今日の毎晩の分（nightly-done.txt）が済んでいれば流さない（--force で流す）
import { createClient, type SupabaseClient } from "@supabase/supabase-js";
import { writeFileSync, existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import {
  excerptOf, keywordsOf, buildPacket, maskBareRoomNo, parseExplanation, bundleProposals, renderMarkdown, morningLine, usdOf, estimateUsdOf, splitLines, EXPLAIN_SYSTEM,
  type PacketSection, type CaseResult, type Explanation,
} from "./lib/brain-self-review";
import {
  buildCassetteIndex, pickEntry, readCassette, requestText, findResultsFile, readRowsFile, reuseRows, latestWeakSpots, dayDir, appendJsonl, readJsonl,
  appendLocalSpend, readLocalSpendToday, jstDate, SELF_REVIEW_DIR, type Row, type Spot,
} from "./lib/brain-self-review-io";
import { loadExamProblems, readLedger, readDailySpend, type AnyProblem } from "./lib/exam-brain-io";
import { writeSelfReviewToDb } from "./lib/brain-self-review-db";
import { dailyCapUsd } from "./lib/exam-brain";
import { loadCards, loadLinks, loadKbRows } from "./lib/exam-rag-store";
import { maskExamText, addressNamesOf } from "./lib/brain-exam-mask";
import { maskRoomNo } from "./lib/exam-rag-run";
import { maskForEmbedding } from "../app/lib/pii-mask";
import { altPiiSignal } from "../app/lib/alt-pii-gate";
import { cutBeforeApplicationMaterial } from "../app/lib/test-pii-guard";
import { loadDeepseekCutoff, isAfterCutoff, cutoffMs, NO_CUTOFF } from "../app/lib/post-apply";
import { isDeepseekPeakAt, altPriceOf } from "../app/lib/llm-price";

const args = process.argv.slice(2);
const arg = (k: string, d = "") => args.find((a) => a.startsWith(`--${k}=`))?.slice(k.length + 3) ?? d;
const flag = (k: string) => args.includes(`--${k}`);
const FROM = (arg("from", "both") as "exam" | "miner" | "both");
const MAX = Math.max(1, Number(arg("max", "10")) || 10);
const DAYS = Math.max(1, Number(arg("days", "14")) || 14);
const IDS = arg("ids").split(",").map((s) => s.trim()).filter(Boolean);
const LABEL = arg("label");
const USD_MAX = Math.max(0, Number(arg("usd-max", "1")) || 1);
const log = (s: string) => console.log(s);
const one = (s: unknown, n: number) => [...String(s ?? "").replace(/\s+/g, " ").trim()].slice(0, n).join("");

// 申込以降の会話: 既定は出さない（skip）。--post-apply=claude の時だけ Claude で説明する（本番と同じく申込以降は Claude だけ・DeepSeek には出さない）
const POST_APPLY = arg("post-apply", "skip") === "claude" ? "claude" : "skip";
type Case = { caseId: string; source: "exam" | "miner"; ids: string[]; title: string; sections: PacketSection[]; kb: Array<{ id: string; title: string }>; skip?: string; dropped: number; llm?: "deepseek" | "claude" };

/** 2重に伏せる＋申込の書類の印の行・個人の値が残る行を落とす */
function maskLines(lines: string[], mask: (s: string) => string): { lines: string[]; dropped: number } {
  let dropped = 0;
  const out: string[] = [];
  for (const l of lines) {
    const m = mask(l);
    if (cutBeforeApplicationMaterial([{ text: m }]).cutAt !== null || altPiiSignal(m)) { dropped++; continue; }
    out.push(m);
  }
  return { lines: out, dropped };
}
const jsonLines = (o: unknown, max = 60): string[] => splitLines(JSON.stringify(o ?? null, null, 1).replace(/^\s*[{}\]]\s*,?$/gm, ""), 240).slice(0, max);

// ─── 試験の落ちた問題 → まとめた材料 ─────────────────────────────────────
async function examCase(sb: SupabaseClient, p: AnyProblem, rows: Row[], o: { card: { answer?: string } | undefined; links: Array<{ kbId: string; title?: string; decided?: string; score: number; kind: string }>; idx: ReturnType<typeof buildCassetteIndex>; why: string }): Promise<Case> {
  const id = p.id;
  const base: Case = { caseId: `exam:${id}`, source: "exam", ids: [id], title: `${id}［${p.type}］${o.why}`, sections: [], kb: o.links.slice(0, 4).map((l) => ({ id: l.kbId, title: l.title ?? "" })), dropped: 0 };
  const conv = String(p.conv ?? ""), at = String(p.at ?? "");
  // 申込以降の線（線より後だけ渡してよい・申込中は渡さない）
  const cut = await loadDeepseekCutoff(sb as never, conv);
  // --show-packet（手元に出すだけ・LLM に出さない）の時は線の外でも作って見せる
  // 2026-10-18 確かめる人: 線が「時刻」（否決で戻した会話）の時は、問題の時刻が線より後でも DeepSeek に渡さない。
  //   材料（録音の要求）の会話履歴・要約・セーブデータは線より前（申込中）の中身を含み、日時は <md> に伏せてあって時刻で切れない（実物 q093: 要約に審査否決の中身）
  const postApply = !isAfterCutoff(at, cut) || cutoffMs(cut) !== NO_CUTOFF;
  const cutSkip = postApply && POST_APPLY !== "claude" ? "申込以降の会話（deepseek の線の外）＝DeepSeek に出さない（--post-apply=claude で Claude に）" : null;
  if (cutSkip && !arg("show-packet")) return { ...base, skip: cutSkip };
  if (postApply) base.llm = "claude";
  let name: string | null = null;
  try { const r = await sb.from("conversations").select("customer_name").eq("id", conv).maybeSingle(); name = ((r.data ?? null) as { customer_name?: string | null } | null)?.customer_name ?? null; } catch { /* 名前なしで伏せる */ }
  const ctx = (Array.isArray(p.context) ? p.context : []) as Array<{ s: string; t: string }>;
  // こちらの担当（竹内・鈴木）は伏せない（材料の「竹内さんの型」等の意味が変わる）
  const names = addressNamesOf([...ctx.filter((m) => m.s === "staff").map((m) => m.t), String(p.staffText ?? "")]).filter((n) => !/^(竹内|鈴木|スモラ)$/.test(n));
  const mask = (s: string) => maskBareRoomNo(maskRoomNo(maskForEmbedding(maskExamText(s, name, names))));
  const fail = rows.find((r) => r.score?.pass === false) ?? rows[0];
  if (!fail) return { ...base, skip: "答案が見つからない" };
  const raw = (fail.raw ?? {}) as Record<string, unknown>, brain = (fail.brain ?? {}) as Record<string, unknown>, draft = (fail.draft ?? null) as { text?: string; code?: string } | null;
  const tc = (raw.turn_contract ?? brain.turn_contract ?? null) as Record<string, unknown> | null;
  const asks = (Array.isArray(p.asks) ? p.asks : []) as Array<{ q: string; route: string; point: string; routes?: string[] }>;
  const answer = o.card?.answer ?? mask(String(p.staffText ?? ""));
  // 言葉: 正解の側（依頼・要点・なぜ・実送信）＋お客様の発言＋下書き＋ブレインの判断の言葉と札（ack_form・aix・two_stage・rule: の名前＝決まりの行を引く）
  const tr = (fail.trace ?? {}) as Record<string, unknown>;
  const kw = keywordsOf([...asks.flatMap((a) => [a.q, a.point]), String(p.why ?? ""), answer, String(p.customer ?? ""), draft?.text ?? "",
    ...(tc ? [JSON.stringify(tc.asks ?? ""), String(tc.background ?? "")] : []),
    [tc?.ack_form, raw.aix, raw.two_stage, brain.two_stage, tr.decision_source, tr.decision_source_no_aix].filter((x) => typeof x === "string").join(" ").replace(/[()（）:]/g, " ")]);
  const sec: PacketSection[] = [];
  sec.push({ name: "問題と正解（竹内さんの実送信）", lines: [
    `型: ${p.type}・段: ${p.stage ?? "-"}・正解の道: ${(p.accept as string[] ?? []).join(" | ")}${(p.mustNot as string[] ?? []).length ? `・ダメな道: ${(p.mustNot as string[]).join(" | ")}` : ""}`,
    ...asks.map((a, i) => `依頼${i + 1}: 「${a.q}」→ 答え方 ${[a.route, ...(a.routes ?? [])].filter((x, j, xs) => xs.indexOf(x) === j).join("/")}・要点: ${a.point}`),
    ...((p.ng as string[] | undefined) ?? []).map((x, i) => `言ってはいけない事${i + 1}: ${x}`),
    `なぜ（正解の理由）: ${p.why ?? ""}`,
    ...splitLines(`お客様の今の発言: ${p.customer ?? ""}`),
    ...splitLines(`正解の送信: ${answer}`).slice(0, 14),
  ] });
  sec.push({ name: "ブレインの最初の出力（LLM）", lines: [
    `reply_mode=${raw.reply_mode ?? "-"}・aix=${raw.aix ?? "-"}・two_stage=${raw.two_stage ?? "-"}・action=${one(raw.action, 80)}`,
    `reply_direction: ${one(raw.reply_direction, 220)}`,
    `key_topics: ${JSON.stringify(raw.key_topics ?? [])}・avoid_topics: ${JSON.stringify(raw.avoid_topics ?? [])}`,
    `reason: ${one(raw.reason, 160)}`,
    ...(tc ? jsonLines({ background: tc.background, situation: tc.situation, asks: tc.asks, must_not: tc.must_not, ack_form: tc.ack_form, close_only: tc.close_only, feeling: tc.feeling, proposals: tc.proposals, open_search: tc.open_search }, 40) : ["turn_contract: なし"]),
  ] });
  sec.push({ name: "決まり・出口の後のブレイン（最終）と trace", lines: [
    `reply_mode=${brain.reply_mode ?? "-"}・two_stage=${brain.two_stage ?? "-"}・action=${one(brain.action, 80)}・ack_form=${(brain.turn_contract as Record<string, unknown> | undefined)?.ack_form ?? "-"}`,
    `reply_direction: ${one(brain.reply_direction, 260)}`,
    `trace: ${one(JSON.stringify(fail.trace ?? {}), 400)}`,
  ] });
  const fa = (Array.isArray(fail.asks) ? fail.asks : []) as Array<{ q: string; covered: boolean; why: string }>;
  const pth = (fail.path ?? {}) as { code?: string }, ess = (fail.essence ?? {}) as { code?: string };
  sec.push({ name: "下書きと判定", lines: [
    `判定: 道（最終）=${pth.code ?? "-"}・本質の道（最初の出力）=${ess.code ?? "-"}・下書きの道=${draft?.code ?? "-"}・合格=${fail.score?.pass ?? "-"}`,
    ...fa.map((a, i) => `依頼${i + 1}の判定: ${a.covered ? "○" : "✕"} ${one(a.why, 160)}`),
    ...(draft?.text ? splitLines(`下書き: ${draft.text}`).slice(0, 14) : ["下書き: なし（ブレインの段だけ）"]),
  ] });
  if (rows.length > 1) sec.push({ name: "他の回", lines: rows.map((r) => `回${r.rep ?? "?"}: 合格=${r.score?.pass ?? "-"}・道=${((r.path ?? {}) as { code?: string }).code ?? "-"}・下書き「${one(((r.draft ?? {}) as { text?: string }).text ?? "", 70)}」`) });
  // 材料（録音）
  const be = pickEntry(o.idx, { problem: id, rep: fail.rep ?? null, at: String(fail.at ?? ""), kind: "brain" });
  const bc = be ? readCassette(be.f) : null;
  if (bc) {
    const t = requestText(bc);
    const ex = excerptOf({ name: "材料A", text: `${t.user}\n${t.system}`, budget: 22_000 }, kw);
    sec.push({ name: `材料A ブレインに渡した要求の抜粋（${ex.kept}/${ex.total}行・名札 ${be!.action}）`, lines: ex.lines });
  } else sec.push({ name: "材料A ブレインに渡した要求", lines: ["（録音が見つからない）"] });
  const hasDraft = !!draft?.text;
  const de = hasDraft ? pickEntry(o.idx, { problem: id, rep: fail.rep ?? null, at: String(fail.at ?? ""), kind: "draft" }) : null;
  const dc = de ? readCassette(de.f) : null;
  if (dc) {
    const t = requestText(dc);
    const exU = excerptOf({ name: "材料B", text: t.user, budget: 14_000, weight: 1.5, instructions: true }, kw);
    const exS = excerptOf({ name: "材料B0", text: t.system, budget: 3_000, weight: 0.5 }, kw);
    sec.push({ name: `材料B 下書きに渡した要求（この番の指示）の抜粋（${exU.kept}/${exU.total}行）`, lines: exU.lines });
    sec.push({ name: `材料B0 下書きの共通の決まりの抜粋（${exS.kept}/${exS.total}行）`, lines: exS.lines });
  } else if (hasDraft) sec.push({ name: "材料B 下書きに渡した要求", lines: ["（録音が見つからない）"] });
  sec.push({ name: "関係する設計知見", lines: o.links.slice(0, 4).map((l) => `${l.kbId.slice(0, 8)}（${l.kind}・${l.score.toFixed(2)}）${one(l.title, 90)} — ${one(l.decided, 120)}`) });
  let dropped = 0;
  const masked = sec.map((s) => { const m = maskLines(s.lines, mask); dropped += m.dropped; return { name: s.name, lines: m.lines }; });
  return { ...base, sections: masked, dropped, ...(cutSkip ? { skip: cutSkip } : {}) };
}

// ─── 毎日拾った弱い所 → まとめた材料（本番の番の材料の写しは無い） ───────────────────
function minerCase(day: string, s: Spot, kbTitle: (id8: string) => { id: string; title: string } | null): Case {
  const mask = (x: string) => maskBareRoomNo(maskRoomNo(maskForEmbedding(x)));
  const kb = s.kb.map(kbTitle).filter((x): x is { id: string; title: string } => !!x);
  const lines = [
    `箱: ${s.bucket}・場面: ${s.scene}・直し方の型: ${s.typeJa}・数 ${s.n}・うち竹内さんの番 ${s.takeuchi}`,
    "（本番の番＝ブレインに渡した材料・ブレインの判断の写しはここには無い。下書きと実送信の差から分ける。材料の要る分け方は『分けられない』でよい）",
    ...s.examples.slice(0, 3).flatMap((e, i) => [
      `例${i + 1}（${e.at.slice(0, 10)}・近さ ${e.sim}）お客様: ${e.customer}`,
      `例${i + 1} AI の下書き: ${e.draft}`,
      `例${i + 1} スタッフの実送信（正解）: ${e.sent}`,
      ...(e.llm ? [`例${i + 1} 直し方（LLM の1語）: ${e.llm.kind} ${e.llm.note}`] : []),
    ]),
  ];
  const m = maskLines(lines, mask);
  return {
    caseId: `miner:${day}:${s.key}`, source: "miner", ids: [s.key], title: `弱い所 ${s.scene}｜${s.typeJa.replace(/（.*$/, "")}（${s.n}件・竹内さん ${s.takeuchi}）`, kb, dropped: m.dropped,
    sections: [{ name: "毎日拾った弱い所（大きく直された番）", lines: m.lines }, { name: "関係する設計知見", lines: kb.map((k) => `${k.id.slice(0, 8)} ${one(k.title, 100)}`) }],
  };
}

// ─── DeepSeek（試験の判定と同じ呼び方） ────────────────────────────────────
async function explain(userText: string): Promise<{ json: unknown; usd: number; usage: { miss: number; hit: number; out: number } } | null> {
  const key = process.env.DEEPSEEK_API_KEY ?? process.env.LLM_ALT_DEEPSEEK_KEY;
  if (!key) throw new Error("DEEPSEEK_API_KEY が無い");
  const { DEEPSEEK_ENDPOINT, DEEPSEEK_DEFAULT_MODEL } = await import("../app/lib/llm-alt-provider");
  const model = process.env.EXAM_JUDGE_MODEL || process.env.DEEPSEEK_MODEL || DEEPSEEK_DEFAULT_MODEL;
  const pr = altPriceOf(model) ?? { in: 0.66, read: 0.022, out: 1.98 };
  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      const res = await fetch(DEEPSEEK_ENDPOINT, {
        method: "POST", headers: { "Content-Type": "application/json", Authorization: `Bearer ${key}` },
        body: JSON.stringify({ model, messages: [{ role: "system", content: EXPLAIN_SYSTEM }, { role: "user", content: userText }], temperature: 0, max_tokens: 1800, response_format: { type: "json_object" }, thinking: { type: "disabled" } }),
        signal: AbortSignal.timeout(120_000),
      });
      const j = await res.json() as { choices?: Array<{ message?: { content?: string } }>; usage?: { prompt_cache_hit_tokens?: number; prompt_cache_miss_tokens?: number; completion_tokens?: number } };
      if (!res.ok) throw new Error(`DeepSeek ${res.status}: ${JSON.stringify(j).slice(0, 200)}`);
      const usage = { miss: j.usage?.prompt_cache_miss_tokens ?? 0, hit: j.usage?.prompt_cache_hit_tokens ?? 0, out: j.usage?.completion_tokens ?? 0 };
      const usd = usdOf(usage, pr, isDeepseekPeakAt(new Date()));
      let json: unknown = null; try { json = JSON.parse(String(j.choices?.[0]?.message?.content ?? "{}")); } catch { json = String(j.choices?.[0]?.message?.content ?? ""); }
      return { json, usd, usage };
    } catch (e) { if (attempt === 1) { log(`  ⚠ 説明の失敗: ${e instanceof Error ? e.message : e}`); return null; } }
  }
  return null;
}
/** 申込以降の会話だけ（--post-apply=claude）: Claude（本番のブレインと同じ Sonnet 5）。前置きは同じ・JSON だけを返させる */
const CLAUDE_MODEL = process.env.SELF_REVIEW_CLAUDE_MODEL || "claude-sonnet-5";
async function explainClaude(userText: string): Promise<{ json: unknown; usd: number; usage: { miss: number; hit: number; out: number } } | null> {
  const key = process.env.ANTHROPIC_API_KEY;
  if (!key) throw new Error("ANTHROPIC_API_KEY が無い");
  const { claudeUsageUsd, usageFromAnthropic } = await import("../app/lib/llm-price");
  try {
    const res = await fetch("https://api.anthropic.com/v1/messages", {
      method: "POST", headers: { "Content-Type": "application/json", "x-api-key": key, "anthropic-version": "2023-06-01" },
      body: JSON.stringify({ model: CLAUDE_MODEL, max_tokens: 2500, thinking: { type: "disabled" }, system: EXPLAIN_SYSTEM, messages: [{ role: "user", content: `${userText}

出力は JSON の1つだけ（前置き・考えの過程・コードの囲みは書かない。why は200字以内・plan は200字以内）。` }] }),
      signal: AbortSignal.timeout(180_000),
    });
    const j = await res.json() as { content?: Array<{ type: string; text?: string }>; usage?: Record<string, unknown> };
    if (!res.ok) throw new Error(`Claude ${res.status}: ${JSON.stringify(j).slice(0, 200)}`);
    const u = usageFromAnthropic(CLAUDE_MODEL, j.usage);
    const text = (j.content ?? []).filter((c) => c.type === "text").map((c) => c.text ?? "").join("");
    let json: unknown = null; try { json = JSON.parse(text.slice(text.indexOf("{"), text.lastIndexOf("}") + 1)); } catch { json = text; log(`  （Claude の答えが JSON で読めない: 種類 ${(j.content ?? []).map((c) => c.type).join(",")}・${[...text].length}字・頭「${[...text].slice(0, 160).join("").replace(/s+/g, " ")}」・尾「${[...text].slice(-120).join("").replace(/s+/g, " ")}」）`); }
    return { json, usd: claudeUsageUsd(u), usage: { miss: Number(u.input_uncached ?? 0), hit: Number(u.cache_read ?? 0), out: Number(u.output_tokens ?? 0) } };
  } catch (e) { log(`  ⚠ 説明の失敗（Claude）: ${e instanceof Error ? e.message : e}`); return null; }
}

type Saved = { caseId: string; source: "exam" | "miner"; ids: string[]; title: string; kb: Array<{ id: string; title: string }>; at: string; usd: number; packetChars: number; llm?: string; exp: Explanation };
function writeReport(day: string) {
  const dir = dayDir(day);
  const saved = readJsonl<Saved>(join(dir, "explanations.jsonl"));
  // 同じ件は新しい説明だけ
  const latest = new Map<string, Saved>(); for (const s of saved) latest.set(s.caseId, s);
  const results: CaseResult[] = [...latest.values()].map((s) => ({ caseId: s.caseId, source: s.source, ids: s.ids, title: s.title, kb: s.kb, exp: s.exp }));
  const bundles = bundleProposals(results);
  const usd = saved.reduce((a, s) => a + (s.usd ?? 0), 0);
  const skipped = existsSync(join(dir, "skipped.json")) ? JSON.parse(readFileSync(join(dir, "skipped.json"), "utf8")) as string[] : [];
  const md = renderMarkdown({ day, results, bundles, usd, skipped });
  writeFileSync(join(dir, "proposals.json"), JSON.stringify({ day, at: new Date().toISOString(), bundles }, null, 1));
  writeFileSync(join(dir, "report.md"), md);
  writeFileSync(join(SELF_REVIEW_DIR, "latest.md"), md);
  const line = morningLine(day, results, bundles);
  writeFileSync(join(dir, "morning-line.txt"), line + "\n");
  return { results, bundles, line, usd, file: join(dir, "report.md") };
}
/** 朝の報告が読む表に書く（--no-db・表が無い・止めている時は書かない） */
async function saveToDb(sb: SupabaseClient | null, day: string, rep: ReturnType<typeof writeReport>): Promise<void> {
  if (flag("no-db")) { log("  表には書かない（--no-db）"); return; }
  if (!sb) return;
  const r: { ok: boolean; reason?: string; proposals?: number } = await writeSelfReviewToDb(sb, { day, line: rep.line, results: rep.results, bundles: rep.bundles, usd: rep.usd })
    .catch((e) => ({ ok: false, reason: e instanceof Error ? e.message : String(e) }));
  log(r.ok ? `  朝の報告の表に書いた（案 ${r.proposals ?? 0}束）` : `  朝の報告の表に書けない: ${r.reason}`);
}
/** 表に書く時だけ service role（無ければ書かない） */
const dbClient = (): SupabaseClient | null => {
  const url = process.env.NEXT_PUBLIC_SUPABASE_URL, skey = process.env.SUPABASE_SERVICE_ROLE_KEY;
  return url && skey ? createClient(url, skey) : null;
};

(async () => {
  if (String(process.env.BRAIN_SELF_REVIEW ?? "").toLowerCase() === "off") { log("BRAIN_SELF_REVIEW=off（止めている）"); return; }
  const day = jstDate();
  if (flag("report")) { const r = writeReport(day); log(`一覧: ${r.file}\n${r.line}`); await saveToDb(dbClient(), day, r); return; }
  if (flag("nightly") && !flag("force") && existsSync(join(dayDir(day), "nightly-done.txt"))) { log(`今日（${day}）の毎晩の自己点検は済んでいる（--force で流し直す）`); return; }
  const url = process.env.NEXT_PUBLIC_SUPABASE_URL, skey = process.env.SUPABASE_SERVICE_ROLE_KEY ?? process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY;
  if (!url || !skey) { console.error("NEXT_PUBLIC_SUPABASE_URL / key が未設定（--env-file=.env.local）"); process.exit(2); }
  const sb = createClient(url, skey);
  const cases: Case[] = [];
  const skipped: string[] = [];
  const nExam = FROM === "exam" ? MAX : FROM === "miner" ? 0 : Math.ceil(MAX * 0.6);

  if (nExam > 0) {
    const { full } = loadExamProblems(".");
    const cards = await loadCards(sb).catch(() => ({} as Record<string, { answer?: string }>));
    const links = await loadLinks(sb).catch(() => ({} as Record<string, never[]>));
    const t0 = Date.now();
    const idx = buildCassetteIndex();
    log(`録音の索引 ${idx.length}件（${((Date.now() - t0) / 1000).toFixed(1)}秒）`);
    // 落ちた問題を選ぶ
    type Pick = { id: string; rows: Row[]; why: string };
    const picks: Pick[] = [];
    if (LABEL) {
      const f = findResultsFile(LABEL, arg("results") ? [arg("results")] : []);
      if (!f) throw new Error(`答案 ${LABEL}.jsonl が見つからない（--results=<dir|file>）`);
      const rows = readRowsFile(f);
      const by = new Map<string, Row[]>(); for (const r of rows) { const a = by.get(r.id) ?? []; a.push(r); by.set(r.id, a); }
      for (const [id, rs] of by) if ((!IDS.length || IDS.includes(id)) && rs.some((r) => r.score?.pass === false)) picks.push({ id, rows: rs, why: `${LABEL} で ✕ ${rs.filter((r) => r.score?.pass === false).length}/${rs.length}` });
    } else {
      const since = Date.now() - DAYS * 86_400_000;
      const ls = readLedger().filter((l) => Date.parse(l.at) >= since);
      const latest = new Map<string, typeof ls[number]>();
      for (const l of ls) { const o = latest.get(l.id); if (!o || Date.parse(l.at) >= Date.parse(o.at)) latest.set(l.id, l); }
      const cand = [...latest.values()].filter((l) => (!IDS.length || IDS.includes(l.id)) && (!l.pass || l.cmp === "worse"))
        .sort((a, b) => Number(b.cmp === "worse") - Number(a.cmp === "worse") || Date.parse(b.at) - Date.parse(a.at));
      for (const l of cand) {
        let rows = reuseRows(l.id, l.label);
        if (!rows.length) { const f = findResultsFile(l.label); if (f) rows = readRowsFile(f).filter((r) => r.id === l.id); }
        picks.push({ id: l.id, rows, why: `${l.label}（${l.stage}）${l.cmp === "worse" ? `前より悪化（${l.cmpWhy}・${l.verdict ?? "-"}）` : `✕ ${l.codes.join(",")}`}` });
      }
    }
    for (const pk of picks) {
      if (cases.filter((c) => c.source === "exam" && !c.skip).length >= nExam) break;
      const p = full.get(pk.id);
      if (!p) { skipped.push(`${pk.id}: 問題の中身が無い`); continue; }
      const c = await examCase(sb, p, pk.rows, { card: (cards as Record<string, { answer?: string }>)[pk.id], links: ((links as Record<string, Array<{ kbId: string; title?: string; decided?: string; score: number; kind: string }>>)[pk.id] ?? []).slice().sort((a, b) => (b.kind === "fixed" ? 2 : b.score) - (a.kind === "fixed" ? 2 : a.score)), idx, why: pk.why });
      if (c.skip) { skipped.push(`${pk.id}: ${c.skip}`); if (!(arg("show-packet") && c.sections.length)) continue; }
      cases.push(c);
    }
  }
  if (FROM !== "exam") {
    const ws = latestWeakSpots();
    if (!ws) skipped.push("毎日拾った弱い所が無い（scripts/edited-turn-miner.ts を先に）");
    else {
      const kbRows = await loadKbRows(sb).catch(() => []);
      const kbTitle = (id8: string) => { const r = kbRows.find((k) => k.id.startsWith(id8)); return r ? { id: r.id, title: r.title } : null; };
      const spots = ws.spots.filter((s) => (s.takeuchi ?? 0) > 0 || (s.n ?? 0) >= 3).sort((a, b) => b.takeuchi - a.takeuchi || b.n - a.n);
      for (const s of spots) { if (cases.length >= MAX) break; cases.push(minerCase(ws.day, s, kbTitle)); }
    }
  }

  // 材料を作る・見込み
  const model = process.env.EXAM_JUDGE_MODEL || process.env.DEEPSEEK_MODEL || "deepseek-v4-pro";
  const pr = altPriceOf(model) ?? { in: 0.66, read: 0.022, out: 1.98 };
  const peak = isDeepseekPeakAt(new Date());
  const built = cases.map((c) => ({ c, packet: buildPacket(c.sections) }));
  const sp = arg("show-packet");
  if (sp) { const b = built.find((x) => x.c.ids.includes(sp) || x.c.caseId === sp); log(b ? b.packet.text : `${sp} が無い`); return; }
  // 出す前に全体でもう一度（伏せた後も個人の値が残る物は出さない）
  const ready = built.filter((b) => { const s = altPiiSignal(b.packet.text); if (s) { skipped.push(`${b.c.caseId}: 伏せた後も個人の値（${s}）`); return false; } return true; });
  const est = ready.map((b) => b.c.llm === "claude" ? estimateUsdOf(b.packet.chars, { in: 2, read: 0.2, out: 10 }, false) : estimateUsdOf(b.packet.chars, pr, peak));
  log(`\n● 説明する ${ready.length}件（試験 ${ready.filter((b) => b.c.source === "exam").length}・毎日拾った ${ready.filter((b) => b.c.source === "miner").length}）・見込み $${est.reduce((a, b) => a + b, 0).toFixed(3)}（${model}${peak ? "・2倍の時間" : ""}）`);
  for (const [i, b] of ready.entries()) log(`  ${b.c.title}｜材料 ${b.packet.chars}字・落とした行 ${b.c.dropped}・見込み $${est[i].toFixed(4)}`);
  for (const s of skipped) log(`  ・出さない: ${s}`);
  writeFileSync(join(dayDir(day), "skipped.json"), JSON.stringify(skipped, null, 1));
  if (flag("dry")) return;
  if (peak && !flag("allow-peak")) { log("⏸ 平日 JST 10〜13・15〜19 は DeepSeek が2倍なので流さない（--allow-peak で流す）"); return; }
  const cap = dailyCapUsd(process.env);
  let used = 0;
  if (cap !== null) {
    used = await readDailySpend(sb).then((x) => x.usd).catch(() => cap);
    log(`  今日の試験の費用 $${used.toFixed(2)}（うち DB の外 $${readLocalSpendToday().usd.toFixed(3)}）／上限 $${cap}`);
  }
  let spent = 0;
  for (const [i, b] of ready.entries()) {
    if (spent + est[i] > USD_MAX) { log(`⏹ この実行の上限 $${USD_MAX} に届くので止める`); break; }
    if (cap !== null && used + spent + est[i] > cap) { log(`⏹ 1日の上限 $${cap} に届くので止める（今日 $${(used + spent).toFixed(2)}）`); break; }
    const user = `${b.packet.text}\n\n上の番（${b.c.title}）で、正解（竹内さんの実送信）からずれた所を説明し、直しを1つ出してください。`;
    const r = b.c.llm === "claude" ? await explainClaude(user) : await explain(user);
    if (!r) continue;
    spent += r.usd;
    appendLocalSpend({ at: new Date().toISOString(), tool: b.c.llm === "claude" ? "brain-self-review-claude" : "brain-self-review", usd: r.usd, calls: 1 });
    const exp = parseExplanation(r.json, b.packet);
    delete exp.raw;
    const saved: Saved = { caseId: b.c.caseId, source: b.c.source, ids: b.c.ids, title: b.c.title, kb: b.c.kb, at: new Date().toISOString(), usd: r.usd, packetChars: b.packet.chars, llm: b.c.llm ?? "deepseek", exp };
    appendJsonl(join(dayDir(day), "explanations.jsonl"), [saved]);
    const m = exp.findings[0];
    log(`\n■ ${b.c.title}（$${r.usd.toFixed(4)}・入力 ${r.usage.miss + r.usage.hit}（一致 ${r.usage.hit}）・出力 ${r.usage.out}）`);
    for (const f of exp.findings) log(`  ${f.grounded ? "●" : "○根拠なし"} ${f.where}（${f.confidence}・${f.causeKey}）: ${f.why}\n${f.evidence.filter((e) => e.ok).map((e) => `     L${e.line}［${e.section}］「${e.quote}」`).join("\n")}`);
    if (exp.fix) log(`  → 直し: ${exp.fix.kind}｜${exp.fix.target}｜${exp.fix.plan}${exp.fix.question ? `｜聞く: ${exp.fix.question}` : ""}`);
    if (exp.invalid.length) log(`  捨てた: ${exp.invalid.join("・")}`);
    if (!m) log("  （説明が無い）");
  }
  const rep = writeReport(day);
  log(`\n● 費用 $${spent.toFixed(4)}・一覧 ${rep.file}\n${rep.line}`);
  await saveToDb(dbClient(), day, rep);
  if (flag("nightly")) writeFileSync(join(dayDir(day), "nightly-done.txt"), `${new Date().toISOString()}\n`);
  for (const bd of rep.bundles.slice(0, 8)) log(`  [${bd.needsTakeuchi ? "聞く" : bd.kind}] ${bd.causeKeys.join("／")}（${bd.n}件・${bd.ids.join(",")}）`);
})().catch((e) => { console.error(e instanceof Error ? e.stack ?? e.message : e); process.exitCode = 1; });
