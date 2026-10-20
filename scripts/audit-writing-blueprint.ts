// scripts/audit-writing-blueprint.ts — 文の設計図（app/lib/writing-blueprint.ts）を実データで測る（読むだけ・LLM なし・DB に書かない・文の中身は出さない）
//
//   --mode=mine  : 竹内さんの手打ち（messages staff_writer='takeuchi' かつ is_aix_generated=false）の返事を場面ごとに段の並びにして、
//                  並びの揃い方（基本の並びと逆の対が無い割合）・段の出る率・多い並び・文の数を数える（既定 90日）
//   --mode=check : 見張り（line_watch_turns）の AI の下書き（draft_first）とスタッフが送った文（staff_texts）を設計図で確かめ、
//                  外れの型ごとに数える（既定 30日）。スタッフの送信も外れる型は「決まりの方が違う」目安
// 実行: npx tsx --env-file=.env.local scripts/audit-writing-blueprint.ts --mode=mine [--days=90]
import { createClient } from "@supabase/supabase-js";
import { resolveReplyScene, type ReplyScene } from "../app/lib/reply-scene";
import { partsOf, orderInversions, BASE_ORDER, WRITING_BLUEPRINTS, PART_JA, checkDraftAgainstBlueprint, questionsOf, BREAK_JA, type BlueprintPart, type BlueprintBreakType } from "../app/lib/writing-blueprint";
import { isOtherAgentViewingPlan, isOtherAgentViewingApplyQuestion } from "../app/lib/other-agent-viewing";

const sb = createClient(process.env.NEXT_PUBLIC_SUPABASE_URL ?? "", process.env.SUPABASE_SERVICE_ROLE_KEY ?? "");
const arg = (k: string, d: string) => (process.argv.find((a) => a.startsWith(`--${k}=`)) ?? `--${k}=${d}`).split("=").slice(1).join("=");
const MODE = arg("mode", "mine");
const DAYS = Number(arg("days", MODE === "mine" ? "90" : "30"));
const PEEK = arg("peek", "");
let peeked = 0;
// --peek=場面:段 は手元で段の分け方を確かめる時だけ（名前・数字は伏せる・出力を残さない）
const mask = (t: string) => t.replace(/[^\s、。！!？?\n]{1,12}(?:さん|様)/g, "〇〇さん").replace(/[0-9０-９]{2,}/g, "N").slice(0, 60);
const pct = (a: number, b: number) => (b ? `${((100 * a) / b).toFixed(0)}%` : "-");

async function readAll<T>(fn: (from: number, to: number) => PromiseLike<{ data: unknown; error: { message: string } | null }>, cap = 400_000): Promise<T[]> {
  const out: T[] = [];
  for (let from = 0; from < cap; from += 1000) {
    const { data, error } = await fn(from, from + 999);
    if (error) throw new Error(error.message);
    const rows = (data ?? []) as T[];
    out.push(...rows);
    if (rows.length < 1000) break;
  }
  return out;
}
type Msg = { conversation_id: string; sender: string; text: string | null; created_at: string; is_aix_generated?: boolean | null; staff_writer?: string | null; image_url?: string | null; file_url?: string | null };
const branchOf = (customer: string): string | null => (isOtherAgentViewingPlan(customer) || isOtherAgentViewingApplyQuestion(customer) ? "other_agent_viewing" : null);

async function mine() {
  const since = new Date(Date.now() - DAYS * 86400_000).toISOString();
  const convs = await readAll<{ id: string; line_source_type: string | null }>((f, t) => sb.from("conversations").select("id, line_source_type").range(f, t));
  const skip = new Set(convs.filter((c) => (c.line_source_type ?? "user") !== "user").map((c) => c.id));
  const msgs = await readAll<Msg>((f, t) => sb.from("messages").select("conversation_id, sender, text, created_at, is_aix_generated, staff_writer, image_url, file_url").gte("created_at", since).order("created_at").order("id").range(f, t));
  const by = new Map<string, Msg[]>();
  for (const m of msgs) { if (skip.has(m.conversation_id)) continue; (by.get(m.conversation_id) ?? by.set(m.conversation_id, []).get(m.conversation_id)!).push(m); }
  type B = { inv: Map<string, number>; n: number; noInvBase: number; noInvBp: number; parts: Map<string, number>; seqs: Map<string, number>; sents: number[]; breaks: Map<string, number>; qMulti: number; qInv: number };
  const mk = (): B => ({ inv: new Map(), n: 0, noInvBase: 0, noInvBp: 0, parts: new Map(), seqs: new Map(), sents: [], breaks: new Map(), qMulti: 0, qInv: 0 });
  const per = new Map<string, B>();
  let turns = 0;
  for (const [, arr] of by) {
    for (let k = 0; k < arr.length; k++) {
      if (arr[k].sender !== "customer" || arr[k + 1]?.sender === "customer") continue;
      let s = k; while (s >= 0 && arr[s].sender === "customer") s--;
      const customer = arr.slice(s + 1, k + 1).map((x) => String(x.text ?? "")).join("\n");
      const block: Msg[] = [];
      for (let j = k + 1; j < arr.length && arr[j].sender !== "customer"; j++) {
        if (block.length && Date.parse(arr[j].created_at) - Date.parse(block[0].created_at) > 30 * 60_000) break;
        if (!block.length && Date.parse(arr[j].created_at) - Date.parse(arr[k].created_at) > 3 * 3600_000) break;   // 3時間より後の最初の文は、返事ではなく後の報告・新しいご紹介
        block.push(arr[j]);
      }
      // 物件のご紹介・見積の本体は「送った物」で返事の文ではない
      const isCard = (t: string) => /https?:\/\/|🌟|御見積書となります|（室内(?:写真|イメージ)）/.test(t);
      const manual = block.filter((x) => x.sender === "staff" && !x.is_aix_generated && x.text && !/^\[(?:画像|動画|スタンプ|ファイル)\]$/.test(x.text.trim()) && !isCard(x.text));
      if (!manual.length || manual.some((x) => x.staff_writer !== "takeuchi")) continue;
      const sent = block.some((x) => x.is_aix_generated || x.image_url || x.file_url || (x.sender === "staff" && isCard(String(x.text ?? ""))));
      const text = manual.map((x) => x.text).join("\n");
      turns++;
      const scene: ReplyScene = resolveReplyScene({ customerText: customer }).scene;
      const branch = branchOf(customer);
      const key = branch ? `${scene}+${branch}` : scene;
      const seq = partsOf(text);
      const qs = questionsOf(customer);
      const chk = checkDraftAgainstBlueprint(text, { scene, routeBranch: branch, questions: qs, sentThisTurn: sent });
      if (PEEK && PEEK.split(":")[0] === key && peeked < 12) { const want = PEEK.split(":")[1]; const hit = seq.sentences.filter((x) => x.part === want); if (hit.length) { peeked++; console.log(`[peek] ${hit.map((x) => mask(x.text)).join(" / ")}`); } }
      for (const kk of [key, "ALL"]) {
        const b = per.get(kk) ?? per.set(kk, mk()).get(kk)!;
        b.n++;
        const invs = orderInversions(seq.parts, BASE_ORDER);
        if (!invs.length) b.noInvBase++;
        for (const [x, y] of invs) { const kk2 = `${PART_JA[x]}→${PART_JA[y]}`; b.inv.set(kk2, (b.inv.get(kk2) ?? 0) + 1); }
        if (!orderInversions(seq.parts, WRITING_BLUEPRINTS[scene].order).length) b.noInvBp++;
        for (const p of new Set(seq.parts)) b.parts.set(p, (b.parts.get(p) ?? 0) + 1);
        const sig = seq.parts.filter((p) => p !== "name" && p !== "greeting").map((p) => PART_JA[p as BlueprintPart]).join("→") || "(空)";
        b.seqs.set(sig, (b.seqs.get(sig) ?? 0) + 1);
        b.sents.push(seq.sentences.filter((x) => x.part !== "name" && x.part !== "greeting").length);
        for (const t of new Set(chk.breaks.map((x) => x.type))) b.breaks.set(t, (b.breaks.get(t) ?? 0) + 1);
        if (qs.length >= 2) { b.qMulti++; if (chk.breaks.some((x) => x.type === "question_order")) b.qInv++; }
      }
    }
  }
  console.log(`=== 竹内さんの手打ちの返事 ${turns}番（直近${DAYS}日・お客様の番の後30分のまとまり・全部 takeuchi の手打ちの番だけ）===`);
  const keys = [...per.keys()].sort((a, b) => per.get(b)!.n - per.get(a)!.n);
  for (const k of keys) {
    const b = per.get(k)!;
    if (b.n < 5) continue;
    const sorted = [...b.sents].sort((x, y) => x - y);
    const q = (p: number) => sorted[Math.min(sorted.length - 1, Math.floor(p * sorted.length))];
    console.log(`\n■ ${k}  n=${b.n}  基本の並びと揃う ${pct(b.noInvBase, b.n)}・設計図の並びと揃う ${pct(b.noInvBp, b.n)}  文の数 中央${q(0.5)}/上位10% ${q(0.9)}  複数の質問 ${b.qMulti}（順が違う ${b.qInv}）`);
    console.log(`  段の出る率: ${[...b.parts].sort((x, y) => y[1] - x[1]).map(([p, c]) => `${PART_JA[p as BlueprintPart]} ${pct(c, b.n)}`).join("・")}`);
    console.log(`  多い並び: ${[...b.seqs].sort((x, y) => y[1] - x[1]).slice(0, 5).map(([s, c]) => `${s} ${pct(c, b.n)}`).join(" ｜ ")}`);
    console.log(`  基本の並びと逆の対（多い順）: ${[...b.inv].sort((x, y) => y[1] - x[1]).slice(0, 5).map(([s2, c]) => `${s2} ${c}`).join("・")}`);
    console.log(`  （手打ちを設計図で確かめた外れ）: ${[...b.breaks].sort((x, y) => y[1] - x[1]).map(([t, c]) => `${BREAK_JA[t as BlueprintBreakType]} ${c}`).join("・") || "なし"}`);
  }
}

async function check() {
  const since = new Date(Date.now() - DAYS * 86400_000).toISOString();
  type T = { conversation_id: string; customer_turn_at: string; customer_last_at: string; draft_first: string | null; staff_texts: Array<{ text: string }> | null; staff_aix: unknown[] | null };
  const rows = await readAll<T>((f, t) => sb.from("line_watch_turns").select("conversation_id, customer_turn_at, customer_last_at, draft_first, staff_texts, staff_aix").gte("created_at", since).not("draft_first", "is", null).order("id").range(f, t));
  const convIds = [...new Set(rows.map((r) => r.conversation_id))];
  const cust = new Map<string, Msg[]>();
  for (let i = 0; i < convIds.length; i += 50) {
    const part = await readAll<Msg>((f, t) => sb.from("messages").select("conversation_id, sender, text, created_at").in("conversation_id", convIds.slice(i, i + 50)).eq("sender", "customer").gte("created_at", new Date(Date.parse(since) - 2 * 86400_000).toISOString()).order("created_at").range(f, t));
    for (const m of part) (cust.get(m.conversation_id) ?? cust.set(m.conversation_id, []).get(m.conversation_id)!).push(m);
  }
  const draftBreaks = new Map<string, number>(), staffBreaks = new Map<string, number>(), onlyDraft = new Map<string, number>(), byScene = new Map<string, Map<string, number>>(), sceneN = new Map<string, number>();
  let n = 0, nStaff = 0, draftClean = 0, staffClean = 0;
  const details = new Map<string, number>();
  for (const r of rows) {
    const ms = (cust.get(r.conversation_id) ?? []).filter((m) => m.created_at >= r.customer_turn_at && m.created_at <= r.customer_last_at);
    const customer = ms.map((m) => String(m.text ?? "")).join("\n");
    if (!customer.trim() || !r.draft_first) continue;
    const scene = resolveReplyScene({ customerText: customer }).scene;
    const facts = { scene, routeBranch: branchOf(customer), questions: questionsOf(customer), sentThisTurn: (r.staff_aix ?? []).length > 0 };
    const d = checkDraftAgainstBlueprint(r.draft_first, facts);
    n++; sceneN.set(scene, (sceneN.get(scene) ?? 0) + 1);
    if (!d.breaks.length) draftClean++;
    const sm = byScene.get(scene) ?? byScene.set(scene, new Map()).get(scene)!;
    const dTypes = new Set(d.breaks.map((b) => b.type));
    for (const t of dTypes) { draftBreaks.set(t, (draftBreaks.get(t) ?? 0) + 1); sm.set(t, (sm.get(t) ?? 0) + 1); }
    for (const b of d.breaks) if (b.type === "missing_required" || b.type === "order") for (const one of b.detail.split(",")) { const k2 = `${BREAK_JA[b.type]}:${one}`; details.set(k2, (details.get(k2) ?? 0) + 1); }
    const st = (r.staff_texts ?? []).map((x) => x.text).filter(Boolean).join("\n");
    if (st.trim()) {
      nStaff++;
      const s = checkDraftAgainstBlueprint(st, facts);
      if (!s.breaks.length) staffClean++;
      const sTypes = new Set(s.breaks.map((b) => b.type));
      for (const t of sTypes) staffBreaks.set(t, (staffBreaks.get(t) ?? 0) + 1);
      for (const t of dTypes) if (!sTypes.has(t)) onlyDraft.set(t, (onlyDraft.get(t) ?? 0) + 1);
    }
  }
  console.log(`=== 見張りの下書き ${n}番（直近${DAYS}日）・うちスタッフの文字の送信あり ${nStaff} ===`);
  console.log(`外れ無し: 下書き ${pct(draftClean, n)}・スタッフの送信 ${pct(staffClean, nStaff)}`);
  console.log("外れの型（番の数）  下書き ｜ スタッフの送信 ｜ 下書きだけ外れ（同じ番でスタッフは外れていない）");
  for (const [t, c] of [...draftBreaks].sort((a, b) => b[1] - a[1])) console.log(`  ${BREAK_JA[t as BlueprintBreakType]}  ${c} ｜ ${staffBreaks.get(t) ?? 0} ｜ ${onlyDraft.get(t) ?? 0}`);
  for (const [t, c] of staffBreaks) if (!draftBreaks.has(t)) console.log(`  ${BREAK_JA[t as BlueprintBreakType]}  0 ｜ ${c} ｜ 0`);
  console.log(`\n中身（下書き）: ${[...details].sort((a, b) => b[1] - a[1]).slice(0, 10).map(([k2, c]) => `${k2} ${c}`).join("・")}`);
  console.log("\n場面ごとの下書きの外れ（上位3）:");
  for (const [sc, m] of [...byScene].sort((a, b) => (sceneN.get(b[0]) ?? 0) - (sceneN.get(a[0]) ?? 0))) console.log(`  ${sc} n=${sceneN.get(sc)}: ${[...m].sort((a, b) => b[1] - a[1]).slice(0, 3).map(([t, c]) => `${BREAK_JA[t as BlueprintBreakType]} ${c}`).join("・")}`);
}

(MODE === "check" ? check() : mine()).catch((e) => { console.error(e); process.exit(1); });
