// 2.8.174（2026-11-22 竹内さん「中の部分見れなくなるときあるから右上にカーソル合わせて拡張ツール延ばせるようする」）
//   右上コーナー #axlx-resize-ne で幅・高さを延ばす（下端固定）
const fs = require("fs");
const path = require("path");
const vm = require("vm");
const EXT = path.join(__dirname, "../../chrome-extension");
const read = (f) => fs.readFileSync(path.join(EXT, f), "utf8");

let pass = 0, fail = 0;
function ok(name, cond, detail) {
  if (cond) { pass++; console.log("✓", name); }
  else { fail++; console.log("✗", name, detail !== undefined ? JSON.stringify(detail) : ""); }
}

const ub = read("underbar.js");
const man = JSON.parse(read("manifest.json"));
const pageVer = (read("page-script.js").match(/_AXLX_PAGE_VER = "([\d.]+)"/) || [])[1];
const verGe = (v) => {
  const [x, y, z] = String(v).split(".").map(Number);
  return x > 2 || (x === 2 && (y > 8 || (y === 8 && z >= 174)));
};

console.log("■ 右上リサイズ");
ok("id=axlx-resize-ne", /id = "axlx-resize-ne"|resizeNeHandle\.id = "axlx-resize-ne"/.test(ub));
ok("cursor ne-resize", /cursor:\s*"ne-resize"/.test(ub));
ok("dragAction resize-ne", /onDragStart\(e, "resize-ne"\)/.test(ub));
ok("展開時に右上ハンドル表示", /resizeNeHandle\.style\.display = "block"/.test(ub));
ok("下端固定（bottomEdge）", /bottomEdge = startWY \+ startPH \+ DRAG_H/.test(ub));
ok("上へ延ばす（startPH - dy）", /startPH - dy/.test(ub));
ok("竹内さんの言葉コメント", /右上にカーソル合わせて拡張ツール延ばせる/.test(ub));
ok("右下も残っている", /cursor:\s*"se-resize"/.test(ub) && /onDragStart\(e, "resize"\)/.test(ub));

console.log("■ 版・構文");
ok("manifest ≥2.8.174", verGe(man.version), man.version);
ok("_AXLX_PAGE_VER ≥2.8.174", verGe(pageVer), pageVer);
try {
  new vm.Script(ub, { filename: "underbar.js" });
  ok("underbar.js の構文", true);
} catch (e) {
  ok("underbar.js の構文", false, e.message);
}

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
