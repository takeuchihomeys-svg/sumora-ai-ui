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

  /**
   * 「検索条件を表示」（左の条件の欄を出す）を押す所を1か所にする。
   * ★ 2026-11-20 竹内さん「全部人間がやるように徹底的に」:
   *   旧は resize のたびにここで3回、content.js でも3回＋画面の書き換えのたびに（カーソル無しで）押していた
   *   ＝開いてすぐ閉じる・カーソル無しの押しが出る。
   *   → content.js もここへ頼む（postMessage `axlx-press-show-sidebar`）。4秒に1回まで・押している最中は重ねない・
   *     文字が短い見えている要素だけ（大きな入れ物の真ん中を押さない）・必ずカーソル経由。
   */
  var _axShowBtnAt = 0;
  function _axPressShowSidebar() {
    if (Date.now() - _axShowBtnAt < 4000) return false;
    var all = document.querySelectorAll('a,button,input,div,span,td,p');
    var best = null, bestLen = 1e9;
    for (var i = 0; i < all.length; i++) {
      var el = all[i];
      if (!el.offsetParent) continue;
      var txt = (el.textContent || el.value || '').trim();
      if (txt.indexOf('検索条件を表示') < 0 || txt.length > 24) continue;
      if (txt.length < bestLen) { best = el; bestLen = txt.length; }
    }
    if (!best) return false;
    _axShowBtnAt = Date.now();
    try {
      if (typeof _humanPointerClick === "function") {
        _humanPointerClick(best, function () { try { best.click(); } catch (_) {} });
      } else {
        best.click();
      }
    } catch (_) {
      try { best.click(); } catch (__) {}
    }
    return true;
  }
  try { document.documentElement.setAttribute("data-axlx-ps", "1"); } catch (_) {}
  window.addEventListener('message', function (e) {
    try {
      if (e.source !== window || !e.data || e.data.from !== "axlx-press-show-sidebar") return;
      _axPressShowSidebar();
    } catch (_) {}
  });
  window.addEventListener('resize', function() {
    setTimeout(_axPressShowSidebar, _hd(300));
    setTimeout(_axPressShowSidebar, _hd(1800));
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

  /**
   * ★ 2026-11-17 統括Pro「沿線↔駅の地図を自動の把握に載せる」:
   *   popup-maps の STATION_LINE_MAP / LINE_STATION_ORDER（window.__AXLX_*）を読む。
   *   地図が無い時は null（DOM 同名全押しにフォールバック）。
   */
  function _lineStationMap() {
    try {
      return (typeof window !== "undefined" && window.__AXLX_STATION_LINE_MAP) || null;
    } catch (_) { return null; }
  }
  function _lineStationOrder() {
    try {
      return (typeof window !== "undefined" && window.__AXLX_LINE_STATION_ORDER) || null;
    } catch (_) { return null; }
  }
  function _normLineName(s) {
    return String(s || "").replace(/\s+/g, "").replace(/　/g, "");
  }
  /** 駅名 → 地図上の沿線名配列（無ければ []） */
  function _mapLinesOfStation(stationName) {
    var m = _lineStationMap();
    if (!m) return [];
    var clean = String(stationName || "").replace(/駅$/, "").trim();
    var lines = m[clean] || m[stationName] || null;
    if (!lines || !lines.length) {
      try {
        var keys = Object.keys(m);
        for (var i = 0; i < keys.length; i++) {
          if (_stationNameMatch(keys[i], clean)) { lines = m[keys[i]]; break; }
        }
      } catch (_) {}
    }
    return Array.isArray(lines) ? lines.slice() : [];
  }
  /**
   * 選んだ沿線 ∩ 地図の沿線 = その駅を押すべき本数の期待値。
   * selectedLineNames が空なら地図の全沿線数（十三なら3）。
   */
  function _mapExpectHitsForStation(stationName, selectedLineNames) {
    var mapLines = _mapLinesOfStation(stationName);
    if (!mapLines.length) return 0;
    var sel = (selectedLineNames || []).map(_normLineName).filter(Boolean);
    if (!sel.length) return mapLines.length;
    var n = 0;
    for (var i = 0; i < mapLines.length; i++) {
      var ml = _normLineName(mapLines[i]);
      for (var j = 0; j < sel.length; j++) {
        if (ml === sel[j] || (ml.length >= 4 && sel[j].indexOf(ml) >= 0) || (sel[j].length >= 4 && ml.indexOf(sel[j]) >= 0)) {
          n++;
          break;
        }
      }
    }
    return n > 0 ? n : mapLines.length;
  }
  /** want 駅名すべてについて地図期待本数の合計（選んだ沿線と交差） */
  function _mapExpectWantStationTargets(names, selectedLineNames) {
    var want = (names || []).map(function (s) { return String(s || "").replace(/駅$/, "").trim(); }).filter(Boolean);
    if (!want.length) return 0;
    var total = 0;
    var any = false;
    for (var i = 0; i < want.length; i++) {
      var h = _mapExpectHitsForStation(want[i], selectedLineNames);
      if (h > 0) { any = true; total += h; }
      else total += 1; // 地図に無い駅は最低1
    }
    return any ? total : 0;
  }
  /** form / cond から今の沿線名リスト */
  function _selectedLineNamesNow(cond) {
    var out = [];
    try {
      out = _checkedLabelTexts("route_id[]") || [];
    } catch (_) {}
    if ((!out || !out.length) && cond && cond.route_ids && cond.route_ids.length) {
      out = cond.route_ids.map(function (id) { return ROUTE_LINE_MAP[id] || null; }).filter(Boolean);
    }
    return out;
  }
  /** 地図の有無と期待を監査に1回載せる */
  function _auditLineStationMap(cond) {
    try {
      if (!_audit) return;
      var has = !!_lineStationMap();
      if (!has) {
        if (!window.__axlxMapMissingNoted) {
          window.__axlxMapMissingNoted = true;
          _auditStepP("line_station_map_missing", "STATION_LINE_MAP未注入");
        }
        return;
      }
      var names = (cond && cond.station_names) || [];
      if (!names.length) return;
      var sel = _selectedLineNamesNow(cond);
      var parts = [];
      for (var i = 0; i < names.length; i++) {
        var sn = String(names[i] || "").replace(/駅$/, "").trim();
        var ml = _mapLinesOfStation(sn);
        var exp = _mapExpectHitsForStation(sn, sel);
        parts.push(sn + "→地図沿線" + ml.length + " 期待" + exp + (sel.length ? ("∩選" + sel.length) : ""));
      }
      var sig = parts.join("|") + "|sel=" + sel.join(",");
      if (window.__axlxLineStationMapSig === sig) return;
      window.__axlxLineStationMapSig = sig;
      _auditStepP("line_station_map", parts.join("／") + (sel.length ? " 選沿線=" + sel.slice(0, 6).join(",") : ""));
    } catch (_) {}
  }

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
     * ★ 2026-11-17 平田さん自動: 賃料を「直接入力」に見せない。
     *   rental_cost* は必ず chooseSelectLikeHuman（擬似一覧＋選択）へ回す。
     */
    if (/^rental_cost/i.test(String(name || ""))) {
      return setSelValHuman(name, val);
    }
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
  /**
   * ★ 2026-11-16 録画: 賃料・更新日が「直接入力」に見えた。
   *   旧は**いま選ばれている行**付近だけ描いていた → 目当て（140000円等）が一覧外だと
   *   カーソルが行へ行けず、値だけ変わる＝直接入力に見える。
   *   → focusIdx（選ぶ行）を中心に窓を開く。
   */
  /**
   * ★ 2026-11-16 竹内さん「築年数や間取りは下まで行ってから選ぶ／スクロールも人間のように」:
   *   旧: 目当ての付近だけ12行出して一瞬で選ぶ（スクロール無し＝機械的）。
   *   新: 全選択肢を縦スクロール可能な一覧にし、**上から下へ**人間らしく送ってから選ぶ。
   */
  function _showFakeOptions(el, focusIdx) {
    try {
      /**
       * ★ 2026-11-16 竹内さん「プルダウンのところ点滅してしまうのも気になる」:
       *   旧は毎回 destroy→create で点滅。同じ欄の一覧が既にあれば再利用（作り直さない）。
       */
      if (_fakeDd && _fakeDd.el && _fakeDd.el.parentNode && _fakeDd.srcEl === el) {
        try {
          if (_fakeDd._safety) { clearTimeout(_fakeDd._safety); _fakeDd._safety = null; }
          _armFakeDdSafety(_fakeDd);
          if (typeof focusIdx === "number" && focusIdx >= 0) _fakeDd.focus = focusIdx;
          return _fakeDd;
        } catch (_) { /* fall through recreate */ }
      }
      _hideFakeOptions(null);
      var d = document;
      var r = el.getBoundingClientRect();
      var vh = window.innerHeight || 800;
      var maxH = 260;
      /**
       * ★ 2026-11-16 竹内さん「プルダウン開くのはカーソルの場所によって違う／上にある場合と下にある場合」:
       *   本物の select と同じく **欄（カーソル）の位置**で開く方向が決まる。
       *   ・欄が画面の上寄り／下に余白あり → 一覧は**下**へ
       *   ・欄が画面の下寄り／下に余白なし → 一覧は**上**へ（スクショ: 賃料が下なら上に開く）
       *   選択肢の並びは常に options 順（上→下）。上下で行の順をひっくり返さない。
       *   ⚠ 「常に下」は誤り（2.8.29）。描画後に bottom を欄の上端へ合わせて隙間・食い違いを防ぐ。
       */
      var spaceBelow = Math.max(0, vh - r.bottom - 4);
      var spaceAbove = Math.max(0, r.top - 4);
      var need = Math.min(maxH, 180);
      var fieldMid = (r.top + r.bottom) / 2;
      /**
       * 開く方向 = いまの欄の位置（主）＋学習した画面位置（副）。
       * 学習: その欄の画面Yが下寄りなら上開きを優先（通常録画の配置を反映）。
       */
      var _nmDd = "";
      try { _nmDd = String(el.getAttribute && el.getAttribute("name") || ""); } catch (_) {}
      var _learnPrefer = null; // "up" | "down" | null
      try {
        var _saDd = _nmDd && typeof _screenAimOf === "function" ? _screenAimOf(_nmDd) : null;
        if (_saDd && typeof _saDd.y === "number") {
          if (_saDd.y > 0.55) _learnPrefer = "up";
          else if (_saDd.y < 0.45) _learnPrefer = "down";
        }
      } catch (_) {}
      // 下に足りない＋上が広い、または欄が下半分で下が need 未満 → 上へ（OSの select と同じ感覚）
      var openUp = (spaceBelow < need && spaceAbove > spaceBelow) ||
        (fieldMid > vh * 0.55 && spaceBelow < need);
      if (_learnPrefer === "up" && spaceAbove >= 80) openUp = true;
      if (_learnPrefer === "down" && spaceBelow >= need) openUp = false;
      if (spaceBelow >= need && _learnPrefer !== "up") openUp = false; // 下が十分なら下（学習が上指定なら上）
      var wrap = d.createElement("div");
      wrap.id = "axlx-fake-dd";
      var listMax = Math.min(maxH, Math.max(100, openUp ? spaceAbove : spaceBelow));
      var topPx = openUp
        ? Math.max(4, Math.round(r.top - listMax))
        : Math.round(r.bottom + 2);
      wrap.style.cssText = [
        "position:fixed",
        "left:" + Math.round(r.left) + "px",
        "top:" + topPx + "px",
        "min-width:" + Math.max(90, Math.round(r.width)) + "px",
        "max-height:" + listMax + "px",
        "overflow-y:auto", "overflow-x:hidden",
        "background:#fff", "border:1px solid #94a3b8", "border-radius:6px",
        "box-shadow:0 6px 20px rgba(0,0,0,.22)", "z-index:2147483646",
        "font:12px/1.4 -apple-system,BlinkMacSystemFont,'Segoe UI',sans-serif",
        "pointer-events:none", "user-select:none",
      ].join(";");
      var cur = el.selectedIndex;
      var focus = (typeof focusIdx === "number" && focusIdx >= 0) ? focusIdx : cur;
      var rowEls = [];
      // 全部の行を出す（スクロールで下まで行くため・並びは options の順＝上から下）
      for (var i = 0; i < el.options.length; i++) {
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
      (d.body || d.documentElement).appendChild(wrap);
      // 上開き: 実高さが分かってから「一覧の下端＝欄の上」に合わせる（隙間・浮きを防ぐ）
      if (openUp) {
        try {
          var h = wrap.offsetHeight || listMax;
          wrap.style.top = Math.max(4, Math.round(r.top - h - 2)) + "px";
        } catch (_) {}
      }
      wrap.scrollTop = 0; // 人が開いた直後は上から見る（並びは常に同じ）
      try {
        console.log("[AX] 擬似プルダウン " + (openUp ? "上" : "下") + "開き fieldMid=" + Math.round(fieldMid) + "/" + vh +
          " below=" + Math.round(spaceBelow) + " above=" + Math.round(spaceAbove));
      } catch (_) {}
      _fakeDd = { el: wrap, rowEls: rowEls, focus: focus, openUp: openUp, srcEl: el };
      _armFakeDdSafety(_fakeDd);
      return _fakeDd;
    } catch (_) { return null; }
  }
  /** 擬似一覧を上から下へ人間らしく送って目当ての行を出す（Promise） */
  function _scrollFakeDdToFocus(dd, focusIdx) {
    return new Promise(function (resolve) {
      try {
        if (!dd || !dd.el || focusIdx == null || focusIdx < 0) { resolve(false); return; }
        var row = dd.rowEls && dd.rowEls[focusIdx];
        if (!row) { resolve(false); return; }
        var wrap = dd.el;
        var target = Math.max(0, row.offsetTop - Math.floor(wrap.clientHeight * 0.35));
        var start = wrap.scrollTop || 0;
        if (Math.abs(target - start) < 8) { resolve(true); return; }
        // 人がホイールで送る形: 数段に分けて（等間隔にしない）
        var steps = Math.min(8, Math.max(3, Math.round(Math.abs(target - start) / 40)));
        var i = 0;
        var tick = function () {
          i++;
          var t = i / steps;
          // ease-out
          var e = 1 - Math.pow(1 - t, 2.2);
          wrap.scrollTop = start + (target - start) * e;
          if (i >= steps) {
            wrap.scrollTop = target;
            resolve(true);
            return;
          }
          setTimeout(tick, _ln(90, 0.4, 55, 160));
        };
        setTimeout(tick, _ln(180, 0.35, 100, 320));
      } catch (_) { resolve(false); }
    });
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

  /**
   * ★ 2026-11-18 竹内さん「家賃や更新日選択する際、画面のスクロールをせず画面外でおこなってしまった。
   *   画面内にあわせるようにスクロールして画面に出てから選択する」:
   *   旧は「キューの手前で1回スクロール＋固定の短い待ち」だけで、スムーズスクロールが終わる前に
   *   カーソルが旧座標へ動き、擬似一覧も旧座標で描かれて画面外で選んでいた。
   *   → 選ぶ直前に: 欄とその下の一覧が画面に入っているか確かめ、入っていなければ中央へスクロールし、
   *     **動きが止まるまで待ってから**もう一度確かめる（最大3回）。入ってからカーソルを動かす。
   *   ⚠ 直前のスクロール抑制（900ms・逆向き）には従わない（選ぶ欄は必ず画面に出す）。
   */
  function _settleSelectInView(el, label) {
    return new Promise(function (resolve) {
      try {
        if (!el || !el.getBoundingClientRect) { resolve(false); return; }
        var tries = 0, scrolled = false;
        var inView = function () {
          var r = el.getBoundingClientRect();
          var vh = window.innerHeight || 800;
          // 欄が見え、下に一覧（約140px）が開ける余白を持つ（端ぎりぎりで選ばない）
          return r.height > 0 && r.top >= 60 && r.bottom <= vh - 90;
        };
        var waitStable = function (cb) {
          var last = null, same = 0, t0 = Date.now();
          (function poll() {
            var y = 0;
            try { y = Math.round(el.getBoundingClientRect().top); } catch (_) {}
            if (last !== null && Math.abs(y - last) <= 1) same++; else same = 0;
            last = y;
            // スクロールが始まる前の「動いていない」を止まったと誤判定しない（最短260ms見る）
            if ((same >= 2 && Date.now() - t0 >= 260) || Date.now() - t0 > 2400) { cb(); return; }
            setTimeout(poll, 70);
          })();
        };
        var finish = function () {
          var ok = false;
          try { ok = inView(); } catch (_) {}
          try { _auditStepP("select_in_view", String(label || (el.getAttribute && el.getAttribute("name")) || "select").slice(0, 30) + (scrolled ? " スクロール" + tries + "回" : " 画面内") + (ok ? " OK" : " 端")); } catch (_) {}
          if (scrolled) {
            // 人が「出た」と目で確かめる短い間
            setTimeout(function () { resolve(true); }, _ln(260, 0.35, 150, 520));
          } else {
            resolve(false);
          }
        };
        var step = function () {
          var ok = true;
          try { ok = inView(); } catch (_) { ok = true; }
          if (ok || tries >= 3) { finish(); return; }
          tries++; scrolled = true;
          try {
            el.scrollIntoView({ behavior: tries === 1 ? "smooth" : "auto", block: "center", inline: "nearest" });
          } catch (_) {}
          try { _lastScrollAt = Date.now(); } catch (_) {}
          waitStable(step);
        };
        step();
      } catch (_) { resolve(false); }
    });
  }
  function chooseSelectLikeHuman(el, val, opts) {
    if (!el || val == null) return Promise.resolve(false);
    var _lbl = (opts && opts.field) || null;
    return _settleSelectInView(el, _lbl).then(function () {
      return _chooseSelectLikeHumanCore(el, val, opts);
    }, function () {
      return _chooseSelectLikeHumanCore(el, val, opts);
    });
  }
  function _chooseSelectLikeHumanCore(el, val, opts) {
    if (!el || val == null) return Promise.resolve(false);
    var o = opts || {};
    try {
      _auditStepP(
        "op_path_select_ui",
        String(o.field || (el && el.getAttribute && el.getAttribute("name")) || "").slice(0, 40) + "=" + String(val).slice(0, 20),
      );
    } catch (_) {}
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
           *
           * ★ 2026-11-16 竹内さん「プルダウンのところもカーソルうごかしてその場所おす／細かく通常のように」:
           *   流れ: ①欄へカーソル（キュー側）→ ②見える擬似一覧 → ③行へカーソル → ④tap → ⑤値＋change
           *   OS一覧は開かない。記録には click→change（人が押した形）。
           */
          /**
           * ★ 2026-11-16: click 記録は**行を押した時に1回だけ**（下の tap 後）。
           *   旧はここに＋_fireAt＋_humanPointerClick で rental_cost2 が連続3回録画されていた。
           */
          // ★ 点滅防止: native focus は OS の枠が点滅するので送らない（擬似一覧だけで見せる）
          // 学んだ押す位置があれば、欄のその点へもう一度微調整（キュー移動のあとの狙い直し）
          var _aimSel = o.aim;
          var _afterAim = function () {
          // ★ 2026-11-16: 目当ての行（want）を窓の中心に出す → カーソルが行へ届く
          var _dd = _showFakeOptions(el, want);
          var _pick = function () {
            // 行を押した時刻（次の select の「前の操作からの間隔」の基準・2.8.109）
            try { window.__axlxSelTapAt = Date.now(); } catch (_) {}
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
              // ★ 2026-11-17 統括Pro「sel_pick＝直書きに見える／F27経路記録」:
              //   擬似一覧＋カーソル後の確定のみ。op_path で「UI経由」と残す（裸代入と区別）。
              try { _auditStepP("op_path_select_ui", (el.getAttribute("name") || "?") + "#" + want); } catch (_) {}
              if (_audit) _auditStepP('sel_pick', (el.getAttribute("name") || "?") + ' → 値"' + String(el.value) + '"（' + want + '番目・UI経由）');
              if (!el.value || el.selectedIndex < 0) {
                // それでも入らなければ、選んだ位置をそのまま使う（最後の砦）
                try { el.selectedIndex = want; } catch (__) {}
              }
              el.dispatchEvent(new Event("input", { bubbles: true }));
            } catch (_) {}
            setTimeout(function () {
              try { el.dispatchEvent(new Event("change", { bubbles: true })); } catch (_) {}
              // ★ 点滅防止: すぐ消さず一拍置いてから消す（連続欄でもチカチカしにくい）
              setTimeout(function () {
                _hideFakeOptions(_dd);
                setTimeout(function () {
                  try { if (el.blur) el.blur(); } catch (_) {}
                  resolve(true);
                }, _ln(120, 0.35, 70, 220));
              }, _ln(170, 0.35, 100, 300));
            }, _ln(130, 0.35, 70, 230));
          };
          // ② 一覧を上から見る → ③ 下へスクロール → ④ 行へカーソル → ⑤ tap
          // ★ 2026-11-16: 築年・賃料などは slow。スクロールしてから選ぶ（人間らしく）
          /**
           * ★ 2026-11-18 竹内さん「家賃・更新日の前後も通常モードの人間のように」:
           *   欄の中（開く→選ぶ）の実測 通常 p25=1.05s／p50=1.3s／p75=1.85s／p90=2.0s／max=3.5s、自動 p50=2.8s／p75=4.1s。
           *   旧 見る 0.9s＋選ぶ前 0.75s＋閉じる待ち 1.0s が重なっていた。
           *   → 見る 0.3s・押す前 0.2s・閉じる待ち 0.4s 程度（対数正規）。たまに（8%）一覧の上で迷う（+0.7〜1.6s）。
           */
          var _lookMs = o.slow ? _ln(330, 0.35, 200, 560) : _ln(260, 0.35, 160, 440);
          if (Math.random() < 0.08) _lookMs += 700 + Math.floor(Math.random() * 900);
          var _tapMs = o.slow ? _ln(210, 0.35, 120, 400) : _ln(170, 0.35, 100, 320);
          setTimeout(function () {
            var afterScroll = function () {
              if (_dd && _dd.rowEls && _dd.rowEls[want]) {
                var row = _dd.rowEls[want];
                try { row.classList.add("axlx-dd-hover"); } catch (_) {}
                if (P && P.moveToEl) {
                  P.moveToEl(row).then(function () {
                    _markFakeRow(_dd, want);
                    setTimeout(function () {
                      try { if (P.tap) P.tap(); } catch (_) {}
                      try { _noteClickForLearn(el); } catch (_) {}
                      _pick();
                    }, _tapMs);
                  }, function () { _markFakeRow(_dd, want); _pick(); });
                  return;
                }
                _markFakeRow(_dd, want);
              }
              _pick();
            };
            // 目当てが下の方なら、上から下へ送ってから選ぶ
            if (_dd && want >= 0 && (_dd.rowEls && _dd.rowEls.length > 8 || o.slow)) {
              _scrollFakeDdToFocus(_dd, want).then(afterScroll, afterScroll);
            } else {
              afterScroll();
            }
          }, _lookMs);
          }; // _afterAim
          /**
           * ★ 2026-11-20 (2.8.136) 実測 run_mwofi2sn_jbec: 徒歩の欄を 0.6秒で2回押していた（列の押下＋ここの狙い直しの tap）。
           *   人は欄を1回押して一覧を開く。カーソルが既に欄の上なら、狙い直し・2回目の tap はしない。
           */
          var _onSelAlready = false;
          try {
            if (P && P.position) {
              var _cp = P.position(), _rr = el.getBoundingClientRect();
              _onSelAlready = !!(_cp && _rr.width > 0 && _cp.x >= _rr.left - 2 && _cp.x <= _rr.right + 2 && _cp.y >= _rr.top - 2 && _cp.y <= _rr.bottom + 2);
            }
          } catch (_) { _onSelAlready = false; }
          // 位置の学び（aim）が無い欄は今まで通りここで押さない（列の押下の1回だけ）
          if (!(_aimSel && typeof _aimSel.x === "number")) _onSelAlready = false;
          if (_onSelAlready) {
            try { _auditStepP("sel_one_press", String((el.getAttribute && el.getAttribute("name")) || "?") + " カーソルが欄の上→押し直さない"); } catch (_) {}
            _afterAim();
            return;
          }
          if (P && P.moveTo && _aimSel && typeof _aimSel.x === "number") {
            try {
              var _sr = el.getBoundingClientRect();
              var _ax = _sr.left + _sr.width * Math.max(0.2, Math.min(0.8, _aimSel.x));
              var _ay = _sr.top + _sr.height * Math.max(0.2, Math.min(0.8, _aimSel.y != null ? _aimSel.y : 0.5));
              // ★ 2026-11-19 #1531: 徒歩の select は右側に分数の欄が重なる → 見えている所の点へ直す
              try {
                var _shp = _visibleHitPoint(el, { x: _ax, y: _ay });
                if (_shp) { _ax = _shp.x; _ay = _shp.y; }
              } catch (_) {}
              try { if (P.setTarget) P.setTarget(el); } catch (_) {}
              P.moveTo(_ax, _ay).then(function () { try { if (P.tap) P.tap(); } catch (_) {} _afterAim(); }, _afterAim);
              return;
            } catch (_) { _afterAim(); return; }
          }
          _afterAim();
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
              try { _auditStepP("op_path_select_ui", (el.getAttribute("name") || "?") + "#" + want); } catch (_) {}
              if (_audit) _auditStepP('sel_pick', (el.getAttribute("name") || "?") + ' → 値"' + String(el.value) + '"（' + want + '番目・UI経由）');
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
    /**
     * ★ 2026-11-20 竹内さん「ちゃんと人間が動くような動きに」:
     *   選んだ値が違った時、旧はすぐ値を直接書き換えていた（一覧を開かずに値だけ変わる）。
     *   → 人と同じくもう1回開いて選び直す。それでも違う時だけ今まで通り直す（_verifySel）。
     */
    var _verifyOrRetry = function () {
      if (_selMatchesWant(el, target)) return _verifySel(el, target);
      try { if (_audit) _auditStepP("sel_retry_human", (el.getAttribute("name") || "?") + " 違う値→もう1回開いて選び直す"); } catch (_) {}
      return openThenChoose().then(function () { return _verifySel(el, target); }, function () { return _verifySel(el, target); });
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
        try { if (P.setTarget) P.setTarget(el); } catch (_) {}
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
        return openThenChoose().then(_verifyOrRetry);
      }, function () {
        return openThenChoose().then(_verifyOrRetry);
      });
    }
    return openThenChoose().then(_verifyOrRetry);
  }
  /**
   * 2026-11-11 竹内さん「ちゃんと画面確認しながら動く」:
   *   選んだ後に **画面の欄が本当にその値になったか**を読む（人の「選べたかな」と同じ）。
   *
   * ★ 2026-11-16 竹内さん「プルダウンを何度もクリック／徒歩が消える」／DB: transportation_id 二重押し×9:
   *   ⚠ 旧は `el.value === target` の**文字列一致だけ**だった。
   *     徒歩は target="徒歩"（文字）・実値は "1" など → **毎回不一致** → `el.value="徒歩"` を代入
   *     → 無効値で**選択が消える** → reseal が擬似一覧をまた開く＝画面が消えたり開いたり・連打に見える。
   *   → ①値一致 ②選択中の**文字**が target を含む → OK（入れ直さない）
   *     ③違う時だけ、選択肢から正しい位置を探して selectedIndex（無効な文字列は絶対に入れない）
   */
  function _selMatchesWant(el, target) {
    if (!el) return false;
    var want = String(target == null ? "" : target);
    var got = String(el.value == null ? "" : el.value);
    if (got === want) return true;
    try {
      if (el.options && el.selectedIndex >= 0) {
        var t = String(el.options[el.selectedIndex].textContent || "").replace(/\s+/g, "");
        var w = want.replace(/\s+/g, "");
        if (t === w || (w.length >= 2 && t.indexOf(w) >= 0) || (t.length >= 2 && w.indexOf(t) >= 0)) return true;
      }
    } catch (_) {}
    return false;
  }
  function _findOptionIndexForWant(el, target) {
    if (!el || !el.options) return -1;
    var want = String(target == null ? "" : target);
    var i;
    for (i = 0; i < el.options.length; i++) {
      if (String(el.options[i].value) === want) return i;
    }
    var w = want.replace(/\s+/g, "");
    for (i = 0; i < el.options.length; i++) {
      var t = String(el.options[i].textContent || "").replace(/\s+/g, "");
      if (t === w) return i;
    }
    for (i = 0; i < el.options.length; i++) {
      var t2 = String(el.options[i].textContent || "").replace(/\s+/g, "");
      if (w.length >= 2 && t2.indexOf(w) >= 0) return i;
    }
    return -1;
  }
  function _verifySel(el, target) {
    if (!el) return false;
    var got = String(el.value == null ? "" : el.value);
    if (_selMatchesWant(el, target)) {
      try { if (_audit) _auditStepP("sel_fix_ok", (el.name || "?") + " got=\"" + got + "\" want=\"" + target + "\"（文字一致でOK）"); } catch (_) {}
      return true;
    }
    // 違う時だけ: 選択肢の位置で直す（文字列の決め打ち代入はしない）
    var ix = _findOptionIndexForWant(el, target);
    if (ix >= 0) {
      try {
        el.selectedIndex = ix;
        el.value = String(el.options[ix].value);
        el.dispatchEvent(new Event("input", { bubbles: true }));
        el.dispatchEvent(new Event("change", { bubbles: true }));
        if (el.blur) el.blur();
      } catch (_) {}
    }
    var now = String(el.value == null ? "" : el.value);
    var ok = _selMatchesWant(el, target);
    if (_audit) {
      _auditStepP("sel_fix", (el.name || "?") + " " + got + "→" + now + "（入れるはず " + target + "）" + (ok ? " OK" : " NG"));
      if (!ok) {
        _audit.sel_mismatch = _audit.sel_mismatch || [];
        if (_audit.sel_mismatch.length < 10) {
          _audit.sel_mismatch.push({ name: el.name || "?", want: String(target), got: now });
        }
      }
    }
    return ok;
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
        var openWait = openMs != null ? openMs : _ln(900, 0.4, 700, 1400);
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
    /**
     * ★ 2026-11-16 竹内さん「間取りも新しいお客さんのように／2LDK以外はずす」:
     *   間取りは「間取り絞り込み＋」の中。旧は絞り込み条件＋に落ちて開き損ねていた。
     */
    if (String(name || "").indexOf("room_layout") >= 0) {
      return _findByText(['間取り絞り込み＋', '間取り絞り込み+', '間取り絞り込み']);
    }
    /** ペット可(eq_rm)・設備は「絞り込み条件＋」の中 */
    if (name === "eq_rm[]" || /^eq_/i.test(String(name || ""))) {
      return _findByText(['絞り込み条件＋', '絞り込み条件+', '絞り込み条件', '検索条件を表示']);
    }
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
   * ★ 2026-11-19 #1532（くれあ・2.8.121）: 左の帯の「…絞り込み＋」は一番内側の要素を押す。
   *   `div.click_menu, div.one_slide_search_box` を文書の順で探すと、他の絞り込みもまとめて含む外側の箱（210×204）が先に当たり、
   *   ボタンで学んだ位置（横50%・縦50%）をその箱に当てて「閲覧履歴」の辺りを押していた（写真 23043）。
   *   小窓が開かず前の客の駅を外せない → 関所が「地域と駅が混在」で6回やり直し → 人が止めた。
   *   人は文字の span を押している（`左の沿線・駅絞り込み＋｜span`）。
   */
  function _sidebarOpenerEl(word, otherRe) {
    var exact = null;
    try { exact = _findByText([word + "＋", word + "+", word]); } catch (_) { exact = null; }
    if (exact) return exact;
    var best = null, bestA = Infinity;
    try {
      var divs = document.querySelectorAll("div.click_menu, div.one_slide_search_box");
      for (var i = 0; i < divs.length; i++) {
        var d = divs[i];
        if (!isVisible(d)) continue;
        var t = norm(d.textContent);
        if (t.indexOf(norm(word)) < 0) continue;
        if (otherRe && otherRe.test(t)) continue;
        var rr = d.getBoundingClientRect();
        var a = Math.max(1, rr.width * rr.height);
        if (a < bestA) { best = d; bestA = a; }
      }
    } catch (_) {}
    return best;
  }
  var _SIDEBAR_OTHER_RE = /所在地絞り込み.*沿線・駅絞り込み|沿線・駅絞り込み.*所在地絞り込み|管理会社絞り込み|閲覧履歴|駅からの移動/;
  /**
   * ★ 2026-11-16: リアプロ「敷金・礼金なし」チェックを広く探す。
   *   完全一致だけでなく「敷金」「礼金」「なし」を含むラベルも対象。
   */
  function _findShikireiCheckbox() {
    try {
      var sLabels = document.querySelectorAll("label");
      for (var si = 0; si < sLabels.length; si++) {
        var sTxt = (sLabels[si].textContent || "").replace(/[\s　]/g, "");
        var hit = sTxt === "敷金・礼金なし" || sTxt === "敷金礼金なし"
          || (sTxt.indexOf("敷金") >= 0 && sTxt.indexOf("礼金") >= 0 && sTxt.indexOf("なし") >= 0);
        if (!hit) continue;
        var sInp = sLabels[si].querySelector('input[type="checkbox"]');
        if (sInp) return sInp;
      }
    } catch (_) {}
    return null;
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
      /**
       * ★ 根本: パネルを開いた瞬間に負債を立てる（閉じる＝確定してリストへが必須）。
       *   場当たりで各所に確定を足す代わりに、開く入口で一律に負債化。
       */
      try { _markPanelOpened(_panelKindOf(name, op), "ensure:" + String(name || "")); } catch (_) {}
      /**
       * ★ 2026-11-17 竹内さん「展開のパターンも機械的」:
       *   旧は毎回同じ opener 直押し。→ 先に opener を画面内へ／学び位置で押す／待ちを揺らす。
       */
      var _openKeys = [];
      try {
        if (/city_code|town_code/.test(String(name || ""))) _openKeys = ["左の所在地絞り込み", "所在地絞り込み＋", "所在地絞り込み"];
        else if (/station_id|route_id/.test(String(name || ""))) _openKeys = ["左の沿線・駅絞り込み", "沿線・駅絞り込み＋", "沿線・駅絞り込み"];
        else if (/room_layout/.test(String(name || ""))) _openKeys = ["間取り絞り込み＋", "間取り絞り込み"];
        else _openKeys = ["絞り込み条件＋", "絞り込み条件"];
      } catch (_) {}
      try {
        if (op.scrollIntoView && Math.random() < 0.7) {
          op.scrollIntoView({
            behavior: Math.random() < 0.8 ? "smooth" : "auto",
            block: Math.random() < 0.55 ? "center" : "nearest",
            inline: "nearest",
          });
        }
      } catch (_) {}
      var _doOpen = function () {
        try {
          if (typeof _pressLearned === "function") _pressLearned(op, _openKeys, "field_open:" + String(name || "").slice(0, 16));
          else _humanPointerClick(op, function () { try { op.click(); } catch (_) {} });
        } catch (_) {
          try { op.click(); } catch (__) {}
        }
      };
      // 展開前の一拍を毎回変える（機械的な即押しを避ける）
      var _pre = 80 + Math.floor(Math.random() * 420);
      if (Math.random() < 0.18) _pre += 200 + Math.floor(Math.random() * 500);
      setTimeout(_doOpen, _pre);
      var _fclk = _activeClock();
      var t0 = _fclk.tick();
      var limit = (maxMs || 3000) + _pre;
      var _openDomain = _intentDomainOfName(String(name || ""), op);
      if (_openDomain === "other") {
        if (/city_code|town_code/.test(String(name || ""))) _openDomain = "open_area";
        else if (/station_id|route_id/.test(String(name || ""))) _openDomain = "open_station";
        else if (/room_layout/.test(String(name || ""))) _openDomain = "open_layout";
        else if (/eq_|option_|pet/.test(String(name || ""))) _openDomain = "open_filter";
      }
      /**
       * ★ 2026-11-19 竹内さん「タイムアウトでボトルネックとなっている部分を取り除いていく」:
       *   旧は開かないまま期限が来ると即 false（呼び手は開いていない欄へそのまま進む）。#1479 open_timeout:city_code[]。
       *   → 期限で1回だけ押し直して同じだけ待つ（押す直前にもう一度見て、開いていれば押さない＝閉じ直さない）。
       */
      var _reopened = false;
      (function poll() {
        if (vis()) {
          try { _noteIntentUnderstood(_openDomain, "press", true, "open:" + String(name || "").slice(0, 20) + (_reopened ? "（押し直し）" : "")); } catch (_) {}
          resolve(true);
          return;
        }
        if (_fclk.tick() - t0 > limit && !_reopened) {
          _reopened = true;
          try { if (_audit) _auditStepP("open_field_retry", String(name || "").slice(0, 24) + " 開かない→1回押し直す"); } catch (_) {}
          _doOpen();
          t0 = _fclk.tick();
          setTimeout(poll, 160 + Math.floor(Math.random() * 120));
          return;
        }
        if (_fclk.tick() - t0 > limit) {
          try { if (_audit) _auditStepP("open_field_timeout", String(name || "").slice(0, 24) + " 押し直しても開かない"); } catch (_) {}
          try { _noteIntentUnderstood(_openDomain, "press", false, "open_timeout:" + String(name || "").slice(0, 16)); } catch (_) {}
          resolve(false);
          return;
        }
        setTimeout(poll, 160 + Math.floor(Math.random() * 120));
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
  /**
   * ★ 2026-11-16 竹内さん「直接入力してしまっているところはカーソル移動して押す」:
   *   旧はカーソル移動のあと `setSelVal`（value 代入）＝見た目は動いても「開いて選ぶ」ではない。
   *   → **必ず chooseSelectLikeHuman**（カーソル→開く→選ぶ→押す）。
   */
  function setSelValHuman(name, val) {
    var el = document.querySelector('select[name="' + name + '"]');
    if (!el || val == null) return Promise.resolve(false);
    return Promise.resolve(chooseSelectLikeHuman(el, val, { forceOpen: true, field: name }));
  }
  // 2026-11-10 人間的な動き: 値を一瞬で入れると「貼り付けた」動きになる。数字などの短い欄は1文字ずつ打つ
  //   （人の打鍵の間は 60〜220ms・たまに止まる）。長い文字列（40字超）は今まで通り一気に入れる（待ちが長くなりすぎない）。
  //   1文字ずつでも最後は input/change を出して React の state を更新する（今までと同じ検出力）。
  var TYPE_MAX_CHARS = 40;
  /**
   * ★ 2026-11-17 統括Pro「typeTextのclick直押しがカーソル無しの主因」:
   *   opts.alreadyAimed=true … キュー／_operateWithPointer でカーソル着済 → focus のみ。
   *   未着 … 必ず _humanPointerClick してから打つ（裸 el.click 禁止）。
   *   経路は op_path_* で監査に残す（土台 F27）。
   */
  function typeTextLikeHuman(el, value, opts) {
    var s = String(value);
    var setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value").set;
    var H = window.AxlxHumanWait;
    var already = !!(opts && opts.alreadyAimed);
    var _typeBody = function () {
      try {
        if (el && typeof window.__axlxRecNoteOp === "function") window.__axlxRecNoteOp("click", el);
      } catch (_) {}
      if (el.focus) { try { el.focus(); } catch (_) {} }
      if (!el || s.length > TYPE_MAX_CHARS || !H || !H.humanDelay) {
        try { _auditStepP("op_path_text_bulk", String((el && el.name) || "").slice(0, 40)); } catch (_) {}
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
          var wait = H.logNormalDelay ? H.logNormalDelay(165, 0.32) : H.humanDelay(165);
          if (Math.random() < 0.05) wait += 300 + Math.floor(Math.random() * 300);
          setTimeout(step, wait);
        };
        step();
      });
    };
    if (already) {
      // ★ 2026-11-17 統括Pro「直click廃止」: 着済でも裸 click せず tap／軽く押すだけ
      try { _auditStepP("op_path_text_cursor", String((el && el.name) || "").slice(0, 40)); } catch (_) {}
      try {
        var _Ptxt = window.AxlxPointerUi;
        if (_Ptxt && _Ptxt.tap) _Ptxt.tap();
        else if (el.focus) el.focus();
      } catch (_) {
        try { if (el.focus) el.focus(); } catch (__) {}
      }
      return _typeBody();
    }
    // カーソル未着: 直clickせず移動してから押す
    if (typeof _humanPointerClick === "function" && window.AxlxPointerUi) {
      try { _auditStepP("op_path_text_move", String((el && el.name) || "").slice(0, 40)); } catch (_) {}
      return _humanPointerClick(el, function () {
        try { el.click(); } catch (_) {}
        return _typeBody();
      }).then(function () { return true; }, function () { return _typeBody(); });
    }
    try { _auditStepP("op_path_text_nocursor", String((el && el.name) || "").slice(0, 40)); } catch (_) {}
    try { el.click(); } catch (_) {}
    return _typeBody();
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
    /**
     * ★ 2026-11-16 竹内さん「間取りは下まで行ってから選ぶ／スクロールも人間のように」:
     *   間取りは**上から下へ**見ていく（DOM順＋小さな揺れ）。大きく飛ばさない。
     *   それ以外（設備など）は従来どおり前半優先の揺らぎ。
     */
    var _layoutLike = String(name || "").indexOf("room_layout") >= 0;
    targets.sort(function (a, b) {
      var ai = cbs.indexOf(a), bi = cbs.indexOf(b);
      if (_layoutLike) {
        return (ai + Math.random() * 1.5) - (bi + Math.random() * 1.5);
      }
      var aw = ai + Math.random() * cbs.length * 0.9;
      var bw = bi + Math.random() * cbs.length * 0.9;
      return aw - bw;
    });
    /**
     * ★ 2026-11-16「ほかのお客さんでもずれが起きない／根元改善」:
     *   設備・ペット等（eq_*）は「絞り込み条件＋」の中。開かずに click すると他客でも直接入力に見える。
     *   → 最初の1回だけ畳みを開いてから、カーソル経由で1つずつ選ぶ。
     * ★ 2026-11-16 りさん通常録画: 間取りも「間取り絞り込み＋」を開いてから label を押す。
     */
    var _needOpen = _layoutLike
      || String(name || "").indexOf("city_code") >= 0
      || String(name || "").indexOf("town_code") >= 0
      || String(name || "").indexOf("station_id") >= 0
      || String(name || "").indexOf("route_id") >= 0
      || /^eq_/i.test(String(name || ""))
      || String(name || "").indexOf("option_") === 0;
    var _enqueueTargets = function () {
      targets.forEach(function (cb) {
        var wantOn = svals.indexOf(String(cb.value)) >= 0;
        /** ★ 細分化: 間取り・所在地・駅・沿線はすべて label 押し */
        var useLabel = _layoutLike
          || String(name || "").indexOf("city_code") >= 0
          || String(name || "").indexOf("town_code") >= 0
          || String(name || "").indexOf("station_id") >= 0
          || String(name || "").indexOf("route_id") >= 0;
        if (useLabel && typeof _toggleCheckboxLikeHuman === "function") {
          _toggleCheckboxLikeHuman(cb, wantOn); // 間隔は人間レンジ（固定禁止）
        } else {
          var _cg = (typeof _clearToggleGapRange === "function")
            ? _clearToggleGapRange()
            : { lo: 250, hi: 1100 };
          enqueueHumanClick(cb, _clickEl, _cg.lo, _cg.hi, null, { keys: [String(name || "")], sigma: 0.55 });
        }
        if (Math.random() < 0.10) {
          var _Hb = window.AxlxHumanWait;
          var _b1 = Math.round(_Hb && _Hb.logNormalDelay ? _Hb.logNormalDelay(1400, 0.45) : (900 + Math.random() * 1700));
          enqueueHumanAction(function () {}, _b1, _b1 + 200, "息");
        } else if (Math.random() < 0.03) {
          var _Hb2 = window.AxlxHumanWait;
          var _b2 = Math.round(_Hb2 && _Hb2.logNormalDelay ? _Hb2.logNormalDelay(3600, 0.4) : (2600 + Math.random() * 2900));
          enqueueHumanAction(function () {}, _b2, _b2 + 200, "考え");
        }
      });
    };
    /**
     * ★ 2026-11-18 HONOKA: 間取りは開いたあと、欲しい欄ごとに画面内へスクロールしてから押す。
     *   1DKだけ押して1LDKが画面外のまま残るのを防ぐ。
     */
    if (_layoutLike && targets.length) {
      var _oldEnqueue = _enqueueTargets;
      _enqueueTargets = function () {
        targets.forEach(function (cb) {
          try {
            var hit = (typeof _labelForCheckbox === "function" ? _labelForCheckbox(cb) : null) || cb;
            if (typeof _scrollIntoViewSoft === "function") _scrollIntoViewSoft(hit);
          } catch (_) {}
        });
        _oldEnqueue();
      };
    }
    if (_needOpen && (targets[0] || cbs[0])) {
      var _openEl = targets[0] || cbs[0];
      // ★ 2026-11-18 竹内さん「間取りが途中停止」: Promise を返し、呼び元（_runBasicOneByOne・間取り把握）が
      //   「畳みを開く→クリックを積む」まで待てるようにする（旧は未積みのまま次の欄へ進み、把握の入れ直しと二重トグルし得た）
      return _ensureFieldVisible(_openEl, name, 4000).then(function () {
        _enqueueTargets();
      }, function () { _enqueueTargets(); });
    }
    _enqueueTargets();
  }
  // 基本条件フォームの select/text 入力も1項目ずつ間隔を空けてセットする
  // 2026-11-10 v2.6.1 竹内さん「賃料選択する部分や更新日選択する部分が早すぎる。毎回人間がマウス動かして押していく形とする」
  //   旧は enqueueHumanAction（el: null）で **カーソルが動かず 80〜200ms** で値が入っていた。
  //   新は要素つきで列に積む（カーソルが欄まで動く→着いてから開く→選ぶ）。押す処理は今まで通り値の代入＋change。
  function _enqueueWithEl(el, fn, minGap, maxGap, label, aim) {
    /**
     * ★ 2026-11-16: 学んだ押す位置（aim）をキューに載せ、drain が `_humanPointerClick(..., aim)` へ渡す。
     *   旧は aim を chooseSelectLikeHuman にだけ渡し、**欄への最初のカーソル移動では使っていなかった**。
     */
    // ★ 2026-11-17 統括Pro: 既定80〜200は直接入力に見える。人の帯を既定に。
    /**
     * ★ 2026-11-18 竹内さん「家賃・更新日の前後のところも実際の通常モードの人間のように」:
     *   DB実測（通常 n=32 / 自動）: 欄の中（開く→選ぶ）通常 p50=1.3s／自動 2.8s、
     *   欄の直前 通常 p50=2.0s・p90=3.9s／自動 p50=4.1s・p75=6.5s、欄の直後 通常 p50=3.0s／自動 p50=4.1s・8秒超25%。
     *   旧は 待ち 1.8〜3.4s（＋ずらし）＋迷い22%＋「息」「考え」＋押した後≥0.95s＋一覧の見る・選ぶ待ち が全部乗っていた。
     *   → select は「selectレーン」: 押す前の待ちは小さく、前の操作からの間隔は通常の分布（_selGapPlan）で決める。
     *     「息」「考え」の足しは廃止（迷い・停止は _selGapPlan の混合が持つ）。
     */
    var _isSelEl = false;
    try { _isSelEl = String(el && el.tagName || "").toUpperCase() === "SELECT"; } catch (_) {}
    if (_isSelEl) {
      _clickQueue.push({ el: el, fn: fn, gap: _ln(110, 0.45, 50, 260), label: label || _opLabel(el), aim: aim || null, lane: "sel" });
      _scheduleClickDrain();
      return;
    }
    _clickQueue.push({ el: el, fn: fn, gap: humanRand(minGap != null ? minGap : 750, maxGap != null ? maxGap : 1500, { sigma: 0.55, strictLo: true }), label: label || _opLabel(el), aim: aim || null });
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
  /** ★ 2026-11-18 MAIN world は chrome.storage 不可 → content 橋＋localStorage 正本 */
  var _LEARN_WARM_KEYS = ["axlx_learn_points", "axlx_learn_screen", "axlx_learn_scene", "axlx_learn_needs_auto"];
  var _LEARN_NEXT_KEYS = [
    "axlx_learn_next", "axlx_learn_site_flow", "axlx_learn_seq", "axlx_learn_next_mode",
    "axlx_learn_screen_flow", "axlx_learn_scene_flows", "axlx_learn_stopped_scene", "axlx_learn_scene_missing",
    "axlx_learn_playbook",
    "axlx_learn_gaps",
  ];
  var _LEARN_PAGE_CACHE_KEY = "axlx_learn_bundle_page";
  var _learnPageCache = null;

  function _learnHasChromeStorage() {
    try {
      return typeof chrome !== "undefined" && chrome.storage && chrome.storage.local && typeof chrome.storage.local.get === "function";
    } catch (_) { return false; }
  }
  function _learnCacheSave(partial) {
    try {
      if (!partial || typeof partial !== "object") return;
      var cur = {};
      try {
        var raw = localStorage.getItem(_LEARN_PAGE_CACHE_KEY);
        if (raw) cur = JSON.parse(raw) || {};
      } catch (_) { cur = {}; }
      for (var ck in partial) {
        if (Object.prototype.hasOwnProperty.call(partial, ck)) cur[ck] = partial[ck];
      }
      cur.at = Date.now();
      localStorage.setItem(_LEARN_PAGE_CACHE_KEY, JSON.stringify(cur));
      _learnPageCache = cur;
    } catch (_) {}
  }
  function _learnCacheLoad(keys) {
    try {
      if (!_learnPageCache) {
        var raw = localStorage.getItem(_LEARN_PAGE_CACHE_KEY);
        _learnPageCache = raw ? JSON.parse(raw) : null;
      }
      if (!_learnPageCache || typeof _learnPageCache !== "object") return null;
      if (Number(_learnPageCache.at) && Date.now() - Number(_learnPageCache.at) > 6 * 60 * 60 * 1000) return null;
      var out = {}, n = 0;
      for (var i = 0; i < keys.length; i++) {
        var key = keys[i];
        if (Object.prototype.hasOwnProperty.call(_learnPageCache, key)) {
          out[key] = _learnPageCache[key];
          n++;
        }
      }
      return n ? out : null;
    } catch (_) { return null; }
  }
  function _applyLearnStoragePayload(r) {
    try {
      if (!r || typeof r !== "object") return;
      if (r.axlx_learn_points) {
        try { _learnKinds = r.axlx_learn_points || {}; } catch (_) { _learnKinds = {}; }
      }
      if (r.axlx_learn_screen) {
        try { _learnScreen = r.axlx_learn_screen || {}; } catch (_) { _learnScreen = {}; }
      }
      if (r.axlx_learn_scene) {
        try { _learnSceneMap = r.axlx_learn_scene || {}; } catch (_) { _learnSceneMap = {}; }
      }
      if (r.axlx_learn_opens) {
        try { _learnOpens = r.axlx_learn_opens || {}; _learnOpensAt = Date.now(); } catch (_) {}
      }
      if (r.axlx_learn_plan) {
        try { _learnPlan = r.axlx_learn_plan || null; _learnPlanAt = Date.now(); } catch (_) {}
      }
      if (typeof _applyLearnNextStorage === "function") _applyLearnNextStorage(r);
    } catch (_) {}
  }
  function _storageLocalGet(keys, timeoutMs, skipCache) {
    keys = Array.isArray(keys) ? keys : [];
    return new Promise(function (resolve) {
      var finished = false;
      var fin = function (data) {
        if (finished) return;
        finished = true;
        var r = data && typeof data === "object" ? data : {};
        if (Object.keys(r).length) _learnCacheSave(r);
        resolve(r);
      };
      if (_learnHasChromeStorage()) {
        try {
          chrome.storage.local.get(keys, function (r) {
            try {
              if (chrome.runtime && chrome.runtime.lastError) {
                fin(_learnCacheLoad(keys) || {});
                return;
              }
            } catch (_) {}
            fin(r || {});
          });
          return;
        } catch (_) {}
      }
      if (!skipCache) {
        var cachedFast = _learnCacheLoad(keys);
        if (cachedFast) {
          try { window.postMessage({ from: "axlx-page-storage-get", id: "bg" + Date.now(), keys: keys }, "*"); } catch (_) {}
          fin(cachedFast);
          return;
        }
      }
      var id = "sg" + Date.now() + Math.random().toString(36).slice(2, 8);
      var onMsg = function (e) {
        if (e.source !== window || !e.data) return;
        if (e.data.from === "axlx-page-storage-result" && e.data.id === id) {
          window.removeEventListener("message", onMsg);
          fin(e.data.data || {});
        }
      };
      window.addEventListener("message", onMsg);
      try { window.postMessage({ from: "axlx-page-storage-get", id: id, keys: keys }, "*"); } catch (_) {}
      setTimeout(function () {
        window.removeEventListener("message", onMsg);
        if (!finished) fin(_learnCacheLoad(keys) || {});
      }, timeoutMs || 4500);
    });
  }
  function _requestLearnRefresh(force) {
    return new Promise(function (resolve) {
      var done = false;
      var id = "lr" + Date.now() + Math.random().toString(36).slice(2, 8);
      var onDone = function (e) {
        if (e.source !== window || !e.data) return;
        if (e.data.from === "axlx-page-learn-refresh-done" && e.data.id === id) {
          fin(e.data.res || null);
        }
      };
      // 返す値: 裏側の取り直し結果（ok/skipped/error/screen_solid…）・届かなければ null・8秒で "timeout"
      var fin = function (res) {
        if (done) return;
        done = true;
        try { window.removeEventListener("message", onDone); } catch (_) {}
        resolve(res === undefined ? null : res);
      };
      window.addEventListener("message", onDone);
      try {
        if (typeof chrome !== "undefined" && chrome.runtime && chrome.runtime.sendMessage) {
          chrome.runtime.sendMessage({ type: "axlx-learn-refresh", force: !!force }, function (r) { fin(r || null); });
        }
      } catch (_) {}
      try { window.postMessage({ from: "axlx-page-learn-refresh", id: id, force: !!force }, "*"); } catch (_) {}
      setTimeout(function () { fin("timeout"); }, 8000);
    });
  }
  function _auditLearnWarmFromState(r, force) {
    try {
      var pk = _learnKinds && typeof _learnKinds === "object" ? Object.keys(_learnKinds).length : 0;
      var sk = _learnScreen && typeof _learnScreen === "object" ? Object.keys(_learnScreen).length : 0;
      var thinN = 0;
      try {
        if (_learnScreen && typeof _learnScreen === "object") {
          for (var _tk in _learnScreen) {
            var _tv = _learnScreen[_tk];
            if (_tv && ((Number(_tv.n) || 0) < 3 || _tv.thin)) thinN++;
          }
        }
      } catch (_) {}
      var na = !!(r && r.axlx_learn_needs_auto);
      var via = _learnHasChromeStorage() ? "chrome" : "bridge";
      if (_audit) {
        _auditStepP(
          "learn_warm",
          "points=" + pk + " screen=" + sk + (thinN ? (" thin=" + thinN) : "") +
            (na ? " needs_auto" : "") + (force ? "（強制）" : "") + " via=" + via,
        );
      }
    } catch (_) {}
  }
  /**
   * 2026-11-14: 学んだ押す位置を**先に読み込んでおく**ための関数（地域・検索ボタンは名前が無く、
   *   `_kindOf(name)` を通らない＝読み込みの機会が無いまま押していた）。
   */
  /**
   * ★ 2026-11-17: Promise で待つ（自動開始直後に aim が空のまま押す抜けを止める）。
   */
  function _learnWarm(force, cb) {
    try {
      var now = Date.now();
      if (!force && _learnKinds && _learnScreen && !(now - _learnKindsAt > 30000)) {
        if (typeof cb === "function") try { cb(true); } catch (_) {}
        return Promise.resolve(true);
      }
      _learnKindsAt = now;
      var to = force ? 8000 : 4500;
      return _storageLocalGet(_LEARN_WARM_KEYS, to, !!force).then(function (r) {
        try { _learnKinds = (r && r.axlx_learn_points) || _learnKinds || {}; } catch (_) { _learnKinds = {}; }
        try { _learnScreen = (r && r.axlx_learn_screen) || _learnScreen || {}; } catch (_) { _learnScreen = {}; }
        try { _learnSceneMap = (r && r.axlx_learn_scene) || _learnSceneMap || {}; } catch (_) { _learnSceneMap = {}; }
        _auditLearnWarmFromState(r, force);
        if (typeof cb === "function") try { cb(true); } catch (_) {}
        return true;
      }, function () {
        _auditLearnWarmFromState(null, force);
        if (typeof cb === "function") try { cb(false); } catch (_) {}
        return false;
      });
    } catch (_) {
      if (typeof cb === "function") try { cb(false); } catch (_) {}
      return Promise.resolve(false);
    }
  }
  function _kindOf(name) {
    try {
      _learnWarm();
      var v = _learnKinds && _learnKinds[name];
      return v && (v.w || v.wk) ? String(v.w || v.wk) : null;
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
        _auditStepP('learn_aim', (tag || 'press') + ':' + (aim ? (aim.key + ' 横' + Math.round(aim.x * 100) + '% 縦' + Math.round(aim.y * 100) + '%（学び' + aim.n + '回）') : '学び無し→カーソル中央')
          + (opensKind ? '／開き方=' + opensKind : ''));
      }
    } catch (_) {}
    /**
     * ★ 2026-11-16 統括Pro「再現35%・カーソル62%・押した位置28%」:
     *   旧は学び無しの時 `simulateClick` 直押し → カーソルも位置も残らない（人間らしさの穴）。
     *   → **学びが無くても必ずカーソル移動してから押す**（aim 無し＝要素内の変則点）。
     */
    /**
     * ★ 2026-11-20 竹内さん「ちゃんと人間が動くような動きに」:
     *   旧は順番待ちの外で押し、カーソルが動いている間は「忙しい」に数えなかった（次の段と重なる）。
     *   待ちの繰り返しから呼ばれると、開閉するボタン（所在地絞り込み等）を続けて2回押して閉じる事もあった。
     *   → 動き始めから押し終わりまで _pressBusy に数える。同じ要素は1.6秒の間は押し直さない（clickByText と同じ）。
     */
    var _nowP = Date.now();
    if (_lastPressEl === el && _nowP - _lastPressAt < 1600) return true;
    _lastPressEl = el;
    _lastPressAt = _nowP;
    _pressBusy++;
    _pressBusyAt = _nowP;
    var _pdone = function () { _pressBusy = Math.max(0, _pressBusy - 1); };
    try {
      var _pp = _humanPointerClick(el, function () { simulateClick(el); }, aim || null);
      if (_pp && typeof _pp.then === "function") _pp.then(_pdone, _pdone); else _pdone();
      return true;
    } catch (_) { _pdone(); }
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
      var now = Date.now();
      if (_learnOpens && now - _learnOpensAt < 30000) return;
      _learnOpensAt = now;
      _storageLocalGet(["axlx_learn_opens"], 2500).then(function (r) {
        try { _learnOpens = (r && r.axlx_learn_opens) || _learnOpens || {}; } catch (_) { _learnOpens = {}; }
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
      var now = Date.now();
      if (_learnPlan && now - _learnPlanAt < 30000) return;
      _learnPlanAt = now;
      _storageLocalGet(["axlx_learn_plan"], 2500).then(function (r) {
        try { _learnPlan = (r && r.axlx_learn_plan) || _learnPlan || null; } catch (_) { _learnPlan = null; }
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

  /**
   * ★ 2026-11-15 竹内さん「学んだ『押す位置』を自動モードが実際に使っているか未検証」
   *   「その部分も強化するようにする」
   *
   *   ⚠ 学んだ位置（`points`）を `_aimOf` で引いて狙っているが、
   *     **実際に狙ったかどうかが記録に残っていなかった**ので、
   *     「学習が効いているか」を測れなかった。
   *   → 使った時に**1件だけ記録**を残す（`_aimUsed`）。
   *     - 欄の名前・狙った位置・学びがあったか・何回目の学びか
   *   ⚠ 中身（入力した値）は記録しない（名前と座標だけ）。
   */
  var _aimUsed = [];
  function _noteAimUsed(name, aim, why) {
    try {
      if (_aimUsed.length > 60) _aimUsed.shift();
      _aimUsed.push({
        f: String(name || "").slice(0, 30),
        x: aim && typeof aim.x === "number" ? Math.round(aim.x * 100) / 100 : null,
        y: aim && typeof aim.y === "number" ? Math.round(aim.y * 100) / 100 : null,
        // 学びが無くて狙えなかった時は why に理由（no_learn / few_times など）
        why: aim ? null : String(why || "").slice(0, 20),
        at: Date.now(),
      });
    } catch (_) {}
  }
  /** 点検に載せる形（拡張 → DB） */
  function _aimUsedForAudit() { try { return _aimUsed.slice(-30); } catch (_) { return []; } }
  try { window.__axlxAimUsedForAudit = _aimUsedForAudit; } catch (_) {}

  /**
   * ★ 2026-11-15 竹内さん「実装する」→ **画像の位置から要素を特定して押す**。
   *
   *   ⚠ なぜ必要か（実測）:
   *     自動モードは画像から **2,837欄** 読めているのに、押した位置は **30個** だけだった。
   *     理由は「押した記録がある欄しか狙えない」から。
   *   ⚠ なぜ「画面の位置をそのまま使う」と壊れるか:
   *     `_humanPointerClick` は `aim.x` を**要素の中の割合**として計算する。
   *     画面の位置（0.17）を渡すと **要素の中の17%** と解釈され、**違う所を押す**。
   *
   *   → **正しい手順**:
   *     ① 画面の位置（0〜1）を px に直す
   *     ② `document.elementFromPoint` で**その場所にある要素**を取る
   *     ③ その要素が**目的の欄か確かめる**（名前・種類が合うか）
   *     ④ 合えば、その要素の中の**真ん中**を押す（`aim` として返す）
   *        ⚠ 画像からは「要素の中のどこか」までは分からないので真ん中（人が押す位置に一番近い）
   *     ⑤ 合わなければ**使わない**（違う物を押さない）
   *
   *   ⚠ 拡張自身の小窓（#axlx- / #aixlinx-）に当たったら使わない。
   *   ⚠ 見えない要素・大きさ0の要素は使わない。
   */
  function _elementAtScreenPos(x, y, wantName, wantKind) {
    try {
      if (typeof document === "undefined" || !document.elementFromPoint) return null;
      var vw = (window.innerWidth || 0), vh = (window.innerHeight || 0);
      if (!(vw > 0 && vh > 0)) return null;
      var px = Math.max(0, Math.min(vw - 1, Math.round(x * vw)));
      var py = Math.max(0, Math.min(vh - 1, Math.round(y * vh)));
      var el = document.elementFromPoint(px, py);
      if (!el) return null;
      // ⚠ 拡張自身の小窓は押さない
      try {
        if (el.closest && el.closest('#axlx-bar, #axlx-guide, [data-axlx], [id^="axlx-"], [id^="aixlinx-"], [class^="axlx-"]')) return null;
      } catch (_) {}
      // ⚠ 見えない・大きさ0は使わない
      var r = el.getBoundingClientRect ? el.getBoundingClientRect() : null;
      if (!r || !(r.width > 2 && r.height > 2)) return null;
      /**
       * ③ 目的の欄か確かめる（名前が合うか）。
       *   ⚠ 画像の位置は**少しずれる**（撮影タイミング・画面の大きさ）ので、
       *     その要素から**近い祖先**も見て名前を探す（label の中の input など）。
       */
      var L2 = (typeof self !== "undefined" ? self : window).AxlxHumanLearn;
      var nameOf = function (e) { try { return L2 && L2.fieldName ? String(L2.fieldName(e) || "") : ""; } catch (_) { return ""; } };
      var want = String(wantName || "").replace(/^(左の|右の)/, "").replace(/｜[^｜]*$/, "").trim();
      var got = nameOf(el).replace(/^(左の|右の)/, "").replace(/｜[^｜]*$/, "").trim();
      var okName = false;
      if (want && got) {
        okName = got === want || (want.length >= 4 && got.length >= 4 && (got.indexOf(want) >= 0 || want.indexOf(got) >= 0));
      }
      /**
       * ⚠ 名前が合わない時は**祖先をたどる**（画像の位置は少しずれるので、
       *   近くの label・td・div が目的の欄を包んでいる事がある）。
       *   ⚠ ただし**3階層まで**（遠くまで探すと別の欄を押す）。
       */
      if (!okName && want) {
        var p = el;
        for (var up = 0; up < 3 && p; up++) {
          p = p.parentElement;
          if (!p) break;
          var pn = nameOf(p).replace(/^(左の|右の)/, "").replace(/｜[^｜]*$/, "").trim();
          if (pn && (pn === want || (want.length >= 4 && pn.indexOf(want) >= 0))) { el = p; okName = true; break; }
        }
      }
      if (!okName) return null;
      return { el: el, x: 0.5, y: 0.5, fromScreen: true };
    } catch (_) { return null; }
  }

  function _aimOf(name) {
    try {
      _learnWarm();
      var v = _learnKinds && _learnKinds[name];
      // ★ 完全一致が無ければ部分一致（room_layout / 検索 等の表記ゆれ）
      if ((!v || typeof v.x !== "number") && _learnKinds && name) {
        try {
          var _nk = String(name);
          var _keys = Object.keys(_learnKinds);
          // ★ 2026-11-18: 短いキーの部分一致で別欄のaimを拾い右ずれ・画面外になる実測あり
          //   → 完全一致優先。部分一致はキーが4文字以上かつ一方が他方の接頭/接尾に限る。
          var _partial = null;
          for (var _ai = 0; _ai < _keys.length; _ai++) {
            var _k = _keys[_ai];
            if (!_k) continue;
            var _cand0 = _learnKinds[_k];
            if (!_cand0 || typeof _cand0.x !== "number" || typeof _cand0.y !== "number") continue;
            if (_k === _nk) { v = _cand0; break; }
            if (!_partial && _k.length >= 4 && _nk.length >= 4
              && (_k.indexOf(_nk) === 0 || _nk.indexOf(_k) === 0
                || _k.slice(-_nk.length) === _nk || _nk.slice(-_k.length) === _k)) {
              _partial = _cand0;
            }
          }
          if ((!v || typeof v.x !== "number") && _partial) v = _partial;
        } catch (_) {}
      }
      /**
       * ★ 2026-11-18 場面ごとの位置（点の学習が弱い n<3 の時だけ・要素があれば使う）
       */
      if (!v || typeof v.x !== "number" || Number(v.n) < 3) {
        var _scn = _sceneOfName(name);
        var _sca = _scn ? _sceneAimOf(name, _scn) : null;
        if (_sca) {
          var _scf = _elementAtScreenPos(_sca.x, _sca.y, name, _sca.kind);
          if (_scf) {
            _noteAimUsed(name, { x: _scf.x, y: _scf.y, n: _sca.n, fromScreen: true, scene: _scn }, null);
            return { x: _scf.x, y: _scf.y, n: _sca.n, el: _scf.el, fromScreen: true, scene: _scn };
          }
        }
      }
      /**
       * ⚠ **狙えなかった理由も残す**（「学びが無い」のか「回数が足りない」のかで次が変わる）。
       *   実測の目安: `n < 2` は偶然かもしれないので使わない（今まで通り）。
       */
      if (!v || typeof v.x !== "number" || typeof v.y !== "number") {
        /**
         * ★ 2026-11-15 竹内さん「実装する」→ **画像の位置から要素を探して押す**。
         *
         *   ⚠ 画面の位置をそのまま `aim` にしない（要素の中の割合と意味が違う）。
         *   → 画面の位置に**実際にある要素**を取り、目的の欄か確かめてから使う。
         */
        var _sa = _screenAimOf(name);
        if (_sa) {
          var _found = _elementAtScreenPos(_sa.x, _sa.y, name, _sa.kind);
          if (_found) {
            _noteAimUsed(name, { x: _found.x, y: _found.y, n: _sa.n, fromScreen: true }, null);
            return { x: _found.x, y: _found.y, n: _sa.n, el: _found.el, fromScreen: true };
          }
          _noteAimUsed(name, null, "screen_no_element（画面の位置に目的の欄が無い）");
          return null;
        }
        _noteAimUsed(name, null, v ? "no_pos" : "no_learn");
        return null;
      }
      /**
       * ★ 2026-11-16 統括「押した位置28%」:
       *   旧は n<2 を捨てていた → 1回の学びも使わず位置%が上がらない。
       *   → n≥1 なら使う。画像位置があればそちらも候補（要素が取れれば画像優先）。
       */
      if (Number(v.n) < 1) {
        var _sa2 = _screenAimOf(name);
        if (_sa2) {
          var _f2 = _elementAtScreenPos(_sa2.x, _sa2.y, name, _sa2.kind);
          if (_f2) {
            _noteAimUsed(name, { x: _f2.x, y: _f2.y, n: _sa2.n, fromScreen: true }, null);
            return { x: _f2.x, y: _f2.y, n: _sa2.n, el: _f2.el, fromScreen: true };
          }
        }
        _noteAimUsed(name, null, "few_times:" + Number(v.n));
        return null;
      }
      if (Number(v.n) === 1) {
        var _sa1 = _screenAimOf(name);
        if (_sa1) {
          var _f1 = _elementAtScreenPos(_sa1.x, _sa1.y, name, _sa1.kind);
          if (_f1) {
            _noteAimUsed(name, { x: _f1.x, y: _f1.y, n: _sa1.n, fromScreen: true }, null);
            return { x: _f1.x, y: _f1.y, n: _sa1.n, el: _f1.el, fromScreen: true };
          }
        }
        // 画像が無い時は1回の押した位置でも使う（捨てない）
      }
      var aim = { x: v.x, y: v.y, n: Number(v.n) || 0 };
      _noteAimUsed(name, aim, null);
      return aim;
    } catch (_) { return null; }
  }

  /**
   * ★ 2026-11-15 竹内さん「理論上この通常のように自動もできる」「実装する」:
   *
   *   **画像から読んだ「画面のどこか」を狙う**（押した記録が無い欄でも狙える）。
   *
   *   ⚠ 実測: 自動モードは画像から2,837欄読めているのに、押した位置は30個だけだった。
   *     理由は「押した記録がある欄しか狙えない」から。
   *   ⚠ `_learnKinds`（`axlx_learn_points`）は**要素の中の割合**（0〜1）。
   *     画像の `x`/`y` は**画面全体の割合**（0〜1）で**意味が違う**。
   *     混ぜると狙いが外れるので、**別の入れ物**（`axlx_learn_screen`）から引く。
   */
  var _learnScreen = null;
  /**
   * ★ 2026-11-18 竹内さん「場面ごとの強化を画像学習にも紐づける」:
   *   場面（area=所在地・station=沿線駅・search=検索）ごとの画面位置（束 shots.learned_scene → axlx_learn_scene）。
   *   欄の名前から場面を決め、その場面の位置を先に引く（地域の○○と沿線の○○を混ぜない）。
   *   ⚠ 点の学習（axlx_learn_points・要素基準）が n≥3 の時はそちらを優先（今まで通り）。
   *   ⚠ 場面の位置は**要素があった時だけ**使う。無ければ従来の処理へ戻す（壊さない）。
   */
  var _learnSceneMap = null;
  function _sceneOfName(name) {
    var n = String(name || "");
    if (/^(city_code|town_code)\[\]$|^one_(city|town)$|所在地/.test(n)) return "area";
    if (/^(station_id|route_id)\[\]$|^one_(station|line)$|沿線|駅を選ぶ/.test(n)) return "station";
    if (/^go_search$|^検索$|住居検索/.test(n)) return "search";
    return null;
  }
  function _sceneAimOf(name, scene) {
    try {
      if (!scene || !_learnSceneMap || typeof _learnSceneMap !== "object") return null;
      var m = _learnSceneMap[scene];
      if (!m || typeof m !== "object") return null;
      var keys = [String(name || "")];
      var al = _SCREEN_AIM_ALIASES[String(name || "")];
      if (al && al.length) keys = keys.concat(al);
      var best = null;
      for (var i = 0; i < keys.length; i++) {
        var v = m[keys[i]];
        if (!v || typeof v.x !== "number" || typeof v.y !== "number") continue;
        if ((Number(v.n) || 0) < 2) continue;
        if (!best || (Number(v.n) || 0) > (Number(best.n) || 0)) {
          best = { x: v.x, y: v.y, n: Number(v.n) || 0, kind: v.kind || null, scene: scene, key: keys[i] };
        }
      }
      return best;
    } catch (_) { return null; }
  }
  /**
   * ★ 2026-11-15「新しくなったら新しくしたのもちゃんと把握」:
   *   ⚠ 旧は一度読んだらページを閉じるまで古いまま（束が更新されても自動に届かない）。
   *   → storage が変わったら取り直す。
   */
  try {
    if (chrome.storage && chrome.storage.onChanged) {
      chrome.storage.onChanged.addListener(function (changes, area) {
        if (area !== "local") return;
        if (changes.axlx_learn_screen) {
          try { _learnScreen = (changes.axlx_learn_screen.newValue) || {}; } catch (_) { _learnScreen = {}; }
        }
        if (changes.axlx_learn_scene) {
          try { _learnSceneMap = (changes.axlx_learn_scene.newValue) || {}; } catch (_) { _learnSceneMap = {}; }
        }
      });
    }
  } catch (_) {}
  /**
   * ★ 2026-11-17 統括Pro「aim無／細かい連動」:
   *   束の画面位置は日本語名・HTML名が混在。拡張は完全一致だけだと city_code[] が aim無になる。
   *   → 引き時に別名も見る（サーバー expand の保険）。
   */
  var _SCREEN_AIM_ALIASES = {
    "city_code[]": ["所在地絞り込み", "所在地を絞り込み", "区を選ぶ"],
    "所在地絞り込み": ["city_code[]", "区を選ぶ"],
    "route_id[]": ["沿線を選ぶ", "沿線・駅絞り込み＋", "沿線・駅絞り込み", "路線"],
    "沿線・駅絞り込み＋": ["route_id[]", "沿線を選ぶ"],
    "station_id[]": ["駅", "駅を選ぶ"],
    transportation_id: ["駅からの移動手段", "移動手段"],
    required_time: ["分数", "徒歩分数", "駅徒歩"],
    rental_cost1: ["賃料下限", "下限賃料", "賃料"],
    rental_cost2: ["賃料上限", "上限賃料", "賃料"],
    update_date: ["更新日"],
    structured_date: ["築年数", "築年"],
    "確定してリストへ": ["確定してリストへ｜span", "確定"],
    "確定してリストへ｜span": ["確定してリストへ", "確定"],
    "room_layout_id[]": ["1LDK", "2LDK", "3LDK", "1K", "1DK", "2K", "3K", "間取り", "間取り絞り込み", "間取り絞り込み＋"],
    "検索": ["go_search", "左の検索", "左の検索｜span", "住居検索"],
    "go_search": ["検索", "左の検索", "住居検索"],
  };
  function _screenAimOf(name) {
    try {
      /**
       * ★ 2026-11-17: 旧は `_learnScreen=undefined`（読込中）にして aim を全部 null にしていた。
       *   → 読み込み完了前の操作は学んだ位置を使えない抜け。
       *   → 読込中も **前の画面位置を残す**／未読なら裏で warm。
       * ★ 2026-11-17 統括Pro「aim無／point 35%」:
       *   旧 n≥3 のみ → flashの薄い位置が捨てられ aim無。n≥1 を使い、回数が多い方を優先。
       */
      if (_learnScreen === null) {
        try { _learnWarm(true); } catch (_) {}
        return null;
      }
      if (!_learnScreen || typeof _learnScreen !== "object") return null;
      var keys = [String(name || "")];
      var al = _SCREEN_AIM_ALIASES[String(name || "")];
      if (al && al.length) keys = keys.concat(al);
      var best = null;
      for (var i = 0; i < keys.length; i++) {
        var v = _learnScreen[keys[i]];
        if (!v || typeof v.x !== "number" || typeof v.y !== "number") continue;
        if (Number(v.n) < 1) continue;
        if (!best || (Number(v.n) || 0) > (Number(best.n) || 0)) {
          best = {
            x: v.x,
            y: v.y,
            screen: true,
            n: Number(v.n) || 0,
            fromScreen: true,
            thin: (Number(v.n) || 0) < 3 || !!v.thin,
            key: keys[i],
          };
        }
      }
      return best;
    } catch (_) { return null; }
  }

  function queueSelVal(name, val) {
    var el = document.querySelector('select[name="' + name + '"]');
    /**
     * ★ 2026-11-16: 欄がまだ無い時も、後から取れたら chooseSelectLikeHuman（直接 setSelVal しない）。
     */
    if (!el) {
      enqueueHumanAction(function () {
        try { _auditStepP("op_path_retry", "sel:" + name); } catch (_) {}
        var e2 = document.querySelector('select[name="' + name + '"]');
        if (e2) return chooseSelectLikeHuman(e2, val, { forceOpen: true, field: name });
        try { _auditStepP("op_path_direct_miss", "sel:" + name); } catch (_) {}
        return setSelValHuman(name, val);
      }, _uiGapMin(), _uiGapMax(), 'sel:' + name + '=' + val);
      return;
    }
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
     * ★ 2026-11-17: 徒歩（移動手段）＋分数プルダウンは人が一覧を見る時間が要る。
     *   直近自動で徒歩が押せない報告 → 待ちを長くし、必ず擬似一覧経由。
     */
    var _isWalkLike = _isTransport || name === "required_time";
    /**
     * ★ 2026-11-16 録画: 賃料プルダウンが早すぎる。
     *   賃料・更新日・築年・面積は人が一覧を目で探す時間が要る → 待ちを長くする。
     */
    var _isRentLike = /^(rental_cost1|rental_cost2|update_date|structured_date|square_meter_l|square_meter_h)$/.test(name);
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
    _enqueueWithEl(el, function () {
      /**
       * ★ 2026-11-16 竹内さん「何回も家賃の部分選択してしまう」:
       *   録画で `rental_cost2` が連続3〜6回。原因は (1) すでに正しいのに forceOpen で再選択
       *   (2) 関所が別欄のずれでも家賃を入れ直す (3) click 記録の多重。
       *   → **すでに正しい値なら開かない**（わざと押し直す必要はない）。
       */
      try {
        if (_selMatchesWant(el, val)) {
          if (_audit) _auditStepP("sel_skip_same", name + "=\"" + val + "\"（既に同じ→押し直ししない）");
          return Promise.resolve(true);
        }
      } catch (_) {}
      return chooseSelectLikeHuman(el, val, { forceOpen: true, aim: _aim, slow: _isRentLike || _isWalkLike, field: name });
    },
      _isWalkLike ? 1600 : (_isRentLike ? 1800 : 900),
      _isWalkLike ? 3000 : (_isRentLike ? 3400 : 1600),
      'sel:' + name + '=' + val,
      _aim);
  }
  function queueTxtVal(name, val) {
    var el = document.querySelector('input[name="' + name + '"]');
    if (!el) {
      enqueueHumanAction(function () {
        try { _auditStepP("op_path_retry", "txt:" + name); } catch (_) {}
        var e2 = document.querySelector('input[name="' + name + '"]');
        if (e2) return typeTextLikeHuman(e2, val); // 未着→内部でカーソル移動
        try { _auditStepP("op_path_direct_miss", "txt:" + name); } catch (_) {}
        return setTxtVal(name, val);
      }, _uiGapMin(), _uiGapMax(), 'txt:' + name + '=' + val);
      return;
    }
    var _aimTxt = _aimOf(name);
    _enqueueWithEl(el, function () { return typeTextLikeHuman(el, val, { alreadyAimed: true }); }, _uiGapMin(), _uiGapMax(), 'txt:' + name + '=' + val, _aimTxt);
  }
  /**
   * 2026-11-14 竹内さん「駅からの移動手段のところ 徒歩をプルダウンで選択するところできていなかった」:
   *   **値ではなく「文字」で選ぶ**プルダウン。値がサイト側で変わっても（"1" でなくても）選べる。
   *   `chooseSelectLikeHuman` は「値一致 → 文字一致」の順で探すので、値を `"徒歩"` として渡せば
   *   文字一致の所で当たる。⚠ 見つからなければ**先頭（未選択）にしない**で、そのまま返す。
   */
  /**
   * ★ 2026-11-16 竹内さん「徒歩もおしたあとに絶対にきえてしまう」／統括: transportation_id・required_time が弱い:
   *
   *   RealNet の仕組み（両方とも起きる）:
   *     A) 移動手段を選ぶ → 分数がリセットされる
   *     B) 分数を入れる → 移動手段が空になる（録画 sel_mismatch got:''）
   *   旧 reseal は「徒歩を戻す→分数を打ち直す→終わり」で、打ち直した瞬間にまた徒歩が消えていた。
   *
   *   → 対で締める: ①UIで徒歩 ②UIで分数 ③待って確認 ④足りない方を**カーソル付きで**直す
   *     （直接 value 代入はしない。開いて選ぶ／欄を押して打つ。最大4ラウンド）
   */
  function _walkTrText() {
    try {
      var tr = document.querySelector('select[name="transportation_id"]');
      if (!tr || !tr.options || tr.selectedIndex < 0) return "";
      return String(tr.options[tr.selectedIndex].textContent || "").replace(/\s+/g, "");
    } catch (_) { return ""; }
  }
  function _walkMinVal() {
    try {
      var inp = document.querySelector('input[name="required_time"]');
      if (inp) return String(inp.value || "");
      /** リアプロは分数が select の回もある（徒歩プルダウンと並ぶ） */
      var sel = document.querySelector('select[name="required_time"]');
      if (sel && sel.selectedIndex >= 0) {
        var opt = sel.options[sel.selectedIndex];
        return String((opt && (opt.value || opt.textContent)) || "").replace(/\s+/g, "");
      }
      return "";
    } catch (_) { return ""; }
  }
  function _findWalkOptionIndex(tr) {
    try {
      for (var i = 0; i < tr.options.length; i++) {
        var t = String(tr.options[i].textContent || "").replace(/\s+/g, "");
        if (t.indexOf("徒歩") >= 0 && !/指定なし|こだわらない/.test(t)) return i;
      }
    } catch (_) {}
    return -1;
  }
  /**
   * ★ 2026-11-16 竹内さん「直接入力禁止／カーソル移動して押す」:
   *   旧は selectedIndex/value 代入（カーソルあっても直接入力）。
   *   → **必ず chooseSelectLikeHuman**（開いて徒歩を選ぶ）。fireChange は互換のため残す。
   */
  function _setWalkHumanQuiet(_fireChange) {
    var tr = document.querySelector('select[name="transportation_id"]');
    if (!tr) return Promise.resolve(false);
    if (_findWalkOptionIndex(tr) < 0) return Promise.resolve(false);
    return Promise.resolve(chooseSelectLikeHuman(tr, "徒歩", { forceOpen: true, field: "transportation_id" }));
  }
  function _setWalkMinHumanQuiet(walkMinutes) {
    if (walkMinutes == null) return Promise.resolve(false);
    /**
     * ★ 2026-11-17: 分数が select の画面では chooseSelectLikeHuman（徒歩プルダウンと同じ経路）。
     *   input の時だけ type。直接 value 代入はしない。
     */
    var sel = document.querySelector('select[name="required_time"]');
    if (sel) {
      return Promise.resolve(chooseSelectLikeHuman(sel, String(walkMinutes), {
        forceOpen: true,
        slow: true,
        field: "required_time",
      }));
    }
    var inp = document.querySelector('input[name="required_time"]');
    if (!inp) return Promise.resolve(false);
    return _operateWithPointer(inp, function () {
      return typeTextLikeHuman(inp, walkMinutes, { alreadyAimed: true });
    });
  }
  /**
   * ★ 2026-11-16: 擬似一覧の開閉は**1検索あたり徒歩1回まで**（連打・画面チラつきの元）。
   *   opts.allowUi=false → 一覧なしだが**カーソル付き**で直す（直接代入はしない）。
   */
  function _resealWalkAfterMinutes(walkMinutes, opts) {
    var o = opts || {};
    return _sealWalkPair(walkMinutes, 0, { allowUi: o.allowUi !== false });
  }
  function _sealWalkPair(walkMinutes, round, opts) {
    var r = Number(round) || 0;
    var o = opts || {};
    var allowUi = o.allowUi !== false && !window._axWalkUiSealedOnce;
    return new Promise(function (resolve) {
      try {
        if (r >= 3) {
          try { if (window._axlxAuditStep) window._axlxAuditStep("walk_seal_fail", "徒歩+分数が揃わない tr=" + _walkTrText() + " min=" + _walkMinVal()); } catch (_) {}
          resolve(false);
          return;
        }
        var trOk = _walkTrText().indexOf("徒歩") >= 0;
        var minGot = _walkMinVal();
        var minOk = walkMinutes == null ||
          minGot === String(walkMinutes) ||
          (minGot && String(minGot).indexOf(String(walkMinutes)) >= 0);
        if (trOk && minOk) {
          try { if (window._axlxAuditStep) window._axlxAuditStep("walk_seal_ok", "徒歩+分数 OK（r" + r + "）"); } catch (_) {}
          resolve(true);
          return;
        }
        var tr = document.querySelector('select[name="transportation_id"]');
        if (!tr) { resolve(false); return; }

        var afterFix = function () {
          setTimeout(function () { _sealWalkPair(walkMinutes, r + 1, { allowUi: false }).then(resolve, resolve); }, _ln(500, 0.35, 350, 800));
        };

        // UIは1回だけ（擬似一覧）。それ以外はカーソル付き quiet
        if (r === 0 && !trOk && allowUi) {
          window._axWalkUiSealedOnce = true;
          try { if (window._axlxAuditStep) window._axlxAuditStep("walk_reseal", "徒歩をUIで戻す（この検索で一覧はこれ1回）"); } catch (_) {}
          Promise.resolve(chooseSelectLikeHuman(tr, "徒歩", { forceOpen: true })).then(function () {
            var p = (walkMinutes != null && _walkMinVal() !== String(walkMinutes))
              ? _setWalkMinHumanQuiet(walkMinutes)
              : Promise.resolve(true);
            p.then(function () {
              setTimeout(function () { _sealWalkPair(walkMinutes, 1, { allowUi: false }).then(resolve, resolve); }, _ln(700, 0.35, 450, 1100));
            }, afterFix);
          }, function () { _sealWalkPair(walkMinutes, 1, { allowUi: false }).then(resolve, resolve); });
          return;
        }

        try { if (window._axlxAuditStep) window._axlxAuditStep("walk_reseal_quiet", "カーソル付きで徒歩+分数（r" + r + "・一覧なし）"); } catch (_) {}
        var chain = Promise.resolve(true);
        if (!trOk) chain = chain.then(function () { return _setWalkHumanQuiet(true); });
        if (walkMinutes != null && (!minOk || !trOk)) {
          chain = chain.then(function () { return _setWalkMinHumanQuiet(walkMinutes); });
        }
        chain.then(afterFix, afterFix);
      } catch (_) { resolve(false); }
    });
  }

  function queueSelValText(name, text) {
    var el = document.querySelector('select[name="' + name + '"]');
    if (!el) {
      enqueueHumanAction(function () {
        try { _auditStepP("op_path_retry", "selText:" + name); } catch (_) {}
        var e2 = document.querySelector('select[name="' + name + '"]');
        if (e2) return chooseSelectLikeHuman(e2, text, { forceOpen: true, field: name });
        try { _auditStepP("op_path_direct_miss", "selText:" + name); } catch (_) {}
        return setSelValHuman(name, text);
      }, _uiGapMin(), _uiGapMax(), 'sel:' + name + '=' + text);
      return;
    }
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
        // ★ 2026-11-20: 表示がそのまま欲しい値なら開き直さない（人は選び済みの欄を開いて同じ物を選ばない）
        if (_cur === String(text).replace(/\s+/g, "")) return;
      }
    } catch (_) {}
    _enqueueWithEl(el, function () { return chooseSelectLikeHuman(el, text, { forceOpen: true, aim: _aim2 }); },
      1400, 2600, 'sel:' + name + '=' + text, _aim2);
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
        /**
         * 2026-11-14 竹内さん「自動検索の部分これでちゃんと強化されたかな」:
         *   **場面ごとの手順**（`scene_flows`＝人が実際に押した順をサーバーが場面に分けた物）も重ねる。
         *   ⚠ ここが 0箇所だったので「計算したが現場に届かない」状態だった（`screen_flow` と同じ穴）。
         *   ⚠ `steps` は**欄の名前の並び**（例: 所在地絞り込み＋ → 大阪市西区 → city_code[] …）。
         *     集合に居る名前だけが前後関係として効く（居ない名前は無視される＝項目は増減しない）。
         *   ⚠ 2回以上見た手順だけ使う（1回だけの偶然を採らない）。
         */
        var sceneFlows = window.__axlxLearnSceneFlows || null;
        if (Array.isArray(sceneFlows) && LO.mergeWithSequence) {
          for (var _sf = 0; _sf < sceneFlows.length; _sf++) {
            var _f = sceneFlows[_sf] || {};
            var _st = Array.isArray(_f.steps) ? _f.steps : [];
            if (_st.length < 2) continue;
            if (Number(_f.runs) < 2) continue;
            // 集合に居る名前だけで鎖を作る（居ない名前は前後関係を作れない）
            var _chain2 = [];
            for (var _si = 0; _si < _st.length; _si++) {
              var _nm = String(_st[_si] || "");
              if (!_nm) continue;
              if (names.indexOf(_nm) < 0) continue;
              if (_chain2.indexOf(_nm) < 0) _chain2.push(_nm);
            }
            if (_chain2.length >= 2) next = LO.mergeWithSequence(next, _chain2, names);
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
      /**
       * ★ 2026-11-16 竹内さん「毎回違う動き／変則／人間のように」:
       *   学んだ直接の組だけ守る。それ以外は毎回入れ替え（wobble 高め・最大3回）。
       */
      var r = LO.orderByLearned(items, function (it) { return it && it.name ? it.name : null; }, next, { min: 2, wobble: 0.72, maxSwaps: 3 });
      if (r && (r.changed || r.wobbled)) {
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
  function _applyLearnNextStorage(r) {
    try {
      var nx = (r && r.axlx_learn_next) || null;
      window.__axlxLearnNext = (nx && typeof nx === "object") ? nx : null;
      var sf = (r && r.axlx_learn_site_flow) || null;
      window.__axlxLearnSiteFlow = (sf && typeof sf === "object") ? sf : null;
      var sq = (r && r.axlx_learn_seq) || null;
      window.__axlxLearnSeq = (sq && typeof sq === "object") ? sq : null;
      var mn = (r && r.axlx_learn_next_mode) || null;
      window.__axlxLearnNextMode = (mn && typeof mn === "object") ? mn : null;
      var scf = (r && r.axlx_learn_screen_flow) || null;
      window.__axlxLearnScreenFlow = (scf && typeof scf === "object") ? scf : null;
      var sflows = (r && r.axlx_learn_scene_flows) || null;
      window.__axlxLearnSceneFlows = Array.isArray(sflows) ? sflows : null;
      window.__axlxLearnStoppedScene = (r && r.axlx_learn_stopped_scene) || null;
      window.__axlxLearnSceneMissing = (r && r.axlx_learn_scene_missing) || null;
      // 手順書（場面の手順・1手ずつの細部・自動の決まり）。key が来ない呼び出しでは前の値を残す
      if (r && Object.prototype.hasOwnProperty.call(r, "axlx_learn_playbook")) {
        var _pb = r.axlx_learn_playbook || null;
        window.__axlxLearnPlaybook = (_pb && typeof _pb === "object") ? _pb : null;
      }
      // 束の人の押す間隔（中央値）。選ぶレーンの速さの基準。key が来ない呼び出しでは前の値を残す
      if (r && Object.prototype.hasOwnProperty.call(r, "axlx_learn_gaps")) {
        var _gp = r.axlx_learn_gaps || null;
        var _gms = _gp ? Number(_gp.median_ms) : 0;
        var _gn = _gp ? Number(_gp.samples) : 0;
        window.__axlxLearnGapMs = (_gms > 0 && _gn >= 10) ? Math.max(800, Math.min(3000, _gms)) : null;
      }
      var n = nx ? Object.keys(nx).length : 0;
      var sqn = (sq && Array.isArray(sq.sequence)) ? sq.sequence.length : 0;
      var scn = scf ? Object.keys(scf).length : 0;
      var sfn = Array.isArray(sflows) ? sflows.length : 0;
      if (n || sqn) console.log("[AX] 学んだ押す順番: " + n + "通り・一連の動き " + sqn + "手" + (mn ? "・モード別あり" : "") + (scn ? "・画面ごと " + scn + "種類" : "") + (sfn ? "・場面ごと " + sfn + "種類" : ""));
    } catch (_) {}
  }
  function _loadLearnNext(force) {
    try {
      var now = Date.now();
      if (!force && now - _learnNextAt < 30000) return;
      _learnNextAt = now;
      if (_learnHasChromeStorage()) {
        chrome.storage.local.get(_LEARN_NEXT_KEYS, function (r) {
          _applyLearnNextStorage(r);
          _learnCacheSave(r);
        });
        return;
      }
      var cached = _learnCacheLoad(_LEARN_NEXT_KEYS);
      if (cached) _applyLearnNextStorage(cached);
    } catch (_) {}
  }
  /** ★ 2026-11-17: 反映関所用（強制・Promise）。30秒スロットルを跨がない。 */
  function _loadLearnNextAsync(force) {
    try {
      if (force) _learnNextAt = 0;
      return _storageLocalGet(_LEARN_NEXT_KEYS, force ? 8000 : 4500, !!force).then(function (r) {
        _learnNextAt = Date.now();
        _applyLearnNextStorage(r);
        return true;
      }, function () { return false; });
    } catch (_) {
      return Promise.resolve(false);
    }
  }
  try {
    window.addEventListener("message", function (e) {
      if (e.source !== window || !e.data || e.data.from !== "axlx-page-learn-push") return;
      try {
        var d = e.data.data;
        if (d && typeof d === "object") {
          var _wasEmpty = !_learnScreen || typeof _learnScreen !== "object" || !Object.keys(_learnScreen).length;
          _learnCacheSave(d);
          _applyLearnStoragePayload(d);
          try {
            var _nowN = (d.axlx_learn_screen && typeof d.axlx_learn_screen === "object") ? Object.keys(d.axlx_learn_screen).length : 0;
            if (_audit && _wasEmpty && _nowN > 0) _auditStepP("learn_screen_late", "画面位置が後から届いた screen=" + _nowN);
          } catch (_) {}
        }
      } catch (_) {}
    });
  } catch (_) {}
  /**
   * ★ 2026-11-17 統括Pro「screen=0／reflect_gap／aim無」:
   *   自動開始前に束を強制取込→warm→場面手順を読み、反映関所を残す。
   *   空のまま押し始めない（キュー先頭で待つ）。
   */
  var _AXLX_PAGE_VER = "2.8.142";
  /**
   * この拡張に入っている自動の決まり（id）。正本は app/lib/auto-procedure-rules.ts の AUTO_RULES。
   *   ⚠ 決まりを足す・変える時は向こうと同時に直す（テスト auto-procedure-rules.test.ts が食い違いを止める）。
   */
  var _AXLX_RULES_DONE = [
    "order_human", "area_before_cond", "no_reset_button", "clear_per_panel", "no_hidden_press",
    "pet_confirm", "confirm_decide", "search_decide", "walk_presearch", "hidden_work_no_pause",
    "select_one_press", "checkbox_settle", "ward_pace", "pick_pace", "playbook_read", "audit_one_progress",
    "one_cursor",
  ];
  /**
   * ★ 2026-11-20 竹内さん「同時に２つマウス出現しないように」「マウスの色や…形が実際の人間の形と違う」:
   *   見えるカーソル（pointer-ui）が「1つのカーソル」の作りか、入力を始める時に点検記録へ残す。
   *   cursor_one: 要素の数=1 の時。cursor_two: 2つ以上・cursor_old: 古い pointer-ui（2つの世界で別々に動く作り）。
   */
  function _auditOneCursor() {
    if (!_audit) return;
    var P = window.AxlxPointerUi;
    if (!P || typeof P.oneCursorInfo !== "function") {
      _auditStepP("cursor_old", "pointer-ui が古い（1つのカーソルの作りでない） page=" + _AXLX_PAGE_VER);
      return;
    }
    var info = P.oneCursorInfo() || {};
    var n = Number(info.count) || 0;
    _auditStepP(n > 1 ? "cursor_two" : "cursor_one", "要素=" + n + " OSを隠す=" + (info.os_hidden ? 1 : 0) + " 形=" + String(info.shape || "-"));
  }
  /**
   * 手順書を読んだ印を点検記録に残す（DB の手順書と、この拡張の決まりが揃っているかを後から数えて確かめる）。
   *   playbook_seen: v=手順書の版 rv=決まりの版 決まり=拡張に有る数/手順書の数 無い=拡張に無い決まり 手順書に無い=手順書が古い分 場面=数 手=数
   *   playbook_none: 手順書が届いていない（学習の取り込みを見直す）
   */
  function _auditPlaybookSeen() {
    if (!_audit) return;
    var pb = window.__axlxLearnPlaybook;
    if (!pb || typeof pb !== "object" || !Array.isArray(pb.scenes)) {
      _auditStepP("playbook_none", "手順書が届いていない page=" + _AXLX_PAGE_VER);
      return;
    }
    var ids = Array.isArray(pb.rules) ? pb.rules.map(function (x) { return String((x && x.id) || ""); }).filter(Boolean) : [];
    var have = 0, lack = [], extra = [];
    for (var i = 0; i < ids.length; i++) {
      if (_AXLX_RULES_DONE.indexOf(ids[i]) >= 0) have++; else lack.push(ids[i]);
    }
    for (var j = 0; j < _AXLX_RULES_DONE.length; j++) {
      if (ids.indexOf(_AXLX_RULES_DONE[j]) < 0) extra.push(_AXLX_RULES_DONE[j]);
    }
    var hands = 0;
    for (var s = 0; s < pb.scenes.length; s++) {
      var sc = pb.scenes[s] || {};
      hands += Array.isArray(sc.detail) ? sc.detail.length : (Array.isArray(sc.steps) ? sc.steps.length : 0);
    }
    var _short = function (a) { return a.length ? (a.slice(0, 2).join(",") + (a.length > 2 ? ",+" + (a.length - 2) : "")) : "-"; };
    _auditStepP(
      "playbook_seen",
      "v=" + String(pb.version || "-").slice(0, 8) +
        " rv=" + String(pb.rules_v || "-").slice(0, 8) +
        " 決まり=" + have + "/" + ids.length +
        " 無い=" + _short(lack) +
        " 手順書に無い=" + _short(extra) +
        " 場面=" + pb.scenes.length + " 手=" + hands,
    );
  }
  /**
   * ★ 2026-11-17 統括Pro徹底「全流れ地図の土台／ボタン・外し・細分化強化の仕組み」:
   *   検索→送付→完了→次客→外し→次条件 の原子を1枚の地図として把握する。
   *   6段（F45）は幹。細分化原子で弱い所だけ次に強化する（新規地図を増やさない・既存活用）。
   */
  var _FLOW_MAP_ATOMS = [
    "switch",           // 客切替
    "place_clear",      // 前客の場所を外す
    "place_select",     // 新客の場所を入れる
    "line_station",     // 沿線↔駅の関係（地図）
    "conditions",       // 条件欄
    "btn_grasp",        // どのボタンを押したか理解
    "search",           // 検索押下
    "fill_done",        // 入力一連完了
    "ready_next",       // 次客へ渡してよい
    "next_clear",       // 次客前の外し
  ];
  function _noteFlowAtom(atom, ok, detail) {
    try {
      if (!window.__axlxFlowMapAtoms) window.__axlxFlowMapAtoms = {};
      var a = String(atom || "").slice(0, 28);
      if (!a) return;
      window.__axlxFlowMapAtoms[a] = {
        ok: !!ok,
        at: Date.now(),
        d: String(detail || "").slice(0, 80),
      };
      if (_audit) {
        _auditStepP(
          ok ? ("flow_atom_ok_" + a) : ("flow_atom_gap_" + a),
          String(detail || (ok ? "原子OK" : "原子不足")).slice(0, 100),
        );
      }
    } catch (_) {}
  }
  function _noteClearMethod(kind, method, detail) {
    try {
      if (!window.__axlxClearMethodUnderstood) window.__axlxClearMethodUnderstood = {};
      var k = String(kind || "place").slice(0, 20);
      window.__axlxClearMethodUnderstood[k] = {
        method: String(method || "").slice(0, 40),
        at: Date.now(),
        d: String(detail || "").slice(0, 60),
      };
      if (_audit) {
        _auditStepP(
          "clear_method_" + k,
          String(method || "") + (detail ? (" " + String(detail).slice(0, 50)) : ""),
        );
      }
      _noteFlowAtom("place_clear", true, k + ":" + method);
      _noteFlowAtom("next_clear", true, k + ":" + method);
    } catch (_) {}
  }
  /**
   * 全流れ地図台帳: 幹6段＋細分化原子＋ボタン理解＋外し方＋沿線駅地図＋今客。
   * 弱い原子を flow_subdivide_need に列挙 → 細分化強化の次手にする仕組み。
   */
  function _auditFullFlowMapLedger(where) {
    try {
      var flow = window.__axlxFlowUnderstood || {};
      var atoms = window.__axlxFlowMapAtoms || {};
      var btns = window.__axlxBtnUnderstood || {};
      var clears = window.__axlxClearMethodUnderstood || {};
      var now = window.__axlxNowCustomer || null;
      var mapOk = !!_lineStationMap();
      var btnOk = 0, btnFail = 0;
      try {
        Object.keys(btns).forEach(function (k) { if (btns[k]) btnOk++; else btnFail++; });
      } catch (_) {}
      if (btnOk > 0) _noteFlowAtom("btn_grasp", true, "ok=" + btnOk);
      else _noteFlowAtom("btn_grasp", false, "ボタン理解0");
      if (mapOk) _noteFlowAtom("line_station", true, "STATION_LINE_MAP載");
      else _noteFlowAtom("line_station", false, "地図未注入");
      if (flow.place && flow.place.ok) _noteFlowAtom("place_select", true, "place済");
      if (flow.conditions && flow.conditions.ok) _noteFlowAtom("conditions", true, "条件済");
      if (flow.search && flow.search.ok) _noteFlowAtom("search", true, "検索済");
      if (flow.fill_done && flow.fill_done.ok) _noteFlowAtom("fill_done", true, "入力完了");
      if (flow.ready_next && flow.ready_next.ok) _noteFlowAtom("ready_next", true, "次可");
      if (flow.switch && flow.switch.ok) _noteFlowAtom("switch", true, "切替済");

      atoms = window.__axlxFlowMapAtoms || {};
      var okAtoms = [], gapAtoms = [];
      for (var i = 0; i < _FLOW_MAP_ATOMS.length; i++) {
        var id = _FLOW_MAP_ATOMS[i];
        if (atoms[id] && atoms[id].ok) okAtoms.push(id);
        else gapAtoms.push(id);
      }
      var clearKeys = Object.keys(clears);
      var clearBrief = clearKeys.slice(0, 4).map(function (ck) {
        return ck + "=" + (clears[ck] && clears[ck].method ? clears[ck].method : "?");
      }).join(",");

      if (_audit) {
        _auditStepP(
          "flow_map_ledger",
          String(where || "map") +
            " 幹ok=" + okAtoms.length + "/" + _FLOW_MAP_ATOMS.length +
            " 地図=" + (mapOk ? "Y" : "N") +
            " ボタンok=" + btnOk + "/fail=" + btnFail +
            (clearBrief ? (" 外し=" + clearBrief) : " 外し=未") +
            (now && now.phase ? (" 今客段=" + now.phase) : "") +
            (gapAtoms.length ? (" 弱=[" + gapAtoms.slice(0, 6).join(",") + "]") : " 弱=[]"),
        );
        if (gapAtoms.length) {
          _auditStepP(
            "flow_subdivide_need",
            "次に細分化=" + gapAtoms.slice(0, 5).join(",") +
              "（既存F45/F46/ボタン台帳/地図を活用・新規地図を増やさない）",
          );
        } else {
          _auditStepP("flow_subdivide_ok", "全流れ原子OK・細分化待ちなし");
        }
      }
      try {
        window.postMessage({
          from: "axlx-rec-note-name",
          name: ("流れ地図:" + okAtoms.length + "/" + _FLOW_MAP_ATOMS.length + (gapAtoms.length ? " 弱" + gapAtoms.length : "")).slice(0, 40),
        }, "*");
      } catch (_) {}
      return { ok: gapAtoms.length === 0, okAtoms: okAtoms, gapAtoms: gapAtoms };
    } catch (_) {
      return { ok: false, okAtoms: [], gapAtoms: _FLOW_MAP_ATOMS.slice() };
    }
  }
  /**
   * ★ 2026-11-17 F46: 録画の場面流れ（area/cond/search/station）が自動に載っているか測る。
   *   駅だけ見ていた旧穴を閉じ、弱い流れ→強化→自動反映の関所にする。
   */
  function _auditFlowLearnReflect(where) {
    try {
      var flows = window.__axlxLearnSceneFlows;
      var hit = { area: false, station: false, cond: false, search: false };
      var stepsN = { area: 0, station: 0, cond: 0, search: 0 };
      if (Array.isArray(flows)) {
        for (var i = 0; i < flows.length; i++) {
          var f = flows[i] || {};
          var sc = String(f.scene || "");
          if (!hit.hasOwnProperty(sc)) continue;
          var st = Array.isArray(f.steps) ? f.steps : [];
          stepsN[sc] = st.length;
          if (st.length > 0) hit[sc] = true;
        }
      }
      var placeOk = hit.area || hit.station;
      var condOk = hit.cond;
      var searchOk = hit.search;
      var allOk = placeOk && condOk && searchOk;
      if (_audit) {
        _auditStepP(
          allOk ? "learn_flow_reflect_ok" : "learn_flow_reflect_gap",
          String(where || "reflect") +
            " area=" + (hit.area ? "Y" + stepsN.area : "N") +
            " station=" + (hit.station ? "Y" + stepsN.station : "N") +
            " cond=" + (hit.cond ? "Y" + stepsN.cond : "N") +
            " search=" + (hit.search ? "Y" + stepsN.search : "N"),
        );
      }
      try {
        window.postMessage({
          from: "axlx-rec-note-name",
          name: (allOk ? "流れ反映OK" : "流れ反映不足").slice(0, 40),
        }, "*");
      } catch (_) {}
      return { ok: allOk, hit: hit, stepsN: stepsN };
    } catch (_) {
      return { ok: false, hit: {}, stepsN: {} };
    }
  }
  /**
   * ★ 今どのお客さんを検索しているか／完了までの段を常に把握する台帳。
   */
  function _noteNowCustomer(phase, detail) {
    try {
      var id = _fillCustomerId || window._axFillRunningCustomerId || null;
      var name = null;
      try {
        if (_fillCondForStamp && _fillCondForStamp.customer_name) name = String(_fillCondForStamp.customer_name).slice(0, 24);
      } catch (_) {}
      var flow = window.__axlxFlowUnderstood || {};
      var doneParts = [];
      var gapParts = [];
      var phases = ["switch", "place", "conditions", "search", "fill_done", "ready_next"];
      for (var i = 0; i < phases.length; i++) {
        var ph = phases[i];
        if (flow[ph] && flow[ph].ok) doneParts.push(ph);
        else gapParts.push(ph);
      }
      window.__axlxNowCustomer = {
        id: id ? String(id) : null,
        name: name,
        phase: String(phase || "").slice(0, 24),
        at: Date.now(),
        done: doneParts.slice(),
        gap: gapParts.slice(),
      };
      if (_audit) {
        _auditStepP(
          "now_customer",
          String(phase || "phase") +
            " cid=" + (id ? String(id).slice(0, 8) : "-") +
            (name ? (" name=" + name) : "") +
            " 完了=[" + doneParts.join(",") + "]" +
            (gapParts.length ? (" 未=[" + gapParts.join(",") + "]") : "") +
            (detail ? (" " + String(detail).slice(0, 40)) : ""),
        );
      }
      try {
        // ★ 2026-11-20 (2.8.134): 学習の記録（shot_ops）にお客さんの名前を入れない（段だけ残す）
        window.postMessage({
          from: "axlx-rec-note-name",
          name: ("今の客:" + String(phase || "")).slice(0, 40),
        }, "*");
      } catch (_) {}
    } catch (_) {}
  }
  function _ensureLearnReflectedForFill() {
    return new Promise(function (resolve) {
      try { if (_audit) _auditStepP("learn_reflect_gate", "取込開始 page=" + _AXLX_PAGE_VER); } catch (_) {}
      try { if (_audit) _auditStepP("page_ver", _AXLX_PAGE_VER); } catch (_) {}
      var done = function () {
        try {
          var _sf = window.__axlxLearnSceneFlows;
          var _sfn = Array.isArray(_sf) ? _sf.length : 0;
          var _sk = (_learnScreen && typeof _learnScreen === "object") ? Object.keys(_learnScreen).length : 0;
          var _stHit = false;
          if (Array.isArray(_sf)) {
            for (var _i = 0; _i < _sf.length; _i++) {
              var _f = _sf[_i] || {};
              if (String(_f.scene || "") !== "station") continue;
              var _st = Array.isArray(_f.steps) ? _f.steps.join(" ") : "";
              if (/駅の設定へ進む|沿線の設定へ戻る|one_station|one_line/.test(_st)) _stHit = true;
            }
          }
          var _flowR = { ok: false };
          try { _flowR = _auditFlowLearnReflect("取込後"); } catch (_) {}
          try { _auditLineStationMap(_fillCondForStamp); } catch (_) {}
          try { _auditFullFlowMapLedger("reflect_done"); } catch (_) {}
          try { _auditPlaybookSeen(); } catch (_) {}
          try { _auditOneCursor(); } catch (_) {}
          if (_audit) {
            _auditStepP(
              (_stHit && _sk > 0) ? "learn_reflect_ok" : "learn_reflect_gap",
              (_stHit && _sk > 0)
                ? ("束反映OK scenes=" + _sfn + " screen=" + _sk + " flow=" + (_flowR.ok ? "Y" : "N"))
                : ("束反映不足 scenes=" + _sfn + " screen=" + _sk + " flow=" + (_flowR.ok ? "Y" : "N")),
            );
          }
          /** 駅反映＋流れ反映の両方が揃った時だけ needs_auto を下ろす合図（MAIN→content中継含む） */
          try {
            var _linkedOk = !!(_stHit && _sk > 0 && _flowR.ok);
            if (typeof chrome !== "undefined" && chrome.runtime && chrome.runtime.sendMessage) {
              chrome.runtime.sendMessage({ type: "axlx-learn-auto-linked", ok: _linkedOk, screen: _sk, scenes: _sfn, flow: !!_flowR.ok });
            } else {
              window.postMessage({ from: "axlx-page-learn-auto-linked", ok: _linkedOk, screen: _sk, scenes: _sfn, flow: !!_flowR.ok }, "*");
            }
          } catch (_) {}
        } catch (_) {}
        resolve(true);
      };
      var afterWarm = function () {
        _loadLearnNextAsync(true).then(done, done);
      };
      var warmLocal = function () {
        _requestLearnRefresh(true).then(function (res) {
          try {
            if (_audit) {
              var _rd = res === "timeout" ? "timeout8s（裏の取り直しが終わる前に読む・後から届けば反映）"
                : !res ? "結果なし"
                : ((res.ok === false ? "失敗 " + (res.error || "") : (res.skipped ? "取らず " + res.skipped : (res.empty ? "束が空" : "取込"))) +
                  (res.screen_solid != null ? " solid=" + res.screen_solid : "") +
                  (res.retry_in_ms != null ? " 待ち" + Math.round(res.retry_in_ms / 1000) + "秒" : "") +
                  (res.ver ? " 版" + res.ver : ""));
              _auditStepP("learn_refresh_res", String(_rd).slice(0, 110));
            }
          } catch (_) {}
          return _storageLocalGet(_LEARN_WARM_KEYS.concat(_LEARN_NEXT_KEYS, ["axlx_learn_link"]), 8000, true);
        }).then(function (r) {
          try { _applyLearnStoragePayload(r); } catch (_) {}
          try {
            var _lk = r && r.axlx_learn_link;
            if (_audit && _lk && _lk.screen_kept) {
              _auditStepP("learn_screen_kept", "束の画面位置0→" + (_lk.site || "") + "の控え 版" + String(_lk.screen_kept).slice(0, 19) + " keys=" + (_lk.screen_keys || 0));
            }
          } catch (_) {}
          return _learnWarm(true);
        }).then(afterWarm, afterWarm);
      };
      warmLocal();
    });
  }
  try { _loadLearnNext(); } catch (_) {}

  function getDirectText(el) {    var t = '';
    for (var n = el.firstChild; n; n = n.nextSibling) {
      if (n.nodeType === 3) t += n.textContent;
    }
    return t.replace(/\s+/g, '').replace(/駅$/, '');
  }

  function fireClick(el) {
    /**
     * ★ 2026-11-16 統括Pro「直click禁止・カーソル57→70」:
     *   生 click イベント直送はカーソル記録が付かない。必ずカーソル経由。
     */
    if (!el) return;
    if (_axFireDepth > 0) { try { el.dispatchEvent(new MouseEvent("click", { bubbles: true, cancelable: true })); } catch (_) {} return; }
    try {
      if (typeof _humanPointerClick === "function" && window.AxlxPointerUi) {
        void _humanPointerClick(el, function (x) {
          try { x.dispatchEvent(new MouseEvent("click", { bubbles: true, cancelable: true })); } catch (_) {}
        });
        return;
      }
    } catch (_) {}
    try { el.dispatchEvent(new MouseEvent("click", { bubbles: true, cancelable: true })); } catch (_) {}
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
    /**
     * ★ 2026-11-17 竹内さん「間隔機械的→人間のような間隔」＋統括Pro:
     *   人間実測 p50≈1005・CV≈0.64。旧 sigma=0.32 は裾が狭く等間隔っぽい。
     *   → sigma 0.55／中央は人間寄り／微小ジッターで同一値連発を潰す。
     */
    var sig = (opts && typeof opts.sigma === "number" && opts.sigma > 0) ? opts.sigma : 0.55;
    if (H && H.logNormalDelay) {
      var med = (lo + hi) / 2;
      // 人間は短い待ちが多くたまに長い → 中央をやや短めに（lo寄りすぎない）
      if (!(opts && opts.keepMed)) med = lo * 0.42 + hi * 0.58;
      var v = H.logNormalDelay(med, sig);
      // ★ 2026-11-17 統括Pro＋近さ39点: 操作と操作の間が機械的に短い。
      //   通常 fast400≈3%・自動≈38〜40%。操作間隔は硬下限420（hi≥250なら常に）。
      //   ⚠ 1クリック内の mousedown→mouseup（40〜90）だけ allowShort。
      //   ★ 旧: lo≥200 の時だけ下限 → 既定80〜200のキューが短間隔の主因になっていた。
      var allowShort = !!(opts && opts.allowShort);
      var floor = strict ? lo : Math.max(20, Math.round(lo * 0.88));
      /**
       * ★ 2026-11-17 統括Pro F28/F29: 短間隔47.7%→44.8%・近さ16。
       *   硬下限700でも短間隔未達 → **操作間隔の硬下限を900**（通常 p50≈1117・human帯800〜）。
       *   allowShort（mousedown内）だけ例外。
       */
      if (!allowShort && !strict && hi >= 250 && floor < 900) floor = 900;
      if (!allowShort && !strict && lo >= 150 && floor < 900) floor = 900;
      if (strict && floor < 1000) floor = Math.max(floor, Math.min(lo, 1000));
      var ceil = hi * 2.4;
      var out = Math.min(ceil, Math.max(floor, v));
      // ためらい（操作間隔だけ・通常録画の長裾に寄せる）
      if (!allowShort) {
        if (Math.random() < 0.28) out += 220 + Math.floor(Math.random() * 580);
        else if (Math.random() < 0.10) out += 800 + Math.floor(Math.random() * 1800);
      }
      // 同一ms連発を避ける微小ジッター（1〜47ms）
      out += 1 + Math.floor(Math.random() * 47);
      return Math.round(Math.min(hi * 2.6, out) * 10) / 10;
    }
    // 予備: 一様ではなく三角寄与（中央寄り）＋ジッター
    var u = Math.random() + Math.random();
    var tri = lo + (hi - lo) * (u / 2);
    return Math.round(tri + 1 + Math.random() * 40);
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
  /**
   * ★ 2026-11-20 竹内さん「全部人間がやるように徹底的に」:
   *   キューは「カーソルを動かす→押し込む（mousedown/up）→ fire(el)」の順で、fire が _clickEl だと
   *   中でもう一度カーソルを動かして押し込んでいた（見えるカーソルが2回押す・待たない void なので次の操作と重なる）。
   *   → _fireAt が fire を呼んでいる間（カーソルが着いて押し込んだ後）は、移動も押し込みもせず本物のクリックだけ。
   */
  var _axFireDepth = 0;
  var _axFireEl = null;
  function _clickEl(el) {
    try {
      if (!el) return;
      // ★ 押す直前に was 腕上げ（checkbox/radio・label 経由も）
      try { _armWasForLearn(el); } catch (_) {}
      if (_axFireDepth > 0) { el.click(); return; }
      // 見えるカーソルで動かしながら押す（失敗しても必ず押す＝止まらない）
      void _humanPointerClick(el, function (x) {
        try { _armWasForLearn(x || el); } catch (_) {}
        try { x.click(); } catch (_) {}
      });
    } catch (_) {
      try { _armWasForLearn(el); } catch (__) {}
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
      /**
       * ★ 2026-11-16 KAORI録画「築年数が画面見切れの部分で選択していた」:
       *   nearest だと端に少し出るだけで選んでしまう。SELECT（築年・賃料等）は
       *   **ちゃんと画面内の中央寄りまで**スクロールしてから選ぶ。
       */
      var _isSelect = false;
      try { _isSelect = String(el.tagName || "").toUpperCase() === "SELECT"; } catch (_) {}
      var _nm = "";
      try { _nm = String(el.getAttribute && el.getAttribute("name") || ""); } catch (_) {}
      /**
       * ★ 2026-11-17 竹内さん「画面もスクロールする必要がある場所ができていない」:
       *   旧は SELECT 以外 nearest＝端に少し出るだけ／駅・区ラベルは見切れたまま押す・外す漏れ。
       *   → チェック系・確定・開閉も **中央寄り**まで入れる（毎回 block を少し揺らす）。
       */
      var _cls = "";
      try { _cls = String(el.className || ""); } catch (_) { _cls = ""; }
      var _tx = "";
      try { _tx = String(el.textContent || "").replace(/\s+/g, "").slice(0, 20); } catch (_) { _tx = ""; }
      var _needFull =
        _isSelect ||
        /structured_date|rental_cost|update_date|square_meter|transportation/i.test(_nm) ||
        /one_station|one_line|one_city|one_town|next_step|go_search|click_menu/i.test(_cls) ||
        /確定してリスト|駅の設定へ|沿線の設定へ|絞り込み/.test(_tx);
      var _block = "nearest";
      if (_needFull) {
        _block = Math.random() < 0.72 ? "center" : (Math.random() < 0.5 ? "start" : "center");
      } else if (Math.random() < 0.35) {
        _block = "center"; // たまに中央へ（機械的 nearest 連打を減らす）
      }
      el.scrollIntoView({
        behavior: Math.random() < 0.85 ? "smooth" : "auto",
        block: _block,
        inline: "nearest",
      });
      try {
        if (_audit && Math.random() < 0.35) {
          _auditStepP("scroll_into_view", String(_nm || _tx || _cls || "el").slice(0, 40) + " block=" + _block);
        }
      } catch (_) {}
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
  /**
   * ★ 2026-11-16 竹内さん「お客さんごとにカーソル等が全く同じ」:
   *   検索開始ごとにカーソルの出発点を画面内の別の所へ飛ばす。
   *   出発が同じだと、同じ欄順のとき軌跡もそっくりになる。
   */
  function _resetHumanPointerForRun() {
    try {
      var vw = (typeof window !== "undefined" && window.innerWidth) ? window.innerWidth : 1200;
      var vh = (typeof window !== "undefined" && window.innerHeight) ? window.innerHeight : 800;
      _pointer = {
        x: 60 + Math.random() * Math.max(120, vw * 0.72),
        y: 60 + Math.random() * Math.max(100, vh * 0.62),
      };
      var _P0 = window.AxlxPointerUi;
      if (_P0 && _P0.scatter) _P0.scatter(_pointer.x, _pointer.y);
    } catch (_) {}
  }
  /**
   * ★ 2026-11-19 竹内さん「徒歩のプルダウンの最初押す部分みぎにずれてる／検索ボタンを画面外から押している」:
   *   要素の枠（getBoundingClientRect）は「見えている所」と違う事がある。
   *     ・徒歩（transportation_id）の select は枠が 230px あるが、右側は分数の入力欄が上に重なっている
   *       （録画 #1531: 押した記録が b=55x29/input の右端＝分数の欄）。
   *     ・左の帯が中でスクロールしていると、検索ボタンは画面の内側でも上の固定の帯（マップ検索・閲覧履歴）の下に隠れる
   *       （#1530 写真: カーソルが閲覧履歴の上）。
   *   → その点で一番上にある物（elementFromPoint）が狙った要素（か中の子・その要素のラベル）の時だけ「押せる点」とする。
   */
  function _hitOkAt(el, x, y) {
    try {
      var vw = window.innerWidth || 1200, vh = window.innerHeight || 800;
      if (!(x >= 1 && y >= 1 && x <= vw - 1 && y <= vh - 1)) return false;
      var h = document.elementFromPoint(Math.round(x), Math.round(y));
      if (!h) return false;
      if (h === el || (el.contains && el.contains(h))) return true;
      if (h.contains && h.contains(el) && String(h.tagName || "").toUpperCase() === "LABEL") return true;
      if (el.id && h.closest && h.closest('label[for="' + el.id + '"]')) return true;
      var lb = el.closest ? el.closest("label") : null;
      if (lb && (h === lb || lb.contains(h))) return true;
      if (el.labels && el.labels.length) {
        for (var i = 0; i < el.labels.length; i++) {
          if (el.labels[i] === h || el.labels[i].contains(h)) return true;
        }
      }
    } catch (_) {}
    return false;
  }
  /**
   * 押せる点を返す（{x,y,fx,fy}）。pt が押せる点ならそのまま。違えば枠の中を格子で見て、pt（無ければ中央）に一番近い押せる点。
   * 1点も無ければ null（＝隠れている・画面の外）。
   */
  function _visibleHitPoint(el, pt) {
    try {
      if (!el || !el.getBoundingClientRect || typeof document.elementFromPoint !== "function") return pt || null;
      var r = el.getBoundingClientRect();
      if (!r || r.width <= 0 || r.height <= 0) return null;
      if (pt && _hitOkAt(el, pt.x, pt.y)) return pt;
      var want = pt || { x: r.left + r.width * 0.5, y: r.top + r.height * 0.5 };
      var best = null, bestD = Infinity;
      var FX = [0.12, 0.25, 0.38, 0.5, 0.62, 0.75, 0.88];
      var FY = [0.3, 0.5, 0.7];
      for (var i = 0; i < FX.length; i++) {
        for (var j = 0; j < FY.length; j++) {
          var x = r.left + r.width * FX[i], y = r.top + r.height * FY[j];
          if (!_hitOkAt(el, x, y)) continue;
          var d = (x - want.x) * (x - want.x) + (y - want.y) * (y - want.y);
          if (d < bestD) { bestD = d; best = { x: x, y: y, fx: FX[i], fy: FY[j] }; }
        }
      }
      return best;
    } catch (_) { return pt || null; }
  }
  /** 欄の中央付近（25〜75%）が全部押せる＝重なり・隠れが無い普通の欄 */
  function _hitPlain(el) {
    try {
      var r = el.getBoundingClientRect();
      if (!r || r.width <= 0 || r.height <= 0) return false;
      var pts = [[0.5, 0.5], [0.28, 0.5], [0.72, 0.5]];
      for (var i = 0; i < pts.length; i++) {
        if (!_hitOkAt(el, r.left + r.width * pts[i][0], r.top + r.height * pts[i][1])) return false;
      }
      return true;
    } catch (_) { return true; }
  }
  function _humanPointerClick(el, fallbackFn, aim, tgtAt) {
    var H = window.AxlxHumanWait;
    var fire = fallbackFn || _clickEl;
    if (!el || !el.getBoundingClientRect || !H || !H.pointerPath) { fire(el); return Promise.resolve(false); }
    var r;
    try { r = el.getBoundingClientRect(); } catch (_) { fire(el); return Promise.resolve(false); }
    if (!r || (r.width <= 0 && r.height <= 0)) {
      /**
       * ★ 2026-11-20 竹内さん「直接入力になっていないか・全部人間がやるように徹底的に」:
       *   隠れた checkbox/radio（大きさ0）は旧はカーソル無しで押していた（駅・区・町の input を直接押す経路の共通の根）。
       *   → 見えている label があれば、カーソルを label へ動かして押し込み、そこで本来の押し（fire(el)）をする。
       *   見える物が無い時だけ今まで通り押し、点検に hidden_press を残す（DB で数えられるように）。
       */
      var _proxy = null;
      try {
        var _tp = String(el.type || "").toLowerCase();
        if (String(el.tagName || "").toUpperCase() === "INPUT" && (_tp === "checkbox" || _tp === "radio")) {
          _proxy = _labelForCheckbox(el);
          if (_proxy === el || !_proxy || !isVisible(_proxy)) _proxy = null;
        }
      } catch (_) { _proxy = null; }
      if (_proxy) {
        return _humanPointerClick(_proxy, function () { return fire(el); }, aim, tgtAt);
      }
      try { _auditStepP("hidden_press", String(_opLabel(el)).slice(0, 40) + " 見える欄が無くカーソル無しで押した"); } catch (_) {}
      fire(el);
      return Promise.resolve(false);
    }
    /**
     * ★ 2026-11-19: 枠の中に押せる点が1つも無い（帯の中のスクロールで固定の帯の下・画面の外）時は、
     *   先にその要素を見える所まで送ってから押す（1回だけ・送っても隠れたままなら今まで通り押す）。
     */
    try {
      if (!el.__axOccScrolled && !_visibleHitPoint(el, null)) {
        el.__axOccScrolled = 1;
        // 一瞬で飛ばさず人の速さで送る（2026-11-20）。送り終わるのを待ってから押し直す
        try { el.scrollIntoView({ block: "center", inline: "nearest", behavior: "smooth" }); } catch (_) {}
        try { if (_audit) _auditStepP("press_hidden_scroll", String(_opLabel(el)).slice(0, 40) + " 押す点が隠れている→見える所まで送ってから押す"); } catch (_) {}
        return new Promise(function (res) {
          setTimeout(function () { res(_humanPointerClick(el, fallbackFn, aim, tgtAt)); }, 560 + Math.floor(Math.random() * 360));
        });
      }
      el.__axOccScrolled = 0;
      r = el.getBoundingClientRect();
    } catch (_) {}
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
        // ★ 2026-11-16: 学んだ位置も毎回数％ずらす（同じピクセルに着かない＝変則）
        _fx = Math.max(0.2, Math.min(0.8, _fx + (Math.random() - 0.5) * 0.12));
        _fy = Math.max(0.2, Math.min(0.8, _fy + (Math.random() - 0.5) * 0.12));
        _aimPt = { x: r.left + r.width * _fx, y: r.top + r.height * _fy, fx: _fx, fy: _fy };
      }
    } catch (_) { _aimPt = null; }
    /**
     * ★ 2026-11-18 HONOKA実測＋統括Pro「検索が画面外／徒歩が右ずれ」:
     *   狙い点が要素外・画面外なら欄の中央へ戻す（スクロール定着後も保険）。
     */
    try {
      var _vwP = window.innerWidth || 1200;
      var _vhP = window.innerHeight || 800;
      var _clampPt = function (pt) {
        if (!pt) return null;
        var x = Math.max(r.left + 2, Math.min(r.right - 2, pt.x));
        var y = Math.max(r.top + 2, Math.min(r.bottom - 2, pt.y));
        x = Math.max(8, Math.min(_vwP - 8, x));
        y = Math.max(8, Math.min(_vhP - 8, y));
        // 要素がほぼ画面外なら中央寄せに放棄
        if (r.right < 4 || r.bottom < 4 || r.left > _vwP - 4 || r.top > _vhP - 4) {
          return { x: Math.max(8, Math.min(_vwP - 8, r.left + r.width * 0.5)), y: Math.max(8, Math.min(_vhP - 8, r.top + r.height * 0.5)) };
        }
        return { x: x, y: y, fx: pt.fx, fy: pt.fy };
      };
      if (_aimPt) _aimPt = _clampPt(_aimPt);
    } catch (_) {}
    /**
     * ★ 2026-11-19: 狙う点の上に別の物が重なっていれば、その要素が見えている所の一番近い点へ直す。
     *   学びが無い時も、重なりのある欄（徒歩の select 等）は見えている所を狙う（普通の欄は今まで通り pointer-ui に任せる）。
     */
    try {
      if (_aimPt) {
        var _hp = _visibleHitPoint(el, _aimPt);
        if (_hp && _hp !== _aimPt) {
          try { if (_audit) _auditStepP("aim_hit_fix", String(_opLabel(el)).slice(0, 40) + " 狙いの点に別の物が重なる→横" + Math.round(_hp.fx * 100) + "%へ"); } catch (_) {}
          _aimPt = _hp;
        }
      } else if (!_hitPlain(el)) {
        var _hp2 = _visibleHitPoint(el, null);
        if (_hp2) {
          _aimPt = _hp2;
          try { if (_audit) _auditStepP("aim_hit_fix", String(_opLabel(el)).slice(0, 40) + " 欄の中央に別の物が重なる→見えている横" + Math.round(_hp2.fx * 100) + "%を押す"); } catch (_) {}
        }
      }
    } catch (_) {}
    // 2026-11-10 v2.6.0 竹内さん「リアプロとITANDI人間のようにマウス動くようにする」:
    //   画面の上に「見えるカーソル」を出して、押す位置まで人の軌跡で動かす（pointer-ui.js・見た目だけ・pointer-events:none）。
    //   動きながら押すと不自然なので、**着いてから**押す（本物のクリックは今まで通り1回だけ）。
    var _P = window.AxlxPointerUi;
    if (_P && _P.ensure) {
      try { _P.ensure(); } catch (_) {}
      var _move = function () {
        try { if (_P.setTarget) _P.setTarget(el); } catch (_) {}
        try {
          if (_aimPt && _P.moveTo) {
            // 見えるカーソル側も毎回ピクセルをずらす（クローン軌跡防止）
            var _jx = _aimPt.x + (Math.random() - 0.5) * Math.min(16, r.width * 0.22);
            var _jy = _aimPt.y + (Math.random() - 0.5) * Math.min(12, r.height * 0.22);
            if (!_hitOkAt(el, _jx, _jy) && _hitOkAt(el, _aimPt.x, _aimPt.y)) { _jx = _aimPt.x; _jy = _aimPt.y; }
            return _P.moveTo(_jx, _jy);
          }
        } catch (_) {}
        return _P.moveToEl(el);
      };
      /**
       * ★ 2026-11-16: _fireAt が返す Promise（プルダウン完了）を必ず待つ。
       *   旧は `_fireAt(...); return true` で擬似一覧の途中に次の操作が始まっていた。
       */
      /**
       * ★ 2026-11-17 通常録画: 操作間隔 p50≈1.1s。移動のあと着地〜押しも厚く。
       *   旧 110〜350ms は速すぎ → 対数正規中央≈280＋たまに長め。
       */
      return _move().then(function () {
        var _dwell = H && H.logNormalDelay ? H.logNormalDelay(280, 0.5) : (180 + Math.floor(Math.random() * 220));
        if (Math.random() < 0.22) _dwell += 200 + Math.floor(Math.random() * 480);
        if (Math.random() < 0.07) _dwell += 500 + Math.floor(Math.random() * 900);
        if (_dwell < 120) _dwell = 120;
        if (_dwell > 1600) _dwell = 1600;
        /**
         * ★ 2026-11-18 区レーン（竹内さん「通常モードの人間の速さのように」）:
         *   tgtAt（押したい時刻）があれば、着地後の見る時間を「目標時刻 − いま − 押下までの約170ms」にする。
         *   着くのが遅れた時は最短80msで押す（待たせない）。漂い（drift）は入れない。
         */
        var _useTgt = false;
        if (tgtAt && isFinite(Number(tgtAt))) {
          _useTgt = true;
          _dwell = Math.max(80, Math.min(4200, Math.round(Number(tgtAt) - Date.now() - 170)));
        }
        // 長く待つ時は欄の上でそっと漂わせてから押す（止まった置物にしない）
        var _preDrift = 0;
        if (_useTgt && _dwell > 1300) { _preDrift = _dwell - 500; _dwell = 500; }
        // 着地後に小さく漂ってから押す（狙い直し）。漂い分は dwell の外＝人間の「直してから押す」
        return new Promise(function (resolve) {
          /**
           * ★ 2026-11-19 #1532: 見えるカーソルの「押す」は _fireAt の中で1回だけ（本物のクリックと同じ瞬間）。
           *   旧はここでも tap して押下1回にカーソルが2回押し込み・記録も span と div の2本（0.4〜0.6秒差）になっていた。
           */
          var _doTap = function () {
            setTimeout(function () {
              Promise.resolve(_fireAt(el, fire, r, _aimPt)).then(function () { resolve(true); }, function () { resolve(true); });
            }, Math.round(_dwell));
          };
          if (_preDrift > 0 && _P.drift) {
            _P.drift(_preDrift, { radius: 6 + Math.random() * 12 }).then(_doTap, _doTap);
          } else if (!_useTgt && Math.random() < 0.28 && _P.drift) {
            _P.drift(120 + Math.floor(Math.random() * 280), { radius: 6 + Math.random() * 14 }).then(_doTap, _doTap);
          } else {
            _doTap();
          }
        });
      }, function () {
        return Promise.resolve(_fireAt(el, fire, r, _aimPt)).then(function () { return true; }, function () { return true; });
      });
    }
    // ★ 2026-11-16: 狙う点も毎回ずらす（同じ欄でも同じピクセルに着かない）
    /**
     * ★ 2026-11-17: 学び無しでも毎回同じ「中央寄り」にならないよう帯を広げる（押す場所の人間化）。
     */
    var to = _aimPt
      ? {
          x: _aimPt.x + (Math.random() - 0.5) * Math.min(18, r.width * 0.25),
          y: _aimPt.y + (Math.random() - 0.5) * Math.min(14, r.height * 0.25),
        }
      : {
          x: r.left + r.width * (0.18 + Math.random() * 0.64),
          y: r.top + r.height * (0.18 + Math.random() * 0.64),
        };
    var pts = H.pointerPath(_pointer, to, 12 + Math.floor(Math.random() * 16));
    // 旧 220〜700ms は速すぎ（人間の駅間隔≈1.1s と合わない）
    var _moveMs = H.logNormalDelay ? H.logNormalDelay(520, 0.45) : (380 + Math.random() * 420);
    if (_moveMs < 280) _moveMs = 280;
    if (_moveMs > 1200) _moveMs = 1200;
    var waits = H.pointerDelays ? H.pointerDelays(pts.length, _moveMs) : pts.map(function () { return 30; });
    var i = 0;
    function ev(type, p) {
      try {
        var t = el;
        var o = { bubbles: true, cancelable: true, view: window, clientX: Math.round(p.x), clientY: Math.round(p.y), button: 0, buttons: type === "mousedown" ? 1 : 0 };
        t.dispatchEvent(new MouseEvent(type, o));
      } catch (_) {}
    }
    return new Promise(function (resolve) {
      var step = function () {
        if (i >= pts.length - 1) {
          var p = pts[pts.length - 1];
          _pointer = { x: p.x, y: p.y };
          // SELECT は OS 一覧が開くので mousedown/mouseup を送らない（2026-11-16）
          var _isSel = false;
          try { _isSel = String(el.tagName || "").toUpperCase() === "SELECT"; } catch (_) {}
          if (_isSel) {
            // SELECT: OS一覧を開かない。click 記録は chooseSelectLikeHuman の tap 時に1回だけ
            try { ev("mouseover", p); } catch (_) {}
          } else {
            ["mouseover", "mousedown", "mouseup"].forEach(function (type) { ev(type, p); });
          }
          var ret = null;
          try { ret = fire(el); } catch (e) { console.error('[AX] クリック例外', e); }
          // ★ 2026-11-16: fire（chooseSelectLikeHuman）が終わるまで待つ
          if (ret && typeof ret.then === "function") {
            ret.then(function () { resolve(true); }, function () { resolve(true); });
          } else {
            resolve(true);
          }
          return;
        }
        var pt = pts[i];
        ev("mousemove", pt);
        i++;
        setTimeout(step, waits[Math.min(i, waits.length - 1)] || 30);
      };
      try { el.dispatchEvent(new MouseEvent("mouseover", { bubbles: true, cancelable: true, view: window })); } catch (_) {}
      step();
    });
  }
  /**
   * 2026-11-10 v2.6.0 カーソルが着いた後に「押す」処理を1か所に（見えるカーソルの経路でも同じ順で出す）。
   *   mousemove → mouseover → mousedown → mouseup → 本物のクリック（1回だけ）
   *
   * ★ 2026-11-16 竹内さん「操作一つずつ／プルダウンも並行で別のことしない」:
   *   ⚠ 旧は `fire(el)`（= chooseSelectLikeHuman の Promise）を**待たず**に次へ進んでいた。
   *     → 擬似一覧が開いたまま次の賃料・更新日が始まり、徒歩が消える・同時操作に見えた。
   *   → **必ず Promise を返し、fire が終わるまで resolve しない**。
   */
  function _fireAt(el, fire, r, aimPt) {
    return new Promise(function (resolve) {
      try {
        var cx, cy;
        /**
         * ★ 2026-11-18 竹内さん「学びがある時は中央押しに逃げない」:
         *   旧は見えるカーソルが要素近くに無いと 0.3〜0.7 乱数＝真ん中寄り固定。
         *   → 学んだ aim（要素内の割合）を優先して合成イベント座標に使う。
         */
        if (aimPt && typeof aimPt.fx === "number" && typeof aimPt.fy === "number" && r && r.width > 0 && r.height > 0) {
          var _afx = Math.max(0.05, Math.min(0.95, aimPt.fx));
          var _afy = Math.max(0.05, Math.min(0.95, aimPt.fy));
          cx = Math.round(r.left + r.width * _afx);
          cy = Math.round(r.top + r.height * _afy);
        } else {
        var _P = window.AxlxPointerUi;
        var _pos = null;
        try { if (_P && _P.visiblePosition) _pos = _P.visiblePosition(); } catch (_) { _pos = null; }
        var _near = _pos && _pos.x >= r.left - 4 && _pos.x <= r.right + 4 && _pos.y >= r.top - 4 && _pos.y <= r.bottom + 4;
        if (_near) {
          cx = Math.round(_pos.x); cy = Math.round(_pos.y);
        } else {
          var fx = 0.30 + Math.random() * 0.40;
          var fy = 0.30 + Math.random() * 0.40;
          cx = Math.round(r.left + r.width * fx); cy = Math.round(r.top + r.height * fy);
        }
        }
        var base = { bubbles: true, cancelable: true, view: window, clientX: cx, clientY: cy, button: 0 };
        ["mousemove", "mouseover"].forEach(function (type) { try { el.dispatchEvent(new MouseEvent(type, base)); } catch (_) {} });
        var aim = 90 + Math.floor(Math.random() * 160);
        /**
         * ★ 2026-11-19 (2.8.125) 押し込み時間を人の分布へ（旧: mousedown と mouseup が同じ瞬間）。
         *   AxlxPointerUi.holdMs()（45〜180ms・ラン persona の press_ms 中心）だけ mousedown を先に出し、
         *   aim の時点で mouseup→click。holdMs が無い時は従来どおり同時。
         */
        var _tag0 = "";
        try { _tag0 = String(el.tagName || "").toUpperCase(); } catch (_) { _tag0 = ""; }
        var _holdMs = 0;
        try { var _PH = window.AxlxPointerUi; if (_tag0 !== "SELECT" && _PH && typeof _PH.holdMs === "function") _holdMs = Math.max(0, Math.min(180, Math.round(_PH.holdMs()) || 0)); } catch (_) { _holdMs = 0; }
        var _downSent = false;
        var _sendDown = function () {
          if (_downSent) return; _downSent = true;
          try { el.dispatchEvent(new MouseEvent("mousedown", Object.assign({}, base, { buttons: 1 }))); } catch (_) {}
        };
        if (_holdMs > 0) setTimeout(_sendDown, Math.max(0, aim - _holdMs));
        setTimeout(function () {
          var _tag = _tag0;
          if (_tag !== "SELECT") {
            _sendDown();
            try { el.dispatchEvent(new MouseEvent("mouseup", Object.assign({}, base, { buttons: 0 }))); } catch (_) {}
          } else {
            // SELECT: 見た目の tap だけ。click 記録は chooseSelectLikeHuman 側で1回
            try {
              var P0 = window.AxlxPointerUi;
              if (P0 && P0.tap) P0.tap();
            } catch (_) {}
          }
          var ret = null;
          var _prevFireEl = _axFireEl;
          _axFireDepth++; _axFireEl = el;
          try { ret = fire(el); } catch (e) { console.error('[AX] クリック例外', e); }
          finally { _axFireDepth = Math.max(0, _axFireDepth - 1); _axFireEl = _prevFireEl; }
          // ★ 2026-11-16: カーソル経由の押しを必ず録画へ残す（押した位置%を上げる）
          try { _noteClickForLearn(el, undefined, { x: cx, y: cy }); } catch (_) {}
          /**
           * ★ 2026-11-17 統括Pro: 押した実座標を point_fields へ（synthetic）。
           *   pointer-ui.tap が要素外だと記録スキップするため、ここでも必ず渡す。
           */
          try { _notePointForLearn(el, cx, cy); } catch (_) {}
          try {
            var P = window.AxlxPointerUi;
            if (_tag !== "SELECT") { if (P && P.tap) P.tap(); }
          } catch (_) {}
          if (ret && typeof ret.then === "function") {
            ret.then(function () { resolve(true); }, function () { resolve(false); });
          } else {
            resolve(true);
          }
        }, aim);
      } catch (e) {
        console.error('[AX] クリック例外', e);
        resolve(false);
      }
    });
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
  function _isElQueuedOrBusy(el) {
    if (_clickBusyItem && _clickBusyItem.el === el) return true;
    for (var qi = 0; qi < _clickQueue.length; qi++) {
      if (_clickQueue[qi] && _clickQueue[qi].el === el) return true;
    }
    return false;
  }
  function enqueueHumanClick(el, clickFn, minGap, maxGap, _unused, opts) {
    if (!el) return false;
    /**
     * ★ 2026-11-19 タクヤ audit #1513: 列にも処理中にも無いのに __axPending が残った欄は二度と押せず、
     *   呼び出し側の待ち（沿線の全部チェック待ち等）が永久に回った。印だけ残った物は外して積み直す。
     */
    if (el.__axPending && !_isElQueuedOrBusy(el)) {
      el.__axPending = false;
      try { _auditStepP("stale_pending_reset", String(_opLabel(el)).slice(0, 36)); } catch (_) {}
    }
    if (el.__axPending) return false;
    if (_axHumanTookOver) return false;
    el.__axPending = true;
    /**
     * ★ 2026-11-17 統括Pro「短間隔37.9%の主因／既定80〜200を廃止」:
     *   未指定の待ちは UI押し帯（≥900）へ。機械的な速さの入口を塞ぐ。
     */
    if (minGap == null || !(Number(minGap) > 0)) minGap = _uiGapMin();
    /** ★ 2026-11-17 統括Pro: 呼び出し側の短いminGapを硬下限900で底上げ（短間隔の入口を塞ぐ） */
    if (Number(minGap) < 900) minGap = 900;
    if (maxGap == null || !(Number(maxGap) > Number(minGap))) maxGap = Math.max(_uiGapMax(), Number(minGap) + 400);
    if (!opts) opts = {};
    if (opts.strictLo == null && Number(minGap) >= 700) opts = Object.assign({}, opts, { strictLo: true, sigma: opts.sigma != null ? opts.sigma : 0.55 });
    // 2026-11-11: opts.strictLo（駅のように下限を下回らせない）を humanRand に渡す
    // ★ 2026-11-16: opts.aim（学んだ押す位置）もキューへ（検索ボタンもカーソルで狙う）
    /**
     * ★ 2026-11-16 統括「押した位置28%・弱い: city_code[]・区・route_id[]」:
     *   区・駅・町字の enqueue が aim 無しで積まれていた → カーソルは動くが学んだ位置を使わない。
     *   → aim 未指定なら要素／name から自動で引く（有れば使う・無ければ null＝変則中央）。
     */
    var _aimQ = (opts && opts.aim) || null;
    if (!_aimQ) {
      try { _aimQ = _aimByEl(el, (opts && opts.keys) || null); } catch (_) { _aimQ = null; }
    }
    if (!_aimQ) {
      try {
        var _nmQ = el.getAttribute && el.getAttribute("name");
        if (_nmQ) _aimQ = _aimOf(_nmQ);
      } catch (_) {}
    }
    /**
     * ★ 2026-11-16 根元: カーソル・クリック位置も学んだ物を必ず使う。
     *   name が無くても opts.keys（親の欄名）や label テキストから aim を引く。
     *   → 他客でも「中央だけ押す」ずれを減らす。
     */
    if (!_aimQ && opts && Array.isArray(opts.keys)) {
      for (var _ki = 0; _ki < opts.keys.length && !_aimQ; _ki++) {
        try { _aimQ = _aimOf(String(opts.keys[_ki] || "")); } catch (_) {}
      }
    }
    if (!_aimQ) {
      try {
        var _lab = String((opts && opts.label) || _opLabel(el) || "").replace(/\s+/g, "").slice(0, 24);
        if (_lab) _aimQ = _aimOf(_lab);
      } catch (_) {}
    }
    // ★ クラス名からも aim（one_station / one_city / go_search）
    if (!_aimQ) {
      try {
        var _cls = String((el && el.className) || "");
        if (/one_station/.test(_cls)) _aimQ = _aimOf("station_id[]") || _aimOf("one_station");
        else if (/one_line/.test(_cls)) _aimQ = _aimOf("route_id[]") || _aimOf("one_line");
        else if (/one_city/.test(_cls)) _aimQ = _aimOf("city_code[]") || _aimOf("one_city");
        else if (/go_search|search_menu/.test(_cls)) _aimQ = _aimOf("go_search") || _aimOf("検索");
      } catch (_) {}
    }
    try {
      if (_aimQ) _auditStepP("cursor_aim", String((opts && opts.label) || (el && el.getAttribute && el.getAttribute("name")) || "el") + " aim有" + (_aimQ.fromScreen ? "(画面)" : "") + (_aimQ.thin ? "(薄)" : ""));
      else _auditStepP("cursor_aim", String((opts && opts.label) || (el && el.getAttribute && el.getAttribute("name")) || "el") + " aim無→変則中央");
    } catch (_) {}
    /**
     * ★ 2026-11-17 統括Pro F28: 既定80〜200へ落ちる抜けを塞ぐ。
     *   minGap は上で _uiGapMin 済み。|| 80 は短間隔の入口だった。
     */
    var _gLo = Number(minGap) > 0 ? Number(minGap) : _uiGapMin();
    var _gHi = Number(maxGap) > _gLo ? Number(maxGap) : Math.max(_uiGapMax(), _gLo + 400);
    if (_gLo < 700) _gLo = 700;
    /**
     * ★ 2026-11-18 竹内さん「地域選択する際の人間の通常モードと比べて時間がかなり遅い／通常モードの人間の速さのように」:
     *   DB実測（audit #1498・v2.8.107）: 区の押し間隔 自動 p50=5735ms／通常 p50=836ms（約7倍）。
     *   原因＝下限の積み上げ（押す前≥900＋押した後≥950＋確認400＋カーソル＋迷い）が区1つごとに乗っていた。
     *   → 区（city_code / one_city）は「区レーン」に通す: 押す前の待ちは小さく、
     *     クリックからクリックまでの間隔は通常の実測分布（_wardPaceMs）で決める。
     */
    var _pickKind = _isWardLaneEl(el) ? null : _pickLaneKind(el);
    var _lane = _isWardLaneEl(el) ? "ward" : (_pickKind ? "pick" : null);
    _clickQueue.push({
      pickKind: _pickKind,
      el: el,
      fn: clickFn || _clickEl,
      gap: _lane === "ward" ? _ln(110, 0.45, 50, 260) : humanRand(_gLo, _gHi, opts),
      label: (opts && opts.label) || _opLabel(el),
      aim: _aimQ || null,
      keys: (opts && opts.keys) || null,
      lane: _lane,
      quick: !!(opts && opts.quick),
      decide: !!(opts && opts.decide),
    });
    _scheduleClickDrain();
    return true;
  }
  // 要素に紐づかない汎用アクション（select/text入力・モーダル閉じ等）もキューで直列化
  function enqueueHumanAction(fn, minGap, maxGap, label) {
    /**
     * ★ 2026-11-17 統括Pro「既定80〜200が短間隔の主因」:
     *   息・考え・retry も含め操作間隔の下限を人寄りに（allowShort は使わない）。
     */
    var lo = (minGap != null && Number(minGap) > 0) ? Number(minGap) : _uiGapMin();
    var hi = (maxGap != null && Number(maxGap) > lo) ? Number(maxGap) : Math.max(_uiGapMax(), lo + 400);
    if (lo < 420) lo = 420;
    if (hi < lo + 200) hi = lo + 200;
    _clickQueue.push({
      el: null,
      fn: fn,
      gap: humanRand(lo, hi, { strictLo: lo >= 700, sigma: 0.55 }),
      label: label || "action",
    });
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
      // ★ 2026-11-20 (2.8.135): リアプロの検索は div.go_search（DIV）。旧は「その他」扱いで 12% の 4〜9秒の迷いが乗っていた
      if (/go_search|search_menu/.test(String(el.className || ""))) return "decide";
      if (tag !== "LABEL" && tag !== "INPUT" && tag !== "SELECT") {
        var _tx = String(el.textContent || "").replace(/\s+/g, "");
        if (_tx.length <= 20 && /^(確定してリストへ|この条件で絞り込む|検索|決定)$/.test(_tx)) return "decide";
      }
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
        else if (/駅の設定へ進む|沿線の設定へ戻る|確定してリスト/.test(txt)) kind = "step";
        else if (/^(次へ|次|続き|もっと見る|次ページ|次のページ)/.test(txt)) kind = "next";
        else if (tag === "SELECT" || tag === "LABEL" || ((tag === "INPUT") && /checkbox|radio/.test(type))) kind = "choose";
        else if (tag === "BUTTON" || /submit|button/.test(type) || /^(検索|送信|決定|実行|保存|登録|送る)/.test(txt)) kind = "decide";
        else kind = "other";
      }
    } catch (_) { kind = "other"; }
    // ★ 2026-11-17 通常録画: 駅/沿線 p50≈1.1s・進む/戻る p50≈1.5s
    var r = {
      input:  [500, 1200],
      next:   [900, 2100],
      step:   [1100, 2000],
      choose: [750, 1600],
      decide: [1200, 3200],
      other:  [700, 1600],
    }[kind] || [700, 1600];
    var base = H && H.logNormalDelay ? H.logNormalDelay((r[0] + r[1]) / 2, 0.55) : (r[0] + r[1]) / 2;
    // 決定のボタンの後は「画面が変わったか」を見るので、たまに長く見る（12%で+0.6〜1.8秒）
    if (kind === "decide" && Math.random() < 0.12) base += 600 + Math.floor(Math.random() * 1200);
    // 一瞬つく（8%で+0.3〜0.9秒）＝人が「お、変わったな」と手を止める形
    else if (Math.random() < 0.08) base += 300 + Math.floor(Math.random() * 600);
    base += 1 + Math.floor(Math.random() * 40);
    /**
     * ★ 2026-11-17: 旧 `r[0]*0.5` が settle を375msまで下げ短間隔の主因。
     *   → 硬下限700（choose/other）／step・decide は900。
     */
    /** ★ 2026-11-17 統括Pro 近さ16: settleも短間隔に入る → 硬下限950／決定1100 */
    var settleFloor = (kind === "step" || kind === "decide") ? 1100 : 950;
    return Math.min(r[1] * 2.6, Math.max(settleFloor, Math.round(base)));
  }
  /** 押す前に迷う時間（0＝迷わない） */
  function _hesitateMs(el) {
    var kind = _hesitateKindOf(el);
    /**
     * ★ 2026-11-19 竹内さん「人の速さで迷いも人のように入れる」:
     *   通常の人の実測（DB・realpro・直近3日・チェック/リンク等の欄）: 中央値 約2.0秒・p90 約7.2秒・
     *   4秒以上が約26%。自動は長い停止（4秒超）が少なく、人より早く単調だった。
     *   → 迷う欄（choose/other・押す前の迷い）に、4〜9秒の長い迷いを約12%足す（ward/sel レーンは別管理なので対象外）。
     */
    if (kind !== "decide") {
      var _HW = window.AxlxHumanWait;
      if (Math.random() < 0.12) {
        var _long = (_HW && _HW.logNormalDelay) ? _HW.logNormalDelay(5200, 0.3) : (4000 + Math.random() * 5000);
        _lastHesitateAt = Date.now();
        return Math.round(Math.min(9000, Math.max(4000, _long)));
      }
    }
    // ★ 2026-11-16: 選ぶ系・決定系の迷いを厚く（機械の即押しを減らす）
    var base = kind === "choose" ? 0.22 : (kind === "decide" ? 0.07 : 0.10);
    // 直前（5秒以内）に迷っていたら少し迷いやすい（同じ所を見直している形）
    var boost = (Date.now() - _lastHesitateAt < 5000) ? 0.05 : 0;
    var p = (base + boost) * (0.8 + Math.random() * 0.45); // ±20〜25% で揺らす
    if (Math.random() >= p) return 0;
    _lastHesitateAt = Date.now();
    var H = window.AxlxHumanWait;
    var r = Math.random();
    // ★ 2026-11-17: 迷い時間も対数正規（一様バンド禁止）
    if (r < 0.60) return Math.round(H && H.logNormalDelay ? H.logNormalDelay(380, 0.45) : (280 + Math.random() * 420));
    if (r < 0.92) return Math.round(H && H.logNormalDelay ? H.logNormalDelay(1100, 0.5) : (750 + Math.random() * 1000));
    return Math.round(H && H.logNormalDelay ? H.logNormalDelay(2600, 0.45) : (1800 + Math.random() * 2700));
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
  /**
   * ★ 2026-11-18 区レーン: 区（city_code / one_city）の押し・外し。
   *   通常録画の区の押し間隔（audit #1498 と同日の人の実測: p25 730 / p50 836 / p75 1030 / p90 1338 ms）。
   *   ⚠ 固定値にしない（対数正規で毎回ちがう）。下限650・上限2200。
   */
  function _isWardLaneEl(el) {
    try {
      if (!el) return false;
      var c = String(el.className || "");
      if (/one_city/.test(c)) return true;
      var tag = String(el.tagName || "").toUpperCase();
      if (tag === "INPUT" && String(el.getAttribute("name") || "") === "city_code[]") return true;
      if (tag === "LABEL" && el.querySelector && el.querySelector('input[name="city_code[]"]')) return true;
    } catch (_) {}
    return false;
  }
  /**
   * ★ 2026-11-18 竹内さん「手を止めたり迷うのも入れる人間のように／家賃・更新日の前後も通常モードの人間のように」:
   *   2.8.108 は区の最中の迷い・停止を**全部消して**いた（人間らしくない）。通常の人の実測（DB・小分け読み）は
   *   区どうし: 速い 0.9〜1.2秒が約45%・迷い 1.5〜6.5秒（中央値3.9秒）が約50%・7〜10秒の停止が約5%（5録画中2つに8秒超）。
   *   → 3種の混合: 速い（50%）／迷い（44%・カーソルが欄の上を漂う）／停止（6%・7〜10.5秒・自動の8〜25秒は使わない）。
   *   家賃・更新日などの select: 通常 直前 p50=2.0s・欄の中 p50=1.3s・欄どうし p50=2.2s（p90 3.5s）・たまに迷い／停止。
   *   ⚠ 固定値にしない（対数正規）。直し直し（同じ区の選び直し）は迷い・停止を入れない（quick）。
   */
  function _wardPaceMs() { return _ln(900, 0.25, 650, 1600); }
  /**
   * ★ 2026-11-19 竹内さん「束にある人の押す間隔を使って待ちを人に近づける」:
   *   DB実測（realpro・7日・1押下に畳んだ間隔の中央値）:
   *     間取り→間取り 自動6.2秒／人0.91秒（n=82）・駅→駅 自動6.1秒／人1.04秒（n=34）・沿線→沿線 人1.33秒。
   *   原因は区と同じ積み上げ（押す前≥0.95秒＋迷い（12%で4〜9秒）＋押した後≥0.95秒＋移動）。
   *   → 一覧の中で続けて選ぶ物（駅・沿線・町字・間取り）は「選ぶレーン」に通す。
   *     2つ目からは「前に押した時刻＋人の間隔」を押す時刻にする。1つ目は今まで通り（一覧を探す間を残す）。
   *     間隔の中央値＝束の人の押す間隔（axlx_learn_gaps.median_ms・全体の中央値）× 欄ごとの比（人の実測から）。
   */
  var _PICK_RATIO = { station: 0.62, line: 0.79, town: 0.67, layout: 0.54 };
  var _PICK_HUMAN_GAP_FALLBACK = 1685;
  function _pickNameOf(el) {
    try {
      if (!el) return "";
      var tag = String(el.tagName || "").toUpperCase();
      if (tag === "INPUT") return String(el.getAttribute("name") || "");
      if (tag === "LABEL") {
        var inp = el.querySelector && el.querySelector('input[type="checkbox"]');
        if (!inp && el.htmlFor) inp = document.getElementById(el.htmlFor);
        if (inp) return String(inp.getAttribute("name") || "");
      }
    } catch (_) {}
    return "";
  }
  function _pickLaneKind(el) {
    try {
      if (!el) return null;
      var c = String(el.className || "");
      var nm = _pickNameOf(el);
      if (/one_station/.test(c) || nm === "station_id[]") return "station";
      if (/one_line/.test(c) || nm === "route_id[]") return "line";
      if (/one_town/.test(c) || nm === "town_code[]") return "town";
      if (nm === "room_layout_id[]") return "layout";
    } catch (_) {}
    return null;
  }
  function _pickPaceMs(kind) {
    var base = Number(window.__axlxLearnGapMs) > 0 ? Number(window.__axlxLearnGapMs) : _PICK_HUMAN_GAP_FALLBACK;
    var med = base * (_PICK_RATIO[kind] || 0.62);
    return _ln(med, 0.28, 600, 2400);
  }
  function _pickGapPlan(kind) {
    var r = Math.random();
    if (r < 0.88) return { kind: "fast", ms: _pickPaceMs(kind) };
    if (r < 0.98) return { kind: "hesitate", ms: _ln(2600, 0.35, 1600, 5000) };
    return { kind: "pause", ms: _ln(7500, 0.15, 6000, 10000) };
  }
  function _wardGapPlan() {
    var r = Math.random();
    if (r < 0.50) return { kind: "fast", ms: _wardPaceMs() };
    if (r < 0.94) return { kind: "hesitate", ms: _ln(3500, 0.4, 1500, 6500) };
    return { kind: "pause", ms: _ln(8500, 0.13, 7000, 10500) };
  }
  function _selGapPlan() {
    var r = Math.random();
    if (r < 0.85) return { kind: "fast", ms: _ln(2100, 0.3, 1100, 3600) };
    if (r < 0.97) return { kind: "hesitate", ms: _ln(4500, 0.3, 3200, 7500) };
    return { kind: "pause", ms: _ln(8500, 0.13, 7000, 11000) };
  }
  /** 区を押している最中か（直近の区クリックから 20 秒以内） */
  function _wardRunActive() {
    try { return !!(window.__axlxWardLastAt && Date.now() - window.__axlxWardLastAt < 20000); } catch (_) { return false; }
  }
  function _longPauseDue(item) {
    /**
     * ★ 2026-11-18 竹内さん「今回天王寺区を押して外して一瞬止まってしまった」:
     *   実測（audit #1498）: 区の再選択の直後に 19.2 秒の無操作（8〜25秒の「人が手を止めた」の範囲）。
     *   通常の人の区選択中の最大間隔は p90≈1.3 秒。区を押している最中は長い停止を入れない（確率も進めない）。
     */
    try {
      // 区・select の「レーン」は迷い・停止を自分の混合（_wardGapPlan / _selGapPlan・最大約11秒）で持つ
      if (item && item.lane) return 0;
      if (item && item._pauseDone) return 0;
      // ★ 2026-11-20 (2.8.135): 見えない内部の作業（確かめ等）と、見直し済みの決定（検索）では手を止めない（詰まりに見えていた）
      if (item && (!item.el || item.decide)) return 0;
      if (_wardRunActive()) return 0;
    } catch (_) {}
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
    var _isWardItem = item.lane === "ward";
    var _isSelItem = item.lane === "sel";
    // 選ぶレーンは「同じ種類を7秒以内に押した直後」だけ（1つ目は一覧を探す間を残して普通の道）
    var _pickRef = 0;
    if (item.lane === "pick") {
      try {
        var _pl = window.__axlxPickLastAt || 0;
        if (_pl && window.__axlxPickLastKind === item.pickKind && Date.now() - _pl < 7000) _pickRef = _pl;
      } catch (_) { _pickRef = 0; }
    }
    var _isPickItem = _pickRef > 0;
    // このアイテムの「前の操作」の時刻（select の押す時刻の基準）。fn を包む前に読む
    var _lastClickBefore = 0;
    try { _lastClickBefore = window.__axlxLastClickAt || 0; } catch (_) {}
    if (item.el && !item._laneWrapped) {
      // 押した瞬間を記録（区・select・選ぶレーンの間隔を通常の分布に合わせる基準・長い停止を入れない判定）
      item._laneWrapped = true;
      var _ofn = item.fn;
      item.fn = function () {
        try {
          var _tn = Date.now();
          window.__axlxLastClickAt = _tn;
          if (_isWardItem) window.__axlxWardLastAt = _tn;
          if (item.lane === "pick") { window.__axlxPickLastAt = _tn; window.__axlxPickLastKind = item.pickKind; }
        } catch (_) {}
        return _ofn.apply(this, arguments);
      };
    }
    var pause = _longPauseDue(item);
    if (pause > 0) {
      try { _auditStepP('fill_pause', Math.round(pause / 1000) + '秒（人が手を止めた）'); } catch (_) {}
      var _startAfterPause = function () {
        try { _auditStepP('fill_resume', '止まった後に再開'); } catch (_) {}
        _scheduleClickDrain();
      };
      /**
       * ★ 2026-11-19 タクヤ audit #1513「沿線選択でとまった」:
       *   止まる前に取り出した1件を列へ戻さず捨てていた → その欄は押されないまま __axPending だけ残り、
       *   以後 enqueueHumanClick が黙って弾く → 沿線の段が「全部チェック待ち」を40秒回り続けた。
       *   → 止まった1件は列の先頭へ戻し、再開したらその1件から押す（同じ1件で二度止まらない）。
       */
      item._pauseDone = true;
      _clickQueue.unshift(item);
      _clickBusyItem = null;
      _holdingPause = true;
      var P0 = window.AxlxPointerUi;
      var _endPause = function () { _holdingPause = false; _lastQueueProgressAt = Date.now(); _startAfterPause(); };
      if (P0 && P0.drift) { P0.drift(pause).then(_endPause, _endPause); }
      else { setTimeout(_endPause, pause); }
      return;
    }
    // 区・selectレーンの迷いは下の混合（_wardGapPlan / _selGapPlan）で決める（通常の _hesitateMs は使わない）
    var hesitate = (_isWardItem || _isSelItem || _isPickItem || !item.el || item.decide) ? 0 : _hesitateMs(item.el);
    /**
     * 区・selectレーン: 直前の操作があれば、「直前の操作の時刻＋通常の人の間隔（混合）」を押す時刻の目標にする。
     *   ・速い: カーソルは前の押下の直後から動き、着いたら目標時刻まで見てから押す（_humanPointerClick の tgtAt）
     *   ・迷い／停止: 先にカーソルを欄へ動かし、その上で漂わせてから押す（手が止まる・迷う形）
     *   ・quick（選び直し）は迷い・停止を入れない
     *   基準: 区は直前の区クリック（7秒以内）／select は直前の select の行を押した時刻 or 直前の操作（20秒以内）
     */
    var _wardTgt = null;
    if (_isWardItem || _isSelItem) {
      try {
        var _nowL = Date.now();
        var _ref = 0;
        if (_isWardItem) {
          var _lw = window.__axlxWardLastAt || 0;
          if (_lw && _nowL - _lw < 7000) _ref = _lw;
        } else {
          _ref = Math.max(window.__axlxSelTapAt || 0, _lastClickBefore || 0);
          if (!_ref || _nowL - _ref > 20000) _ref = 0;
        }
        if (_ref) {
          var _plan = item.quick
            ? { kind: "fast", ms: _isWardItem ? _wardPaceMs() : _ln(1500, 0.3, 1000, 2600) }
            : (_isWardItem ? _wardGapPlan() : _selGapPlan());
          if (_plan.kind === "fast") {
            _wardTgt = _ref + _plan.ms;
          } else {
            // 経過分と、移動＋着地（約1秒）を引いた分だけ、欄の上で迷う
            hesitate = Math.max(400, Math.round(_plan.ms - (_nowL - _ref) - 1000));
          }
          try {
            if (_audit && (_plan.kind !== "fast" || Math.random() < 0.3)) {
              _auditStepP(_plan.kind === "pause" ? "fill_pause" : "ward_pace", (_isWardItem ? "区" : "select") + " " + _plan.kind + " 目標間隔" + Math.round(_plan.ms) + "ms");
            }
          } catch (_) {}
        }
      } catch (_) { _wardTgt = null; }
    }
    if (_isPickItem) {
      try {
        var _pPlan = item.quick ? { kind: "fast", ms: _pickPaceMs(item.pickKind) } : _pickGapPlan(item.pickKind);
        item.gap = _ln(110, 0.45, 50, 260);
        if (_pPlan.kind === "fast") {
          _wardTgt = _pickRef + _pPlan.ms;
        } else {
          hesitate = Math.max(400, Math.round(_pPlan.ms - (Date.now() - _pickRef) - 1000));
        }
        if (_audit && (_pPlan.kind !== "fast" || Math.random() < 0.3)) {
          _auditStepP(_pPlan.kind === "pause" ? "fill_pause" : "pick_pace",
            String(item.pickKind) + " " + _pPlan.kind + " 目標間隔" + Math.round(_pPlan.ms) + "ms"
            + (Number(window.__axlxLearnGapMs) > 0 ? "（束の人の間隔" + Math.round(window.__axlxLearnGapMs) + "ms）" : "（束なし・既定）"));
        }
      } catch (_) { _wardTgt = null; }
    }
    var _planned = item.gap + hesitate, _setAt = Date.now();
    if (hesitate > 0) { try { _tmarkHesitate(item.label, hesitate); } catch (_) {} }
    // 2026-11-10 v2.6.2 竹内さん「人間が迷いながらマウスもまよったりしながら考えながら入力していく」:
    //   迷う時は、まず**カーソルをその要素へ動かしてから漂わせる**（迷っている間に手が漂う形）。
    //   要素が無い（select/text の汎用アクション）時は、その場で漂わせる。迷いが終わってから押す。
    var _hesitateDrift = hesitate > 0 && item.el && window.AxlxPointerUi && window.AxlxPointerUi.moveToEl;
    var _startClick = function () {
    _clickQueueTimer = setTimeout(function() {
      _clickQueueTimer = null;
      /**
       * ★ 2026-11-17 統括Pro「aim無／learn_warm=0」:
       *   積んだ時点で束が未温だと aim無のまま押す。押す直前に再引きする。
       */
      try {
        if (item.el && !item.aim) {
          var _re = null;
          try { _re = _aimByEl(item.el, item.keys || null); } catch (_) { _re = null; }
          if (!_re) {
            try {
              var _nmR = item.el.getAttribute && item.el.getAttribute("name");
              if (_nmR) _re = _aimOf(_nmR);
            } catch (_) {}
          }
          if (_re) {
            item.aim = _re;
            try { _auditStepP("cursor_aim", String(item.label || "el") + " aim有(再引き)" + (_re.fromScreen ? "(画面)" : "") + (_re.thin ? "(薄)" : "")); } catch (_) {}
          }
        }
      } catch (_) {}
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
        var settle = (_isWardItem || item.lane === "pick") ? _ln(110, 0.4, 60, 260) : (_isSelItem ? _ln(90, 0.4, 50, 200) : _afterClickGapMs(item.el));
        setTimeout(function () {
          _clickBusyItem = null;
          _clickQueueTimer = null;
          _scheduleClickDrain();
        }, settle);
      };
      try {
        // v2.5.96: 画面の外の時だけ最小の移動で見える位置へ寄せ、動かしたら終わるまで待ってから押す
        /**
         * ★ 2026-11-17 統括Pro F36「押す/外す前に画面内にあるか」:
         *   _ensureInView 後も端外なら center をもう一度（スクロール未定着の関所）。
         */
        var _viewWait = item.el ? _ensureInView(item.el) : 0;
        var _gateScroll = function () {
          try {
            if (!item.el || !item.el.getBoundingClientRect) return 0;
            var rr = item.el.getBoundingClientRect();
            var vh2 = window.innerHeight || 800;
            if (rr.top >= 40 && rr.bottom <= vh2 - 40) return 0;
            item.el.scrollIntoView({
              behavior: Math.random() < 0.8 ? "smooth" : "auto",
              block: "center",
              inline: "nearest",
            });
            try { if (_audit) _auditStepP("scroll_gate", String(item.label || "").slice(0, 36)); } catch (_) {}
            return 280 + Math.floor(Math.random() * 320);
          } catch (_) { return 0; }
        };
        if (_viewWait > 0) {
          setTimeout(function () {
            var extra = _gateScroll();
            var go = function () {
              try {
                var ret2 = item.el ? _humanPointerClick(item.el, item.fn, item.aim || null, _wardTgt) : item.fn();
                if (ret2 && typeof ret2.then === "function") { ret2.then(done, done); return; }
              } catch (e2) { console.error('[AX] humanClick 例外（続行）', e2); }
              done();
            };
            if (extra > 0) setTimeout(go, extra);
            else go();
          }, _viewWait);
          return;
        }
        var _extra0 = _gateScroll();
        if (_extra0 > 0) {
          setTimeout(function () {
            try {
              var ret3 = item.el ? _humanPointerClick(item.el, item.fn, item.aim || null, _wardTgt) : item.fn();
              if (ret3 && typeof ret3.then === "function") { ret3.then(done, done); return; }
            } catch (e3) { console.error('[AX] humanClick 例外（続行）', e3); }
            done();
          }, _extra0);
          return;
        }
        // 2026-11-10 人間的な動き: 要素を押す時は、人の軌跡でマウスを動かしてから押す（mousemove〜click）。
        //   item.fn は今まで通り最後の1回だけ呼ぶ（_clickIfUnchecked 等のガードはそのまま効く）
        //   ★ 2026-11-16: 学んだ押す位置（item.aim）があればその点へ（プルダウン・入力欄）
        var ret = item.el ? _humanPointerClick(item.el, item.fn, item.aim || null, _wardTgt) : item.fn();
        if (ret && typeof ret.then === "function") { ret.then(done, done); return; }
      } catch (e) { console.error('[AX] humanClick 例外（続行）', e); }
      done();
    // 区・selectレーン: 迷いは欄の上で漂って（drift）済みなので、タイマーで二重に待たない（迷い＝設計した長さだけ）
    }, item.gap + (((_isWardItem || _isSelItem || _isPickItem) && hesitate > 0 && window.AxlxPointerUi && window.AxlxPointerUi.drift) ? 0 : hesitate));
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
    // ★ 2026-11-20: 順番待ちの外の押し（clickByText・simulateClick＝小窓を開く・次へ・区のボタン）も「忙しい」に数える。
    //   旧は見えず、押している最中に次の段が始まりカーソルが重なっていた。数が残っても8秒で忙しくないとする（止まらない）。
    var _pressing = _pressBusy > 0 && Date.now() - _pressBusyAt < 8000;
    return _clickQueueTimer !== null || _clickQueue.length > 0 || !!_clickBusyItem || _holdingPause || _pressing;
  }
  function whenClickQueueIdle(cb, pollMs) {
    if (_axHumanTookOver) return;
    if (!isClickQueueBusy()) { cb(); return; }
    // pollMs: 区レーンなど「終わった瞬間に次へ」進めたい所だけ短くする（既定 150ms）
    setTimeout(function() { whenClickQueueIdle(cb, pollMs); }, pollMs > 0 ? pollMs : _pd(150));
  }
  /**
   * ★ 2026-11-16 竹内さん「ちゃんとひとつずつ選択できるように／同時にうごかないように／1つずつ人間のように」:
   *   ⚠ 実測（まりあ自動 2.7.85）: `rental_cost2`・`update_date`・`structured_date` の change が
   *     **同じ1ms台**に並んでいた（人がやらない同時操作）。通常は間隔中央 1.6秒・80ms未満ゼロ。
   *   → 条件キューを**一気に全部積まず**、1件 `run` → キューが空になるまで待つ → 次、を繰り返す。
   *     `_clickQueue` の直列化に加え、**項目どうしの重なり**を止める。
   */
  function _runBasicOneByOne(queue, done) {
    var q = Array.isArray(queue) ? queue.slice() : [];
    var i = 0;
    function step() {
      if (i >= q.length) {
        whenClickQueueIdle(function () { try { if (typeof done === "function") done(); } catch (_) {} });
        return;
      }
      var item = q[i++];
      /**
       * ★ 2026-11-16: run が Promise を返す場合（ペットで絞り込み条件を開く等）は待つ。
       *   旧は即 whenClickQueueIdle → 開く前に次の欄へ進んでいた。
       */
      var afterRun = function () {
        whenClickQueueIdle(function () {
          /**
           * ★ 2026-11-18 竹内さん「家賃・更新日の前後も通常モードの人間のように」:
           *   旧は 項目どうしに 0.45〜1.35s（＋12%で+0.7〜1.9s）を足していた。select は次の欄までの間隔を
           *   _selGapPlan（通常の分布・迷い／停止つき）が決めるので、ここの足しは短く（二重にしない）。
           */
          var pause = _ln(200, 0.45, 90, 650);
          setTimeout(step, pause);
        }, 40);
      };
      try {
        if (item && typeof item.run === "function") {
          var ret = item.run();
          if (ret && typeof ret.then === "function") {
            ret.then(afterRun, afterRun);
            return;
          }
        }
      } catch (_) {}
      afterRun();
    }
    step();
  }
  /**
   * ★ 2026-11-16 自動録画実測: 通常は 所在地/駅 → 条件 → 検索。
   *   自動は条件が先・確定clickより検索が先、になっていた。
   *   → 場所（所在地 or 駅）が終わった**あと**に条件を1つずつ → 検索。
   *     所在地・駅のどちらからでも同じ関数を使う（fillRealpro 共通）。
   */
  /**
   * ★ 2026-11-16 竹内さん「駅を外しただけで地域を選ばず検索／大阪全部が出る」:
   *   場所（区 or 駅）を入れ終わるまで false。`_runDeferredBasicThenSearch` だけが true にする。
   *   clickSearch / 25秒保険はこれが true になるまで押さない（全件検索防止）。
   */
  var _axPlaceReady = false;
  /**
   * ★ 2026-11-16 竹内さん「間取りや敷金礼金なしのチェックが入る前に検索が走った／タイムアウト？」:
   *   DB実測: `search_guard_press` → あとから `basic_after_place` → `gate_warn` → `search`
   *   ＝25秒保険が**基本条件（間取り・敷礼など）の前に**検索を押し、関所は警告だけで通した。
   *   → 場所だけでなく、基本条件が終わるまで `_axConditionsReady` を false にする。
   */
  var _axConditionsReady = false;
  function _markPlaceReady(why) {
    _axPlaceReady = true;
    try { window.__axlxForceClearAllPlace = false; } catch (_) {}
    try { if (_audit) _auditStepP("place_ready", String(why || "場所確定").slice(0, 80)); } catch (_) {}
    try { _noteFlowPhase("place", true, why || "場所確定"); } catch (_) {}
    try { _noteFlowAtom("place_select", true, why || "場所確定"); } catch (_) {}
    try { _noteNowCustomer("place", why || "場所確定"); } catch (_) {}
  }
  function _markConditionsReady(why) {
    _axConditionsReady = true;
    try { if (_audit) _auditStepP("conditions_ready", String(why || "条件そろった").slice(0, 80)); } catch (_) {}
    try { _noteFlowPhase("conditions", true, why || "条件そろった"); } catch (_) {}
    try { _noteFlowAtom("conditions", true, why || "条件そろった"); } catch (_) {}
    try { _noteNowCustomer("conditions", why || "条件そろった"); } catch (_) {}
    try { _emitFillProgressHeartbeat("conditions_ready"); } catch (_) {}
  }
  /**
   * ★ 2026-11-18 HONOKA根本: 欲しい間取りの hit/miss を1か所で測る（関所・検索前・把握の正本）。
   *   旧は「1つでもチェック」で完了扱い → 1DK+1LDK なのに 1DK だけでも次へ進んだ。
   */
  function _layoutWantReport(wantVals) {
    var want = (wantVals || []).map(String).filter(Boolean);
    var allChk = [];
    try {
      allChk = Array.prototype.slice.call(document.querySelectorAll('input[name="room_layout_id[]"]:checked'))
        .map(function (cb) { return String(cb.value); });
    } catch (_) { allChk = []; }
    var hit = want.filter(function (v) { return allChk.indexOf(v) >= 0; });
    var missing = want.filter(function (v) { return allChk.indexOf(v) < 0; });
    var extras = allChk.filter(function (v) { return want.indexOf(v) < 0; });
    return {
      wantN: want.length,
      hitN: hit.length,
      missing: missing,
      extras: extras,
      ok: want.length > 0 ? (missing.length === 0 && extras.length === 0) : extras.length === 0,
      partial: want.length > 0 && hit.length > 0 && missing.length > 0,
    };
  }
  /**
   * ★ 2026-11-18 HONOKA根本（物件未取得）:
   *   リアプロは検索でページ再読込 → MAIN の _autoSendArmed / notifyDone が消える。
   *   Case C は session の axlx_pending_auto_send だけが生存経路。
   *   旧: その印は popup の go_search 監視だけが書いていた → **自動の clickSearch では印が立たない**
   *     → リロード後 Case C 不発 → 物件取得ゼロ／監査 status=started のまま。
   *   → 検索 click **直前**に postMessage（同期）で content/bulk-dl に印を書かせる。
   */
  function _armPropertyPathBeforeSearch(why) {
    try {
      window.postMessage({
        from: "axlx-search-armed",
        customerId: _fillCustomerId || null,
        ts: Date.now(),
        why: String(why || "search").slice(0, 48),
        pageVer: _AXLX_PAGE_VER,
      }, "*");
      try { if (_audit) _auditStepP("search_armed", "物件取得のリロード生存印 " + String(why || "").slice(0, 40)); } catch (_) {}
    } catch (_) {}
  }
  /**
   * ★ 2026-11-17 F45 統括Pro「何が完了しているか理解していない／完了→次客」:
   *   ボタン理解（F41）と同型で、客1人の一連の段を1つずつ把握する。
   *   段: switch → place → conditions → search → fill_done → ready_next
   *   全部 ok のときだけ「次客へ渡してよい」と理解する（抜けを測れる）。
   */
  var _FLOW_PHASES = ["switch", "place", "conditions", "search", "fill_done", "ready_next"];
  function _noteFlowPhase(phase, ok, detail) {
    try {
      if (!window.__axlxFlowUnderstood) window.__axlxFlowUnderstood = {};
      var ph = String(phase || "").slice(0, 24);
      if (!ph) return;
      window.__axlxFlowUnderstood[ph] = {
        ok: !!ok,
        at: Date.now(),
        d: String(detail || "").slice(0, 80),
      };
      if (_audit) {
        _auditStepP(
          ok ? ("flow_done_" + ph) : ("flow_gap_" + ph),
          String(detail || (ok ? "完了理解" : "未完了")).slice(0, 100),
        );
      }
      try {
        window.postMessage({
          from: "axlx-rec-note-name",
          name: ((ok ? "完了済:" : "未完了:") + ph).slice(0, 40),
        }, "*");
      } catch (_) {}
    } catch (_) {}
  }
  function _flowReadyForNext() {
    try {
      var m = window.__axlxFlowUnderstood || {};
      return !!(
        m.place && m.place.ok &&
        m.conditions && m.conditions.ok &&
        m.search && m.search.ok &&
        m.fill_done && m.fill_done.ok
      );
    } catch (_) { return false; }
  }
  function _auditFlowUnderstandLedger(where) {
    try {
      var m = window.__axlxFlowUnderstood || {};
      var okParts = [], gapParts = [];
      for (var i = 0; i < _FLOW_PHASES.length; i++) {
        var ph = _FLOW_PHASES[i];
        if (ph === "ready_next") continue;
        var row = m[ph];
        if (row && row.ok) okParts.push(ph);
        else gapParts.push(ph);
      }
      var ready = _flowReadyForNext();
      if (ready) {
        _noteFlowPhase("ready_next", true, "一連完了→次客へ渡してよい");
      } else if (gapParts.length) {
        _noteFlowPhase("ready_next", false, "未=" + gapParts.join(","));
      }
      if (_audit) {
        _auditStepP(
          "flow_understand_ledger",
          String(where || "ledger") +
            " ok=[" + okParts.join(",") + "]" +
            (gapParts.length ? " 未=[" + gapParts.join(",") + "]" : "") +
            " ready_next=" + (ready ? "Y" : "N"),
        );
      }
      try {
        window.postMessage({
          from: "axlx-rec-note-name",
          name: ("流れ台帳:ok" + okParts.length + "/未" + gapParts.length + (ready ? "/次可" : "")).slice(0, 40),
        }, "*");
      } catch (_) {}
      return ready;
    } catch (_) { return false; }
  }
  /**
   * ★ 2026-11-16 竹内さん「続きのお客さんにうつるとき所在地や駅の選択をやりなおす」
   *   「もともとのお客さんの地域や駅はずして新しい条件を選択」:
   *   自動の続き客では前客の地域/駅を**全部外す**（人が選んだ物を残すのは通常モードのみ）。
   *   ⚠ 旧バグ: `_resetAutoPicked()` で空オブジェクトを置くと「覚えあり・中身なし」になり、
   *     前客のチェックを全部「人が選んだ」と誤認して**残していた**。
   */
  function _shouldForceClearPrevPlace() {
    try {
      if (window.__axlxForceClearAllPlace) return true;
      if (window._axAutoPicking) return true;
    } catch (_) {}
    return false;
  }
  function _autoPickedHasMemory() {
    try {
      var a = window.__axAutoPicked;
      if (!a || typeof a !== "object") return false;
      return ["city", "town", "station"].some(function (k) {
        return Array.isArray(a[k]) && a[k].length > 0;
      });
    } catch (_) { return false; }
  }
  function _runDeferredBasicThenSearch(why) {
    /**
     * ★ 根本: 場所のあともパネル負債が残っていれば先に確定清算（CONFIRM=0 の根を塞ぐ）。
     *   条件投入・検索は清算後だけ。
     */
    _settlePanelDebtThen("場所のあと・パネル清算:" + String(why || ""), function () {
      _markPlaceReady(why || "場所のあと");
      var q = null;
      try { q = window.__axDeferredBasicQueue; window.__axDeferredBasicQueue = null; } catch (_) { q = null; }
      function _goSearchAfterBasic() {
        _settlePanelDebtThen("条件後・検索前清算", function () {
          /**
           * ★ 2026-11-18: conditions_ready の前に間取り全 hit を強制確認。
           *   1つ欠けていれば1回だけ入れ直し → それでも欠けても印を残してから検索へ（関所が止める）。
           */
          function _afterLayoutGrasp() {
            _markConditionsReady(why || "基本条件のあと");
            setTimeout(clickSearch, 700 + Math.floor(Math.random() * 500));
          }
          try {
            var wantL = (_axExpect && _axExpect.layoutVals) ? _axExpect.layoutVals.map(String) : [];
            if (wantL.length) {
              var rep0 = _layoutWantReport(wantL);
              try { if (typeof _understandLayoutScene === "function") _understandLayoutScene(wantL); } catch (_) {}
              if (rep0.missing.length) {
                try {
                  if (_audit) {
                    _auditStepP(
                      "layout_pre_search_miss",
                      "検索前: 欲しい" + rep0.wantN + "のうち" + rep0.hitN + "だけ／不足=" + rep0.missing.slice(0, 6).join(",")
                    );
                  }
                } catch (_) {}
                try { setCheckboxes("room_layout_id[]", wantL); } catch (_) {}
                whenClickQueueIdle(function () {
                  var rep1 = _layoutWantReport(wantL);
                  try { if (typeof _understandLayoutScene === "function") _understandLayoutScene(wantL); } catch (_) {}
                  try {
                    if (_audit) {
                      _auditStepP(
                        rep1.missing.length ? "layout_pre_search_still_miss" : "layout_pre_search_fixed",
                        "入れ直し後 hit=" + rep1.hitN + "/" + rep1.wantN +
                          (rep1.missing.length ? (" 不足=" + rep1.missing.slice(0, 6).join(",")) : "")
                      );
                    }
                  } catch (_) {}
                  _afterLayoutGrasp();
                });
                return;
              }
              try {
                if (_audit) _auditStepP("layout_pre_search_ok", "間取り全hit " + rep0.hitN + "/" + rep0.wantN);
              } catch (_) {}
            }
          } catch (_) {}
          _afterLayoutGrasp();
        });
      }
      if (q && q.length) {
        try { if (_audit) _auditStepP("basic_after_place", (why || "場所のあと") + " → 条件を1つずつ" + q.length + "件"); } catch (_) {}
        _runBasicOneByOne(q, _goSearchAfterBasic);
        return;
      }
      _goSearchAfterBasic();
    });
  }
  /**
   * ★ 2026-11-16: page-script（MAIN）から録画（content）へ click を渡す。
   *   ネイティブ select は OS一覧防止のため本物の click を送らない → change だけが録画に残り「押さず変化」になる。
   *   → `__axlxRecNoteOp`（同世界）＋ postMessage（別世界）の両方で click を残す。
   */
  /**
   * ★ 2026-11-16 統括Pro「was欠落」: MAIN→isolated は window 関数が届かない。
   *   CustomEvent は同期で DOM 共有するため、click 前に was を渡せる。
   */
  function _armWasForLearn(el) {
    try {
      var c = el;
      if (c && c.querySelector) {
        var i = c.querySelector('input[type="checkbox"],input[type="radio"]');
        if (i) c = i;
      }
      if (!c || typeof c.checked !== "boolean") return;
      var nm = "";
      try { nm = String((c.getAttribute && c.getAttribute("name")) || ""); } catch (_) {}
      var detail = { name: nm.slice(0, 40), was: !!c.checked };
      try {
        document.documentElement.dispatchEvent(new CustomEvent("axlx-rec-arm-was", { detail: detail, bubbles: true }));
      } catch (_) {}
      try { window.postMessage({ from: "axlx-rec-arm-was", name: detail.name, was: detail.was }, "*"); } catch (_) {}
      try { if (typeof window.__axlxRecArmWas === "function") window.__axlxRecArmWas(c); } catch (_) {}
    } catch (_) {}
  }
  function _noteClickForLearn(el, wasOpt, pt) {
    try {
      if (typeof window.__axlxRecNoteOp === "function") window.__axlxRecNoteOp("click", el);
    } catch (_) {}
    try {
      var nm = "";
      var w = "click";
      if (el) {
        nm = (el.getAttribute && (el.getAttribute("name") || el.getAttribute("id"))) || "";
        if (!nm) nm = String(el.textContent || el.value || "").replace(/\s+/g, "").slice(0, 30);
        try {
          var ty = String((el.getAttribute && el.getAttribute("type")) || "").toLowerCase();
          if (ty === "checkbox" || ty === "radio") w = ty;
          else if (/one_city|one_station|one_line|label/i.test(String(el.className || ""))) w = "checkbox";
        } catch (_) {}
      }
      var msg = { from: "axlx-rec-note-op", kind: "click", name: String(nm || "click").slice(0, 40), w: w };
      if (typeof wasOpt === "boolean") msg.was = wasOpt;
      /**
       * ★ 2026-11-20 (2.8.134) 統括Pro「押した位置14%」: 押した実座標を要素の中の割合で送る。
       *   実測（run_mwofi2sn_jbec）: 印刷用PDF・確定してリストへ・検索・次ページなど 18回が位置なし。
       *   旧は名前だけ送り、記録側は elementFromPoint／name で要素を探していた
       *   （表示名では見つからない・中央の拡張小窓に当たると別の要素になる）。
       *   ⚠ 要素の外（±20%より外）なら送らない（嘘の位置を入れない）。
       */
      try {
        if (el && pt && Number.isFinite(Number(pt.x)) && Number.isFinite(Number(pt.y)) && el.getBoundingClientRect) {
          var _r = el.getBoundingClientRect();
          if (_r && _r.width > 0 && _r.height > 0) {
            var _fx = (Number(pt.x) - _r.left) / _r.width;
            var _fy = (Number(pt.y) - _r.top) / _r.height;
            if (_fx >= -0.2 && _fx <= 1.2 && _fy >= -0.2 && _fy <= 1.2) {
              msg.fx = Math.round(Math.max(0, Math.min(1, _fx)) * 100) / 100;
              msg.fy = Math.round(Math.max(0, Math.min(1, _fy)) * 100) / 100;
              msg.bw = Math.round(_r.width);
              msg.bh = Math.round(_r.height);
              var _tg = String(el.tagName || "").toLowerCase();
              if (_tg) msg.bt = _tg.slice(0, 12);
              var _cls = String((el.className && typeof el.className === "string") ? el.className : "").trim();
              var _first = _cls ? _cls.split(/\s+/).filter(Boolean)[0] : "";
              if (_first) msg.shape = (_tg ? _tg + "." : "") + String(_first).slice(0, 24);
              msg.clientX = Number(pt.x);
              msg.clientY = Number(pt.y);
            }
          }
        }
      } catch (_) {}
      window.postMessage(msg, "*");
    } catch (_) {}
  }
  /**
   * ★ 2026-11-17 統括Pro「_fireAt→point 座標配線」:
   *   page-script（MAIN）から押した実座標を isolated の録画へ渡す。
   *   旧は _noteClickForLearn だけ → point_fields が空／真ん中固定で point_pct が上がらなかった。
   */
  function _notePointForLearn(el, cx, cy) {
    try {
      if (!Number.isFinite(Number(cx)) || !Number.isFinite(Number(cy))) return;
      var nm = "";
      try {
        if (el) {
          nm = (el.getAttribute && (el.getAttribute("name") || el.getAttribute("id"))) || "";
          if (!nm) nm = String(el.textContent || el.value || "").replace(/\s+/g, "").slice(0, 30);
        }
      } catch (_) { nm = ""; }
      window.postMessage({
        from: "axlx-rec-point",
        name: String(nm || "").slice(0, 40),
        clientX: Number(cx),
        clientY: Number(cy),
        synthetic: true,
      }, "*");
    } catch (_) {}
  }
  // fillRealpro 開始時に前回残留のキューを破棄（pendingフラグも解除）
  function clearClickQueue() {
    _clickQueue.forEach(function(it) { if (it.el) it.el.__axPending = false; });
    _clickQueue.length = 0;
    try { if (_clickBusyItem && _clickBusyItem.el) _clickBusyItem.el.__axPending = false; } catch (_) {}
    _clickBusyItem = null;
    if (_clickQueueTimer) { clearTimeout(_clickQueueTimer); _clickQueueTimer = null; }
  }
  /**
   * ★ 2026-11-18 平田 run_mwlrwjhx_xoqv: 自動が止まったので人が引き取って入力していた間も、
   *   裏で自動の verify が 3秒ごとに淀川区を外し続けていた（ward_extra_clear_click 59件・人の操作と並走）。
   *   → 自動の入力中に**人が検索欄を押した／変えた**ら、自動はその場で手を引く（人の操作が優先）。
   *   ⚠ 拡張の合成イベントは isTrusted=false なので数えない。スクロールバー・余白・拡張の小窓は数えない。
   */
  var _axHumanTookOver = false;
  var _axFillStartedAt = 0;
  function _isHumanTakeoverTarget(t) {
    try {
      if (!t || t.nodeType !== 1) return false;
      if (t === document.documentElement || t === document.body) return false;
      if (t.closest && t.closest('[id^="aixlinx-"], [id^="axlx"], [data-axlx-shape]')) return false;
      return !!(t.closest && t.closest(
        'input, select, textarea, label, button, a, td.pager, .click_menu, .one_city, .one_town, .one_line, .one_station, ' +
        '.close_search_detail, .search_list, .next_step_button2, [class*="btn"], [class*="button"]'
      ));
    } catch (_) { return false; }
  }
  /**
   * ★ 2026-11-18 竹内さん「次のお客さんが入ってきてバグ起きたのか地域の途中で止まってしまった」:
   *   平田 audit 1488: 自動が大阪市都島区のラベルを押した直後に `human_takeover（change:city_code[]）` で止まった。
   *   ⚠ スクリプトの .click() でもブラウザが出す change / click は isTrusted=true になる（自動の自分の操作を人と取り違えた）。
   *   → 人の判定は**スクリプトでは作れない** pointerdown（マウス・タッチ）と keydown（キーボード）だけにする。
   *     click / change は見ない。
   */
  function _onHumanTakeover(e) {
    try {
      if (!e || !e.isTrusted) return;
      if (e.type !== "pointerdown" && e.type !== "keydown") return;
      if (!window._axFillRunning || _doneNotified || _axHumanTookOver) return;
      if (_axFillStartedAt && Date.now() - _axFillStartedAt < 1500) return;
      if (e.type === "keydown") {
        var _kt = e.target;
        if (!_kt || !_kt.closest || !_kt.closest("input, select, textarea")) return;
        if (_kt.closest('[id^="aixlinx-"], [id^="axlx"], [data-axlx-shape]')) return;
      } else if (!_isHumanTakeoverTarget(e.target)) return;
      _axHumanTookOver = true;
      var what = "";
      try {
        var tg = e.target;
        what = String((tg.getAttribute && tg.getAttribute("name")) || (tg.textContent || "").replace(/\s+/g, "")).slice(0, 24);
      } catch (_) {}
      try { clearClickQueue(); } catch (_) {}
      try { if (_audit) _auditStepP("human_takeover", e.type + ":" + what + "（人の操作を優先して自動を止めた）"); } catch (_) {}
      try { _noteFlowPhase("human_takeover", false, e.type + ":" + what); } catch (_) {}
      console.warn("[AX] 人が操作したので自動入力を止めます:", e.type, what);
      // gate: 人が物件を選ぶので bulk-dl の全ページ自動送信を構えない
      notifyDone("human_takeover: 人が操作したので自動入力を止めました（" + e.type + ":" + what + "）", "human_takeover");
    } catch (_) {}
  }
  try {
    document.addEventListener("pointerdown", _onHumanTakeover, true);
    document.addEventListener("keydown", _onHumanTakeover, true);
  } catch (_) {}
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
  /** 一覧の号室メニュー（印刷用PDF等の小さな menu）の中の要素か。検索の小窓（div.this_window_close）とは別物 */
  function _isRoomMenuEl(el) {
    try {
      if (!el) return false;
      if (/room_menu/.test(String(el.className || ""))) return true;
      return !!(el.closest && el.closest('[class*="room_menu"]'));
    } catch (_) { return false; }
  }
  /** 号室メニューの ×とじる が**画面の中に本当に出ている**時だけ返す（隠れ・透明・画面外は null＝押さない） */
  function _roomMenuCloseOnScreen() {
    try {
      var cands = Array.prototype.slice.call(document.querySelectorAll('.hide_room_menu_close, [class*="room_menu"] a, [class*="room_menu"] div, [class*="room_menu"] span'));
      for (var i = 0; i < cands.length; i++) {
        var el = cands[i];
        var t = String(el.textContent || "").replace(/\s+/g, "");
        if (!/とじる|閉じる/.test(t) || t.length > 8) continue;
        if (!isVisible(el)) continue;
        var s = window.getComputedStyle(el);
        if (Number(s.opacity) === 0) continue;
        var r = el.getBoundingClientRect();
        var vw = window.innerWidth || 1200, vh = window.innerHeight || 800;
        if (r.left < 0 || r.top < 0 || r.right > vw || r.bottom > vh) continue;
        var cx = r.left + r.width / 2, cy = r.top + r.height / 2;
        var top = document.elementFromPoint ? document.elementFromPoint(cx, cy) : el;
        if (top && top !== el && !el.contains(top) && !top.contains(el)) continue;
        return el;
      }
    } catch (_) {}
    return null;
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
    _pressBusyAt = Date.now();
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
  var _pressBusyAt = 0;
  /**
   * 順番待ちの外でカーソルを動かして押す時の共通の入口。動き始めから押し終わりまで「忙しい」に数え、
   * 押し終わりで解ける Promise を返す（続けて押す時は、前の押しが終わってから次を動かす）。
   */
  function _pressHumanTracked(el, fn, aim) {
    _pressBusy++;
    _pressBusyAt = Date.now();
    var fin = false;
    var done = function () { if (fin) return; fin = true; _pressBusy = Math.max(0, _pressBusy - 1); };
    var p = null;
    try { p = _humanPointerClick(el, fn, aim || null); } catch (_) {
      try { fn(el); } catch (__) {}
      done();
      return Promise.resolve(false);
    }
    if (p && typeof p.then === "function") {
      return p.then(function (v) { done(); return v; }, function () { done(); return false; });
    }
    done();
    return Promise.resolve(true);
  }

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
  /** ★ 2026-11-17: 等間隔 retry をやめ対数正規＋ジッター（統括Pro ±30%） */
  function _modalRetryMs() {
    var H = window.AxlxHumanWait;
    var v = H && H.logNormalDelay ? H.logNormalDelay(780, 0.4) : (650 + Math.floor(Math.random() * 350));
    v *= 0.7 + Math.random() * 0.6; // ±30% 前後
    if (v < 420) v = 420;
    if (v > 1600) v = 1600;
    return Math.round(v);
  }
  /**
   * ★ 2026-11-19 竹内さん「タイムアウトでボトルネックとなっている部分を取り除いていく必要がある」:
   *   段の中の短い期限（開くまで6秒・駅の設定へ9秒・開き直し12秒 等）を壁時計で数えると、
   *   人の長い間（8〜25秒）・クリックの列・画面が隠れている間も減り、押す前／押した直後に
   *   「開かない・移らない」と諦めていた（#1513 の長い停止と同じ型）。
   *   → 「動ける間」だけ数える時計。列が動いている間・画面が隠れている間は進めない。
   *     waitForClick の試しは列が空の時だけ走るので、1回の間は最大 capMs までしか足さない。
   */
  function _activeClock(capMs) {
    var last = 0, el = 0, cap = capMs || 1200;
    return {
      tick: function () {
        var now = Date.now();
        var idle = true;
        try { idle = !isClickQueueBusy(); } catch (_) { idle = true; }
        try { if (document.visibilityState === "hidden") idle = false; } catch (_) {}
        if (last && idle) el += Math.min(cap, Math.max(0, now - last));
        last = now;
        return el;
      },
    };
  }
  var _placeClearClock = _activeClock();

  function waitForClick(tryFn, onDone, maxTries, retryMs, pauseMs, onFail) {    maxTries = maxTries !== undefined ? maxTries : 30;
    retryMs  = retryMs  !== undefined ? retryMs  : _modalRetryMs();
    pauseMs  = pauseMs  !== undefined ? pauseMs  : _hd(600); // 省略時も毎回ばらつかせる（呼ぶ側の多くは既に乱数）
    var tries = 0;
    function attempt() {
      if (_axHumanTookOver) return;
      // 人間らしいクリックキュー消化中は判定・クリックを開始しない
      // （前ステップのクリックが全て完了してから次ステップに進む＝順序保証。試行回数は消費しない）
      if (isClickQueueBusy()) {
        var Hbusy = window.AxlxHumanWait;
        var busyWait = Hbusy && Hbusy.logNormalDelay ? Hbusy.logNormalDelay(180, 0.4) : _pd(150);
        setTimeout(attempt, Math.max(80, Math.round(busyWait)));
        return;
      }
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
        // 毎回ちがう待ち（固定 retryMs の等間隔感を消す）
        var waitR = _pd(retryMs) * (0.7 + Math.random() * 0.6);
        if (Math.random() < 0.08) waitR += 200 + Math.floor(Math.random() * 500);
        setTimeout(attempt, Math.max(120, Math.round(waitR)));
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
  /**
   * ★ 2026-11-15 竹内さん「検索の条件に、その他の要望と必須・できればも並べる」（依頼2-3）
   *
   *   ⚠ 「その他の要望」は自由文なのでサイトの欄には入れられない（無理に入れると検索が壊れる）。
   *   → **検索の直前に、画面の隅に小さく出す**（人が見て必要な物だけ手で入れる）。
   *     ⚠ 見せるだけ（押させない・検索の邪魔をしない・8秒で消える）。
   *     ⚠ 入力した中身は残さない（要望はお客様の情報・写真にもDBにも入れない）。
   *     ⚠ 同じ内容を何度も出さない（同じ検索で2回描かない）。
   */
  var _otherReqShownFor = "";
  function _showOtherRequests(cond) {
    try {
      if (!cond) return;
      var list = [];
      if (Array.isArray(cond.other_requests_list)) list = cond.other_requests_list.slice(0, 10);
      else if (cond.other_requests) {
        list = String(cond.other_requests).split(/[・、,／\/]+/).map(function (s) { return String(s).trim(); }).filter(Boolean).slice(0, 10);
      }
      var strength = String(cond.requirement_strength || "").trim();
      if (!list.length && !strength) return;
      var stamp = list.join("|") + "#" + strength;
      if (stamp === _otherReqShownFor) return;   // 同じ内容は描き直さない
      _otherReqShownFor = stamp;
      var old = document.getElementById("axlx-other-req");
      if (old && old.parentNode) old.parentNode.removeChild(old);
      var d = document.createElement("div");
      d.id = "axlx-other-req";
      d.setAttribute("data-axlx", "1");
      d.style.cssText = "position:fixed;right:12px;bottom:12px;z-index:2147483000;max-width:260px;"
        + "background:rgba(17,24,39,.94);color:#fff;border-radius:10px;padding:8px 10px;"
        + "font:600 11px/1.5 -apple-system,system-ui,sans-serif;pointer-events:none;opacity:.95;box-shadow:0 4px 14px rgba(0,0,0,.3)";
      var html = "";
      if (strength) {
        html += '<div style="opacity:.85;margin-bottom:3px">条件の強さ: ' + _escHtml(strength) + "</div>";
      }
      if (list.length) {
        html += '<div style="opacity:.85;margin-bottom:2px">その他の要望:</div>';
        html += '<div>・' + list.map(_escHtml).join("<br>・") + "</div>";
      }
      d.innerHTML = html;
      (document.body || document.documentElement).appendChild(d);
      // 8秒で消す（見せるだけ・ずっと残らない）
      setTimeout(function () {
        try { if (d && d.parentNode) d.parentNode.removeChild(d); } catch (_) {}
      }, 8000);
    } catch (_) {}
  }
  /** 画面に出す時の安全な文字（タグを消す） */
  function _escHtml(s) {
    return String(s == null ? "" : s).replace(/[&<>"']/g, function (c) {
      return ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c];
    });
  }

  function _auditReset(runId) {    _fillRunId = runId || null;
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
    // ★ 2026-11-18: 入力が進んでいる印（次のお客さんの依頼を断るか・止まった入力として閉じるかの判定に使う）
    try { window.__axlxFillTouchAt = Date.now(); } catch (_) {}
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
          // ★ 2026-11-17 駅/沿線外し土台（録画ノートに残す）
          station_place_clear_begin: "駅・沿線を外す開始",
          station_clear_via_next: "外しのため駅の設定へ進む",
          station_clear_cursor: "駅を外す",
          line_clear_after_station: "沿線を外す",
          station_then_line_clear_force: "駅のあと沿線を外す",
          // ★ 2026-11-17 通常録画正本（2.8.46）: 人が押す戻るは「沿線の設定へ戻る」
          station_clear_back_line: "沿線の設定へ戻る",
          // ⚠ station_go_without_line は録画ノートに載せない（DB汚染・学習を濁す実測）
          station_clear_blocked_no_line: "残駅あるが沿線未選択",
          station_intent_clear: "駅を外す",
          station_intent_select: "駅を選ぶ",
          line_intent_clear: "沿線を外す",
          line_intent_select: "沿線を選ぶ",
          // ★ 2026-11-17 各ボタン理解（選ぶ済/外す済/押す済）→ shot_ops へ
          station_done_select: "選ぶ済:station_id[]",
          station_done_clear: "外す済:station_id[]",
          line_done_select: "選ぶ済:route_id[]",
          line_done_clear: "外す済:route_id[]",
          ward_done_select: "選ぶ済:city_code[]",
          ward_done_clear: "外す済:city_code[]",
          town_done_select: "選ぶ済:town_code[]",
          town_done_clear: "外す済:town_code[]",
          layout_done_select: "選ぶ済:room_layout_id[]",
          layout_done_clear: "外す済:room_layout_id[]",
          pet_done_select: "選ぶ済:eq_rm[]",
          pet_done_clear: "外す済:eq_rm[]",
          confirm_press_ok: "押す済:確定してリストへ",
          confirm_press_fail: "押す失敗:確定してリストへ",
          go_press_ok: "押す済:駅の設定へ進む",
          go_press_fail: "押す失敗:駅の設定へ進む",
          back_press_ok: "押す済:沿線の設定へ戻る",
          back_press_fail: "押す失敗:沿線の設定へ戻る",
          search_press_ok: "押す済:検索",
          switch_grasp: "切替把握",
          ward_scene: "地域場面",
          layout_scene: "間取り場面",
          station_scene: "駅場面",
          btn_understand_ledger: "理解台帳",
          open_area_press_ok: "押す済:所在地絞り込み＋",
          open_station_press_ok: "押す済:沿線・駅絞り込み＋",
          open_layout_press_ok: "押す済:間取り絞り込み＋",
          open_filter_press_ok: "押す済:絞り込み条件＋",
          learn_reflect_ok: "束の駅手順を反映",
          learn_reflect_gap: "束の駅遷移が空",
          learn_reflect_gate: "束取込ゲート",
          learn_warm: "学習束を温める",
          learn_station_flow_hit: "束の駅手順ヒット",
          learn_station_flow_gap: "束の駅手順ギャップ",
          page_ver: "ページ脚本の版",
          fill_begin: "自動入力開始",
          pet_panel_confirm: "ペット操作後に確定してリストへ",
          pet_clear: "ペット可を外す",
          pet_select: "ペット可を選ぶ",
          flow_understand_ledger: "流れ台帳",
          flow_done_switch: "完了済:切替",
          flow_done_place: "完了済:場所",
          flow_done_conditions: "完了済:条件",
          flow_done_search: "完了済:検索",
          flow_done_fill_done: "完了済:入力完了",
          flow_done_ready_next: "完了済:次客へ渡してよい",
          flow_gap_switch: "未完了:切替",
          flow_gap_place: "未完了:場所",
          flow_gap_conditions: "未完了:条件",
          flow_gap_search: "未完了:検索",
          flow_gap_fill_done: "未完了:入力完了",
          flow_gap_ready_next: "未完了:次客へ渡してよい",
          now_customer: "今の客",
          learn_flow_reflect_ok: "流れ反映OK",
          learn_flow_reflect_gap: "流れ反映不足",
          station_per_line_ok: "沿線ごと駅OK",
          station_per_line: "沿線ごと駅",
          station_per_line_done: "沿線ごと駅揃い",
          station_per_line_gap: "沿線ごと駅不足",
          line_station_map: "沿線↔駅地図",
          line_station_map_missing: "沿線↔駅地図なし",
          line_station_map_gap: "沿線↔駅地図不足",
          flow_map_ledger: "全流れ地図台帳",
          flow_subdivide_need: "細分化強化が要る",
          flow_subdivide_ok: "細分化待ちなし",
          clear_method_station: "駅の外し方",
          clear_method_ward: "所在地の外し方",
          clear_method_layout: "間取りの外し方",
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
          station_place_clear_begin: "駅・沿線を外す開始",
          station_clear_via_next: "外しのため駅の設定へ進む",
          station_clear_cursor: "駅を外す",
          line_clear_after_station: "沿線を外す",
          station_then_line_clear_force: "駅のあと沿線を外す",
          station_clear_back_line: "沿線の設定へ戻る",
          station_clear_blocked_no_line: "残駅あるが沿線未選択",
          station_intent_clear: "駅を外す",
          station_intent_select: "駅を選ぶ",
          line_intent_clear: "沿線を外す",
          line_intent_select: "沿線を選ぶ",
          station_done_select: "選ぶ済:station_id[]",
          station_done_clear: "外す済:station_id[]",
          line_done_select: "選ぶ済:route_id[]",
          line_done_clear: "外す済:route_id[]",
          ward_done_select: "選ぶ済:city_code[]",
          ward_done_clear: "外す済:city_code[]",
          town_done_select: "選ぶ済:town_code[]",
          town_done_clear: "外す済:town_code[]",
          layout_done_select: "選ぶ済:room_layout_id[]",
          layout_done_clear: "外す済:room_layout_id[]",
          pet_done_select: "選ぶ済:eq_rm[]",
          pet_done_clear: "外す済:eq_rm[]",
          confirm_press_ok: "押す済:確定してリストへ",
          confirm_press_fail: "押す失敗:確定してリストへ",
          go_press_ok: "押す済:駅の設定へ進む",
          go_press_fail: "押す失敗:駅の設定へ進む",
          back_press_ok: "押す済:沿線の設定へ戻る",
          back_press_fail: "押す失敗:沿線の設定へ戻る",
          search_press_ok: "押す済:検索",
          switch_grasp: "切替把握",
          ward_scene: "地域場面",
          layout_scene: "間取り場面",
          station_scene: "駅場面",
          btn_understand_ledger: "理解台帳",
          open_area_press_ok: "押す済:所在地絞り込み＋",
          open_station_press_ok: "押す済:沿線・駅絞り込み＋",
          open_layout_press_ok: "押す済:間取り絞り込み＋",
          open_filter_press_ok: "押す済:絞り込み条件＋",
          learn_reflect_ok: "束の駅手順を反映",
          learn_reflect_gap: "束の駅遷移が空",
          learn_reflect_gate: "束取込ゲート",
          learn_warm: "学習束を温める",
          learn_station_flow_hit: "束の駅手順ヒット",
          learn_station_flow_gap: "束の駅手順ギャップ",
          page_ver: "ページ脚本の版",
          fill_begin: "自動入力開始",
          pet_panel_confirm: "ペット操作後に確定してリストへ",
          pet_clear: "ペット可を外す",
          pet_select: "ペット可を選ぶ",
          flow_understand_ledger: "流れ台帳",
          flow_done_switch: "完了済:切替",
          flow_done_place: "完了済:場所",
          flow_done_conditions: "完了済:条件",
          flow_done_search: "完了済:検索",
          flow_done_fill_done: "完了済:入力完了",
          flow_done_ready_next: "完了済:次客へ渡してよい",
          flow_gap_switch: "未完了:切替",
          flow_gap_place: "未完了:場所",
          flow_gap_conditions: "未完了:条件",
          flow_gap_search: "未完了:検索",
          flow_gap_fill_done: "未完了:入力完了",
          flow_gap_ready_next: "未完了:次客へ渡してよい",
          now_customer: "今の客",
          learn_flow_reflect_ok: "流れ反映OK",
          learn_flow_reflect_gap: "流れ反映不足",
          station_per_line_ok: "沿線ごと駅OK",
          station_per_line: "沿線ごと駅",
          station_per_line_done: "沿線ごと駅揃い",
          station_per_line_gap: "沿線ごと駅不足",
          line_station_map: "沿線↔駅地図",
          line_station_map_missing: "沿線↔駅地図なし",
          line_station_map_gap: "沿線↔駅地図不足",
          flow_map_ledger: "全流れ地図台帳",
          flow_subdivide_need: "細分化強化が要る",
          flow_subdivide_ok: "細分化待ちなし",
          clear_method_station: "駅の外し方",
          clear_method_ward: "所在地の外し方",
          clear_method_layout: "間取りの外し方",
        };
        var _nm2 = _STEP_JA2[String(k)] || null;
        if (_nm2) {
          try { window.postMessage({ from: "axlx-rec-note-name", name: _nm2 }, "*"); } catch (_) {}
        }
      }
    } catch (_) {}
    if (!_audit) return;
    _audit.steps.push({ at: Date.now(), k: String(k).slice(0, 40), d: d == null ? null : String(d).slice(0, 120) });
    /**
     * ★ 2026-11-17 統括Pro「学習しても自動が強化されない」実測:
     *   旧は steps>60 で先頭から shift → fill_start / learn_reflect_* / learn_warm が消える。
     *   2.8.77 自動は aim無ばかり残り、反映関所の印が監査から消えて「連動していない」と誤認された。
     *   → 反映・学習連動の印は消さない。それ以外を間引く（上限100）。
     */
    var _PIN = /^(select_in_view|toggle_late_ok|ward_pace|fill_pause|fill_resume|motion_stats|learn_reflect_|learn_warm|learn_reflect_gate|learn_flow_reflect_|fill_start|fill_begin|btn_understand|switch_grasp|page_ver|flow_done_|flow_gap_|flow_understand|now_customer|flow_map_ledger|flow_subdivide_|flow_atom_|clear_method_|line_station_map|learn_refresh_res|learn_screen_late|learn_screen_kept|stale_pending_reset|station_line_wait|station_line_repress|station_line_stuck|station_clear_before_ward|station_clear_confirm_before_ward|station_name_absent|ward_clear_before_station|ward_clear_open_retry|ward_clear_hidden_left|station_go_stuck|open_field_retry|open_field_timeout|station_clear_retry|station_clear_open_retry|ward_clear_retry|press_hidden_scroll|aim_hit_fix|search_wait_view|leftover_|post_send_clear|playbook_|hidden_press|clear_stage|clear_retry_press|sel_one_press|search_cursor|search_armed|modal_confirm|confirm_press_ok|cursor_one|cursor_two|cursor_old)/;
    try {
      while (_audit.steps.length > 100) {
        var _dropAt = -1;
        for (var _di = 0; _di < _audit.steps.length; _di++) {
          var _dk = String((_audit.steps[_di] && _audit.steps[_di].k) || "");
          if (_PIN.test(_dk)) continue;
          _dropAt = _di;
          break;
        }
        if (_dropAt < 0) break;
        _audit.steps.splice(_dropAt, 1);
      }
    } catch (_) {
      if (_audit.steps.length > 100) _audit.steps.shift();
    }
    /**
     * ★ 2026-11-16 統括Pro「steps到達が完走率の主因」:
     *   fill-done 前に途中の段を content→background へ送る（止まっても none にしない）。
     *   5段ごと／8秒に1回（過剰送信しない）。
     * ★ 2026-11-17: 駅/沿線外し原子は**即送信**（測れる土台・F14/F23/F24）。
     */
    try {
      var _nSt = _audit.steps.length;
      var _nowP = Date.now();
      if (!_audit._progAt) _audit._progAt = 0;
      if (!_audit._progN) _audit._progN = 0;
      /**
       * ★ 2026-11-17 統括Pro「つなぐ部分が弱い／把握・完了・押した印が残らない」:
       *   旧: PIN印も5段or8秒待ち → fill中断で now_customer / learn_warm / flow_map が監査に届かない。
       *   → PIN・完了・押す済・外し原子は**即送信**。進捗は末尾40＋PIN印を必ず混ぜる。
       */
      var _pinFlush = _PIN.test(String(k));
      var _clearKey = /motion_stats|learn_refresh_res|learn_screen_late|stale_pending_reset|station_line_wait|station_line_repress|station_line_stuck|station_clear_before_ward|station_clear_confirm_before_ward|station_name_absent|ward_clear_before_station|ward_clear_open_retry|ward_clear_hidden_left|station_go_stuck|open_field_retry|open_field_timeout|station_place_clear_begin|station_clear_via_next|station_clear_cursor|line_clear_after_station|station_then_line_clear|station_clear_back|station_clear_blocked|station_intent_|line_intent_|_done_|_press_ok|switch_grasp|ward_scene|layout_scene|station_scene|btn_understand_ledger|learn_reflect_|learn_station_flow_|learn_flow_reflect_|fill_begin|learn_warm|learn_reflect_gate|page_ver|flow_done_|flow_gap_|flow_understand|now_customer|flow_map_ledger|flow_subdivide_|flow_atom_|clear_method_|line_station_map|station_per_line|station_select_ok|leftover_|post_send_clear|playbook_|hidden_press|clear_stage|cursor_one|cursor_two|cursor_old/.test(String(k));
      if (_pinFlush || _clearKey || _nSt - _audit._progN >= 5 || _nowP - _audit._progAt >= 8000) {
        _audit._progN = _nSt;
        _audit._progAt = _nowP;
        var _progSteps = _audit.steps.slice(-40);
        try {
          var _pinned = [];
          for (var _pi = 0; _pi < _audit.steps.length; _pi++) {
            var _psk = String((_audit.steps[_pi] && _audit.steps[_pi].k) || "");
            if (_PIN.test(_psk)) _pinned.push(_audit.steps[_pi]);
          }
          if (_pinned.length) {
            var _seenK = {};
            var _merged = [];
            for (var _mi = 0; _mi < _pinned.length; _mi++) {
              var _mk = String((_pinned[_mi] && _pinned[_mi].k) || "");
              if (_seenK[_mk]) continue;
              _seenK[_mk] = true;
              _merged.push(_pinned[_mi]);
            }
            for (var _mj = 0; _mj < _progSteps.length; _mj++) {
              var _mk2 = String((_progSteps[_mj] && _progSteps[_mj].k) || "");
              if (_seenK[_mk2]) continue;
              _seenK[_mk2] = true;
              _merged.push(_progSteps[_mj]);
            }
            _progSteps = _merged.slice(-50);
          }
        } catch (_) {}
        window.postMessage({
          from: "aixlinx-fill-progress",
          runId: _fillRunId || (_audit && _audit.local_run_id) || null,
          customerId: _fillCustomerId || null,
          steps: _progSteps,
        }, "*");
      }
    } catch (_) {}
  }
  function _emitFillProgressHeartbeat(tag) {
    try {
      if (!_audit || _doneNotified) return;
      var now = Date.now();
      if (!_audit._opsProgAt) _audit._opsProgAt = 0;
      if (now - _audit._opsProgAt < 2500) return;
      _audit._opsProgAt = now;
      window.postMessage({
        from: "aixlinx-fill-progress",
        runId: _fillRunId || (_audit.local_run_id) || null,
        customerId: _fillCustomerId || null,
        steps: _audit.steps ? _audit.steps.slice(-8) : [],
        opsCount: _audit.ops ? _audit.ops.length : 0,
        conditionsReady: !!_axConditionsReady,
        tag: tag || null,
      }, "*");
    } catch (_) {}
  }
  function _auditOp(label, planned, waited) {
    if (!_audit || !_audit.ops) return;
    var late = waited - planned;
    if (late > _audit.late_max) _audit.late_max = late;
    if (late > 1000) _audit.late_over_1s++;
    _audit.ops.push({ t: Date.now() - _fillStartedAt, k: String(label || '').slice(0, 40), p: planned, w: waited, by: 'auto' });
    if (_audit.ops.length > 80) _audit.ops.shift();
    _emitFillProgressHeartbeat(String(label || "").slice(0, 24));
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
      try { _ledgerSaveSoon("ward"); } catch (_) {}
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
      try { _ledgerSaveSoon("station"); } catch (_) {}
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
      try {
        var _wv = _walkMinVal();
        if (_wv) f.walk = _wv;
      } catch (_) {
        var wk = document.querySelector('input[name="required_time"]'); if (wk) f.walk = wk.value;
      }
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
    /**
     * ★ 2026-11-15 竹内さん「学んだ『押す位置』を自動モードが実際に使っているか未検証」:
     *   **学んだ位置を狙ったか（狙えなかった理由も）**を点検に載せる。
     *   ⚠ これで「学習が効いているか」を数字で確かめられる。
     */
    try { if (typeof _aimUsed !== "undefined" && _aimUsed.length) _audit.aim_used = _aimUsed.slice(-20); } catch (_) {}
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
  /**
   * ★ 2026-11-16 連続客ボトルネック:
   *   前客の fill が残ったまま次客の aixlinx-fill が来ると、旧は「重複」で return し
   *   **次客の fill-done が永久に出ない** → fill_timeout → 連続が詰まる。
   *   → 客が違う時は前客を superseded で閉じ、次客の入力を始める。
   */
  function _abortFillForNextCustomer(nextId) {
    var oldId = window._axFillRunningCustomerId || _fillCustomerId;
    /** ★ 2026-11-17: 世代を上げ、前客の遅延 force-clear が次客を壊さない印にする */
    try { window.__axlxFillGen = (Number(window.__axlxFillGen) || 0) + 1; } catch (_) {}
    try { clearClickQueue(); } catch (_) {}
    try {
      if (window.__axStallWatch) { clearInterval(window.__axStallWatch); window.__axStallWatch = null; }
      if (window.__axFastSearchWatch) { clearInterval(window.__axFastSearchWatch); window.__axFastSearchWatch = null; }
      if (_watchdogTimer) { clearTimeout(_watchdogTimer); _watchdogTimer = null; }
      if (window.__axSearchFallbackTimer) { clearTimeout(window.__axSearchFallbackTimer); window.__axSearchFallbackTimer = null; }
      window.__axDeferredBasicQueue = null;
    } catch (_) {}
    var keepId = _fillCustomerId;
    var keepDone = _doneNotified;
    try {
      _fillCustomerId = oldId || null;
      _doneNotified = false;
      window._axFillRunning = true; // notifyDone が false にする
      notifyDone("superseded-by-next-customer:" + String(nextId || "").slice(0, 8));
      try { if (_audit) _auditStepP("supersede", "次客へ切替のため前客fillを閉じる"); } catch (_) {}
    } catch (_) {
      window._axFillRunning = false;
      _doneNotified = false;
    }
    _fillCustomerId = keepId;
    // 次客の fill 用に完了印を戻す（上で true になっている）
    _doneNotified = false;
    window._axFillRunning = false;
    window._axFillRunningCustomerId = null;
    void keepDone;
  }

  function notifyDone(errMsg, gate) {
    window._axFillRunning = false; // 次回呼び出しのためにフラグをリセット
    try { window._axFillRunningCustomerId = null; } catch (_) {}
    if (_doneNotified) return;
    _doneNotified = true;
    if (_watchdogTimer) { clearTimeout(_watchdogTimer); _watchdogTimer = null; }
    /**
     * ★ 2026-11-17 F45: fill完了を「理解」して台帳に残す。
     *   エラー／門止めは fill_done 未完了。成功時だけ次客へ渡してよいかを測る。
     */
    try {
      if (errMsg || gate) {
        _noteFlowPhase("fill_done", false, gate ? ("gate:" + String(gate)) : String(errMsg || "").slice(0, 60));
        try { _noteNowCustomer("fill_done_gap", gate ? String(gate) : String(errMsg || "").slice(0, 40)); } catch (_) {}
      } else {
        _noteFlowPhase("fill_done", true, "fill-done送信");
        try { _noteNowCustomer("fill_done", "一連完了待ち"); } catch (_) {}
      }
      var _ready = _auditFlowUnderstandLedger(errMsg ? "fill_doneエラー" : (gate ? "fill_done門" : "fill_done成功"));
      try { _auditFullFlowMapLedger(errMsg ? "fill_doneエラー" : (gate ? "fill_done門" : "fill_done成功")); } catch (_) {}
      if (_ready) {
        try { _noteNowCustomer("ready_next", "次客へ渡してよい"); } catch (_) {}
      }
    } catch (_) {}
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
    // ★ 2026-11-18: 止めた理由の種類（human_takeover・busy_other_customer 等）。background が「次のお客さんへ進むか止めるか」を分ける
    if (gate && typeof gate === "string") msg.gateKind = gate;
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

  /**
   * ★ 2026-11-15 竹内さん「学習と自動モードの強化もお願い」→ **実測で判明**:
   *
   *   ⚠ `search_audits` が 60件中 **54件「途中で止まった（abandoned）」**になっていた。
   *     統括はこれを見て「完走率 8%」と言い、**検索が押せていないと判断**していた。
   *   ところが中身を見ると、止まった回も**最後まで操作が進んでいた**（最後の操作が `click:検索`・全49手）。
   *
   *   ⚠ 原因: 終わりの合図（`notifyDone`）は **拡張が自分で検索を押した時**（`clickSearch`）にしか
   *     呼ばれない。**通常モードでは人が検索を押す**ので通らず、合図が来ないまま `abandoned` になっていた。
   *     ＝ **止まっていないのに止まったと記録されていた**（統括の判断が狂う一番の原因）。
   *
   *   → **人が検索を押した事を検知して、合図を送る**（`startHumanSearchWatch`）。
   *     ⚠ 自動で入れる時（`fillRealpro`）は今まで通り `clickSearch` が送るので**二重にならない**
   *       （`_doneNotified` で1回だけ）。
   *     ⚠ 人の操作でも**点検の段（steps）**に「人が検索を押した」を残す（後で手本と比べられる）。
   */
  var _humanSearchWatch = null;
  function startHumanSearchWatch() {
    try {
      if (_humanSearchWatch) return;                      // すでに見張っている
      // ★ 2026-11-18 F18: page-script は MAIN world のため chrome.runtime が無くても動かせる（_storageLocalGet ブリッジ使用）
      /**
       * 見張る相手: 検索ボタン（`div.go_search`・`a.text` の「検索」・小窓の外にある物）。
       *   ⚠ 小窓の中の検索は押さない（所在地の確定と取り違える）。
       */
      var isSearchBtn = function (el) {
        try {
          if (!el || !el.closest) return false;
          if (el.closest('.this_window, [role="dialog"], .modal, .modal_wrap')) return false;   // 小窓の中は除く
          var t = String(el.textContent || "").replace(/\s+/g, "");
          if (el.matches && el.matches('div.go_search, div.go_search_submit')) return true;
          return /^(住居検索|検索|物件を検索する|条件で検索)$/.test(t);
        } catch (_) { return false; }
      };
      var onClick = function (e) {
        try {
          if (!e || !e.isTrusted) return;                 // 人の操作だけ（拡張の合成クリックは除く）
          if (!isSearchBtn(e.target)) return;
          /**
           * ⚠ 合図を送るには「誰の検索か」が要る（`_fillCustomerId`）。
           *   通常モード（人が操作）では自動入力の文脈が無いので、**拡張の「いまのお客様」**を借りる。
           *   それも無ければ**お客様を付けずに送る**（点検の段だけ残す・物件取得は走らせない）。
           */
          var cid = _fillCustomerId || null;
          if (!cid) {
            try {
              if (typeof _storageLocalGet === "function") {
                _storageLocalGet(["current_customer_id"], 600, true).then(function (r) {
                  var c = (r && r.current_customer_id) || null;
                  if (c) { _fillCustomerId = c; }
                  _sendHumanSearchDone(Date.now());
                }, function () { _sendHumanSearchDone(Date.now()); });
                return;
              }
            } catch (_) {}
          }
          _sendHumanSearchDone(Date.now());
        } catch (_) {}
      };
      /**
       * 人が検索を押した合図（`notifyDone` を1回だけ）。
       *   ⚠ 少し待ってから送る（サイトが結果を描くのを待つ。すぐ送ると「0件」に見える）。
       *   ⚠ **関数宣言**にする（`var` だと巻き上げで undefined になり、
       *     `onClick` から呼んだ時に**黙って何も起きない**・過去に踏んだ罠）。
       */
      function _sendHumanSearchDone(t0) {
        /**
         * ⚠ 待ちは**人の間隔**にする（固定の数字はテストで落ちる・実測で指摘された）。
         *   `AxlxHumanWait.logNormalDelay` を使う（無ければ 2.5秒）。
         */
        var _H = window.AxlxHumanWait;
        var _wait = (_H && _H.logNormalDelay) ? _H.logNormalDelay(2500, 0.35) : 2500;
        setTimeout(function () {
          try {
            if (_doneNotified) return;
            if (_audit) {
              try { _auditStepP('human_search', '人が検索を押した（' + Math.round((Date.now() - t0) / 1000) + '秒後に合図）'); } catch (_) {}
            } else {
              /**
               * ⚠ 通常モードは `_audit` が無い。それでも**段を1つ残す**ために最低限の器を作る
               *   （`notifyDone` が `_auditPack` を通る時に `pack_error` にならないように）。
               */
              try {
                _audit = {
                  v: 1, site: 'realpro', search_clicked: Date.now(), search_press: null, search_buttons: null,
                  sel_mismatch: [], form: null, stations_ok: [], stations_missing: [], lines_missing: [],
                  click_fails: [], reset_fail: null, area_path: null, fallback: null,
                  steps: [{ at: t0, k: "human_search", d: "人が検索を押した" }], ops: [],
                  late_max: 0, late_over_1s: 0, stall: null,
                  local_run_id: 'human_' + t0.toString(36), no_run_id: true,
                };
              } catch (_) {}
            }
            notifyDone();
          } catch (_) {}
        }, Math.max(600, Math.round(_wait)));
      }
      document.addEventListener("click", onClick, true);
      _humanSearchWatch = onClick;
      console.log("[AX] 人の検索を見張ります（通常モードでも点検に残す）");
    } catch (_) {}
  }
  /**
   * ⚠ 2026-11-15: **起動時に呼ぶ**（これを忘れると見張りが付かない）。
   */
  try { startHumanSearchWatch(); } catch (_) {}


  // 非ブロッキング警告表示（alert() はモーダルブロッキングで無人運転時に
  // fill-done の配送まで止めてしまうため使用禁止）
  function showWarnToast(msg) {
    try {
      console.log('[AX] ' + msg);
      var t = document.createElement('div');
      t.textContent = '⚠️ ' + msg;
      /**
       * ★ 2026-11-17 平田さん自動: アナウンス／警告が出ると「確定してリストへ」前で止まったように見える。
       *   → トーストは**クリックを奪わない**（pointer-events:none）。自動は止めない。
       */
      t.style.cssText = 'position:fixed;top:16px;right:16px;z-index:2147483646;pointer-events:none;' +
        'background:#c0392b;color:#fff;padding:12px 16px;border-radius:8px;' +
        'font-size:13px;max-width:340px;box-shadow:0 4px 12px rgba(0,0,0,.3);white-space:pre-wrap;';
      document.body.appendChild(t);
      setTimeout(function() { if (t.parentNode) t.parentNode.removeChild(t); }, 15000);
    } catch (e) { /* 表示失敗は無視 */ }
  }

  /**
   * ★ 2026-11-17 竹内さん「その場その場より根本の仕組みを強化・構築」:
   *   通常正本は常に「パネルを開く → 操作 → 確定してリストへ」。
   *   旧はペット／区／クリア／STEP6 に場当たりで確定を足していた → また抜けた。
   *   → **開いたら負債（_axPanelDebt）／確定で清算** の単一仕組みにする。
   *     ensureFieldVisible で開いた瞬間に負債。検索・条件投入前に未清算なら止めて清算。
   */
  var _axPanelDebt = null; // { kind, why, openedAt } | null
  function _panelKindOf(name, openerEl) {
    var nm = String(name || "");
    var tx = "";
    try { tx = String((openerEl && openerEl.textContent) || "").replace(/\s+/g, ""); } catch (_) { tx = ""; }
    var blob = nm + " " + tx;
    if (/所在地|city_code|town_code|one_city/.test(blob)) return "area";
    if (/沿線|駅|station|route_id|one_line|one_station/.test(blob)) return "station";
    if (/絞り込み条件|eq_rm|間取|room_layout|設備/.test(blob)) return "filter";
    return "panel";
  }
  function _markPanelOpened(kind, why) {
    _axPanelDebt = {
      kind: String(kind || "panel"),
      why: String(why || "").slice(0, 80),
      openedAt: Date.now(),
    };
    try {
      if (_audit) _auditStepP("panel_debt_open", _axPanelDebt.kind + " / " + _axPanelDebt.why);
      console.log("[AX] パネル負債+: " + _axPanelDebt.kind + " (" + _axPanelDebt.why + ")");
    } catch (_) {}
  }
  function _clearPanelDebt(why) {
    if (!_axPanelDebt) return;
    try {
      if (_audit) _auditStepP("panel_debt_clear", (_axPanelDebt.kind || "") + " / " + String(why || "").slice(0, 60));
    } catch (_) {}
    _axPanelDebt = null;
  }
  /** 未清算のパネルがあれば確定してリストへ。無い／既に閉じていれば false。 */
  function _settlePanelDebt(why) {
    if (!_axPanelDebt) return false;
    var debt = _axPanelDebt;
    var confLeft = null;
    try { confLeft = _findByText(["確定してリストへ", "この条件で絞り込む"]); } catch (_) { confLeft = null; }
    if (!confLeft) {
      // ボタンが無い＝もう閉じている → 負債だけ消す（二重押ししない）
      _clearPanelDebt("already_closed:" + (why || ""));
      return false;
    }
    var ok = _pressConfirmListLikeHuman(why || ("panel_settle:" + debt.kind + "/" + debt.why));
    try {
      if (_audit) _auditStepP(ok ? "panel_settle_ok" : "panel_settle_miss", debt.kind + " / " + String(why || "").slice(0, 40));
    } catch (_) {}
    return ok;
  }
  /**
   * キュー空まで待ってから清算 → 次へ（検索・条件の前に必ず通す）。
   * ★ 2026-11-17 実愛さん: 清算待ちが終わらず賃料・徒歩まで届かない抜け。
   * ★ 2026-11-18 平田・タイムアウト多発: キューが動いているのに固定12秒で捨てていた。
   *   竹内さん「完成度高ければタイムアウト不要／1人は物件送るまで」→ 進捗中はスライス延長、上限120秒。
   */
  function _settlePanelDebtThen(why, nextFn) {
    var finished = false;
    var finish = function () {
      if (finished) return;
      finished = true;
      try { if (typeof nextFn === "function") nextFn(); } catch (_) {}
    };
    var settleStart = Date.now();
    var PANEL_SETTLE_SLICE_MS = 12000;
    // ★ 2026-11-18 竹内さん「進捗中は切らない」: キューが動いている間は上限10分（旧120秒）。キューが空なら即清算して進む（待たない）
    var PANEL_SETTLE_CAP_MS = 900000; // ★ 2026-11-18: 10分→15分（キュー動作中の短切り上げ禁止）
    var killer = null;
    var armKiller = function () {
      if (killer) clearTimeout(killer);
      var elapsed = Date.now() - settleStart;
      if (elapsed >= PANEL_SETTLE_CAP_MS) {
        try {
          if (_audit) _auditStepP("panel_settle_timeout", String(why || "").slice(0, 60) + " cap=" + PANEL_SETTLE_CAP_MS);
          console.warn("[AX] パネル清算タイムアウト（上限）→ 条件へ進む", why);
        } catch (_) {}
        try { _axPanelDebt = null; } catch (_) {}
        finish();
        return;
      }
      var slice = Math.min(PANEL_SETTLE_SLICE_MS, PANEL_SETTLE_CAP_MS - elapsed);
      killer = setTimeout(function () {
        try {
          if (isClickQueueBusy && Date.now() - settleStart < PANEL_SETTLE_CAP_MS) {
            armKiller();
            return;
          }
        } catch (_) {}
        try {
          if (_audit) _auditStepP("panel_settle_timeout", String(why || "").slice(0, 60));
          console.warn("[AX] パネル清算タイムアウト → 条件へ進む", why);
        } catch (_) {}
        try { _axPanelDebt = null; } catch (_) {}
        finish();
      }, slice);
    };
    armKiller();
    whenClickQueueIdle(function () {
      try { _settlePanelDebt(why); } catch (_) {}
      whenClickQueueIdle(function () {
        if (killer) clearTimeout(killer);
        finish();
      });
    });
  }
  /**
   * ★ 2026-11-17 実愛さん: 地域で止まっても賃料・徒歩など新条件は1つずつ入れる。
   *   旧は ward_verify_fail で即 notifyDone → クリア済みのまま基本条件未投入＝画面が前客のまま／空のまま。
   *   → 基本条件を入れてから中止（検索は押さない＝誤地域の全件を出さない）。
   */
  function _basicsThenAbort(errMsg, why) {
    try { showWarnToast(String(errMsg || "").slice(0, 120)); } catch (_) {}
    _settlePanelDebtThen("abort前清算:" + String(why || ""), function () {
      var q = null;
      try { q = window.__axDeferredBasicQueue; window.__axDeferredBasicQueue = null; } catch (_) { q = null; }
      function afterBasics() {
        try { _markConditionsReady("abort_after_basic"); } catch (_) {}
        try { if (_audit) _auditStepP("basic_then_abort", String(why || errMsg || "").slice(0, 80)); } catch (_) {}
        notifyDone(errMsg);
      }
      if (q && q.length) {
        try { if (_audit) _auditStepP("basic_before_abort", q.length + "件"); } catch (_) {}
        _runBasicOneByOne(q, afterBasics);
        return;
      }
      afterBasics();
    });
  }

  /**
   * ★ 2026-11-17 平田さん自動＋通常正本: 「確定してリストへ」は地域／駅／絞り込み条件の必押。
   *   ペット外し後も同じボタン。見つからない・×だけ押す抜けを止める。
   *   → 成功したらパネル負債も清算（根元仕組みと一体）。
   */
  function _pressConfirmListLikeHuman(why) {
    var labels = ["確定してリストへ", "この条件で絞り込む", "決定"];
    var conf = null;
    try { conf = _findByText(labels); } catch (_) { conf = null; }
    if (!conf) {
      try {
        var els = Array.prototype.slice.call(document.querySelectorAll("a,button,div,span,li,p,label"));
        for (var i = 0; i < els.length && !conf; i++) {
          var el = els[i];
          if (!isVisible(el)) continue;
          var tx = String(el.textContent || "").replace(/\s+/g, "");
          if (!tx || tx.length > 40) continue;
          if (/確定してリストへ|この条件で絞り込む/.test(tx)) conf = el;
        }
      } catch (_) {}
    }
    if (!conf) return false;
    try {
      if (_audit) _auditStepP("modal_confirm", why || "確定してリストへ");
    } catch (_) {}
    /**
     * ★ 2026-11-17 平田さん: 確定は最重要。通常録画 n=332 の画面位置を必ず狙う。
     *   keys/label で aim を引き、無ければ _screenAimOf。
     */
    var _confAim = null;
    try {
      _confAim = _screenAimOf("確定してリストへ")
        || _aimOf("確定してリストへ")
        || _aimByEl(conf, ["確定してリストへ", "この条件で絞り込む"]);
    } catch (_) { _confAim = null; }
    var _confBefore = null;
    try {
      var _scrB = _graspStationModalScreen();
      _confBefore = { formLn: _scrB.formLn, formSt: _scrB.formSt, kind: _scrB.kind };
    } catch (_) { _confBefore = null; }
    // ★ 2.8.136 実測 run_mwofi2sn_jbec: 確定の前に 14.45秒・6.92秒・4.89秒止まっていた（span＝「その他」の長い迷い＋手を止める）。
    //   選び終えて確定するのは決定の押下 → 長い迷い・停止を入れない（decide）。
    var _confOpts = Object.assign({}, _uiGapOpts() || {}, {
      label: "確定してリストへ",
      keys: ["確定してリストへ", "この条件で絞り込む", "modal_confirm"],
      aim: _confAim || undefined,
      decide: true,
    });
    enqueueHumanClick(conf, function (el) {
      try {
        // ★ 通常録画と同じく shot_ops に「確定してリストへ」を残す（自動80件で CONFIRM=0 だった抜け）
        if (typeof window.__axlxRecNoteOp === "function") window.__axlxRecNoteOp("click", el);
        try {
          window.postMessage({ source: "axlx-page", type: "AXLX_REC_NOTE", ev: "click", label: "確定してリストへ" }, "*");
        } catch (_) {}
        if (typeof simulateClick === "function") simulateClick(el);
        else el.click();
        // ★ 押した理解: 確定が効いたか（モーダル閉鎖／form変化）
        try {
          setTimeout(function () {
            try { _verifyPressUnderstood("confirm", _confBefore); } catch (_) {}
          }, 400);
        } catch (_) {}
      } catch (_) {
        try { el.click(); } catch (__) {}
      }
    }, _uiGapMin(), _uiGapMax(), null, _confOpts);
    _clearPanelDebt(why || "confirm");
    return true;
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
    _pressBusyAt = Date.now();
    var _done = function () { _pressBusy = Math.max(0, _pressBusy - 1); };
    var press = function () {
      try { el.dispatchEvent(new MouseEvent('mousedown', {bubbles:true, cancelable:true, view:window})); } catch (_) {}
      setTimeout(function() {
        try {
          el.dispatchEvent(new MouseEvent('mouseup',   {bubbles:true, cancelable:true, view:window}));
          el.dispatchEvent(new MouseEvent('click',     {bubbles:true, cancelable:true, view:window}));
        } catch (_) {}
        if (_axPressing === el) _axPressing = null;
        _done();
      }, humanRand(40, 90, { allowShort: true }));
    };
    if (_axFireDepth > 0) {
      // カーソルが着いて押し込み済み: 同じ要素なら click だけ・別の要素（label↔input）なら動かさずに押す
      if (_axFireEl === el) {
        try { el.dispatchEvent(new MouseEvent('click', {bubbles:true, cancelable:true, view:window})); } catch (_) {}
        _done();
      } else {
        press();
      }
      return;
    }
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

  /**
   * ★ 2026-11-16 細分化土台: checkbox → 人が押す label（for= / closest）。
   *   間取り・所在地・沿線・駅で共通。input 直押しは外し損ねの原子。
   * ★ 駅は label.one_station／沿線は label.one_line を最優先（録画と同じ）。
   */
  function _labelForCheckbox(cb) {
    if (!cb) return null;
    try {
      var nm = String(cb.name || "");
      if (/station_id/.test(nm)) {
        var st = (cb.closest && cb.closest("label.one_station")) || null;
        if (st) return st;
      }
      if (/route_id/.test(nm)) {
        var ln = (cb.closest && cb.closest("label.one_line")) || null;
        if (ln) return ln;
      }
      if (/city_code|town_code/.test(nm)) {
        var cy = (cb.closest && cb.closest("label.one_city, label.one_town")) || null;
        if (cy) return cy;
      }
    } catch (_) {}
    try {
      if (cb.id) {
        var lb = document.querySelector('label[for="' + String(cb.id).replace(/"/g, "") + '"]');
        if (lb) return lb;
      }
    } catch (_) {}
    try { if (cb.closest) { var c = cb.closest("label"); if (c) return c; } } catch (_) {}
    try { if (cb.parentElement && String(cb.parentElement.tagName || "").toUpperCase() === "LABEL") return cb.parentElement; } catch (_) {}
    return null;
  }
  /** 外す／選ぶ: label を狙い（checked=false 直書き禁止）＋aimでカーソル */
  /** カーソルが el の上にある時だけ押す動き（tap）を見せる（押し直しの見た目・離れていたら何もしない） */
  function _tapIfCursorOn(el) {
    try {
      var P = window.AxlxPointerUi;
      if (!el || !P || !P.position || !P.tap || !el.getBoundingClientRect) return false;
      var cp = P.position(), r = el.getBoundingClientRect();
      if (!cp || !(r.width > 0)) return false;
      if (cp.x < r.left - 2 || cp.x > r.right + 2 || cp.y < r.top - 2 || cp.y > r.bottom + 2) return false;
      P.tap();
      return true;
    } catch (_) { return false; }
  }
  function _toggleCheckboxLikeHuman(cb, wantOn, minGap, maxGap, flags) {
    if (!cb) return;
    var hit = _labelForCheckbox(cb) || cb;
    var nm = String(cb.name || "");
    var keys = [nm];
    if (/station/.test(nm)) keys.push("station_id[]", "one_station");
    if (/route/.test(nm)) keys.push("route_id[]", "one_line");
    if (/city_code/.test(nm)) keys.push("city_code[]", "one_city");
    if (/town_code/.test(nm)) keys.push("town_code[]", "one_town");
    if (/room_layout/.test(nm)) keys.push("room_layout_id[]");
    if (/pet/i.test(nm) || /ペット/.test(String(hit && hit.textContent || ""))) keys.push("pet");
    var _domain = _intentDomainOfName(nm, hit);
    // ★ 2026-11-17: 固定 420/980 ではなく駅外しと同じ人間レンジ（未指定時）
    var _g = (typeof _clearToggleGapRange === "function")
      ? _clearToggleGapRange()
      : { lo: 950, hi: 1600 };
    var lo = (minGap != null && isFinite(Number(minGap))) ? Number(minGap) : _g.lo;
    var hi = (maxGap != null && isFinite(Number(maxGap))) ? Number(maxGap) : _g.hi;
    if (lo < 900) lo = 900;
    if (hi <= lo) hi = lo + 400;
    // ★ 2026-11-17 aim強化: keys を渡して押した位置の学びを引く（route/station/city）
    enqueueHumanClick(hit, function () {
      try {
        if (!cb || !cb.isConnected) return;
        // ★ 2026-11-18 細部徹底: クリック実行直前に要素を視野へ入れ、連続選択時の画面外漏れを防ぐ
        try { if (typeof _scrollIntoViewSoft === "function") _scrollIntoViewSoft(hit); } catch (_) {}
        if (cb.checked === !!wantOn) {
          // 既に望む状態＝「選ぶ/外す」は理解済み（二重押ししない）
          _noteIntentUnderstood(_domain, wantOn ? "select" : "clear", true, "already");
          return;
        }
        // ★ 押す前に was を同期腕上げ（MAIN→isolated）
        var _wasBefore = null;
        try { _wasBefore = !!cb.checked; } catch (_) { _wasBefore = null; }
        try { _armWasForLearn(cb); } catch (_) {}
        try { _noteClickForLearn(cb, _wasBefore); } catch (_) {}
        // ★ 意図（外す/選ぶ）を domain 付きで残す（駅・沿線・区・町・ペット・間取り）
        try {
          var _intent = wantOn ? "select" : "clear";
          if (_audit) _auditStepP(_domain + "_intent_" + _intent, String(cb.value || nm || "").slice(0, 24));
          window.postMessage({ from: "axlx-rec-note-name", name: (_intent === "clear" ? "外す:" : "選ぶ:") + _domain + ":" + String(nm || "").slice(0, 16) }, "*");
          if (!wantOn && typeof _noteClearMethod === "function") {
            _noteClearMethod(_domain, "cursor_checkbox", String(cb.value || nm || "").slice(0, 30));
          }
        } catch (_) {}
        if (hit && hit !== cb && hit.isConnected) { try { hit.click(); } catch (_) {} }
        // 沿線の「前客の残り」と「この客で自分が押した物」を分けて数える（#1513 で取り違えた）
        try {
          if (wantOn && /route_id/.test(nm)) {
            if (!window.__axlxLinePickedRun) window.__axlxLinePickedRun = {};
            window.__axlxLinePickedRun[String(cb.value || "")] = 1;
          }
        } catch (_) {}
        /**
         * ★ 2026-11-18 竹内さん「今回天王寺区を押して外して一瞬止まってしまった」:
         *   録画（audit #1498）: 天王寺区が label→name→label→name→label→city_code[] と3回切り替わり、
         *   その後に未選択へ戻っていた（押して外れた）。
         *   原因の見立て: 押した直後に checked を**すぐ**読んで「まだ選ばれていない」と判断し、
         *   サイト側の反映が遅れているだけなのに 2回目・3回目を重ねて**元に戻していた**。
         *   → 押した後は反映を最大 ~240ms 待ってから判断し、本当に変わっていない時だけ次の手を打つ（1手ずつ待つ）。
         */
        var _settleChk = function (ms) {
          return new Promise(function (resolve) {
            var t0 = Date.now();
            (function poll() {
              var ok = false;
              try { ok = (cb.checked === !!wantOn); } catch (_) { ok = false; }
              if (ok || Date.now() - t0 >= ms) { resolve(ok); return; }
              setTimeout(poll, 40);
            })();
          });
        };
        var _t0Toggle = Date.now();
        /**
         * ★ 2.8.136: 1回目の反映待ちを 240→600ms（合えばすぐ進むので速い時は同じ）。
         *   実測 run_mwofi2sn_jbec: 同じ区・間取りを0.1秒以内に重ねて押した記録（遅い反映に2回目を重ねていた）。
         *   押し直す時はカーソルが欄の上なら押す動きを見せる。
         */
        return _settleChk(600).then(function (ok1) {
          if (ok1) {
            try { if (Date.now() - _t0Toggle > 60 && _audit) _auditStepP("toggle_late_ok", _domain + " 反映待ち" + (Date.now() - _t0Toggle) + "ms（重ね押ししない）"); } catch (_) {}
            return true;
          }
          // 直書き禁止: まだ合わなければ input.click をもう1回だけ
          try { _tapIfCursorOn(hit); } catch (_) {}
          try { cb.click(); } catch (_) {}
          // ★ 2026-11-20: 2回目の後は長めに待つ（遅れて反映するサイトで3回目を重ねて元に戻さない）
          return _settleChk(420);
        }).then(function (ok2) {
          if (ok2) return true;
          /**
           * ★ 2026-11-17 DB toggleFail station=9 line=4:
           *   native click で状態が変わらない時は simulateClick（リアプロ jQuery）を1回。
           */
          if (typeof simulateClick === "function") {
            try { _tapIfCursorOn(hit); } catch (_) {}
            try { simulateClick(hit && hit.isConnected ? hit : cb); } catch (_) {}
            return _settleChk(480);
          }
          return false;
        }).then(function () {
          /**
           * ★ 土台: 効いたか検証（押したつもりで終わらせない）
           * ★ 2026-11-20: ここでは見るだけ（押さない）。旧は4回目を押してすぐ読み、遅れて反映する所で元に戻していた
           */
          try { _verifyCheckboxUnderstood(cb, wantOn, _domain, true); } catch (_) {}
          return true;
        }, function () { return true; });
      } catch (_) {}
    }, lo, hi, null, { keys: keys, label: nm || "toggle", sigma: 0.55, quick: !!(flags && flags.quick) });
  }
  /** 可視の駅／沿線ラベル数・チェック済み数 */
  function _visStationLabels() {
    return Array.prototype.slice.call(document.querySelectorAll("label.one_station")).filter(isVisible);
  }
  function _visLineLabels() {
    return Array.prototype.slice.call(document.querySelectorAll("label.one_line")).filter(isVisible);
  }
  function _countCheckedVisible(labels) {
    var n = 0;
    (labels || []).forEach(function (lb) {
      var cb = lb.querySelector && lb.querySelector('input[type="checkbox"]');
      if (!cb && lb.htmlFor) { try { cb = document.getElementById(lb.htmlFor); } catch (_) { cb = null; } }
      if (cb && cb.checked) n++;
    });
    return n;
  }
  /**
   * ★ 2026-11-17 竹内さん「押した／外した／選んだの理解の抜けは駅以外にも」:
   *   土台: どの欄か（domain）・意図（select/clear/press）・結果（ok/fail）を1か所で残す。
   *   沿線押し≠駅選択、外す≠選ぶ、押したつもり≠効いた、を全UIで同じ型にする。
   *   domain: line|station|ward|town|pet|layout|confirm|search|go|back|other
   */
  function _intentDomainOfName(nm, el) {
    var s = String(nm || "");
    var cls = "";
    try { cls = String((el && el.className) || ""); } catch (_) { cls = ""; }
    var tx = "";
    try { tx = String((el && el.textContent) || "").replace(/\s+/g, "").slice(0, 24); } catch (_) { tx = ""; }
    if (/station_id|one_station/.test(s + cls) || /駅/.test(tx) && /one_station/.test(cls)) return "station";
    if (/route_id|one_line/.test(s + cls)) return "line";
    if (/city_code|one_city|所在地/.test(s + cls + tx)) return "ward";
    if (/town_code|one_town/.test(s + cls)) return "town";
    if (/pet|ペット|eq_rm/.test(s + cls + tx)) return "pet";
    if (/room_layout|間取/.test(s + cls + tx)) return "layout";
    if (/確定してリスト|この条件で絞り込む/.test(tx)) return "confirm";
    if (/検索|go_search/.test(s + cls + tx)) return "search";
    if (/駅の設定へ進む/.test(tx)) return "go";
    if (/沿線の設定へ戻る|沿線を選び直す/.test(tx)) return "back";
    if (/所在地絞り込み/.test(tx)) return "open_area";
    if (/沿線・駅絞り込み|沿線駅絞り込み/.test(tx)) return "open_station";
    if (/間取り絞り込み/.test(tx)) return "open_layout";
    if (/絞り込み条件/.test(tx)) return "open_filter";
    return "other";
  }
  /** domain → リアプロボタン台帳の正名（1つずつ理解の測り方） */
  function _buttonIdOfDomain(domain) {
    var d = String(domain || "");
    if (d === "station") return "station_id[]";
    if (d === "line") return "route_id[]";
    if (d === "ward") return "city_code[]";
    if (d === "town") return "town_code[]";
    if (d === "layout") return "room_layout_id[]";
    if (d === "pet") return "eq_rm[]";
    if (d === "confirm") return "確定してリストへ";
    if (d === "go") return "駅の設定へ進む";
    if (d === "back") return "沿線の設定へ戻る";
    if (d === "search") return "検索";
    if (d === "open_area") return "所在地絞り込み＋";
    if (d === "open_station") return "沿線・駅絞り込み＋";
    if (d === "open_layout") return "間取り絞り込み＋";
    if (d === "open_filter") return "絞り込み条件＋";
    return d || "other";
  }
  /** 意図→結果の理解を監査＋録画に残す（抜けの測り方を統一・ボタン台帳正名付き） */
  function _noteIntentUnderstood(domain, intent, ok, detail) {
    try {
      var k = String(domain || "other") + "_" + (ok ? "done_" : "fail_") + String(intent || "press");
      // 互換: station_done_select / line_done_clear 等
      if (ok && (intent === "select" || intent === "clear")) {
        k = String(domain || "other") + "_done_" + intent;
      } else if (!ok && (intent === "select" || intent === "clear")) {
        k = "toggle_fail";
      } else if (ok && intent === "press") {
        k = String(domain || "other") + "_press_ok";
      } else if (!ok && intent === "press") {
        k = String(domain || "other") + "_press_fail";
      }
      if (_audit) _auditStepP(k, String(detail || "").slice(0, 80));
      var btnId = _buttonIdOfDomain(domain);
      try {
        if (!window.__axlxBtnUnderstood) window.__axlxBtnUnderstood = {};
        window.__axlxBtnUnderstood[btnId + ":" + String(intent || "press")] = !!ok;
      } catch (_) {}
      try {
        var label =
          (intent === "clear" ? "外す済:" : intent === "select" ? "選ぶ済:" : ok ? "押す済:" : "押す失敗:") +
          String(btnId || domain || "") +
          (detail ? ":" + String(detail).slice(0, 16) : "");
        window.postMessage({ from: "axlx-rec-note-name", name: label.slice(0, 40) }, "*");
      } catch (_) {}
    } catch (_) {}
  }
  /**
   * チェック欄: 押したあと want と now が一致したか。一致しなければ1回だけリトライして理解を確定。
   * @returns {boolean} 理解できた（効いた）
   */
  function _verifyCheckboxUnderstood(cb, wantOn, domain, lookOnly) {
    if (!cb) return false;
    var now = false;
    try { now = !!cb.checked; } catch (_) { return false; }
    if (now === !!wantOn) {
      _noteIntentUnderstood(domain || _intentDomainOfName(cb.name, cb), wantOn ? "select" : "clear", true, String(cb.value || cb.name || "").slice(0, 24));
      return true;
    }
    if (lookOnly) {
      _noteIntentUnderstood(domain || _intentDomainOfName(cb.name, cb), wantOn ? "select" : "clear", false, "3手後も now=" + now + " want=" + wantOn + "（押し足さない）");
      return false;
    }
    // もう1回だけ（理解できていない＝効いていない）
    try {
      var hit = _labelForCheckbox(cb) || cb;
      if (typeof simulateClick === "function") simulateClick(hit);
      else if (hit && hit.click) hit.click();
      else cb.click();
    } catch (_) {}
    try { now = !!cb.checked; } catch (_) { now = false; }
    var ok = now === !!wantOn;
    _noteIntentUnderstood(domain || _intentDomainOfName(cb.name, cb), wantOn ? "select" : "clear", ok, "retry now=" + now + " want=" + wantOn);
    return ok;
  }
  /**
   * ボタン押しの理解: 押す前の印 → 押す → 期待する変化があったか。
   * kind: confirm（モーダル閉じ／form変化）| go（station_listへ）| back（line_listへ）| search（検索開始）
   */
  function _verifyPressUnderstood(kind, before) {
    var ok = false;
    var detail = "";
    try {
      if (kind === "confirm") {
        var scr = _graspStationModalScreen();
        var area = typeof _graspAreaModalScreen === "function" ? _graspAreaModalScreen() : null;
        ok = (scr && scr.kind === "closed") || (area && area.kind === "closed") ||
          (before && before.formLn != null && scr.formLn !== before.formLn) ||
          (before && before.formSt != null && scr.formSt !== before.formSt);
        // パネルが残っていても確定文言が消えていればOK寄り
        if (!ok) {
          var still = false;
          try { still = !!_findByText(["確定してリストへ", "この条件で絞り込む"]); } catch (_) { still = false; }
          ok = !still;
        }
        detail = "scr=" + (scr && scr.kind) + " formLn=" + (scr && scr.formLn) + " formSt=" + (scr && scr.formSt);
      } else if (kind === "go") {
        var scrG = _graspStationModalScreen();
        ok = scrG.kind === "station_list" || scrG.stVis > 0;
        detail = "scr=" + scrG.kind + " stVis=" + scrG.stVis;
      } else if (kind === "back") {
        var scrB = _graspStationModalScreen();
        ok = scrB.kind === "line_list" || scrB.lineVis > 0;
        detail = "scr=" + scrB.kind;
      } else if (kind === "search") {
        ok = true; // 検索は clickSearch 側の監査で追う（ここでは押下キュー投入の理解）
        detail = "queued";
      }
    } catch (_) { ok = false; }
    _noteIntentUnderstood(kind === "go" || kind === "back" ? kind : kind, "press", ok, detail);
    return ok;
  }
  /**
   * ★ 2026-11-17 竹内さん「地域や間取りも把握／前客→新客／外したと押したを理解／統括Pro細かく」:
   *   駅場面と同じ型で、区・間取り・客切替も「今の残・want・次の段」を1つに決める。
   *   外した≠押した。前客の残を残したまま新客に入らない。
   */
  function _countCheckedWards() {
    try { return document.querySelectorAll('input[name="city_code[]"]:checked').length; } catch (_) { return 0; }
  }
  function _countCheckedTowns() {
    try { return document.querySelectorAll('input[name="town_code[]"]:checked').length; } catch (_) { return 0; }
  }
  function _countCheckedLayouts() {
    try { return document.querySelectorAll('input[name="room_layout_id[]"]:checked').length; } catch (_) { return 0; }
  }
  /** 前客→新客の切替把握（残チェック＋forceClear旗を測れる印にする） */
  function _understandCustomerSwitch(prevId, nextId, cond) {
    var prev = prevId != null ? String(prevId) : "";
    var next = nextId != null ? String(nextId) : "";
    var switched = !!(prev && next && prev !== next);
    var first = !prev && !!next;
    var same = !!(prev && next && prev === next);
    var wardN = _countCheckedWards();
    var townN = _countCheckedTowns();
    var stN = 0, lnN = 0, layN = 0;
    try { stN = _countCheckedStations(); } catch (_) { stN = 0; }
    try { lnN = _countCheckedRoutes(); } catch (_) { lnN = 0; }
    layN = _countCheckedLayouts();
    var force = false;
    try { force = !!_shouldForceClearPrevPlace(); } catch (_) { force = false; }
    var residual = wardN + townN + stN + lnN + layN;
    var phase = "ok_clean";
    if (switched && residual > 0) phase = "need_clear_prev";
    else if (switched && residual === 0) phase = "switched_clean";
    else if (first) phase = "first_customer";
    else if (same && residual > 0) phase = "same_customer_residual";
    else if (same) phase = "same_customer";
    var wantWard = (cond && cond.city_codes && cond.city_codes.length) ? cond.city_codes.length : 0;
    var wantSt = (cond && cond.station_names && cond.station_names.length) ? cond.station_names.length : 0;
    var wantLay = 0;
    try {
      if (cond && cond.floor_plan) wantLay = 1;
      if (_axExpect && _axExpect.layoutVals && _axExpect.layoutVals.length) wantLay = _axExpect.layoutVals.length;
    } catch (_) {}
    try {
      var sig = phase + "|" + prev.slice(0, 8) + ">" + next.slice(0, 8) + "|r" + residual + "|f" + (force ? 1 : 0);
      if (window.__axlxSwitchSceneSig !== sig) {
        window.__axlxSwitchSceneSig = sig;
        if (_audit) {
          _auditStepP(
            "switch_grasp",
            phase +
              " prev=" + (prev ? prev.slice(0, 8) : "-") +
              " next=" + (next ? next.slice(0, 8) : "-") +
              " 残:区" + wardN + "町" + townN + "駅" + stN + "沿線" + lnN + "間取" + layN +
              " forceClear=" + (force ? "Y" : "N") +
              " want:区" + wantWard + "駅" + wantSt + "間取" + wantLay,
          );
        }
        try {
          window.postMessage({
            from: "axlx-rec-note-name",
            name: ("切替把握:" + phase).slice(0, 40),
          }, "*");
        } catch (_) {}
      }
    } catch (_) {}
    try {
      _noteFlowPhase(
        "switch",
        true,
        phase + " prev=" + (prev ? prev.slice(0, 8) : "-") + " next=" + (next ? next.slice(0, 8) : "-"),
      );
    } catch (_) {}
    return {
      phase: phase,
      switched: switched,
      residual: residual,
      wardN: wardN,
      townN: townN,
      stN: stN,
      lnN: lnN,
      layN: layN,
      force: force,
    };
  }
  /** 地域（区・町）場面: 余分の外し／wantの選択／確定の段 */
  function _understandWardScene(cond) {
    var scr = typeof _graspAreaModalScreen === "function" ? _graspAreaModalScreen() : { kind: "unknown" };
    var wantCodes = [];
    try {
      if (cond && cond.city_codes && cond.city_codes.length) {
        wantCodes = cond.city_codes.map(String);
      } else if (_axExpect && _axExpect.cityCodes && _axExpect.cityCodes.length) {
        wantCodes = _axExpect.cityCodes.map(String);
      }
    } catch (_) { wantCodes = []; }
    var allChk = [];
    try {
      allChk = Array.prototype.slice.call(document.querySelectorAll('input[name="city_code[]"]:checked'))
        .map(function (cb) { return String(cb.value); });
    } catch (_) { allChk = []; }
    var townN = _countCheckedTowns();
    var hitWant = wantCodes.length
      ? wantCodes.filter(function (v) { return allChk.indexOf(v) >= 0; })
      : [];
    var extras = wantCodes.length
      ? allChk.filter(function (v) { return wantCodes.indexOf(v) < 0; })
      : allChk.slice();
    var phase = "unknown";
    if (extras.length) phase = "need_clear_extras";
    else if (wantCodes.length && hitWant.length < wantCodes.length) phase = "need_select";
    else if (wantCodes.length && hitWant.length >= wantCodes.length && extras.length === 0) phase = "ok";
    else if (!wantCodes.length && (allChk.length || townN)) phase = "need_clear_all";
    else if (!wantCodes.length && !allChk.length && !townN) phase = "ok_empty";
    try {
      var sig = phase + "|w" + hitWant.length + "/" + wantCodes.length + "|x" + extras.length + "|t" + townN + "|" + (scr && scr.kind);
      if (window.__axlxWardSceneSig !== sig) {
        window.__axlxWardSceneSig = sig;
        if (_audit) {
          _auditStepP(
            "ward_scene",
            phase + " screen=" + (scr && scr.kind) +
              " want済=" + hitWant.length + "/" + wantCodes.length +
              " 余分=" + extras.length + " 町残=" + townN,
          );
        }
        if (phase === "ok" || phase === "ok_empty") {
          _noteIntentUnderstood("ward", extras.length ? "clear" : "select", true, "scene_" + phase);
        }
      }
    } catch (_) {}
    return {
      phase: phase,
      hitWant: hitWant.length,
      wantN: wantCodes.length,
      extras: extras.length,
      townN: townN,
      screen: scr && scr.kind,
    };
  }
  /** 間取り場面: 前客余分の外し／want選択の段（関所・適用後で同じ印） */
  function _understandLayoutScene(wantVals) {
    var want = [];
    try {
      if (wantVals && wantVals.length) want = wantVals.map(String);
      else if (_axExpect && _axExpect.layoutVals && _axExpect.layoutVals.length) want = _axExpect.layoutVals.map(String);
    } catch (_) { want = []; }
    var allChk = [];
    try {
      allChk = Array.prototype.slice.call(document.querySelectorAll('input[name="room_layout_id[]"]:checked'))
        .map(function (cb) { return String(cb.value); });
    } catch (_) { allChk = []; }
    var hitWant = want.length ? want.filter(function (v) { return allChk.indexOf(v) >= 0; }) : [];
    var extras = want.length
      ? allChk.filter(function (v) { return want.indexOf(v) < 0; })
      : allChk.slice();
    var phase = "unknown";
    if (extras.length) phase = "need_clear_extras";
    else if (want.length && !hitWant.length) phase = "need_select";
    else if (want.length && hitWant.length < want.length) phase = "need_select_more";
    else if (want.length && hitWant.length >= want.length && !extras.length) phase = "ok";
    else if (!want.length && allChk.length) phase = "need_clear_all";
    else if (!want.length && !allChk.length) phase = "ok_empty";
    try {
      var sig = phase + "|h" + hitWant.length + "/" + want.length + "|x" + extras.length;
      if (window.__axlxLayoutSceneSig !== sig) {
        window.__axlxLayoutSceneSig = sig;
        if (_audit) {
          _auditStepP(
            "layout_scene",
            phase + " want済=" + hitWant.length + "/" + want.length + " 余分=" + extras.length + " 画面=" + allChk.length,
          );
        }
        if (phase === "ok") {
          _noteIntentUnderstood("layout", "select", true, "scene_ok " + hitWant.length + "/" + want.length);
        } else if (phase === "ok_empty") {
          _noteIntentUnderstood("layout", "clear", true, "scene_ok_empty");
        }
      }
    } catch (_) {}
    return {
      phase: phase,
      hitWant: hitWant.length,
      wantN: want.length,
      extras: extras.length,
      checked: allChk.length,
    };
  }
  /**
   * ★ 2026-11-17 悠さん自動実測: 沿線は form で checked（was→now=true）なのに
   *   可視 one_line だけ見ると0 →「沿線未選択で駅へ進まない」連発→駅0のまま確定。
   *   → **form の route_id[] / station_id[] も必ず見る**（可視と大きい方）。
   */
  function _countCheckedRoutes() {
    var vis = 0, form = 0;
    try { vis = _countCheckedVisible(_visLineLabels()); } catch (_) { vis = 0; }
    try { form = document.querySelectorAll('input[name="route_id[]"]:checked').length; } catch (_) { form = 0; }
    return Math.max(vis, form);
  }
  function _countCheckedStations() {
    var vis = 0, form = 0;
    try {
      vis = Array.prototype.slice.call(document.querySelectorAll("label.one_station"))
        .filter(isVisible)
        .filter(function (lb) {
          var cb = lb.querySelector && lb.querySelector('input[type="checkbox"]');
          if (!cb && lb.htmlFor) { try { cb = document.getElementById(lb.htmlFor); } catch (_) { cb = null; } }
          return !!(cb && cb.checked);
        }).length;
    } catch (_) { vis = 0; }
    try { form = document.querySelectorAll('input[name="station_id[]"]:checked').length; } catch (_) { form = 0; }
    return Math.max(vis, form);
  }
  /**
   * ★ 2026-11-17 竹内さん「同じ駅名でも沿線ごとに選択／十三は該当沿線すべて押す」:
   *   旧は駅名ごとに「1つでも checked なら1」→ 沿線3本でも十三が1つで完了扱い。
   *   → **同名ラベルの本数ぶん**数える（沿線ごとの駅チェックを把握する）。
   */
  function _stationNameMatch(ptxt, clean) {
    var t = String(ptxt || "").replace(/\s+/g, "").replace(/駅$/, "");
    var c = String(clean || "").replace(/\s+/g, "").replace(/駅$/, "");
    if (!t || !c) return false;
    return t === c || (t.length >= 2 && c.length >= 2 && (t.startsWith(c) || c.startsWith(t)));
  }
  /** want 駅名に当たる label.one_station（または station_id[]）の本数＝沿線ごとの候補 */
  function _countWantStationTargets(names, cond, domOnly) {
    var want = (names || []).map(function (s) { return String(s || "").replace(/駅$/, "").trim(); }).filter(Boolean);
    if (!want.length) return 0;
    var n = 0;
    try {
      var labels = Array.prototype.slice.call(document.querySelectorAll("label.one_station"));
      if (!labels.length) {
        Array.prototype.slice.call(document.querySelectorAll('input[name="station_id[]"]')).forEach(function (inp) {
          var lab = null;
          try { lab = _labelForCheckbox(inp) || inp.parentElement; } catch (_) { lab = inp.parentElement; }
          var ptxt = String((lab && lab.textContent) || "");
          if (want.some(function (c) { return _stationNameMatch(ptxt, c); })) n++;
        });
      } else {
        labels.forEach(function (lab) {
          var ptxt = String(lab.textContent || "");
          if (want.some(function (c) { return _stationNameMatch(ptxt, c); })) n++;
        });
      }
    } catch (_) {}
    /**
     * ★ 地図期待: DOM がまだ少ない／見えていない時も「十三×3沿線なら3本」を落とさない。
     *   DOM本数と地図期待の大きい方を採用。
     */
    if (domOnly) return n;
    try {
      var mapExp = _mapExpectWantStationTargets(want, _selectedLineNamesNow(cond || null));
      if (mapExp > n) n = mapExp;
    } catch (_) {}
    return n;
  }
  /** want 駅名に当たる checked 本数（同名が複数沿線にあれば複数） */
  function _countWantStationsChecked(names) {
    var want = (names || []).map(function (s) { return String(s || "").replace(/駅$/, "").trim(); }).filter(Boolean);
    if (!want.length) return 0;
    var ok = 0;
    try {
      var inputs = Array.prototype.slice.call(document.querySelectorAll('input[name="station_id[]"]:checked'));
      inputs.forEach(function (inp) {
        var lab = null;
        try { lab = _labelForCheckbox(inp) || inp.parentElement; } catch (_) { lab = inp.parentElement; }
        var ptxt = String((lab && lab.textContent) || "");
        if (want.some(function (c) { return _stationNameMatch(ptxt, c); })) ok++;
      });
    } catch (_) {}
    return ok;
  }
  /**
   * ★ 2026-11-17 竹内さん「沿線押した／駅選択／外したの理解ができていない」:
   *   DB: 自動 line_select多数・st_select=0・go_block大量・confirmあり。
   *   → 今の画面＋formの本数＋客の want から「次に何をすべき段」を1つに決める。
   *   沿線押し ≠ 駅選択。外す ≠ 選ぶ。確定は駅が揃ってから。
   */
  function _understandStationScene(cond) {
    var scr = _graspStationModalScreen();
    var wantStN = (cond && cond.station_names && cond.station_names.length) ? cond.station_names.length : 0;
    var wantLnN = (cond && cond.route_ids && cond.route_ids.length) ? cond.route_ids.length : 0;
    var formLn = 0, formSt = 0, wantOk = 0;
    try { formLn = _countCheckedRoutes(); } catch (_) { formLn = 0; }
    try { formSt = _countCheckedStations(); } catch (_) { formSt = 0; }
    var wantTargets = 0;
    try { wantOk = wantStN ? _countWantStationsChecked(cond.station_names) : 0; } catch (_) { wantOk = 0; }
    try { wantTargets = wantStN ? _countWantStationTargets(cond.station_names, cond) : 0; } catch (_) { wantTargets = wantStN; }
    var absentN = 0;
    try { absentN = wantStN ? _stationNamesAbsentStable(cond.station_names).length : 0; } catch (_) { absentN = 0; }
    if (absentN) {
      try { wantTargets = _countWantStationTargets(cond.station_names, cond, true); } catch (_) {}
    }
    if (wantTargets < wantStN - absentN) wantTargets = wantStN - absentN;
    try { _auditLineStationMap(cond); } catch (_) {}
    var phase = "unknown";
    if (scr.kind === "closed") phase = "need_open";
    else if (wantLnN > 0 && formLn < 1 && scr.kind !== "station_list") phase = "need_line_select";
    else if (wantStN > 0 && formLn >= 1 && (scr.kind === "line_list" || (scr.canGoSt && scr.kind !== "station_list")) && wantOk < 1)
      phase = "need_go_station";
    else if (wantStN > 0 && (scr.kind === "station_list" || scr.stVis > 0) && wantOk < wantTargets)
      phase = "need_station_select";
    else if (wantStN > 0 && wantOk >= wantTargets) phase = "need_confirm";
    else if (wantStN === 0 && formLn >= 1) phase = "need_confirm_line_only";
    else if (scr.kind === "station_list" && wantStN > 0) phase = "need_station_select";
    try {
      var sig = phase + "|" + scr.kind + "|ln" + formLn + "|st" + formSt + "|ok" + wantOk + "/" + wantTargets;
      if (window.__axlxStationSceneSig !== sig) {
        window.__axlxStationSceneSig = sig;
        if (_audit) {
          _auditStepP(
            "station_scene",
            phase + " screen=" + scr.kind +
              " 沿線form=" + formLn + "/" + wantLnN +
              " 駅form=" + formSt + " want済=" + wantOk + "/" + wantTargets +
              "（名" + wantStN + "）" +
              (scr.canGoSt ? " go可" : "") + (scr.canBackLn ? " back可" : ""),
          );
        }
      }
    } catch (_) {}
    return {
      screen: scr.kind,
      formLn: formLn,
      formSt: formSt,
      wantLnN: wantLnN,
      wantStN: wantStN,
      wantTargets: wantTargets,
      wantOk: wantOk,
      phase: phase,
      canGoSt: !!scr.canGoSt,
      canBackLn: !!scr.canBackLn,
      scr: scr,
    };
  }
  /**
   * ★ 2026-11-17 竹内さん「路線の画面の把握／ほかの画面も構造を把握／把握力が足りない」:
   *   旧は visLn/visSt の数だけで判断 → DOMに両方残ると誤認 → back連打・駅外しを沿線画面でやる／
   *   station_modal_fail「路線一覧なし」。
   *   → **今どの画面か**を構造で読む土台（line_list / station_list / closed / unknown）。
   *   正本: 沿線一覧＝one_line可視＋「駅の設定へ進む」／駅一覧＝one_station可視＋「沿線の設定へ戻る」。
   * @returns {{ kind: string, lineVis: number, stVis: number, formSt: number, formLn: number, canGoSt: boolean, canBackLn: boolean, canConfirm: boolean }}
   */
  function _graspStationModalScreen() {
    var lineVis = 0, stVis = 0, formSt = 0, formLn = 0;
    try { lineVis = _visLineLabels().length; } catch (_) { lineVis = 0; }
    try { stVis = _visStationLabels().length; } catch (_) { stVis = 0; }
    try { formSt = document.querySelectorAll('input[name="station_id[]"]:checked').length; } catch (_) { formSt = 0; }
    try { formLn = document.querySelectorAll('input[name="route_id[]"]:checked').length; } catch (_) { formLn = 0; }
    // 遷移ボタンの可視（画面の印）
    var canGoSt = false, canBackLn = false, canConfirm = false;
    try {
      var els = Array.prototype.slice.call(document.querySelectorAll("a,button,div,span,li"));
      for (var i = 0; i < els.length; i++) {
        var el = els[i];
        if (!isVisible(el)) continue;
        var tx = String(el.textContent || "").replace(/\s+/g, "");
        if (!tx || tx.length > 28) continue;
        if (/駅の設定へ進む/.test(tx)) canGoSt = true;
        if (/沿線の設定へ戻る|沿線を選び直す/.test(tx)) canBackLn = true;
        if (/確定してリストへ|この条件で絞り込む/.test(tx)) canConfirm = true;
      }
    } catch (_) {}
    /**
     * 判定優先:
     *   1) 駅ラベル可視＋戻る → station_list（駅画面）
     *   2) 沿線ラベル可視＋進む → line_list（沿線画面）
     *   3) 駅だけ可視 → station_list
     *   4) 沿線だけ可視 → line_list
     *   5) 確定だけ／モーダル痕跡なし → closed
     *   6) それ以外 → unknown
     */
    var kind = "unknown";
    if (stVis > 0 && (canBackLn || lineVis === 0)) kind = "station_list";
    else if (lineVis > 0 && (canGoSt || stVis === 0)) kind = "line_list";
    else if (stVis > 0) kind = "station_list";
    else if (lineVis > 0) kind = "line_list";
    else if (!canGoSt && !canBackLn && formSt === 0 && formLn === 0 && !canConfirm) kind = "closed";
    else if (canConfirm && lineVis === 0 && stVis === 0) kind = "closed";
    var out = {
      kind: kind,
      lineVis: lineVis,
      stVis: stVis,
      formSt: formSt,
      formLn: formLn,
      canGoSt: canGoSt,
      canBackLn: canBackLn,
      canConfirm: canConfirm,
    };
    try {
      var prev = window.__axlxScreenGraspSt;
      var sig = kind + ":" + lineVis + ":" + stVis + ":" + formSt + ":" + formLn;
      if (prev !== sig) {
        window.__axlxScreenGraspSt = sig;
        if (_audit) {
          _auditStepP(
            "screen_grasp",
            "station=" + kind + " lineVis=" + lineVis + " stVis=" + stVis +
              " formSt=" + formSt + " formLn=" + formLn +
              (canGoSt ? " go" : "") + (canBackLn ? " back" : "") + (canConfirm ? " conf" : ""),
          );
        }
      }
    } catch (_) {}
    return out;
  }
  /**
   * ★ 所在地モーダルの画面把握（pref / ward / town / closed / unknown）
   */
  function _graspAreaModalScreen() {
    var wardVis = 0, townVis = 0, prefVis = 0;
    try {
      wardVis = Array.prototype.slice.call(document.querySelectorAll("label.one_city")).filter(isVisible).length;
    } catch (_) { wardVis = 0; }
    try {
      townVis = Array.prototype.slice.call(document.querySelectorAll("label.one_town")).filter(isVisible).length;
    } catch (_) { townVis = 0; }
    try {
      prefVis = Array.prototype.slice.call(document.querySelectorAll('input[name="pref_code"]'))
        .filter(function (inp) { return inp.parentElement && isVisible(inp.parentElement); }).length;
    } catch (_) { prefVis = 0; }
    var canNext = false, canConfirm = false;
    try {
      var els = Array.prototype.slice.call(document.querySelectorAll("a,button,div,span"));
      for (var i = 0; i < els.length; i++) {
        if (!isVisible(els[i])) continue;
        var tx = String(els[i].textContent || "").replace(/\s+/g, "");
        if (/詳細な地域の設定へ|次へ/.test(tx) && tx.length < 24) canNext = true;
        if (/確定してリストへ/.test(tx)) canConfirm = true;
      }
    } catch (_) {}
    var kind = "unknown";
    if (townVis > 0) kind = "town_list";
    else if (wardVis > 0) kind = "ward_list";
    else if (prefVis > 0) kind = "pref_list";
    else if (!canNext && !canConfirm) kind = "closed";
    try {
      var prev = window.__axlxScreenGraspArea;
      var sig = kind + ":" + wardVis + ":" + townVis;
      if (prev !== sig) {
        window.__axlxScreenGraspArea = sig;
        if (_audit) _auditStepP("screen_grasp", "area=" + kind + " wardVis=" + wardVis + " townVis=" + townVis);
      }
    } catch (_) {}
    return { kind: kind, wardVis: wardVis, townVis: townVis, prefVis: prefVis, canNext: canNext, canConfirm: canConfirm };
  }
  /**
   * ★ 駅を1つずつ外す（直書き禁止）。沿線は触らない。
   * ★ 2026-11-17 録画「駅も今回1駅だけ外せていなかった」:
   *   旧は isVisible でない駅をスキップ → 画面外の1駅が残る。
   *   → **先に scrollIntoView してから外す**（見えてから押す）。
   * @returns {number}
   */
  function _uncheckVisibleStationsLikeHuman(onlyVisible) {
    /**
     * ★ 2026-11-17 根本: **1回で1駅だけ**外す。
     *   旧は checked 全件を一括キュー → scrollIntoView が連続で走り、画面外の1駅が残る／押し失敗。
     *   → 先頭1件を中央へ寄せてから外す。残りは次ティック（状態機械が再呼出し）。
     */
    /**
     * ★ 2026-11-20 竹内さん「最初画面おかしくなる」「直接入力してしまっている可能性」:
     *   小窓が閉じていて見えない駅まで画面を送って押していた（画面が飛ぶ・カーソル無しの直接外しに見える）。
     *   → onlyVisible の時（小窓の外からの呼び出し）は見える駅だけ外す。見えない残りは小窓を開いて外す経路が担当する。
     */
    var cbs = Array.prototype.slice.call(document.querySelectorAll('input[name="station_id[]"]:checked')).filter(function (cb) {
      if (!onlyVisible) return true;
      var h = _labelForCheckbox(cb) || cb;
      return isVisible(h);
    });
    if (!cbs.length) {
      // 可視ラベル側の残（nameずれ対策）
      var visLeft = null;
      _visStationLabels().some(function (lb) {
        var cb = lb.querySelector && lb.querySelector('input[type="checkbox"]');
        if (!cb && lb.htmlFor) { try { cb = document.getElementById(lb.htmlFor); } catch (_) { cb = null; } }
        if (cb && cb.checked) { visLeft = { cb: cb, hit: lb }; return true; }
        return false;
      });
      if (!visLeft) return 0;
      try {
        visLeft.hit.scrollIntoView({
          behavior: Math.random() < 0.8 ? "smooth" : "auto",
          block: Math.random() < 0.75 ? "center" : "nearest",
          inline: "nearest",
        });
      } catch (_) {}
      try { if (_audit) _auditStepP("station_scroll_clear", String(visLeft.cb.value || "").slice(0, 24)); } catch (_) {}
      _toggleCheckboxLikeHuman(visLeft.cb, false);
      return 1;
    }
    var cb0 = cbs[0];
    var hit0 = _labelForCheckbox(cb0) || cb0;
    try {
      if (hit0 && hit0.scrollIntoView) {
        hit0.scrollIntoView({
          behavior: Math.random() < 0.8 ? "smooth" : "auto",
          block: Math.random() < 0.75 ? "center" : "nearest",
          inline: "nearest",
        });
      }
    } catch (_) {}
    try { if (_audit) _auditStepP("station_scroll_clear", String(cb0.value || "").slice(0, 24) + " 残" + cbs.length); } catch (_) {}
    _toggleCheckboxLikeHuman(cb0, false);
    return 1;
  }
  /**
   * ★ 沿線を1つずつ外す（直書き禁止）。駅は触らない。
   *   画面外の沿線もスクロールしてから外す（駅と同じ漏れ防止）。
   * @returns {number}
   */
  function _uncheckVisibleLinesLikeHuman(onlyVisible) {
    /**
     * ★ 2026-11-17 根本: 駅と同じく **1回で1沿線だけ**（一括キュー禁止）。
     *   DB: line_clear_after_station が同一沿線を大量連打＝外し失敗のまま次へ進めていた。
     */
    var cbs = Array.prototype.slice.call(document.querySelectorAll('input[name="route_id[]"]:checked')).filter(function (cb) {
      if (!onlyVisible) return true;
      var h = _labelForCheckbox(cb) || cb;
      return isVisible(h);
    });
    if (!cbs.length) {
      var visLeft = null;
      _visLineLabels().some(function (lb) {
        var cb = lb.querySelector && lb.querySelector('input[type="checkbox"]');
        if (!cb && lb.htmlFor) { try { cb = document.getElementById(lb.htmlFor); } catch (_) { cb = null; } }
        if (cb && cb.checked) { visLeft = { cb: cb, hit: lb }; return true; }
        return false;
      });
      if (!visLeft) return 0;
      try {
        visLeft.hit.scrollIntoView({
          behavior: Math.random() < 0.8 ? "smooth" : "auto",
          block: Math.random() < 0.75 ? "center" : "nearest",
          inline: "nearest",
        });
      } catch (_) {}
      _toggleCheckboxLikeHuman(visLeft.cb, false);
      return 1;
    }
    var cb0 = cbs[0];
    var hit0 = _labelForCheckbox(cb0) || cb0;
    try {
      if (hit0 && hit0.scrollIntoView) {
        hit0.scrollIntoView({
          behavior: Math.random() < 0.8 ? "smooth" : "auto",
          block: Math.random() < 0.75 ? "center" : "nearest",
          inline: "nearest",
        });
      }
    } catch (_) {}
    _toggleCheckboxLikeHuman(cb0, false);
    return 1;
  }
  /**
   * ★ 2026-11-16 竹内さん「駅を外すとき直接入力／1つずつカーソル／まずは駅から次に沿線」:
   *   見える label だけ外す。順番は **駅 → 沿線**。checked=false 禁止。
   * ⚠ 沿線画面だけで呼ぶと駅が見えず沿線だけ外れる＝竹内さん指摘の「直接外している」。
   *   続き客の強制クリアは `_advanceForcePlaceClearViaStationFirst` を使うこと。
   * @returns {number} 積んだ外し件数
   */
  function _uncheckStationsThenLinesLikeHuman(opts) {
    var o = opts || {};
    var forceAll = !!o.forceAll;
    var stN = _uncheckVisibleStationsLikeHuman(true);
    var lineN = _uncheckVisibleLinesLikeHuman(true);
    if (stN || lineN) {
      try {
        if (_audit) {
          _auditStepP(
            forceAll ? "station_then_line_clear_force" : "station_then_line_clear",
            "駅" + stN + "→沿線" + lineN + "を1つずつカーソルで外す（直書きなし）",
          );
        }
      } catch (_) {}
      console.log("[AX] 駅→沿線の順で外す", stN, "→", lineN, forceAll ? "(続き客)" : "");
    }
    return stN + lineN;
  }
  /**
   * ★ 2026-11-17 学習→自動の断絶封じ:
   *   束の `scene_flows`（station）から「駅の設定へ進む／沿線の設定へ戻る」文言を拾い、
   *   強制クリアの押下候補の先頭に置く（録画正本が自動に載る経路）。
   */
  function _learnedStationTransitLabels() {
    var go = ["駅の設定へ進む", "駅の設定へ進む›", "駅の設定へ進む>"];
    var back = ["沿線の設定へ戻る", "沿線の設定へ戻る›", "沿線の設定へ戻る>", "沿線を選び直す", "沿線選択に戻る", "路線を選び直す"];
    var hit = false;
    try {
      _loadLearnNext();
      var flows = window.__axlxLearnSceneFlows;
      if (!Array.isArray(flows)) return { go: go, back: back, hit: false, stepsN: 0 };
      for (var i = 0; i < flows.length; i++) {
        var f = flows[i] || {};
        if (String(f.scene || "") !== "station") continue;
        var steps = Array.isArray(f.steps) ? f.steps : [];
        for (var si = 0; si < steps.length; si++) {
          var raw = String(steps[si] || "");
          var cleaned = raw
            .replace(/^(click:|change:|tap:)/i, "")
            .replace(/^(左の|右の|上の|下の|中央の|小窓の)/, "")
            .replace(/｜[^｜]*$/, "")
            .trim();
          if (/駅の設定へ進む/.test(cleaned) || /駅の設定へ進む/.test(raw)) {
            if (go.indexOf(cleaned) < 0) go.unshift(cleaned);
            hit = true;
          }
          if (/沿線の設定へ戻る|沿線を選び直す|路線を選び直す|沿線選択に戻る/.test(cleaned) || /沿線の設定へ戻る/.test(raw)) {
            if (back.indexOf(cleaned) < 0) back.unshift(cleaned);
            hit = true;
          }
        }
        try {
          if (!window.__axlxLearnStationFlowNoted && _audit) {
            window.__axlxLearnStationFlowNoted = true;
            _auditStepP(
              hit ? "learn_station_flow_hit" : "learn_station_flow_gap",
              hit
                ? ("束の駅手順を外し状態機械に反映 steps=" + steps.length)
                : ("束の駅手順に遷移ボタン無し steps=" + steps.length + "→録画正本の文言で続行"),
            );
          }
        } catch (_) {}
        return { go: go, back: back, hit: hit, stepsN: steps.length };
      }
    } catch (_) {}
    try {
      if (!window.__axlxLearnStationFlowNoted && _audit) {
        window.__axlxLearnStationFlowNoted = true;
        _auditStepP("learn_station_flow_gap", "scene_flows に station 無し（束未読か旧束）");
      }
    } catch (_) {}
    return { go: go, back: back, hit: false, stepsN: 0 };
  }
  /**
   * ★ 2026-11-17 竹内さん「駅の設定へ進むにまず沿線の画面からすすんでえきを１つずつ外す／そのあとに沿線を外す」:
   *   沿線画面で沿線だけ直外ししない。状態機械:
   *   start → go_station（駅の設定へ進む）→ clear_stations → back_to_lines → clear_lines → done
   * @returns {boolean} true=外し完了（通常の沿線選択へ進んでよい）／false=まだ外し中
   */
  function _advanceForcePlaceClearViaStationFirst() {
    var phase = null;
    try { phase = window.__axlxPlaceClearPhase || null; } catch (_) { phase = null; }
    if (phase === "done") return true;
    try { if (isClickQueueBusy()) return false; } catch (_) {}

    var transit = _learnedStationTransitLabels();
    /** ★ 画面把握土台: 数だけでなく kind で分岐（誤画面操作を止める） */
    var scr = _graspStationModalScreen();
    var visSt = _visStationLabels();
    var visLn = _visLineLabels();
    var checkedSt = Math.max(_countCheckedVisible(visSt), Number(scr.formSt) || 0);
    // ★ 悠さん自動: 可視0でも form の route_id[] checked を沿線ありと見る
    var checkedLn = Math.max(_countCheckedVisible(visLn), Number(scr.formLn) || 0);
    var formSt = scr.formSt;

    if (!phase || phase === "start") {
      // ★ 土台 F23/F24: 外し開始を必ず1回残す（測れる）
      try {
        if (!window.__axlxPlaceClearBegan) {
          window.__axlxPlaceClearBegan = true;
          if (_audit) _auditStepP("station_place_clear_begin", "沿線画面→駅の設定へ→駅外し→沿線外し screen=" + scr.kind + (transit.hit ? "（束の駅手順あり）" : ""));
          try { _noteClearMethod("station", "via_next_then_clear", "begin screen=" + scr.kind); } catch (_) {}
        }
      } catch (_) {}
      // すでに駅画面にいる → 駅外しへ
      if (scr.kind === "station_list" && (checkedSt > 0 || formSt > 0 || scr.stVis > 0)) {
        try { window.__axlxPlaceClearPhase = "clear_stations"; } catch (_) {}
        return false;
      }
      if (checkedSt > 0 || (visSt.length && formSt > 0)) {
        try { window.__axlxPlaceClearPhase = "clear_stations"; } catch (_) {}
        return false;
      }
      /**
       * ★ 2026-11-17 DB実測＋竹内さん「沿線を選択せず押してエラー」:
       *   → **沿線画面（line_list）かつ沿線1本以上 checked** のときだけ駅へ進む。
       */
      if (scr.kind === "line_list" && checkedLn > 0) {
        try { window.__axlxPlaceClearPhase = "go_station"; window.__axlxPlaceClearGoAt = 0; } catch (_) {}
        return false;
      }
      if (visLn.length > 0 && checkedLn > 0 && scr.kind !== "station_list") {
        try { window.__axlxPlaceClearPhase = "go_station"; window.__axlxPlaceClearGoAt = 0; } catch (_) {}
        return false;
      }
      if (scr.kind === "line_list" && formSt > 0 && checkedLn === 0) {
        try {
          if (_audit) _auditStepP("station_clear_blocked_no_line", "残駅ありだが沿線未選択→駅へ進まない（エラー防止）");
        } catch (_) {}
        return false;
      }
      if (scr.kind === "line_list" && checkedLn > 0 && formSt === 0 && checkedSt === 0) {
        try { window.__axlxPlaceClearPhase = "clear_lines"; } catch (_) {}
        return false;
      }
      if (scr.kind === "closed" && formSt === 0 && scr.formLn === 0) {
        try {
          window.__axlxPlaceClearPhase = "done";
          window.__axlxStationForceClearedOnce = true;
          window.__axlxLineForceClearedOnce = true;
          window.__axlxNeedClearStation = false;
        } catch (_) {}
        return true;
      }
      // 外す物なし
      try {
        window.__axlxPlaceClearPhase = "done";
        window.__axlxStationForceClearedOnce = true;
        window.__axlxLineForceClearedOnce = true;
        window.__axlxNeedClearStation = false;
      } catch (_) {}
      return true;
    }

    if (phase === "go_station") {
      // 画面把握: すでに駅一覧なら clear へ（進むを連打しない）
      if (scr.kind === "station_list" || visSt.length > 0) {
        try { window.__axlxPlaceClearPhase = "clear_stations"; } catch (_) {}
        return false;
      }
      // ★ 沿線画面以外／沿線0本では絶対に押さない
      if (scr.kind !== "line_list" && scr.kind !== "unknown") {
        try {
          if (_audit) _auditStepP("station_go_wrong_screen", "screen=" + scr.kind + "のため駅の設定へ進むを押さない");
        } catch (_) {}
        return false;
      }
      if (checkedLn < 1) {
        try {
          // 録画ノート汚染防止: 監査は5秒に1回だけ
          var _gwAt = Number(window.__axlxGoWithoutLineAt) || 0;
          if (!_gwAt || Date.now() - _gwAt > 5000) {
            window.__axlxGoWithoutLineAt = Date.now();
            if (_audit) _auditStepP("station_go_without_line", "沿線未選択のため駅の設定へ進むを押さない");
          }
        } catch (_) {}
        try { window.__axlxPlaceClearGoAt = 0; } catch (_) {}
        try { window.__axlxPlaceClearPhase = "start"; } catch (_) {}
        return false;
      }
      var goAt = 0;
      try { goAt = Number(window.__axlxPlaceClearGoAt) || 0; } catch (_) { goAt = 0; }
      if (!goAt) {
        if (!scr.canGoSt && scr.kind === "line_list") {
          try { if (_audit) _auditStepP("station_go_no_btn", "沿線画面だが駅の設定へ進むが見えない"); } catch (_) {}
        }
        if (clickByText(transit.go)) {
          try {
            window.__axlxPlaceClearGoAt = _placeClearClock.tick() || 1;
            if (_audit) _auditStepP("station_clear_via_next", "外しのため沿線画面から駅の設定へ進む screen=" + scr.kind + (transit.hit ? "・束反映" : ""));
            try { _noteClearMethod("station", "via_next", "駅の設定へ進む"); } catch (_) {}
          } catch (_) {}
          console.log("[AX] 強制クリア: 沿線画面→駅の設定へ進む（駅を先に外す）");
        }
        return false;
      }
      if (_placeClearClock.tick() - goAt > 9000) {
        try {
          if (_audit) _auditStepP("station_clear_via_next_timeout", "駅ページへ進めず沿線外しへ screen=" + scr.kind);
          window.__axlxPlaceClearPhase = "clear_lines";
        } catch (_) {}
      }
      return false;
    }

    if (phase === "clear_stations") {
      // ★ 駅画面以外では外さない（沿線画面で駅を触る誤操作防止）
      if (scr.kind === "line_list") {
        try {
          if (_audit) _auditStepP("station_clear_wrong_screen", "line_list上で駅外ししない→go_stationへ");
          window.__axlxPlaceClearPhase = "go_station";
          window.__axlxPlaceClearGoAt = 0;
        } catch (_) {}
        return false;
      }
      var nSt = _uncheckVisibleStationsLikeHuman();
      var leftSt = formSt;
      /**
       * ★ 2026-11-17 DB: 外し was→now 失敗で clear が無限連打 → モーダル待ちを食いつぶし
       *   station_modal_fail「路線一覧が表示されませんでした」。
       *   → 残数が変わらない連続試行を数え、上限で次フェーズへ（細部の暴走止め）。
       */
      var stStuck = 0;
      try {
        var sk = "st:" + leftSt;
        if (window.__axlxClearStuckKey === sk) stStuck = (Number(window.__axlxClearStuckN) || 0) + 1;
        else stStuck = 0;
        window.__axlxClearStuckKey = sk;
        window.__axlxClearStuckN = stStuck;
      } catch (_) { stStuck = 0; }
      if (nSt) {
        try {
          if (_audit) _auditStepP("station_clear_cursor", "駅" + nSt + "を1つずつ外す（沿線の前）残" + leftSt);
          try { _noteClearMethod("station", "one_station_label", "外し" + nSt + "残" + leftSt); } catch (_) {}
        } catch (_) {}
        console.log("[AX] 強制クリア: 駅を先に外す", nSt);
        if (stStuck >= 7) {
          try {
            if (_audit) _auditStepP("station_clear_stuck", "残" + leftSt + "・外し失敗連続" + stStuck + "→沿線へ（モーダルタイムアウト防止）");
          } catch (_) {}
        } else {
          return false; // キュー消化待ち
        }
      }
      if (leftSt > 0 && stStuck < 7) {
        var scrollTries = 0;
        try { scrollTries = Number(window.__axlxStationClearScrollTries) || 0; } catch (_) { scrollTries = 0; }
        if (scrollTries < 8) {
          try {
            var leftCb = document.querySelector('input[name="station_id[]"]:checked');
            var leftHit = leftCb ? (_labelForCheckbox(leftCb) || leftCb) : null;
            if (leftHit && leftHit.scrollIntoView) {
              leftHit.scrollIntoView({ behavior: "smooth", block: "center", inline: "nearest" });
            }
            window.__axlxStationClearScrollTries = scrollTries + 1;
            if (_audit) _auditStepP("station_clear_scroll_retry", "残" + leftSt + "・試行" + (scrollTries + 1));
          } catch (_) {}
          return false;
        }
        try {
          if (_audit) _auditStepP("station_clear_left", "残駅" + leftSt + "を外し切れず沿線へ（上限）");
        } catch (_) {}
      }
      try {
        window.__axlxStationForceClearedOnce = true;
        window.__axlxStationClearScrollTries = 0;
        window.__axlxClearStuckKey = "";
        window.__axlxClearStuckN = 0;
        window.__axlxPlaceClearPhase = "back_to_lines";
        window.__axlxPlaceClearBackTries = 0;
        window.__axlxPlaceClearBackAt = Date.now();
      } catch (_) {}
      return false;
    }

    if (phase === "back_to_lines") {
      /**
       * ★ 2026-11-17 通常録画（2.8.46）正本:
       *   駅を1つずつ外したあと **「沿線の設定へ戻る」**（g≈1510）→ 沿線を外す／選び直す。
       * ★ 画面把握: line_list に着いたら clear_lines。station_list のときだけ back を押す。
       *   DB back×5連打＝画面を読まず押していた。
       */
      if (scr.kind === "line_list" || (visLn.length > 0 && scr.kind !== "station_list")) {
        try {
          if (!window.__axlxPlaceClearBackSettled) {
            window.__axlxPlaceClearBackSettled = true;
            var Hb = window.AxlxHumanWait;
            var settle = Hb && Hb.logNormalDelay ? Hb.logNormalDelay(1510, 0.4) : 1510;
            if (settle < 900) settle = 900;
            if (settle > 2600) settle = 2600;
            window.__axlxPlaceClearBackSettleUntil = Date.now() + settle;
            return false;
          }
          if (Date.now() < (Number(window.__axlxPlaceClearBackSettleUntil) || 0)) return false;
        } catch (_) {}
        try { window.__axlxPlaceClearPhase = "clear_lines"; window.__axlxClearStuckKey = ""; window.__axlxClearStuckN = 0; } catch (_) {}
        return false;
      }
      try {
        if (Date.now() < (Number(window.__axlxPlaceClearBackSettleUntil) || 0)) return false;
      } catch (_) {}
      var tries = 0;
      try { tries = Number(window.__axlxPlaceClearBackTries) || 0; } catch (_) { tries = 0; }
      if (tries < 2) {
        // 駅画面以外で back を押さない（把握）
        if (scr.kind !== "station_list" && !scr.canBackLn) {
          try {
            if (_audit) _auditStepP("station_back_wrong_screen", "screen=" + scr.kind + "・back不可→待ち");
          } catch (_) {}
          return false;
        }
        var backOk = clickByText(transit.back);
        if (!backOk) {
          try {
            var els = Array.prototype.slice.call(document.querySelectorAll("a,button,div,span,li"));
            for (var bi = 0; bi < els.length; bi++) {
              var el = els[bi];
              if (!isVisible(el)) continue;
              var tx = String(el.textContent || "").replace(/\s+/g, "");
              if (!tx || tx.length > 24) continue;
              if (/トップ|ホーム|main\.php|ログアウト|駅の設定へ/.test(tx)) continue;
              // 録画正本／沿線へ戻る系だけ（曖昧な「戻る」単体は最後）
              if (/沿線の設定へ戻る|沿線.*戻る|設定へ戻る/.test(tx)) {
                var nb = _nextBackGapRange();
                enqueueHumanClick(el, _clickEl, nb.lo, nb.hi, null, { sigma: 0.55 });
                backOk = true;
                break;
              }
            }
          } catch (_) {}
        }
        try { window.__axlxPlaceClearBackTries = tries + 1; } catch (_) {}
        if (backOk) {
          try {
            window.__axlxPlaceClearBackSettled = false;
            // 押した直後は画面遷移を待つ（すぐ再押ししない）
            var Hb2 = window.AxlxHumanWait;
            var waitBack = Hb2 && Hb2.logNormalDelay ? Hb2.logNormalDelay(1600, 0.4) : 1600;
            if (waitBack < 1000) waitBack = 1000;
            if (waitBack > 2800) waitBack = 2800;
            window.__axlxPlaceClearBackSettleUntil = Date.now() + waitBack;
            if (_audit) _auditStepP("station_clear_back_line", "沿線の設定へ戻る#" + (tries + 1) + (transit.hit ? "・束反映" : ""));
          } catch (_) {}
          console.log("[AX] 強制クリア: 沿線の設定へ戻る（録画正本）");
          return false;
        }
        // 押せなかった時だけすぐ再試行可
        return false;
      }
      // 戻れない → 一旦確定して沿線モーダルを開き直す（最終手段）
      try {
        if (_audit) _auditStepP("station_clear_back_giveup", "沿線へ戻れず×" + tries + "→一旦確定→再開");
      } catch (_) {}
      if (_pressConfirmListLikeHuman("駅クリア中の一旦確定") || clickByText(["確定してリストへ", "この条件で絞り込む", "決定"])) {
        try {
          if (_audit) _auditStepP("station_clear_confirm_mid", "沿線の設定へ戻る無し→一旦確定→沿線再開");
          window.__axlxPlaceClearPhase = "reopen";
          window.__axlxPlaceClearReopenAt = _placeClearClock.tick() || 1;
          window.__axlxLineForceClearedOnce = false;
          window.__axlxNeedClearStation = true;
        } catch (_) {}
        console.log("[AX] 強制クリア: 沿線へ戻れず確定→沿線再開");
        return false;
      }
      try {
        window.__axlxPlaceClearPhase = "done";
        window.__axlxLineForceClearedOnce = true;
        window.__axlxNeedClearStation = false;
        if (_audit) _auditStepP("station_clear_line_skip", "沿線画面に戻れず駅外しのみ完了");
      } catch (_) {}
      return true;
    }

    if (phase === "reopen") {
      if (visLn.length > 0) {
        try { window.__axlxPlaceClearPhase = "clear_lines"; } catch (_) {}
        return false;
      }
      if (clickByText(["沿線・駅絞り込み＋", "沿線・駅絞り込み+", "沿線・駅絞り込み"])) {
        try {
          if (_audit) _auditStepP("station_reopen_for_line_clear", "駅外し後に沿線画面を開き直す");
        } catch (_) {}
      }
      var reAt = 0;
      try { reAt = Number(window.__axlxPlaceClearReopenAt) || 0; } catch (_) { reAt = 0; }
      if (reAt && _placeClearClock.tick() - reAt > 12000) {
        try {
          window.__axlxPlaceClearPhase = "done";
          window.__axlxLineForceClearedOnce = true;
          window.__axlxNeedClearStation = false;
        } catch (_) {}
        return true;
      }
      return false;
    }

    if (phase === "clear_lines") {
      // ★ 駅画面のまま沿線外ししない → 先に back
      if (scr.kind === "station_list") {
        try {
          if (_audit) _auditStepP("line_clear_wrong_screen", "station_list上で沿線外ししない→backへ");
          window.__axlxPlaceClearPhase = "back_to_lines";
          window.__axlxPlaceClearBackTries = 0;
        } catch (_) {}
        return false;
      }
      var nLn = _uncheckVisibleLinesLikeHuman();
      var leftLn = scr.formLn;
      /** ★ DB: line_clear_after_station 大量連打＝外し失敗のまま同じ沿線を押し続ける */
      var lnStuck = 0;
      try {
        var lk = "ln:" + leftLn;
        if (window.__axlxClearStuckKey === lk) lnStuck = (Number(window.__axlxClearStuckN) || 0) + 1;
        else lnStuck = 0;
        window.__axlxClearStuckKey = lk;
        window.__axlxClearStuckN = lnStuck;
      } catch (_) { lnStuck = 0; }
      if (nLn) {
        try {
          if (_audit) _auditStepP("line_clear_after_station", "駅のあと沿線" + nLn + "を1つずつ外す残" + leftLn);
        } catch (_) {}
        console.log("[AX] 強制クリア: 駅のあと沿線を外す", nLn);
        if (lnStuck < 8) return false;
        try {
          if (_audit) _auditStepP("line_clear_stuck", "残" + leftLn + "・外し失敗連続" + lnStuck + "→完了扱い（路線一覧タイムアウト防止）");
        } catch (_) {}
      } else if (leftLn > 0) {
        var lnTries = 0;
        try { lnTries = Number(window.__axlxLineClearScrollTries) || 0; } catch (_) { lnTries = 0; }
        if (lnTries < 10 && lnStuck < 8) {
          try {
            var leftLcb = document.querySelector('input[name="route_id[]"]:checked');
            var leftLhit = leftLcb ? (_labelForCheckbox(leftLcb) || leftLcb) : null;
            if (leftLhit && leftLhit.scrollIntoView) {
              leftLhit.scrollIntoView({ behavior: "smooth", block: "center", inline: "nearest" });
            }
            window.__axlxLineClearScrollTries = lnTries + 1;
            if (_audit) _auditStepP("line_clear_scroll_retry", "残" + leftLn + "・試行" + (lnTries + 1));
          } catch (_) {}
          return false;
        }
        try {
          if (_audit) _auditStepP("line_clear_left", "残沿線" + leftLn + "を外し切れず完了扱いにする（上限）");
        } catch (_) {}
      }
      try {
        window.__axlxPlaceClearPhase = "done";
        window.__axlxLineClearScrollTries = 0;
        window.__axlxClearStuckKey = "";
        window.__axlxClearStuckN = 0;
        window.__axlxStationForceClearedOnce = true;
        window.__axlxLineForceClearedOnce = true;
        window.__axlxNeedClearStation = false;
        if (_audit) _auditStepP("station_then_line_clear_force", "駅→沿線の順で外し完了（駅の設定へ経由）");
      } catch (_) {}
      return true;
    }

    return true;
  }

  /**
   * ★ 2026-11-19 竹内さん「新しいお客さんが所在地で検索する場合駅外して所在地を入れるなど」「駅と地域は混ぜない」:
   *   _doReset は駅・沿線の残りを直外しせず「駅画面経由」へ回すが、それを動かすのは駅の流れ（STEP B）だけだった。
   *   所在地・場所なしの客では誰も外さず、前客の駅を残したまま区を入れていた（#1478 区4/9・#1476 fill-done 未着・#1479）。
   *   → 所在地へ入る前に「沿線・駅絞り込み」を開き、駅→沿線の順で1つずつ外して確定してから次へ進む。
   *     外し切れない時も止めずに進み、検索前の関所（_axGateCheck の混在）がもう一度これで外す。
   */
  /**
   * ★ 2026-11-19 竹内さん「検索する際に前のお客さんの条件が残っていると判断できる能力…どこを外すのかも理解できる。
   *   連続で検索する場合は必ず前のお客さんの条件が残っている…そこを把握していれば止まることはなくなる」:
   *   旧は「残っているか見ずに」全部を外す手順を流していた（残らなかった所を後の関所で初めて知り止まる）。
   *   → ①フォームを読んで「前客が何を残しているか」を言葉にする（_scanLeftoverForm）
   *     ②今回のお客さんが欲しい場所と比べて「どこを外すか」を決める（_planLeftover・純関数）
   *     ③外した後にもう一度読み、残りがあれば場所は専用の外しで／チェック類は全体をやり直す（_cleanStartGate）
   *   ⚠ 入力に入る前に必ず「きれいな状態」を確かめてから進む（前客が止まった・人が触った後でも同じ）。
   */
  function _axWantPlaceMode(c) {
    c = c || {};
    var hasWard = !!((c.city_codes && c.city_codes.length > 0) || c.detail_ward);
    var hasSt = !!(c.station_names && c.station_names.length > 0);
    var hasRt = !!(c.route_ids && c.route_ids.length > 0);
    if (c.area_mode === "ward") {
      if (hasWard) return "area";
      if (hasSt) return "station";
      if (hasRt) return "route";
      return "none";
    }
    if (c.area_mode === "station") {
      if (hasSt) return "station";
      if (hasRt) return "route";
      if (hasWard) return "area";
      return "none";
    }
    if (hasWard) return "area";
    if (hasSt) return "station";
    if (hasRt) return "route";
    return "none";
  }
  function _scanLeftoverForm() {
    var q = function (sel) { try { return document.querySelectorAll(sel).length; } catch (_) { return 0; } };
    var s = {
      stations: q('input[name="station_id[]"]:checked'),
      lines: q('input[name="route_id[]"]:checked'),
      wards: q('input[name="city_code[]"]:checked'),
      towns: q('input[name="town_code[]"]:checked'),
      layouts: q('input[name="room_layout_id[]"]:checked'),
      structured: q('input[name="structured_type[]"]:checked'),
      pet: q('input[name="eq_rm[]"]:checked'),
      shikirei: false,
      selects: [],
      texts: [],
    };
    try { var _sh = _findShikireiCheckbox(); s.shikirei = !!(_sh && _sh.checked); } catch (_) {}
    ["rental_cost1", "rental_cost2", "transportation_id", "structured_date", "square_meter_l", "square_meter_h", "update_date"].forEach(function (n) {
      try {
        var el = document.querySelector("select[name='" + n + "']");
        if (el && el.selectedIndex > 0) s.selects.push(n);
      } catch (_) {}
    });
    ["required_time", "keyword", "free_word", "freeword", "building_name", "search_word"].forEach(function (n) {
      try {
        var el = document.querySelector("input[name='" + n + "']");
        if (el && el.value) s.texts.push(n);
      } catch (_) {}
    });
    return s;
  }
  /**
   * ★ 2026-11-19 竹内さん「外すのもちゃんと検索で入れたのを覚えていたらはずせる。その点も把握できていたら外し忘れがなくなる」:
   *   「入れたものの控え」（台帳）を客ごとに作って sessionStorage に残す（ページが読み直されても消えない）。
   *   次の客の開始時に、画面の読み取り（DOM）と台帳を**突き合わせる**:
   *   画面に見えない（モーダルが閉じて DOM から消えた）が台帳には「駅5・沿線1」とあれば、
   *   外し忘れの候補としてモーダルを開いて確かめて外す。外し終えたら台帳を消す。
   */
  var _AX_LEDGER_KEY = "axlx_entered_ledger";
  var _axLedgerAcc = { stations: 0, lines: 0, wards: 0, towns: 0, layouts: 0, structured: 0, pet: 0, shikirei: 0, names: {} };
  var _axLedgerTimer = null;
  /**
   * ★ 2026-11-20 竹内さん「ちゃんとお客さんと次のお客さんの切り替える部分を把握するようにする」:
   *   ⚠ 前客の番号（__axlxLastFilledCustomerId）は window にしか無く、リアプロは検索のたびに頁を読み直すので
   *     次のお客さんの開始時には消えていた → 切替把握が毎回「first_customer（前客なし）」になっていた。
   *   → 前客の番号は sessionStorage にも置く（同じタブなら頁を読み直しても残る）。
   *   台帳の番号は「その台帳を始めたお客さん」で固定する（保存が遅れて次客の番号が付かないように）。
   *   台帳には「そのお客さんが入れたかった物」（区のコード・駅の名前）も残し、次客と突き合わせる。
   */
  var _AX_LAST_CID_KEY = "axlx_last_filled_cid";
  var _axLedgerCid = "";
  var _axLedgerWant = null;
  function _lastFilledCidLoad() {
    try {
      var w = window.__axlxLastFilledCustomerId;
      if (w) return String(w);
      var raw = window.sessionStorage && window.sessionStorage.getItem(_AX_LAST_CID_KEY);
      if (!raw) return "";
      var o = JSON.parse(raw);
      if (!o || !o.cid || Date.now() - Number(o.at || 0) > 6 * 3600 * 1000) return "";
      return String(o.cid);
    } catch (_) { return ""; }
  }
  function _lastFilledCidSave(cid) {
    try {
      window.__axlxLastFilledCustomerId = cid || null;
      if (cid && window.sessionStorage) window.sessionStorage.setItem(_AX_LAST_CID_KEY, JSON.stringify({ cid: String(cid), at: Date.now() }));
    } catch (_) {}
  }
  function _wantOfCond(cond) {
    var w = { wards: [], stations: [] };
    try {
      w.wards = (cond && cond.city_codes ? cond.city_codes : []).map(String).slice(0, 40);
      w.stations = (cond && cond.station_names ? cond.station_names : []).map(function (s) { return String(s).slice(0, 16); }).slice(0, 60);
    } catch (_) {}
    return w;
  }
  /** 前客の欲しかった物と今客の欲しい物の差（外す候補・共通） */
  function _wantDiff(prevW, curW) {
    var out = { dropWards: [], dropStations: [], keep: 0 };
    try {
      if (!prevW) return out;
      var cw = (curW && curW.wards) || [], cs = (curW && curW.stations) || [];
      (prevW.wards || []).forEach(function (c) { if (cw.indexOf(c) < 0) out.dropWards.push(c); else out.keep++; });
      (prevW.stations || []).forEach(function (s) { if (cs.indexOf(s) < 0) out.dropStations.push(s); else out.keep++; });
    } catch (_) {}
    return out;
  }
  function _ledgerReset() {
    _axLedgerAcc = { stations: 0, lines: 0, wards: 0, towns: 0, layouts: 0, structured: 0, pet: 0, shikirei: 0, names: {} };
  }
  function _ledgerLoad() {
    try {
      var raw = window.sessionStorage && window.sessionStorage.getItem(_AX_LEDGER_KEY);
      if (!raw) return null;
      var L = JSON.parse(raw);
      if (!L || !L.n) return null;
      if (Date.now() - Number(L.at || 0) > 6 * 3600 * 1000) return null;
      return L;
    } catch (_) { return null; }
  }
  function _ledgerClear() {
    try { if (window.sessionStorage) window.sessionStorage.removeItem(_AX_LEDGER_KEY); } catch (_) {}
  }
  function _ledgerNames(arr, key) {
    try {
      (arr || []).forEach(function (t) {
        if (!t) return;
        var k = key + ":" + String(t).slice(0, 16);
        _axLedgerAcc.names[k] = 1;
      });
    } catch (_) {}
  }
  function _ledgerSave(why) {
    try {
      var s = _scanLeftoverForm();
      var pk = { ward: 0, station: 0 };
      try { pk = _pickedCounts(); } catch (_) {}
      var a = _axLedgerAcc;
      a.stations = Math.max(a.stations, s.stations, pk.station);
      a.lines = Math.max(a.lines, s.lines);
      a.wards = Math.max(a.wards, s.wards, pk.ward);
      a.towns = Math.max(a.towns, s.towns);
      a.layouts = Math.max(a.layouts, s.layouts);
      a.structured = Math.max(a.structured, s.structured);
      a.pet = Math.max(a.pet, s.pet);
      a.shikirei = Math.max(a.shikirei, s.shikirei ? 1 : 0);
      try { _ledgerNames(Object.keys(_axStationPicked).map(function (k) { return (_axStationPicked[k] || {}).text || k; }), "駅"); } catch (_) {}
      try { _ledgerNames(Object.keys(_axWardPicked).map(function (k) { return (_axWardPicked[k] || {}).text || k; }), "区"); } catch (_) {}
      try { _ledgerNames(_checkedLabelTexts("route_id[]"), "線"); } catch (_) {}
      var total = a.stations + a.lines + a.wards + a.towns + a.layouts + a.structured + a.pet + a.shikirei;
      if (total <= 0 || !window.sessionStorage) return;
      var L = {
        at: Date.now(),
        why: String(why || ""),
        cid: String(_axLedgerCid || (window._axFillRunningCustomerId || (typeof _fillCustomerId !== "undefined" ? _fillCustomerId : "")) || ""),
        n: { stations: a.stations, lines: a.lines, wards: a.wards, towns: a.towns, layouts: a.layouts, structured: a.structured, pet: a.pet, shikirei: a.shikirei },
        names: Object.keys(a.names).slice(0, 40),
        want: _axLedgerWant || null,
      };
      window.sessionStorage.setItem(_AX_LEDGER_KEY, JSON.stringify(L));
    } catch (_) {}
  }
  function _ledgerSaveSoon(why) {
    try {
      if (_axLedgerTimer) return;
      _axLedgerTimer = setTimeout(function () { _axLedgerTimer = null; _ledgerSave(why || "pick"); }, 1200);
    } catch (_) {}
  }
  function _planLeftover(s, wantMode, ledger) {
    s = s || {};
    var wantSt = wantMode === "station" || wantMode === "route";
    var wantWd = wantMode === "area";
    var placeSt = (s.stations || 0) + (s.lines || 0);
    var placeWd = (s.wards || 0) + (s.towns || 0);
    var mem = (ledger && ledger.n) || {};
    var memSt = (mem.stations || 0) + (mem.lines || 0);
    var memWd = (mem.wards || 0) + (mem.towns || 0);
    var memOnlySt = placeSt === 0 && memSt > 0;
    var memOnlyWd = placeWd === 0 && memWd > 0;
    if (memOnlySt) placeSt = memSt;
    if (memOnlyWd) placeWd = memWd;
    var prev = placeSt > 0 && placeWd > 0 ? "混在" : placeSt > 0 ? "駅" : placeWd > 0 ? "地域" : "なし";
    var want = wantWd ? "地域" : wantSt ? "駅" : "なし";
    var boxes = [];
    if (s.layouts > 0) boxes.push("間取り" + s.layouts);
    if (s.structured > 0) boxes.push("構造" + s.structured);
    if (s.pet > 0) boxes.push("絞込" + s.pet);
    if (s.shikirei) boxes.push("敷礼なし");
    var plan = {
      prev: prev,
      want: want,
      transition: prev + "→" + want,
      clearStations: placeSt > 0 && !wantSt,
      clearWards: placeWd > 0 && !wantWd,
      sameKindPlace: (placeSt > 0 && wantSt) || (placeWd > 0 && wantWd),
      memOnlyStations: memOnlySt && !wantSt,
      memOnlyWards: memOnlyWd && !wantWd,
      boxes: boxes,
      soft: (s.selects || []).concat(s.texts || []),
    };
    plan.dirty = plan.clearStations || plan.clearWards || boxes.length > 0;
    var parts = [];
    if (placeSt > 0) parts.push(memOnlySt ? "駅・沿線(覚えのみ)" + memSt : "駅" + (s.stations || 0) + "・沿線" + (s.lines || 0));
    if (placeWd > 0) parts.push(memOnlyWd ? "区・町(覚えのみ)" + memWd : "区" + (s.wards || 0) + "・町" + (s.towns || 0));
    boxes.forEach(function (b) { parts.push(b); });
    if (plan.soft.length) parts.push("選択/文字" + plan.soft.length);
    var out = [];
    if (plan.clearStations) out.push("駅・沿線");
    if (plan.clearWards) out.push("区・町");
    if (plan.sameKindPlace) out.push("同種の場所は入れ直しで");
    boxes.forEach(function (b) { out.push(b); });
    var named = "";
    try { if (ledger && ledger.names && ledger.names.length) named = " 入れた控え[" + ledger.names.slice(0, 12).join("・") + "]"; } catch (_) {}
    plan.summary = "前客" + plan.transition + " 残[" + (parts.join("・") || "なし") + "] 外す[" + (out.join("・") || "なし") + "]" + named;
    return plan;
  }
  /**
   * ★ 2026-11-19 竹内さん「最大3回って形だと残ってしまう可能性がある」→ 統括Pro 案A（回数上限をやめ進捗型）:
   *   外しの完了線 **F57（外し完了関所）** ＝ 台帳の名前の残り0 ∧ 画面の残り一覧0 ∧ 混在印0。
   *   旧は外し直しを「最大3回」で打ち切り、残っていても関所へ進んでいた（#1532: 駅5・沿線1が残ったまま区へ→混在→止まった）。
   *   → 外し終えた後の残り数が**前回より減っていれば続ける**（回数制限なし）。
   *     **2回続けて1件も減らなければ**別経路（閉じて少し待って開き直す）へ。別経路でも2回減らなければ「外し切れず」。
   *     全体の安全上限は**時間**（既定 150 秒・列が動いている間だけ数える）。回数ではない。
   */
  function _leftoverProgressNew(left0, nowTick) {
    return { prev: Number(left0) || 0, flat: 0, alt: 0, route: "normal", rounds: 0, t0: Number(nowTick) || 0, budget: 150000 };
  }
  /**
   * 外した後の残り数（left）から次の動きを決める純関数。
   * @returns {{action:"done"|"continue"|"alt"|"stuck", why:string}}
   *   done=残り0／continue=もう一度外す（減った・進捗なし1回目）／alt=別経路へ切り替えて外す／stuck=外し切れず（理由付き）
   */
  function _leftoverProgressStep(prog, left, nowTick) {
    prog.rounds = (prog.rounds || 0) + 1;
    left = Number(left) || 0;
    if (left <= 0) return { action: "done", why: "残り0" };
    var el = (Number(nowTick) || 0) - (prog.t0 || 0);
    if (el > (prog.budget || 150000)) return { action: "stuck", why: "時間上限" + Math.round((prog.budget || 150000) / 1000) + "秒" };
    if (left < prog.prev) {
      var was = prog.prev;
      prog.prev = left;
      prog.flat = 0;
      return { action: "continue", why: "残" + was + "→" + left + "（減った→続ける）", progressed: true };
    }
    prog.flat = (prog.flat || 0) + 1;
    if (prog.flat >= 2) {
      if (!prog.alt) {
        prog.alt = 1;
        prog.flat = 0;
        prog.route = "alt";
        return { action: "alt", why: "進捗なし2回（残" + left + "）→別経路（閉じて少し待って開き直す）" };
      }
      return { action: "stuck", why: "進捗なし2回→別経路でも減らず（残" + left + "）" };
    }
    return { action: "continue", why: "進捗なし" + prog.flat + "回（残" + left + "）" };
  }
  /**
   * 台帳（入れた控え）の名前のうち、画面の checked ラベルにまだ残っている名前を返す（名前単位の残り判定）。
   * names は "駅:梅田"・"区:北区"・"線:御堂筋線" の形（_ledgerNames が 16 文字に切る）。texts は種類ごとの checked ラベル文字。
   * kinds を渡すとその種類（今回外す側）だけ見る。
   */
  function _ledgerNamesLeft(names, texts, kinds) {
    var norm = function (t) { return String(t || "").replace(/\s+/g, "").replace(/駅$/, ""); };
    var out = [];
    (names || []).forEach(function (n) {
      var s = String(n || "");
      var i = s.indexOf(":");
      if (i < 0) return;
      var kind = s.slice(0, i);
      var nm = norm(s.slice(i + 1));
      if (!nm) return;
      if (kinds && kinds.indexOf(kind) < 0) return;
      var pool = (texts && texts[kind]) || [];
      for (var j = 0; j < pool.length; j++) {
        var t = norm(pool[j]);
        if (!t) continue;
        if (t === nm || (nm.length >= 2 && t.indexOf(nm) >= 0) || (t.length >= 2 && nm.indexOf(t) >= 0)) { out.push(s); break; }
      }
    });
    return out;
  }
  /**
   * F57 外し完了関所の判定（純関数）: 今回外す側の画面の残り0 ∧ 台帳の名前の残り0 ∧ 混在印0。
   *   p は外した後の _planLeftover（clearStations／clearWards が「まだ外す側が残っている」の意味）。
   */
  function _f57Judge(s, p, namesLeft) {
    s = s || {}; p = p || {};
    var stLeft = p.clearStations ? (s.stations || 0) + (s.lines || 0) : 0;
    var wdLeft = p.clearWards ? (s.wards || 0) + (s.towns || 0) : 0;
    var mixed = p.prev === "混在" ? 1 : 0;
    var nl = namesLeft || [];
    return { done: stLeft === 0 && wdLeft === 0 && nl.length === 0 && mixed === 0, stLeft: stLeft, wdLeft: wdLeft, mixed: mixed, names: nl.length };
  }
  function _leftoverStuckText(s, why) {
    s = s || {};
    return "残 駅" + (s.stations || 0) + "・沿線" + (s.lines || 0) + "・区" + (s.wards || 0) + "・町" + (s.towns || 0) + "（" + String(why || "外し切れず").slice(0, 60) + "）";
  }
  /** 汚れたまま検索に進まず、このお客さんの入力をきれいに中止する（fill-done の error 頭＝ "leftover_stuck:"・background が error_kind にする） */
  function _leftoverAbort(msg) {
    try { window.__axlxLeftoverWhy = ""; } catch (_) {}
    try { showWarnToast(String(msg).replace(/^leftover_stuck:\s*/, "")); } catch (_) {}
    try { notifyDone(String(msg)); } catch (_) {}
  }
  /** 台帳の名前に当たる checked の項目（今見えている物だけ）。モーダルが閉じて見えない物は専用の外し（開く→外す）が担当 */
  function _leftoverNamedInputs(names, kinds) {
    var out = [];
    try {
      [["駅", "station_id[]"], ["線", "route_id[]"], ["区", "city_code[]"], ["区", "town_code[]"]].forEach(function (m) {
        if (kinds && kinds.indexOf(m[0]) < 0) return;
        var inputs = document.querySelectorAll('input[name="' + m[1] + '"]:checked');
        Array.prototype.forEach.call(inputs, function (inp) {
          var l = (inp.closest && inp.closest("label")) || inp.parentElement;
          var t = l ? (l.textContent || "").replace(/\s+/g, "").slice(0, 24) : "";
          var texts = {}; texts[m[0]] = [t];
          if (!_ledgerNamesLeft(names, texts, [m[0]]).length) return;
          var hit = null;
          try { hit = _labelForCheckbox(inp); } catch (_) { hit = null; }
          if (hit && !isVisible(hit)) return;
          out.push(inp);
        });
      });
    } catch (_) {}
    return out;
  }
  /** 台帳の名前の項目だけを1つずつ（カーソル経由・直書き checked=false 禁止）外す。終わったら done(外した件数) */
  function _leftoverSweepNames(names, kinds, done) {
    var list = _leftoverNamedInputs(names, kinds);
    if (!list.length) { try { done(0); } catch (_) {} return; }
    try { if (_audit) _auditStepP("leftover_progress", "台帳の名前に当たる残り" + list.length + "件を1つずつ外す"); } catch (_) {}
    list.forEach(function (cb) { try { _toggleCheckboxLikeHuman(cb, false); } catch (_) {} });
    try {
      whenClickQueueIdle(function () { try { done(list.length); } catch (_) {} });
    } catch (_) { try { done(list.length); } catch (_e) {} }
  }
  /**
   * 前客の条件を外した直後の「きれいか」関所。場所の残りは専用の外し（進捗型・回数制限なし／F57 で完了確認）、
   * チェック類（間取り・構造・絞り込み・敷礼）の残りは外し全体を1回だけやり直す。
   * 場所が外し切れなかった時は**汚れたまま検索せず** leftover_stuck で中止する（旧は関所へ進み、混在→やり直し→止まった）。
   * セレクト・文字の残りは新条件で上書きされるのでやり直さない（外し切れない欄で時間を捨てない）。
   */
  function _cleanStartGate(cond, round, proceed, redo) {
    var finished = false;
    var mode = "none";
    try { mode = _axWantPlaceMode(cond); } catch (_) {}
    var go = function () {
      if (finished) return;
      finished = true;
      try { clearTimeout(guard); } catch (_) {}
      try { proceed(); } catch (_) {}
    };
    var abortStuck = function (s2, why) {
      if (finished) return;
      finished = true;
      try { clearTimeout(guard); } catch (_) {}
      var txt = _leftoverStuckText(s2, why);
      try { window.__axlxLedgerForceOpenSt = false; } catch (_) {}
      try { if (_audit) _auditStepP("leftover_stuck", txt); } catch (_) {}
      try { _leftoverAbort("leftover_stuck: 前のお客さんの条件を外し切れず中止（汚れたまま検索しない） " + txt); } catch (_) {}
    };
    var guard = setTimeout(function () {
      if (finished) return;
      var s9 = null, p9 = null;
      try { s9 = _scanLeftoverForm(); p9 = _planLeftover(s9, mode, null); } catch (_) {}
      if (p9 && (p9.clearStations || p9.clearWards)) { abortStuck(s9, "きれい確認が200秒終わらず・時間上限"); return; }
      try { if (_audit) _auditStepP("leftover_gate_timeout", "きれい確認が200秒終わらず→そのまま進む（関所が見る）"); } catch (_) {}
      go();
    }, 200000);
    try { window.__axlxLeftoverWhy = ""; } catch (_) {}
    var ledger = null;
    try { ledger = round ? null : (window.__axlxPrevLedger || null); } catch (_) { ledger = null; }
    var s = _scanLeftoverForm();
    var p = _planLeftover(s, mode, ledger);
    try { if (_audit) _auditStepP(round ? "leftover_rescan" : "leftover_after_clear", p.summary + (round ? "（やり直し" + round + "回目）" : "")); } catch (_) {}
    if (!p.dirty) {
      try { if (_audit) _auditStepP("leftover_clean", "きれい確認OK（" + p.transition + (p.sameKindPlace ? "・同種の場所は入れ直し" : "") + "）"); } catch (_) {}
      try { if (!p.sameKindPlace) { window.__axlxPrevLedger = null; _ledgerClear(); } } catch (_) {}
      go();
      return;
    }
    if (p.memOnlyStations) {
      try {
        window.__axlxLedgerForceOpenSt = true;
        if (_audit) _auditStepP("leftover_ledger_open", "画面には見えないが前客が駅・沿線を入れた控えあり→沿線・駅を開いて確かめて外す");
      } catch (_) {}
    }
    var kinds = [];
    if (p.clearStations) kinds.push("駅", "線");
    if (p.clearWards) kinds.push("区");
    var swept = false;
    var afterPlace = function () {
      try { window.__axlxLedgerForceOpenSt = false; } catch (_) {}
      if (finished) return;
      var s2 = _scanLeftoverForm();
      var p2 = _planLeftover(s2, mode, null);
      if (p2.boxes.length > 0 && round < 1 && typeof redo === "function") {
        try { if (_audit) _auditStepP("leftover_redo", "チェックが残る " + p2.boxes.join("・") + "→外しをもう一度"); } catch (_) {}
        finished = true;
        try { clearTimeout(guard); } catch (_) {}
        redo();
        return;
      }
      // F57: 台帳の名前の残り（画面の checked ラベルと突き合わせ）
      var ledNames = [];
      try { var _L = window.__axlxPrevLedger || ledger; ledNames = (_L && _L.names) || []; } catch (_) { ledNames = []; }
      var namesLeft = [];
      try {
        namesLeft = _ledgerNamesLeft(ledNames, {
          "駅": _checkedLabelTexts("station_id[]"),
          "線": _checkedLabelTexts("route_id[]"),
          "区": _checkedLabelTexts("city_code[]").concat(_checkedLabelTexts("town_code[]")),
        }, kinds);
      } catch (_) { namesLeft = []; }
      var f57 = _f57Judge(s2, p2, namesLeft);
      if (!f57.done) {
        if (!swept && namesLeft.length > 0) {
          swept = true;
          _leftoverSweepNames(ledNames, kinds, function () { afterPlace(); });
          return;
        }
        var why = "";
        try { why = String(window.__axlxLeftoverWhy || ""); } catch (_) { why = ""; }
        abortStuck(s2, (why || "外し切れず") + (namesLeft.length ? " 台帳名残" + namesLeft.slice(0, 4).join("・") : ""));
        return;
      }
      var placeWasDirty = !!(p.clearStations || p.clearWards);
      if (placeWasDirty) {
        try { if (_audit) _auditStepP("leftover_done_F57", "外し完了線OK 台帳名0・画面残0・混在印0 " + p.transition); } catch (_) {}
      }
      try {
        if (_audit) _auditStepP(p2.dirty ? "leftover_unclean" : "leftover_clean", (p2.dirty ? "残りあり→関所へ " : "きれい確認OK ") + p2.summary);
      } catch (_) {}
      try { if (!p2.dirty || placeWasDirty) { window.__axlxPrevLedger = null; _ledgerClear(); } } catch (_) {}
      go();
    };
    var stepWard = function () {
      if (p.clearWards) _clearWardsBeforeStationThen(afterPlace, "前客の区・町を最初に外す");
      else afterPlace();
    };
    if (p.clearStations) _clearStationsBeforeWardThen(stepWard, "前客の駅・沿線を最初に外す");
    else stepWard();
  }
  /**
   * ★ 2026-11-19 竹内さん「入れたのを覚えていたら外せるので、完了したらちゃんと外すようにすれば問題ない。順番に行えば」→ 統括Pro 案B:
   *   送付が終わったお客さんの結果ページで、台帳（入れた控え）と画面の残りを突き合わせ、次のお客さんの開始時と同じ「外す」手順
   *   （場所なしの客＝駅・沿線→区・町の順・カーソル経由・進捗型）で外し、`post_send_clear` を監査に残す。
   *   ⚠ fail-open: 例外・120秒でも必ず done を呼ぶ（次客を止めない）。入力中（_axFillRunning）は何もしない（次客と衝突させない）。
   *   呼び出し: background.js の _postSendClearRealpro が executeScript(MAIN) で window.__axlxPostSendClearP() を呼ぶ
   *   （page-script は MAIN world で content.js の中継（編集禁止）に乗れないため）。次客開始時のきれい確認（_cleanStartGate）は安全網として残る。
   * @param {function} done done({ok, left, why?, skipped?})
   */
  function _postSendClear(done) {
    var finished = false;
    var fin = function (r) {
      if (finished) return;
      finished = true;
      try { clearTimeout(guard); } catch (_) {}
      try { window.__axlxPostSendClearRunning = false; } catch (_) {}
      try { done(r); } catch (_) {}
    };
    var guard = setTimeout(function () {
      try { if (_audit) _auditStepP("post_send_clear", "120秒終わらず→次客へ進む（fail-open）"); } catch (_) {}
      fin({ ok: false, left: -1, why: "timeout120" });
    }, 120000);
    try {
      // 入力中は何もしない（次客・別の入力と衝突させない）
      var busy = false;
      try { busy = !!window._axFillRunning; } catch (_) { busy = false; }
      if (busy) { fin({ ok: true, left: null, skipped: "fill_running" }); return; }
      if (window.__axlxPostSendClearRunning) { fin({ ok: true, left: null, skipped: "already_running" }); return; }
      window.__axlxPostSendClearRunning = true;
      var ledger = null;
      try { ledger = _ledgerLoad(); } catch (_) { ledger = null; }
      var s = _scanLeftoverForm();
      var p = _planLeftover(s, "none", ledger);
      try { if (_audit) _auditStepP("post_send_clear", "開始 " + p.summary); } catch (_) {}
      var placeN = function (x) { return (x.stations || 0) + (x.lines || 0) + (x.wards || 0) + (x.towns || 0); };
      if (!p.clearStations && !p.clearWards) {
        try { if (_audit) _auditStepP("post_send_clear", "場所の残りなし→外す物なし"); } catch (_) {}
        try { _ledgerClear(); window.__axlxPrevLedger = null; } catch (_) {}
        fin({ ok: true, left: 0 });
        return;
      }
      if (p.memOnlyStations) { try { window.__axlxLedgerForceOpenSt = true; } catch (_) {} }
      var after = function () {
        if (finished) return;
        try { window.__axlxLedgerForceOpenSt = false; } catch (_) {}
        var s2 = null;
        try { s2 = _scanLeftoverForm(); } catch (_) { s2 = {}; }
        var left = placeN(s2);
        try { if (_audit) _auditStepP("post_send_clear", (left === 0 ? "完了 " : "残りあり ") + _leftoverStuckText(s2, left === 0 ? "外し完了" : String(window.__axlxLeftoverWhy || "外し切れず"))); } catch (_) {}
        if (left === 0) { try { _ledgerClear(); window.__axlxPrevLedger = null; } catch (_) {} }
        fin({ ok: left === 0, left: left, why: left ? String(window.__axlxLeftoverWhy || "") : "" });
      };
      var stepWard = function () {
        if (p.clearWards) _clearWardsBeforeStationThen(after, "送付後の外し");
        else after();
      };
      var run = function () {
        try {
          if (p.clearStations) _clearStationsBeforeWardThen(stepWard, "送付後の外し");
          else stepWard();
        } catch (e) { fin({ ok: false, left: -1, why: "exception:" + String(e && e.message || e).slice(0, 60) }); }
      };
      // 結果ページは検索条件が畳まれているので、次客の _doReset と同じく先に「検索条件を表示」を押して開く
      var showBtn = null;
      try {
        var els = [].slice.call(document.querySelectorAll("a,button,div,span,td,p"));
        for (var i = 0; i < els.length; i++) {
          if (!els[i].offsetParent) continue;
          var t = (els[i].textContent || "").trim();
          if (t === "検索条件を表示" || t === "▼検索条件を表示" || t === "▶検索条件を表示") { showBtn = els[i]; break; }
        }
      } catch (_) { showBtn = null; }
      if (showBtn) {
        try {
          enqueueHumanClick(showBtn, _clickEl, _uiGapMin(), _uiGapMax(), null, _uiGapOpts());
          whenClickQueueIdle(function () { setTimeout(run, humanRand(900, 1500)); });
        } catch (_) { run(); }
      } else {
        run();
      }
    } catch (e) {
      fin({ ok: false, left: -1, why: "exception:" + String(e && e.message || e).slice(0, 60) });
    }
  }
  try {
    window.__axlxPostSendClear = function (done) { _postSendClear(typeof done === "function" ? done : function () {}); };
    // executeScript(world:"MAIN") が結果を待てるよう Promise 版も出す（background.js _postSendClearRealpro が使う）
    window.__axlxPostSendClearP = function () { return new Promise(function (resolve) { _postSendClear(resolve); }); };
  } catch (_) {}
  function _clearStationsBeforeWardThen(nextFn, why, round, progArg) {
    var _why = why || "所在地";
    var _round = Number(round) || 0;
    var clk = (progArg && progArg.clk) || _activeClock();
    /**
     * ★ 2026-11-19 竹内さん「駅のお客さんから地域のお客さんに移るとき必ず、駅と沿線外す…ちゃんと外して次に移る」:
     *   #1532 は前客の駅5・沿線1が残ったまま区へ進み、関所の混在→やり直し6回→人の操作で止まった。
     * ★ 2026-11-19 竹内さん「最大3回って形だと残ってしまう可能性がある」→ 統括Pro 案A（進捗型）:
     *   旧は開く→外す→確定を最大3回で打ち切っていた。→ 外した後の残り（駅＋沿線）が**前回より減っていれば続ける**（回数制限なし）。
     *   2回続けて減らなければ別経路（閉じて少し待って開き直す）へ・別経路でも減らなければ理由を残して終える
     *   （呼び出し側＝きれい確認の関所が、残りがあれば汚れたまま検索せず leftover_stuck で中止する）。全体の上限は時間（150秒）。
     */
    var prog = progArg || null;
    var _next = function () {
      var lx = _leftNow();
      var d = _leftoverProgressStep(prog, lx.st + lx.ln, clk.tick());
      if (d.action === "continue" || d.action === "alt") {
        try {
          if (_audit) {
            if (d.action === "alt") _auditStepP("leftover_alt_route", "駅・沿線 " + d.why);
            else if (d.progressed) _auditStepP("leftover_progress", "駅" + lx.st + "・沿線" + lx.ln + " " + d.why);
            else _auditStepP("station_clear_retry", (prog.rounds + 1) + "回目: 駅" + lx.st + "・沿線" + lx.ln + "が残る（" + d.why + "）→もう一度開いて外す");
          }
        } catch (_) {}
        setTimeout(function () { _clearStationsBeforeWardThen(nextFn, why, _round + 1, prog); }, _ln(700, 0.35, 400, 1300));
        return;
      }
      if (d.action === "stuck") {
        try { window.__axlxLeftoverWhy = "駅・沿線 " + d.why; } catch (_) {}
        try { if (_audit) _auditStepP("leftover_progress", "駅" + lx.st + "・沿線" + lx.ln + " 外し切れず終える（" + d.why + "）"); } catch (_) {}
      }
      try { nextFn(); } catch (_) {}
    };
    var _leftNow = function () {
      var st = 0, ln = 0;
      try { st = document.querySelectorAll('input[name="station_id[]"]:checked').length; } catch (_) { st = 0; }
      try { ln = document.querySelectorAll('input[name="route_id[]"]:checked').length; } catch (_) { ln = 0; }
      return { st: st, ln: ln };
    };
    var left0 = _leftNow();
    var _forceOpenSt = false;
    try { _forceOpenSt = !!window.__axlxLedgerForceOpenSt && _round === 0; window.__axlxLedgerForceOpenSt = false; } catch (_) {}
    if (!left0.st && !left0.ln && !_forceOpenSt) { try { nextFn(); } catch (_) {} return; }
    try {
      window.__axlxNeedClearStation = true;
      window.__axlxPlaceClearPhase = "start";
      window.__axlxPlaceClearGoAt = 0;
      window.__axlxPlaceClearBackTries = 0;
      window.__axlxPlaceClearBegan = false;
      window.__axlxPlaceClearBackSettled = false;
      window.__axlxPlaceClearBackSettleUntil = 0;
      window.__axlxStationForceClearedOnce = false;
      window.__axlxLineForceClearedOnce = false;
      if (_audit) _auditStepP("station_clear_before_ward", "駅残" + left0.st + "・沿線残" + left0.ln + "→沿線・駅で1つずつ外して確定してから" + _why + "へ");
    } catch (_) {}
    var phase = "open", openedAt = 0, reopenN = 0, confirmedAt = 0;
    if (!prog) { prog = _leftoverProgressNew(left0.st + left0.ln, clk.tick()); prog.clk = clk; }
    var altClosed = !prog.alt, altWaitUntil = 0;
    waitForClick(
      function () {
        try { if (isClickQueueBusy()) return false; } catch (_) {}
        var scr = null;
        try { scr = _graspStationModalScreen(); } catch (_) { scr = { kind: "unknown" }; }
        if (phase === "open") {
          /**
           * 別経路（2回続けて減らなかった時）: 開いたままのモーダルを一度閉じ、少し待ってから開き直す
           *   （画面の状態が変な形で固まっていても、開き直しで駅画面・沿線画面の状態機械を最初からやり直せる）。
           */
          if (!altClosed) {
            if (!altWaitUntil) {
              var dxa = null;
              try { dxa = document.querySelector("div.this_window_close"); } catch (_) { dxa = null; }
              if (dxa && isVisible(dxa) && scr.kind !== "closed") {
                enqueueHumanClick(dxa, _clickEl, _uiGapMin(), _uiGapMax(), null, _uiGapOpts());
                altWaitUntil = clk.tick() + _ln(2500, 0.3, 1500, 4500);
                return false;
              }
              altClosed = true;
            } else if (clk.tick() < altWaitUntil) {
              return false;
            } else {
              altClosed = true;
            }
          }
          if (scr.kind === "line_list" || scr.kind === "station_list") { phase = "clear"; return false; }
          if (!openedAt || (clk.tick() - openedAt > 6000 && reopenN < 2)) {
            if (openedAt) {
              reopenN++;
              try { if (_audit) _auditStepP("station_clear_open_retry", "沿線・駅絞り込みが開かない→押し直す（" + reopenN + "）"); } catch (_) {}
            }
            openedAt = clk.tick() || 1;
            var opened = false;
            try {
              var _stOp = _sidebarOpenerEl("沿線・駅絞り込み", _SIDEBAR_OTHER_RE);
              if (_stOp) {
                try { _markPanelOpened("station", "station_open"); } catch (_) {}
                _pressLearned(_stOp, ["左の沿線・駅絞り込み", "沿線・駅絞り込み＋", "沿線・駅絞り込み"], "station_open_before_ward");
                opened = true;
              }
            } catch (_) {}
            if (!opened) clickByText(["沿線・駅絞り込み＋", "沿線・駅絞り込み+", "沿線・駅絞り込み"]);
            return false;
          }
          if (clk.tick() - openedAt > 12000 && reopenN >= 2) { phase = "fail_open"; return true; }
          return false;
        }
        if (phase === "clear") {
          var done = false;
          try { done = _advanceForcePlaceClearViaStationFirst(); } catch (_) { done = true; }
          if (!done) return false;
          phase = "confirm";
          return false;
        }
        if (phase === "confirm") {
          if (scr.kind === "closed") return true;
          if (confirmedAt) return clk.tick() - confirmedAt > 2500;
          if (_pressConfirmListLikeHuman("駅外し後に確定→" + _why) || clickByText(["確定してリストへ", "この条件で絞り込む", "決定"])) {
            confirmedAt = clk.tick() || 1;
            try { if (_audit) _auditStepP("station_clear_confirm_before_ward", "駅・沿線を外した後に確定→" + _why); } catch (_) {}
            return false;
          }
          var dx = null;
          try { dx = document.querySelector("div.this_window_close"); } catch (_) { dx = null; }
          if (dx && isVisible(dx)) {
            enqueueHumanClick(dx, _clickEl, _uiGapMin(), _uiGapMax(), null, _uiGapOpts());
            confirmedAt = clk.tick() || 1;
            return false;
          }
          return true;
        }
        return true;
      },
      function () {
        var l2 = _leftNow();
        try { if (_audit) _auditStepP("station_clear_before_ward_done", (phase === "fail_open" ? "開けず" : "完了") + " 残 駅" + l2.st + "・沿線" + l2.ln); } catch (_) {}
        _next();
      },
      160, 450, 300,
      function () {
        var l3 = _leftNow();
        try { if (_audit) _auditStepP("station_clear_before_ward_timeout", "外し切れず phase=" + phase + " 残 駅" + l3.st + "・沿線" + l3.ln + "→" + _why + "へ（検索前の関所で再確認）"); } catch (_) {}
        _next();
      }
    );
  }

  /**
   * ★ 2026-11-17 通常連続録画正本01:34＋統括Pro continuous_switch:
   *   CLEAR区(one_city) → 確定してリストへ → 沿線・駅絞り込み＋ → SELECT沿線 → 駅の設定へ → 駅SELECT
   *   旧: `__axlxNeedClearWard` を立てるだけで**読んでいなかった** → 区が残ったまま駅へ。
   *   → 駅モーダルを開く前に、残区を所在地モーダルで1つずつ外して確定する。
   * ★ 2026-11-19 竹内さん「地域のところではあったタイムアウトの部分等」:
   *   旧は「所在地絞り込み」を1回押して 8秒で黙って諦め、区を残したまま駅へ進んでいた（#1479 open_timeout）。
   *   → 6秒で1回押し直し・14秒で諦める時は理由と残数を残す。見えない残（畳まれた町）だけになったら確定へ進む。
   *     関所（_axGateCheck）の区余りもこれで外す（setCheckboxes 空の直外しをやめる）。
   */
  /**
   * 区コードで入れ直す時も小窓を通す（直接チェック禁止）: 所在地絞り込み→大阪府→区を1つずつ→確定してリストへ。
   * 終わったら done(ok)。押せなくても done は必ず呼ぶ（呼び元が checked の数で判断する）。
   */
  function _areaFallbackViaModal(codes, done) {
    var want = (codes || []).map(String).filter(Boolean);
    var phase = "open", openedAt = 0, prefAt = 0, confirmedAt = 0, pickTicks = 0;
    var fin = false;
    var end = function (ok) { if (fin) return; fin = true; try { done(ok); } catch (_) {} };
    var allOn = want.length > 0 && want.every(function (c) {
      var i = document.querySelector('input[name="city_code[]"][value="' + c.replace(/"/g, "") + '"]');
      return !!(i && i.checked);
    });
    if (!want.length || allOn) { end(allOn); return; }
    try { _auditStepP("area_fallback_modal", "区" + want.length + "を小窓で1つずつ（直接チェックしない）"); } catch (_) {}
    waitForClick(
      function () {
        try { if (isClickQueueBusy()) return false; } catch (_) {}
        var g = null;
        try { g = _graspAreaModalScreen(); } catch (_) { g = { kind: "unknown" }; }
        if (phase === "open") {
          if (g.kind === "ward_list") { phase = "pick"; return false; }
          if (g.kind === "pref_list") {
            if (!prefAt || Date.now() - prefAt > 3500) { prefAt = Date.now(); clickByText(["大阪府"]); }
            return false;
          }
          if (g.kind === "town_list") {
            if (!prefAt || Date.now() - prefAt > 3500) { prefAt = Date.now(); clickByText(["市区郡の設定へ戻る", "市区郡の選択へ戻る", "市区郡を選び直す", "大阪府"]); }
            return false;
          }
          if (!openedAt || Date.now() - openedAt > 6000) {
            openedAt = Date.now();
            var op = null;
            try { op = _sidebarOpenerEl("所在地絞り込み", _SIDEBAR_OTHER_RE); } catch (_) { op = null; }
            if (op) _pressLearned(op, ["左の所在地絞り込み", "所在地絞り込み＋"], "area_open_fallback");
            else clickByText(["所在地絞り込み＋", "所在地絞り込み+", "所在地絞り込み"]);
          }
          return false;
        }
        if (phase === "pick") {
          pickTicks++;
          var n = 0;
          want.forEach(function (code) {
            var inp = document.querySelector('input[name="city_code[]"][value="' + code.replace(/"/g, "") + '"]');
            if (!inp || inp.checked) return;
            var h = _labelForCheckbox(inp);
            if (!h || !isVisible(h)) return;
            _toggleCheckboxLikeHuman(inp, true);
            n++;
          });
          if (n && pickTicks < 12) return false;
          phase = "confirm";
          return false;
        }
        if (phase === "confirm") {
          if (confirmedAt) return Date.now() - confirmedAt > 800;
          if (_pressConfirmListLikeHuman("所在地フォールバック確定")) { confirmedAt = Date.now(); return false; }
          return true;
        }
        return true;
      },
      function () { end(true); },
      90, 450, 300,
      function () {
        try { _auditStepP("area_fallback_modal_timeout", "phase=" + phase); } catch (_) {}
        end(false);
      }
    );
  }
  function _clearWardsBeforeStationThen(nextFn, why, round, progArg) {
    var _why = why || "駅";
    var _round = Number(round) || 0;
    var prog = progArg || null;
    var _wardLeft = function () {
      try { return document.querySelectorAll('input[name="city_code[]"]:checked, input[name="town_code[]"]:checked').length; } catch (_) { return 0; }
    };
    var cityLeft = _wardLeft();
    var needWard = false;
    try { needWard = !!(window.__axlxNeedClearWard) || cityLeft > 0; } catch (_) { needWard = cityLeft > 0; }
    if (!needWard) {
      try { nextFn(); } catch (_) {}
      return;
    }
    try {
      if (_audit) _auditStepP("ward_clear_before_station", "区残" + cityLeft + "→所在地で外してから" + _why + "へ（連続客正本）");
      console.log("[AX] 連続客: 残区を外してから" + _why + "へ", cityLeft);
    } catch (_) {}

    var phase = "open";
    var openedAt = 0;
    var reopenN = 0;
    var clearedAt = 0;
    var confirmedAt = 0;
    var hiddenOnlySince = 0;
    var townStepTried = false;
    var prefPressedAt = 0;
    var wardBackTried = 0;
    var clk = (progArg && progArg.clk) || _activeClock();
    if (!prog) { prog = _leftoverProgressNew(cityLeft, clk.tick()); prog.clk = clk; }
    var altClosed = !prog.alt, altWaitUntil = 0;
    var hiddenLeftSeen = false;
    var _finish = function (how) {
      /**
       * ★ 2026-11-19 竹内さん「地域のお客さんから駅に移る場合もちゃんとここの部分外す」:
       *   開けなかった・時間切れ・外したのに区/町が残っている時は開く→外す→確定をやり直す。
       * ★ 2026-11-19 竹内さん「最大3回って形だと残ってしまう可能性がある」→ 統括Pro 案A（進捗型）:
       *   旧は最大3回で打ち切り。→ 残り（区＋町）が**前回より減っていれば続ける**（回数制限なし）。
       *   2回続けて減らなければ別経路（閉じて少し待って開き直す）・別経路でも減らなければ理由を残して終える
       *   （きれい確認の関所が、残りがあれば汚れたまま検索せず leftover_stuck で中止する）。全体の上限は時間（150秒）。
       */
      var _wl = _wardLeft();
      var d = _leftoverProgressStep(prog, _wl, clk.tick());
      // 見えない残（畳まれた町）だけを確定して終えた時は、カーソルで外せないので回し直さない（旧と同じ）。残りはきれい確認の関所が判定する
      if (how === "完了" && _wl > 0 && hiddenLeftSeen) {
        d = { action: "stuck", why: "見えない残" + _wl + "（区/町の一覧に出せず・戻る" + wardBackTried + "回・カーソルで外せない）" };
      }
      if (d.action === "continue" || d.action === "alt") {
        try {
          if (_audit) {
            if (d.action === "alt") _auditStepP("leftover_alt_route", "区・町 " + d.why);
            else if (d.progressed) _auditStepP("leftover_progress", "区/町" + _wl + " " + d.why);
            else _auditStepP("ward_clear_retry", (prog.rounds + 1) + "回目: 区/町" + _wl + "が残る（" + how + "・" + d.why + "）→もう一度開いて外す");
          }
        } catch (_) {}
        setTimeout(function () { _clearWardsBeforeStationThen(nextFn, why, _round + 1, prog); }, _ln(700, 0.35, 400, 1300));
        return;
      }
      if (d.action === "stuck") {
        try { window.__axlxLeftoverWhy = "区・町 " + d.why; } catch (_) {}
        try { if (_audit) _auditStepP("leftover_progress", "区/町" + _wl + " 外し切れず終える（" + d.why + "）"); } catch (_) {}
      }
      try { window.__axlxNeedClearWard = false; } catch (_) {}
      try { if (_audit) _auditStepP("ward_clear_before_station_done", how + " 残 区/町" + _wardLeft() + "→" + _why); } catch (_) {}
      try { nextFn(); } catch (_) {}
    };
    waitForClick(
      function () {
        try { if (isClickQueueBusy()) return false; } catch (_) {}
        var cityNow = _wardLeft();
        var cityVis = Array.prototype.slice.call(document.querySelectorAll("label.one_city, label.one_town")).filter(isVisible);

        if (phase === "open") {
          // 別経路（2回続けて減らなかった時）: 開いたままのモーダルを一度閉じ、少し待ってから開き直す
          if (!altClosed) {
            if (!altWaitUntil) {
              var dxw = null;
              try { dxw = document.querySelector("div.this_window_close"); } catch (_) { dxw = null; }
              if (dxw && isVisible(dxw) && cityVis.length > 0) {
                enqueueHumanClick(dxw, _clickEl, _uiGapMin(), _uiGapMax(), null, _uiGapOpts());
                altWaitUntil = clk.tick() + _ln(2500, 0.3, 1500, 4500);
                return false;
              }
              altClosed = true;
            } else if (clk.tick() < altWaitUntil) {
              return false;
            } else {
              altClosed = true;
            }
          }
          /**
           * ★ 2026-11-20 竹内さん「前のお客さんの条件も外すことちゃんとできていない…押したのを外したらよいだけ」:
           *   旧は `div.this_window_close, .this_window` が DOM に在るだけで「開いた」とみなし、小窓を開かずに外しへ進んでいた
           *   （閉じた小窓の区は見えない→「見えない残3（畳まれた町）」で中止・台帳には福島区・西区・淀川区と残っていた）。
           *   → 画面を読んで決める: 区/町の一覧が見える＝外しへ／都道府県の画面＝大阪府を押して区の一覧へ／それ以外＝所在地絞り込みを押して開く。
           */
          var _ga = null;
          try { _ga = _graspAreaModalScreen(); } catch (_) { _ga = { kind: "unknown" }; }
          if (cityVis.length > 0 || _ga.kind === "ward_list" || _ga.kind === "town_list") {
            phase = "clear";
            return false;
          }
          if (cityNow <= 0) return true;
          if (_ga.kind === "pref_list") {
            if (!prefPressedAt || clk.tick() - prefPressedAt > 3500) {
              prefPressedAt = clk.tick() || 1;
              if (clickByText(["大阪府"])) {
                try { if (_audit) _auditStepP("ward_clear_pref", "都道府県の画面→大阪府を押して区の一覧へ（前客の区を外すため）"); } catch (_) {}
              }
            }
            return false;
          }
          if (!openedAt || (clk.tick() - openedAt > 6000 && reopenN < 1)) {
            if (openedAt) {
              reopenN++;
              try { if (_audit) _auditStepP("ward_clear_open_retry", "所在地絞り込みが開かない→押し直す"); } catch (_) {}
            }
            openedAt = clk.tick() || 1;
            if (!clickByText(["所在地絞り込み＋", "所在地絞り込み+", "所在地絞り込み"])) {
              try {
                var _arOp = _sidebarOpenerEl("所在地絞り込み", _SIDEBAR_OTHER_RE);
                if (_arOp) _pressLearned(_arOp, ["左の所在地絞り込み", "所在地絞り込み＋"], "area_open_before_st");
              } catch (_) {}
            }
            return false;
          }
          if (clk.tick() - openedAt > 14000) {
            phase = "fail_open";
            return true;
          }
          return false;
        }

        if (phase === "clear") {
          if (cityNow <= 0) {
            phase = "confirm";
            return false;
          }
          if (!clearedAt || clk.tick() - clearedAt > 400) {
            clearedAt = clk.tick();
            var n = 0;
            Array.prototype.slice.call(document.querySelectorAll('input[name="city_code[]"]:checked, input[name="town_code[]"]:checked'))
              .forEach(function (cb) {
                var hit = _labelForCheckbox(cb);
                if (hit && !isVisible(hit)) return;
                _toggleCheckboxLikeHuman(cb, false);
                n++;
              });
            if (n && _audit) {
              _auditStepP("ward_clear_cursor", "区/町" + n + "を1つずつ外す（" + _why + "の前）");
              try { _noteClearMethod("ward", "cursor_one_by_one", _why + "前に区" + n); } catch (_) {}
            }
            if (!n) {
              if (!hiddenOnlySince) hiddenOnlySince = clk.tick() || 1;
              /**
               * ★ 2026-11-20: 見えない残りが**区**（city_code）の時は町の画面へ進まない（逆方向）。
               *   都道府県の画面なら大阪府を押す／町の画面なら区の一覧へ戻る（戻るボタン・大阪府の道しるべ）を1つずつ押す。
               */
              var _hidWard = 0, _hidTown = 0;
              try {
                Array.prototype.forEach.call(document.querySelectorAll('input[name="city_code[]"]:checked'), function (cb) { var h = _labelForCheckbox(cb); if (!h || !isVisible(h)) _hidWard++; });
                Array.prototype.forEach.call(document.querySelectorAll('input[name="town_code[]"]:checked'), function (cb) { var h = _labelForCheckbox(cb); if (!h || !isVisible(h)) _hidTown++; });
              } catch (_) {}
              var _gc = null;
              try { _gc = _graspAreaModalScreen(); } catch (_) { _gc = { kind: "unknown" }; }
              if ((_hidWard > 0 || _hidTown > 0) && _gc.kind === "closed" && reopenN < 2) {
                reopenN++;
                phase = "open";
                openedAt = 0;
                hiddenOnlySince = 0;
                try { if (_audit) _auditStepP("leftover_ward_reopen", "小窓が閉じている・見えない区/町" + (_hidWard + _hidTown) + "→所在地絞り込みを開き直す"); } catch (_) {}
                return false;
              }
              if (_hidWard > 0 && wardBackTried < 3 && clk.tick() - hiddenOnlySince > 500 && (_gc.kind === "pref_list" || _gc.kind === "town_list")) {
                wardBackTried++;
                var _backOk = false;
                if (_gc.kind === "pref_list") {
                  _backOk = clickByText(["大阪府"]);
                } else {
                  _backOk = clickByText(["市区郡の設定へ戻る", "市区郡の選択へ戻る", "市区郡を選び直す", "市区郡の設定に戻る", "地域の設定へ戻る", "大阪府"]);
                }
                hiddenOnlySince = 0;
                try {
                  if (_audit) _auditStepP("leftover_ward_back", "見えない区" + _hidWard + "（" + _gc.kind + "）→区の一覧へ" + (_backOk ? "押した" : "押せる物なし") + "#" + wardBackTried);
                } catch (_) {}
                return false;
              }
              if (_hidWard > 0 && _hidTown === 0) townStepTried = true;
              /**
               * ★ 2026-11-19 (2.8.125) 竹内さん「一連の流れに入れたらよいだけ」:
               *   見えない残 = 町の一覧（town_list）にだけ在る町。区の画面では見えず外せなかった（→確定して進み関所で中止）。
               *   → 「詳細な地域の設定へ進む」(div.next_step_button2) をカーソルで1回押して町の画面へ入り、
               *     出た町を1つずつ外す（上の処理がそのまま働く）。1回だけ・押せなければ従来どおり。
               */
              if (!townStepTried && clk.tick() - hiddenOnlySince > 600) {
                var _nx = null;
                try { _nx = document.querySelector("div.next_step_button2"); } catch (_) { _nx = null; }
                if (_nx && isVisible(_nx)) {
                  townStepTried = true;
                  try { enqueueHumanClick(_nx, _clickEl, _uiGapMin(), _uiGapMax(), null, _uiGapOpts()); } catch (_) {}
                  hiddenOnlySince = 0;
                  try { if (_audit) _auditStepP("leftover_town_step", "見えない町" + cityNow + "→詳細地域へ進んで外す（" + _why + "の前）"); } catch (_) {}
                  return false;
                }
              }
              if (clk.tick() - hiddenOnlySince > 3000) {
                try { if (_audit) _auditStepP("ward_clear_hidden_left", "見えない残の区/町" + cityNow + "だけ→確定して進む（関所で再確認）"); } catch (_) {}
                hiddenLeftSeen = true;
                phase = "confirm";
              }
            } else {
              hiddenOnlySince = 0;
            }
          }
          return false;
        }

        if (phase === "confirm") {
          if (confirmedAt && clk.tick() - confirmedAt > 600) return true;
          if (!confirmedAt) {
            if (_pressConfirmListLikeHuman("区外し後に確定→" + _why) || clickByText(["確定してリストへ", "この条件で絞り込む", "決定"])) {
              confirmedAt = clk.tick() || 1;
              try { if (_audit) _auditStepP("ward_clear_confirm", "区外し後に確定→" + _why); } catch (_) {}
            } else {
              return true;
            }
          }
          return false;
        }
        return true;
      },
      function () {
        _finish(phase === "fail_open" ? "開けず" : "完了");
      },
      120,
      450,
      300,
      function () {
        try { if (_audit) _auditStepP("ward_clear_before_station_timeout", "外し切れず phase=" + phase); } catch (_) {}
        _finish("時間切れ");
      },
    );
  }

  /**
   * ★ 2026-11-19 #1463「指定の駅が選択できませんでした 駅: 堀江・新町・桜川・西長堀」:
   *   駅の一覧に**載っていない名前**（堀江・新町＝地名）も「1つ以上選ぶ」数に入れていたので、
   *   他の駅を選び終えても完了にならず、約50秒で検索ごと止めていた（一覧に無い名前を飛ばすのは「0駅の時だけ」だった）。
   *   → 一覧が出て 2.5秒そのまま（入力の数が変わらない）なら、一覧に無い名前を「選べない名前」として数から外す。
   *     一覧に在る名前が0なら空を返さない（全部無い＝今まで通り止める・全件検索にしない）。
   */
  function _stationNamesAbsentStable(names) {
    var want = (names || []).map(function (s) { return String(s || "").replace(/駅$/, "").trim(); }).filter(Boolean);
    if (!want.length) return [];
    var inputs = [];
    try { inputs = Array.prototype.slice.call(document.querySelectorAll('input[name="station_id[]"]')); } catch (_) { inputs = []; }
    var visN = 0;
    var texts = [];
    inputs.forEach(function (inp) {
      var lab = null;
      try { lab = _labelForCheckbox(inp) || inp.parentElement; } catch (_) { lab = inp.parentElement; }
      if (lab && isVisible(lab)) visN++;
      texts.push(String((lab && lab.textContent) || ""));
    });
    if (!inputs.length || !visN) { try { window.__axlxStListSig = null; } catch (_) {} return []; }
    var now = Date.now();
    var sig = inputs.length + ":" + visN;
    try {
      var prev = window.__axlxStListSig;
      if (!prev || prev.sig !== sig) { window.__axlxStListSig = { sig: sig, since: now }; return []; }
      if (now - prev.since < 2500) return [];
    } catch (_) { return []; }
    var absent = want.filter(function (c) {
      return !texts.some(function (t) { return _stationNameMatch(t, c); });
    });
    if (absent.length >= want.length) return [];
    try {
      if (absent.length && !window.__axlxStAbsentSent) {
        window.__axlxStAbsentSent = true;
        if (_audit) _auditStepP("station_name_absent", "駅の一覧に無い名前=" + absent.join("・").slice(0, 80) + "（地名・沿線の選び漏れ？）→飛ばして選べる駅で進む 一覧" + inputs.length);
      }
    } catch (_) {}
    return absent;
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
      /**
       * ★ 2026-11-17 DB実測 AREA_MISMATCH 欲しい9・入った8・足りない1（西淀川など画面外）:
       *   旧は未選択を一括キュー → スクロールが追いつかず1区欠ける。
       *   → **未選択の先頭1区だけ**中央へ寄せて押す。残りは verify ループが再呼出し。
       */
      /**
       * ★ 2026-11-18 竹内さん「直接入力しない／外す場合も選択して外す」:
       *   欲しくない区が checked のまま残っていると「勝手に入力された」ように見える。
       *   → 余分な区は **先頭1つだけ** labelクリックで外す（checked=false 直書き禁止）。
       */
      try {
        var wantSet = {};
        var wantAll = (window.__axlxWardWantAll && window.__axlxWardWantAll.length) ? window.__axlxWardWantAll : codes;
        for (var wi = 0; wi < wantAll.length; wi++) wantSet[String(wantAll[wi])] = true;
        var extras = Array.prototype.slice.call(document.querySelectorAll('input[name="city_code[]"]:checked'));
        for (var ei = 0; ei < extras.length; ei++) {
          if (wantSet[String(extras[ei].value)]) continue;
          _toggleCheckboxLikeHuman(extras[ei], false, 620, 1400, { quick: true });
          try { if (_audit) _auditStepP("ward_extra_clear_click", String(extras[ei].value || "").slice(0, 24)); } catch (_) {}
          return true; // 1回1外し（カーソル徹底）
        }
      } catch (_) {}
      var already = 0;
      var target = null;
      /**
       * ★ 2026-11-18 平田 通常録画: 人は 都島→北→中央→福島→西→天王寺→浪速→淀川→西淀川 と
       *   **画面の並び順**（左上から）に1区ずつ押す（間隔0.8〜2.2秒・外しは0回）。
       *   自動はお客様の書いた順で画面を行き来していた → 画面の並び順に並べ替えて押す。
       */
      try {
        var _domOrder = {};
        var _allCity = document.querySelectorAll('input[name="city_code[]"]');
        for (var di = 0; di < _allCity.length; di++) {
          var _dv = String(_allCity[di].value);
          if (_domOrder[_dv] == null) _domOrder[_dv] = di;
        }
        codes = codes.slice().sort(function (a, b) {
          var ia = _domOrder[String(a)], ib = _domOrder[String(b)];
          if (ia == null && ib == null) return 0;
          if (ia == null) return 1;
          if (ib == null) return -1;
          return ia - ib;
        });
      } catch (_) {}
      for (var ci2 = 0; ci2 < codes.length; ci2++) {
        var c2 = document.querySelector('input[name="city_code[]"][value="' + String(codes[ci2]) + '"]');
        if (!c2) continue;
        var lb2 = (c2.closest && c2.closest('label')) || c2.parentElement || c2;
        if (c2.checked) { already++; _noteWardPicked(codes[ci2], lb2.textContent); continue; }
        if (!target) target = { c: c2, lb: lb2, code: codes[ci2] };
      }
      if (target) {
        try {
          if (target.lb && target.lb.scrollIntoView) {
            target.lb.scrollIntoView({
              behavior: Math.random() < 0.85 ? "smooth" : "auto",
              block: Math.random() < 0.7 ? "center" : "nearest",
              inline: "nearest",
            });
          }
        } catch (_) {}
        try { if (_audit) _auditStepP("ward_scroll_select", String(target.code) + " 済" + already + "/" + codes.length); } catch (_) {}
        /**
         * ★ 2026-11-14 竹内さん「所在地の部分も一気に押すのではなくて一つずつカーソル動かして押すようにする」
         * ★ 2026-11-16 細分化: DBでは人が `label.one_city` を押す。input 直ではなく label。
         */
        try {
          var _selN = window.__axlxWardSelN || (window.__axlxWardSelN = {});
          var _sk = String(target.code);
          _selN[_sk] = (_selN[_sk] || 0) + 1;
          if (_selN[_sk] === 3 && _audit) {
            _auditStepP("ward_reselect_loop", _sk + " を3回選び直した（選んだ区が外されている）");
            console.warn("[AX] 同じ区を3回選び直しています:", _sk);
          }
        } catch (_) {}
        // 同じ区の2回目以降の選び直しは迷い・停止を入れない（天王寺区のように選び直しで止まらない）
        _toggleCheckboxLikeHuman(target.c, true, 620, 1400, { quick: (window.__axlxWardSelN && window.__axlxWardSelN[String(target.code)] >= 2) });
        _noteWardPicked(target.code, target.lb && target.lb.textContent);
        _auditStepP('ward_by_code', '1区（コード・1つずつ）済' + (already + 1) + '/' + codes.length);
        return true;
      }
      /**
       * ★ 2026-11-18 平田1482: 欲しい9・入った1。未選択コードが querySelector でヒットしないと
       *   ここで黙って return し、verify が「足りない」まま MAX_RETRY まで空振りする。
       *   → DOM欠を監査に残し、一覧を下へスクロールして次の verify で拾えるようにする。
       */
      if (already < codes.length) {
        var missDom = [];
        for (var mj = 0; mj < codes.length; mj++) {
          if (!document.querySelector('input[name="city_code[]"][value="' + String(codes[mj]) + '"]')) {
            missDom.push(String(codes[mj]));
          }
        }
        try {
          if (_audit) {
            _auditStepP(
              "ward_dom_miss",
              "既選" + already + "/" + codes.length
                + (missDom.length ? (" DOM無=[" + missDom.slice(0, 12).join(",") + "]") : " DOMはあるが未ヒット")
            );
          }
        } catch (_) {}
        try {
          var listBox = document.querySelector(".this_window .one_city, label.one_city, .this_window");
          var scrollEl = (listBox && listBox.closest && (listBox.closest(".this_window") || listBox.parentElement)) || listBox;
          if (scrollEl && scrollEl.scrollBy) scrollEl.scrollBy({ top: 180 + Math.floor(Math.random() * 80), behavior: "smooth" });
          else if (scrollEl && scrollEl.scrollTop != null) scrollEl.scrollTop = (scrollEl.scrollTop || 0) + 200;
        } catch (_) {}
      }
      if (already > 0) {
        _auditStepP('ward_by_code', already + '区（コードで既選択）');
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
        if (!inp && wardLabels[i].htmlFor) {
          try { inp = document.getElementById(wardLabels[i].htmlFor); } catch (_) { inp = null; }
        }
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
        // 未選択 → **label を1つずつ**（DB: 左の大阪市〇〇区｜label.one_city）
        /**
         * ★ 2026-11-14／2026-11-16 細分化: 人が押すのは label.one_city。
         */
        if (inp) _toggleCheckboxLikeHuman(inp, true, 620, 1400);
        else enqueueHumanClick(wardLabels[i], _clickEl, _uiGapMin(), _uiGapMax(), null, _uiGapOpts());
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
  /** ★ 2026-11-18 平田1484: 間取り3/4で1回リトライ打ち切り→検索なし。回数制に変更 */
  var _axGateRetried = false; // 互換（真偽として使う旧経路）
  var _axGateRetryN = 0;
  var _AX_GATE_RETRY_MAX = 6;
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
    var out = { errors: [], missingLayout: false, extraLayout: false, extraStation: false, extraWard: false, placeMixed: false };
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
      /**
       * ★ 2026-11-16 録画: 敷金・礼金なしが外れていた。
       *   関所でもチェック状態を確かめる（未チェックなら入れ直し）。
       */
      if (_axExpect.shikirei) {
        try {
          var shCb = _findShikireiCheckbox();
          if (shCb && !shCb.checked) {
            out.errors.push('敷金・礼金なしが未チェック');
            out.missingShikirei = true;
          } else if (!shCb) {
            out.errors.push('敷金・礼金なしの欄が見つからない');
          }
        } catch (_) {}
      }
      // ⑤ 間取り（客条件だけ残す・前客分が残っていたら入れ直し）
      if (_axExpect.layoutVals && _axExpect.layoutVals.length) {
        var want = _axExpect.layoutVals.map(String);
        var allChk = Array.prototype.slice.call(document.querySelectorAll('input[name="room_layout_id[]"]:checked'))
          .map(function (cb) { return String(cb.value); });
        var hitWant = want.filter(function (v) { return allChk.indexOf(v) >= 0; });
        var missingWant = want.filter(function (v) { return allChk.indexOf(v) < 0; });
        var extras = allChk.filter(function (v) { return want.indexOf(v) < 0; });
        try { if (typeof _understandLayoutScene === "function") _understandLayoutScene(want); } catch (_) {}
        if (!hitWant.length) {
          out.missingLayout = true;
          var total = document.querySelectorAll('input[name="room_layout_id[]"]').length;
          out.errors.push('間取り（' + String(_axExpect.floorPlan || '').slice(0, 30) + '）が画面に入っていない（間取りの欄 ' + total + '個・チェック 0）');
        }
        /**
         * ★ 2026-11-18 HONOKA実測＋統括Pro:
         *   旧は「欲しい間取りが1つでもあればOK」→ 1DK+1LDK なのに 1DK だけでも関所通過。
         *   → **全部 hit するまで missingLayout**（同名駅の全押し原則と同型）。
         */
        if (missingWant.length) {
          out.missingLayout = true;
          out.errors.push(
            '間取りが足りない（欲しい' + want.length + 'のうち' + hitWant.length
            + 'だけ／足りない値' + missingWant.slice(0, 6).join(',') + '）'
          );
        }
        /**
         * ★ 2026-11-16 竹内さん「2LDK以外はずしている／新しいお客さんのように」:
         *   旧関所は「欲しい間取りが1つでもあればOK」→ 前客の1LDK・2Kが残っても通っていた。
         *   → **余分があれば止めて入れ直す**（setCheckboxes が外す＋客条件だけ残す）。
         */
        if (extras.length) {
          out.extraLayout = true;
          out.errors.push('間取りに前客分が残っている（余分' + extras.length + '・欲しい' + want.length + '／画面' + allChk.length + '）');
        }
      } else if (_axExpect.floorPlan) {
        /** 条件はあるのに値が空＝全外しのはず。チェックが残っていたら余分 */
        var leftChk = document.querySelectorAll('input[name="room_layout_id[]"]:checked').length;
        try { if (typeof _understandLayoutScene === "function") _understandLayoutScene([]); } catch (_) {}
        if (leftChk > 0) {
          out.extraLayout = true;
          out.errors.push('間取りを外し切れていない（画面に' + leftChk + '個残っている）');
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
        /**
         * ★ 2026-11-16: URLに前客の条件が残っていても、**この回で選んでいなければ場所なし**。
         *   旧は urlHasArea だけで通していた → 駅を外した直後に前客URLで「場所あり」と誤認し全件検索。
         */
        var hasArea = (wardEff > 0) || (stEff > 0) || (urlHasArea && _axPlaceReady && (_picked.ward + _picked.station) > 0);
        if (!hasArea) {
          out.errors.push('場所（' + String(_axExpect.areaText || '').slice(0, 24) + '）が画面に入っていない（区 ' + wardN + '・駅 ' + stN + '）');
          out.missingArea = true;
        } else {
          /**
           * ★ 2026-11-17 竹内さん「地域と駅が混ざったら物件も検索ちゃんとできない／ここはどちらか」:
           *   旧は both を許可していた → 日本橋などが地域＋駅で同時に残り0件になる。
           *   → **同時はエラー**（どちらか一方だけ通す）。
           */
          if (wardEff > 0 && stEff > 0) {
            out.placeMixed = true;
            out.area_ok_by = 'both';
            out.errors.push('地域と駅が同時に入っている（どちらか一方にする・区' + wardEff + '・駅' + stEff + '）');
            try { if (_audit) _auditStepP('place_mixed', 'ward=' + wardEff + ' station=' + stEff); } catch (_) {}
          } else {
            out.area_ok_by = wardEff > 0 ? 'ward' : 'station';
          }
          out.area_counts = { dom_ward: wardN, dom_station: stN, remembered_ward: _picked.ward, remembered_station: _picked.station };
        }
        /**
         * ★ 2026-11-16 細分化（所在地↔駅の軸）:
         *   所在地客なのに駅チェックがDOMに残る／駅客なのに区が残る → 前客の場所が混ざる。
         *   モーダル閉鎖後は DOM 0 になりやすいので、**画面に見えている残だけ**を止める。
         * ★ 2026-11-17: areaMode が空でも両方残っていたら外し忘れとして扱う。
         */
        if ((_axExpect.areaMode === 'ward' || out.placeMixed) && stN > 0) {
          out.extraStation = true;
          if (!out.placeMixed) out.errors.push('所在地検索なのに駅・沿線が残っている（' + stN + '）');
        }
        if ((_axExpect.areaMode === 'station' || out.placeMixed) && wardN > 0) {
          out.extraWard = true;
          if (!out.placeMixed) out.errors.push('駅・沿線検索なのに所在地が残っている（' + wardN + '）');
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

  /**
   * ★ 2026-11-17 統括Pro「done印が録画に残っていない／ボタン理解を終わらせる」:
   *   検索前に、この回で理解できたボタン（選ぶ/外す/押す）を台帳形式で残す。
   *   DB done=0 を終わらせる土台（再読込後に測れる）。
   */
  function _auditBtnUnderstandLedger(where) {
    try {
      var m = window.__axlxBtnUnderstood || {};
      var keys = Object.keys(m);
      var okN = 0, failN = 0;
      var okParts = [], failParts = [];
      for (var i = 0; i < keys.length; i++) {
        var k = keys[i];
        if (m[k]) {
          okN++;
          if (okParts.length < 12) okParts.push(k);
        } else {
          failN++;
          if (failParts.length < 8) failParts.push(k);
        }
      }
      if (_audit) {
        _auditStepP(
          "btn_understand_ledger",
          String(where || "search") + " ok=" + okN + " fail=" + failN +
            (okParts.length ? " [" + okParts.join(",") + "]" : "") +
            (failParts.length ? " 未=" + failParts.join(",") : ""),
        );
      }
      try {
        window.postMessage({
          from: "axlx-rec-note-name",
          name: ("理解台帳:ok" + okN + "/fail" + failN).slice(0, 40),
        }, "*");
      } catch (_) {}
    } catch (_) {}
  }
  function clickSearch() {
    try { _auditBtnUnderstandLedger("search前"); } catch (_) {}
    try { _auditFlowUnderstandLedger("search前"); } catch (_) {}
    try { _auditFullFlowMapLedger("search前"); } catch (_) {}
    if (_guideOn()) {
      // 案内モード（data-axlx-guide が "0" 以外）＝拡張は押さない。
      //   ⚠ 自動モードなのにここに来るなら、realpro-guide.js が "0" を書けていない（＝原因が分かる）
      var _g = null;
      try { _g = document.documentElement.getAttribute("data-axlx-guide"); } catch (_) {}
      _noteSearchWhy('guide_on: data-axlx-guide=' + String(_g), { guideAttr: _g });
      console.warn("[AX] 案内モードのため検索を押さない（スタッフが押す） data-axlx-guide=" + String(_g));
      notifyDone("guide-mode: 検索はスタッフが押す"); return;
    }
    /**
     * ★ 2026-11-16 竹内さん「続きのお客さんも地域または駅を選択してから検索／先に検索になってそのあと指定ではなく」:
     *   DB実測: `search_guard_press` が fill_start 直後に走り、`_axExpect` 未設定のまま関所が空通し → 大阪全件。
     *   → 準備前・場所未確定では **押さない**（pressedAt も付けない＝保険が再試行できる）。
     */
    if (!_axExpect) {
      try { _auditStepP("search_block_early", "条件の準備前に検索しようとした → 押さない（場所→条件→検索の順）"); } catch (_) {}
      try { _noteFlowPhase("search", false, "expect未準備"); } catch (_) {}
      _noteSearchWhy("expect_not_ready");
      return;
    }
    if (_axExpect.areaMode && !_axPlaceReady) {
      try { _auditStepP("search_block_no_place", "場所（地域/駅）を入れる前に検索しようとした → 押さない"); } catch (_) {}
      try { _noteFlowPhase("search", false, "場所未確定"); } catch (_) {}
      _noteSearchWhy("place_not_ready");
      return;
    }
    /**
     * ★ 2026-11-16: 間取り・敷礼なし等が終わる前の検索を止める（25秒保険・stall 対策）。
     *   関所の gate_retry 中だけは通す（入れ直したあと再検索するため）。
     */
    if (!_axConditionsReady && !_axGateRetried) {
      try { _auditStepP("search_block_no_basic", "間取り・敷礼など基本条件の前に検索しようとした → 押さない"); } catch (_) {}
      try { _noteFlowPhase("search", false, "条件未準備"); } catch (_) {}
      _noteSearchWhy("basic_not_ready");
      return;
    }
    /**
     * ★ 根本: パネル未清算のまま検索しない（確定してリストへ抜けの関所）。
     */
    if (_axPanelDebt) {
      try { _auditStepP("search_block_panel_debt", _axPanelDebt.kind + " / " + _axPanelDebt.why); } catch (_) {}
      _noteSearchWhy("panel_debt:" + _axPanelDebt.kind);
      _settlePanelDebtThen("検索前のパネル清算", function () { setTimeout(clickSearch, 350); });
      return;
    }
    // クリックキュー消化中は検索しない（条件クリックが全て反映される前の検索送信を防止）
    if (isClickQueueBusy()) {
      if (_audit && !_audit._searchWaitMarked) { _audit._searchWaitMarked = true; _auditStepP('search_wait', 'queue=' + _clickQueue.length); }
      setTimeout(clickSearch, _pd(200)); return;
    }
    /**
     * 2026-11-14: **検索を押した時刻**を残す（保険の判定に使う・二重押しを防ぐ）。
     *   ⚠ 準備チェックの**あと**に付ける（早めに付けると保険が止まって再試行できない）。
     */
    try { window._axSearchPressedAt = Date.now(); } catch (_) {}
    try { _ledgerSave("search"); } catch (_) {}
    try {
      var _PM = window.AxlxPointerUi;
      if (_audit && _PM && typeof _PM.motionStats === "function") {
        var _ms = _PM.motionStats();
        if (_ms && _ms.n > 0) _auditStepP("motion_stats", "n=" + _ms.n + " 速p50=" + _ms.speed_p50 + " 速CV=" + _ms.speed_cv + " ms p50=" + _ms.ms_p50 + " 曲p50=" + _ms.curve_p50 + " p90=" + _ms.curve_p90 + " 距p50=" + _ms.dist_p50 + " 行過=" + _ms.over_pct + "% 迷=" + _ms.pause_pct + "% persona=" + (_ms.persona ? (_ms.persona.source + "/s" + _ms.persona.speed_scale + "/c" + _ms.persona.curve_gain + "/p" + _ms.persona.press_ms) : "-") + " plan=" + (_ms.plan_id || "-"));
      }
    } catch (_) {}
    // v2.5.50 検索を押す前の関所。2026-11-10 v2.6.18: 間取りだけでなく**家賃・更新日・築年・徒歩・場所**も画面で確かめる。
    //   ・間取りが0個 → 1回だけ入れ直す（今まで通り）
    //   ・家賃・更新日・場所などが画面と違う → **入れ直してから**もう一度確かめる（1回だけ）→ それでも違えば止める
    //   止めた時は fill-done に gate:true を付ける（content.js が error として中継＝background はこのお客様のリアプロを理由付きで飛ばす）
    var _gate = _axGateCheck();
    if (_gate.errors.length) {
      if (_axGateRetryN < _AX_GATE_RETRY_MAX) {
        _axGateRetryN++;
        _axGateRetried = true;
        _auditStepP('gate_retry', 'n=' + _axGateRetryN + '/' + _AX_GATE_RETRY_MAX + ' ' + _gate.errors.join(' / ').slice(0, 160));
        /**
         * ★ 2026-11-16 竹内さん「弱い部分あれば細かく強化／操作一つずつ」:
         *   実測: 関所の入れ直しが setSelVal（押さず change）→ カーソル付きに直したあと、
         *   それでも queueSelVal を**一気に全部積む**と擬似一覧が重なって徒歩が消えた。
         *   → `_runBasicOneByOne` で1つ終わるまで次を始めない。徒歩は最後に締める。
         */
        try {
          var _gateQ = [];
          var _selNow = function (n) { try { return document.querySelector('select[name="' + n + '"]'); } catch (_) { return null; } };
          if ((_gate.missingLayout || _gate.extraLayout) && _axExpect.layoutVals && _axExpect.layoutVals.length) {
            _gateQ.push({ name: "room_layout_id[]", run: function () { return setCheckboxes("room_layout_id[]", _axExpect.layoutVals); } });
          } else if (_gate.extraLayout) {
            _gateQ.push({ name: "room_layout_id[]", run: function () { return setCheckboxes("room_layout_id[]", []); } });
          }
          /**
           * ★ 2026-11-17 通常録画正本＋統括Pro: 関所の駅余りを setCheckboxes([]) で直外ししない。
           *   → 旗を立てて沿線・駅モーダルを開き、駅画面→沿線画面の順で外し直す。
           */
          /**
           * ★ 2026-11-17: 混在時は area_mode の「残す側」以外を外す。
           *   ward希望→駅を外す／station希望→区を外す／不明→両方外す。
           */
          /** ★ 2026-11-19: 混在では extraStation も立つので、駅の客の駅を外さないよう areaMode で必ず残す側を守る。 */
          if ((_gate.extraStation || _gate.placeMixed) && _axExpect.areaMode !== "station") {
            _gateQ.push({
              name: "station_id[]",
              run: function () {
                try {
                  if (_audit) _auditStepP("gate_station_defer_clear", (_gate.placeMixed ? "混在→" : "") + "関所: 駅余り→駅画面経由で外し切って確定（setCheckboxes空禁止）");
                } catch (_) {}
                /** ★ 2026-11-19: 旧は旗を立てて開くだけ（外す処理は駅の流れでしか動かず、所在地客では残った）。 */
                return new Promise(function (res) {
                  _clearStationsBeforeWardThen(res, "関所");
                });
              },
            });
          }
          if ((_gate.extraWard || _gate.placeMixed) && _axExpect.areaMode !== "ward") {
            _gateQ.push({
              name: "city_code[]",
              run: function () {
                try {
                  window.__axlxNeedClearWard = true;
                  if (_audit) _auditStepP("gate_ward_clear", (_gate.placeMixed ? "混在→" : "") + "関所: 所在地余りを所在地絞り込みで1つずつ外す");
                } catch (_) {}
                return new Promise(function (res) {
                  _clearWardsBeforeStationThen(res, "関所");
                });
              },
            });
          }
          /**
           * ★ 2026-11-16: 関所の入れ直しは**ずれている欄だけ**。
           *   旧は errors が1つでも家賃・更新日・築年を全部押し直していた
           *   → 間取りだけ欠けても家賃がもう一度開く（録画で rent×6＝初回3＋関所3）。
           */
          if (_axExpect.rentMin != null) {
            var _r1g = _selNow("rental_cost1");
            if (!_r1g || !_selMatchesWant(_r1g, _axExpect.rentMin)) {
              _gateQ.push({ name: "rental_cost1", run: function () { queueSelVal("rental_cost1", _axExpect.rentMin); } });
            }
          }
          if (_axExpect.rentMax != null) {
            var _r2g = _selNow("rental_cost2");
            if (!_r2g || !_selMatchesWant(_r2g, _axExpect.rentMax)) {
              _gateQ.push({ name: "rental_cost2", run: function () { queueSelVal("rental_cost2", _axExpect.rentMax); } });
            }
          }
          if (_axExpect.updateDays != null) {
            var _upg = _selNow("update_date");
            if (!_upg || !_selMatchesWant(_upg, _axExpect.updateDays)) {
              _gateQ.push({ name: "update_date", run: function () { queueSelVal("update_date", _axExpect.updateDays); } });
            }
          }
          if (_axExpect.age != null) {
            var _agg = _selNow("structured_date");
            if (!_agg || !_selMatchesWant(_agg, _axExpect.age)) {
              _gateQ.push({ name: "structured_date", run: function () { queueSelVal("structured_date", _axExpect.age); } });
            }
          }
          if (_axExpect.shikirei || _gate.missingShikirei) {
            _gateQ.push({
              name: "敷金・礼金なし",
              run: function () {
                try {
                  var _sh = _findShikireiCheckbox();
                  if (_sh && !_sh.checked) enqueueHumanClick(_sh, _clickEl, _uiGapMin(), _uiGapMax(), null, _uiGapOpts());
                } catch (_) {}
              },
            });
          }
          if (_axExpect.walk != null) {
            _gateQ.push({
              name: "transportation_id",
              run: function () {
                try {
                  var _tr = document.querySelector('select[name="transportation_id"]');
                  if (!_tr) return;
                  var _needTr = !!_gate.missingTransport;
                  if (!_needTr) {
                    try {
                      var _tx = String(_tr.options[_tr.selectedIndex] && _tr.options[_tr.selectedIndex].textContent || "").replace(/\s+/g, "");
                      if (!_tx || _tx.indexOf("徒歩") < 0) _needTr = true;
                    } catch (_) { _needTr = true; }
                  }
                  if (_needTr) {
                    queueSelValText("transportation_id", "徒歩");
                    _auditStepP('gate_reseal_walk', '徒歩を1つずつ戻す');
                  }
                } catch (_) {}
              },
            });
            _gateQ.push({
              name: "required_time",
              run: function () {
                var _gotW = _walkMinVal();
                var _wantW = String(_axExpect.walk);
                if (_gotW === _wantW || (_gotW && _gotW.indexOf(_wantW) >= 0)) return;
                var _wkSel = document.querySelector('select[name="required_time"]');
                if (_wkSel) {
                  queueSelValText("required_time", _wantW);
                  return;
                }
                var _wk = document.querySelector('input[name="required_time"]');
                if (_wk) queueTxtVal("required_time", _axExpect.walk);
              },
            });
            _gateQ.push({
              name: "walk_seal_final",
              run: function () {
                enqueueHumanAction(function () {
                  return _resealWalkAfterMinutes(_axExpect.walk);
                }, 500, 1000, "gate_walk_seal");
              },
            });
          }
          _runBasicOneByOne(_gateQ, function () {
            try { window._axSearchPressedAt = 0; } catch (_) {}
            setTimeout(clickSearch, _pd(500));
          });
        } catch (_) {
          whenClickQueueIdle(function () {
            try { window._axSearchPressedAt = 0; } catch (_) {}
            setTimeout(clickSearch, _pd(500));
          });
        }
        return;
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
      /**
       * ★ 2026-11-16 竹内さん「間取りや敷金礼金なしの前に検索が走った」:
       *   旧は場所以外を gate_warn で通していた → 間取り0・敷礼未チェックのまま検索。
       *   → 場所・間取り・敷礼なし は**止める**（条件未完了の検索を防ぐ）。
       */
      var _hardGate = _gate.errors.some(function (m) {
        var s = String(m);
        return s.indexOf('場所') === 0 || s.indexOf('間取り') === 0 || s.indexOf('敷金') === 0 || s.indexOf('礼金') >= 0;
      });
      if (_hardGate) {
        /**
         * ★ 2026-11-18: リトライ残があるなら止めて検索スキップしない（間取り途中停止の本丸）。
         *   キュー消化後に clickSearch を再入場させる。
         */
        if (_axGateRetryN < _AX_GATE_RETRY_MAX) {
          _axGateRetryN++;
          _auditStepP('gate_soft_retry', 'hard未完了→再試行 n=' + _axGateRetryN + ' ' + gateMiss.slice(0, 120));
          // 間取り不足ならクリック入れ直しを積んでから再入場
          try {
            if (_gate.missingLayout || _gate.extraLayout) {
              var openLay = _findByText(["間取り絞り込み＋", "間取り絞り込み+", "間取り絞り込み"]);
              if (openLay) enqueueHumanClick(openLay, _clickEl, _uiGapMin(), _uiGapMax(), null, _uiGapOpts());
              if (_axExpect && _axExpect.layoutVals && _axExpect.layoutVals.length) {
                setCheckboxes("room_layout_id[]", _axExpect.layoutVals);
              }
            }
          } catch (_) {}
          whenClickQueueIdle(function () {
            setTimeout(function () {
              try { window._axSearchPressedAt = 0; } catch (_) {}
              try { clickSearch(); } catch (_) {}
            }, _pd(800));
          });
          return;
        }
        _auditStepP('gate_stop_basic', gateMiss);
        if (_audit) _audit.form = _readRealproForm();
        console.warn('[AX] 間取り/敷礼/場所が未完了なので検索しない: ' + gateMiss);
        notifyDone('AXLX_FILL_INCOMPLETE: ' + gateMiss, true);
        return;
      }
      _auditStepP('gate_warn', gateMiss);
      if (_audit) { _audit.form = _readRealproForm(); _audit.gate_warn = gateMiss; }
      try { showWarnToast('条件が画面と違うまま検索します: ' + gateMiss.slice(0, 80)); } catch (_) {}
      console.warn('[AX] 検索を押す前の確認で違う所があった（止めずに検索する）: ' + gateMiss);
      // ← 家賃丸め等だけは止めずに下へ進む
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
    /**
     * ★ 2026-11-16 竹内さん「徒歩もおしたあとに絶対にきえてしまう」:
     *   検索を押す直前にもう一度だけ徒歩を締める（他の欄の change で空になった場合の最後の砦）。
     *   1回だけ（`_axPreSearchWalkSealed`）＝ループしない。
     */
    if (_axExpect && _axExpect.walk != null && !window._axPreSearchWalkSealed) {
      window._axPreSearchWalkSealed = true;
      /**
       * ★ 2026-11-20 (2.8.135) 竹内さん「外した後検索のところおすときも少し詰まっている」:
       *   徒歩が合っている時も列に1件積んで待っていた（実測 #1544: 2回目の clickSearch→3回目まで 3.2秒）。
       *   → 合っていればそのまま押す。ずれている時だけ直す。
       */
      var _walkOkNow = false;
      try {
        var _wm = _walkMinVal(), _ww = String(_axExpect.walk);
        _walkOkNow = _walkTrText().indexOf("徒歩") >= 0 && (_wm === _ww || (!!_wm && _wm.indexOf(_ww) >= 0));
      } catch (_) { _walkOkNow = false; }
      if (_walkOkNow) {
        try { _auditStepP("walk_seal_ok", "検索前 徒歩+分数 OK（待たずに押す）"); } catch (_) {}
        setTimeout(clickSearch, _pd(120));
        return;
      }
      enqueueHumanAction(function () {
        // 検索直前は静かに直すだけ（一覧をまた開かない）
        return _resealWalkAfterMinutes(_axExpect.walk, { allowUi: false });
      }, 350, 800, "pre_search_walk_seal");
      whenClickQueueIdle(function () {
        setTimeout(clickSearch, _pd(280));
      });
      return;
    }
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
     * ★ 2026-11-16 竹内さん「検索も保険も直接じゃなく、どうしてもする場合でもちゃんとカーソル移動させて検索ボタンを押す」:
     *   旧: `_humanPointerClick` を直呼び＋すぐ `notifyDone`（キュー外・押し終わり前に完了扱い）。
     *   新: **必ず `enqueueHumanClick`（カーソル移動→着いてから押す）**。本線も控え保険も同じ経路。
     *     ・学んだ押す位置（aim）があればその点へ
     *     ・押し終わってから `notifyDone`（途中で完了にしない）
     */
    var _pressSearchBtn = function (btn) {
      if (!btn) return false;
      /**
       * ★ 2026-11-18 竹内さん「検索を押す際 画面が切れていた。画面表示されるようにスクロールして、検索が出てから押す」:
       *   旧はスクロールを頼んだ直後にカーソルを動かし、まだ画面外の検索を押していた。
       *   → 画面の中に出てから押す（スクロール後に待って再確認・最大6回＝約2秒）。出なければ今まで通り押す。
       */
      try {
        var _inVNow = function () {
          var rr = btn.getBoundingClientRect();
          var vh = window.innerHeight || 800, vw = window.innerWidth || 1200;
          if (!(rr.width > 0 && rr.height > 0 && rr.top >= 0 && rr.bottom <= vh && rr.left >= 0 && rr.right <= vw)) return false;
          /**
           * ★ 2026-11-19 #1530 竹内さん「検索ボタンを画面外から押している…ちゃんとスクロールして画面に見えるようになってから」:
           *   左の帯が中でスクロールしていると、枠は画面の内側でも上の固定の帯の下に隠れていた（カーソルが閲覧履歴の上）。
           *   → ボタンの中央付近が本当に一番上に見えている時だけ「見えている」とする。
           */
          return !!_visibleHitPoint(btn, null) && _hitPlain(btn);
        };
        if (!_inVNow()) {
          btn.__axSearchViewTries = (Number(btn.__axSearchViewTries) || 0) + 1;
          if (btn.__axSearchViewTries <= 6) {
            // 一瞬で飛ばさず人の速さで送る（2026-11-20）。送り終わるのを待ってから見直す
            try { btn.scrollIntoView({ block: "center", inline: "nearest", behavior: "smooth" }); } catch (_) {}
            try { _auditStepP("search_wait_view", "検索が画面の外 → 出てから押す（" + btn.__axSearchViewTries + "回目）"); } catch (_) {}
            setTimeout(function () { _pressSearchBtn(btn); }, 520 + Math.floor(Math.random() * 380));
            return false;
          }
        } else {
          btn.__axSearchViewTries = 0;
        }
      } catch (_) {}
      _scrollIntoViewSoft(btn);
      // ★ 2026-11-18: スクロール後に再測。まだ画面外なら aim を捨てて欄中央（画面外カーソル防止）
      try {
        var _rr0 = btn.getBoundingClientRect();
        var _vh0 = window.innerHeight || 800;
        var _vw0 = window.innerWidth || 1200;
        if (_rr0.bottom < 0 || _rr0.top > _vh0 || _rr0.right < 0 || _rr0.left > _vw0) {
          // ⚠ ここは直後に押すので instant のまま（smooth だと動いている途中の位置を狙う）。上の6回の待ちを抜けた時だけ通る
          try { btn.scrollIntoView({ block: "center", inline: "nearest", behavior: "instant" }); } catch (_) {
            try { btn.scrollIntoView(true); } catch (__) {}
          }
        }
      } catch (_) {}
      if (_audit) {
        _audit.search_clicked = true;
        try {
          var _rr = btn.getBoundingClientRect();
          _audit.search_press = {
            at: String((btn.textContent || btn.value || '').replace(/\s+/g, '')).slice(0, 20),
            rect: { t: Math.round(_rr.top), l: Math.round(_rr.left), w: Math.round(_rr.width), h: Math.round(_rr.height) },
            in_view: (_rr.top >= 0 && _rr.bottom <= (window.innerHeight || 800) && _rr.left >= 0 && _rr.right <= (window.innerWidth || 1200)),
            t: Date.now() - (_fillStartedAt || Date.now()),
            which: _inModal(btn) ? "modal" : (_isSidebar(btn) ? "sidebar" : "unknown"),
            cls: String(btn.className || "").slice(0, 40),
            via: "cursor_queue",
          };
        } catch (_) {}
      }
      var _sAim = null;
      try {
        if (!_inModal(btn)) _sAim = _aimByEl(btn, ['左の検索', '検索', '住居検索', 'go_search']);
        // 画面外の学びは使わない（右ずれ・画面外の根）
        if (_sAim && _audit && _audit.search_press && _audit.search_press.in_view === false) _sAim = null;
      } catch (_) { _sAim = null; }
      try {
        _auditStepP('search_cursor', '検索へカーソル移動してから押す' + (_sAim ? (' aim=' + _sAim.key) : ''));
        _auditStepP('learn_aim', 'search:' + (_sAim ? (_sAim.key + ' 横' + Math.round(_sAim.x * 100) + '% 縦' + Math.round(_sAim.y * 100) + '%') : '学び無し→欄中央付近'));
      } catch (_) {}
      try { btn.__axPending = false; } catch (_) {}
      var _finishSearchPress = function () {
        try {
          if (_audit && _audit.search_press) {
            var P = window.AxlxPointerUi;
            var ps = P && P.visiblePosition ? P.visiblePosition() : null;
            if (ps) _audit.search_press.pointer = { x: Math.round(ps.x), y: Math.round(ps.y) };
          }
        } catch (_) {}
        try {
          _noteFlowPhase(
            "search",
            true,
            (_audit && _audit.search_press && _audit.search_press.which)
              ? ("which=" + _audit.search_press.which)
              : "検索押下",
          );
          try { _auditStepP("search_press_ok", "検索を押した"); } catch (_) {}
          try { _noteNowCustomer("search", "検索押下"); } catch (_) {}
        } catch (_) {}
        notifyDone();
      };
      /**
       * ★ 2026-11-18: click 直前にリロード生存印（同期 postMessage）。
       *   click → 即遷移だと whenClickQueueIdle→notifyDone が消える／Case C 不発の根を塞ぐ。
       */
      var _queued = enqueueHumanClick(btn, function (el) {
        try { _armPropertyPathBeforeSearch("検索click直前"); } catch (_) {}
        try { el.click(); } catch (_) {}
      }, _uiGapMin(), _uiGapMax(), null, { aim: _sAim, label: "click:検索", strictLo: true, sigma: 0.55, decide: true });
      if (_queued) {
        whenClickQueueIdle(_finishSearchPress);
      } else {
        // キューに積めない時も直接clickせず、カーソル着いてから押す
        var _pr = _humanPointerClick(btn, function () {
          try { _armPropertyPathBeforeSearch("検索click直前(直)"); } catch (_) {}
          try { btn.click(); } catch (_) {}
        }, _sAim);
        if (_pr && typeof _pr.then === "function") _pr.then(_finishSearchPress, _finishSearchPress);
        else setTimeout(_finishSearchPress, 600);
      }
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
    try { _noteFlowPhase("search", false, "検索ボタン無し"); } catch (_) {}
    notifyDone('clickSearch: 検索ボタンが見つかりません（フォーム折りたたみ/モーダル遮蔽の可能性）');
  }

  // 路線ボタンをクリック（リアプロモーダル: LABEL.one_line 構造確認済み）
  function clickLineButtons(routeIds) {
    if (!routeIds || !routeIds.length) return;
    /**
     * ★ 2026-11-17 打合せ: 沿線も「今どの画面か」を読んでから押す。
     *   station_list 上で沿線押ししない／closed なら開き直す。
     *   画面外ラベルは isVisible スキップせず scroll→押す（駅と同じ）。
     */
    try {
      var _scrLn = _graspStationModalScreen();
      if (_scrLn.kind === "station_list") {
        if (_audit) _auditStepP("line_select_wrong_screen", "station_list上で沿線選びしない→沿線へ戻る");
        clickByText(["沿線の設定へ戻る", "沿線を選び直す", "沿線の設定へ戻る‹", "沿線の設定へ戻る<"]);
        return;
      }
      if (_scrLn.kind === "closed") {
        if (_audit) _auditStepP("line_select_closed", "closed→沿線・駅を開き直してから選ぶ");
        clickByText(["沿線・駅絞り込み＋", "沿線・駅絞り込み+", "沿線・駅絞り込み"]);
        return;
      }
    } catch (_) {}
    // label.one_line を優先（診断で確認した実DOM構造）
    var labels = Array.prototype.slice.call(document.querySelectorAll('label.one_line'));
    var _pickLine = function (lb) {
      if (!lb) return false;
      try {
        if (lb.scrollIntoView) {
          lb.scrollIntoView({
            behavior: Math.random() < 0.8 ? "smooth" : "auto",
            block: Math.random() < 0.7 ? "center" : "nearest",
            inline: "nearest",
          });
        }
      } catch (_) {}
      var cb = lb.querySelector('input[type="checkbox"]');
      if (!cb && lb.htmlFor) {
        try { cb = document.getElementById(lb.htmlFor); } catch (_) { cb = null; }
      }
      if (cb) {
        if (!cb.checked) _toggleCheckboxLikeHuman(cb, true, _stGapMin(), _stGapMax());
        return true;
      }
      var _lo = _uiGapOpts();
      _lo.keys = ["route_id[]", "one_line"];
      enqueueHumanClick(lb, _clickEl, _uiGapMin(), _uiGapMax(), null, _lo);
      return true;
    };
    routeIds.forEach(function(id) {
      var lineName = ROUTE_LINE_MAP[id];
      if (!lineName) return;
      var lineNorm = norm(lineName);
      var found = false;
      // PASS1: label.one_line 完全一致（可視優先・画面外も候補）
      var _hitVis = null, _hitAny = null;
      for (var i = 0; i < labels.length; i++) {
        var lNorm = norm(labels[i].textContent);
        if (lNorm !== lineNorm) continue;
        if (isVisible(labels[i])) { _hitVis = labels[i]; break; }
        if (!_hitAny) _hitAny = labels[i];
      }
      if (_hitVis || _hitAny) {
        found = _pickLine(_hitVis || _hitAny);
        if (_hitAny && !_hitVis && _audit) _auditStepP("line_scroll_pick", lineName);
      }
      // PASS2: 短縮名サフィックス一致（"御堂筋線" → "大阪市高速軌道御堂筋線"）
      for (var j = 0; j < labels.length && !found; j++) {
        var lNorm2 = norm(labels[j].textContent);
        if (lNorm2.length >= 4 && lineNorm.endsWith(lNorm2)) {
          found = _pickLine(labels[j]);
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
  /**
   * ★ 2026-11-17 通常録画実測（normal 80枚）:
   *   駅 gap p10=751 p50=1117 p90=1611／沿線 p50=1005／進む・戻る p50=1510
   *   → 下限250帯は速すぎ。人間の駅リズム（≈1.1秒）に合わせる。
   */
  function _stGapMin() {
    var H = window.AxlxHumanWait;
    /** ★ 2026-11-17 統括Pro: 駅2つ目以降が短間隔の主因 → 下限を通常p50寄り（≥950） */
    var v = H && H.logNormalDelay ? H.logNormalDelay(1100, 0.35) : (1000 + Math.floor(Math.random() * 150));
    if (v < 950) v = 950;
    if (v > 1300) v = 1300;
    return Math.round(v);
  }
  function _stGapMax() {
    var H = window.AxlxHumanWait;
    var v = H && H.logNormalDelay ? H.logNormalDelay(1650, 0.4) : (1400 + Math.floor(Math.random() * 500));
    return Math.round(v + _stationBreath());
  }
  /** 駅を1つ押した後に足す「人の一息」（何駅目かは決めない・毎回ちがう） */
  function _stationBreath() {
    var add = 0;
    var H = window.AxlxHumanWait;
    if (Math.random() < 0.12) {
      add += H && H.logNormalDelay ? H.logNormalDelay(1400, 0.45) : (900 + Math.floor(Math.random() * 1700));
    }
    if (Math.random() < 0.035) {
      add += H && H.logNormalDelay ? H.logNormalDelay(3600, 0.4) : (2600 + Math.floor(Math.random() * 2900));
    }
    return Math.round(add);
  }
  /** 駅／沿線の押し間隔（録画 p50≈1.1s） */
  function _clearToggleGapRange() {
    return { lo: _stGapMin(), hi: _stGapMax() };
  }
  /** 「駅の設定へ進む」「沿線の設定へ戻る」は録画どおり遅め（p50≈1510） */
  function _nextBackGapRange() {
    var H = window.AxlxHumanWait;
    var lo = H && H.logNormalDelay ? H.logNormalDelay(1100, 0.3) : 1000;
    var hi = H && H.logNormalDelay ? H.logNormalDelay(1700, 0.35) : 1600;
    if (lo < 900) lo = 900;
    if (hi < lo + 200) hi = lo + 400;
    return { lo: Math.round(lo), hi: Math.round(hi) };
  }
  /**
   * ★ 2026-11-17 統括Pro「固定ギャップ450-1000が機械的／最低800ms」:
   *   区・町・設備・間取りなど汎用UI押し。通常録画 p50≈1117 に合わせる。
   */
  function _uiGapMin() {
    var H = window.AxlxHumanWait;
    // ★ 2026-11-17 F29: 短間隔未達 → UI押し硬下限 1000（通常 p50≈1117）
    var v = H && H.logNormalDelay ? H.logNormalDelay(1100, 0.4) : 1050;
    if (v < 1000) v = 1000;
    if (v > 1400) v = 1400;
    return Math.round(v);
  }
  function _uiGapMax() {
    var H = window.AxlxHumanWait;
    var v = H && H.logNormalDelay ? H.logNormalDelay(1680, 0.42) : 1650;
    if (v < 1400) v = 1400;
    return Math.round(v);
  }
  function _uiGapOpts() { return { strictLo: true, sigma: 0.55 }; }
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
    try {
      var _scrSel = _graspStationModalScreen();
      if (_scrSel.kind === "line_list") {
        if (_audit) _auditStepP("station_select_wrong_screen", "line_list上で駅選びしない→駅の設定へ");
        clickByText(["駅の設定へ進む", "駅の設定へ進む›", "駅の設定へ進む>"]);
        return;
      }
      if (_scrSel.kind === "closed") {
        if (_audit) _auditStepP("station_select_closed", "closed→沿線・駅を開き直してから選ぶ");
        clickByText(["沿線・駅絞り込み＋", "沿線・駅絞り込み+", "沿線・駅絞り込み"]);
        return;
      }
    } catch (_) {}
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

      /**
       * ★ 2026-11-16 通常録画（2.8.37）: 人は `label.one_station` を押す
       *   （大国町・本町・堺筋本町）。汎用 label より one_station を先に見る。
       *   沿線が前客と被って残っていても、駅はここで必ず選ぶ。
       */
      var labels = Array.prototype.slice.call(document.querySelectorAll('label.one_station'));
      if (!labels.length) labels = Array.prototype.slice.call(document.querySelectorAll('label'));
      /**
       * ★ 2026-11-17 竹内さん「沿線ごとに同名駅（十三）をすべて押す」:
       *   旧: 非表示ラベルを skip → 画面外の十三が残る／同一 value を1つだけ → 沿線違いの同名を落とす。
       *   新: 名前一致は**全部**スクロールして押す（要素単位の二重押しだけ防ぐ）。
       */
      var _seenStEls = [];
      var _perLineN = 0;
      for (var i = 0; i < labels.length; i++) {
        var txt = labels[i].textContent.replace(/\s+/g, '').replace(/駅$/, '');
        if (!_stationNameMatch(txt, clean)) continue;
        var inp = labels[i].querySelector('input[type="checkbox"]');
        if (!inp && labels[i].htmlFor) inp = document.getElementById(labels[i].htmlFor);
        if (inp) {
          if (_seenStEls.indexOf(inp) >= 0) { found = true; continue; }
          _seenStEls.push(inp);
          try {
            if (labels[i].scrollIntoView) {
              labels[i].scrollIntoView({
                behavior: Math.random() < 0.8 ? "smooth" : "auto",
                block: Math.random() < 0.7 ? "center" : "nearest",
                inline: "nearest",
              });
            }
          } catch (_) {}
          if (!inp.checked) {
            _toggleCheckboxLikeHuman(inp, true, _stGapMin(), _stGapMax());
            _perLineN++;
          } else {
            _perLineN++;
          }
          found = true;
        } else {
          if (_seenStEls.indexOf(labels[i]) >= 0) { found = true; continue; }
          _seenStEls.push(labels[i]);
          try {
            if (labels[i].scrollIntoView) {
              labels[i].scrollIntoView({ behavior: "smooth", block: "center", inline: "nearest" });
            }
          } catch (_) {}
          enqueueHumanClick(labels[i], _clickEl, _stGapMin(), _stGapMax(), null, { keys: ["station_id[]", clean] });
          _perLineN++;
          found = true;
        }
      }
      if (found) {
        try {
          if (_audit) {
            var _mapHit = 0;
            try { _mapHit = _mapExpectHitsForStation(clean, _selectedLineNamesNow(null)); } catch (_) {}
            var _msg = clean + " 沿線ごと" + _perLineN + "本";
            if (_mapHit > 0) _msg += " 地図期待" + _mapHit;
            if (_perLineN <= 1 && _mapHit > 1) _msg += "（地図より少ない／要スクロール）";
            else if (_perLineN <= 1) _msg += "（同名が1つだけ／要確認）";
            _auditStepP(
              (_perLineN > 1 || (_mapHit > 0 && _perLineN >= _mapHit)) ? "station_per_line_ok" : "station_per_line",
              _msg,
            );
            if (_mapHit > _perLineN) {
              _auditStepP("line_station_map_gap", clean + " 押" + _perLineN + "<地図" + _mapHit);
            }
          }
        } catch (_) {}
        _okMark();
        return;
      }

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
            if (!inp.checked) _toggleCheckboxLikeHuman(inp, true, _stGapMin(), _stGapMax());
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
      if (pinp && !pinp.checked) { enqueueHumanClick(pinp, _clickEl, _uiGapMin(), _uiGapMax(), null, _uiGapOpts()); pass0clicked = true; }
      else if (pinp && pinp.checked) { pass0clicked = true; } // checked済みも成功（再クリック禁止）
      else if (!pinp) { enqueueHumanClick(townLabels[pi], _clickEl, _uiGapMin(), _uiGapMax(), null, _uiGapOpts()); pass0clicked = true; }
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
          /**
           * ★ 2026-11-16 統括「カーソル62%・押した位置28%」:
           *   旧は町字フォールバックで `inp.click()` 直押し → 人間らしさの穴。
           *   → カーソルキュー経由（aim は enqueue 側で自動引き）。
           */
          if (inp) {
            if (!inp.checked) enqueueHumanClick(inp, _clickEl, _uiGapMin(), _uiGapMax(), null, { strictLo: true, sigma: 0.55, keys: [clean, "town_code[]"] });
            return true;
          }
          enqueueHumanClick(labels[i], _clickEl, _uiGapMin(), _uiGapMax(), null, { strictLo: true, sigma: 0.55, keys: [clean] });
          return true;
        }
      }
      return false;
    }
    function tryEl(matchFn) {
      var els = Array.prototype.slice.call(document.querySelectorAll('a,div,span,td,li,button,p'));
      for (var i = 0; i < els.length; i++) {
        if (!isVisible(els[i])) continue;
        var txt = els[i].textContent.replace(/\s+/g, '');
        if (matchFn(txt)) {
          enqueueHumanClick(els[i], _clickEl, _uiGapMin(), _uiGapMax(), null, { strictLo: true, sigma: 0.55, keys: [clean] });
          return true;
        }
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
          if (inp && !inp.checked) {
            enqueueHumanClick(inp, _clickEl, _uiGapMin(), _uiGapMax(), null, { strictLo: true, sigma: 0.55, keys: [clean, "town_code[]"] });
            return true;
          }
        }
        try {
          enqueueHumanClick(all[i], _clickEl, _uiGapMin(), _uiGapMax(), null, { strictLo: true, sigma: 0.55, keys: [clean] });
          return true;
        } catch (e) {}
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
  /**
   * ★ 2026-11-20 竹内さん「連続でお客さんちゃんと検索できるように」:
   *   ホーム→「住居検索」でページが本当に移ると、入力の途中（このファイルの中身）が消え、
   *   誰も入力の指示を送り直さないので background が 30分待ってからそのお客さんを飛ばしていた。
   *   → 移る前に {番号・条件} を sessionStorage に置き、移った先で読み込み時に同じお客さんの入力を続ける（90秒以内・1回だけ）。
   */
  var _AX_REFILL_KEY = "axlx_refill_after_nav";
  (function _resumeFillAfterNav() {
    var raw = null;
    try { raw = sessionStorage.getItem(_AX_REFILL_KEY); } catch (_) { raw = null; }
    if (!raw) return;
    try { sessionStorage.removeItem(_AX_REFILL_KEY); } catch (_) {}
    var j = null;
    try { j = JSON.parse(raw); } catch (_) { j = null; }
    if (!j || !j.cond || !j.at || Date.now() - Number(j.at) > 90000) return;
    var tries = 0;
    var go = function () {
      tries++;
      var formReady = !!(document.querySelector('select[name="rental_cost2"]') || document.querySelector('input[name="city_code[]"]') || document.querySelector('div.go_search'));
      var guideKnown = document.documentElement.getAttribute("data-axlx-guide") != null;
      if ((!formReady || !guideKnown) && tries < 30) { setTimeout(go, 500); return; }
      if (!formReady || window._axFillRunning) return;
      console.log("[AX] 住居検索へ移った後 → 同じお客さんの入力を続けます " + String(j.cid || "-").slice(0, 8));
      try { window.postMessage({ from: "aixlinx-fill", conditions: j.cond, customerId: j.cid || null, resumedAfterNav: true }, "*"); } catch (_) {}
    };
    setTimeout(go, 800);
  })();

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
      /** トップページへ戻すリンクは絶対に押さない（自動途中でホームへ戻る事故の予防） */
      var notTop = function (e) {
        var t = norm(e.textContent || '');
        if (t === 'トップページ' || t === 'トップ' || t === 'ホーム' || t === 'home') return false;
        try {
          var href = (e.getAttribute && e.getAttribute('href')) || (e.closest && e.closest('a') && e.closest('a').getAttribute('href')) || '';
          if (/main\.php\/?$/.test(String(href)) && !/[?&]method=/.test(String(href))) return false;
        } catch (_) {}
        return true;
      };
      var inner = function (e) {
        return !Array.prototype.some.call(e.children || [], function (c) {
          return norm(c.textContent || '') === norm(e.textContent || '');
        });
      };
      var exact = function (want) {
        return vis.filter(function (e) { return norm(e.textContent || '') === want && inner(e) && notTop(e); })[0] || null;
      };
      var b = exact('住居検索') || exact('住居') || exact('住居（賃貸）') || exact('賃貸');
      if (b) return b;
      // ③ 左端のメニュー（x が 220px より左）で「住居」を含む物
      var left = vis.filter(function (e) {
        try {
          var r = e.getBoundingClientRect();
          if (!r || r.left > 220 || r.width > 160) return false;
          if (!notTop(e)) return false;
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
    // ★ 2026-11-16: お客・検索ごとにカーソル出発点を変える（軌跡がクローンにならない）
    try { _resetHumanPointerForRun(); } catch (_) {}
    /**
     * ★ 2026-11-17: 反映関所は監査リセット後・キュー先頭で行う（旧はリセット前に測り screen=0 のまま押し始めていた）。
     */
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
     * ★ 2026-11-16 連続客: **先に前客を閉じる**（点検リセットの前）。
     *   旧は先に _auditReset すると、supersede の fill-done に次客の空点検が載る。
     */
    if (window._axFillRunning) {
      var _runCid = window._axFillRunningCustomerId || null;
      var _newCid = _fillCustomerId || null;
      // 片方だけ番号が無い＝別の人として扱う（customer-handoff.js の pageIncomingDecision と揃える・2026-11-20）
      var _diffCust = !!((_runCid || _newCid) && String(_runCid || "") !== String(_newCid || ""));
      if (_diffCust) {
        /**
         * ★ 2026-11-18 竹内さん「ちゃんと選択したお客さんで検索されるようにする」（平田さん・R.さんの取り違え）:
         *   旧は前客の入力を**閉じて**次客を始めていた。その時 `_fillCustomerId` は既に次客の番号に変わっていて、
         *   前客（平田さん）の検索・結果に次客（R.さん）の条件・番号が付いた＝別のお客さんに送られる経路。
         *   → 入力中の別のお客さんの依頼は**始めない**（上書きしない）。印は前客に戻す。
         *   次客は一括側が待つ（前客が終わってから）。
         */
        console.warn("[AX] 前客の入力中 → 次客は始めません（上書きしない） run=" + String(_runCid).slice(0, 8) + " next=" + String(_newCid).slice(0, 8));
        _fillCustomerId = _runCid;
        try { if (_audit) _auditStepP("next_customer_refused", "前客入力中→次客を断った（上書きしない） next=" + String(_newCid).slice(0, 8)); } catch (_) {}
        try {
          window.postMessage({
            from: "aixlinx-fill-done", gate: true, gateKind: "busy_other_customer", customerId: _newCid,
            error: "busy_other_customer: 前のお客さんの条件入力中のため、このお客さんは始めませんでした（上書きしない）",
          }, "*");
        } catch (_) {}
        return;
      } else {
        console.warn('[AX] fillRealpro 重複呼び出しを無視 (既に実行中・同客)');
        /**
         * 2026-11-14: 同客の重複は notifyDone しない（1回目の段を壊さない）。
         * ★ 2026-11-16: 別客なら上で superseded → 次客 fill へ。
         */
        try { if (_audit && _audit.steps) { _audit.steps.push({ at: Date.now(), k: "duplicate_ignored", d: null }); if (_audit.steps.length > 60) _audit.steps.shift(); } } catch (_) {}
        return;
      }
    }
    /**
     * 2026-11-14: 重複を抜けたあと／新規で点検を作る。
     *   （連続切替の supersede 後は次客用に作り直す）
     */
    try { _auditReset(cond && cond._audit_run_id); } catch (_) {}
    _axHumanTookOver = false;
    _axFillStartedAt = Date.now();
    try { window.__axlxFillTouchAt = _axFillStartedAt; } catch (_) {}
    window._axFillRunning = true;
    try { window.__axlxFillGen = (Number(window.__axlxFillGen) || 0) + 1; } catch (_) {}
    try { _axPanelDebt = null; } catch (_) {} // ★ 客ごとにパネル負債をリセット（根本仕組み）
    /**
     * ★ 2026-11-17 竹内さん「前客→新客／各ボタン理解」:
     *   切替把握を fill 開始直後に残す（残チェック・forceClear・want）。
     *   ボタン理解台帳も客ごとにリセット。
     */
    try {
      var _prevCid = _lastFilledCidLoad() || window._axFillRunningCustomerId || null;
      var _nextCid = _fillCustomerId || null;
      window.__axlxBtnUnderstood = {};
      /** ★ F45: 客ごとに流れ完了台帳をリセット（前客の完了印を持ち越さない） */
      window.__axlxFlowUnderstood = {};
      /** ★ F47: 全流れ地図原子・外し方も客ごとにリセット */
      window.__axlxFlowMapAtoms = {};
      window.__axlxClearMethodUnderstood = {};
      if (typeof _understandCustomerSwitch === "function") {
        _understandCustomerSwitch(_prevCid, _nextCid, cond);
      }
      if (_prevCid && _nextCid && String(_prevCid) !== String(_nextCid)) {
        try { _noteFlowAtom("switch", true, "前客→次客"); } catch (_) {}
      }
      _lastFilledCidSave(_nextCid);
      try {
        _fillCondForStamp = cond || null;
        _noteNowCustomer("fill_start", "検索開始");
        _auditFlowLearnReflect("fill_start");
        _auditFullFlowMapLedger("fill_start");
      } catch (_) {}
    } catch (_) {}
    try { window._axFillRunningCustomerId = _fillCustomerId || null; } catch (_) {}
    // ★ 2026-11-19 (2.8.125) ラン seed: 検索ごとに新しい persona（動きの癖）。計画(axlx_motion_plan)の run_seed が有れば pointer-ui が優先。
    try { window.__axlxRunId = String(_fillCustomerId || "c") + ":" + Date.now().toString(36) + Math.floor(Math.random() * 1e6).toString(36); } catch (_) {}
    /**
     * ★ 2026-11-16: 条件入力の開始を毎回知らせる（住居検索でページが変わっても bulk-dl が印を持つ）。
     *   検索前の一覧ダウンロードを止めるために必須。
     */
    /**
     * ★ 2026-11-16 勇気さん実測: initiated に customerId を載せる。
     *   bulk-dl が popup/storage（次客に切替済み）を読まず、この回の客で送る相手を固定する。
     */
    try {
      window.postMessage({
        from: "axlx-autofill-initiated",
        customerId: _fillCustomerId || null,
        customerName: (typeof cond === "object" && cond && cond.customer_name) ? cond.customer_name : null,
      }, "*");
    } catch (_) {}
    /**
     * 2026-11-14: ここから**自動で入れる**ので、入れた物を覚える（人が選んだ物と区別する）。
     *   ⚠ 覚えていないと、次にモーダルを開いた時に「前の残り」と区別できず、
     *     **人が選んだ地域まで消してしまう**（竹内さん「自動で消してしまっている」）。
     */
    try {
      window._axAutoPicking = true;
      window.__axlxForceClearAllPlace = true; // 続き客: 前客の地域/駅を全部やりなおす
      _resetAutoPicked();
      try { if (_audit) _auditStepP("place_redo", "続き客: 前の地域/駅を外してから新しい条件を選ぶ"); } catch (_) {}
    } catch (_) {}
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
      /**
       * 2026-11-16 竹内さん「自動途中でトップに戻る」:
       *   旧はホーム→住居検索の移り中に **fill-started を送っていなかった**。
       *   background は 25秒で no_fill_start → tab_reload（裸 main.php）→ **トップへ戻す競争**になっていた
       *   （録画 05:20: 左の住居検索｜a.text の直後に空ショット／監査 tab_reload）。
       *   → 住居検索へ移る**前に** fill-started を送り、読み直し競争を止める。
       */
      try {
        window.postMessage({ from: 'aixlinx-fill-started', customerId: _fillCustomerId || null, runId: _fillRunId || null, phase: 'go_estate' }, '*');
      } catch (_) {}
      try { _auditStepP('go_estate_wait', 'ホーム→住居検索（fill-started送信済）'); } catch (_) {}
      /**
       * ★ 2026-11-18: ホーム画面は旧フローで learn_reflect_gate が未到達（v2.8.95 learn_warm=0）。
       *   住居遷移の前に束温め＋反映関所を終える（ページ遷移で Main が切れても cache に残す）。
       */
      var _goEstateAfterLearn = function () {
        // ページが本当に移ると、この入力（page-script の中身）は全部消える → 移った先で同じお客さんの入力を続ける控え
        try {
          sessionStorage.setItem(_AX_REFILL_KEY, JSON.stringify({ cid: _fillCustomerId || null, cond: cond, at: Date.now() }));
        } catch (_) {}
        ensureRealproSearchPage(cond, function (ok) {
          if (!ok) {
            window._axFillRunning = false;
            notifyDone('no_search_form: リアプロがホームの画面のままで、住居ボタンから物件検索へ移れませんでした');
          }
        });
      };
      try {
        enqueueHumanAction(function () { return _ensureLearnReflectedForFill(); }, 300, 800, "learn_reflect_gate");
        whenClickQueueIdle(_goEstateAfterLearn);
      } catch (_) {
        _ensureLearnReflectedForFill().then(_goEstateAfterLearn, _goEstateAfterLearn);
      }
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
    try { sessionStorage.removeItem(_AX_REFILL_KEY); } catch (_) {} // 検索の画面で入力を始めた＝移り先の控えは要らない
    clearClickQueue(); // 前回実行の残留クリックキューを破棄（誤クリック防止）
    // fill-done 保証: 実行開始時にフラグをリセットし、フェイルセーフを仕掛ける
    // （background.js 側のタイムアウトより必ず先に発火させる）
    // 2026-11-10 v2.5.96: 駅を1つずつ人の速さ（420〜1100ms）で選ぶので、沿線の全駅を選ぶと 40〜110秒かかる。
    // 2026-11-10 v2.6.14 竹内さん「人間のように」で全操作が人の速度になったので、総時間の上限を15分に延ばした
    //   （background の 905秒より10秒先）。ただし**無進捗で止まった時**は下の _stallWatch が先に止める（15分待たない）。
    _doneNotified = false;
    _axExpect = null; _axGateRetried = false; _axGateRetryN = 0; // v2.5.50 検索を押す前の関所の材料（このお客様の分を下で置く）
    _axPlaceReady = false; // ★ 続きの客でも場所→条件→検索。前客の「場所済み」を引きずらない
    _axConditionsReady = false; // ★ 間取り・敷礼まで終わる前に25秒保険で検索しない
    _stationPickSeen = false; // ★ 次客でも駅の「最初の1つを探す間」を入れる
    try {
      window.__axlxForceClearAllPlace = true;
      window.__axlxNeedClearWard = true;
      window.__axlxNeedClearStation = true;
      // 続き客: 沿線・駅の「全部外し→入れ直し」は客ごとに1回だけ（ポーリングで繰り返し外さない）
      window.__axlxLineForceClearedOnce = false;
      window.__axlxStationForceClearedOnce = false;
      window.__axlxLineWaitN = 0;
      window.__axlxLineRepressN = 0;
      window.__axlxLineStuckSent = false;
      window.__axlxLineOverlapSent = false;
      window.__axlxLinePickedRun = {};
      window.__axlxStListSig = null;
      window.__axlxStAbsentSent = false;
      window._axPreSearchWalkSealed = false;
      window._axWalkUiSealedOnce = false;
      window._axSearchPressedAt = 0;
      window._axStDiagDone = false;
    } catch (_) {}
    /**
     * ★ 2026-11-19 入れたものの台帳: 前客の控えを読んでから（消す前に）、今回の台帳を新しく始める。
     *   読み込み元は sessionStorage（ページが読み直されても残る）。同じページ内の前客は覚え（_axStationPicked 等）も足す。
     */
    try {
      // 前客の保存待ち（1.2秒後に書く分）は、前客の番号のまま今ここで書き切る
      try { if (_axLedgerTimer) { clearTimeout(_axLedgerTimer); _axLedgerTimer = null; _ledgerSave("flush_on_switch"); } } catch (_) {}
      var _pl = _ledgerLoad();
      try {
        var _pkPrev = _pickedCounts();
        if ((_pkPrev.station > 0 || _pkPrev.ward > 0)) {
          _pl = _pl || { at: Date.now(), n: { stations: 0, lines: 0, wards: 0, towns: 0, layouts: 0, structured: 0, pet: 0, shikirei: 0 }, names: [] };
          _pl.n.stations = Math.max(_pl.n.stations || 0, _pkPrev.station);
          _pl.n.wards = Math.max(_pl.n.wards || 0, _pkPrev.ward);
          /**
           * ★ 2026-11-20 竹内さん「前のお客さんと今検索しているお客さんの把握する力がかなり弱い」:
           *   同じページ内の前客の覚え（押した駅・区の名前）も台帳の名前に足す（数だけだと「何を外すか」が分からない）。
           */
          try {
            var _nm = Array.isArray(_pl.names) ? _pl.names.slice() : [];
            var _addNm = function (kind, map) {
              Object.keys(map || {}).forEach(function (k) {
                var t = String(((map[k] || {}).text) || k).slice(0, 16);
                var key = kind + ":" + t;
                if (t && _nm.indexOf(key) < 0) _nm.push(key);
              });
            };
            _addNm("駅", _axStationPicked);
            _addNm("区", _axWardPicked);
            _pl.names = _nm.slice(0, 40);
          } catch (_) {}
        }
      } catch (_) {}
      window.__axlxPrevLedger = _pl;
      _ledgerReset();
      var _curCid = String(window._axFillRunningCustomerId || (typeof _fillCustomerId !== "undefined" ? _fillCustomerId : "") || "");
      _axLedgerCid = _curCid;
      _axLedgerWant = _wantOfCond(cond);
      if (_pl) {
        try {
          var _prevCid = String(_pl.cid || "");
          var _who = !_prevCid ? "前客=不明" : (_curCid && _prevCid === _curCid ? "前客=同じお客さん（やり直し）" : "前客=" + _prevCid.slice(0, 8) + "→今客=" + (_curCid ? _curCid.slice(0, 8) : "不明"));
          var _df = _wantDiff(_pl.want || null, _axLedgerWant);
          var _dfTxt = _pl.want
            ? " 前客の希望→今客: 外す候補 区" + _df.dropWards.length + "・駅" + _df.dropStations.length + "／共通" + _df.keep
              + (_df.dropStations.length ? "（" + _df.dropStations.slice(0, 6).join("・") + "）" : "")
            : " 前客の希望=控え無し";
          _auditStepP("leftover_ledger", _who + " 入れた控え 駅" + ((_pl.n && _pl.n.stations) || 0) + "・沿線" + ((_pl.n && _pl.n.lines) || 0) + "・区" + ((_pl.n && _pl.n.wards) || 0) + "・間取り" + ((_pl.n && _pl.n.layouts) || 0)
            + (Array.isArray(_pl.names) && _pl.names.length ? " [" + _pl.names.slice(0, 10).join("・") + "]" : "") + _dfTxt);
        } catch (_) {}
      }
    } catch (_) { window.__axlxPrevLedger = null; }
    // 2026-11-11: 前のお客様で選んだ区・駅の覚えを消す（このお客様の分だけを見る）
    _resetPicked();
    if (_watchdogTimer) clearTimeout(_watchdogTimer);
    _watchdogTimer = setTimeout(function _axWatchdogFire() {
      /**
       * ★ 2026-11-18 竹内さん「進捗あり・一連未完了では切らない」: 直近5分以内に操作（ops・進捗の心拍）がある間は
       *   中止せず1分ごとに見直す（硬上限＝入力開始から60分）。無進捗で30分／60分に達した時だけ下の中止へ進む。
       */
      try {
        var _wdNow = Date.now();
        var _wdLast = Math.max(
          (_audit && _audit._opsProgAt) || 0,
          (_audit && _audit._progAt) || 0,
          (_audit && _audit.ops && _audit.ops.length) ? (_fillStartedAt + Number(_audit.ops[_audit.ops.length - 1].t || 0)) : 0
        );
        var _wdActive = (_wdLast && _wdNow - _wdLast < 5 * 60 * 1000) || isClickQueueBusy();
        if (!_doneNotified && _wdActive && _wdNow - _fillStartedAt < 60 * 60 * 1000) {
          console.warn('[AX] フェイルセーフ到達だが進捗あり（' + Math.round((_wdNow - _wdLast) / 1000) + '秒前）→ 切らずに1分後に見直す');
          try { _auditStepP('watchdog_extend', '進捗あり・中止せず延長'); } catch (_) {}
          _watchdogTimer = setTimeout(_axWatchdogFire, 60000);
          return;
        }
      } catch (_) {}
      /**
       * ★ 2026-11-16 完走優先: 条件が揃っていれば切り上げず検索（カーソル経由の clickSearch）。
       *   未完了のときだけ中止（全件検索防止）。
       */
      try {
        if (_axConditionsReady && _axExpect && (!_axExpect.areaMode || _axPlaceReady) && !window._axSearchPressedAt) {
          var _wg = _axGateCheck();
          var _hard = _wg.errors.some(function (m) {
            var s = String(m);
            return s.indexOf('場所') === 0 || s.indexOf('間取り') === 0 || s.indexOf('敷金') === 0 || s.indexOf('礼金') >= 0;
          });
          if (!_hard) {
            console.warn('[AX] 1800秒・条件そろい → 完走のため検索（カーソル経由・切り上げない）');
            _auditStepP('watchdog_complete_search', '条件完了済み→clickSearch（カーソル移動）');
            try { clickSearch(); } catch (_) {}
            return;
          }
        }
      } catch (_) {}
      console.warn('[AX] フェイルセーフ: 1800秒経過 → 条件未完了のため中止（不完全検索を出さない）');
      _auditStall();
      notifyDone('watchdog-timeout: 1800秒以内に条件入力が完了しませんでした（全件検索防止のため中止）');
    }, 1800000); // ★ 2026-11-18: 895秒→30分（間取りリトライ・9区クリックが短TOで切れないように）
    // 2026-11-10 v2.6.15: 「住居」を押してページが移るとこの関数の続きは走らない。
    //   移った先の新しいページで fill がもう一度来た時に、前のページの見張りが残らないよう、
    //   ページを離れる時にタイマーを片付ける（見張りが二重に走って早く止まるのを防ぐ）
    try {
      if (!window.__axUnloadHooked) {
        window.__axUnloadHooked = true;
        window.addEventListener('pagehide', function () {
          try { _ledgerSave("pagehide"); } catch (_) {}
          if (_watchdogTimer) { clearTimeout(_watchdogTimer); _watchdogTimer = null; }
          if (window.__axStallWatch) { clearInterval(window.__axStallWatch); window.__axStallWatch = null; }
          if (window.__axFastSearchWatch) { clearInterval(window.__axFastSearchWatch); window.__axFastSearchWatch = null; }
          /**
           * ★ 2026-11-18: 検索押下後に遷移で notifyDone が消えても、生存印だけは残す。
           */
          try {
            if (window._axSearchPressedAt && !_doneNotified) {
              _armPropertyPathBeforeSearch("pagehide生存");
            }
          } catch (_) {}
          window._axFillRunning = false;
        });
      }
    } catch (_) {}
    /**
     * ★ 2026-11-16 竹内さん「保険の部分が逆にボトルネック／途中で切り上げない／不完全な物件検索になる」:
     *   旧: 25秒で保険検索・180秒で中断 → 間取り・敷礼の前に検索／途中切り上げ＝不完全検索。
     *   新（完走優先）:
     *     ・本線は `_runDeferredBasicThenSearch` → `conditions_ready` → `clickSearch` だけ。
     *     ・保険は**控え**: 条件完了後に本線が押さなかった時だけ、長く待ってから押す（途中では絶対に押さない・中断しない）。
     *     ・場所〜基本条件の入力中は stall で切り上げない（タイマーを戻して待つ）。
     *     ・保険も本線も **clickSearch → enqueueHumanClick（カーソル移動してから検索）**。直接 .click() しない。
     */
    (function () {
      var _lastCount = -1, _sameSince = Date.now();
      var _searchPushed = false;
      var _idleSince = Date.now();
      /** 条件完了後、本線の clickSearch を待つ余裕（人が見直す間も含む） */
      var SEARCH_BACKUP_MS = 180000; // ★ 2026-11-18: 90秒→3分（本線待ちの控え）
      /** 条件未完了の間は切り上げない。完了後の無進捗だけ長く見る */
      var STALL_AFTER_READY_MS = 1200000; // ★ 2026-11-18: 20分（完走優先・短TO除去）
      function _fillStillRunning() {
        try {
          if (isClickQueueBusy()) return true;
          if (document.getElementById("axlx-fake-dd")) return true;
          if (!_axExpect) return true;
          if (_axExpect.areaMode && !_axPlaceReady) return true;
          if (!_axConditionsReady) return true;
          if (window.__axDeferredBasicQueue && window.__axDeferredBasicQueue.length) return true;
          var w = document.querySelector('.this_window, [role="dialog"], .modal, .modal_wrap');
          if (w && (w.offsetParent !== null || (w.getClientRects && w.getClientRects().length))) return true;
        } catch (_) {}
        return false;
      }
      var _fastWatch = setInterval(function () {
        try {
          if (_doneNotified || _searchPushed) { clearInterval(_fastWatch); return; }
          if (window._axSearchPressedAt) { _searchPushed = true; clearInterval(_fastWatch); return; }
          // 入力の途中は保険を動かさない（ボトルネックにしない）
          if (_fillStillRunning()) { _idleSince = Date.now(); return; }
          var opsN = _audit && _audit.ops ? _audit.ops.length : 0;
          if (opsN !== window.__axFastCount) { window.__axFastCount = opsN; _idleSince = Date.now(); return; }
          if (Date.now() - _idleSince < SEARCH_BACKUP_MS) return;
          var g = _axGateCheck();
          var hardMissing = g.errors.some(function (m) {
            var s = String(m);
            return s.indexOf('場所') === 0 || s.indexOf('間取り') === 0 || s.indexOf('敷金') === 0 || s.indexOf('礼金') >= 0;
          });
          if (hardMissing) {
            _auditStepP('search_backup_wait', '条件未完了のため控え保険は待つのみ: ' + g.errors.join(' / ').slice(0, 100));
            _idleSince = Date.now();
            return;
          }
          console.warn('[AX] 条件完了後 ' + (SEARCH_BACKUP_MS / 1000) + '秒 本線が押していない → 控えとして検索（カーソル経由）');
          _auditStepP('search_backup_press', '控え保険→clickSearch（カーソル移動・途中切り上げではない）');
          _searchPushed = true;
          clearInterval(_fastWatch);
          try { clickSearch(); } catch (_) {}
        } catch (_) {}
      }, 3000);
      window.__axFastSearchWatch = _fastWatch;
      window.__axStallWatch = setInterval(function () {
        try {
          if (_doneNotified) { clearInterval(window.__axStallWatch); return; }
          // 入力中・キュー中は「止まった」とみなさない（途中切り上げ禁止）
          if (_fillStillRunning()) { _sameSince = Date.now(); _lastCount = -1; return; }
          var n = _audit && _audit.ops ? _audit.ops.length : 0;
          if (n !== _lastCount) { _lastCount = n; _sameSince = Date.now(); return; }
          if (Date.now() - _sameSince < STALL_AFTER_READY_MS) return;
          var _gateNow = _axGateCheck();
          var _hardMissing = _gateNow.errors.some(function (m) {
            var s = String(m);
            return s.indexOf('場所') === 0 || s.indexOf('間取り') === 0 || s.indexOf('敷金') === 0 || s.indexOf('礼金') >= 0;
          });
          if (!_hardMissing && _axConditionsReady) {
            console.warn('[AX] 条件完了後の長待ち → 完走のため検索（カーソル経由・中断しない）');
            _auditStepP('stall_complete_search', '完走優先→clickSearch（カーソル移動・切り上げない）');
            try { clickSearch(); } catch (_) {}
            return;
          }
          // まだ条件が揃わない長待ち: 中断せず待ち続ける（不完全検索を出さない）
          _auditStepP('stall_keep_waiting', '条件未完了のため切り上げず待つ');
          _sameSince = Date.now();
        } catch (_) {}
      }, 5000);
    })();

    // 検索の点検: popup が載せた run_id（ブレインの時だけ）。無ければ記録しない
    _auditReset(cond && cond._audit_run_id);
    _auditStepP('fill_start', cond && cond.area_mode);
    _auditStepP('vis', document.visibilityState);
    /**
     * ★ 2026-11-17 統括Pro「強化は実装済だが反映一連が止まる」実測:
     *   2.8.76 自動で learn_reflect_gap（screen=0）・aim無が並んだ。
     *   原因: 束取込前に押し始め／監査リセットで warm 印が消える／別名未引き。
     *   → キュー先頭で強制取込＋warm＋反映関所。切替把握もここ（2回目リセット後）で残す。
     */
    try {
      window.__axlxLearnStationFlowNoted = false;
      var _prevCid2 = window.__axlxLastFilledCustomerId || null;
      var _nextCid2 = _fillCustomerId || null;
      if (typeof _understandCustomerSwitch === "function") {
        _understandCustomerSwitch(_prevCid2, _nextCid2, cond);
      }
    } catch (_) {}
    try {
      enqueueHumanAction(function () {
        return _ensureLearnReflectedForFill();
      }, 700, 1200, "learn_reflect_gate");
    } catch (_) {
      try { _ensureLearnReflectedForFill(); } catch (__) {}
    }
    /**
     * ★ 2026-11-15 竹内さん「検索の条件に、次の2つも並べる: その他の要望（other_requests を「・」で区切った1つずつ）／
     *   必須・できれば（requirement_strength）」（依頼2-3）
     *
   *   ⚠ 「その他の要望」は**自由文**（例: ペット可・上の階を希望・角部屋）なので、
   *     サイトの決まった欄には入れられない（無理に入れると検索が壊れる）。
     *   → **検索の直前に画面へ出す**（人が見て、必要な物だけ手で入れる）。
     *     ⚠ 消さない・押させない（見せるだけ・検索の邪魔をしない）。
     *     ⚠ 入力した中身は残さない（要望はお客様の情報なので、写真にもDBにも入れない）。
     */
    try { _showOtherRequests(cond); } catch (_) {}
    // 2026-09-27 v2.5.32 入力を始めた合図（content.js → background）。一括検索はこれが来なければタブを読み直して1回だけやり直す
    try { window.postMessage({ from: 'aixlinx-fill-started', customerId: _fillCustomerId || null, runId: _fillRunId || null }, '*'); } catch (_) {}
    _fillCondForStamp = cond || null; // 2026-11-10 検索の印（誰の一覧か）を notifyDone で書く時に使う
    if (!cond) { notifyDone(); return; }

    /**
     * 連続検索: モーダルを閉じる → **残っている条件を1つずつ外す** → 新お客さんの条件入力 → 検索
     *
     * ★【決まり・2026-11-18 竹内さん「リセットが壊れる原因の可能性高いので厳しければ外す形戻す」】
     *   2.8.105 で「リセットを先に押す」にしたが、リセットでページが読み直され入力が消えた（audit 1492・1494）→ 2.8.107 で戻した。
     *   → 前客の条件は **カーソルで1つずつ外す**（リセットは押さない）→ 新条件を入れる → 検索。
     *   細かい動きも通常と同じく **カーソルを動かしてからクリック**（直書きの checked=false 禁止）。
     *   正本: dept_search_tool 黄金ルール／.cursor/rules/auto-clear-not-reset.mdc
     */
    function _doReset(callback, _resetRound) {
      /**
       * ★ 2026-11-19 竹内さん「前のお客さんの条件が残っていると判断できる能力」「入れたのを覚えていたら外し忘れがなくなる」:
       *   外す前に**フォームを読んで台帳と突き合わせ**「何が残っているか・どこを外すか」を点検に残す。
       *   外し終えたら「きれいか」を確かめてから新条件へ進む（残りがあれば場所は専用の外し・チェック類は外しをやり直す）。
       */
      var _rr = Number(_resetRound) || 0;
      var _cb0 = callback;
      try {
        if (_rr === 0) {
          var _preS = _scanLeftoverForm();
          var _preP = _planLeftover(_preS, _axWantPlaceMode(cond), window.__axlxPrevLedger || null);
          if (_audit) _auditStepP("leftover_scan", _preP.summary);
        }
      } catch (_) {}
      callback = function () {
        try {
          _cleanStartGate(cond, _rr, _cb0, function () { _doReset(_cb0, _rr + 1); });
        } catch (_) {
          try { _cb0(); } catch (_e) {}
        }
      };
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
        // 2026-11-16: 生 click ではなくカーソル付き（人間らしさ・記録）
        var _showWait = humanRand(900, 1500);
        try {
          enqueueHumanClick(showFormBtn, _clickEl, _uiGapMin(), _uiGapMax(), null, _uiGapOpts());
          showFormDelay = _showWait;
          console.log("[AX] 検索条件を表示 クリック → フォーム展開待機 " + _showWait + "ms");
        } catch (e) { console.error("[AX] _doReset: 検索条件を表示クリックで例外（続行）", e); }
      }

      setTimeout(function() {
      // 検索条件を表示のキューが終わってからモーダル処理へ（enqueue と setTimeout の競合を防ぐ）
      whenClickQueueIdle(function() {

      // Step1: 開いているモーダルを先に閉じる
      /**
       * ★ 2026-11-20 竹内さん「最初画面おかしくなる問題がまだ残っている」:
       *   旧は文字「×とじる」の要素を全部「開いている検索のモーダル」とみなしていた。
       *   一覧の号室メニューの ×とじる（div.hide_room_menu_close）も当たり（今日の5回すべて入力開始の約5秒後に押していた）、
       *   さらに下の「駅→沿線を外す」が閉じた小窓の見えない駅へ画面を送って押していた（画面が飛ぶ・直接外しに見える）。
       *   → 検索の小窓の ×とじる だけを Step1 で扱う。号室メニューは画面に本当に出ている時だけ閉じ、駅・沿線には触らない。
       */
      var closeBtn = [].slice.call(document.querySelectorAll("a, button, div, span")).find(function(el) {
        var t = (el.textContent || "").trim();
        if (!((t === "× とじる" || t === "×とじる" || t === "とじる" || t === "閉じる") && el.offsetParent !== null)) return false;
        return !_isRoomMenuEl(el);
      });
      if (!closeBtn) {
        var _rmClose = _roomMenuCloseOnScreen();
        if (_rmClose) {
          try { if (_audit) _auditStepP("room_menu_close", "号室メニューが画面に出ている→閉じる（検索の小窓ではない・駅/沿線は触らない）"); } catch (_) {}
          enqueueHumanClick(_rmClose, _clickEl, _uiGapMin(), _uiGapMax(), null, _uiGapOpts());
        }
      }
      var closeDelay = 0;
      if (closeBtn) {
        // ★ 修正: モーダルが開いている場合、閉じる前に路線・駅の選択をクリア
        // リアプロのモーダルはJS内部状態を持ちフォームDOM操作では消えないため
        // 閉じる前にlabel.one_line（路線）とstation_code[]（駅）をクリックして解除する
        try {
          /**
           * ★ 2026-11-17: モーダルが沿線画面のまま閉じると駅が残る。
           *   駅が見えるなら駅→沿線。沿線だけ見えるなら「駅の設定へ」経路は STEP B に任せ、
           *   ここでは見える分だけ駅優先で外し、閉じる（完全クリアは次回 open の状態機械）。
           */
          var _stVis0 = _visStationLabels();
          if (_stVis0.length) {
            _uncheckStationsThenLinesLikeHuman({ forceAll: true });
            console.log("[AX] _doReset: 駅ページ可視 → 駅→沿線を1つずつ外す");
          } else if (_visLineLabels().length) {
            // 沿線画面: 閉じる前に沿線だけ外さない（駅が残る）。旗を立てて次回 open で経由外し
            try {
              window.__axlxNeedClearStation = true;
              window.__axlxPlaceClearPhase = "start";
              window.__axlxLineForceClearedOnce = false;
              window.__axlxStationForceClearedOnce = false;
            } catch (_) {}
            console.log("[AX] _doReset: 沿線画面のため駅経由クリアを次回へ（沿線直外ししない）");
          } else {
            _uncheckStationsThenLinesLikeHuman({ forceAll: true });
          }
        } catch (_e) { /* ignore */ }
        // 閉じるもカーソル付き（生 click 禁止）
        enqueueHumanClick(closeBtn, _clickEl, _uiGapMin(), _uiGapMax(), null, _uiGapOpts());
        closeDelay = _ln(520, 0.4, 320, 950);
      }

      setTimeout(function() {
        // モーダル内クリア＋閉じるのキューが全て消化されてからフォームクリアへ進む
        whenClickQueueIdle(function() {
        try {
        /**
         * ★ 2026-11-17 通常録画正本（01:18）＋竹内さん「駅は直接入力で外されている」:
         *   駅・沿線は form の checked をここで外すと「直接入力」に見える。
         *   → station_id[] / route_id[] は残チェック外しから**除外**し、
         *     旗を立てて STEP B の `_advanceForcePlaceClearViaStationFirst`
         *     （駅の設定へ→駅外し→沿線の設定へ戻る→沿線外し）に任せる。
         */
        var checkboxNames = [
          "city_code[]", "town_code[]",
          "room_layout_id[]", "structured_type[]", "eq_rm[]",
        ];
        try {
          var _stLeft = document.querySelectorAll('input[name="station_id[]"]:checked').length;
          var _lnLeft = document.querySelectorAll('input[name="route_id[]"]:checked').length;
          if (_stLeft > 0 || _lnLeft > 0) {
            window.__axlxNeedClearStation = true;
            window.__axlxPlaceClearPhase = "start";
            window.__axlxLineForceClearedOnce = false;
            window.__axlxStationForceClearedOnce = false;
            window.__axlxPlaceClearBegan = false;
            if (_audit) {
              _auditStepP(
                "station_defer_form_clear",
                "form残 駅" + _stLeft + "・沿線" + _lnLeft + "→駅画面経由で外す（直接外ししない）",
              );
            }
            console.log("[AX] _doReset: 駅/沿線の form残は駅画面経由クリアへ委譲", _stLeft, _lnLeft);
          }
        } catch (_) {}
        var _H0 = window.AxlxHumanWait;
        /**
         * 2026-11-16 竹内さん「リセットではなくて外して新しいお客さんの条件入れて検索」:
         *   前客のチェックを **見えるラベルへカーソルを動かしてから** 1つずつ外す（直書き禁止）。
         *   チェック本体が隠れている事があるので、label を狙う。
         */
        function _uncheckLeftoversThenRest() {
          /**
           * ★ 2026-11-20 (2.8.135) 竹内さん「次のお客さんにいくために外す部分…直接入力になってしまっている」:
           *   実測 #1544: 間取り→絞り込み条件（ペット）→所在地 の箱を**先に全部開けて**からまとめて外していた。
           *   後から開けた所在地の小窓が絞り込み条件を隠し、ペット相談は見えないまま
           *   `hidden_press`（カーソル無しで押した）になっていた。所在地の＋も2回押して開くのに 4.7秒かかっていた。
           *   → 箱ごとに「開ける→その中を1つずつ外す→確定」してから次の箱へ（人と同じ順）。
           *   onlyRe: この段で外す欄の名前／skipRe: 前の段で扱った欄（残っても見えない時に直接押さない）。
           */
          var _clearedAny = false;
          var _runUncheck = function (onlyRe, skipRe, after) {
            var _next = typeof after === "function" ? after : _resetRest;
            var _toUncheck = [];
            /**
             * ★ 2026-11-20 竹内さん「所在地のところ直接入力…1つずつおすようにする」:
             *   区・町・駅・沿線は小窓の中にあり、閉じている間は label が見えない（押すとカーソル無しの直接入力になる）。
             *   → 見えていない場所の欄はここでは外さず、小窓を開いて外す係（_clearWardsBeforeStationThen・
             *     _clearStationsBeforeWardThen・所在地/沿線の小窓の外し）に任せる。見えている物だけここで外す。
             */
            var _hiddenPlace = 0;
            checkboxNames.forEach(function (name) {
              if (onlyRe && !onlyRe.test(name)) return;
              if (skipRe && skipRe.test(name)) return;
              [].slice.call(document.querySelectorAll("input[name='" + name + "']:checked")).forEach(function (cb) {
                if (/city_code|town_code|station_id|route_id/.test(name)) {
                  var _lb = null;
                  try { _lb = _labelForCheckbox(cb); } catch (_) { _lb = null; }
                  if (!(_lb && isVisible(_lb)) && !isVisible(cb)) { _hiddenPlace++; return; }
                }
                _toUncheck.push(cb);
              });
            });
            if (_hiddenPlace > 0) {
              try { _auditStepP("reset_skip_hidden_place", _hiddenPlace + "件（小窓を開いて外す係に任せる）"); } catch (_) {}
            }
            if (_toUncheck.length === 0) {
              console.log("[AX] _doReset: 残チェックなし → 次へ");
              _auditStepP("clear_checks", 0);
              if (!_clearedAny) { try { _noteClearMethod("place", "clean_no_clear", "残0"); } catch (_) {} }
              _next();
              return;
            }
            console.log("[AX] _doReset: 残チェック " + _toUncheck.length + "件を1つずつ外す（リセットボタンは使わない）");
            _auditStepP("clear_checks", _toUncheck.length);
            _clearedAny = true;
            var _needPanelConfirm = false;
            _toUncheck.forEach(function (cb, idx) {
              var hit = null;
              try {
                var nm = String((cb && cb.getAttribute && cb.getAttribute("name")) || "");
                if (/eq_rm|city_code|town_code/.test(nm)) _needPanelConfirm = true;
                if (cb.id) {
                  var lb = document.querySelector('label[for="' + String(cb.id).replace(/"/g, "") + '"]');
                  if (lb) hit = lb;
                }
                if (!hit) hit = (cb.closest && cb.closest("label")) || cb.parentElement || cb;
              } catch (_) { hit = cb; }
              var lo = idx < 8 ? 420 : 180;
              var hi = idx < 8 ? 980 : 420;
              enqueueHumanClick(hit, function () {
                try {
                  if (cb && cb.isConnected && cb.checked) {
                    if (typeof window.__axlxRecNoteOp === "function") window.__axlxRecNoteOp("click", cb);
                    try { _noteClearMethod(_intentDomainOfName(nm, cb), "cursor_checkbox", String(cb.value || nm || "").slice(0, 24)); } catch (_) {}
                    if (hit && hit !== cb && hit.isConnected) {
                      try { hit.click(); } catch (_) {}
                    }
                    // label が外すのが遅れる事がある: すぐ input も押すと戻ってしまうので、少し待って残っていた時だけ
                    var _isLabel = !!(hit && hit !== cb && String(hit.tagName || "").toUpperCase() === "LABEL");
                    if (!_isLabel) {
                      if (cb.checked) { try { cb.click(); } catch (_) {} }
                    } else {
                      /**
                       * ★ 2.8.136: 旧は 320ms 後に残っていれば input を直接押していた（カーソルの押す動き無し）。
                       *   サイトの反応が遅い時は外れた後に押して付け直す恐れもある（実測 run_mwofi2sn_jbec で同じ区を3回押した記録）。
                       *   → 2回確かめてから、カーソルの押す動き付きで1回だけ押し直す。
                       */
                      setTimeout(function () {
                        try {
                          if (!(cb.isConnected && cb.checked)) return;
                          setTimeout(function () {
                            try {
                              if (!(cb.isConnected && cb.checked)) return;
                              try { _auditStepP("clear_retry_press", String(cb.value || nm || "").slice(0, 24) + " ラベルで外れず→カーソルで押し直し"); } catch (_) {}
                              try { _tapIfCursorOn(hit); } catch (_) {}
                              cb.click();
                            } catch (_) {}
                          }, _ln(450, 0.3, 300, 800));
                        } catch (_) {}
                      }, 320);
                    }
                  }
                } catch (_) {}
              }, lo, hi);
            });
            /**
             * ★ 2026-11-17 通常正本 PET→CONFIRM / WARD→CONFIRM:
             *   絞り込み条件・所在地を開いて外したあと、確定してリストへが無いと条件が残る／録画にも出ない。
             *   → パネルを開いた系を外したら必ず確定を押してからセレクト外しへ。
             */
            whenClickQueueIdle(function () {
              // ★ 根本: 場当たり必押ではなくパネル負債清算（開いていれば確定／閉じていれば何もしない）
              if (_needPanelConfirm || _axPanelDebt) {
                _settlePanelDebtThen("前客クリア後のパネル清算", function () {
                  try { if (_audit) _auditStepP("clear_panel_confirm", "外し後に確定してリストへ（負債清算）"); } catch (_) {}
                  _next();
                });
                return;
              }
              _next();
            });
          };
          /**
           * ★ 2026-11-16 細分化: 外す前に該当パネルを開く（間取り／沿線駅／所在地）。
           *   畳んだままだと label が押せない＝前客条件が残る原子。
           */
          var _openThenUncheck = function () {
            var chain = Promise.resolve(true);
            /**
             * ★ 2.8.135: 箱ごとの段（開ける→外す→確定→次の箱）。
             *   ★ 2026-11-17: 駅・沿線は form直外ししない（駅画面経由）。ここでは開かない。
             *   ペット(eq_rm)は通常録画どおり「絞り込み条件＋」を開いてから外す。
             */
            var _stage = function (sel, name, onlyRe) {
              chain = chain.then(function () {
                var el = null;
                try { el = document.querySelector(sel); } catch (_) { el = null; }
                if (!el) return true;
                try { _auditStepP("clear_stage", name + " を開けて外す"); } catch (_) {}
                return _ensureFieldVisible(el, name, 4000).then(function () { return true; }, function () { return false; })
                  .then(function () {
                    return new Promise(function (resolve) { _runUncheck(onlyRe, null, function () { resolve(true); }); });
                  });
              });
            };
            _stage('input[name="room_layout_id[]"]:checked', "room_layout_id[]", /^room_layout_id/);
            _stage('input[name="eq_rm[]"]:checked', "eq_rm[]", /^eq_rm/);
            _stage('input[name="city_code[]"]:checked, input[name="town_code[]"]:checked', "city_code[]", /^(city_code|town_code)/);
            var _rest = function () { _runUncheck(null, /^(room_layout_id|eq_rm|city_code|town_code)/, _resetRest); };
            chain.then(_rest, _rest);
          };
          _openThenUncheck();
        }
        /**
         * ⚠ 自動は「リセット」ボタンを押さない（2026-11-18 2.8.105 で押す形にして 2.8.107 で戻した）。
         *   実測 audit 1492・1494: リセットを押した1〜3秒後に入力の段も録画の操作も途絶え、そのお客さんの入力が消えた
         *   （リアプロのリセットはページを読み直す＝入力中の自動が丸ごと消える）。前の条件は1つずつ外す。
         */
        _uncheckLeftoversThenRest();

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
        // 敷礼なし：生 click ではなくカーソル付き（人が外すのと同じ）
        ;(function() {
          var sInp = _findShikireiCheckbox();
          if (sInp && sInp.checked) enqueueHumanClick(sInp, _clickEl, _uiGapMin(), _uiGapMax(), null, _uiGapOpts());
        })();

        // セレクト系をリセット（structured_date=築年数 / square_meter=面積 も select要素）
        // update_date: 前顧客の更新日フィルターが残留すると次顧客の検索が絞られるバグの修正
        /**
         * 2026-11-11／2026-11-16: セレクト・テキストも**1つずつ**。
         *   セレクトは **click → selectedIndex=0 → change**（押さず変化にしない＝学習・監査が人と同じ）。
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
        /**
         * セレクト外し: OSのプルダウンを開かない（mousedown禁止）。
         * カーソルを欄へ動かしてから先頭へ戻す（人が欄を見て消す形）。
         * テキストも欄へフォーカスしてから空にする。
         */
        (function _clearSelectsAndTextsOneByOne(i) {
          if (i >= _clearTargets.length) {
            whenClickQueueIdle(function () {
              console.log("[AX] 前客の条件を外し完了 → 新条件の入力開始");
              _auditStepP("clear_done", null);
              var _look = _ln(650, 0.4, 380, 1300);
              if (Math.random() < 0.10) _look += 900 + Math.floor(Math.random() * 1700);
              setTimeout(callback, _look);
            });
            return;
          }
          var t = _clearTargets[i];
          var next = function () { setTimeout(function () { _clearSelectsAndTextsOneByOne(i + 1); }, _ln(220, 0.35, 120, 480)); };
          if (t.kind === "select") {
            /**
             * ★ 2026-11-16 直接入力改善: 先頭へ戻すのも擬似一覧＋カーソル（selectedIndex=0 だけにしない）。
             */
            var _clrVal = "";
            try { _clrVal = t.el.options && t.el.options[0] ? String(t.el.options[0].value) : ""; } catch (_) { _clrVal = ""; }
            Promise.resolve(chooseSelectLikeHuman(t.el, _clrVal, { forceOpen: true }))
              .then(next, next);
          } else {
            _operateWithPointer(t.el, function () {
              return typeTextLikeHuman(t.el, "", { alreadyAimed: true });
            }).then(next, next);
          }
        })(0);
      } // _resetRest end（関数宣言に変えた・2026-11-14）
        } catch (err) {
          // クリア失敗でも条件入力は続行する（静かに停止すると fill-done が来なくなる）
          console.error("[AX] _doReset クリア中の例外（続行）", err);
          if (_audit) _audit.reset_fail = 'フォームのクリアで例外: ' + String((err && err.message) || err).slice(0, 120);
          setTimeout(callback, _ln(650, 0.4, 380, 1300));
        }
        }); // whenClickQueueIdle end（フォームクリア）
      }, closeDelay);

      }); // whenClickQueueIdle end（検索条件を表示の後）
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

    /**
     * ★ 2026-11-15／2026-11-16: 続き客は反対側の場所も外す（地域↔駅）。
     *   ⚠ 旧バグ1: `hasStation` 等を**宣言より前**に参照していた（常に undefined → フラグがほぼ立たない）。
     *   ⚠ 旧バグ2: `__axlxNeedClearWard` / `__axlxNeedClearStation` を立てるだけで**読んでいなかった**。
     *   → 宣言を先にし、自動の続き客では両方クリアを必須にする。
     */
    var hasStation   = cond.station_names && cond.station_names.length > 0;
    var hasRoutes    = cond.route_ids && cond.route_ids.length > 0;
    var hasCities    = cond.city_codes && cond.city_codes.length > 0;
    try {
      var _wantStationMode = (cond.area_mode === "station") || ((hasStation || hasRoutes) && (cond.area_mode !== "ward"));
      var _wantWardMode = (cond.area_mode === "ward") || !!(hasCities || cond.detail_ward);
      // 続き客・自動: 前客の地域も駅もやりなおす（片方だけ外して検索しない）
      if (_shouldForceClearPrevPlace() || _wantStationMode) {
        try { window.__axlxNeedClearWard = true; } catch (_) {}
      }
      if (_shouldForceClearPrevPlace() || _wantWardMode) {
        try { window.__axlxNeedClearStation = true; } catch (_) {}
      }
      if (_audit && (_wantStationMode || _wantWardMode || _shouldForceClearPrevPlace())) {
        _auditStepP(
          "place_side_clear",
          "ward清=" + !!window.__axlxNeedClearWard + " station清=" + !!window.__axlxNeedClearStation
            + " want=" + (_wantStationMode ? "station" : (_wantWardMode ? "ward" : "auto")),
        );
      }
    } catch (_) {}
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
      /**
       * ★ 2026-11-16 録画（勇気）: 西区が入っていなかった。
       *   旧 auto は station > area だったため、野田等の駅名が付いていると
       *   city_codes（福島区・西区）があっても駅モードになり、区が消えた／押されなかった。
       *   → **区コードがある時は所在地を優先**（area_mode が station の明示の時だけ駅）。
       */
      if (_hasWard(c)) return "area";
      if (_hasStation(c)) return "station";
      if (_hasRoutes(c)) return "route";
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
    /**
     * ★ 2026-11-16 録画: 管理費・共益費込みが入っていなかった。
     *   name が無い／違う時はラベル文字でも探す（「管理費・共益費込み」）。
     */
    (function _queueCommonFee() {
      var feeCb0 = document.querySelector('input[name="include_common_fee"]');
      if (!feeCb0) {
        var labs = document.querySelectorAll("label");
        for (var fi = 0; fi < labs.length; fi++) {
          var ft = (labs[fi].textContent || "").replace(/[\s　]/g, "");
          if (ft.indexOf("管理費") >= 0 && (ft.indexOf("共益費") >= 0 || ft.indexOf("込み") >= 0)) {
            feeCb0 = labs[fi].querySelector('input[type="checkbox"]') || feeCb0;
            if (feeCb0) break;
          }
        }
      }
      if (feeCb0 && !feeCb0.checked) {
        var _feeEl = feeCb0;
        _basicQueue.push({
          name: "include_common_fee",
          run: function () { enqueueHumanClick(_feeEl, _clickEl, _uiGapMin(), _uiGapMax(), null, _uiGapOpts()); try { console.log("[AX] 管理費・共益費込みをチェック"); } catch (_) {} },
        });
      }
    })();
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
          /**
           * ★ 2026-11-17: 分数が select（プルダウン）の画面では chooseSelectLikeHuman。
           *   input の時だけ type。旧は input だけ見て select 画面では何も押さなかった。
           */
          var selRt = document.querySelector('select[name="required_time"]');
          if (selRt) {
            enqueueHumanAction(function () {
              return new Promise(function (resolve) {
                Promise.resolve(chooseSelectLikeHuman(selRt, String(cond.walk_minutes), {
                  forceOpen: true,
                  slow: true,
                  field: "required_time",
                })).then(function () {
                  setTimeout(function () {
                    _resealWalkAfterMinutes(cond.walk_minutes, { allowUi: false }).then(function () { resolve(); }, function () { resolve(); });
                  }, _ln(1100, 0.35, 800, 1600));
                }, function () { resolve(); });
              });
            }, 900, 1500, "sel:required_time=" + cond.walk_minutes);
            return;
          }
          var inp = document.querySelector('input[name="required_time"]');
          if (!inp) return;
          _enqueueWithEl(inp, function () {
            return new Promise(function (resolve) {
              setTimeout(function () {
                Promise.resolve(typeTextLikeHuman(inp, cond.walk_minutes, { alreadyAimed: true })).then(function () {
                  setTimeout(function () {
                    _resealWalkAfterMinutes(cond.walk_minutes, { allowUi: false }).then(function () { resolve(); }, function () { resolve(); });
                  }, _ln(1100, 0.35, 800, 1600));
                });
              }, _ln(950, 0.4, 600, 1400));
            });
          }, 900, 1500, 'txt:required_time=' + cond.walk_minutes);
        },
      });
      /**
       * ★ 2026-11-16: 条件の最後にもう一度徒歩を締める（他の欄の後で消える対策）。
       *   関所の前に「徒歩＋分数」が揃っている状態にする。
       */
      _basicQueue.push({
        name: "walk_seal_final",
        run: function () {
          enqueueHumanAction(function () {
            // この検索で徒歩の擬似一覧を開けるのはここ（足りない時）だけ
            return _resealWalkAfterMinutes(cond.walk_minutes, { allowUi: true });
          }, _uiGapMin(), _uiGapMax(), "walk_seal_final");
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
     * 間取りを積む（人がチェックする形）。
     *   名前は `room_layout_id[]` にそろえる（学習の並びと合わせる）。
     *
     * ★ 2026-11-16 竹内さん「間取りの部分も選択されていないバグがたまにおきてしまう」:
     *   ⚠ 旧は **キュー組み立て時**に `querySelectorAll` した checkbox 要素を閉じて持っていた。
     *     所在地・駅モーダルのあと DOM が作り直されると **古い要素への click が効かない**
     *     → 間取りが画面に入らない（録画: 条件に rent はあるのに room_layout 0）。
     *   → **実行時に** `setCheckboxes` で今の DOM から探す（一息も setCheckboxes 内）。
     */
    /**
     * ★ 2026-11-16 竹内さん「間取りも新しいお客さんのように」:
     *   客条件がある時は必ず積む（値が空なら全外し＝前客分を残さない）。
     *   ★ 続き客は floor_plan が空でも**必ず setCheckboxes**（前客間取りを残さない）。
     *   setCheckboxes が want外を外し・wantを入れる（キュー競合で二重外ししない）。
     */
    if ((_layoutsToPush && _layoutsToPush.length) || cond.floor_plan || _shouldForceClearPrevPlace()) {
      (function (vals2) {
        _basicQueue.push({
          name: "room_layout_id[]",
          run: function () {
            var nBefore = 0;
            try { nBefore = document.querySelectorAll('input[name="room_layout_id[]"]').length; } catch (_) {}
            try {
              if (_shouldForceClearPrevPlace() && _audit) {
                var _nChk0 = document.querySelectorAll('input[name="room_layout_id[]"]:checked').length;
                if (_nChk0) {
                  _auditStepP("layout_clear_all", "続き客: 間取り残" + _nChk0 + "→客条件だけに差し替え want=" + vals2.length);
                  try { _noteClearMethod("layout", "cursor_checkbox", "残" + _nChk0); } catch (_) {}
                }
              }
            } catch (_) {}
            // ★ 2026-11-18 竹内さん「間取りが途中停止」: クリックを積み終えてから audit・把握を積む（Promise を返す＝_runBasicOneByOne が待つ）
            var _spL = setCheckboxes("room_layout_id[]", vals2);
            var _afterLayoutEnq = function () {
            try {
              if (_audit) {
                var nAfter = document.querySelectorAll('input[name="room_layout_id[]"]').length;
                var nChk = document.querySelectorAll('input[name="room_layout_id[]"]:checked').length;
                _auditStepP("layout_apply", "want=" + vals2.length + "／欄" + nAfter + "（組立時" + nBefore + "）／check" + nChk);
                if (!nAfter) _auditStepP("layout_miss_dom", "間取りの欄がDOMに無い（折りたたみ・別画面の可能性）");
              }
            } catch (_) {}
            // ★ 間取り場面の把握（外し／選ぶの段）をキュー後に測る＋足りなければ1回入れ直し
            try {
              enqueueHumanAction(function () {
                try { if (typeof _understandLayoutScene === "function") _understandLayoutScene(vals2); } catch (_) {}
                try {
                  var rep = _layoutWantReport(vals2);
                  if (_audit) {
                    _auditStepP(
                      rep.ok ? "layout_grasp_ok" : (rep.partial ? "layout_grasp_partial" : "layout_grasp_miss"),
                      "把握 hit=" + rep.hitN + "/" + rep.wantN +
                        (rep.missing.length ? (" 不足=" + rep.missing.slice(0, 6).join(",")) : "") +
                        (rep.extras.length ? (" 余分=" + rep.extras.length) : "")
                    );
                  }
                  if (rep.missing.length && vals2 && vals2.length) {
                    if (_audit) _auditStepP("layout_grasp_refill", "把握後に不足分を入れ直し");
                    setCheckboxes("room_layout_id[]", vals2);
                  }
                } catch (_) {}
              }, 400, 900, "間取り把握");
            } catch (_) {
              try { if (typeof _understandLayoutScene === "function") _understandLayoutScene(vals2); } catch (__) {}
            }
            };
            if (_spL && typeof _spL.then === "function") return _spL.then(_afterLayoutEnq, _afterLayoutEnq);
            _afterLayoutEnq();
          },
        });
      })(_layoutsToPush && _layoutsToPush.length ? _layoutsToPush : []);
    }
    /**
     * 2026-11-14 竹内さん「まだ徒歩の部分一度選択した後に消えるようになってしまっている」
     *   → **原因を発見**: 上の並べ替えが**移動手段と分数の順番を入れ替えて**いた。
     *
     *   ⚠ リアプロは「移動手段（transportation_id）」を選ぶと、**その下の分数（required_time）が
     *     リセットされる**（画面が作り直される）。人がやっても同じ。
     *   旧は `_orderByLearned` に**そのまま**渡していたので、学んだ順が
     *   「required_time → transportation_id」だと:
     *     ① 分数を打つ（10）→ ② 移動手段を選ぶ → **分数が消える**（＝「一度選んだ後に消える」）
     *   実測では「入る時と入らない時がある」＝学んだ順によって変わっていた。
     *
     *   → **移動手段は必ず分数より先**に固定する（学んだ順でも入れ替えない）。
     *     これは「見た目の好み」ではなく**画面の仕組み（親が子をリセットする）**なので、学習より優先する。
     *     ⚠ 他の欄（賃料・面積・築年・間取り）は今まで通り学んだ順で並べ替える。
     */
    (function _keepTransportBeforeWalk() {
      try {
        var _ti = -1, _wi = -1, _si = -1;
        for (var _i = 0; _i < _basicQueue.length; _i++) {
          if (_basicQueue[_i].name === "transportation_id") _ti = _i;
          else if (_basicQueue[_i].name === "required_time") _wi = _i;
          else if (_basicQueue[_i].name === "walk_seal_final") _si = _i;
        }
        if (_ti >= 0 && _wi >= 0 && _ti > _wi) {
          var _tr = _basicQueue.splice(_ti, 1)[0];
          _wi = 0;
          for (var _j = 0; _j < _basicQueue.length; _j++) {
            if (_basicQueue[_j].name === "required_time") { _wi = _j; break; }
          }
          _basicQueue.splice(_wi, 0, _tr);
        }
        // ★ 2026-11-16: walk_seal_final は必ず分数のあと（他の条件の後＝末尾付近）に置く
        _si = -1; _wi = -1;
        for (var _k = 0; _k < _basicQueue.length; _k++) {
          if (_basicQueue[_k].name === "required_time") _wi = _k;
          else if (_basicQueue[_k].name === "walk_seal_final") _si = _k;
        }
        if (_si >= 0 && _wi >= 0 && _si < _wi) {
          var _seal = _basicQueue.splice(_si, 1)[0];
          _basicQueue.push(_seal);
        } else if (_si >= 0 && _si < _basicQueue.length - 1) {
          // 末尾へ（他の欄の後で消える対策）
          var _seal2 = _basicQueue.splice(_si, 1)[0];
          _basicQueue.push(_seal2);
        }
      } catch (_) {}
    })();
    // ここで**まとめて**並べ替える（賃料・面積・共益費・徒歩・築年・間取りが同じ並びに入る）
    _basicQueue = _orderByLearned(_basicQueue);
    /**
     * ⚠ 並べ替えた**後**にもう一度そろえる（`_orderByLearned` が鎖で入れ替えるため）。
     *   ここを忘れると、学習の鎖が「分数 → 移動手段」を作った時にまた消える。
     */
    (function _keepTransportBeforeWalk2() {
      try {
        var _ti = -1, _wi = -1;
        for (var _i = 0; _i < _basicQueue.length; _i++) {
          if (_basicQueue[_i].name === "transportation_id") _ti = _i;
          else if (_basicQueue[_i].name === "required_time") _wi = _i;
        }
        if (_ti < 0 || _wi < 0 || _ti < _wi) return;
        var _tr = _basicQueue.splice(_ti, 1)[0];
        _wi = 0;
        for (var _j = 0; _j < _basicQueue.length; _j++) {
          if (_basicQueue[_j].name === "required_time") { _wi = _j; break; }
        }
        _basicQueue.splice(_wi, 0, _tr);
      } catch (_) {}
    })();
    /**
     * ★ 2026-11-15 竹内さん「選択1つずつではなくて並行でおこなってしまっている」
     *   「所在地のところも時間ギリギリなので：すべて尾下の確認してするように」:
     *
     *   ⚠ 実測（brain_aix 13:16）: 条件（賃料・徒歩…）と所在地モーダルが**同じキューに同時に積まれ**、
     *     区押しと条件入力が交错していた（人がやらない並行）。
     *   → **所在地モーダルを使う時は、条件キューを後回し**にする。
     *     所在地を全部確かめて確定した**あと**に条件を流し、それから検索する。
     *
     * ★ 2026-11-16: 更新日・構造・ペット等も**同じ条件キュー**に入れる（外で即実行すると所在地と同時になる）。
     *   流し方は `_runBasicOneByOne`（1つ終わるまで次を始めない）。
     */
    {
      // 更新日（前の顧客の値が残らないよう、未設定時は "" に戻す）
      var updEl0 = document.querySelector('select[name="update_date"]');
      if (updEl0) {
        var _updVal = cond.rp_update_days ? String(cond.rp_update_days) : "";
        _basicQueue.push({
          name: "update_date",
          run: function () {
            queueSelVal("update_date", _updVal);
            try { console.log("[AX] 更新日" + (_updVal ? "セット:" + _updVal + "日以内" : "リセット")); } catch (_) {}
          },
        });
      }
    }
    if (cond.structure_types && cond.structure_types.length > 0) {
      var sVals0 = cond.structure_types.map(function (s) { return STRUCTURE_MAP[s]; }).filter(Boolean);
      if (sVals0.length) {
        _basicQueue.push({
          name: "structured_type[]",
          run: function () { setCheckboxes("structured_type[]", sVals0); },
        });
      }
    }
    /**
     * ★ 2026-11-17 通常録画01:18正本＋竹内さん「ペット飼育でない客は外す」:
     *   正本: 絞り込み条件＋ → ペット相談 was=true→now=false（eq_rm[]）。
     *   pet_ok の時は開いて選ぶ／でない時は残っていれば同じ経路で外す。
     */
    _basicQueue.push({
      name: "eq_rm[]",
      run: function () {
        var wantPet = !!cond.pet_ok;
        var petCb = document.querySelector('input[name="eq_rm[]"][value="113"]');
        if (!petCb) {
          try { if (_audit) _auditStepP("pet_miss", "ペット可(eq_rm=113)が見つからない"); } catch (_) {}
          return;
        }
        // 既に希望どおりなら何もしない（開かない＝余計な操作をしない）
        if (!!petCb.checked === wantPet) {
          try {
            if (_audit) _auditStepP(wantPet ? "pet_already_on" : "pet_already_off", "ペット可は既に希望どおり");
          } catch (_) {}
          return;
        }
        return _ensureFieldVisible(petCb, "eq_rm[]", 4000).then(function () {
          var again = document.querySelector('input[name="eq_rm[]"][value="113"]');
          if (!again) return;
          var hit = null;
          try {
            // 通常録画は「ペット相談」ラベルを押す
            hit = _labelForCheckbox(again)
              || _findByText(["ペット相談", "ペット飼育可能", "ペット飼育", "ペット可"])
              || again;
          } catch (_) { hit = again; }
          if (!!again.checked !== wantPet) {
            if (typeof _toggleCheckboxLikeHuman === "function") {
              _toggleCheckboxLikeHuman(again, wantPet);
            } else {
              enqueueHumanClick(hit, _clickEl, _uiGapMin(), _uiGapMax(), null, _uiGapOpts());
            }
          }
          try {
            console.log("[AX] ペット可: 絞り込み条件を開いてから" + (wantPet ? "選択" : "外す"));
            if (_audit) _auditStepP(wantPet ? "pet_select" : "pet_clear", wantPet ? "ペット可を選ぶ" : "ペット可を外す（新客は条件なし）");
          } catch (_) {}
          /**
           * ★ 2026-11-17 平田さん監査 `pet_not_checked`:
           *   旧は toggle をキューに積んだ直後（700ms）に checked を見ていた →
           *   **押し終わる前に「外れていない」判定** → 確定も早すぎ／未押しに見える。
           *   → **キュー空まで待ってから**検証→押し直し→確定してリストへ。
           */
          return new Promise(function (resolve) {
            function _afterPetToggle() {
              try {
                var chk = document.querySelector('input[name="eq_rm[]"][value="113"]');
                if (chk && !!chk.checked !== wantPet) {
                  try {
                    if (_audit) _auditStepP(
                      wantPet ? "pet_not_checked" : "pet_still_checked",
                      wantPet ? "ペット可を押したのに checked=false → 押し直し" : "ペット可を外したのに checked=true → 押し直し",
                    );
                  } catch (_) {}
                  var hit2 = null;
                  try {
                    hit2 = _labelForCheckbox(chk)
                      || _findByText(["ペット相談", "ペット飼育可能", "ペット飼育", "ペット可"])
                      || chk;
                  } catch (_) { hit2 = chk; }
                  if (typeof _toggleCheckboxLikeHuman === "function") _toggleCheckboxLikeHuman(chk, wantPet);
                  else enqueueHumanClick(hit2, _clickEl, _uiGapMin(), _uiGapMax(), null, _uiGapOpts());
                  whenClickQueueIdle(function () { setTimeout(_confirmPetPanel, 350); });
                  return;
                }
              } catch (_) {}
              _confirmPetPanel();
            }
            function _confirmPetPanel() {
              try {
                if (_pressConfirmListLikeHuman(wantPet ? "pet_select後の確定" : "pet_clear後の確定")) {
                  if (_audit) _auditStepP("pet_panel_confirm", "ペット操作後に確定してリストへ");
                } else {
                  if (_audit) _auditStepP("pet_panel_confirm_miss", "ペット操作後に確定ボタンが見つからない");
                }
              } catch (_) {}
              whenClickQueueIdle(function () { resolve(); });
            }
            whenClickQueueIdle(function () { setTimeout(_afterPetToggle, 280); });
          });
        });
      },
    });
    /**
     * ★ 2026-11-16 録画: 敷金・礼金なしが入っていなかった。
     *   原因: popup が adj チェックだけ送り、顧客テキストの希望を無視 → cond.shikirei_free=false。
     *   → prefer_no_shikirei も見る。ラベルは「敷金・礼金なし」を広く探す。
     */
    if (cond.shikirei_free || cond.prefer_no_shikirei) {
      _basicQueue.push({
        name: "敷金・礼金なし",
        run: function () {
          var sInp = _findShikireiCheckbox();
          if (sInp && !sInp.checked) {
            enqueueHumanClick(sInp, _clickEl, _uiGapMin(), _uiGapMax(), null, _uiGapOpts());
            try { console.log("[AX] 敷金・礼金なしをチェック"); } catch (_) {}
          } else if (!sInp) {
            try { if (_audit) _auditStepP("shikirei_miss", "敷金・礼金なしの欄が見つからない"); } catch (_) {}
          }
        },
      });
    }
    /**
     * ★ 2026-11-16 自動録画: 条件が所在地より先に走っていた（通常は場所→条件→検索）。
     *   → 条件キューがある限り**後回し**。場所（所在地/駅）または「場所なし」分岐の最後で流す。
     */
    var _deferBasicForPlace = _basicQueue.length > 0;
    try { window.__axDeferredBasicQueue = _deferBasicForPlace ? _basicQueue.slice() : null; } catch (_) { window.__axDeferredBasicQueue = null; }
    if (_deferBasicForPlace) {
      try { if (_audit) _auditStepP("basic_defer", "場所のあとで条件を1つずつ入れる（並行しない）" + _basicQueue.length + "件"); } catch (_) {}
    }
    // 2026-11-10 v2.6.18 竹内さん「ちゃんと画面見て判断できるようになってるのかな場所など」→「なおす」:
    //   入れるはずの値を1か所に置く（検索を押す直前に、画面の実際の値と1つずつ比べる）。
    //   間取りの有無に関わらず置く（家賃・更新日・徒歩・場所も比べるため）。
    _axExpect = {
      /**
       * ★ 2026-11-16 録画: 間取りが選択されていなかった。
       *   旧は「いま画面で checked の物」を期待値にしていた → 条件を入れる前なので常に空。
       *   → 入れる予定の `_layoutsToPush` を期待値にする（関所・再入力が効く）。
       */
      /**
       * ★ 2026-11-16: 旧はパース失敗時に「いま画面の checked」を期待値にしていた
       *   → 前客の間取りが「正しい」と誤認され関所が通る。客条件の vals だけを信じる。
       */
      layoutVals: (_layoutsToPush && _layoutsToPush.length ? _layoutsToPush.map(String) : []),
      floorPlan: String(cond.floor_plan || ''),
      rentMax: (cond.rent_max != null ? String(nearestUp(RENT_OPTS, cond.rent_max)) : null),
      rentMin: (cond.rent_min != null ? String(nearestDown(RENT_OPTS, cond.rent_min)) : null),
      updateDays: (cond.rp_update_days != null ? String(cond.rp_update_days) : (cond.rp_update_days === '' ? '' : null)),
      age: (cond.building_age ? String(nearestUp(AGE_OPTS, cond.building_age)) : null),
      walk: (cond.walk_minutes != null ? String(cond.walk_minutes) : null),
      shikirei: !!(cond.shikirei_free || cond.prefer_no_shikirei),
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
    /**
     * ★ 2026-11-18 平田 run_mwlrwjhx_xoqv（淀川区を押す/外すを約20往復）:
     *   verify は `__axlxWardCodes` を「足りない区だけ」に一時差し替える。余計な区を外す判定は
     *   **お客様の欲しい区の全部**で見ないと、選んだ直後の区が「余計」になって外される。
     *   → 全部の控え `__axlxWardWantAll` を別に持つ（差し替えない）。
     */
    try {
      window.__axlxWardCodes = (cond.city_codes || []).map(String);
      window.__axlxWardWantAll = window.__axlxWardCodes.slice();
      window.__axlxWardSelN = {};
    } catch (_) { window.__axlxWardCodes = null; window.__axlxWardWantAll = null; }
    // ★ 2026-11-16: 更新日・構造・ペット・敷礼なしは上の `_basicQueue` に入れた（ここで即実行しない＝同時操作を止める）

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
      /**
       * ★ 2026-11-16 直接入力改善: pref_code もカーソルを動かしてから押す（checked 直書きしない）。
       */
      var prefCb = document.querySelector('input[name="pref_code"][value="27"]');
      if (prefCb && !prefCb.checked) {
        enqueueHumanClick(prefCb, _clickEl, _uiGapMin(), _uiGapMax(), null, _uiGapOpts());
      }
      setTimeout(function() {
        _auditStepP('cities', (cond.city_codes || []).length);
        setCheckboxes("city_code[]", cond.city_codes);
        try {
          enqueueHumanAction(function () {
            try { if (typeof _understandWardScene === "function") _understandWardScene(cond); } catch (_) {}
          }, 500, 1100, "地域把握");
        } catch (_) {
          try { if (typeof _understandWardScene === "function") _understandWardScene(cond); } catch (__) {}
        }
      }, _hd(150));
    }

    // 沿線・駅なし（locationMode: area または none）
    if (locationMode === "area" || locationMode === "none") {
      // ★ 2026-11-19: 前客の駅・沿線が残っていれば、所在地へ入る前に沿線・駅で1つずつ外して確定する（駅と地域を混ぜない）
      _clearStationsBeforeWardThen(function () {
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
        _runDeferredBasicThenSearch("場所なし");
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
           *
           * ★ 2026-11-16 竹内さん「全て押した後に次に行く」:
           *   ⚠ 実測（まりあ自動）: `_humanPointerClick` 直呼びだと tryFn が即 true →
           *     **確定のクリック完了前に検索**が走っていた（確定 click より検索が先）。
           *   → **キューに積む**（押し終わるまで busy＝次の段に進まない）。
           *
           * ★ 2026-11-17 平田さん自動: 地域そろったあと確定前で停止／確定が最重要。
           *   → 共通 `_pressConfirmListLikeHuman` を使い、見つからない時だけ ×。
           */
          if (_pressConfirmListLikeHuman("所在地モーダル確定")) return true;
          var d = document.querySelector('div.this_window_close');
          if (d && isVisible(d)) {
            if (_audit) _auditStepP('modal_confirm_fallback_x', '×とじる（確定が見つからない）');
            enqueueHumanClick(d, function (el) { try { el.click(); } catch (_) {} }, _uiGapMin(), _uiGapMax(), null, _uiGapOpts());
            return true;
          }
          return clickByText(['×とじる', '× とじる', 'とじる', '閉じる']);
        }
        /**
         * ★ 2026-11-16: 確定クリックが終わってから条件→検索（全部押したあと次へ）。
         */
        function _afterAreaAllPressedThenNext(why) {
          whenClickQueueIdle(function () {
            var tries = 0;
            function waitModalGone() {
              tries++;
              var stillOpen = false;
              try {
                var closeBtn = document.querySelector("div.this_window_close");
                if (closeBtn && isVisible(closeBtn)) stillOpen = true;
                if (!stillOpen && document.querySelectorAll("label.one_city:not([style*='display: none'])").length > 0) {
                  // 市区郡ラベルが前面に残っている＝モーダル未閉鎖の可能性
                  var confLeft = _findByText(["確定してリストへ"]);
                  if (confLeft && isVisible(confLeft)) stillOpen = true;
                }
              } catch (_) {}
              if (stillOpen && tries < 40) {
                setTimeout(waitModalGone, 200 + Math.floor(Math.random() * 120));
                return;
              }
              try { if (_audit) _auditStepP("area_all_done", (why || "所在地") + " → 全部押したあと次へ（試行" + tries + "）"); } catch (_) {}
              _runDeferredBasicThenSearch(why);
            }
            setTimeout(waitModalGone, 350 + Math.floor(Math.random() * 250));
          });
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
            /**
             * ★ 2026-11-20 竹内さん「所在地のところ直接入力してしまっている可能性あるので1つずつおすようにする」:
             *   旧は小窓が閉じたまま pref_code と city_code[] を押していた（見えない欄＝カーソル無しの直接入力）。
             *   → 所在地絞り込みを開き、大阪府→区を1つずつカーソルで押して「確定してリストへ」を押す。
             */
            _areaFallbackViaModal(codes, function () {
              whenClickQueueIdle(function() {
                // 1つ以上実際にチェックされた場合のみ検索（全件検索防止）
                var applied = document.querySelectorAll('input[name="city_code[]"]:checked').length;
                if (applied > 0) {
                  _runDeferredBasicThenSearch('所在地フォールバック');
                } else {
                  var em = '所在地フォールバック失敗: city_codeチェック未反映（全件検索防止のため中止）: ' + msg;
                  showWarnToast(em);
                  notifyDone(em);
                }
              });
            });
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
            // 2.8.129: 区の入れ直しも小窓を開いて1つずつ押す（閉じたまま city_code[] を押さない）
            _areaFallbackViaModal(codes, function () {
              whenClickQueueIdle(function () {
                var applied = document.querySelectorAll('input[name="city_code[]"]:checked').length;
                if (_audit) _auditStepP('area_force_search', applied + '区で検索へ（' + String(why).slice(0, 60) + '）');
                if (applied > 0) {
                  console.warn('[AX] 地域は完全でないが ' + applied + '区入っている → 条件→検索へ進む');
                  _runDeferredBasicThenSearch('区が1つ以上');
                } else {
                  var em = '地域が1区も入らず中止（全件検索防止）: ' + String(why).slice(0, 120);
                  showWarnToast(em);
                  notifyDone(em);
                }
              });
            });
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
            /**
             * ★ 2026-11-15 竹内さん「ちゃんと人間の動きでできるようにする」
             *   ⚠ 旧は `simulateClick(btnEl)` を**直に呼んでいた**ので、カーソルは別の所に居たまま
             *     ボタンだけ押されていた（人が見ると「勝手に押された」）。
             *   → `_humanPointerClick` で**カーソルをその要素まで動かしてから**押す。
             *     ⚠ 失敗しても必ず押す（止まらない）。`simulateClick` はその中で使う。
             */
            // 動いている間も「忙しい」に数える（上の _pressBusy の確かめで、動いている途中に押し直さない・2026-11-20）
            _pressHumanTracked(btnEl, function () { try { simulateClick(btnEl); } catch (_) {} });
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
          /**
           * ★ 2026-11-16 統括Pro「区・city_code 17%・変バグを細かく」:
           *   旧は checked→deselect を `wTarget.click()` 直押し（カーソル無し＝人間らしさの穴・トグル誤作動の温床）。
           *   → 外す時もカーソル移動してから押す。
           */
          /**
           * ★ 2026-11-20 竹内さん「ちゃんと人間が動くような動きに」:
           *   旧は外す押しのカーソルが動き始めてから 240〜400ms で選ぶ押しを始めていた（2つのカーソルの動きが重なる）。
           *   → 外す押しが終わってから間を置いて選ぶ押しへ。選ぶ押しが終わってから Y を確かめる。
           */
          var _selectStep = function () {
            setTimeout(function() {
              _pressHumanTracked(wTarget, function () { try { simulateClick(wTarget); } catch (_) {} }).then(function () {
                console.log('[AX] ensureWardButtonY: カーソル移動→クリック→select 待機');
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
              });
            }, 240 + Math.floor(Math.random() * 160));
          };
          if (wInp && wInp.checked) {
            console.log('[AX] ensureWardButtonY: checked→カーソルでdeselect 待機');
            _pressHumanTracked(wTarget, function () { try { wTarget.click(); } catch (_) {} }).then(_selectStep);
          } else {
            _selectStep();
          }
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
             * 2026-11-14 竹内さん「人が選んだ物は残す」／2026-11-16「続き客は所在地・駅をやりなおす」:
             *   ⚠ 旧バグ: `_resetAutoPicked()` 後の空オブジェクトを「覚えあり」とみなし、
             *     前客の区を全部「人が選んだ」として残していた → 続き客で条件が混ざる／大阪全件。
             *   → 自動の続き客（`_shouldForceClearPrevPlace`）は**全部外す**。
             *     通常で覚えがある時だけ「自動で入れた物だけ」外す。
             */
            var _keepHuman = false;
            var _forceAll = _shouldForceClearPrevPlace();
            try {
              if (!_forceAll && _autoPickedHasMemory()) {
                var _auto = window.__axAutoPicked;
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
            if (_audit) {
              _auditStepP(
                _forceAll ? "area_preclear_force" : "area_preclear",
                on.length + "件を先に外す" + (_forceAll ? "（続き客: 前の地域を全部やりなおす）" : (_keepHuman ? "（人が選んだ物は残す）" : "")),
              );
            }
            console.log('[AX] モーダルを開く前に地域を外します:', on.length, '件' + (_forceAll ? '（続き客やり直し）' : (_keepHuman ? '（人が選んだ物は残す）' : '')));
            /**
             * ★ 2026-11-16: checked=false 直書き禁止。label へカーソル→押して外すだけ。
             */
            window.__axAreaPreclearN = on.length;
            on.forEach(function (cb) {
              if (!cb.checked) return;
              _toggleCheckboxLikeHuman(cb, false);
            });
          } catch (_) {}
        })();
        // 先に外すクリックが終わるまでモーダルを開かない
        whenClickQueueIdle(function () {
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
                    try { _markPanelOpened("area", "area_open_by_class"); } catch (_) {}
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
                    try { _markPanelOpened("area", "area_open_by_area"); } catch (_) {}
                    _pressLearned(cands[k], ['左の所在地絞り込み', '所在地絞り込み＋', '所在地絞り込み'], 'area_open');
                    return true;
                  }
                }
              }
            } catch (_) {}
            // ③ 文字（今まで通り・最後の受け皿）
            var openedTxt = clickByText(['所在地絞り込み＋', '所在地絞り込み+', '所在地絞り込み']);
            if (openedTxt) { try { _markPanelOpened("area", "area_open_by_text"); } catch (_) {} }
            return openedTxt;
          },
          function() {
            console.log('[AX] STEP1完了: 所在地絞り込みクリック済');
            try { if (!_axPanelDebt) _markPanelOpened("area", "area_modal_step1"); } catch (_) {}
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
                 * ★ 2026-11-16: 続き客・自動は前客の地域を全部外す（空の __axAutoPicked で誤残ししない）。
                 *   通常で覚えがある時だけ「自動で入れた物だけ」外す。
                 */
                var _forceAll = _shouldForceClearPrevPlace();
                if (!_forceAll && _autoPickedHasMemory()) {
                  var _autoSet = {};
                  try {
                    var _auto = window.__axAutoPicked;
                    ["city", "town"].forEach(function (k) {
                      (Array.isArray(_auto[k]) ? _auto[k] : []).forEach(function (v) { _autoSet[k + ":" + String(v)] = true; });
                    });
                  } catch (_) {}
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
                if (_audit) {
                  _auditStepP(
                    _forceAll ? "area_prev_clear_force" : "area_prev_clear",
                    _all.length + (_forceAll ? "件を外す（続き客: 前の地域を全部やりなおす）" : "件を外す（自動で入れた物）"),
                  );
                }
                console.log('[AX] 地域を外します:', _all.length, '件' + (_forceAll ? '（続き客やり直し）' : '（自動で入れた物／人が選んだ物は残す）'));
                /**
                 * ★ 2026-11-16: checked 直書き禁止。label カーソル押しだけ。
                 */
                _all.forEach(function (cb) {
                  if (!cb.checked) return;
                  _toggleCheckboxLikeHuman(cb, false);
                });
              } catch (_) {}
            })();
            // STEP2+3を統合: 市区郡直接クリックと大阪府クリックを同時にポーリング
            // ケースA: モーダルが市区郡ページ表示中 → 大阪府をスキップして市区郡を直接クリック
            // ケースB: モーダルが都道府県ページ表示中 → 大阪府をクリック
            var prefClicked = false;
            /**
             * ⚠ 2026-11-15: `doAfterWard` の中で使う（**使う所より前に宣言**）。
             *   地域がそろったかを確かめ始めた時刻。押し切るまで待つための上限に使う。
             */
            var _wardVerifyStart = 0;
            // ★ 2026-11-18 竹内さん「区が揃うまで待つ・進捗中は切らない」: 入った区が増えた最後の時刻（増えている間は中止しない）
            var _wardBestChecked = -1, _wardGainAt = 0;

            function doAfterWard() {
              console.log('[AX] STEP3完了: 市区郡クリック済 → next_step_button2 確認');
              /**
               * ⚠ 2026-11-15: 確認を始めた時刻（**押し直しの上限を時間で測る**ため）。
               *   `var` は**使う所より前に**置く（後ろに置くと undefined のまま catch に飲まれて黙って動かない）。
               */
              _wardVerifyStart = Date.now();
              _wardBestChecked = -1; _wardGainAt = Date.now();
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
                // ★ 2026-11-18: 区の確認・押し直しの間も background の fill-done 待ちを延長（9区で無進捗扱いにしない）
                try { _emitFillProgressHeartbeat('ward_verify'); } catch (_) {}
                var chk = isAllWantedWardsChosen(cond.city_codes);
                var want = (cond.city_codes || []).map(String).filter(Boolean);
                if (want.length === 0) { _auditStepP('ward', null); _afterWardConfirmed(); return; }
                if (chk.all) {
                  if (n) _auditStepP('ward_verified', n + '回目でそろった（' + want.length + '区）');
                  _auditStepP('ward', null);
                  _afterWardConfirmed();
                  return;
                }
                /**
                 * ⚠ 2026-11-15 **実測で見つけた本物の原因**（自動モードが必ず止まる）:
                 *
                 *   点検記録（2.7.79・10:49・まりあ）:
                 *     page:ward_by_code ×8 → ward_verify_fail「欲しい3区・入った0区」
                 *     → AXLX_AREA_MISMATCH で中止
                 *
                 *   なぜ8回とも「入った0区」だったか:
                 *     ① `clickWardPrecise` は**キューに積むだけ**（人が押す速さで1つずつ・1区 620〜1400ms＋迷い）
                 *     ② なのに確認は **620ms 後に1回**だけ（`setTimeout(..., 620)`）
                 *     ③ 3区なら押し終わるまで **約3〜6秒**かかる → その前に「そろっていない」と判定
                 *     ④ 足そうとまたキューに積む（`__axPending` で弾かれるか、二重に積まれる）
                 *     ⑤ 8回×620ms＝**約5秒**で打ち切り → 押し終わる前に必ず中止
                 *   → **1区も押せていないのに「地域がそろいません」で止まっていた**（まりあさんの自動モードは今日0回成功）。
                 *
                 *   → 直し方: 「時間で決める」のをやめ、**キューが空になるまで待つ**（`whenClickQueueIdle`）。
                 *     そのうえで:
                 *       ・**押し直しはキューが空になってから**（押している最中に積むと二重押し＝外れる）
                 *       ・待ち切れない時の上限は**45秒**（3区＋迷い＋長い停止8〜25秒を1回挟んでも足りる）
                 *       ・押し直しは**2回まで**（同じ事を何度も積まない）
                 */
                var t0 = _wardVerifyStart || (_wardVerifyStart = Date.now());
                var elapsed = Date.now() - t0;
                /**
                 * ★ 2026-11-17 平田さん: 9区で MAX_RETRY=2 だと足りない1区で即中止＋
                 *   `_wardVerifyStart=0` で「0秒待った」と誤表示していた。
                 *   → タイマーはリセットしない／押し直しは足りない区数に応じて増やす。
                 *   ⚠ 「1区でも入れば進む」は都島区だけバグと矛盾 → **全部そろってから確定**（竹内さん絶対）。
                 *
                 * ★ 2026-11-18 平田1482 実測（search_audits id=1482・ext 2.8.93・9区指定）:
                 *   入った1区・足りない8・約13秒で ward_verify_fail → batch_timeout。
                 *   `clickWardPrecise` は1回の verify で**未選択の先頭1区だけ**足す設計のまま。
                 *   旧 `MAX_RETRY=Math.min(10,missing+3)` は9区で10で打ち切り（10×約1.3秒≈13秒）が原因。
                 *   → 欲しい区数に比例した retry／時間上限（硬上限30回・90秒以上）。
                 */
                var missingN = chk.missing.length || 1;
                // ★ 2026-11-18: 目安も短くしない（9区×長く／最低15分）
                var MAX_MS = Math.max(900000, want.length * 90000);
                var MAX_RETRY = Math.min(30, Math.max(4, Math.max(want.length * 3, missingN * 2 + 4)));
                /**
                 * ★ 2026-11-18 竹内さん「タイムアウトを取り除く／AREA_MISMATCH で検索せず batch_timeout の連鎖を止める」:
                 *   MAX_MS・MAX_RETRY は「目安」に格下げ（超えても**入った区が増えている間は中止しない**＝区が揃うまで待つ）。
                 *   中止するのは ①入った区が一度も増えないまま WARD_NO_GAIN_MS（5分以上） ②硬上限 WARD_HARD_MS（30分）だけ。
                 *   目安を超えた後の押し直しは 3秒間隔にして、画面外の区などで同じクリックを積み続けない。
                 */
                // ★ 2026-11-18: 無増5分は短い → 最低15分／硬上限45分
                var WARD_NO_GAIN_MS = Math.max(900000, want.length * 60000);
                var WARD_HARD_MS = 45 * 60 * 1000;
                if (chk.checked.length > _wardBestChecked) { _wardBestChecked = chk.checked.length; _wardGainAt = Date.now(); }
                var _wardOverSoft = n >= MAX_RETRY || elapsed > MAX_MS;
                var _wardGiveUp = elapsed > WARD_HARD_MS || (Date.now() - _wardGainAt) > WARD_NO_GAIN_MS;
                if (isClickQueueBusy()) {
                  if (_wardGiveUp) {
                    var msg0 = '地域がそろいません（欲しい' + want.length + '区・入った' + chk.checked.length + '区・足りない' + chk.missing.length + '・押す列が' + Math.round(elapsed / 1000) + '秒たっても終わらない・retry=' + n + ' MAX_RETRY=' + MAX_RETRY + ' MAX_MS=' + MAX_MS + '）';
                    _auditStepP('ward_verify_fail', msg0 + ' 入った:[' + chk.checked.join(',') + '] 足りない:[' + chk.missing.join(',') + ']');
                    _basicsThenAbort('AXLX_AREA_MISMATCH: ' + msg0, 'ward_queue_timeout');
                    return;
                  }
                  whenClickQueueIdle(function () { setTimeout(function () { _verifyThenConfirm(n); }, _ln(110, 0.4, 60, 240)); }, 40);
                  return;
                }
                if (_wardGiveUp) {
                  var msg = '地域がそろいません（欲しい' + want.length + '区・入った' + chk.checked.length + '区・足りない' + chk.missing.length + '・' + Math.round(elapsed / 1000) + '秒待った・retry=' + n + ' MAX_RETRY=' + MAX_RETRY + ' MAX_MS=' + MAX_MS + '）';
                  _auditStepP('ward_verify_fail', msg + ' 入った:[' + chk.checked.join(',') + '] 足りない:[' + chk.missing.join(',') + ']');
                  console.warn('[AX] ' + msg + ' → 基本条件は入れてから中止（検索はしない）');
                  _basicsThenAbort('AXLX_AREA_MISMATCH: ' + msg, 'ward_verify_fail');
                  return;
                }
                // まだそろっていない（かつ押す列は空）→ 足す（余計は外す）
                if (n === 0) {
                  console.log('[AX] 確定前に確認: そろっていません（入った' + chk.checked.length + '・足りない' + chk.missing.length + '）→ 足します');
                }
                try {
                  chk.stale.forEach(function (code) {
                    var inp = document.querySelector('label input[name="city_code[]"][value="' + String(code) + '"]');
                    var lbl = inp && inp.closest ? inp.closest('label') : null;
                    /**
                     * ★ 2026-11-15 竹内さん「ちゃんと人間の動きでできるようにする」
                     *   ⚠ 旧は `simulateClick(lbl)` を直に呼んでいた（カーソルは動かない）。
                     *   → キューに積んで**1つずつ カーソルを動かして**外す
                     *     （人が区を外す速さ・`clickWardPrecise` と同じ 620〜1400ms）。
                     */
                    // ★ 2026-11-18 竹内さん「外す場合も選択して外す」: 狙いは見えている label（hidden input へカーソルを送らない）。checked 直書きなし
                    // 押す瞬間に checked を見る（既に外れていれば押さない＝積み重ねで付け直さない）
                    if (inp && lbl) _toggleCheckboxLikeHuman(inp, false, 620, 1400, { quick: true });
                  });
                } catch (_) {}
                try {
                  if (chk.missing.length) {
                    // 足りない区だけ押し直し（全コード再走査だと見えない区をまたスキップする）
                    var _prevCodes = window.__axlxWardCodes;
                    window.__axlxWardCodes = chk.missing.slice();
                    clickWardPrecise([wardFull, wardShort]);
                    window.__axlxWardCodes = _prevCodes;
                  }
                } catch (_) {}
                // 積んだ後は**キューが空になるまで待ってから**もう一度確かめる（時間で決めない）
                /**
                 * ★ 2026-11-18 区レーン: 旧は押し終わり検知150ms＋確認400ms（区1つごとに約0.5秒）。
                 *   押した直後の状態は _toggleCheckboxLikeHuman が確かめて返すので、ここは短く（通常の人の速さに合わせる）。
                 */
                whenClickQueueIdle(function () { setTimeout(function () { _verifyThenConfirm(n + 1); }, _wardOverSoft ? 3000 : _ln(90, 0.4, 50, 220)); }, 40);
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
                            console.log('[AX] STEP6: 確定をキューへ → 押し終わりを待つ');
                            _auditStepP('modal_close', null);
                            _afterAreaAllPressedThenNext('STEP6確定');
                          },
                          45, 450, 500 + Math.floor(Math.random() * 350),
                          function() {
                            /**
                             * ★ 2026-11-17 平田さん: 確定前で諦めない。最後にもう一度必押してから次へ。
                             */
                            console.warn('[AX] STEP6: 確定リトライ → それでも無ければ条件へ');
                            try {
                              if (_pressConfirmListLikeHuman("STEP6最終リトライ")) {
                                _afterAreaAllPressedThenNext('STEP6最終リトライ確定');
                                return;
                              }
                            } catch (_) {}
                            _afterAreaAllPressedThenNext('STEP6閉じられず');
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
                  _afterAreaAllPressedThenNext('広げて検索・確定');
                },
                45, 450, 500 + Math.floor(Math.random() * 350),
                function() {
                  console.warn('[AX] 広げて検索: 確定リトライ');
                  try {
                    if (_pressConfirmListLikeHuman("広げて検索最終リトライ")) {
                      _afterAreaAllPressedThenNext('広げて検索・最終リトライ確定');
                      return;
                    }
                  } catch (_) {}
                  _afterAreaAllPressedThenNext('広げて検索・閉じられず');
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
                try { _graspAreaModalScreen(); } catch (_) {}
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
                    // 500ms ごとの再ポーリングで同じ区を重ねて積んでも、押す瞬間に checked を見るので付け直さない
                    if (inp && lbl) _toggleCheckboxLikeHuman(inp, false, 620, 1400);
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
        }); // whenClickQueueIdle（地域の先外しクリック完了後）
      } else {
        /**
         * ★ 2026-11-16: 直接チェック後も **場所確定→条件→検索**（旧は clickSearch 直呼びで条件スキップ＆早押し）。
         */
        setTimeout(function () {
          whenClickQueueIdle(function () {
            var applied = document.querySelectorAll('input[name="city_code[]"]:checked').length;
            if (applied > 0) {
              _runDeferredBasicThenSearch("直接区チェック後");
            } else {
              var em = "直接区チェック後も区が0（全件検索防止のため中止）";
              try { _auditStepP("area_direct_zero", em); } catch (_) {}
              showWarnToast(em);
              notifyDone(em);
            }
          });
        }, 700 + Math.floor(Math.random() * 400));
      }
      return;
      }, locationMode === "none" ? "場所なし" : "所在地");
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
    // ★ 2026-11-17: 残駅があるときは form に沿線を直書きしない（駅画面経由クリアへ）
    if (hasRoutes && !hasStation) {
      var _stLeft0 = 0;
      try { _stLeft0 = document.querySelectorAll('input[name="station_id[]"]:checked').length; } catch (_) { _stLeft0 = 0; }
      if (_stLeft0 > 0) {
        try {
          window.__axlxNeedClearStation = true;
          window.__axlxPlaceClearPhase = "start";
          window.__axlxLineForceClearedOnce = false;
          if (_audit) _auditStepP("route_only_defer_st", "沿線のみだが残駅" + _stLeft0 + "→駅画面経由で先に外す");
        } catch (_) {}
      } else {
        console.warn('[AX] ⚠️ 沿線のみ検索（駅指定なし）: route_ids=' + (cond.route_ids || []).join(',') +
          ' / station_names が空です。上流の駅名解決を確認してください');
        showWarnToast('沿線のみで検索します（駅指定なし）');
        setCheckboxes("route_id[]", cond.route_ids);
      }
    }

    // 沿線・駅モーダル：waitForClick方式（必ず駅が選択されるまでリトライ）
    function closeStationModal() {
      /**
       * 2026-11-11 竹内さん「駅の場合は 1沿線・駅絞り込み 2該当する沿線 3駅の設定へ進む 4該当する駅 5確定してリストへ」
       * ★ 2026-11-16: 所在地と同じく **enqueue**（確定完了前に検索へ進まない）。
       * ★ 2026-11-17: 共通 `_pressConfirmListLikeHuman`（確定必押）。
       * ★ 2026-11-17 悠さん自動: 駅指定ありなのに駅0のまま確定→検索が根因。
       *   → 駅が1つも checked なら確定しない（駅選択へ戻す）。
       */
      if (hasStation) {
        var _uConf = null;
        try { _uConf = _understandStationScene(cond); } catch (_) { _uConf = null; }
        var _wantOkC = _uConf ? _uConf.wantOk : 0;
        var _wantN = (cond.station_names || []).length;
        try { _wantN -= _stationNamesAbsentStable(cond.station_names).length; } catch (_) {}
        if (_wantOkC < 1 || (_wantN > 0 && _wantOkC < _wantN)) {
          try {
            if (_audit) {
              _auditStepP(
                "station_confirm_blocked",
                "駅未揃いのまま確定しない want済=" + _wantOkC + "/" + _wantN +
                  (_uConf ? " phase=" + _uConf.phase + " screen=" + _uConf.screen : ""),
              );
            }
          } catch (_) {}
          try {
            if (_uConf && _uConf.phase === "need_go_station") {
              clickByText(["駅の設定へ進む", "駅の設定へ進む›", "駅の設定へ進む>"]);
            } else if (_uConf && (_uConf.phase === "need_station_select" || _uConf.screen === "station_list")) {
              selectStationsByName(cond.station_names);
            } else if (_uConf && _uConf.phase === "need_line_select" && hasRoutes) {
              clickLineButtons(cond.route_ids);
            }
          } catch (_) {}
          return false;
        }
      }
      if (_pressConfirmListLikeHuman("駅モーダル確定")) return true;
      var d = document.querySelector('div.this_window_close');
      if (d && isVisible(d)) {
        if (_audit) _auditStepP('station_confirm_fallback_x', '×とじる（確定が見つからない）');
        enqueueHumanClick(d, function (el) { try { el.click(); } catch (_) {} }, _uiGapMin(), _uiGapMax(), null, _uiGapOpts());
        return true;
      }
      return clickByText(['×とじる', '× とじる', 'とじる']);
    }
    /** 駅モーダル閉じたあと: キュー消化 → 条件1つずつ → 検索（通常と同じ順） */
    function _afterStationThenBasicSearch(why) {
      whenClickQueueIdle(function () {
        _runDeferredBasicThenSearch(why || "駅確定後");
      });
    }

    // 沿線・駅モーダル操作がタイムアウトした場合のフォールバック:
    // 全件検索（エリアなし）を送信するのは誤物件LINE送信の原因になるためnotifyDone(error)で中止する。
    // fallbackSearchWithoutArea と同じ方針: エリア条件が解決できない場合は検索しない。
    var _stationFailSent = false;
    function fallbackSearchWithoutStation(msg) {
      // 早めに止めた後、待ちの段の時間切れからもう一度呼ばれても1回だけ（終わりの通知を二重にしない）
      if (_stationFailSent) return;
      _stationFailSent = true;
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

    /**
     * ★ 2026-11-16: 続き客の前クリアは**モーダルが開いて見えるようになってから**
     *   （旧: 開く前に checked=false 直書き＝直接入力に見えた）。
     *   ここでは旗だけ立て、STEP B/D で駅→沿線の順にカーソル外しする。
     */
    (function _markNeedStationClear() {
      try {
        if (window.__axlxNeedClearStation || _shouldForceClearPrevPlace()) {
          window.__axlxNeedClearStation = true;
          // 続き客の外し状態機械を毎回リセット（沿線直外しに戻さない）
          window.__axlxPlaceClearPhase = "start";
          window.__axlxPlaceClearGoAt = 0;
          window.__axlxPlaceClearBackTries = 0;
          window.__axlxPlaceClearBegan = false;
          window.__axlxPlaceClearBackSettled = false;
          window.__axlxPlaceClearBackSettleUntil = 0;
          window.__axlxStationForceClearedOnce = false;
          window.__axlxLineForceClearedOnce = false;
        }
      } catch (_) {}
    })();

    // STEP A: 残区を外してから「沿線・駅絞り込み＋」
    _clearWardsBeforeStationThen(function () {
    waitForClick(
      function() {
        try {
          var _stOpB = _sidebarOpenerEl('沿線・駅絞り込み', _SIDEBAR_OTHER_RE);
          if (_stOpB) {
            try { _markPanelOpened("station", "station_open"); } catch (_) {}
            _pressLearned(_stOpB, ['左の沿線・駅絞り込み', '沿線・駅絞り込み＋', '沿線・駅絞り込み'], 'station_open');
            return true;
          }
        } catch (_) {}
        var clsTargets = ['click_menu', 'one_slide_search_box'];
        for (var ci = 0; ci < clsTargets.length; ci++) {
          var divs = Array.prototype.slice.call(document.querySelectorAll('div.' + clsTargets[ci]));
          for (var i = 0; i < divs.length; i++) {
            if (!isVisible(divs[i])) continue;
            var t = divs[i].textContent.replace(/\s+/g, '');
            if (t.includes('沿線・駅絞り込み')) {
              // 2026-11-14 竹内さん「この地域押すところ…ちゃんと学習する」: 駅の絞り込みも学んだ位置で押す
              try { _markPanelOpened("station", "station_open"); } catch (_) {}
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
        var _stationNextAt = 0, _stationNextN = 0;
        waitForClick(
          function() {
            var labels = Array.prototype.slice.call(document.querySelectorAll('label.one_line'));
            var vis = labels.filter(function(l) { return isVisible(l); });
            if (!vis.length) {
              // ★ 画面把握: closed/unknown なら路線一覧待ち（無理に駅直扱いしない）
              try {
                var _scrB = _graspStationModalScreen();
                if (_scrB.kind === "closed" || (_scrB.kind === "unknown" && _scrB.stVis === 0)) {
                  return false;
                }
              } catch (_) {}
              // 駅ページが直接表示されている場合（事前選択済みルートでモーダルが駅一覧を直接表示）
              // input[name="station_id[]"] はhidden checkboxのためisVisibleで不可視→親ラベルで判定
              var stationInputs = Array.prototype.slice.call(document.querySelectorAll('input[name="station_id[]"]'));
              var visStationParents = stationInputs.filter(function(i) {
                return i.parentElement && isVisible(i.parentElement);
              });
              if (visStationParents.length) {
                /**
                 * ★ 2026-11-17: 駅ページ直でも「駅を1つずつ外す→沿線画面へ戻って沿線を外す」。
                 *   旧は駅だけ外して LineForceClearedOnce まで立てて沿線外しを飛ばしていた。
                 */
                var _forceStPage = (_shouldForceClearPrevPlace() || window.__axlxNeedClearStation) && !window.__axlxLineForceClearedOnce;
                if (_forceStPage) {
                  try {
                    if (!window.__axlxPlaceClearPhase || window.__axlxPlaceClearPhase === "done") {
                      window.__axlxPlaceClearPhase = "clear_stations";
                    }
                  } catch (_) {}
                  if (!_advanceForcePlaceClearViaStationFirst()) return false;
                  try { if (isClickQueueBusy()) return false; } catch (_) {}
                }
                console.log('[AX] STEP B: 駅ページが直接表示(親label可視) → stationPageDirect=true');
                stationPageDirect = true;
                return true;
              }
              return false; // まだ描画されていない
            }
            /**
             * ★ 2026-11-17 竹内さん「駅の設定へ進むにまず沿線の画面からすすんでえきを１つずつ外す／そのあとに沿線」:
             *   ⚠ 旧: 沿線画面で `_uncheckStationsThenLinesLikeHuman` → 駅が見えず**沿線だけ直外し**。
             *   新: 沿線画面→駅の設定へ進む→駅1つずつ外す→沿線画面へ戻る→沿線外す。
             */
            /**
             * ★ 2026-11-17: form に駅が残っているのに沿線だけ外す＝直接入力に見える。
             *   残駅があれば必ず駅画面経由クリアを先に完了させる。
             */
            var _formStLeft = 0;
            try { _formStLeft = document.querySelectorAll('input[name="station_id[]"]:checked').length; } catch (_) { _formStLeft = 0; }
            if (_formStLeft > 0) {
              try {
                window.__axlxNeedClearStation = true;
                if (window.__axlxLineForceClearedOnce) window.__axlxLineForceClearedOnce = false;
                if (!window.__axlxPlaceClearPhase || window.__axlxPlaceClearPhase === "done") {
                  window.__axlxPlaceClearPhase = "start";
                }
              } catch (_) {}
            }
            var _forcePlaceClear = (_shouldForceClearPrevPlace() || window.__axlxNeedClearStation || _formStLeft > 0) && !window.__axlxLineForceClearedOnce;
            if (_forcePlaceClear) {
              try {
                if (!window.__axlxPlaceClearPhase || window.__axlxPlaceClearPhase === "done") {
                  window.__axlxPlaceClearPhase = "start";
                }
              } catch (_) {}
              if (!_advanceForcePlaceClearViaStationFirst()) return false;
              try { if (isClickQueueBusy()) return false; } catch (_) {}
              /**
               * ★ 2026-11-17 画面把握: 外し完了後にモーダルが閉じていると
               *   「路線一覧が表示されませんでした」。→ closed なら開き直してから選ぶ。
               */
              try {
                var _scrAfter = _graspStationModalScreen();
                if (_scrAfter.kind === "closed") {
                  if (!window.__axlxStationReopenAfterClear) {
                    window.__axlxStationReopenAfterClear = true;
                    if (_audit) _auditStepP("screen_reopen_after_clear", "外し後closed→沿線・駅を開き直す");
                    clickByText(["沿線・駅絞り込み＋", "沿線・駅絞り込み+", "沿線・駅絞り込み"]);
                  }
                  return false;
                }
                window.__axlxStationReopenAfterClear = false;
              } catch (_) {}
            }
            var wantedLineNorms = (hasRoutes ? cond.route_ids : []).map(function(id) {
              return ROUTE_LINE_MAP[id] ? norm(ROUTE_LINE_MAP[id]) : null;
            }).filter(Boolean);
            var _clearedLines = 0;
            var _keptOverlap = 0;
            var _keptMine = 0;
            // force 済みでない通常パス: want 以外の沿線だけ外す（駅は STEP D）
            // ⚠ 残駅がある間は沿線直外ししない（上で force 完了するまで待つ）
            if (!_forcePlaceClear && _formStLeft === 0) {
              vis.forEach(function(lbl) {
                var cb = lbl.querySelector('input[type="checkbox"]');
                if (!cb && lbl.htmlFor) {
                  try { cb = document.getElementById(lbl.htmlFor); } catch (_) { cb = null; }
                }
                if (!cb || !cb.checked) return;
                var lNorm = norm(lbl.textContent);
                var isWanted = wantedLineNorms.some(function(w) {
                  return w === lNorm || (lNorm.length >= 4 && w.endsWith(lNorm)) || (w.length >= 4 && lNorm.endsWith(w));
                });
                if (isWanted) {
                  var _mine = false;
                  try { _mine = !!(window.__axlxLinePickedRun && window.__axlxLinePickedRun[String(cb.value || "")]); } catch (_) {}
                  if (_mine) _keptMine++; else _keptOverlap++;
                  return;
                }
                _toggleCheckboxLikeHuman(cb, false);
                _clearedLines++;
              });
              if (_keptOverlap > 0 && !window.__axlxLineOverlapSent) {
                try { window.__axlxLineOverlapSent = true; } catch (_) {}
                try { _auditStepP("station_line_overlap", "沿線" + _keptOverlap + "本は前客と被り残し→駅は必ず選び直す"); } catch (_) {}
              }
              if (_clearedLines > 0) {
                try { _auditStepP("station_line_clear_extra", "不要沿線" + _clearedLines + "本をカーソルで外す"); } catch (_) {}
              }
            }
            /**
             * 2026-11-11 竹内さん「なんでh.rさん沿線選択されずにとまってしまうのか」:
             *   ⚠ `clickLineButtons` は**クリックの列（非同期）**に積むだけなので、
             *     ここで `return true` すると**路線が押される前に次の段（駅の設定へ進む）へ進んでいた**。
             *     → 路線が本当に checked になるまで待つ（最大 _modalTry 回）。
             * ★ 2026-11-16: 沿線が全部既存でも true にしてよいが、**駅選択は絶対にスキップしない**
             *   （下の STEP D が hasStation なら必ず selectStationsByName）。
             */
            if (_stationFailSent) return false;
            /**
             * ★ 2026-11-19 竹内さん「かえさん検索途中で止まった・駅の部分で詰まっている」（audit #1521）:
             *   希望「堺市・商店街近く」（地域のお客様）の「堺市」が駅として届き、沿線（route_ids）0本のまま駅の段へ入った。
             *   STEP C で「沿線未選択→駅へ進まない」を約80秒繰り返してから止まっていた。沿線が無いと駅は選べない。
             *   → 沿線0本・画面の沿線 checked も0の時は、待たずに理由を残して止める（全件検索はしない）。
             */
            if (!hasRoutes && hasStation) {
              var _lnNow0 = 0;
              try { _lnNow0 = document.querySelectorAll('input[name="route_id[]"]:checked').length; } catch (_) { _lnNow0 = 0; }
              if (_lnNow0 < 1) {
                try { if (_audit) _auditStepP("station_no_route", "駅=" + (cond.station_names || []).join("・").slice(0, 60) + " 沿線0本→止める"); } catch (_) {}
                fallbackSearchWithoutStation('沿線が決まっていません（駅: ' + (cond.station_names || []).join('・') + '・沿線0本）。地域の名前を駅として読んだ可能性があります。');
                return false;
              }
            }
            if (hasRoutes) clickLineButtons(cond.route_ids);
            // キューに積んだ外し／押しが終わるまで次段へ進まない（沿線残し＋駅選びの原子）
            try { if (isClickQueueBusy()) return false; } catch (_) {}
            /**
             * 2026-11-13 竹内さん「沿線絞り込みの部分はどうなっているか」:
             *   路線を押す段も残す（学習で「沿線 → 駅へ進む」の順を学べるように）。
             *   ⚠ 路線の名前は入れない（段の名前だけ）。
             */
            try { _auditStepP('station_line', '沿線を選ぶ'); } catch (_) {}
            /**
             * ★ 2026-11-16 KAORI録画「沿線は2つ選択しているが駅は1つの沿線分しか選んでいない」:
             *   旧は want の**どれか1本**が checked なら次へ（some）→ 2本目が押される前に
             *   「駅の設定へ進む」へ進み、駅一覧が片方の沿線だけになる。
             *   → **全部の沿線が checked になるまで待つ**（every）。
             */
            var _lineOk = !hasRoutes ? true : (function () {
              var want = (cond.route_ids || []).map(function (id) { return ROUTE_LINE_MAP[id]; }).filter(Boolean).map(norm);
              if (!want.length) return true;
              // ★ 可視ラベル＋ form 両方（悠さん: 可視だけだと every が永遠に false）
              var nowChecked = Array.prototype.slice.call(document.querySelectorAll('label.one_line'))
                .filter(function (l) {
                  var c = l.querySelector('input[type="checkbox"]');
                  if (!c && l.htmlFor) { try { c = document.getElementById(l.htmlFor); } catch (_) { c = null; } }
                  return c && c.checked;
                })
                .map(function (l) { return norm(l.textContent); });
              // form に checked があるのにラベル照合が弱い時: 本数で足切り（want数≤form数）
              var formN = 0;
              try { formN = document.querySelectorAll('input[name="route_id[]"]:checked').length; } catch (_) { formN = 0; }
              var matchOne = function (w) {
                return nowChecked.some(function (n) {
                  return w === n || (n.length >= 4 && w.endsWith(n)) || (w.length >= 4 && n.endsWith(w));
                });
              };
              if (want.every(matchOne)) return true;
              if (formN >= want.length && formN > 0) {
                try { if (_audit) _auditStepP("line_ok_form", "form沿線" + formN + "≥want" + want.length + "→駅へ進む"); } catch (_) {}
                return true;
              }
              return false;
            })();
            if (!_lineOk) {
              // まだ路線が入っていない（クリックの列の途中）→ この段をもう一度
              try {
                window.__axlxLineWaitN = (window.__axlxLineWaitN || 0) + 1;
                if (_audit && window.__axlxLineWaitN % 10 === 0) {
                  var _missLn = (cond.route_ids || []).map(function (id) { return ROUTE_LINE_MAP[id]; }).filter(Boolean)
                    .filter(function (nm) {
                      var n0 = norm(nm);
                      return !Array.prototype.slice.call(document.querySelectorAll('label.one_line')).some(function (l) {
                        var c = l.querySelector('input[type="checkbox"]');
                        if (!c && l.htmlFor) { try { c = document.getElementById(l.htmlFor); } catch (_) { c = null; } }
                        return c && c.checked && norm(l.textContent) === n0;
                      });
                    });
                  _auditStepP("station_line_wait", window.__axlxLineWaitN + "回待ち 未チェック=" + _missLn.join("・").slice(0, 80) + " 自押し済=" + _keptMine);
                }
              } catch (_) {}
              /**
               * ★ 2026-11-19 竹内さん「タクヤの場合沿線だけおして駅を押さなかった」（audit #1513）:
               *   1本目だけ押され、2本目は列から落ちた後の印が残って二度と積まれず、ここで64秒回り続けた。
               *   列が空なのに未チェックの沿線が残る時は、その沿線だけ印を外して押し直す（最大3回）。
               *   それでも入らない時は理由（ラベル有無・チェック・印・画面）を1回だけ残す。
               */
              try {
                var _lnIdle = true;
                try { _lnIdle = !isClickQueueBusy(); } catch (_) { _lnIdle = true; }
                var _lnLabelOf = function (id) {
                  var nm0 = ROUTE_LINE_MAP[id] ? norm(ROUTE_LINE_MAP[id]) : "";
                  if (!nm0) return null;
                  var all = Array.prototype.slice.call(document.querySelectorAll('label.one_line'));
                  for (var i0 = 0; i0 < all.length; i0++) { if (norm(all[i0].textContent) === nm0) return all[i0]; }
                  for (var i1 = 0; i1 < all.length; i1++) {
                    var t1 = norm(all[i1].textContent);
                    if (t1.length >= 4 && nm0.endsWith(t1)) return all[i1];
                  }
                  return null;
                };
                var _lnCbOf = function (lb) {
                  if (!lb) return null;
                  var c0 = lb.querySelector('input[type="checkbox"]');
                  if (!c0 && lb.htmlFor) { try { c0 = document.getElementById(lb.htmlFor); } catch (_) { c0 = null; } }
                  return c0;
                };
                var _missIds = (cond.route_ids || []).filter(function (id) {
                  var c1 = _lnCbOf(_lnLabelOf(id));
                  return !(c1 && c1.checked);
                });
                if (_lnIdle && _missIds.length && window.__axlxLineWaitN % 8 === 0 && (window.__axlxLineRepressN || 0) < 3) {
                  window.__axlxLineRepressN = (window.__axlxLineRepressN || 0) + 1;
                  _missIds.forEach(function (id) {
                    var lb1 = _lnLabelOf(id);
                    var cb1 = _lnCbOf(lb1);
                    [lb1, cb1].forEach(function (e1) {
                      if (e1 && e1.__axPending && !_isElQueuedOrBusy(e1)) e1.__axPending = false;
                    });
                  });
                  if (_audit) _auditStepP("station_line_repress", window.__axlxLineRepressN + "回目 未チェック=" + _missIds.map(function (id) { return ROUTE_LINE_MAP[id] || id; }).join("・").slice(0, 80));
                  clickLineButtons(_missIds);
                } else if (_missIds.length && (window.__axlxLineRepressN || 0) >= 3 && window.__axlxLineWaitN >= 40 && !window.__axlxLineStuckSent) {
                  window.__axlxLineStuckSent = true;
                  var _why = _missIds.map(function (id) {
                    var lb2 = _lnLabelOf(id);
                    var cb2 = _lnCbOf(lb2);
                    return (ROUTE_LINE_MAP[id] || id) + ":" + (!lb2 ? "ラベル無" : (!cb2 ? "箱無" : (cb2.checked ? "済" : "未"))) +
                      ((lb2 && lb2.__axPending) || (cb2 && cb2.__axPending) ? "・印残" : "");
                  });
                  var _scrK = "";
                  try { _scrK = _graspStationModalScreen().kind; } catch (_) { _scrK = "?"; }
                  if (_audit) _auditStepP("station_line_stuck", _why.join("／").slice(0, 120) + " 画面=" + _scrK + " 列=" + (_lnIdle ? "空" : "動"));
                }
              } catch (_) {}
              return false;
            }
            try { window.__axlxLineWaitN = 0; } catch (_) {}
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
                  if (!_stationNextAt) _stationNextAt = Date.now(); // 押し終わった時刻から切り替わりを待つ
                  // ★ 画面把握: 駅一覧に移ったか（form/ラベル）。沿線一覧のままなら押し直し
                  try {
                    var _uGo = _understandStationScene(cond);
                    if (_uGo.screen === "station_list" || _uGo.scr.stVis > 0) {
                      try {
                        if (window.__axlxAwaitGoUnderstand) {
                          window.__axlxAwaitGoUnderstand = 0;
                          _verifyPressUnderstood("go", { formLn: _uGo.formLn });
                        }
                      } catch (_) {}
                      return true;
                    }
                    if (_uGo.screen === "line_list") {
                      /**
                       * ★ 2026-11-19 竹内さん「沿線おしたあとは駅の設定にページ移動することは理解できていないのか」:
                       *   旧は押し終わった直後（画面が切り替わる前）にも沿線一覧なら即押し直していた（二度押し）。
                       *   → 押してから 1.8秒は切り替わりを待つ。3回押しても沿線一覧のままなら理由を残す。
                       */
                      if (Date.now() - _stationNextAt < 1800) return false;
                      try {
                        if (window.__axlxAwaitGoUnderstand && Date.now() - Number(window.__axlxAwaitGoUnderstand) > 2500) {
                          window.__axlxAwaitGoUnderstand = 0;
                          _verifyPressUnderstood("go", { formLn: _uGo.formLn });
                        }
                      } catch (_) {}
                      if (_stationNextN >= 3 && _stationNextN % 3 === 0) {
                        try {
                          if (_audit) _auditStepP("station_go_stuck", "駅の設定へ進むを" + _stationNextN + "回押しても沿線一覧のまま 沿線form=" + _uGo.formLn + "/" + _uGo.wantLnN);
                        } catch (_) {}
                      }
                      _stationNextPressed = false;
                      return false;
                    }
                  } catch (_) {}
                  if (document.querySelectorAll('label.one_line').length > 0 &&
                      document.querySelector('div.this_window_close') &&
                      !document.querySelectorAll('input[name="station_id[]"]').length) {
                    _stationNextPressed = false;
                    return false;
                  }
                  return true;
                }
                if (_pressBusy > 0) return false;
                /**
                 * ★ 2026-11-17 竹内さん「沿線押し≠駅選択の理解」:
                 *   場面理解で need_go_station / form沿線あり のときだけ進む。
                 *   沿線未選択なら選ぶ段に戻す（駅へ進まない）。
                 */
                var _uC = null;
                try { _uC = _understandStationScene(cond); } catch (_) { _uC = null; }
                var _lnChk = _uC ? _uC.formLn : 0;
                try { if (!_lnChk) _lnChk = _countCheckedRoutes(); } catch (_) {}
                if (_uC && _uC.phase === "need_line_select") {
                  try {
                    if (hasRoutes) clickLineButtons(cond.route_ids);
                    var _blkAt2 = Number(window.__axlxGoWithoutLineAt) || 0;
                    if (Date.now() - _blkAt2 > 2000) {
                      window.__axlxGoWithoutLineAt = Date.now();
                      if (_audit) _auditStepP("station_go_without_line", "STEP C: 場面=need_line_select→沿線を先に選ぶ");
                    }
                  } catch (_) {}
                  return false;
                }
                if (_lnChk < 1) {
                  try {
                    var _blkAt = Number(window.__axlxGoWithoutLineAt) || 0;
                    if (Date.now() - _blkAt > 2000) {
                      window.__axlxGoWithoutLineAt = Date.now();
                      if (_audit) _auditStepP("station_go_without_line", "STEP C: 沿線未選択→駅へ進まない form+vis=0");
                    }
                  } catch (_) {}
                  return false;
                }
                // すでに駅画面なら STEP D へ（沿線押し済みの理解）
                if (_uC && (_uC.screen === "station_list" || _uC.phase === "need_station_select" || _uC.phase === "need_confirm")) {
                  if (_audit) _auditStepP("station_scene_ready", "STEP C: 既に駅画面/選択段 phase=" + _uC.phase);
                  return true;
                }
                if (clickByText(['駅の設定へ進む', '駅の設定へ進む›', '駅の設定へ進む>'])) {
                  _stationNextPressed = true;
                  _stationNextAt = 0;
                  _stationNextN++;
                  if (_audit) _auditStepP('station_next_press', '駅の設定へ進む formLn=' + _lnChk + (_uC ? " phase=" + _uC.phase : ""));
                  // ★ 押した理解: 直後はまだ遷移前なので印だけ。次ポーリングで _verifyPressUnderstood('go')
                  try { window.__axlxAwaitGoUnderstand = Date.now(); } catch (_) {}
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
                    waitForClick(closeStationModal, function() { _afterStationThenBasicSearch("沿線のみ"); },
                      20, 500, (500 + Math.floor(Math.random() * 500)),
                      function() {
                        console.warn('[AX] 沿線モーダルを閉じられず → 条件→検索');
                        _afterStationThenBasicSearch("沿線閉じられず");
                      });
                  };
                  waitForClick(
                    function() {
                      // 駅リストが描画されるまで待ち、可視 one_station を1つずつ外す（input 直押し禁止）
                      if (!document.querySelectorAll('input[name="station_id[]"]').length) return false;
                      var n = 0;
                      Array.prototype.slice.call(document.querySelectorAll('input[name="station_id[]"]:checked'))
                        .forEach(function(inp) {
                          var hit = _labelForCheckbox(inp);
                          if (!hit || !isVisible(hit)) return;
                          _toggleCheckboxLikeHuman(inp, false);
                          n++;
                        });
                      if (n && _audit) _auditStepP("station_clear_cursor", "沿線のみ: 駅" + n + "をカーソルで外す");
                      try { if (isClickQueueBusy()) return false; } catch (_) {}
                      return true;
                    },
                    _closeAndSearch,
                    6, 500, _hd(300),
                    _closeAndSearch
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
                    /**
                     * ★ 2026-11-17 竹内さん「沿線押しと駅選択の理解」:
                     *   沿線画面のまま駅を選ぼうとしない。場面が line_list なら先に駅へ進む。
                     *   駅が揃うまで確定しない（wantOk は form で数える）。
                     */
                    try {
                      var _uD = _understandStationScene(cond);
                      if (_uD.phase === "need_line_select" || (_uD.formLn < 1 && hasRoutes)) {
                        if (hasRoutes) clickLineButtons(cond.route_ids);
                        return false;
                      }
                      if (_uD.phase === "need_go_station" || _uD.screen === "line_list") {
                        if (_uD.formLn >= 1) clickByText(["駅の設定へ進む", "駅の設定へ進む›", "駅の設定へ進む>"]);
                        return false;
                      }
                      var _uDNeed = (_uD.wantTargets > 0 ? _uD.wantTargets : _uD.wantStN);
                      if (_uD.phase === "need_confirm" && _uD.wantOk >= _uDNeed && _uDNeed > 0) {
                        if (_audit) _auditStepP("station_select_ok", "want済=" + _uD.wantOk + "/" + _uDNeed + "（名" + _uD.wantStN + "）→確定へ");
                        return true;
                      }
                    } catch (_) {}
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
                    // ★ 毎パス: 不要駅を one_station で1つずつ外す（直書き禁止）。
                    //   続き客の全外しは STEP B で駅→沿線済み。ここでは want 以外だけ。
                    var _wantedStCleans = (cond.station_names || []).map(function(sn) {
                      return sn.replace(/駅$/, '').trim();
                    });
                    var _stClearN = 0;
                    Array.prototype.slice.call(document.querySelectorAll('input[name="station_id[]"]:checked'))
                      .filter(function(inp) {
                        var lab = _labelForCheckbox(inp) || inp.parentElement;
                        if (lab && !isVisible(lab)) return false; // 見えない＝直接入力経路に落とさない
                        var ptxt = ((lab && lab.textContent) || '').replace(/\s+/g, '').replace(/駅$/, '');
                        return !_wantedStCleans.some(function(c) {
                          return ptxt === c ||
                            (ptxt.length >= 2 && c.length >= 2 && (ptxt.startsWith(c) || c.startsWith(ptxt)));
                        });
                      })
                      .forEach(function(inp) {
                        _toggleCheckboxLikeHuman(inp, false);
                        _stClearN++;
                      });
                    if (_stClearN > 0) {
                      try { if (_audit) _auditStepP("station_clear_cursor", "不要駅" + _stClearN + "を one_station で1つずつ外す"); } catch (_) {}
                    }
                    /**
                     * ★ 2026-11-16 竹内さん「沿線が被って残っていても駅はちゃんと選択する」＋「外してから新客」:
                     *   外したあと客の駅を必ず選び直す（one_station）。
                     */
                    selectStationsByName(cond.station_names);
                    try { if (_audit) _auditStepP("station_reselect", "駅を選び直す want=" + _wantedStCleans.length); } catch (_) {}
                    try { if (isClickQueueBusy()) return false; } catch (_) {}
                    /**
                     * ★ 2026-11-17: 駅の「選んだ」判定は form（可視だけだと0のまま確定していた）。
                     *   wantOk = want名が form で checked の数。沿線押しとは別印。
                     */
                    var _wantOkForm = 0;
                    var _wantTargets = 0;
                    try { _wantOkForm = _countWantStationsChecked(cond.station_names); } catch (_) { _wantOkForm = 0; }
                    try { _wantTargets = _countWantStationTargets(cond.station_names, cond); } catch (_) { _wantTargets = _wantedStCleans.length; }
                    var _absentD = [];
                    try { _absentD = _stationNamesAbsentStable(cond.station_names); } catch (_) { _absentD = []; }
                    if (_absentD.length) {
                      try { _wantTargets = _countWantStationTargets(cond.station_names, cond, true); } catch (_) {}
                    }
                    var _floorD = _wantedStCleans.length - _absentD.length;
                    if (_wantTargets < _floorD) _wantTargets = _floorD;
                    try { _auditLineStationMap(cond); } catch (_) {}
                    var _checkedCount = _wantOkForm;
                    /**
                     * ★ 沿線ごとの同名駅: 候補本数ぶん checked になるまで完了にしない
                     *   （旧: 駅名1つで1本 checked なら完了 → 十三が1つだけ）
                     */
                    var _allMatchedChecked = _wantTargets > 0 && _wantOkForm >= _wantTargets;
                    try {
                      if (_audit) {
                        _auditStepP(
                          _allMatchedChecked ? "station_per_line_done" : "station_per_line_gap",
                          "want名" + _wantedStCleans.length + " → 候補" + _wantTargets + " 済" + _wantOkForm,
                        );
                      }
                      var _mapExp2 = _mapExpectWantStationTargets(_wantedStCleans, _selectedLineNamesNow(cond));
                      if (_mapExp2 > 0 && _wantOkForm < _mapExp2 && !_absentD.length) {
                        _auditStepP(
                          "line_station_map_gap",
                          "地図期待" + _mapExp2 + " 済" + _wantOkForm + "（沿線ごと不足）",
                        );
                        _allMatchedChecked = false;
                      }
                    } catch (_) {}
                    // 可視ラベルでも二重確認（form と食い違う時の診断）
                    var _stVis = Array.prototype.slice.call(document.querySelectorAll('label.one_station'));
                    if (!_stVis.length) _stVis = vis;
                    if (!_allMatchedChecked) {
                      var _visOk = 0;
                      (cond.station_names || []).forEach(function(sn) {
                        var clean = sn.replace(/駅$/, '').trim();
                        _stVis.forEach(function(l) {
                          var txt = l.textContent.replace(/\s+/g, '').replace(/駅$/, '');
                          if (!_stationNameMatch(txt, clean)) return;
                          var inp = l.querySelector('input[type="checkbox"]');
                          if (!inp && l.htmlFor) inp = document.getElementById(l.htmlFor);
                          if (inp && inp.checked) _visOk++;
                        });
                      });
                      if (_visOk > _checkedCount) _checkedCount = _visOk;
                      if (_wantTargets > 0 && _visOk >= _wantTargets) _allMatchedChecked = true;
                    }
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
                    /**
                     * ★ 2026-11-16: 通勤stallで1駅だけ選んで進むと「沿線2本なのに駅1つ」になる。
                     *   指定駅が複数／沿線が2本以上の時は、半数未満で途中打ち切りしない（every 完了か上限まで待つ）。
                     */
                    var _wantStN = (cond.station_names || []).length;
                    var _wantLineN = (cond.route_ids || []).length;
                    var _stallMinOk = Math.max(1, Math.min(_wantStN, Math.ceil(_wantStN * 0.5)));
                    if (_wantLineN >= 2 && _wantStN <= 2) _stallMinOk = Math.max(_stallMinOk, _wantStN); // ハブ少数は全部必須
                    if (cond.commute && !_allMatchedChecked && _checkedCount >= 1) {
                      if (_checkedCount === _cmPrevChecked && ++_cmStall >= 3) {
                        if (_checkedCount < _stallMinOk) {
                          console.warn("[AX] STEP D(通勤): " + _checkedCount + "/" + _wantStN + "駅で停滞だが下限" + _stallMinOk + "未満 → まだ待つ");
                          return false;
                        }
                        console.warn("[AX] STEP D(通勤の到達時間): " + _checkedCount + "/" + _wantStN + "駅で選択が止まった → 選べた駅で検索");
                        showWarnToast("通勤の駅を" + _checkedCount + "/" + _wantStN + "駅選択しました");
                        _auditStepP("commute_stall", _checkedCount + "/" + _wantStN);
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
                      // STEP F: 確定後 → 条件1つずつ → 検索（通常と同じ順）
                      _afterStationThenBasicSearch("駅確定後");
                    },
                    20, 500, (500 + Math.floor(Math.random() * 500)),
                    function() {
                      console.warn('[AX] 駅モーダルを閉じられず → 条件→検索');
                      _afterStationThenBasicSearch("駅閉じられず");
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
    }); // _clearWardsBeforeStationThen end

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

    // ── 物件名をセット（直代入禁止 → カーソル移動＋1文字ずつ入力）────────────────
    var _pressFwSearch = function () {
      window.__axlxEstimateSearchResult = { ok: true, triggered: true };
      if (_guideOn()) { window.__axlxEstimateSearchResult = { ok: false, error: "guide-mode: 案内モードのため検索を押さない" }; return; }
      try { _fwBtn.__axPending = false; } catch (_) {}
      if (!enqueueHumanClick(_fwBtn, function (el) { try { el.click(); } catch (_) {} }, _uiGapMin(), _uiGapMax(), null, { label: "click:検索(見積)", strictLo: true, sigma: 0.55 })) {
        _humanPointerClick(_fwBtn, function () { try { _fwBtn.click(); } catch (_) {} });
      }
    };
    var _fwBtnPre = (function () {
      var _fwInModal = function (el) {
        try { return !!(el.closest && el.closest('.this_window, [role="dialog"], .modal, #modal, .modal_wrap')); } catch (_) { return false; }
      };
      var _fwCand = Array.prototype.slice.call(document.querySelectorAll("div.go_search, div.go_search_submit"))
        .filter(function (d) { return !_fwInModal(d); });
      return _fwCand[0] || (function () {
        var candidates = Array.from(document.querySelectorAll("button, input[type='submit'], div[onclick], a"))
          .filter(function (el) { return !_fwInModal(el); });
        return candidates.find(function (el) {
          var t = (el.textContent || el.value || "").trim();
          return ["住居検索", "検索", "物件を検索する", "条件で検索"].some(function (kw) { return t.includes(kw); });
        });
      })();
    })();
    var _fwBtn = _fwBtnPre;
    if (!_fwBtn) {
      window.__axlxEstimateSearchResult = {
        ok: false,
        error: "検索ボタンが見つかりません（div.go_search が存在しない可能性があります）",
      };
      return;
    }
    try {
      Promise.resolve(typeTextLikeHuman(_fwInput, _fwPropName)).then(_pressFwSearch, _pressFwSearch);
    } catch (_) {
      _pressFwSearch();
    }

    // 詳細ボタンのクリックは background.js の Step 5 が chrome.tabs.onUpdated で
    // 捕捉しながら行う。page-script.js は search triggered を通知するだけでよい。
    // （旧実装で _fwPoll/_fwScanRows がクリックすると background.js と二重クリックになるため廃止）
  });

  // 2026-09-27 v2.5.32 content.js の「page-script は生きているか」に答える（一括検索の前のタブの確かめ）
  /**
   * ★ 2026-11-17 次客乗り換え: pong に fillRunning／客ID／世代を載せる。
   *   no_fill_start→tab_reload が「別客の fill 中」にページを壊す抜けを止める材料。
   */
  window.addEventListener("message", function(e) {
    if (e.source !== window || !e.data || e.data.from !== "axlx-page-ping") return;
    window.postMessage({
      from: "axlx-page-pong",
      id: e.data.id,
      fillRunning: !!window._axFillRunning,
      fillCustomerId: window._axFillRunningCustomerId || _fillCustomerId || null,
      fillGen: Number(window.__axlxFillGen) || 0,
      pageVer: (typeof _AXLX_PAGE_VER !== "undefined") ? _AXLX_PAGE_VER : null,
    }, "*");
  });
  function _forceFillClearSafe(reason, onlyCustomerId) {
    try {
      var cur = window._axFillRunningCustomerId || _fillCustomerId || null;
      // ★ 2026-11-20: 進行中の番号が分からない入力が動いている時は、別のお客さん宛ての clear で壊さない
      if (onlyCustomerId != null && ((cur != null && String(onlyCustomerId) !== String(cur)) || (cur == null && window._axFillRunning))) {
        console.warn("[AX] force-fill-clear スキップ（別客が進行中） want=" + String(onlyCustomerId).slice(0, 8) + " cur=" + String(cur).slice(0, 8) + " reason=" + (reason || ""));
        try { if (_audit) _auditStepP("force_clear_skip", "別客進行中→壊さない"); } catch (_) {}
        return false;
      }
      console.warn("[AX] force-fill-clear: " + (reason || "") + " → fillRunning 解除");
      try { clearClickQueue(); } catch (_) {}
      window._axFillRunning = false;
      window._axFillRunningCustomerId = null;
      _doneNotified = false;
      if (_watchdogTimer) { clearTimeout(_watchdogTimer); _watchdogTimer = null; }
      try {
        if (window.__axStallWatch) { clearInterval(window.__axStallWatch); window.__axStallWatch = null; }
        if (window.__axFastSearchWatch) { clearInterval(window.__axFastSearchWatch); window.__axFastSearchWatch = null; }
      } catch (_) {}
      return true;
    } catch (_) { return false; }
  }
  /**
   * ★ 2026-11-16 連続客: bg が fill_timeout した時に fillRunning を強制クリア。
   * ★ 2026-11-17: **客スコープ**（次客 fill 中に前客 timeout の clear で壊さない）。
   */
  try {
    if (typeof chrome !== "undefined" && chrome.runtime && chrome.runtime.onMessage) {
      chrome.runtime.onMessage.addListener(function (msg) {
        try {
          if (!msg || msg.type !== "axlx-force-fill-clear") return;
          _forceFillClearSafe(msg.reason || "fill_timeout", msg.customerId != null ? msg.customerId : null);
        } catch (_) {}
      });
    }
  } catch (_) {}
  window.addEventListener("message", function (e) {
    try {
      if (!e.data || e.data.from !== "axlx-force-fill-clear") return;
      _forceFillClearSafe(e.data.reason || "", e.data.customerId != null ? e.data.customerId : null);
    } catch (_) {}
  });

  window.addEventListener("message", function(e) {
    if (!e.data || e.data.from !== "aixlinx-fill") return;
    /**
     * ★ 2026-11-18 竹内さん「お客さん検索中や選択中上書きしないように ちゃんと１人のお客さん完了してから次のお客さんに移るように」:
     *   旧は別のお客さんの依頼が来ると前のお客さんの入力を閉じて（superseded）次を始めた＝入力途中の画面を上書きした。
     *   → 前のお客さんの入力が進んでいる間（無進捗 3分未満）は断る（busy_other_customer）。
     *     3分以上止まっている入力だけ、今まで通り閉じて次へ（止まった入力で永久に詰まらない）。
     *   判定は customer-handoff.js の pageIncomingDecision と同じ（ページの中には読み込まないので写し）。
     */
    try {
      var _incCid = e.data.customerId || null;
      var _runCidNow = window._axFillRunningCustomerId || null;
      var _lastTouch = Number(window.__axlxFillTouchAt) || _axFillStartedAt || 0;
      var _otherCust = window._axFillRunning && !_doneNotified && (_runCidNow || _incCid)
          && String(_runCidNow || "") !== String(_incCid || "");
      /**
       * ★ 2026-11-20 竹内さん「連続でお客さんちゃんと検索できるように」:
       *   旧は「3分以上止まった前客なら閉じて次へ」のつもりが、中（fillRealpro）で別客を必ず断り、
       *   さらに片方に番号が無いと「同じ人の重複」として黙って無視（このとき _fillCustomerId だけ次客に変わり、
       *   前客の結果が次客の番号で返り得た）。→ 3分以上止まった前客は、ここで前客の番号のまま閉じてから次客を始める。
       */
      if (_otherCust && Date.now() - _lastTouch >= 3 * 60 * 1000) {
        console.warn("[AX] 前のお客さんの入力が3分以上止まっている → 前客を閉じて次へ run=" + String(_runCidNow || "-").slice(0, 8) + " next=" + String(_incCid || "-").slice(0, 8));
        try { if (_audit) _auditStepP("stuck_prev_closed", "前客が3分以上無進捗→前客の番号で閉じて次客へ next=" + String(_incCid || "-").slice(0, 8)); } catch (_) {}
        try { if (_runCidNow) _fillCustomerId = _runCidNow; } catch (_) {}
        try { notifyDone("stuck_superseded: 前のお客さんの入力が3分以上進まず、次のお客さんに移りました"); } catch (_) {}
        try { _forceFillClearSafe("stuck_superseded", null); } catch (_) {}
        _otherCust = false;
      }
      if (_otherCust) {
        console.warn("[AX] 前のお客さんの入力中 → 次のお客さんは始めません run=" + String(_runCidNow || "-").slice(0, 8) + " next=" + String(_incCid || "-").slice(0, 8));
        try { if (_audit) _auditStepP("next_customer_refused", "前客入力中→次客を断った next=" + String(_incCid || "-").slice(0, 8)); } catch (_) {}
        window.postMessage({
          from: "aixlinx-fill-done", gate: true, gateKind: "busy_other_customer", customerId: _incCid,
          error: "busy_other_customer: 前のお客さんの条件入力中のため、このお客さんは始めませんでした（上書きしない）",
        }, "*");
        return;
      }
    } catch (_) {}
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
      notifyDone('fill_exception: fillRealpro listener: ' + ((err && err.message) || String(err)));
    }
  });
})();
