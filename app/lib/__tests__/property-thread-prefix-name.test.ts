// 物件名を頭だけで呼んだ発言の名指し（2026-10-27 番 8598「おおきに長堀橋気になります」）。実データの言い方そのまま
// 実行: npx tsx app/lib/__tests__/property-thread-prefix-name.test.ts
import { roomsNamedByPrefix, propertyThreadPrefixNameEnabled, PREFIX_SKIP_RAW_RE } from "../property-thread";
import { buildingKeyOf, splitPropertyName } from "../customer-state";

let passed = 0, failed = 0;
function it(name: string, fn: () => void) {
  try { fn(); passed++; console.log(`  ✓ ${name}`); }
  catch (e) { failed++; console.log(`  ✗ ${name}\n      ${e instanceof Error ? e.message : String(e)}`); }
}
function eq<T>(a: T, b: T, label = "") { if (JSON.stringify(a) !== JSON.stringify(b)) throw new Error(`${label} expected ${JSON.stringify(b)} but got ${JSON.stringify(a)}`); }
const items = (names: string[]) => names.map((n) => ({ key: splitPropertyName(n)?.buildingKey ?? buildingKeyOf(n), room: n }));
const hit = (text: string, names: string[]) => roomsNamedByPrefix(buildingKeyOf(text), items(names)).map((x) => x.room);
const SENT_8598 = ["コスモトム日本橋Ⅱ 5B号室", "レバンガAP桜川FOX 402号室", "ラパンジール恵美須2 405号室", "おおきに長堀橋鰻谷北サニーアパートメント 1005号室"];

console.log("切替（既定 off）");
it("既定 off・on で入る", () => { eq(propertyThreadPrefixNameEnabled({}), false); eq(propertyThreadPrefixNameEnabled({ PROPERTY_THREAD_PREFIX_NAME: "on" }), true); });

console.log("頭だけの呼び方");
it("番 8598「おおきに長堀橋気になります！」→ おおきに長堀橋鰻谷北サニーアパートメント", () => eq(hit("おおきに長堀橋気になります！", SENT_8598), ["おおきに長堀橋鰻谷北サニーアパートメント 1005号室"]));
it("「S-RESIDENCE難波の方到着してます」→ S-RESIDENCE難波8iller", () => eq(hit("S-RESIDENCE難波の方到着してます！", ["S-RESIDENCE難波8iller 603号室", "シャーメゾン田川北 101号室"]), ["S-RESIDENCE難波8iller 603号室"]));

console.log("取り違えない");
it("同じ銘柄の別の建物（頭の後ろが名前の続き）は名指しにしない: 「アーバネックス本町Ⅱ」→ アーバネックス南新町 にしない", () => eq(hit("アーバネックス本町Ⅱは募集されていませんか？？", ["アーバネックス南新町 801号室"]), []));
it("「ラパンジール長堀どうですか」→ ラパンジール恵美須2 にしない", () => eq(hit("ラパンジール長堀どうですか？", SENT_8598), []));
it("頭が2つの建物に当たる時は決めない", () => eq(hit("メゾンドの件どうでしょう", ["メゾンドール本町 101号室", "メゾンドヴィレ難波 202号室"]), []));
it("5字未満の頭（「グラン」）は使わない", () => eq(hit("グランは良いですね", ["グランパシフィック 101号室"]), []));
it("持ち込み（URL・画像の書き起こし）の発言は頭の一致を使わない", () => { eq(PREFIX_SKIP_RAW_RE.test("ShaMaisonRicco 2階 https://suumo.jp/x"), true); eq(PREFIX_SKIP_RAW_RE.test("[画像] 物件名：セレニテ難波ブリエ"), true); });

console.log(`\n${passed} passed, ${failed} failed`);
if (failed) process.exitCode = 1;
