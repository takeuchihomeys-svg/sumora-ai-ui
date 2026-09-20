// app/lib/example-hygiene.ts
// 2026-09-11 竹内方針1〜5（統合設計 §7 データ衛生）: 「正解例として使えるか」の唯一の判定。
//   generate-reply が例外時に流す失敗文「（AI返信の生成に失敗しました。再生成をお試しください）」を
//   スタッフが無修正で送ると save-reply-example の autoStarred で☆が付き、few-shot・差分学習・評価に「正解」として混入していた
//   （☆付き2行・うち1件は 9/11 に顧客へ LINE 配信済み・失敗文由来の ai_reply_knowledge 11行）。
//   行は削除しない。読む側（few-shot・学習・評価）と書く側（保存・送信）がこのファイルの関数だけで除外する。
//   2026-09-12 竹内方針D: few-shot 注入直前の曜日補正（fixExampleWeekdays）もここ。曜日の判定は jst-date の1関数（後処理の TYPO_WEEKDAY_MISMATCH と同じ）。
//   依存は jst-date（依存ゼロ）だけ。

import { fixDateWeekdays } from "./jst-date";

/** generate-reply/route.ts が例外時にストリームへ流す文言（route 側もこの定数を import する＝文言の出所は1か所） */
export const GENERATION_FAILURE_TEXT = "（AI返信の生成に失敗しました。再生成をお試しください）";
/** 失敗文の検出（括弧・句読点の揺れを許す） */
export const GENERATION_FAILURE_RE = /AI返信の生成に失敗しました|再生成をお試しください/;
/** テスト送信とみられる極端に短い文（「あ」「ああ」「test」）。line_reply に18件・embedding ありで pgvector の検索対象に入っていた */
export const JUNK_SENT_RE = /^[ぁ-んA-Za-z\s]{1,6}$/;
/** PostgREST の .not(col, "like", ...) 用（列が NOT NULL 前提のクエリだけで使う。NULL 列に使うと NULL 行も落ちる） */
export const EXCLUDE_FAILED_SENT_LIKE = "%AI返信の生成に失敗しました%";

/** 失敗文か（送信停止・保存停止の判定） */
export function isGenerationFailureText(s: string | null | undefined): boolean {
  return GENERATION_FAILURE_RE.test(s ?? "");
}

/** 正解例（sent_reply）として使えるか。few-shot・差分学習・評価・常設スクリプトが同じ関数で除外する */
export function isUsableExampleText(s: string | null | undefined): boolean {
  const t = (s ?? "").trim();
  if (!t) return false;
  if (GENERATION_FAILURE_RE.test(t)) return false;
  if (JUNK_SENT_RE.test(t)) return false;
  return true;
}

/**
 * few-shot に注入する実例の「日付（曜）」を、日付を正として直す（DB の行は書き換えない＝注入の直前だけ）。
 *   実データ: sent_reply に曜日の誤りが残った aix_action 3行（☆付き e650e29e「8/1（金）8/2（土）8/3（日）」＝正しくは土・日・月）。
 *   createdAt（その文を書いた時点）が分かる時は、その時点の暦で曜日を付け替える（後処理の TYPO_WEEKDAY_MISMATCH と同じ関数）。
 *   分からない時（pgvector RPC の戻りに created_at が無い）は年を確定できないので、今日基準で食い違う曜日だけを外す（誤った曜日を新たに作らない）。
 */
export function fixExampleWeekdays(text: string, createdAt?: string | null, nowMs: number = Date.now()): string {
  if (!text) return text;
  const t = createdAt ? Date.parse(createdAt) : NaN;
  return Number.isFinite(t) ? fixDateWeekdays(text, t).text : fixDateWeekdays(text, nowMs, "strip").text;
}

/** AI 下書き（ai_draft）として差分学習に使えるか（失敗文の下書きは「AIの誤り」ではない） */
export function isUsableAiDraft(s: string | null | undefined): boolean {
  const t = (s ?? "").trim();
  return !!t && !GENERATION_FAILURE_RE.test(t);
}

// ─── 2026-09-20 竹内「他にも文生成の問題起きないか徹底的にテスト」──────────────────
// AIX【確認します】(acknowledge_check) は **管理会社・オーナー宛て**のメッセージも作る
// （aix/action/route.ts に「【メッセージの宛先】管理会社またはオーナー（お客様宛てではない）」と明記された正しい機能）。
// その出力が手本 ai_reply_examples に入り、`STATE_SEARCH_ALIASES.applying` が "acknowledge_check" を
// 含むため、**申込中のお客様への返信を作る時に管理会社宛ての文が手本として渡っていた**（手本8件・☆付きあり）。
// 実物:「ゆそひさんのご案内をしております！！ プレアール都島Ⅲ103号室の募集状況を確認させていただきます！！
//        あわせて入居可能日についてもご確認をお願いできますでしょうか！！」＝お客様に出したら宛先の取り違え。
//
// 線（scripts/audit-mgmt-phrase-line.ts）: お客様へのLINE 12,031通に **0通**・手本に8件 ＝ 誤削除0。
// 判定は AIX 側のプロンプトが**必須にしている要素**で見分ける（route.ts の「冒頭1行目」と「見積もり依頼」）。
//
// isUsableExampleText とは**別の関数**にしてある。AIX【確認します】自身は
// getStarredExamplesForAction(["acknowledge_check"]) で自分の実例（管理会社宛て）を手本にするので、
// そこでこれを掛けると自分の手本が全部消える。お客様に見せる側の経路だけで使う。
/** 管理会社・オーナー宛ての文の印（AIX【確認します】のプロンプトが必須にしている要素） */
export const TO_MANAGEMENT_RE =
  /のご案内をしております|(?:御)?見積(?:もり|り|書)?もお願い(?:でき|出来)ますでしょうか/;

/** お客様に見せる返信の手本として使えるか（管理会社・オーナー宛ての文を除く） */
export function isCustomerFacingExample(s: string | null | undefined): boolean {
  const t = (s ?? "").trim();
  if (!t) return false;
  return !TO_MANAGEMENT_RE.test(t);
}
