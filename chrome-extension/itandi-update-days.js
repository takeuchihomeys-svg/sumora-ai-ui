// chrome-extension/itandi-update-days.js
// ITANDI BB の検索フォームの「募集条件更新 [ ] 日以内」に、リアプロの更新日（rp_update_days）と同じ日数を入れる（v2.5.34）。
//
// 2026-09-27 竹内（ITANDI の賃貸物件検索のスクショ）「ITANDI のここの更新日、リアプロではボタン押すけど、ここでは更新日に合わせて
//   入力できるようにする。そうすれば更新に沿って物件検索できるから」「リアプロはボタンで選択やけど ITANDI は入力となる（更新日）」
//   ＝ リアプロは select[name="update_date"] に値を入れる（page-script.js）。ITANDI は入力欄に日数の数字を「打つ」。仕組みを混同しない。
//
// 決まり（純関数・下のテストで固定: tests/chrome-extension/itandi-update-days.test.js）:
//   ・日数の出どころはリアプロと同じ（popup の更新日の欄／background の _buildBatchConditions の rp_update_days）
//   ・日数が無い（null）＝「なし」。欄が空ならそのまま触らない（今までどおり）。前のお客様の値が残っていたら空にする
//   ・「0」（当日）と「なし」（空）は別の値として扱う
//   ・欄の場所は保存されたコードにも記録にも無かった（2026-09-27 時点で name 未確認）→ 「募集条件更新」の文字から近い入力欄を探す。
//     見つからなければ name に update を含む欄を how="name" で返す（記録だけ・呼ぶ側は打たない）。お金の欄（renew/fee 等）は候補にしない。
//     どちらも無ければ「欄が無い」と返す（検索は止めない・点検に残す）
//   ・入れ方: 欄を押す → 開いた一覧を見る → 空にする → 1文字ずつ打つ（人の間）→ 一覧（なし/0/1/…/9）に同じ値があれば押す・
//     一覧が無ければ change を出して欄を離れる（set_typed＝確定は未確認）。
//     ⚠ Escape は使わない（itandi ではグローバルの keydown が React の状態を壊す・itandi-page-script.js の 178 行目）
//   ・一覧に無い日数（14 等）は打たない → なし（広い側・漏れない）で out_of_range。9 に丸めない（狭くなり漏れる）
//   ・入った後に値を読み直して確かめる。一覧を押したのに残らない時だけ1回入れ直す。
//     空にもできず前の値が残る時だけ "stuck" を返す（呼ぶ側は検索を押さない）
//   ・待ちは呼ぶ側の human-wait（env.hd／env.sd）。このファイルに固定の待ちは置かない
(function (root, factory) {
  var api = factory();
  if (typeof module !== "undefined" && module.exports) { module.exports = api; }
  if (root) { root.AxlxItandiUpdateDays = api; }
})(typeof self !== "undefined" ? self : (typeof globalThis !== "undefined" ? globalThis : this), function () {
  "use strict";

  var LABEL = "募集条件更新";
  // ITANDI の他の欄（このファイルが触ってはいけない物）。name の頭で見分ける
  var OTHER_FIELD_RE = /^(rent|floor_area_amount|station_walk_minutes|building_age|room_layout|structure_type|option_id|totalRentCheck)/;
  // 更新料・費用などお金の欄（日数を打ってはいけない）。v2.5.34 反証の検証: 予備の探し方の renew が更新料（renewal_fee 等）を拾うおそれ
  var MONEY_FIELD_RE = /renew|fee|price|cost|money|ryo|kin$/i;
  // 名前での予備は「見つけた」と記録するだけで打たない（呼ぶ側が how="name" を field_missing 扱いにする）。欄の name が分かったらラベルより先に探す
  var NAME_FALLBACK_RE = /update|koushin|kousin/i;

  function nfkc(s) { var t = String(s == null ? "" : s); return t.normalize ? t.normalize("NFKC") : t; }

  // 入れる日数に揃える: null＝なし／0 以上の整数（"3"・3・"3日" も 3）。負・読めない物は null
  function normDays(v) {
    if (v === null || v === undefined) return null;
    if (typeof v === "number") return isFinite(v) && v >= 0 ? Math.floor(v) : null;
    var s = nfkc(v).trim();
    if (!s || s === "なし" || s === "指定なし") return null;
    var m = s.match(/^(\d+)/);
    return m ? Number(m[1]) : null;
  }

  // 欄に見えている文字 → 日数。"" と「なし」は null・数字は 0 も含めて数・それ以外（読めない文字）は文字のまま返す
  function readDays(raw) {
    var s = nfkc(raw).replace(/\s+/g, "");
    if (!s || s === "なし" || s === "指定なし") return null;
    var m = s.match(/^(\d+)(日(以内)?)?$/);
    return m ? Number(m[1]) : s;
  }

  function sameDays(a, b) { return a === b; }

  // 一覧の選択肢の文字が、入れたい日数（null＝なし）と同じか
  function optionMatches(text, days) {
    var t = readDays(text);
    if (days === null) return t === null && /なし/.test(nfkc(text));
    return t === days;
  }

  // 今の値と入れたい値から、何をするか（keep＝触らない／set＝入れる／clear＝空にする）
  function plan(currentRaw, want) {
    var cur = readDays(currentRaw);
    if (sameDays(cur, want)) return "keep";
    return want === null ? "clear" : "set";
  }

  // ── 欄を探す（DOM の children・parentElement・textContent・tagName・getAttribute だけを使う）──
  function isInputish(el) {
    if (!el || !el.tagName) return false;
    var tag = String(el.tagName).toUpperCase();
    if (tag === "SELECT") return true;
    if (tag !== "INPUT") return false;
    var type = String(el.type || (el.getAttribute && el.getAttribute("type")) || "text").toLowerCase();
    return ["checkbox", "radio", "hidden", "submit", "button", "reset", "file", "image"].indexOf(type) < 0;
  }
  function nameOf(el) { return String(el.name || (el.getAttribute && el.getAttribute("name")) || ""); }
  function isCandidate(el) { var n = nameOf(el); return isInputish(el) && !OTHER_FIELD_RE.test(n) && !MONEY_FIELD_RE.test(n); }
  function preorder(rootEl) {
    var out = [];
    (function walk(n) { out.push(n); var ch = n.children || []; for (var i = 0; i < ch.length; i++) walk(ch[i]); })(rootEl);
    return out;
  }
  function textOf(el) { return nfkc(el.textContent).replace(/[\s　]/g, ""); }

  function findField(rootEl) {
    if (!rootEl) return null;
    var all = preorder(rootEl);
    // ① 文字「募集条件更新」を持つ一番内側の要素から、祖先を6段まで上って入力欄を探す
    //    文字を持つ子だけを下りる（ページ全体の要素の textContent を全部読まない＝一覧の表が大きくても重くならない）
    var labels = [];
    (function down(n) {
      var ch = n.children || [], hit = [];
      for (var i = 0; i < ch.length; i++) if (textOf(ch[i]).indexOf(LABEL) >= 0) hit.push(ch[i]);
      if (!hit.length) { if (n !== rootEl) labels.push(n); return; }
      for (var j = 0; j < hit.length; j++) down(hit[j]);
    })(rootEl);
    // 一覧の列の見出し「募集条件更新日」より、フォームの「募集条件更新」ちょうど（や「〜日以内」）を先に試す
    labels.sort(function (a, b) {
      var ea = /^募集条件更新(日以内)?$/.test(textOf(a)) ? 0 : 1, eb = /^募集条件更新(日以内)?$/.test(textOf(b)) ? 0 : 1;
      return ea - eb || all.indexOf(a) - all.indexOf(b);
    });
    for (var li = 0; li < labels.length; li++) {
      var lab = labels[li];
      var labIdx = all.indexOf(lab);
      // ラベルの要素そのものが入力欄を包んでいる時（<label>募集条件更新 <input> 日以内</label>）も同じ扱い
      var anc = lab;
      for (var depth = 0; depth <= 6 && anc; depth++) {
        var cands = preorder(anc).filter(function (x) { return x !== anc && isCandidate(x); });
        if (cands.length) {
          if (cands.length > 3) break; // 広すぎる（フォーム全体まで上った）→ このラベルからは決めない
          var after = cands.filter(function (x) { return all.indexOf(x) > labIdx; });
          var el = after[0] || cands[0];
          return { el: el, how: "label", name: nameOf(el) || null };
        }
        if (anc === rootEl) break;
        anc = anc.parentElement;
      }
    }
    // ② name に update 等を含む欄（他の欄の name は除く）
    for (var i = 0; i < all.length; i++) {
      if (isCandidate(all[i]) && NAME_FALLBACK_RE.test(nameOf(all[i]))) return { el: all[i], how: "name", name: nameOf(all[i]) };
    }
    return null;
  }

  // ── 入れる（env: later(fn, ms)・hd(ms)・sd(ms)・setVal(el, v)・fire(el, type)・press(el)・click(el)・blur(el)・options(el)）──
  //   done({ status, want, before, got, how_set, tries })
  //   status: kept（もう同じ値）／set（一覧・select から選んで入れた）／set_typed（一覧が無く打っただけ・値として確定したかは画面の文字では
  //           分からない＝点検は warn）／cleared（空にした）／out_of_range（一覧 なし/0〜9 に無い日数＝打たずに なし で検索）／
  //           not_accepted（打ったが入らず空で検索）／stuck（空にもできない）
  //   v2.5.34 反証の検証（2026-09-27）: 8日以上たったお客様の 14 を毎回打って弾かれて なし に戻す動きになっていた → 欄を押して一覧を見た時点で
  //     数の選択肢があり同じ値が無ければ打たない（人は一覧に無い数を打たない）。9 に丸めると狭くなり物件が漏れるので丸めない
  function hasNumberOptions(list) {
    for (var k = 0; k < list.length; k++) if (typeof readDays(list[k].textContent) === "number") return true;
    return false;
  }
  function run(el, days, env, done) {
    var want = normDays(days);
    var before = el ? String(el.value == null ? "" : el.value) : "";
    var tries = 0;
    var howSet = null;
    var outOfRange = false;
    function finish(status) {
      done({ status: status, want: want, before: before, got: String(el.value == null ? "" : el.value), how_set: howSet, tries: tries });
    }
    var first = plan(before, want);
    if (first === "keep") { finish("kept"); return; }

    var isSelect = String(el.tagName || "").toUpperCase() === "SELECT";

    function attempt(target, cb) {
      tries++;
      if (isSelect) {
        var opts = [].slice.call(el.options || []);
        var pick = function (tg) { return opts.filter(function (x) { return tg === null ? (x.value === "" || optionMatches(x.textContent, null)) : readDays(x.value) === tg || optionMatches(x.textContent, tg); })[0]; };
        var o = pick(target);
        if (!o && target !== null && hasNumberOptions(opts)) { outOfRange = true; o = pick(null); }
        if (o) { env.setVal(el, o.value); env.fire(el, "change"); howSet = outOfRange ? "out_of_range" : "select"; }
        env.later(function () { cb(); }, env.sd(300));
        return;
      }
      env.press(el);
      env.later(function () {
        if (target !== null) {
          // 押して開いた一覧を見る: 数の選択肢があって同じ値が無い＝一覧に無い日数 → 打たずに なし へ
          var pre = env.options(el) || [];
          if (hasNumberOptions(pre) && !pre.some(function (x) { return optionMatches(x.textContent, target); })) {
            outOfRange = true; target = null;
            if (readDays(el.value) === null) { env.blur(el); howSet = "out_of_range"; env.later(function () { cb(); }, env.sd(300)); return; }
          }
        }
        env.setVal(el, "");
        var text = target === null ? "" : String(target);
        var i = 0;
        (function typeNext() {
          if (i < text.length) {
            env.later(function () { i++; env.setVal(el, text.slice(0, i)); typeNext(); }, env.hd(140));
            return;
          }
          env.later(function () {
            var list = env.options(el) || [];
            var hit = list.filter(function (x) { return optionMatches(x.textContent, target); })[0];
            if (!hit && target !== null && hasNumberOptions(list)) {
              // 打った後に出た一覧に同じ値が無い → 一覧に無い日数。打った文字を消して なし を選ぶ
              outOfRange = true; target = null; env.setVal(el, "");
              list = env.options(el) || [];
              hit = list.filter(function (x) { return optionMatches(x.textContent, null); })[0];
            }
            if (hit) {
              // 押した後も欄を離れてから読む（押しが効かなかった時、欄には打った文字が見えたままで、離れた時に元へ戻るため）
              env.click(hit); env.blur(el); howSet = outOfRange ? "out_of_range" : "option";
            } else {
              env.fire(el, "change"); env.blur(el); howSet = outOfRange ? "out_of_range" : "typed";
            }
            env.later(function () { cb(); }, env.sd(300));
          }, env.sd(300));
        })();
      }, env.hd(250));
    }

    function check() { return sameDays(readDays(el.value), want); }
    function okStatus() { return want === null ? "cleared" : (howSet === "typed" ? "set_typed" : "set"); }

    attempt(want, function () {
      if (outOfRange) { finish(readDays(el.value) === null ? "out_of_range" : "stuck"); return; }
      if (check()) { finish(okStatus()); return; }
      // 入れ直すのは「一覧の選択肢を押したのに値が残らなかった」時だけ（1回）。打った値が入らない欄は
      //   同じ文字を打ち直しても同じ → すぐ空にする（人が何度も打ち直す動きをしない）
      var retry = howSet === "option" || howSet === "select";
      var afterRetry = function () {
        if (check()) { finish(okStatus()); return; }
        if (want === null) { finish("stuck"); return; }
        attempt(null, function () { finish(readDays(el.value) === null ? "not_accepted" : "stuck"); });
      };
      if (retry) attempt(want, afterRetry); else afterRetry();
    });
  }

  return {
    LABEL: LABEL,
    normDays: normDays,
    readDays: readDays,
    optionMatches: optionMatches,
    plan: plan,
    findField: findField,
    run: run,
  };
});
