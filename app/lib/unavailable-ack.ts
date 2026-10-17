// app/lib/unavailable-ack.ts — 「募集終了・募集に出ていない・申込が入った」報告の後のお礼の番（純関数・DB/LLM なし）
//
// 2026-10-15 竹内さん（ゆなまるさん 10/09・会話 63fa0c26）: スタッフ「お送り頂きました〇〇につきまして…現在募集に出ていないお部屋となっております！！
//   引き続き新着で…出次第お送りさせて頂きます！！」→ お客様「ありがとうございます！」→ 下書き「お気に召されましたらご都合よろしいお日にち
//   御座いますでしょうか！！ご案内させて頂きます！！」。「募集していないとなっているのに。何の話をしているのかの軸が分からない」。
//   この番の話題（軸）＝こちらの直前の報告（そのお部屋は募集に出ていない）＋残した約束（新着が出次第お送り）。
//   内覧・申込の誘い（お気に召されましたら…）は「気に入って頂けるお部屋」が話題にある時の扉の文で、話題のお部屋が募集に出ていない番では指す物が無い。
// 戻す: UNAVAILABLE_ACK_AXIS=off

const N = (s: string | null | undefined) => String(s ?? "").normalize("NFKC");

export function unavailableAckAxisEnabled(env: Record<string, string | undefined> = typeof process !== "undefined" ? process.env : {}): boolean {
  return (env.UNAVAILABLE_ACK_AXIS ?? "").trim().toLowerCase() !== "off";
}

/** 募集に出ていない・終了・申込が入った・成約の報告 */
const UNAVAILABLE_RE = /募集(?:に|が)?(?:出て|でて)(?:い|お)?(?:ない|りません|ございません)|募集(?:が)?終了|募集(?:を)?(?:停止|ストップ)|募集(?:して)?(?:い|お)?(?:ない|りません)|募集(?:が)?(?:無い|ない|ございません)|(?:お?申込み?|お?申し込み)(?:が)?(?:入り|入って|入った|ございま|あり)|成約(?:済|して|となり|になり)|空き(?:が)?(?:無い|ない|ございません)|ご紹介(?:が)?(?:出来|でき)ない/;
/** 同じ報告の中に今ご紹介出来るお部屋がある（一部募集中） */
const AVAILABLE_RE = /(?:現在|今)?募集中(?:と|で|の|です|となり)|空室(?:と|で|です|となり)|ご内覧(?:頂|いただ)ける|ご案内(?:可能|出来|でき)/;

/** こちらの文が「お部屋が募集に出ていない」報告だけか（今ご紹介出来るお部屋が同じ文に無い） */
export function unavailableReportOf(staffText: string | null | undefined): boolean {
  const t = N(staffText);
  if (!UNAVAILABLE_RE.test(t)) return false;
  return !AVAILABLE_RE.test(t);
}

/** 気に入って頂いた時の内覧・申込の誘いの1文（扉の文）。あればその文を返す */
const INVITE_RE = /(?:お気に召され|気に入られ|お気に入り(?:頂|いただ)け)[^。！!\n]{0,40}(?:ご?案内|ご?内覧|お?申込|お?申し込み|抑え|押さえ)|ご都合(?:よろしい|の良い|のよい)お日にち/;
/**
 * 2026-10-15 軸の直し④（axis-brain-1015）: 物件確認した の結果が全部 unavailable の時、その後のお礼・続きの番の「次の一手の見本」を
 *   aix-taxonomy の weDo（お気に召されましたら…ご案内）ではなく、受け＋何卒にする（指すお部屋が無い）。
 *   記録（aix_usage_logs）の prop_statuses が全部 unavailable／物件1件で check_pattern=unavailable／記録の文が募集に出ていない報告だけ のどれか。
 */
// 2026-10-18 竹内さん 10/16「募集終了（そのお部屋は募集が終わっていました）の後のお礼の締めに『条件に合った物件が見つかるまでサポートする』姿勢を入れる」。
//   受け＋サポートの姿勢の1文＋何卒。新着のお約束の繰り返しではない（姿勢）。戻す UNAVAILABLE_ACK_SUPPORT=off（受け＋何卒だけ＝10/15 の形）
const UNAVAILABLE_ACK_SUPPORT = (typeof process !== "undefined" ? (process.env.UNAVAILABLE_ACK_SUPPORT ?? "") : "").trim().toLowerCase() !== "off";
export const UNAVAILABLE_ACK_SUPPORT_LINE = "〇〇さんのご条件に合ったお部屋が見つかるまで全力でサポートさせて頂きます！！";
export const UNAVAILABLE_ACK_WEDO = UNAVAILABLE_ACK_SUPPORT
  ? `はい😊！！${UNAVAILABLE_ACK_SUPPORT_LINE}何卒よろしくお願い致します！！`
  : "はい😊！！何卒よろしくお願い致します！！";
export const UNAVAILABLE_ACK_DIRECTION = UNAVAILABLE_ACK_SUPPORT
  ? "物件確認の結果は【募集に出ていない】（直前の AIX で報告済み・新着のお約束も送り済みなら繰り返さない）。お礼・了承には受け＋「ご条件に合ったお部屋が見つかるまで全力でサポートさせて頂きます」の姿勢の1文＋何卒で短く閉じる（竹内さん 10/16）"
  : "物件確認の結果は【募集に出ていない】（直前の AIX で報告済み・新着のお約束も送り済みなら繰り返さない）。お礼・了承には受け＋何卒で短く閉じる";
export const UNAVAILABLE_ACK_FORBID = "内覧・申込の誘い（「お気に召されましたら」「ご都合よろしいお日にち」「ご案内させて頂きます」）／募集に出ていないお部屋の話を続ける事／新着の約束の言い直し";
export function checkResultAllUnavailable(log: { aix_type?: string | null; check_pattern?: string | null; prop_statuses?: ReadonlyArray<string | null> | null; generated_text?: string | null } | null | undefined): boolean {
  if (!log || log.aix_type !== "property_check_result") return false;
  const st = (log.prop_statuses ?? []).map((s) => String(s ?? "").toLowerCase()).filter(Boolean);
  if (st.length) return st.every((s) => s === "unavailable");
  if ((log.check_pattern ?? "") === "unavailable") return true;
  return unavailableReportOf(log.generated_text ?? null);
}
/**
 * 2026-10-15 brain-merge（decisions-brain の確かめる人の指摘6）: 直前の物件の動き（物件確認した・物件を送る・おすすめ）が
 *   「物件確認した の結果が全部募集に出ていない」か。この時は 保留の柔らかい1文・送った物件が刺さっているか（hold-soft-next）の材料を出さない
 *   （指すお部屋が無い・この番の締めは受け＋何卒＝axis 側）。後から物件を送り直していれば false（新しいお部屋の話）。
 *   rows は新しい順。窓は generate-reply の AIX 実行済みの窓（72時間）と同じ。UNAVAILABLE_ACK_AXIS=off で常に false
 */
const PROPERTY_MOVE_AIX = new Set(["property_check_result", "property_send", "property_recommendation"]);
export function lastPropertyMoveAllUnavailable(
  rows: ReadonlyArray<{ aix_type?: string | null; created_at?: string | null; check_pattern?: string | null; prop_statuses?: ReadonlyArray<string | null> | null; generated_text?: string | null }>,
  now: number = Date.now(),
  env?: Record<string, string | undefined>,
  windowMs = 72 * 60 * 60 * 1000,
): boolean {
  if (!unavailableAckAxisEnabled(env)) return false;
  const last = rows.find((r) => PROPERTY_MOVE_AIX.has(r.aix_type ?? ""));
  if (!last) return false;
  const t = Date.parse(last.created_at ?? "");
  if (!Number.isFinite(t) || now - t > windowMs) return false;
  return checkResultAllUnavailable(last);
}
export function inviteSentenceOf(text: string | null | undefined): string | null {
  const t = N(text);
  for (const s of t.split(/\n|(?<=[!！。])(?![!！])/)) if (INVITE_RE.test(s)) return s.trim();
  return null;
}
