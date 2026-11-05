// app/lib/__tests__/switch-fingerprint.test.ts — 版の記録（スイッチの組の指紋）
//   実行: npx tsx app/lib/__tests__/switch-fingerprint.test.ts
import { switchEntries, switchFingerprint, digestVerOn, fnv1a } from "../switch-fingerprint";
import { brainDecisionDigestExtra } from "../brain-decision-ledger";
let pass = 0, fail = 0;
const t = (name: string, ok: boolean) => { if (ok) { pass++; console.log(`  OK  ${name}`); } else { fail++; console.log(`  NG  ${name}`); } };
const env = { BRAIN_MATERIAL_SELF_REPORT: "on", AIX_DESK_COMMAND: "shadow", LLM_ALT_ACTIONS: "aix_desk_command,aix_desk_consult", AIX_SECRET_TOKEN: "abc", BRAIN_API_KEY: "x", BRAIN_NOTE: "has space", PATH: "/usr/bin", NEXT_PUBLIC_SUPABASE_URL: "https://x" };
const e = switchEntries(env).map(([k]) => k).join(",");
t("スイッチだけを並べる（鍵・空白入りの値・関係ない名前は入れない）", e === "AIX_DESK_COMMAND,BRAIN_MATERIAL_SELF_REPORT,LLM_ALT_ACTIONS");
const a = switchFingerprint(env), b = switchFingerprint({ ...env, PATH: "/other" }), c = switchFingerprint({ ...env, AIX_DESK_COMMAND: "on" });
t("指紋は8字", /^[0-9a-f]{8}$/.test(a.h) && a.n === 3);
t("関係ない環境が変わっても指紋は同じ", a.h === b.h);
t("スイッチが変われば指紋が変わる", a.h !== c.h);
t("並べ方に依らない", switchFingerprint({ AIX_DESK_COMMAND: "shadow", BRAIN_MATERIAL_SELF_REPORT: "on", LLM_ALT_ACTIONS: "aix_desk_command,aix_desk_consult" }).h === a.h);
t("中身に鍵の値が入らない", !a.text.includes("abc") && !a.text.includes("https"));
t("FNV-1a の既知の値", fnv1a("") === "811c9dc5");
t("既定 on・off で止める", digestVerOn({}) && !digestVerOn({ BRAIN_DIGEST_VER: "off" }));
t("digest に ver が入る", JSON.stringify((brainDecisionDigestExtra({}, env) as Record<string, unknown>).ver) === JSON.stringify({ sw: a.h }));
t("off なら入らない", !("ver" in brainDecisionDigestExtra({}, { ...env, BRAIN_DIGEST_VER: "off" })));
// 2026-11-05 作業員9（弱い所 323）: 統括・文・夜の線の名前も拾う／鍵らしい名前は拾わない
{
  const e = switchEntries({ CONDUCTOR_INTAKE: "shadow", TWO_MESSAGE_PLAN: "on", FLASH_WRITER_ADAPT: "off", WRITER_FLASH_SCENES: "ack", MGMT_HOURS_SPLIT_1028: "on", TAKEUCHI_WORDING_R11: "off", EXAMPLE_WRITER_BOOST: "off", TURN_CONTRACT_LASTMETA: "off", CONDUCTOR_API_KEY: "abc", PATH: "x" }).map(([k]) => k);
  t("新しい名前の頭を拾う", ["CONDUCTOR_INTAKE", "TWO_MESSAGE_PLAN", "FLASH_WRITER_ADAPT", "WRITER_FLASH_SCENES", "MGMT_HOURS_SPLIT_1028", "TAKEUCHI_WORDING_R11", "EXAMPLE_WRITER_BOOST", "TURN_CONTRACT_LASTMETA"].every((k) => e.includes(k)));
  t("鍵らしい名前と関係ない名前は拾わない", !e.includes("CONDUCTOR_API_KEY") && !e.includes("PATH"));
}
console.log(`\n${pass} passed, ${fail} failed`);
if (fail) process.exit(1);
