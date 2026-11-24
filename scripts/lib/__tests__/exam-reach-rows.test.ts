// 1本の表（#683 と #684）: exam-room と exam-select が同じ行（rowOf）を使えているか
import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { rowOfWith, learnedForSelect, tableOf } from "../exam-reach-rows";
import { roomOf } from "../exam-room";
import { selectMinimal } from "../exam-select";
import type { LearnedReachFile } from "../exam-learned-reach";

const file: LearnedReachFile = {
  v: 1, at: "2026-11-25T00:00:00Z", days: 60,
  switches: {
    BRAIN_FAR_OTHER_FIRST: { runs: 2, lastRunAt: "2026-11-24T00:00:00Z", problems: { q1: { v: "none", same: 2, diff: 0, mark: 0, lastAt: "x" }, q2: { v: "hit", same: 0, diff: 1, mark: 1, lastAt: "x" } } },
  },
};
const dir = mkdtempSync(join(tmpdir(), "l-reach-"));
writeFileSync(join(dir, "learned-reach.json"), JSON.stringify(file));

// 置き場から読む（loadLearnedReach を通す）
let calls = 0;
const base = rowOfWith({ path: join(dir, "learned-reach.json") });
const rowOf = (sw: string) => { calls++; return base(sw); };
const row = rowOf("BRAIN_FAR_OTHER_FIRST");
assert.equal(row.inTable, true);
assert.equal(row.fixes?.turn, "far_other", "表の欄（コードで決まる物）");
assert.equal(row.learned.get("q1"), "none", "置き場の覚え");
assert.equal(rowOf("NOT_IN_FILE").learned.size, 0, "置き場に無いスイッチは空＝unknown");
assert.equal(rowOfWith({ path: join(dir, "nothing.json") })("BRAIN_FAR_OTHER_FIRST").learned.size, 0, "置き場が無い時も空");

// exam-room（#684）: 同じ行の fixes で余地を数える
calls = 0;
const on = ["BRAIN_FAR_OTHER_FIRST"];
const r = roomOf({ onSwitches: on, table: tableOf(on, rowOf), turns: [{ conv: "c", at: 0, isReply: true, mismatch: true, materials: {}, text: "遠いので他の候補もありますか" }] });
assert.deepEqual([r.applicable, r.room], [1, 1]);
// exam-select（#683）: 同じ行の learned で、効かない問題を落とす（needs が無いスイッチ＝覚えた表の道）
const sel = selectMinimal({ ids: ["q1", "q2", "q3"], onSwitches: on, prior: new Map(), off: new Map(), table: tableOf(on, rowOf), stage: "brain", learned: learnedForSelect(on, rowOf) });
assert.deepEqual(sel.drop.map((d) => d.id), ["q1"], "効かない（none）だけ落とす");
assert.deepEqual(sel.keep.map((k) => k.id).sort(), ["q2", "q3"], "効いた・分からないは残す");
assert.ok(calls >= 2, "どちらも同じ rowOf を通った");
console.log("exam-reach-rows: ok");
