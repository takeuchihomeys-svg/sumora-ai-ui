import { customerNameTokens, maskCustomerNames } from "../compose-name-mask";
const tk = customerNameTokens(["山田 ともき", "ともき"]);
const a = maskCustomerNames("ともきさんよろしければご都合よろしいお日にちにご案内させて頂きます！！最大限割引させて頂きます", tk);
const b = maskCustomerNames("山田様の件、山田ともきさん", tk);
const ok = a === "YUMAさんよろしければご都合よろしいお日にちにご案内させて頂きます！！最大限割引させて頂きます" && b === "YUMA様の件、YUMAさん"
  && maskCustomerNames("出さんの件", customerNameTokens(["出"])) === "YUMAさんの件" && maskCustomerNames("出来ます", customerNameTokens(["出"])) === "出来ます";
console.log(ok ? "compose-name-mask: pass" : "compose-name-mask: FAIL " + JSON.stringify({ a, b }));
if (!ok) process.exit(1);
import { staffHeadNames } from "../compose-name-mask";
{
  const h = staffHeadNames(["AKANEさんお世話になっております！！", "こちらさん", "かしこまりました！！\nAKANEさん", "鈴木さんへ", "  いしのさん、はじめまして"]);
  const ok = h.join() === "AKANE,いしの";
  console.log(ok ? "staff-head-names: pass" : "staff-head-names: FAIL " + h.join()); if (!ok) process.exit(1);
}
{
  // 2026-11-04 版 20261104b: 飾り文字の表示名・英字の表示名の大文字小文字・英字の続き
  const t1 = customerNameTokens(["𝚂𝚊𝚗𝚊."]);
  const a1 = maskCustomerNames("𝚂𝚊𝚗𝚊.さんお世話になっております！！", t1);
  const t2 = customerNameTokens(["satoko"]);
  const a2 = maskCustomerNames("新着で1件SATOKOさんにかなり", t2);
  const t3 = customerNameTokens(["takeo1022"]);
  const a3 = maskCustomerNames("こちらにtakeoさんご希望条件", t3);
  const t4 = customerNameTokens(["it_77"]);
  const a4 = maskCustomerNames("itさんご都合よろしい日 it is", t4);
  const a5 = maskCustomerNames("Takeoverさん", t3);
  const ok = a1 === "YUMAさんお世話になっております！！" && a2 === "新着で1件YUMAさんにかなり" && a3 === "こちらにYUMAさんご希望条件" && a4 === "YUMAさんご都合よろしい日 it is" && a5 === "Takeoverさん";
  console.log(ok ? "compose-name-mask 20261104b: pass" : "compose-name-mask 20261104b: FAIL " + JSON.stringify({ a1, a2, a3, a4, a5 }));
  if (!ok) process.exit(1);
}
{
  // 2026-11-04 版 20261104c: 伏せた後に英字の「〇〇さん」が残るか
  const { leftLatinName } = require("../compose-name-mask");
  const ok = leftLatinName("全域からMATUMOTOさんのご希望") === true && leftLatinName("YUMAさんお世話になっております") === false && leftLatinName("大阪さんの件") === false;
  console.log(ok ? "left-latin-name: pass" : "left-latin-name: FAIL"); if (!ok) process.exit(1);
}
