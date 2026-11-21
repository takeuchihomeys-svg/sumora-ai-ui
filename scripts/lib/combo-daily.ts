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
import { tcMix, aixBundleFamily } from "./ask-route-of";

export const POST_APPLY_RE = /記入欄】|・氏名、フリガナ|申込(?:み)?(?:用)?フォーマット|お申込に必要なご情報|ご本人確認書類として|審査(?:結果|が通|通過しました)|ご契約(?:書|手続)/;

export type ComboDaily = {
  day: string; n: number; same: number; sameRate: number | null;
  aixToReply: number; aixToReplyByKind: Record<string, number>; replyToAix: number; secondAixMiss: number;
  examples: { aixToReply: string[]; replyToAix: string[]; secondAixMiss: string[]; comboMiss: string[] };
};

/** span 日（既定7日・竹内さん本人の番は1日に数番しか無い＝1日では数が揺れる）の窓で、day まで（day を含む）を数える */
export async function comboDaily(sb: SupabaseClient, day: string, span = 7): Promise<ComboDaily & { span: number }> {
  const e0ms = Date.parse(new Date(`${day}T00:00:00+09:00`).toISOString()) + 86_400_000;
  const s0 = new Date(e0ms - span * 86_400_000).toISOString();
  const turns = (await readWatchTurns(sb, s0)).filter((t) => Date.parse(t.customer_turn_at) < e0ms);
  const convs = [...new Set(turns.map((t) => t.conversation_id))];
  const msgs = new Map<string, Array<StaffMove & { text: string }>>();
  const until = new Date(e0ms + 86_400_000).toISOString();
  for (let i = 0; i < convs.length; i += 50) {
    for (let j = 0; ; j += 1000) {
      const { data, error } = await sb.from("messages").select("conversation_id, created_at, sender, staff_writer, is_aix_generated, text").in("conversation_id", convs.slice(i, i + 50)).gte("created_at", s0).lt("created_at", until).order("created_at", { ascending: true }).range(j, j + 999);
      if (error) throw new Error(error.message);
      for (const r of (data ?? []) as Array<Record<string, unknown>>) {
        const a = msgs.get(r.conversation_id as string) ?? [];
        a.push({ at: Date.parse(r.created_at as string), aix: !!r.is_aix_generated, writer: (r.staff_writer as string | null) ?? null, customer: r.sender === "customer", text: String(r.text ?? "") });
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
  const out: ComboDaily & { span: number } = { day, span, n: 0, same: 0, sameRate: null, aixToReply: 0, aixToReplyByKind: {}, replyToAix: 0, secondAixMiss: 0, examples: { aixToReply: [], replyToAix: [], secondAixMiss: [], comboMiss: [] } };
  const push = (k: keyof ComboDaily["examples"], c: string) => { if (out.examples[k].length < 10) out.examples[k].push(c.slice(0, 8)); };
  for (const t of turns) {
    const at = Date.parse(t.customer_turn_at);
    const all = msgs.get(t.conversation_id) ?? [];
    if (all.some((m) => !m.customer && m.at <= at + 86_400_000 && POST_APPLY_RE.test(m.text))) continue; // 申込以降
    const moves: Array<StaffMove & { text: string }> = [];
    for (const m of all.filter((x) => x.at > at)) { if (m.customer || m.at - at >= 86_400_000) break; moves.push(m); }
    if (!moves.length || !moves.every((m) => m.writer === "takeuchi")) continue; // 竹内さん本人の番だけ
    const tc = takeuchiCombo(at, assignAixKinds(moves, (t.staff_aix ?? []).filter((a) => a.at && a.aix_type).map((a) => ({ at: Date.parse(String(a.at)), aixType: String(a.aix_type) }))));
    if (!tc) continue;
    out.n++;
    const ds = t.decision_id ? src.get(String(t.decision_id)) ?? "" : "";
    const route: "reply" | "two_stage" | "aix" = /two_stage_promise/.test(ds) ? "two_stage" : aixFamily(t.brain_action) !== "返信" ? "aix" : "reply";
    const bp = pickSendCombo({ type: null, route, cues: { firstContact: /condition_hearing/.test(String(t.scene_key ?? "")) } });
    const bc = bp?.combo ?? (route === "aix" ? "aix_only" : route === "two_stage" ? "promise_then_aix_later" : "reply_only");
    if (bc === tc) out.same++; else push("comboMiss", t.conversation_id);
    const sentAix = moves.some((m) => m.aix);
    if (route === "aix" && !sentAix) { out.aixToReply++; const k = aixBundleFamily(String(t.brain_action ?? "?")); out.aixToReplyByKind[k] = (out.aixToReplyByKind[k] ?? 0) + 1; push("aixToReply", t.conversation_id); }
    if (route === "reply" && sentAix) { out.replyToAix++; push("replyToAix", t.conversation_id); }
    const kinds = [...new Set((t.staff_aix ?? []).map((a) => aixBundleFamily(String(a.aix_type ?? ""))).filter(Boolean))];
    const mix = tcMix(t.decision_id ? tcOf.get(t.decision_id) : null);
    if (kinds.length >= 2 && (!mix || mix.a <= 1)) { out.secondAixMiss++; push("secondAixMiss", t.conversation_id); }
  }
  out.sameRate = out.n ? Math.round((out.same / out.n) * 1000) / 10 : null;
  return out;
}
