// app/lib/__tests__/property-detail-source.test.ts
// 実行: npx tsx app/lib/__tests__/property-detail-source.test.ts（自己完結ハーネス。全 PASS で exit 0）
//
// 2026-09-29 竹内「昨日かなり DeepSeek で API 費用を使った。更に節約できないか」:
//   資料の中身の読み取りを「文字層があれば文字層（推論なし）・無ければ画像」に分ける純関数と、同じ物件の 7日以内の行から写す純関数。
//   材料は売上サポの行（property_pickups.pdf_text）の実物の形（リアプロの元付資料の文字層）を短くした物。
import {
  detailSourceFor, countDetailLabels, reusableLinesByPdfUrl, buildTextDetailUser, planDetailSource, detailModelLabel, pickupRowDetailPlan,
  PROPERTY_TEXT_DETAIL_SYSTEM, DETAIL_TEXT_MIN_CHARS, DETAIL_TEXT_MAX_CHARS, PROPERTY_TEXT_DETAIL_MAX_TOKENS,
} from "../property-detail-source";
import { parseDetailResult, PROPERTY_IMAGE_DETAIL_PROMPT } from "../property-image-read";

let passed = 0, failed = 0; const failures: string[] = [];
function it(name: string, fn: () => void) {
  try { fn(); passed++; console.log(`  ✓ ${name}`); }
  catch (e) { failed++; failures.push(`${name}: ${e instanceof Error ? e.message : String(e)}`); console.log(`  ✗ ${name}\n      ${e instanceof Error ? e.message : String(e)}`); }
}
function expect<T>(actual: T) {
  return {
    toBe(exp: T) { if (actual !== exp) throw new Error(`expected ${JSON.stringify(exp)} got ${JSON.stringify(actual)}`); },
    atLeast(n: number) { if (Number(actual) < n) throw new Error(`${actual} < ${n}`); },
    toContain(sub: string) { if (!String(actual).includes(sub)) throw new Error(`expected to contain ${JSON.stringify(sub)}`); },
    notToContain(sub: string) { if (String(actual).includes(sub)) throw new Error(`expected NOT to contain ${JSON.stringify(sub)}`); },
  };
}

/** リアプロの元付資料の文字層の形（実物を短くした物・金額は伏せ字） */
const AGENT_TEXT = `物件名 サンプルレジデンス 402号室
所在地 大阪市西区北堀江1丁目 交通 大阪メトロ四つ橋線 四ツ橋駅 徒歩5分
賃料 ○○○,○○○円 管理費 ○,○○○円 敷金 なし 礼金 1ヶ月
間取タイプ 1K[洋:6.1畳] 専有面積 22.5㎡ 所在階 4階/10階建 向き 南 築年月 2019年3月 構造 RC
現況 空室 入居時期 即時 引渡 相談
駐車場 なし 駐輪場 有 バイク置場 有
ペット 不可 楽器 不可 保証会社 要（オリコフォレントインシュア） 連帯保証人 不要
設備 バス・トイレ別 独立洗面台 浴室乾燥機 オートロック 宅配BOX 室内洗濯機置場 エアコン
フリーレント なし 入居条件 2人入居不可 事務所利用不可
備考 解約予定 6月30日 広告料 100%`;

/** 「白い表」＝文字層はあるが見出しが写っていない（文字抜けの資料） */
const BLANK_TABLE_TEXT = "株式会社サンプル不動産 " + "〇".repeat(300) + " TEL 06-0000-0000 免許番号 大阪府知事(3)第00000号";

console.log("\n── ★ どこから読むか（detailSourceFor）──");

it("★ 元付資料の文字層 → text（画像を送らない）", () => {
  expect(detailSourceFor(AGENT_TEXT, true)).toBe("text");
  expect(countDetailLabels(AGENT_TEXT)).atLeast(10);
});
it("★ 文字層が無い → image（今までどおり画像・推論 low）", () => {
  expect(detailSourceFor(null, true)).toBe("image");
  expect(detailSourceFor("", true)).toBe("image");
});
it("★ 白い表（長さはあるが見出しが無い）→ image（pdf_has_text=true でも文字層を信じない）", () => {
  expect(BLANK_TABLE_TEXT.length).atLeast(DETAIL_TEXT_MIN_CHARS);
  expect(detailSourceFor(BLANK_TABLE_TEXT, true)).toBe("image");
});
it("短い文字層（見出しはある）→ image", () => {
  expect(detailSourceFor("間取 1K 所在階 3階 駐車場 なし", true)).toBe("image");
});
it("画像も文字層も無い → none", () => {
  expect(detailSourceFor(null, false)).toBe("none");
  expect(detailSourceFor(BLANK_TABLE_TEXT, false)).toBe("none");
});
it("見出しの数は種類で数える（同じ見出しの繰り返しは1つ）", () => {
  expect(countDetailLabels("設備 設備 設備 設備")).toBe(1);
});

console.log("\n── ★ 同じ物件を二度読まない（reusableLinesByPdfUrl）──");
const NOW = Date.parse("2026-09-29T03:00:00Z");
const day = (n: number) => new Date(NOW - n * 86_400_000).toISOString();

it("★ 7日以内の同じ pdf_url の行から写す（新しい方）", () => {
  const m = reusableLinesByPdfUrl([
    { pdf_url: "https://rp/print/1", image_lines: ["駐車場: なし", "ペット: 不可"], created_at: day(2) },
    { pdf_url: "https://rp/print/1", image_lines: ["駐車場: 有"], created_at: day(5) },
    { pdf_url: "https://rp/print/2", image_lines: ["設備: オートロック"], created_at: day(0.5) },
  ], NOW);
  expect(m.size).toBe(2);
  expect(m.get("https://rp/print/1")!.join("|")).toBe("駐車場: なし|ペット: 不可");
  expect(m.get("https://rp/print/2")![0]).toBe("設備: オートロック");
});
it("★ 8日前の行は写さない（募集状況・退去予定は日で変わる）", () => {
  const m = reusableLinesByPdfUrl([{ pdf_url: "https://rp/print/1", image_lines: ["駐車場: なし"], created_at: day(8) }], NOW);
  expect(m.size).toBe(0);
});
it("空の image_lines・pdf_url なし・created_at が読めない行は写さない", () => {
  const m = reusableLinesByPdfUrl([
    { pdf_url: "https://rp/print/1", image_lines: [], created_at: day(1) },
    { pdf_url: null, image_lines: ["駐車場: なし"], created_at: day(1) },
    { pdf_url: "https://rp/print/3", image_lines: ["駐車場: なし"], created_at: null },
    { pdf_url: "https://rp/print/4", image_lines: "not-array", created_at: day(1) },
  ], NOW);
  expect(m.size).toBe(0);
});

console.log("\n── ★ 写し → 文字層 → 画像 の順（planDetailSource・2026-09-29 検証の反証: 写しは文字層が無い行だけ）──");

it("★ 文字層がある行は 7日以内の写しがあっても写さない（毎回 $0.001 で読む方が正確・新しい）", () => {
  const p = planDetailSource(AGENT_TEXT, true, ["駐車場: なし", "ペット: 不可"]);
  expect(p.source).toBe("text");
});
it("★ 文字層が無い行は写しがあれば写す（画像 $0.006 を省く）", () => {
  const p = planDetailSource(null, true, ["駐車場: なし"]);
  expect(p.source).toBe("reuse");
  expect(p.source === "reuse" ? p.lines.join("|") : "").toBe("駐車場: なし");
});
it("白い表（文字抜け）の行も写しがあれば写す・無ければ画像", () => {
  expect(planDetailSource(BLANK_TABLE_TEXT, true, ["設備: オートロック"]).source).toBe("reuse");
  expect(planDetailSource(BLANK_TABLE_TEXT, true, null).source).toBe("image");
  expect(planDetailSource(BLANK_TABLE_TEXT, true, []).source).toBe("image");
});
it("画像も文字層も写しも無ければ none", () => {
  expect(planDetailSource(null, false, null).source).toBe("none");
});

console.log("\n── ★ image_details.model に出所を残す（detailModelLabel）──");

it("★ text:／image:／pickup_text: はモデル名付き・reuse／pickup_lines は語だけ（列追加なし）", () => {
  expect(detailModelLabel("text", "deepseek-flash")).toBe("text:deepseek-flash");
  expect(detailModelLabel("image", "deepseek-flash")).toBe("image:deepseek-flash");
  expect(detailModelLabel("pickup_text", "deepseek-flash")).toBe("pickup_text:deepseek-flash");
  expect(detailModelLabel("reuse", "deepseek-flash")).toBe("reuse");
  expect(detailModelLabel("pickup_lines", "deepseek-flash")).toBe("pickup_lines");
  expect(detailModelLabel("image", "")).toBe("image");
});

console.log("\n── ★ 送る画像を売上サポの行で済ませる（pickupRowDetailPlan）──");

it("★ 行に image_lines があれば写す（DeepSeek を呼ばない）", () => {
  const p = pickupRowDetailPlan([{ image_lines: ["駐車場: 敷地内 空有", "ペット: 不可"], pdf_text: AGENT_TEXT }]);
  expect(p?.kind).toBe("lines");
  expect(p && p.kind === "lines" ? p.lines.length : 0).toBe(2);
});
it("★ image_lines が無ければ文字層を読む（推論なし・$0.001）", () => {
  const p = pickupRowDetailPlan([{ image_lines: null, pdf_text: AGENT_TEXT }]);
  expect(p?.kind).toBe("text");
});
it("どちらも無ければ null（呼び出し側が画像を読む）", () => {
  expect(pickupRowDetailPlan([{ image_lines: [], pdf_text: BLANK_TABLE_TEXT }])).toBe(null);
  expect(pickupRowDetailPlan([])).toBe(null);
});
it("長すぎる・短すぎる行は写さない（image_lines の掃除は ensureImageDetail と同じ線）", () => {
  const p = pickupRowDetailPlan([{ image_lines: ["x", "あ".repeat(121), "駐車場: なし"], pdf_text: null }]);
  expect(p && p.kind === "lines" ? p.lines.join("|") : "").toBe("駐車場: なし");
});

console.log("\n── ★ 文字層の指示文（画像版と同じ線）──");

it("★ 金額・住所・駅徒歩・面積は書かない線が画像版と同じ", () => {
  expect(PROPERTY_TEXT_DETAIL_SYSTEM).toContain("金額・住所・駅徒歩・専有面積は書かない");
  expect(PROPERTY_IMAGE_DETAIL_PROMPT).toContain("金額・住所・駅徒歩・専有面積は書かない");
});
it("★ 項目の一覧が画像版と同じ（増減すると使い先の材料が変わる）", () => {
  const pick = (s: string) => (s.match(/間取り／[\s\S]*?入居条件/)?.[0] ?? "").replace(/\s+/g, "");
  expect(pick(PROPERTY_TEXT_DETAIL_SYSTEM)).toBe(pick(PROPERTY_IMAGE_DETAIL_PROMPT));
  expect(pick(PROPERTY_TEXT_DETAIL_SYSTEM).length).atLeast(40);
});
it("「不明」「記載なし」を作らない線も同じ", () => {
  expect(PROPERTY_TEXT_DETAIL_SYSTEM).toContain("「不明」「記載なし」という行も作らない");
});
it("★ 文字は user に置き、指示は system（固定）＝前置きキャッシュが毎回当たる形", () => {
  const u = buildTextDetailUser(AGENT_TEXT);
  expect(u.startsWith("【資料の文字】\n")).toBe(true);
  expect(u).toContain("保証会社 要（オリコフォレントインシュア）");
  expect(PROPERTY_TEXT_DETAIL_SYSTEM).notToContain("【資料の文字】");
});
it("長い文字層は先頭 6,000 字で切る（資料 2ページで十分）", () => {
  const u = buildTextDetailUser("あ".repeat(10_000));
  expect(u.length).toBe("【資料の文字】\n".length + DETAIL_TEXT_MAX_CHARS);
});
it("推論なしなので上限は小さくてよい（画像版 12,000 に対し 1,500）", () => {
  expect(PROPERTY_TEXT_DETAIL_MAX_TOKENS).toBe(1500);
});

console.log("\n── ★ 文字層の読み取りの返事を同じ純関数で読む（parseDetailResult）──");

it("★ 影の比較（12件）で返った形: 保証会社名・帖数・入居条件がそのまま行になる", () => {
  const r = parseDetailResult(`{"kind":"property","lines":["間取り: 1K[洋6.1帖]","所在階: 4階","向き: 南","築年: 2019年3月","構造: RC","現況: 空室","退去予定: 6月30日","駐車場: なし","駐輪場: 有","バイク置場: 有","ペット: 不可","楽器: 不可","保証会社: 要（オリコフォレントインシュア）","連帯保証人: 不要","洗濯機置場: 室内","設備: バス・トイレ別 独立洗面台 浴室乾燥機 オートロック 宅配BOX エアコン","フリーレント: なし","入居条件: 2人入居不可 事務所利用不可"]}`);
  expect(r.kind).toBe("property");
  // 18行のうち「駐車場: なし」「フリーレント: なし」は既存の線（値が「なし」の行は材料にしない・EMPTY_VALUE_RE）で落ちる＝画像版と同じ扱い
  expect(r.lines.length).toBe(16);
  expect(r.lines.find((l) => l.startsWith("駐車場"))).toBe(undefined);
  expect(r.lines.find((l) => l.startsWith("入居条件"))).toBe("入居条件: 2人入居不可 事務所利用不可");
  expect(r.lines.find((l) => l.startsWith("保証会社"))).toBe("保証会社: 要（オリコフォレントインシュア）");
});
it("文字層が物件の資料でない（見積書）なら中身を書き出さない", () => {
  const r = parseDetailResult(`{"kind":"estimate","lines":["初期費用: ○○円"]}`);
  expect(r.kind).toBe("estimate");
  expect(r.lines.length).toBe(0);
});

console.log(`\n${passed} passed, ${failed} failed`);
if (failed) { for (const f of failures) console.log(`  - ${f}`); process.exit(1); }
