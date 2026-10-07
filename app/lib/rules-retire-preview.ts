// app/lib/rules-retire-preview.ts
// 学習ルールを無効にする前に「返信生成から外れたら一致が下がらないか」を過去の番で測るための試し（純関数・依存なし）。
//
// 2026-10-07 5巡目（竹内さん「大丈夫」）: スタッフの定型（初期費用も最大限割引・周辺全域・ご満足…全力でサポート）と
//   食い違う学習ルール 6本（f6e3cd53・ac177394・744f95e0・f4410208・886ac923・3f36ddb5）を ai_prompt_rules で無効にし、
//   b2d7bf7f の「『〇〇周辺全域から』といった自作のエリア表現も使わない」の一文を外す（10/01「全域にする」と食い違う）。
//   本番の無効化（SQL）は竹内さんが流す。ここは generate-reply の testFlags.rules_retire=on（テストの会話だけ）で、
//   DB を変えずに「無効にした後のルールの文字列」を作る（再生 scripts/yuma-r3-replay.ts --drafts=A:rules_retire=off,B:rules_retire=on）。
//   SQL を流した後はこの試しは何もしない（該当の行が文字列に無い）。

/** 無効にするルールの本文の頭（ai_prompt_rules.rule_text の先頭 24 字。id は報告の SQL と同じ） */
export const RETIRE_RULE_HEADS: ReadonlyArray<{ id: string; key: string; head: string }> = [
  { id: "f6e3cd53-64a8-4827-8b9a-738d7e421eab", key: "WEEKLY-hearing-1788750051770-4", head: "お客様が記載したエリア表現（駅名・地域名・範囲指定）はそのまま使う" },
  { id: "ac177394-52b5-4dc0-9631-995e55324fa2", key: "FEEDBACK-0d9ce6d5-4818-43fb-a24f-5e308611618e-1", head: "「〇〇さんにご満足頂けるお部屋が見つかるまで全力でサポート" },
  { id: "744f95e0-260a-4cc0-8cd7-214b17bc5fec", key: "DIFF-POLICY-FULL-a907bf03-9731-4cdc-b78c-ba7edb9999dc", head: "hearing段階の初期返信で「初期費用を最大限割引」などのコスト優遇" },
  { id: "f4410208-35ba-4e87-8a64-f0708f6f443f", key: "WEEKLY-hearing-1784516504548-6", head: "条件ヒアリング後のピックアップ宣言文末に「初期費用も最大限割引" },
  { id: "886ac923-3e6e-44ae-9a29-c8fa2eafc7ac", key: "FEEDBACK-1feeef80-a1ba-4d67-80d4-deabc813a3b6-1", head: "金額・費用の値引きに関する断定的な約束表現" },
  { id: "3f36ddb5-128d-4a9f-ad77-2f31cc9014d7", key: "FEEDBACK-532ed681-c549-431a-94c2-63739bf72be4-1", head: "「初期費用も最大限割引させて頂き引越し費用を抑えます」といった" },
];

/** b2d7bf7f から外す一文（10/01「全域にする」と食い違う） */
export const B2D7_SENTENCE = "「〇〇周辺全域から」といった自作のエリア表現も使わない。";

/** ルールの注入文字列から、無効にするルールの行を除き b2d7bf7f の一文を外す（無効にした後の姿） */
export function previewRetiredRules(rulesText: string): { text: string; dropped: number; edited: number } {
  let dropped = 0, edited = 0;
  const lines = String(rulesText ?? "").split("\n").filter((l) => {
    const body = l.replace(/^・(?:【線引き】)?/, "");
    if (RETIRE_RULE_HEADS.some((r) => body.startsWith(r.head))) { dropped++; return false; }
    return true;
  }).map((l) => {
    if (!l.includes(B2D7_SENTENCE)) return l;
    edited++;
    return l.replace(B2D7_SENTENCE, "");
  });
  return { text: lines.join("\n"), dropped, edited };
}

/** 無効にするルールの rule_key（fetchPromptRules の exclude.keys に渡すと、空いた枠に入る次のルールまで本番と同じになる） */
export const RETIRE_RULE_KEYS: readonly string[] = RETIRE_RULE_HEADS.map((r) => r.key);
