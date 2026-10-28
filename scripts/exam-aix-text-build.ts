// scripts/exam-aix-text-build.ts — 試験の「AIX の文」の段の問題を本番から作る（読むだけ・LLM なし）
//
// 2026-10-22 試験のブレインの穴（AIX の文を作って採点する段が無かった）。正解＝竹内さんが実際に送った AIX の通（messages.staff_writer='takeuchi'・竹内基準）。
//   番は今までの道具で作る（同じ切り方・伏せ方）: scripts/audit-r9s2-aix-cases.ts --fixed（1通目・aix/action・物件オススメの✨この会話に合った文）／
//   scripts/audit-r11-aix-second-cases.ts（✨2通目）。押下の前の会話（申込の書類の手前で切る・名前は YUMA・maskPII）とピッカーの値が入力。
//   ここで個人の値の関所（piiValueSignal・書類・審査の事情・お客様の名前の一覧）を通し、ボタン×ピッカーを散らして約30問を選ぶ（scripts/lib/exam-aix-text.ts の DEFAULT_QUOTA）。
//   置き場は試験の取り置きの根（<倉庫の根>/.claude/exam-cache/aix-text-exam/questions.json・.gitignore・伏せた会話が入るので倉庫に上げない）。
// 実行: npx tsx --env-file=.env.local scripts/exam-aix-text-build.ts [--since=2026-08-01] [--reuse-raw] [--quota=property_send:aix=6,...]
import { execSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { examCacheRoot } from "./lib/llm-cassette";
import { piiValueSignal, applicationMaterialReason } from "../app/lib/test-pii-guard";
import { screeningSensitiveSignal } from "../app/lib/screening-sensitive";
import { BUTTON_JA, DEFAULT_QUOTA, goldUnusable, pickQuestions, questionHash, type AixQuestion, type AixTextKind } from "./lib/exam-aix-text";

const arg = (k: string, d = "") => process.argv.find((a) => a.startsWith(`--${k}=`))?.slice(k.length + 3) ?? d;
const SINCE = arg("since", "2026-08-01T00:00:00Z");
export const AIX_EXAM_DIR = join(examCacheRoot(), "aix-text-exam");
// 2026-10-29 --raw1/--raw2: 生の番の置き場を分ける（既定の raw-*.json を上書きしない）
const RAW1 = join(AIX_EXAM_DIR, arg("raw1", "raw-first.json")), RAW2 = join(AIX_EXAM_DIR, arg("raw2", "raw-second.json"));
// 2026-10-29 --qfile=<名前.json>: 別の問題の組（2通目の訴求の比べ等）を同じ置き場に作る（既定の questions.json は触らない）
const OUT = join(AIX_EXAM_DIR, arg("qfile", "questions.json"));

type RawCase = { id: string; action: string; route: "aix/action" | "aix-template-generate"; src: string; at: string; body: Record<string, unknown>; sent: string; inputText: string };

function pickerOf(c: RawCase, type: string, kind: AixTextKind): string | null {
  const b = c.body;
  if (kind !== "aix") return String(b.pickupType ?? (type === "estimate_sheet" ? "1件" : "")) || null;
  if (type === "property_check_result") return String(b.check_pattern ?? "") || null;
  if (type === "property_send") return String(b.send_mode ?? "") || null;
  if (type === "application_push") return String(b.app_sub_mode ?? "") || null;
  if (type === "viewing_invite" || type === "meeting_place") return b.conversation_match ? "会話を合わせる" : "固定";
  if (type === "estimate_sheet") return "1件";
  return null;
}
function toQuestion(c: RawCase, from: "first" | "second"): AixQuestion | null {
  let type: string, kind: AixTextKind;
  if (from === "second") { type = c.action.startsWith("estimate") ? "estimate_sheet" : "property_recommendation"; kind = "second"; }
  else if (c.id.startsWith("rec-vision")) return null; // 画像を読む経路（DeepSeek は文字だけ）
  else if (c.route === "aix-template-generate") { type = "property_recommendation"; kind = "tpl"; }
  else { type = c.action; kind = "aix"; }
  const q: Omit<AixQuestion, "hash"> = { id: `${type}:${kind}:${c.src.replace(/[^0-9a-f]/gi, "").slice(0, 8) || c.id.slice(-8)}`, aixType: type, button: BUTTON_JA[type] ?? type, picker: pickerOf(c, type, kind), kind, route: c.route, body: c.body, gold: c.sent, inputText: c.inputText, at: c.at, src: c.src };
  return { ...q, hash: questionHash(q) };
}
/** 個人の値の関所（全部の文字: 正解・会話・入力）。名前の一覧はお客様の名前（2文字以上）が残っていないか */
function piiGate(q: AixQuestion, names: string[]): string | null {
  const recent = ((q.body.recent_messages ?? q.body.recentMessages) as Array<{ text: string }> | undefined) ?? [];
  const texts = [q.gold, q.inputText, ...recent.map((m) => m.text), String(q.body.sentMessage ?? "")];
  for (const t of texts) { const r = piiValueSignal(t); if (r) return `個人の値（${r}）`; }
  // 審査の事情（夜の仕事・外国籍・保証人の事情 等）は本番では Claude に固定（SCREENING_PII_CLAUDE）＝DeepSeek の試験に回さない
  for (const t of texts) { const r = screeningSensitiveSignal(t); if (r) return `審査の事情（${r.category}）`; }
  for (const t of [q.inputText, ...recent.map((m) => m.text)]) { const r = applicationMaterialReason(t); if (r) return `書類（${r}）`; }
  const all = texts.join("\n");
  // 短い名前（3文字以下・かなと英字と記号の名前）は普通の言葉に当たる（「し…」「カ…」が 45番・23番に当たった）→ 呼び方（さん・様）が付いた時だけ
  const esc = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const hit = names.find((n) => (n.length >= 4 && /[\p{Script=Han}]/u.test(n)) || n.length >= 5 ? all.includes(n) : new RegExp(`(?<![\\p{L}\\p{N}])${esc(n)}\\s*(?:さん|様|くん|ちゃん)`, "u").test(all));
  return hit ? `お客様の名前が残っている（${hit.slice(0, 1)}…）` : null;
}

(async () => {
  mkdirSync(AIX_EXAM_DIR, { recursive: true });
  const reuse = process.argv.includes("--reuse-raw") && existsSync(RAW1) && existsSync(RAW2);
  if (!reuse) {
    execSync(`npx tsx --env-file=.env.local scripts/audit-r9s2-aix-cases.ts --fixed --per=12 --since=${SINCE} --out="${RAW1}"`, { stdio: "inherit" });
    execSync(`npx tsx --env-file=.env.local scripts/audit-r11-aix-second-cases.ts --per=8 --since=${SINCE} --out="${RAW2}"`, { stdio: "inherit" });
  }
  const raw1 = (JSON.parse(readFileSync(RAW1, "utf8")) as { cases: RawCase[] }).cases;
  const raw2 = (JSON.parse(readFileSync(RAW2, "utf8")) as { cases: RawCase[] }).cases;
  const { loadKnownCustomerNames, loadKnownCallNames } = await import("../app/lib/pii-known-names");
  const names = [...new Set([...(await loadKnownCustomerNames()), ...(await loadKnownCallNames())])].map((s) => s.trim()).filter((s) => s.length >= 2 && s !== "YUMA" && !/^(?:お客様|様|さん)$/.test(s));
  const drops: Record<string, number> = {};
  const cands: AixQuestion[] = [];
  for (const [list, from] of [[raw1, "first"], [raw2, "second"]] as const) for (const c of list) {
    const q = toQuestion(c, from);
    if (!q) { drops["画像を読む経路"] = (drops["画像を読む経路"] ?? 0) + 1; continue; }
    const bad = goldUnusable(q.gold) ?? (q.kind === "second" && /^\s*[①-⑳]/.test(q.gold) ? "物件ごとの資料の一覧（入力に無い）" : null) ?? piiGate(q, names);
    if (bad) { drops[`${q.aixType}:${bad.replace(/（.*$/, "")}`] = (drops[`${q.aixType}:${bad.replace(/（.*$/, "")}`] ?? 0) + 1; continue; }
    cands.push(q);
  }
  const quota = { ...DEFAULT_QUOTA };
  for (const kv of arg("quota").split(",").filter(Boolean)) { const [k, v] = kv.split("="); if (k && Number(v) >= 0) quota[k] = Number(v); }
  const questions = pickQuestions(cands, quota);
  // 2026-10-28 --must=<元の番の id の一部,…>: 割り当て（quota）の外でも必ず入れる番（関所は通した候補だけ）。
  //   例: 物件オススメの2通目で竹内さんが「〇〇となりますが」とご希望との差を先に正直に書いた番（RECOMMEND_SECOND_WISH_NG の比べ）
  for (const key of arg("must").split(",").map((s) => s.trim()).filter(Boolean)) {
    const hit = cands.find((q) => (q.src ?? "").includes(key) || q.id.includes(key) || String((q as { rawId?: string }).rawId ?? "").includes(key));
    if (hit && !questions.some((q) => q.id === hit.id)) questions.push(hit);
    if (!hit) console.warn(`--must: ${key} は候補に無い（関所で落ちたか元の番に無い）`);
  }
  writeFileSync(OUT, JSON.stringify({ made: new Date().toISOString(), since: SINCE, quota, questions }, null, 1));
  console.log(`\n問題 ${questions.length}（候補 ${cands.length}）→ ${OUT}`);
  const by: Record<string, string[]> = {};
  for (const q of questions) (by[`${q.button}・${q.kind}`] ??= []).push(q.picker ?? "-");
  for (const [k, ps] of Object.entries(by)) console.log(`  ${k}: ${ps.length}（${ps.join("・")}）`);
  console.log(`落とした: ${Object.entries(drops).map(([k, v]) => `${k} ${v}`).join("・") || "なし"}`);
})().catch((e) => { console.error(e); process.exit(1); });
