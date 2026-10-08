// app/lib/brain-keyword-rules.ts — 学習した語のルール（trigger_action_rules の keyword_rule）をブレインで使う時の線（純関数）
//
// 2026-09-27 竹内さん「重い順から治す」の1番目（YUMA の徹底テストで見つかった・穴:G5）:
//   ブレイン（LLM）が「AIX なし」と判断しても、brain-core の信号5.5／信号8（学習した語のルール）が
//   「ます😊」「しました」「も見て」のような意味の無い語で AIX を出していた（b34eb51a・85894e05・671d868f）。
//   決まり: AIX の要否はブレインだけが判断する（memory feedback_brain_owns_aix）。
//   直し（2つ）:
//     ① ブレインがはっきり「なし」と言った時（parsed.aix が null・空・"null"・"なし"）は、語のルール（信号5.5・信号8）で上書きしない
//        → isExplicitNoAix。語でない信号（沈黙・画像・URL 等）は今回は変えていない（件数は scripts/audit-brain-keyword-rules.ts）
//     ② 語尾・絵文字・助詞で始まる断片・定型の敬語の断片・申込フォームの断片はルールから外す → isMeaninglessRuleKeyword
//        読む側（brain-core）で外し、学習する側（learn-trigger-rules）は作らない・次の実行で消す
//   本番（9/5〜・YUMA を除く）: 語のルールの出どころの判断（signal:property_send 17件）はスタッフが押した AIX と一致0・15件は AIX を押していない
//
// ※ 画面から import しない（サーバーの brain-core・学習の route・scripts から使う）が、依存は無い純関数だけ。

/** ブレイン（LLM）の aix の生の値が「AIX なし」をはっきり言っているか（null・空・"null"・"none"・"なし"）。
 *  知らない語（正規化できない文字列）は「なし」とは言っていない＝ false（従来どおり信号で補ってよい） */
export function isExplicitNoAix(rawAix: unknown): boolean {
  if (rawAix === null || rawAix === undefined) return true;
  if (typeof rawAix !== "string") return false;
  const s = rawAix.trim().toLowerCase();
  return s === "" || s === "null" || s === "none" || s === "なし" || s === "無し" || s === "不要" || s === "aixなし";
}

// ── 意味の無い語 ───────────────────────────────────────────────────────────────

/** 絵文字・異体字セレクタ・結合子（語から剥がして残りで判断する） */
const PICTO_RE = /[\p{Extended_Pictographic}\u{FE0F}\u{200D}\u{1F3FB}-\u{1F3FF}]/gu;

/** ひらがなだけの語でも中身がある語（これを含む時は外さない）。
 *  2026-09-27 に keyword_rule 1,705件のひらがなだけの語（conf≥0.65 で 155件）を目で読んで残した物＋同じ種類の語 */
const HIRAGANA_CONTENT_WORDS = [
  "いくら", "くらで", "くらです", // 費用（「いくらですか」の断片）
  "おすすめ", "こだわり", "だわり",
  "まだあり", "あいて", "あいてる", "いつから", "いつごろ", "いつまで", "どこで", "どれがいい", "まだですか", "なんかない",
  "みにいき", "いきたい", "だめ", // 内覧（見に行きたい）・結果（だめでした）— 迷う語は残す側に倒す
  "なんば", "うめだ", "てんま",
  "にします", "きめます", "きめた",
] as const;

/** 定型の敬語・挨拶（この中の切れ端だけの語は意味が無い）。「した宜」「知致し」「訳ござ」「数お掛けし」等の n-gram の出所 */
const POLITE_PHRASES = [
  "承知致しました宜しくお願い致します", "承知しました宜しくお願いします", "かしこまりました",
  "お世話になります", "お世話になりました", "申し訳ございません", "大変お手数お掛けします",
  "させて頂きます", "失礼します", "ありがとうございます",
] as const;

/** 学習した語のルールの語が意味の無い物なら、その理由（無ければ null）。
 *  理由: 絵文字 ／ 語尾・助詞（ひらがなだけの断片） ／ 助詞で始まる断片 ／ 定型の敬語の断片 ／ フォームの断片 ／ 短すぎる */
export function meaninglessRuleKeywordReason(keyword: string | null | undefined): string | null {
  const raw = String(keyword ?? "").trim();
  if (!raw) return "空";
  const hasPicto = PICTO_RE.test(raw);
  PICTO_RE.lastIndex = 0;
  const k = raw.replace(PICTO_RE, "").replace(/[\s　。、,.!?！？~〜ー]+$/u, "").trim();
  if (hasPicto) {
    // 絵文字を剥がした残りが短い・残りも意味が無い → 絵文字の語（「ます😊」「す😊」「うか💦」「います😊」）
    if ([...k].length < 3 || meaninglessRuleKeywordReason(k) !== null) return "語尾・絵文字";
  }
  if ([...k].length < 2) return "短すぎる";
  // 申込・条件のフォームの断片（「⇒万まで③」「区⑥ご希望」「住所〒住」）— learn-trigger-rules の isGarbageTriggerRule と同じ考え
  if (/[⇒①-⑳〒]/u.test(k)) return "フォームの断片";
  // ひらがなだけ（語尾・助詞・助動詞の切れ端: 「しました」「ていま」「ですか」「ございませ」）
  if (/^[ぁ-ゖー]+$/u.test(k)) {
    if (HIRAGANA_CONTENT_WORDS.some((w) => k.includes(w))) return null;
    return "語尾・助詞";
  }
  // 助詞で始まる「漢字1文字＋かな1文字まで」の断片（「も見て」「が見つ」「を探し」）。
  //   「も見たい」（他の間取りも見たい・PR 1.0/10）のように言い切った形・「の空き」（空き）は残す
  if (/^[もをにがはでとの][一-鿿々][ぁ-ゖ]?$/u.test(k) && !/空/.test(k)) return "助詞で始まる断片";
  // 定型の敬語・挨拶の切れ端（「て頂きます」「知致しまし」「した宜」「訳ござい」「話になりま」）
  if (POLITE_PHRASES.some((p) => p.includes(k))) return "定型の敬語の断片";
  return null;
}

export function isMeaninglessRuleKeyword(keyword: string | null | undefined): boolean {
  return meaninglessRuleKeywordReason(keyword) !== null;
}

// ── 語のルールの当て方（brain-core の信号5.5・信号8 と同じ計算） ─────────────────────────

export type KeywordRule = { action_type: string; keyword: string; confidence: number | null; occurrence_count: number | null };

/** 信号5.5（竹内さんの回答から作った高い確信のルール: conf 0.95〜1・occurrence ≥10）。最初に当たった語の action（rules は並べ替え済み） */
export function humanKeywordRuleHit(custText: string, rules: ReadonlyArray<KeywordRule>): KeywordRule | null {
  if (!custText) return null;
  return rules.find(
    (r) =>
      (r.confidence ?? 0) >= 0.95 && (r.confidence ?? 0) <= 1 &&
      (r.occurrence_count ?? 0) >= 10 &&
      custText.includes(r.keyword),
  ) ?? null;
}

/** 信号8（学習した語の足し算）: 当たった語の confidence をアクションごとに足し、0.85 以上の最上位。当たった語も返す */
export function summedKeywordRuleHit(
  custText: string,
  rules: ReadonlyArray<KeywordRule>,
): { action: string; score: number; keywords: string[] } | null {
  if (!custText) return null;
  const scores: Record<string, number> = {};
  const hits: Record<string, string[]> = {};
  for (const r of rules) {
    if (!custText.includes(r.keyword)) continue;
    scores[r.action_type] = (scores[r.action_type] ?? 0) + Math.min(r.confidence ?? 0, 1);
    (hits[r.action_type] ??= []).push(r.keyword);
  }
  const top = Object.entries(scores)
    .filter(([, score]) => score >= 0.85)
    .sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))[0];
  return top ? { action: top[0], score: top[1], keywords: hits[top[0]] ?? [] } : null;
}

// ── ブレインの「AIX なし」を語・状態の信号で上書きしない（2026-10-08）────────────────────────
// 竹内さん（10/08）「旧ルールで、文の単語だけで変に判断してしまってボトルネックになっているのがあるはずやから、ちゃんとブレインを基盤に読み取るようにする」。
//   9/27 は語のルール（信号5.5・8）だけを止め、語でない信号（費用の語→見積書・申込の語→申込へ・内覧の語・TikTok・画像だけ・URL・沈黙 3日 等の
//   detectSignalBasedAixFallback の残り）と場面の信号（S5 日時の語→待ち合わせ）は残していた。
//   本番の全期間（brain-aix-eval の matched・scripts/audit-word-vs-brain.ts の③）:
//     ブレインが AIX なし → 信号が AIX を立てた番（signal:property_recommendation 22・property_search 22・property_send 20・followup_revive 10・
//       application_push 8・estimate_sheet 7・acknowledge_check 6・その他 2）97番で、スタッフが同じ AIX を押したのは 3番・AIX を押さなかったのは 84番。
//     場面の信号 S5（日時の語→待ち合わせ）10番は 0番一致・10番とも AIX なし（「14:30-15:00くらいに掛けても大丈夫でしょうか」＝電話の時刻・
//       「今コンビニ行ったので…投函」「13時に変更…13時半で大丈夫です」＝確定済みの時刻の変更）。
//     比べ: ブレインが AIX なしのまま（信号も立てない）番は 844番中 607番（72%）一致。
//   実物: 「他社で決まりました」→物件オススメ／「検討してみます」→物件ピックアップ／「本日電話いけますか」→物件検索／
//         「家賃をいくらまでにしたら…出てきますか」→見積書送る／広告の URL（temu）→確認します。
//   → ブレインがはっきり「なし」と言った時は、これらの信号の AIX を採らない（AIX要対応・グループの通知・やることの元にしない）。
//   残す物（竹内さんの決定で「ブレインが AIX なしの時に入れる」と決めた場面の信号）: S2（特定のお部屋の入居日の質問→物件確認した 9/14）・
//     S3（審査・管理会社の名前の質問→物件確認した 9/30）・S11。約束（promise:*）・未履行のピックアップ（signal:pending_pickup）・締めの後の待ち・
//     内覧当日の待ち 等の状態の規則は別の所（この関数は通らない）。
//   ブレインが判断していない時（夜の見送り・失敗）は brain-core が走らないのでここは関係しない（決定論の確かな物だけが残る）。
//   戻す: BRAIN_NULL_SIGNAL_FALLBACK=on（旧: 信号で AIX を立てる）
export type SignalOverNullSource = { kind: "signal"; action: string } | { kind: "scene"; scene: string | null | undefined };
/** ブレインが「AIX なし」の時に、この信号の AIX を採るか（true=採る＝旧の動き） */
export function adoptSignalAixOverBrainNull(
  explicitNoAix: boolean,
  src: SignalOverNullSource,
  env: Record<string, string | undefined> = process.env,
): boolean {
  if (!explicitNoAix) return true; // ブレインが分からない語を返した（「なし」とは言っていない）→ 従来どおり信号で補う
  if ((env.BRAIN_NULL_SIGNAL_FALLBACK ?? "").toLowerCase() === "on") return true;
  if (src.kind === "signal") return false;
  // 場面の信号: 竹内さんの決定で入れている S2・S3・S11 は残す。S5（日時の語→待ち合わせ）は内覧の流れの段階（9/30）とぶつかる＋本番 0/10 → 採らない
  return !/^S5/.test(String(src.scene ?? ""));
}
