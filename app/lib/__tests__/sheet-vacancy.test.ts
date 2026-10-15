// 資料の欄で現況・退去予定日・入居可能日・内覧可能日を読む（app/lib/sheet-vacancy.ts）のテスト（自己完結ハーネス）
// 文は実物（property_pickups.pdf_text・送った資料の画像を目で読んだ物・image_details.lines）。
// 実行: npx tsx app/lib/__tests__/sheet-vacancy.test.ts
import { readSheetVacancy, sheetVacancyLines, alignVacancyLines, vacateMonthDay, sheetDateKey } from "../sheet-vacancy";
import { vacancyDateFromMaterial } from "../viewing-check-first";
import { readMoveInMaterial } from "../procedure-question";
import { routeContractTerm } from "../contract-terms-question";
import { moveInFactOfPickup } from "../aix-material-facts";
import { parseExtractVacancyResponse, extractVacancyDateSystem } from "../extract-vacancy-date-prompt";
import { normalizeVacancyLines } from "../property-detail-source";

let passed = 0, failed = 0; const failures: string[] = [];
function it(name: string, fn: () => void) {
  try { fn(); passed++; console.log(`  ✓ ${name}`); }
  catch (e) { failed++; failures.push(name); console.log(`  ✗ ${name}\n      ${e instanceof Error ? e.message : String(e)}`); }
}
const eq = (a: unknown, b: unknown) => { if (JSON.stringify(a) !== JSON.stringify(b)) throw new Error(`got ${JSON.stringify(a)} want ${JSON.stringify(b)}`); };
const ok = (c: unknown, m = "") => { if (!c) throw new Error(`false ${m}`); };

// ── 取り違え①: リアプロ「現況/入居時期 A / B」の B は入居時期（退去予定日ではない）──
// 実物: ラクラス長堀橋 1504・maison de Villa 北畠 202（売上サポ 9/28 の画像読みは「退去予定: 2026年11月28日」「退去予定: 2026年10月20日」と取り違えた）
it("退去予定 / 2026年11月28日 → 現況 退去予定・入居可能日 2026年11月28日・退去予定日なし（ラクラス長堀橋）", () => {
  const v = readSheetVacancy("築年 2016年02月\n現況/入居時期 退去予定 / 2026年11月28日\n賃料");
  eq([v.current, v.vacate, v.moveIn, v.moveInFrom], ["退去予定", null, "2026年11月28日", "現況/入居時期の後ろ"]);
});
it("退去予定 / 2026年10月20日 / 商談中 → 商談中は現況に添える（maison de Villa 北畠）", () => {
  const v = readSheetVacancy("現況/入居時期 退去予定 / 2026年10月20日 / 商談中");
  eq(sheetVacancyLines(v), ["現況: 退去予定・商談中", "入居可能日: 2026年10月20日"]);
});
it("退去予定(10/31) / 相談 → 退去予定日 10/31（括弧）・入居可能日 相談", () => {
  const v = readSheetVacancy("現況/入居時期\n退去予定(10/31) / 相談");
  eq([v.current, v.vacate, v.vacateFrom, v.moveIn], ["退去予定", "10/31", "現況/入居時期の前の括弧・文", "相談"]);
});
it("退去予定(9/下) / 相談 / 商談中 → 退去予定 9/下（旬は内覧開始日にしない）", () => {
  const v = readSheetVacancy("現況/入居時期 退去予定(9/下) / 相談 / 商談中");
  eq([v.vacate, v.moveIn, vacateMonthDay(v.vacate)], ["9/下", "相談", null]);
});
it("空室 / 2026年8月下旬 → 現況 空室・入居可能日 2026年8月下旬（サンプラザ山坂）", () => {
  eq(sheetVacancyLines(readSheetVacancy("現況/入居時期 空室 / 2026年8月下旬")), ["現況: 空室", "入居可能日: 2026年8月下旬"]);
});
it("空室 / 相談 / 審査中 / 内装中", () => {
  eq(sheetVacancyLines(readSheetVacancy("現況/入居時期 空室 / 相談 / 審査中 / 内装中")), ["現況: 空室・審査中・内装中", "入居可能日: 相談"]);
});

// ── 取り違え②: 備考・特記・案内方法の文の退去予定日 ──
it("【現況】空き予定(9/30退去予定)（サザンパークス 705・資料の表は「退去予定 / 相談」）", () => {
  const v = readSheetVacancy("現況/入居時期: 退去予定 / 相談\n備考: 最寄り3路線が使えて…\n【現況】\n空き予定(9/30退去予定)\n【備考】\nクリーニング特約有");
  eq([v.current, v.vacate, v.moveIn], ["退去予定", "9/30", "相談"]);
});
it("案内方法: 8月末空き予定・入居時期 期日指定(2026年09月上旬)（ジェントリー3）", () => {
  const v = readSheetVacancy("現況: 居住中\n入居時期: 期日指定(2026年09月上旬)\n案内方法: 8月末空き予定");
  eq(sheetVacancyLines(v), ["現況: 居住中", "退去予定: 8月末", "入居可能日: 期日指定(2026年09月上旬)"]);
  eq(vacateMonthDay(v.vacate), "8月末");
});
it("文字層の備考「‧内覧方法： 9/25 退去予定」（フィッシェ福原）・「現況優先」は現況にしない", () => {
  const v = readSheetVacancy("備考\n※ 写真は参考となり、現況優先となります。 ‧内覧⽅法： 9/25 退去予定\nAL 「呼 0223 」");
  eq([v.current, v.vacate], ["退去予定", "9/25"]);
});
it("「入居可能時期についてはリフォーム状況によって…」は入居可能日にしない", () => {
  eq(readSheetVacancy("※入居可能時期についてはリフォーム状況によって変更が生じる場合がございます。").moveIn, null);
});
it("退去時のクリーニング代・申込分より適用の日付は退去予定日にしない", () => {
  eq(readSheetVacancy("カギ交換費用：38,500円（税込/退去時）2026年7月24日申込分より適用・エアコンクリーニング代：16,500円（税込/退去時）").vacate, null);
});

// ── 取り違え③: 欄の名前が退去予定でない所の退去日 ──
it("解約予定日 2026年6月30日・入居可能日 相談（エステムプラザ本町クロス）", () => {
  const v = readSheetVacancy("入居可能日 : 相談\n解約予定日 : 2026年6月30日");
  eq(sheetVacancyLines(v), ["現況: 退去予定", "退去予定: 2026年6月30日", "入居可能日: 相談"]);
});
it("入居予定日 2026/9/中旬退去予定 → 退去予定日（入居可能日にしない・ハーモニーテラス森ノ宮）", () => {
  eq(sheetVacancyLines(readSheetVacancy("入居予定日: 2026/9/中旬退去予定")), ["現況: 退去予定", "退去予定: 2026/9/中旬"]);
});
it("itandi の1行「現況 居住中 入居可能時期 2026 年 11 月上旬」", () => {
  eq(sheetVacancyLines(readSheetVacancy("現況 居住中 入居可能時期 2026 年 11 月上旬")), ["現況: 居住中", "入居可能日: 2026年11月上旬"]);
});

it("「現況」だけの欄の「退去予定 2026/09/29」は退去予定日（Park Lane Minami 902・スタッフ「9月29日退去予定」）", () => {
  const v = readSheetVacancy("現況: 退去予定 2026/09/29\n入居可能日: 相談");
  eq([v.vacate, v.moveIn, vacateMonthDay(v.vacate)], ["2026/09/29", "相談", "9月29日"]);
});
it("「現況/入居時期 退去予定 2026年12月上旬」（/ 抜け）は退去予定日にしない", () => {
  eq(readSheetVacancy("現況/入居時期 退去予定 2026年12月上旬").vacate, null);
});

// ── ④ 内覧可能日 ──
it("特記「内覧可能日：2026年8月1日〜」（サンプラザ山坂 202 の退去予定の版）", () => {
  const v = readSheetVacancy("現況/入居時期: 退去予定 / 2026年8月下旬\n特記事項: ・インターネット：無料・内覧可能日：2026年8月1日〜・webサービス広告掲載");
  eq(sheetVacancyLines(v), ["現況: 退去予定", "入居可能日: 2026年8月下旬", "内覧可能日: 2026年8月1日〜"]);
});

// ── 分からない時は出さない ──
it("2部屋以上の一覧は決めない（Goパレス福島）", () => {
  const v = readSheetVacancy("号室: 203 / 状況: 10/末\n号室: 205 / 状況: 10/末\n号室: 302 / 状況: 10/末");
  eq([v.multiRoom, sheetVacancyLines(v)], [true, []]);
});
it("退去予定の日付が同じ所で2つ食い違う → 出さない", () => {
  const v = readSheetVacancy("退去予定日: 2026年9月30日\n解約予定日: 2026年10月31日");
  eq(v.vacate, null); ok(v.conflicts.length > 0);
});
it("現況が「—」は現況を作らない（ジュネスニッコー・入居可能時期 2026年10月31日）", () => {
  eq(sheetVacancyLines(readSheetVacancy("現況 —\n入居可能時期 2026年10月31日")), ["入居可能日: 2026年10月31日"]);
});
it("現況の欄が空室なのに特記に「8月末空予定」（リバーサイド大今里）→ 退去予定日は出さない", () => {
  const v = readSheetVacancy("現況/入居時期 空室 / 相談\n【その他特記事項】8月末空予定");
  eq([v.current, v.vacate, v.moveIn], ["空室", null, "相談"]); ok(v.conflicts.length > 0);
});
it("入居時期と同じ日付の退去予定（写した物）は捨てる", () => {
  const v = readSheetVacancy("現況: 退去予定\n入居可能日: 2026年8月下旬\n退去予定: 2026年8月下旬");
  eq([v.vacate, v.moveIn], [null, "2026年8月下旬"]);
});
it("日付の鍵", () => { eq(sheetDateKey("2026/07/27"), "7/27"); eq(sheetDateKey("9/下"), "9/下旬"); eq(sheetDateKey("10月末"), "10/末"); eq(sheetDateKey("2026年10月20日"), "10/20"); });

// ── 読み取りの行（LLM）を欄に合わせる ──
it("LLM が入居時期を退去予定にした行を直す（maison de Villa 北畠の書き写し）", () => {
  const llm = ["間取り: 2LDK", "現況: 退去予定", "退去予定: 2026年10月20日", "駐輪場: 1世帯自転車1台迄"];
  const r = alignVacancyLines(llm, "号室名: 202（2階部分）\n現況/入居時期: 退去予定 / 2026年10月20日 / 商談中\n賃料: 95,000円", {});
  eq(r.lines, ["間取り: 2LDK", "現況: 退去予定・商談中", "入居可能日: 2026年10月20日", "駐輪場: 1世帯自転車1台迄"]);
});
it("「退去予定(10/下)」の旬は行に残る（normalizeVacancyLines が落とさない・エステムコート難波サウスプレイスIII）", () => {
  const r = alignVacancyLines(["現況: 退去予定(10/下) / 相談", "退去予定: 10/下"], "現況/入居時期 退去予定(10/下) / 相談", {});
  eq(normalizeVacancyLines(r.lines), ["現況: 退去予定", "退去予定: 10/下", "入居可能日: 相談"]);
});
it("LLM が落とした備考の退去予定日を足す（サザンパークス）", () => {
  const r = alignVacancyLines(["間取り: 1LDK", "現況: 退去予定", "入居可能日: 相談"], "現況/入居時期: 退去予定 / 相談\n【現況】\n空き予定(9/30退去予定)", {});
  eq(r.lines, ["間取り: 1LDK", "現況: 退去予定", "退去予定: 9/30", "入居可能日: 相談"]);
});
it("LLM が退去予定日を入居可能日にした行を落として退去予定に（ハーモニーテラス森ノ宮の書き写しの実物）", () => {
  const r = alignVacancyLines(["間取り: 1LDK", "入居可能日: 2026/9/中旬"], "構造: 木造 3階建 3階部分\n入居予定日: 2026/9/中旬退去予定\n設備等: プロパンガス", {});
  eq(r.lines, ["間取り: 1LDK", "現況: 退去予定", "退去予定: 2026/9/中旬"]);
});
it("欄が無い資料で、元の文字に退去の字の無い退去予定の日付は落とす（作り事）・他の行は残す", () => {
  const r = alignVacancyLines(["ペット: 不可", "退去予定: 11/15"], "ペット不可 2人入居可 11/15 更新", {});
  eq(r.lines, ["ペット: 不可"]);
});
it("SHEET_VACANCY_FIELDS=off・元の文字が無い時は触らない", () => {
  const l = ["現況: 退去予定", "退去予定: 2026年10月20日"];
  eq(alignVacancyLines(l, "現況/入居時期 退去予定 / 2026年10月20日", { SHEET_VACANCY_FIELDS: "off" }).lines, l);
  eq(alignVacancyLines(l, "", {}).lines, l);
});

// ── 読み口（ブレインの内覧の答え・資料の答え）も欄で読む ──
it("vacancyDateFromMaterial: 「現況/入居時期 退去予定 / 2026年10月20日」は退去予定日にしない（旧は 10月20日）", () => {
  eq(vacancyDateFromMaterial(["現況/入居時期 退去予定 / 2026年10月20日 / 商談中"]), null);
});
it("vacancyDateFromMaterial: 括弧の退去日と入居時期の日付 → 括弧（旧は入居時期の 11月20日）", () => {
  eq(vacancyDateFromMaterial(["現況/入居時期 退去予定(10/31) / 2026年11月20日"]), "10月31日");
});
it("vacancyDateFromMaterial: 売上サポの資料の行＋取り違えて保存された行 → 入居時期と同じ日付は捨てる", () => {
  eq(vacancyDateFromMaterial(["現況/入居時期 退去予定 / 2026年10月20日", "現況: 退去予定", "退去予定: 2026年10月20日"]), null);
});
it("vacancyDateFromMaterial: 前からの形（括弧・退去予定日・月末・旬）", () => {
  eq(vacancyDateFromMaterial(["現況: 退去予定(10/31)", "入居可能日: 相談"]), "10月31日");
  eq(vacancyDateFromMaterial(["退去予定日：2026/07/27"]), "7月27日");
  eq(vacancyDateFromMaterial(["現況: 10月末退去予定"]), "10月末");
  eq(vacancyDateFromMaterial(["現況: 退去予定 / 2026年11月下旬"]), null);
  eq(vacancyDateFromMaterial(["退去予定: 9/30"]), "9月30日");
});
it("readMoveInMaterial: 「退去予定(10/31) / 相談」は入居可能日の日付ではない（旧は date）", () => {
  eq(readMoveInMaterial(["現況/入居時期 退去予定(10/31) / 相談"]).kind, "leaving");
  eq(readMoveInMaterial(["現況/入居時期 退去予定 / 2026年10月20日"]).kind, "date");
});
it("routeContractTerm: 入居時期の日付だけの資料は「資料に入居可能日の記載」（退去予定日とは言わない）", () => {
  const r = routeContractTerm("move_in", { lines: ["現況/入居時期 退去予定 / 2026年11月28日"] });
  eq([r.route, r.why], ["material", "資料に入居可能日の記載"]);
  const r2 = routeContractTerm("move_in", { lines: ["現況/入居時期 退去予定(10/31) / 相談"] });
  // fix(review) 10/15: 退去予定日がまだ先の時は最短の入居時期の目安（逆算）が添わる（vacate-move-in-estimate・日付で変わるので前方一致）
  eq([r2.route, r2.why.startsWith("資料に退去予定日の記載")], ["material", true]);
});
it("moveInFactOfPickup: 資料の文字のままの1行に、欄で分けた行を添える", () => {
  const f = moveInFactOfPickup({ pdf_text: "現況/入居時期 退去予定 / 2026年11月28日\n賃料 170,000 円" });
  ok(f && f.lines.includes("現況/入居時期 退去予定 / 2026年11月28日") && f.lines.includes("入居可能日: 2026年11月28日") && !f.lines.some((l) => /^退去予定:/.test(l)), JSON.stringify(f));
});

// ── 2026-10-13 レビューの直し ──
it("【軽微2】契約期間の終わり「2026年11月1日～2028年10月31日 解約予告1ヶ月前」は退去予定日にしない", () => {
  eq(readSheetVacancy("契約期間: 2026年11月1日～2028年10月31日 解約予告1ヶ月前").vacate, null);
});
it("【軽微2】定期借家「…～2028/10/31 解約不可」・「※2026/9/30退去済み」は退去予定日にしない", () => {
  eq(readSheetVacancy("契約期間: 定期借家 2026/11/1～2028/10/31 解約不可").vacate, null);
  eq(readSheetVacancy("現況: 空室\n※2026/9/30退去済み").vacate, null);
  eq(readSheetVacancy("備考: 退去時クリーニング 2026年10月1日退去時精算").vacate, null);
});
it("【軽微2】来年より先の年の日付は退去予定日にしない・今年の日付は読む", () => {
  const y = new Date().getFullYear();
  eq(readSheetVacancy(`備考: ${y + 2}年3月31日解約予定`).vacate, null);
  eq(readSheetVacancy(`備考: ${y}年10月31日解約予定`).vacate, `${y}年10月31日`);
});
it("【軽微3】見出し 空き予定日・空室予定日・退去予定時期・退去時期・明渡し予定", () => {
  eq(readSheetVacancy("空き予定日: 2026年10月31日").vacate, "2026年10月31日");
  eq(readSheetVacancy("空室予定日：10/20").vacate, "10/20");
  eq(readSheetVacancy("退去予定時期: 2026年11月中旬").vacate, "2026年11月中旬");
  eq(readSheetVacancy("退去時期 10月末").vacate, "10月末");
  eq(readSheetVacancy("明渡し予定日: 2026/12/15").vacate, "2026/12/15");
});
it("【軽微3】和暦（令和8年10月31日・R8.10.31）を読む", () => {
  eq(vacateMonthDay(readSheetVacancy("解約予定日: 令和8年10月31日").vacate), "10月31日");
  eq(vacateMonthDay(readSheetVacancy("退去予定日 R8.10.31").vacate), "10月31日");
});
it("【軽微3】元の文字で日付が読めない時は LLM の「退去予定:」の行を落とさず残す", () => {
  const r = alignVacancyLines(["間取り: 1K", "退去予定: 10/31"], "間取り 1K\n備考: 立会 拾月参拾壱日 退去予定（手書き）\n所在階 3階", {});
  eq(r.lines, ["間取り: 1K", "退去予定: 10/31"]);
});
it("【軽微1】「新築 空室」→ 欄「空室」の時は新築を残す", () => {
  const r = alignVacancyLines(["現況: 新築 空室", "入居可能日: 相談"], "現況/入居時期 空室 / 相談\n築年 2026年09月", {});
  eq(r.lines, ["現況: 新築 空室", "入居可能日: 相談"]);
});
it("【軽微1】欄と違う LLM の入居可能日（即入居可・27日後入居可・退去及び内装完了後）は捨てずに別の行に添える（読み口は欄の値）", () => {
  const r = alignVacancyLines(["現況: 退去予定", "入居可能日: 退去及び内装完了後"], "現況/入居時期 退去予定(10/26) / 相談\n入居時期 退去及び内装完了後", {});
  eq(r.lines, ["現況: 退去予定", "退去予定: 10/26", "入居可能日: 相談", "入居の別の記載: 退去及び内装完了後（資料の別の所）"]);
  eq(readMoveInMaterial(r.lines).kind, "leaving");
  const r2 = alignVacancyLines(["入居可能日: 即入居可"], "現況/入居時期 空室 / 相談\n備考 即入居可", {});
  ok(r2.lines.includes("入居可能日: 相談") && r2.lines.includes("入居の別の記載: 即入居可（資料の別の所）"), JSON.stringify(r2.lines));
  eq(readMoveInMaterial(r2.lines).kind, "unknown");
  // 同じ中身（即入 と 即入居可・日付が同じ）は添えない＝2回かけても同じ
  eq(alignVacancyLines(["入居可能日: 即入居可"], "間取タイプ 1K\n現況/入居時期 空室 / 即入", {}).lines, ["現況: 空室", "入居可能日: 即入"]);
  eq(alignVacancyLines(r.lines, "現況/入居時期 退去予定(10/26) / 相談\n入居時期 退去及び内装完了後", {}).lines, r.lines);
});

it("【見直し1】2回かけても同じ（実データ #1248・#1249・#1397・#1486・#1652 の形）", () => {
  const cases: Array<[string[], string]> = [
    [["現況: 新築 空室", "入居可能日: 即入 / 商談中"], "間取タイプ 1DK\n現況/入居時期 空室 / 即入 / 商談中"], // #1248
    [["現況: 新築 空室", "入居可能日: 即入"], "間取タイプ 1DK\n現況/入居時期 空室 / 即入 / 商談中"], // #1249
    [["現況: 新築 空室", "入居可能日: 即入"], "間取タイプ 1DK\n現況/入居時期 空室 / 即入 / 審査中"], // #1397
    [["現況: 新築 空室 / 即入 / 商談中", "入居可能日: 即入"], "間取タイプ 1K\n現況/入居時期 空室 / 即入 / 商談中"], // #1486
    [["現況: 新築 建築中", "入居可能日: 2026年11月中旬"], "間取タイプ 1LDK\n現況/入居時期 建築中 / 2026年11月中旬 / 審査中"], // #1652
  ];
  for (const [llm, src] of cases) {
    const once = alignVacancyLines(llm, src, {}).lines;
    const twice = alignVacancyLines(once, src, {}).lines;
    eq(twice, once);
    ok(once[0].startsWith("現況: 新築 "), JSON.stringify(once));
  }
  eq(alignVacancyLines(cases[3][0], cases[3][1], {}).lines, ["現況: 新築 空室・商談中", "入居可能日: 即入"]);
});
it("【見直し2】元の文字に退去・解約・明渡し・空き予定の字も和暦も無い資料で LLM が書いた退去日は落とす（作り事の形）", () => {
  eq(alignVacancyLines(["現況: 居住中", "入居可能日: 相談", "退去予定: 11/15"], "間取タイプ 1K\n現況 居住中\n入居時期 相談", {}).lines, ["現況: 居住中", "入居可能日: 相談"]);
  // 和暦がある（読めない書き方の恐れ）・退去の字がある時は残す
  ok(alignVacancyLines(["間取り: 1K", "退去予定: 10/31"], "間取 1K\n備考: 立会 拾月参拾壱日 退去の予定（手書き）", {}).lines.includes("退去予定: 10/31"));
  ok(alignVacancyLines(["間取り: 1K", "退去予定: 10/31"], "間取 1K\n備考: 令和捌年拾月 予定 所在階 3階", {}).lines.includes("退去予定: 10/31"));
});

it("【B の読み直し】現況の欄が空で次の行が金額（「現況:」⏎「7,700円/月」）は現況にしない・LLM の現況の行を残す（ba1527de 1788404857079）", () => {
  const src = "号室: 201\n現況:\n7,700円/月\n入居時期: 期日指定(2026年10月上旬)\n案内方法: 9月末空き予定";
  const v = readSheetVacancy(src);
  ok(v.current !== "7,700円/月", JSON.stringify(v));
  const r = alignVacancyLines(["間取り: 2DK", "現況: 201号室 9月末空き予定", "入居可能日: 期日指定(2026年10月上旬)", "退去予定: 9月末"], src, {});
  ok(!r.lines.some((l) => /円/.test(l) && /^現況/.test(l)), JSON.stringify(r.lines));
  ok(r.lines.includes("現況: 201号室 9月末空き予定") && r.lines.includes("退去予定: 9月末") && r.lines.includes("入居可能日: 期日指定(2026年10月上旬)"), JSON.stringify(r.lines));
  eq(alignVacancyLines(r.lines, src, {}).lines, r.lines);
});
it("【B の読み直し】金額・面積・号室だけの現況は採らない（現況: 7,700円/月・25.3㎡・203号室）", () => {
  eq(readSheetVacancy("現況: 7,700円/月").current, null);
  eq(readSheetVacancy("現況 25.3㎡").current, null);
  eq(readSheetVacancy("現況: 203号室").current, null);
  eq(readSheetVacancy("現況: 空室").current, "空室");
  eq(readSheetVacancy("現況: 即入居可").current, "即入居可");
  eq(readSheetVacancy("現況: 申込有り").current, "申込有り");
});
it("【B の読み直し】「現況: 相談(2026年7月17日退去予定)」は 現況 退去予定・退去予定日 2026年7月17日（「相談」を現況にしない）", () => {
  const v = readSheetVacancy("現況: 相談(2026年7月17日退去予定)");
  eq([v.current, v.vacate], ["退去予定", "2026年7月17日"]);
});

// ── AIX【物件確認した】の画像の退去予定日（/api/extract-vacancy-date）: Haiku は書き写すだけ・欄で決める ──
it("extract-vacancy-date: 書き写しの「退去予定 / 2026年10月20日」は退去予定日にしない（旧の Haiku は 2026年10月20日 を返した）", () => {
  eq(parseExtractVacancyResponse(`{"propertyName":"maison de Villa 北畠 202号室","fields":["現況/入居時期: 退去予定 / 2026年10月20日 / 商談中"]}`, {}), { propertyName: "maison de Villa 北畠 202号室", vacancyDate: null, fields: ["現況/入居時期: 退去予定 / 2026年10月20日 / 商談中"], vacancyFrom: null });
});
it("extract-vacancy-date: 括弧・備考の退去日は返す（形は 9月30日・8月末・9月下旬）", () => {
  eq(parseExtractVacancyResponse(`{"propertyName":"A","fields":["現況/入居時期: 退去予定(9/30) / 相談"]}`, {}).vacancyDate, "9月30日");
  eq(parseExtractVacancyResponse(`{"propertyName":"A","fields":["現況: 居住中","案内方法: 8月末空き予定"]}`, {}).vacancyDate, "8月末");
  eq(parseExtractVacancyResponse(`{"propertyName":"A","fields":["入居予定日: 2026/9/下旬退去予定"]}`, {}).vacancyDate, "9月下旬");
});
it("extract-vacancy-date: SHEET_VACANCY_FIELDS=off は旧の返事（vacancyDate）のまま・指示も旧", () => {
  eq(parseExtractVacancyResponse(`{"propertyName":"A","vacancyDate":"10月20日"}`, { SHEET_VACANCY_FIELDS: "off" }), { propertyName: "A", vacancyDate: "10月20日" });
  ok(/vacancyDate/.test(extractVacancyDateSystem({ SHEET_VACANCY_FIELDS: "off" })) && /fields/.test(extractVacancyDateSystem({})));
});

console.log(`\n${passed} passed, ${failed} failed`);
if (failed) { for (const f of failures) console.log(`  - ${f}`); process.exit(1); }
