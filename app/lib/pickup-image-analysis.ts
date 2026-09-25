// app/lib/pickup-image-analysis.ts（純関数・DB/DeepSeek 依存なし）
// 「🔍 画像で分析」: 物件資料の事実（文字層＋切り出した間取り図から読んだ物）とお客様の希望を照らし、点と「要確認」を出す。
//
// 2026-09-24 竹内「画像で分析ボタンを付ける。お客さんの要望【水回りの判断・キッチンの判断・リビングと洋室の位置関係・
//   収納（WIC 等）】を判断できる。トリミングした画像の中で一番条件に合った物件がわかる」
// 2026-09-24 強化（竹内「希望条件や NG 条件の細かい部分も画像から判断できているか」）: 希望は image-wants.ts が W1… で集め、
//   点はモデルに付けさせず checks から決定論で出す（scoreChecksDetail・NG と必須は2倍・必須に ng なら20点が上限）
// 2026-09-24 作り直し（竹内「2つの型を使ってプロンプトキャッシュを効かせる」「必要な所だけを切り出して読ませる。表の文字は文字層から」
//   「物件と一致しているか。食い違いは点を出さず『要確認』」「物件ごとに保存し、2回目以降は画像を読み直さない（希望との照合は文字だけ）」）:
//   以前: 資料1ページ全体の画像＋希望を1回で DeepSeek（推論 low）に渡し、希望ごとの ok/ng も画像から答えさせていた
//         （1件 0.2〜1円・出力 1,700〜10,540 で上限 12000 に迫った・希望が変わるたびに画像を読み直す）
//   今:   画像から読むのは物件の事実だけ（sheet-read-server・型ごとの固定の前置き・推論なし・物件ごとに保存）。
//         希望との照合はここで文字だけ・決まった手順（sheet-facts.matchWantsWithFacts）。決まらない希望だけ文字で1回聞く（judgeWantsByText）
import { scoreChecksDetail, type ImageWant, type WantCheck } from "./image-wants";
import { checkSheetConsistency, describeFacts, matchWantsWithFacts, parseSummaryFacts, type SheetConsistency, type SheetTextFacts } from "./sheet-facts";
import type { SheetImageFacts } from "./sheet-prompt";
import { okCountOf } from "./pickup-best";

export type PickupImageAnalysis = {
  water: string;        // 水回り（バス・トイレ別／独立洗面台／浴室乾燥 等）
  kitchen: string;      // キッチン（対面/壁付け・IH/ガス・口数）
  layout: string;       // 間取りとリビング・洋室の関係（帖数）
  storage: string;      // 収納（WIC・収納の数）
  match: number | null; // 希望への合い具合 0〜100（checks から決定論で。要確認・判定できる希望が無ければ null）
  match_raw?: number | null; // 必須 NG の上限（20）をかける前の点（同点の並べ替えに使う）
  must_fail?: boolean;       // 必須・NG 条件に当たった
  ok_count?: number;         // 「合う」の数（同点の並べ替えに使う）
  good: string[];       // 希望に合う点
  concern: string[];    // 希望に合わない・気になる点
  checks: WantCheck[];  // 希望1つずつの判定（W1…）
  /** 物件と資料・読んだ間取り図が一致しているか（要確認なら点を出さない） */
  review?: SheetConsistency;
  /**
   * 2026-09-25 竹内「読み取り必ず DeepSeek で」: DeepSeek が2回とも答えなかった所（"間取り図"・"希望の照合"）。
   * Claude では埋めない。保存していないので 🔍 画像で分析（次の回）で DeepSeek が読み直す
   */
  read_failed?: string[];
  /** 資料の型・切り出し・保存した読み取り（画面の小さな注記と、2回目以降の引き当て） */
  sheet?: {
    type: string; type_by: string; crop_mode: string | null; crop_basis: string | null; crop_reason: string | null;
    facts_id: number | null; source: string; prompt_version: string; see: string | null;
  };
};

/**
 * 事実と希望から分析結果を作る。
 *   - 説明文・文字層・読んだ間取り図が食い違えば review=要確認・match=null（点を出さない）。照合は文字層だけで行い画像の事実は使わない
 *   - llmChecks: 決まった手順で決まらなかった希望（undecided）を文字で聞いた答え
 * 文字層も画像の事実も無ければ null（読めない）
 */
export function buildPickupAnalysis(input: {
  wants: ImageWant[];
  text: SheetTextFacts;
  image: SheetImageFacts | null;
  summary?: string | null;
  llmChecks?: WantCheck[];
  /** DeepSeek が2回とも答えなかった所（image＝間取り図・wantIds＝文字の照合で聞けなかった希望） */
  unread?: { image?: boolean; wantIds?: string[] };
}): PickupImageAnalysis | null {
  const { wants, text, image } = input;
  if (!text.hasText && !image) return null;
  const review = checkSheetConsistency({ summary: input.summary ?? null, text, image });
  const trusted = review.status === "ok" ? image : null;
  const fm = matchWantsWithFacts(wants, text, trusted, parseSummaryFacts(input.summary).madori);
  const llm = new Map((review.status === "ok" ? input.llmChecks ?? [] : []).map((c) => [c.id, c]));
  const unreadIds = new Set(input.unread?.wantIds ?? []);
  const checks: WantCheck[] = [...fm.checks];
  // 読み取れなかった希望は「分からない」のまま（点に入らない）・理由に印を書く
  for (const id of fm.undecided) checks.push(llm.get(id) ?? { id, result: "unknown", why: unreadIds.has(id) ? `${UNREAD_WHY}` : "" });
  const order = new Map(wants.map((w, i) => [w.id, i]));
  checks.sort((a, z) => (order.get(a.id) ?? 99) - (order.get(z.id) ?? 99));
  const detail = wants.length ? scoreChecksDetail(wants, checks) : { score: null, raw: null, mustFail: false };
  const byId = new Map(wants.map((w) => [w.id, w]));
  const good = checks.filter((c) => c.result === "ok").map((c) => byId.get(c.id)?.text ?? "").filter(Boolean).slice(0, 4);
  const readFailed = [
    ...(input.unread?.image ? ["間取り図"] : []),
    ...(unreadIds.size && fm.undecided.some((id) => unreadIds.has(id)) ? ["希望の照合"] : []),
  ];
  const concern = [
    ...(review.status === "要確認" ? ["要確認（物件と資料が一致しない）"] : []),
    ...(readFailed.length ? [`要確認（${readFailed.join("・")}を${UNREAD_LABEL}・🔍 で読み直す）`] : []),
    ...checks.filter((c) => c.result === "ng").map((c) => byId.get(c.id)?.text ?? ""),
  ].filter(Boolean).slice(0, 4);
  const d = describeFacts(text, trusted);
  const out: PickupImageAnalysis = {
    ...d,
    match: review.status === "要確認" ? null : detail.score,
    match_raw: review.status === "要確認" ? null : detail.raw,
    must_fail: detail.mustFail,
    ok_count: checks.filter((c) => c.result === "ok").length,
    good, concern, checks, review,
    ...(readFailed.length ? { read_failed: readFailed } : {}),
  };
  return out;
}

/** 「読み取れなかった」の印（vision-alt-provider の DEEPSEEK_READ_FAILED_LABEL と同じ語。純関数のファイルなので import しない） */
export const UNREAD_LABEL = "読み取れなかった";
const UNREAD_WHY = `${UNREAD_LABEL}（DeepSeek）`;

/** 旧: 条件欄をまとめた文（画面の表示用に残す） */
export function buildWantsText(c: Record<string, unknown> | null | undefined, staffNote?: string | null): string {
  const parts: string[] = [];
  const add = (label: string, v: unknown) => { const s = String(v ?? "").trim(); if (s) parts.push(`${label}: ${s}`); };
  if (c) {
    add("間取り", c.floor_plan ?? c.layout);
    add("こだわり", c.preferences);
    add("NG", c.ng_points);
    add("その他の希望", c.other_requests);
    add("追加条件", c.additional_conditions);
  }
  add("スタッフのメモ", staffNote);
  return parts.join("\n");
}

/**
 * 一番合う物件（match が最大）。match が1件も無ければ null。
 * 同点は 上限前の点（match_raw）→「合う」の数が多い方（2026-09-24 竹内「前回の反証で出た点も直す」: 判定できた希望が1つだけで 100点の物件が、
 *   5つ合って 100点の物件より上に来る事があった）→ 元の順位
 */
export function pickBest<T extends { id: number; rank: number; analysis: PickupImageAnalysis | null }>(rows: T[]): T | null {
  const scored = rows.filter((r) => r.analysis?.match != null);
  if (!scored.length) return null;
  return scored.slice().sort((a, z) => (z.analysis!.match! - a.analysis!.match!)
    || ((z.analysis!.match_raw ?? 0) - (a.analysis!.match_raw ?? 0))
    || (okCountOf(z.analysis) - okCountOf(a.analysis))
    || (a.rank - z.rank))[0];
}
