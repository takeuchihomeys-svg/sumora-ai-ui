// 2026-09-11 統合設計（経路B）: 顧客名スロット（{name}／〇〇さん）の決定論置換は reply-context の fillNameSlot が唯一の実装。
//   reply-context は他の app/lib/* を runtime import しない（依存ゼロ）ので循環 import にならない
import { fillNameSlot } from "./reply-context";
// 2026-09-11 竹内方針1・4・5（統合設計 §1）: 後処理の決定論修正（承知→かしこまりました・すぐに除去・誤字）は依存ゼロの2モジュールが唯一の定義
import { normalizeBannedPhrasing } from "./banned-phrasing";
import { applyTypoAutoFix } from "./typo-check";
// 2026-09-12 竹内方針A: 時間枠の「空いて」・断言置換文は AIX 場面判定（aix-reply-set）と同じ定数
import { isScheduleSlotVacancy, ASSERTION_REPLACEMENT } from "./scene-patterns";
export { fillNameSlot };

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
/** 2026-09-11 竹内方針3（E2-c）: 前方一致（2字以上）も同一とみなす（吉田⊂吉田雄貴・なお⊂なおちん・りおな⊂りおなちゃん）。
 *  旧実装は後方一致だけで、姓で呼ぶ漢字フルネーム・ちゃん付き・略称を別人と判定していた */
const nameKey = (s: string) => toHira((typeof s.normalize === "function" ? s.normalize("NFKC") : s).replace(/[\s.・]/g, "")).toLowerCase();
export const sameName = (a: string, b: string): boolean => {
  const x = nameKey(a), y = nameKey(b);
  if (!x || !y) return false;
  if (x === y || x.endsWith(y) || y.endsWith(x)) return true;
  const short = x.length <= y.length ? x : y, long = short === x ? y : x;
  return short.length >= 2 && long.startsWith(short);
};

// 第三者・一般名詞の「〇〇さん」（顧客名候補から除外）
// 2026-09-11 竹内方針3（E2-i）: 婚約者・他社・同居人・パートナー・貸主・親御・ご友人・お知り合い・配信者を追加
export const THIRD_PARTY_SAN_RE = /^(?:お客|皆|みな|大家|オーナー|管理会社|管理|業者|保証会社|担当者?|旦那|奥|お母|お父|お子|お姉|お兄|彼氏|彼女|息子|娘|ご主人|お嬢|ご家族|仲介|不動産屋|鈴木|スタッフ|皆様|みなさま|お客様|婚約者|他社|同居人|パートナー|貸主|親御|ご友人|友人|お知り合い|知り合い|配信者|業者様|ご近所)$/;
// 呼びかけ候補: 行頭・空白・句読点・括弧・絵文字の直後のみ、名前部分は単一スクリプト限定（貪欲巻き込みを構造的に排除）
// 2026-09-11 竹内方針3（E2-e）: 敬称からカタカナ「サン」を外す（正解中の顧客敬称使用は0件。「モンサント旭町」「都度サンメゾン」を拾っていた）
const ADDRESS_CAND_RE = /(?:^|[\s、。！!？?「（(]|\p{Extended_Pictographic})([ぁ-んゝゞァ-ヴヽヾー]{2,6}|[一-鿿々]{1,4}|[A-Za-z]{2,12})(?:さん|様|さま)/gmu;
/** 呼びかけ位置の後続（行頭挨拶の直後に来る語）。resolveAddressName と checkNameConsistency が同じ定義を使う */
// 行頭の「〇〇さんの／に／は」も呼びかけ（スタッフは「はい！！⏎見木さんの初期費用…」のように2行目以降の行頭で呼ぶ）
const ADDRESS_HEAD_FOLLOW_SRC = "(?:[、,，！!。\\s😊😌🌟✨]|$|お世話|はじめまして|初めまして|お待たせ|お久しぶり|本日|ありがとう|有難う|ご都合|ご希望|ご連絡|おはよう|こんにちは|こんばんは|夜遅く|いつも|お疲れ|[のにはも])";
/** 強いつながり（文中でも呼びかけとみなす） */
const ADDRESS_COLLOCATION_SRC = "(?:にオススメ|におすすめ|にお勧め|のご希望|ご希望|のご都合|ご都合|にご満足|のご条件)";
/** 紹介者・会話相手の文脈（〇〇さんよりご紹介／〇〇さんとお話）は顧客への呼びかけではない */
const REFERRER_FOLLOW_RE = /^(?:さん|様|さま)(?:より|から)(?:ご)?紹介|^(?:さん|様|さま)(?:と|に)(?:お話|話|相談)/;
const PLACEHOLDER_ADDRESS_RE = /(?:〇〇|○○|アカウント名|\[名前\]|\{name\}|名無し[^\s、。！!\n]{0,8}|権兵衛|名称未設定|未設定|ゲスト)\s*(?:さん|様)?/;

export type NameIssue = {
  code: "NAME_MISMATCH" | "NAME_PLACEHOLDER" | "NAME_OVERUSE" | "NAME_FULLNAME_LEAK";
  severity: "block" | "warning";
  evidence: string;
  message: string;
  suggestion: string;
};

/** 確定名（resolveAddressName の結果）をそのまま使う。実名形でない生の表示名が渡された時だけ正規化する（再正規化でスタッフ由来の名前を壊さない）。
 *  2026-09-12 竹内方針C: export して、生成（nameNote・greetingNote・初回挨拶・resolveGreeting・名前スロット）も同じ関数を使う。
 *  旧実装はそこだけ normalizeCustomerName で「りおなちゃん」の「ちゃん」を剥がしていた（「〇〇ちゃんさん」は5会話・31通）。
 *  区切り（空白・中黒）を含む生の値（「山田 太郎」）は従来どおり正規化する（「山田 太郎さん」と書かない） */
export function canonOf(raw: string | null | undefined): string {
  const t = (raw ?? "").trim().replace(/(?:さん|様|さま)$/, "");
  if (!t) return "";
  if (!/[\s・]/.test(t) && isPlausiblePersonName(t) && !PLACEHOLDER_NAME_CORE_RE.test(t) && !GENERIC_NICKNAMES.has(t)) return t;
  return normalizeCustomerName(t);
}
/** 本文 index の候補が呼びかけ位置（行頭の挨拶・強いつながり）か */
function isAddressPosition(text: string, start: number, candEnd: number): boolean {
  const lineStart = text.lastIndexOf("\n", start - 1) + 1;
  const before = text.slice(lineStart, start);
  const after = text.slice(candEnd);
  if (/^[ \t　「]*$/.test(before) && new RegExp(`^(?:さん|様|さま)${ADDRESS_HEAD_FOLLOW_SRC}`).test(after)) return true;
  return new RegExp(`^(?:さん|様|さま)${ADDRESS_COLLOCATION_SRC}`).test(after);
}

export function checkNameConsistency(
  text: string,
  canonicalRaw: string | null | undefined,
  opts?: { isAutoSend?: boolean; allowNames?: string[]; /** 2026-09-11 竹内方針3: その会話でスタッフが呼んだ名前・顧客の名乗り（block しない） */ aliases?: string[] },
): NameIssue[] {
  const issues: NameIssue[] = [];
  // 2026-09-11 竹内方針3（E2-c）: 確定名は再正規化しない（「りおなちゃん」「Hayato」をスタッフが呼んだ形のまま使う）
  const canon = canonOf(canonicalRaw);
  const allow = (opts?.allowNames ?? []).map(normalizeCustomerName).filter(Boolean);
  const aliases = (opts?.aliases ?? []).map((a) => a.trim()).filter(Boolean);
  const ph = text.match(PLACEHOLDER_ADDRESS_RE);
  if (ph) {
    issues.push({
      code: "NAME_PLACEHOLDER", severity: "block", evidence: ph[0],
      message: "名前プレースホルダ（〇〇さん等）が未置換のまま残っています",
      suggestion: canon ? `「${canon}さん」に置換` : "呼びかけごと削除（名前なしで返信）",
    });
  }
  // 2026-09-11 竹内方針3（E2-i）: block は「呼びかけ位置に確定名・aliases・allowNames のどれでもない名前」がある時だけ。他の位置は warning
  const foreignAddr = new Set<string>();
  const foreignOther = new Set<string>();
  for (const m of text.matchAll(ADDRESS_CAND_RE)) {
    const cand = m[1];
    const candStart = (m.index ?? 0) + m[0].length - cand.length - (m[0].match(/(?:さん|様|さま)$/)?.[0].length ?? 0);
    const candEnd = candStart + cand.length;
    if (THIRD_PARTY_SAN_RE.test(cand)) continue;
    if (REFERRER_FOLLOW_RE.test(text.slice(candEnd))) continue; // 〇〇さんよりご紹介／〇〇さんとお話
    if (canon && sameName(cand, canon)) continue;
    if (aliases.some((a) => sameName(cand, a))) continue;
    if (allow.some((a) => sameName(cand, a))) continue; // 連名者・保証人など顧客自身が書いた名前
    // ひらがな候補は動詞・助詞断片（「よろしければ」「頂き」等）が混ざりやすいため実名形チェックを追加
    if (/^[ぁ-んゝゞ]+$/.test(cand) && !isPlausiblePersonName(cand)) continue;
    (isAddressPosition(text, candStart, candEnd) ? foreignAddr : foreignOther).add(cand);
  }
  if (foreignAddr.size > 0 || foreignOther.size > 0) {
    const addr = foreignAddr.size > 0;
    const list = [...(addr ? foreignAddr : foreignOther)].join(" / ");
    issues.push({
      code: "NAME_MISMATCH", severity: canon ? (addr ? "block" : "warning") : (opts?.isAutoSend ? "block" : "warning"), evidence: list,
      message: canon
        ? `確定名「${canon}さん」以外の${addr ? "呼びかけ" : "名前"}（${list}）があります${addr ? "" : "（呼びかけ位置ではないため確認のみ）"}`
        : `お客様名が不明の会話で名前（${list}）を書いています`,
      suggestion: canon ? `呼びかけは「${canon}さん」に統一` : "呼びかけを削除し名前なしで返信",
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

// ─── 2026-09-11 竹内方針3（統合設計 §2 方針3）: 呼び名は「その会話でスタッフが直近に呼んだ名前」を1つだけ決める ─────
//   生成（greeting・nameNote・fillNameSlot・pair）・後処理（別名の統一）・検査（checkNameConsistency）・check-reply が同じ verdict を見る。
//   実測: 直近スタッフ呼び名の的中 338/340（現行の生成経路 358/375・表示名 313/366）。直近20件の窓と全履歴で差は無い。
//   途中で変えない: スタッフの呼び履歴がある時は顧客の名乗りで切り替えない（名乗った名前は aliases に入れて block しない）。

/** LINE表示名・DB名を「分割」して呼び名を取る（記号で結合しない）。
 *  Hayato.I→Hayato ／ H!tom!.M・H0N0KA.→""（語中に記号・数字）／ 愛 乃→愛乃（1字漢字・かなの分かち書きは結合）／ 見木 響夢→見木。
 *  「ちゃん」は剥がさない（スタッフは 2/2件「りおなちゃんさん」と書いた） */
export function normalizeDisplayName(raw?: string | null): string {
  const s = (typeof (raw ?? "").normalize === "function" ? (raw ?? "").normalize("NFKC") : raw ?? "").trim().replace(/(?:さん|様|さま|サマ|氏)$/, "");
  if (!s) return "";
  const tokens = s.split(/[\s・._()（）…,，、\/／|｜~〜]+/)
    // 語頭・語末の記号・絵文字だけ剥がす（「ゆき♡」→「ゆき」）。語中に残る記号・数字はトークンごと不採用
    .map((t) => t.replace(/^[^ぁ-んゝゞァ-ヴヽヾー々〆一-鿿A-Za-z]+|[^ぁ-んゝゞァ-ヴヽヾー々〆一-鿿A-Za-z]+$/g, ""))
    .filter(Boolean);
  if (tokens.length === 0) return "";
  const ok = (t: string) => !/[^ぁ-んゝゞァ-ヴヽヾー々〆一-鿿A-Za-z]/.test(t) && !GENERIC_NICKNAMES.has(t) && !PLACEHOLDER_NAME_CORE_RE.test(t) && isPlausiblePersonName(t);
  if (tokens.length >= 2 && (tokens.every((t) => /^[一-鿿々]$/.test(t)) || tokens.every((t) => /^[ぁ-んゝゞァ-ヴヽヾー]+$/.test(t)))) {
    const j = tokens.join("");
    return ok(j) ? j : "";
  }
  for (const t of tokens) if (ok(t)) return t;
  return "";
}

export type AddressNameSource = "staff_greeting_head" | "staff_inline" | "staff_original_locked" | "customer_self_intro" | "pc_name" | "display" | "none";
export type AddressNameVerdict = { name: string; source: AddressNameSource; evidence: string; at: string | null; aliases: string[] };
/** isAix / is_aix_generated: AIX 生成の送信（2026-09-12 竹内方針C: 人間スタッフの呼び名を優先するために使う。無ければ人間扱い） */
export type AddrMsg = { sender: string; text?: string | null; createdAt?: string | null; created_at?: string | null; isAix?: boolean | null; is_aix_generated?: boolean | null };

const ADDR_NAME_SRC = "([ぁ-んゝゞ]{2,8}|[ァ-ヴヽヾー]{2,8}|[一-鿿々]{1,4}|[A-Za-z]{2,12})";
const ADDR_NON_NAME_RE = /(お客様|オーナー|大家|管理|業者|保証|担当|スタッフ|弊社|不動産|審査|通過|契約|入居|退去|申込|内覧|皆|各位|こちら|まずは|引き続き|何卒|改めて|よろし|宜し|もしよ|できれば|出来れば|ぜひ|是非|ご家族|お母|お父|旦那|奥様|婚約者|パートナー)/;
const addrHeadRe = () => new RegExp(`^[ \\t　「]*${ADDR_NAME_SRC}(?:さん|様|さま)(?=${ADDRESS_HEAD_FOLLOW_SRC})`, "gm");
const addrCollocRe = () => new RegExp(`(?:^|[\\s、。！!「（(])${ADDR_NAME_SRC}(?:さん|様|さま)(?=${ADDRESS_COLLOCATION_SRC})`, "gm");
/** 顧客の名乗り（「李維（リー・ウェイ）と申します」「名前は、竹田と申します」） */
const SELF_INTRO_RE = /(?:^|[\s、。！!のは])([一-鿿々]{1,4}|[ぁ-んゝゞ]{2,6}|[ァ-ヴヽヾー]{2,8}|[A-Za-z]{2,12})(?:\s*[（(][^）)\n]{0,20}[）)])?\s*(?:と申します|といいます|と言います)/;

function validAddrName(n: string): boolean {
  if (!n || ADDR_NON_NAME_RE.test(n) || THIRD_PARTY_SAN_RE.test(n) || GENERIC_NICKNAMES.has(n) || PLACEHOLDER_NAME_CORE_RE.test(n)) return false;
  return isPlausiblePersonName(n);
}
/** スタッフ1通から呼びかけ位置の名前（行頭挨拶 → 強いつながり の順）を取る */
function staffAddressNames(text: string): Array<{ name: string; kind: "head" | "inline"; evidence: string }> {
  const out: Array<{ name: string; kind: "head" | "inline"; evidence: string }> = [];
  for (const m of text.matchAll(addrHeadRe())) if (validAddrName(m[1])) out.push({ name: m[1], kind: "head", evidence: m[0].trim().slice(0, 30) });
  for (const m of text.matchAll(addrCollocRe())) if (validAddrName(m[1])) out.push({ name: m[1], kind: "inline", evidence: m[0].trim().slice(0, 30) });
  return out;
}

// ─── 2026-09-12 竹内方針C: 名前の開示（名乗り・申込フォーマット・本人確認書類）──────────────────────
//   実測: 開示の直後にスタッフが一時的に開示名へ切り替えた会話が3つ・計15通あり、3会話とも元の名前に戻っている
//   （yt→竹田×7→yt／まりあ→宮下×5→まりあ／Noriyuki→江籠×3→Noriyuki）。申込フォーマット受領後もスタッフの呼び名は 9/9 行が元のまま。
//   開示名は「呼び名に採用しない」。スタッフが開示名へ一時的に切り替えたことを見分けるためだけに使う（清水さんの会話ではフォーマットの氏名は同居の別人）。
//   「〇〇です」は使わない（一致33件のほぼ全部が「大丈夫です／了解です」の誤検出）
/** 申込フォーマットの申込者欄（【お申込者様記入欄】〜次の【】まで）。緊急連絡先欄・連帯保証人欄・同居人欄は対象外 */
const APPLICANT_SECTION_RE = /【?お?申込者様?記入欄】?([\s\S]*?)(?=【|$)/;
/** 申込者欄の最初の「氏名」の値（同じ行・または次の行）。「・氏名、フリガナ 宮下 真尋 ミヤシタ マヒロ」「・氏名\n　タケダ　ヨリマサ」 */
const FORM_NAME_RE = /氏名(?:[、,，]?[ \t　]*(?:フリガナ|ふりがな))?[ \t　]*[:：]?[ \t　]*(?:\n[ \t　]*)?([^\n]+)/;
/** 本人確認書類の OCR（「[画像] 氏名：江龍　紀幸 … 運転免許証」「氏名 松尾 ひとみ … 個人番号カード」） */
const ID_DOC_RE = /運転免許証|個人番号|マイナンバー|在留カード|保険証|被保険者/;
const ID_NAME_RE = /(?:^|\n|\])[ \t　]*氏名[ \t　]*[:：]?[ \t　]*([^\n]+)/;
const NON_PERSON_FORM_VALUE_RE = /株式会社|有限会社|合同会社|法人|会社|フリガナ|生年月日|なし|無し/;

type Disclosure = { full: string; parts: string[]; idx: number; kind: "self_intro" | "form" | "id_doc" };

/** 氏名欄の値から名前のトークン（漢字・かな・英字の連続）を取る。「江籠 紀幸(エゴ ノリユキ)」→ full=江籠紀幸 parts=[江籠, 紀幸] */
function parseDisclosedName(raw: string): { full: string; parts: string[] } | null {
  const v = (typeof raw.normalize === "function" ? raw.normalize("NFKC") : raw).replace(/[（(][^）)]*[）)]?/g, " ").trim();
  if (!v || NON_PERSON_FORM_VALUE_RE.test(v)) return null;
  const tokens = v.split(/[\s、,，・]+/).filter((t) => /^(?:[一-鿿々]+|[ぁ-んゝゞ]+|[ァ-ヴヽヾー]+|[A-Za-z]+|[一-鿿々]+[ぁ-んゝゞ]+)$/.test(t));
  if (!tokens.length) return null;
  // 先頭と同じ文字種のトークンを2つまで（漢字の氏名の後ろに続くフリガナは別の読みなので含めない）
  const script = (t: string) => (/^[ァ-ヴヽヾー]+$/.test(t) ? "kata" : /^[A-Za-z]+$/.test(t) ? "latin" : "jp");
  const head = tokens.filter((t, i) => i < 2 && script(t) === script(tokens[0]));
  const full = head.join("");
  if (full.length < 2 || full.length > 12) return null;
  return { full, parts: head };
}

/** 顧客メッセージから名前の開示を集める（古い順・メッセージ index 付き） */
function collectDisclosures(msgs: AddrMsg[]): Disclosure[] {
  const out: Disclosure[] = [];
  msgs.forEach((m, idx) => {
    if (m.sender !== "customer" || !m.text) return;
    const s = SELF_INTRO_RE.exec(m.text);
    if (s) {
      const n = s[1].replace(/^(?:私|わたし|僕|自分)/, "");
      if (validAddrName(n)) out.push({ full: n, parts: [n], idx, kind: "self_intro" });
    }
    const sec = APPLICANT_SECTION_RE.exec(m.text);
    if (sec) {
      const f = FORM_NAME_RE.exec(sec[1]);
      const p = f ? parseDisclosedName(f[1]) : null;
      if (p) out.push({ ...p, idx, kind: "form" });
    } else if (ID_DOC_RE.test(m.text)) {
      const f = ID_NAME_RE.exec(m.text);
      const p = f ? parseDisclosedName(f[1]) : null;
      if (p) out.push({ ...p, idx, kind: "id_doc" });
    }
  });
  return out;
}
const disclosureMatches = (name: string, d: Disclosure) => sameName(name, d.full) || d.parts.some((p) => sameName(name, p));

// ローマ字表記と仮名表記の同一視（Hitomi＝ひとみ は「別の名前」ではない＝表記替えは元の名前の固定の対象外）
const KANA_ROMA: Record<string, string> = {
  あ: "a", い: "i", う: "u", え: "e", お: "o", か: "ka", き: "ki", く: "ku", け: "ke", こ: "ko", が: "ga", ぎ: "gi", ぐ: "gu", げ: "ge", ご: "go",
  さ: "sa", し: "si", す: "su", せ: "se", そ: "so", ざ: "za", じ: "zi", ず: "zu", ぜ: "ze", ぞ: "zo", た: "ta", ち: "ti", つ: "tu", て: "te", と: "to",
  だ: "da", ぢ: "zi", づ: "zu", で: "de", ど: "do", な: "na", に: "ni", ぬ: "nu", ね: "ne", の: "no", は: "ha", ひ: "hi", ふ: "hu", へ: "he", ほ: "ho",
  ば: "ba", び: "bi", ぶ: "bu", べ: "be", ぼ: "bo", ぱ: "pa", ぴ: "pi", ぷ: "pu", ぺ: "pe", ぽ: "po", ま: "ma", み: "mi", む: "mu", め: "me", も: "mo",
  や: "ya", ゆ: "yu", よ: "yo", ら: "ra", り: "ri", る: "ru", れ: "re", ろ: "ro", わ: "wa", を: "o", ん: "n", ぁ: "a", ぃ: "i", ぅ: "u", ぇ: "e", ぉ: "o",
};
/** 訓令式寄りに正規化したローマ字（ヘボン式・長音の揺れを畳む） */
function normRoma(s: string): string {
  return s.toLowerCase().replace(/shi/g, "si").replace(/chi/g, "ti").replace(/tsu/g, "tu").replace(/fu/g, "hu").replace(/ji/g, "zi")
    .replace(/sh/g, "sy").replace(/ch/g, "ty").replace(/j/g, "zy").replace(/m(?=[bp])/g, "n")
    .replace(/ou|oo|oh(?![aiueo])/g, "o").replace(/uu/g, "u").replace(/nn/g, "n");
}
function kanaToRoma(kana: string): string | null {
  const h = toHira(kana);
  let out = "";
  let sokuon = false;
  for (const c of h) {
    if (c === "っ") { sokuon = true; continue; }
    if (c === "ー") continue;
    if (c === "ゃ" || c === "ゅ" || c === "ょ") {
      const v = c === "ゃ" ? "a" : c === "ゅ" ? "u" : "o";
      if (!out.endsWith("i")) return null;
      out = out.slice(0, -1) + "y" + v; // き+ゃ=kya／し+ゃ=sya（sha を normRoma で sya に畳む）
      continue;
    }
    const r = KANA_ROMA[c];
    if (!r) return null;
    out += sokuon ? r[0] + r : r;
    sokuon = false;
  }
  return out;
}
/** 同じ名前の表記違い（ローマ字⇔仮名）か */
export function sameReading(a: string, b: string): boolean {
  const latin = /^[A-Za-z]+$/;
  const kana = /^[ぁ-んゝゞァ-ヴヽヾー]+$/;
  const [l, k] = latin.test(a) && kana.test(b) ? [a, b] : latin.test(b) && kana.test(a) ? [b, a] : [null, null];
  if (!l || !k) return false;
  const r = kanaToRoma(k);
  return !!r && normRoma(r) === normRoma(l);
}

/** 呼び名の唯一の決定。messages は古い順（sender='staff'|'customer'）。優先: ①直近スタッフ送信の行頭呼びかけ ②強いつながり
 *  ③スタッフの呼び履歴が無い時だけ顧客の名乗り ④DB名（property_customers）⑤表示名 ⑥""（名前を出さない）。
 *  2026-09-12 竹内方針C: ①②は人間スタッフの呼びかけを AIX より優先する（AIX の呼びかけは人間の呼び履歴が無い時だけ）。
 *  さらに「元の名前の固定」: 最新の呼び名が開示名（名乗り・申込フォーマット・本人確認書類）と同じで、スタッフがその名前を初めて使ったのが
 *  開示より後で、開示の前は別の名前で呼んでいた → 開示の前に最後に使っていた名前を採る（source=staff_original_locked）。
 *  開示名と一時的に使った名前は aliases に入る（unifyAddressAliases が元の名前に戻し、checkNameConsistency は block しない） */
export function resolveAddressName(input: { messages: AddrMsg[]; displayName?: string | null; pcName?: string | null }): AddressNameVerdict {
  const msgs = input.messages ?? [];
  const aliases = new Set<string>();
  type StaffAddr = { name: string; kind: "head" | "inline"; evidence: string; at: string | null; idx: number; isAix: boolean };
  const staffAddrs: StaffAddr[] = [];
  msgs.forEach((m, idx) => {
    if (m.sender !== "staff" || !m.text) return;
    const found = staffAddressNames(m.text);
    // 1通の中は行頭の呼びかけを先に（最新の1通から採る時に head が優先される）
    const ordered = [...found.filter((x) => x.kind === "inline"), ...found.filter((x) => x.kind === "head")];
    for (const f of ordered) {
      aliases.add(f.name);
      staffAddrs.push({ ...f, at: m.createdAt ?? m.created_at ?? null, idx, isAix: !!(m.isAix ?? m.is_aix_generated) });
    }
  });
  const human = staffAddrs.filter((a) => !a.isAix);
  const pool = human.length ? human : staffAddrs;
  let staffPick: StaffAddr | null = pool.length ? pool[pool.length - 1] : null;
  let locked = false;
  if (staffPick) {
    const pick = staffPick;
    const disclosures = collectDisclosures(msgs);
    const d = disclosures.find((x) => disclosureMatches(pick.name, x));
    const firstUse = pool.find((a) => sameName(a.name, pick.name));
    if (d && firstUse && firstUse.idx > d.idx) {
      const prior = [...pool].reverse().find((a) => a.idx < d.idx);
      if (prior && !sameName(prior.name, pick.name) && !sameReading(prior.name, pick.name)) {
        staffPick = prior;
        locked = true;
        for (const x of disclosures) if (disclosureMatches(pick.name, x)) { aliases.add(x.full); for (const p of x.parts) if (validAddrName(p)) aliases.add(p); }
      }
    }
  }
  let selfIntro: { name: string; evidence: string; at: string | null } | null = null;
  for (let i = msgs.length - 1; i >= 0 && !selfIntro; i--) {
    const m = msgs[i];
    if (m.sender !== "customer" || !m.text) continue;
    const s = SELF_INTRO_RE.exec(m.text);
    if (s) {
      const n = s[1].replace(/^(?:私|わたし|僕|自分)/, "");
      if (validAddrName(n)) selfIntro = { name: n, evidence: s[0].trim().slice(0, 30), at: m.createdAt ?? m.created_at ?? null };
    }
  }
  if (selfIntro) aliases.add(selfIntro.name);
  const pc = normalizeDisplayName(input.pcName);
  const disp = normalizeDisplayName(input.displayName);
  for (const raw of [input.pcName, input.displayName]) {
    for (const t of (raw ?? "").normalize("NFKC").split(/[\s・._()（）…,，、\/／]+/)) {
      const tt = t.trim();
      if (tt && validAddrName(tt)) aliases.add(tt);
    }
  }
  if (pc) aliases.add(pc);
  if (disp) aliases.add(disp);
  let v: AddressNameVerdict;
  if (staffPick) v = { name: staffPick.name, source: locked ? "staff_original_locked" : staffPick.kind === "head" ? "staff_greeting_head" : "staff_inline", evidence: staffPick.evidence, at: staffPick.at, aliases: [] };
  else if (selfIntro) v = { name: selfIntro.name, source: "customer_self_intro", evidence: selfIntro.evidence, at: selfIntro.at, aliases: [] };
  else if (pc) v = { name: pc, source: "pc_name", evidence: input.pcName ?? "", at: null, aliases: [] };
  else if (disp) v = { name: disp, source: "display", evidence: input.displayName ?? "", at: null, aliases: [] };
  else v = { name: "", source: "none", evidence: "", at: null, aliases: [] };
  v.aliases = [...aliases].filter((a) => a !== v.name);
  return v;
}

/** 呼びかけ位置の別名（aliases）を確定名へ決定論で置換する（NAME_ALIAS_UNIFIED）。修正ループで別名が戻っても同じ関数で直す */
export function unifyAddressAliases(text: string, canonRaw: string | null | undefined, aliases: string[] | undefined): { text: string; fixes: string[] } {
  const canon = canonOf(canonRaw);
  const fixes: string[] = [];
  if (!canon || !aliases?.length) return { text, fixes };
  let out = text;
  for (const a of aliases) {
    if (!a || a === canon || a.length < 1) continue;
    const esc = escapeRegExp(a);
    const head = new RegExp(`(^|\\n)([ \\t　「]*)${esc}(?:さん|様|さま)(?=${ADDRESS_HEAD_FOLLOW_SRC})`, "g");
    const colloc = new RegExp(`(^|[\\s、。！!「（(])${esc}(?:さん|様|さま)(?=${ADDRESS_COLLOCATION_SRC})`, "g");
    const before = out;
    out = out.replace(head, (_m, br: string, lead: string) => `${br}${lead}${canon}さん`)
      .replace(colloc, (_m, pre: string) => `${pre}${canon}さん`);
    if (out !== before) fixes.push(`NAME_ALIAS_UNIFIED:${a}さん→${canon}さん`);
  }
  return { text: out, fixes };
}

/** 2026-09-11 竹内方針1・3・4・5（統合設計 §1）: 後処理の決定論修正の唯一の入口。
 *  ①別名の統一 → ②承知→かしこまりました・すぐに除去 → ③誤字の自動修正 → ④名前スロット。
 *  validateAndClean の末尾（ゲートの後）と final-check の修正版の2か所で同じ関数を通す（ゲートで生じる「域から域から」も消える） */
export function applySurfaceFixes(
  text: string,
  opts?: { customerName?: string | null; aliases?: string[]; now?: number; /** 〇〇さん／{name} を確定名で埋めるか（テンプレート最適化は false） */ fillName?: boolean },
): { text: string; applied: string[] } {
  const applied: string[] = [];
  let out = text;
  const u = unifyAddressAliases(out, opts?.customerName, opts?.aliases);
  if (u.fixes.length) { out = u.text; applied.push(...u.fixes); }
  const b = normalizeBannedPhrasing(out);
  if (b.shochi || b.hasty || b.uketamawari) {
    out = b.text;
    if (b.shochi) applied.push(`SHOCHI_TO_KASHIKOMARI×${b.shochi}`);
    if (b.hasty) applied.push(`HASTY_ADVERB_REMOVED×${b.hasty}`);
    if (b.uketamawari) applied.push(`BARE_UKETAMAWARI_TO_KASHIKOMARI×${b.uketamawari}`); // 2026-09-12 竹内方針B
  }
  const t = applyTypoAutoFix(out, { customerName: canonOf(opts?.customerName), now: opts?.now });
  if (t.applied.length) {
    out = t.text; applied.push(...t.applied);
    // 誤字の修正（「翔太さんさん」→「翔太さん」）で呼びかけの形が整った別名を、もう一度だけ統一する
    const u2 = unifyAddressAliases(out, opts?.customerName, opts?.aliases);
    if (u2.fixes.length) { out = u2.text; applied.push(...u2.fixes); }
  }
  if (opts?.fillName !== false && /[〇○]{2,}\s*(?:さん|様|さま)|\{name\}/.test(out)) {
    const filled = fillNameSlot(out, canonOf(opts?.customerName));
    if (filled !== out) { out = filled; applied.push("NAME_SLOT_FILLED"); }
  }
  return { text: out, applied };
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
  /** 2026-09-12 竹内方針A-3: 一致しても断言ではない形（時間枠の「空いて」・キャンセルの「トラブル」等）。true なら次の一致を探す */
  exclude?: (text: string, m: RegExpMatchArray) => boolean;
};

/** ASSERTION_BAN_RULES の一致判定（後処理置換 AIX_GATE_RULES と final-check runAssertionBanChecks が同じ関数を使う）。
 *  exclude に当たる一致は飛ばし、断言として扱う最初の一致を返す */
export function findAssertionMatch(rule: AssertionBanRule, text: string): RegExpMatchArray | null {
  const g = new RegExp(rule.re.source, rule.re.flags.includes("g") ? rule.re.flags : rule.re.flags + "g");
  for (const m of text.matchAll(g)) {
    if (rule.exclude?.(text, m)) continue;
    return m;
  }
  return null;
}

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
    replacement: ASSERTION_REPLACEMENT.DISCLOSURE_ASSERTION,
    msg: "告知事項（事故・トラブル・心理的瑕疵・騒音）の「なし」断言は管理会社確認前は禁止（宅建業法47条 不告知リスク）",
    sug: "「告知事項につきましては管理会社に確認の上お伝えさせて頂きます」に変更",
    // A-3（99482059）: 仮押さえのキャンセル手続きの「先方様とのトラブルは一切ございません」は告知事項ではない
    exclude: (text, m) => {
      const pre = text.slice(Math.max(0, (m.index ?? 0) - 25), m.index ?? 0);
      return /先方|キャンセル|ご?契約/.test(pre) && !/告知|事故|心理的|騒音|近隣/.test(m[0]);
    },
  },
  {
    // 「現在空室です」「募集中となっております」「空いております」「埋まってしまいました」「空室確認しました」「申込が入っています」
    // 未来形・条件形・疑問形（空室状況を確認します／空室でしたら／空室ですか／募集中か確認）は構造的に不一致
    code: "VACANCY_ASSERTION",
    re: /(?:(?:空室|募集中|満室|空き(?:あり|部屋)|入居中|退去(?:予定|済み)|ご案内可能な状態|お申込み可能な状態)(?:です|でございます|で御座います|でした|となって(?:おり|い)ます|になって(?:おり|い)ます|となります|とのこと|との回答|(?:を|と)?確認(?:しました|いたしました|致しました|できました|出来ました|が取れました)|と伺|と聞い)|空いて(?:います|おります|ございます|いました|おりました)|埋まって(?:います|おります|いました|おりました|しまいました|しまっており)|募集(?:は)?(?:終了|停止)(?:し(?:ました|ており|ています)|です|となって|となりました)|お?申(?:し)?込(?:み)?が入って(?:います|おります|いました|しまい))(?![かがらば])/,
    staffConfirmedRe: new RegExp(`(?:空室|空き|募集|満室|埋まっ|申込|入居中|退去)[^\\n]{0,30}${MGMT_CONFIRMED_TAIL}|${MGMT_CONFIRMED_TAIL}[^\\n]{0,30}(?:空室|空き|募集|満室|埋まっ|入居中|退去)`),
    sourceRe: /空室|空き|募集|満室|入居中|退去|埋まっ/,
    exemptOnAixVacancyDone: true,
    replacement: ASSERTION_REPLACEMENT.VACANCY_ASSERTION,
    msg: "空室・募集状況の断言は管理会社確認（AIX【物件確認した】）前は禁止",
    sug: "「最新の空き状況を確認しご連絡させて頂きます」に変更（確認結果はAIX【物件確認した】から送る）",
    // A-3（82e2d5cf）: 「17:45～18:45のお時間のみ空いております」は内覧枠の話（空室の断言ではない）。判定は scene-patterns と共有
    exclude: (text, m) => /^空いて/.test(m[0]) && isScheduleSlotVacancy(text, m.index ?? 0),
  },
  {
    // 「9月1日からご入居いただけます」「10月上旬より入居可能」「来月から入居できます」「退去日は9/30」「鍵のお渡しは10/1」
    // 「10月からご入居ご希望」「入居可能でしょうか」「入居可能な物件をピックアップ」「10月中にご入居いただけるお部屋」は lookahead で除外
    code: "MOVEIN_DATE_ASSERTION",
    re: /(?:(?:[0-9０-９]{1,2}\s*[\/／月]\s*[0-9０-９]{1,2}\s*日?|[0-9０-９]{1,2}\s*月(?:上旬|中旬|下旬|末|初旬|頭)?|来月|今月|翌月|再来月|来週|今週|即日|即|明日|明後日|すぐに?)(?:から|より|以降|に|には|中に|末に|頃|ごろ)?[^\n。！!？?]{0,10}?(?:ご?入居(?:可能|いただけ|頂け|できます|出来ます|OK|オッケー|となります|になります)|お引(?:っ)?越し(?:いただけ|頂け|可能|できます|出来ます)|お住まい(?:いただけ|頂け)|(?:鍵|お鍵)(?:の)?お渡し|お渡し(?:可能|できます|出来ます))(?!でしょうか|ですか|か|る|よう|ますよう|ご希望|希望|な(?:お部屋|物件)|の物件|[・、][^\n。！!]{0,40}(?:お部屋|物件)[^\n。！!]{0,15}(?:ピックアップ|お探し|探させ))|退去(?:日|予定日|予定)(?:は|が)?\s*[0-9０-９]{1,2}\s*[\/／月])/,
    staffConfirmedRe: new RegExp(`(?:入居|退去|引(?:っ)?越し|鍵)[^\\n]{0,30}${MGMT_CONFIRMED_TAIL}|${MGMT_CONFIRMED_TAIL}[^\\n]{0,30}(?:入居|退去|引(?:っ)?越し|鍵)|(?:[0-9０-９]{1,2}\\s*[\\/／月]\\s*[0-9０-９]{1,2}|[0-9０-９]{1,2}\\s*月)[^\\n]{0,12}(?:入居|退去|お渡し)`),
    sourceRe: /入居|退去|引(?:っ)?越し|鍵/,
    exemptOnAixVacancyDone: true,
    // A-3（c31f7082）: 「即入居可能・初期費用を…お部屋をピックアップ」（条件の並び）は re の lookahead で除外
    replacement: ASSERTION_REPLACEMENT.MOVEIN_DATE_ASSERTION,
    msg: "入居可能日・退去日の具体日付の断言は管理会社確認前は禁止（AIX_BOUNDARY_MOVEIN の決定論版）",
    sug: "「ご入居可能日につきましては管理会社に空き状況を確認しご連絡させて頂きます」に変更",
  },
  {
    // 「審査は問題ございません」「審査は大丈夫です」「審査は通るかと思います」「必ず審査に通ります」「審査についてはご安心ください」
    // 「審査に通りやすいよう最大限サポート」「審査面も全力でサポートしますのでご安心ください（12字超）」は不一致
    code: "SCREENING_ASSURANCE",
    re: /審査[^\n。！!？?]{0,12}(?:問題(?:ございません|ありません|御座いません|ない(?:です|かと|と思))|大丈夫(?:です|かと|だと|でしょう)|通(?:ります|る(?:かと|と思|はず|でしょう)|りやすい(?:です|かと|と思)|過(?:します|する(?:かと|と思|はず)|できます|出来ます))(?!よう|様|と[、,]?)|心配(?:ございません|ありません|いりません|不要|ご無用|ない)|(?:ご)?安心(?:ください|下さい|してください|頂け|いただけ))|(?:必ず|確実に|絶対(?:に)?|間違いなく|100[%％])[^\n。！!？?]{0,8}(?:審査|承認|通(?:り|し|過)|ご入居(?:いただけ|頂け|できます))/,
    staffConfirmedRe: /審査[^\n]{0,20}(?:承認|通過|可決|OK|通りました|結果(?:が出|は|:|：))/,
    sourceRe: /審査/,
    exemptOnAixVacancyDone: false,
    // A-3（7c80b31b・7a7c74f5・24e89bc5）: 願望形「審査通りますようサポート」・条件形「〜通過しますと」は re の lookahead で除外
    replacement: ASSERTION_REPLACEMENT.SCREENING_ASSURANCE,
    msg: "根拠のない審査安心断言は禁止（審査主体は保証会社・管理会社。結果は審査次第）",
    sug: "「審査結果につきましては保証会社の審査次第となります」に変更",
  },
];

/** ゲートの判定に使う文脈（顧客条件の復唱免除に使う） */
type GateOpts = { customerMessage?: string; lastStaffMsg?: string; customerConditions?: string };
// ─── 2026-09-11 統合設計（経路F2・楓馬/YUYA 事例）: 顧客条件の復唱は「見積金額内訳」ゲートの対象外 ───
//   旧実装は「家賃」「管理費」「共益費」と「N万円」が同じ文にあるだけで見積内訳とみなし、
//   「家賃9万円〜13万円・2LDK…でピックアップ」を見積作成宣言／「確認しご連絡」に置換していた（PAIR_ELEMENT_MISSING・CONFIRM_NO_OBJECT を誘発）。
//   条件＝範囲または上限の表記で、数字が顧客文・DB 条件・直前スタッフ文に実在し、費用内訳語（敷金・礼金・初期費用…）を含まない文
const RANGE_OR_CAP_RE = /[0-9０-９.．]+\s*万?(?:円)?\s*[〜~～ー-]\s*[0-9０-９.．]+\s*万|[0-9０-９.．]+\s*万(?:円)?\s*(?:以内|以下|前後|まで|程度)/;
const COST_WORD_RE = /初期費用|敷金|礼金|仲介手数料|保証料|鍵交換|火災保険|前家賃|日割|御見積|お見積|見積|合計|総額|内訳|割引|スモ割|節約/;
const toHalfNum = (t: string) => t.replace(/[０-９．]/g, (d) => String.fromCharCode(d.charCodeAt(0) - 0xfee0));
export function isCustomerConditionEcho(s: string, o?: GateOpts): boolean {
  if (COST_WORD_RE.test(s) || !RANGE_OR_CAP_RE.test(s)) return false;
  const src = toHalfNum(`${o?.customerMessage ?? ""}\n${o?.customerConditions ?? ""}\n${o?.lastStaffMsg ?? ""}`);
  const nums = [...toHalfNum(s).matchAll(/[0-9.]+(?=\s*(?:万|[〜~～ー-]))/g)].map((m) => m[0]);
  return nums.length > 0 && nums.every((n) => src.includes(n));
}

const AIX_GATE_RULES: { name: string; test: (s: string, o?: GateOpts) => boolean; replacement: string; promisedReplacement?: string; vacancyDoneReplacement?: string; assertion?: AssertionBanRule }[] = [
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
    test: (s, o) => !isCustomerConditionEcho(s, o) && (
      (/[0-9０-９][0-9０-９,，．.]*\s*(?:万\s*)?円/.test(s) &&
        /(?:初期費用|敷金|礼金|仲介手数料|保証料|鍵交換|火災保険|前?家賃|管理費|共益費|日割|御見積|お見積|見積|合計|総額|内訳|割引|スモ割|節約)/.test(s)) ||
      // 「敷金1ヶ月分」等の月数表記（円なし）も物件固有数値としてブロック
      (/[0-9０-９]+(?:[.．][0-9０-９]+)?\s*[ヶケか]月分?/.test(s) &&
        /(?:敷金|礼金|保証料|前家賃)/.test(s))),
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
    test: (s: string) => findAssertionMatch(r, s) !== null,
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
/** 2026-09-11 統合設計（経路F1）: ピックアップ再宣言ゲートの対象から常に外す文。
 *  「出来次第お送り」「出来ましたらお送り」＝既存約束の履行形（スタッフの実際の正解返信もこの形）、「全力でサポート」「見つかるまで」＝締め */
const PICKUP_KEEP_RE = /(?:出来|でき)(?:次第|ましたら)[^\n]{0,12}お送り|全力で(?:お部屋探し)?サポート|見つかるまで/;
/** 挨拶行（開口語の挿入位置を決める時に飛ばす行） */
const GREETING_LINE_RE = /お世話になっております|はじめまして|初めまして|夜遅くに失礼|ご連絡遅くなり/;

/** 後処理ゲートが本文を削除・置換した記録（tpo_debug.postprocess と GATE_PAIR_CONFLICT の安全弁が参照） */
export type GateEdit = { rule: string; before: string; after: string | null; reversible: boolean };

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
    // AIX【物件ピックアップした】で物件送付済み（generate-reply の aixDone.propertySend＝resolvePickupGate 整合後）。
    aixPickupDone?: boolean;
    /** 2026-09-11 統合設計（経路F）: 削除してはいけない文（isCellRequiredSentence＝選ばれたセルの必須要素／未履行約束の復唱）。route が渡す */
    protect?: (sentence: string) => boolean;
    /** 顧客の DB 条件（見積金額内訳ゲートの「顧客条件の復唱」免除に使う） */
    customerConditions?: string;
  },
): { cleaned: string; violations: string[]; edits: GateEdit[] } {
  const violations: string[] = [];
  const edits: GateEdit[] = [];
  const usedReplacement = new Set<string>();
  // 削除系ゲートの置換文「かしこまりました😊！！」は削除位置に入れず、ループ後に本文先頭（挨拶行の直後）へ1回だけ入れる
  //   （旧実装は削除位置＝末尾に入れて EMPTY_CLOSER の block をゲート自身が作っていた: it_0 事例）
  let needAck = false;
  const gateOpts: GateOpts = { customerMessage: opts?.customerMessage, lastStaffMsg: opts?.lastStaffMsg, customerConditions: opts?.customerConditions };
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
      // 見積書作成宣言の繰り返し（約束済みの場合のみ削除。受付文は本文先頭に1回だけ入れる）
      if (opts?.estimatePromised && estimateDeclarationRe.test(s)) {
        violations.push(`見積作成宣言の繰り返し: ${s.trim().slice(0, 40)}`);
        edits.push({ rule: "見積作成宣言の繰り返し", before: s, after: null, reversible: false });
        needAck = true;
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
        edits.push({ rule: "空室確認の再宣言", before: s, after: null, reversible: false });
        needAck = true;
        continue;
      }
      // 2026-09-11 統合設計（経路F1）: 履行約束の復唱・締め（PICKUP_KEEP_RE）と、選ばれたセルの必須要素／未履行約束の復唱（protect）は削除しない
      if (opts?.aixPickupDone && PICKUP_REDECLARE_RE.test(s) && !PICKUP_KEEP_RE.test(s) && !opts.protect?.(s)) {
        violations.push(`ピックアップ宣言の再宣言(送付済): ${s.trim().slice(0, 40)}`);
        edits.push({ rule: "ピックアップ再宣言", before: s, after: null, reversible: true });
        needAck = true;
        continue;
      }
      const rule = AIX_GATE_RULES.find((r) => {
        if (!r.test(s, gateOpts)) return false;
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
        const rep =
          opts?.aixVacancyDone && rule.vacancyDoneReplacement
            ? rule.vacancyDoneReplacement
            : opts?.estimatePromised && rule.promisedReplacement
              ? rule.promisedReplacement
              : rule.replacement;
        outSentences.push(rep);
        edits.push({ rule: rule.name, before: s, after: rep, reversible: false });
      } else {
        edits.push({ rule: rule.name, before: s, after: null, reversible: false });
      }
    }
    return outSentences.join("");
  });
  // 違反行の除去で生じた3連以上の改行を2連（空行1つ）に圧縮
  let cleaned = violations.length > 0
    ? outLines.join("\n").replace(/\n{3,}/g, "\n\n")
    : text;
  // 削除系ゲートの受付文: 最初の非挨拶行が開口語（かしこまりました／はい）でない時だけ、挨拶行の直後に1回入れる
  if (needAck && !/かしこまりました/.test(cleaned)) {
    const lines = cleaned.split("\n");
    const gi = lines.findIndex((l) => l.trim() && !GREETING_LINE_RE.test(l));
    if (gi >= 0 && !/^はい/.test(lines[gi].trim())) lines.splice(gi, 0, "かしこまりました😊！！");
    else if (gi < 0) lines.push("かしこまりました😊！！");
    cleaned = lines.join("\n").replace(/\n{3,}/g, "\n\n");
  }
  return { cleaned, violations, edits };
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
    /** 2026-09-11 統合設計（経路F）: ゲートが削除してはいけない文（isCellRequiredSentence） */
    protect?: (sentence: string) => boolean;
    /** 顧客の DB 条件（見積金額内訳ゲートの顧客条件復唱免除） */
    customerConditions?: string;
    /** 2026-09-11 竹内方針3: resolveAddressName の aliases（呼びかけ位置の別名を確定名に統一する） */
    nameAliases?: string[];
    /** 曜日の自動修正の基準時刻（既定 Date.now()） */
    now?: number;
  },
): { cleaned: string; issues: string[]; gateEdits: GateEdit[] } {
  const issues: string[] = []
  let gateEdits: GateEdit[] = []
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
  // 2026-09-11 統合設計（経路B・🐥事例）: 通常返信（aixGates）では「〇〇さん」「{name}」を確定名で埋める／名前不明なら呼びかけ＋直結助詞ごと削除。
  //   gen1・gen2 の両方を通る唯一の後処理なのでここに置く（旧実装は detectPlaceholders に任せて残し、BANNED_WORD〇〇＋NAME_PLACEHOLDER の
  //   二重 block を LLM 修正でしか消せなかった）。名前以外の 〇〇 スロットは埋めない。テンプレート最適化（aixGates=false）は対象外
  if (opts?.aixGates && /[〇○]{2,}\s*(?:さん|サン|様|さま)|\{name\}/.test(cleaned)) {
    const filled = fillNameSlot(cleaned, canonOf(opts.customerName)); // 2026-09-12 竹内方針C: 確定名を再正規化しない
    if (filled !== cleaned) { issues.push("NAME_SLOT_FILLED"); cleaned = filled; }
  }
  // （旧: さんさん → さん の畳み込みはここにあった。2026-09-11 末尾の applySurfaceFixes（誤字の自動修正）に統合＝ゲート由来の重複も消える）
  // プレースホルダー残存チェック（削除はしない・issuesに追加のみ）
  const placeholders = detectPlaceholders(cleaned);
  if (placeholders.length > 0) issues.push("プレースホルダー残存: " + placeholders.join(" "));
  // 禁止ワード
  const banned = ["コスパ", "少々お待ちください", "共益費込み"]
  banned.forEach(w => { if (cleaned.includes(w)) issues.push("禁止ワード: " + w) })
  // AIXゲート機械検証（opt-in: generate-reply の通常返信ドラフトのみ。テンプレート最適化・パターン生成は対象外）
  if (opts?.aixGates) {
    const { cleaned: gated, violations, edits } = enforceAixGates(cleaned, {
      estimatePromised: opts.estimatePromised,
      customerMessage: opts.customerMessage,
      lastStaffMsg: opts.lastStaffMsg,
      aixVacancyDone: opts.aixVacancyDone,
      aixPickupDone: opts.aixPickupDone,
      protect: opts.protect,
      customerConditions: opts.customerConditions,
    });
    if (violations.length > 0) {
      issues.push(...violations.map(v => "AIXゲート違反(置換済): " + v));
      cleaned = gated;
      gateEdits = edits;
    }
  }
  // 2026-09-11 竹内方針1・3・4・5（統合設計 §1）: 末尾（ゲートの後）で決定論の表層修正（別名の統一・承知→かしこまりました・すぐに除去・誤字）。
  //   gen1・gen2 の両方を通る唯一の後処理。final-check の修正版も同じ applySurfaceFixes を通す
  {
    const sf = applySurfaceFixes(cleaned, { customerName: opts?.customerName, aliases: opts?.nameAliases, now: opts?.now, fillName: !!opts?.aixGates });
    if (sf.applied.length > 0) {
      issues.push(...sf.applied.map((a) => "表層修正: " + a));
      cleaned = sf.text;
    }
  }
  return { cleaned, issues, gateEdits }
}
