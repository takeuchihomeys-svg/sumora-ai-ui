// scripts/audit-draft-confidence.ts — 下書きの自信（app/lib/draft-confidence.ts）を過去の本物の下書きで試す（読むだけ・書き込みなし・LLM なし・費用0）
//
// 材料: 本番の見張り line_watch_turns（その番の下書き・最終チェック・ブレインの判断・場面・スタッフが実際に送った文と押した AIX）
//       ＋ messages（この番のお客様の発言・材料の会話）＋ brain_decision_logs.digest（LLM の判断と規則の後の判断・物件の見立て・追加の調査）
// 答え（スタッフが実際にした事・返事のまとまりの中）:
//   as_is   … 下書きをそのまま送った（近さ 0.9 以上＝edit-diff の none/tiny）
//   light   … 少し直した（0.6〜0.9）
//   heavy   … 大きく直した・書き直した（0.6 未満）
//   aix     … 文を送らず AIX を押した（下書きを使わなかった）
//   （何もしなかった番・申込以降の番・下書きの無い番・試験の会話は数えない）
// 試し方: 時刻で古い 60% と新しい 40% に分ける。場面の前例の表は古い半分だけで作り、新しい半分で段ごとのそのまま率を見る（前例の表の答えの漏れを防ぐ）。
//
// 実行: npx tsx --env-file=.env.local scripts/audit-draft-confidence.ts [--samples=4] [--write-priors]
//   --write-priors … 全部の番で場面の前例の表（app/lib/draft-confidence-priors.ts）を書き直す（ファイルを書くだけ・DB は読むだけ）
//   例は名前・番号を伏せて（maskPII）先頭だけ出す
import { createClient } from "@supabase/supabase-js";
import { writeFileSync } from "node:fs";
import { pickJudgeDraft, cleanDraft } from "../app/lib/line-watch-judge";
import { classifyEdit } from "../app/lib/edit-diff";
import { isTestConversation } from "../app/lib/test-conversations";
import { maskPII } from "../app/lib/pii-mask";
import {
  scoreDraftConfidence, confidenceSignals, bandOf, CONFIDENCE_WEIGHTS, CONFIDENCE_CODE_JA,
  type ConfidenceInput, type ConfidenceCode, type ConfidenceBand,
} from "../app/lib/draft-confidence";

const arg = (k: string, d: string) => process.argv.find((a) => a.startsWith(`--${k}=`))?.slice(k.length + 3) ?? d;
const SAMPLES = Number(arg("samples", "3"));
const WRITE_PRIORS = process.argv.includes("--write-priors");
/** 重みの当てはめの答え: agree（中身が合った・既定）か asis（そのまま送った） */
const FIT_TARGET: "agree" | "asis" = arg("fit-target", "agree") === "asis" ? "asis" : "agree";
const SHOW_FIT = process.argv.includes("--fit");

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
  decision_id: string | null; verdict: string | null; verdict_detail: { reason?: string } | null;
};
type Msg = { conversation_id: string; sender: string; created_at: string; text: string | null };
type Dec = { id: string; conversation_id: string; created_at: string; digest: Record<string, unknown> | null };
type Outcome = "as_is" | "light" | "heavy" | "aix";
/** agree … 見張りの判定（line-watch-judge・決まった計算）で「そのまま／同じ事」＝中身が合っていた（na は null） */
type Row = { at: string; cid: string; scene: string; outcome: Outcome; agree: boolean | null; input: ConfidenceInput; draft: string; sent: string };

const P = Date.parse;
const pct = (a: number, b: number) => (b ? `${((100 * a) / b).toFixed(0)}%` : "-");

function outcomeOf(t: Turn, draft: string): { outcome: Outcome; sent: string } | null {
  const texts = (t.staff_texts ?? []).filter((x) => x.burst !== false && (x.text ?? "").trim());
  if (texts.length) {
    // 下書きを1通として送り、続けて別の文（物件の一覧 等）も送る番があるので、1通ずつ比べて一番近い物で決める
    let best = String(texts[0].text), bestSim = -1;
    for (const x of texts) { const sim = classifyEdit(draft, String(x.text)).sim; if (sim > bestSim) { bestSim = sim; best = String(x.text); } }
    const d = classifyEdit(draft, best);
    return { outcome: d.amount === "none" || d.amount === "tiny" ? "as_is" : d.amount === "small" ? "light" : "heavy", sent: best };
  }
  if ((t.staff_aix ?? []).some((a) => a.burst !== false)) return { outcome: "aix", sent: "" };
  return null;
}

function finalCheckOf(fc: Record<string, unknown> | null): ConfidenceInput["finalCheck"] {
  if (!fc) return null;
  const issues = Array.isArray(fc.issues) ? (fc.issues as Array<{ code?: string; severity?: string }>) : [];
  return {
    ok: typeof fc.ok === "boolean" ? fc.ok : null,
    issues,
    revisionExhausted: fc.revision_exhausted === true,
    regenCount: typeof fc.regen_count === "number" ? fc.regen_count : null,
    preIssues: Array.isArray(fc.pre) ? (fc.pre as string[]) : null,
  };
}

/** 点で並べた時に「そのまま送られた」が上に来る確率（AUC・同点は半分） */
function auc(rows: Array<{ s: number; y: boolean }>): number {
  const pos = rows.filter((r) => r.y).map((r) => r.s), neg = rows.filter((r) => !r.y).map((r) => r.s);
  if (!pos.length || !neg.length) return NaN;
  let w = 0;
  for (const p of pos) for (const n of neg) w += p > n ? 1 : p === n ? 0.5 : 0;
  return w / (pos.length * neg.length);
}

async function main() {
  const turns = await readAll<Turn>((f, t) => sb.from("line_watch_turns")
    .select("conversation_id, customer_turn_at, customer_last_at, conv_status, draft_first, draft_first_at, draft_last, draft_versions, brain_action, brain_reply_mode, scene_key, final_check, staff_texts, staff_aix, decision_id, verdict, verdict_detail")
    .order("customer_turn_at").order("id").range(f, t));
  const since = new Date(Math.min(...turns.map((t) => P(t.customer_turn_at))) - 10 * 86_400_000).toISOString();
  const msgs = await readAll<Msg>((f, t) => sb.from("messages").select("conversation_id, sender, created_at, text").gte("created_at", since).order("created_at").order("id").range(f, t));
  const decs = await readAll<Dec>((f, t) => sb.from("brain_decision_logs").select("id, conversation_id, created_at, digest").gte("created_at", since).order("created_at").order("id").range(f, t));
  console.log(`見張りの番 ${turns.length}・messages ${msgs.length}・判断 ${decs.length}`);

  const mBy = new Map<string, Msg[]>();
  for (const m of msgs) { if (!mBy.has(m.conversation_id)) mBy.set(m.conversation_id, []); mBy.get(m.conversation_id)!.push(m); }
  const dById = new Map(decs.map((d) => [d.id, d]));
  const dBy = new Map<string, Dec[]>();
  for (const d of decs) { if (!dBy.has(d.conversation_id)) dBy.set(d.conversation_id, []); dBy.get(d.conversation_id)!.push(d); }

  const skip: Record<string, number> = {};
  const bump = (k: string) => { skip[k] = (skip[k] ?? 0) + 1; };
  const rows: Row[] = [];
  for (const t of turns) {
    if (isTestConversation(t.conversation_id)) { bump("試験の会話"); continue; }
    if (t.verdict_detail?.reason === "out_of_scope" || (t.scene_key ?? "").startsWith("対象外")) { bump("申込以降"); continue; }
    const pick = pickJudgeDraft(t);
    if (pick.src !== "last" && pick.src !== "first") { bump("下書きなし・古い下書き"); continue; }
    const draft = cleanDraft(pick.draft).text;
    if (!draft) { bump("下書きなし・古い下書き"); continue; }
    const oc = outcomeOf(t, draft);
    if (!oc) { bump("スタッフが何もしなかった"); continue; }
    const list = mBy.get(t.conversation_id) ?? [];
    const lastAt = P(t.customer_last_at ?? t.customer_turn_at);
    const turnAt = P(t.customer_turn_at);
    const custText = list.filter((m) => m.sender === "customer" && P(m.created_at) >= turnAt - 1000 && P(m.created_at) <= lastAt + 1000).map((m) => m.text ?? "").join("\n");
    const before = list.filter((m) => P(m.created_at) < turnAt);
    const ground = before.slice(-30).map((m) => m.text ?? "").join("\n");
    const firstContact = !before.some((m) => m.sender !== "customer");
    let dec = t.decision_id ? dById.get(t.decision_id) ?? null : null;
    if (!dec) dec = (dBy.get(t.conversation_id) ?? []).filter((d) => P(d.created_at) >= turnAt - 1000 && P(d.created_at) <= lastAt + 15 * 60_000).pop() ?? null;
    const g = dec?.digest ?? null;
    const str = (v: unknown) => (typeof v === "string" ? v : null);
    const input: ConfidenceInput = {
      draft, customerText: custText, groundText: ground, convStatus: t.conv_status,
      finalCheck: finalCheckOf(t.final_check),
      brain: {
        replyMode: t.brain_reply_mode, action: t.brain_action,
        // digest の la（LLM の AIX）は 10/09 から。無い行は規則の食い違いを数えない（action と同じ値にする）
        llmAction: g && "la" in g ? str(g.la) : t.brain_action,
        property: g ? str(g.prop) : null, llmProperty: g ? str(g.lp) : null,
        questions: g && Array.isArray(g.q) ? (g.q as unknown[]).length : null,
        deepCheck: !!(g && g.dc),
      },
      isFirstContact: firstContact,
      sceneKey: t.scene_key,
    };
    rows.push({ at: t.customer_turn_at, cid: t.conversation_id, scene: t.scene_key ?? "", outcome: oc.outcome, agree: t.verdict && t.verdict !== "na" ? t.verdict === "same" || t.verdict === "same_meaning" : null, input, draft, sent: oc.sent });
  }
  console.log(`数える番 ${rows.length}（除いた: ${Object.entries(skip).map(([k, v]) => `${k} ${v}`).join("・")}）`);
  if (!rows.length) return;

  rows.sort((a, b) => P(a.at) - P(b.at));
  const cut = Math.floor(rows.length * 0.6);
  const train = rows.slice(0, cut), test = rows.slice(cut);
  console.log(`古い半分 ${train.length}（〜${train[train.length - 1].at.slice(0, 10)}）・新しい半分 ${test.length}（${test[0].at.slice(0, 10)}〜${test[test.length - 1].at.slice(0, 10)}）`);

  const priorsOf = (rs: Row[]) => {
    const p: Record<string, { n: number; asIs: number }> = {};
    for (const r of rs) { if (!r.scene) continue; p[r.scene] ??= { n: 0, asIs: 0 }; p[r.scene].n++; if (r.outcome === "as_is") p[r.scene].asIs++; }
    return p;
  };
  const trainPriors = priorsOf(train);
  const trainBase = train.filter((r) => r.outcome === "as_is").length / train.length;

  // ── 印ごと（古い半分・新しい半分） ──
  const sigOf = (r: Row) => new Set(confidenceSignals({ ...r.input, priors: trainPriors, priorBase: trainBase }).map((s) => s.code));
  const sigs = new Map<Row, Set<ConfidenceCode>>(rows.map((r) => [r, sigOf(r)]));
  const asIs = (rs: Row[]) => rs.filter((r) => r.outcome === "as_is").length;
  const agreeRate = (rs: Row[]) => { const k = rs.filter((r) => r.agree !== null); return pct(k.filter((r) => r.agree).length, k.length); };
  // 重みの当てはめ（古い半分だけ）: 印が付いた番の「うまくいった」の見込み比（対数）×20。
  //   件数が少ない印（15件未満）は決めた重みのまま（会社の事実・センシティブ等は少なくても重い＝作り話・圧の型は1通でも外せない）
  const good = (r: Row) => (FIT_TARGET === "asis" ? r.outcome === "as_is" : r.agree === true);
  const fitPool = train.filter((r) => FIT_TARGET === "asis" || r.agree !== null);
  const fitted: Record<ConfidenceCode, number> = { ...CONFIDENCE_WEIGHTS };
  {
    const G = fitPool.filter(good).length, B = fitPool.length - G;
    for (const code of Object.keys(CONFIDENCE_WEIGHTS) as ConfidenceCode[]) {
      const on = fitPool.filter((r) => sigs.get(r)!.has(code));
      if (on.length < 15) continue;
      const g = on.filter(good).length, b = on.length - g;
      const lor = Math.log(((g + 1) / (b + 1)) / ((G + 1) / (B + 1)));
      fitted[code] = Math.max(-15, Math.min(35, Math.round(-20 * lor)));
    }
  }
  console.log(`\n全体: そのまま率 古い ${pct(asIs(train), train.length)}・新しい ${pct(asIs(test), test.length)}／中身が合った率 古い ${agreeRate(train)}・新しい ${agreeRate(test)}`);
  console.log(`\n印ごと（件数・そのまま率 古い/新しい・中身が合った率 古い/新しい・付かない番のそのまま率・重み 今→当てはめ(${FIT_TARGET})）`);
  for (const code of Object.keys(CONFIDENCE_WEIGHTS) as ConfidenceCode[]) {
    const on = (rs: Row[]) => rs.filter((r) => sigs.get(r)!.has(code));
    const a = on(train), b = on(test);
    if (!a.length && !b.length) continue;
    const offAll = rows.filter((r) => !sigs.get(r)!.has(code));
    console.log(`  ${code.padEnd(20)} ${String(a.length + b.length).padStart(4)}件  ${pct(asIs(a), a.length).padStart(4)} / ${pct(asIs(b), b.length).padStart(4)}  合った ${agreeRate(a).padStart(4)} / ${agreeRate(b).padStart(4)}  （無し ${pct(asIs(offAll), offAll.length)}）  ${CONFIDENCE_WEIGHTS[code]}→${fitted[code]}  ${CONFIDENCE_CODE_JA[code]}`);
  }

  // ── 段ごと ──
  const scoreWith = (w: Record<ConfidenceCode, number>) => rows.map((r) => ({ r, c: scoreDraftConfidence({ ...r.input, priors: trainPriors, priorBase: trainBase }, w) }));
  type Scored = ReturnType<typeof scoreWith>;
  const show = (label: string, list: Scored) => {
    const ag = list.filter((x) => x.r.agree !== null);
    console.log(`\n${label}（${list.length}番）: AUC そのまま ${auc(list.map((x) => ({ s: x.c.score, y: x.r.outcome === "as_is" }))).toFixed(3)}・中身が合った ${auc(ag.map((x) => ({ s: x.c.score, y: !!x.r.agree }))).toFixed(3)}`);
    for (const band of ["high", "mid", "low"] as ConfidenceBand[]) {
      const g = list.filter((x) => x.c.band === band);
      const n = g.length, k = (o: Outcome) => g.filter((x) => x.r.outcome === o).length;
      const ga = g.filter((x) => x.r.agree !== null);
      console.log(`  ${band.padEnd(4)} ${String(n).padStart(4)}番（${pct(n, list.length).padStart(4)}）  そのまま ${pct(k("as_is"), n).padStart(4)}・少し直す ${pct(k("light"), n).padStart(4)}・大きく直す ${pct(k("heavy"), n).padStart(4)}・AIX へ ${pct(k("aix"), n).padStart(4)}｜中身が合った ${pct(ga.filter((x) => x.r.agree).length, ga.length)}`);
    }
    const deciles: string[] = [];
    for (let lo = 0; lo <= 90; lo += 10) {
      const g = list.filter((x) => x.c.score >= lo && x.c.score < lo + 10 + (lo === 90 ? 1 : 0));
      if (g.length) deciles.push(`${lo}-${lo + 9}: ${pct(g.filter((x) => x.r.outcome === "as_is").length, g.length)}(${g.length})`);
    }
    console.log(`  点の刻み（そのまま率）: ${deciles.join("  ")}`);
  };
  const testSet = new Set(test);
  const scored = scoreWith(CONFIDENCE_WEIGHTS);
  show("今の重み・新しい半分（試し）", scored.filter((x) => testSet.has(x.r)));
  show("今の重み・全部", scored);
  if (SHOW_FIT) {
    show("当てはめた重み・新しい半分（試し）", scoreWith(fitted).filter((x) => testSet.has(x.r)));
    console.log(`\n当てはめた重み（${FIT_TARGET}）: ${JSON.stringify(fitted)}`);
  }

  // ── 例（伏せて・先頭だけ） ──
  if (SAMPLES > 0) {
    const testScored = scored.filter((x) => testSet.has(x.r));
    const ex = (label: string, list: Scored) => {
      console.log(`\n例: ${label}`);
      for (const x of list.slice(0, SAMPLES)) {
        console.log(`  - ${x.r.at.slice(0, 10)} ${x.r.scene} 点${x.c.score} 理由: ${x.c.reasons.filter((y) => y.delta).map((y) => y.code).join(",") || "なし"}`);
        console.log(`    下書き: ${maskPII(x.r.draft).replace(/\n+/g, " ⏎ ").slice(0, 90)}`);
        if (x.r.sent) console.log(`    送った: ${maskPII(x.r.sent).replace(/\n+/g, " ⏎ ").slice(0, 90)}`);
      }
    };
    ex("自信 高 なのに大きく直された・AIX へ", testScored.filter((x) => x.c.band === "high" && (x.r.outcome === "heavy" || x.r.outcome === "aix")));
    ex("自信 低 なのにそのまま送られた", testScored.filter((x) => x.c.band === "low" && x.r.outcome === "as_is"));
  }

  if (WRITE_PRIORS) {
    const all = priorsOf(rows);
    const base = asIs(rows) / rows.length;
    const keys = Object.keys(all).sort();
    const body = keys.map((k) => `  ${JSON.stringify(k)}: { n: ${all[k].n}, asIs: ${all[k].asIs} },`).join("\n");
    const src = `// app/lib/draft-confidence-priors.ts — 場面ごとの「下書きがそのまま送られた」前例の表（自動で書く・手で直さない）
// 書く: npx tsx --env-file=.env.local scripts/audit-draft-confidence.ts --write-priors（${new Date().toISOString().slice(0, 10)}・${rows.length}番）
// 中身は場面の鍵（line-watch-turn sceneKeyOf）と件数だけ（会話・お客様の情報は入らない）
export const DRAFT_CONFIDENCE_PRIOR_BASE = ${base.toFixed(3)};
export const DRAFT_CONFIDENCE_SCENE_PRIORS: Readonly<Record<string, { n: number; asIs: number }>> = {
${body}
};
`;
    writeFileSync("app/lib/draft-confidence-priors.ts", src);
    console.log(`\n前例の表を書いた: ${keys.length}場面・全体のそのまま率 ${pct(asIs(rows), rows.length)}`);
  }
  void bandOf;
}

main().catch((e) => { console.error(e); process.exit(1); });
