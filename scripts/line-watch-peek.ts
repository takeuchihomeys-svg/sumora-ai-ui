// scripts/line-watch-peek.ts — 見張りの画面と同じ読み取り（loadLineWatch）を本番 DB で読むだけで当てる（名前は1文字だけ出す）
// 実行: npx tsx --env-file=.env.local scripts/line-watch-peek.ts [--test]（--test で YUMA も）
import { createClient } from "@supabase/supabase-js";
import { loadLineWatch } from "../app/lib/line-watch-server";
(async () => {
  const sb = createClient(process.env.NEXT_PUBLIC_SUPABASE_URL!, process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY!);
  const t0 = Date.now();
  const d = await loadLineWatch(sb, { includeTest: process.argv.includes("--test") });
  console.log("ms", Date.now() - t0);
  console.log(JSON.stringify({ capture: d.capture, summary: d.summary, errors: d.errors }, null, 1));
  const mask = (n: string | null) => (n ? n.slice(0, 1) + "…" : "-");
  console.log("WAITING"); for (const w of d.waiting.slice(0, 12)) console.log(` ${mask(w.name)} ${w.businessMin}m late=${w.late} scene=${w.scene} brain=${w.brain} draft=${w.draftReady} sent=${w.sentinel} fc=${w.finalCheck.slice(0, 80)}`);
  console.log("PROMISES"); for (const p of d.promises.slice(0, 8)) console.log(` ${mask(p.name)} ${p.kindJa} ${p.hours}h active=${p.customerActive} ${p.evidence ?? ""}`);
  console.log("AIX", d.aixItems.length, d.aixItems.slice(0, 5).map((a) => a.label).join(" / "));
  console.log("CAL"); for (const c of d.calendar.slice(0, 20)) console.log(` ${c.code} ${mask(c.name)} ${c.day} ${c.detail}`);
  console.log("SEARCH"); for (const s of d.search.slice(0, 15)) console.log(` ${s.kind} ${mask(s.name)} ${s.detail}`);
})();
