// app/lib/__tests__/brain-prompt-rules-1113.test.ts — 指示文の差し替え 1113（追客・ルール⑦の当て方）（実行: npx tsx app/lib/__tests__/brain-prompt-rules-1113.test.ts）
// 実物の STATIC_BRAIN_SYSTEM（brain-core）を on／off の別プロセスで作って比べる（1112 のテストと同じ形）
import { execFileSync } from "node:child_process";
import { applyPromptRules1113, promptRules1113Enabled, PROMPT_RULE_EDITS_1113 } from "../brain-prompt-rules-1112";
let pass = 0, fail = 0;
const t = (name: string, ok: boolean) => { if (ok) pass++; else { fail++; console.log("NG:", name); } };

if (process.argv[2] === "dump") {
  import("../brain-core").then((m) => { process.stdout.write(m.STATIC_BRAIN_SYSTEM); process.exit(0); });
} else {
  const run = (v: string) => execFileSync("npx", ["tsx", `"${__filename}"`, "dump"], { env: { ...process.env, NEXT_PUBLIC_SUPABASE_URL: "http://localhost:1", NEXT_PUBLIC_SUPABASE_ANON_KEY: "dummy", ANTHROPIC_API_KEY: "dummy", BRAIN_PROMPT_RULES_1113: v }, maxBuffer: 64 * 1024 * 1024, shell: true, stdio: ["ignore", "pipe", "ignore"] }).toString("utf8");
  const off = run("off"), on = run("on");
  t("既定は off", !promptRules1113Enabled({}) && promptRules1113Enabled({ BRAIN_PROMPT_RULES_1113: "on" }));
  t("off の時は何も変えない", applyPromptRules1113("abc", {}) === "abc");
  t("実物 off: 差し替え前の文が両方ある", PROMPT_RULE_EDITS_1113.every((e) => off.includes(e.from)));
  t("実物 on: 差し替え前の文が消え、差し替えの文が入る", PROMPT_RULE_EDITS_1113.every((e) => !on.includes(e.from) && on.includes(e.to)));
  t("実物 on: 追客は物件の AIX（followup_revive は選ばない）", /followup_revive: 選ばない。お客様の返事が止まった時の追客は/.test(on));
  t("実物 on: ⑦はお客様自身のネガの気持ちだけ・『募集終了』の報告は含めない", /お客様自身の発言に、断り・キャンセル/.test(on) && !/直前スタッフ発言または直近顧客発言に「断り」/.test(on));
  t("実物 on: ⑥⑧は変えない", /ルール⑥（感謝・了承への返し方）/.test(on) && /ルール⑧（強推し直後の了承には再推奨しない）/.test(on));
  t("on と off の違いは差し替えた所だけ", on.length - off.length === PROMPT_RULE_EDITS_1113.reduce((a, e) => a + e.to.length - e.from.length, 0));
  t("元の文が無い時は黙って飛ばす", applyPromptRules1113("無関係", { BRAIN_PROMPT_RULES_1113: "on" }) === "無関係");
  console.log(`pass ${pass} / fail ${fail}`);
  process.exit(fail ? 1 : 0);
}
