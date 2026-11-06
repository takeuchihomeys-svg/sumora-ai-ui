// 夜の基準に固定するか（scripts/lib/exam-base-pin.ts）の単体テスト（LLM も DB も git も使わない）
// 実行: npx tsx scripts/lib/__tests__/exam-base-pin.test.ts（全 PASS で exit 0）
import { decideBasePin, touchesExam, confirmTargets, defaultOnFromSubjects, nightBaseJobDue, isExamJobShape, nightBaseAlready, pinConfirmIds, mergePinnedBase, NIGHT_BASE_REPEAT } from "../exam-base-pin";

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

{
  const day = nightBaseJobDue(null, new Date("2026-11-05T05:00:00Z"), { cwd: "/x" }); // JST 14時
  ok("夜の基準: 昼は積まない", !day.due && day.job === null);
  const n = nightBaseJobDue(null, new Date("2026-11-05T13:00:00Z"), { cwd: "/x" }); // JST 22時
  ok("夜の基準: 夜に1つ積む", n.due && n.day === "2026-11-05" && String((n.job as { cmds: string[] }).cmds[0]).includes("--baseline-only") && (n.job as { nightOnly: boolean }).nightOnly);
  ok("夜の基準: 同じ日は2回積まない", !nightBaseJobDue("2026-11-05", new Date("2026-11-05T14:00:00Z"), { cwd: "/x" }).due);
}

ok("依頼の形: 夜の基準の印（{day, at}）は依頼でない（11/05 21:49 の落ち）", !isExamJobShape({ day: "2026-11-05", at: "x" }));
ok("依頼の形: brain-exam の依頼", isExamJobShape({ id: "1", label: "a", only: "q1" }));
ok("依頼の形: only が無い brain-exam は依頼でない", !isExamJobShape({ id: "1", label: "a" }));
ok("依頼の形: cmd は cmds が要る", isExamJobShape({ id: "1", label: "a", runner: "cmd", cmds: ["scripts/x.ts"] }) && !isExamJobShape({ id: "1", label: "a", runner: "cmd" }));
ok("依頼の形: tsc-remote", isExamJobShape({ id: "1", label: "a", runner: "tsc-remote", only: "" }));
ok("依頼の形: 知らない runner・配列・null は依頼でない", !isExamJobShape({ id: "1", label: "a", runner: "x" }) && !isExamJobShape([]) && !isExamJobShape(null));
ok("二重に積まない: 列・済み・結果に同じ日の名前", nightBaseAlready("2026-11-05", ["2026-11-05T12-00-00-000Z-night-base-2026-11-05.json"]) && !nightBaseAlready("2026-11-06", ["x-night-base-2026-11-05.json"]));

{
  // 11/06 統括役: 夜の基準に固定して、外れた問題だけ今の main で確かめ直す
  const rows = [{ id: "q1", score: { pass: true } }, { id: "q2", score: { pass: false } }, { id: "q2", score: { pass: true } }, { id: "q3", score: { pass: true } }, { id: "q4", error: "x", score: { pass: false } }];
  ok("確かめ直しは外れた回のある問題だけ（全部○は悪化になりえない・失敗の行は数えない）", pinConfirmIds(rows).join(",") === "q2");
  const night = [{ id: "q1", v: "n" }, { id: "q2", v: "n" }, { id: "q2", v: "n" }], cur = [{ id: "q2", v: "c" }, { id: "q2", v: "c" }];
  const m = mergePinnedBase(night, cur, ["q2"]);
  ok("確かめ直した問題は今の main の前・他は夜の基準", m.filter((r) => r.id === "q2").every((r) => r.v === "c") && m.filter((r) => r.id === "q2").length === 2 && m.find((r) => r.id === "q1")?.v === "n");
  ok("今の main の前が作れなかった問題は夜の基準のまま", mergePinnedBase(night, [], ["q2"]).filter((r) => r.id === "q2").every((r) => r.v === "n"));
}

{
  // 11/07: 途中までの夜の基準（作れた問題の一覧だけ控えに入る）。控えに無い問題は missing＝昼の依頼が前を作る
  const nb = { commit: "abc1234", at: new Date(Date.now() - 3_600_000).toISOString(), problems: ["q001", "q002"] };
  const d = decideBasePin({ nightly: nb, nowMs: Date.now(), requestHasNightly: true, since: { files: [] }, problems: ["q001", "q003"] });
  ok("途中までの控え: 控えにある問題は夜の基準・無い問題は missing（前を作る）", d.ref === "abc1234" && d.missing.join(",") === "q003");
  // 夜の基準は昼の依頼と同じ --repeat（構成の鍵）で作る
  const nj = nightBaseJobDue(null, new Date("2026-11-07T12:30:00Z"), { cwd: "/x" });
  ok("夜の基準の依頼は --repeat=4（昼の依頼の構成と同じ）・main が進んでも止めない", NIGHT_BASE_REPEAT === 4 && String((nj.job as { cmds: string[] }).cmds[0]).includes("--repeat=4") && (nj.job as { env: Record<string, string> }).env.EXAM_BASELINE_IGNORE_MAIN_MOVED === "1");
}

console.log(`${pass} pass / ${fail} fail`);
process.exit(fail ? 1 : 0);
