/**
 * 押す間隔の数え方（重複除去・1押下に畳み・click/tap/key 絞り）
 * npx tsx app/lib/__tests__/press-gaps.test.ts
 */
import { pressGapsFromRows, pressStatNote } from "../human-nearness";

let pass = 0, fail = 0;
const ok = (name: string, cond: boolean, extra?: unknown) => {
  if (cond) { pass++; console.log("  ✓ " + name); }
  else { fail++; console.log("  ✗ " + name + (extra === undefined ? "" : " → " + JSON.stringify(extra))); }
};
const auto = () => "auto";

const T0 = 1_795_000_000_000;
const click = (t: number, f = "a", extra: Record<string, unknown> = {}) => ({ k: "click", t: T0 + t, f, g: 5, ...extra });

console.log("■ 行をまたいだ重複除去（輪を丸ごと入れた写真行）");
{
  const ring = [click(0, "a"), click(1000, "b"), click(2500, "c"), click(4000, "d")];
  // 同じ輪を30行で重ねても、1回分と同じ数え方になる
  const rows = Array.from({ length: 30 }, () => ({ install_id: "i1", mode: "aix", shot_ops: ring }));
  const r = pressGapsFromRows(rows, auto).auto;
  ok("重複除去前は 30×4=120", r.rawOps === 120, r.rawOps);
  ok("重複除去後は 4", r.uniqueOps === 4, r.uniqueOps);
  ok("間隔は 1000/1500/1500", JSON.stringify(r.gaps) === "[1000,1500,1500]", r.gaps);
}
{
  // install_id が違えば別の操作（同じ t でも潰さない）
  const ops = [click(0, "a"), click(1000, "b")];
  const rows = [
    { install_id: "i1", mode: "aix", shot_ops: ops },
    { install_id: "i2", mode: "aix", shot_ops: ops },
  ];
  const r = pressGapsFromRows(rows, auto).auto;
  ok("install_id が違えば別物として数える", r.uniqueOps === 4, r.uniqueOps);
  ok("別 install の間を間隔にしない（2本の間隔）", r.gaps.length === 2, r.gaps);
}
{
  // install_id が無い行は t+k+f で重複除去
  const ops = [click(0, "a"), click(900, "b")];
  const rows = [{ mode: "aix", shot_ops: ops }, { mode: "aix", shot_ops: ops }];
  const r = pressGapsFromRows(rows, auto).auto;
  ok("install_id 無しでも t+k+f で除く", r.uniqueOps === 2 && r.gaps.length === 1, r);
}

console.log("\n■ 300ms 以内の click/tap を1押下に畳む");
{
  // 1回の押下が click 3本（0 / 120 / 250ms）→ 次の押下は 1200ms 後
  const ops = [
    click(0, "A｜a.x"), click(120, "A｜a.x2"), click(250, "A"),
    click(1200, "B｜a.y"), click(1330, "B"),
    click(2700, "C"),
  ];
  const r = pressGapsFromRows([{ install_id: "i", mode: "aix", shot_ops: ops }], auto).auto;
  ok("畳む前 6 → 畳んだ後 3", r.beforeFold === 6 && r.presses === 3, r);
  ok("間隔は塊の先頭どうし（1200 / 1500）", JSON.stringify(r.gaps) === "[1200,1500]", r.gaps);
  ok("畳む前の短い差（120/130）は間隔に出ない", !r.gaps.some((g) => g < 400), r.gaps);
}
{
  // 300ms ちょうどは畳む・301ms は別の押下
  const a = pressGapsFromRows([{ install_id: "i", mode: "aix", shot_ops: [click(0), click(300)] }], auto).auto;
  const b = pressGapsFromRows([{ install_id: "i", mode: "aix", shot_ops: [click(0), click(301)] }], auto).auto;
  ok("300ms は畳む", a.presses === 1 && a.gaps.length === 0, a);
  ok("301ms は別の押下（間隔301＝短いまま✗のまま）", b.presses === 2 && b.gaps[0] === 301, b);
}
{
  // 本当に短い別の押下（畳んだ後も短い）はそのまま短く出る
  const ops = [click(0), click(700), click(1000 + 700)];
  const r = pressGapsFromRows([{ install_id: "i", mode: "aix", shot_ops: ops }], auto).auto;
  ok("畳み窓より長い短間隔は短いまま", r.gaps[0] === 700 && r.gaps[1] === 1000, r.gaps);
}
{
  // 塊の途中に前の行の続きが来ても t 順で整う（行の順に依らない）
  const rows = [
    { install_id: "i", mode: "aix", shot_ops: [click(2000, "c"), click(2100, "c2")] },
    { install_id: "i", mode: "aix", shot_ops: [click(0, "a"), click(1000, "b")] },
  ];
  const r = pressGapsFromRows(rows, auto).auto;
  ok("行の順に依らず t 順", JSON.stringify(r.gaps) === "[1000,1000]", r.gaps);
}

console.log("\n■ click/tap/key だけ（step/diag/change は外す）");
{
  const ops = [
    { k: "step", t: T0 + 0, f: "流れ台帳", g: 1 },
    { k: "step", t: T0 + 1, f: "全流れ地図台帳", g: 1 },
    { k: "diag", t: T0 + 2, f: "", g: 2 },
    { k: "change", t: T0 + 3, f: "x", g: 3 },
    click(1000, "a"),
    { k: "key", t: T0 + 2500, f: "Enter", g: 1500 },
    { k: "tap", t: T0 + 4000, f: "t", g: 1500 },
  ];
  const r = pressGapsFromRows([{ install_id: "i", mode: "aix", shot_ops: ops }], auto).auto;
  ok("対象は click/key/tap の3本", r.uniqueOps === 3, r.uniqueOps);
  ok("間隔は 1500/1500（step の 1ms は入らない）", JSON.stringify(r.gaps) === "[1500,1500]", r.gaps);
}
{
  // key は畳まない（打鍵の連続は別々の押下）
  const ops = [
    { k: "key", t: T0, f: "1" }, { k: "key", t: T0 + 100, f: "2" }, { k: "key", t: T0 + 200, f: "3" },
  ];
  const r = pressGapsFromRows([{ install_id: "i", mode: "aix", shot_ops: ops }], auto).auto;
  ok("key は畳まない", r.presses === 3 && r.gaps.length === 2, r);
}
{
  const r = pressGapsFromRows([{ install_id: "i", mode: "aix", shot_ops: [{ k: "click", f: "x", g: 100 }, click(500)] }], auto).auto;
  ok("t が無い操作は数えず noT に残す", r.noT === 1 && r.uniqueOps === 1, r);
}

console.log("\n■ 群ごと（自動／通常）・classify");
{
  const rows = [
    { install_id: "i", mode: "aix", shot_ops: [click(0, "a"), click(150, "a2"), click(1500, "b")] },
    { install_id: "i", mode: "normal", shot_ops: [click(100000, "n1"), click(101200, "n2")] },
    { install_id: "i", mode: "other", shot_ops: [click(200000, "z")] },
  ];
  const r = pressGapsFromRows(rows, (row) => {
    const m = String(row.mode);
    return m === "aix" ? "auto" : m === "normal" ? "normal" : null;
  });
  ok("自動と通常は別の群（互いの間の差を間隔にしない）", JSON.stringify(r.auto.gaps) === "[1500]" && JSON.stringify(r.normal.gaps) === "[1200]", r);
  ok("classify が null の行は数えない", !("other" in r) && Object.keys(r).length === 2, Object.keys(r));
}

console.log("\n■ 表示の注記");
{
  const r = pressGapsFromRows([{ install_id: "i", mode: "aix", shot_ops: [click(0), click(100), click(2000)] }], auto).auto;
  const n = pressStatNote("自動", r);
  ok("元→重複除去→1押下 を残す", n === "自動元3→重複除去3→1押下2", n);
  ok("空でも落ちない", pressStatNote("通常", undefined) === "通常元0→重複除去0→1押下0");
  ok("null/undefined 行でも落ちない", Object.keys(pressGapsFromRows(null, auto)).length === 0);
}

console.log(`\n${pass} 件 OK / ${fail} 件 NG`);
if (fail) process.exit(1);
