/**
 * 2.8.329 2人目が次のページへ行かずリセットした（#1677）／3人目の沿線（区間）で駅を選べず迷った（#1678）。
 *   node tests/chrome-extension/next-page-line-range-v28329.test.js
 *
 *   ① 頁の番号: 「前頁 1 2 次 最後」の2頁を「1ページのみ」と読んだ（td.pager の数字だけ数えていた・30日で次へを押せた印0件）。
 *      → 実際の関数を偽の画面で動かし、いまの頁の番号が td.pager でない形・pager(N) が0始まりの形でも2頁と読むかを見る。
 *   ② 沿線（区間）: 「御堂筋沿線（中津〜本町）」は御堂筋線だけ・駅は中津・梅田・淀屋橋・本町（端も含む）。
 *      → 裏の解決（resolution-core）と一括の入力（popup.js の関数）を実物の文で動かす。
 *   ③ 迷い: 駅の画面では駅の札だけを見る（「御堂筋線」の字を押しに行かない）・カーソルは飛んでいる途中で打ち切らない。
 */
const fs = require("fs");
const path = require("path");
const vm = require("vm");
const ext = path.join(__dirname, "..", "..", "chrome-extension");
const read = (f) => fs.readFileSync(path.join(ext, f), "utf8");
const bulk = read("bulk-dl.js");
const page = read("page-script.js");
const popup = read("popup.js");
const ptr = read("pointer-ui.js");

let pass = 0, fail = 0;
function ok(name, c, extra) { if (c) { pass++; console.log("  ✓ " + name); } else { fail++; console.log("NG: " + name + (extra === undefined ? "" : " " + JSON.stringify(extra).slice(0, 300))); } }

/** function 名(…) { … } を中括弧の対応で切り出す */
function fnSrc(src, name) {
  const m = new RegExp("function " + name.replace(/\$/g, "\\$") + "\\s*\\(").exec(src);
  if (!m) return "";
  const i = src.indexOf("{", m.index);
  let depth = 0;
  for (let j = i; j < src.length; j++) {
    if (src[j] === "{") depth++;
    else if (src[j] === "}") { depth--; if (depth === 0) return src.slice(m.index, j + 1); }
  }
  return "";
}

// ── 偽の画面（頁の番号の行だけ）──
function El(tag, opts, kids) {
  const e = {
    tagName: tag.toUpperCase(),
    className: (opts && opts.cls) || "",
    _text: (opts && opts.text) || "",
    _attrs: Object.assign({}, (opts && opts.attrs) || {}),
    children: kids || [],
    parentElement: null,
    disabled: false,
    get textContent() { return this._text + this.children.map((c) => c.textContent).join(""); },
    getAttribute(k) { return Object.prototype.hasOwnProperty.call(this._attrs, k) ? this._attrs[k] : null; },
    getBoundingClientRect() { return { width: 20, height: 14, left: 0, top: 0, right: 20, bottom: 14 }; },
    classList: { contains: (c) => (" " + e.className + " ").indexOf(" " + c + " ") >= 0 },
    closest(sel) { let x = this; while (x) { if (x.tagName === sel.toUpperCase()) return x; x = x.parentElement; } return null; },
    querySelectorAll(sel) {
      const parts = sel.split(",").map((s) => s.trim());
      const out = [];
      const walk = (n) => {
        for (const c of n.children) {
          if (parts.some((p) => {
            const [t, cl] = p.split(".");
            return c.tagName === t.toUpperCase() && (!cl || c.classList.contains(cl));
          })) out.push(c);
          walk(c);
        }
      };
      walk(this);
      return out;
    },
  };
  for (const k of e.children) k.parentElement = e;
  return e;
}
function pagerDoc(cells) {
  const tr = El("tr", {}, cells);
  const table = El("table", {}, [tr]);
  const body = El("body", {}, [table]);
  return { querySelectorAll: (s) => body.querySelectorAll(s) };
}
function runPager(doc) {
  const ctx = { document: doc, console };
  vm.createContext(ctx);
  const src = ["_isDisabledEl", "_isElVisible", "_pagerCellClickable", "_pagerCellLooksCurrent", "_readPagerState"].map((n) => fnSrc(bulk, n)).join("\n");
  vm.runInContext(src + "\nthis.__r = _readPagerState();", ctx);
  return ctx.__r;
}
const td = (text, oc, cls) => El("td", { text, cls: cls === undefined ? "pager" : cls, attrs: oc ? { onclick: oc } : {} });

console.log("■ ① 頁の番号を行全体で読む");
{
  // #1677 の形の推定: いまの頁「1」は td.pager でない
  const r1 = runPager(pagerDoc([td("前頁", ""), td("1", "", "pager_now"), td("2", "pager(2)"), td("次", "pager(2)"), td("最後", "pager(2)")]));
  ok("いまの頁が td.pager でなくても 2頁と読む（旧は [2] で1ページのみ）", r1.nums.join(",") === "1,2" && !r1.onlyOnePage, r1);
  ok("いまの頁=1（押す口の無い番号）・次がある", r1.current === 1 && r1.currentKnown && r1.hasNextUsable, r1);
  // pager(N) が0始まり（1頁目の次が pager(1)）
  const r2 = runPager(pagerDoc([td("前頁", ""), td("1", ""), td("2", "pager(1)"), td("次", "pager(1)"), td("最後", "pager(1)")]));
  ok("pager(N) が0始まりでも次がある（旧は 1>1 で押せない次と読んだ）", r2.hasNextUsable && !r2.onlyOnePage, r2);
  // 最後の頁
  const r3 = runPager(pagerDoc([td("前頁", "pager(1)"), td("1", "pager(1)"), td("2", ""), td("次", "pager(2)")]));
  ok("最後の頁（いま=2・番号の最大=2）は次が無い", r3.current === 2 && !r3.hasNextUsable && !r3.onlyOnePage, r3);
  // 1頁だけ
  const r4 = runPager(pagerDoc([td("1", ""), td("次", "")]));
  ok("1頁だけは 1ページのみ・次無し", r4.onlyOnePage && !r4.hasNextUsable, r4);
  // 番号が <a> の中（td の中の a）
  const r5 = runPager(pagerDoc([El("td", { cls: "pager" }, [El("b", { text: "1" })]), El("td", { cls: "pager" }, [El("a", { text: "2", attrs: { href: "?page=2" } })]), El("td", { cls: "pager" }, [El("a", { text: "3", attrs: { href: "?page=3" } })]), td("次", "pager(2)")]));
  ok("番号が a の中でも数える（いま=1・3頁・次有）", r5.nums.join(",") === "1,2,3" && r5.current === 1 && r5.hasNextUsable, r5);
  ok("読んだ行の形を点検に1行残す（dl:pager_read）", /_liveDlStep\("pager_read"/.test(bulk));
  const fnp = fnSrc(bulk, "_findNextPageEl");
  ok("次の「次」探しは pager(N) と今の頁を比べない（hasNextUsable で決める）", /!pst1\.hasNextUsable/.test(fnp) && !/Number\(pm\[1\]\) <= \(pst1\.current/.test(fnp));
}

console.log("■ ② 沿線（区間）: 裏の解決（resolution-core）");
{
  // resolution-core は ESM の副作用で globalThis に出す
  const done = import(path.join(ext, "resolution-core.js").replace(/\\/g, "/").replace(/^([A-Za-z]):/, "file:///$1:")).then(() => {
    const R = globalThis.SUMORA_RESOLUTION;
    const cases = {
      "御堂筋沿線（中津〜本町）": { r: ["6701"], s: ["中津", "梅田", "淀屋橋", "本町"] },
      "御堂筋線（中津～本町）": { r: ["6701"], s: ["中津", "梅田", "淀屋橋", "本町"] },
      "御堂筋（中津〜本町）": { r: ["6701"], s: ["中津", "梅田", "淀屋橋", "本町"] },
    };
    for (const [a, want] of Object.entries(cases)) {
      const out = R.resolveConditionsLocal({ desired_area: a, area_mode: "station" });
      ok(`「${a}」→ 御堂筋線だけ・駅は中津〜本町の全部`, JSON.stringify(out.route_ids) === JSON.stringify(want.r)
        && want.s.every((x) => out.station_names.includes(x)) && out.station_names.length === want.s.length
        && !out.station_names.includes("御堂筋") && out.unknown_tokens.length === 0, out);
    }
    const plain = R.resolveConditionsLocal({ desired_area: "中津〜本町", area_mode: "station" });
    ok("線の無い「中津〜本町」は今まで通り（各駅の線を全部）", plain.route_ids.length > 1, plain.route_ids);
    const tani = R.resolveConditionsLocal({ desired_area: "谷町線（天満橋〜天王寺）", area_mode: "station" });
    ok("区間の駅名（谷町四丁目）を数字に崩さない", tani.station_names.includes("谷町四丁目") && tani.unknown_tokens.length === 0, tani);
    const note = R.resolveConditionsLocal({ desired_area: "西中島南方（〜じゃなくても可、大阪市内）", area_mode: "station" });
    ok("括弧の補足（〜じゃなくても可）は区間にしない", JSON.stringify(note.station_names) === JSON.stringify(["西中島南方"]), note);
  });

  console.log("■ ② 沿線（区間）: 一括の入力（popup.js の関数を実物の表で）");
  const ctx = { console, window: {} };
  vm.createContext(ctx);
  vm.runInContext(read("popup-maps.js"), ctx);
  const names = ["lineRangeKey", "lineRangeSpecs", "restrictRangeRoutes", "expandLineRange", "lineNameToRouteId", "lineNameToInternalName"];
  const reDecl = /const _LINE_RANGE_RE = [^\n]+/.exec(popup);
  ok("popup.js に区間の正規表現がある", !!reDecl);
  vm.runInContext((reDecl ? reDecl[0] : "") + "\n" + names.map((n) => fnSrc(popup, n)).join("\n")
    + "\nthis.__f = { lineRangeKey, lineRangeSpecs, restrictRangeRoutes };", ctx);
  const F = ctx.__f;
  ok("「御堂筋沿線」→ 駅の並びの表のキー", F.lineRangeKey("御堂筋沿線") === "大阪市高速軌道御堂筋線", F.lineRangeKey("御堂筋沿線"));
  const sp = F.lineRangeSpecs("御堂筋沿線（中津〜本町）");
  ok("区間 = 中津・梅田・淀屋橋・本町（端も含む）", sp.length === 1 && sp[0].stations.join(",") === "中津,梅田,淀屋橋,本町" && sp[0].route_id === "6701", sp);
  const routesOf = (st) => ({ "梅田": ["6701", "6664", "6668"], "本町": ["6701", "6704", "6703"], "中津": ["6701"], "淀屋橋": ["6701"], "江坂": ["6701", "9999"] }[st] || []);
  const rr = F.restrictRangeRoutes(["6701", "6664", "6668", "6704", "6703"], ["中津", "梅田", "淀屋橋", "本町"], sp, routesOf, []);
  ok("沿線は区間の線だけ（梅田・本町の他の線まで広げない）", JSON.stringify(rr) === JSON.stringify(["6701"]), rr);
  const rr2 = F.restrictRangeRoutes(["6701", "9999", "6664"], ["中津", "梅田", "淀屋橋", "本町", "江坂"], sp, routesOf, []);
  ok("区間の外の駅（江坂）の線は残す", rr2.includes("9999") && !rr2.includes("6664"), rr2);
  ok("一括の送る直前に区間で線を絞る・欄が展開済みなら登録の希望エリアから区間を読む",
    /lineRangeSpecs\(adjAreaClean\)/.test(popup) && /lineRangeSpecs\(c\.desired_area \|\| c\.area \|\| ""\)/.test(popup) && /restrictRangeRoutes\(route_ids, realpro_station_names/.test(popup));
  ok("線の名前の切れ端（御堂筋）を駅として送らない", /_lineFrag = realpro_station_names\.filter/.test(popup));
  ok("括弧を消す前に区間を展開（popup の parseAreaTokens）", (() => {
    const p = fnSrc(popup, "parseAreaTokens");
    return p.indexOf("_LINE_RANGE_RE") > 0 && p.indexOf("_LINE_RANGE_RE") < p.indexOf('replace(/（[^）]*）/g, "")');
  })());
  module.exports = done;
}

console.log("■ ③ 迷い: 駅の画面では駅の札だけ・カーソルはつながった動き");
{
  const core = fnSrc(page, "_selectStationsByNameCore");
  ok("駅の画面（one_station／station_id[]）を見分ける", /var _stScreen = labels\.length > 0 \|\| document\.querySelectorAll\('input\[name="station_id\[\]"\]'\)/.test(core));
  ok("駅の画面では画面の他の字（a,td,div…）を候補にしない", /var els = _stScreen \? \[\] :/.test(core));
  ok("「〜線」の字・沿線の札（one_line）は駅にしない", /\/線\$\/\.test\(getDirectText\(el\)\)/.test(core) && /one_line/.test(core));
  ok("飛ばした事を点検に残す（station_line_text_skip）", /_auditStepP\("station_line_text_skip"/.test(core));
  const elsAt = core.indexOf("var els = _stScreen");
  const step2 = core.indexOf("STEP2");
  ok("飛ばしは STEP2〜4（汎用の字の一致）より前", elsAt > 0 && step2 > elsAt);
  ok("pointer-ui: いま飛んでいる途中かを返す（moving）", /moving: function \(\)/.test(ptr) && /_anim && !_anim\.cancelled && !_anim\.done/.test(ptr));
  ok("動かし直す前に飛んでいるカーソルが止まるのを待つ（途中で打ち切らない）", /_moveTry > 1 \? _waitPointerIdle\(\)/.test(page) && /_P\.moving\(\)/.test(page));
  ok("押す物が画面に無い時はカーソルを動かさない（move_target_gone）", /_auditStepP\("move_target_gone"/.test(page));
  ok("外れた物は押さない", /if \(_arr === "gone"\)/.test(page) && /return Promise\.resolve\(_gone === "detached" \? "gone" : false\)/.test(page));
  const SA = require(path.join(ext, "search-audit.js"));
  const sa = read("search-audit.js");
  const KEEP = eval(/var KEEP_STEP = (\/.*\/[a-z]*);/.exec(sa)[1]);
  for (const k of ["dl:pager_read", "page:move_target_gone", "page:station_line_text_skip", "page:station_select_ok", "page:station_per_line_ok", "page:station_name_absent"]) {
    ok(`点検に残る: ${k}`, KEEP.test(k));
  }
  void SA;
}

console.log("■ 手順書の正本（地図）に駅の手");
{
  const map = fs.readFileSync(path.join(__dirname, "..", "..", "app", "lib", "loop-flow-map.ts"), "utf8");
  const i = map.indexOf('button: "駅（沿線の次に駅まで選ぶ）"');
  const go = map.indexOf('button: "駅の設定へ進む"');
  const conf = map.indexOf('button: "確定してリストへ"');
  ok("入力の手に「駅（沿線の次に駅まで選ぶ）」がある", i > 0);
  ok("並び: 駅の設定へ進む → 駅を選ぶ → 確定してリストへ", go > 0 && i > go && conf > i);
  ok("区間の例（中津〜本町＝中津・梅田・淀屋橋・本町）を手の文に持つ", /中津〜本町＝中津・梅田・淀屋橋・本町/.test(map.slice(i, i + 900)));
  ok("駅の場面の station_id[] の手に結ぶ（録画に無ければ駅の設定へ進むの後ろに足す）", /fields: \["station_id\[\]"\], when: "[^"]+", after: "駅の設定へ進む"/.test(map));
}

Promise.resolve(module.exports).then(() => {
  console.log(`\n${pass} passed, ${fail} failed`);
  process.exit(fail ? 1 : 0);
}, (e) => { console.log("NG: 例外 " + (e && e.stack || e)); process.exit(1); });
