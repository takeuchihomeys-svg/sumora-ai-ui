// 2026-09-15 竹内（YUYA 事例）: AIX【保証会社について】の名寄せ・種類の既定・並行審査の判定・固定テンプレ・事実の照合・登録
// 実行: npx tsx app/lib/__tests__/guarantor-companies.test.ts（自己完結ハーネス。全 PASS で exit 0）
import {
  normalizeGuarantorName, resolveGuarantor, isMasterGuarantor, guarantorAliasesOf, planParallelScreening, buildGuarantorInfoText,
  buildGuarantorListText, formatGuarantorFacts, checkGuarantorFacts, GUARANTOR_TYPE_LABELS, GUARANTOR_SCAN_WORDS, type GuarantorProperty,
  buildGuarantorCheckNote, detectGuarantorInText, detectGuarantorFromMessages,
  parseGuarantorTypeJa, guarantorTypeJa, guarantorNamesByType, GUARANTOR_OCR_NAME_HINT,
  GUARANTOR_TYPES, GUARANTOR_TYPE_DEFINITION, GUARANTOR_TYPE_SHORT, GUARANTOR_TYPES_JA, GUARANTOR_TYPE_SCREENING_NOTE,
  normalizeGuarantorType, GUARANTOR_INFO_STAFF_EXAMPLES, type GuarantorType,
} from "../guarantor-companies";
import { normalizeAixActionKey, AIX_STAFF_NOTES, AIX_BUTTON_LABELS } from "../aix-taxonomy";
import { aixLedgerKind, aixTextPromises, buildActionLedger, buildLedgerLinesForBrain, LEDGER_KIND_JA } from "../action-ledger";
import { avoidTopicsForAix } from "../aix-staff-first";

let passed = 0, failed = 0; const failures: string[] = [];
function it(name: string, fn: () => void) {
  try { fn(); passed++; console.log(`  ✓ ${name}`); }
  catch (e) { failed++; failures.push(`${name}: ${e instanceof Error ? e.message : String(e)}`); console.log(`  ✗ ${name}\n      ${e instanceof Error ? e.message : String(e)}`); }
}
function expect<T>(actual: T) {
  return {
    toBe(exp: T) { if (actual !== exp) throw new Error(`expected ${JSON.stringify(exp)} but got ${JSON.stringify(actual)}`); },
    toEqual(exp: unknown) { if (JSON.stringify(actual) !== JSON.stringify(exp)) throw new Error(`expected ${JSON.stringify(exp)} but got ${JSON.stringify(actual)}`); },
    toContain(s: string) { if (typeof actual !== "string" || !actual.includes(s)) throw new Error(`expected ${JSON.stringify(actual)} to contain ${JSON.stringify(s)}`); },
    notToContain(s: string) { if (typeof actual === "string" && actual.includes(s)) throw new Error(`expected ${JSON.stringify(actual)} not to contain ${JSON.stringify(s)}`); },
  };
}

// ─── 1. 名寄せ（表記ゆれ） ───
it("日本セーフティ／日本セーフティー／日本セーフティ―／株式会社付き → 日本セーフティー", () => {
  for (const s of ["日本セーフティ", "日本セーフティー", "日本セーフティ―", "日本セーフティー株式会社", "日本セーフティ 保証会社"]) expect(normalizeGuarantorName(s)).toBe("日本セーフティー");
});
it("カーサ → Casa／エポス → エポスカード／オリコ → オリコフォレントインシュア／JID → 日本賃貸保証／アセス保証 → アセス保証", () => {
  expect(normalizeGuarantorName("カーサ")).toBe("Casa");
  expect(normalizeGuarantorName("CASA")).toBe("Casa");
  expect(normalizeGuarantorName("エポス")).toBe("エポスカード");
  expect(normalizeGuarantorName("オリコ")).toBe("オリコフォレントインシュア");
  expect(normalizeGuarantorName("JID")).toBe("日本賃貸保証");
  expect(normalizeGuarantorName("ｊｉｄ")).toBe("日本賃貸保証");
  expect(normalizeGuarantorName("アセス保証")).toBe("アセス保証");
  expect(normalizeGuarantorName("アセス")).toBe("アセス保証");
});
it("未知の会社はそのまま（カスタム）・空は空", () => {
  expect(normalizeGuarantorName("スモラ保証")).toBe("スモラ保証");
  expect(normalizeGuarantorName("  ")).toBe("");
  expect(isMasterGuarantor("スモラ保証")).toBe(false);
  expect(isMasterGuarantor("日本セーフティ")).toBe(true);
});
it("正規名 → 別名一覧（照合の許可語）", () => {
  expect(guarantorAliasesOf("日本セーフティー").includes("日本セーフティ")).toBe(true);
  expect(guarantorAliasesOf("スモラ保証")).toEqual(["スモラ保証"]);
});

// ─── 2. 種類の既定値 ───
it("全保連 → 信用系・既知／エポス → 信販系（2026-09-26 竹内さん・種類は3つ）", () => {
  expect(resolveGuarantor("全保連")).toEqual({ name: "全保連", type: "shinyou", known: true });
  expect(resolveGuarantor("エポス").type).toBe("credit");
});
it("カスタム登録の会社は customs の種類・無ければ unknown", () => {
  expect(resolveGuarantor("スモラ保証", [{ name: "スモラ保証", type: "independent" }])).toEqual({ name: "スモラ保証", type: "independent", known: true });
  expect(resolveGuarantor("スモラ保証")).toEqual({ name: "スモラ保証", type: "unknown", known: false });
});

// ─── 3. 並行審査の判定（YUYA 5物件） ───
const YUYA: GuarantorProperty[] = [
  { name: "カーザSun I", company: "日本セーフティー", type: "independent" },
  { name: "ノルデンハイムリバーサイド十三", company: "オリコ", type: "credit" },
  { name: "朝日プラザ新大阪", company: "アセス保証", type: "independent" },
  { name: "Renatus新大阪", company: "日本セーフティ", type: "independent" },
  { name: "ディザイア新大阪", company: "日本賃貸保証", type: "shinyou" },
];
it("YUYA 5物件 → 会社4・かぶり1組（日本セーフティー: カーザSun I・Renatus新大阪）・並行可", () => {
  const p = planParallelScreening(YUYA);
  expect(p.groups.length).toBe(4);
  expect(p.overlapping).toEqual([{ company: "日本セーフティー", properties: ["カーザSun I", "Renatus新大阪"] }]);
  expect(p.canParallel).toBe(true);
});
it("全物件エポス → 並行不可", () => {
  const p = planParallelScreening([{ name: "A", company: "エポス", type: "credit" }, { name: "B", company: "エポスカード", type: "credit" }]);
  expect(p.groups.length).toBe(1);
  expect(p.canParallel).toBe(false);
});

// ─── 4. 固定テンプレ（YUYA 9/15 17:31 の実送信の型） ───
const YUYA_EXPECTED = `YUYAさん
こちら保証会社一覧となります！！

・カーザSun I
・Renatus新大阪
の保証会社は日本セーフティーと独立系の保証会社となりますので、審査基準が緩い保証会社となります😊！！

・朝日プラザ新大阪
の保証会社はアセス保証と独立系の保証会社となりますので、審査基準が緩い保証会社となります😊！！

・ノルデンハイムリバーサイド十三
の保証会社はオリコフォレントインシュアと信販系の保証会社となり、クレジット審査となりますので比較的審査厳し目のお部屋となります！！

・ディザイア新大阪
の保証会社は日本賃貸保証と信用系の保証会社となり、金融系の情報ではなく過去の家賃滞納やトラブルが無かったかを見る審査となります！！

審査無事通過する為、保証会社が異なるお部屋並行して審査かけさせて頂く事可能です！！
カーザSun IとRenatus新大阪は保証会社が同じ（日本セーフティー）となりますので、どちらか1件の審査となります！！
よろしければお気に召されたお部屋一度審査かけさせて頂きます！！

※保証会社審査通過後、オーナー審査移行するまでキャンセル料不要となります！！`;
it("YUYA・並行 ON → 完成例と完全一致（会社は正規名・種類の順・かぶりの組・キャンセル料の行）", () => {
  expect(buildGuarantorInfoText({ customerName: "YUYA", properties: YUYA, parallel: true })).toBe(YUYA_EXPECTED);
});
it("並行 OFF → 並行審査に触れない・最終行はキャンセル料", () => {
  const t = buildGuarantorInfoText({ customerName: "YUYA", properties: YUYA, parallel: false });
  expect(t).notToContain("並行して審査");
  expect(t).notToContain("どちらか1件");
  expect(t).toContain("よろしければお気に召されたお部屋一度審査かけさせて頂きます！！");
  expect(t.endsWith("※保証会社審査通過後、オーナー審査移行するまでキャンセル料不要となります！！")).toBe(true);
});
it("全物件が同じ会社＋並行 ON → 「1件ずつ審査」・並行の文は無い", () => {
  const t = buildGuarantorInfoText({ customerName: "", properties: [{ name: "A", company: "エポス", type: "credit" }, { name: "B", company: "エポスカード", type: "credit" }], parallel: true });
  expect(t).toContain("保証会社がいずれもエポスカードと同じとなりますので、お気に召されたお部屋1件ずつ審査かけさせて頂く形となります！！");
  expect(t).notToContain("並行して");
  expect(t.startsWith("こちら保証会社一覧となります！！")).toBe(true);   // 名前が無ければ行ごと省く
});
it("物件が1件だけ＋並行 ON → 「いずれも同じ」「1件ずつ」にならず誘いの文（LLM 指示も同じ）", () => {
  const one: GuarantorProperty[] = [{ name: "カーザSun I", company: "日本セーフティー", type: "independent" }];
  const t = buildGuarantorInfoText({ customerName: "YUYA", properties: one, parallel: true });
  expect(t).notToContain("いずれも");
  expect(t).notToContain("1件ずつ");
  expect(t).notToContain("並行して");
  expect(t).toContain("よろしければお気に召されたお部屋一度審査かけさせて頂きます！！");
  expect(formatGuarantorFacts(one, { parallel: true }).block).toContain("並行審査の提案は書かない");
});
it("種類が不明の物件 → 審査の緩い・厳しいに触れない", () => {
  const t = buildGuarantorInfoText({ customerName: "YUYA", properties: [{ name: "A", company: "スモラ保証", type: "unknown" }], parallel: false });
  expect(t).toContain("・A\nの保証会社はスモラ保証となります！！");
  expect(t).notToContain("緩い");
  expect(t).notToContain("厳し");
});
it("固定テンプレの本文は送信時の記録で約束（ピックアップ・見積書・確認）に読まれない", () => {
  expect(aixTextPromises("guarantor_info", YUYA_EXPECTED, "2026-09-15T08:31:00.000Z").length).toBe(0);
});
it("入力の確認（17:27 型の一覧）は物件名と正規名の2行1組", () => {
  expect(buildGuarantorListText(YUYA.slice(0, 2))).toBe("⚪︎カーザSun I\n日本セーフティー\n⚪︎ノルデンハイムリバーサイド十三\nオリコフォレントインシュア");
});

// ─── 5. 事実の照合 ───
const ONLY_JSN: GuarantorProperty[] = [{ name: "カーザSun I", company: "日本セーフティー", type: "independent" }];
it("入力に無い「全保連」→ NG・〇〇に置換・unmatched に正規名", () => {
  const r = checkGuarantorFacts("カーザSun Iの保証会社は全保連となります！！", ONLY_JSN);
  expect(r.ok).toBe(false);
  expect(r.unmatched).toEqual(["全保連"]);
  expect(r.cleaned).toBe("カーザSun Iの保証会社は〇〇となります！！");
});
it("別表記「日本セーフティ」は入力と同じ会社 → OK", () => {
  const r = checkGuarantorFacts("カーザSun Iの保証会社は日本セーフティと独立系の保証会社となります！！", ONLY_JSN);
  expect(r.ok).toBe(true);
  expect(r.cleaned).toContain("日本セーフティ");
});
it("長い順に走査: 「オリコフォレントインシュア」は1つの〇〇（「オリコ」で再走査しない）・種類の表現も検知", () => {
  const r = checkGuarantorFacts("保証会社はオリコフォレントインシュアと信販系の保証会社となります！！", ONLY_JSN);
  expect(r.cleaned).toBe("保証会社は〇〇と信販系の保証会社となります！！");
  expect(r.unmatched).toEqual(["オリコフォレントインシュア"]);
  expect(r.typeWarnings).toEqual(["種類:信販系"]);
});
it("本文に「独立系」「審査基準が緩い」で入力が信販系だけ → typeWarnings（伏せ字にはしない）", () => {
  const r = checkGuarantorFacts("Aの保証会社はエポスカードと独立系の保証会社となりますので、審査基準が緩い保証会社となります！！", [{ name: "A", company: "エポス", type: "credit" }]);
  expect(r.ok).toBe(false);
  expect(r.unmatched).toEqual([]);
  expect(r.typeWarnings).toEqual(["種類:独立系", "種類:緩い"]);
  expect(r.cleaned).toContain("エポスカード");
});
it("固定テンプレの出力は必ず OK（全種類）", () => {
  expect(checkGuarantorFacts(YUYA_EXPECTED, YUYA).ok).toBe(true);
  const zenhoren: GuarantorProperty[] = [{ name: "アベニュー西長居201号室", company: "全保連", type: "shinyou" }];
  expect(checkGuarantorFacts(buildGuarantorInfoText({ customerName: "", properties: zenhoren, parallel: false }), zenhoren).ok).toBe(true);
  for (const t of GUARANTOR_TYPES) {
    const one: GuarantorProperty[] = [{ name: "A", company: "テスト保証", type: t }];
    expect(checkGuarantorFacts(buildGuarantorInfoText({ customerName: "", properties: one, parallel: false }), one).ok).toBe(true);
    expect(checkGuarantorFacts(buildGuarantorCheckNote(one), one).ok).toBe(true);
  }
});
it("一般語「ライフ」は単独で走査しない（ライフスタイルを伏せない）", () => {
  const r = checkGuarantorFacts("ライフスタイルに合ったお部屋となります！！", ONLY_JSN);
  expect(r.ok).toBe(true);
  expect(GUARANTOR_SCAN_WORDS[0].length >= GUARANTOR_SCAN_WORDS[GUARANTOR_SCAN_WORDS.length - 1].length).toBe(true);
});
it("英字の短い別名は語境界付き（snapshot・casablanca・JIDAI・NAPOLI を伏せない）・「ナップサック」も伏せない", () => {
  const r = checkGuarantorFacts("snapshot casablanca JIDAI NAPOLI ナップサック の話", ONLY_JSN);
  expect(r.ok).toBe(true);
  expect(r.cleaned).toBe("snapshot casablanca JIDAI NAPOLI ナップサック の話");
  const hit = checkGuarantorFacts("保証会社は JID と NAP と casa です", ONLY_JSN);
  expect(hit.cleaned).toBe("保証会社は 〇〇 と 〇〇 と 〇〇 です");
  expect([...hit.unmatched].sort()).toEqual(["Casa", "ナップ", "日本賃貸保証"].sort());
});
it("半角カナ・全角英字の会社名も元の本文の位置で伏せる（本文全体を NFKC 化しない＝「！！」「（）」が崩れない）", () => {
  const r = checkGuarantorFacts("保証会社はｵﾘｺとなります！！（信販系）ＥＰＯＳも可", ONLY_JSN);
  expect(r.cleaned).toBe("保証会社は〇〇となります！！（信販系）〇〇も可");
  expect([...r.unmatched].sort()).toEqual(["エポスカード", "オリコフォレントインシュア"].sort());
});
it("スタッフ登録の会社（extraCompanies）も入力に無ければ伏せる・入力にあれば伏せない", () => {
  const customs = [{ name: "スモラ保証" }];
  const r = checkGuarantorFacts("Aの保証会社はスモラ保証となります！！", ONLY_JSN, customs);
  expect(r.cleaned).toBe("Aの保証会社は〇〇となります！！");
  expect(r.unmatched).toEqual(["スモラ保証"]);
  const ok = checkGuarantorFacts("Aの保証会社はスモラ保証となります！！", [{ name: "A", company: "スモラ保証", type: "unknown" }], customs);
  expect(ok.ok).toBe(true);
});
it("LLM に渡す事実ブロック: 物件ごとの正規名と種類・許された言い回し・並行審査の組・許可語に別名", () => {
  const f = formatGuarantorFacts(YUYA, { parallel: true });
  expect(f.block).toContain(`- ノルデンハイムリバーサイド十三: オリコフォレントインシュア（${GUARANTOR_TYPE_LABELS.credit}）`);
  expect(f.block).toContain("同じ会社の組（カーザSun IとRenatus新大阪=日本セーフティー）");
  expect(f.block).toContain("審査無事通過する為、保証会社が異なるお部屋並行して審査かけさせて頂く事可能です！！");
  expect(f.allowedNames.includes("日本セーフティ")).toBe(true);
  expect(f.allowedNames.includes("オリコ")).toBe(true);
  expect(formatGuarantorFacts(YUYA, { parallel: false }).block).toContain("並行審査の提案は書かない");
});

// ─── 6. 登録（ブレインの語彙・台帳の種類） ───
it("AIX の登録: 正準キー・日本語ラベル・台帳の種類・STAFF_NOTES", () => {
  expect(aixLedgerKind("guarantor_info")?.kind).toBe("guarantor_explained");
  expect(normalizeAixActionKey("guarantor_info")).toBe("guarantor_info");
  expect(normalizeAixActionKey("保証会社について")).toBe("guarantor_info");
  expect(normalizeAixActionKey("guarantor_company")).toBe("guarantor_info");
  expect(!!AIX_STAFF_NOTES.guarantor_info).toBe(true);
  expect(AIX_BUTTON_LABELS.guarantor_info).toBe("保証会社について");
  expect(!!LEDGER_KIND_JA.guarantor_explained).toBe(true);
});
it("ブレインの避ける話題「審査」「保証会社」はこの AIX では外す", () => {
  expect(avoidTopicsForAix("guarantor_info", ["審査", "保証会社", "内覧"])).toEqual(["内覧"]);
});

// ─── 7. 台帳の経路（LEDGER_KINDS の登録漏れを固定） ───
it("送信時の記録 guarantor_explained が台帳に入り、ブレインの行に物件・会社・種類・並行が出る", () => {
  const ledger = buildActionLedger({
    messages: [],
    now: Date.parse("2026-09-15T09:00:00.000Z"),
    recordedFacts: [{
      sent_at: "2026-09-15T08:31:00.000Z", origin: "aix", aix_type: "guarantor_info", kind: "guarantor_explained", status: "done",
      detail: { guarantors: [{ name: "カーザSun I", company: "日本セーフティー", type: "independent" }], parallel: true, propertyNames: ["カーザSun I"], propertyCount: 1 },
      evidence: "guarantor_info",
    }],
  });
  const e = ledger.entries.find((x) => x.kind === "guarantor_explained");
  expect(!!e).toBe(true);
  expect(e?.status).toBe("done");
  const line = buildLedgerLinesForBrain(ledger);
  expect(line).toContain("保証会社の案内（物件ごとの保証会社・種類）を実行");
  expect(line).toContain("カーザSun I: 日本セーフティー（独立系）／並行審査を勧めた");   // 種類は日本語（GUARANTOR_TYPE_SHORT）
});

// ─── 8. 物件確認した（募集中）に添える説明（2026-09-17 竹内・YUYA 事例）───
it("1件・信販系: 9/16 の実送信の型（クレディセゾンは信販系＝2026-09-26 竹内さん決定。実送信の「信用系」は種類名だけ信販系に・信用系は別の種類）", () => {
  const note = buildGuarantorCheckNote([{ name: "サンキャッスル田川 406号室", company: "クレディセゾン", type: "credit" }]);
  expect(note).toBe("クレディセゾンという信販系の保証会社を使用しており、クレジットカードの滞納歴で審査する保証会社となります！！");
});
it("1件・独立系: 審査が緩い側の文になる（旧実装は種類を見ず信販系の文を付けていた）", () => {
  const note = buildGuarantorCheckNote([{ name: "テスト物件 101号室", company: "日本セーフティ", type: "independent" }]);
  expect(note).toContain("独立系の保証会社を使用しており");
  expect(note).toContain("審査通過しやすい");
  expect(note).toContain("日本セーフティー");      // 名寄せ（入力は「日本セーフティ」）
  expect(/クレジット|滞納/.test(note)).toBe(false);
});
it("1件・全保連（信用系）: 信用系の定義の言葉の文（LICC系とは書かない）", () => {
  const note = buildGuarantorCheckNote([{ name: "A 101号室", company: "全保連", type: "shinyou" }]);
  expect(note).toBe("全保連という信用系の保証会社を使用しており、金融系の情報ではなく過去の家賃滞納やトラブルが無かったかを見る保証会社となります！！");
});
it("複数件で同じ会社: 「こちら2部屋とも〜」（実送信 7/21 の型）", () => {
  const note = buildGuarantorCheckNote([
    { name: "サニーハウス南楠江 303号室", company: "Casa", type: "independent" },
    { name: "アバンティ南堀江ウエスト 601号室", company: "カーサ", type: "independent" },   // 別名も名寄せで同じ会社
  ]);
  expect(note.startsWith("こちら2部屋ともCasaという独立系の保証会社を使用しており")).toBe(true);
  expect(note.split("\n").length).toBe(1);
});
it("会社が分かれる: どの部屋がどの会社か分かるよう物件名を頭に付けて1行ずつ", () => {
  const note = buildGuarantorCheckNote([
    { name: "A 101号室", company: "日本セーフティー", type: "independent" },
    { name: "B 202号室", company: "クレディセゾン", type: "credit" },
  ]);
  const lines = note.split("\n");
  expect(lines.length).toBe(2);
  expect(lines[0].startsWith("A 101号室は日本セーフティーという独立系")).toBe(true);
  expect(lines[1].startsWith("B 202号室はクレディセゾンという信販系")).toBe(true);
});
it("会社名を入れていない物件は無視・全部空なら何も足さない（欄が任意）", () => {
  expect(buildGuarantorCheckNote([])).toBe("");
  expect(buildGuarantorCheckNote([{ name: "A 101号室", company: "   ", type: "unknown" }])).toBe("");
  const mixed = buildGuarantorCheckNote([
    { name: "A 101号室", company: "", type: "unknown" },
    { name: "B 202号室", company: "エポス", type: "credit" },
  ]);
  expect(mixed).toBe("エポスカードという信販系の保証会社を使用しており、クレジットカードの滞納歴で審査する保証会社となります！！");
});
it("種類が不明の会社は審査の緩い・厳しいに触れない", () => {
  const note = buildGuarantorCheckNote([{ name: "A 101号室", company: "オセロ・フィナンシャルサービス", type: "unknown" }]);
  expect(note).toBe("オセロ・フィナンシャルサービスという保証会社を使用しております！！");
  expect(/独立系|LICC|信用系|信販|審査/.test(note)).toBe(false);
});

// ─── 9. 会話から保証会社名を拾う（画面の候補ボタン・旧 AixModal の11社リストを置き換え）───
it("会話の1通から拾う: 長い会社名が優先・別名も正規名で返る・種類も付く", () => {
  expect(detectGuarantorInText("保証会社はオリコフォレントインシュアとなります")).toEqual({ name: "オリコフォレントインシュア", type: "credit" });
  expect(detectGuarantorInText("セゾンで審査します")).toEqual({ name: "クレディセゾン", type: "credit" });
  expect(detectGuarantorInText("保証会社の記載はありません")).toBe(null);
  expect(detectGuarantorInText("")).toBe(null);
});
it("会話（古い順）からは一番新しい発言の保証会社を拾う", () => {
  const msgs = [
    { text: "保証会社は日本セーフティーです" },
    { text: "こちらの物件どうですか？" },
    { text: "管理会社より：保証会社 全保連" },
  ];
  expect(detectGuarantorFromMessages(msgs)).toEqual({ name: "全保連", type: "shinyou" });
  expect(detectGuarantorFromMessages([{ text: "こんにちは" }])).toBe(null);
  expect(detectGuarantorFromMessages([])).toBe(null);
});

// ─── 10. 2026-09-26 竹内さん決定（ナップ=独立系・クレディセゾン=信販系・マスタに無い会社はスタッフの説明どおり）───
it("決定どおりの分類: ナップ=独立系／クレディセゾン・エポス=信販系／全保連・ジェイリース・日本賃貸保証=信用系", () => {
  expect(resolveGuarantor("ナップ賃貸保証").type).toBe("independent");
  expect(resolveGuarantor("クレディセゾン").type).toBe("credit");
  expect(resolveGuarantor("エポス").type).toBe("credit");
  expect(resolveGuarantor("全保連").type).toBe("shinyou");
  expect(resolveGuarantor("ジェイリース").type).toBe("shinyou");
  expect(resolveGuarantor("JID").type).toBe("shinyou");
});
it("足した会社（スタッフが独立系と説明）: シノケン・ほっと保証・レンポッポ・アーク・エイト・オセロ → 独立系", () => {
  for (const [raw, name] of [["シノケンコミュニケーションズ", "シノケンコミュニケーションズ"], ["シノケン", "シノケンコミュニケーションズ"], ["ほっと保証", "ほっと保証"], ["レンポッポ", "レンポッポ"], ["アーク保証", "アーク保証"], ["アーク賃貸保証", "アーク保証"], ["エイト賃貸保証", "エイト賃貸保証"], ["オセロ・フィナンシャルサービス株式会社", "オセロ・フィナンシャルサービス"], ["JPMCファイナンス", "JPMC"]] as const) {
    expect(resolveGuarantor(raw)).toEqual({ name, type: "independent", known: true });
  }
});
it("説明の無い会社は種類を推測しない（不明）", () => {
  for (const raw of ["興和アシスト", "テナントファースト", "プレサンスギャランティ", "ランドインシュア", "パナソニックホームズ賃貸サポート", "エフアール信用保証", "クレデンス"]) {
    const r = resolveGuarantor(raw);
    expect(r.known).toBe(true);
    expect(r.type).toBe("unknown");
  }
});
it("短い呼び名（シノケン・アーク・プレサンス）は本文から拾わない（不動産会社名・一般語と重なる）", () => {
  expect(detectGuarantorInText("シノケンの物件です")).toBe(null);
  expect(detectGuarantorInText("アークヒルズ近くのお部屋")).toBe(null);
  expect(detectGuarantorInText("プレサンス難波のお部屋")).toBe(null);
  expect(detectGuarantorInText("保証会社はエイト賃貸保証です")).toEqual({ name: "エイト賃貸保証", type: "independent" });
  expect(detectGuarantorInText("3番手:K-net となります")).toEqual({ name: "K-net", type: "shinyou" });
});

// ─── 11. 2026-09-26 竹内さん決定（同日3回目・最新）: 種類は3つ（独立系・信販系・信用系）・LICC系は全部信用系・信用系と信販系は違う ───
//   経緯: fd989546「スタッフの信用系＝信販系」（誤り）→ 4a3a0e79「4種類・信用系=K-net」→ 本変更「LICC系を信用系に統合して3種類」
it("種類は3つ＋不明（LICC系という種類は無い）", () => {
  expect([...GUARANTOR_TYPES]).toEqual(["independent", "credit", "shinyou", "unknown"]);
  expect(GUARANTOR_TYPE_SHORT.shinyou).toBe("信用系");
  expect(GUARANTOR_TYPE_SHORT.credit).toBe("信販系");
  expect(GUARANTOR_TYPE_LABELS.shinyou.startsWith("信用系")).toBe(true);
  expect([...GUARANTOR_TYPES_JA]).toEqual(["独立系", "信販系", "信用系", "不明"]);
  for (const t of GUARANTOR_TYPES) {
    expect(GUARANTOR_TYPE_LABELS[t]).notToContain("LICC");
    expect(GUARANTOR_TYPE_SCREENING_NOTE[t]).notToContain("LICC");
    expect(buildGuarantorCheckNote([{ name: "A", company: "テスト保証", type: t }])).notToContain("LICC");
    expect(buildGuarantorInfoText({ customerName: "", properties: [{ name: "A", company: "テスト保証", type: t }], parallel: false })).notToContain("LICC");
  }
  for (const ex of GUARANTOR_INFO_STAFF_EXAMPLES) expect(ex).notToContain("LICC");   // 手本で無くした種類名を見せない
});
it("信用系に入るのは LICC の会社（全保連・ジェイリース・日本賃貸保証）と K-net・エポス/クレディセゾンは信販系・ナップは独立系", () => {
  expect(resolveGuarantor("K-net")).toEqual({ name: "K-net", type: "shinyou", known: true });
  expect(resolveGuarantor("ケーネット").type).toBe("shinyou");
  expect(resolveGuarantor("Knet").type).toBe("shinyou");
  expect([...guarantorNamesByType("shinyou")].sort()).toEqual(["K-net", "ジェイリース", "全保連", "日本賃貸保証"].sort());
  expect(guarantorNamesByType("credit").includes("K-net")).toBe(false);
  expect(guarantorNamesByType("credit").includes("エポスカード")).toBe(true);
  expect(guarantorNamesByType("credit").includes("全保連")).toBe(false);
});
it("種類の定義は竹内さんの言葉に沿う（信販系＝クレジットカード会社・信販会社が母体・一番厳しい／信用系＝金融系の情報ではなく過去の家賃滞納やトラブル）", () => {
  expect(GUARANTOR_TYPE_DEFINITION.credit).toBe("クレジットカード会社や信販会社が母体となっている保証会社。審査は一番厳しい");
  expect(GUARANTOR_TYPE_DEFINITION.shinyou).toBe("金融系の情報ではなく、過去の家賃滞納やトラブルが無かったかを見る保証会社");
  // 独立系は竹内さんの定義なし（説明はスタッフの実送信 SCREENING_NOTE のまま）
  expect(GUARANTOR_TYPE_DEFINITION.independent).toBe("");
});
it("信用系の説明文: 定義の言葉だけ・審査の緩い・厳しいを書かない・信販系の語（クレジット）も LICC の話も持たない", () => {
  expect(GUARANTOR_TYPE_SCREENING_NOTE.shinyou).toBe("信用系の保証会社となり、金融系の情報ではなく過去の家賃滞納やトラブルが無かったかを見る審査となります！！");
  const note = buildGuarantorCheckNote([{ name: "ALEX23", company: "K-net", type: "shinyou" }]);
  expect(note).toBe("K-netという信用系の保証会社を使用しており、金融系の情報ではなく過去の家賃滞納やトラブルが無かったかを見る保証会社となります！！");
  const info = buildGuarantorInfoText({ customerName: "", properties: [{ name: "ハイツ岩本", company: "全保連", type: "shinyou" }], parallel: false });
  expect(info).toContain("の保証会社は全保連と信用系の保証会社となり、金融系の情報ではなく過去の家賃滞納やトラブルが無かったかを見る審査となります！！");
  // 一覧の決まった締めの文（審査無事通過する為・キャンセル料不要・審査かけさせて頂きます）は除いて見る
  const body = (t: string) => t.split("\n").filter((l) => !/審査無事通過する為|キャンセル料不要|審査かけさせて頂きます/.test(l)).join("\n");
  for (const t of [note, info, GUARANTOR_TYPE_SCREENING_NOTE.shinyou]) {
    expect(/緩|厳し|通りやす|通過しやす|中級|クレジット|信販|LICC|加盟/.test(body(t))).toBe(false);
  }
});
it("信用系以外の文は「信用系」と書かない（取り違えの再発防止）", () => {
  for (const t of ["independent", "credit", "unknown"] as const) {
    expect(GUARANTOR_TYPE_LABELS[t]).notToContain("信用系");
    expect(buildGuarantorCheckNote([{ name: "A", company: "テスト保証", type: t }])).notToContain("信用系");
    expect(buildGuarantorInfoText({ customerName: "", properties: [{ name: "A", company: "テスト保証", type: t }], parallel: false })).notToContain("信用系");
  }
});
it("本文の種類の照合（3種類）: 全保連を信用系と書くのは正しい・信販系/独立系の会社を信用系と書いたら注意・LICC系は無くした種類なので注意", () => {
  // 9/23 のスタッフの実送信の呼び方（全保連・ジェイリース・K-net＝信用系）は通る
  expect(checkGuarantorFacts("Aの保証会社は全保連と信用系の保証会社となります！！", [{ name: "A", company: "全保連", type: "shinyou" }]).typeWarnings).toEqual([]);
  expect(checkGuarantorFacts("ジェイリース（信用系）", [{ name: "A", company: "ジェイリース", type: "shinyou" }]).ok).toBe(true);
  // 信販系（エポス・クレディセゾン）を「信用系」と書いたら止める（9/16・9/23 の取り違え）
  expect(checkGuarantorFacts("Aの保証会社はセゾンと信用系の保証会社となります！！", [{ name: "A", company: "クレディセゾン", type: "credit" }]).typeWarnings).toEqual(["種類:信用系"]);
  expect(checkGuarantorFacts("Aの保証会社はエポスカードと信用系の保証会社となります！！", [{ name: "A", company: "エポス", type: "credit" }]).typeWarnings).toEqual(["種類:信用系"]);
  // 独立系（ナップ）を「信用系」と書いたら止める
  expect(checkGuarantorFacts("Aの保証会社はナップと信用系の保証会社となります！！", [{ name: "A", company: "ナップ", type: "independent" }]).typeWarnings).toEqual(["種類:信用系"]);
  // 信用系の会社を「信販系」と書いたら止める
  expect(checkGuarantorFacts("AはK-netという信販系の保証会社", [{ name: "A", company: "K-net", type: "shinyou" }]).typeWarnings).toEqual(["種類:信販系"]);
  expect(checkGuarantorFacts("Aの保証会社は全保連と信販系の保証会社となります！！", [{ name: "A", company: "全保連", type: "shinyou" }]).typeWarnings).toEqual(["種類:信販系"]);
  // 「LICC系」は種類として無くしたので、全保連でも注意（旧の言い回しの混入）
  expect(checkGuarantorFacts("Aの保証会社は全保連とLICC系の保証会社となります！！", [{ name: "A", company: "全保連", type: "shinyou" }]).typeWarnings).toEqual(["種類:LICC系"]);
  expect(checkGuarantorFacts(buildGuarantorCheckNote([{ name: "A", company: "K-net", type: "shinyou" }]), [{ name: "A", company: "K-net", type: "shinyou" }]).ok).toBe(true);
  expect(checkGuarantorFacts(buildGuarantorCheckNote([{ name: "A", company: "クレディセゾン", type: "credit" }]), [{ name: "A", company: "クレディセゾン", type: "credit" }]).ok).toBe(true);
});
it("日本語の種類名: 「信用系」は信用系・旧の「LICC系」「LICC」も信用系・往復できる", () => {
  expect(parseGuarantorTypeJa("信用系")).toBe("shinyou");
  expect(parseGuarantorTypeJa("信販系")).toBe("credit");
  expect(parseGuarantorTypeJa("LICC系")).toBe("shinyou");
  expect(parseGuarantorTypeJa("LICC")).toBe("shinyou");
  expect(parseGuarantorTypeJa("licc")).toBe("shinyou");
  expect(parseGuarantorTypeJa("独立系")).toBe("independent");
  expect(parseGuarantorTypeJa("不明")).toBe("unknown");
  expect(parseGuarantorTypeJa("credit")).toBe("credit");
  expect(parseGuarantorTypeJa("shinyou")).toBe("shinyou");
  expect(parseGuarantorTypeJa("")).toBe(null);
  expect(parseGuarantorTypeJa("なにか")).toBe(null);
  for (const t of GUARANTOR_TYPES) expect(parseGuarantorTypeJa(guarantorTypeJa(t))).toBe(t);
});
it("後方互換: DB・旧画面に残る値 \"licc\" は信用系として読む（落ちない・LICC系と書かない）", () => {
  expect(normalizeGuarantorType("licc")).toBe("shinyou");
  expect(normalizeGuarantorType("LICC")).toBe("shinyou");
  expect(normalizeGuarantorType("credit")).toBe("credit");
  expect(normalizeGuarantorType("なにか")).toBe(null);
  expect(normalizeGuarantorType(null)).toBe(null);
  // 保存済みの "licc" のまま渡されても信用系の文になる（型の外の値＝as で渡す）
  const legacy = [{ name: "A", company: "全保連", type: "licc" as unknown as GuarantorType }];
  expect(buildGuarantorCheckNote(legacy)).toBe("全保連という信用系の保証会社を使用しており、金融系の情報ではなく過去の家賃滞納やトラブルが無かったかを見る保証会社となります！！");
  expect(buildGuarantorInfoText({ customerName: "", properties: legacy, parallel: false })).toContain("の保証会社は全保連と信用系の保証会社となり");
  expect(formatGuarantorFacts(legacy, { parallel: false }).block).toContain(`- A: 全保連（${GUARANTOR_TYPE_LABELS.shinyou}）`);
  expect(checkGuarantorFacts("Aの保証会社は全保連と信用系の保証会社となります！！", legacy).ok).toBe(true);
  // スタッフ登録の会社が旧 "licc" で保存されていても信用系
  expect(resolveGuarantor("スモラ保証", [{ name: "スモラ保証", type: "licc" as unknown as GuarantorType }]).type).toBe("shinyou");
  // 台帳（sent_facts の detail.guarantors）の旧 "licc" もブレインには「信用系」と出す
  const ledger = buildActionLedger({
    messages: [],
    now: Date.parse("2026-09-15T09:00:00.000Z"),
    recordedFacts: [{
      sent_at: "2026-09-15T08:31:00.000Z", origin: "aix", aix_type: "guarantor_info", kind: "guarantor_explained", status: "done",
      detail: { guarantors: [{ name: "ディザイア新大阪", company: "日本賃貸保証", type: "licc" }], parallel: false, propertyNames: ["ディザイア新大阪"], propertyCount: 1 },
      evidence: "guarantor_info",
    }],
  });
  expect(buildLedgerLinesForBrain(ledger)).toContain("ディザイア新大阪: 日本賃貸保証（信用系）");
});
it("会社を混ぜた一覧: 種類の順は 独立系 → 信販系 → 信用系 → 不明", () => {
  const info = buildGuarantorInfoText({ customerName: "", parallel: false, properties: [
    { name: "E", company: "クレデンス", type: "unknown" },
    { name: "C", company: "全保連", type: "shinyou" },
    { name: "D", company: "K-net", type: "shinyou" },
    { name: "B", company: "エポス", type: "credit" },
    { name: "A", company: "日本セーフティー", type: "independent" },
  ] });
  const order = ["・A", "・B", "・C", "・D", "・E"].map((k) => info.indexOf(k));
  expect(order.every((v, i) => v >= 0 && (i === 0 || v > order[i - 1]))).toBe(true);
});
it("プロンプトの一般知識の会社名はマスタから: 全保連・ジェイリースは独立系に並ばず信用系に並ぶ", () => {
  const ind = guarantorNamesByType("independent");
  expect(ind.includes("全保連")).toBe(false);
  expect(ind.includes("ジェイリース")).toBe(false);
  expect(ind.includes("ナップ")).toBe(true);
  expect(guarantorNamesByType("shinyou").includes("ジェイリース")).toBe(true);
  expect(guarantorNamesByType("credit").includes("クレディセゾン")).toBe(true);
  expect(GUARANTOR_OCR_NAME_HINT).toContain("レンポッポ");
  expect(/独立系|LICC|信販|信用系/.test(GUARANTOR_OCR_NAME_HINT)).toBe(false);   // 読み取りには種類を渡さない
});

console.log(`\n${passed} passed, ${failed} failed`);
if (failed > 0) { for (const f of failures) console.log(`  - ${f}`); process.exit(1); }
