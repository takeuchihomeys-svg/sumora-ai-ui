// scripts/aix-desk-eval.ts — 担当の札（ボタン×ピッカーごとの担当）の形を、30日の AIX の外れと当たりに DeepSeek で当てる試し（本番の書き込みなし・LINE に送らない）
//
// 2026-10-29 竹内さん（KB P1 03d2bdd2・ad20192b）・作業員1: AIX の統括が候補を2〜3個に絞る → 候補の担当だけが「自分の番か・どのピッカーか・何が足りないか」を答える →
//   統括が比べて1つ選ぶ（この試しでは担当の点の一番高い物＝決まった計算・LLM を1回減らす）。正解はスタッフの押下（竹内さんの番と従業員の番を分けて数える＝竹内基準）。
//   入力: scripts/audit-aix-miss-causes.ts --json=<path> --hits=60 の出力（外れ134・当たり60）
//   伏せる: 申込の書類の手前で切る・名前（呼び名）・URL・号室・電話等。個人の値が残る番は外す（memory/test_protocol_brain.md 6）
// 実行: LLM_TEST_MODE=deepseek-all npx tsx --env-file=.env.local scripts/aix-desk-eval.ts --in=<json> [--n=999] [--max-usd=3] [--out=<json>]
import { readFileSync, writeFileSync } from "node:fs";
import { createClient } from "@supabase/supabase-js";
import { AIX_CATALOG, catalogKeyOfPress, buttonOfKey, topicKey } from "../app/lib/aix-catalog";
import { join } from "node:path";
import { examCacheRoot } from "./lib/llm-cassette";
import type { AixDeskCard } from "../app/lib/aix-desk-types";
// 札は手元だけ（scripts/build-aix-desk-cards.ts の出力・git に入れない）
const AIX_DESK_CARDS: Record<string, AixDeskCard> = (JSON.parse(readFileSync(join(examCacheRoot(), "aix-desk", "cards.json"), "utf8")) as { cards: Record<string, AixDeskCard> }).cards;
import { cutBeforeApplicationMaterial, piiValueSignal, applicationMaterialReason } from "../app/lib/test-pii-guard";
import { maskExamText, addressNamesOf } from "./lib/brain-exam-mask";

const sb = createClient(process.env.NEXT_PUBLIC_SUPABASE_URL ?? "", process.env.SUPABASE_SERVICE_ROLE_KEY ?? process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY ?? "");
const arg = (k: string, d = "") => process.argv.find((a) => a.startsWith(`--${k}=`))?.slice(k.length + 3) ?? d;
// --with-brain: LINE の統括（今のブレイン）の AIX を候補に必ず入れ、点が同じ時はブレインの方を選ぶ（壊さない形）
const WITH_BRAIN = process.argv.includes("--with-brain");
const IN = arg("in"); const OUT = arg("out"); const N = Number(arg("n", "999")); const MAX_USD = Number(arg("max-usd", "3"));

type InRow = { id: number; conversation_id: string; customer_turn_at: string; customer_last_at: string | null; scene_key: string | null; cause: string; staff_aix: string | null; staff_check_pattern: string | null; staff_writer: string; brain_action: string | null; brain_reply_mode: string | null };
type Msg = { sender: string; text: string | null; created_at: string };

const cost = { usd: 0, calls: 0, fail: 0, hit: 0, miss: 0 };
async function deepseekJson(sys: string, user: string): Promise<Record<string, unknown> | null> {
  const key = process.env.DEEPSEEK_API_KEY ?? process.env.LLM_ALT_DEEPSEEK_KEY;
  if (!key) throw new Error("DEEPSEEK_API_KEY が無い");
  const { DEEPSEEK_ENDPOINT, DEEPSEEK_DEFAULT_MODEL } = await import("../app/lib/llm-alt-provider");
  const { altPriceOf, isDeepseekPeakAt } = await import("../app/lib/llm-price");
  if (piiValueSignal(user)) { cost.fail++; return null; }
  const model = process.env.DEEPSEEK_MODEL ?? DEEPSEEK_DEFAULT_MODEL;
  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      const res = await fetch(DEEPSEEK_ENDPOINT, {
        method: "POST", headers: { "Content-Type": "application/json", Authorization: `Bearer ${key}` },
        body: JSON.stringify({ model, messages: [{ role: "system", content: sys }, { role: "user", content: user }], temperature: 0, max_tokens: 600, response_format: { type: "json_object" }, thinking: { type: "disabled" } }),
        signal: AbortSignal.timeout(120_000),
      });
      const j = await res.json() as { choices?: Array<{ message?: { content?: string } }>; usage?: { prompt_cache_hit_tokens?: number; prompt_cache_miss_tokens?: number; completion_tokens?: number } };
      if (!res.ok) throw new Error(`DeepSeek ${res.status}: ${JSON.stringify(j).slice(0, 200)}`);
      const pr = altPriceOf(model);
      if (pr && j.usage) cost.usd += (((j.usage.prompt_cache_miss_tokens ?? 0) * pr.in + (j.usage.prompt_cache_hit_tokens ?? 0) * pr.read + (j.usage.completion_tokens ?? 0) * pr.out) / 1e6) * (pr.peakDouble && isDeepseekPeakAt(new Date()) ? 2 : 1);
      cost.calls++; cost.hit += j.usage?.prompt_cache_hit_tokens ?? 0; cost.miss += j.usage?.prompt_cache_miss_tokens ?? 0;
      return JSON.parse(String(j.choices?.[0]?.message?.content ?? "{}")) as Record<string, unknown>;
    } catch (e) { if (attempt === 1) { cost.fail++; console.warn(`  失敗: ${e instanceof Error ? e.message : e}`); } }
  }
  return null;
}

function maskForLlm(text: string, names: string[]): string {
  return maskExamText(text, null, names)
    .replace(/https?:\/\/\S+/g, "［URL］")
    .replace(/[0-9０-９]{2,4}\s*号室/g, "［号室］")
    .replace(/\[(画像|動画|ファイル)\][^\n]{60,}/g, (m) => m.slice(0, 80));
}

const SELECTABLE = AIX_CATALOG.filter((e) => e.brainSelectable);
const LIST_TEXT = SELECTABLE.map((e) => `- ${e.key}｜${e.button}${e.picker ? `→${e.picker.label}` : ""}｜${(e.staffOnly || "定型").slice(0, 50)}`).join("\n");
const COMMANDER_SYS = [
  "あなたは大阪の賃貸仲介（スモラ）の LINE 接客で、AIX（スタッフが確かめた事・資料を送る道具）のボタン×ピッカーを選ぶ「AIX の統括」です。",
  "今のお客様の発言と前の流れを読み、スタッフがこの後に押す AIX の候補を一覧から3つまで、ありそうな順に選びます。",
  "スタッフだけが知る事（管理会社に確認した結果・見積の金額・内覧の空き・撮った写真など）が要る番は AIX。会話・資料・会社の事実だけで答えられる番は AIX ではない（not_aix）。",
  "鍵は一覧の鍵をそのまま書く。",
  "【一覧（鍵｜ボタン→ピッカー｜送るスタッフだけが知る事）】",
  LIST_TEXT,
  '出力は JSON だけ: {"aix_turn":true,"candidates":["鍵1","鍵2","鍵3"],"why":"短く"}',
].join("\n");
const deskSys = (key: string) => [
  "あなたは大阪の賃貸仲介（スモラ）の AIX の担当です。下の札があなたの担当のボタン×ピッカーの中身です（竹内さん＝社長の送り方が基準）。",
  "今の番の後に、スタッフがあなたの担当のボタン×ピッカーを押して送る流れかを答えます。確認の結果（募集中か終了か・管理会社の答え）はスタッフが確かめてから選ぶので、結果がまだ会話に無い事は理由にしない（約束の返信にするか、その場で AIX にするかは別の所で決める）。",
  AIX_DESK_CARDS[key]?.text ?? `■担当 ${key}`,
  '出力は JSON だけ: {"mine":true,"score":0.0〜1.0,"picker":"別のピッカーを勧める時だけ鍵","missing":["足りない材料"],"why":"短く"}',
].join("\n");

(async () => {
  if (process.env.LLM_TEST_MODE !== "deepseek-all") throw new Error("LLM_TEST_MODE=deepseek-all を付けて流す");
  const { setupLlmTest } = await import("./lib/llm-test-harness");
  const h = await setupLlmTest("aix-desk-eval");
  try {
    const input = JSON.parse(readFileSync(IN, "utf8")) as { misses: InRow[]; hits: InRow[] };
    const rows = [...input.misses, ...input.hits].slice(0, N);
    type Res = { row: InRow; gold: string; goldBtn: string; brainBtn: string; aixTurn: boolean | null; cands: string[]; pick: string | null; desks: Array<{ key: string; mine: boolean; score: number; why: string; missing: string[] }>; skipped?: string };
    const results: Res[] = [];
    const work = async (r: InRow): Promise<Res> => {
      const gold = catalogKeyOfPress({ aix_type: r.staff_aix, check_pattern: r.staff_check_pattern }).key;
      const base: Res = { row: r, gold, goldBtn: buttonOfKey(gold), brainBtn: r.brain_reply_mode === "aix" ? String(r.brain_action ?? "") : "返信", aixTurn: null, cands: [], pick: null, desks: [] };
      const { data } = await sb.from("messages").select("sender, text, created_at").eq("conversation_id", r.conversation_id).lte("created_at", r.customer_last_at ?? r.customer_turn_at).order("created_at", { ascending: false }).limit(12);
      const msgs = ((data ?? []) as Msg[]).reverse();
      const cut = cutBeforeApplicationMaterial(msgs);
      if (cut.cutAt != null && cut.kept.length < msgs.length) return { ...base, skipped: "申込の書類より後" };
      const names = addressNamesOf(msgs.filter((m) => m.sender !== "customer").map((m) => m.text ?? ""));
      const turnAt = Date.parse(r.customer_turn_at);
      const lines = msgs.map((m) => `${Date.parse(m.created_at) >= turnAt && m.sender === "customer" ? "★" : ""}${m.sender === "customer" ? "お客様" : "こちら"}: ${maskForLlm(m.text ?? "", names).replace(/\s+/g, " ").slice(0, 220)}`);
      if (lines.some((l) => applicationMaterialReason(l) || piiValueSignal(l))) return { ...base, skipped: "個人の値" };
      const user = `【会話（★が今の番のお客様の発言）】\n${lines.join("\n")}`;
      const c = await deepseekJson(COMMANDER_SYS, user);
      let cands = (Array.isArray(c?.candidates) ? (c!.candidates as unknown[]).map(String) : []).filter((k) => !!AIX_DESK_CARDS[k]).slice(0, 3);
      let brainKey: string | null = null;
      if (WITH_BRAIN && r.brain_reply_mode === "aix" && r.brain_action) {
        brainKey = cands.find((k) => buttonOfKey(k) === r.brain_action) ?? (AIX_DESK_CARDS[r.brain_action] ? r.brain_action : Object.keys(AIX_DESK_CARDS).find((k) => buttonOfKey(k) === r.brain_action) ?? null);
        if (brainKey && !cands.includes(brainKey)) cands = [...cands, brainKey];
      }
      base.aixTurn = c?.aix_turn === false ? false : true; base.cands = cands;
      const desks = await Promise.all(cands.map(async (k) => {
        const d = await deepseekJson(deskSys(k), user);
        return { key: k, mine: d?.mine === true, score: Number(d?.score ?? 0) || 0, why: String(d?.why ?? "").slice(0, 80), missing: Array.isArray(d?.missing) ? (d!.missing as unknown[]).map(String).slice(0, 3) : [] };
      }));
      base.desks = desks;
      const mine = desks.filter((d) => d.mine).sort((a, b) => b.score - a.score || (a.key === brainKey ? -1 : b.key === brainKey ? 1 : 0));
      base.pick = mine[0]?.key ?? null;
      return base;
    };
    for (let i = 0; i < rows.length; i += 6) {
      if (cost.usd > MAX_USD) { console.log(`費用の上限 $${MAX_USD} で止める（${i}番まで）`); break; }
      results.push(...await Promise.all(rows.slice(i, i + 6).map(work)));
      if (i % 30 === 0) console.log(`  ${Math.min(i + 6, rows.length)}/${rows.length} $${cost.usd.toFixed(3)}`);
    }
    const done = results.filter((x) => !x.skipped);
    const pct = (a: number, n: number) => (n ? `${Math.round((a / n) * 100)}%` : "—");
    const summarize = (xs: Res[], label: string) => {
      const btnOk = xs.filter((x) => x.pick && buttonOfKey(x.pick) === x.goldBtn).length;
      const keyOk = xs.filter((x) => x.pick && topicKey(x.pick) === topicKey(x.gold)).length;
      const candHas = xs.filter((x) => x.cands.some((k) => buttonOfKey(k) === x.goldBtn)).length;
      const noPick = xs.filter((x) => !x.pick).length;
      console.log(`| ${label} | ${xs.length} | ${btnOk}（${pct(btnOk, xs.length)}） | ${keyOk}（${pct(keyOk, xs.length)}） | ${candHas}（${pct(candHas, xs.length)}） | ${noPick} |`);
    };
    console.log(`\n# 担当の札の試し（DeepSeek・本番の書き込みなし）: ${done.length}番（外した ${results.length - done.length}: 申込の書類より後・個人の値）`);
    console.log("今の選び方の正解の数: 外れの番は 0（定義どおり）・当たりの番は全部（同じボタン）。\n");
    console.log("| 組 | 番 | ボタンが合った | ボタン×ピッカーが合った（結果のピッカーは寄せる） | 候補3つにボタンが入った | 担当が誰も手を挙げない |");
    console.log("|---|---|---|---|---|---|");
    const miss = done.filter((x) => x.row.cause !== "hit"), hit = done.filter((x) => x.row.cause === "hit");
    summarize(miss, "外れの番（全部）");
    for (const c of ["①返信と AIX の取り違え", "②AIX の種類違い", "③約束かその場か", "④スタッフだけが知る事", "⑤材料が届いていない"]) summarize(miss.filter((x) => x.row.cause === c), `　${c}`);
    summarize(miss.filter((x) => x.row.staff_writer === "takeuchi"), "　うち竹内さんの番");
    summarize(hit, "当たりの番（壊さないか）");
    summarize(hit.filter((x) => x.row.staff_writer === "takeuchi"), "　うち竹内さんの番");
    console.log(`\n費用: DeepSeek ${cost.calls}回 $${cost.usd.toFixed(3)}（入力のキャッシュ ${pct(cost.hit, cost.hit + cost.miss)}・失敗 ${cost.fail}）／Claude 0回`);
    if (OUT) writeFileSync(OUT, JSON.stringify(results.map((x) => ({ id: x.row.id, cause: x.row.cause, writer: x.row.staff_writer, gold: x.gold, brain: x.brainBtn, cands: x.cands, pick: x.pick, desks: x.desks, skipped: x.skipped })), null, 1));
  } finally { await h.finish(); }
  setTimeout(() => process.exit(process.exitCode ?? 0), 500);
})();
