// 材料を字数で切った時のログ（app/lib/material-cut-log.ts）のテスト
// 実行: npx tsx app/lib/__tests__/material-cut-log.test.ts
import { clipMaterial, clipMaterialLogged, materialCutLogOn } from "../material-cut-log";
let pass = 0, fail = 0;
const ok = (n: string, c: boolean, d = "") => { if (c) pass++; else { fail++; console.log(`✗ ${n} ${d}`); } };
ok("既定 off", materialCutLogOn({}) === false && materialCutLogOn({ MATERIAL_CUT_LOG: "on" }) === true);
ok("短い時は切らない・記録なし", clipMaterial("あいう", 5, "x").record === null && clipMaterial("あいう", 5, "x").text === "あいう");
const r = clipMaterial("a".repeat(1600), 1500, "brain:ai_summary", "conv1");
ok("切り方は今の slice(0, max) と同じ", r.text === "a".repeat(1600).slice(0, 1500));
ok("記録に切った字数", JSON.stringify(r.record) === JSON.stringify({ tag: "material:cut", label: "brain:ai_summary", kept: 1500, cut: 100, ctx: "conv1" }));
const logs: string[] = []; const orig = console.log; console.log = (s: string) => { logs.push(s); };
clipMaterialLogged("b".repeat(10), 5, "t", null, {}); clipMaterialLogged("b".repeat(10), 5, "t", null, { MATERIAL_CUT_LOG: "on" }); clipMaterialLogged(null, 5, "t", null, { MATERIAL_CUT_LOG: "on" });
console.log = orig;
ok("on の時だけ・切った時だけログ", logs.length === 1 && /"cut":5/.test(logs[0]), JSON.stringify(logs));
console.log(`material-cut-log: ${pass} passed, ${fail} failed`); if (fail) process.exit(1);
