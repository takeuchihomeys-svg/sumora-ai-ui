// app/lib/aix-brought-prefill.ts — AIX【物件確認した】を開いた時の物件名・件数の初期値を、ブレインの「物件ごとの状況」の台帳
//   （property-thread＝お客様が送ってきた物件・持ち込み）から作る（純関数・DB に触らない）
//
// 2026-10-28 竹内さんの決定（設計知見 25714f9b）「お客さんが何の物件を送ってきているのか要点を捉えれるようにする。そうすれば物件のことを理解した文が生成され、文の質が上がる」
//   実物: 10/20 19:24 こおし（SUUMO の物件）→ AIX【物件確認した】を開くと物件名が空欄・送られた物件数が既定の1件のまま。
//   線（直近90日の物件確認した 329通・作業員3 10/27）: 物件名の記録が空のまま送った AIX は 募集終了 46/56・募集中 71/234。
//     下書きの物件名が「物件1件」「SUUMOのお部屋」「お送り頂きました物件」になった物は 募集終了 39/56・募集中 79/234。
//   今の画面の初期値（AixModal の propertyNamePrefill）は会話の文の網だけで決め、1件以下の時だけ・入れた名前が直されたのは 3通中2通。
// 作り: まだ確認の結果を返していない（最後の「物件確認した」より後に）お客様が送ってきた物件を、送ってきた順に並べる。
//   物件名が読めない（物件①・空）物は名前を null のまま数にだけ入れる（推測で入れない・設計知見 8094f9ed）。
// 入れる: 画面 NEXT_PUBLIC_AIX_BROUGHT_PREFILL=on（既定 off）
import type { PropertyThreadState } from "@/app/lib/property-thread";

export type BroughtRoom = { name: string | null; at: string; source: string | null };
export type BroughtPrefill = { rooms: BroughtRoom[]; count: number; lastCheckAt: string | null };

const PLACEHOLDER_RE = /^(?:物件|お部屋)\s*[①-⑳0-9０-９]*$/;
const CHECK_KINDS = new Set(["check_available", "check_vacating", "check_ended", "check_alternative"]);

export function aixBroughtPrefillEnabled(env: Record<string, string | undefined> = typeof process !== "undefined" ? process.env : {}): boolean {
  return (env.NEXT_PUBLIC_AIX_BROUGHT_PREFILL ?? env.AIX_BROUGHT_PREFILL ?? "").trim().toLowerCase() === "on";
}

/**
 * まだ確認の結果を返していない、お客様が送ってきた物件（送ってきた順）。
 *   lastCheckAt＝会話全体の最後の「物件確認した」の出来事。それより後の customer_shared だけ
 *   windowHours＝一番新しい持ち込みから遡る幅（昔の持ち込みを混ぜない・既定 72時間）
 */
export function broughtForCheck(s: PropertyThreadState | null | undefined, opts: { windowHours?: number; checkAts?: ReadonlyArray<string | null | undefined> } = {}): BroughtPrefill {
  if (!s) return { rooms: [], count: 0, lastCheckAt: null };
  // AIX【物件確認した】を送った時刻も区切りにする（物件名の記録が空の AIX は台帳の物件に結びつかない＝90日の監査で古い持ち込みが積み上がった）
  let lastCheckAt: string | null = null;
  for (const t of opts.checkAts ?? []) if (t && (!lastCheckAt || t > lastCheckAt)) lastCheckAt = t;
  for (const r of s.rooms) for (const e of r.events) if (CHECK_KINDS.has(e.kind) && (!lastCheckAt || e.at > lastCheckAt)) lastCheckAt = e.at;
  const shared: Array<{ key: string; name: string | null; at: string; source: string | null }> = [];
  for (const r of s.rooms) {
    if (r.origin !== "customer" && !r.events.some((e) => e.kind === "customer_shared")) continue;
    const ev = r.events.filter((e) => e.kind === "customer_shared" && (!lastCheckAt || e.at > lastCheckAt));
    if (!ev.length) continue;
    const first = ev.reduce((a, b) => (a.at <= b.at ? a : b));
    shared.push({ key: r.key, name: cleanBroughtName(String(r.ref?.display ?? r.names?.[0] ?? "")), at: first.at, source: first.text ?? null });
  }
  if (!shared.length) return { rooms: [], count: 0, lastCheckAt };
  const newest = shared.reduce((a, b) => (a.at >= b.at ? a : b)).at;
  const win = (opts.windowHours ?? 72) * 3600_000;
  const rooms = shared.filter((x) => Date.parse(newest) - Date.parse(x.at) <= win).sort((a, b) => a.at.localeCompare(b.at))
    .map(({ name, at, source }) => ({ name, at, source }));
  return { rooms, count: rooms.length, lastCheckAt };
}

/**
 * 台帳の物件名のうち、物件名として使える物だけ返す（使えない時は null＝空欄のまま）。
 *   90日の監査（10/28）で台帳の持ち込みの名前に混ざっていた物: 「(thanks)」「あと、こちらの物件も見積もり…」「（室内イメージ）」「▼ShaMaison Nonno」
 *   「# サニーコート西川2 102号室」「パンジー支店」「桜川1LDK+S」「ラボルトヴィタ 1K/5階(大阪府…)の賃貸」
 */
export function cleanBroughtName(raw: string | null | undefined): string | null {
  let s = String(raw ?? "").normalize("NFKC").trim().replace(/^[#▼■◆●・*\s]+/, "").trim();
  if (!s) return null;
  // ポータルの見出し「物件名 1K/5階(大阪府…)の賃貸」は頭の物件名だけ
  if (/の賃貸$/.test(s)) s = s.split(/\s+(?:[0-9]+\s*(?:K|DK|LDK|R)|ワンルーム)|\(/)[0].trim();
  // 「桜川 1K」「難波2LDK」＝地名と間取りだけ（物件名ではない）＝間取りを外す前に見る
  if (/^\S{1,6}\s*[0-9]?(?:K|DK|LDK|R)(?:\+S)?$/.test(s)) return null;
  // 戸建ての「〇〇戸建 1-」の末尾の「1-」・「野江内代 ワンルーム」の間取り・末尾の「.」を外す
  s = s.replace(/\s+[0-9]+-$/, "").replace(/\s+(?:ワンルーム|[0-9]?(?:K|DK|LDK|R))$/, "").replace(/\.+$/, "").trim();
  if (!s || PLACEHOLDER_RE.test(s)) return null;
  if (/[、。！!？?（(）)]|室内イメージ|thanks|こちら|見積|ありがとう|支店|一覧|お願い|アプリ|ご覧|^物件名|ソース|下記|調べて|でしょうか|前家賃|駅\s*歩|線\/|^JR|^(?:マンション|アパート|物件)\s/i.test(s)) return null;
  // 「桜川 1K」「難波2LDK」＝地名と間取りだけ（物件名ではない）
  if (/^\S{1,6}\s*[0-9]?(?:K|DK|LDK|R)(?:\+S)?$/.test(s)) return null;
  if (s.length > 40) return null;
  return s;
}

/** 文の生成に渡す材料の1段（お客様が送ってきた物件・何件・名前が読めない物は「名前不明」と書く） */
export function broughtMaterialLine(p: BroughtPrefill): string {
  if (!p.count) return "";
  const list = p.rooms.map((r, i) => `${i + 1}. ${r.name ?? "（物件名が読めない・資料の画像か URL だけ）"}`).join("\n");
  return `【お客様が送ってきた物件（まだ確認の結果を返していない・送ってきた順・${p.count}件）】\n${list}\n→ 文ではこの物件名で書く（「お送り頂きました物件」「SUUMOのお部屋」のようにぼかさない）。名前が読めない物はスタッフが入れた物件名を使い、無ければ物件名を作らない`;
}

/**
 * 2026-10-28 竹内さん（#4 未来穂 10/22・ギガ賃貸）「指定した物件があるのだから、AIX から見積書を作成した場合はその物件がセットされているようにする」:
 *   AIX【見積書送る】の①②③の枠に入れる物件名を、お客様が書いた順に並べる（見積書ツールへの引き継ぎ estimate-handoff の target＋candidates は送付の記録の順）。
 *   お客様の文に出てこない物は後ろ（元の順のまま）。同じ物件は1つ。最大 max 件。入れる: NEXT_PUBLIC_AIX_ESTIMATE_PREFILL=on（既定 off）
 */
export function orderByCustomerText(names: ReadonlyArray<string | null | undefined>, customerText: string, max = 3): string[] {
  const t = String(customerText ?? "").normalize("NFKC").replace(/\s+/g, "");
  const core = (s: string) => s.normalize("NFKC").replace(/\s+/g, "").replace(/[0-9]+(?:号室)?$/, "");
  const seen = new Set<string>();
  const list = names.map((n) => String(n ?? "").trim()).filter((n) => { const k = core(n); if (!k || seen.has(k)) return false; seen.add(k); return true; });
  const pos = (n: string) => { const c = core(n); for (let len = Math.min(c.length, 8); len >= 3; len--) { const i = t.indexOf(c.slice(0, len)); if (i >= 0) return i; } return Number.POSITIVE_INFINITY; };
  return list.map((n, i) => ({ n, i, p: pos(n) })).sort((a, b) => (a.p - b.p) || (a.i - b.i)).slice(0, max).map((x) => x.n);
}
export function aixEstimatePrefillEnabled(env: Record<string, string | undefined> = typeof process !== "undefined" ? process.env : {}): boolean {
  return (env.NEXT_PUBLIC_AIX_ESTIMATE_PREFILL ?? "").trim().toLowerCase() === "on";
}

/**
 * 2026-10-28 AIX【物件確認した】の文の竹内さんの型（90日 329通・竹内さん87通の実送信の多数の形）を書く役に渡す材料の1段（既定 off・AIX_CHECK_FORM_MATERIAL=on）。
 *   物件あった（竹内さん39通）: 見積書の同封の一文 31・締めはご査収 23／ご案内 12・申込で抑える締めは 1（下書き 10/15〜 6/46 → 送ったのは 2）
 *   物件なかった（25通）: 募集に出ていない1文で終える 18（次の約束は新着 4・ピックアップ 4）
 *   見積書が無い時に「御見積書作成しお送り」と約束する下書きが出た（10/14 まで 1・スタッフが消した）
 *   決めるのは書く役（材料・決定論で消さない）。申込が入りそう（お客様が申込・抑えたいと言った等）な時は申込の締めでよい
 */
export function checkResultFormMaterial(o: { pattern: string | null | undefined; hasEstimate: boolean }): string {
  const p = String(o.pattern ?? "");
  const lines: string[] = [];
  if (p === "available" || p === "alternative") {
    lines.push("締めはご査収（「お手隙の際にご査収ください！！」）か内覧のご案内（「ご都合よろしいお日にちにお部屋ご案内させて頂きます！！」）が竹内さんの多数の形。「お申込みしお部屋抑えさせて頂きます」の締めは、お客様が申込・抑えたいと言った時や申込が入りそうな時だけ（竹内さん 39通中 1）");
    if (!o.hasEstimate) lines.push("今回は御見積書を同封しない。御見積書を作成してお送りする約束も書かない（聞かれていない約束を作らない）");
  } else if (p === "unavailable") {
    lines.push("「〈物件名〉につきまして募集状況確認させて頂きましたところ、現在募集に出ていないお部屋となっております！！」の1文で終えるのが竹内さんの多数の形（25通中 18）。次の物件のピックアップ・新着の約束は、お客様が次を頼んでいる時だけ");
  }
  return lines.length ? `【竹内さんの文の型（物件確認した・実送信の多数の形）】\n${lines.map((l) => `・${l}`).join("\n")}` : "";
}
export function aixCheckFormMaterialEnabled(env: Record<string, string | undefined> = typeof process !== "undefined" ? process.env : {}): boolean {
  return (env.AIX_CHECK_FORM_MATERIAL ?? "").trim().toLowerCase() === "on";
}
