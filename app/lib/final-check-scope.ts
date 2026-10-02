// app/lib/final-check-scope.ts
// 最終チェックが「何を止める物か」を1か所で決める（純関数・DB 依存なし）。
//
// 2026-09-21 竹内:
//   「ファイナルチェックはハルシネーションがないようにする部分となる。逆に足を引っ張るようなことはしない。
//     ブレインで判断されて文生成されてるのだから、ブレインの部分は生成の際に完了できている。
//     ファイナルチェックはハルシネーションが起きた文をお客さんに送るということを事前に防ぐ部分だから。
//     返信生成を一択などにしたらボトルネックになる可能性が高い」
//
// ■ それまでの形
//   final-check は 74 種類の指摘を出しており、その多くが**文体・構成**だった
//   （開口語・締め・感嘆符の数・「させて頂く」の数・呼びかけの数・骨格の欠け…）。
//   文体はブレインと生成の段階で決まっている物なので、検査が別の物差しで言うと
//     ・スタッフの画面が「確認推奨」で埋まって、本当に危ない指摘が埋もれる
//     ・block なら作り直しが走って費用が倍になる
//   ＝ 足を引っ張る。
//
// ■ 直した形
//   指摘を3つに分ける:
//     fact   … 事実・ハルシネーション（嘘がお客様に届く）        → **出す**
//     safety … 送信の歯止め（自動送信・センシティブ・二重送信）    → **出す**
//     style  … 文体・構成（開口語・締め・言い回しの数・骨格）      → **出さない**（数えるだけ）
//   style は消さずに残して数える（学習と監査のため）。画面にもブロックにも出さない。
//
// ⚠ 新しい code を足す時は必ずここに分類を書く。書き忘れた code は fact 扱い（＝出す）にする。
//   知らない物を黙って捨てない（設計知見「迷ったら安全側」）。
//   fact（一覧は持たない＝既定）に入る物の例: FABRICATED_*・*_ASSERTION・UNSENT_CLAIM・RENT_NEGOTIATION_PROMISE・
//   MGMT_DISCOUNT_NEGOTIATION_PROMISE・COMPANY_FACT_CONTRADICTION（2026-09-23 会社の事実に反する断定・block）

export type IssueScope = "fact" | "safety" | "style";

/** 文体・構成の指摘（お客様に嘘は届かない。ブレインと生成の担当） */
const STYLE_CODES: ReadonlySet<string> = new Set([
  // 開口語・挨拶
  "OPENER_MISMATCH", "OPENER_UNUSUAL", "OPENING_GREETING_MISMATCH", "OPENING_GREETING_UNEXPECTED",
  "THANK_OPENING", "NAME_BEFORE_OPENING", "INTRO_REPEAT", "FILLER_GREETING",
  "GRATITUDE_OPENING", "CONDITION_OPENING",
  // 締め
  "CLOSER_MISSING", "EMPTY_CLOSER", "PASSIVE_CLOSER", "NANISOTSU_MISPLACED",
  "CLOSING_FORWARD_PUSH", "HUMBLE_WAIT", "AWAIT_CONTACT_MISPLACED",
  // 言い回しの数・重複
  "EXCLAMATION_OVERUSE", "SASETE_OVERUSE", "NAME_OVERUSE", "DOUBLE_KEIGO", "SELF_HONORIFIC",
  "LIST_STRUCTURE", "SPLIT_ACK_REPLY",
  // 骨格・必須要素（セル）
  "REPLY_SKELETON_MISSING", "PAIR_ELEMENT_MISSING", "CELL_AVOID_CONFLICT",
  "WE_DO_MISSING", "WE_DO_MISSING_DET", "PASSIVE_ONLY",
  // 共感・言葉づかい
  "FEELING_TEMPLATE", "SYMPATHY_ECHO", "VOCAB_MIRROR_MISMATCH", "NEGATIVE_APOLOGY",
  "CONDITION_ECHO_MISSING", "ECHO_CONFIRM", "PROMISE_ECHO_MISMATCH",
  // 2026-09-21 実データ45日の全 code を目で読んで足した分（scripts/audit-finalcheck-after.ts）。
  //   どれも「嘘が届く」話ではなく、書き方・構成の話だった:
  //   PROMISE_ECHO_MISSING     「短い了承の場面ですが直前スタッフ約束の復唱WE DO文がありません」＝骨格
  //   COMMIT_AFTER_DELIVERABLE 「成果物送付時に全力サポート締めを重ねている」＝締めの重ね
  //   GENERIC_ONLY_REPLY       中身が定型だけ＝構成
  //   REPEATED_SENTENCE        「締めの文がこの会話で既に送った文とほぼ同じ（言い方を変えて）」＝言い回し
  //     ※ 繰り返しは 2026-09-21 に生成側（previous-send-note）で材料として扱うようにした。検査では出さない
  "PROMISE_ECHO_MISSING", "COMMIT_AFTER_DELIVERABLE", "GENERIC_ONLY_REPLY", "REPEATED_SENTENCE",
  "GOCHOUGO_AFTER_DATE", "GOCHOUGO_NO_CONDITION", "GOCHOUGO_REVERSED", "GOCHOUGO_STAFF_TASK",
  "UKETAMAWARI_OBJECT_UNANCHORED", "CONFIRM_NO_OBJECT", "CONFIRM_OBJECT_UNSTATED", "CONFIRM_SUBJECT_THEFT",
  // 言い過ぎ・押し方（売り方の話。嘘ではない）
  "CONSIDER_PUSH", "URGENCY_NO_INTENT", "APPLY_PUSH_NO_INTENT", "UNPROMPTED_PROPOSAL",
  "PREEMPTIVE_HEDGE", "HEDGE_WITHOUT_SEARCH_DECL", "SELF_HEDGE_ECHO",
  "RESULT_EXCUSE", "WIDEN_EXCUSE_REDUNDANT", "CONDITION_RELAX_UNASKED",
]);

/** 送信の歯止め（嘘ではないが、送ってしまうと取り返しがつかない） */
const SAFETY_CODES: ReadonlySet<string> = new Set([
  "UNCHECKED_AUTO_SEND", "PARTIALLY_UNCHECKED", "REVISION_EXHAUSTED_AUTO_SEND",
  "SENSITIVE_CASE", "DUPLICATE_OF_SENT", "BANNED_WORD", "NG_PROPERTY_MENTION",
  "GATE_PAIR_CONFLICT",
  // ※ REPEATED_SENTENCE は 2026-09-21 に style へ移した（「言い方を変えて」＝文体の話）。
  //   DUPLICATE_OF_SENT（同じ本文をもう一度送ろうとしている）は safety のまま＝二重送信の歯止め。
]);

/**
 * その指摘が何の指摘か。
 * ⚠ 知らない code は **fact**（＝出す）。分類を書き忘れた物を黙って捨てないため。
 */
export function classifyIssueScope(code: string | null | undefined): IssueScope {
  const c = (code ?? "").trim();
  if (!c) return "fact";
  if (SAFETY_CODES.has(c)) return "safety";
  if (STYLE_CODES.has(c)) return "style";
  return "fact";
}

/** 分類に必要な2つだけ見る（他の項目はそのまま通す＝呼び出し側の型を壊さない） */
export type ScopedIssue = { code?: string | null; severity?: string | null };

/**
 * スタッフに見せる指摘と、数えるだけの指摘に分ける。
 *
 * 竹内 2026-09-21「ファイナルチェックはハルシネーションが起きた文をお客さんに送るということを
 *   事前に防ぐ部分」→ 見せるのは fact と safety だけ。style は数えるだけ。
 */
export function splitFinalCheckIssues<T extends ScopedIssue>(issues: readonly T[]): { shown: T[]; styleOnly: T[] } {
  const shown: T[] = [], styleOnly: T[] = [];
  for (const i of issues ?? []) {
    if (classifyIssueScope(i.code as string | null) === "style") styleOnly.push(i);
    else shown.push(i);
  }
  return { shown, styleOnly };
}

/** 文体の指摘が block になっていたら作り直しが走ってしまう。style は必ず block から外す */
export function hasBlockingIssue(issues: readonly ScopedIssue[]): boolean {
  return (issues ?? []).some((i) => i.severity === "block" && classifyIssueScope(i.code as string | null) !== "style");
}

// ── 2026-10-02 竹内「文体だけの指摘とは文に間違いがないことかな？それなら大丈夫」 ──
//   warning だけの回の書き直し（Sonnet の revision＋Haiku の recheck）は、指摘が「文に間違いの無い文体」だけなら走らせない。
//   style（上の STYLE_CODES）を全部ではなく、**間違いを含まない物だけ**に絞った一覧（各 code の定義文と実データの例を読んで決めた）:
//     入れる  … 開口語・締め・言い回しの数・骨格・共感の言い方・復唱の有無（どれも「どう書くか」の好み。事実・文法・主語・頼まれていない中身の誤りではない）
//     入れない … 文法の誤り（DOUBLE_KEIGO 二重敬語・SELF_HONORIFIC 自敬）
//               事実・主語のずれ（OPENING_GREETING_UNEXPECTED 遅れていないのに遅れの謝罪・INTRO_REPEAT 既にやり取りのある人に自己紹介・
//                 AWAIT_CONTACT_MISPLACED 次に動くのはこちらなのに連絡待ち・PROMISE_ECHO_MISMATCH 未履行を完了形・VOCAB_MIRROR_MISMATCH お客様の言っていない語・
//                 GOCHOUGO_* 日程の聞き直し／主語の逆転・UKETAMAWARI_OBJECT_UNANCHORED／CONFIRM_* 確認の目的語・主語）
//               頼まれていない中身（CLOSING_FORWARD_PUSH・CONSIDER_PUSH・URGENCY_NO_INTENT・APPLY_PUSH_NO_INTENT・UNPROMPTED_PROPOSAL・
//                 PREEMPTIVE_HEDGE・HEDGE_WITHOUT_SEARCH_DECL・SELF_HEDGE_ECHO・RESULT_EXCUSE・WIDEN_EXCUSE_REDUNDANT・CONDITION_RELAX_UNASKED）・
//               決まりの禁止（NEGATIVE_APOLOGY）・お客様の気持ちの代弁（SYMPATHY_ECHO＝気持ちを決めつける）
//   ⚠ 新しい style の code はここに入れない限り書き直しが走る（＝今までどおり）。知らない物は省かない
const STYLE_NO_ERROR_CODES: ReadonlySet<string> = new Set([
  // 開口語・挨拶の選び方
  "OPENER_MISMATCH", "OPENER_UNUSUAL", "OPENING_GREETING_MISMATCH", "THANK_OPENING", "NAME_BEFORE_OPENING",
  "FILLER_GREETING", "GRATITUDE_OPENING", "CONDITION_OPENING",
  // 締めの選び方
  "CLOSER_MISSING", "EMPTY_CLOSER", "PASSIVE_CLOSER", "NANISOTSU_MISPLACED", "HUMBLE_WAIT", "COMMIT_AFTER_DELIVERABLE",
  // 言い回しの数・並べ方
  "EXCLAMATION_OVERUSE", "SASETE_OVERUSE", "NAME_OVERUSE", "LIST_STRUCTURE", "SPLIT_ACK_REPLY", "REPEATED_SENTENCE",
  // 骨格・必須要素（観測専用）
  "REPLY_SKELETON_MISSING", "PAIR_ELEMENT_MISSING", "CELL_AVOID_CONFLICT", "WE_DO_MISSING", "WE_DO_MISSING_DET", "PASSIVE_ONLY", "GENERIC_ONLY_REPLY",
  // 共感・復唱の言い方
  "FEELING_TEMPLATE", "CONDITION_ECHO_MISSING", "ECHO_CONFIRM", "PROMISE_ECHO_MISSING",
]);

/** 文に間違いの無い文体の指摘か（書き直しを走らせなくてよい物）。STYLE_CODES の部分集合 */
export function isStyleNoErrorCode(code: string | null | undefined): boolean {
  const c = (code ?? "").trim();
  return STYLE_NO_ERROR_CODES.has(c) && STYLE_CODES.has(c);
}

/** 書き直しに渡す指摘が全部「文に間違いの無い文体」か（空なら false＝判断しない） */
export function isStyleOnlyNoError(issues: readonly ScopedIssue[]): boolean {
  const list = issues ?? [];
  return list.length > 0 && list.every((i) => isStyleNoErrorCode(i.code as string | null));
}

/** テスト用: 一覧（STYLE_CODES の部分集合であることを確かめる） */
export function styleNoErrorCodesForTest(): { list: string[]; notInStyle: string[] } {
  const list = [...STYLE_NO_ERROR_CODES];
  return { list, notInStyle: list.filter((c) => !STYLE_CODES.has(c)) };
}
