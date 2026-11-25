/**
 * 2.8.218: sort_no_head で PDF へ飛ぶ根＝見出し aim が falseHead で全落ち
 * 束の学習キーは「大阪N棟N戸並べ替え｜div.under／main_table」だけ。
 * → 短い見出しが無い時は under を①見出し aim に使う（③高→低の別名にはしない）
 */
const fs = require("fs");
const path = require("path");
const root = path.join(__dirname, "..", "..", "chrome-extension");
const bulk = fs.readFileSync(path.join(root, "bulk-dl.js"), "utf8");
const page = fs.readFileSync(path.join(root, "page-script.js"), "utf8");
const man = JSON.parse(fs.readFileSync(path.join(root, "manifest.json"), "utf8"));
const rules = fs.readFileSync(
  path.join(__dirname, "..", "..", "app", "lib", "auto-procedure-rules.ts"),
  "utf8"
);

function assert(cond, msg) {
  if (!cond) throw new Error(msg);
}
function semverOk(v, min) {
  const a = String(v).split(".").map(Number);
  const b = String(min).split(".").map(Number);
  for (let i = 0; i < 3; i++) {
    if ((a[i] || 0) > (b[i] || 0)) return true;
    if ((a[i] || 0) < (b[i] || 0)) return false;
  }
  return true;
}

assert(semverOk(man.version, "2.8.218"), "manifest >= 2.8.218 got " + man.version);
assert(page.includes('2.8.218'), "page ver 2.8.218");
assert(bulk.includes("function _pickSortHeadAimFromPoints"), "_pickSortHeadAimFromPoints");
assert(bulk.includes("toori_under"), "toori_under src");
assert(bulk.includes("sort_head_aim_scroll"), "aim scroll stamp");
assert(bulk.includes("sort_head_aim_miss"), "aim miss stamp");
assert(bulk.includes("createTreeWalker"), "TreeWalker leaf");
assert(!/var falseHead = \/棟/.test(bulk), "old falseHead must be gone");
assert(rules.includes('id: "sort_head_aim_toori_fallback"'), "rule");
assert(page.includes("sort_head_aim_toori_fallback"), "RULES_DONE");

/** 純関数相当（bulk と同じ優先） */
function pickSortHeadAimFromPoints(pts) {
  let bestShort = null, bestShortN = -1;
  let bestUnder = null, bestUnderN = -1;
  let bestTable = null, bestTableN = -1;
  Object.keys(pts).forEach((k) => {
    const v = pts[k];
    if (!v || typeof v.x !== "number" || typeof v.y !== "number") return;
    if (/高.?低|sort_detail/i.test(k)) return;
    if (!/並[べび]替え|並び順|sort_head/i.test(k)) return;
    let nn = typeof v.n === "number" ? v.n : 0;
    const isToori = /棟.*戸/.test(k) || /div\.main_table|div\.under/.test(k);
    if (!isToori) {
      if (/並べ替え｜span|^並べ替え$|^並び替え$|sort_head/i.test(k)) nn += 100;
      if (nn > bestShortN) {
        bestShortN = nn;
        bestShort = { x: v.x, y: v.y, k, n: nn, src: "short" };
      }
      return;
    }
    if (/div\.under|\.under/.test(k)) {
      if (nn > bestUnderN) {
        bestUnderN = nn;
        bestUnder = { x: v.x, y: v.y, k, n: nn, src: "toori_under" };
      }
      return;
    }
    if (/div\.main_table|main_table/.test(k)) {
      let score = nn;
      if (v.x < 0.05) score -= 2;
      if (score > bestTableN) {
        bestTableN = score;
        bestTable = { x: v.x, y: v.y, k, n: nn, src: "toori_table" };
      }
    }
  });
  return bestShort || bestUnder || bestTable;
}

/** DB束相当: 見出しは棟戸だけ・高→低は別 */
const bundlePts = {
  "左の大阪36棟46戸並べ替え｜div.main_table": { x: 0.02, y: 0.64, n: 4 },
  "左の大阪29棟32戸並べ替え｜div.under": { x: 0.31, y: 0.3, n: 2 },
  "左の高→低｜span.sort_detail": { x: 0.15, y: 0.47, n: 5 },
  "高→低": { x: 0.15, y: 0.47, n: 1 },
};

const picked = pickSortHeadAimFromPoints(bundlePts);
assert(!!picked, "picks something");
assert(picked.src === "toori_under", "prefer under over main_table got " + picked.src);
assert(picked.x === 0.31 && picked.y === 0.3, "under coords");
assert(!/高.?低|sort_detail/.test(picked.k), "not hilo alias");

/** 短い見出しがあればそちら */
const withShort = pickSortHeadAimFromPoints({
  ...bundlePts,
  "並べ替え｜span": { x: 0.2, y: 0.25, n: 1 },
});
assert(withShort.src === "short", "short wins");
assert(withShort.k === "並べ替え｜span", "short key");

/** under も short も無い → table（左端は減点） */
const onlyTable = pickSortHeadAimFromPoints({
  "左の大阪0棟0戸並べ替え更新｜div.main_table": { x: 0.38, y: 0.54, n: 2 },
  "左の大阪36棟46戸並べ替え｜div.main_table": { x: 0.02, y: 0.64, n: 4 },
});
assert(onlyTable.src === "toori_table", "table fallback");
assert(onlyTable.x === 0.38, "prefer non-left-edge table");

/** 旧 falseHead なら全部 null になることを回帰で固定 */
function oldFalseHeadPick(pts) {
  const falseHead = /棟\d*戸.*並[べび]替え|並[べび]替え更新｜|並[べび]替え｜div\.(main_table|under)/;
  let bestHead = null, bestHeadN = -1;
  Object.keys(pts).forEach((k) => {
    const v = pts[k];
    if (!v || typeof v.x !== "number") return;
    if (/高.?低|sort_detail/i.test(k)) return;
    if (!/並[べび]替え|並び順/.test(k)) return;
    if (falseHead.test(k)) return;
    const nn = typeof v.n === "number" ? v.n : 0;
    if (nn > bestHeadN) {
      bestHeadN = nn;
      bestHead = { k };
    }
  });
  return bestHead;
}
assert(oldFalseHeadPick(bundlePts) === null, "旧falseHeadなら束の見出しは全部落ちる＝とぶ根");

console.log("sort-head-aim-toori-v28218: OK");
