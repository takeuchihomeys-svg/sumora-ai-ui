// 2026-09-17 竹内（a🤫 事例）: 送った物件の「別の部屋・いちばん広い部屋」の質問は
//   管理会社への空室確認（AIX 確認します）ではなく AIX【物件確認した】→ 室内写真を確認した
// 実行: npx tsx app/lib/__tests__/other-room-scene.test.ts（自己完結ハーネス。全 PASS で exit 0）
import { detectAixSceneEvidence, isConfirmationScene } from "../aix-scene-evidence";
import { sceneSignalFallback, resolveBrainCheckPattern } from "../brain-aix-feedback";
import { propertyCheckKindFor } from "../aix-taxonomy";
import { OTHER_ROOM_LAYOUT_Q_RE, OTHER_ROOM_SEARCH_RE } from "../scene-patterns";

let passed = 0, failed = 0; const failures: string[] = [];
function it(name: string, fn: () => void) {
  try { fn(); passed++; console.log(`  ✓ ${name}`); }
  catch (e) { failed++; failures.push(`${name}: ${e instanceof Error ? e.message : String(e)}`); console.log(`  ✗ ${name}\n      ${e instanceof Error ? e.message : String(e)}`); }
}
function expect<T>(actual: T) {
  return {
    toBe(exp: T) { if (JSON.stringify(actual) !== JSON.stringify(exp)) throw new Error(`expected ${JSON.stringify(exp)} but got ${JSON.stringify(actual)}`); },
    toContain(s: string) { if (typeof actual !== "string" || !actual.includes(s)) throw new Error(`expected ${JSON.stringify(actual)} to contain ${JSON.stringify(s)}`); },
  };
}

const base = { hasCustomerImage: false, sentPropertyCount: 3, recentMessages: [], aixHistory: [] as { aix_type?: string | null }[] };
const scene = (text: string, o: Partial<typeof base> = {}) =>
  detectAixSceneEvidence({ latestCustomerTurn: text, ...base, ...o } as Parameters<typeof detectAixSceneEvidence>[0]);

console.log("\n[語彙]");
it("竹内さんの実例と近い言い回しを拾う", () => {
  expect(OTHER_ROOM_LAYOUT_Q_RE.test("この物件のいちばん広い部屋ありますか？")).toBe(true);
  expect(OTHER_ROOM_LAYOUT_Q_RE.test("一番広いお部屋はどれですか")).toBe(true);
  expect(OTHER_ROOM_LAYOUT_Q_RE.test("他のお部屋もありますか？")).toBe(true);
  expect(OTHER_ROOM_LAYOUT_Q_RE.test("違う間取りのタイプはありますか")).toBe(true);
  expect(OTHER_ROOM_LAYOUT_Q_RE.test("間取り図見せて頂けますか")).toBe(true);
  expect(OTHER_ROOM_LAYOUT_Q_RE.test("室内の写真ありますか？")).toBe(true);
});
it("物件探しの依頼は除く（物件ピックアップの場面）", () => {
  expect(OTHER_ROOM_SEARCH_RE.test("もっと広い部屋で探してほしいです")).toBe(true);
  expect(OTHER_ROOM_SEARCH_RE.test("他にも広いお部屋あればお願いします")).toBe(true);
  expect(OTHER_ROOM_SEARCH_RE.test("この物件のいちばん広い部屋ありますか？")).toBe(false);
});

console.log("\n[場面（S11）]");
it("竹内さんの実例: 管理会社への空室確認ではなく室内写真を確認した", () => {
  const e = scene("この物件のいちばん広い部屋ありますか？");
  expect(e?.scene).toBe("S11_other_room");
  expect(e?.candidateAction).toBe("property_check_result");
  expect(e?.checkPattern).toBe("interior_photo");
  expect(e?.timing).toBe("now"); // 受付宣言を挟まずその場で送る
  // 確認の約束の場面ではない（物件確認タスク・確認します の誘導を起こさない）
  expect(isConfirmationScene(e)).toBe(false);
});
it("物件探しの依頼は S11 にしない（条件変更＝物件探しの場面のまま）", () => {
  expect(scene("もっと広い部屋で探してほしいです")?.scene).toBe("S7_condition_change");
  expect(scene("他にも広いお部屋あればお願いします")?.scene === "S11_other_room").toBe(false);
});
it("新しい物件の URL・画像が一緒に来た時は従来どおり空室確認（S1）", () => {
  expect(scene("この物件のいちばん広い部屋ありますか？\nhttps://suumo.jp/chintai/bc_1005/")?.scene).toBe("S1_vacancy");
  expect(scene("この物件のいちばん広い部屋ありますか？", { hasCustomerImage: true })?.scene).toBe("S1_vacancy");
});
it("内覧希望は S4 内覧のまま（資料ではなく実際に見たい話）", () => {
  expect(scene("メロディハイムの別の部屋も拝見したいです")?.candidateAction).toBe("viewing_invite");
  expect(scene("一番広いお部屋を内覧したいです")?.candidateAction).toBe("viewing_invite");
});
it("こちらが物件を1件も送っていない会話では S11 にしない", () => {
  const e = scene("他のお部屋もありますか？", { sentPropertyCount: 0 });
  expect(e?.scene === "S11_other_room").toBe(false);
});
it("従来の空室確認・入居日・審査の場面は変わらない", () => {
  expect(scene("この物件まだ募集中ですか？")?.scene).toBe("S1_vacancy");
  expect(scene("この物件いつから入居できますか？")?.scene).toBe("S2_move_in");
});

console.log("\n[ブレインへの受け渡し]");
it("信号が property_check_result + interior_photo を出す", () => {
  const e = scene("この物件のいちばん広い部屋ありますか？");
  const sig = sceneSignalFallback(e);
  expect(sig?.action).toBe("property_check_result");
  expect(sig?.checkPattern).toBe("interior_photo");
  expect(sig?.decisionSource).toBe("signal:scene_S11");
});
it("check_pattern の解決が S11 の値を通す", () => {
  const e = scene("この物件のいちばん広い部屋ありますか？");
  const kind = resolveBrainCheckPattern("property_check_result", e, null, "この物件のいちばん広い部屋ありますか？");
  expect(kind?.check_pattern).toBe("interior_photo");
});

console.log("\n[スタッフへの案内文]");
it("押すボタンが「物件確認した」→「室内写真を確認した」になっている", () => {
  const kind = propertyCheckKindFor("interior_photo");
  expect(kind?.ui_button).toBe("物件確認した（募集状況）");
  expect(kind?.note).toContain("室内写真を確認した");
  expect(kind?.note).toContain("管理会社への空室確認ではなく");
});
it("条件・交渉系は従来どおり", () => {
  expect(propertyCheckKindFor("mgmt_guarantor")?.ui_button).toBe("確認した（条件・交渉）");
  expect(propertyCheckKindFor("unknown_pattern")).toBe(null);
});

console.log(`\n${passed} passed, ${failed} failed`);
if (failed > 0) { for (const f of failures) console.log(`  - ${f}`); process.exit(1); }
