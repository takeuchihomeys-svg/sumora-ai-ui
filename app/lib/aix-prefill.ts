// app/lib/aix-prefill.ts
// AIX を開いた時に「確認が要る所以外」を先に入れる値を決める（純関数・DB も fetch も持たない）。
//
// 2026-10-01 竹内「AIX 開いたら、確認した要件以外は全てセットされていて、スタッフは確認したことだけ入れたら良いようにするのが理想の形。
//   物件名等はセットされていて、スタッフは確認事項だけ入れていく形」（memory project_aix_prefill_direction）。
//
// 決まり（設計知見）:
//   ・値は必ず「出所」と組で返す（売上サポ・お客様が送った物件・送った資料・会話・登録の条件・AIX の記録）。画面は出所を見せ、スタッフが直せる
//   ・推測で埋めない（候補が2つ以上で決まらない時は null＝今までどおり候補ボタン）。可否・入居可能日・番地など資料や会話に無い事実はここで決めない
//   ・どの物件かは決定論で決める（設計知見「お客様の反応は物件ごと…物件の決定を LLM に任せると取り違える」）
//   ・線は実データで測った物だけ（下の各関数のコメントに数字。監査 scripts/audit-aix-prefill.ts）
//
// 記録: 画面は送る時に「自動で入れた値・出所・そのまま使ったか」を aix_usage_logs.prefill に残す（summarizePrefillUse）。
//   見張りで欄ごとの当たり率を数え、当たりの低い欄から直す。

export type PrefillSource = "pickup" | "customer_shared" | "staff_sent" | "conversation" | "conditions" | "aix_history";

export const PREFILL_SOURCE_LABEL: Record<PrefillSource, string> = {
  pickup: "売上サポ",
  customer_shared: "お客様が送った物件",
  staff_sent: "送った資料",
  conversation: "会話",
  conditions: "登録の条件",
  aix_history: "これまでの送付",
};

export type Prefilled<T> = { value: T; source: PrefillSource; reason: string };

/** 画面の欄の横に出す文字（AixModal の既存「（会話から自動・違えば選び直し）」と同じ形） */
export function prefillNote(p: { source: PrefillSource } | null | undefined): string {
  return p ? `（${PREFILL_SOURCE_LABEL[p.source]}から自動・違えば直す）` : "";
}

// ─── 物件を送った種類（物件ピックアップした send_mode／物件オススメ pickup_type）────────────────
/**
 * 「前に物件を送ったか」の区切り。直前の1時間の送付は同じ回（物件ピックアップ→物件オススメの2連・送り直し）なので数えない。
 * 実測（2026-10-01・180日・YUMA 除く）: 物件ピックアップ 363件で 初回／新着の当たり 278件（77%）。外れは「条件広げ」52件（会話からは決められない）。
 *   物件オススメ（9/27〜の記録）21件で 17件（81%）。
 *   ⚠ 送付の表（sent_properties）で数えると新着の半分が「前の送付なし」になる（表に抜けが多い）→ AIX の記録で数える。
 */
export const PRIOR_SEND_GAP_MS = 60 * 60_000;
const PROPERTY_SEND_AIX = new Set(["property_send", "property_recommendation"]);

export type AixHistoryRow = { aix_type: string | null; created_at: string | null };

/** 1時間より前に物件（ピックアップ・オススメ）を送った回数 */
export function priorPropertySendCount(history: ReadonlyArray<AixHistoryRow>, nowMs: number): number {
  let n = 0;
  for (const h of history) {
    if (!h.aix_type || !PROPERTY_SEND_AIX.has(h.aix_type) || !h.created_at) continue;
    const t = Date.parse(h.created_at);
    if (Number.isFinite(t) && t < nowMs - PRIOR_SEND_GAP_MS) n++;
  }
  return n;
}

export function sendModePrefill(history: ReadonlyArray<AixHistoryRow>, nowMs: number): Prefilled<"normal" | "new_arrival"> {
  const n = priorPropertySendCount(history, nowMs);
  return n > 0
    ? { value: "new_arrival", source: "aix_history", reason: `前に物件を送った記録 ${n}回 → 新着` }
    : { value: "normal", source: "aix_history", reason: "物件を送った記録なし → 初回" };
}

export function pickupTypePrefill(history: ReadonlyArray<AixHistoryRow>, nowMs: number): Prefilled<"新規ピックアップ" | "新着1件"> {
  const n = priorPropertySendCount(history, nowMs);
  return n > 0
    ? { value: "新着1件", source: "aix_history", reason: `前に物件を送った記録 ${n}回 → 新着1件` }
    : { value: "新規ピックアップ", source: "aix_history", reason: "物件を送った記録なし → 初回" };
}

// ─── 物件名 ─────────────────────────────────────────────────────────────
/** 比べるための建物名（号室・階・空白を外す） */
export function propertyBaseName(s: string | null | undefined): string {
  return (s ?? "")
    .replace(/[　\s]+/g, " ")
    .replace(/\s*[0-9０-９A-Za-z\-ー－]{1,6}\s*号室\s*$/, "")
    .replace(/\s*[0-9０-９]{1,3}\s*階\s*$/, "")
    .replace(/\s+/g, "")
    .trim();
}

export type PropertyNameInput = {
  /** 売上サポで選んで渡された物件（「物件名 号室」・選んだ並び） */
  pickupNames?: ReadonlyArray<string>;
  /** お客様が今回の連投（こちらの最後の発言より後）で送ってきた物件名（customerSharedPropertyNames の name） */
  customerSharedThisTurn?: ReadonlyArray<string>;
  /** こちらが送った物件（「🌟〇〇 305号室」「【〇〇 305号室】」・新しい順） */
  staffSent?: ReadonlyArray<string>;
  /** お客様の今回の連投の文（改行でつないだ物） */
  customerTurnText?: string | null;
};

const uniqByBase = (xs: ReadonlyArray<string>): string[] => {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const x of xs) {
    const b = propertyBaseName(x);
    if (!b || seen.has(b)) continue;
    seen.add(b);
    out.push(x.trim());
  }
  return out;
};

/**
 * 物件名の欄に先に入れる名前。決まらない時は null（今まで通り候補ボタン）。
 *   ①売上サポで選んだ物件（1件目）
 *   ②こちらが送った物件のうち、お客様が今回の発言で名前を出した物がちょうど1件
 *
 * ⚠ 監査（scripts/audit-aix-prefill.ts・物件確認した でスタッフが入れた物件名 73件）で外した決め方（2026-10-01）:
 *   ・「こちらが送った物件が1件だけ」→ 当たり1・外れ13（お客様は前に送った物件ではなく、自分で見つけた物件＝画像・URL を聞くことが多い）
 *   ・「お客様が今回送ってきた物件（共有文）が1件」→ 当たり2・外れ4（共有文の物件と、確かめた物件が別）
 *   入れて外れると取り違え（別の物件名で文が出来る）になるので、当たる形だけ残した。customerSharedThisTurn・staffSent の単独では決めない
 */
export function propertyNamePrefill(o: PropertyNameInput): Prefilled<string> | null {
  const pickup = uniqByBase(o.pickupNames ?? []);
  if (pickup.length) return { value: pickup[0], source: "pickup", reason: pickup.length > 1 ? `売上サポで選んだ ${pickup.length}件の1件目` : "売上サポで選んだ物件" };
  const sent = uniqByBase(o.staffSent ?? []);
  const turn = (o.customerTurnText ?? "").replace(/[　\s]+/g, "");
  if (!turn) return null;
  const named = sent.filter((s) => {
    const b = propertyBaseName(s);
    return b.length >= 3 && turn.includes(b);
  });
  return named.length === 1 ? { value: named[0], source: "conversation", reason: "お客様が名前を出した、送った物件" } : null;
}

/**
 * お客様の直近の連投（古い順のメッセージを受ける）。スタッフが一言返した後に AIX を開くこともあるので、
 * 末尾のこちらの発言は飛ばし、その前のお客様の発言の続きを返す
 */
export function customerTurnOf<M extends { sender?: string | null }>(messagesOldestFirst: ReadonlyArray<M>): M[] {
  const out: M[] = [];
  let i = messagesOldestFirst.length - 1;
  while (i >= 0 && messagesOldestFirst[i].sender !== "customer") i--;
  for (; i >= 0 && messagesOldestFirst[i].sender === "customer"; i--) out.unshift(messagesOldestFirst[i]);
  return out;
}

// ─── エリア ─────────────────────────────────────────────────────────────
/** 登録の条件の文（「エリア: 天王寺区、阿倍野区」「エリア：…」）からエリアを読む。無ければ null */
export function areaFromConditions(conditions: string | null | undefined): Prefilled<string> | null {
  const m = (conditions ?? "").match(/(?:^|[\n／|])\s*(?:希望)?エリア\s*[:：]\s*([^\n／|]+)/);
  const v = m?.[1]?.trim();
  if (!v || /^(?:なし|未定|不明|-|ー)$/.test(v)) return null;
  return { value: v.slice(0, 80), source: "conditions", reason: "お客様の登録の条件" };
}

// ─── 記録 ──────────────────────────────────────────────────────────────
export type PrefillUse = { value: string; source: PrefillSource; kept: boolean; final?: string };

/**
 * 送る時の記録（aix_usage_logs.prefill）。自動で入れた欄ごとに、そのまま使ったか（kept）と、直した時の最後の値。
 * 欄の名前は画面の state の名前（例: interiorPropertyName・sendMode）。比べる時は空白の違いを無視する。
 */
export function summarizePrefillUse(
  entries: ReadonlyArray<{ field: string; prefilled: Prefilled<string> | null | undefined; final: string | null | undefined }>,
): Record<string, PrefillUse> | null {
  const out: Record<string, PrefillUse> = {};
  const norm = (s: string | null | undefined) => (s ?? "").replace(/[　\s]+/g, "").trim();
  for (const e of entries) {
    if (!e.prefilled) continue;
    const kept = norm(e.prefilled.value) === norm(e.final);
    out[e.field] = { value: e.prefilled.value.slice(0, 80), source: e.prefilled.source, kept, ...(kept ? {} : { final: (e.final ?? "").slice(0, 80) }) };
  }
  return Object.keys(out).length ? out : null;
}

/** 記録に来た prefill を整える（知らない出所・壊れた形は落とす） */
export function sanitizePrefill(raw: unknown): Record<string, PrefillUse> | null {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return null;
  const out: Record<string, PrefillUse> = {};
  for (const [k, v] of Object.entries(raw as Record<string, unknown>)) {
    if (!/^[A-Za-z_][A-Za-z0-9_]{0,40}$/.test(k) || !v || typeof v !== "object") continue;
    const r = v as Record<string, unknown>;
    if (typeof r.value !== "string" || typeof r.kept !== "boolean" || typeof r.source !== "string" || !(r.source in PREFILL_SOURCE_LABEL)) continue;
    out[k] = { value: r.value.slice(0, 80), source: r.source as PrefillSource, kept: r.kept, ...(typeof r.final === "string" ? { final: r.final.slice(0, 80) } : {}) };
    if (Object.keys(out).length >= 20) break;
  }
  return Object.keys(out).length ? out : null;
}
