/**
 * カウンターキッチンの画像の読み（property-brain-image.ts の counter_kitchen）を目で監査する（2026-11-21 作業員G・台帳 #477）
 *
 *   物件の資料の画像（property_pickups の trim / page / agent の画像＝物件資料だけ・お客様の値や申込の書類は出さない）を
 *   1枚1回 DeepSeek で読み（問いは counter_kitchen の1つ・分からなければ null）、答えと画像の置き場を並べる。
 *   答えが正しいかは**人が画像を見て**決める（--judge=<id>:ok|ng|unknown,... で控えに書く）。誤り0の線が出るまで判定には使わない。
 *
 *   実行（夜・22時〜翌8時。memory/test_protocol_brain.md の手順・LLM_TEST_MODE=deepseek-all）:
 *     LLM_TEST_MODE=deepseek-all npx tsx --env-file=.env.local scripts/counter-kitchen-image-audit.ts --limit=12 [--kitchen=対面|壁付け] [--ids=1,2]
 *     npx tsx scripts/counter-kitchen-image-audit.ts --judge=166151:ok,169742:ng        # 目で見た正解を控えに足す（LLM なし）
 *     npx tsx scripts/counter-kitchen-image-audit.ts --report                          # 正解と読みの突き合わせ（LLM なし）
 *   控え: <repo>/.claude/exam-cache/counter-kitchen-audit/{reads,truth}.json（git に入れない）
 */
import { execSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";

const args = process.argv.slice(2);
const arg = (k: string) => args.find((a) => a.startsWith(`--${k}=`))?.slice(k.length + 3) ?? null;
const flag = (k: string) => args.includes(`--${k}`);

const root = resolve(dirname(resolve(execSync("git rev-parse --git-common-dir", { encoding: "utf8" }).trim())));
const DIR = join(root, ".claude", "exam-cache", "counter-kitchen-audit");
const READS = join(DIR, "reads.json");
const TRUTH = join(DIR, "truth.json");
type Read = { id: number; url: string; kitchen_v8: string | null; read: boolean | null; failed: boolean; at: string; model: string };
const load = <T,>(p: string, d: T): T => (existsSync(p) ? (JSON.parse(readFileSync(p, "utf8")) as T) : d);

function judge() {
  const truth = load<Record<string, "ok" | "ng" | "unknown">>(TRUTH, {});
  for (const part of String(arg("judge")).split(",")) {
    const [id, v] = part.split(":");
    if (!/^\d+$/.test(id) || !["ok", "ng", "unknown"].includes(v)) throw new Error(`形が違う: ${part}（<id>:ok|ng|unknown）`);
    truth[id] = v as "ok" | "ng" | "unknown";
  }
  mkdirSync(DIR, { recursive: true });
  writeFileSync(TRUTH, JSON.stringify(truth, null, 1));
  console.log(`正解の控え: ${Object.keys(truth).length}件`);
}

function report() {
  const reads = load<Read[]>(READS, []);
  const truth = load<Record<string, string>>(TRUTH, {});
  let wrong = 0, unknown = 0, right = 0, notJudged = 0;
  for (const r of reads) {
    const t = truth[String(r.id)];
    const got = r.read === true ? "ok" : r.read === false ? "ng" : "unknown";
    if (!t) { notJudged++; continue; }
    if (got === "unknown") { unknown++; continue; }   // 分からないは誤りに数えない（作らないのが正しい）
    if (t === "unknown") { console.log(`  ? ${r.id} 読み=${got}・目でも決められない`); continue; }
    if (got === t) right++; else { wrong++; console.log(`  ✗ ${r.id} 読み=${got}・目=${t}（sheet-v8=${r.kitchen_v8 ?? "—"}）`); }
  }
  console.log(`読み ${reads.length}件: 正しい ${right}・誤り ${wrong}・分からない ${unknown}・まだ目で見ていない ${notJudged}`);
  console.log(wrong === 0 && right >= 20 ? "誤り0（20件以上）→ 判定に使う候補" : "まだ判定には使わない（誤りがある・件数が足りない）");
}

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
  const reads = load<Read[]>(READS, []);
  for (const r of rows) {
    const url = r.agent_image_url ?? r.page_image_url ?? r.trim_image_url;
    if (!url) continue;
    const res = await readFloorPlanFacts(url, ["counter_kitchen"], { timeoutMs: 30_000 });
    const read = res.facts?.counter_kitchen ?? null;
    reads.push({ id: r.id, url, kitchen_v8: r.image_analysis?.kitchen ?? null, read, failed: !!res.failed, at: new Date().toISOString(), model: res.model });
    console.log(`  ${r.id}  読み=${read === true ? "カウンター" : read === false ? "壁付け" : "分からない"}  sheet-v8=${r.image_analysis?.kitchen ?? "—"}  ${url}`);
  }
  mkdirSync(DIR, { recursive: true });
  writeFileSync(READS, JSON.stringify(reads, null, 1));
  await h.finish();
}

(flag("report") ? Promise.resolve(report()) : arg("judge") ? Promise.resolve(judge()) : readMany())
  .catch((e) => { console.error(e instanceof Error ? e.message : e); process.exit(2); });
