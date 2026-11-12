// app/lib/brain-prompt-rules-1112.ts — ブレインの指示文（AIX_CAPABILITY_MAP・REPLY_STYLE_RULES）の古い決まり3つを、竹内さんの今の決定に合わせて差し替える（純関数・文字列だけ）
//
// 2026-11-12 作業員19（統括役「根C」・brain-rules-facts.ts と同じやり方＝答えの指示を事実の材料に・既定 off＝今と1文字も変わらない）
//   ① 見積書の後の申込誘導: 「支払い意思つき金額質問は申込誘導を必ず添える」は、同じ指示文の「見積書の後は申込へ進めない」と食い違う。
//        竹内さんの実送信（60日・見積書送る 153回）: 見積書の後 5分以内に内覧のご案内 46%・申込の語 25%（feedback_estimate_not_apply・申込へ 10%）。申込の意思を言葉にした番は返信で受けて入居希望日を聞く（apply-intent-reply-first・KB 2385202c）
//   ② 「最も効果実績が高いボタン（most_effective 最多）」: 推定込みの成約勝率は成約データでも効果でもない→止めた（KB 5e006794・退役）。指示文に根拠として残っていた
//   ③ 「全然大丈夫です」: 要望を言い直して謝った時は『全然大丈夫です』にせず、送ってくれた事に感謝して受け入れる（KB 317c7a7c P1 10/20）
// 入れる: BRAIN_PROMPT_RULES_1112=on。差し替えは「元の文が一字一句そのままある時だけ」（見つからなければ何もしない＝壊れない側）

export function promptRules1112Enabled(env: Record<string, string | undefined> = typeof process !== "undefined" ? process.env : {}): boolean {
  return (env.BRAIN_PROMPT_RULES_1112 ?? "").trim().toLowerCase() === "on";
}

export type PromptRuleEdit = { id: string; from: string; to: string };

export const PROMPT_RULE_EDITS_1112: PromptRuleEdit[] = [
  {
    id: "most_effective",
    from: "申込到達会話で最も効果実績が高いボタン（applying_pattern の most_effective 最多）。",
    to: "物件が会話にある番で、物件の初期費用・見積の質問・依頼に押すボタン（竹内さんの実送信・60日で見積書送る 153回）。費用の語だけでは選ばず、質問の中身（物件の初期費用か・見積の依頼か・持ち込みか）で分ける。",
  },
  {
    id: "estimate_then_apply",
    from: "返信には「お気に召されましたらお申込みでお部屋お抑えします」の申込誘導を必ず添える",
    to: "返信は金額の質問への答え（御見積書）を先に受ける。見積書の後の締めは内覧のご案内が中心で、申込誘導は必須にしない（実送信は見積書の後に内覧のご案内46%・申込の語25%）。お客様が申込の意思を言葉にした番は返信で受けて入居希望日を聞く（申込フォーマットは後の番）",
  },
  {
    id: "zenzen_daijoubu",
    from: "- 「全然大丈夫です」→ 使ってOK。顧客が「すみません」「申し訳ない」等と恐縮している場合に使う",
    to: "- 「全然大丈夫です」→ お客様が要望を言い直して・足して謝った時（「何度もすみません、〇〇で考えてて」）は使わない。要望を送ってくれた事に感謝して受け入れ、「ご満足頂けるお部屋が見つかるのが一番」の姿勢を示す（竹内さん 10/20）。それ以外の恐縮でも共感フレーズは足さず行動宣言へ",
  },
];

/** 指示文の一部を差し替える。off の時は text をそのまま返す。元の文が無い編集は黙って飛ばす */
export function applyPromptRules1112(text: string, env: Record<string, string | undefined> = typeof process !== "undefined" ? process.env : {}): string {
  if (!promptRules1112Enabled(env)) return text;
  let out = text;
  for (const e of PROMPT_RULE_EDITS_1112) if (out.includes(e.from)) out = out.replace(e.from, () => e.to);
  return out;
}

// ── 2026-11-12 作業員19（統括役の追加）: reply_mode の「判断に迷う時は必ず aix」を P0 の問いに ──
//   旧: 「線引きルール該当時・金額/契約/入居日/内覧日程の確定に関わる時・判断に迷う時は必ずaix。雑談や単純な質問への一般返信のみauto_reply」
//   P0 ca55d42b: スタッフだけが知る情報（管理会社に確認して分かった事・募集状況・交渉の結果・撮影した写真・見積の金額・内覧日の確定）は AIX。返信は AI が知り得る材料だけで書ける番で、スタッフの文と100%一致できる対象（目標100%）。
//   「迷ったら aix」は、書ける番まで AIX に倒す向き（P0 と逆）。迷いの原因は材料が届いていない／場面の読み違い／返信か AIX かの判断の誤り（P0 の外れの見方）なので、問いに戻って決める。
//   残す物: 線引きルール該当時は aix（コード側の reply_mode のフェイルクローズ・自動送信の関所は変えない）。
// 入れる: BRAIN_REPLY_MODE_P0=on（既定 off＝今と1文字も変わらない）。コード側（brain-core の replyMode の強制）は変えていない＝この変更は LLM の出力の向きだけ
export function replyModeP0Enabled(env: Record<string, string | undefined> = typeof process !== "undefined" ? process.env : {}): boolean {
  return (env.BRAIN_REPLY_MODE_P0 ?? "").trim().toLowerCase() === "on";
}

export const REPLY_MODE_P0_EDITS: PromptRuleEdit[] = [
  {
    id: "reply_mode_p0",
    from: "線引きルール該当時・金額/契約/入居日/内覧日程の確定に関わる時・判断に迷う時は必ずaix。雑談や単純な質問への一般返信のみauto_reply",
    to: "返信か AIX かは「お客様の発言に答えるのに、スタッフだけが知る情報（管理会社に確認して分かる事・募集状況・交渉の結果・見積の金額・内覧日の確定）が要るか」で決める。要らない（会話・資料・会社の事実・物件の記録だけで答えられる）番は auto_reply、要る番と線引きルール該当時は aix（手元に無い間は約束の返信）。迷う時は「迷ったら aix」とせず、材料が届いているか・場面を読み違えていないかに戻って決める",
  },
];

/** reply_mode の指示だけを差し替える。off の時は text をそのまま返す */
export function applyReplyModeP0(text: string, env: Record<string, string | undefined> = typeof process !== "undefined" ? process.env : {}): string {
  if (!replyModeP0Enabled(env)) return text;
  let out = text;
  for (const e of REPLY_MODE_P0_EDITS) if (out.includes(e.from)) out = out.replace(e.from, () => e.to);
  return out;
}
