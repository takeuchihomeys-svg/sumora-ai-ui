// scripts/audit-appeal-by-scene.ts — 土台「訴求」の物差しを場面（申込までの地図の駅・分かれ道）で分けて数える（台帳 #755・2026-11-28 作業員A・読むだけ・LLM なし・DB なし）
//   入力: audit-route-progress-takeuchi.ts --json の照らし（番ごとの駅と一手 act・申込まで届いたか reached・書き手 writer）。
//   訴求の一手 = 返信の内覧の誘い（reply:invite_viewing＝「お気に召されましたらご案内させて頂きます」の形）・返信の申込の誘い（reply:invite_apply＝「お申込みでお部屋抑えさせて頂きます」の形）・
//     AIX【内覧日調整】【申込へ】。reply:invite_estimate は本文を読むと「募集状況と最大限割引の見積書をご連絡させて頂きます」の約束の形が多い＝訴求ではなく見積の約束として別に数える。
//     （11/28 本文を6番読んで分け方を確かめた: invite_viewing 2/2・invite_apply 1/1 は誘いの文、invite_estimate 2/2 は確認＋見積の約束）
//   場面ごとに: 竹内さん本人の番の数・訴求した割合（内覧／申込の内訳）・見積の約束の割合・訴求した番と、しなかった番の申込まで届いた割合。
//   --write: quality_daily の appeal:scene:<駅>（scope takeuchi・value＝訴求した割合・detail に内訳）／--writers=all で全員
//   実行: npx tsx --env-file=.env.local scripts/audit-appeal-by-scene.ts --from=<照らしの json> [--writers=all] [--min=5] [--write]
import { readFileSync } from "node:fs";
import { createClient } from "@supabase/supabase-js";

const arg = (k: string, d = "") => process.argv.find((a) => a.startsWith(`--${k}=`))?.slice(k.length + 3) ?? d;
import { appealByScene, type Row } from "./lib/appeal-by-scene";

const pct = (a: number, b: number) => (b ? Math.round((a / b) * 1000) / 10 : null);
(async () => {
  const from = arg("from"); if (!from) throw new Error("--from=<照らしの json> が要る");
  const writers = arg("writers") === "all" ? "all" : "takeuchi";
  const min = Number(arg("min", "5"));
  const rows = JSON.parse(readFileSync(from, "utf8")) as Row[];
  const out = appealByScene(rows, { writers });
  console.log(`### 訴求を場面で分けて（${writers === "all" ? "全員" : "竹内さん本人"}・${rows.length}番の照らしから・n≥${min} の場面）`);
  for (const s of out.filter((x) => x.n >= min)) {
    console.log(`- ${s.scene}: ${s.n}番・訴求 ${s.appeal}（${pct(s.appeal, s.n)}%・内覧 ${s.viewing}／申込 ${s.apply}）・見積の約束 ${s.estimate}・申込まで届いた 訴求した番 ${s.reachedAppeal}/${s.appeal}（${pct(s.reachedAppeal, s.appeal) ?? "—"}%）／しなかった番 ${s.reachedOther}/${s.other}（${pct(s.reachedOther, s.other) ?? "—"}%）`);
  }
  if (process.argv.includes("--write")) {
    const sb = createClient(process.env.NEXT_PUBLIC_SUPABASE_URL ?? "", process.env.SUPABASE_SERVICE_ROLE_KEY ?? process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY ?? "", { auth: { persistSession: false } });
    const day = new Date(Date.now() + 9 * 3600_000).toISOString().slice(0, 10);
    const qd = out.filter((x) => x.n >= min).map((s) => ({ day, metric: `appeal:scene:${s.scene}`, scope: writers === "all" ? "all" : "takeuchi", value: pct(s.appeal, s.n), n: s.n,
      detail: { viewing: s.viewing, apply: s.apply, estimate_promise: s.estimate, reached_appeal: pct(s.reachedAppeal, s.appeal), reached_other: pct(s.reachedOther, s.other) }, source: "scripts/audit-appeal-by-scene.ts（作業員A・#755）" }));
    const { error } = await sb.from("quality_daily").upsert(qd, { onConflict: "day,metric,scope" });
    console.log(error ? `quality_daily: ${error.message}` : `書いた: quality_daily ${qd.length}行（${day}）`);
  }
  process.exitCode = 0; // process.exit は使わない（Windows の 0xC0000409 の落ち・13330ed0b と同じ）
})().catch((e) => { console.error(e); process.exitCode = 1; });
