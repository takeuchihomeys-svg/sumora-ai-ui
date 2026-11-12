// app/lib/brain-judge-basis.ts — 判断の根拠のメモ: ブレインが「何を根拠に道を選んだか」を、判断を全部書き終えた後に書く欄（純関数・DB/LLM なし）
//
// 2026-11-12 作業員17（竹内さん 11/12・KB 1a78e4e3・7d6fe3eb・ef6626d7）。
//   書かせる物: 読んだ状況の手がかり／読む深さ（浅い・普通・深い）と深さを決めた手がかり・なぜ／立てた読みの候補と選んだ理由／優先した要件の順／重点／選んだ確認の順番とそのなぜ。
//   置き方: brain-seven-fields.ts（3e7b63be）と同じ＝aix・action・reply_mode・reply_direction・turn_contract を全部書き終えた後に JSON の一番最後に書き終えた後のメモとして。
//     道の前や判断と並べると道が引っぱられる（試験で4回起きた）。この欄で判断を変えない。
//   既定 off（BRAIN_JUDGE_BASIS=on）。off の時は出力の指定が空文字＝1文字も変わらない。型の名前は judge-basis-types.ts の1か所。
import { DEPTH_KINDS, PRIORITY_KINDS, PRIORITY_LABEL, FOCUS_KINDS, FOCUS_LABEL, ORDER_ROLES, type BasisDepth, type Priority, type Focus } from "./judge-basis-types";

type Env = Record<string, string | undefined>;
export const brainJudgeBasisOn = (env: Env = typeof process !== "undefined" ? process.env : {}): boolean => (env.BRAIN_JUDGE_BASIS ?? "").trim().toLowerCase() === "on";

export type BasisReading = { reading: string; focus: Focus | null };
export type JudgeBasis = {
  clues: string[];
  depth: BasisDepth | null; depthClue: string; depthWhy: string;
  readings: BasisReading[]; chosen: number | null; chosenWhy: string;
  priority: Priority[]; focus: Focus | null;
  order: string[]; orderWhy: string;
};

export const BRAIN_JUDGE_BASIS_FIELD = `"judge_basis"（書き終えた後のメモ・判断の根拠のメモ。判断は変えない・材料に無い事実は書かない）: {"clues": ["読んだ状況の手がかり（お客様の言葉・直前の送信・段階・時期 等）25字×最大4"], "depth": "${DEPTH_KINDS.join("|")}（この番をどれだけ深く読んだか）", "depth_clue": "深さを決めた手がかり 25字", "depth_why": "なぜその深さか 30字", "readings": [{"reading": "立てた読み（お客様は今こう思っている・こうしたい）30字", "focus": "${FOCUS_KINDS.join("|")}"}（2〜3候補）], "chosen": 選んだ読みの番号（0 から）, "chosen_why": "選んだ理由 30字", "priority": ["優先した要件を大切な順に ${PRIORITY_KINDS.join("|")} から最大3つ"], "focus": "この番で一番大切にした事 ${FOCUS_KINDS.join("|")}", "order": ["使った確認の順番を ${ORDER_ROLES.join("|")} から順に"], "order_why": "その順番にした理由 30字"}`;
export const BRAIN_JUDGE_BASIS_LEGEND = `重点＝${FOCUS_KINDS.map((k) => `${k}（${FOCUS_LABEL[k]}）`).join("・")}。優先＝${PRIORITY_KINDS.map((k) => `${k}（${PRIORITY_LABEL[k]}）`).join("・")}。`;

/** ブレインの「今回の発言」の出力に足す項目（off なら空文字）。brainSevenOutputItem の後ろに続ける */
export function brainJudgeBasisOutputItem(env?: Env): string {
  return brainJudgeBasisOn(env) ? `、（以下は書き終えた後のメモ＝aix・action・reply_mode・reply_direction・turn_contract・seven_read 等を全部書き終えた後で JSON の一番最後に書く。これを書くために道・AIX・返信の方向を変えない。${BRAIN_JUDGE_BASIS_LEGEND}）${BRAIN_JUDGE_BASIS_FIELD}` : "";
}

const clip = (v: unknown, n: number) => String(v ?? "").replace(/\s+/g, " ").trim().slice(0, n);
const blank = (v: unknown) => v == null || ["", "null", "none"].includes(String(v).trim().toLowerCase());
const pickOf = <T extends string>(v: unknown, list: readonly T[]): T | null => { const s = String(v ?? "").trim() as T; return list.includes(s) ? s : null; };

/** 生の欄 → 型（一覧の外の名前は捨てる・何も残らなければ null） */
export function normalizeJudgeBasis(raw: unknown): JudgeBasis | null {
  if (!raw || typeof raw !== "object") return null;
  const o = raw as Record<string, unknown>;
  const clues = Array.isArray(o.clues) ? o.clues.filter((x) => !blank(x)).map((x) => clip(x, 30)).slice(0, 4) : [];
  const readings: BasisReading[] = Array.isArray(o.readings)
    ? o.readings.flatMap((r) => (r && typeof r === "object" && !blank((r as { reading?: unknown }).reading) ? [{ reading: clip((r as { reading?: unknown }).reading, 40), focus: pickOf((r as { focus?: unknown }).focus, FOCUS_KINDS) }] : [])).slice(0, 3)
    : [];
  const ch = Number(o.chosen);
  const chosen = o.chosen != null && Number.isInteger(ch) && ch >= 0 && ch < readings.length ? ch : null;
  const priority = (Array.isArray(o.priority) ? o.priority : []).map((x) => pickOf(x, PRIORITY_KINDS)).filter((x): x is Priority => !!x).filter((x, i, a) => a.indexOf(x) === i).slice(0, 3);
  const order = (Array.isArray(o.order) ? o.order : []).map((x) => pickOf(x, ORDER_ROLES as readonly string[])).filter((x): x is string => !!x).slice(0, 8);
  const out: JudgeBasis = {
    clues, depth: pickOf(o.depth, DEPTH_KINDS), depthClue: blank(o.depth_clue) ? "" : clip(o.depth_clue, 40), depthWhy: blank(o.depth_why) ? "" : clip(o.depth_why, 50),
    readings, chosen, chosenWhy: blank(o.chosen_why) ? "" : clip(o.chosen_why, 50),
    priority, focus: pickOf(o.focus, FOCUS_KINDS), order, orderWhy: blank(o.order_why) ? "" : clip(o.order_why, 50),
  };
  return out.depth || out.focus || out.readings.length || out.priority.length || out.order.length ? out : null;
}

/** digest の短い1語（例: d|answer|answer_question） */
export const judgeBasisDigest = (t: JudgeBasis | null | undefined) => (t ? `${t.depth ? t.depth[0] : "?"}|${t.focus ?? "?"}|${t.priority[0] ?? "?"}` : null);
