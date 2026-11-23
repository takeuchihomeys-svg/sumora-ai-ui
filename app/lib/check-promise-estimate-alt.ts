// app/lib/check-promise-estimate-alt.ts — 募集状況の確認の約束を果たす番に、2つ目の候補として AIX【見積書送る】を並べる（純関数・既定 off）
//
// 2026-11-23 作業員K2（台帳 #469・統括役の頼み・作業員A の aix-turn-60b.json の「種類違い」9番）。
//   確認の約束（promise:check）が残っている番、ブレインは AIX【物件確認した】を立てる（aix-task-link.resolveStaffPromiseAix）。
//   竹内さんは、お客様が送ってきたお部屋が空いていた時、確認の報告ではなく【見積書送る】（最大限割引した初期費用の御見積書）で約束を果たしていた
//   （3722・5831・6260 の3番。空いていたかは確認した人だけが知る＝ブレインには分からない）。
//   ただし確認の約束の後に竹内さんが押した AIX は 物件確認した 19・見積書 3・物件 9（同じ表）で、主の一手を見積書にすると外れが増える。
//   → 主の一手は【物件確認した】のまま、2つ目（altActions・画面の2択）に【見積書送る】を並べるだけ。見積る物件が無い時・既に2つ目がある時は並べない。
//   見込み: 種類違い（確認↔見積）の3番のうち、約束の文に「募集状況…確認させて頂き」がある2番（3722・6260）が、（5831 は「募集状況と初期費用…ご連絡」で確認の語が無く拾わない）主の一手は変わらず2つ目で押せる形になる（A の物差しの「一致」は主の一手で数えるので数は動かない＝
//   動かす数は「2つ目の候補で押せた番」。毎日の数はまだ無い）。
// ■ スイッチ CHECK_PROMISE_ESTIMATE_ALT: 既定 off（何もしない）／on（brain-core の約束の AIX の所で2つ目に並べる）
// テスト: app/lib/__tests__/check-promise-estimate-alt.test.ts（3番の約束の言い回しを伏せた形）
type Env = Record<string, string | undefined>;
export function checkPromiseEstimateAltOn(env: Env = typeof process !== "undefined" ? process.env : {}): boolean {
  return String(env.CHECK_PROMISE_ESTIMATE_ALT ?? "").trim().toLowerCase() === "on";
}

/** 募集状況（空き）の確認の約束の文（aix-task-link の VACANCY_CHECK_DECL_RE と同じ形・あちらは書き出していない。「確認させて頂き、〜」の続く形も拾うよう語尾だけ広い） */
const VACANCY_CHECK_RE = /(?:募集状況|空室状況|空き状況|空室|空き)[^\n。！!]{0,20}確認(?:させて(?:頂|いただ)き|いたし|致し|して(?:参|まい)ります)/;
/** 内覧の可否の確認（内覧の約束は内覧調整で果たす＝見積書を並べない） */
const VIEWING_RE = /内覧|内見|ご案内/;

/**
 * @returns 2つ目に並べる AIX（"estimate_sheet"）か null
 */
export function checkPromiseEstimateAlt(o: {
  promiseKind: string | null | undefined;
  promiseAction: string | null | undefined;
  currentAlt: string | null | undefined;
  /** 見積る物件があるか（brain-core の estimatePropertyInPlay） */
  propertyInPlay: boolean;
  /** 直前のこちらの約束の文 */
  lastStaffText: string | null | undefined;
}): "estimate_sheet" | null {
  if (o.promiseKind !== "check" || o.promiseAction !== "property_check_result") return null;
  if (o.currentAlt) return null;
  if (!o.propertyInPlay) return null;
  const t = String(o.lastStaffText ?? "");
  if (!VACANCY_CHECK_RE.test(t)) return null;
  if (VIEWING_RE.test(t) && !/見積|初期費用/.test(t)) return null;
  return "estimate_sheet";
}
