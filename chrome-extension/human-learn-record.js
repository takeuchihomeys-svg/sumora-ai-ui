// chrome-extension/human-learn-record.js
// 2026-11-11 竹内さん「普通モードはスタッフの動きを学習する形でもよい。画面録画や監視して動きちゃんと理解できるように」
//
// human-learn.js（純関数）で覚えた人の動きを、**通常モード・スタッフモードの時だけ** chrome.storage.local に貯める。
//   storage のキー: axlx_human_learn = { v:1, n, sessions, kinds, gaps, gap_ms, fields, order, at, site }
//   → 自動モードの「人のような間」（human-wait.js の logNormalDelay）を実測に寄せる材料にする。
//
// ⚠ 自動モード・AIX では**覚えない**（拡張の動きが混ざって「人の動き」でなくなるため）。
//     モードが自動に変わったら、その場で見張りを外して貯めるのを止める。
// ⚠ 入力した中身（値）は残さない。欄の名前・操作の種類・間だけ。
(function () {
  "use strict";
  /**
   * 2026-11-14 竹内さん「今実際おこなった 出来ていない部分学習おねがい」→ 2.7.44 でも
   *   写真 60枚すべて `shot_ops` が `k:"diag"` の1件、理由は **`no_answer:tab1001211057`**（同じタブ）。
   *
   * ⚠ 本当の原因（旧の印の付け方）:
   *   旧は **`L`（human-learn.js）が無い時も先に印を立ててから** `return` していた:
   *     window.__axlxHumanLearnRecord = true;  // ← 先に立てる
   *     var L = ...AxlxHumanLearn; if (!L) return;  // ← 無ければ抜ける（印は残る）
   *   しかも**拡張を更新すると、開いたままのタブの古い記録係は無効になる**（拡張の入れ替えで
   *   メッセージの口が死ぬ）。background は `chrome.scripting.executeScript` で**注入し直して**
   *   助けようとするが、**この印が残っているので即 return** ＝ 何度注入しても復活しない。
   *   → タブは `sendMessage` に**永久に答えない**（＝ `no_answer`）。
   *
   * → ① **印は初期化が終わってから**立てる（途中で抜けたら印を残さない＝注入し直せば直る）。
   *   ② **メッセージの受け口は `L` が無くても先に付ける**（タブが必ず理由を答えられるように）。
   *   ③ 答えに `why` を入れる（`no_learn_lib` / `dupe`）＝次に同じ事が起きたらDBで分かる。
   */
  var _recBoot = (typeof self !== "undefined" ? self : window);
  // ② 受け口は最初に付ける（この下で何が起きても、タブは「なぜ空か」を答えられる）
  try {
    if (typeof chrome !== "undefined" && chrome.runtime && chrome.runtime.onMessage) {
      chrome.runtime.onMessage.addListener(function (msg, _s, sendResponse) {
        if (!msg || msg.type !== "axlx-recent-ops") return;
        try {
          var g = _recBoot.__axlxHumanLearnRecState || null;
          if (g && typeof g.answer === "function") { g.answer(sendResponse); return true; }
          // まだ本体が立ち上がっていない（ライブラリ待ち・二重起動）→ 理由を返す
          sendResponse({ ok: true, ops: [], diag: { why: (g && g.why) || "booting", ring: 0, seen: 0 } });
        } catch (_) { try { sendResponse({ ok: true, ops: [] }); } catch (__) {} }
        return true;
      });
    }
  } catch (_) {}
  // 既に本体が動いている（同じページに二重に入った）→ 受け口だけ足して終わる
  if (_recBoot.__axlxHumanLearnRecord) {
    try {
      _recBoot.__axlxHumanLearnRecState = _recBoot.__axlxHumanLearnRecState || { why: "dupe" };
    } catch (_) {}
    return;
  }

  var KEY = "axlx_human_learn";
  // 2026-11-11 竹内さん「データたまって理解するたび反映」: 貯まるたびに作り直す「動きの癖」（カーソルがこれを見て動く）
  var PROFILE_KEY = "axlx_human_profile";
  /**
   * 2026-11-13: 要素ごとの押した位置（人がどこを押したか）。
   *   pointer-ui.js と同じ鍵（`axlx_human_points`）を読み書きする。
   *   ここで貯めた物を、次に同じボタンを押す時に**狙う場所**として使う。
   */
  var POINTS_KEY2 = "axlx_human_points";
  var SAVE_EVERY_MS = 60000;   // 1分ごとに書き出す（操作のたびに書かない）
  var MIN_OPS_TO_SAVE = 5;     // 5回未満は書かない（誤操作・一瞬のクリックだけを貯めない）
  var LEARN_LOCK = "human-learn-record.js";

  var L = (typeof self !== "undefined" ? self : window).AxlxHumanLearn;
  /**
   * 2026-11-14 竹内さん「順になおしていく」→ **`ring_empty: seen0: watchundefined` の正体**:
   *
   *   ⚠ `watchundefined` は、**先頭の受け口が「まだ立ち上がっていない」と答えた**印。
   *     つまり本体が下の `if (!L)` で抜けていた（`human-learn.js` がまだ居ない）。
   *   ⚠ 旧は**1回だけ見て諦めて**いた。`document_start` は実行順が保証されない事があり
   *     （別 entry・注入し直し・ページの作り直し）、その場合 `human-learn-record.js` だけ先に走って
   *     **永久に立ち上がらない**。その結果 `seen:0`（クリックを1回も拾えない）になっていた。
   *
   *   → **ライブラリが来るまで待つ**（最大3秒・50msおき）。来たら続きをやる。
   *     待っても来なければ理由を残して諦める（次の注入で復活できる＝印は立てない）。
   */
  function _bootAfterLib() {
    try {
      _recBoot.__axlxHumanLearnRecord = true;
      _recBoot.__axlxHumanLearnRecState = { why: null };
    } catch (_) {}
    start();
  }
  if (!L) {
    try { _recBoot.__axlxHumanLearnRecState = { why: "waiting_lib" }; } catch (_) {}
    var _waitTries = 0;
    var _waitTimer = setInterval(function () {
      _waitTries++;
      var got = (typeof self !== "undefined" ? self : window).AxlxHumanLearn;
      if (got) {
        clearInterval(_waitTimer);
        L = got;
        try { console.log("[AX] 記録係: " + (_waitTries * 50) + "ms 待って ライブラリが来ました"); } catch (_) {}
        _bootAfterLib();
        return;
      }
      if (_waitTries >= 60) {           // 3秒待っても来ない
        clearInterval(_waitTimer);
        try { _recBoot.__axlxHumanLearnRecState = { why: "no_learn_lib" }; } catch (_) {}
        try { console.warn("[AX] 記録係: 3秒待っても human-learn.js が来ません（操作を記録できません）"); } catch (_) {}
      }
    }, 50);
    return;
  }

  /**
   * 2026-11-14 竹内さん「順になおしていく」:
   *   ⚠ 旧はこの先の本体が**トップレベルにべた書き**だったので、`L` が無い時に抜けると
   *     **ライブラリが後から来ても何も始まらなかった**（＝`seen:0` のまま）。
   *   → 本体を `start()` にまとめ、ライブラリが来た時に呼ぶ（待つ側も呼ぶ）。
   */
  function start() {
  var rec = L.create({
    doc: document, win: window,
    // 2026-11-11 竹内さん「録画のような形で」: 操作のたびに画面の写真を1枚撮る
    onOp: function (kind, el, pt) { shootAfter(kind, el, pt); },
  });
  var detach = null;
  var watching = false;
  var timer = null;
  var site = (function () {
    try {
      var h = String(location.hostname || "");
      if (/realnetpro/.test(h)) return "realpro";
      if (/itandibb/.test(h)) return "itandi";
      if (/reins/.test(h)) return "reins";
    } catch (_) {}
    return "unknown";
  })();

  /**
   * 2026-11-11 竹内さん「写真ちゃんと送られたかな？」→ 0枚のまま。
   *
   * ⚠ 原因: `shouldLearn` は**通常・スタッフの時だけ true**（自動・AIX は false）。
   *   写真は学習（`onOp`）の中から撮っているので、**自動モード・AIXモードでは一度も撮られていなかった**。
   *   だが竹内さんが写真で確かめたいのは**まさに自動モードで「検索を押せたか」**。
   *
   * → 分ける:
   *   ・**学習（人の動きを覚える）** … 今まで通り 通常・スタッフの時だけ（拡張の動きを混ぜない）
   *   ・**写真（画面の記録）**       … どのモードでも撮る（自動で押した画面こそ残したい）
   *   写真は `onOp` ではなく**自前の見張り**（人が押した時＋拡張が押した時）から撮る。
   */
  /**
   * 人の動きを覚えるモードか。
   *
   * 2026-11-14 竹内さん「学習して改善したら自動モード強化されるように」:
   *   ⚠ 旧は `return !autoOn` で、**自動モードでは記録を止めていた**。
   *     そのため `by_mode` に **AIX（自動）が0件**になり、統括が
   *     「自動は記録が0件＝学べていない」と言い続けていた（実測）。
   *   ⚠ 自動モードの動きは「人の手本」ではないので、**人の動きとして混ぜてはいけない**
   *     （混ぜると順番が濁る）。だが「**自動がどう動いたか**」は学ぶ価値がある
   *     （どこで止まったか・何を押せなかったか）。
   *   → **どのモードでも記録する**。モードは `mode` 列に入るので、後で分けて学べる
   *     （`by_mode` がモード別に分ける）。
   */
  function shouldLearn(st) {
    void st;
    return true;
  }
  /** 写真を撮るモードか（＝どのモードでも撮る。止める設定がある時だけ止める） */
  function shouldShoot(st) {
    var s = st || {};
    try { if (s.axlxShotOff === true) return false; } catch (_) {}
    return true;
  }

  /** 覚えている最中の印（同じページで二重に見張らない・他の部品からも分かる） */
  function lock() { try { document.documentElement.setAttribute("data-axlx-learn", "1"); } catch (_) {} }
  function unlock() { try { document.documentElement.removeAttribute("data-axlx-learn"); } catch (_) {} }

  function startWatching() {
    if (watching) return;
    watching = true;
    try { lock(); } catch (_) {}
    detach = rec.attach(document, window);
    console.log("[AX] 通常モード: 人の動きを覚えます（" + site + "）");
  }
  function stopWatching() {
    if (!watching) return;
    watching = false;
    try { if (detach) detach(); } catch (_) {}
    detach = null;
    try { unlock(); } catch (_) {}
    console.log("[AX] 自動モード: 人の動きを覚えるのを止めました（" + site + "）");
    save(true); // 止める時に残りを書き出す
  }

  /** 画面に「見張っています」の小さな印（消せる・邪魔にならない） */
  function ensureBadge() {
    try {
      if (document.getElementById("axlx-learn-badge")) return;
      var d = document.createElement("div");
      d.id = "axlx-learn-badge";
      d.style.cssText = "position:fixed;left:10px;bottom:10px;z-index:2147483000;background:rgba(22,163,74,.92);color:#fff;"
        + "font:700 11px/1.4 -apple-system,system-ui,sans-serif;padding:4px 8px;border-radius:8px;pointer-events:none;opacity:.85";
      d.textContent = "👀 人の動きを学習中";
      (document.body || document.documentElement).appendChild(d);
    } catch (_) {}
  }
  /**
   * 2026-11-11 竹内さん「普通モードでのマウスの動かし方やボタンのどこ押すかもちゃんとたまるんかな」:
   *   貯まっているかを**その場で見える**ようにする（数が増えていくのが分かる）。
   *   印に「マウス◯回・押した所◯・スクロール◯」を出す。
   */
  function paintBadge() {
    try {
      var d = document.getElementById("axlx-learn-badge");
      if (!d) return;
      var det = rec.detail();
      var n = rec.count();
      d.textContent = "👀 学習中 操作" + n + "・マウス" + (det.moves || []).length
        + "・押した所" + (det.points || []).length + "・スクロール" + (det.scrolls || []).length;
    } catch (_) {}
  }
  /**
   * 2026-11-11 竹内さん「データたまって理解するたび反映」:
   *   貯まるたびに「こう理解した（速さ・曲がり・押す位置）」を**画面の印に出す**。
   *   → 反映されていることが目で分かる（数字が動く）。
   */
  function paintLearned(prof) {
    try {
      var d = document.getElementById("axlx-learn-badge");
      if (!d || !prof) return;
      var parts = [];
      if (prof.speed_px_s != null) parts.push("速さ" + prof.speed_px_s);
      if (prof.curve != null) parts.push("曲がり" + prof.curve);
      if (prof.aim) parts.push("押す所" + prof.aim.x + "/" + prof.aim.y);
      if (!parts.length) return;
      d.textContent = "👀 学習中｜理解した動き: " + parts.join("・");
      d.style.background = "rgba(21,128,61,.95)";
    } catch (_) {}
  }
  function removeBadge() {
    try { var d = document.getElementById("axlx-learn-badge"); if (d) d.remove(); } catch (_) {}
  }

  var _saving = false;
  function save(force) {
    if (_saving) return;
    var ops = rec.list();
    if (!ops.length) return;
    if (!force && ops.length < MIN_OPS_TO_SAVE) return;
    _saving = true;
    var add = L.summarize(ops);
    // 2026-11-11 竹内さん「マウスの動かし方やボタンのどこ押すか、画面のうごかしかたも」:
    //   動き・押した場所・スクロールも一緒に集計して貯める（detail() が締め忘れを締めてから返す）
    try {
      var det = rec.detail();
      var motion = L.summarizeMotion(det);
      add.moves = motion.moves; add.points = motion.points; add.scrolls = motion.scrolls;
      /**
       * 2026-11-14 竹内さん「実際の通常モードでの検索のデータと比べてのギャップを強化」:
       *   ⚠ `point_fields` の**押した順番**（`points.order`）を送っていなかったので、
       *     写真が無い記録（＝通常モードの大半）では**順番を学べなかった**（実測 normal 34件で順番0）。
       *   → `field_order`（サーバーの列）に届くように、`order` と `fields` も渡す。
       */
      try { add.order = (motion.points && motion.points.order) || []; } catch (_) { add.order = []; }
      try { add.fields = Object.keys((motion.points && motion.points.fields) || {}).slice(0, 40); } catch (_) { add.fields = []; }
      /**
       * 2026-11-14 竹内さん「プルダウンのところとか、さっき改善されたかな」
       *   → ⚠ **自動モード（拡張が押す）では順番が空のまま**だった。
       *     `motion.points` は `isTrusted` の物だけなので、拡張の押下は入らない。
       *   → この受け口で貯めた `_livePoints`（人も拡張も）から**順番と欄**を作って足す。
       *     ⚠ 人の手本が既にある時は**そちらを優先**（人の押し方の方が正確）。
       */
      try {
        var _live = _livePoints || {};
        var _liveNames = Object.keys(_live).filter(function (k) { return k !== "__last" && _live[k] && _live[k].n; });
        if (!add.order || !add.order.length) {
          // `__last` に積んだ順番は残していないので、時刻ではなく**n（回数）の多い順**ではなく
          // **押された順**が要る → `_orderLive` を使う
          add.order = _orderLive.slice(0, 40);
        }
        if (!add.fields || !add.fields.length) add.fields = _liveNames.slice(0, 40);
        /**
         * 欄ごとの押した位置も `_livePoints` から作る（自動モードでも位置が残る）。
         *   ⚠ 人の記録が既にある時は上書きしない。
         */
        if (!add.points || !add.points.fields || !Object.keys(add.points.fields).length) {
          var pf = {};
          _liveNames.slice(0, 40).forEach(function (k) {
            var v = _live[k];
            pf[k] = { n: Number(v.n) || 0, x: Number(v.x) || 0, y: Number(v.y) || 0, w: v.wk || null, by: v.by || null };
          });
          add.points = { n: _liveNames.length, x: null, y: null, fields: pf, order: _orderLive.slice(0, 40) };
        }
      } catch (_) {}
      /**
       * 2026-11-14 竹内さん「ボタンなのかプルダウンなのか、どこで展開されるのかも意識して学習して改善する」:
       *   押したら何が開いたか（modal / options / form / result / none）を送る。
       *   ⚠ 中身は送らない（開いた物の種類と数だけ）。
       */
      try { add.opens = (motion.opens && motion.opens.byField) || {}; } catch (_) { add.opens = {}; }
      try { add.open_kinds = (motion.opens && motion.opens.kinds) || {}; } catch (_) { add.open_kinds = {}; }
    } catch (_) {}
  /**
   * 2026-11-11 竹内さん「画面の動き方もちゃんと把握できているのかな録画のような形で」→「操作のたびに1枚」
   *
   *   操作の**たびに**画面の写真を1枚撮って Storage に置く（1検索で30〜80枚）。
   *   並べると操作の流れ（録画に近い物）になる。
   *   ・撮るのは人が操作した時だけ（拡張の動きは撮らない）
   *   ・撮りすぎない（最短 350ms はあける・background 側でも間引く）
   *   ・写真の中身は DB に送らない（Storage 内・名前だけ DB へ）
   */
  var _shotPending = false;
  var _shotPendingAt = 0;
  var _shotLast = 0;
  var _shotCount = 0;
  /**
   * 2026-11-13 竹内さん「写真から学習する。押す場所や押す順番などもりかいできるから」:
   *   直近の操作を**小さな輪**に残しておき、写真を撮る時に一緒に送る。
   *   → 写真1枚に「その直前までに何を押したか（順番・時刻）」が付く。
   *     「この画面で次に何を押すか」を後から学べる材料になる。
   *   ⚠ 入れるのは**欄の名前・操作の種類・時刻だけ**（入力した中身・文字は入れない）。
   *   ⚠ 上限 40件（古い物から捨てる）。ページを離れると消える（それでよい）。
   */
  var _opsRing = [];
  /** 2026-11-14: click/change を拾った回数（診断用・なぜ ops が空かを知るため） */
  var _opsSeen = 0;
  var _opsAsk = 0;
  /**
   * 2026-11-13 竹内さん「所在地絞り込みや沿線絞り込みの部分はどうなっているか。抜けていないのか」:
   *   地域（6段）と駅（5段）も記録するようになったので、上限を 40 → **60** に上げる。
   *   ⚠ 地域は検索の**最初**に押すので、上限が小さいと後から消える（＝学べない）。
   */
  var OPS_RING_MAX = 60;
  /**
   * 2026-11-13 竹内さん「ちゃんと読み取れるようになったかな」→ `site=realpro` は入るが
   *   **`shot_ops` が 0件**だった。
   *   ⚠ 原因: この輪には**人が押した操作（isTrusted）だけ**を入れていた。
   *     録画モードで押しているのは**拡張**（isTrusted=false）なので、**1つも入らない**。
   *   → **録画モードの時は、拡張の操作も拾う**（どのボタンを押したかの材料になる）。
   *     `_recNoteOp` を pointer-ui（拡張の押下）から呼んでもらい、ここに積む。
   *   ⚠ 入れるのは**欄の名前・種類・時刻だけ**（入力した中身は入れない）。
   */
  function _pushOp(kind, el, by) {
    try {
      var nm = el && L && L.fieldName ? L.fieldName(el) : null;
      // 同じ物を続けて積まない（拡張の tap と click が両方来る事がある）
    var last = _opsRing[_opsRing.length - 1];
      var t = Date.now();
      var nmStr = nm ? String(nm).slice(0, 30) : null;
      if (last && last.f === nmStr && t - Number(last.t || 0) < 120) return;
      /**
       * 2026-11-13 竹内さん「自動検索のところちゃんと学習されるようになっているのか」:
       *   ⚠ チェックボックスは **`label` を押すと `input` にも click が伝わる**ので、
       *     同じ1回の操作が **2回**（`左の1K｜label` と `room_layout_id[]`）記録されていた。
       *     実測: この形が **40件中24件**。学習すると「1K → 間取り → 1K → 間取り…」の
       *     **交互（人がやらない押し方）**を学び、確からしさが 20/20回になってしまっていた。
       *   → **同じチェックの label と input は1回に畳む**（120〜400ms 以内・同じ親の中）。
       */
      try {
        var _LL0 = (typeof self !== "undefined" ? self : window).AxlxHumanLearn || L;
        var _sameToggle = (function () {
          if (!last || !el) return false;
          var gap2 = t - Number(last.t || 0);
          if (!(gap2 >= 0 && gap2 <= 400)) return false;      // 近い時だけ（人の2回押しは残す）
          var cb = last.el;
          if (!cb || !cb.nodeType) return false;
          // 片方が label・片方が input（同じチェックを指している）
          var a = String(cb.tagName || "").toUpperCase(), b = String(el.tagName || "").toUpperCase();
          var isPair = (a === "LABEL" && b === "INPUT") || (a === "INPUT" && b === "LABEL");
          if (!isPair) return false;
          var inp = a === "INPUT" ? cb : el;
          var lab = a === "LABEL" ? cb : el;
          if (!inp || String(inp.name || "").indexOf("[]") < 0) return false;  // チェック系だけ
          // 同じ親の中に居る（同じチェック）
          return !!(lab.contains && lab.contains(inp)) || (inp.closest && inp.closest("label") === lab);
        })();
        if (_sameToggle) { void _LL0; return; }
      } catch (_) {}
      /**
       * 2026-11-13: 要素の種類は**その場で読む**（読み込み順に頼らない）。
       *   ⚠ 旧は ファイル先頭の `L` を使っていたが、`human-learn.js` より先に読まれると
       *     `L` が undefined のままになり、**種類が1つも入らなかった**（実際に0件だった）。
       */
      var LL = (typeof self !== "undefined" ? self : window).AxlxHumanLearn || L;
      var kd = (LL && LL.kindOfEl) ? LL.kindOfEl(el) : null;
      /**
       * 2026-11-13 竹内さん「ほかに抜けている箇所はあるのか。原因見つけて改善する」:
       *   `g`（直前の操作からの間隔 ms）も残す。
       *   ⚠ これが無いと「人が次を押すまでどれくらい待つか」を学べず、
       *     サーバーは `move_ms`（マウス移動の時間）で代用していた（別物）。
       *   ⚠ 間隔は 0〜60000ms に丸める（画面を離れていた長い空白は混ぜない）。
       */
      var gap = null;
      if (last && typeof last.t === "number" && t > last.t) {
        var d = t - last.t;
        if (d >= 0 && d <= 60000) gap = d;
      }
      _opsRing.push({ t: t, k: String(kind || "?").slice(0, 10), f: nmStr, w: kd, g: gap, el: el || null, by: (by === "human" || by === "auto") ? by : null });
      try { _opsSeen++; } catch (_) {}
      while (_opsRing.length > OPS_RING_MAX) _opsRing.shift();
    } catch (_) {}
  }
  /** 拡張が押した時にも積む（録画モードの時だけ使う・pointer-ui から呼ばれる） */
  function _recNoteOp(kind, el) { try { _pushOp(kind || "tap", el); } catch (_) {} }
  /**
   * 2026-11-13 竹内さん「所在地絞り込みや沿線絞り込みの部分はどうなっているか。抜けていないのか」:
   *   **要素を渡さずに名前だけで積む**（地域・駅の段は `waitForClick` で押していて
   *   `enqueueHumanClick` を通らない＝いままで記録に残らなかった）。
   *   実測: 記録15種類に地域・駅が**1つも無かった**。
   *   ⚠ 残すのは**段の名前と時刻だけ**（区の名前・入力した中身は入れない）。
   */
  function _recNoteName(name) {
    try {
      var nmStr = name ? String(name).slice(0, 30) : null;
      if (!nmStr) return;
      var last = _opsRing[_opsRing.length - 1];
      var t = Date.now();
      if (last && last.f === nmStr && t - Number(last.t || 0) < 120) return;
      var gap = null;
      if (last && typeof last.t === "number" && t > last.t) {
        var d = t - last.t;
        if (d >= 0 && d <= 60000) gap = d;
      }
      _opsRing.push({ t: t, k: "step", f: nmStr, w: "step", g: gap, el: null });
      while (_opsRing.length > OPS_RING_MAX) _opsRing.shift();
    } catch (_) {}
  }
  try {
    if (typeof window !== "undefined") {
      window.__axlxRecNoteOp = _recNoteOp;
      window.__axlxRecNoteName = _recNoteName;
    }
    /**
     * 2026-11-14 竹内さん「画面録画したのみたら一連の動き学習できるからいまみてみて」:
     *   `page-script.js` は**ページの世界**で動くので、ここの `window.__axlxRecNoteName` は**見えない**。
     *   → **postMessage で受ける**（地域・駅の段が学習の記録に入るように）。
     *   ⚠ 受けるのは**名前だけ**。区の名前・入力した中身は入っていない。
     */
    window.addEventListener("message", function (e) {
      try {
        if (!e || e.source !== window || !e.data || e.data.from !== "axlx-rec-note-name") return;
        var n = typeof e.data.name === "string" ? e.data.name.slice(0, 30) : "";
        if (n) _recNoteName(n);
      } catch (_) {}
    });
  } catch (_) {}
  /**
   * 2026-11-13 竹内さん「ちゃんと読み取れるようになったかな」→ `shot_ops` が 0件
   *   ⚠ `pointer-ui` の `tap()` だけに頼ると、**拡張が `el.click()` で直接押した時**（ポインタを使わない所）は
   *     何も残らない。録画モードで押しているのは拡張なので、それでは材料が入らない。
   *   → **このページで起きた click / change を（人でも拡張でも）拾う**。
   *     ⚠ `isTrusted` で人の操作だけに絞らない（録画は拡張の操作を覚えたい）。
   *     ⚠ 入れるのは**欄の名前・種類・時刻だけ**（入力した中身は入れない）。
   */
  try {
    var _cap = function (e) {
      try {
        if (!e || !e.target) return;
        /**
         * 2026-11-14 竹内さん「通常モードで行っているのはスタッフ等人間が実際の動きをしているので
         *   そこを理解して学習する」:
         *   `isTrusted === true` は**人が起こした操作**、`false` は**拡張が作った操作**。
         *   → この区別を記録に残す（`by`）。学習は「人の手本」を優先できる。
         *   ⚠ ここを捨てていたので、実測で 394件すべて `by` が無かった。
         */
        var _by = (e.isTrusted === true) ? "human" : "auto";
        _pushOp(e.type || "click", e.target, _by);
        /**
         * 2026-11-14 竹内さん「プルダウンのところとか、さっき改善されたかな」
         *   → **自動モード（拡張が押す）では押した欄が1つも記録されていなかった**（実測で発覚）。
         *
         *   ⚠ 理由: 押した欄の名前・順番を作る `recordPoint` は `guarded`（**`isTrusted` だけ**）の中にあり、
         *     拡張の `el.click()` は**通らない**。だから `point_fields` / `field_order` が空で、
         *     自動モードでは「どの欄を・どの順で押したか」を学べなかった。
         *
         *   → **この受け口（click/change を両方拾う）でも、押した欄を積む**。
         *     ⚠ 人の手本とは混ぜない: `by` を付けて分ける（学習は `human` を優先する）。
         *     ⚠ 拡張の合成クリックは座標が 0,0 なので、位置は**要素の真ん中**として記録する（`syn:true`）。
         */
        try {
          if ((e.type === "click" || e.type === "change") && e.target) {
            _pushPoint(e.target, _by, e);
          }
        } catch (_) {}
      } catch (_) {}
    };
    document.addEventListener("click", _cap, true);
    document.addEventListener("change", _cap, true);
  } catch (_) {}
  /**
   * 押した欄を `axlx_human_points` に積む（2026-11-14・自動モードでも順番を学ぶため）。
   *
   *   ⚠ 入れるのは**欄の名前・位置（割合）・種類・時刻**だけ（入力した中身は入れない）。
   *   ⚠ `syn:true` … 拡張の合成クリック（座標0,0）なので位置は**推測（真ん中）**。
   *   ⚠ 同じ欄が続けて来たら1つに畳む（click と change が両方来るため）。
   */
  function _pushPoint(el, by, ev) {
    try {
      if (!el || !L || !L.fieldName) return;
      var name = L.fieldName(el);
      if (!name) return;                      // 名前が取れない（img/body 等）は積まない
      var r = el.getBoundingClientRect ? el.getBoundingClientRect() : null;
      if (!r || !(r.width > 0 && r.height > 0)) return;
      var syn = (by === "auto");
      var fx = syn ? 0.5 : ((Number(ev.clientX) - r.left) / r.width);
      var fy = syn ? 0.5 : ((Number(ev.clientY) - r.top) / r.height);
      if (!syn && !(fx >= -0.2 && fx <= 1.2 && fy >= -0.2 && fy <= 1.2)) return;
      var cur = _livePoints || {};
      var t = Date.now();
      /**
       * 同じ欄の click → change は1回に畳む（120〜400ms 以内）。
       *   ⚠ 畳まないと「city_code[] → city_code[]」のように同じ欄が並び、順番が濁る。
       */
      if (cur.__last && cur.__last.f === name && t - Number(cur.__last.t || 0) < 400) {
        cur.__last.n = (Number(cur.__last.n) || 1) + 1;
        cur.__last.t = t;
        _savePoints(cur);
        return;
      }
      // 押された順に足す（同じ欄が離れて2回目なら**残す**＝押し直しとして学ぶ）
      if (_orderLive.length < 60) _orderLive.push(name);
      var prev = cur[name] || { n: 0, x: 0, y: 0, xs: [], ys: [] };
      var n = (Number(prev.n) || 0) + 1;
      var xs = (Array.isArray(prev.xs) ? prev.xs : []).concat([Math.round(Math.max(0, Math.min(1, fx)) * 100) / 100]).slice(-20);
      var ys = (Array.isArray(prev.ys) ? prev.ys : []).concat([Math.round(Math.max(0, Math.min(1, fy)) * 100) / 100]).slice(-20);
      var med = function (a) { if (!a.length) return 0; var s = a.slice().sort(function (p, q) { return p - q; }); var m = Math.floor(s.length / 2); return s[m]; };
      cur[name] = {
        n: n, x: med(xs), y: med(ys), xs: xs, ys: ys,
        wk: (L.kindOfEl ? L.kindOfEl(el) : null) || prev.wk || null,
        by: by || prev.by || null,
      };
      cur.__last = { f: name, t: t, n: 1 };
      _savePoints(cur);
    } catch (_) {}
  }
  var _livePoints = null;
  var _livePointsAt = 0;
  /**
   * 2026-11-14: **押された順**（人も拡張も・重複は畳む）。
   *   ⚠ `_livePoints` は「欄ごとの回数」しか持たないので、**順番**はここで別に持つ。
   *     これが `field_order` になり、「賃料 → 徒歩 → 更新日」の流れを学べる。
   */
  var _orderLive = [];
  function _savePoints(cur) {
    try {
      if (!cur) return;
      var o = {}; o[POINTS_KEY2] = cur;
      chrome.storage.local.set(o);
      _livePointsAt = Date.now();
    } catch (_) {}
  }
  try {
    chrome.storage.local.get([POINTS_KEY2], function (r) {
      try { _livePoints = (r && r[POINTS_KEY2]) || {}; } catch (_) { _livePoints = {}; }
    });
  } catch (_) { _livePoints = {}; }
  /**
   * 2026-11-14 竹内さん「ほかちゃんと録画したの学習できてるかな」:
   *   ⚠ 実測: 版 2.7.22 の写真 **234枚すべて `shot_ops` が空**だった（旧版 2.7.21 は 79枚ついていた）。
   *     録画（1.5〜3.5秒ごと）の経路で `ops` が空＝**操作の輪（_opsRing）が空**で渡っている。
   *   → **なぜ空なのかを記録に残す**（推測で直さない）。
   *     `axlx_ops_diag` … 最後に聞かれた時の「輪の長さ・click を拾った回数・録画中か・時刻」
   */
  var _opsAsk = 0;           // 何回聞かれたか
  function _opsDiag(asked) {
    try {
      var d = {
        ring: _opsRing.length,
        seen: _opsSeen,
        asked: _opsAsk,
        at: Date.now(),
        site: (typeof site !== "undefined" ? site : null),
        watching: (typeof watching !== "undefined" ? watching : null),
        shooting: _shooting,
        last: _opsRing.length ? _opsRing[_opsRing.length - 1].f : null,
      };
      var o = {}; o.axlx_ops_diag = d;
      try { chrome.storage.local.set(o); } catch (_) {}
      try { console.log("[ops] " + (asked ? "聞かれた" : "更新") + ": 輪" + d.ring + "件 / 拾った" + d.seen + "回 / 見張り" + d.watching + " / 撮影" + d.shooting); } catch (_) {}
    } catch (_) {}
  }
  /** 写真と一緒に送る「直前までの操作」（新しい順に最大40件） */
  function _recentOps() {
    try {
      _opsAsk++;
      _opsDiag(true);
      // ⚠ DOM 要素（el）は送らない（JSON にできない・個人情報ではないが重い）
      return _opsRing.slice(-OPS_RING_MAX).map(function (o) {
        /**
         * 2026-11-14 竹内さん「データベースの録画している部分からの学習もちゃんと理解するように
         *   通常モードで行っているのはスタッフ等人間が実際の動きをしているのでそこを理解して学習する」:
         *
         *   ⚠ `by`（**人が押したのか拡張が押したのか**）を**捨てていた**ので、
         *     学習する時に「人の手本」と「機械の動き」を区別できなかった（実測: by が全部なし 394件）。
         *   → `by` も送る（"human" / "auto"）。サーバーと学習が**人の動きだけ**を手本にできる。
         *   ⚠ 拡張が押した物は `isTrusted=false` なので、記録する時に判定して入れる。
         */
        return { t: o.t, k: o.k, f: o.f, w: o.w, g: o.g, by: o.by || null };
      });
    } catch (_) { return null; }
  }
  /**
   * 2026-11-14: `_recentOps` の**中身と診断**を一緒に返す（なぜ空かを background が残せるように）。
   */
  function _recentOpsWithDiag() {
    try {
      return {
        ops: _recentOps() || [],
        diag: { ring: _opsRing.length, seen: _opsSeen, asked: _opsAsk, watching: watching, shooting: _shooting },
      };
    } catch (_) { return { ops: [], diag: null }; }
  }
  /**
   * 2026-11-13 竹内さん「録画から学習できるのか」:
   *   録画モードの写真にも**押した操作**を付ける（押す順番の材料）。
   *   background が「直近の操作をください」と聞いてくるので答える。
   *   ⚠ 送るのは**欄の名前・操作の種類・時刻だけ**（入力した中身は送らない）。
   */
  try {
    if (typeof chrome !== "undefined" && chrome.runtime && chrome.runtime.onMessage) {
      /**
       * 2026-11-14: 受け口は先頭でも付けている（ライブラリ待ちの間に聞かれても理由を返せる）。
       *   ここでは**実際の操作を返せる**ように状態へ関数を渡す（先頭の受け口がこれを使う）。
       */
      try {
        _recBoot.__axlxHumanLearnRecState = {
          why: null,
          answer: function (sendResponse) {
            try {
              var out = _recentOpsWithDiag();
              sendResponse({ ok: true, ops: out.ops || [], diag: out.diag });
            } catch (_) { try { sendResponse({ ok: true, ops: [] }); } catch (__) {} }
          },
        };
      } catch (_) {}
      /**
       * 2026-11-13 竹内さん「ほかに抜けている箇所はあるのか。原因見つけて改善する」:
       *   写真と一緒に送る**動きの癖**（速さ・曲がり・押す位置・スクロール・操作の間）を返す。
       *   ⚠ 旧は background が `motion` を全部ゼロで送っていたので、
       *     写真つきの行（＝記録の大半）には何も入っていなかった。
       */
      chrome.runtime.onMessage.addListener(function (msg, _s, sendResponse) {
        if (!msg || msg.type !== "axlx-recent-motion") return;
        try {
          var det = { moves: [], points: [], scrolls: [] };
          try { det = rec.detail(); } catch (_) {}
          var LL = (typeof self !== "undefined" ? self : window).AxlxHumanLearn || L;
          var m = (LL && LL.summarizeMotion) ? LL.summarizeMotion(det) : null;
          sendResponse({ ok: !!m, motion: m || null });
        } catch (_) { try { sendResponse({ ok: false, motion: null }); } catch (__) {} }
        return true;
      });
    }
  } catch (_) {}
  var SHOT_MIN_GAP_MS = 400;   // これより短い間隔では撮らない
  var SHOT_MAX_PER_SESSION = 300; // 1ページで撮る上限（暴走しないように）
  function shootAfter(kind, el, pt) {
    try {
      /**
       * 2026-11-11 竹内さん「このお客さんちゃんと保存されてたかな？」→ 学習は入るが写真が0枚。
       *   どこで止まっているか分からないと直せないので、**試した回数と結果**を残す。
       *   storage: axlx_human_shot_diag = { tried, ok, last_error, last_at }
       */
      var diag = function (ok, err) {
        try {
          chrome.storage.local.get(["axlx_human_shot_diag"], function (r) {
            var d = (r && r.axlx_human_shot_diag) || { tried: 0, ok: 0 };
            d.tried = (Number(d.tried) || 0) + 1;
            if (ok) d.ok = (Number(d.ok) || 0) + 1;
            d.last_error = ok ? null : String(err || "?");
            d.last_at = Date.now();
            var o = {}; o.axlx_human_shot_diag = d;
            try { chrome.storage.local.set(o); } catch (_) {}
          });
        } catch (_) {}
      };
      /**
       * 2026-11-14 竹内さん「３にする」（小窓が開いた時だけ大きく撮る）:
       *   **押した直後に何が開いているか**を見た目だけで判定する。
       *
       *   "options" … プルダウンの中身（select を開いた・option が並んでいる）
       *   "modal"   … 小窓（地域・沿線の選択など。`.this_window` / `[role=dialog]` / `.modal`）
       *   "form"    … 条件の入力欄（検索の欄がある）
       *   "result"  … 検索結果の一覧
       *   "none"    … どれでもない
       *
       *   ⚠ 見るのは**要素があるか・見えているか**だけ。文字・入力値は読まない。
       *   ⚠ 判定できなければ "none"（＝小さく撮る＝容量を守る）。
       */
      var _openedKind = function () {
        try {
          var d = document;
          if (!d || !d.querySelector) return "none";
          var visible = function (el) {
            try { return !!el && el.offsetParent !== null; } catch (_) { return false; }
          };
          // ① プルダウンの選択肢が開いている（select の size が2以上／option が複数見えている）
          try {
            var sels = d.querySelectorAll("select");
            for (var i = 0; i < sels.length; i++) {
              var s = sels[i];
              if (!visible(s)) continue;
              // 開いている select は size が 1 より大きくなる（OS が描く一覧は DOM に出ないが、
              // サイト独自の一覧は div/ul で出るので ② で拾う）
              if (Number(s.size) > 1) return "options";
            }
          } catch (_) {}
          // ② サイト独自の一覧（ul/div の選択肢がいくつも見えている）
          try {
            var lists = d.querySelectorAll("ul.selectBox, .select_box, .dropdown, .options, [class*='selectList'], [class*='optionList']");
            for (var j = 0; j < lists.length; j++) {
              if (!visible(lists[j])) continue;
              var n = lists[j].querySelectorAll("li, div[data-value], a").length;
              if (n >= 3) return "options";
            }
          } catch (_) {}
          // ③ 小窓
          try {
            var modal = d.querySelector(".this_window, [role='dialog'], .modal, #modal, .modal_wrap");
            if (visible(modal)) return "modal";
          } catch (_) {}
          // ④ 検索結果 / 条件の欄
          try {
            if (d.querySelector(".building_tr, .building_list, [class*='building_tr']")) return "result";
            if (d.querySelector("select[name='rental_cost2'], input[name='city_code[]'], div.go_search")) return "form";
          } catch (_) {}
          return "none";
        } catch (_) { return "none"; }
      };
      // 2026-11-11 竹内さん「写真ちゃんと送られたかな？」:
      //   旧は `if (!watching)` で弾いていた（＝自動・AIX では撮らない）。写真はモードに関係なく撮る。
      /**
       * 2026-11-14 竹内さん「さっきいれているデータベースをみる」→ **実データで判明**:
       *   2.7.50 は写真 167/168件（99%）撮れていたのに、2.7.55 は **0枚**だった。
       *   ⚠ 原因: `watching`（人の動きを見張っている印）が false だと撮らない作りだった。
       *     `watching` は「人の動きを覚える」ための印で、**写真とは別の話**。
       *     見張りが止まる（モード切替・ページの作り直し・ライブラリ待ち）と**写真も止まった**。
       *   → **写真は `watching` に関係なく撮る**（モード・見張りの状態に依存しない）。
       *     止める設定は `axlxShotOff` だけ（人が明示的に切った時）。
       */
      try { if (!shouldShoot({ axlxShotOff: (window.__axlxShotOff === true) })) { diag(false, "shot_off"); return; } } catch (_) {}
      var now = Date.now();
      /**
       * 2026-11-11 竹内さん「写真撮ってるかな？」→ 0枚のまま。
       *   `_shotPending` は応答が返らないと**永久に true**になり、以降すべて弾かれていた
       *   （＝1回失敗すると二度と撮らない）。3秒たったら諦めて次を撮る。
       */
      if (_shotPending && now - _shotPendingAt < 3000) return;   // 撮っている最中（3秒まで）
      if (_shotPending) { _shotPending = false; diag(false, "timeout_stuck"); }  // 張り付きを解く
      if (now - _shotLast < SHOT_MIN_GAP_MS) return;   // 間引きは「失敗」ではない（数えない）
      if (_shotCount >= SHOT_MAX_PER_SESSION) { diag(false, "max_reached"); return; }
      _shotLast = now;
      _shotCount++;
      _shotPending = true;
      _shotPendingAt = now;
      chrome.runtime.sendMessage({
        type: "axlx-human-shot",
        site: site,
        kind: kind,
        what: el ? (L.fieldName ? L.fieldName(el) : null) : null,
        x: pt && typeof pt.x === "number" ? pt.x : null,
        y: pt && typeof pt.y === "number" ? pt.y : null,
        /**
         * 2026-11-14 竹内さん「３にする」（小窓が開いた時だけ大きく撮る）:
         *   ⚠ background は「大きく撮るか」を判断する材料を持っていない（DOM が無い）。
         *     判断できるのは**このページ側**だけ。
         *   → **押した直後に小窓（プルダウン・ダイアログ）が開いているか**を調べて一緒に送る。
         *     background は `opened` が modal/options の時だけ大きく撮る（1280px）。
         *   ⚠ 見るのは**見た目だけ**（中身の文字は読まない・入力値も触らない）。
         */
        opened: _openedKind(),
        /**
         * 2026-11-13 竹内さん「写真から学習する。押す場所や押す順番などもりかいできるから」
         *   「おしかたのボタンの仕様の理解の為にも」:
         *   この写真の**直前までの操作の並び**を一緒に送る（時刻・種類・どの欄か）。
         *   → 写真と「何を押した直後か」が結びつき、後から
         *     「この画面では次にこれを押す」を学べる。
         *   ⚠ 送るのは**欄の名前と操作の種類・時刻だけ**（入力した中身・文字は送らない）。
         */
        ops: _recentOps(),
      }, function (res) {
        void chrome.runtime.lastError;
        _shotPending = false;
        if (res && res.ok) {
          diag(true, null);
          try {
            var so = {};
            so.axlx_human_shot = { key: res.shot_key, at: Date.now(), seq: res.seq, run_id: res.run_id };
            chrome.storage.local.set(so);
          } catch (_) {}
        } else {
          diag(false, (res && res.error) || (chrome.runtime.lastError && chrome.runtime.lastError.message) || "no_response");
        }
      });
    } catch (e) {
      _shotPending = false;
      diag(false, "send_error: " + String((e && e.message) || e));
    }
  }
    try {
      chrome.storage.local.get([KEY], function (r) {
        try {
          var next = L.mergeAggregate(r && r[KEY], add);
          next.at = Date.now();
          next.site = site;
          var o = {}; o[KEY] = next;
          /**
           * 2026-11-11 竹内さん「データたまって理解するたび反映」:
           *   貯まった**その場で**「動きの癖」を作り直して別のキー（axlx_human_profile）に置く。
           *   → 見えるカーソル（pointer-ui.js）がこのキーの変化を見て、**次の動きから**新しい癖で動く。
           *     ページを開き直さなくても、操作するほど動きが人の実測に寄っていく。
           */
          try {
            var prof = L.profileFrom(next);
            if (prof) o[PROFILE_KEY] = prof;
          } catch (_) {}
          /**
           * 2026-11-13 竹内さん「撮影したところからぼたんの押す場所の確認や移動の部分で学習した部分あるか」:
           *   押した位置を**要素ごと**に残す（`axlx_human_points`）。
           *   次に同じボタン・同じ欄を押す時、見えるカーソルが**その人の押した場所**を狙う。
           *   例: rental_cost2 → { x:0.10, y:0.14, n:6 }
           *   ⚠ 押した**回数（n）が2以上の物だけ**使う（1回だけは偶然かもしれない）。
           */
          try {
            var pf = (next.points && next.points.fields) || null;
            if (pf && typeof pf === "object") {
              chrome.storage.local.get([POINTS_KEY2], function (rr) {
                try {
                  var cur = (rr && rr[POINTS_KEY2]) || {};
                  var changed = false;
                  Object.keys(pf).slice(0, 60).forEach(function (k) {
                    var v = pf[k];
                    if (!v || typeof v.x !== "number" || typeof v.y !== "number") return;
                    var old = cur[k] || null;
                    var nOld = old ? Number(old.n) || 0 : 0;
                    var nNew = Number(v.n) || 0;
                    if (nNew <= nOld) return;
                    // 回数の多い方（新しい実測）に寄せる
                    cur[k] = { x: v.x, y: v.y, n: nNew };
                    changed = true;
                  });
                  if (changed) {
                    var oo = {}; oo[POINTS_KEY2] = cur;
                    try { chrome.storage.local.set(oo); } catch (_) {}
                  }
                } catch (_) {}
              });
            }
          } catch (_) {}
          chrome.storage.local.set(o, function () {
            _saving = false;
            rec.reset(); // 操作・動き・押した場所・スクロールをまとめて空にする
            try { void chrome.runtime.lastError; } catch (_) {}
            // 2026-11-11: 理解した内容をその場で見せる（反映されていることが分かる）
            try { if (o[PROFILE_KEY]) paintLearned(o[PROFILE_KEY]); else paintBadge(); } catch (_) {}
            /**
             * 2026-11-11 竹内さん「今このお客さんを普通モードでやったんやけど動き理解できているかな」:
             *   貯めた直後に**その場で**DB へ送る（別のスクリプトの変化待ちに頼らない＝確実に届く）。
             *   送る係（human-learn-upload.js）が居れば、それに頼む。居なければ何もしない（貯まるだけ）。
             */
            try {
              var U = (typeof self !== "undefined" ? self : window).__axlxHumanMotionUploadNow;
              if (typeof U === "function") U(next);
            } catch (_) {}
            console.log("[AX] 人の動きを貯めました:", "操作" + next.n + "・マウス" + (next.moves ? next.moves.n : 0)
              + "・押した所" + (next.points ? next.points.n : 0) + "・スクロール" + (next.scrolls ? next.scrolls.n : 0)
              + (o[PROFILE_KEY] ? "／理解した動き: 速さ" + o[PROFILE_KEY].speed_px_s : "（まだ材料不足）"));
          });
        } catch (_) { _saving = false; }
      });
    } catch (_) { _saving = false; }
  }

  /**
   * 2026-11-11 竹内さん「動きも学習させたい」:
   *   自動モードでも**拡張自身の動き**（見えるカーソルの移動・押した位置・間隔）を覚える。
   *   ⚠ 人の動きとは**別の入れ物**に入れる（混ぜると「人の速さ」の実測が壊れる）。
   *   ・`axlx_auto_motion` に集計（速さ・曲がり・押した位置・スクロール・間隔）
   *   ・自動モードで動いた時だけ書く。通常・スタッフでは今まで通り `axlx_human_learn`（人の実測）
   */
  var AUTO_KEY = "axlx_auto_motion";
  var _autoOps = [];
  var _autoLastAt = 0;
  var _autoLastEl = null;
  var _autoSaving = false;
  /** 拡張が押す直前に呼ぶ（pointer-ui の位置と要素を残す） */
  function noteAutoOp(kind, el, extra) {
    try {
      var t = Date.now();
      var gap = _autoLastAt ? Math.min(120000, t - _autoLastAt) : null;
      _autoLastAt = t;
      var P = (typeof self !== "undefined" ? self : window).AxlxPointerUi;
      var pos = (P && P.visiblePosition) ? P.visiblePosition() : null;
      var r = null, fx = null, fy = null;
      try {
        if (el && el.getBoundingClientRect) {
          r = el.getBoundingClientRect();
          // 押す位置は「カーソルが居た所」を要素の中の割合にする（人が見た点）
          if (pos && r.width > 0 && r.height > 0) {
            fx = Math.round(Math.max(0, Math.min(1, (pos.x - r.left) / r.width)) * 100) / 100;
            fy = Math.round(Math.max(0, Math.min(1, (pos.y - r.top) / r.height)) * 100) / 100;
          }
        }
      } catch (_) {}
      _autoOps.push({
        t: t, k: String(kind || "click").slice(0, 12),
        f: (L && L.fieldName) ? L.fieldName(el) : null,
        gap: gap, x: fx, y: fy,
        scroll: (extra && typeof extra.dy === "number") ? Math.round(extra.dy) : null,
      });
      if (_autoOps.length > 200) _autoOps.shift();
      if (_autoOps.length >= 20 && !_autoSaving) {
        _autoSaving = true;
        flushAuto();
      }
    } catch (_) {}
  }
  /** 自動モードの動きを集計して貯める */
  function flushAuto() {
    try {
      if (!_autoOps.length) { _autoSaving = false; return; }
      var adds = L.summarize(_autoOps);
      var det = { moves: [], points: [], scrolls: [] };
      // 押した位置（拡張が狙った点）
      _autoOps.forEach(function (o) {
        if (o.x != null && o.y != null) det.points.push({ f: o.f || "?", x: o.x, y: o.y, s: "auto" });
        if (o.scroll != null) det.scrolls.push({ dy: o.scroll, dir: o.scroll > 0 ? "down" : "up", y: 0 });
      });
      var motion = L.summarizeMotion(det);
      adds.moves = motion.moves; adds.points = motion.points; adds.scrolls = motion.scrolls;
      /**
       * 2026-11-14 竹内さん「自動検索の部分学習反映されるようにちゃんと連携する
       *   今自動検索がちゃんと学習連携されていない可能性たかい」:
       *   ⚠ **その通りだった**。自動モードの動きは `axlx_auto_motion`（PC の中）に貯めるだけで、
       *     **DB へは一度も送っていなかった**（実測: `by_mode` の aix が0件のまま）。
       *     だから自動モードは「記録が0件＝学べていない」と毎回言われ、改善もされなかった。
       *   → 人の動きと同じ送り口（`__axlxHumanMotionUploadNow`）で **mode を付けて**送る。
       *     ⚠ 入れるのは欄の名前・種類・位置・間隔だけ（入力した中身は入れない）。
       *     ⚠ 人の実測とは**別の行**で送る（mode="aix"）。混ぜない。
       */
      try {
        var _U = (typeof self !== "undefined" ? self : window).__axlxHumanMotionUploadNow;
        if (typeof _U === "function") {
          _U({
            v: 1, n: adds.n, kinds: adds.kinds || {}, gap_ms: adds.gap_ms || null,
            gaps: adds.gaps || [], fields: adds.fields || [], order: adds.order || [],
            moves: motion.moves, points: motion.points, scrolls: motion.scrolls,
            opens: (motion.opens && motion.opens.byField) || {},
            open_kinds: (motion.opens && motion.opens.kinds) || {},
            site: site, at: Date.now(), source: "extension_auto",
          }, { mode: "aix", site: site });
        }
      } catch (_) {}
      chrome.storage.local.get([AUTO_KEY], function (r) {
        try {
          var prev = r && r[AUTO_KEY];
          var next = L.mergeAggregate(prev, adds);
          next.at = Date.now();
          next.site = site;
          next.source = "extension_auto";   // ← 人の実測と区別する印
          var o = {}; o[AUTO_KEY] = next;
          chrome.storage.local.set(o, function () {
            _autoOps = [];
            _autoSaving = false;
            try { void chrome.runtime.lastError; } catch (_) {}
          });
        } catch (_) { _autoSaving = false; }
      });
    } catch (_) { _autoSaving = false; }
  }
  try { window.__axlxNoteAutoOp = noteAutoOp; } catch (_) {}

  // ── モードを見る（学習は通常・スタッフの時だけ／写真はどのモードでも）──
  var KEYS = ["staffMode", "staffModeAt", "aixMode", "autoModeAt", "aiMode", "axlxShotOff"];
  var _shooting = false;
  function apply(st) {
    if (shouldLearn(st)) { startWatching(); ensureBadge(); }
    else { stopWatching(); removeBadge(); }
    /**
     * 2026-11-11 竹内さん「写真ちゃんと送られたかな？」→ 0枚。
     *   写真は学習（onOp）の中から撮っていたので、**自動・AIX では一度も撮られなかった**。
     *   → 写真は**どのモードでも**撮る（自前の見張り）。学習とは別にする。
     */
    if (shouldShoot(st)) startShooting();
    else stopShooting();
  }

  /** 写真を撮る見張り（モードに関係なく動く。人も拡張も押したら撮る） */
  function startShooting() {
    if (_shooting) return;
    _shooting = true;
    try {
      var h = function (e) {
        /**
         * 2026-11-14 竹内さん「さっきいれているデータベースをみる」→ **実データで判明**:
         *   ⚠ 旧は `if (!e.isTrusted) return;` で**拡張の押下を撮らなかった**。
         *     そのため**自動モード（拡張が押す）では写真が1枚も撮れず**、
         *     画像から学ぶ材料が無かった（実測: 2.7.55 で写真0枚）。
         *   → **人でも拡張でも撮る**（写真は「画面の記録」なので、誰が押したかは関係ない）。
         *     ⚠ 人の手本と混ぜない区別は `shot_ops` の `by`（human / auto）で残す。
         */
        if (!e) return;
        _noteShotDiag((e.isTrusted ? "trusted_" : "auto_") + (e.type || "?"));
        // 2026-11-13: 操作の記録は下の `_cap`（人も拡張も拾う）に1本化した（二重に積まない）
        shootAfter(e.type, e.target, null);
      };
      // 人が押した時・打った時・選んだ時＋**拡張が押した時**（自動モードの画面も残す）
      document.addEventListener("click", h, true);
      document.addEventListener("change", h, true);
      window.addEventListener("wheel", function (e) {
        if (e) { _noteShotDiag(e.isTrusted ? "trusted_wheel" : "auto_wheel"); shootAfter("wheel", null, null); }
      }, { passive: true, capture: true });
      _shootDetach = function () {
        try { document.removeEventListener("click", h, true); document.removeEventListener("change", h, true); } catch (_) {}
      };
      console.log("[AX] 画面の写真: どのモードでも撮ります（" + site + "）");
      // 起動直後に1枚（「撮れるか」を確かめられるように）
      try { setTimeout(function () { shootAfter("startup", null, null); }, 1500); } catch (_) {}
    } catch (_) {}
  }
  var _shootDetach = null;
  function stopShooting() {
    if (!_shooting) return;
    _shooting = false;
    try { if (_shootDetach) _shootDetach(); } catch (_) {}
    _shootDetach = null;
  }
  /** 写真の通り道を残す（どこで止まるか分かるように） */
  function _noteShotDiag(why) {
    try {
      chrome.storage.local.get(["axlx_human_shot_diag"], function (r) {
        var d = (r && r.axlx_human_shot_diag) || { tried: 0, ok: 0 };
        d.last_why = why;
        d.last_why_at = Date.now();
        try { chrome.storage.local.set({ axlx_human_shot_diag: d }); } catch (_) {}
      });
    } catch (_) {}
  }
  try {
    chrome.storage.local.get(KEYS, function (r) { apply(r || {}); });
    chrome.storage.onChanged.addListener(function (ch, area) {
      if (area !== "local" || !ch) return;
      if (!("staffMode" in ch) && !("aixMode" in ch) && !("autoModeAt" in ch) && !("aiMode" in ch) && !("axlxShotOff" in ch)) return;
      chrome.storage.local.get(KEYS, function (r) { apply(r || {}); });
    });
  } catch (_) {}

  // 1分ごとに書き出す（見えていないタブでは書き出さない＝裏のタブを止めない）
  timer = setInterval(function () {
    if (document.hidden) return;
    if (!watching) return;
    paintBadge();   // 貯まっている数を更新（増えていくのが見える）
    save(false);
  }, SAVE_EVERY_MS);

  // タブを閉じる・離れる時に書き出す
  window.addEventListener("pagehide", function () { save(true); });
  document.addEventListener("visibilitychange", function () { if (document.hidden) save(false); else paintBadge(); });

  // 外から集計を読めるように（点検・確かめ用）
  window.__axlxHumanLearnReport = function () {
    var det = { moves: [], points: [], scrolls: [] };
    try { det = rec.detail(); } catch (_) {}
    return {
      watching: watching, site: site, ops: rec.count(), lock: LEARN_LOCK,
      shooting: _shooting,   // 2026-11-11: 写真を撮る見張りが動いているか（モードに関係なく動く）
      moves: (det.moves || []).length, points: (det.points || []).length, scrolls: (det.scrolls || []).length,
      detail: det,          // 中身（何をどう覚えたか）も見られるように
      summarizeMotion: function () { try { return L.summarizeMotion(det); } catch (_) { return null; } },
    };
  };
  /**
   * 2026-11-11 竹内さん「動き理解できているかな」:
   *   いま貯まっている物と、DB に貯まっている物を**その場で**確かめられるようにする。
   *   コンソールで `__axlxLearnNow()` と打つと全部出る。
   */
  window.__axlxLearnNow = function (cb) {
    var out = { この画面: window.__axlxHumanLearnReport() };
    try {
      chrome.storage.local.get([KEY, PROFILE_KEY, "axlx_human_learn_uploaded_at"], function (r) {
        out.貯まった合計 = r && r[KEY] ? { 操作: r[KEY].n, マウス: r[KEY].moves && r[KEY].moves.n, 押した所: r[KEY].points && r[KEY].points.n, スクロール: r[KEY].scrolls && r[KEY].scrolls.n } : null;
        out.理解した動き = (r && r[PROFILE_KEY]) || null;
        out.最後に送った時刻 = r && r.axlx_human_learn_uploaded_at ? new Date(r.axlx_human_learn_uploaded_at).toLocaleString("ja-JP") : "まだ";
        console.log("[AX] 学習の状態:", out);
        if (typeof cb === "function") cb(out);
      });
    } catch (_) { console.log("[AX] 学習の状態:", out); if (typeof cb === "function") cb(out); }
    return out;
  };
  /** いま貯まっている物を、その場で DB へ送る（確かめたい時） */
  window.__axlxLearnSendNow = function () {
    try {
      chrome.storage.local.get([KEY], function (r) {
        var agg = r && r[KEY];
        if (!agg || !agg.n) { console.warn("[AX] 送る物がありません（まだ貯まっていない）"); return; }
        var U = (typeof self !== "undefined" ? self : window).__axlxHumanMotionUploadNow;
        if (typeof U !== "function") { console.warn("[AX] 送る係（human-learn-upload.js）が居ません"); return; }
        U(agg);
        console.log("[AX] DB へ送りました:", agg.n + "回分");
      });
    } catch (_) {}
  };
  } // start() ここまで（2026-11-14: ライブラリ待ちの後に始められるように関数にまとめた）
})();
