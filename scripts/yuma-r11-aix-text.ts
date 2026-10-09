// scripts/yuma-r11-aix-text.ts — 11巡目（10/08 竹内「AIX テンプレートの文の質も竹内が送っている形で…竹内の方に寄せるように改善する」）の前後を AIX の文で測る
//
//   番は scripts/audit-r9s2-aix-cases.ts（1通目・aix/action）と scripts/audit-r11-aix-second-cases.ts（✨2通目）が本番から作る
//   （竹内さんが送った通が正解・会話は書類の手前で切り名前は YUMA・伏せ済み）。
//   同じ番を AIX_TAKEUCHI_FORM=off（前）／on（後）で交互に作り直す（同じプロセス・呼ぶ前に env を切り替える＝直した所は全部呼ぶ時に env を読む）。
//   学習ルールは今の DB のまま（testFlags.rules_r9=off）。after()（aix_generate_log 等の記録）は何もしない箱で包む＝YUMA に行を残さない。
//   手順書 memory/test_protocol_brain.md どおり（YUMA だけ・共通の入口・試行錯誤は DeepSeek・最後の Claude は種類ごとに1〜2回・同時1本）。
// 実行（AsyncLocalStorage を globalThis に置く .cjs が要る）:
//   NODE_OPTIONS=--require=<als.cjs> LLM_TEST_MODE=deepseek-all npx tsx --env-file=.env.local scripts/yuma-r11-aix-text.ts --label=ds1 --cases=a.json,b.json [--reps=1] [--per=99] [--actions=..] [--ids=..] [--variants=before,after] [--wait-min=30]
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
const VARIANTS = arg("variants", "before,after").split(",") as Array<"before" | "after">;
const CASES = arg("cases", "scripts/.replay-out/r11-aix-cases.json,scripts/.replay-out/r11-aix-second-cases.json").split(",");
const WAIT_MIN = Number(arg("wait-min", "30"));
// 切り替える環境変数（既定 AIX_TAKEUCHI_FORM・10/08 12巡目: --toggle=AIX_TAKEUCHI_PICKUP で物件ピックアップの行だけを前後に）
const TOGGLE = arg("toggle", "AIX_TAKEUCHI_FORM");
const OUT_DIR = "scripts/.replay-out";
const sb = createClient(process.env.NEXT_PUBLIC_SUPABASE_URL ?? "", process.env.SUPABASE_SERVICE_ROLE_KEY ?? process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY ?? "");

type Case = { id: string; action: string; route: "aix/action" | "aix-template-generate"; body: Record<string, unknown>; sent: string; inputText: string };
let h: LlmTestHarness | null = null;

async function yumaState() {
  const { data: conv } = await sb.from("conversations").select("*").eq("id", YUMA).single();
  const { data: pcs } = await sb.from("property_customers").select("*").eq("conversation_id", YUMA);
  const c = { ...(conv as Record<string, unknown>) }; delete c.updated_at; delete c.last_message_at;
  return { raw: { conv, pcs }, hash: createHash("sha1").update(JSON.stringify({ c, pcs })).digest("hex") };
}

async function main() {
  h = await setupLlmTest("yuma-r11-aix-text");
  h.assertYuma(YUMA);
  (globalThis as unknown as Record<string, unknown>).AsyncLocalStorage ??= (await import("node:async_hooks")).AsyncLocalStorage;
  const { workAsyncStorage } = await import("next/dist/server/app-render/work-async-storage.external");
  const { POST: aixPost } = await import("../app/api/aix/action/route");
  const { POST: tplPost } = await import("../app/api/aix-template-generate/route");

  const all: Case[] = CASES.filter((f) => existsSync(f)).flatMap((f) => (JSON.parse(readFileSync(f, "utf8")) as { cases: Case[] }).cases);
  const per: Record<string, number> = {};
  const keyOf = (c: Case) => c.route === "aix-template-generate" && !c.action.includes("second") ? "rec-template" : c.action;
  const list = all.filter((c) => {
    const k = keyOf(c);
    if (k === "property_recommendation") return false; // 画像を読む経路（DeepSeek は文字だけ）
    if (ACTIONS.length && !ACTIONS.some((a) => k === a || k.startsWith(`${a}:`) || k.startsWith(a))) return false;
    if (IDS.length && !IDS.includes(c.id)) return false;
    per[k] = (per[k] ?? 0) + 1;
    return per[k] <= PER;
  });
  if (!existsSync(OUT_DIR)) mkdirSync(OUT_DIR, { recursive: true });
  const outFile = `${OUT_DIR}/r11-aix-${LABEL}.jsonl`;
  writeFileSync(outFile, "");
  const before = await yumaState();
  writeFileSync(`${OUT_DIR}/r11-aix-${LABEL}-yuma-before.json`, JSON.stringify(before.raw));
  await h.waitUntilYumaQuiet([], { maxWaitMin: WAIT_MIN });
  console.log(`=== ${list.length}番 × ${VARIANTS.join("/")} × ${REPS}回 label=${LABEL} mode=${process.env.LLM_TEST_MODE ?? (process.env.LLM_TEST_FINAL_CLAUDE ? "final-claude" : "-")} ===`);

  const store = { afterContext: { after: () => {} }, route: "/api/aix/action", isStaticGeneration: false } as never;
  let n = 0;
  for (const c of list) for (let rep = 0; rep < REPS; rep++) for (const v of (rep % 2 ? [...VARIANTS].reverse() : VARIANTS)) {
    const recent = ((c.body.recent_messages ?? c.body.recentMessages) as Array<{ text: string }> | undefined) ?? [];
    h.assertSceneSafe(recent.map((m) => m.text), c.id);
    process.env[TOGGLE] = v === "before" ? "off" : "on";
    const t0 = Date.now();
    let text = "", err = "";
    try {
      if (c.route === "aix/action") {
        const body = { ...c.body, conversation_id: YUMA, customer_name: "YUMA", testFlags: { rules_r9: "off" } };
        const res = await workAsyncStorage.run(store, () => aixPost(new Request("http://localhost/api/aix/action", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) }) as never)) as Response;
        const j = await res.json().catch(() => ({})) as Record<string, unknown>;
        text = String((c.action === "estimate_sheet" ? j.coverLetter : j.message_text) ?? "");
        if (!text) err = String(j.error ?? JSON.stringify(j).slice(0, 160));
      } else {
        const body = { ...c.body, conversationId: YUMA, customerName: "YUMA" };
        const res = await workAsyncStorage.run(store, () => tplPost(new Request("http://localhost/api/aix-template-generate", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) }) as never)) as Response;
        const j = await res.json().catch(() => ({})) as Record<string, unknown>;
        text = String(j.text ?? "");
        if (!text) err = String(j.error ?? JSON.stringify(j).slice(0, 160));
      }
    } catch (e) { err = `失敗: ${e instanceof Error ? e.message : String(e)}`; }
    n++;
    const rec = { id: c.id, action: keyOf(c), v, rep, ms: Date.now() - t0, text, err: err || null };
    appendFileSync(outFile, JSON.stringify(rec) + "\n");
    console.log(`[${n}] ${c.id} ${v} r${rep + 1} ${Math.round(rec.ms / 1000)}s ${err ? "ERR " + err.slice(0, 120) : text.replace(/\n+/g, "／").slice(0, 100)}`);
  }
  delete process.env[TOGGLE];
  const after = await yumaState();
  console.log(after.hash === before.hash ? "YUMA の会話・条件の行: 変わっていない" : `⚠ YUMA の会話・条件の行が変わった → 控え ${OUT_DIR}/r11-aix-${LABEL}-yuma-before.json から戻す`);
  const foreign = await h.foreignYumaRows([]);
  console.log(`YUMA の他の行（10分以内・未来）: ${foreign.length}`);
}
main().catch((e) => { console.error(e); process.exitCode = 1; })
  .finally(async () => { if (h) await h.finish(); setTimeout(() => process.exit(process.exitCode ?? 0), 800); });
