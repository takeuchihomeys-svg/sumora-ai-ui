// 2026-09-24 竹内「同じ建物だと平米数2㎡以内だと家賃がひくい部屋をここにいれて、他の部屋は売上サポに飛ばさなくて大丈夫」
// 実行: npx tsx app/lib/__tests__/pickup-dedupe.test.ts
// 説明文は 2026-09-24 の実物の1回分（property_pickups id 35〜44・拡張の buildPropertySummary の形そのまま）。お客様の情報は無い
import { dedupeSameBuilding, parseAreaSqm, buildingKey, readDedupeRoom, dedupeNoteJa, adTier } from "../pickup-dedupe";
import { buildPickupRows, type PickupItemInput } from "../property-pickups";

let passed = 0, failed = 0;
function t(name: string, ok: boolean, extra?: unknown) {
  if (ok) { passed++; console.log(`  OK  ${name}`); } else { failed++; console.log(`  NG  ${name}${extra !== undefined ? `\n      ${JSON.stringify(extra, (_k, v) => v instanceof Map ? [...v.entries()] : v).slice(0, 400)}` : ""}`); }
}

// ── 実物の1回分（10件） ──
const REAL = [
  "【1🌟★】エステムコート難波Ⅶビヨンド\n78,000円 7,000円\n1K 21.81㎡\nAD 171,600円",
  "【2🌟】スプランディッド難波WEST\n77,000円 7,000円\n1K 22.4㎡\nAD 2ヶ月",
  "【3】エスリード難波AGREA\n76,400円 8,000円\n1K 21.09㎡\nAD 2ヶ月",
  "【4】エスリード難波AGREA\n76,300円 8,000円\n1K 21.83㎡\nAD 2ヶ月",
  "【5🌟】エスリード難波AGREA\n73,100円 8,000円\n1K 21.09㎡\nAD 2ヶ月",
  "【6】エスリード難波AGREA\n77,000円 8,000円\n1K 21.09㎡\nAD 1.5ヶ月",
  "【7】エスリード難波AGREA\n75,800円 8,000円\n1K 21.09㎡\nAD 1.5ヶ月",
  "【8】エスリード難波AGREA\n75,400円 8,000円\n1K 21.83㎡\nAD 1.5ヶ月",
  "【9】エスリード難波AGREA\n75,200円 8,000円\n1K 21.09㎡\nAD 1.5ヶ月",
  "【10】エスリード難波AGREA\n74,200円 8,000円\n1K 21.83㎡\nAD 1.5ヶ月",
];
{
  const r = dedupeSameBuilding(REAL);
  t("★ 実物: 10件 → 3件（エステムコート・スプランディッド・エスリード 73,100円）", JSON.stringify(r.keep) === JSON.stringify([0, 1, 4]), r.keep);
  t("★ 実物: 落とすのは エスリードの 7件", r.dropped.length === 7 && r.dropped.every((d) => d.name === "エスリード難波AGREA" && d.keptRank === 5), r.dropped);
  t("★ 実物: 落とした部屋はどれも 73,100円より高い", r.dropped.every((d) => d.rentYen > 73_100));
  t("★ 実物: 残した【5】に「7件省略」", r.droppedCount.get(4) === 7);
  t("★ 実物: 【5🌟】は自分の 🌟 のまま（落とした中に 🌟 より強い印は無い）", !r.inheritMark.has(4));
  const room = readDedupeRoom(REAL[0], 0);
  t("★ 読み: 家賃 78,000・管理費 7,000（ラベルなしの2つ目の金額）・面積 21.81・AD 171,600円・1K", room.rentYen === 78_000 && room.adminFeeYen === 7_000 && room.areaSqm === 21.81 && room.adYen === 171_600 && room.floorPlan === "1K", room);
  const room5 = readDedupeRoom(REAL[4], 4);
  t("★ 読み: AD 2ヶ月は家賃から円に（146,200円）・順位 5・🌟", room5.adYen === 146_200 && room5.rank === 5 && room5.recommended === 1, room5);
}

// ── 数珠つなぎにしない ──
{
  const r = dedupeSameBuilding([
    "【1】テストレジデンス\n60,000円\n1K 20.0㎡",
    "【2】テストレジデンス\n61,000円\n1K 21.5㎡",
    "【3】テストレジデンス\n62,000円\n1K 23.0㎡",
  ]);
  t("★ 20.0／21.5／23.0（20.0 が最安）→ 21.5 だけ落ち、23.0 は残る（20.0 と 3㎡違う）", JSON.stringify(r.keep) === "[0,2]", r);
}
{
  const r = dedupeSameBuilding([
    "【1】テストレジデンス\n60,000円\n1K 20.0㎡",
    "【2】テストレジデンス\n61,000円\n1K 22.0㎡",
    "【3】テストレジデンス\n62,000円\n1K 22.01㎡",
  ]);
  t("★ ちょうど 2.00㎡差は落とす・2.01㎡差は残す", JSON.stringify(r.keep) === "[0,2]", r.keep);
}

// ── 家賃が同じ時 ──
{
  const r = dedupeSameBuilding([
    "【1】テストコート\n70,000円 9,000円\n1K 25.0㎡\nAD 1ヶ月",
    "【2】テストコート\n70,000円 6,000円\n1K 25.5㎡\nAD 1ヶ月",
  ]);
  t("★ 同じ家賃 → 管理費が低い方を残す", JSON.stringify(r.keep) === "[1]", r.keep);
}
{
  const r = dedupeSameBuilding([
    "【1】テストコート\n70,000円 6,000円\n1K 25.0㎡\nAD 1ヶ月",
    "【2】テストコート\n70,000円 6,000円\n1K 25.5㎡\nAD 2ヶ月",
  ]);
  t("★ 家賃も管理費も同じ → AD が高い方（利益）を残す", JSON.stringify(r.keep) === "[1]", r.keep);
}
{
  const r = dedupeSameBuilding([
    "【1】テストコート\n70,000円 6,000円\n1K 25.0㎡\nAD 1ヶ月",
    "【2】テストコート\n70,000円 6,000円\n1K 25.5㎡\nAD 1ヶ月",
  ]);
  t("★ AD も同じ → 面積が広い方を残す", JSON.stringify(r.keep) === "[1]", r.keep);
}
{
  const r = dedupeSameBuilding([
    "【1】テストコート\n70,000円 6,000円\n1K 25.0㎡\nAD 1ヶ月",
    "【2】テストコート\n70,000円 6,000円\n1K 25.0㎡\nAD 1ヶ月",
  ]);
  t("★ 全部同じ → 元の順位が上を残す", JSON.stringify(r.keep) === "[0]", r.keep);
}

// ── 残す側（誤削除 0） ──
{
  const r = dedupeSameBuilding([
    "【1】テストハイツ\n60,000円\n1K 30.0㎡",
    "【2】テストハイツ\n65,000円\n1LDK 30.5㎡",
  ]);
  t("★ 1K と 1LDK は面積が近くても両方残す", JSON.stringify(r.keep) === "[0,1]", r.keep);
}
{
  const r = dedupeSameBuilding([
    "【1】テストハイツ\n60,000円\n1K",
    "【2】テストハイツ\n65,000円\n1K 25.0㎡",
    "【3】テストハイツ\n1K 25.2㎡",
  ]);
  t("★ 面積・家賃が読めない物は比べずに残す", JSON.stringify(r.keep) === "[0,1,2]", r.keep);
}
{
  const r = dedupeSameBuilding([
    "【1】エスリード難波AGREA\n73,000円\n1K 21.0㎡",
    "【2】エスリード難波グランデ\n74,000円\n1K 21.0㎡",
  ]);
  t("★ 「エスリード難波AGREA」と「エスリード難波グランデ」は別の建物（似ている度は使わない）", JSON.stringify(r.keep) === "[0,1]", r.keep);
}
{
  const r = dedupeSameBuilding([
    "【1】テストビルⅠ\n60,000円\n1K 20.0㎡",
    "【2】テストビルⅡ\n61,000円\n1K 20.0㎡",
  ]);
  t("★ Ⅰ と Ⅱ は別の建物", JSON.stringify(r.keep) === "[0,1]", r.keep);
}
t("★ 「エステムコート難波Ⅶビヨンド」と「エステムコート難波VIIビヨンド」は同じ建物", buildingKey("エステムコート難波Ⅶビヨンド") === buildingKey("エステムコート難波VIIビヨンド"));
t("★ 全角英字・空白の違いは同じ建物", buildingKey("エスリード難波ＡＧＲＥＡ") === buildingKey("エスリード 難波AGREA"));
t("★ 「A号棟」と「A棟」は同じ建物", buildingKey("テストタウンA号棟") === buildingKey("テストタウンA棟"));
{
  const r = dedupeSameBuilding([
    "【1】テストマンション 101\n60,000円\n1K 20.0㎡",
    "【2】テストマンション 305\n63,000円\n1K 21.0㎡",
  ]);
  t("★ 号室が違っても同じ建物（号室は名前から外れる）", JSON.stringify(r.keep) === "[0]", r.keep);
}

// ── 印の引き継ぎ ──
{
  const r = dedupeSameBuilding([
    "【1🌟★】テストレジデンス\n65,000円\n1K 20.5㎡",
    "【2】テストレジデンス\n60,000円\n1K 20.0㎡",
  ]);
  t("★ 落とした部屋の 🌟★ を残した部屋に引き継ぐ", JSON.stringify(r.keep) === "[1]" && r.inheritMark.get(1) === 2, r);
  const items: PickupItemInput[] = r.keep.map((i) => ({
    summary: ["【1🌟★】テストレジデンス\n65,000円\n1K 20.5㎡", "【2】テストレジデンス\n60,000円\n1K 20.0㎡"][i],
    pdfUrl: null, pdfBlobUrl: null, pdfText: null, judgment: null,
    recommendedOverride: r.inheritMark.get(i), extraReasonsJa: [dedupeNoteJa(r.droppedCount.get(i) ?? 0)],
  }));
  const rows = buildPickupRows({ batchId: "b", propertyCustomerId: null, conversationId: null, customerName: null, site: null }, items);
  t("★ 行: 順位は元のまま（2）・印は 🌟★（2）・理由に「1件省略」", rows.length === 1 && rows[0].rank === 2 && rows[0].recommended === 2 && (rows[0].reasons_ja ?? []).some((s) => s.includes("1件省略")), rows[0]);
}

{
  // 2026-09-25 YUMA テスト（お客様A・itandi の実物 id 58 と id 60 の説明文を補った形）: 🌟★ は AD 2.5ヶ月の 907号室。
  //   旧: 2,000円安い 413号室（AD 0.5ヶ月・利益が出ない）を残して 🌟★ を引き継ぎ → 売上サポで一番オススメが保留の物件に付いた
  const S = [
    "【1🌟★】エステムコート新大阪VIエキスプレイス 907号室\n60,000円 管理費8,000円\n1K 20.8㎡\n大阪メトロ御堂筋線「新大阪」徒歩8分\nAD 2.5ヶ月",
    "【2】エステムコート新大阪VIエキスプレイス 413号室\n58,000円 管理費7,000円\n1K 20.88㎡\n大阪メトロ御堂筋線「新大阪」徒歩9分\nAD 0.5ヶ月",
    "【3】エステムコート新大阪VIエキスプレイス 1512号室\n59,000円 管理費8,000円\n1K 20.88㎡\n大阪メトロ御堂筋線「新大阪」徒歩8分\nAD 1ヶ月",
  ];
  const r = dedupeSameBuilding(S);
  t("★ AD の段が高い 🌟★（2.5ヶ月）は、安い部屋（0.5ヶ月）があっても落とさない", r.keep.includes(0) && r.keep.includes(1), r);
  t("★ その時 🌟★ は安い部屋に引き継がない", !r.inheritMark.has(1), r);
  t("★ 印の無い部屋（1512・AD 1ヶ月）は今まで通り安い部屋に寄せて落とす", !r.keep.includes(2) && r.dropped.some((d) => d.index === 2 && d.keptIndex === 1), r.dropped);
  // AD の段が同じ（どちらも 2ヶ月）なら今まで通り（実物の AGREA: 🌟★ 1107号室 76,300円 → 206号室 73,100円 に寄せて引き継ぐ）
  const r2 = dedupeSameBuilding([
    "【1】エスリード難波AGREA 206号室\n73,100円 8,000円\n1K 21.09㎡\nAD 2ヶ月",
    "【2🌟★】エスリード難波AGREA 1107号室\n76,300円 8,000円\n1K 21.83㎡\nAD 2ヶ月",
  ]);
  t("★ AD の段が同じなら安い部屋に寄せて 🌟★ を引き継ぐ（今まで通り）", JSON.stringify(r2.keep) === "[0]" && r2.inheritMark.get(0) === 2, r2);
  // 2026-09-25 YUMA テスト（お客様C）: 🌟 の 710（AD 2ヶ月）と 🌟★ の 307（AD 2ヶ月）が両方残り、同じ建物が 3部屋並んだ
  //   → 同じ段以上の部屋をもう残していればそちらに寄せて、強い印（🌟★）を引き継ぐ
  const S4 = [
    "【1】エステムコート新大阪VIエキスプレイス 413号室\n58,000円 管理費7,000円\n1K 20.88㎡\nAD 0.5ヶ月",
    "【2🌟】エステムコート新大阪VIエキスプレイス 710号室\n58,000円 管理費10,000円\n1K 20.88㎡\nAD 2ヶ月",
    "【3】エステムコート新大阪VIエキスプレイス 1512号室\n59,000円 管理費8,000円\n1K 20.88㎡\nAD 1ヶ月",
    "【4🌟★】エステムコート新大阪VIエキスプレイス 307号室\n60,000円 管理費7,910円\n1K 20.8㎡\nAD 2ヶ月",
  ];
  const r4 = dedupeSameBuilding(S4);
  t("★ 同じ段の 🌟 が2つ → 安い 413 と 710 の2部屋だけ残す", JSON.stringify(r4.keep) === "[0,1]", r4);
  t("★ 307 の 🌟★ は同じ段の 710 に引き継ぐ（413 には引き継がない）", r4.inheritMark.get(1) === 2 && !r4.inheritMark.has(0), [...r4.inheritMark.entries()]);
  // 2026-09-25 YUMA テスト（お客様B）: 送付済みの 710号室が一番安いので残り、まだ送っていない部屋を落としていた
  const S3 = [
    "【1】エステムコート新大阪VIエキスプレイス 405号室\n67,000円 管理費なし\n1K 20.8㎡\nAD 1ヶ月",
    "【2】エステムコート新大阪VIエキスプレイス 710号室\n58,000円 管理費10,000円\n1K 20.88㎡\nAD 2ヶ月",
    "【3】エステムコート新大阪VIエキスプレイス 907号室\n60,000円 管理費8,000円\n1K 20.8㎡\nAD 2.5ヶ月",
  ];
  const r3 = dedupeSameBuilding(S3, { isSent: (i) => i === 1 });
  t("★ 送付済みの部屋（710）は残す部屋に選ばない → まだ送っていない一番安い 907 を残す", JSON.stringify(r3.keep) === "[2]", r3);
  t("★ isSent が無ければ今まで通り一番安い 710", JSON.stringify(dedupeSameBuilding(S3).keep) === "[1]");
  t("★ 全部送付済みなら今まで通り一番安い部屋", JSON.stringify(dedupeSameBuilding(S3, { isSent: () => true }).keep) === "[1]");
  t("★ AD の段: 円は家賃で月数に（171,600円÷78,000円＝2.2ヶ月→3）・0.5ヶ月→1・なし→0", adTier({ adYen: 171_600, rentYen: 78_000 }) === 3 && adTier({ adYen: 29_000, rentYen: 58_000 }) === 1 && adTier({ adYen: null, rentYen: 58_000 }) === 0 && adTier({ adYen: 146_200, rentYen: 73_100 }) === 3);
}

{
  // 反証レビュー（2026-09-24）: 説明文に【N】が無い時、詰まった items の i+1 で番号を振ると LINE グループの番号とずれる → 元の番号
  const S = ["A棟\n60,000円\n1K 20㎡", "A棟\n61,000円\n1K 20.5㎡", "B荘\n55,000円\n1K 25㎡"];
  const r = dedupeSameBuilding(S);
  const items: PickupItemInput[] = r.keep.map((i) => ({
    summary: S[i], pdfUrl: null, pdfBlobUrl: null, pdfText: null, judgment: null, fallbackRank: i + 1,
    extraReasonsJa: (r.droppedCount.get(i) ?? 0) > 0 ? [dedupeNoteJa(r.droppedCount.get(i) ?? 0)] : null,
  }));
  const rows = buildPickupRows({ batchId: "b", propertyCustomerId: null, conversationId: null, customerName: null, site: null }, items);
  t("★ 行: 【N】が無くても元の番号（1・3）", rows.map((x) => x.rank).join(",") === "1,3", rows.map((x) => x.rank));
  t("★ 行: 省略の一文は理由の先頭（画面は先頭3つだけ出す）", (rows[0].reasons_ja ?? [])[0]?.includes("1件省略") === true, rows[0].reasons_ja);
}

// ── 面積の読み ──
t("★ 面積: 21.09㎡", parseAreaSqm("【1】A\n1K 21.09㎡") === 21.09);
t("★ 面積: 全角 ２５．５ｍ２", parseAreaSqm("【1】A\n1K ２５．５ｍ２") === 25.5);
t("★ 面積: 平米", parseAreaSqm("【1】A\n30平米") === 30);
t("★ 面積: 名前の行の数字は読まない", parseAreaSqm("【1】ヴィラ25㎡\n60,000円") === null);
t("★ 面積: 1件だけ・空は何もしない", JSON.stringify(dedupeSameBuilding(["【1】A\n60,000円\n1K 20㎡"]).keep) === "[0]" && dedupeSameBuilding([]).keep.length === 0);

// ── 一般名（2026-09-24 竹内「前回の反証で出た点も直す」）──
{
  const r = dedupeSameBuilding([
    "【1】物件\n60,000円\n1K 20.0㎡",
    "【2】物件\n61,000円\n1K 20.5㎡",
    "【3】マンション\n62,000円\n1K 20.2㎡",
    "【4】マンション\n63,000円\n1K 20.3㎡",
  ]);
  t("★ 一般名: 「物件」「マンション」どうしは同じ建物と見なさない（全部残す）", JSON.stringify(r.keep) === "[0,1,2,3]", r.keep);
  t("★ 一般名: 鍵は空・普通の名前は鍵あり", buildingKey("物件") === "" && buildingKey("【2】 マンション") === "" && buildingKey("エスリード難波AGREA") !== "");
  t("★ 一般名: 「テストレジデンス」は一般名ではない", buildingKey("テストレジデンス") !== "");
}

console.log(`\n${passed} passed, ${failed} failed`);
if (failed > 0) process.exit(1);
