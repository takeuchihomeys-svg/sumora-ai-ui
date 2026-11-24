// 統括の指示書が読んでいなかった材料を読む（台帳 #674・BRIEF_READ_EXTRA・app/lib/conductor-brief.ts）
// 実行: npx tsx app/lib/__tests__/conductor-brief-extra.test.ts（全 PASS で exit 0）
import { buildConductorBrief, briefReadExtraOn } from "../conductor-brief";

let pass = 0, fail = 0;
const ok = (name: string, c: boolean, d: unknown = "") => { if (c) pass++; else { fail++; console.error(`✗ ${name}`, d); } };
const meta = {
  judge_basis_rec: { purpose: "confirm_promise", key_point: "約束の確認の結果を先に" },
  material_clash: { v: 1, opposed: [{ a: "rule6", b: "ack_form", kind: "aix_reply", level: "yes", dyn: false }] },
  situation_now: { v: 1, timeline: { words: [{ word: "来月", said: "2026-11-20T00:00:00Z", from: null, to: null, label: "12月" }] } },
};
ok("既定は off", !briefReadExtraOn({}) && briefReadExtraOn({ BRIEF_READ_EXTRA: "on" }));
delete process.env.BRIEF_READ_EXTRA;
ok("off の時は extra が無い（今と同じ）", buildConductorBrief(meta).extra === undefined);
process.env.BRIEF_READ_EXTRA = "on";
const b = buildConductorBrief(meta);
ok("on: 判断の根拠の記録・材料の食い違い・時の言葉を読む", b.extra?.basis?.purpose === "confirm_promise" && b.extra?.clash?.[0]?.a === "rule6" && b.extra?.time_words?.[0]?.word === "来月", b.extra);
ok("on でも judge_basis（on の時の欄）がある時は basis を重ねない", buildConductorBrief({ ...meta, judge_basis: { purpose: "x" } }).extra?.basis === undefined);
ok("材料が無ければ extra を付けない", buildConductorBrief({}).extra === undefined);
delete process.env.BRIEF_READ_EXTRA;

console.log(`conductor-brief-extra: PASS ${pass} / FAIL ${fail}`);
if (fail) process.exit(1);
