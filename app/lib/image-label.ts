// app/lib/image-label.ts
// お客様が送った画像に「何の画像か（物件か・物件以外か）」の見出しを付ける（純関数・DB 依存なし）。
//
// 2026-10-01 竹内「送られてきた画像が物件なのか、物件以外なのか分かるためにも、画像分析したのを
//   今ある本人確認書類のように文字に出しといたら、文やAIXでの判断の質が上がる」
//
// 【形】messages.text = "[画像] 【見出し】\n<書き起こし>"
//   ・先頭の「[画像]」は変えない（"[画像]" ちょうど＝読み取り前、"[画像] " 始まり＝読み取り文、の判定が各所にある）
//   ・見出しは1行目だけ。書き起こしは物件の画像では残す（スタッフ・ブレイン・物件の特定 own-property-match が使う）
//   ・本人確認書類・収入証明書・申込書は従来どおり「[画像] 本人確認書類」等の種類だけ（id-document-guard / personal-document-guard。
//     received-document がこの形そのものを読み戻すので形を変えない）
//
// 【決め方（入口・出口の線）】
//   見出しは**読み取り文に付ける入口**の材料（本文の書き換えではない）が、ブレインの AIX の矯正（brain-core の
//   correction:image_only・信号3.5）にも使う。物件／物件以外を**取り違えた見出しは無い方がまし**なので、
//   ・Vision の分類（floor_plan / property_photo / estimate）はそのまま採る（実データ 241件で物件以外の取り違え 0件・下の監査）
//   ・分類が other / 無い物は、中身の指紋が強く当たった時だけ物件／物件以外の見出しにする。
//     当たらなければ【種類不明】（物件とも物件以外とも言わない）
//   実データの線は scripts/audit-image-label.ts（2026-10-01・お客様の画像 948件・6/06〜）
//
// 【Vision の TYPE の取りこぼし】
//   1行目を「TYPE: id_document」でなく「id_document」だけで返すことがあり（実データ 14件・うち身分証・保証会社の申込書 3件）、
//   旧の解析（/^TYPE:/）は種類を other にして「id_document」の行ごと本文に保存していた＝個人情報が書き起こしのまま残った。
//   parseVisionTypeOutput で「TYPE:」の有無・** 囲み・全角コロンを問わず読む。

import { classifyImageTranscript } from "@/app/lib/condition-source-gate";

/** Vision の分類（line-webhook の TYPE と同じ値） */
export const VISION_IMAGE_TYPES = ["estimate", "floor_plan", "property_photo", "id_document", "income_document", "other"] as const;
export type VisionImageType = (typeof VISION_IMAGE_TYPES)[number];

/** 見出しの大きな区分（ブレインの判断に使う） */
export type ImageGroup = "property" | "estimate" | "non_property" | "unknown";

export type ImageKind =
  | "property_material" | "property_screen" | "property_ad" | "property_photo"
  | "estimate"
  | "payment" | "procedure" | "defect_report" | "chat" | "search_condition" | "route"
  | "pet_photo" | "person_photo" | "pet_document"
  | "unknown";

/** 見出しの文字（会話本文にそのまま入る。received-document の書類名の語＝申込書・口座・保険 等を含めない） */
export const IMAGE_KIND_LABEL: Readonly<Record<ImageKind, string>> = {
  property_material: "物件の資料",
  property_screen: "物件の画面（ポータル）",
  property_ad: "物件の画面（SNS・広告）",
  property_photo: "物件の写真",
  estimate: "見積書・初期費用の明細",
  payment: "物件以外：振込・支払いの控え",
  procedure: "物件以外：契約・入居の手続きの画面",
  defect_report: "物件以外：不具合の報告",
  chat: "物件以外：やり取りのスクショ",
  search_condition: "物件以外：検索条件の画面",
  route: "物件以外：経路・乗換の画面",
  pet_photo: "物件以外：ペットの写真",
  person_photo: "物件以外：人物の写真",
  pet_document: "物件以外：ペットの書類",
  unknown: "種類不明",
};

const KIND_GROUP: Readonly<Record<ImageKind, ImageGroup>> = {
  property_material: "property", property_screen: "property", property_ad: "property", property_photo: "property",
  estimate: "estimate",
  payment: "non_property", procedure: "non_property", defect_report: "non_property", chat: "non_property",
  search_condition: "non_property", route: "non_property", pet_photo: "non_property", person_photo: "non_property",
  pet_document: "non_property",
  unknown: "unknown",
};

/** 書き起こしを残さない種類（個人情報が載る） */
// 2026-10-09 振込・支払いの控え（払込受領証・振込完了の画面・ご利用明細）も書き起こしを残さない:
//   実データ（お客様の画像の全期間）で支払いの控え 6件の全部に 振込依頼人名・お客様氏名・携帯番号・引落口座の番号 が残っていた。
//   書き起こしを読む所は無い（物件の取り出し・条件の読み取りは物件以外を飛ばす）＝見出し「支払いの控えが届いた」だけで足りる。
//   戻す: IMAGE_PAYMENT_DROP=off（見出し＋書き起こしの旧の形）
const DROP_TRANSCRIPT: ReadonlySet<ImageKind> = new Set<ImageKind>(["pet_document", "payment"]);
const dropsTranscript = (kind: ImageKind): boolean =>
  DROP_TRANSCRIPT.has(kind) && !(kind === "payment" && process.env.IMAGE_PAYMENT_DROP === "off");

/**
 * 残す書き起こしの中の携帯番号（070/080/090）を伏せる。
 * 2026-10-09: 種類が決まらない書類の写真（重なった書類）に携帯番号だけ残っていた（1件）。
 *   物件の画像（間取り図・物件写真 244件）・見積書の書き起こしに携帯番号は 0件（業者の番号は 0120・06 等）＝物件の話を落とさない。
 *   戻す: IMAGE_MOBILE_MASK=off
 */
const MOBILE_IN_TRANSCRIPT_RE = /0[789]0[-‐－ー\s]?\d{4}[-‐－ー\s]?\d{4}/g;
export function maskTranscriptMobile(t: string): string {
  if (process.env.IMAGE_MOBILE_MASK === "off") return t;
  return t.replace(MOBILE_IN_TRANSCRIPT_RE, "（携帯番号）");
}

// ── Vision の出力の解析 ─────────────────────────────────────────────
const TYPE_TOKEN = VISION_IMAGE_TYPES.join("|");
/** 1行目の種類（「TYPE: x」「**TYPE:** x」「TYPE：x」「x」だけ・「# x」） */
const TYPE_LINE_RE = new RegExp(`^[\\s#*]*(?:TYPE\\s*\\**\\s*[:：]\\s*\\**\\s*)?(${TYPE_TOKEN})\\b\\**\\s*(.*)$`, "i");

/**
 * Vision の返事（1行目に種類・2行目以降に書き起こし）を分ける。
 * 種類が読めなければ旧と同じ（中身があれば other・無ければ空）。
 */
export function parseVisionTypeOutput(raw: string | null | undefined): { imageType: string; content: string } {
  const text = (raw ?? "").trim();
  if (!text) return { imageType: "", content: "" };
  const nl = text.indexOf("\n");
  const first = nl < 0 ? text : text.slice(0, nl);
  const rest = nl < 0 ? "" : text.slice(nl + 1);
  const m = first.match(TYPE_LINE_RE);
  if (m) {
    // 同じ行の残り（「TYPE: other 物件名：…」）は書き起こしに戻す
    const tail = (m[2] ?? "").trim();
    return { imageType: m[1].toLowerCase(), content: [tail, rest].filter((s) => s.trim()).join("\n").trim() };
  }
  // 「TYPE:」はあるが値が一覧に無い行は捨てる（種類の行を本文に残さない）
  if (/^[\s#*]*TYPE\s*\**\s*[:：]/i.test(first)) return { imageType: "other", content: rest.trim() };
  return { imageType: "other", content: text };
}

/** 書き起こしの先頭に残った種類の行（保存済みの行の「[画像] id_document\n…」）を外す。外した種類も返す */
export function splitLeakedTypeLine(content: string | null | undefined): { leakedType: string | null; content: string } {
  const t = (content ?? "").trim();
  const nl = t.indexOf("\n");
  const first = (nl < 0 ? t : t.slice(0, nl)).trim();
  const m = first.match(new RegExp(`^[\\s#*]*(?:TYPE\\s*[:：]\\s*)?(${TYPE_TOKEN})[\\s*]*$`, "i"));
  if (!m) return { leakedType: null, content: t };
  return { leakedType: m[1].toLowerCase(), content: nl < 0 ? "" : t.slice(nl + 1).trim() };
}

// ── 中身の指紋 ────────────────────────────────────────────────────
/** 文字が無い写真（Vision が「テキストは含まれていません。…の写真です」と書く形） */
const NO_TEXT_PHOTO_RE = /(?:テキスト|文字|会話|情報)[^。\n]{0,20}(?:含まれて(?:い)?ません|ありません|写っていません)/;
const PET_WORD_RE = /犬|猫|イヌ|ネコ|子犬|子猫|ペット|ハスキー|柴犬|シバイヌ|チワワ|トイプードル|うさぎ|ハムスター|インコ|フェレット/;
const PERSON_WORD_RE = /人物|顔写真|ポートレート|自撮り|セルフィー/;
/** ペットの書類（飼い主の氏名・住所が載る → 書き起こしを残さない） */
const PET_DOCUMENT_RE = /狂犬病予防注射済証|狂犬病.{0,6}(?:注射|予防).{0,6}(?:済|証明)|犬の鑑札|ワクチン接種証明書/;
/** 振込・支払いの控え（振込先は弊社の口座。物件ではない） */
//   2026-10-09: 振込の控え・振込明細・領収書（「上記正に領収」「但し」の欄つき）も足した（見積書の「振り込み期日」は当てない）
const PAYMENT_RE = /振込完了|振込を(?:正常に)?受け付け|払込受領証|お振込金額|振込予定日|ご利用明細[\s\S]{0,120}振込|振込(?:の)?(?:控え|明細書?|受付書)|領収(?:書|証)[\s\S]{0,200}(?:上記(?:の)?(?:金額を)?正に|但し)/;
/** 契約・入居の手続き（電子契約・口座振替・保険・入居後のアプリ・申込の管理画面・誓約書類） */
const PROCEDURE_RE = /電子契約|Web\s*口座振替|口座振替(?:登録|受付|手続)|ネット口座振替|GMOサイン|署名(?:が)?完了|ruum|生活支援サービス|お部屋の各種手続き|少額短期保険|ご契約一覧|本申込|入居予定者|申込み?(?:が)?完了|駐車場使用契約書|誓約書|差入書|重要事項説明書\s*[✓✔]|賃貸借契約書\s*\/|契約手続き/;
/** 不具合の報告（入居後の設備の不具合フォーム） */
const DEFECT_RE = /不具合(?:箇所|のある|の詳細|を拡大)/;
/** やり取りのスクショ（LINE・メール・他社からの文面） */
const CHAT_RE = /既読\s*\d{1,2}:\d{2}|【メッセージ\s*\d*】|送信者\s*[:：]|LINE会話|^\s*(?:#\s*)?(?:お世話になっております|先ほどは(?:お忙しい中)?)/m;
/** 経路・乗換（地図アプリ・乗換案内） */
const ROUTE_RE = /乗換\s*\d+\s*回|ルートメモ|IC優先|経路(?:検索|案内)/;
/** SNS・広告（自社の TikTok「革命のスモラ」「ギガ賃貸」・他社の SNS 投稿） */
const AD_RE = /関連するコンテンツを見つける|革命のスモラ|ギガ賃貸|SUMORA|スモラ|#大阪賃貸|#お部屋探し|すてきなコメントを書く|フォロワー|爆モテ不動産|【物件\s*no\.?\s*\d+】/i;
/** 検索条件の画面の語 */
const SEARCH_SCREEN_RE = /検索条件|こだわり条件|絞り込|希望条件|条件を(?:変更|保存|追加|指定|クリア|編集)|エリアを選択|沿線を選択|駅を選択|路線を選択/;
/** 物件の資料（マイソク・募集図面・業者間サイトの物件概要） */
//   「物件名：」は入れない（Vision がポータルの画面を書き起こす時に自分で「**物件名:**」と見出しを付ける）
const MATERIAL_RE = /物件種目|号室名|【物件概要】|取引態様|募集図面/;
/** ポータルの物件画面（SUUMO・HOME'S・アットホーム・アプリの物件ページ） */
const PORTAL_RE = /SUUMO|suumo|LIFULL|HOME'?S|アットホーム|at\s*home|物件情報|物件詳細|内見予約|空室状況|お問い合わせ|Apamanshop|アパマン|CANARY|カナリー|物件コード|最近見た物件|お気に入り/i;
/** 物件の値（家賃・間取り・広さ）＝物件の画面と言ってよい強さ */
const PRICE_RE = /[0-9０-９.]+\s*万円|賃料|家賃\s*[:：]?\s*[0-9０-９]|(?<![¥￥0-9])[0-9]{2,3},[0-9]{3}\s*円/;
const LAYOUT_RE = /[1-5]\s*(?:R|K|DK|LDK|SLDK)\b|ワンルーム|[0-9.]+\s*(?:㎡|m²|m2)/;

function hasPropertyValues(t: string): boolean {
  return PRICE_RE.test(t) && LAYOUT_RE.test(t);
}

/**
 * 画像の種類を決める。
 * imageType: Vision の分類（floor_plan / property_photo / estimate / other / 空）。本人確認書類・収入証明書は呼び出し側が先に処理する。
 * content: 書き起こし（"[画像] " を除いた物）
 */
export function classifyCustomerImage(imageType: string | null | undefined, content: string | null | undefined): ImageKind {
  const type = (imageType ?? "").trim().toLowerCase();
  const t = (content ?? "").normalize("NFKC").trim();

  // 個人情報の載る書類は分類に関わらず先に（書き起こしを捨てる）
  if (PET_DOCUMENT_RE.test(t)) return "pet_document";

  // Vision が物件・見積書と分けた物は採る（実データで物件以外の取り違え 0件）。中の種類だけ指紋で分ける
  if (type === "estimate") return PAYMENT_RE.test(t) ? "payment" : "estimate";
  if (type === "floor_plan" || type === "property_photo") {
    if (AD_RE.test(t)) return "property_ad";
    if (MATERIAL_RE.test(t)) return "property_material";
    if (PORTAL_RE.test(t)) return "property_screen";
    if (NO_TEXT_PHOTO_RE.test(t) || type === "property_photo") return "property_photo";
    return "property_material";
  }

  // other / 分類なし: 強い指紋が当たった時だけ見出しを付ける（外れは【種類不明】）
  if (!t) return "unknown";
  if (NO_TEXT_PHOTO_RE.test(t)) {
    if (PET_WORD_RE.test(t)) return "pet_photo";
    if (PERSON_WORD_RE.test(t)) return "person_photo";
    return "unknown";
  }
  if (PAYMENT_RE.test(t)) return "payment";
  if (DEFECT_RE.test(t)) return "defect_report";
  if (PROCEDURE_RE.test(t)) return "procedure";
  if (CHAT_RE.test(t)) return "chat";
  if (ROUTE_RE.test(t)) return "route";
  // SNS の物件の投稿（自社の TikTok 等）: 広告の印＋間取り（1LDK 等）
  if (AD_RE.test(t) && LAYOUT_RE.test(t)) return "property_ad";
  const transcriptKind = classifyImageTranscript(t);
  // 検索条件の画面: condition-source-gate の「条件の画面」は語の数で決める（「申込み完了」の画面も当たった）ので、画面の語を必須にする
  if (transcriptKind === "image_condition" && SEARCH_SCREEN_RE.test(t)) return "search_condition";
  // 物件の画面: 物件ページの印が2つ以上（condition-source-gate と同じ線）＋物件の値（家賃と間取り／家賃とポータルの印）
  if (transcriptKind === "image_property" && (hasPropertyValues(t) || (PRICE_RE.test(t) && PORTAL_RE.test(t)))) {
    if (MATERIAL_RE.test(t)) return "property_material";
    return "property_screen";
  }
  return "unknown";
}

export function imageKindGroup(kind: ImageKind): ImageGroup {
  return KIND_GROUP[kind];
}

/** 保存する本文（"[画像] 【見出し】\n<書き起こし>"）。書き起こしが空なら "[画像]"（読み取り前・失敗と同じ形を保つ） */
export function labeledImageText(kind: ImageKind, content: string | null | undefined): string {
  const t = (content ?? "").trim();
  if (!t) return "[画像]";
  const head = `[画像] 【${IMAGE_KIND_LABEL[kind]}】`;
  return dropsTranscript(kind) ? head : `${head}\n${maskTranscriptMobile(t)}`;
}

// ── 保存済みの本文から読む ──────────────────────────────────────────
const LABEL_TO_KIND: ReadonlyMap<string, ImageKind> = new Map(
  (Object.keys(IMAGE_KIND_LABEL) as ImageKind[]).map((k) => [IMAGE_KIND_LABEL[k], k]),
);
/** 本文の先頭の見出し（"[画像] 【物件の資料】…"）。見出しの一覧にある物だけ（書き起こしの【物件no.94】等は拾わない） */
const SAVED_LABEL_RE = /^\s*\[画像\]\s*【([^】\n]{1,40})】/;

/** 保存済みの本文の見出しの種類（無ければ null） */
export function savedImageKind(text: string | null | undefined): ImageKind | null {
  const m = (text ?? "").match(SAVED_LABEL_RE);
  if (!m) return null;
  return LABEL_TO_KIND.get(m[1]) ?? null;
}

/** 書き起こしの先頭の見出しの行を外す（物件名の取り出し・条件の読み取りなど、書き起こしだけを見たい所用） */
export function stripImageLabel(body: string): string {
  const m = body.match(/^\s*【([^】\n]{1,40})】[ \t]*\n?/);
  if (m && LABEL_TO_KIND.has(m[1])) return body.slice(m[0].length);
  return body;
}

/**
 * お客様の画像の大きな区分（ブレイン用）。本文の見出し → 種類の名前だけの書類 → image_type の順に見る。
 * 見出しの無い昔の行・読み取り前は image_type だけで決める（other / 無し＝unknown）。
 */
export function customerImageGroup(text: string | null | undefined, imageType: string | null | undefined): ImageGroup | "personal_document" | null {
  const t = (text ?? "").trim();
  if (!/^\[画像\]/.test(t)) return null;
  const kind = savedImageKind(t);
  if (kind) return imageKindGroup(kind);
  const type = (imageType ?? "").trim().toLowerCase();
  if (type === "id_document" || type === "income_document") return "personal_document";
  if (type === "floor_plan" || type === "property_photo") return "property";
  if (type === "estimate") return "estimate";
  return "unknown";
}
