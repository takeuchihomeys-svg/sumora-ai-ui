// ─── 顧客名の妥当性判定（LINE表示名を実名として使わないためのゲート）───────────
// LINEの表示名は「H!tom!.M」「ゆき♡」「taro_123」のように記号・数字・絵文字を含むことが多く、
// これをそのまま「〇〇さん」と呼びかけると実名（Hitomi 等）と食い違い、お客様の信頼を損なう。
// 実名として許容する文字は ひらがな/カタカナ/漢字/英字/長音符/々/空白/中黒 のみ。
// これ以外の文字（記号・数字・絵文字）を1文字でも含む名前は「LINE表示名」とみなして採用しない。
const NAME_ALLOWED_CHARS_RE = /^[ぁ-んゝゞァ-ヴヽヾー々〆一-鿿A-Za-z\s・]+$/;
// 名前ではないプレースホルダー（LINEプロフィール取得失敗時・UIのダミー値）
const NAME_PLACEHOLDERS = new Set([
  "名称未設定", "未設定", "お客様", "名無し", "名無しさん", "ゲスト",
  "guest", "Guest", "unknown", "Unknown", "user", "User", "LINE", "line",
]);
// G30（2026-09-08 Fable5）: プレースホルダ名の派生形（部分一致）。「名無しの権兵衛」「ゲスト01」「未設定」等の派生を
// 完全一致セット（NAME_PLACEHOLDERS）だけでは弾けず、UI の || "名無し" デフォルトが実名として採用されていた。
// isPlausiblePersonName / normalizeCustomerName / final-check が同じ定数を使う（三者同名）
export const PLACEHOLDER_NAME_CORE_RE =
  /名無し|権兵衛|名称未設定|未設定|ゲスト|匿名|テスト|サンプル|ダミー|お客様|お客さま|(?<![A-Za-z])(?:guest|unknown|user|test|sample|dummy|nanashi|line)(?![A-Za-z])/i;
/** 本文中の「プレースホルダ名＋敬称」呼びかけ（final-check 用・block） */
export const PLACEHOLDER_ADDRESS_DET_RE =
  /(?:名無し[^\s、。！!\n]{0,8}|権兵衛|名称未設定|未設定|ゲスト|匿名|テスト|サンプル|ダミー|(?<![A-Za-z])(?:guest|unknown|user|test|sample|dummy))\s*(?:さん|様|さま|サン)/i;

// 名前から非許容文字（記号・絵文字・数字等）を除去して実名として使える形を抽出する
// 例: "SATOKO♪" → "SATOKO"、"ゆき♡" → "ゆき"、"H!tom!.M" → "HtomM"
// isPlausiblePersonName に渡す前の前処理として使う。変換後も判定は isPlausiblePersonName に委ねる。
//
// NFKC 正規化を先に掛ける理由（2026-08 初回対応バグ）:
// LINE表示名には全角英字「ＭＩＫＡ」・半角カナ「ﾕｷ」・装飾数字「𝟑ᩚ𝟐ᩚ𝟕ᩚ.」等が頻出する。
// 正規化なしだとこれらが丸ごと除去され、実名が取れるケースでも空文字になってしまう。
// NFKC で「ＭＩＫＡ→MIKA」「ﾕｷ→ユキ」「𝟑→3」に畳んでから許容文字で絞る。
// ※ 数字は意図的に許容しない（"taro_123"→"taro123" のようなハンドル名を実名として
//    採用してしまい「327さん」等の誤った呼びかけを生むため）。数字混じりは空文字になり、
//    呼びかけごと削除される（enforceCustomerName 側で助詞まで含めて安全に消す）。
export function stripNonNameChars(raw: string): string {
  const normalized = typeof raw.normalize === "function" ? raw.normalize("NFKC") : raw;
  return normalized.replace(/[^ぁ-んゝゞァ-ヴヽヾー々〆一-鿿A-Za-z\s・]/g, "").trim();
}

// 実名として使える形か（true のときのみ「〇〇さん」の呼びかけに使ってよい）
export function isPlausiblePersonName(raw?: string | null): boolean {
  const n = (raw ?? "").trim();
  if (!n) return false;
  if (n.length > 20) return false;
  if (NAME_PLACEHOLDERS.has(n) || PLACEHOLDER_NAME_CORE_RE.test(n)) return false;
  // 1文字は頭文字（イニシャル）の可能性が高いので漢字1文字（「関」さん等）のみ許可
  if (n.length === 1 && !/^[一-鿿々]$/.test(n)) return false;
  if (!NAME_ALLOWED_CHARS_RE.test(n)) return false;
  // 「姓 名」までは許可。区切りが3つ以上ある文字列は名前ではなく文断片とみなす
  const segments = n.split(/[\s・]+/).filter(Boolean);
  return segments.length >= 1 && segments.length <= 3;
}

function escapeRegExp(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

const HONORIFIC_RE_SRC = "(?:さん|サン|様|さま)";

// 呼びかけ「〇〇さん」を削除するとき、直後の助詞まで一緒に消さないと文が壊れる。
// 例: 「初期費用も割引させて頂き𝟑ᩚ𝟐ᩚ𝟕ᩚ.さんのお引越しにかかる費用を…」
//      → 「さん」だけ消すと「…頂きのお引越しにかかる費用を…」になり、
//        文頭で起きると「のお引越しにかかる費用を…」という壊れた返信が送られる（実障害）。
// 名前を正しい実名に置換できる場合は助詞をそのまま残し、削除する場合のみ助詞も落とす。
//
// 対象を「のがにをへ」に限定する理由: 「は」「も」「と」は次の語の1文字目としても頻出し
//（「はじめまして」「もしよろしければ」「とても」）、消すと本文を壊す。
// さらに落とすのは tail（読点・空白）が無い＝助詞が名前に直結している場合のみ。
// 「〇〇さん、はじめまして」は読点があるので「は」は次の文の一部＝絶対に消さない。
const TRAILING_PARTICLE_RE_SRC = "([のがにをへ])?";
// 助詞を落としてよいか: 名前と助詞の間に読点・空白・改行が無い場合のみ
function shouldDropParticle(tail: string): boolean {
  return tail === "";
}

// ─── 顧客名の誤り（LINE表示名の混入）を決定論的に修正 ────────────────────────
// final-check（Haiku）は FABRICATED_NAME を検出できるが、接地修正は
// [CHECKPOINT]/[CONDITIONS]/[RULES] に無い事実で置換できない仕様のため名前を直せない
// （引用検証で修正全体が破棄される）。名前はDBの customer_name が唯一の正解なので、
// LLMに任せず、ここでコード側が確定的に置換・除去する。
//  ① 本文に出た LINE表示名（実名の形でないもの）→ 正しい名前に置換／名前不明なら呼びかけごと削除
//  ② 行頭の呼びかけ「〇〇さん」の〇〇が実名の形でない → 同上
// 実名の形をした別名（第三者の「オーナーさん」「管理会社さん」等を含む）は一切触らない。
export function enforceCustomerName(
  text: string,
  opts: { customerName?: string | null; lineDisplayName?: string | null },
): { cleaned: string; fixes: string[] } {
  const canonicalRaw = (opts.customerName ?? "").trim();
  const canonical = isPlausiblePersonName(canonicalRaw) ? canonicalRaw : "";
  const display = (opts.lineDisplayName ?? "").trim();
  const fixes: string[] = [];
  let cleaned = text;

  // ① LINE表示名がそのまま本文に出ている（「H!tom!.Mさん、お世話に…」等）
  if (display && display !== canonical && !isPlausiblePersonName(display)) {
    const esc = escapeRegExp(display);
    const addressReSrc = `${esc}\\s*${HONORIFIC_RE_SRC}([、,]?\\s*)${TRAILING_PARTICLE_RE_SRC}`;
    if (new RegExp(addressReSrc, "g").test(cleaned)) {
      cleaned = cleaned.replace(
        new RegExp(addressReSrc, "g"),
        (_m, tail: string, particle: string | undefined) => {
          const p = particle ?? "";
          if (canonical) return `${canonical}さん${tail}${p}`;
          // 名前不明 → 呼びかけごと削除。直結した助詞も落として「のお引越し」等の残骸を防ぐ
          return shouldDropParticle(tail) ? "" : p;
        },
      );
      fixes.push(`LINE表示名の呼びかけ「${display}さん」→「${canonical ? `${canonical}さん` : "(削除)"}」`);
    }
    if (cleaned.includes(display)) {
      cleaned = cleaned.split(display).join(canonical);
      fixes.push(`本文中のLINE表示名「${display}」を除去`);
    }
  }

  // ② 行頭の呼びかけ「〇〇さん」が実名の形でない（表示名の変形・崩れをAIが書いた場合）
  const lineHeadAddressRe = /(^|\n)([\s「]*)([^\s、。！!？?\n【】「」（）()・]{1,20})\s*(?:さん|サン|様|さま)([、,]?[ 　]*)([のがにをへ])?/g;
  cleaned = cleaned.replace(lineHeadAddressRe, (m, br: string, lead: string, base: string, tail: string, particle: string | undefined) => {
    if (base === canonical) return m;
    // 実名の形をしているものは第三者名の可能性もあるため一切触らない（誤置換の防止）
    if (isPlausiblePersonName(base)) return m;
    // テンプレの未置換プレースホルダー（「〇〇さん」「アカウント名さん」「[名前]さん」等）は
    // detectPlaceholders の検出対象なのでここでは潰さない（潰すと未置換の警告が消えてしまう）
    if (/[〇○＿_{}[\]]/.test(base) || base === "アカウント名") return m;
    fixes.push(`不正な呼びかけ「${base}さん」→「${canonical ? `${canonical}さん` : "(削除)"}」`);
    // 削除時は直後の助詞（「〇〇さんのお引越し」の「の」等）も落とす。残すと文頭に助詞が残る
    const p = particle ?? "";
    if (canonical) return `${br}${lead}${canonical}さん${tail}${p}`;
    return shouldDropParticle(tail) ? `${br}${lead}` : `${br}${lead}${p}`;
  });

  return { cleaned, fixes };
}

// ─── 顧客名の正規化・一貫性チェック（S-5 / 2026-09-08 Fable5）────────────────────
// 旧実装（route.ts の貪欲 /([^\s「」。！\n]{1,8})さん/g）は「私の方でも竹田さん」を「私の方でも竹田」と
// 捕捉して正当返信を block し、逆に「竹田頼正様」「〇〇さん」「山田さん（一貫した誤名）」は素通りしていた。
// 名前は normalizeCustomerName で1つに確定し、検査は「アンカー付き・単一スクリプト候補＋第三者辞書＋sameName 比較」で行う。
// 初回・recheck・check-reply・後処理後で同じ関数を走らせる（final-check runDeterministicChecks から呼ぶ）。
const HONORIFIC_TAIL_RE = /(?:様|さま|サマ|さん|サン|ちゃん|くん|君|氏)$/;
const GENERIC_NICKNAMES = new Set(["パパ", "ママ", "ねこ", "いぬ", "猫", "犬", "匿名", "名無し", "名称未設定", "お客様", "お客さま"]);

/** 確定名の正規化。敬称除去・記号除去・かな分かち書き結合・姓抽出。実名形でなければ "" */
export function normalizeCustomerName(raw?: string | null): string {
  let n = stripNonNameChars((raw ?? "").trim()).replace(HONORIFIC_TAIL_RE, "").trim();
  const segs = n.split(/[\s・]+/).filter(Boolean);
  if (segs.length === 0) return "";
  if (segs.length >= 2) {
    const allKana = segs.every((s) => /^[ぁ-んゝゞァ-ヴヽヾー]+$/.test(s));
    n = allKana ? segs.join("") : segs[0]; // 「あ や」→「あや」／「山田 太郎」→「山田」
  }
  if (GENERIC_NICKNAMES.has(n) || PLACEHOLDER_NAME_CORE_RE.test(n)) return "";
  return isPlausiblePersonName(n) ? n : "";
}
const toHira = (s: string) => s.replace(/[ァ-ヴ]/g, (c) => String.fromCharCode(c.charCodeAt(0) - 0x60));
const sameName = (a: string, b: string) => {
  const x = toHira(a).toLowerCase(), y = toHira(b).toLowerCase();
  return x === y || x.endsWith(y) || y.endsWith(x);
};

// 第三者・一般名詞の「〇〇さん」（顧客名候補から除外）
export const THIRD_PARTY_SAN_RE = /^(?:お客|皆|みな|大家|オーナー|管理会社|管理|業者|保証会社|担当者?|旦那|奥|お母|お父|お子|お姉|お兄|彼氏|彼女|息子|娘|ご主人|お嬢|ご家族|仲介|不動産屋|鈴木|スタッフ|皆様|みなさま|お客様)$/;
// 呼びかけ候補: 行頭・空白・句読点・括弧・絵文字の直後のみ、名前部分は単一スクリプト限定（貪欲巻き込みを構造的に排除）
const ADDRESS_CAND_RE = /(?:^|[\s、。！!？?「（(]|\p{Extended_Pictographic})([ぁ-んゝゞァ-ヴヽヾー]{2,6}|[一-鿿々]{1,4}|[A-Za-z]{2,12})(?:さん|サン|様|さま)/gmu;
const PLACEHOLDER_ADDRESS_RE = /(?:〇〇|○○|アカウント名|\[名前\]|\{name\}|名無し[^\s、。！!\n]{0,8}|権兵衛|名称未設定|未設定|ゲスト)\s*(?:さん|様)?/;

export type NameIssue = {
  code: "NAME_MISMATCH" | "NAME_PLACEHOLDER" | "NAME_OVERUSE" | "NAME_FULLNAME_LEAK";
  severity: "block" | "warning";
  evidence: string;
  message: string;
  suggestion: string;
};

export function checkNameConsistency(
  text: string,
  canonicalRaw: string | null | undefined,
  opts?: { isAutoSend?: boolean; allowNames?: string[] },
): NameIssue[] {
  const issues: NameIssue[] = [];
  const canon = normalizeCustomerName(canonicalRaw);
  const allow = (opts?.allowNames ?? []).map(normalizeCustomerName).filter(Boolean);
  const ph = text.match(PLACEHOLDER_ADDRESS_RE);
  if (ph) {
    issues.push({
      code: "NAME_PLACEHOLDER", severity: "block", evidence: ph[0],
      message: "名前プレースホルダ（〇〇さん等）が未置換のまま残っています",
      suggestion: canon ? `「${canon}さん」に置換` : "呼びかけごと削除（名前なしで返信）",
    });
  }
  const foreign = new Set<string>();
  for (const m of text.matchAll(ADDRESS_CAND_RE)) {
    const cand = m[1];
    if (THIRD_PARTY_SAN_RE.test(cand)) continue;
    if (canon && sameName(cand, canon)) continue;
    if (allow.some((a) => sameName(cand, a))) continue; // 連名者・保証人など顧客自身が書いた名前
    // ひらがな候補は動詞・助詞断片（「よろしければ」「頂き」等）が混ざりやすいため実名形チェックを追加
    if (/^[ぁ-んゝゞ]+$/.test(cand) && !isPlausiblePersonName(cand)) continue;
    foreign.add(cand);
  }
  if (foreign.size > 0) {
    const list = [...foreign].join(" / ");
    issues.push({
      code: "NAME_MISMATCH", severity: canon || opts?.isAutoSend ? "block" : "warning", evidence: list,
      message: canon ? `確定名「${canon}さん」以外の呼びかけ（${list}）が混在しています` : `お客様名が不明の会話で名前（${list}）を創作しています`,
      suggestion: canon ? `全て「${canon}さん」に統一` : "呼びかけを削除し名前なしで返信",
    });
  }
  if (canon) {
    const full = text.match(new RegExp(`${escapeRegExp(canon)}[ぁ-ん一-鿿々]{1,4}\\s*(?:様|さま)`));
    if (full) {
      issues.push({
        code: "NAME_FULLNAME_LEAK", severity: "block", evidence: full[0],
        message: "フルネーム＋様の呼びかけです（本人確認書類の氏名を返信に書かない）",
        suggestion: `「${canon}さん」に置換`,
      });
    }
    const cnt = (text.match(new RegExp(`${escapeRegExp(canon)}(?:さん|サン|様|さま)`, "g")) ?? []).length;
    if (cnt >= 3) {
      issues.push({
        code: "NAME_OVERUSE", severity: "warning", evidence: `${canon}さん×${cnt}`,
        message: `顧客名の呼びかけが${cnt}回あります`,
        suggestion: "冒頭1回＋本文1回（計2回）以内",
      });
    }
  }
  return issues;
}

// 送信前の未置換プレースホルダーを検出（送信ブロック用）
const PLACEHOLDER_ALLOWLIST = new Set(["[画像]", "[動画]", "[スタンプ]"]);

export function detectPlaceholders(text: string): string[] {
  const found = new Set<string>();
  // [日付] [物件名] [名前] など半角角括弧（20文字以内・改行なし）
  for (const m of text.matchAll(/\[[^\[\]\n]{1,20}\]/g)) {
    if (!PLACEHOLDER_ALLOWLIST.has(m[0])) found.add(m[0]);
  }
  // {name} {日付} など波括弧型
  for (const m of text.matchAll(/\{[^{}\n]{1,20}\}/g)) found.add(m[0]);
  // 〇〇・○○ 伏せ字型（2文字以上連続）
  for (const m of text.matchAll(/[〇○]{2,}/g)) found.add(m[0]);
  return [...found];
}

// ─── AIX専用コンテンツのハードゲート（生成後の機械検証）───
// enforcement_level='required' 等のAIX判定時もプロンプト指示（viewingFactNote / estimateGateNote /
// propertyFactGateNote / meetingPlaceGateNote）はLLMへの指示に過ぎず、無視された場合を止められない。
// ここで生成後テキストを文単位で検査し、違反文を許可済みの宣言テンプレに置換する最終防衛線。
// promisedReplacement: 見積書・割引が直前スタッフ返信で約束済み／AIXで送付済み（estimatePromised=true）の場合の
// 代替置換文。通常の replacement（見積書作成宣言）をそのまま使うと約束済みの宣言を後段で再挿入して
// 二重宣言になるため、短い受付文に切り替える。
// vacancyDoneReplacement: AIXで空室確認を実行＋結果送信済み（aixVacancyDone=true）の場合の代替置換文。
// 通常の replacement（"確認しご連絡させて頂きます"）をそのまま使うと、既に確認済みの内容について
// 「これから確認します」と再宣言することになり二重宣言バグそのものになるため受付文へ切り替える。
// ─── G6 宅建業法（2026-09-08 Fable5）: 管理会社確認前の断言禁止3点（告知事項・空室状況・入居可能日）＋根拠なし審査安心 ───
// 四者同名: 生成（line-reply-prompts.ts VOCAB_SEMANTICS ■E）・後処理置換（本ファイル AIX_GATE_RULES）・
// final-check（runAssertionBanChecks）・route.ts（aixVacancyDone 供給）が本定数を参照する。直す時は4か所を grep。
// 免除は「情報源の存在」のみ（管理会社確認結果の報告・AIX 完了・審査結果報告）。顧客が日付・空室を言っただけでは免除しない。
export type AssertionBanCode = "DISCLOSURE_ASSERTION" | "VACANCY_ASSERTION" | "MOVEIN_DATE_ASSERTION" | "SCREENING_ASSURANCE";
export type AssertionBanRule = {
  code: AssertionBanCode;
  /** 本文の断言文に一致 */
  re: RegExp;
  /** スタッフ直近発言（AIX送付文含む）に一致すれば「管理会社確認済み・結果報告済み」として免除 */
  staffConfirmedRe: RegExp;
  /** staffSourceText（AIX原文）に対象語があれば情報源ありとして免除（isAix or brainMeta.action=property_check_result 時のみ） */
  sourceRe: RegExp;
  /** aixVacancyDone（AIX【物件確認した】property_check_result / mgmt_* 完了）で免除するか（空室・入居日のみ true） */
  exemptOnAixVacancyDone: boolean;
  /** validateAndClean で違反文を置き換える確認宣言（自分自身が re に一致しないこと） */
  replacement: string;
  msg: string;
  sug: string;
};

// 管理会社への確認が「完了した」ことを示す文末（未来形「確認します」「確認でき次第」は含めない）
const MGMT_CONFIRMED_TAIL =
  "(?:確認(?:しました|いたしました|致しました|したところ|いたしましたところ|が取れ|済み|できました|出来ました)|とのこと|との回答|との返答|によりますと|によると|から(?:の)?回答)";

export const ASSERTION_BAN_RULES: AssertionBanRule[] = [
  {
    // 「トラブルはございません」「告知事項なし」「事故物件ではありません」「騒音は特にありません」
    code: "DISCLOSURE_ASSERTION",
    re: /(?:告知事項|心理的瑕疵|事故物件|事故歴|事件|自殺|孤独死|トラブル|騒音|近隣(?:問題|トラブル)?|訳あり)[^\n。！!？?]{0,14}(?:は|も|等は|などは|では)?(?:ございません|ありません|御座いません|無(?:い|し)(?:です|物件|と)|ない(?:です|物件|と|ので)|なし(?:です|の|と)|特に(?:ございません|ありません|無|な)|問題(?:ございません|ありません|御座いません|ない))/,
    staffConfirmedRe: new RegExp(`(?:告知|心理的瑕疵|事故|トラブル|騒音)[^\\n]{0,30}${MGMT_CONFIRMED_TAIL}|${MGMT_CONFIRMED_TAIL}[^\\n]{0,30}(?:告知|心理的瑕疵|事故|トラブル|騒音)`),
    sourceRe: /告知|心理的瑕疵|事故|トラブル|騒音/,
    exemptOnAixVacancyDone: false,
    replacement: "告知事項につきましては管理会社に確認の上お伝えさせて頂きます！！",
    msg: "告知事項（事故・トラブル・心理的瑕疵・騒音）の「なし」断言は管理会社確認前は禁止（宅建業法47条 不告知リスク）",
    sug: "「告知事項につきましては管理会社に確認の上お伝えさせて頂きます」に変更",
  },
  {
    // 「現在空室です」「募集中となっております」「空いております」「埋まってしまいました」「空室確認しました」「申込が入っています」
    // 未来形・条件形・疑問形（空室状況を確認します／空室でしたら／空室ですか／募集中か確認）は構造的に不一致
    code: "VACANCY_ASSERTION",
    re: /(?:(?:空室|募集中|満室|空き(?:あり|部屋)|入居中|退去(?:予定|済み)|ご案内可能な状態|お申込み可能な状態)(?:です|でございます|で御座います|でした|となって(?:おり|い)ます|になって(?:おり|い)ます|となります|とのこと|との回答|(?:を|と)?確認(?:しました|いたしました|致しました|できました|出来ました|が取れました)|と伺|と聞い)|空いて(?:います|おります|ございます|いました|おりました)|埋まって(?:います|おります|いました|おりました|しまいました|しまっており)|募集(?:は)?(?:終了|停止)(?:し(?:ました|ており|ています)|です|となって|となりました)|お?申(?:し)?込(?:み)?が入って(?:います|おります|いました|しまい))(?![かがらば])/,
    staffConfirmedRe: new RegExp(`(?:空室|空き|募集|満室|埋まっ|申込|入居中|退去)[^\\n]{0,30}${MGMT_CONFIRMED_TAIL}|${MGMT_CONFIRMED_TAIL}[^\\n]{0,30}(?:空室|空き|募集|満室|埋まっ|入居中|退去)`),
    sourceRe: /空室|空き|募集|満室|入居中|退去|埋まっ/,
    exemptOnAixVacancyDone: true,
    replacement: "最新の空き状況を確認しご連絡させて頂きます😊！！",
    msg: "空室・募集状況の断言は管理会社確認（AIX【物件確認した】）前は禁止",
    sug: "「最新の空き状況を確認しご連絡させて頂きます」に変更（確認結果はAIX【物件確認した】から送る）",
  },
  {
    // 「9月1日からご入居いただけます」「10月上旬より入居可能」「来月から入居できます」「退去日は9/30」「鍵のお渡しは10/1」
    // 「10月からご入居ご希望」「入居可能でしょうか」「入居可能な物件をピックアップ」「10月中にご入居いただけるお部屋」は lookahead で除外
    code: "MOVEIN_DATE_ASSERTION",
    re: /(?:(?:[0-9０-９]{1,2}\s*[\/／月]\s*[0-9０-９]{1,2}\s*日?|[0-9０-９]{1,2}\s*月(?:上旬|中旬|下旬|末|初旬|頭)?|来月|今月|翌月|再来月|来週|今週|即日|即|明日|明後日|すぐに?)(?:から|より|以降|に|には|中に|末に|頃|ごろ)?[^\n。！!？?]{0,10}?(?:ご?入居(?:可能|いただけ|頂け|できます|出来ます|OK|オッケー|となります|になります)|お引(?:っ)?越し(?:いただけ|頂け|可能|できます|出来ます)|お住まい(?:いただけ|頂け)|(?:鍵|お鍵)(?:の)?お渡し|お渡し(?:可能|できます|出来ます))(?!でしょうか|ですか|か|る|よう|ますよう|ご希望|希望|な(?:お部屋|物件)|の物件)|退去(?:日|予定日|予定)(?:は|が)?\s*[0-9０-９]{1,2}\s*[\/／月])/,
    staffConfirmedRe: new RegExp(`(?:入居|退去|引(?:っ)?越し|鍵)[^\\n]{0,30}${MGMT_CONFIRMED_TAIL}|${MGMT_CONFIRMED_TAIL}[^\\n]{0,30}(?:入居|退去|引(?:っ)?越し|鍵)|(?:[0-9０-９]{1,2}\\s*[\\/／月]\\s*[0-9０-９]{1,2}|[0-9０-９]{1,2}\\s*月)[^\\n]{0,12}(?:入居|退去|お渡し)`),
    sourceRe: /入居|退去|引(?:っ)?越し|鍵/,
    exemptOnAixVacancyDone: true,
    replacement: "ご入居可能日につきましては管理会社に空き状況を確認しご連絡させて頂きます！！",
    msg: "入居可能日・退去日の具体日付の断言は管理会社確認前は禁止（AIX_BOUNDARY_MOVEIN の決定論版）",
    sug: "「ご入居可能日につきましては管理会社に空き状況を確認しご連絡させて頂きます」に変更",
  },
  {
    // 「審査は問題ございません」「審査は大丈夫です」「審査は通るかと思います」「必ず審査に通ります」「審査についてはご安心ください」
    // 「審査に通りやすいよう最大限サポート」「審査面も全力でサポートしますのでご安心ください（12字超）」は不一致
    code: "SCREENING_ASSURANCE",
    re: /審査[^\n。！!？?]{0,12}(?:問題(?:ございません|ありません|御座いません|ない(?:です|かと|と思))|大丈夫(?:です|かと|だと|でしょう)|通(?:ります|る(?:かと|と思|はず|でしょう)|りやすい(?:です|かと|と思)|過(?:します|する(?:かと|と思|はず)|できます|出来ます))|心配(?:ございません|ありません|いりません|不要|ご無用|ない)|(?:ご)?安心(?:ください|下さい|してください|頂け|いただけ))|(?:必ず|確実に|絶対(?:に)?|間違いなく|100[%％])[^\n。！!？?]{0,8}(?:審査|承認|通(?:り|し|過)|ご入居(?:いただけ|頂け|できます))/,
    staffConfirmedRe: /審査[^\n]{0,20}(?:承認|通過|可決|OK|通りました|結果(?:が出|は|:|：))/,
    sourceRe: /審査/,
    exemptOnAixVacancyDone: false,
    replacement: "審査結果につきましては保証会社の審査次第となりますが、お申込みは最大限サポートさせて頂きます！！",
    msg: "根拠のない審査安心断言は禁止（審査主体は保証会社・管理会社。結果は審査次第）",
    sug: "「審査結果につきましては保証会社の審査次第となります」に変更",
  },
];

const AIX_GATE_RULES: { name: string; test: (s: string) => boolean; replacement: string; promisedReplacement?: string; vacancyDoneReplacement?: string; assertion?: AssertionBanRule }[] = [
  {
    // 内覧候補日時の具体提示（「8/7（木）14:00〜」等）→ AIX「内覧へ」ボタン専用
    name: "内覧候補日時",
    test: (s) =>
      /[0-9０-９]{1,2}\s*[\/／月]\s*[0-9０-９]{1,2}/.test(s) &&
      /(?:[0-9０-９]{1,2}\s*[:：]\s*[0-9０-９]{2}|[0-9０-９]{1,2}\s*時|午前|午後)\s*[〜~～-]?/.test(s) &&
      /(?:内覧|内見|見学|ご案内|ご都合|いかが|ご希望|空いて)/.test(s),
    // G7（2026-09-08 Fable5）: 条件節＋疑問形の正規形（「〜にご案内させて頂きます」単独締めは V3 GOCHOUGO_NO_CONDITION）
    replacement: "お気に召されましたらご都合よろしいお日にち御座いますでしょうか！！ご案内させて頂きます！！",
  },
  {
    // 見積金額内訳（「敷金50,000円」「家賃72,000円」「敷金1ヶ月分」等）→ AIX「見積書送る」ボタン専用
    // AIは物件資料・見積書の画像を読めないため、物件固有の金額・数値（家賃・管理費・割引額等）の生成は絶対禁止
    name: "見積金額内訳",
    test: (s) =>
      (/[0-9０-９][0-9０-９,，．.]*\s*(?:万\s*)?円/.test(s) &&
        /(?:初期費用|敷金|礼金|仲介手数料|保証料|鍵交換|火災保険|前?家賃|管理費|共益費|日割|御見積|お見積|見積|合計|総額|内訳|割引|スモ割|節約)/.test(s)) ||
      // 「敷金1ヶ月分」等の月数表記（円なし）も物件固有数値としてブロック
      (/[0-9０-９]+(?:[.．][0-9０-９]+)?\s*[ヶケか]月分?/.test(s) &&
        /(?:敷金|礼金|保証料|前家賃)/.test(s)),
    replacement: "最大限割引させていただいた御見積書を作成しお送りさせて頂きます！！",
    promisedReplacement: "確認しご連絡させて頂きます😊！！",
  },
  {
    // 物件固有金額（¥表記・「数万円」「〜万円」等の曖昧額の断定提示）→ AIX「見積書送る」ボタン専用
    // 上の「見積金額内訳」は数字+円/万円を検出するが、¥50,000 等の通貨記号表記と、
    // 「スモ割適用後の金額は〜万円となります」のような数字を伏せた断定文はすり抜けるためここで補完する。
    // 一般知識文（「敷金は1〜2ヶ月分が目安です」等）や金額を伴わない「家賃」単独では発火させない。
    name: "物件固有金額",
    test: (s) =>
      /(?:管理費|共益費|敷金|礼金|初期費用|合計|総額|スモ割)/.test(s) &&
      // ¥50,000・￥５万 等の通貨記号+数字表記
      (/[¥￥]\s*[0-9０-９][0-9０-９,，．.]*\s*万?/.test(s) ||
        // 「数万円」「〜万円」「約 万円」等、数字を伏せつつ物件固有額として断定する文
        // （目安・相場・一般的 等の一般知識マーカーがある文は除外）
        (/(?:数|[〜~～]|約\s*)万\s*円/.test(s) &&
          /(?:です|となります|になります|でございます|かかります|頂きます|いただきます)/.test(s) &&
          !/(?:目安|相場|一般的|通常|平均|多いです|ケースが|場合が)/.test(s))),
    replacement: "物件の詳細な費用は、スタッフが資料を確認してAIX【見積書送る】からお送りします！！",
  },
  {
    // 見積書カバー文（数字なしでも「御見積書となります」「ご査収ください」等で送付済みを装う文）
    // → AIX「見積書送る」ボタン専用。数字+円がなくても添付済みを偽装する文を止める
    name: "見積書カバー文",
    test: (s) =>
      /(?:御?見積書|お見積書)/.test(s) &&
      /(?:となります|同封|添付|ご査収|お送りしました|お送り致しました)/.test(s) &&
      !/作成|お送りさせて頂きます|お送りいたします/.test(s),
    replacement: "最大限割引させていただいた御見積書を作成しお送りさせて頂きます！！",
    promisedReplacement: "確認しご連絡させて頂きます😊！！",
  },
  {
    // 住所・集合場所・集合時間の確定文 → AIX「待ち合わせ」ボタン専用
    name: "待ち合わせ確定",
    test: (s) =>
      /(?:エントランス|集合場所|現地集合|待ち合わせ場所)/.test(s) &&
      /(?:丁目|番地|〒|[0-9０-９]{1,2}\s*[:：]\s*[0-9０-９]{2}|[0-9０-９]{1,2}\s*時)/.test(s),
    replacement: "内覧の詳細についてはご連絡させて頂きます！！",
  },
  // G6 (2026-09-08 Fable5): 旧「確認結果断言」（狭い文末形のみ）を共有定数 ASSERTION_BAN_RULES から生成する形に置換。
  // 「空室です」「9月1日からご入居いただけます」「告知事項なし」「審査は問題ございません」が文単位で確認宣言に置換される。
  // exemptOnAixVacancyDone=true（空室・入居日）は AIX 確認済みなら「かしこまりました」（旧 vacancyDoneReplacement と同じ挙動）。
  ...ASSERTION_BAN_RULES.map((r) => ({
    name: `断言禁止:${r.code}`,
    test: (s: string) => r.re.test(s),
    replacement: r.replacement,
    vacancyDoneReplacement: r.exemptOnAixVacancyDone ? "かしこまりました😊！！" : undefined,
    assertion: r,
  })),
];

// AIX【物件確認した】で空室確認を実行＋結果送信済みなのに、返信が「これから確認します」と
// 未来形で再宣言している文を検出する（プロンプト指示が無視された場合の最終防衛線）。
// 過去形・完了形（「確認しましたところ」「確認済み」）は正当な結果報告なので除外する。
const VACANCY_REDECLARE_RE =
  /(?:空室|空き)(?:状況|状態)?|募集(?:状況|状態)?|お部屋の(?:状況|空き)|管理会社/;
const VACANCY_REDECLARE_FUTURE_RE =
  /(?:確認|問い合わせ|問合せ)(?:を)?(?:し(?:て|、)?)?(?:改めて)?(?:させて(?:頂|いただ)き|いたします|致します|します|でき次第|次第)|(?:確認|問い合わせ)し(?:て)?ご連絡/;
const VACANCY_REDECLARE_PAST_RE =
  /確認(?:し(?:まし)?た|済み|できまし|が取れ|したところ|いたしましたところ)|確認結果/;

// AIX【物件ピックアップ】で物件送付済みなのに「これからピックアップします」と再宣言する文。
const PICKUP_REDECLARE_RE =
  /(?:ピックアップ|お探し|探させて|お部屋を?(?:お)?探し)[^。！!？?\n]{0,20}(?:させて(?:頂|いただ)き|いたします|致します|します|お送り|お届け)/;

// 文中の金額（円単位）を正規化して抽出（「176,180円」「¥176,180 円」「１７６，１８０円」→ "176180"）
// estimatePromised置換の「履歴内金額の引用免除」判定に使用する
function extractYenAmounts(t: string): string[] {
  return [...t.matchAll(/[¥￥]?([0-9０-９][0-9０-９,，.．]{2,})[\s　]*円/g)].map((m) =>
    m[1].replace(/[０-９]/g, (d) => String.fromCharCode(d.charCodeAt(0) - 0xfee0)).replace(/[,，.．]/g, ""),
  );
}

export function enforceAixGates(
  text: string,
  opts?: {
    estimatePromised?: boolean;
    customerMessage?: string;
    lastStaffMsg?: string;
    // AIX【物件確認した】で空室確認を実行＋結果送信済み（generate-reply の aixDone.vacancyCheck / mgmtCheck）。
    // true の場合、「これから確認します」の再宣言文を削除し、AIXゲートの置換文も受付文に切り替える。
    aixVacancyDone?: boolean;
    // AIX【物件ピックアップした】で物件送付済み（generate-reply の aixDone.propertySend）。
    aixPickupDone?: boolean;
  },
): { cleaned: string; violations: string[] } {
  const violations: string[] = [];
  const usedReplacement = new Set<string>();
  // 履歴内金額の引用免除用: 直前スタッフメッセージに実在する金額（スタッフが提示済み＝AIが引用してよい金額）
  const staffPrices = opts?.lastStaffMsg ? extractYenAmounts(opts.lastStaffMsg) : [];
  // 分割払い提案ゲート: お客様が支払い方法を質問していない／「払えない」と言っていないのに
  // AIが「分割払いのご相談も可能です」等を生成した場合、該当文を削除する（置換文は挿入しない）。
  // 分割払いの提案定義はコード・テンプレ・DBのどこにも存在しないため、出現＝LLMの自由生成＝削除が正。
  const customerAskedInstallment = opts?.customerMessage
    ? /分割|支払(い)?方法|カード払い|クレジット|一括|払え(ない|なそう|そうにない|ません)/.test(opts.customerMessage)
    : false;
  const installmentProposalRe = /分割[^。！!？?\n]{0,10}(払い|支払|も可能|でき(ます|る)|のご相談|ご案内|ご対応)/;
  // 見積書作成宣言ゲート: 約束済み（estimatePromised=true）の場合、LLMが再生成した
  // 「御見積書を作成しお送りします」宣言文そのものも二重宣言となるため短い受付文へ置換する
  const estimateDeclarationRe = /(?:御?見積書|お見積書)[^。！!？?\n]{0,20}(?:作成|お送り)|最大限割引[^。！!？?\n]{0,25}(?:作成|お送り)/;
  const outLines = text.split("\n").map((line) => {
    // 文末（。！!？?）で分割。「！！」等の連続記号は1文として保持する
    const sentences = line.split(/(?<=[。！!？?])(?![。！!？?])/);
    const outSentences: string[] = [];
    for (const s of sentences) {
      // 分割払い提案（顧客が聞いていない場合のみ削除・置換なし）
      if (!customerAskedInstallment && installmentProposalRe.test(s)) {
        violations.push(`分割払い提案(削除): ${s.trim().slice(0, 40)}`);
        continue;
      }
      // 見積書作成宣言の繰り返し（約束済みの場合のみ短文へ置換。本文に既に受付文があれば削除のみ）
      if (opts?.estimatePromised && estimateDeclarationRe.test(s)) {
        violations.push(`見積作成宣言の繰り返し: ${s.trim().slice(0, 40)}`);
        if (!usedReplacement.has("見積作成宣言の繰り返し") && !text.includes("かしこまりました")) {
          usedReplacement.add("見積作成宣言の繰り返し");
          outSentences.push("かしこまりました😊！！");
        }
        continue;
      }
      // AIX実行済みアクションの再宣言（空室確認・物件ピックアップ）→ 該当文を削除
      // プロンプトの【🚫 AIX実行済みアクションの再宣言禁止】が無視された場合の最終防衛線。
      if (
        opts?.aixVacancyDone &&
        VACANCY_REDECLARE_RE.test(s) &&
        VACANCY_REDECLARE_FUTURE_RE.test(s) &&
        !VACANCY_REDECLARE_PAST_RE.test(s)
      ) {
        violations.push(`空室確認の再宣言(実行済): ${s.trim().slice(0, 40)}`);
        if (!usedReplacement.has("空室確認の再宣言") && !text.includes("かしこまりました")) {
          usedReplacement.add("空室確認の再宣言");
          outSentences.push("かしこまりました😊！！");
        }
        continue;
      }
      if (opts?.aixPickupDone && PICKUP_REDECLARE_RE.test(s)) {
        violations.push(`ピックアップ宣言の再宣言(送付済): ${s.trim().slice(0, 40)}`);
        if (!usedReplacement.has("ピックアップ再宣言") && !text.includes("かしこまりました")) {
          usedReplacement.add("ピックアップ再宣言");
          outSentences.push("かしこまりました😊！！");
        }
        continue;
      }
      const rule = AIX_GATE_RULES.find((r) => {
        if (!r.test(s)) return false;
        // 内覧候補日時: スタッフ自身が提案済みの日付を引用している文は免除（二重ゲート防止）
        // 例: スタッフ「9/7（月）16:00よりオンライン内覧…」→ 顧客「はい大丈夫」→ AI「9/7（月）16:00より内覧…」
        if (r.name === "内覧候補日時" && opts?.lastStaffMsg) {
          const dateMatch = s.match(/[0-9０-９]{1,2}\s*[\/／月]\s*[0-9０-９]{1,2}/);
          if (dateMatch && opts.lastStaffMsg.includes(dateMatch[0])) return false;
        }
        // G6: 直前スタッフ発言（AIX送付文含む）に確認結果報告があれば「確認済み事実の復唱」として通す
        if (r.assertion && opts?.lastStaffMsg && r.assertion.staffConfirmedRe.test(opts.lastStaffMsg)) return false;
        return true;
      });
      if (!rule) {
        outSentences.push(s);
        continue;
      }
      // 履歴内金額の引用免除: estimatePromised=true の強制置換（promisedReplacement）は、
      // スタッフが直前に送った金額（例: 176,180円）を引用して顧客の誤認（179,180円）を
      // 訂正する正当な返答まで潰してしまう。文中の金額が直前スタッフメッセージに実在する
      // 場合は「履歴内の金額の正当な引用」とみなし、置換せずそのまま通す。
      if (opts?.estimatePromised && rule.promisedReplacement && staffPrices.length > 0) {
        const sentencePrices = extractYenAmounts(s);
        if (sentencePrices.some((p) => staffPrices.includes(p))) {
          outSentences.push(s);
          continue;
        }
      }
      violations.push(`${rule.name}: ${s.trim().slice(0, 40)}`);
      // 同一ルールの違反が複数文ある場合、宣言テンプレは1回だけ挿入し残りは除去（内訳の複数行等）
      if (!usedReplacement.has(rule.name)) {
        usedReplacement.add(rule.name);
        // 約束済みの場合は宣言テンプレを再挿入せず短い受付文に切り替える（二重宣言の再挿入防止）
        // 置換文の優先順: ①空室確認済み（再宣言になる置換文を回避）② 見積約束済み ③ 通常
        outSentences.push(
          opts?.aixVacancyDone && rule.vacancyDoneReplacement
            ? rule.vacancyDoneReplacement
            : opts?.estimatePromised && rule.promisedReplacement
              ? rule.promisedReplacement
              : rule.replacement,
        );
      }
    }
    return outSentences.join("");
  });
  // 違反行の除去で生じた3連以上の改行を2連（空行1つ）に圧縮
  const cleaned = violations.length > 0
    ? outLines.join("\n").replace(/\n{3,}/g, "\n\n")
    : text;
  return { cleaned, violations };
}

// ─── 物件固有金額のソース検証（テンプレート最適化モード用の軽量ポストチェック）───
// 【物件固有の金額・数値はAIが画像を見れないため生成禁止】
// AIは物件資料・見積書等の画像を読み取ることができない。そのため、家賃・管理費・敷金礼金・初期費用内訳・
// 合計金額・割引額など、物件固有の具体的な数値に関する質問には、AIが推測・生成して回答することを絶対禁止とする。
// これらの数値は必ずスタッフが画像を確認した上で、AIX（見積書送る／物件確認した等）から送付する。
// テンプレート最適化モードは aixGates を無効化しているため、出力中の「〜円」金額が
// スタッフ由来ソーステキスト（AIX物件情報・テンプレ原文等）に実在するかをここで機械検証する。
const normalizeAmountDigits = (s: string): string =>
  s.replace(/[０-９]/g, (d) => String.fromCharCode(d.charCodeAt(0) - 0xfee0)).replace(/[,，]/g, "");

export function verifyAmountsAgainstSource(text: string, sourceText: string): { cleaned: string; unmatched: string[] } {
  const normalizedSource = normalizeAmountDigits(sourceText);
  const unmatched: string[] = [];
  const cleaned = text.replace(/[0-9０-９][0-9０-９,，]*円/g, (m) => {
    // 数字部分（円を除く）を半角・カンマなしに正規化してソース内に存在するか確認
    const digits = normalizeAmountDigits(m).slice(0, -1);
    if (normalizedSource.includes(digits)) return m; // ソースに実在 → 正当な金額
    unmatched.push(m);
    return "〇〇円"; // ソースに存在しない金額（ハルシネーション）→ 伏せ字に置換
  });
  return { cleaned, unmatched };
}

export function validateAndClean(
  text: string,
  opts?: {
    aixGates?: boolean;
    customerName?: string | null;
    lineDisplayName?: string | null;
    // 見積書・割引の約束済みフラグ（直前スタッフ返信 or aix_usage_logs estimate_sheet 由来）。
    // true の場合、AIXゲートの置換文を見積書作成宣言→短い受付文に切り替え、宣言の繰り返しも置換する
    estimatePromised?: boolean;
    // 分割払いゲート用: お客様の最新メッセージ（支払い方法を質問していない場合、返信中の分割提案文を削除）
    customerMessage?: string;
    // 履歴内金額の引用免除用: 直前のスタッフメッセージ。返信中の金額がここに実在する場合、
    // estimatePromised の強制置換（promisedReplacement）をスキップする（正当な金額引用の保護）
    lastStaffMsg?: string;
    // AIXで実行＋送信済みのアクション（空室確認 / 物件ピックアップ）。
    // true の場合、「これから確認します/ピックアップします」の再宣言文を削除する
    aixVacancyDone?: boolean;
    aixPickupDone?: boolean;
  },
): { cleaned: string; issues: string[] } {
  const issues: string[] = []
  let cleaned = text
  // **太字** → 太字なしに除去
  if (/\*\*[^*]+\*\*/.test(cleaned)) {
    issues.push("マークダウン太字(**)")
    cleaned = cleaned.replace(/\*\*([^*]+)\*\*/g, "$1")
  }
  // 顧客名の誤り（LINE表示名の混入）を決定論的に修正（さんさん畳み込みより先に実行する）
  if (opts?.customerName != null || opts?.lineDisplayName != null) {
    const { cleaned: named, fixes } = enforceCustomerName(cleaned, {
      customerName: opts.customerName,
      lineDisplayName: opts.lineDisplayName,
    })
    if (fixes.length > 0) {
      issues.push(...fixes.map((f) => "顧客名修正: " + f))
      cleaned = named
    }
  }
  // さんさん → さん
  if (/さんさん/.test(cleaned)) {
    issues.push("敬称重複(さんさん)")
    cleaned = cleaned.replace(/さんさん/g, "さん")
  }
  // プレースホルダー残存チェック（削除はしない・issuesに追加のみ）
  const placeholders = detectPlaceholders(cleaned);
  if (placeholders.length > 0) issues.push("プレースホルダー残存: " + placeholders.join(" "));
  // 禁止ワード
  const banned = ["コスパ", "少々お待ちください", "共益費込み"]
  banned.forEach(w => { if (cleaned.includes(w)) issues.push("禁止ワード: " + w) })
  // AIXゲート機械検証（opt-in: generate-reply の通常返信ドラフトのみ。テンプレート最適化・パターン生成は対象外）
  if (opts?.aixGates) {
    const { cleaned: gated, violations } = enforceAixGates(cleaned, {
      estimatePromised: opts.estimatePromised,
      customerMessage: opts.customerMessage,
      lastStaffMsg: opts.lastStaffMsg,
      aixVacancyDone: opts.aixVacancyDone,
      aixPickupDone: opts.aixPickupDone,
    });
    if (violations.length > 0) {
      issues.push(...violations.map(v => "AIXゲート違反(置換済): " + v));
      cleaned = gated;
    }
  }
  return { cleaned, issues }
}
