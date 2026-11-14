// chrome-extension/human-learn.js
// 2026-11-11 竹内さん「必要なら人間の動きをちゃんとおしえるので画面録画や監視して動きちゃんと理解できるように。
//   通常モードのところで動きこっちで行うからそこ把握できれば理想。普通モードはスタッフの動きを学習する形でもよい」
//
// 何をするか:
//   通常モード（とスタッフモード）の間、**人が本当に押した・打った・選んだ**操作を画面から見張って覚える。
//   覚えるのは「どの欄を・どの順で・どれくらい間をあけて触ったか」だけ。**入力した中身（値）は残さない**。
//   覚えた物は集計（回数・間の中央値・触った欄の順）にして chrome.storage.local に溜める。
//   自動モードの「人のような間」を、この実測に寄せていくための材料（今は貯める所まで）。
//
// 2026-11-11 竹内さん「普通モードでのマウスの動かし方やボタンのどこ押すかもちゃんとたまるんかな。
//   画面のうごかしかたも」:
//   ① **マウスの動かし方**も覚える（`moves`）: 1回の移動ごとに
//        距離・時間・速さ（平均／最大）・まっすぐ具合（曲がり）・始点と終点・形（点を8個まで）
//      → 「どれくらいの速さで・どれくらい曲がって動くか」が分かる（pointer-ui.js の軌跡を実測に寄せる材料）
//   ② **ボタンのどこを押したか**も覚える（`points`）: 押した要素の中の位置を 0〜1 の割合で
//      → 「真ん中ではなく左寄りを押す」のような癖が分かる（_fireAt の狙う点を実測に寄せる材料）
//   ③ **画面の動かし方**も覚える（scroll の `dy`・`y`）: 1回のスクロール量と、その時のページ内の位置（％）
//      → 「一度にどれくらい動かすか・どこまで送ってから押すか」が分かる
//   座標は**画面（ビューポート）の％**で持つ（画面の大きさが違っても比べられる）。
//
// 見分け方:
//   ブラウザが本当に人が起こしたイベントは isTrusted === true。拡張が作った物は false。
//   → 通常モードでは拡張は押さないので、数えられるのは人の操作だけ（拡張の動きは混ざらない）。
//
// このファイルは chrome.* を使わない純関数（テストしやすい）。保存は human-learn-record.js が行う。
(function (root, factory) {
  var api = factory();
  if (typeof module !== "undefined" && module.exports) { module.exports = api; }
  if (root) { root.AxlxHumanLearn = api; }
})(typeof self !== "undefined" ? self : (typeof globalThis !== "undefined" ? globalThis : this), function () {
  "use strict";

  var MAX_OPS = 150;          // 1ページで覚える操作の上限（古い物から捨てる）
  var SAME_KIND_MIN_MS = 250; // 同じ種類が続く時は間引く（スクロールや連続キーで溢れないように）
  var MAX_FIELDS = 40;        // 覚える欄の名前の種類の上限
  var MAX_GAPS = 80;          // 間（ms）の見本の上限（中央値を出すため）
  // 2026-11-11 竹内さん「マウスの動かし方やボタンのどこ押すか、画面のうごかしかたも」:
  var MAX_MOVES = 40;         // 1ページで覚える「1回の移動」の上限
  var MAX_MOVE_PTS = 24;      // 1回の移動で貯める点の上限（多すぎると重い）
  var MOVE_GAP_MS = 350;      // 指が止まってこれだけ経ったら「1回の移動」を締める
  var MAX_POINTS = 40;        // 押した場所の上限
  var MAX_SCROLLS = 40;       // 画面の動かし方の上限
  var MAX_OPENS = 40;         // 「押したら何が開いたか」の上限（2026-11-14）

  /**
   * 2026-11-11 竹内さん「これでボタン物件検索でおすばしょ理解できたかな？」→
   *   「押した場所は分かるが、**何というボタンか**が分からない」（リアプロの検索ボタンは名前の無い DIV）:
   *   旧は name → id → 文字（BUTTON/A/LABEL/OPTION だけ）→ class → タグ の順。
   *   → **DIV/SPAN/TD の文字も拾う**（「検索」「駅の設定へ進む」など）。加えて class も必ず残す。
   *
   *   名前の作り方（人が読んで分かる形にする）:
   *     "検索｜div.go_search"      … 文字が取れた時（文字｜タグ.クラス）
   *     "go_search"               … 文字が無くて class がある時（その class）
   *     "rental_cost2"            … name がある時（欄の名前を最優先）
   *     "#btn-mode-ward"          … id がある時
   *   ⚠ 入力した中身（値）は入れない。文字は**ボタンや見出しの表示文言**だけ（30字まで）。
   */
  var TEXT_TAGS = /^(BUTTON|A|LABEL|OPTION|LI|SPAN|DIV|TD|TH|P|H1|H2|H3|H4)$/;
  function fieldName(el) {
    if (!el) return null;
    try {
      var tag = String(el.tagName || "").toUpperCase();
      // ① 欄の名前（input/select はこれが一番確実）
      var name = el.getAttribute && el.getAttribute("name");
      if (name) return String(name).slice(0, 30);
      // ② 表示の文字（人が「何を押したか」分かる形）＋ class（サイト側の目印）
      var cls = (el.className && typeof el.className === "string") ? el.className.trim().split(/\s+/)[0] : "";
      var mark = tag.toLowerCase() + (cls ? "." + cls : "");
      /**
       * 2026-11-11 竹内さん「検索のボタンはこのように2か所ある。その点をちゃんと理解すればより質上がる」:
       *   リアプロの「検索」は**2か所**（左のサイドバー／小窓の中）。どちらも `検索｜div.go_search` になるので
       *   **名前だけでは区別できない** → 場所を名前の頭に付ける。
       *     "小窓の検索｜…"  … 小窓（市区郡・沿線の設定）の中の検索
       *     "左の検索｜…"    … 左のサイドバーの検索（メイン・これを押すのが正しい）
       */
      var placePrefix = "";
      try {
        if (el.closest) {
          if (el.closest('.this_window, [role="dialog"], .modal, #modal, .modal_wrap')) placePrefix = "小窓の";
          else {
            var _r = el.getBoundingClientRect ? el.getBoundingClientRect() : null;
            var _vw = 0;
            try { _vw = (typeof window !== "undefined" && window.innerWidth) || 1200; } catch (_) { _vw = 1200; }
            if ((el.closest('.one_slide_search_box, #search_area, .search_box, #left, .left_area, .side')) ||
                (_r && _r.left < _vw * 0.45)) placePrefix = "左の";
          }
        }
      } catch (_) {}
      if (TEXT_TAGS.test(tag)) {
        var txt = directText(el).slice(0, 20);
        if (txt) return (placePrefix + txt + "｜" + mark).slice(0, 30);
      }
      /**
       * 2026-11-14 竹内さん「弱い部分を俺が実際みつけたら通常モードの録画から実際の動きを学習して改善する」
       *   → 実測: 学べた欄の **8割が `img` と `body`**（7日で img 26回・body 8回・本物は pager 4回だけ）。
       *     ＝ **欄の名前が取れていない**ので「押す位置」を学べない。
       *
       *   ⚠ 原因: 名前も id も class も無い要素（画像・余白）は、最後に**タグ名をそのまま**返していた。
       *     `img` / `body` は**欄ではない**ので、いくら貯めても学習の役に立たない。
       *
       *   → ① **親をたどって意味のある名前を探す**（画像を包むリンク・ボタン・行の見出し）。
       *     ② それでも無い `img` / `body` / `html` は **`null` を返す**（記録しない＝ゴミを貯めない）。
       */
      var _NON_FIELD = /^(img|body|html|picture|svg|canvas|br|hr)$/i;
      try {
        if (_NON_FIELD.test(tag) && el.closest) {
          // ① 押した画像/余白を包む「意味のある入れ物」を探す（リンク・ボタン・ラベル・行）
          var _host = el.closest("a,button,label,tr,li,[role='button']");
          if (_host && _host !== el) {
            var _hostName = _host.getAttribute && _host.getAttribute("name");
            if (_hostName) return String(_hostName).slice(0, 30);
            var _hostTxt = directText(_host).slice(0, 20);
            if (_hostTxt) return (placePrefix + _hostTxt + "｜" + tag.toLowerCase()).slice(0, 30);
            var _hostCls = (_host.className && typeof _host.className === "string") ? _host.className.trim().split(/\s+/)[0] : "";
            if (_hostCls) return (tag.toLowerCase() + "→" + _host.tagName.toLowerCase() + "." + _hostCls).slice(0, 30);
          }
          // ② 意味のある名前が無い → **記録しない**（`img` `body` を貯めても学べない）
          return null;
        }
      } catch (_) {}
      // ③ id
      var id = el.id;
      if (id) return ("#" + id + (cls ? "｜" + mark : "")).slice(0, 30);
      // ④ class だけ
      if (cls) return mark.slice(0, 24);
      // ⑤ タグだけ
      return tag.toLowerCase();
    } catch (_) { return null; }
  }
  /**
   * その要素**自身**の文字（子の文字は混ぜない）。ボタンの中の入れ子で
   * 「検索」ではなく「検索条件をすべてクリア」のような長い文字になるのを防ぐ。
   */
  function directText(el) {
    try {
      var t = "";
      var kids = el.childNodes || [];
      for (var i = 0; i < kids.length; i++) {
        if (kids[i].nodeType === 3) t += kids[i].nodeValue || "";
        if (t.replace(/\s+/g, "").length >= 12) break;
      }
      t = t.replace(/[\s\u3000]+/g, "");
      if (t) return t;
      // 自身の直下に文字が無ければ、全体の文字（短い時だけ）
      var all = String(el.textContent || "").replace(/[\s\u3000]+/g, "");
      return all.length <= 16 ? all : all.slice(0, 12);
    } catch (_) { return ""; }
  }

  /** 操作の種類（click / key / change / scroll） */
  /**
   * 2026-11-13 竹内さん「どこがダウンドロップでどこが入力する部分かなども学習できているかな」
   *
   *   要素が**どういう種類か**を覚える（純関数）。
   *   ・select   … プルダウン（開いて選ぶ）
   *   ・checkbox / radio … チェック（押して選ぶ）
   *   ・text     … 直接入力（打ち込む）
   *   ・button / link … 押すだけ
   *   ・other
   *   ⚠ これが分かると、自動モードで「プルダウンは開いて選ぶ」「入力欄は打つ」を
   *     人がやった通りに選べる（今までは名前だけで、種類を学んでいなかった）。
   */
  function kindOfEl(el) {
    if (!el) return "other";
    try {
      var tag = String(el.tagName || "").toUpperCase();
      var type = String((el.getAttribute && el.getAttribute("type")) || "").toLowerCase();
      if (tag === "SELECT") return "select";
      if (tag === "TEXTAREA") return "text";
      if (tag === "INPUT") {
        if (type === "checkbox") return "checkbox";
        if (type === "radio") return "radio";
        if (type === "submit" || type === "button" || type === "reset" || type === "image") return "button";
        if (type === "file") return "file";
        return "text";
      }
      if (tag === "BUTTON") return "button";
      if (tag === "A") return "link";
      if (tag === "LABEL") {
        // ラベルの中にチェックがある＝チェックの代わり
        try { if (el.querySelector && el.querySelector('input[type="checkbox"], input[type="radio"]')) return "checkbox"; } catch (_) {}
        return "link";
      }
      /**
       * 2026-11-14 竹内さん「途中で本来プルダウンなのにプルダウンと判断できていない部分や
       *   押すことができていないボタンはあったりするか」:
       *   ⚠ 実測で **`確定してリストへ｜span`（79回）と `左の検索｜span`（11回）が `other`** だった。
       *     リアプロのボタンは `<span>` / `<div>` で作られていて、`onclick` や `role` が付いている。
       *     `other` のままだと「押せる物」として扱えず、**押せたかの確認もできない**（＝止まる原因）。
       *   → **押せる印がある物は `button`** と判定する:
       *     ・`onclick` が付いている ・`role="button"` ・`cursor: pointer`
       *     ・class に search / btn / button / submit / next / confirm を含む
       */
      var _clickable = (function () {
        try {
          if (el.onclick) return true;
          if (String((el.getAttribute && el.getAttribute("role")) || "").toLowerCase() === "button") return true;
          var cls = String((el.className && typeof el.className === "string") ? el.className : "").toLowerCase();
          if (/(btn|button|submit|go_search|search|next|confirm|kakutei)/.test(cls)) return true;
          var st = null;
          try { st = (typeof getComputedStyle === "function") ? getComputedStyle(el) : null; } catch (_) { st = null; }
          if (st && String(st.cursor || "") === "pointer") return true;
        } catch (_) {}
        return false;
      })();
      if (_clickable) return "button";
      return "other";
    } catch (_) { return "other"; }
  }

  function kindOf(type) {
    if (type === "click") return "click";
    if (type === "keydown" || type === "key") return "key";
    if (type === "change" || type === "input") return "change";
    if (type === "scroll" || type === "wheel") return "scroll";
    return "other";
  }

  /**
   * 覚える器を作る（1ページに1つ）。
   * @param {{now?:()=>number, doc?:Document, win?:Window}} opt
   */
  function create(opts) {
    var o = opts || {};
    var now = typeof o.now === "function" ? o.now : function () { return Date.now(); };
    var D = o.doc || (typeof document !== "undefined" ? document : null);
    var W = o.win || (typeof window !== "undefined" ? window : null);
    var ops = [];
    var lastKind = null, lastAt = 0;
    // マウスの移動を1回としてまとめるための作業場所（点を貯めて、止まったら1件にする）
    var move = null;
    var moves = [];      // 1回の移動の記録（MAX_MOVES まで）
    var points = [];     // 押した場所（要素の中の割合・MAX_POINTS まで）
    var scrolls = [];    // 画面の動かし方（量と位置・MAX_SCROLLS まで）
    var opens = [];      // 押したら何が開いたか（2026-11-14・MAX_OPENS まで）
    var opAt = 0, opEl = null;    var vw = function () { try { return (W && W.innerWidth) || 1200; } catch (_) { return 1200; } };
    var vh = function () { try { return (W && W.innerHeight) || 800; } catch (_) { return 800; } };

    /**
     * 2026-11-11 竹内さん「ボタン物件検索でおすばしょ理解できたかな」:
     *   押した場所と要素の名前だけでは「**どの段階で**押したか」が分からない。
     *   例）「検索」ボタンは条件入力の最後に押す。物件の行は検索結果で押す。駅はモーダルの中で押す。
     *   → 記録の1件ごとに**段階**を付ける（見た目で分かる印だけを見る・サイトは触らない）。
     *     form   … 条件を入れている画面（検索の欄がある）
     *     modal  … 小窓（所在地・沿線の選択）が開いている
     *     result … 検索結果の一覧（物件の行がある）
     *     other  … どれでもない
     */
    function stageOf() {
      try {
        var d = D;
        if (!d || !d.querySelector) return "other";
        // 小窓が開いているか（リアプロは .this_window、ITANDI は role=dialog）
        if (d.querySelector(".this_window, [role='dialog'], .modal")) {
          var w = d.querySelector(".this_window, [role='dialog'], .modal");
          if (w && w.offsetParent !== null) return "modal";
        }
        // 検索結果の一覧か（物件の行がある）
        if (d.querySelector(".building_tr, .building_list, .property_list, [class*='building_tr']")) return "result";
        // 条件の欄があるか
        if (d.querySelector("select[name='rental_cost2'], input[name='city_code[]'], div.go_search, div.go_search_submit")) return "form";
        return "other";
      } catch (_) { return "other"; }
    }

    /** 1件覚える。間引きで捨てたら false */
    function record(type, el) {
      var k = kindOf(type);
      var t = now();
      if (k === lastKind && t - lastAt < SAME_KIND_MIN_MS) { lastAt = t; return false; }
      opAt = t; opEl = el || null;
      ops.push({ t: t, k: k, f: fieldName(el), s: stageOf() });
      if (ops.length > MAX_OPS) ops.shift();
      lastKind = k; lastAt = t;
      return true;
    }

    /**
     * 2026-11-14 竹内さん「ボタンなのかプルダウンなのか、どこで展開されるのかも意識して学習して改善する」:
     *   ⚠ 記録していたのは「押した要素の名前・種類・段階（form/modal/result）」だけ。
     *     **押したら何が開いたか（展開先）は学んでいなかった**。
     *     そのため自動モードでは「このボタンは小窓を開く」「このプルダウンは一覧が下に出る」
     *     が分からず、**開いた前提で次の値を探して空振り**していた。
     *   → 押した前後で画面がどう変わったかを**印だけ**で見て、展開先を残す:
     *     ・modal    … 小窓（.this_window / role=dialog）が出た／消えた
     *     ・options  … プルダウンの選択肢（option）が増えた
     *     ・form     … 条件の欄が増えた・減った
     *     ・result   … 結果の一覧に変わった
     *     ・none     … 目に見える変化が無い
     *   ⚠ 入力した中身（値）は見ない・残さない。数（option の数・欄の数）だけ。
     */
    function uiCounts() {
      var d = D;
      if (!d || !d.querySelectorAll) return { modal: 0, options: 0, form: 0, result: 0 };
      var vis = function (e) {
        try { return !!(e && (e.offsetParent !== null || (e.getClientRects && e.getClientRects().length))); } catch (_) { return false; }
      };
      var n = function (sel) { try { return d.querySelectorAll(sel).length; } catch (_) { return 0; } };
      var modals = 0;
      try {
        var ms = d.querySelectorAll(".this_window, [role='dialog'], .modal, .modal_wrap");
        for (var i = 0; i < ms.length; i++) if (vis(ms[i])) modals++;
      } catch (_) {}
      return {
        modal: modals,
        options: n("option"),
        form: n("select[name], input[name='city_code[]'], div.go_search, div.go_search_submit"),
        result: n(".building_tr, .building_list, .property_list, [class*='building_tr']"),
      };
    }
    /** 押す直前の画面の数（展開先を知るための控え） */
    var _beforeCounts = null;
    function noteBeforeClick(el) {
      try { _beforeCounts = uiCounts(); _beforeEl = el || null; } catch (_) { _beforeCounts = null; }
    }
    var _beforeEl = null;
    /**
     * 押した後に**何が開いたか**を1件残す。押してから 500ms 待ってから見る
     * （サイトは非同期で描くので、すぐ見ると「変化なし」に見える）。
     */
    function noteOpened(el) {
      try {
        if (!_beforeCounts) return;
        var b = _beforeCounts;
        var target = el || _beforeEl;
        _beforeCounts = null; _beforeEl = null;
        var a = uiCounts();
        var what = "none";
        if (a.modal > b.modal) what = "modal";
        else if (a.options > b.options + 2) what = "options";   // プルダウンの一覧が開いた
        else if (a.result > b.result) what = "result";
        else if (a.form !== b.form) what = "form";
        else if (a.modal < b.modal) what = "modal_close";       // 閉じた（確定など）
        opens.push({ f: fieldName(target), o: what, s: stageOf(), n: opens.length + 1 });
        if (opens.length > MAX_OPENS) opens.shift();
      } catch (_) {}
    }

    /**
     * 押した場所（要素の中のどこか）を0〜1の割合で覚える。
     *   人が「真ん中ではなく左寄り・上の方」を押す癖を測るため。要素が取れない時は覚えない。
     */
  function recordPoint(e) {
    try {
      var el = e && e.target;
      if (!el || !el.getBoundingClientRect) return;
      var r = el.getBoundingClientRect();
      if (!(r.width > 0 && r.height > 0)) return;
      /**
       * 2026-11-14 竹内さん「家賃のプルダウンの部分のマウスのうごきとクリックして選択する動き
       *   徒歩の部分プルダウンで選択してそのままにしているうごき
       *   更新日のプルダウンをマウスで動かしてクリックするうごき
       *   次へを押す場所もちゃんと把握するようにする」
       *
       *   ⚠ **押した順番が1件も取れていなかった**（実測: `field_order` が2手以上の物が0件）。
       *     名前（`point_fields`）は21種類あるのに順番は0件。原因は**ここ**:
       *       拡張が `el.click()` で押すと `clientX`/`clientY` が **0** になる。
       *       → `fx = (0 - r.left) / r.width` が大きくマイナス → 「枠の外」で**捨てていた**。
       *     そのため自動モード・AIXの押下は**1つも記録されず**、順番が学べなかった。
       *
       *   → ① 座標が**要素の中**なら今まで通りその位置（人が押した時）
       *     ② 座標が **0,0**（＝`el.click()` の合成クリック）なら**要素の真ん中**として記録する
       *        ⚠ 「どこを押したか」は人の時だけ正確。合成の時は真ん中（推測）と分かるように `syn:true` を付ける。
       *     ③ それ以外（明らかに枠の外）は今まで通り捨てる
       */
      var _syn = (Number(e.clientX) === 0 && Number(e.clientY) === 0);
      var fx = _syn ? 0.5 : (e.clientX - r.left) / r.width;
      var fy = _syn ? 0.5 : (e.clientY - r.top) / r.height;
      if (!_syn && !(fx >= -0.2 && fx <= 1.2 && fy >= -0.2 && fy <= 1.2)) return; // 枠の外（別の要素の上）は捨てる
      points.push({
        f: fieldName(el),
        x: Math.round(Math.max(0, Math.min(1, fx)) * 100) / 100,
        y: Math.round(Math.max(0, Math.min(1, fy)) * 100) / 100,
        w: Math.round(r.width), h: Math.round(r.height),
        s: stageOf(),   // 2026-11-11: どの段階で押したか（form/modal/result）
        /**
         * 2026-11-14 竹内さん「実際の通常モードでの検索のデータと比べてのギャップを強化」:
         *   ⚠ `point_fields` には**時刻も順番も無かった**ので、写真（`shot_ops`）が無い記録
         *     （＝通常モードのほとんど）では**押す順番を学べなかった**
         *     （実測: normal 34件あるのに「順番0・画面0」）。
         *   → **この記録の中での通し番号（n）**を残す。同じ記録の中の順番が分かる。
         */
        n: points.length + 1,
        /**
         * 2026-11-13 竹内さん「どこがダウンドロップでどこが入力する部分か」:
         *   要素の種類（select/checkbox/text/button/link）も残す。
         *   ⚠ `w` は**幅**で使っているので、種類は `wk` にする（取り違えない）。
         */
        wk: kindOfEl(el),
        /** 2026-11-14: `el.click()` の合成クリック（座標0,0）で記録した＝位置は真ん中（推測） */
        syn: _syn || undefined,
      });
        if (points.length > MAX_POINTS) points.shift();
      } catch (_) {}
    }

    /** スクロール（画面の動かし方）。量と、動かした後のページ内の位置（％）を覚える */
    function recordScroll(dy, pageY, pageH, viewH) {
      try {
        if (!dy) return;
        scrolls.push({
          dy: Math.round(dy),
          dir: dy > 0 ? "down" : "up",
          // ページ全体のどこに居るか（0＝一番上・1＝一番下）
          y: (pageH > viewH) ? Math.round(Math.max(0, Math.min(1, pageY / (pageH - viewH))) * 100) / 100 : 0,
        });
        if (scrolls.length > MAX_SCROLLS) scrolls.shift();
      } catch (_) {}
    }

    /**
     * マウスの動きを1点ぶん覚える（mousemove のたびに呼ぶ）。
     *   押していない時の動きと、押しながらの動き（ドラッグ）を区別する。
     *   指を止めて 350ms 経ったら「1回の移動」として締める。
     */
    function recordMove(x, y, buttons, t) {
      try {
        var tt = typeof t === "number" ? t : now();
        if (!move || tt - move.lastAt > MOVE_GAP_MS) {
          closeMove(); // 前の移動を締める
          move = { t0: tt, lastAt: tt, pts: [], drag: !!buttons };
        }
        move.lastAt = tt;
        if (buttons) move.drag = true;
        // 点は最大 MOVE_SAMPLES 個（間引いて残す＝形が分かる程度）
        if (move.pts.length < MAX_MOVE_PTS) move.pts.push({ x: Math.round(x), y: Math.round(y), t: tt, b: buttons ? 1 : 0 });
      } catch (_) {}
    }

    /** 貯めていた移動を1件に締める（距離・時間・速さ・曲がり・形） */
    function closeMove() {
      if (!move || move.pts.length < 2) { move = null; return; }
      var pts = move.pts;
      var a = pts[0], b = pts[pts.length - 1];
      var dist = 0, maxSeg = 0;
      for (var i = 1; i < pts.length; i++) {
        var d = Math.hypot(pts[i].x - pts[i - 1].x, pts[i].y - pts[i - 1].y);
        dist += d;
        if (d > maxSeg) maxSeg = d;
      }
      var ms = Math.max(1, b.t - a.t);
      var straight = Math.hypot(b.x - a.x, b.y - a.y);
      moves.push({
        ms: Math.round(ms),
        dist: Math.round(dist),
        // 速さ（px/秒）。遅い動き・速い動きの目安
        px_s: Math.round(dist / (ms / 1000)),
        peak_px_s: Math.round(maxSeg / (ms / 1000)), // 一番速かった瞬間の目安
        // 曲がり具合: 実際に動いた距離 ÷ まっすぐの距離（1.0＝まっすぐ・大きいほど曲がる）
        curve: straight > 6 ? Math.round((dist / straight) * 100) / 100 : null,
        from: { x: Math.round((a.x / vw()) * 100) / 100, y: Math.round((a.y / vh()) * 100) / 100 },
        to: { x: Math.round((b.x / vw()) * 100) / 100, y: Math.round((b.y / vh()) * 100) / 100 },
        drag: !!move.drag,
        // 形（画面の％・最大8点）＝どう曲がったか
        shape: shapeOf(pts),
      });
      if (moves.length > MAX_MOVES) moves.shift();
      move = null;
    }

    /** 軌跡の点を最大8個に間引いて、画面の％で返す */
    function shapeOf(pts) {
      var n = Math.min(MAX_MOVE_PTS, 8);
      var out = [];
      if (pts.length <= n) {
        for (var i = 0; i < pts.length; i++) out.push([Math.round((pts[i].x / vw()) * 100) / 100, Math.round((pts[i].y / vh()) * 100) / 100]);
        return out;
      }
      for (var j = 0; j < n; j++) {
        var idx = Math.round((j / (n - 1)) * (pts.length - 1));
        out.push([Math.round((pts[Math.min(idx, pts.length - 1)].x / vw()) * 100) / 100, Math.round((pts[Math.min(idx, pts.length - 1)].y / vh()) * 100) / 100]);
      }
      return out;
    }

    /** 画面（document）に付ける。戻り値は外す関数 */
    function attach(doc, win) {      var d = doc || D;
      var w = win || W;
      if (!d || !d.addEventListener) return function () {};
      /**
       * 2026-11-11 竹内さん「画面の動き方もちゃんと把握できているのかな録画のような形で」:
       *   操作のたびに**画面の写真を1枚**撮れるよう、`onOp(kind, el, pt)` を呼ぶ口を作った。
       *   呼ぶ側（human-learn-record.js）が写真を撮る。無ければ何もしない（学習だけ続く）。
       */
      var onOp = typeof o.onOp === "function" ? o.onOp : null;
      var pointOf = function (e) {
        try {
          var el = e && e.target;
          if (!el || !el.getBoundingClientRect) return null;
          var r = el.getBoundingClientRect();
          if (!(r.width > 0 && r.height > 0)) return null;
          return { x: e.clientX, y: e.clientY, fx: (e.clientX - r.left) / r.width, fy: (e.clientY - r.top) / r.height };
        } catch (_) { return null; }
      };
      var guarded = function (type) {
        return function (e) {
          // 人が起こした物だけ（拡張が dispatch した物は数えない＝学習を汚さない）
          if (!e || !e.isTrusted) return;
          /**
           * 2026-11-14 竹内さん「ちゃんと学習できるように」:
           *   ⚠ **AIXLINX 自身の小窓（バー・ミニボタン・案内）を押した記録も学習に混ざっていた**
           *     （実測: `左のAIXLINX｜div`・`#axlx-bar`・`#aixlinx-mini-btn`・`div.search_menu` の誤爆）。
           *     自分の UI は「サイトの操作」ではないので、順番・押す位置・展開先を濁らせる。
           *   → 拡張が作った要素（`#axlx-` / `[data-axlx]` / `#aixlinx-`）は**記録しない**。
           */
          try {
            var _t = e.target;
            if (_t && (_t.closest
              ? _t.closest('#axlx-bar, #axlx-learn-badge, #aixlinx-mini-btn, #axlx-guide, [data-axlx], [id^="axlx-"], [id^="aixlinx-"], [class^="axlx-"]')
              : (String(_t.id || "").indexOf("axlx") === 0 || String(_t.id || "").indexOf("aixlinx") === 0))) return;
          } catch (_) {}
          /**
           * 2026-11-14 竹内さん「どこで展開されるのかも意識して学習して改善する」:
           *   押す**直前**の画面の数（小窓・選択肢・欄・結果）を控えておき、
           *   押した**後**に何が増えたかで「展開先」を学ぶ。
           *   ⚠ 見るのは数の変化だけ（入力した中身は見ない）。
           */
          if (type === "click") { try { noteBeforeClick(e.target); } catch (_) {} }
          var added = record(type, e.target);
          var pt = null;
          if (type === "click") {
            recordPoint(e); pt = pointOf(e); // ボタンのどこを押したか
            // 押した後に何が開いたか（サイトが描くのを待ってから見る）
            var _tgt = e.target;
            setTimeout(function () { try { noteOpened(_tgt); } catch (_) {} }, 520 + Math.floor(Math.random() * 260));
          }
          // 間引かれた操作では撮らない（同じ所を連打しても写真は増やさない）
          if (added && onOp) { try { onOp(type, e.target, pt); } catch (_) {} }
        };
      };
      var hClick = guarded("click");
      var hKey = guarded("keydown");
      var hChange = guarded("change");
      var hWheel = function (e) {
        if (!e || !e.isTrusted) return;
        var added = record("wheel", null);
        // 画面の動かし方（1回の量と、その時のページ内の位置）
        try {
          var p = (w && w.pageYOffset) || 0;
          var ph = (d.documentElement && d.documentElement.scrollHeight) || 0;
          var vhh = (w && w.innerHeight) || 800;
          recordScroll(e.deltaY, p, ph, vhh);
        } catch (_) {}
        // 2026-11-11: スクロールも「画面の動き方」なので、その後の画面を1枚撮る
        if (added && onOp) { try { onOp("wheel", null, null); } catch (_) {} }
      };
      var hMove = function (e) {
        if (!e || !e.isTrusted) return;
        // 押していない時の動きと、押しながらの動き（ドラッグ）を区別して覚える
        recordMove(e.clientX, e.clientY, e.buttons, now());
      };
      var hScroll = function () {
        // ホイール以外（キー・バー・指）でも位置だけ覚える（量は分からないので 0＝位置だけ）
        try {
          if (!w) return;
          var p = w.pageYOffset || 0;
          var ph = (d.documentElement && d.documentElement.scrollHeight) || 0;
          var vhh = w.innerHeight || 800;
          if (ph > vhh) {
            var y = Math.round(Math.max(0, Math.min(1, p / (ph - vhh))) * 100) / 100;
            if (scrolls.length === 0 || scrolls[scrolls.length - 1].y !== y) {
              scrolls.push({ dy: 0, dir: null, y: y });
              if (scrolls.length > MAX_SCROLLS) scrolls.shift();
            }
          }
        } catch (_) {}
      };
      var on = function (type, fn, opt) { try { d.addEventListener(type, fn, opt || true); } catch (_) {} };
      on("click", hClick);
      on("keydown", hKey);
      on("change", hChange);
      on("mousemove", hMove, { passive: true, capture: true });
      try { if (w && w.addEventListener) w.addEventListener("wheel", hWheel, { passive: true, capture: true }); } catch (_) {}
      try { if (w && w.addEventListener) w.addEventListener("scroll", hScroll, { passive: true }); } catch (_) {}
      return function detach() {
        try {
          d.removeEventListener("click", hClick, true);
          d.removeEventListener("keydown", hKey, true);
          d.removeEventListener("change", hChange, true);
          d.removeEventListener("mousemove", hMove, true);
        } catch (_) {}
        try { if (w) { w.removeEventListener("wheel", hWheel, true); w.removeEventListener("scroll", hScroll); } } catch (_) {}
        closeMove(); // 残っている移動を締める
      };
    }

    function list() { return ops.slice(); }
    function count() { return ops.length; }
    /** 貯めた動き・押した場所・スクロール（読み出し用。締め忘れを締めてから返す） */
    function detail() {
      closeMove();
      return { moves: moves.slice(), points: points.slice(), scrolls: scrolls.slice(), opens: opens.slice() };
    }
    function reset() {
      ops = []; lastKind = null; lastAt = 0; move = null;
      moves = []; points = []; scrolls = []; opens = [];
    }

    return { attach: attach, record: record, recordPoint: recordPoint, recordMove: recordMove, recordScroll: recordScroll,
             noteBeforeClick: noteBeforeClick, noteOpened: noteOpened,
             closeMove: closeMove, list: list, count: count, detail: detail, reset: reset };
  }

  /** 中央値（空なら null） */
  function median(arr) {
    if (!arr || !arr.length) return null;
    var a = arr.slice().sort(function (x, y) { return x - y; });
    var m = Math.floor(a.length / 2);
    return a.length % 2 ? a[m] : Math.round((a[m - 1] + a[m]) / 2);
  }

  /**
   * 2026-11-11: 小数を保つ中央値（曲がり具合・押した位置の割合など）。
   *   ⚠ `median` は整数に丸めるので、1.2 が 1 に・0.25 が 0 に潰れる（実測が消える）。
   *   小数第2位まで残す。
   */
  function medianF(arr) {
    if (!arr || !arr.length) return null;
    var a = arr.slice().sort(function (x, y) { return x - y; });
    var m = Math.floor(a.length / 2);
    var v = a.length % 2 ? a[m] : (a[m - 1] + a[m]) / 2;
    return Math.round(v * 100) / 100;
  }

  /**
   * 覚えた操作を集計する（純関数）。
   * @returns {{n:number, kinds:Object, gap_ms:number|null, gaps:number[], fields:string[], order:string[]}}
   */
  function summarize(ops) {
    var list = Array.isArray(ops) ? ops : [];
    var kinds = {};
    var gaps = [];
    var fields = [];
    var order = [];
    for (var i = 0; i < list.length; i++) {
      var op = list[i] || {};
      var k = op.k || "other";
      kinds[k] = (kinds[k] || 0) + 1;
      if (op.f) {
        if (fields.indexOf(op.f) < 0 && fields.length < MAX_FIELDS) fields.push(op.f);
        if (order.length < MAX_FIELDS) order.push(op.f);
      }
      if (i > 0 && typeof op.t === "number" && typeof list[i - 1].t === "number") {
        var g = op.t - list[i - 1].t;
        if (g >= 0 && g <= 120000) gaps.push(g); // 2分超えは「離席」なので間の見本に入れない
      }
    }
    var sample = gaps.length > MAX_GAPS ? gaps.slice(-MAX_GAPS) : gaps;
    return { n: list.length, kinds: kinds, gap_ms: median(gaps), gaps: sample, fields: fields, order: order };
  }

  /**
   * 2026-11-11 竹内さん「マウスの動かし方やボタンのどこ押すか、画面のうごかしかたも」:
   *   動き（moves）・押した場所（points）・画面の動かし方（scrolls）を集計する（純関数）。
   *   残すのは**傾向**（中央値など）と**見本**（形・押した割合）。
   * @returns {{moves:Object, points:Object, scrolls:Object}}
   */
  /**
   * 2026-11-14 竹内さん「どこで展開されるのかも意識して学習して改善する」:
   *   **押したら何が開いたか**を、欄ごとにまとめる（純関数）。
   *   @returns {{byField:Object, kinds:Object, n:number}}
   *     byField … `{ "左の所在地絞り込み＋｜span": { opens: "modal", n: 3 } }`
   *     kinds   … `{ modal: 3, options: 5, none: 2 }`（全体の内訳）
   *   ⚠ 入れるのは「開いた物の種類」だけ（中身・文字は入れない）。
   */
  function _opensOf(list) {
    var arr = Array.isArray(list) ? list : [];
    var byField = {}, kinds = {}, n = 0;
    arr.forEach(function (o) {
      if (!o) return;
      var f = String(o.f || "").slice(0, 30);
      var k = String(o.o || "none");
      if (!f) return;
      n++;
      kinds[k] = (kinds[k] || 0) + 1;
      var cur = byField[f] || { n: 0, opens: {}, stage: null };
      cur.n++;
      cur.opens[k] = (cur.opens[k] || 0) + 1;
      if (o.s) cur.stage = String(o.s);
      byField[f] = cur;
    });
    // 欄ごとに「一番多かった開き方」を残す（迷わない形に）
    var out = {};
    Object.keys(byField).slice(0, 40).forEach(function (f) {
      var v = byField[f], best = null, bn = -1;
      Object.keys(v.opens).forEach(function (k) { if (v.opens[k] > bn) { best = k; bn = v.opens[k]; } });
      out[f] = { opens: best, n: v.n, stage: v.stage, all: v.opens };
    });
    return { byField: out, kinds: kinds, n: n };
  }

  function summarizeMotion(detail) {
    var d = detail && typeof detail === "object" ? detail : {};
    var mv = Array.isArray(d.moves) ? d.moves : [];
    var pt = Array.isArray(d.points) ? d.points : [];
    var sc = Array.isArray(d.scrolls) ? d.scrolls : [];
    // ── マウスの動かし方 ──
    var speeds = [], curves = [], durs = [], dists = [];
    var drags = 0, shapes = [];
    mv.forEach(function (m) {
      if (!m) return;
      if (typeof m.px_s === "number") speeds.push(m.px_s);
      if (typeof m.curve === "number") curves.push(m.curve);
      if (typeof m.ms === "number") durs.push(m.ms);
      if (typeof m.dist === "number") dists.push(m.dist);
      if (m.drag) drags++;
      if (Array.isArray(m.shape) && m.shape.length >= 2 && shapes.length < 6) shapes.push(m.shape);
    });
    var moves = {
      n: mv.length,
      drag_n: drags,
      speed_px_s: median(speeds),          // ふだんの速さ
      curve: medianF(curves),              // 曲がり具合（1.0＝まっすぐ）※小数を保つ
      ms: median(durs),                    // 1回の移動にかける時間
      dist: median(dists),                 // 1回の距離（px）
      shapes: shapes,                      // どう曲がったかの見本（画面の％・最大6本）
    };

    // ── ボタンのどこを押したか ──
    var xs = [], ys = [], byField = {};
    /**
     * 2026-11-14 竹内さん「実際の通常モードでの検索のデータと比べてのギャップを強化」:
     *   **押した順番**（この記録の中での並び）を残す。写真が無い記録でも順番を学べるようにする。
     *   `order` は重複を畳んだ「初めて押した順」（同じ欄の2回目は入れない）。
     */
    var order = [];
    pt.forEach(function (p) {
      if (!p || typeof p.x !== "number" || typeof p.y !== "number") return;
      xs.push(p.x); ys.push(p.y);
      var f = p.f || "?";
      if (order.indexOf(f) < 0) order.push(f);
      if (!byField[f]) byField[f] = { n: 0, xs: [], ys: [], stages: {}, w: {} };
      byField[f].n++;
      // 2026-11-13 竹内さん「どこがダウンドロップでどこが入力する部分か」: 要素の種類も数える
      var w = p.wk || "other";
      byField[f].w[w] = (byField[f].w[w] || 0) + 1;
      // 2026-11-11: どの段階で押したかも数える（form/modal/result）
      var sg = p.s || "other";
      byField[f].stages[sg] = (byField[f].stages[sg] || 0) + 1;
      if (byField[f].xs.length < 20) { byField[f].xs.push(p.x); byField[f].ys.push(p.y); }
    });
    var fieldSpread = {};
    Object.keys(byField).slice(0, 20).forEach(function (f) {
      fieldSpread[f] = { n: byField[f].n, x: medianF(byField[f].xs), y: medianF(byField[f].ys) };
      // 一番多かった段階（この要素をどの場面で押すか）
      var st = byField[f].stages, best = null, bestN = -1;
      Object.keys(st).forEach(function (k) { if (st[k] > bestN) { best = k; bestN = st[k]; } });
      if (best) fieldSpread[f].stage = best;
      // 2026-11-13: 要素の種類（select/checkbox/text/button など）＝**どう扱う欄か**
      var ww = byField[f].w, bw = null, bwn = -1;
      Object.keys(ww).forEach(function (k) { if (ww[k] > bwn) { bw = k; bwn = ww[k]; } });
      if (bw) fieldSpread[f].w = bw;
    });
    var points = {
      n: pt.length,
      x: medianF(xs),                      // ふだんは横のどこを押すか（0＝左端・0.5＝真ん中）
      y: medianF(ys),                      // 縦のどこか（0＝上端・0.5＝真ん中）
      fields: fieldSpread,                 // 欄ごとの癖
      /**
       * 2026-11-14: **押した順番**（初めて押した順・重複なし）。
       *   写真（shot_ops）が無い記録でも「順番」を学べるようにする。
       */
      order: order.slice(0, 40),
    };

    // ── 画面の動かし方 ──
    var dys = [], ysPos = [], downs = 0, ups = 0;
    sc.forEach(function (s) {
      if (!s) return;
      if (typeof s.dy === "number" && s.dy !== 0) { dys.push(Math.abs(s.dy)); if (s.dy > 0) downs++; else ups++; }
      if (typeof s.y === "number") ysPos.push(s.y);
    });
    var scrolls = {
      n: sc.length,
      dy: median(dys),                     // 1回に動かす量
      down: downs, up: ups,
      y: medianF(ysPos),                   // よく居るページ内の位置（0＝上・1＝下）※小数を保つ
      y_samples: ysPos.slice(-20),         // どこまで送ってから押すか の見本
    };

    return { moves: moves, points: points, scrolls: scrolls, opens: _opensOf(d.opens) };
  }

  /** 数の中央値を前の値と合わせる（見本の配列をまとめて中央値を出し直す） */
  function _mergeArr(prev, add, cap) {
    var out = (Array.isArray(prev) ? prev : []).concat(Array.isArray(add) ? add : []);
    if (cap && out.length > cap) out = out.slice(-cap);
    return out;
  }

  /**
   * 動きの集計を前と合わせる（純関数）。見本（shapes・y_samples・欄ごと）は新しい方を優先して足す。
   */
  function mergeMotion(prev, add) {
    var p = prev && typeof prev === "object" ? prev : {};
    var a = add && typeof add === "object" ? add : {};
    var pm = p.moves || {}, am = a.moves || {};
    var pp = p.points || {}, ap = a.points || {};
    var psc = p.scrolls || {}, asc = a.scrolls || {};

    // 中央値は「前の中央値」と「今の中央値」を回数で重み付けして寄せる（見本を全部持ち回らないため）
    //   ⚠ 1.2 のような小数を潰さないこと（曲がり具合・押した位置の割合）
    var blend = function (pv, av, pn, an) {
      var hasP = typeof pv === "number", hasA = typeof av === "number";
      if (hasP && hasA) {
        var wp = Math.max(1, Number(pn) || 1), wa = Math.max(1, Number(an) || 1);
        return Math.round(((pv * wp + av * wa) / (wp + wa)) * 100) / 100;
      }
      return hasA ? av : (hasP ? pv : null);
    };

    var fieldSpread = {};
    var pf = pp.fields || {}, af = ap.fields || {};
    Object.keys(af).forEach(function (f) {
      var pre = pf[f] || null;
      fieldSpread[f] = pre ? { n: (Number(pre.n) || 0) + (Number(af[f].n) || 0), x: blend(pre.x, af[f].x, pre.n, af[f].n), y: blend(pre.y, af[f].y, pre.n, af[f].n), ...(pre.w || af[f].w ? { w: af[f].w || pre.w } : {}), ...(pre.stage || af[f].stage ? { stage: af[f].stage || pre.stage } : {}) } : af[f];
    });
    Object.keys(pf).forEach(function (f) {
      if (!fieldSpread[f] && Object.keys(fieldSpread).length < 20) fieldSpread[f] = pf[f];
    });

    return {
      moves: {
        n: (Number(pm.n) || 0) + (Number(am.n) || 0),
        drag_n: (Number(pm.drag_n) || 0) + (Number(am.drag_n) || 0),
        speed_px_s: blend(pm.speed_px_s, am.speed_px_s, pm.n, am.n),
        curve: (typeof pm.curve === "number" && typeof am.curve === "number")
          ? Math.round(((pm.curve * Math.max(1, pm.n || 1) + am.curve * Math.max(1, am.n || 1)) / (Math.max(1, pm.n || 1) + Math.max(1, am.n || 1))) * 100) / 100
          : (typeof am.curve === "number" ? am.curve : (typeof pm.curve === "number" ? pm.curve : null)),        ms: blend(pm.ms, am.ms, pm.n, am.n),
        dist: blend(pm.dist, am.dist, pm.n, am.n),
        shapes: _mergeArr(pm.shapes, am.shapes, 6),
      },
      points: {
        n: (Number(pp.n) || 0) + (Number(ap.n) || 0),
        x: blend(pp.x, ap.x, pp.n, ap.n),
        y: blend(pp.y, ap.y, pp.n, ap.n),
        fields: fieldSpread,
      },
      scrolls: {
        n: (Number(psc.n) || 0) + (Number(asc.n) || 0),
        dy: blend(psc.dy, asc.dy, psc.n, asc.n),
        down: (Number(psc.down) || 0) + (Number(asc.down) || 0),
        up: (Number(psc.up) || 0) + (Number(asc.up) || 0),
        y: blend(psc.y, asc.y, psc.n, asc.n),
        y_samples: _mergeArr(psc.y_samples, asc.y_samples, 20),
      },
    };
  }

  /**
   * 前の集計と今の集計を1つに（純関数・元は変えない）。
   *   回数は足す・間の見本は新しい物を残して上限まで・欄の順は新しい回を先に。
   */
  function mergeAggregate(prev, add) {
    var p = prev && typeof prev === "object" ? prev : {};
    var a = add && typeof add === "object" ? add : {};
    var kinds = {};
    var pk = p.kinds || {}, ak = a.kinds || {};
    Object.keys(pk).forEach(function (k) { kinds[k] = (kinds[k] || 0) + (Number(pk[k]) || 0); });
    Object.keys(ak).forEach(function (k) { kinds[k] = (kinds[k] || 0) + (Number(ak[k]) || 0); });
    var gaps = (Array.isArray(p.gaps) ? p.gaps : []).concat(Array.isArray(a.gaps) ? a.gaps : []);
    if (gaps.length > MAX_GAPS) gaps = gaps.slice(-MAX_GAPS);
    var fields = (Array.isArray(a.fields) ? a.fields : []).slice();
    (Array.isArray(p.fields) ? p.fields : []).forEach(function (f) {
      if (fields.indexOf(f) < 0 && fields.length < MAX_FIELDS) fields.push(f);
    });
    var order = (Array.isArray(a.order) ? a.order : []).slice(0, MAX_FIELDS);
    // 2026-11-11: マウスの動かし方・押した場所・画面の動かし方も合わせる
    var motion = mergeMotion({ moves: p.moves, points: p.points, scrolls: p.scrolls },
                             { moves: a.moves, points: a.points, scrolls: a.scrolls });
    return {
      v: 1,
      n: (Number(p.n) || 0) + (Number(a.n) || 0),
      sessions: (Number(p.sessions) || 0) + 1,
      kinds: kinds,
      gaps: gaps,
      gap_ms: median(gaps),
      fields: fields,
      order: order,
      moves: motion.moves,
      points: motion.points,
      scrolls: motion.scrolls,
    };
  }

  /** 集計から「前より人の間が測れたか」を1行で（点検・画面に出す用） */
  function reportLine(agg) {
    if (!agg || !agg.n) return "まだ人の動きを覚えていません（通常モードで操作すると貯まります）";
    var g = agg.gap_ms == null ? "?" : Math.round(agg.gap_ms);
    var s = "人の動き: " + agg.n + "回・" + (agg.sessions || 0) + "回分／操作の間 約" + g + "ms";
    // 2026-11-11: マウスの動かし方・ボタンのどこ・画面の動かし方も1行に足す
    var mv = agg.moves, pt = agg.points, sc = agg.scrolls;
    if (mv && mv.n) s += "／マウス " + mv.n + "回分（速さ 約" + (mv.speed_px_s || "?") + "px/s・曲がり" + (mv.curve || "?") + "）";
    if (pt && pt.n) s += "／押した所 横" + (pt.x == null ? "?" : pt.x) + "・縦" + (pt.y == null ? "?" : pt.y);
    if (sc && sc.n) s += "／スクロール " + sc.n + "回（1回 約" + (sc.dy == null ? "?" : sc.dy) + "px）";
    return s;
  }

  /** 貯めた物の中身を人に見せる1行ずつ（確認用） */
  function describe(agg) {
    var out = [];
    if (!agg) return ["まだ何も貯まっていません"];
    var mv = agg.moves || {}, pt = agg.points || {}, sc = agg.scrolls || {};
    if (mv.n) {
      out.push("マウス: " + mv.n + "回分を覚えました");
      out.push("  ふだんの速さ 約" + (mv.speed_px_s || "?") + "px/秒・1回にかける時間 約" + (mv.ms || "?") + "ms・距離 約" + (mv.dist || "?") + "px");
      out.push("  まっすぐ具合 " + (mv.curve || "?") + "（1.00に近いほどまっすぐ・大きいほど曲がる）" + (mv.drag_n ? "・押しながら動かした回 " + mv.drag_n : ""));
    } else out.push("マウス: まだ");
    if (pt.n) out.push("押した場所: " + pt.n + "回分／ふだんは横 " + (pt.x == null ? "?" : pt.x) + "・縦 " + (pt.y == null ? "?" : pt.y) + "（0＝左/上端・0.5＝真ん中）");
    else out.push("押した場所: まだ");
    if (sc.n) out.push("画面の動かし方: " + sc.n + "回分／1回 約" + (sc.dy == null ? "?" : sc.dy) + "px（下へ " + (sc.down || 0) + "・上へ " + (sc.up || 0) + "）");
    else out.push("画面の動かし方: まだ");
    return out;
  }

  /**
   * 2026-11-11 竹内さん「通常モードの動きから学ぶのか」「これで画面から動き把握できるようになったてことかな？」
   *   貯めた実測（`axlx_human_learn`）から、**自動モードの動きに使う値**を作る（純関数）。
   *
   *   何を学ぶか:
   *     ・速さ（px/秒）        → カーソルを動かす時間を実測に合わせる
   *     ・曲がり具合（1.0〜）  → 軌跡の曲げ方を実測に合わせる
   *     ・押した位置（0〜1）   → ボタンのどこを狙うかを実測に合わせる
   *     ・スクロール量（px）   → 一度に送る量を実測に合わせる
   *
   *   ⚠ 実測が無い・少なすぎる時は **null を返す**（呼ぶ側は今まで通りの値を使う＝急に動きが変わらない）。
   *   ⚠ 極端な値は丸める（速すぎ・遅すぎ・端すぎで不自然にならないように）。
   *
   * @param {Object} agg  axlx_human_learn の中身
   * @param {{minMoves?:number, minPoints?:number, minScrolls?:number}} opt
   * @returns {{speed_px_s:number, curve:number, aim:{x:number,y:number}, scroll_dy:number|null,
   *            sample:{moves:number, points:number, scrolls:number}, at:number}|null}
   */
  function profileFrom(agg, opt) {
    var o = opt || {};
    var minMoves = o.minMoves == null ? 3 : o.minMoves;
    var minPoints = o.minPoints == null ? 3 : o.minPoints;
    var minScrolls = o.minScrolls == null ? 2 : o.minScrolls;
    if (!agg || typeof agg !== "object") return null;
    var mv = agg.moves || {}, pt = agg.points || {}, sc = agg.scrolls || {};

    // 速さ: 100〜4000px/秒の範囲に丸める（人が見て自然な範囲）
    var sp = typeof mv.speed_px_s === "number" && mv.speed_px_s > 0 ? mv.speed_px_s : null;
    if (sp != null) sp = Math.max(100, Math.min(4000, Math.round(sp)));
    // 曲がり: 1.0〜2.0（1.0＝まっすぐ）。実測が 1.0 未満（誤差）は 1.0 に
    var cv = typeof mv.curve === "number" && mv.curve >= 1 ? mv.curve : null;
    if (cv != null) cv = Math.round(Math.max(1, Math.min(2, cv)) * 100) / 100;
    // 押す位置: 0.5〜0.5 を中心に 0.2〜0.8 に丸める（端すぎる所は押さない＝押し間違いを防ぐ）
    var ax = typeof pt.x === "number" ? Math.max(0.2, Math.min(0.8, pt.x)) : null;
    var ay = typeof pt.y === "number" ? Math.max(0.2, Math.min(0.8, pt.y)) : null;
    // スクロール量: 50〜1500px に丸める
    var sd = typeof sc.dy === "number" && sc.dy > 0 ? Math.max(50, Math.min(1500, Math.round(sc.dy))) : null;

    var enoughMoves = (Number(mv.n) || 0) >= minMoves;
    var enoughPoints = (Number(pt.n) || 0) >= minPoints;
    var enoughScrolls = (Number(sc.n) || 0) >= minScrolls;

    if (!enoughMoves && !enoughPoints && !enoughScrolls) return null; // 材料が足りない＝今まで通り
    return {
      speed_px_s: enoughMoves ? sp : null,
      curve: enoughMoves ? cv : null,
      aim: (enoughPoints && ax != null && ay != null) ? { x: Math.round(ax * 100) / 100, y: Math.round(ay * 100) / 100 } : null,
      scroll_dy: enoughScrolls ? sd : null,
      sample: { moves: Number(mv.n) || 0, points: Number(pt.n) || 0, scrolls: Number(sc.n) || 0 },
      at: Number(agg.at) || 0,
    };
  }

  /**
   * 2026-11-13 竹内さん「ほかにちゃんと学習の面とかで連携できていない部分などあるか」:
   *   ⚠ サーバー（学習担当のブレイン）は `motion`（速さ565px/秒・曲がり1.04・操作の間 中央値524ms）を
   *     計算して返しているのに、拡張は**ローカルの癖（axlx_human_profile）だけ**を使っていた
   *     ＝ 他の PC で貯まった分・写真から学んだ分が**現場に届いていなかった**。
   *   → サーバーの motion を**先に**見る（無ければ今まで通りローカルの癖）。
   *     ⚠ 丸めは同じ（120〜1600ms）。極端な値で飛ばない・止まらないようにする。
   */
  var _srvMotion = null;
  var _srvMotionAt = 0;
  function _serverMotion() {
    var now = Date.now();
    if (_srvMotion && now - _srvMotionAt < 60000) return _srvMotion;
    _srvMotionAt = now;
    try {
      if (typeof chrome === "undefined" || !chrome.storage || !chrome.storage.local) return _srvMotion;
      chrome.storage.local.get(["axlx_learn_motion"], function (r) {
        try {
          var m = (r && r.axlx_learn_motion) || null;
          _srvMotion = (m && typeof m === "object") ? m : {};
        } catch (_) { _srvMotion = {}; }
      });
    } catch (_) {}
    return _srvMotion;
  }

  /** プロファイルから「この距離を動く時間」を出す（実測の速さ・無ければ null） */
  function moveMsFor(profile, dist) {
    if (!(dist > 0)) return null;
    // ① サーバーで学んだ速さ（他の PC の分も入っている）を先に見る
    var srv = _serverMotion();
    var srvSpeed = srv && typeof srv.speed_px_s === "number" ? srv.speed_px_s : null;
    if (srvSpeed && srvSpeed > 0) {
      return Math.max(120, Math.min(1600, Math.round((dist / srvSpeed) * 1000)));
    }
    // ② 無ければ手元の実測
    if (!profile || typeof profile.speed_px_s !== "number") return null;
    /**
     * 2026-11-13: ⚠ 速さが 0 以下だと `dist / 0` で **無限大**になり、
     *   1600ms に丸められて「すごく遅い」動きになっていた（記録が壊れている時の保険）。
     *   → 0 以下は「実測なし」として null（呼ぶ側が今まで通りの速さを使う）。
     */
    if (!(profile.speed_px_s > 0)) return null;
    var ms = (dist / profile.speed_px_s) * 1000;
    // 速さから出した時間を 120〜1600ms に丸める（0ms で飛ばない・長すぎて止まらない）
    return Math.max(120, Math.min(1600, Math.round(ms)));
  }

  /**
   * 2026-11-13: サーバーが学んだ「曲がり具合」を返す（無ければ null＝手元の癖を使う）。
   *   1.0＝まっすぐ・大きいほど曲げる。0.5〜3.0 に丸める（極端に曲げない）。
   */
  function serverCurve() {
    var srv = _serverMotion();
    var c = srv && typeof srv.curve === "number" ? srv.curve : null;
    if (c == null || !(c > 0)) return null;
    return Math.max(0.5, Math.min(3.0, c));
  }

  /**
   * 2026-11-13: サーバーが学んだ「操作と操作の間」（中央値・ms）を返す。
   *   ⚠ 画面の待ちに使う時の**目安**。呼ぶ側で 200〜3000ms に丸める。
   */
  function serverGapMs() {
    try {
      if (typeof chrome === "undefined" || !chrome.storage || !chrome.storage.local) return null;
      // 同期では読めないので、キャッシュに入っている時だけ返す（無ければ null＝今まで通り）
      return (_srvGap && typeof _srvGap.ms === "number" && _srvGap.ms > 0) ? _srvGap.ms : null;
    } catch (_) { return null; }
  }
  var _srvGap = null;
  var _srvGapAt = 0;
  function _loadServerGap() {
    var now = Date.now();
    if (now - _srvGapAt < 60000) return;
    _srvGapAt = now;
    try {
      if (typeof chrome === "undefined" || !chrome.storage || !chrome.storage.local) return;
      chrome.storage.local.get(["axlx_learn_gaps"], function (r) {
        try {
          var g = (r && r.axlx_learn_gaps) || null;
          var ms = g && typeof g.median_ms === "number" ? g.median_ms : null;
          _srvGap = (ms && ms > 0) ? { ms: Math.max(200, Math.min(3000, ms)) } : null;
        } catch (_) { _srvGap = null; }
      });
    } catch (_) {}
  }
  try { _loadServerGap(); } catch (_) {}

  /** 段階の日本語名（画面に出す用） */
  var STAGE_JA = { form: "条件の入力", modal: "小窓（選択）", result: "検索結果", other: "その他" };
  function stageJa(s) { return STAGE_JA[s] || STAGE_JA.other; }

  /**
   * 2026-11-11 竹内さん「これでボタン物件検索でおすばしょ理解できたかな？ある程度は」:
   *   押した場所を**人が読める形**にする（記録の全体像から）。
   *   「物件検索のボタンは条件の入力の最後に、横62%・縦78%で押した」のように出す。
   *
   * @param {Object} agg  axlx_human_learn の中身
   * @returns {string[]} 1行ずつ（多すぎないように上位8件まで）
   */
  function buttonReport(agg) {
    var out = [];
    var pt = (agg && agg.points) || {};
    var fields = pt.fields || {};
    var names = Object.keys(fields);
    if (!names.length) return ["押した場所の記録がまだありません（通常モードで操作すると貯まります）"];
    // 押した回数の多い順
    names.sort(function (a, b) { return (Number(fields[b].n) || 0) - (Number(fields[a].n) || 0); });
    out.push("押した場所（多い順・" + (pt.n || 0) + "回分）:");
    names.slice(0, 8).forEach(function (f) {
      var v = fields[f] || {};
      var pct = function (x) { return x == null ? "?" : Math.round(x * 100) + "%"; };
      var st = v.stage ? "／" + stageJa(v.stage) : "";
      // 名前は "検索｜div.go_search" の形。長い時はそのまま（30字まで）
      out.push("  ・" + f + " … " + (v.n || 0) + "回・横" + pct(v.x) + "・縦" + pct(v.y) + st);
    });
    if (names.length > 8) out.push("  （ほか " + (names.length - 8) + "件）");
    return out;
  }

  /** 集計から「何を学んだか」を1行ずつ（画面に出す用） */
  function learnedLines(profile) {
    if (!profile) return ["まだ学べていません（通常モードでもう少し操作すると学び始めます）"];
    var out = [];
    out.push("速さ: " + (profile.speed_px_s != null ? "約" + profile.speed_px_s + "px/秒（カーソルの動きに使います）" : "まだ"));
    out.push("曲がり: " + (profile.curve != null ? profile.curve + "（1.00＝まっすぐ）" : "まだ"));
    out.push("押す位置: " + (profile.aim ? "横" + profile.aim.x + "・縦" + profile.aim.y + "（ボタンのどこを狙うか）" : "まだ"));
    out.push("スクロール: " + (profile.scroll_dy != null ? "1回 約" + profile.scroll_dy + "px" : "まだ"));
    return out;
  }

  /**
   * 2026-11-13 竹内さん「site_flow と weak を実際に使う」:
   *   **サーバー（学習担当のブレイン）が学んだ事**を人が読める1行ずつにする。
   *   ⚠ これまで `learnedLines` は**手元の癖だけ**を出していて、
   *     サーバーが計算した `next`（押す順番）・`weak`（次に学ぶ事）・`site_flow`（サイトの手順）は
   *     storage に置くだけで**画面に出していなかった**（＝学んだ事が現場に見えていない）。
   *
   * @param {{next?:Object, weak?:Array, site_flow?:Object, gaps?:Object, motion?:Object}} srv
   * @returns {string[]}
   */
  function serverLearnLines(srv) {
    var out = [];
    var s = srv || {};
    /** 数字の増減を「+3 / -2 / ±0」にする（統括の表示用） */
    function sgn(v) {
      var n = Number(v);
      if (!isFinite(n) || n === 0) return "±0";
      return n > 0 ? "+" + n : String(n);
    }
    var nx = (s.next && typeof s.next === "object") ? s.next : {};
    var names = Object.keys(nx);
    if (names.length) {
      // 確からしさの高い順
      names.sort(function (a, b) {
        var ra = nx[a] && nx[a].total ? nx[a].n / nx[a].total : 0;
        var rb = nx[b] && nx[b].total ? nx[b].n / nx[b].total : 0;
        return rb - ra;
      });
      out.push("▼ 写真から学んだ「次に押す物」（" + names.length + "通り）");
      names.slice(0, 8).forEach(function (k) {
        var v = nx[k] || {};
        var pct = v.total ? Math.round((v.n / v.total) * 100) : null;
        out.push("  ・「" + k + "」の次は「" + (v.next || "?") + "」"
          + (pct != null ? "（" + v.n + "/" + v.total + "回・" + pct + "%）" : ""));
      });
    } else {
      out.push("▼ 写真から学んだ「次に押す物」: まだ（写真つきの操作が2回以上たまると学びます）");
    }

    var sf = (s.site_flow && typeof s.site_flow === "object") ? s.site_flow : {};
    /**
     * 2026-11-14 竹内さん「学習の統括の部分判断できるようにちゃんと強化していく」:
     *   **統括の判断**（結論・次にやる事・数字）をいちばん上に出す。
     *   ⚠ これが無いと、弱い所の一覧だけが並んで「で、使えるの？」が分からない。
     */
    var sup = (s.supervisor && typeof s.supervisor === "object") ? s.supervisor : null;
    if (sup && sup.headline) {
      out.push("▼ 統括の判断: " + String(sup.headline));
      if (sup.score) {
        out.push("  材料の揃い: " + String(sup.score.coverage) + "/100・弱い所 " + String(sup.score.weak) + "件"
          + (sup.score.delta ? "・前回から 記録" + sgn(sup.score.delta.rows) + " 順番" + sgn(sup.score.delta.next) + " 場所" + sgn(sup.score.delta.points) + " 弱い所" + sgn(sup.score.delta.weak) : ""));
      }
      if (sup.block) out.push("  ⚠ " + String(sup.block));
      if (Array.isArray(sup.actions) && sup.actions.length) {
        out.push("  次にやる事:");
        for (var ai2 = 0; ai2 < Math.min(5, sup.actions.length); ai2++) {
          var a2 = sup.actions[ai2] || {};
          out.push("    ・" + String(a2.what || "") + (a2.name ? "（" + String(a2.name) + "）" : ""));
        }
      }
      out.push("");
    }
    /**
     * 2026-11-14 竹内さん「DBにあって反映できていないものはあるか」:
     *   `opens`（押したら何が開くか）を**画面に出していなかった**（学んでいるのに人が見えない）。
     *   自動検索もこれを見て「開くはず」と確かめられる。ここでも1行で見せる。
     */
    var op = (s.opens && typeof s.opens === "object") ? s.opens : {};
    var OJ = { modal: "小窓が開く", options: "プルダウンの一覧が開く", form: "入力欄が変わる", result: "結果の一覧に変わる", modal_close: "小窓が閉じる", none: "変化なし" };
    if (Object.keys(op).length) {
      out.push("");
      out.push("▼ 押したら何が開くか（" + Object.keys(op).length + "個）");
      Object.keys(op).slice(0, 6).forEach(function (k) {
        var v = op[k] || {};
        out.push("  ・「" + k + "」→ " + (OJ[v.opens] || v.opens || "?") + (v.n ? "（" + v.n + "回）" : ""));
      });
    }
    var screens = (s.screen_flow && typeof s.screen_flow === "object") ? s.screen_flow : {};
    var SJ = { modal: "小窓（地域・駅）", form: "条件の入力", result: "結果の一覧", other: "その他" };
    if (Object.keys(screens).length) {
      out.push("");
      out.push("▼ 写真から学んだ画面ごとの仕組み" + (s.shots ? "（写真 " + s.shots.total + "枚）" : ""));
      Object.keys(screens).slice(0, 4).forEach(function (sc) {
        var v = screens[sc] || {};
        if (!v.n) return;
        out.push("  【" + (SJ[sc] || sc) + "】" + v.n + "枚");
        // 回数の多い順に1本の流れにする（同じ元からは1本）
        var usedFrom = {};
        var flow = [];
        (v.steps || []).slice().sort(function (a, b) { return (b.n || 0) - (a.n || 0); }).forEach(function (x) {
          if (usedFrom[x.from]) return;
          usedFrom[x.from] = true;
          flow.push(x.from + " → " + x.to);
        });
        if (flow.length) out.push("    順番: " + flow.slice(0, 5).join(" / "));
        if (v.lastPressed && v.lastPressed.length) {
          out.push("    最後に押す物: " + v.lastPressed.slice(0, 3).map(function (x) { return x.name + "（" + x.n + "枚）"; }).join("・"));
        }
      });
    }

    void sf;
    var sites = Object.keys(sf);
    if (sites.length) {
      out.push("");
      out.push("▼ サイトごとの手順");
      sites.slice(0, 3).forEach(function (site) {
        var arr = Array.isArray(sf[site]) ? sf[site] : [];
        if (!arr.length) return;
        // 回数の多い順に、矢印でつないだ「流れ」を作る（同じ元からは1本だけ）
        var usedFrom = {};
        var flow = [];
        arr.slice().sort(function (a, b) { return (b.n || 0) - (a.n || 0); }).forEach(function (x) {
          if (usedFrom[x.from]) return;
          usedFrom[x.from] = true;
          flow.push(x);
        });
        // 起点（誰からも指されていない物）から並べる
        var pointed = {};
        flow.forEach(function (x) { pointed[x.to] = true; });
        var head = flow.filter(function (x) { return !pointed[x.from]; })[0] || flow[0];
        var chain = [];
        var cur = head;
        var guard = 0;
        while (cur && guard++ < 12) {
          if (!chain.length) chain.push(cur.from);
          chain.push(cur.to);
          var nextX = flow.filter(function (y) { return y.from === cur.to; })[0];
          if (!nextX || chain.indexOf(nextX.to) >= 0) break;
          cur = nextX;
        }
        out.push("  " + site + ": " + chain.map(function (t) { return String(t).slice(0, 24); }).join(" → "));
      });
    }

    var weak = Array.isArray(s.weak) ? s.weak : [];
    out.push("");
    if (weak.length) {
      out.push("▼ 次に学ぶ事（" + weak.length + "件）");
      weak.slice(0, 6).forEach(function (w) {
        if (!w || typeof w !== "object") return;
        out.push("  ・" + (w.name || "?") + " … " + (w.why || "") + (w.how ? "（" + String(w.how).slice(0, 40) + "）" : ""));
      });
      if (weak.length > 6) out.push("  ほか " + (weak.length - 6) + "件");
    } else {
      out.push("▼ 次に学ぶ事: なし（今の所そろっています）");
    }

    var g = (s.gaps && typeof s.gaps === "object") ? s.gaps : null;
    if (g && g.median_ms) out.push("", "▼ 操作と操作の間: 中央値 約" + g.median_ms + "ms（" + (g.samples || 0) + "件）");
    return out;
  }

  /**
   * 2026-11-13 竹内さん「写真から学習する。押す場所や押す順番などもりかいできるから」
   *   「おしかたのボタンの仕様の理解の為にも」「自動モードでは実際に人間がおしたようにおすことができる」
   *
   *   写真と一緒に貯めた「操作の並び」（`shot_ops`）から、**次に押す物**を学ぶ（純関数）。
   *   ・直前の操作（f）→ その次に押された物 の組を数える
   *   ・同じ「直前」から複数の行き先がある時は、**回数の多い方**を返す
   *   ・1回だけの組は返さない（偶然かもしれない・`min` 回以上）
   *
   * @param {Array<Array<{t:number,k:string,f:string}>>} sequences  写真ごとの操作の並び
   * @param {{min?:number}} [opt]
   * @returns {Object<string,{next:string,n:number,total:number}>} 直前の欄 → 次に押す物
   */
  function nextPressFrom(sequences, opt) {
    var o = opt || {};
    var min = o.min == null ? 2 : o.min;
    var list = Array.isArray(sequences) ? sequences : [];
    var tally = {};   // 直前 → { 次 → 回数 }
    for (var i = 0; i < list.length; i++) {
      var seq = Array.isArray(list[i]) ? list[i] : null;
      if (!seq || seq.length < 2) continue;
      for (var j = 1; j < seq.length; j++) {
        var a = seq[j - 1] || {}, b = seq[j] || {};
        if (!a.f || !b.f) continue;
        if (a.f === b.f) continue;             // 同じ欄の続き（値の入力など）は数えない
        if (!tally[a.f]) tally[a.f] = {};
        tally[a.f][b.f] = (tally[a.f][b.f] || 0) + 1;
      }
    }
    var out = {};
    Object.keys(tally).forEach(function (from) {
      var dest = tally[from];
      var names = Object.keys(dest);
      names.sort(function (x, y) { return dest[y] - dest[x]; });
      var total = 0;
      names.forEach(function (n) { total += dest[n]; });
      var top = names[0];
      if (!top || dest[top] < min) return;
      out[from] = { next: top, n: dest[top], total: total };
    });
    return out;
  }

  return {
    create: create,
    summarize: summarize,
    summarizeMotion: summarizeMotion,
    opensOf: _opensOf,
    mergeAggregate: mergeAggregate,
    mergeMotion: mergeMotion,
    profileFrom: profileFrom,
    moveMsFor: moveMsFor,
    serverCurve: serverCurve,
    serverGapMs: serverGapMs,
    serverLearnLines: serverLearnLines,
    learnedLines: learnedLines,
    buttonReport: buttonReport,
    nextPressFrom: nextPressFrom,
    stageJa: stageJa,
    reportLine: reportLine,
    describe: describe,
    fieldName: fieldName,
    kindOf: kindOf,
    kindOfEl: kindOfEl,
    median: median,
    medianF: medianF,
    MAX_OPS: MAX_OPS,
    MAX_GAPS: MAX_GAPS,
    SAME_KIND_MIN_MS: SAME_KIND_MIN_MS,
    MAX_MOVES: MAX_MOVES,
    MAX_MOVE_PTS: MAX_MOVE_PTS,
    MOVE_GAP_MS: MOVE_GAP_MS,
    MAX_POINTS: MAX_POINTS,
    MAX_SCROLLS: MAX_SCROLLS,
  };
});
