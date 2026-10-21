// scripts/audit-reaction-predict.ts — 「相手の頭の中・反応の予想」（app/lib/customer-reaction-predict.ts）を実データで確かめる（本番 DB は読むだけ・書かない）
//
//   過去の「お客様の束 → こちらの返事 → お客様の次の束」を並べ、こちらの返事を下書きと見なして、次のお客様の反応の種類
//   （質問／お礼・了承／止まる・検討／不満／内覧・申込へ進む／返事なし）を予想し、実際の次の束と比べる。
//   古い 70% で数え表を作り、新しい 30% で当てる（時間で分ける）。基準: いちばん多い種類／今回と同じ種類。
//   --llm: 新しい側の一部を DeepSeek（伏せた文だけ・申込の書類・個人の値の通は外す）にも当てさせて比べる＋次の束の種類付けの確かめ
//   --write-table: 全部の例で数え表を作って app/lib/customer-reaction-table-data.ts に書く（数だけ・文は書かない）
// 実行:
//   npx tsx --env-file=.env.local scripts/audit-reaction-predict.ts [--days=180]
//   LLM_TEST_MODE=deepseek-all npx tsx --env-file=.env.local scripts/audit-reaction-predict.ts --llm --n=240 [--max-usd=1]
import { createClient } from "@supabase/supabase-js";
import * as fs from "fs";
import * as path from "path";
import { isTestConversation } from "../app/lib/test-conversations";
import { applicationMaterialReason, piiValueSignal } from "../app/lib/test-pii-guard";
import { examplePiiReason } from "../app/lib/example-pii-guard";
import { altPiiSignal } from "../app/lib/alt-pii-gate";
import { maskExamText, addressNamesOf } from "./lib/brain-exam-mask";
import type { MoodMsg } from "../app/lib/customer-mood-flow";
import {
  classifyCustomerBurst, draftKindOf, readCustomerMind, predictReaction, reactionRisk, buildReactionNote, isDownMood,
  REACTION_CATS, REACTION_JA, BAD_CATS, type ReactionCat, type DraftKind,
} from "../app/lib/customer-reaction-predict";
import type { ReactionTable } from "../app/lib/customer-reaction-table-data";

const arg = (k: string, d: string) => process.argv.find((a) => a.startsWith(`--${k}=`))?.slice(k.length + 3) ?? d;
const has = (k: string) => process.argv.includes(`--${k}`);
const DAYS = Number(arg("days", "180"));
const sb = createClient(process.env.NEXT_PUBLIC_SUPABASE_URL!, (process.env.SUPABASE_SERVICE_ROLE_KEY ?? process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY)!);
type M = { id: string; conversation_id: string; sender: string; created_at: string; text: string | null; is_aix_generated: boolean | null };
const H = 3600_000, D = 24 * H;

async function all<T>(q: (from: number) => PromiseLike<{ data: T[] | null; error: { message: string } | null }>): Promise<T[]> {
  const out: T[] = [];
  for (let i = 0; i < 900_000; i += 1000) { const { data, error } = await q(i); if (error) throw new Error(error.message); out.push(...(data ?? [])); if ((data ?? []).length < 1000) break; }
  return out;
}
const pct = (a: number, b: number) => (b ? `${((a / b) * 100).toFixed(1)}%` : "-");

type Ex = {
  id: string; cid: string; at: number; now: ReactionCat; draft: DraftKind; actual: ReactionCat;
  custTexts: string[]; staffTexts: string[]; nextTexts: string[]; prior: MoodMsg[]; name: string | null; staffAll: string[]; mood: "down" | "ok"; temp: string;
};

function emptyTable(): ReactionTable { return { builtAt: new Date().toISOString(), days: DAYS, all: {}, byNow: {}, byNowDraft: {}, byMoodDraft: {} }; }
function addTo(t: ReactionTable, e: Ex) {
  const inc = (o: Record<string, number>, k: string) => { o[k] = (o[k] ?? 0) + 1; };
  inc(t.all, e.actual);
  inc(t.byNow[e.now] ??= {}, e.actual);
  inc(t.byNowDraft[`${e.now}|${e.draft}`] ??= {}, e.actual);
  inc(t.byMoodDraft[`${e.mood}|${e.draft}`] ??= {}, e.actual);
}

async function main() {
  const since = new Date(Date.now() - DAYS * D).toISOString();
  const msgs = await all<M>((i) => sb.from("messages").select("id, conversation_id, sender, created_at, text, is_aix_generated").gte("created_at", since).order("created_at").order("id").range(i, i + 999));
  const outs = await all<{ conversation_id: string; applied_at: string | null }>((i) => sb.from("deal_outcomes").select("conversation_id, applied_at").not("applied_at", "is", null).range(i, i + 999));
  const appliedAt = new Map<string, number>(); for (const o of outs) { const t = Date.parse(o.applied_at!); const p = appliedAt.get(o.conversation_id); if (p == null || t < p) appliedAt.set(o.conversation_id, t); }
  const convs = await all<{ id: string; line_source_type: string | null; customer_name: string | null }>((i) => sb.from("conversations").select("id, line_source_type, customer_name").range(i, i + 999));
  const skip = new Set(convs.filter((c) => c.line_source_type === "group").map((c) => c.id));
  const nameOf = new Map(convs.map((c) => [c.id, c.customer_name]));
  const by = new Map<string, M[]>();
  for (const m of msgs) { if (isTestConversation(m.conversation_id) || skip.has(m.conversation_id)) continue; (by.get(m.conversation_id) ?? by.set(m.conversation_id, []).get(m.conversation_id)!).push(m); }

  const exs: Ex[] = [];
  const nowMs = Date.now();
  for (const [cid, list0] of by) {
    const ap = appliedAt.get(cid) ?? Infinity;
    const list = list0.filter((m) => Date.parse(m.created_at) < ap);
    // 交互のかたまり（お客様／こちら）
    const runs: Array<{ who: "c" | "s"; ms: M[] }> = [];
    for (const m of list) { const who = m.sender === "customer" ? "c" : "s"; const r = runs[runs.length - 1]; if (r && r.who === who) r.ms.push(m); else runs.push({ who, ms: [m] }); }
    const staffAll = list.filter((m) => m.sender !== "customer").map((m) => m.text ?? "");
    let consumed = 0;
    for (let i = 0; i < runs.length; i++) {
      const c = runs[i]; consumed += c.ms.length;
      if (c.who !== "c") continue;
      const s = runs[i + 1]; if (!s) continue;
      const cEnd = Date.parse(c.ms[c.ms.length - 1].created_at);
      const s0 = Date.parse(s.ms[0].created_at);
      if (s0 - cEnd > 48 * H) continue;
      const reply = s.ms.filter((m) => Date.parse(m.created_at) - s0 <= 3 * H);
      const sEnd = Date.parse(s.ms[s.ms.length - 1].created_at);
      const n = runs[i + 2];
      let actual: ReactionCat | null = null; let nextTexts: string[] = [];
      if (n && Date.parse(n.ms[0].created_at) - sEnd <= 7 * D) { actual = classifyCustomerBurst(n.ms.map((m) => m.text)); nextTexts = n.ms.map((m) => m.text ?? ""); }
      else if (n || nowMs - sEnd > 7 * D) actual = "silent";
      if (!actual) continue;
      const now = classifyCustomerBurst(c.ms.map((m) => m.text));
      if (now === "other") continue; // 画像・フォームだけ＝予想の対象外
      const prior = list.slice(0, consumed).map((m) => ({ sender: m.sender, text: m.text, createdAt: m.created_at, isAix: m.is_aix_generated }));
      const mind = readCustomerMind(prior);
      exs.push({ id: c.ms[0].id, cid, at: Date.parse(c.ms[0].created_at), now, draft: draftKindOf(reply.map((m) => m.text ?? "").join("\n")), actual,
        custTexts: c.ms.map((m) => m.text ?? ""), staffTexts: reply.map((m) => m.text ?? ""), nextTexts, prior, name: nameOf.get(cid) ?? null, staffAll,
        mood: mind && isDownMood(mind) ? "down" : "ok", temp: mind?.temperature ?? "中" });
    }
  }
  exs.sort((a, b) => a.at - b.at);
  const cut = exs[Math.floor(exs.length * 0.7)]?.at ?? 0;
  const train = exs.filter((e) => e.at < cut), test = exs.filter((e) => e.at >= cut);
  console.log(`例: ${exs.length}（会話 ${new Set(exs.map((e) => e.cid)).size}・${DAYS}日・申込より前）・学び ${train.length}／当て ${test.length}（${new Date(cut + 9 * H).toISOString().slice(0, 10)} 以降）`);
  const dist = (xs: Ex[]) => REACTION_CATS.map((k) => `${REACTION_JA[k]} ${pct(xs.filter((e) => e.actual === k).length, xs.length)}`).join("・");
  console.log(`次の反応の分布（当て）: ${dist(test)}`);

  const table = emptyTable(); for (const e of train) addTo(table, e);
  const majority = (Object.entries(table.all).sort((a, b) => b[1] - a[1])[0]?.[0] ?? "thanks") as ReactionCat;
  const acc = (f: (e: Ex) => ReactionCat, xs: Ex[] = test) => xs.filter((e) => f(e) === e.actual).length;
  const methods: Array<[string, (e: Ex) => ReactionCat]> = [
    [`基準A いつも一番多い種類（${REACTION_JA[majority]}）`, () => majority],
    ["基準B 今回と同じ種類", (e) => e.now],
    ["予想 今回の種類だけ（下書き前）", (e) => predictReaction(e.now, null, table).likely],
    ["予想 今回の種類×下書きの形", (e) => predictReaction(e.now, e.draft, table).likely],
  ];
  // 試し: 温度（お客様の頭の中）も鍵に足すと当たりが上がるか
  const tempOf = new Map<string, string>(); for (const e of exs) tempOf.set(e.id, e.temp);
  const t3: Record<string, Record<string, number>> = {};
  for (const e of train) { const c = (t3[`${e.now}|${e.draft}|${tempOf.get(e.id)}`] ??= {}); c[e.actual] = (c[e.actual] ?? 0) + 1; }
  methods.push(["試し 今回×下書き×温度", (e) => {
    const c = t3[`${e.now}|${e.draft}|${tempOf.get(e.id)}`]; const n = c ? Object.values(c).reduce((a, b) => a + b, 0) : 0;
    return n >= 20 ? (Object.entries(c!).sort((a, b) => b[1] - a[1])[0][0] as ReactionCat) : predictReaction(e.now, e.draft, table).likely;
  }]);
  for (const t of ["高", "中", "低"]) { const g = test.filter((e) => tempOf.get(e.id) === t); console.log(`温度 ${t}: ${g.length}番・悪い反応 ${pct(g.filter((e) => BAD_CATS.has(e.actual)).length, g.length)}・進む ${pct(g.filter((e) => e.actual === "proceed").length, g.length)}`); }
  console.log("\n① 次の反応の種類の当たり（当て側）");
  for (const [k, f] of methods) console.log(`  ${k.padEnd(28)} ${pct(acc(f), test.length)}（${acc(f)}/${test.length}）`);
  const noSilent = test.filter((e) => e.actual !== "silent");
  console.log(`  （返事が来た番だけ ${noSilent.length}）` + methods.map(([k, f]) => ` ${k.slice(0, 6)} ${pct(acc(f, noSilent), noSilent.length)}`).join("／"));
  // 悪い反応（止まる・不満・返事なし）を当てられるか＝2択
  const isBad = (c: ReactionCat) => BAD_CATS.has(c);
  console.log("\n② 悪い反応の恐れ（risk）× 実際に悪い反応（止まる・不満・返事なし）だった割合");
  const rows = test.map((e) => { const mind = readCustomerMind(e.prior); return { e, sig: mind ? reactionRisk(mind, e.staffTexts.join("\n"), table) : null }; }).filter((r) => r.sig);
  const baseBad = rows.filter((r) => isBad(r.e.actual)).length;
  console.log(`  全体 ${pct(baseBad, rows.length)}（${rows.length}）`);
  for (const [lo, hi] of [[0, 0.25], [0.25, 0.4], [0.4, 0.55], [0.55, 1.01]] as const) {
    const g = rows.filter((r) => r.sig!.risk >= lo && r.sig!.risk < hi);
    console.log(`  risk ${lo.toFixed(2)}〜${hi > 1 ? "1.00" : hi.toFixed(2)}: ${g.length}番・悪い反応 ${pct(g.filter((r) => isBad(r.e.actual)).length, g.length)}`);
  }
  for (const k of ["unanswered", "pushy", "stall", "complaint"] as const) {
    const g = rows.filter((r) => r.sig!.kinds.includes(k));
    const q = g.filter((r) => r.e.actual === "question").length;
    console.log(`  印 ${k.padEnd(10)} ${g.length}番・悪い反応 ${pct(g.filter((r) => isBad(r.e.actual)).length, g.length)}・次も質問 ${pct(q, g.length)}`);
  }
  const qBase = rows.filter((r) => r.e.now === "question" && r.e.draft !== "promise");
  console.log(`  （比べ: 今回が質問・約束でない返事の番 ${qBase.length}・次も質問 ${pct(qBase.filter((r) => r.e.actual === "question").length, qBase.length)}）`);
  const pushAll = rows.filter((r) => r.e.draft === "push");
  console.log(`  （比べ: 勧めた番全体 ${pushAll.length}・悪い反応 ${pct(pushAll.filter((r) => isBad(r.e.actual)).length, pushAll.length)}）`);

  console.log("\n③ 今回の種類×下書きの形 → 次の反応（学び側・20番以上）");
  for (const [k, c] of Object.entries(table.byNowDraft).sort()) {
    const n = Object.values(c).reduce((a, b) => a + b, 0); if (n < 20) continue;
    const bad = [...BAD_CATS].reduce((a, x) => a + (c[x] ?? 0), 0);
    console.log(`  ${k.padEnd(18)} n=${String(n).padStart(4)} 悪い ${pct(bad, n).padStart(6)}｜${REACTION_CATS.filter((x) => c[x]).map((x) => `${REACTION_JA[x]} ${pct(c[x], n)}`).join("・")}`);
  }

  // 注記の見本（伏せて表示）
  console.log("\n④ ブレインへの注記の見本（伏せた）");
  let shown = 0;
  for (const e of [...test].reverse()) {
    if (shown >= 3) break;
    const mind = readCustomerMind(e.prior); const note = buildReactionNote(mind, table);
    if (!note || !note.includes("似た番")) continue;
    if (e.custTexts.some((t) => piiValueSignal(t) || applicationMaterialReason(t))) continue;
    const names = addressNamesOf(e.staffAll);
    console.log(`  お客様: ${maskExamText(e.custTexts.join(" "), e.name, names).replace(/\s+/g, " ").slice(0, 60)}`);
    console.log(maskExamText(note, e.name, names).split("\n").filter(Boolean).map((l) => `    ${l}`).join("\n"));
    shown++;
  }

  if (has("write-table")) {
    const full = emptyTable(); for (const e of exs) addTo(full, e);
    const file = path.join(__dirname, "..", "app", "lib", "customer-reaction-table-data.ts");
    const head = fs.readFileSync(file, "utf8").split("\n").filter((l) => l.startsWith("//") || l.startsWith("export type")).join("\n");
    fs.writeFileSync(file, `${head}\nexport const REACTION_TABLE: ReactionTable = ${JSON.stringify(full)};\n`);
    console.log(`\n数え表を書いた: ${exs.length} 例`);
  }

  if (has("llm")) await llmCompare(test, table);
}

// ── DeepSeek（伏せた文だけ）──────────────────────────────
const cost = { usd: 0, calls: 0, fail: 0 };
async function deepseekJson(user: string, sys: string): Promise<Record<string, unknown> | null> {
  const key = process.env.DEEPSEEK_API_KEY ?? process.env.LLM_ALT_DEEPSEEK_KEY;
  if (!key) throw new Error("DEEPSEEK_API_KEY が無い");
  const { DEEPSEEK_ENDPOINT, DEEPSEEK_DEFAULT_MODEL } = await import("../app/lib/llm-alt-provider");
  const { altPriceOf, isDeepseekPeakAt } = await import("../app/lib/llm-price");
  const model = process.env.DEEPSEEK_MODEL ?? DEEPSEEK_DEFAULT_MODEL;
  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      const res = await fetch(DEEPSEEK_ENDPOINT, {
        method: "POST", headers: { "Content-Type": "application/json", Authorization: `Bearer ${key}` },
        body: JSON.stringify({ model, messages: [{ role: "system", content: sys }, { role: "user", content: user }], temperature: 0, max_tokens: 1500, response_format: { type: "json_object" }, thinking: { type: "disabled" } }),
        signal: AbortSignal.timeout(120_000),
      });
      const j = await res.json() as { choices?: Array<{ message?: { content?: string } }>; usage?: { prompt_cache_hit_tokens?: number; prompt_cache_miss_tokens?: number; completion_tokens?: number } };
      if (!res.ok) throw new Error(`DeepSeek ${res.status}: ${JSON.stringify(j).slice(0, 200)}`);
      const pr = altPriceOf(model);
      if (pr && j.usage) cost.usd += (((j.usage.prompt_cache_miss_tokens ?? 0) * pr.in + (j.usage.prompt_cache_hit_tokens ?? 0) * pr.read + (j.usage.completion_tokens ?? 0) * pr.out) / 1e6) * (pr.peakDouble && isDeepseekPeakAt(new Date()) ? 2 : 1);
      cost.calls++;
      return JSON.parse(String(j.choices?.[0]?.message?.content ?? "{}")) as Record<string, unknown>;
    } catch (e) { if (attempt === 1) { cost.fail++; console.warn(`  失敗: ${e instanceof Error ? e.message : e}`); } }
  }
  return null;
}
const CAT_DEF = "question=質問・確認を聞く／thanks=お礼・了承・受け止めだけ／stall=検討する・保留・見送り・考える／complaint=不満・苦情・急かし／proceed=内覧・申込・日程を進める（行ける日時を出す等）／silent=7日以内に返事が来ない／other=画像だけ等それ以外";
const PRED_SYS = [
  "あなたは大阪の賃貸仲介の LINE 接客を読む係です。お客様の連投と、それへのこちら（不動産会社）の返事を読み、お客様が次に何と返すかの種類を1つ予想します。",
  `種類: ${CAT_DEF}`,
  '出力は JSON だけ: {"items":[{"i":1,"next":"question"}]}',
].join("\n");
const LABEL_SYS = [
  "あなたは大阪の賃貸仲介の LINE 接客を読む係です。お客様の連投の種類を1つ付けます。複数当たる時の優先: complaint > proceed > question > stall > thanks > other。",
  `種類: ${CAT_DEF.replace(/／silent=[^／]+/, "")}`,
  '出力は JSON だけ: {"items":[{"i":1,"cat":"thanks"}]}',
].join("\n");

/** DeepSeek に渡す文: 名前・電話・メール・個人の値は伏せる・物件名の行（🌟）と号室も伏せる・URL は外す */
function maskForDeepseek(texts: ReadonlyArray<string>, name: string | null, names: string[]): string {
  // 種類の予想に要らない物は落とす（質に効かない個人情報に近い物も渡さない）: 画像の書き起こし・物件名（カタカナ・英字の名前）・住所・駅・号室
  return texts.map((t) => maskExamText(t, name, names)
    .replace(/https?:\/\/\S+/g, "［URL］")
    .replace(/\[(画像|動画|ファイル)\][^\n]*/g, "[$1]")
    .replace(/^.*🌟.*$/gm, "🌟［物件］")
    .replace(/[0-9０-９]{2,4}\s*号室/g, "［号室］")
    .replace(/(?:大阪府|兵庫県|京都府|奈良県|滋賀県|和歌山県)?[一-龥]{1,4}[市区][一-龥ぁ-ん]{0,6}(?:町|丁目)?[0-9０-９\-－ー丁目番地号]*/g, "［住所］")
    .replace(/[一-龥ァ-ヴー]{1,8}駅/g, "［駅］")
    .replace(/[A-Za-zＡ-Ｚａ-ｚ][A-Za-zＡ-Ｚａ-ｚ0-9０-９'’ .・-]{2,}/g, "［名］")
    .replace(/[ァ-ヴ][ァ-ヴー・]{3,}[一-龥]{0,4}/g, "［名］"))
    .join("\n").replace(/\n{2,}/g, "\n").slice(-500);
}
function hasPii(texts: ReadonlyArray<string>): boolean {
  return texts.some((t) => !!(piiValueSignal(t) || applicationMaterialReason(t) || altPiiSignal(t) || examplePiiReason(t)));
}

async function llmCompare(test: Ex[], table: ReactionTable) {
  if (process.env.LLM_TEST_MODE !== "deepseek-all") throw new Error("LLM_TEST_MODE=deepseek-all を付けて流す");
  // テストの LLM の共通の入口（使用量の記録・Claude を通さない）。DeepSeek だけを伏せた文で呼ぶ
  const { setupLlmTest } = await import("./lib/llm-test-harness");
  const h = await setupLlmTest("audit-reaction-predict");
  try { await llmCompareInner(test, table); } finally { await h.finish(); }
}
async function llmCompareInner(test: Ex[], table: ReactionTable) {
  const N = Number(arg("n", "240")); const maxUsd = Number(arg("max-usd", "1"));
  // 種類ごとに偏らないよう、新しい側から均等に間引き（伏せても個人の値が残りそうな番は外す）
  const ok = test.filter((e) => !hasPii([...e.custTexts, ...e.staffTexts, ...e.nextTexts]));
  const step = Math.max(1, Math.floor(ok.length / N));
  const sample = ok.filter((_, i) => i % step === 0).slice(0, N);
  console.log(`\n⑤ DeepSeek（伏せた文だけ）と比べる: ${sample.length} 番（個人の値の通を外した ${ok.length}/${test.length} から）`);
  const pred = new Map<string, ReactionCat>(); const lab = new Map<string, ReactionCat>();
  const B = 10;
  const items = sample.map((e) => { const names = addressNamesOf(e.staffAll); return { e, c: maskForDeepseek(e.custTexts, e.name, names), s: maskForDeepseek(e.staffTexts, e.name, names), n: e.nextTexts.length ? maskForDeepseek(e.nextTexts, e.name, names) : "" }; });
  if (has("show-masked")) for (const x of items.slice(0, 2)) console.log(`  [伏せた例] お客様: ${x.c.replace(/\n/g, " ").slice(0, 80)}｜こちら: ${x.s.replace(/\n/g, " ").slice(0, 80)}`);
  const chunks: typeof items[] = []; for (let i = 0; i < items.length; i += B) chunks.push(items.slice(i, i + B));
  for (let c = 0; c < chunks.length; c += 6) {
    if (cost.usd > maxUsd) { console.log(`  費用の上限 $${maxUsd} で止める`); break; }
    await Promise.all(chunks.slice(c, c + 6).map(async (ch) => {
      const o = await deepseekJson(ch.map((x, i) => `### ${i + 1}\n【お客様の連投】\n${x.c}\n【こちらの返事】\n${x.s}`).join("\n\n"), PRED_SYS);
      for (const it of (Array.isArray(o?.items) ? o!.items as Array<Record<string, unknown>> : [])) { const x = ch[Number(it.i) - 1]; const v = String(it.next ?? ""); if (x && (REACTION_CATS as readonly string[]).includes(v)) pred.set(x.e.id, v as ReactionCat); }
      const withNext = ch.filter((x) => x.n);
      if (withNext.length) {
        const o2 = await deepseekJson(withNext.map((x, i) => `### ${i + 1}\n${x.n}`).join("\n\n"), LABEL_SYS);
        for (const it of (Array.isArray(o2?.items) ? o2!.items as Array<Record<string, unknown>> : [])) { const x = withNext[Number(it.i) - 1]; const v = String(it.cat ?? ""); if (x && (REACTION_CATS as readonly string[]).includes(v)) lab.set(x.e.id, v as ReactionCat); }
      }
    }));
  }
  const got = sample.filter((e) => pred.has(e.id));
  const majority = (Object.entries(table.all).sort((a, b) => b[1] - a[1])[0]?.[0] ?? "thanks") as ReactionCat;
  const a = (f: (e: Ex) => ReactionCat) => pct(got.filter((e) => f(e) === e.actual).length, got.length);
  console.log(`  同じ ${got.length} 番で: 基準A ${a(() => majority)}・基準B ${a((e) => e.now)}・予想(表) ${a((e) => predictReaction(e.now, e.draft, table).likely)}・DeepSeek ${a((e) => pred.get(e.id)!)}`);
  const labeled = sample.filter((e) => lab.has(e.id));
  console.log(`  次の束の種類付けの一致（決まった計算 vs DeepSeek）: ${pct(labeled.filter((e) => lab.get(e.id) === e.actual).length, labeled.length)}（${labeled.length}）`);
  const conf = new Map<string, number>(); for (const e of labeled) if (lab.get(e.id) !== e.actual) { const k = `${e.actual}→${lab.get(e.id)}`; conf.set(k, (conf.get(k) ?? 0) + 1); }
  console.log(`  食い違いの多い組: ${[...conf].sort((x, y) => y[1] - x[1]).slice(0, 6).map(([k, v]) => `${k} ${v}`).join("・")}`);
  // DeepSeek の種類付けを正解とした時の当たり（決まった計算の種類付けの癖を外して見る）
  const a2 = (f: (e: Ex) => ReactionCat) => pct(labeled.filter((e) => pred.has(e.id) && f(e) === lab.get(e.id)).length, labeled.filter((e) => pred.has(e.id)).length);
  console.log(`  （DeepSeek の種類付けを正解に・返事が来た番）基準A ${a2(() => majority)}・基準B ${a2((e) => e.now)}・予想(表) ${a2((e) => predictReaction(e.now, e.draft, table).likely)}・DeepSeek ${a2((e) => pred.get(e.id)!)}`);
  console.log(`  DeepSeek ${cost.calls} 回・$${cost.usd.toFixed(4)}・失敗 ${cost.fail}`);
}

main().catch((e) => { console.error(e); process.exit(1); });
