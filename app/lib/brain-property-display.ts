// app/lib/brain-property-display.ts
// 画面の物件名（状況の1行の主のお部屋・AIX の物件名の候補・【必ず】の物件名）をブレインの判断（current_property）にそろえる純関数（DB 依存なし・画面からも import できる）。
//
// 2026-10-13 竹内さん（P0 9eb6aa9c・P1 0593a0aa「判断も表示も自動入力も次の行動もブレインが決めた事を使う」）:
//   会話「未桜」10/9: ブレインは current_property を「レジュールアッシュ難波MINAMI」と決めていた（brain_decision_logs.building_key）のに、
//   状況の1行は前の「見積送付済み Alivis新町 802号室」・【必ず】の帯は物件名なし・AIX の物件名は規則だけで決まっていた。
// 決めた事:
//   ・ブレインの判断が新しい時（判断した顧客発言の時刻 analyzed_msg_ts が最新のお客様の発言より前でない時）だけ使う。古い・null・合わない時は今の規則で補う。
//   ・状況の1行（customer-state.ts の resolveCustomerState・brainProperty）: 台帳のお部屋と名前が合う時だけ主のお部屋にする（新しい部屋は作らない）。
//     記録で決まる相手（これからの内覧の物件・申込の物件）は安全の線として残し、ブレインと違う時は食い違い（info）に出すだけ。
//   ・【輪】customer-state はブレインの入力でもある（brain-core の getCustomerState）。ブレインの答えを入力の経路に戻すと誤りが自分を強めるので、
//     この上書きは画面の経路（GET /api/customer-state）だけで使い、ブレインに渡す経路は引数を渡さない（getCustomerState の既定は使わない）。
//   ・AIX: 候補の一番上にブレインの物件を出すだけ（先入れは当たり率を測ってから・設計知見 90d263b1）。
//   ・【必ず】: スタッフが約束の通に書いた名前（「A・B」）は、ブレインの1件が A か B に入っていれば本文のまま。本文に名前が無ければブレイン。
//     食い違う時はブレインを先にし、本文の名前は notes に「本文の名前: 〇〇」で残す。
// 戻す: BRAIN_PROPERTY_DISPLAY=off（サーバ）／NEXT_PUBLIC_BRAIN_PROPERTY_DISPLAY=off（画面。"use client" では NEXT_PUBLIC_ しか入らない）
import {
  splitPropertyName, brainPickRef, isBrainPickFresh, sameBrainPropertyRef, brainPropertyDisplayEnabled, matchRoomRefs,
  type BrainPropertyPick, type RoomRef,
} from "./customer-state";
import { isNotPropertyName } from "./not-property-words";

export { brainPropertyDisplayEnabled, isBrainPickFresh, brainPickRef, brainFocusRoom, type BrainPropertyPick } from "./customer-state";

/** 画面（"use client"）用: NEXT_PUBLIC_BRAIN_PROPERTY_DISPLAY はビルド時に埋め込まれる */
export function brainPropertyDisplayEnvFromPublic(): Record<string, string | undefined> {
  return { BRAIN_PROPERTY_DISPLAY: process.env.NEXT_PUBLIC_BRAIN_PROPERTY_DISPLAY };
}

const ms = (iso: string | null | undefined) => { const t = Date.parse(iso ?? ""); return Number.isFinite(t) ? t : NaN; };

// ─── AIX の物件名の候補 ───

export type BrainOptionCandidate = { name: string; label: string; url: string | null; at: string | null; fromBrain?: boolean };

/**
 * AIX の「お客様が送った物件」の候補の一番上にブレインの物件を出す（先入れはしない）。
 *   同じ物件が候補にあれば、それを一番上に移して印を付ける（候補の表記のまま）。無ければブレインの表記で足す。
 *   ブレインの判断が古い・無い・戻すスイッチが off の時は候補のまま
 */
export function withBrainPropertyFirst(
  options: ReadonlyArray<BrainOptionCandidate>,
  pick: BrainPropertyPick | null | undefined,
  o: { latestCustomerAt: string | null | undefined; env?: Record<string, string | undefined> },
): BrainOptionCandidate[] {
  if (!brainPropertyDisplayEnabled(o.env ?? process.env)) return [...options];
  const name = (pick?.name ?? "").trim();
  if (!name || !isBrainPickFresh(pick, o.latestCustomerAt)) return [...options];
  const ref = brainPickRef(pick);
  if (!ref) return [...options];
  const idx = options.findIndex((c) => { const cr = splitPropertyName(c.name); return !!cr && sameBrainPropertyRef(ref, cr); });
  if (idx >= 0) {
    const hit = { ...options[idx], fromBrain: true };
    return [hit, ...options.slice(0, idx), ...options.slice(idx + 1)];
  }
  // at は null（お客様が送った時刻ではない＝「お客様が〇時に送付」を出さない・今回の連投の共有にも数えない）
  return [{ name, label: name, url: null, at: null, fromBrain: true }, ...options];
}

// ─── 【必ず】の約束の物件名 ───

export type PromisePropertyResolution = {
  /** 約束の行に出す物件名（無ければ null） */
  name: string | null;
  /** 本文の名前を使わなかった時の本文の名前（notes に「本文の名前: 〇〇」で残す） */
  textName: string | null;
  source: "text" | "brain" | "none";
};

/** 2つの文字の編集距離が k 以下か（短い名前の照合だけ） */
function editDistanceAtMost(a: string, b: string, k: number): boolean {
  const x = Array.from(a), y = Array.from(b);
  if (Math.abs(x.length - y.length) > k) return false;
  let prev = Array.from({ length: y.length + 1 }, (_, j) => j);
  for (let i = 1; i <= x.length; i++) {
    const cur = [i];
    for (let j = 1; j <= y.length; j++) cur[j] = Math.min(prev[j] + 1, cur[j - 1] + 1, prev[j - 1] + (x[i - 1] === y[j - 1] ? 0 : 1));
    prev = cur;
  }
  return prev[y.length] <= k;
}

/**
 * 約束の通が何件もの物件の約束か（「お送り頂きました5件」「2部屋」「それぞれの管理会社」）。ブレインの1件で呼ぶと他の物件が消える。
 *   60日の監査（scripts/audit-brain-property-display.ts --part=promise）: 名前の無い約束にブレインの1件を入れた 60通のうち 10通がこの形
 */
const MULTI_PROPERTY_RE = /[2-9２-９二三四五六七八九十]\s*(?:件|部屋|物件|棟)|それぞれ|各(?:物件|お部屋)|全て|全部|両方|まとめて|複数/;
/** 本文の片仮名・英字の語（物件名の手がかり） */
const NAME_WORD_RE = /[ァ-ヶー]{3,}|[A-Za-z][A-Za-z.]{2,}/g;
/** 約束の文によく出る、物件名ではない片仮名・英字（設備・ポータル等は not-property-words の表） */
const STAFF_COMMON_WORD_RE = /^(?:エリア|フェンス|サポート|スムーズ|スタッフ|タイミング|ピックアップ|オススメ|ページ|ルール|チェック|リスト|データ|サービス|イメージ|サイズ|タイプ|センター|ショップ|SNS|URL|PDF|お部屋)$/i;
/** 画面の仮の名前（「物件no.92」「物件①」） */
const PLACEHOLDER_NAME_RE = /^物件\s*(?:no\.?|番号)?\s*[0-9０-９①-⑳]+/i;
/**
 * 約束の本文に、ブレインの物件ではない別の物件名らしい語があるか（「アービングNeo岸里玉出の駐車場」「クリエオーレ一津屋Ⅱの代理契約」）。
 *   本文から物件名を読み取れなかった（confirmPropertyNameOf が null）時に、ブレインの1件で埋めてよいかの安全の線。
 *   60日の監査: 本文に別の物件の名前があるのにブレインの別の物件を入れた誤りが 3通（アービング・クリエオーレ・エグゼの報告の文）
 */
export function otherPropertyWordsIn(text: string | null | undefined, brainName: string): string[] {
  const t = String(text ?? "").normalize("NFKC");
  const b = brainName.normalize("NFKC");
  const words = t.match(NAME_WORD_RE) ?? [];
  return [...new Set(words)].filter((w) => !b.includes(w) && !isNotPropertyName(w) && !STAFF_COMMON_WORD_RE.test(w));
}

/**
 * 約束の通の物件名（本文から読んだ名前・「A・B」）とブレインの物件から、【必ず】の行に出す物件名を決める。
 *   ・本文に名前が無い → ブレイン（新しい時だけ）。ただし本文が何件もの約束（「5件」）・本文にブレインと違う物件名らしい語がある時は名前なしのまま
 *   ・ブレインの1件が本文の A か B に入る（同じ部屋・同じ建物・表記ゆれ）→ 本文のまま
 *   ・食い違う → ブレインを先にし、本文の名前を textName に残す
 */
export function resolvePromisePropertyName(
  textName: string | null | undefined,
  pick: BrainPropertyPick | null | undefined,
  o: { latestCustomerAt: string | null | undefined; env?: Record<string, string | undefined>; promiseText?: string | null },
): PromisePropertyResolution {
  const text = (textName ?? "").trim() || null;
  const keep: PromisePropertyResolution = { name: text, textName: null, source: text ? "text" : "none" };
  if (!brainPropertyDisplayEnabled(o.env ?? process.env)) return keep;
  const brainName = (pick?.name ?? "").trim();
  if (!brainName || PLACEHOLDER_NAME_RE.test(brainName) || !isBrainPickFresh(pick, o.latestCustomerAt)) return keep;
  // ブレインが「A・B」と2件を書いた時は、それぞれを照合する（表示はブレインの書いたまま）
  const brainRefs = brainName.split(/[・、]/).map((s) => brainPickRef({ ...pick!, name: s.trim() })).filter((r): r is NonNullable<typeof r> => !!r);
  if (!brainRefs.length) return keep;
  if (!text) {
    if (MULTI_PROPERTY_RE.test(o.promiseText ?? "")) return keep;
    if (otherPropertyWordsIn(o.promiseText, brainName).length) return keep;
    return { name: brainName, textName: null, source: "brain" };
  }
  const parts = text.split("・").map((s) => s.trim()).filter(Boolean);
  // 表記ゆれ（読み取りの1〜2字の取り違え「ラヴィータ西橘田／西梅田」・似ている・含む）は同じ物件として本文を残す（60日の監査で食い違い 2通とも表記ゆれ）
  const near = (a: RoomRef, b: RoomRef) => sameBrainPropertyRef(a, b) || matchRoomRefs(a, b) === "maybe"
    || (Math.min(a.buildingKey.length, b.buildingKey.length) >= 5 && (!a.room || !b.room || a.room === b.room) && editDistanceAtMost(a.buildingKey, b.buildingKey, 2));
  if (parts.some((p) => { const pr = splitPropertyName(p); return !!pr && brainRefs.some((br) => near(br, pr)); })) return keep;
  return { name: brainName, textName: text, source: "brain" };
}

/**
 * 約束の行を作る前の送信時の記録（1通分）の確認の約束の物件名をブレイン基準にする（カレンダーの行だけに使う。sent_facts の記録は本文のまま）。
 *   変えた時は detail.textPropertyName に本文の名前を残す（無ければ付けない）
 */
export function applyBrainToPromiseEntries<E extends { kind: string; status: string; evidence?: string | null; detail?: { propertyName?: string | null; textPropertyName?: string | null; sentence?: string | null } | null }>(
  entries: ReadonlyArray<E>,
  pick: BrainPropertyPick | null | undefined,
  o: { latestCustomerAt: string | null | undefined; env?: Record<string, string | undefined>; /** 送った本文の全体（無ければ約束の文） */ promiseText?: string | null },
): E[] {
  return entries.map((e) => {
    if (e.kind !== "confirmation_promised" || e.status !== "promised") return e;
    const r = resolvePromisePropertyName(e.detail?.propertyName ?? null, pick, { ...o, promiseText: o.promiseText ?? e.detail?.sentence ?? e.evidence ?? null });
    if (r.source !== "brain") return e;
    return { ...e, detail: { ...(e.detail ?? {}), propertyName: r.name, ...(r.textName ? { textPropertyName: r.textName } : {}) } };
  });
}

/**
 * conversations.suggested_aix_meta / last_brain_meta から、新しい方の判断の current_property を取る（どちらも判断の時刻が無ければ null）。
 *   current_property が null の判断も「ブレインは物件を決めなかった」という新しい判断（古い判断の物件に戻さない）
 */
export function brainPickFromMetas(...metas: Array<{ current_property?: unknown; analyzed_msg_ts?: unknown } | null | undefined>): BrainPropertyPick | null {
  let best: BrainPropertyPick | null = null;
  for (const m of metas) {
    if (!m) continue;
    const ts = typeof m.analyzed_msg_ts === "string" ? m.analyzed_msg_ts : null;
    if (!ts) continue;
    if (best && ms(best.analyzedMsgTs) >= ms(ts)) continue;
    const cp = typeof m.current_property === "string" ? m.current_property.trim() : "";
    best = { name: cp || null, analyzedMsgTs: ts };
  }
  return best;
}
