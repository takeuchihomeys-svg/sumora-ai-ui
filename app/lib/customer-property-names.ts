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
