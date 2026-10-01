// 2026-10-01 竹内「同じ物件が2つ入ってしまうバグ…2回送ってしまったのが原因…ちゃんと分析した時に省かれるようにする」のテスト
// 実行: npx tsx app/lib/__tests__/pickup-recent-dup.test.ts
// 行の形は property_pickups の実物（id 3363・3364・3368＝あかり／3338・3339＝カーサ ラピス／622・750＝エグゼ堺筋本町）。お客様の名前・電話番号は無い
import { recentDuplicateIndexes, RECENT_DUP_WINDOW_MS, type RecentPickupRow } from "../pickup-recent-dup";

let passed = 0, failed = 0;
function t(name: string, ok: boolean, extra?: unknown) {
  if (ok) { passed++; console.log(`  OK  ${name}`); } else { failed++; console.log(`  NG  ${name}${extra !== undefined ? `\n      ${JSON.stringify(extra).slice(0, 600)}` : ""}`); }
}
const at = (iso: string) => Date.parse(iso);

console.log("■ 二重送信（あかり 16:19 → 16:23）");
{
  const prev: RecentPickupRow[] = [
    { property_name: "あんしん福町", room_no: "101", pdf_url: "https://www.realnetpro.com/common/factsheet.php?id=9737186&org=1", created_at: "2026-10-01T07:19:48.344Z" },
    { property_name: "ルミエール姫里", room_no: "403", pdf_url: "https://www.realnetpro.com/common/factsheet.php?id=7883042&org=1", created_at: "2026-10-01T07:19:48.344Z" },
  ];
  const summaries = [
    "【1】あんしん福町 101号室\n55,000円 6,000円\n1K 28.36㎡\nなんば線「福」徒歩10分\nAD 2ヶ月",
    "【2】ルミエール姫里 403号室\n59,000円 6,000円\n1K 24.08㎡\n阪神本線「姫島」徒歩7分\nAD 1.5ヶ月",
    "【3】水上ビル東館 655号室\n52,000円 10,000円\n1K 24.4㎡",
  ];
  const urls = ["https://www.realnetpro.com/common/factsheet.php?id=9737186&org=1", "https://www.realnetpro.com/common/factsheet.php?id=7883042&org=1", "https://www.realnetpro.com/common/factsheet.php?id=1&org=1"];
  const d = recentDuplicateIndexes(summaries, urls, prev, at("2026-10-01T07:23:09.439Z"));
  t("同じ2件は外す・まだ無い1件は残す", d.has(0) && d.has(1) && !d.has(2) && d.size === 2, [...d]);
  const d2 = recentDuplicateIndexes(summaries, [null, null, null], prev, at("2026-10-01T07:23:09.439Z"));
  t("URL が無くても建物名＋号室で外す（🌟 付きの見出しも）", d2.has(0) && d2.has(1) && d2.size === 2, [...d2]);
}

console.log("■ 4秒違いで別の道から入った同じ部屋（カーサ ラピス 302・URL なしの行）");
{
  const prev: RecentPickupRow[] = [{ property_name: "カーサ　ラピス", room_no: "302", pdf_url: "https://www.realnetpro.com/common/factsheet.php?id=7318626&org=1", created_at: "2026-09-30T16:11:16.134Z" }];
  const s = ["【1🌟★】カーサ　ラピス 302号室\n90,000円 8,000円\n1DK 35.32㎡\n大阪メトロ長堀鶴見緑地線 松屋町駅 徒歩5分"];
  const d = recentDuplicateIndexes(s, [null], prev, at("2026-09-30T16:11:20.870Z"));
  t("全角スペースの名前・URL なし → 外す", d.has(0), [...d]);
}

console.log("■ 日を空けた出し直しは消さない（エグゼ堺筋本町 604・2行目からお客様に送っていた）");
{
  const prev: RecentPickupRow[] = [{ property_name: "エグゼ堺筋本町", room_no: "604", pdf_url: "https://www.realnetpro.com/common/factsheet.php?id=9342189&org=1", created_at: "2026-09-26T04:53:41.394Z" }];
  const s = ["【3】エグゼ堺筋本町 604号室\n82,000円 10,000円\n1K 25.88㎡\n中央線「堺筋本町」徒歩4分"];
  const d = recentDuplicateIndexes(s, ["https://www.realnetpro.com/common/factsheet.php?id=9342189&org=1"], prev, at("2026-09-27T10:30:28.272Z"));
  t("約30時間後 → 残す", d.size === 0, [...d]);
  t("線は6時間", RECENT_DUP_WINDOW_MS === 6 * 3600 * 1000);
}

console.log("■ 消さない側に倒す物");
{
  const prev: RecentPickupRow[] = [
    { property_name: "コル・デ・ソル杭全", room_no: "101", pdf_url: null, created_at: "2026-10-01T07:00:00Z" },
    { property_name: "物件", room_no: "", pdf_url: "https://xxx.public.blob.vercel-storage.com/a.pdf", created_at: "2026-10-01T07:00:00Z" },
  ];
  const now = at("2026-10-01T07:05:00Z");
  t("号室が同じでも建物名が違えば残す", recentDuplicateIndexes(["【1】小路東一戸建 101号室"], [null], prev, now).size === 0);
  t("号室の無い行は名前だけでは外さない", recentDuplicateIndexes(["【1】コル・デ・ソル杭全"], [null], prev, now).size === 0);
  t("一時置き場の URL は鍵にしない", recentDuplicateIndexes(["【1】別の建物 202号室"], ["https://xxx.public.blob.vercel-storage.com/a.pdf"], prev, now).size === 0);
  t("記録が無い → 何も外さない", recentDuplicateIndexes(["【1】あんしん福町 101号室"], [null], [], now).size === 0);
}

console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);
