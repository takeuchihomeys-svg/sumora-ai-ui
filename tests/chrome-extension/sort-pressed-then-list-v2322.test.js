// 2.8.322 高→低を押したあとの読み直しは、並べ替え完了とみて④物件取得へ進む
//   竹内さん 2026-11-27「並べ替えした後物件取得するのちゃんと手順書にはいっているのか／並べ替えしたあとにつまっている／④のところ物件取得／完了を把握できていない」
//   実測 #1668: sort_hilo → sort_lag_grace のあと sort_done も物件取得も無い（読み直しで待ちが消えた）。
const fs = require("fs");
const path = require("path");
const vm = require("vm");

const root = path.join(__dirname, "..", "..");
const dl = fs.readFileSync(path.join(root, "chrome-extension", "bulk-dl.js"), "utf8").replace(/\r\n/g, "\n");
const page = fs.readFileSync(path.join(root, "chrome-extension", "page-script.js"), "utf8").replace(/\r\n/g, "\n");

let passed = 0, failed = 0;
function ok(name, cond, detail) {
  if (cond) { passed++; console.log("  ✓ " + name); }
  else { failed++; console.log("  ✗ " + name + (detail ? " :: " + detail : "")); }
}

function sliceFn(src, name) {
  const start = src.indexOf("function " + name + "(");
  if (start < 0) return "";
  let i = src.indexOf("{", start);
  let d = 0;
  for (; i < src.length; i++) {
    if (src[i] === "{") d++;
    else if (src[i] === "}") { d--; if (d === 0) return src.slice(start, i + 1); }
  }
  return "";
}

console.log("■ 1. 押したあとかどうかの判断（同じページでは始めない／読み直し後は④）");
{
  const src = sliceFn(dl, "_sortPressedMeansList") + "\nthis.__f = _sortPressedMeansList;";
  ok("関数が取り出せる", src.includes("function _sortPressedMeansList"));
  function run(href, o, now) {
    const sb = { location: { href }, Date: { now: () => now } };
    vm.createContext(sb);
    vm.runInContext(src, sb);
    return sb.__f(o);
  }
  const t = 1_000_000;
  const before = "https://realnetpro.com/main.php?method=estate&display=building";
  const after = before + "&ad=odr_desc";
  ok("同じアドレス・ad 順でない → まだ④にしない（押した直後の待ち）", run(before, { at: t, href: before }, t + 1000) === false);
  ok("ad=odr_desc になった → ④へ", run(after, { at: t, href: before }, t + 1000) === true);
  ok("アドレスが変わった → ④へ", run(before + "&page=2", { at: t, href: before }, t + 1000) === true);
  ok("3分より古い印 → ④にしない", run(after, { at: t, href: before }, t + 4 * 60 * 1000) === false);
  ok("印が無い → ④にしない", run(after, null, t) === false);
}

console.log("■ 2. 押す手と、読み直し後の進み方の順番");
{
  const pressAt = dl.indexOf('sessionStorage.setItem("axlx_sort_pressed_sync"');
  const lagAt = dl.indexOf("_auditSort(\"sort_lag_grace\"");
  ok("高→低を押した印は、待ち（lag）より前に書く", pressAt > 0 && lagAt > pressAt, "press=" + pressAt + " lag=" + lagAt);
  const maybe = sliceFn(dl, "_maybeAutoPressOnLoad");
  const resumeAt = maybe.indexOf("_sortPressedMeansList(_readSortPressedSync())");
  const blockAt = maybe.indexOf("blocked_need_search_first");
  ok("読み直し後の④は、「検索前だから押さない」より前", resumeAt > 0 && blockAt > resumeAt, "resume=" + resumeAt + " block=" + blockAt);
  ok("④は物件取得の開始（_startAutoPressRun）", maybe.indexOf("_startAutoPressRun()") > resumeAt);
  ok("行が無い時は印を消さず、次の描き直しでやり直せる（rows0 の return が印を消すより前）", (() => {
    const r0 = maybe.indexOf("sort_pressed_rows0");
    const rm = maybe.indexOf('removeItem("axlx_sort_pressed_sync")');
    return r0 > 0 && rm > r0;
  })());
  const kick = sliceFn(dl, "_kickSortAfterSearch");
  ok("並べ替えの開始は、押したあとなら断る（もう一度並べ替えない）", kick.indexOf("sort_skip_done") > 0 && kick.indexOf("return false") > kick.indexOf("sort_skip_done"));
}

console.log("■ 3. パネルが並べ替えのまま戻らない");
{
  ok("並べ替え完了後に「並べ替え」の次の動きが来たら物件取得に直す", /並べ替え\|並び替え/.test(dl) && dl.includes('nmG = _panelWord("list", "next") || nmG'));
  ok("いまの表示が並べ替えのままでも、完了後は物件取得最中に直す", dl.includes('_caG = _panelWord("list", "now") || _caG'));
  ok("ページ側は、押したあとの sort 要求を list（物件取得）にする", page.includes('ph = "list"; wh = "sort_pressed"'));
  ok("list の次の動きは物件取得", page.includes('nextMove = "物件取得（印刷用PDF）"'));
}

console.log("■ 4. 手順書の④は地図から出ている（この回で手書きの⑤を足していない）");
{
  const map = fs.readFileSync(path.join(root, "app", "lib", "loop-flow-map.ts"), "utf8");
  ok("地図の並べ替えの次は list_press（④）", /id: "sort"[\s\S]{0,900}next: \["list_press", "b_zero"\]/.test(map));
  ok("④の文は地図の playbook から作る", map.includes("export function renderListPressSteps"));
  const pb = fs.readFileSync(path.join(root, "app", "lib", "action-playbook.ts"), "utf8");
  ok("一覧の手は renderListPressSteps() を使う", pb.includes("...renderListPressSteps()"));
}

console.log("\n結果: " + passed + " 合格 / " + failed + " 不合格");
process.exit(failed ? 1 : 0);
