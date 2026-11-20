// 2.8.152（2026-11-20 竹内さん「直していないものちゃんと改善する また自動か手動かもちゃんと判断するようにする」）
//   ① 印刷用PDF（a.print）など拡張の押しに位置が付かなかった → 見えるカーソルの位置を記録に渡す
//   ② 自動の押しが axlx_human_points（人の位置）に入っていた → 人の押しだけ積む・読む時も自動は使わない
//   ③ 人の位置と自動の位置は by で分ける（モードでは分けない）
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

const rec = read("human-learn-record.js");
const pu = read("pointer-ui.js");

console.log("■ ① 拡張の押しに位置を付ける");
ok("_recNoteOp が座標（ev）を _pushOp に渡す", /function _recNoteOp\(kind, el, ev\) \{ try \{ _pushOp\(kind \|\| "tap", el, "auto", ev \|\| null\)/.test(rec));
ok("pointer-ui の tap がカーソルの位置を synthetic で渡す", /_rec\("click", _tapEl, _pRec \? \{ clientX: _pRec\.x, clientY: _pRec\.y, synthetic: true \} : null\)/.test(pu));
ok("拡張の押しの位置を控え、直後の btn.click()（0,0）に使う", /if \(useXY && ev && ev\.synthetic === true\) \{\s*try \{ _pendingPointXY = \{ x: cxU, y: cyU/.test(rec));

console.log("■ ② 人の位置の鍵に自動を入れない");
const pp = rec.slice(rec.indexOf("function _pushPoint(el, by, ev)"), rec.indexOf("// var _livePoints = null;"));
ok("自動の押しは _liveAutoPoints（ページの中だけ）", /var cur = _isAutoBy \? _liveAutoPoints : \(_livePoints \|\| \(_livePoints = \{\}\)\);/.test(pp));
ok("_savePoints（axlx_human_points）は人の押しだけ", (pp.match(/_savePoints\(cur\)/g) || []).length === 2 && (pp.match(/if \(!_isAutoBy\) _savePoints\(cur\)/g) || []).length === 2);
ok("_liveAutoPoints は start の先頭で宣言", /var _motionReplyAt = 0;\s*var _liveAutoPoints = \{\};/.test(rec));
ok("save() の POINTS_KEY2 へ移す時も自動は飛ばす", /if \(!v \|\| typeof v\.x !== "number" \|\| typeof v\.y !== "number"\) return;\s*if \(v\.by === "auto"\) return;/.test(rec));
const pf = pu.slice(pu.indexOf("function _pointsFor("), pu.indexOf("function _pointsFor(") + 2500);
ok("見えるカーソルは自動の位置を『人の位置』として狙わない（旧の鍵の自動も無視）", /if \(v\.by === "auto"\) return null;/.test(pf));

console.log("■ ③ by を付けて送る");
const a = rec.indexOf("function _markPointsBy(points, by)");
const b = rec.indexOf("/** 写真の行に載せる自動の押した位置", a);
const sb = {};
vm.createContext(sb);
vm.runInContext(rec.slice(a, b), sb);
const pts = { fields: { a: { n: 1, x: 0.1, y: 0.2 }, b: { n: 2, x: 0.3, y: 0.4, by: "auto" } } };
sb._markPointsBy(pts, "human");
ok("by が無い欄に付ける", pts.fields.a.by === "human");
ok("既に付いている by は変えない", pts.fields.b.by === "auto");
ok("空でも落ちない", (() => { try { sb._markPointsBy(null, "auto"); sb._markPointsBy({}, "auto"); return true; } catch (_) { return false; } })());
ok("人の記録（rec.detail）の位置は by:human", /var motion = L\.summarizeMotion\(det\);\s*_markPointsBy\(motion\.points, "human"\);/.test(rec));
ok("自動モードの集計（flushAuto）の位置は by:auto", /var motion = L\.summarizeMotion\(det\);\s*_markPointsBy\(motion\.points, "auto"\);/.test(rec));
ok("写真の行の返事でも人の位置に by:human", /if \(m\) _markPointsBy\(m\.points, "human"\);/.test(rec));
ok("save() の point_fields は人が先・by で区別", /by: human \? "human" : "auto"/.test(rec));

console.log("■ ④ PC の中の集計で人と自動を平均しない");
const L = require(path.join(EXT, "human-learn.js"));
const h = { points: { n: 3, fields: { f1: { n: 3, x: 0.2, y: 0.2, by: "human" } } } };
const au = { points: { n: 5, fields: { f1: { n: 5, x: 0.8, y: 0.8, by: "auto" }, f2: { n: 1, x: 0.5, y: 0.5, by: "auto" } } } };
const m1 = L.mergeMotion(h, au);
ok("人の位置に自動が来ても人のまま", m1.points.fields.f1.x === 0.2 && m1.points.fields.f1.by === "human", m1.points.fields.f1);
ok("人が押していない欄は自動の位置（by:auto）", m1.points.fields.f2 && m1.points.fields.f2.by === "auto");
const m2 = L.mergeMotion(au, h);
ok("自動の位置に人が来たら人に置き換える", m2.points.fields.f1.x === 0.2 && m2.points.fields.f1.by === "human", m2.points.fields.f1);
const m3 = L.mergeMotion(h, { points: { n: 1, fields: { f1: { n: 1, x: 0.4, y: 0.4, by: "human" } } } });
ok("人どうしは今まで通り合わせる（by を残す）", m3.points.fields.f1.n === 4 && m3.points.fields.f1.by === "human" && m3.points.fields.f1.x > 0.2 && m3.points.fields.f1.x < 0.4, m3.points.fields.f1);
const m4 = L.mergeMotion({ points: { fields: { f1: { n: 1, x: 0.2, y: 0.2 } } } }, { points: { fields: { f1: { n: 1, x: 0.6, y: 0.6 } } } });
ok("by の無い旧記録どうしは今まで通り", m4.points.fields.f1.n === 2 && m4.points.fields.f1.x === 0.4, m4.points.fields.f1);

console.log("■ ⑤ サーバー: 自動か手動かの見分けを1か所に");
const root = path.join(__dirname, "../..");
const rd = (f) => fs.readFileSync(path.join(root, f), "utf8");
const pb = rd("app/lib/press-by.ts");
ok("isAutoMode は aix / ai / auto / brain_*", /m === "aix" \|\| m === "ai" \|\| m === "auto" \|\| m\.startsWith\("brain_"\)/.test(pb));
ok("pointBy は by:auto と syn:true を自動", /o\.by === "auto" \|\| o\.syn === true/.test(pb));
const brain = rd("app/lib/human-learn-brain.ts");
ok("束: 自動モードの点検は拡張の押しだけ数える（2か所）", (brain.match(/auditHumanLike\(autoRows as never, \{ pressBy: "auto" \}\)/g) || []).length === 2);
ok("束: 人と自動の位置の比べはモードでなく by", /compareFields\(posOf\(allRows, "human"\), posOf\(allRows, "auto"\), \[\]\)/.test(brain));
ok("束: learnPoints も pointBy", /const isAuto = pointBy\(r\) === "auto";/.test(brain));
ok("束: aix|auto だけの数え方が残っていない", !/m === "aix" \|\| m === "auto"|m !== "aix" && m !== "auto"|mode === "aix" \|\| mode === "auto"/.test(brain));
for (const f of ["app/lib/learn-foundation-audit.ts", "app/lib/human-nearness.ts", "app/lib/shot-learn.ts", "app/lib/latest-learn-loop.ts", "scripts/human-nearness.ts"]) {
  const s = rd(f);
  ok(f + " は isAutoMode を使う", /isAutoMode\(/.test(s) && !/m === "aix" \|\| m === "auto"/.test(s));
}
const audit = rd("app/lib/human-like-audit.ts");
ok("auditHumanLike に pressBy（自動だけ数える）", /opt: \{ pressBy\?: PressBy \} = \{\}/.test(audit) && /rowHasPointBy\(r\.point_fields, opt\.pressBy\)/.test(audit));

console.log("■ 版");
const man = JSON.parse(read("manifest.json"));
const ps = read("page-script.js");
const verGe = (v) => { const [x, y, z] = String(v).split(".").map(Number); return x > 2 || (x === 2 && (y > 8 || (y === 8 && z >= 152))); };
ok("manifest 2.8.152 以上", verGe(man.version), man.version);
ok("_AXLX_PAGE_VER 2.8.152 以上", verGe((ps.match(/_AXLX_PAGE_VER = "([\d.]+)"/) || [])[1]));
for (const f of ["human-learn-record.js", "human-learn.js", "pointer-ui.js"]) {
  let okc = true;
  try { new vm.Script(read(f), { filename: f }); } catch (e) { okc = false; console.log("    " + f + ": " + e.message); }
  ok(f + " の構文が通る", okc);
}

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
