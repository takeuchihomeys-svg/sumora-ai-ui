// app/lib/__tests__/waiting-commitment.test.ts
// 2026-09-18 竹内（𝒮❦ 事例）「この状況だとお客さんと約束して信頼関係を結ぶ形とする」
// 実行: npx tsx app/lib/__tests__/waiting-commitment.test.ts
import {
  resolveWaitingSituation, contactDateLabel, waitingContactLine, ensureWaitingCommitment,
  WAITING_COMMITMENT_RE, WAITING_DOOR_LINE, waitingCommitmentLabel,
} from "../waiting-commitment";

let pass = 0, fail = 0;
function t(name: string, cond: boolean, extra = "") {
  if (cond) { pass++; console.log(`  OK  ${name}`); }
  else { fail++; console.log(`  NG  ${name}${extra ? ` -- ${extra}` : ""}`); }
}
const NOW = "2026-09-18T11:30:00+09:00";

console.log("── 𝒮❦ 事例（本物の文）");
{
  const staff = "𝒮❦さん\nお世話になっております！！\n\n管理会社担当者に交渉させていただきましたが、お申込みから1ヶ月半が最長でのご入居設定日とのご回答でした！！\n11月中旬ごろのご入居の場合、9月末ごろにお申込みいただきますと11月中旬頃ご入居可能となります😊！！\n\nお手隙の際にご確認ください！！";
  const s = resolveWaitingSituation(staff, NOW);
  t("待ちの場面として拾える", !!s, JSON.stringify(s));
  t("「9月末ごろにお申込み」→ 9月30日", !!s && contactDateLabel(s) === "9月30日", s ? contactDateLabel(s) : "null");
  t("約束の1文が実送信どおり",
    !!s && waitingContactLine(s) === "9月30日に一度9月30日時点での募集状況をご連絡させて頂きます！！",
    s ? waitingContactLine(s) : "null");
  t("約束の文は自分の検出にかかる（必須要素と出口が同じ判定）",
    !!s && WAITING_COMMITMENT_RE.test(waitingContactLine(s)));
  t("指示に日付と元の言い回しが入る",
    !!s && waitingCommitmentLabel(s).includes("9月30日") && waitingCommitmentLabel(s).includes("お申込み"));
}

console.log("── 実データの他の言い回し（365日・22件から）");
{
  const cases: Array<[string, string]> = [
    ["管理会社に入居日の交渉させていただきましたが、お申込みから延ばせて40日間とのご返事でした。10月末ご入居希望ですと9/20日辺りでのお部屋お申込みで10月末ご入居可能です😊！！", "9月20日"],
    ["10月末ご入居ですと、お申込は9月末頃を目安にお申込頂く形となります！！", "9月30日"],
    ["会社審査から入居日決定のご返事まで1週間程猶予がございますので、9/16日辺りでお申込みいただくのをオススメいたします😊！！\nご入居希望に間に合います！！", "9月16日"],
    ["10/31日ご入居希望変わらずですと一度お部屋の審査キャンセルさせていただき、9月末ごろに再度お申込みという形となります！！", "9月30日"],
  ];
  for (const [staff, want] of cases) {
    const s = resolveWaitingSituation(staff, NOW);
    t(`「${staff.slice(0, 26)}…」→ ${want}`, !!s && contactDateLabel(s) === want, s ? contactDateLabel(s) : "null");
  }
}

console.log("── 待ちではない文では何もしない（安全側）");
{
  const notWaiting = [
    "8月1日ご入居でお申込みしお部屋抑えさせて頂きます！！",                       // もう申し込む（待ちではない）
    "S-RESIDENCE難波503号室10/1日ご入居でお申込させて頂きます！！",              // 同上
    "7/29入居希望でエスティメゾン南堀江 1103号室のお申込み進めさせて頂きます😊", // 同上
    "こちらのお部屋は9月末退去予定のため現地内覧は退去後となります！！",          // 申込の期日ではない
    "引き続き審査の進捗あり次第ご連絡させていただきます！！",                      // 期日が無い（従来の「〜次第」の担当）
    "お申込み手続きは土曜日も対応可能です😊！！",                                  // 日付が無い
    "",
  ];
  for (const s of notWaiting) t(`「${s.slice(0, 22)}…」→ 何もしない`, resolveWaitingSituation(s, NOW) === null);
  t("null / undefined でも落ちない",
    resolveWaitingSituation(null, NOW) === null && resolveWaitingSituation(undefined, NOW) === null);
}

console.log("── 月末の日数・年またぎ");
{
  const mk = (m: string) => `${m}にお申込みいただきますと翌月中旬頃ご入居可能となります！！`;
  t("2月末は28日（2026年）", contactDateLabel(resolveWaitingSituation(mk("2月末ごろ"), "2026-01-10T10:00:00+09:00")!) === "2月28日");
  t("4月末は30日", contactDateLabel(resolveWaitingSituation(mk("4月末ごろ"), "2026-03-10T10:00:00+09:00")!) === "4月30日");
  t("12月に「1月末」と言われたら翌年の1月（日付は同じ31日）",
    contactDateLabel(resolveWaitingSituation(mk("1月末ごろ"), "2026-12-20T10:00:00+09:00")!) === "1月31日");
  t("あり得ない日（2月31日）は拾わない",
    resolveWaitingSituation(mk("2月31日"), "2026-01-10T10:00:00+09:00") === null);
  t("全角数字も読める",
    contactDateLabel(resolveWaitingSituation(mk("９月末ごろ"), NOW)!) === "9月30日");
}

console.log("── 出口の差し込み（締めの前・二重にしない）");
{
  const s = resolveWaitingSituation("11月中旬ごろのご入居の場合、9月末ごろにお申込みいただきますと11月中旬頃ご入居可能となります😊！！", NOW)!;
  const light = "はい😊！！\nご確認頂きありがとうございます！！\n何卒よろしくお願い致します！！";
  const out = ensureWaitingCommitment(light, s);
  t("約束の文が入る", out.includes(waitingContactLine(s)), out);
  t("間の窓口の文も入る", out.includes(WAITING_DOOR_LINE));
  t("締めは最後のまま", out.trimEnd().endsWith("何卒よろしくお願い致します！！"), out);
  t("お礼の文は消さない", out.includes("ご確認頂きありがとうございます！！"));

  const already = "はい😊！！\n9月30日に一度9月30日時点での募集状況をご連絡させて頂きます！！\n引き続き何卒よろしくお願い致します！！";
  t("既に書けていれば二重にしない", ensureWaitingCommitment(already, s) === already);
  t("場面でなければ触らない", ensureWaitingCommitment(light, null) === light);
  t("空文には足さない", ensureWaitingCommitment("", s) === "");

  const noCloser = "はい😊！！\nご確認頂きありがとうございます！！";
  t("締めが無ければ末尾に足す", ensureWaitingCommitment(noCloser, s).trimEnd().endsWith(WAITING_DOOR_LINE));
}

console.log(`\n合計: ${pass}/${pass + fail}`);
if (fail > 0) process.exit(1);
