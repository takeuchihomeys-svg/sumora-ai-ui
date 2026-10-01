// scripts/audit-ack-check-retire.ts
// 実行: npx tsx --env-file=.env.local scripts/audit-ack-check-retire.ts      （DAYS=150 既定・読み取りのみ・何も書かない）
//       DUMP=1 …… 確認します の判断を1件ずつ表示
//
// 2026-10-01 竹内「確認します あまり使わないので、いきなり物件確認したで大丈夫」
//   A. ブレインが 確認します（acknowledge_check）を出した判断（場面・出どころ別）と、その後スタッフが押した AIX（生の種類）
//   B. 一致率: normalizeAixForMatch が 確認します＝物件確認した を同一視していた時（旧）と、別に数える時（新）の比較
//   C. 確認します の押下そのもの（全期間・場面）
//   D. 確認します の判断に今の補正（customer-property-inquiry）を当てると、何件が 物件確認した／見積書送る に変わるか・その後スタッフが押した AIX
import { createClient } from "@supabase/supabase-js";
import { pairBrainDecisions, type BrainDecisionRow, type AixPressRow } from "../app/lib/brain-aix-feedback";
import { isTestConversation } from "../app/lib/test-conversations";
import { correctCustomerPropertyInquiryAix } from "../app/lib/customer-property-inquiry";

const sb = createClient(process.env.NEXT_PUBLIC_SUPABASE_URL ?? "", process.env.SUPABASE_SERVICE_ROLE_KEY ?? process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY ?? "");
const DAYS = Number(process.env.DAYS ?? 150);
const DUMP = process.env.DUMP === "1";
const SINCE = new Date(Date.now() - DAYS * 86400_000).toISOString();

async function pageAll<T>(q: (from: number, to: number) => PromiseLike<{ data: T[] | null; error: { message: string } | null }>): Promise<T[]> {
  const out: T[] = [];
  for (let p = 0; p < 300; p++) { const { data, error } = await q(p * 1000, p * 1000 + 999); if (error) throw new Error(error.message); const r = data ?? []; out.push(...r); if (r.length < 1000) break; }
  return out;
}
const tally = (m: Map<string, number>, k: string) => m.set(k, (m.get(k) ?? 0) + 1);
const show = (title: string, m: Map<string, number>) => { console.log(title); for (const [k, v] of [...m].sort((a, b) => b[1] - a[1])) console.log(`   ${k}: ${v}`); };
const sceneOf = (s: string | null | undefined) => { try { return (JSON.parse(s ?? "null") as { scene?: string } | null)?.scene ?? "(場面なし)"; } catch { return "(場面なし)"; } };

/** 旧の同一視（10/01 まで） */
const normOld = (a: string | null | undefined) => { const s = (a ?? "").trim(); return s === "acknowledge_check" ? "property_check_result" : s; };
const normNew = (a: string | null | undefined) => (a ?? "").trim();

async function main() {
  type Dec = BrainDecisionRow & { analyzed_msg_ts?: string | null };
  const decs = (await pageAll<Dec>((f, t) => sb.from("brain_decision_logs").select("id, conversation_id, created_at, suggested_action, suggested_check_pattern, decision_source, scene_evidence").gte("created_at", SINCE).order("created_at").range(f, t)))
    .filter((d) => !isTestConversation(d.conversation_id));
  const presses = (await pageAll<AixPressRow>((f, t) => sb.from("aix_usage_logs").select("conversation_id, aix_type, check_pattern, created_at").gte("created_at", SINCE).not("aix_type", "is", null).order("created_at").range(f, t)))
    .filter((p) => !isTestConversation(p.conversation_id));
  const pairs = pairBrainDecisions(decs, presses).filter((p) => !p.pending);

  // ── A ──
  const ack = pairs.filter((p) => p.decision.suggested_action === "acknowledge_check");
  const byScene = new Map<string, number>(), bySrc = new Map<string, number>(), next = new Map<string, number>(), nextByScene = new Map<string, number>();
  for (const p of ack) {
    const sc = sceneOf(p.decision.scene_evidence);
    tally(byScene, sc);
    tally(bySrc, p.decision.decision_source ?? "(null)");
    const n = p.press?.aix_type ?? "(押されず・文で返した)";
    tally(next, n);
    tally(nextByScene, `${sc} → ${n}`);
  }
  console.log(`\n== A. ブレインが 確認します を出した判断（${DAYS}日・テスト会話除く・判定済み） ${ack.length}件 ==`);
  show("場面", byScene);
  show("出どころ", bySrc);
  show("24時間以内（次の判断まで）にスタッフが最初に押した AIX", next);
  show("場面 → 押した AIX", nextByScene);
  if (DUMP) for (const p of ack) console.log(`  ${p.decision.created_at.slice(0, 16)} ${p.decision.conversation_id.slice(0, 8)} ${sceneOf(p.decision.scene_evidence)} ${p.decision.decision_source} → ${p.press?.aix_type ?? "-"}`);

  // ── B ──
  const rate = (norm: (a: string | null | undefined) => string) => {
    let pressed = 0, matched = 0, pcrPressed = 0, pcrMatched = 0, ackPressed = 0, ackMatched = 0;
    for (const p of pairs) {
      const a = norm(p.decision.suggested_action);
      if (!a || !p.press) continue;
      pressed++;
      const ok = norm(p.press.aix_type) === a;
      if (ok) matched++;
      if (p.decision.suggested_action === "property_check_result") { pcrPressed++; if (ok) pcrMatched++; }
      if (p.decision.suggested_action === "acknowledge_check") { ackPressed++; if (ok) ackMatched++; }
    }
    const pct = (a: number, b: number) => (b ? `${(100 * a / b).toFixed(1)}%` : "-");
    return `全体（AIX あり・押された判断）${matched}/${pressed} = ${pct(matched, pressed)}｜ブレイン=物件確認した ${pcrMatched}/${pcrPressed} = ${pct(pcrMatched, pcrPressed)}｜ブレイン=確認します ${ackMatched}/${ackPressed} = ${pct(ackMatched, ackPressed)}`;
  };
  console.log(`\n== B. 一致率（判断の総数 ${pairs.length}） ==`);
  console.log(`  旧（確認します＝物件確認した）: ${rate(normOld)}`);
  console.log(`  新（別に数える）            : ${rate(normNew)}`);

  // ── C ──
  const ackPress = presses.filter((p) => p.aix_type === "acknowledge_check");
  console.log(`\n== C. スタッフが 確認します を押した回（${DAYS}日） ${ackPress.length}回 ==`);
  for (const p of ackPress) console.log(`   ${p.created_at.slice(0, 16)} ${p.conversation_id.slice(0, 8)}`);

  // ── D ──
  type Msg = { conversation_id: string; sender: string; text: string | null; created_at: string };
  const convs = [...new Set(ack.map((p) => p.decision.conversation_id))];
  const msgs: Msg[] = [];
  for (let i = 0; i < convs.length; i += 60) {
    const ids = convs.slice(i, i + 60);
    msgs.push(...await pageAll<Msg>((f, t) => sb.from("messages").select("conversation_id, sender, text, created_at").in("conversation_id", ids).gte("created_at", new Date(Date.parse(SINCE) - 7 * 86400_000).toISOString()).order("created_at").range(f, t)));
  }
  const changed = new Map<string, number>(), kept = new Map<string, number>();
  for (const p of ack) {
    const at = Date.parse(p.decision.created_at) + 60_000;
    const before = msgs.filter((m) => m.conversation_id === p.decision.conversation_id && Date.parse(m.created_at) <= at);
    const turn: string[] = [];
    for (let i = before.length - 1; i >= 0 && before[i].sender === "customer"; i--) { const t = (before[i].text ?? "").trim(); if (t && !/^\[画像\]/.test(t)) turn.unshift(t); }
    let scene: { scene?: string; propertySpecifiedBy?: string | null } | null = null;
    try { const j = JSON.parse(p.decision.scene_evidence ?? "null") as { scene?: string; property_by?: string } | null; scene = j ? { scene: j.scene, propertySpecifiedBy: j.property_by ?? null } : null; } catch { scene = null; }
    const r = correctCustomerPropertyInquiryAix({ finalAix: "acknowledge_check", scene, customerTurn: turn.join("\n") });
    const next = p.press?.aix_type ?? "(押されず)";
    if (r) changed.set(`${r.action} → スタッフ ${next}`, (changed.get(`${r.action} → スタッフ ${next}`) ?? 0) + 1);
    else kept.set(`${sceneOf(p.decision.scene_evidence)} → スタッフ ${next}`, (kept.get(`${sceneOf(p.decision.scene_evidence)} → スタッフ ${next}`) ?? 0) + 1);
    if (DUMP && r) console.log(`  D ${p.decision.created_at.slice(0, 16)} ${p.decision.conversation_id.slice(0, 8)} → ${r.action}（スタッフ ${next}）｜${turn.join(" / ").replace(/\n/g, " ").slice(0, 80)}`);
  }
  console.log(`\n== D. 確認します の判断 ${ack.length}件に今の補正を当てる ==`);
  show("変わる（補正後 → スタッフが押した AIX）", changed);
  show("変わらない（場面 → スタッフが押した AIX）", kept);
}
main().catch((e) => { console.error(e); process.exit(1); });
