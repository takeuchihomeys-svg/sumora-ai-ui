// npx tsx app/lib/__tests__/aix-family.test.ts
// 2026-11-22 作業員K2（台帳 #313）: AIX の系統の名前を1か所に（AIX_FAMILY_ONE・既定 off）
import assert from "node:assert/strict";
import { aixFamilyOf, aixFamilyOneOn } from "../aix-family";
import { aixContentFamily } from "../line-watch-judge";
import { aixFamily as yardFamily } from "../../../scripts/lib/prod-yardstick-db";

let n = 0;
const t = (name: string, f: () => void) => { f(); n++; console.log("ok", name); };
const KEYS = ["property_send", "property_recommendation", "property_search", "zenryoku_support", "property_check_result", "acknowledge_check", "guarantor_info", "estimate_sheet", "cost_explain", "cost_breakdown", "viewing_invite", "meeting_place", "phone_call", "condition_hearing", "greeting_viewing"];
t("既定 off", () => { assert.equal(aixFamilyOneOn({}), false); assert.equal(aixFamilyOneOn({ AIX_FAMILY_ONE: "on" }), true); });
t("見張りの系統と同じ答え（見張りが系統に入れる種類・入れない種類とも）", () => { for (const k of KEYS) assert.equal(aixFamilyOf(k), aixContentFamily(k), k); });
t("物差しだけにあった 申込 を足す・ピッカー付きの鍵も読む", () => { assert.equal(aixFamilyOf("application_push"), "申込"); assert.equal(aixFamilyOf("property_check_result/available"), "確認"); });
t("物差しは off の時は今まで通り（見積・サポート）・on の時は見張りと同じ（費用・物件）", () => {
  const prev = process.env.AIX_FAMILY_ONE;
  delete process.env.AIX_FAMILY_ONE;
  assert.equal(yardFamily("estimate_sheet"), "見積"); assert.equal(yardFamily("zenryoku_support"), "サポート"); assert.equal(yardFamily(null), "返信");
  process.env.AIX_FAMILY_ONE = "on";
  assert.equal(yardFamily("estimate_sheet"), "費用"); assert.equal(yardFamily("zenryoku_support"), "物件"); assert.equal(yardFamily("guarantor_info"), "確認"); assert.equal(yardFamily(null), "返信");
  if (prev === undefined) delete process.env.AIX_FAMILY_ONE; else process.env.AIX_FAMILY_ONE = prev;
});
console.log(`${n} ok`);
