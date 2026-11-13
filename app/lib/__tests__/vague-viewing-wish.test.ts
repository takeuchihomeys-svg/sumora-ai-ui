// ふわっとした内覧の希望の読み（2026-11-14 作業員B・q427）。実行: npx tsx app/lib/__tests__/vague-viewing-wish.test.ts
import { isVagueViewingWish, sentRoomNames, viewingRoomNamed, ASK_ROOM_RE } from "../vague-viewing-wish";
let pass = 0, fail = 0;
const t = (name: string, ok: boolean, extra: unknown = "") => { if (ok) { pass++; console.log(`  OK  ${name}`); } else { fail++; console.log(`  NG  ${name}`, extra); } };
// 実物（名前は伏せた）: q427 の番と竹内さんの送信
t("q427「後内とかもしたいです」は日時の無い内覧の希望（「とかもしたい」の『もし』を仮定と読まない）", isVagueViewingWish("返事が遅くなりすいません！\n初期費用はカードで決済できますか？\n後内とかもしたいです"));
t("「見学とかは可能でしょうか？」も同じ", isVagueViewingWish("見学とかは可能でしょうか？"));
t("日時の語があれば別の場面", !isVagueViewingWish("来週の木曜日は内見したいです") && !isVagueViewingWish("明日内覧できますか"));
t("仮定の内覧は希望にしない", !isVagueViewingWish("もし埋まらなければ内見したいです"));
const names = sentRoomNames(["【プレジオ阿波座9-15F 1308号室】\n初期費用さらに", "🌟ウスヰマンション 202号室\n\n（オススメポイント）"]);
t("送ったお部屋の名前を取る", names.includes("プレジオ阿波座9-15F") && names.includes("ウスヰマンション"), names);
t("q427 の番はお部屋の名前を言っていない", !viewingRoomNamed("後内とかもしたいです", names));
t("名前があれば特定あり", viewingRoomNamed("ウスヰマンション内見お願いします", names) && viewingRoomNamed("プレジオ阿波座の内覧したいです", names));
t("竹内さんの部屋を聞く形", ASK_ROOM_RE.test("お部屋のご案内も可能です！！\nお気に召されましたお部屋ご教授いただけましたらお部屋のご案内可否も確認させて頂きます😊！！"));
t("候補の日時を送る形は部屋を聞く形ではない", !ASK_ROOM_RE.test("かしこまりました！！ お部屋ご案内させて頂きます！！ 直近ですと 10/16(金) 12:00〜15:00 にてご案内可能です！！"));
console.log(`\n${pass} passed, ${fail} failed`);
if (fail) process.exit(1);
