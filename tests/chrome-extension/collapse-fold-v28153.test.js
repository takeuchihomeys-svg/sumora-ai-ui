// 2.8.153（2026-11-22 竹内さん「ここおしたらちゃんと折りたたまれるように 構造考えておりたたまれるようにする」）
//   ∨ → 親が wrap を隠してミニボタン／子は mini-mode で中身を消さない／1回目の無視をやめる
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

const pp = read("popup.js");
const ub = read("underbar.js");
const html = read("popup.html");
const seg = (() => {
  const i = pp.indexOf('getElementById("collapse-btn")');
  return i >= 0 ? pp.slice(i, i + 800) : "";
})();

console.log("■ 構造");
ok("underbar: ∨ → notifyParent(collapse)", /isUnderbar[\s\S]{0,80}notifyParent\("collapse"\)/.test(seg));
ok("子は setMiniMode(true) しない", !/setMiniMode\(true\)/.test(seg));
ok("折りたたみ前に mini-mode を外す", /setMiniMode\(false\);\s*notifyParent\("collapse"\)/.test(seg));
ok("サイドパネル: showView(view-list)", /else \{\s*showView\("view-list"\);/.test(seg));
ok("親: collapse → setSize(false)", /if \(a === "collapse"\) \{[\s\S]{0,80}setSize\(false\)/.test(ub));
ok("親: 縮むとミニボタンを出す", /miniBtnEl\.style\.display = "flex"/.test(ub));
ok("親: 開くとミニボタンを隠す", /miniBtnEl\.style\.display = "none"/.test(ub));
ok("1回目無視（ignoreNextCollapse=true）が無い", !/ignoreNextCollapse\s*=\s*true/.test(ub));
ok("開く時 repaint（白い箱の保険）", /send\("repaint"\)/.test(ub) && /action === "repaint"/.test(pp));

console.log("■ 説明・版");
ok("title が折りたたむ", /折りたたむ/.test(html));
const man = JSON.parse(read("manifest.json"));
const verGe = (v) => { const [x, y, z] = String(v).split(".").map(Number); return x > 2 || (x === 2 && (y > 8 || (y === 8 && z >= 153))); };
ok("manifest ≥2.8.153", verGe(man.version), man.version);
ok("_AXLX_PAGE_VER ≥2.8.153", verGe((read("page-script.js").match(/_AXLX_PAGE_VER = "([\d.]+)"/) || [])[1]));
for (const f of ["popup.js", "underbar.js"]) {
  let okc = true;
  try { new vm.Script(read(f), { filename: f }); } catch (e) { okc = false; console.log("   ", f, e.message); }
  ok(f + " の構文", okc);
}

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
