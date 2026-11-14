(function(){
  try {
    var di = Object.getOwnPropertyDescriptor(Window.prototype, 'innerWidth');
    if (di && di.get) Object.defineProperty(window, 'innerWidth', {
      get: function(){ return Math.max(di.get.call(window), 1300); },
      configurable: true
    });
  } catch(e){}
  try {
    var do2 = Object.getOwnPropertyDescriptor(Window.prototype, 'outerWidth');
    if (do2 && do2.get) Object.defineProperty(window, 'outerWidth', {
      get: function(){ return Math.max(do2.get.call(window), 1300); },
      configurable: true
    });
  } catch(e){}

  window.addEventListener('resize', function() {
    function tryClick(delay) {
      setTimeout(function() {
        var all = document.querySelectorAll('a,button,input,div,span,td,p');
        for (var i = 0; i < all.length; i++) {
          var el = all[i];
          if (!el.offsetParent) continue;
          var txt = (el.textContent || el.value || '').trim();
          if (txt.indexOf('検索条件を表示') >= 0) {
            el.click();
            return;
          }
        }
      }, delay);
    }
    tryClick(_hd(300));
    tryClick(_hd(800));
    tryClick(_hd(1800));
  });

  // ── リアプロ自動入力 ──────────────────────────────────────────────
  var RENT_OPTS = [-1,20000,25000,30000,35000,40000,45000,50000,55000,60000,65000,70000,75000,80000,85000,90000,95000,100000,110000,120000,130000,140000,150000,160000,170000,180000,190000,200000,250000,300000,350000,400000,450000,500000,600000,700000,800000,900000,1000000];
  var AGE_OPTS  = [-1,1,3,5,7,10,15,20,25,30,35,40,45,50];
  var AREA_OPTS = [-1,15,20,25,30,35,40,45,50,55,60,70,80,100];
  var STRUCTURE_MAP = {
    "鉄骨鉄筋コンクリート造":"1","SRC":"1","SRC造":"1",
    "鉄筋コンクリート造":"2","RC":"2","RC造":"2",
    "鉄骨造":"3","S造":"3",
    "重量鉄骨造":"4",
    "軽量鉄骨造":"5",
    "木造":"6",
    "木造一部RC造":"7"
  };
  var FLOOR_MAP = {
    "ワンルーム":"1","1R":"1","スタジオタイプ":"2","スタジオ":"2",
    "1K":"3","1DK":"4","1LDK":"6",
    "2K":"7","2DK":"8","2LDK":"9",
    "3K":"10","3DK":"11","3LDK":"12",
    "4K":"13","4DK":"14","4LDK":"15",
    "5K":"16","5DK":"17","5LDK":"18",
    "6LDK":"19","メゾネット":"21","テナント":"20"
  };
  // リアプロにSLDKは存在しないため代替間取りIDへ展開
  // 1SLDK → 1LDK(6) + 2DK(8) + 2LDK(9)
  var SLDK_SUBSTITUTE = {
    "1SLDK":["6","8","9"],"2SLDK":["9","11","12"],
    "3SLDK":["12","14","15"],"4SLDK":["15","17","18"]
  };
  // SLDK展開後の最上位間取り（範囲選択でtoFloorがさらに上の場合に使う基点）
  var SLDK_UPPER_LDK = {
    "1SLDK":"2LDK","2SLDK":"3LDK","3SLDK":"4LDK","4SLDK":"5LDK"
  };

  // route_id → リアプロ路線名（モーダルのボタンテキストと一致）
  var ROUTE_LINE_MAP = {
    "6701":"大阪市高速軌道御堂筋線","6702":"大阪市高速軌道谷町線",
    "6703":"大阪市高速軌道四つ橋線","6704":"大阪市高速軌道中央線",
    "6705":"大阪市高速軌道千日前線","6706":"大阪市高速軌道堺筋線",
    "6707":"大阪市高速軌道南港ポートタウン線","6699":"大阪市高速軌道今里筋線",
    "6768":"大阪市高速軌道長堀鶴見緑地線","6711":"北大阪急行南北線",
    "6603":"大阪環状線","6767":"JR東西線",
    "6645":"片町線","6604":"桜島線","6650":"おおさか東線",
    "6426":"関西本線","6647":"阪和線","6605":"福知山線","6171":"東海道本線",
    "6541":"近鉄大阪線","6551":"近鉄難波・奈良線",
    "6555":"近鉄南大阪線","6557":"近鉄長野線","6558":"近鉄道明寺線","6563":"近鉄けいはんな線",
    "6651":"京阪電気鉄道京阪線","6658":"京阪電気鉄道中之島線","6652":"京阪電気鉄道交野線",
    "6661":"阪急電鉄京都線","6662":"阪急電鉄千里線","6664":"阪急電鉄神戸線",
    "6668":"阪急電鉄宝塚線","6669":"阪急電鉄箕面線",
    "6671":"阪神電鉄本線","6673":"阪神電鉄阪神なんば線",
    "6681":"南海電鉄南海本線",
    "6686":"南海電鉄高野線","6694":"南海電鉄泉北線",
    "6691":"南海電鉄空港線","6766":"南海電鉄汐見橋線","6684":"南海電鉄多奈川線","6683":"南海電鉄高師浜線",
    "6689":"阪堺電気軌道阪堺線","6690":"阪堺電気軌道上町線",
    "6709":"大阪モノレール本線","6772":"大阪モノレール彩都線",
    "6676":"能勢電鉄","6713":"水間鉄道水間線","6648":"関西空港線",
  };

  function nearestUp(opts, val) {
    for (var i = 0; i < opts.length; i++) {
      if (opts[i] !== -1 && opts[i] >= val) return String(opts[i]);
    }
    return String(opts[opts.length - 1]);
  }
  function nearestDown(opts, val) {
    var best = "-1";
    for (var i = 0; i < opts.length; i++) {
      if (opts[i] !== -1 && opts[i] <= val) best = String(opts[i]);
    }
    return best;
  }
  function setSelVal(name, val) {
    /**
     * 2026-11-11 竹内さん「通常モードなら押す場所理解しているのに自動モードでは理解できていない」:
     *   欄が**閉じている（畳まれている）**時は「＋」を押して開いてから入れる（案内モードと同じ）。
     */
    var el = document.querySelector('select[name="' + name + '"]');
    if (!el || val == null) return Promise.resolve(false);
    return _ensureFieldVisible(el, name, 2500).then(function () {
      try {
        /**
         * 2026-11-14 竹内さん「駅からの移動手段のところ 徒歩をプルダウンで選択するところできていなかった」:
         *   ⚠ 旧は `el.value = String(val)` の**代入だけ**だった。リアプロの「徒歩」の値が `"1"` でない、
         *     または `"徒歩"` を渡された場合、`value` に入れると**一致する選択肢が無い＝未選択に戻る**。
         *   → **値でも文字でも探して、見つかった選択肢の位置で選ぶ**（`selectedIndex`）。
         *     見つからなければ**何もしない**（未選択で上書きしない）。
         */
        var _want = String(val);
        var _idx = -1;
        try {
          for (var _q = 0; _q < el.options.length; _q++) {
            if (String(el.options[_q].value) === _want) { _idx = _q; break; }
          }
          if (_idx < 0) {
            var _wt = _want.replace(/\s+/g, "");
            for (var _q2 = 0; _q2 < el.options.length; _q2++) {
              var _txt = String(el.options[_q2].textContent || "").replace(/\s+/g, "");
              if (_txt === _wt || (_wt.length >= 1 && _txt.indexOf(_wt) === 0) || (_wt.length >= 2 && _txt.indexOf(_wt) >= 0)) { _idx = _q2; break; }
            }
          }
        } catch (_) { _idx = -1; }
        if (_idx < 0) return false;
        el.selectedIndex = _idx;
        if (!el.value || el.selectedIndex < 0) el.selectedIndex = _idx;
        el.dispatchEvent(new Event("change", {bubbles:true}));
        return true;
      } catch (_) {}
      return false;
    });
  }
  /**
   * 2026-11-10 v2.6.9 竹内さん「家賃のところも押したらいきなり入力されている。押したら家賃の部分を選択する形で動くように」
   *   旧は select の value を直接代入していた（プルダウンが開いて選ばれる様子が見えない＝貼り付けた動き）。
   *   新は **人がプルダウンを開いて選ぶ形**にする:
   *     ① カーソルが欄まで動く → ② 欄を押して開く（mousedown → focus → click）
   *     ③ 選ぶ候補までカーソルを動かす（キーボードの矢印キーも少し使う＝人の選び方）
   *     ④ 確定（change）→ ⑤ 閉じたのを見届ける
   *   ⚠ 画面のプルダウンの一覧（OS が描く部品）は拡張からは掴めないので、
   *      「開く操作」と「選ぶ動き」を順に出す形で人に近づける（実際の一覧は OS が描く）。
   *   値の入れ方（value＋change）は今まで通り＝サイトの検知は変えない。
   */
  /**
   * 2026-11-11 竹内さん「賃料のところプルダウンなのに直接入力になってしまっている」:
   *
   *   ネイティブの `<select>` は拡張の擬似クリックでは開かない（Chrome の仕様）。
   *   → **拡張が見える一覧を描く**（値は変えない・見た目だけ）。
   *   カーソルが選んだ行へ動き、行が光るので「選んでいる」ことが目で分かる。
   *
   *   ⚠ 拡張が描いた物は**押しても何もしない**（pointer-events:none）。値は呼ぶ側が入れる。
   *   ⚠ 画面の一番上に出す（他の物に隠れない）。最大 12 行まで（長すぎると画面を覆う）。
   */
  var _fakeDd = null;
  function _showFakeOptions(el) {
    try {
      _hideFakeOptions(null);
      var d = document;
      var r = el.getBoundingClientRect();
      var wrap = d.createElement("div");
      wrap.id = "axlx-fake-dd";
      wrap.style.cssText = [
        "position:fixed",
        "left:" + Math.round(r.left) + "px",
        "top:" + Math.round(r.bottom + 2) + "px",
        "min-width:" + Math.max(90, Math.round(r.width)) + "px",
        "max-height:260px", "overflow:hidden",
        "background:#fff", "border:1px solid #94a3b8", "border-radius:6px",
        "box-shadow:0 6px 20px rgba(0,0,0,.22)", "z-index:2147483646",
        "font:12px/1.4 -apple-system,BlinkMacSystemFont,'Segoe UI',sans-serif",
        "pointer-events:none", "user-select:none",
      ].join(";");
      var cur = el.selectedIndex;
      var rowEls = [];
      var n = Math.min(el.options.length, 12);
      // 選択中の物が下の方なら、その前後が見えるようにずらす
      var start = 0;
      if (cur > n - 3) start = Math.max(0, Math.min(el.options.length - n, cur - (n - 3)));
      for (var i = start; i < start + n; i++) {
        var op = el.options[i];
        var row = d.createElement("div");
        var sel = (i === cur);
        row.style.cssText = [
          "padding:3px 8px", "white-space:nowrap", "overflow:hidden", "text-overflow:ellipsis",
          sel ? "background:#2563eb;color:#fff;font-weight:700" : "color:#111",
        ].join(";");
        row.textContent = String(op.textContent || "").trim() || ("(値 " + op.value + ")");
        wrap.appendChild(row);
        rowEls[i] = row;
      }
      // 選んでいる行が一覧の中に見えるようスクロール
      (d.body || d.documentElement).appendChild(wrap);
      try {
        if (rowEls[cur]) rowEls[cur].scrollIntoView({ block: "nearest" });
      } catch (_) {}
      _fakeDd = { el: wrap, rowEls: rowEls };
      _armFakeDdSafety(_fakeDd);
      return _fakeDd;
    } catch (_) { return null; }
  }
  function _hideFakeOptions(dd) {
    try {
      var t = (dd && dd.el) || document.getElementById("axlx-fake-dd");
      if (dd && dd._safety) { clearTimeout(dd._safety); dd._safety = null; }
      if (t && t.parentNode) t.parentNode.removeChild(t);
    } catch (_) {}
    _fakeDd = null;
  }
  /**
   * 2026-11-11 念のため: 拡張が描いた一覧が残っても**画面を塞がない**（pointer-events:none）。
   *   それでも残ると見た目が邪魔なので、出してから8秒たったら必ず消す（安全弁）。
   */
  function _armFakeDdSafety(dd) {
    try {
      if (!dd || dd._safety) return;
      dd._safety = setTimeout(function () {
        try { _hideFakeOptions(dd); } catch (_) {}
      }, 8000);
    } catch (_) {}
  }
  /** 一覧の行を「選んだ」見た目にする（人が選んでいるのが目で分かる） */
  function _markFakeRow(dd, idx) {
    try {
      if (!dd || !dd.rowEls) return;
      for (var k in dd.rowEls) {
        if (!Object.prototype.hasOwnProperty.call(dd.rowEls, k)) continue;
        var row = dd.rowEls[k];
        if (String(k) === String(idx)) { row.style.background = "#2563eb"; row.style.color = "#fff"; row.style.fontWeight = "700"; }
        else { row.style.background = ""; row.style.color = "#111"; row.style.fontWeight = ""; }
      }
    } catch (_) {}
  }

  function chooseSelectLikeHuman(el, val, opts) {
    if (!el || val == null) return Promise.resolve(false);
    var o = opts || {};
    var P = window.AxlxPointerUi;
    var target = String(val);
    var fire = function (type, extra) {
      try {
        var oo = Object.assign({ bubbles: true, cancelable: true, view: window }, extra || {});
        el.dispatchEvent(new MouseEvent(type, oo));
      } catch (_) {}
    };
    /**
     * 2026-11-11 竹内さん「まずここおして、展開されたところの徒歩の部分をおすながれ。時間差とかも人間が押すように」:
     *   ① 欄を押して開く → **ゆっくり待つ**（人が一覧を目で探す 700〜1600ms）
     *   ② 目当ての値を選ぶ → **ゆっくり待つ**（人が選んで決める 400〜1100ms）
     *   ③ 閉じる → 少し待つ
     *   開いている間・選ぶ間・閉じた後を、毎回ちがう長さにする（等間隔にしない）。
     */
    var openThenChoose = function () {
      return new Promise(function (resolve) {
        /**
         * 2026-11-11 竹内さん「なんで賃料等プルダウンのところちゃんとおしてプルダウンのところから選択されるようになっていないのか」
         *            「なんでh.rさん沿線選択されずにとまってしまうのか」
         *
         * ⚠ **真の原因**: ネイティブの `<select>` を本物の形でクリックすると、
         *   **OS（Windows）が一覧を描く**。その一覧は**拡張からは閉じられない**（blur でも閉じない）。
         *   開いたままになると**画面の上に被さり、後続のクリックを全部ブロック**する。
         *   → 賃料・更新日を選んだ所で一覧が開きっぱなしになり、
         *     **沿線・駅の選択が永久に進まない**（＝h.r さんが駅の画面で止まる）。
         *
         * → **ネイティブの select では「開くクリック」を送らない**。
         *   人が見て分かる形（カーソルが欄まで動く → 少し待つ → 値が変わる → 少し待つ）は保ちつつ、
         *   OS の一覧を開かせない（＝閉じられない物を開かない）。
         *   ⚠ サイトが反応するのは `change` なので、値の入れ方は今まで通りで検出は変わらない。
         */
        var _isNativeSelect = (function () {
          try { return String(el.tagName || "").toUpperCase() === "SELECT"; } catch (_) { return false; }
        })();
        /**
         * 目当ての選択肢の位置を**先に**決める（ネイティブ select の分岐でも使う）。
         * ・値（"1" 等）で一致 → 文字（「徒歩」等）で前方一致 → それでも無ければ先頭
         */
        var want = -1;
        try {
          for (var _i = 0; _i < el.options.length; _i++) {
            if (String(el.options[_i].value) === target) { want = _i; break; }
          }
          if (want < 0) {
            /**
             * 2026-11-14 竹内さん「駅からの移動手段のところ 徒歩をプルダウンで選択するところできていなかった」:
             *   文字で探す時、旧は `indexOf(_wantText) === 0`（**先頭一致**）だけだった。
             *   → 「徒歩」は当たるが、`"1"` のような値は文字として無いので当たらず、
             *     最後の **`want = 0`（先頭＝未選択）** に落ちて**何も選ばれない**。
             *   → ① 完全一致 → ② 先頭一致 → ③ **含む**（「徒歩」を含む選択肢）まで見る。
             *     どれも無ければ **`want = -1` のまま**（呼ぶ側が「見つからない」と判断できる）。
             */
            var _wantText = String(target).replace(/\s+/g, "");
            for (var _j = 0; _j < el.options.length; _j++) {
              var _ot = String(el.options[_j].textContent || "").replace(/\s+/g, "");
              if (_ot === _wantText) { want = _j; break; }
            }
            if (want < 0) {
              for (var _j2 = 0; _j2 < el.options.length; _j2++) {
                var _ot2 = String(el.options[_j2].textContent || "").replace(/\s+/g, "");
                if (_wantText.length >= 1 && _ot2.indexOf(_wantText) === 0) { want = _j2; break; }
              }
            }
            if (want < 0) {
              for (var _j3 = 0; _j3 < el.options.length; _j3++) {
                var _ot3 = String(el.options[_j3].textContent || "").replace(/\s+/g, "");
                if (_wantText.length >= 2 && _ot3.indexOf(_wantText) >= 0) { want = _j3; break; }
              }
            }
          }
        } catch (_) { want = -1; }
        /**
         * ⚠ 目当てが見つからない時は **先頭（未選択）を選ばない**。
         *   旧は `want = 0` にしていたので「選んだつもりで未選択」になっていた（＝徒歩が入らない原因）。
         *   → 何もせず false を返す（点検に残す）。
         */
        if (want < 0) {
          try {
            if (window._axlxAuditStep) window._axlxAuditStep('sel_not_found', (el.getAttribute && el.getAttribute("name") || "?") + ' に "' + target + '" が無い（選択肢 ' + (el.options ? el.options.length : 0) + '個）');
          } catch (_) {}
          return Promise.resolve(false);
        }
        if (_isNativeSelect) {
          /**
           * 2026-11-11 竹内さん「賃料のところプルダウンなのに直接入力になってしまっている」:
           *
           * ⚠ ネイティブの `<select>` は、拡張からの擬似クリックでは**一覧が開かない**（Chrome の仕様）。
           *   だから「値を入れるだけ」＝**直接入力に見える**。人が見て分かる形にするには
           *   **拡張自身が見える一覧を描いて、カーソルで選ぶ**しかない。
           *   ⚠ ただし本物のクリックを送ると OS が一覧を描き、**閉じられなくて後続を全部止める**。
           *
           * → ① カーソルが欄へ動く → ② **見える一覧**を欄の下に出す（拡張が描く）
           *    ③ カーソルが目当ての行へ動く → ④ 押す（行が光る）
           *    ⑤ 一覧を消す → ⑥ 値を入れて change（サイトの検出は今まで通り）
           */
          try { if (el.focus) el.focus(); } catch (_) {}
          var _dd = _showFakeOptions(el);
          var _pick = function () {
            // ⑥ 値を入れて change（サイトが反応するのはここ）
            try {
              /**
               * 2026-11-14 竹内さん「駅からの移動手段のところ 徒歩をプルダウンで選択するところできていなかった」:
               *   ⚠ 旧は `el.selectedIndex = want;` の**直後に `el.value = target;`** を書いていた。
               *     `target` は決め打ちの `"1"` なので、リアプロの「徒歩」の値が `"1"` でないと
               *     この代入で**無効な値になり、選択が先頭（未選択）へ戻る**＝**徒歩が入らない**。
               *     （実測: 自動モードで `transportation_id` が **0件**・通常モードは3件押されていた）
               *   → **`selectedIndex` で選んだ物が正しければ、その値を使う**（決め打ちで上書きしない）。
               *     目当てが `want`（値一致→文字一致で見つけた位置）なので、そこが正解。
               */
              var _pickVal = (want >= 0 && el.options && el.options[want]) ? String(el.options[want].value) : target;
              el.selectedIndex = want;
              // 決め打ちの値が**実在する選択肢**の時だけ、その値で確定する（無ければ selectedIndex のまま）
              try {
                var _exists = false;
                for (var _k = 0; _k < el.options.length; _k++) {
                  if (String(el.options[_k].value) === target) { _exists = true; break; }
                }
                if (_exists) el.value = target; else el.value = _pickVal;
              } catch (_) { try { el.value = _pickVal; } catch (__) {} }
              if (_audit) _auditStepP('sel_pick', (el.getAttribute("name") || "?") + ' → 値"' + String(el.value) + '"（' + want + '番目）');
              if (!el.value || el.selectedIndex < 0) {
                // それでも入らなければ、選んだ位置をそのまま使う（最後の砦）
                try { el.selectedIndex = want; } catch (__) {}
              }
              el.dispatchEvent(new Event("input", { bubbles: true }));
            } catch (_) {}
            setTimeout(function () {
              try { el.dispatchEvent(new Event("change", { bubbles: true })); } catch (_) {}
              _hideFakeOptions(_dd);
              setTimeout(function () {
                try { if (el.blur) el.blur(); } catch (_) {}
                resolve(true);
              }, _ln(220, 0.35, 120, 420));
            }, _ln(200, 0.35, 110, 380));
          };
          // ② 人が一覧を見て候補を探す間 → ③ カーソルを目当ての行へ
          setTimeout(function () {
            if (_dd && _dd.rowEls && _dd.rowEls[want]) {
              var row = _dd.rowEls[want];
              try { row.classList.add("axlx-dd-hover"); } catch (_) {}
              if (P && P.moveToEl) {
                P.moveToEl(row).then(function () {
                  _markFakeRow(_dd, want);   // カーソルが乗った行を光らせる（人が選んだ形）
                  setTimeout(function () { if (P.tap) { try { P.tap(); } catch (_) {} } _pick(); }, _ln(220, 0.4, 120, 480));
                }, function () { _markFakeRow(_dd, want); _pick(); });
                return;
              }
              _markFakeRow(_dd, want);
            }
            _pick();
          }, _ln(1100, 0.4, 700, 1600));
          return;
        }
        // ② 欄を押して開く（人がクリックして一覧を出す）※ サイト独自の一覧の時だけ
        try { if (el.focus) el.focus(); } catch (_) {}
        fire("mousedown", { buttons: 1 });
        fire("mouseup");
        fire("click");
        // 開いた一覧を見る間（人が目で候補を探す）
        setTimeout(function () {
          // ③ 候補へ移る動き（カーソルを少し下へ＝一覧の中を探す形）
          var cur = el.selectedIndex >= 0 ? el.selectedIndex : 0;
          var dir = want >= cur ? 1 : -1;
          var steps = Math.min(6, Math.abs(want - cur));
          var stepMs = _ln(260, 0.35, 150, 450);
          var i2 = 0;
          /**
           * 2026-11-11 竹内さん「更新日とか賃料や面積の部分は押したら展開されてその展開された中で選択するところなのに一押ししかしていなかった」:
           *   旧は開いた一覧の上を矢印キーで動かす「ふり」をしてから、最後に el.value を代入して終わっていた。
           *   → 画面では**一覧が開いたまま**で、選ばれたことも閉じたことも見えない（＝一押しに見える）。
           *
           * 2026-11-11 竹内さん「家賃のところも大量に連続でえらばれてるけどおしてその家賃していしたらよいだけ」:
           *   ⚠ **selectedIndex を1つずつ動かしていた**ので、10万円まで行くのに何十回も選択が動いていた
           *     （＝画面で「大量に連続で選ばれている」ように見えた）。
           *   → **人がやる形に戻す**: 開く → **目当ての値を直接えらぶ** → 決める → 閉じる。
           *     途中の値は選ばない（ちらちら動かさない）。
           */
          function stepMove() {
            // ④ 目当ての値を**そのまま**選ぶ（途中の値は選ばない）
            try {
              /**
               * 2026-11-14: ここも同じ穴だった（`el.value = target` の決め打ちで
               *   実在しない値だと選択が先頭へ戻る）。**選んだ位置の値**を使う。
               */
              var _pickVal2 = (want >= 0 && el.options && el.options[want]) ? String(el.options[want].value) : target;
              el.selectedIndex = want;
              try {
                var _ex2 = false;
                for (var _k2 = 0; _k2 < el.options.length; _k2++) {
                  if (String(el.options[_k2].value) === target) { _ex2 = true; break; }
                }
                el.value = _ex2 ? target : _pickVal2;
              } catch (_) { try { el.value = _pickVal2; } catch (__) {} }
              if (!el.value || el.selectedIndex < 0) { try { el.selectedIndex = want; } catch (__) {} }
              if (_audit) _auditStepP('sel_pick', (el.getAttribute("name") || "?") + ' → 値"' + String(el.value) + '"（' + want + '番目）');
              el.dispatchEvent(new Event("input", { bubbles: true }));
            } catch (_) {}
              // ⑤ 一覧を閉じる（人が選び終えて画面から離れる）。閉じないと開いたままで終わる
              /**
               * 2026-11-11 竹内さん「画面検索中なぜかトップページに戻ったりして崩れてしまう」:
               *   ⚠ 旧（v2.6.63 の直前）はここで **Enter キーを dispatch していた**。
               *   リアプロの検索フォームは Enter で **form が送信される**ので、
               *   プルダウンを選ぶたびに検索が走り、トップページ（main.php）へ飛んで崩れていた。
               *   → Enter は送らない。閉じるのは **blur と、欄の外を軽く触るだけ**（送信を起こさない操作）。
               */
              try {
                if (el.blur) el.blur();
                // 欄の外を「触る」だけ（click は出さない＝form を送らない・ボタンを押さない）
                var _outside = document.querySelector('#main, #container, .contents, main') || document.body;
                if (_outside) {
                  _outside.dispatchEvent(new MouseEvent("mousedown", { bubbles: true, cancelable: true, view: window }));
                  _outside.dispatchEvent(new MouseEvent("mouseup", { bubbles: true, cancelable: true, view: window }));
                }
                fire("mouseout", {});
              } catch (_) {}
              // ⑥ 閉じたのを見届けてから change（人が確定した形）
              setTimeout(function () {
                try { el.dispatchEvent(new Event("change", { bubbles: true })); } catch (_) {}
                setTimeout(function () { resolve(true); }, _ln(260, 0.4, 150, 520));
              }, _ln(240, 0.35, 130, 460));
          }
          stepMove();
        }, _ln(900, 0.4, 500, 1500));
      });
    };
    if (P && P.moveToEl) {
      try { P.ensure(); } catch (_) {}
      /**
       * 2026-11-13 竹内さん「自動検索の部分に反映できるようにする」:
       *   学んだ**押した位置**（`o.aim`・人が欄のどこを押したか）があれば、**その割合の所へ**カーソルを動かす。
       *   ⚠ 無ければ今まで通り真ん中（moveToEl）。
       *   ⚠ 狙いは 0.2〜0.8 に丸める（端すぎる所は押さない＝押し間違いを防ぐ）。
       */
      var _move = function () {
        try {
          if (o.aim && P.moveTo && el.getBoundingClientRect) {
            var _r = el.getBoundingClientRect();
            if (_r.width > 0 && _r.height > 0) {
              var _fx = Math.max(0.2, Math.min(0.8, o.aim.x));
              var _fy = Math.max(0.2, Math.min(0.8, o.aim.y));
              return P.moveTo(_r.left + _r.width * _fx, _r.top + _r.height * _fy);
            }
          }
        } catch (_) {}
        return P.moveToEl(el);
      };
      return _move().then(function () {
        if (P.tap) { try { P.tap(); } catch (_) {} }
        return openThenChoose().then(function () { return _verifySel(el, target); });
      }, function () {
        return openThenChoose().then(function () { return _verifySel(el, target); });
      });
    }
    return openThenChoose().then(function () { return _verifySel(el, target); });
  }
  /**
   * 2026-11-11 竹内さん「ちゃんと画面確認しながら動く」:
   *   選んだ後に **画面の欄が本当にその値になったか**を読む（人の「選べたかな」と同じ）。
   *   違うままなら1回だけ入れ直す。それでも違えば点検（steps/sel_mismatch）に残す（理由を後から追える）。
   *   ⚠ 直すのは「まだ違う」時だけ。合っていれば何もしない（サイトを余計に触らない）。
   */
  function _verifySel(el, target) {
    if (!el) return false;
    var got = String(el.value == null ? '' : el.value);
    if (got === String(target)) return true;
    try {
      el.value = String(target);
      el.dispatchEvent(new Event("input", { bubbles: true }));
      el.dispatchEvent(new Event("change", { bubbles: true }));
      if (el.blur) el.blur();
    } catch (_) {}
    var now = String(el.value == null ? '' : el.value);
    if (_audit) {
      _auditStepP('sel_fix', (el.name || '?') + ' ' + got + '→' + now + '（入れるはず ' + target + '）');
      if (now !== String(target)) {
        _audit.sel_mismatch = _audit.sel_mismatch || [];
        if (_audit.sel_mismatch.length < 10) {
          _audit.sel_mismatch.push({ name: el.name || '?', want: String(target), got: now });
        }
      }
    }
    return now === String(target);
  }
  /**
   * 2026-11-10 v2.6.1 竹内さん「賃料選択する部分や更新日選択する部分が早すぎる。毎回人間がマウス動かして押していく形とする」
   *   賃料・更新日・面積・築年数などの **select（プルダウン）** は、旧は enqueueHumanAction（el: null）で
   *   カーソルが動かず 80〜200ms で値が入っていた（人が選んでいるようには見えない）。
   *   新は: ①見えるカーソルでその欄まで動く（着くまで待つ）
   *         ②人が欄を開いて選ぶ間（開く 250〜600ms → 選ぶ 400〜1100ms・対数正規）
   *         ③値を入れて change を出す（今までと同じ）
   *   欄が見つからない時は今まで通り（止まらない）。
   */
  function _operateWithPointer(el, action, openMs, chooseMs) {
    if (!el) return Promise.resolve(false);
    var P = window.AxlxPointerUi;
    // 2026-11-10 v2.6.10 竹内さん「ちゃんと画面を見ながら動くようにしていく」:
    //   動かす前に「その欄が画面に出ているか」を確かめる。見えていなければ少し待って見直す（最大6秒）。
    //   それでも見えなければ今まで通り触る（止まらない）。
    var waitVisible = function (attempt) {
      return new Promise(function (resolve) {
        var ok = true;
        try {
          var r = el.getBoundingClientRect();
          ok = !!(r && (r.width > 0 || r.height > 0));
          if (ok) ok = isVisible(el);
        } catch (_) { ok = true; }
        if (ok || attempt >= 12) { resolve(true); return; }
        // 2026-11-11 竹内さん「通常モードなら押す場所理解しているのに自動モードでは理解できていない」:
        //   ただ待つだけでは**閉じている欄は永久に開かない** → 案内モードと同じ「＋を押して開く」を1回だけ試す
        if (attempt === 1) {
          _ensureFieldVisible(el, el.getAttribute && el.getAttribute("name"), 3000).then(function () {
            setTimeout(function () { resolve(waitVisible(attempt + 1)); }, 150);
          }, function () { resolve(waitVisible(attempt + 1)); });
          return;
        }
        setTimeout(function () { resolve(waitVisible(attempt + 1)); }, _pd(500));
      });
    };
    var run = function () {
      return new Promise(function (resolve) {
        // ① 欄を開く前の間（人が視線を移して手を伸ばす）
        // 2026-11-10 v2.6.4 竹内さん「ボタン押してから選択するのめちゃくちゃ早い・人間の速度で」:
        //   旧は開く 250〜550ms → 選ぶ 400〜900ms（合計 0.65〜1.45秒）。人がプルダウンを開いて一覧を見て選ぶには速すぎる。
        //   新は 開く 450〜1000ms → 一覧を見る 700〜1600ms → 選んだ後に確認 250〜700ms（合計 1.4〜3.3秒）。
        //   対数正規（毎回ちがう・たまに長い）で、等間隔にしない。
        var openWait = openMs != null ? openMs : _ln(700, 0.4, 450, 1000);
        setTimeout(function () {
          if (P && P.tap) { try { P.tap(); } catch (_) {} }
          // ② 選ぶ前の間（人が一覧を見て選ぶ）
          var chooseWait = chooseMs != null ? chooseMs : _ln(1100, 0.42, 700, 1600);
          setTimeout(function () {
            // ③ 選んだ後に「合ってるかな」と見る間
            var confirmWait = _ln(430, 0.45, 250, 700);
            setTimeout(function () { resolve(true); }, confirmWait);
          }, chooseWait);
        }, openWait);
      });
    };
    if (P && P.moveToEl) {
      try { P.ensure(); } catch (_) {}
      return waitVisible(0).then(function () {
        return P.moveToEl(el);
      }).then(run, run).then(function () { return action(); });
    }
    return waitVisible(0).then(run).then(function () { return action(); });
  }
  /**
   * 2026-11-11 竹内さん「もともとの通常モードでのアナウンスとかでも押す場所や賃料等の条件理解しているから
   *   ちゃんとそれを押すことができればよいのになぜできていないのか。場所とかも通常モードなら押す場所理解しているのに
   *   なぜ自動モードやAIXモードでは理解できていないのか。ここの部分改善する」
   *
   * 原因: **案内モード（realpro-guide.js）には「閉じている欄を開く」段取り（openerFor）がある**のに、
   *   自動モード（この page-script.js）には**無かった**。だから条件の欄が「絞り込み条件＋」の中に
   *   畳まれている時・「所在地絞り込み＋」を開く前の時は、欄が**見えないまま触れず**、
   *   値が入らない → 検索前の確認で「違う」→ 止まる（＝押せていない）。
   *   → 案内モードと同じ「開く」考え方を**自動モードにも入れる**（同じ画面・同じ手順で探す）。
   *
   * 探し方（案内モード realpro-guide.js と同じ考え）:
   *   ① その欄から上へたどり、すぐ前の兄弟か箱の中に「…＋」の見出しがあればそれを押す
   *   ② 無ければ名前で探す（所在地絞り込み＋／沿線・駅絞り込み＋／絞り込み条件＋／検索条件を表示）
   */
  var PLUS_HEAD_RE = /[＋+]$/;
  function _openerFor(el) {
    try {
      for (var n = el, depth = 0; n && n !== document.body && depth < 8; n = n.parentElement, depth++) {
        for (var sib = n.previousElementSibling, k = 0; sib && k < 3; sib = sib.previousElementSibling, k++) {
          if (isVisible(sib) && PLUS_HEAD_RE.test(norm(sib.textContent)) && norm(sib.textContent).length <= 20) return sib;
          var inner = sib.querySelector ? Array.prototype.filter.call(sib.querySelectorAll("a,button,div,span,p,dt,h3,h4"),
            function (x) { return isVisible(x) && PLUS_HEAD_RE.test(norm(x.textContent)) && norm(x.textContent).length <= 20; }) : [];
          if (inner.length) return inner[inner.length - 1];
        }
      }
    } catch (_) {}
    return null;
  }
  /** 閉じている欄を開く（見つからなければ null） */
  function _openerForKind(name, el) {
    var near = el ? _openerFor(el) : null;
    if (near) return near;
    if (name === "city_code[]" || name === "town_code[]") return _findByText(['所在地絞り込み＋', '所在地絞り込み+', '所在地絞り込み']);
    if (name === "station_id[]" || name === "route_id[]") return _findByText(['沿線・駅絞り込み＋', '沿線・駅絞り込み+', '沿線・駅絞り込み']);
    return _findByText(['絞り込み条件＋', '絞り込み条件+', '絞り込み条件', '検索条件を表示']);
  }
  /** 文字で押せる要素を探す（見えている物だけ） */
  /**
   * 2026-11-11 竹内さん「ちゃんと通常モードのアナウンスのところ参考に改善していくように。あの動きが分かればできるはず。
   *   所在地も通常モードならちゃんと光るのに自動モードやAIXモードでできていない」
   *
   * 原因: 案内モード（realpro-guide.js）の `textMatches` は**文字のノードから上へたどって**探す。
   *   欲しい文字の一部になっている文字のノードだけを見て、その上の要素（6段まで）の文字が
   *   欲しい文字と同じかを比べ、長くなったら止める。→ **入れ子が深くても・他の文字が混ざっていても取れる**。
   *   自動モードの旧 `_findByText` は `querySelectorAll` で**要素の全体の文字**を比べるだけだったので、
   *   「所在地絞り込み ＋」のように**中の要素に分かれている**物を取りこぼしていた（＝押せない・光らない）。
   *   → 案内モードと同じ探し方を自動モードにも入れる。
   */
  var TEXT_SEL = "a,button,div,span,td,th,p,label,li,input[type=button],input[type=submit]";
  function _textMatches(texts, sel) {
    var want = texts.map(norm).filter(Boolean);
    var maxLen = 0; want.forEach(function (w) { if (w.length > maxLen) maxLen = w.length; });
    var cand = [];
    var add = function (el) { if (el && cand.indexOf(el) < 0) cand.push(el); };
    try {
      if (!sel || /input/.test(sel)) {
        Array.prototype.forEach.call(document.querySelectorAll("input[type=button],input[type=submit]"), function (el) {
          if (want.indexOf(norm(el.value)) >= 0) add(el);
        });
      }
      if (document.body && maxLen) {
        var walker = document.createTreeWalker(document.body, NodeFilter.SHOW_TEXT, null, false);
        var n;
        while ((n = walker.nextNode())) {
          var raw = n.nodeValue;
          if (!raw || raw.length > maxLen * 4 + 40) continue;
          var nt = norm(raw);
          if (!nt || !want.some(function (w) { return w.indexOf(nt) >= 0; })) continue;
          for (var el = n.parentElement, k = 0; el && el !== document.body && k < 6; el = el.parentElement, k++) {
            if (!el.matches || !el.matches(sel || TEXT_SEL)) continue;
            var et = norm(el.textContent);
            if (et.length > maxLen) break;
            if (want.indexOf(et) >= 0) add(el);
          }
        }
      }
    } catch (_) {}
    var hits = cand.filter(function (el) {
      try { return !(el.closest && el.closest("#axlx-guide-panel,#axlx-guide-layer")) && isVisible(el); } catch (_) { return false; }
    });
    // 一番内側だけ（中に同じ文字の要素を持つ外側の箱は外す）
    return hits.filter(function (el) {
      return !hits.some(function (o) { return o !== el && el.contains(o); });
    });
  }
  function _findByText(list) {
    var hits = _textMatches(list);
    if (!hits.length) return null;
    // 画面に見えている物を優先
    var inv = hits.filter(function (el) {
      try { var r = el.getBoundingClientRect(); return r.top >= 0 && r.bottom <= (window.innerHeight || 800); } catch (_) { return false; }
    });
    return (inv.length ? inv : hits)[0] || null;
  }
  /**
   * 欄が見えるようにする（見えていれば何もしない）。閉じていれば「＋」を押して開く。
   * 開いたら最大 maxMs まで見えるのを待つ。戻り値は「見えるようになったか」。
   */
  function _ensureFieldVisible(el, name, maxMs) {
    return new Promise(function (resolve) {
      if (!el) { resolve(false); return; }
      var vis = function () { try { return isVisible(el) && !!(el.getBoundingClientRect().width || el.getBoundingClientRect().height); } catch (_) { return true; } };
      if (vis()) { resolve(true); return; }
      var op = _openerForKind(name, el);
      if (!op) { resolve(false); return; }
      // 人が「＋」を押して開く形（カーソルを動かしてから押す）
      console.log('[AX] 閉じている欄を開きます: ' + String(name || '') + ' → ' + String((op.textContent || '')).replace(/\s+/g, '').slice(0, 16));
      if (_audit) _auditStepP('open_field', String(name || '') + ' / ' + String((op.textContent || '')).replace(/\s+/g, '').slice(0, 16));
      _humanPointerClick(op, function () { try { op.click(); } catch (_) {} });
      var t0 = Date.now();
      var limit = maxMs || 3000;
      (function poll() {
        if (vis()) { resolve(true); return; }
        if (Date.now() - t0 > limit) { resolve(false); return; }
        setTimeout(poll, 200);
      })();
    });
  }
  /** 対数正規の間（中央値・σ・下限・上限）。human-wait が無ければ一様 */
  function _ln(median, sigma, lo, hi) {
    var H = window.AxlxHumanWait;
    if (!H || !H.logNormalDelay) return lo + Math.floor(Math.random() * (hi - lo));
    var v = H.logNormalDelay(median, sigma);
    return Math.max(lo, Math.min(hi, v));
  }
  function setSelValHuman(name, val) {
    var el = document.querySelector('select[name="' + name + '"]');
    if (!el || val == null) return;
    return _operateWithPointer(el, function () { return setSelVal(name, val); });
  }
  // 2026-11-10 人間的な動き: 値を一瞬で入れると「貼り付けた」動きになる。数字などの短い欄は1文字ずつ打つ
  //   （人の打鍵の間は 60〜220ms・たまに止まる）。長い文字列（40字超）は今まで通り一気に入れる（待ちが長くなりすぎない）。
  //   1文字ずつでも最後は input/change を出して React の state を更新する（今までと同じ検出力）。
  var TYPE_MAX_CHARS = 40;
  function typeTextLikeHuman(el, value) {
    var s = String(value);
    var setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value").set;
    var H = window.AxlxHumanWait;
    if (!el || s.length > TYPE_MAX_CHARS || !H || !H.humanDelay) {
      setter.call(el, s);
      el.dispatchEvent(new Event("input", { bubbles: true }));
      el.dispatchEvent(new Event("change", { bubbles: true }));
      return Promise.resolve(false);
    }
    return new Promise(function (resolve) {
      var i = 0;
      var step = function () {
        i++;
        setter.call(el, s.slice(0, i));
        el.dispatchEvent(new Event("input", { bubbles: true }));
        if (i >= s.length) {
          el.dispatchEvent(new Event("change", { bubbles: true }));
          resolve(true);
          return;
        }
        // 打鍵の間 60〜220ms（対数正規・右に裾）。5%ほどで「考えて止まる」300〜600ms をはさむ
        // 2026-11-10 v2.6.4 竹内さん「早すぎる部分は人間の動きのように」: 中央値 110ms は速い → 165ms（人がキーボードを見て打つ速さ）
        var wait = H.logNormalDelay ? H.logNormalDelay(165, 0.32) : H.humanDelay(165);
        if (Math.random() < 0.05) wait += 300 + Math.floor(Math.random() * 300);
        setTimeout(step, wait);
      };
      if (el.focus) { try { el.focus(); } catch (_) {} }
      step();
    });
  }
  function setTxtVal(name, val) {
    var el = document.querySelector('input[name="' + name + '"]');
    if (!el || val == null) return;
    return typeTextLikeHuman(el, val);
  }
  function setCheckboxes(name, vals) {
    var svals = (vals || []).map(String);
    var cbs = Array.prototype.slice.call(document.querySelectorAll('input[name="' + name + '"]'));
    // 2026-11-10 v2.6.6 竹内さん「ほかの部分もちゃんとランダムで選択できるように。まだ人間的になっていない部分がある可能性ある」:
    //   旧は DOM の並び（上から）に必ず同じ順でチェックを入れていた（間取り 1K→1DK→1LDK… が毎回同じ）。
    //   人が選ぶ時は「気になった所から」「上から順とは限らない」ので、**対象を毎回シャッフル**して積む。
    //   選ぶ集合は変えない（入れ忘れ・余計に入れない）。順番だけ毎回ちがう。
    var targets = cbs.filter(function (cb) { return cb.checked !== (svals.indexOf(String(cb.value)) >= 0); });
    // 上の方から見ていく事が多いので、完全なランダムにせず「前半を少し優先」する揺らぎを混ぜる
    targets.sort(function (a, b) {
      var ai = cbs.indexOf(a), bi = cbs.indexOf(b);
      var aw = ai + Math.random() * cbs.length * 0.9;
      var bw = bi + Math.random() * cbs.length * 0.9;
      return aw - bw;
    });
    // 2026-11-11 竹内さん「この＋一息の考え方かなり重要。人間はその発想があるから。ほかでもちゃんと確認おねがい」:
    //   間取り・設備のチェックにも一息を入れる（駅と同じ2段）。
    //   ・10% で「項目を見比べる」一息 900〜2600ms ・さらに 3% で 2.6〜5.5秒（考え込む）
    targets.forEach(function (cb) {
      /**
       * 2026-11-14 竹内さん「地域の部分ちゃんと１つずつマウスを動かしてクリックしてせんたくする」:
       *   `_clickEl` 自体を「カーソルを動かしてから押す」に直したので、ここは今まで通り。
       *   ⚠ 2重に動かさない（`_humanPointerClick` を2回呼ばない）。
       */
      enqueueHumanClick(cb, _clickEl, 420, 980);
      if (Math.random() < 0.10) {
        var _b1 = 900 + Math.floor(Math.random() * 1700);
        enqueueHumanAction(function () {}, _b1, _b1 + 200, "息");
      } else if (Math.random() < 0.03) {
        var _b2 = 2600 + Math.floor(Math.random() * 2900);
        enqueueHumanAction(function () {}, _b2, _b2 + 200, "考え");
      }
    });
  }
  // 基本条件フォームの select/text 入力も1項目ずつ間隔を空けてセットする
  // 2026-11-10 v2.6.1 竹内さん「賃料選択する部分や更新日選択する部分が早すぎる。毎回人間がマウス動かして押していく形とする」
  //   旧は enqueueHumanAction（el: null）で **カーソルが動かず 80〜200ms** で値が入っていた。
  //   新は要素つきで列に積む（カーソルが欄まで動く→着いてから開く→選ぶ）。押す処理は今まで通り値の代入＋change。
  function _enqueueWithEl(el, fn, minGap, maxGap, label) {
    _clickQueue.push({ el: el, fn: fn, gap: humanRand(minGap || 80, maxGap || 200), label: label || _opLabel(el) });
    _scheduleClickDrain();
    /**
     * 2026-11-11 竹内さん「一連のうごきからちゃんと一息の部分入るようになっているか。人間のように一息もランダムにはいる」:
     *   条件を1つ入れた後に、たまに手を止める（人が「次はどこだ」と画面を見る形）。
     *   ・10% で 900〜2600ms ・さらに 3% で 2.6〜5.5秒
     *   次の項目の前に「何もしない」段を1つ挟む（順番は変わらない・待つだけ）。
     */
    if (Math.random() < 0.10) {
      var _b1 = 900 + Math.floor(Math.random() * 1700);
      enqueueHumanAction(function () {}, _b1, _b1 + 200, "息");
    } else if (Math.random() < 0.03) {
      var _b2 = 2600 + Math.floor(Math.random() * 2900);
      enqueueHumanAction(function () {}, _b2, _b2 + 200, "考え");
    }
  }
  /**
   * 2026-11-13 竹内さん「それで自動検索の部分に反映できるようにする。その点も併せて改善できるようにする」:
   *   学んだ**欄の種類**（`axlx_learn_points` の w）を読み、押し方を切り替える。
   *   ・select   … プルダウン（開いて選ぶ）  ← 今まで通り chooseSelectLikeHuman
   *   ・checkbox … 押して選ぶ
   *   ・text     … 直接入力
   *   ⚠ 学習が無ければ今まで通り（select の欄は select として扱う＝画面の作りに従う）。
   *   ⚠ **画面の作り（実際のタグ）を最優先**し、学習は「同じ名前で迷った時」に使う。
   *     画面が select なのに学習が text なら、**画面を信じる**（誤学習で壊さない）。
   */
  var _learnKinds = null;
  var _learnKindsAt = 0;
  /**
   * 2026-11-14: 学んだ押す位置を**先に読み込んでおく**ための関数（地域・検索ボタンは名前が無く、
   *   `_kindOf(name)` を通らない＝読み込みの機会が無いまま押していた）。
   */
  function _learnWarm() {
    try {
      if (typeof chrome === "undefined" || !chrome.storage || !chrome.storage.local) return;
      var now = Date.now();
      if (_learnKinds && !(now - _learnKindsAt > 30000)) return;  // 30秒は読み直さない（軽い）
      _learnKindsAt = now;
      chrome.storage.local.get(["axlx_learn_points"], function (r) {
        try { _learnKinds = (r && r.axlx_learn_points) || {}; } catch (_) { _learnKinds = {}; }
      });
    } catch (_) {}
  }
  function _kindOf(name) {
    try {
      _learnWarm();
      var v = _learnKinds && _learnKinds[name];
      return v && v.w ? String(v.w) : null;
    } catch (_) { return null; }
  }
  /**
   * 2026-11-14 竹内さん「地域の部分ちゃんと１つずつマウスを動かしてクリックしてせんたくする」
   *   「徒歩選択したあとに、選択までできたが自動で消してしまっている」:
   *
   *   ⚠ 自動で入れた地域を**覚えていない**ので、次にモーダルを開いた時に
   *     「前の残り」と区別できず、**人が選んだ物まで消していた**。
   *   → **自動で入れた物だけ**を覚える（`__axAutoPicked`）。
   *     人が選んだ物は覚えない＝消さない。
   */
  function _noteAutoPicked(kind, value) {
    try {
      var cur = window.__axAutoPicked;
      if (!cur || typeof cur !== "object") cur = { city: [], town: [], station: [] };
      var k = String(kind || "city");
      if (!Array.isArray(cur[k])) cur[k] = [];
      var v = String(value == null ? "" : value);
      if (v && cur[k].indexOf(v) < 0) cur[k].push(v);
      window.__axAutoPicked = cur;
    } catch (_) {}
  }
  /** 自動で入れた物の覚えを消す（新しいお客様の検索を始める時） */
  function _resetAutoPicked() {
    try { window.__axAutoPicked = { city: [], town: [], station: [] }; } catch (_) {}
  }

  /** 学んだ「押した位置」（要素の中の割合）を返す（無ければ null） */
  /**
   * 2026-11-14 竹内さん「この地域押すところや、検索押すところちゃんと学習する」:
   *   学んだ押す位置（`axlx_learn_points`）は、**欄の名前**（`name`）で引いていた。
   *   だが **「所在地絞り込み」「検索」には `name` 属性が無い**（div/span のボタン）ので、
   *   名前で引けず＝**学んだ位置が一切使われていなかった**（実測）。
   *   本番DBの学習データには、押した要素を**その場で作った名前**で残している:
   *     ・`左の所在地絞り込み＋｜span`（x 0.66 / y 0.57）
   *     ・`左の検索｜span`（x 0.74 / y 0.68）
   *     ・`左の大阪市西区｜label.one_city`（x 0.52 / y 0.46）…
   *   → **要素の「印（文字・クラス・タグ）」から学んだ名前を探して**、その位置を使う。
   *     ⚠ 名前が**一致しすぎる物**（例: `左の検索` が2か所）は、要素の位置（左右）で選ぶ。
   */
  function _aimByEl(el, fallbackKeys) {
    if (!el) return null;
    var all = _learnKinds;
    if (!all) { try { _learnWarm(); } catch (_) {} }
    all = _learnKinds;
    if (!all) return null;
    var want = [];
    try {
      // ① 呼ぶ側が渡した名前（例: ['左の検索', '検索']）
      if (fallbackKeys) want = want.concat(fallbackKeys);
      // ② 要素の文字（空白を除く・先頭20字）
      var t = String(el.textContent || "").replace(/\s+/g, "");
      if (t) want.push(t.slice(0, 20));
      // ③ クラス名（例: search_menu / go_search）
      var cn = String(el.className || "").split(/\s+/).filter(Boolean);
      for (var i = 0; i < cn.length && i < 4; i++) want.push(cn[i]);
      // ④ タグ＋クラス（例: div.search_menu）
      if (cn.length) want.push(String(el.tagName || "").toLowerCase() + "." + cn[0]);
    } catch (_) {}
    var best = null;
    for (var k in all) {
      if (!Object.prototype.hasOwnProperty.call(all, k)) continue;
      var v = all[k];
      if (!v || typeof v.x !== "number" || typeof v.y !== "number") continue;
      // 学んだ名前 `左の所在地絞り込み＋｜span` を「場所 / 文字 / 印」に分ける
      var seg = String(k).split("｜");
      var label = seg[0] || "";
      var sig = seg[1] || "";
      var labelBody = label.replace(/^左の|^右の/, "");
      var score = 0;
      for (var w = 0; w < want.length; w++) {
        var q = String(want[w] || "");
        if (!q) continue;
        if (labelBody === q) score = Math.max(score, 40);
        else if (label.indexOf(q) >= 0) score = Math.max(score, 26);
        else if (q.indexOf(labelBody) >= 0 && labelBody.length >= 2) score = Math.max(score, 18);
        if (sig && q && sig.toLowerCase().indexOf(String(q).toLowerCase()) >= 0) score = Math.max(score, 12);
      }
      if (score <= 0) continue;
      // 何回も押されている物ほど信頼する（n を少しだけ足す・最大6）
      score += Math.min(6, Number(v.n) || 0);
      if (!best || score > best.score) best = { score: score, x: v.x, y: v.y, key: k, n: Number(v.n) || 0 };
    }
    if (!best || best.score < 18) return null;
    return { x: best.x, y: best.y, key: best.key, n: best.n, score: best.score };
  }

  /**
   * 2026-11-14 竹内さん「この地域押すところや、検索押すところちゃんと学習する」:
   *   **ボタン（名前の無い div/span）を、学んだ押す位置で押す**。
   *   ・学んだ位置がある → その割合へカーソルを動かして押す（人が押した所と同じ）
   *   ・無い → 今まで通り `simulateClick`（リアプロの jQuery に効く）
   *   ⚠ 学んだ位置が**要素の外**を指していたら使わない（誤学習で押し間違えない）。
   *     0.2〜0.8 に丸めるのは `_humanPointerClick` 側でやる。
   */
  function _pressLearned(el, keys, tag) {
    if (!el) return false;
    var aim = null;
    try { aim = _aimByEl(el, keys); } catch (_) { aim = null; }
    /**
     * 2026-11-14 竹内さん「どこで展開されるのかも意識して学習して改善する」:
     *   学んだ**開き方**（modal/options/form/result）も一緒に残す。
     *   → 「このボタンは小窓を開くはず」と分かっていれば、開かなかった時に**すぐ押し直せる**。
     */
    var opensKind = null;
    try { opensKind = _opensOfEl(el, keys); } catch (_) { opensKind = null; }
    try {
      if (_audit) {
        _auditStepP('learn_aim', (tag || 'press') + ':' + (aim ? (aim.key + ' 横' + Math.round(aim.x * 100) + '% 縦' + Math.round(aim.y * 100) + '%（学び' + aim.n + '回）') : '学び無し→今まで通り')
          + (opensKind ? '／開き方=' + opensKind : ''));
      }
    } catch (_) {}
    if (aim) {
      try {
        _humanPointerClick(el, function () { simulateClick(el); }, aim);
        return true;
      } catch (_) {}
    }
    try { simulateClick(el); } catch (_) { try { el.click(); } catch (_) {} }
    return true;
  }

  /**
   * 2026-11-14 竹内さん「ボタンなのかプルダウンなのか、どこで展開されるのかも意識して学習して改善する」:
   *   学んだ**開き方**（`axlx_learn_opens`）を返す。
   *     "modal"（小窓）／"options"（プルダウンの一覧）／"form"／"result"／"modal_close"／"none"
   *   ⚠ 無ければ null（今まで通り＝分岐しない）。
   */
  var _learnOpens = null;
  var _learnOpensAt = 0;
  function _opensWarm() {
    try {
      if (typeof chrome === "undefined" || !chrome.storage || !chrome.storage.local) return;
      var now = Date.now();
      if (_learnOpens && now - _learnOpensAt < 30000) return;
      _learnOpensAt = now;
      chrome.storage.local.get(["axlx_learn_opens"], function (r) {
        try { _learnOpens = (r && r.axlx_learn_opens) || {}; } catch (_) { _learnOpens = {}; }
      });
    } catch (_) {}
  }
  function _opensOfEl(el, keys) {
    try {
      _opensWarm();
      if (!_learnOpens) return null;
      var aim = _aimByEl(el, keys);   // 名前の引き方（文字・クラス・タグ）を再利用して同じ欄を探す
      if (!aim || !aim.key) return null;
      var v = _learnOpens[aim.key];
      return (v && typeof v.opens === "string") ? v.opens : null;
    } catch (_) { return null; }
  }

  /**
   * 2026-11-14 竹内さん「DBにあって反映できていないものはあるか」:
   *   ⚠ `learn_plan`（統括の判断＝弱い所・次にやる事）は **storage に置くだけで誰も読んでいなかった**。
   *     「この欄は記録と写真で種類が違う」「名前から種類を推せない」と分かっているのに、
   *     自動検索は毎回同じ思い込みで触っていた。
   *   → 計画を読み、**該当する欄を触る時に「学びが弱い」と点検に残す**（動きは変えない＝安全）。
   *     記録が溜まったら、その欄だけ慎重に扱えるようにするための第1歩。
   */
  var _learnPlan = null;
  var _learnPlanAt = 0;
  function _learnPlanWarm() {
    try {
      if (typeof chrome === "undefined" || !chrome.storage || !chrome.storage.local) return;
      var now = Date.now();
      if (_learnPlan && now - _learnPlanAt < 30000) return;
      _learnPlanAt = now;
      chrome.storage.local.get(["axlx_learn_plan"], function (r) {
        try { _learnPlan = (r && r.axlx_learn_plan) || null; } catch (_) { _learnPlan = null; }
      });
    } catch (_) {}
  }
  /** その欄は「学びが弱い」と統括が言っているか（弱い所の名前を返す・無ければ null） */
  function _weakOf(name) {
    try {
      _learnPlanWarm();
      if (!_learnPlan || !Array.isArray(_learnPlan.items)) return null;
      var n = String(name || "");
      if (!n) return null;
      for (var i = 0; i < _learnPlan.items.length; i++) {
        var it = _learnPlan.items[i];
        if (!it || !it.name) continue;
        var raw = String(it.name);
        // `左の大阪市西区｜label.one_city` と `city_code[]` のような形の違いを吸収して比べる
        if (raw === n || raw.indexOf(n) >= 0 || n.indexOf(raw) >= 0) return { kind: it.kind, why: it.why, action: it.action };
      }
      return null;
    } catch (_) { return null; }
  }

  function _aimOf(name) {    try {
      var v = _learnKinds && _learnKinds[name];
      if (!v || typeof v.x !== "number" || typeof v.y !== "number") return null;
      if (Number(v.n) < 2) return null;
      return { x: v.x, y: v.y };
    } catch (_) { return null; }
  }

  function queueSelVal(name, val) {
    var el = document.querySelector('select[name="' + name + '"]');
    if (!el) { enqueueHumanAction(function () { setSelVal(name, val); }, 80, 200, 'sel:' + name + '=' + val); return; }
    /**
     * 2026-11-11 竹内さん「徒歩の部分のところもまずここおして、展開されたところの徒歩の部分をおすながれ。
     *   いま直接徒歩が反映されてしまっている。ちゃんとおして順にやっていくようにする。時間差とかも人間が押すように」
     *
     *   ⚠ 旧は `_enqueueWithEl` の待ちが 900〜1600ms と**短く**、しかも
     *     すでに同じ値が選ばれていると「変化が無い」ので**押したように見えなかった**。
     *   → 待ちを長くして（移動手段は特に）、**必ず「開く→選ぶ→決める→閉じる」を出す**。
     */
    var _isTransport = (name === "transportation_id");
    /**
     * 2026-11-13 竹内さん「自動検索の部分に反映できるようにする」:
     *   学んだ**押した位置**（人が欄の中のどこを押したか）を狙って開く。
     *   ⚠ 画面の作り（select）を最優先し、学習は「どこを押すか」にだけ使う（誤学習で壊さない）。
     */
    var _aim = _aimOf(name);
    var _learnedKind = _kindOf(name);
    /**
     * 2026-11-14 竹内さん「DBにあって反映できていないものはあるか」:
     *   統括が「この欄は学びが弱い（記録と写真で種類が違う等）」と言っている欄は、
     *   点検に残す（あとから「なぜここで止まったか」を追える）。
     */
    var _wk = _weakOf(name);
    try {
      if (_learnedKind) _auditStepP('learn_kind', name + '=' + _learnedKind + (_aim ? '（押す位置 横' + Math.round(_aim.x * 100) + '%）' : ''));
      if (_wk) _auditStepP('learn_weak', name + '=' + _wk.kind + '（' + String(_wk.why || '').slice(0, 40) + '）');
    } catch (_) {}
    _enqueueWithEl(el, function () { return chooseSelectLikeHuman(el, val, { forceOpen: true, aim: _aim }); },
      _isTransport ? 1400 : 900,
      _isTransport ? 2600 : 1600,
      'sel:' + name + '=' + val);
  }
  function queueTxtVal(name, val) {
    var el = document.querySelector('input[name="' + name + '"]');
    if (!el) { enqueueHumanAction(function () { setTxtVal(name, val); }, 80, 200, 'txt:' + name + '=' + val); return; }
    _enqueueWithEl(el, function () { return typeTextLikeHuman(el, val); }, 700, 1200, 'txt:' + name + '=' + val);
  }
  /**
   * 2026-11-14 竹内さん「駅からの移動手段のところ 徒歩をプルダウンで選択するところできていなかった」:
   *   **値ではなく「文字」で選ぶ**プルダウン。値がサイト側で変わっても（"1" でなくても）選べる。
   *   `chooseSelectLikeHuman` は「値一致 → 文字一致」の順で探すので、値を `"徒歩"` として渡せば
   *   文字一致の所で当たる。⚠ 見つからなければ**先頭（未選択）にしない**で、そのまま返す。
   */
  function queueSelValText(name, text) {
    var el = document.querySelector('select[name="' + name + '"]');
    if (!el) { enqueueHumanAction(function () { setSelVal(name, text); }, 80, 200, 'sel:' + name + '=' + text); return; }
    var _aim2 = _aimOf(name);
    var _wk2 = _weakOf(name);
    try {
      if (_wk2) _auditStepP('learn_weak', name + '=' + _wk2.kind);
      /**
       * いま選ばれている物が既に「徒歩」なら、押し直さない（トグルで壊さない）。
       *   ⚠ ただし「押した形」は見せたいので、点検には残す。
       */
      var _cur = "";
      try { _cur = String(el.options[el.selectedIndex] && el.options[el.selectedIndex].textContent || "").replace(/\s+/g, ""); } catch (_) {}
      if (_cur.indexOf(String(text)) >= 0) {
        _auditStepP('sel_already', name + ' は既に「' + _cur + '」');
      }
    } catch (_) {}
    _enqueueWithEl(el, function () { return chooseSelectLikeHuman(el, text, { forceOpen: true, aim: _aim2 }); },
      1400, 2600, 'sel:' + name + '=' + text);
  }

  /**
   * 2026-11-13 竹内さん「つなぐ」:
   *   学んだ押す順番（`axlx_learn_next`）で、**同じ集合のまま順番だけ**を並べ替える。
   *   ⚠ 項目は増減させない（入れる条件は絶対に変えない＝検索漏れを出さない）。
   *   ⚠ 学んだ順が無ければ元の順（今まで通り）。
   *   ⚠ 学習の束は background が取りに行って storage に置く（page-script は読むだけ）。
   */
  function _orderByLearned(list) {
    try {
      var items = Array.isArray(list) ? list : [];
      if (items.length < 2) return items;
      _loadLearnNext();
      var LO = window.AxlxLearnOrder;
      if (!LO || !LO.orderByLearned) return items;
      var next = window.__axlxLearnNext || null;   // background が storage から読んで入れる（下の受け口）
      /**
       * 2026-11-13 竹内さん「site_flow と weak を実際に使う」:
       *   ⚠ `next`（A の次は B）だけだと、**並べ替えに使える組が3通りしかなかった**
       *     （残りはモーダルの中などで、この集合に居ない）。
       *   → `site_flow`（サイトの手順の鎖）も使い、**集合の中だけの前後関係**を作って足す。
       *   ⚠ 足すのは「どちらが先か」だけ。**項目の増減は絶対にしない**（検索漏れを出さない）。
       */
      var flow = window.__axlxLearnSiteFlow || null;
      /**
       * 2026-11-14 竹内さん「一連の動きの学習や強化、反映の為に抜けている部分」:
       *   ⚠ `axlx_learn_seq`（一連の動きの型）と `axlx_learn_next_mode`（モード別の押す順番）を
       *     **受け取っているのに使っていなかった**（実測 0箇所）。
       *   → 鎖（sequence）から「A は B より前」を作って足す（`next` を優先）。
       *     このモードで学べている順番があれば、それも重ねる（一番その場に合う）。
       */
      var seq = window.__axlxLearnSeq || null;
      var modeNext = window.__axlxLearnNextMode || null;
      /**
       * 2026-11-14 竹内さん「DBにあって反映できていないものはあるか」:
       *   `screen_flow`（画面ごとの手順）は **popup の表示にしか使われていなかった**（自動検索 0箇所）。
       *   小窓の中の順番（区 → 町字 → 確定）を学んでいるのに使っていない＝**DBにあるのに反映できていない物**。
       *   → 画面ごとの鎖を「前後関係」として重ねる（`next` が無い所だけ・項目は増減しない）。
       */
      var screenFlow = window.__axlxLearnScreenFlow || null;
      if (!next && !flow && !seq && !modeNext && !screenFlow) return items;
      try {
        var names = items.map(function (it) { return it && it.name ? it.name : null; }).filter(Boolean);
        // ① モード別の押す順番を先に重ねる（その場に一番合う）
        if (modeNext && typeof modeNext === "object") {
          next = Object.assign({}, modeNext, next || {});
        }
        // ② 鎖から前後関係を作って補う（next が無い所だけ）
        if (seq && seq.sequence && LO.mergeWithSequence) {
          next = LO.mergeWithSequence(next, seq.sequence, names);
        }
        // ②' 画面ごとの鎖（小窓の中の順番など）も同じ形で重ねる
        if (screenFlow && LO.mergeWithSequence) {
          for (var _sc in screenFlow) {
            if (!Object.prototype.hasOwnProperty.call(screenFlow, _sc)) continue;
            var _steps = (screenFlow[_sc] && screenFlow[_sc].steps) || [];
            if (!_steps.length) continue;
            /**
             * `steps` は `[{from,to,n}]`（回数の多い前後）。回数2以上の物だけ鎖にする
             * （1回だけの偶然を採らない）。
             */
            var _chain = [];
            _steps.slice(0, 12).forEach(function (st) {
              if (!st || !st.from || !st.to) return;
              if (Number(st.n) < 2) return;
              if (_chain.indexOf(st.from) < 0) _chain.push(st.from);
              if (_chain.indexOf(st.to) < 0) _chain.push(st.to);
            });
            if (_chain.length >= 2) next = LO.mergeWithSequence(next, _chain, names);
          }
        }
        // ③ サイトの手順（site_flow）も補う
        if (next && flow && LO.mergeLearnedOrder) {
          next = LO.mergeLearnedOrder(next, flow, { names: names });
          /**
           * 2026-11-13 竹内さん「site_flow を実際に使う」:
           *   人の手順（`site_flow`）と**自動の順が違う所**を点検に残す（動きは変えない）。
           */
          if (LO.flowMismatches) {
            var mis = LO.flowMismatches(names, flow, { min: 2 });
            if (mis.length) {
              _auditStepP('flow_order_gap',
                mis.slice(0, 4).map(function (m) { return m.earlier + ' は ' + m.later + ' より先（' + m.n + '回）'; }).join(' / '));
            }
          }
        }
      } catch (_) { /* 失敗したら next だけ使う */ }
      if (!next) return items;
      var r = LO.orderByLearned(items, function (it) { return it && it.name ? it.name : null; }, next, { min: 2 });
      if (r && r.changed) {
        try {
          _auditStepP('learn_order',
            '学んだ順に並べ替え' + (r.wobbled ? '（人が時々変える分の揺らぎ入り）' : '') + ': ' + (r.used || []).slice(0, 3).join(' / '));
        } catch (_) {}
        console.log('[AX] 条件の入力順を学んだ順にしました' + (r.wobbled ? '（揺らぎあり）' : '') + ':', (r.used || []).join(' / '));
      }
      return (r && Array.isArray(r.items) && r.items.length === items.length) ? r.items : items;
    } catch (_) { return list; }
  }

  /**
   * 2026-11-13 竹内さん「つなぐ」:
   *   学んだ押す順番を storage から読む（background が1日1回取りに行って置いている）。
   *   ⚠ 30秒ごとに読み直す（学習が進んだら次の検索から効く）。
   */
  var _learnNextAt = 0;
  function _loadLearnNext() {
    try {
      var now = Date.now();
      if (now - _learnNextAt < 30000) return;
      _learnNextAt = now;
      if (typeof chrome === "undefined" || !chrome.storage || !chrome.storage.local) return;
      /**
       * 2026-11-13 竹内さん「site_flow を実際に使う」:
       *   サイトごとの手順（`axlx_learn_site_flow`）も一緒に読む。
       *   押す順番の材料が `next` だけだと3通りしか無いので、鎖から前後関係を補う。
       */
      chrome.storage.local.get(["axlx_learn_next", "axlx_learn_site_flow", "axlx_learn_seq", "axlx_learn_next_mode", "axlx_learn_screen_flow"], function (r) {
        try {
          var nx = (r && r.axlx_learn_next) || null;
          window.__axlxLearnNext = (nx && typeof nx === "object") ? nx : null;
          var sf = (r && r.axlx_learn_site_flow) || null;
          window.__axlxLearnSiteFlow = (sf && typeof sf === "object") ? sf : null;
          /**
           * 2026-11-14 竹内さん「一連の動きの学習や反映の為に抜けている部分」:
           *   一連の動きの型（鎖）と、モード別の押す順番も読む。
           */
          var sq = (r && r.axlx_learn_seq) || null;
          window.__axlxLearnSeq = (sq && typeof sq === "object") ? sq : null;
          var mn = (r && r.axlx_learn_next_mode) || null;
          window.__axlxLearnNextMode = (mn && typeof mn === "object") ? mn : null;
          /**
           * 2026-11-14 竹内さん「DBにあって反映できていないものはあるか」:
           *   ⚠ `screen_flow`（画面ごとの手順＝小窓の中の順番）は **popup の表示にしか使われていなかった**
           *     （自動検索では0箇所）。せっかく「小窓では 区→町字→確定 の順」と学んでいるのに使っていない。
           *   → 読んで、条件の入力順に重ねる（`_orderByLearned` が使う）。
           */
          var scf = (r && r.axlx_learn_screen_flow) || null;
          window.__axlxLearnScreenFlow = (scf && typeof scf === "object") ? scf : null;
          var n = nx ? Object.keys(nx).length : 0;
          var sqn = (sq && Array.isArray(sq.sequence)) ? sq.sequence.length : 0;
          var scn = scf ? Object.keys(scf).length : 0;
          if (n || sqn) console.log("[AX] 学んだ押す順番: " + n + "通り・一連の動き " + sqn + "手" + (mn ? "・モード別あり" : "") + (scn ? "・画面ごと " + scn + "種類" : ""));
        } catch (_) {}
      });
    } catch (_) {}
  }
  try { _loadLearnNext(); } catch (_) {}

  function getDirectText(el) {    var t = '';
    for (var n = el.firstChild; n; n = n.nextSibling) {
      if (n.nodeType === 3) t += n.textContent;
    }
    return t.replace(/\s+/g, '').replace(/駅$/, '');
  }

  function fireClick(el) {
    el.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true }));
  }

  // ── 人間らしいクリックキュー ─────────────────────────────────────────
  // 同一tick内の連続クリック（駅×N・区×N・町字×N・路線×N・チェックボックス×N）を
  // 1件ずつランダム間隔で直列実行する。itandi-page-script.js のディレイ設計を踏襲。
  // - 各クリック間: 呼び出し側指定のランダム間隔（60〜200ms程度）
  // - 8%の確率で 300〜700ms の「迷い」ポーズを追加（人間の躊躇を再現）
  // - el.__axPending フラグでポーリング再実行時の二重エンキューを防止
  // 2026-11-10 人間的な動き: クリックの列の間隔を対数正規にする（旧は一様乱数 min〜max で、間隔の分布が平ら＝機械らしい）。
  //   人の操作の間は「短い事が多く、たまに大きく伸びる」形（右に裾が長い）。中央値を (min+max)/2 にして同じ範囲に収める。
  //   下の端は min・上の端は max×1.6（たまに大きく伸びる分）。human-wait.js が無ければ今まで通り一様。
  function humanRand(min, max, opts) {
    var lo = Number(min), hi = Number(max);
    if (!(isFinite(lo) && isFinite(hi)) || hi <= lo) return lo || 0;
    var H = window.AxlxHumanWait;
    var strict = !!(opts && opts.strictLo);
    if (H && H.logNormalDelay) {
      /**
       * 2026-11-11 竹内さん「ひとつずつおすかたち」→「駅の下限を守る」:
       *   旧は Math.round + `Math.max(lo, ...)` で **lo に張り付いて同じ値が連続**していた。
       *   対策: ① 対数正規の中央値を lo と hi の間で決める（lo に張り付かせない）
       *        ② 0.1ms 単位で残す ③ 10%で「ためらい」を足す ④ たまに速く押す（下の端を lo*0.55 まで許す）
       *   strictLo: 駅のように「これより速く押さない」下限を守りたい時（lo を下回らせない）
       */
      var med = (lo + hi) / 2;
      var v = H.logNormalDelay(med, 0.32);
      var floor = strict ? lo : Math.max(20, lo * 0.55);
      var ceil = hi * 1.8;
      var out = Math.min(ceil, Math.max(floor, v));
      if (Math.random() < 0.10) out += 80 + Math.floor(Math.random() * 260); // ためらい
      return Math.round(Math.min(hi * 2.2, out) * 10) / 10; // 0.1ms 単位
    }
    return lo + Math.floor(Math.random() * (hi - lo + 1));
  }
  // 2026-09-27 竹内「拡張ツールは人間らしい動きをするために全て時間ランダムにする」: 固定の数字の待ちを共通の関数で散らす。
  //   human-wait.js（self.AxlxHumanWait）は content.js が先にページへ入れる。読めない時は元の値で動く（止まらない）。
  //   _hd＝人の操作の間（0.8〜1.5倍）／_pd＝条件を見る間隔（±15%・平均は元と同じ＝回数で打ち切る長さは変えない）
  function _hd(ms) { var H = window.AxlxHumanWait; return H ? H.humanDelay(ms) : ms; }
  function _pd(ms) { var H = window.AxlxHumanWait; return H ? H.pollDelay(ms) : ms; }
  /**
   * 2026-11-14 竹内さん「地域の部分ちゃんと１つずつマウスを動かしてクリックしてせんたくする」
   *   「今自動的に反映されてしまっている場面がある」:
   *
   *   ⚠ 旧は `el.click()` だけだったので、**カーソルが動かず一瞬で入っていた**
   *     （人が見ると「自動で反映された」ように見える）。
   *     地域の区・町字・間取り・こだわり条件など、**13か所すべて**がこれを使っていた。
   *
   *   → **カーソルをその要素まで動かしてから押す**（`_humanPointerClick`）。
   *     ⚠ `_humanPointerClick` は Promise を返すが、`enqueueHumanClick` は待たなくてよい
   *       （押す順番はキューが守る・次の間隔も入っている）。
   *     ⚠ 見えるカーソル（pointer-ui）が無い環境では、中の `fire(el)` がそのまま押す（今まで通り）。
   */
  function _clickEl(el) {
    try {
      if (!el) return;
      // 見えるカーソルで動かしながら押す（失敗しても必ず押す＝止まらない）
      void _humanPointerClick(el, function (x) { try { x.click(); } catch (_) {} });
    } catch (_) {
      try { el.click(); } catch (__) {}
    }
  }
  // 2026-11-10 人間的な動き: 押す前に、その要素が画面に入るまで少しずつ動かす（人が目で探して手を伸ばす形）。
  //   一瞬で飛ばさない（behavior: smooth）。画面に入っているなら何もしない。押す・選ぶの中身は変えない。
  // 2026-11-10 v2.5.96 竹内さん「画面無駄に上下しまくりすぎている。実際のスタッフはそこまで上下しまくらないし
  //   その上下の時間もはやすぎる」:
  //   旧は block:"center" で毎回その要素を画面の真ん中へ寄せていた＝押すたびに画面が大きく上下する（人の動きではない）。
  //   直し: ①画面に入っていれば何もしない（今まで通り）②画面の外の時だけ、**最小の移動**で見える位置へ寄せる
  //   （block:"nearest"）③連続して動かさない＝直近 900ms 以内にスクロールしていたら、その時はスクロールせずに待ってから押す
  //   （人が「少し見てから押す」形・画面が細かく往復しない）④スムーズの時間はブラウザ任せにせず、押す前に少し待つ
  var _lastScrollAt = 0;
  var _lastScrollDir = 0; // 2026-11-10 v2.6.12: 直前のスクロールの向き（+下 / -上）
  function _ensureInView(el) {
    try {
      if (!el || !el.getBoundingClientRect) return 0;
      var r = el.getBoundingClientRect();
      var vh = window.innerHeight || 800;
      var margin = 60; // 画面の端から少し内側に入れる（端ぎりぎりで押さない）
      if (r.top >= margin && r.bottom <= vh - margin) return 0;
      var now = Date.now();
      // 直前のスクロールから 900ms 未満なら、動かさずに「見えている所で待つ」時間を返す
      if (_lastScrollAt && now - _lastScrollAt < 900) return 350 + Math.floor(Math.random() * 450);
      var dir = r.top < margin ? -1 : 1;
      // 2026-11-10 v2.6.12 竹内さん「細部まで徹底した動き」:
      //   直前に逆方向へ動かした直後なら、すぐ戻さずに少し待つ（人が行ったり来たりしない）。
      if (_lastScrollDir && dir !== _lastScrollDir && now - _lastScrollAt < 2500) {
        return 500 + Math.floor(Math.random() * 600);
      }
      _lastScrollAt = now;
      _lastScrollDir = dir;
      // 最小の移動で見える位置へ（真ん中へは寄せない）
      // ⚠ 2026-10-06 v2.6.12 の決定「細かく往復しない」は今も守る（block を center/start に散らすと行ったり来たりする）。
      //   人の揺らぎは「スクロール位置」ではなく**待ち時間**で出す（下の wait）。
      el.scrollIntoView({ behavior: "smooth", block: "nearest", inline: "nearest" });
      // スムーズの動きが終わるのを待つ（人が目で追う時間・距離に応じて 250〜700ms）
      /**
       * 2026-11-11 竹内さん「弱い部分あれば人間の動きになるように強化する」:
       *   旧は `距離×1.2` を 250〜700ms に丸めるだけ＝**同じ距離なら必ず同じ待ち**（決定的・機械的）。
       *   新: 距離の比例を「下限」にして、その上に **人の揺らぎ**（0.8〜1.6倍・たまに長く見る）を足す。
       *   遠くへ動いた時は「目で追って少し確認する」時間も足す（距離200px超で 1〜3割増し）。
       */
      var dist = r.top < margin ? -(r.top - margin) : (r.bottom - (vh - margin));
      var base = Math.min(700, Math.max(250, Math.round(Math.abs(dist) * 1.2)));
      var H = window.AxlxHumanWait;
      var wait;
      if (H && H.logNormalDelay) {
        wait = H.logNormalDelay(base, 0.3);           // 同じ距離でも毎回ちがう
        if (Math.abs(dist) > 200 && Math.random() < 0.3) wait += 200 + Math.floor(Math.random() * 500); // 遠い時は目で追う
        if (Math.random() < 0.06) wait += 400 + Math.floor(Math.random() * 900); // たまに長く見る
      } else {
        wait = base * (0.8 + Math.random() * 0.8);
      }
      return Math.min(2200, Math.max(180, Math.round(wait)));
    } catch (_) { return 0; }
  }
  // 2026-11-10 人間的な動き: マウスが要素まで「動いて」から押す。人の軌跡（少し曲がる）をなぞって
  //   mousemove / mouseover / mousedown / mouseup / click を順に出す（押すのは最後の1回だけ＝二重に効かせない）。
  //   軌跡は human-wait.js の pointerPath（純関数・依存ゼロ）。読めない時は今まで通り click だけ。
  var _pointer = { x: 120 + Math.random() * 200, y: 120 + Math.random() * 200 };
  function _humanPointerClick(el, fallbackFn, aim) {
    var H = window.AxlxHumanWait;
    var fire = fallbackFn || _clickEl;
    if (!el || !el.getBoundingClientRect || !H || !H.pointerPath) { fire(el); return Promise.resolve(false); }
    var r;
    try { r = el.getBoundingClientRect(); } catch (_) { fire(el); return Promise.resolve(false); }
    if (!r || (r.width <= 0 && r.height <= 0)) { fire(el); return Promise.resolve(false); }
    /**
     * 2026-11-14 竹内さん「この地域押すところや、検索押すところちゃんと学習する」:
     *   ⚠ 学んだ**押した位置**（`aim`＝人がその要素のどこを押したか）は
     *     **プルダウン（chooseSelectLikeHuman）だけ**で使っていて、
     *     **地域ボタン・検索ボタンでは使っていなかった**（実測）。
     *   → ボタンでも、学んだ位置があれば**その割合へカーソルを動かして**押す。
     *     ⚠ 0.2〜0.8 に丸める（端すぎる所は押さない＝押し間違い防止）。
     *     ⚠ `pointer-ui`（見えるカーソル）がある時は `moveTo` で狙う。
     */
    var _aimPt = null;
    try {
      if (aim && typeof aim.x === "number" && typeof aim.y === "number") {
        var _fx = Math.max(0.2, Math.min(0.8, aim.x));
        var _fy = Math.max(0.2, Math.min(0.8, aim.y));
        _aimPt = { x: r.left + r.width * _fx, y: r.top + r.height * _fy, fx: _fx, fy: _fy };
      }
    } catch (_) { _aimPt = null; }
    // 2026-11-10 v2.6.0 竹内さん「リアプロとITANDI人間のようにマウス動くようにする」:
    //   画面の上に「見えるカーソル」を出して、押す位置まで人の軌跡で動かす（pointer-ui.js・見た目だけ・pointer-events:none）。
    //   動きながら押すと不自然なので、**着いてから**押す（本物のクリックは今まで通り1回だけ）。
    var _P = window.AxlxPointerUi;
    if (_P && _P.ensure) {
      try { _P.ensure(); } catch (_) {}
      var _move = function () {
        try {
          if (_aimPt && _P.moveTo) return _P.moveTo(_aimPt.x, _aimPt.y);
        } catch (_) {}
        return _P.moveToEl(el);
      };
      return _move().then(function () {
        try { _P.tap(); } catch (_) {}
        _fireAt(el, fire, r);
        return true;
      }, function () { _fireAt(el, fire, r); return true; });
    }
    var to = _aimPt ? { x: _aimPt.x, y: _aimPt.y } : { x: r.left + r.width * (0.35 + Math.random() * 0.3), y: r.top + r.height * (0.35 + Math.random() * 0.3) };
    var pts = H.pointerPath(_pointer, to, 10 + Math.floor(Math.random() * 8));
    var waits = H.pointerDelays ? H.pointerDelays(pts.length, 260 + Math.random() * 340) : pts.map(function () { return 30; });
    var i = 0;
    function ev(type, p) {
      try {
        var t = el;
        var o = { bubbles: true, cancelable: true, view: window, clientX: Math.round(p.x), clientY: Math.round(p.y), button: 0, buttons: type === "mousedown" ? 1 : 0 };
        /**
         * 2026-11-11 竹内さん「マウスの動かし方とクリックの部分もちゃんとできるように」:
         *   旧は軌跡の途中で `elementFromPoint` を呼んで「その点の下の要素」へ mousemove を出していた。
         *   これは重い（レイアウトを毎点で計算する）うえ、**見えるカーソル（pointer-ui）は狙った要素の上を滑っている**のに
         *   途中の点が別の要素へ飛ぶ＝人が見ると「カーソルと反応がずれる」。
         *   途中は狙った要素へ（人がその要素の上をなぞる形）、最後の点だけ本物のクリック。
         *   ⚠ pointer-ui が使える時はそちらが軌跡を描くので、ここは「本物のクリック1回」だけでよい。
         */
        t.dispatchEvent(new MouseEvent(type, o));
      } catch (_) {}
    }
    return new Promise(function (resolve) {
      var step = function () {
        if (i >= pts.length - 1) {
          var p = pts[pts.length - 1];
          _pointer = { x: p.x, y: p.y };
          ["mouseover", "mousedown", "mouseup"].forEach(function (type) { ev(type, p); });
          try { fire(el); } catch (e) { console.error('[AX] クリック例外', e); }
          resolve(true);
          return;
        }
        var pt = pts[i];
        ev("mousemove", pt);
        i++;
        setTimeout(step, waits[Math.min(i, waits.length - 1)] || 30);
      };
      // 押す前に要素の上へ（mouseover は最初に1回）
      try { el.dispatchEvent(new MouseEvent("mouseover", { bubbles: true, cancelable: true, view: window })); } catch (_) {}
      step();
    });
  }
  /**
   * 2026-11-10 v2.6.0 カーソルが着いた後に「押す」処理を1か所に（見えるカーソルの経路でも同じ順で出す）。
   *   mousemove → mouseover → mousedown → mouseup → 本物のクリック（1回だけ）
   */
  function _fireAt(el, fire, r) {
    try {
      /**
       * 2026-11-11 竹内さん「マウスの動かし方とクリックの部分もちゃんとできるように」:
       *   旧は **常に要素の真ん中**を狙っていた（毎回同じ点＝機械的）。
       *   いまは 30〜70%の位置で毎回ちがう。
       *   ⚠ さらに 2026-11-11: **見えるカーソルが居る位置**で押す（カーソルの先と押す点を一致させる）。
       *     ずれていると「カーソルはAを指しているのにBが押される」＝人が見て不自然。
       *     カーソルの位置が取れない時だけ 30〜70% で決める。
       */
      var cx, cy;
      var _P = window.AxlxPointerUi;
      var _pos = null;
      try { if (_P && _P.visiblePosition) _pos = _P.visiblePosition(); } catch (_) { _pos = null; }
      var _near = _pos && _pos.x >= r.left - 4 && _pos.x <= r.right + 4 && _pos.y >= r.top - 4 && _pos.y <= r.bottom + 4;
      if (_near) {
        // カーソルが要素の上に居る → その点で押す（先端の座標がそのまま押す点）
        cx = Math.round(_pos.x); cy = Math.round(_pos.y);
      } else {
        var fx = 0.30 + Math.random() * 0.40;   // 30〜70%
        var fy = 0.30 + Math.random() * 0.40;
        cx = Math.round(r.left + r.width * fx); cy = Math.round(r.top + r.height * fy);
      }
      var base = { bubbles: true, cancelable: true, view: window, clientX: cx, clientY: cy, button: 0 };
      // 2026-11-10 v2.6.9 竹内さん「あと選択してちゃんとその画面おすように」:
      //   カーソルを上に載せる → **少し止まって「ここだ」と確かめる** → 押す（人が狙いを定める間）。
      //   押した後も少し残って「反応したか」を見る（すぐ次の場所へ飛ばない）。
      ["mousemove", "mouseover"].forEach(function (type) { try { el.dispatchEvent(new MouseEvent(type, base)); } catch (_) {} });
      var aim = 90 + Math.floor(Math.random() * 160);
      setTimeout(function () {
        try { el.dispatchEvent(new MouseEvent("mousedown", Object.assign({}, base, { buttons: 1 }))); } catch (_) {}
        try { el.dispatchEvent(new MouseEvent("mouseup", Object.assign({}, base, { buttons: 0 }))); } catch (_) {}
        try { fire(el); } catch (e) { console.error('[AX] クリック例外', e); }
        // 2026-11-11 竹内さん「リアプロ側はどうか」: 押した後の「反応を見る間」が空の関数で意味が無かった
        //   （次の場所へすぐ飛ぶのを止める意図だったが、実際には何も待っていなかった）。
        //   次のクリックは元々キュー（enqueueHumanClick の gap）が間を空けるので、ここは
        //   「押した瞬間にカーソルを縮めて戻す」だけにする（見た目の反応・二重に待たない）。
        try {
          var P = window.AxlxPointerUi;
          if (P && P.tap) P.tap();
        } catch (_) {}
      }, aim);
    } catch (e) { console.error('[AX] クリック例外', e); }
  }
  // ★ 修正(Bug2): 選択側クリックの実行時ガード。
  // 同一駅が複数路線に出現するモーダルでは同名inputが2つ描画され、内部状態で同期している場合
  // 1個目のクリックで両方checkedになる → キューに残った2個目のクリックがトグル解除として作用し
  // 選択が消える（解除側 _unclickIfChecked と対称のガードが選択側に無かった欠陥）。
  // 実行時点で未checkedのときだけクリックすることで、同期input（2回目スキップ）と
  // 非同期の同名別駅（両方クリック）の双方で正しく動作する
  function _clickIfUnchecked(el) {
    if (!el.checked) {
      _clickEl(el);
      // 2026-11-11 竹内さん「地域か駅どちらか入っていればそれで場所は選択されている」:
      //   モーダルを閉じると DOM から消える事があるので、押した駅を覚えておく
      try {
        var nm = el.getAttribute && el.getAttribute("name");
        if (nm === "station_id[]") {
          var lb = (el.closest && el.closest("label")) || el.parentElement;
          _noteStationPicked(el.value, lb ? lb.textContent : "");
        } else if (nm === "route_id[]") {
          var lb2 = (el.closest && el.closest("label")) || el.parentElement;
          _noteStationPicked(el.value, lb2 ? lb2.textContent : "");
        } else if (nm === "city_code[]" || nm === "town_code[]") {
          var lb3 = (el.closest && el.closest("label")) || el.parentElement;
          _noteWardPicked(el.value, lb3 ? lb3.textContent : "");
        }
      } catch (_) {}
    }
  }
  var _clickQueue = [];
  var _clickBusyItem = null; // 2026-11-10 v2.6.8 いま処理中の1件（迷いの漂いの間も「忙しい」）
  // 2026-11-10 v2.6.11: 人が手を止める長い停止（8〜25秒）は**わざと**なので、その間は安全弁を止める
  var _holdingPause = false;
  var _clickQueueTimer = null;
  // 2026-09-27 v2.5.31: 点検の記録（ブレインの時だけ）に操作ごとの時刻を残すため、列の1件ごとに名前（label）を持つ
  function _opLabel(el) {
    try {
      if (!el) return 'action';
      var n = el.getAttribute && el.getAttribute('name');
      if (n) return (n + ':' + String(el.value || '')).slice(0, 40);
      return ('click:' + String(el.textContent || '').replace(/\s+/g, '')).slice(0, 40);
    } catch (e) { return 'click'; }
  }
  function enqueueHumanClick(el, clickFn, minGap, maxGap, _unused, opts) {
    if (!el || el.__axPending) return false;
    el.__axPending = true;
    // 2026-11-11: opts.strictLo（駅のように下限を下回らせない）を humanRand に渡す
    _clickQueue.push({ el: el, fn: clickFn || _clickEl, gap: humanRand(minGap || 80, maxGap || 200, opts), label: _opLabel(el) });
    _scheduleClickDrain();
    return true;
  }
  // 要素に紐づかない汎用アクション（select/text入力・モーダル閉じ等）もキューで直列化
  function enqueueHumanAction(fn, minGap, maxGap, label) {
    _clickQueue.push({ el: null, fn: fn, gap: humanRand(minGap || 80, maxGap || 200), label: label || 'action' });
    _scheduleClickDrain();
  }
  // 2026-11-10 人間的な動き: 「迷い」ポーズ（人が押す前に一瞬止まる）。
  // 2026-11-10 v2.5.99 竹内さん「ボタン選択する際人間ならたまにまよう」:
  //   人が迷うのは「迷う余地がある所」＝**選ぶ系（チェック・ラジオ・選択肢）**。送信・検索のような決定のボタンは迷わない。
  //   旧は全部 8%（±25%）で 300〜700ms 固定幅。新は:
  //     ・選ぶ系（label・checkbox・radio・select）は **12〜20%**、決定系（button・submit）は **3%**、その他 8%
  //     ・迷う長さも**3段**（一瞬 250〜600ms 65%／少し考え込む 700〜1600ms 30%／かなり迷う 1800〜4500ms 5%）
  //     ・同じ種類の操作が続いた時は少し迷いやすい（人が同じ欄を何度も見る形）＝直前の迷いから 5秒以内なら確率 +4pt
  //   確率も長さも毎回抽選で、等間隔にならない。
  var _lastHesitateAt = 0;
  function _hesitateKindOf(el) {
    try {
      if (!el) return "other";
      var tag = String(el.tagName || "").toUpperCase();
      var type = String((el.getAttribute && el.getAttribute("type")) || "").toLowerCase();
      if (tag === "SELECT" || tag === "LABEL") return "choose";
      if (tag === "INPUT" && (type === "checkbox" || type === "radio")) return "choose";
      if (tag === "BUTTON" || type === "submit" || type === "button") return "decide";
      if (tag === "A" || tag === "DIV" || tag === "SPAN") return "other";
      return "other";
    } catch (_) { return "other"; }
  }
  /**
   * 2026-11-11 竹内さん「ちゃんとボタン押してからの動きも人間のようにやっていく。ボタン押して次のボタンおすところも。
   *   ここの部分はボタンすぐに押せるところや、この部分は少し考えながら押すから時間必要など。
   *   どのようにボタンをおしていくか。また一息一瞬つくかなど、そのように人間のように」
   *
   * 押した「後」に次の所へ移るまでの間を、**ボタンの意味で変える**（人がそうしているから）:
   *   input  … 入力欄。打ち終わって次の欄へ移るのは速い（0.5〜1.2秒）
   *   next   … 「次へ」「続き」のような進む操作。行き先を確かめるので少し間（0.8〜2.0秒）
   *   choose … 選択肢を選ぶ（チェック・ラジオ・プルダウン）。選んだ結果を目で見る（0.35〜1.0秒）
   *   decide … 決定のボタン（検索・送信）。押した後に**画面が変わったかを見る**ので長め（1.2〜3.2秒）
   *   other  … その他（0.5〜1.4秒）
   * ⚠ 迷い（_hesitateMs）とは別物。迷いは「押す前」、これは「押した後」。
   */
  function _afterClickGapMs(el) {
    var H = window.AxlxHumanWait;
    var kind = "other";
    try {
      if (!el) kind = "other";
      else {
        var tag = String(el.tagName || "").toUpperCase();
        var type = String((el.getAttribute && el.getAttribute("type")) || "").toLowerCase();
        var txt = String((el.textContent || "").replace(/\s+/g, "")).slice(0, 12);
        if (tag === "INPUT" && !/checkbox|radio|button|submit/.test(type)) kind = "input";
        else if (/^(次へ|次|続き|もっと見る|次ページ|次のページ)/.test(txt)) kind = "next";
        else if (tag === "SELECT" || tag === "LABEL" || ((tag === "INPUT") && /checkbox|radio/.test(type))) kind = "choose";
        else if (tag === "BUTTON" || /submit|button/.test(type) || /^(検索|送信|決定|実行|保存|登録|送る)/.test(txt)) kind = "decide";
        else kind = "other";
      }
    } catch (_) { kind = "other"; }
    var r = {
      input:  [500, 1200],
      next:   [800, 2000],
      choose: [350, 1000],
      decide: [1200, 3200],
      other:  [500, 1400],
    }[kind] || [500, 1400];
    var base = H && H.logNormalDelay ? H.logNormalDelay((r[0] + r[1]) / 2, 0.32) : (r[0] + r[1]) / 2;
    // 決定のボタンの後は「画面が変わったか」を見るので、たまに長く見る（12%で+0.6〜1.8秒）
    if (kind === "decide" && Math.random() < 0.12) base += 600 + Math.floor(Math.random() * 1200);
    // 一瞬つく（8%で+0.3〜0.9秒）＝人が「お、変わったな」と手を止める形
    else if (Math.random() < 0.08) base += 300 + Math.floor(Math.random() * 600);
    return Math.min(r[1] * 2.4, Math.max(r[0] * 0.6, Math.round(base)));
  }
  /** 押す前に迷う時間（0＝迷わない） */
  function _hesitateMs(el) {
    var kind = _hesitateKindOf(el);
    var base = kind === "choose" ? 0.15 : (kind === "decide" ? 0.03 : 0.08);
    // 直前（5秒以内）に迷っていたら少し迷いやすい（同じ所を見直している形）
    var boost = (Date.now() - _lastHesitateAt < 5000) ? 0.04 : 0;
    var p = (base + boost) * (0.8 + Math.random() * 0.45); // ±20〜25% で揺らす
    if (Math.random() >= p) return 0;
    _lastHesitateAt = Date.now();
    var r = Math.random();
    if (r < 0.65) return 250 + Math.floor(Math.random() * 350);   // 一瞬
    if (r < 0.95) return 700 + Math.floor(Math.random() * 900);   // 少し考え込む
    return 1800 + Math.floor(Math.random() * 2700);               // かなり迷う
  }
  /**
   * 2026-11-10 v2.6.11 竹内さん「この止まった部分ちゃんと解決できるように／人間も止まったりするので
   *   ここの部分を改善ちゃんと行っていく／人間のように」:
   *   人は時々**手が止まる**（考え込む・画面を読み返す・別の事を考える）。止まること自体は自然。
   *   大事なのは「止まった後に必ず戻ってくる」こと。ここでは**長めの停止（8〜25秒）を低確率で入れ**、
   *   その間カーソルは静かに漂わせ、終わったら何事もなく続きへ進む（タイムアウトで失敗にしない）。
   *   ⚠ 本物のフリーズと区別するため、**止まる前と後に必ず点検へ印**を残す（fill_stall / fill_resume）。
   *   止まる確率は「同じ画面で操作が続いているほど少し上がる」（人が飽きて手が止まる形）。
   */
  var _opsSincePause = 0;
  function _longPauseDue() {
    _opsSincePause++;
    // 25操作に1回くらい（約4%）。連続で操作している時ほど出やすい
    var p = 0.02 + Math.min(0.03, _opsSincePause / 2000);
    if (Math.random() >= p) return 0;
    _opsSincePause = 0;
    // 8〜25秒（対数正規・たまに長い）
    return _ln(11000, 0.5, 8000, 25000);
  }
  /**
   * 2026-11-10 v2.6.2 竹内さん「人間が迷いながらマウスもまよったりしながら考えながら入力していく」:
   *   迷っている間はカーソルを**その場で漂わせる**（止まったまま待たない）。35% は狙いを少し外して戻る。
   *   迷いが終わったら押す。カーソルが無い環境では今まで通り（時間だけ待つ）。
   */
  function _hesitateThen(el, ms, done) {
    var P = window.AxlxPointerUi;
    if (P && P.wander && Math.random() < 0.35) { P.wander(el, ms).then(done, done); return; }
    if (P && P.drift) { P.drift(ms).then(done, done); return; }
    setTimeout(done, ms);
  }
  function _scheduleClickDrain() {
    if (_clickQueueTimer || _clickBusyItem || !_clickQueue.length) return;
    var item = _clickQueue.shift();
    _clickBusyItem = item; // 2026-11-10 v2.6.8: 迷いの漂い中も「忙しい」と分かるように（止まったように見える原因）
    // 2026-11-10 v2.6.11 竹内さん「人間も止まったりするので・人間のように」:
    //   低確率で**長めの停止（8〜25秒）**を入れる（人が考え込む・画面を読み返す）。
    //   止まる前と後に必ず点検へ印を残し、止まった後は必ず続きへ戻る（失敗にしない）。
    var pause = _longPauseDue();
    if (pause > 0) {
      try { _auditStepP('fill_pause', Math.round(pause / 1000) + '秒（人が手を止めた）'); } catch (_) {}
      var _startAfterPause = function () {
        try { _auditStepP('fill_resume', '止まった後に再開'); } catch (_) {}
        _scheduleClickDrain();
      };
      _clickBusyItem = null;
      _holdingPause = true;
      var P0 = window.AxlxPointerUi;
      var _endPause = function () { _holdingPause = false; _lastQueueProgressAt = Date.now(); _startAfterPause(); };
      if (P0 && P0.drift) { P0.drift(pause).then(_endPause, _endPause); }
      else { setTimeout(_endPause, pause); }
      return;
    }
    var hesitate = _hesitateMs(item.el);
    var _planned = item.gap + hesitate, _setAt = Date.now();
    if (hesitate > 0) { try { _tmarkHesitate(item.label, hesitate); } catch (_) {} }
    // 2026-11-10 v2.6.2 竹内さん「人間が迷いながらマウスもまよったりしながら考えながら入力していく」:
    //   迷う時は、まず**カーソルをその要素へ動かしてから漂わせる**（迷っている間に手が漂う形）。
    //   要素が無い（select/text の汎用アクション）時は、その場で漂わせる。迷いが終わってから押す。
    var _hesitateDrift = hesitate > 0 && item.el && window.AxlxPointerUi && window.AxlxPointerUi.moveToEl;
    var _startClick = function () {
    _clickQueueTimer = setTimeout(function() {
      _clickQueueTimer = null;
      _auditOp(item.label, _planned, Date.now() - _setAt);
      // 2026-11-10: 中の処理が非同期（1文字ずつの打鍵）でも、終わってから次へ進む（順番が崩れない）
      var done = function () {
        if (item.el) item.el.__axPending = false;
        /**
         * 2026-11-11 竹内さん「ボタン押して次のボタンおすところも。ここの部分はボタンすぐに押せるところや、
         *   この部分は少し考えながら押すから時間必要など」:
         *   旧は 140〜360ms の固定レンジ（どのボタンでも同じ）。
         *   新は**ボタンの意味で変える**（_afterClickGapMs・1か所）:
         *     入力欄は速い／選択肢は結果を見る／「次へ」は行き先を確かめる／決定は画面が変わったか見る（長め）
         */
        var settle = _afterClickGapMs(item.el);
        setTimeout(function () {
          _clickBusyItem = null;
          _clickQueueTimer = null;
          _scheduleClickDrain();
        }, settle);
      };
      try {
        // v2.5.96: 画面の外の時だけ最小の移動で見える位置へ寄せ、動かしたら終わるまで待ってから押す
        var _viewWait = item.el ? _ensureInView(item.el) : 0;
        if (_viewWait > 0) {
          setTimeout(function () {
            try {
              var ret2 = item.el ? _humanPointerClick(item.el, item.fn) : item.fn();
              if (ret2 && typeof ret2.then === "function") { ret2.then(done, done); return; }
            } catch (e2) { console.error('[AX] humanClick 例外（続行）', e2); }
            done();
          }, _viewWait);
          return;
        }
        // 2026-11-10 人間的な動き: 要素を押す時は、人の軌跡でマウスを動かしてから押す（mousemove〜click）。
        //   item.fn は今まで通り最後の1回だけ呼ぶ（_clickIfUnchecked 等のガードはそのまま効く）
        var ret = item.el ? _humanPointerClick(item.el, item.fn) : item.fn();
        if (ret && typeof ret.then === "function") { ret.then(done, done); return; }
      } catch (e) { console.error('[AX] humanClick 例外（続行）', e); }
      done();
    }, item.gap + hesitate);
    };
    if (_hesitateDrift) {
      var P = window.AxlxPointerUi;
      P.moveToEl(item.el).then(function () {
        return (P.wander && Math.random() < 0.35) ? P.wander(item.el, hesitate) : P.drift(hesitate);
      }).then(_startClick, _startClick);
    } else if (hesitate > 0 && window.AxlxPointerUi && window.AxlxPointerUi.drift) {
      window.AxlxPointerUi.drift(hesitate).then(_startClick, _startClick);
    } else {
      _startClick();
    }
  }
  function isClickQueueBusy() {
    // 2026-11-10 v2.6.8 竹内さん「途中でマウスとまったりしている・止まったまま動いていないなぜなのか」:
    //   旧は「タイマーが無い＋列が空」で暇と判定していたが、**迷いの漂い（drift/wander）の間は
    //   タイマーも列も空に見えた**ため、呼び出し側（waitForClick など）が「済んだ」と誤判定し、
    //   次の段が迷いと重なって進んだ後、迷いが終わった側が次の列を起こさず止まっていた。
    //   いま処理中の1件（_clickBusyItem）も「忙しい」に数える。
    return _clickQueueTimer !== null || _clickQueue.length > 0 || !!_clickBusyItem || _holdingPause;
  }
  function whenClickQueueIdle(cb) {
    if (!isClickQueueBusy()) { cb(); return; }
    setTimeout(function() { whenClickQueueIdle(cb); }, _pd(150));
  }
  // fillRealpro 開始時に前回残留のキューを破棄（pendingフラグも解除）
  function clearClickQueue() {
    _clickQueue.forEach(function(it) { if (it.el) it.el.__axPending = false; });
    _clickQueue.length = 0;
    _clickBusyItem = null;
    if (_clickQueueTimer) { clearTimeout(_clickQueueTimer); _clickQueueTimer = null; }
  }
  // 2026-11-10 v2.6.8 竹内さん「止まったまま動いていないなぜなのか」:
  //   万一 迷いの漂いや非同期の処理が返ってこなくても、**列が20秒止まったら強制的に次へ進める**安全弁。
  //   迷いの最長は 4.5秒＋漂い、1文字ずつの打鍵は40字でも約10秒なので、20秒は「明らかに固まった」時だけ。
  var _lastQueueProgressAt = Date.now();
  var _lastBusyLabel = null;
  setInterval(function () {
    try {
      // 2026-11-10 v2.6.8: 「忙しい物が変わった時」だけ時計を戻す（同じ物のままなら止まったまま）
      var cur = _clickBusyItem ? String(_clickBusyItem.label || '?') : null;
      if (_holdingPause) { _lastQueueProgressAt = Date.now(); _lastBusyLabel = null; return; }
      if (!_clickBusyItem) { _lastQueueProgressAt = Date.now(); _lastBusyLabel = null; return; }
      if (cur !== _lastBusyLabel) { _lastBusyLabel = cur; _lastQueueProgressAt = Date.now(); return; }
      if (Date.now() - _lastQueueProgressAt < 20000) return;
      console.warn('[AX] クリックの列が20秒進まない → 強制的に次へ（固まった所: ' + cur + '）');
      if (_clickBusyItem.el) _clickBusyItem.el.__axPending = false;
      if (_clickQueueTimer) { clearTimeout(_clickQueueTimer); _clickQueueTimer = null; }
      _clickBusyItem = null;
      _lastBusyLabel = null;
      _lastQueueProgressAt = Date.now();
      _scheduleClickDrain();
    } catch (_) {}
  }, 3000);

  // スペース除去＋全角英数→半角
  function norm(t) {
    return (t || '').replace(/\s+/g, '').replace(/[Ａ-Ｚａ-ｚ０-９＋－＊／]/g, function(c) {
      return String.fromCharCode(c.charCodeAt(0) - 0xFEE0);
    });
  }

  // position:fixed のモーダル内要素は offsetParent=null になるため BoundingClientRect で判定
  function isVisible(el) {
    try {
      var s = window.getComputedStyle(el);
      if (s.display === 'none' || s.visibility === 'hidden') return false;
      var r = el.getBoundingClientRect();
      if (r.width === 0 && r.height === 0) return false; // display:none祖先の検出
      return true;
    } catch(e) { return false; }
  }

  // テキストで要素を探してクリック（完全一致→包含の順）
  // DIVのonclickはel.click()の方が確実（診断でgo_search等がDIVと判明）
  /**
   * 2026-11-11 竹内さん「地域や駅の検索の際も、押した後検索ボタンにマウス移動させて押していなかった。
   *   駅の部分も駅の設定へ進むへ画面が移動して押されていなかった」:
   *   旧は見つけた要素を **その場で el.click()** していた（カーソルは動かない）。
   *   → 画面では「押した瞬間に次の画面に変わっている」＝人が見て「押していない」と分かる動きだった。
   *   新は **カーソルをその要素まで動かしてから押す**（_humanPointerClick・見えるカーソル＋人の軌跡）。
   *     - 押す位置が画面の外なら、まず要素が入る所まで画面を送る（少し余白を残す）
   *     - 押した後は _afterClickGapMs の間（人が反応を見る間）待つ
   *     - カーソルが使えない環境では今まで通り click だけ（止まらない）
   */
  function _scrollIntoViewSoft(el) {
    // 2026-11-11: 既にある `_ensureInView` に任せる（スクロールの決定は1か所だけ＝
    //   scroll-calm-v2596.test.js の「block: nearest 固定・連続で動かさない」を二重に持たない）
    try { _ensureInView(el); } catch (_) {}
    return true;
  }
  function clickByText(candidates) {
    var els = Array.prototype.slice.call(
      document.querySelectorAll('a,button,div,span,td,li,p,label')
    );
    var hit = null;
    for (var ci = 0; ci < candidates.length && !hit; ci++) {
      var cand = norm(candidates[ci]);
      // 完全一致
      for (var i = 0; i < els.length; i++) {
        if (!isVisible(els[i])) continue;
        if (norm(els[i].textContent) === cand) { hit = els[i]; break; }
      }
    }
    if (!hit) {
      for (var cj = 0; cj < candidates.length && !hit; cj++) {
        var cand2 = norm(candidates[cj]);
        // 包含（短すぎる候補は除外）
        if (cand2.length < 5) continue;
        /**
         * 2026-11-14 竹内さん「まだ所在地絞り込み押すことできていない」:
         *   ⚠ 旧は**最初に見つかった要素**を採っていた。`textContent` は子の文字も全部つなぐので、
         *     左の帯の**親の div** が「所在地絞り込み＋沿線・駅絞り込み＋…」と一致し、
         *     押しても**何も起きない親**を押していた（＝開かない）。
         *   → 「一致する中で**一番内側（子に同じ一致が無い）**」を採る。
         *     内側が無ければ今まで通り。
         */
        var found = [];
        for (var j = 0; j < els.length; j++) {
          if (!isVisible(els[j])) continue;
          if (norm(els[j].textContent).indexOf(cand2) >= 0) found.push(els[j]);
        }
        if (found.length) {
          // 子孫に同じ候補を含む物があれば、親は捨てる（一番内側を採る）
          var inner = found.filter(function (e) {
            return !found.some(function (o) { return o !== e && e.contains(o); });
          });
          hit = (inner.length ? inner[0] : found[0]);
          break;
        }
      }
    }
    if (!hit) return false;
    /**
     * 2026-11-11 竹内さん「ちゃんとマウス移動して押すってところ徹底する」:
     *   押すのが非同期（カーソル移動を待つ）になったので、waitForClick の再試行と重なると
     *   **同じボタンを2回押してしまう**。
     *   ・開閉するボタン（沿線・駅絞り込み・所在地絞り込み）は2回押すと閉じる
     *   ・進むボタンは2回押すと2画面進む
     *   → 同じ要素を短い間に続けて押さない（1.6秒）。画面が変われば要素が消えるので自然に解除される。
     */
    var now = Date.now();
    if (_lastPressEl === hit && now - _lastPressAt < 1600) return true;
    _lastPressEl = hit;
    _lastPressAt = now;
    // 画面の外なら先に送る（見えてから押す＝人の順序）
    _scrollIntoViewSoft(hit);
    var gap = _afterClickGapMs(hit);
    _pressBusy++;
    var _done = function () {
      _pressBusy = Math.max(0, _pressBusy - 1);
      _lastPressGapMs = gap;
    };
    var _pr = _humanPointerClick(hit, function () { try { hit.click(); } catch (_) {} });
    if (_pr && typeof _pr.then === "function") { _pr.then(_done, _done); } else { _done(); }
    return true;
  }
  var _lastPressGapMs = 0;
  var _lastPressEl = null;
  var _lastPressAt = 0;
  /**
   * 2026-11-11 竹内さん「押した後検索ボタンにマウス移動させて押していなかった」:
   *   clickByText / simulateClick は **カーソルが着いてから押す**ので、呼び出した直後はまだ押せていない。
   *   呼び出し側（waitForClick 等）が「押せた」と見てすぐ次の段へ進むと、
   *   ・進むボタンを押し切る前に次の段が動く（画面が変わっていない所を触る）
   *   ・駅の選択が終わる前に検索へ行く
   *   といったズレになる。→ **押し終わるまで待つ**関数を用意する（最大 ms で諦める）。
   */
  var _pressBusy = 0;

  // ────────────────────────────────────────────────────────────────────
  // waitForClick: 要素が出るまでリトライして、成功したら onDone を呼ぶ
  // tryFn    : function() → boolean（true=成功）
  // onDone   : 成功後に呼ぶコールバック
  // maxTries : 最大リトライ数（デフォルト30回 = 約15秒）
  // retryMs  : リトライ間隔ms（デフォルト500ms）
  // pauseMs  : 成功後 onDone を呼ぶまでの待機ms（デフォルト600ms）
  // onFail   : maxTries超過時に呼ぶコールバック
  //            （省略時も静かに停止せず notifyDone を送る — fill-done タイムアウト対策）
  // ────────────────────────────────────────────────────────────────────
  // 2026-11-10 v2.6.7 竹内さん「駅モーダルで失敗するの原因なにかな？そのような失敗あれば原因を追いかけていく」
  //   原因: 沿線・駅モーダルの各段（沿線ボタン→路線一覧→駅ページ→駅の選択→閉じる）が
  //     **30回×500ms＝15秒**で打ち切られていた。人がモーダルを開いて路線を探して押すには短すぎ、
  //     ページが重い時・拡大した時・前のお客様の残りを消している時に「路線一覧が表示されませんでした」で止まっていた。
  //   直し: 75回×800ms（±）≒ 60秒まで待つ。人の速度で操作するので、待ちも人に合わせる。
  //     打ち切りは今まで通り理由を残して検索しない（全件検索はしない）。
  var MODAL_TRIES = 75;
  function _modalTry() { return MODAL_TRIES; }
  function _modalRetryMs() { return 700 + Math.floor(Math.random() * 300); }
  function waitForClick(tryFn, onDone, maxTries, retryMs, pauseMs, onFail) {    maxTries = maxTries !== undefined ? maxTries : 30;
    retryMs  = retryMs  !== undefined ? retryMs  : 500;
    pauseMs  = pauseMs  !== undefined ? pauseMs  : _hd(600); // 省略時も毎回ばらつかせる（呼ぶ側の多くは既に乱数）
    var tries = 0;
    function attempt() {
      // 人間らしいクリックキュー消化中は判定・クリックを開始しない
      // （前ステップのクリックが全て完了してから次ステップに進む＝順序保証。試行回数は消費しない）
      if (isClickQueueBusy()) { setTimeout(attempt, _pd(150)); return; }
      var ok = false;
      try {
        ok = tryFn();
      } catch (err) {
        // tryFn内の例外で静かに死ぬと fill-done が永遠に来ない → 失敗扱いで打ち切る
        console.error('[AX] waitForClick: tryFn例外 → 打ち切り', err);
        if (onFail) {
          try { onFail(); return; } catch (e2) { console.error('[AX] waitForClick: onFail例外', e2); }
        }
        notifyDone('waitForClick: tryFn例外: ' + (err && err.message));
        return;
      }
      if (ok) {
        setTimeout(function() {
          try {
            onDone();
          } catch (err) {
            console.error('[AX] waitForClick: onDone例外 → fill-done送信', err);
            notifyDone('waitForClick: onDone例外: ' + (err && err.message));
          }
        }, pauseMs);
      } else if (tries < maxTries) {
        tries++;
        setTimeout(attempt, _pd(retryMs));
      } else {
        if (onFail) {
          try {
            onFail();
          } catch (err) {
            console.error('[AX] waitForClick: onFail例外 → fill-done送信', err);
            notifyDone('waitForClick: onFail例外: ' + (err && err.message));
          }
        } else {
          // onFail未指定: 従来は「静かに停止」で fill-done が来ずタイムアウトしていた
          console.warn('[AX] waitForClick: タイムアウト（onFail未指定）→ fill-done送信');
          notifyDone('waitForClick timeout');
        }
      }
    }
    attempt();
  }

  // fill-done は1回の fillRealpro につき1回だけ送る（多重送信防止）
  // フェイルセーフ watchdog: 何らかの理由で全経路が沈黙しても必ず送信される
  var _doneNotified = false;
  var _watchdogTimer = null;
  // 2026-09-18 竹内（一括検索の混線）: この自動入力を始めた時の顧客 ID。notifyDone がそのまま返す
  var _fillCustomerId = null;
  // 2026-11-11 竹内さん「最初人間ならここちょっと考える時間あったりする」: 最初にどこから手を付けるか考える間（このページでの1回目か）
  var _fillSessionSeen = false;
  var _thinkBeforeFill = 0;
  // 2026-11-11 竹内さん「地域や駅の部分最初だけ間隔かかる」: 駅の一覧を最初に目で探す間（このページで1回だけ）
  var _stationPickSeen = false;
  // 2026-11-10 自動入力の検索の印（axlx_search_for）を書く時に使う、この回の検索の条件（notifyDone まで持つ）
  var _fillCondForStamp = null;

  // ── 検索の点検（2026-09-25 竹内「検索がちゃんとされていなかったら原因を見つけられるようにする」）──
  // popup が conditions._audit_run_id を載せた時（＝ブレインの時）だけ、この入力で「押せた・押せなかった駅」「路線」「部品」
  // 「リセットの失敗」「条件を外した検索」と、検索ボタンを押す直前のフォームの読み戻しを集め、fill-done の audit に載せて返す（8KB まで）。
  // 読み戻しはこのファイルが値を入れている name（rental_cost1/2・update_date・required_time・structured_date・room_layout_id[]・
  // station_id[]・route_id[]・city_code[]・town_code[]）だけ。見つからない欄は入れない（点検側は比べない）
  var _fillRunId = null;
  var _audit = null;
  // 2026-09-27 v2.5.31 竹内「操作ごとの待ち時間を本物の検索の記録で測る」「広げての回が条件を入れ終わる前に85秒の見張りで止まった（点検23）」:
  //   ・段（steps）は 20 → 60 件まで（リセット・モーダルの各段・検索を押した時刻・タブが見えていたかも足した）
  //   ・操作の列（ops）: クリックの列の1件ごとに {t: 入力を始めてからの ms, k: 何を, p: 予定の間 ms, w: 実際の間 ms}（最大80件）。
  //     w − p が大きい＝タイマーが遅れた（タブが隠れている時の Chrome のタイマーの間引き等）。
  //   ・見張り（85秒）で止まった時は stall に「どの段で・列の残り・タブが見えていたか・遅れの最大」を残す
  //     （その時の読み戻しは stall.form に入れる＝入れ終わっていない値なので点検の比べ（form）には使わない）
  var _fillStartedAt = 0;
  var _hiddenSince = null, _hiddenMs = 0;
  function _auditReset(runId) {
    _fillRunId = runId || null;
    _fillStartedAt = Date.now();
    _hiddenMs = 0;
    _hiddenSince = (document.visibilityState === 'hidden') ? Date.now() : null;
    /**
     * 2026-11-13 竹内さん「まだ自動モードで地域などの部分おせていない、ここ録画しているので」:
     *   ⚠ 旧は `runId ? {...} : null` だったので、**`cond._audit_run_id` が無いと点検を丸ごと作らなかった**。
     *     自動モードの多くは run_id を付けずに動くので、`_audit` が null のまま
     *     → 段（steps）が1つも記録されず、点検は **`stalled:realpro:none`（最後の段: none）** になっていた。
     *     実測: 7日で **259回**。＝「どこで止まったか」が**一切分からない**状態だった。
     *   → **run_id が無くても必ず作る**（その場の番号を振る）。
     *     点検の行としては残せなくても（送る時に番号が要る）、
     *     **段の記録・止まった時の理由**はコンソールと点検の材料に残せるようにする。
     */
    _audit = {
      v: 1, site: 'realpro',
      search_clicked: null, search_press: null, search_buttons: null,
      sel_mismatch: [], form: null, stations_ok: [], stations_missing: [], lines_missing: [],
      click_fails: [], reset_fail: null, area_path: null, fallback: null,
      steps: [], ops: [], late_max: 0, late_over_1s: 0, stall: null,
      // run_id が無い時は「その場の番号」（点検に送れないが、理由は残る）
      local_run_id: _fillRunId || ('local_' + Date.now().toString(36)),
      no_run_id: !_fillRunId,
    };
    if (!_fillRunId) {
      console.warn('[AX] 点検の run_id がありません（cond._audit_run_id）→ 段の記録だけは残します');
    }
  }
  function _auditStepP(k, d) {
    /**
     * 2026-11-13 竹内さん「所在地絞り込みや沿線絞り込みの部分はどうなっているか。抜けていないのか」:
     *   ⚠ 旧は `if (!_audit) return;` だったので、**点検が無い回（自動モードの多く）は
     *     地域・駅の段が学習の記録にも残らなかった**。
     *   ⚠ 実測: 記録は15種類・`左の` と `(なし)` だけで、**地域と駅の操作が0件**。
     *   → 学習への記録（`__axlxRecNoteName`）は **_audit の有無に関係なく**行う。
     *     点検の配列への追加は今まで通り `_audit` がある時だけ。
     */
    try {
      if (typeof window !== "undefined" && typeof window.__axlxRecNoteName === "function") {
        /**
         * 2026-11-14 竹内さん「画面録画したのみたら一連の動き学習できるからいまみてみて」:
         *   ⚠ **ここが動いていなかった本当の理由**: `page-script.js` は **ページの世界**で動き
         *     （content.js が `<script src>` で注入）、`human-learn-record.js` は
         *     **アイソレーテッドワールド**（manifest の content_scripts）。
         *     世界が違うので `window.__axlxRecNoteName` は**見えない**（実測: 地域の段が0件）。
         *   → **postMessage で橋渡し**する（content script 側が受けて記録する）。
         *     ⚠ 残すのは**段の名前だけ**（区の名前・入力した中身は入れない）。
         */
        var _STEP_JA = {
          modal: "所在地絞り込み",
          ward: "区を選ぶ",
          ward_by_code: "区を選ぶ",
          ward_next_press: "地域の設定へ進む",
          next_step: "地域の設定へ進む",
          town: "町字を選ぶ",
          modal_close: "確定してリストへ",
          modal_confirm: "確定してリストへ",
          station: "沿線・駅絞り込み",
          station_line: "沿線を選ぶ",
          station_next_press: "駅の設定へ進む",
          station_confirm: "確定してリストへ",
        };
        var _nm = _STEP_JA[String(k)] || null;
        if (_nm) {
          // ① 同じ世界に入口があればそれ（将来 page-script 側に置いた時）
          try { window.__axlxRecNoteName(_nm); } catch (_) {}
          // ② 世界をまたぐ橋（content script の human-learn-record.js が受ける）
          try { window.postMessage({ from: "axlx-rec-note-name", name: _nm }, "*"); } catch (_) {}
        }
      } else {
        var _STEP_JA2 = {
          modal: "所在地絞り込み", ward: "区を選ぶ", ward_by_code: "区を選ぶ",
          ward_next_press: "地域の設定へ進む", next_step: "地域の設定へ進む",
          town: "町字を選ぶ", modal_close: "確定してリストへ", modal_confirm: "確定してリストへ",
          station: "沿線・駅絞り込み", station_line: "沿線を選ぶ",
          station_next_press: "駅の設定へ進む", station_confirm: "確定してリストへ",
        };
        var _nm2 = _STEP_JA2[String(k)] || null;
        if (_nm2) {
          try { window.postMessage({ from: "axlx-rec-note-name", name: _nm2 }, "*"); } catch (_) {}
        }
      }
    } catch (_) {}
    if (!_audit) return;
    _audit.steps.push({ at: Date.now(), k: String(k).slice(0, 30), d: d == null ? null : String(d).slice(0, 120) });
    if (_audit.steps.length > 60) _audit.steps.shift();
  }
  function _auditOp(label, planned, waited) {
    if (!_audit || !_audit.ops) return;
    var late = waited - planned;
    if (late > _audit.late_max) _audit.late_max = late;
    if (late > 1000) _audit.late_over_1s++;
    _audit.ops.push({ t: Date.now() - _fillStartedAt, k: String(label || '').slice(0, 40), p: planned, w: waited, by: 'auto' });
    if (_audit.ops.length > 80) _audit.ops.shift();
  }
  // 2026-11-10 v2.5.99 竹内さん「ボタン選択する際人間ならたまにまよう」:
  //   迷った操作を点検に残す（数と合計・どこで迷ったか）。あとで人の回と比べる材料になる
  function _tmarkHesitate(label, ms) {
    if (!_audit) return;
    _audit.hesitate_n = (_audit.hesitate_n || 0) + 1;
    _audit.hesitate_ms = (_audit.hesitate_ms || 0) + ms;
    if (!_audit.hesitate_last || _audit.hesitate_last.length < 8) {
      (_audit.hesitate_last = _audit.hesitate_last || []).push({ k: String(label || '').slice(0, 30), ms: ms });
    }
  }
  // ── 2026-11-10 竹内「この画面の見張りの部分もちゃんと人間が動いているか確認もできるように」──
  //   拡張が出す操作（isTrusted=false）と、人が本当に押した操作（isTrusted=true）を区別して数える（human-trace.js の共通部品）。
  //   案内モード（スタッフが押す）では人の操作だけが来る＝「人が操作しているか」を点検の記録で確かめられる。
  //   入力の中身（値）は残さない。数と、最後の操作の種類・欄の名前・間の平均だけ。
  var _HTr = (function () {
    try {
      var HT = (typeof window !== "undefined" ? window : self).AxlxHumanTrace;
      if (!HT) return null;
      var tr = HT.create({});
      tr.attach(document, window);
      return tr;
    } catch (_) { return null; }
  })();
  function _humanSnapshot() { return _HTr ? _HTr.snapshot() : null; }
  // 2026-11-10 案内モード（realpro-guide.js）から読めるように外に出す（案内は押さないので、人の操作だけが数えられる）
  try { window.__axlxHumanSnapshot = _humanSnapshot; } catch (_) {}
  try {
    document.addEventListener('visibilitychange', function () {
      var hidden = document.visibilityState === 'hidden';
      if (hidden && _hiddenSince == null) _hiddenSince = Date.now();
      if (!hidden && _hiddenSince != null) { _hiddenMs += Date.now() - _hiddenSince; _hiddenSince = null; }
      if (window._axFillRunning) _auditStepP('vis', document.visibilityState);
    });
  } catch (e) { /* 記録だけ */ }
  function _auditStall() {
    if (!_audit) return;
    try {
      var last = _audit.steps.length ? _audit.steps[_audit.steps.length - 1] : null;
      var hiddenNow = _hiddenSince != null ? Date.now() - _hiddenSince : 0;
      var closeEl = document.querySelector('div.this_window_close');
      _audit.stall = {
        stage: last ? last.k : 'none',
        stage_detail: last ? last.d : null,
        since_stage_ms: last ? Date.now() - last.at : null,
        elapsed_ms: Date.now() - _fillStartedAt,
        visibility: document.visibilityState,
        has_focus: (typeof document.hasFocus === 'function') ? document.hasFocus() : null,
        hidden_ms: _hiddenMs + hiddenNow,
        queue_len: _clickQueue.length,
        queue_busy: isClickQueueBusy(),
        queue_next: _clickQueue.length ? _clickQueue[0].label : null,
        queue_busy_item: (_clickBusyItem && _clickBusyItem.label) || null, // 2026-11-10 v2.6.8 いま漂い/処理中の物
        ops_done: _audit.ops ? _audit.ops.length : 0,
        late_max: _audit.late_max,
        late_over_1s: _audit.late_over_1s,
        modal_open: !!(closeEl && isVisible(closeEl)),
        city_checked: document.querySelectorAll('input[name="city_code[]"]:checked').length,
        form: _readRealproForm(),
      };
    } catch (e) { _audit.stall = { stage: 'stall_read_error', error: String((e && e.message) || e).slice(0, 100) }; }
  }
  function _visibleTexts(sel, n) {
    try {
      return Array.prototype.slice.call(document.querySelectorAll(sel)).filter(function (el) { return el.offsetParent !== null; })
        .map(function (el) { return (el.textContent || el.value || '').replace(/\s+/g, '').slice(0, 20); }).filter(Boolean).slice(0, n || 8);
    } catch (e) { return []; }
  }
  /**
   * 2026-11-11 竹内さん「所在地の部分も選択しているのに把握できていない可能性ある。
   *   ここ選択して入れば場所は選択されているから大丈夫。地域か駅どちらか入っていればそれで場所は選択されている」
   *
   * ⚠ リアプロは**モーダルを閉じると区のチェックボックスが DOM から消える**（または隠れる）。
   *   閉じた後に `input[name="city_code[]"]:checked` を数えると **0 件**になり、
   *   「場所が入っていない」と誤解して止まる（＝実際は選べているのに止まる）。
   *   → **自分で選んだ区を覚えておく**（`_axWardPicked`）。DOM に無くても、
   *     一度も選んでいなければ「無い」、選んだ事があれば「ある」と判定する。
   *   → 駅・沿線も同じ（`_axStationPicked`）。
   */
  var _axWardPicked = {};      // value -> { at, text }
  var _axStationPicked = {};   // value -> { at, text }
  var _axPickedAt = 0;
  function _noteWardPicked(code, text) {
    try {
      if (code == null || String(code) === "") return;
      _axWardPicked[String(code)] = { at: Date.now(), text: String(text || "").slice(0, 24) };
      _axPickedAt = Date.now();
      /**
       * 2026-11-14: **自動で入れた区を覚える**（人が選んだ物と区別するため）。
       *   ⚠ モーダルを開いた直後に「前の選択を外す」処理があり、
       *     覚えが無いと**人が選んだ区まで消していた**（竹内さん「自動で消してしまっている」）。
       *   → ここで覚えておけば、外すのは**自動で入れた物だけ**になる。
       */
      if (window._axAutoPicking) _noteAutoPicked("city", code);
    } catch (_) {}
  }
  function _noteStationPicked(code, text) {
    try {
      if (code == null || String(code) === "") return;
      _axStationPicked[String(code)] = { at: Date.now(), text: String(text || "").slice(0, 24) };
      _axPickedAt = Date.now();
    } catch (_) {}
  }
  function _resetPicked() { _axWardPicked = {}; _axStationPicked = {}; _axPickedAt = 0; }
  /** 覚えている（選んだ）数 */
  function _pickedCounts() {
    return { ward: Object.keys(_axWardPicked).length, station: Object.keys(_axStationPicked).length };
  }
  function _checkedLabelTexts(name) {
    try {
      return Array.prototype.slice.call(document.querySelectorAll('input[name="' + name + '"]:checked')).map(function (inp) {
        var l = (inp.closest && inp.closest('label')) || inp.parentElement;
        var t = l ? (l.textContent || '').replace(/\s+/g, '').slice(0, 24) : '';
        return t || String(inp.value || '');
      }).slice(0, 80);
    } catch (e) { return []; }
  }
  function _readRealproForm() {
    var f = {};
    try {
      var sel = function (name) { return document.querySelector('select[name="' + name + '"]'); };
      var r2 = sel('rental_cost2'); if (r2) f.rent_max = r2.value;
      var r1 = sel('rental_cost1'); if (r1) f.rent_min = r1.value;
      var up = sel('update_date'); if (up) f.update_days = up.value;
      var ag = sel('structured_date'); if (ag) f.age = ag.value;
      var wk = document.querySelector('input[name="required_time"]'); if (wk) f.walk = wk.value;
      f.layouts = _checkedLabelTexts('room_layout_id[]');
      f.stations = _checkedLabelTexts('station_id[]');
      f.lines = _checkedLabelTexts('route_id[]');
      f.wards = _checkedLabelTexts('city_code[]').concat(_checkedLabelTexts('town_code[]')).slice(0, 80);
      // 2026-11-11 竹内さん「地域か駅どちらか入っていればそれで場所は選択されている」:
      //   モーダルを閉じると DOM から消えるので、**覚えている分**も読み戻しに載せる（点検で「入っている」と分かる）
      try {
        var _pk = _pickedCounts();
        if (!f.wards.length && _pk.ward > 0) f.wards_remembered = Object.keys(_axWardPicked).slice(0, 20);
        if (!f.stations.length && _pk.station > 0) f.stations_remembered = Object.keys(_axStationPicked).slice(0, 20);
      } catch (_) {}
    } catch (e) { f.read_error = String((e && e.message) || e).slice(0, 100); }
    return f;
  }
  function _auditPack() {
    if (!_audit) return null;
    try {
      delete _audit._searchWaitMarked;
      // 2026-11-10: 人が動いたか（拡張の操作と区別した数）を点検の記録に載せる
      _audit.human = _humanSnapshot();
      var a = _audit;
      if (JSON.stringify(a).length > 8000) {
        a = JSON.parse(JSON.stringify(a));
        ['stations_missing', 'lines_missing', 'click_fails'].forEach(function (k) { a[k] = (a[k] || []).slice(0, 6).map(function (m) { if (m && m.sample) m.sample = m.sample.slice(0, 3); return m; }); });
        if (a.form) ['stations', 'lines', 'wards', 'layouts'].forEach(function (k) { if (a.form[k]) a.form[k] = a.form[k].slice(0, 20); });
        if (a.stall && a.stall.form) ['stations', 'lines', 'wards', 'layouts'].forEach(function (k) { if (a.stall.form[k]) a.stall.form[k] = a.stall.form[k].slice(0, 10); });
        a.stations_ok = (a.stations_ok || []).slice(0, 20);
        a.ops = (a.ops || []).slice(-30);
        a.steps = (a.steps || []).slice(-30);
        a.truncated = true;
      }
      return a;
    } catch (e) { return { v: 1, site: 'realpro', pack_error: true }; }
  }

  // errMsg を渡すと fill-done メッセージに error フィールドが付き、
  // content.js → background.js へ中継されてログ・デバッグ材料になる。
  // 正常系は引数なしで呼ぶこと。
  function notifyDone(errMsg, gate) {
    window._axFillRunning = false; // 次回呼び出しのためにフラグをリセット
    if (_doneNotified) return;
    _doneNotified = true;
    if (_watchdogTimer) { clearTimeout(_watchdogTimer); _watchdogTimer = null; }
    /**
     * 2026-11-10 竹内さん「押したらちゃんと送られるようになっているから、自動モードの場合押したらちゃんとそのまま売り上げ番長に送られるようにする」:
     *   自動モードは案内（realpro-guide.js）が OFF なので「この一覧は誰の検索か」の印（axlx_search_for）が書かれず、
     *   印刷用PDF を押すたびに「違うお客様の物件では？」の小窓が出て止まっていた。
     *   自動入力で検索を押せた時も、ここで印を書く（＝拡張がその人の条件で検索した一覧）。門で止めた時（gate）は書かない。
     */
    try {
      var SS = (typeof self !== 'undefined' ? self : window).AxlxSearchStamp;
      if (SS && _fillCustomerId && !gate && !errMsg) {
        var prev = SS.read ? SS.read() : null;
        if (!prev || String(prev.cid) !== String(_fillCustomerId) || Date.now() - Number(prev.at || 0) > 60 * 1000) {
          SS.write({
            cid: String(_fillCustomerId), name: '', at: Date.now(), site: 'realpro', complete: true,
            intended: _fillCondForStamp && SS.compactIntended ? SS.compactIntended(_fillCondForStamp) : null, filled: null,
          });
          console.log('[AX] 自動入力の検索の印を書きました（この一覧は誰の検索か）:', String(_fillCustomerId).slice(0, 8));
        }
      }
    } catch (_) { /* 印が書けなくても今まで通り */ }
    var msg = { from: 'aixlinx-fill-done' };
    // v2.5.50 検索を押す前の関所で止めた（検索していない）＝この合図で物件を取りに行かせない
    if (gate) msg.gate = true;
    // 2026-09-18: この入力を始めた時の顧客 ID をそのまま返す（誰の完了かを送る側が持つ）
    if (_fillCustomerId) msg.customerId = _fillCustomerId;
    if (errMsg) msg.error = String(errMsg).slice(0, 300);
    // 検索の点検（ブレインの時だけ）: この入力の記録を載せて返す
    /**
     * 2026-11-13 竹内さん「まだ自動モードで地域などの部分おせていない、ここ録画しているので」:
     *   ⚠ 旧は `if (_fillRunId)` で、**run_id が無いと点検を一切送らなかった**。
     *     そのため自動モードの回は「途中で止まった（最後の段: none）」になり、
     *     **どこで止まったか分からない**まま259回たまっていた。
     *   → run_id が無くても**その場の番号で送る**（点検の材料になる方が大事）。
     */
    if (_audit) {
      if (_fillRunId) msg.runId = _fillRunId;
      if (errMsg) _auditStepP('done_error', errMsg);
      try {
        msg.audit = _auditPack();
        if (!_fillRunId) msg.audit.run_id = _audit.local_run_id || null;
        msg.audit.no_run_id = !_fillRunId;
      } catch (_) {}
    }
    window.postMessage(msg, '*');
  }

  // 非ブロッキング警告表示（alert() はモーダルブロッキングで無人運転時に
  // fill-done の配送まで止めてしまうため使用禁止）
  function showWarnToast(msg) {
    try {
      console.log('[AX] ' + msg);
      var t = document.createElement('div');
      t.textContent = '⚠️ ' + msg;
      t.style.cssText = 'position:fixed;top:16px;right:16px;z-index:2147483647;' +
        'background:#c0392b;color:#fff;padding:12px 16px;border-radius:8px;' +
        'font-size:13px;max-width:340px;box-shadow:0 4px 12px rgba(0,0,0,.3);white-space:pre-wrap;';
      document.body.appendChild(t);
      setTimeout(function() { if (t.parentNode) t.parentNode.removeChild(t); }, 15000);
    } catch (e) { /* 表示失敗は無視 */ }
  }

  // next_step_button2 がY状態（市区郡選択済み）か確認
  // 診断確認: Y状態=クラス town_search_Y が独立で付く（next_action とは別クラス）
  // NG: '.next_action_town_search_Y'（アンダースコアで繋げると一致しない）
  function isWardButtonY() {
    var btn = document.querySelector('div.next_step_button2');
    return btn ? btn.classList.contains('town_search_Y') : false;
  }

  /**
   * 市区郡チェックボックス（city_code[]）が**1つ以上** checked か（DOMフォールバック）。
   *
   * ⚠ 2026-11-14 竹内さん「なぜか地域を都島区を押してしまっている」:
   *   **この関数を「もう選ばれている」の判定に使ってはいけない**。
   *   リアプロは前のお客様の区を残すので、**都島区が1つ残っているだけ**でも true になる。
   *   → その結果「選び直さずに確定」して、**頼んだ3区が入らず都島区だけ**になった（本番の点検記録で確認）。
   *   「選ばれている」の判定は **`isAllWantedWardsChosen(wantCodes)`** を使う。
   */
  function isWardChecked() {
    if (isWardButtonY()) return true; // ボタンY状態が最も確実
    return document.querySelectorAll('label input[name="city_code[]"]:checked').length > 0;
  }

  /**
   * 2026-11-14: **欲しい区が全部そろっているか**（1つでも欠けたら false）。
   *   ⚠ 1区でも入っていれば true にする `isWardChecked` とは**別物**（取り違えると都島区だけ入る）。
   * @param {string[]} wantCodes 入れたい区のコード（cond.city_codes）
   * @returns {{all:boolean, missing:string[], stale:string[], checked:string[]}}
   */
  function isAllWantedWardsChosen(wantCodes) {
    var want = (Array.isArray(wantCodes) ? wantCodes : []).map(String).filter(Boolean);
    var checked = Array.prototype.slice
      .call(document.querySelectorAll('label input[name="city_code[]"]:checked'))
      .map(function (inp) { return String(inp.value); });
    var missing = want.filter(function (c) { return checked.indexOf(c) < 0; });
    var stale = checked.filter(function (c) { return want.indexOf(c) < 0; });
    return { all: want.length > 0 && missing.length === 0 && stale.length === 0, missing: missing, stale: stale, checked: checked };
  }

  // 完全マウスイベントシーケンスでクリック（mousedown→mouseup→click）
  // サイト独自のイベントデリゲーションがmousedownを待っている場合に対応
  // 人間の押下時間を再現: mousedown の 40〜90ms 後に mouseup→click を発火
  // （後続処理は waitForClick の pauseMs ≧ 240ms で待機するため間に合う）
  /**
   * 2026-11-11 竹内さん「ちゃんとマウス移動して押すってところ徹底する」:
   *   旧はカーソルを動かさずに mousedown→mouseup→click を出していた（画面のカーソルは別の所に居る）。
   *   新は **カーソルをその要素まで動かしてから** 押す（見えるカーソル＋人の軌跡）。
   *   押す順（mousedown→40〜90ms→mouseup→click）と「1回だけ押す」は今まで通り。
   * ⚠ カーソル移動がいま非同期になったので、waitForClick の再試行と重なると
   *   **同じボタンを2回押してしまう**（進むボタンなら2画面進む）。押している最中は再入を断る。
   */
  var _axPressing = null;
  function simulateClick(el) {
    if (!el) return;
    if (_axPressing === el) { return; } // 同じ要素を押している最中（再試行で重ねない）
    _pressBusy++;
    var _done = function () { _pressBusy = Math.max(0, _pressBusy - 1); };
    var press = function () {
      el.dispatchEvent(new MouseEvent('mousedown', {bubbles:true, cancelable:true, view:window}));
      setTimeout(function() {
        el.dispatchEvent(new MouseEvent('mouseup',   {bubbles:true, cancelable:true, view:window}));
        el.dispatchEvent(new MouseEvent('click',     {bubbles:true, cancelable:true, view:window}));
        if (_axPressing === el) _axPressing = null;
        _done();
      }, humanRand(40, 90));
    };
    var P = window.AxlxPointerUi;
    if (P && P.ensure && P.moveToEl) {
      _axPressing = el;
      _scrollIntoViewSoft(el);
      try { P.ensure(); } catch (_) {}
      P.moveToEl(el).then(function () {
        if (P.tap) { try { P.tap(); } catch (_) {} }
        press();
      }, function () { if (_axPressing === el) _axPressing = null; press(); });
      return;
    }
    press();
  }

  // 市区郡ラベルを安全にクリック（city_code[]を持つlabel限定・checked済みは再クリックしない）
  function clickWardPrecise(texts) {
    /**
     * 2026-11-11 竹内さん「所在地も通常モードならちゃんと光るのに自動モードやAIXモードでできていない」:
     *   案内モード（realpro-guide.js）は **`input[name="city_code[]"][value="<コード>"]` をコードで直接**探す。
     *   自動モードは**文字で照合**していたので、「大阪市北区」と「北区」の違い・
     *   `・`や全角の揺れ・ラベルの入れ子の違いで取りこぼしていた（＝区が押せない＝所在地が入らない）。
     *   → **コードがあればコードで先に探す**（一番確実）。無ければ今まで通り文字で探す。
     */
    var codes = (window.__axlxWardCodes && window.__axlxWardCodes.length) ? window.__axlxWardCodes : null;
    if (codes && codes.length) {
      var hitByCode = 0;
      for (var ci2 = 0; ci2 < codes.length; ci2++) {
        var c2 = document.querySelector('input[name="city_code[]"][value="' + String(codes[ci2]) + '"]');
        if (!c2) continue;
        var lb2 = (c2.closest && c2.closest('label')) || c2.parentElement || c2;
        if (c2.checked) { hitByCode++; _noteWardPicked(codes[ci2], lb2.textContent); continue; }
        if (isVisible(lb2)) {
          // 2026-11-14: 区は**同期で押す**（押した直後に「確定してリストへ」へ進むため・上の _pressLearned の注記と同じ理由）
          simulateClick(lb2); hitByCode++; _noteWardPicked(codes[ci2], lb2.textContent);
        }
      }
      if (hitByCode > 0) {
        _auditStepP('ward_by_code', hitByCode + '区（コードで選択）');
        return true;
      }
    }
    var allLabels = Array.prototype.slice.call(document.querySelectorAll('label'));
    var wardLabels = allLabels.filter(function(l) {
      return !!l.querySelector('input[name="city_code[]"]');
    });
    if (wardLabels.length === 0) return false; // まだ市区郡ページに到達していない
    for (var ci = 0; ci < texts.length; ci++) {
      var t = norm(texts[ci]);
      for (var i = 0; i < wardLabels.length; i++) {
        var ltxt = norm(wardLabels[i].textContent);
        if (ltxt !== t && !ltxt.includes(t) && !t.includes(ltxt)) continue;
        var inp = wardLabels[i].querySelector('input[name="city_code[]"]');
        if (inp && inp.checked && isWardButtonY()) { _noteWardPicked(inp.value, wardLabels[i].textContent); return true; } // 選択済みかつボタンY → 成功
        if (inp && inp.checked) {
          /**
           * 2026-11-13 竹内さん「まだ自動モードで地域などの部分おせていない」:
           *   ⚠ 旧はここで **`simulateClick(wardLabels[i])`＝チェックを外してしまう**（トグル）。
           *     「DOM上はchecked だがボタンがN」を「未反映」と決めつけて押し直していたが、
           *     実際は**押せている**事が多く、押し直すと**選択が外れる**。
           *     実測: 「A B A B A B…」の交互クリックが **40件中24件**あった（人が10往復も押さない）。
           *   → **外さずに**、サイトの内部状態を反映させる（Yにする）だけにする。
           *     `ensureWardButtonY` が「外してから押し直す」を**必要な時だけ**行う（同じ所の二重押しを避ける）。
           */
          try { if (typeof ensureWardButtonY === 'function') ensureWardButtonY(function () {}); } catch (_) {}
          _noteWardPicked(inp.value, wardLabels[i].textContent);
          return true;
        }
        // 未選択 → フルイベントシーケンスでクリック
        /**
         * 2026-11-14 竹内さん「この地域押すところ…ちゃんと学習する」:
         *   ⚠ 区のボタンにも学んだ位置を使おうとしたが、`_pressLearned` は
         *     **カーソルを動かしてから押す（200〜900ms かかる・非同期）**。
         *     区を押した直後に「確定してリストへ」へ進む流れなので、
         *     押す前に確定が走って**区が入らない**恐れがある。
         *   → 区・町字は**今まで通り同期で押す**（`simulateClick`）。
         *     学んだ位置は「所在地絞り込み（開く）」「検索（押す）」で使う。
         *     区の位置学習は `axlx_learn_points` に残っており、順番の学習にも効いている。
         */
        simulateClick(wardLabels[i]);
        if (inp) _noteWardPicked(inp.value, wardLabels[i].textContent);
        return true;
      }
    }
    return false;
  }

  // 旧 alertStop は alert() ブロッキングにより無人運転で fill-done が届かなくなるため廃止。
  // タイムアウト時は各モーダル経路のフォールバック関数（条件なし検索）を使うこと。

  // v2.5.50 検索を押す前の関所の材料（fillRealpro が入れるはずの間取りを置く・無ければ見ない）
  var _axExpect = null;
  var _axGateRetried = false;
  /**
   * 2026-11-10 v2.6.18 竹内さん「ちゃんと画面見て判断できるようになってるのかな場所など」→「なおす」:
   *   旧は**間取りだけ**を画面で確かめ、家賃・更新日・築年・徒歩・場所（区/駅）は確かめずに検索していた
   *   （入っていなくても「入れたつもり」で検索に進む）。
   *   新は入れるはずの値を1か所（_axExpect）に置き、**画面の実際の値を読み戻して1つずつ比べる**。
   *   比べる物: 家賃の上限・下限／更新日／築年数／徒歩の分数／間取り／場所（区 or 駅のどちらかが入っているか）
   *   戻り値: { errors: [理由の文...], missingLayout: bool }
   *     errors    … 画面が「入れるはずの値」になっていない物（人が見て分かる日本語）
   *     missingLayout … 間取りが0個（これは1回だけ入れ直す対象）
   *   ⚠ 画面に欄が無い物（サイトにその項目が無い）は比べない（止めない）。
   *   ⚠ 「−1 / 下限なし」など“指定なし”の値は比べない（入れなくて正しい）。
   */
  function _axGateCheck() {
    var out = { errors: [], missingLayout: false };
    try {
      if (!_axExpect) return out;
      var sel = function (n) { return document.querySelector('select[name="' + n + '"]'); };
      var same = function (a, b) { return String(a == null ? '' : a) === String(b == null ? '' : b); };
      var isNone = function (v) { return v == null || v === '' || v === '-1' || v === '0'; };

      // ① 家賃（上限・下限）: 欄がある時だけ比べる
      if (_axExpect.rentMax != null && !isNone(_axExpect.rentMax)) {
        var r2 = sel('rental_cost2');
        if (r2 && !same(r2.value, _axExpect.rentMax)) {
          out.errors.push('家賃の上限が画面と違う（入れるはず ' + _axExpect.rentMax + '／画面 ' + r2.value + '）');
        }
      }
      if (_axExpect.rentMin != null && !isNone(_axExpect.rentMin)) {
        var r1 = sel('rental_cost1');
        if (r1 && !same(r1.value, _axExpect.rentMin)) {
          out.errors.push('家賃の下限が画面と違う（入れるはず ' + _axExpect.rentMin + '／画面 ' + r1.value + '）');
        }
      }
      // ② 更新日
      if (_axExpect.updateDays != null) {
        var up = sel('update_date');
        if (up && !same(up.value, _axExpect.updateDays)) {
          out.errors.push('更新日が画面と違う（入れるはず ' + _axExpect.updateDays + '／画面 ' + up.value + '）');
        }
      }
      // ③ 築年数
      if (_axExpect.age != null && !isNone(_axExpect.age)) {
        var ag = sel('structured_date');
        if (ag && !same(ag.value, _axExpect.age)) {
          out.errors.push('築年数が画面と違う（入れるはず ' + _axExpect.age + '／画面 ' + ag.value + '）');
        }
      }
      // ④ 徒歩の分数
      if (_axExpect.walk != null && String(_axExpect.walk).trim() !== '') {
        var wk = document.querySelector('input[name="required_time"]');
        if (wk && !same(wk.value, _axExpect.walk)) {
          out.errors.push('駅からの徒歩が画面と違う（入れるはず ' + _axExpect.walk + '／画面 ' + wk.value + '）');
        }
        /**
         * 2026-11-14 竹内さん「駅からの移動手段のところ 徒歩をプルダウンで選択するところできていなかった」:
         *   ⚠ 旧は分数（required_time）だけを見ていて、**移動手段（transportation_id）が「徒歩」か**を
         *     確かめていなかった。だから「徒歩10分」ではなく「車10分」「バス10分」でも通っていた。
         *   → **選ばれている移動手段の文字が「徒歩」か**を確かめる（違えば入れ直しの対象）。
         */
        try {
          var trSel = document.querySelector('select[name="transportation_id"]');
          if (trSel && trSel.options && trSel.selectedIndex >= 0) {
            var trTxt = String(trSel.options[trSel.selectedIndex].textContent || "").replace(/\s+/g, "");
            // 「指定なし」「こだわらない」等は未選択とみなす（選ばれていない）
            if (!trTxt || /指定なし|こだわらない|選択して|unselected/i.test(trTxt)) {
              out.errors.push('移動手段が未選択（「徒歩」にするはず／画面「' + trTxt + '」）');
              out.missingTransport = true;
            } else if (trTxt.indexOf("徒歩") < 0) {
              out.errors.push('移動手段が「徒歩」でない（画面「' + trTxt + '」）');
              out.missingTransport = true;
            }
          }
        } catch (_) {}
      }
      // ⑤ 間取り（0個なら入れ直す対象）
      if (_axExpect.layoutVals && _axExpect.layoutVals.length) {
        var want = _axExpect.layoutVals.map(String);
        var checked = Array.prototype.slice.call(document.querySelectorAll('input[name="room_layout_id[]"]:checked'))
          .filter(function (cb) { return want.indexOf(String(cb.value)) >= 0; });
        if (!checked.length) {
          out.missingLayout = true;
          var total = document.querySelectorAll('input[name="room_layout_id[]"]').length;
          out.errors.push('間取り（' + String(_axExpect.floorPlan || '').slice(0, 30) + '）が画面に入っていない（間取りの欄 ' + total + '個・チェック 0）');
        }
      }
      /**
       * ⑥ 場所: **所在地（区・町）か沿線・駅のどちらかが入っていれば「場所あり」**として通す。
       *
       * 2026-11-11 竹内さん「場所あるのに場所ないと誤解している場合おおいのでは。
       *   所在地か沿線駅のどちらかで選択していれば場所は指定している。そこの部分誤解されていないか」
       *
       * ⚠ 旧は `_axExpect.areaMode`（'ward' か 'station'）で**どちらを求めるか**を決めて、
       *   その軸だけを見て「入っていない」と判定していた。
       *   → area_mode が 'ward' でも実際は沿線で検索する事があり、**場所があるのに「無い」と誤解**していた。
       * 新: **どちらか1つでも入っていれば場所あり**（＝全件検索にならない）。
       *   両方0の時だけ止める（大阪府の全件検索を防ぐ）。
       */
      if (_axExpect.areaMode) {
        var wardN = document.querySelectorAll('input[name="city_code[]"]:checked').length +
                    document.querySelectorAll('input[name="town_code[]"]:checked').length;
        var stN = document.querySelectorAll('input[name="station_id[]"]:checked').length +
                  document.querySelectorAll('input[name="route_id[]"]:checked').length;
        /**
         * 2026-11-11 竹内さん「所在地の部分も選択しているのに把握できていない可能性ある。
         *   ここ選択して入れば場所は選択されているから大丈夫。地域か駅どちらか入っていればそれで場所は選択されている」
         *
         * ⚠ モーダルを閉じると区・駅のチェックボックスが DOM から消える/隠れるので、
         *   ここで数えると **0 件**になる（＝選べているのに「場所なし」と誤解して止まる）。
         * → **自分で選んだ物を覚えている分**も数える（`_pickedCounts`）。
         */
        var _picked = _pickedCounts();
        // 画面に残っている数と、覚えている数の大きい方を使う
        var wardEff = Math.max(wardN, _picked.ward);
        var stEff = Math.max(stN, _picked.station);
        // 画面の読み取りに失敗していても、URL に条件が載っていれば場所ありとみなす
        var urlHasArea = false;
        try {
          var _q = new URLSearchParams(location.search);
          ["city_code", "city_code[]", "town_code", "town_code[]", "station_id", "station_id[]", "route_id", "route_id[]"].forEach(function (k) {
            if (_q.has(k) && String(_q.get(k) || "") !== "") urlHasArea = true;
          });
        } catch (_) {}
        var hasArea = (wardEff > 0) || (stEff > 0) || urlHasArea;
        if (!hasArea) {
          out.errors.push('場所（' + String(_axExpect.areaText || '').slice(0, 24) + '）が画面に入っていない（区 ' + wardN + '・駅 ' + stN + '）');
        } else {
          // どちらか入っていれば通す。点検に「どちらで入ったか」を残す（誤解の追跡用）
          out.area_ok_by = (wardEff > 0 && stEff > 0) ? 'both' : (wardEff > 0 ? 'ward' : 'station');
          out.area_counts = { dom_ward: wardN, dom_station: stN, remembered_ward: _picked.ward, remembered_station: _picked.station };
        }
      }
    } catch (e) { /* 読めない時は止めない（今まで通り） */ }
    return out;
  }
  /** 旧: 間取りだけを見る（互換のため残す） */
  function _axGateMissing() {
    var g = _axGateCheck();
    return g.missingLayout ? (g.errors[0] || '間取りが入っていない') : null;
  }

  // 検索ボタンをクリック
  // リアプロは DIV.go_search が実際の検索ボタン（診断で確認済み）
  // 2026-10-01 竹内「押したら勝手に自動検索始まって…防ぐ」: 案内モード（<html data-axlx-guide> が "0" 以外）の間は拡張が検索を押さない（どの道から来ても）
  function _guideOn() { return document.documentElement.getAttribute("data-axlx-guide") !== "0"; }
  /**
   * 2026-11-11 竹内さん「まだ自動モード検索されない。なんで改善したはずが改善されていないのか」
   *
   *   何度直しても動かないので、**推測をやめて実際の値を残す**。
   *   検索を押す所で「なぜ押した／押さなかった」かを storage に残し、
   *   画面の帯から読めるようにする（`axlx_search_why`）。
   */
  function _noteSearchWhy(why, extra) {
    try {
      var o = {
        why: String(why || "").slice(0, 80),
        at: Date.now(),
        guide: (function () { try { return document.documentElement.getAttribute("data-axlx-guide"); } catch (_) { return null; } })(),
        fillRunning: !!window._axFillRunning,
        queueBusy: (function () { try { return isClickQueueBusy(); } catch (_) { return null; } })(),
        goSearch: document.querySelectorAll('div.go_search, div.go_search_submit').length,
        area_mode: _axExpect ? _axExpect.areaMode : null,
        extra: extra || null,
      };
      chrome.storage.local.set({ axlx_search_why: o });
      console.log('[AX] 検索の判断:', why, o);
    } catch (_) {}
  }
  /**
   * 2026-11-14 竹内さん「検索まで押せるか」:
   *   地域・駅のモーダル（小窓）が開いているか。開いている間は「保険の検索」を押さない
   *   （モーダルの中で検索を押すと条件が中途半端になる）。
   */
  function _axModalOpen() {
    try {
      var d = document.querySelector('.this_window, [role="dialog"], .modal, #modal, .modal_wrap');
      if (!d) return false;
      return isVisible(d);
    } catch (_) { return false; }
  }

  function clickSearch() {
    /**
     * 2026-11-14: **検索を押した時刻**を残す（保険の判定に使う・二重押しを防ぐ）。
     */
    try { window._axSearchPressedAt = Date.now(); } catch (_) {}
    if (_guideOn()) {
      // 案内モード（data-axlx-guide が "0" 以外）＝拡張は押さない。
      //   ⚠ 自動モードなのにここに来るなら、realpro-guide.js が "0" を書けていない（＝原因が分かる）
      var _g = null;
      try { _g = document.documentElement.getAttribute("data-axlx-guide"); } catch (_) {}
      _noteSearchWhy('guide_on: data-axlx-guide=' + String(_g), { guideAttr: _g });
      console.warn("[AX] 案内モードのため検索を押さない（スタッフが押す） data-axlx-guide=" + String(_g));
      notifyDone("guide-mode: 検索はスタッフが押す"); return;
    }
    // クリックキュー消化中は検索しない（条件クリックが全て反映される前の検索送信を防止）
    if (isClickQueueBusy()) {
      if (_audit && !_audit._searchWaitMarked) { _audit._searchWaitMarked = true; _auditStepP('search_wait', 'queue=' + _clickQueue.length); }
      setTimeout(clickSearch, _pd(200)); return;
    }
    // v2.5.50 検索を押す前の関所。2026-11-10 v2.6.18: 間取りだけでなく**家賃・更新日・築年・徒歩・場所**も画面で確かめる。
    //   ・間取りが0個 → 1回だけ入れ直す（今まで通り）
    //   ・家賃・更新日・場所などが画面と違う → **入れ直してから**もう一度確かめる（1回だけ）→ それでも違えば止める
    //   止めた時は fill-done に gate:true を付ける（content.js が error として中継＝background はこのお客様のリアプロを理由付きで飛ばす）
    var _gate = _axGateCheck();
    if (_gate.errors.length) {
      if (!_axGateRetried) {
        _axGateRetried = true;
        _auditStepP('gate_retry', _gate.errors.join(' / ').slice(0, 200));
        // 画面を見て、入れるはずの値になっていない物を入れ直す（間取り・家賃・更新日・築年・徒歩）
        try {
          if (_gate.missingLayout && _axExpect.layoutVals.length) setCheckboxes("room_layout_id[]", _axExpect.layoutVals);
          if (_axExpect.rentMax != null) setSelVal("rental_cost2", _axExpect.rentMax);
          if (_axExpect.rentMin != null) setSelVal("rental_cost1", _axExpect.rentMin);
          if (_axExpect.updateDays != null) setSelVal("update_date", _axExpect.updateDays);
          if (_axExpect.age != null) setSelVal("structured_date", _axExpect.age);
          if (_axExpect.walk != null) {
            /**
             * 2026-11-14 竹内さん「駅からの移動手段のところ 徒歩をプルダウンで選択するところできていなかった」:
             *   ⚠ 旧は**分数（required_time）だけ**を入れ直していた。
             *     移動手段（transportation_id）が「徒歩」でなくても直さなかった。
             *   → 移動手段が「徒歩」でなければ**そこも入れ直す**。
             */
            try {
              if (_gate.missingTransport) {
                var _tr = document.querySelector('select[name="transportation_id"]');
                if (_tr) {
                  var _ti = -1;
                  for (var _tq = 0; _tq < _tr.options.length; _tq++) {
                    if (String(_tr.options[_tq].textContent || "").replace(/\s+/g, "").indexOf("徒歩") >= 0) { _ti = _tq; break; }
                  }
                  if (_ti >= 0) { _tr.selectedIndex = _ti; _tr.dispatchEvent(new Event("change", { bubbles: true })); }
                }
              }
            } catch (_) {}
            var _wk = document.querySelector('input[name="required_time"]');
            if (_wk && String(_wk.value) !== String(_axExpect.walk)) typeTextLikeHuman(_wk, _axExpect.walk);
          }
        } catch (_) {}
        setTimeout(clickSearch, _pd(900)); return;
      }
      var gateMiss = _gate.errors.join(' / ').slice(0, 240);
      /**
       * 2026-11-11 竹内さん「自動検索も検索ボタン押す前にとまってしまった。ちゃんと検索おすように」:
       *   ⚠ 旧は1回入れ直して**それでも違えば検索せずに止めていた**。
       *     だが実際は「値は入っているのに比べ方が違う」事が多く（例: 家賃の丸め）、
       *     **検索が行われないまま止まる**＝物件が出ない、という一番困る結果になっていた。
       *   → **場所だけは止める**（全件検索になるとお客様に無関係な物件が飛ぶ）。
       *     それ以外（家賃・更新日・築年・徒歩・間取り）は**警告を残して検索する**。
       */
      var _areaErr = _gate.errors.some(function (m) { return String(m).indexOf('場所') === 0; });
      if (_areaErr) {
        _auditStepP('gate_stop_area', gateMiss);
        if (_audit) _audit.form = _readRealproForm();
        console.warn('[AX] 場所が入っていないので検索しない（全件検索を防ぐ）: ' + gateMiss);
        notifyDone('AXLX_FILL_INCOMPLETE: ' + gateMiss, true);
        return;
      }
      _auditStepP('gate_warn', gateMiss);
      if (_audit) { _audit.form = _readRealproForm(); _audit.gate_warn = gateMiss; }
      try { showWarnToast('条件が画面と違うまま検索します: ' + gateMiss.slice(0, 80)); } catch (_) {}
      console.warn('[AX] 検索を押す前の確認で違う所があった（止めずに検索する）: ' + gateMiss);
      // ← 止めずに下へ進む（検索を押す）
    }
    if (_audit) { delete _audit._searchWaitMarked; }
    // 2026-11-10 v2.5.98 竹内さん「細かい部分も実際の人間がするように」:
    //   条件を入れ終わってから検索を押すまでに「上がって全体を見直す」間を置く（1〜3秒・対数正規）。
    //   押した瞬間に検索されると人が確認していないように見える。1回だけ待つ（待った後の再入場は待たない）
    /**
     * 2026-11-14 竹内さん「なぜか今勝手に入力だけされていてボタンは押していない。検索も押してない」:
     *   ⚠ DB の点検で **`page:search_look` が19回続いた**（＝見直す間に入るたびに先頭へ戻っていた）。
     *     原因: `_axSearchLookedOver` は `setTimeout` の中で false に戻す作りだが、
     *     **タイマーが発火する前に別の経路から `clickSearch` が呼ばれる**と、
     *     フラグが true のままで「見直す」に入り直し、**検索に到達しない**（180秒後に
     *     `stall_recover_search` でやっと押す＝遅すぎる）。
     *   → **予約済みなら二重に予約しない**（`_axSearchLookTimer` を持つ）。
     *     さらに「見直す」で待つのは**1回だけ**（`_axSearchLookCount` で数え、2回目以降は待たずに押す）。
     *
     * 2026-11-14 竹内さん「検索ボタンもおしていなかった」→ 実測で **14回**続いていた:
     *   ⚠ 上の直しだけでは足りなかった。タイマー発火時に `_axSearchLookAt = 0` に戻していたので、
     *     **次の `clickSearch` でまた「見直す」に入り直す**（`_axSearchLookedOver=false` も戻すため）。
     *     ＝**待つ → 押す**の筈が **待つ → 待つ → 待つ…** の無限ループになり、検索に一度も到達しない。
     *   → **見直すのは「この回で1回だけ」**にする:
     *     ・`_axSearchLookDone` を立てたら、もう「見直す」には入らない（タイマー発火後も戻さない）
     *     ・リセットは**検索を押した後**か**次の検索の開始時**（`fillRealpro` の頭）だけ
     */
    var _nowMs = Date.now();
    var _lookAt = Number(window._axSearchLookAt) || 0;
    if (_nowMs - _lookAt < 6000) {
      // 直前に「見直す」を予約した → **二重に予約しない**（タイマーが押す）
      if (_audit) _auditStepP('search_look_skip', '予約済み');
      return;
    }
    /**
     * ⚠ この回で既に「見直す」を済ませている → **待たずに押す**（無限ループ防止）。
     *   旧は毎回 false に戻していたので 14回続いた（本番の点検記録で確認）。
     */
    if (window._axSearchLookDone) {
      if (_audit) _auditStepP('search_look_done', '見直し済み→押す');
      window._axSearchLookedOver = false;
    } else if (!window._axSearchLookedOver) {
      window._axSearchLookedOver = true;
      window._axSearchLookAt = _nowMs;
      var _lookMs = humanRand(1000, 2200);
      // 2026-11-11 竹内さん「一息もランダムにはいる」: 見直す間に、10%で一息 900〜2600ms・3%で2.6〜5.5秒を足す
      if (Math.random() < 0.10) _lookMs += 900 + Math.floor(Math.random() * 1700);
      else if (Math.random() < 0.03) _lookMs += 2600 + Math.floor(Math.random() * 2900);
      _auditStepP('search_look', Math.round(_lookMs) + 'ms');
      /**
       * ⚠ タイマーは**1本だけ**。発火したら**この回の見直しは済み**にして、そのまま検索へ進む。
       *   `_axSearchLookDone` を立てるので、次に `clickSearch` が来ても**待たずに押す**。
       */
      try { if (window._axSearchLookTimer) clearTimeout(window._axSearchLookTimer); } catch (_) {}
      window._axSearchLookTimer = setTimeout(function () {
        try {
          window._axSearchLookDone = true;      // ← この回はもう待たない（無限ループ防止）
          window._axSearchLookedOver = false;
          window._axSearchLookAt = 0;
          clickSearch();
        } catch (_) {}
      }, _lookMs);
      return;
    }
    window._axSearchLookedOver = false;
    _auditStepP('search', null);
    /**
     * 2026-11-11 竹内さん「検索のボタンはこのように2か所ある。その点をちゃんと理解すればより質上がる」:
     *   リアプロの「検索」は**2か所**にある。
     *     ① **左のサイドバー**（条件を入れた後に押す・メインの検索）  ← これを押すのが正しい
     *     ② **小窓（市区郡・沿線の設定）の中の下**（モーダルの中の「検索」） ← ここを押すと条件が中途半端
     *
     *   旧: `div.go_search` を**最初に見つかった1つ**だけ押していた（どちらか分からない）。
     *   新: **2つを取り違えない**ように、
     *     ・小窓（.this_window）の中にあるボタンは**候補から外す**（モーダルの中の検索は押さない）
     *     ・左のサイドバー側（`.one_slide_search_box`・`#search_area`・画面の左半分）を優先する
     *     ・どちらを押したかを点検に残す（`which`: sidebar／modal／unknown）
     */
    var goDivs = Array.prototype.slice.call(
      document.querySelectorAll('div.go_search, div.go_search_submit')
    );
    // 小窓の中のボタンか（＝モーダル内の検索）を見分ける
    var _inModal = function (el) {
      try {
        return !!(el.closest && el.closest('.this_window, [role="dialog"], .modal, #modal, .modal_wrap'));
      } catch (_) { return false; }
    };
    // 左のサイドバー側かどうか（人が条件を入れている所）
    var _isSidebar = function (el) {
      try {
        if (el.closest && el.closest('.one_slide_search_box, #search_area, .search_box, #left, .left_area, .side')) return true;
        var r = el.getBoundingClientRect();
        var vw = window.innerWidth || 1200;
        return r.left < vw * 0.45; // 画面の左半分にあればサイドバー扱い
      } catch (_) { return false; }
    };
    var _visible = function (el) { try { return !!(el.offsetParent || (el.getClientRects && el.getClientRects().length)); } catch (_) { return false; } };
    // ① 小窓の中は外す → ② 見えている物だけ → ③ 左のサイドバーを優先
    var _modalBtns = goDivs.filter(function (d) { return _inModal(d); });
    var _outside = goDivs.filter(function (d) { return !_inModal(d) && _visible(d); });
    var _sidebar = _outside.filter(_isSidebar);
    var goOrder = _sidebar.length ? _sidebar.concat(_outside.filter(function (d) { return _sidebar.indexOf(d) < 0; })) : _outside;
    if (_audit) {
      _audit.search_buttons = {
        total: goDivs.length,
        in_modal: _modalBtns.length,
        sidebar: _sidebar.length,
        outside: _outside.length,
        sample: goDivs.slice(0, 6).map(function (d) {
          var r = null; try { r = d.getBoundingClientRect(); } catch (_) {}
          return {
            cls: String(d.className || "").slice(0, 40),
            txt: String(d.textContent || "").replace(/\s+/g, "").slice(0, 12),
            modal: _inModal(d),
            left: r ? Math.round(r.left) : null,
            top: r ? Math.round(r.top) : null,
            visible: _visible(d),
          };
        }),
      };
    }
    // 検索の点検: 押す直前のフォームを読み戻す（入れようとした条件と比べる材料）
    if (_audit) _audit.form = _readRealproForm();
    /**
     * 2026-11-11 竹内さん「地域や駅の検索の際も、押した後検索ボタンにマウス移動させて押していなかった」:
     *   旧は見つけたボタンを **その場で .click()**（カーソルは別の所に居た）。
     *   新は **検索ボタンまでカーソルを動かしてから押す**。
     *     ・押す前に画面を検索ボタンの所へ送る（下の方にあって見えていない事がある）
     *     ・押したあと「反応を見る間」（_afterClickGapMs・decide は 1.2〜3.2秒）は待たずに notifyDone を返す
     *       （待つと fill-done が遅れて background の見張りに引っかかる。押した事実はすぐ返す）
     */
    var _pressSearchBtn = function (btn) {
      if (!btn) return false;
      _scrollIntoViewSoft(btn);
      /**
       * 2026-11-11 竹内さん「ちゃんと画面確認しながら動くことができていなかった」:
       *   押した「場所」と「時刻」を点検に残す（実画面で「本当にそのボタンを押したか」を後から確かめられる）。
       *   ・at      … 押すボタンの文字（先頭20字）
       *   ・rect    … 押すボタンの画面の位置（見えていたか）
       *   ・pointer … 押した時にカーソルが居た所（ボタンの上かどうか）
       */
      if (_audit) {
        _audit.search_clicked = true;
        try {
          var _rr = btn.getBoundingClientRect();
          _audit.search_press = {
            at: String((btn.textContent || btn.value || '').replace(/\s+/g, '')).slice(0, 20),
            rect: { t: Math.round(_rr.top), l: Math.round(_rr.left), w: Math.round(_rr.width), h: Math.round(_rr.height) },
            in_view: (_rr.top >= 0 && _rr.bottom <= (window.innerHeight || 800)),
            t: Date.now() - (_fillStartedAt || Date.now()),
            // 2026-11-11: 2か所ある検索ボタンのどちらを押したか（左のサイドバー側か・小窓の中か）
            which: _inModal(btn) ? "modal" : (_isSidebar(btn) ? "sidebar" : "unknown"),
            cls: String(btn.className || "").slice(0, 40),
          };
        } catch (_) {}
      }
      /**
       * 2026-11-14 竹内さん「この地域押すところや、検索押すところちゃんと学習する」:
       *   検索ボタンも**学んだ押す位置**（`左の検索｜span` など）へカーソルを動かして押す。
       *   ⚠ 2か所ある検索ボタン（左のサイドバー／小窓の中）を取り違えないよう、
       *     小窓の中のボタンには**学んだ位置を使わない**（位置が違うため）。
       */
      var _sAim = null;
      try {
        if (!_inModal(btn)) _sAim = _aimByEl(btn, ['左の検索', '検索', '住居検索', 'go_search']);
      } catch (_) { _sAim = null; }
      if (_audit) {
        try { _auditStepP('learn_aim', 'search:' + (_sAim ? (_sAim.key + ' 横' + Math.round(_sAim.x * 100) + '% 縦' + Math.round(_sAim.y * 100) + '%') : '学び無し→今まで通り')); } catch (_) {}
      }
      _humanPointerClick(btn, function () { try { btn.click(); } catch (_) {} }, _sAim);
      // 押し終わってから（カーソルが着いて押した後）カーソルの居た所を残す
      setTimeout(function () {
        try {
          if (!_audit || !_audit.search_press) return;
          var P = window.AxlxPointerUi;
          var ps = P && P.visiblePosition ? P.visiblePosition() : null;
          if (ps) _audit.search_press.pointer = { x: Math.round(ps.x), y: Math.round(ps.y) };
        } catch (_) {}
      }, 500);
      notifyDone();
      return true;
    };
    // 「検索」ボタンは2か所ある（左のサイドバー／小窓の中）。**左のサイドバーを優先**する
    for (var i = 0; i < goOrder.length; i++) {
      _pressSearchBtn(goOrder[i]); return;
    }
    // フォールバック: button/a テキスト一致（小窓の中の「検索」は押さない）
    var SEARCH_TEXTS = ['住居検索', '検索', '物件を検索する', '条件で検索'];
    var allBtns = Array.prototype.slice.call(
      document.querySelectorAll('button,input[type="submit"],a,input[type="button"]')
    );
    var _fbOutside = allBtns.filter(function (b) { return !_inModal(b); });
    var _fbSide = _fbOutside.filter(_isSidebar);
    var _fbOrder = _fbSide.concat(_fbOutside.filter(function (b) { return _fbSide.indexOf(b) < 0; }));
    for (var si = 0; si < SEARCH_TEXTS.length; si++) {
      for (var i = 0; i < _fbOrder.length; i++) {
        var b = _fbOrder[i];
        if (!b.offsetParent) continue;
        var txt = (b.textContent || b.value || '').replace(/\s+/g, '');
        if (txt === SEARCH_TEXTS[si]) { _pressSearchBtn(b); return; }
      }
    }
    /**
     * 2026-11-11 竹内さん「まだ検索もおせていない。ちゃんと通常モードのアナウンスのところ参考に改善していく」:
     *   上の2つで見つからない時、**案内モードと同じ探し方（文字のノードから上へたどる）**でも探す。
     *   リアプロの検索ボタンは `div.go_search` の事が多いが、画面の作りが変わると
     *   「検索」の文字が**中の span に分かれている**ことがあり、要素の全体文字を比べる旧の探し方では取れない。
     */
    var _byTextBtn = _findByText(['住居検索', '検索', '物件を検索する', '条件で検索']);
    if (_byTextBtn && !_inModal(_byTextBtn)) {
      console.log('[AX] 検索ボタンを文字から見つけました（案内モードと同じ探し方）');
      _pressSearchBtn(_byTextBtn); return;
    }
    // 小窓の中しか無い場合でも、最後の手段として押す（全件検索より「検索しない」方が困るため）
    if (_byTextBtn) {
      console.warn('[AX] 検索ボタンが小窓の中にしかありません（押します）');
      _pressSearchBtn(_byTextBtn); return;
    }
    if (_audit) { _audit.search_clicked = false; _audit.click_fails.push({ what: 'search', text: '検索', sample: _visibleTexts('button,input[type="submit"],a', 8) }); }
    notifyDone('clickSearch: 検索ボタンが見つかりません（フォーム折りたたみ/モーダル遮蔽の可能性）');
  }

  // 路線ボタンをクリック（リアプロモーダル: LABEL.one_line 構造確認済み）
  function clickLineButtons(routeIds) {
    if (!routeIds || !routeIds.length) return;
    // label.one_line を優先（診断で確認した実DOM構造）
    var labels = Array.prototype.slice.call(document.querySelectorAll('label.one_line'));
    routeIds.forEach(function(id) {
      var lineName = ROUTE_LINE_MAP[id];
      if (!lineName) return;
      var lineNorm = norm(lineName);
      var found = false;
      // PASS1: label.one_line 完全一致（クリックはキュー経由で 90〜200ms 間隔の順次実行）
      for (var i = 0; i < labels.length && !found; i++) {
        if (!isVisible(labels[i])) continue;
        var lNorm = norm(labels[i].textContent);
        if (lNorm === lineNorm) {
          var cb = labels[i].querySelector('input[type="checkbox"]');
          if (cb) { if (!cb.checked) enqueueHumanClick(cb, _clickEl, 450, 1000); }
          else { enqueueHumanClick(labels[i], _clickEl, 450, 1000); }
          found = true;
        }
      }
      // PASS2: 短縮名サフィックス一致（"御堂筋線" → "大阪市高速軌道御堂筋線"）
      for (var i = 0; i < labels.length && !found; i++) {
        if (!isVisible(labels[i])) continue;
        var lNorm = norm(labels[i].textContent);
        if (lNorm.length >= 4 && lineNorm.endsWith(lNorm)) {
          var cb = labels[i].querySelector('input[type="checkbox"]');
          if (cb) { if (!cb.checked) enqueueHumanClick(cb, _clickEl, 450, 1000); }
          else { enqueueHumanClick(labels[i], _clickEl, 450, 1000); }
          found = true;
        }
      }
      // 検索の点検: 選べなかった路線（ラベルの数と見本）
      if (found && _audit) _audit.lines_missing = _audit.lines_missing.filter(function (m) { return m.name !== lineName; });
      if (!found && _audit && !_audit.lines_missing.some(function (m) { return m.name === lineName; })) _audit.lines_missing.push({ name: lineName, label_count: labels.length, sample: labels.slice(0, 6).map(function (l) { return (l.textContent || '').replace(/\s+/g, '').slice(0, 20); }) });
    });
  }

  // 2026-09-29 v2.5.39 通勤の到達時間で選んだ多数の駅（cond.commute・60駅超）は 25〜60ms で押す（電車1本の全駅選択と同じ考え・90秒の fill-done に収める）
  // 2026-11-10 v2.5.96 竹内さん「駅も一気に選択してしまう部分がのこっている」「上下の時間もはやすぎる」:
  //   25〜60ms は人が駅を1つずつ押す速さではない（一瞬で全部にチェックが付く）。駅は**320〜900ms**にする。
  //   駅が多い時は 90秒の fill-done を超えうるので、待ちの上限はサーバー側のタイムアウトではなく
  //   ここで「ランダムに一息」を入れつつ、_whenTickIdle で検索前に全部済むのを待つ形で担保する。
  // 2026-11-10 v2.5.97 竹内さん「20駅ごとにというかランダムに人間のように」:
  //   等間隔の一息をやめ、**押すたびに 10% の確率**で 900〜2600ms・**3%** で 2.6〜5.5秒の間を足す
  var _stGapFast = false;
  function _stGapMin() { return 420; }
  function _stGapMax() { return 1100 + _stationBreath(); }
  /** 駅を1つ押した後に足す「人の一息」（何駅目かは決めない・毎回ちがう） */
  function _stationBreath() {
    var add = 0;
    if (Math.random() < 0.10) add += 900 + Math.floor(Math.random() * 1700);
    if (Math.random() < 0.03) add += 2600 + Math.floor(Math.random() * 2900);
    return add;
  }
  // 駅名でボタン/チェックボックスをクリック
  function selectStationsByName(names) {
    if (!names || !names.length) return;
    /**
     * 2026-11-11 竹内さん「地域や駅の部分最初だけ間隔かかるなど。人間ならどこに間隔あいてどこはすぐに決めれるか。そのバランスもちゃんと考える」:
     *   人が駅を選ぶ時、**最初の1つは一覧を目で探すので時間がかかる**（1.2〜3.4秒）。
     *   2つ目以降は位置が分かっているので速い（0.4〜1.1秒＋たまに一息）。
     *   さらに「似た名前の駅を探し直す」時（前の駅と文字が似ていない）は少し長く見る。
     */
    var _isFirstStation = !_stationPickSeen;
    _stationPickSeen = true;
    if (_isFirstStation) {
      var H0 = window.AxlxHumanWait;
      var look = H0 && H0.logNormalDelay ? H0.logNormalDelay(1900, 0.35) : 1900;
      if (look < 1200) look = 1200; if (look > 3400) look = 3400;
      console.log("[AX] 駅の一覧を最初に目で探す間 " + Math.round(look) + "ms");
      _auditStepP("station_first_look", Math.round(look) + "ms");
      setTimeout(function () { _selectStationsByNameCore(names); }, look);
      return;
    }
    _selectStationsByNameCore(names);
  }
  function _selectStationsByNameCore(names) {
    names.forEach(function(name) {
      var clean = name.replace(/駅$/, '').trim();
      if (!clean) return;
      var found = false;
      // 検索の点検: 選べた駅（ポーリングで何度も呼ばれるので重ねない）
      var _okMark = function () {
        if (!_audit) return;
        if (_audit.stations_ok.indexOf(clean) < 0) _audit.stations_ok.push(clean);
        // 前の回（一覧の描画前）に「押せなかった」とした駅が後で押せたら消す（誤った札を付けない）
        _audit.stations_missing = _audit.stations_missing.filter(function (m) { return m.name !== clean; });
      };

      // STEP1: label+checkbox（フォーム方式）- 全マッチを順次クリック（同名駅が複数路線に出現するため）
      // クリックはキュー経由（90〜200ms間隔）。checked済み・クリック予約済みも「処理済み」扱いにして
      // STEP2以降の直接テキストクリックへ誤フォールスルーしない（トグル解除事故の防止）
      var labels = Array.prototype.slice.call(document.querySelectorAll('label'));
      // ★ 修正(Bug2): 同一 station_code のinputは1つだけエンキュー（重複描画分の二重クリック防止）
      var _seenStValues = {};
      for (var i = 0; i < labels.length; i++) {
        if (!isVisible(labels[i])) continue;
        var txt = labels[i].textContent.replace(/\s+/g, '').replace(/駅$/, '');
        if (txt === clean) {
          var inp = labels[i].querySelector('input[type="checkbox"]');
          if (!inp && labels[i].htmlFor) inp = document.getElementById(labels[i].htmlFor);
          if (inp) {
            var _stKey = inp.value || '';
            if (_stKey && _seenStValues[_stKey]) { found = true; continue; }
            if (_stKey) _seenStValues[_stKey] = true;
            // ★ 修正(Bug2): _clickEl → _clickIfUnchecked（実行時checkedガード）
            if (!inp.checked) enqueueHumanClick(inp, _clickIfUnchecked, _stGapMin(), _stGapMax(), null, { strictLo: true });
            found = true;
          }
        }
      }
      if (found) { _okMark(); return; }

      var els = Array.prototype.slice.call(
        document.querySelectorAll('a,button,td,li,span,div,p')
      );

      // STEP2〜4はfireClickの前にchecked状態を確認できないままだとポーリング再実行時に
      // トグル解除される危険があるため、紐づくcheckboxが特定でき既にcheckedなら
      // 「処理済み」としてクリックをスキップする（STEP1/5と同等のガード）
      var isElChecked = function(el) {
        var inp = el.querySelector && el.querySelector('input[type="checkbox"]');
        if (!inp && el.closest) {
          var lb = el.closest('label');
          if (lb) {
            inp = lb.querySelector('input[type="checkbox"]');
            if (!inp && lb.htmlFor) inp = document.getElementById(lb.htmlFor);
          }
        }
        return !!(inp && inp.checked);
      };
      // ★ 修正(Bug2): エンキュー時だけでなくクリック実行直前にも checked を再評価する実行時ガード
      // （キュー待機中に同期inputが先にcheckedへ変わった場合のトグル解除事故を防止）
      // ★ 修正(M4): isElChecked がcheckboxを特定できない場合に false を返し続けて
      //   ポーリング再実行のたびに fireClick が走り無限トグルになるのを防ぐ。
      //   要素ごとに発火回数をマークし、2回以上はスキップする。
      var _fireClickIfUnchecked = function(el) {
        if (!isElChecked(el)) {
          if (el.__axClickCount >= 2) return;
          el.__axClickCount = (el.__axClickCount || 0) + 1;
          fireClick(el);
        }
      };

      // STEP2: 直接テキスト 完全一致 - 全マッチを順次クリック（同名駅が複数路線に出現するため）
      for (var i = 0; i < els.length; i++) {
        if (!isVisible(els[i])) continue;
        if (getDirectText(els[i]) === clean) {
          if (!isElChecked(els[i])) enqueueHumanClick(els[i], _fireClickIfUnchecked, _stGapMin(), _stGapMax());
          found = true;
        }
      }
      if (found) { _okMark(); return; }

      // STEP3: 全テキスト完全一致かつ葉ノード - 全マッチを順次クリック
      for (var i = 0; i < els.length; i++) {
        if (!isVisible(els[i])) continue;
        var ft = els[i].textContent.replace(/\s+/g, '').replace(/駅$/, '');
        if (ft === clean && els[i].children.length === 0) {
          if (!isElChecked(els[i])) enqueueHumanClick(els[i], _fireClickIfUnchecked, _stGapMin(), _stGapMax());
          found = true;
        }
      }
      if (found) { _okMark(); return; }

      // STEP4: 直接テキスト 前方一致
      for (var i = 0; i < els.length && !found; i++) {
        if (!isVisible(els[i])) continue;
        var dt = getDirectText(els[i]);
        if (dt.length >= 2 && clean.length >= 2 &&
            (dt.startsWith(clean) || clean.startsWith(dt))) {
          if (!isElChecked(els[i])) enqueueHumanClick(els[i], _fireClickIfUnchecked, _stGapMin(), _stGapMax());
          found = true;
        }
      }
      if (found) { _okMark(); return; }

      // STEP5: label 前方一致フォールバック（checked済みも処理済み扱い）
      for (var i = 0; i < labels.length && !found; i++) {
        if (!isVisible(labels[i])) continue;
        var txt = labels[i].textContent.replace(/\s+/g, '').replace(/駅$/, '');
        if ((txt.startsWith(clean) || clean.startsWith(txt)) && txt.length >= 2) {
          var inp = labels[i].querySelector('input[type="checkbox"]');
          if (!inp && labels[i].htmlFor) inp = document.getElementById(labels[i].htmlFor);
          if (inp) {
            // ★ 修正(Bug2): _clickEl → _clickIfUnchecked（実行時checkedガード）
            if (!inp.checked) enqueueHumanClick(inp, _clickIfUnchecked, _stGapMin(), _stGapMax(), null, { strictLo: true });
            found = true;
          }
        }
      }
      // STEP6: station_code[] を直接親テキストで検索
      // ラベルに checkbox が紐づかない DOM 構造（for属性なし・checkbox がlabel外等）に対応
      if (!found) {
        var stAllInputs = Array.prototype.slice.call(document.querySelectorAll('input[name="station_id[]"]'));
        for (var i = 0; i < stAllInputs.length && !found; i++) {
          var sinp = stAllInputs[i];
          var sp = sinp.parentElement;
          if (!sp) continue;
          var sptxt = sp.textContent.replace(/\s+/g, '').replace(/駅$/, '');
          if (sptxt === clean || (sptxt.length >= 2 && clean.length >= 2 &&
              (sptxt.startsWith(clean) || clean.startsWith(sptxt)))) {
            // ★ 修正(Bug2): _clickEl → _clickIfUnchecked（実行時checkedガード）
            if (!sinp.checked) enqueueHumanClick(sinp, _clickIfUnchecked, _stGapMin(), _stGapMax());
            found = true;
          }
        }
        if (!found) console.log('[AX] selectStations: 全STEP失敗（駅モーダルに存在しない可能性）: ' + clean);
      }
      // 検索の点検: 押せた駅・押せなかった駅（ラベルの数と見本）。同じ駅は1回だけ
      if (found) { _okMark(); }
      else if (_audit && !_audit.stations_missing.some(function (m) { return m.name === clean; })) {
        var _stInputs = Array.prototype.slice.call(document.querySelectorAll('input[name="station_id[]"]'));
        _audit.stations_missing.push({ name: clean, line: null, label_count: _stInputs.length,
          sample: _stInputs.slice(0, 6).map(function (x) { return x.parentElement ? (x.parentElement.textContent || '').replace(/\s+/g, '').slice(0, 16) : ''; }) });
      }
    });
  }

  // 詳細地域（町丁目レベル）のチェックボックスを選択する
  // DevTools調査済: 町字ボタンは label.one_town > input[type="checkbox"][name="town_code[]"]
  function clickDetailArea(name) {
    if (!name) return false;
    var clean = name.trim();

    // PASS0: label.one_town 直接狙い撃ち（DevTools調査済）
    // 「近いの何個か選択」: 完全一致・前方一致・双方向前方一致をまとめてクリック
    // 例: clean="喜連西" → "喜連西"(完全) + "喜連"(双方向:喜連西.startsWith(喜連)) を同時に選択
    var townLabels = Array.prototype.slice.call(document.querySelectorAll('label.one_town'));
    var pass0clicked = false;
    for (var pi = 0; pi < townLabels.length; pi++) {
      var ptxt = townLabels[pi].textContent.replace(/\s+/g, '');
      var ok = ptxt === clean ||
               ptxt.startsWith(clean) ||
               ptxt.includes(clean) ||
               (ptxt.length >= 2 && clean.startsWith(ptxt));
      if (!ok) continue;
      var pinp = townLabels[pi].querySelector('input[type="checkbox"]');
      // 複数町字は 90〜200ms 間隔の順次クリック（キュー経由）
      if (pinp && !pinp.checked) { enqueueHumanClick(pinp, _clickEl, 450, 1000); pass0clicked = true; }
      else if (pinp && pinp.checked) { pass0clicked = true; } // checked済みも成功（再クリック禁止）
      else if (!pinp) { enqueueHumanClick(townLabels[pi], _clickEl, 450, 1000); pass0clicked = true; }
    }
    if (pass0clicked) return true;

    function tryLabel(matchFn) {
      var labels = Array.prototype.slice.call(document.querySelectorAll('label'));
      for (var i = 0; i < labels.length; i++) {
        if (!isVisible(labels[i])) continue;
        var txt = labels[i].textContent.replace(/\s+/g, '');
        if (matchFn(txt)) {
          var inp = labels[i].querySelector('input[type="checkbox"]');
          if (!inp && labels[i].htmlFor) inp = document.getElementById(labels[i].htmlFor);
          if (inp) {
            if (!inp.checked) inp.click();
            return true;
          }
          // inp が null の場合のみラベルクリック
          labels[i].click(); return true;
        }
      }
      return false;
    }
    function tryEl(matchFn) {
      var els = Array.prototype.slice.call(document.querySelectorAll('a,div,span,td,li,button,p'));
      for (var i = 0; i < els.length; i++) {
        if (!isVisible(els[i])) continue;
        var txt = els[i].textContent.replace(/\s+/g, '');
        if (matchFn(txt)) { els[i].click(); return true; }
      }
      return false;
    }

    // PASS1: 完全一致
    if (tryLabel(function(t){ return t === clean; })) return true;
    if (tryEl(function(t){ return t === clean; })) return true;
    // PASS2: 前方一致（「喜連西1丁目〜5丁目」等）
    if (tryLabel(function(t){ return t.startsWith(clean); })) return true;
    if (tryEl(function(t){ return t.startsWith(clean); })) return true;
    // PASS3: 部分一致（要素テキストに地名が含まれる）
    if (tryLabel(function(t){ return t.includes(clean); })) return true;
    if (tryEl(function(t){ return t.includes(clean); })) return true;
    // PASS4: 逆部分一致（地名が要素テキストを含む — 短いラベル向け）
    if (clean.length >= 2) {
      if (tryLabel(function(t){ return t.length >= 2 && clean.includes(t); })) return true;
      if (tryEl(function(t){ return t.length >= 2 && clean.includes(t); })) return true;
    }
    // PASS5: 強制クリック（isVisible()が position:fixed モーダル内で誤判定する場合のフォールバック）
    function tryForce(matchFn) {
      var all = Array.prototype.slice.call(document.querySelectorAll('label,a,div,span,td,li,button,p'));
      for (var i = 0; i < all.length; i++) {
        var txt = all[i].textContent.replace(/\s+/g, '');
        if (!matchFn(txt)) continue;
        if (all[i].tagName === 'LABEL') {
          var inp = all[i].querySelector('input[type="checkbox"]');
          if (!inp && all[i].htmlFor) inp = document.getElementById(all[i].htmlFor);
          if (inp && !inp.checked) { inp.click(); return true; }
        }
        try { all[i].click(); return true; } catch(e) {}
      }
      return false;
    }
    if (tryForce(function(t){ return t === clean; })) return true;
    if (tryForce(function(t){ return t.startsWith(clean); })) return true;
    if (tryForce(function(t){ return t.includes(clean); })) return true;
    if (clean.length >= 2) {
      if (tryForce(function(t){ return t.length >= 2 && clean.includes(t); })) return true;
    }
    return false;
  }

  /**
   * 2026-11-10 v2.6.15 竹内さん「ここの画面で検索はできない。リアプロBBと左上に書いている部分の下の住居ボタンから物件検索にうつる」:
   *   リアプロは main.php を開いても**ホーム（お知らせ・トピックスの画面）**のことがあり、そこには検索の欄が無い。
   *   検索の画面（method=estate&display=building）へは、左上の「住居」ボタンから移る。
   *   ・検索の欄（rental_cost2 か city_code[]）が無ければ「住居」を押して検索の画面へ移る
   *   ・移ったら（URL か欄の出現で確かめる）入力を続ける。移れなければ fill-done(error) で止める（全件検索しない）
   *   ・押すのは人の形（カーソルが動いてから押す）。読み込み直しはしない（サイトに余計な負担をかけない）
   */
  function ensureRealproSearchPage(cond, done) {
    var hasForm = function () {
      // 2026-11-10 v2.6.16: 検索の画面かどうかの判定。
      //   確実な印: 家賃の欄（rental_cost2）・エリアの欄（city_code[]）・検索のボタン（go_search）
      //   補助の印: 「所在地絞り込み」「沿線・駅絞り込み」の文字（ホームには出ない）
      //   → **確実な印1つ**、または補助の印2つで「検索の画面」とみなす
      var sure = 0, aux = 0;
      try {
        if (document.querySelector('select[name="rental_cost2"]')) sure += 1;
        if (document.querySelector('input[name="city_code[]"]')) sure += 1;
        if (document.querySelector('div.go_search, div.go_search_submit')) sure += 1;
        if (document.querySelector('select[name="update_date"]')) sure += 1;
        var txt = document.body ? String(document.body.textContent || '') : '';
        if (txt.indexOf('所在地絞り込み') >= 0) aux += 1;
        if (txt.indexOf('沿線・駅絞り込み') >= 0) aux += 1;
        if (txt.indexOf('管理会社絞り込み') >= 0) aux += 1;
      } catch (_) {}
      return sure >= 1 || aux >= 2;
    };
    if (hasForm()) { done(true); return; }
    /**
     * 2026-11-10 v2.6.16 竹内さん（画像で指定）「この住居の住居検索ボタンから2枚目の物件一覧にうつる」:
     *   左の細い縦のメニュー（トップページ・住居検索・店舗・事務所…）の**2番目「住居検索」**。
     *   文字は「住居検索」または「住居」。アイコンだけの時もあるので、次の順で探す:
     *     ① 文字が「住居検索」に一致（一番内側）
     *     ② 文字が「住居」に一致
     *     ③ 左端（x が小さい）の「住居」を含むリンク
     *   押すのは人の形（カーソルが動いてから押す）。
     */
    var findHomeBtn = function () {
      var all = Array.prototype.slice.call(document.querySelectorAll('a,div,span,button,li,td'));
      var vis = all.filter(function (e) { try { return isVisible(e); } catch (_) { return false; } });
      var inner = function (e) {
        return !Array.prototype.some.call(e.children || [], function (c) {
          return norm(c.textContent || '') === norm(e.textContent || '');
        });
      };
      var exact = function (want) {
        return vis.filter(function (e) { return norm(e.textContent || '') === want && inner(e); })[0] || null;
      };
      var b = exact('住居検索') || exact('住居') || exact('住居（賃貸）') || exact('賃貸');
      if (b) return b;
      // ③ 左端のメニュー（x が 220px より左）で「住居」を含む物
      var left = vis.filter(function (e) {
        try {
          var r = e.getBoundingClientRect();
          if (!r || r.left > 220 || r.width > 160) return false;
          var t = norm(e.textContent || '');
          return t.indexOf('住居') === 0 && t.length <= 6;
        } catch (_) { return false; }
      });
      return left[0] || null;
    };
    var tries = 0;
    // 2026-11-10 v2.6.16: メニューの文字は「a」でなく「div/li/span」のこともある。押せる親をたどって押す
    var clickable = function (el) {
      var e = el;
      for (var i = 0; e && i < 5; i++, e = e.parentElement) {
        var tag = String(e.tagName || '').toUpperCase();
        if (tag === 'A' || tag === 'BUTTON' || e.onclick || (e.getAttribute && e.getAttribute('role') === 'button')) return e;
        // リンクの入れ物（li の onclick など）も拾う
        if (tag === 'LI' && e.querySelector && e.querySelector('a')) return e.querySelector('a');
      }
      return el;
    };
    var poll = function () {
      if (hasForm()) { done(true); return; }
      if (tries >= 40) {
        console.warn('[AX] 検索の画面へ移れない（住居ボタンが見つからない・押しても移らない）');
        _auditStepP('no_search_form', '住居ボタンで検索の画面へ移れず');
        done(false);
        return;
      }
      tries++;
      var btn = findHomeBtn();
      if (btn && !window.__axHomeBtnClicked) {
        window.__axHomeBtnClicked = true;
        var target = clickable(btn);
        console.log('[AX] ホームの画面 → 左メニューの「住居検索」を押して物件検索へ移る');
        _auditStepP('go_estate', (String(btn.textContent || '').replace(/\s+/g, '') || '(文字なし)').slice(0, 20) + ' / ' + String(target.tagName || '').toLowerCase());
        // 人の形（カーソルが動いてから押す）
        try {
          var P = window.AxlxPointerUi;
          var fire = function () {
            // 押す手段を順に試す（リンクなら href 移動も）
            try { target.click(); } catch (_) {}
            if (target !== btn) { try { btn.click(); } catch (_) {} }
            // それでも移らなければ href を直接開く（同じタブ）
            setTimeout(function () {
              try {
                if (hasForm()) return;
                var href = (target.getAttribute && target.getAttribute('href')) || (btn.closest && btn.closest('a') && btn.closest('a').getAttribute('href'));
                if (href && href !== '#' && href.indexOf('javascript') !== 0) {
                  console.log('[AX] 住居検索へ href で移る: ' + String(href).slice(0, 80));
                  location.href = href;
                }
              } catch (_) {}
            }, 2500);
          };
          if (P && P.moveToEl) { P.ensure(); P.moveToEl(target).then(function () { if (P.tap) P.tap(); fire(); }, fire); }
          else fire();
        } catch (_) { try { btn.click(); } catch (__) {} }
      }
      setTimeout(poll, _pd(500));
    };
    poll();
  }

  function fillRealpro(cond) {
    _stGapFast = !!(cond && cond.commute && cond.station_names && cond.station_names.length > 60);
    /**
     * 2026-11-14 竹内さん「検索ボタンもおしていなかった」:
     *   「見直す間」の印（`_axSearchLookDone`）は**検索1回につき1回**だけにする。
     *   → 新しい検索の開始（ここ）で必ず戻す。戻さないと2回目以降は見直しをせず、
     *     戻し忘れると逆に**永久に検索しない**（本番で14回ループした）。
     */
    try {
      window._axSearchLookedOver = false;
      window._axSearchLookDone = false;
      window._axSearchLookAt = 0;
      if (window._axSearchLookTimer) { clearTimeout(window._axSearchLookTimer); window._axSearchLookTimer = null; }
    } catch (_) {}
    /**
     * 2026-11-11 竹内さん「まだ自動モード検索されない。なんで改善したはずが改善されていないのか」:
     *   推測で直すのをやめ、**入口で何が来たか**を残す（`axlx_fill_entry`）。
     */
    try {
      chrome.storage.local.set({ axlx_fill_entry: {
        at: Date.now(),
        hasCond: !!cond,
        keys: cond ? Object.keys(cond).slice(0, 30) : [],
        area_mode: cond ? (cond.area_mode || null) : null,
        city_codes: cond && cond.city_codes ? cond.city_codes.length : 0,
        station_names: cond && cond.station_names ? cond.station_names.length : 0,
        route_ids: cond && cond.route_ids ? cond.route_ids.length : 0,
        fillRunning: !!window._axFillRunning,
        guide: (function () { try { return document.documentElement.getAttribute("data-axlx-guide"); } catch (_) { return null; } })(),
        url: String(location.href).slice(0, 200),
      } });
    } catch (_) {}
    // 重複実行防止: popupパス(underbar→postMessage)とbackgroundパス(content.js→postMessage)が
    // 同時に aixlinx-fill を送ると fillRealpro が2回呼ばれてDOMレースが起きる
    /**
     * 2026-11-14: **重複の判定より先に点検を作る**。
     *   ⚠ 旧は `_auditReset` が下（3541行）にあり、重複で return すると点検が作られなかった
     *     ＝ 2回目の return の後に1回目が終わっても、点検が無いまま `finished` が送られていた。
     *   → ここで先に作る（`cond._audit_run_id` が無ければその場の番号）。
     */
    try { _auditReset(cond && cond._audit_run_id); } catch (_) {}
    if (window._axFillRunning) {
      console.warn('[AX] fillRealpro 重複呼び出しを無視 (既に実行中)');
      /**
       * 2026-11-14 竹内さん「自動モードでの検索はちゃんと改善されているのか」→ **されていなかった**。
       *
       *   ⚠ 実測: `search_audits` の 175回中 **147回（84%）が `steps:0`**（自動モードが113回）。
       *     `started` は作られるが、段が1つも残らずに `abandoned` になっていた。
       *   原因は**ここ**だった: 2回目の呼び出しが重複として return する時、
       *     `notifyDone('duplicate-call-ignored')` を呼んでいた。これが
       *     **`finished` を「段なし」で送ってしまい**、しかも `_doneNotified = true` にするので
       *     **1回目の本物の検索が終わっても段が記録されない**（＝点検が空になる）。
       *
       *   → **重複した時は「何も送らない」**（`notifyDone` を呼ばない）。
       *     本物の1回目が `finished` を送るので、段も結果も正しく残る。
       *     ⚠ `duplicate-call-ignored` は点検に残したいので、**段だけ足す**
       *       （`notifyDone` を呼ばずに、いまの点検に1行足す）。
       */
      try { if (_audit && _audit.steps) { _audit.steps.push({ at: Date.now(), k: "duplicate_ignored", d: null }); if (_audit.steps.length > 60) _audit.steps.shift(); } } catch (_) {}
      return;
    }
    window._axFillRunning = true;
    /**
     * 2026-11-14: ここから**自動で入れる**ので、入れた物を覚える（人が選んだ物と区別する）。
     *   ⚠ 覚えていないと、次にモーダルを開いた時に「前の残り」と区別できず、
     *     **人が選んだ地域まで消してしまう**（竹内さん「自動で消してしまっている」）。
     */
    try { window._axAutoPicking = true; _resetAutoPicked(); } catch (_) {}
    window._axStDiagDone = false; // 診断ログフラグをリセット（次回fill時に再診断できるようにする）
    // 2026-11-10 v2.6.16 竹内さん（画像）「この住居の住居検索ボタンから2枚目の物件一覧にうつる」:
    //   ホームの画面（左メニューの「住居検索」を押す前）なら、まず検索の画面へ移る。
    //   判定は ensureRealproSearchPage と同じ（確実な印1つ or 補助の印2つ）。
    var _isSearchPage = (function () {
      var sure = 0, aux = 0;
      try {
        if (document.querySelector('select[name="rental_cost2"]')) sure += 1;
        if (document.querySelector('input[name="city_code[]"]')) sure += 1;
        if (document.querySelector('div.go_search, div.go_search_submit')) sure += 1;
        if (document.querySelector('select[name="update_date"]')) sure += 1;
        var txt = document.body ? String(document.body.textContent || '') : '';
        if (txt.indexOf('所在地絞り込み') >= 0) aux += 1;
        if (txt.indexOf('沿線・駅絞り込み') >= 0) aux += 1;
        if (txt.indexOf('管理会社絞り込み') >= 0) aux += 1;
      } catch (_) {}
      return sure >= 1 || aux >= 2;
    })();
    if (!_isSearchPage) {
      // 「住居」を押すと**ページが移る**ので、この function の続きは走らない（ページが入れ替わる）。
      //   移った先で background がもう一度送ってくる（fill-done を返さずに待たせる）。
      ensureRealproSearchPage(cond, function (ok) {
        if (!ok) {
          window._axFillRunning = false;
          notifyDone('no_search_form: リアプロがホームの画面のままで、住居ボタンから物件検索へ移れませんでした');
        }
        // ok の時は何もしない（ページが移る。移らなかった時は下の再試行が受ける）
      });
      // ページが移らなかった場合に備えて、少し待ってからもう一度確かめる（移っていれば欄がある）
      setTimeout(function () {
        if (window._axFillRunning && document.body) {
          var hasFormNow = !!(document.querySelector('select[name="rental_cost2"]') || document.querySelector('input[name="city_code[]"]') || document.querySelector('div.go_search')) ||
                           (String(document.body.textContent || '').indexOf('所在地絞り込み') >= 0);
          if (hasFormNow) {
            console.log('[AX] 住居検索を押した後、同じページで検索の欄が出た → 入力を続ける');
            window._axFillRunning = false;
            fillRealpro(cond);
          }
        }
      }, 4000);
      return;
    }
    clearClickQueue(); // 前回実行の残留クリックキューを破棄（誤クリック防止）
    // fill-done 保証: 実行開始時にフラグをリセットし、フェイルセーフを仕掛ける
    // （background.js 側のタイムアウトより必ず先に発火させる）
    // 2026-11-10 v2.5.96: 駅を1つずつ人の速さ（420〜1100ms）で選ぶので、沿線の全駅を選ぶと 40〜110秒かかる。
    // 2026-11-10 v2.6.14 竹内さん「人間のように」で全操作が人の速度になったので、総時間の上限を15分に延ばした
    //   （background の 905秒より10秒先）。ただし**無進捗で止まった時**は下の _stallWatch が先に止める（15分待たない）。
    _doneNotified = false;
    _axExpect = null; _axGateRetried = false; // v2.5.50 検索を押す前の関所の材料（このお客様の分を下で置く）
    // 2026-11-11: 前のお客様で選んだ区・駅の覚えを消す（このお客様の分だけを見る）
    _resetPicked();
    if (_watchdogTimer) clearTimeout(_watchdogTimer);
    _watchdogTimer = setTimeout(function() {
      // 条件入力が未完了のまま clickSearch すると全件検索→LINE誤送信になるため検索しない。
      // error付きdoneでbackground.jsがスクレイプを中止するので前回結果の誤スクレイプも起きない。
      console.warn('[AX] フェイルセーフ: 895秒経過 → 検索せず fill-done(error) 送信');
      _auditStall();
      notifyDone('watchdog-timeout: 895秒以内に条件入力が完了しませんでした（全件検索防止のため中止）');
    }, 895000);
    // 2026-11-10 v2.6.15: 「住居」を押してページが移るとこの関数の続きは走らない。
    //   移った先の新しいページで fill がもう一度来た時に、前のページの見張りが残らないよう、
    //   ページを離れる時にタイマーを片付ける（見張りが二重に走って早く止まるのを防ぐ）
    try {
      if (!window.__axUnloadHooked) {
        window.__axUnloadHooked = true;
        window.addEventListener('pagehide', function () {
          if (_watchdogTimer) { clearTimeout(_watchdogTimer); _watchdogTimer = null; }
          if (window.__axStallWatch) { clearInterval(window.__axStallWatch); window.__axStallWatch = null; }
          if (window.__axFastSearchWatch) { clearInterval(window.__axFastSearchWatch); window.__axFastSearchWatch = null; }
          window._axFillRunning = false;
        });
      }
    } catch (_) {}
    // 2026-11-10 v2.6.14 竹内さん「止まった部分ちゃんと解決できるように」:
    //   **無進捗の見張り**: 操作の列が 180秒 まったく進まなければ、その時点で止まったと判断して中断する
    //   （総時間15分を待たない）。人が手を止める長い停止（8〜25秒）はこれより短いので誤発火しない。
    //   点検に「どこで止まったか」を残す。
    (function () {
      var _lastCount = -1, _sameSince = Date.now();
      /**
       * 2026-11-14 竹内さん「検索ボタンも押していなかった」:
       *   ⚠ 旧は止まってから **180秒**待ってやっと検索を押していた（実測：`search_look` が14回続いた後
       *     `duplicate-call-ignored` で終わり、検索は押されていない）。
       *   → **もっと早い保険**を入れる: 条件が入っていて・小窓が閉じていて・
       *     まだ検索を押していない状態が **25秒**続いたら、**検索を押す**（人がやったのと同じ）。
       *     ⚠ 場所が入っていなければ押さない（全件検索の防止）。
       */
      var _searchPushed = false;
      var _idleSince = Date.now();
      var _fastWatch = setInterval(function () {
        try {
          if (_doneNotified || _searchPushed) { clearInterval(_fastWatch); return; }
          if (window._axSearchPressedAt) { _searchPushed = true; clearInterval(_fastWatch); return; }
          var opsN = _audit && _audit.ops ? _audit.ops.length : 0;
          if (opsN !== window.__axFastCount) { window.__axFastCount = opsN; _idleSince = Date.now(); return; }
          var modalOpen = (function () {
            try {
              var w = document.querySelector('.this_window, [role="dialog"], .modal, .modal_wrap');
              return !!(w && (w.offsetParent !== null || (w.getClientRects && w.getClientRects().length)));
            } catch (_) { return false; }
          })();
          if (modalOpen) { _idleSince = Date.now(); return; }   // 小窓が開いている間は押さない（確定が先）
          if (Date.now() - _idleSince < 25000) return;
          var g = _axGateCheck();
          var areaMissing = g.errors.some(function (m) { return String(m).indexOf('場所') === 0; });
          if (areaMissing) {
            _auditStepP('search_guard_area_missing', '場所が入っていないので押さない: ' + g.errors.join(' / ').slice(0, 100));
            clearInterval(_fastWatch);
            return;
          }
          console.warn('[AX] 25秒 検索が押されていない → 検索を押します');
          _auditStepP('search_guard_press', '25秒押されていない → 検索を押す');
          _searchPushed = true;
          clearInterval(_fastWatch);
          try { clickSearch(); } catch (_) {}
        } catch (_) {}
      }, 2500);
      window.__axFastSearchWatch = _fastWatch;
      window.__axStallWatch = setInterval(function () {
        try {
          if (_doneNotified) { clearInterval(window.__axStallWatch); return; }
          var n = _audit && _audit.ops ? _audit.ops.length : 0;
          if (n !== _lastCount) { _lastCount = n; _sameSince = Date.now(); return; }
          if (Date.now() - _sameSince < 180000) return;
          /**
           * 2026-11-11 竹内さん「あと検索もとまらないように」:
           *   ⚠ 旧は止まったら**検索を押さずに中断**していた（＝物件が出ないまま終わる）。
           *   → 止まる直前に**条件が入っているか**を見て、入っていれば**検索を押して**から終わる。
           *     入っていなければ今まで通り止める（全件検索はしない）。
           */
          var _gateNow = _axGateCheck();
          var _areaMissing = _gateNow.errors.some(function (m) { return String(m).indexOf('場所') === 0; });
          if (!_areaMissing) {
            console.warn('[AX] 180秒 操作が進まない → 条件は入っているので**検索を押してから**終わります');
            _auditStepP('stall_recover_search', '条件あり → 検索を押す');
            try { clickSearch(); } catch (_) {}
            return;   // clickSearch が notifyDone を呼ぶ（ここでは止めない）
          }
          console.warn('[AX] 180秒 操作が進まない → 止まったと判断して中断');
          _auditStall();
          clearInterval(window.__axStallWatch);
          notifyDone('stall-timeout: 180秒 操作が進みませんでした（' + (_clickBusyItem ? _clickBusyItem.label : '待機中') + '）');
        } catch (_) {}
      }, 5000);
    })();

    // 検索の点検: popup が載せた run_id（ブレインの時だけ）。無ければ記録しない
    _auditReset(cond && cond._audit_run_id);
    _auditStepP('fill_start', cond && cond.area_mode);
    _auditStepP('vis', document.visibilityState);
    // 2026-09-27 v2.5.32 入力を始めた合図（content.js → background）。一括検索はこれが来なければタブを読み直して1回だけやり直す
    try { window.postMessage({ from: 'aixlinx-fill-started', customerId: _fillCustomerId || null, runId: _fillRunId || null }, '*'); } catch (_) {}
    _fillCondForStamp = cond || null; // 2026-11-10 検索の印（誰の一覧か）を notifyDone で書く時に使う
    if (!cond) { notifyDone(); return; }

    // 連続検索対応: モーダルを閉じる → フォームを手動クリア → 条件入力 の順で実行
    // ※ リセットボタンはページ遷移を引き起こすため使用しない（ページ遷移するとスクリプトが死ぬ）
    function _doReset(callback) {
      // Step0: 検索結果ページでフォームが折りたたまれている場合→「検索条件を表示」をクリックして展開
      // ポップアップ展開時はresizeイベントが発火して自動クリックされるが、
      // background.jsからの自動実行時はresizeが起きないためここで明示的に展開する
      var showFormDelay = 0;
      var allEls0 = [].slice.call(document.querySelectorAll("a,button,div,span,td,p"));
      var showFormBtn = null;
      for (var si0 = 0; si0 < allEls0.length; si0++) {
        var se0 = allEls0[si0];
        if (!se0.offsetParent) continue;
        var _t0 = (se0.textContent || '').trim();
        if (_t0 === '検索条件を表示' || _t0 === '▼検索条件を表示' || _t0 === '▶検索条件を表示') { showFormBtn = se0; break; }
      }
      if (showFormBtn) {
        // v2.5.96: 人が「検索条件を表示」を押して中身を目で追う間（900〜1800ms・対数正規）
        var _showWait = humanRand(900, 1500);
        try { showFormBtn.click(); showFormDelay = _showWait; console.log("[AX] 検索条件を表示 クリック → フォーム展開待機 " + _showWait + "ms"); }
        catch (e) { console.error("[AX] _doReset: 検索条件を表示クリックで例外（続行）", e); }
      }

      setTimeout(function() {

      // Step1: 開いているモーダルを先に閉じる
      var closeBtn = [].slice.call(document.querySelectorAll("a, button, div, span")).find(function(el) {
        var t = (el.textContent || "").trim();
        return (t === "× とじる" || t === "×とじる" || t === "とじる" || t === "閉じる") && el.offsetParent !== null;
      });
      var closeDelay = 0;
      if (closeBtn) {
        // ★ 修正: モーダルが開いている場合、閉じる前に路線・駅の選択をクリア
        // リアプロのモーダルはJS内部状態を持ちフォームDOM操作では消えないため
        // 閉じる前にlabel.one_line（路線）とstation_code[]（駅）をクリックして解除する
        try {
          Array.prototype.slice.call(document.querySelectorAll('label.one_line')).forEach(function(lbl) {
            if (!isVisible(lbl)) return;
            var cb = lbl.querySelector('input[type="checkbox"]');
            if (cb && cb.checked) enqueueHumanClick(cb, _clickEl, 400, 950);
          });
          Array.prototype.slice.call(document.querySelectorAll('input[name="station_id[]"]:checked'))
            .filter(function(inp) { return inp.parentElement && isVisible(inp.parentElement); })
            .forEach(function(inp) { enqueueHumanClick(inp, _clickEl, 400, 950); });
          console.log("[AX] _doReset: モーダル内の路線・駅選択をクリア（順次クリック）");
        } catch (_e) { /* ignore */ }
        // 閉じるボタンはクリア用クリックの完了後にキュー経由で実行（FIFOで順序保証）
        // click() の例外で callback 未到達（= fill-done 永久欠落）にならないよう try-catch
        enqueueHumanAction(function() {
          try { closeBtn.click(); console.log("[AX] モーダルを閉じました"); }
          catch (err) { console.error("[AX] _doReset: モーダル閉じで例外（続行）", err); }
        }, 200, 400);
        closeDelay = _ln(520, 0.4, 320, 950);
      }

      setTimeout(function() {
        // モーダル内クリア＋閉じるのキューが全て消化されてからフォームクリアへ進む
        // （queueされた解除クリックより先に checked=false を直接セットすると、
        //  後から実行される click() で再チェックされてしまうため順序が重要）
        whenClickQueueIdle(function() {
        try {
        // Step2: フォームを直接手動クリア（ページ遷移なし・確実にリセット）
        // チェックボックス系：市区郡・沿線・駅・間取り・構造・設備をすべてリセット
        // 修正: route_id[]（沿線）と station_code[]（駅）が抜けており、
        // 前顧客の沿線・駅選択が残ったまま次顧客の検索が実行されるバグがあった
        var checkboxNames = [
          "city_code[]", "town_code[]",
          "route_id[]", "station_id[]",
          "room_layout_id[]", "structured_type[]", "eq_rm[]",
        ];
        /**
         * 2026-11-11 竹内さん「物件検索した後に次のお客さんにうつるためにリセットする間隔などその点は人間的になっているか」:
         *   旧は **一瞬で全部 checked=false**（人が条件を消す速さではない・画面が一斉に変わる）。
         *   人が前のお客様の条件を消す時は、上から順に1つずつ「カチッ」と外していく（たまにまとめて外す事もある）。
         *   ・対象を集めて **上から順**（消す時は順番が大事＝住所の階層があるため）に1つずつ外す
         *   ・間は 90〜260ms（対数正規）・8%で一息 300〜800ms
         *   ・件数が多い時（20件超）は 5件ずつにまとめる（人が「だいたいこの辺」とまとめて外す形）
         *   ⚠ 同期で消せないと後段（入力）が狂うので、全部消し終わってから次へ進む
         */
        var _toUncheck = [];
        checkboxNames.forEach(function (name) {
          [].slice.call(document.querySelectorAll("input[name='" + name + "']:checked")).forEach(function (cb) { _toUncheck.push(cb); });
        });
        var _H0 = window.AxlxHumanWait;
        // 全部外し終わったら次（select・text のクリア）へ進む（非同期なので順番を守る）
        var _afterUncheck = function () { _resetRest(); };
        var _unchk = function (i) {
          if (i >= _toUncheck.length) { _afterUncheck(); return; }
          var cb = _toUncheck[i];
          try { if (cb.isConnected && cb.checked) { cb.checked = false; cb.dispatchEvent(new Event("change", { bubbles: true })); } } catch (_) {}
          var gap = _H0 && _H0.logNormalDelay ? _H0.logNormalDelay(160, 0.35) : 160;
          if (gap < 90) gap = 90; if (gap > 260) gap = 260;
          if (Math.random() < 0.08) gap += 300 + Math.floor(Math.random() * 500);
          setTimeout(function () { _unchk(i + 1); }, gap);
        };
        if (_toUncheck.length > 20) {
          // 多い時は5件ずつまとめて外す（人が「この辺をまとめて」とやる形）
          var _chunk = 0;
          var _unchunk = function () {
            if (_chunk >= _toUncheck.length) { _afterUncheck(); return; }
            _toUncheck.slice(_chunk, _chunk + 5).forEach(function (cb) {
              try { if (cb.isConnected && cb.checked) { cb.checked = false; cb.dispatchEvent(new Event("change", { bubbles: true })); } } catch (_) {}
            });
            _chunk += 5;
            setTimeout(_unchunk, 260 + Math.floor(Math.random() * 380));
          };
          _unchunk();
        } else {
          _unchk(0);
        }

      // 敷金・礼金なし チェックボックスをリセット（ラベルテキストで特定するため name リストに含められない）
      // 前顧客が敷礼なし希望 → 次顧客が希望なし のとき残留するバグの修正
      // 2026-11-11: チェックボックスを人と同じ速さで外すので、残り（敷礼・select・text）はその後に回す
      /**
       * 2026-11-14 竹内さん「なにか足りていない部分がある可能性はちゃんと全部必要な機能はいるように」:
       *   ⚠ DB の点検に **`RESET_FAILED: _resetRest is not a function`** が残っていた（実際に起きていた）。
       *     原因: `_resetRest` は `var`（関数式）で定義されていたため、
       *     先に作られる `_afterUncheck` から呼ばれた時に**まだ代入されていない**事があった
       *     （`var` は巻き上げられるが、代入はその行に来るまで行われない）。
       *   → **関数宣言に変える**（巻き上げで、どこから呼んでも使える）。
       */
      function _resetRest() {
        ;(function() {
          var sLabels = document.querySelectorAll('label');
          for (var si = 0; si < sLabels.length; si++) {
            var sTxt = (sLabels[si].textContent || '').replace(/[\s　]/g, '');
            if (sTxt === '敷金・礼金なし' || sTxt === '敷金礼金なし') {
              var sInp = sLabels[si].querySelector('input[type="checkbox"]');
              if (sInp && sInp.checked) { sInp.click(); }
              break;
            }
          }
        })();

        // セレクト系をリセット（structured_date=築年数 / square_meter=面積 も select要素）
        // update_date: 前顧客の更新日フィルターが残留すると次顧客の検索が絞られるバグの修正
        /**
         * 2026-11-11 竹内さん「一連のうごきからちゃんと一息の部分入るようになっているか。人間のように一息もランダムにはいる」:
         *   旧はセレクト・テキストのクリアも**一斉**（forEach で即）。
         *   1つずつ、90〜260ms 空けて消す（チェックボックスと同じ速さ）。8%で一息 300〜800ms。
         *   最後の1つが終わったら次へ進む。
         */
        var selectNames = ["rental_cost1", "rental_cost2", "transportation_id",
                           "structured_date", "square_meter_l", "square_meter_h",
                           "update_date"];
        var textNames = ["required_time", "keyword", "free_word", "freeword", "building_name", "search_word"];
        var _clearTargets = [];
        selectNames.forEach(function (name) {
          var el = document.querySelector("select[name='" + name + "']");
          if (el && el.selectedIndex !== 0) _clearTargets.push({ kind: "select", el: el });
        });
        textNames.forEach(function (name) {
          var el = document.querySelector("input[name='" + name + "']");
          if (el && el.value) _clearTargets.push({ kind: "text", el: el });
        });
        (function () {
          var sw = document.querySelector('input[type="search"]');
          if (sw && sw.value) _clearTargets.push({ kind: "text", el: sw });
        })();
        var _clearIdx = 0;
        var _clearNext = function () {
          if (_clearIdx >= _clearTargets.length) { _finishReset(); return; }
          var t = _clearTargets[_clearIdx++];
          try {
            if (t.kind === "select") { t.el.selectedIndex = 0; t.el.dispatchEvent(new Event("change", { bubbles: true })); }
            else { t.el.value = ""; t.el.dispatchEvent(new Event("change", { bubbles: true })); }
          } catch (_) {}
          var gap = _H0 && _H0.logNormalDelay ? _H0.logNormalDelay(160, 0.35) : 160;
          if (gap < 90) gap = 90; if (gap > 260) gap = 260;
          if (Math.random() < 0.08) gap += 300 + Math.floor(Math.random() * 500);
          setTimeout(_clearNext, gap);
        };
        var _finishReset = function () {
          console.log("[AX] フォーム手動クリア完了 → 条件入力開始");
          _auditStepP('reset', null);
          // 2026-11-10 v2.6.12 竹内さん「細部まで徹底した動き」: リセット後に「条件が消えたのを見届ける」間（人が画面を見る）
          // 2026-11-11: ここにも一息（人が「全部消えたか」を見る・10%で900〜2600ms）
          var _look = _ln(650, 0.4, 380, 1300);
          if (Math.random() < 0.10) _look += 900 + Math.floor(Math.random() * 1700);
          setTimeout(callback, _look);
        };
        _clearNext();
      } // _resetRest end（関数宣言に変えた・2026-11-14）
        } catch (err) {
          // クリア失敗でも条件入力は続行する（静かに停止すると fill-done が来なくなる）
          console.error("[AX] _doReset クリア中の例外（続行）", err);
          if (_audit) _audit.reset_fail = 'フォームのクリアで例外: ' + String((err && err.message) || err).slice(0, 120);
          setTimeout(callback, _ln(650, 0.4, 380, 1300));
        }
        }); // whenClickQueueIdle end
      }, closeDelay);

      }, showFormDelay); // Step0: 検索条件を表示 展開待機
    }

    _doReset(function() {
    /**
     * 2026-11-11 竹内さん「最初人間ならここちょっと考える時間あったりする」:
     *   空のフォームの前に座った人は、いきなり駅を押さない。**まず全体をざっと見て、どこから手を付けるか決める**。
     *   この「最初に考える間」を1回だけ待ってから入力に入る（2.0〜6.5秒・たまに長く／2人目以降は0.8〜2.4秒）。
     *   ⚠ 待っている間も fill-done は出さない（呼び出し元は「入力中」として待つ）。
     */
    (function _waitThinkThenFill(next) {
      if (!(_thinkBeforeFill > 0)) { next(); return; }
      var ms = _thinkBeforeFill;
      _thinkBeforeFill = 0;
      _auditStepP('think_first', Math.round(ms) + 'ms');
      console.log("[AX] どこから手を付けるか考える間 " + (ms / 1000).toFixed(1) + "秒 待ってから入力を始めます");
      setTimeout(next, ms);
    })(function () {

    setTimeout(function() {
    try { // fill-done 保証: 本体で例外が起きても必ず notifyDone する

    /**
     * 2026-11-11 竹内さん「検索おしてからの駅や地域選択する間隔とかも最初人間ならここちょっと考える時間あったりするので。
     *   地域や駅の部分最初だけ間隔かかるなど。人間ならどこに間隔あいてどこはすぐに決めれるか。そのバランスもちゃんと考える」:
     *   空のフォームの前に座った人は、いきなり駅を押さない。**まず全体をざっと見て、どこから手を付けるか決める**。
     *   この「最初に考える間」を1回だけ入れる（2.0〜6.5秒・中央値3.2秒・たまに長く考える）。
     *   ⚠ 2人目以降・同じお客様の2パス目は、要領が分かっているので短くする（0.8〜2.4秒）。
     */
    (function () {
      var H = window.AxlxHumanWait;
      var _first = !_fillSessionSeen;              // このページで最初の入力か
      _fillSessionSeen = true;
      var lo = _first ? 2000 : 800, hi = _first ? 6500 : 2400;
      var ms = H && H.logNormalDelay ? H.logNormalDelay(_first ? 3200 : 1400, 0.35) : ((lo + hi) / 2);
      if (ms < lo) ms = lo; if (ms > hi) ms = hi;
      if (Math.random() < 0.08) ms += 800 + Math.floor(Math.random() * 1500); // たまに長く考える
      console.log("[AX] 条件を見て「どこから手を付けるか」考える間 " + Math.round(ms / 1000) + "秒（" + (_first ? "最初" : "2回目以降") + "）");
      _thinkBeforeFill = ms;
    })();

    // 未登録地名の警告（NEIGHBORHOOD_WARD_MAPに未登録のトークン）
    if (cond.unknown_tokens && cond.unknown_tokens.length) {
      console.log("[AX] ⚠️ 未登録地名（スキップ）: " + cond.unknown_tokens.join(", "));
      console.log("[AX] → popup.js の NEIGHBORHOOD_WARD_MAP に追加が必要です");
    }

    // ── 防御: station_names に路線名が混入していた場合、沿線(route_ids)に再分類する ──
    // 学習データ汚染等で「御堂筋線」が駅名として渡ってくると、駅リストに存在せず
    // 「指定の駅が選択できませんでした」で停止していた。ROUTE_LINE_MAP と照合し、
    // 路線名と判定できるトークンは route_ids に移して沿線ボタンクリックで処理する。
    // ※ 将来拡張ポイント: ここで判定できない「〜線」トークンは popup.js 側の
    //   /api/token-resolve（DeepSeek-V3 → Claude web_search の2段判定）で
    //   線名/駅名を解決できる。page-script はページ文脈で外部APIを呼べないため
    //   API判定は popup.js（resolveUnknownTokensWithAI）側に実装済み。
    (function reclassifyLineTokens() {
      var names = cond.station_names || [];
      if (!names.length) return;
      var keep = [];
      for (var i = 0; i < names.length; i++) {
        var token = String(names[i]).trim();
        var matchedId = null;
        if (/線$/.test(token) && token.length >= 3) {
          // 正規化: 「大阪市高速電気軌道」(大阪メトロ現名称) → 「大阪市高速軌道」(リアプロ内部名)
          var normTok = token.replace("大阪市高速電気軌道", "大阪市高速軌道");
          for (var id in ROUTE_LINE_MAP) {
            var ln = ROUTE_LINE_MAP[id];
            if (ln === normTok || ln.endsWith(normTok) || normTok.endsWith(ln)) { matchedId = id; break; }
          }
        }
        if (matchedId) {
          cond.route_ids = cond.route_ids || [];
          if (cond.route_ids.indexOf(matchedId) === -1) cond.route_ids.push(matchedId);
          console.log("[AX] 路線名を検出 → 駅から沿線に再分類: " + token + " → route_id " + matchedId);
        } else {
          keep.push(names[i]);
        }
      }
      cond.station_names = keep;
    })();

    // ── area_mode: webappトグル/ポップアップの明示指定が絶対ルール（自動判定より優先）──
    // "ward"    → 所在地モーダルのみ使用。駅/沿線の軸を完全に消す
    // "station" → 沿線・駅モーダルのみ使用。所在地の軸を完全に消す
    // "auto" / undefined → 何も消さない（従来の自動判定）
    // ※ resolve-search-conditions は同じ desired_area から city_codes と
    //   station_names/route_ids の両方を埋めるため、負けた軸をここで一括抹消しないと
    //   後段の駅名入力・隣駅展開・detail_ward モーダルが誤発火する。
    //   路線名再分類 IIFE の後に置くこと（ward モード時に再分類された route_ids も消すため）。

    // suppression前スナップショット: area_mode抹消で軸が空になったか判定するため
    var _hadAreaBeforeSuppress = !!(
      (cond.station_names && cond.station_names.length) ||
      (cond.route_ids && cond.route_ids.length) ||
      (cond.city_codes && cond.city_codes.length) ||
      cond.detail_ward ||
      (cond.desired_area && String(cond.desired_area).trim())
    );

    if (cond.area_mode === "ward") {
      cond.station_names = [];
      cond.route_ids    = [];
    } else if (cond.area_mode === "station") {
      cond.city_codes  = [];
      cond.detail_ward = null;
      cond.detail_area = null;
    }

    var hasStation   = cond.station_names && cond.station_names.length > 0;
    var hasRoutes    = cond.route_ids && cond.route_ids.length > 0;
    var hasCities    = cond.city_codes && cond.city_codes.length > 0;
    /**
     * 2026-11-14 竹内さん「今回も地域の部分押さなかった」「入力だけされてボタンは押していない」:
     *   ⚠ **バグを発見**: `hasModalWard` が `locationMode` を使っていたが、
     *     `locationMode` は**この行より後**で定義される（`var locationMode = decideLocationMode(cond)`）。
     *     `var` は巻き上げられるので、ここでは **undefined** →
     *     `hasCities && undefined === "area"` は **false** →
     *     **地域モーダルが一度も動かない**（実測: 点検の段に modal/ward/town が0件）。
     *   → ここでは `locationMode` を見ず、`area_mode` と区の有無で決める（後で locationMode を確定して直す）。
     */
    var hasModalWard = !!(cond.detail_ward) || (hasCities && (cond.area_mode !== "station"));
    var hasDetailArea = !!(cond.detail_area) || !!(cond.town_names && cond.town_names.length > 0);  // 町字まで選択
    // town_names: 複数町字配列（Supabase property_customers.town_names から）。detail_area と共存可。
    var townNamesList = (cond.town_names && cond.town_names.length > 0)
      ? cond.town_names : (cond.detail_area ? [cond.detail_area] : []);

    // ── 場所モード判定の一元化（優先順位: station > route > area > none）──────
    // リアプロは駅×所在地がAND条件になるため、駅/沿線がある場合は地域を使わない
    // area_mode が明示指定されている場合はユーザー意図を最優先する
    /**
     * 2026-11-11 竹内さん「場所あるのに場所ないと誤解している場合おおいのでは。
     *   所在地か沿線駅のどちらかで選択していれば場所は指定している。そこの部分誤解されていないか」
     *
     * ⚠ 旧: `area_mode === "ward"` の時、区が無ければ**他の軸を見ずに "none"**（＝場所なし）を返していた。
     *   だが area_mode は「どちらを使うか」の希望であって、**実際には駅・沿線で入っている事がある**
     *   （サーバーが両方の軸を埋める・area_mode が古い・resolve の結果が片方だけ等）。
     *   → **どちらか1つでも条件があれば場所あり**として扱う（"none" を返さない＝中止しない）。
     *     両方とも空の時だけ "none"。
     */
    var _hasWard = (c) => !!((c.city_codes && c.city_codes.length > 0) || c.detail_ward);
    var _hasStation = (c) => !!(c.station_names && c.station_names.length > 0);
    var _hasRoutes = (c) => !!(c.route_ids && c.route_ids.length > 0);
    function decideLocationMode(c) {
      if (c.area_mode === "ward") {
        // 希望は所在地。だが駅・沿線が入っていればそちらで場所は指定できている（誤解して止めない）
        if (_hasWard(c)) return "area";
        if (_hasStation(c)) return "station";
        if (_hasRoutes(c)) return "route";
        return "none";
      }
      if (c.area_mode === "station") {
        if (_hasStation(c)) return "station";
        if (_hasRoutes(c)) return "route";
        // 希望は駅。だが所在地が入っていればそちらで場所は指定できている
        if (_hasWard(c)) return "area";
        return "none";
      }
      // auto（従来: station > route > area > none）
      if (_hasStation(c)) return "station";
      if (_hasRoutes(c)) return "route";
      if (_hasWard(c)) return "area";
      return "none";
    }
    var locationMode = decideLocationMode(cond);
    /**
     * 2026-11-14: `locationMode` が確定したので、**ここで `hasModalWard` を正しく直す**。
     *   ⚠ 上で暫定で決めた値（`area_mode` ベース）を、確定した `locationMode` で上書きする。
     *     駅・沿線で入れる場合は地域モーダルを使わない（リアプロはAND条件になり結果が出なくなる）。
     */
    hasModalWard = !!(cond.detail_ward) || (hasCities && locationMode === "area");
    if (_audit) { _audit.area_path = locationMode; _auditStepP('location', locationMode); }
    console.log("[AX] 場所モード判定: " + locationMode + " / 地域モーダル: " + (hasModalWard ? "使う" : "使わない"),
      { area_mode: cond.area_mode, station_names: cond.station_names, route_ids: cond.route_ids,
        hasStation: hasStation, hasRoutes: hasRoutes,
        cities: cond.city_codes, ward: cond.detail_ward });

    // ── 基本条件（1項目ずつ 80〜200ms 間隔で順次入力 — 人間らしさ）──────────
    /**
     * 2026-11-13 竹内さん「つなぐ」（学んだ押す順番を自動モードに繋ぐ）:
     *   条件の入力順を、**人が押した順**に近づける。
     *   ⚠ 順番だけを変える（入れる項目は絶対に増減しない＝検索漏れを出さない）。
     *   ⚠ 学んだ順が無ければ今まで通り（下の並び）。
     */
    var _basicQueue = [];
    if (cond.rent_min) _basicQueue.push({ name: "rental_cost1", run: function () { queueSelVal("rental_cost1", nearestDown(RENT_OPTS, cond.rent_min)); } });
    if (cond.rent_max) _basicQueue.push({ name: "rental_cost2", run: function () { queueSelVal("rental_cost2", nearestUp(RENT_OPTS, cond.rent_max)); } });
    if (cond.area_min) _basicQueue.push({ name: "square_meter_l", run: function () { queueSelVal("square_meter_l", nearestDown(AREA_OPTS, cond.area_min)); } });
    if (cond.area_max) _basicQueue.push({ name: "square_meter_h", run: function () { queueSelVal("square_meter_h", nearestUp(AREA_OPTS, cond.area_max)); } });
    var feeCb0 = document.querySelector('input[name="include_common_fee"]');
    if (feeCb0 && !feeCb0.checked) _basicQueue.push({ name: "include_common_fee", run: function () { enqueueHumanClick(feeCb0, _clickEl, 450, 1000); } });
    /**
     * 2026-11-13 竹内さん「自動検索にちゃんと反映されるようになっているのか学習の部分。抜けている部分ないのか」:
     *   ⚠ 旧は**賃料・面積・共益費の5つだけ**をまとめて並べ替え、
     *     徒歩（required_time）・築年（structured_date）・間取り（room_layout_id[]）は
     *     **その下で個別に呼んでいた**（並べ替えの外）。
     *   → 学んだ12通りのうち、実際に使えるのは **3通りだけ**だった（実測）。
     *   直し: **徒歩・築年・間取りも同じ並びに積む**（`_clickQueue` は1本なので順番どおりに流れる）。
     *     ⚠ 積む**中身は変えない**（今までと同じ条件・同じ押し方）。**順番だけ**が学んだ順になる。
     */
    // 徒歩（移動手段 → 分数）: 人が押す順（移動手段が先）は今まで通り守る
    if (cond.walk_minutes) {
      /**
       * 2026-11-14 竹内さん「駅からの移動手段のところ 徒歩をプルダウンで選択するところできていなかった」:
       *   ⚠ 旧は `queueSelVal("transportation_id", "1")` と**値"1"を決め打ち**していた。
       *     リアプロの「徒歩」の値が `"1"` でない場合:
       *       ・`chooseSelectLikeHuman` の**値一致で見つからず**、文字一致の所で `"1"` を文字として探す
       *       ・それも無いので `want = 0`（＝**先頭＝未選択**）になり、**徒歩が入らない**
       *     実測: 自動モードで `transportation_id` が **0件**（通常モードは人が3件押している）。
       *   → **値ではなく「徒歩」という文字で選ぶ**（`queueSelVal` に文字指定を渡せるようにする）。
       *     駅からの移動手段は「徒歩」が既定なので、文字で探すのが一番確実。
       */
      _basicQueue.push({ name: "transportation_id", run: function () { queueSelValText("transportation_id", "徒歩"); } });
      _basicQueue.push({
        name: "required_time",
        run: function () {
          // 2026-11-10 v2.6.4: 移動手段を選んでから「何分にしよう」と考える間 → 1文字ずつ打つ
          var inp = document.querySelector('input[name="required_time"]');
          if (!inp) return;
          _enqueueWithEl(inp, function () {
            return new Promise(function (resolve) {
              setTimeout(function () { resolve(typeTextLikeHuman(inp, cond.walk_minutes)); }, _ln(950, 0.4, 600, 1400));
            });
          }, 900, 1500, 'txt:required_time=' + cond.walk_minutes);
        },
      });
    }
    if (cond.building_age) {
      _basicQueue.push({ name: "structured_date", run: function () { queueSelVal("structured_date", nearestUp(AGE_OPTS, cond.building_age)); } });
    }
    /**
     * 間取り: 学んだ順に並べるため、**押す物の一覧を作ってから**積む。
     *   ⚠ 名前は実際の間取りのラベル（「左の3K｜label」など）ではなく
     *     **`room_layout_id[]` にそろえる**（学習は `_basicQueue` の名前で並ぶため）。
     *     1つずつ（人がチェックする形）押す。中身・順番の集合は今までと同じ。
     */
    var _layoutsToPush = null;
    if (cond.floor_plan) {
      var FLOOR_RANK = [
        "1R","ワンルーム","スタジオタイプ","スタジオ",
        "1K","1DK","1LDK",
        "2K","2DK","2LDK",
        "3K","3DK","3LDK",
        "4K","4DK","4LDK",
        "5K","5DK","5LDK",
        "6LDK","メゾネット"
      ];
      // 短縮表記を正規化: "1L以上" → "1LDK以上"、"2L〜3L" → "2LDK〜3LDK"
      // v2.5.50 全角の数字・英字は半角にそろえる（登録「２K　2DK 2LDK」の ２K が型として読めていなかった）
      var fpStr = String(cond.floor_plan).replace(/[Ａ-Ｚａ-ｚ０-９]/g, function (ch) { return String.fromCharCode(ch.charCodeAt(0) - 0xFEE0); })
        .toUpperCase().trim().replace(/(\d)L(?!\w)/g, '$1LDK');
      var vals = [];
      var ijouMatch = fpStr.match(/^(.+?)以上$/);
      var rangeMatch = fpStr.match(/^(.+?)[～〜](.+?)$/);
      if (ijouMatch) {
        // 「3LDK以上」→ 3LDK〜メゾネットを全選択
        var baseFloor = ijouMatch[1].trim();
        var baseIdx = FLOOR_RANK.indexOf(baseFloor);
        // v2.5.82 竹内「1LDK以上…1LDKから2LDKで調べる」: 一つ上の大きさまで（floor-ijou.js・content.js が先に入れる）
        var _FI = (typeof AxlxFloorIjou !== "undefined" ? AxlxFloorIjou : null);
        var _rg = _FI ? _FI.ijouRange(FLOOR_RANK, baseFloor) : null;
        if (baseIdx >= 0) {
          for (var ri = baseIdx; ri < (_rg ? _rg[1] + 1 : FLOOR_RANK.length); ri++) {
            var fv = FLOOR_MAP[FLOOR_RANK[ri]];
            if (fv && vals.indexOf(fv) < 0) vals.push(fv);
          }
        }
      } else if (rangeMatch) {
        // 「1DK～1LDK」→ 1DKから1LDKまでの範囲を全選択
        var fromFloor = rangeMatch[1].trim();
        var toFloor   = rangeMatch[2].trim();
        if (SLDK_SUBSTITUTE[fromFloor]) {
          // fromFloor が SLDK（リアプロに存在しない）→ 代替間取りを展開
          // 例: "1SLDK〜2LDK" → 1LDK + 2DK + 2LDK
          SLDK_SUBSTITUTE[fromFloor].forEach(function(v) {
            if (vals.indexOf(v) < 0) vals.push(v);
          });
          // toFloor が展開上限(2LDK等)より上なら残り範囲を追加
          var upperLdk = SLDK_UPPER_LDK[fromFloor];
          var upperIdx = FLOOR_RANK.indexOf(upperLdk);
          var toIdx = FLOOR_RANK.indexOf(toFloor);
          if (upperIdx >= 0 && toIdx > upperIdx) {
            for (var ri = upperIdx + 1; ri <= toIdx; ri++) {
              var fv = FLOOR_MAP[FLOOR_RANK[ri]];
              if (fv && vals.indexOf(fv) < 0) vals.push(fv);
            }
          }
        } else {
          var fromIdx = FLOOR_RANK.indexOf(fromFloor);
          var toIdx   = FLOOR_RANK.indexOf(toFloor);
          // ★ 修正(M5): 未知の間取り文字列の場合 indexOf が -1 を返し、
          //   0 扱いになって「ワンルーム〜xxx」という意図しない範囲が選択されていた。
          //   どちらかが -1 なら範囲選択を中止してスキップする。
          if (fromIdx < 0 || toIdx < 0) {
            console.warn('[AX] rangeMatch: unknown floor plan, skipping range selection', fromFloor, toFloor);
          } else {
            if (fromIdx > toIdx) { var tmp = fromIdx; fromIdx = toIdx; toIdx = tmp; }
            for (var ri = fromIdx; ri <= toIdx; ri++) {
              var fv = FLOOR_MAP[FLOOR_RANK[ri]];
              if (fv && vals.indexOf(fv) < 0) vals.push(fv);
            }
          }
        }
      } else {
        // カンマ・もしくは・または等で分割し、各トークン内からFLOOR_MAPキーを抽出
        // 例: "2LDKもしくは、ちょっと広めの1LDK" → ["2LDK", "1LDK"]
        var floorKeys = Object.keys(FLOOR_MAP).sort(function(a,b){ return b.length - a.length; });
        function extractFloor(token) {
          if (SLDK_SUBSTITUTE[token]) {
            // SLDKは複数値なので vals に直接追加してnullを返す
            SLDK_SUBSTITUTE[token].forEach(function(v) {
              if (vals.indexOf(v) < 0) vals.push(v);
            });
            return null;
          }
          if (FLOOR_MAP[token]) return FLOOR_MAP[token];
          for (var ki = 0; ki < floorKeys.length; ki++) {
            if (token.indexOf(floorKeys[ki]) >= 0) return FLOOR_MAP[floorKeys[ki]];
          }
          return null;
        }
        var rawTokens = fpStr.split(/[,、・\/\.\s]+|もしくは|または|もしくわ|あるいは/)
          .map(function(s){ return s.trim(); }).filter(Boolean);
        rawTokens.forEach(function(t) {
          var v = extractFloor(t);
          if (v && vals.indexOf(v) < 0) vals.push(v);
        });
      }
      // 広げて検索：LDK → 同室数DKも追加（1LDK→1DK, 2LDK→2DK等）
      if (cond.is_wide) {
        FLOOR_RANK.forEach(function(rank) {
          var v = FLOOR_MAP[rank];
          if (v && vals.indexOf(v) >= 0 && /LDK$/.test(rank)) {
            var dkKey = rank.replace("LDK", "DK");
            var dkVal = FLOOR_MAP[dkKey];
            if (dkVal && vals.indexOf(dkVal) < 0) vals.push(dkVal);
          }
        });
      }
      if (vals.length) {
        /**
         * 2026-11-13: 学んだ順に並べるため、**ここでは押さずに並びに積む**（下で並べ替えてから流す）。
         *   ⚠ 押す内容は今までと同じ（`setCheckboxes` と同じ対象・同じ1つずつの押し方）。
         *     変えるのは**順番だけ**。
         */
        _layoutsToPush = vals;
      }
    }
    /**
     * 間取りを1つずつ積む（人がチェックする形・今までと同じ `enqueueHumanClick`）。
     *   名前は `room_layout_id[]` にそろえる（学習の並びと合わせる）。
     */
    if (_layoutsToPush && _layoutsToPush.length) {
      (function (vals2) {
        var cbs = Array.prototype.slice.call(document.querySelectorAll('input[name="room_layout_id[]"]'));
        // いまの画面で「入れるべき物」と違う物だけ押す（今までと同じ判定）
        var targets = cbs.filter(function (cb) { return cb.checked !== (vals2.map(String).indexOf(String(cb.value)) >= 0); });
        targets.forEach(function (cb) {
          _basicQueue.push({
            name: "room_layout_id[]",
            run: function () {
              enqueueHumanClick(cb, _clickEl, 420, 980);
              /**
               * 2026-11-11 竹内さん「この＋一息の考え方かなり重要。人間はその発想があるから」:
               *   間取りのチェックにも一息を入れる（`setCheckboxes` と同じ 10%／3%）。
               *   ⚠ 並び替えで `setCheckboxes` を通らなくなるので、**同じ一息をここに移す**（人間らしさを落とさない）。
               */
              if (Math.random() < 0.10) {
                var _b1 = 900 + Math.floor(Math.random() * 1700);
                enqueueHumanAction(function () {}, _b1, _b1 + 200, "息");
              } else if (Math.random() < 0.03) {
                var _b2 = 2600 + Math.floor(Math.random() * 2900);
                enqueueHumanAction(function () {}, _b2, _b2 + 200, "考え");
              }
            },
          });
        });
      })(_layoutsToPush);
    }
    // ここで**まとめて**並べ替える（賃料・面積・共益費・徒歩・築年・間取りが同じ並びに入る）
    _basicQueue = _orderByLearned(_basicQueue);
    for (var _bi = 0; _bi < _basicQueue.length; _bi++) { try { _basicQueue[_bi].run(); } catch (_) {} }
    // 2026-11-10 v2.6.18 竹内さん「ちゃんと画面見て判断できるようになってるのかな場所など」→「なおす」:
    //   入れるはずの値を1か所に置く（検索を押す直前に、画面の実際の値と1つずつ比べる）。
    //   間取りの有無に関わらず置く（家賃・更新日・徒歩・場所も比べるため）。
    _axExpect = {
      layoutVals: (cond.floor_plan ? Array.prototype.slice.call(document.querySelectorAll('input[name="room_layout_id[]"]:checked')).map(function (c) { return String(c.value); }) : []),
      floorPlan: String(cond.floor_plan || ''),
      rentMax: (cond.rent_max != null ? String(nearestUp(RENT_OPTS, cond.rent_max)) : null),
      rentMin: (cond.rent_min != null ? String(nearestDown(RENT_OPTS, cond.rent_min)) : null),
      updateDays: (cond.rp_update_days != null ? String(cond.rp_update_days) : (cond.rp_update_days === '' ? '' : null)),
      age: (cond.building_age ? String(nearestUp(AGE_OPTS, cond.building_age)) : null),
      walk: (cond.walk_minutes != null ? String(cond.walk_minutes) : null),
      /**
       * 2026-11-11 竹内さん「所在地か沿線駅のどちらかで選択していれば場所は指定している」:
       *   **実際にどちらで入れるか**（locationMode）を控える。
       *   area_mode（希望）だけを見ると、駅で入れたのに「区が無い＝場所なし」と誤解する。
       */
      areaMode: (function () {
        var lm = (typeof locationMode !== 'undefined' && locationMode) ? locationMode : null;
        if (lm === 'area') return 'ward';
        if (lm === 'station' || lm === 'route') return 'station';
        return (cond.area_mode || (cond.station_names && cond.station_names.length ? 'station' : (cond.city_codes && cond.city_codes.length ? 'ward' : null)));
      })(),
      areaText: String(cond.detail_ward || (cond.station_names || []).slice(0, 2).join('・') || ((cond.city_codes || []).length + '区')),
    };
    /**
     * 2026-11-11 竹内さん「所在地も通常モードならちゃんと光るのに自動モードやAIXモードでできていない」:
     *   区は**コードで探す**のが一番確実（案内モードと同じ）。ここで控えを置き、clickWardPrecise が使う。
     */
    try {
      window.__axlxWardCodes = (cond.city_codes || []).map(String);
    } catch (_) { window.__axlxWardCodes = null; }
    if (cond.structure_types && cond.structure_types.length > 0) {
      var sVals = cond.structure_types.map(function(s){ return STRUCTURE_MAP[s]; }).filter(Boolean);
      if (sVals.length) setCheckboxes("structured_type[]", sVals);
    }
    if (cond.pet_ok) {
      var petCb = document.querySelector('input[name="eq_rm[]"][value="113"]');
      if (petCb && !petCb.checked) enqueueHumanClick(petCb, _clickEl, 450, 1000);
    }
    if (cond.shikirei_free) {
      // 敷金・礼金なしチェックボックス: ラベルテキストで検索してクリック
      var sLabels = document.querySelectorAll('label');
      for (var si = 0; si < sLabels.length; si++) {
        var sTxt = (sLabels[si].textContent || '').replace(/[\s　]/g, '');
        if (sTxt === '敷金・礼金なし' || sTxt === '敷金礼金なし') {
          var sInp = sLabels[si].querySelector('input[type="checkbox"]');
          if (sInp && !sInp.checked) { enqueueHumanClick(sInp, _clickEl, 450, 1000); console.log('[AX] 敷金・礼金なしをチェック'); }
          break;
        }
      }
    }
    {
      // 更新日フィルター（update_date select: 1/3/7/14日以内）
      // 検索フォームページにのみ存在するため、存在確認してからセット。
      // rp_update_days が null（新規顧客・初回物件出し前）の場合は
      // 前の顧客の選択値が残らないよう "" にリセットする。
      var updEl = document.querySelector('select[name="update_date"]');
      if (updEl) {
        if (cond.rp_update_days) {
          queueSelVal("update_date", String(cond.rp_update_days));
          console.log("[AX] 更新日セット:", cond.rp_update_days + "日以内");
        } else {
          queueSelVal("update_date", "");
          console.log("[AX] 更新日リセット（新規顧客 or 未設定）");
        }
      }
    }

    {
      // 並び順（2026-09-19 竹内）
      //   「AD順じゃなくて、指定しなければ更新順になるから17時の時だけ並び替え順をAD順にしなければ大丈夫」
      //
      // つまり**リアプロの既定が更新順**。やることは「17時便では並び替えを既定に戻す」だけ。
      //   ・sort_order="updated"（17時便）→ 並び替えを**既定へ明示的に戻す**
      //   ・sort_order="ad"（11時便）・未指定（手動）→ **何もしない**（今の並びのまま）
      //
      // 「指定しない」ではなく「戻す」なのは、リアプロが**前の検索の値を残す**画面だから。
      // 同じ罠を更新日フィルターで踏んでいる（上の update_date も「前の顧客の選択値が残らないよう "" にリセット」）。
      // 11時便が AD 順で走った後、17時便で何もしないと AD 順のままになる。
      if (cond.sort_order === "updated") {
        var SORT_SELECTORS = ['select[name="sort"]', 'select[name="order"]', 'select[name="sort_order"]', 'select[name="disp_sort"]', 'select[name="order_by"]'];
        var sortEl = null;
        for (var _si = 0; _si < SORT_SELECTORS.length; _si++) {
          sortEl = document.querySelector(SORT_SELECTORS[_si]);
          if (sortEl) break;
        }
        if (sortEl) {
          // 既定＝空の選択肢があればそれ、無ければ先頭（リアプロの既定は更新順）
          var _def = null;
          for (var _oi = 0; _oi < sortEl.options.length; _oi++) {
            if ((sortEl.options[_oi].value || "") === "") { _def = sortEl.options[_oi]; break; }
          }
          if (!_def && sortEl.options.length > 0) _def = sortEl.options[0];
          if (_def) {
            queueSelVal(sortEl.getAttribute("name"), _def.value);
            console.log("[AX] 並び順を既定（更新順）に戻す:", (_def.textContent || "").trim() || "(空)");
          }
        } else {
          // 見つからない時は触らない＝既定のまま。実機で名前を確かめる手がかりだけ出す
          //   （11時便が AD 順を指定していない今の作りでは、そもそも AD 順が残らないので実害は出にくい）
          var _allSel = Array.prototype.map.call(document.querySelectorAll("select"), function (s) {
            return (s.getAttribute("name") || "(name無し)") + "=[" + Array.prototype.map.call(s.options, function (o) { return (o.textContent || "").trim(); }).slice(0, 6).join("|") + "]";
          });
          console.warn("[AX] 並び順の select が見つからない（既定のまま・要確認）。画面の select 一覧:", _allSel.join("  "));
        }
      }
    }

    // ── T=150ms: 所在地絞り込み（直接チェック — モーダルを使わない場合のみ）─────
    // detail_ward がある場合はモーダル経由で選択するのでスキップ
    // 駅・沿線指定がある場合は所在地をセットしない（リアプロはAND条件になり検索結果が出なくなる）
    // locationMode === "area" は「駅・沿線なし かつ (city_codes or detail_ward)あり」なので
    // !hasModalWard との組み合わせで従来の hasCities && !hasModalWard && !hasStation && !hasRoutes と等価
    /**
     * 2026-11-14 竹内さん「いきなり地域だけ選択せずに選択して入れてしまっている可能性ある。
     *   そこも原因で止まってしまうバグが起きているのでは」:
     *   ⚠ **その通りだった**。ここで `setCheckboxes("city_code[]", ...)` を直接呼ぶと、
     *     モーダルを開く**前に**区がチェックされた状態になる（リアプロは前の選択を保持するので、
     *     前のお客様の区が残っている事もある）。
     *     ・モーダル経由の時（hasModalWard）は**この分岐を絶対に通さない**
     *     ・通すのは「モーダルを使わない（区を直接チェックする）」時だけ
     *   ⚠ さらに **モーダルを使う時は、開く前に区・町字を全部外す**（下の _clearPrevAreaSelection が担当）。
     */
    var _useDirectCities = (locationMode === "area" && !hasModalWard);
    if (locationMode === "area" && hasModalWard) {
      // モーダルで選ぶので、直接チェックの経路が混ざらないように**ここで記録**する
      if (_audit) _auditStepP('area_skip_direct', 'モーダルで選ぶため直接チェックはしない');
    }
    if (_useDirectCities) {
      var prefCb = document.querySelector('input[name="pref_code"][value="27"]');
      if (prefCb && !prefCb.checked) {
        prefCb.checked = true;
        prefCb.dispatchEvent(new Event("change", {bubbles:true}));
      }
      setTimeout(function() { _auditStepP('cities', (cond.city_codes || []).length); setCheckboxes("city_code[]", cond.city_codes); }, _hd(150));
    }

    // 沿線・駅なし（locationMode: area または none）
    if (locationMode === "area" || locationMode === "none") {
      if (locationMode === "none") {
        // area_mode抹消等で場所条件が空になった場合 → 全件検索せず中止（fallbackSearchWithoutAreaと同方針）
        if (_hadAreaBeforeSuppress) {
          var errNone = "area_mode=" + (cond.area_mode || "auto") +
            " 指定により場所条件が空になりました（全件検索防止のため中止）";
          showWarnToast(errNone);
          notifyDone(errNone);
          return;
        }
        // 本当に場所条件ゼロの顧客（desired_area自体が空）のみ: 従来どおり可視化して検索
        var warnNone = "場所条件なしで検索します（家賃・間取り等のみ）。";
        if (cond.unknown_tokens && cond.unknown_tokens.length) {
          warnNone = "未解決の地名: " + cond.unknown_tokens.join("、") + "\n" + warnNone;
        }
        showWarnToast(warnNone);
        setTimeout(clickSearch, 240 + Math.floor(Math.random() * 160));
        return;
      }
      if (hasModalWard) {
        // ── ポーリング方式（waitForClick）──────────────────────────────
        // 各ステップ: 要素が見つかるまで500msごとにリトライ
        //             見つかったら600ms後に次のステップを起動
        // 人間が画面を見て確認してから押すのと同等の動き
        var wardFull  = cond.detail_ward || "";
        var wardShort = wardFull.replace(/^大阪市|^大阪府/, "");
        var detailAreaName = cond.detail_area || "";
        // town_names が優先: 複数町字を全てクリック。detail_area 単体は後方互換で残す
        var townNamesForStep5 = (cond.town_names && cond.town_names.length > 0)
          ? cond.town_names : (detailAreaName ? [detailAreaName] : []);

        function closeAreaModal() {
          /**
           * 2026-11-11 竹内さん「地域の場合は 1所在地絞り込み 2該当する地域 3確定してリストへ」:
           *   ⚠ 旧は `div.this_window_close`（×とじる）を**先に**押していた。×は閉じるだけで反映されない事がある。
           *   → **まず「確定してリストへ」**。無い時だけ ×／とじる。
           */
          var conf = _findByText(['確定してリストへ', 'この条件で絞り込む', '決定']);
          if (conf) {
            if (_audit) _auditStepP('modal_confirm', '確定してリストへ');
            _humanPointerClick(conf, function () { try { conf.click(); } catch (_) {} });
            return true;
          }
          var d = document.querySelector('div.this_window_close');
          if (d && isVisible(d)) {
            if (_audit) _auditStepP('modal_confirm', '×とじる（確定が見つからない）');
            _humanPointerClick(d, function () { try { d.click(); } catch (_) {} });
            return true;
          }
          return clickByText(['×とじる', '× とじる', 'とじる', '閉じる']);
        }

        // 所在地モーダル操作がタイムアウトした場合のフォールバック:
        // city_codes があれば直接チェックボックス方式に降格して検索を継続する（区レベルで検索）。
        // city_codes も無い場合のみ全件検索防止のため中止する。
        function fallbackSearchWithoutArea(msg) {
          if (_audit) { _audit.fallback = '所在地モーダル失敗 → 市区コードで代替: ' + String(msg).slice(0, 150); _auditStepP('fallback_area', msg); }
          try { closeAreaModal(); } catch (e) { /* ignore */ }
          var codes = (cond.city_codes || []).map(String);
          if (codes.length > 0) {
            // 町丁目モーダルは失敗したが区コードがある → 直接チェックで代替（ピンポイントが区レベルに降格）
            showWarnToast('所在地モーダル失敗 → 市区コードで代替検索: ' + msg);
            var prefCb2 = document.querySelector('input[name="pref_code"][value="27"]');
            if (prefCb2 && !prefCb2.checked) {
              prefCb2.checked = true;
              prefCb2.dispatchEvent(new Event('change', {bubbles:true}));
            }
            setTimeout(function() {
              try { setCheckboxes('city_code[]', codes); } catch (e) { console.error('[AX] fallback setCheckboxes例外', e); }
              setTimeout(function() {
                // キュー化された順次クリックが全て反映されてから判定する
                whenClickQueueIdle(function() {
                // 1つ以上実際にチェックされた場合のみ検索（全件検索防止）
                var applied = document.querySelectorAll('input[name="city_code[]"]:checked').length;
                if (applied > 0) {
                  clickSearch();
                } else {
                  var em = '所在地フォールバック失敗: city_codeチェック未反映（全件検索防止のため中止）: ' + msg;
                  showWarnToast(em);
                  notifyDone(em);
                }
                });
              }, 600 + Math.floor(Math.random() * 300));
            }, 240 + Math.floor(Math.random() * 160));
            return;
          }
          // city_codes もない → 全件検索は絶対にしないが、**区が1つでも入れば検索へ進む**
          _areaAtLeastOneThenSearch(msg);
        }

        /**
         * 2026-11-14 竹内さん「順に実際の動きのように押していけばできるようになる」:
         *   **段ごとに順に押し、どこで止まっても次へ進む**ための「関所」。
         *   ・地域モーダルが失敗しても、**区が1つでも入っていれば検索まで進む**
         *   ・区も入らない時だけ中止（全件検索は絶対にしない）
         *   ⚠ これを入れないと「地域で止まる → 検索しない → 物件が出ない」になる（実測で起きていた）。
         */
        function _areaAtLeastOneThenSearch(why) {
          try {
            var codes = (cond.city_codes || []).map(String);
            if (codes.length) {
              try { setCheckboxes('city_code[]', codes); } catch (_) {}
            }
            setTimeout(function () {
              whenClickQueueIdle(function () {
                var applied = document.querySelectorAll('input[name="city_code[]"]:checked').length;
                if (_audit) _auditStepP('area_force_search', applied + '区で検索へ（' + String(why).slice(0, 60) + '）');
                if (applied > 0) {
                  console.warn('[AX] 地域は完全でないが ' + applied + '区入っている → 検索へ進む');
                  clickSearch();
                } else {
                  var em = '地域が1区も入らず中止（全件検索防止）: ' + String(why).slice(0, 120);
                  showWarnToast(em);
                  notifyDone(em);
                }
              });
            }, 700 + Math.floor(Math.random() * 300));
          } catch (_) {}
        }

        // 「詳細な地域の設定へ進む」ボタン
        // 診断確認: class=next_action_town_search_Y のときだけ機能する
        // → Y状態を確認してからクリック・N状態なら市区郡を再クリック
        /**
         * 2026-11-11 竹内さん「駅の設定へ進むへ画面が移動して押されていなかった」:
         *   旧は simulateClick を呼んだ直後に false を返していた（＝まだ押せていないのに「押した」扱い）。
         *   カーソルを動かしてから押すようになったので、**押し終わって画面が変わるまで**は
         *   「押した」と返さない（waitForClick が次へ進まない＝ボタンを取りこぼさない）。
         *   ・押した印（_nextPressedAt）から 900ms は「押し中」として待つ
         *   ・町字の一覧（label.one_town）が出たら成功
         */
        var nextBtnAttempts = 0;
        var _nextPressedAt = 0;
        function clickNextStepBtn() {
          if (document.querySelectorAll('label.one_town').length > 0) {
            console.log('[AX] clickNextStepBtn: 町字ページ表示確認 → 完了');
            return true;
          }
          // 押した直後は「画面が変わるのを待つ」間（押し直さない・次へ進まない）
          if (_nextPressedAt && Date.now() - _nextPressedAt < 900) return false;
          var btnEl = document.querySelector('div.next_step_button2');
          var isY = btnEl ? btnEl.classList.contains('town_search_Y') : false;
          // 押し終わるのを待ってから押した印を付ける（カーソル移動の途中で押し直さない）
          if (isY && _pressBusy > 0) return false;
          if (nextBtnAttempts % 2 === 0 && isY) {
            _nextPressedAt = Date.now();
            simulateClick(btnEl);
            if (_audit) _auditStepP('ward_next_press', 'next_step_button2');
            console.log('[AX] clickNextStepBtn: Y確認→カーソル移動してクリック (試行=' + nextBtnAttempts + ')');
          } else if (!isY) {
            console.log('[AX] clickNextStepBtn: N待機 (試行=' + nextBtnAttempts + ')');
          }
          nextBtnAttempts++;
          return false;
        }

        // 市区郡ボタンを確実にY状態にしてからコールバック
        // 診断実証済み: native .click()でdeselect→300ms→simulateClickでselect→400ms→Y確認
        function ensureWardButtonY(callback) {
          if (isWardButtonY()) { callback(); return; }
          var wardLbls = Array.prototype.slice.call(document.querySelectorAll('label')).filter(function(l){
            return !!l.querySelector('input[name="city_code[]"]');
          });
          var wTarget = null;
          var searchTerms = [wardFull, wardShort];
          for (var ci = 0; ci < searchTerms.length && !wTarget; ci++) {
            var t = norm(searchTerms[ci]);
            for (var i = 0; i < wardLbls.length; i++) {
              var ltxt = norm(wardLbls[i].textContent);
              if (ltxt === t || ltxt.includes(t) || t.includes(ltxt)) { wTarget = wardLbls[i]; break; }
            }
          }
          if (!wTarget) { console.log('[AX] ensureWardButtonY: ラベル見つからず → proceed'); callback(); return; }
          var wInp = wTarget.querySelector('input[name="city_code[]"]');
          if (wInp && wInp.checked) {
            wTarget.click();
            console.log('[AX] ensureWardButtonY: checked→deselect 300ms待機');
          }
          setTimeout(function() {
            simulateClick(wTarget);
            console.log('[AX] ensureWardButtonY: simulateClick→select 400ms待機');
            setTimeout(function() {
              if (isWardButtonY()) {
                console.log('[AX] ensureWardButtonY: Y確認 → callback');
                callback();
              } else {
                waitForClick(isWardButtonY, callback, 15, 300, 240 + Math.floor(Math.random() * 160), function() {
                  console.log('[AX] ensureWardButtonY: タイムアウト → 強制callback');
                  callback();
                });
              }
            }, 320 + Math.floor(Math.random() * 200));
          }, 240 + Math.floor(Math.random() * 160));
        }

        // STEP1: 「所在地絞り込み＋」が出るまで待ってクリック
        /**
         * 2026-11-14 竹内さん「いきなり地域だけ選択せずに選択して入れてしまっている可能性ある」:
         *   ⚠ **モーダルを開く前に、区・町字を全部外す**。
         *     リアプロは前のお客様の選択を保持するので、開いた時に**すでに区が入っている**事がある。
         *     その状態で「区を押す」とトグルで**外れて**しまい、確定しても地域が入らない
         *     （＝止まる原因）。先にきれいにする。
         */
        (function _clearBeforeOpen() {
          try {
            var on = Array.prototype.slice.call(document.querySelectorAll('input[name="city_code[]"]:checked, input[name="town_code[]"]:checked'));
            if (!on.length) return;
            /**
             * 2026-11-14 竹内さん「地域の部分ちゃんと１つずつ…今自動的に反映されてしまっている場面がある」
             *   「徒歩選択したあとに、選択までできたが自動で消してしまっている」:
             *
             *   ⚠ 旧は**全部外して**いたので、**人が選んだ地域まで消していた**。
             *   → **自動で入れた物だけ**外す（`__axAutoPicked`）。人が選んだ物は残す。
             *     覚えが無い（前のお客様の残り）時は今まで通り全部外す。
             */
            var _auto = window.__axAutoPicked;
            var _keepHuman = false;
            try {
              if (_auto && typeof _auto === "object") {
                var _set = {};
                ["city", "town"].forEach(function (k) {
                  (Array.isArray(_auto[k]) ? _auto[k] : []).forEach(function (v) { _set[k + ":" + String(v)] = true; });
                });
                var _targets = on.filter(function (cb) {
                  var nm = String(cb.name || "");
                  var kind = nm.indexOf("town_code") >= 0 ? "town" : "city";
                  return !!_set[kind + ":" + String(cb.value)];
                });
                if (_targets.length < on.length) {
                  _keepHuman = true;
                  if (_audit) _auditStepP('area_preclear_keep', (on.length - _targets.length) + '件は人が選んだので残す');
                }
                on = _targets;
              }
            } catch (_) {}
            if (!on.length) return;
            if (_audit) _auditStepP('area_preclear', on.length + '件を先に外す' + (_keepHuman ? '（人が選んだ物は残す）' : ''));
            console.log('[AX] モーダルを開く前に地域を外します:', on.length, '件' + (_keepHuman ? '（人が選んだ物は残す）' : ''));
            on.forEach(function (cb) {
              try { if (cb.checked) { cb.checked = false; cb.dispatchEvent(new Event("change", { bubbles: true })); } } catch (_) {}
            });
          } catch (_) {}
        })();
        waitForClick(
          /**
           * 2026-11-14 竹内さん「まだ所在地絞り込み押すことできていない。原因見つけて改善する」:
           *   ⚠ 旧は `clickByText(['所在地絞り込み＋', ...])` だけで探していた。
           *     だが `clickByText` は **`textContent`（子の文字も全部つなぐ）** で照合するので、
           *     リアプロの左の帯のように
           *       `<div class="click_menu">所在地絞り込み<span>＋</span></div>`
           *     の**入れ子**になっていると、親の div の文字が
           *     「所在地絞り込み＋沿線・駅絞り込み＋…」のように長くなり、**完全一致しない**。
           *     部分一致は「短すぎる候補は除く」規則（5文字未満）で落ちる事もある。
           *   ⚠ 駅（沿線・駅絞り込み）は**先にクラス名で堅く探す**ように直してあった（動いていた）。
           *     地域だけ文字頼みで残っていた＝**ここが押せない原因**。
           *   → 駅と同じ順で探す：① **クラス名**（click_menu / one_slide_search_box）
           *     ② **場所の帯の中**（.left_area / #left / .one_slide_search_box / 画面の左半分）
           *     ③ 文字（今まで通り）
           */
          function() {
            try {
              // ① クラス名で堅く探す（駅と同じ）
              var clsTargets = ['click_menu', 'one_slide_search_box'];
              for (var ci = 0; ci < clsTargets.length; ci++) {
                var divs = Array.prototype.slice.call(document.querySelectorAll('div.' + clsTargets[ci]));
                for (var i = 0; i < divs.length; i++) {
                  if (!isVisible(divs[i])) continue;
                  var t = divs[i].textContent.replace(/\s+/g, '');
                  if (t.includes('所在地絞り込み')) {
                    if (_audit && !window._axAreaOpenMarked) { window._axAreaOpenMarked = true; _auditStepP('area_open_by_class', clsTargets[ci]); }
                    // 2026-11-14 竹内さん「この地域押すところ…ちゃんと学習する」: 学んだ押す位置で押す
                    _pressLearned(divs[i], ['左の所在地絞り込み', '所在地絞り込み＋', '所在地絞り込み'], 'area_open');
                    return true;
                  }
                }
              }
              // ② 場所の帯の中を文字で探す（親の入れ子に強い）
              var areas = Array.prototype.slice.call(document.querySelectorAll('.left_area, #left, .one_slide_search_box, .search_box, #search_area, .side'));
              for (var ai = 0; ai < areas.length; ai++) {
                if (!isVisible(areas[ai])) continue;
                var cands = Array.prototype.slice.call(areas[ai].querySelectorAll('div,span,a,button,td,p'));
                for (var k = 0; k < cands.length; k++) {
                  if (!isVisible(cands[k])) continue;
                  var tt = cands[k].textContent.replace(/\s+/g, '');
                  // 「所在地絞り込み＋」を含み、**他の絞り込みを含まない**（一番内側を採る）
                  if (tt.includes('所在地絞り込み') && !/沿線・駅絞り込み|管理会社絞り込み/.test(tt)) {
                    if (_audit && !window._axAreaOpenMarked) { window._axAreaOpenMarked = true; _auditStepP('area_open_by_area', tt.slice(0, 20)); }
                    _pressLearned(cands[k], ['左の所在地絞り込み', '所在地絞り込み＋', '所在地絞り込み'], 'area_open');
                    return true;
                  }
                }
              }
            } catch (_) {}
            // ③ 文字（今まで通り・最後の受け皿）
            return clickByText(['所在地絞り込み＋', '所在地絞り込み+', '所在地絞り込み']);
          },
          function() {
            console.log('[AX] STEP1完了: 所在地絞り込みクリック済');
            _auditStepP('modal', 'area');
            /**
             * 2026-11-14 竹内さん「まだ所在地絞り込み押すことできていない。原因見つけて改善する」:
             *   ⚠ 押した「つもり」で次へ進むと、モーダルが開いていないのに STEP2 以降が
             *     全部タイムアウトして**地域が入らない**（＝実測で起きていた）。
             *   → **本当に開いたかを確かめる**（区・町字・都道府県のどれかが出ているか）。
             *     出ていなければ**別の手で押し直す**（クラス名 → 親をたどる → 座標でクリック）。
             */
            (function _ensureAreaOpened(tries) {
              var n = tries || 0;
              var opened = function () {
                try {
                  return !!(document.querySelector('label.one_city, label.one_town, input[name="city_code[]"], input[name="pref_code"]'));
                } catch (_) { return false; }
              };
              if (opened()) {
                if (n) console.log('[AX] 所在地絞り込みが開きました（押し直し' + n + '回）');
                if (_audit && n) _auditStepP('area_open_retry', n + '回で開いた');
                return;
              }
              /**
               * 2026-11-14 竹内さん「この地域押すところ…ちゃんと学習する」:
               *   ⚠ 押し方を「学んだ位置へカーソルを動かしてから押す」（`_pressLearned`）に変えたので、
               *     **押し終わるまで 200〜900ms かかる**。旧のまま「すぐ確かめる」だと
               *     まだ動いている途中で「開いていない」と判断し→**もう一度押す**→
               *     モーダルが開いてすぐ閉じる（トグル）＝**地域が入らない**。
               *   → 最初は**押し終わるのを待つ**（grace）。それでも開かなければ押し直す。
               */
              var grace = n === 0 ? 1400 : 900 + Math.floor(Math.random() * 400);
              if (n >= 3) {
                console.warn('[AX] 所在地絞り込みが開きません（3回試しました）');
                if (_audit) _auditStepP('area_open_fail', '3回試しても開かない');
                return;
              }
              // 押し直す: ① 場所の帯の中で「所在地絞り込み」を含む一番内側
              setTimeout(function () {
                if (opened()) { if (_audit) _auditStepP('area_open_retry', '待って開いた'); return; }
                try {
                  var all = Array.prototype.slice.call(document.querySelectorAll('div,span,a,button,td,p'));
                  var cand = all.filter(function (e) {
                    if (!isVisible(e)) return false;
                    var t = e.textContent.replace(/\s+/g, '');
                    if (!t.includes('所在地絞り込み')) return false;
                    if (/沿線・駅絞り込み|管理会社絞り込み/.test(t)) return false;
                    // 子に同じ物があれば親（内側だけ残す）
                    return !all.some(function (o) { return o !== e && e.contains(o) && o.textContent.replace(/\s+/g, '').includes('所在地絞り込み'); });
                  });
                  if (cand.length) {
                    console.log('[AX] 所在地絞り込みを押し直します（' + (n + 1) + '回目）');
                    _pressLearned(cand[0], ['左の所在地絞り込み', '所在地絞り込み＋', '所在地絞り込み'], 'area_open_retry');
                  }
                } catch (_) {}
                setTimeout(function () { _ensureAreaOpened(n + 1); }, 900 + Math.floor(Math.random() * 400));
              }, grace);
            })(0);
            /**
             * 2026-11-14 竹内さん「地域の部分はいる前から地域だけ選択されていた」:
             *   ⚠ 前の検索で選んだ区・町字が**モーダルに残ったまま**開く事がある
             *     （リアプロは前の選択を保持する）。そのまま押すと
             *     「頼んでいない区も入る」「前の区が残る」＝条件が濁る。
             *   → モーダルを開いた直後に、**選択済みの区・町字を全部外す**（1つずつ・人と同じ速さ）。
             *     ⚠ 外すのは**このモーダルの中だけ**（左のサイドバーの検索条件は _doReset が担当）。
             *
             * 2026-11-14 竹内さん「地域の部分ちゃんと１つずつマウスを動かしてクリックしてせんたくする。
             *   今自動的に反映されてしまっている場面がある」
             *   「徒歩選択したあとに、選択までできたが自動で消してしまっている」:
             *
             *   ⚠ **ここが原因だった**。旧は「開いた直後に選択済みを全部外す」だったので、
             *     **人が自分で選んだ区まで消していた**（＝自動で反映されてしまう／選んだのに消える）。
             *     さらに `_clearBeforeOpen` も**モーダルを開く前**に全部外していたので、二重に消していた。
             *
             *   → **自動で入れる前に、こちらが入れた物だけ外す**（人が選んだ物は残す）。
             *     ・`window.__axAutoPicked`（この回で自動が入れた値）を覚えておき、
             *       **その値だけ**外す。人が選んだ物は触らない。
             *     ・覚えが無い（＝前のお客様の残り）時は**全部外す**（今まで通り・条件の濁りを防ぐ）。
             */
            (function _clearPrevAreaSelection() {
              try {
                var _cityOn = Array.prototype.slice.call(document.querySelectorAll('input[name="city_code[]"]:checked'));
                var _townOn = Array.prototype.slice.call(document.querySelectorAll('input[name="town_code[]"]:checked'));
                var _all = _cityOn.concat(_townOn);
                if (!_all.length) return;
                /**
                 * 人が選んだ物は残す。`__axAutoPicked` があればその値だけ外す。
                 *   ⚠ 覚えが無い時は今まで通り全部外す（前のお客様の残りを消す）。
                 */
                var _auto = window.__axAutoPicked;
                var _autoSet = null;
                try {
                  if (_auto && typeof _auto === "object") {
                    _autoSet = {};
                    ["city", "town"].forEach(function (k) {
                      (Array.isArray(_auto[k]) ? _auto[k] : []).forEach(function (v) { _autoSet[k + ":" + String(v)] = true; });
                    });
                  }
                } catch (_) { _autoSet = null; }
                if (_autoSet) {
                  var _before = _all.length;
                  _all = _all.filter(function (cb) {
                    var nm = String(cb.name || "");
                    var kind = nm.indexOf("town_code") >= 0 ? "town" : "city";
                    return !!_autoSet[kind + ":" + String(cb.value)];
                  });
                  if (_all.length < _before) {
                    if (_audit) _auditStepP('area_keep_human', (_before - _all.length) + '件は人が選んだので残す');
                  }
                }
                if (!_all.length) return;
                if (_audit) _auditStepP('area_prev_clear', _all.length + '件を外す（自動で入れた物）');
                console.log('[AX] 自動で入れた地域を外します:', _all.length, '件（人が選んだ物は残します）');
                _all.forEach(function (cb) {
                  try {
                    /**
                     * ⚠ 2026-11-14: `simulateClick` は**トグル**なので、既にcheckedの物を押すと
                     *   外れるが、タイミング次第で二重押しになる。**checked を直接 false にして
                     *   change を送る**方が確実（画面も同じ状態になる）。
                     */
                    if (cb.checked) {
                      cb.checked = false;
                      cb.dispatchEvent(new Event("change", { bubbles: true }));
                    }
                  } catch (_) {}
                });
              } catch (_) {}
            })();
            // STEP2+3を統合: 市区郡直接クリックと大阪府クリックを同時にポーリング
            // ケースA: モーダルが市区郡ページ表示中 → 大阪府をスキップして市区郡を直接クリック
            // ケースB: モーダルが都道府県ページ表示中 → 大阪府をクリック
            var prefClicked = false;

            function doAfterWard() {
              console.log('[AX] STEP3完了: 市区郡クリック済 → next_step_button2 確認');
              /**
               * 2026-11-14 竹内さん「なぜか地域を都島区を押してしまっている」「検索ボタンも押していなかった」:
               *   ⚠ 旧は `clickWardPrecise()` が true を返した**直後**に `doAfterWard()` を呼んでいた。
               *     `clickWardPrecise` は**カーソルを動かしてから押す（非同期・200〜900ms）**ので、
               *     true は「押し始めた」だけ。**欲しい区が本当に入ったか確かめずに確定**していた。
               *     そのため直前に残っていた**都島区だけ**が入り、頼んだ3区が入らなかった
               *     （点検記録: `page:ward` の直後に `確定してリストへ`・
               *      `gate_retry: 場所（3区）が画面に入っていない（区 0・駅 0）`）。
               *   → **確定する前に、欲しい区が全部そろったかを確かめる**（最大8回・600ms間隔）。
               *     そろっていなければ足す。それでもだめなら**確定せずに中止**
               *     （誤った地域で検索するより、止まって理由を残す方がよい）。
               */
              (function _verifyThenConfirm(tries) {
                var n = tries || 0;
                var chk = isAllWantedWardsChosen(cond.city_codes);
                var want = (cond.city_codes || []).map(String).filter(Boolean);
                if (want.length === 0) { _auditStepP('ward', null); _afterWardConfirmed(); return; }
                if (chk.all) {
                  if (n) _auditStepP('ward_verified', n + '回目でそろった（' + want.length + '区）');
                  _auditStepP('ward', null);
                  _afterWardConfirmed();
                  return;
                }
                if (n >= 8) {
                  var msg = '地域がそろいません（欲しい' + want.length + '区・入った' + chk.checked.length + '区・足りない' + chk.missing.length + '）';
                  _auditStepP('ward_verify_fail', msg + ' 入った:[' + chk.checked.join(',') + '] 足りない:[' + chk.missing.join(',') + ']');
                  console.warn('[AX] ' + msg + ' → 誤った地域で検索しないため中止します');
                  showWarnToast(msg);
                  notifyDone('AXLX_AREA_MISMATCH: ' + msg);
                  return;
                }
                // まだそろっていない → 足す（余計は外す）
                if (n === 0) {
                  console.log('[AX] 確定前に確認: そろっていません（入った' + chk.checked.length + '・足りない' + chk.missing.length + '）→ 足します');
                }
                try {
                  chk.stale.forEach(function (code) {
                    var inp = document.querySelector('label input[name="city_code[]"][value="' + String(code) + '"]');
                    var lbl = inp && inp.closest ? inp.closest('label') : null;
                    if (lbl) simulateClick(lbl);
                  });
                } catch (_) {}
                try { if (chk.missing.length) clickWardPrecise([wardFull, wardShort]); } catch (_) {}
                setTimeout(function () { _verifyThenConfirm(n + 1); }, 620 + Math.floor(Math.random() * 260));
              })(0);
            }

            /** 地域がそろった後の流れ（今までの doAfterWard の中身） */
            function _afterWardConfirmed() {
              if (hasDetailArea) {
                // STEP3後確認: div.next_step_button2 が見えることを確認
                // 見えない場合 = 市区郡がトグルで解除された → 再クリックして再選択
                function startSTEP4() {
                  waitForClick(clickNextStepBtn,
                    function() {
                      console.log('[AX] STEP4完了: 詳細な地域へ進むクリック済 → 町字待機 detailArea:', detailAreaName);
                      _auditStepP('next_step', null);
                      // STEP5: 町字（例:「喜連西」）が出るまで待ってクリック
                      waitForClick(
                        function() {
                          var n = document.querySelectorAll('label.one_town').length;
                          console.log('[AX] STEP5 poll: label.one_town=' + n + '個 townNames:', townNamesForStep5);
                          if (n === 0) return false;
                          // 複数町字を全てクリック（townNamesForStep5 配列を順次処理）
                          var clicked = false;
                          for (var ti = 0; ti < townNamesForStep5.length; ti++) {
                            if (clickDetailArea(townNamesForStep5[ti])) clicked = true;
                          }
                          return clicked;
                        },
                        function() {
                          console.log('[AX] STEP5完了: 町字クリック済 → 閉じる待機');
                          _auditStepP('town', null);
                          waitForClick(closeAreaModal, function() {
                            console.log('[AX] STEP6完了: モーダル閉じた → 検索');
                            _auditStepP('modal_close', null);
                            setTimeout(clickSearch, 650 + Math.floor(Math.random() * 450));
                          },
                          20, 500, 500 + Math.floor(Math.random() * 350),
                          function() {
                            // 閉じるボタンが見つからなくても検索を試みる（clickSearch が必ず notifyDone）
                            console.warn('[AX] STEP6: モーダルを閉じられず → そのまま検索');
                            setTimeout(clickSearch, 650 + Math.floor(Math.random() * 450));
                          });
                        },
                        30, 500, 500 + Math.floor(Math.random() * 350),
                        function() { fallbackSearchWithoutArea('「' + townNamesForStep5.join('、') + '」の地域ボタンが見つかりませんでした。'); }
                      );
                    },
                    30, 500, 500 + Math.floor(Math.random() * 350),
                    function() { fallbackSearchWithoutArea('「詳細な地域の設定へ進む」ボタンが見つかりませんでした。'); }
                  );
                }

                // 300ms後にボタンY状態を確認してSTEP4へ
                setTimeout(function() {
                  if (isWardButtonY()) {
                    console.log('[AX] STEP3後確認: ボタンY確認 → STEP4へ');
                    startSTEP4();
                  } else {
                    console.log('[AX] STEP3後確認: N状態 → ensureWardButtonY');
                    ensureWardButtonY(startSTEP4);
                  }
                }, 240 + Math.floor(Math.random() * 160));
              } else {
                // 広げて検索: 市区郡まで選択して閉じる（詳細地域には進まない）
                waitForClick(closeAreaModal, function() {
                  setTimeout(clickSearch, 650 + Math.floor(Math.random() * 450));
                },
                20, 500, 500 + Math.floor(Math.random() * 350),
                function() {
                  console.warn('[AX] モーダルを閉じられず → そのまま検索');
                  setTimeout(clickSearch, 650 + Math.floor(Math.random() * 450));
                });
              }
            }

            // 500msごとにポーリング:
            //   最優先: city_code[]が既にchecked = 市区郡選択済み → 再クリック禁止（トグルで解除になるため）
            //   次優先: city_code[]を持つlabelを安全クリック（大阪府記憶済みケース）
            //   最後: 大阪府をクリック（初回ケース）
            waitForClick(
              function() {
                // 最優先: 既に町字ページ表示中（モーダル記憶）→ 大阪府ブレッドクラムを誤クリックしないよう先にチェック
                if (document.querySelectorAll('label.one_town').length > 0) {
                  prefClicked = false;
                  console.log('[AX] STEP2: 既に町字ページ → STEP4へ直行');
                  return true;
                }
                /**
                 * 2026-11-14 竹内さん「なぜか地域を都島区を押してしまっている。通常モードではちゃんと光るのに
                 *   ちゃんと選択できていなかった。検索ボタンも押していなかった」:
                 *
                 * ⚠ **原因はここだった**（本番の点検記録で確認）:
                 *   `isWardChecked()` は「**1区でも checked なら true**」だった。
                 *   リアプロは**前のお客様の区を残す**ので、たまたま都島区が残っていると
                 *   「もう選ばれている」と判断して **西区・北区・中央区を1つも押さずに**「確定してリストへ」へ進み、
                 *   **都島区だけ**が入った（点検記録: `page:ward` の直後に `確定してリストへ`・
                 *   `gate_retry: 場所（3区）が画面に入っていない（区 0・駅 0）`）。
                 *
                 * → 「選ばれている」の判定を **欲しい区が全部そろっているか** に変える。
                 *   `wantCodes` があればその全部が checked、無ければ今まで通り。
                 *   ⚠ 足りない区は `clickWardPrecise` が**足す**（チェック済みは押さない＝外さない）。
                 */
                var _chk = isAllWantedWardsChosen(cond.city_codes);
                var _want = (cond.city_codes || []).map(String).filter(Boolean);
                var _missing = _chk.missing;
                var _stale = _chk.stale;
                if (_chk.all) {
                  // 欲しい区が全部そろっている → 押し直さずに「確定してリストへ」へ進む
                  try {
                    if (_audit) _auditStepP('ward_already_ok', _want.length + '区すべて選択済み（押し直さない）');
                  } catch (_) {}
                  Array.prototype.slice.call(document.querySelectorAll('label input[name="city_code[]"]:checked')).forEach(function (inp) { _noteWardPicked(inp.value, ""); });
                  prefClicked = false;
                  console.log('[AX] STEP2: 欲しい ' + _want.length + '区がすべて選択済み → 選び直さず「確定してリストへ」まで進みます');
                  return true;
                }
                if (_want.length === 0 && _chk.checked.length > 0) {
                  // 期待コードが無い（検証不能）→ 従来通りスキップ
                  Array.prototype.slice.call(document.querySelectorAll('label input[name="city_code[]"]:checked')).forEach(function (inp) { _noteWardPicked(inp.value, ""); });
                  prefClicked = false;
                  return true;
                }
                /**
                 * 足りない区がある／余計な区が残っている → **足して直す**。
                 *   ・余計（前のお客様の区）は外す
                 *   ・足りない区を押す（`clickWardPrecise` はチェック済みを押さない）
                 */
                try {
                  if (_audit) {
                    _auditStepP('ward_fix', '足りない区 ' + _missing.length + '件（' + _missing.join(',') + '）・余計 ' + _stale.length + '件（' + _stale.join(',') + '）');
                  }
                } catch (_) {}
                console.log('[AX] STEP2: 地域を選び直します（足りない ' + _missing.length + '件・余計 ' + _stale.length + '件）');
                _stale.forEach(function (code) {
                  try {
                    var inp = document.querySelector('label input[name="city_code[]"][value="' + String(code) + '"]');
                    var lbl = inp && inp.closest ? inp.closest('label') : null;
                    if (lbl) enqueueHumanClick(lbl, function (el) { simulateClick(el); }, 420, 1000); // トグルで解除（順次）
                  } catch (_) {}
                });
                /**
                 * ⚠ 市区郡のラベルがまだ描画されていない（都道府県ページに居る）時は
                 *   **大阪府を押して**市区郡ページへ進む（ここを飛ばすと永久に待つ）。
                 */
                if (_missing.length && clickWardPrecise([wardFull, wardShort])) { prefClicked = false; return true; }
                if (clickByText(['大阪府'])) { prefClicked = true; return true; }
                return false; // 市区郡ラベル未描画 → 次ポーリングで再試行
                return false;
              },
              function() {
                if (!prefClicked) {
                  // 市区郡選択済みOR直接クリック完了 → 次のステップへ
                  doAfterWard();
                } else {
                  // 大阪府クリック後 → 市区郡ページへ遷移を待ってクリック
                  waitForClick(
                    function() { return clickWardPrecise([wardFull, wardShort]); },
                    doAfterWard,
                    30, 500, 500 + Math.floor(Math.random() * 350),
                    function() { fallbackSearchWithoutArea('「' + wardFull + '」の市区郡ボタンが見つかりませんでした。'); }
                  );
                }
              },
              30, 500, 500 + Math.floor(Math.random() * 350),
              function() { fallbackSearchWithoutArea('大阪府または市区郡の選択ができませんでした。'); }
            );
          },
          30, 500, 500 + Math.floor(Math.random() * 350),
          function() { fallbackSearchWithoutArea('「所在地絞り込み」ボタンが見つかりませんでした。'); }
        );
      } else {
        // area && !hasModalWard: 直接チェック（T=150ms）反映後に検索（none は上で処理済み）
        setTimeout(function() { clickSearch(); }, 600 + Math.floor(Math.random() * 300));
      }
      return;
    }

    // ── ここから locationMode === "station" || "route" ──────────────────────
    // 駅+地域併記時: リアプロはAND条件になるため地域条件は捨てる（仕様維持）が、
    // 黙って捨てず必ず可視化する
    if ((locationMode === "station" || locationMode === "route") &&
        (hasModalWard || hasCities)) {
      console.log("[AX] 駅/沿線条件を優先し、地域条件（" +
        (cond.detail_ward || (cond.city_codes || []).join(",")) + "）はスキップ");
      showWarnToast("駅条件を優先し、地域条件はスキップしました。");
    }

    // 沿線 form state を事前セット（駅指定なしの場合のみ。駅指定ありはモーダル内で完結させる）
    if (hasRoutes && !hasStation) {
      // ★ 修正(Bug2): 上流（popup.js等）が駅名を station_names に入れ損ねると
      // ここで「沿線は選択・駅は未選択」のまま黙って検索される（Bug2の症状そのもの）。
      // サイレントに進めず必ず可視化する
      console.warn('[AX] ⚠️ 沿線のみ検索（駅指定なし）: route_ids=' + (cond.route_ids || []).join(',') +
        ' / station_names が空です。上流の駅名解決を確認してください');
      showWarnToast('沿線のみで検索します（駅指定なし）');
      setCheckboxes("route_id[]", cond.route_ids);
    }

    // 沿線・駅モーダル：waitForClick方式（必ず駅が選択されるまでリトライ）
    function closeStationModal() {
      /**
       * 2026-11-11 竹内さん「駅の場合は 1沿線・駅絞り込み 2該当する沿線 3駅の設定へ進む 4該当する駅 5確定してリストへ」
       *
       * ⚠ 旧は `div.this_window_close`（×とじる）を**先に**押していた。
       *   画像の画面には「×とじる」と「確定してリストへ」の**両方**がある。
       *   **×は閉じるだけ**で、選んだ駅がサイトに反映されない事がある。押すべきは**確定してリストへ**。
       * → 順番を逆にして、**まず「確定してリストへ」**を押す。無い時だけ ×／とじる。
       */
      var conf = _findByText(['確定してリストへ', 'この条件で絞り込む', '決定']);
      if (conf) {
        if (_audit) _auditStepP('station_confirm', '確定してリストへ');
        _humanPointerClick(conf, function () { try { conf.click(); } catch (_) {} });
        return true;
      }
      var d = document.querySelector('div.this_window_close');
      if (d && isVisible(d)) {
        if (_audit) _auditStepP('station_confirm', '×とじる（確定が見つからない）');
        _humanPointerClick(d, function () { try { d.click(); } catch (_) {} });
        return true;
      }
      return clickByText(['×とじる', '× とじる', 'とじる']);
    }

    // 沿線・駅モーダル操作がタイムアウトした場合のフォールバック:
    // 全件検索（エリアなし）を送信するのは誤物件LINE送信の原因になるためnotifyDone(error)で中止する。
    // fallbackSearchWithoutArea と同じ方針: エリア条件が解決できない場合は検索しない。
    function fallbackSearchWithoutStation(msg) {
      var errMsg = '沿線・駅モーダル操作失敗（全件検索防止のため中止）: ' + msg;
      // 2026-11-10 v2.6.7 竹内さん「そのような失敗あれば原因を追いかけていく」:
      //   失敗した時に「その場の画面がどうだったか」を点検に残す（次に同じ失敗が起きた時に原因を特定できるように）。
      //   画面には触らない（読むだけ・読み込み直しもしない）
      try {
        var _diag = {
          modal: (function () {
            var d = document.querySelector('.this_window, .modal, [role="dialog"]');
            return d ? { visible: isVisible(d), text: String(d.textContent || '').replace(/\s+/g, '').slice(0, 160) } : null;
          })(),
          one_line: document.querySelectorAll('label.one_line').length,
          one_line_vis: Array.prototype.slice.call(document.querySelectorAll('label.one_line')).filter(isVisible).length,
          station_inputs: document.querySelectorAll('input[name="station_id[]"]').length,
          station_vis_parents: Array.prototype.slice.call(document.querySelectorAll('input[name="station_id[]"]')).filter(function (i) { return i.parentElement && isVisible(i.parentElement); }).length,
          buttons: Array.prototype.slice.call(document.querySelectorAll('div,a,button,span'))
            .filter(function (e) { return isVisible(e) && /絞り込み|駅の設定|確定/.test(String(e.textContent || '')); })
            .map(function (e) { return String(e.textContent || '').replace(/\s+/g, '').slice(0, 24); }).slice(0, 8),
          queue: _clickQueue.length,
          vis: document.visibilityState,
        };
        _auditStepP('station_modal_fail_diag', JSON.stringify(_diag).slice(0, 500));
      } catch (_) {}
      _auditStepP('station_modal_fail', msg);
      showWarnToast(errMsg);
      try { closeStationModal(); } catch (e) { /* ignore */ }
      notifyDone(errMsg);
    }

    // STEP A: 「沿線・駅絞り込み＋」が出るまで待ってクリック
    waitForClick(
      function() {
        var clsTargets = ['click_menu', 'one_slide_search_box'];
        for (var ci = 0; ci < clsTargets.length; ci++) {
          var divs = Array.prototype.slice.call(document.querySelectorAll('div.' + clsTargets[ci]));
          for (var i = 0; i < divs.length; i++) {
            if (!isVisible(divs[i])) continue;
            var t = divs[i].textContent.replace(/\s+/g, '');
            if (t.includes('沿線・駅絞り込み')) {
              // 2026-11-14 竹内さん「この地域押すところ…ちゃんと学習する」: 駅の絞り込みも学んだ位置で押す
              _pressLearned(divs[i], ['左の沿線・駅絞り込み', '沿線・駅絞り込み＋', '沿線・駅絞り込み'], 'station_open');
              return true;
            }
          }
        }
        return clickByText(['沿線・駅絞り込み＋', '沿線・駅絞り込み+', '沿線・駅絞り込み']);
      },
      function() {
        /**
         * 2026-11-13 竹内さん「沿線絞り込みの部分はどうなっているか。抜けていないのか」:
         *   駅の**最初の段（沿線・駅絞り込みを開く）**が段に残っていなかった
         *   （`station_confirm` と `station_next_press` だけ）。
         *   → 学習で「駅の手順」を学べるように、開いた事を残す。
         */
        try { _auditStepP('station', '沿線・駅絞り込みを開く'); } catch (_) {}
        // STEP B: 路線ボタン（label.one_line）が描画されたらクリック
        var stationPageDirect = false;
        // 2026-11-11: 「駅の設定へ進む」を押した印（押し直さない・押し終わるまで次へ進まない）
        var _stationNextPressed = false;
        waitForClick(
          function() {
            var labels = Array.prototype.slice.call(document.querySelectorAll('label.one_line'));
            var vis = labels.filter(function(l) { return isVisible(l); });
            if (!vis.length) {
              // 駅ページが直接表示されている場合（事前選択済みルートでモーダルが駅一覧を直接表示）
              // input[name="station_id[]"] はhidden checkboxのためisVisibleで不可視→親ラベルで判定
              var stationInputs = Array.prototype.slice.call(document.querySelectorAll('input[name="station_id[]"]'));
              var visStationParents = stationInputs.filter(function(i) {
                return i.parentElement && isVisible(i.parentElement);
              });
              if (visStationParents.length) {
                console.log('[AX] STEP B: 駅ページが直接表示(親label可視) → stationPageDirect=true');
                stationPageDirect = true;
                return true;
              }
              return false; // まだ描画されていない
            }
            // ★ 修正: 前顧客の路線選択残留をクリア（モーダルのJS内部状態）
            // _doReset のフォームDOM操作では消えないため、モーダル表示中に直接クリック解除する
            // ※ クリックがキュー化され非同期になったため、今回選択予定の路線は解除しない
            //   （解除クリックが後から実行されて選択が消える事故の防止。checked済みは
            //    clickLineButtons 側が再クリックしないのでそのまま活きる）
            var wantedLineNorms = (hasRoutes ? cond.route_ids : []).map(function(id) {
              return ROUTE_LINE_MAP[id] ? norm(ROUTE_LINE_MAP[id]) : null;
            }).filter(Boolean);
            vis.forEach(function(lbl) {
              var cb = lbl.querySelector('input[type="checkbox"]');
              if (!cb || !cb.checked) return;
              var lNorm = norm(lbl.textContent);
              var keep = wantedLineNorms.some(function(w) {
                return w === lNorm || (lNorm.length >= 4 && w.endsWith(lNorm));
              });
              if (!keep) enqueueHumanClick(cb, _clickEl, 450, 1000);
            });
            /**
             * 2026-11-11 竹内さん「なんでh.rさん沿線選択されずにとまってしまうのか」:
             *   ⚠ `clickLineButtons` は**クリックの列（非同期）**に積むだけなので、
             *     ここで `return true` すると**路線が押される前に次の段（駅の設定へ進む）へ進んでいた**。
             *     → 路線が本当に checked になるまで待つ（最大 _modalTry 回）。
             *     ・目標の路線が1つでも checked になったら次へ
             *     ・まだなら false を返して、同じ段をもう一度見る（押し直しは clickLineButtons が checked を見て避ける）
             */
            if (hasRoutes) clickLineButtons(cond.route_ids);
            /**
             * 2026-11-13 竹内さん「沿線絞り込みの部分はどうなっているか」:
             *   路線を押す段も残す（学習で「沿線 → 駅へ進む」の順を学べるように）。
             *   ⚠ 路線の名前は入れない（段の名前だけ）。
             */
            try { _auditStepP('station_line', '沿線を選ぶ'); } catch (_) {}
            var _lineOk = !hasRoutes ? true : (function () {
              var want = (cond.route_ids || []).map(function (id) { return ROUTE_LINE_MAP[id]; }).filter(Boolean).map(norm);
              if (!want.length) return true;
              var nowChecked = Array.prototype.slice.call(document.querySelectorAll('label.one_line'))
                .filter(isVisible)
                .filter(function (l) { var c = l.querySelector('input[type="checkbox"]'); return c && c.checked; })
                .map(function (l) { return norm(l.textContent); });
              return nowChecked.some(function (n) {
                return want.some(function (w) { return w === n || (n.length >= 4 && w.endsWith(n)); });
              });
            })();
            if (!_lineOk) {
              // まだ路線が入っていない（クリックの列の途中）→ この段をもう一度
              return false;
            }
            return true;
          },
          function() {
            // STEP C: 「駅の設定へ進む」が出るまで待ってクリック
            waitForClick(
              function() {
                if (stationPageDirect) { console.log('[AX] STEP C: 駅ページ直接表示 → スキップ'); return true; }
                /**
                 * 2026-11-11 竹内さん「駅の部分も駅の設定へ進むへ画面が移動して押されていなかった」:
                 *   旧は clickByText の戻り値（true）だけで「押せた」と見て、すぐ次の段（駅の選択）へ進んでいた。
                 *   だがカーソルを動かしてから押すので、**押し切る前に次の段が動き**、駅ページへ移る前に
                 *   駅を探し始めて失敗していた。
                 *   → 押したら **押し終わるまで待ってから**「押せた」と返す（押し直さない）。
                 */
                if (_stationNextPressed) {
                  if (_pressBusy > 0) return false;      // まだカーソルが動いている／押している最中
                  // 2026-11-11: 押した直後に「駅ページに移ったか」も見る（移っていなければもう一度押す）
                  if (document.querySelectorAll('label.one_line').length > 0 &&
                      document.querySelector('div.this_window_close') &&
                      !document.querySelectorAll('input[name="station_id[]"]').length) {
                    _stationNextPressed = false;         // まだ路線の一覧のまま → もう一度押す
                    return false;
                  }
                  return true;                            // 押し終わった → 次の段（駅の選択）へ
                }
                if (_pressBusy > 0) return false;
                if (clickByText(['駅の設定へ進む', '駅の設定へ進む›', '駅の設定へ進む>'])) {
                  _stationNextPressed = true;
                  if (_audit) _auditStepP('station_next_press', '駅の設定へ進む');
                }
                return false;
              },
              function() {
                // 残留解除クリック用: 実行時点で checked のときだけクリックする
                // （モーダル内inputとフォーム側inputが同期している場合の二重トグル事故防止）
                var _unclickIfChecked = function(el) { if (el.checked) _clickEl(el); };
                if (!hasStation) {
                  // ★ 修正: 駅指定なし → 前顧客の駅残留を全解除してから閉じて検索
                  // 旧実装はクリアせず閉じていたため、同一沿線の前顧客の駅が
                  // 「沿線のみ検索」に混入するバグがあった
                  var _closeAndSearch = function() {
                    waitForClick(closeStationModal, function() { setTimeout(clickSearch, 700 + Math.floor(Math.random() * 400)); },
                      20, 500, (500 + Math.floor(Math.random() * 500)),
                      function() {
                        console.warn('[AX] 沿線モーダルを閉じられず → そのまま検索');
                        setTimeout(clickSearch, 700 + Math.floor(Math.random() * 400));
                      });
                  };
                  waitForClick(
                    function() {
                      // 駅リストが描画されるまで短時間待ってから残留を全解除
                      if (!document.querySelectorAll('input[name="station_id[]"]').length) return false;
                      Array.prototype.slice.call(document.querySelectorAll('input[name="station_id[]"]:checked'))
                        .forEach(function(inp) { enqueueHumanClick(inp, _unclickIfChecked, 450, 1000); });
                      return true;
                    },
                    _closeAndSearch,
                    6, 500, _hd(300),
                    _closeAndSearch // 駅リストが描画されない場合は従来どおりそのまま閉じて検索
                  );
                  return;
                }
                var stNamesStr = (cond.station_names || []).join('・');
                // 「梅田まで電車1本」（popup.js resolveDirectCommute）: 選んだ沿線の駅をすべて選択する。
                // 駅ページには選んだ沿線の全駅が出る（拡張の路線駅マップより網羅的）ので、見えている駅を全部チェックする。
                // 前回試行から選択数が増えない（サイト側の選択上限等）ときは選べた駅で進める（全件検索にはしない）。
                var _selAllPrevChecked = -1;
                // 2026-09-29 v2.5.39 通勤の到達時間で選んだ多数の駅: サイト側の選択上限などで増えなくなったら選べた駅で進む（全件検索にはしない）
                var _cmPrevChecked = -1, _cmStall = 0;
                function selectAllLineStations() {
                  var inputs = Array.prototype.slice.call(document.querySelectorAll('input[name="station_id[]"]'))
                    .filter(function(inp) { return inp.parentElement && isVisible(inp.parentElement); });
                  if (!inputs.length) return false;
                  var unchecked = inputs.filter(function(inp) { return !inp.checked; });
                  var checkedCount = inputs.length - unchecked.length;
                  if (!unchecked.length) {
                    console.log('[AX] STEP D(電車1本): 沿線の全' + inputs.length + '駅を選択');
                    return true;
                  }
                  if (checkedCount > 0 && checkedCount === _selAllPrevChecked) {
                    console.warn('[AX] STEP D(電車1本): ' + checkedCount + '/' + inputs.length + '駅で選択が止まった → 選べた駅で検索');
                    showWarnToast('沿線の駅を' + checkedCount + '/' + inputs.length + '駅選択しました');
                    return true;
                  }
                  _selAllPrevChecked = checkedCount;
                  // 2026-11-10 v2.5.96 竹内さん「駅も一気に選択してしまう部分がのこっている」
                  // 2026-11-10 v2.5.97 竹内さん「20駅ごとにというかランダムに人間のように」:
                  //   旧は 20駅ごとに必ず一息（等間隔＝機械らしい）。人が駅の一覧を上から見て1つずつ押す形にする。
                  //    ・1駅ごとの間は 320〜900ms（対数正規・毎回ちがう）
                  //    ・**毎回 10% の確率**で「一覧を目で追う」一息 900〜2600ms（何駅目かは決めない＝ランダム）
                  //    ・さらに **3%** で「少し手が止まる」長めの間 2.6〜5.5秒（疲れ・考え込み）
                  //   駅数が増えても一息の位置が偏らないので、サイトへの負荷も読みの速さも人に近い
                  unchecked.forEach(function(inp) {
                    var _base = 320 + Math.floor(Math.random() * 300); // 320〜620ms
                    var _gap = humanRand(_base, _base + 280) + _stationBreath();
                    enqueueHumanClick(inp, _clickIfUnchecked, _gap, _gap + 60);
                  });
                  return false;
                }
                // STEP D: 駅ページが描画され、かつ指定駅が選択されるまでリトライ
                waitForClick(
                  function() {
                    // ★ 診断ログ（初回のみ）: DOM上の全checkbox/radio input名を記録
                    // station_id[] ガードの前に実行し、0件のときも必ずログが出るようにする
                    if (!window._axStDiagDone) {
                      window._axStDiagDone = true;
                      var _stCodeCount = document.querySelectorAll('input[name="station_id[]"]').length;
                      var _allChk = Array.prototype.slice.call(document.querySelectorAll('input[type="checkbox"], input[type="radio"]'));
                      var _nameMap = {};
                      _allChk.forEach(function(inp) {
                        var n = inp.getAttribute('name') || '(no-name)';
                        if (!_nameMap[n]) { _nameMap[n] = { count: 0, sample: '' }; }
                        _nameMap[n].count++;
                        if (!_nameMap[n].sample) {
                          var p = inp.parentElement;
                          _nameMap[n].sample = p ? p.textContent.replace(/\s+/g, '').slice(0, 20) : '';
                        }
                      });
                      console.log('[AX] DIAG station_id[] count:', _stCodeCount, '| all input names:', JSON.stringify(_nameMap));
                      var _allLbls = Array.prototype.slice.call(document.querySelectorAll('label'));
                      var _visLblSamples = _allLbls.filter(function(l) { return isVisible(l); }).slice(0, 12).map(function(l) { return '"' + l.textContent.replace(/\s+/g, '').slice(0, 20) + '"'; });
                      console.log('[AX] DIAG visible labels:', _visLblSamples.join(', '));
                    }
                    // ★ 修正: 駅リスト（station_id[]）が実際にDOMへ載るまで待つ
                    // input[name="station_id[]"] の親要素が可視になるまでポーリング
                    // （旧: station_code[] = 常に0件でSTEP D全失敗）
                    var _stIdInputs = Array.prototype.slice.call(document.querySelectorAll('input[name="station_id[]"]'));
                    if (!_stIdInputs.length) return false;
                    var _visStParents = _stIdInputs.filter(function(inp) { return inp.parentElement && isVisible(inp.parentElement); });
                    if (!_visStParents.length) return false; // 駅セクションがまだ描画されていない
                    if (cond.select_all_line_stations) return selectAllLineStations();
                    var labels = Array.prototype.slice.call(document.querySelectorAll('label'));
                    var vis = labels.filter(function(l) { return isVisible(l); });
                    // ★ 修正: 前顧客のモーダル残留選択を「毎パス」クリアする
                    // リアプロのモーダルは独自JS内部状態を持ち _doReset のフォームDOM操作では消せない。
                    // さらに遅延描画・内部状態からの復元で後から checked が現れるため、
                    // 一回限りフラグ（旧 _modalStationsCleared）は空振り→永久ロックの原因だった。
                    // 冪等性: :checked のみ対象 ＋ __axPending ＋ _unclickIfChecked（実行時checkedガード）
                    // ※ 今回選択予定の駅は解除しない（解除クリックが後から実行されて選択が消える事故の防止）
                    var _wantedStCleans = (cond.station_names || []).map(function(sn) {
                      return sn.replace(/駅$/, '').trim();
                    });
                    Array.prototype.slice.call(document.querySelectorAll('input[name="station_id[]"]:checked'))
                      .filter(function(inp) {
                        var ptxt = ((inp.parentElement && inp.parentElement.textContent) || '').replace(/\s+/g, '').replace(/駅$/, '');
                        // 温存判定は selectStationsByName の選択条件（完全一致・双方向前方一致）と揃える
                        // 旧実装の双方向includesは「今回駅名と部分一致する前回駅」を温存する穴があった
                        return !_wantedStCleans.some(function(c) {
                          return ptxt === c ||
                            (ptxt.length >= 2 && c.length >= 2 && (ptxt.startsWith(c) || c.startsWith(ptxt)));
                        });
                      })
                      .forEach(function(inp) { enqueueHumanClick(inp, _unclickIfChecked, 450, 1000); });
                    selectStationsByName(cond.station_names);
                    // ★ 修正: 指定駅が「すべて」チェックされたか確認
                    // 旧実装の .some() は1駅（前顧客の残留チェックでも可）で通過してしまい、
                    // 複数駅指定時に残りが未選択のまま検索されるバグがあった。
                    // DOM上にマッチするlabelが1つも無い駅（表記ゆれ等）は判定から除外し、
                    // 全滅時は false → maxTries超過で fallbackSearchWithoutStation が中止する
                    var _checkedCount = 0;
                    var _allMatchedChecked = (cond.station_names || []).every(function(sn) {
                      var clean = sn.replace(/駅$/, '').trim();
                      var matched = false, ok = false;
                      vis.forEach(function(l) {
                        var txt = l.textContent.replace(/\s+/g, '').replace(/駅$/, '');
                        // ★ 修正(Bug2): 双方向includesだと「新大阪」の検証に「大阪」ラベルが混入し、
                        // 別駅のchecked（前顧客残留等）で誤って検証通過するため、
                        // 残留クリア側・selectStationsByNameと同じ「完全一致 or 双方向前方一致」に統一
                        if (txt !== clean &&
                            !(txt.length >= 2 && clean.length >= 2 &&
                              (txt.startsWith(clean) || clean.startsWith(txt)))) return;
                        var inp = l.querySelector('input[type="checkbox"]');
                        if (!inp && l.htmlFor) inp = document.getElementById(l.htmlFor);
                        if (!inp) { matched = true; return; } // ★ B5修正: label一致でもinp=nullなら matched=true/ok=false → 安全側で失敗
                        matched = true;
                        if (inp.checked) ok = true;
                      });
                      if (matched && ok) _checkedCount++;
                      return !matched || ok;
                    });
                    // フォールバック検証: ラベルに checkbox が紐づかない構造でも確認できる
                    // （ラベルがあっても inp=null の場合 matched=false のまま _checkedCount が増えない問題を解消）
                    // station_code[] を全件走査して親テキストと照合し、
                    // モーダルに存在しない駅名（堀江等の地域名）はスキップ（=通過扱い）
                    if (_checkedCount === 0) {
                      var _allSt = Array.prototype.slice.call(document.querySelectorAll('input[name="station_id[]"]'));
                      if (_allSt.length > 0) {
                        var _fbCount = 0;
                        var _fbOk = (cond.station_names || []).every(function(sn) {
                          var clean = sn.replace(/駅$/, '').trim();
                          var inModal = false, isChecked = false;
                          _allSt.forEach(function(inp) {
                            var p = inp.parentElement;
                            var ptxt = p ? p.textContent.replace(/\s+/g, '').replace(/駅$/, '') : '';
                            if (!ptxt) return;
                            if (ptxt === clean || (ptxt.length >= 2 && clean.length >= 2 &&
                                (ptxt.startsWith(clean) || clean.startsWith(ptxt)))) {
                              inModal = true;
                              if (inp.checked) isChecked = true;
                            }
                          });
                          if (!inModal) return true; // 駅モーダルに存在しない名前（地域名等）はスキップ
                          if (isChecked) _fbCount++;
                          return isChecked;
                        });
                        if (_fbOk && _fbCount >= 1) {
                          console.log('[AX] STEP D: input-based検証成功: ' + _fbCount + '駅確認');
                          _checkedCount = _fbCount;
                          _allMatchedChecked = true;
                        }
                      }
                    }
                    if (cond.commute && !_allMatchedChecked && _checkedCount >= 1) {
                      if (_checkedCount === _cmPrevChecked && ++_cmStall >= 3) {
                        console.warn("[AX] STEP D(通勤の到達時間): " + _checkedCount + "/" + (cond.station_names || []).length + "駅で選択が止まった → 選べた駅で検索");
                        showWarnToast("通勤の駅を" + _checkedCount + "/" + (cond.station_names || []).length + "駅選択しました");
                        _auditStepP("commute_stall", _checkedCount + "/" + (cond.station_names || []).length);
                        return true;
                      }
                      if (_checkedCount !== _cmPrevChecked) _cmStall = 0;
                      _cmPrevChecked = _checkedCount;
                    }
                    return _allMatchedChecked && _checkedCount >= 1;
                  },
                  function() {
                    // STEP E: 駅が選択された → モーダルを閉じる
                    waitForClick(closeStationModal, function() {
                      // STEP F: 検索実行（駅が確定してから）
                      setTimeout(clickSearch, 700 + Math.floor(Math.random() * 400)); // 700-1100ms human-like jitter
                    },
                    20, 500, (500 + Math.floor(Math.random() * 500)),
                    function() {
                      console.warn('[AX] 駅モーダルを閉じられず → そのまま検索');
                      setTimeout(clickSearch, 700 + Math.floor(Math.random() * 400));
                    });
                  },
                  _modalTry(), _modalRetryMs(), (600 + Math.floor(Math.random() * 700)),
                  function() { fallbackSearchWithoutStation('指定の駅が選択できませんでした。\n駅: ' + stNamesStr); }
                );
              },
              _modalTry(), _modalRetryMs(), (600 + Math.floor(Math.random() * 700)),
              function() { fallbackSearchWithoutStation('「駅の設定へ進む」ボタンが見つかりませんでした。'); }
            );
          },
          _modalTry(), _modalRetryMs(), (600 + Math.floor(Math.random() * 700)),
          function() { fallbackSearchWithoutStation('路線一覧が表示されませんでした。'); }
        );
      },
      _modalTry(), _modalRetryMs(), (600 + Math.floor(Math.random() * 700)),
      function() { fallbackSearchWithoutStation('「沿線・駅絞り込み」ボタンが見つかりませんでした。'); }
    );

    } catch (err) {
      // 本体の同期例外（不正な条件データ等）でも fill-done を必ず送る
      console.error('[AX] fillRealpro 本体例外 → fill-done送信', err);
      notifyDone('fillRealpro: ' + ((err && err.message) || String(err)));
    }
    }, 0); // _doReset内で待機済みのため即時実行
    }); // 考える間（_waitThinkThenFill）end
    }); // _doReset end
  }

  // ── axlx-realpro-freeword-search: フリーワード検索ハンドラー ────────────────
  // background.js が executeScript 経由で送った postMessage を受けて
  // フリーワード入力 → 検索クリック を行う。
  // 結果行スキャンは AJAX 更新の場合のみ担当（ページ遷移した場合は background.js が引き継ぐ）
  window.addEventListener("message", function(e) {
    if (!e.data || e.data.from !== "axlx-realpro-freeword-search") return;
    var _fwPropName = (e.data.propertyName || "").trim();
    var _fwRoomNum  = (e.data.roomNumber   || "").trim();

    window.__axlxEstimateSearchResult = undefined;

    // ── フリーワード入力欄を探す ─────────────────────────────────────────────
    // DevTools調査済み（2026-08-11）: リアプロ main.php の実DOM確認
    // index 30: type="search" name="keyword" → これが正しいフリーワード欄
    var _FW_SELECTORS = [
      'input[name="keyword"]',
      'input[type="search"]',
      'input[name="free_word"]',
      'input[name="freeword"]',
      'input[name="building_name"]',
      'input[name="search_word"]',
      '#free_word',
      '#freeword',
      'input[placeholder*="フリーワード"]',
      'input[placeholder*="物件名"]',
      'input[placeholder*="建物名"]',
    ];

    var _fwInput = null;
    for (var _si = 0; _si < _FW_SELECTORS.length; _si++) {
      _fwInput = document.querySelector(_FW_SELECTORS[_si]);
      if (_fwInput) break;
    }

    if (!_fwInput) {
      window.__axlxEstimateSearchResult = {
        ok: false,
        error: "フリーワード入力欄が見つかりません（DevToolsで document.querySelectorAll('input[type=text]') を実行してセレクターを確認してください）",
      };
      return;
    }

    // ── 物件名をセット ────────────────────────────────────────────────────────
    _fwInput.focus();
    _fwInput.value = _fwPropName;
    // React / Vue 等のバインディングにも対応するため複数イベントを発火
    ["input", "change", "keyup"].forEach(function(ev) {
      _fwInput.dispatchEvent(new Event(ev, { bubbles: true }));
    });

    // ── 検索ボタンをクリック（page-script.js 既存の clickSearch セレクターを流用）──
    // div.go_search は DevTools 診断済みの確定セレクター
    // 2026-11-11 竹内さん「検索のボタンはこのように2か所ある」: 小窓の中の「検索」は押さない（左のサイドバーを優先）
    var _fwInModal = function (el) {
      try { return !!(el.closest && el.closest('.this_window, [role="dialog"], .modal, #modal, .modal_wrap')); } catch (_) { return false; }
    };
    var _fwCand = Array.prototype.slice.call(document.querySelectorAll("div.go_search, div.go_search_submit"))
      .filter(function (d) { return !_fwInModal(d); });
    var _fwBtn =
      _fwCand[0] ||
      (function() {
        var candidates = Array.from(document.querySelectorAll("button, input[type='submit'], div[onclick], a"))
          .filter(function (el) { return !_fwInModal(el); });
        return candidates.find(function(el) {
          var t = (el.textContent || el.value || "").trim();
          return ["住居検索", "検索", "物件を検索する", "条件で検索"].some(function(kw) { return t.includes(kw); });
        });
      })();

    if (!_fwBtn) {
      window.__axlxEstimateSearchResult = {
        ok: false,
        error: "検索ボタンが見つかりません（div.go_search が存在しない可能性があります）",
      };
      return;
    }

    // triggered フラグを立ててから検索開始
    // → background.js がこのフラグを確認して結果スキャンのポーリングを開始する
    // → ページ遷移で page-script.js が消えても background.js が独立してスキャンを継続できる
    window.__axlxEstimateSearchResult = { ok: true, triggered: true };
    if (_guideOn()) { window.__axlxEstimateSearchResult = { ok: false, error: "guide-mode: 案内モードのため検索を押さない" }; return; }
    _fwBtn.click();

    // 詳細ボタンのクリックは background.js の Step 5 が chrome.tabs.onUpdated で
    // 捕捉しながら行う。page-script.js は search triggered を通知するだけでよい。
    // （旧実装で _fwPoll/_fwScanRows がクリックすると background.js と二重クリックになるため廃止）
  });

  // 2026-09-27 v2.5.32 content.js の「page-script は生きているか」に答える（一括検索の前のタブの確かめ）
  window.addEventListener("message", function(e) {
    if (e.source !== window || !e.data || e.data.from !== "axlx-page-ping") return;
    window.postMessage({ from: "axlx-page-pong", id: e.data.id }, "*");
  });

  window.addEventListener("message", function(e) {
    if (!e.data || e.data.from !== "aixlinx-fill") return;
    // 2026-09-18 竹内（一括検索で違うお客さんの条件が送られるバグ）:
    //   「誰の自動入力か」をここで覚え、notifyDone がそのまま fill-done に載せて返す。
    //   中継側の「今の顧客」ではなく**この入力を始めた時の顧客**を返すので、遅れて届いた
    //   シグナルが次の顧客の待ちを解決することがなくなる
    _fillCustomerId = e.data.customerId || null;
    // 2026-10-01 竹内「光らせるようにする」: 案内モード（realpro-guide.js が <html data-axlx-guide="1"> を付ける・既定オン）の時は
    //   入力しない・押さない。案内（光らせてスタッフが押す）に条件を渡し、待っている側には「案内に回した」と完了を返す
    //   （一括の流れが入力の完了を待って固まったり、タブを読み直したり、検索の後に自動で結果を読み取りに行かないように）
    // 既定は案内（印が付く前に依頼が届いても自動で入れない＝安全側）。OFF の印（"0"）が付いている時だけ今まで通り入力する
    if (document.documentElement.getAttribute("data-axlx-guide") !== "0") {
      window.postMessage({ from: "aixlinx-fill-started", customerId: _fillCustomerId }, "*");
      window.postMessage({ from: "axlx-guide-start", conditions: e.data.conditions || {}, customerId: _fillCustomerId }, "*");
      _doneNotified = false;
      notifyDone("guide-mode: 案内モードのため拡張は入力していません（スタッフが入力して検索）");
      return;
    }
    try {
      fillRealpro(e.data.conditions);
      /**
       * 2026-11-14 竹内さん「検索まで押せるか」「検索ボタンを押さなかった原因も地域のところで
       *   止まってしまっていた可能性ある」:
       *   ⚠ `fillRealpro` は**条件を積むだけ**で、検索を押すのは
       *     「モーダル（地域・駅）が完了した時」だけ。**モーダルが無い条件では検索が押されない**。
       *     実測: 並びに「検索」があるのは 11/79（14%）だけだった。
       *   → **保険**: 入力を始めてから N 秒たっても検索が押されていなければ、
       *     条件が入っている事を確かめて**押す**（全件検索はしない）。
       *     ⚠ 地域・駅のモーダルが動いている間は押さない（モーダルの完了を待つ）。
       */
      try {
        if (window.__axSearchFallbackTimer) clearTimeout(window.__axSearchFallbackTimer);
        window.__axSearchFallbackTimer = setTimeout(function () {
          try {
            // すでに検索を押した／モーダルが開いている／入力中 → 何もしない
            if (window._axSearchPressedAt && Date.now() - window._axSearchPressedAt < 60000) return;
            if (_axModalOpen()) return;
            if (isClickQueueBusy()) { return; }
            var any = document.querySelector('input[name="city_code[]"]:checked')
              || document.querySelector('input[name="rental_cost2"]')
              || document.querySelector('input[name="room_layout_id[]"]:checked');
            if (!any) return;
            console.log('[AX] 検索が押されていない → 条件は入っているので押します（保険）');
            try { if (_audit) _auditStepP('search_fallback', '一定時間たっても押されていないため押す'); } catch (_) {}
            clickSearch();
          } catch (_) {}
        }, 25000);
      } catch (_) {}
    } catch (err) {
      // fill-done 保証: 同期例外でも必ず完了シグナルを送る
      console.error('[AX] fillRealpro 同期例外 → fill-done送信', err);
      notifyDone('fillRealpro listener: ' + ((err && err.message) || String(err)));
    }
  });
})();
