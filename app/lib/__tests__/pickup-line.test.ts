// 2026-09-17 竹内（✩ さん事例）: ピックアップ行に物件名を入れない
// 実行: npx tsx app/lib/__tests__/pickup-line.test.ts
import { stripPropertyNameFromPickupLine, PICKUP_LINE_NOTE } from "../pickup-line";

let passed = 0, failed = 0; const failures: string[] = [];
function it(name: string, fn: () => void) {
  try { fn(); passed++; console.log(`  ✓ ${name}`); }
  catch (e) { failed++; failures.push(`${name}: ${e instanceof Error ? e.message : String(e)}`); console.log(`  ✗ ${name}\n      ${e instanceof Error ? e.message : String(e)}`); }
}
function expect<T>(actual: T) {
  return {
    toBe(exp: T) { if (JSON.stringify(actual) !== JSON.stringify(exp)) throw new Error(`expected ${JSON.stringify(exp)} but got ${JSON.stringify(actual)}`); },
    toContain(s: string) { if (typeof actual !== "string" || !actual.includes(s)) throw new Error(`expected ${JSON.stringify(actual)} to contain ${JSON.stringify(s)}`); },
    notToContain(s: string) { if (typeof actual === "string" && actual.includes(s)) throw new Error(`expected ${JSON.stringify(actual)} not to contain ${JSON.stringify(s)}`); },
  };
}

const DRAFT = "お世話になっております！！\n\n堺筋本町・長堀橋周辺全域から広めで初期費用安いお部屋、堺筋本町・長堀橋・OPUS RESIDENCE SHINSAIBASHI SOUTHでお客様にオススメできるお部屋ピックアップさせて頂きました！！\n\nお手隙の際にご査収ください😌！！";

console.log("\n[竹内さんの通]");
it("物件名の混ざった列挙が落ちて実送信に近い形になる", () => {
  const r = stripPropertyNameFromPickupLine(DRAFT, ["OPUS RESIDENCE SHINSAIBASHI SOUTH 302号室"]);
  expect(r.text).toContain("堺筋本町・長堀橋周辺全域から広めで初期費用安いお部屋ピックアップさせて頂きました！！");
  expect(r.text).notToContain("OPUS RESIDENCE");
  expect(r.text).toContain("お手隙の際にご査収ください😌！！");
  expect(r.removed.length).toBe(1);
});
it("物件名のリストが無くても英大文字2語以上で拾う", () => {
  const r = stripPropertyNameFromPickupLine(DRAFT, []);
  expect(r.text).notToContain("OPUS RESIDENCE");
});

console.log("\n[落とす形]");
it("号室が混ざった列挙も落とす", () => {
  const t = "梅田周辺全域から1LDKのお部屋、ジュネスニッコー1003号室でYUMAさんにオススメできるお部屋ピックアップさせて頂きました！！";
  const r = stripPropertyNameFromPickupLine(t, []);
  expect(r.text).toBe("梅田周辺全域から1LDKのお部屋ピックアップさせて頂きました！！");
});
it("会話から取れた物件名（カタカナ）で拾う", () => {
  const t = "本町周辺全域から広めのお部屋、セレニテ難波ブリエでオススメできるお部屋ピックアップさせて頂きました！！";
  const r = stripPropertyNameFromPickupLine(t, ["セレニテ難波ブリエ 0611号室"]);
  expect(r.text).toBe("本町周辺全域から広めのお部屋ピックアップさせて頂きました！！");
});

console.log("\n[触らない形＝実送信363件の型]");
const REAL = [
  "堺筋本町・長堀橋周辺全域から広めで初期費用を抑える事が出来るお部屋ピックアップさせて頂きました！！",
  "枚方・高槻・吹田・守口・門真・鶴見区周辺全域から瑞希さんご希望の猫OK・家賃11万円以内・1SLDK〜2LDKのご条件に合ったお部屋ピックアップさせて頂きました！！",
  "大阪市内全域と立花駅・甲子園駅周辺全域からAKANEさんにオススメ出来る1K・1DK・家賃6万円以内のお部屋ピックアップさせて頂きました😊！！",
  "ミナミ周辺全域から家賃を抑えた敷金礼金なし・初期費用の安いマンションをピックアップさせて頂きました😊！！",
  "梅田まで乗り継ぎ2回以内・30分以内のエリア全域からH!tom!.Mさんご希望のマンションタイプ・家賃管理費込み7万以内のご条件に合ったお部屋ピックアップさせて頂きました😊！！",
  "新着で大阪環状線沿線全域からreinaさんにオススメできる鉄筋・鉄骨造マンションの1DK・1LDK・駅徒歩15分以内のお部屋ピックアップさせていただきました！！",
];
it("実送信の6件はどれも触らない（お客様名のローマ字1語・物件の種類は物件名でない）", () => {
  const ng = REAL.filter((t) => stripPropertyNameFromPickupLine(t, []).removed.length > 0);
  expect(ng).toBe([]);
});
it("ピックアップの行でない文・読点の無い行・空文は触らない", () => {
  const a = "🌟OPUS RESIDENCE SHINSAIBASHI SOUTH 302\n\n堺筋本町徒歩5分のお部屋となります！！";
  expect(stripPropertyNameFromPickupLine(a, [])).toBe({ text: a, removed: [] });
  const b = "OPUS RESIDENCE SHINSAIBASHI SOUTHでお部屋ピックアップさせて頂きました！！";
  expect(stripPropertyNameFromPickupLine(b, [])).toBe({ text: b, removed: [] }); // 読点が無い＝落とすと文が壊れる
  expect(stripPropertyNameFromPickupLine("", [])).toBe({ text: "", removed: [] });
});

console.log("\n[生成の指示]");
it("入れてよい要素と実データの根拠が入っている", () => {
  expect(PICKUP_LINE_NOTE).toContain("エリア・お客様名・ご希望条件");
  expect(PICKUP_LINE_NOTE).toContain("物件名・号室");
  expect(PICKUP_LINE_NOTE).toContain("363件");
});

console.log(`\n${passed} passed, ${failed} failed`);
if (failed > 0) { for (const f of failures) console.log(`  - ${f}`); process.exit(1); }
