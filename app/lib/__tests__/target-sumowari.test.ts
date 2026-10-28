// app/lib/__tests__/target-sumowari.test.ts — 竹内さん #10（かずき 10/27「この2件スも割適用できますでしょうか」）
//   実行: npx tsx app/lib/__tests__/target-sumowari.test.ts
import { sumowariNamedIn, compareTargets, brainHotDecision } from "../brain-attention";
let pass = 0, fail = 0;
const t = (name: string, ok: boolean) => { if (ok) { pass++; console.log(`  OK  ${name}`); } else { fail++; console.log(`  NG  ${name}`); } };
t("実物の表記ゆれ「スも割」", sumowariNamedIn("この2件スも割適用できますでしょうか"));
t("スモ割・すも割・スモワリ", sumowariNamedIn("スモ割できますか") && sumowariNamedIn("すも割って何ですか") && sumowariNamedIn("スモワリ使えますか"));
t("割引だけは当たらない", !sumowariNamedIn("割引ありますか") && !sumowariNamedIn(null));
const a = { tier: "new" as const, lastCustomerAt: "2026-10-28T01:00:00Z" };
const b = { tier: "new" as const, lastCustomerAt: "2026-10-28T02:00:00Z", sumowari: true };
t("同じ段はスモ割の人が先（発言が古くても）", [a, b].sort(compareTargets)[0] === b);
t("段が上の人はスモ割より先", [b, { tier: "viewed" as const, lastCustomerAt: null }].sort(compareTargets)[0].tier === "viewed");
t("印が無ければ今まで通り（新しい発言が先）", [a, { ...b, sumowari: undefined }].sort(compareTargets)[0].lastCustomerAt === "2026-10-28T02:00:00Z");
const now = Date.parse("2026-10-28T03:00:00Z");
const base = { status: "first_reply", createdAt: "2026-10-27T13:00:00Z", lastCustomerAt: "2026-10-27T13:42:00Z", meta: null, staffNeverReplied: true, nowMs: now };
t("新規で物件の番の印が無い → 今まで通り hot にしない", brainHotDecision(base).hot === false);
t("新規でスモ割を名指し → hot", brainHotDecision({ ...base, sumowariNamedAt: "2026-10-27T13:42:00Z" }).hot === true);
console.log(`\n${pass} OK / ${fail} NG`);
if (fail) process.exit(1);
