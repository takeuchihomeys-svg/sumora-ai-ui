// app/lib/conductor-material-index.ts — 統括の指示書の「材料の目録」（CONDUCTOR_MATERIAL_INDEX・既定 off）
// 2026-11-24 作業員A（台帳 #675 の続き・統括役の決め）: ブレインの入力だけに入り、統括が直に読む所の無かった材料（32行）を、
//   32本の読み口でなく1本の口で統括に渡す。その番のブレインの入力に有った材料の名前・字数・中身の要点（各1行・24字まで）だけ。
//   置き場は統括の指示書の extra（#674 と同じ・meta.conductor_brief.extra.materials）。書き手には渡さない（BRIEF_SECTION_SUBS に入れない）。
//   今は LLM の入力に入らない（指示書はコードが読むだけ・log-aix-usage の前の判断の写しからも指示書は外してある）＝入力の増え 0 字。
//   文にして LLM に渡す時は materialIndexText（上限 MATERIAL_INDEX_TEXT_MAX 字）を、キャッシュの後ろ（毎番変わる所＝会話の後ろ）に置く。
export type MaterialIndexItem = { k: string; n: number; g: string };
type Env = Record<string, string | undefined>;

export function conductorMaterialIndexOn(env: Env = typeof process !== "undefined" ? process.env : {}): boolean {
  return (env.CONDUCTOR_MATERIAL_INDEX ?? "").trim().toLowerCase() === "on";
}

export const MATERIAL_INDEX_MAX = 30;
export const MATERIAL_GIST_MAX = 24;
export const MATERIAL_INDEX_TEXT_MAX = 600;

/** 中身の要点: 最初の中身のある行（見出し【…】はその名前・続きがあれば「：」で24字まで） */
export function gistOf(text: string): string {
  const line = text.split(/\r?\n/).map((l) => l.trim()).find((l) => l && !/^[-─━=＝・]+$/.test(l)) ?? "";
  const h = line.match(/【([^】]{1,30})】/);
  const rest = (h ? line.replace(h[0], "") : line).replace(/^[\s:：・、。（）()\-]+/, "").trim();
  const g = h ? (rest ? `${h[1]}：${rest}` : h[1]) : rest;
  return Array.from(g).slice(0, MATERIAL_GIST_MAX).join("");
}

/** 見出し（行頭の【…】）ごとに分ける。見出しが2つ未満なら分けない */
function splitByHeading(text: string): string[] {
  const parts = text.split(/\n(?=\s*【)/).map((s) => s.trim()).filter(Boolean);
  return parts.length >= 2 ? parts : [text.trim()];
}

/**
 * 目録を作る（決まった計算・LLM なし）。blocks はブレインの入力の材料の名前 → 中身（brain:blocks の見張りと同じ名前）。
 *   split に挙げた名前（お客様の状態の塊など複数の材料をまとめた物）は見出しごとに分ける（名前は「名前/見出し」）。
 *   marks は meta.material_marks（字数の印だけの1行の材料）。空の材料は載せない。並びは渡した順・上限 MATERIAL_INDEX_MAX
 */
export function buildMaterialIndex(blocks: Readonly<Record<string, string | null | undefined>>, o: { split?: readonly string[]; marks?: Readonly<Record<string, number>> | null } = {}): MaterialIndexItem[] {
  const out: MaterialIndexItem[] = [];
  const split = new Set(o.split ?? []);
  for (const [k, raw] of Object.entries(blocks)) {
    const t = (raw ?? "").trim();
    if (!t) continue;
    if (split.has(k)) {
      for (const p of splitByHeading(t)) { const h = p.match(/^【([^】]{1,30})】/); out.push({ k: h ? `${k}/${h[1]}` : k, n: p.length, g: gistOf(p) }); }
    } else out.push({ k, n: t.length, g: gistOf(t) });
  }
  for (const [k, n] of Object.entries(o.marks ?? {})) if (n > 0) out.push({ k: `mark.${k}`, n, g: "" });
  return out.slice(0, MATERIAL_INDEX_MAX);
}

/** 文にする時の形（今は使っていない・LLM に渡す時はキャッシュの後ろに置く） */
export function materialIndexText(items: readonly MaterialIndexItem[] | null | undefined, max = MATERIAL_INDEX_TEXT_MAX): string {
  if (!items?.length) return "";
  const lines = ["【材料の目録（この番のブレインの入力に有った材料）】"];
  let len = lines[0].length;
  for (const i of items) {
    const l = `・${i.k}（${i.n}字）${i.g ? `：${i.g}` : ""}`;
    if (len + 1 + l.length > max) { lines.push("・…"); break; }
    lines.push(l); len += 1 + l.length;
  }
  return lines.join("\n");
}

/** 目録の1件の JSON の字数の上限の見込み（k 40字・n 6桁・g 24字＋括り） */
export const MATERIAL_INDEX_JSON_MAX = MATERIAL_INDEX_MAX * (40 + 6 + MATERIAL_GIST_MAX + 20);
