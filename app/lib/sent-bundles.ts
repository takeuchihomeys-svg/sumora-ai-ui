// app/lib/sent-bundles.ts — こちらが AIX で送った「束」（資料・見積書の画像・室内イメージの URL・🌟の文・現況）を物件ごとに組む（純関数・DB/LLM なし）
//
// 2026-10-15 軸の直し（axis-brain-1015）③ 竹内さん（未桜さん 22b2511e 10/09）:
//   「AIX で物件資料・見積書・SUUMO の室内イメージの URL をセットで送った直後の『ここって洗面台とトイレ一緒な感じですか？』は、
//    URL・見積書を送った物件とセットにして、資料を読めば答えられる（人が資料を見るのと同じ）」。
//   お客様は室内イメージの URL の通を引用していた＝画像ではない通。今までは引用先が画像の時だけ物件に直せた（material-answer の quotedImageUrl）。
//   → AIX の送信（aix_usage_logs の line_message_id・sent_at）の ±60秒にこちらが AIX で送った通（画像・URL・🌟の文）を1つの束にし、
//     物件ごとに分ける。文の物件名と画像の読みの名前（sent_image_properties）が合う物だけを束に入れる（合わない物は入れない＝取り違えの安全の線）。
//     例: 10/09 18:21 の AIX【物件確認した】は記録の物件名がエステムコート・文はレジュールアッシュ＝合わないので束にしない。
//   使い道: ①引用・「ここ」の物件を束から1件に決める（material-answer の対象）②ブレインの材料【送った束】（資料で答える・確認事項の済みの判定の材料）
//   安全の線（網）: 別の部屋・現況 unavailable・古い束（既定 21日）は「資料で答えた／空きを答えた」の済みにしない。最後に決めるのはブレイン。
//   戻す: SENT_BUNDLES=off
// テスト: app/lib/__tests__/sent-bundles.test.ts

import { normalizePropertyName } from "./property-name-match";
import { brainNameMatchesAny } from "./property-name-loose";

export function sentBundlesEnabled(env: Record<string, string | undefined> = typeof process !== "undefined" ? process.env : {}): boolean {
  return (env.SENT_BUNDLES ?? "").trim().toLowerCase() !== "off";
}

export type BundleMsg = { line_message_id?: string | null; created_at: string; sender: string; is_aix_generated?: boolean | null; image_url?: string | null; text?: string | null };
export type BundleLog = {
  line_message_id?: string | null; sent_at?: string | null; created_at: string; aix_type: string | null; check_pattern?: string | null;
  property_names?: string[] | null; prop_statuses?: string[] | null; prop_cost_notes?: string[] | null;
};
/** 画像の読み（image_details.kind）と、送った時に記録した物件名（sent_image_properties.property_name） */
export type BundleImageRead = { image_url: string; kind?: string | null; property_name?: string | null; room_no?: string | null };

export type SentBundle = {
  property: string;
  sentAt: string;
  aixType: string | null;
  /** 現況（prop_statuses・物件確認した の check_pattern） */
  status: "available" | "unavailable" | null;
  costNote: string | null;
  images: Array<{ url: string; kind: string | null }>;
  urls: string[];
  /** 🌟の文（オススメの文・最初の300字） */
  starText: string | null;
  /** 束に入れた通の line_message_id（引用の照らし合わせ用） */
  messageIds: string[];
};

export const BUNDLE_WINDOW_MS = 60_000;
export const BUNDLE_STALE_DAYS = 21;

const VOICE = (s: string) => s.normalize("NFD").replace(/[゙゚]/g, "").normalize("NFC");
const CHAR = (s: string) => s.replace(/ヴァ/g, "バ").replace(/ヴィ/g, "ビ").replace(/ヴェ/g, "ベ").replace(/ヴォ/g, "ボ").replace(/ヴ/g, "ブ").replace(/ヶ/g, "ケ");
const norm = (s: string) => VOICE(CHAR(normalizePropertyName(String(s ?? "").normalize("NFKC"))));
/** 物件名から号室・階を外した建物の部分 */
export function buildingPart(name: string): string {
  return String(name ?? "").normalize("NFKC").replace(/\s*(?:[0-9]{1,2}階)?\s*[A-Za-z]?[-‐－]?[0-9]{1,5}\s*(?:号室|号)?\s*$/, "").replace(/\s*[0-9]{1,2}階.*$/, "").trim();
}
/** 文がその物件名（建物の部分）に触れているか */
export function textMentionsProperty(text: string | null | undefined, name: string): boolean {
  const b = norm(buildingPart(name));
  if (b.length < 3) return false;
  const t = norm(String(text ?? ""));
  if (t.includes(b)) return true;
  // 書き方の揺れ（末尾の地名・記号の違い）: 建物の部分の先頭 6 字（短い名前は全部）
  const head = b.slice(0, Math.max(4, Math.min(6, b.length)));
  return head.length >= 4 && t.includes(head);
}

const URL_RE = /https?:\/\/[^\s]+/g;

/**
 * AIX の記録ごとに、±60秒にこちらが AIX で送った通を集め、物件ごとの束にする（新しい順）。
 *   ・記録に物件名が無い・束の文がどれもその物件名に触れていない物は入れない（文が別の物件を書いている AIX を取り違えない）
 *   ・画像: 読みの名前（sent_image_properties）がその物件と合う物。読みの名前が無い画像は、記録の物件が1件の時だけ
 *   ・URL: 記録の物件が1件の時は全部。複数の時は、URL と同じ通の文に物件名がある物だけ
 */
export function buildSentBundles(logs: ReadonlyArray<BundleLog>, msgs: ReadonlyArray<BundleMsg>, reads: ReadonlyArray<BundleImageRead>, o: { windowMs?: number } = {}): SentBundle[] {
  const win = o.windowMs ?? BUNDLE_WINDOW_MS;
  const readBy = new Map(reads.map((r) => [r.image_url, r]));
  const aixMsgs = msgs.filter((m) => m.sender !== "customer" && !!m.is_aix_generated && Number.isFinite(Date.parse(m.created_at)));
  const out: SentBundle[] = [];
  for (const lg of logs) {
    const names = (lg.property_names ?? []).map((n) => String(n ?? "").trim()).filter(Boolean);
    if (!names.length) continue;
    const at = Date.parse(lg.sent_at ?? lg.created_at);
    if (!Number.isFinite(at)) continue;
    const near = aixMsgs.filter((m) => Math.abs(Date.parse(m.created_at) - at) <= win);
    if (!near.length) continue;
    const texts = near.filter((m) => !m.image_url && String(m.text ?? "").trim() && !/^\s*\[(?:画像|動画|スタンプ|ファイル)\]\s*$/.test(String(m.text ?? "")));
    names.forEach((name, i) => {
      const mentioned = texts.some((m) => textMentionsProperty(m.text, name));
      if (!mentioned) return;
      const images = near.filter((m) => !!m.image_url).filter((m) => {
        const r = readBy.get(String(m.image_url));
        if (r?.property_name) return brainNameMatchesAny(name, [r.property_name]) || textMentionsProperty(r.property_name, name);
        return names.length === 1;
      }).map((m) => ({ url: String(m.image_url), kind: readBy.get(String(m.image_url))?.kind ?? null }));
      const urlMsgs = texts.filter((m) => /https?:\/\//.test(String(m.text ?? "")) && (names.length === 1 || textMentionsProperty(m.text, name)));
      const urls = [...new Set(urlMsgs.flatMap((m) => String(m.text ?? "").match(URL_RE) ?? []))];
      const star = texts.find((m) => /🌟/.test(String(m.text ?? "")) && textMentionsProperty(m.text, name)) ?? texts.find((m) => textMentionsProperty(m.text, name));
      const st = String(lg.prop_statuses?.[i] ?? (lg.aix_type === "property_check_result" && names.length === 1 ? lg.check_pattern ?? "" : "")).toLowerCase();
      out.push({
        property: name, sentAt: new Date(at).toISOString(), aixType: lg.aix_type,
        status: st === "available" ? "available" : st === "unavailable" ? "unavailable" : null,
        costNote: lg.prop_cost_notes?.[i] ? String(lg.prop_cost_notes[i]).slice(0, 160) : null,
        images, urls, starText: star ? String(star.text ?? "").slice(0, 300) : null,
        messageIds: [...new Set([...images.map((im) => near.find((m) => m.image_url === im.url)?.line_message_id), ...urlMsgs.map((m) => m.line_message_id), star?.line_message_id, lg.line_message_id].filter((x): x is string => !!x))],
      });
    });
  }
  return out.sort((a, b) => Date.parse(b.sentAt) - Date.parse(a.sentAt));
}

/** 引用した通（line_message_id）が入っている束 */
export function bundleOfQuoted(bundles: ReadonlyArray<SentBundle>, quotedLineId: string | null | undefined): SentBundle | null {
  if (!quotedLineId) return null;
  return bundles.find((b) => b.messageIds.includes(quotedLineId)) ?? null;
}

/** その時刻より前の一番新しい束（「ここ」「こちら」の指す物件の候補）。古い束（既定 21日）は返さない */
export function latestBundleBefore(bundles: ReadonlyArray<SentBundle>, atIso: string, o: { staleDays?: number } = {}): SentBundle | null {
  const at = Date.parse(atIso);
  const stale = (o.staleDays ?? BUNDLE_STALE_DAYS) * 86_400_000;
  return bundles.find((b) => Date.parse(b.sentAt) <= at && at - Date.parse(b.sentAt) <= stale) ?? null;
}

/**
 * 安全の線（網）: この束で「資料で答えた・空きを答えた」の済みにしてよいか。
 *   別の部屋（名前が合わない）・現況 unavailable の空き以外の問い・古い束・問いより前の束は済みにしない
 */
export function bundleMayAnswer(b: SentBundle, o: { askedAt: string; property?: string | null; about?: string | null; nowMs?: number }): boolean {
  if (Date.parse(b.sentAt) < Date.parse(o.askedAt)) return false;
  if ((o.nowMs ?? Date.now()) - Date.parse(b.sentAt) > BUNDLE_STALE_DAYS * 86_400_000) return false;
  if (o.property && !brainNameMatchesAny(o.property, [b.property]) && !textMentionsProperty(o.property, b.property)) return false;
  if (b.status === "unavailable" && o.about !== "vacancy") return false;
  return true;
}

const KIND_JA: Record<string, string> = { property: "資料", estimate: "見積書", room: "室内写真", interior: "室内写真" };
const fmt = (iso: string) => { const d = new Date(Date.parse(iso) + 9 * 3600_000); return `${d.getUTCMonth() + 1}/${d.getUTCDate()} ${String(d.getUTCHours()).padStart(2, "0")}:${String(d.getUTCMinutes()).padStart(2, "0")}`; };

/** ブレインの材料【送った束】（新しい物から max 件）。無ければ空文字 */
export function buildSentBundlesNote(bundles: ReadonlyArray<SentBundle>, o: { max?: number; quoted?: SentBundle | null } = {}): string {
  if (!bundles.length) return "";
  const list = bundles.slice(0, o.max ?? 5);
  const lines = list.map((b) => {
    const kinds = b.images.reduce<Record<string, number>>((acc, im) => { const k = KIND_JA[im.kind ?? ""] ?? "画像"; acc[k] = (acc[k] ?? 0) + 1; return acc; }, {});
    const parts = [...Object.entries(kinds).map(([k, n]) => `${k}${n}枚`), ...(b.urls.length ? [`室内イメージの URL ${b.urls.length}件`] : [])];
    const st = b.status === "available" ? "・現況 募集中" : b.status === "unavailable" ? "・現況 募集に出ていない（この物件の質問は資料で答えず、誘わない）" : "";
    return `- ${fmt(b.sentAt)} ${b.property}（AIX ${b.aixType ?? "?"}・${parts.join("・") || "文のみ"}${st}）${o.quoted && o.quoted === b ? " ←お客様が今引用した束" : ""}`;
  });
  return `【送った束（こちらが AIX で送った資料・見積書・URL を物件ごとにまとめた物・新しい順）】\n${lines.join("\n")}\n→ 「ここ」「こちら」は引用した束、無ければ直前の束の物件。その物件の質問は資料（物件資料の読み取り）で答えられるなら返信で答える。別の部屋・募集に出ていない物件・古い束を答えにしない。`;
}
