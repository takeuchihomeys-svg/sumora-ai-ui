// 「〇〇周辺全域から…ピックアップさせて頂きました」の後の「もう少し」の番の出し切りの材料（app/lib/search-exhausted.ts areaAllExhaustUpgrade）
// 2026-11-12 作業員1（試験 q001・q002 の外れ・統括役の決め）。お客様の文はすべて実物（120日の実送信の番・名前は伏せた）。
// 実行: npx tsx app/lib/__tests__/exhausted-area-all.test.ts
import { areaAllExhaustUpgrade, exhaustedAreaAllStrongOn, exhaustedPickupReadyOn, searchExhausted, AREA_ALL_PICKED_RE } from "../search-exhausted";

let passed = 0, failed = 0; const failures: string[] = [];
const it = (name: string, fn: () => void) => { try { fn(); passed++; console.log(`  ✓ ${name}`); } catch (e) { failed++; failures.push(name); console.log(`  ✗ ${name}\n      ${e instanceof Error ? e.message : String(e)}`); } };
const eq = (a: unknown, b: unknown) => { if (JSON.stringify(a) !== JSON.stringify(b)) throw new Error(`expected ${JSON.stringify(b)} but got ${JSON.stringify(a)}`); };
const ON = { EXHAUSTED_AREA_ALL_STRONG: "on" };

const Q001_MARK = "〇〇さんお待たせ致しました！！\n天王寺周辺全域から敷金礼金なし・初期費用を抑えられる物件をピックアップさせて頂きました！！\nお手隙の際にご査収ください😌！！";
const weak = (markerText: string, markerAt = "2026-09-19T10:56:49.102Z") => ({ exhausted: true, strength: "weak" as const, markerText, markerAt, reason: "" });
const up = (turn: string, mark = Q001_MARK, env: Record<string, string> = ON) => areaAllExhaustUpgrade(weak(mark), turn, env).strength;

it("既定 off", () => { eq(exhaustedAreaAllStrongOn({}), false); eq(exhaustedPickupReadyOn({}), false); eq(up("もう少し探していただけますか？", Q001_MARK, {}), "weak"); });
it("印の形（周辺全域から・沿線全域から・エリア全域から）", () => {
  eq(AREA_ALL_PICKED_RE.test(Q001_MARK.normalize("NFKC")), true);
  eq(AREA_ALL_PICKED_RE.test("御堂筋線沿線全域から1K以上のお部屋ピックアップさせて頂きました！！"), true);
  eq(AREA_ALL_PICKED_RE.test("新着の物件で家賃を抑えたマンションのお部屋をピックアップさせて頂きました！！"), false);
  eq(AREA_ALL_PICKED_RE.test("天王寺周辺全域からピックアップしてお送りさせて頂きます！！"), false); // これから送る約束は印ではない
});
// 実物: 新しい条件の無い「もう少し」→ スタッフは新着待ち（5/5）
for (const t of ["もう少し探していただけますか？", "ありがとうございます。 かなり良いと思いますが、もう少し探してみたいです。", "もう少し送ってください🙇‍♀️", "もう少し見てみたいのでまたあれは紹介して欲しいです。 今月いっぱい探したいです。"]) {
  it(`新しい条件の無い「もう少し」→ strong: ${t.slice(0, 20)}`, () => eq(up(t), "strong"));
}
// 実物: 新しい条件を足した番 → スタッフは新しいピックアップの約束（2/2）＝強くしない
for (const t of ["複数ありがとうございます！ できたら本町、堺筋本町らへんが良くて、松屋町の方になるとすこし不便になってしまうので、他の物件も見たいです", "ありがとうございます！ もう少しだけみなみに近い物件見たいです", "ありがとうございます！ 他にももう少し見てみたいです！ できれば、35㎡以上の部屋がいいです！", "もっと初期費用安くなる物件ないですか？", "もう少し駅から近い物件ないでしょうか"]) {
  it(`新しい条件のある番 → weak のまま: ${t.slice(0, 20)}`, () => eq(up(t), "weak"));
}
it("内覧の日の話は上げない（監査の実物・スタッフは即日内覧できる部屋を案内）", () => eq(up("承知しました🥹ありがとうございます 明日見れる他の物件ありますか？"), "weak"));
it("「もう少し」でない番（お礼・質問）は上げない", () => {
  eq(up("ありがとうございます！"), "weak");
  eq(up("こちらの物件の初期費用はいくらですか？"), "weak");
});
it("画像の書き起こしの中の語では条件と読まない（q002 の形・印が全域からの時）", () => {
  eq(up("[画像] ラクラス阿倍野元町 0507 6.4万円\n大阪メトロ御堂筋線 昭和町駅 徒歩5分\nこの三つの物件良さそうですが、\nもう少し見てみたいので、送っていただきたいです🙇‍♀️"), "strong");
});
it("新着の束の印（q002）は対象外のまま", () => eq(up("もう少し見てみたいので、送っていただきたいです", "新着の物件で家賃を抑えたマンションのお部屋をピックアップさせて頂きました！！"), "weak"));
it("一番新しい印が文の無い AIX の送付でも、前後10分のこちらの文から全域からを読む", () => {
  const r = areaAllExhaustUpgrade(weak("", "2026-09-19T10:57:30Z"), "もう少し探していただけますか？", ON, [
    { sender: "staff", text: Q001_MARK, createdAt: "2026-09-19T10:56:49Z" },
    { sender: "customer", text: "もう少し探していただけますか？", createdAt: "2026-09-20T13:20:00Z" },
  ]);
  eq([r.strength, r.upgraded], ["strong", true]);
});
it("strong・出し切りでない時はそのまま", () => {
  eq(areaAllExhaustUpgrade({ exhausted: false, strength: null, markerText: Q001_MARK }, "もう少し探して", ON).strength, null);
  eq(areaAllExhaustUpgrade({ exhausted: true, strength: "strong", markerText: Q001_MARK }, "もう少し探して", ON).strength, "strong");
});
it("送れる候補がある（pickupReady=true）→ 出し切りではない（既存の判定）", () => {
  const msgs = [{ sender: "staff", text: Q001_MARK, createdAt: "2026-09-19T10:56:49Z" }, { sender: "customer", text: "もう少し探していただけますか？", createdAt: "2026-09-20T13:20:00Z" }];
  eq(searchExhausted(msgs, { conditionChangedThisTurn: false, pickupReady: true }).exhausted, false);
  eq(searchExhausted(msgs, { conditionChangedThisTurn: false, pickupReady: null }).exhausted, true);
});

console.log(`\n${passed} passed, ${failed} failed`);
if (failed) { console.log(failures.join("\n")); process.exit(1); }
