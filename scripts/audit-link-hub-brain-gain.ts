// scripts/audit-link-hub-brain-gain.ts — つなぎの芯（ハブ）が LINE のブレインに届いていれば道が変わった番を数える（本番 DB は読むだけ・LLM なし・$0）
//   実行: npx tsx --env-file=.env.local scripts/audit-link-hub-brain-gain.ts --days=21 --turns=600 [--out=scripts/.replay-out/link-hub-gain.json]
//   出す数: スタッフが AIX を押した番でブレインが外した番のうち、司令塔の1行（gainNote）・開いている事の一覧（gainOpenItem）が当たる数と、返信だけの番に出る数（openItemOnReply・riskReplyNote）
import { createClient } from "@supabase/supabase-js";
import { getConductorDecision } from "../app/lib/link-conductor-server";
import { conductorNoteAix, renderConductorBrainNote } from "../app/lib/link-conductor";
import { isTestConversation } from "../app/lib/test-conversations";
import { writeFileSync } from "node:fs";

const sb = createClient(process.env.NEXT_PUBLIC_SUPABASE_URL ?? "", process.env.SUPABASE_SERVICE_ROLE_KEY ?? process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY ?? "");
const arg = (k: string, d: string) => process.argv.find((a) => a.startsWith(`--${k}=`))?.slice(k.length + 3) ?? d;
const DAYS = Number(arg("days", "21")), N = Number(arg("turns", "600"));
const P = (s: string | null | undefined) => (s ? Date.parse(s) : NaN);
const PROP = new Set(["property_send", "property_recommendation", "property_send_new_arrival", "property_send_widen"]);
const same = (a: string, b: string) => a === b || (PROP.has(a) && PROP.has(b)) || (a === "property_check_result" && b === "property_check") || (b === "property_check_result" && a === "property_check");
type Turn = { conv_status: string | null; conversation_id: string; customer_turn_at: string; customer_last_at: string | null; brain_action: string | null; brain_reply_mode: string | null; scene_key: string | null; staff_aix: Array<{ aix_type: string; check_pattern: string | null; burst: boolean }> | null; staff_texts: Array<{ burst: boolean; text: string }> | null };

(async () => {
  const since = new Date(Date.now() - DAYS * 86400_000).toISOString();
  const all: Turn[] = [];
  for (let from = 0; from < 6000; from += 1000) {
    const { data, error } = await sb.from("line_watch_turns").select("conv_status, conversation_id, customer_turn_at, customer_last_at, brain_action, brain_reply_mode, scene_key, staff_aix, staff_texts")
      .gte("customer_turn_at", since).not("staff_first_at", "is", null).order("customer_turn_at", { ascending: false }).range(from, from + 999);
    if (error) throw new Error(error.message);
    all.push(...((data ?? []) as Turn[]));
    if (!data || data.length < 1000) break;
  }
  const turns = all.filter((t) => !isTestConversation(t.conversation_id) && !String(t.scene_key ?? "").startsWith("対象外"));
  const step = Math.max(1, Math.floor(turns.length / N));
  const sample = turns.filter((_, i) => i % step === 0).slice(0, N);
  const rows: Array<Record<string, unknown>> = [];
  const c = { n: 0, staffAix: 0, staffReply: 0, brainRight: 0, gainFirst: 0, gainNote: 0, gainOpenItem: 0, noteAny: 0, riskReplyNote: 0, riskReplyNoteBrainReply: 0, protectOnly: 0, noteOnStaffAixWrong: 0, openItemAny: 0, openItemOnReply: 0 };
  const gainBy: Record<string, number> = {}, riskBy: Record<string, number> = {}, openGainBy: Record<string, number> = {};
  let i = 0;
  const worker = async () => {
    while (i < sample.length) {
      const t = sample[i++];
      const at = P(t.customer_last_at ?? t.customer_turn_at) + 60_000;
      try {
        const r = await getConductorDecision(sb, t.conversation_id, at, { statusAt: t.conv_status ?? null, pointInTime: true });
        if (!r) continue;
        const d = r.decision; c.n++;
        const staffAix = [...new Set((t.staff_aix ?? []).filter((x) => x.burst).map((x) => x.aix_type))];
        const staffText = (t.staff_texts ?? []).some((x) => x.burst && (x.text ?? "").trim());
        const brainAix = t.brain_reply_mode === "aix" && t.brain_action ? t.brain_action : null;
        const na = conductorNoteAix(d);
        const note = renderConductorBrainNote(d, r.input.conv.customer_name);
        if (note) c.noteAny++;
        if (na?.protectOnly) c.protectOnly++;
        const noteAix = na && !na.protectOnly ? na.action : null;
        // 開いている要対応（ハブの材料・司令塔の選びの前）
        const turnStart = P(t.customer_turn_at); const openItems = r.input.aixItems.filter((x) => x.status === "pending" && P(x.created_at) < turnStart).map((x) => x.action);
        const queueAix = r.hub.promises.filter((p) => p.source === "queue" && p.action && !p.watch && !p.deferred).map((p) => p.action as string);
        const open = [...new Set([...openItems, ...queueAix])];
        if (open.length) c.openItemAny++;
        const brainRight = staffAix.length ? !!brainAix && staffAix.some((s) => same(brainAix, s)) : !brainAix;
        if (brainRight) c.brainRight++;
        if (staffAix.length) {
          c.staffAix++;
          if (!brainRight) {
            if (noteAix && staffAix.some((s) => same(noteAix, s))) { c.gainNote++; gainBy[noteAix] = (gainBy[noteAix] ?? 0) + 1; if (na?.first) c.gainFirst++; }
            else if (noteAix) c.noteOnStaffAixWrong++;
            const hit = open.find((a) => staffAix.some((s) => same(a, s)));
            if (hit) { c.gainOpenItem++; openGainBy[hit] = (openGainBy[hit] ?? 0) + 1; }
          }
        } else if (staffText) {
          c.staffReply++;
          if (open.length) c.openItemOnReply++;
          if (noteAix) { c.riskReplyNote++; riskBy[noteAix] = (riskBy[noteAix] ?? 0) + 1; if (!brainAix) c.riskReplyNoteBrainReply++; }
        }
        rows.push({ conv: t.conversation_id.slice(0, 8), at: new Date(at).toISOString(), staffAix, staffText, brainAix, noteAix, first: na?.first ?? null, protectOnly: na?.protectOnly ?? null, open, kind: d.kind, pickupReady: r.hub.properties.pickupReady, reader: d.reader, conf: d.confidence, note: note.replace(/\n/g, " ⏎ ") });
      } catch (e) { console.warn(t.conversation_id.slice(0, 8), e instanceof Error ? e.message : String(e)); }
    }
  };
  await Promise.all(Array.from({ length: 3 }, worker));
  writeFileSync(arg("out", "scripts/.replay-out/link-hub-gain.json"), JSON.stringify(rows, null, 1));
  console.log(JSON.stringify({ days: DAYS, ...c, gainBy, openGainBy, riskBy }, null, 1));
})().catch((e) => { console.error(e); process.exitCode = 1; });
