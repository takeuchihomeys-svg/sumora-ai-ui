// scripts/edited-turn-miner.ts — 大きく直された番を拾い、試験の問題の候補と弱い所の候補の一覧を作る（手で回す・毎日・DB を読むだけ）
//
// 2026-10-16 竹内さん「毎日、AI の下書き（返信・AIX）と実際に送った文を比べ、大きく直された番を自動で拾う → 試験の問題・弱い所の候補」。
//   決まり: app/lib/edited-turn-miner.ts／DB: app/lib/edited-turn-miner-server.ts。本番の毎日の見張り（数だけ）は /api/cron/line-watch-daily（cron_run_logs の edited-turn-miner）。
//   このスクリプトは手元で回す: 試験の道具（problems の共有の置き場・spec.json・brain-exam-add）が手元のファイルなので本番の cron では作れない／LLM の費用をここで絞る。
//
// 出す物（<倉庫の根>/.claude/exam-cache/edited-turns/<JST の日付>/・.gitignore・伏せた文だけ）:
//   exam-batch.json … brain-exam-add.ts --add-batch に渡す ExamSpec の配列（竹内さんの番・返信の番だけ・正解の道は実送信から・依頼の point は実送信を2重に伏せた物）
//   weak-spots.json … 弱い所の候補（箱×場面×型・数・竹内さんの番の数・関係する設計知見 id・代表の番は会話の hash と伏せた要旨）
//   seen.json（日付の外）… もう出した番（次の日に同じ番を出さない）
// 個人情報: 文は maskExamText（名前・電話・メール・現住所・生年月日）→ maskForEmbedding（maskPII＋生年月日・12桁）→ 部屋番号 の2重。会話 id は hash（exam-batch の conv だけ生の id＝問題を作るのに要る・手元だけ）
// LLM: 既定は呼ばない（費用0）。--llm で「量しか言えない番（書き直し・長さだけ）」の直し方を DeepSeek（deepseek-flash・推論なし・温度0・固定の前置き）で1語に分ける。
//   申込以降・申込の書類の印がある会話・伏せた後も個人の値が残る本文（alt-pii-gate）は DeepSeek に出さない。1日の上限（既定 30回・--llm-max）。llm_usage_logs には書かない（DB に書かない）
// 止める: EDITED_TURN_MINER=off
//
// 実行: npx tsx --env-file=.env.local scripts/edited-turn-miner.ts [--days=2] [--llm] [--llm-max=30] [--max-exam=10] [--add] [--show=3] [--no-seen] [--out=<dir>]
//   --add … 作った exam-batch.json を brain-exam-add.ts --add-batch でそのまま足す（spec.json・problems.json が変わる＝コミットは人が中身を読んでから）
import { createClient } from "@supabase/supabase-js";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { execFileSync } from "node:child_process";
import { mineEditedTurns } from "../app/lib/edited-turn-miner-server";
import { examSpecOf, weakSpotsOf, editedTurnMinerEnabled, needsLlmLabel, EDIT_TYPE_JA, BUCKET_JA, type MinedTurn, type ExamSpecCandidate } from "../app/lib/edited-turn-miner";
import { maskForEmbedding } from "../app/lib/pii-mask";
import { altPiiSignal } from "../app/lib/alt-pii-gate";
import { cutBeforeApplicationMaterial } from "../app/lib/test-pii-guard";
import { callDeepSeek } from "../app/lib/vision-alt-provider";
import { DEEPSEEK_FLASH_USD_PER_M, isDeepseekPeak } from "../app/lib/customer-pref-learning";
import { maskExamText, addressNamesOf } from "./lib/brain-exam-mask";
import { maskRoomNo } from "./lib/exam-rag-run";
import { examCacheRoot } from "./lib/llm-cassette";
import { atomicWriteJson } from "./lib/exam-shared-file";

const args = process.argv.slice(2);
const arg = (k: string, d = "") => args.find((a) => a.startsWith(`--${k}=`))?.slice(k.length + 3) ?? d;
const flag = (k: string) => args.includes(`--${k}`);
const DAYS = Math.max(1, Number(arg("days", "2")) || 2);
const LLM_MAX = Math.max(0, Number(arg("llm-max", "30")) || 0);
const MAX_EXAM = Math.max(0, Number(arg("max-exam", "10")) || 0);
const SHOW = Math.max(0, Number(arg("show", "3")) || 0);
const jstDate = (ms = Date.now()) => new Date(ms + 9 * 3600_000).toISOString().slice(0, 10);
const ROOT = arg("out") || join(examCacheRoot(), "edited-turns");
const one = (s: string, n: number) => [...String(s ?? "").replace(/\s+/g, " ").trim()].slice(0, n).join("");

/** 2重に伏せる（会話の名前・こちらが呼んだ名前も） */
function masker(name: string | null, texts: string[]): (s: string) => string {
  const names = addressNamesOf(texts);
  return (s: string) => maskRoomNo(maskForEmbedding(maskExamText(s, name, names)));
}

// ── DeepSeek（任意）: 量しか言えない番の直し方を1語に
const LABEL_SYSTEM = [
  "あなたは賃貸仲介の LINE の返信を比べる係です。AI の下書きと、スタッフが実際に送った文を読み、スタッフが「どう直したか」を1つだけ選びます。",
  "選ぶ語（この中から1つ）: 答える相手の取り違え（別の質問・別の物件に答えた）／答えの不足（聞かれた事に答えていない）／余計な事（頼まれていない話・誘い・約束を足した）／",
  "事実の誤り（金額・日時・条件が違う）／人しか知らない事（管理会社の回答・空き・内覧日・見積の金額をスタッフが書いた）／言い方（敬語・長さ・口調だけ）／その他",
  '出力は JSON だけ: {"kind":"<選んだ語>","note":"<30字以内・名前や番号は書かない>"}',
].join("\n");
type Usage = { calls: number; input: number; cacheHit: number; output: number; usd: number; skippedPii: number; skippedCap: number };
async function llmLabel(turns: MinedTurn[], masks: Map<string, (s: string) => string>, usage: Usage, budgetLeft: number): Promise<void> {
  for (const t of turns) {
    if (t.bucket === "aix_turn" || !needsLlmLabel(t.types)) continue;
    if (usage.calls >= budgetLeft) { usage.skippedCap++; continue; }
    // 申込の書類の印がある番・伏せた後も個人の値が残る本文は出さない
    if (cutBeforeApplicationMaterial([{ text: t.customer }, { text: t.draft }, { text: t.sent }]).cutAt !== null) { usage.skippedPii++; continue; }
    const mask = masks.get(t.conv) ?? ((s: string) => s);
    const body = `お客様: ${one(mask(t.customer), 300)}\n\nAI の下書き: ${one(mask(t.draft), 600)}\n\nスタッフの実送信: ${one(mask(t.sent), 600)}`;
    if (altPiiSignal(body)) { usage.skippedPii++; continue; }
    const r = await callDeepSeek(LABEL_SYSTEM, body, { model: "deepseek-flash", maxTokens: 120, timeoutMs: 30_000, thinking: false, temperature: 0 });
    usage.calls++;
    if (!r) continue;
    const peak = isDeepseekPeak(new Date().toISOString()) ? 2 : 1;
    const miss = Math.max(0, r.usage.input - r.usage.cacheHit);
    usage.input += r.usage.input; usage.cacheHit += r.usage.cacheHit; usage.output += r.usage.output;
    usage.usd += peak * (miss * DEEPSEEK_FLASH_USD_PER_M.input + r.usage.cacheHit * DEEPSEEK_FLASH_USD_PER_M.cacheHit + r.usage.output * DEEPSEEK_FLASH_USD_PER_M.output) / 1e6;
    try { const j = JSON.parse(r.text.replace(/^```(?:json)?|```$/g, "").trim()) as { kind?: string; note?: string }; if (j.kind) t.llmLabel = { kind: String(j.kind).slice(0, 20), note: one(maskForEmbedding(String(j.note ?? "")), 30) }; } catch { /* 崩れた答えは捨てる */ }
  }
}

(async () => {
  if (!editedTurnMinerEnabled()) { console.log("EDITED_TURN_MINER=off（止めている）"); return; }
  const url = process.env.NEXT_PUBLIC_SUPABASE_URL, key = process.env.SUPABASE_SERVICE_ROLE_KEY ?? process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY;
  if (!url || !key) { console.error("NEXT_PUBLIC_SUPABASE_URL / key が未設定（--env-file=.env.local）"); process.exit(2); }
  const sb = createClient(url, key);
  const now = Date.now();
  const rep = await mineEditedTurns(sb, { sinceMs: now - DAYS * 86_400_000, untilMs: now });
  const masks = new Map<string, (s: string) => string>();
  for (const t of rep.turns) if (!masks.has(t.conv)) masks.set(t.conv, masker(rep.names[t.conv] ?? null, rep.turns.filter((x) => x.conv === t.conv).flatMap((x) => [x.sent, x.draft])));

  // LLM（任意・1日の上限）
  const day = jstDate(now), dir = join(ROOT, day);
  mkdirSync(dir, { recursive: true });
  const usageFile = join(dir, "llm-usage.json");
  const usedToday = existsSync(usageFile) ? (JSON.parse(readFileSync(usageFile, "utf8")) as Usage).calls : 0;
  const usage: Usage = { calls: 0, input: 0, cacheHit: 0, output: 0, usd: 0, skippedPii: 0, skippedCap: 0 };
  // 2026-10-16 確かめる人: 会話の状態が読めなかった時は申込以降の止めが効かないので DeepSeek に出さない
  if (flag("llm") && rep.errors.length) console.log("⚠ 読めなかった物があるので DeepSeek は呼ばない（申込以降の止めが効かない）");
  else if (flag("llm")) {
    await llmLabel(rep.turns, masks, usage, Math.max(0, LLM_MAX - usedToday));
    writeFileSync(usageFile, JSON.stringify({ ...usage, calls: usedToday + usage.calls }, null, 1));
  }

  // 数
  const by = (f: (t: MinedTurn) => string) => { const m = new Map<string, number>(); for (const t of rep.turns) m.set(f(t), (m.get(f(t)) ?? 0) + 1); return [...m].sort((a, b) => b[1] - a[1]); };
  console.log(`● ${DAYS}日（${rep.since.slice(0, 16)}〜${rep.until.slice(0, 16)} UTC）比べた組: 返信 ${rep.pairs.reply}・AIX ${rep.pairs.aix}／外した: 申込以降 ${rep.skipped.postApply}・テスト ${rep.skipped.test}`);
  console.log(`● 拾った番 ${rep.turns.length}（竹内さん ${rep.turns.filter((t) => t.writer === "takeuchi").length}・従業員 ${rep.turns.filter((t) => t.writer === "employee").length}）`);
  console.log(`  箱: ${by((t) => BUCKET_JA[t.bucket]).map(([k, v]) => `${k} ${v}`).join("・")}`);
  const tc = new Map<string, number>(); for (const t of rep.turns) if (t.bucket !== "aix_turn") for (const ty of t.types) tc.set(ty, (tc.get(ty) ?? 0) + 1);
  console.log(`  直し方の型（返信・AIX の文）: ${[...tc].sort((a, b) => b[1] - a[1]).map(([k, v]) => `${EDIT_TYPE_JA[k as keyof typeof EDIT_TYPE_JA].replace(/（.*$/, "")} ${v}`).join("・")}`);
  console.log(`  AIX の番の型: ${by((t) => (t.bucket === "aix_turn" ? t.humanKinds[0] ?? "-" : "")).filter(([k]) => k).map(([k, v]) => `${k} ${v}`).join("・") || "-"}`);
  console.log(`  場面: ${by((t) => t.sceneJa).slice(0, 12).map(([k, v]) => `${k} ${v}`).join("・")}`);
  if (flag("llm")) {
    const lc = by((t) => t.llmLabel?.kind ?? "").filter(([k]) => k);
    console.log(`● DeepSeek: ${usage.calls}回（今日の計 ${usedToday + usage.calls}/${LLM_MAX}）入力 ${usage.input}（キャッシュ一致 ${usage.cacheHit}）出力 ${usage.output} 約$${usage.usd.toFixed(5)}・個人情報で出さず ${usage.skippedPii}・上限で出さず ${usage.skippedCap}`);
    console.log(`  直し方（LLM）: ${lc.map(([k, v]) => `${k} ${v}`).join("・") || "-"}`);
  }

  // 弱い所の候補
  const spots = weakSpotsOf(rep.turns);
  const byKey = new Map(rep.turns.map((t) => [`${t.convHash}|${t.at}`, t]));
  const spotsOut = spots.map((w) => ({
    ...w, typeJa: w.bucket === "aix_turn" ? "人しか知らない事・AIX を押した" : EDIT_TYPE_JA[w.type],
    examples: w.examples.map((e) => { const t = byKey.get(`${e.convHash}|${e.at}`); const m = t ? masks.get(t.conv)! : (s: string) => s; return { ...e, customer: one(m(t?.customer ?? ""), 50), draft: one(m(t?.draft ?? ""), 80), sent: one(m(t?.sent ?? ""), 80), llm: t?.llmLabel ?? null }; }),
  }));
  atomicWriteJson(join(dir, "weak-spots.json"), { day, days: DAYS, pairs: rep.pairs, picked: rep.turns.length, spots: spotsOut }, true);
  console.log(`\n● 弱い所の候補 上位（箱｜場面｜型 → 数（竹内さん）・関係する知見）`);
  for (const w of spotsOut.slice(0, 12)) console.log(`  ${BUCKET_JA[w.bucket].slice(0, 12)}｜${w.scene}｜${w.bucket === "aix_turn" ? w.key.split("|")[2] : w.typeJa.replace(/（.*$/, "")} → ${w.n}（${w.takeuchi}）・${w.kb.join(",")}`);

  // 試験の問題の候補（竹内さんの番・もう入っている番・前に出した番は外す）
  const spec = existsSync("scripts/brain-exam/spec.json") ? JSON.parse(readFileSync("scripts/brain-exam/spec.json", "utf8")) as Array<{ conv: string; at: string }> : [];
  const seenFile = join(ROOT, "seen.json");
  const seen: Record<string, string> = !flag("no-seen") && existsSync(seenFile) ? JSON.parse(readFileSync(seenFile, "utf8")) : {};
  const cands: ExamSpecCandidate[] = [];
  for (const t of [...rep.turns].sort((a, b) => a.sim - b.sim)) {
    if (cands.length >= MAX_EXAM) break;
    const k = `${t.convHash}|${t.at}`;
    if (seen[k]) continue;
    if (spec.some((s) => s.conv === t.conv && Math.abs(Date.parse(s.at) - Date.parse(t.at)) < 6 * 3600_000)) continue;
    const c = examSpecOf(t, masks.get(t.conv)!);
    if (!c) continue;
    if (t.llmLabel) c.tags.push(`直し方:${t.llmLabel.kind}`);
    cands.push(c); seen[k] = day;
  }
  const batchFile = join(dir, "exam-batch.json");
  atomicWriteJson(batchFile, cands, true);
  if (!flag("no-seen")) atomicWriteJson(seenFile, seen, true);
  console.log(`\n● 試験の問題の候補 ${cands.length}問 → ${batchFile}`);
  for (const c of cands.slice(0, SHOW)) console.log(`  [${c.type}／${c.stage}] 正解の道=${c.accept.join("|")}${c.mustNot.length ? ` ×${c.mustNot.join("|")}` : ""}\n    客「${one(c.asks[0].q, 70)}」\n    実「${one(c.asks[0].point, 110)}」\n    型: ${c.tags.slice(1).join("・")}`);
  if (flag("add") && cands.length) {
    console.log("\n● brain-exam-add --add-batch で足す");
    execFileSync("npx", ["tsx", "--env-file=.env.local", "scripts/brain-exam-add.ts", `--add-batch=${batchFile}`], { stdio: "inherit", shell: process.platform === "win32" });
  } else if (cands.length) console.log(`  足す: npx tsx --env-file=.env.local scripts/brain-exam-add.ts --add-batch=${batchFile}`);
  if (rep.errors.length) console.log("⚠ 読めなかった物:", rep.errors.slice(0, 5).join(" / "));
})().catch((e) => { console.error(e instanceof Error ? e.message : e); process.exitCode = 1; });
