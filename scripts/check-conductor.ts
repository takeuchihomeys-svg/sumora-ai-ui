// scripts/check-conductor.ts — 自己改善の芯 ④「統括の判断」の点検（読むだけ・LLM なし・費用0・作業員N・2026-11-21・台帳 #473）
//
// 竹内さん 11/21「…統括の判断を強化する、を自己改善の仕組で特に強化すれば更に質が上がる」。
//   竹内さんの番（line_watch_turns・verdict_detail.staff_writer=takeuchi・判定のある番）で、統括の一手が外れた番を種類ごとに数え、
//   原因の3つ（CLAUDE.md 絶対的な考え方）に決まった線で分けられる所まで分ける:
//     reply_not_aix … ブレインは返信・竹内さんは AIX → 「AIX の番を返信にしている」
//     aix_not_reply … ブレインは AIX・竹内さんは返信 → 「場面や決まりの読み違い」
//     aix_kind      … どちらも AIX で種類が違う → 「場面や決まりの読み違い」
//     reply_content … どちらも返信で中身が違う → 事実の食い違い・スタッフだけの事実がある（fact_conflict・facts.staffOnly）なら「材料が届いていない」、ほかは「読み違い」
//   外れた番の id を、試験の問題の候補（作業員H の brain-exam-add --suggest の入力）と、統括の教訓（作業員L の conductor_lessons）の材料として並べる。
//   数: core:conductor = 竹内さんの番の一手（道）の一致の割合（%）。
// 実行: npx tsx --env-file=.env.local scripts/check-conductor.ts [--days=7] [--json]
import { createClient } from "@supabase/supabase-js";

export type MissType = "reply_not_aix" | "aix_not_reply" | "aix_kind" | "reply_content";
export type Cause = "aix_turn_as_reply" | "misread" | "material";
export const CAUSE_JA: Record<Cause, string> = { aix_turn_as_reply: "AIX の番を返信にしている", misread: "場面や決まりの読み違い", material: "材料が届いていない" };

type Vd = { path?: string; reason?: string; staff_aix?: string[] | null; brain_aix?: string | null; facts?: { staffOnly?: string[]; conflict?: string[] } | null; staff_writer?: string };
/** 1番の外れの種類と原因（純関数）。一致・判定なしは null */
export function missOf(verdict: string, brainMode: string | null, brainAction: string | null, vd: Vd): { type: MissType; cause: Cause } | null {
  if (verdict === "same" || verdict === "same_meaning" || verdict === "na") return null;
  const staffAix = (vd.staff_aix ?? []).filter(Boolean);
  const brainAix = brainMode === "aix" ? (vd.brain_aix ?? brainAction ?? "") : "";
  if (!brainAix && staffAix.length) return { type: "reply_not_aix", cause: "aix_turn_as_reply" };
  if (brainAix && !staffAix.length) return { type: "aix_not_reply", cause: "misread" };
  if (brainAix && staffAix.length) return staffAix[0] === brainAix ? { type: "reply_content", cause: "misread" } : { type: "aix_kind", cause: "misread" };
  const material = vd.reason === "fact_conflict" || (vd.facts?.staffOnly ?? []).length > 0 || (vd.facts?.conflict ?? []).length > 0;
  return { type: "reply_content", cause: material ? "material" : "misread" };
}

/** AIX の番1番（地図の木の元・台帳 #610）。kind は竹内さんの最初の AIX の種類（property 系はまとめる） */
export type ConductorAixTurn = { id: number; kind: string; sceneKey: string | null; decAix: string | null; miss: "ok" | "reply_not_aix" | "aix_kind"; cause: "material" | "misread" | "aix_turn_as_reply" | "counting" | null };
/** AIX の番の外れの原因（純関数・地図の木の原因の段）: 竹内さんの最初の一手が返信で AIX が 2分より後＝2段の約束を「AIX の番」と数えた（数え方の誤り・作業員A の audit-aix-turn-judgment の ①）／
 *  スタッフだけの事実・事実の食い違い＝材料が届いていない／ほかは型どおり（返信にした＝判断の誤り・種類違い＝読み違い） */
export function aixTurnCauseOf(type: "reply_not_aix" | "aix_kind", vd: Vd, staffFirstAt: number | null, firstAixAt: number | null): "material" | "misread" | "aix_turn_as_reply" | "counting" {
  if (type === "reply_not_aix" && staffFirstAt != null && firstAixAt != null && firstAixAt - staffFirstAt > 120_000) return "counting";
  if (vd.reason === "fact_conflict" || (vd.facts?.staffOnly ?? []).length > 0 || (vd.facts?.conflict ?? []).length > 0) return "material";
  return type === "reply_not_aix" ? "aix_turn_as_reply" : "misread";
}

/** @param sinceMs 指定すると days の代わりにその時刻から（見込みの突き合わせ: 本番に入った後の番だけで数える） */
export async function checkConductor(days = 7, sinceMs?: number) {
  const sb = createClient(process.env.NEXT_PUBLIC_SUPABASE_URL ?? "", process.env.SUPABASE_SERVICE_ROLE_KEY ?? "");
  const since = new Date(sinceMs ?? Date.now() - days * 86_400_000).toISOString();
  const { data, error } = await sb.from("line_watch_turns").select("id,conversation_id,customer_turn_at,staff_first_at,verdict,brain_reply_mode,brain_action,verdict_detail,scene_key,staff_aix").gte("customer_turn_at", since).not("verdict", "is", null).neq("verdict", "na").limit(3000);
  if (error) throw new Error(error.message);
  type W = { id: number; conversation_id: string; customer_turn_at: string; staff_first_at: string | null; verdict: string; brain_reply_mode: string | null; brain_action: string | null; verdict_detail: Vd | null; scene_key?: string | null; staff_aix?: Array<{ at?: string; aix_type?: string }> | null };
  const rows = ((data ?? []) as W[]).filter((r) => r.verdict_detail?.staff_writer === "takeuchi");
  // 2026-11-21 統括役の決め: 比べるブレインは「送る直前の判断」＝brain_decision_logs のこちらの最初の送信より前の最新（K2 の audit-aix-first-move と同じ）。
  //   見張りの番のブレイン（line_watch_turns.brain_*）と食い違う割合は、分析し直しで判断が変わる番＝統括の揺れの物差し（sway）として別に出す
  const byConv = new Map<string, W[]>();
  for (const r of rows) byConv.set(r.conversation_id, [...(byConv.get(r.conversation_id) ?? []), r]);
  const decOf = new Map<number, { mode: string | null; action: string | null } | null>();
  for (const [c, ws] of byConv) {
    const lo = new Date(Math.min(...ws.map((w) => Date.parse(w.customer_turn_at))) - 86_400_000).toISOString();
    const { data: bs } = await sb.from("brain_decision_logs").select("created_at,suggested_action,suggested_reply_mode").eq("conversation_id", c).gte("created_at", lo).order("created_at").limit(2000);
    const list = (bs ?? []) as Array<{ created_at: string; suggested_action: string | null; suggested_reply_mode: string | null }>;
    for (const w of ws) {
      const until = Date.parse(w.staff_first_at ?? w.customer_turn_at) + 1000;
      const d = [...list].reverse().find((x) => Date.parse(x.created_at) <= until && Date.parse(x.created_at) >= Date.parse(w.customer_turn_at) - 60_000);
      decOf.set(w.id, d ? { mode: d.suggested_reply_mode, action: d.suggested_action } : null);
    }
  }
  const fam = (t: string | null | undefined) => (t === "property_send" || t === "property_recommendation" ? "property" : String(t ?? ""));
  const byType: Record<string, number> = {}, byCause: Record<string, number> = {};
  const ids: Record<string, number[]> = {};
  let n = 0, pathOk = 0, aixTurns = 0, aixOk = 0, sway = 0;
  // 2026-11-23 作業員P（台帳 #610・数ごとの地図の木）: AIX の番を1番ずつ返す（数は上と同じ数え方・木は app/lib/metric-map.ts の buildTree）
  const turns: ConductorAixTurn[] = [];
  for (const r of rows) {
    const d = decOf.get(r.id);
    if (!d) continue; // 直前の判断が無い番は数えない
    n++;
    const watchAix = r.brain_reply_mode === "aix" ? fam(r.brain_action) : "";
    const decAix = d.mode === "aix" ? fam(d.action) : "";
    if (watchAix !== decAix) sway++;
    const vd = r.verdict_detail ?? {};
    const staffAix = (vd.staff_aix ?? []).filter(Boolean).map(fam);
    let m: { type: MissType; cause: Cause } | null = null;
    if (staffAix.length) {
      aixTurns++; m = !decAix ? { type: "reply_not_aix", cause: "aix_turn_as_reply" } : decAix !== staffAix[0] ? { type: "aix_kind", cause: "misread" } : null; if (!m) aixOk++;
      const ats = (r.staff_aix ?? []).map((a) => Date.parse(String(a.at ?? ""))).filter(Number.isFinite);
      const mt = m ? (m.type as "reply_not_aix" | "aix_kind") : null;
      turns.push({ id: r.id, kind: staffAix[0], sceneKey: r.scene_key ?? null, decAix: decAix || null, miss: mt ?? "ok",
        cause: mt ? aixTurnCauseOf(mt, vd, r.staff_first_at ? Date.parse(r.staff_first_at) : null, ats.length ? Math.min(...ats) : null) : null });
    }
    else if (decAix) m = { type: "aix_not_reply", cause: "misread" };
    if (!m) pathOk++;
    if (!m && !(r.verdict === "same" || r.verdict === "same_meaning")) {
      const material = vd.reason === "fact_conflict" || (vd.facts?.staffOnly ?? []).length > 0 || (vd.facts?.conflict ?? []).length > 0;
      m = { type: "reply_content", cause: material ? "material" : "misread" };
    }
    if (!m) continue;
    byType[m.type] = (byType[m.type] ?? 0) + 1; byCause[m.cause] = (byCause[m.cause] ?? 0) + 1;
    (ids[m.type] = ids[m.type] ?? []).push(r.id);
  }
  const pct = (x: number, y: number) => (y ? Math.round((x / y) * 1000) / 10 : null);
  return { days, n, score: pct(pathOk, n), aixTurns, aixScore: pct(aixOk, aixTurns), swayRate: pct(sway, n), byType, byCause, ids, turns };
}

if (process.argv[1]?.endsWith("check-conductor.ts")) {
  const days = Number(process.argv.find((a) => a.startsWith("--days="))?.slice(7) ?? 7) || 7;
  checkConductor(days).then((r) => {
    if (process.argv.includes("--json")) { console.log(JSON.stringify(r)); return; }
    console.log(`統括の判断（${r.days}日・竹内さんの番 ${r.n}・送る直前の判断で道の一致 ${r.score ?? "—"}%・AIX を送った番 ${r.aixTurns} で ${r.aixScore ?? "—"}%・見張りのブレインと直前の判断の食い違い（揺れ）${r.swayRate ?? "—"}%）`);
    console.log(`- 外れの種類: ${JSON.stringify(r.byType)}`);
    console.log(`- 原因: ${Object.entries(r.byCause).map(([k, n]) => `${CAUSE_JA[k as Cause]} ${n}`).join("・") || "なし"}`);
    for (const [k, xs] of Object.entries(r.ids)) console.log(`- 試験の問題の候補（${k}）: 見張りの番 ${xs.slice(0, 10).join(",")}`);
  }).catch((e) => { console.error(e instanceof Error ? e.message : e); process.exit(1); });
}
