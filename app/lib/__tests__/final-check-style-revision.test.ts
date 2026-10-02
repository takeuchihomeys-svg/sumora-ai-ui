// app/lib/__tests__/final-check-style-revision.test.ts — 2026-10-02 文に間違いの無い文体だけの指摘では書き直さない（実行: npx tsx app/lib/__tests__/final-check-style-revision.test.ts）
import { isStyleOnlyNoError, isStyleNoErrorCode, styleNoErrorCodesForTest, classifyIssueScope } from "../final-check-scope";
let pass = 0, fail = 0;
const t = (name: string, ok: boolean, extra = "") => { if (ok) { pass++; console.log(`  OK  ${name}`); } else { fail++; console.log(`  NG  ${name} ${extra}`); } };
const w = (code: string) => ({ code, severity: "warning" });

const { list, notInStyle } = styleNoErrorCodesForTest();
t("一覧は全部 style（画面に出さない物）の部分集合", notInStyle.length === 0, notInStyle.join(","));
t("一覧の code はどれも style に分類される", list.every((c) => classifyIssueScope(c) === "style"));

// 本番の記録（送った例・9/10〜）で書き直しの引き金になっていた形
t("何卒の位置だけ → 書き直さない", isStyleOnlyNoError([w("NANISOTSU_MISPLACED")]));
t("！！の数＋何卒＋受け身のお願い → 書き直さない", isStyleOnlyNoError([w("EXCLAMATION_OVERUSE"), w("NANISOTSU_MISPLACED"), w("HUMBLE_WAIT")]));
t("名前の呼びかけの数＋フィラー挨拶 → 書き直さない", isStyleOnlyNoError([w("NAME_OVERUSE"), w("FILLER_GREETING")]));

// 間違いを含む文体・事実は今までどおり書き直す
t("二重敬語（文法の誤り）は書き直す", !isStyleOnlyNoError([w("DOUBLE_KEIGO")]) && !isStyleNoErrorCode("DOUBLE_KEIGO"));
t("自敬表現は書き直す", !isStyleNoErrorCode("SELF_HONORIFIC"));
t("未履行を完了形（PROMISE_ECHO_MISMATCH）は書き直す", !isStyleNoErrorCode("PROMISE_ECHO_MISMATCH"));
t("遅れていないのに遅れの謝罪は書き直す", !isStyleNoErrorCode("OPENING_GREETING_UNEXPECTED"));
t("次に動くのはこちらなのに連絡待ちは書き直す", !isStyleNoErrorCode("AWAIT_CONTACT_MISPLACED"));
t("お客様の言っていない語は書き直す", !isStyleNoErrorCode("VOCAB_MIRROR_MISMATCH"));
t("頼まれていない条件の緩和は書き直す", !isStyleNoErrorCode("CONDITION_RELAX_UNASKED"));
t("気持ちの代弁は書き直す", !isStyleNoErrorCode("SYMPATHY_ECHO"));
t("文体＋質問の取りこぼし（事実）→ 書き直す", !isStyleOnlyNoError([w("NANISOTSU_MISPLACED"), w("MISSED_QUESTION")]));
t("文体＋会社のルール違反 → 書き直す", !isStyleOnlyNoError([w("NANISOTSU_MISPLACED"), w("RULE_VIOLATION")]));
t("知らない code → 書き直す（迷ったら今までどおり）", !isStyleOnlyNoError([w("SOMETHING_NEW")]));
t("空 → 判断しない（false）", !isStyleOnlyNoError([]));

console.log(`\n合計: ${pass}/${pass + fail}`); if (fail) process.exit(1);
