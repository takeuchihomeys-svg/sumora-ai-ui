// scripts/audit-aix-turn-judgment.ts — 竹内さん本人の AIX の番を、AIX の種類ごとに「送る直前のブレインの判断」と竹内さんの最初の一手で数え直す（読むだけ・LLM なし・費用0）
//
// 2026-11-23 作業員A（竹内さん 11/23「AIX の番の判断なんでこんなに弱いのか…土台や連携できていない部分徹底的に連携させる」・台帳「AIX の番の判断を、土台と連携の切れ目から徹底的に直す」）。
//   check-conductor（core:conductor の AIX の番）は 7日 9番・60日 96番で、数え方の誤りが混ざる:
//     ① 竹内さんは約束の返信を先に送り、AIX は後（2段）＝最初の一手は返信なのに「AIX の番」と数えていた
//     ② 前の番の約束を果たす AIX（お客様のお礼・了承の後の結果の AIX）を、この番の判断と数えていた
//     ③ 竹内さんが AIX の中身を手で打った番（aix-should-be の strong）を「返信の番」と数えていた
//   ここでは番を5つに分けて種類ごとに数える:
//     aix_first …… 最初の一手が AIX（種類 K）。ブレインの AIX が同じ種類なら一致
//     two_stage … 最初の一手は約束の返信、AIX は 2分より後。ブレインが2段（two_stage_promise）か約束の返信なら一致・同じ種類の AIX を今と言ったら「先後」
//     quick ……… 返信の後 2分以内に AIX（reply_then_aix_quick）。ブレインがその AIX の種類なら一致
//     hand_aix … 竹内さんは AIX を押さず、中身を手で打った（aix-should-be の strong）。ブレインがその鍵のボタンなら一致
//     reply …… AIX なし（ブレインが AIX を言ったら「AIX→返信」の外れ＝精度の側）
//   ②の前の番の約束の果たしは prevFulfil の印を付け、別に数える（外さないで両方出す）。
//   外れの番ごとに、判断の時点の材料（送れる候補・確認の結果・開いている約束・スタッフの手元の申告・AIX の相談・統括の desk・画像の読み）と、
//   ブレインに渡った塊（line_watch_turns.materials.brain.blocks の chars と empty）を並べる＝「材料はあるのに届いていない／届いているのに使われていない／材料が無い」を分ける元。
//   お客様の本文は出さない（会話の頭8字・種類・数だけ）。申込以降は外す（combo-daily の POST_APPLY_RE と turn-application-gate）。
// 重い読み: 60日の見張りの番と会話ごとの読み（1会話ずつ・順番に）。営業時間（JST 9〜22時）は --days=3 に絞る。
// 実行（22時以降）: npx tsx --env-file=<env> scripts/audit-aix-turn-judgment.ts [--days=60] [--json=<出力>]
import { createClient } from "@supabase/supabase-js";
import { writeFileSync } from "node:fs";
import { readWatchTurns } from "./lib/prod-yardstick-db";
import { assignAixKinds, aixFulfilsPrevPromise, type StaffMove } from "./lib/combo-of-moves";
import { POST_APPLY_RE } from "./lib/combo-daily";
import { loadTurnApplicationRecords } from "../app/lib/turn-application-gate-server";
import { turnApplicationReason } from "../app/lib/turn-application-gate";
import { shouldBeAixOf } from "../app/lib/aix-should-be";
import { classifyCustomerBurst } from "../app/lib/customer-reaction-predict";
import { aixKindOfTurn, turnClassOf, brainRouteOf, judgeTurn, type TurnClass } from "../app/lib/aix-turn-judgment";

/** 下書きがその AIX の種類の約束か（audit-aix-miss-causes の PROMISE と同じ網・純関数） */
export function draftPromiseOf(draft: string, kind: string): boolean {
  const re = kind === "estimate_sheet" || kind === "cost_breakdown" ? /(?:御見積|お見積|見積書)[^。！\n]{0,20}(?:作成|お送り|させて頂きます)/
    : kind === "property" || kind === "property_send" || kind === "property_recommendation" ? /ピックアップ[^。！\n]{0,20}(?:お送り|させて頂きます|させていただきます)|(?:新着|お部屋)[^。！\n]{0,15}出次第[^。！\n]{0,10}お送り/
    : /(?:確認させて頂きます|確認させていただきます|確認致します|確認いたします|確認(?:出来|でき)次第)/;
  return re.test(draft);
}
const arg = (k: string, d: string) => process.argv.find((a) => a.startsWith(`--${k}=`))?.slice(k.length + 3) ?? d;

type Msg = { at: number; sender: string; text: string; aix: boolean; writer: string | null };
type Dec = { id: string; created_at: string; suggested_action: string | null; suggested_reply_mode: string | null; suggested_check_pattern: string | null; decision_source: string | null; digest: Record<string, unknown> | null };

(async () => {
  const sb = createClient(process.env.NEXT_PUBLIC_SUPABASE_URL ?? "", process.env.SUPABASE_SERVICE_ROLE_KEY ?? "", { auth: { persistSession: false } });
  let days = Number(arg("days", "60")) || 60;
  const h = (new Date().getUTCHours() + 9) % 24;
  if (h >= 9 && h < 22 && !process.argv.includes("--force")) { days = Math.min(days, 3); console.log(`営業時間なので --days=${days} に絞った`); }
  const since = new Date(Date.now() - days * 864e5).toISOString();
  const turns = await readWatchTurns(sb, since);
  const byConv = new Map<string, typeof turns>();
  for (const t of turns) byConv.set(t.conversation_id, [...(byConv.get(t.conversation_id) ?? []), t]);
  const rows: Array<Record<string, unknown>> = [];
  let skippedPost = 0, skippedNotTakeuchi = 0, skippedNoDec = 0;
  for (const [c, ts] of byConv) {
    const lo = new Date(Math.min(...ts.map((t) => Date.parse(t.customer_turn_at))) - 3 * 864e5).toISOString();
    const hi = new Date(Math.max(...ts.map((t) => Date.parse(t.customer_turn_at))) + 3 * 864e5).toISOString();
    const [mq, bq, pq, sq, iq, tq, wq] = await Promise.all([
      sb.from("messages").select("sender, text, created_at, is_aix_generated, staff_writer").eq("conversation_id", c).gte("created_at", lo).lt("created_at", hi).order("created_at").limit(5000),
      sb.from("brain_decision_logs").select("id, created_at, suggested_action, suggested_reply_mode, suggested_check_pattern, decision_source, digest").eq("conversation_id", c).gte("created_at", lo).lt("created_at", hi).order("created_at").limit(3000),
      sb.from("property_pickups").select("created_at, status, sent_at, expired_at").eq("conversation_id", c).lt("created_at", hi).limit(2000),
      sb.from("sent_properties").select("sent_at, recruitment_status, recruitment_checked_at").eq("conversation_id", c).lt("sent_at", hi).limit(2000),
      sb.from("sent_image_properties").select("created_at, facts").eq("conversation_id", c).lt("created_at", hi).limit(2000),
      sb.from("line_tasks").select("task_type, status, created_at, completed_at, result").eq("conversation_id", c).lt("created_at", hi).limit(500),
      sb.from("line_watch_turns").select("id, materials, draft_first, draft_last").in("id", ts.map((t) => t.id)),
    ]);
    const ms: Msg[] = ((mq.data ?? []) as Array<Record<string, unknown>>).map((m) => ({ at: Date.parse(String(m.created_at)), sender: String(m.sender), text: String(m.text ?? ""), aix: !!m.is_aix_generated, writer: (m.staff_writer as string | null) ?? null }));
    const ds = (bq.data ?? []) as Dec[];
    const blocksOf = new Map<number, { chars?: Record<string, number>; empty?: string[] } | null>();
    // 2026-11-25 作業員A（統括役の頼み）: 見張りの下書き（画面に出た文）。ブレインが2段の約束を書き、記録は後で果たす AIX（suggested_reply_mode=aix）の番を分ける元
    const draftOf = new Map<number, string>();
    for (const w of (wq.data ?? []) as Array<{ id: number; draft_first: string | null; draft_last: string | null }>) { const l = String(w.draft_last ?? ""); draftOf.set(w.id, l.trim() && !/^\s*__[A-Z_]{2,30}__\s*$/.test(l) ? l : String(w.draft_first ?? "")); }
    for (const w of (wq.data ?? []) as Array<{ id: number; materials: { brain?: { blocks?: { chars?: Record<string, number>; empty?: string[] } } } | null }>) blocksOf.set(w.id, w.materials?.brain?.blocks ?? null);
    let gate: Awaited<ReturnType<typeof loadTurnApplicationRecords>> | null = null;
    for (const t of ts) {
      const at = Date.parse(t.customer_turn_at);
      if (ms.some((m) => m.sender !== "customer" && m.at <= at + 864e5 && POST_APPLY_RE.test(m.text))) { skippedPost++; continue; }
      gate = gate ?? await loadTurnApplicationRecords(sb, c);
      if (turnApplicationReason(gate, new Date(at + 864e5).toISOString())) { skippedPost++; continue; }
      const moves: Msg[] = [];
      for (const m of ms.filter((x) => x.at > at)) { if (m.sender === "customer" || m.at - at >= 864e5) break; moves.push(m); }
      if (!moves.length || !moves.every((m) => m.writer === "takeuchi")) { skippedNotTakeuchi++; continue; }
      const aixLogs = (t.staff_aix ?? []).filter((a) => a.at && a.aix_type).map((a) => ({ at: Date.parse(String(a.at)), aixType: String(a.aix_type) }));
      const kinded = assignAixKinds(moves.map((m): StaffMove => ({ at: m.at, aix: m.aix, writer: m.writer })), aixLogs);
      const firstAt = moves[0].at;
      const dec = [...ds].reverse().find((d) => Date.parse(d.created_at) <= firstAt + 1000 && Date.parse(d.created_at) >= at - 60_000);
      if (!dec) { skippedNoDec++; continue; }
      const decAt = Date.parse(dec.created_at);
      const handKeys = moves.filter((m) => !m.aix).map((m) => shouldBeAixOf(m.text, { mode: "hand" })).filter((s) => s && s.strength === "strong").map((s) => s!.key);
      const cls: TurnClass = turnClassOf(kinded, handKeys);
      const tk = aixKindOfTurn(kinded, handKeys);
      const prevStaff = ms.filter((m) => m.sender !== "customer" && m.at < at && at - m.at <= 864e5).map((m) => m.text);
      const prevFulfil = !!tk && aixFulfilsPrevPromise(tk, prevStaff);
      const prevPromise = ["property_send", "property_check_result", "estimate_sheet"].filter((k) => aixFulfilsPrevPromise(k, prevStaff)).map((k) => (k === "property_send" ? "property" : k));
      const route = brainRouteOf(dec.suggested_reply_mode, dec.suggested_action, dec.decision_source);
      const v = judgeTurn(cls, tk, route);
      const burst: string[] = []; for (let i = ms.findIndex((m) => m.at > at) - 1; i >= 0 && ms[i].sender === "customer"; i--) burst.unshift(ms[i].text);
      const dg = (dec.digest ?? {}) as Record<string, unknown>;
      const pend = ((pq.data ?? []) as Array<{ created_at: string; status: string; sent_at: string | null; expired_at: string | null }>)
        .filter((p) => Date.parse(p.created_at) <= decAt && p.status !== "misattributed" && (!p.sent_at || Date.parse(p.sent_at) > decAt) && (!p.expired_at || Date.parse(p.expired_at) > decAt)).length;
      const checked = ((sq.data ?? []) as Array<{ recruitment_checked_at: string | null }>).filter((s) => s.recruitment_checked_at && Date.parse(s.recruitment_checked_at) <= decAt && decAt - Date.parse(s.recruitment_checked_at) <= 3 * 864e5).length;
      const imgFacts = ((iq.data ?? []) as Array<{ created_at: string; facts: unknown }>).filter((s) => Date.parse(s.created_at) <= decAt && s.facts).length;
      const tasks = (tq.data ?? []) as Array<{ task_type: string; status: string; created_at: string; completed_at: string | null; result: unknown }>;
      const openTasks = tasks.filter((x) => Date.parse(x.created_at) <= decAt && (!x.completed_at || Date.parse(x.completed_at) > decAt)).length;
      const taskResult = tasks.filter((x) => x.result && x.completed_at && Date.parse(x.completed_at) <= decAt && decAt - Date.parse(x.completed_at) <= 3 * 864e5).length;
      const bl = blocksOf.get(t.id) ?? null;
      // 竹内さんは2段（約束の返信→後で AIX）・ブレインの記録は同じ種類の AIX（先後）でも、画面に出た下書きがその種類の約束なら「ブレインも2段の約束を書いた」（今の数え方は変えず印だけ）
      const bDraftPromise = v === "先後" && !!tk && draftPromiseOf(draftOf.get(t.id) ?? "", tk);
      const firstAixAt = kinded.find((m) => m.aix)?.at ?? null;
      rows.push({
        id: t.id, conv: c.slice(0, 8), at: t.customer_turn_at.slice(0, 16), cls, tk, prevFulfil, prevPromise, bDraftPromise, route: route.route, bk: route.kind, src: dec.decision_source, v,
        minDecToAix: firstAixAt ? Math.round((firstAixAt - decAt) / 6e4) : null, burst: classifyCustomerBurst(burst),
        mat: { pend, pp: dg.pp === true, checked, taskResult, openTasks, imgFacts, po: (dg.sn as { po?: number } | undefined)?.po ?? null, mk: dg.mk ?? null, mks: dg.mks === true, ac: dg.ac ? (dg.ac as { answer?: string }).answer ?? "?" : null, ad: dg.ad ? { sb: (dg.ad as { sb?: string }).sb ?? null, pick: (dg.ad as { pick?: string }).pick ?? null } : null, rc: dg.rc ?? null, cp: dg.cp ?? null },
        blocks: bl ? { promise: bl.chars?.promise ?? 0, tasks: bl.chars?.tasks ?? 0, sentProps: bl.chars?.sentProps ?? 0, aixHistory: bl.chars?.aixHistory ?? 0, aixCatalog: bl.chars?.aixCatalog ?? 0, empty: bl.empty ?? [] } : null,
      });
    }
  }
  const tally = new Map<string, Record<string, number>>();
  for (const r of rows) {
    if (r.cls === "reply" && r.route !== "aix") continue;
    const k = `${r.cls}|${r.cls === "reply" ? `brain:${r.bk}` : r.tk}${r.prevFulfil ? "|前の約束" : ""}`;
    const o = tally.get(k) ?? {}; o[String(r.v)] = (o[String(r.v)] ?? 0) + 1; tally.set(k, o);
  }
  console.log(`AIX の番の数え直し（${days}日・竹内さん本人の番 ${rows.length}・申込以降で外した ${skippedPost}・竹内さん以外の手 ${skippedNotTakeuchi}・直前の判断なし ${skippedNoDec}）`);
  for (const [k, o] of [...tally].sort()) console.log(`  ${k}: ${JSON.stringify(o)}`);
  if (arg("json", "")) writeFileSync(arg("json", ""), JSON.stringify(rows, null, 1));
})().catch((e) => { console.error(e); process.exit(1); });
