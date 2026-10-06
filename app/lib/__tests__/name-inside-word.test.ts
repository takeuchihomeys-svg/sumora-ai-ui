// app/lib/__tests__/name-inside-word.test.ts — 表示名の置き換えが語の途中を壊さない／壊れを決定論で見つける
// 実行: npx tsx app/lib/__tests__/name-inside-word.test.ts
// 2026-10-06 竹内（し 事例）「誤字が発生する原因　また発生してるって監視や最終チェックわかってるのになぜ編集されていないのか」
import { enforceCustomerName, replaceDisplayStandalone } from "../validate-reply";
import { detectNameInsideWord } from "../name-inside-word";
import { runDeterministicChecks } from "../final-check";
import { splitFinalCheckIssues } from "../final-check-scope";

let pass = 0, fail = 0;
const t = (name: string, ok: boolean, extra = "") => { if (ok) { pass++; console.log(`  OK  ${name}`); } else { fail++; console.log(`  NG  ${name} ${extra}`); } };

// 実物（10/06 17:46 の下書き）の壊れる前の形。表示名「し」・呼び名「角田」
const ORIGINAL = "かしこまりました！！\n松屋町周辺全域から12万円程・綺麗めのお部屋を角田さんにオススメできるよう新たにピックアップしてお送りさせて頂きます😊！！\n角田さんがご満足頂くお部屋が見つかるまでお部屋探し全力でサポートさせて頂きます😌！！";
const BROKEN = "か角田こまりま角田た！！\n松屋町周辺全域から12万円程・綺麗めのお部屋を角田さんにオススメできるよう新たにピックアップ角田てお送りさせて頂きます😊！！\n角田さんがご満足頂くお部屋が見つかるまでお部屋探角田全力でサポートさせて頂きます😌！！";
// 10/05 の壊れた下書き（実物）の元
const ORIGINAL2 = "はい😊！！\nご連絡お待ちしております！！\nお部屋お気に召されましたら、実際にお部屋ご案内させて頂きますのでいつでもお気軽にご連絡ください😌！！";

{
  const r = enforceCustomerName(ORIGINAL, { customerName: "角田", lineDisplayName: "し" });
  t("し 事例: 本文の「し」（かしこまりました・して・探し）を角田に替えない", r.cleaned === ORIGINAL, r.cleaned);
  const r2 = enforceCustomerName(ORIGINAL2, { customerName: "角田", lineDisplayName: "し" });
  t("し 事例（10/05）: 「お待ちしております」「召されましたら」を壊さない", r2.cleaned === ORIGINAL2, r2.cleaned);
  const r3 = enforceCustomerName("しさん\nお世話になっております！！", { customerName: "角田", lineDisplayName: "し" });
  t("表示名の呼びかけ「しさん」は呼び名「角田さん」に直す（今までどおり）", r3.cleaned.startsWith("角田さん\n"), r3.cleaned);
}
t("記号の表示名（H!tom!.M）は日本語の前でも置き換える", replaceDisplayStandalone("H!tom!.Mご希望のお部屋", "H!tom!.M", "山田").text === "山田ご希望のお部屋");
t("英字1文字の表示名「S」は SUUMO の中を置き換えない", replaceDisplayStandalone("SUUMOのお部屋", "S", "佐藤").count === 0);
t("絵文字の表示名は置き換える（端に字が無い）", replaceDisplayStandalone("🐥ご希望の", "🐥", "ひよ").text === "ひよご希望の");
t("漢字に挟まれた「し」も語の途中（お部屋探し全力）", replaceDisplayStandalone("お部屋探し全力で", "し", "角田").count === 0);

// 検出
t("壊れた下書きを見つける（か角田こ・ま角田た）", detectNameInsideWord(BROKEN, ["角田"]).length >= 2);
t("壊れていない文は見つけない（角田さん）", detectNameInsideWord(ORIGINAL, ["角田"]).length === 0);
t("登録名が敬称つき（黒明さん）でも名前だけで見る", detectNameInsideWord("確認させて頂き黒明さんにオススメ", ["黒明さん"]).length === 0);
t("ひらがなだけの名前は対象外（はる→はるか）", detectNameInsideWord("あはるかに", ["はる"]).length === 0);
t("1文字の名前は対象外（に関して）", detectNameInsideWord("ご希望に関して", ["関"]).length === 0);
{
  const issues = runDeterministicChecks(BROKEN, { customerName: "角田" } as Parameters<typeof runDeterministicChecks>[1]);
  const hit = issues.find((i) => i.code === "NAME_INSIDE_WORD");
  t("最終チェックの決定論で block（作り直しの対象）", hit?.severity === "block", JSON.stringify(hit));
  t("画面と作り直しに出す側（safety）に分類される", splitFinalCheckIssues(issues).shown.some((i) => i.code === "NAME_INSIDE_WORD"));
  const ok = runDeterministicChecks(ORIGINAL, { customerName: "角田" } as Parameters<typeof runDeterministicChecks>[1]);
  t("壊れていない文では出ない", !ok.some((i) => i.code === "NAME_INSIDE_WORD"));
}
console.log(`\n合計: ${pass}/${pass + fail}`); if (fail) process.exit(1);
