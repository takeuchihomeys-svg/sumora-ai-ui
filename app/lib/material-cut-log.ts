// app/lib/material-cut-log.ts — 材料を字数で切った時に、何をどれだけ切ったかを1行のログに残す（純関数＋console・DB/LLM なし）
//
// 2026-11-12 作業員1（竹内さん 11/12「材料の部分もちゃんと細分化するのと受け取る側もちゃんと受け取るようになっているか」・統括役の頼み）:
//   受け取る側の点検で、ai_summary（1500字）・最終チェックのルール（3000／2000字）・チェックポイントの事実（2000字）は黙って切られ、
//   切られた時のログがどこにも無かった（材料が「無い」のか「あるのに切られた」のかを後から分けられない＝静かに壊れる所）。
//   ここは切る所を1つにして、切った時だけ { tag: "material:cut", label, kept, cut } を出す。切り方（先頭から max 字）は今と同じ＝答えは変えない。
//   11/12 統括役: 既定 on（ログだけで切り方は変えない・戻す MATERIAL_CUT_LOG=off）。off でも切り方は同じで、ログを出さないだけ。

type Env = Record<string, string | undefined>;
export function materialCutLogOn(env?: Env): boolean {
  const e = env ?? (typeof process !== "undefined" ? process.env : {});
  return (e.MATERIAL_CUT_LOG ?? "").trim().toLowerCase() !== "off";
}

export type CutRecord = { tag: "material:cut"; label: string; kept: number; cut: number; ctx?: string | null };

/** 先頭から max 字に切る（今の .slice(0, max) と同じ）。切った時だけ記録を返す */
export function clipMaterial(text: string | null | undefined, max: number, label: string, ctx?: string | null): { text: string; record: CutRecord | null } {
  const s = String(text ?? "");
  if (s.length <= max) return { text: s, record: null };
  return { text: s.slice(0, max), record: { tag: "material:cut", label, kept: max, cut: s.length - max, ctx: ctx ?? null } };
}

/** 切って、MATERIAL_CUT_LOG=on の時だけログに出す（呼ぶ側の .slice(0, max) の置き換え） */
export function clipMaterialLogged(text: string | null | undefined, max: number, label: string, ctx?: string | null, env?: Env): string {
  const r = clipMaterial(text, max, label, ctx);
  if (r.record && materialCutLogOn(env)) console.log(JSON.stringify(r.record));
  return r.text;
}
