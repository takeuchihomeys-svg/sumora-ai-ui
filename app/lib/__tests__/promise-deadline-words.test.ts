// app/lib/__tests__/promise-deadline-words.test.ts — 約束の期日の言葉の表（実行: npx tsx app/lib/__tests__/promise-deadline-words.test.ts [--table]）
import { chooseDeadlineWord, fromTrackerKind, DEADLINE_TABLE_SCENES, type PromiseWhenKind } from "../promise-deadline-words";
import { TIME_FACTS_FORBIDDEN_RE } from "../time-facts";

let pass = 0, fail = 0;
const t = (n: string, ok: boolean, info?: unknown) => { if (ok) pass++; else { fail++; console.log(`  NG ${n} → ${JSON.stringify(info)}`); } };
const at = (iso: string) => Date.parse(iso);
const w = (kind: PromiseWhenKind, iso: string, extra: Record<string, unknown> = {}) => chooseDeadlineWord({ kind, nowMs: at(iso), ...extra });

const THU10 = "2026-11-12T10:00:00+09:00", THU17 = "2026-11-12T17:00:00+09:00", THU1830 = "2026-11-12T18:30:00+09:00", THU2110 = "2026-11-12T21:10:00+09:00";
const FRI20 = "2026-11-13T20:00:00+09:00", SAT12 = "2026-11-14T12:00:00+09:00", SUN12 = "2026-11-15T12:00:00+09:00", HOL12 = "2026-11-23T12:00:00+09:00", THU07 = "2026-11-12T07:00:00+09:00";

// ピックアップ・新着待ち: どの時刻でも期日を言い切らない
for (const iso of [THU10, THU1830, SAT12, THU2110]) {
  t(`pickup は出来次第（${iso.slice(5, 16)}）・本日中を出さない`, w("pickup", iso).word === "出来次第" && !/本日中|明日/.test(w("pickup", iso).phrase), w("pickup", iso));
  t(`new_arrival は新着で募集に出次第（${iso.slice(5, 16)}）`, w("new_arrival", iso).word === "新着で募集に出次第");
}
// 見積書: 平日16時前の自社の作業だけ本日中に
t("見積書 平日10時: 本日中に（mid）", w("estimate", THU10).word === "本日中に" && w("estimate", THU10).confidence === "mid");
t("見積書 平日17時: 出来次第（本日中に言い切らない）", w("estimate", THU17).word === "出来次第");
t("見積書 土曜: 出来次第", w("estimate", SAT12).word === "出来次第");
t("見積書 夜: 出来次第", w("estimate", THU2110).word === "出来次第");
// 募集状況の確認（ネットで確かめられる）: 21時より前は確認出来次第・21時以降は明日一番に
t("募集状況 平日10時: 確認出来次第（high）", w("check_vacancy", THU10).word === "確認出来次第" && w("check_vacancy", THU10).confidence === "high");
t("募集状況 18:30: 確認出来次第・営業時間の一言なし（KB 5fe999f8）", w("check_vacancy", THU1830).word === "確認出来次第" && w("check_vacancy", THU1830).prefix === null && !/営業時間/.test(w("check_vacancy", THU1830).phrase), w("check_vacancy", THU1830));
t("募集状況 21:10: 明日一番に", w("check_vacancy", THU2110).word === "明日一番に");
t("募集状況 土曜昼: 確認出来次第だが確かさ mid", w("check_vacancy", SAT12).word === "確認出来次第" && w("check_vacancy", SAT12).confidence === "mid");
// 管理会社にしか答えられない確認・交渉
t("管理会社の確認 平日10時: 確認出来次第（本日中に言い切らない）", w("check_mgmt", THU10).word === "確認出来次第" && !/本日中/.test(w("check_mgmt", THU10).phrase));
t("管理会社の確認 18:30（木）: 本日管理会社営業時間外の為、明日（台帳の穴）", w("check_mgmt", THU1830).word === "明日一番に" && w("check_mgmt", THU1830).prefix === "本日管理会社営業時間外の為、" && /^本日管理会社営業時間外の為、明日確認させて頂き、確認出来次第ご連絡させて頂きます$/.test(w("check_mgmt", THU1830).phrase), w("check_mgmt", THU1830));
t("交渉 18:30（木）: 明日交渉させて頂き（KB 9fd703f4 の形）", /^本日管理会社営業時間外の為、明日交渉させて頂き、確認出来次第ご連絡させて頂きます$/.test(w("negotiate", THU1830).phrase), w("negotiate", THU1830).phrase);
t("管理会社の確認 金曜20時: 翌営業日は月曜＝明日と言い切らない・営業開始次第", w("check_mgmt", FRI20).word === "営業開始次第" && w("check_mgmt", FRI20).prefix === "本日管理会社営業時間外の為、" && w("check_mgmt", FRI20).confidence === "mid", w("check_mgmt", FRI20));
t("管理会社の確認 土曜: お休みのため・営業開始次第", w("check_mgmt", SAT12).prefix === "本日管理会社がお休みのため、" && w("check_mgmt", SAT12).word === "営業開始次第");
t("管理会社の確認 日曜: 翌日が月曜＝お休みのため・明日一番に（mid）", w("check_mgmt", SUN12).word === "明日一番に" && w("check_mgmt", SUN12).prefix === "本日管理会社がお休みのため、" && w("check_mgmt", SUN12).confidence === "mid", w("check_mgmt", SUN12));
t("管理会社の確認 祝日（11/23）: 翌日が火曜＝お休みのため", w("check_mgmt", HOL12).prefix === "本日管理会社がお休みのため、", w("check_mgmt", HOL12));
t("管理会社の確認 朝7時: 営業開始次第（一言なし）", w("check_mgmt", THU07).word === "営業開始次第" && w("check_mgmt", THU07).prefix === null);
// 〇時頃はスタッフが時刻を入れた時だけ
t("〇時頃: スタッフが入力した時だけ", w("check_mgmt", THU10, { staffGivenHour: 15 }).word === "〇時頃" && /15時頃/.test(w("check_mgmt", THU10, { staffGivenHour: 15 }).phrase) && w("check_mgmt", THU10).word !== "〇時頃");
// 言葉は全部事実と文の骨格・道の言葉（AIX・返信する）を含まない
const all: string[] = [];
for (const k of ["pickup", "new_arrival", "check_vacancy", "check_mgmt", "negotiate", "estimate"] as PromiseWhenKind[]) for (const s of DEADLINE_TABLE_SCENES) { const c = chooseDeadlineWord({ kind: k, nowMs: at(s.iso) }); all.push(c.phrase, ...c.basis); }
t("表の全部に道の言葉（AIX・返信する・選ぶ）が無い", all.every((x) => !/AIX|選ぶ|返信(?:する|で)/.test(x)) && all.every((x) => !TIME_FACTS_FORBIDDEN_RE.test(x.replace(/約束(?:して|する)/g, ""))));
t("言い切りの日付（11/13 など）を作らない", all.every((x) => !/[0-9]{1,2}\/[0-9]{1,2}/.test(x.replace(/KB [0-9a-f]+|[0-9]+\/[0-9]+ の|10\/26|11\/04/g, ""))));
// 本日中には見積書以外に出ない
t("本日中にを出すのは見積書の平日16時前だけ", (["pickup", "new_arrival", "check_vacancy", "check_mgmt", "negotiate"] as PromiseWhenKind[]).every((k) => DEADLINE_TABLE_SCENES.every((s) => chooseDeadlineWord({ kind: k, nowMs: at(s.iso) }).word !== "本日中に")));
// 種類の名前の入口
t("promise-tracker の種類との対応", fromTrackerKind("物件探し") === "pickup" && fromTrackerKind("見積書") === "estimate" && fromTrackerKind("交渉") === "negotiate" && fromTrackerKind("確認") === "check_vacancy" && fromTrackerKind("確認", { mgmtOnly: true }) === "check_mgmt" && fromTrackerKind("ご連絡") === null && fromTrackerKind(null) === null);

if (process.argv.includes("--table")) {
  for (const s of DEADLINE_TABLE_SCENES) {
    console.log(`■ ${s.label}`);
    for (const k of ["pickup", "new_arrival", "check_vacancy", "check_mgmt", "negotiate", "estimate"] as PromiseWhenKind[]) { const c = chooseDeadlineWord({ kind: k, nowMs: at(s.iso) }); console.log(`  ${k.padEnd(13)} ${c.word}（${c.confidence}）${c.prefix ? `［${c.prefix}］` : ""} ${c.phrase}`); }
  }
}
console.log(`pass ${pass} / fail ${fail}`);
process.exit(fail ? 1 : 0);
