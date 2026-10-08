// scripts/audit-r9-overlay-reach.ts — 9巡目の重ね（rules-overlay.ts・testFlags.rules_r9）が各経路のルールの文字列をどう変えるか（DB は読むだけ・LLM なし）
//   off（今の DB）／on（段1）／stage2（段1＋段2）で: 返信生成（generate_reply＋global）・最終チェック（final_check）・ブレインの【絶対ルール】【線引き】・
//   ブレインの行動の候補のルール・AIX の各 action（fetchPromptRulesSplit）の 本数・字数・入れ替わった行 を出す。
// 実行: npx tsx --env-file=.env.local scripts/audit-r9-overlay-reach.ts [--show=generate_reply]
import { buildR9Overlay, runWithRulesOverlay, type RulesR9Mode } from "../app/lib/rules-overlay";

const SHOW = process.argv.find((a) => a.startsWith("--show="))?.slice(7) ?? "";
const AIX = ["property_check_result", "viewing_invite", "meeting_place", "application_push", "followup_revive", "property_recommendation", "property_send", "estimate_sheet", "condition_hearing", "acknowledge_check", "cost_breakdown", "guarantor_info"];

async function main() {
  const { fetchPromptRules, fetchPromptRulesSplit } = await import("../app/lib/prompt-rules");
  const { loadBrainSystemInputs } = await import("../app/lib/brain-core");
  const lines = (s: string) => s.split("\n").filter((l) => /^・|^- /.test(l.trim())).length;
  const out: Record<string, Record<RulesR9Mode, string>> = {};
  for (const mode of ["off", "on", "stage2"] as RulesR9Mode[]) {
    const ov = buildR9Overlay(mode);
    await runWithRulesOverlay(ov, async () => {
      const put = (k: string, v: string) => { (out[k] ??= {} as Record<RulesR9Mode, string>)[mode] = v; };
      put("返信 generate_reply", await fetchPromptRules("generate_reply", { conversation_state: "proposing", is_first_reply: "false" }));
      put("最終チェック final_check", await fetchPromptRules("final_check", {}, false));
      const b = await loadBrainSystemInputs();
      put("ブレイン【絶対ルール】", b.promptRules.map((r) => `- ${r.rule_text}`).join("\n"));
      put("ブレイン【線引き】", b.boundaryPromptRules.map((r) => `- ${r.rule_text}`).join("\n"));
      for (const a of AIX) {
        const s = await fetchPromptRulesSplit(a, {});
        put(`AIX ${a}（action）`, s.action);
        if (a === AIX[0]) put("AIX 共通（global）", s.global);
      }
    });
  }
  console.log("経路\toff 行/字\ton 行/字\tstage2 行/字");
  for (const [k, v] of Object.entries(out)) console.log(`${k}\t${lines(v.off)}/${v.off.length}\t${lines(v.on)}/${v.on.length}\t${lines(v.stage2)}/${v.stage2.length}`);
  if (SHOW) {
    const k = Object.keys(out).find((x) => x.includes(SHOW));
    if (k) {
      const set = (s: string) => new Set(s.split("\n").filter((l) => l.trim()));
      const off = set(out[k].off), on = set(out[k].on);
      console.log(`\n=== ${k}: on で消えた行 ===`); for (const l of off) if (!on.has(l)) console.log("- " + l.slice(0, 200));
      console.log(`\n=== ${k}: on で入った行 ===`); for (const l of on) if (!off.has(l)) console.log("+ " + l.slice(0, 200));
    }
  }
}
main().catch((e) => { console.error(e); process.exitCode = 1; }).finally(() => setTimeout(() => process.exit(process.exitCode ?? 0), 300));
