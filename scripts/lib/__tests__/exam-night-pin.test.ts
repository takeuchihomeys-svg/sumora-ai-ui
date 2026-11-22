// 前を作った構成ごとに「この晩の前の commit」を控える（scripts/lib/exam-base-pin.ts の nightPinUpdate）
// 実行: npx tsx scripts/lib/__tests__/exam-night-pin.test.ts（全 PASS で exit 0）
// 2026-11-21 作業員H: 夜の基準は stage=brain の構成だけ → draft の依頼は夜に main が進むたびに前を作り直していた（7日 前 $42.9）
import { nightPinUpdate, decideBasePin } from "../exam-base-pin";
import { nightStartMs } from "../exam-cost-gate";

let pass = 0, fail = 0;
const ok = (name: string, c: boolean, d: unknown = "") => { if (c) pass++; else { fail++; console.error(`✗ ${name}`, d); } };
const now = Date.parse("2026-11-21T15:00:00Z"); // JST 0時
const ns = nightStartMs(now);                   // JST 11/21 12時
const built = (commit: string, problems: string[]) => ({ commit, cfg: "d68686dd11", snapDay: "2026-11-21", problems });

const w1 = nightPinUpdate(null, built("aaaaaaa1", ["q1", "q2"]), now, ns);
ok("控えが無ければ新しく書く", !!w1 && w1.commit === "aaaaaaa1" && w1.problems.join() === "q1,q2" && w1.cfg === "d68686dd11");
const w2 = nightPinUpdate(w1, built("aaaaaaa1", ["q2", "q3"]), now + 60_000, ns);
ok("同じ commit なら作った問題を足す（at は変えない）", !!w2 && w2.problems.join() === "q1,q2,q3" && w2.at === w1!.at, w2);
ok("足す問題が無ければ書かない", nightPinUpdate(w2, built("aaaaaaa1", ["q1"]), now, ns) === null);
ok("この晩の控え（別の commit）は上書きしない＝最初の commit に固定", nightPinUpdate(w2, built("bbbbbbb2", ["q9"]), now + 3600_000, ns) === null);
const old = { commit: "ccccccc3", at: new Date(ns - 3600_000).toISOString(), cfg: "d68686dd11", problems: ["q1"] };
const w3 = nightPinUpdate(old, built("ddddddd4", ["q5"]), now, ns);
ok("晩より前の控えは新しい commit で書き直す", !!w3 && w3.commit === "ddddddd4" && w3.problems.join() === "q5");
ok("作った問題が0なら書かない", nightPinUpdate(null, built("x", []), now, ns) === null);

// 書いた控えを後の依頼が使う（decideBasePin・その後の main は試験の線に触れる既定 on の変更＝悪化に見えた問題だけ今の main で確かめ直す）
const d = decideBasePin({ nightly: w2!, nowMs: now + 2 * 3600_000, requestHasNightly: true, since: { files: ["app/lib/brain-core.ts"], defaultOnChange: true }, problems: ["q1", "q4"] });
ok("後の依頼はこの晩の commit に固定・確かめ直しあり・無い問題は missing", d.ref === "aaaaaaa1" && d.confirmOnCurrent && d.missing.join() === "q4", d);

console.log(`exam-night-pin: ${pass} pass / ${fail} fail`);
if (fail) process.exit(1);
