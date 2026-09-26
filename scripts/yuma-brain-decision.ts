// YUMA のブレイン判断だけを取る（保存しない＝AIX要対応の通知なし）。cwd の木のコードで動く（前＝worktree／後＝作業コピー）
// scripts/yuma-done-state-test.ts から呼ぶ（前の木には無ければ複写して使う）。実行: npx tsx --env-file=.env.local scripts/yuma-brain-decision.ts <出力JSON>
import { writeFileSync } from "node:fs";
import { createClient } from "@supabase/supabase-js";
import { analyzeConversation } from "../app/lib/brain-core";
const sb = createClient(process.env.NEXT_PUBLIC_SUPABASE_URL ?? "", process.env.SUPABASE_SERVICE_ROLE_KEY ?? process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY ?? "");
const Y = "dd34f5b0-03bf-4dfb-a598-a4d18ebb8df7";
async function main() {
  const out = process.argv[2];
  const { data: c } = await sb.from("conversations").select("status, property_customer_id, brain_strategy, conversation_direction").eq("id", Y).maybeSingle();
  const cc = (c ?? {}) as Record<string, unknown>;
  const strategy = (cc.brain_strategy ?? null) as never;
  const prevDir = (cc.conversation_direction ?? null) as Record<string, unknown> | null;
  const meta = await analyzeConversation(Y, true, (cc.status as string) ?? "proposing", null, "brain", {
    autoSendEnabled: false, customerName: "YUMA",
    prevPhase: typeof prevDir?.current_phase === "string" ? prevDir.current_phase : null,
    prevAix: typeof prevDir?.suggested_aix_button === "string" ? prevDir.suggested_aix_button : null,
    mode: strategy ? "incremental" : "full", layer: strategy ? "fresh" : "combined", strategy: strategy ?? null,
  });
  writeFileSync(out, JSON.stringify(meta ?? null), "utf8");
  console.log("brain done", !!meta, strategy ? "fresh" : "combined");
  setTimeout(() => process.exit(0), 500);
}
main().catch((e) => { console.error(e); process.exit(1); });
