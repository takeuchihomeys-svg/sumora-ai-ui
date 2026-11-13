// scripts/test-ref-resolve.ts — 指す物を解く欄 ref_resolve と、送った物件の一覧の束の番号・見積の初期費用（REF_RESOLVE 既定 off・LLM/DB なし・費用0）
// 実行: npx tsx scripts/test-ref-resolve.ts
// 実例3番（名前と物件名は伏せた）: 12105（送ってきてくれたやつで初期費用5万以内はあれだけ？）・12555（URL の号室が引けない）・10911（画像の物件名が空・読み取り「難皮」）
import assert from "node:assert/strict";
import { resolveRefs, refCountOf, refResolveLine, refResolveDigest, portalIdOf, nameSimilarity, refResolveOn, type RefSent } from "../app/lib/ref-resolve";
import { attachBundles, parseEstimateTexts, attachEstimates, buildSentProps, buildSentPropsText } from "../app/lib/sent-props-text";

let n = 0;
const t = (name: string, f: () => void) => { f(); n++; console.log("ok", name); };

t("既定 off", () => { assert.equal(refResolveOn({}), false); assert.equal(refResolveOn({ REF_RESOLVE: "shadow" }), true); });

t("送った物件の一覧: 束の番号（何回目・何件目）・送ったのはこちら・見積の初期費用と見積の号室（AIX【見積書】の本文から）", () => {
  const props = buildSentProps({ customerRows: [
    { property_name: "Aハイツ", room_no: "101", sent_at: "2026-11-01T03:00:00Z" },
    { property_name: "Bコート", room_no: "202", sent_at: "2026-11-01T03:00:30Z" },
    { property_name: "Cレジデンス", room_no: "303", sent_at: "2026-11-03T05:00:00Z" },
  ], imageRows: [], sharedRows: [] });
  assert.equal(attachBundles(props), 2);
  assert.deepEqual(props.map((p) => [p.bundle_no, p.bundle_pos, p.sent_by]), [[1, 1, "ours"], [1, 2, "ours"], [2, 1, "ours"]]);
  const ests = parseEstimateTexts([{ generated_text: "①【Aハイツ 101号室】\n\n初期費用さらに\n🌟33,000円割引させて頂き\n初期費用：48,000円\n\n②【Bコート 205号室】\n初期費用：120,500円", sent_at: "2026-11-02T01:00:00Z" }]);
  assert.deepEqual(ests.map((e) => [e.property_name, e.room_no, e.initial_cost]), [["Aハイツ", "101", 48000], ["Bコート", "205", 120500]]);
  assert.equal(attachEstimates(props, ests), 1, "号室が違う見積は付けない（Bコート 202 と 205）");
  const text = buildSentPropsText(props);
  assert.match(text, /Aハイツ 101（.*1回目の送信の1件目・御見積書の初期費用48,000円/);
  // 付けていない時は今と同じ（束・見積の字は出ない）
  assert.doesNotMatch(buildSentPropsText(buildSentProps({ customerRows: [{ property_name: "Aハイツ", room_no: "101", sent_at: "2026-11-01T03:00:00Z" }], imageRows: [], sharedRows: [] })), /回目の送信|御見積書の初期費用/);
});

const sent12105: RefSent[] = [
  { name: "Aハイツ", room: "101", sent_at: "2026-11-01T03:00:00Z", bundle_no: 1, bundle_pos: 1, estimate_initial_cost: 48000 },
  { name: "Bコート", room: "202", sent_at: "2026-11-01T03:00:30Z", bundle_no: 1, bundle_pos: 2, estimate_initial_cost: 120500 },
  { name: "Cレジデンス", room: "303", sent_at: "2026-11-01T03:01:00Z", bundle_no: 1, bundle_pos: 3, estimate_initial_cost: 95000 },
];

t("12105: 前＝持ち込みと取り違え／後＝こちらが送った物件を見積の初期費用5万以内で絞る（Aハイツ 101 だけ・確か）", () => {
  const before = { kind: "brought" };
  const r = resolveRefs({ text: "送ってきてくれたやつで初期費用5万以内はあれだけ？", sent: sent12105, brought: [{ name: "Dマンション", room: null, at: "2026-11-02T00:00:00Z", from: "url", url: "https://suumo.jp/chintai/jnc_000011112222/" }] });
  assert.equal(r.items.length, 1);
  const it = r.items[0];
  assert.notEqual(it.kind, before.kind);
  assert.equal(it.kind, "ours");
  assert.deepEqual(it.targets, [{ name: "Aハイツ", room: "101" }]);
  assert.ok(it.clues.includes("cost_filter"));
  assert.equal(it.certainty, "high");
  assert.equal(refCountOf(r), 1);
  assert.match(refResolveLine(r) ?? "", /こちらが送った物件: Aハイツ 101/);
  // 見積の初期費用が無い時は絞らず needs_cost の印
  const noCost = resolveRefs({ text: "送ってきてくれたやつで初期費用5万以内はあれだけ？", sent: sent12105.map((s) => ({ ...s, estimate_initial_cost: null })), brought: [] });
  assert.match(noCost.items[0].note ?? "", /needs_cost/);
});

t("12555: URL の号室が引けない＝持ち込み・不確か・needs_room（次の番の掲載と見積の食い違いの入口）", () => {
  const url = "https://www.homes.co.jp/chintai/room/abc123def456/";
  assert.deepEqual(portalIdOf(url), { site: "homes", id: "abc123def456" });
  assert.deepEqual(portalIdOf("https://suumo.jp/chintai/jnc_000098765432/?bc=100"), { site: "suumo", id: "000098765432" });
  const r = resolveRefs({ text: `${url} ここ空いてますか？`, sent: [], brought: [{ name: "Eビル", room: null, at: "2026-11-05T00:00:00Z", url, portal_id: "abc123def456", from: "url" }] });
  const u = r.items.find((x) => x.word === "URL")!;
  assert.deepEqual([u.kind, u.targets[0].name, u.targets[0].room, u.certainty], ["brought", "Eビル", null, "low"]);
  assert.match(u.note ?? "", /needs_room/);
  assert.match(refResolveDigest(r) ?? "", /brought:1:low:needs_room/);
  // 台帳に無い id は needs_name
  assert.match(resolveRefs({ text: "https://suumo.jp/chintai/jnc_000000000001/", sent: [], brought: [] }).items[0].note ?? "", /needs_name（suumo 000000000001/);
});

t("10911: 画像の物件名が空・読み取り「難皮」＝似た名前（1字違い）で送った物件「難波レジデンス」に当てる（たぶん）", () => {
  assert.ok(nameSimilarity("難皮レジデンス", "難波レジデンス") >= 0.8);
  const r = resolveRefs({ text: "[画像] この物件はどうですか", sent: [{ name: "難波レジデンス", room: "502", sent_at: "2026-10-01T00:00:00Z", bundle_no: 1, bundle_pos: 1 }], brought: [{ name: null, room: null, at: "2026-10-02T00:00:00Z", from: "image", image_name: "難皮レジデンス" }] });
  const img = r.items.find((x) => x.word === "画像")!;
  assert.deepEqual([img.kind, img.targets[0]?.name, img.certainty], ["brought", "難波レジデンス", "mid"]);
  assert.match(img.note ?? "", /難皮レジデンス/);
  // 読み取りも空なら needs_name
  const empty = resolveRefs({ text: "[画像]", sent: [], brought: [{ name: null, room: null, at: "2026-10-02T00:00:00Z", from: "image", image_name: null }] });
  assert.match(empty.items[0].note ?? "", /needs_name（画像の物件名が空）/);
});

t("束の何件目・↑・引用・複数の指す物（深さの札 refCount）", () => {
  assert.deepEqual(resolveRefs({ text: "2件目の物件の駐車場は？", sent: sent12105, brought: [] }).items[0].targets, [{ name: "Bコート", room: "202" }]);
  const up = resolveRefs({ text: "↑の3件どれも良いですね", sent: sent12105, brought: [], lastStaffSentBundle: true });
  assert.deepEqual([up.items[0].kind, up.items[0].targets.length, up.items[0].certainty], ["ours", 3, "mid"]);
  assert.equal(refCountOf(up), 3);
  const q = resolveRefs({ text: "これの初期費用は？", sent: sent12105, brought: [], quotedText: "Cレジデンス 303号室の資料です" });
  assert.deepEqual([q.items[0].targets, q.items[0].certainty], [[{ name: "Cレジデンス", room: "303" }], "high"]);
  // 指す言葉が無い文は空（数えない）
  assert.deepEqual(resolveRefs({ text: "よろしくお願いします", sent: sent12105, brought: [] }), { items: [], refCount: 0 });
});

console.log(`全部 ${n} 件 ok`);
