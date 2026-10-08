// scripts/yuma-r9s2-aix-text.ts — 9巡目 段2（AIX の振り分けの写し 137本の無効）の前後を AIX の文で測る（10/08 竹内「測ってちゃんと行う。AIX の所」）
//
//   番は scripts/audit-r9s2-aix-cases.ts が本番から作る（竹内さんが送った AIX の通が正解・会話は書類の手前で切り名前は YUMA・伏せ済み）。
//   ここは同じ番を testFlags.rules_r9 = on（＝今の本番・段1 適用済み）と stage2（段1＋段2）で作り直すだけ（比べるのは audit-r9s2-aix-score.ts）。
//   aix/action の POST を同じプロセスで呼ぶ（開発サーバを立てない）。after()（aix_generate_log 等の記録）は何もしない箱で包む＝YUMA に行を残さない。
//   物件オススメの ✨（aix-template-generate）は testFlags を読まないので runWithRulesOverlay で包む。
//   手順書 memory/test_protocol_brain.md どおり（YUMA だけ・共通の入口・試行錯誤は DeepSeek・最後の Claude は action ごとに1〜2回・同時1本）。
// 実行（AsyncLocalStorage を globalThis に置く .cjs が要る＝Next の箱を tsx で使うため）:
//   NODE_OPTIONS=--require=<als.cjs> LLM_TEST_MODE=deepseek-all npx tsx --env-file=.env.local scripts/yuma-r9s2-aix-text.ts --label=ds1 [--reps=1] [--per=12] [--actions=a,b] [--versions=on,stage2] [--ids=..]
import { setupLlmTest, YUMA, type LlmTestHarness } from "./lib/llm-test-harness";
import { readFileSync, appendFileSync, writeFileSync, existsSync, mkdirSync } from "node:fs";
import { createHash } from "node:crypto";
import { createClient } from "@supabase/supabase-js";

const arg = (k: string, d = "") => (process.argv.find((a) => a.startsWith(`--${k}=`)) ?? "").slice(k.length + 3) || d;
const LABEL = arg("label", "ds");
const REPS = Math.max(1, Number(arg("reps", "1")));
const PER = Number(arg("per", "99"));
const ACTIONS = arg("actions", "").split(",").filter(Boolean);
const IDS = arg("ids", "").split(",").filter(Boolean);
const VERSIONS = arg("versions", "on,stage2").split(",") as Array<"on" | "stage2">;
const CASES_FILE = arg("cases", "scripts/.replay-out/r9s2-aix-cases.json");
const OUT_DIR = "scripts/.replay-out";
const sb = createClient(process.env.NEXT_PUBLIC_SUPABASE_URL ?? "", process.env.SUPABASE_SERVICE_ROLE_KEY ?? process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY ?? "");

type Case = { id: string; action: string; route: "aix/action" | "aix-template-generate"; body: Record<string, unknown>; sent: string; inputText: string };
let h: LlmTestHarness | null = null;

// YUMA の条件・会話の行が変わっていないか（前後で比べる・変わっていたら戻す元を出す）
async function yumaState() {
  const { data: conv } = await sb.from("conversations").select("*").eq("id", YUMA).single();
  const { data: pcs } = await sb.from("property_customers").select("*").eq("conversation_id", YUMA);
  const c = { ...(conv as Record<string, unknown>) }; delete c.updated_at; delete c.last_message_at;
  return { raw: { conv, pcs }, hash: createHash("sha1").update(JSON.stringify({ c, pcs })).digest("hex") };
}

async function main() {
  h = await setupLlmTest("yuma-r9s2-aix-text");
  h.assertYuma(YUMA);
  (globalThis as unknown as Record<string, unknown>).AsyncLocalStorage ??= (await import("node:async_hooks")).AsyncLocalStorage;
  const { workAsyncStorage } = await import("next/dist/server/app-render/work-async-storage.external");
  const { POST: aixPost } = await import("../app/api/aix/action/route");
  const { POST: tplPost } = await import("../app/api/aix-template-generate/route");
  const { runWithRulesOverlay, buildR9Overlay } = await import("../app/lib/rules-overlay");

  const all = (JSON.parse(readFileSync(CASES_FILE, "utf8")) as { cases: Case[] }).cases;
  const per: Record<string, number> = {};
  const list = all.filter((c) => {
    const k = c.route === "aix-template-generate" ? "rec-template" : c.action;
    if (ACTIONS.length && !ACTIONS.includes(k)) return false;
    if (IDS.length && !IDS.includes(c.id)) return false;
    per[k] = (per[k] ?? 0) + 1;
    return per[k] <= PER;
  });
  if (!existsSync(OUT_DIR)) mkdirSync(OUT_DIR, { recursive: true });
  const outFile = `${OUT_DIR}/r9s2-aix-${LABEL}.jsonl`;
  writeFileSync(outFile, "");
  const before = await yumaState();
  writeFileSync(`${OUT_DIR}/r9s2-aix-${LABEL}-yuma-before.json`, JSON.stringify(before.raw));
  await h.waitUntilYumaQuiet([]);
  console.log(`=== ${list.length}番 × ${VERSIONS.join("/")} × ${REPS}回 label=${LABEL} mode=${process.env.LLM_TEST_MODE ?? (process.env.LLM_TEST_FINAL_CLAUDE ? "final-claude" : "-")} ===`);

  const store = { afterContext: { after: () => {} }, route: "/api/aix/action", isStaticGeneration: false } as never;
  let n = 0;
  for (const c of list) for (let rep = 0; rep < REPS; rep++) for (const v of VERSIONS) {
    const recent = ((c.body.recent_messages ?? c.body.recentMessages) as Array<{ text: string }> | undefined) ?? [];
    h.assertSceneSafe(recent.map((m) => m.text), c.id);
    const t0 = Date.now();
    let text = "", err = "";
    try {
      if (c.route === "aix/action") {
        const body = { ...c.body, conversation_id: YUMA, customer_name: "YUMA", testFlags: { rules_r9: v } };
        const res = await workAsyncStorage.run(store, () => aixPost(new Request("http://localhost/api/aix/action", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) }) as never)) as Response;
        const j = await res.json().catch(() => ({})) as Record<string, unknown>;
        text = String((c.action === "estimate_sheet" ? j.coverLetter : j.message_text) ?? "");
        if (!text) err = String(j.error ?? JSON.stringify(j).slice(0, 160));
      } else {
        const body = { ...c.body, conversationId: YUMA, customerName: "YUMA" };
        const res = await runWithRulesOverlay(buildR9Overlay(v), () => workAsyncStorage.run(store, () => tplPost(new Request("http://localhost/api/aix-template-generate", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) }) as never))) as Response;
        const j = await res.json().catch(() => ({})) as Record<string, unknown>;
        text = String(j.text ?? "");
        if (!text) err = String(j.error ?? JSON.stringify(j).slice(0, 160));
      }
    } catch (e) { err = `失敗: ${e instanceof Error ? e.message : String(e)}`; }
    n++;
    const rec = { id: c.id, action: c.route === "aix-template-generate" ? "rec-template" : c.action, v, rep, ms: Date.now() - t0, text, err: err || null };
    appendFileSync(outFile, JSON.stringify(rec) + "\n");
    console.log(`[${n}] ${c.id} ${v} r${rep + 1} ${Math.round(rec.ms / 1000)}s ${err ? "ERR " + err.slice(0, 120) : text.replace(/\n+/g, "／").slice(0, 110)}`);
  }
  const after = await yumaState();
  console.log(after.hash === before.hash ? "YUMA の会話・条件の行: 変わっていない" : `⚠ YUMA の会話・条件の行が変わった → 控え ${OUT_DIR}/r9s2-aix-${LABEL}-yuma-before.json から戻す`);
  const foreign = await h.foreignYumaRows([]);
  console.log(`YUMA の他の行（10分以内・未来）: ${foreign.length}`);
}
main().catch((e) => { console.error(e); process.exitCode = 1; })
  .finally(async () => { if (h) await h.finish(); setTimeout(() => process.exit(process.exitCode ?? 0), 800); });
