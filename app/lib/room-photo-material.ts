// app/lib/room-photo-material.ts
// 室内写真の依頼の番で「頼まれた物件の室内イメージ（URL・画像）が手元にある」か（純関数・customer-state の名前の寄せ方だけに依存）。
//
// 2026-10-07 5巡目（竹内さん「AIX を直接出す」）: 室内写真の依頼で、手元に室内イメージの URL・画像がある時は
//   AIX【物件確認した→室内写真を確認した】を直接出す。無い時は今まで通り「室内のお写真撮影出来次第お送りさせて頂きます」の約束（2段）→ 撮影後に AIX。
//
// 線（scripts/audit-photo-material-at-hand.ts・365日 依頼 31通を全部読んだ）:
//   ・会話のどこかに室内イメージを送った事がある（会話単位）では分けられない: 直接 11・撮影 5・他 11
//     （ゆなまる 10/7 は Avantio Anhelo の室内イメージを前日に送っていたが、頼まれたのはお客様の持ち込みのシャーメゾン ソレイユ＝撮影）
//   ・物件の記録（sent_properties.property_url）はリアプロの資料の URL（realnetpro factsheet）で室内イメージではない／
//     sent_image_properties は資料の画像（室内とは限らない）／お客様の持ち込みのサイトの画面（360°）でもスタッフは撮影した
//   → **頼まれた物件**の室内イメージ（「（室内イメージ）https://…」・AIX 室内写真）をこちらが既に送っている時だけ「手元にある」。
//     頼まれた物件は 引用・名指し（property-thread の今の番の物件）→ 無ければ依頼の直前のこちらの送付のまとまりの物件。
//   物件サイトでその場で探して送る形（直接 のうち前に記録の無い物）は data から先に分からない＝約束の道に残す（スタッフが URL を見つけたら AIX）。

import { buildingKeyOf, splitPropertyName } from "./customer-state";

const INTERIOR_LABEL_RE = /室内イメージ|室内写真|室内の(?:お)?写真|お部屋の(?:お)?写真|室内動画|ルームツアー/;
/** 送付の文から物件名を拾う（🌟名前 号室・【名前 号室】・①名前） */
const NAME_LINE_RES: RegExp[] = [
  /🌟\s*([^\n🌟]{2,40}?)(?:\s*[0-9０-９]{2,4}\s*号?室?)?(?=\n|$|\s{2}|！)/gu,
  /【\s*([^【】\n]{2,40}?)\s*】/g,
  /(?:^|\n)\s*[①-⑳]\s*([^\n]{2,40}?)(?=\n|$)/g,
  /こちら\s*([^\s、。！!]{2,24}?)(?:\s*[0-9０-９]{2,4}\s*号?室?)?の室内/g,
  /([^\s、。！!（）()]{2,24}?)(?:\s*[0-9０-９]{2,4}\s*号?室?)?の室内イメージ/g,
];
const NOT_NAME_RE = /^(?:室内イメージ|オススメポイント|物件|お部屋|外観室内イメージ|初期費用|お申込者様記入欄)/;

export function namesInStaffText(text: string): string[] {
  const out = new Set<string>();
  for (const re of NAME_LINE_RES) {
    for (const m of String(text ?? "").matchAll(re)) {
      const raw = (m[1] ?? "").trim();
      if (!raw || NOT_NAME_RE.test(raw)) continue;
      const ref = splitPropertyName(raw);
      const k = buildingKeyOf(ref?.building ?? raw);
      if (k && k.length >= 2) out.add(k);
    }
  }
  return [...out];
}

export type PhotoMaterialInput = {
  /** 依頼より前の会話（古い順） */
  before: ReadonlyArray<{ sender: string; text: string; createdAt: string; isImage?: boolean }>;
  /** 依頼の文（名指しを拾う） */
  requestText: string;
  /** 今の番の物件（property-thread の turnTargets の display・引用・名指し）。無ければ直前の送付のまとまりから */
  targetNames?: ReadonlyArray<string>;
  /** 室内写真の AIX を送った物件名（aix_usage_logs check_pattern=interior_photo の property_names） */
  interiorAixNames?: ReadonlyArray<string>;
  /** 台帳から決めた頼まれた物件（photoTargetsFromThread）。あれば targetNames より先に使う */
  targetRooms?: ReadonlyArray<PhotoTargetRoom>;
};
export type PhotoMaterialVerdict = { atHand: boolean; targets: string[]; interiorKnown: string[]; why: string };

const MIN = 60_000;
const sameKey = (a: string, b: string) => !!a && !!b && (a === b || (a.length >= 3 && b.includes(a)) || (b.length >= 3 && a.includes(b)));

/** 室内イメージを送った物件（ラベルの通の前後 5分のこちらの送付で名前が出た物件） */
export function interiorSentNames(before: PhotoMaterialInput["before"]): string[] {
  const out = new Set<string>();
  const staff = before.map((m, i) => ({ ...m, i })).filter((m) => m.sender !== "customer");
  for (const m of staff) {
    const t = m.text ?? "";
    if (!INTERIOR_LABEL_RE.test(t) || !(/https?:\/\//.test(t) || m.isImage)) continue;
    for (const k of namesInStaffText(t)) out.add(k);
    const t0 = Date.parse(m.createdAt);
    for (const o of staff) {
      if (o.i === m.i || Math.abs(Date.parse(o.createdAt) - t0) > 5 * MIN) continue;
      // 前後の送付の文（🌟の紹介・見積の見出し）。同じまとまりに物件が複数ある時はラベルの直後の紹介の文を優先
      if (o.i > m.i && o.i <= m.i + 2) for (const k of namesInStaffText(o.text ?? "")) out.add(k);
    }
  }
  return [...out];
}

/** 依頼の直前のこちらの送付のまとまり（最後のこちらの通から 10分さかのぼる）の物件 */
function lastClusterNames(before: PhotoMaterialInput["before"]): string[] {
  const staff = before.filter((m) => m.sender !== "customer");
  const last = staff[staff.length - 1];
  if (!last) return [];
  const t1 = Date.parse(last.createdAt);
  const out = new Set<string>();
  for (const m of staff) if (t1 - Date.parse(m.createdAt) <= 10 * MIN) for (const k of namesInStaffText(m.text ?? "")) out.add(k);
  return [...out];
}

/** 物件ごとの状況の台帳（property-thread）から、依頼の番の頼まれた物件（今の番の物件・無ければ依頼の直前に動きのあった物件）と「こちらが送った物件か」 */
export type PhotoTargetRoom = { name: string; sentByUs: boolean; broughtByCustomer?: boolean };
export function photoTargetsFromThread(
  state: { rooms: ReadonlyArray<{ key: string; names: string[]; sentByUs: boolean; events: ReadonlyArray<{ at: string; kind?: string }> }>; turnTargets: ReadonlyArray<{ roomKey: string; display: string; at: string }> } | null | undefined,
  requestAt: string,
): PhotoTargetRoom[] {
  if (!state) return [];
  const t0 = Date.parse(requestAt);
  const tt = state.turnTargets.filter((x) => !Number.isFinite(t0) || Date.parse(x.at) >= t0 - MIN);
  // お客様が先に送ってきた物件（台帳の最初の出来事が customer_shared）は、後でこちらが見積の画像を送っていても持ち込み（ゆなまる 10/7 シャーメゾン ソレイユ＝撮影）
  const brought = (r: { events: ReadonlyArray<{ at: string; kind?: string }> } | undefined) => {
    const first = [...(r?.events ?? [])].sort((a, b) => Date.parse(a.at) - Date.parse(b.at))[0];
    return first?.kind === "customer_shared";
  };
  const roomOfKey = (k: string) => state.rooms.find((r) => r.key === k);
  if (tt.length) return tt.map((x) => ({ name: x.display, sentByUs: roomOfKey(x.roomKey)?.sentByUs ?? false, broughtByCustomer: brought(roomOfKey(x.roomKey)) }));
  // 依頼より前の最後の出来事の時刻から 10分以内に動きのあった物件（束で送った・見積を送った等）
  const lastOf = (r: { events: ReadonlyArray<{ at: string }> }) => Math.max(-Infinity, ...r.events.map((e) => Date.parse(e.at)).filter((x) => !Number.isFinite(t0) || x <= t0));
  const latest = Math.max(-Infinity, ...state.rooms.map(lastOf));
  if (!Number.isFinite(latest)) return [];
  return state.rooms.filter((r) => latest - lastOf(r) <= 10 * MIN).map((r) => ({ name: r.names[0] ?? r.key, sentByUs: r.sentByUs, broughtByCustomer: brought(r) }));
}

/** 建築中・完成前（資料・会話にある時は撮影も URL も無い＝約束の道） */
const UNDER_CONSTRUCTION_RE = /建築中|建設中|工事中|完成予定|竣工予定|未完成|内覧会/;

export function photoMaterialAtHand(i: PhotoMaterialInput): PhotoMaterialVerdict {
  const known = [...new Set([...interiorSentNames(i.before), ...(i.interiorAixNames ?? []).map((n) => buildingKeyOf(splitPropertyName(n)?.building ?? n))])].filter(Boolean);
  // 台帳の物件（こちらが送った物件＝資料がある）があれば先に使う
  if (i.targetRooms?.length) {
    const rooms = i.targetRooms.map((r) => ({ ...r, key: buildingKeyOf(splitPropertyName(r.name)?.building ?? r.name) })).filter((r) => r.key);
    const staffText = i.before.filter((m) => m.sender !== "customer").map((m) => m.text ?? "");
    const per = rooms.map((r) => {
      const resend = known.some((k) => sameKey(k, r.key));
      // 建築中の語と物件名が同じ行にある時だけ（物件を並べた送付の文の別の行の「内覧会」で当てない）
      const building = staffText.some((t) => t.split(/\n|。/).some((l) => UNDER_CONSTRUCTION_RE.test(l) && buildingKeyOf(l).includes(r.key)));
      const ours = r.sentByUs && !r.broughtByCustomer;
      return { ...r, ok: !building && (resend || ours), resend, building, ours };
    });
    const atHand = per.length > 0 && per.every((r) => r.ok);
    return {
      atHand, targets: per.map((r) => r.name), interiorKnown: known,
      why: per.map((r) => `${r.name}: ${r.building ? "建築中" : r.resend ? "室内イメージ送付済み" : r.ours ? "こちらが送った物件（資料あり）" : "お客様の持ち込み"}`).join("・"),
    };
  }
  let targets = (i.targetNames ?? []).map((n) => buildingKeyOf(splitPropertyName(n)?.building ?? n)).filter(Boolean);
  let how = "今の番の物件";
  if (!targets.length) {
    // 依頼の文の名指し（知っている物件名が文にある）
    const req = buildingKeyOf(i.requestText);
    const named = known.filter((k) => k.length >= 3 && req.includes(k));
    if (named.length) { targets = named; how = "依頼の文の名指し"; }
  }
  if (!targets.length) { targets = lastClusterNames(i.before); how = "直前の送付のまとまり"; }
  if (!targets.length) return { atHand: false, targets, interiorKnown: known, why: "頼まれた物件が分からない" };
  // 複数の物件（「3つの物件を室内写真を見たい」）は全部の室内イメージが手元にある時だけ
  const atHand = targets.every((t) => known.some((k) => sameKey(k, t)));
  return { atHand, targets, interiorKnown: known, why: `${how}: ${targets.join("・")} → 室内イメージ${atHand ? "あり" : "なし"}` };
}
