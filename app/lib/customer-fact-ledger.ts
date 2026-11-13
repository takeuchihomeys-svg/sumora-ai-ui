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

/**
 * 2026-11-05 作業員3（竹内さんの決定 KB a5a2f6f8 ①・外れ 8873）: 開いている約束（こちらが宣言して、まだ果たしていない物）を約束の種類ごとに分けて帳面に書く。
 *   旧は「pickup_declared（…）」と種類の英語名だけで、果たしたかどうかも、次に何をする番かも読めなかった（8873: 24秒前のピックアップの約束を見ず、確認を選んだ）。
 *   ・ピックアップ・見積書の約束 → 次の番で果たす（物件を送る AIX／御見積書の AIX）。お客様がその後に別の事を言っても、約束は残る
 *   ・確認の約束 → 結果待ち（確かめた記録が付くまで結果を書かない）
 *   ・果たした約束 → 「果たした」と書く（もう果たす番ではない）
 *   決めるのはブレイン（P0）。ここで変えるのは帳面の言い方だけ。既定 on（11/05 op2-on 15問＋op2-r3 ×3 で main 比 悪化0・q209 は送った事の行の言い方を変えない形で 3/4）。戻す FACT_LEDGER_OPEN_PROMISE=off。
 *   ※ w2-conductor のコミットしていない同じ名前の版（全部の約束を「結果は確かめてから」とする）は、ピックアップの約束で物件を送るのを止める方に働くので採らない（統括役 11/05）
 */
export function factLedgerOpenPromiseOn(env: Env = typeof process !== "undefined" ? process.env : {}): boolean {
  return (env.FACT_LEDGER_OPEN_PROMISE ?? "").trim().toLowerCase() !== "off";
}
const PROMISE_JA: Record<string, string> = { pickup_declared: "物件のピックアップ", estimate_declared: "御見積書", confirmation_promised: "募集状況などの確認" };
/**
 * 古い約束の線（KB 7323e80a・action-ledger.STALE_PROMISE_HOURS と同じ14日＝果たすまでの時間の90%値で一番遅いご連絡 8.2日より長い）。
 * これより古い約束は「流れた」とみなし、果たす番とは書かない（行は消さない＝「もう言った」は届け続ける）
 */
export const OPEN_PROMISE_STALE_HOURS = 14 * 24;
/** 約束1つの帳面の言い方（on の時）。fulfilled＝あとで果たした記録がある・ageH＝約束からの時間 */
export function openPromiseValue(kind: string, what: string, fulfilled: boolean, ageH: number | null = null): string {
  const name = PROMISE_JA[kind] ?? kind;
  const obj = what ? `・${what}` : "";
  if (fulfilled) return `こちらの約束（${name}${obj}）＝果たした`;
  if (ageH != null && Number.isFinite(ageH) && ageH > OPEN_PROMISE_STALE_HOURS) return `こちらの約束（${name}${obj}）＝14日以上前・その後の記録なし（流れた約束として扱い、今の番で蒸し返さない）`;
  // KB a1e161c6: 約束の続きで今の発言の答えを置き換えない（今聞かれた事に答えた上で果たす）
  if (kind === "pickup_declared") return `こちらの約束・まだ果たしていない（${name}${obj}）＝次の一手で果たす番（物件を送る AIX）。お客様がその後に別の物件や質問を送ってきても約束は残る（今の発言に答えた上で果たす）`;
  if (kind === "estimate_declared") return `こちらの約束・まだ果たしていない（${name}${obj}）＝次の一手で果たす番（御見積書の AIX）。お客様がその後に別の事を言っても約束は残る（今の発言に答えた上で果たす）`;
  if (kind === "confirmation_promised") return `こちらの約束・結果待ち（${name}${obj}）＝まだ確かめた結果は無い。結果を書けるのは確かめた記録が付いてから（AIX 物件確認した）`;
  return `こちらの約束・まだ果たしていない（${name}${obj}）`;
}
export type FactKind = "stage" | "property" | "viewing" | "promise" | "done" | "memo" | "plan" | "worry" | "emotion";
export type Fact = { key: string; kind: FactKind; value: string; at: string | null; source: FactSource };

const SOURCE_RANK: Record<FactSource, number> = { state: 3, ledger: 3, memo: 2, meta: 1, strategy: 0 };
const clip = (s: unknown, n: number) => String(s ?? "").replace(/\s+/g, " ").trim().slice(0, n);

export type FactLedgerInput = {
  state?: { stage: string; stageLabel: string; since: string | null; properties: ReadonlyArray<{ key: string; name: string; statusLabel: string; lastAt: string; estimateSent: boolean; sentByUs: boolean; customerInterest: boolean }>; viewings?: ReadonlyArray<{ ymd: string; time: string | null; name: string | null; status?: string }> } | null;
  ledger?: ReadonlyArray<{ kind: string; status: string; at: string | null; evidence?: string; detail?: { object?: string | null; propertyNames?: string[] }; /** 果たした done の位置（action-ledger の fulfilledBy・null＝まだ果たしていない） */ fulfilledBy?: number | null }>;
  memo?: ReadonlyArray<{ kind: string; text: string; at?: string | null; retiredAt?: string | null }>;
  meta?: { checkpoint_stage?: string | null; plan_ahead?: { goal?: string; steps?: string[] } | null; plan_ahead_at?: string | null; three_layer?: { worry?: string } | null; emotion?: string | null; analyzed_msg_ts?: string | null } | null;
  strategy?: { checkpoint_stage?: string | null; strategy_analyzed_at?: string | null } | null;
  /** 今の時刻（古い約束の線に使う・2026-11-05。無ければ線を引かない） */
  nowMs?: number;
};

/** 行動台帳（action-ledger の entries）→ 帳面の ledger の材料。brain-core はこれを通す（果たしたかどうか＝fulfilledBy も渡す・2026-11-05） */
export function ledgerFactsFrom(entries: ReadonlyArray<{ kind: string; status: string; at: string | null; evidence?: string; detail: { object?: string | null; propertyNames?: string[] }; fulfilledBy?: number | null }>): NonNullable<FactLedgerInput["ledger"]> {
  return entries.map((e) => ({ kind: e.kind, status: e.status, at: e.at, evidence: e.evidence, detail: { object: e.detail.object ?? null, propertyNames: e.detail.propertyNames }, fulfilledBy: e.fulfilledBy ?? null }));
}
export function buildFactLedger(i: FactLedgerInput, env?: Env): Fact[] {
  const openOn = factLedgerOpenPromiseOn(env);
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
    if (e.status === "promised") out.push({ key: `promise:${e.kind}:${what}`, kind: "promise", value: openOn ? openPromiseValue(e.kind, what, e.fulfilledBy != null, i.nowMs != null && e.at ? (i.nowMs - Date.parse(e.at)) / 3_600_000 : null) : `${e.kind}${what ? `（${what}）` : ""}`, at: e.at, source: "ledger" });
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

// ── 2026-11-13 作業員1（点検役「会話の流れの読み」・12548・12370・12306）: 帳面に「事情」「外した物件」「言い直した条件（範囲付き）」「再来」を持たせ、
//   今の一通と照らす印（前提にしている／言い直し／前の決定の取り消し／再来）を出す。決めるのはブレイン（印は材料だけ）。既定 off（FACT_LEDGER_THREE=on）
export function factLedgerThreeOn(env: Env = typeof process !== "undefined" ? process.env : {}): boolean {
  return (env.FACT_LEDGER_THREE ?? "").trim().toLowerCase() === "on";
}
export type FactThreeInput = {
  /** お客様の事情（メモの事情・決める人・会社の上限 等） */
  circumstances?: ReadonlyArray<{ text: string; at?: string | null }>;
  /** 外した物件（お客様が「ここは無しで」と言った・こちらが対象から外した） */
  excluded?: ReadonlyArray<{ name: string; why?: string | null; at?: string | null }>;
  /** 言い直した条件（property_condition_history・scope＝その条件が効く範囲 例「このエリアだけ」） */
  restated?: ReadonlyArray<{ field: string; from: string | null; to: string | null; scope?: string | null; at?: string | null }>;
  /** 再来（前の回の結果・deal_outcomes の前の episode） */
  revisit?: { result: string; endedAt: string | null; propertyName?: string | null } | null;
};
const FIELD_JA: Record<string, string> = { rent_max: "家賃の上限", rent_min: "家賃の下限", desired_area: "エリア", floor_plan: "間取り", move_in_time: "入居時期", walk_minutes: "駅徒歩", pet: "ペット", preferences: "こだわり", other_requests: "その他の要望", building_age: "築年数" };
export function factsThree(x: FactThreeInput): Fact[] {
  const out: Fact[] = [];
  for (const c of (x.circumstances ?? []).slice(-6)) out.push({ key: `circ:${clip(c.text, 16)}`, kind: "memo", value: `事情: ${clip(c.text, 60)}`, at: c.at ?? null, source: "memo" });
  for (const e of (x.excluded ?? []).slice(-6)) out.push({ key: `excluded:${clip(e.name, 20)}`, kind: "property", value: `外した物件: ${clip(e.name, 30)}${e.why ? `（${clip(e.why, 30)}）` : ""}`, at: e.at ?? null, source: "state" });
  for (const r of (x.restated ?? []).slice(-6)) out.push({ key: `restated:${r.field}`, kind: "memo", value: `言い直した条件: ${FIELD_JA[r.field] ?? r.field} ${clip(r.from ?? "なし", 20)}→${clip(r.to ?? "なし", 20)}${r.scope ? `（範囲: ${clip(r.scope, 20)}）` : ""}`, at: r.at ?? null, source: "state" });
  if (x.revisit) out.push({ key: "revisit", kind: "stage", value: `再来: 前の回は ${x.revisit.result}${x.revisit.propertyName ? `（${clip(x.revisit.propertyName, 30)}）` : ""}${x.revisit.endedAt ? `・${x.revisit.endedAt.slice(0, 10)} まで` : ""}`, at: x.revisit.endedAt, source: "state" });
  return out;
}
export type TurnFactMark = { mark: "前提" | "言い直し" | "取り消し" | "再来"; fact: string };
/** 今の一通と帳面を照らす（決まった語・印は材料。決めるのはブレイン） */
export function turnFactMarks(turnText: string, x: FactThreeInput): TurnFactMark[] {
  const t = String(turnText ?? "").normalize("NFKC");
  const out: TurnFactMark[] = [];
  for (const e of x.excluded ?? []) { const core = e.name.replace(/\s*[0-9]{2,4}号?室?$/, "").trim(); if (core.length >= 2 && t.includes(core)) out.push({ mark: "取り消し", fact: `外した物件「${clip(e.name, 30)}」をまた話している` }); }
  for (const r of x.restated ?? []) {
    const ja = FIELD_JA[r.field] ?? r.field;
    const hit = r.field.startsWith("rent") ? /家賃|万円?|円|予算/.test(t) : r.field === "desired_area" ? /エリア|駅|区|周辺/.test(t) : r.field === "move_in_time" ? /入居|引っ?越|月/.test(t) : t.includes(ja);
    if (hit) out.push({ mark: "言い直し", fact: `${ja}（前に ${clip(r.from ?? "なし", 16)}→${clip(r.to ?? "なし", 16)}${r.scope ? `・範囲 ${clip(r.scope, 16)}` : ""}）に触れている` });
  }
  for (const c of x.circumstances ?? []) {
    const words = (c.text.match(/[一-龯ァ-ヶー]{2,}/g) ?? []).filter((w) => !/お客様|こちら|物件|お部屋/.test(w)).slice(0, 6);
    if (words.some((w) => t.includes(w))) out.push({ mark: "前提", fact: `事情「${clip(c.text, 40)}」を前提にしている` });
  }
  if (x.revisit) out.push({ mark: "再来", fact: `前の回（${x.revisit.result}）がある会話` });
  return out.slice(0, 8);
}
export function turnFactMarksLine(marks: ReadonlyArray<TurnFactMark>): string {
  return marks.length ? `【今の一通と帳面の照らし（印・決めるのはあなた）】${marks.map((m) => `${m.mark}: ${m.fact}`).join("／")}` : "";
}
/** お客様のメモの項目 → 帳面の事情・外した物件（2026-11-13 作業員1・竹内さん「メモの部分もうまく活用する」。名前はメモの kind のまま: circumstance・people・ng） */
export function memoItemsToThree(items: ReadonlyArray<{ kind: string; text: string; property?: string | null; sourceAt?: string | null; retiredAt?: string | null }>): Pick<FactThreeInput, "circumstances" | "excluded"> {
  const live = items.filter((m) => !m.retiredAt);
  return {
    circumstances: live.filter((m) => m.kind === "circumstance" || m.kind === "people").map((m) => ({ text: m.kind === "people" ? `決める人: ${m.text}` : m.text, at: m.sourceAt ?? null })),
    excluded: live.filter((m) => m.kind === "ng" && !!m.property).map((m) => ({ name: String(m.property), why: m.text, at: m.sourceAt ?? null })),
  };
}
