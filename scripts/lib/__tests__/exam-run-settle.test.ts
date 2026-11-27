// 止まった回の残りの片付け（scripts/lib/exam-run-settle.ts）の純関数の試験
import assert from "node:assert/strict";
import { leftoverBackupsOf, labelPidsOf } from "../exam-run-settle";
let ok = 0, ng = 0;
const t = (name: string, f: () => void) => { try { f(); ok++; } catch (e) { ng++; console.error("✕", name, String(e)); } };
t("中身の残った控えだけ・同じ label だけ", () => {
  const files = [
    { name: ".brain-exam-pfm-1-q141-yuma2-pc-backup.json", body: "{\"id\":\"x\"}" },
    { name: ".brain-exam-pfm-1-q141-yuma3-pc-backup.json", body: "" },
    { name: ".brain-exam-pfm-1-q1410-yuma2-pc-backup.json", body: "{}" },
    { name: ".brain-exam-pfm-1-q141-yuma2-pc-backup.json.stale-202611270815", body: "{}" },
    { name: ".brain-exam-pfm-1-q141-yuma-pc-backup.json", body: "{}" },
  ];
  assert.deepEqual(leftoverBackupsOf(files, "pfm-1-q141"), [{ name: files[0].name, conv: "YUMA2" }, { name: files[4].name, conv: "YUMA" }]);
});
t("label の記号を正規表現にしない", () => { assert.deepEqual(leftoverBackupsOf([{ name: ".brain-exam-aXb-yuma2-pc-backup.json", body: "{}" }], "a.b"), []); });
t("--label が丸ごと一致する node だけ", () => {
  const ps = [
    { pid: 1, cmd: "node cli.mjs scripts/brain-exam.ts --label=pfm-1-q009 --conv=auto" },
    { pid: 2, cmd: "node cli.mjs scripts/brain-exam.ts --label=pfm-1-q0091 --conv=auto" },
    { pid: 3, cmd: "node x \"--label=pfm-1-q009\"" },
    { pid: 4, cmd: "node x --label=pfm-1-q009" },
    { pid: 5, cmd: "node x --run-queue" },
  ];
  assert.deepEqual(labelPidsOf(ps, "pfm-1-q009"), [1, 3, 4]);
});
console.log(`exam-run-settle: ${ok}/${ng}`);
if (ng) process.exit(1);
