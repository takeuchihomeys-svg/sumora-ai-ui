// scripts/audit-writer-linkage.ts — 統括が渡す欄ごとに ①書き手に届いているか ②届いた欄が下書きの文に入ったか を本番の番で数える（読むだけ・LLM なし・費用0）
//
// 2026-11-21 作業員L（竹内さん「LINE の文生成のところとの連携も細かく強化する・徹底的に」・台帳 #466・統括役の頼み）。連携の地図（linkage-map）の持ち主として。
//   本番の番＝下書きを画面に出した会話（conversations.ai_draft_shown_at が窓の中）。その会話の今のブレインの答え（last_brain_meta）と出した下書き（ai_draft_shown）を突き合わせる。
//   ブレインの答えが下書きより新しい会話は、同じ番でないので外す（数えに入れない）。テストの会話は外す。
//   欄の表:
//     指示書（conductor_brief）… 作業員I の compose-brief-uptake.briefUptake（欄ごとに入るべき語・数の事実・約束・いつの言葉・誘い）＝②
//     決めた事（delivery-check の DELIVERY_FIELDS: 重点・約束・依頼・事実の出所・こちら側・潜在・刺さり・近い番・狙い）＝①（書き手の注記に入るか）と②（値の頭12字が下書きにあるか）
//     今の状況（situation_now の our_items・promises_open）・お客様ごとの計画（customer_plan）・教訓（conductor_lessons）＝①は配線とスイッチ、②は値がある番の数
//   届かない・入らない訳: a 欄が無い／b 配線が無い／c 書き手の指示で使われていない（渡したのに入らない）／d スイッチが off
// 実行: npx tsx --env-file=.env.local scripts/audit-writer-linkage.ts [--hours=24] [--max=60] [--json=<出力>]
import { createClient } from "@supabase/supabase-js";
import { writeFileSync } from "node:fs";
import { briefUptake, tokensOfValue } from "../app/lib/compose-brief-uptake";
import { deliveryOfTurn, DELIVERY_FIELDS } from "../app/lib/delivery-check";
import { isTestConversation, isNoLineTestConversation } from "../app/lib/test-conversations";
import { LINKAGE_SWITCH_DEFAULTS } from "../app/lib/linkage-switch-defaults";

const arg = (k: string, d: string) => process.argv.find((a) => a.startsWith(`--${k}=`))?.slice(k.length + 3) ?? d;
const squash = (s: string) => s.normalize("NFKC").replace(/[\s、。・「」（）()／/：:→＝！!？?]/g, "");
const sw = (k: string) => (process.env[k] ?? (LINKAGE_SWITCH_DEFAULTS as Record<string, string>)[k] ?? "off").trim().toLowerCase();

type Row = { id: string; ai_draft_shown: string | null; ai_draft_shown_at: string | null; brain_analyzed_at: string | null; last_brain_meta: Record<string, unknown> | null };
(async () => {
  const hours = Number(arg("hours", "24")) || 24, max = Number(arg("max", "60")) || 60;
  const sb = createClient(process.env.NEXT_PUBLIC_SUPABASE_URL ?? "", process.env.SUPABASE_SERVICE_ROLE_KEY ?? "", { auth: { persistSession: false } });
  const since = new Date(Date.now() - hours * 36e5).toISOString();
  const { data, error } = await sb.from("conversations").select("id, ai_draft_shown, ai_draft_shown_at, brain_analyzed_at, last_brain_meta")
    .gte("ai_draft_shown_at", since).order("ai_draft_shown_at", { ascending: false }).limit(max);
  if (error) throw new Error(error.message);
  const all = ((data ?? []) as Row[]).filter((r) => !isTestConversation(r.id) && !isNoLineTestConversation(r.id) && r.last_brain_meta && r.ai_draft_shown);
  // 同じ番だけ（ブレインの答えが下書きを出す前）
  const rows = all.filter((r) => !r.brain_analyzed_at || !r.ai_draft_shown_at || Date.parse(r.brain_analyzed_at) <= Date.parse(r.ai_draft_shown_at) + 5_000);
  console.log(`統括 → 書き手の連携（${hours}時間・下書きを出した会話 ${all.length}・同じ番 ${rows.length}）`);

  // ① 指示書の欄（②＝下書きに入ったか）
  const up = new Map<string, { n: number; used: number }>();
  for (const r of rows) for (const it of briefUptake(r.last_brain_meta!.conductor_brief as never, r.ai_draft_shown ?? "")) {
    const c = up.get(it.section) ?? { n: 0, used: 0 }; c.n++; if (it.used) c.used++; up.set(it.section, c);
  }
  console.log(`\n## 指示書（conductor_brief）の欄 → 下書きに入ったか（作業員I の briefUptake）・書き手への配線: COMPOSE_BRIEF_ROLES=${sw("COMPOSE_BRIEF_ROLES")}（返信のみ・AIX の2通目は配線なし=b）`);
  for (const [k, c] of up) console.log(`${k.padEnd(14)} 渡す値のある番 ${c.n}・下書きに入った ${c.used}（${c.n ? Math.round((100 * c.used) / c.n) : 0}%）`);

  // ② 決めた事（DELIVERY_FIELDS）: ①書き手の注記に入るか（静的の配線＋値の頭12字）・②下書きに入ったか
  console.log(`\n## 決めた事（delivery-check の欄）: 値のある番 → ①書き手の注記に届いた → ②下書きに入った ／ AIX の2通目の配線`);
  const table: Array<Record<string, unknown>> = [];
  for (const f of DELIVERY_FIELDS) {
    let val = 0, writerOk = 0, inDraft = 0; const whyNo: Record<string, number> = {};
    for (const r of rows) {
      const m = r.last_brain_meta!; const v = f.value(m);
      if (!v) continue;
      val++;
      const d = deliveryOfTurn(m)[f.key];
      if (d?.writer === "ok") writerOk++; else whyNo[String(d?.writer)] = (whyNo[String(d?.writer)] ?? 0) + 1;
      // ②は値の語（作業員I の tokensOfValue: 単位つきの数か、漢字・カタカナの語 最大4つ）のどれかが下書きにあるか（指示の文は言い換えられるので頭12字の一致では測らない）
      const toks = tokensOfValue(v).map(squash).filter((x) => x.length >= 2); const dr = squash(r.ai_draft_shown ?? "");
      if (toks.some((x) => dr.includes(x))) inDraft++;
    }
    const aix2 = f.wiring.aix2 === true ? "届く" : `届かない(${f.wiring.aix2})`;
    table.push({ key: f.key, label: f.label, val, writerOk, inDraft, whyNo, aix2 });
    console.log(`${f.key.padEnd(15)} 値 ${String(val).padStart(2)} → ①届いた ${writerOk}${Object.keys(whyNo).length ? `（届かない: ${Object.entries(whyNo).map(([k, n]) => `${k}=${n}`).join("・")}）` : ""} → ②下書き ${inDraft} ／ 2通目 ${aix2}`);
  }

  // ③ 今の状況・計画・教訓（配線とスイッチ・値のある番の数）
  const sn = rows.filter((r) => r.last_brain_meta!.situation_now);
  const ouOpen = sn.filter((r) => ((r.last_brain_meta!.situation_now as { our_items?: Array<{ answered?: boolean | null }> }).our_items ?? []).some((o) => o.answered === false)).length;
  const poOpen = sn.filter((r) => ((r.last_brain_meta!.situation_now as { promises_open?: unknown[] }).promises_open ?? []).length > 0).length;
  const plan = rows.filter((r) => (r.last_brain_meta!.conductor_brief as { plan?: unknown } | undefined)?.plan).length;
  const lessons = rows.filter((r) => ((r.last_brain_meta!.conductor_lessons as { ids?: unknown[] } | undefined)?.ids ?? []).length > 0).length;
  console.log(`\n## 今の状況・計画・教訓`);
  console.log(`situation_now      値 ${sn.length}（答えの無い前の項目 ${ouOpen}・開いている約束 ${poOpen}）→ ①返信: SITUATION_WRITER_NOTE=${sw("SITUATION_WRITER_NOTE")}・2通目: SITUATION_WRITER_NOTE_AIX=${sw("SITUATION_WRITER_NOTE_AIX")} → ②語の網なし（測れない）`);
  console.log(`customer_plan      値 ${plan}（指示書の plan の欄・CONDUCTOR_BRIEF_PLAN=${sw("CONDUCTOR_BRIEF_PLAN")}）→ ①書き手の役目の表に入れていない（b）`);
  console.log(`conductor_lessons  値 ${lessons}（CONDUCTOR_LESSONS=${sw("CONDUCTOR_LESSONS")}・学びの行が0の間は読まない）→ ①書き手へは配線しない設計（統括の材料だけ）`);
  if (arg("json", "")) writeFileSync(arg("json", ""), JSON.stringify({ hours, n: rows.length, brief: Object.fromEntries(up), fields: table, situation: { n: sn.length, ouOpen, poOpen }, plan, lessons }, null, 1));
})().catch((e) => { console.error(e instanceof Error ? e.message : String(e)); process.exit(1); });
