// scripts/dry-run-link-conductor.ts — つなぎのブレイン 段3 司令塔の試し（本番 DB は読むだけ・LINE へ送らない・書かない）
//   A. お客様の番（line_watch_turns）: その時点の司令塔の決定 と スタッフが実際にした事（すぐの並びの AIX／返信）を比べる。ブレインの一手（brain_action）も並べる
//   B. 毎日の点検（JST 11:00 の時点）: 会話ごとの決定 と その後24時間にスタッフがした事を比べる
//   flash（DeepSeek）は --flash の時だけ・迷いの時だけ・候補の札と段階だけ（お客様の文・名前は渡さない・審査の事情がある会話は聞かない）。上限 --flash-max（既定 150 回）
// 実行: npx tsx --env-file=.env.local scripts/dry-run-link-conductor.ts [--days=7] [--turns=150] [--snap=150] [--flash]
import { createClient } from "@supabase/supabase-js";
import { getConductorDecision, deepseekTieBreaker, type AsyncTieBreaker } from "../app/lib/link-conductor-server";
import { renderConductorDecision, countDecisions, CONDUCTOR_KIND_JA, RECOMMENDED, type ConductorDecision } from "../app/lib/link-conductor";
import { activeConversationIds } from "../app/lib/customer-hub-server";
import { isTestConversation } from "../app/lib/test-conversations";
import { maskPII } from "../app/lib/pii-mask";

const sb = createClient(process.env.NEXT_PUBLIC_SUPABASE_URL ?? "", process.env.SUPABASE_SERVICE_ROLE_KEY ?? process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY ?? "");
const arg = (k: string, d: string) => process.argv.find((a) => a.startsWith(`--${k}=`))?.slice(k.length + 3) ?? d;
const DAYS = Number(arg("days", "7"));
const TURNS = Number(arg("turns", "150"));
const SNAP = Number(arg("snap", "150"));
const FLASH = process.argv.includes("--flash");
const FLASH_MAX = Number(arg("flash-max", "150"));
const EX = Number(arg("ex", "12"));
const H = 3600_000, DAY = 24 * H;
const P = (s: string | null | undefined) => (s ? Date.parse(s) : NaN);

// flash の費用（DeepSeek flash・混雑時間の倍を常に掛けた上限の見積もり）
let flashCalls = 0, inTok = 0, outTok = 0, cacheTok = 0;
const ds = FLASH ? deepseekTieBreaker({ onUsage: (u) => { inTok += Math.max(0, u.input - u.cacheHit); cacheTok += u.cacheHit; outTok += u.output; } }) : null;
const flash: AsyncTieBreaker | null = ds ? async (q) => { if (flashCalls >= FLASH_MAX) return null; flashCalls++; return ds(q); } : null;
const costUsd = () => 2 * (inTok * 0.15 + cacheTok * 0.003 + outTok * 0.6) / 1e6;

/** 決定の道（比べる形）: reply / aix:<type> / staff / wait */
function pathOf(d: ConductorDecision): string {
  if (d.kind === "wait") return "wait";
  if (d.action) return `aix:${d.action}`;
  if (d.kind === "send") return "reply";
  return "staff";
}
const coarse = (p: string) => (p.startsWith("aix:") ? "aix" : p);
// 物件を送る AIX（初回・新着・広げた）は同じ仲間（どれで送るかはブレインの番の判断）
const PROP = new Set(["property_send", "property_recommendation", "property_send_new_arrival", "property_send_widen"]);
const sameAix = (a: string, staff: string[]) => a.startsWith("aix:") && staff.some((s) => s === a.slice(4) || (a.slice(4) === "property_check_result" && s === "property_check") || (PROP.has(s) && PROP.has(a.slice(4))));

type Turn = { conv_status: string | null; conversation_id: string; customer_turn_at: string; customer_last_at: string | null; brain_action: string | null; brain_reply_mode: string | null; scene_key: string | null; staff_first_at: string | null; brain_at: string | null;
  staff_aix: Array<{ aix_type: string; check_pattern: string | null; burst: boolean }> | null; staff_texts: Array<{ burst: boolean; text: string }> | null };

(async () => {
  const nowMs = Date.now();
  const since = new Date(nowMs - DAYS * DAY).toISOString();
  const examples: string[] = [];
  const decisions: ConductorDecision[] = [];

  // ── A. お客様の番 ──
  const { data: tr, error } = await sb.from("line_watch_turns").select("conv_status, conversation_id, customer_turn_at, customer_last_at, brain_action, brain_reply_mode, scene_key, staff_first_at, brain_at, staff_aix, staff_texts")
    .gte("customer_turn_at", since).not("staff_first_at", "is", null).order("customer_turn_at", { ascending: false }).limit(3000);
  if (error) throw new Error(error.message);
  const turns = ((tr ?? []) as Turn[]).filter((t) => !isTestConversation(t.conversation_id) && !String(t.scene_key ?? "").startsWith("対象外"));
  const step = Math.max(1, Math.floor(turns.length / TURNS));
  const sample = turns.filter((_, i) => i % step === 0).slice(0, TURNS);
  const A = { n: 0, failed: 0, coarseAgree: 0, brainCoarseAgree: 0, staffAix: 0, aixAgree: 0, aixAgreeWithNote: 0, brainAixAgree: 0, unionAgree: 0, replyTurns: 0, noteOnReply: 0, byKind: {} as Record<string, number>, staffKinds: {} as Record<string, number>, hesitant: 0 };
  let next = 0;
  const workerA = async () => {
    while (next < sample.length) {
      const t = sample[next++];
      const at = (P(t.customer_last_at ?? t.customer_turn_at)) + 60_000;
      try {
        const r = await getConductorDecision(sb, t.conversation_id, at, { flash, statusAt: t.conv_status ?? null });
        if (!r) { A.failed++; continue; }
        const d = r.decision; decisions.push(d);
        A.n++; A.byKind[d.kind] = (A.byKind[d.kind] ?? 0) + 1; if (d.hesitant) A.hesitant++;
        const staffAix = [...new Set((t.staff_aix ?? []).filter((x) => x.burst).map((x) => x.aix_type))];
        const staffText = (t.staff_texts ?? []).some((x) => x.burst && (x.text ?? "").trim());
        const staff = staffAix.length ? "aix" : staffText ? "reply" : "wait";
        A.staffKinds[staff] = (A.staffKinds[staff] ?? 0) + 1;
        const cp = pathOf(d);
        if (coarse(cp) === staff) A.coarseAgree++;
        const brainPath = t.brain_reply_mode === "aix" && t.brain_action ? `aix:${t.brain_action}` : "reply";
        if (coarse(brainPath) === staff) A.brainCoarseAgree++;
        const noteAixAll = d.action ? cp : (() => { const c = d.alternatives.find((x) => x.action && (x.kind === "ask_staff" || x.kind === "send")); return c ? `aix:${c.action}` : ""; })();
        if (staff === "reply") { A.replyTurns++; if (noteAixAll) A.noteOnReply++; }
        if (staffAix.length) {
          A.staffAix++;
          if (sameAix(cp, staffAix)) A.aixAgree++;
          // ブレインの材料（返信の後に残る AIX）まで含めて当たったか
          const noteAix = d.action ? cp : (() => { const c = d.alternatives.find((x) => x.action && (x.kind === "ask_staff" || x.kind === "send")); return c ? `aix:${c.action}` : ""; })();
          if (sameAix(cp, staffAix) || sameAix(noteAix, staffAix)) A.aixAgreeWithNote++;
          if (sameAix(brainPath, staffAix)) A.brainAixAgree++;
          // LINK_CONDUCTOR_BRAIN=on の時にブレインが受け取る物（ブレインの一手＋司令塔の残る一手）のどちらかで当たるか
          if (sameAix(brainPath, staffAix) || sameAix(cp, staffAix) || sameAix(noteAix, staffAix)) A.unionAgree++;
        }
        if (examples.length < 6 && (d.kind !== "send" || d.by !== "brain" || staffAix.length)) {
          examples.push(`${renderConductorDecision(d, r.input.conv.customer_name)}\n  スタッフ実際: ${staff === "aix" ? `AIX ${staffAix.join("+")}` : staff === "reply" ? "返信" : "動かず"}・ブレイン: ${brainPath}`);
        }
      } catch (e) { A.failed++; console.warn("A", t.conversation_id.slice(0, 8), e instanceof Error ? e.message : String(e)); }
    }
  };
  await Promise.all(Array.from({ length: 4 }, workerA));

  // ── B. 毎日の点検（JST 11:00） ──
  const B = { postApply: 0, n: 0, failed: 0, agree: 0, judged: 0, newTurn: 0, byKind: {} as Record<string, { n: number; agree: number; judged: number }>, hesitant: 0, housekeeping: 0 };
  const days = Math.min(DAYS, 5);
  const perDay = Math.ceil(SNAP / days);
  const points: Array<{ id: string; at: number }> = [];
  for (let k = 1; k <= days; k++) {
    const dayStart = Date.parse(new Date(nowMs - k * DAY + 9 * H).toISOString().slice(0, 10) + "T11:00:00+09:00");
    if (dayStart + DAY > nowMs) continue;
    const ids = await activeConversationIds(sb, new Date(dayStart - 14 * DAY).toISOString(), new Date(dayStart).toISOString(), 2000);
    const st = Math.max(1, Math.floor(ids.length / perDay));
    for (const id of ids.filter((_, i) => i % st === 0).slice(0, perDay)) points.push({ id, at: dayStart });
  }
  let nb = 0;
  const workerB = async () => {
    while (nb < points.length) {
      const p = points[nb++];
      try {
        const r = await getConductorDecision(sb, p.id, p.at, { flash });
        if (!r) { B.failed++; continue; }
        // 今が申込以降の会話は、その日の状態が分からない（今の status で決めると「待つ」が水増しになる）＝数えない
        if (r.hub.where.isPostApply || r.hub.where.stage === "applying" || r.hub.where.stage === "won") { B.postApply++; continue; }
        const d = r.decision; decisions.push(d);
        B.n++; if (d.hesitant) B.hesitant++; if (d.housekeeping.length) B.housekeeping++;
        const k = (B.byKind[d.kind] ??= { n: 0, agree: 0, judged: 0 }); k.n++;
        const until = new Date(p.at + DAY).toISOString(), from = new Date(p.at).toISOString();
        const [m, l] = await Promise.all([
          sb.from("messages").select("sender, created_at").eq("conversation_id", p.id).gt("created_at", from).lte("created_at", until).order("created_at").limit(200),
          sb.from("aix_usage_logs").select("aix_type, created_at, sent_at").eq("conversation_id", p.id).gt("created_at", from).lte("created_at", until).limit(100),
        ]);
        const msgs = (m.data ?? []) as Array<{ sender: string; created_at: string }>;
        const firstCust = msgs.find((x) => x.sender === "customer");
        const staffOut = msgs.filter((x) => x.sender !== "customer");
        const aixTypes = ((l.data ?? []) as Array<{ aix_type: string }>).map((x) => x.aix_type);
        // お客様の新しい番が先に来た後のスタッフの動きは、この時点の決定の答えではない（数えない）
        const staffBeforeCust = staffOut.filter((x) => !firstCust || P(x.created_at) < P(firstCust.created_at));
        let agree: boolean | null;
        if (d.kind === "wait") agree = staffBeforeCust.length === 0 ? true : false;
        else if (d.action) agree = sameAix(`aix:${d.action}`, aixTypes) ? true : (firstCust && !staffBeforeCust.length ? null : false);
        else if (d.kind === "send") agree = staffBeforeCust.length > 0 ? true : (firstCust ? null : false);
        else agree = null; // スタッフの作業（内覧・記録の直し）は送信から見えない
        if (agree === null) { if (firstCust) B.newTurn++; continue; }
        B.judged++; k.judged++; if (agree) { B.agree++; k.agree++; }
        if (examples.length < EX && d.kind !== "wait") examples.push(`${renderConductorDecision(d, r.input.conv.customer_name)}\n  その後24時間: ${staffBeforeCust.length ? `スタッフ送信 ${staffBeforeCust.length}${aixTypes.length ? `（AIX ${[...new Set(aixTypes)].join("+")}）` : ""}` : "動かず"}${firstCust ? "・お客様の新しい番あり" : ""} → ${agree ? "一致" : "不一致"}`);
      } catch (e) { B.failed++; console.warn("B", p.id.slice(0, 8), e instanceof Error ? e.message : String(e)); }
    }
  };
  await Promise.all(Array.from({ length: 4 }, workerB));

  const pct = (a: number, b: number) => (b ? `${Math.round((a / b) * 100)}%` : "-");
  const c = countDecisions(decisions);
  const L: string[] = [];
  L.push(`# つなぎの司令塔 試し（直近 ${DAYS}日・読むだけ・送らない）`);
  L.push(`当てたオススメ: ${Object.entries(RECOMMENDED).map(([k, v]) => `決定${k} ${v}`).join(" ／ ")}`);
  L.push(`\n## A. お客様の番 ${A.n}（読めない ${A.failed}）`);
  L.push(`決定: ${Object.entries(A.byKind).map(([k, n]) => `${CONDUCTOR_KIND_JA[k as keyof typeof CONDUCTOR_KIND_JA]} ${n}`).join("・")}・迷い ${A.hesitant}`);
  L.push(`スタッフ実際: ${Object.entries(A.staffKinds).map(([k, n]) => `${k} ${n}`).join("・")}`);
  L.push(`返信／AIX／待つ の一致: 司令塔 ${pct(A.coarseAgree, A.n)}（${A.coarseAgree}/${A.n}）・ブレイン ${pct(A.brainCoarseAgree, A.n)}`);
  L.push(`スタッフが AIX を押した番 ${A.staffAix}: AIX の種類の一致 司令塔の1位 ${pct(A.aixAgree, A.staffAix)}・1位＋返信の後に残る一手 ${pct(A.aixAgreeWithNote, A.staffAix)}・ブレイン ${pct(A.brainAixAgree, A.staffAix)}・ブレインか司令塔の残る一手のどちらか ${pct(A.unionAgree, A.staffAix)}`);
  L.push(`スタッフが返信だけの番 ${A.replyTurns}: 司令塔が AIX の一手を出した（ブレインの材料に1行入る）${A.noteOnReply}（${pct(A.noteOnReply, A.replyTurns)}）`);
  L.push(`\n## B. 毎日の点検（JST 11:00）${B.n}（読めない ${B.failed}・申込以降で数えない ${B.postApply}）`);
  L.push(`決定: ${Object.entries(B.byKind).map(([k, v]) => `${CONDUCTOR_KIND_JA[k as keyof typeof CONDUCTOR_KIND_JA]} ${v.n}（判定 ${v.judged}・一致 ${pct(v.agree, v.judged)}）`).join("・")}`);
  L.push(`その後24時間のスタッフの動きとの一致: ${pct(B.agree, B.judged)}（${B.agree}/${B.judged}）・お客様の新しい番が先で判定しない ${B.newTurn}・迷い ${B.hesitant}・片付けあり ${B.housekeeping}`);
  L.push(`\n## 全体 ${c.conversations}: ${Object.entries(c.byKind).map(([k, n]) => `${CONDUCTOR_KIND_JA[k as keyof typeof CONDUCTOR_KIND_JA]} ${n}`).join("・")}・スタッフしか分からない ${c.staffOnly}・迷い ${c.hesitant}・平均の自信 ${c.avgConfidence}`);
  L.push(`片付け: ${Object.entries(c.housekeeping).map(([k, n]) => `${k} ${n}`).join("・")}`);
  L.push(`flash: ${FLASH ? `${flashCalls}回・入力 ${inTok}+一致 ${cacheTok}・出力 ${outTok}・約 $${costUsd().toFixed(4)}（混雑の倍で見積もり）` : "使わず（--flash で迷いの時だけ）"}`);
  L.push(`\n## 見本（伏せた）`);
  for (const e of examples) L.push(maskPII(e, []));
  console.log(L.join("\n"));
})().catch((e) => { console.error(e instanceof Error ? e.message : e); process.exitCode = 1; });
