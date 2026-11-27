// 2.8.328（2026-11-27 竹内さん「ボタンの把握の部分弱い気がするので、その点徹底的に強化する ちゃんと押したら押したってこと理解できるように」・設計知見 530603c3）:
//   押した（押す関数が実際に呼ばれた）と効いた（画面が変わった）を別に見る仕組みの配線。構造と順番を見る。
const fs = require("fs"), path = require("path");
const root = path.join(__dirname, "..", "..", "chrome-extension");
const read = (f) => fs.readFileSync(path.join(root, f), "utf8").replace(/\r\n/g, "\n");
const ps = read("page-script.js"), dl = read("bulk-dl.js"), bg = read("background.js"), au = read("search-audit.js");
let pass = 0, fail = 0;
function ok(n, c, d) { if (c) { pass++; console.log("  ✓ " + n); } else { fail++; console.log("  ✗ " + n + (d ? " :: " + d : "")); } }
/** 関数の本体（宣言の行と同じ字下げの "}" まで） */
function body(src, name) {
  const m = new RegExp("\\n([ \\t]*)(async )?function " + name + "\\(").exec(src);
  if (!m) return "";
  const end = src.indexOf("\n" + m[1] + "}", m.index + 1);
  return end < 0 ? "" : src.slice(m.index + 1, end + m[1].length + 2);
}

console.log("■ ページ: 押した受領（_humanPointerClick の外側）");
{
  const outer = body(ps, "_humanPointerClick");
  const core = body(ps, "_humanPointerClickCore");
  ok("外側と中身に分かれている", outer.length > 0 && core.length > 0);
  ok("外側は押す関数が呼ばれたかを覚える（st.fired = true）", /st\.fired = true/.test(outer));
  ok("外側は中身を呼んで、終わったら受領を出す", /_humanPointerClickCore\(/.test(outer) && /_pressReceipt\(el, st\.fired/.test(outer));
  ok("例外でも押せなかった受領を出す", /catch \(e\) \{[^}]*_pressReceipt\(el, false, "exception"\)/.test(outer));
  ok("中身が自分を呼び直す所は中身を直接呼ぶ（受領が二重にならない）", !/[^e]_humanPointerClick\(/.test(core.replace(/function _humanPointerClickCore\(/, "")));
  const kind = body(ps, "_pressKindOf");
  ok("チェック欄（区・町・沿線・駅）は種類なし＝押せた受領を出さない", /one_city/.test(kind) && /one_station/.test(kind) && /return null/.test(kind));
  for (const k of ["confirm", "area_open", "go_station", "search", "reset"]) ok(`種類 ${k} を返す`, kind.includes(`return "${k}"`));
  const rec = body(ps, "_pressReceipt");
  ok("受領は点検（press_ok_/press_ng_）と枠（_pressNote press）の両方へ", /"press_ok_" : "press_ng_"/.test(rec) && /_pressNote\("press"/.test(rec));
}

console.log("■ ページ: 列（積んだ≠押した）");
{
  const clr = body(ps, "clearClickQueue");
  ok("取り消しで押されなかった物を数える（press_ng_cleared）", /_ran/.test(clr) && /press_ng_cleared/.test(clr));
  ok("20秒の安全弁で落とした物を残す（press_ng_stuck）", /press_ng_stuck/.test(ps));
  const reset = body(ps, "_resetPress");
  const iNot = reset.indexOf("queue_idle_not_fired");
  ok("リセットは列が空いても押す関数が呼ばれていなければ押せなかった扱い", iNot > 0 && /if \(!fired\)/.test(reset));
}

console.log("■ ページ: 効いたの確かめ");
{
  const ce = body(ps, "_confirmEffectThen");
  ok("確定は閉じたか見る→押し直し1回→閉じなければ止める", /confirm_effect_ok/.test(ce) && /confirm_effect_retry/.test(ce) && /confirm_effect_ng/.test(ce) && /notifyDone\(/.test(ce));
  ok("確定の押し直しは1回だけ", (ce.match(/_pressConfirmListLikeHuman\(/g) || []).length === 1);
  const area = body(ps, "_afterAreaAllPressedThenNext");
  ok("所在地は閉じたのを見てから次の手（_confirmEffectThen → _guideLikeAfterConfirmCheck）",
    area.indexOf('_confirmEffectThen("area"') >= 0 && area.indexOf('_confirmEffectThen("area"') < area.indexOf("_guideLikeAfterConfirmCheck"));
  const st = body(ps, "_afterStationThenBasicSearch");
  ok("駅も閉じたのを見てから次の手", st.indexOf('_confirmEffectThen("station"') >= 0 && st.indexOf('_confirmEffectThen("station"') < st.indexOf("_guideLikeAfterConfirmCheck"));
  ok("所在地を開いたかは小窓が見えるかで見る（input が有るかだけで決めない）", /var opened = function \(\) \{\s*try \{\s*var g = _graspAreaModalScreen\(\);\s*return !!\(g && g\.kind !== "closed"\)/.test(ps));
  ok("開く途中に押し直さない（列が忙しい間は待つ・9秒で打ち切り）", /area_open_late_skip/.test(ps));
}

console.log("■ ページ: 入力の終わりの数・先に送る印");
{
  const iClr = ps.indexOf("_doneNotified = true");
  const iSum = ps.indexOf('_auditStepP("press_sum"');
  ok("終わりの合図のあと、押せた・押せなかったの数を1行（press_sum）", iClr > 0 && iSum > iClr);
  ok("入力の始めに数を0に戻す", /_pressLedgerReset\(\)/.test(ps));
  const pin = /var _PIN = \/\^\(([^)]*)/.exec(ps);
  for (const k of ["press_ok_", "press_ng_", "press_sum", "confirm_effect_", "area_open_ok", "search_press_ok", "reset_press_"]) {
    ok(`ページ側の先送り（_PIN）に ${k}`, !!pin && pin[1].split("|").includes(k));
  }
}

console.log("■ 一覧（bulk-dl）: 印刷用PDF・次へ・高→低");
{
  const pdf = body(dl, "_pressPrintPdf");
  ok("印刷用PDFは押せたかを返す（cb(ok)）・押せなければ press_ng_pdf", /cb\(ok\)/.test(pdf) && /press_ng_pdf/.test(pdf));
  ok("送り始めなかったのを残す（press_ng_pdf_effect）", /press_ng_pdf_effect/.test(dl));
  const iSum = dl.indexOf('"press_pdf_sum"');
  ok("頁の終わりに押した・送れた・送れずの数（press_pdf_sum）", iSum > 0);
  const nx = body(dl, "_nextPageEffectNote");
  ok("次へは頁の番号で動いたか見る（press_next_moved／press_ng_next_page）", /press_next_moved/.test(nx) && /press_ng_next_page/.test(nx) && /_readPagerState\(\)/.test(nx));
  ok("次へを押した受領（press_next／press_ng_next）", /"press_next"/.test(dl) && /"press_ng_next"/.test(dl));
  // 竹内さん「時間差で並べ替えしたということの認識にすればよい」
  const rec = body(dl, "_sortTimeRecognized");
  ok("高→低は押した時刻からの時間差で完了と認識（press_sort_effect_ok／短い・不明は press_ng_sort_effect）",
    /press_sort_effect_ok/.test(rec) && /press_ng_sort_effect/.test(rec) && /SORT_MIN_GAP_MS/.test(rec));
  ok("押した時に時刻を覚える（_sortPressedAt = Date.now()）", /_adSortDone = true;\s*_sortPressedAt = Date\.now\(\);/.test(dl));
  ok("読み直し後は保存した押した時刻を使う", /if \(!_sortPressedAt\) _sortPressedAt = Number\(_sortSync\.at\)/.test(dl));
  const iRec = dl.indexOf('_sortTimeRecognized("resume"'), iDone = dl.indexOf('_liveDlStep("sort_done", "pressed_resume")');
  ok("読み直し後: 猶予のあと認識してから④（sort_done の前）", iRec > 0 && iDone > iRec);
  const iRec2 = dl.indexOf('_sortTimeRecognized("hilo"'), iDone2 = dl.indexOf('_liveDlStep("sort_done", "hilo")');
  ok("同じページ: 猶予のあと認識してから④", iRec2 > 0 && iDone2 > iRec2);
  const sch = body(dl, "_scheduleSortCursorAfterSearch");
  ok("並べ替え済みの一覧では並べ替えを始めない（新しい行の道・#1673）", /_sortRecognizedDone\("schedule:/.test(sch) && sch.indexOf("_sortRecognizedDone") < sch.indexOf("_rescanRows"));
  ok("きっかけ（kick）の道も同じ確かめ", /_sortRecognizedDone\("kick:/.test(body(dl, "_kickSortAfterSearch")));
  const rd = body(dl, "_sortRecognizedDone");
  ok("並べ替え済み＝押した・読み直し後の続き・物件取得が始まった・次頁の続き", /_adSortDone/.test(rd) && /_sortResumeStarted/.test(rd) && /_sortResumeWaiting/.test(rd) && /_sortPressedAt/.test(rd));
  ok("URL だけで効いたと決める旧の印は無い（読み直し判定は通らない道だった）", !/_adUrl \? "press_sort_effect_ok"/.test(dl));
  for (const c of ['"confirm"', '"pdf"', '"next"', '"sort"', '"press"']) ok(`枠の「押した」行が ${c} を受ける`, body(dl, "_setPressNote").includes(c));
}

console.log("■ 点検: 押した印が上限で捨てられない");
{
  const keep = /var KEEP_STEP = \/\^\(([^)]*)/.exec(au);
  const rule = /var RULE_STEP = \/\^\(([^)]*)/.exec(au);
  for (const k of ["page:press_ng_", "page:press_sum", "page:confirm_effect_", "page:area_open_ok", "dl:press_"]) ok(`KEEP_STEP に ${k}`, !!keep && keep[1].split("|").includes(k));
  ok("RULE_STEP に page:press_ok_", !!rule && rule[1].split("|").includes("page:press_ok_"));
}

console.log("■ 裏（background）: リセットのタブ・重いだけの無返事");
{
  ok("リセットで押すタブの選び方は1か所（_pickRealproResetTab）", body(bg, "_pickRealproResetTab").length > 0);
  ok("リセットの4か所が同じ選び方を使う", (bg.match(/_pickRealproResetTab\(/g) || []).length >= 5);
  const en = body(bg, "_ensureRealproTab");
  ok("エラー無しの無返事は確かめ直す（すぐ読み直さない）", /返事が遅かっただけ/.test(en) && /!probe\.err/.test(en));
  ok("リセットの前に並べ替えの印も消す（axlx_sort_pressed_sync）", /"axlx_sort_pressed_sync"/.test(bg));
  ok("物件の比較も一括中・邪魔しない窓は後回し", /webapp_compare/.test(bg));
}

console.log(`\n結果: ${pass} 通過 / ${fail} 失敗`);
if (fail) process.exit(1);
