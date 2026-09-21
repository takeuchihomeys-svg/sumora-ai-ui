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
  "property_send",                            // 物件ピックアップした（実送信 45.7% / 668件）
  "property_send_new_arrival",                // 新着物件（25.2% / 135件）
  "property_send_widen",                      // 条件を広げて再検索（42.6% / 47件）
  "estimate_sheet",                           // 見積書送る（10.4% / 327件）
  "property_check_result",                    // 物件確認した（31.8% / 22件）
  "property_check_result_available",          //   └ 空室あり（37.1% / 62件）
  "property_check_result_unavailable",        //   └ 申込あり（33.3% / 15件）
  "property_check_result_alternative",        //   └ 別のお部屋（同じ性質・母数10件未満）
  "zenryoku_support",                         // 全力サポート（65.2% / 23件）
  // ⚠ 2026-09-21 実測で外した（scripts/audit-waited-when.ts・直近120日・実送信1,881件）:
  //   property_recommendation  559件中 **1件（0.2%）** — 物件を探した結果でも、この経路では書いていない
  //   acknowledge_check         13件中 **0件（0.0%）** — 「確認します」と言う通そのもので、まだ結果が無い
  //   property_search / phone_followup — 実測が1件も無い（推測で入れていた）。未知は消す側に倒す方針に戻す
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

// ─────────────────────────────────────────────────────────────
// 「許す」だけでは足りなかった（2026-09-21・その1）
//
// 竹内「お待たせ致しましたが下書きに残る経路を塞ぐ」→ 経路別に測ったら**逆だった**。
//   scripts/audit-waited-leak.ts（直近60日・下書きと実送信が揃う1,860件）:
//     場面ごとの「実送信に有り」対「AI が書く」
//       property_check_result_unavailable  46.7% 対  0.0%  → **+46.7pt AI が書けていない**
//       property_check_result              31.8% 対  9.1%  → +22.7pt
//       estimate_sheet                     27.5% 対 15.5%  → +12.0pt
//       property_send                      50.3% 対 47.5%  → +2.8pt（合っている）
//       property_send_new_arrival          38.3% 対 37.4%  → +0.9pt（合っている）
//     直近14日は 残13 / 消11 / **足34** ＝ スタッフが手で足す方が3倍多い。
//   ＝ 禁止語が漏れているのではなく、**許す場面で AI が書いていない**のが実害だった。
//
// 直す形: 消す／消さない だけでなく、**その場面の実測の率を材料として渡す**
//   （設計知見「率の表を渡してモデルに選ばせる」「必須にしてよいのは過半数が守っている形だけ」）。
//   50%前後なので「必ず書け」とは言わない。率を見せて選ばせる。
// ─────────────────────────────────────────────────────────────

/**
 * その場面の実送信で冒頭に「お待たせ致しました」が入っている率（%）。
 * scripts/audit-waited-when.ts ③（直近120日・実送信1,881件）— 下書きの有無で絞らない全実送信。
 * ⚠ 旧値は audit-waited-leak.ts（60日・下書きと実送信が揃う通だけ）で、母数が2〜5倍小さかった。
 *   大きく動いたのは estimate_sheet 27.5% → **10.4%**（142件 → 327件）。
 */
export const WAITED_SENT_RATE: Record<string, number> = {
  zenryoku_support: 65.2,                    // 23件
  property_send: 45.7,                       // 668件
  property_send_widen: 42.6,                 // 47件
  property_check_result_available: 37.1,     // 62件
  property_check_result_unavailable: 33.3,   // 15件
  property_check_result: 31.8,               // 22件
  property_send_new_arrival: 25.2,           // 135件
  estimate_sheet: 10.4,                      // 327件
  // ↓ 消す側（isWaitedAllowed が false）。線が動いていないことを確かめるために残す
  viewing_invite: 1.1,                       // 88件
  property_recommendation: 0.2,              // 559件
  acknowledge_check: 0.0,                    // 13件
  meeting_place: 0.0,                        // 53件
};
/** 率の母数が少ない場面では何も言わない */
const WAITED_MIN_SAMPLE_ACTIONS: ReadonlySet<string> = new Set(Object.keys(WAITED_SENT_RATE));

/** 材料に出す下限（%）。これ未満の場面は触れない */
export const WAITED_NOTE_MIN_PCT = 10;

/** その場面の実送信の率（%）。許さない場面・実測が無い場面は null */
export function waitedSentRate(action: string | null | undefined): number | null {
  const a = (action ?? "").trim();
  if (!a || !isWaitedAllowed(a)) return null;
  const key = WAITED_MIN_SAMPLE_ACTIONS.has(a) ? a : [...WAITED_MIN_SAMPLE_ACTIONS].find((k) => a.startsWith(`${k}_`));
  if (!key) return null;
  const rate = WAITED_SENT_RATE[key];
  return rate === undefined || rate < WAITED_NOTE_MIN_PCT ? null : rate;
}

/**
 * その場面の「お待たせ致しました」の材料。許さない場面・実測が無い場面は空文字。
 *
 * ⚠ 「必ず書け」とは言わない（一番高い場面でも65.2%）。率を見せて選ばせる。
 *
 * ⚠ 2026-09-21 追記: 最初は「時間が空いている／約束していたなら置いてよい」と条件を添えていたが、
 *   scripts/audit-waited-when.ts で実送信1,881件を測ったら**どの条件でも分かれなかった**:
 *     直前のお客様の発言から 〜15分 28.6% ／ 1〜2時間 40.0% ／ 1日〜 19.7%（時間では分かれない）
 *     「確認します」と約束していた 28.2% 対 していない 22.9%（約束でも分かれない）
 *     本日すでに挨拶済み 45.6% 対 まだ 45.7%（property_send・挨拶の有無でも分かれない）
 *   分かれるのは**場面だけ**（property_send 45.7% 対 property_recommendation 0.2%）。
 *   ＝ AIX で届ける通は、何分前に返していようと「待たせた作業の結果」なので時間は関係ない。
 *   実測が支えない条件を書くと、それ自体が創作の指示になる（設計知見「データにない文を作らない」）ので消した。
 */
export function buildWaitedNote(action: string | null | undefined): string {
  const rate = waitedSentRate(action);
  if (rate === null) return "";
  return `\n\n【最後に確認：お待たせ致しました】この場面の実送信では`
    + `**${rate}%** が「お待たせ致しました！！」で書き出している`
    + `（待たせた作業の結果を届ける場面なので事実として正しい）。`
    + `この通が「探した・作った・確認した結果を届ける通」なら冒頭1行に置いてよい。`;
}

// ─────────────────────────────────────────────────────────────
// 「率を材料として渡す」だけでも足りなかった（2026-09-21・その2）
//
// 上の buildWaitedNote を userPrompt の最後に置いて YUMA で本番経路を叩いたら **0/2**。
// 理由は率ではなく、**同じ事実を3か所から違う向きで渡していた**こと:
//   ① system の全AIX共通ルール（greetingTimeNote）に「『お待たせ致しました』は禁止語」
//   ② 挨拶行の実値が「①「〇〇さんお世話になっております！！」で始める」と**1つに固定**
//   ③ userPrompt の最後に「45.7% が書いている」
//   → ①②は骨格（構成①・JSON の intro）なので③は勝てない。
//     設計知見「同じ事実について『書くな』と『書け』を別の場所から渡さない」そのものだった。
//
// 直す形: 挨拶行の実値を**2択にして率を添える**（どちらを選ぶかは生成側＝ブレインの判断に任せる）。
//   竹内さん 2026-09-21「一択と指摘するんじゃなくて実際の成約データから学習して、
//   場面でいれるかどうかはブレインに判断させる」と同じ形（opener-rates.judgeOpener の兄弟）。
//   実送信が半々（45.7%）＝ スタッフ自身がどちらも書いている場面なので、1つに決める方が誤り。
// ─────────────────────────────────────────────────────────────

/** 冒頭にあるか（途中に出る「お待たせ」は挨拶ではない）。scripts/audit-waited-when.ts と同じ形 */
export const WAITED_HEAD_RE = /^[^\n]{0,20}お待たせ(?:致|いた)?しました/;

/**
 * その会話で**前回のこちらの送信**が「お待たせ致しました」で始まっていたか。
 * 履歴にこちらの送信が無ければ null。
 *
 * ⚠ 2026-09-21 実測（scripts/audit-waited-when.ts ②''・1,125組）:
 *     前回「お待たせ」だった後 → 今回も **55.8%**（391件）
 *     前回そうでなかった後     → 今回は **22.6%**（734件）
 *   ＝ **繰り返しを避けるのではなく、その会話の癖として続く**。
 *   時間・約束・挨拶済みでは分かれなかったのに、これだけが分かれた唯一の軸。
 *
 * @param ourRecentTexts こちらの送信本文（古い順）。最後の1件だけ見る
 */
export function waitedUsedLastTime(ourRecentTexts: ReadonlyArray<string>): boolean | null {
  for (let i = ourRecentTexts.length - 1; i >= 0; i--) {
    const t = (ourRecentTexts[i] ?? "").trim();
    if (!t || /^\[(?:画像|動画|スタンプ|ファイル)\]$/.test(t)) continue;
    return WAITED_HEAD_RE.test(t);
  }
  return null;
}

/** 前回使っていた時／いなかった時に、次も使う率（%）。上の実測 */
export const WAITED_AFTER_USED_PCT = 55.8;
export const WAITED_AFTER_UNUSED_PCT = 22.6;

/**
 * 挨拶行の実値の代わりに渡す「2択」。許さない場面・実測が無い場面は空文字（呼び出し側は従来の固定値）。
 *
 * ⚠ 2択を率だけで渡したら YUMA で **3/3（100%）** になった（実送信 45.7%）。
 *   設計知見「中間を言葉で指定しても中間には落ちない → 条件で分ける」。
 *   分かれる軸は実測で1つだけ見つかった（その会話の前回の書き出し）ので、それを添えて寄せる。
 *
 * @param action      AIX の種類
 * @param basePhrase  その場面で従来使っていた挨拶（例「お世話になっております！！」）。空なら本日挨拶済み
 * @param prevUsed    その会話の前回のこちらの送信が「お待たせ」だったか（waitedUsedLastTime）。不明なら null
 */
export function buildWaitedOpeningChoice(
  action: string | null | undefined,
  basePhrase: string,
  prevUsed: boolean | null = null,
): string {
  const rate = waitedSentRate(action);
  if (rate === null) return "";
  const base = (basePhrase ?? "").trim();
  const other = 100 - rate;
  // 本日すでに挨拶済み（basePhrase が空）でも率は変わらなかった（45.6% 対 45.7%）ので、
  // その時は「お待たせ致しました」と「名前行から本題」の2択にする
  const altLabel = base ? `「[お客様名]${base}」` : `挨拶行を書かず名前行または本題から始める`;
  // ⚠ 2026-09-21 YUMA: 最初「今回も前者でよい」と書いたら 0/5 になった（「〜でよい」は許可であって指示ではない）。
  //   後者側の「基本は後者」だけが指示として効き、両方とも後者に倒れていた。向きを揃える。
  const lean = prevUsed === true
    ? `\nこの会話は**前回のこちらの送信も「お待たせ致しました」で書き出している**（実送信でも前回使った次に使うのが **${WAITED_AFTER_USED_PCT}%**）。`
      + `書き出しの流れを合わせるので、**今回も前者で書き出す**。`
    : prevUsed === false
      ? `\nこの会話では**前回のこちらの送信は「お待たせ致しました」を使っていない**。`
        + `実送信では前回使っていない次に使うのは **${WAITED_AFTER_UNUSED_PCT}%** だけなので、**基本は後者**を選ぶ。`
        + `今回が特に長く待たせた作業の結果（物件を探し直した・管理会社の回答が返ってきた 等）の時だけ前者。`
      : "";
  return `①「[お客様名]お待たせ致しました！！」（この場面の実送信 **${rate.toFixed(1)}%**）`
    + `か ${altLabel}（${other.toFixed(1)}%）の**どちらかを選んで**始める。`
    + `探した物件・作った見積書・管理会社に確認した結果など、`
    + `**こちらが作業した結果を届ける通なら前者**（お客様は結果を待っているので事実として正しい）。`
    + `そうでなければ後者。両方を重ねて書かない。${lean}`;
}
