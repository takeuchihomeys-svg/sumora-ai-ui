// npx tsx app/lib/__tests__/sentence-pattern-catalog.test.ts — 文型カタログ（2026-11-12 作業員23・根B）＋解剖の欄（根C）
import assert from "node:assert/strict";
import { existsSync, readFileSync, writeFileSync, mkdtempSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { skeletonize, skeletonKey, openerWordOf, openerBranchOf, buildPatternCatalog, patternCatalogNote, aixBodySentences, LATENT_NINE, type CatalogTurn } from "../sentence-pattern-catalog";
import { patternCatalogNoteFor } from "../sentence-pattern-catalog-server";
import { keepPromiseOf, turnAnatomyOf, nearAnatomyMajority, nearAnatomyLine, nearAnatomyOn, deadlineOf, leadOfText } from "../turn-anatomy-fields";
import { propertyNameVariants } from "../takeuchi-exemplar-row";

let n = 0;
const t = (name: string, f: () => void) => { f(); n++; void name; };

t("骨: 名前・物件名・号室・金額・日付・時刻は差し込み欄に", () => {
  const pn = propertyNameVariants(["プレジオ神戸WEST 203号室"]);
  const a = skeletonize("YUMAさんお世話になっております!!", pn);
  assert.equal(a.skeleton, "{名前}さんお世話になっております!!");
  const b = skeletonize("お送りさせて頂きましたお部屋の中でも特にプレジオ神戸WEST 203号室が家賃管理費込90,000円となります!!", pn);
  assert.ok(!b.skeleton.includes("プレジオ") && !b.skeleton.includes("203") && !b.skeleton.includes("90,000"), b.skeleton);
  assert.ok(b.slots.includes("{物件名}") && b.slots.includes("{金額}"));
  const c = skeletonize("11月20日の14時にお部屋ご案内させて頂きます!", []);
  assert.ok(c.skeleton.includes("{日付}") && c.skeleton.includes("{時刻}") && !/[0-9]/.test(c.skeleton), c.skeleton);
  const d = skeletonize("ラクラス阿倍野元町 0507 のお部屋", []);
  assert.ok(!d.skeleton.includes("ラクラス"), "一覧に無い物件名も部屋番号の前なら伏せる: " + d.skeleton);
  const e = skeletonize("西区・浪速区周辺全域から家賃7万円以内・1LDKで田中さんにオススメできるお部屋ピックアップしてお送りさせて頂きます!!", []);
  assert.equal(e.skeleton, "{エリア}から{条件}で{名前}さんにオススメできるお部屋ピックアップしてお送りさせて頂きます!!");
});
t("骨の鍵: 絵文字・小さな揺れは同じ", () => {
  assert.equal(skeletonKey("何卒よろしくお願い致します😌!!"), skeletonKey("何卒よろしくお願い致します!!"));
  assert.equal(skeletonKey("お部屋を新たにピックアップ"), skeletonKey("お部屋ピックアップ"));
});
t("開口語と3分岐", () => {
  assert.equal(openerWordOf("かしこまりました😊!!"), "kashikomari");
  assert.equal(openerWordOf("はい😊!!"), "hai");
  assert.equal(openerWordOf("ご条件お送り頂きありがとうございます!!"), "arigato");
  assert.equal(openerWordOf(null), "none");
  assert.equal(openerBranchOf({ customer: "[画像] 【物件情報】", lead: "estimate", roles: [] }), "received");
  assert.equal(openerBranchOf({ customer: "広い所がいいです", lead: "keep", roles: [] }), "act");
  assert.equal(openerBranchOf({ customer: "駐車場ありますか", lead: "answer_only", roles: ["answer"] }), "answer");
});
t("潜在の型は9種", () => { assert.equal(LATENT_NINE.length, 9); assert.ok(!LATENT_NINE.includes("none" as never)); });
t("AIX の本文: 箇条書き・記入欄・挨拶を除き、折り返しをつなぐ", () => {
  const s = aixBodySentences("YUMAさんお世話になっております!!\n初期費用さらに\n🌟5万円割引させて頂きます!!\n・家賃6万円\n住所: 大阪市\nお手隙の際にご査収ください😌!!");
  assert.equal(s[0], "初期費用さらに🌟5万円割引させて頂きます!!");
  assert.equal(s[s.length - 1], "お手隙の際にご査収ください😌!!");
  assert.ok(!s.some((x) => x.includes("住所") || x.startsWith("・")));
});

const turn = (id: string, o: Partial<CatalogTurn> = {}): CatalogTurn => ({ id, scene: "conditions", latent: "living", lead: "keep", customer: "広い所がいいです", fact: null, sentences: [
  { text: "かしこまりました😊!!", role: "uke" },
  { text: `${id}さんがご満足頂くお部屋が見つかるまで全力でサポートさせて頂きます!!`, role: "trust" },
  { text: `独自の言い方 ${id} だけの文です!!`, role: "keep" },
  { text: "何卒よろしくお願い致します😊!!", role: "close" },
], ...o });

t("カタログ: 2通以上の骨だけ・割合・本文は写さない", () => {
  const cat = buildPatternCatalog([turn("Aa"), turn("Bb"), turn("Cc")], [], { now: "x" });
  const close = cat.groups.find((g) => g.kind === "close" && g.scene === "*" && g.situation === "keep")!;
  assert.equal(close.n, 3); assert.equal(close.top, 1);
  const keep = cat.groups.find((g) => g.kind === "keep" && g.scene === "*");
  assert.equal(keep, undefined, "1通だけの言い方は載せない");
  const s = JSON.stringify(cat);
  assert.ok(!s.includes("独自の言い方") && !s.includes("Aaさん"), "1通だけの文・名前は出ない");
  const kp = cat.keepPromise.find((k) => k.kind === "until_found")!;
  assert.equal(kp.n, 3);
  const kg = cat.groups.find((g) => g.kind === "keep_promise" && g.scene === "*" && g.situation === "until_found")!;
  assert.ok(kg.patterns[0].skeleton.startsWith("{名前}さんがご満足"));
  assert.equal(cat.opener.find((o) => o.branch === "act")!.expectedShare, 1);
});
t("潜在の一文: 書いた割合と事実で言う／言わない・通が少ない型は言わない・上書き", () => {
  const w = (id: string) => turn(id, { latent: "screening", fact: "通りやすい保証会社", sentences: [{ text: "審査に通りやすい保証会社でご案内させて頂きます!!", role: "barrier" }] });
  const turns = [...["a", "b", "c", "d", "e"].map(w), ...["f", "g", "h", "i", "j"].map((id) => turn(id, { latent: "viewing_slot" }))];
  const cat = buildPatternCatalog(turns, []);
  assert.equal(cat.latentSay.find((x) => x.latent === "screening")!.say, true);
  assert.equal(cat.latentSay.find((x) => x.latent === "viewing_slot")!.say, false);
  assert.equal(cat.latentSay.find((x) => x.latent === "taken")!.few, true);
  assert.equal(buildPatternCatalog(turns, [], { noSay: ["screening"] }).latentSay.find((x) => x.latent === "screening")!.say, false);
});
t("注記: off なら出ない・on で骨と割合だけ", () => {
  const cat = buildPatternCatalog([turn("Aa"), turn("Bb"), turn("Cc")], []);
  const key = { scene: "conditions", latent: "living" as const, lead: "keep" as const, branch: "act" as const, keepKind: "until_found" as const };
  assert.equal(patternCatalogNote(cat, key, {}), null);
  const note = patternCatalogNote(cat, key, { SENTENCE_PATTERN_CATALOG: "on" })!;
  assert.ok(note.includes("かしこまりました") && note.includes("締め") && note.includes("継続の約束") && !note.includes("独自の言い方"), note);
  assert.equal(patternCatalogNote(null, key, { SENTENCE_PATTERN_CATALOG: "on" }), null);
});
t("サーバー: ファイルが無い・壊れている・off なら null", () => {
  const dir = mkdtempSync(join(tmpdir(), "w23-pc-"));
  const bad = join(dir, "bad.json"); writeFileSync(bad, "{");
  const good = join(dir, "good.json"); writeFileSync(good, JSON.stringify(buildPatternCatalog([turn("Aa"), turn("Bb")], [])));
  const o = { scene: "conditions", customerText: "広い所", meta: { reply_direction: "ピックアップしてお送りする" } };
  assert.equal(patternCatalogNoteFor(o, { SENTENCE_PATTERN_CATALOG_FILE: good }), null);
  assert.equal(patternCatalogNoteFor(o, { SENTENCE_PATTERN_CATALOG: "on" }), null);
  assert.equal(patternCatalogNoteFor(o, { SENTENCE_PATTERN_CATALOG: "on", SENTENCE_PATTERN_CATALOG_FILE: bad }), null);
  assert.equal(patternCatalogNoteFor(o, { SENTENCE_PATTERN_CATALOG: "on", SENTENCE_PATTERN_CATALOG_FILE: join(dir, "none.json") }), null);
  assert.ok(patternCatalogNoteFor(o, { SENTENCE_PATTERN_CATALOG: "on", SENTENCE_PATTERN_CATALOG_FILE: good })?.note.includes("締め"));
});

// ── 根C: 解剖の欄・近い番の多数派 ──
t("継続の約束 {種類, 理由の事実}", () => {
  assert.deepEqual(keepPromiseOf("引き続き新着でオススメ出来るお部屋募集に出次第お送りさせて頂きます!!"), { kind: "new_listing", reason: null });
  assert.equal(keepPromiseOf("ご満足頂くお部屋が見つかるまで全力でサポートさせて頂きます!!")?.kind, "until_found");
  assert.deepEqual(keepPromiseOf("1部屋のみの募集となりますのでお気に召されましたらお申込しお部屋押さえさせていただきます!!"), { kind: "invite", reason: "one_room" });
  assert.equal(keepPromiseOf("駐車場はございます!!"), null);
});
t("解剖の欄: 誘導先・締め・期日・推す点", () => {
  const a = turnAnatomyOf("かしこまりました!!\n西区周辺全域からお部屋ピックアップ出来次第お送りさせて頂きます!!\n何卒よろしくお願い致します😊!!");
  assert.equal(a.lead, "keep"); assert.equal(a.close, "nanitozo"); assert.equal(a.keep, "new_listing"); assert.equal(a.deadline, "as_soon");
  assert.equal(deadlineOf("明日中にピックアップしましたお部屋お送りさせて頂きます"), "tomorrow");
  assert.equal(leadOfText("お気に召されましたらお申込しお部屋抑えさせて頂きます"), "apply");
  assert.deepEqual(turnAnatomyOf("専有面積40.52㎡のゆとりある広さ・徒歩5分").appeal, ["size", "station"]);
});
t("近い番の多数派: 5件未満は出さない・割合の低い欄は出さない・off が既定", () => {
  const A = turnAnatomyOf("ピックアップしてお送りさせて頂きます!!\n何卒よろしくお願い致します!!");
  const B = turnAnatomyOf("駐車場はございます!!\n何卒よろしくお願い致します!!");
  assert.equal(nearAnatomyMajority([A, A, A, A]), null);
  const m = nearAnatomyMajority([A, A, A, A, B])!;
  assert.equal(m.lead?.v, "keep"); assert.equal(m.close?.v, "nanitozo");
  const m2 = nearAnatomyMajority([A, A, A, B, B])!;
  assert.equal(m2.lead?.v, "keep", "60% は出す");
  const mixed = nearAnatomyMajority([A, A, B, B, turnAnatomyOf("ご内覧させて頂きます")])!;
  assert.equal(mixed.lead, null, "割合が低い欄は出さない");
  assert.ok(nearAnatomyLine(m).includes("誘導先") && !nearAnatomyLine(m).includes("ピックアップしてお送り"), "文は渡さない");
  assert.equal(nearAnatomyLine(null), "");
  assert.equal(nearAnatomyOn({}), false);
});

// 手元に作業員5 の材料があれば、実物のカタログに名前・物件名が残らないか（倉庫の外・無ければ飛ばす・DB は読まない）
const catPath = join(process.cwd(), "..", "..", "exam-cache", "anatomy-seven", "pattern-catalog.json");
if (existsSync(catPath)) {
  t("実物のカタログ: 名前・物件名・部屋番号が残らない", () => {
    const s = readFileSync(catPath, "utf8").normalize("NFKC").replace(/\s+/g, "");
    assert.ok(!/YUMA/.test(s), "名前");
    const raw: string[] = [];
    for (const f of ["seven-latent4.json", "seven-latent4b.json"]) { const p = join(catPath, "..", f); if (existsSync(p)) for (const o of JSON.parse(readFileSync(p, "utf8")) as Array<{ reads?: Array<{ part?: { property?: string | null } } | null> }>) { const v = o.reads?.[0]?.part?.property; if (v) raw.push(v); } }
    const probes = [...new Set(raw.flatMap((v) => { const x = v.normalize("NFKC"); return [x.replace(/\s+/g, ""), x.split(/\s+/)[0]]; }).filter((x) => x.length >= 3 && !/物件|URL|^[0-9]/i.test(x)))];
    const left = probes.filter((p) => s.includes(p));
    assert.equal(left.length, 0, `物件名が残った: ${left.length}個`);
    assert.ok(!/[0-9]{3,4}号室/.test(s), "部屋番号");
    console.log(`  実物のカタログ: 確かめた物件名 ${probes.length}個 → 残り0`);
  });
}
console.log(`sentence-pattern-catalog: ${n} pass`);
