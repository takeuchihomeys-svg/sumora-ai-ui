// 2.8.129: 前客の区を小窓を開いて外す／号室メニューの ×とじる を検索の小窓と取り違えない／所在地の代替も小窓を通す／「次」はカーソルで1回だけ
const fs = require("fs");
const path = require("path");

let pass = 0, fail = 0;
function ok(name, cond) { if (cond) { pass++; console.log("✓ " + name); } else { fail++; console.log("✗ " + name); } }

const root = path.join(__dirname, "..", "..", "chrome-extension");
const ps = fs.readFileSync(path.join(root, "page-script.js"), "utf8");
const bd = fs.readFileSync(path.join(root, "bulk-dl.js"), "utf8");
const mf = JSON.parse(fs.readFileSync(path.join(root, "manifest.json"), "utf8"));

function body(src, name) {
  const i = src.indexOf("function " + name + "(");
  if (i < 0) return "";
  let d = 0, j = src.indexOf("{", i);
  for (let k = j; k < src.length; k++) {
    if (src[k] === "{") d++;
    else if (src[k] === "}") { d--; if (d === 0) return src.slice(i, k + 1); }
  }
  return "";
}

ok("版は manifest と page-script で同じ 2.8.129", mf.version === "2.8.129" && /_AXLX_PAGE_VER = "2\.8\.129"/.test(ps));

// 区の外し: DOM に在るだけで「開いた」とみなさない
const wc = body(ps, "_clearWardsBeforeStationThen");
ok("区の外し: .this_window が在るだけで開いた扱いにしない", wc && !/cityNow > 0 && document\.querySelector\("div\.this_window_close, \.this_window"\)/.test(wc));
ok("区の外し: 画面を読んで決める（_graspAreaModalScreen）", /_graspAreaModalScreen\(\)/.test(wc));
ok("区の外し: 都道府県の画面なら大阪府を押す", /pref_list[\s\S]{0,300}clickByText\(\["大阪府"\]\)/.test(wc));
ok("区の外し: 見えない区は区の一覧へ戻って外す", /leftover_ward_back/.test(wc));
ok("区の外し: 小窓が閉じていたら開き直す", /leftover_ward_reopen/.test(wc));
ok("区の外し: 見えない区だけの時は町の画面へ進まない", /_hidWard > 0 && _hidTown === 0\) townStepTried = true/.test(wc));
ok("区の外し: checked を直接書き換えない", !/\.checked\s*=\s*(false|true)/.test(wc));

// Step1: 号室メニューを検索の小窓と取り違えない
const isRm = body(ps, "_isRoomMenuEl");
ok("号室メニュー判定の関数がある", !!isRm && !!body(ps, "_roomMenuCloseOnScreen"));
const fn = new Function(isRm + "; return _isRoomMenuEl;")();
ok("hide_room_menu_close は号室メニュー", fn({ className: "hide_room_menu_close", closest: () => null }) === true);
ok("this_window_close は号室メニューではない", fn({ className: "this_window_close", closest: () => null }) === false);
ok("号室メニューの中の要素も号室メニュー", fn({ className: "x", closest: (s) => (/room_menu/.test(s) ? {} : null) }) === true);
ok("_doReset Step1 は号室メニューを除く", /return !_isRoomMenuEl\(el\);/.test(ps));
ok("号室メニューは画面に出ている時だけ閉じ、駅・沿線には触らない", /room_menu_close/.test(ps) && /_roomMenuCloseOnScreen\(\)/.test(ps));
ok("小窓の外からの駅・沿線外しは見える物だけ", /_uncheckVisibleStationsLikeHuman\(true\)/.test(ps) && /_uncheckVisibleLinesLikeHuman\(true\)/.test(ps));

// 所在地の代替: 小窓を通す
const fb = body(ps, "_areaFallbackViaModal");
ok("所在地の代替は小窓を開いて区を1つずつ押す", !!fb && /_toggleCheckboxLikeHuman\(inp, true\)/.test(fb) && /_pressConfirmListLikeHuman/.test(fb));
ok("所在地の代替（2経路）で setCheckboxes('city_code[]', codes) を呼ばない", !/setCheckboxes\('city_code\[\]', codes\)/.test(ps));
ok("区が1つでも入れば検索の経路も小窓を通す", /_areaAtLeastOneThenSearch[\s\S]{0,600}_areaFallbackViaModal\(codes/.test(ps));
ok("全部入っている時は小窓を開かない", /if \(!want\.length \|\| allOn\) \{ end\(allOn\); return; \}/.test(fb));

// 前客の把握
ok("前客と今客を監査に残す", /前客=同じお客さん（やり直し）/.test(ps) && /今客=/.test(ps));
ok("同じページ内の前客の名前も台帳に足す", /_addNm\("区", _axWardPicked\)/.test(ps));

// 「次」: カーソルで1回だけ
const nx = body(bd, "clickNextPageBtn");
ok("「次」はカーソルを動かしてから押す", /P\.moveToEl\(el\)/.test(nx));
ok("「次」の onclick 直実行は頁が変わらない時だけ（同時3回押しをやめる）", /_tryFallback\(0\)/.test(nx) && /if \(_moved\(\)\) return;/.test(nx));
ok("頁送りの確かめ待ちを延ばした", /_verifyNextPage\(_urlBefore, 14000\)/.test(bd));

console.log(pass + " pass / " + fail + " fail");
process.exit(fail ? 1 : 0);
