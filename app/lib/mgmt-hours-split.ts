// app/lib/mgmt-hours-split.ts — 確認の「いつ」の線（純関数）
//
// 2026-10-28 竹内さんの決定（KB 5d9e56b5・9fd703f4・今週の LINE #26 Ryoichi・#28 あかり）:
//   募集状況（空き）の確認は業者の物件サイト（リアプロ・ITANDI・レインズ）で弊社の営業時間中に確かめられる＝18時以降でも「明日」を付けない。
//   管理会社にしか答えられない確認・交渉（駐車場・鍵交換の免除・ペット 等）だけ、18時以降は「本日管理会社営業時間外の為明日…」。
// 切替: MGMT_HOURS_SPLIT_1028（2026-11-05 既定 on・=off で戻す。作業員9 の試験 mgmt-split-on 悪化0・q197 は揺れ＝ブレインの判断に触らない・竹内さんの決定 P1 5d9e56b5／5fe999f8 の2回）。テスト: app/lib/__tests__/mgmt-hours-split.test.ts
export function mgmtHoursSplitEnabled(env: Record<string, string | undefined> = typeof process !== "undefined" ? process.env : {}): boolean {
  return (env.MGMT_HOURS_SPLIT_1028 ?? "").trim().toLowerCase() !== "off";
}

/** 弊社の営業の終わり（JST の時）。やることリストの最後の便は 20:30・電話は19時まで＝確かめ待ち（竹内さんに答え待ち） */
export const COMPANY_CLOSE_HOUR = 21;

/** 確認の対象が空き・募集状況だけか（駐車場・鍵交換・ペット・交渉 等が入っていれば管理会社の確認） */
export function isVacancyConfirmObject(object: string | null | undefined): boolean {
  const o = String(object ?? "").trim();
  if (!o) return false;
  if (/駐車|駐輪|バイク|鍵|ペット|猫|犬|交渉|値下|割引|礼金|敷金|フリーレント|設備|入居(?:可能)?日|保証|審査|契約|退去|楽器|二人|法人/.test(o)) return false;
  return /募集状況|空室|空き|募集/.test(o);
}

/**
 * 夜の管理会社への確認の結び（2026-11-05 作業員9・弱い所 324・KB P1 9fd703f4）。
 *   なぜ: 2段の確認の番は、ブレインの返信の方向（two-stage の direction「結びは『確認出来次第ご連絡させて頂きます！！』」）が
 *   本質の帯の一番上に入り、下の【管理会社の状況】の「明日」の指示より勝っていた（試験 q136＝8/23 20:38 の番・前も今も「明日」が無い）。
 *   竹内さん本人の夜（18時以降）の管理会社への確認の送信は、ほぼ全部「明日」を付けている:
 *     8/23 20:54「礼金の交渉と駐車場の空き状況について、管理会社に確認させて頂きます！！ 管理会社営業時間外ですので明日確認し 確認出来次第ご連絡」（q136 の番そのもの）
 *     10/26 18:45「本日管理会社営業時間外の為明日交渉、確認させていただき確認出来次第ご連絡」・8/24 18:11・9/10 22:24・8/25 23:38（例外は 9/06 20:59 の駐車場料金の1通）
 *   何を: ブレインの方向のすぐ下に1行だけ足し、結びの前に「本日管理会社営業時間外の為、明日」を入れさせる（ブレインの判断・結びの言葉は変えない）。
 *   入れない: 確認の約束が無い番・土曜の夜（交渉は月曜の別の注記）・朝（9時前）・募集状況だけの確認で21時より前（10/28 の決定＝今すぐ確かめられる）。
 * 切替: MGMT_NIGHT_CLOSING=on の時だけ（既定 off）。
 * 【退役 2026-11-06・統括役の決め】off のまま使わない。書き手は下に足したこの注記より、上のブレインの方向（two-stage の check の direction）の結びに従い、
 *   試験で「明日」を入れたのは 9通中2通だけだった（closing2 1/3・fc-night2 0/3 等）。同じ事は two-stage.nightMgmtCheckDirection（MGMT_NIGHT_DIRECTION）が
 *   方向の文そのもので行い、q136 で 3/3（night-dir-q136）。二重に言うだけになるので on にしない（消さずに履歴として残す）
 */
export function mgmtNightClosingOn(env: Record<string, string | undefined> = typeof process !== "undefined" ? process.env : {}): boolean {
  return (env.MGMT_NIGHT_CLOSING ?? "").trim().toLowerCase() === "on";
}
/** 管理会社にしか答えられない話題（isVacancyConfirmObject の外す語と同じ並び） */
// 保証・審査は入れない（竹内さんの 10/26 19:25・8/23 21:24 の保証会社の交渉の約束は「明日」無し）
export const MGMT_TOPIC_RE = /駐車|駐輪|バイク|鍵|ペット|猫|犬|交渉|値下|割引|礼金|敷金|フリーレント|設備|入居(?:可能)?日|代理契約|退去|楽器|二人|法人|クリーニング|洗濯/;
// 2026-11-06 試験 night-closing-on: q136（礼金の調整・駐車場）の confirmCtx.object が「募集状況」になっていて募集状況だけの確認と読み、21時前の線で外していた
//   ＝話題はお客様の発言（topicText）でも見る。お客様の発言に管理会社の話題があれば管理会社への確認（object の言葉は使わない）
// saturday: 土曜の夜だけ外す（明日が日曜＝別の土日の注記「月曜日一番」に任せる）。日曜の夜は明日が月曜なので入れる（8/23 日曜 20:54 の竹内さん）
export function nightMgmtClosingLine(o: { hour: number; saturday: boolean; allowed: boolean; object: string | null | undefined; splitOn: boolean; topicText?: string | null }): string | null {
  if (!o.allowed || o.saturday) return null;
  if (!(o.hour >= 18)) return null;
  const mgmtTopic = MGMT_TOPIC_RE.test(String(o.topicText ?? ""));
  const vacancy = isVacancyConfirmObject(o.object) && !mgmtTopic;
  if (vacancy && o.splitOn && o.hour < COMPANY_CLOSE_HOUR) return null;
  const obj = mgmtTopic && isVacancyConfirmObject(o.object) ? "" : String(o.object ?? "").trim();
  // 2026-11-06 試験 night-all4-q136: 「管理会社に確認させて頂きます！！」の後ろに「明日確認させて頂き、確認出来次第…」を別の文で足し、最終チェック（AIX_BOUNDARY_PROMISE＝確認の二重宣言）に文ごと消された
  //   ＝確認・交渉の約束の文そのものに「明日」を入れる（竹内さんの 10/26 18:45・8/25 23:38 の実送信の形）。別の文に分けない
  return `- 🕘 夜の確認の約束（${o.hour}時台・管理会社の営業時間外）: 確認・交渉の約束は1文だけにし、その文の中に「明日」を入れる。竹内さんの実送信の形: 「${obj ? `${obj}につきまして、` : "〇〇につきまして、"}本日管理会社営業時間外の為明日確認させて頂き、確認出来次第ご連絡させて頂きます！！」（10/26）か「明日管理会社に〇〇を確認（交渉）させて頂きます！！ 確認出来次第ご連絡させて頂きます！！」（8/25）。「管理会社に確認させて頂きます」と「明日確認させて頂き」を別々の文に書かない（確認の二重の約束になる）。当日中の答えを約束しない・ほかの中身は上のまま`;
}

/**
 * 夜の管理会社への確認をブレインに渡す材料の1行（2026-11-06 作業員9・弱い所 345・KB P1 9fd703f4）。
 *   なぜ: 試験 q136（8/23 20:38・礼金の調整と駐車場の空き）でブレインが17回中16回 AIX【物件確認した】を選んだ。竹内さんは確認の約束の返信＋「明日」
 *   （夜の管理会社への確認の送信7通中6通が「明日」）。ブレインの手本（brain-route-type-data）にこの番は「約束の返信（確認）」で入っているのに、
 *   今が管理会社の営業時間外＝結果をまだ持っていない、という事実が材料に無かった。
 *   何を: 18時以降で（曜日は見ない）、お客様の連投に管理会社の話題（MGMT_TOPIC_RE）がある番だけ、事実と竹内さんの決まりを1行で渡す（判断はブレイン・決定論で書き換えない）。
 * 切替: MGMT_NIGHT_BRAIN_NOTE（11/06 既定 on・=off で止める・H-9 待ち）。
 */
export function mgmtNightBrainNoteOn(env: Record<string, string | undefined> = typeof process !== "undefined" ? process.env : {}): boolean {
  return (env.MGMT_NIGHT_BRAIN_NOTE ?? "").trim().toLowerCase() !== "off"; // 2026-11-06 既定 on（試験 night-all4-q136 0/4→3/3・昼 night3-day 悪化0・竹内さんへの確認 H-9 待ち＝「夜も AIX でよい」なら戻す）
}
// 曜日は見ない（土日の夜も結果は持っていない＝約束の返信。8/23 の q136 は日曜の夜）
export function nightMgmtBrainNote(o: { hour: number; customerText: string | null | undefined }): string {
  if (!(o.hour >= 18)) return "";
  const t = String(o.customerText ?? "");
  const hit = t.match(MGMT_TOPIC_RE);
  if (!hit) return "";
  return `\n【管理会社の営業時間外】今は${o.hour}時台（管理会社の営業時間外）。お客様が聞いた「${hit[0]}」等の管理会社にしか答えられない確認・交渉は、今は結果を持っていない＝AIX【物件確認した】で結果を送る番ではない。竹内さんの決まり（18時以降）: 確認の約束の返信（two_stage=check・「本日管理会社営業時間外の為、明日確認させて頂き、確認出来次第ご連絡」・土曜の夜は月曜）にして、結果は翌日 AIX【確認した】で送る。募集状況だけの確認はこの決まりの外（今すぐ確かめられる）`;
}

/**
 * 案A（2026-11-06 統括役の決め・弱い所 345）: 夜の番だけ、お客様の話題に当たるピッカーの意味を材料の1行に足す
 *   「AIX【物件確認した】のこのピッカーは『管理会社に聞いた結果』を送るボタン＝今夜はまだ押せない（結果が無い）」。
 *   なぜ: 事実と決まりの1行（MGMT_NIGHT_BRAIN_NOTE）だけでは q136 が 0/3→1/4 しか動かなかった。ブレインはピッカー（mgmt_parking・mgmt_initial_cost）を
 *   「管理会社に確かめる」の意味で選んでいる見込み＝選ぶ時に見るピッカーの言葉で、今夜は結果が無い事を伝える。
 *   AIX の一覧（aix-catalog の説明・キャッシュの固定部分）は変えない（夜だけの1行は動く材料の側に置く＝キャッシュを壊さない・AIX の改善の決まりの外）。
 * 切替: MGMT_NIGHT_PICKER_NOTE（MGMT_NIGHT_BRAIN_NOTE の1行が出る番だけ・11/06 既定 on・=off で止める・H-9 待ち）。
 */
export function mgmtNightPickerNoteOn(env: Record<string, string | undefined> = typeof process !== "undefined" ? process.env : {}): boolean {
  return (env.MGMT_NIGHT_PICKER_NOTE ?? "").trim().toLowerCase() !== "off"; // 2026-11-06 既定 on（試験 night-all4-q136 0/4→3/3・昼 night3-day 悪化0・竹内さんへの確認 H-9 待ち＝「夜も AIX でよい」なら戻す）
}
const TOPIC_PICKERS: Array<[RegExp, string]> = [
  [/駐車|駐輪|バイク/, "mgmt_parking"],
  [/礼金|敷金|交渉|値下|割引|フリーレント|クリーニング|鍵/, "mgmt_initial_cost"],
  [/代理契約/, "mgmt_proxy"],
  [/ペット|猫|犬/, "mgmt_pet"],
  [/設備|洗濯|楽器/, "mgmt_equipment"],
  [/入居(?:可能)?日/, "mgmt_move_in"],
  [/二人|法人/, "mgmt_two_person"],
];
export function nightPickerLine(customerText: string | null | undefined): string {
  const t = String(customerText ?? "");
  const ps = [...new Set(TOPIC_PICKERS.filter(([re]) => re.test(t)).map(([, p]) => p))];
  if (!ps.length) return "";
  return `\n【今夜はまだ押せないピッカー】AIX【物件確認した】の ${ps.join("・")} は「管理会社に聞いた結果」を送るピッカー。今は管理会社の営業時間外で結果がまだ無い＝今夜はこのピッカーを選ばない（aix にしない）。今夜は two_stage=check の確認の約束の返信、結果が出た翌日にこのピッカー`;
}

/** 夜の管理会社の話題で、A1 の AIX 直接（two-stage answerableDirectAix）を外す（2026-11-06 作業員9・弱い所 345／350）。MGMT_NIGHT_NO_DIRECT（11/06 既定 on・=off で止める・H-9 待ち） */
export function mgmtNightNoDirectOn(env: Record<string, string | undefined> = typeof process !== "undefined" ? process.env : {}): boolean {
  return (env.MGMT_NIGHT_NO_DIRECT ?? "").trim().toLowerCase() !== "off"; // 2026-11-06 既定 on（試験 night-all4-q136 0/4→3/3・昼 night3-day 悪化0・竹内さんへの確認 H-9 待ち＝「夜も AIX でよい」なら戻す）
}

/**
 * 最終チェック（rule_check）に渡す夜の1行（2026-11-06 作業員9・弱い所 324・統括役の決め）。
 *   試験 closing2-q136 で、書き手の「…明日管理会社に確認させて頂きます！！確認出来次第ご連絡させて頂きます！！」（竹内さんの 8/25 の形）を
 *   rule_check が AIX_BOUNDARY_PROMISE（AIX の番の約束）×2 と読み、書き直しで「明日」を落とした。
 *   出すのは 18時以降・お客様の発言に管理会社の話題（MGMT_TOPIC_RE）がある番だけ。守りの他の型（内覧日時・金額・住所 等）には触れない。
 * 切替: MGMT_NIGHT_FC_TOMORROW=on の時だけ（既定 off）。
 */
export function mgmtNightFcTomorrowOn(env: Record<string, string | undefined> = typeof process !== "undefined" ? process.env : {}): boolean {
  return (env.MGMT_NIGHT_FC_TOMORROW ?? "").trim().toLowerCase() === "on";
}
export function mgmtNightFcTomorrowNote(o: { hour: number; customerText: string | null | undefined }, env?: Record<string, string | undefined>): string {
  if (!mgmtNightFcTomorrowOn(env) || !(o.hour >= 18)) return "";
  const hit = String(o.customerText ?? "").match(MGMT_TOPIC_RE);
  if (!hit) return "";
  return `\n【夜の管理会社への確認（竹内さんの決まり）】今は管理会社の営業時間外。お客様が聞いた「${hit[0]}」等の確認・交渉を「明日管理会社に確認（交渉）させて頂きます」「本日管理会社営業時間外の為明日確認させて頂き、確認出来次第ご連絡させて頂きます」と1回約束する文は正しい約束（結果は翌日 AIX で送る）＝AIX_BOUNDARY_PROMISE にしない・「明日」を消さない。同じ確認の約束が2文に重なっている時だけ二重宣言として指摘してよい（その時も「明日」の入った方を残す）\n`;
}
