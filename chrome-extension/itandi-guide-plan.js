// chrome-extension/itandi-guide-plan.js（self.AxlxItandiGuidePlan・純関数・chrome.* も DOM も使わない）
// ITANDI の「案内モード」の手順表: お客様の条件から「どの欄に何を入れるか」を1つずつ並べる。
//
// 2026-10-01 竹内「ITANDIも画面表示光らせるようにする。検索の画面の入力は手動でそれ以外は今まで通りに、画像もそのままチェックして売上番長に送って解析させる流れ」:
//   拡張は値を入れない・押さない。この手順表を itandi-guide.js が上から見て、まだ終わっていない最初の欄を光らせ、
//   スタッフが入れ終わったら次へ進む。検索を押すのも常にスタッフ。検索の後（一覧・チェック・売上番長に送る）は今まで通り。
//
// 値の決め方は itandi-page-script.js の自動入力（fill → _afterReset → fillRemainingFields）と同じ:
//   家賃は万円・5文字以内（itandi-form-guard.js rentText）／面積・駅徒歩・築年数はそのまま／間取りの広げ方（以上・〜・SLDK・広げては LDK→DK も）／
//   構造（id → ラベルの文字）／ペット・バストイレ別・敷金礼金なし／場所（area_mode の指定・路線名の付け替え・所在地が先）／募集条件更新の日数。
//   広げて検索の家賃の上乗せ・築年数＋5年・隣の駅は popup が条件に入れてから渡す（ここは受け取った条件をそのまま使う＝自動入力と同じ）。
//   tests/chrome-extension/itandi-guide.test.js が itandi-page-script.js の表と同じか・自動入力と同じ欄を選ぶかを確かめる。
(function (root, factory) {
  var api = factory();
  if (typeof module !== "undefined" && module.exports) module.exports = api;
  if (root) root.AxlxItandiGuidePlan = api;
})(typeof self !== "undefined" ? self : typeof window !== "undefined" ? window : null, function () {
  "use strict";

  // ── itandi-page-script.js と同じ表（変えたら両方を直す・テストが比べる）──
  var STRUCTURE_MAP = {
    "木造": "wooden", "木造一部RC造": "wooden",
    "鉄骨造": "steel", "S造": "steel", "重量鉄骨造": "steel",
    "軽量鉄骨造": "lightweight_steel",
    "鉄筋コンクリート造": "rc", "RC": "rc", "RC造": "rc",
    "鉄骨鉄筋コンクリート造": "src", "SRC": "src", "SRC造": "src",
    "ブロック": "block",
    "鉄筋ブロック": "reinforcing_block",
    "PC": "pc", "PC造": "pc",
    "HPC": "hpc", "HPC造": "hpc",
    "ALC": "alc", "ALC造": "alc",
    "CFT": "cft", "CFT造": "cft",
  };
  var STRUCTURE_LABEL_MAP = {
    "鉄骨鉄筋コンクリート造": "SRC",
    "鉄筋コンクリート造": "RC",
    "鉄骨造": "鉄骨造",
    "軽量鉄骨造": "軽量鉄骨造",
    "木造": "木造",
    "ブロック": "ブロック",
    "鉄筋ブロック": "鉄筋ブロック",
    "PC": "PC", "PC造": "PC",
    "HPC": "HPC", "HPC造": "HPC",
    "ALC": "ALC", "ALC造": "ALC",
    "CFT": "CFT", "CFT造": "CFT",
    "S造": "鉄骨造", "重量鉄骨造": "鉄骨造",
    "SRC": "SRC", "SRC造": "SRC",
    "RC": "RC", "RC造": "RC",
  };
  var VALID_LAYOUTS = ["1R","1K","1DK","1LDK","2K","2DK","2LDK","3K","3DK","3LDK","4K","4DK","4LDK","5K_OVER"];
  var FLOOR_RANK_IT = ["1R","1K","1DK","1LDK","2K","2DK","2LDK","3K","3DK","3LDK","4K","4DK","4LDK","5K_OVER"];
  var FLOOR_TEXT_IT = {
    "1R":"1R","ワンルーム":"1R","1K":"1K","1DK":"1DK","1LDK":"1LDK",
    "2K":"2K","2DK":"2DK","2LDK":"2LDK",
    "3K":"3K","3DK":"3DK","3LDK":"3LDK",
    "4K":"4K","4DK":"4DK","4LDK":"4LDK",
    "5K以上":"5K_OVER","5K":"5K_OVER","5K_OVER":"5K_OVER"
  };
  var SLDK_SUBSTITUTE_IT = {
    "1SLDK":["1LDK","2DK","2LDK"],
    "2SLDK":["2LDK","3DK","3LDK"],
    "3SLDK":["3LDK","4DK","4LDK"]
  };
  var SLDK_UPPER_IT = {
    "1SLDK":"2LDK","2SLDK":"3LDK","3SLDK":"4LDK"
  };
  var ITANDI_STATION_ALIAS_MAP = {
    "難波":       ["難波", "なんば"],
    "なんば":     ["なんば", "難波"],
    "大阪難波":   ["大阪難波", "難波", "なんば"],
    "天王寺":     ["天王寺", "大阪阿部野橋"],
    "大阪阿部野橋": ["大阪阿部野橋", "天王寺"],
    "北浜":       ["北浜", "大阪北浜"],
    "大阪北浜":   ["大阪北浜", "北浜"],
  };
  // ペット相談・バストイレ別（itandi-page-script.js fillRemainingFields の id とラベル）
  var PET_ID = "22010", BATH_ID = "11010";
  var BATH_RE = /バス.*トイレ別|トイレ別|バストイレ別/i;
  // 敷金・礼金なしのラベルの文字（自動入力が探す物と同じ）
  var SHIKIREI_TEXTS = ["敷金・礼金なし", "敷金礼金なし", "敷礼なし"];
  /** 2026-10-01 竹内「横並びのところは左から右」: ITANDI の間取り・構造の並び（実画面・左から右・上の段から下の段） */
  var LAYOUT_GRID_IT = ["1R", "1K", "1DK", "1LDK", "2K", "2DK", "2LDK", "3K", "3DK", "3LDK", "4K", "4DK", "4LDK", "5K", "5DK", "5LDK"];
  var STRUCTURE_GRID_IT = ["木造", "ブロック", "鉄筋ブロック", "鉄骨造", "軽量鉄骨造", "RC", "SRC", "PC", "HPC", "ALC", "CFT"];
  function gridOrder(vals, labelOf, grid) {
    var rank = function (v) { var i = grid.indexOf(String(labelOf(v))); return i < 0 ? grid.length : i; };
    return vals.map(function (v, k) { return { v: v, k: k }; })
      .sort(function (a, b) { return rank(a.v) - rank(b.v) || a.k - b.k; })
      .map(function (x) { return x.v; });
  }
  /** 2026-10-01 実画面: 賃料のすぐ下に「敷金なし」「礼金なし」が別々にある */
  var SHIKIREI_SPLIT = ["敷金なし", "礼金なし"];

  function getStationAliases(name) { return ITANDI_STATION_ALIAS_MAP[name] || [name]; }
  function layoutLabel(id) { return id === "5K_OVER" ? "5K以上" : id; }

  function G() { return typeof self !== "undefined" ? self : typeof globalThis !== "undefined" ? globalThis : {}; }
  function FG() {
    var g = G().AxlxItandiFormGuard;
    if (!g && typeof require === "function") { try { g = require("./itandi-form-guard.js"); } catch (_) {} }
    return g || null;
  }
  function UD() {
    var u = G().AxlxItandiUpdateDays;
    if (!u && typeof require === "function") { try { u = require("./itandi-update-days.js"); } catch (_) {} }
    return u || null;
  }

  /** 家賃の欄に打つ文字（itandi-page-script.js の STEP 1 と同じ: 円→万円・5文字以内） */
  function rentValue(v, dir) {
    if (!v) return null;
    var val = v > 1000 ? v / 10000 : v;
    var F = FG();
    if (F) { var t = F.rentText(v, dir); if (t) val = t; }
    return String(val);
  }

  /** 間取りの id（input[name="room_layout:in"] の id）。itandi-page-script.js fillRemainingFields の間取りの節と同じ順・同じ広げ方 */
  function layoutIds(floorPlan, isWide) {
    var ids = [];
    var add = function (id) { if (id && ids.indexOf(id) < 0) ids.push(id); };
    if (floorPlan) {
      var fpStr = String(floorPlan).trim().replace(/(\d)L(?!\w)/g, "$1LDK");
      var ijouMatch = fpStr.match(/^(.+?)以上$/);
      var rangeMatch = fpStr.match(/^(.+?)[～〜](.+?)$/);
      if (ijouMatch) {
        var baseKey = FLOOR_TEXT_IT[ijouMatch[1].trim()] || ijouMatch[1].trim();
        var baseIdx = FLOOR_RANK_IT.indexOf(baseKey);
        // v2.5.82 竹内「1LDK以上…1LDKから2LDKで調べる」: 一つ上の大きさまで（floor-ijou.js・4か所で同じ決まり）
        var FI = (typeof module !== "undefined" && module.exports && typeof require === "function") ? require("./floor-ijou.js") : ((typeof self !== "undefined" ? self : window).AxlxFloorIjou || null);
        var rg = FI ? FI.ijouRange(FLOOR_RANK_IT, ijouMatch[1].trim(), function (k) { return FLOOR_TEXT_IT[k] || null; }) : null;
        if (rg) for (var a = rg[0]; a <= rg[1]; a++) add(FLOOR_RANK_IT[a]);
        else if (baseIdx >= 0) for (var a2 = baseIdx; a2 < FLOOR_RANK_IT.length; a2++) add(FLOOR_RANK_IT[a2]);
      } else if (rangeMatch) {
        var fromRaw = rangeMatch[1].trim(), toRaw = rangeMatch[2].trim();
        if (SLDK_SUBSTITUTE_IT[fromRaw]) {
          SLDK_SUBSTITUTE_IT[fromRaw].forEach(add);
          var upperIdx = FLOOR_RANK_IT.indexOf(SLDK_UPPER_IT[fromRaw]);
          var toIdx0 = FLOOR_RANK_IT.indexOf(FLOOR_TEXT_IT[toRaw] || toRaw);
          if (upperIdx >= 0 && toIdx0 > upperIdx) for (var b = upperIdx + 1; b <= toIdx0; b++) add(FLOOR_RANK_IT[b]);
        } else {
          var fromIdx = FLOOR_RANK_IT.indexOf(FLOOR_TEXT_IT[fromRaw] || fromRaw);
          var toIdx = FLOOR_RANK_IT.indexOf(FLOOR_TEXT_IT[toRaw] || toRaw);
          if (fromIdx >= 0 && toIdx >= 0) {
            if (fromIdx > toIdx) { var tmp = fromIdx; fromIdx = toIdx; toIdx = tmp; }
            for (var c = fromIdx; c <= toIdx; c++) add(FLOOR_RANK_IT[c]);
          }
        }
      } else {
        var keys = Object.keys(FLOOR_TEXT_IT).sort(function (x, y) { return y.length - x.length; });
        fpStr.split(/[・,、\/\.\s]+|もしくは|または|もしくわ|あるいは/).forEach(function (plan) {
          plan = plan.trim();
          if (SLDK_SUBSTITUTE_IT[plan]) { SLDK_SUBSTITUTE_IT[plan].forEach(add); return; }
          var id = FLOOR_TEXT_IT[plan] || null;
          if (!id) for (var k = 0; k < keys.length; k++) if (plan.indexOf(keys[k]) >= 0) { id = FLOOR_TEXT_IT[keys[k]]; break; }
          if (id && VALID_LAYOUTS.indexOf(id) !== -1) add(id);
        });
      }
    }
    // 広げて検索：LDK を選んだ時は同じ部屋数の DK も（自動入力の is_wide の節と同じ・1〜4LDK）
    if (isWide) {
      ["1LDK", "2LDK", "3LDK", "4LDK"].forEach(function (ldk) { if (ids.indexOf(ldk) >= 0) add(ldk.replace("LDK", "DK")); });
    }
    return ids;
  }

  /**
   * 場所の決め方（itandi-page-script.js _afterReset と同じ）:
   *   area_mode=ward → 路線・駅を捨てる／station → 所在地を捨てる／駅の欄に混ざった「〜線」は路線へ／所在地があれば所在地が先
   *   返り値: { mode: "area"|"station"|"none", wards, townMap, lines, stations, selectAll, batchCity }
   */
  function locationOf(cond) {
    var c = cond || {};
    var lines = (c.itandi_lines || []).slice();
    var stations = c.station_names ? c.station_names.slice() : null;
    var wardName = c.ward_name, wardNames = c.ward_names, townMap = c.ward_town_map || null;
    if (c.area_mode === "ward") { lines = []; stations = null; }
    else if (c.area_mode === "station") { wardName = null; wardNames = null; townMap = null; }
    if (stations && stations.length) {
      var remaining = [];
      stations.forEach(function (tok) {
        if (tok.length >= 3 && /線$/.test(tok)) { if (lines.indexOf(tok) === -1) lines.push(tok); }
        else remaining.push(tok);
      });
      stations = remaining;
    }
    var wards = wardNames && wardNames.length ? wardNames.slice() : (wardName ? [wardName] : []);
    var st = (stations || (c.station_name ? [c.station_name] : [])).map(function (s) { return String(s).replace(/駅$/, "").trim(); }).filter(Boolean);
    // 市の全域（「大阪市内」・区の無い「〇〇市」1つだけ）＝自動入力は1回の小窓でその市の区を全部押す（batchCity）
    var batchCity = null;
    if (wards.length === 1) {
      var mIn = String(wards[0]).match(/^([^\s　]+?[市])(内)$/);
      if (mIn) batchCity = mIn[1];
      else if (/^[^\s　]+[市]$/.test(wards[0]) && !/[区町村]/.test(wards[0])) batchCity = wards[0];
    }
    if (wards.length) return { mode: "area", wards: wards, townMap: townMap, lines: [], stations: [], selectAll: false, batchCity: batchCity, townArea: c.town_area || null };
    if (lines.length) return { mode: "station", wards: [], townMap: null, lines: lines, stations: st, selectAll: !!c.select_all_line_stations, batchCity: null };
    return { mode: "none", wards: [], townMap: null, lines: [], stations: [], selectAll: false, batchCity: null };
  }

  /** 区の短い名前（「大阪市城東区」→「城東区」・itandi-page-script.js getShortName と同じ） */
  function wardShortName(w) {
    var s = String(w).replace(/^.+?([^\s　市区郡]+[区町村])$/, "$1");
    return s === w ? null : s;
  }

  /**
   * 手順表。1つの手順＝{ id, kind, label（スタッフに出す文）, ... }。
   *   kind: "clear"（前のお客様の条件が残っていれば外す・画面を読んで決める）／"text"（打つ欄 name を value に・数で比べる）
   *         ／"check"（チェック欄 name・id に印・無ければラベルの文字 labelText）／"check_text"（文字 texts のラベルのチェック）
   *         ／"update_days"（募集条件更新の欄を days に）／"pick_area"（所在地の小窓で区を選ぶ）／"pick_lines"（路線・駅の小窓で路線と駅を選ぶ）
   *         ／"search"（検索を押す）
   *   plan.want: 「このお客様で入れる物」（clear の手順が前のお客様の残りと見分けるため）
   * 入れる値が無い欄は手順にしない（残っていれば clear の手順が外す＝自動入力の _itResetForm と同じ前提）
   */
  function buildPlan(cond, opts) {
    var c = cond || {};
    var steps = [];
    var want = { texts: {}, checks: {}, labels: [], updateDays: null, location: null, shikirei: !!c.shikirei_free };
    var push = function (s) { s.id = s.id || (s.kind + ":" + (s.name || "") + ":" + (s.fid || s.labelText || (s.texts || []).join("/") || "") + ":" + (s.value != null ? s.value : "")); steps.push(s); };
    var wantCheck = function (name, id, labelText) { (want.checks[name] = want.checks[name] || []).push({ id: id || null, labelText: labelText || null }); };

    push({ kind: "clear", label: "前のお客様の条件が残っています。光っている所を外してください（×・チェックを外す・欄を空に）" });

    // 2026-10-01 竹内「リアプロも ITANDI も所在地のところから上から順に開かせていった方が分かりやすい」:
    //   手順は ITANDI の検索画面の上から下の並び（所在地／路線・駅 → 駅徒歩 → 賃料・管理費込み・敷金なし・礼金なし → 間取り → 専有面積 → 築年数 → 構造
    //   → 募集条件更新 → バス・トイレ別 → ペット相談 → 検索）。入れる値は自動入力と同じ（並びだけ変えた）
    var loc = locationOf(c);
    want.location = loc;
    if (loc.mode === "area") {
      var wl = loc.batchCity ? loc.batchCity + "の全区" : loc.wards.map(function (w) {
        var towns = loc.townMap && loc.townMap[w] && loc.townMap[w].length ? loc.townMap[w] : null;
        return w + (towns ? "（" + towns.join("・") + "）" : "");
      }).join("・");
      push({ kind: "pick_area", wards: loc.wards, townMap: loc.townMap, batchCity: loc.batchCity, townArea: loc.townArea || null,
        // 2026-10-02 v2.5.70 竹内「おしたらこのように近畿と大阪はセットされている状態。ここから押す形」: 近畿・大阪府は小窓を開いた時に選ばれている＝手順の文に書かない
        //   （選ばれていない時だけ、その場の光と吹き出しで「近畿」「大阪府」を出す＝itandi-guide.js evalArea）
        label: "「所在地で絞り込み」で " + wl + " を選んで「確定」（区ごとに1回）" });
    } else if (loc.mode === "station") {
      push({ kind: "pick_lines", lines: loc.lines, stations: loc.stations, selectAll: loc.selectAll,
        label: "「路線・駅で絞り込み」で 路線 " + loc.lines.join("・") + (loc.selectAll ? " の駅を全部" : loc.stations.length ? " → 駅 " + loc.stations.slice(0, 12).join("・") + (loc.stations.length > 12 ? " ほか" + (loc.stations.length - 12) + "駅" : "") : "") + " を選んで「確定」" });
    }

    if (c.walk_minutes) { want.texts["station_walk_minutes:lteq"] = String(c.walk_minutes); push({ kind: "text", name: "station_walk_minutes:lteq", value: String(c.walk_minutes), hint: c.walk_minutes + "分", label: "駅徒歩に「" + c.walk_minutes + "」分以内と入力" }); }

    var rMin = rentValue(c.rent_min, "min");
    if (rMin) { want.texts["rent:gteq"] = rMin; push({ kind: "text", name: "rent:gteq", value: rMin, hint: rMin + "万〜", label: "賃料の下限に「" + rMin + "」と入力（万円）" }); }
    var rMax = rentValue(c.rent_max, "max");
    if (rMax) { want.texts["rent:lteq"] = rMax; push({ kind: "text", name: "rent:lteq", value: rMax, hint: "〜" + rMax + "万", label: "賃料の上限に「" + rMax + "」と入力（万円）" }); }
    wantCheck("totalRentCheck", null, null);
    push({ kind: "check", name: "totalRentCheck", fid: null, labelText: null, label: "「管理費・共益費込み」にチェック" });
    if (c.shikirei_free) {
      // 実画面は「敷金なし」「礼金なし」が別々のチェック（賃料のすぐ下）。旧の「敷金・礼金なし」の1つの文字は無いので飛ばされていた
      want.labels = SHIKIREI_TEXTS.concat(SHIKIREI_SPLIT);
      push({ kind: "check_text", texts: SHIKIREI_TEXTS.concat(["敷金なし"]), label: "「敷金なし」にチェック" });
      push({ kind: "check_text", texts: ["礼金なし"], label: "「礼金なし」にチェック" });
    }

    gridOrder(layoutIds(c.floor_plan, !!c.is_wide), layoutLabel, LAYOUT_GRID_IT).forEach(function (id) {
      wantCheck("room_layout:in", id, layoutLabel(id));
      push({ kind: "check", name: "room_layout:in", fid: id, labelText: layoutLabel(id), exact: true, label: "間取り「" + layoutLabel(id) + "」にチェック" });
    });
    if (c.area_min) { want.texts["floor_area_amount:gteq"] = String(c.area_min); push({ kind: "text", name: "floor_area_amount:gteq", value: String(c.area_min), hint: c.area_min + "㎡〜", label: "専有面積の下限に「" + c.area_min + "」と入力（㎡）" }); }
    if (c.area_max) { want.texts["floor_area_amount:lteq"] = String(c.area_max); push({ kind: "text", name: "floor_area_amount:lteq", value: String(c.area_max), hint: "〜" + c.area_max + "㎡", label: "専有面積の上限に「" + c.area_max + "」と入力（㎡）" }); }
    if (c.building_age) { want.texts["building_age:lteq"] = String(c.building_age); push({ kind: "text", name: "building_age:lteq", value: String(c.building_age), hint: c.building_age + "年以内", label: "築年数に「" + c.building_age + "」年以内と入力" }); }
    var seenSt = {};
    gridOrder((c.structure_types || []).slice(), function (s) { return STRUCTURE_LABEL_MAP[s] || s; }, STRUCTURE_GRID_IT).forEach(function (s) {
      var v = STRUCTURE_MAP[s] || null;
      var lt = STRUCTURE_LABEL_MAP[s] || s;
      var key = v || "label:" + lt;
      if (seenSt[key]) return;
      seenSt[key] = true;
      wantCheck("structure_type:in", v, lt);
      push({ kind: "check", name: "structure_type:in", fid: v, labelText: lt, alt: lt !== s ? s : null, label: "構造「" + lt + "」にチェック" });
    });

    var U = UD();
    var days = U ? U.normDays(c.rp_update_days) : null;
    want.updateDays = days;
    if (days !== null) push({ kind: "update_days", value: days, hint: days + "日以内", label: "「募集条件更新」に「" + days + "」日以内を入れる" + (days > 9 ? "（一覧に無い日数なら空のまま「この手順は済み」）" : "") });

    if (c.preferences && BATH_RE.test(c.preferences)) {
      wantCheck("option_id:all_in", BATH_ID, "バス・トイレ別");
      push({ kind: "check", name: "option_id:all_in", fid: BATH_ID, labelText: "バス・トイレ別", label: "「バス・トイレ別」にチェック" });
    }
    if (c.pet_ok) {
      wantCheck("option_id:all_in", PET_ID, "ペット相談");
      push({ kind: "check", name: "option_id:all_in", fid: PET_ID, labelText: "ペット相談", exact: true, section: "入居条件（その他）", label: "「ペット相談」にチェック" });
    }
    push({ kind: "search", label: "最後に「検索」を押してください" });
    return { steps: steps, location: loc.mode, want: want };
  }

  /**
   * 2026-10-02 v2.5.68 竹内「西淀川区選択しているのに選択されたことになっていない」（早急）:
   *   確定の後、左の「所在地」に「大阪市西淀川区 ⊗」のチップ（× は別の丸いボタン）・下の要約に「大阪府：大阪市西淀川区」が出ているのに、
   *   チップの行（filterRow）が今の画面の形で読めず、所在地の手順が済みにならなかった。
   *   → 画面の文字（小窓の中・案内の枠と光は除く）から、選ばれた区を読む予備の見分け（純関数）:
   *     ①文字がそのまま区（「大阪市西淀川区」「西淀川区」・全角半角・空白をそろえる）＝チップ
   *     ②「大阪府：大阪市西淀川区」「大阪府:西淀川区、大阪市北区」の形＝下の要約（「：」の後ろを「、・,／」で区切る）
   *   返すのは wards のうち選ばれている物（入れた順）。番地つきの所在地（「大阪市西淀川区歌島1丁目」）は数えない
   */
  function selectedWardsFromTexts(texts, wards) {
    function sq(t) { return String(t == null ? "" : t).normalize("NFKC").replace(/[\s　]+/g, "").replace(/[⊗×✕✖]/g, ""); }
    function short(w) { var s = sq(w).replace(/内$/, ""); var m = s.match(/^.+?[市郡]([^市郡]+[区町村])$/); return m ? m[1] : s; }
    var seen = {};
    (texts || []).forEach(function (t) {
      var s = sq(t);
      if (!s) return;
      var m = s.match(/^(?:大阪府|京都府|兵庫県|奈良県)[：:](.+)$/);
      var parts = m ? m[1].split(/[、,，・\/／]/) : [s];
      parts.forEach(function (p) { if (p) seen[p] = true; });
    });
    return (wards || []).filter(function (w) {
      var full = sq(w).replace(/内$/, ""), sh = short(w);
      return !!(seen[full] || seen[sh]);
    });
  }

  /**
   * 小窓の種類（2026-10-06 v2.5.80 竹内「拡張ツール itandi 駅の部分ひかっていない ちゃんとリアプロ同様に光るようにする」）。
   *   旧: 所在地の小窓かを input[name="regionName"]（都道府県の選び）で見分けていた → 路線・駅の小窓にも同じ都道府県の選び（近畿・大阪府）が
   *   あるので、路線・駅の小窓を「所在地の小窓」と取り違え「所在地の小窓を閉じて…」と出し、路線も駅も光らなかった。
   *   → 小窓の見出し・文の語で見分ける: 「路線・駅選択」「路線を選ばなくても検索可能」→ lines ／「所在地選択」「市区町村」→ area
   */
  function modalKindFromText(text) {
    var t = String(text || "").replace(/[\s　]+/g, "");
    if (/路線・?駅(選択|で絞り込み)|路線を選ばなくても|駅を選択/.test(t)) return "lines";
    if (/所在地(選択|で絞り込み)|市区町村/.test(t)) return "area";
    return null;
  }

  // ── 駅の名前の照らし合わせ（2026-10-06 v2.5.85・リアプロ v2.5.84 と同じ直し方）──
  //   ITANDI の駅の文字はリアプロと別の表（feedback_site_naming_separation）＝読み替えは ITANDI_STATION_ALIAS_MAP だけを使う（リアプロの
  //   realpro-guide-plan.js STATION_NAME_ALIASES は混ぜない）。表に足す時は scripts/audit-guide-station-miss.ts --site=itandi の候補（ITANDI の画面の文字）を見てから。
  //   旧（itandi-guide.js stationLabelHit）: 読み替えの表＋「含む・1字差」だけで、全角/半角・ヶ/ケ・「N丁目」・JR の有無が違うと黙って光らなかった。
  function stationKeyIt(n) {
    var t = String(n == null ? "" : n);
    if (t.normalize) t = t.normalize("NFKC");
    return t.replace(/[\s　]+/g, "")
      .replace(/[（(][^）)]*[）)]/g, "")
      .replace(/駅$/, "")
      .replace(/[ヶヵ]/g, "ケ")
      .replace(/(\d)(?=丁目)/g, function (d) { return "〇一二三四五六七八九".charAt(Number(d)); });
  }
  function stripJrIt(k) { return /^JR./.test(k) ? k.slice(2) : k; }
  /** 画面の駅の文字 lk（key）が名前の key nk に当たるか（同じ・または短い文字の中に名前があって差が1字＝旧の stationLabelHit と同じ緩さ） */
  function keyHit(lk, nk) {
    if (!lk || !nk) return false;
    if (lk === nk) return true;
    return lk.length <= 8 && lk.indexOf(nk) >= 0 && (lk.length - nk.length) <= 1;
  }
  /** 名前 → 照らす key の並び（先頭が本来の名前・後ろが読み替え） */
  function nameKeysIt(name) {
    var base = String(name == null ? "" : name).replace(/駅$/, "");
    var out = [];
    var add = function (x) { var k = stationKeyIt(x); if (k && out.indexOf(k) < 0) out.push(k); };
    getStationAliases(base).forEach(add);
    add(base);
    out.slice().forEach(function (k) { add(stripJrIt(k)); });
    return out;
  }
  /** 画面の駅の文字1つが、光らせる駅の名前のどれかに当たるか（光らせる時に使う） */
  function stationLabelWantedIt(label, names) {
    var lk = stationKeyIt(label), lj = stripJrIt(lk);
    return (names || []).some(function (n) { return nameKeysIt(n).some(function (k) { return keyHit(lk, k) || (lj !== lk && keyHit(lj, k)); }); });
  }
  /**
   * 光らせる駅の名前 names と、この案内の間に小窓で見た駅の文字 labels を照らす。
   *   返す: { missing: [どの文字にも当たらない名前], via: {名前: 本来の名前と違う形で当たった画面の文字} }。labels が空なら missing も空
   */
  function matchStationsIt(names, labels) {
    var ls = (labels || []).map(function (l) { var k = stationKeyIt(l); return { l: String(l), k: k, j: stripJrIt(k) }; }).filter(function (x) { return x.k; });
    var missing = [], via = {};
    if (!ls.length) return { missing: missing, via: via };
    (names || []).forEach(function (n) {
      var keys = nameKeysIt(n), hit = null, exact = false;
      for (var i = 0; i < ls.length && !exact; i++) {
        for (var j = 0; j < keys.length; j++) {
          if (keyHit(ls[i].k, keys[j]) || (ls[i].j !== ls[i].k && keyHit(ls[i].j, keys[j]))) {
            if (j === 0 && ls[i].k === keys[0]) { exact = true; hit = null; break; }
            if (!hit) hit = ls[i].l;
          }
        }
      }
      if (exact) return;
      if (hit) { via[String(n)] = hit; return; }
      if (missing.indexOf(String(n)) < 0) missing.push(String(n));
    });
    return { missing: missing, via: via };
  }
  function missNoteIt(missing) {
    if (!missing || !missing.length) return "";
    return "見つからない駅: " + missing.slice(0, 6).join("・") + (missing.length > 6 ? " 他" + (missing.length - 6) : "");
  }

  return {
    stationKeyIt: stationKeyIt, stationLabelWantedIt: stationLabelWantedIt, matchStationsIt: matchStationsIt, missNoteIt: missNoteIt,
    modalKindFromText: modalKindFromText,
    buildPlan: buildPlan, layoutIds: layoutIds, locationOf: locationOf, rentValue: rentValue, getStationAliases: getStationAliases,
    wardShortName: wardShortName, layoutLabel: layoutLabel, selectedWardsFromTexts: selectedWardsFromTexts,
    STRUCTURE_MAP: STRUCTURE_MAP, STRUCTURE_LABEL_MAP: STRUCTURE_LABEL_MAP, VALID_LAYOUTS: VALID_LAYOUTS, FLOOR_RANK_IT: FLOOR_RANK_IT,
    FLOOR_TEXT_IT: FLOOR_TEXT_IT, SLDK_SUBSTITUTE_IT: SLDK_SUBSTITUTE_IT, SLDK_UPPER_IT: SLDK_UPPER_IT, ITANDI_STATION_ALIAS_MAP: ITANDI_STATION_ALIAS_MAP,
    PET_ID: PET_ID, BATH_ID: BATH_ID, BATH_RE: BATH_RE, SHIKIREI_TEXTS: SHIKIREI_TEXTS,
  };
});
