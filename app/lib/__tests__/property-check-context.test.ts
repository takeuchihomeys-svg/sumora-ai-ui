// 2026-09-15 竹内（みく事例）: AIX 物件確認した — 送られた物件数の自動判定・スタッフの入力を正にする・引用返信の物件
// 実行: npx tsx app/lib/__tests__/property-check-context.test.ts（自己完結ハーネス。全 PASS で exit 0）
import { countCustomerSentProperties } from "../customer-property-count";
import { avoidTopicsForAix } from "../aix-staff-first";
// 2026-09-21: 文を作る純関数は quoted-note.ts に分けた（quoted-context.ts は DB を読むのでテストから外す）
import { formatQuotedContextBlock } from "../quoted-note";

let passed = 0, failed = 0; const failures: string[] = [];
function it(name: string, fn: () => void) {
  try { fn(); passed++; console.log(`  ✓ ${name}`); }
  catch (e) { failed++; failures.push(`${name}: ${e instanceof Error ? e.message : String(e)}`); console.log(`  ✗ ${name}\n      ${e instanceof Error ? e.message : String(e)}`); }
}
function expect<T>(actual: T) {
  return { toBe(exp: T) { if (actual !== exp) throw new Error(`expected ${JSON.stringify(exp)} but got ${JSON.stringify(actual)}`); } };
}

// ─── 送られた物件数（みくの実データ） ───
const staffReport = { sender: "staff", text: "みくさんお世話になっております！！ お送り頂きました物件につきまして募集状況確認させて頂きましたところ…" };
it("物件の URL 2通＋質問 → 2件（URL）", () => {
  const r = countCustomerSentProperties([
    staffReport,
    { sender: "customer", text: "ありがとうございます。" },
    { sender: "customer", text: "物件名：大阪市住吉区 長居東１丁目 3階 １ＬＤＫ\n詳細を見る\n https://www.athome.co.jp/u?s=1GChG61" },
    { sender: "customer", text: "物件名：大阪市旭区 太子橋１丁目 2階 １ＬＤＫ\n詳細を見る\n https://www.athome.co.jp/u?s=1E96Fn1" },
    { sender: "customer", text: "お安くなりますか？" },
  ]);
  expect(r.count).toBe(2); expect(r.basis).toBe("url");
});
it("「こちら３階は空きありますか？」（URL・画像なし）→ 数えない（空欄のまま）", () => {
  const r = countCustomerSentProperties([staffReport, { sender: "customer", text: "すみません💦\nこちら３階は空きありますか？" }]);
  expect(r.count).toBe(0); expect(r.basis).toBe("none");
});
it("ニフティのアプリ案内リンクは数えない（物件1件）", () => {
  const r = countCustomerSentProperties([staffReport, { sender: "customer", text: "地下鉄谷町線 駒川中野 徒歩5分\nhttps://myhome.nifty.com/smp/rent/osaka/x/suumof_100526289596/\n\nニフティ不動産アプリ版はこちら\nhttps://myhome.nifty.com/apps/" }]);
  expect(r.count).toBe(1);
});
it("スクショ2枚＋URL1件 → 3件（mixed）", () => {
  const r = countCustomerSentProperties([staffReport, { sender: "customer", text: "[画像] 物件A" }, { sender: "customer", text: "[画像] 物件B" }, { sender: "customer", text: "https://suumo.jp/chintai/bc_1/" }]);
  expect(r.count).toBe(3); expect(r.basis).toBe("mixed");
});
it("最後がスタッフなら、その前のお客様の連投で数える", () => {
  const r = countCustomerSentProperties([{ sender: "customer", text: "https://suumo.jp/chintai/bc_1/" }, { sender: "customer", text: "https://suumo.jp/chintai/bc_2/" }, { sender: "staff", text: "確認させて頂きます" }]);
  expect(r.count).toBe(2);
});

// ─── スタッフの入力を正にする（ブレインの避ける話題） ───
it("物件確認した＋御見積書同封 → 「見積書」「初期費用」は避ける話題から外す（来阪は残す）", () => {
  expect(avoidTopicsForAix("property_check_result", ["来阪", "見積書", "初期費用", "内覧日程の確定"], { estimateEnclosed: true }).join(",")).toBe("来阪,内覧日程の確定");
});
it("内覧誘導ありなら「内覧日程の確定」も外す", () => {
  expect(avoidTopicsForAix("property_check_result", ["来阪", "内覧日程の確定"], { viewingInvite: true }).join(",")).toBe("来阪");
});
it("見積書送る は種類そのもので「見積書」を外す", () => expect(avoidTopicsForAix("estimate_sheet", ["見積書", "申込"]).join(",")).toBe("申込"));
it("物件確認した（同封なし）は「他物件の募集状況確認」を残す", () => expect(avoidTopicsForAix("property_check_result", ["他物件の募集状況確認"]).join(",")).toBe("他物件の募集状況確認"));

// ─── 引用返信の物件 ───
it("引用先がスタッフの物件資料 → 物件名と「こちら」の指す先を書く", () => {
  const b = formatQuotedContextBlock({ customerText: "すみません💦\nこちら３階は空きありますか？", quotedSender: "staff", quotedText: null, isImage: true, propertyLabel: "robot home 太子橋(旧robot) 101号室", detailLines: [], detailKind: null });
  expect(b.includes("robot home 太子橋(旧robot) 101号室")).toBe(true);
  expect(b.includes("取り違えない")).toBe(true);
});
it("引用が無ければ何も入れない", () => expect(formatQuotedContextBlock(null)).toBe(""));

console.log(`\n${passed} passed, ${failed} failed`);
if (failed > 0) { for (const f of failures) console.log(`  - ${f}`); process.exit(1); }
