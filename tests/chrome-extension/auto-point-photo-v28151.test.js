// 2.8.151（2026-11-20 竹内さん「押した位置は画像から学習したら改善される」）
//   DB 実測: 自動の写真 99行のうち押した位置（point_fields）が付いたのは 0行（2.8.145）。
//   写真の行の位置は人の押し（isTrusted）だけだったので、自動の押し（_opsRing の x/y）を by:"auto" で載せる
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

const src = read("human-learn-record.js");
const a = src.indexOf("function _autoPressPointsSince(ring, sinceT)");
const b = src.indexOf("function _pushOp(kind, el, by, ev)", a);
const sb = { _PRESS_KIND: { click: 1, tap: 1 } };
vm.createContext(sb);
vm.runInContext(src.slice(a, b), sb);
const f = sb._autoPressPointsSince;

console.log("■ 自動の押しから位置を作る");
const ring = [
  { t: 100, k: "click", by: "auto", f: "左の所在地絞り込み＋｜span", x: 0.3, y: 0.6, w: "button", bw: 120, bh: 30 },
  { t: 200, k: "click", by: "human", f: "rental_cost2", x: 0.1, y: 0.2 },
  { t: 300, k: "change", by: "auto", f: "rental_cost2", x: 0.5, y: 0.5 },
  { t: 400, k: "click", by: "auto", f: "印刷用PDF｜a.print" },
  { t: 500, k: "tap", by: "auto", f: "堺市北区｜label.one_city", x: 0.2, y: 0.4 },
  { t: 600, k: "click", by: "auto", f: "左の所在地絞り込み＋｜span", x: 0.35, y: 0.55 },
];
const all = f(ring, 0);
ok("x/y のある自動の click/tap だけ（人・change・x/y無しは入れない）", all && all.n === 3, all && all.n);
ok("欄ごとにまとめる", all && Object.keys(all.fields).length === 2, all && Object.keys(all.fields));
ok("by:auto を付ける（人の位置と区別）", all && all.fields["左の所在地絞り込み＋｜span"].by === "auto");
ok("同じ欄は回数を数え・最後の位置", all && all.fields["左の所在地絞り込み＋｜span"].n === 2 && all.fields["左の所在地絞り込み＋｜span"].x === 0.35);
ok("幅・高さ・種類も残す", all && all.fields["左の所在地絞り込み＋｜span"].bw === 120 && all.fields["左の所在地絞り込み＋｜span"].w === "button");
ok("押した順", all && all.order.join(">") === "左の所在地絞り込み＋｜span>堺市北区｜label.one_city");
const after = f(ring, 500);
ok("前の写真より後の押しだけ", after && after.n === 1 && after.fields["左の所在地絞り込み＋｜span"].x === 0.35, after);
ok("無ければ null（空の位置を送らない）", f(ring, 600) === null && f([], 0) === null);
ok("枠の外の値は捨てる", f([{ t: 1, k: "click", by: "auto", f: "a", x: 1.4, y: 0.2 }], 0) === null);

console.log("■ 組み込み");
const h = src.slice(src.indexOf('msg.type !== "axlx-recent-motion"'), src.indexOf('msg.type !== "axlx-recent-motion"') + 1600);
ok("人の位置が無い写真だけ自動の位置を載せる", /if \(m && !_hasHumanPt\) \{[\s\S]{0,120}_autoPressPointsSince\(_opsRing, _motionReplyAt\)/.test(h));
ok("返したら時刻を進める（同じ押しを2枚に載せない）", /_motionReplyAt = Date\.now\(\);\s*sendResponse/.test(h));
ok("_motionReplyAt は start の先頭で宣言", /var _opsAsk = 0;\s*var _motionReplyAt = 0;/.test(src));

console.log("■ 束（人の位置が先）");
const brain = fs.readFileSync(path.join(__dirname, "../../app/lib/human-learn-brain.ts"), "utf8");
const lp = brain.slice(brain.indexOf("export function learnPoints("), brain.indexOf("shot_ops の x/y で point_fields が薄い欄を補う"));
ok("自動の位置は人の位置を上書きしない", /if \(old && isAuto && !oldAuto\) continue;/.test(lp));
ok("人の位置は自動の位置を置き換える", /\(oldAuto && !isAuto\)/.test(lp));

console.log("■ 版");
const man = JSON.parse(read("manifest.json"));
const ps = read("page-script.js");
const verGe = (v) => { const [x, y, z] = String(v).split(".").map(Number); return x > 2 || (x === 2 && (y > 8 || (y === 8 && z >= 151))); };
ok("manifest 2.8.151 以上", verGe(man.version), man.version);
ok("_AXLX_PAGE_VER 2.8.151 以上", verGe((ps.match(/_AXLX_PAGE_VER = "([\d.]+)"/) || [])[1]));

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
