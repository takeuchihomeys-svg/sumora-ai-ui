// area-token.js — 希望エリアの語が「地域（所在地）」か「駅」か（2026-10-06 v2.5.76）
//
// 竹内「地域なのに駅としてなぜか扱っている」（けんじじさん・希望エリア 東淀川区・旭区・吹田市・守口市）:
//   原因: リアプロ・ITANDI の検索の直前の「ローカル補正」（_hasKnownStation）が、希望エリアの語が駅の辞書（STATION_LINE_MAP）に
//   あれば地域モードを駅モードに切り替えていた。「守口市」は京阪の駅名でもあるので駅モードになり、駅の手順で 守口市（京阪本線）と
//   吹田（「吹田市」を路線の前置きの読みで「吹田」駅に）を光らせた。分類（classifyAreaTokens）は 市・区 で終わる語を地域としていたのに、
//   補正と駅の拾い出しがその決まりを通っていなかった。
//   → 市・区・郡・府・県で終わる語は地域。駅として扱うのは、お客様が「〇〇駅」と書いた・路線の名前を前に付けた（京阪守口市・阪急茨木市）・
//     スタッフが手直しで駅と覚えさせた（LEARNED_OVERRIDE_MAP）時だけ。
//   同じ形の市: 守口市・門真市・寝屋川市・枚方市・茨木市・高槻市・吹田市・豊中市・池田市・箕面市・摂津市・堺市 など（駅名と同じ・近い）
(function (root, factory) {
  var api = factory();
  if (typeof module !== "undefined" && module.exports) module.exports = api;
  if (root && !root.AxlxAreaToken) root.AxlxAreaToken = api;
})(typeof self !== "undefined" ? self : this, function () {
  var AREA_SUFFIX_RE = /(?:[市区郡府県]|(?:市|府|県|都)内)$/;
  var LINE_PREFIX_RE = /^(?:阪急|阪神|南海|近鉄|JR|ＪＲ|京阪|大阪メトロ|地下鉄|北大阪急行|モノレール|大阪モノレール)/;
  /**
   * 地域（所在地）の語か。rawText＝お客様の希望エリアの元の文（「守口市駅」と書いてあれば駅）。override＝スタッフの手直し（語→"station"|"area"）
   */
  function isAreaToken(t, rawText, override) {
    t = String(t || "").trim();
    if (!t) return false;
    if (override && override[t] === "station") return false;
    if (override && override[t] === "area") return true;
    if (LINE_PREFIX_RE.test(t)) return false;
    if (rawText && String(rawText).indexOf(t + "駅") >= 0) return false;
    return AREA_SUFFIX_RE.test(t);
  }
  /** 駅として拾ってよい語か（地域の語でない） */
  function stationEligible(t, rawText, override) {
    return !isAreaToken(t, rawText, override);
  }
  return { isAreaToken: isAreaToken, stationEligible: stationEligible, AREA_SUFFIX_RE: AREA_SUFFIX_RE, LINE_PREFIX_RE: LINE_PREFIX_RE };
});
