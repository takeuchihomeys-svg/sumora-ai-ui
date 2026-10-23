// app/lib/final-check-flash.ts — 最終チェックの「指揮官 Claude＋FLASH の下確かめ」（スイッチ FINAL_CHECK_FLASH・既定 off＝今のまま1文字も変わらない）
//
// 2026-10-22 竹内さんの決定（KB a6dff652）:「最終チェックのブレインの部分もこのような構造にしたら費用も抑えられるし、質も上がるのでは？」
//   「最終チェックの部分がボトルネックにならないように」
//   → 指揮官は Claude のまま（148d59dd④ 質の線）・FLASH が項目ごとに分担して同時に下確かめ・Claude は挙がった所だけ見て直すか決め、最後の合否を出す。
//   申込以降・審査の事情は Claude だけ。今の最終チェックと試験で比べ、質が同じ以上の時だけ切り替える。並列にして返信までの時間を延ばさない。
//   つながる決定: 0210e013（pro 司令塔＋flash）・c0884407 P0（安いモデルはパーツに分けて読み、つなぎと優先順位を強く）・2804f1de（flash は flash の考え方）
//
// 形（この順・どこで失敗しても今の Claude だけの3パスに戻る＝fail-safe）:
//   ① 決定論の検査（今のまま・無料）
//   ② 入口: 自動送信・センシティブ・申込以降・会話の記録が読めない・審査の事情・入力に個人の値 → 使わない（今の3パス）
//   ③ FLASH の下確かめを同時に（伏せた最小の材料だけ・1項目1問の短い指示・温度0・推論なし・硬い時間切れ）
//        rules（会社の決まり・禁止語）／facts（金額・日付・曜日・物件名・号室・空きが材料と合うか）／asks（答えの抜け）／
//        aix（スタッフしか知らない事＝AIX の番を返信で言い切っていないか）／company（会社の事実に反していないか・材料がある時だけ）
//   ④ 指揮官 Claude: 挙がった候補だけを、伏せない材料と照らして「本当の問題か」を決める（短い指示）。
//      候補が0・全項目が完走・低リスク（下の lowRiskForSkip・保守的）の時だけ Claude を呼ばない
//   ⑤ 時間切れ・失敗・個人の値の網に当たった項目が1つでもある → 今の3パス（Claude だけ）に戻す
//
// 個人情報: FLASH（DeepSeek）には伏せた文だけ（名前→お客様・申込の欄の値→伏せ字・電話/メール→伏せ字）。伏せた後に
//   piiValueSignal／altPiiSignal の網が当たったら、その番は FLASH を使わず全部 Claude（迷ったら Claude）。指揮官 Claude には伏せない材料を渡す。
// ここは純関数＋呼び出しの口（callFlash は差し替え可＝テストで fetch を出さない）。組み込みは final-check.ts runFinalCheck。
// テスト: app/lib/__tests__/final-check-flash.test.ts

import { maskPII } from "./pii-mask";
import { maskApplicationValuesForAlt, altPiiSignal } from "./alt-pii-gate";
import { piiValueSignal } from "./test-pii-guard";
import { screeningSensitiveSignal } from "./screening-sensitive";

export type Env = Record<string, string | undefined>;
const envOf = (): Env => (typeof process !== "undefined" ? process.env : {});

/** FINAL_CHECK_FLASH=on の時だけ（既定 off） */
export function finalCheckFlashOn(env: Env = envOf()): boolean {
  const v = (env.FINAL_CHECK_FLASH ?? "").trim().toLowerCase();
  return v === "on" || v === "1" || v === "true";
}
/** 候補0・低リスクで Claude を呼ばない（既定 on・FINAL_CHECK_FLASH_SKIP=off で必ず指揮官を呼ぶ） */
export function finalCheckFlashSkipOn(env: Env = envOf()): boolean {
  return (env.FINAL_CHECK_FLASH_SKIP ?? "").trim().toLowerCase() !== "off";
}
/** FLASH の硬い時間切れ（既定 4500ms・1500〜8000）。flash（推論なし）は 1.1〜1.6秒（vision-alt-provider の実測）＝待ちの尾を作らない線 */
export const FINAL_CHECK_FLASH_TIMEOUT_DEFAULT_MS = 4500;
export function finalCheckFlashTimeoutMs(env: Env = envOf()): number {
  const n = Number((env.FINAL_CHECK_FLASH_TIMEOUT_MS ?? "").trim());
  if (!Number.isFinite(n) || n <= 0) return FINAL_CHECK_FLASH_TIMEOUT_DEFAULT_MS;
  return Math.max(1500, Math.min(8000, Math.floor(n)));
}
export const FINAL_CHECK_FLASH_MODEL = "deepseek-flash";
export const FINAL_CHECK_FLASH_MAX_TOKENS = 500;
export const FINAL_CHECK_FLASH_VERSION = "fc-flash-2026-10-23";

// ─── ② 入口 ─────────────────────────────────────────────────────────────
/** runFinalCheckGated が ctx に載せる（無い＝check-reply 等の別の入口＝使わない・fail-closed） */
export type FlashGateInput = {
  autoSendConversation?: boolean;
  sensitive?: boolean;
  postApply?: boolean;
  stateUnknown?: boolean;
};
export type FlashEligibilityInput = {
  gate: FlashGateInput | null | undefined;
  isAutoSend?: boolean;
  phaseKey?: string | null;
  conversationStage?: string | null;
  /** 判断に使う元の文（お客様の最新・会話・材料）。審査の事情・個人の値の網をかける */
  rawTexts: ReadonlyArray<string | null | undefined>;
};
const POST_APPLY_PHASE = new Set(["applying", "closed_won"]);
const POST_APPLY_STAGE_RE = /申込|審査|契約|重説|鍵渡し|入居済|成約/;
export function flashEligibility(p: FlashEligibilityInput): { ok: boolean; reason: string | null } {
  const g = p.gate;
  if (!g) return { ok: false, reason: "入口の判定なし（generate-reply 以外）" };
  if (p.isAutoSend || g.autoSendConversation) return { ok: false, reason: "自動送信（3パス完走が関所）" };
  if (g.sensitive) return { ok: false, reason: "センシティブ" };
  if (g.postApply) return { ok: false, reason: "申込以降（Claude だけ）" };
  if (g.stateUnknown) return { ok: false, reason: "会話の記録が読めない" };
  if (p.phaseKey && POST_APPLY_PHASE.has(p.phaseKey)) return { ok: false, reason: `段階 ${p.phaseKey}（Claude だけ）` };
  if (p.conversationStage && POST_APPLY_STAGE_RE.test(p.conversationStage)) return { ok: false, reason: `段階「${p.conversationStage.slice(0, 12)}」（Claude だけ）` };
  const all = p.rawTexts.filter(Boolean).join("\n");
  const scr = screeningSensitiveSignal(all);
  if (scr) return { ok: false, reason: `審査の事情（${scr.word}）` };
  const pii = piiValueSignal(all) ?? altPiiSignal(all);
  if (pii) return { ok: false, reason: `個人の値（${pii}）` };
  return { ok: true, reason: null };
}

// ─── 伏せる ─────────────────────────────────────────────────────────────
/** FLASH に渡す前の伏せ字（名前→お客様・申込の欄の値・電話・メール）。部屋番号・物件名・金額は照らすのに要るので残す（個人の値ではない） */
export function maskForFlash(text: string | null | undefined, names: ReadonlyArray<string | null | undefined>): string {
  const t = String(text ?? "");
  if (!t) return "";
  return maskApplicationValuesForAlt(maskPII(t, [...names]));
}

// ─── ③ 下確かめ（FLASH） ──────────────────────────────────────────────────
export type FlashSubKey = "rules" | "facts" | "asks" | "aix" | "company";
export const FLASH_SUB_KEYS: ReadonlyArray<FlashSubKey> = ["rules", "facts", "asks", "aix", "company"];

/** final-check.ts が組んで渡す材料（伏せない元の文。FLASH 向けはここで伏せる・指揮官には元のまま） */
export type FlashMaterials = {
  draft: string;
  lastCustomer: string;
  /** 直近の会話（6通・formatHistory の形） */
  history: string;
  /** 確認済みの事実・スタッフの材料・資料の値・登録条件をまとめた物 */
  facts: string;
  /** [COMPANY_FACTS]（今回お客様が聞いた会社の事実。無ければ空＝company は呼ばない） */
  companyFacts: string;
  /** 会社の決まり（selectRulesForCheckCached の text）＋最終チェック専用ルール */
  rules: string;
  /** ブレインが読んだお客様の質問 */
  customerQuestions: string[];
  /** 今の日時（JST の文字） */
  now: string;
  /** 伏せる名前（お客様の名前・呼び名・連名者） */
  names: string[];
};

const OUT_SPEC = `出力は JSON だけ: {"hits":[{"code":"…","evidence":"…","why":"…"}]}
・evidence は【返信】からそのまま写した短い引用（言い換え禁止）。asks だけは【お客様の最新】からの引用。
・確かな根拠が無い時・問題が無い時は {"hits":[]}。迷ったら挙げない（挙げた物は上の係がもう一度見る）。
・why は1文（何と食い違うか）。`;

/** 項目ごとの指示（短く・1項目1問・最後に一番大事な事＝flash の考え方 2804f1de） */
export const FLASH_SYSTEM: Record<FlashSubKey, string> = {
  rules: `あなたは不動産会社の LINE 返信の下確かめ係（会社の決まりの係）。
【返信】が【決まり】のどれかに「はっきり」反する所だけを挙げる。文体の好み・言い回しの改善は挙げない。
code: BANNED_WORD（禁止の語を使った）／RULE_VIOLATION（決まりの文にはっきり反する）／AIX_BOUNDARY_DB（「【線引き】」の決まりの事実を返信が自分で言い切った）
${OUT_SPEC}
why には反した決まりの文を短く写す。`,
  facts: `あなたは不動産会社の LINE 返信の下確かめ係（事実の係）。
【返信】に書いた金額・日付・曜日・時刻・物件名・号室・空き状況・入居日のうち、【材料】【会話】【お客様の最新】のどこにも無い物・食い違う物だけを挙げる。
お客様自身が書いた言葉の復唱・こちらの担当者の名乗りは問題ではない。日付と曜日の組は【今の日時】と照らす。
code: FABRICATED_AMOUNT／FABRICATED_DATE／FABRICATED_PROPERTY／FABRICATED_AVAILABILITY／TIME_INVALID（日付と曜日・時刻が合わない）
${OUT_SPEC}`,
  asks: `あなたは不動産会社の LINE 返信の下確かめ係（答えの抜けの係）。
【お客様の最新】に書かれた問い・依頼のうち、【返信】が答えていない・触れていない物だけを挙げる。お礼・了承・あいさつは問いではない。
【ブレインが読んだ質問】があればそれも照らす。返信が「確認してご連絡します」と受けていれば触れている。
code: MISSED_QUESTION
${OUT_SPEC}`,
  aix: `あなたは不動産会社の LINE 返信の下確かめ係（返信か AIX かの係）。
スタッフしか知らない事（管理会社に確認して分かった事・募集状況・交渉の結果・見積の金額や内訳・内覧の日時の確定・待ち合わせの住所や時刻・入居可能日・申込の必要書類の一覧）を、
【材料】【会話】に無いのに【返信】が言い切っている所だけを挙げる。「確認いたします」「お送りします」など宣言・予告だけは問題ではない。
code: AIX_BOUNDARY_ESTIMATE／AIX_BOUNDARY_VIEWING／AIX_BOUNDARY_MEETING／AIX_BOUNDARY_PROPERTY／AIX_BOUNDARY_APPLICATION／AIX_BOUNDARY_MOVEIN
${OUT_SPEC}`,
  company: `あなたは不動産会社の LINE 返信の下確かめ係（会社の事実の係）。
【会社の事実】に反する断定を【返信】がしている所だけを挙げる。会社の事実に書いていない事は挙げない。
code: COMPANY_FACT_CONTRADICTION
${OUT_SPEC}`,
};
export const FLASH_CODES: Record<FlashSubKey, ReadonlySet<string>> = {
  rules: new Set(["BANNED_WORD", "RULE_VIOLATION", "AIX_BOUNDARY_DB"]),
  facts: new Set(["FABRICATED_AMOUNT", "FABRICATED_DATE", "FABRICATED_PROPERTY", "FABRICATED_AVAILABILITY", "TIME_INVALID"]),
  asks: new Set(["MISSED_QUESTION"]),
  aix: new Set(["AIX_BOUNDARY_ESTIMATE", "AIX_BOUNDARY_VIEWING", "AIX_BOUNDARY_MEETING", "AIX_BOUNDARY_PROPERTY", "AIX_BOUNDARY_APPLICATION", "AIX_BOUNDARY_MOVEIN"]),
  company: new Set(["COMPANY_FACT_CONTRADICTION"]),
};

/** 項目ごとの最小の材料（伏せた後）。返信は最後（一番近い所＝flash が持ちきれる位置） */
export function flashUser(k: FlashSubKey, m: FlashMaterials): string {
  const mk = (s: string) => maskForFlash(s, m.names);
  const draft = `【返信】\n${mk(m.draft)}`;
  const cust = `【お客様の最新】\n${mk(m.lastCustomer) || "（なし）"}`;
  switch (k) {
    case "rules":
      // 決まりは会社共通（個人の値なし）。先頭に置いて前置きキャッシュを効かせる
      return `【決まり】\n${m.rules || "（なし）"}\n\n${draft}`;
    case "facts":
      return `【今の日時】${m.now}\n\n【材料】\n${mk(m.facts) || "（なし）"}\n\n【会話】\n${mk(m.history) || "（なし）"}\n\n${cust}\n\n${draft}`;
    case "asks":
      return `${cust}\n\n【ブレインが読んだ質問】\n${m.customerQuestions.length ? m.customerQuestions.map((q) => `- ${mk(q)}`).join("\n") : "（なし）"}\n\n${draft}`;
    case "aix":
      return `【材料】\n${mk(m.facts) || "（なし）"}\n\n【会話】\n${mk(m.history) || "（なし）"}\n\n${cust}\n\n${draft}`;
    case "company":
      return `【会社の事実】\n${m.companyFacts}\n\n${cust}\n\n${draft}`;
  }
}

export type FlashHit = { key: FlashSubKey; code: string; evidence: string; why: string };
const norm = (s: string) => String(s ?? "").normalize("NFKC").replace(/\s+/g, "");

/** FLASH の答えを読む（読めない形は null＝失敗＝今の3パスに戻す）。code の外れ・引用が本文に無い物は捨てる */
export function parseFlashOut(k: FlashSubKey, text: string, maskedDraft: string, maskedCustomer: string): FlashHit[] | null {
  const s = String(text ?? "").replace(/^```(?:json)?\s*|\s*```$/g, "").trim();
  const i = s.indexOf("{"), j = s.lastIndexOf("}");
  if (i < 0 || j <= i) return null;
  let o: unknown;
  try { o = JSON.parse(s.slice(i, j + 1)); } catch { return null; }
  const hits = (o as { hits?: unknown }).hits;
  if (!Array.isArray(hits)) return null;
  const dN = norm(maskedDraft), cN = norm(maskedCustomer);
  const out: FlashHit[] = [];
  for (const h of hits) {
    if (!h || typeof h !== "object") continue;
    const code = String((h as { code?: unknown }).code ?? "").trim();
    const evidence = String((h as { evidence?: unknown }).evidence ?? "").trim();
    const why = String((h as { why?: unknown }).why ?? "").trim();
    if (!FLASH_CODES[k].has(code) || !evidence) continue;
    const src = k === "asks" ? cN : dN;
    if (!src.includes(norm(evidence))) continue;
    out.push({ key: k, code, evidence: evidence.slice(0, 200), why: why.slice(0, 200) });
  }
  return out;
}

export type FlashCallResult = { text: string; usage: { input: number; output: number; cacheHit: number }; model: string } | null;
export type FlashCaller = (system: string, user: string, opts: { model: string; maxTokens: number; timeoutMs: number }) => Promise<FlashCallResult>;

export type FlashSubLog = { key: FlashSubKey; ok: boolean; ms: number; usd: number; hits: number; error?: string; skipped?: string };
export type FlashOutcome = {
  /** 全項目が完走した（false＝今の3パスに戻す） */
  ok: boolean;
  fallbackReason: string | null;
  hits: FlashHit[];
  subs: FlashSubLog[];
  ms: number;
  usd: number;
};

/** DeepSeek flash の値段（llm-price と同じ: 一致 $0.003／不一致 $0.15／出力 $0.6 per 1M・混雑の時間は2倍） */
export function flashUsd(u: { input: number; output: number; cacheHit: number }, peak: boolean): number {
  const miss = Math.max(0, u.input - u.cacheHit);
  return ((miss * 0.15 + u.cacheHit * 0.003 + u.output * 0.6) / 1e6) * (peak ? 2 : 1);
}

/**
 * ③ 下確かめを同時に回す。硬い時間切れ（timeoutMs）を全体にもかける＝どれか1つが遅くても待たずに今の3パスへ戻す。
 *   伏せた後に個人の値の網が当たった項目がある → 呼ばずに ok=false（全部 Claude）
 */
export async function runFlashSubChecks(m: FlashMaterials, deps: { call: FlashCaller; timeoutMs: number; peak?: boolean; onUsage?: (k: FlashSubKey, r: NonNullable<FlashCallResult>, ms: number, ok: boolean) => void }): Promise<FlashOutcome> {
  const t0 = Date.now();
  const maskedDraft = maskForFlash(m.draft, m.names);
  const maskedCust = maskForFlash(m.lastCustomer, m.names);
  const keys = FLASH_SUB_KEYS.filter((k) => k !== "company" || !!m.companyFacts.trim());
  const users = new Map<FlashSubKey, string>();
  for (const k of keys) {
    const u = flashUser(k, m);
    const sig = piiValueSignal(u) ?? altPiiSignal(u);
    if (sig) {
      return { ok: false, fallbackReason: `伏せた後も個人の値（${k}: ${sig}）`, hits: [], subs: [{ key: k, ok: false, ms: 0, usd: 0, hits: 0, skipped: "pii" }], ms: Date.now() - t0, usd: 0 };
    }
    users.set(k, u);
  }
  const one = async (k: FlashSubKey): Promise<{ log: FlashSubLog; hits: FlashHit[] | null }> => {
    const s = Date.now();
    try {
      const r = await deps.call(FLASH_SYSTEM[k], users.get(k)!, { model: FINAL_CHECK_FLASH_MODEL, maxTokens: FINAL_CHECK_FLASH_MAX_TOKENS, timeoutMs: deps.timeoutMs });
      const ms = Date.now() - s;
      if (!r) return { log: { key: k, ok: false, ms, usd: 0, hits: 0, error: "応答なし" }, hits: null };
      const hits = parseFlashOut(k, r.text, maskedDraft, maskedCust);
      deps.onUsage?.(k, r, ms, !!hits);
      const usd = flashUsd(r.usage, !!deps.peak);
      return { log: { key: k, ok: !!hits, ms, usd, hits: hits?.length ?? 0, ...(hits ? {} : { error: "読めない形" }) }, hits };
    } catch (e) {
      return { log: { key: k, ok: false, ms: Date.now() - s, usd: 0, hits: 0, error: (e instanceof Error ? e.message : String(e)).slice(0, 80) }, hits: null };
    }
  };
  let timer: ReturnType<typeof setTimeout> | null = null;
  const timeout = new Promise<"timeout">((res) => { timer = setTimeout(() => res("timeout"), deps.timeoutMs + 250); });
  const all = Promise.all(keys.map(one));
  const raced = await Promise.race([all, timeout]);
  if (timer) clearTimeout(timer);
  if (raced === "timeout") {
    return { ok: false, fallbackReason: `FLASH の時間切れ（${deps.timeoutMs}ms）`, hits: [], subs: keys.map((k) => ({ key: k, ok: false, ms: Date.now() - t0, usd: 0, hits: 0, error: "timeout" })), ms: Date.now() - t0, usd: 0 };
  }
  const subs = raced.map((r) => r.log);
  const failed = subs.filter((s) => !s.ok);
  const usd = subs.reduce((a, s) => a + s.usd, 0);
  if (failed.length) return { ok: false, fallbackReason: `FLASH の失敗（${failed.map((f) => `${f.key}:${f.error}`).join(",")}）`, hits: [], subs, ms: Date.now() - t0, usd };
  return { ok: true, fallbackReason: null, hits: raced.flatMap((r) => r.hits ?? []), subs, ms: Date.now() - t0, usd };
}

// ─── ④ 指揮官を呼ばずに済むか（保守的） ──────────────────────────────────────
const AMOUNT_RE = /[0-9０-９][0-9０-９,，.．]*\s*(?:円|万|千|ヶ月|か月|カ月|%|％)/;
const DATE_TIME_RE = /[0-9０-９]{1,2}\s*月\s*[0-9０-９]{1,2}\s*日|[0-9０-９]{1,2}\s*日\s*[（(]|[0-9０-９]{1,2}\s*[:：]\s*[0-9０-９]{2}|[0-9０-９]{1,2}\s*時|[月火水木金土日]曜/;
const ROOM_RE = /[0-9０-９]{2,4}\s*号室|[0-9０-９]+\s*階/;
export const LOW_RISK_MAX_CHARS = 220;
export type SkipInput = {
  draft: string;
  hits: FlashHit[];
  allOk: boolean;
  /** 決定論の検査の severity（block・warning が1つでもあれば呼ぶ） */
  detSeverities: ReadonlyArray<string>;
  isEarlyConversation?: boolean;
  enforcementRequired?: boolean;
  isDeliverableReply?: boolean;
  ngPropertiesCount?: number;
};
/**
 * 指揮官 Claude を呼ばない線（保守的）: 下確かめが全部完走・候補0、かつ下書きが「事実を作り得る形」を持たない時だけ。
 *   金額・日付・曜日・時刻・号室・階が入る／長い（220字超）／初回／ブレインが required／AIX の成果物の文／NG 物件の指定がある／
 *   決定論の検査に block か warning がある → 必ず呼ぶ。
 */
export function lowRiskForSkip(p: SkipInput): { skip: boolean; why: string } {
  if (!p.allOk) return { skip: false, why: "下確かめが完走していない" };
  if (p.hits.length) return { skip: false, why: `候補 ${p.hits.length}件` };
  if (p.detSeverities.some((s) => s === "block" || s === "warning")) return { skip: false, why: "決定論の指摘あり" };
  if (p.isEarlyConversation) return { skip: false, why: "初回" };
  if (p.enforcementRequired) return { skip: false, why: "ブレインが required" };
  if (p.isDeliverableReply) return { skip: false, why: "AIX の成果物の文" };
  if ((p.ngPropertiesCount ?? 0) > 0) return { skip: false, why: "NG 物件の指定あり" };
  const d = String(p.draft ?? "");
  if (d.length > LOW_RISK_MAX_CHARS) return { skip: false, why: `長い（${d.length}字）` };
  if (AMOUNT_RE.test(d)) return { skip: false, why: "金額・割合を含む" };
  if (DATE_TIME_RE.test(d)) return { skip: false, why: "日付・曜日・時刻を含む" };
  if (ROOM_RE.test(d)) return { skip: false, why: "号室・階を含む" };
  return { skip: true, why: "候補0・低リスク" };
}

// ─── ④ 指揮官 Claude の指示 ─────────────────────────────────────────────────
/** 候補の code → 今の3パスの名前（severity の決まり assignSeverity・画面の表示を今と同じにする） */
export function passOfCode(code: string): "rule_check" | "anomaly_scan" | "context_check" {
  if (code === "MISSED_QUESTION" || code === "TIME_INVALID") return "context_check";
  if (code.startsWith("FABRICATED_") || code === "COMPANY_FACT_CONTRADICTION") return "anomaly_scan";
  return "rule_check";
}

/** 固定の前置き（キャッシュが効く・毎回同じ文） */
export const CONDUCTOR_STATIC = `あなたは不動産会社の LINE 返信の最終チェックの指揮官です。
下確かめ係（項目ごとの小さなモデル）が【候補】を挙げました。あなたは候補を1つずつ、伏せていない【材料】【会話】【会社の事実】【決まり】と照らし、
本当に直すべき問題かだけを決めます。最終チェックの目的はハルシネーション（材料に無い事実・会社の事実に反する断定・スタッフしか知らない事の言い切り）と
答えの抜け・会社の決まりの違反を止めることです。文体の好みは問題にしません（足を引っ張らない）。

決め方:
1. 候補の引用が【返信】（asks は【お客様の最新】）に実際にあるか。無ければ捨てる。
2. 材料・会話・お客様の言葉に根拠があれば捨てる（お客様の言葉の復唱・こちらの担当者の名乗り・資料のとおりの値は問題ではない）。
3. 「確認いたします」「お送りします」などの宣言・予告だけは AIX の越権ではない。
4. 本当の問題だけを issues に入れる。code は候補の code をそのまま使う。新しい問題は、候補の引用と同じ文の中で明らかな誤りがある時だけ同じ種類の code で足してよい。
5. message はスタッフ向けの日本語1文、evidence は本文からの引用（言い換え禁止）、suggestion は具体的な直し方。
確信が持てない候補は入れない。問題が無ければ issues は空配列。`;

export function buildConductorUser(m: FlashMaterials, hits: FlashHit[], extra: { brainNote?: string; finalCheckRules?: string } = {}): string {
  const cand = hits.map((h, i) => `${i + 1}. [${h.key}] ${h.code}｜引用「${h.evidence}」｜係の理由: ${h.why || "（なし）"}`).join("\n");
  const needRules = hits.some((h) => h.key === "rules");
  return [
    `【候補】\n${cand}`,
    extra.brainNote ? `【ブレインの判断】\n${extra.brainNote}` : "",
    `【今の日時】${m.now}`,
    `【材料】\n${m.facts || "（なし）"}`,
    m.companyFacts ? `【会社の事実】\n${m.companyFacts}` : "",
    needRules ? `【決まり】\n${m.rules || "（なし）"}` : (extra.finalCheckRules ? `【最終チェックの決まり】\n${extra.finalCheckRules}` : ""),
    `【会話】\n${m.history || "（なし）"}`,
    `【お客様の最新】\n${m.lastCustomer || "（なし）"}`,
    `【返信】\n${m.draft}`,
  ].filter(Boolean).join("\n\n");
}

// ─── 記録（CheckResult.flash・JSONB のキー追加のみ＝migrate-schema 不要） ─────────────
export type FinalCheckFlashLog = {
  version: string;
  /** used＝FLASH＋指揮官（または省略）で決めた／fallback＝今の3パスに戻した／ineligible＝入口で使わなかった */
  mode: "used" | "fallback" | "ineligible";
  reason: string | null;
  subs?: FlashSubLog[];
  hits?: number;
  conductor?: { ran: boolean; ms?: number; usd?: number; why: string; kept?: number; error?: string };
  /** 下確かめ＋指揮官の時間（ms）と費用の見込み（$） */
  ms?: number;
  est_usd?: number;
};
