// app/lib/customer-fact-ledger.ts — お客様ごとの確かな事実の帳面（純関数・DB/LLM なし）
//
// 2026-11-03 竹内さん（KB P1「100% に向けて土台の7つ」④・統括が最初に読む物）:
//   お客様のメモ・送った事の台帳・状況のまとめ（customer-state）・判断の記録（last_brain_meta）・全体の分析（brain_strategy）を決まった計算で束ね、
//   事実ごとに時刻（at）と出所（source）を付ける。食い違いは「一次（state・ledger・memo）＞まとめ（meta・strategy）」の順の候補として残し、
//   どちらを正にするかはブレイン（P0）。置き場は表 customer_fact_ledger（1会話1行・サーバーの鍵だけ・customer-fact-ledger-server.ts）。
// 切替: CUSTOMER_FACT_LEDGER（off／shadow＝作って保存だけ・既定／on＝ブレインの材料の先頭に1ブロック）。テスト: app/lib/__tests__/customer-fact-ledger.test.ts
type Env = Record<string, string | undefined>;
export type FactLedgerMode = "off" | "shadow" | "on";
export function factLedgerMode(env: Env = typeof process !== "undefined" ? process.env : {}): FactLedgerMode {
  const v = (env.CUSTOMER_FACT_LEDGER ?? "").trim().toLowerCase();
  // 2026-11-03 統括役の判断: shadow（作って保存だけ・ブレインには渡さない）を既定に（データを早く溜める）。on は判断を変えるので段階で
  return v === "on" ? "on" : v === "off" ? "off" : "shadow";
}
export const FACT_LEDGER_VERSION = 1;

export type FactSource = "state" | "ledger" | "memo" | "meta" | "strategy";
export type FactKind = "stage" | "property" | "viewing" | "promise" | "done" | "memo" | "plan" | "worry" | "emotion";
export type Fact = { key: string; kind: FactKind; value: string; at: string | null; source: FactSource };

const SOURCE_RANK: Record<FactSource, number> = { state: 3, ledger: 3, memo: 2, meta: 1, strategy: 0 };
const clip = (s: unknown, n: number) => String(s ?? "").replace(/\s+/g, " ").trim().slice(0, n);

export type FactLedgerInput = {
  state?: { stage: string; stageLabel: string; since: string | null; properties: ReadonlyArray<{ key: string; name: string; statusLabel: string; lastAt: string; estimateSent: boolean; sentByUs: boolean; customerInterest: boolean }>; viewings?: ReadonlyArray<{ ymd: string; time: string | null; name: string | null; status?: string }> } | null;
  ledger?: ReadonlyArray<{ kind: string; status: string; at: string | null; evidence?: string; detail?: { object?: string | null; propertyNames?: string[] } }>;
  memo?: ReadonlyArray<{ kind: string; text: string; at?: string | null; retiredAt?: string | null }>;
  meta?: { checkpoint_stage?: string | null; plan_ahead?: { goal?: string; steps?: string[] } | null; plan_ahead_at?: string | null; three_layer?: { worry?: string } | null; emotion?: string | null; analyzed_msg_ts?: string | null } | null;
  strategy?: { checkpoint_stage?: string | null; strategy_analyzed_at?: string | null } | null;
};

export function buildFactLedger(i: FactLedgerInput): Fact[] {
  const out: Fact[] = [];
  const s = i.state;
  if (s) {
    out.push({ key: "stage", kind: "stage", value: s.stageLabel, at: s.since, source: "state" });
    for (const p of s.properties.slice(0, 12)) {
      const marks = [p.sentByUs ? "送付" : "持ち込み", p.estimateSent ? "見積済" : "", p.customerInterest ? "名指し" : ""].filter(Boolean).join("・");
      out.push({ key: `prop:${p.key}`, kind: "property", value: `${p.name}（${p.statusLabel}・${marks}）`, at: p.lastAt, source: "state" });
    }
    for (const v of (s.viewings ?? []).slice(-4)) out.push({ key: `viewing:${v.ymd}`, kind: "viewing", value: `${v.ymd}${v.time ? ` ${v.time}` : ""} ${v.name ?? "物件名なし"}${v.status ? `（${v.status}）` : ""}`, at: null, source: "state" });
  }
  for (const e of (i.ledger ?? []).slice(-30)) {
    const what = clip(e.detail?.object ?? e.detail?.propertyNames?.join("・") ?? e.evidence ?? "", 40);
    if (e.status === "promised") out.push({ key: `promise:${e.kind}:${what}`, kind: "promise", value: `${e.kind}${what ? `（${what}）` : ""}`, at: e.at, source: "ledger" });
    else if (e.status === "done") out.push({ key: `done:${e.kind}:${what}`, kind: "done", value: `${e.kind}${what ? `（${what}）` : ""}`, at: e.at, source: "ledger" });
  }
  for (const m of (i.memo ?? []).filter((x) => !x.retiredAt).slice(-12)) out.push({ key: `memo:${m.kind}:${clip(m.text, 20)}`, kind: "memo", value: `${m.kind}: ${clip(m.text, 60)}`, at: m.at ?? null, source: "memo" });
  const mt = i.meta;
  if (mt?.plan_ahead && (mt.plan_ahead.goal || mt.plan_ahead.steps?.length)) out.push({ key: "plan", kind: "plan", value: `${clip(mt.plan_ahead.goal, 30)}${mt.plan_ahead.steps?.length ? `／${mt.plan_ahead.steps.join("→")}` : ""}`, at: mt.plan_ahead_at ?? null, source: "meta" });
  if (mt?.three_layer?.worry) out.push({ key: "worry", kind: "worry", value: clip(mt.three_layer.worry, 50), at: mt.analyzed_msg_ts ?? null, source: "meta" });
  if (mt?.emotion) out.push({ key: "emotion", kind: "emotion", value: clip(mt.emotion, 20), at: mt.analyzed_msg_ts ?? null, source: "meta" });
  if (i.strategy?.checkpoint_stage) out.push({ key: "stage", kind: "stage", value: i.strategy.checkpoint_stage, at: i.strategy.strategy_analyzed_at ?? null, source: "strategy" });
  // 同じ鍵は一次の出所を先に（まとめは食い違いの候補として残す＝消さない）
  const firstIdx = new Map<string, number>();
  out.forEach((f, idx) => { if (!firstIdx.has(f.key)) firstIdx.set(f.key, idx); });
  return out.map((f, idx) => ({ f, idx })).sort((a, b) => (firstIdx.get(a.f.key)! - firstIdx.get(b.f.key)!) || (SOURCE_RANK[b.f.source] - SOURCE_RANK[a.f.source]) || (a.idx - b.idx)).map((x) => x.f);
}

/** 同じ鍵で値が違う物（食い違いの候補） */
export function factConflicts(facts: ReadonlyArray<Fact>): Array<{ key: string; first: Fact; other: Fact }> {
  const by = new Map<string, Fact[]>();
  for (const f of facts) by.set(f.key, [...(by.get(f.key) ?? []), f]);
  const out: Array<{ key: string; first: Fact; other: Fact }> = [];
  for (const [key, fs] of by) if (fs.length > 1 && fs.some((f) => f.value !== fs[0].value)) out.push({ key, first: fs[0], other: fs.find((f) => f.value !== fs[0].value)! });
  return out;
}

const SOURCE_JA: Record<FactSource, string> = { state: "記録", ledger: "送った事の台帳", memo: "メモ", meta: "前の判断", strategy: "全体の分析" };
const ago = (at: string | null, now: number) => {
  if (!at) return "";
  const h = Math.round((now - Date.parse(at)) / 3_600_000);
  return Number.isFinite(h) ? (h < 24 ? `${Math.max(0, h)}時間前` : `${Math.round(h / 24)}日前`) : "";
};
/** ブレインに渡す1ブロック（on の時だけ・材料の先頭） */
export function factLedgerBlock(facts: ReadonlyArray<Fact>, nowMs: number): string {
  if (!facts.length) return "";
  const lines = facts.slice(0, 40).map((f) => `- ${f.value}（${SOURCE_JA[f.source]}${ago(f.at, nowMs) ? `・${ago(f.at, nowMs)}` : ""}）`);
  const cf = factConflicts(facts).map((c) => `${c.key}: ${SOURCE_JA[c.first.source]}=${c.first.value}／${SOURCE_JA[c.other.source]}=${c.other.value}`);
  return `【このお客様の確かな事実の帳面（いつ・どこから）】まずこれを読む。一次（記録・送った事の台帳・メモ）とまとめ（前の判断・全体の分析）が食い違う時は、新しい・一次の方を正にする（決めるのはあなた）\n${lines.join("\n")}${cf.length ? `\n【帳面の食い違い】${cf.join("／")}` : ""}`;
}
