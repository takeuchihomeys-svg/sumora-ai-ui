// YUMA のブレイン判断だけを取る（保存しない＝AIX要対応の通知なし）。cwd の木のコードで動く（前＝worktree／後＝作業コピー）
// scripts/yuma-done-state-test.ts から呼ぶ（前の木には無ければ複写して使う）。実行: npx tsx --env-file=.env.local scripts/yuma-brain-decision.ts <出力JSON>
//
// 2026-09-26 竹内「この形でおこなう」（テストの3段の②）: ブレインは DeepSeek にしない（判断が揺れる）。
//   代わりに **場面ごとに Claude で1回分析した結果を保存して使い回す**。
//   BRAIN_CACHE_LABEL を付けると、同じ場面（会話の直近の発言の文面・状態・戦略の有無が同じ）なら保存した判断を返し、ブレインを呼ばない。
//     BRAIN_CACHE_LABEL … 使い回しの名前（例: before / after。ブレインのコードが違う木は名前を分ける）。無ければ毎回 Claude で取る（今までどおり）
//     BRAIN_CACHE_DIR   … 置き場（既定 <cwd>/scripts/.brain-cache。前の worktree から呼ぶ時は作業コピーの置き場を渡す）
//     BRAIN_REFRESH=1   … 保存を無視して取り直す（ブレインのコード・プロンプトを直した後）
//   ⚠ 鍵に時刻は入れない（場面の発言は毎回「今から○分前」で入れ直すため）。相対日付に強く依る場面で古さが気になる時は BRAIN_REFRESH=1
import { writeFileSync, readFileSync, existsSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import { createHash } from "node:crypto";
import { createClient } from "@supabase/supabase-js";
import { analyzeConversation } from "../app/lib/brain-core";
const sb = createClient(process.env.NEXT_PUBLIC_SUPABASE_URL ?? "", process.env.SUPABASE_SERVICE_ROLE_KEY ?? process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY ?? "");
const Y = "dd34f5b0-03bf-4dfb-a598-a4d18ebb8df7";

/** 場面の鍵: 直近30発言の（送り手・AIX か・文面）＋状態＋戦略の有無＋使い回しの名前。時刻は入れない */
async function sceneKey(label: string, status: string, hasStrategy: boolean): Promise<string> {
  const { data } = await sb.from("messages").select("sender, text, is_aix_generated").eq("conversation_id", Y).order("created_at", { ascending: false }).limit(30);
  const rows = ((data ?? []) as Array<{ sender: string; text: string | null; is_aix_generated: boolean | null }>).reverse();
  const body = JSON.stringify({ label, status, hasStrategy, m: rows.map((r) => [r.sender, !!r.is_aix_generated, r.text ?? ""]) });
  return createHash("sha1").update(body).digest("hex").slice(0, 16);
}

async function main() {
  const out = process.argv[2];
  const { data: c } = await sb.from("conversations").select("status, property_customer_id, brain_strategy, conversation_direction").eq("id", Y).maybeSingle();
  const cc = (c ?? {}) as Record<string, unknown>;
  const strategy = (cc.brain_strategy ?? null) as never;
  const prevDir = (cc.conversation_direction ?? null) as Record<string, unknown> | null;
  const status = (cc.status as string) ?? "proposing";

  const label = (process.env.BRAIN_CACHE_LABEL ?? "").trim();
  const cacheDir = process.env.BRAIN_CACHE_DIR ?? join(process.cwd(), "scripts", ".brain-cache");
  const cacheFile = label ? join(cacheDir, `${label}-${await sceneKey(label, status, !!strategy)}.json`) : null;
  if (cacheFile && existsSync(cacheFile) && process.env.BRAIN_REFRESH !== "1") {
    writeFileSync(out, readFileSync(cacheFile, "utf8"), "utf8");
    console.log("brain reused", cacheFile);
    setTimeout(() => process.exit(0), 100);
    return;
  }

  const meta = await analyzeConversation(Y, true, status, null, "brain", {
    autoSendEnabled: false, customerName: "YUMA",
    prevPhase: typeof prevDir?.current_phase === "string" ? prevDir.current_phase : null,
    prevAix: typeof prevDir?.suggested_aix_button === "string" ? prevDir.suggested_aix_button : null,
    mode: strategy ? "incremental" : "full", layer: strategy ? "fresh" : "combined", strategy: strategy ?? null,
  });
  const json = JSON.stringify(meta ?? null);
  writeFileSync(out, json, "utf8");
  // 取れなかった回（null）は保存しない（次に取り直せるように）
  if (cacheFile && meta) { mkdirSync(cacheDir, { recursive: true }); writeFileSync(cacheFile, json, "utf8"); }
  console.log("brain done", !!meta, strategy ? "fresh" : "combined", cacheFile && meta ? `saved ${cacheFile}` : "");
  setTimeout(() => process.exit(0), 500);
}
main().catch((e) => { console.error(e); process.exit(1); });
