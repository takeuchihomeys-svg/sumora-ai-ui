/**
 * 手元の再点検で統括根拠の土台行を置き換える（本番の古い数え方の F28 70.6% を Pro に残さない）
 * 実行: npx tsx app/lib/__tests__/foundation-evidence-refresh.test.ts
 */
import { refreshFoundationEvidence, type FoundationAudit } from "../learn-foundation-audit";

let fail = 0;
function ok(name: string, cond: boolean) {
  console.log(`${cond ? "✓" : "✗"} ${name}`);
  if (!cond) fail++;
}

const item = (id: string, okv: boolean, line: string) => ({ id, ok: okv, line, next: "次", layer: "free" });
const fa = {
  ok_n: 2,
  missing_n: 1,
  summary: "土台(realpro) 2/3 ✓／欠 1",
  screen_solid: 878,
  items: [
    item("F28_auto_gap_floor", true, "自動の短間隔 0%（元120→重複除去40→1押下17）"),
    item("F29_human_nearness", false, "近さ 51点"),
    item("F41_button_done_marks", true, "done印 自動の行に有"),
  ],
} as unknown as FoundationAudit;

const before = [
  { label: "結論", value: "x" },
  { label: "学習土台点検（F番号）", value: "土台(all) 29/56" },
  { label: "土台 F28_auto_gap_floor", value: "✗ 短間隔 70.6%" },
  { label: "土台 F29_human_nearness", value: "✗ 近さ 7点" },
  { label: "土台 F99_unknown", value: "そのまま" },
];
const out = refreshFoundationEvidence(before, fa, "［realpro］");
const v = (label: string) => out.filter((e) => e.label === label).map((e) => e.value);

ok("要約は再点検の値", v("学習土台点検（F番号）")[0]?.startsWith("［realpro］土台(realpro) 2/3") === true);
ok("要約は1件", v("学習土台点検（F番号）").length === 1);
ok("F28 は ✓ 0% に置き換え", v("土台 F28_auto_gap_floor")[0]?.startsWith("✓ 自動の短間隔 0%") === true);
ok("F29 は 51点に置き換え", v("土台 F29_human_nearness")[0] === "✗ 近さ 51点");
ok("F28 は1件（二重にしない）", v("土台 F28_auto_gap_floor").length === 1);
ok("束に無かった F41 は足す", v("土台 F41_button_done_marks")[0]?.startsWith("✓") === true);
ok("関係ない行は残す", v("結論")[0] === "x" && v("土台 F99_unknown")[0] === "そのまま");
ok("元の配列は変えない", before[2].value === "✗ 短間隔 70.6%");

if (fail) { console.log(`\n✗ ${fail} 件失敗`); process.exit(1); }
console.log("\n✓ 全部通過");
