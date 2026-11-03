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
