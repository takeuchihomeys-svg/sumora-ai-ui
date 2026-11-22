// app/lib/writer-decided-lines.ts — 統括・ブレインが決めた事のうち、書き手に届いていなかった欄を1行ずつ渡す（純関数・どれも既定 off）
//
// 2026-11-21 作業員L（竹内さん「LINE の文生成のところとの連携も細かく強化する・徹底的に」・台帳 #466・統括役の OK）:
//   本番の番（11/21・同じ番10）の数え（scripts/audit-writer-linkage.ts）で、返信の書き手に届いていなかった欄と、AIX の2通目にほぼ何も届いていなかった事が分かった。
//   ① 返信の書き手へ
//     WRITER_HOOKED_PRESS … 刺さった所（our_send_uptake の hooked・送った物件のどの点）を「押さえ」の材料に（delivery-check の hooked: b）
//     WRITER_LATENT_KIND  … 潜在の下の種類（審査・先に取られる・費用・入居日…）を従の行の1語に（latent_kind: c＝設計図は中身の文だけで種類を書かない）
//     （近い番の意見 near と事実の出所 fact_source は作業員22 の COMPOSE_DECIDED が既に運ぶ＝スイッチ off なだけ・delivery-check の印を d に直した）
//   ② AIX の2通目の書き手へ（AIX_SECOND_DECIDED）… 事実の出所・こちら側の状態・刺さった所を1塊で。
//     作業員K2 の SITUATION_WRITER_NOTE_AIX（situation_now と our_items）と重なる「こちら側」は、K2 の方が on の時は外す（11/21 K2 と決めた）。
//   決まり: 値はブレイン・統括の欄の値のまま（文は作らない・物件名や金額を足さない）。道（返信か AIX か・どのボタンか）は変えない。値が無い欄は何も足さない。
type Env = Record<string, string | undefined>;
const envOf = (env?: Env): Env => env ?? (typeof process !== "undefined" ? process.env : {});
const on = (k: string, env?: Env) => (envOf(env)[k] ?? "").trim().toLowerCase() === "on";
export const writerHookedPressOn = (env?: Env) => on("WRITER_HOOKED_PRESS", env);
export const writerLatentKindOn = (env?: Env) => on("WRITER_LATENT_KIND", env);
export const aixSecondDecidedOn = (env?: Env) => on("AIX_SECOND_DECIDED", env);

type M = Record<string, unknown> | null | undefined;
const obj = (v: unknown): Record<string, unknown> | null => (v && typeof v === "object" && !Array.isArray(v) ? (v as Record<string, unknown>) : null);
const arr = (v: unknown): unknown[] => (Array.isArray(v) ? v : []);
const clip = (v: unknown, n: number) => Array.from(String(v ?? "").replace(/\s+/g, " ").trim()).slice(0, n).join("");

/** 刺さった所（送った物件のどの点・hook=hooked の最初の物） */
export function hookedPointOf(m: M): { property: string | null; point: string } | null {
  const u = arr(obj(m)?.our_send_uptake).map(obj).find((x) => x?.hook === "hooked" && clip(x?.point, 20));
  // our-send-uptake の行: part（こちらが送った部分の文）・point（家賃・広さ・間取り…の点の名前）。物件名の欄は無い＝part の頭を出す
  return u ? { property: clip(u.property ?? u.part, 20) || null, point: clip(u.point, 20) } : null;
}
/** 潜在の下の種類（delivery-check と同じ読み: latent_read.feeling.what → three_layer.worry → customer_mindset.anxiety.target を latentKindOf で） */
export function latentKindValueOf(m: M, latentKindOf: (w: string) => string | null): string | null {
  const x = obj(m);
  const w = clip(obj(obj(x?.latent_read)?.feeling)?.what, 60) || clip(obj(x?.three_layer)?.worry, 60) || clip(obj(obj(x?.customer_mindset)?.anxiety)?.target, 20);
  return w ? latentKindOf(w) : null;
}
const BASIS_JA: Record<string, string> = { conversation: "会話で分かっている事", material: "資料の値", company_fact: "会社の事実", general: "一般の事" };
/** 答えに使う事実の出所（依頼ごと・答えがある物だけ・最大3） */
export function factSourcesOf(m: M): Array<{ quote: string; basis: string }> {
  return arr(obj(obj(m)?.turn_contract)?.asks).map(obj)
    .filter((a): a is Record<string, unknown> => !!a && !!BASIS_JA[String(a.basis)] && !!clip(a.answer, 10) && !!clip(a.quote, 10))
    .slice(0, 3).map((a) => ({ quote: clip(a.quote, 24), basis: BASIS_JA[String(a.basis)] }));
}
/** こちら側の状態（our_side_note の最初の2行） */
export function ourSideLinesOf(m: M): string[] {
  const t = obj(m)?.our_side_note;
  return typeof t === "string" ? t.split("\n").map((x) => x.trim()).filter(Boolean).slice(0, 2).map((x) => clip(x, 80)) : [];
}

/** ① 返信の書き手へ: 刺さった所（押さえの材料） */
export function writerHookedLine(m: M): string {
  const h = hookedPointOf(m);
  return h ? `- 刺さった所（ブレインの読み）: 「${h.point}」${h.property ? `（送った部分: ${h.property}）` : ""}→ 押さえの行でこの点に触れる（新しい点を作らない）` : "";
}
/** ① 返信の書き手へ: 潜在の下の種類（従の行の1語） */
export function writerLatentKindLine(m: M, latentKindOf: (w: string) => string | null): string {
  const k = latentKindValueOf(m, latentKindOf);
  return k ? `- 潜在の種類（ブレインの読み）: ${k} → 従の行（不安を消す・支える一言）はこの種類に向ける（言い当てない・決めつけない）` : "";
}
/** ② AIX の2通目の書き手へ: 事実の出所・こちら側・刺さった所（SITUATION_WRITER_NOTE_AIX が on の時はこちら側を外す） */
export function aixSecondDecidedNote(m: M, o: { situationNoteOn: boolean }): string {
  const L: string[] = [];
  const fs = factSourcesOf(m);
  if (fs.length) L.push(`- 答えに使う事実の出所: ${fs.map((f) => `「${f.quote}」は${f.basis}で`).join("／")}`);
  if (!o.situationNoteOn) { const os = ourSideLinesOf(m); if (os.length) L.push(`- こちら側の状態: ${os.join(" ／ ")}`); }
  const h = hookedPointOf(m);
  if (h) L.push(`- 刺さった所: 「${h.point}」${h.property ? `（送った部分: ${h.property}）` : ""}（2通目の推す点はこの点を先に）`);
  return L.length ? `\n【ブレイン・統括が決めた事（2通目の材料・値のまま使う）】\n${L.join("\n")}` : "";
}
