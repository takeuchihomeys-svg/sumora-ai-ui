// app/lib/__tests__/brain-prompt-rules-1112.test.ts — 指示文の差し替え（実行: npx tsx app/lib/__tests__/brain-prompt-rules-1112.test.ts）
// 実物の STATIC_BRAIN_SYSTEM（brain-core）を on／off の別プロセスで作って比べる
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { applyPromptRules1112, promptRules1112Enabled, PROMPT_RULE_EDITS_1112 } from "../brain-prompt-rules-1112";

let pass = 0, fail = 0;
const t = (name: string, ok: boolean) => { if (ok) pass++; else { fail++; console.log("NG:", name); } };

if (process.argv[2] === "dump") {
  import("../brain-core").then((m) => { process.stdout.write(m.STATIC_BRAIN_SYSTEM); process.exit(0); });
} else {
  const run = (v: string) => execFileSync("npx", ["tsx", `"${__filename}"`, "dump"], { env: { ...process.env, NEXT_PUBLIC_SUPABASE_URL: "http://localhost:1", NEXT_PUBLIC_SUPABASE_ANON_KEY: "dummy", ANTHROPIC_API_KEY: "dummy", BRAIN_PROMPT_RULES_1112: v }, maxBuffer: 64 * 1024 * 1024, shell: true, stdio: ["ignore", "pipe", "ignore"] }).toString("utf8");
  const off = run("off"), on = run("on");
  const h = (s: string) => createHash("sha1").update(s).digest("hex").slice(0, 8);
  t("既定は on（11/13 束の試験で悪化0）・off で止まる", promptRules1112Enabled({}) && !promptRules1112Enabled({ BRAIN_PROMPT_RULES_1112: "off" }));
  t("off の時は何も変えない（文が同じ）", applyPromptRules1112("abc", {}) === "abc");
  t("実物 off: 差し替えの文が残っている（差し替え前の確認）", PROMPT_RULE_EDITS_1112.every((e) => off.includes(e.from)));
  t("実物 on: 差し替えの文が消えている", PROMPT_RULE_EDITS_1112.every((e) => !on.includes(e.from)));
  t("実物 on: 差し替えの文が入っている", PROMPT_RULE_EDITS_1112.every((e) => on.includes(e.to)));
  t("実物 on: 『申込誘導を必ず添える』が無い", !/申込誘導を必ず添える/.test(on) && /申込誘導を必ず添える/.test(off));
  t("実物 on: most_effective が無い", !/most_effective 最多）。/.test(on.split("【aixキー選択")[0]));
  t("on と off の違いは差し替えた所だけ（長さの差＝新旧の差の合計）", on.length - off.length === PROMPT_RULE_EDITS_1112.reduce((a, e) => a + e.to.length - e.from.length, 0));
  t("実物 off: acknowledge_check の説明が正反対に2つある（差し替え前の確認）", /acknowledge_check: 管理会社への確認依頼の文を作る（お客様宛てではない）/.test(off) && /acknowledge_check: 御見積書を送った後/.test(off));
  t("実物 on: 管理会社への確認依頼の説明が無く、代表確認だけ・確認の約束は返信（2段）", !/acknowledge_check: 管理会社への確認依頼の文を作る/.test(on) && /acknowledge_check: 御見積書を送った後/.test(on) && /募集状況の確認の約束は返信（2段）・確認の結果が出たら property_check_result/.test(on));
  t("実物 on: 『いきなり物件確認したで大丈夫』の引用が無い（cf241dbd）・実送信の数は残る", !/いきなり物件確認したで大丈夫/.test(on) && /確認します 0）/.test(on) && /いきなり物件確認したで大丈夫/.test(off));
  t("実物 on: cost_explain の 2,980円は会社の事実＝返信", /2,980円の仕組み（スモラ＝一律2,980円／イエヤス・ギガ＝0円）は会社の事実＝返信で答える/.test(on));
  t("元の文が無い時は黙って飛ばす", applyPromptRules1112("無関係", { BRAIN_PROMPT_RULES_1112: "on" }) === "無関係");
  console.log(`off ${h(off)} (${off.length}字) / on ${h(on)} (${on.length}字)`);
  console.log(`pass ${pass} / fail ${fail}`);
  process.exit(fail ? 1 : 0);
}
