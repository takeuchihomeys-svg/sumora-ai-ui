// chrome-extension/itandi-form-guard.js（self.AxlxItandiFormGuard・純関数・DOM も chrome.* も使わない）
// ITANDI BB の検索フォームで「検索を押したつもりで押せていない」を防ぐ決まり（v2.5.45）。
//
// 2026-09-30 竹内（拡張のエラー画面）「[batch] error: … itandi auto Error: itandi 検索完了シグナル（fill-done）が245秒以内に届きませんでした」
//   本番の点検（search_audits 12:39〜13:50・extension_snapshots の写真と文字）で分かった事:
//   ① 条件のリセットのボタンの文字が ITANDI で「条件削除」になっていた（旧の探し方は 条件全削除/条件クリア/全クリア/クリア だけ）
//      → 9/26 以降の ITANDI の回は全部 reset_fail。前のお客様の所在地のチップ・路線/駅のチップが積み上がり
//        （13:50 の画面: 所在地 天王寺区・浪速区・城東区・鶴見区＋駅 25駅）、「該当物件数が多すぎます。3,000件以内」で検索のボタンが押せない
//   ② 家賃の上限 84,999 円のお客様で「8.4999」を打ち、ITANDI が「賃料（上限）は5桁以内で入力して下さい」→ 検索のボタンが押せない
//   ③ 押せない（disabled の）ボタンを click() しても例外にならず「押せた」と記録 → fill-done は ok で届き、
//      一覧は前のお客様の結果（49 戸）のまま → itandi-bulk-dl は新しい行を待ち続けて 5分の待ち切れ（batch_timeout）
//   → ①リセットは「条件削除」も探す ②家賃は5文字以内の文字にする ③押す前にボタンと画面の赤い文を見て、押せなければ
//     検索しないで理由付きで返す（background はそのサイトを飛ばして次へ・5分待たない）
(function (root, factory) {
  var api = factory();
  if (typeof module === "object" && module.exports) module.exports = api;
  if (root) root.AxlxItandiFormGuard = api;
})(typeof self !== "undefined" ? self : (typeof globalThis !== "undefined" ? globalThis : this), function () {
  "use strict";

  function nfkc(s) { var t = String(s == null ? "" : s); return t.normalize ? t.normalize("NFKC") : t; }
  function squash(s) { return nfkc(s).replace(/[\s　]+/g, ""); }

  // ── ① 条件のリセットのボタン ──
  // 2026-09-30 の ITANDI の画面: 検索のボタンの左に「条件削除」。旧の文字も残す（戻った時・別の画面）
  var RESET_LABELS = ["条件削除", "条件全削除", "条件クリア", "全クリア", "クリア"];
  function isResetLabel(text) { return RESET_LABELS.indexOf(squash(text)) >= 0; }

  // ── ② 家賃の欄に打つ文字（万円・5文字以内）──
  // v: 円（1000 より大きい）か万円。dir: "max"＝上限（切り下げ＝登録より広げない）／"min"＝下限（切り上げ）
  //   ITANDI は「5桁以内」。8.4999（6文字）は弾かれる → 10 未満は小数3桁（8.499）・100 未満は2桁（10.49）・それ以上は1桁
  //   末尾の 0 と点は落とす（8.500→8.5・7.000→7）。読めない・0 以下は null（呼ぶ側は欄を触らない）
  var MAX_LEN = 5;
  function rentText(v, dir) {
    var n = typeof v === "number" ? v : parseFloat(nfkc(v).replace(/[,，万円\s]/g, ""));
    if (!isFinite(n) || n <= 0) return null;
    var man = n > 1000 ? n / 10000 : n;
    var digits = man < 10 ? 3 : man < 100 ? 2 : man < 1000 ? 1 : 0;
    var s = null;
    for (var d = digits; d >= 0; d--) {
      var f = Math.pow(10, d);
      // 浮動小数の誤差（8.5*1000=8499.999…）で1つずれないように、丸めてから切り下げ／切り上げ
      var x = Math.round(man * f * 1e6) / 1e6;
      var q = dir === "min" ? Math.ceil(x) : Math.floor(x);
      var t = (q / f).toFixed(d);
      if (t.indexOf(".") >= 0) t = t.replace(/0+$/, "").replace(/\.$/, "");
      if (t.length <= MAX_LEN) { s = t; break; }
    }
    return s;
  }

  // ── ③ 検索のボタンが押せるか ──
  // state: { found: ボタンがあるか, disabled: ボタンが押せない（disabled・aria-disabled）, texts: 画面の赤い文・件数の近くの文（配列） }
  // 返り値: null＝押してよい／{ code, ja }＝押さない理由
  var TOO_MANY_RE = /該当物件数が多すぎ|件以内になるように条件/;
  var INVALID_RE = /正しく入力されていない項目|で入力して下さい|で入力してください|桁以内/;
  function searchBlock(state) {
    var st = state || {};
    var texts = (Array.isArray(st.texts) ? st.texts : []).map(function (t) { return nfkc(t).replace(/\s+/g, " ").trim(); }).filter(Boolean);
    var tooMany = texts.filter(function (t) { return TOO_MANY_RE.test(t); })[0];
    var invalid = texts.filter(function (t) { return INVALID_RE.test(t) && !TOO_MANY_RE.test(t); });
    // 一番具体的な赤い文（「賃料（上限）は5桁以内…」）を理由に。無ければ最初の物
    var invalidOne = invalid.filter(function (t) { return /桁以内|で入力して/.test(t); })[0] || invalid[0];
    if (!st.found) return { code: "no_button", ja: "検索のボタンが見つからない" };
    if (invalidOne) return { code: "invalid", ja: "入力の誤りで検索できない（" + invalidOne.slice(0, 60) + "）" };
    if (tooMany) return { code: "too_many", ja: "該当が3,000件を超えて検索できない（前の条件が残っている可能性）" };
    if (st.disabled) return { code: "disabled", ja: "検索のボタンが押せない状態" };
    return null;
  }

  // ── 同じ依頼が2回届いた時（popup の iframe が tabs.sendMessage と underbar の中継の両方で switch-customer を受ける）──
  // prev: { key, at } ／ key: 条件の JSON。同じ key が windowMs 以内なら2回目は動かさない
  var DUP_WINDOW_MS = 8000;
  function isDuplicateFill(prev, key, now, windowMs) {
    if (!prev || !key || prev.key !== key) return false;
    var w = windowMs == null ? DUP_WINDOW_MS : windowMs;
    return typeof prev.at === "number" && now - prev.at >= 0 && now - prev.at < w;
  }
  // 条件の形を比べる鍵（点検の run_id は同じ回なら同じ・無い時もある＝そのまま入れる）
  // v2.5.48: 点検の run_id（_audit_run_id）は鍵に入れない。2回目の依頼は popup が run_id を新しく作る事があり
  //   （1回目が控えを使った後）、run_id の違いだけで「別の依頼」と読んで2本目を動かしていた（9/30 の ITANDI の一括の回すべて）
  function fillKey(cond) {
    try {
      if (cond && typeof cond === "object" && !Array.isArray(cond)) {
        var c = {};
        Object.keys(cond).forEach(function (k) { if (k !== "_audit_run_id") c[k] = cond[k]; });
        return JSON.stringify(c);
      }
      return JSON.stringify(cond == null ? null : cond);
    } catch (e) { return null; }
  }

  // ── fill-done の中継: ページの失敗は検索を押していない＝そのサイトを飛ばす（skip）──
  // page-script は検索を押す前に止まった時だけ skip:true を付ける。skip の時だけ background に error として渡す
  //   （旧: error は pageError に入れて渡さず、background は押していない検索の結果を5分待っていた）
  function relayError(data) {
    var d = data || {};
    if (!d.error) return { error: null, pageError: null };
    return d.skip ? { error: String(d.error), pageError: String(d.error) } : { error: null, pageError: String(d.error) };
  }

  // ── ④ v2.5.46 前のお客様の条件を1つずつ外す（ボタンに頼らない）──
  // 2026-09-30 竹内「（ITANDI に）消去ボタンは無いので、リアプロのように、一度入っているのを全部抜いて、新しいお客さんに切り替わるたびにお客さんの条件入れたら出来る」
  //   本番の画面の文字（extension_snapshots 9/30 12:31〜14:27 の text_head）:
  //     「… 管理会社 所在地 大阪市天王寺区 大阪市浪速区 所在地で絞り込み 路線・駅 東淀川 新大阪 … 谷町六丁目 路線・駅で絞り込み 駅徒歩 …」
  //   ＝選んだ区・駅は「所在地」「路線・駅」の見出しと「〜で絞り込み」のボタンの間にチップで並ぶ（前のお客様の分が積み上がっていた）。
  //   読み戻しの欄（form.filled）: rent:lteq / rent:gteq / floor_area_amount:gteq / floor_area_amount:lteq / station_walk_minutes:lteq /
  //     building_age:lteq / offer_conditions_updated_at:gteq（更新日・itandi-update-days.js が空にする）/ val（並び・条件ではない）
  var FILTER_ROWS = [
    { key: "wards", ja: "所在地", label: "所在地",
      buttons: ["所在地で絞り込み", "所在地で絞り込む", "所在地を絞り込む", "エリアで絞り込む", "エリアを絞り込む", "エリアで絞り込み", "地域で絞り込む", "地域を絞り込む", "地域で絞り込み"] },
    { key: "stations", ja: "路線・駅", label: "路線・駅",
      buttons: ["路線・駅で絞り込み", "路線・駅で絞り込む", "路線・駅を絞り込む", "路線で絞り込む", "路線で絞り込み", "沿線・駅で絞り込む", "沿線・駅で絞り込み", "沿線・駅を絞り込む"] },
  ];
  // 打つ欄（このファイルの page-script が値を入れる name）。空にしてから入れる（旧: お客様に値が無い欄は前の値のまま＝築年数・駅徒歩が残った）
  var CLEAR_TEXT_FIELDS = [
    { name: "rent:lteq", ja: "家賃の上限" },
    { name: "rent:gteq", ja: "家賃の下限" },
    { name: "floor_area_amount:gteq", ja: "専有面積の下限" },
    { name: "floor_area_amount:lteq", ja: "専有面積の上限" },
    { name: "station_walk_minutes:lteq", ja: "駅徒歩" },
    { name: "building_age:lteq", ja: "築年数" },
  ];
  // 外すチェック（name で分かる物）。管理費込み（totalRentCheck）は毎回入れるので外さない（keep）
  var CLEAR_CHECK_NAMES = [
    { name: "room_layout:in", ja: "間取り" },
    { name: "structure_type:in", ja: "構造" },
    { name: "option_id:all_in", ja: "設備・こだわり" },
  ];
  // 外すチェック（name が分からずラベルの文字で分かる物）。画面の文字「敷金なし 礼金なし」
  var CLEAR_CHECK_LABELS = ["敷金なし", "礼金なし", "敷金・礼金なし", "敷金礼金なし"];
  // 空にしない文字の欄: 並び（val）・更新日（募集条件更新の段が空にする／入れる）
  var KEEP_TEXT_RE = /^(val|offer_conditions_updated_at:gteq)$|sort|order/i;
  function keepTextName(name) { return !name || KEEP_TEXT_RE.test(String(name)); }

  // 欄が空か（ITANDI の一覧の欄は空の時「指定なし」を見せることがある）
  function isEmptyValue(v) { var s = squash(v); return s === "" || s === "指定なし"; }

  // チップの文字（行の中の文字の断片から、見出し・ボタン・×を除いた物）
  var CHIP_NOISE = { "×": 1, "✕": 1, "x": 1, "X": 1, "削除": 1, "閉じる": 1, "close": 1, "clear": 1 };
  function chipNames(texts, rowKey) {
    var row = FILTER_ROWS.filter(function (r) { return r.key === rowKey; })[0];
    var out = [];
    (Array.isArray(texts) ? texts : []).forEach(function (t) {
      var s = squash(t);
      if (!s || CHIP_NOISE[s]) return;
      if (row && (s === squash(row.label) || row.buttons.some(function (b) { return squash(b) === s; }))) return;
      // 見出しと他の行の見出しの断片（「駅徒歩」「分以内」等）はチップでない
      //   空の時の案内の文字（出る画面なら）もチップでない＝空を「残っている」と言わない
      if (/^(駅徒歩|分以内|賃料|万円|〜|~|指定なし|未選択|選択なし|選択してください|すべて|全て)$/.test(s)) return;
      if (out.indexOf(s) < 0) out.push(s);
    });
    return out;
  }

  // チップの「外す」部品か（×・削除の aria-label／title・class の delete/remove/close/clear）
  //   o: { tag, text, aria, title, cls }。文字のある部品（区・駅の名前・〜で絞り込み）は外す部品にしない
  var DEL_ATTR_RE = /削除|外す|取り消|閉じる|remove|delete|clear|close|cancel/i;
  var DEL_CLASS_RE = /delete|remove|close|clear|cancel|cross|xmark|times/i;
  function isDeleteControl(o) {
    var x = o || {};
    var text = squash(x.text);
    if (text && !CHIP_NOISE[text]) return false;
    if (CHIP_NOISE[text]) return true;
    if (DEL_ATTR_RE.test(String(x.aria || "")) || DEL_ATTR_RE.test(String(x.title || ""))) return true;
    if (DEL_CLASS_RE.test(String(x.cls || ""))) return true;
    // 文字の無いボタン・アイコン（svg）はチップの中なら外す部品（チップの名前の部品とは別）
    var tag = String(x.tag || "").toLowerCase();
    return tag === "button" || tag === "svg" || x.role === "button";
  }

  // 読み戻し（state）から残っている欄を並べる
  // state: { chips: { wards: [...], stations: [...] }, texts: [{ name, value }], checks: [{ name, label }] }
  // 返り値: [{ field, ja, values }]（空＝全部外れている）
  function leftovers(state) {
    var st = state || {};
    var out = [];
    var chips = st.chips || {};
    FILTER_ROWS.forEach(function (r) {
      var v = Array.isArray(chips[r.key]) ? chips[r.key].filter(Boolean) : [];
      if (v.length) out.push({ field: r.key, ja: r.ja, values: v.slice(0, 30) });
    });
    (Array.isArray(st.texts) ? st.texts : []).forEach(function (t) {
      if (!t || isEmptyValue(t.value) || keepTextName(t.name)) return;
      var def = CLEAR_TEXT_FIELDS.filter(function (d) { return d.name === t.name; })[0];
      out.push({ field: String(t.name), ja: def ? def.ja : "その他の入力（" + String(t.name).slice(0, 30) + "）", values: [String(t.value).slice(0, 20)], other: !def });
    });
    var byCheck = {};
    (Array.isArray(st.checks) ? st.checks : []).forEach(function (c) {
      if (!c) return;
      var def = CLEAR_CHECK_NAMES.filter(function (d) { return d.name === c.name; })[0];
      var key = def ? def.name : "label:" + squash(c.label || c.name);
      if (!byCheck[key]) { byCheck[key] = { field: key, ja: def ? def.ja : "敷金・礼金", values: [] }; out.push(byCheck[key]); }
      byCheck[key].values.push(String(c.label || c.id || c.name || "").slice(0, 20));
    });
    return out;
  }

  // 外す前と後の読み戻しから、点検（filled.reset）に残す形
  //   cleared: 前に値があって外れた欄 ／ leftover: 外した後も残っている欄（どちらも欄の名前）
  function resetSummary(before, after) {
    var b = leftovers(before), all = leftovers(after);
    var aKeys = all.map(function (x) { return x.field; });
    // 名前の分からない欄（物件名・管理会社など・このファイルが入れない欄）は空にしてみるが、残っても失敗にしない（leftover_other に残す）。
    //   画面の作りが変わって空にできない欄が1つ出ただけで、全部のお客様の ITANDI を毎回飛ばさないため
    var a = all.filter(function (x) { return !x.other; });
    var other = all.filter(function (x) { return x.other; }).map(function (x) { return x.field; });
    return {
      cleared: b.filter(function (x) { return aKeys.indexOf(x.field) < 0; }).map(function (x) { return x.field; }),
      leftover: a.map(function (x) { return x.field; }),
      leftover_other: other,
      leftover_ja: a.map(function (x) { return x.ja + "（" + x.values.slice(0, 4).join("・") + (x.values.length > 4 ? " ほか" + (x.values.length - 4) : "") + "）"; }),
    };
  }
  function resetFailText(summary) {
    var s = summary || {};
    var ja = Array.isArray(s.leftover_ja) ? s.leftover_ja : [];
    return ja.length ? ("前の条件を消せない: " + ja.join("・")).slice(0, 160) : null;
  }

  // 入れた後、このお客様の条件だけになっているか（前の区・駅が混ざっていないか）
  //   after: { wards: [...], stations: [...] }（入れた後のチップ）
  //   want:  { mode: "area"|"station"|"none", wards: [...], stations: [...]（別名込み）, selectAll: 駅を路線ごとに全部選ぶ回 }
  //   返り値: { foreign: [...混ざった物（はっきり外れの物だけ）], unmatched_stations: [...当たらない駅（別名・表記ゆれがあるので札にしない）] }
  function wardShort(w) { var s = squash(w).replace(/内$/, ""); var m = s.match(/^.+?[市郡]([^市郡]+[区町村])$/); return m ? m[1] : s; }
  function stationKey(s) { return squash(s).replace(/[（(].*?[）)]/g, "").replace(/駅$/, ""); }
  function foreignChips(after, want) {
    var a = after || {}, w = want || {};
    var wards = Array.isArray(a.wards) ? a.wards : [], stations = Array.isArray(a.stations) ? a.stations : [];
    var foreign = [], unmatched = [];
    if (w.mode === "station") wards.forEach(function (c) { foreign.push("所在地:" + c); });
    if (w.mode === "area") stations.forEach(function (c) { foreign.push("駅:" + c); });
    if (w.mode === "area") {
      var ws = (Array.isArray(w.wards) ? w.wards : []).map(function (x) { return squash(x).replace(/内$/, ""); }).filter(Boolean);
      wards.forEach(function (c) {
        var cs = squash(c);
        var hit = ws.some(function (x) { return cs.indexOf(x) === 0 || x.indexOf(cs) === 0 || cs.indexOf(wardShort(x)) >= 0; });
        if (!hit && ws.length) foreign.push("所在地:" + c);
      });
    }
    if (w.mode === "station" && !w.selectAll) {
      var ss = (Array.isArray(w.stations) ? w.stations : []).map(stationKey).filter(Boolean);
      stations.forEach(function (c) { if (ss.length && ss.indexOf(stationKey(c)) < 0) unmatched.push(c); });
    }
    return { foreign: foreign.slice(0, 20), unmatched_stations: unmatched.slice(0, 20) };
  }

  return {
    FILTER_ROWS: FILTER_ROWS,
    CLEAR_TEXT_FIELDS: CLEAR_TEXT_FIELDS,
    CLEAR_CHECK_NAMES: CLEAR_CHECK_NAMES,
    CLEAR_CHECK_LABELS: CLEAR_CHECK_LABELS,
    keepTextName: keepTextName,
    isDeleteControl: isDeleteControl,
    isEmptyValue: isEmptyValue,
    chipNames: chipNames,
    leftovers: leftovers,
    resetSummary: resetSummary,
    resetFailText: resetFailText,
    foreignChips: foreignChips,
    /** 1つ外すごとの人の間（ms・humanDelay で散らす） */
    RESET_STEP_MS: 450,
    RESET_LABELS: RESET_LABELS,
    isResetLabel: isResetLabel,
    rentText: rentText,
    RENT_MAX_LEN: MAX_LEN,
    searchBlock: searchBlock,
    isDuplicateFill: isDuplicateFill,
    fillKey: fillKey,
    DUP_WINDOW_MS: DUP_WINDOW_MS,
    relayError: relayError,
    /** 検索のボタンが押せるようになるのを待つ長さ（件数の数え直しを待つ・人が件数を見る間） */
    SEARCH_READY_WAIT_MS: 8000,
  };
});
