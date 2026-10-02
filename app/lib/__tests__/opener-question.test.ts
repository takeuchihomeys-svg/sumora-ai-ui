// app/lib/__tests__/opener-question.test.ts — 2026-10-02 夜 竹内さん「かしこまりましたとか違う」（ゆいと・スモラの実物）
//   実行: npx tsx app/lib/__tests__/opener-question.test.ts
import { isYesNoConfirmQuestion } from "../opener-question";
import { enforceOpener } from "../greeting";
let pass = 0, fail = 0;
const t = (name: string, ok: boolean, extra = "") => { if (ok) { pass++; console.log(`  OK  ${name}`); } else { fail++; console.log(`  NG  ${name} ${extra}`); } };
t("確かめの質問: 内見はできない感じってことですかね？", isYesNoConfirmQuestion("内見はできない感じってことですかね？"));
t("確かめの質問: 〜ないですよね💦", isYesNoConfirmQuestion("ペットおっけ、8.5までの家賃で1dkはやっぱりないですよね💦"));
for (const s of ["ワンルームですと他にあったりしますか?", "本日電話いける時間ありますか？", "11時50分着くらいになりますが大丈夫でしょうか？"]) t(`確かめの質問ではない（依頼・打診）: ${s}`, !isYesNoConfirmQuestion(s));
const d = { opener: "none" as const, openerAllowed: ["none", "kashikomari", "hai"] as ("none" | "kashikomari" | "hai")[], openerBodyRule: true, openerStrict: false, openerConfirmQuestion: true };
const real = "かしこまりました！！\n退去前のため室内の内覧はできないのですが、建物の外観や共用部・周辺環境は現地でご確認いただけます😊\n室内は退去後にご案内可能となりますので、お気に召されましたらお申込みでお部屋を先に押さえてからご内覧頂くことも可能です！！";
const out = enforceOpener(real, d);
t("実物: かしこまりました を外して本題から", out.rest.startsWith("退去前のため"), out.rest.slice(0, 20));
const undertake = "かしこまりました！！\n京都周辺全域からあさみさんのご条件に合ったお部屋をピックアップさせて頂きます！！";
t("引き受けの本文（ピックアップ）は かしこまりました を残す（人の実送信の形）", enforceOpener(undertake, d).rest === undertake);
t("確かめの質問でない時は今まで通り", enforceOpener(undertake, { ...d, openerConfirmQuestion: false }).rest === undertake);
console.log(`\n合計: ${pass}/${pass + fail}`); if (fail) process.exit(1);
