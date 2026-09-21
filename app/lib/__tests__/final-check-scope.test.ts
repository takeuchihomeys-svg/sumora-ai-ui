// 最終チェックは「ハルシネーションを止める物」に絞る（竹内 2026-09-21）。
//
// 竹内「ファイナルチェックはハルシネーションがないようにする部分となる。逆に足を引っ張るようなことはしない。
//   ブレインで判断されて文生成されてるのだから、ブレインの部分は生成の際に完了できている」
//
// 実行: npx tsx app/lib/__tests__/final-check-scope.test.ts（全 PASS で exit 0）
import { classifyIssueScope, splitFinalCheckIssues, hasBlockingIssue } from "../final-check-scope";

let passed = 0, failed = 0; const failures: string[] = []; let current = "";
function describe(name: string, fn: () => void) { current = name; fn(); }
function it(name: string, fn: () => void) {
  try { fn(); passed++; console.log(`  ✓ ${current} › ${name}`); }
  catch (e) { failed++; failures.push(`${current} › ${name}: ${e instanceof Error ? e.message : String(e)}`); console.log(`  ✗ ${current} › ${name}\n      ${e instanceof Error ? e.message : String(e)}`); }
}
function expect<T>(actual: T) {
  return { toBe(exp: T) { if (actual !== exp) throw new Error(`expected ${JSON.stringify(exp)} but got ${JSON.stringify(actual)}`); } };
}

describe("ハルシネーション・事実の指摘は出す", () => {
  it("★ F1 作り話・根拠なしは fact", () => {
    for (const c of ["FABRICATED_POLICY_DET", "FABRICATED_SEARCH_REPORT", "FABRICATED_NAME",
      "UNSENT_CLAIM", "REASSURANCE_NO_BASIS", "UNGROUNDED_CONDITION", "COST_ASSERTION_NO_ESTIMATE",
      "SCHEDULE_ASSERT_UNCONFIRMED", "TIME_INVALID", "TIME_INVALID_HONIJITSU",
      "ECHO_FROM_BRAIN_NOT_CUSTOMER", "NAME_PLACEHOLDER", "GUIDE_POSSIBLE_NO_DATE"]) {
      if (classifyIssueScope(c) !== "fact") throw new Error(`${c} が fact ではない`);
    }
  });
  it("★ F2 質問の取りこぼし・段階ミスマッチ・二重宣言は fact（会話の事実に関わる）", () => {
    for (const c of ["MISSED_QUESTION", "STAGE_MISMATCH", "DOUBLE_DECLARATION", "STAFF_REQUEST_OMITTED",
      "CONDITION_ADD_MISROUTED", "SUBJECT_CONFUSION", "RULE_VIOLATION"]) {
      if (classifyIssueScope(c) !== "fact") throw new Error(`${c} が fact ではない`);
    }
  });
  it("★ F3 知らない code は fact（分類を書き忘れた物を黙って捨てない）", () => {
    expect(classifyIssueScope("MADA_SHIRANAI_CODE")).toBe("fact");
    expect(classifyIssueScope("")).toBe("fact");
    expect(classifyIssueScope(null)).toBe("fact");
  });
});

describe("送信の歯止めは出す", () => {
  it("★ S1 自動送信・センシティブ・二重送信は safety", () => {
    for (const c of ["UNCHECKED_AUTO_SEND", "SENSITIVE_CASE", "DUPLICATE_OF_SENT",
      "BANNED_WORD", "NG_PROPERTY_MENTION", "PARTIALLY_UNCHECKED"]) {
      if (classifyIssueScope(c) !== "safety") throw new Error(`${c} が safety ではない`);
    }
  });
});

describe("★ 文体・構成は出さない（数えるだけ）", () => {
  it("★ T1 開口語の指摘は style（竹内「一択などにしたらボトルネック」）", () => {
    for (const c of ["OPENER_MISMATCH", "OPENER_UNUSUAL", "GRATITUDE_OPENING", "CONDITION_OPENING",
      "THANK_OPENING", "OPENING_GREETING_MISMATCH", "FILLER_GREETING"]) {
      if (classifyIssueScope(c) !== "style") throw new Error(`${c} が style ではない`);
    }
  });
  it("★ T2 締め・何卒の位置は style", () => {
    for (const c of ["CLOSER_MISSING", "EMPTY_CLOSER", "PASSIVE_CLOSER", "NANISOTSU_MISPLACED"]) {
      if (classifyIssueScope(c) !== "style") throw new Error(`${c} が style ではない`);
    }
  });
  it("★ T3 言い回しの数（感嘆符・させて頂く・呼びかけ）は style", () => {
    for (const c of ["EXCLAMATION_OVERUSE", "SASETE_OVERUSE", "NAME_OVERUSE", "DOUBLE_KEIGO"]) {
      if (classifyIssueScope(c) !== "style") throw new Error(`${c} が style ではない`);
    }
  });
  it("★ T4 骨格・セルの必須要素は style（ブレインと生成の担当）", () => {
    for (const c of ["REPLY_SKELETON_MISSING", "PAIR_ELEMENT_MISSING", "CELL_AVOID_CONFLICT",
      "WE_DO_MISSING", "WE_DO_MISSING_DET", "PASSIVE_ONLY"]) {
      if (classifyIssueScope(c) !== "style") throw new Error(`${c} が style ではない`);
    }
  });
});

describe("分ける", () => {
  const ISSUES = [
    { code: "FABRICATED_SEARCH_REPORT", severity: "block" },
    { code: "OPENER_UNUSUAL", severity: "info" },
    { code: "EXCLAMATION_OVERUSE", severity: "warning" },
    { code: "MISSED_QUESTION", severity: "warning" },
    { code: "SENSITIVE_CASE", severity: "block" },
  ];
  it("★ D1 文体は見せる側に入らない", () => {
    const { shown, styleOnly } = splitFinalCheckIssues(ISSUES);
    expect(shown.length).toBe(3);
    expect(styleOnly.length).toBe(2);
    expect(shown.map((i) => i.code).join(",")).toBe("FABRICATED_SEARCH_REPORT,MISSED_QUESTION,SENSITIVE_CASE");
  });
  it("★ D2 文体が block でも作り直しを起こさない", () => {
    expect(hasBlockingIssue([{ code: "REPLY_SKELETON_MISSING", severity: "block" }])).toBe(false);
    expect(hasBlockingIssue([{ code: "FABRICATED_SEARCH_REPORT", severity: "block" }])).toBe(true);
    expect(hasBlockingIssue([{ code: "SENSITIVE_CASE", severity: "block" }])).toBe(true);
  });
  it("D3 空でも落ちない", () => {
    expect(splitFinalCheckIssues([]).shown.length).toBe(0);
    expect(hasBlockingIssue([])).toBe(false);
  });
});

console.log(`\n${passed} passed, ${failed} failed`);
if (failed) { for (const f of failures) console.log(`  - ${f}`); process.exit(1); }
