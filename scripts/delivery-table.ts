// scripts/delivery-table.ts — 決めた事が書き手まで届いているかの表（AI を呼ばない・費用0・作業員22・2026-11-13）
// 実行:
//   npx tsx scripts/delivery-table.ts --results=<答案の jsonl,…>                     … 試験の答案の brain から（DB を読まない）
//   npx tsx --env-file=.env.local scripts/delivery-table.ts --db=20                 … 本番の新しい会話の suggested_aix_meta を N 件だけ（軽い読み・テストの会話と申込以降は外す）
//   [--json=<出力>]
// 中身は scripts/lib/delivery-table.ts（純関数）。値の中身（お客様の文）は出さず、数だけ出す。
import { readFileSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { tallyDelivery, formatDelivery, emptyPlanStats } from "./lib/delivery-table";
import { SUB_FIELDS, subValuesOf } from "../app/lib/decided-subfields";

const args = process.argv.slice(2);
const arg = (k: string, d = "") => args.find((a) => a.startsWith(`--${k}=`))?.slice(k.length + 3) ?? d;

async function main() {
  const metas: Array<Record<string, unknown>> = [];
  for (const p of arg("results").split(",").filter(Boolean)) {
    for (const l of readFileSync(resolve(p), "utf8").split("\n").filter(Boolean)) { try { const r = JSON.parse(l) as { brain?: Record<string, unknown> }; if (r.brain) metas.push(r.brain); } catch { /* */ } }
  }
  const nDb = Number(arg("db", "0"));
  if (nDb > 0) {
    const { createClient } = await import("@supabase/supabase-js");
    const { isTestConversation } = await import("../app/lib/test-conversations");
    const { isPostApplyStatus } = await import("../app/lib/llm-alt-provider");
    const sb = createClient(process.env.NEXT_PUBLIC_SUPABASE_URL ?? "", process.env.SUPABASE_SERVICE_ROLE_KEY ?? "");
    const { data, error } = await sb.from("conversations").select("id, status, suggested_aix_meta").not("suggested_aix_meta", "is", null).order("updated_at", { ascending: false }).limit(Math.min(nDb * 2, 80));
    if (error) throw new Error(error.message);
    for (const r of (data ?? []) as Array<{ id: string; status: string | null; suggested_aix_meta: Record<string, unknown> | null }>) {
      if (metas.length >= nDb + (arg("results") ? 1e9 : 0)) break;
      if (!r.suggested_aix_meta || isTestConversation(r.id) || isPostApplyStatus(r.status)) continue;
      metas.push(r.suggested_aix_meta);
    }
  }
  if (!metas.length) { console.error("--results か --db を指定してください"); process.exit(1); }
  const t = tallyDelivery(metas);
  console.log(`# 決めた事の届き方（${metas.length} 番・ok/値あり（届かない理由 a 欄が無い・b 配線が無い・c 指示文で使われていない・d スイッチ off））`);
  console.log(formatDelivery(t, metas.length));
  const e = emptyPlanStats(metas);
  console.log(`設計図の注記が空の番: ${e.empty}/${e.n}（スタッフの番 ${e.emptyStaff}・返信の番 ${e.emptyReply}）`);
  // --subs=N: 下の欄の値の有無（種類・数・有無だけ・個人の値は出さない）を、値の多い番から N 番
  const ns = Number(arg("subs", "0"));
  if (ns > 0) {
    const ranked = metas.map((m) => ({ m, v: subValuesOf(m) })).map((x) => ({ ...x, n: Object.values(x.v).filter(Boolean).length })).sort((a, b) => b.n - a.n).slice(0, ns);
    ranked.forEach((x, i) => { console.log(`
## 実物 ${i + 1}（道 ${x.m.reply_mode === "auto_reply" || !x.m.action ? "返信" : "スタッフの番"}・値のある下の欄 ${x.n}/${SUB_FIELDS.length}）`); for (const f of SUB_FIELDS) if (x.v[f.sub]) console.log(`  ${f.sub} = ${x.v[f.sub]}`); });
    const cnt = Object.fromEntries(SUB_FIELDS.map((f) => [f.sub, metas.filter((m) => f.value(m)).length]));
    console.log(`
## 下の欄ごとの値あり（${metas.length} 番）`); for (const f of SUB_FIELDS) console.log(`  ${f.sub} ${cnt[f.sub]}`);
  }
  if (arg("json")) writeFileSync(resolve(arg("json")), JSON.stringify({ n: metas.length, tally: t }, null, 1));
}
main().catch((e) => { console.error(e instanceof Error ? e.message : e); process.exitCode = 1; });
