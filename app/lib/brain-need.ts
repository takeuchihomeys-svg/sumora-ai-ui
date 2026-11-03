// app/lib/brain-need.ts — ブレインが番ごとに出す「難しさ・自信・足りない材料」（need）と「次の数手の計画」（plan_ahead）（純関数・DB/LLM なし）
//
// 2026-11-03 竹内さん（KB P1「ブレインが取りに行くかを判断する」「考える量もブレインが番ごとに判断する」「ブレインに4つ足す」①）・設計の案 fetch-think-design.md。
//   第1段（この版）: 欄を出させて記録するだけ（判断・読み直しは変えない）。読み直しの口（opts.recheck）は次の段。
//   need: 足りない材料の名前は「取りに行ける道具」から選ぶ（作業員1の材料の自己申告 digest.mm と同じ口にまとめる予定）。
//   plan_ahead: 番ごとにゼロから決めて揺れないよう、前の計画を読み、変える時だけ理由つきで出し直す。置き場は last_brain_meta（正）＝suggested_aix_meta が
//     AIX の1通目の送信で消されても残る（KB 7c1c584b）。
// 切替: BRAIN_NEED_REPORT・BRAIN_PLAN_AHEAD（どちらも既定 off）。テスト: app/lib/__tests__/brain-need.test.ts
type Env = Record<string, string | undefined>;
const envOf = (): Env => (typeof process !== "undefined" ? process.env : {});
const on = (v: string | undefined) => (v ?? "").trim().toLowerCase() === "on";
export const needReportOn = (env: Env = envOf()) => needReportMode(env) !== "off";
/**
 * 2026-11-04 統括役の案A（n7a-need で q015 が悪化: 判断と同じ出力で先に自信を書かせると、自信を持って先へ進む AIX に寄った）:
 *   BRAIN_NEED_REPORT=after は、need を出力の一番最後（判断を全部書き終えた後）の振り返りの欄にする（費用 0・順番だけ変える）。=on は旧の位置（途中）
 */
export function needReportMode(env: Env = envOf()): "off" | "on" | "after" {
  const v = (env.BRAIN_NEED_REPORT ?? "").trim().toLowerCase();
  return v === "after" ? "after" : v === "on" ? "on" : "off";
}
export const planAheadOn = (env: Env = envOf()) => on(env.BRAIN_PLAN_AHEAD);

/** 取りに行ける材料の道具（設計の案 §1） */
export const NEED_TOOLS = ["sheet_detail", "sent_ledger", "estimate", "company_fact", "examples", "past_lines", "property_record", "now_fulfillable", "aix_cards", "customer_memo"] as const;
export type NeedTool = typeof NEED_TOOLS[number];
const LEVELS = ["high", "mid", "low"] as const;
export type Level = typeof LEVELS[number];
export type BrainNeed = { difficulty: Level; confidence: Level; missing: NeedTool[]; why: string };
export type PlanAhead = { goal: string; steps: string[]; why: string; changedBecause: string | null };

export const BRAIN_NEED_RULES = `【この番の難しさ・自信・足りない材料（need）】判断と一緒に出す。
  difficulty: high（要件が2つ以上・お断り・不満・交渉・申込の直前・場面が読みにくい）／mid／low（短いお礼・了承・締めの後のスタンプ 等）
  confidence: あなたの今の判断の自信（high／mid／low）。材料が足りない・会話の読みが2通りある時は low。
  missing: 判断に足りない材料を、次の道具の名前から選ぶ（無ければ []）: sheet_detail（物件の資料の中身・設備や契約）／sent_ledger（こちらが送った事の全部）／estimate（送った見積の金額）／company_fact（会社の事実）／examples（竹内さんの近い実例）／past_lines（お客様の古い発言）／property_record（物件ごとの記録）／now_fulfillable（確認済み・見積を作れる・送れる候補）／aix_cards（AIX の担当の札）／customer_memo（お客様のメモ）`;
export const BRAIN_PLAN_AHEAD_RULES = `【このお客様の次の数手の計画（plan_ahead）】このお客様で目指す事（goal・例「今週中に内覧」）と、次の2〜3手（steps・例「物件オススメ→見積書→内覧調整」）。
  【前の計画】が材料にあれば、それを土台にする: そのまま進む時は果たした手を外して次へ。変える時だけ changedBecause に理由（お客様の言葉・新しい事実）を書く。理由の無い作り直しはしない。`;
export const BRAIN_NEED_RULES_AFTER = `【振り返り（need・判断の後に書く）】判断（action・aix・turn_contract・key_topics 等）を全部書き終えた後で、最後に振り返りとして書く。この振り返りで判断を変えない。
  difficulty: high（要件が2つ以上・お断り・不満・交渉・申込の直前・場面が読みにくい）／mid／low（短いお礼・了承・締めの後のスタンプ 等）
  confidence: 書き終えた判断の自信（high／mid／low）。材料が足りない・会話の読みが2通りある時は low。
  missing: 判断に足りなかった材料を、次の道具の名前から選ぶ（無ければ []）: sheet_detail／sent_ledger／estimate／company_fact／examples／past_lines／property_record／now_fulfillable／aix_cards／customer_memo`;
export const BRAIN_NEED_FIELD = `"need": {"difficulty": "high|mid|low", "confidence": "high|mid|low", "missing": ["道具の名前"], "why": "30字以内"}`;
export const BRAIN_PLAN_AHEAD_FIELD = `"plan_ahead": {"goal": "目指す事（25字以内）", "steps": ["次の手（15字以内）"], "why": "30字以内", "changed_because": "前の計画から変えた理由（変えていなければ null）"}`;

const clip = (v: unknown, n: number) => String(v ?? "").replace(/\s+/g, " ").trim().slice(0, n);
const nullish = (v: unknown) => v == null || String(v).trim() === "" || String(v).trim() === "null";
const pick = <T extends string>(v: unknown, list: readonly T[], d: T): T => ((list as readonly string[]).includes(String(v)) ? (String(v) as T) : d);

export function normalizeNeed(raw: unknown): BrainNeed | null {
  if (!raw || typeof raw !== "object") return null;
  const o = raw as Record<string, unknown>;
  const missing = Array.isArray(o.missing) ? [...new Set(o.missing.map(String).filter((x): x is NeedTool => (NEED_TOOLS as readonly string[]).includes(x)))].slice(0, 5) : [];
  return { difficulty: pick(o.difficulty, LEVELS, "mid"), confidence: pick(o.confidence, LEVELS, "mid"), missing, why: clip(o.why, 40) };
}
export function normalizePlanAhead(raw: unknown): PlanAhead | null {
  if (!raw || typeof raw !== "object") return null;
  const o = raw as Record<string, unknown>;
  const goal = clip(o.goal, 30);
  const steps = Array.isArray(o.steps) ? o.steps.map((x) => clip(x, 20)).filter(Boolean).slice(0, 3) : [];
  if (!goal && !steps.length) return null;
  const cb = o.changed_because ?? o.changedBecause;
  return { goal, steps, why: clip(o.why, 40), changedBecause: nullish(cb) ? null : clip(cb, 50) };
}
/** 前の計画の材料の1行（無ければ ""） */
export function prevPlanAheadLine(prev: PlanAhead | null | undefined, at: string | null | undefined): string {
  if (!prev || (!prev.goal && !prev.steps.length)) return "";
  const when = at ? `（${Math.max(0, Math.round((Date.now() - Date.parse(at)) / 3_600_000))}時間前の判断）` : "";
  return `【前の計画${when}】目指す事: ${prev.goal || "-"}／次の手: ${prev.steps.join("→") || "-"}${prev.why ? `／理由: ${prev.why}` : ""}`;
}
/** digest に残す短い形 */
export const needDigest = (n: BrainNeed | null | undefined) => (n ? `${n.difficulty[0]}${n.confidence[0]}${n.missing.length ? `:${n.missing.join(",")}` : ""}` : null);
export const planAheadDigest = (p: PlanAhead | null | undefined) => (p ? `${p.goal.slice(0, 15)}|${p.steps[0] ?? ""}${p.changedBecause ? "|変" : ""}` : null);

// ── ③ 材料の時刻と出所・食い違い（設計の案 §9・BRAIN_MATERIAL_PROVENANCE 既定 off）──────────────────
//   まとめ（全体の分析＝戦略の層）は古いことがある。一次の記録（customer-state の段階・送った記録）と食い違う所だけ決まった計算で拾い、
//   「食い違い: …」の1行で渡す。どちらを正にするかはブレイン（P0）。
export const materialProvenanceOn = (env: Env = envOf()) => on(env.BRAIN_MATERIAL_PROVENANCE);
export const MATERIAL_PROVENANCE_RULE = `【材料の古さ】まとめ（全体の分析・セーブポイント・要約）は最大72時間古い。今の会話・送った記録の新しい事実と食い違ったら、新しい事実・元の事実を正にする。【材料の食い違い】の行があれば、どちらを正にしたかを判断に反映する。`;

/** customer-state の段階 → 全体の分析の段階（checkpoint_stage）の粗い対応 */
const STAGE_GROUP: Record<string, string | null> = {
  first: "hearing", searching: "hearing", proposing: "proposing", interested: "proposing", estimate_sent: "proposing",
  viewing_arranging: "viewing", viewing_scheduled: "viewing", viewed: "viewing", apply_prep: "applying", applying: "applying", won: "contract", dropped: null,
};
const STAGE_JA: Record<string, string> = { hearing: "ヒアリング", proposing: "提案中", viewing: "内覧", applying: "申込", contract: "契約" };
export type ConflictKind = "stage" | "sent";
export type MaterialConflicts = { kinds: ConflictKind[]; line: string; strategyAgeH: number | null };

export function detectMaterialConflicts(input: {
  strategyStage?: string | null; strategyAt?: string | null; strategyNextStep?: string | null;
  stateStage?: string | null; stateStageLabel?: string | null;
  rooms?: ReadonlyArray<{ sentByUs: boolean; firstAt: string; name: string }>; nowMs?: number;
}): MaterialConflicts {
  const now = input.nowMs ?? Date.now();
  const atMs = input.strategyAt ? Date.parse(input.strategyAt) : NaN;
  const strategyAgeH = Number.isFinite(atMs) ? Math.max(0, Math.round((now - atMs) / 3_600_000)) : null;
  const kinds: ConflictKind[] = []; const parts: string[] = [];
  const mapped = input.stateStage ? STAGE_GROUP[input.stateStage] ?? null : null;
  const ss = (input.strategyStage ?? "").trim();
  if (ss && mapped && ss !== mapped && STAGE_JA[ss]) {
    kinds.push("stage"); parts.push(`段階（まとめ=${STAGE_JA[ss]}・記録=${input.stateStageLabel || STAGE_JA[mapped]}）`);
  }
  if (Number.isFinite(atMs) && /ピックアップ|物件.{0,6}送|property_send|オススメ/.test(input.strategyNextStep ?? "")) {
    const after = (input.rooms ?? []).filter((r) => r.sentByUs && Date.parse(r.firstAt) > atMs);
    if (after.length) { kinds.push("sent"); parts.push(`送った件数（まとめの次の手=物件を送る・まとめの後に${after.length}件送った記録）`); }
  }
  const age = strategyAgeH != null ? `【材料の時刻】全体の分析: ${strategyAgeH}時間前に作った物` : "";
  const line = [age, parts.length ? `【材料の食い違い】${parts.join("／")}` : ""].filter(Boolean).join("\n");
  return { kinds, line, strategyAgeH };
}
export const conflictDigest = (c: MaterialConflicts | null | undefined) => (c && c.kinds.length ? c.kinds.join(",") : null);

// ── 潜在意識と要点（KB P1「お客様の潜在意識と要点を読む部分を6つで強化」①②・どちらも既定 off・記録だけ）─────────────
//   ① 3段（表の質問→奥の心配→何が満たされれば安心するか）を判断の前に出す。② key_topics から「一番の要点」を1つ選ぶ（作業員6の ComposeIntent.main が受ける）
// 2026-11-04 統括役（試験を組にまとめる・need と同じく「判断の後」の形に揃える）: =after は出力の一番最後の振り返りの欄（判断を引っ張らない）。=on は旧の位置
const modeOf = (v: string | undefined): "off" | "on" | "after" => { const x = (v ?? "").trim().toLowerCase(); return x === "after" ? "after" : x === "on" ? "on" : "off"; };
export const threeLayerMode = (env: Env = envOf()) => modeOf(env.BRAIN_THREE_LAYER);
export const mainPointMode = (env: Env = envOf()) => modeOf(env.BRAIN_MAIN_POINT);
export const threeLayerOn = (env: Env = envOf()) => threeLayerMode(env) !== "off";
export const mainPointOn = (env: Env = envOf()) => mainPointMode(env) !== "off";
export type ThreeLayer = { surface: string; worry: string; relief: string };
export const BRAIN_THREE_LAYER_RULES = `【3段で考える（three_layer）】判断の前に、お客様の今の番を3段で読む: surface＝表の質問・依頼（お客様の言葉に近く）／worry＝奥の心配（会話・記録から読める物だけ・創作しない）／relief＝何が満たされれば安心するか（こちらが出せる物で）。例: 「初期費用15万くらいの物件ないですか」→ worry「予算が足りるか不安・今の候補が高いと感じている」→ relief「割引で15万に収まる物件と、収まる理由」。読めない段は ""。AIX・返信の判断と key_topics はこの relief に沿わせる。`;
export const BRAIN_THREE_LAYER_RULES_AFTER = `【振り返り（three_layer・判断の後に書く）】判断を全部書き終えた後で、お客様の今の番を3段で振り返る: surface＝表の質問・依頼／worry＝奥の心配（会話・記録から読める物だけ・創作しない）／relief＝何が満たされれば安心するか（こちらが出せる物で）。読めない段は ""。この振り返りで判断を変えない。`;
export const BRAIN_MAIN_POINT_RULES_AFTER = `【振り返り（main_point・判断の後に書く）】key_topics を書き終えた後で、その中から一番伝えるべき1つを、そのままの言葉で main_point に書く（返信の主役の1文になる）。key_topics が空なら null。この振り返りで key_topics を変えない。`;
export const BRAIN_THREE_LAYER_FIELD = `"three_layer": {"surface": "表の質問（30字以内）", "worry": "奥の心配（40字以内）", "relief": "何が満たされれば安心するか（40字以内）"}`;
export const BRAIN_MAIN_POINT_RULES = `【一番の要点（main_point）】key_topics の中から、この番で一番伝えるべき1つを選び、そのままの言葉で main_point に書く（返信の主役の1文になる）。key_topics が空なら null。`;
export const BRAIN_MAIN_POINT_FIELD = `"main_point": "key_topics の中の1つ（そのままの言葉）または null"`;
export function normalizeThreeLayer(raw: unknown): ThreeLayer | null {
  if (!raw || typeof raw !== "object") return null;
  const o = raw as Record<string, unknown>;
  const t = { surface: clip(o.surface, 40), worry: clip(o.worry, 50), relief: clip(o.relief, 50) };
  return t.surface || t.worry || t.relief ? t : null;
}
/** key_topics の中の1つに寄せる（無い言葉は捨てる＝創作の要点を作らない） */
export function normalizeMainPoint(raw: unknown, keyTopics: ReadonlyArray<string> | null | undefined): string | null {
  if (nullish(raw)) return null;
  const v = clip(raw, 60); const kt = (keyTopics ?? []).map((x) => String(x));
  return kt.find((x) => x === v) ?? kt.find((x) => x.includes(v) || v.includes(x)) ?? null;
}
export const threeLayerDigest = (t: ThreeLayer | null | undefined) => (t && t.worry ? t.worry.slice(0, 20) : null);
