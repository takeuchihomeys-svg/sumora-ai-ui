// app/lib/__tests__/new-arrivals.test.ts
// 2026-09-25 竹内「右の一覧の項目を新着物件に名前変更。ブレインの基準をクリアした物件があれば LINE 一覧と同じ UI で 1・2 や文字が出る。
//   トーク一覧も新着物件があった順に」
// 実行: npx tsx app/lib/__tests__/new-arrivals.test.ts（全 PASS で exit 0）
import { isNewArrival, summarizeNewArrivals, newArrivalLine, sortByNewArrivals, hitsSentBuilding, manYen, NEW_ARRIVAL_WINDOW_HOURS, type NewArrivalRow } from "../new-arrivals";

let pass = 0, fail = 0;
function t(name: string, cond: boolean, extra = "") {
  if (cond) { pass++; console.log(`  OK  ${name}`); }
  else { fail++; console.log(`  NG  ${name}${extra ? ` -- ${extra}` : ""}`); }
}
const NOW = Date.parse("2026-09-25T15:00:00+09:00");
const at = (jst: string) => new Date(`${jst}+09:00`).toISOString();
const row = (o: Partial<NewArrivalRow> & { id: number }): NewArrivalRow => ({
  created_at: at("2026-09-25T11:00:00"), property_name: "テスト建物A", summary_text: "【1】テスト建物A 101\n賃料 72,000円", verdict: "pass", status: "pending",
  expired_at: null, seen_at: null, score: 70, recommended: 0, rank: 1, ...o,
});

console.log("── 新着の決まり（通す・未送信・未読・72時間以内・送った建物に当たらない）");
{
  t("★ 通す・未送信・未読 → 新着", isNewArrival(row({ id: 1 }), [], NOW));
  t("保留（hold）は新着にしない", !isNewArrival(row({ id: 2, verdict: "hold" }), [], NOW));
  t("外す候補（drop）は新着にしない", !isNewArrival(row({ id: 3, verdict: "drop" }), [], NOW));
  t("判定なし（null）は新着にしない", !isNewArrival(row({ id: 4, verdict: null }), [], NOW));
  t("送った（sent）は新着にしない", !isNewArrival(row({ id: 5, status: "sent" }), [], NOW));
  t("見送り（skipped）は新着にしない", !isNewArrival(row({ id: 6, status: "skipped" }), [], NOW));
  t("★ 誰かが開いた（seen_at あり）→ 新着でない（既読はスタッフ全員で共有）", !isNewArrival(row({ id: 7, seen_at: at("2026-09-25T12:00:00") }), [], NOW));
  t("画像の保存期間が切れた（expired_at あり）→ 新着でない", !isNewArrival(row({ id: 8, expired_at: at("2026-09-25T03:00:00") }), [], NOW));
  t(`${NEW_ARRIVAL_WINDOW_HOURS}時間を過ぎた → 新着でない（cron が消す前でも）`, !isNewArrival(row({ id: 9, created_at: at("2026-09-22T14:00:00") }), [], NOW));
  t("71時間前 → まだ新着", isNewArrival(row({ id: 10, created_at: at("2026-09-22T16:00:00") }), [], NOW));
  t("届いた時刻が読めない → 新着でない", !isNewArrival(row({ id: 11, created_at: "？" }), [], NOW));
}

console.log("── 送った物件の建物に当たる物は新着として知らせない");
{
  t("★ 同じ建物を送っている → 新着でない", !isNewArrival(row({ id: 20, property_name: "グランパシフィック難波" }), [{ property_name: "グランパシフィック難波" }], NOW));
  t("★ 号室付き・空白の違いでも同じ建物", hitsSentBuilding("グランパシフィック難波 402号室", [{ property_name: "グランパシフィック 難波" }]));
  t("別の建物 → 新着のまま", isNewArrival(row({ id: 21, property_name: "グランパシフィック難波" }), [{ property_name: "エスリード福島" }], NOW));
  t("同じシリーズの別の建物（ハーモニーテラス今林↔田島）は当てない", !hitsSentBuilding("ハーモニーテラス今林", [{ property_name: "ハーモニーテラス田島" }]));
  t("一般名（「物件」）は比べない＝新着のまま", isNewArrival(row({ id: 22, property_name: "物件" }), [{ property_name: "物件" }], NOW));
  t("送った側が空・一般名でも落ちない", !hitsSentBuilding("テスト建物A", [{ property_name: null }, { property_name: "マンション" }]));
}

console.log("── お客様1人分のまとめ・2行目の文");
{
  const rows = [
    row({ id: 31, property_name: "建物ロー", score: 60, created_at: at("2026-09-25T10:00:00"), summary_text: "【2】建物ロー\n賃料 65,000円" }),
    row({ id: 32, property_name: "建物ハイ", score: 82, created_at: at("2026-09-25T09:00:00"), summary_text: "【1】建物ハイ\n7.2万円 管理費5,000円" }),
    row({ id: 33, property_name: "建物ホールド", verdict: "hold", score: 95, created_at: at("2026-09-25T14:00:00") }),
  ];
  const s = summarizeNewArrivals(rows, [], NOW);
  t("数は通すの2件だけ（保留は数えない）", s.count === 2, JSON.stringify(s));
  t("時刻は一番新しい新着（保留の14:00ではなく10:00）", s.at === at("2026-09-25T10:00:00"), String(s.at));
  t("一番は点の高い物（建物ハイ）", s.top?.name === "建物ハイ" && s.top?.rentYen === 72000, JSON.stringify(s.top));
  t("★ 2行目「🆕 新着2件・建物ハイ 7.2万」", newArrivalLine(s) === "🆕 新着2件・建物ハイ 7.2万", String(newArrivalLine(s)));
  t("新着なし → 文なし", newArrivalLine(summarizeNewArrivals([], [], NOW)) === null);
  t("家賃が読めない時は名前だけ", newArrivalLine({ count: 1, top: { id: 1, name: "建物X", rentYen: null } }) === "🆕 新着1件・建物X");
  t("同点は🌟が上", summarizeNewArrivals([row({ id: 41, property_name: "P", score: 70 }), row({ id: 42, property_name: "Q", score: 70, recommended: 1 })], [], NOW).top?.name === "Q");
  t("manYen 75,500 → 7.55万", manYen(75500) === "7.55万");
  t("manYen 100,000 → 10万", manYen(100000) === "10万");
  t("manYen 0 → null", manYen(0) === null);
}

console.log("── トーク一覧の並び（新着のあるお客様を新着の新しい順に上・ほかは元の LINE の順）");
{
  const list = [
    { key: "a", new_count: 0, new_at: null },
    { key: "b", new_count: 2, new_at: at("2026-09-25T10:00:00") },
    { key: "c", new_count: 0, new_at: null },
    { key: "d", new_count: 1, new_at: at("2026-09-25T13:00:00") },
  ];
  t("★ d（13:00）→ b（10:00）→ a → c", sortByNewArrivals(list).map((x) => x.key).join("") === "dbac", sortByNewArrivals(list).map((x) => x.key).join(""));
  t("元の配列は変えない", list.map((x) => x.key).join("") === "abcd");
}

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
