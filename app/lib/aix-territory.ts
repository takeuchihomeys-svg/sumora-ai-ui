// app/lib/aix-territory.ts
// AIX が送る物＝通常返信の本文に書かせない物（AIX_ACTION_REPLY_DIRECTION[*].forbid を機械で読める形にした物）。
//
// 2026-09-20 竹内「AIX から返信する部分は AIX からスタッフが送るから大丈夫／②や⑤の部分等は AIX から」
//   「他にも会話の部分でちゃんと AIX の機能も把握したうえで調査する」
//
// ■ なぜ要るか（YUMA で再現した事）
//   セル（VI_POSITIVE）から「ご都合よろしいお日にち御座いますでしょうか」を外したのに、YUMA の生成で再発した。
//   出所はセルではなく**ブレインの戦略文**だった:
//     winning_pattern  「直近の複数内覧候補日時を提示し、当日確定後は物件名・号室・待ち合わせ場所・住所を復唱して…」
//     closing_strategy 「内覧希望を頂いたので直近の複数候補日時を提示し、内覧完了から申込への流れをつくらせて頂きます。」
//   generate-reply はこれを「両者を統合した1アクションを WE DO 宣言で返信末尾に1文含めること」として渡す。
//   同じブレインの note は「内覧候補日時の提示はこのボタン専用（候補日時の手打ち・AI生成は禁止）」と正しく言っている。
//   ＝ **同じ事実について「書くな」と「書け」を別の場所から渡していた**（設計知見が最も危険とする形）。
//
// ■ 直し方の方針
//   禁止を別の場所に足すと三つ目の指示になる。**戦略を渡すその行に添える**ことで矛盾を解消する。
//   本文を書き換える出口は作らない（実送信に正当な用例があるため。例:「ご都合よろしいお日にち」は実送信48通）。
//   ここがやるのは「LLM に渡す戦略文に、その戦略が AIX の担当であることを併記する」だけ。
//
// 四者同名: 生成（generate-reply の brainGuidanceNote）・監査（scripts/audit-aix-territory.ts）・
//   テスト（__tests__/aix-territory.test.ts）が同じ AIX_TERRITORY を見る。
import { AIX_BUTTON_LABELS, AIX_ACTION_REPLY_DIRECTION } from "./aix-taxonomy";

export type AixTerritoryLine = {
  /** どの AIX の担当か（AIX_ACTION_REPLY_DIRECTION のキー） */
  aix: string;
  /** 何が担当か（人が読む言葉） */
  what: string;
  /** 戦略文・セルの文言に当てる線 */
  re: RegExp;
};

/**
 * AIX ごとの「通常返信の本文に書かせない物」。
 * ⚠ 足す時の条件: AIX_ACTION_REPLY_DIRECTION[aix].forbid に**実際に書いてある物**だけを機械化する。
 *   ここで新しい禁止を発明しない（禁止の出所を1つにするため）。
 */
export const AIX_TERRITORY: AixTerritoryLine[] = [
  { aix: "viewing_invite", what: "日程を聞く疑問形（候補日時の確認）",
    re: /ご都合[^\n]{0,12}(?:お日にち|日程|日時)[^\n]{0,12}(?:御座|ござ)いますでしょうか|(?:お日にち|日程|候補日)[^\n]{0,10}(?:お聞かせ|教えて)(?:頂|いただ)け/ },
  { aix: "viewing_invite", what: "具体的な候補日時・2択日程の提示",
    // 「候補日時をそのまま送る」「複数枠を並列提示」のような next_steps の言い回しも拾う（動詞を広めに取る）
    re: /(?:複数)?(?:の)?(?:内覧)?候補日時[^\n]{0,10}(?:提示|お送り|送付|送る|提案|並べ)|(?:複数)?枠[^\n]{0,6}(?:並列)?提示|\d{1,2}月\d{1,2}日[^\n]{0,8}\d{1,2}時|[月火水木金土日]曜(?:日)?[^\n]{0,6}\d{1,2}時/ },
  { aix: "meeting_place", what: "住所・集合場所・集合時間の記載",
    re: /(?:集合場所|待ち合わせ場所)[^\n]{0,10}(?:・|、|と)?(?:住所)?[^\n]{0,10}(?:を)?(?:復唱|記載|お伝え|送|案内)|集合(?:場所|時間)[^\n]{0,6}(?:を)?(?:復唱|明記)/ },
  { aix: "estimate_sheet", what: "金額・内訳・割引額の生成／総額の断言",
    re: /(?:具体的な)?(?:割引額|還元額|報酬額)[^\n]{0,8}(?:を)?(?:提示|明示|お伝え|記載)|総額[^\n]{0,6}(?:を)?(?:断言|確定|お伝え)/ },
  { aix: "cost_breakdown", what: "初期費用の内訳項目の説明",
    re: /(?:敷金|礼金|保証料|火災保険|鍵交換|日割(?:り)?家賃)[^\n]{0,10}(?:の)?(?:内訳|内容)[^\n]{0,8}(?:を)?(?:説明|ご説明)/ },
  { aix: "phone_call", what: "電話番号の記載・折り返しの時刻約束",
    re: /こちらから(?:お)?電話(?:させて|致し|します|する)|\d{1,2}時[^\n]{0,6}(?:に)?(?:お)?電話(?:させて|致し|します|する)/ },
  { aix: "guarantor_info", what: "保証会社名の記載・審査通過の断言・並行審査の提案",
    re: /並行(?:して)?審査|審査[^\n]{0,8}(?:必ず|確実に)[^\n]{0,8}(?:通[りるら]|通過)/ },
  { aix: "application_push", what: "必要書類リストの生成",
    re: /(?:必要)?書類[^\n]{0,8}(?:の)?(?:リスト|一覧)[^\n]{0,8}(?:を)?(?:提示|送|案内|生成)|(?:身分証|住民票|収入証明|印鑑証明)[^\n]{0,16}(?:ご用意|お願い|提出)/ },
  { aix: "application_push", what: "希少性の煽り",
    re: /埋まって(?:しまい|しまう)|残り\s*[0-9０-９]\s*(?:部屋|室)|お早めに(?:お申込|ご決断)/ },
  { aix: "condition_hearing", what: "条件フォーム本体（①〜⑧）の生成",
    re: /(?:条件)?(?:ヒアリング)?フォーム[^\n]{0,8}(?:の)?(?:全文|本文|中身)[^\n]{0,8}(?:を)?(?:生成|記載)|①[^\n]{0,20}②[^\n]{0,20}③/ },
];

/** 文の中に AIX の担当が含まれていれば、その担当を返す（重複は AIX×what で1つにまとめる） */
export function detectAixTerritory(text: string | null | undefined): Array<{ aix: string; what: string }> {
  if (!text) return [];
  const out: Array<{ aix: string; what: string }> = [];
  const seen = new Set<string>();
  for (const t of AIX_TERRITORY) {
    if (!t.re.test(text)) continue;
    const key = `${t.aix}|${t.what}`;
    if (seen.has(key)) continue;
    seen.add(key);
    out.push({ aix: t.aix, what: t.what });
  }
  return out;
}

/**
 * ブレインの戦略文（winning_pattern / closing_strategy / next_steps）に AIX の担当が混ざっている時、
 * **その戦略を渡すのと同じ行に添える**注記を作る。何も混ざっていなければ空文字。
 *
 * 「別の場所から禁止を渡さない」ための関数なので、呼び出し側は戦略の行の直後にこれを置く。
 */
export function buildAixTerritoryGuard(texts: Array<string | null | undefined>): string {
  const seen = new Set<string>();
  const hits: Array<{ aix: string; what: string }> = [];
  for (const t of texts) {
    for (const h of detectAixTerritory(t)) {
      const key = `${h.aix}|${h.what}`;
      if (seen.has(key)) continue;
      seen.add(key);
      hits.push(h);
    }
  }
  if (hits.length === 0) return "";
  const byAix = new Map<string, string[]>();
  for (const h of hits) {
    if (!byAix.has(h.aix)) byAix.set(h.aix, []);
    byAix.get(h.aix)!.push(h.what);
  }
  const parts = [...byAix.entries()].map(([aix, whats]) => {
    const label = AIX_BUTTON_LABELS[aix] ?? aix;
    const forbid = AIX_ACTION_REPLY_DIRECTION[aix]?.forbid ?? "";
    return `AIX【${label}】が送る物（${whats.join("・")}）${forbid ? `／このAIXの禁止: ${forbid}` : ""}`;
  });
  return `  → ⛔ 上の戦略には**スタッフが AIX から送る物**が含まれている: ${parts.join(" ／ ")}。`
    + `これらは AIX のボタンでスタッフが送るので、今回の本文には書かない（戦略はそこへ繋ぐ受付・宣言までにとどめる）。`;
}
