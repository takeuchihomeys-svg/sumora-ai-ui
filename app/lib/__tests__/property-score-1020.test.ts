// 物件の点付けの直し（2026-10-20 竹内さん）: ペットの希望の向き（owner-fb:1020-pet-score）・リノベーション物件の築年（owner-fb:1020-renov-age）
// 実行: npx tsx app/lib/__tests__/property-score-1020.test.ts
import { parseEquipmentWants, parseListingEquipment, matchEquipment, petWantOverride, petWantFixEnabled } from "../listing-equipment";
import { renovatedAgeOk, renovAgeFixEnabled } from "../property-brain";

let passed = 0, failed = 0;
function it(name: string, fn: () => void) {
  try { fn(); passed++; console.log(`  ✓ ${name}`); }
  catch (e) { failed++; console.log(`  ✗ ${name}\n      ${e instanceof Error ? e.message : String(e)}`); }
}
function eq<T>(a: T, b: T, label = "") { if (JSON.stringify(a) !== JSON.stringify(b)) throw new Error(`${label} expected ${JSON.stringify(b)} but got ${JSON.stringify(a)}`); }
const withEnv = (k: string, v: string | undefined, fn: () => void) => { const old = process.env[k]; if (v == null) delete process.env[k]; else process.env[k] = v; try { fn(); } finally { if (old == null) delete process.env[k]; else process.env[k] = old; } };
const petWants = (c: Record<string, unknown>) => parseEquipmentWants(c as never).wants.filter((w) => w.key === "pet").map((w) => w.mode);

console.log("切替（既定 off）");
it("どちらも既定 off・on で入る", () => {
  eq(petWantFixEnabled({}), false); eq(petWantFixEnabled({ PROPERTY_PET_WANT_1020: "on" }), true);
  eq(renovAgeFixEnabled({}), false); eq(renovAgeFixEnabled({ PROPERTY_RENOV_AGE_1020: "ON" }), true);
});

console.log("ペットの希望の向き（実データ 361人で ng になった3人のうち2人が読み違い）");
it("off は今まで通り（NG欄の「ペット不可」は ng）", () => withEnv("PROPERTY_PET_WANT_1020", undefined, () => {
  eq(petWants({ ng_points: "1階NG、ペット不可" }), ["ng"]);
}));
it("on: NG欄の「ペット不可」＝ペット不可の物件が NG＝ペット飼育可能を望む（must）", () => withEnv("PROPERTY_PET_WANT_1020", "on", () => {
  eq(petWants({ ng_points: "1階NG、ペット不可" }), ["must"]);
}));
it("on: 「ペット不可でも可」はこだわらない＝希望にしない", () => withEnv("PROPERTY_PET_WANT_1020", "on", () => {
  eq(petWants({ ng_points: "ペット不可でも可" }), []);
}));
it("on: 「ペット可NG」はそのまま ng（ペットのいる建物を避けたい）", () => withEnv("PROPERTY_PET_WANT_1020", "on", () => {
  eq(petWants({ ng_points: "ペット可NG" }), ["ng"]);
}));
it("on: 「ペット なし」（空白入り）は自分が飼っていない話＝希望にしない（off は must に割れていた）", () => {
  withEnv("PROPERTY_PET_WANT_1020", undefined, () => eq(petWants({ preferences: "ペット なし" }), ["must"]));
  withEnv("PROPERTY_PET_WANT_1020", "on", () => eq(petWants({ preferences: "ペット なし" }), []));
});
it("on: ペット相談（小型犬、猫可）の物件は、NG欄の「ペット不可」の人に ○（ワールドアイ京町堀 204 の形）", () => withEnv("PROPERTY_PET_WANT_1020", "on", () => {
  const facts = parseListingEquipment("設備: エアコン ペット相談（小型犬、猫可）\n備考: ■ペット飼育時は賃料+3000円");
  const m = matchEquipment(parseEquipmentWants({ ng_points: "1階NG、ペット不可" } as never), facts);
  eq(m.rows.filter((r) => r.want.key === "pet").map((r) => r.result), ["ok"]);
}));
it("純関数 petWantOverride（off は null）", () => {
  eq(petWantOverride("ペット不可", "ng_points", {}), null);
  eq(petWantOverride("ペット不可", "ng_points", { PROPERTY_PET_WANT_1020: "on" }), "must");
  eq(petWantOverride("ペット不可", "preferences", { PROPERTY_PET_WANT_1020: "on" }), null);
});

console.log("リノベーション物件の築年（KB 6497a18a サマックスYUIハイツ 205・築30年）");
it("off は false（今まで通り希望超過で −10 保留）", () => {
  eq(renovatedAgeOk({ name: "サマックスYUIハイツ 205", rawText: "フルリノベーション済み" }, null, {}), false);
});
it("on: 資料の印・物件名・説明文のリノベ済みは減点しない", () => {
  const env = { PROPERTY_RENOV_AGE_1020: "on" };
  eq(renovatedAgeOk({ name: "サマックスYUIハイツ 205", rawText: "" }, { renovated: true }, env), true);
  eq(renovatedAgeOk({ name: "〇〇ハイツ（フルリノベーション）", rawText: "" }, null, env), true);
  eq(renovatedAgeOk({ name: "〇〇ハイツ", rawText: "室内リノベーション済" }, null, env), true);
});
it("on: 外壁・共用部のリノベ・リフォーム予定は数えない", () => {
  const env = { PROPERTY_RENOV_AGE_1020: "on" };
  eq(renovatedAgeOk({ name: "〇〇ハイツ", rawText: "外壁リノベーション済" }, null, env), false);
  eq(renovatedAgeOk({ name: "〇〇ハイツ", rawText: "リフォーム予定" }, null, env), false);
});

console.log(`\n${passed} passed, ${failed} failed`);
if (failed) process.exitCode = 1;
