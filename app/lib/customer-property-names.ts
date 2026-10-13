// app/lib/customer-property-names.ts
// お客様が送ってくれた物件（ポータルの共有文）から物件名の候補を取り出す（純関数・DB 依存なし）。
//
// 2026-09-16 竹内（YUYA 事例）「物件名表示ボタンつくって、押したらお客さんが送ってくれた物件が表示されるようにする。
//   それで会話を合わせるボタンおしたら物件名が入るようにする」:
//   AIX【物件確認した】→物件なかった の画面は、物件名を手で打つかスクショを選んで AI に読ませるしかなかった。
//   お客様は SUUMO の共有文で物件名を送ってきている（YUYA 13:27「募集終了て言われた物件がSUUMOで即入居でありますが…／
//   プルス新北野 3階／https://suumo.jp/…／by SUUMO」→ スタッフの返信 13:37 は「プルス新北野ですが…」）。
//
// 実データ（120日・お客様の URL つき発言）の形は3種類:
//   A. SUUMO:  「プルス新北野 3階 / https://suumo.jp/… / by SUUMO」        → 1行目が物件名＋階（物件名が取れる）
//   B. ニフティ: 「地下鉄堺筋線 恵美須町 徒歩5分 / 1R 5.2万円 / [詳細] / URL」 → 駅・徒歩・間取り・家賃だけ（物件名が無い）
//   C. athome: 「物件名：大阪市旭区 太子橋１丁目 （太子橋今市駅 ） 2階 １ＬＤＫ / …」→「物件名：」の値
// B は物件名が無いので候補にしない（設計知見「共有文の駅名・徒歩分で物件を呼ばない」＝shared-property-ref と同じ考え）。

import { isNotPropertyName } from "./not-property-words";

export type CustomerPropertyCandidate = {
  /** 物件名欄に入れる値（建物名。末尾の「N階」は外す） */
  name: string;
  /** 画面に出す文字（「プルス新北野 3階」のように階も見せる） */
  label: string;
  /** 元の共有文の URL（あれば） */
  url: string | null;
  /** お客様が送った時刻（ISO） */
  at: string | null;
};

type Msg = { sender?: string | null; text?: string | null; createdAt?: string | null; created_at?: string | null; rawCreatedAt?: string | null };

const PORTAL_URL_RE = /https?:\/\/[^\s）)」』]+/;
/** 物件ではないリンク（アプリの案内・LINE・TikTok） */
const NON_PROPERTY_URL_RE = /\/apps?\/?(?:$|[?#])|(?:^|\/\/)(?:[\w.-]*\.)?(?:line\.me|lin\.ee|tiktok\.com|apps\.apple\.com|play\.google\.com)\b/i;
/** 末尾の階数（「3階」「10階」） */
const FLOOR_TAIL_RE = /\s*[0-9０-９]{1,3}\s*階\s*$/;
/** 間取り（この語がある行は駅名＋間取りの可能性があるので物件名にしない。例: 「堺筋本町 1LDK 6階」） */
const LAYOUT_RE = /[0-9０-９]?\s*(?:SLDK|LDK|SDK|DK|K|R)(?![a-zA-Z])|１ＬＤＫ|１Ｋ|１Ｒ|ＬＤＫ/;
/** 家賃・徒歩分（共有文の描写＝物件名ではない） */
const DESCRIPTOR_RE = /徒歩\s*[0-9０-９]+\s*分|[0-9０-９.．]+\s*万円|価格[:：]|所在地[:：]|交通[:：]|物件種目[:：]/;
/** 建物名らしいか（カタカナ・漢字・英字が2文字以上続く） */
const NAME_LIKE_RE = /[ァ-ヶー][ァ-ヶー・\s]{1,}|[一-龯]{2,}|[A-Za-zＡ-Ｚａ-ｚ][A-Za-zＡ-Ｚａ-ｚ\s]{2,}/;

const normalize = (s: string) => s.replace(/[　\s]+/g, " ").trim();

/** 1行が物件名として使えるか（駅・家賃・間取りだけの描写は使わない） */
function looksLikePropertyName(line: string): boolean {
  const t = normalize(line);
  if (!t || t.length > 40) return false;
  if (PORTAL_URL_RE.test(t)) return false;
  if (DESCRIPTOR_RE.test(t)) return false;
  if (LAYOUT_RE.test(t)) return false;
  if (/^(?:by\s|\[詳細\]|詳細を見る|ニフティ|☆|[0-9０-９]+$)/i.test(t)) return false;
  return NAME_LIKE_RE.test(t.replace(FLOOR_TAIL_RE, ""));
}

/** 「プルス新北野 3階」→ name「プルス新北野」/ label「プルス新北野 3階」 */
function toCandidate(line: string, url: string | null, at: string | null): CustomerPropertyCandidate | null {
  const label = normalize(line);
  const name = normalize(label.replace(FLOOR_TAIL_RE, ""));
  if (!name) return null;
  return { name, label, url, at };
}

/**
 * お客様が送ってくれた物件の候補（新しい順・最大 limit 件）。
 *   ・SUUMO 形式: URL の直前の行が物件名（「by SUUMO」の2行上）
 *   ・athome 形式: 「物件名：〇〇」
 *   ・物件名が無い共有文（ニフティの駅・家賃だけ）は候補にしない
 */
export function customerSharedPropertyNames(
  messagesOldestFirst: ReadonlyArray<Msg>,
  opts: { limit?: number } = {},
): CustomerPropertyCandidate[] {
  const limit = opts.limit ?? 5;
  const out: CustomerPropertyCandidate[] = [];
  const seen = new Set<string>();
  // 新しい順に見る
  for (const m of [...messagesOldestFirst].reverse()) {
    if (m.sender !== "customer") continue;
    const text = m.text ?? "";
    if (!text.trim()) continue;
    const at = m.createdAt ?? m.created_at ?? m.rawCreatedAt ?? null;
    const lines = text.split("\n");
    const urlInMsg = (text.match(PORTAL_URL_RE) ?? []).find((u) => !NON_PROPERTY_URL_RE.test(u)) ?? null;
    const found: CustomerPropertyCandidate[] = [];
    // C. athome: 「物件名：〇〇」
    for (const line of lines) {
      const mm = line.match(/物件名[:：]\s*(.+)$/);
      if (mm) {
        const c = toCandidate(mm[1], urlInMsg, at);
        if (c) found.push(c);
      }
    }
    // A. SUUMO: 物件名の行 → URL の行（→ by SUUMO）
    if (found.length === 0) {
      for (let i = 0; i < lines.length; i++) {
        const line = lines[i] ?? "";
        if (!PORTAL_URL_RE.test(line)) continue;
        const url = (line.match(PORTAL_URL_RE) ?? [])[0] ?? null;
        if (url && NON_PROPERTY_URL_RE.test(url)) continue;
        // URL の直前の行（空行は飛ばす）
        for (let j = i - 1; j >= 0 && i - j <= 3; j--) {
          const prev = lines[j] ?? "";
          if (!prev.trim()) continue;
          if (looksLikePropertyName(prev)) {
            const c = toCandidate(prev, url, at);
            if (c) found.push(c);
          }
          break;
        }
      }
    }
    for (const c of found) {
      const key = c.name;
      if (seen.has(key)) continue;
      seen.add(key);
      out.push(c);
      if (out.length >= limit) return out;
    }
  }
  return out;
}

// ── 持ち込みの後の「名前だけ」の発言（2026-10-13 竹内・未桜事例）──
// 「動画の URL が送られてきたけど、それが物件の URL で『レジュールアッシュ難波MINAMI』と把握できていない。LINE の内容で把握できているはず」:
//   未桜 10/8 14:14 TikTok の動画の URL＋「ここはもう埋まっちゃてますか？」→ こちら「特定出来ませんでした…マンション名など頂けますと」
//   → 10/9 12:12 お客様「レジュールアッシュ難波MINAMIです🙇🏻‍♀️」→ こちら「レジュールアッシュ難波MINAMIの件、かしこまりました！！募集状況確認させて頂きます」。
//   旧: TikTok は物件でないリンク（NON_PROPERTY_URL_RE）・名前だけの発言は URL も画像も無い → どの台帳（property-thread・customer-state・AIX の候補）にも
//   物件として残らず、状況の1行は前の「見積送付済み Alivis新町 802号室」のまま・【必ず】は物件名なしだった。
// 決めた事: お客様が物件を持ち込んだ（URL＝動画・SNS も含む／画像・動画）後 72 時間以内に、お客様が物件名だけ（「〇〇です」「〇〇 302号室です」）を
//   送ってきたら、それを持ち込みの物件の名前の**候補**にする（決定論は候補の網・どの物件の話かはブレインが文を読んで決める＝P0 9eb6aa9c）。
//   名前らしさは「カタカナ3字以上・英字3字以上・建物の語（マンション・ハイツ…）」のどれか。駅・地名だけ（「梅田です」）・質問・お礼・条件は候補にしない。
//   線は scripts/audit-customer-name-after-share.ts（60日の実データで、こちらの次の返事・AIX がその名前で受けたか）で決めた。
// 戻す: CUSTOMER_NAME_AFTER_SHARE=off（サーバ）／NEXT_PUBLIC_CUSTOMER_NAME_AFTER_SHARE=off（画面。"use client" では NEXT_PUBLIC_ しか入らない＝
//   画面は customerNameAfterShareEnvFromPublic() の値を env に渡す）
export function customerNameAfterShareEnabled(env: Record<string, string | undefined> = process.env): boolean {
  const v = env.CUSTOMER_NAME_AFTER_SHARE ?? env.NEXT_PUBLIC_CUSTOMER_NAME_AFTER_SHARE ?? "";
  return v.toLowerCase() !== "off";
}
/** 画面（"use client"）用: NEXT_PUBLIC_CUSTOMER_NAME_AFTER_SHARE はビルド時に埋め込まれる（process.env.NEXT_PUBLIC_… をそのまま書く） */
export function customerNameAfterShareEnvFromPublic(): Record<string, string | undefined> {
  return { CUSTOMER_NAME_AFTER_SHARE: process.env.NEXT_PUBLIC_CUSTOMER_NAME_AFTER_SHARE };
}

/** お客様が物件を持ち込んだ発言（URL＝ポータル・動画・SNS／画像・動画） */
const SHARE_RE = /https?:\/\/|^\s*\[(?:画像|動画)\]/;
/** 物件ではない画像（本人確認書類・振込の控え等の読み取りの見出し）。60日の監査: 本人確認書類の後の申込の物件名を「持ち込み」に読んだ（394b4cbc） */
const NOT_PROPERTY_IMAGE_RE = /^\s*\[画像\]\s*(?:【物件以外|本人確認書類|免許証|マイナンバー|保険証|在留カード|給与明細|源泉徴収|振込|口座)/;
/** 名前だけの発言の語尾（です・になります・という物件です 等） */
const NAME_TAIL_RE = /(?:という|って|の)?(?:物件|マンション|お部屋|部屋|建物)?(?:の?名前)?(?:です|でした|になります|になってます|みたいです|だと思います|と思います|ですね|ですよ)?$/;
/** 前置き（物件名は・名前は） */
const NAME_HEAD_RE = /^(?:物件名|マンション名|建物名|名前|物件|お部屋|こちら|ここ|それ)(?:は|が|：|:)\s*/;
/** 名前ではない（質問・お礼・了承・条件・地名の語） */
const NOT_NAME_WORD_RE = /ます|ません|ください|下さい|でしょう|ですか|お願い|ありがと|了解|分かり|わかり|承知|大丈夫|すみません|はい|いいえ|探し|希望|以内|以下|以上|万円|[0-9０-９]+\s*万|円|駅|徒歩|沿線|エリア|内覧|内見|空い|空き|募集|費用|家賃|見積|いつ|どこ|何|どれ|どう|気にな|良い|いい|好き|無理|厳し|検討|職場|勤務|会社|学校|彼|同棲|入居|引越|引っ越|審査|保証|[？?。、,]/;
/** 名前らしさ（カタカナ3字以上・英字3字以上・建物の語） */
const BUILDING_WORD_RE = /マンション|ハイツ|コーポ|レジデンス|ハイム|メゾン|荘|ビル|タワー|コート|パレス|ヴィラ|ハウス|ガーデン|プラザ|ヒルズ/;
const NAME_SHAPE_RE = new RegExp(`[ァ-ヶー]{3,}|[A-Za-zＡ-Ｚａ-ｚ][A-Za-zＡ-Ｚａ-ｚ.．]{2,}|${BUILDING_WORD_RE.source}`);
const ROOM_TAIL_RE = /\s*([0-9０-９]{2,4})\s*(?:号室|号)?$/;
/** 絵文字・記号（ZWJ・肌の色・異体字の選択子も） */
const EMOJI_RE = /[\p{Extended_Pictographic}‍️\u{1F3FB}-\u{1F3FF}]/gu;

/**
 * お客様の1通が「物件名だけ」か。名前（建物）と号室を返す。名前でなければ null。
 *   例: 「レジュールアッシュ難波MINAMIです🙇🏻‍♀️」→ { name: "レジュールアッシュ難波MINAMI", room: null }
 *       「セレニテ本町グラン 1203号室です」→ { name: "セレニテ本町グラン", room: "1203" }
 *       「梅田です」「ありがとうございます」「ここ空いてますか？」→ null
 */
export function nameOnlyMessage(text: string | null | undefined): { name: string; room: string | null } | null {
  const raw = String(text ?? "").replace(EMOJI_RE, "").trim();
  if (!raw || raw.includes("\n") || /https?:\/\/|^\s*\[/.test(raw)) return null;
  let t = raw.replace(/[!！~〜～…\s]+$/u, "").trim();
  t = t.replace(NAME_HEAD_RE, "").replace(NAME_TAIL_RE, "").trim();
  let room: string | null = null;
  const rm = t.match(ROOM_TAIL_RE);
  if (rm && rm.index != null && rm.index > 0) { room = rm[1].normalize("NFKC"); t = t.slice(0, rm.index).trim(); }
  t = t.replace(NAME_TAIL_RE, "").replace(/[、,の]$/, "").trim();
  const len = Array.from(t).length;
  if (len < 3 || len > 40) return null;
  if (NOT_NAME_WORD_RE.test(t) || /[@＠]/.test(t)) return null;
  if (!NAME_SHAPE_RE.test(t)) return null;
  // 設備・SNS/ポータル名・間取り・人の名前・単独で曖昧な語（ミナミ・レオパレス）は外す（not-property-words.ts の共通の表・2026-10-13 レビュー）
  if (isNotPropertyName(t)) return null;
  // 平仮名の混ざる文は名前ではない（60日の監査: 「ギリギリにすみせん」「旦那の方からLINE来る」「クリエオーレの方は」が名前に読まれた）。
  //   平仮名を含む建物名（「さくらハイツ」）は建物の語があり平仮名4字以下の時だけ
  const hira = (t.match(/[ぁ-ゖ]/g) ?? []).length;
  if (hira > 0 && !(hira <= 4 && BUILDING_WORD_RE.test(t))) return null;
  return { name: t, room };
}

/**
 * AIX の「お客様が送った物件」の候補（共有文の物件名＋持ち込みの後の名前だけの1通・新しい順・同じ名前は1つ・最大5）。
 * 画面（AixModal）から呼ぶ純関数。env は画面では customerNameAfterShareEnvFromPublic() を渡す（off で共有文の物件名だけ＝旧と同じ）
 */
export function customerPropertyOptionsForAix(
  messagesOldestFirst: ReadonlyArray<Msg>,
  env: Record<string, string | undefined>,
): CustomerPropertyCandidate[] {
  const shared = customerSharedPropertyNames(messagesOldestFirst);
  const named = customerNamedAfterShare(messagesOldestFirst, { env }).map(({ name, label, url, at }) => ({ name, label, url, at }));
  if (!named.length) return shared;
  const all = [...shared, ...named].sort((a, b) => Date.parse(b.at ?? "") - Date.parse(a.at ?? ""));
  const seen = new Set<string>();
  return all.filter((c) => (seen.has(c.name) ? false : (seen.add(c.name), true))).slice(0, 5);
}

export type NamedAfterShare = CustomerPropertyCandidate & {
  /** 持ち込みの発言の時刻（URL・画像） */
  sharedAt: string | null;
  /** 号室（名前に付いていた時） */
  room: string | null;
};

/**
 * 持ち込み（URL・画像・動画）の後 72 時間以内にお客様が名前だけを送った発言 → 持ち込みの物件の名前の候補（古い順）。
 *   その間にお客様の別の持ち込みがあれば、その新しい持ち込みを起点にする（名前は一番新しい持ち込みに結ぶ）。
 *   url は起点の持ち込みの URL（画像なら null）。
 */
export function customerNamedAfterShare(
  messagesOldestFirst: ReadonlyArray<Msg>,
  opts: { windowHours?: number; env?: Record<string, string | undefined> } = {},
): NamedAfterShare[] {
  if (!customerNameAfterShareEnabled(opts.env ?? process.env)) return [];
  const win = (opts.windowHours ?? 72) * 3600_000;
  const out: NamedAfterShare[] = [];
  let share: { at: string | null; t: number; url: string | null } | null = null;
  for (const m of messagesOldestFirst) {
    if (m.sender !== "customer") continue;
    const text = String(m.text ?? "");
    const at = m.createdAt ?? m.created_at ?? m.rawCreatedAt ?? null;
    const t = at ? Date.parse(at) : NaN;
    if (NOT_PROPERTY_IMAGE_RE.test(text)) { share = null; continue; }
    if (SHARE_RE.test(text)) { share ={ at, t, url: (text.match(PORTAL_URL_RE) ?? [])[0] ?? null }; continue; }
    if (!share || !Number.isFinite(t) || !Number.isFinite(share.t) || t < share.t || t - share.t > win) continue;
    const n = nameOnlyMessage(text);
    if (!n) continue;
    out.push({ name: n.name, label: n.room ? `${n.name} ${n.room}号室` : n.name, url: share.url, at, sharedAt: share.at, room: n.room });
  }
  return out;
}
