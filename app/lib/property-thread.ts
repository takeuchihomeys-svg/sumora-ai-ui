// app/lib/property-thread.ts
// 物件ごとの状況の台帳（1つの会話で出た物件1件ずつの出来事と今の状況）＋今の番がどの物件の話か（純関数・DB に触らない）。
//
// 2026-10-07 竹内（S❤ 10/7 01:24 の見張り「事実違い: 物件」）:
//   「物件ごとに状況を把握できていたら、出来る、今物件の事把握できていないのかもしれない。物件にたいして反応や進捗があれば
//    1件ずつそのデータ保管して、物件の事にたいしての話になったときは、状況を理解出来るようにした方が良い」
//
// 【実物で追った出所】（会話 d3a56a97・10/6〜10/7）
//   13:15 こちらが4件の資料を送った（クリエオーレ私市山手104・ポルテ・ボヌールB棟0203・クリエオーレ一津屋Ⅱ103・フェリオ永田101）
//   13:58 お客様「こちらの初期費用知りたいです」＝フェリオ永田101 の資料の**引用**
//   19:21 AIX【物件確認した】画像3枚＋「シャーメゾン フェリシード 101号室 募集中・見積書同封」（記録の物件名は「物件①」「シャーメゾン フェリシード 101号室」）
//   01:24 お客様「こちら礼金は少し安くなったりは」＝19:21 の**名前の無い画像**（見積書）の引用／「あとこちらの詳細も」＝一津屋Ⅱ103 の資料の引用
//   AI の案は「シャーメゾン フェリシード 101号室の礼金について減額交渉」（本文に名前が出ていた方に寄せた）、
//   スタッフは「ファリオ永田の礼金について減額交渉」＝13:58 に初期費用を聞かれた物件の見積書だった。
//   ブレインには引用先が「[画像]」としか渡らない（quoted-context は sent_image_properties にある資料の画像だけ物件に直せる。
//   AIX の見積書の画像は記録が無い）＝物件ごとの「聞かれた→見積→交渉」のつながりが材料に無かった。
//
// 【作り】二重管理にしない: 名前の寄せ方は customer-state（splitPropertyName / matchRoomRefs）、画像→物件は送った時の記録
//   （sent_image_properties / sent_properties）、出来事は messages・aix_usage_logs・estimate_records をその場で読んで並べる（新しい表は作らない）。
//   AIX の画像で名前の記録が無い物は、同じ AIX の物件名（property_names）のうち画像の記録が無い1件に寄せる。
//   物件名が「物件①」等の仮の名前なら、その AIX より前にお客様が費用・募集状況を聞いて答えがまだの物件に寄せる（inferred＝推定と書く）。
//
// 戻す: PROPERTY_THREAD_NOTE=off（ブレイン・返信の材料に入れない）
import { splitPropertyName, matchRoomRefs, buildingKeyOf, type RoomRef } from "./customer-state";
import { alternativeCaptureEnabled } from "./staff-capture";
import { jstParts } from "./jst-date";
// 2026-10-08 8巡目（記録の続き・竹内「オススメした物件と、お客さんが送ってきた物件をちゃんと保管できていればできる」）
import { extractScreenshotProperty, seriesTokens } from "./own-property-match";
import { similarity } from "./property-name-match";
import { customerSharedPropertyNames, customerNamedAfterShare, type NamedAfterShare } from "./customer-property-names";
import { collectStaffFreeRent, staffFreeRentFor, type StaffFreeRentFact } from "./staff-free-rent";
// 2026-10-09 主語の抜けた発言の物件の候補（turn-referent.ts・既定 on・PROPERTY_REFERENT_FALLBACK=off で止まる）
import { resolveTurnReferent, turnReferentEnabled, turnReferentLines, type ReferentMention, type TurnReferent } from "./turn-referent";

export function propertyThreadEnabled(): boolean {
  return (process.env.PROPERTY_THREAD_NOTE ?? "").toLowerCase() !== "off";
}

export type PtMsg = {
  sender: string; text: string | null; created_at: string;
  line_message_id?: string | null; quoted_message_id?: string | null; image_url?: string | null; is_aix_generated?: boolean | null;
};
export type PtAix = {
  created_at: string; aix_type: string | null; check_pattern?: string | null;
  property_names?: string[] | null; prop_statuses?: string[] | null; estimate_sent?: boolean | null; generated_text?: string | null;
};
export type PtEstimate = {
  created_at: string; property_name: string | null; room_no: string | null;
  /** 2026-10-08 8巡目（記録）: 見積書の割引・初期費用（estimate_records）。台帳の「見積書を送った」に金額を添える（AD は渡さない＝お客様向けの文に出さない） */
  discount_yen?: number | null; initial_cost_yen?: number | null;
};

/** 見積書の金額の短い文（「割引 26,500円・初期費用 208,110円」）。金額が無い・PROPERTY_THREAD_ESTIMATE_AMOUNT=off なら null */
export function estimateAmountText(e: Pick<PtEstimate, "discount_yen" | "initial_cost_yen">, env: Record<string, string | undefined> = process.env): string | null {
  if ((env.PROPERTY_THREAD_ESTIMATE_AMOUNT ?? "").toLowerCase() === "off") return null;
  const parts: string[] = [];
  if (typeof e.discount_yen === "number" && e.discount_yen > 0) parts.push(`割引 ${e.discount_yen.toLocaleString("ja-JP")}円`);
  if (typeof e.initial_cost_yen === "number" && e.initial_cost_yen > 0) parts.push(`初期費用 ${e.initial_cost_yen.toLocaleString("ja-JP")}円`);
  return parts.length ? parts.join("・") : null;
}
/** 物件オススメの控え（recommendation_snapshots）: 🌟の物件と本文 */
export type PtRecommendation = { sent_at: string; star_name: string | null; star_room: string | null; star_text?: string | null };

/** 🌟の本文の要旨（見出しの次の「・」の行か最初の文・2つまで・60字） */
export function recommendGist(starText: string | null | undefined): string | null {
  const lines = String(starText ?? "").split(/\r?\n/).map((l) => l.trim()).filter(Boolean);
  const body = lines.filter((l) => !/^🌟/.test(l) && !/^（?オススメポイント）?$/.test(l) && !/ご査収|お手隙/.test(l));
  const bullets = body.filter((l) => /^[・-]/.test(l)).map((l) => l.replace(/^[・-]\s*/, ""));
  const picks = (bullets.length ? bullets : body).slice(0, 2).map((l) => l.replace(/[！!]+$/, ""));
  const g = Array.from(picks.join("／")).slice(0, 60).join("");
  return g || null;
}

/** 2本柱の拡張を戻す: PROPERTY_THREAD_ORIGIN=off（オススメ・持ち込み・食いつき・フリーレント・内覧の出来事を足さない＝7巡目の台帳） */
export function propertyThreadOriginEnabled(env: Record<string, string | undefined> = process.env): boolean {
  return (env.PROPERTY_THREAD_ORIGIN ?? "").toLowerCase() !== "off";
}

export type PtInput = {
  messages: ReadonlyArray<PtMsg>;
  /** 物件オススメの控え（🌟の文）。2026-10-08 */
  recommendations?: ReadonlyArray<PtRecommendation>;
  /** 画像 URL → 送った物件の名前（sent_image_properties → sent_properties の順） */
  imageLabels: ReadonlyMap<string, string>;
  aix?: ReadonlyArray<PtAix>;
  estimates?: ReadonlyArray<PtEstimate>;
};

export type PtTopic = "cost" | "discount" | "detail" | "vacancy" | "viewing" | "photo" | "like" | "ng" | "other";
export type PtEventKind =
  | "sent" | "customer_shared" | "customer_ask" | "check_available" | "check_vacating" | "check_ended" | "estimate"
  | "staff_negotiating" | "staff_checking" | "staff_result"
  // 2026-10-08: こちらがオススメした（🌟）・内覧の候補日を出した・内覧（待ち合わせ）が決まった
  | "recommended" | "viewing_offered" | "viewing_set"
  // 2026-10-14 取りこぼしの無い設計（37af1885）: AIX【物件確認した】の「別の部屋」＝聞かれた部屋の代わりに同じ建物で募集中の部屋を案内した
  | "check_alternative";
export type PtEvent = { at: string; kind: PtEventKind; topic?: PtTopic; by: "quote" | "named" | "record" | "inferred"; text?: string };
export type PtRoom = {
  key: string; ref: RoomRef; names: string[]; events: PtEvent[]; sentByUs: boolean;
  /** 2026-10-08 物件の出所: ours＝こちらが送った/オススメした物件・customer＝お客様が送ってきた（持ち込み）物件。最初の出来事で決める */
  origin?: "ours" | "customer" | null;
  /** お客様が食いついた（反応・質問・内覧希望・見積の依頼）最初の時刻と話題 */
  hooked?: { at: string; topic: PtTopic } | null;
  /** スタッフが送った文に書いたフリーレント（staff-free-rent・資料からは読まない） */
  freeRent?: StaffFreeRentFact | null;
};
export type PtTurnTarget = { roomKey: string; display: string; topic: PtTopic; by: "quote" | "named" | "inferred"; customerText: string; at: string; why?: string };
export type PropertyThreadState = {
  rooms: PtRoom[]; turnTargets: PtTurnTarget[];
  /** 2026-10-09 引用・名指しが無い主語の抜けた番の物件の候補（turnTargets とは別に持つ＝内覧の確認・契約の答え等の他の利用者の動きは変えない） */
  turnReferent?: TurnReferent | null;
  /** turnReferent の元になったお客様の文 */
  turnReferentText?: string;
  /**
   * 2026-10-13 区切り4（レビュー）: 並びの何番目・内覧の日にちの返事からの推定の ▶（turnTargets には入れない＝契約の答え・内覧の確認・
   * 写真の材料・turnReferent の動きを変えない）。台帳の文（ブレインの材料）にだけ出す
   */
  turnHints?: PtTurnTarget[];
};

const PLACEHOLDER_RE = /^(?:物件|お部屋)\s*[①-⑳0-9０-９]*$/;
/** 物件名でない物（挨拶・ポータルの一覧の見出し・省略の点） */
const NOT_PROPERTY_NAME_RE = /お世話になって|お疲れ様|ありがとうございます|賃貸物件一覧|物件一覧|検索結果|・・・|…|最近見た物件/;
const TOPIC_RES: Array<[PtTopic, RegExp]> = [
  ["discount", /礼金|敷金|安く|値下|減額|交渉|割引|まけ|下げ/],
  ["cost", /初期費用|費用|見積|いくら|金額|総額/],
  ["photo", /写真|動画|画像/],
  ["vacancy", /空き|空いて|募集|まだあり|残って|埋まっ/],
  ["viewing", /内覧|内見|見に行|見学/],
  ["detail", /詳細|詳しく|間取り|設備|情報/],
  ["ng", /なし|無しで|やめ|微妙|厳し|合わな|違う/],
  ["like", /いい|良い|良さ|気になる|素敵|好き|ここで/],
];
export function topicOf(text: string): PtTopic {
  const t = String(text ?? "");
  for (const [k, re] of TOPIC_RES) if (re.test(t)) return k;
  return "other";
}
const STATUS_KIND: Record<string, PtEventKind> = { available: "check_available", vacating: "check_vacating", unavailable: "check_ended", ended: "check_ended" };
/**
 * 物件確認の状態 → 出来事。2026-10-14（37af1885）: 「別の部屋」（alternative）は旧は読まず出来事が無かった
 *   （台帳に無い＝今の番の物件の候補・並びに入らず、次のブレインの今の物件がその部屋 0/6）。STAFF_CAPTURE_ALTERNATIVE=off で旧
 */
function statusKindOf(st: string): PtEventKind | undefined {
  if (st === "alternative") return alternativeCaptureEnabled() ? "check_alternative" : undefined;
  return STATUS_KIND[st];
}
const NEGOTIATE_RE = /交渉/;
const CHECK_PROMISE_RE = /確認(?:させて|致し|いたし|し)[^\n。！!]{0,20}(?:ます|次第)/;
const RESULT_RE = /(?:とのご返事|とのご返答|とのことでした|難しい|出来ません|できません|可能です|可能との)/;

const ms = (iso: string) => Date.parse(iso);
const isImage = (m: PtMsg) => !!m.image_url || /^\s*\[画像\]/.test(m.text ?? "");

/** JST の「10/6 13:58」 */
export function jstShort(iso: string): string {
  const p = jstParts(iso);
  return `${p.m}/${p.d} ${String(p.hour).padStart(2, "0")}:${String(p.minute).padStart(2, "0")}`;
}

export function resolvePropertyThreads(input: PtInput): PropertyThreadState {
  const rooms: PtRoom[] = [];
  const msgs = [...input.messages].sort((a, b) => ms(a.created_at) - ms(b.created_at));
  const byLmid = new Map<string, PtMsg>();
  for (const m of msgs) if (m.line_message_id) byLmid.set(m.line_message_id, m);

  // 2026-10-09 読み取り（OCR）の名前の化け（「ロッジール城山町」↔「ロワジール城山町」・「セニャリプロ」↔「セニャリブロ」・「LOCHAS」↔「LOHAS」）:
  //   片方が画像の読み取りの名前の時だけ、名前が近く（matchRoomRefs の maybe）・号室が同じ・シリーズの番号が同じなら同じ部屋にし、
  //   表示はスタッフが打った名前（AIX の物件名・手打ちの本文・見積書の記録）にする。既定 on（10/09 試験の途中で全体が悪くならない）・戻す: PROPERTY_THREAD_OCR_REPAIR=off
  const ocrRepair = (process.env.PROPERTY_THREAD_OCR_REPAIR ?? "").toLowerCase() !== "off";
  const ocrRooms = new Set<PtRoom>();
  const findRoom = (ref: RoomRef, ocr: boolean): PtRoom | null => {
    for (const r of rooms) { const k = matchRoomRefs(ref, r.ref); if (k === "same_room" || (k === "same_building" && (!ref.room || !r.ref.room))) return r; }
    if (ocrRepair) {
      for (const r of rooms) {
        if (!ocr && !ocrRooms.has(r)) continue; // どちらかが読み取りの名前の時だけ
        if (!ref.room || !r.ref.room || ref.room !== r.ref.room) continue;
        // 近さは括弧の読み仮名（「（ロッジールシヤマヤマチヤウ）」「(テン)」）を外して測る。線 0.65（実物: ロッジール↔ロワジール 0.67・スブランディッド↔スプランディッド 0.75／
        //   別の建物: スプランディッド難波WESTⅢ↔鶴渡西Ⅲ 0.59・エスリード弁天町グランツ↔ベイコート 0.60 は同じ号室でも寄せない）
        const keyOf = (b: string) => buildingKeyOf(b.replace(/[（(][^）)]*[）)]/g, ""));
        if (matchRoomRefs(ref, r.ref) !== "maybe" && similarity(keyOf(ref.building), keyOf(r.ref.building)) < 0.65) continue;
        if (seriesTokens(ref.building) !== seriesTokens(r.ref.building)) continue;
        return r;
      }
    }
    return null;
  };
  const roomOf = (name: string | null | undefined, sentByUs: boolean, ocr = false): PtRoom | null => {
    if (!name || PLACEHOLDER_RE.test(name.trim())) return null;
    // 2026-10-09 物件名でない物（お客様のスクショの挨拶・ポータルの一覧の見出し）を物件にしない（audit-hidden-subject の実物）
    if (NOT_PROPERTY_NAME_RE.test(name)) return null;
    const ref = splitPropertyName(name);
    if (!ref) return null;
    const hit = findRoom(ref, ocr);
    if (hit) {
      if (!hit.names.includes(ref.display)) hit.names.push(ref.display);
      // 読み取りの名前の部屋に、打った名前が来たら表示を打った名前に替える
      if (!ocr && ocrRooms.has(hit)) { hit.ref = { ...ref, room: ref.room ?? hit.ref.room }; ocrRooms.delete(hit); }
      else if (!hit.ref.room && ref.room) hit.ref = ref;
      hit.sentByUs ||= sentByUs; return hit;
    }
    const r: PtRoom = { key: `${ref.buildingKey}#${ref.room ?? ""}`, ref, names: [ref.display], events: [], sentByUs };
    rooms.push(r);
    if (ocr) ocrRooms.add(r);
    return r;
  };
  const push = (r: PtRoom | null, e: PtEvent) => {
    if (!r) return;
    // 同じ種類の出来事が10分以内に重なったら1つ（束で送った画像の重複）
    if (r.events.some((x) => x.kind === e.kind && x.topic === e.topic && Math.abs(ms(x.at) - ms(e.at)) < 10 * 60_000)) return;
    r.events.push(e);
  };

  // ① 送った資料の画像（記録のある物）
  const imageRoom = new Map<string, PtRoom>(); // message の line_message_id or image_url → 物件
  for (const m of msgs) {
    if (m.sender !== "staff" || !m.image_url) continue;
    const label = input.imageLabels.get(m.image_url);
    const r = roomOf(label, true, true);
    if (!r) continue;
    imageRoom.set(m.line_message_id ?? m.image_url, r);
    push(r, { at: m.created_at, kind: "sent", by: "record" });
  }

  const originOn = propertyThreadOriginEnabled();
  // ①' 物件オススメの控え（🌟の物件・本文の要旨）。AIX の記録より先に置く（同じ送信の重なりは本文の要旨つきの方を残す）
  if (originOn) {
    for (const rc of input.recommendations ?? []) {
      const name = rc.star_name ? (rc.star_room ? `${rc.star_name} ${rc.star_room}号室` : rc.star_name) : null;
      const gist = recommendGist(rc.star_text);
      push(roomOf(name, true), { at: rc.sent_at, kind: "recommended", by: "record", ...(gist ? { text: gist } : {}) });
    }
  }

  // ② AIX の記録（物件確認の結果・見積書）。名前の記録が無い画像は同じ AIX の物件名に寄せる
  const placeholderImages: Array<{ msg: PtMsg; aixAt: string }> = [];
  for (const a of [...(input.aix ?? [])].sort((x, y) => ms(x.created_at) - ms(y.created_at))) {
    const names = (a.property_names ?? []).map((n) => String(n ?? "").trim());
    const sts = a.prop_statuses ?? [];
    const named: Array<PtRoom | null> = names.map((n) => roomOf(n, false));
    names.forEach((n, i) => {
      const r = named[i];
      if (!r) return;
      const k = statusKindOf(String(sts[i] ?? ""));
      if (a.aix_type === "property_check_result" && k) push(r, { at: a.created_at, kind: k, by: "record" });
      if (a.estimate_sent) push(r, { at: a.created_at, kind: "estimate", by: "record" });
      if (originOn) {
        if (a.aix_type === "property_recommendation") { r.sentByUs = true; push(r, { at: a.created_at, kind: "recommended", by: "record" }); }
        else if (a.aix_type === "property_send") { r.sentByUs = true; push(r, { at: a.created_at, kind: "sent", by: "record" }); }
        else if (a.aix_type === "estimate_sheet") push(r, { at: a.created_at, kind: "estimate", by: "record" });
        else if (a.aix_type === "viewing_invite") push(r, { at: a.created_at, kind: "viewing_offered", by: "record" });
        else if (a.aix_type === "meeting_place") push(r, { at: a.created_at, kind: "viewing_set", by: "record" });
      }
    });
    if (a.aix_type === "estimate_sheet") {
      for (const mm of String(a.generated_text ?? "").matchAll(/【([^】\n]{2,40})】/g)) push(roomOf(mm[1], false), { at: a.created_at, kind: "estimate", by: "record" });
    }
    // この AIX の画像（AIX の記録の 20 秒前〜記録の時刻・スタッフの画像）を、物件名の並び（property_names の順）に寄せる。
    //   AIX は物件ごとに画像を続けて送る（資料→見積書）。記録のある画像を目印に、目印より前の画像は前の物件・後ろは目印の物件。
    //   目印が無く、画像の数が物件の数で割り切れる時は均等に分ける（c024b7b9: 画像4枚・2件＝前2枚が1件目）。どちらでもなければ寄せない（推測しない）
    const burst = msgs.filter((m) => m.sender === "staff" && isImage(m) && m.is_aix_generated !== false
      && ms(m.created_at) <= ms(a.created_at) + 2000 && ms(m.created_at) >= ms(a.created_at) - 20_000);
    if (!burst.length || !names.length) continue;
    const idOf = (m: PtMsg) => m.line_message_id ?? m.image_url ?? "";
    // 2026-10-09 引用先の画像の名前の化け（読み取り「RIHGII Saison 3F田 1505号室」↔ AIX の物件名「RISING Maison 本町橋 1505号室」・名前の近さ 0.38）:
    //   同じ AIX の束の画像で、読み取りの名前の部屋が AIX の物件名のどれとも合わず、号室（3〜4桁）が同じ物件名が1つだけある時は、その物件に寄せる
    //   （画像の行き先と出来事を打った名前の部屋へ移し、読み取りの部屋は消す）。戻す: PROPERTY_THREAD_OCR_REPAIR=off
    if (ocrRepair) {
      for (const m of burst) {
        const r = imageRoom.get(idOf(m));
        if (!r || !ocrRooms.has(r) || named.includes(r) || !r.ref.room || r.ref.room.length < 3) continue;
        // シリーズの番号が両方にあって違う（サウスプレイスⅧ／Ⅵ）なら別の建物＝寄せない
        const sr = seriesTokens(r.ref.building);
        const same = named.filter((x): x is PtRoom => !!x && x.ref.room === r.ref.room && !(sr && seriesTokens(x.ref.building) && seriesTokens(x.ref.building) !== sr));
        if (same.length !== 1) continue;
        const to = same[0];
        for (const [k, v] of imageRoom) if (v === r) imageRoom.set(k, to);
        for (const e of r.events) if (!to.events.some((x) => x.kind === e.kind && Math.abs(ms(x.at) - ms(e.at)) < 10 * 60_000)) to.events.push(e);
        for (const n of r.names) if (!to.names.includes(n)) to.names.push(n);
        to.sentByUs ||= r.sentByUs;
        const idx = rooms.indexOf(r); if (idx >= 0) rooms.splice(idx, 1);
        ocrRooms.delete(r);
      }
    }
    const anchorIdx = burst.map((m) => { const r = imageRoom.get(idOf(m)); return r ? named.findIndex((x) => x === r) : -1; });
    const assign = (m: PtMsg, slot: number) => {
      if (slot < 0 || slot >= names.length || imageRoom.has(idOf(m))) return;
      const r = named[slot];
      if (r) imageRoom.set(idOf(m), r);
      else if (PLACEHOLDER_RE.test(names[slot])) placeholderImages.push({ msg: m, aixAt: a.created_at });
    };
    if (anchorIdx.some((i) => i >= 0)) {
      const firstAnchor = anchorIdx.findIndex((i) => i >= 0);
      let cur = -1;
      burst.forEach((m, j) => {
        if (anchorIdx[j] >= 0) { cur = anchorIdx[j]; return; }
        if (j < firstAnchor) { if (anchorIdx[firstAnchor] === 1) assign(m, 0); return; } // 目印より前の物件が1件だけの時
        assign(m, cur);
      });
    } else if (burst.length % names.length === 0) {
      const k = burst.length / names.length;
      burst.forEach((m, j) => assign(m, Math.floor(j / k)));
    }
  }

  for (const e of input.estimates ?? []) {
    const r = roomOf(e.room_no ? `${e.property_name ?? ""} ${e.room_no}号室` : e.property_name, false);
    const amount = estimateAmountText(e);
    // 同じ見積書が AIX の記録から先に載っている時（10分以内）は、そこに金額を添える（2つにしない）
    const same = r && amount ? r.events.find((x) => x.kind === "estimate" && !x.text && Math.abs(ms(x.at) - ms(e.created_at)) < 10 * 60_000) : undefined;
    if (same) same.text = amount ?? undefined;
    else push(r, { at: e.created_at, kind: "estimate", by: "record", ...(amount ? { text: amount } : {}) });
  }

  // ③ お客様の発言（引用・名指し）と、スタッフの手打ち（交渉・確認・結果）
  const customerAsks: Array<{ r: PtRoom; at: string; topic: PtTopic }> = [];
  const staffTextMentions: ReferentMention[] = [];
  const resolvePlaceholder = (aixAt: string): PtRoom | null => {
    // 仮の名前の画像＝その AIX より前に、お客様が費用・募集状況を聞き、まだ見積・確認の結果が無い物件（一番新しい物）
    const cands = customerAsks.filter((c) => ms(c.at) < ms(aixAt) && (c.topic === "cost" || c.topic === "vacancy" || c.topic === "discount")
      && !c.r.events.some((e) => (e.kind === "estimate" || e.kind.startsWith("check_")) && ms(e.at) > ms(c.at) && ms(e.at) <= ms(aixAt) && e.by !== "inferred"));
    return cands.length ? cands[cands.length - 1].r : null;
  };
  const roomsNamedIn = (text: string): PtRoom[] => {
    // 照合は建物の鍵と同じ形（長音・記号・空白を外す）にそろえる
    const t = buildingKeyOf(text);
    return rooms.filter((r) => r.ref.buildingKey.length >= 3 && t.includes(r.ref.buildingKey));
  };
  // 2026-10-13 竹内（未桜）: 持ち込み（動画の URL・画像）の後にお客様が名前だけ送った発言（「レジュールアッシュ難波MINAMIです」）は持ち込みの物件の名前の候補
  //   （customer-property-names.customerNamedAfterShare・戻す: CUSTOMER_NAME_AFTER_SHARE=off）。どの物件の話かはブレインが台帳の文を読んで決める
  const namedAfterShare = new Map<string, NamedAfterShare>();
  if (originOn) for (const c of customerNamedAfterShare(msgs.map((m) => ({ sender: m.sender, text: m.text ?? (m.image_url ? "[画像]" : ""), createdAt: m.created_at })))) if (c.at) namedAfterShare.set(c.at, c);
  for (const m of msgs) {
    if (m.sender === "customer") {
      const text = String(m.text ?? "");
      const nas = namedAfterShare.get(m.created_at);
      if (nas && roomsNamedIn(text).length === 0) {
        const r = roomOf(nas.label, false);
        if (r) {
          push(r, { at: m.created_at, kind: "customer_shared", by: "named", text: `名前だけ・${nas.sharedAt ? jstShort(nas.sharedAt) : ""}の持ち込み（${nas.url ? "URL" : "画像"}）の続き` });
          continue;
        }
      }
      const q = m.quoted_message_id ? byLmid.get(m.quoted_message_id) : undefined;
      let target: PtRoom | null = null; let by: PtEvent["by"] = "quote";
      if (q) {
        target = imageRoom.get(q.line_message_id ?? q.image_url ?? "") ?? null;
        if (!target) {
          const ph = placeholderImages.find((p) => p.msg === q);
          if (ph) { target = resolvePlaceholder(ph.aixAt); by = "inferred"; }
        }
        if (!target && q.text) target = roomsNamedIn(q.text)[0] ?? null;
      }
      if (!target) { const named = roomsNamedIn(text); if (named.length === 1) { target = named[0]; by = "named"; } }
      // 2026-10-08 お客様が送ってきた物件（SUUMO 等の画面・資料の画像の書き起こし）: 知らない物件でも1件の物件として残す（持ち込み）
      if (!target && originOn && /^\s*\[画像\]/.test(text)) {
        const sp = extractScreenshotProperty(text);
        // 書き起こしの文（「近隣の駐車場が満車で見つかっておりません。」）を物件名にしない（YUMA の実物・10/08）
        if (sp?.name && sp.name.length <= 40 && !/[。！!？?]|ません|おります|ございます|です|ます$/.test(sp.name)) { target = roomOf(sp.room ? `${sp.name} ${sp.room}号室` : sp.name, false, true); by = "named"; }
      }
      // ポータルの共有文（SUUMO「物件名 / URL / by SUUMO」・athome「物件名：」）＝持ち込み。元の URL は出来事の text に残す
      //   （本文に知っている物件名が出ていても、共有文なら「送ってきた」として残す＝名指しの質問にしない）
      if ((!target || by === "named") && originOn && /https?:\/\//.test(text)) {
        const cands = customerSharedPropertyNames([{ sender: "customer", text, createdAt: m.created_at }], { limit: 5 });
        if (cands.length) {
          for (const c of cands) push(roomOf(c.name, false), { at: m.created_at, kind: "customer_shared", by: "named", ...(c.url ? { text: c.url.slice(0, 120) } : {}) });
          continue;
        }
      }
      if (!target) continue;
      // 画像の書き起こし（ポータルの画面・資料）は文の中の「敷金」等で話題を読まない＝お客様が物件を送ってきた（ゆなまる 10/6「シャーメゾン ソレイユ」の画面）
      if (/^\s*\[画像\]/.test(text)) { push(target, { at: m.created_at, kind: "customer_shared", by }); continue; }
      const topic = topicOf(text);
      push(target, { at: m.created_at, kind: "customer_ask", topic, by, text: Array.from(text.replace(/\s+/g, " ")).slice(0, 40).join("") });
      customerAsks.push({ r: target, at: m.created_at, topic });
    } else if (m.sender === "staff" && m.text && !isImage(m)) {
      const named = roomsNamedIn(m.text);
      for (const r of named) staffTextMentions.push({ at: m.created_at, roomKey: r.key, display: r.ref.display, by: "ours" });
      if (named.length !== 1) continue;
      const r = named[0];
      if (RESULT_RE.test(m.text) && /(?:交渉|確認)させて(?:頂|いただ)きました|ご返事|ご返答/.test(m.text)) push(r, { at: m.created_at, kind: "staff_result", by: "named", text: Array.from(m.text.replace(/\s+/g, " ")).slice(0, 60).join("") });
      else if (NEGOTIATE_RE.test(m.text)) push(r, { at: m.created_at, kind: "staff_negotiating", by: "named" });
      else if (CHECK_PROMISE_RE.test(m.text)) push(r, { at: m.created_at, kind: "staff_checking", by: "named" });
    }
  }
  // 仮の名前の画像に付いた見積・確認を、推定した物件にも付ける（お客様の引用が来た時に分かる）
  for (const p of placeholderImages) {
    const r = resolvePlaceholder(p.aixAt);
    if (r) push(r, { at: p.aixAt, kind: "estimate", by: "inferred" });
  }
  for (const r of rooms) r.events.sort((a, b) => ms(a.at) - ms(b.at));
  if (originOn) {
    const freeRent = collectStaffFreeRent(msgs.filter((m) => m.sender === "staff" && m.text && !isImage(m)).map((m) => ({ text: m.text, createdAt: m.created_at })));
    for (const r of rooms) {
      const first = r.events.find((e) => e.kind === "sent" || e.kind === "recommended" || e.kind === "customer_shared" || e.kind.startsWith("check_"));
      // 別の部屋（check_alternative）はこちらが代わりに案内した部屋＝ours
      r.origin = !first ? null : first.kind === "sent" || first.kind === "recommended" || first.kind === "check_alternative" ? "ours" : "customer";
      const h = r.events.find((e) => e.kind === "customer_ask" && e.topic !== "ng");
      r.hooked = h ? { at: h.at, topic: h.topic ?? "other" } : null;
      r.freeRent = freeRent.length ? staffFreeRentFor(freeRent, r.ref.building, r.ref.room) : null;
    }
    // 物件の名前が同じ行に無いフリーレント（「グランメール弁天 503号室現在募集中…\nこちらフリーレント1ヶ月…」）は、その通に名前が出た物件が1つならその物件
    for (const f of freeRent) {
      if (f.property) continue;
      const m = msgs.find((x) => x.sender === "staff" && x.created_at === f.at);
      const named = m?.text ? roomsNamedIn(m.text) : [];
      if (named.length === 1 && !named[0].freeRent) named[0].freeRent = f;
    }
  }

  // ④ 今の番（最後のスタッフの発言より後のお客様の発言）がどの物件の話か
  const lastStaffAt = [...msgs].reverse().find((m) => m.sender === "staff")?.created_at;
  const turnTargets: PtTurnTarget[] = [];
  for (const r of rooms) {
    for (const e of r.events) {
      if ((e.kind !== "customer_ask" && e.kind !== "customer_shared") || (lastStaffAt && ms(e.at) <= ms(lastStaffAt))) continue;
      turnTargets.push({ roomKey: r.key, display: r.ref.display, topic: e.topic ?? "other", by: e.by === "record" ? "quote" : e.by, customerText: e.text ?? "", at: e.at });
    }
  }
  // 2026-10-08 名前の無い「前にオススメしてくれた物件」「送ってもらったお部屋」: 一番新しいオススメ（無ければ送った物件）と推定する
  if (originOn && turnTargets.length === 0) {
    const turnMsgs = msgs.filter((m) => m.sender === "customer" && (!lastStaffAt || ms(m.created_at) > ms(lastStaffAt)) && !isImage(m));
    const ref = turnMsgs.find((m) => GENERIC_REF_RE.test(String(m.text ?? "")) || CUSTOMER_SENT_REF_RE.test(String(m.text ?? "")));
    if (ref) {
      const rt = String(ref.text ?? "");
      // 「私が送った物件」「最初に送ったお部屋」＝お客様が送ってきた物件（持ち込み）。「送って頂いた」はこちらが送った物件
      const wantShared = CUSTOMER_SENT_REF_RE.test(rt) && !GENERIC_REF_RE.test(rt);
      const wantRec = /オススメ|おすすめ|お勧め|お薦め/.test(rt);
      const firstWanted = /最初|初め|はじめ/.test(rt);
      const pickOf = (kinds: PtEventKind[]) => {
        // 名前の無い呼び方は最近の話（14日以内の出来事）の中で決める（台帳は期間を問わず残すので、古い会話の物件に飛ばない）
        const from = ms(ref.created_at) - 14 * 86400_000;
        const xs = rooms.map((r) => ({ r, e: r.events.filter((e) => kinds.includes(e.kind) && ms(e.at) < ms(ref.created_at) && ms(e.at) >= from).at(-1) }))
          .filter((x): x is { r: PtRoom; e: PtEvent } => !!x.e).sort((a, b) => ms(b.e.at) - ms(a.e.at));
        return (firstWanted ? xs.at(-1) : xs[0]) ?? null;
      };
      const hit = wantShared ? pickOf(["customer_shared"]) : (wantRec ? pickOf(["recommended"]) : null) ?? pickOf(["recommended", "sent"]);
      if (hit) {
        const label = hit.e.kind === "recommended" ? "オススメした物件" : hit.e.kind === "customer_shared" ? "お客様が送ってきた物件" : "送った物件";
        turnTargets.push({ roomKey: hit.r.key, display: hit.r.ref.display, topic: topicOf(rt), by: "inferred", customerText: Array.from(rt.replace(/\s+/g, " ")).slice(0, 40).join(""), at: ref.created_at,
          why: `（名前の無い呼び方・${firstWanted ? "一番最初に" : "一番新しく"}${label} ${jstShort(hit.e.at)} と推定）` });
      }
    }
  }
  const turnHints: PtTurnTarget[] = [];
  // 2026-10-13 当たり率の直し（区切り4 材料①）: 「1番上のやつ」「2番目」「最後の」＝直前にこちらが送った物件の並び（同じ束の資料・オススメ・見積）の何番目か。
  //   ad97cd40 10/12「1番上のやつ最短入居いくらですか？」→ ブレインは前の物件（プレジオ難波EURO）を言った。材料を渡すだけ（決めるのはブレイン）。戻す: PROPERTY_THREAD_ORDINAL=off
  if (originOn && propertyThreadOrdinalEnabled() && turnTargets.length === 0) {
    const turnMsgs = msgs.filter((m) => m.sender === "customer" && (!lastStaffAt || ms(m.created_at) > ms(lastStaffAt)) && !isImage(m));
    const hit = turnMsgs.map((m) => ({ m, idx: ordinalIndexOf(String(m.text ?? "")) })).find((x) => x.idx !== null);
    if (hit) {
      const batch = lastOursBatch(rooms, hit.m.created_at);
      const i = hit.idx === -1 ? batch.length - 1 : hit.idx!;
      if (batch.length >= 2 && i >= 0 && i < batch.length) {
        const r = batch[i];
        turnHints.push({ roomKey: r.key, display: r.ref.display, topic: topicOf(String(hit.m.text ?? "")), by: "inferred", customerText: Array.from(String(hit.m.text ?? "").replace(/\s+/g, " ")).slice(0, 40).join(""), at: hit.m.created_at,
          why: `（「${ordinalWordOf(String(hit.m.text ?? ""))}」＝直前にこちらが送った${batch.length}件の並び（${batch.map((x) => x.ref.display).join("・")}）の${hit.idx === -1 ? "最後" : `${i + 1}件目`}と推定）` });
      }
    }
  }
  // 2026-10-13 当たり率の直し（区切り4 材料②）: 内覧の日にち・時間だけの返事（「10日でお願い致します」「13時でお願いします」）は、
  //   直前にこちらが内覧の日程を出した通に書いた物件（無ければ内覧調整の記録の物件）の話。5dd2d456・63fa0c26・615499ba で別の物件を言っていた。戻す: PROPERTY_THREAD_VIEWING_REPLY=off
  if (originOn && propertyThreadViewingReplyEnabled() && turnTargets.length === 0) {
    const turnMsgs = msgs.filter((m) => m.sender === "customer" && (!lastStaffAt || ms(m.created_at) > ms(lastStaffAt)) && !isImage(m));
    const reply = turnMsgs.find((m) => isViewingDateReply(String(m.text ?? "")));
    if (reply) {
      const from = ms(reply.created_at) - 7 * 86400_000;
      const offer = [...msgs].reverse().find((m) => m.sender === "staff" && m.text && !isImage(m) && ms(m.created_at) < ms(reply.created_at) && ms(m.created_at) >= from && VIEWING_OFFER_RE.test(String(m.text)));
      let named = offer ? roomsNamedIn(String(offer.text)) : [];
      if (!named.length) {
        const ev = rooms.flatMap((r) => r.events.filter((e) => (e.kind === "viewing_offered" || e.kind === "viewing_set") && ms(e.at) < ms(reply.created_at) && ms(e.at) >= from).map((e) => ({ r, e })))
          .sort((a, b) => ms(b.e.at) - ms(a.e.at));
        if (ev.length) named = rooms.filter((r) => ev.some((x) => x.r.key === r.key && ms(x.e.at) >= ms(ev[0].e.at) - 5 * 60_000));
      }
      for (const r of named.slice(0, 3)) {
        turnHints.push({ roomKey: r.key, display: r.ref.display, topic: "viewing", by: "inferred", customerText: Array.from(String(reply.text ?? "").replace(/\s+/g, " ")).slice(0, 40).join(""), at: reply.created_at,
          why: `（内覧の日にちの返事＝直前にこちらが内覧の日程を出した物件${offer ? ` ${jstShort(offer.created_at)}` : "（内覧調整の記録）"}と推定）` });
      }
    }
  }
  turnTargets.sort((a, b) => ms(a.at) - ms(b.at));
  // 2026-10-09 主語の抜けた番（「空いてますか？」「いくらですか？」・引用も名指しも無い）: 直前の送信が1件 → こちらが最後に出した1件 → お客様が最後に名前を出した物件。
  //   決まらない時は候補を送った順で渡す（推測で1件にしない）。turnTargets には入れない
  let turnReferent: TurnReferent | null = null; let turnReferentText = "";
  if (originOn && turnReferentEnabled() && turnTargets.length === 0) {
    const turn = msgs.filter((m) => m.sender === "customer" && (!lastStaffAt || ms(m.created_at) > ms(lastStaffAt)));
    if (turn.length && !turn.some(isImage) && !turn.some((m) => m.quoted_message_id)) {
      turnReferentText = turn.map((m) => String(m.text ?? "")).join("\n");
      const t0 = turn[0].created_at;
      const prevCustomer = [...msgs].reverse().find((m) => m.sender === "customer" && ms(m.created_at) < ms(t0));
      const OURS: ReadonlySet<PtEventKind> = new Set<PtEventKind>(["sent", "recommended", "estimate", "check_available", "check_alternative", "check_vacating", "check_ended", "staff_negotiating", "staff_checking", "staff_result", "viewing_offered", "viewing_set"]);
      const mentions: ReferentMention[] = [...staffTextMentions];
      for (const r of rooms) for (const e of r.events) {
        if (e.by === "inferred") continue;
        if (OURS.has(e.kind)) mentions.push({ at: e.at, roomKey: r.key, display: r.ref.display, by: "ours" });
        else if (e.kind === "customer_ask" || e.kind === "customer_shared") mentions.push({ at: e.at, roomKey: r.key, display: r.ref.display, by: "customer" });
      }
      turnReferent = resolveTurnReferent({ turnText: turnReferentText, turnStartAt: t0, prevCustomerAt: prevCustomer?.created_at ?? null, mentions, jst: jstShort });
    }
  }
  return { rooms, turnTargets, turnReferent, turnReferentText, turnHints };
}

// ─── 2026-10-13 当たり率の直し（区切り4）: 並びの何番目・内覧の日にちの返事 ───
export function propertyThreadOrdinalEnabled(env: Record<string, string | undefined> = process.env): boolean {
  return (env.PROPERTY_THREAD_ORDINAL ?? "").toLowerCase() !== "off";
}
export function propertyThreadViewingReplyEnabled(env: Record<string, string | undefined> = process.env): boolean {
  return (env.PROPERTY_THREAD_VIEWING_REPLY ?? "").toLowerCase() !== "off";
}
const N_JA: Record<string, number> = { "1": 0, "一": 0, "１": 0, "2": 1, "二": 1, "２": 1, "3": 2, "三": 2, "３": 2, "4": 3, "四": 3, "４": 3, "5": 4, "五": 4, "５": 4 };
const ORDINAL_RES: Array<[RegExp, (m: RegExpMatchArray) => number]> = [
  [/(?:一番|1番|１番|いちばん)(?:上|最初|はじめ|初め)/, () => 0],
  [/(?:一番|1番|１番|いちばん)(?:下|最後)|最後(?:の|に送(?:って|られ)|のやつ)/, () => -1],
  [/上から([1-5１-５一二三四五])(?:つ目|番目|件目|個目|枚目)?/, (m) => N_JA[m[1]]],
  [/([1-5１-５一二三四五])(?:つ目|番目|件目|個目|枚目)(?:の|に|は|が|って)/, (m) => N_JA[m[1]]],
  [/最初の(?:やつ|物件|お部屋|部屋|とこ|ところ|方)/, () => 0],
];
/** お客様の文の「1番上のやつ」「2番目の」「最後の」→ 並びの番号（0始まり・最後は -1）。無ければ null */
/** 序数の後ろに続くと物件の並びの話ではない語（「1番上の階」「2番目に安い」「最後の確認」「3つ目の質問」） */
const ORDINAL_NOT_AFTER_RE = /^(?:の|に|は|が|って)?\s*(?:階|安い|安く|高い|高く|広い|狭い|近い|遠い|質問|確認|お願い|ご質問|件|点|理由)/;
export function ordinalIndexOf(text: string): number | null {
  const t = text.normalize("NFKC");
  for (const [re, f] of ORDINAL_RES) {
    const m = t.match(re);
    if (!m || m.index == null) continue;
    if (ORDINAL_NOT_AFTER_RE.test(t.slice(m.index + m[0].length))) continue;
    return f(m);
  }
  return null;
}
function ordinalWordOf(text: string): string {
  const t = text.normalize("NFKC");
  for (const [re] of ORDINAL_RES) { const m = t.match(re); if (m) return m[0]; }
  return "";
}
/** その時刻より前の、こちらが一番新しく送った物件の束（資料・オススメ・見積・確認の結果を10分以内にまとめて）。送った順・同じ物件は1つ */
function lastOursBatch(rooms: ReadonlyArray<PtRoom>, beforeAt: string): PtRoom[] {
  const KINDS: ReadonlySet<PtEventKind> = new Set<PtEventKind>(["sent", "recommended", "estimate", "check_available", "check_alternative", "check_vacating"]);
  const evs = rooms.flatMap((r) => r.events.filter((e) => KINDS.has(e.kind) && e.by !== "inferred" && ms(e.at) < ms(beforeAt)).map((e) => ({ r, t: ms(e.at) })));
  if (!evs.length) return [];
  const last = Math.max(...evs.map((x) => x.t));
  const batch = evs.filter((x) => x.t >= last - 10 * 60_000).sort((a, b) => a.t - b.t);
  const out: PtRoom[] = [];
  for (const x of batch) if (!out.includes(x.r)) out.push(x.r);
  return out;
}
/** 内覧の日程を出したこちらの文（「〇日 〇時〜ご案内可能です」「ご都合よろしいお日にち」） */
const VIEWING_OFFER_RE = /ご案内(?:可能|させて)|内覧|内見|お日にち|ご都合/;
/** 内覧の日にち・時間だけの返事（短い・物件の名前が無い） */
export function isViewingDateReply(text: string): boolean {
  const t = text.normalize("NFKC").trim();
  if (!t || Array.from(t).length > 40) return false;
  const when = /\d{1,2}\s*(?:日|時|:\d{2})|\d{1,2}\s*\/\s*\d{1,2}|午前|午後|明日|明後日|今日|本日|[月火水木金土日]曜/.test(t);
  const ask = /でお願い|で大丈夫|からで|可能ですか|いけます|行けます|でいいですか|で良いですか|希望です|がいいです|が良いです/.test(t);
  // 入金・契約・重説・鍵の日にちの返事は内覧の返事ではない（2026-10-13 レビュー「本日の振込で大丈夫ですか」「契約は15日でお願いします」）
  if (/入金|振込|振り込|支払|払い|契約|審査|鍵|引渡|引き渡|重説|重要事項|書類|までに/.test(t)) return false;
  return when && ask;
}

const GENERIC_REF_RE =/(?:オススメ|おすすめ|お勧め|お薦め|送って(?:頂|いただ|くださ|くれ|もら)|頂いた|いただいた|前の|先日の|この前の|さっきの)[^。\n？?]{0,12}(?:物件|お部屋|部屋)/;
const CUSTOMER_SENT_REF_RE = /(?:私が|自分が|こちらから|最初に|前に|さっき)?送った(?:物件|お部屋|部屋)|送らせて(?:頂|いただ)いた(?:物件|お部屋|部屋)|共有した(?:物件|お部屋|部屋)/;
const TOPIC_JA: Record<PtTopic, string> = { cost: "初期費用", discount: "礼金・費用の値下げ", detail: "詳細", vacancy: "募集状況", viewing: "内覧", photo: "写真", like: "気に入った様子", ng: "合わない様子", other: "このお部屋の話" };
const KIND_JA: Record<PtEventKind, string> = {
  sent: "こちらが資料を送った", customer_shared: "お客様が送ってきた", customer_ask: "お客様", check_available: "確認の結果 募集中",
  check_alternative: "確認の結果 別の部屋が募集中（聞かれた部屋の代わりにこちらが案内）",
  check_vacating: "確認の結果 退去予定", check_ended: "確認の結果 募集終了", estimate: "見積書を送った",
  staff_negotiating: "こちらが交渉中と伝えた", staff_checking: "こちらが確認中と伝えた", staff_result: "結果を伝えた",
  recommended: "こちらがオススメした（🌟）", viewing_offered: "内覧の候補日を出した", viewing_set: "内覧（待ち合わせ）が決まった",
};
function eventLine(e: PtEvent): string {
  const head = e.kind === "customer_ask" ? `お客様「${e.text ?? ""}」（${TOPIC_JA[e.topic ?? "other"]}）`
    : e.kind === "customer_shared" ? (e.text?.startsWith("名前だけ") ? `お客様がこの物件の名前を送ってきた（${e.text}）` : "お客様がこの物件の画面・資料を送ってきた")
    : (e.kind === "estimate" || e.kind === "recommended") && e.text ? `${KIND_JA[e.kind]}（${e.text}）` : KIND_JA[e.kind];
  return `${jstShort(e.at)} ${head}${e.by === "inferred" ? "（推定）" : ""}`;
}

/** 物件の出所・食いつき・フリーレントの1行（無ければ null） */
export function roomSourceLine(r: PtRoom): string | null {
  const parts: string[] = [];
  if (r.origin === "customer") parts.push("お客様が送ってきた物件（持ち込み）");
  else if (r.origin === "ours") parts.push(r.events.some((e) => e.kind === "recommended") ? "こちらがオススメした物件" : "こちらが送った物件");
  if (r.hooked) parts.push(`お客様が食いついた ${jstShort(r.hooked.at)}（${TOPIC_JA[r.hooked.topic]}）`);
  if (r.freeRent) parts.push(r.freeRent.kind === "none" ? `フリーレント: なし（スタッフの送付「${r.freeRent.phrase}」）` : `フリーレント: スタッフの送付「${r.freeRent.phrase}」`);
  return parts.length ? parts.join("・") : null;
}

/**
 * ブレイン・返信の材料（今の番が物件の話の時だけ）。今の番の物件を先に、その物件の出来事を時刻順に。
 * 同じ会話で状況が動いた他の物件（見積・確認・交渉・お客様の反応があった物）を短く添える（最大 maxOthers 件）。
 */
export function buildPropertyThreadNote(s: PropertyThreadState, opts: { maxOthers?: number; maxEvents?: number } = {}): string {
  // 2026-10-13 区切り4（レビュー）: 引用・名指しが無い番は、推定の ▶（turnHints＝並びの何番目・内覧の日にちの返事）を材料の文にだけ出す
  const targets = s.turnTargets.length ? s.turnTargets : (s.turnHints ?? []);
  if (!targets.length) return s.turnReferent ? buildReferentNote(s, opts) : "";
  const maxEvents = opts.maxEvents ?? 6;
  const targetKeys = [...new Set(targets.map((t) => t.roomKey))];
  const lines: string[] = ["【🏠 物件ごとの状況（この会話の台帳・今の番の物件を先に）】"];
  for (const k of targetKeys) {
    const r = s.rooms.find((x) => x.key === k);
    if (!r) continue;
    const ts = targets.filter((t) => t.roomKey === k);
    const how = ts.map((t) => `${TOPIC_JA[t.topic]}${t.by === "quote" ? "・引用" : t.by === "inferred" ? (t.why ? "・名前の無い呼び方→推定" : "・引用先は名前の無い画像→推定") : "・名指し"}`).join("／");
    lines.push(`▶ 今の番の物件: ${r.ref.display}（${how}）${r.names.length > 1 ? ` 別の書き方: ${r.names.filter((n) => n !== r.ref.display).join("・")}` : ""}`);
    // 2026-10-08 物件の出所・食いつき・フリーレント（スタッフが送った文に書いた物だけ）
    const src = roomSourceLine(r);
    if (src) lines.push(`  ・${src}`);
    for (const e of r.events.slice(-maxEvents)) lines.push(`  ・${eventLine(e)}`);
    // 今の番の「こちら」がどの物件かを1行で（引用先が名前の無い見積書の画像でも、根拠と一緒に名前を渡す）
    for (const t of ts) {
      const why = t.why ? t.why : t.by === "inferred" ? "（引用先はこちらが送った見積書の画像・その前にお客様が初期費用を聞いた物件の見積書と推定）" : t.by === "quote" ? "（引用先の画像の物件）" : "（物件名の名指し）";
      lines.push(`  → お客様「${t.customerText}」の「こちら」＝${r.ref.display}${why}`);
    }
  }
  const others = s.rooms.filter((r) => !targetKeys.includes(r.key) && r.events.some((e) => e.kind !== "sent"))
    .sort((a, b) => ms(b.events.at(-1)!.at) - ms(a.events.at(-1)!.at)).slice(0, opts.maxOthers ?? 3);
  if (others.length) {
    lines.push("（同じ会話の他の物件・今の番の話ではない）");
    for (const r of others) { const e = r.events.filter((x) => x.kind !== "sent").at(-1)!; const src = roomSourceLine(r); lines.push(`・${r.ref.display}: ${eventLine(e)}${src ? `（${src}）` : ""}`); }
  }
  lines.push("⚠ お客様が今話している物件は ▶ の物件（「こちら」は → の行の物件）。その物件の約束・答えは ▶ の物件名で書き、同じ会話の他の物件（直前の AIX の本文に名前が出ていた物件を含む）と取り違えない。");
  return lines.join("\n");
}

/** 主語の抜けた番の台帳の文（引用・名指しが無く、turn-referent が物件の候補を出した時だけ） */
function buildReferentNote(s: PropertyThreadState, opts: { maxOthers?: number; maxEvents?: number }): string {
  const ref = s.turnReferent;
  if (!ref) return "";
  const maxEvents = opts.maxEvents ?? 6;
  const lines: string[] = ["【🏠 物件ごとの状況（この会話の台帳・今の番の物件を先に）】", ...turnReferentLines(ref, s.turnReferentText ?? "", jstShort)];
  const keys = ref.kind === "one" ? [ref.roomKey] : ref.candidates.map((c) => c.roomKey);
  for (const k of keys.slice(0, 3)) {
    const r = s.rooms.find((x) => x.key === k);
    if (!r) continue;
    if (ref.kind === "many") lines.push(`・${r.ref.display}`);
    const src = roomSourceLine(r);
    if (src) lines.push(`  ・${src}`);
    for (const e of r.events.slice(ref.kind === "one" ? -maxEvents : -2)) lines.push(`  ・${eventLine(e)}`);
  }
  lines.push(ref.kind === "one"
    ? "⚠ 主語の無い発言の物件は ▶ の物件（会話の流れから決めた・推定を含む）。同じ会話の他の物件と取り違えない。"
    : "⚠ 主語の無い発言の物件は決まっていない。▶ の候補のどれかに勝手に決めて答えない。");
  return lines.join("\n");
}
