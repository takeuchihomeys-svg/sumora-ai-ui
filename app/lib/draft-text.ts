// app/lib/draft-text.ts
// 保存されている下書き（conversations.ai_draft）を「お客様に送る文」に直す（純関数・DB 依存なし）。
//
// 2026-09-18 竹内「これ文の生成とかは返信の下書き通りになるよね、今までのセットされている」の確認中に見つけた穴:
//   画面（page.tsx）は ai_draft を stripInternalTagsOrNull で内部タグを外してから入力欄に出しているのに、
//   自動返信は**生の ai_draft** を送ろうとしていた。つまり
//     ・内部タグ（<<<STOP_REASON:…>>> 等）が入った下書きは、自動返信では送られない（安全側だが黙って止まる）
//     ・もし止め忘れれば、画面に出ていない社内向けの文字がお客様に飛ぶ
//   → 画面と自動返信が**同じ関数**を使う（設計知見「同じ判定は同じ関数・四者同名」）。
//
// これを通した文は、**スタッフが入力欄で見ている文とまったく同じ**になる。
import { stripMetaNarration, isNotACustomerReply, stripMarkdownEmphasis } from "./meta-narration";

/** 本文として使えない印（社内用の合図）。これが本文全体なら送る物は無い */
const DRAFT_SENTINELS: ReadonlySet<string> = new Set(["[AIX誘導中]", "__SHOWN__", "[画像のみ]"]);
/** 生成に失敗した時の画面向けの置き文（お客様への文ではない） */
const FAILURE_PLACEHOLDER_RE = /^[（(]AI返信の生成に失敗/;

/**
 * 下書きから内部メタタグ（スタッフ向けの社内指示）を外す。
 * 顧客向けの返信文に絶対に混ぜてはいけない物だけを落とす。
 */
export function stripInternalTags(text: string): string {
  let t = text
    // 2026-09-20 竹内「他にも文生成の問題起きないか徹底的にテスト」:
    //   旧実装は閉じタグ（>>>）を**必須**にしていたため、生成のストリームが途中で切れたトレーラーが
    //   剥がれずに本文へ残っていた。実物（下書き5件・最新 9/18）:
    //     「…確認出来次第ご連絡させて頂きます😌！！ <<<FINAL_CHECK:{"ok":true,"issu」＝JSON が途中で終わっている。
    //   閉じタグが無ければ**末尾まで**落とす。またタグ名を並べるのをやめて <<<大文字:…> の形で1本化し、
    //   これから増える内部タグも自動で落ちるようにする（実送信365日 12,031通に「<<<」「>>>」は**0通**＝誤削除0）。
    .replace(/\n?<<<[A-Z_]{3,}:[\s\S]*?(?:>>>|$)/g, "")
    // 2026-09-20: スタッフ向けの注記を AI が本文の先頭に書き写すことがある（プロンプトの見出しを写す型）。
    //   実物「【⚠️センシティブ案件: この返信案は参考のみ。送信前に必ず手動確認（キャンセル・リスケ検知）】」
    //   注記の行だけ落として本文は残す（実送信に「⚠」は**0通**＝誤削除0。物件名の【…】には ⚠ が無いので当たらない）
    .replace(/(^|\n)[ \t]*【[^】\n]{0,6}⚠[^】\n]{0,80}】[ \t]*/g, "$1")
    .trim();
  // AI が返信全体を「」で囲んで出力することがある → 先頭「末尾」のペアのみ除去
  if (t.startsWith("「") && t.endsWith("」")) t = t.slice(1, -1).trim();
  // 2026-09-18 竹内: Markdown の強調記号は LINE では記号のまま出る（中の文字は残す）
  t = stripMarkdownEmphasis(t);
  // 2026-09-15 竹内「こんなの絶対にいれない」: AI の作業メモは入力欄の入口でも落とす
  t = stripMetaNarration(t).text;
  return t;
}

/**
 * DB から読んだ ai_draft を「送れる本文」に直す。送る物が無ければ null。
 * 画面の入力欄に出す文と、自動返信で送る文は、必ずこの関数を通した物にする。
 */
export function draftToSendableText(text: string | null | undefined): string | null {
  if (!text) return null;
  const raw = text.trim();
  if (DRAFT_SENTINELS.has(raw)) return null;
  if (FAILURE_PLACEHOLDER_RE.test(raw)) return null;
  // 2026-09-18 竹内「社内への確認みたいな文は絶対に送らない・テキストボックスにも入らないように」:
  //   文全体が「返信そのもの／この会話そのもの」について述べている＝お客様への返信ではない。
  //   一部を削るのではなく**丸ごと使わない**（削ると残りが意味を成さず、かえって危ない）
  if (isNotACustomerReply(raw)) return null;
  const out = stripInternalTags(raw);
  if (!out) return null;
  // 整形した後に社内向けの文だけが残った場合も使わない（先頭だけ削れて後ろが残る形を塞ぐ）
  if (isNotACustomerReply(out)) return null;
  return out;
}
