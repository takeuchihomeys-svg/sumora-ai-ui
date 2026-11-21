// scripts/lib/self-improve-growth.ts — 自己改善の統括が毎朝追う「伸びしろ」の物差し（LLM なし・作業員N・2026-11-21・台帳 #473）
//
// 竹内さん 11/21「伸びしろの部分は自己改善で改善されるようになっているのか」（統括役の頼み）。今日見つけた伸びしろ3つを、毎朝の1枚と quality_daily で追う:
//   1 AIX の最初の一手の一致を種類ごとに（物件・物件確認・見積・内覧・申込・電話）＝作業員K2 の scripts/audit-aix-first-move.ts と同じ数え方（self-improve の measureDay が数える）
//   2 AIX の文を竹内さんが直した割合（種類ごと・特にピックアップ）と、ピックアップの直しの中身の型の数＝K2 の scripts/audit-aix-edit-diff.ts の editKinds・pickupEditFeatures をそのまま使う
//   3 統括の欄が返信の書き手・AIX の2通目に届いた割合＝作業員L の scripts/audit-writer-linkage.ts（--json の出力を読む）
//   下がった・上がらない日は「直しの候補」に持ち主（1・2＝K2 #469／3＝L #466）と、つないだ竹内さんの指摘（owner_pointers）つきで出す。
import type { SupabaseClient } from "@supabase/supabase-js";
import { execFileSync } from "node:child_process";
import { readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { editKinds, pickupEditFeatures } from "../audit-aix-edit-diff";

export const FIRST_MOVE_GROUPS: Array<[string, RegExp]> = [
  ["物件", /^(?:property_send|property_recommendation|property)$/], ["物件確認", /^property_check_result$/], ["見積", /^estimate/],
  ["内覧", /^(?:viewing_invite|viewing_adjust|meeting_place|greeting_viewing)$/], ["申込", /^application/], ["電話", /^phone/],
];
export const groupOf = (aixType: string | null | undefined): string => FIRST_MOVE_GROUPS.find(([, re]) => re.test(String(aixType ?? "")))?.[0] ?? "その他";

/** 2 AIX の文の直し（その日・種類ごと）。AI の元の文は ai_template_candidates（source=aix_edit）にある時だけ（K2 の数え方） */
export async function aixEditOfDay(sb: SupabaseClient, s0: string, e0: string) {
  const { data: us } = await sb.from("aix_usage_logs").select("conversation_id,aix_type,line_message_id,was_edited,sent_at").gte("sent_at", s0).lt("sent_at", e0).not("line_message_id", "is", null).not("aix_type", "is", null).limit(3000);
  const rows = (us ?? []) as Array<{ conversation_id: string; aix_type: string; line_message_id: string; was_edited: boolean | null; sent_at: string }>;
  const { data: cands } = await sb.from("ai_template_candidates").select("conversation_id,action_type,original_text,created_at").eq("source", "aix_edit").gte("created_at", new Date(Date.parse(s0) - 600_000).toISOString()).lt("created_at", new Date(Date.parse(e0) + 600_000).toISOString()).limit(3000);
  const cs = (cands ?? []) as Array<{ conversation_id: string | null; action_type: string | null; original_text: string | null; created_at: string }>;
  const ids = rows.map((r) => r.line_message_id);
  const msgs = new Map<string, { text: string | null; staff_writer: string | null }>();
  for (let i = 0; i < ids.length; i += 100) {
    const { data: m } = await sb.from("messages").select("line_message_id,text,staff_writer").in("line_message_id", ids.slice(i, i + 100));
    for (const x of (m ?? []) as Array<{ line_message_id: string; text: string | null; staff_writer: string | null }>) msgs.set(x.line_message_id, x);
  }
  // 2026-11-21 作業員N: 押されなかった種類も n=0 で返す（毎日の数が「回っていない」と見えないように・check-stale）
  const byType: Record<string, { n: number; edited: number; withAi: number }> = Object.fromEntries([...FIRST_MOVE_GROUPS.map(([g]) => g), "ピックアップ"].map((g) => [g, { n: 0, edited: 0, withAi: 0 }]));
  const features: Record<string, number> = {};
  for (const r of rows) {
    const m = msgs.get(r.line_message_id);
    if (!m || m.staff_writer !== "takeuchi") continue; // 正解は竹内さん本人の番（KB 41dadfe6）
    const g = groupOf(r.aix_type) === "物件" && r.aix_type === "property_send" ? "ピックアップ" : groupOf(r.aix_type);
    const t = (byType[g] = byType[g] ?? { n: 0, edited: 0, withAi: 0 });
    t.n++;
    const c = cs.filter((x) => x.conversation_id === r.conversation_id && x.action_type === r.aix_type && Math.abs(Date.parse(x.created_at) - Date.parse(r.sent_at)) <= 600_000)[0];
    if (c?.original_text) {
      t.withAi++;
      const ks = editKinds(c.original_text, m.text ?? "");
      if (!(ks.length === 1 && (ks[0] === "同じ" || ks[0] === "名前だけ"))) t.edited++;
      if (g === "ピックアップ") for (const f of pickupEditFeatures(c.original_text, m.text ?? "")) features[f] = (features[f] ?? 0) + 1;
    } else if (r.was_edited) t.edited++;
  }
  return { byType, features };
}

/** tsx の台本を子で流す（tsx は npx の置き場にあり node_modules に無い＝npx を shell で呼ぶ・.env の鍵は親の env をそのまま渡す） */
export function runTsx(args: string[], timeoutMs = 120_000): string {
  return execFileSync("npx", ["tsx", ...args.map((a) => JSON.stringify(a))], { encoding: "utf8", timeout: timeoutMs, env: process.env, shell: true, stdio: ["ignore", "pipe", "ignore"] });
}

/** 3 統括の欄 → 書き手（L の台本の --json を読む・直近24時間） */
export function writerLinkageNow(): { n: number; briefRate: number | null; deliverRate: number | null; inDraftRate: number | null; aix2Wired: string } | null {
  const out = join(tmpdir(), `writer-linkage-${process.pid}.json`);
  try {
    runTsx(["scripts/audit-writer-linkage.ts", "--hours=24", "--max=60", `--json=${out}`], 180_000);
    const j = JSON.parse(readFileSync(out, "utf8")) as { n: number; brief: Record<string, { n: number; used: number }>; fields: Array<{ val: number; writerOk: number; inDraft: number; aix2: string }> };
    const bn = Object.values(j.brief ?? {}).reduce((a, c) => a + c.n, 0), bu = Object.values(j.brief ?? {}).reduce((a, c) => a + c.used, 0);
    const fv = (j.fields ?? []).reduce((a, f) => a + f.val, 0), fo = (j.fields ?? []).reduce((a, f) => a + f.writerOk, 0), fd = (j.fields ?? []).reduce((a, f) => a + f.inDraft, 0);
    const wired = (j.fields ?? []).filter((f) => f.aix2 === "届く").length;
    const r = (a: number, b: number) => (b ? Math.round((a / b) * 1000) / 10 : null);
    return { n: j.n, briefRate: r(bu, bn), deliverRate: r(fo, fv), inDraftRate: r(fd, fv), aix2Wired: `${wired}/${(j.fields ?? []).length}` };
  } catch { return null; } finally { try { rmSync(out); } catch { /* 無ければよい */ } }
}

/**
 * 4 ピックアップで送る物件の「物件の理解」の欄の埋まり方（作業員K2 の scripts/audit-pickup-understanding.ts --days=1 --sent --json・2026-11-21 K2 の頼み）。
 *   JSON の形（K2 と決めた）: { n: 送った行, fields: { <鍵>: { filled: 埋まっている, gap: 元はあるのに空, none: 元も無い } } }
 *   台本がまだ無い（main に入っていない）時は null（何もしない）
 */
export function pickupUnderstandingNow(exists: (p: string) => boolean): { n: number; fields: Record<string, { filled: number; gap: number; none: number }> } | null {
  const script = "scripts/audit-pickup-understanding.ts";
  if (!exists(script)) return null;
  const out = join(tmpdir(), `pickup-understanding-${process.pid}.json`);
  try {
    runTsx([script, "--days=1", "--sent", `--json=${out}`], 180_000);
    const j = JSON.parse(readFileSync(out, "utf8")) as { n?: number; fields?: Record<string, { filled: number; gap: number; none: number }> };
    // 送った行が0の日は fields が空・n も0（作業員K2）＝その日は飛ばす
    return j.fields && Number(j.n ?? 0) > 0 && Object.keys(j.fields).length ? { n: Number(j.n), fields: j.fields } : null;
  } catch { return null; } finally { try { rmSync(out); } catch { /* 無し */ } }
}

/** 下がった・上がらない（純関数）: 前の日より下がった、または前の週より上がっていない時に候補（数が少ない日は見ない） */
export function needsFix(v: number | null, prevDay: number | null, prevWeek: number | null, n: number | null, minN = 3, higherIsBetter = true): "down" | "flat" | null {
  if (v == null || (n != null && n < minN)) return null;
  const worse = (a: number) => (higherIsBetter ? v < a : v > a);
  if (prevDay != null && worse(prevDay)) return "down";
  if (prevWeek != null && !(higherIsBetter ? v > prevWeek : v < prevWeek)) return "flat";
  return null;
}

/** 持ち主と台帳・指摘のつなぎ */
export const GROWTH_OWNERS: Record<string, { owner: string; item: number }> = { first_move: { owner: "作業員K2", item: 469 }, aix_edit: { owner: "作業員K2", item: 469 }, writer_link: { owner: "作業員L", item: 466 } };
export async function pointersOfItems(sb: SupabaseClient, items: number[]): Promise<Record<number, number[]>> {
  const out: Record<number, number[]> = {};
  for (const it of items) {
    const { data } = await sb.from("owner_pointers").select("id").contains("work_item_ids", [it]).neq("state", "closed").limit(20);
    out[it] = ((data ?? []) as Array<{ id: number }>).map((r) => r.id);
  }
  return out;
}

/** 物件オススメが売上サポ（AIX ツール）を通っているか（作業員K2 の scripts/audit-appeal-vs-codes.ts --json・台帳 #479・竹内さん 11/21「ここもちゃんと自己改善のところにいれる」）
 *  rate＝matched÷n（オススメの文のうち売上サポに同じ建物の行がある割合・%）・textOnly＝推しどころごとの「文に書いたのに AIX の札に無い数」。台本が無い・失敗は null */
export function appealViaToolNow(days: number, scriptExists: (p: string) => boolean): { n: number; matched: number; rate: number | null; textOnly: Record<string, number> } | null {
  const p = "scripts/audit-appeal-vs-codes.ts";
  if (!scriptExists(p)) return null;
  const out = join(tmpdir(), `appeal-vs-codes-${process.pid}-${days}.json`);
  try {
    runTsx([p, `--days=${days}`, "--writer=all", `--json=${out}`], 180_000);
    const j = JSON.parse(readFileSync(out, "utf8")) as { n: number; matched: number; points?: Record<string, { both: number; text_only: number; code_only: number }> };
    const textOnly: Record<string, number> = {};
    for (const [k, v] of Object.entries(j.points ?? {})) if (v.text_only) textOnly[k] = v.text_only;
    return { n: j.n, matched: j.matched, rate: j.n ? Math.round((j.matched / j.n) * 1000) / 10 : null, textOnly };
  } catch { return null; } finally { try { rmSync(out); } catch { /* 無し */ } }
}
