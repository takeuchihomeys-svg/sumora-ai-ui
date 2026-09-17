// 2026-09-15 竹内（YUYA 事例）: AIX【保証会社について】の名寄せ・種類の既定・並行審査の判定・固定テンプレ・事実の照合・登録
// 実行: npx tsx app/lib/__tests__/guarantor-companies.test.ts（自己完結ハーネス。全 PASS で exit 0）
import {
  normalizeGuarantorName, resolveGuarantor, isMasterGuarantor, guarantorAliasesOf, planParallelScreening, buildGuarantorInfoText,
  buildGuarantorListText, formatGuarantorFacts, checkGuarantorFacts, GUARANTOR_TYPE_LABELS, GUARANTOR_SCAN_WORDS, type GuarantorProperty,
  buildGuarantorCheckNote, detectGuarantorInText, detectGuarantorFromMessages,
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
it("全保連 → LICC系・既知／エポス → 信販系", () => {
  expect(resolveGuarantor("全保連")).toEqual({ name: "全保連", type: "licc", known: true });
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
  { name: "ディザイア新大阪", company: "日本賃貸保証", type: "licc" },
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

・ディザイア新大阪
の保証会社は日本賃貸保証とLICC系の保証会社となり、独立系の保証会社に比べると審査基準は上がりますが、信用情報を重視した審査基準とはなりませんので審査通過する可能性十分に御座います！！

・ノルデンハイムリバーサイド十三
の保証会社はオリコフォレントインシュアと信販系の保証会社となり、クレジット審査となりますので比較的審査厳し目のお部屋となります！！

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
it("固定テンプレの出力は必ず OK（LICC系の「独立系の保証会社に比べると」を独立系と数えない）", () => {
  expect(checkGuarantorFacts(YUYA_EXPECTED, YUYA).ok).toBe(true);
  const liccOnly: GuarantorProperty[] = [{ name: "アベニュー西長居201号室", company: "全保連", type: "licc" }];
  expect(checkGuarantorFacts(buildGuarantorInfoText({ customerName: "", properties: liccOnly, parallel: false }), liccOnly).ok).toBe(true);
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
it("1件・信用系: 9/16 の実送信そのまま（クレディセゾン→信用系・クレジットカードの滞納歴）", () => {
  const note = buildGuarantorCheckNote([{ name: "サンキャッスル田川 406号室", company: "クレディセゾン", type: "credit" }]);
  expect(note).toBe("クレディセゾンという信用系の保証会社を使用しており、クレジットカードの滞納歴で審査する保証会社となります！！");
});
it("1件・独立系: 審査が緩い側の文になる（旧実装は種類を見ず信販系の文を付けていた）", () => {
  const note = buildGuarantorCheckNote([{ name: "テスト物件 101号室", company: "日本セーフティ", type: "independent" }]);
  expect(note).toContain("独立系の保証会社を使用しており");
  expect(note).toContain("審査通過しやすい");
  expect(note).toContain("日本セーフティー");      // 名寄せ（入力は「日本セーフティ」）
  expect(/クレジット|滞納/.test(note)).toBe(false);
});
it("1件・LICC系: 【保証会社について】と同じ言い回し（信用情報を重視した審査基準とはなりません）", () => {
  const note = buildGuarantorCheckNote([{ name: "A 101号室", company: "全保連", type: "licc" }]);
  expect(note).toContain("全保連というLICC系の保証会社を使用しており");
  expect(note).toContain("信用情報を重視した審査基準とはなりませんので審査通過する可能性十分に御座います！！");
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
  expect(lines[1].startsWith("B 202号室はクレディセゾンという信用系")).toBe(true);
});
it("会社名を入れていない物件は無視・全部空なら何も足さない（欄が任意）", () => {
  expect(buildGuarantorCheckNote([])).toBe("");
  expect(buildGuarantorCheckNote([{ name: "A 101号室", company: "   ", type: "unknown" }])).toBe("");
  const mixed = buildGuarantorCheckNote([
    { name: "A 101号室", company: "", type: "unknown" },
    { name: "B 202号室", company: "エポス", type: "credit" },
  ]);
  expect(mixed).toBe("エポスカードという信用系の保証会社を使用しており、クレジットカードの滞納歴で審査する保証会社となります！！");
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
  expect(detectGuarantorFromMessages(msgs)).toEqual({ name: "全保連", type: "licc" });
  expect(detectGuarantorFromMessages([{ text: "こんにちは" }])).toBe(null);
  expect(detectGuarantorFromMessages([])).toBe(null);
});

console.log(`\n${passed} passed, ${failed} failed`);
if (failed > 0) { for (const f of failures) console.log(`  - ${f}`); process.exit(1); }
