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
  function fillKey(cond) {
    try { return JSON.stringify(cond == null ? null : cond); } catch (e) { return null; }
  }

  // ── fill-done の中継: ページの失敗は検索を押していない＝そのサイトを飛ばす（skip）──
  // page-script は検索を押す前に止まった時だけ skip:true を付ける。skip の時だけ background に error として渡す
  //   （旧: error は pageError に入れて渡さず、background は押していない検索の結果を5分待っていた）
  function relayError(data) {
    var d = data || {};
    if (!d.error) return { error: null, pageError: null };
    return d.skip ? { error: String(d.error), pageError: String(d.error) } : { error: null, pageError: String(d.error) };
  }

  return {
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
