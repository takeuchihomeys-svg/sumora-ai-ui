// chrome-extension/realpro-guide-plan.js（self.AxlxRealproGuidePlan・純関数・chrome.* も DOM も使わない）
// リアプロの「案内モード」の手順表: お客様の条件から「どの欄に何を入れるか」を1つずつ並べる。
//
// 2026-10-01 竹内「光らせるようにする。今選択しているところを光らせるようにする」「そうすれば機械的な動きがなく人間が押す形となる」:
//   拡張は値を入れない・押さない。この手順表を realpro-guide.js が上から見て、まだ終わっていない最初の欄を光らせ、
//   スタッフが入れ終わったら次へ進む。押すのは常にスタッフ。
//
// 値の決め方は page-script.js fillRealpro と同じ（家賃・面積は選択肢に丸める・築年数は上に丸める・間取りの広げ方・構造・場所の決め方）。
//   tests/chrome-extension/realpro-guide-plan.test.js が page-script.js の表（RENT_OPTS・FLOOR_MAP 等）と同じかを確かめる。
(function (root, factory) {
  var api = factory();
  if (typeof module !== "undefined" && module.exports) module.exports = api;
  if (root) root.AxlxRealproGuidePlan = api;
})(typeof self !== "undefined" ? self : typeof window !== "undefined" ? window : null, function () {
  "use strict";

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
  var SLDK_SUBSTITUTE = { "1SLDK":["6","8","9"],"2SLDK":["9","11","12"],"3SLDK":["12","14","15"],"4SLDK":["15","17","18"] };
  var SLDK_UPPER_LDK = { "1SLDK":"2LDK","2SLDK":"3LDK","3SLDK":"4LDK","4SLDK":"5LDK" };
  var FLOOR_RANK = ["1R","ワンルーム","スタジオタイプ","スタジオ","1K","1DK","1LDK","2K","2DK","2LDK","3K","3DK","3LDK","4K","4DK","4LDK","5K","5DK","5LDK","6LDK","メゾネット"];
  var FLOOR_LABEL = {}; Object.keys(FLOOR_MAP).forEach(function (k) { if (!FLOOR_LABEL[FLOOR_MAP[k]]) FLOOR_LABEL[FLOOR_MAP[k]] = k; });
  // route_id → リアプロの路線名（page-script.js ROUTE_LINE_MAP と同じ・駅の小窓で先に押す路線のボタンを光らせる）
  var ROUTE_LINE_MAP = {
    "6701":"大阪市高速軌道御堂筋線","6702":"大阪市高速軌道谷町線","6703":"大阪市高速軌道四つ橋線","6704":"大阪市高速軌道中央線",
    "6705":"大阪市高速軌道千日前線","6706":"大阪市高速軌道堺筋線","6707":"大阪市高速軌道南港ポートタウン線","6699":"大阪市高速軌道今里筋線",
    "6768":"大阪市高速軌道長堀鶴見緑地線","6711":"北大阪急行南北線","6603":"大阪環状線","6767":"JR東西線",
    "6645":"片町線","6604":"桜島線","6650":"おおさか東線","6426":"関西本線","6647":"阪和線","6605":"福知山線","6171":"東海道本線",
    "6541":"近鉄大阪線","6551":"近鉄難波・奈良線","6555":"近鉄南大阪線","6557":"近鉄長野線","6558":"近鉄道明寺線","6563":"近鉄けいはんな線",
    "6651":"京阪電気鉄道京阪線","6658":"京阪電気鉄道中之島線","6652":"京阪電気鉄道交野線",
    "6661":"阪急電鉄京都線","6662":"阪急電鉄千里線","6664":"阪急電鉄神戸線","6668":"阪急電鉄宝塚線","6669":"阪急電鉄箕面線",
    "6671":"阪神電鉄本線","6673":"阪神電鉄阪神なんば線","6681":"南海電鉄南海本線","6686":"南海電鉄高野線","6694":"南海電鉄泉北線",
    "6691":"南海電鉄空港線","6766":"南海電鉄汐見橋線","6684":"南海電鉄多奈川線","6683":"南海電鉄高師浜線",
    "6689":"阪堺電気軌道阪堺線","6690":"阪堺電気軌道上町線","6709":"大阪モノレール本線","6772":"大阪モノレール彩都線",
    "6676":"能勢電鉄","6713":"水間鉄道水間線","6648":"関西空港線",
  };
  var STRUCTURE_LABEL = { "1":"SRC造","2":"RC造","3":"鉄骨造","4":"重量鉄骨造","5":"軽量鉄骨造","6":"木造","7":"木造一部RC造" };

  function nearestUp(opts, val) {
    for (var i = 0; i < opts.length; i++) if (opts[i] !== -1 && opts[i] >= val) return String(opts[i]);
    return String(opts[opts.length - 1]);
  }
  function nearestDown(opts, val) {
    var best = "-1";
    for (var i = 0; i < opts.length; i++) if (opts[i] !== -1 && opts[i] <= val) best = String(opts[i]);
    return best;
  }
  function man(yen) { return (Math.round(Number(yen) / 1000) / 10) + "万"; }

  /** 間取りの値（room_layout_id[] の value）。page-script.js fillRealpro の間取りの節と同じ */
  function floorPlanValues(floorPlan, isWide) {
    if (!floorPlan) return [];
    var fpStr = String(floorPlan).replace(/[Ａ-Ｚａ-ｚ０-９]/g, function (ch) { return String.fromCharCode(ch.charCodeAt(0) - 0xFEE0); })
      .toUpperCase().trim().replace(/(\d)L(?!\w)/g, "$1LDK");
    var vals = [];
    var add = function (v) { if (v && vals.indexOf(v) < 0) vals.push(v); };
    var ijou = fpStr.match(/^(.+?)以上$/);
    var range = fpStr.match(/^(.+?)[～〜](.+?)$/);
    if (ijou) {
      // v2.5.82 竹内「1LDK以上…1LDKから2LDKで調べる」: 一つ上の大きさまで（floor-ijou.js・4か所で同じ決まり）
      var FI = (typeof module !== "undefined" && module.exports && typeof require === "function") ? require("./floor-ijou.js") : ((typeof self !== "undefined" ? self : window).AxlxFloorIjou || null);
      var rg = FI ? FI.ijouRange(FLOOR_RANK, ijou[1].trim()) : null;
      var bi = FLOOR_RANK.indexOf(ijou[1].trim());
      if (rg) for (var a = rg[0]; a <= rg[1]; a++) add(FLOOR_MAP[FLOOR_RANK[a]]);
      else if (bi >= 0) for (var a2 = bi; a2 < FLOOR_RANK.length; a2++) add(FLOOR_MAP[FLOOR_RANK[a2]]);
    } else if (range) {
      var from = range[1].trim(), to = range[2].trim();
      if (SLDK_SUBSTITUTE[from]) {
        SLDK_SUBSTITUTE[from].forEach(add);
        var ui = FLOOR_RANK.indexOf(SLDK_UPPER_LDK[from]), ti0 = FLOOR_RANK.indexOf(to);
        if (ui >= 0 && ti0 > ui) for (var b = ui + 1; b <= ti0; b++) add(FLOOR_MAP[FLOOR_RANK[b]]);
      } else {
        var fi = FLOOR_RANK.indexOf(from), ti = FLOOR_RANK.indexOf(to);
        if (fi >= 0 && ti >= 0) {
          if (fi > ti) { var tmp = fi; fi = ti; ti = tmp; }
          for (var c = fi; c <= ti; c++) add(FLOOR_MAP[FLOOR_RANK[c]]);
        }
      }
    } else {
      var keys = Object.keys(FLOOR_MAP).sort(function (x, y) { return y.length - x.length; });
      fpStr.split(/[,、・\/\.\s]+|もしくは|または|もしくわ|あるいは/).map(function (s) { return s.trim(); }).filter(Boolean).forEach(function (t) {
        if (SLDK_SUBSTITUTE[t]) { SLDK_SUBSTITUTE[t].forEach(add); return; }
        if (FLOOR_MAP[t]) { add(FLOOR_MAP[t]); return; }
        for (var k = 0; k < keys.length; k++) if (t.indexOf(keys[k]) >= 0) { add(FLOOR_MAP[keys[k]]); return; }
      });
    }
    if (isWide) {
      FLOOR_RANK.forEach(function (rank) {
        var v = FLOOR_MAP[rank];
        if (v && vals.indexOf(v) >= 0 && /LDK$/.test(rank)) add(FLOOR_MAP[rank.replace("LDK", "DK")]);
      });
    }
    return vals;
  }

  /** リアプロの「間取」の並び（実画面・左から右・上の段から下の段） */
  var LAYOUT_GRID = ["ワンルーム", "スタジオタイプ", "1K", "1DK", "1LDK", "2K", "2DK", "2LDK", "3K", "3DK", "3LDK", "4K", "4DK", "4LDK", "5K", "5DK", "5LDK", "6LDK～", "6LDK~", "メゾネット"];
  /** 横並びの欄の手順を画面の並び（左から右・上の段から）に並べ替える。並びに無い物は元の順で後ろ */
  function gridOrder(vals, labelOf, grid) {
    var rank = function (v) { var i = grid.indexOf(String(labelOf(v))); return i < 0 ? grid.length : i; };
    return vals.map(function (v, k) { return { v: v, k: k }; })
      .sort(function (a, b) { return rank(a.v) - rank(b.v) || a.k - b.k; })
      .map(function (x) { return x.v; });
  }

  /** 場所の決め方（page-script.js decideLocationMode と同じ）: station / route / area / none */
  function locationMode(c) {
    var st = c.station_names && c.station_names.length > 0, rt = c.route_ids && c.route_ids.length > 0;
    var ar = (c.city_codes && c.city_codes.length > 0) || !!c.detail_ward;
    if (c.area_mode === "ward") return ar ? "area" : "none";
    if (c.area_mode === "station") return st ? "station" : rt ? "route" : "none";
    return st ? "station" : rt ? "route" : ar ? "area" : "none";
  }

  /**
   * 手順表。1つの手順＝{ id, kind, label（スタッフに出す文）, ... }。
   *   kind: "reset"（リセットを押す）／"select"（選択欄 name を value に）／"text"（文字の欄 name を value に）
   *         ／"check"（チェック欄 name の value に印・want=false は外す）／"check_text"（文字 text のラベルのチェック）
   *         ／"pick_station"（駅の名前 names に印）／"pick_city"（区の code に印）／"search"（検索を押す）
   * 入れる値が無い欄は手順にしない（リセットで空に戻る＝page-script の _doReset と同じ前提）
   */
  function buildPlan(cond, opts) {
    var c = cond || {};
    var o = opts || {};
    var steps = [];
    var push = function (s) { s.id = s.id || (s.kind + ":" + (s.name || s.text || "") + ":" + (s.value != null ? s.value : "")); steps.push(s); };
    // 2026-10-01 竹内「リセット今回はしなくて大丈夫だったので、リセットは次のお客さんから」:
    //   前に案内したお客様がいて今回と違う時（前の条件が欄に残っている時）だけ（opts.withReset）
    if (o.withReset) push({ kind: "reset", label: "前のお客様の条件を消すため「リセット」を押してください" });
    // 2026-10-01 竹内「リアプロも ITANDI も所在地のところから上から順に開かせていった方が分かりやすい」
    //   「とにかく押しやすいように上から下で・横並びのところは左から右」:
    //   手順はリアプロの左の欄の上から下の並び（所在地／沿線・駅 → 駅からの移動手段 → 更新日 → 賃料 → 管理費・共益費含む → 敷金・礼金なし
    //   → 面積 → 築年数 → 間取（左から右・上の段から） → 構造 → 絞り込み条件（ペット相談）→ 検索）。入れる値は自動入力と同じ（並びだけ変えた）
    var lm = locationMode(c);
    var lines = (c.route_ids || []).map(function (r) { return ROUTE_LINE_MAP[String(r)]; }).filter(Boolean);
    if (lm === "area" && c.city_codes && c.city_codes.length) push({ kind: "pick_city", codes: c.city_codes.map(String).slice(0, 40), label: "「所在地絞り込み」から区を選んでください（光っている区にチェック）" });
    else if (lm === "station") push({ kind: "pick_station", names: c.station_names.slice(0, 40), lines: lines, label: "「沿線・駅絞り込み」から駅を選んでください（光っている駅にチェック）" });
    else if (lm === "route") push({ kind: "pick_route", lines: lines, label: "「沿線・駅絞り込み」から路線を選んでください" });
    if (c.walk_minutes) {
      push({ kind: "select", name: "transportation_id", value: "1", hint: "徒歩", label: "駅からの移動手段を「徒歩」に" });
      push({ kind: "text", name: "required_time", value: String(c.walk_minutes), hint: c.walk_minutes + "分", label: "徒歩の分数に「" + c.walk_minutes + "」と入力" });
    }
    // v2.5.82 hint＝光の右に出す値（竹内「光っているだけじゃわからない部分はアナウンスを入れる」）。更新日はお客様・サイトごとの値（popup の欄＝前回からの日数・手の指定）
    if (c.rp_update_days) push({ kind: "select", name: "update_date", value: String(c.rp_update_days), hint: c.rp_update_days + "日以内", label: "更新日を「" + c.rp_update_days + "日以内」に" });
    if (c.rent_min) push({ kind: "select", name: "rental_cost1", value: nearestDown(RENT_OPTS, c.rent_min), hint: man(nearestDown(RENT_OPTS, c.rent_min)) + "〜", label: "賃料の下限を「" + man(nearestDown(RENT_OPTS, c.rent_min)) + "」に" });
    if (c.rent_max) push({ kind: "select", name: "rental_cost2", value: nearestUp(RENT_OPTS, c.rent_max), hint: "〜" + man(nearestUp(RENT_OPTS, c.rent_max)), label: "賃料の上限を「" + man(nearestUp(RENT_OPTS, c.rent_max)) + "」に" });
    push({ kind: "check", name: "include_common_fee", value: null, want: true, label: "「管理費・共益費込み」にチェック" });
    if (c.shikirei_free) push({ kind: "check_text", text: "敷金・礼金なし", want: true, label: "「敷金・礼金なし」にチェック" });
    if (c.area_min) push({ kind: "select", name: "square_meter_l", value: nearestDown(AREA_OPTS, c.area_min), hint: nearestDown(AREA_OPTS, c.area_min) + "㎡〜", label: "面積の下限を「" + nearestDown(AREA_OPTS, c.area_min) + "㎡」に" });
    if (c.area_max) push({ kind: "select", name: "square_meter_h", value: nearestUp(AREA_OPTS, c.area_max), hint: "〜" + nearestUp(AREA_OPTS, c.area_max) + "㎡", label: "面積の上限を「" + nearestUp(AREA_OPTS, c.area_max) + "㎡」に" });
    if (c.building_age) push({ kind: "select", name: "structured_date", value: nearestUp(AGE_OPTS, c.building_age), hint: nearestUp(AGE_OPTS, c.building_age) + "年以内", label: "築年数を「" + nearestUp(AGE_OPTS, c.building_age) + "年以内」に" });
    gridOrder(floorPlanValues(c.floor_plan, !!c.is_wide), function (v) { return FLOOR_LABEL[v] || v; }, LAYOUT_GRID).forEach(function (v) {
      push({ kind: "check", name: "room_layout_id[]", value: v, want: true, label: "間取り「" + (FLOOR_LABEL[v] || v) + "」にチェック" });
    });
    (c.structure_types || []).map(function (s) { return STRUCTURE_MAP[s]; }).filter(Boolean).forEach(function (v) {
      push({ kind: "check", name: "structured_type[]", value: v, want: true, label: "構造「" + (STRUCTURE_LABEL[v] || v) + "」にチェック" });
    });
    if (c.pet_ok) push({ kind: "check", name: "eq_rm[]", value: "113", want: true, label: "「ペット相談」にチェック" });
    push({ kind: "search", label: "最後に「検索」を押してください" });
    return { steps: steps, location: lm };
  }

  /**
   * 駅の手順の次の動き（2026-10-02 v2.5.71 竹内「駅選択したつぎが光らない」）。
   *   旧: 光る駅を全部選ぶと「決定・OK・閉じる」を光らせて手で「済み」を待った → 実画面のボタンは「確定してリストへ」「×とじる」で
   *   どれにも当たらず何も光らず、小窓を閉じても手順が「済み」にならず、賃料から先がずっと光らなかった。
   *   x: { visibleUnchecked（見えている・まだの光る駅の数）, visibleTargets（見えている光る駅の数）, anyChecked（光る駅のどれかに印・隠れていても）,
   *        modalOpen（駅の小窓が開いている＝「確定してリストへ」「駅リセット」「設定へ戻る」が見える）, lineBtns（見えている路線のボタンの数） }
   *   返す: "stations"（光っている駅を押す）／"confirm"（「確定してリストへ」を押す）／"lines"（路線を押す）／"done"（済み）／"open"（小窓を開く）
   *   スタッフが光る駅の一部だけ選んだ時も、1駅でも印があって小窓を閉じれば済み（選ぶのはスタッフ）。
   */
  function stationStepAction(x) {
    if (x.visibleUnchecked > 0) return "stations";
    if (x.modalOpen) return x.anyChecked ? "confirm" : (x.lineBtns > 0 ? "lines" : "confirm");
    if (x.anyChecked) return "done";
    return x.lineBtns > 0 ? "lines" : "open";
  }
  /** 駅・路線の小窓を閉じるボタンの文字（押したら駅の手順は済み・1駅でも印がある時） */
  var STATION_MODAL_DONE_TEXTS = ["確定してリストへ", "×とじる", "とじる", "閉じる", "決定", "この条件で絞り込む", "検索"];
  var STATION_MODAL_OPEN_TEXTS = ["確定してリストへ", "駅リセット", "設定へ戻る"];

  /**
   * 一覧の画面で「誰の検索結果か」（2026-10-02 v2.5.71 竹内「印刷用pdfも光らせる」）。
   *   実画面: 検索の後の一覧で案内の枠が「拡張でお客様を選ぶと…」＝案内のお客様が無く、印刷用PDF の光（v2.5.69）が出なかった
   *   （案内の記録は storage.session＝拡張の読み直し・ブラウザの再起動で消える／駅の手順が止まり小窓の「検索」で一覧へ進んだ時も results にならない）。
   *   → お客様の元は1つ: 拡張が選んでいる今のお客様（storage.local の current_customer_id＝上のバー・一括DL・下見・popup と同じ）。
   *   x: { rows（一覧の行の数）, hasSession, stage（"form"|"results"|null）, sessionCid, currentCid }
   *   返す: "none"（一覧ではない・お客様が分からない）／"adopt"（今のお客様で一覧の案内を作る）／"switch"（今のお客様に合わせ直す）／"keep"
   */
  function resultsCustomerAction(x) {
    if (!x.rows) return "none";
    var cur = x.currentCid ? String(x.currentCid) : "";
    if (!x.hasSession) return cur ? "adopt" : "none";
    if (cur && String(x.sessionCid || "") !== cur && x.stage === "results") return "switch";
    if (cur && !x.sessionCid) return "switch";
    return "keep";
  }

  return {
    resultsCustomerAction: resultsCustomerAction,
    stationStepAction: stationStepAction, STATION_MODAL_DONE_TEXTS: STATION_MODAL_DONE_TEXTS, STATION_MODAL_OPEN_TEXTS: STATION_MODAL_OPEN_TEXTS,
    buildPlan: buildPlan, floorPlanValues: floorPlanValues, locationMode: locationMode, nearestUp: nearestUp, nearestDown: nearestDown,
    ROUTE_LINE_MAP: ROUTE_LINE_MAP, RENT_OPTS: RENT_OPTS, AGE_OPTS: AGE_OPTS, AREA_OPTS: AREA_OPTS, FLOOR_MAP: FLOOR_MAP, STRUCTURE_MAP: STRUCTURE_MAP,
    SLDK_SUBSTITUTE: SLDK_SUBSTITUTE, FLOOR_LABEL: FLOOR_LABEL,
  };
});
