// app/lib/customer-pref-learning.ts
// お客様ごとのこだわりの倍率（customer-pref-weights.ts）を **毎週の学習に組み込む** ための純関数（DB・ネット・LLM に触れない）。
//
// 2026-09-29 竹内「（お客様ごとの採点の倍率を毎週の学習に）組み込む」「ここは DeepSeek で分析できるかな？ 物件検索ブレイン（DeepSeek）の部分が分析する形」
//
// ■ 形（毎週・日曜 20:40 UTC＝月曜 JST 5:40・/api/cron/scoring-pref-learning・重みの学習 scoring-learning の 30分後）
//   ① 今まで送った物件から材料（回）を作り直す（customer-pref-learning-server.loadPrefEpisodes＝scripts/build-customer-pref-episodes と同じ組み立て）
//   ② 古い 7割で倍率の表を学び、新しい 3割で当て直す（customer-pref-weights.backtestPrefWeights・決定論・費用 0）
//   ③ 良くなった時だけ表を更新する（decidePrefApply）: 改善が線 0.01 以上・悪くなる帯が無い・通す／保留が変わる候補 0件・3位以内が下がらない。
//      良くならなければ表はそのまま（空のまま）。鍵 CUSTOMER_PREF_LEARNING_AUTO_APPLY（既定 on＝竹内さんの「組み込む」・off＝提案だけ）
//   ④ 更新した時は 前の表・後の表・数字 を scoring_pref_learning_runs と scoring_pref_weights（版）に残す（前の版に戻せる）
//   ⑤ 安全の決まりは customer-pref-weights のまま（AD は弱めない・加点だけ・上限 2倍・10回以上かつ 8人以上・帯・通す／保留）
//
// ■ DeepSeek で「読む」部分（数字は決定論のまま・文を読む材料だけ任せる。物件の判断と同じ口 vision-alt-provider.callDeepSeekRead＝推論なし・温度0・
//   失敗は同じ前置きで1回だけ読み直し・Claude に倒さない。名札 pref_read_customer／pref_read_appeal／pref_hypothesis／pref_weekly_summary）
//   1. お客様のこだわりの強さ（条件の欄＋申込前の発言・仮名化）→ 条件の種類ごとに 絶対／できれば／触れただけ／言っていない
//      決定論（customerStrength）と並べて記録し、当て直しは **両方** で回す（どちらが良いか比べられる）。判定に使うのは決定論の方（今まで通り）
//   2. スタッフが訴求した点（🌟の本文・AIX 物件ピックアップの文）→ 決まった一覧から複数選択
//   3. 👑 と違う物件を選んだ理由の仮説（👑 と選んだ物の札と資料の文字）→ 決まった一覧から差になった項目（自由文は1行）
//   4. 週のまとめ（数字＋仮説 → 10行以内の日本語・記録の表だけ・グループには送らない）
//   前置き（固定の説明・一覧）を先頭に置き、動く部分は後ろ（DeepSeek の先頭一致キャッシュ）。読んだ物は scoring_pref_reads に鍵で残し、
//   同じ材料は二度読まない。週の費用の上限（weeklyBudgetUsd）と時間の上限を超えたら止める（残りは次の週）
//   申込以降の会話・画像・本人確認書類は渡さない（post-apply.deepseekSafeCutoff の線・線が引けない会話は読まない）。お客様の名前・電話等は仮名化

import { PREF_WEIGHT_CONFIG, isPrefFamily, type PrefWeightTable, type PrefBacktest, type PrefLevel } from "./customer-pref-weights";
import { FAMILY_JA, type StrengthLevel } from "./recommend-score-drift";

export const PREF_LEARNING_CONFIG = {
  /** 材料の期間（送付は 2026-08-14〜なので全期間） */
  days: 400,
  /** 1週の DeepSeek の費用の上限（USD・公式料金・ピーク2倍込み）。超えたら読むのを止める（残りは次の週） */
  weeklyBudgetUsd: 1.0,
  /** 1週に読む件数の上限（種類ごと。新しい回から） */
  maxReads: { customer: 40, appeal: 40, hypothesis: 30 } as Record<ReadKind, number>,
  /** DeepSeek を回す時間の上限（cron の 300秒に収める） */
  llmTimeBudgetMs: 100_000,
  /** 同時に投げる数 */
  concurrency: 3,
  readTimeoutMs: 20_000,
  maxTokens: { customer: 400, appeal: 160, hypothesis: 260, summary: 700 } as Record<ReadKind | "summary", number>,
  /** 1人の発言をいくつまで渡すか（新しい方から）・文字数 */
  maxMessages: 30,
  maxMessageChars: 1_800,
  /** 判定に読む表のキャッシュ */
  cacheMs: 10 * 60_000,
} as const;

export type ReadKind = "customer" | "appeal" | "hypothesis";

// ─── 費用 ────────────────────────────────────────────────────────────────────

/** deepseek-flash の公式料金（USD/M・scripts/audit-llm-unnamed.ts と同じ） */
export const DEEPSEEK_FLASH_USD_PER_M = { input: 0.15, cacheHit: 0.003, output: 0.6 } as const;
/** DeepSeek のピーク（平日 UTC 01-04・06-10＝JST 10-13・15-19）は2倍 */
export function isDeepseekPeak(iso: string): boolean {
  const d = new Date(iso);
  if (!Number.isFinite(d.getTime())) return false;
  const h = d.getUTCHours(), w = d.getUTCDay();
  return w >= 1 && w <= 5 && ((h >= 1 && h < 4) || (h >= 6 && h < 10));
}
export function estimateDeepSeekUsd(u: { input: number; cacheHit: number; output: number }, atIso: string): number {
  const miss = Math.max(0, (u.input ?? 0) - (u.cacheHit ?? 0));
  const usd = (miss * DEEPSEEK_FLASH_USD_PER_M.input + (u.cacheHit ?? 0) * DEEPSEEK_FLASH_USD_PER_M.cacheHit + (u.output ?? 0) * DEEPSEEK_FLASH_USD_PER_M.output) / 1e6;
  return +(usd * (isDeepseekPeak(atIso) ? 2 : 1)).toFixed(8);
}
/** まだ読んでよいか（使った分が上限未満） */
export function budgetAllows(spentUsd: number, limitUsd: number = PREF_LEARNING_CONFIG.weeklyBudgetUsd): boolean {
  return Number.isFinite(spentUsd) && spentUsd < limitUsd;
}

// ─── 自動で表を更新する ─────────────────────────────────────────────────────

/**
 * 良くなった時だけ自動で表を更新するか（環境変数 CUSTOMER_PREF_LEARNING_AUTO_APPLY）。
 *   既定 on（2026-09-29 竹内「組み込む」＝良くなった時だけ表を更新する所まで自動）。off／0／false で「提案だけ」（版は proposed で残す）
 */
export const PREF_AUTO_APPLY_DEFAULT_ON = true;
export function prefAutoApplyEnabled(env: Record<string, string | undefined> = process.env): boolean {
  const v = String(env.CUSTOMER_PREF_LEARNING_AUTO_APPLY ?? "").trim().toLowerCase();
  if (v === "off" || v === "0" || v === "false") return false;
  if (v === "on" || v === "1" || v === "true") return true;
  return PREF_AUTO_APPLY_DEFAULT_ON;
}

/**
 * 表を更新するか。当て直しの判定（backtestPrefWeights.decision＝改善 0.01 以上・悪い帯なし・通す／保留の変化 0・3位以内が下がらない・確かめ用 20回以上）が
 *   「使う」で、学んだ変更が 1つ以上ある時だけ。enabled=false なら proposed で残すだけ
 */
export function decidePrefApply(input: { enabled: boolean; backtest: Pick<PrefBacktest, "decision" | "learned" | "gain" | "verdictFlips"> }): { apply: boolean; propose: boolean; reason: string } {
  const bt = input.backtest;
  if (!bt.learned.changes.length) return { apply: false, propose: false, reason: bt.decision.reason };
  if (!bt.decision.enable) return { apply: false, propose: false, reason: bt.decision.reason };
  if (!input.enabled) return { apply: false, propose: true, reason: `提案だけ（CUSTOMER_PREF_LEARNING_AUTO_APPLY が off）: ${bt.decision.reason}` };
  return { apply: true, propose: true, reason: bt.decision.reason };
}

/** DB から読んだ表の形を確かめる（壊れていれば null＝表なし）。AD・条件でない家族は捨てる。倍率は minMult〜maxMult に押し込む */
export function sanitizePrefTable(raw: unknown, cfg = PREF_WEIGHT_CONFIG): PrefWeightTable | null {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return null;
  const out: PrefWeightTable = {};
  for (const [f, lv] of Object.entries(raw as Record<string, unknown>)) {
    if (!/^[a-z_:0-9]{2,40}$/.test(f)) return null;
    if (!lv || typeof lv !== "object" || Array.isArray(lv)) return null;
    if (!isPrefFamily(f)) continue;
    const row: Partial<Record<PrefLevel, number>> = {};
    for (const [k, v] of Object.entries(lv as Record<string, unknown>)) {
      if (k !== "strong" && k !== "stated") return null;
      if (typeof v !== "number" || !Number.isFinite(v)) return null;
      row[k] = Math.min(cfg.maxMult, Math.max(cfg.minMult, Math.round(v * 100) / 100));
    }
    if (Object.keys(row).length) out[f] = row;
  }
  return out;
}

export type PrefTableDiff = { family: string; level: PrefLevel; from: number; to: number };
/** 前の表 → 後の表 で変わった所（記録・戻す時の材料） */
export function diffPrefTables(before: PrefWeightTable | null | undefined, after: PrefWeightTable | null | undefined): PrefTableDiff[] {
  const out: PrefTableDiff[] = [];
  const fams = new Set([...Object.keys(before ?? {}), ...Object.keys(after ?? {})]);
  for (const f of [...fams].sort()) for (const lv of ["strong", "stated"] as const) {
    const a = before?.[f]?.[lv] ?? 1, b = after?.[f]?.[lv] ?? 1;
    if (Math.abs(a - b) > 1e-9) out.push({ family: f, level: lv, from: a, to: b });
  }
  return out;
}

// ─── 鍵（同じ材料は二度読まない） ───────────────────────────────────────────

/** 短いハッシュ（djb2・16進）。node の部品を使わない（純関数） */
export function inputHash(s: string): string {
  let h = 5381;
  for (let i = 0; i < s.length; i++) h = ((h * 33) ^ s.charCodeAt(i)) >>> 0;
  let g = 2166136261;
  for (let i = 0; i < s.length; i++) { g ^= s.charCodeAt(i); g = Math.imul(g, 16777619) >>> 0; }
  return h.toString(16).padStart(8, "0") + g.toString(16).padStart(8, "0");
}

// ─── ① お客様のこだわりの強さ（DeepSeek） ───────────────────────────────────

/** DeepSeek に選ばせる条件の種類（recommend-score-drift.codeFamily の家族と同じ鍵） */
export const LLM_FAMILIES: ReadonlyArray<{ key: string; ja: string }> = [
  "rent", "initial_cost", "floor_plan", "walk", "age", "size", "area", "commute", "move_in", "pet",
  "equip:bath_toilet", "equip:washbasin", "equip:autolock", "equip:delivery_box", "equip:floor2", "equip:net_free", "equip:parking",
  "equip:bath_dryer", "equip:south", "equip:corner", "equip:laundry_in", "equip:reheating", "equip:counter_kitchen", "equip:structure", "equip:elevator",
].map((key) => ({ key, ja: FAMILY_JA[key] ?? key }));
const LLM_FAMILY_SET = new Set(LLM_FAMILIES.map((f) => f.key));

export const LLM_STRENGTH_LEVELS = ["absolute", "prefer", "mentioned", "none"] as const;
export type LlmStrengthLevel = (typeof LLM_STRENGTH_LEVELS)[number];
/** DeepSeek の4段 → 判定の3段（絶対＝strong・できれば／触れただけ＝stated・言っていない＝none） */
export function llmLevelToStrength(l: LlmStrengthLevel | null | undefined): StrengthLevel {
  return l === "absolute" ? "strong" : l === "prefer" || l === "mentioned" ? "stated" : "none";
}

const familyListText = LLM_FAMILIES.map((f) => `${f.key}=${f.ja}`).join("、");

/** 固定の前置き（毎週・毎人同じ＝先頭一致のキャッシュ） */
export const STRENGTH_SYSTEM = [
  "あなたは賃貸のお部屋探しの会話を読む係です。お客様1人の【条件の欄】と【申込前の発言】から、条件の種類ごとに「こだわりの強さ」を判定します。",
  "条件の種類（鍵=意味）: " + familyListText,
  "強さの4段: absolute=絶対（必須・NG・譲れない・何度も言う）／prefer=できれば（希望として書いた・1〜2回言った）／mentioned=触れただけ（質問や雑談で1回）／none=言っていない",
  "決まり: 書いていない・言っていない種類は none。推測で足さない。強い言い方（絶対・必須・NG・不可・無理・だけは）や言い直し・繰り返しは absolute。",
  "出力は JSON だけ: {\"levels\":{\"rent\":\"prefer\",\"equip:bath_toilet\":\"absolute\",...}}。none の種類は書かなくてよい。説明文は書かない。",
].join("\n");

const STRENGTH_FIELD_JA: ReadonlyArray<[string, string]> = [
  ["rent_max", "家賃の上限"], ["max_rent", "家賃の上限"], ["rent_min", "家賃の下限"], ["floor_plan", "間取り"], ["layout", "間取り"], ["walk_minutes", "駅徒歩（分）"],
  ["building_age", "築年（年以内）"], ["floor_area_min", "広さ（㎡以上）"], ["desired_area", "エリア"], ["initial_cost_limit", "初期費用の上限"],
  ["commute_station", "通勤先"], ["commute_minutes", "通勤（分）"], ["pet", "ペット"], ["move_in_time", "入居時期"], ["preferences", "希望（自由文）"],
  ["other_requests", "その他（自由文）"], ["additional_conditions", "追加の条件"], ["raw_format_text", "記入フォーマット"], ["ng_points", "NG"],
];

/**
 * 動く部分（お客様1人）。mask は仮名化（pii-mask.maskPII 等）。発言は新しい方から maxMessages 通・maxMessageChars 字まで。
 *   条件の欄は STRENGTH_FIELD_JA の欄だけ（名前・電話・メール等の欄は渡さない）
 */
export function buildStrengthUser(input: { conditions: Record<string, unknown> | null | undefined; messages: ReadonlyArray<string>; mask: (s: string) => string; cfg?: typeof PREF_LEARNING_CONFIG }): string {
  const cfg = input.cfg ?? PREF_LEARNING_CONFIG;
  const c = input.conditions ?? {};
  const lines: string[] = [];
  for (const [k, ja] of STRENGTH_FIELD_JA) {
    const v = c[k];
    if (v == null || v === "" || v === false) continue;
    const s = typeof v === "boolean" ? "あり" : String(v).replace(/\s+/g, " ").trim();
    if (!s) continue;
    lines.push(`- ${ja}: ${input.mask(s).slice(0, 300)}`);
  }
  const msgs: string[] = [];
  let chars = 0;
  for (const m of [...input.messages].reverse()) {
    const s = input.mask(String(m ?? "")).replace(/\s+/g, " ").trim();
    if (!s) continue;
    if (msgs.length >= cfg.maxMessages || chars + s.length > cfg.maxMessageChars) break;
    msgs.unshift(`- ${s.slice(0, 200)}`);
    chars += Math.min(200, s.length);
  }
  return `【条件の欄】\n${lines.length ? lines.join("\n") : "（記入なし）"}\n【申込前の発言（古い順）】\n${msgs.length ? msgs.join("\n") : "（発言なし）"}`;
}

/** 返事 → 条件の種類 → 4段（一覧に無い鍵・段は捨てる。levels が無ければ null） */
export function parseStrengthReply(text: string): Record<string, LlmStrengthLevel> | null {
  const body = String(text ?? "").match(/\{[\s\S]*\}/)?.[0];
  if (!body) return null;
  let j: { levels?: unknown };
  try { j = JSON.parse(body); } catch { return null; }
  if (!j || typeof j !== "object" || !j.levels || typeof j.levels !== "object" || Array.isArray(j.levels)) return null;
  const out: Record<string, LlmStrengthLevel> = {};
  for (const [k, v] of Object.entries(j.levels as Record<string, unknown>)) {
    if (!LLM_FAMILY_SET.has(k)) continue;
    if (typeof v !== "string" || !(LLM_STRENGTH_LEVELS as readonly string[]).includes(v)) continue;
    if (v !== "none") out[k] = v as LlmStrengthLevel;
  }
  return out;
}

/** DeepSeek の強さ → customer-pref-weights の StrengthMap（家族 → strong/stated/none） */
export function strengthMapFromLlm(levels: Record<string, LlmStrengthLevel> | null | undefined): Record<string, StrengthLevel> {
  const out: Record<string, StrengthLevel> = {};
  for (const [k, v] of Object.entries(levels ?? {})) out[k] = llmLevelToStrength(v);
  return out;
}

// ─── ② スタッフが訴求した点（DeepSeek） ─────────────────────────────────────

export const APPEAL_ITEMS: ReadonlyArray<{ key: string; ja: string }> = [
  { key: "rent", ja: "家賃の安さ・予算内" }, { key: "initial_cost", ja: "初期費用の安さ・敷礼0・フリーレント" }, { key: "station_near", ja: "駅近・徒歩" },
  { key: "commute", ja: "通勤・アクセス" }, { key: "new_build", ja: "築浅・新築・リノベ" }, { key: "spacious", ja: "広さ・帖数" }, { key: "layout", ja: "間取り" },
  { key: "area", ja: "エリア・立地" }, { key: "equipment", ja: "設備全般（オートロック・宅配ボックス・浴室乾燥 等）" }, { key: "bath_toilet", ja: "バス・トイレ別" },
  { key: "washbasin", ja: "独立洗面台" }, { key: "floor2", ja: "2階以上・階数" }, { key: "sunny", ja: "南向き・日当たり" }, { key: "pet", ja: "ペット可" },
  { key: "move_in", ja: "入居時期・すぐ入れる" }, { key: "ad", ja: "AD・広告料（社内向け）" }, { key: "surroundings", ja: "周辺環境・買い物" }, { key: "quiet", ja: "静か・構造" },
  { key: "other", ja: "その他" },
];
const APPEAL_SET = new Set(APPEAL_ITEMS.map((a) => a.key));

export const APPEAL_SYSTEM = [
  "あなたは賃貸の営業の文を読む係です。スタッフがお客様に物件を送った時の文から「何を推したか（訴求した点）」を一覧から選びます。",
  "一覧（鍵=意味）: " + APPEAL_ITEMS.map((a) => `${a.key}=${a.ja}`).join("、"),
  "決まり: 文に書いてある推しだけ選ぶ（複数可）。物件名や数字の羅列だけで推していない項目は選ばない。無ければ空の配列。",
  "出力は JSON だけ: {\"appeals\":[\"rent\",\"station_near\"]}。説明文は書かない。",
].join("\n");

export function buildAppealUser(texts: ReadonlyArray<string>, mask: (s: string) => string): string {
  const body = texts.map((t) => mask(String(t ?? "")).replace(/\s+/g, " ").trim()).filter(Boolean).map((t) => t.slice(0, 700));
  return `【送った文】\n${body.length ? body.map((t, i) => `(${i + 1}) ${t}`).join("\n") : "（文なし）"}`;
}

export function parseAppealReply(text: string): string[] | null {
  const body = String(text ?? "").match(/\{[\s\S]*\}/)?.[0];
  if (!body) return null;
  let j: { appeals?: unknown };
  try { j = JSON.parse(body); } catch { return null; }
  if (!j || !Array.isArray(j.appeals)) return null;
  return [...new Set((j.appeals as unknown[]).filter((x): x is string => typeof x === "string" && APPEAL_SET.has(x)))];
}

// ─── ③ 👑 と違う物件を選んだ理由の仮説（DeepSeek） ──────────────────────────

export const DIFF_ITEMS: ReadonlyArray<{ key: string; ja: string }> = [
  ...LLM_FAMILIES,
  { key: "ad", ja: "AD・利益（社内の事情）" }, { key: "photo", ja: "写真・資料の見た目（内装・外観）" }, { key: "already_sent", ja: "送付済み・同じ建物" },
  { key: "availability", ja: "募集状況（申込あり・商談中）" }, { key: "unknown", ja: "分からない" },
];
const DIFF_SET = new Set(DIFF_ITEMS.map((d) => d.key));

export const HYPOTHESIS_SYSTEM = [
  "あなたは賃貸のお部屋探しの採点を点検する係です。採点で1位だった物件（👑）ではなく、スタッフが別の物件をお客様に送った回について、「差になった項目」を一覧から選びます。",
  "一覧（鍵=意味）: " + DIFF_ITEMS.map((d) => `${d.key}=${d.ja}`).join("、"),
  "決まり: 2つの物件の資料の文字と採点の理由、お客様のこだわりを見比べ、スタッフの選択を説明できる項目だけ選ぶ（多くて3つ）。分からなければ unknown。自由文は1行・40字以内。",
  "出力は JSON だけ: {\"items\":[\"walk\",\"size\"],\"note\":\"駅近と広さを優先したと読める\"}。",
].join("\n");

export type HypothesisSide = { name: string; facts: string; reasons: ReadonlyArray<string>; score: number | null };
export type HypothesisInput = { crown: HypothesisSide; chosen: HypothesisSide; strength: Record<string, StrengthLevel> };

const sideText = (label: string, s: HypothesisSide, mask: (x: string) => string) =>
  `【${label}】${mask(s.name).slice(0, 60)}${s.score != null ? `（${s.score}点）` : ""}\n資料: ${mask(s.facts).replace(/\s+/g, " ").trim().slice(0, 500) || "（読めない）"}\n採点の理由: ${s.reasons.slice(0, 12).join("・") || "（なし）"}`;

export function buildHypothesisUser(h: HypothesisInput, mask: (s: string) => string): string {
  const st = Object.entries(h.strength).filter(([, v]) => v !== "none").map(([k, v]) => `${FAMILY_JA[k] ?? k}=${v === "strong" ? "絶対" : "希望"}`).join("・") || "（書いていない）";
  return `【お客様のこだわり】${st}\n${sideText("採点の1位（👑・送らなかった）", h.crown, mask)}\n${sideText("スタッフが送った物件", h.chosen, mask)}`;
}

export function parseHypothesisReply(text: string): { items: string[]; note: string } | null {
  const body = String(text ?? "").match(/\{[\s\S]*\}/)?.[0];
  if (!body) return null;
  let j: { items?: unknown; note?: unknown };
  try { j = JSON.parse(body); } catch { return null; }
  if (!j || !Array.isArray(j.items)) return null;
  const items = [...new Set((j.items as unknown[]).filter((x): x is string => typeof x === "string" && DIFF_SET.has(x)))].slice(0, 3);
  const note = typeof j.note === "string" ? j.note.replace(/\s+/g, " ").trim().slice(0, 60) : "";
  return { items: items.length ? items : ["unknown"], note };
}

// ─── ④ 週のまとめ ───────────────────────────────────────────────────────────

export type WeeklyNumbers = {
  weekOf: string;
  rounds: number; customers: number; train: number; holdout: number;
  base: { relRank: number; top1: number; top3: number; top10: number };
  weighted: { relRank: number; top1: number; top3: number; top10: number };
  gain: number;
  changes: ReadonlyArray<{ family: string; level: PrefLevel; from: number; to: number; rounds: number }>;
  skipped: ReadonlyArray<{ family: string; level: PrefLevel; rounds: number; reason: string }>;
  worseBands: ReadonlyArray<{ band: string; value: string; gain: number; n: number }>;
  verdictFlips: { toPass: number; toHold: number };
  decision: string;
  applied: boolean;
  /** DeepSeek の強さで当て直した時の改善（無ければ null） */
  llmGain: number | null;
  strengthAgree: { compared: number; agree: number } | null;
  appealTop: ReadonlyArray<[string, number]>;
  hypothesisTop: ReadonlyArray<[string, number]>;
  reads: { customer: number; appeal: number; hypothesis: number; usd: number };
};

const pct = (x: number) => `${Math.round(x * 100)}%`;
const f3 = (x: number) => x.toFixed(3);

/** DeepSeek 抜きのまとめ（費用 0・読めなかった週もこれを残す） */
export function deterministicWeeklySummary(n: WeeklyNumbers): string {
  const lines: string[] = [];
  lines.push(`■ お客様ごとの倍率の学習（${n.weekOf.slice(0, 10)}）: 回 ${n.rounds}・お客様 ${n.customers}人・学ぶ ${n.train}／確かめ ${n.holdout}`);
  lines.push(`確かめ用: 相対順位 ${f3(n.base.relRank)} → ${f3(n.weighted.relRank)}（${n.gain >= 0 ? "+" : ""}${f3(n.gain)}）・👑一致 ${pct(n.base.top1)} → ${pct(n.weighted.top1)}・10位以内 ${pct(n.base.top10)} → ${pct(n.weighted.top10)}`);
  lines.push(n.changes.length ? `学んだ表: ${n.changes.map((c) => `${FAMILY_JA[c.family] ?? c.family}×${c.level} ×${c.from}→×${c.to}（${c.rounds}回）`).join("・")}` : "学んだ表: 変更なし（学べる条件×強さが無い・または動かしても順位が変わらない）");
  if (n.worseBands.length) lines.push(`悪くなる帯: ${n.worseBands.map((b) => `${b.band}=${b.value} ${b.gain}（${b.n}回）`).join("・")}`);
  if (n.verdictFlips.toPass + n.verdictFlips.toHold) lines.push(`通す／保留が変わる候補: 保留→通す ${n.verdictFlips.toPass}・通す→保留 ${n.verdictFlips.toHold}`);
  lines.push(`判定: ${n.applied ? "表を更新した" : "表はそのまま"} — ${n.decision}`);
  if (n.llmGain != null) lines.push(`DeepSeek の強さで当て直し: 改善 ${n.llmGain >= 0 ? "+" : ""}${f3(n.llmGain)}（決定論 ${n.gain >= 0 ? "+" : ""}${f3(n.gain)}）${n.strengthAgree ? `・強さの一致 ${n.strengthAgree.agree}/${n.strengthAgree.compared}` : ""}`);
  // 一覧の意味は「家賃の安さ・予算内」「設備全般（オートロック・…）」の形なので、括弧を落としてから最初の語だけ（dry で「設備全般（オートロック 5」と出た）
  const shortJa = (ja: string | undefined, k: string) => (ja ?? k).replace(/（[^）]*）?/g, "").split("・")[0];
  if (n.appealTop.length) lines.push(`スタッフの訴求（多い順）: ${n.appealTop.slice(0, 6).map(([k, c]) => `${shortJa(APPEAL_ITEMS.find((a) => a.key === k)?.ja, k)} ${c}`).join("・")}`);
  if (n.hypothesisTop.length) lines.push(`👑と違う物を選んだ差（仮説・多い順）: ${n.hypothesisTop.slice(0, 6).map(([k, c]) => `${shortJa(DIFF_ITEMS.find((d) => d.key === k)?.ja, k)} ${c}`).join("・")}`);
  lines.push(`DeepSeek: 強さ ${n.reads.customer}人・訴求 ${n.reads.appeal}回・仮説 ${n.reads.hypothesis}回・$${n.reads.usd.toFixed(4)}`);
  return lines.slice(0, 10).join("\n");
}

export const SUMMARY_SYSTEM = [
  "あなたは不動産会社の社内向けの短い報告を書く係です。物件の採点（お客様ごとのこだわりの倍率）の週1回の学習の結果（数字）と仮説を、人が読める日本語にまとめます。",
  "決まり: 10行以内・1行 60字以内・敬体・数字は渡された物だけ使う（作らない）・「良くなった／変わらない／悪くなる帯がある」を最初の行で言い切る・最後の行に次にやることを1つ。",
  "出力は本文だけ（見出し記号・JSON・前置きは書かない）。",
].join("\n");

export function buildSummaryUser(n: WeeklyNumbers): string {
  return `【数字（決定論）】\n${deterministicWeeklySummary(n)}`;
}

/** 返事 → 10行以内・600字以内の本文（空なら null） */
export function parseSummaryReply(text: string): string | null {
  const lines = String(text ?? "").replace(/```[a-z]*\n?|```/g, "").split(/\r?\n/).map((s) => s.trim()).filter(Boolean).slice(0, 10);
  const out = lines.join("\n").slice(0, 600).trim();
  return out.length >= 10 ? out : null;
}

// ─── 決定論と DeepSeek の強さを比べる ────────────────────────────────────────

export type StrengthCompare = { customers: number; compared: number; agree: number; llmHigher: number; detHigher: number; byFamily: Record<string, { compared: number; agree: number }> };
const LV = { none: 0, stated: 1, strong: 2 } as const;

/** お客様ごとの 決定論の強さ × DeepSeek の強さ（両方ある人だけ・一覧の家族だけ）。一致・どちらが強いかを数える */
export function compareStrengthSources(rows: ReadonlyArray<{ det: Record<string, StrengthLevel> | null; llm: Record<string, StrengthLevel> | null }>): StrengthCompare {
  const out: StrengthCompare = { customers: 0, compared: 0, agree: 0, llmHigher: 0, detHigher: 0, byFamily: {} };
  for (const r of rows) {
    if (!r.det || !r.llm) continue;
    out.customers++;
    for (const f of LLM_FAMILIES) {
      const a = r.det[f.key] ?? "none", b = r.llm[f.key] ?? "none";
      if (a === "none" && b === "none") continue;
      out.compared++;
      const bf = (out.byFamily[f.key] ??= { compared: 0, agree: 0 });
      bf.compared++;
      if (a === b) { out.agree++; bf.agree++; }
      else if (LV[b] > LV[a]) out.llmHigher++; else out.detHigher++;
    }
  }
  return out;
}

/** 件数の多い順（訴求・仮説の集計） */
export function topCounts(lists: ReadonlyArray<ReadonlyArray<string>>, n = 8): Array<[string, number]> {
  const m = new Map<string, number>();
  for (const l of lists) for (const k of l) m.set(k, (m.get(k) ?? 0) + 1);
  return [...m].sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0])).slice(0, n);
}
