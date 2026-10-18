// scripts/parts-eval.ts — パーツごとに測る試験（S0）: 4段の正解を作る・段ごとに数える・癖の表を出す
//
// 2026-10-18 竹内さん（設計知見 P0 c0884407）「パーツに分けて読み、つなぎと優先順位をブレインで強くして最後に生成する」＋「外れ方から癖を見つけ出し、その癖に特化して改善を繰り返す」
// 決まった計算は scripts/lib/parts-eval.ts（単体テスト scripts/lib/__tests__/parts-eval.test.ts）。
//
// 使い方:
//   ① 正解の下書き（機械）: npx tsx --env-file=.env.local scripts/parts-eval.ts --build [--ids=q008,...] [--llm]
//        spec.json（正解の鍵）＋ problems.json（竹内さんの実送信）から 4段の正解を作り scripts/parts-eval/gold-16.json と人が見る一覧 gold-16.review.md に書く。
//        --llm … DeepSeek flash に「使う事実・受け止めの抜け・先に答える項目」の下書きを1問1回だけ聞く（$0.01 未満）。平日 JST 10-13・15-19（2倍の時間）は止まる。
//        problems.json に無い問題は exam_problem_index（SELECT だけ）の answer を竹内さんの実送信として使う。
//   ② 段ごとに数える＋癖の表: npx tsx scripts/parts-eval.ts --score --runs=A=mc1018-sonnet,P=mc1018-pro,F=mc1018-flash,Fmaj=mc1018-flash:maj3
//        結果は scripts/brain-exam/results/<label>.jsonl を読む（LLM は呼ばない）。表は標準出力と scripts/brain-exam/results/parts-<名>.md に。
//        案 C（flash の判断だけ・1回／3回の多数決）・案 D（読み手 flash＋核 Claude）も、brain-exam と同じ行の形で結果を出せば同じ表に並ぶ。
import type { LlmTestHarness } from "./lib/llm-test-harness";
import { existsSync, readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { deriveGold, reorderPriority, quoteOverlap, dice, partReceive, goldToContract, scoreRow, habitTable, habitTableText, topHabitsByModel, majorityRow, parseRuns, columnOf, STAGE_JA, RECEIVE_JA, maskGoldText, type GoldParts, type ResultRow, type SpecRow, type ProblemRow, type RowScore } from "./lib/parts-eval";

const args = process.argv.slice(2);
const flag = (k: string) => args.includes(`--${k}`);
const opt = (k: string) => args.find((a) => a.startsWith(`--${k}=`))?.split("=").slice(1).join("=") ?? null;
const DEFAULT_IDS = "q008,q018,q032,q053,q056,q057,q069,q070,q156,q157,q158,q164,q166,q170,q172,q174".split(",");
const GOLD_FILE = opt("gold") ?? "scripts/parts-eval/gold-16.json";
const RESULTS_DIR = "scripts/brain-exam/results";
let harness: LlmTestHarness | null = null;

async function staffTextFromIndex(ids: string[]): Promise<Map<string, string>> {
  const out = new Map<string, string>();
  if (!ids.length) return out;
  const { createClient } = await import("@supabase/supabase-js");
  const sb = createClient(process.env.NEXT_PUBLIC_SUPABASE_URL!, process.env.SUPABASE_SERVICE_ROLE_KEY!);
  const { data, error } = await sb.from("exam_problem_index").select("id,answer").in("id", ids);
  if (error) throw new Error(`exam_problem_index を読めない: ${error.message}`);
  for (const r of data ?? []) if (r.answer) out.set(r.id as string, r.answer as string);
  return out;
}

// ─── DeepSeek flash（1問1回・下書きの補い） ───────────────────────────────
const llmCost = { calls: 0, usd: 0 };
async function flashJson(sys: string, user: string): Promise<Record<string, unknown> | null> {
  const key = process.env.DEEPSEEK_API_KEY ?? process.env.LLM_ALT_DEEPSEEK_KEY;
  if (!key) throw new Error("DEEPSEEK_API_KEY が無い");
  const { DEEPSEEK_ENDPOINT, DEEPSEEK_FLASH_MODEL } = await import("../app/lib/llm-alt-provider");
  const { altPriceOf, isDeepseekPeakAt } = await import("../app/lib/llm-price");
  if (isDeepseekPeakAt(new Date())) throw new Error("DeepSeek が2倍の時間（平日 JST 10-13・15-19）＝呼ばない");
  const res = await fetch(DEEPSEEK_ENDPOINT, {
    method: "POST", headers: { "Content-Type": "application/json", Authorization: `Bearer ${key}`, "x-sumora-llm-action": "parts_eval_gold" },
    body: JSON.stringify({ model: DEEPSEEK_FLASH_MODEL, messages: [{ role: "system", content: sys }, { role: "user", content: user }], temperature: 0, max_tokens: 2500, response_format: { type: "json_object" }, thinking: { type: "disabled" } }),
    signal: AbortSignal.timeout(90_000),
  });
  const j = await res.json() as { choices?: Array<{ message?: { content?: string } }>; usage?: { prompt_cache_hit_tokens?: number; prompt_cache_miss_tokens?: number; completion_tokens?: number } };
  if (!res.ok) throw new Error(`DeepSeek ${res.status}: ${JSON.stringify(j).slice(0, 200)}`);
  const pr = altPriceOf(DEEPSEEK_FLASH_MODEL);
  if (pr && j.usage) llmCost.usd += ((j.usage.prompt_cache_miss_tokens ?? 0) * pr.in + (j.usage.prompt_cache_hit_tokens ?? 0) * pr.read + (j.usage.completion_tokens ?? 0) * pr.out) / 1e6;
  llmCost.calls++;
  const txt = String(j.choices?.[0]?.message?.content ?? "{}");
  try { return JSON.parse(txt) as Record<string, unknown>; } catch { const a = txt.indexOf("{"), b = txt.lastIndexOf("}"); try { return a >= 0 && b > a ? JSON.parse(txt.slice(a, b + 1)) as Record<string, unknown> : null; } catch { console.warn(`  flash の答えが JSON でない: ${txt.slice(0, 120)}`); return null; } }
}
const REFINE_SYS = [
  "あなたは不動産仲介の LINE 返信の試験の正解を整える係です。お客様の今の発言・直前のこちらの送信・竹内さん（人）が実際に返した文・正解の下書き（依頼の一覧）を読みます。",
  "やる事: ①依頼ごとに、竹内さんの文が使った事実（会話・送った資料・会社の決まり・一般的な事のどれから何を）を短く書く（facts・各20字まで・basis は conversation/material/company_fact/general/judgement）。",
  "②お客様の発言の中で、下書きに無い『受け止める事』（お礼・謝り・気遣い・不安・了承）か依頼があれば extra に足す（竹内さんの文が受けていなければ route は none）。",
  "③竹内さんの文が一番先に答えている依頼の id（lead_with）。④下書きと竹内さんの文が食い違う所があれば disagree に短く書く。",
  "人の名前・電話・号室の数字は書かない。出力は JSON だけ: {\"items\":[{\"id\":\"a1\",\"facts\":[\"…\"],\"basis\":\"conversation\"}],\"extra\":[{\"quote\":\"…\",\"receive\":\"thanks|apology|care|anxiety|agree|null\",\"route\":\"reply|promise|aix|none\",\"say\":\"…\"}],\"lead_with\":\"a1\",\"disagree\":[\"…\"]}",
].join("\n");
async function refineWithFlash(g: GoldParts, prob: ProblemRow): Promise<void> {
  const lastStaff = (prob.context ?? []).filter((c) => c.s === "staff").slice(-1).map((c) => maskGoldText(c.t).slice(0, 400)).join("");
  const user = `【お客様の今の発言】\n${maskGoldText(prob.customer)}\n\n【直前のこちらの送信】\n${lastStaff || "（なし＝初回）"}\n\n【竹内さんの実際の返し】\n${g.finalText}\n\n【正解の下書き】\n${g.asks.map((a) => `${a.id}「${a.quote}」道=${a.route}${a.receive ? `・受け止め=${a.receive}` : ""}・言う事=${a.say ?? "（触れない）"}`).join("\n")}`;
  const o = await flashJson(REFINE_SYS, user);
  if (!o) { g.pending.push("flash の補いが読めなかった"); return; }
  for (const it of (o.items as Array<{ id?: string; facts?: string[]; basis?: string }> | undefined) ?? []) {
    const a = g.asks.find((x) => x.id === it.id); if (!a) continue;
    a.facts = (it.facts ?? []).map((f) => maskGoldText(String(f)).slice(0, 30)).slice(0, 4);
    if (it.basis && ["conversation", "material", "company_fact", "general", "judgement"].includes(it.basis)) a.basis = it.basis as GoldParts["asks"][number]["basis"];
  }
  for (const ex of (o.extra as Array<{ quote?: string; receive?: string | null; route?: string; say?: string }> | undefined) ?? []) {
    const q = maskGoldText(String(ex.quote ?? "")).trim(); if (!q) continue;
    if (g.asks.some((a) => a.quote.includes(q) || q.includes(a.quote) || quoteOverlap(q, a.quote) >= 0.5 || dice(q, a.quote) >= 0.35)) continue;
    // 受け止めは「受け止めだけの部分」に限る（質問・依頼の文を不安と呼んだ物は依頼として扱う）
    const rk0 = ex.receive && ex.receive in RECEIVE_JA ? ex.receive as keyof typeof RECEIVE_JA : null;
    const rk = rk0 && partReceive(q) ? rk0 : null;
    const route = (["reply", "promise", "aix", "none"].includes(String(ex.route)) ? ex.route : "reply") as GoldParts["asks"][number]["route"];
    const id = `a${g.asks.length + 1}`;
    g.asks.push({ id, quote: q, kind: rk ? "feeling" : "request", receive: rk, properties: [], route, routes: [route], answer: ex.say ? maskGoldText(ex.say).slice(0, 60) : null, basis: null, aixKey: null, status: "machine", facts: [], priority: null, say: route === "none" ? null : ex.say ? maskGoldText(ex.say) : null, why: "flash が足した", specIndex: null });
    g.pending.push(`${id}: flash が足した「${q.slice(0, 20)}」（${rk ? `受け止め:${RECEIVE_JA[rk]}` : "依頼"}・道=${route}）`);
  }
  const lw = String(o.lead_with ?? "");
  if (lw && lw !== g.leadWith && g.asks.some((a) => a.id === lw)) g.pending.push(`先に答える項目: 機械=${g.leadWith}・flash=${lw}（どちらか決めてもらう）`);
  g.notes = ((o.disagree as string[] | undefined) ?? []).slice(0, 3).map((d) => `flash の指摘: ${maskGoldText(String(d)).slice(0, 60)}`);
}

function reviewMarkdown(golds: GoldParts[]): string {
  const out: string[] = ["# パーツごとの試験の正解（16問・下書き）", "", "status: spec＝今ある spec（竹内さんの実送信から作った正解）／machine＝機械の下書き（**竹内さんの確認待ち**）", ""];
  for (const g of golds) {
    out.push(`## ${g.id}［${g.type}］ 道の正解=${g.accept.join("|")}${g.mustNotPath.length ? `・道で×=${g.mustNotPath.join("|")}` : ""}${g.pending.length ? `　⏳確認待ち ${g.pending.length}` : "　✅"}`);
    out.push("", "| id | ①依頼・受け止め | ②道 | 事実 | ③順 | 言う事 | 出どころ |", "|---|---|---|---|---|---|---|");
    for (const a of g.asks) out.push(`| ${a.id}${a.id === g.leadWith ? "★" : ""} | ${a.receive ? `〔${RECEIVE_JA[a.receive]}〕` : ""}${a.quote.replace(/\n/g, " ").slice(0, 60)}${a.label ? `〈spec: ${a.label.slice(0, 30)}〉` : ""}${a.properties.length ? `（物件: ${a.properties.join("／")}）` : ""} | ${a.routes.join("|")} | ${a.facts.join("／") || "-"} | ${a.priority ?? "-"} | ${(a.say ?? "（触れない）").replace(/\n/g, " ").slice(0, 70)} | ${a.status} |`);
    out.push("", `③言ってはいけない事: ${g.mustNot.join("／") || "（なし）"}${g.closeOnly ? "　・閉じるだけの番" : ""}`);
    out.push("", "④竹内さんの実物:", "", "> " + g.finalText.replace(/\n/g, "\n> "));
    if (g.pending.length) out.push("", "確認待ち:", ...g.pending.map((p) => `- ⏳ ${p}`));
    if (g.notes?.length) out.push("", "参考:", ...g.notes.map((p) => `- ${p}`));
    out.push("");
  }
  return out.join("\n");
}

async function build() {
  const ids = (opt("ids") ?? DEFAULT_IDS.join(",")).split(",").map((s) => s.trim()).filter(Boolean);
  const spec = JSON.parse(readFileSync("scripts/brain-exam/spec.json", "utf8")) as SpecRow[];
  const probs = existsSync("scripts/brain-exam/problems.json") ? JSON.parse(readFileSync("scripts/brain-exam/problems.json", "utf8")) as ProblemRow[] : [];
  const missing = ids.filter((id) => !probs.find((p) => p.id === id)?.staffText);
  const fromIndex = await staffTextFromIndex(missing);
  const golds: GoldParts[] = [];
  for (const id of ids) {
    const s = spec.find((x) => x.id === id); if (!s) { console.warn(`spec に無い: ${id}`); continue; }
    const p = probs.find((x) => x.id === id) ?? { id, customer: (s.asks ?? []).map((a) => a.q).join("\n"), staffText: fromIndex.get(id) ?? "" };
    if (!p.staffText) p.staffText = fromIndex.get(id) ?? "";
    const g = deriveGold(s, p);
    if (flag("llm")) { await refineWithFlash(g, p); reorderPriority(g); }
    golds.push(g);
  }
  mkdirSync("scripts/parts-eval", { recursive: true });
  writeFileSync(GOLD_FILE, JSON.stringify({ builtAt: new Date().toISOString(), note: "パーツごとの試験の正解（4段）。status=machine と pending は竹内さんの確認待ち。contract は TurnContract の形（足す欄は extra）", golds: golds.map((g) => ({ ...g, contract: goldToContract(g) })) }, null, 1));
  writeFileSync(GOLD_FILE.replace(/\.json$/, ".review.md"), reviewMarkdown(golds));
  const pend = golds.reduce((a, g) => a + g.pending.length, 0);
  console.log(`正解 ${golds.length}問・依頼の行 ${golds.reduce((a, g) => a + g.asks.length, 0)}（spec ${golds.reduce((a, g) => a + g.asks.filter((x) => x.status === "spec").length, 0)}・機械 ${golds.reduce((a, g) => a + g.asks.filter((x) => x.status === "machine").length, 0)}）・確認待ち ${pend}件（${golds.filter((g) => g.pending.length).length}問）`);
  if (flag("llm")) console.log(`flash: ${llmCost.calls}回 $${llmCost.usd.toFixed(4)}`);
  console.log(`→ ${GOLD_FILE} ／ ${GOLD_FILE.replace(/\.json$/, ".review.md")}`);
}

function score() {
  for (const includeMachine of [false, true]) scoreOnce(includeMachine);
}
function scoreOnce(includeMachine: boolean) {
  const runs = parseRuns(opt("runs") ?? "A=mc1018-sonnet,P=mc1018-pro,F=mc1018-flash,Pmaj=mc1018-pro:maj3,Fmaj=mc1018-flash:maj3");
  const gold = (JSON.parse(readFileSync(GOLD_FILE, "utf8")) as { golds: GoldParts[] }).golds;
  const byId = new Map(gold.map((g) => [g.id, g]));
  const scored: Array<RowScore & { column: string }> = [];
  const columns: string[] = [];
  for (const run of runs) {
    const f = `${RESULTS_DIR}/${run.label}.jsonl`;
    if (!existsSync(f)) { console.warn(`結果が無い: ${f}`); continue; }
    const rows = readFileSync(f, "utf8").trim().split("\n").filter(Boolean).map((l) => JSON.parse(l) as ResultRow).filter((r) => byId.has(r.id));
    if (run.majority) {
      const col = columnOf(run.plan, run.label, "maj"); columns.push(col);
      for (const id of new Set(rows.map((r) => r.id))) { const m = majorityRow(rows.filter((r) => r.id === id), run.label); if (m) scored.push({ ...scoreRow(byId.get(id)!, m, { includeMachine }), column: col }); }
    } else {
      const reps = [...new Set(rows.map((r) => r.rep))].sort((a, b) => a - b);
      for (const rep of reps) { const col = columnOf(run.plan, run.label, rep); columns.push(col); for (const r of rows.filter((x) => x.rep === rep)) scored.push({ ...scoreRow(byId.get(r.id)!, r, { includeMachine }), column: col }); }
    }
  }
  const t = habitTable(scored, columns);
  const lines: string[] = [];
  lines.push(`# パーツごとの試験（${runs.map((r) => `${r.plan}=${r.label}${r.majority ? ":maj3" : ""}`).join("・")}・正解 ${gold.length}問・${includeMachine ? "確認待ちの行（機械の下書き：受け止め等）も入れた" : "spec の行だけ（竹内さんの実送信から作った正解）"}）`, "");
  lines.push("## 癖の表（段×種類・列＝案:モデル#回・数＝外れの数）", "", habitTableText(t), "");
  lines.push("## モデルごとの癖（多い順）");
  for (const m of topHabitsByModel(t, 4)) lines.push(`- ${m.model}: ${m.top.map((x) => `${STAGE_JA[x.stage]}×${x.kind} ${x.count}`).join("・") || "外れなし"}`);
  lines.push("", "## 依頼ごとの最初に落ちた段（全列の合計）");
  const firstFail = new Map<string, Record<string, number>>();
  for (const s of scored) for (const it of s.items) { const k = `${s.id}/${it.askId}`; const m = firstFail.get(k) ?? {}; const f = it.firstFail ?? "ok"; m[f] = (m[f] ?? 0) + 1; firstFail.set(k, m); }
  for (const [k, m] of firstFail) lines.push(`- ${k}: ${Object.entries(m).map(([f, n]) => `${f === "ok" ? "正解" : STAGE_JA[f as keyof typeof STAGE_JA]} ${n}`).join("・")}`);
  const sims = scored.filter((s) => s.finalSim != null);
  if (sims.length) {
    lines.push("", "## ④最後の文の近さ（竹内さんの実物との文字の重なり・参考）");
    for (const c of columns) { const xs = sims.filter((s) => s.column === c).map((s) => s.finalSim!); if (xs.length) lines.push(`- ${c}: 平均 ${(xs.reduce((a, b) => a + b, 0) / xs.length).toFixed(2)}（${xs.length}問）`); }
  }
  const text = lines.join("\n");
  console.log(text);
  const name = (opt("name") ?? runs.map((r) => r.plan).join("")) + (includeMachine ? "-all" : "-spec");
  writeFileSync(`${RESULTS_DIR}/parts-${name}.md`, text);
  writeFileSync(`${RESULTS_DIR}/parts-${name}.json`, JSON.stringify({ columns, table: t, scored: scored.map((s) => ({ column: s.column, id: s.id, items: s.items, misses: s.misses, stage: s.stage, finalSim: s.finalSim })) }, null, 1));
  console.log(`\n→ ${RESULTS_DIR}/parts-${name}.md`);
}

(async () => {
  if (flag("build") && flag("llm")) { const { setupLlmTest } = await import("./lib/llm-test-harness"); harness = await setupLlmTest("parts-eval-gold"); }
  if (flag("build")) await build();
  else if (flag("score")) score();
  else console.log("使い方: --build [--ids=..] [--llm] ／ --score [--runs=A=mc1018-sonnet,...]");
})().catch((e) => { console.error(e instanceof Error ? e.message : e); process.exitCode = 1; }).finally(async () => { if (harness) await harness.finish(); setTimeout(() => process.exit(process.exitCode ?? 0), 300); });
