/** npx tsx app/lib/__tests__/city-all-wards.test.ts */
import assert from "node:assert/strict";
import { cityAllWards, isCityNameNotStation } from "../city-all-wards";

let n = 0;
function t(name: string, fn: () => void) {
  fn();
  n++;
  console.log("ok", name);
}

const KAE = "堺市・商店街近く";

t("堺市 → 7区", () => {
  assert.equal(cityAllWards("堺市", KAE)?.length, 7);
  assert.equal(cityAllWards("堺市内", "堺市内")?.length, 7);
});
t("堺市駅と書けば駅", () => {
  assert.equal(cityAllWards("堺市", "堺市駅の近く"), null);
  assert.equal(isCityNameNotStation("堺市", "堺市駅の近く"), false);
});
t("LLM の 堺市・堺 は駅にしない（audit #1521）", () => {
  assert.equal(isCityNameNotStation("堺市", KAE), true);
  assert.equal(isCityNameNotStation("堺", KAE), true);
  assert.equal(isCityNameNotStation("堺駅", KAE), true);
});
t("堺駅・別の駅は残す", () => {
  assert.equal(isCityNameNotStation("堺", "堺市・堺駅の近く"), false);
  assert.equal(isCityNameNotStation("三国ヶ丘", KAE), false);
  assert.equal(isCityNameNotStation("梅田", "梅田"), false);
});
t("堺市の区そのものは対象外（区のトークンで解決）", () => {
  assert.equal(cityAllWards("堺市北区", "堺市北区"), null);
});

console.log(`${n} passed`);
