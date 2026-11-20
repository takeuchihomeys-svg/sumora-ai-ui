// app/lib/feeling-conductor-table.ts — 気持ち・状況から統括の5つの判断を決める表（FEELING_CONDUCTOR_TABLE・既定 off・純関数）
//   2026-11-15 作業員I（竹内さん 11/15「統括の器を強化していく」・KB 3041baaa P0「作った部品が本番に届いているか・統括の土台を揃える」・統括の土台③）
//   設計図: memory/design_docs/feeling_conductor_linkage_1115.md の「段4」と「追記（状況）」
//
// ■ 5つの判断: ①重点（conductor-focus の Focus）②一手の強さ（押す・添える・待つ・引く）③返信と AIX の組と順番 ④次に送る物 ⑤書き手に渡す段
// ■ 決まり（統括役 11/15）: 表に入れるのは竹内さんの決定がある行（設計図に出所の KB・memory を書いてある行）だけ。
//   設計図で「？」の行（興味が薄い・不満・離れかけ・熱が下がった・決める人が別・答えていない問い）は表に入れない＝OPEN_ROWS に名前だけ置き、
//   当たった番は open に名前を残す（scripts/feeling-conductor-count.ts が竹内さんの番で数え、型が見える物は案・見えない物は推奨つきの問いにする）
// ■ 読む物: 気持ち＝customer_mindset（12の状態・不安の向き・迷いの種類）・強さ＝latent_five.feeling.strength → latent_read.feeling.strength（強い=3・ふつう=2・弱い=1）
//   状況＝turn_contract.asks（何について）・action_ledger.facts（見積・約束）・now_vs_later（開いている約束・今出せる結果）・our_send_uptake（刺さり）・入力の situation（入居までの日数・内覧の段階・駅の中の状態）
// ■ スイッチ FEELING_CONDUCTOR_TABLE: off（既定・何もしない）／shadow（meta.feeling_conductor に記録だけ）／on（記録＋重点・優先度の表の手がかり・指示書の次の一手の強さ・具体の一手・書き手への欄に使う）
//   ②の強さの言葉 → 次の一手の強さ（next-move-types.NextStrength）への読み替え: 押す=strong・添える=invite・待つ=door・引く=none（作業員I の読み替え・竹内さんの決定ではない＝要確認）

// 型は他の部品から import しない（next-move-types は型だけでも 1,877 ファイルを引き、brain-core の型と輪になって型の検査が重くなる＝11/15 リモートの組み立てで OOM）。
//   名前は conductor-focus.FOCUS_KINDS・next-move-types.NEXT_DEST/NEXT_STRENGTH と同じ（scripts/test-feeling-conductor-table.ts が突き合わせる）
export type Focus = "answer" | "promise_make" | "promise_keep" | "ease" | "close" | "propose" | "relation";
export type NextDest = "viewing" | "apply" | "estimate" | "ask_send" | "ask_condition" | "keep_send" | "wait_check" | "answer_only" | "door" | "none";
export type NextStrength = "strong" | "invite" | "together" | "door" | "none";

type Env = Record<string, string | undefined>;
type M = Record<string, unknown>;
export type FeelingTableMode = "off" | "shadow" | "on";
export function feelingTableMode(env: Env = typeof process !== "undefined" ? process.env : {}): FeelingTableMode {
  const v = String(env.FEELING_CONDUCTOR_TABLE ?? "").trim().toLowerCase();
  // 2026-11-21 作業員K2（統括役の決め・#100）: 既定 shadow（meta.feeling_conductor に記録だけ・判断と文は変えない＝applyFeelingFocus 等は on の時だけ）。
  //   60日の数えで表と竹内さんの一致 15/73・竹内さんの重点は「約束を果たす」が最多＝順番が悪いのか材料（開いている約束・今出せる結果・強さ）が無いのかを、本番の記録で分ける。止める =off
  return v === "on" ? "on" : v === "off" ? "off" : "shadow";
}
/** 判断に使う（on の時だけ）。shadow は記録だけ */
export const feelingTableOn = (env?: Env) => feelingTableMode(env) === "on";

const obj = (v: unknown): M | null => (v && typeof v === "object" && !Array.isArray(v) ? (v as M) : null);
const arr = (v: unknown): unknown[] => (Array.isArray(v) ? v : []);
const str = (v: unknown): string | null => (typeof v === "string" && v.trim() ? v.trim() : null);

/** ②一手の強さ（設計図の言葉） */
export const PUSH_LEVELS = ["push", "add", "wait", "pull"] as const;
export type PushLevel = typeof PUSH_LEVELS[number];
export const PUSH_LEVEL_JA: Record<PushLevel, string> = { push: "押す", add: "添える", wait: "待つ", pull: "引く" };
export const PUSH_TO_NEXT_STRENGTH: Record<PushLevel, NextStrength> = { push: "strong", add: "invite", wait: "door", pull: "none" };
const PUSH_RANK: Record<PushLevel, number> = { pull: 0, wait: 1, add: 2, push: 3 };
const PUSH_BY_RANK: PushLevel[] = ["pull", "wait", "add", "push"];

/** 表が読む材料（meta から・入力から） */
export type FeelingRead = {
  state: string | null;            // 12の状態（customer_mindset.state）
  anxiety: { target: string; direction: string } | null;
  hesitation: string | null;       // 迷いの種類（customer_mindset.hesitation）
  strength: 1 | 2 | 3 | null;      // 強さ（latent_five → latent_read）
  strengthFrom: "latent_five" | "latent_read" | null;
  abouts: string[];                // 依頼の「何について」（turn_contract.asks.about）
  askText: string;                 // 依頼の引用（安さの不審の網に使うだけ）
  estimatesSent: number;           // こちらが送った御見積書の数（入力 → action_ledger.facts.estimateSent）
  openPromise: boolean;            // 開いている約束（action_ledger.facts の未果たし・now_vs_later.our_open）
  resultReady: boolean;            // 今出せる結果（now_vs_later.ready_now）
  notHooked: boolean;              // 送った物件が刺さっていない（our_send_uptake）
  daysToMoveIn: number | null;     // 入居希望日までの日数（入力）
  viewing: "none" | "scheduled" | "place_sent" | "done" | null; // 内覧の段階（入力）
  substate: string | null;         // 駅の中の状態（入力: 例 候補切れ・刺さらず）
};
export type FeelingSituationInput = { daysToMoveIn?: number | null; estimatesSent?: number | null; viewing?: FeelingRead["viewing"]; substate?: string | null };

const STRENGTH_NUM: Record<string, 1 | 2 | 3> = { strong: 3, mid: 2, weak: 1 };
/** 安さを不審に思う網（feedback_cost_explain_aix の場面の言葉だけ・候補の網） */
export const CHEAP_DOUBT_RE = /安すぎ|安い理由|なんで(?:こんなに)?安|なぜ(?:こんなに)?安|どうして(?:こんなに)?安|怪し|裏があ|詐欺/;

export function readFeeling(meta: M | null | undefined, sit: FeelingSituationInput = {}): FeelingRead {
  const m = meta ?? {};
  const cm = obj(m.customer_mindset);
  const ax = obj(cm?.anxiety);
  const f5 = str(obj(obj(m.latent_five)?.feeling)?.strength);
  const f4 = str(obj(obj(m.latent_read)?.feeling)?.strength);
  const strength = (f5 && STRENGTH_NUM[f5]) || (f4 && STRENGTH_NUM[f4]) || null;
  const asks = arr(obj(m.turn_contract)?.asks).map(obj).filter((a): a is M => !!a);
  const facts = obj(obj(m.action_ledger)?.facts);
  const nl = obj(m.now_vs_later);
  const uptake = arr(m.our_send_uptake).map(obj);
  return {
    state: str(cm?.state),
    anxiety: ax && str(ax.target) ? { target: String(ax.target), direction: String(ax.direction ?? "") } : null,
    hesitation: str(cm?.hesitation),
    strength,
    strengthFrom: f5 && STRENGTH_NUM[f5] ? "latent_five" : f4 && STRENGTH_NUM[f4] ? "latent_read" : null,
    abouts: [...new Set(asks.map((a) => str(a.about)).filter((x): x is string => !!x))],
    askText: [...asks.map((a) => String(a.quote ?? "")), ...arr(m.customer_questions).map(String)].join("\n").slice(0, 400),
    estimatesSent: typeof sit.estimatesSent === "number" ? sit.estimatesSent : facts?.estimateSent === true ? 1 : 0,
    openPromise: facts?.pickupPromisedUnfulfilled === true || facts?.estimatePromisedUnfulfilled === true || facts?.confirmationPromisedUnfulfilled === true || !!str(nl?.our_open),
    resultReady: arr(nl?.ready_now).some((x) => typeof x === "string" && x.trim()),
    notHooked: uptake.some((u) => u?.hook === "not_hooked"),
    daysToMoveIn: typeof sit.daysToMoveIn === "number" && Number.isFinite(sit.daysToMoveIn) ? sit.daysToMoveIn : null,
    viewing: sit.viewing ?? null,
    substate: sit.substate ?? null,
  };
}

/** 表の1行。決めない欄は undefined（その判断は他の部品のまま） */
export type FeelingRow = {
  id: string;
  /** 読み（設計図の言葉） */
  read: string;
  kind: "feeling" | "situation";
  match: (r: FeelingRead) => boolean;
  focus?: Focus;
  push?: PushLevel;
  /** 強さを1段上げる（状況の行）。push と両方は持たない */
  pushUp?: boolean;
  /** ③組・順番（竹内さんの決定の言葉の要約） */
  combo?: string;
  /** ④次に送る物（AIX の種類か次の行き先）。読みで変わる物は関数 */
  next?: (r: FeelingRead) => { dest: NextDest | null; aix: string | null; what: string } | null;
  /** 決定の出所（KB・memory・日付） */
  source: string;
};

const VIEWING_NEXT = (r: FeelingRead) =>
  r.viewing === "done" ? null
  : r.viewing === "scheduled" ? { dest: "viewing" as const, aix: "meeting_place", what: "待ち合わせ場所（日にち決定の後）" }
  : r.viewing === "place_sent" ? null
  : { dest: "viewing" as const, aix: "viewing_invite", what: "内覧調整（候補日）" };

/** 決定のある行だけ（設計図 段4 と 追記の「統括の判断へのつなぎ」）。上から順に当てて、同じ判断は先の行が勝つ */
export const FEELING_ROWS: readonly FeelingRow[] = [
  { id: "screening_worry_strong", read: "審査の不安（前向き）・強さ3", kind: "feeling",
    match: (r) => (r.state === "審査の不安" || r.anxiety?.target === "審査") && r.anxiety?.direction !== "後ろ向き" && r.strength === 3,
    focus: "ease", push: "push", combo: "気持ちを答えより先に。竹内さんは電話の AIX を選ぶ番がある（作業員H が数え中＝組は決めない）",
    source: "10/09 12の状態（feedback_domain_emotion_states）・aix:screening-consult-phone-call" },
  { id: "taken_worry", read: "先に取られる不安・抑えたい", kind: "feeling",
    match: (r) => r.state === "先に取られる不安" || r.state === "抑えたい" || r.anxiety?.target === "先に取られる",
    focus: "propose", push: "push", combo: "抑え（申込の流れ）を提案",
    next: () => ({ dest: "apply", aix: null, what: "申込で抑える流れ" }),
    source: "10/09「抑えたい」（feedback_domain_emotion_states）" },
  { id: "hesitate_between", read: "迷い（物件どうし）", kind: "feeling",
    match: (r) => r.state === "迷い" && r.hesitation === "複数物件で迷う",
    focus: "propose", push: "add", combo: "1件を推す・抑えるのを提案",
    next: () => ({ dest: "apply", aix: null, what: "1件を推して抑える提案" }),
    source: "10/09 決定2（feedback_domain_emotion_states）" },
  { id: "cheap_doubt", read: "安さを不審に思う", kind: "feeling",
    match: (r) => CHEAP_DOUBT_RE.test(r.askText),
    combo: "AIX【初期費用を説明】",
    next: () => ({ dest: null, aix: "cost_explain", what: "初期費用を説明" }),
    source: "feedback_cost_explain_aix（9/12 竹内さん）" },
  { id: "want_cheaper", read: "安くしたい", kind: "feeling",
    match: (r) => r.state === "安くしたい",
    combo: "まず AIX 見積書 → 続けば代表確認でさらに下げた見積書 → それでも続けば代表確認か初期費用の説明",
    next: (r) => r.estimatesSent === 0 ? { dest: "estimate", aix: "estimate_sheet", what: "最大限割引の御見積書" }
      : r.estimatesSent === 1 ? { dest: "estimate", aix: "estimate_sheet", what: "代表確認でさらに下げた御見積書" }
      : { dest: null, aix: "cost_explain", what: "代表確認か初期費用の説明" },
    source: "11/05 No.39（竹内さん）" },
  { id: "estimate_asked", read: "見積を頼んだ", kind: "feeling",
    match: (r) => r.abouts.includes("property_cost") || /御?見積|初期費用(?:は|って|を|教|いくら)/.test(r.askText),
    combo: "その物件に興味がある。御見積書の後、未内覧で空室なら内覧へ",
    next: (r) => r.estimatesSent === 0 ? { dest: "estimate", aix: "estimate_sheet", what: "御見積書" } : r.viewing === "none" || r.viewing == null ? { dest: "viewing", aix: "viewing_invite", what: "内覧へ（未内覧・空室なら）" } : null,
    source: "10/09 決定2（feedback_domain_emotion_states）" },
  { id: "hooked_strong", read: "刺さっている・強さ3", kind: "feeling",
    match: (r) => r.state === "刺さっている" && r.strength === 3,
    focus: "propose", push: "push", combo: "締めの CTA は刺さり具合で3つ",
    source: "feedback_recommend_cta_by_appeal" },
  { id: "viewing_flow", read: "時間が無い・内覧したい", kind: "feeling",
    match: (r) => r.state === "内覧したい" || r.state === "時間が無い",
    combo: "内覧は段階どおり（候補日 → 日にち決定 → 待ち合わせ）",
    next: VIEWING_NEXT,
    source: "feedback_viewing_flow_stages" },
  { id: "out_of_candidates", read: "送ったが刺さらず物件が無い", kind: "situation",
    match: (r) => r.substate === "候補切れ" || (r.notHooked && r.substate === "刺さらず"),
    combo: "全力サポートはお客様の返信の後",
    source: "feedback_zenryoku_support_timing" },
  { id: "promise_with_result", read: "開いている約束があり手元に結果がある", kind: "situation",
    match: (r) => r.openPromise && r.resultReady,
    focus: "promise_keep", combo: "約束を果たす AIX",
    source: "決定 C（P0 の親 C・ACK_CONFIRM_AIX_PATH）" },
  { id: "time_close", read: "時間が迫る（入居まで30日以内）", kind: "situation",
    match: (r) => r.daysToMoveIn != null && r.daysToMoveIn >= 0 && r.daysToMoveIn <= 30,
    pushUp: true,
    source: "fact_company_policies_1008（申込は入居30日前から基本）・設計図 追記のつなぎ" },
];

/** 設計図の「？」の行（決定が無い＝表に入れない）。当たった番は open に名前だけ残す */
export const OPEN_ROWS: ReadonlyArray<{ id: string; read: string; match: (r: FeelingRead) => boolean; ask: string }> = [
  { id: "low_interest", read: "興味が薄い", match: (r) => r.state === "興味が薄い", ask: "竹内さんの番から埋める" },
  { id: "unhappy_leaving", read: "不満・離れかけ", match: (r) => r.state === "不満・離れかけ", ask: "竹内さんの番から埋める" },
  { id: "decider_elsewhere", read: "決める人が別にいる", match: (r) => r.hesitation === "家族・同居人に相談", ask: "竹内さんの番から埋める（押さない・資料を渡しやすい形の案）" },
  // 熱が下がった（段2 の合図2つ以上）は段2 の部品が無いので読めない＝竹内さんに聞く（押すか引くか）。答えていない問いは出所が無い
];

/** ⑤書き手に渡す段（設計図 段4 の⑤・文の役目ごとに渡す欄）。表の判断のうちどれをどの役目へ */
export const FEELING_TO_ROLES: Readonly<Record<"focus" | "push" | "combo" | "next", readonly string[]>> = {
  focus: ["head", "bridge"],     // 重点 → 頭の一文・つなぎ（focus.kind の役目と同じ）
  push: ["close", "bridge"],     // 一手の強さ → 締め・つなぎ（hook.degree の役目と同じ）
  combo: ["aix1", "aix2"],       // 組 → AIX の1通目・2通目（priority.combo の役目と同じ）
  next: ["bridge", "aix2"],      // 次に送る物 → つなぎ・AIX 2通目（aim.mid の役目と同じ）
};

export type FeelingDecision = {
  rows: string[];
  focus: Focus | null; focusFrom: string | null;
  push: PushLevel | null; pushFrom: string | null;
  combo: string | null; comboFrom: string | null;
  next: { dest: NextDest | null; aix: string | null; what: string } | null; nextFrom: string | null;
  /** ⑤ 役目 → 渡す判断の名前 */
  writer: Record<string, string[]>;
  sources: string[];
  /** 「？」の行に当たった（決定が無い・竹内さんの番から埋める） */
  open: string[];
  /** 読みの要約（記録・数え用） */
  read: { state: string | null; strength: number | null; hesitation: string | null; anxiety: string | null;
    /** 2026-11-21 作業員K2: 1週間後に「順番か材料か」を分ける材料（開いている約束・今出せる結果・強さの出所・刺さっていない） */
    openPromise?: boolean; resultReady?: boolean; strengthFrom?: string | null; notHooked?: boolean };
};

export function decideFromFeeling(meta: M | null | undefined, sit: FeelingSituationInput = {}): FeelingDecision {
  const r = readFeeling(meta, sit);
  const hits = FEELING_ROWS.filter((row) => { try { return row.match(r); } catch { return false; } });
  const d: FeelingDecision = { rows: hits.map((h) => h.id), focus: null, focusFrom: null, push: null, pushFrom: null, combo: null, comboFrom: null, next: null, nextFrom: null, writer: {}, sources: [], open: [],
    read: { state: r.state, strength: r.strength, hesitation: r.hesitation, anxiety: r.anxiety ? `${r.anxiety.target}:${r.anxiety.direction}` : null, openPromise: r.openPromise, resultReady: r.resultReady, strengthFrom: r.strengthFrom, notHooked: r.notHooked } };
  let up = false;
  for (const h of hits) {
    if (h.focus && !d.focus) { d.focus = h.focus; d.focusFrom = h.id; }
    if (h.push && !d.push) { d.push = h.push; d.pushFrom = h.id; }
    if (h.pushUp) up = true;
    if (h.combo && !d.combo) { d.combo = h.combo; d.comboFrom = h.id; }
    if (h.next && !d.next) { const n = h.next(r); if (n) { d.next = n; d.nextFrom = h.id; } }
    if (!d.sources.includes(h.source)) d.sources.push(h.source);
  }
  // 時間が迫る → 強さを1段上げる（決まった強さが無い時は上げる元が無い＝決めない）
  if (up && d.push) { const nx = PUSH_BY_RANK[Math.min(3, PUSH_RANK[d.push] + 1)]; if (nx !== d.push) { d.push = nx; d.pushFrom = `${d.pushFrom}+time_close`; } }
  for (const [k, roles] of Object.entries(FEELING_TO_ROLES)) {
    if (d[k as "focus" | "push" | "combo" | "next"] == null) continue;
    for (const role of roles) (d.writer[role] ??= []).push(k);
  }
  d.open = OPEN_ROWS.filter((o) => { try { return o.match(r); } catch { return false; } }).map((o) => o.id);
  return d;
}

/** digest の短い印 例 "taken_worry,time_close|f:propose|p:push|n:apply|?:" */
export function feelingDigest(d: FeelingDecision | null | undefined): string | null {
  if (!d) return null;
  // 2026-11-21 作業員K2: 行に当たらない番も材料（m:開いている約束・今出せる結果・強さ）を残す＝竹内さんの番と並べて「順番か材料か」を数える（先頭に置いて切れないように）
  const mat = `m:${d.read?.openPromise ? 1 : 0}${d.read?.resultReady ? 1 : 0}${d.read?.strength ?? "-"}${d.read?.notHooked ? 1 : 0}`;
  return [mat, d.rows.join(",") || "-", `f:${d.focus ?? "-"}`, `p:${d.push ?? "-"}`, `n:${d.next?.aix ?? d.next?.dest ?? "-"}`, `?:${d.open.join(",")}`].join("|").slice(0, 100);
}

const decisionOf = (meta: unknown): FeelingDecision | null => {
  const v = obj(obj(meta)?.feeling_conductor);
  return v && Array.isArray(v.rows) ? (v as unknown as FeelingDecision) : null;
};

/** ① 重点: on の時、表の重点がブレインの重点と違えば表の重点にする（元は focus_brain に残す） */
export function applyFeelingFocus(meta: M, env?: Env): boolean {
  if (!feelingTableOn(env)) return false;
  const d = decisionOf(meta); const cf = obj(meta.conductor_focus);
  if (!d?.focus || !cf || cf.focus === d.focus) return false;
  meta.conductor_focus = { ...cf, focus_brain: cf.focus, focus: d.focus, why: `表:${d.focusFrom}`.slice(0, 30) };
  return true;
}
/** 優先度の表の手がかり（priority-table.priorityCuesFromMeta が on の時に足す） */
export function feelingPriorityCues(meta: unknown, env?: Env): { takenWorry?: boolean; hooked?: boolean } {
  if (!feelingTableOn(env)) return {};
  const d = decisionOf(meta);
  if (!d) return {};
  return { ...(d.rows.includes("taken_worry") ? { takenWorry: true } : {}), ...(d.rows.includes("hooked_strong") ? { hooked: true } : {}) };
}
/** ② 一手の強さ: on の時、指示書の次の一手の強さを表の強さにする（無ければ null） */
export function feelingNextStrength(meta: unknown, env?: Env): { strength: NextStrength; from: string } | null {
  if (!feelingTableOn(env)) return null;
  const d = decisionOf(meta);
  return d?.push ? { strength: PUSH_TO_NEXT_STRENGTH[d.push], from: d.pushFrom ?? "" } : null;
}
/** ④ 次に送る物: on の時、表の次に送る物（具体の一手が材料から決まらない番に使う） */
export function feelingNextSend(meta: unknown, env?: Env): (NonNullable<FeelingDecision["next"]> & { from: string }) | null {
  if (!feelingTableOn(env)) return null;
  const d = decisionOf(meta);
  return d?.next ? { ...d.next, from: d.nextFrom ?? "" } : null;
}
/** ⑤ 指示書の欄（on の時だけ・書き手への1行に出す） */
export function feelingBriefSection(meta: unknown, env?: Env): { focus: string | null; push: string | null; combo: string | null; next: string | null; rows: string[]; tool?: string } | null {
  if (!feelingTableOn(env)) return null;
  const d = decisionOf(meta);
  if (!d || !d.rows.length) return null;
  const tool = Array.isArray(obj(meta)?.feeling_aix_order) ? (obj(meta)!.feeling_aix_order as Array<{ decided?: boolean; what?: string; to?: string }>).filter((x) => x.decided).map((x) => `${x.what}→${x.to}`).join("／").slice(0, 120) : "";
  return { focus: d.focus, push: d.push ? PUSH_LEVEL_JA[d.push] : null, combo: d.combo, next: d.next?.what ?? null, rows: d.rows, ...(tool ? { tool } : {}) };
}
