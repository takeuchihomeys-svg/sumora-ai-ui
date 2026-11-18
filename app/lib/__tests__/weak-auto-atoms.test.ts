/**
 * 弱点原子の細分化
 * 実行: npx tsx app/lib/__tests__/weak-auto-atoms.test.ts
 */
import { atomsFromEvidence, atomsLine } from "../weak-auto-atoms";
import { LEARN_MECHANISMS } from "../learn-supervisor";

let pass = 0;
let fail = 0;
function ok(name: string, cond: boolean, detail?: unknown) {
  if (cond) { pass++; console.log("  ✓", name); }
  else { fail++; console.log("  ✗", name, detail ?? ""); }
}

console.log("■ 弱点原子");
{
  const atoms = atomsFromEvidence([
    { label: "自動モードの人間らしさ", value: "操作 100件／カーソル 62%・押した位置 28%／⚠ 手の形 0回" },
    { label: "欄×観点", value: "平均26%／弱い: route_id[] 0%・区を選ぶ17%・city_code[] 17%" },
    { label: "学習→自動の連携", value: "止: 5.自動で使う（新束のあとの自動走行がまだ無い）" },
    { label: "通常録画→完全再現の土台", value: "画像にあるが押していない 1113欄" },
    { label: "押した操作の中身", value: "区別できない unknown 43149" },
  ]);
  ok("カーソル原子", atoms.some((a) => a.id === "cursor_pct" && a.score === 62));
  ok("押した位置原子", atoms.some((a) => a.id === "point_pct" && a.score === 28));
  ok("手の形原子", atoms.some((a) => a.id === "hand_cs"));
  ok("route_id 原子", atoms.some((a) => a.id === "field:route_id"));
  ok("city 原子", atoms.some((a) => a.id === "field:city_code"));
  ok("一連原子", atoms.some((a) => a.id === "link_auto"));
  ok("画像未押し原子", atoms.some((a) => a.id === "image_unpressed"));
  ok("外し区別の変バグ", atoms.some((a) => a.id === "bug_toggle_unknown"));
  ok("line が空でない", atomsLine(atoms).length > 20);
}

console.log("\n■ 仕組み⑯⑰⑱⑲");
ok("仕組み⑯がある", LEARN_MECHANISMS.some((s) => /弱点は原子/.test(s)));
ok("仕組み⑰がある", LEARN_MECHANISMS.some((s) => /なぜ弱い|100%への道/.test(s)));
ok("仕組み⑱がある", LEARN_MECHANISMS.some((s) => /学んだ欄も弱い間は再強化/.test(s)));
ok("仕組み⑲がある", LEARN_MECHANISMS.some((s) => /現場の誤りは型で根元改善/.test(s)));
ok("仕組み⑳がある", LEARN_MECHANISMS.some((s) => /弱い部分は画像から徹底学習|強化ループを回す/.test(s)));
ok("仕組み㉑がある", LEARN_MECHANISMS.some((s) => /リアプロのボタンは1つずつ/.test(s)));

console.log("\n■ 根元の誤り型");
{
  const atoms = atomsFromEvidence([
    { label: "足りない土台", value: "沿線2本・駅は1沿線分・ペットは絞り込み条件・築年見切れ・プルダウン上下・カーソル67%" },
  ]);
  ok("early_multi", atoms.some((a) => a.id === "bug_early_multi"));
  ok("collapsed_direct", atoms.some((a) => a.id === "bug_collapsed_direct"));
  ok("select_offscreen", atoms.some((a) => a.id === "bug_select_offscreen"));
  ok("dropdown_flip", atoms.some((a) => a.id === "bug_dropdown_flip"));
  ok("cursor_no_aim", atoms.some((a) => a.id === "bug_cursor_no_aim"));
}

console.log(`\n結果: 合格 ${pass} / 不合格 ${fail}`);
if (fail) process.exitCode = 1;
