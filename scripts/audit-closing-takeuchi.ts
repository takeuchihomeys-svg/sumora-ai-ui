// scripts/audit-closing-takeuchi.ts — 竹内さん本人が「決めに行った」番と、送る直前のブレインの一手を並べる（読むだけ・LLM なし・費用0・作業員P・2026-11-23・台帳 #658）
//
// 竹内さん 11/23（P0）「クロージングする際はちゃんと決めに行く、チャンス見極める能力もちゃんとあげる…人間を超えるように徹底的に強化する」。
//   番＝見張りの番（line_watch_turns）のうち、お客様の発言の後の手がすべて竹内さん本人（messages.staff_writer=takeuchi・端末の記録）の番。申込以降は外す（作業員A と同じ門）。
//   竹内さんが決めに行った＝AIX の申込の後押し（application_push・push）・審査の相談の電話（phone_call で連投に「審査」）・手打ちの「申込で抑える／審査に出す」の文。
//   ブレイン＝送る直前の判断（brain_decision_logs の最初の手より前の最新）。apply-readiness の点（7日の窓）・判断の記録の欄の欠け・14日の内に申込に届いたか。
//   数の決め方は app/lib/closing-chance.ts（純関数）。本文は出さない（会話の頭8字・種類・数だけ）。
// 重い読み: 60日の見張りの番と会話ごとの読み。営業時間（JST 9〜22時）は --days=2 --max-conv=10 に絞る（--force で外す）。
// 実行（22時以降）: npx tsx --env-file=<env> scripts/audit-closing-takeuchi.ts [--days=60] [--json=<出力>]
import { createClient } from "@supabase/supabase-js";
import { writeFileSync } from "node:fs";
import { readWatchTurns } from "./lib/prod-yardstick-db";
import { assignAixKinds, type StaffMove } from "./lib/combo-of-moves";
import { POST_APPLY_RE } from "./lib/combo-daily";
import { loadTurnApplicationRecords } from "../app/lib/turn-application-gate-server";
import { turnApplicationReason } from "../app/lib/turn-application-gate";
import { detectApplyReadiness } from "../app/lib/apply-readiness";
import { CLOSE_TEXT_RE, isClosingAix, isBrainClosing, closingVerdictOf, graspGapsOf, closingSummaryOf, CLOSING_GRASP_FIELDS, type ClosingRow } from "../app/lib/closing-chance";

const arg = (k: string, d: string) => process.argv.find((a) => a.startsWith(`--${k}=`))?.slice(k.length + 3) ?? d;

(async () => {
  const sb = createClient(process.env.NEXT_PUBLIC_SUPABASE_URL ?? "", process.env.SUPABASE_SERVICE_ROLE_KEY ?? "", { auth: { persistSession: false } });
  let days = Number(arg("days", "60")) || 60, maxConv = Number(arg("max-conv", "400")) || 400;
  const h = (new Date().getUTCHours() + 9) % 24;
  if (h >= 9 && h < 22 && !process.argv.includes("--force")) { days = Math.min(days, 2); maxConv = Math.min(maxConv, 10); console.log(`営業時間なので --days=${days} --max-conv=${maxConv} に絞った`); }
  const turns = await readWatchTurns(sb, new Date(Date.now() - days * 864e5).toISOString());
  const byConv = new Map<string, typeof turns>();
  for (const t of turns) byConv.set(t.conversation_id, [...(byConv.get(t.conversation_id) ?? []), t]);
  const rows: ClosingRow[] = [];
  let skippedPost = 0, skippedNotTakeuchi = 0, skippedNoDec = 0;
  for (const [c, ts] of [...byConv].slice(0, maxConv)) {
    const lo = new Date(Math.min(...ts.map((t) => Date.parse(t.customer_turn_at))) - 8 * 864e5).toISOString();
    const hi = new Date(Math.max(...ts.map((t) => Date.parse(t.customer_turn_at))) + 2 * 864e5).toISOString();
    const [mq, bq, uq] = await Promise.all([
      sb.from("messages").select("sender, text, created_at, is_aix_generated, staff_writer").eq("conversation_id", c).gte("created_at", lo).lt("created_at", hi).order("created_at").limit(5000),
      sb.from("brain_decision_logs").select("created_at, suggested_action, suggested_reply_mode, digest").eq("conversation_id", c).gte("created_at", lo).lt("created_at", hi).order("created_at").limit(3000),
      // 申込の AIX の下の形（push＝後押し／confirm＝確定／format＝申込書）。staff_aix の aix_type には下の形が無い＝aix_usage_logs の app_sub_mode で見る（60日の申込の AIX は format 42・push 2）
      sb.from("aix_usage_logs").select("created_at, aix_type, app_sub_mode").eq("conversation_id", c).eq("aix_type", "application_push").gte("created_at", lo).lt("created_at", hi).limit(500),
    ]);
    const subLogs = ((uq.data ?? []) as Array<{ created_at: string; app_sub_mode: string | null }>).map((u) => ({ at: Date.parse(u.created_at), sub: u.app_sub_mode }));
    const subOf = (at: number) => subLogs.filter((u) => Math.abs(u.at - at) <= 10 * 6e4).sort((a, b) => Math.abs(a.at - at) - Math.abs(b.at - at))[0]?.sub ?? null;
    const ms = ((mq.data ?? []) as Array<Record<string, unknown>>).map((m) => ({ at: Date.parse(String(m.created_at)), sender: String(m.sender), text: String(m.text ?? ""), aix: !!m.is_aix_generated, writer: (m.staff_writer as string | null) ?? null, createdAt: String(m.created_at) }));
    const ds = (bq.data ?? []) as Array<{ created_at: string; suggested_action: string | null; suggested_reply_mode: string | null; digest: Record<string, unknown> | null }>;
    const gate = await loadTurnApplicationRecords(sb, c);
    for (const t of ts) {
      const at = Date.parse(t.customer_turn_at);
      if (ms.some((m) => m.sender !== "customer" && m.at <= at + 864e5 && POST_APPLY_RE.test(m.text))) { skippedPost++; continue; }
      if (turnApplicationReason(gate, new Date(at).toISOString())) { skippedPost++; continue; }
      const moves = [] as typeof ms;
      for (const m of ms.filter((x) => x.at > at)) { if (m.sender === "customer" || m.at - at >= 864e5) break; moves.push(m); }
      if (!moves.length || !moves.every((m) => m.writer === "takeuchi")) { skippedNotTakeuchi++; continue; }
      const burst: string[] = []; for (let i = ms.findIndex((m) => m.at > at) - 1; i >= 0 && ms[i].sender === "customer"; i--) burst.unshift(ms[i].text);
      const custText = burst.join("\n");
      const aixLogs = (t.staff_aix ?? []).filter((a: { at?: string; aix_type?: string }) => a.at && a.aix_type).map((a: { at?: string; aix_type?: string }) => ({ at: Date.parse(String(a.at)), aixType: String(a.aix_type) }));
      const kinded = assignAixKinds(moves.map((m): StaffMove => ({ at: m.at, aix: m.aix, writer: m.writer })), aixLogs)
        .map((m) => (m.aix && m.aixKind === "application_push" ? { ...m, aixKind: `application_push/${subOf(m.at) ?? "unknown"}` } : m));
      const aixClose = kinded.find((m) => m.aix && isClosingAix(m.aixKind, custText));
      const handClose = moves.find((m) => !m.aix && CLOSE_TEXT_RE.test(m.text));
      const takeuchiClose = !!aixClose || !!handClose;
      const firstAt = moves[0].at;
      const dec = [...ds].reverse().find((d) => Date.parse(d.created_at) <= firstAt + 1000 && Date.parse(d.created_at) >= at - 60_000);
      if (!dec) { skippedNoDec++; continue; }
      const brainClose = isBrainClosing(dec.suggested_action, dec.suggested_reply_mode, custText);
      const hist = ms.filter((m) => m.at <= at).map((m) => ({ sender: m.sender, text: m.text, createdAt: m.createdAt }));
      const ar = detectApplyReadiness(hist, at);
      // 7日の窓の外（8〜28日前）にだけある合図（APPLY_READINESS_WIDE の的: 見積書・内覧の希望・割引）
      const in7 = new Set(ar.hits.map((x) => x.key));
      const wide = new Set<string>();
      for (const k of [1, 2, 3]) for (const x of detectApplyReadiness(hist, at - k * 7 * 864e5).hits) if (!in7.has(x.key)) wide.add(x.key);
      const applied14 = turnApplicationReason(gate, new Date(at + 14 * 864e5).toISOString()) ? true : (Date.now() - at >= 14 * 864e5 ? false : null);
      rows.push({
        id: t.id, conv: c.slice(0, 8), at: t.customer_turn_at.slice(0, 16), takeuchiClose, closeHow: aixClose ? `aix:${aixClose.aixKind}` : handClose ? "hand" : null,
        brainClose, brainAct: dec.suggested_reply_mode === "aix" ? dec.suggested_action : dec.suggested_reply_mode, readiness: ar.windowCount ? ar.score : null, level: ar.windowCount ? ar.level : null,
        verdict: closingVerdictOf(takeuchiClose, brainClose), applied14, gaps: graspGapsOf(dec.digest), wideHits: [...wide],
      });
    }
  }
  const s = closingSummaryOf(rows);
  console.log(`決めに行く番の見極め（${days}日・竹内さん本人の番 ${rows.length}・申込以降で外した ${skippedPost}・竹内さん以外の手 ${skippedNotTakeuchi}・直前の判断なし ${skippedNoDec}）`);
  console.log(`  竹内さんが決めに行った ${s.takeuchiClose}・ブレインが決めに行った ${s.brainClose}・両方 ${s.both}・見逃し ${s.missed}・早すぎ ${s.early}`);
  console.log(`  主: 決めに行くべき番でブレインも決めに行った ${s.closeRate ?? "—"}%・ブレインが決めに行った番の当たり ${s.brainPrecision ?? "—"}%`);
  console.log(`  竹内さんが決めに行った後 14日で申込 ${s.afterTakeuchiClose.applied}/${s.afterTakeuchiClose.n}・早すぎの番の後 ${s.afterBrainEarly.applied}/${s.afterBrainEarly.n}`);
  console.log(`  決めに行った番の統括の材料の欠け: ${CLOSING_GRASP_FIELDS.map((f) => `${f.label} ${s.gapCount[f.key] ?? 0}`).join("・")}`);
  const lv = (v: string) => { const xs = rows.filter((r) => r.verdict === v); const c2: Record<string, number> = {}; for (const r of xs) c2[r.level ?? "—"] = (c2[r.level ?? "—"] ?? 0) + 1; return JSON.stringify(c2); };
  console.log(`  申込予測の度合い: 見逃し ${lv("missed")}・早すぎ ${lv("early")}・両方 ${lv("both")}`);
  // --candidates: APPLY_READINESS_WIDE の試験の問題の候補＝見逃しの番のうち、7日の窓の外に見積書・内覧の希望・割引の合図がある番（申込以降は上で外している）
  if (process.argv.includes("--candidates")) {
    const WIDE_KEYS = new Set(["estimate_sent", "cust_viewing_req", "discount_told"]);
    const cs = rows.filter((r) => r.verdict === "missed" && (r.wideHits ?? []).some((k) => WIDE_KEYS.has(k)));
    console.log(`  APPLY_READINESS_WIDE の問題の候補（見逃し×窓の外の合図）${cs.length}: ${cs.map((r) => `${r.id}（${r.conv}・${r.at}Z・${r.closeHow}・窓の外 ${(r.wideHits ?? []).filter((k) => WIDE_KEYS.has(k)).join("+")}・7日の点 ${r.readiness ?? "—"}）`).join(" / ") || "なし"}`);
  }
  if (arg("json", "")) writeFileSync(arg("json", ""), JSON.stringify(rows, null, 1));
})().catch((e) => { console.error(e); process.exit(1); });
