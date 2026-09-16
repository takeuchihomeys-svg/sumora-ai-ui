// 2026-09-16 竹内（YUYA 事例）: お客様が送ってくれた物件の名前を候補に出し、選ぶと物件名欄に入る
// 実行: npx tsx app/lib/__tests__/customer-property-names.test.ts（自己完結ハーネス。全 PASS で exit 0）
import { customerSharedPropertyNames } from "../customer-property-names";

let passed = 0, failed = 0; const failures: string[] = [];
function it(name: string, fn: () => void) {
  try { fn(); passed++; console.log(`  ✓ ${name}`); }
  catch (e) { failed++; failures.push(`${name}: ${e instanceof Error ? e.message : String(e)}`); console.log(`  ✗ ${name}\n      ${e instanceof Error ? e.message : String(e)}`); }
}
function expect<T>(actual: T) {
  return { toBe(exp: T) { if (JSON.stringify(actual) !== JSON.stringify(exp)) throw new Error(`expected ${JSON.stringify(exp)} but got ${JSON.stringify(actual)}`); } };
}

const C = (text: string, at = "2026-09-16T13:27:45Z") => ({ sender: "customer", text, createdAt: at });
const S = (text: string) => ({ sender: "staff", text, createdAt: "2026-09-16T13:30:00Z" });

it("YUYA: SUUMO の共有文から物件名（階は表示に残し、名前からは外す）", () => {
  const msgs = [C("募集終了て言われた物件がSUUMOで即入居でありますが見落としとかではないですか？\nプルス新北野 3階\nhttps://suumo.jp/chintai/bc_100526248899/\nby SUUMO")];
  const r = customerSharedPropertyNames(msgs);
  expect(r.length).toBe(1);
  expect(r[0].name).toBe("プルス新北野");
  expect(r[0].label).toBe("プルス新北野 3階");
  expect(r[0].url).toBe("https://suumo.jp/chintai/bc_100526248899/");
});
it("実データの SUUMO の形をまとめて（カタカナ・英字・漢字まじりの建物名・古い順の配列を新しい順に返す）", () => {
  const msgs = [
    C("森小路ガーデンハイツ 4階\nhttps://suumo.jp/chintai/bc_100495273025/\nby SUUMO", "2026-09-14T08:31:53Z"),
    C("メゾンラトゥール 1階\nhttps://suumo.jp/chintai/bc_100525940324/\nby SUUMO", "2026-09-14T16:39:01Z"),
    C("アーブル　ヴィラージュ 1階\nhttps://suumo.jp/chintai/bc_100516544027/\nby SUUMO", "2026-09-14T16:41:55Z"),
    C("OPUS RESIDENCE SHINSAIBASHI SOUTH 3階\nhttps://suumo.jp/chintai/bc_100527254405/\nby SUUMO", "2026-09-16T11:01:05Z"),
  ];
  expect(customerSharedPropertyNames(msgs).map((c) => c.name)).toBe(["OPUS RESIDENCE SHINSAIBASHI SOUTH", "アーブル ヴィラージュ", "メゾンラトゥール", "森小路ガーデンハイツ"]);
});
it("ニフティの共有文（駅・徒歩・間取り・家賃だけ）は候補にしない", () => {
  const msgs = [C("地下鉄堺筋線 恵美須町 徒歩5分\n1R 5.2万円\n[詳細]\nhttps://myhome.nifty.com/smp/rent/osaka/osakashinaniwaku/suumof_100526666198/\n\nニフティ不動産アプリ版はこちら\nhttps://myhome.nifty.com/apps/")];
  expect(customerSharedPropertyNames(msgs)).toBe([]);
});
it("駅名＋間取り＋階（「堺筋本町 1LDK 6階」）は物件名にしない", () => {
  const msgs = [C("堺筋本町 1LDK 6階\nhttps://suumo.jp/chintai/bc_100527106738/\nby SUUMO")];
  expect(customerSharedPropertyNames(msgs)).toBe([]);
});
it("athome の「物件名：」はそのまま候補に", () => {
  const msgs = [C("物件名：大阪市旭区 太子橋１丁目 （太子橋今市駅 ） 2階 １ＬＤＫ\n\n物件種目：賃貸アパート\n価格：8.2万円\n詳細を見る\n  https://www.athome.co.jp/u?s=1E96Fn1")];
  const r = customerSharedPropertyNames(msgs);
  expect(r.length).toBe(1);
  expect(r[0].name).toBe("大阪市旭区 太子橋１丁目 （太子橋今市駅 ） 2階 １ＬＤＫ");
});
it("URL だけ・TikTok・スタッフの発言は候補にしない", () => {
  expect(customerSharedPropertyNames([C("https://suumo.jp/chintai/bc_100503105742/")])).toBe([]);
  expect(customerSharedPropertyNames([C("https://lite.tiktok.com/t/ZSqQPJfYV/")])).toBe([]);
  expect(customerSharedPropertyNames([S("🌟エストレーラ 305号室\nhttps://suumo.jp/chintai/bc_1/\nby SUUMO")])).toBe([]);
});
it("同じ物件名は1つ・新しい順・最大5件", () => {
  const msgs = [
    C("メゾンラトゥール 1階\nhttps://suumo.jp/chintai/bc_1/\nby SUUMO", "2026-09-14T16:39:01Z"),
    C("メゾンラトゥール 5階\nhttps://suumo.jp/chintai/bc_2/\nby SUUMO", "2026-09-15T10:00:00Z"),
    C("グリーンプラザ 6階\nhttps://suumo.jp/chintai/bc_3/\nby SUUMO", "2026-09-16T10:00:00Z"),
  ];
  const r = customerSharedPropertyNames(msgs);
  expect(r.map((c) => c.label)).toBe(["グリーンプラザ 6階", "メゾンラトゥール 5階"]);
  expect(customerSharedPropertyNames(msgs, { limit: 1 }).length).toBe(1);
});

console.log(`\n${passed} passed, ${failed} failed`);
if (failed > 0) { for (const f of failures) console.log(`  - ${f}`); process.exit(1); }
