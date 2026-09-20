// app/lib/waited-scope.ts
// 「お待たせ致しました」をどの場面で許すか（純関数・四者同名の単一真実源）。
//
// 2026-09-20 竹内「AIX で送ったあとの AIX テンプレートの文の質を上げる」→ 差分を測ったら、
//   この語は**場面によって正誤が正反対**だった。竹内さんの判断は「結果を届ける AIX では許す」。
//
// ■ 実測（scripts/audit-omatase-aix.ts・直近60日・生成文と実送信が両方ある1,805件）
//   経路ごとに「生成に出た時スタッフがどうしたか」:
//     物件ピックアップ            残66 / 消6  / 足6
//     新着物件                    残39 / 消1  / 足3
//     見積書送る                  残21 / 消0  / **足16**
//     物件確認した（空室あり）    残22 / 消3  / 足6
//     物件確認した（申込あり）    残0  / 消0  / **足7**
//     条件を広げて再検索          残17 / 消1  / 足2
//     ───────────────────────────────────
//     内覧日調整                  残1  / **消14** / 足0
//     通常返信（line_reply）      残0  / **消5**  / 足1
//   実送信にも 291通/4,195通（6.9%）あり、そのうち**手打ちが58通**。
//
// ■ なぜ分かれるのか
//   「お待たせ致しました」は**待たせた作業の結果を届ける**時に事実として正しい
//   （物件を探した・見積書を作った・管理会社に確認した＝お客様は待っていた）。
//   内覧日の調整や通常返信では待たせていないので不要。
//   memory feedback_no_omatase「返信で一切使わない（自動返信化のため）」は**通常返信**について
//   実測どおり（消5・足1）で、禁止の範囲が結果報告の AIX まで広がっていたのが食い違いの原因。
//
// ■ 使う側
//   ・aix-template-generate: 許す場面では stripWaited をかけない
//   ・aix/action（AIX 本体）: 許さない場面（内覧日調整）にだけ stripWaited をかける
//   ・generate-reply / greeting.enforceOpening: 通常返信なので従来どおり全部消す（ここは触らない）

/**
 * 「お待たせ致しました」を許す AIX（＝待たせた作業の結果を届ける場面）。
 * ⚠ 足す時は必ず実測を根拠にする（その AIX でスタッフが「残した＋足した」が「消した」を上回るか）。
 */
export const WAITED_ALLOWED_ACTIONS: ReadonlySet<string> = new Set([
  "property_send",                            // 物件ピックアップした（残66/消6/足6）
  "property_send_new_arrival",                // 新着物件（残39/消1/足3）
  "property_send_widen",                      // 条件を広げて再検索（残17/消1/足2）
  "property_recommendation",                  // 物件オススメ（物件を探した結果を届ける・同じ性質）
  "property_search",                          // 物件を探す（同上）
  "estimate_sheet",                           // 見積書送る（残21/消0/足16 ＝ 足すのが最多）
  "property_check_result",                    // 物件確認した（管理会社への確認の結果）
  "property_check_result_available",          //   └ 空室あり（残22/消3/足6）
  "property_check_result_unavailable",        //   └ 申込あり（残0/消0/足7）
  "property_check_result_alternative",        //   └ 別のお部屋（同じ性質）
  "acknowledge_check",                        // 確認します → その結果を届ける場面
  "phone_followup",                           // 電話終了後のまとめ（話した結果を届ける）
  "zenryoku_support",                         // 全力サポート（残7/消1/足0）
]);

/**
 * 「お待たせ致しました」を消さない場面か。
 * 未知の action は **false（消す）** に倒す（新しい AIX が黙って禁止語を通さないように）。
 */
export function isWaitedAllowed(action: string | null | undefined): boolean {
  const a = (action ?? "").trim();
  if (!a) return false;
  if (WAITED_ALLOWED_ACTIONS.has(a)) return true;
  // 画面のサブパターン（property_check_result_mgmt_move_in 等）は接頭辞で拾う
  for (const k of WAITED_ALLOWED_ACTIONS) {
    if (a.startsWith(`${k}_`)) return true;
  }
  return false;
}
