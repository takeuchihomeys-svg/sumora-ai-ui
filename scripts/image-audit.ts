/**
 * 画像の読みの目の監査（種類を問わず・2026-11-21 作業員G・台帳 #510＝#505 の子）。LLM なし（読みは種類ごとの台本が書く）
 *
 *   置き場: <repo>/.claude/exam-cache/image-audit/<topic>/reads.json（読み・種類ごとの台本が書く）・truth.json（目で見た正解）
 *     reads.json = [{ id, read: "ok"|"ng"|"unknown"|<値>, ref?: 画像の置き場, at }]
 *
 *   npx tsx scripts/image-audit.ts --topic=counter_kitchen --judge=166151:ok,169742:ng   # 目で見た正解を足す
 *   npx tsx scripts/image-audit.ts --topic=counter_kitchen --report                      # 突き合わせ（誤り・分からない・まだ見ていない）
 *   npx tsx --env-file=.env.local scripts/image-audit.ts --topic=counter_kitchen --report --record --item=477
 *       → 台帳（work_item_events の note）と quality_daily（image_audit:<topic>:right／wrong）に残す
 *
 *   読みを書く台本: scripts/counter-kitchen-image-audit.ts（counter_kitchen）。他の種類は同じ形の reads.json を書けば使える
 */
import { execSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { auditLedgerNote, auditReport, parseJudgeArg, type AuditRead, type AuditTruth } from "../app/lib/image-audit";

const args = process.argv.slice(2);
const arg = (k: string) => args.find((a) => a.startsWith(`--${k}=`))?.slice(k.length + 3) ?? null;
const flag = (k: string) => args.includes(`--${k}`);

export function imageAuditDir(topic: string): string {
  if (!/^[a-z0-9_]+$/.test(topic)) throw new Error(`topic は英小文字・数字・_ だけ: ${topic}`);
  const root = resolve(dirname(resolve(execSync("git rev-parse --git-common-dir", { encoding: "utf8" }).trim())));
  return join(root, ".claude", "exam-cache", "image-audit", topic);
}
const load = <T,>(p: string, d: T): T => (existsSync(p) ? (JSON.parse(readFileSync(p, "utf8")) as T) : d);

async function main() {
  const topic = arg("topic");
  if (!topic) throw new Error("--topic=<種類> が要る（例 counter_kitchen）");
  const dir = imageAuditDir(topic);
  const READS = join(dir, "reads.json"), TRUTH = join(dir, "truth.json");
  if (arg("judge")) {
    const truth = load<AuditTruth>(TRUTH, {});
    for (const { id, value } of parseJudgeArg(arg("judge")!)) truth[id] = value;
    mkdirSync(dir, { recursive: true });
    writeFileSync(TRUTH, JSON.stringify(truth, null, 1));
    console.log(`正解の控え（${topic}）: ${Object.keys(truth).length}件`);
    return;
  }
  if (!flag("report")) throw new Error("--judge=… か --report を付ける");
  const reads = load<AuditRead[]>(READS, []);
  const truth = load<AuditTruth>(TRUTH, {});
  const minRight = Number(arg("min") ?? 20) || 20;
  const r = auditReport(reads, truth, minRight);
  for (const w of r.wrongIds) console.log(`  ✗ ${w.id} 読み=${w.read}・目=${w.truth}`);
  const note = auditLedgerNote(topic, r);
  console.log(note);
  if (flag("record")) {
    const item = Number(arg("item"));
    const { supabase } = await import("../app/lib/supabase-server");
    if (Number.isFinite(item) && item > 0) {
      const { error } = await supabase.from("work_item_events").insert({ item_id: item, kind: "note", actor: "作業員G", note });
      console.log(error ? `台帳に書けない: ${error.message}` : `台帳 #${item} に残した`);
    }
    const day = new Date(Date.now() + 9 * 3600e3).toISOString().slice(0, 10);
    const rows = [
      { day, metric: `image_audit:${topic}:right`, scope: "all", value: r.right, n: r.total, source: "scripts/image-audit.ts", detail: { wrong: r.wrong, unknown: r.unknown, ready: r.ready } },
      { day, metric: `image_audit:${topic}:wrong`, scope: "all", value: r.wrong, n: r.total, source: "scripts/image-audit.ts", detail: { wrongIds: r.wrongIds.slice(0, 20).map((w) => w.id) } },
    ];
    const { error } = await supabase.from("quality_daily").upsert(rows, { onConflict: "day,metric,scope" });
    console.log(error ? `quality_daily に書けない: ${error.message}` : "quality_daily に2行");
  }
}

main().catch((e) => { console.error(e instanceof Error ? e.message : e); process.exit(2); });
