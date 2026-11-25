// result-verify.js — 検索結果ページの「効いている条件」の文字を、今のお客さんの希望と照らす（2026-11-24 v2.8.277）
//
// 竹内さん「前客の駅外すようにちゃんと確認できないのか／画面を見て確認、問題あれば外す」
// 統括Pro「外し確認の正本は『結果ページの効いている条件の文字＋棟戸数』。フォームには選んだ駅の一覧が出ない」
//
// 純関数だけ（画面に触らない）。使う側（bulk-dl.js）が見出しの文字と、検索を押した時の希望を渡す。
//   parseHead(text)            … 見出しの文字から 家賃上下限・徒歩・築年・更新日・棟戸数 を読む
//   verify(text, expect, opts) … 希望と照らして { verdict, diffs, seen, count, full }
//     verdict: "ok" 合っている／"mismatch" 前客の値などが残っている／"full" 全件（条件が効いていない）／
//              "unknown" 見出しから何も読めなかった（止める根拠にしない）
//
// ⚠ 見出しの範囲だけ読む: 一覧の行（部屋名・住所・沿線の「徒歩10分」）を読むと別物を拾う。
//   最初の行の目印（部屋名／お問合せ先／住所：／沿線：）より前で切る。
// ⚠ 読めた項目だけ比べる。読めない項目は「分からない」＝止める根拠にしない（誤検知で客を飛ばさない）。
(function (root, factory) {
  var api = factory();
  if (typeof module !== "undefined" && module.exports) module.exports = api;
  if (root && !root.AxlxResultVerify) root.AxlxResultVerify = api;
})(typeof self !== "undefined" ? self : this, function () {
  /** 全件とみなす棟数（大阪全件は 16000 台）。条件つきなら数十〜数百 */
  var FULL_BUILDINGS = 5000;
  /** 家賃の誤差（円）。選択肢の刻みで上へ/下へ丸めた分 */
  var RENT_TOL = 10000;
  /** 徒歩・築年・更新日の誤差（選択肢の刻みで丸めた分） */
  var STEP_TOL = 5;

  function norm(t) {
    return String(t == null ? "" : t)
      .replace(/[０-９]/g, function (c) { return String.fromCharCode(c.charCodeAt(0) - 0xFEE0); })
      .replace(/[，,]/g, "")
      .replace(/[\s\u3000]+/g, " ");
  }
  /** 一覧の最初の行の目印より前だけ（見出し） */
  function headRegion(text) {
    var t = norm(text);
    var m = /部屋名|お問合せ先|お問い合わせ先|住所\s*[:：]|沿線\s*[:：]/.exec(t);
    return (m ? t.slice(0, m.index) : t).slice(0, 2500);
  }
  /** 「10.7万」「80000円」「8」（単位なしで1000未満は万）→ 円 */
  function manToYen(s) {
    var m = /([0-9.]+)\s*(万|円)?/.exec(String(s || ""));
    if (!m) return null;
    var n = parseFloat(m[1]);
    if (!isFinite(n)) return null;
    if (m[2] === "万") return Math.round(n * 10000);
    if (m[2] === "円") return Math.round(n);
    return Math.round(n >= 1000 ? n : n * 10000);
  }
  function parseHead(text) {
    var h = headRegion(text);
    var out = { region: h.slice(0, 200), count: null, rentSeen: false, rentMin: null, rentMax: null, walk: null, update: null, age: null };
    var mc = /([0-9]+)\s*棟\s*([0-9]+)\s*戸/.exec(norm(text).slice(0, 3000));
    if (mc) out.count = { b: Number(mc[1]), h: Number(mc[2]) };
    // 家賃: 「家賃 8万～10.7万」「家賃 ～10.5万」「賃料 8万～」「家賃 下限なし～10万」
    var mr = /(?:家賃|賃料)\s*[:：]?\s*(下限なし|[0-9.]+\s*(?:万|円)?)?\s*[～〜~－\-]\s*(上限なし|[0-9.]+\s*万|[0-9]{4,}\s*円?)?/.exec(h);
    if (mr && (mr[1] || mr[2])) {
      out.rentSeen = true;
      if (mr[1] && /[0-9]/.test(mr[1])) out.rentMin = manToYen(mr[1]);
      if (mr[2] && /[0-9]/.test(mr[2])) out.rentMax = manToYen(mr[2]);
    } else {
      // 「家賃 10万以下」「家賃 8万以上」
      var mo = /(?:家賃|賃料)\s*[:：]?\s*([0-9.]+)\s*万\s*(以下|以内|以上)/.exec(h);
      if (mo) {
        out.rentSeen = true;
        if (mo[2] === "以上") out.rentMin = manToYen(mo[1]); else out.rentMax = manToYen(mo[1]);
      }
    }
    var mw = /徒歩\s*([0-9]{1,3})\s*分/.exec(h);
    if (mw) out.walk = Number(mw[1]);
    var mu = /更新\s*([0-9]{1,3})\s*日/.exec(h);
    if (mu) out.update = Number(mu[1]);
    var ma = /築\s*([0-9]{1,3})\s*年/.exec(h);
    if (ma) out.age = Number(ma[1]);
    return out;
  }
  function numOrNull(v) {
    if (v == null || v === "" || v === "-1") return null;
    var n = Number(v);
    return isFinite(n) && n > 0 ? n : null;
  }
  /**
   * expect: { rentMin, rentMax（円・文字でも可）, walk, age, updateDays } ＝ 検索を押した時の希望（無ければ null）
   * 返す diffs は日本語（画面・点検にそのまま出す）
   */
  function verify(text, expect, opts) {
    expect = expect || {};
    opts = opts || {};
    var p = parseHead(text);
    var diffs = [];
    var seen = [];
    var fullB = opts.fullBuildings || FULL_BUILDINGS;
    var full = !!(p.count && p.count.b >= fullB);

    if (p.rentSeen) {
      seen.push("家賃");
      var eMin = numOrNull(expect.rentMin), eMax = numOrNull(expect.rentMax);
      if (eMax != null) {
        if (p.rentMax == null) diffs.push("家賃の上限が見出しに無い（希望 " + eMax / 10000 + "万）");
        else if (Math.abs(p.rentMax - eMax) > RENT_TOL) diffs.push("家賃の上限が違う（見出し " + p.rentMax / 10000 + "万・希望 " + eMax / 10000 + "万）");
      } else if (p.rentMax != null) diffs.push("希望に無い家賃の上限が残っている（見出し " + p.rentMax / 10000 + "万）");
      if (eMin != null) {
        if (p.rentMin == null) diffs.push("家賃の下限が見出しに無い（希望 " + eMin / 10000 + "万）");
        else if (Math.abs(p.rentMin - eMin) > RENT_TOL) diffs.push("家賃の下限が違う（見出し " + p.rentMin / 10000 + "万・希望 " + eMin / 10000 + "万）");
      } else if (p.rentMin != null) diffs.push("希望に無い家賃の下限が残っている（見出し " + p.rentMin / 10000 + "万）");
    }
    var cmp = function (label, head, exp, unit) {
      if (head == null) return;
      seen.push(label);
      var e = numOrNull(exp);
      if (e == null) diffs.push("希望に無い" + label + "が残っている（見出し " + head + unit + "）");
      else if (Math.abs(head - e) > STEP_TOL) diffs.push(label + "が違う（見出し " + head + unit + "・希望 " + e + unit + "）");
    };
    cmp("徒歩", p.walk, expect.walk, "分");
    cmp("築年", p.age, expect.age, "年");
    cmp("更新日", p.update, expect.updateDays, "日");

    var verdict;
    if (full) verdict = "full";
    else if (diffs.length) verdict = "mismatch";
    else if (seen.length) verdict = "ok";
    else verdict = "unknown";
    return { verdict: verdict, diffs: diffs, seen: seen, count: p.count, full: full, parsed: p };
  }
  /** 点検に残す短い文（80字に収める）。見出しの読み取り結果＋判定 */
  function brief(r) {
    var p = r.parsed || {};
    var parts = [r.verdict];
    if (p.count) parts.push(p.count.b + "棟");
    if (p.rentSeen) parts.push("家賃" + (p.rentMin != null ? p.rentMin / 10000 : "") + "~" + (p.rentMax != null ? p.rentMax / 10000 : ""));
    if (p.walk != null) parts.push("徒歩" + p.walk);
    if (p.age != null) parts.push("築" + p.age);
    if (p.update != null) parts.push("更" + p.update);
    if (r.diffs && r.diffs.length) parts.push("差" + r.diffs.length);
    return parts.join(" ").slice(0, 80);
  }
  return { parseHead: parseHead, verify: verify, brief: brief, headRegion: headRegion, FULL_BUILDINGS: FULL_BUILDINGS };
});
