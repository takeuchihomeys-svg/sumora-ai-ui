// scripts/audit-apply-precursor.ts
// 実行: npx tsx --env-file=.env.local scripts/audit-apply-precursor.ts [--days=7]
//
// 2026-09-20 竹内「過去の成約データや直近の会話から学習して」:
//   「申込になりそう」を**申込の話が出る前**に見つけるための正解データを作る。
//   群A: 申込に到達した会話 → 申込AIXの直前N日に何が起きていたか
//   群B: 申込に到達していない会話 → 同じ長さの窓で同じ物を数える（**対照群**）
//   対照群が無いと何でも予測に見える（設計知見「線を引いたら外れた側の中身を必ず読む」）。
// 読み取りのみ。
import { createClient } from "@supabase/supabase-js";
const sb = createClient(process.env.NEXT_PUBLIC_SUPABASE_URL ?? "", process.env.SUPABASE_SERVICE_ROLE_KEY ?? process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY ?? "");
const arg = (k: string, d = "") => (process.argv.find((a) => a.startsWith(`--${k}=`)) ?? `--${k}=${d}`).split("=").slice(1).join("=");
const WINDOW_D = Number(arg("days", "7"));
const APPLIED = ["applying", "application_push", "screening", "closed_won"];
const APPLY_AIX = ["application_push", "application_confirm"];

type Msg = { sender: string; text: string; created_at: string };

/** applying_pattern の turning_point / key_success_factors から拾った候補の合図 */
const SIGNALS: Array<{ key: string; label: string; who: "staff" | "customer"; re: RegExp }> = [
  { key: "push_one", label: "1件に絞って強く推した", who: "staff", re: /特に(?:オススメ|おすすめ|お勧め)|一番(?:オススメ|おすすめ)|かなりオススメ|イチオシ|1番手/ },
  { key: "estimate", label: "見積書を送った", who: "staff", re: /御見積書|お見積書|初期費用.{0,8}(?:御|お)?見積/ },
  { key: "discount", label: "割引・還元を伝えた", who: "staff", re: /割引させて|最大限割引|還元|節約出来|お安く/ },
  { key: "relieve", label: "審査・保証の不安を解消した", who: "staff", re: /独立系|審査(?:基準)?(?:が)?(?:緩|ゆる|通りやす)|保証会社.{0,12}(?:可能|対応|交渉|確認)|保証人(?:なし|不要)|キャンセル(?:料)?(?:は)?(?:無料|かかりま)/ },
  { key: "viewed", label: "内覧・待ち合わせをした", who: "staff", re: /待ち合わせ|待合せ|現地エントランス|本日はご内覧|お時間頂きありがとう/ },
  { key: "cust_positive", label: "お客様が前向きな反応", who: "customer", re: /良さそう|いいですね|良いですね|気に入|素敵|ここ(?:が|に)し|これ(?:が|に)し|いい感じ/ },
  { key: "cust_cost_q", label: "お客様が自ら費用を聞いた", who: "customer", re: /初期費用|いくら|費用.{0,6}(?:は|って)|総額|手数料|家賃.{0,4}(?:は|って)/ },
  { key: "cust_proc_q", label: "お客様が手続き・審査を聞いた", who: "customer", re: /審査|保証会社|必要(?:な)?(?:もの|書類)|書類|申込|申し込|何が(?:いる|要る)|流れ/ },
  { key: "cust_named", label: "お客様が物件を名指しした", who: "customer", re: /号室|この(?:お?部屋|物件)|こちらの(?:お?部屋|物件)|[0-9０-９]{3,4}(?:号)?(?:室)?で/ },
  { key: "cust_move_q", label: "お客様が入居時期を聞いた・言った", who: "customer", re: /入居(?:日|時期|可能)|いつから|何日から|引っ越し(?:は|日)/ },
  { key: "cust_viewing_req", label: "お客様が内覧を希望した", who: "customer", re: /見てみたい|内覧|内見|見学|見たいです|ご案内(?:して|お願い)/ },
];

function countIn(msgs: Msg[], from: number, to: number) {
  const out: Record<string, number> = {};
  for (const s of SIGNALS) {
    const hit = msgs.some((m) => {
      const t = Date.parse(m.created_at);
      if (!(t >= from && t <= to)) return false;
      const isCust = m.sender === "customer";
      if (s.who === "customer" && !isCust) return false;
      if (s.who === "staff" && isCust) return false;
      return s.re.test(m.text ?? "");
    });
    out[s.key] = hit ? 1 : 0;
  }
  return out;
}

async function main() {
  const convs: Array<Record<string, unknown>> = [];
  for (let from = 0; ; from += 1000) {
    const { data, error } = await sb.from("conversations").select("id, customer_name, status, created_at, updated_at").range(from, from + 999);
    if (error) { console.error(error.message); process.exit(1); }
    if (!data?.length) break;
    convs.push(...(data as Array<Record<string, unknown>>));
    if (data.length < 1000) break;
  }
  const applied = convs.filter((c) => APPLIED.includes(String(c.status ?? "")));
  const notApplied = convs.filter((c) => !APPLIED.includes(String(c.status ?? "")) && ["proposing", "viewing", "hearing", "property_recommendation", "condition_hearing", "availability_check", "estimate_request"].includes(String(c.status ?? "")));
  console.log(`=== 群A 申込に到達 ${applied.length}件 / 群B 未到達（提案中など）${notApplied.length}件 ===`);
  console.log(`  窓: 基準時刻の直前 ${WINDOW_D} 日\n`);

  const tally = { A: {} as Record<string, number>, B: {} as Record<string, number> };
  let nA = 0, nB = 0;

  // 群A: 申込AIXの時刻を基準に、その直前N日
  for (const c of applied) {
    const { data: ap } = await sb.from("aix_usage_logs")
      .select("created_at").eq("conversation_id", c.id as string).in("aix_type", APPLY_AIX)
      .not("sent_at", "is", null).order("created_at", { ascending: true }).limit(1);
    if (!ap?.length) continue;                       // 申込AIXを押していない会話は基準が取れない
    const base = Date.parse(String(ap[0].created_at));
    const { data: msgs } = await sb.from("messages")
      .select("sender, text, created_at").eq("conversation_id", c.id as string)
      .lt("created_at", new Date(base).toISOString()).order("created_at", { ascending: false }).limit(200);
    const list = ((msgs ?? []) as Msg[]).filter((m) => m.text);
    const r = countIn(list, base - WINDOW_D * 86400_000, base);
    nA++; for (const [k, v] of Object.entries(r)) tally.A[k] = (tally.A[k] ?? 0) + v;
  }

  // 群B: 最後のやり取りを基準に、その直前N日
  for (const c of notApplied) {
    const base = Date.parse(String(c.updated_at ?? ""));
    if (!Number.isFinite(base)) continue;
    const { data: msgs } = await sb.from("messages")
      .select("sender, text, created_at").eq("conversation_id", c.id as string)
      .order("created_at", { ascending: false }).limit(200);
    const list = ((msgs ?? []) as Msg[]).filter((m) => m.text);
    if (list.length < 4) continue;                   // ほぼ会話が無い物は対照にしない
    const r = countIn(list, base - WINDOW_D * 86400_000, base);
    nB++; for (const [k, v] of Object.entries(r)) tally.B[k] = (tally.B[k] ?? 0) + v;
  }

  console.log(`--- 申込の直前${WINDOW_D}日に起きていたか（群A ${nA}件 / 群B ${nB}件）---`);
  console.log(`  ${"合図".padEnd(26)} ${"群A".padStart(7)} ${"群B".padStart(7)} ${"差".padStart(7)}`);
  const rows = SIGNALS.map((s) => {
    const a = (100 * (tally.A[s.key] ?? 0)) / Math.max(nA, 1);
    const b = (100 * (tally.B[s.key] ?? 0)) / Math.max(nB, 1);
    return { s, a, b, d: a - b };
  }).sort((x, y) => y.d - x.d);
  for (const { s, a, b, d } of rows) {
    console.log(`  ${s.label.padEnd(26)} ${`${a.toFixed(0)}%`.padStart(7)} ${`${b.toFixed(0)}%`.padStart(7)} ${`${d >= 0 ? "+" : ""}${d.toFixed(0)}pt`.padStart(7)}`);
  }
  console.log(`\n  ＝ 差が大きい合図ほど「申込になりそう」の材料になる。差が小さい物は両方で起きている＝使えない。`);
}
main().catch((e) => { console.error(e); process.exit(1); });
