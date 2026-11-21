// 試験の依頼の env の名前の突き合わせ（scripts/lib/exam-env-check.ts）
// 実行: npx tsx scripts/lib/__tests__/exam-env-check.test.ts（全 PASS で exit 0）
import { checkEnvNames, missingPrereqs, nearNames, sameAsDefault } from "../exam-env-check";

let pass = 0, fail = 0;
const ok = (name: string, c: boolean, d: unknown = "") => { if (c) pass++; else { fail++; console.error(`✗ ${name}`, d); } };
const read = new Set(["COMPOSE_LEAD_JUDGE_FIRST", "COMPOSE_CLOSING_TABLE", "BRAIN_ESTIMATE_RECORDS", "INFO_FILL_MAP"]);

const c = checkEnvNames({ LEAD_JUDGE_FIRST: "on", BRAIN_ESTIMATE_RECORDS: "on", EXAM_LEDGER_SIP: "on", LLM_TEST_MODE: "deepseek-all", INFO_FIL_MAP: "on" }, read);
ok("昨夜の COMPOSE_ 抜きを止め、近い名前に正しい名前", c.unread.some((u) => u.name === "LEAD_JUDGE_FIRST" && u.near[0] === "COMPOSE_LEAD_JUDGE_FIRST"), c);
ok("読む名前は通す", c.ok.includes("BRAIN_ESTIMATE_RECORDS"));
ok("試験の道具の名前（EXAM_・LLM_）は見ない", !c.unread.some((u) => /^(EXAM_|LLM_)/.test(u.name)) && !c.ok.some((n) => /^(EXAM_|LLM_)/.test(n)));
ok("1字違いも近い名前に出す", c.unread.find((u) => u.name === "INFO_FIL_MAP")?.near.includes("INFO_FILL_MAP") === true, c);
ok("Map でも読める", checkEnvNames({ INFO_FILL_MAP: "on" }, new Map([["INFO_FILL_MAP", 1]])).unread.length === 0);
ok("近い名前なし", nearNames("ZZZZ_QQQQ", read).length === 0);
ok("前提が無い COMPOSE_LEAD_JUDGE_FIRST を出す", missingPrereqs({ COMPOSE_LEAD_JUDGE_FIRST: "on" }).some((m) => m.need === "BRAIN_SEVEN_FIELDS=on"));
ok("前提が env か既定にあれば出さない", missingPrereqs({ COMPOSE_LEAD_JUDGE_FIRST: "on", BRAIN_SEVEN_FIELDS: "on" }).length === 0 && missingPrereqs({ COMPOSE_DROP_DUPLICATES: "on" }, { BRAIN_COMPOSE_BLUEPRINT: "on" }).length === 0);
ok("off で積む時は前提を見ない", missingPrereqs({ COMPOSE_LEAD_JUDGE_FIRST: "off" }).length === 0);
const rd = new Map([["COMPOSE_VALUE_SLOTS", { kind: "bool", lit: "off", dflt: "", lower: true }], ["INFO_FILL_MAP", { kind: "bool", lit: "on", dflt: "", lower: true }]]);
ok("既定 on の物を on で積むと差が出ない", JSON.stringify(sameAsDefault({ COMPOSE_VALUE_SLOTS: "on", INFO_FILL_MAP: "on" }, rd)) === JSON.stringify(["COMPOSE_VALUE_SLOTS"]));
ok("本番の .env.local で on の物も差が出ない", sameAsDefault({ INFO_FILL_MAP: "on" }, rd, { INFO_FILL_MAP: "on" }).includes("INFO_FILL_MAP"));
console.log(`exam-env-check: ${pass} PASS / ${fail} FAIL`);
process.exit(fail ? 1 : 0);
