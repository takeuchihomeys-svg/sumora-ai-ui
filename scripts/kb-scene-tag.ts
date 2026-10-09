// scripts/kb-scene-tag.ts — 設計知見に返信の場面の札「場面:〇〇」を付ける（3巡目・10/07 竹内「的確なRAG検索できるように」）
//   候補は題の語の型（design-knowledge-rag.ts KB_SCENES.titleRe＝本文には当てない）。既に付いている札は触らない・足すだけ。
//   既定は数えるだけ（dry）。--apply で書き込み、前の札を --backup=<file> に控える（戻す: --restore=<file>）。書いた行は埋め込みを作り直す。
// 実行: npx tsx --env-file=.env.local scripts/kb-scene-tag.ts [--apply --backup=<file>] [--show=<場面>] [--restore=<file>]
//
// 2026-10-08 竹内「ちゃんと RAG で正確に確かめられるようにする」: 今の決まり（P0/P1）に場面の札を付け切る（--llm）。
//   題の型だけでは P1 の 3割にしか札が無く、題の語で別の場面に振られた行もあった（題に「見積」があるだけの採点の行が 場面:初期費用 等）。
//   --llm --out=<plan.json> [--max-p=1] [--only-untagged] … P0/P1 の行を DeepSeek（推論なし・温度0・12行ずつ・電話・メールは伏せる）に
//       「担当が返信・AIX の作業中にどの場面で確かめる決まりか」を聞いて計画を作る（DB に書かない）:
//       足す＝DeepSeek の場面のうち無い札／場面に結びつかない行＝「場面:その他」（場面を確かめた印。kb.ts は場面の札のある行に題の型を当てない）／
//       外す候補＝付いている場面の札で DeepSeek が選ばず、題の型で付いた（題の語が場面の型に当たる）物＝人が確かめてから --remove で外す
//   --apply-plan=<plan.json> --backup=<file> [--remove=<id8:場面,…>] [--skip=<id8:場面,…>（足さない札）] … 計画を当てる（書く直前に札を読み直して足すだけ・控えを取る・書いた行は埋め込みを作り直す）
//   戻す: --restore=<backup>（札を控えの形に戻して埋め込みも作り直す）
import { createClient } from "@supabase/supabase-js";
import { readFileSync, writeFileSync } from "node:fs";
import { KB_SCENES, rowInScene, type KbScene } from "../app/lib/design-knowledge-rag";
import { embedKbRows, loadRagRows } from "../app/lib/design-knowledge-rag-server";
import { effectivePriority } from "../app/lib/design-knowledge-priority";
import { maskForLlm } from "../app/lib/design-knowledge-curation";
import { callDeepSeek } from "../app/lib/vision-alt-provider";
import { altPriceOf } from "../app/lib/llm-price";
import { flushLlmUsage, recordAltUsage, setScriptRouteLabel } from "../app/lib/llm-usage-recorder";

const sb = createClient(process.env.NEXT_PUBLIC_SUPABASE_URL ?? "", process.env.SUPABASE_SERVICE_ROLE_KEY ?? process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY ?? "");
const arg = (k: string) => process.argv.find((a) => a.startsWith(`--${k}=`))?.slice(k.length + 3) ?? "";
const APPLY = process.argv.includes("--apply");

/** 行に足す場面の札（題の型で当たる場面のうち、まだ付いていない物） */
export function sceneTagsToAdd(r: { title: string; tags: string[] | null }): string[] {
  const out: string[] = [];
  for (const s of Object.keys(KB_SCENES) as KbScene[]) {
    if (s === "other") continue;
    const tag = KB_SCENES[s].tag;
    if ((r.tags ?? []).includes(tag)) continue;
    if (rowInScene({ title: r.title, tags: [] }, s)) out.push(tag);
  }
  return out;
}

// ── DeepSeek で場面を聞く（P0/P1） ──
export const SCENE_KEYS: KbScene[] = ["ack", "considering", "question", "conditions", "property_share", "cost", "viewing", "apply"];
export const SCENE_TAG_SYSTEM = [
  "あなたは不動産仲介の LINE 返信 AI の開発メモ（設計の決まり）の整理係です。担当者は、お客様の今の発言の『場面』を決めてから、その場面の決まりを引いて返信・AIX（スタッフが確認した事を送るボタン）を作ります。",
  "各メモについて『担当がどの場面の返信・AIX を作る時に、このメモを確かめるべきか』を、次の場面の記号から選んでください（複数可・最大3・本当に関係する物だけ）:",
  "ack＝お客様の短いお礼・了承・締めの挨拶だけ／considering＝検討中・保留・また連絡します／question＝お客様の質問（相場・設備・契約条件・手続き・保証会社 等）／conditions＝お客様が条件を出す・言い直す・あと一つの不満／property_share＝お客様が物件の URL・画像を送ってきた（持ち込み）／cost＝初期費用・見積書・値下げ・分割／viewing＝内覧の希望・日程・待ち合わせ・内覧当日／apply＝申込・審査・必要書類・仮押さえ・審査落ち",
  "お客様の発言の場面に結びつかないメモ（物件検索の採点・拡張ツール・画面・API 費用・テストの仕方・設計知見の整理・どの場面にも共通する考え方 等）は空の配列にしてください。題に場面の語があるだけ（例: 見積書の割引を採点に入れない）では選ばない。",
  '形: {"items":[{"n":番号,"s":["cost","viewing"]}]}',
].join("\n");
export function sceneTagPrompt(rows: Array<{ n: number; title: string; insight: string }>, mask: (s: string) => string): string {
  return rows.map((r) => `[${r.n}] 題: ${mask(r.title).slice(0, 220)}\n本文: ${mask(r.insight).replace(/\s+/g, " ").slice(0, 420)}`).join("\n\n");
}
export function parseSceneTagBatch(text: string): Map<number, KbScene[]> {
  const out = new Map<number, KbScene[]>();
  const m = String(text ?? "").match(/\{[\s\S]*\}/);
  if (!m) return out;
  try {
    const j = JSON.parse(m[0]) as { items?: Array<{ n?: number; s?: unknown }> };
    for (const it of j.items ?? []) {
      const n = Number(it.n);
      if (!Number.isFinite(n) || !Array.isArray(it.s)) continue;
      out.set(n, [...new Set((it.s as unknown[]).map(String).filter((x): x is KbScene => (SCENE_KEYS as string[]).includes(x)))].slice(0, 3));
    }
  } catch { /* 読めない返事は空 */ }
  return out;
}
export type SceneTagPlanRow = { id: string; title: string; priority: number; llm: KbScene[]; add: string[]; removeCandidates: string[]; keptDisagree: string[] };
const SCENE_TAG_SET = new Set(Object.values(KB_SCENES).map((v) => v.tag));
/**
 * DeepSeek の場面を足すのは、題か本文の頭（400字）にその場面の語がある時だけ（DeepSeek だけだと「汎用の型」「採点」の行にも場面を付けた＝10/08 の計画 104行を目で読んだ）。
 *   場面の点（+0.5）は大きいので、誤った札は場面で引いた時に関係ない行を押し上げる
 */
export const SCENE_EVIDENCE_RE: Record<Exclude<KbScene, "other">, RegExp> = {
  ack: /お礼|了承|ありがとう|締めの|よろしくお願い|かしこまりました|返信不要/,
  considering: /検討|保留|考え|持ち帰|また連絡/,
  question: /質問|聞かれ|聞いた|問い合わせ|ですか[？?」]/,
  conditions: /条件|希望の|言い直|あと一つ|世帯/,
  property_share: /持ち込|SUUMO|URL|お客様が送|送ってきた|お客様の画像|物件の画像|募集状況/,
  cost: /初期費用|見積|費用の|割引|安く|分割|値下|減額|総額|敷礼|礼金|フリーレント/,
  viewing: /内覧|内見|待ち合わせ|候補日/,
  apply: /申込|申し込|審査|必要書類|仮押さえ|お部屋を?抑え|保証会社/,
};
export function sceneEvidence(r: { title: string; insight?: string | null }, s: KbScene): boolean {
  if (s === "other") return false;
  return SCENE_EVIDENCE_RE[s].test(`${r.title}\n${String(r.insight ?? "").slice(0, 400)}`);
}
/** DeepSeek の答えと今の札を合わせる（足すだけ・外すのは候補に出すだけ） */
export function mergeSceneTags(r: { id: string; title: string; insight?: string | null; tags: string[] | null; priority: number }, llm0: KbScene[]): SceneTagPlanRow {
  const tags = r.tags ?? [];
  const llm = llm0.filter((s) => sceneEvidence(r, s));
  const want = llm.map((s) => KB_SCENES[s].tag);
  const has = tags.filter((t) => SCENE_TAG_SET.has(t));
  const add = want.filter((t) => !tags.includes(t));
  if (!want.length && !has.length) add.push(KB_SCENES.other.tag);
  const removeCandidates: string[] = [], keptDisagree: string[] = [];
  for (const t of has) {
    if (t === KB_SCENES.other.tag || want.includes(t)) continue;
    const s = (Object.keys(KB_SCENES) as KbScene[]).find((k) => KB_SCENES[k].tag === t)!;
    (rowInScene({ title: r.title, tags: [] }, s) ? removeCandidates : keptDisagree).push(t);
  }
  return { id: r.id, title: r.title, priority: r.priority, llm: llm0, add, removeCandidates, keptDisagree };
}

async function llmPlan() {
  setScriptRouteLabel("script:kb-scene-tag");
  const maxP = Number(arg("max-p") || 1);
  const out = arg("out");
  if (!out) throw new Error("--llm には --out=<plan.json> が要る");
  // --only-untagged: 場面の札がまだ無い行だけ（毎週の整理・新しく入った決まり）
  const rows = (await loadRagRows(sb)).filter((r) => effectivePriority(r) <= maxP && (!process.argv.includes("--only-untagged") || !(r.tags ?? []).some((t) => SCENE_TAG_SET.has(t))));
  const B = 12;
  const usage = { calls: 0, failed: 0, input: 0, cacheHit: 0, output: 0, usd: 0, model: "" };
  const plan: SceneTagPlanRow[] = [];
  for (let i = 0; i < rows.length; i += B) {
    const chunk = rows.slice(i, i + B);
    const prompt = sceneTagPrompt(chunk.map((r, k) => ({ n: k + 1, title: r.title, insight: r.insight })), maskForLlm);
    const t0 = Date.now();
    usage.calls++;
    const res = await callDeepSeek(SCENE_TAG_SYSTEM, prompt, { thinking: false, temperature: 0, maxTokens: 60 + chunk.length * 30, timeoutMs: 60_000 });
    if (res) {
      usage.model = res.model; usage.input += res.usage.input; usage.cacheHit += res.usage.cacheHit; usage.output += res.usage.output;
      recordAltUsage({ model: res.model, action: "kb-scene-tag", conversationId: null, usage: { input_tokens: res.usage.cacheMiss, cache_read_input_tokens: res.usage.cacheHit, output_tokens: res.usage.output }, status: 200, errorType: null, durationMs: Date.now() - t0, sysHead: SCENE_TAG_SYSTEM, sysKeyFull: null, maxTokens: 60 + chunk.length * 30 });
    }
    const parsed = res ? parseSceneTagBatch(res.text) : new Map<number, KbScene[]>();
    chunk.forEach((r, k) => { const v = parsed.get(k + 1); if (v) plan.push(mergeSceneTags({ id: r.id, title: r.title, insight: r.insight, tags: r.tags ?? null, priority: effectivePriority(r) }, v)); else usage.failed++; });
    process.stdout.write(`\r  DeepSeek ${Math.min(i + B, rows.length)}/${rows.length}`);
  }
  console.log("");
  const price = altPriceOf(usage.model || "deepseek");
  if (price) usage.usd = ((usage.input - usage.cacheHit) * price.in + usage.cacheHit * price.read + usage.output * price.out) / 1e6;
  writeFileSync(out, JSON.stringify({ generated_at: new Date().toISOString(), rows: rows.length, usage, plan }, null, 1));
  const n = (f: (p: SceneTagPlanRow) => boolean) => plan.filter(f).length;
  console.log(`P0〜P${maxP} ${rows.length}行・答えなし ${usage.failed}・足す ${n((p) => p.add.length > 0)}行（その他 ${n((p) => p.add.includes(KB_SCENES.other.tag))}）・外す候補 ${n((p) => p.removeCandidates.length > 0)}行・題の型でなく付いた札で食い違い ${n((p) => p.keptDisagree.length > 0)}行`);
  console.log(`DeepSeek ${usage.calls}回・入力 ${usage.input}（キャッシュ ${usage.cacheHit}）・出力 ${usage.output}・約 $${usage.usd.toFixed(4)}・${usage.model}\n計画: ${out}`);
  await flushLlmUsage();
}

async function applyPlan(planPath: string) {
  const backup = arg("backup");
  if (!backup) throw new Error("--apply-plan には --backup=<file> が要る（戻すため）");
  const { plan } = JSON.parse(readFileSync(planPath, "utf8")) as { plan: SceneTagPlanRow[] };
  // --remove=<id8:場面,…>（人が確かめた外す札だけ。場面は「初期費用」でも「場面:初期費用」でも）
  const remove = new Map<string, string[]>();
  for (const x of arg("remove").split(",").filter(Boolean)) { const [id8, tag] = x.split(":"); remove.set(id8, [...(remove.get(id8) ?? []), tag.startsWith("場面:") ? tag : `場面:${tag}`]); }
  // --skip=<id8:場面,…>（人が読んで要らないとした足す札。場面に結びつかない行になれば「場面:その他」）
  const skip = new Map<string, string[]>();
  for (const x of arg("skip").split(",").filter(Boolean)) { const [id8, tag] = x.split(":"); skip.set(id8, [...(skip.get(id8) ?? []), tag.startsWith("場面:") ? tag : `場面:${tag}`]); }
  const ids = plan.filter((p) => p.add.length || remove.has(p.id.slice(0, 8))).map((p) => p.id);
  // 書く直前に今の札を読み直す（並行で札が変わっていても上書きしない＝足す・外すだけ）
  const now = new Map<string, string[] | null>();
  for (let i = 0; i < ids.length; i += 150) {
    const { data, error } = await sb.from("system_design_thinking").select("id, tags, is_current").in("id", ids.slice(i, i + 150));
    if (error) throw new Error(error.message);
    for (const r of (data ?? []) as Array<{ id: string; tags: string[] | null; is_current: boolean }>) if (r.is_current) now.set(r.id, r.tags);
  }
  const bk: Array<{ id: string; tags: string[] | null }> = [];
  const writes: Array<{ id: string; tags: string[] }> = [];
  for (const p of plan) {
    if (!now.has(p.id)) continue;
    const cur = now.get(p.id) ?? [];
    const rm = remove.get(p.id.slice(0, 8)) ?? [];
    const next = cur.filter((t) => !rm.includes(t));
    const sk = skip.get(p.id.slice(0, 8)) ?? [];
    for (const t of p.add) if (!next.includes(t) && !sk.includes(t)) next.push(t);
    // 場面の札が全部外れて何も無くなる時は「場面:その他」（確かめた印）
    if (!next.some((t) => SCENE_TAG_SET.has(t))) next.push(KB_SCENES.other.tag);
    if (next.length === cur.length && next.every((t, i) => t === cur[i])) continue;
    bk.push({ id: p.id, tags: now.get(p.id) ?? null });
    writes.push({ id: p.id, tags: next });
  }
  writeFileSync(backup, JSON.stringify(bk));
  for (const w of writes) { const { error } = await sb.from("system_design_thinking").update({ tags: w.tags }).eq("id", w.id); if (error) throw new Error(`${w.id}: ${error.message}`); }
  const e = await embedKbRows(sb, { dry: false, ids: writes.map((w) => w.id) });
  console.log(`書いた: ${writes.length}行（外した札 ${[...remove.values()].flat().length}）・控え ${backup}・埋め込み ${e.embedded}行（$${e.usd.toFixed(5)}）`);
}

async function main() {
  if (process.argv.includes("--llm")) return llmPlan();
  if (arg("apply-plan")) return applyPlan(arg("apply-plan"));
  const restore = arg("restore");
  if (restore) {
    const bk = JSON.parse(readFileSync(restore, "utf8")) as Array<{ id: string; tags: string[] | null }>;
    for (const b of bk) { const { error } = await sb.from("system_design_thinking").update({ tags: b.tags }).eq("id", b.id); if (error) throw new Error(error.message); }
    const e = await embedKbRows(sb, { dry: false, ids: bk.map((b) => b.id) });
    console.log(`戻した: ${bk.length}行・埋め込み ${e.embedded}（$${e.usd.toFixed(5)}）`);
    return;
  }
  const rows: Array<{ id: string; title: string; tags: string[] | null }> = [];
  for (let p = 0; p < 10; p++) {
    const { data, error } = await sb.from("system_design_thinking").select("id, title, tags").eq("is_current", true).order("created_at").range(p * 1000, p * 1000 + 999);
    if (error) throw new Error(error.message);
    rows.push(...((data ?? []) as typeof rows));
    if ((data ?? []).length < 1000) break;
  }
  const plan = rows.map((r) => ({ r, add: sceneTagsToAdd(r) })).filter((x) => x.add.length);
  const by = new Map<string, number>();
  for (const x of plan) for (const t of x.add) by.set(t, (by.get(t) ?? 0) + 1);
  console.log(`現行 ${rows.length}行・札を足す ${plan.length}行: ${[...by].map(([t, n]) => `${t} ${n}`).join("・")}`);
  const show = arg("show");
  if (show) for (const x of plan.filter((p) => p.add.includes(KB_SCENES[show as KbScene]?.tag ?? show))) console.log(`  ${x.r.id.slice(0, 8)} ${x.r.title.slice(0, 90)}`);
  if (!APPLY) return;
  const backup = arg("backup");
  if (!backup) throw new Error("--apply には --backup=<file> が要る（戻すため）");
  writeFileSync(backup, JSON.stringify(plan.map((x) => ({ id: x.r.id, tags: x.r.tags }))));
  for (const x of plan) {
    const { error } = await sb.from("system_design_thinking").update({ tags: [...(x.r.tags ?? []), ...x.add] }).eq("id", x.r.id);
    if (error) throw new Error(`${x.r.id}: ${error.message}`);
  }
  const e = await embedKbRows(sb, { dry: false, ids: plan.map((x) => x.r.id) });
  console.log(`書いた: ${plan.length}行（控え ${backup}）・埋め込み ${e.embedded}（$${e.usd.toFixed(5)}）`);
}
if (process.argv[1]?.includes("kb-scene-tag")) main().catch((e) => { console.error(e); process.exit(1); });
