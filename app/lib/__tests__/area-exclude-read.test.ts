// 2026-11-06 作業員1（弱い所 359・q008）: 物件を送った後の「〇〇は住んでいたが不便だった」をエリアを外す言い直しと読む手本
// 実行: npx tsx app/lib/__tests__/area-exclude-read.test.ts（自己完結ハーネス。全 PASS で exit 0）
import { areaExcludeReadOn, readAreaExclude, pickAreaExcludeExamples, areaExcludeBrainText } from "../area-exclude-read";

let passed = 0, failed = 0; const failures: string[] = [];
function it(name: string, fn: () => void) {
  try { fn(); passed++; console.log(`  ✓ ${name}`); } catch (e) { failed++; failures.push(name); console.log(`  ✗ ${name}: ${e instanceof Error ? e.message : e}`); }
}
function expect<T>(a: T) { return { toBe: (b: T) => { if (a !== b) throw new Error(`expected ${JSON.stringify(b)} got ${JSON.stringify(a)}`); }, toContain: (s: string) => { if (!String(a).includes(s)) throw new Error(`expected to contain ${s}`); } }; }

const Q008 = "神崎川はすんでましたが\n不便だったので汗"; // 実物（9/19 721ff307 竹内さんの番）

it("スイッチは既定 on（止める =off）", () => { expect(areaExcludeReadOn({})).toBe(true); expect(areaExcludeReadOn({ BRAIN_AREA_EXCLUDE_READ: "off" })).toBe(false); });
it("q008: 物件を送った後なら当たる", () => { expect(readAreaExclude({ customerText: Q008, sentPropertyCount: 2 })).toBe(true); });
it("物件を送っていない会話は当たらない", () => { expect(readAreaExclude({ customerText: Q008, sentPropertyCount: 0 })).toBe(false); });
it("住んでいた経験だけ（悪さなし）は当たらない", () => { expect(readAreaExclude({ customerText: "神崎川は前に住んでました！", sentPropertyCount: 2 })).toBe(false); });
it("内覧の話（行った事がある所を内見したい）は当たらない", () => { expect(readAreaExclude({ customerText: "前に住んでた所で不便じゃなかったので内見したいです", sentPropertyCount: 2 })).toBe(false); });
it("申込の書類（実家・住居年数）は当たらない", () => { expect(readAreaExclude({ customerText: "【お申込者様記入欄】\n・住居年数 20\n・住居形態 実家が遠い", sentPropertyCount: 2 })).toBe(false); });
it("別の言い方: 「十三に住んでいた事があって治安が微妙で」も当たる", () => { expect(readAreaExclude({ customerText: "十三に住んでいた事があって治安が微妙で…", sentPropertyCount: 3 })).toBe(true); });
// 監査（200日・物件を送った後）で当たった実物 5番（全部ピックアップの約束で返した・竹内さん 3/3）
for (const [name, t] of [
  ["9/19 ミナミ方面は避けたい", "出来れば中央大通りより北側でお願いしたいです。\nミナミ方面は、避けたいです。"],
  ["9/09 京都・尼崎はNG", "できれば大阪の市内付近でお願いいたします（京都・尼崎はNGで、、、)"],
  ["9/17 環状線は避けたい", "御堂筋線で1本の場所とかありますか？\n環状線は遅延とかが多く避けたいです💦"],
  ["8/10 生野区付近は避けたい", "ネッサンスは面積的には問題ないのですが、小さい子どもが住んでるため生野区付近は避けたいと考えております。"],
] as const) it(`監査で当たる実物: ${name}`, () => { expect(readAreaExclude({ customerText: t, sentPropertyCount: 3 })).toBe(true); });
// 監査で目で読んで外した実物（エリアを外す言い直しではない）
for (const [name, t] of [
  ["会社（スモラさん以外で契約）", "スモラさん以外で契約する気ないので！"],
  ["作り（和室は避けたい）", "できれば押入れなども和室の味が残っているものは避けたいなとおもっておりまして"],
  ["作り（木造は避けたい）", "木造は避けたいので、鉄骨造またはRCの物件で探していただけると助かります。"],
  ["告知事項は避けたい", "できれば、告知事項のある物件は避けたいです。"],
  ["ブランド（レオパレス以外）", "家賃4-5万円で、家具家電付きの賃貸を泉大津市で探しています。できれば、レオパレス以外で探しております。"],
  ["広げる（環状以外でも市内ならOK）", "環状以外でも、市内なら、オッケーです。"],
  ["他の物件（〇〇以外でも）", "メルクリオール難波さん以外でも、他にありましたら物件情報知りたいです！！"],
  ["内見の番（加美駅付近以外＋内見予定）", "平野区加美駅付近以外で大阪市内で初期費用が抑えれる物件があったら教えてほしいです。\n間に合えば内見予定の9/9に行きたいです。"],
  ["条件の入力の型（①【…】西成区以外）", "①【ご入居の時期】⇒6月中\n⑤【ご希望のエリア・駅名】⇒西成区以外"],
  ["内覧の日（月曜日以外）", "来週月曜日以外で15時30以降内覧空いてる日ありますか？"],
  ["ペットはNG（地名ではない）", "ペットはNGでお願いします"],
] as const) it(`監査で外す実物: ${name}`, () => { expect(readAreaExclude({ customerText: t, sentPropertyCount: 3 })).toBe(false); });
it("手本: 同じ会話は外す（答えが漏れない）", () => { expect(pickAreaExcludeExamples("721ff307-5ced-46bb-b33c-f5e9cc6bbe04", {}).some((e) => e.conv.startsWith("721ff307"))).toBe(false); });
it("手本: 試験の元の会話も外す", () => { expect(pickAreaExcludeExamples("copy", { BRAIN_JUDGE_EXAMPLES_EXCLUDE_CONV: "721ff307-5ced-46bb-b33c-f5e9cc6bbe04" }).length).toBe(2); });
it("材料の文: 言い直しと竹内さんの数", () => {
  const t = areaExcludeBrainText(true, pickAreaExcludeExamples("x", {}));
  expect(t).toContain("条件の言い直し（そのエリアを除く）");
  expect(t).toContain("約束 3・相づちだけの返信 0");
  // 11/06 area-read-on-1106: 読み方だけでは q008 が動かない → 一手（ピックアップの約束）を1組で渡す
  expect(t).toContain("一手: 竹内さんは「〇〇エリアを除いた地域から");
  expect(t).toContain("route=promise");
  expect(t).toContain("竹内さん: ピックアップの約束（2段:pickup）");
});
it("材料の文: 当たらなければ空", () => { expect(areaExcludeBrainText(false, [])).toBe(""); });

console.log(`\n${passed} passed, ${failed} failed`);
if (failed > 0) { for (const f of failures) console.log(`  - ${f}`); process.exit(1); }
