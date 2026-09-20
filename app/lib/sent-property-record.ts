// app/lib/sent-property-record.ts
// 「お客様にどの物件を送ったか」を1か所に集める（純関数＋薄い書き込み）。
//
// 2026-09-20 竹内「物件ピックアップから送る物件もテーブルかクエリで保管したら、どれが物件ピックアップで
//   送った物件かも理解できるし、文生成される部分毎回直さなくて済む（退去予定物件の部分等）。
//   そして一度送った物件が間違えって入ってしまうこと防げる（アナウンスがでる）」
//
// ■ 実測（scripts/audit-sent-properties.ts・直近180日）で分かった今の状態
//   ・AIX の物件ピックアップ 941件（物件オススメ557／物件ピックアップ384）で **物件名が構造化されて残る率 0%**
//     （残っているのは property_check_result の 49/282件＝17% だけ）
//   ・sent_properties の rent / property_url / recruitment_status / applicant_rank / customer_reaction は **全部0%**
//   ・同じ物件を2回以上送った会話は 128件中29件（**22.7%**）
//   ・送信時の画像読み取り（2026-09-20 に入った経路）は sent_image_properties にだけ書いており、
//     **重複チェック（check-property-duplicate）とブレインが見る sent_properties に繋がっていない**
//
// ■ ここの役割
//   送った物件を sent_properties に入れる時の判断（重複か・退去予定か）を**純関数**にして、
//   送信経路（send-line-message）・監査・テストが同じ関数を見る（四者同名）。
//   物件名の突き合わせは property-name-match の similarity に統一する
//   （check-property-duplicate は独自の Levenshtein を持っていて線が二重になっていた）。
import { normalizePropertyName, similarity } from "./property-name-match";

/** sent_properties に入れる1件 */
export type SentPropertyRow = {
  conversation_id: string;
  property_customer_id: string | null;
  property_name: string;
  room_no: string;
  image_url: string | null;
  source: string;
  recruitment_status: string | null;
};

/** 既に送ってある物件（重複判定の材料） */
export type ExistingProperty = { property_name: string; room_no: string | null };

/**
 * AIX の prop_statuses → sent_properties.recruitment_status。
 * 画面の選択肢（app/api/aix/action/route.ts の cmPatternLabel）と DB のコメントを繋ぐ唯一の写像。
 *   available    空室・募集中          → open
 *   vacating     退去予定あり（募集中）→ move_out_planned   ← 竹内さんの言う「退去予定物件の部分」
 *   unavailable  申込あり              → occupied
 *   alternative  別のお部屋が募集中    → （その物件自体の状態ではないので入れない）
 */
export function toRecruitmentStatus(propStatus: string | null | undefined): string | null {
  switch ((propStatus ?? "").trim()) {
    case "available": return "open";
    case "vacating": return "move_out_planned";
    case "unavailable": return "occupied";
    default: return null;
  }
}

/** 号室の表記ゆれを揃える（「0403」「403号室」「403」→「403"）。空なら "" */
export function normalizeRoomNo(raw: string | null | undefined): string {
  const s = (raw ?? "").trim();
  if (!s) return "";
  const m = s.match(/([0-9０-９]{1,5})\s*号?室?\s*$/);
  const digits = (m?.[1] ?? s).replace(/[０-９]/g, (c) => String.fromCharCode(c.charCodeAt(0) - 0xfee0));
  // 先頭の 0 は表記ゆれ（「0403」と「403」が同じ部屋）。ただし全部 0 なら潰さない
  const trimmed = digits.replace(/^0+(?=\d)/, "");
  return /^\d+$/.test(trimmed) ? trimmed : s;
}

/**
 * 重複と言ってよい物件名の近さ。
 *
 * 実測で決めた（scripts/audit-property-dup-threshold.ts・同じ会話の物件名ペア 684組）:
 *   **号室が同じでも名前が違うペアが 494組**ある（「501号室」はどの建物にもあるので号室だけでは決まらない）。
 *   「号室一致＋似ている度 ≥ T」で重複と言った時に、名前が違う物を巻き込む数:
 *     T=0.70 → 48件 ／ 0.85 → 6件 ／ 0.90 → 2件 ／ **0.95 → 0件**
 *   アナウンスは**別の物件を重複と言わない**ことが最優先（誤った警告はスタッフの信頼を失う）なので 0.95 を採る。
 *
 * ⚠ この線だと画像の誤読（「グランパシフィック生野東」↔「グラン**バ**シフィック生野東」= 0.818）は拾えない。
 *   だが別物件（「グランパシフィック生野東」↔「グランパシフィック梅南」= 0.762）と 0.06 しか離れておらず、
 *   **この2つの間に線は引けない**。property-name-match.ts の MATCH_MIN_SCORE と同じ判断
 *   （「誤読も寄せずに捨てる。物件名を間違えて記録するより、記録しない方がまし」）。
 *   誤読を直すのは resolveReadProperty（会話の物件名を辞書にした照合）の担当で、ここの担当ではない。
 */
export const DUP_MIN_SCORE = 0.95;

/**
 * 同じ物件が既に送られているか。
 * ・名前が DUP_MIN_SCORE 未満なら、号室が同じでも別物件（494組の実例がそう）
 * ・名前が十分近くて号室が両方あるなら、**号室で決める**（同じ建物の別部屋 65組を潰さない）
 * ・号室が片方でも無いなら、名前が十分近い時点で重複とみなす
 */
export function isSameProperty(a: ExistingProperty, b: ExistingProperty): boolean {
  const an = normalizePropertyName(a.property_name);
  const bn = normalizePropertyName(b.property_name);
  if (!an || !bn) return false;
  if (similarity(an, bn) < DUP_MIN_SCORE) return false;
  const ar = normalizeRoomNo(a.room_no);
  const br = normalizeRoomNo(b.room_no);
  if (ar && br) return ar === br;
  return true;
}

/** これから送る物件のうち、既に送ってある物（＝スタッフに知らせる物）を返す */
export function findAlreadySent(
  existing: ExistingProperty[],
  incoming: ExistingProperty[],
): Array<{ incoming: ExistingProperty; existing: ExistingProperty }> {
  const out: Array<{ incoming: ExistingProperty; existing: ExistingProperty }> = [];
  for (const inc of incoming) {
    const hit = existing.find((ex) => isSameProperty(ex, inc));
    if (hit) out.push({ incoming: inc, existing: hit });
  }
  return out;
}

/** スタッフに見せる一文（アナウンス）。重複が無ければ空文字 */
export function buildDuplicateNotice(dups: Array<{ incoming: ExistingProperty; existing: ExistingProperty }>): string {
  if (dups.length === 0) return "";
  const names = dups.map((d) => `${d.incoming.property_name}${normalizeRoomNo(d.incoming.room_no) ? ` ${normalizeRoomNo(d.incoming.room_no)}号室` : ""}`);
  return `⚠️ ${names.join("・")} は既にこのお客様へお送りしています`;
}

/**
 * AIX の並行配列（property_names / prop_statuses）を sent_properties の行にする。
 * 物件名に号室が入っている形（「〇〇 403号室」）も分ける。
 * ⚠ 物件名が空の要素は落とす（空の行を作らない）。
 */
export function buildSentPropertyRows(input: {
  conversationId: string;
  propertyCustomerId?: string | null;
  names: Array<string | null | undefined>;
  statuses?: Array<string | null | undefined>;
  imageUrl?: string | null;
  source: string;
}): SentPropertyRow[] {
  const out: SentPropertyRow[] = [];
  input.names.forEach((raw, i) => {
    const s = (raw ?? "").trim();
    if (!s) return;
    const m = s.match(/^(.*?)[\s　]*([0-9０-９]{1,5})\s*号室\s*$/);
    const name = (m?.[1] ?? s).trim();
    const roomNo = m ? normalizeRoomNo(m[2]) : "";
    if (!name) return;
    out.push({
      conversation_id: input.conversationId,
      property_customer_id: input.propertyCustomerId ?? null,
      property_name: name,
      room_no: roomNo,
      image_url: input.imageUrl ?? null,
      source: input.source,
      recruitment_status: toRecruitmentStatus(input.statuses?.[i]),
    });
  });
  return out;
}
