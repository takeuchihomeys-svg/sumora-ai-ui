// app/lib/__tests__/pickup-fit-phrase.test.ts — 札の合う点が文に入ったかの網（2026-11-26 作業員A・#793）
//   実行: npx tsx app/lib/__tests__/pickup-fit-phrase.test.ts
import { fitInText, FIT_CODES } from "../pickup-fit-phrase";

let pass = 0, fail = 0;
const t = (name: string, ok: boolean) => { if (ok) { pass++; console.log(`  OK  ${name}`); } else { fail++; console.log(`  NG  ${name}`); } };
// 竹内さん本人の物件オススメの文の型（物件名は伏せた）
const rec = "リビング12.7帖・洋室4帖の1LDKで専有面積44.84㎡と広く快適にお過ごし頂けるお部屋の間取りとなります！！家賃管理費込138,000円と15万円以内に収まるお部屋となります！！インターネット無料・二口ガスコンロ・ペット飼育可能となります！！";
const r = fitInText(["FLOOR_PLAN_MATCH", "RENT_OK", "SQM_OK", "EQUIP_PET_OK", "EQUIP_WASHBASIN_OK", "AD_HIGH"], rec);
t("竹内さんの言い方: 間取り・予算に収まる・広さ・ペットは入った／独立洗面は書いていない", r.hit.join() === "FLOOR_PLAN_MATCH,RENT_OK,SQM_OK,EQUIP_PET_OK" && r.fit.length === 5);
t("スタッフだけの札（広告料）は数えない", !r.fit.includes("AD_HIGH"));
const box = "松屋町周辺全域から12万円程・綺麗めの1DK以上のオススメできるお部屋ピックアップさせて頂きました！！お手隙の際にご査収ください";
t("束の文は見出しだけ: 間取りは入る・敷金礼金なしは入らない", fitInText(["FLOOR_PLAN_MATCH", "ZERO_ZERO_MATCH"], box).hit.join() === "FLOOR_PLAN_MATCH");
t("箇条の型: 敷金礼金なし・築年数・駅徒歩・独立洗面", fitInText(["ZERO_ZERO_MATCH", "BUILDING_AGE_OK", "WALK_OK", "EQUIP_WASHBASIN_OK"], "・敷金礼金なし\n・2024年6月築で築年数浅く\n・「桜川」駅徒歩7分\n・独立洗面台").hit.length === 4);
t("網の札は合う点だけ（合わない点の札は無い）", FIT_CODES.every((c) => !/NOT|UNKNOWN|FAR|ASK|UNLISTED|^AD_|^SEARCH_/.test(c)));
console.log(`pickup-fit-phrase: ${pass} pass / ${fail} fail`);
process.exit(fail ? 1 : 0);
