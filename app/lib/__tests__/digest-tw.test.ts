// app/lib/__tests__/digest-tw.test.ts — 2026-11-06 弱い所 306: 2択の印は digest.tw（tc は turn_contract の道の数えのまま上書きしない）
import { toFreshDigest } from "../brain-layers";
import { brainDecisionDigestExtra } from "../brain-decision-ledger";
let pass = 0, fail = 0;
const t = (n: string, ok: boolean, info?: unknown) => { if (ok) pass++; else { fail++; console.log(`  NG ${n} → ${JSON.stringify(info)}`); } };
const meta = { two_choice_mode: true, turn_contract: { asks: [{ route: "promise" }, { route: "reply" }] } } as Record<string, unknown>;
const d = { ...toFreshDigest(meta, null), ...brainDecisionDigestExtra(meta) } as Record<string, unknown>;
t("tc は道の数えのまま（2択でも上書きされない）", d.tc === "2:r1p1a0n0", d.tc);
t("2択の印は tw", d.tw === true, d.tw);
const d2 = { ...toFreshDigest({}, null), ...brainDecisionDigestExtra({}) } as Record<string, unknown>;
t("2択でない番は tw なし", !("tw" in d2));
console.log(`\n${pass} passed, ${fail} failed`);
if (fail) process.exitCode = 1;
