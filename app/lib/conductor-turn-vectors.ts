// app/lib/conductor-turn-vectors.ts — 入口の統括の「近い過去の番」の表（conductor_turn_vectors）の1行の作り方（⑤(a)・作業員1・11/04・純関数）
//   設計: 作業員2 conductor-brain-shape.md 追記2（KB P1 641c85f3「ベクトルで近い過去の番の当たりで重み」）。基準は竹内さんの番だけ（KB 41dadfe6）。
//   状況の文は、再生の試験の材料（scripts/conductor-intake-replay-build.ts）と同じ材料・同じ伏せ（compose-name-mask＋maskPII は呼ぶ側）で作る＝試験と本番で同じ文。
//   中身: 場面・段階・伏せた今の番のお客様の発言（120字まで）・直前のこちらの送信の種類（AIX の種類／返信）。会話の文はここで切るだけで、倉庫（git）には載せない。

export const SITUATION_CUSTOMER_MAX = 120;
/** 申込の書類の手前まで（replay-build と同じ線）。この語が出た番は表に入れない */
export const APPLY_DOCS_RE = /(申込(?:書|フォーマット)|本人確認書類|免許証|マイナンバー|源泉徴収|給与明細|生年月日|勤務先)/;

/** 2026-11-04 統括役: 文の解剖の表と同じ決まり＝URL・電話・〒 は残さない（お客様が貼った SUUMO 等の URL は「〔物件のURL〕」） */
const PORTAL_RE = /(suumo|homes\.co\.jp|athome|chintai|itandi|realpro|reins|canary|smocca|door\.ac|minimini|apamanshop|able\.co\.jp|eheya|goodrooms)/i;
export function maskContactBits(t: string): string {
  return t
    .replace(/https?:\/\/[^\s　「」『』（）()<>]+/gi, (u) => (PORTAL_RE.test(u) ? "〔物件のURL〕" : "〔URL〕"))
    .replace(/\bwww\.[^\s　]+/gi, (u) => (PORTAL_RE.test(u) ? "〔物件のURL〕" : "〔URL〕"))
    .replace(/〒\s*\d{3}[-‐ー−－]?\d{4}/g, "〔〒〕")
    .replace(/(?:\+81[-‐ー−－\s]?|(?<!\d)0)\d{1,4}[-‐ー−－\s]?\d{1,4}[-‐ー−－\s]?\d{3,4}(?!\d)/g, (m) => (m.replace(/\D/g, "").length >= 10 ? "〔電話〕" : m))
    .replace(/(?<![\d-])\d{3}[-‐ー−－]\d{4}(?![\d-])/g, "〔〒〕");
}

/**
 * 片割れのサロゲート（絵文字を slice の途中で切った残り）を外す（純関数・2026-11-11 作業員4・弱い所 292 の続き）。
 *   11/08 から夜の近い番の表の書き込みが「invalid input syntax for type json」で毎晩落ちていた＝状況の文 v2 の 60字・120字の切り出しが
 *   絵文字の半分で切れ、片割れの \ud83d が JSON に入ると Postgres が束ごと断る（1行で 200行の束が全部書けず、3晩 新しい番が0）。
 *   入口の意見の今の番の文も同じ切り方＝埋め込みにも片割れが渡っていた。値の中の文字列を深く見て、片割れだけ外す（他は変えない）
 */
export function stripLoneSurrogates<T>(v: T): T {
  if (typeof v === "string") return v.replace(/[\ud800-\udbff](?![\udc00-\udfff])|(?<![\ud800-\udbff])[\udc00-\udfff]/g, "") as unknown as T;
  if (Array.isArray(v)) return v.map((x) => stripLoneSurrogates(x)) as unknown as T;
  if (v && typeof v === "object") return Object.fromEntries(Object.entries(v as Record<string, unknown>).map(([k, x]) => [k, stripLoneSurrogates(x)])) as T;
  return v;
}

/** 状況の文（埋め込む文）。伏せは呼ぶ側で済ませた文を渡す（URL・電話・〒 はここでも伏せる） */
export function turnSituationText(o: { scene: string | null; stage: string | null; customerMasked: string; lastStaffKind: string | null }): string {
  const cust = maskContactBits(o.customerMasked).replace(/\s+/g, " ").trim().slice(0, SITUATION_CUSTOMER_MAX);
  return stripLoneSurrogates([
    `場面: ${o.scene || "不明"}`,
    `段階: ${o.stage || "不明"}`,
    `直前のこちら: ${o.lastStaffKind || "なし"}`,
    `お客様: ${cust}`,
  ].join("\n"));
}

/** こちらの一手（正解）: AIX の種類（あれば）か返信 */
/** shape＝この番の竹内さんの組み合わせの型（R・A・AT・AR・RAT…・作業員7 two-message-plan.shapeOfSends・11/05 統括役） */
export type TurnActual = { route: "aix" | "reply"; aix: string | null; picker: string | null; shape?: string };
export function actualOf(o: { isAix: boolean; aixType: string | null; checkPattern: string | null }): TurnActual {
  return o.isAix ? { route: "aix", aix: o.aixType ?? "aix_unknown", picker: o.checkPattern ?? null } : { route: "reply", aix: null, picker: null };
}

/** 型を数えない付き物（画像・スタンプ・URL だけの通・申込フォーマット等の定型）。shapeOfSends の決まり「付き物は呼ぶ側で外す」 */
const ATTACHMENT_RE = /^\s*(?:\[(?:画像|スタンプ|動画|ファイル)\]\s*)+$/;
const URL_ONLY_RE = /^\s*(?:https?:\/\/\S+\s*)+$/;
export function isShapeAttachment(text: string | null | undefined): boolean {
  const t = String(text ?? "").trim();
  return !t || ATTACHMENT_RE.test(t) || URL_ONLY_RE.test(t) || APPLY_DOCS_RE.test(t) && /フォーマット|ご記入/.test(t);
}
/**
 * この番のこちらの送信（最初の送信 firstIdx から、次のお客様の発言の手前まで・時刻の順）を、shapeOfSends に渡す形にする。
 *   msgs は会話の通（古い順）。付き物は外す。AIX は送信の印 is_aix_generated で見分ける
 */
export function turnSendsForShape(msgs: ReadonlyArray<{ sender: string; text: string | null; is_aix_generated: boolean | null }>, firstIdx: number): Array<{ isAix: boolean; text: string | null }> {
  const out: Array<{ isAix: boolean; text: string | null }> = [];
  for (let i = firstIdx; i < msgs.length && msgs[i].sender !== "customer"; i++) {
    const m = msgs[i];
    if (!m.is_aix_generated && isShapeAttachment(m.text)) continue;
    out.push({ isAix: !!m.is_aix_generated, text: m.text });
  }
  return out;
}

/** ブレインごとに合ったか（見張りの番がある時だけ・無ければ {}）。judge＝道・aix＝AIX の種類 */
export function hitsOf(actual: TurnActual, watch: { brainMode: string | null; brainAction: string | null } | null): Record<string, boolean> {
  if (!watch) return {};
  const brainAix = watch.brainMode === "aix" && !!watch.brainAction;
  const out: Record<string, boolean> = { judge: brainAix === (actual.route === "aix") };
  if (brainAix && actual.route === "aix") out.aix = watch.brainAction === actual.aix;
  return out;
}

/** 表の1行（埋め込みは呼ぶ側で足す） */
export type TurnVectorRow = {
  source_key: string; source: "messages" | "watch"; conversation_id: string; property_customer_id: string | null;
  scene: string; stage: string | null; situation: string; fp: string[]; actual: TurnActual; hits: Record<string, boolean>;
  writer: "takeuchi" | "employee" | "unknown"; turn_at: string;
};
export function turnVectorRow(o: {
  sendId: string; conversationId: string; propertyCustomerId: string | null; scene: string | null; stage: string | null;
  customerMasked: string; lastStaffKind: string | null; fp: string[]; actual: TurnActual; hits: Record<string, boolean>;
  writer: string | null; turnAt: string;
}): TurnVectorRow {
  return {
    source_key: `msg:${o.sendId}`, source: "messages", conversation_id: o.conversationId, property_customer_id: o.propertyCustomerId,
    scene: o.scene || "不明", stage: o.stage, situation: turnSituationText(o), fp: o.fp, actual: o.actual, hits: o.hits,
    writer: o.writer === "takeuchi" ? "takeuchi" : o.writer === "employee" ? "employee" : "unknown", turn_at: o.turnAt,
  };
}

/** 2026-11-04 統括役（竹内さんに「今夜から埋め始める」）: 既定 on（表を埋めるだけ・読む側はまだ無い・夜 01:50 だけ・約 $0.01/日）。=off で止める */
export const conductorTurnVectorsOn = (env: Record<string, string | undefined> = process.env) => (env.CONDUCTOR_TURN_VECTORS ?? "").trim().toLowerCase() !== "off";
