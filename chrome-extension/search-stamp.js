// search-stamp.js — 一覧の物件を「その一覧を検索したお客様」以外に送らない（2026-10-06 v2.5.80）
//
// 竹内「何でこれこんな物件でているのか 原因見つけて改善する 違うお客さんの物件がまぎれている」
//   （あさん: 本町・堺筋本町・〜15万・1LDK。10/04 14:11 の回に RIDGE江坂・ソルテ住道・ぷりんせす八丁畷B棟（高槻市）・スプランディッド難波2 が付いた）。
//   調べた事実: その時間の検索の記録（search_audits）は「あさん」の2回だけ（案内モード＝拡張は入力しない・終わりの合図なし）。
//   付いた6部屋は全部 元付「アズ・スタット」・1K/1R・4.2〜7.7万で、あさんの条件（1LDK・本町）とも他のお客様の条件とも合わない
//   ＝誰かの検索結果ではなく、あさんの条件で検索していない一覧（管理会社の一覧など）で印刷用PDF を押した物が、
//   拡張の「今のお客様」（current_customer_id）にそのまま付いた。v2.5.62 の「印刷用PDF を押したら20秒後にまとめて送る」もこの道を通る。
//   旧の見張り（v2.5.49 batch-guard sendOwner・OWNER_MISMATCH）は一括の回の時だけで、手で押した送信は見ていなかった。
//   → ①案内で「検索」を押した時に、その一覧を検索したお客様をタブに印（sessionStorage axlx_search_for）
//     ②送る時（手で押す・20秒後のまとめて送る）に、印のお客様と今のお客様・印の新しさ・手順が終わっていたか・
//       選んだ部屋の場所（ブレインの下見の AREA_FAR）を照らし、合わなければ送らない（手で押した時は日本語で確かめる）
(function (root, factory) {
  var api = factory();
  if (typeof module !== "undefined" && module.exports) module.exports = api;
  if (root && !root.AxlxSearchStamp) root.AxlxSearchStamp = api;
})(typeof self !== "undefined" ? self : this, function () {
  var KEY = "axlx_search_for";
  var STALE_MS = 3 * 60 * 60 * 1000;
  function read() {
    try { var s = sessionStorage.getItem(KEY); return s ? JSON.parse(s) : null; } catch (_) { return null; }
  }
  function write(o) {
    try { sessionStorage.setItem(KEY, JSON.stringify(o)); } catch (_) {}
  }
  /**
   * 純: 送ってよいか。stamp＝{cid, name, at, site, complete}／cur＝{cid, name}／selected＝[{area:"far"|"close"|…}]
   *   返す: { ok, reasons:[code], message }（message は確かめの文・日本語）
   */
  function check(p) {
    var st = p.stamp, cur = p.cur || {}, now = typeof p.now === "number" ? p.now : Date.now();
    var reasons = [], lines = [];
    var curName = cur.name ? cur.name + "さん" : "今のお客様";
    if (!st || !st.cid) {
      reasons.push("no_search");
      lines.push("・この一覧は、拡張の案内で「" + curName + "」の条件で検索した一覧ではありません");
    } else if (cur.cid && String(st.cid) !== String(cur.cid)) {
      reasons.push("other_customer");
      lines.push("・この一覧は「" + (st.name ? st.name + "さん" : "別のお客様") + "」の検索です（今のお客様は「" + curName + "」）");
    } else {
      if (now - Number(st.at || 0) > STALE_MS) { reasons.push("stale"); lines.push("・この一覧の検索から3時間以上たっています"); }
      if (st.complete === false) { reasons.push("incomplete"); lines.push("・案内の手順（駅・区・家賃など）が終わる前に検索した一覧です"); }
    }
    var sel = Array.isArray(p.selected) ? p.selected : [];
    var known = sel.filter(function (x) { return x && x.area; });
    var far = known.filter(function (x) { return x.area === "far"; }).length;
    if (known.length >= 2 && far * 2 >= known.length) {
      reasons.push("far");
      lines.push("・選んだ " + known.length + "件のうち " + far + "件が「" + curName + "」の希望の場所から遠い物件です");
    }
    var ok = reasons.length === 0;
    return {
      ok: ok,
      reasons: reasons,
      message: ok ? "" : "送る前に確かめてください（違うお客様の物件が混ざっていないか）\n\n" + lines.join("\n") + "\n\nこのまま「" + curName + "」の物件として送りますか？",
    };
  }
  /**
   * v2.5.81: 送る時に売上サポの回へ渡す形（印が今のお客様の物で新しい時だけ。違う時は null＝別の検索の条件を付けない）。
   *   サーバーは property_pickups.search_conditions に残し、AIX の物件ピックアップの文が時刻の窓なしで読む
   */
  function forSend(stamp, curCid, now) {
    if (!stamp || !stamp.cid || !curCid || String(stamp.cid) !== String(curCid)) return null;
    var t = typeof now === "number" ? now : Date.now();
    if (t - Number(stamp.at || 0) > STALE_MS) return null;
    return { v: 1, site: stamp.site || null, at: new Date(Number(stamp.at)).toISOString(), complete: stamp.complete !== false, intended: stamp.intended || null, filled: stamp.filled || null };
  }
  /** 案内の条件（popup が組み立てた検索の条件）を小さく */
  function compactIntended(c) {
    if (!c) return null;
    var pick = ["area_mode", "station_names", "city_codes", "ward_names", "itandi_lines", "route_ids", "rent_min", "rent_max", "floor_plan", "building_age", "walk_minutes", "area_min", "area_max", "is_wide", "rp_update_days", "pet_ok", "structure_types"];
    var o = {};
    pick.forEach(function (k) { var v = c[k]; if (v == null || v === "" || (Array.isArray(v) && !v.length)) return; o[k] = Array.isArray(v) ? v.slice(0, 40) : v; });
    return o;
  }
  return { KEY: KEY, STALE_MS: STALE_MS, read: read, write: write, check: check, forSend: forSend, compactIntended: compactIntended };
});
