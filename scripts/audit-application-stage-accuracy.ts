// 申込の段階の判定が、実際の会話と合っているか（読み取りのみ）
//
// 2026-09-21 竹内「実際に申し込んだかのところ判断できるようにする」
//
// 設計知見の手順⑦全件監査。判定は生成に渡す材料になるので、**誤って「申込済み」と言わない**ことが最優先。
//
// 実行: npx tsx --env-file=.env.local scripts/audit-application-stage-accuracy.ts
import { createClient } from "@supabase/supabase-js";
import { resolveApplicationStage } from "../app/lib/application-stage";

const sb = createClient(process.env.NEXT_PUBLIC_SUPABASE_URL ?? "", process.env.SUPABASE_SERVICE_ROLE_KEY ?? process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY ?? "");
const DAYS = Number(process.env.DAYS ?? 365);
const pct = (a: number, b: number) => (b ? `${((a / b) * 100).toFixed(1)}%` : "-");
const mask = (s: string) => s.replace(/[ぁ-んァ-ヶー一-龥A-Za-z]{1,6}(?:さん|様|さま)/g, "〈お客様〉");

async function page(table: string, select: string, days: number) {
  const out: Array<Record<string, unknown>> = [];
  for (let p = 0; p < 40; p++) {
    const { data, error } = await sb.from(table).select(select)
      .gte("created_at", new Date(Date.now() - days * 86400_000).toISOString())
      .order("created_at", { ascending: false }).range(p * 1000, p * 1000 + 999);
    if (error) { console.log(`⚠ ${table}: ${error.message}`); break; }
    const r = (data ?? []) as unknown as Array<Record<string, unknown>>;
    if (r.length === 0) break; out.push(...r); if (r.length < 1000) break;
  }
  return out;
}

async function main() {
  const msgs = (await page("messages", "conversation_id, sender, text, created_at", DAYS))
    .filter((m) => String(m.sender) === "staff" && String(m.text ?? "").trim());
  const byConv = new Map<string, Array<{ text: string; at: number }>>();
  for (const m of msgs) {
    const c = String(m.conversation_id ?? "");
    const at = Date.parse(String(m.created_at ?? ""));
    if (!c || Number.isNaN(at)) continue;
    byConv.set(c, [...(byConv.get(c) ?? []), { text: String(m.text), at }]);
  }
  for (const arr of byConv.values()) arr.sort((a, b) => a.at - b.at);

  const convs: Array<Record<string, unknown>> = [];
  for (let p = 0; p < 10; p++) {
    const { data } = await sb.from("conversations").select("id, status").range(p * 1000, p * 1000 + 999);
    const r = (data ?? []) as Array<Record<string, unknown>>;
    if (r.length === 0) break; convs.push(...r); if (r.length < 1000) break;
  }
  const statusById = new Map(convs.map((c) => [String(c.id), String(c.status ?? "")]));

  console.log(`=== 会話 ${byConv.size}件（直近${DAYS}日・スタッフ送信あり）===\n`);

  // ① 段階の分布
  const byStage = new Map<string, number>();
  const verdicts = new Map<string, ReturnType<typeof resolveApplicationStage>>();
  for (const [cid, list] of byConv.entries()) {
    const v = resolveApplicationStage(list.map((x) => x.text));
    verdicts.set(cid, v);
    byStage.set(v.stage, (byStage.get(v.stage) ?? 0) + 1);
  }
  console.log(`=== ① 段階の分布 ===`);
  for (const s of ["none", "guided", "declared", "info_requested", "submitted", "screening"]) {
    const n = byStage.get(s) ?? 0;
    console.log(`   ${s.padEnd(16)} ${String(n).padStart(4)}件（${pct(n, byConv.size)}）`);
  }

  // ② 「申込済み」と判定した会話の status（誤判定を探す）
  const APPLYING = new Set(["applying", "screening", "contract", "closed_won", "成約", "申込", "審査中"]);
  const submitted = [...verdicts.entries()].filter(([, v]) => v.submitted);
  const submittedEarly = submitted.filter(([cid]) => !APPLYING.has(statusById.get(cid) ?? ""));
  console.log(`\n=== ② 「申込済み」と判定した会話 ${submitted.length}件 ===`);
  console.log(`   status も申込以降     ${submitted.length - submittedEarly.length}件`);
  console.log(`   status はまだ前段階   ${submittedEarly.length}件（${pct(submittedEarly.length, submitted.length)}）`);
  console.log(`   ※ status は人が変えるので遅れる。根拠の文を読んで**本当に申込の話か**を確かめる`);
  console.log(`\n   ─ status が前段階の会話の根拠（最大12件・誤判定ならここに出る）─`);
  for (const [cid, v] of submittedEarly.slice(0, 12)) {
    console.log(`   [status=${statusById.get(cid) ?? "-"}] ${mask(v.evidence ?? "")}`);
  }

  // ③ 逆に status は申込以降なのに「申込していない」と判定した会話（取りこぼし）
  const missed = [...byConv.keys()].filter((cid) => APPLYING.has(statusById.get(cid) ?? "") && !verdicts.get(cid)?.submitted);
  console.log(`\n=== ③ status は申込以降なのに「まだ」と判定した会話 ${missed.length}件（取りこぼし）===`);
  for (const cid of missed.slice(0, 8)) {
    const v = verdicts.get(cid)!;
    const last = (byConv.get(cid) ?? []).slice(-2).map((x) => mask(x.text).replace(/\n/g, " ／ ").slice(0, 70)).join(" ｜ ");
    console.log(`   [status=${statusById.get(cid)} / 判定=${v.stage}] ${last}`);
  }

  // ④ 物件確認の結果（他人の申込）を誤って「申込済み」にしていないか
  const OTHERS_TEXT_RE = /[23]番手|お?申込(?:み|)が(?:入|はい)って/;
  const hasOthers = [...byConv.entries()].filter(([, list]) => list.some((x) => OTHERS_TEXT_RE.test(x.text)));
  const othersWrong = hasOthers.filter(([cid]) => verdicts.get(cid)?.submitted
    && !(byConv.get(cid) ?? []).some((x) => /お?申込(?:み|)完了|お申込み?手続き(?:を)?進め|審査/.test(x.text)));
  console.log(`\n=== ④ 他人の申込（2番手以降・申込が入っており）がある会話 ${hasOthers.length}件 ===`);
  console.log(`   そのうち誤って「申込済み」にした: **${othersWrong.length}件**`);
  for (const [cid, v] of othersWrong.slice(0, 6).map(([cid]) => [cid, verdicts.get(cid)!] as const)) {
    console.log(`   [status=${statusById.get(cid) ?? "-"}] ${mask(v.evidence ?? "")}`);
  }
  if (othersWrong.length === 0) console.log(`   ✅ 0件 ＝ 他人の申込を自分の申込と数えていない`);
}
main().catch((e) => { console.error(e); process.exit(1); });
