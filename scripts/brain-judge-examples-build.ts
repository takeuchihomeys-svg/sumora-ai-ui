// scripts/brain-judge-examples-build.ts — 見張りで外れた番から「ブレインの判断の手本」を作る（LLM なし・費用 0・本番 DB は読むだけ）
//
// 2026-10-13 竹内さんの承認（見張りの結果をブレインと試験に戻す・その2）。中身と使い方は app/lib/brain-judge-examples.ts の頭。
//   ・番: line_watch_turns の直近 --days（既定75）日。判定は今の版（evalWatchTurn・付け直しの前でも今の物差しで読む）で different かつ道の外れ（PATH_MISS_REASONS）
//   ・竹内さんの番（staff_writer=takeuchi）を主に、書いた人が分からない番（AIX を押しただけ）も入れる。従業員の番は場面ごとに足りない時だけ
//   ・外す: テストの会話・申込以降（場面の対象外・申込フォームを送った後）・申込の書類や個人の値を含む番・お客様の発言が無い番
//   ・伏せる: お客様の名前（全会話の表示名）・電話・メール（maskPII）
// 実行: npx tsx --env-file=.env.local scripts/brain-judge-examples-build.ts [--days=75] [--per-scene=40] [--write] [--show=5]
//   --write で app/lib/brain-judge-examples-data.ts を書き直す（既定は dry＝件数と見本だけ）
import { writeFileSync } from "node:fs";
import { createClient } from "@supabase/supabase-js";
import { isTestConversation } from "../app/lib/test-conversations";
import { evalWatchTurn, type WatchTurnInput } from "../app/lib/line-watch-turn-eval";
import { guardBackfillJudgement, BACKFILL_KEY } from "../app/lib/line-watch-backfill";
import { type WindowMsg, type WindowPress } from "../app/lib/line-watch-judge";
import { staffActsOf, STAFF_ACT_JA, APPLY_FORM_RE } from "../app/lib/customer-sim-shadow";
import { applicationMaterialReason } from "../app/lib/test-pii-guard";
import { maskPII } from "../app/lib/pii-mask";
import { resolveReplyScene, REPLY_SCENE_JA } from "../app/lib/reply-scene";
import { PATH_MISS_REASONS, describeActualMove, textFingerprint, type JudgeExample } from "../app/lib/brain-judge-examples";

const sb = createClient(process.env.NEXT_PUBLIC_SUPABASE_URL ?? "", process.env.SUPABASE_SERVICE_ROLE_KEY ?? process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY ?? "");
const arg = (k: string, d = "") => process.argv.find((a) => a.startsWith(`--${k}=`))?.slice(k.length + 3) ?? d;
const DAYS = Number(arg("days", "75"));
const PER_SCENE = Number(arg("per-scene", "40"));
const SHOW = Number(arg("show", "5"));
const WRITE = process.argv.includes("--write");
const OUT = "app/lib/brain-judge-examples-data.ts";
const DAY = 86_400_000, HOUR = 3_600_000;
const P = (s: string) => Date.parse(s);
const iso = (n: number) => new Date(n).toISOString();
// AIX の日本語（brain-core の AIX_LABEL_JP と同じ・brain-core は重いので写す）
const AIX_JA: Record<string, string> = {
  property_recommendation: "物件オススメ", property_send: "物件を送る", property_search: "物件を探す", viewing_invite: "内覧調整", application_push: "申込へ",
  property_check_result: "物件確認した", estimate_sheet: "見積書送る", meeting_place: "待ち合わせ場所", acknowledge_check: "確認した", followup_revive: "追客フォロー",
  condition_hearing: "条件ヒアリング", cost_explain: "初期費用を説明", cost_breakdown: "初期費用について", phone_call: "電話", guarantor_info: "保証会社について", zenryoku_support: "全力サポート",
};
const EMO_JA: Record<string, string> = {};
const STAGE_JA: Record<string, string> = { hearing: "ヒアリング", proposing: "提案中", viewing: "内覧", applying: "申込を検討", contracted: "成約" };

async function readAll<T>(q: (f: number, t: number) => PromiseLike<{ data: unknown; error: { message: string } | null }>): Promise<T[]> {
  const out: T[] = [];
  for (let i = 0; i < 2_000_000; i += 1000) { const r = await q(i, i + 999); if (r.error) throw new Error(r.error.message); const d = (r.data ?? []) as T[]; out.push(...d); if (d.length < 1000) break; }
  return out;
}

type Row = WatchTurnInput & { id: number; brain_check_pattern: string | null; decision_id: string | null; customer_last_at: string | null; verdict_detail: Record<string, unknown> | null };
type Msg = WindowMsg & { conversation_id: string };
type Press = WindowPress & { conversation_id: string };
type Dec = { id: string; conversation_id: string; created_at: string; analyzed_msg_ts: string | null; intent: string | null; digest: Record<string, unknown> | null };

(async () => {
  const nowMs = Date.now();
  const rows = (await readAll<Row>((f, t) => sb.from("line_watch_turns").select("id, conversation_id, customer_turn_at, customer_last_at, conv_status, draft_last, draft_last_at, draft_first, draft_first_at, draft_versions, draft_sentinel, brain_action, brain_check_pattern, brain_reply_mode, brain_versions, tpo_label, decision_id, verdict_detail")
    .gte("customer_turn_at", iso(nowMs - DAYS * DAY)).order("customer_turn_at").order("id").range(f, t))).filter((r) => !isTestConversation(r.conversation_id));
  const convIds = [...new Set(rows.map((r) => r.conversation_id))];
  const since = iso(Math.min(...rows.map((t) => P(t.customer_turn_at))) - HOUR);
  const msgs: Msg[] = [], presses: Press[] = [], decs: Dec[] = [];
  for (let i = 0; i < convIds.length; i += 50) {
    const chunk = convIds.slice(i, i + 50);
    // 指紋（会話の早い発言）と申込以降の見分けのため、メッセージは会話の最初から読む
    msgs.push(...await readAll<Msg>((f, t) => sb.from("messages").select("conversation_id, sender, created_at, text, is_aix_generated").in("conversation_id", chunk).order("created_at").order("id").range(f, t)));
    presses.push(...await readAll<Press>((f, t) => sb.from("aix_usage_logs").select("conversation_id, aix_type, check_pattern, created_at").in("conversation_id", chunk).not("aix_type", "is", null).order("created_at").order("id").range(f, t)));
    decs.push(...await readAll<Dec>((f, t) => sb.from("brain_decision_logs").select("id, conversation_id, created_at, analyzed_msg_ts, intent:digest->>intent, digest").in("conversation_id", chunk).gte("created_at", since).order("created_at").order("id").range(f, t)));
  }
  const names = ((await sb.from("conversations").select("customer_name").limit(5000)).data ?? []).map((r: { customer_name: string | null }) => (r.customer_name ?? "").trim()).filter((s) => s.length >= 2);
  const group = <T extends { conversation_id: string }>(xs: T[]) => { const m = new Map<string, T[]>(); for (const x of xs) { if (!m.has(x.conversation_id)) m.set(x.conversation_id, []); m.get(x.conversation_id)!.push(x); } return m; };
  const mBy = group(msgs), pBy = group(presses), dBy = group(decs);
  const decById = new Map(decs.map((d) => [d.id, d]));
  const mask = (s: string) => maskPII(s, names).replace(/https?:\/\/\S+/g, "〈URL〉").replace(/\s+/g, " ").trim();

  const skip: Record<string, number> = {};
  const sk = (k: string) => { skip[k] = (skip[k] ?? 0) + 1; };
  const cands: JudgeExample[] = [];
  for (const t of rows) {
    const mm = mBy.get(t.conversation_id) ?? [];
    const ps = pBy.get(t.conversation_id) ?? [];
    const ev = evalWatchTurn(t, { msgs: mm.filter((m) => P(m.created_at) >= P(t.customer_turn_at) - 4 * DAY), presses: ps, decisions: dBy.get(t.conversation_id) ?? [], nowMs });
    let j = ev.judgement;
    const old = t.verdict_detail ?? {};
    if (old[BACKFILL_KEY]) j = guardBackfillJudgement(j, { hasDraft: !!old.bf_example || !!old.bf_draft_absent, hasBrain: (t.brain_versions ?? 0) > 0 });
    if (j.verdict !== "different" || !PATH_MISS_REASONS.has(j.detail.reason)) { sk("道の外れでない"); continue; }
    if (ev.scene.path === "対象外") { sk("申込以降"); continue; }
    const custLast = ev.window.customerLastAt;
    const before = mm.filter((m) => P(m.created_at) <= P(custLast));
    if (before.some((m) => m.sender !== "customer" && APPLY_FORM_RE.test(m.text ?? ""))) { sk("申込以降（申込フォームの後）"); continue; }
    const custMsgs = mm.filter((m) => m.sender === "customer" && P(m.created_at) >= P(t.customer_turn_at) && P(m.created_at) <= P(custLast));
    const custText = custMsgs.map((m) => m.text ?? "").join("\n").trim();
    if (!custText) { sk("お客様の発言なし"); continue; }
    const burstTexts = ev.window.texts.filter((x) => x.burst).map((x) => x.text);
    if ([...custMsgs.map((m) => m.text ?? ""), ...burstTexts].some((x) => applicationMaterialReason(x))) { sk("申込の書類・個人の値"); continue; }
    const writer = (j.detail.staff_writer === "takeuchi" ? "takeuchi" : j.detail.staff_writer === "employee" ? "employee" : "unknown") as JudgeExample["writer"];
    // その時の状況: 段階・気持ち・指す物件の有無（ブレインの digest）＋直前の AIX（台帳）
    const dg = (t.decision_id ? decById.get(t.decision_id)?.digest : null) ?? null;
    const prevAix = ps.filter((p) => P(p.created_at) < P(t.customer_turn_at)).slice(-3).map((p) => AIX_JA[String(p.aix_type)] ?? p.aix_type);
    const sentN = ps.filter((p) => P(p.created_at) < P(t.customer_turn_at) && /^property_(send|recommendation)$/.test(String(p.aix_type))).length;
    const estN = ps.filter((p) => P(p.created_at) < P(t.customer_turn_at) && p.aix_type === "estimate_sheet").length;
    const state = [
      dg?.cp ? `段階 ${STAGE_JA[String(dg.cp)] ?? dg.cp}` : t.conv_status ? `段階 ${STAGE_JA[t.conv_status] ?? t.conv_status}` : "",
      dg?.emo ? `気持ち ${EMO_JA[String(dg.emo)] ?? dg.emo}` : "",
      dg?.prop ? "指す物件あり" : "",
      sentN ? `物件の送付 ${sentN}回` : "物件の送付なし",
      estN ? `見積書 ${estN}回送付済み` : "",
      prevAix.length ? `直前の AIX ${prevAix.join("→")}` : "",
    ].filter(Boolean).join("・");
    const brain = ev.scene.path === "AIX" ? `AIX【${AIX_JA[String(t.brain_action)] ?? t.brain_action ?? "種類なし"}${t.brain_check_pattern ? `／${t.brain_check_pattern}` : ""}】` : `返信${(j.detail.draft_acts ?? []).length ? `（${(j.detail.draft_acts ?? []).map((a) => STAFF_ACT_JA[a] ?? a).join("・")}）` : ""}`;
    const actual = describeActualMove({
      burstPress: ev.window.presses.filter((p) => p.burst).map((p) => ({ aix_type: p.aix_type, check_pattern: p.check_pattern })),
      laterPress: ev.window.presses.filter((p) => !p.burst).map((p) => ({ aix_type: p.aix_type })),
      staffFacts: j.detail.staff_fact,
      staffActs: [...staffActsOf(burstTexts.join("\n"))],
      actJa: STAFF_ACT_JA as Record<string, string>, aixJa: AIX_JA,
    });
    // 指紋: 会話の最初の4通＋番の直前の20通（試験の写しは直前の会話だけ持つ＝直前の通で合わせる）
    const custBefore = mm.filter((m) => m.sender === "customer" && P(m.created_at) < P(t.customer_turn_at));
    const fp = [...new Set([...custBefore.slice(0, 4), ...custBefore.slice(-20)].map((m) => textFingerprint(mask(m.text ?? ""))).filter((x): x is string => !!x))];
    cands.push({
      conv: t.conversation_id, at: t.customer_turn_at, scene: resolveReplyScene({ customerText: custText }).scene,
      customer: mask(custText).slice(0, 120), state, brain, actual, reason: j.detail.reason, writer, fp,
    });
  }
  // 場面ごとに: 竹内さん → 分からない → 従業員 の順・新しい順で PER_SCENE まで
  const rank = { takeuchi: 0, unknown: 1, employee: 2 } as const;
  const out: JudgeExample[] = [];
  const byScene = new Map<string, JudgeExample[]>();
  for (const c of cands) { if (!byScene.has(c.scene)) byScene.set(c.scene, []); byScene.get(c.scene)!.push(c); }
  for (const [, xs] of byScene) out.push(...xs.sort((a, b) => rank[a.writer] - rank[b.writer] || P(b.at) - P(a.at)).slice(0, PER_SCENE));
  out.sort((a, b) => a.scene.localeCompare(b.scene) || P(b.at) - P(a.at));

  console.log(`# 判断の手本（見張りの道の外れ）直近 ${DAYS}日｜番 ${rows.length}・候補 ${cands.length}・入れる ${out.length}`);
  console.log(`外した: ${Object.entries(skip).map(([k, v]) => `${k} ${v}`).join("・")}`);
  for (const [sc, xs] of [...byScene].sort()) {
    const kept = out.filter((x) => x.scene === sc);
    console.log(`  ${REPLY_SCENE_JA[sc as keyof typeof REPLY_SCENE_JA] ?? sc}: 候補 ${xs.length}・入れる ${kept.length}（竹内さん ${kept.filter((x) => x.writer === "takeuchi").length}・分からない ${kept.filter((x) => x.writer === "unknown").length}・従業員 ${kept.filter((x) => x.writer === "employee").length}）｜理由 ${[...new Set(kept.map((x) => x.reason))].map((r) => `${r} ${kept.filter((x) => x.reason === r).length}`).join("・")}`);
  }
  for (const e of out.filter((x) => x.writer === "takeuchi").slice(0, SHOW)) console.log(`--- ${e.at.slice(0, 16)} ${e.conv.slice(0, 8)} [${e.scene}] ${e.reason}\n    客「${e.customer}」\n    状況: ${e.state}\n    AI: ${e.brain} → 実際: ${e.actual}`);
  if (!WRITE) { console.log(`\n（dry: ${OUT} は書いていない。--write で書く）`); return; }
  const body = `// app/lib/brain-judge-examples-data.ts — 自動で作る（scripts/brain-judge-examples-build.ts --write）。手で直さない。
// 見張りで道が外れた番（返信か AIX か・AIX の種類）の、その時の状況と竹内さんの実際の一手。名前・電話・メールは伏せた。申込以降・テスト会話は入れない。
// 作った日 ${iso(nowMs).slice(0, 10)}・直近 ${DAYS}日・${out.length}件
import type { JudgeExample } from "./brain-judge-examples";
export const JUDGE_EXAMPLES_BUILT_AT = ${JSON.stringify(iso(nowMs))};
export const JUDGE_EXAMPLES: ReadonlyArray<JudgeExample> = ${JSON.stringify(out, null, 0).replace(/\},\{/g, "},\n  {")};
`;
  writeFileSync(OUT, body);
  console.log(`\n書いた: ${OUT}（${out.length}件・${body.length}字）`);
})().catch((e) => { console.error(e); process.exit(1); });
