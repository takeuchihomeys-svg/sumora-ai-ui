// 「AIX が実際に押されている場面」をブレインに渡す文のテスト（自己完結ハーネス）
// 実行: npx tsx app/lib/__tests__/aix-scene-stats.test.ts
import { buildAixSceneNote, AIX_SCENE_STATS } from "../aix-scene-stats";

let passed = 0, failed = 0; const failures: string[] = []; let current = "";
function describe(name: string, fn: () => void) { current = name; fn(); }
function it(name: string, fn: () => void) {
  try { fn(); passed++; console.log(`  ✓ ${current} › ${name}`); }
  catch (e) { failed++; failures.push(`${current} › ${name}`); console.log(`  ✗ ${current} › ${name}\n      ${e instanceof Error ? e.message : String(e)}`); }
}
const truthy = (a: unknown, msg = "") => { if (!a) throw new Error(`expected truthy ${msg}`); };
const falsy = (a: unknown, msg = "") => { if (a) throw new Error(`expected falsy ${msg}`); };

const NOTE = buildAixSceneNote();

describe("渡す中身", () => {
  it("9種類すべてが載る", () => {
    for (const key of Object.keys(AIX_SCENE_STATS)) truthy(NOTE.includes(key), key);
  });
  it("成約側の割合が高い順に並ぶ", () => {
    const order = Object.entries(AIX_SCENE_STATS).map(([k]) => ({ k, at: NOTE.indexOf(`- ${k}（`) }));
    const sorted = [...order].sort((a, b) => a.at - b.at).map((x) => x.k);
    const byWon = Object.entries(AIX_SCENE_STATS).sort((a, b) => b[1].wonPct - a[1].wonPct).map(([k]) => k);
    truthy(JSON.stringify(sorted) === JSON.stringify(byWon), `${sorted} vs ${byWon}`);
  });
  it("押すまでの時間と押した後の反応が入る", () => {
    truthy(NOTE.includes("押すまで中央値"));
    truthy(NOTE.includes("押した後にお客様が返す型"));
  });
  it("応える型／こちらから型の区別が入る", () => {
    truthy(NOTE.includes("応える型"));
    truthy(NOTE.includes("こちらから型"));
  });
  it("費用を聞かれたら先に募集状況の確認という実務の順序が入る", () =>
    truthy(NOTE.includes("先に募集状況の確認")));
});

// 設計知見・竹内方針2「物件名を生成に持ち込まない」／「本文を引用して渡すと写す」
describe("持ち込んではいけない物が入っていない", () => {
  it("実在の物件名・号室を入れない（例は〇〇で伏せる）", () => {
    falsy(/\d{3,4}号室/.test(NOTE), NOTE);
    falsy(/(エスティメゾン|プリレス|レオンコンフォート|リデア|ハウスアメニティ)/.test(NOTE), NOTE);
  });
  it("お客様の本名を入れない", () => falsy(/[一-龥ぁ-んァ-ヶー]{2,4}さん/.test(NOTE), NOTE));
  it("具体的な日付を入れない（〇/〇 の型にする）", () => falsy(/\d{1,2}月\d{1,2}日|\d{1,2}\/\d{1,2}[^\d]/.test(NOTE.replace(/\d+\.\d+時間/g, "")), NOTE));
});

// 設計知見「AIX の要否・種類はブレインだけが判断」: 禁止・命令にしない
describe("指示ではなく材料として渡す", () => {
  it("押すな・押せ の形を入れない", () =>
    falsy(/押さない|押すな|必ず押|選んではいけない|禁止/.test(NOTE), NOTE));
  it("相関であって因果ではないと明記する", () => truthy(NOTE.includes("相関であって因果ではない")));
  it("判断の材料だと書く", () => truthy(NOTE.includes("材料として使う")));
});

describe("大きさ", () => {
  it("1時間キャッシュ側に入る想定で 3000字以内", () => truthy(NOTE.length < 3000, `${NOTE.length}字`));
  it("実測の件数が書いてある（出典が分かる）", () => truthy(NOTE.includes("押下1,826件")));
});

console.log(`\n${passed} passed, ${failed} failed`);
if (failed > 0) { console.log(failures.map((f) => `- ${f}`).join("\n")); process.exit(1); }
