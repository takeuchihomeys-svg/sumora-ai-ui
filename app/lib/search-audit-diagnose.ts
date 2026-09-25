// app/lib/search-audit-diagnose.ts
// 検索の点検の見立て（DeepSeek だけ・Claude に倒さない）。決定論の点検（search-audit-check.ts）で怪しいと出た回だけ、
// 「どこで・なぜ・どう直すか」を1回だけ聞く。
//
// 2026-09-25 竹内「DeepSeek の API で行う。そうすればずっと拡張ツール側も成長していく。問題や読み取れていない部分が分かる」
// 決まり:
//   ・callDeepSeekRead（deepseek-flash・推論なし・温度0・max 400・20秒・答えが崩れたら同じ前置きで1回だけ読み直す）。action = search_audit
//   ・固定の前置き（SEARCH_AUDIT_SYSTEM_PROMPT）を先頭・その回の材料（札・差分・段の最後30件・件数）を後ろ＝前置きキャッシュが当たる形
//   ・お客様の名前・電話は材料に入れない（customer_snapshot に元から無い・自由記述は拡張で数字を伏せ済み）
//   ・推測で DOM の名前（クラス名・name 属性）を作らせない（前置きで禁止・答えの where は「ファイルと関数」まで）
import { callDeepSeekRead } from "@/app/lib/vision-alt-provider";
import { DEEPSEEK_FLASH_MODEL } from "@/app/lib/llm-alt-provider";
import { parseMan, type AuditCheck, type AuditResult, type AuditStep, type Filled, type FormReadback, type Intended } from "@/app/lib/search-audit-check";

export const SEARCH_AUDIT_ACTION = "search_audit";
// v2（2026-09-25）: 本番の通し確認で「賃料の上限2万・件数表示0件（本当の0件）」を DeepSeek が「駅と地域の入れ方のずれ・徒歩が入っていない」と読んだ
//   → ①お客様の賃料の上限を材料に足す ②件数表示が0で条件どおりに入っている時は「条件が厳しい」を先に疑う、を前置きに1行 ③読み戻せなかった欄を「入った=なし」と書かない
export const SEARCH_AUDIT_PROMPT_VERSION = "search-audit-v2";

/** 固定の前置き（毎回一字一句同じ＝キャッシュが当たる。変えたら SEARCH_AUDIT_PROMPT_VERSION も上げる） */
export const SEARCH_AUDIT_SYSTEM_PROMPT = `あなたは不動産の物件検索を自動で行う Chrome 拡張「AIXLINX 物件検索」の不具合を調べる係です。
拡張がブレインモードで1人のお客様の条件を検索サイトに入れて検索した1回分の記録を読み、「ちゃんと検索できていたか」「お客様の条件とずれていないか」を見立てます。

【3つの検索サイトは表記が別物（混ぜない）】
- リアプロ（realpro）: 路線の内部名は「大阪市高速軌道御堂筋線」の形。popup.js の STATION_LINE_MAP / LINE_ROUTE_MAP（route_id）/ ROUTE_LINE_MAP（モーダルの表示名）と page-script.js。
- itandi: 路線は「高速電気軌道第1号線(大阪メトロ御堂筋線)」「JR京都線」の形。popup.js の ITANDI_LINE_MAP_FILL と itandi-page-script.js（路線ごとに駅の一覧が切り替わる）。
- レインズ（reins）: 路線は「大阪メトロ御堂筋線」の形。popup.js の REINS_LINE_MAP と reins-page-script.js（入力欄は番号で指す）。
例: 同じ御堂筋線でもサイトごとに名前が違う。ある駅が「その路線に無い」と出たら、駅と路線の対応表（どのサイトの表か）を疑う。

【拡張の流れとファイルの地図】
1. background.js: 一括検索（_runBatchSearch・手動の一括 axlx-manual-bulk-search）→ _batchAutofill がサイトのタブに axlx-switch-customer を送る。
2. popup.js: お客様の条件から検索の条件（conditions）を作る（場所の解決: 駅名→路線、地名→市区、area_mode=station/ward）。更新日は rp-update-days.js。
3. page-script.js（リアプロ）/ itandi-page-script.js / reins-page-script.js: 画面のフォームに入れて検索ボタンを押し、fill-done（完了の合図）を返す。
   content.js / itandi-content.js が fill-done を background に中継する。
4. bulk-dl.js（リアプロ）/ itandi-bulk-dl.js: 結果の一覧を読み、ブレインの判定の後に送る。全部読み終えたら axlx-batch-customer-done（ページ数・読んだ行数・送った数）。
5. background.js の _scrapeAndSendRealpro: 完了の合図を待つ（リアプロ90秒・itandi245秒・結果は無進捗5分）。

【札（決定論の点検が付けた物）】
STATION_MISSING 駅のボタンが見つからない／ROUTE_MISSING 路線が選べない／AREA_UNRESOLVED 地名を場所に直せない／
LOCATION_MODE 駅と地域の入れ方の食い違い・場所なし検索・条件を外した検索／CONDITION_MISREAD お客様の条件を検索に入れていない／
RENT_MISMATCH 賃料の上限が入らない・狭い／FLOOR_PLAN_DROPPED 間取りが入らない／UPDATE_DAYS 更新日が入らない・決まりと違う／
RESET_FAILED 前の条件を消せない／UI_NOT_FOUND 画面の部品が見つからない／ZERO_UNCONFIRMED 0件だが本当に0件か確かめられない／
ZERO_CONFIRMED 0件（件数表示も0）／SENT_LT_READ 送れる物件を送り切れない／STALLED 途中で止まった／ERROR_* 失敗。

【答え方】
- 賃料は円と万円が混ざらないよう、どちらも万円に直して並べている。
- 札が ZERO_CONFIRMED（件数表示も0）で、入れた条件がお客様の条件どおりに入っている時は、検索のずれより「お客様の条件が厳しい」を先に疑う（is_genuine_zero=true にして、どの条件が厳しいかを書く）。
- 「（読み戻しなし）」はその欄を画面から読めなかった印で、入らなかったという意味ではない。
- 材料に書いてあることだけから考える。推測で DOM の名前（クラス名・name 属性・id）やサイトの画面の作りを作らない。分からない所は「分からない」と書く。
- where はファイル名と関数名まで（上の地図の名前から選ぶ。無ければ function は空文字）。
- is_genuine_zero: 本当に条件に合う物件が0件だったと思えるなら true、検索のずれ・失敗が原因なら false、判断できなければ null。
- cause_key_suggest: 決定論の原因の鍵が粗すぎる・違う時だけ、同じ形（種類:サイト:…）で1つ提案（なければ空文字）。
- JSON だけを返す（前後に文を付けない）:
{"cause_ja":"原因を1〜2文","where":{"file":"ファイル名","function":"関数名"},"fix_ja":"直し方を1〜3文","cause_key_suggest":"","is_genuine_zero":null,"confidence":0.0}`;

export type SearchAuditDiagnosis = {
  cause_ja: string;
  where: { file: string; function: string };
  fix_ja: string;
  cause_key_suggest: string;
  is_genuine_zero: boolean | null;
  confidence: number;
};

export type DiagnoseMaterial = {
  site: string | null;
  trigger?: string | null;
  mode?: string | null;
  is_wide?: boolean | null;
  area_mode?: string | null;
  checks: AuditCheck[];
  intended?: Intended | null;
  filled?: Filled | null;
  steps?: AuditStep[] | null;
  result?: AuditResult | null;
  error?: string | null;
  customer_area?: string | null;
  customer_area_mode?: string | null;
  /** お客様の賃料の上限（万円・customer_snapshot の rent_max/max_rent から）。2026-09-25 v2 */
  customer_rent_max_man?: number | null;
};

function short(v: unknown, n = 200): string {
  if (v == null) return "なし";
  const s = Array.isArray(v) ? v.slice(0, 20).join("・") + (v.length > 20 ? `…（全${v.length}）` : "") : typeof v === "object" ? JSON.stringify(v) : String(v);
  return s.slice(0, n);
}

/** intended と filled の差分（見る欄だけ・純関数） */
export function intendedFilledDiff(i: Intended | null | undefined, f: Filled | null | undefined): string[] {
  const lines: string[] = [];
  const form = f?.form ?? null;
  // 賃料はサイトごとに単位が違う（リアプロは円・itandi とレインズは万円）→ 両方を万円に直して並べる
  //   （2026-09-25 本番の確かめで、itandi の「8」（＝8万円）を DeepSeek が「80000 が 8 と誤入力」と読み違えた）
  const man = (v: unknown) => { const n = parseMan(v); return n == null ? v : `${n}万円`; };
  // 読み戻しは「画面にその入力欄があった時だけ」欄を持つ（page-script の _readRealproForm・itandi の _itReadForm は if (x !== undefined) f.walk = x）。
  //   欄が無い＝読めなかった → 「入った=なし」と書くと DeepSeek が「徒歩が入っていない」と読む（2026-09-25 本番の確かめ）→「（読み戻しなし）」
  const pairs: Array<[string, unknown, keyof FormReadback, ((v: unknown) => unknown)?]> = [
    ["賃料上限", man(i?.rent_max), "rent_max", man],
    ["賃料下限", man(i?.rent_min), "rent_min", man],
    ["更新日", i?.rp_update_days, "update_days"],
    ["徒歩", i?.walk_minutes, "walk"],
    ["築年数", i?.building_age, "age"],
    ["間取り", i?.floor_plan, "layouts"],
    ["駅", i?.station_names, "stations"],
    ["路線", i?.itandi_lines ?? i?.route_ids ?? i?.reins_line, "lines"],
    ["市区", i?.ward_names ?? i?.city_codes ?? i?.detail_ward, "wards"],
  ];
  for (const [k, a, fk, conv] of pairs) {
    const read = !!form && Object.prototype.hasOwnProperty.call(form, fk);
    const b = read ? (conv ? conv(form![fk]) : form![fk]) : undefined;
    if (a == null && b == null) continue;
    lines.push(`${k}: 入れようとした=${short(a)} ／ 入った=${read ? short(b) : "（読み戻しなし）"}`);
  }
  if (f?.stations_missing?.length) lines.push(`押せなかった駅: ${f.stations_missing.slice(0, 8).map((m) => `${m.name}${m.line ? `（${m.line}）` : ""}${m.label_count != null ? `[ラベル${m.label_count}${m.sample?.length ? `・例 ${m.sample.slice(0, 5).join("/")}` : ""}]` : ""}`).join("、")}`);
  if (f?.lines_missing?.length) lines.push(`選べなかった路線: ${f.lines_missing.slice(0, 6).map((m) => m.name).join("、")}`);
  if (f?.click_fails?.length) lines.push(`押せなかった部品: ${f.click_fails.slice(0, 6).map((c) => `${c.what}:${c.text ?? ""}`).join("、")}`);
  if (f?.reset_fail) lines.push(`リセットの失敗: ${f.reset_fail}`);
  if (f?.fallback) lines.push(`条件を外した検索: ${f.fallback}`);
  if (f?.area_path) lines.push(`場所の入れ方（画面側の判定）: ${f.area_path}`);
  if (f && f.search_clicked != null) lines.push(`検索ボタン: ${f.search_clicked ? "押した" : "押せなかった"}`);
  if (i?.unknown_tokens?.length) lines.push(`場所に直せなかった言葉: ${i.unknown_tokens.join("・")}`);
  return lines;
}

/** その回の材料（前置きの後ろに付ける・純関数） */
export function buildDiagnoseUserText(m: DiagnoseMaterial): string {
  const steps = (m.steps ?? []).slice(-30).map((s) => `${s.k}${s.d ? ` ${String(s.d).slice(0, 100)}` : ""}`);
  const r = m.result ?? {};
  return [
    `【この回】サイト=${m.site ?? "?"} 起動=${m.trigger ?? "?"} モード=${m.mode ?? "?"} 広げて=${m.is_wide ? "はい" : "いいえ"} 場所の入れ方=${m.area_mode ?? "?"}`,
    `お客様の希望エリア=${short(m.customer_area, 160)}（お客様の設定=${m.customer_area_mode ?? "?"}）${m.customer_rent_max_man != null ? ` お客様の賃料上限=${m.customer_rent_max_man}万円` : ""}`,
    `【札】`,
    ...m.checks.slice(0, 12).map((c) => `- ${c.code}（${c.severity}）${c.title}: ${c.detail}`),
    `【入れようとした条件と入った値】`,
    ...intendedFilledDiff(m.intended, m.filled),
    `【結果】ページ数=${r.pages ?? "?"} 読んだ行=${r.read_rows ?? "?"} 送れる行=${r.sendable_rows ?? "?"} 送った=${r.sent_count ?? "?"} 0件と決めた理由=${r.zero_reason ?? "なし"} 件数表示=${r.count_text ?? "読めない"}${m.error ? ` 失敗=${String(m.error).slice(0, 200)}` : ""}`,
    `【段（最後の30件）】`,
    ...steps,
  ].join("\n");
}

/** 答えの JSON を読む（崩れていれば null・純関数） */
export function parseDiagnosis(text: string): SearchAuditDiagnosis | null {
  const s = String(text ?? "").trim().replace(/^```(?:json)?\s*/i, "").replace(/```\s*$/, "");
  const a = s.indexOf("{"), b = s.lastIndexOf("}");
  if (a < 0 || b <= a) return null;
  let j: Record<string, unknown>;
  try { j = JSON.parse(s.slice(a, b + 1)); } catch { return null; }
  if (typeof j.cause_ja !== "string" || !j.cause_ja.trim()) return null;
  const w = (j.where && typeof j.where === "object" ? j.where : {}) as Record<string, unknown>;
  const conf = Number(j.confidence);
  const gz = j.is_genuine_zero;
  return {
    cause_ja: String(j.cause_ja).slice(0, 400),
    where: { file: String(w.file ?? "").slice(0, 80), function: String(w.function ?? "").slice(0, 80) },
    fix_ja: String(j.fix_ja ?? "").slice(0, 500),
    cause_key_suggest: String(j.cause_key_suggest ?? "").slice(0, 120),
    is_genuine_zero: gz === true ? true : gz === false ? false : null,
    confidence: Number.isFinite(conf) ? Math.max(0, Math.min(1, conf)) : 0,
  };
}

export type DiagnoseOutcome = {
  diagnosis: SearchAuditDiagnosis | null;
  failed: boolean;
  attempts: number;
  usage: { input: number; output: number; cacheHit: number };
  model: string | null;
};

/** DeepSeek に1回（崩れたら1回だけ読み直し）。Claude には倒さない */
export async function diagnoseSearchAudit(m: DiagnoseMaterial, opts?: { runId?: string | null }): Promise<DiagnoseOutcome> {
  const user = buildDiagnoseUserText(m);
  // 2026-09-25 反証: 読み直すのは「答えが崩れた」時だけ。20秒の待ち切れ（応答なし）は同じ原因で呼び直しても同じ（費用と時間だけ増える）→ 読み直さない
  const read = await callDeepSeekRead(SEARCH_AUDIT_SYSTEM_PROMPT, user, { maxTokens: 400, timeoutMs: 20_000, model: DEEPSEEK_FLASH_MODEL }, parseDiagnosis,
    { retryIf: (elapsedMs) => elapsedMs < 18_000 });
  const usage = { input: 0, output: 0, cacheHit: 0 };
  for (const a of read.attempts) {
    usage.input += a.res?.usage.input ?? 0;
    usage.output += a.res?.usage.output ?? 0;
    usage.cacheHit += a.res?.usage.cacheHit ?? 0;
    // 使用量を llm_usage_logs に（action=search_audit で分ける）
    void import("@/app/lib/llm-usage-recorder").then(({ recordAltUsage }) => recordAltUsage({
      model: a.res?.model ?? DEEPSEEK_FLASH_MODEL, action: SEARCH_AUDIT_ACTION, conversationId: null,
      usage: { input_tokens: Math.max(0, (a.res?.usage.input ?? 0) - (a.res?.usage.cacheHit ?? 0)), output_tokens: a.res?.usage.output ?? 0, cache_read_input_tokens: a.res?.usage.cacheHit ?? 0 },
      status: a.res ? 200 : 0, errorType: a.ok ? null : (a.res ? "empty_or_unparsable" : "no_response"),
      durationMs: a.ms, sysHead: `【検索の点検${a.retry ? "・読み直し" : ""}】${SEARCH_AUDIT_PROMPT_VERSION}${opts?.runId ? ` ${opts.runId}` : ""}`, sysKeyFull: null, maxTokens: 400,
    })).catch(() => {});
  }
  return { diagnosis: read.value, failed: read.failed, attempts: read.attempts.length, usage, model: read.res?.model ?? null };
}
