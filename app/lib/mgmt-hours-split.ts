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
  return `- 🕘 夜の確認の約束（${o.hour}時台・管理会社の営業時間外）: 上の結び「確認出来次第ご連絡させて頂きます！！」の前に「本日管理会社営業時間外の為、明日${obj ? `${obj}を` : ""}確認させて頂き、」を入れて1文にする（竹内さんの実送信の形・当日中の答えを約束しない・ほかの中身は上のまま）`;
}

/**
 * 夜の管理会社への確認をブレインに渡す材料の1行（2026-11-06 作業員9・弱い所 345・KB P1 9fd703f4）。
 *   なぜ: 試験 q136（8/23 20:38・礼金の調整と駐車場の空き）でブレインが17回中16回 AIX【物件確認した】を選んだ。竹内さんは確認の約束の返信＋「明日」
 *   （夜の管理会社への確認の送信7通中6通が「明日」）。ブレインの手本（brain-route-type-data）にこの番は「約束の返信（確認）」で入っているのに、
 *   今が管理会社の営業時間外＝結果をまだ持っていない、という事実が材料に無かった。
 *   何を: 18時以降で（曜日は見ない）、お客様の連投に管理会社の話題（MGMT_TOPIC_RE）がある番だけ、事実と竹内さんの決まりを1行で渡す（判断はブレイン・決定論で書き換えない）。
 * 切替: MGMT_NIGHT_BRAIN_NOTE=on の時だけ（既定 off）。
 */
export function mgmtNightBrainNoteOn(env: Record<string, string | undefined> = typeof process !== "undefined" ? process.env : {}): boolean {
  return (env.MGMT_NIGHT_BRAIN_NOTE ?? "").trim().toLowerCase() === "on";
}
// 曜日は見ない（土日の夜も結果は持っていない＝約束の返信。8/23 の q136 は日曜の夜）
export function nightMgmtBrainNote(o: { hour: number; customerText: string | null | undefined }): string {
  if (!(o.hour >= 18)) return "";
  const t = String(o.customerText ?? "");
  const hit = t.match(MGMT_TOPIC_RE);
  if (!hit) return "";
  return `\n【管理会社の営業時間外】今は${o.hour}時台（管理会社の営業時間外）。お客様が聞いた「${hit[0]}」等の管理会社にしか答えられない確認・交渉は、今は結果を持っていない＝AIX【物件確認した】で結果を送る番ではない。竹内さんの決まり（18時以降）: 確認の約束の返信（two_stage=check・「本日管理会社営業時間外の為、明日確認させて頂き、確認出来次第ご連絡」・土曜の夜は月曜）にして、結果は翌日 AIX【確認した】で送る。募集状況だけの確認はこの決まりの外（今すぐ確かめられる）`;
}
