// 夜の基準に固定するか（scripts/lib/exam-base-pin.ts）の単体テスト（LLM も DB も git も使わない）
// 実行: npx tsx scripts/lib/__tests__/exam-base-pin.test.ts（全 PASS で exit 0）
import { decideBasePin, touchesExam, confirmTargets, defaultOnFromSubjects } from "../exam-base-pin";

let fail = 0, pass = 0;
function ok(name: string, cond: boolean, detail = "") { if (cond) pass++; else { fail++; console.error(`✗ ${name}${detail ? `\n   ${detail}` : ""}`); } }

const now = Date.parse("2026-11-05T05:00:00Z");
const nightly = { commit: "97fe109aaaaaaa", at: "2026-11-04T23:00:00Z", problems: ["q001", "q002", "q003"] };
const base = { nightly, nowMs: now, requestHasNightly: true, problems: ["q001", "q009"] };

ok("線: 文書は触れない", !touchesExam("memory/hazard_checklist.md"));
ok("線: 画面は触れない", !touchesExam("app/admin/page.tsx"));
ok("線: 他の台本は触れない", !touchesExam("scripts/audit-prod-as-exam.ts"));
ok("線: テストは触れない", !touchesExam("scripts/lib/__tests__/x.test.ts"));
ok("線: ブレインは触れる", touchesExam("app/lib/brain-core.ts"));
ok("線: 試験の道具は触れる", touchesExam("scripts/brain-exam.ts") && touchesExam("scripts/lib/exam-lane.ts"));
ok("線: 分からない app は触れる（安全側）", touchesExam("app/api/generate-reply/route.ts"));

{
  const d = decideBasePin({ ...base, nightly: null, since: { files: [] } });
  ok("夜の基準が無い→今まで通り", d.ref === null);
}
{
  const d = decideBasePin({ ...base, nowMs: Date.parse("2026-11-06T12:00:00Z"), since: { files: [] } });
  ok("古い→今まで通り", d.ref === null && /古い/.test(d.why));
}
{
  const d = decideBasePin({ ...base, requestHasNightly: false, since: { files: [] } });
  ok("古い作業ツリー→今まで通り（点検表 12）", d.ref === null && /含まない/.test(d.why));
}
{
  const d = decideBasePin({ ...base, since: { files: ["memory/x.md", "app/admin/page.tsx"] } });
  ok("線に触れない→夜だけ", d.ref === nightly.commit && !d.confirmOnCurrent);
  ok("夜に無い問題は missing", d.missing.join(",") === "q009");
}
{
  const d = decideBasePin({ ...base, since: { files: ["app/lib/brain-core.ts"], defaultOnChange: false } });
  ok("既定 off の足し込みだけ→夜だけ", d.ref === nightly.commit && !d.confirmOnCurrent);
}
{
  const d = decideBasePin({ ...base, since: { files: ["app/lib/brain-core.ts"] } });
  ok("既定 on が分からない→夜＋確かめ直し（安全側）", d.ref === nightly.commit && d.confirmOnCurrent);
}
ok("確かめ直しは悪化だけ", confirmTargets([{ id: "q1", cmp: "worse" }, { id: "q2", cmp: "worseFlake" }, { id: "q3", cmp: "better" }, { id: "q4", cmp: "same" }]).join(",") === "q1,q2");

ok("題: 既定 off だけ→false", !defaultOnFromSubjects(["feat(組み合わせ): …（どれも既定 off）", "fix(x): 記録だけ"]));
ok("題: 既定 on が1つ→true", defaultOnFromSubjects(["feat(a): …（既定 off）", "feat(挨拶): …（GREETING_CONTINUATION_SKIP 既定 on）"]));
ok("題: 書いていない題は安全側で true", defaultOnFromSubjects(["fix(送った資料の読み直し): 読めなかった画像を読み直す"]));
ok("題: 空→false", !defaultOnFromSubjects([]));

console.log(`${pass} pass / ${fail} fail`);
process.exit(fail ? 1 : 0);
