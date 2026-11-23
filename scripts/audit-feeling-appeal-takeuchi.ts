// scripts/audit-feeling-appeal-takeuchi.ts — 土台「気持ち」「訴求」の場面ごとの物差し（竹内さん本人の手打ちの返信 と その番の AI の下書きを同じ網で比べる・読むだけ・LLM なし・費用0）
//   作業員P・2026-11-23（前の作業員K2 の残り・統括役の頼み）。決め方は app/lib/feeling-appeal-map.ts（純関数）。網は K2 の audit-scene-feeling-appeal.ts と同じ。
//   番＝見張りの番のうち、お客様の発言の後のこちらの通がすべて竹内さん本人（messages.staff_writer=takeuchi・端末の記録）で、手打ちの返信がある番（AIX だけの番は比べない）。申込以降は外す。
//   AI の下書き＝line_watch_turns.draft_last（竹内さんの最初の通より後に作り直された下書きなら draft_first）。場面＝こちらに物件の AIX があれば「物件を送る」・ほかはお客様の束の reply-scene。
//   本文は出さない（場面ごとの数だけ）。重い読み: 営業時間（JST 9〜22時）は --days=2 --max-conv=10 に絞る（--force で外す）。
// 実行（22時以降）: npx tsx --env-file=<env> scripts/audit-feeling-appeal-takeuchi.ts [--days=60] [--json=<出力>]
import { createClient } from "@supabase/supabase-js";
import { writeFileSync } from "node:fs";
import { POST_APPLY_RE } from "./lib/combo-daily";
import { loadTurnApplicationRecords } from "../app/lib/turn-application-gate-server";
import { turnApplicationReason } from "../app/lib/turn-application-gate";
import { resolveReplyScene } from "../app/lib/reply-scene";
import { isTestConversation } from "../app/lib/test-conversations";
import { feelingOf, appealOf, feelingAppealSummaryOf, type FeelingAppealRow } from "../app/lib/feeling-appeal-map";

const arg = (k: string, d: string) => process.argv.find((a) => a.startsWith(`--${k}=`))?.slice(k.length + 3) ?? d;

(async () => {
  const sb = createClient(process.env.NEXT_PUBLIC_SUPABASE_URL ?? "", process.env.SUPABASE_SERVICE_ROLE_KEY ?? "", { auth: { persistSession: false } });
  let days = Number(arg("days", "60")) || 60, maxConv = Number(arg("max-conv", "400")) || 400;
  const h = (new Date().getUTCHours() + 9) % 24;
  if (h >= 9 && h < 22 && !process.argv.includes("--force")) { days = Math.min(days, 2); maxConv = Math.min(maxConv, 10); console.log(`営業時間なので --days=${days} --max-conv=${maxConv} に絞った`); }
  const since = new Date(Date.now() - days * 864e5).toISOString();
  type W = { id: number; conversation_id: string; customer_turn_at: string; staff_first_at: string | null; draft_first: string | null; draft_last: string | null; draft_last_at: string | null; staff_aix: Array<{ aix_type?: string }> | null; materials: { brain?: { blocks?: { empty?: string[] } } } | null };
  const turns: W[] = [];
  for (let i = 0; ; i += 1000) {
    const { data, error } = await sb.from("line_watch_turns").select("id,conversation_id,customer_turn_at,staff_first_at,draft_first,draft_last,draft_last_at,staff_aix,materials").gte("customer_turn_at", since).not("verdict", "is", null).neq("verdict", "na").order("customer_turn_at").range(i, i + 999);
    if (error) throw new Error(error.message);
    turns.push(...((data ?? []) as W[]));
    if ((data ?? []).length < 1000) break;
  }
  const byConv = new Map<string, W[]>();
  for (const t of turns) if (!isTestConversation(t.conversation_id)) byConv.set(t.conversation_id, [...(byConv.get(t.conversation_id) ?? []), t]);
  const rows: FeelingAppealRow[] = [];
  let skipped = { post: 0, notTakeuchi: 0, noHand: 0, noDraft: 0 };
  for (const [c, ts] of [...byConv].slice(0, maxConv)) {
    const lo = new Date(Math.min(...ts.map((t) => Date.parse(t.customer_turn_at))) - 864e5).toISOString();
    const hi = new Date(Math.max(...ts.map((t) => Date.parse(t.customer_turn_at))) + 2 * 864e5).toISOString();
    const { data: md } = await sb.from("messages").select("sender,text,created_at,is_aix_generated,staff_writer").eq("conversation_id", c).gte("created_at", lo).lt("created_at", hi).order("created_at").limit(5000);
    const ms = ((md ?? []) as Array<Record<string, unknown>>).map((m) => ({ at: Date.parse(String(m.created_at)), sender: String(m.sender), text: String(m.text ?? ""), aix: !!m.is_aix_generated, writer: (m.staff_writer as string | null) ?? null }));
    const gate = await loadTurnApplicationRecords(sb, c);
    for (const t of ts) {
      const at = Date.parse(t.customer_turn_at);
      if (turnApplicationReason(gate, t.customer_turn_at) || ms.some((m) => m.sender !== "customer" && m.at <= at + 864e5 && POST_APPLY_RE.test(m.text))) { skipped.post++; continue; }
      const moves: typeof ms = [];
      for (const m of ms.filter((x) => x.at > at)) { if (m.sender === "customer" || m.at - at >= 864e5) break; moves.push(m); }
      if (!moves.length || !moves.every((m) => m.writer === "takeuchi")) { skipped.notTakeuchi++; continue; }
      const hand = moves.filter((m) => !m.aix).map((m) => m.text);
      if (!hand.length) { skipped.noHand++; continue; }
      const firstAt = moves[0].at;
      const draft = t.draft_last && (!t.draft_last_at || Date.parse(t.draft_last_at) <= firstAt) ? t.draft_last : t.draft_first;
      if (!draft) { skipped.noDraft++; continue; }
      const burst: string[] = []; for (let i = ms.findIndex((m) => m.at > at) - 1; i >= 0 && ms[i].sender === "customer"; i--) burst.unshift(ms[i].text);
      const propertySend = (t.staff_aix ?? []).some((a) => /^property(_send|_recommendation|_pickup)?/.test(String(a.aix_type ?? "")));
      const scene = propertySend ? "property_send" : resolveReplyScene({ customerText: burst.join("\n") }).scene;
      const tkText = hand.join("\n");
      rows.push({ id: t.id, conv: c.slice(0, 8), at: t.customer_turn_at.slice(0, 16), scene, tkFeel: feelingOf(tkText), aiFeel: feelingOf(draft), tkAppeal: appealOf(tkText), aiAppeal: appealOf(draft), empty: t.materials?.brain?.blocks?.empty ?? [] });
    }
  }
  const s = feelingAppealSummaryOf(rows);
  console.log(`気持ち・訴求の場面ごと（${days}日・竹内さん本人の手打ちの返信の番 ${rows.length}・申込以降 ${skipped.post}・竹内さん以外 ${skipped.notTakeuchi}・手打ち無し ${skipped.noHand}・下書き無し ${skipped.noDraft}）`);
  for (const [k, v] of Object.entries(s).sort((a, b) => b[1].n - a[1].n)) console.log(`  ${k}: n ${v.n}・気持ち 一致 ${v.feelOk}（見逃し ${v.feelMissed}・言い過ぎ ${v.feelExtra}）・訴求 一致 ${v.appealOk}（見逃し ${v.appealMissed}・言い過ぎ ${v.appealExtra}・推すと誘うの違い ${v.appealOther}）`);
  if (arg("json", "")) writeFileSync(arg("json", ""), JSON.stringify(rows, null, 1));
})().catch((e) => { console.error(e); process.exit(1); });
