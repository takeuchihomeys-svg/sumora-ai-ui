// app/lib/conductor-doubt.ts — 統括の「確かめる段」（疑いの印）と「自信の印」（番の確かさ）の表（純関数・DB/LLM なし・作業員22・2026-11-12）
//
// 竹内さん 11/12「統括としての機能に足りていない部分や強化する部分あれば入れていく」「これらの部分も細分化して強化していく」
//   （親 P0 575a7cd5・8bfcdf60② 下の役の答えを確かな事実と照らす・ea2a9405③ 自信を測って分からない時はスタッフに正直に渡す）。
// ① 疑いの印（DOUBT_TABLE）: ブレインの判断を、別の部品が持つ事実と突き合わせて食い違いを印にする。決め直さない（記録だけ）。
//    1行＝1種類: 何と何を突き合わせるか（compares）・なぜ疑うか（why）・スタッフの直しのどの型に当たるか（editTypes＝edited-turn-miner の EditType／AIX の番）。
//    並びは「本番でスタッフが AI の下書きを直した番」の数の多い順（edited-turns の weak-spots.json から scripts/doubt-kind-rank.ts で数える・今の並びは 2026-10-16 の14日分 358番）。
// ② 自信の印（SURE_CUES）: 確かさを下げる手がかりの種類・重み・なぜ。合計で 高・中・低。影の自動返信で人に回す線の案（HANDOFF_RULE）。
// 置き方: 道（meta.action・reply_mode・turn_contract の route）は照らすために読むだけ。どの欄にも返信か AIX かを決める言葉は入れない。
import { strengthCeiling, type NextStrength } from "./next-move-types";
import { splitOurPartsFine } from "./our-part-types";
import type { InfoCell } from "./info-fill-map";
import type { OpenItem } from "./exchange-ledger";

export const DOUBT_KINDS = [
  "fact_missed", "path_mismatch", "misread", "push_over_ceiling", "held_answerable", "time_line", "promise_overlap", "answered_staff_only", "fact_but_staff",
] as const;
export type DoubtKind = typeof DOUBT_KINDS[number];
export type DoubtSpec = {
  kind: DoubtKind; label: string;
  /** どの部品の何と何を突き合わせるか */
  compares: string;
  /** なぜ疑うか */
  why: string;
  /** スタッフの直しの型（edited-turn-miner の EditType・"aix_turn"＝人が AIX を押した番・"staff_value:datetime" 等は AIX の番の人しか知らない事の型） */
  editTypes: string[];
  /** 2026-10-16 の14日分（返信 151・AIX の文 148・AIX の番 59）で当たった直しの数 */
  count1016: number;
};
export const DOUBT_TABLE: readonly DoubtSpec[] = [
  { kind: "fact_missed", label: "事実の取りこぼし", compares: "照らし合わせの残り（exchange-ledger の their_question_unanswered）× 判断の依頼ごとの読み（turn_contract.asks の quote）",
    why: "お客様がまだ答えてもらっていない問いがあるのに、この番の依頼に入っていない＝金額・日時・物件を人が直す番（fact_fix）の一番の出所", editTypes: ["fact_fix", "staff_value:money"], count1016: 65 },
  { kind: "path_mismatch", label: "型と道の食い違い", compares: "判断の順番の型（check-order の型の目的・後で果たす型か）× この番の出し方（meta.action）",
    why: "約束が先の型（T1・T3・T4）で今スタッフの番にした／結果を先に果たす型（T10）で今スタッフの番にしない＝人が AIX を押し直した番（AIX の番 59 のうち人しか知らない日時・金額の10を除く）", editTypes: ["aix_turn"], count1016: 49 },
  { kind: "misread", label: "読み違い", compares: "一通の読みの候補（read_candidates）・判断の根拠の選んだ読み（judge_basis）× 問いの有無（customer_questions）・入口の重点（conductor_focus）",
    why: "お礼だけと読んだのに問いがある／2つの読み手の重点が違う＝人が書き直した番（近さ0.3未満・場面・中身が違う）", editTypes: ["rewrite"], count1016: 45 },
  { kind: "push_over_ceiling", label: "押す強さの上限越え", compares: "訴求の時機（appeal_timing・engagement_stance）× 押す強さの上限（next-move-types.strengthCeiling・刺さり・検討・初回・取られる不安）",
    why: "竹内さんの198通で上限を超えた番は 5% 未満。超えると人が誘いを消す（appeal_cut）", editTypes: ["appeal_cut"], count1016: 17 },
  { kind: "held_answerable", label: "答えられるのに保留", compares: "確かめる約束の依頼（turn_contract の route=promise）× その依頼の出所（basis が会話・資料・会社の事実）／要る情報の埋まり（info-fill-map が全部 known）",
    why: "答えの材料があるのに確認の約束にした＝人がその場で答えた番（promise_escape・q065 の形）", editTypes: ["promise_escape"], count1016: 12 },
  { kind: "time_line", label: "時間の線の食い違い", compares: "約束の文の時の言葉（本日中・今日中）× 番の時刻（analyzed_msg_ts の JST・21時以降）",
    why: "夜の番に本日中と約束すると果たせない・人が日時を直す（AIX の番の人しか知らない日時 8・作業員20 の21時の線）", editTypes: ["staff_value:datetime"], count1016: 8 },
  { kind: "promise_overlap", label: "約束の重ね", compares: "この番の約束（turn_contract の promise の文を our-part-types で分けた鍵）× 照らし合わせの果たし済み・まだ果たしていない約束（exchange-ledger）",
    why: "同じ約束を重ねると対象の無い約束になる＝人が消す（vague_promise_cut）", editTypes: ["vague_promise_cut"], count1016: 7 },
  { kind: "answered_staff_only", label: "スタッフしか知らない事に答えた", compares: "答えの依頼（route=reply の問い）× その出所（basis が判断・無し）",
    why: "出所の無い答えは作り話になる＝人が確認の約束に直す（promise_added）", editTypes: ["promise_added"], count1016: 7 },
  { kind: "fact_but_staff", label: "答えられるのにスタッフの番", compares: "問いの依頼（kind=question）の出所（basis・answer）× この番の出し方（meta.action）",
    why: "問いが全部、会話・資料・会社の事実で答えられるのにスタッフの番にした（10/21 A1 の逆向き）。直しの型の網に当たる物はまだ無い", editTypes: [], count1016: 0 },
];
export const DOUBT_LABEL: Record<DoubtKind, string> = Object.fromEntries(DOUBT_TABLE.map((d) => [d.kind, d.label])) as Record<DoubtKind, string>;
export type BriefDoubt = { kind: DoubtKind; why: string };

/** 自信の印（確かさを下げる手がかり）。重みは直しの多さ・決め直しの起きやすさの目安（影の自動返信の集計で直す） */
export const SURE_CUES = [
  { key: "doubt", weight: 2, why: "別の部品の事実と食い違った＝直される番の出所（疑いの印1つにつき・2つまで数える）" },
  { key: "read_split", weight: 2, why: "読みの候補が割れて選べていない＝一通の中身が言葉に無い番（T4・T5 の外れの形）" },
  { key: "material_unwired", weight: 2, why: "要る情報の材料がブレインに届いていない＝分からないまま書く" },
  { key: "brain_low", weight: 1, why: "ブレイン自身が自信 low と書いた（need.confidence）" },
  { key: "deep", weight: 1, why: "深く読む番＝複数の依頼・申込・審査（竹内さんの番の外れが寄っていた理由・P1 077d6e18）" },
  { key: "rare_type", weight: 1, why: "竹内さんの実例が少ない型（T10・T11・T12＝本番の数件・実例1件から作った型）" },
  { key: "new_scene", weight: 1, why: "型の表のどれにも当たらない番（初めての場面）" },
] as const;
export type SureCueKey = typeof SURE_CUES[number]["key"];
export const RARE_TYPES: ReadonlySet<string> = new Set(["T10_result_ready", "T11_first_contact_hearing", "T12_hooked_comparing_taken"]);
export type Sure = "high" | "mid" | "low";
/** 確かさの線: 合計 0〜1＝高・2〜3＝中・4以上＝低 */
export const SURE_LINE = { mid: 2, low: 4 } as const;
/** 影の自動返信で人に回す線の案（記録だけ・作業員1 の場面の集計で直す）: 低い番は全部／直しの多い上位2種の疑いの印は1つでも */
export const HANDOFF_RULE = { level: "low" as Sure, kinds: ["fact_missed", "path_mismatch"] as DoubtKind[], why: "低い番と、スタッフの直しが一番多い2種（事実の取りこぼし 65・型と道 49）の疑いがある番は、影の自動返信でも人に回す" };

export type DoubtInputs = {
  asks: Array<Record<string, unknown>>;
  ledger: { open: OpenItem[]; keptPromises: string[] } | null;
  info: { node: string | null; cells: InfoCell[] } | null;
  typeId: string | null;
};
const FACT_BASES = new Set(["conversation", "material", "company_fact", "general"]);
const BASIS_JA: Record<string, string> = { conversation: "会話", material: "資料", company_fact: "会社の事実", general: "一般", judgement: "判断" };
const obj = (v: unknown): Record<string, unknown> | null => (v && typeof v === "object" && !Array.isArray(v) ? (v as Record<string, unknown>) : null);
const arr = (v: unknown): unknown[] => (Array.isArray(v) ? v : []);
const str = (v: unknown, n = 60): string | null => (typeof v === "string" && v.trim() ? v.trim().slice(0, n) : null);
const staffTurnOf = (m: Record<string, unknown>) => m.reply_mode !== "auto_reply" && typeof m.action === "string" && !!m.action;
const LATER_TYPES = new Set(["T1_conditions_first", "T3_question_staff_only", "T4_property_shared"]);
const kw = (t: string) => (t.match(/[一-龠ァ-ヶー]{2,}/g) ?? []).filter((k) => !/させて|頂き|致し|ご確認|お部屋|部屋|物件|こちら/.test(k));
const overlaps = (a: string, b: string) => kw(a).some((k) => b.includes(k));
const jstHour = (iso: string | null) => { const t = iso ? Date.parse(iso) : NaN; return Number.isFinite(t) ? new Date(t + 9 * 3600_000).getUTCHours() : null; };
const RANK: Record<NextStrength, number> = { none: 0, door: 1, together: 2, invite: 2, strong: 3 };

/** 疑いの印（DOUBT_TABLE の並び＝直しの多い順に出す）。道は照らすために読むだけ・変えない */
export function briefDoubts(m: Record<string, unknown>, c: DoubtInputs): BriefDoubt[] {
  const hit = new Map<DoubtKind, string>();
  const add = (k: DoubtKind, why: string) => { if (!hit.has(k)) hit.set(k, why); };
  const staff = staffTurnOf(m);
  const qs = c.asks.filter((a) => a.kind === "question");
  const promiseAsks = c.asks.filter((a) => a.route === "promise" && str(a.answer));
  // 事実の取りこぼし
  const unanswered = (c.ledger?.open ?? []).filter((o) => o.kind === "their_question_unanswered");
  const missed = unanswered.filter((o) => !c.asks.some((a) => overlaps(o.what, String(a.quote ?? "")) || overlaps(String(a.quote ?? ""), o.what)));
  if (missed.length) add("fact_missed", `まだ答えていない問い ${missed.length}件が依頼に無い（${missed[0].what.slice(0, 20)}）`);
  // 型と道
  if (c.typeId && LATER_TYPES.has(c.typeId) && staff) add("path_mismatch", `${c.typeId.split("_")[0]} は今の番は約束・果たしは後の型`);
  if (c.typeId === "T10_result_ready" && !staff) add("path_mismatch", "T10 は前の約束の結果を先に果たす型");
  // 読み違い
  const rc = obj(m.read_candidates);
  const cq = arr(m.customer_questions).filter((x) => typeof x === "string" && x.trim());
  if (rc?.turn === "ack_only" && (cq.length || qs.length)) add("misread", "お礼だけと読んだが問いがある");
  const jb = obj(m.judge_basis);
  const jbFocus = str(jb?.focus, 20), cfFocus = str(obj(m.conductor_focus)?.focus, 20);
  if (jbFocus && cfFocus && jbFocus !== cfFocus) add("misread", `重点が割れた（入口 ${cfFocus}・判断 ${jbFocus}）`);
  // 押す強さの上限越え
  const at = obj(m.appeal_timing);
  const brainStrength: NextStrength | null = at?.level === "must" ? "strong" : at?.level === "suggest" ? "invite" : m.engagement_stance === "push" ? "invite" : null;
  if (brainStrength) {
    const uptake = arr(m.our_send_uptake).map(obj);
    const ceil = strengthCeiling({
      remaining: false, decideSignal: m.customer_intent === "decision", considering: typeof m.hesitancy_pattern === "string" && !!m.hesitancy_pattern,
      firstContact: c.typeId === "T11_first_contact_hearing", notHooked: uptake.length > 0 && uptake.every((u) => u?.hook === "not_hooked"),
      takenWorry: obj(obj(m.customer_mindset)?.anxiety)?.target === "先に取られる",
    } as Parameters<typeof strengthCeiling>[0]);
    if (RANK[brainStrength] > RANK[ceil.max]) add("push_over_ceiling", `${brainStrength} が上限 ${ceil.max} を越えた（${ceil.why.slice(0, 30)}）`);
  }
  // 答えられるのに保留
  const heldByBasis = promiseAsks.filter((a) => FACT_BASES.has(String(a.basis)) && a.kind === "question");
  if (heldByBasis.length) add("held_answerable", `確かめる約束にした問いに出所あり（${BASIS_JA[String(heldByBasis[0].basis)]}）`);
  else if (c.info && c.info.cells.length && c.info.cells.every((x) => x.state === "known") && promiseAsks.some((a) => /確認|確かめ/.test(String(a.answer)))) add("held_answerable", `今の駅（${c.info.node ?? "?"}）の要る情報は全部分かっている`);
  // 時間の線
  const h = jstHour(str(m.analyzed_msg_ts, 40));
  if (h !== null && h >= 21 && promiseAsks.some((a) => /本日中|今日中/.test(String(a.answer)))) add("time_line", `${h}時の番で本日中の約束`);
  // 約束の重ね
  const promiseKeys = promiseAsks.flatMap((a) => splitOurPartsFine(String(a.answer), "").filter((p) => p.kind === "promise").map((p) => p.key));
  const again = promiseKeys.filter((k) => c.ledger?.keptPromises.includes(k));
  const stillOpen = (c.ledger?.open ?? []).filter((o) => o.kind === "our_promise_unkept");
  if (again.length) add("promise_overlap", `果たし済みの約束をまた約束（${[...new Set(again)].join(",")}）`);
  else if (stillOpen.length && promiseAsks.some((a) => stillOpen.some((o) => overlaps(o.what, String(a.answer))))) add("promise_overlap", "まだ果たしていない約束と同じ約束を重ねた");
  // スタッフしか知らない事に答えた
  const noBasis = c.asks.filter((a) => a.route === "reply" && a.kind === "question" && !FACT_BASES.has(String(a.basis)) && str(a.answer));
  if (noBasis.length) add("answered_staff_only", `出所の無い答え ${noBasis.length}件`);
  // 答えられるのにスタッフの番
  if (staff && qs.length && qs.every((a) => FACT_BASES.has(String(a.basis)) && str(a.answer))) add("fact_but_staff", `問い${qs.length}件とも答えの出所あり`);
  return DOUBT_TABLE.filter((d) => hit.has(d.kind)).map((d) => ({ kind: d.kind, why: hit.get(d.kind)! }));
}

/** 番の確かさ（決まった計算・SURE_CUES の重みの合計）。手がかりの名前を残す */
export function briefSure(m: Record<string, unknown>, c: { doubts: BriefDoubt[]; info: DoubtInputs["info"]; typeId: string | null }): { level: Sure; score: number; cues: SureCueKey[]; handoff: boolean } {
  const cues: SureCueKey[] = [];
  const jb = obj(m.judge_basis);
  const readings = arr(jb?.readings).map(obj).filter(Boolean) as Array<Record<string, unknown>>;
  const rc = obj(m.read_candidates);
  if ((new Set(readings.map((r) => String(r.focus))).size >= 2 && jb?.chosen == null) || (rc && arr(rc.options).length >= 2 && rc.chosen == null)) cues.push("read_split");
  if (c.info?.cells.some((x) => x.state === "unwired")) cues.push("material_unwired");
  if (String(obj(m.need)?.confidence ?? "") === "low") cues.push("brain_low");
  if (String(jb?.depth ?? obj(m.brain_depth)?.depth ?? "") === "deep") cues.push("deep");
  if (c.typeId && RARE_TYPES.has(c.typeId)) cues.push("rare_type");
  if (!c.typeId) cues.push("new_scene");
  const w = (k: SureCueKey) => SURE_CUES.find((x) => x.key === k)!.weight;
  const score = cues.reduce((s, k) => s + w(k), 0) + Math.min(c.doubts.length, 2) * w("doubt");
  if (c.doubts.length) cues.unshift("doubt");
  const level: Sure = score >= SURE_LINE.low ? "low" : score >= SURE_LINE.mid ? "mid" : "high";
  const handoff = level === HANDOFF_RULE.level || c.doubts.some((d) => HANDOFF_RULE.kinds.includes(d.kind));
  return { level, score, cues, handoff };
}

/** edited-turns の weak-spots.json（scripts/edited-turn-miner.ts の出力）→ 疑いの印の種類ごとの直しの数（多い順） */
export function rankDoubtKinds(spots: ReadonlyArray<{ bucket: string; type: string; key: string; n: number }>): Array<{ kind: DoubtKind; n: number }> {
  const out = DOUBT_TABLE.map((d) => ({ kind: d.kind, n: 0 }));
  for (const s of spots) {
    const human = s.bucket === "aix_turn" ? s.key.split("|")[2] ?? "" : null;
    for (const d of DOUBT_TABLE) {
      const hitType = d.editTypes.some((t) => (t === "aix_turn" ? s.bucket === "aix_turn" && !(human ?? "").startsWith("staff_value:") : t.startsWith("staff_value:") ? human === t : s.bucket !== "aix_turn" && s.type === t));
      if (hitType) out.find((o) => o.kind === d.kind)!.n += s.n;
    }
  }
  return out.sort((a, b) => b.n - a.n);
}
