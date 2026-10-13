// app/lib/__tests__/ack-form-takeuchi.test.ts — 了承への返事の長さ・形（竹内さんの実送信）・本質の字数切り（2026-10-13 区切り2）
//   実行: npx tsx app/lib/__tests__/ack-form-takeuchi.test.ts
import { ackLengthGuide, patternYDoLine, curatedPickupAckRule, pickupAckLengthPhrase, knowledgeHeading, closeOnlyShape } from "../ack-form-takeuchi";
import { clipAtBoundary } from "../turn-contract";
let pass = 0, fail = 0;
const t = (name: string, ok: boolean) => { if (ok) { pass++; console.log(`  OK  ${name}`); } else { fail++; console.log(`  NG  ${name}`); } };
const ON = { ACK_FORM_TAKEUCHI: "on", TURN_CONTRACT_CLIP_BOUNDARY: "on" }, OFF = { ACK_FORM_TAKEUCHI: "off", KNOWLEDGE_HEADING_FORM: "off", TURN_CONTRACT_CLIP_BOUNDARY: "off" };

console.log("① 了承への返事");
t("長さの目安は3行・竹内さんの形", /3行/.test(ackLengthGuide(ON)) && /何卒よろしくお願い致します/.test(ackLengthGuide(ON)));
t("戻すと旧の2行", ackLengthGuide(OFF) === "承認・了解→2行");
t("既定は off（試しで悪くなった）", ackLengthGuide({}) === "承認・了解→2行");
t("パターンY は 2〜3行・待ちの形", /2〜3行/.test(patternYDoLine(ON)) && /2行以内/.test(patternYDoLine(OFF)));
t("確認済みルール: 待ちの形の1文を許し、言い切りと3回目は書かない", /ピックアップ出来次第お送りさせて頂きますので/.test(curatedPickupAckRule(ON)) && /3回目/.test(curatedPickupAckRule(ON)) && /再宣言も書かない/.test(curatedPickupAckRule(OFF)));
t("返事の要らない番も真ん中の1文（決定 3696fe20）", /真ん中の1文/.test(closeOnlyShape(ON)) && /締めだけ/.test(closeOnlyShape(OFF)));
t("旧ノートの長さ", pickupAckLengthPhrase(ON).startsWith("2〜3行") && pickupAckLengthPhrase(OFF).startsWith("2行以内"));

console.log("② ナレッジの見出し（本質＞学習ルール＝形）");
t("本質がある番: 差分学習の見出しから「最優先・必ず守る」を外す", !/最優先/.test(knowledgeHeading("diff", ON, true)) && /最優先・必ず守る/.test(knowledgeHeading("diff", OFF, true)));
t("本質がある番: 絶対ルールの見出しは安全の線は守る・中身は本質", /安全の線/.test(knowledgeHeading("critical", ON, true)) && /本質/.test(knowledgeHeading("critical", ON, true)) && knowledgeHeading("critical", OFF, true) === "【⚠️ 絶対ルール】");
t("本質が無い番（夜の見送り・古い判断）は旧の見出しのまま", knowledgeHeading("critical", ON, false) === "【⚠️ 絶対ルール】" && /最優先・必ず守る/.test(knowledgeHeading("diff", ON, false)) && knowledgeHeading("critical", ON) === "【⚠️ 絶対ルール】");
for (const w of ["嘘", "個人情報", "金額", "空き/退去日", "内覧の確定", "審査の結果/期間", "キャンセル料", "送ってはいけない物", "虚偽への加担"]) t(`安全の線に「${w}」`, knowledgeHeading("critical", ON, true).includes(w) && knowledgeHeading("diff", ON, true).includes(w));

console.log("③ 本質の字数切りを文の区切りで");
t("短い時はそのまま", clipAtBoundary("駐車場空いてますか", 40, ON) === "駐車場空いてますか");
t("文の途中で切らない（区切りで）", clipAtBoundary("オンライン内見をご提案、室内の撮影もさせて頂く", 20, ON) === "オンライン内見をご提案");
t("区切りが無ければ旧の slice", clipAtBoundary("あいうえおかきくけこさしすせそたちつてとなにぬねのはひふへほまみむめもや", 30, ON).length === 30);
t("戻すと旧の slice", clipAtBoundary("オンライン内見をご提案、室内の撮影もさせて頂く", 10, OFF) === "オンライン内見をご提");

console.log(`\n${pass} OK / ${fail} NG`);
if (fail) process.exit(1);
