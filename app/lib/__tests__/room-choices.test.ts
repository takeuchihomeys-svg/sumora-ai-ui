// 2026-09-16 竹内（カイナ事例）: 申込のお部屋が決まっていない時の候補の号室
// 実行: npx tsx app/lib/__tests__/room-choices.test.ts（自己完結ハーネス。全 PASS で exit 0）
import { parseRoomChoices, shouldAskRoomChoice, roomChoiceNote, stripUngroundedRoomNo } from "../room-choices";

let passed = 0, failed = 0; const failures: string[] = [];
function it(name: string, fn: () => void) {
  try { fn(); passed++; console.log(`  ✓ ${name}`); }
  catch (e) { failed++; failures.push(`${name}: ${e instanceof Error ? e.message : String(e)}`); console.log(`  ✗ ${name}\n      ${e instanceof Error ? e.message : String(e)}`); }
}
function expect<T>(actual: T) {
  return { toBe(exp: T) { if (actual !== exp) throw new Error(`expected ${JSON.stringify(exp)} but got ${JSON.stringify(actual)}`); } };
}

it("カイナ: 「1303・906・506」→ 3部屋（実送信の (1303号室・906号室・506号室) と同じ）", () => {
  const r = parseRoomChoices("1303・906・506");
  expect(r.join("・")).toBe("1303号室・906号室・506号室");
  expect(shouldAskRoomChoice(r)).toBe(true);
  expect(roomChoiceNote(r)).toBe("件数: 3部屋\n号室: 1303号室・906号室・506号室");
});
it("号室が付いていてもそのまま・区切りは 読点/カンマ/スラッシュ/空白 も通す", () => {
  expect(parseRoomChoices("1303号室, 906号室").join("・")).toBe("1303号室・906号室");
  expect(parseRoomChoices("205、301 402/503").join("・")).toBe("205号室・301号室・402号室・503号室");
  expect(parseRoomChoices("１３０３・９０６").join("・")).toBe("1303号室・906号室");
});
it("「部屋」「室」の表記ゆれ・英数字の部屋番号も揃える", () => {
  expect(parseRoomChoices("A101・B202室・303部屋").join("・")).toBe("A101号室・B202号室・303号室");
});
it("同じ号室は1つにまとめる・空や記号だけは落とす", () => {
  expect(parseRoomChoices("1303・1303・906").join("・")).toBe("1303号室・906号室");
  expect(parseRoomChoices("　・、").length).toBe(0);
  expect(parseRoomChoices("").length).toBe(0);
  expect(parseRoomChoices(null).length).toBe(0);
});
it("号室ではない文字列（物件名・階数の説明）は号室にしない", () => {
  expect(parseRoomChoices("アーバンフラッツ心斎橋").length).toBe(0);
  expect(parseRoomChoices("3部屋の中から").length).toBe(0);
});
it("候補が1つなら聞かない（決まっているのと同じ）", () => {
  expect(shouldAskRoomChoice(parseRoomChoices("1303"))).toBe(false);
  expect(shouldAskRoomChoice([])).toBe(false);
});

// 本番確認で見つけた穴: 候補の号室を渡さない申込確定で、会話に無い「1303号室」を2回とも書いた
it("カイナ: 会話にもスタッフ入力にも無い号室を落とす（申込の号室の創作を止める）", () => {
  const r = stripUngroundedRoomNo("かしこまりました！！\nアーバンフラッツ心斎橋 1303号室、お申込みさせて頂きます😊！！", "アーバンフラッツ心斎橋\nお客様: 内見は大丈夫なので進めて頂きたいです！");
  expect(r.text).toBe("かしこまりました！！\nアーバンフラッツ心斎橋、お申込みさせて頂きます😊！！");
  expect(r.removed.join(",")).toBe("1303号室");
});
it("会話にある号室・スタッフが入れた号室は残す", () => {
  const t = "かしこまりました！！\nアーバンフラッツ心斎橋 1303号室、お申込みさせて頂きます😊！！";
  expect(stripUngroundedRoomNo(t, "お客様: 1303号室でお願いします！").text).toBe(t);
  expect(stripUngroundedRoomNo(t, "アーバンフラッツ心斎橋 1303号室").text).toBe(t);
  // 全角で書かれていても同じ号室として残す
  expect(stripUngroundedRoomNo(t, "お客様: １３０３号室でお願いします！").text).toBe(t);
  expect(stripUngroundedRoomNo(t, "").removed.join(",")).toBe("1303号室");
});
it("候補の号室を聞く形（3部屋）は全部根拠があるので落とさない", () => {
  const t = "かしこまりました！！\n代理契約でお申込みさせて頂きます！！\n現在募集の3部屋の中で(1303号室・906号室・506号室)\nお部屋は何号室で審査かけさせていただきましょうか！！";
  expect(stripUngroundedRoomNo(t, "1303号室・906号室・506号室").text).toBe(t);
});

console.log(`\n${passed} passed, ${failed} failed`);
if (failed > 0) { for (const f of failures) console.log(`  - ${f}`); process.exit(1); }
