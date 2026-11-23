// scripts/lib/combo-daily.ts — 返信と AIX の組の毎日の数（作業員M の頼み・竹内さん「返信と AIX の組み合わせの部分も自己改善で細部まで」・LLM なし・費用0・作業員N・2026-11-21）
//
// 数える番: 前の日の竹内さん本人の番（その番の手＝お客様の次の発言まで24時間のこちらの通が全部 takeuchi）。申込以降は外す（作業員M の POST_APPLY_RE と同じ）。
//   番の拾い方は prod-yardstick-db.readWatchTurns・竹内さんの組は combo-of-moves.takeuchiCombo（オススメ＋ピックアップは1つの束）・
//   ブレインの組は audit-combo-vs-takeuchi と同じ（見張りの道＋decision_source の2段 → send-combo-table.pickSendCombo）・要件の内訳は digest.tc（ask-route-of.tcMix）。
//   出す数（台帳 #405・#32 の物差しの名前にそろえる）:
//     組の一致 … ブレインの組と竹内さんの組が同じ番の割合
//     AIX→返信の外れ … ブレインの最終が AIX（brain_action あり）なのに竹内さんは返信だけ（AIX の種類ごとの内訳つき）
//     返信→AIX の外れ … ブレインは返信なのに竹内さんは AIX を送った
//     2つ目の AIX の取りこぼし … 竹内さんが AIX を2種類以上送ったのに、要件の AIX が1つ以下（ask-route-of.outlierOf と同じ線）
//   本文は出さない（数と会話の id の頭8字だけ）。
import type { SupabaseClient } from "@supabase/supabase-js";
import { readWatchTurns, readDecisionSources, aixFamily } from "./prod-yardstick-db";
import { pickSendCombo } from "../../app/lib/send-combo-table";
import { takeuchiCombo, assignAixKinds, type StaffMove } from "./combo-of-moves";
import { tcMix, aixBundleFamily, askTurnClass, askDailyCounts, type AskTurnClass } from "./ask-route-of";
import { loadTurnApplicationRecords } from "../../app/lib/turn-application-gate-server";
import { turnApplicationReason, type TurnApplicationRecords } from "../../app/lib/turn-application-gate";
import { comboNetOf, comboNetMarkOf, type ComboNet, type ComboNetTurn } from "./combo-net";

/** 作業員M の comboMatches（scripts/lib/combo-of-moves.ts・枝 combo-fit-1121 8a893f3f5）と同じ決まり。main に入ったら import に替える */
// 2026-11-21 作業員M（2cb0feb7 の型）: 前の番でこちらが約束した事を果たす AIX は、この番の組に数えない（combo-of-moves の aixFulfilsPrevPromise・comboWithoutPrevFulfil の写し）
const PREV_PROMISE_OF_LOCAL: ReadonlyArray<[RegExp, RegExp]> = [
  [/^property_check_result/, /募集状況(?:を)?確認|空き(?:状況)?(?:を)?確認|確認させて頂きます|確認出来次第|確認でき次第/],
  [/^(?:property_send|property_recommendation)/, /ピックアップ(?:して|させて)|お送りさせて頂きます|お探し(?:して|させて)|新着(?:で|が)/],
  [/^estimate_sheet/, /御?見積(?:書)?(?:を)?(?:作成|お作り|お送り)/],
];
export function aixFulfilsPrevPromiseLocal(aixKind: string | null | undefined, prevStaffTexts: readonly string[]): boolean {
  const row = PREV_PROMISE_OF_LOCAL.find(([kr]) => kr.test(String(aixKind ?? "")));
  return !!row && prevStaffTexts.some((t) => row[1].test(String(t ?? "")));
}
export function comboWithoutPrevFulfilLocal(takeuchi: string | null | undefined): string | null {
  if (takeuchi === "promise_then_aix_later" || takeuchi === "reply_then_aix_quick") return "reply_only";
  if (takeuchi === "reply_only" || takeuchi === "reply_reply") return takeuchi;
  return null;
}
export function comboMatchesLocal(brain: string | null | undefined, takeuchi: string | null | undefined, o: { laterAixWithinMs?: number | null; laterAixFulfilsPrev?: boolean } = {}): boolean {
  if (!brain || !takeuchi) return false;
  if (brain === takeuchi) return true;
  if (o.laterAixFulfilsPrev) { const own = comboWithoutPrevFulfilLocal(takeuchi); if (own && own === brain) return true; }
  // 2段の1通目＝約束の返信。竹内さんの AIX が次の発言の後に来た番（48時間以内）は同じ組
  if (brain === "promise_then_aix_later" && takeuchi === "reply_only" && o.laterAixWithinMs != null && o.laterAixWithinMs <= 48 * 3_600_000) return true;
  return false;
}

export const POST_APPLY_RE = /記入欄】|・氏名、フリガナ|申込(?:み)?(?:用)?フォーマット|お申込に必要なご情報|ご本人確認書類として|審査(?:結果|が通|通過しました)|ご契約(?:書|手続)/;

export type ComboDaily = {
  day: string; n: number; same: number; sameRate: number | null;
  aixToReply: number; aixToReplyByKind: Record<string, number>; replyToAix: number; secondAixMiss: number;
  examples: { aixToReply: string[]; replyToAix: string[]; secondAixMiss: string[]; comboMiss: string[] };
  /** 2026-11-21 作業員M の頼み（台帳 #407）: 組が外れた番の一覧（本文なし） */
  misses: Array<{ conv: string; at: string; brain: string; takeuchi: string; kind: "AIX→返信" | "返信→AIX" | "2つ目の取りこぼし" | "その他" }>;
  /** 2026-11-22 作業員N2（作業員M の頼み・台帳 #520）: 要件の帳面の分け（ask-route-of.askTurnClass・audit-ask-route-takeuchi と同じ数え方）の数と、外れた会話（頭8字） */
  ask: ReturnType<typeof askDailyCounts> & { misses: Array<{ conv: string; cls: AskTurnClass }> };
  /** 2026-11-23 作業員A（台帳 #624・統括役の決め）: 本当の一致（combo_net・scripts/lib/combo-net.ts）。今の same／sameRate は変えずに並べる */
  net?: ComboNet;
};

/** span 日（既定7日・竹内さん本人の番は1日に数番しか無い＝1日では数が揺れる）の窓で、day まで（day を含む）を数える */
export async function comboDaily(sb: SupabaseClient, day: string, span = 7, opts: { spec?: ReadonlyArray<{ conv?: string; at?: string; why?: string; tags?: unknown }>; sides?: ReadonlyArray<{ conv: string; at: string; side: string }> } = {}): Promise<ComboDaily & { span: number }> {
  const e0ms = Date.parse(new Date(`${day}T00:00:00+09:00`).toISOString()) + 86_400_000;
  const s0 = new Date(e0ms - span * 86_400_000).toISOString();
  const turns = (await readWatchTurns(sb, s0)).filter((t) => Date.parse(t.customer_turn_at) < e0ms);
  const convs = [...new Set(turns.map((t) => t.conversation_id))];
  const msgs = new Map<string, Array<StaffMove & { text: string; src?: string | null }>>();
  const until = new Date(e0ms + 86_400_000).toISOString();
  for (let i = 0; i < convs.length; i += 50) {
    for (let j = 0; ; j += 1000) {
      const { data, error } = await sb.from("messages").select("conversation_id, created_at, sender, staff_writer, staff_writer_source, is_aix_generated, text").in("conversation_id", convs.slice(i, i + 50)).gte("created_at", s0).lt("created_at", until).order("created_at", { ascending: true }).range(j, j + 999);
      if (error) throw new Error(error.message);
      for (const r of (data ?? []) as Array<Record<string, unknown>>) {
        const a = msgs.get(r.conversation_id as string) ?? [];
        a.push({ at: Date.parse(r.created_at as string), aix: !!r.is_aix_generated, writer: (r.staff_writer as string | null) ?? null, customer: r.sender === "customer", text: String(r.text ?? ""), src: (r.staff_writer_source as string | null) ?? null });
        msgs.set(r.conversation_id as string, a);
      }
      if ((data ?? []).length < 1000) break;
    }
  }
  const src = await readDecisionSources(sb, [...new Set(turns.map((t) => t.decision_id).filter((x): x is string => !!x))]);
  const ids = [...new Set(turns.map((t) => t.decision_id).filter((x): x is string => !!x))];
  const tcOf = new Map<string, string | null>();
  for (let i = 0; i < ids.length; i += 200) {
    const { data } = await sb.from("brain_decision_logs").select("id, digest").in("id", ids.slice(i, i + 200));
    for (const r of (data ?? []) as Array<{ id: string; digest: { tc?: string } | null }>) tcOf.set(r.id, r.digest?.tc ?? null);
  }
  const out: ComboDaily & { span: number } = { day, span, n: 0, same: 0, sameRate: null, aixToReply: 0, aixToReplyByKind: {}, replyToAix: 0, secondAixMiss: 0, examples: { aixToReply: [], replyToAix: [], secondAixMiss: [], comboMiss: [] }, misses: [], ask: { ...askDailyCounts([]), misses: [] } };
  const askClasses: AskTurnClass[] = [];
  const netTurns: ComboNetTurn[] = [];
  const push = (k: keyof ComboDaily["examples"], c: string) => { if (out.examples[k].length < 10) out.examples[k].push(c.slice(0, 8)); };
  // 申込以降は会話ごとの申込の記録でも外す（窓より前の申込の案内を拾う・審査落ち→切り替えの戻しは gate の例外のまま。作業員M・11/21 615499ba）
  const gate = new Map<string, TurnApplicationRecords>();
  for (const t of turns) {
    const at = Date.parse(t.customer_turn_at);
    const all = msgs.get(t.conversation_id) ?? [];
    if (all.some((m) => !m.customer && m.at <= at + 86_400_000 && POST_APPLY_RE.test(m.text))) continue; // 申込以降
    if (!gate.has(t.conversation_id)) gate.set(t.conversation_id, await loadTurnApplicationRecords(sb, t.conversation_id));
    if (turnApplicationReason(gate.get(t.conversation_id), new Date(at + 86_400_000).toISOString())) continue;
    const moves: Array<StaffMove & { text: string; src?: string | null }> = [];
    for (const m of all.filter((x) => x.at > at)) { if (m.customer || m.at - at >= 86_400_000) break; moves.push(m); }
    if (!moves.length || !moves.every((m) => m.writer === "takeuchi")) continue; // 竹内さん本人の番だけ
    const kinded = assignAixKinds(moves, (t.staff_aix ?? []).filter((a) => a.at && a.aix_type).map((a) => ({ at: Date.parse(String(a.at)), aixType: String(a.aix_type) })));
    const tc = takeuchiCombo(at, kinded);
    if (!tc) continue;
    out.n++;
    const ds = t.decision_id ? src.get(String(t.decision_id)) ?? "" : "";
    const route: "reply" | "two_stage" | "aix" = /two_stage_promise/.test(ds) ? "two_stage" : aixFamily(t.brain_action) !== "返信" ? "aix" : "reply";
    // multiTopics は渡さない: 本番は turn_contract.asks の kind=question が2つ以上。digest.tc の要件の数（お礼＋依頼も2）は広すぎる（作業員M・11/21）
    const bp = pickSendCombo({ type: null, route, cues: {
      firstContact: /condition_hearing/.test(String(t.scene_key ?? "")),
      hearing: t.brain_action === "condition_hearing",
      aixKind: route === "aix" ? (t.brain_action || null) : null,
    } });
    const bc = bp?.combo ?? (route === "aix" ? "aix_only" : route === "two_stage" ? "promise_then_aix_later" : "reply_only");
    const laterAix = all.find((m) => m.aix && !m.customer && m.writer === "takeuchi" && m.at > at && m.at - at <= 48 * 3_600_000);
    const prevStaffTexts = all.filter((m) => !m.customer && m.at < at && at - m.at <= 86_400_000).map((m) => m.text);
    const firstAixKind = kinded.find((m) => m.aix)?.aixKind ?? null;
    const matched = comboMatchesLocal(bc, tc, { laterAixWithinMs: laterAix ? laterAix.at - at : null, laterAixFulfilsPrev: aixFulfilsPrevPromiseLocal(firstAixKind, prevStaffTexts) });
    if (matched) out.same++; else push("comboMiss", t.conversation_id);
    netTurns.push({ conv: t.conversation_id.slice(0, 8), at: t.customer_turn_at, matched, brain: String(bc), takeuchi: String(tc), device: moves.every((m) => m.src === "device"), firstAixKind,
      mark: matched ? null : comboNetMarkOf({ conv: t.conversation_id, at: t.customer_turn_at }, opts.spec ?? [], opts.sides ?? []) });
    const sentAix = moves.some((m) => m.aix);
    const kindsM = [...new Set((t.staff_aix ?? []).map((a) => aixBundleFamily(String(a.aix_type ?? ""))).filter(Boolean))];
    const mixM = tcMix(t.decision_id ? tcOf.get(t.decision_id) : null);
    if (!matched) out.misses.push({ conv: t.conversation_id.slice(0, 8), at: t.customer_turn_at, brain: String(bc), takeuchi: String(tc), kind: route === "aix" && !sentAix ? "AIX→返信" : route === "reply" && sentAix ? "返信→AIX" : kindsM.length >= 2 && (!mixM || mixM.a <= 1) ? "2つ目の取りこぼし" : "その他" });
    if (route === "aix" && !sentAix) { out.aixToReply++; const k = aixBundleFamily(String(t.brain_action ?? "?")); out.aixToReplyByKind[k] = (out.aixToReplyByKind[k] ?? 0) + 1; push("aixToReply", t.conversation_id); }
    if (route === "reply" && sentAix) { out.replyToAix++; push("replyToAix", t.conversation_id); }
    const kinds = [...new Set((t.staff_aix ?? []).map((a) => aixBundleFamily(String(a.aix_type ?? ""))).filter(Boolean))];
    const mix = tcMix(t.decision_id ? tcOf.get(t.decision_id) : null);
    if (kinds.length >= 2 && (!mix || mix.a <= 1)) { out.secondAixMiss++; push("secondAixMiss", t.conversation_id); }
    // 2026-11-22 作業員N2（作業員M の頼み・台帳 #520）: 要件の帳面の分け（同じ番・同じ手＝次のお客様の発言で切った moves）
    // 2026-11-22 作業員M の照らし（2cb0feb7）: 前の番の約束を果たす AIX は要件の外＝組の数えと同じ prevStaffTexts を渡す
    const cls = askTurnClass({ tc: t.decision_id ? tcOf.get(t.decision_id) : null, turnAt: at, moves: moves.map((m) => ({ at: m.at, aix: m.aix, text: m.text })), kinds, brainAction: t.brain_action, prevStaffTexts });
    askClasses.push(cls);
    if (cls !== "合う" && cls !== "記録なし" && out.ask.misses.length < 20) out.ask.misses.push({ conv: t.conversation_id.slice(0, 8), cls });
  }
  out.ask = { ...askDailyCounts(askClasses), misses: out.ask.misses };
  out.sameRate = out.n ? Math.round((out.same / out.n) * 1000) / 10 : null;
  out.net = comboNetOf(netTurns);
  return out;
}
