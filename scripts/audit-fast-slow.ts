// scripts/audit-fast-slow.ts — 「慣れた事は速く・難しい事はじっくり」（app/lib/brain-fast-slow.ts）を本番の番で測る（読むだけ・書き込みなし・LLM なし・費用0）
//
// 材料: 本番の見張り line_watch_turns（下書き・最終チェック・場面・スタッフが実際に送った文と押した AIX・材料の字数 materials.brain.blocks）
//       ＋ messages（この番のお客様の発言）＋ brain_decision_logs.digest（下書きの自信の入力）＋ llm_usage_logs（本番のブレインの呼び出しの費用・時間）
// 見る事:
//   1. 慣れた（easy）・普通・難しい（hard）の割合（入口の計算＝お客様の文と場面の前例だけ・ブレインの前に分かる物）
//   2. 段ごとにスタッフがした事（そのまま／少し直す／大きく直す／AIX へ）と下書きの自信の段 → 難しい番ほど直されているか・慣れた番は直されにくいか
//   3. 速い道で渡さない材料の字数（easy の番の materials）→ 入力の減り・費用と時間の見込み。じっくりの道の2回目の費用の見込み
// 場面の前例の表は古い 60% だけで作り、新しい 40% で確かめる（表の答えの漏れを防ぐ）。
// 実行: npx tsx --env-file=.env.local scripts/audit-fast-slow.ts [--days=14] [--write-priors]
//   --write-priors … 全部の番で app/lib/brain-fast-slow-priors.ts を書き直す（場面の名前と件数だけ・ファイルを書くだけ・DB は読むだけ）
import { createClient } from "@supabase/supabase-js";
import { writeFileSync } from "node:fs";
import { pickJudgeDraft, cleanDraft } from "../app/lib/line-watch-judge";
import { classifyEdit } from "../app/lib/edit-diff";
import { isTestConversation } from "../app/lib/test-conversations";
import { resolveReplyScene } from "../app/lib/reply-scene";
import { detectSensitiveCase } from "../app/lib/sensitive-case";
import { screeningSensitiveSignal } from "../app/lib/screening-sensitive";
import { isConditionFormMessage } from "../app/lib/reply-context";
import { readCustomerMind } from "../app/lib/customer-reaction-predict";
import { isPostApplyStatus } from "../app/lib/llm-alt-provider";
import { scoreDraftConfidence, type ConfidenceInput } from "../app/lib/draft-confidence";
import { decideTurnDifficulty, FAST_DROP_MATERIALS, type TurnLevel } from "../app/lib/brain-fast-slow";
import { claudeUsageUsd, altUsageUsd } from "../app/lib/llm-price";

const arg = (k: string, d: string) => process.argv.find((a) => a.startsWith(`--${k}=`))?.slice(k.length + 3) ?? d;
const DAYS = Number(arg("days", "14"));
const WRITE_PRIORS = process.argv.includes("--write-priors");
const sb = createClient(process.env.NEXT_PUBLIC_SUPABASE_URL!, process.env.SUPABASE_SERVICE_ROLE_KEY || process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY!);
async function readAll<T>(q: (from: number, to: number) => PromiseLike<{ data: unknown; error: { message: string } | null }>, cap = 300_000): Promise<T[]> {
  const out: T[] = [];
  for (let i = 0; i < cap; i += 1000) {
    const r = await q(i, i + 999);
    if (r.error) throw new Error(r.error.message);
    const d = (r.data ?? []) as T[];
    out.push(...d);
    if (d.length < 1000) break;
  }
  return out;
}
type Turn = {
  conversation_id: string; customer_turn_at: string; customer_last_at: string | null; conv_status: string | null;
  draft_first: string | null; draft_first_at: string | null; draft_last: string | null; draft_versions: number | null;
  brain_action: string | null; brain_reply_mode: string | null; scene_key: string | null; final_check: Record<string, unknown> | null;
  staff_texts: Array<{ at: string; text: string | null; burst?: boolean }> | null; staff_aix: Array<{ aix_type: string; burst?: boolean }> | null;
  decision_id: string | null; verdict: string | null; verdict_detail: { reason?: string } | null; materials: Record<string, unknown> | null;
};
type Msg = { conversation_id: string; sender: string; created_at: string; text: string | null; is_aix_generated: boolean | null };
type Dec = { id: string; conversation_id: string; created_at: string; digest: Record<string, unknown> | null };
type Outcome = "as_is" | "light" | "heavy" | "aix";
type Row = { at: string; outcome: Outcome; agree: boolean | null; scene: string; diffIn: Parameters<typeof decideTurnDifficulty>[0]; conf: ConfidenceInput; blocks: { chars: Record<string, number>; userTotal: number | null } | null };
const P = Date.parse;
const pct = (a: number, b: number) => (b ? `${((100 * a) / b).toFixed(0)}%` : "-");

function outcomeOf(t: Turn, draft: string): Outcome | null {
  const texts = (t.staff_texts ?? []).filter((x) => x.burst !== false && (x.text ?? "").trim());
  if (texts.length) {
    let bestSim = -1, best = String(texts[0].text);
    for (const x of texts) { const sim = classifyEdit(draft, String(x.text)).sim; if (sim > bestSim) { bestSim = sim; best = String(x.text); } }
    const d = classifyEdit(draft, best);
    return d.amount === "none" || d.amount === "tiny" ? "as_is" : d.amount === "small" ? "light" : "heavy";
  }
  if ((t.staff_aix ?? []).some((a) => a.burst !== false)) return "aix";
  return null;
}
function finalCheckOf(fc: Record<string, unknown> | null): ConfidenceInput["finalCheck"] {
  if (!fc) return null;
  return {
    ok: typeof fc.ok === "boolean" ? fc.ok : null,
    issues: Array.isArray(fc.issues) ? (fc.issues as Array<{ code?: string; severity?: string }>) : [],
    revisionExhausted: fc.revision_exhausted === true,
    regenCount: typeof fc.regen_count === "number" ? fc.regen_count : null,
    preIssues: Array.isArray(fc.pre) ? (fc.pre as string[]) : null,
  };
}

async function main() {
  const turns = await readAll<Turn>((f, t) => sb.from("line_watch_turns")
    .select("conversation_id, customer_turn_at, customer_last_at, conv_status, draft_first, draft_first_at, draft_last, draft_versions, brain_action, brain_reply_mode, scene_key, final_check, staff_texts, staff_aix, decision_id, verdict, verdict_detail, materials")
    .order("customer_turn_at").order("id").range(f, t));
  const since = new Date(Math.min(...turns.map((t) => P(t.customer_turn_at))) - 10 * 86_400_000).toISOString();
  const msgs = await readAll<Msg>((f, t) => sb.from("messages").select("conversation_id, sender, created_at, text, is_aix_generated").gte("created_at", since).order("created_at").order("id").range(f, t));
  const decs = await readAll<Dec>((f, t) => sb.from("brain_decision_logs").select("id, conversation_id, created_at, digest").gte("created_at", since).order("created_at").order("id").range(f, t));
  console.log(`見張りの番 ${turns.length}・messages ${msgs.length}・判断 ${decs.length}`);
  const mBy = new Map<string, Msg[]>();
  for (const m of msgs) { if (!mBy.has(m.conversation_id)) mBy.set(m.conversation_id, []); mBy.get(m.conversation_id)!.push(m); }
  const dById = new Map(decs.map((d) => [d.id, d]));
  const dBy = new Map<string, Dec[]>();
  for (const d of decs) { if (!dBy.has(d.conversation_id)) dBy.set(d.conversation_id, []); dBy.get(d.conversation_id)!.push(d); }

  const rows: Row[] = [];
  const skip: Record<string, number> = {};
  const bump = (k: string) => { skip[k] = (skip[k] ?? 0) + 1; };
  for (const t of turns) {
    if (isTestConversation(t.conversation_id)) { bump("試験の会話"); continue; }
    if (t.verdict_detail?.reason === "out_of_scope" || (t.scene_key ?? "").startsWith("対象外")) { bump("申込以降"); continue; }
    const pick = pickJudgeDraft(t);
    if (pick.src !== "last" && pick.src !== "first") { bump("下書きなし"); continue; }
    const draft = cleanDraft(pick.draft).text;
    if (!draft) { bump("下書きなし"); continue; }
    const oc = outcomeOf(t, draft);
    if (!oc) { bump("スタッフが何もしなかった"); continue; }
    const list = mBy.get(t.conversation_id) ?? [];
    const lastAt = P(t.customer_last_at ?? t.customer_turn_at), turnAt = P(t.customer_turn_at);
    const turnMsgs = list.filter((m) => m.sender === "customer" && P(m.created_at) >= turnAt - 1000 && P(m.created_at) <= lastAt + 1000);
    const custText = turnMsgs.filter((m) => !/^\s*\[(?:画像|動画)\]/.test(m.text ?? "")).map((m) => m.text ?? "").join("\n");
    const hasImage = turnMsgs.some((m) => /^\s*\[画像\]/.test(m.text ?? ""));
    const before = list.filter((m) => P(m.created_at) < turnAt);
    const upto = list.filter((m) => P(m.created_at) <= lastAt + 1000);
    const mind = readCustomerMind(upto.map((m) => ({ sender: m.sender, text: m.text, createdAt: m.created_at, isAix: m.is_aix_generated })));
    const firstContact = !before.some((m) => m.sender !== "customer");
    const scene = resolveReplyScene({ customerText: custText }).scene;
    const diffIn = {
      customerText: custText, hasImage, scene, postApply: isPostApplyStatus(t.conv_status), isFirstContact: firstContact,
      pendingPromises: null, mindNow: mind?.now ?? null, mindWorry: mind?.worry ?? null,
      sensitive: !!detectSensitiveCase(custText), screeningSensitive: !!screeningSensitiveSignal(custText), conditionForm: isConditionFormMessage(custText),
    };
    let dec = t.decision_id ? dById.get(t.decision_id) ?? null : null;
    if (!dec) dec = (dBy.get(t.conversation_id) ?? []).filter((d) => P(d.created_at) >= turnAt - 1000 && P(d.created_at) <= lastAt + 15 * 60_000).pop() ?? null;
    const g = dec?.digest ?? null;
    const str = (v: unknown) => (typeof v === "string" ? v : null);
    const conf: ConfidenceInput = {
      draft, customerText: custText, groundText: before.slice(-30).map((m) => m.text ?? "").join("\n"), convStatus: t.conv_status,
      finalCheck: finalCheckOf(t.final_check),
      brain: { replyMode: t.brain_reply_mode, action: t.brain_action, llmAction: g && "la" in g ? str(g.la) : t.brain_action, property: g ? str(g.prop) : null, llmProperty: g ? str(g.lp) : null, questions: g && Array.isArray(g.q) ? (g.q as unknown[]).length : null, deepCheck: !!(g && g.dc) },
      isFirstContact: firstContact, sceneKey: t.scene_key,
    };
    const b = ((t.materials as { brain?: { blocks?: { chars?: Record<string, number>; userTotal?: number | null } } } | null)?.brain?.blocks) ?? null;
    rows.push({ at: t.customer_turn_at, outcome: oc, agree: t.verdict && t.verdict !== "na" ? t.verdict === "same" || t.verdict === "same_meaning" : null, scene, diffIn, conf, blocks: b?.chars ? { chars: b.chars, userTotal: b.userTotal ?? null } : null });
  }
  console.log(`数える番 ${rows.length}（除いた: ${Object.entries(skip).map(([k, v]) => `${k} ${v}`).join("・")}）`);
  rows.sort((a, b) => P(a.at) - P(b.at));
  const cut = Math.floor(rows.length * 0.6);
  const train = rows.slice(0, cut), test = rows.slice(cut);
  const priorsOf = (rs: Row[]) => { const p: Record<string, { n: number; asIs: number }> = {}; for (const r of rs) { p[r.scene] ??= { n: 0, asIs: 0 }; p[r.scene].n++; if (r.outcome === "as_is") p[r.scene].asIs++; } return p; };
  const asIsN = (rs: Row[]) => rs.filter((r) => r.outcome === "as_is").length;
  const trainPriors = priorsOf(train), trainBase = asIsN(train) / train.length;
  console.log(`古い半分 ${train.length}（〜${train[train.length - 1].at.slice(0, 10)}）・新しい半分 ${test.length}（${test[0].at.slice(0, 10)}〜${test[test.length - 1].at.slice(0, 10)}）・全体のそのまま率（古い）${pct(asIsN(train), train.length)}`);
  console.log(`\n場面の前例（古い半分）: ${Object.entries(trainPriors).sort((a, b) => b[1].n - a[1].n).map(([k, v]) => `${k} ${pct(v.asIs, v.n)}/${v.n}`).join("・")}`);

  const levelOf = (r: Row, pri = trainPriors, base = trainBase) => decideTurnDifficulty({ ...r.diffIn, priors: pri, priorBase: base });
  const show = (label: string, rs: Row[]) => {
    console.log(`\n${label}（${rs.length}番）`);
    const why: Record<string, number> = {};
    for (const lv of ["easy", "normal", "hard"] as TurnLevel[]) {
      const g = rs.filter((r) => levelOf(r).level === lv);
      const n = g.length, k = (o: Outcome) => g.filter((r) => r.outcome === o).length;
      const ag = g.filter((r) => r.agree !== null);
      const bands = g.map((r) => scoreDraftConfidence({ ...r.conf, priors: undefined }).band);
      console.log(`  ${lv.padEnd(6)} ${String(n).padStart(4)}番（${pct(n, rs.length).padStart(4)}）  そのまま ${pct(k("as_is"), n).padStart(4)}・少し直す ${pct(k("light"), n).padStart(4)}・大きく直す ${pct(k("heavy"), n).padStart(4)}・AIX へ ${pct(k("aix"), n).padStart(4)}｜中身が合った ${pct(ag.filter((r) => r.agree).length, ag.length).padStart(4)}｜自信 低 ${pct(bands.filter((b) => b === "low").length, n)}・高 ${pct(bands.filter((b) => b === "high").length, n)}`);
      if (lv === "hard") for (const r of g) for (const w of levelOf(r).reasons) { const key = w.replace(/\d+/g, "N").replace(/（.*）/, ""); why[key] = (why[key] ?? 0) + 1; }
    }
    console.log(`  難しいの理由: ${Object.entries(why).sort((a, b) => b[1] - a[1]).map(([k, v]) => `${k} ${v}`).join("・")}`);
  };
  show("新しい半分（試し・前例の表は古い半分だけ）", test);
  show("全部（前例の表は古い半分）", rows);
  // easy の中の場面
  const easyTest = test.filter((r) => levelOf(r).level === "easy");
  const byScene: Record<string, Row[]> = {};
  for (const r of easyTest) (byScene[r.scene] ??= []).push(r);
  console.log(`\n慣れた番の場面（新しい半分）: ${Object.entries(byScene).map(([k, v]) => `${k} ${v.length}番 そのまま${pct(asIsN(v), v.length)}・AIX へ ${pct(v.filter((r) => r.outcome === "aix").length, v.length)}`).join("・")}`);

  // --breakdown: 場面×長さ×段ごと（全部の番）。慣れた番の線を決める時に見る
  if (process.argv.includes("--breakdown")) {
    const grp: Record<string, Row[]> = {};
    for (const r of rows) {
      const t = String(r.diffIn.customerText ?? "").normalize("NFKC").trim();
      const k = `${r.scene}|${r.diffIn.conditionForm ? "form" : t.length <= 80 ? "short" : "long"}|${levelOf(r).level}`;
      (grp[k] ??= []).push(r);
    }
    console.log("\n場面|長さ|段 ごと（全部）");
    for (const [k, v] of Object.entries(grp).sort((a, b) => b[1].length - a[1].length)) {
      const ag = v.filter((r) => r.agree !== null);
      console.log(`  ${k.padEnd(34)} ${String(v.length).padStart(4)}番 そのまま ${pct(asIsN(v), v.length).padStart(4)}・大きく直す ${pct(v.filter((r) => r.outcome === "heavy").length, v.length).padStart(4)}・AIX へ ${pct(v.filter((r) => r.outcome === "aix").length, v.length).padStart(4)}・合った ${pct(ag.filter((r) => r.agree).length, ag.length)}`);
    }
  }
  // ── 材料の字数（easy の番・materials がある番だけ） ──
  const all = rows;
  const withB = all.filter((r) => r.blocks && r.blocks.userTotal);
  const easyB = withB.filter((r) => levelOf(r).level === "easy");
  const dropOf = (r: Row) => FAST_DROP_MATERIALS.reduce((a, k) => a + (r.blocks!.chars[k] ?? 0), 0);
  const avg = (xs: number[]) => (xs.length ? xs.reduce((a, b) => a + b, 0) / xs.length : 0);
  const easyDrop = avg(easyB.map(dropOf)), easyUser = avg(easyB.map((r) => r.blocks!.userTotal!));
  const perKey = FAST_DROP_MATERIALS.map((k) => `${k} ${Math.round(avg(easyB.map((r) => r.blocks!.chars[k] ?? 0)))}`).join("・");
  const share = (lv: TurnLevel) => all.filter((r) => levelOf(r).level === lv).length / all.length;
  console.log(`\n材料（materials のある ${withB.length}番・うち慣れた ${easyB.length}番）: 慣れた番の素の入力 平均 ${Math.round(easyUser)}字 → 速い道で渡さない 平均 ${Math.round(easyDrop)}字（${pct(easyDrop, easyUser)}）  内訳: ${perKey}`);

  // ── 本番のブレインの呼び出し（llm_usage_logs・直近 DAYS 日） ──
  const usSince = new Date(Date.now() - DAYS * 86_400_000).toISOString();
  type U = { model: string; action: string | null; env: string | null; input_uncached: number; cache_read: number; cache_write: number; cache_write_5m: number; cache_write_1h: number; output_tokens: number; duration_ms: number; status: number; created_at: string };
  const us = (await readAll<U>((f, t) => sb.from("llm_usage_logs").select("model, action, env, input_uncached, cache_read, cache_write, cache_write_5m, cache_write_1h, output_tokens, duration_ms, status, created_at")
    .gte("created_at", usSince).in("action", ["brain_fresh", "brain_full", "brain_fresh_claude"]).order("created_at").range(f, t)))
    .filter((u) => u.status === 200 && !/^local|test|exam/i.test(u.env ?? ""));
  const envs: Record<string, number> = {}; for (const u of us) envs[u.env ?? "?"] = (envs[u.env ?? "?"] ?? 0) + 1;
  const usdOf = (u: U) => (u.model.startsWith("claude") ? claudeUsageUsd(u as never) : altUsageUsd(u as never));
  const n = us.length;
  const usd = us.reduce((a, u) => a + usdOf(u), 0);
  const inUnc = avg(us.map((u) => u.input_uncached)), out = avg(us.map((u) => u.output_tokens)), dur = avg(us.map((u) => u.duration_ms));
  const models: Record<string, number> = {}; for (const u of us) models[u.model] = (models[u.model] ?? 0) + 1;
  console.log(`\n本番のブレイン（${DAYS}日・${n}回・env ${JSON.stringify(envs)}・model ${JSON.stringify(models)}）: 合計 $${usd.toFixed(2)}・1回 $${(usd / Math.max(1, n)).toFixed(4)}・素の入力 ${Math.round(inUnc)} tok・出力 ${Math.round(out)} tok・時間 ${(dur / 1000).toFixed(1)}秒`);
  // 時間 ≈ a + b×素の入力 + c×出力（最小二乗）
  const X = us.map((u) => [1, (u.input_uncached ?? 0) + (u.cache_write ?? 0), u.output_tokens ?? 0]), y = us.map((u) => u.duration_ms ?? 0);
  const xtx = [0, 1, 2].map((i) => [0, 1, 2].map((j) => X.reduce((a, r) => a + r[i] * r[j], 0)));
  const xty = [0, 1, 2].map((i) => X.reduce((a, r, k) => a + r[i] * y[k], 0));
  const solve = (A: number[][], b: number[]) => { const M = A.map((r, i) => [...r, b[i]]); for (let i = 0; i < 3; i++) { let p = i; for (let k = i + 1; k < 3; k++) if (Math.abs(M[k][i]) > Math.abs(M[p][i])) p = k; [M[i], M[p]] = [M[p], M[i]]; for (let k = 0; k < 3; k++) if (k !== i) { const f = M[k][i] / M[i][i]; for (let j = i; j < 4; j++) M[k][j] -= f * M[i][j]; } } return M.map((r, i) => r[3] / r[i]); };
  const [, bIn] = n > 10 ? solve(xtx, xty) : [0, 0, 0];
  // 字→トークン（素の入力 ÷ 素の入力の字数 の比を、materials の userTotal の平均で近似）
  const tokPerChar = inUnc / Math.max(1, avg(withB.map((r) => r.blocks!.userTotal!)));
  const dropTok = easyDrop * Math.min(1.2, Math.max(0.4, tokPerChar));
  const usdPerInTok = (() => { const c = us.filter((u) => u.model.startsWith("claude")); const r = c.length ? c : us; const sumIn = r.reduce((a, u) => a + u.input_uncached, 0); const sumUsdIn = r.reduce((a, u) => a + usdOf({ ...u, cache_read: 0, cache_write: 0, cache_write_5m: 0, cache_write_1h: 0, output_tokens: 0 } as U), 0); return sumIn ? sumUsdIn / sumIn : 0; })();
  const sEasy = share("easy"), sHard = share("hard");
  const perCall = usd / Math.max(1, n);
  const saveEasy = dropTok * usdPerInTok;
  const extraHard = perCall * 1.2; // 2回目（割れた時だけ3回目・割れを2割と見る）
  console.log(`  1トーク ${tokPerChar.toFixed(2)} tok/字 → 慣れた番で 約${Math.round(dropTok)} tok 減・$${saveEasy.toFixed(4)}/番（素の入力の単価 $${(usdPerInTok * 1e6).toFixed(2)}/Mtok）・時間 約${((bIn * dropTok) / 1000).toFixed(2)}秒（入力1tokあたり ${(bIn).toFixed(3)}ms）`);
  console.log(`  全部の番にならすと: 速い道 −$${(saveEasy * sEasy).toFixed(4)}/番（慣れた ${pct(sEasy, 1)}）・じっくりの道の2回目 +$${(extraHard * sHard).toFixed(4)}/番（難しい ${pct(sHard, 1)}・2回目＋割れた2割の3回目）・時間 難しい番は +${(dur / 1000).toFixed(0)}〜${((2 * dur) / 1000).toFixed(0)}秒`);
  console.log(`  ${DAYS}日の呼び出し ${n}回で: 速い道 −$${(saveEasy * sEasy * n).toFixed(2)}・2回目 +$${(extraHard * sHard * n).toFixed(2)}（2回目を止める BRAIN_FAST_SLOW_SECOND=off なら速い道の分だけ）`);

  if (WRITE_PRIORS) {
    const pr = priorsOf(rows), base = asIsN(rows) / rows.length;
    const body = Object.keys(pr).sort().map((k) => `  ${JSON.stringify(k)}: { n: ${pr[k].n}, asIs: ${pr[k].asIs} },`).join("\n");
    writeFileSync("app/lib/brain-fast-slow-priors.ts", `// app/lib/brain-fast-slow-priors.ts — 返信の場面（reply-scene・お客様の文だけで決まる）ごとの「下書きがそのまま送られた」前例の表（自動で書く・手で直さない）
// 書く: npx tsx --env-file=.env.local scripts/audit-fast-slow.ts --write-priors（${new Date().toISOString().slice(0, 10)}・${rows.length}番）
// 中身は場面の名前と件数だけ（会話・お客様の情報は入らない）
export const BRAIN_FAST_SLOW_PRIOR_BASE = ${base.toFixed(3)};
export const BRAIN_FAST_SLOW_SCENE_PRIORS: Readonly<Record<string, { n: number; asIs: number }>> = {
${body}
};
`);
    console.log(`\n前例の表を書いた: ${Object.keys(pr).length}場面・全体のそのまま率 ${pct(asIsN(rows), rows.length)}`);
  }
}
main().catch((e) => { console.error(e); process.exit(1); });
