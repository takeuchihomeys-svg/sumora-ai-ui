// 2026-11-12 作業員20 最終チェックの根の直し（全読みの穴: 根1 重みの表・穴1 申込の境界・穴2 受け身禁止・穴4 修正案の食い違い）
// 各スイッチは既定 off（off の時は今までと1文字も変わらない）。文は本番の下書き・スタッフ実送信の型（名前は YUMA に伏せた）
// 実行: npx tsx app/lib/__tests__/final-check-roots.test.ts
import { classifyIssueScope, splitFinalCheckIssues, hasBlockingIssue, issueWeight, isStyleNoErrorCode } from "../final-check-scope";
import { applicationBoundaryKept, revisionStaticFor } from "../final-check-roots";
import { runVocabSemanticChecks, buildSonnetRevisionPrompt } from "../final-check";
import { VIEWING_DATE_ASK_RE } from "../reply-context";
import type { TurnContract, ContractAsk } from "../turn-contract";

let passed = 0, failed = 0; const failures: string[] = [];
function it(name: string, fn: () => void) {
  try { fn(); passed++; console.log(`  ✓ ${name}`); }
  catch (e) { failed++; failures.push(`${name}: ${e instanceof Error ? e.message : String(e)}`); console.log(`  ✗ ${name}\n      ${e instanceof Error ? e.message : String(e)}`); }
}
function eq<T>(a: T, b: T, label = "") { if (JSON.stringify(a) !== JSON.stringify(b)) throw new Error(`${label} expected ${JSON.stringify(b)} but got ${JSON.stringify(a)}`); }

const ask = (o: Partial<ContractAsk>): ContractAsk => ({ quote: "", topic: "other", kind: "question", route: "reply", answer: null, basis: null, aixKey: null, ...o });
const contract = (asks: ContractAsk[]): TurnContract => ({
  asks, leadWith: null, closeOnly: false, mustNot: [], proposals: [], alreadySaid: [], settled: [],
  feeling: { kind: null, acknowledge: false }, humanChecks: [], source: "brain",
});
const ON_TABLE = { FC_SEVERITY_TABLE: "on" };

// ─── 根1 重みの表（FC_SEVERITY_TABLE）───
it("根1 off: 創作約束・主語逆転・承りましたの目的語は今までどおり style（画面から外れる）", () => {
  for (const c of ["CONFIRM_NO_OBJECT", "GOCHOUGO_STAFF_TASK", "UKETAMAWARI_OBJECT_UNANCHORED"]) {
    eq(classifyIssueScope(c, {}), "style", c);
    eq(splitFinalCheckIssues([{ code: c, severity: "block" }], {}).shown.length, 0, c);
    eq(hasBlockingIssue([{ code: c, severity: "block" }], {}), false, c);
  }
});
it("根1 on: 誤りを含む style は fact に戻り、画面に出て、block は止める", () => {
  for (const c of ["CONFIRM_NO_OBJECT", "CONFIRM_SUBJECT_THEFT", "GOCHOUGO_STAFF_TASK", "GOCHOUGO_REVERSED", "UKETAMAWARI_OBJECT_UNANCHORED"]) {
    eq(classifyIssueScope(c, ON_TABLE), "fact", c);
    eq(splitFinalCheckIssues([{ code: c, severity: "block" }], ON_TABLE).shown.length, 1, c);
    eq(hasBlockingIssue([{ code: c, severity: "block" }], ON_TABLE), true, c);
    eq(issueWeight(c, "block", ON_TABLE), { scope: "fact", toRevision: true, toScreen: true, stops: true }, c);
  }
});
it("根1 on でも、文に間違いの無い文体（開口語・締め・骨格・！！の数）は今までどおり画面に出さない", () => {
  for (const c of ["OPENER_UNUSUAL", "EMPTY_CLOSER", "EXCLAMATION_OVERUSE", "PAIR_ELEMENT_MISSING", "SASETE_OVERUSE"]) {
    eq(classifyIssueScope(c, ON_TABLE), "style", c);
    eq(issueWeight(c, "block", ON_TABLE).toScreen, false, c);
  }
  eq(issueWeight("EMPTY_CLOSER", "block", ON_TABLE).toRevision, false, "NO_ERROR は書き直しを省く");
  eq(isStyleNoErrorCode("CONFIRM_NO_OBJECT"), false, "書き直しには元から渡る");
});
it("根1 on でも、他の fact・safety・知らない code は変わらない", () => {
  eq(classifyIssueScope("FABRICATED_AMOUNT", ON_TABLE), "fact");
  eq(classifyIssueScope("BANNED_WORD", ON_TABLE), "safety");
  eq(classifyIssueScope("MADA_SHIRANAI_CODE", ON_TABLE), "fact");
});

// ─── 穴1 AIX_BOUNDARY_APPLICATION（FC_APPLICATION_ANSWER）───
const ON_APP = { FC_APPLICATION_ANSWER: "on" };
const D_DOCS = "YUMAさんお世話になっております！！\nお申込みに必要な書類は、申込フォーマットと本人確認書類（免許証またはマイナンバーカード）の裏表のお写真です😊！！\n審査は保証会社の結果が出るまで1〜2週間程です！！";
const E_DOCS = "お申込みに必要な書類は、申込フォーマットと本人確認書類（免許証またはマイナンバーカード）の裏表のお写真です";
const C_DOCS = "審査に必要な書類を教えてください";
it("穴1 off: 必要書類の答えは今までどおり指摘に残る", () => {
  eq(applicationBoundaryKept({ code: "AIX_BOUNDARY_APPLICATION", evidence: E_DOCS }, { contract: contract([ask({ topic: "screening", route: "reply" })]), draft: D_DOCS, customerText: C_DOCS, env: {} }), false);
});
it("穴1 on（ブレインが返信で答えると決めた）: 必要書類・審査の流れの答えは外す", () => {
  eq(applicationBoundaryKept({ code: "AIX_BOUNDARY_APPLICATION", evidence: E_DOCS }, { contract: contract([ask({ topic: "screening", route: "reply" })]), draft: D_DOCS, customerText: C_DOCS, env: ON_APP }), true);
});
it("穴1 on（ブレインが無い番）: お客様が書類を聞いていれば外す・聞いていなければ外さない", () => {
  eq(applicationBoundaryKept({ code: "AIX_BOUNDARY_APPLICATION", evidence: E_DOCS }, { contract: null, draft: D_DOCS, customerText: C_DOCS, env: ON_APP }), true);
  eq(applicationBoundaryKept({ code: "AIX_BOUNDARY_APPLICATION", evidence: E_DOCS }, { contract: null, draft: D_DOCS, customerText: "ありがとうございます、検討します", env: ON_APP }), false);
});
it("穴1 on: 申込を受け付けた・確定する文（AIX の番）は外さない", () => {
  const d = "正式にお申込みを受け付けました。必要書類は身分証明書・収入証明書・保証人の印鑑証明書の3点です。";
  eq(applicationBoundaryKept({ code: "AIX_BOUNDARY_APPLICATION", evidence: "必要書類は身分証明書・収入証明書・保証人の印鑑証明書の3点です" }, { contract: contract([ask({ topic: "screening", route: "reply" })]), draft: d, customerText: C_DOCS, env: ON_APP }), false);
});
it("穴1 on: ブレインが AIX／約束と決めた項目・他の code は外さない", () => {
  eq(applicationBoundaryKept({ code: "AIX_BOUNDARY_APPLICATION", evidence: E_DOCS }, { contract: contract([ask({ topic: "screening", route: "aix" })]), draft: D_DOCS, customerText: "", env: ON_APP }), false);
  eq(applicationBoundaryKept({ code: "AIX_BOUNDARY_MOVEIN", evidence: E_DOCS }, { contract: contract([ask({ topic: "screening", route: "reply" })]), draft: D_DOCS, customerText: C_DOCS, env: ON_APP }), false);
});

// ─── 穴2 書き直しの指示文の受け身禁止（FC_REVISION_PASSIVE_STAFF）───
const withEnv = <T,>(e: Record<string, string>, fn: () => T): T => {
  const keep: Record<string, string | undefined> = {};
  for (const k of Object.keys(e)) { keep[k] = process.env[k]; process.env[k] = e[k]; }
  try { return fn(); } finally { for (const k of Object.keys(e)) { if (keep[k] === undefined) delete process.env[k]; else process.env[k] = keep[k]; } }
};
const staticOf = () => buildSonnetRevisionPrompt("x", [], {})[0].text;
it("穴2 off: 書き直しの指示文は今までと同じ（受け身は絶対禁止のまま）", () => {
  const t = staticOf();
  eq(t.includes("受け身表現は絶対禁止"), true);
  eq(t.includes("「はい😊！！」開始（Yes/No質問を除く）"), true);
  eq(revisionStaticFor("abc", {}), "abc");
});
it("穴2 on: スタッフの定型「周辺からご条件に合ったお部屋をピックアップして」は変えない・受け身で行動宣言にならない文だけ直す", () => {
  const t = withEnv({ FC_REVISION_PASSIVE_STAFF: "on" }, staticOf);
  eq(t.includes("受け身表現は絶対禁止"), false);
  eq(t.includes("【絶対禁止】個人名"), false);
  eq(t.includes("周辺からご条件に合ったお部屋をピックアップして"), true);
  eq(t.includes("ご満足頂くお部屋が見つかるまで全力でサポート"), true);
  eq(t.includes("以下の問題が検出されました。修正した返信文を作成してください。"), true);
  eq(t.includes("日本橋周辺全域"), true, "エリア名の維持は残る");
});

// ─── 穴4 修正案と block の文型の食い違い（FC_SUGGESTION_ALIGN）───
const ON_SUG = { FC_SUGGESTION_ALIGN: "on" };
const ctx = { sentPropertiesCount: 1, customerName: "YUMA", lastCustomerMessage: "ありがとうございます！", recentMessages: [{ sender: "staff", text: "物件を送らせて頂きました😊" }, { sender: "customer", text: "ありがとうございます！" }] };
const T_NOCOND = "YUMAさん、ご都合よろしいお日にちにお部屋ご案内させて頂きます！！";
it("穴4 off: V3 の修正案は今までどおり（block の文型 VIEWING_DATE_ASK_RE に当たる）", () => {
  const sug = runVocabSemanticChecks(T_NOCOND, ctx).find((i) => i.code === "GOCHOUGO_NO_CONDITION")?.suggestion ?? "";
  eq(VIEWING_DATE_ASK_RE.test(sug), true);
});
it("穴4 on: V3 の修正案は通常返信で許される形（条件節つき・日時なし）で、block の文型に当たらない", () => {
  const sug = withEnv(ON_SUG, () => runVocabSemanticChecks(T_NOCOND, ctx).find((i) => i.code === "GOCHOUGO_NO_CONDITION")?.suggestion ?? "");
  eq(sug.length > 0, true);
  eq(VIEWING_DATE_ASK_RE.test(sug.replace(/^「|」の宣言形.*$/g, "")), false, sug);
  eq(/よろしければ|お気に召されましたら/.test(sug), true, sug);
});
it("穴4 on: V12 は「はい！！ご案内可能です😊」とお客様の質問に答える形を指摘しない（off では指摘する）", () => {
  const c2 = { ...ctx, lastCustomerMessage: "明日お部屋の内覧はできますか？" };
  const T = "はい！！お部屋ご案内可能です😊！！";
  eq(runVocabSemanticChecks(T, c2).some((i) => i.code === "GUIDE_POSSIBLE_NO_DATE"), true);
  eq(withEnv(ON_SUG, () => runVocabSemanticChecks(T, c2).some((i) => i.code === "GUIDE_POSSIBLE_NO_DATE")), false);
  eq(withEnv(ON_SUG, () => runVocabSemanticChecks("お部屋ご案内可能です！！", c2).some((i) => i.code === "GUIDE_POSSIBLE_NO_DATE")), true, "はい始まりでない丸投げは今までどおり指摘");
});
it("穴4 on: 書き直しの指示文の「はい😊禁止」は、その場で答える返信を除く", () => {
  const t = withEnv(ON_SUG, staticOf);
  eq(t.includes("その場で答える返信・Yes/No質問は「はい」で始めてよい"), true);
  eq(t.includes("受け身表現は絶対禁止"), true, "穴2 は別スイッチ＝このスイッチだけでは変わらない");
});

console.log(`\n${passed} passed, ${failed} failed`);
if (failed) { for (const f of failures) console.log(" - " + f); process.exit(1); }
