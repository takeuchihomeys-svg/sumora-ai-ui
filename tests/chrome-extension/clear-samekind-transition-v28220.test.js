// 実行: node tests/chrome-extension/clear-samekind-transition-v28220.test.js
// v2.8.220 竹内さん「外すのもちゃんとできていない／次の動きへの移行が弱い」:
//   同種でも先に外す・展開後再読み・clear_then_fill→next_move の配線
const fs = require("fs");
const path = require("path");
const vm = require("vm");
const root = path.join(__dirname, "../../chrome-extension");
const ps = fs.readFileSync(path.join(root, "page-script.js"), "utf8");
const mf = JSON.parse(fs.readFileSync(path.join(root, "manifest.json"), "utf8"));

let pass = 0, fail = 0;
function ok(name, c, detail) {
  if (c) { pass++; console.log("  ✓ " + name); }
  else { fail++; console.log("  ✗ " + name + (detail !== undefined ? "  " + JSON.stringify(detail) : "")); }
}

function extractFn(name) {
  const head = "  function " + name + "(";
  const s = ps.indexOf(head);
  if (s < 0) return null;
  let i = ps.indexOf("{", s) + 1, depth = 1, inStr = null, inLine = false, inBlock = false;
  for (; i < ps.length && depth > 0; i++) {
    const c = ps[i], n = ps[i + 1];
    if (inLine) { if (c === "\n") inLine = false; continue; }
    if (inBlock) { if (c === "*" && n === "/") { inBlock = false; i++; } continue; }
    if (inStr) { if (c === "\\") { i++; continue; } if (c === inStr) inStr = null; continue; }
    if (c === "/" && n === "/") { inLine = true; continue; }
    if (c === "/" && n === "*") { inBlock = true; continue; }
    if (c === '"' || c === "'" || c === "`") { inStr = c; continue; }
    if (c === "{") depth++;
    if (c === "}") depth--;
  }
  return ps.slice(s, i);
}

console.log("\n■ 版");
ok("manifest≥2.8.220", /^2\.8\.(22\d|2[3-9]\d|[3-9]\d{2})$/.test(mf.version) || mf.version >= "2.8.220", mf.version);
ok("page-script≥2.8.220", /_AXLX_PAGE_VER = "2\.8\.22\d"/.test(ps));

console.log("\n■ _planLeftover 同種でも外す");
const sandbox0 = {};
vm.createContext(sandbox0);
vm.runInContext(["_axWantPlaceMode", "_planLeftover"].map(extractFn).join("\n"), sandbox0);
const plan = sandbox0._planLeftover;
const empty = { stations: 0, lines: 0, wards: 0, towns: 0, layouts: 0, structured: 0, pet: 0, shikirei: false, selects: [], texts: [] };
let p = plan(Object.assign({}, empty, { stations: 4, lines: 2 }), "station");
ok("駅→駅: clearStations+sameKindMustClear+dirty", p.clearStations && p.sameKindMustClear && p.dirty, p);
ok("要約に『同種でも先に外す』", /同種でも先に外す/.test(p.summary), p.summary);
p = plan(Object.assign({}, empty, { wards: 5 }), "area");
ok("地域→地域: clearWards+sameKindMustClear", p.clearWards && p.sameKindMustClear && p.dirty, p);
p = plan(empty, "station", { n: { stations: 8, lines: 3 }, names: ["駅:梅田"] });
ok("台帳のみ同種駅: memOnlyStations で外す", p.clearStations && p.memOnlyStations && p.dirty, p);

console.log("\n■ 配線（ソース）");
ok("フォーム展開後に leftover_rescan_after_form", /leftover_rescan_after_form/.test(ps));
ok("同種 force 旗 ForceClearSameKind", /__axlxForceClearSameKindStations/.test(ps) && /__axlxForceClearSameKindWards/.test(ps));
ok("clear_then_fill 後に next_move_grasp", /clear_then_fill[\s\S]{0,400}next_move_grasp/.test(ps) || /_graspNextCustomerAndMove\("clear_then_fill"\)/.test(ps));
ok("一連に clear_then_fill 段", /id: "clear_then_fill"/.test(ps));
ok("leftover_force_same_stations / wards", /leftover_force_same_stations/.test(ps) && /leftover_force_same_wards/.test(ps));

console.log("\n" + pass + " passed, " + fail + " failed");
process.exit(fail ? 1 : 0);
