/**
 * 2.8.197: sort_no_head（並べ替えが巨大文言に埋もれる）対策
 * DB#1595: head=N / sort_no_head → PDF へ進んで並べ替えを飛ばしていた
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

assert(semverOk(man.version, "2.8.197"), "manifest >= 2.8.197 got " + man.version);
assert(bulk.includes("createTreeWalker") || bulk.includes("_findSortHeadEl"), "head find still present");
assert(bulk.includes("function _findSortHeadEl"), "_findSortHeadEl");
assert(bulk.includes("並[べび]替え"), "contains regex");
assert(bulk.includes("並び替えに戻る"), "戻る文言");
assert(bulk.includes("sort_retry_before_pdf"), "retry before pdf");
assert(bulk.includes("sort_head_buried"), "buried stamp");
assert(/_findSortHeadEl\(\)/.test(bulk), "used in sortOnce path");
assert(page.includes("並び替えに戻る") || page.includes("並[べび]替え"), "page evidence");
assert(page.includes("sort_head_buried_find"), "RULES_DONE");
assert(rules.includes('id: "sort_head_buried_find"'), "rule");
assert(rules.includes('marker: "_findSortHeadEl"'), "rule marker");

// 純関数相当: 含む一致＋最短（巨大テーブル除外）
function findSortHeadMock(nodes) {
  const re = /並[べび]替え|並び順/;
  const cands = [];
  for (const n of nodes) {
    const nt = String(n.t || "").replace(/[\s\u3000]+/g, "");
    if (!re.test(nt) || nt.length > 120) continue;
    const root = !!n.root;
    cands.push({ id: n.id, len: nt.length, root });
  }
  cands.sort((a, b) => a.len - b.len);
  for (const c of cands) if (!c.root && c.len <= 24) return c.id;
  for (const c of cands) if (!c.root && c.len <= 60) return c.id;
  for (const c of cands) if (!c.root) return c.id;
  return null;
}
assert(
  findSortHeadMock([
    { id: "table", t: "大阪50棟70戸並べ替え更新日…とても長い本文", root: true },
    { id: "nav", t: "ヘルプ", root: false },
    { id: "head", t: "並び替え", root: false },
  ]) === "head",
  "picks short head over table",
);
assert(
  findSortHeadMock([
    { id: "table", t: "大阪50棟70戸並べ替え", root: true },
    { id: "back", t: "並び替えに戻る", root: false },
  ]) === "back",
  "picks 並び替えに戻る",
);
assert(
  findSortHeadMock([
    { id: "only", t: "大阪29棟32戸並べ替え", root: false },
  ]) === "only",
  "mid-length non-root ok",
);
assert(
  findSortHeadMock([{ id: "nav", t: "ヘルプ", root: false }]) === null,
  "no false positive",
);

console.log("sort-head-buried-v28197: OK");
