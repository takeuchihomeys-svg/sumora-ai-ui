// 試験の問題 id を使い回さない網（scripts/lib/exam-id-ledger.ts）の単体テスト（git も DB も使わない）
// 実行: npx tsx scripts/lib/__tests__/exam-id-ledger.test.ts（全 PASS で exit 0）
import { nextIdNumber, idClashes, withSpec, ledgerFromHistory, rowFromReusedId } from "../exam-id-ledger";

let fail = 0, pass = 0;
function ok(name: string, cond: boolean, detail = "") { if (cond) pass++; else { fail++; console.error(`✗ ${name}${detail ? `\n   ${detail}` : ""}`); } }

// 11/06 15:00 に q374（会話 A）・23:08 に外す・11/07 03:33 に q374 を別の番（会話 B）に使った
const v1 = { at: "2026-11-06T06:00:50Z", spec: [{ id: "q373", conv: "x", at: "p" }, { id: "q374", conv: "A", at: "a" }] };
const v2 = { at: "2026-11-06T14:08:43Z", spec: [{ id: "q373", conv: "x", at: "p" }] };
const v3 = { at: "2026-11-06T18:33:41Z", spec: [{ id: "q373", conv: "x", at: "p" }, { id: "q374", conv: "B", at: "b" }] };
const led = ledgerFromHistory([v1, v2, v3], v3.spec);
ok("歴史: 使い回した id は今の番を正にし、今の番が入った時刻を残す", led.ids.q374 === "B|b" && led.reused.q374?.since === v3.at && led.reused.q374.old.join(",") === "A|a", JSON.stringify(led));
ok("古い答案の行（今の番が入る前）は採点から外す・今の番の行は外さない", rowFromReusedId({ id: "q374", at: "2026-11-06T10:00:00Z" }, led) && !rowFromReusedId({ id: "q374", at: "2026-11-07T00:00:00Z" }, led) && !rowFromReusedId({ id: "q373", at: "2026-11-06T10:00:00Z" }, led));
// 外した一番大きい id を次に使わない
const led2 = ledgerFromHistory([{ at: "t1", spec: [{ id: "q385" }, { id: "q386" }] }], [{ id: "q385" }]);
ok("次の番号は控えの最大＋1（外した q386 を使い回さない）", nextIdNumber([{ id: "q385" }], led2) === 387 && nextIdNumber([{ id: "q385" }], null) === 386);
// 控えにある id の番の印が違う spec は止める
ok("使い回しの疑い: 控えの印と違う id", idClashes([{ id: "q373", conv: "y", at: "q" }], led).join(",") === "q373" && idClashes(v3.spec, led).length === 0);
ok("控えに足す時はある id を上書きしない", withSpec(led, [{ id: "q373", conv: "z", at: "r" }, { id: "q390", conv: "n", at: "n" }]).ids.q373 === "x|p" && withSpec(led, [{ id: "q390" }]).maxN === 390);

console.log(`${pass} pass / ${fail} fail`);
process.exit(fail ? 1 : 0);
