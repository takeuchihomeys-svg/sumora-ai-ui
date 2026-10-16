// app/lib/__tests__/short-name-mask.test.ts — 短い名前（1〜2字）で本文の字が名前に置き換わらないこと
// 実行: npx tsx app/lib/__tests__/short-name-mask.test.ts
// 2026-10-16 短い名前の点検（し 事例「か〇〇こまりま〇〇た」の再点検）:
//   ・名前の読み替え（pii-pseudonym）: 1〜2字の名前は敬称つきの時だけ伏せる → 本文の「し」「の」は触らない・往復で元に戻る
//   ・出口の名前直し（validate-reply.enforceCustomerName）: 短い表示名は敬称なしの所では置き換えない（「㎡の1LDK」「J’S Garden」）、
//     敬称つきでも左隣が同じ字の種類（「たかしさん」「ゆりあさん」）なら別の名前の一部として触らない
import { enforceCustomerName, replaceDisplayStandalone } from "../validate-reply";
import { createMasker } from "../pii-pseudonym";

let pass = 0, fail = 0;
const t = (name: string, ok: boolean, extra = "") => { if (ok) { pass++; console.log(`  OK  ${name}`); } else { fail++; console.log(`  NG  ${name} ${extra}`); } };

const BODY = "かしこまりました！！\nお部屋探し全力でサポートさせて頂きます😊！！\nアパートの42.75㎡の1LDK・阿倍野8の202号室・J’S Garden・S-FORT大今里もピックアップしてお送りします！！\nご連絡お待ちしております😌！！";

// ── 出口の名前直し ──
for (const disp of ["し", "の", "て", "ア", "S", "まし", "して", "田"]) {
  const r = enforceCustomerName(BODY, { customerName: "山本", lineDisplayName: disp });
  t(`表示名「${disp}」: 敬称の無い本文の字を呼び名に替えない`, r.cleaned === BODY, r.cleaned.slice(0, 80));
}
t("表示名「し」: 呼びかけ（行頭の「しさん」）は呼び名に直す",
  enforceCustomerName("しさん\nお世話になっております！！", { customerName: "山本", lineDisplayName: "し" }).cleaned.startsWith("山本さん"));
t("表示名「し」: 助詞の後の呼びかけ（本日はしさんに）は直す",
  enforceCustomerName("本日はしさんにオススメのお部屋です！！", { customerName: "山本", lineDisplayName: "し" }).cleaned === "本日は山本さんにオススメのお部屋です！！");
t("表示名「し」: 別の名前の一部（たかしさん）は触らない",
  enforceCustomerName("たかしさん\nお世話になっております！！", { customerName: "山本", lineDisplayName: "し" }).cleaned.startsWith("たかしさん"));
t("表示名「あ」: 別の名前の一部（ゆりあさん・みにあさん）は触らない",
  enforceCustomerName("ゆりあさんとみにあさんにオススメです！！", { customerName: "山本", lineDisplayName: "あ" }).cleaned === "ゆりあさんとみにあさんにオススメです！！");
t("表示名「S」: 呼びかけ（何よりもSさんと）は直す",
  enforceCustomerName("何よりもSさんとご家族様が", { customerName: "山本", lineDisplayName: "S" }).cleaned === "何よりも山本さんとご家族様が");
t("短い表示名は敬称なしの所を置き換えない（の・S）",
  replaceDisplayStandalone("42.75㎡の1LDK", "の", "山本").count === 0 && replaceDisplayStandalone("J’S Garden", "S", "山本").count === 0);
t("長い表示名は語の外なら今まで通り置き換える",
  replaceDisplayStandalone("H!tom!.Mご希望のお部屋", "H!tom!.M", "山田").text === "山田ご希望のお部屋");
t("絵文字の表示名は今まで通り置き換える", replaceDisplayStandalone("🐥ご希望の", "🐥", "ひよ").text === "ひよご希望の");
t("字と絵文字が混じる2字の表示名（a🤫）は今まで通り置き換える", replaceDisplayStandalone("ご案内です。a🤫ご希望の", "a🤫", "山本").count === 1);
t("長い表示名の呼びかけは左隣が日本語でも呼び名に直す（沿線からミナト★さん）", enforceCustomerName("沿線からミナト★さんご希望の", { customerName: "山本", lineDisplayName: "ミナト★" }).cleaned === "沿線から山本さんご希望の");

// ── 名前の読み替え（DeepSeek に渡す前に伏せて、出口で戻す） ──
for (const party of ["し", "の", "ア", "田", "はる", "まし", "ユキ"]) {
  const m = createMasker({ conversationId: "short-name-test", customerName: party, knownNames: ["し", "の", "他人太郎"] });
  const src = `${party}さん\n${BODY}`;
  const masked = m.maskBlock(src);
  const fake = m.table().find((e) => e.reversible)?.fake ?? "";
  t(`当事者「${party}」: 呼びかけは仮名に伏せる`, !!fake && masked.startsWith(`${fake}さん`), masked.slice(0, 20));
  t(`当事者「${party}」: 敬称の無い本文は伏せない（本文がそのまま）`, masked === `${fake}さん\n${BODY}`, masked.slice(0, 80));
  t(`当事者「${party}」: 往復で元に戻る`, m.unmask(masked) === src);
  // LLM の返答（本文に「し」「の」が普通に出る）を戻しても、本文の字が名前にならない
  const reply = `${fake}さん\nかしこまりました！！ピックアップしてお送りします😊！！`;
  t(`当事者「${party}」: 戻す側で本文の字を名前に替えない`, m.unmask(reply) === `${party}さん\nかしこまりました！！ピックアップしてお送りします😊！！`, m.unmask(reply));
  t(`当事者「${party}」: 戻し残しなし`, m.leftovers(m.unmask(reply)).length === 0);
}
{
  // 他のお客様の1字の名前（「し」）は、敬称つきの時だけ「〇〇」に伏せる（本文の「し」は伏せない＝文が壊れない）
  const m = createMasker({ conversationId: "short-name-test", customerName: "山本", knownNames: ["し"] });
  const out = m.maskBlock("しさんの事例: かしこまりました");
  t("他のお客様「し」: 敬称つきだけ伏せる", out === "〇〇さんの事例: かしこまりました", out);
}

console.log(`\n合計: ${pass}/${pass + fail}`);
if (fail) process.exit(1);
