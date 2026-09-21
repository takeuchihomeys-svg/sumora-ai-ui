// app/lib/negative-context.ts
// 「否決・募集終了の報告があったか」を事実だけで判定する（純関数・DB 依存なし）。
//
// 2026-09-21 竹内「なんでここでお申込頂きありがとうございますと意味のわからない文が生成されるのか。
//   これ状況を読み取れていないから、ブレインのどこかに弱い部分があるのでその部分を見つけて強化する必要がある。
//   今の状況把握して文をつくる部分。」
//
// ■ 実物（ギガ賃貸・2026-09-21 16:55）
//   こちら「こちらお部屋の詳細となります！！／お気に召されましたらご都合よろしいお日にちにご案内させて頂きます！！」
//   お客様「ありがとうございます🙇 検討します」
//   AI   「はい！！／**お申込みいただきありがとうございます😊**／お部屋お気に召されましたらお申込みでお部屋押さえさせて頂きます！！」
//   ＝ 申込は1件も入っていないのに申込へのお礼。実送信 **0通 / 6,816通**（スタッフは一度も使わない形）。
//
// ■ 出所を追った結果（設計知見「おかしな文を1通見つけたら」の②）
//   手本（ai_reply_examples）にお礼形 **0件** ／ ナレッジ（11,207件）にも **0件** ＝ 写したのではない。
//   ブレインもセル（ES_THINKING）も turnPair も**正しく「検討中」と読んでいた**:
//     brainReplyDirection: 感謝と検討表明を受け止め、検討を見守る姿勢で締める
//     turnPair: staff=estimate_send / customer=thinking / ruleId=ES_THINKING
//     closer: wait_softly（検討中→ごゆっくり＋扉。急かし禁止）
//   なのに **TPO だけが「ネガ文脈（否決・募集終了報告への短い了承）」** になり、
//   本文の指示（effectiveReplyDirection）を丸ごと乗っ取っていた:
//     「否決・募集終了報告への短い了承に対する受け止め…3行目に次の一手を1文」
//   ＝ 「区切り」の指示と「見積書送付済み」の材料が混ざって、LLM が申込へのお礼を作った。
//
// ■ 何が弱かったか（generate-reply/route.ts の旧コード）
//     const brainCorroborates = brainFresh && stance==="wait" && customer_intent==="negative";
//     return (aixSaysUnavailable || staffSaysNeg || brainCorroborates) ? { kind: "staff_report" } : none;
//   **コメントには「ブレイン由来は補助証拠のみ」と書いてあるのに `||` で単独で確定していた**。
//   ＝ スタッフが否決を1文字も書いていなくても、ブレインが「待ち」かつ「懸念あり」と言えばネガ文脈になる。
//   しかも「検討します」に対して stance=wait は**正しい**判断なので、ブレインが正しく働くほど誤発動する。
//
// ■ 実測（scripts/audit-negative-context.ts・直近120日・材料が残る963件）
//   ネガ文脈になった通は 3件（withdrawal 2 / staff_report 1）。
//   staff_report の1件が**この誤判定**で、直前のスタッフ送信に否決・募集終了の語は無く、
//   お客様は「検討します」＝前向き、**スタッフは100%直した**。
//   ブレイン単独で正しく立った例は **0件** ＝ 外しても失う物が無い。
//
// ■ 決めた線
//   ネガ文脈は「**こちらが否決・募集終了を報告した事実**」だけで立てる（ブレインの推測では立てない）。
//   ブレインの stance / customer_intent は**補助**にとどめ、単独の根拠にしない。

/** こちらが否決・募集終了を報告した形（結果報告に限定・事前の確認宣言や仮定は除く） */
export const STAFF_NEG_RESULT_RE = /否決|不承認|募集終了(?:でした|となって|しており|していました|とのこと|です)|埋まって(?:しまい|おり|いました|しまって)|満室(?:でした|となって|とのこと)|先約|他の方で決まり|申込が入って(?:しまい|おり)|審査.{0,8}(?:通らな|通りません|落ち|NG|見送り|承認が(?:下り|おり)ません|難しい)(?:かった|でした|ました|となり|とのこと|になり|と)/;

/** 事前の確認宣言・仮定・安心材料の説明（結果報告ではない） */
export const STAFF_HYPOTHETICAL_RE = /確認(?:し|いた|させ)|場合|たら|もし|ご安心|ほとんど/;

/** 同時に代替を提案している＝ネガの締めではない（お客様はその提案への感謝を返している） */
export const STAFF_ALTERNATIVE_RE = /https?:\/\/|代わり|かわり|こちら(?:は|も|など)?(?:いかが|おすすめ|オススメ)|ピックアップ|ご紹介|おすすめ|オススメ/;

/** AIX の履歴が「募集終了」で終わっている（brain-core の「最新:<aix_type>(...)(結果:<check_pattern>)」） */
export const AIX_UNAVAILABLE_RE = /最新:property_check_result[^\s→]*結果:unavailable/;

export type NegativeReportInput = {
  /** 直近のこちらの送信本文 */
  staffText: string;
  /** AIX の履歴の文字列（無ければ null） */
  aixHistory?: string | null;
  /** 直近のこちらの送信からの経過ミリ秒（不明なら null＝古さで落とさない） */
  staffAgeMs?: number | null;
  /** ブレインの見立て（**補助のみ**。単独では立てない） */
  brain?: { fresh: boolean; stance?: string | null; customerIntent?: string | null } | null;
};

export type NegativeReportVerdict = {
  /** 否決・募集終了の報告があったか */
  yes: boolean;
  /** 何を根拠にしたか（監査・ログ用） */
  basis: "aix_unavailable" | "staff_text" | null;
  /** 立たなかった理由（監査用） */
  reason: string | null;
  /** ブレインも同じ見立てか（補助。単独では yes にしない） */
  brainAgrees: boolean;
};

/** 72時間より前のこちらの発言は固着させない（route.ts の旧実装と同じ線） */
export const STAFF_REPORT_MAX_AGE_MS = 72 * 60 * 60 * 1000;

/**
 * 「こちらが否決・募集終了を報告した」か。
 *
 * ⚠ ブレインの見立て（stance=wait かつ customer_intent=negative）は **yes の根拠にしない**。
 *   「検討します」に対して stance=wait は正しい判断なので、ブレインが正しく働くほど誤発動していた
 *   （実測: ブレイン単独で立った1件は誤り・正しく立った例は0件）。
 *   brainAgrees は返すが、呼ぶ側も単独では使わないこと。
 */
export function resolveNegativeReport(input: NegativeReportInput): NegativeReportVerdict {
  const staffText = input.staffText ?? "";
  const brainAgrees = !!(
    input.brain?.fresh &&
    input.brain.stance === "wait" &&
    input.brain.customerIntent === "negative"
  );

  // AIX の履歴が「募集終了」なら、こちらが報告した事実として確定してよい
  if (AIX_UNAVAILABLE_RE.test(input.aixHistory ?? "")) {
    return { yes: true, basis: "aix_unavailable", reason: null, brainAgrees };
  }
  if (input.staffAgeMs !== null && input.staffAgeMs !== undefined && input.staffAgeMs > STAFF_REPORT_MAX_AGE_MS) {
    return { yes: false, basis: null, reason: "こちらの発言が72時間より前", brainAgrees };
  }
  // 同時に代替を提案しているならネガの締めではない
  if (STAFF_ALTERNATIVE_RE.test(staffText)) {
    return { yes: false, basis: null, reason: "同時に代替を提案している", brainAgrees };
  }
  // 事前の確認宣言・仮定は結果報告ではない
  if (STAFF_HYPOTHETICAL_RE.test(staffText)) {
    return { yes: false, basis: null, reason: "結果報告ではない（確認宣言・仮定）", brainAgrees };
  }
  if (STAFF_NEG_RESULT_RE.test(staffText)) {
    return { yes: true, basis: "staff_text", reason: null, brainAgrees };
  }
  return {
    yes: false,
    basis: null,
    // ここが今回の直しの肝。ブレインが「待ち＋懸念」でも、報告の事実が無ければ立てない
    reason: brainAgrees ? "ブレインは待ち＋懸念だが、否決・募集終了の報告が無い" : "否決・募集終了の報告が無い",
    brainAgrees,
  };
}
