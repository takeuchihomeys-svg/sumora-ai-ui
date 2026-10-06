// scripts/audit-interior-tone.ts（DeepSeek・物件資料だけ）: 内装の色の読み取り（interior-tone）を目で付けた答えと比べる（2026-10-07）。実行: LLM_TEST_MODE=deepseek-all npx tsx --env-file=.env.local scripts/audit-interior-tone.ts
import { setupLlmTest, type LlmTestHarness } from "./lib/llm-test-harness";
let h: LlmTestHarness | null = null;
// 目で見た答え（T=白基調・F=白基調ではない・B=どちらとも・N=居室の写真なし）
const TRUTH: Record<string, string> = { 3491: "F", 3490: "F", 3488: "T", 3486: "T", 3485: "T", 3482: "F", 3481: "F", 3479: "B", 3478: "B", 3476: "F", 3480: "F", 3477: "N", 3470: "F", 3473: "T", 3474: "B", 3471: "F", 3465: "F", 3483: "N", 3441: "T", 3432: "F", 3489: "F" };
const S = "https://wfwsmwxakhyxobytszoq.supabase.co/storage/v1/object/public/property-images/aix/4f1df513-127f-4ace-b68c-62c769cc625f/";
(async () => {
  h = await setupLlmTest("pickfit-tone-eval2");
  const { readInteriorToneForPickup, readInteriorTone } = await import("../app/lib/interior-tone-read");
  const { createClient } = await import("@supabase/supabase-js");
  const sb = createClient(process.env.NEXT_PUBLIC_SUPABASE_URL!, process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY!);
  const { data } = await sb.from("property_pickups").select("id,site,property_name,pdf_blob_url,page_image_url").in("id", Object.keys(TRUTH).map(Number));
  const tally: Record<string, number> = {};
  const rows = [...(data ?? []), { id: "MFPR", site: "img", page_image_url: S + "1791129443644_0_kebg3.jpeg" }, { id: "OPUS", site: "img", page_image_url: S + "1791129443647_1_mxmsf.jpeg" }];
  const T2: Record<string, string> = { ...TRUTH, MFPR: "F", OPUS: "F" };
  for (const r of rows as any[]) {
    const res = await readInteriorToneForPickup(r);
    const w = res.tone?.whiteBased;
    const t = T2[String(r.id)];
    const k = `${t}->${w === true ? "T" : w === false ? "F" : "null"}`;
    tally[k] = (tally[k] ?? 0) + 1;
    console.log(r.id, r.site, res.source, t, "→", res.tone ? `${res.tone.label} floor=${res.tone.floor} white=${w}` : "失敗", res.ms + "ms");
  }
  console.log(tally);
})().catch((e) => { console.error(e); process.exitCode = 1; }).finally(async () => { if (h) await h.finish(); setTimeout(() => process.exit(process.exitCode ?? 0), 500); });
