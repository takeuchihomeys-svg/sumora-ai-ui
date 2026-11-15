// app/lib/brain-judge-basis.ts — 判断の根拠のメモ: ブレインが「何を根拠に道を選んだか」を、判断を全部書き終えた後に書く欄（純関数・DB/LLM なし）
//
// 2026-11-12 作業員17（竹内さん 11/12・KB 1a78e4e3・7d6fe3eb・ef6626d7）。
//   書かせる物: 読んだ状況の手がかり／読む深さ（浅い・普通・深い）と深さを決めた手がかり・なぜ／立てた読みの候補と選んだ理由／優先した要件の順／重点／選んだ確認の順番とそのなぜ。
//   置き方: brain-seven-fields.ts（3e7b63be）と同じ＝aix・action・reply_mode・reply_direction・turn_contract を全部書き終えた後に JSON の一番最後に書き終えた後のメモとして。
//     道の前や判断と並べると道が引っぱられる（試験で4回起きた）。この欄で判断を変えない。
//   既定 off（BRAIN_JUDGE_BASIS=on）。off の時は出力の指定が空文字＝1文字も変わらない。型の名前は judge-basis-types.ts の1か所。
import { NEXT_DEST, type NextDest } from "./next-move-types";
import { DEPTH_KINDS, DEPTH_LABEL, DEPTH_VIA_KINDS, DEPTH_VIA_LABEL, CHECK_STEPS, STEP_LABEL, PRIORITY_KINDS, PRIORITY_LABEL, FOCUS_KINDS, FOCUS_LABEL, ORDER_ROLES, PURPOSE_KINDS, PURPOSE_LABEL, MISSING_KINDS, MISSING_LABEL, type BasisDepth, type BasisDepthVia, type Priority, type Focus, type Purpose, type MissingKind } from "./judge-basis-types";

type Env = Record<string, string | undefined>;
/** 2026-11-12 作業員22（作業員10 の測り: 文の誘導先をブレインから取ると 12/48→5/48＝答案にブレインの次の行き先の欄が無い）:
 *  判断の根拠のメモに次の行き先（作業員16 の NEXT_DEST）と「答えられるのに約束にした問い」の印を足す。BRAIN_JUDGE_BASIS=on かつ BRAIN_JUDGE_BASIS_NEXT=on の時だけ（既定 off）。
 *  置き方は judge_basis と同じ（道を書き終えた後・JSON の最後）。道の前には置かない */
export const brainJudgeBasisNextOn = (env: Env = typeof process !== "undefined" ? process.env : {}): boolean => (env.BRAIN_JUDGE_BASIS_NEXT ?? "").trim().toLowerCase() === "on";
export const BRAIN_JUDGE_BASIS_NEXT_FIELDS = `"next_dest": "書き終えた道の後で、この番のあとお客様を進める先を ${NEXT_DEST.join("|")} から1つ（道は変えない）", "held_answerable": {"held": 会話・資料・会社の事実で答えられる問いを確かめる約束にしたか true|false, "quote": "その問いのお客様の言葉 25字（無ければ空）"}`;
/** 2026-11-15 作業員L（統括の土台①・統括の外れの場所を本番で記録する）: 3つの形。
 *  off    … 出力の指定も meta も無い（今まで通り）
 *  on     … 出力の指定を足し meta.judge_basis に入れる＝文の統括（compose-sentence-plan・compose-brief）・配分（conductor-allocation の深さ）・指示書・疑いの印が読む＝下書きが変わりうる
 *  shadow … 出力の指定は on と同じ（ブレインに書かせないと記録できない）が、meta.judge_basis_rec にだけ入れる＝読む側は誰も読まない（記録だけ・judge_next も作らない）。
 *           本番の記録は brain_decision_logs.digest.jbr（judgeBasisRecDigest）。数えるのは scripts/judge-basis-score.ts（--results で答案・--prod で本番の記録）
 *  費用: on と shadow はブレインの今回の発言の層の出力が 1回 約250〜400 トークン増える（指定の文は約1.5k 字・前置きでなく毎回の所）。
 *  試験（11/15 作業員L・DeepSeek・10問×1回・L1115-jb-off → L1115-jb-shadow）: 最終の道 8/10 → 8/10・合格 5 → 7 だが、本質の道（LLM の最初の答え）7 → 4、
 *    q051 が返信→AIX:property_check_result に悪化（下書き 4/5 → 3/5）。出力の指定を足すと道が揺れる（KB c5fd146d と同じ型）＝記録だけでも「道を変えない」とは言えない。
 *    → 既定は off のまま。shadow にするのは --majority（3回の過半数）で悪化0を確かめてから。 */
export type JudgeBasisMode = "off" | "on" | "shadow";
export const JUDGE_BASIS_DEFAULT_MODE: JudgeBasisMode = "off";
export function judgeBasisMode(env: Env = typeof process !== "undefined" ? process.env : {}): JudgeBasisMode {
  const v = (env.BRAIN_JUDGE_BASIS ?? "").trim().toLowerCase();
  return v === "on" || v === "shadow" || v === "off" ? v : JUDGE_BASIS_DEFAULT_MODE;
}
/** 読む側（文の統括・配分・指示書・judge_next）に渡す形か＝on の時だけ。shadow は記録だけなので false */
export const brainJudgeBasisOn = (env: Env = typeof process !== "undefined" ? process.env : {}): boolean => judgeBasisMode(env) === "on";
/** 記録だけの形か（meta.judge_basis_rec に入れる） */
export const brainJudgeBasisShadow = (env: Env = typeof process !== "undefined" ? process.env : {}): boolean => judgeBasisMode(env) === "shadow";
/** ブレインに書かせるか（on か shadow） */
export const brainJudgeBasisAsk = (env: Env = typeof process !== "undefined" ? process.env : {}): boolean => judgeBasisMode(env) !== "off";

export type BasisReading = { reading: string; focus: Focus | null };
export type JudgeBasis = {
  clues: string[];
  depth: BasisDepth | null; depthClue: string; depthWhy: string;
  /** 2026-11-12 作業員22（作業員16 の CheckDepth.via）: 普通の番の中身（back＝遡る／fact＝事実を見る）。書いていなければ null */
  depthVia: BasisDepthVia | null;
  readings: BasisReading[]; chosen: number | null; chosenWhy: string;
  priority: Priority[]; focus: Focus | null;
  order: string[]; orderWhy: string;
  /** 2026-11-12 作業員22: 目的（なぜこの番でこれをするか・check-order の Need の名前）となぜ */
  purpose: Purpose | null; purposeWhy: string;
  /** 足りない情報（何が無いからそうしているか）。[] は足りない物が無い・null は書いていない */
  missing: BasisMissing[] | null;
  /** 押さえる要点（どこを押さえにいっているか） */
  keyPoint: string;
  /** 2026-11-12 作業員22（BRAIN_JUDGE_BASIS_NEXT）: 次の行き先（NEXT_DEST）と、答えられるのに約束にした問いの印 */
  nextDest: NextDest | null;
  held: { held: boolean; quote: string } | null;
};
export type BasisMissing = { kind: MissingKind; what: string };

export const BRAIN_JUDGE_BASIS_FIELD = `"judge_basis"（書き終えた後のメモ・判断の根拠のメモ。判断は変えない・材料に無い事実は書かない）: {"clues": ["読んだ状況の手がかり（お客様の言葉・直前の送信・段階・時期 等）25字×最大4"], "depth": "${DEPTH_KINDS.join("|")}（この番の読み方: ${DEPTH_KINDS.map((k) => `${k}＝${DEPTH_LABEL[k]}`).join("・")}）", "depth_via": "${DEPTH_VIA_KINDS.join("|")}|none（普通の時の中身: ${DEPTH_VIA_KINDS.map((k) => `${k}＝${DEPTH_VIA_LABEL[k]}`).join("・")}）", "depth_clue": "深さを決めた手がかり 25字", "depth_why": "なぜその深さか 30字", "readings": [{"reading": "立てた読み（お客様は今こう思っている・こうしたい）30字", "focus": "${FOCUS_KINDS.join("|")}"}（2〜3候補）], "chosen": 選んだ読みの番号（0 から）, "chosen_why": "選んだ理由 30字", "priority": ["優先した要件を大切な順に ${PRIORITY_KINDS.join("|")} から最大3つ"], "focus": "この番で一番大切にした事 ${FOCUS_KINDS.join("|")}", "order": ["使った確認の順番を ${CHECK_STEPS.join("|")} から順に"], "order_why": "その順番にした理由 30字", "purpose": "なぜこの番でこれをするか（目的）を ${PURPOSE_KINDS.join("|")} から1つ", "purpose_why": "その目的にした理由 30字", "missing": [{"kind": "${MISSING_KINDS.join("|")}", "what": "何が足りないか 25字"}]（足りない物が無ければ []・最大3）, "key_point": "この番で押さえる要点（お客様のどの言葉・どの事実か）30字"}`;
/** 目的・足りない情報・要点に書かない言葉の目安（道・次の一手の言葉）。読み取りでは消さずに物差しで数える */
export const BASIS_ROUTE_WORD_RE = /AIX|返信|申込|内覧|押す|抑え|次の一手|誘導|オススメ|お送りする/; // 「押さえる要点」は欄の名前なので含めない（部屋を抑えるは「抑え」）
export const BRAIN_JUDGE_BASIS_LEGEND = `目的＝${PURPOSE_KINDS.map((k) => `${k}（${PURPOSE_LABEL[k]}）`).join("・")}。足りない情報＝${MISSING_KINDS.map((k) => `${k}（${MISSING_LABEL[k]}）`).join("・")}。目的・足りない情報・要点はお客様の言葉と事実だけで書く（道や次の一手の言葉は書かない）。確認の順番＝${CHECK_STEPS.map((k) => `${k}（${STEP_LABEL[k]}）`).join("・")}。重点＝${FOCUS_KINDS.map((k) => `${k}（${FOCUS_LABEL[k]}）`).join("・")}。優先＝${PRIORITY_KINDS.map((k) => `${k}（${PRIORITY_LABEL[k]}）`).join("・")}。`;

/** ブレインの「今回の発言」の出力に足す項目（off なら空文字）。brainSevenOutputItem の後ろに続ける */
export function brainJudgeBasisOutputItem(env?: Env): string {
  const field = brainJudgeBasisNextOn(env) ? `${BRAIN_JUDGE_BASIS_FIELD.slice(0, -1)}, ${BRAIN_JUDGE_BASIS_NEXT_FIELDS}}` : BRAIN_JUDGE_BASIS_FIELD;
  return brainJudgeBasisAsk(env) ? `、（以下は書き終えた後のメモ＝aix・action・reply_mode・reply_direction・turn_contract・seven_read 等を全部書き終えた後で JSON の一番最後に書く。これを書くために道・AIX・返信の方向を変えない。${BRAIN_JUDGE_BASIS_LEGEND}）${field}` : "";
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
    depthVia: pickOf(o.depth_via, DEPTH_VIA_KINDS),
    readings, chosen, chosenWhy: blank(o.chosen_why) ? "" : clip(o.chosen_why, 50),
    priority, focus: pickOf(o.focus, FOCUS_KINDS), order, orderWhy: blank(o.order_why) ? "" : clip(o.order_why, 50),
    purpose: pickOf(o.purpose, PURPOSE_KINDS), purposeWhy: blank(o.purpose_why) ? "" : clip(o.purpose_why, 50),
    missing: Array.isArray(o.missing)
      ? o.missing.flatMap((m): BasisMissing[] => { const r = (m && typeof m === "object" ? m : { kind: m }) as { kind?: unknown; what?: unknown }; const k = pickOf(r.kind, MISSING_KINDS); return k ? [{ kind: k, what: blank(r.what) ? "" : clip(r.what, 40) }] : []; }).filter((x, i, a) => a.findIndex((y) => y.kind === x.kind) === i).slice(0, 3)
      : null,
    keyPoint: blank(o.key_point) ? "" : clip(o.key_point, 50),
    nextDest: pickOf(o.next_dest, NEXT_DEST),
    held: o.held_answerable && typeof o.held_answerable === "object" && typeof (o.held_answerable as { held?: unknown }).held === "boolean"
      ? { held: (o.held_answerable as { held: boolean }).held, quote: blank((o.held_answerable as { quote?: unknown }).quote) ? "" : clip((o.held_answerable as { quote?: unknown }).quote, 30) } : null,
  };
  return out.depth || out.focus || out.readings.length || out.priority.length || out.order.length || out.purpose || out.keyPoint ? out : null;
}

/** digest の短い1語（例: d|ease|worry|worry|m1＝深さ|重点|優先の先頭|目的|足りない情報の数） */
export const judgeBasisDigest = (t: JudgeBasis | null | undefined) => (t ? `${t.depth ? t.depth[0] : "?"}|${t.focus ?? "?"}|${t.priority[0] ?? "?"}|${t.purpose ?? "?"}|m${t.missing ? t.missing.length : "?"}` : null);

/** meta.judge_next（文の統括へ plan で渡す・BRAIN_JUDGE_BASIS と BRAIN_JUDGE_BASIS_NEXT が両方 on の時だけ）。判断の根拠のメモから写すだけ */
export type JudgeNext = { dest: NextDest | null; held: boolean; quote: string | null };
export function judgeNextOf(raw: unknown, env?: Env): JudgeNext | undefined {
  if (!brainJudgeBasisOn(env) || !brainJudgeBasisNextOn(env)) return undefined;
  const jb = normalizeJudgeBasis(raw);
  if (!jb || (!jb.nextDest && !jb.held)) return undefined;
  return { dest: jb.nextDest, held: jb.held?.held === true, quote: jb.held?.held && jb.held.quote ? jb.held.quote : null };
}

/** 2026-11-15 作業員L: 本番の記録（brain_decision_logs.digest.jbr）の短い形。scripts/judge-basis-score.ts --prod が judgeBasisFromRecDigest で戻して数える。
 *  d 深さ・f 重点・p 優先・o 順番・r 読みの候補の重点・c 選んだ読み・u 目的・m 足りない情報の種類（[] は無い・欄なしは書いていない） */
export type JudgeBasisRecDigest = { d?: string; f?: string; p?: string[]; o?: string[]; r?: Array<string | null>; c?: number; u?: string; m?: string[] };
export function judgeBasisRecDigest(t: JudgeBasis | null | undefined): JudgeBasisRecDigest | null {
  if (!t) return null;
  const out: JudgeBasisRecDigest = {};
  if (t.depth) out.d = t.depth;
  if (t.focus) out.f = t.focus;
  if (t.priority.length) out.p = [...t.priority];
  if (t.order.length) out.o = [...t.order];
  if (t.readings.length) out.r = t.readings.map((r) => r.focus);
  if (t.chosen != null) out.c = t.chosen;
  if (t.purpose) out.u = t.purpose;
  if (t.missing) out.m = t.missing.map((m) => m.kind);
  return Object.keys(out).length ? out : null;
}
/** digest.jbr → 判断の根拠のメモの生の形（normalizeJudgeBasis に通せる形・読みの文は残していないので「読みN」） */
export function judgeBasisFromRecDigest(d: unknown): Record<string, unknown> | null {
  if (!d || typeof d !== "object") return null;
  const o = d as JudgeBasisRecDigest;
  return {
    depth: o.d ?? null, focus: o.f ?? null, priority: o.p ?? [], order: o.o ?? [],
    readings: (o.r ?? []).map((f, i) => ({ reading: `読み${i + 1}`, focus: f })), chosen: o.c ?? null,
    purpose: o.u ?? null, missing: Array.isArray(o.m) ? o.m.map((k) => ({ kind: k })) : undefined,
  };
}
