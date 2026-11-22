/**
 * カウンターキッチンの画像の読み（property-brain-image.ts の counter_kitchen）の目の監査の「読み」の台本（2026-11-21 作業員G・台帳 #477・#510）
 *
 *   物件の資料の画像（property_pickups の trim / page / agent の画像＝物件資料だけ・お客様の値や申込の書類は出さない）を
 *   1枚1回 DeepSeek で読み（問いは counter_kitchen の1つ・分からなければ null）、共通の監査の形（scripts/image-audit.ts・topic=counter_kitchen）で reads.json に足す。
 *   読み: カウンター＝"ok"・壁付け＝"ng"・分からない＝"unknown"。正しいかは**人が画像を見て** image-audit の --judge で決める。
 *
 *   夜（22時〜翌8時。memory/test_protocol_brain.md の手順）:
 *     LLM_TEST_MODE=deepseek-all npx tsx --env-file=.env.local scripts/counter-kitchen-image-audit.ts --limit=12 [--kitchen=対面|壁付け] [--ids=1,2]
 *     npx tsx scripts/image-audit.ts --topic=counter_kitchen --judge=166151:ok,169742:ng
 *     npx tsx --env-file=.env.local scripts/image-audit.ts --topic=counter_kitchen --report --record --item=477
 */
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { execSync } from "node:child_process";
import { dirname, resolve } from "node:path";
import type { AuditRead } from "../app/lib/image-audit";

const args = process.argv.slice(2);
const arg = (k: string) => args.find((a) => a.startsWith(`--${k}=`))?.slice(k.length + 3) ?? null;

const root = resolve(dirname(resolve(execSync("git rev-parse --git-common-dir", { encoding: "utf8" }).trim())));
const DIR = join(root, ".claude", "exam-cache", "image-audit", arg("topic") ?? "counter_kitchen");
const READS = join(DIR, "reads.json");

async function readMany() {
  const { setupLlmTest } = await import("./lib/llm-test-harness");
  const h = await setupLlmTest("counter-kitchen-image-audit");
  process.env.COUNTER_KITCHEN_IMAGE_READ = "on";
  const { supabase } = await import("../app/lib/supabase-server");
  const { readFloorPlanFacts } = await import("../app/lib/property-brain-image");
  const limit = Math.min(Number(arg("limit") ?? 12) || 12, 30);
  const ids = (arg("ids") ?? "").split(",").filter((x) => /^\d+$/.test(x)).map(Number);
  let q = supabase.from("property_pickups").select("id, trim_image_url, page_image_url, agent_image_url, image_analysis")
    .order("id", { ascending: false }).limit(ids.length ? ids.length : 200);
  q = ids.length ? q.in("id", ids) : q.or("trim_image_url.not.is.null,page_image_url.not.is.null,agent_image_url.not.is.null");
  const { data, error } = await q;
  if (error) throw new Error(error.message);
  const kw = arg("kitchen");
  const rows = ((data ?? []) as Array<{ id: number; trim_image_url: string | null; page_image_url: string | null; agent_image_url: string | null; image_analysis: { kitchen?: string } | null }>)
    .filter((r) => !kw || String(r.image_analysis?.kitchen ?? "").startsWith(kw)).slice(0, limit);
  const reads: AuditRead[] = existsSync(READS) ? JSON.parse(readFileSync(READS, "utf8")) : [];
  for (const r of rows) {
    const url = r.agent_image_url ?? r.page_image_url ?? r.trim_image_url;
    if (!url) continue;
    const res = await readFloorPlanFacts(url, ["counter_kitchen"], { timeoutMs: 30_000 });
    const v = res.facts?.counter_kitchen ?? null;
    const read = v === true ? "ok" : v === false ? "ng" : "unknown";
    reads.push({ id: String(r.id), read, ref: url, ...({ kitchen_v8: r.image_analysis?.kitchen ?? null, at: new Date().toISOString(), model: res.model } as object) } as AuditRead);
    console.log(`  ${r.id}  読み=${read === "ok" ? "カウンター" : read === "ng" ? "壁付け" : "分からない"}  sheet-v8=${r.image_analysis?.kitchen ?? "—"}  ${url}`);
  }
  mkdirSync(DIR, { recursive: true });
  writeFileSync(READS, JSON.stringify(reads, null, 1));
  console.log(`reads.json: ${reads.length}件 → 次は scripts/image-audit.ts --topic=counter_kitchen --judge=… --report`);
  await h.finish();
}

readMany().catch((e) => { console.error(e instanceof Error ? e.message : e); process.exit(2); });
