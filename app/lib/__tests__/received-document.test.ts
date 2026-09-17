// 2026-09-17 竹内（友哉事例）: お客様が送った PDF を保存・表示し、届いている書類をもう一度お願いしない
// 実行: npx tsx app/lib/__tests__/received-document.test.ts（自己完結ハーネス。全 PASS で exit 0）
import {
  FILE_MSG_PREFIX,
  fileMessageText,
  fileNameFromText,
  classifyDocumentName,
  provesEmployment,
  detectReceivedDocuments,
  buildReceivedDocumentNote,
} from "../received-document";
import { customerOwnWords, isImageTextUnit } from "../reply-context";

let passed = 0, failed = 0; const failures: string[] = [];
function it(name: string, fn: () => void) {
  try { fn(); passed++; console.log(`  ✓ ${name}`); }
  catch (e) { failed++; failures.push(`${name}: ${e instanceof Error ? e.message : String(e)}`); console.log(`  ✗ ${name}\n      ${e instanceof Error ? e.message : String(e)}`); }
}
function expect<T>(actual: T) {
  return {
    toBe(exp: T) { if (JSON.stringify(actual) !== JSON.stringify(exp)) throw new Error(`expected ${JSON.stringify(exp)} but got ${JSON.stringify(actual)}`); },
    toContain(s: string) { if (typeof actual !== "string" || !actual.includes(s)) throw new Error(`expected ${JSON.stringify(actual)} to contain ${JSON.stringify(s)}`); },
    notToContain(s: string) { if (typeof actual === "string" && actual.includes(s)) throw new Error(`expected ${JSON.stringify(actual)} not to contain ${JSON.stringify(s)}`); },
  };
}

console.log("\n[ファイルメッセージの本文]");
it("ファイル名を残す・無ければ印だけ", () => {
  expect(fileMessageText("労働条件通知書_中谷友哉.pdf")).toBe("[ファイル] 労働条件通知書_中谷友哉.pdf");
  expect(fileMessageText("")).toBe(FILE_MSG_PREFIX);
  expect(fileMessageText(null)).toBe(FILE_MSG_PREFIX);
  expect(fileNameFromText("[ファイル] 労働条件通知書_中谷友哉.pdf")).toBe("労働条件通知書_中谷友哉.pdf");
  expect(fileNameFromText("[ファイル]")).toBe(null);
  expect(fileNameFromText("お願いします")).toBe(null);
});

console.log("\n[書類の種類]");
it("友哉さんの PDF は労働条件通知書＝在籍・収入の証明", () => {
  expect(classifyDocumentName("労働条件通知書_中谷友哉.pdf")).toBe("労働条件通知書");
  expect(provesEmployment("労働条件通知書")).toBe(true);
  expect(provesEmployment("運転免許証")).toBe(false);
  expect(provesEmployment(null)).toBe(false);
});
it("よくある書類名を拾う・関係ない名前は拾わない", () => {
  expect(classifyDocumentName("在籍証明書.pdf")).toBe("在籍証明書");
  expect(classifyDocumentName("源泉徴収票2025.pdf")).toBe("源泉徴収票");
  expect(classifyDocumentName("給与明細_9月.pdf")).toBe("給与明細");
  expect(classifyDocumentName("運転免許証.jpg")).toBe("運転免許証");
  expect(classifyDocumentName("入居申込書.pdf")).toBe("申込書");
  expect(classifyDocumentName("IMG_0421.pdf")).toBe(null);
  expect(classifyDocumentName("")).toBe(null);
});

console.log("\n[会話から届いている書類を拾う]");
const 友哉 = [
  { sender: "staff", text: "在籍証明に関しては株式会社Dank-All からの定期的な収入がある証明となりますので、必要となります！！", created_at: "2026-09-16T04:08:00Z" },
  { sender: "customer", text: "[ファイル] 労働条件通知書_中谷友哉.pdf", created_at: "2026-09-16T09:29:00Z" },
  { sender: "customer", text: "いかがでしょうか", created_at: "2026-09-16T09:29:30Z" },
  { sender: "staff", text: "お送りいただきありがとうございます！！\n確認させていただきます😌！！", created_at: "2026-09-16T10:02:00Z" },
  { sender: "customer", text: "お願いします", created_at: "2026-09-17T00:04:00Z" },
];
it("友哉さんの会話から PDF を拾い、受信時刻（JST）を添える", () => {
  const docs = detectReceivedDocuments(友哉);
  expect(docs.length).toBe(1);
  expect(docs[0].via).toBe("file");
  expect(docs[0].fileName).toBe("労働条件通知書_中谷友哉.pdf");
  expect(docs[0].label).toBe("労働条件通知書");
  expect(docs[0].at).toBe("9/16 18:29"); // 09:29Z = 18:29 JST
});
it("こちらが送ったファイルは拾わない・物件のスクショは書類にしない", () => {
  expect(detectReceivedDocuments([{ sender: "staff", text: "[ファイル] 御見積書.pdf" }]).length).toBe(0);
  expect(detectReceivedDocuments([{ sender: "customer", text: "[画像] グランドコート難波 702 家賃70,000円" }]).length).toBe(0);
});
it("書類の画像は種類が読めた物・本人確認書類だけ拾う", () => {
  expect(detectReceivedDocuments([{ sender: "customer", text: "[画像] 運転免許証 大阪府公安委員会" }])[0].label).toBe("運転免許証");
  expect(detectReceivedDocuments([{ sender: "customer", text: "[画像]", image_type: "id_document" }])[0].label).toBe("本人確認書類");
  expect(detectReceivedDocuments([{ sender: "customer", text: "[画像]", image_type: "floor_plan" }]).length).toBe(0);
});
it("同じ書類は1つに・新しい順の上限を守る", () => {
  const many = Array.from({ length: 8 }, (_, i) => ({ sender: "customer", text: `[ファイル] 書類${i}.pdf` }));
  expect(detectReceivedDocuments(many).length).toBe(5);
  expect(detectReceivedDocuments([
    { sender: "customer", text: "[ファイル] 労働条件通知書_中谷友哉.pdf" },
    { sender: "customer", text: "[ファイル] 労働条件通知書_中谷友哉.pdf" },
  ]).length).toBe(1);
});

console.log("\n[生成に渡す材料]");
it("届いている書類と「もう一度お願いしない」が入る・実データの根拠つき", () => {
  const note = buildReceivedDocumentNote(detectReceivedDocuments(友哉));
  expect(note).toContain("労働条件通知書_中谷友哉.pdf（労働条件通知書） — 9/16 18:29 受信");
  expect(note).toContain("もう一度お願いしない");
  expect(note).toContain("「在籍証明の作成をお願いします」等は書かない");
  expect(note).toContain("お送りいただきありがとうございます");
  expect(note).toContain("53件中44件");
  expect(buildReceivedDocumentNote([])).toBe("");
});
it("在籍・収入の証明でない書類では在籍証明の行を出さない", () => {
  const note = buildReceivedDocumentNote(detectReceivedDocuments([{ sender: "customer", text: "[ファイル] 運転免許証.pdf" }]));
  expect(note).toContain("運転免許証");
  expect(note).notToContain("在籍証明の作成をお願いします");
});

console.log("\n[ファイル名はお客様の言葉ではない（reply-context）]");
it("ファイルの通は意図の判定に使わず、印だけに置き換わる", () => {
  expect(isImageTextUnit("[ファイル] 労働条件通知書_中谷友哉.pdf")).toBe(true);
  expect(customerOwnWords("[ファイル] 労働条件通知書_中谷友哉.pdf")).toBe("[ファイル]");
  expect(customerOwnWords("[画像] グランドコート難波 702")).toBe("[画像]");
  expect(customerOwnWords("お願いします")).toBe("お願いします");
});

console.log(`\n${passed} passed, ${failed} failed`);
if (failed > 0) { for (const f of failures) console.log(`  - ${f}`); process.exit(1); }
