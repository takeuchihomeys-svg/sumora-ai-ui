// app/lib/estimate-image-role.ts の単体テスト（DB も LLM も使わない）
// 実行: npx tsx --test app/lib/__tests__/estimate-image-role.test.ts
import { test } from "node:test";
import assert from "node:assert/strict";
import { estimateImageRoleOn, estimateRoleUrls, estimateRoleRows } from "../estimate-image-role";

const CONV = "0a1b2c3d-1111-2222-3333-444455556666";
const own = (n: string) => `https://example.supabase.co/storage/v1/object/public/property-images/aix/${CONV}/1763500000000_${n}.jpg`;

test("既定 on（11/19）・off で止まる", () => {
  assert.equal(estimateImageRoleOn({}), true);
  assert.equal(estimateImageRoleOn({ AIX_ESTIMATE_IMAGE_ROLE: "on" }), true);
  assert.equal(estimateImageRoleOn({ AIX_ESTIMATE_IMAGE_ROLE: "off" }), false);
});

test("物件確認した: 物件の並びと同じ配列（見積書の無い物件は null）から、見積書の URL だけ", () => {
  const urls = estimateRoleUrls({ estimate_image_urls: [own("a"), null, own("b")] }, CONV);
  assert.deepEqual(urls, [own("a"), own("b")]);
});

test("1枚の estimate_image_url も・重複は1つ", () => {
  assert.deepEqual(estimateRoleUrls({ estimate_image_urls: [own("a")], estimate_image_url: own("a") }, CONV), [own("a")]);
  assert.deepEqual(estimateRoleUrls({ estimate_image_url: own("c") }, CONV), [own("c")]);
});

test("この会話のためにアップロードした画像だけ（会話の中の画像・別の会話・お客様の画像は書かない）", () => {
  const other = own("x").replace(CONV, "99999999-1111-2222-3333-444455556666");
  const customer = "https://example.supabase.co/storage/v1/object/public/line-images/customer/abc.jpg";
  const sentBefore = "https://example.supabase.co/storage/v1/object/public/property-images/messages/abc.jpg";
  assert.deepEqual(estimateRoleUrls({ estimate_image_urls: [other, customer, sentBefore, "http://x/aix/" + CONV + "/a.jpg"] }, CONV), []);
});

test("会話が無ければ書かない・最大10", () => {
  assert.deepEqual(estimateRoleUrls({ estimate_image_urls: [own("a")] }, null), []);
  const many = Array.from({ length: 14 }, (_, i) => own(`m${i}`));
  assert.equal(estimateRoleUrls({ estimate_image_urls: many }, CONV).length, 10);
});

test("行は kind=estimate・lines は空（既存の見積書の行と同じ形）", () => {
  const rows = estimateRoleRows([own("a")], CONV);
  assert.deepEqual(rows, [{ image_url: own("a"), conversation_id: CONV, kind: "estimate", lines: [], model: "role:aix-estimate" }]);
});
