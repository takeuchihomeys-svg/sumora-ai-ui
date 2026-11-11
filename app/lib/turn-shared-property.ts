// app/lib/turn-shared-property.ts — 今の番にお客様が送ってきた物件（URL・画像だけ）の物件名・号室を、既にある読み取りの結果から決める（純関数・DB/ネットに触れない）
//
// 2026-11-11 作業員1（KB 決定 親 P0 ecd7b961「一通は何の事か（対象）から読む」・対象の一致 12/30）:
//   お客様が SUUMO 等の URL・物件の画像だけを送り、本文に物件名が無い番で、今の番の物件（brain-material-wiring.threadDocTarget）が空になっていた。
//   物件ごとの台帳（property-thread）が今の番の物件にできるのは、引用・名指し・共有文の物件名・画像の書き起こしの物件名がある時だけで、
//     ① URL だけ（共有文に名前が無い）＝ SUUMO のページの読み（portal-page-read・既にある）を見ていない
//     ② 名前の無い画像（SUUMO の画面「寝屋川市 2LDK 2階(2LDK/2階/60.61㎡)」・こちらが送った資料の切り抜き）＝ 読み取りの値（㎡・間取り・家賃）を見ていない
//   ここは既にある読み取りの結果（messages.text の画像の書き起こし・共有文・SUUMO のページの読み）から物件名・号室を取り、
//   名前が無い時は「この会話でこちらが送った部屋」（sent_image_properties.facts の ㎡・間取り・家賃）の指紋で1部屋に決まる時だけ当てる。
//   新しい LLM 呼び出しは無い。決まらない（0件・複数）時は null＝今まで通り。
//
//   指紋の線（誤って別の部屋を当てない側）: 面積（㎡）が 0.05 以内で同じ・間取りと家賃（±1,000円）が食い違わず、
//     「間取りと家賃の両方が同じ」か「面積が細かい数（30.38㎡ 等）で間取りか家賃が同じ」部屋がちょうど1部屋の時だけ。帖の数字はこちらの送った部屋の記録（facts）に無いので使わない（記録に入ったら同じ線で足せる）。
//   ⚠ SUUMO のページの値は古い・別の部屋の掲載もある（KB 65ce4bcb）＝ここで取るのは「今の番の物件はどれか」（対象）だけ。本文の数字・先入れには使わない。
//   既定 off（入れる TURN_SHARED_PROPERTY_TARGET=on）。
import { customerImagePropertyGate, factsFromPropertyText, factsFromShareText, propertyUrlsIn, type CustomerSentFacts } from "./customer-sent-property";
import { extractScreenshotProperty } from "./own-property-match";
import { customerSharedPropertyNames } from "./customer-property-names";
import { splitPropertyName, buildingKeyOf, normalizeRoomNo } from "./customer-state";
import { threadDocTarget, type ThreadLite } from "./brain-material-wiring";
import type { PortalPage } from "./portal-page-read";

type Env = Record<string, string | undefined>;
export function turnSharedPropertyTargetOn(env?: Env): boolean {
  const e = env ?? (typeof process !== "undefined" ? process.env : {});
  return (e.TURN_SHARED_PROPERTY_TARGET ?? "").trim().toLowerCase() === "on";
}

export type TsMsg = { sender: string | null | undefined; text: string | null | undefined; image_type?: string | null; created_at: string };
/** こちらが送った部屋（sent_image_properties の物件名・号室・facts の値） */
export type KnownRoom = { name: string; roomNo: string | null; areaSqm: number | null; madori: string | null; rentYen: number | null };
export type SharedTarget = {
  name: string; roomNo: string | null;
  /** image_name＝画像の書き起こしの物件名／share_text＝共有文の物件名／portal_page＝SUUMO のページの物件名／fingerprint＝㎡・間取り・家賃でこちらが送った部屋に当てた */
  by: "image_name" | "share_text" | "portal_page" | "fingerprint";
  /** 何から決めたか（ログ・材料の行。物件の値だけ・個人の値は入れない） */
  evidence: string;
};

/** 今の番（最後のスタッフの発言より後のお客様の発言・古い順） */
export function customerTurnOf(msgsOldestFirst: ReadonlyArray<TsMsg>): TsMsg[] {
  let i = msgsOldestFirst.length - 1;
  while (i >= 0 && msgsOldestFirst[i].sender !== "staff") i--;
  return msgsOldestFirst.slice(i + 1).filter((m) => m.sender === "customer");
}

/** sent_image_properties.facts から指紋の値（area_sqm・floor_plan・rent） */
export function knownRoomOf(row: { property_name: string | null; room_no: string | null; facts?: unknown }): KnownRoom | null {
  if (!row.property_name) return null;
  const f = (row.facts && typeof row.facts === "object" ? row.facts : {}) as Record<string, unknown>;
  const n = (v: unknown) => (typeof v === "number" && Number.isFinite(v) ? v : typeof v === "string" && v.trim() && Number.isFinite(Number(v)) ? Number(v) : null);
  const md = typeof f.floor_plan === "string" ? f.floor_plan.normalize("NFKC").toUpperCase().replace(/\s/g, "") : null;
  return { name: row.property_name, roomNo: row.room_no ?? null, areaSqm: n(f.area_sqm), madori: md || null, rentYen: n(f.rent) };
}

const mdNorm = (s: string | null | undefined) => (s ? s.normalize("NFKC").toUpperCase().replace(/\s/g, "").replace(/^ワンルーム$/, "1R") : null);
const roomKey = (name: string, room: string | null) => `${buildingKeyOf(name)}#${normalizeRoomNo(room) ?? ""}`;

/** 名前の無い物件の値（㎡・間取り・家賃）で、こちらが送った部屋がちょうど1部屋に決まる時だけ返す */
export function fingerprintKnownRoom(f: Pick<CustomerSentFacts, "areaSqm" | "madori" | "rentYen">, known: ReadonlyArray<KnownRoom>, opts: { sameName?: string | null } = {}): KnownRoom | null {
  if (f.areaSqm == null) return null;
  const md = mdNorm(f.madori);
  const hits = new Map<string, KnownRoom>();
  for (const k of known) {
    if (k.areaSqm == null || Math.abs(k.areaSqm - f.areaSqm) > 0.05) continue;
    if (opts.sameName && buildingKeyOf(k.name) !== buildingKeyOf(opts.sameName)) continue;
    const kmd = mdNorm(k.madori);
    const mdSame = !!md && !!kmd && md === kmd;
    const rentSame = f.rentYen != null && k.rentYen != null && Math.abs(f.rentYen - k.rentYen) <= 1000;
    const mdDiff = !!md && !!kmd && md !== kmd;
    const rentDiff = f.rentYen != null && k.rentYen != null && Math.abs(f.rentYen - k.rentYen) > 1000;
    // 同じ名前の建物の中で号室を当てる時は面積だけでよい（建物はもう決まっている）
    if (mdDiff || rentDiff) continue;
    // 別の建物の部屋を当てない線: 間取りと家賃の両方が同じ、または面積が細かい数（30.38㎡ 等・.0/.5 でない）で間取りか家賃が同じ時だけ
    //   （25㎡・1K のような丸い数の部屋はポータルに多い＝面積と間取りだけでは別の建物かもしれない）
    const preciseArea = Math.round(f.areaSqm * 100) % 50 !== 0;
    if (!opts.sameName && !(mdSame && rentSame) && !(preciseArea && (mdSame || rentSame))) continue;
    const key = roomKey(k.name, k.roomNo);
    if (!hits.has(key) || (!hits.get(key)!.roomNo && k.roomNo)) hits.set(key, k);
  }
  const list = [...hits.values()];
  if (list.length === 1) return list[0];
  // 同じ建物で号室の有る行と無い行が両方ある時は号室の有る方（同じ部屋の記録の重なり）。別の建物・別の号室が2つ以上なら決めない
  const withRoom = list.filter((k) => k.roomNo);
  const sameBuilding = list.every((k) => buildingKeyOf(k.name) === buildingKeyOf(list[0].name));
  return sameBuilding && withRoom.length === 1 ? withRoom[0] : null;
}

const PLAIN_NAME_RE = /^(?:賃貸|分譲)?\s*(?:マンション|アパート|一戸建て?|戸建て?|物件)$/;
const sumOf = (f: Pick<CustomerSentFacts, "areaSqm" | "madori" | "rentYen">) =>
  [f.madori, f.areaSqm != null ? `${f.areaSqm}㎡` : null, f.rentYen != null ? `${Math.round(f.rentYen / 100) / 100}万円` : null].filter(Boolean).join("・");

/** 名前は取れたが号室が無い時、こちらが送った同じ建物の部屋から号室を埋める（面積で1部屋に決まる時・同じ建物の部屋が1つだけの時） */
function fillRoom(name: string, f: Pick<CustomerSentFacts, "areaSqm" | "madori" | "rentYen">, known: ReadonlyArray<KnownRoom>): string | null {
  const same = known.filter((k) => buildingKeyOf(k.name) === buildingKeyOf(name) && k.roomNo);
  const rooms = [...new Set(same.map((k) => normalizeRoomNo(k.roomNo)))];
  if (rooms.length === 1) return same[0].roomNo;
  if (!rooms.length) return null;
  return fingerprintKnownRoom(f, same, { sameName: name })?.roomNo ?? null;
}

/**
 * 今の番にお客様が送ってきた物件（URL・画像）の物件名・号室。ちょうど1件に決まる時だけ。
 * @param turn 今の番のお客様の発言（customerTurnOf の結果・古い順）
 * @param pages URL ごとの SUUMO のページの読み（readPortalPage の結果・無くてよい）
 * @param known この会話でこちらが送った部屋（指紋・号室の埋め）
 */
export function sharedPropertyOfTurn(o: { turn: ReadonlyArray<TsMsg>; pages?: ReadonlyMap<string, PortalPage>; known?: ReadonlyArray<KnownRoom> }): { target: SharedTarget | null; reason: "none" | "multiple" | "unresolved" | "partial" | "ok"; found: number } {
  const known = o.known ?? [];
  const found = new Map<string, SharedTarget>();
  let shared = 0;
  // 2026-11-11 試験 w1-tsp-on3（q202「合計3物件」）: 3件の持ち込みのうち共有文の1件だけ名前が取れ、その1件を今の番の物件と言い切った
  //   → 名前が決まらない持ち込みが1つでもあれば、今の番の物件は決めない（partial）
  let unresolved = 0;
  const put = (t: SharedTarget) => {
    const ref = splitPropertyName(t.name, t.roomNo);
    if (!ref) return;
    const key = `${ref.buildingKey}#${ref.room ?? ""}`;
    // 同じ建物の号室なしと号室ありは1件（号室ありを残す）
    for (const [k, v] of found) {
      if (k.split("#")[0] !== ref.buildingKey) continue;
      if (!ref.room) return;
      if (!v.roomNo) { found.delete(k); break; }
    }
    if (!found.has(key)) found.set(key, { ...t, name: ref.building, roomNo: ref.room });
  };
  for (const m of o.turn) {
    const text = String(m.text ?? "");
    if (/^\s*\[画像\]/.test(text)) {
      const g = customerImagePropertyGate(text, m.image_type ?? null);
      // 個人情報・物件以外は見ない（fail-closed）。読めていない画像（「[画像]」だけ）は物件かもしれない＝決まらない物として数える
      if (!g.ok) { if (g.reason === "unread") { shared++; unresolved++; } continue; }
      shared++;
      const f = factsFromPropertyText(g.body);
      const sp = extractScreenshotProperty(`[画像] ${g.body}`);
      const name = f.name && !PLAIN_NAME_RE.test(f.name) ? f.name : null;
      if (name) {
        const room = sp?.room ?? fillRoom(name, f, known);
        put({ name, roomNo: room, by: "image_name", evidence: `画像の書き起こしの物件名「${name}${sp?.room ? ` ${sp.room}` : ""}」${room && !sp?.room ? `（号室はこちらが送った同じ建物の部屋から）` : ""}` });
        continue;
      }
      const k = fingerprintKnownRoom(f, known);
      if (k) put({ name: k.name, roomNo: k.roomNo, by: "fingerprint", evidence: `名前の無い物件の画像の値（${sumOf(f)}）がこちらが送った部屋と同じ` });
      else unresolved++;
      continue;
    }
    const urls = propertyUrlsIn(text);
    if (!urls.length) continue;
    shared += urls.length;
    const names = customerSharedPropertyNames([{ sender: "customer", text, createdAt: m.created_at }], { limit: 5 });
    if (names.length) {
      for (const c of names) {
        const ref = splitPropertyName(c.name);
        const room = ref?.room ?? (ref ? fillRoom(ref.building, factsFromShareText(text), known) : null);
        put({ name: ref?.building ?? c.name, roomNo: room, by: "share_text", evidence: `共有文の物件名「${c.name}」` });
      }
      continue;
    }
    const share = factsFromShareText(text);
    for (const u of urls) {
      const p = o.pages?.get(u);
      if (p?.status === "ok" && p.name) {
        const f = { areaSqm: p.areaSqm ?? share.areaSqm, madori: p.madori ?? share.madori, rentYen: p.rentYen ?? share.rentYen };
        put({ name: p.name, roomNo: fillRoom(p.name, f, known), by: "portal_page", evidence: `URL のページ（SUUMO）の物件名「${p.name}」` });
        continue;
      }
      const f = p?.status === "ok" ? { areaSqm: p.areaSqm ?? share.areaSqm, madori: p.madori ?? share.madori, rentYen: p.rentYen ?? share.rentYen } : share;
      const k = fingerprintKnownRoom(f, known);
      if (k) put({ name: k.name, roomNo: k.roomNo, by: "fingerprint", evidence: `名前の無い URL の値（${sumOf(f)}）がこちらが送った部屋と同じ` });
      else unresolved++;
    }
  }
  if (!shared) return { target: null, reason: "none", found: 0 };
  if (found.size === 0) return { target: null, reason: "unresolved", found: 0 };
  if (found.size > 1) return { target: null, reason: "multiple", found: found.size };
  if (unresolved > 0) return { target: null, reason: "partial", found: found.size };
  return { target: [...found.values()][0], reason: "ok", found: 1 };
}

/**
 * 今の番の物件（資料の写し・材料の対象）。引用・名指しの物件（台帳の turnTargets が1つ）は先に、
 * 次に今の番にお客様が送ってきた物件（URL・画像の読み取り）、最後に主語の抜けた番の1件（turnReferent）。
 * ＝お客様が今まさに送ってきた物は、直前にこちらが送った物件（主語の抜けの推定）より確か。
 */
export function turnDocTargetWithShared(pt: ThreadLite | null | undefined, shared: SharedTarget | null): { name: string; roomNo: string | null; by: string } | null {
  if (pt) {
    const keys = [...new Set(pt.turnTargets.map((t) => t.roomKey))];
    if (keys.length >= 1) return threadDocTarget(pt);
  }
  if (shared) return { name: shared.name, roomNo: shared.roomNo, by: `shared:${shared.by}` };
  return threadDocTarget(pt);
}

/** ブレインの材料の1行（無ければ空）。答え（返信か AIX か）は書かない＝ブレインが決める */
export function sharedTargetMaterialLine(t: SharedTarget | null): string {
  if (!t) return "";
  const label = `${t.name}${t.roomNo ? ` ${t.roomNo}号室` : ""}`;
  return `【🏠 今の番の物件（お客様が送ってきた URL・画像の読み取りから）】${label} — ${t.evidence}。本文に物件名が無くても、この番の話の対象はこの物件（募集状況・費用・条件の話はこの物件のこと）。${t.by === "fingerprint" ? "こちらが以前送った部屋の資料をお客様が送り直した形。" : ""}`;
}
