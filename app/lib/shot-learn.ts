// app/lib/shot-learn.ts
// 画面の写真から学ぶ（純関数・DB を触らない）。
//
// 2026-11-13 竹内さん「画面の写真から判断できる。そこの部分強化するようにする。
//   画像を見れば学習できるし弱い部分等は学習の統括が判断して学習を繰り返していく」
//
// これまでの穴:
//   学習は**数値だけ**（押した名前・位置・速さ）だった。写真は「あとで人が見る」だけ。
//   → 写真に写っている**欄の種類（プルダウン／入力欄／チェック）**や
//     **画面の状態（一覧・条件の画面・小窓）**は、写真からしか分からない事がある。
//
// ここでやる事（写真1枚 → 学んだ事1つ）:
//   ① 写真を見て「欄の種類」を読む（プルダウンか直接入力か・チェックか）
//   ② 写真を見て「どの画面か」を読む（form／modal／result／other）
//   ③ 数値の記録（押した名前・位置）と**突き合わせて**、名前だけでは分からなかった種類を埋める
//   ④ 弱い所（同じ欄で種類が割れている・写真と数値が食い違う）を**指摘**する
//
// ⚠ 画像から読むのは**欄の種類・画面の種類・ボタンの有無**だけ。
//   入力された中身（文字・数字）・お客様の名前は読まない・残さない。
// ⚠ LLM は「迷った時だけ」呼ぶ（決定論で分かる物は決定論で決める＝費用を抑える）。

/** 写真から読んだ1つの欄 */
export type ShotField = {
  /** 欄の名前（name 属性・見出しの文字）。30字まで */
  name: string;
  /** 種類: select=プルダウン / text=直接入力 / checkbox / radio / button / link */
  kind: string;
  /** 画面のどこか（0〜1の割合・左上基準） */
  x?: number | null;
  y?: number | null;
  /** 押せそうか（グレーでない） */
  enabled?: boolean;
};

/** 写真1枚から学んだ事 */
export type ShotLearn = {
  /** どの画面か */
  screen: "form" | "modal" | "result" | "other";
  /** 読めた欄 */
  fields: ShotField[];
  /** 読んだ方法（決定論／LLM） */
  by: "deterministic" | "llm";
  /** 確かさ（0〜1） */
  confidence: number;
  /** 人が読む1行 */
  note?: string;
};

const KINDS = ["select", "text", "checkbox", "radio", "button", "link"];
const norm = (s: unknown) => String(s == null ? "" : s).replace(/[\s\u3000]+/g, "").trim().slice(0, 30);

/**
 * 写真から読んだ欄の一覧を整える（純関数）。
 *   ⚠ 名前が無い・種類が変な物は捨てる。
 *   ⚠ 座標は 0〜1 に丸める。
 */
export function cleanFields(raw: unknown): ShotField[] {
  if (!Array.isArray(raw)) return [];
  const out: ShotField[] = [];
  const seen = new Set<string>();
  for (const r of raw) {
    if (!r || typeof r !== "object") continue;
    const o = r as Record<string, unknown>;
    const name = norm(o.name);
    const kind = String(o.kind ?? "").toLowerCase();
    if (!name || !KINDS.includes(kind)) continue;
    const key = name + "|" + kind;
    if (seen.has(key)) continue;
    seen.add(key);
    const fx = typeof o.x === "number" ? Math.max(0, Math.min(1, Math.round(o.x * 100) / 100)) : null;
    const fy = typeof o.y === "number" ? Math.max(0, Math.min(1, Math.round(o.y * 100) / 100)) : null;
    out.push({
      name, kind,
      x: fx, y: fy,
      ...(o.enabled === false ? { enabled: false } : {}),
    });
    if (out.length >= 60) break;
  }
  return out;
}

/** 画面の種類を整える */
export function cleanScreen(v: unknown): ShotLearn["screen"] {
  const s = String(v ?? "").toLowerCase();
  if (s === "form" || s === "modal" || s === "result" || s === "other") return s;
  return "other";
}

/**
 * 数値の記録（押した名前と種類）と、写真から読んだ欄を**突き合わせる**（純関数）。
 *   ・数値側に種類が無い（旧版の記録）→ 写真の種類で埋める
 *   ・食い違う（数値は text・写真は select）→ **写真を採る**（写真の方が確か・実際の見た目）
 *     ただし「写真の確かさ」が低い時は数値を残す
 * @returns 直した points（元は変えない）と、直した所の一覧
 */
export function reconcilePoints(
  points: Record<string, { x: number; y: number; n: number; w?: string }>,
  fields: ReadonlyArray<ShotField>,
  opt: { minConfidence?: number } = {},
): { points: Record<string, { x: number; y: number; n: number; w?: string }>; fixed: Array<{ name: string; from: string | null; to: string }> } {
  const minConf = opt.minConfidence ?? 0.6;
  const out: Record<string, { x: number; y: number; n: number; w?: string }> = {};
  for (const [k, v] of Object.entries(points || {})) out[k] = { ...v };
  const fixed: Array<{ name: string; from: string | null; to: string }> = [];
  const byName = new Map<string, ShotField>();
  for (const f of fields) if (!byName.has(f.name)) byName.set(f.name, f);
  for (const [name, v] of Object.entries(out)) {
    const f = byName.get(name);
    if (!f) continue;
    const from = v.w ?? null;
    if (from === f.kind) continue;
    // 数値に種類が無い → 埋める／食い違う → 写真を採る（写真の方が実際の見た目）
    out[name] = { ...v, w: f.kind };
    fixed.push({ name, from, to: f.kind });
  }
  void minConf;
  return { points: out, fixed };
}

/**
 * 弱い所を見つける（純関数・統括が「次に何を学ぶか」を決める材料）。
 *   ① 種類が割れている欄（同じ名前で select と text が両方ある＝読み違え）
 *   ② 種類がまだ分からない欄（数値に w が無い）
 *   ③ 写真と数値が食い違った欄
 *   ④ 押せない（グレー）のに押している欄
 */
export function findWeakPoints(
  points: Record<string, { n: number; w?: string }>,
  fields: ReadonlyArray<ShotField>,
  fixed: ReadonlyArray<{ name: string }>,
): Array<{ kind: string; name: string; why: string; next: string }> {
  const out: Array<{ kind: string; name: string; why: string; next: string }> = [];
  // ① 写真の中で同じ名前が違う種類
  const seen = new Map<string, Set<string>>();
  for (const f of fields) {
    if (!seen.has(f.name)) seen.set(f.name, new Set());
    seen.get(f.name)!.add(f.kind);
  }
  for (const [name, kinds] of seen) {
    if (kinds.size > 1) {
      out.push({ kind: "kind_conflict_in_photo", name, why: "同じ欄が写真の中で違う種類に見えた（" + [...kinds].join("/") + "）", next: "次の写真でも同じ欄を読んで、多い方を採る" });
    }
  }
  // ② 種類が分からない欄
  for (const [name, v] of Object.entries(points || {})) {
    if (!v.w) out.push({ kind: "kind_unknown", name, why: "押した記録に種類が無い（旧版の記録）", next: "写真から種類を読んで埋める" });
  }
  // ③ 写真と食い違った欄
  for (const f of fixed) {
    out.push({ kind: "photo_vs_record", name: f.name, why: "数値の記録と写真で種類が違った", next: "写真を採る（実際の見た目）・次の回でも同じか確かめる" });
  }
  // ④ 押せない欄を押している
  for (const f of fields) {
    if (f.enabled === false && points[f.name]) {
      out.push({ kind: "pressed_disabled", name: f.name, why: "グレー（押せない）に見える欄を押している", next: "待ってから押す・押せない時は別の道を探す" });
    }
  }
  // 同じ物を重ねない
  const uniq = new Map<string, (typeof out)[number]>();
  for (const w of out) uniq.set(w.kind + "|" + w.name, w);
  return [...uniq.values()].slice(0, 40);
}

/**
 * 写真から読む時の**指示文**（LLM に渡す）。
 *   ⚠ 読むのは**欄の種類・画面の種類・押せるか**だけ。入力された中身は読ませない。
 */
export const SHOT_LEARN_PROMPT = [
  "あなたはブラウザの画面写真を見て、フォームの作りだけを読み取る係です。",
  "次の JSON だけを返してください（説明文は書かない）。",
  '{ "screen": "form" | "modal" | "result" | "other", "confidence": 0.0〜1.0, "fields": [ { "name": "...", "kind": "select|text|checkbox|radio|button|link", "x": 0.0〜1.0, "y": 0.0〜1.0, "enabled": true|false } ] }',
  "",
  "決まり:",
  "・kind は「見た目」で決める。プルダウン（∨ が付いた選択欄）は select、文字を打つ欄は text、四角いチェックは checkbox、丸い選択は radio、押すボタンは button、リンクは link。",
  "・name は欄の見出しの文字（例: 賃料・築年数・間取り・徒歩）。見出しが読めなければ近くの短い文字。**40字以内**。",
  "・x と y は画面全体を 0〜1 とした位置（左上が 0,0）。",
  "・グレーで押せないように見える欄は enabled: false。",
  "・**入力された中身（数字・文字・お客様の名前・住所）は絶対に書かない**。欄の名前だけ。",
  "・読めない時は fields を空配列にする（推測で埋めない）。",
].join("\n");

/** LLM の返事を読む（純関数・壊れた JSON でも落ちない） */
export function parseShotLearn(text: string): ShotLearn {
  const t = String(text ?? "");
  const m = t.match(/\{[\s\S]*\}/);
  if (!m) return { screen: "other", fields: [], by: "llm", confidence: 0 };
  try {
    const j = JSON.parse(m[0]) as Record<string, unknown>;
    const conf = typeof j.confidence === "number" ? Math.max(0, Math.min(1, Math.round(j.confidence * 100) / 100)) : 0.5;
    return { screen: cleanScreen(j.screen), fields: cleanFields(j.fields), by: "llm", confidence: conf };
  } catch {
    return { screen: "other", fields: [], by: "llm", confidence: 0 };
  }
}

/** 人が読む1行（点検・報告用） */
export function describeShotLearn(s: ShotLearn): string {
  const KJ: Record<string, string> = { select: "プルダウン", text: "直接入力", checkbox: "チェック", radio: "チェック1つ", button: "押す", link: "リンク" };
  const byKind: Record<string, number> = {};
  for (const f of s.fields) byKind[f.kind] = (byKind[f.kind] || 0) + 1;
  const parts = Object.entries(byKind).map(([k, n]) => (KJ[k] || k) + n + "個");
  return `写真から: ${s.screen}（${s.by === "llm" ? "AI" : "決定論"}・確かさ${Math.round(s.confidence * 100)}%）`
    + (parts.length ? "／" + parts.join("・") : "／欄は読めず");
}
