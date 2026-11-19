// app/lib/ref-brought.ts — 持ち込みの台帳から ref_resolve の RefBrought を作る（純関数・DB/LLM なし・作業員16・2026-11-13）
//
// 統括役の頼み 11/13「持ち込みの台帳を決めて引く」。お客様が送ってきた物件を記録している所はコードに2つあり、新しい表は作らない（二重に持たない）:
//   ① ポータルの共有文（customer-property-names.customerSharedPropertyNames）: SUUMO「物件名 3階 / URL / by SUUMO」・athome「物件名：」→ 名前・URL（messages だけ・費用0）
//   ② 物件ごとの状況の台帳（property-thread.PropertyThreadState）: origin=customer の部屋（建物・号室）と、出来事 customer_shared の text に残る元の URL
// どちらもポータルの id（ref-resolve.portalIdOf）で当てる鍵を付ける。号室が無い（SUUMO の共有文は階まで）物は room=null のまま＝ref_resolve で needs_room。
import { portalIdOf, type RefBrought } from "./ref-resolve";
import type { CustomerPropertyCandidate } from "./customer-property-names";
import type { PropertyThreadState } from "./property-thread";

const URL_RE = /https?:\/\/[^\s）)」』]+/;
/** 共有文の名前の「…号室」「…NNN号」だけ号室にする（「3階」は号室ではない） */
const roomOfLabel = (label: string): string | null => label.match(/([0-9０-９]{2,4})\s*号室?/)?.[1]?.normalize("NFKC") ?? null;

export function broughtFromShares(cands: ReadonlyArray<CustomerPropertyCandidate>): RefBrought[] {
  return cands.filter((c) => c.name).map((c) => ({
    name: c.name, room: roomOfLabel(c.label), at: c.at ?? "", url: c.url, portal_id: portalIdOf(c.url)?.id ?? null, from: c.url ? "url" as const : "text" as const,
  }));
}

export function broughtFromThreads(s: PropertyThreadState | null | undefined): RefBrought[] {
  const out: RefBrought[] = [];
  for (const r of s?.rooms ?? []) {
    if (r.origin !== "customer") continue;
    const ev = r.events.find((e) => e.kind === "customer_shared");
    const url = ev?.text?.match(URL_RE)?.[0] ?? null;
    out.push({ name: r.ref.building || r.names[0] || null, room: r.ref.room ?? null, at: ev?.at ?? r.events[0]?.at ?? "", url, portal_id: portalIdOf(url)?.id ?? null, from: url ? "url" : "text" });
  }
  return out;
}

/** 同じ持ち込み（ポータルの id・URL・名前＋号室）は1つにまとめる。号室・名前のある方を残す */
export function mergeBrought(...lists: ReadonlyArray<ReadonlyArray<RefBrought>>): RefBrought[] {
  const out: RefBrought[] = [];
  const keyOf = (b: RefBrought) => b.portal_id ?? b.url ?? (b.name ? `${b.name}|${b.room ?? ""}` : null);
  for (const b of lists.flat()) {
    const k = keyOf(b);
    const ex = k ? out.find((o) => keyOf(o) === k || (!!b.portal_id && o.portal_id === b.portal_id)) : null;
    if (!ex) { out.push({ ...b }); continue; }
    if (!ex.name && b.name) ex.name = b.name;
    if (!ex.room && b.room) ex.room = b.room;
    if (!ex.url && b.url) ex.url = b.url;
    if (!ex.image_name && b.image_name) ex.image_name = b.image_name;
  }
  return out;
}
