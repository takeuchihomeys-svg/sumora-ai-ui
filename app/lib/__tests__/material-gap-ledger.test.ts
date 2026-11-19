// 材料の抜けの台帳（app/lib/material-gap-ledger.ts）と人が直した番の数え（scripts/lib/material-gap-count.ts）のテスト
// 実行: npx tsx app/lib/__tests__/material-gap-ledger.test.ts
import { materialBookOf, materialBooksDigest, materialGapBooksMode, materialGapsDigest, materialGapLedgerMode, gapsFromInfoCells, gapsFromCutRecords, gapsFromSelfReport, gapsFromTurnMust, buildGapLedger, gapLedgerDigest, tallyGaps, GAP_EFFECTS } from "../material-gap-ledger";
import { classifySentContent, gapsFromSpot, countSpots, SPOT_EFFECT } from "../../../scripts/lib/material-gap-count";
let pass = 0, fail = 0;
const ok = (n: string, c: boolean, d = "") => { if (c) pass++; else { fail++; console.log(`✗ ${n} ${d}`); } };

ok("既定 off・shadow／on は記録だけ", materialGapLedgerMode({}) === "off" && materialGapLedgerMode({ MATERIAL_GAP_LEDGER: "shadow" }) === "shadow" && materialGapLedgerMode({ MATERIAL_GAP_LEDGER: "on" }) === "shadow");
ok("効き目は疑いの印の9種", GAP_EFFECTS.length === 9);
{
  const g = gapsFromInfoCells([{ key: "area", state: "known" }, { key: "layout", state: "unknown" }, { key: "move_in", state: "stale", why: "入居時期の月が過ぎている" }, { key: "apply_form", state: "unwired" }], "hearing");
  ok("情報の土台: 分かっていない=a・古い=d・届いていない=c・分かっている物は入れない", g.map((x) => `${x.what.name}:${x.why}`).join() === "layout:a,move_in:d,apply_form:c", JSON.stringify(g));
}
ok("切ったログ=c（最終チェックは書き手の役）", (() => { const g = gapsFromCutRecords([{ label: "final_check:rules", cut: 300 }, { label: "brain:ai_summary", cut: 0 }]); return g.length === 1 && g[0].why === "c" && g[0].forRole === "writer"; })());
{
  const g = gapsFromSelfReport(["管理会社の回答", "送れる物件の候補", "入居者アプリの種類"]);
  ok("自己申告: スタッフの側=e・システムの側=b・会社の知識=a", g.map((x) => x.why).join() === "e,b,a", JSON.stringify(g.map((x) => [x.what.name, x.why])));
}
ok("今の番の物件の取りこぼし=b", gapsFromTurnMust([{ table: "sent_properties", name: "ALEGRIA枚方公園Ⅱ" }])[0].why === "b");
{
  const led = buildGapLedger(gapsFromTurnMust([{ table: "t", name: "x" }]), gapsFromTurnMust([{ table: "t", name: "x" }]));
  ok("重なりは1つ", led.length === 1);
  ok("digest の形", gapLedgerDigest(led)[0] === "property_record:t:x|brain|db_table|b|fact_missed");
  ok("数え", tallyGaps(led).why.b === 1);
}
ok("meta の形: 無ければ undefined", materialGapsDigest([], []) === undefined && (materialGapsDigest(["管理会社の回答"], ["viewings"])?.length ?? 0) === 2);
// 人が直した番（weak-spots の実物の例）
ok("金額だけ人の送信にある → 金額・c", classifySentContent("初期費用：135,430円となります！！", "はい！！", "fact_fix")?.name === "金額（見積・初期費用・家賃）");
ok("地域・相場だけ人の送信にある → a", classifySentContent("大阪市内の治安の良いエリアとなりますので2LDKの家賃相場が高いエリアとなります！！", "はい！！", "fact_fix")?.why === "a");
ok("人しか知らない事 → e", classifySentContent("管理会社に確認したところ空室です", "", "other")?.why === "e");
ok("長さ・挨拶の型は材料の抜けではない", gapsFromSpot({ key: "k", bucket: "reply_edit", scene: "s", type: "longer", n: 5 }).length === 0 && SPOT_EFFECT.greeting_added === null);
{
  const r = countSpots([
    { key: "1", bucket: "reply_edit", scene: "その他", type: "fact_fix", n: 4, examples: [{ draft: "はい！！", sent: "大阪市内の治安の良いエリアとなりますので相場が高いエリアとなります" }, { draft: "はい", sent: "初期費用：135,430円" }] },
    { key: "2", bucket: "reply_edit", scene: "質問", type: "promise_escape", n: 2, examples: [{ draft: "確認させて頂きます", sent: "こちら設備にバス・トイレ別となります" }] },
  ]);
  ok("数え: 合計と a〜e", r.total === 6 && r.why.a === 2 && r.why.c === 2 && r.why.b === 2, JSON.stringify(r));
  ok("数え: 効き目", r.effect.fact_missed === 4 && r.effect.held_answerable === 2, JSON.stringify(r.effect));
}
// 2026-11-13 帳面の6つ×印（G1 親 680）: 実物は 11/12〜13 のブレインの自己申告（digest.mm）の名前
{

  ok("帳面: 既定 off", materialGapBooksMode({}) === "off" && materialGapBooksMode({ MATERIAL_GAP_BOOKS: "shadow" }) === "shadow");
  const B = (l: string) => { const b = materialBookOf(l); return `${b.book}|${b.mark}`; };
  ok("電話で話した内容＝電話・スタッフ", B("お電話で話した内容") === "phone|staff");
  ok("スライド交渉の結果＝管理会社の結果・スタッフ", B("8階スライド交渉の結果") === "mgmt_result|staff");
  ok("代表の割引可否＝管理会社の結果・スタッフ", B("代表の割引可否") === "mgmt_result|staff");
  ok("募集状況＝管理会社の結果・スタッフ", B("603号室の最新の募集状況") === "mgmt_result|staff");
  ok("送れる物件候補＝こちら側・取りに行く", B("107,000円以内の送れる物件候補") === "our_side|fetch");
  ok("資料の寸法＝物件の資料・取りに行く", B("クローゼットの広さ(資料の寸法)") === "property_doc|fetch");
  ok("探し始めの時期（会社の方針）＝会社の事実・取りに行く", B("入居時期から逆算した探し始めの時期(会社の方針)") === "company_fact|fetch");
  ok("スタッフの空き時間＝こちら側・スタッフ", B("15日のスタッフの空き時間") === "our_side|staff");
  ok("内覧する物件の順番と住所＝内覧の場・取りに行く（予定の記録）", B("内覧する物件の順番と1件目の住所") === "viewing_place|fetch");
  ok("提携先との進捗＝こちら側・スタッフ", B("提携先(大福不動産)との進捗") === "our_side|staff");
  const d = materialBooksDigest(["お電話で話した内容", "お電話で話した内容", "603号室の最新の募集状況"]);
  ok("digest: 同じ組は1つ・帳面|印|鍵", JSON.stringify(d) === JSON.stringify(["phone|staff|other", "mgmt_result|staff|vacancy_status"]), JSON.stringify(d));
  ok("digest: 空は undefined", materialBooksDigest([]) === undefined);
}
console.log(`material-gap-ledger: ${pass} passed, ${fail} failed`); if (fail) process.exit(1);
