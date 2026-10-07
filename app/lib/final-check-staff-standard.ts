// app/lib/final-check-staff-standard.ts
// 最終チェック（rule_check）が「直しても直らない」RULE_VIOLATION の2つの型を外す（純関数・依存なし）。
//
// 2026-10-07 竹内「最終チェックはちゃんと機能しているか」（見張りの「最終チェックの段ごとの指摘（28日）」で
//   返信 条件提示の RULE_VIOLATION 9→9・AIX property_send の RULE_VIOLATION 6→6 が修正前→最後で減らない）。
//   監査 scripts/audit-final-check-persist.ts（28日・YUMA 除く 146番）で実物を全部読んだ:
//
// ① スタッフの定型の文を禁じる学習ルール（入口で外す）
//   条件提示の 8件はスタッフが 8件とも下書きの通り（または同じ形で）送っていた。指摘の中身（conversations.ai_draft_check の message）は
//     「初期費用割引フレーズが条件フォーム未提出の初回返信で使用されています」（f4410208・744f95e0・212cafe4）
//     「『ご満足頂くお部屋が見つかるまで全力でサポート』は不安を口にしている場面以外では使用禁止」（ac177394・全場面）
//     「顧客が指定していない『周辺全域から』を勝手に追加している」（f6e3cd53）
//   ＝ai_prompt_rules の学習ルールが、スタッフの初回返信の定型と食い違っていた。実送信（120日・初回の名乗りの文 170通）:
//     条件フォームの⑦初期費用に記入あり 75通 → 「初期費用も最大限割引」43（57%）・「全域」54（72%）・「ご満足…全力でサポート」29
//     記入なし 94通 → 割引 16（17%）・全域 30・ご満足 26
//   「全域」は 10/01 竹内さんの決定「全域にする」で後処理（condition-echo-polish）が足している＝ルールの方が古い。
//   これらは事実の誤りではなく文体（文に間違いの無い言い回し）。最終チェックは事実・境界の誤りを見る所なので、
//   この3つの言い回しを禁じる学習ルールは**最終チェックの [RULES] にだけ**渡さない（返信生成に渡すルールは変えない）。
//
// ② 本文に無い要素を「言及がない」と言う RULE_VIOLATION（出口で外す）
//   「Brain指示には『11月末入居』と明記されているが、実返信に入居時期の言及がない」「（『本日中に』が欠落）」
//   「Brain判定で必須とされた条件：…駐車場ありの条件」「修正後ドラフト全文に初期費用割引に関する記述がない」の 5件は、
//   どれも引用が本文に無い（＝書き直しの入口 passableWarnIssues に入らない・no_passable）のに画面に「△」で残り、
//   スタッフは 5件とも足さずに送っていた。rule_check の仕事は「ルールに反する文」を引用で示す事で、
//   「足りない要素」はブレインの判断との照合（文脈の段 context_check の MISSED_QUESTION 等）の仕事。
//   → rule_check の RULE_VIOLATION で、引用が本文に無く「言及がない／欠落／記述がない／Brain判定で必須」の形の物だけ外す。
//   引用が本文にある RULE_VIOLATION・他の code・他の段（FABRICATED_PROPERTY の本文に無い引用＝1LDKS→1LDK の写し違い等）は外さない。
//
// 戻す: FINAL_CHECK_STAFF_STANDARD=off（①②とも）

export function staffStandardFilterEnabled(): boolean {
  return (process.env.FINAL_CHECK_STAFF_STANDARD ?? "").toLowerCase() !== "off";
}

/** スタッフの初回返信の定型（実送信で使われている言い回し） */
const STANDARD_PHRASES: Array<{ id: string; re: RegExp }> = [
  { id: "discount_closing", re: /初期費用(?:も|を)?最大限割引/ },
  { id: "zeniki", re: /全域/ },
  { id: "manzoku_support", re: /ご満足/ },
];
/** その言い回しを禁じる・使わせない形 */
const BAN_RE = /(禁止|使わない|使用しない|追加しない|付けない|入れない|先出しして?はいけない|してはいけない|自発的に入れる|勝手に)/;
/** 定型の言い回しを「書け」と言う形（禁じていない）は外さない */
const ENCOURAGE_ONLY_RE = /で締め|を必ず/;

/** 学習ルール1行がスタッフの定型の言い回しを禁じているか（最終チェックに渡さない物）。永久ルール・【線引き】は呼ぶ側で外さない */
export function bansStaffStandardPhrase(rule: string): string | null {
  const t = String(rule ?? "");
  if (!BAN_RE.test(t)) return null;
  for (const p of STANDARD_PHRASES) {
    if (!p.re.test(t)) continue;
    // 「全域」の語を含んでも、エリアの推測・絞り込み（事実の創作）を禁じる中身のあるルール（b2d7bf7f）は外さない
    if (p.id === "zeniki" && /推測|絞り込/.test(t)) continue;
    // 「ご満足…の一文で締め」等、定型を勧めるだけのルールは外さない（禁止の語が別の要素に掛かっている）
    const around = t.slice(Math.max(0, t.search(p.re) - 10), t.search(p.re) + 60);
    if (ENCOURAGE_ONLY_RE.test(around) && !BAN_RE.test(around)) continue;
    return p.id;
  }
  return null;
}

/** 引用が本文に無い「言及がない／欠落」型の言い方 */
const MISSING_CLAIM_RE = /(言及|記述|記載|触れ|明記)(?:が|は|も)?(?:ない|無い|なし|無し|ありません|されていない|していない)|欠落|抜けて|含まれていない|含まれておらず|Brain判定で必須|Brain指示には|Brain判定:/;

/**
 * rule_check の RULE_VIOLATION で、引用（evidence）が本文に無く「足りない要素」を言っている物か（外してよいか）。
 * draftNorm・evidenceNorm は呼ぶ側の normalizeForMatch 済みの文字列（本文に引用があるかの判定を final-check と同じにする）
 */
export function isMissingElementRuleFlag(pass: string, code: string, evidence: string, evidenceInDraft: boolean): boolean {
  if (pass !== "rule_check" || code !== "RULE_VIOLATION") return false;
  if (evidenceInDraft) return false;
  return MISSING_CLAIM_RE.test(String(evidence ?? ""));
}

// ─────────────────────────────────────────────────────────────
// ③ 最後の Claude の確かめ（10/07・Haiku の rule_check）で残った2つの誤発火（出口で外す）
// ─────────────────────────────────────────────────────────────
// (a) 「受け身表現」: 前置きの規則（「〇〇さんご希望のご条件に合った〜」）には「スタッフが能動的に探す行動宣言の一部なら対象外」と書いてあるのに、
//     「YUMAさんにオススメできるお部屋をピックアップして」「YUMAさんがご満足頂くお部屋が見つかるまで全力でサポート」に付けた（7場面中5場面）。
//     実送信（120日・初回の名乗りの文 170通）でスタッフはこの形を使っている（さんにオススメ 18/105・ご満足…全力でサポート 55/170）。
//     → 指摘の文が「受け身」で、引用が行動宣言（ピックアップ・お送り・全力でサポート）を含む RULE_VIOLATION は外す。
// (b) 初期費用の割引の一文: 永久ルール（12924481）は「⑦初期費用の限度額が②家賃の3倍以内または20万円以内／お客様が費用を抑えたいと言った」時は使ってよい。
//     Haiku は⑦の記入（「10万位」「やすくしてください」「出来ればなし」）があっても「条件を満たさない」と言った（4場面中3場面）。
//     → お客様の文で決定論に判定し、使ってよい時の「割引の一文」への RULE_VIOLATION は外す（使ってはいけない時＝⑦が家賃の3倍かつ20万円を超える・記入も費用の言及も無い時は残す）。
const ACTIVE_DECL_RE = /ピックアップ|お送り|全力でサポート|お探し/;
export function isPassiveMisfire(pass: string, code: string, message: string, evidence: string): boolean {
  if (pass !== "rule_check" || code !== "RULE_VIOLATION") return false;
  if (!/受け身/.test(String(message ?? ""))) return false;
  return ACTIVE_DECL_RE.test(String(evidence ?? ""));
}

const DISCOUNT_PHRASE_RE = /初期費用(?:も|を)?最大限割引/;
const COST_WORD_RE = /費用|安く|やすく|抑え|おさえ|安い|お得|節約/;
const manOf = (s: string): number | null => {
  const t = s.normalize("NFKC").replace(/,/g, "");
  const m = t.match(/(\d+(?:\.\d+)?)\s*万/);
  if (m) return Number(m[1]);
  const y = t.match(/(\d{5,7})\s*円?/);
  return y ? Number(y[1]) / 10000 : null;
};
/** 永久ルール 12924481 の判定（お客様の文から）。true＝割引の一文を使ってよい */
export function discountPhraseAllowed(customerText: string): boolean {
  // NFKC は ⑦ を 7 に変えるので全体には掛けない（値ごとに掛ける）
  const t = String(customerText ?? "");
  // ⑦の行の値（「⑦【初期費用の限度額】⇒10万位」の ⇒ の後ろ・⇒ が無ければ【】の後ろ）
  const line7 = (t.match(/⑦[^\n⑧]*/)?.[0] ?? "");
  const parts = line7.split(/⇒|→|：|:/);
  const sevenVal = (parts.length > 1 ? parts.slice(1).join("") : line7.replace(/^⑦\s*(?:【[^】]*】)?/, "")).trim();
  const two = t.match(/②[^\n③]*/)?.[0] ?? "";
  const rentNums = [...two.normalize("NFKC").matchAll(/(\d+(?:\.\d+)?)\s*(?:万)?/g)].map((m) => Number(m[1])).filter((n) => n > 0 && n < 100);
  const rentMax = rentNums.length ? Math.max(...rentNums) : null;
  const limit = sevenVal ? manOf(sevenVal) : null;
  if (limit != null) return limit <= 20 || (rentMax != null && limit <= rentMax * 3);
  if (sevenVal && !/^(?:特に|とくに)?(?:なし|無し|ない|未定|-|ー)?$/.test(sevenVal.replace(/\s/g, ""))) return true; // 「やすくしてください」「出来ればなし」等の記入
  if (sevenVal && COST_WORD_RE.test(sevenVal)) return true;
  // ⑦の記入が無い時は、お客様の文のどこかで費用に触れていれば可（フォームの項目名「初期費用の限度額」は数えない）
  return COST_WORD_RE.test(t.replace(/初期費用の限度額/g, "").replace(/⑦[^\n]*/g, ""));
}
export function isAllowedDiscountMisfire(pass: string, code: string, evidence: string, customerText: string): boolean {
  if (pass !== "rule_check" || code !== "RULE_VIOLATION") return false;
  if (!DISCOUNT_PHRASE_RE.test(String(evidence ?? ""))) return false;
  return discountPhraseAllowed(customerText);
}
