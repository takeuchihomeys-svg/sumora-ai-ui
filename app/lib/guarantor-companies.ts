// app/lib/guarantor-companies.ts
// 2026-09-15 竹内（YUYA 事例）「AIX に保証会社についてを作る。物件ごとに物件名・保証会社名（選択・無ければ登録）・種類を5件〜入れて会話を合わせる。
//   並行して審査かけるトグルで、かぶっていない保証会社なら並行審査を勧める」— 純関数・DB 依存なし
//   静的な一覧（名寄せ・種類）はここにハードコード。スタッフが新しく登録した会社名だけ guarantor_companies テーブル（feedback_static_vs_dynamic_db）
//   本文の会社名・種類は入力値だけ（LLM に作らせない。入力に無い会社名は〇〇に伏せて送信前チェックで止める＝cost_breakdown の金額の照合と同じ考え）
// 依存ゼロ（他の app/lib/* を import しない・画面とサーバーの両方から使う）

// ─── 型 ───
// 2026-09-26 竹内さん決定（同日3回目・最新）: 保証会社の種類は**3つ**（独立系・信販系・信用系）＋不明。
//   「全保連は信用系」「エポスは信販系」「LICC系は全部信用系」→ 「LICC系」という種類は無くし、LICC の会社（全保連・ジェイリース）は信用系。K-net も信用系。
//   2026-10-08 竹内さん: 日本賃貸保証・テナントファーストは独立系（日本賃貸保証を信用系にしていたのを直した）
//   経緯（同日に2回取り違えた）: fd989546「スタッフの信用系＝信販系」（誤り）→ 4a3a0e79「4種類（独立系・LICC系・信販系・信用系=K-net）」
//     → 04883e71「LICC系の説明を加盟会社同士で滞納情報を共有に」→ 本変更「LICC系は信用系に統合して3種類」。
//     スタッフの実送信（9/23 86d1e936「全保連（信用系）」「ジェイリース（信用系）」「K-net（信用系）」）もこの3種類の呼び方
//   種類の定義（竹内さんの言葉そのまま・2026-09-26）:
//     信販系「信販系はクレジットカード会社や信販会社が母体となっている　一番厳しい」
//     信用系「信用系は金融系の情報ではなく過去の家賃滞納やトラブルがなかったかみられるばしょ」
//   独立系の説明はスタッフの実送信のまま（下の SCREENING_NOTE）
//   後方互換: DB に保存済みの "licc"・旧画面のチップ／AI の読み取りの「LICC系」「LICC」は信用系として読む（normalizeGuarantorType・parseGuarantorTypeJa）
export type GuarantorType = "independent" | "credit" | "shinyou" | "unknown";
export const GUARANTOR_TYPES: readonly GuarantorType[] = ["independent", "credit", "shinyou", "unknown"];
/**
 * 種類の定義（竹内さんの言葉に沿って短く・プロンプトの一般知識と画面の説明はここから。お客様向けの文はこの定義から外れる言い方を作らない）。
 * independent は竹内さんの定義が無いのでスタッフの実送信の説明（SCREENING_NOTE）に任せ、ここは空。unknown は空＝種類に触れない
 */
export const GUARANTOR_TYPE_DEFINITION: Record<GuarantorType, string> = {
  independent: "",
  credit: "クレジットカード会社や信販会社が母体となっている保証会社。審査は一番厳しい",
  shinyou: "金融系の情報ではなく、過去の家賃滞納やトラブルが無かったかを見る保証会社",
  unknown: "",
};
/** UI の select と台帳の日本語ラベル */
export const GUARANTOR_TYPE_LABELS: Record<GuarantorType, string> = {
  independent: "独立系（審査ゆるめ）",
  credit: "信販系（クレジット審査）",
  shinyou: "信用系（家賃滞納・トラブル歴）",
  unknown: "不明・その他",
};
/** 本文で使う短い呼び名（「〇〇と独立系の保証会社」）。unknown は空＝種類に触れない */
export const GUARANTOR_TYPE_SHORT: Record<GuarantorType, string> = { independent: "独立系", credit: "信販系", shinyou: "信用系", unknown: "" };
/**
 * 種類→審査の説明（スタッフ実文から。LLM に種類から創作させない。unknown は空＝緩い／厳しいに触れない）。
 * shinyou: 竹内さんの定義の言葉だけで書く。審査の緩い・厳しいは書かない（竹内さんの定義に無い）。
 *   LICC の加盟の話は入れない: スタッフの実送信の「LICC」は種類名としての言及だけ（6/16「LICC系と独立系の保証会社中心に」・7/01「クレディセゾン（LICC系）」＝誤り・
 *   8/23 AIX「全保連となりLICC系の保証となります」）で、加盟・情報共有を説明した実送信は無い（2026-09-26 調べ）。
 *   旧 licc の文の「独立系の保証会社に比べると審査基準は上がりますが…審査通過する可能性十分に御座います」も種類ごと無くした（信用系の定義に審査の緩さが無い）
 */
export const GUARANTOR_TYPE_SCREENING_NOTE: Record<GuarantorType, string> = {
  independent: "独立系の保証会社となりますので、審査基準が緩い保証会社となります😊！！",
  credit: "信販系の保証会社となり、クレジット審査となりますので比較的審査厳し目のお部屋となります！！",
  shinyou: "信用系の保証会社となり、金融系の情報ではなく過去の家賃滞納やトラブルが無かったかを見る審査となります！！",
  unknown: "",
};
/**
 * 種類ごとの「許された言い回し」（固定テンプレ buildGuarantorInfoText と、会話を合わせる formatGuarantorFacts の両方がこの1本を使う＝同じ判定を2か所に書かない）。
 * 「・物件名」の行に続く1行（先頭の「の保証会社は」は物件名の行を受ける）
 */
export const GUARANTOR_TYPE_SENTENCE: Record<GuarantorType, (company: string) => string> = {
  independent: (c) => `の保証会社は${c}と${GUARANTOR_TYPE_SCREENING_NOTE.independent}`,
  credit: (c) => `の保証会社は${c}と${GUARANTOR_TYPE_SCREENING_NOTE.credit}`,
  shinyou: (c) => `の保証会社は${c}と${GUARANTOR_TYPE_SCREENING_NOTE.shinyou}`,
  unknown: (c) => `の保証会社は${c}となります！！`,
};
/**
 * 種類の根拠（2026-10-08 竹内「全て何系かも分かるように」「独立系は確認して判断が取れたら言い切って良い・曖昧な場合は入れない」）
 *   takeuchi   = 竹内さんが種類を言った（全保連・エポス・興和アシスト 等）
 *   official   = 公式の情報で確かめた（LICC の正会員の一覧・会社の公式サイトの母体／事業）。source に URL
 *   unverified = 種類の候補はあるが公式の情報で確かめきれない（商品の提携・社名が見つからない 等）
 *   staff_sent = スタッフの実送信の呼び方だけ（スタッフの取り違えがある＝確かではない）
 *   none       = 種類が分からない（type は unknown）
 * 返信・AIX の本文で種類を言い切るのは takeuchi／official の時だけ（guarantorTypeSure）
 */
export type GuarantorTypeBasis = "takeuchi" | "official" | "unverified" | "staff_sent" | "none";
export type GuarantorCompany = { name: string; aliases: readonly string[]; type: GuarantorType; basis?: GuarantorTypeBasis; source?: string };
export type GuarantorProperty = { name: string; company: string; type: GuarantorType };

export function isGuarantorType(v: unknown): v is GuarantorType {
  return typeof v === "string" && (GUARANTOR_TYPES as readonly string[]).includes(v);
}
/**
 * DB・リクエストに入っている種類の値 → GuarantorType（後方互換）。旧の "licc"（2026-09-26 まで保存していた値）は信用系。
 * 読めない値は null（呼び出し側が会社名から resolveGuarantor で決める／unknown にする）
 */
export function normalizeGuarantorType(v: unknown): GuarantorType | null {
  if (isGuarantorType(v)) return v;
  if (typeof v === "string" && v.trim().toLowerCase() === "licc") return "shinyou";
  return null;
}

/** 画像の読み取り（extract-guarantor-info・AIX の mgmt_guarantor）と旧画面が使う日本語の種類名（unknown は「不明」） */
export type GuarantorTypeJa = "独立系" | "信販系" | "信用系" | "不明";
export const GUARANTOR_TYPES_JA: readonly GuarantorTypeJa[] = ["独立系", "信販系", "信用系", "不明"];
export function guarantorTypeJa(t: GuarantorType): GuarantorTypeJa {
  return t === "independent" ? "独立系" : t === "credit" ? "信販系" : t === "shinyou" ? "信用系" : "不明";
}
/**
 * 日本語の種類名 → GuarantorType。「信用系」は信用系（信販系とは別）。
 *   旧の「LICC系」「LICC」（4種類の頃の画面のチップ・AI の読み取り結果）と値 "licc" は信用系に読む（2026-09-26 竹内さん「LICC系は全部信用系」）。
 * 読めない値は null（呼び出し側が会社名から resolveGuarantor で決める）
 */
export function parseGuarantorTypeJa(raw: string | null | undefined): GuarantorType | null {
  const s = (raw ?? "").trim();
  if (!s) return null;
  const v = normalizeGuarantorType(s);
  if (v) return v;
  if (/^独立系/.test(s)) return "independent";
  if (/^LICC/i.test(s)) return "shinyou";
  if (/^信販系/.test(s)) return "credit";
  if (/^信用系/.test(s)) return "shinyou";
  if (/^不明/.test(s)) return "unknown";
  return null;
}

// ─── マスタ（正規名・別名・既定の種類・種類の根拠）───
// 2026-10-08 竹内「保証会社、分からない保証会社あるかも。ちゃんと確認する。全て何系かも分かるように」:
//   資料（売上サポの pdf_text・image_lines／送った画像の読み取り）・スタッフの送信・AIX に出た会社名を全期間で洗い出し（scripts/audit-guarantor-names.ts）、
//   種類を公式の情報で確かめた（出所は source）。種類の決め方（竹内さんの定義の順）:
//     信用系＝LICC（一般社団法人 全国賃貸保証業協会）の正会員（https://jpg.or.jp/member02.html・2026年4月現在の11社）＋竹内さんが言った会社
//     信販系＝クレジットカード会社・信販会社が母体
//     独立系＝そのどちらでもない家賃保証の会社（各社の公式の会社概要で母体を確かめた）
//   basis が takeuchi／official の会社だけ本文で種類を言い切る（guarantorTypeSure）。unverified＝種類の候補はあるが確かでない（言わない）
//   ⚠ 9/26 にスタッフの実送信の呼び方で「独立系」に入れていたエルズサポート・アーク・ニッポンインシュア・ルームバンクインシュアは LICC の正会員＝信用系に直した
//   出現の件数（全期間・資料の行／スタッフの送信）は scripts/.replay-out/guarantor-names.json
const JPG = "https://jpg.or.jp/member02.html";
export const GUARANTOR_COMPANY_MASTER: readonly GuarantorCompany[] = [
  // ── 独立系（公式の会社概要で母体を確かめた・LICC の正会員ではない・信販が母体ではない）──
  { name: "日本セーフティー", aliases: ["日本セーフティ", "日本セーフティ―", "セーフティー", "セーフティ", "JSN"], type: "independent", basis: "official", source: "https://www.nihon-safety.co.jp/company/" },
  { name: "Casa", aliases: ["カーサ", "CASA", "casa"], type: "independent", basis: "official", source: "https://www.casa-inc.co.jp/company/about/" },
  { name: "いえらぶパートナーズ", aliases: ["いえらぶ", "いえらぶ保証", "いえらぶ賃貸保証", "いえるぶ保証"], type: "independent", basis: "official", source: "https://www.ielove-partners.co.jp/company/" },
  { name: "アセス保証", aliases: ["アセス", "アセス信用保証"], type: "independent", basis: "official", source: "https://www.assess-credit.co.jp/company.html" },
  { name: "フォーシーズ", aliases: ["フォーシーズンズ", "4seasons"], type: "independent", basis: "official", source: "https://www.4cs.co.jp/corporate/profile.html" },
  { name: "ハウスリーブ", aliases: [], type: "independent", basis: "official", source: "https://www.house-leave.com/company/" },
  // ナップ賃貸保証は 2021〜2024 年の版では LICC の正会員だった（今の一覧には無い）
  { name: "ナップ", aliases: ["NAP", "ナップ賃貸保証"], type: "independent", basis: "official", source: "https://www.nap-service.com/about/" },
  { name: "JPMC", aliases: ["ジェイピーエムシー", "日本管理センター", "JPMCファイナンス"], type: "independent", basis: "official", source: "https://jpmc-finance.jp/co" },
  { name: "イントラスト", aliases: ["intrust", "イエントラスト"], type: "independent", basis: "official", source: "https://www.entrust-inc.jp/ir/stock.php" },
  // ラクーンレントは 2025-01-01 にイントラストの子会社（プレミアライフ）へ合併
  { name: "ラクーン", aliases: ["ラクーンレント", "raccoon"], type: "independent", basis: "official", source: "https://www.entrust-inc.jp/rr/info/202412261.html" },
  { name: "GTN", aliases: ["ジーティーエヌ", "グローバルトラストネットワークス"], type: "independent", basis: "official", source: "https://www.gtn.co.jp/company" },
  { name: "シノケンコミュニケーションズ", aliases: ["シノケン", "シノケン保証", "シンケンユミュニケーションズ"], type: "independent", basis: "official", source: "https://www.shinoken-cm.com/company/" },
  { name: "ほっと保証", aliases: [], type: "independent", basis: "official", source: "https://www.hothosyou.co.jp/corporate/" },
  // レンポッポは会社名ではなく CAPCO AGENCY の商品「れんぽっぽ」（資料・スタッフはレンポッポと書くので名前は分けて置く・種類は同じ）
  { name: "CAPCO AGENCY", aliases: ["CAPCO", "キャプコエージェンシー"], type: "independent", basis: "official", source: "https://www.capco-agency.co.jp/company/" },
  { name: "レンポッポ", aliases: ["れんぽっぽ"], type: "independent", basis: "official", source: "https://www.capco-agency.co.jp/company/" },
  { name: "オセロ・フィナンシャルサービス", aliases: ["オセロフィナンシャルサービス", "オセロ・ファイナンシャルサービス", "オセロ"], type: "independent", basis: "official", source: "https://www.othello-fs.com/about/" },
  { name: "クレデンス", aliases: [], type: "independent", basis: "official", source: "https://credence-credit.com/company/history" },
  { name: "プレサンスギャランティ", aliases: ["プレサンス", "ブレサンスギャランティ"], type: "independent", basis: "official", source: "https://www.pressance-guarantee.jp/company/" },
  { name: "パナソニックホームズ賃貸サポート", aliases: ["パナソニック ホームズ賃貸サポート"], type: "independent", basis: "official", source: "https://homes.panasonic.com/phrs/company/" },
  { name: "エフアール信用保証", aliases: [], type: "independent", basis: "official", source: "https://www.fr-s.com/company/index.html" },
  { name: "JRAG", aliases: ["日本賃貸住宅保証機構", "IRAG", "JRAQ"], type: "independent", basis: "official", source: "https://www.jrag.co.jp/company/" },
  // 旭化成賃貸サポート・旭化成信用保証サポートの社名は無い（資料の書き方・読み違いとみる）
  { name: "旭化成不動産サポート", aliases: ["旭化成賃貸サポート", "旭化成信用保証サポート"], type: "independent", basis: "official", source: "https://www.afr-web.co.jp/" },
  { name: "エステム保証", aliases: ["エステム保証サービス"], type: "independent", basis: "official", source: "https://www.n-estem.co.jp/hosyo/aboutus.html" },
  { name: "レクストレントプラス", aliases: [], type: "independent", basis: "official", source: "https://rextrentplus.com/companyprofile/" },
  { name: "日本プレミアム保証", aliases: [], type: "independent", basis: "official", source: "https://premium-guarantee.com/company/" },
  // 運営はアークシステムテクノロジーズ（福岡）＝LICC のアーク株式会社（岩手）とは別
  { name: "ピーマスター保証", aliases: ["マスター保証"], type: "independent", basis: "official", source: "https://www.arktech.ne.jp/about.html" },
  // 2026-09-01 USEN TRUST と合併
  { name: "新日本信用保証", aliases: ["USEN TRUST"], type: "independent", basis: "official", source: "https://www.snsh.co.jp/company/" },
  { name: "ホワイト保証", aliases: [], type: "independent", basis: "official", source: "https://whiteguarantee.com/company.html" },
  { name: "PSサポート", aliases: ["PS サポート"], type: "independent", basis: "official", source: "https://www.ps-support.net/profile01.html" },
  { name: "アイシンクレント", aliases: [], type: "independent", basis: "official", source: "https://www.ithinkrent.co.jp/aboutus" },
  { name: "アールエムトラスト", aliases: [], type: "independent", basis: "official", source: "https://www.mlit.go.jp/jutakukentiku/house/jutakukentiku_house_fr7_000028.html" },
  { name: "スマートクレジット", aliases: [], type: "independent", basis: "official", source: "https://www.smartcredit.co.jp/company/" },
  { name: "日本管理サポート", aliases: [], type: "independent", basis: "official", source: "https://www.jms0077.co.jp/company/" },
  { name: "木下グループ保証", aliases: [], type: "independent", basis: "official", source: "https://www.kinoshita-chintai.com/service/kino-plus.html" },
  { name: "大学生協住まいサービス", aliases: ["大学生協住まいサービス保証"], type: "independent", basis: "official", source: "https://www.univcoop-housing.co.jp/outline.html" },
  { name: "リロ家賃サービス", aliases: ["リロ・フィナンシャル・ソリューションズ"], type: "independent", basis: "official", source: "https://www.relo-fs.jp/company/" },
  { name: "レントラスト", aliases: [], type: "independent", basis: "official", source: "https://www.renttrust.jp/html/outline.html" },
  { name: "日本テナント保証", aliases: [], type: "independent", basis: "official", source: "https://www.nihontenant-g.com/" },
  { name: "インシュアランス", aliases: [], type: "independent", basis: "official", source: "https://d-insurance.jp/company/" },
  // ── 種類の候補はあるが確かでない（本文で種類を言わない）──
  // 日本賃貸保証（JID）・テナントファースト: 2026-10-08 竹内さん「日本賃貸保証は独立系／テナントファーストは独立系」（9/26 は日本賃貸保証を信用系にしていた・LICC にいた記録も無い）
  { name: "日本賃貸保証", aliases: ["JID"], type: "independent", basis: "takeuchi", source: "https://www.jid-net.co.jp/company/profile/" },
  { name: "テナントファースト", aliases: ["テナントファスタート"], type: "independent", basis: "takeuchi" },
  // 2026-10-08 竹内さん（根拠＝竹内さん）: sumai保証＝独立系／あんしん保証＝信販系／レジデンシャルパートナーズ＝信販系／日本トラストコーポレーション＝独立系／エイト賃貸保証＝信用系。
  //   LGO・CGO の会員（日本セーフティー・Casa 等）＝独立系（表の独立系の会社はこのまま）。信和CM保証など答えの無い会社は今のまま（種類を言わない）
  // sumai保証（スマサポ）: 会社は独立系だが 2024-01 からエポスカードと保証の業務を一緒に行う（信販寄りとも見られる）
  { name: "sumai保証", aliases: ["Sumai保証", "スマサポ", "Sumai"], type: "independent", basis: "takeuchi", source: "https://www.sumasapo.co.jp/service_warranty.php" },
  // あんしん保証: 会社は独立系・資料の「ライフ安心プラス」はライフカード提携の商品（筆頭株主アイフル＝公式では未確認）
  { name: "あんしん保証", aliases: ["ライフ安心プラス", "ライフあんしんプラス", "ライフアンしんプラス"], type: "credit", basis: "takeuchi", source: "https://www.anshin-gs.co.jp/company/" },
  // レジデンシャルパートナーズ: 東急住宅リース 100%・商品「RPプラスJ」（ジャックス提携）「EPOSプラスRP」（エポス提携）
  { name: "レジデンシャルパートナーズ", aliases: [], type: "credit", basis: "takeuchi", source: "https://www.residential-partners.co.jp/company/" },
  // 信和CM保証: 信和保証（2025年設立）か信和コミュニティ。社名の「CM」は確かめられない
  { name: "信和CM保証", aliases: ["信和保証"], type: "independent", basis: "unverified", source: "https://www.shinwa-hosho.co.jp/company/profile/" },
  // 日本トラストコーポレーション: この社名の保証会社が見つからない（株式会社日本トラスト・有限会社トラスト・コーポレーションの候補）
  { name: "日本トラストコーポレーション", aliases: ["日本トラスト"], type: "independent", basis: "takeuchi" },
  // エイト賃貸保証: 公式サイトが無く母体を確かめられない（2021〜2023 年の版では LICC の正会員）
  { name: "エイト賃貸保証", aliases: ["エイト保証", "エイト"], type: "shinyou", basis: "takeuchi" },
  // ── 信販系（母体がカード会社・信販会社）──
  { name: "エポスカード", aliases: ["エポス", "EPOS", "ROOM iD", "ルームiD"], type: "credit", basis: "takeuchi", source: "https://www.eposcard.co.jp/room_id/companies.html" },
  { name: "オリコフォレントインシュア", aliases: ["オリコ", "オリコフォレント", "ORICO"], type: "credit", basis: "official", source: "https://www.orico-fi.co.jp/profile/company/" },
  { name: "クレディセゾン", aliases: ["セゾン", "SAISON"], type: "credit", basis: "official", source: "https://www.saisoncard.co.jp/rentquick/" },
  { name: "ジャックス", aliases: ["JACCS"], type: "credit", basis: "official", source: "https://www.jaccs.co.jp/business/rent/" },
  { name: "アプラス", aliases: ["APLUS"], type: "credit", basis: "official", source: "https://www.aplus.co.jp/business/service/rent/" },
  // えるく信用保証＝カード会社 株式会社えるく（えるくカード）そのもの
  { name: "えるく", aliases: ["えるく信用保証"], type: "credit", basis: "official", source: "https://www.erc-card.co.jp/smarts/index/67/" },
  // ── 信用系（LICC の正会員＝jpg.or.jp の一覧・竹内さんが言った会社）──
  // 全保連: 竹内さん「全保連は信用系」（2026-10-08 にも確定）。LICC の今の会員の一覧（2026年4月）には無いが竹内さんの決定で信用系（2010〜2024年4月の版にはあった）
  // エルズサポート・アーク・ニッポンインシュア・ルームバンクインシュア: 2026-10-08 竹内さん「信用系にする」（LICC の正会員）
  { name: "全保連", aliases: ["ゼンホレン"], type: "shinyou", basis: "takeuchi", source: "https://www.zenhoren.jp/company/outline.html" },
  { name: "ジェイリース", aliases: ["Jリース", "J-LEASE"], type: "shinyou", basis: "official", source: JPG },
  { name: "K-net", aliases: ["Knet", "ケーネット", "近畿保証サービス", "近畿保証"], type: "shinyou", basis: "official", source: JPG },
  { name: "興和アシスト", aliases: [], type: "shinyou", basis: "official", source: JPG },
  { name: "エルズサポート", aliases: ["エルズ", "L's"], type: "shinyou", basis: "official", source: JPG },
  { name: "アーク保証", aliases: ["アーク賃貸保証", "アーク"], type: "shinyou", basis: "official", source: JPG },
  { name: "ニッポンインシュア", aliases: ["日本インシュア"], type: "shinyou", basis: "official", source: JPG },
  { name: "ルームバンクインシュア", aliases: ["ルームバンク", "RoomBank"], type: "shinyou", basis: "official", source: JPG },
  { name: "ランドインシュア", aliases: [], type: "shinyou", basis: "official", source: JPG },
  { name: "大成保証", aliases: [], type: "shinyou", basis: "official", source: JPG },
  { name: "宅建ブレインズ", aliases: [], type: "shinyou", basis: "official", source: JPG },
  { name: "テンポスバスターズ", aliases: [], type: "shinyou", basis: "official", source: JPG },
  // ── 種類が分からない（名寄せ・入力に無い会社名を伏せる走査のためだけ。種類に触れない）──
  // ライフ: 資料の「ライフ」はライフ安心プラス・ライフサポート（駆け付け）等の一部が多い。会社として確かめられない
  { name: "ライフ", aliases: ["ライフ保証", "ライフ賃貸保証"], type: "unknown", basis: "none" },
  // 2026-10-08 竹内さん: グリーン保証・東京保証＝独立系／GC保証＝信販系（根拠＝竹内さん）
  { name: "グリーン保証", aliases: [], type: "independent", basis: "takeuchi" },
  { name: "東京保証", aliases: [], type: "independent", basis: "takeuchi" },
  { name: "GC保証", aliases: ["新GC保証"], type: "credit", basis: "takeuchi" },
  { name: "西日本賃貸保証サービス", aliases: [], type: "unknown", basis: "none" },
  { name: "ミニミニ保証", aliases: [], type: "unknown", basis: "none" },
  { name: "エイブル保証", aliases: ["エイブル賃貸保証", "エイブルくらしの安心保証"], type: "unknown", basis: "none" },
  { name: "PMサポート保証", aliases: [], type: "unknown", basis: "none" },
];

/** 種類ごとのマスタの正規名（プロンプトの一般知識の会社名はここから作る＝会社の種類の知識をマスタ1本に・2026-09-26） */
export function guarantorNamesByType(t: GuarantorType): string[] {
  return GUARANTOR_COMPANY_MASTER.filter((c) => c.type === t).map((c) => c.name);
}
/** 画像の読み取り用: 資料に出る会社名の手がかり（種類は付けない＝種類は読み取った会社名から resolveGuarantor で決める） */
export const GUARANTOR_OCR_NAME_HINT: string = `【よく出る保証会社名（表記の手がかり・この一覧に無い会社もある）】\n${GUARANTOR_COMPANY_MASTER.map((c) => c.name).join("、")}`;

// ─── 名寄せ ───
/** 比較用のキー（全角半角・空白・株式会社・末尾の「保証会社」「保証」を落とす。正規名側も同じ関数を通すので「アセス保証」は一致する） */
function nameKey(raw: string): string {
  return (raw ?? "").normalize("NFKC").replace(/\s+/g, "").replace(/株式会社|\(株\)|（株）/g, "").replace(/(?:保証会社|保証)$/, "").toLowerCase();
}
const MASTER_BY_KEY: ReadonlyMap<string, GuarantorCompany> = (() => {
  const m = new Map<string, GuarantorCompany>();
  for (const c of GUARANTOR_COMPANY_MASTER) for (const w of [c.name, ...c.aliases]) if (!m.has(nameKey(w))) m.set(nameKey(w), c);
  return m;
})();
function masterOf(raw: string): GuarantorCompany | null {
  const k = nameKey(raw);
  return k ? MASTER_BY_KEY.get(k) ?? null : null;
}

/** 表記ゆれ（日本セーフティ／日本セーフティー／カーサ／オリコ／JID 等）を正規名に。マスタに無ければ trim してそのまま（カスタム会社） */
export function normalizeGuarantorName(raw: string): string {
  const s = (raw ?? "").trim();
  if (!s) return "";
  return masterOf(s)?.name ?? s;
}

/** 会社名 → 正規名・既定の種類・既知か（UI の「会社を選んだら種類を自動」と API 側の既定値決定はこれ1本） */
export function resolveGuarantor(raw: string, customs: ReadonlyArray<{ name: string; type: GuarantorType }> = []): { name: string; type: GuarantorType; known: boolean } {
  const s = (raw ?? "").trim();
  const m = masterOf(s);
  if (m) return { name: m.name, type: m.type, known: true };
  const k = nameKey(s);
  const c = k ? customs.find((x) => nameKey(x.name) === k) : undefined;
  if (c) return { name: c.name, type: normalizeGuarantorType(c.type) ?? "unknown", known: true };   // 登録済みの旧 "licc" は信用系
  return { name: s, type: "unknown", known: false };
}

/**
 * 種類が表で確か（竹内さん・公式の情報）か。返信・AIX の本文・ブレインの材料で「独立系」等を言い切るのは sure の時だけ（2026-10-08 竹内さん決定）。
 * 表に無い会社・スタッフの呼び方だけの会社・種類不明は sure=false（種類に触れない）。スタッフが登録した会社（customs）も確かではない扱い
 */
export function guarantorTypeSure(raw: string): { sure: boolean; type: GuarantorType; basis: GuarantorTypeBasis; source: string | null } {
  const m = masterOf((raw ?? "").trim());
  if (!m || m.type === "unknown") return { sure: false, type: m?.type ?? "unknown", basis: "none", source: null };
  const basis: GuarantorTypeBasis = m.basis ?? "staff_sent";
  return { sure: basis === "takeuchi" || basis === "official", type: m.type, basis, source: m.source ?? null };
}
/** 本文で使ってよい種類（確かでなければ unknown＝種類に触れない）。戻す GUARANTOR_TYPE_SURE_ONLY=off（旧＝表の種類をそのまま） */
export function guarantorTypeForText(raw: string, fallback: GuarantorType = "unknown"): GuarantorType {
  if (typeof process !== "undefined" && process.env?.GUARANTOR_TYPE_SURE_ONLY === "off") { const r = resolveGuarantor(raw); return r.known ? r.type : fallback; }
  const s = guarantorTypeSure(raw);
  return s.sure ? s.type : "unknown";
}

/**
 * 既定の種類を自動で入れる所（AIX の先入れ・画像の読み取り・種類を選ばなかった時）用の resolveGuarantor。
 * 表の会社は表で確かな種類だけ（確かでなければ unknown＝スタッフが選ぶ）・スタッフが登録した会社（customs）はその種類。
 */
export function resolveGuarantorForText(raw: string, customs: ReadonlyArray<{ name: string; type: GuarantorType }> = []): { name: string; type: GuarantorType; known: boolean } {
  const r = resolveGuarantor(raw, customs);
  if (!isMasterGuarantor(raw)) return r;
  return { ...r, type: guarantorTypeForText(raw, r.type) };
}

/** マスタの会社か（/api/guarantor-companies の POST がマスタ重複を弾くのに使う） */
export function isMasterGuarantor(raw: string): boolean {
  return masterOf((raw ?? "").trim()) !== null;
}

/** 正規名 → [正規名, ...別名]。マスタに無ければ [canonical] */
export function guarantorAliasesOf(canonical: string): string[] {
  const m = masterOf(canonical);
  return m ? [m.name, ...m.aliases] : [canonical];
}

// ─── 並行審査の判定（決定論・LLM に判断させない）───
export type ParallelScreeningPlan = {
  /** 正規名でまとめた会社ごとの物件名（入力順） */
  groups: Array<{ company: string; type: GuarantorType; properties: string[] }>;
  /** 2物件以上で同じ会社（＝並行して審査できない組） */
  overlapping: Array<{ company: string; properties: string[] }>;
  /** 会社が2社以上ある＝保証会社が異なるお部屋の並行審査を勧められる */
  canParallel: boolean;
};

/**
 * 会社を名寄せしてまとめる。同じ会社で種類が食い違っていたら最初の物件の種類。
 * YUYA 事例（カーザSun I=日本セーフティー・ノルデンハイム=オリコ・朝日プラザ=アセス保証・Renatus=日本セーフティ・ディザイア=日本賃貸保証）
 *   → groups 4・overlapping [{日本セーフティー, [カーザSun I, Renatus新大阪]}]・canParallel true
 */
export function planParallelScreening(properties: readonly GuarantorProperty[]): ParallelScreeningPlan {
  const groups: ParallelScreeningPlan["groups"] = [];
  for (const p of properties) {
    const company = normalizeGuarantorName(p.company);
    const g = groups.find((x) => nameKey(x.company) === nameKey(company));
    if (g) g.properties.push(p.name);
    else groups.push({ company, type: normalizeGuarantorType(p.type) ?? "unknown", properties: [p.name] });   // 保存済みの旧 "licc" は信用系
  }
  return {
    groups,
    overlapping: groups.filter((g) => g.properties.length >= 2).map((g) => ({ company: g.company, properties: g.properties })),
    canParallel: groups.length >= 2,
  };
}

const TYPE_ORDER: Record<GuarantorType, number> = { independent: 0, credit: 1, shinyou: 2, unknown: 3 };
/**
 * 並行審査の文の出し方（固定テンプレと LLM への指示の両方がこれ1本）。
 * 2026-09-15 検証指摘: 物件が1件だけの時に「いずれも同じ」「1件ずつ」は不自然なので、並行 ON でも2件以上ある時だけ並行／同一会社の文を出す
 */
function parallelMode(properties: readonly GuarantorProperty[], plan: ParallelScreeningPlan, parallel: boolean): "parallel" | "same_company" | "none" {
  if (!parallel || properties.length < 2) return "none";
  return plan.canParallel ? "parallel" : "same_company";
}
const PARALLEL_LINE = "審査無事通過する為、保証会社が異なるお部屋並行して審査かけさせて頂く事可能です！！";
const INVITE_LINE = "よろしければお気に召されたお部屋一度審査かけさせて頂きます！！";
const CANCEL_LINE = "※保証会社審査通過後、オーナー審査移行するまでキャンセル料不要となります！！";

// ─── 文の形（2026-10-07 竹内「文の質をあげてボタンとしてつかっていく」・提案20回・押下0の調査）───
// お客様の「保証会社どこですか？」は**1件の物件**の問いが多く（200日の手打ち: 1件の答え 5通／一覧 4通）、スタッフは2〜4分で2行の答えを手で打っていた:
//   9/30 8a77820b「保証会社はナップ賃貸保証となります！！\n独立系の保証会社となりますので比較的審査通過しやすいお部屋となります😌！！」
//   8/22 f568a14b「エスポワールの保証会社 株式会社Casaという独立系の保証会社となり比較的審査通過しやすいお部屋となります😊！！」
//   9/25 ab7ea742「1番手の保証会社はシノケンコミュニケーションズ（独立系）となり、否決の場合2番手ほっと保証（独立系）で審査される形となります！！」
//   6/01 2cba9376「保証会社はエルズサポートと日本セーフティ・独立系の保証会社となり、審査基準が緩く審査通過する可能性は高いお部屋となります😊！！」
//   10/04 b3bae304「保証会社興和アシストという…保証会社となります！！」
// AIX は1件でも「こちら保証会社一覧となります！！／・物件名／…／よろしければ…審査かけさせて頂きます！！／※キャンセル料不要」の5段（YUYA の5物件の一覧の型）
//   ＝1件の答えには長すぎ・「一覧」が合わず、同じ物件の2社（1社目/2社目）は同じ物件の段落が2つ並んだ。→ 物件の数と1物件の会社の数で形を分ける
// 2026-10-07 竹内「1社目 2社目にする スタッフが間違えている」: 同じ物件の2社は「1社目／2社目」と書く（上の ab7ea742 等の手打ちの「1番手／2番手」は
//   申込の順番の語と同じでスタッフの誤り＝手本にしない）。「1番手／2番手」は申込の順番（1番手でお申込み・2番手以降）だけに使う
//   answer   : 物件が1件（会社1社＝2行の答え／2社以上＝1社目・2社目の答え）。手打ちの過半数の形（物件名なし 4/5・締めの誘い・キャンセル料の行なし）
//   rank_list: 物件が2件以上で、どれかの物件に2社以上（6/29「【保証会社】◎物件 1番手:… 2番手:…」→ 1社目:… 2社目:…・9/22 YUYA「それぞれの保証会社確認させていただきました！！・物件 会社（種類）…となります！！」）
//   list     : 物件が2件以上・1物件1社（今までの YUYA 9/15 17:31 の型のまま・並行審査はこの形だけ）
export type GuarantorInfoShape = "answer" | "rank_list" | "list";
const propKey = (s: string) => (s ?? "").normalize("NFKC").replace(/\s+/g, "").replace(/号室$/, "");
/** 物件ごとの会社（入力順＝上から1社目）。同じ物件名のカードは同じ物件の2社目・3社目 */
export function guarantorCompaniesByProperty(properties: readonly GuarantorProperty[]): Array<{ name: string; companies: Array<{ company: string; type: GuarantorType }> }> {
  const out: Array<{ name: string; companies: Array<{ company: string; type: GuarantorType }> }> = [];
  for (const p of properties) {
    const company = normalizeGuarantorName(p.company);
    if (!company) continue;
    const type = normalizeGuarantorType(p.type) ?? "unknown";
    const g = out.find((x) => propKey(x.name) === propKey(p.name));
    if (!g) out.push({ name: p.name, companies: [{ company, type }] });
    else if (!g.companies.some((c) => nameKey(c.company) === nameKey(company))) g.companies.push({ company, type });
  }
  return out;
}
export function guarantorInfoShape(properties: readonly GuarantorProperty[]): GuarantorInfoShape {
  const byProp = guarantorCompaniesByProperty(properties);
  if (byProp.length <= 1) return "answer";
  return byProp.some((p) => p.companies.length >= 2) ? "rank_list" : "list";
}
/** 1件の答えの種類の文（ナップ 9/30 の実送信の2行目の型。信販系・信用系は一覧と同じ説明・不明は書かない） */
export const GUARANTOR_ANSWER_TYPE_NOTE: Record<GuarantorType, string> = {
  independent: "独立系の保証会社となりますので比較的審査通過しやすいお部屋となります😊！！",
  credit: GUARANTOR_TYPE_SCREENING_NOTE.credit,
  shinyou: GUARANTOR_TYPE_SCREENING_NOTE.shinyou,
  unknown: "",
};
const typeTag = (t: GuarantorType) => (GUARANTOR_TYPE_SHORT[t] ? `（${GUARANTOR_TYPE_SHORT[t]}）` : "");
/** 2社以上の「1社目の保証会社は A（独立系）となり、否決の場合2社目 B（独立系）で審査される形となります！！」（ab7ea742 9/25 の型・語は 10/07 竹内「1社目 2社目にする」） */
function rankSentence(companies: ReadonlyArray<{ company: string; type: GuarantorType }>): string {
  const [first, ...rest] = companies;
  const tail = rest.map((c, i) => `${i + 2}社目${c.company}${typeTag(c.type)}`).join("、");
  return `1社目の保証会社は${first.company}${typeTag(first.type)}となり、否決の場合${tail}で審査される形となります！！`;
}
/** 物件1件の答え（LLM なし）。1社＝「保証会社は〇〇となります！！」＋種類の文／2社以上＝1社目・2社目の文 */
export function buildGuarantorAnswerText(properties: readonly GuarantorProperty[]): string {
  const p = guarantorCompaniesByProperty(properties)[0];
  if (!p) return "";
  if (p.companies.length >= 2) return rankSentence(p.companies);
  const c = p.companies[0];
  return [`保証会社は${c.company}となります！！`, GUARANTOR_ANSWER_TYPE_NOTE[c.type]].filter(Boolean).join("\n");
}
/** 物件2件以上で、どれかに2社以上（9/22 YUYA・6/29 の一覧の型）。並行審査の文は付けない（同じ物件の2社目と並行審査は意味が重なる） */
export function buildGuarantorRankListText(properties: readonly GuarantorProperty[]): string {
  const lines = guarantorCompaniesByProperty(properties).map((p) => p.companies.length === 1
    ? `・${p.name} ${p.companies[0].company}${typeTag(p.companies[0].type)}`
    : `・${p.name} ${p.companies.map((c, i) => `${i + 1}社目:${c.company}${typeTag(c.type)}`).join(" ")}`);
  return ["それぞれの保証会社確認させて頂きました！！", lines.join("\n"), "となります！！\nお手隙の際にご確認ください😊！！"].join("\n\n");
}

// ─── 固定テンプレ（物件2件以上・1物件1社は YUYA 9/15 17:31 の実送信の型）───
/**
 * 「文面を作る（固定）」の本文。LLM を呼ばない。会社名は正規名（「日本セーフティ」と入れても「日本セーフティー」）。
 * 挨拶行（「お世話になっております！！」）は他の AIX と同じく付けない。
 * 2026-10-07: 形は guarantorInfoShape で分ける（物件1件＝2行の答え・2社以上の物件がある一覧＝1社目/2社目の一覧・それ以外＝今までの一覧）
 */
export function buildGuarantorInfoText(o: { customerName: string; properties: readonly GuarantorProperty[]; parallel: boolean }): string {
  const shape = guarantorInfoShape(o.properties);
  if (shape === "answer") return buildGuarantorAnswerText(o.properties);
  if (shape === "rank_list") return [o.customerName ? `${o.customerName}さん` : "", buildGuarantorRankListText(o.properties)].filter(Boolean).join("\n");
  const plan = planParallelScreening(o.properties);
  const head = [o.customerName ? `${o.customerName}さん` : "", "こちら保証会社一覧となります！！"].filter(Boolean).join("\n");
  // 会社ごとの段落: 種類の順（独立系 → 信販系 → 信用系 → 不明）、同じ種類の中は入力順
  const groups = [...plan.groups].sort((a, b) => TYPE_ORDER[a.type] - TYPE_ORDER[b.type]);
  const paragraphs = groups.map((g) => `${g.properties.map((p) => `・${p}`).join("\n")}\n${GUARANTOR_TYPE_SENTENCE[g.type](g.company)}`);
  // 並行審査（parallelMode で固定テンプレと formatGuarantorFacts の分岐を1本にする）
  const closing: string[] = [];
  const mode = parallelMode(o.properties, plan, o.parallel);
  if (mode === "parallel") {
    closing.push(PARALLEL_LINE);
    for (const ov of plan.overlapping) closing.push(`${ov.properties.join("と")}は保証会社が同じ（${ov.company}）となりますので、どちらか1件の審査となります！！`);
    closing.push(INVITE_LINE);
  } else if (mode === "same_company") {
    closing.push(`保証会社がいずれも${plan.groups[0]?.company ?? ""}と同じとなりますので、お気に召されたお部屋1件ずつ審査かけさせて頂く形となります！！`);
  } else {
    closing.push(INVITE_LINE);
  }
  return [head, ...paragraphs, closing.join("\n"), CANCEL_LINE].join("\n\n");
}

// ─── 物件確認した（募集中）に添える説明（YUYA 事例・2026-09-17）───
// 竹内「保証会社名は見積書の下に項目いれて、そこに保証会社名入れれる形とする。ここで保証会社について説明された文が生成されるようになる」
//
// 【物件確認した】は「この1件（数件）の保証会社」を御見積書の直後に1〜2行で添える場面で、
// 【保証会社について】（保証会社一覧を送る場面）とは文の型が違う。文はスタッフの実送信そのまま（種類ごとに1つ）:
//   信販系 2026-09-16 YUYA「クレディセゾンという信用系の保証会社を使用しており、クレジットカードの滞納歴で審査する保証会社となります！！」
//     （🌟最大限割引しました御見積書同封させて頂きました！！ の直後に置かれている＝画面の入力欄も見積書の下に置く）
//   独立系 2026-06-29「保証会社:オセロ・フィナンシャルサービス株式会社となり独立系の保証会社となりますのでかなり審査通過しやすいお部屋となります😊！！」
//   複数件で同じ会社 2026-07-21「2部屋とも保証会社クレデンスという比較的審査通過しやすいもの採用しております！！」
// ※ credit（クレディセゾン・エポス等）の呼び名は「信販系」。9/16 の実送信はクレディセゾンを「信用系」と書いていたが、
//   2026-09-26 竹内さん決定でクレディセゾンは信販系・信用系は別の種類（全保連・ジェイリース・K-net 等）なので、種類名だけ「信販系」にして文の型は実送信のまま。
//   「クレジットカードの滞納歴で審査する」は竹内さんの信販系の定義（クレジットカード会社や信販会社が母体）に沿う
// ※ shinyou（全保連・ジェイリース・K-net 等）: この場面の実送信は無い → 同じ型（〇〇という△△の保証会社を使用しており、…）に竹内さんの信用系の定義の言葉だけを入れる
// ※ 旧実装（AixModal で generatedMsg に追記）は種類を見ずに「クレジットカードの滞納歴で審査する中級程の保証会社」固定で、
//   独立系（審査が緩い）の物件にも信販系の説明が付いていた。事実関係の説明なので種類ごとに分ける
export const GUARANTOR_CHECK_SENTENCE: Record<GuarantorType, (company: string) => string> = {
  independent: (c) => `${c}という独立系の保証会社を使用しており、審査基準が緩くかなり審査通過しやすいお部屋となります😊！！`,
  credit: (c) => `${c}という信販系の保証会社を使用しており、クレジットカードの滞納歴で審査する保証会社となります！！`,
  shinyou: (c) => `${c}という信用系の保証会社を使用しており、金融系の情報ではなく過去の家賃滞納やトラブルが無かったかを見る保証会社となります！！`,
  unknown: (c) => `${c}という保証会社を使用しております！！`,
};

/**
 * 【物件確認した・募集中】の本文に添える保証会社の説明。会社名が入っている物件だけが対象（入れなければ空＝何も足さない）。
 * ・全部同じ会社: 1件ならそのまま／複数件は「こちら2部屋とも〜」（実送信の型）
 * ・会社が分かれる: 物件名を頭に付けて会社ごとに1行（どの部屋がどの会社か分かるように）
 * 会社名は正規名（「日本セーフティ」と入れても「日本セーフティー」）。種類は入力値をそのまま使う（LLM に決めさせない）
 */
export function buildGuarantorCheckNote(properties: readonly GuarantorProperty[]): string {
  const filled = properties.filter((p) => (p.company ?? "").trim());
  if (filled.length === 0) return "";
  const plan = planParallelScreening(filled);
  if (plan.groups.length === 1) {
    const g = plan.groups[0];
    const sentence = GUARANTOR_CHECK_SENTENCE[g.type](g.company);
    return filled.length >= 2 ? `こちら${filled.length}部屋とも${sentence}` : sentence;
  }
  return plan.groups
    .map((g) => `${g.properties.filter(Boolean).join("・")}は${GUARANTOR_CHECK_SENTENCE[g.type](g.company)}`)
    .join("\n");
}

// ─── 手打ちの一覧（YUYA 17:27 型・UI の「入力の確認」用。送信文には使わない）───
export function buildGuarantorListText(properties: readonly GuarantorProperty[]): string {
  return properties.map((p) => `⚪︎${p.name}\n${normalizeGuarantorName(p.company)}`).join("\n");
}

// ─── LLM に渡す事実ブロック（会話を合わせる用）───
export function formatGuarantorFacts(propertiesIn: readonly GuarantorProperty[], opts: { parallel: boolean }): { block: string; allowedNames: string[]; plan: ParallelScreeningPlan } {
  const properties: GuarantorProperty[] = propertiesIn.map((p) => ({ ...p, type: normalizeGuarantorType(p.type) ?? "unknown" }));   // 旧の "licc" は信用系
  const plan = planParallelScreening(properties);
  const allowedNames = [...new Set(properties.flatMap((p) => {
    const canonical = normalizeGuarantorName(p.company);
    return [p.company.trim(), canonical, ...guarantorAliasesOf(canonical)];
  }).filter(Boolean))];
  const shape = guarantorInfoShape(properties);
  const factLines = ["【物件ごとの保証会社（スタッフ入力・確定事実。この会社名・種類だけを使う。同じ物件に2社以上ある時は上から1社目・2社目）】"];
  for (const p of properties) factLines.push(`- ${p.name}: ${normalizeGuarantorName(p.company)}（${GUARANTOR_TYPE_LABELS[p.type]}）`);
  // 2026-10-07: 物件1件・1社目/2社目の一覧は、固定の文を土台にして会話に合わせる（種類の言い回し・並行審査・キャンセル料の行の指示は一覧の形だけ）
  if (shape !== "list") {
    const base = shape === "answer" ? buildGuarantorAnswerText(properties) : buildGuarantorRankListText(properties);
    factLines.push(`【土台の文（会社名・種類・言い回しはこの文のまま）】\n${base}`);
    factLines.push("【禁止】上記に無い保証会社名・種類／「審査通ります」「通りそうです」等の通過の断言／保証人・緊急連絡先の話／「こちら保証会社一覧となります」「※保証会社審査通過後…キャンセル料不要」の行（一覧の形の文）");
    return { block: factLines.join("\n"), allowedNames, plan };
  }
  const lines: string[] = [...factLines];
  lines.push("【種類ごとに使ってよい言い回し（この文だけ。種類から別の説明を作らない）】");
  const types = GUARANTOR_TYPES.filter((t) => properties.some((p) => p.type === t));
  for (const t of types) {
    if (t === "unknown") lines.push("- 不明・その他: 種類には触れない（審査の緩い・厳しいを書かない）。「の保証会社は〇〇となります！！」まで");
    else if (t === "shinyou") lines.push(`- ${GUARANTOR_TYPE_SHORT[t]}: 「・物件名」の次行に「${GUARANTOR_TYPE_SENTENCE[t]("〇〇")}」（信販系とは別の種類。審査の緩い・厳しいは書かない。「LICC系」とは書かない）`);
    else lines.push(`- ${GUARANTOR_TYPE_SHORT[t]}: 「・物件名」の次行に「${GUARANTOR_TYPE_SENTENCE[t]("〇〇")}」`);
  }
  lines.push("【並行審査】");
  const mode = parallelMode(properties, plan, opts.parallel);
  if (mode === "parallel") {
    lines.push(`保証会社が異なるお部屋（${plan.groups.map((g) => g.company).join("／")}）は並行して審査をかけられる。文: 「${PARALLEL_LINE}」`);
    for (const ov of plan.overlapping) lines.push(`同じ会社の組（${ov.properties.join("と")}=${ov.company}）は「どちらか1件の審査となります」と1文で伝える`);
  } else if (mode === "same_company") {
    lines.push(`全物件が同じ会社（${plan.groups[0]?.company ?? ""}）＝並行審査は書かない。「お気に召されたお部屋1件ずつ審査」と書く`);
  } else {
    lines.push("並行審査の提案は書かない");
  }
  lines.push(`【必ず入れる】${CANCEL_LINE}`);
  lines.push("【禁止】上記に無い保証会社名・種類／「審査通ります」「通りそうです」等の通過の断言（許される言い回しは上の文の「審査通過する可能性十分に御座います」「審査無事通過する為」まで）／保証人・緊急連絡先の話");
  return { block: lines.join("\n"), allowedNames, plan };
}

// ─── 本文の事実の照合（決定論）───
/** 単独では走査しない一般語 */
const SCAN_SKIP = new Set(["ライフ", "シノケン", "アーク", "エイト", "オセロ", "プレサンス", "インシュアランス", "マスター保証", "信和保証", "Sumai"]);
/** 2026-09-15 検証指摘: 会社名の直後にこの語が続く時は別の言葉（「ナップサック」）なので伏せない */
const SCAN_NOT_FOLLOWED_BY: Record<string, string[]> = { "ナップ": ["サック"] };
/** UI の「会話履歴から保証会社名を自動検出」にも使える走査語（長い順） */
export const GUARANTOR_SCAN_WORDS: readonly string[] = [...new Set(GUARANTOR_COMPANY_MASTER.flatMap((c) => [c.name, ...c.aliases]))].sort((a, b) => b.length - a.length);
const isAsciiWord = (w: string) => /^[\x20-\x7e]+$/.test(w);
const isAlnum = (ch: string) => /^[A-Za-z0-9]$/.test(ch);

/**
 * 本文から走査語の出現範囲 [start, end) を返す（元の本文の位置。NFKC で一致する半角カナ・全角英字も元の文字列上で範囲を取るので、
 * 伏せる時に本文全体を NFKC 化して「！！」→「!!」のように文体を崩さない＝2026-09-15 検証指摘）。
 * 英数字だけの語（NAP・JID・casa・EPOS 等）は語境界付き（「snapshot」「casablanca」「JIDAI」に当てない）。
 */
function findWordRanges(text: string, word: string): Array<[number, number]> {
  const target = word.normalize("NFKC").toLowerCase();
  const ascii = isAsciiWord(target);
  const notFollowed = SCAN_NOT_FOLLOWED_BY[word] ?? [];
  const ranges: Array<[number, number]> = [];
  const n = text.length;
  let i = 0;
  while (i < n) {
    let acc = "";
    let matched = -1;
    for (let j = i; j < n; j++) {
      acc += text[j];
      const norm = acc.normalize("NFKC").toLowerCase();
      if (norm.length > target.length) break;
      if (norm === target) { matched = j + 1; break; }
    }
    if (matched < 0) { i++; continue; }
    const before = i > 0 ? text[i - 1].normalize("NFKC") : "";
    const after = matched < n ? text[matched].normalize("NFKC") : "";
    const boundaryOk = !ascii || (!isAlnum(before) && !isAlnum(after));
    const tailOk = !notFollowed.some((s) => text.startsWith(s, matched));
    if (boundaryOk && tailOk) { ranges.push([i, matched]); i = matched; }
    else i++;
  }
  return ranges;
}

/**
 * 本文に入力に無い保証会社名（マスタの別会社・extraCompanies に渡したスタッフ登録の会社）が出たら「〇〇」に伏せ、種類の表現が入力と食い違えば typeWarnings に出す。
 * 長い順に走査するので「オリコフォレントインシュア」が伏せられた後に「オリコ」で再走査されない。固定テンプレの出力は必ず ok
 * @param extraCompanies guarantor_companies テーブルのスタッフ登録分（入力に無い登録会社名も走査する。純関数のまま＝呼び出し側が渡す）
 */
export function checkGuarantorFacts(
  text: string,
  properties: readonly GuarantorProperty[],
  extraCompanies: ReadonlyArray<{ name: string }> = [],
): { ok: boolean; cleaned: string; unmatched: string[]; typeWarnings: string[] } {
  const allowedCanonical = new Set(properties.map((p) => nameKey(normalizeGuarantorName(p.company))));
  const scan: Array<{ word: string; canonical: string }> = [];
  for (const c of GUARANTOR_COMPANY_MASTER) {
    if (allowedCanonical.has(nameKey(c.name))) continue;
    for (const w of [c.name, ...c.aliases]) {
      if (w.normalize("NFKC").length < 3 || SCAN_SKIP.has(w)) continue;
      scan.push({ word: w, canonical: c.name });
    }
  }
  for (const x of extraCompanies) {
    const w = (x?.name ?? "").trim();
    if (!w || w.normalize("NFKC").length < 3 || isMasterGuarantor(w) || allowedCanonical.has(nameKey(w))) continue;
    scan.push({ word: w, canonical: w });
  }
  scan.sort((a, b) => b.word.length - a.word.length);
  let cleaned = text ?? "";
  const unmatched: string[] = [];
  for (const { word, canonical } of scan) {
    const ranges = findWordRanges(cleaned, word);
    if (ranges.length === 0) continue;
    // 後ろから置き換えて位置がずれないようにする
    for (const [s, e] of ranges.reverse()) cleaned = cleaned.slice(0, s) + "〇〇" + cleaned.slice(e);
    if (!unmatched.includes(canonical)) unmatched.push(canonical);
  }
  // 種類の表現（伏せ字にはしない・notice にだけ出す）。種類は3つ（2026-09-26 竹内さん・LICC系は信用系に統合）
  //   全保連・ジェイリース等（信用系）を「信用系」と書くのは正しい。信販系（エポス・クレディセゾン等）・独立系の会社を「信用系」と書いたら止める。
  //   「LICC系」は無くした種類なので、どの会社でも書いたら止める（旧の言い回しの混入）
  const has = (t: GuarantorType) => properties.some((p) => normalizeGuarantorType(p.type) === t);
  const t = cleaned;
  const typeWarnings: string[] = [];
  if (/独立系/.test(t) && !has("independent")) typeWarnings.push("種類:独立系");
  if (/LICC/i.test(t)) typeWarnings.push("種類:LICC系");
  if (/信販系/.test(t) && !has("credit")) typeWarnings.push("種類:信販系");
  if (/信用系/.test(t) && !has("shinyou")) typeWarnings.push("種類:信用系");
  if (/審査基準が緩|審査ゆるめ|緩め|審査(?:が|は)?緩/.test(t) && !has("independent")) typeWarnings.push("種類:緩い");
  return { ok: unmatched.length === 0 && typeWarnings.length === 0, cleaned, unmatched, typeWarnings };
}

/**
 * 会話の1通から保証会社名を拾う（UI の「会話から入れる」候補。長い会社名から当てるので「オリコフォレントインシュア」が「オリコ」に負けない）。
 * 2026-09-17 竹内（YUYA 事例）: 画面側に別の短い一覧（11社）がコピーされていたのをここに寄せた（名寄せ・種類・語境界の判定が1か所）
 */
export function detectGuarantorInText(text: string): { name: string; type: GuarantorType } | null {
  const t = text ?? "";
  if (!t.trim()) return null;
  for (const w of GUARANTOR_SCAN_WORDS) {
    if (w.normalize("NFKC").length < 3 || SCAN_SKIP.has(w)) continue;
    if (findWordRanges(t, w).length === 0) continue;
    const r = resolveGuarantor(w);
    return { name: r.name, type: r.type };
  }
  return null;
}

/** 会話（古い順の配列）から一番新しい保証会社名を拾う。スタッフ・お客様どちらの発言も見る（管理会社の回答をそのまま貼る運用があるため） */
export function detectGuarantorFromMessages(messagesOldestFirst: ReadonlyArray<{ text?: string | null }>): { name: string; type: GuarantorType } | null {
  for (let i = messagesOldestFirst.length - 1; i >= 0; i--) {
    const hit = detectGuarantorInText(messagesOldestFirst[i]?.text ?? "");
    if (hit) return hit;
  }
  return null;
}

// ─── 会話を合わせる（LLM）の構成（形ごと。route の静的な指示に入れる＝形ごとにキャッシュの鍵が分かれるだけ）───
/** 審査の不安を書いたお客様への1文（スタッフの実送信: 2cba9376「審査無事通りますようサポートさせて頂きます！！」・732692f2「審査面無事通過できますようにサポートさせて頂きます！！」） */
export const GUARANTOR_SUPPORT_LINE = "審査無事通過できますようにサポートさせて頂きます！！";
export function guarantorInfoStructure(shape: GuarantorInfoShape): string {
  if (shape === "answer") {
    return `【構成（物件1件の保証会社のご質問への答え・スタッフの手打ちの過半数の形）】
①【土台の文】をそのまま書く（会社名・種類・言い回しを変えない。物件名の一覧「・物件名」や「こちら保証会社一覧となります」の形にしない）
②お客様の直近の発言に審査の不安（きつい・厳しい・通るか・ブラック・心配 等）がある時だけ、最後に「${GUARANTOR_SUPPORT_LINE}」を1文足す
③それ以外は足さない（申込・内覧の誘い・並行審査・「※保証会社審査通過後…キャンセル料不要」の行・挨拶の言い直しを書かない）`;
  }
  if (shape === "rank_list") {
    return `【構成（物件ごとの保証会社の一覧・同じ物件に1社目/2社目がある）】
①【土台の文】をそのまま書く（物件ごとの行・1社目/2社目の順・会社名・種類を変えない。「1番手／2番手」と書き換えない）
②お客様の直近の発言に審査の不安がある時だけ、最後に「${GUARANTOR_SUPPORT_LINE}」を1文足す
③並行審査・「※保証会社審査通過後…キャンセル料不要」の行は書かない`;
  }
  return `【構成】
①お客様の直近の発言に質問・不安（審査が心配・保証会社はどこか・保証人は要るか 等）があれば、最初の1文でそれに直接答える（無ければ「こちら保証会社一覧となります！！」から始める）
②物件ごとの一覧: 「・物件名」を1行ずつ並べ、続けて「の保証会社は〇〇と独立系の保証会社となりますので、…」の形（同じ会社の物件は同じ段落にまとめる。会社が違えば段落を分ける）
③種類ごとの説明は【種類ごとに使ってよい言い回し】の文だけを使う（種類が「不明・その他」の物件は審査の緩い・厳しいに触れない）
④【並行審査】の指示どおり（指示が「書かない」なら並行審査に一切触れない。同じ会社の組があれば「どちらか1件の審査となります」）
⑤「よろしければお気に召されたお部屋一度審査かけさせて頂きます！！」
⑥最終行は「※保証会社審査通過後、オーナー審査移行するまでキャンセル料不要となります！！」`;
}

// ─── スタッフの実文（会話を合わせるの手本・中身は写さない）───
// 2026-09-26: 全保連を「LICC系の保証」と書いた 8/23 の1通は外した（種類は3つ・LICC系は信用系に統合＝無くした種類名を手本で見せない）
export const GUARANTOR_INFO_STAFF_EXAMPLES: readonly string[] = [
  "お世話になっております！！\nこちら保証会社一覧となります！！\n・カーザSun I\n・Renatus新大阪\nの保証会社は日本セーフティと独立系の保証会社となりますので、審査基準が緩い保証会社となります😊！！\n\n審査無事通過する為、保証会社が異なるお部屋並行して審査かけさせて頂く事可能です！！\nよろしければお気に召されたお部屋一度審査かけさせて頂きます！！\n\n※保証会社審査通過後、オーナー審査移行するまでキャンセル料不要となります！！",
  "ヴィラ汐町・オーラコート杭瀬の保証会社が日本セーフティと独立系の保証会社となります！！独立系保証会社の為審査基準緩く、審査通過する可能性十分に御座います！！よろしければ一度お申込みし審査かけてみるのは如何でしょうか😌！！",
  "こちらのお部屋如何でしょうか😌！保証会社がアセス保証と他物件と被っておりませんので、お気に召されましたら審査かけさせて頂きます！",
  "H-Maison大正:保証会社JPMC\nソルテラスNAMBAサウスフィール:保証会社Casa\nとなり比較的審査通過しやすいお部屋となります😊！！お気に召されましたらお部屋お申込みいただくのをお勧めいたします！！",
];
/** 物件1件の答えの手本（スタッフの手打ちの実送信そのまま・2026-10-07）。中身（会社名・種類）は写さない */
export const GUARANTOR_ANSWER_STAFF_EXAMPLES: readonly string[] = [
  "保証会社はナップ賃貸保証となります！！\n独立系の保証会社となりますので比較的審査通過しやすいお部屋となります😌！！",
  // ab7ea742 9/25 の手打ちは「1番手／2番手」だった（10/07 竹内「スタッフが間違えている」）→ 語だけ「1社目／2社目」に直して見せる
  "1社目の保証会社はシノケンコミュニケーションズ（独立系）となり、否決の場合2社目ほっと保証（独立系）で審査される形となります！！",
  "ご質問ありがとうございます！！\n保証会社はエルズサポートと日本セーフティ・独立系の保証会社となり、審査基準が緩く審査通過する可能性は高いお部屋となります😊！！\n審査無事通りますようサポートさせて頂きます！！",
];

/** お客様の発言に審査の不安があるか（きつい・厳しい・通るか・ブラック・心配 等）。「会話を合わせる」の物件1件の形で支えの1文を足すかだけに使う */
export function customerWorriesAboutScreening(text: string | null | undefined): boolean {
  return /きつ|厳し|通(?:る|り|ら|過)|落ち|ブラック|心配|不安|大丈夫|滞納|審査.{0,6}(?:緩|ゆる|甘)/.test(String(text ?? ""));
}
/**
 * 物件1件・1社目/2社目の一覧の「会話を合わせる」（LLM なし・2026-10-07）。
 * DeepSeek で回すと土台を崩した（1社目が消える・種類が不明の会社に「ブラックでも通る可能性十分に御座います」）ので、
 * 土台の文＋お客様が審査の不安を書いた時だけ支えの1文（スタッフの実送信 2cba9376・732692f2 の形）を決定論で足す
 */
export function buildGuarantorMatchedText(properties: readonly GuarantorProperty[], latestCustomerMessage: string | null | undefined): string | null {
  const shape = guarantorInfoShape(properties);
  if (shape === "list") return null;
  const base = shape === "answer" ? buildGuarantorAnswerText(properties) : buildGuarantorRankListText(properties);
  return customerWorriesAboutScreening(latestCustomerMessage) ? `${base}\n${GUARANTOR_SUPPORT_LINE}` : base;
}
