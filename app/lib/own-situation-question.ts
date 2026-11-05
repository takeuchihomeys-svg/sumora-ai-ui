// app/lib/own-situation-question.ts — お客様自身の事情（無職・収入・夜職 等）で「借りられるか」を聞く問いか（純関数・DB/LLM なし）
//
// 2026-11-05 作業員7（弱い所 343・q332）: 「現在は無職…このような状況でも、こちらの物件をご紹介いただくことは可能でしょうか？」が、
//   場面の網（aix-scene-evidence の S1 募集状況）で「物件＋可能でしょうか」＝空室の問いと読まれ、ブレインが物件確認の約束（2段:check）にしていた。
//   竹内さんの実送信: AIX【電話】「審査通過するにあたりまして5分程お電話でお打ち合わせ…」1通（空室の確認はしていない）。
//   → お客様自身の事情で借りられるか（審査の相談）を聞く問いは、空室の問いにしない（判断はブレインに返す・候補を消すだけ）。
//   空き・募集状況の言葉（空いて・空き・募集・まだありますか）が同じ文にある時は空室の問いのまま。
// スイッチ: 既定 on（11/05・止める OWN_SITUATION_NOT_VACANCY=off）。テスト: app/lib/__tests__/own-situation-question.test.ts

type Env = Record<string, string | undefined>;
export function ownSituationNotVacancyOn(env: Env = typeof process !== "undefined" ? process.env : {}): boolean {
  return (env.OWN_SITUATION_NOT_VACANCY ?? "").trim().toLowerCase() !== "off"; // 11/05 tm7 悪化0 で既定 on（統括役の決め・止める OWN_SITUATION_NOT_VACANCY=off）
}

/** お客様自身の事情の語（審査に効く状況）。本番90日の監査（作業員7）で、内定の問い（60e6d3ab「内定書などないですが申し込みはできる」）の番にスタッフが同じ番で物件の募集状況確認を約束していた＝内定・転職・退職・派遣・アルバイト・パート・年金は入れない */
const OWN_SITUATION_RE = /無職|求職中|収入|フリマ|夜職|水商売|キャバ|ホスト|学生|フリーランス|個人事業|自営業|ブラック|滞納|自己破産|債務整理|保証人(?:が|は)?(?:いない|居ない|無い|ない|使えない)|生活保護|外国籍|ビザ/;
/** 借りられるか・紹介できるか・審査が通るか の問い */
const CAN_RENT_Q_RE = /(?:紹介|ご紹介|契約|入居|借り|お借り|申込|申し込|審査)[^\n。！!]{0,20}(?:可能|でき|出来|大丈夫|いけ|通)[^\n。！!]{0,12}(?:[？?]|でしょうか|ですか|ますか|ませんか)/;
/** 空き・募集状況そのものの言葉（あれば空室の問いのまま） */
const VACANCY_WORD_RE = /空いて|空き|空室|募集|まだあり|まだ有り|残って/;

/** お客様自身の事情で借りられるかを聞く問いか（空室の問いではない） */
export function isOwnSituationRentQuestion(text: string | null | undefined): boolean {
  const t = String(text ?? "").normalize("NFKC");
  if (!t.trim()) return false;
  if (VACANCY_WORD_RE.test(t)) return false;
  return OWN_SITUATION_RE.test(t) && CAN_RENT_Q_RE.test(t);
}
