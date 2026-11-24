// app/lib/conductor-material-index.ts — 統括の指示書の「材料の目録」（CONDUCTOR_MATERIAL_INDEX・既定 on＝記録だけ・=off で止まる）
// 2026-11-24 作業員A（台帳 #675 の続き・統括役の決め）: ブレインの入力だけに入り、統括が直に読む所の無かった材料（32行）を、
//   32本の読み口でなく1本の口で統括に渡す。その番のブレインの入力に有った材料の名前・字数・中身の要点（各1行・24字まで）だけ。
//   置き場は統括の指示書の extra（#674 と同じ・meta.conductor_brief.extra.materials）。書き手には渡さない（BRIEF_SECTION_SUBS に入れない）。
//   今は LLM の入力に入らない（指示書はコードが読むだけ・log-aix-usage の前の判断の写しからも指示書は外してある）＝入力の増え 0 字。
//   文にして LLM に渡す時は materialIndexText（上限 MATERIAL_INDEX_TEXT_MAX 字）を、キャッシュの後ろ（毎番変わる所＝会話の後ろ）に置く。
export type MaterialIndexItem = { k: string; n: number; g: string };
type Env = Record<string, string | undefined>;

export function conductorMaterialIndexOn(env: Env = typeof process !== "undefined" ? process.env : {}): boolean {
  return (env.CONDUCTOR_MATERIAL_INDEX ?? "on").trim().toLowerCase() !== "off"; // 11/24 統括役の決め: 記録だけ＝既定 on（11/22 の決まり）・=off で止まる
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

// ── MATERIAL_INDEX_GAP（2026-11-24 夕 作業員A・統括役の了承の設計）: 有るはずの材料が目録に無い番を見つける（既定 shadow＝記録だけ・=off で止まる）──
//   shadow: 指示書の extra.material_gaps に残すだけ（疑いの印・確かさ・人に回す線には効かせない）。
//   on: 今は shadow と同じ（疑いの印 material_gap に入れるかは shadow の数を見て統括役が決める＝その時に conductor-doubt へ足す）。
//   証拠はブレインの入力とは別の所（meta.situation_now＝sent_facts・AIX の記録・時系列の帳面）から取る。同じ読みから来る物は表に入れない（同じ失敗で両方消えるので）
export type MaterialGapMode = "off" | "shadow" | "on";
export function materialIndexGapMode(env: Env = typeof process !== "undefined" ? process.env : {}): MaterialGapMode {
  const v = (env.MATERIAL_INDEX_GAP ?? "shadow").trim().toLowerCase();
  return v === "off" ? "off" : v === "on" ? "on" : "shadow";
}
type Rec = Record<string, unknown>;
const objOf = (v: unknown): Rec | null => (v && typeof v === "object" && !Array.isArray(v) ? (v as Rec) : null);
const arrOf = (v: unknown): unknown[] => (Array.isArray(v) ? v : []);
export type ExpectedRow = {
  id: string;
  /** 目録の名前（どれか1つが min 字以上あれば足りている）。「名前/」で終わる物は見出しで分けた塊の頭の一致 */
  want: readonly string[];
  min: number;
  /** 有るはずの証拠（無ければ null）。meta の欄の名前はコードで確かめた物（situation-now.ts の SituationNow） */
  evidence: (m: Rec) => string | null;
  why: string;
};
export const EXPECTED: readonly ExpectedRow[] = [
  {
    id: "sent_props", want: ["sentProps"], min: 20,
    // SituationNow.sent（SnSent.kind・sent_facts と AIX の記録から）↔ 材料は sent_properties の表（brain-core の buildSentPropsText）
    evidence: (m) => { const n = arrOf(objOf(m.situation_now)?.sent).filter((s) => objOf(s)?.kind === "properties_sent").length; return n ? `送った物件の記録 ${n}件（situation_now.sent）` : null; },
    why: "物件を送った記録があるのに、送った物件の材料が入力に無い",
  },
  {
    id: "promises_open", want: ["promise"], min: 10,
    // SituationNow.promises_open（SnPromise・行動台帳から）↔ 材料は promise-tracker.buildPromiseBrainNote（メッセージの約束の追跡）
    evidence: (m) => { const n = arrOf(objOf(m.situation_now)?.promises_open).length; return n ? `開いている約束 ${n}件（situation_now.promises_open）` : null; },
    why: "開いている約束があるのに、お客様との約束の材料が入力に無い",
  },
  {
    id: "viewings", want: ["viewings", "customerState/", "customerState"], min: 10,
    // SituationNow.timeline.viewings（at・done・カレンダーと時系列の帳面）↔ 材料は内覧の表（viewingsText）か、お客様の状態の塊（内覧の行を含む・その時は viewingsText は空）
    evidence: (m) => { const n = arrOf(objOf(objOf(m.situation_now)?.timeline)?.viewings).filter((v) => objOf(v)?.done === false).length; return n ? `これからの内覧 ${n}件（situation_now.timeline.viewings）` : null; },
    why: "これからの内覧があるのに、内覧の材料（内覧の表・お客様の状態の塊）が入力に無い",
  },
];
// tasks（未完了のタスク）は入れない: 証拠になる欄が line_tasks の1回の読み（brain-core の openTasksResult）しか無く、行動台帳の lineTasks も材料の tasksText も同じ読みから作る＝同じ失敗で両方消える（読みの失敗は brain-material-miss の open_tasks が別に数えている）
export type MaterialGap = { id: string; want: string; evidence: string; got: number };
/** 有るはずの材料の抜け（決まった計算・LLM なし）。目録が無い番（指示書を作らない番・申込以降）は見ない。1番に max 件まで */
export function materialGaps(m: Rec | null | undefined, items: readonly MaterialIndexItem[] | null | undefined, max = 3): MaterialGap[] {
  if (!m || !items?.length) return [];
  const out: MaterialGap[] = [];
  for (const r of EXPECTED) {
    const ev = (() => { try { return r.evidence(m); } catch { return null; } })();
    if (!ev) continue;
    const got = Math.max(0, ...items.filter((i) => r.want.some((w) => (w.endsWith("/") ? i.k.startsWith(w) : i.k === w))).map((i) => i.n));
    if (got >= r.min) continue;
    out.push({ id: r.id, want: r.want.join("|"), evidence: ev, got });
    if (out.length >= max) break;
  }
  return out;
}
