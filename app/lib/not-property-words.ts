// app/lib/not-property-words.ts — 「物件名ではない語」の共通の表（純関数・画面とサーバで共用・サーバ専用の import なし）
//   2026-10-13 未桜事例のレビュー: お客様の名前だけの1通（customer-property-names.nameOnlyMessage）と、こちらの確認の約束の物件名
//   （action-ledger.confirmPropertyNameOf）が、設備・SNS/ポータル名・間取り・人の名前を物件名に読んでいた。表を1つにして両方で使う。
//   単独だと物件名か曖昧な語（ミナミ・レオパレス）は外す方を選ぶ（誤って別の物件に結ぶ事を0にするのが先）。

/** 設備・手続き・その他（片仮名・英字）。語の一部に含まれていても外す */
export const NOT_PROPERTY_WORD_RE = /インターネット|ネット|エアコン|ペット|オートロック|クリーニング|キャンセル|フリーレント|カード|ガス|コンロ|バス|トイレ|キッチン|ベランダ|クローゼット|カウンター|モニター|ボックス|フォーマット|オンライン|スケジュール|ローン|クレジット|ポイント|キャンペーン|プラン|サイト|アプリ|メール|ライン|LINE|wifi|Wi-?Fi|ロフト|カーテン|エレベーター|セキュリティ|ウォシュレット|リフォーム|リノベ|オーナー|トランクルーム|デザイナーズ|ルームシェア|シェアハウス|ワンルーム|オッケー|オーケー/i;

/** SNS・ポータル・動画の名前（その名前だけの1通は物件名ではない） */
export const SNS_PORTAL_RE = /tiktok|ティックトック|インスタ|instagram|youtube|ユーチューブ|twitter|ツイッター|facebook|フェイスブック|suumo|スーモ|homes|ホームズ|athome|アットホーム|ホームメイト|エイブル|ミニミニ|アパマン|いえらぶ|ieyasu|イエヤス|chintai|チンタイ|google|グーグル|マップ/i;

/** 間取り（1LDK・2DK・1R・ワンルーム） */
export const LAYOUT_RE = /[0-9０-９]\s*(?:S?LDK|SDK|DK|K|R)(?![A-Za-z])|ワンルーム/i;

/** 単独だと物件名か曖昧な語（そのまま1語で来た時だけ外す） */
const AMBIGUOUS_ALONE_RE = /^(?:ミナミ|キタ|レオパレス|ダイワ|セキスイ|シャーメゾン|マンション|アパート|ハイツ|コーポ)$/;

/** 人の名前の形: 英字だけ／カタカナだけの2語を空白で挟む（ヤマダ ハナコ・Yuma Takeuchi）。カタカナ6〜8字の1語の名前（ヤマダハナコ）も */
const PERSON_TWO_WORDS_RE = /^(?:[A-Za-z]+\s+[A-Za-z]+|[ァ-ヶー]+[\s　]+[ァ-ヶー]+)$/;
const PERSON_KATAKANA_ONE_RE = /^(?:[ァ-ヶ]{2,4})(?:[ァ-ヶ]{2,4})$/;
/** 人の名前によく使う語尾（カタカナの名前の後ろ） */
const PERSON_GIVEN_TAIL_RE = /(?:コ|ミ|カ|ナ|キ|ヤ|タ|ト|オ|ジ|イ|マ|ヒロ|ユウ|ユキ|ハナ|サキ|ミキ|ケンタ|ショウタ|ユウマ|ダイキ)$/;
const BUILDING_HINT_RE = /コート|テラス|マンション|ハイツ|コーポ|レジデンス|ハイム|メゾン|荘|ビル|タワー|コート|パレス|ヴィラ|ハウス|ガーデン|プラザ|ヒルズ|レジデンシャル|グラン|シティ|パーク|ステージ|スクエア|アーバン|プレサンス|エスリード|コンフォリア|クリエオーレ|フジパレス/;

/** 人の名前に見えるか（建物を思わせる語がある時は人の名前にしない） */
export function looksLikePersonName(s: string): boolean {
  const t = s.normalize("NFKC").trim();
  if (BUILDING_HINT_RE.test(t)) return false;
  if (PERSON_TWO_WORDS_RE.test(t)) return true;
  // 空白なしのカタカナ6〜8字で、名前によく使う語尾（ヤマダハナコ）。長い建物名（レジュールアッシュ）は8字を超える・語尾が違う
  if (PERSON_KATAKANA_ONE_RE.test(t) && Array.from(t).length >= 6 && PERSON_GIVEN_TAIL_RE.test(t)) return true;
  return false;
}

/**
 * 物件名の候補として外すべき語か（設備・SNS/ポータル・間取り・人の名前・単独で曖昧な語）。
 * 名前の候補（号室・語尾を取った後の文字）を渡す。
 */
export function isNotPropertyName(name: string): boolean {
  const t = name.normalize("NFKC").trim();
  if (!t) return true;
  if (NOT_PROPERTY_WORD_RE.test(t) || /^OK$/.test(t)) return true;
  if (SNS_PORTAL_RE.test(t)) return true;
  if (LAYOUT_RE.test(t)) return true;
  if (AMBIGUOUS_ALONE_RE.test(t)) return true;
  if (looksLikePersonName(t)) return true;
  return false;
}
