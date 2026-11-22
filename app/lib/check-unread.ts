// app/lib/check-unread.ts — 指摘の型「読めていない（画像・物件）」の点検の決まり（純関数・DB/LLM なし）
//
// 2026-11-21 作業員N（台帳 #472・竹内さん 11/21「なんでこれよみとれていないのか？重要なのは、お客さんが反応した画像」#461・
//   「物件確認したのところもちゃんと物件把握できるようにする」#471）。
//   指摘の型の表で、読めていない型だけ、竹内さんの指摘の後に自分で見つけた穴が0だった（memory/owner_feedback_types_1121.md）。
//   読むべき物を3つの分野で数え、読んだ記録が無い物を出す:
//     ① お客様が反応したこちらの画像（直後のお客様の文が画像への反応か、画像を引用した）→ 読んだ記録 = image_details か sent_image_properties の物件名
//     ② お客様が送った画像（物件の画面・写真）→ 読んだ記録 = image_details
//     ③ AIX【物件確認した】の物件名（aix_usage_logs.property_names が空）
//   台本は scripts/check-unread.ts（読むだけ）。

export type CuMsg = { id: string; sender: string; text: string | null; image_url: string | null; created_at: string; quoted_message_id?: string | null; is_aix_generated?: boolean | null };

const REACTION_RE = /気になり|気に入|いいですね|良いですね|いい感じ|綺麗|きれい|広い|狭い|ここ(?:は|が|に|って|の)|この(?:お?部屋|物件)|こちら(?:の)?(?:お?部屋|物件)|見てみたい|内覧|内見|高い|安い|[?？]/;
export const isReactionText = (t: string | null | undefined) => REACTION_RE.test(String(t ?? "").normalize("NFKC"));

/** こちらの画像のうち、お客様が反応した物（直後60分以内・間にこちらの文が無いお客様の文が反応の語か、その画像を引用した）。
 *  同じ送り（AIX の画像と本文・2分以内の AIX の文）は挟まっても続きと見る＝AIX の物件の画像への反応を拾う（竹内さん 11/21 #461） */
export function reactedOurImages(msgs: ReadonlyArray<CuMsg>, windowMs = 60 * 60_000): CuMsg[] {
  const ms = [...msgs].sort((a, b) => a.created_at.localeCompare(b.created_at));
  const out: CuMsg[] = [];
  const byId = new Map(ms.map((m) => [m.id, m]));
  for (let i = 0; i < ms.length; i++) {
    const m = ms[i];
    if (m.sender !== "staff" || !m.image_url) continue;
    // 引用で指された（時間に関係なく）
    const quoted = ms.some((x) => x.sender === "customer" && x.quoted_message_id === m.id);
    let reacted = quoted;
    if (!reacted) {
      for (let j = i + 1; j < ms.length; j++) {
        const x = ms[j];
        if (Date.parse(x.created_at) - Date.parse(m.created_at) > windowMs) break;
        // 同じ送り（AIX の画像と本文・2分以内の AIX の文）は挟まっても続きと見る＝AIX の物件の画像への反応を拾う（竹内さん 11/21 #461）
        const sameSend = !!x.is_aix_generated && Math.abs(Date.parse(x.created_at) - Date.parse(m.created_at)) <= 120_000;
        if (x.sender === "staff" && !x.image_url && String(x.text ?? "").trim() && !/^\[画像\]$/.test(String(x.text)) && !sameSend) break; // こちらの別の文が挟まった
        if (x.sender === "customer") { reacted = isReactionText(x.text); break; }
      }
    }
    if (reacted && byId.has(m.id)) out.push(m);
  }
  return out;
}

export type UnreadRow = { field: "reacted_our_image" | "customer_image" | "check_result_property"; total: number; read: number; examples: string[] };
export function unreadLine(r: UnreadRow): string {
  const un = r.total - r.read;
  return `${r.field}: 読むべき物 ${r.total}・読んだ記録あり ${r.read}・無い ${un}（${r.total ? Math.round((un / r.total) * 1000) / 10 : 0}%）${r.examples.length ? `・例 ${r.examples.join(",")}` : ""}`;
}
