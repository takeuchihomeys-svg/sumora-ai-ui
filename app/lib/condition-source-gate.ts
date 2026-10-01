// app/lib/condition-source-gate.ts（純関数・DB/LLM 依存なし）
// お客様の発言が「条件の発言」か「物件の問い合わせ（SUUMO 等の物件を送って空いているか聞いているだけ）」かを入口で見分ける。
//
// 2026-09-30 竹内（黒明様の事例）「【グループ】黒明様お部屋…のエリアに『4階のお部屋・11階のお部屋』が入っている。
//   おそらく SUUMO でこの物件空いてるかって送られてきた物件で、お客さんが希望している条件でない。他にも西中島南方とか出てるけど、
//   ここもお客さんの希望の条件じゃない。反映する部分の能力がかなり低い。根本的な部分。お客さんの条件か、ただ物件 SUUMO 等のサイト送ってきているだけか等」
//   「実際の LINE や成約データもみて、ちゃんと反映されるようにズレがないように根本的な部分改善する」
//
// 【出所（実物）】
//   - P4（line-webhook-text extractConditionsFromCasualReply）: 9/23「4階のお部屋は11月初旬で入居出来るなら良かったのですが、、
//     11階の方を抑えつつ、新着でオススメ物件あればご連絡いただきたいです」（こちらが送った Luxe難波WEST 403・1104号室の話）を
//     希望エリア「4階のお部屋・11階のお部屋」・入居時期「11月初旬」・その他「11階の方を抑えつつ…」として書いた。
//     入口はスタッフの「1104号室家賃67,500円」の『家賃』だけで開き、Haiku の4択にも「物件の話」が無かった。
//   - 経路C（detectAndAnnounceAreaChange）: 9/24 転職先の書式の貼り返し「・勤務先所在地 西中島南方駅最寄り」を地域の指定と読んだ。
//   - 条件の欄に物件の話が入ったのは 13人・19語（scripts/audit-condition-pollution.ts）。書き手は P4・経路C・ブレインの橋・条件ブレイン・最初の登録。
//
// 【決まり】（設計知見「おかしな文を1通見つけたら」の⑤: 入口は厳しくてよい／出口は誤削除0でなければ入れない）
//   - ここは**入口**: 条件の欄に「足す」前に、発言のうち条件として読んでよい部分（conditionText）だけを残す。既存の値は消さない。
//   - 見分けは決定論の形を先に（URL・物件情報の形・号室・N階のお部屋・この物件・空いてますか・抑えて・申込の書式・物件ページのスクショ）。
//     足りない所は既存の Haiku の分類（line-webhook-text の4択に property_inquiry を1つ足す＝新しい呼び出しは増やさない）。
//   - 1通に物件の話と条件が同居する時（「こちらの物件の空き状況と 桜川、九条エリアでおすすめの物件が…」）は節で分けて条件の節だけ残す。
//   - 本物の階の条件（「2階以上」「1階以外」「1階の物件希望」「最上階」）・URL の無い「駅徒歩N分」・駅を並べた紹介の依頼は止めない（実物をテストに固定）。
//   - 「この部屋の広さで」「こちらの物件と同じような」は物件を物差しにした条件の発言（問い合わせではない）。

import { stationsInText, wardsInText, linesInText, normStation, normWard, isKnownStation } from "./osaka-geo";
import { isApplicationFormMessage } from "./application-form-detect";
import { isFilledSumoraForm } from "./condition-format";
import { walkMinutesInText } from "./walk-minutes-text";

/** 1通（または連投）の種類 */
export type ConditionTurnKind =
  | "condition"        // 条件の発言
  | "condition_form"   // うちの条件のフォーマット・条件の一覧（そのまま条件）
  | "mixed"            // 物件の話と条件の同居（条件の節だけ残す）
  | "property_inquiry" // 物件の問い合わせだけ（条件の欄に書かない・物件確認の流れへ）
  | "apply_form"       // 申込・審査の書類（勤務先所在地 等）。条件ではない
  | "image_property"   // 物件ページのスクショ（SUUMO の物件名・号室・階・家賃・駅徒歩の組）
  | "image_condition"  // 条件のメモ・検索条件の画面のスクショ
  | "image_other"      // その他の画像（LINE のスクショ・書類 等）
  | "empty";

export type DroppedPieceKind = "inquiry" | "request" | "apply_form" | "image_property" | "image_other";

export type ConditionTurn = {
  kind: ConditionTurnKind;
  /** 条件として読んでよい部分（空なら条件の欄に何も書かない） */
  conditionText: string;
  /** 落とした部分と理由（ログ・監査用） */
  dropped: Array<{ text: string; kind: DroppedPieceKind; reason: string }>;
};

const nf = (s: unknown) => String(s ?? "").normalize("NFKC");

/** 連投の区切り（app/lib/reply-context.ts MSG_SEP と同じ字。import すると重いので字だけ持つ） */
const MSG_SEP_CHAR = "⁣";

// ── 物件の問い合わせの形 ────────────────────────────────────────────
/** 物件ポータル・物件ページの URL（本番の isPropertySiteUrl の5サイトより広い。180日で 114通が5サイトをすり抜けていた） */
export const PORTAL_URL_RE = /https?:\/\/[^\s]*(?:suumo|homes\.co\.jp|chintai|athome|lifull|nifty|realestate\.yahoo|smocca|pethomeweb|sumaity|eheya|canary-app|pitat|realnetpro|house\.goo|iimon|homemate|shamaison|sumaisagashi|oshimaland|izumi-realestate|zkss|actrus|able\.co|minimini|apamanshop|door\.ac|ielove|share\.google|goo\.gl\/maps|maps\.app\.goo)/i;
/** 物件ポータルの共有文（物件名：／交通：／所在地：／価格：のうち2項目以上）— line-webhook-text の PROPERTY_LISTING_SHAPE_RE と同じ */
export const PROPERTY_LISTING_SHAPE_RE = /(?:物件名|交通|所在地|価格|物件種目)\s*[:：][\s\S]*(?:物件名|交通|所在地|価格|物件種目)\s*[:：]/;
/** ポータルアプリの共有文（「地下鉄堺筋線 恵美須町 徒歩5分 1R 5.2万円 [詳細]」「【空室あり!】-パティオライブ ・1K(布忍駅 / 松原市東新町)の賃貸マンション|賃貸EX」「by SUUMO」） */
const PORTAL_SHARE_RE = /\[詳細\]|【空室あり|賃貸EX|by\s*SUUMO|by\s*賃貸スモッカ|ニフティ不動産|SUUMO物件コード|物件コード\s*[:：]|号室名\s*[:：]/i;

/**
 * 物件を物差しにした条件の発言（「この部屋の広さで」「こちらの物件と同じような」「この物件みたいな」）。
 * 物件を指す語があっても問い合わせではない（20adb6ad「この部屋の広さで南向き2階以上キッチン広め 家賃10万ぐらいで堀江阿波座辺りで」）
 */
const REFERENCE_AS_CONDITION_RE = /(?:この|こちらの|その|あの|こういう|こんな)(?:物件|お部屋|部屋)(?:と|に)?(?:同じ|似た|似てる|近い|みたいな|みたいに|のような|のように|ような|ように|くらい|ぐらい|程度|並み|以上|より)|(?:この|こちらの|その|あの)(?:物件|お部屋|部屋)の(?:広さ|間取り|家賃|条件|感じ|雰囲気|ような|みたいな|くらい|ぐらい|レベル|設備|条件で)/g;

/** 階の条件（止めてはいけない側）: 「N階の物件希望」「N階の部屋がいい」「N階以上」「1階以外」 */
const FLOOR_CONDITION_TAIL = "(?!(?:が|を|で|は|も)?(?:希望|いい|良い|よい|良かった|以外|以上|NG|ng|ダメ|だめ|嫌|いや|イヤ|避け|不可|無理|は避))";

/** 1件の物件を指す形（それぞれ 180日の実物で条件として言われた例がほぼ0の形） */
const INQUIRY_SHAPES: ReadonlyArray<readonly [string, RegExp]> = [
  ["物件サイトの URL", PORTAL_URL_RE],
  ["物件情報の形", PROPERTY_LISTING_SHAPE_RE],
  ["ポータルの共有文", PORTAL_SHARE_RE],
  ["号室", /号室|号棟|[0-9]{3,4}号(?![線機館目])/],
  // 「Luxe難波WEST 1104」「プレリス阿波座Bloom 505」「メゾンボヌール203」（建物名＋部屋番号）
  ["建物名＋部屋番号", /[ァ-ヶーA-Za-z]{2,}[\s　]?[0-9]{3,4}(?![0-9万円㎡m²分帖畳年月日時,.\-〜~:：/])/],
  // 「4階のお部屋」「11階の方」「何階の空き」「3階部分」（「1階の物件希望」「2階の部屋がいい」は条件）
  ["N階のお部屋", new RegExp(`(?:[0-9]+|[一二三四五六七八九十]+|何)階(?:部分|の(?:お)?(?:部屋|方|物件|空き))${FLOOR_CONDITION_TAIL}`)],
  ["上の階・下の階の部屋", /(?:上|下|隣)の(?:階|部屋)(?:の)?(?:空き|資料|お部屋)|同じ(?:建物|マンション|物件)の(?:別の|他の)?(?:部屋|お部屋|階)/],
  ["この物件", /(?:この|こちらの|こちら|その|そちらの|あの|こっちの|ここの|上記の?|先ほどの|さっきの|前回の|昨日の|お送り頂いた|お送りいただいた|送って頂いた|送っていただいた|送ってもらった|頂いた|いただいた|ご提示いただいた|気になる|気になってる|気になっている)(?:[0-9一二三四五六七八九十]+(?:つ|件)の|ふたつの|みっつの|2つの|二つの)?(?:物件|お部屋|部屋)/],
  ["空き・募集", /空いて(?:ます|い|る|おり|ますか)|空き(?:が|は|状況|あり|ある|です|でしょう|確認|部屋)|空室(?:ですか|でしょうか|確認|状況|あり)|まだ(?:あり|空|募集|残って)|募集(?:中|して|出て|終了|され|が出|状況|停止|ありますか|あります)|埋まって|埋まり/],
  // 「抑えて」はお部屋の仮押さえの時だけ（目的語がお部屋・物件か、「抑えていただ／抑えて欲しい／抑えつつ」の形）。
  //   目的語の無い「出来るだけ抑えたい」「敷礼なしで抑えたい」は費用の話（掃除の表を作る時の目視で見つけた誤り）
  ["抑え・申込・内見", /(?:部屋|物件|方|号室|こちら|ここ|そちら|念の為|念のため|一旦|先に)(?:を|は|も)?(?:念の為|念のため|一旦|先に)?(?:抑え|押さえ|おさえ)|(?:抑え|押さえ|おさえ)(?:て(?:いただ|頂|もらえ|ください|下さい|欲しい|ほしい|おいて|おき)|つつ|れ(?:ている|てる|ました|た))|仮押さえ|申し?込(?!金|み?(?:が)?(?:可能|できる)(?:な)?(?:物件|所|ところ|とこ|お部屋|部屋))|内見|内覧|見学/],
  ["物件名", /物件名|建物名|マンション名/],
  // 「カシータで決めようと思っています」「ここで決めたい」（1件の物件に決める話）
  ["物件に決める", /(?:ここ|こちら|そちら|[ァ-ヶーA-Za-z]{2,})(?:で|に)決め(?:よう|ます|たい|まし|る|て)/],
  // 送った物件・持ち込んだ物件の建物名（ブランド）。「マンション」「ハイツ」だけは条件の語なので入れない
  ["建物名（ブランド）", /エステムコート|エステムプラザ|プレサンス|エスリード|アドバンス|セレニテ|ラグゼ|スプランディッド|レジュール|フィオーレ|アーバネックス|クレヴィスタ|ララプレイス|ファーストステージ|ワールドアイ|パークアクシス|プレジオ|メロディハイム|レオンコンフォート|シーズンフラッツ|ルクレ|HR FRONT|Luxe|LUXE|CITY SPIRE|メゾンボヌール|アコード中之島/],
  ["1件の家賃・間取りの形", /[0-9.]+万円\s*[/／]\s*管理費|間取り\s*[:：]|広さ\s*[:：]|築年(?:数|月)\s*[:：]|所在地\s*[:：]|交通\s*[:：]/],
];

/**
 * 費用の「抑えたい」（「初期費用を極力抑えたい」「管理費込みで5.5万くらいで抑えたい」「家賃もう少し抑えたい」）はお部屋の「抑えて（仮押さえ）」ではない。
 * 監査（scripts/audit-condition-source-gate.ts の B・D）で「旭区周辺で家賃もう少し抑えたいです」「初期費用を抑えたいです 今海外にて10月頭に日本に帰ります」を
 * 物件の話として落としていた → 費用の語の後ろ 10字以内の「抑え」は形の判定から外す
 */
const COST_SENSE_HOLD_RE = /(?:費用|家賃|賃料|予算|万|円|額|コスト|出費|支払い?|料金|金額|価格|安く|くらい|ぐらい|程度|負担)[^。\n！？!?]{0,10}?(?:抑え|押さえ|おさえ)/g;
/** 文を物件を物差しにした言い方・費用の「抑えたい」を消してから見る（問い合わせの形の判定用） */
function stripReferences(s: string): string {
  return s.replace(REFERENCE_AS_CONDITION_RE, " ").replace(COST_SENSE_HOLD_RE, " ");
}

/** 物件の問い合わせの形（当たった形の名前）。無ければ [] */
export function inquiryShapesOf(text: string | null | undefined): string[] {
  const s = stripReferences(nf(text));
  return INQUIRY_SHAPES.filter(([, re]) => re.test(s)).map(([k]) => k);
}

/** 「探す条件を言っている」印（問い合わせと同居した文を節に分けるかの判定） */
const SEARCH_REQUEST_RE = /探して|探し(?:たい|てい|中|直|ます)|で探|も探|探す|条件|以内|以下|以上|未満|エリア|周辺|辺り|あたり|付近|近辺|沿線|方面|紹介|提案して|似た|同じような|みたいな(?:物件|部屋|所|とこ)|ような(?:物件|部屋)|でもいい|でも良い|でも大丈夫|でもOK|も含め|広げ|他にも|他の物件|ほかの物件|別の物件|希望(?!日|時|の日|の時間)|(?:が|で|も)(?:いい|良い|よい)(?:な|です|かな|と思)/;
/** 場所の言い方でも「〇〇付近にある」（建物の所在）・「夕方あたり」（時間）は探す条件の印ではない */
const NOT_SEARCH_PLACE_RE = /(?:周辺|付近|近辺|辺り|あたり|エリア)(?:に(?:ある|あった|あります)|の(?:物件|マンション|お部屋|部屋))|(?:夕方|朝|昼|夜|午前|午後|月末|月初|週末|中旬|上旬|下旬|初旬|頃|[0-9]+時)(?:あたり|辺り|頃|ごろ)/g;
function hasSearchRequest(s: string): boolean {
  return SEARCH_REQUEST_RE.test(nf(s).replace(NOT_SEARCH_PLACE_RE, " "));
}

/** 条件の語（依頼だけの節と条件の節を分ける・地名は osaka-geo で見る） */
const COND_VOCAB_RE = /家賃|賃料|予算|[0-9.]+万|円|間取り|[1-4](?:K|DK|LDK|R)|ワンルーム|帖|畳|㎡|平米|広さ|広め|徒歩|駅近|築|[0-9一二三四五六七八九十]+階以上|階以外|最上階|高層階|ペット|オートロック|バス|トイレ|風呂|洗面|駐車場|駐輪|宅配|収納|キッチン|コンロ|エアコン|インターネット|Wi-?Fi|角部屋|日当たり|南向き|入居|初期費用|敷金|礼金|保証|エレベーター|区|市|線|エリア|周辺|沿線|階|防音|タワ|静か|騒音|向き|楽器|二人|同棲|子供|家具|ネット|ロフト|バルコニー|庭|審査|女性|セキュリティ|防犯|条件/;

/** 条件でない依頼だけの節（「新着でオススメ物件あればご連絡いただきたいです」） */
const REQUEST_ONLY_RE = /新着|オススメ|おすすめ|お勧め|ご連絡|連絡(?:ください|下さい|いただ|頂|を|して|お願い)|送って|お送り|ご提案|ご紹介|紹介して|教えて|お願いします|お願い致します|お願いいたします/;

function hasGeo(s: string): boolean {
  return stationsInText(s).length > 0 || wardsInText(s).length > 0 || linesInText(s).length > 0;
}
/** 依頼だけで条件の語も地名も無い節 */
export function isRequestOnlyClause(s: string): boolean {
  const t = nf(s);
  // 2026-09-30 YUMA「これからは駅10分以内でお願いします」: 「徒歩」の語が無い駅からの分数（駅 N 分以内）は条件の語の一覧に当たらず、
  //   「お願いします」だけの依頼として捨てていた（P4 が登録の徒歩を書けない）→ 徒歩の上限と読める節は条件の節（walk-minutes-text.ts と同じ読み）
  if (walkMinutesInText(t) !== null) return false;
  return REQUEST_ONLY_RE.test(t) && !COND_VOCAB_RE.test(t) && !hasGeo(t);
}

// ── 申込・審査の書類 ──────────────────────────────────────────────
/** 書式の見出し（行の頭に来る物だけ数える＝「転職先の勤務先が梅田なので梅田周辺で」のような条件の文を書類と読まない） */
const APPLY_HEADING_LINE_RE = /(?:^|\n)\s*[・•\-－*＊【◆■□●○①-⑳0-9.．)）]*\s*(勤務先名|勤務先所在地|勤務先住所|勤務先電話番号|勤務先|勤続年数|勤続|年収|雇用形態|保険種類|緊急連絡先|現住所|生年月日|続柄|氏名|フリガナ|本籍|在籍|業種|職種|役職|会社名|所属)/g;
/** 申込・審査の書類（勤務先所在地・現住所 等の見出しが2種類以上、または申込フォームの判定） */
export function isApplyPaperText(text: string | null | undefined): boolean {
  const t = nf(text);
  if (!t.trim()) return false;
  if (isApplicationFormMessage(t).detected) return true;
  const heads = new Set<string>();
  for (const m of t.matchAll(APPLY_HEADING_LINE_RE)) heads.add(m[1]);
  // 確かめ（2026-09-30）: 自己紹介（名前・現住所・勤務先）＋条件の一覧（①入居希望日 ②希望の家賃帯 ③希望の場所…）の最初の登録を
  //   書類と読み、条件の一覧を丸ごと落としていた（656d8f5e）→ 条件の見出しの方が多い条件の一覧は書類ではない
  if (heads.size >= 2 && conditionListLabels(t).size > heads.size) return false;
  return heads.size >= 2;
}

// ── 条件のフォーム ────────────────────────────────────────────────
const CONDITION_FORM_RE = /お部屋探しご条件|お部屋お探し中|下記(?:の)?条件で|以下(?:の)?条件で|希望条件\s*[:：]|【希望エリア】|【ご希望の家賃|【ご入居の時期】/;
/** 条件の一覧の見出し（行の頭・「・」「①」の後。うちのフォーマット以外の自前の一覧「エリア:平野区／家賃:8〜10万以下／間取り:1LDK」） */
const CONDITION_LIST_LABEL_RE = /(?:^|\n)\s*[・•\-－*＊【◆■□●○①-⑳0-9.．)）]*\s*(?:ご)?(?:希望の?)?(エリア|場所|地域|家賃|賃料|予算|間取り|広さ|入居|初期費用|築年数|駅徒歩|徒歩|条件|ペット|人数|駐車場|駐輪場|宅配ボックス|その他)/g;
function conditionListLabels(t: string): Set<string> {
  const labels = new Set<string>();
  for (const m of t.matchAll(CONDITION_LIST_LABEL_RE)) labels.add(m[1]);
  return labels;
}
/** 1件の物件の書き方（物件の貼り付け・資料の文字）。条件の一覧には出ない印 */
const LISTING_FIELD_RE = /物件名|号室|[0-9.]+万円\s*[/／]\s*管理費|築年月|物件種目|価格\s*[:：]|管理費等?\s*[:：]|共益費\s*[:：]|専有面積|建物階|所在地\s*[:：]|交通\s*[:：]|敷金\s*[:：]|礼金\s*[:：]|構造\s*[:：]|階建|取引態様|現況\s*[:：]|記入欄/;
/**
 * 自前の条件の一覧（見出し3種類以上＋「以下・以上・以内・まで・希望…」の望みの語・物件の書き方の印なし）。
 * 確かめ（2026-09-30・180日の実送信）: 「間取り:」「築年数:」を1件の物件の形として拾い、同じ通の印の無い行も物件の話の続きとして落としていた
 *   （c20d02f3 の最初の条件で 1LDK・入居10/1・ペット・保証人なし・独立洗面台…、3207c765 で家賃・初期費用・ペット可、b58d24e3 で 2LDK以上・築年数）
 */
export function isConditionListText(text: string | null | undefined): boolean {
  const t = nf(text);
  if (!t.trim() || LISTING_FIELD_RE.test(t)) return false;
  if (PROPERTY_LISTING_SHAPE_RE.test(t) || PORTAL_URL_RE.test(t) || PORTAL_SHARE_RE.test(t)) return false;
  return conditionListLabels(t).size >= 3 && /以下|以上|以内|まで|希望|程度|前後|くらい|ぐらい/.test(t);
}
function isConditionFormText(t: string): boolean {
  if (PROPERTY_LISTING_SHAPE_RE.test(t) || PORTAL_URL_RE.test(t) || PORTAL_SHARE_RE.test(t)) return false;
  return isFilledSumoraForm(t) || CONDITION_FORM_RE.test(t) || (t.match(/[①②③④⑤⑥⑦⑧⑨⑩]/g) ?? []).length >= 3 || isConditionListText(t);
}

// ── 画像の書き起こし（line-webhook の Vision「[画像] <内容>」）──────────────
/** 物件ページの印（SUUMO アプリの「物件情報」・号室・家賃/管理費・間取り・広さ・築年月・内見予約…） */
const IMAGE_PROPERTY_MARKERS: ReadonlyArray<RegExp> = [
  /物件情報/, /物件名/, /号室/, /SUUMO|suumo|アットホーム|HOME'?S|ホームズ/, /物件コード/, /取り?扱い?店舗/, /所在地/, /交通/,
  /[0-9.]+万円\s*[/／]?\s*管理費|管理費|共益費/, /敷金|礼金|敷\s*[:：]|礼\s*[:：]/, /間取り\s*[:：]?/, /専有面積|広さ\s*[:：]/, /築年月|築年数\s*[:：]|築[0-9]+年/,
  /内見予約|空室状況|問い合わせ|お問い合わせ/, /徒歩\s*[0-9]+\s*分/, /[0-9]+階建|[0-9]+階部分|[0-9]+\s*階(?:\s|$)/, /現況|入居可能/,
];
/** 検索条件の画面・条件のメモの印 */
const IMAGE_CONDITION_MARKERS_RE = /検索条件|絞り込|こだわり条件|希望条件|条件を(?:変更|保存|追加|指定|クリア|編集)|条件の(?:変更|追加|保存)|指定なし|下限なし|上限なし|エリアを選択|沿線を選択|駅を選択|路線を選択|この条件で|条件に合う|条件メモ/;
/** 条件のメモらしい語（物件ページの印が無い時だけ見る） */
const IMAGE_MEMO_WORDS_RE = /希望|以内|以上|まで|予算|エリア|条件/g;
/** 物件の1行（条件の画面のスクショでも、一覧に並ぶ物件の行は条件ではない） */
const IMAGE_PROPERTY_ROW_RE = /号室|物件名|[0-9.]+万円\s*[/／]|管理費|共益費|築[0-9]+年.*万円|万円.*築[0-9]+年|徒歩\s*[0-9]+\s*分.*万円|万円.*徒歩\s*[0-9]+\s*分/;

/**
 * 物件の一覧・物件ページの行（駅徒歩N分・N階建・築N年・部屋N階・㎡の区切り・敷/礼）。
 * 確かめ（2026-09-30・180日の画像 15件）: athome・SUUMO の検索結果の一覧には「人気の設備・条件」「条件を絞り込む」「条件を変更する」のボタンがあり、
 *   旧版はそれだけで条件の画面と読み、物件の行（「サンキャドマス南堀江／大阪市浪速区幸町1丁目／阪神なんば線「桜川」駅 徒歩6分」）を条件として残した
 *   （31e93a45 の希望エリアの「桜川」はこの形の画像から入った）→ 物件の行が2つ以上ある画面は物件の一覧（image_property）
 */
const IMAGE_LISTING_LINE_RE = /駅\s*」?\s*徒?歩\s*[0-9]+\s*分(?!以内|以下|まで)|[0-9]+\s*階建|築\s*[0-9]+\s*年(?!以内|以下|まで)|部屋\s*[0-9]+\s*階|部屋\s*[0-9]{3,4}|[0-9.]+\s*(?:㎡|m²|m2)\s*[/／|｜)]|敷\s*[/／]\s*礼|敷\s*[0-9]+\s*円|号室/;
/** 検索条件の画面そのものの印（結果の一覧のボタンでは出ない） */
const IMAGE_CONDITION_SCREEN_RE = /検索条件の(?:変更|設定|保存|編集)|この条件で(?:検索|探す)|指定なし|下限なし|上限なし|エリアを選択|沿線を選択|駅を選択|路線を選択|条件メモ|希望条件/;

/** 画像の見出しの行（image-label.ts の IMAGE_KIND_LABEL と同じ。書き起こしの【物件概要】【物件no.94】は当てない） */
const IMAGE_KIND_LABEL_LINE_RE = /^\s*【(?:物件の(?:資料|画面（ポータル）|画面（SNS・広告）|写真)|見積書・初期費用の明細|物件以外：[^】\n]{1,24}|種類不明)】[ \t]*\n?/;

/** 画像の書き起こしの種類 */
export function classifyImageTranscript(body: string | null | undefined): "image_property" | "image_condition" | "image_other" {
  const t = nf(String(body ?? "").replace(IMAGE_KIND_LABEL_LINE_RE, "")).trim();
  if (!t) return "image_other";
  const listingLines = t.split(/\n+/).filter((l) => IMAGE_LISTING_LINE_RE.test(l)).length;
  if (IMAGE_CONDITION_MARKERS_RE.test(t)) {
    if (listingLines >= 2) return "image_property";
    if (IMAGE_CONDITION_SCREEN_RE.test(t) || listingLines === 0) return "image_condition";
  }
  const hits = IMAGE_PROPERTY_MARKERS.filter((re) => re.test(t)).length;
  if (hits >= 2 || PROPERTY_LISTING_SHAPE_RE.test(t)) return "image_property";
  if ((t.match(IMAGE_MEMO_WORDS_RE) ?? []).length >= 2 && hits === 0 && (COND_VOCAB_RE.test(t) || hasGeo(t))) return "image_condition";
  return "image_other";
}

// ── 文・節に分ける ────────────────────────────────────────────────
function splitSentences(block: string): string[] {
  return block.split(/\n+|(?<=[。！？!?])/).map((s) => s.trim()).filter(Boolean);
}
function splitPieces(sentence: string): string[] {
  return sentence.split(/[、，,]+|[\s　]+/).map((s) => s.trim()).filter(Boolean);
}

/**
 * お客様の発言（1通、または MSG_SEP でつないだ連投）を見分け、条件として読んでよい部分だけを返す。
 * 入口の関所: 呼び出し側は conditionText が空なら条件の欄に何も書かない。conditionText だけを LLM に渡す。
 */
export function classifyConditionTurn(text: string | null | undefined): ConditionTurn {
  const raw = String(text ?? "");
  const blocks = raw.split(MSG_SEP_CHAR).map((b) => b.replace(/^\n+|\n+$/g, "")).filter((b) => b.trim());
  if (blocks.length === 0) return { kind: "empty", conditionText: "", dropped: [] };
  const kept: string[] = [];
  const dropped: ConditionTurn["dropped"] = [];
  const kinds = new Set<ConditionTurnKind>();

  for (const block0 of blocks) {
    const block = block0.trim();
    // ① 画像の書き起こし
    if (/^\[画像\]/.test(block)) {
      // 2026-10-01 竹内「画像が物件なのか物件以外なのか文字に出しておく」: 先頭の見出し（【物件の資料】【物件以外：検索条件の画面】…・image-label.ts）は
      //   書き起こしではないので外す（条件の行として LLM に渡さない）。image-label.ts がこのファイルを読むので import せず同じ見出しを並べる
      const body = block.replace(/^\[画像\]\s*/, "").replace(IMAGE_KIND_LABEL_LINE_RE, "");
      const k = classifyImageTranscript(body);
      kinds.add(k);
      if (k === "image_condition") {
        // 検索条件の画面でも、一覧に並ぶ物件の行は条件ではない
        const lines = body.split(/\n+/).map((l) => l.trim()).filter(Boolean);
        const condLines = lines.filter((l) => !IMAGE_PROPERTY_ROW_RE.test(nf(l)));
        for (const l of lines) if (!condLines.includes(l)) dropped.push({ text: l, kind: "image_property", reason: "条件の画面の中の物件の行" });
        if (condLines.length) kept.push(condLines.join("\n"));
      } else {
        dropped.push({ text: block, kind: k === "image_property" ? "image_property" : "image_other", reason: k === "image_property" ? "物件ページのスクショ" : "条件ではない画像" });
      }
      continue;
    }
    const t = nf(block);
    // ② 申込・審査の書類（書式の貼り返しも）
    if (isApplyPaperText(t)) {
      kinds.add("apply_form");
      dropped.push({ text: block, kind: "apply_form", reason: "申込・審査の書類" });
      continue;
    }
    // ③ 条件のフォーム（一覧）はそのまま条件
    if (isConditionFormText(t)) {
      kinds.add("condition_form");
      kept.push(block);
      continue;
    }
    // ④ 文ごとに見る。物件の URL・共有文がある通は、条件の依頼の印が無い文を全部物件の話とみなす（SUUMO の題「十三 1LDK 5階」）
    const blockIsPortal = PORTAL_URL_RE.test(t) || PROPERTY_LISTING_SHAPE_RE.test(t) || PORTAL_SHARE_RE.test(t);
    let blockKept = 0;
    let blockDropped = 0;
    // 絵文字だけ・記号だけの切れ端は見ない（「？」の後の「🙇‍♂️」）
    const sentences = splitSentences(block).filter((s) => /[\p{L}\p{N}]/u.test(s));
    const infos = sentences.map((sent) => {
      const s = nf(sent);
      const shapes = inquiryShapesOf(s);
      // 物件の URL・共有文と同じ通でも、平仮名の文で条件を言っている文（「離婚するので出来たら安めのとこでペット可があれば嬉しいです」）は条件。
      //   共有文の題（「日本橋 1DK 6階」「阪急京都本線 摂津市 徒歩5分」「2LDK 7.05万円」）は平仮名がほぼ無い
      const portalTitle = blockIsPortal && !((s.match(/[ぁ-ん]/g) ?? []).length >= 4 && (COND_VOCAB_RE.test(s) || hasGeo(s) || hasSearchRequest(s)) && !/物件|お部屋/.test(s));
      return { sent, s, shapes, inquiry: shapes.length > 0 || portalTitle };
    });
    // 物件の話がある通では、印の無い文（挨拶・「見積書」「10/1入居で仲介手数料…」）はその物件の話の続きと見る。
    //   残すのは「探す条件の印」「地名」がある文と、残した文のすぐ後に続く条件の語の文（「ペット2匹で、、、」）だけ
    const blockHasInquiry = infos.some((x) => x.inquiry);
    let prevKept = false;
    for (const { sent, s, shapes, inquiry } of infos) {
      if (!inquiry) {
        if (isRequestOnlyClause(s)) { dropped.push({ text: sent, kind: "request", reason: "依頼だけ（条件の語なし）" }); prevKept = false; continue; }
        // 地名だけの行（「阿波座駅 徒歩5分」＝物件の最寄り）は残さない。地名は探す条件の印（エリア・周辺・以内・がいい 等）と一緒の時だけ
        //   （YUMA の確認: 「レジデンス西本町 4階 402号室／家賃6.8万円 1K／阿波座駅 徒歩5分／こちら空いてますか？」で阿波座駅・徒歩5分を条件ブレインが書いた）
        //   地名を文で言っている（平仮名4字以上・物件の説明の形＝徒歩N分・N万円・カタカナの建物名が無い）文は残す（「もし、物件をお持ちであれば、御堂筋線が西中島南方から江坂」）
        const hira = (s.match(/[ぁ-ん]/g) ?? []).length;
        const geoSentence = hasGeo(s) && hira >= 4 && !/徒歩\s*[0-9]+\s*分|[0-9.]+万円|号室|[ァ-ヶー]{4,}/.test(s);
        if (blockHasInquiry && !hasSearchRequest(s) && !geoSentence && !((prevKept || blockIsPortal) && COND_VOCAB_RE.test(s) && hira >= 1)) {
          dropped.push({ text: sent, kind: "inquiry", reason: "物件の話の続き（条件の印なし）" }); blockDropped++; prevKept = false; continue;
        }
        kept.push(sent); blockKept++; prevKept = true;
        continue;
      }
      prevKept = false;
      if (!hasSearchRequest(stripReferences(s).replace(/https?:\/\/\S+/g, ""))) {
        dropped.push({ text: sent, kind: "inquiry", reason: shapes.join("・") || "物件の URL・共有文と同じ通" });
        blockDropped++;
        continue;
      }
      // ⑤ 物件の話と条件が同じ文に同居 → 節で分ける（「こちらの物件の空き状況と 桜川、九条エリアでおすすめの物件が…」）
      const parts: string[] = [];
      for (const p of splitPieces(sent)) {
        const ps = nf(p);
        if (PORTAL_URL_RE.test(ps) || /^https?:\/\//.test(ps)) { dropped.push({ text: p, kind: "inquiry", reason: "URL" }); blockDropped++; continue; }
        const pShapes = inquiryShapesOf(ps);
        if (pShapes.length) { dropped.push({ text: p, kind: "inquiry", reason: pShapes.join("・") }); blockDropped++; continue; }
        parts.push(p);
      }
      const joined = parts.join(" ").trim();
      if (joined && !isRequestOnlyClause(joined)) { kept.push(joined); blockKept++; prevKept = true; }
      else if (joined) dropped.push({ text: joined, kind: "request", reason: "依頼だけ（条件の語なし）" });
    }
    if (blockKept && blockDropped) kinds.add("mixed");
    else if (blockKept) kinds.add("condition");
    else if (blockDropped) kinds.add("property_inquiry");
  }

  const conditionText = kept.join("\n").trim();
  let kind: ConditionTurnKind;
  if (kinds.has("condition_form")) kind = "condition_form";
  else if (conditionText && (kinds.has("mixed") || (kinds.has("condition") && dropped.some((d) => d.kind !== "request")))) kind = "mixed";
  else if (conditionText && kinds.has("image_condition") && !kinds.has("condition")) kind = "image_condition";
  else if (conditionText) kind = "condition";
  else if (kinds.has("property_inquiry")) kind = "property_inquiry";
  else if (kinds.has("image_property")) kind = "image_property";
  else if (kinds.has("apply_form")) kind = "apply_form";
  else if (kinds.has("image_other")) kind = "image_other";
  else kind = dropped.length ? "property_inquiry" : "empty";
  return { kind, conditionText, dropped };
}

// ── 出口の手前の関所（書く前に・新しく足す値だけ見る）─────────────────────
/** 希望エリアに入ってはいけない語の形（地名ではない） */
const AREA_TOKEN_NOT_PLACE_RE = /(?:[0-9]+|[一二三四五六七八九十]+|何)階|号室|部屋|物件|https?:|空いて|抑え|押さえ|入居|連絡|したい|です|ます|ください|この|その|良かった|内見|内覧|勤務先|所在地|最寄り$/;

/** 希望エリアの語の芯（照合用） */
export function areaTokenCore(tok: string): string {
  return nf(tok).replace(/^大阪府/, "").replace(/[（(][^）)]*[）)]/g, "")
    .replace(/(周辺|エリア|付近|沿線|辺り|あたり|方面|全域|近辺|界隈|近く|最寄り)$/g, "").replace(/駅$/, "").trim();
}
export function splitAreaTokens(s: string | null | undefined): string[] {
  return nf(s).split(/[・、,，/／\s　]+|または|もしくは/).map((t) => t.trim()).filter(Boolean);
}

/** 語が文に根拠を持つか（そのまま・駅名の言い換え・区の言い換え・路線） */
export function areaTokenGroundedIn(tok: string, text: string): boolean {
  const core = areaTokenCore(tok);
  const t = nf(text);
  if (!core) return false;
  if (t.includes(core)) return true;
  const st = normStation(core);
  if (st && stationsInText(t).some((x) => x.station === st)) return true;
  const w = normWard(core);
  if (w && wardsInText(t).some((x) => x.ward === w)) return true;
  if (/線$/.test(core) && linesInText(t).some((x) => x.word.includes(core.replace(/線$/, "")) || core.includes(x.word))) return true;
  return false;
}
function isGeoToken(tok: string): boolean {
  const core = areaTokenCore(tok);
  return !!core && (isKnownStation(core) || !!normWard(core) || /[区市町村郡線]$/.test(core) || linesInText(core).length > 0 || stationsInText(core).length > 0);
}

const FREE_TEXT_FIELDS = ["preferences", "ng_points", "other_requests"] as const;
const AREA_SPLIT_RE = /[・、,，\n]/;

export type GateDrop = { field: string; value: string; reason: string };

/**
 * LLM が条件の発言から読み取った値（extracted）を、書く前に見分けの結果（turn）と照らして絞る（入口の関所）。
 *   - 希望エリア: 新しく足す語のうち、地名の形でない語（「4階のお部屋」）・条件の部分に根拠が無い語（落とした物件の話・書式にだけある語）を捨てる
 *   - こだわり・NG・その他: 新しく足す節のうち、物件の話の節・依頼だけの節を捨てる
 *   - その他の値（入居時期・家賃 等）: 落とした部分にだけあって条件の部分に無い値を捨てる（「4階のお部屋は11月初旬で…」の11月初旬）
 * existing に今の値を渡す（今ある語・節は捨てない＝消す側の出口にはしない）。
 */
export function gateExtractedConditions(
  extracted: Record<string, unknown>,
  turn: ConditionTurn,
  existing?: Record<string, unknown> | null,
): { extracted: Record<string, unknown>; dropped: GateDrop[] } {
  const out: Record<string, unknown> = { ...extracted };
  const drops: GateDrop[] = [];
  const cond = turn.conditionText;
  const droppedText = turn.dropped.map((d) => d.text).join("\n");

  // 希望エリア
  if (typeof out.desired_area === "string" && out.desired_area.trim()) {
    const existingAreaText = String(existing?.desired_area ?? "");
    const existingTokens = new Set(splitAreaTokens(existingAreaText).map(areaTokenCore));
    const keep: string[] = [];
    for (const tok of splitAreaTokens(out.desired_area)) {
      const core = areaTokenCore(tok);
      // 今の語の言い換え（登録「大阪市北区」→ LLM が「北区」と返す）も今ある語として残す。
      //   確かめ（2026-09-30）: 芯の完全一致だけだと「北区・福島区・西中島南方」の北区・福島区を根拠なしで落とし、
      //   丸ごと書く経路（条件ブレイン・P4 の置き換え）で登録の区を消していた（関所が「今ある値は消さない」を破る）
      if (existingTokens.has(core) || (existingAreaText && areaTokenGroundedIn(tok, existingAreaText))) { keep.push(tok); continue; }
      if (AREA_TOKEN_NOT_PLACE_RE.test(nf(tok))) { drops.push({ field: "desired_area", value: tok, reason: "地名の形でない（物件の話の断片）" }); continue; }
      if (inquiryShapesOf(tok).includes("建物名（ブランド）")) { drops.push({ field: "desired_area", value: tok, reason: "建物名" }); continue; }
      // 条件の部分に根拠が無い語は足さない（地名の辞書に無くても、条件の部分にそのまま書いてあれば町名・通称として残す）
      if (!areaTokenGroundedIn(tok, cond)) {
        drops.push({ field: "desired_area", value: tok, reason: areaTokenGroundedIn(tok, droppedText) ? "物件の話・書類の中にだけある" : (isGeoToken(tok) ? "条件の発言に根拠が無い" : "地名でなく条件の発言にも無い") });
        continue;
      }
      keep.push(tok);
    }
    if (keep.length) out.desired_area = keep.join("・");
    else delete out.desired_area;
  }

  // こだわり・NG・その他
  for (const f of FREE_TEXT_FIELDS) {
    const v = out[f];
    if (typeof v !== "string" || !v.trim()) continue;
    const existingFree = nf(existing?.[f] ?? "");
    const existingClauses = new Set(existingFree.split(AREA_SPLIT_RE).map((s) => s.trim()).filter(Boolean));
    const keep: string[] = [];
    const before = drops.length;
    for (const cl of v.split(AREA_SPLIT_RE).map((s) => s.trim()).filter(Boolean)) {
      // 今の値の中にそのまま含まれる節も今ある節（区切りが「、」「・」で違うだけの時に消さない）
      if (existingClauses.has(nf(cl)) || (nf(cl).length >= 2 && existingFree.includes(nf(cl)))) { keep.push(cl); continue; }
      const shapes = inquiryShapesOf(cl);
      if (shapes.length) { drops.push({ field: f, value: cl, reason: `物件の話（${shapes.join("・")}）` }); continue; }
      if (isRequestOnlyClause(cl)) { drops.push({ field: f, value: cl, reason: "依頼だけ（条件ではない）" }); continue; }
      keep.push(cl);
    }
    // 落とす節が無ければ値をそのまま（区切りを書き換えない）
    if (drops.length === before) continue;
    if (keep.length) out[f] = keep.join("・");
    else delete out[f];
  }

  // その他の値: 落とした部分にだけある値
  if (droppedText) {
    for (const [f, v] of Object.entries(out)) {
      if (f === "desired_area" || (FREE_TEXT_FIELDS as readonly string[]).includes(f)) continue;
      if (v === null || v === undefined || v === "") continue;
      if (existing && String(existing[f] ?? "") === String(v)) continue;
      const forms = valueForms(v);
      if (!forms.length) continue;
      const inCond = forms.some((x) => nf(cond).includes(x));
      const inDropped = forms.some((x) => nf(droppedText).includes(x));
      if (inDropped && !inCond) { drops.push({ field: f, value: String(v), reason: "物件の話の中にだけある値" }); delete out[f]; }
    }
  }
  return { extracted: out, dropped: drops };
}

/** 値の文中での書き方の候補（70000 → 7万・7.0万・70000・70,000 ／ 文字列はそのまま） */
function valueForms(v: unknown): string[] {
  if (typeof v === "number" && Number.isFinite(v)) {
    const out = new Set<string>([String(v), v.toLocaleString("en-US")]);
    if (v >= 10000) { const man = v / 10000; out.add(`${man}万`); out.add(`${man.toFixed(1)}万`); }
    return [...out].filter((x) => x.length >= 2);
  }
  const s = nf(v).trim();
  return s.length >= 2 ? [s] : [];
}

// ── ブレインの橋の希望エリアの足し方 ─────────────────────────────────────
/**
 * ブレインの橋（generate-draft-bg-async applyBrainConditionChange）が読んだ希望エリアを今のエリアとどう合わせるか。
 *   差し替えの言葉（condition-intent classifyByKeywords が REPLACE ＝「じゃなくて・ではなく・に変えて・に変更・やっぱり・にしてほしい」）→ 置き換え
 *   除外（EXCLUDE）→ 書かない（null）
 *   それ以外（追加・緩和・分からない）→ 今のエリアに足す（今の語は消さない）
 * 旧は常に置き換えで、足されただけのエリア・物件の問い合わせの建物名で登録の区が消えていた。
 */
export function mergeAreaForBrainBridge(input: { current: string | null | undefined; extracted: string | null | undefined; conditionText: string; conditionChangeType?: string | null; intent?: "FORMAL" | "ADD" | "REPLACE" | "EXCLUDE" | null }): string | null {
  const cur = splitAreaTokens(input.current);
  const add = splitAreaTokens(input.extracted);
  if (!add.length) return input.current?.trim() ? input.current : null;
  if (input.intent === "EXCLUDE") return null;
  if (!cur.length || (input.intent === "REPLACE" && input.conditionChangeType !== "condition_relax")) return add.join("・");
  const curCores = new Set(cur.map(areaTokenCore));
  const fresh = add.filter((t) => !curCores.has(areaTokenCore(t)));
  return [...cur, ...fresh].join("・");
}

// ── エリアの入れ方（area_mode）────────────────────────────────────────
/**
 * 希望エリアの語から area_mode を決める。classify-area-modes の cron・拡張の setupAreaModeSelector と同じ決まり:
 *   駅だけ → station ／ 区・市だけ → ward ／ **駅と「〇〇区・〇〇郡」が混ざったら ward**（区の指定を捨てない）／ 何も分からない → auto
 * 旧の line-webhook-text inferAreaMode は「駅が1つでもあれば station」で、黒明様の「大阪市西区・大阪市浪速区」に
 * 駅1つ（西中島南方）が足された時に区が検索から落ちた（9/29 の検索2回が wards:[]）。
 */
export function decideAreaMode(tokens: string[], isStation: (t: string) => boolean): "station" | "ward" | "auto" {
  const toks = tokens.filter((t) => t.length >= 2 && !/^[0-9０-９]/.test(t) && !t.endsWith("線"));
  if (toks.length === 0) return "auto";
  const isRegion = (t: string) => /[市区郡]/.test(t) || /(?:市内|府内|県内|都内)$/.test(t);
  const st = toks.filter((t) => isStation(t)).length;
  const specificWard = toks.some((t) => !isStation(t) && /[区郡]$/.test(t));
  const rg = toks.filter((t) => isRegion(t)).length;
  if (st > 0 && specificWard) return "ward";
  if (st > 0) return "station";
  if (rg > 0) return "ward";
  return "auto";
}
