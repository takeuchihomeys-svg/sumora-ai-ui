// app/lib/sent-image-doc-guard.ts — こちらが送った画像のうち、契約・申込・支払い・本人確認などの書類と判る物を DeepSeek の読み取りに出さない守り
//
// 2026-11-21 作業員G（統括役の頼み・最優先「申込以降の書類・個人の値を DeepSeek に渡さない」）:
//   14日でスタッフが手で送った画像 52枚を目で読むと、書類（重説・契約書・口座振替・申込の画面・内定通知書・御請求書）が 15枚あった。
//   申込中の会話の画像は既に読まない（post-apply.loadDeepseekCutoff・sent-image-record と ensureImageDetail）が、
//   会話の状態がまだ申込に変わっていない（案内中のまま契約書類のやり取りをしている）会話の書類は線をすり抜けて読みに出ていた
//   （例: 案内中の会話で「契約書類の返送の際に住民票…」と一緒に送った御請求書＝宛名つき）。
//   画像は読む前に中身が分からないので、**同じ会話でその前後10分にこちらが書いた文**で書類の番と判る時は読まない。
//   線（14日の手で送った画像 52枚に当てた）: 書類の番の前後の文には「契約書類」「重要事項」「請求書」「内定通知書」「リビングFIT」等が出ていた。
//   物件の資料・見積書・室内写真の番の前後の文（「新着で募集に出た」「初期費用について代表に交渉」「御見積書」等）には当たらない（誤って止めた物 0）。
//   「見積」「申込」「審査」だけでは止めない（見積書・切り替えの物件資料の番にも出る）。
//   読むのは手で書いた文だけ（AIX の本文は物件の説明で「請求書の到着時」等が出る＝30日で AIX の物件資料を1枚止めていた）。
//   既定 on（SENT_IMAGE_DOC_GUARD=off で止める）。止めた時は読まない＝記録が無いだけ（物件の記録は作らない）
type Env = Record<string, string | undefined>;
export function sentImageDocGuardOn(env: Env = typeof process !== "undefined" ? process.env : {}): boolean {
  return (env.SENT_IMAGE_DOC_GUARD ?? "").trim().toLowerCase() !== "off";
}
/** 書類の番と判る、こちらの文の語（物件の資料・見積書の番には出ない語だけ） */
export const SENT_DOC_TEXT_RE = /契約書|重要事項|重説|請求書|御請求|口座振替|口座(?:の)?登録|振込(?:期日|先|口座)|申込書|入居申込(?:書|の画面)|本人確認|内定通知|住民票|源泉徴収|給与明細|保証委託|リビングFIT|鍵(?:の)?(?:受け?渡し|お渡し)|署名|捺印|実印|印鑑証明/;
export const SENT_DOC_WINDOW_MS = 10 * 60_000;

/** 前後10分のこちらの文から、書類の番か（純関数） */
export function sentDocTurn(nearStaffTexts: ReadonlyArray<string | null | undefined>): { doc: boolean; hit: string | null } {
  for (const t of nearStaffTexts) {
    // 画像の書き起こし（[画像] で始まる）はこちらの文ではない（自社の御見積書の「御請求金額」等が当たる）
    if (/^\s*\[画像\]/.test(String(t ?? ""))) continue;
    const m = String(t ?? "").normalize("NFKC").match(SENT_DOC_TEXT_RE);
    if (m) return { doc: true, hit: m[0] };
  }
  return { doc: false, hit: null };
}

type Sb = { from: (t: string) => any };
/** サーバー: その会話で送った時刻の前後10分のこちらの文を読み、書類の番なら true（読めない時は false＝今まで通り） */
export async function sentImageIsDocTurn(sb: Sb, conversationId: string | null | undefined, sentAtIso?: string | null, opts?: { imageUrl?: string | null; aix?: boolean | null }): Promise<{ doc: boolean; hit: string | null }> {
  if (!sentImageDocGuardOn() || !conversationId) return { doc: false, hit: null };
  try {
    // AIX から送った画像は物件・見積の流れ（書類は手で送る）＝止めない。30日で手の文「請求書の到着時…」の近くの AIX の物件資料を1枚止めていた
    let aix = opts?.aix ?? null;
    if (aix === null && opts?.imageUrl) {
      const { data: row } = await sb.from("messages").select("is_aix_generated").eq("conversation_id", conversationId).like("image_url", `%${opts.imageUrl.split("/").pop() ?? opts.imageUrl}%`).limit(1).maybeSingle();
      aix = !!(row as { is_aix_generated?: boolean | null } | null)?.is_aix_generated;
    }
    if (aix) return { doc: false, hit: null };
    const t = sentAtIso ? Date.parse(sentAtIso) : Date.now();
    const { data, error } = await sb.from("messages").select("text").eq("conversation_id", conversationId).neq("sender", "customer").or("is_aix_generated.is.null,is_aix_generated.eq.false")
      .gte("created_at", new Date(t - SENT_DOC_WINDOW_MS).toISOString()).lte("created_at", new Date(t + SENT_DOC_WINDOW_MS).toISOString()).limit(40);
    if (error) return { doc: false, hit: null };
    return sentDocTurn(((data ?? []) as Array<{ text: string | null }>).map((r) => r.text));
  } catch { return { doc: false, hit: null }; }
}
