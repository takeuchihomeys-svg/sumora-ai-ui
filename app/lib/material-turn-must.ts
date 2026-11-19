// app/lib/material-turn-must.ts — 材料の上限を「今の番に要る物」で決める（純関数・DB/LLM なし）
//
// 2026-11-12 作業員1（竹内さん 11/12「材料の部分もちゃんと細分化するのと受け取る側もちゃんと受け取るようになっているか」「もっと早めれないか」・統括役）:
//   受け取る側の点検で、送った物件（sent_properties 20件）・送った資料の画像（20件）・AIX の記録（空室確認・見積の元 30行）・内覧の記録（3行）は
//   新しい順の件数で切られ、今の番の話の物件（お客様が名前で呼んだ・引用した物件）でも古ければ材料から落ちていた（「前に送ってくれた〇〇」）。
//   ここは件数を広げて読み（呼ぶ側）、今の番の物件の行は件数の外で必ず残し、残りを新しい順の元の件数で埋める。今の番の物件が無ければ今と同じ。
//   既定 off（入れる MATERIAL_TURN_MUST=on）。
import { buildingKeyOf } from "./customer-state";

type Env = Record<string, string | undefined>;
export function materialTurnMustOn(env?: Env): boolean {
  const e = env ?? (typeof process !== "undefined" ? process.env : {});
  return (e.MATERIAL_TURN_MUST ?? "").trim().toLowerCase() === "on";
}
/** on の時に読む件数（広げる倍率は控えめ・DB の読みを増やしすぎない） */
export const WIDE_LIMIT = { sentProps: 60, sentImages: 60, aixLogs: 80, viewingHistory: 10 } as const;

/** 今の番の文（最後のこちらの文より後のお客様の文・引用先の文）に名前が出た物件の建物の鍵（3字以上） */
export function turnMustKeys(turnText: string | null | undefined, names: ReadonlyArray<string | null | undefined>): Set<string> {
  const t = buildingKeyOf(String(turnText ?? ""));
  const out = new Set<string>();
  if (!t) return out;
  for (const n of names) {
    const k = buildingKeyOf(String(n ?? "").replace(/\s*[0-9０-９]{1,4}\s*号室?\s*$/, ""));
    if (k.length >= 3 && t.includes(k)) out.add(k);
  }
  return out;
}

/** 新しい順の行から、今の番の物件の行（must）は全部・残りは新しい順に n 件（元の並び＝新しい順のまま返す） */
export function selectNewestWithMust<T>(rowsNewestFirst: ReadonlyArray<T>, n: number, isMust: (r: T) => boolean): { rows: T[]; mustKept: number; beyondLimit: number } {
  const out: T[] = [];
  let normal = 0, mustKept = 0, beyond = 0;
  for (const r of rowsNewestFirst) {
    const must = isMust(r);
    if (normal < n) { out.push(r); normal++; if (must) mustKept++; continue; }
    if (must) { out.push(r); mustKept++; beyond++; }
  }
  return { rows: out, mustKept, beyondLimit: beyond };
}

/** 物件名の列（行の名前・AIX の property_names の配列）が今の番の鍵に当たるか */
export function rowHitsKeys(names: ReadonlyArray<string | null | undefined> | string | null | undefined, keys: ReadonlySet<string>): boolean {
  if (!keys.size) return false;
  const list = Array.isArray(names) ? names : [names as string | null | undefined];
  return list.some((n) => { const k = buildingKeyOf(String(n ?? "").replace(/\s*[0-9０-９]{1,4}\s*号室?\s*$/, "")); return k.length >= 3 && [...keys].some((x) => x === k || x.includes(k) || k.includes(x)); });
}
