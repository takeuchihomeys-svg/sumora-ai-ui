// scripts/exam-aix-text-snap.ts — 試験の「AIX の文」の問題に、その番の時点の材料の写し（q.snap）を持たせる（読むだけ・LLM なし）
//
// 2026-10-28 作業員5（作業員3の引き継ぎ 1）: 問題は会話だけを持ち、売上サポの行・登録の条件・ブレインの判断は試験の会話（YUMA4 等）の今の行を読んでいた
//   （その番の材料が届かない＋別の作業の残りが混ざる）。RECOMMEND_SECOND_WISH_NG・PICKUP_FOCUS_ONE が試験で効いたか測れなかった。
//   写す物（その番の時点＝押した時刻・✨2通目は押した時刻＋1分まで）:
//     customerConditions … aix_generate_log.conditions_snapshot.customer_conditions（画面が送った条件の文字・その番より前で一番新しい物）
//     testPropertyCustomer … property_customers の条件の列（⚠ 履歴が無い＝今の行。その番より後に直した行は notes に出す）
//     testSnapshot.pickups / sentImages / aixUsage … property_pickups・sent_image_properties・aix_usage_logs のその番より前の行
//     testBrainMeta … brain_decision_logs.digest（その番より前で一番新しいブレインの判断の要点）から戻せる欄だけ
//       （⚠ turn_contract.situation は digest に残っていない＝AIX_CONTRACT_SITUATION は写しでは測れない）
//   書く場所は questions.json の q.snap（問題の印 hash には入れない＝今までの取り置き・結果はそのまま）。使うのは exam-aix-text.ts --snap の時だけ。
//   入口は isTestModeAllowed かつテスト専用の会話の時だけ写しを読む（app/lib/exam-test-snapshot.ts）。
//   個人の値: 条件の文字・自由記述は maskPII を通し、piiValueSignal が残れば写さない。
// 実行: npx tsx --env-file=.env.local scripts/exam-aix-text-snap.ts [--only=<id,…>] [--dry]
import { createClient } from "@supabase/supabase-js";
import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { examCacheRoot } from "./lib/llm-cassette";
import { maskPII } from "../app/lib/pii-mask";
import { piiValueSignal } from "../app/lib/test-pii-guard";
import type { AixQuestion } from "./lib/exam-aix-text";
import { manYen } from "../app/lib/man-yen";

const sb = createClient(process.env.NEXT_PUBLIC_SUPABASE_URL ?? "", process.env.SUPABASE_SERVICE_ROLE_KEY ?? process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY ?? "");
const arg = (k: string, d = "") => process.argv.find((a) => a.startsWith(`--${k}=`))?.slice(k.length + 3) ?? d;
const QFILE = join(examCacheRoot(), "aix-text-exam", "questions.json");
const only = arg("only").split(",").map((s) => s.trim()).filter(Boolean);

export type AixQuestionSnap = {
  madeAt: string;
  cut: string;
  customerConditions?: string;
  testPropertyCustomer?: Record<string, unknown>;
  testSnapshot?: { pickups: unknown[]; sentImages: unknown[]; aixUsage: unknown[] };
  testBrainMeta?: Record<string, unknown>;
  notes: string[];
};

const PC_COLS = "desired_area, preferences, other_requests, floor_plan, rent_max, rent_min, pet, building_age, walk_minutes, initial_cost_limit, move_in_time, floor_area_min, ng_points, additional_conditions, updated_at";
const clean = (v: unknown): string | null => {
  if (typeof v !== "string" || !v.trim()) return null;
  const m = maskPII(v);
  return piiValueSignal(m) ? null : m;
};

/** brain_decision_logs.digest（toFreshDigest＋brainDecisionDigestExtra）から、AIX の入口が読む欄だけ戻す */
export function brainMetaFromDigest(d: Record<string, unknown> | null | undefined): Record<string, unknown> | null {
  if (!d || typeof d !== "object") return null;
  const s = (k: string) => (typeof d[k] === "string" && (d[k] as string).trim() ? (d[k] as string).trim() : null);
  const out: Record<string, unknown> = {
    action: s("aix"), customer_intent: s("intent"), customer_emotion: s("emo"), current_property: s("prop"),
    reply_direction: s("dir"), future_timeline: s("timeline"), purchase_signal_level: s("sig"), checkpoint_stage: s("cp"),
    closing_strategy: s("cs"), condition_change_type: s("cond"), hesitancy_pattern: s("hes"),
    customer_questions: Array.isArray(d.q) ? (d.q as unknown[]).filter((x) => typeof x === "string") : [],
    // 2026-10-28 digest の st（turn_contract.situation・BRAIN_DIGEST_SITUATION=on の後の行だけ）
    ...(s("st") ? { turn_contract: { situation: s("st") } } : {}),
  };
  for (const k of Object.keys(out)) if (out[k] === null) delete out[k];
  return Object.keys(out).length ? out : null;
}

async function convOf(q: AixQuestion): Promise<string | null> {
  if (q.route === "aix-template-generate" && q.kind === "tpl") {
    const [p8, at] = q.src.split("@");
    const { data } = await sb.from("aix_generate_log").select("conversation_id").eq("generated_at", at).like("conversation_id", `${p8}%`).limit(1);
    return (data?.[0] as { conversation_id?: string } | undefined)?.conversation_id ?? null;
  }
  const { data } = await sb.from("aix_usage_logs").select("conversation_id").eq("id", q.src).maybeSingle();
  return (data as { conversation_id?: string } | null)?.conversation_id ?? null;
}

async function snapOf(q: AixQuestion): Promise<AixQuestionSnap | null> {
  const conv = await convOf(q);
  if (!conv) return null;
  const notes: string[] = [];
  // その番の時点: 押した時刻（✨2通目は押した後に作る＝押下の行を含める +1分）。✨この会話に合った文（tpl）は生成の時刻より前
  const cutMs = Date.parse(q.at) + (q.kind === "second" ? 60_000 : q.kind === "tpl" ? -1000 : 1000);
  const cut = new Date(cutMs).toISOString();
  const snap: AixQuestionSnap = { madeAt: new Date().toISOString(), cut, notes };

  // 条件の文字（画面が送った物）: aix/action の番は、その押下の生成の記録（同じボタン・押す前60分〜押した1分後・✨の記録でない）の値をそのまま
  //   （見積書等は画面が条件を送らない＝null が本番の通り）。✨（aix-template-generate）は入口が登録の条件の行から組む＝下で行から作る
  if (q.route === "aix/action") {
    const { data: g } = await sb.from("aix_generate_log").select("conditions_snapshot, generated_at").eq("conversation_id", conv).eq("action_type", q.aixType)
      .gte("generated_at", new Date(Date.parse(q.at) - 60 * 60_000).toISOString()).lte("generated_at", new Date(Date.parse(q.at) + 60_000).toISOString())
      .order("generated_at", { ascending: false }).limit(5);
    const own = ((g ?? []) as Array<{ conditions_snapshot?: { source?: unknown; customer_conditions?: unknown } | null }>).find((r) => r.conditions_snapshot?.source !== "aix-template-generate");
    const raw = own?.conditions_snapshot?.customer_conditions;
    const cc = clean(raw);
    if (cc) snap.customerConditions = cc;
    else notes.push(own ? (raw ? "条件の文字に個人の値（写さない）" : "その番の画面は条件を送っていない") : "その番の生成の記録なし（条件の文字なし）");
  }

  // 登録の条件の行（履歴なし＝今の行）
  const { data: cv } = await sb.from("conversations").select("property_customer_id").eq("id", conv).maybeSingle();
  const pcId = (cv as { property_customer_id?: string | null } | null)?.property_customer_id ?? null;
  if (pcId) {
    const { data: pc } = await sb.from("property_customers").select(PC_COLS).eq("id", pcId).maybeSingle();
    if (pc) {
      const row: Record<string, unknown> = {};
      for (const [k, v] of Object.entries(pc as Record<string, unknown>)) {
        if (k === "updated_at") continue;
        if (typeof v === "string") { const c = clean(v); if (c) row[k] = c; } else if (v !== null && v !== undefined) row[k] = v;
      }
      snap.testPropertyCustomer = row;
      // ✨の入口の customerConditions の組み立て（aix-template-generate の DB の代わり・同じ形）
      if (q.route === "aix-template-generate") {
        const man = (v: unknown) => (typeof v === "number" ? manYen(v) : String(v));
        snap.customerConditions = [
          row.desired_area ? `エリア: ${row.desired_area}` : "", row.floor_plan ? `間取り: ${row.floor_plan}` : "",
          row.rent_max ? `家賃上限: ${man(row.rent_max)}万円` : "", row.walk_minutes ? `駅徒歩: ${row.walk_minutes}分以内` : "",
          row.move_in_time ? `入居希望: ${row.move_in_time}` : "", row.preferences ? `希望: ${row.preferences}` : "",
          row.ng_points ? `NG条件: ${row.ng_points}` : "", row.other_requests ? `その他: ${row.other_requests}` : "",
        ].filter(Boolean).join(" / ").slice(0, 1000) || undefined;
      }
      const up = (pc as { updated_at?: string | null }).updated_at;
      if (up && Date.parse(up) > cutMs) notes.push(`登録の条件は今の行（その番の後 ${up.slice(0, 10)} に更新）`);
    }
  } else notes.push("登録の条件の行なし");

  // 売上サポの行・送った資料の読み・AIX の履歴
  const [pk, si, au] = await Promise.all([
    sb.from("property_pickups").select("id, rank, recommended, score, verdict, reason_codes, created_at, property_name, room_no, terms, location, equipment, sent_at")
      .eq("conversation_id", conv).lte("created_at", cut).order("created_at", { ascending: false }).limit(60),
    sb.from("sent_image_properties").select("property_name, room_no, created_at, facts")
      .eq("conversation_id", conv).lte("created_at", cut).gte("created_at", new Date(cutMs - 14 * 86400_000).toISOString()).order("created_at", { ascending: false }).limit(60),
    sb.from("aix_usage_logs").select("aix_type, check_pattern, send_keyword, created_at, picker_choices")
      .eq("conversation_id", conv).lte("created_at", cut).order("created_at", { ascending: false }).limit(30),
  ]);
  // 送った印（sent_at）がその番より後の物は、その番の時点では送っていない
  const pickups = ((pk.data ?? []) as Array<Record<string, unknown>>).map((r) => (r.sent_at && Date.parse(String(r.sent_at)) > cutMs ? { ...r, sent_at: null } : r));
  const aixUsage = ((au.data ?? []) as Array<Record<string, unknown>>).map((r) => ({ ...r, send_keyword: clean(r.send_keyword) }));
  snap.testSnapshot = { pickups, sentImages: (si.data ?? []) as unknown[], aixUsage };

  // ブレインの判断の要点
  const { data: bd } = await sb.from("brain_decision_logs").select("digest, created_at").eq("conversation_id", conv).lte("created_at", cut).not("digest", "is", null)
    .order("created_at", { ascending: false }).limit(1);
  const meta = brainMetaFromDigest((bd?.[0] as { digest?: Record<string, unknown> } | undefined)?.digest);
  if (meta) {
    for (const k of ["closing_strategy", "reply_direction", "current_property", "future_timeline"]) if (typeof meta[k] === "string") { const c = clean(meta[k]); if (c) meta[k] = c; else delete meta[k]; }
    snap.testBrainMeta = meta;
    const age = (cutMs - Date.parse(String((bd?.[0] as { created_at?: string }).created_at))) / 3600_000;
    if (age > 24) notes.push(`ブレインの判断は ${Math.round(age)} 時間前の物`);
  } else notes.push("ブレインの判断の記録なし");
  return snap;
}

(async () => {
  const j = JSON.parse(readFileSync(QFILE, "utf8")) as { questions: Array<AixQuestion & { snap?: AixQuestionSnap }> };
  let n = 0;
  for (const q of j.questions) {
    if (only.length && !only.some((o) => q.id.includes(o))) continue;
    const s = await snapOf(q);
    if (!s) { console.log(`${q.id}: 元の会話が分からない（写さない）`); continue; }
    q.snap = s; n++;
    const t = s.testSnapshot!;
    console.log(`${q.id}: 条件${s.customerConditions ? "○" : "×"} 登録${s.testPropertyCustomer ? "○" : "×"} 売上サポ ${t.pickups.length}（ng あり ${t.pickups.filter((r) => ((r as { equipment?: { match?: Array<{ result?: string }> } }).equipment?.match ?? []).some((m) => m?.result === "ng")).length}）・資料の読み ${t.sentImages.length}・AIX ${t.aixUsage.length}・ブレイン${s.testBrainMeta ? `○(${Object.keys(s.testBrainMeta).join(",")})` : "×"}${s.notes.length ? `／${s.notes.join("・")}` : ""}`);
  }
  if (!process.argv.includes("--dry")) writeFileSync(QFILE, JSON.stringify(j, null, 1));
  console.log(`\n写し ${n}問${process.argv.includes("--dry") ? "（--dry: 書かない）" : ` → ${QFILE}`}`);
})().catch((e) => { console.error(e); process.exit(1); });
