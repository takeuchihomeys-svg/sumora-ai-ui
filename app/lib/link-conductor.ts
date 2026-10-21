// app/lib/link-conductor.ts — つなぎのブレイン 段3「司令塔」（純関数・DB も fetch も LLM も持たない）
//
// 2026-10-21 竹内さん（設計知見 72d92e4f「LINE のブレインと同じ構造」・e07a8b73「多くは機械の計算・迷う所だけ flash」・
//   98bca000「4つが同じ今どこ・何を約束したか・次の一手を見る」・2d65c6a6 統括ブレイン）:
//   段2 の共通の状態（customer-hub）を読み、お客様ごとに「次の一手」を1つに決める。
//     send      … お客様へ送る（ブレインの返信／中身が手元にある AIX＝送れる物件・連絡日の連絡）
//     ask_staff … スタッフしか分からない事（確認の結果・見積の金額・状態の確かめ）→ AIX で送る／確かめる（下書きには書かない＝P0 4b744a33）
//     todo      … スタッフの作業（今日の内覧・記録の直し）→ やることリスト
//     wait      … 今は動かない（お客様・管理会社の待ち・申込以降・見送り）
//   それぞれに自信（0〜1）と「なぜ」を付ける。
//
// 構造（LINE のブレインと同じ）: 分野の読み手（READERS）が候補（点・確かさ・理由）を出し、司令塔（conductCustomer）が
//   ①食い違いの決まり（下の決定1〜5）で候補を抑える ②点の高い順に選ぶ ③1位と2位の種類が違い点が近い時だけ「迷い」＝ flash に聞ける（任意・入れ口だけ）。
//   flash に渡すのは候補の札と段階の名前だけ（お客様の文・名前は渡さない）。審査の事情がある会話は flash に聞かない（PII → Claude だけ）。
//
// 質問待ち 21（司令塔が決める事）は竹内さん「オススメで」（10/21）→ 次のオススメで作った（RECOMMENDED に1か所）:
//   決定1 status と一次事実の段階が違う → 一次事実（customer-state）を正として動く。status は自動で直さず、スタッフに確かめる（ask_staff・低い点）
//   決定2 約束を果たしたのに【必ず】・要対応が開いたまま → 「閉じる」と決める（証拠＝約束の後の同じ AIX）。書き込みはしない（片付けの一覧に出すだけ）
//   決定3 内覧が決まった後のピックアップの約束 → 閉じずに「保留」（内覧の物件で進む間は送らない。見送りになれば再開）
//   決定4 カレンダーの内覧と記録が合わない → 予定はカレンダーを正にし、記録の直しをスタッフに確かめる（todo）
//   決定5 次の一手の候補が割れた → 決まった順（点）で選び、点が近く種類が違う時だけ flash（迷い）。flash が無い・使えない時は点の順
//
// 切替（全部 既定 off）: LINK_CONDUCTOR（見張りが決定を数える）・LINK_CONDUCTOR_BRAIN（LINE のブレインの材料に1行）・
//   LINK_CONDUCTOR_TODO（やることリストの迷う所の順）・LINK_CONDUCTOR_EXAM（試験の問題の候補につなぎの切れを足す）
// テスト: app/lib/__tests__/link-conductor.test.ts
import type { CustomerHub, HubContradiction, HubInput } from "./customer-hub";
import { maskPII } from "./pii-mask";
import { isCloserOnly } from "./staff-todo-list";

const H = 3600_000;
const DAY = 24 * H;
const ms = (s: string | null | undefined) => (s ? Date.parse(s) : NaN);
/** 期限からこれだけ過ぎた約束・要対応は「送る」でなく「まだ要るか確かめる」（やることリスト） */
export const ABANDON_MS = 3 * DAY;

type Env = Record<string, string | undefined>;
const envOf = (): Env => (typeof process !== "undefined" ? process.env : {});
const on = (v: string | undefined) => (v ?? "").trim().toLowerCase() === "on";
/** 見張り（link-brain-watch）が司令塔の決定を数える（既定 off） */
export function linkConductorEnabled(env: Env = envOf()): boolean { return on(env.LINK_CONDUCTOR); }
/** LINE のブレインの材料に司令塔の1行を入れる（既定 off） */
export function linkConductorBrainEnabled(env: Env = envOf()): boolean { return on(env.LINK_CONDUCTOR_BRAIN); }
/** やることリストの迷う所（同じ組で点が近い）の順を司令塔が決める（既定 off） */
export function linkConductorTodoEnabled(env: Env = envOf()): boolean { return on(env.LINK_CONDUCTOR_TODO); }
/** 試験の問題の候補に、見張りの本物の切れ（ブレインの番の物）を足す（既定 off・scripts/exam-question-candidates.ts は --link でも足す） */
export function linkConductorExamEnabled(env: Env = envOf()): boolean { return on(env.LINK_CONDUCTOR_EXAM); }

/** 質問待ち 21 に当てたオススメ（報告・テストが読む1か所） */
export const RECOMMENDED = {
  1: "status と段階が違う → 一次事実の段階で動き、status はスタッフに確かめる（自動で直さない）",
  2: "果たした約束の【必ず】・要対応 → 閉じると決める（書き込みはしない・片付けの一覧）",
  3: "内覧が決まった後のピックアップの約束 → 保留（内覧の物件で進む間は送らない）",
  4: "カレンダーの内覧と記録が違う → 予定はカレンダーを正・記録の直しをスタッフに確かめる",
  5: "候補が割れた → 点の順。点が近く種類が違う時だけ flash（迷い）",
} as const;

// ───────── 型 ─────────
export type ConductorKind = "send" | "ask_staff" | "todo" | "wait";
export type ConductorBy = "brain" | "aix" | "staff" | "none";
export const CONDUCTOR_KIND_JA: Record<ConductorKind, string> = { send: "送る", ask_staff: "スタッフに確かめる（AIX）", todo: "やることリスト", wait: "待つ" };
export type ReaderId = "turn" | "promise" | "aix_item" | "schedule" | "pickup" | "contradiction" | "route" | "closed";
export type ConductorCandidate = {
  kind: ConductorKind; by: ConductorBy;
  /** AIX のボタン（返信・作業は null） */
  action: string | null; checkPattern: string | null;
  label: string;
  /** 点（大きいほど先） */
  score: number;
  /** この読み手の決まりの確かさ（0〜1） */
  certainty: number;
  reader: ReaderId;
  why: string;
  dueAt?: string | null;
};
export type Housekeeping = { type: "close_item" | "close_calendar" | "pause_pickup" | "fix_status" | "fix_viewing_record"; detail: string; decision: 1 | 2 | 3 | 4 };
export type ConductorDecision = {
  conversationId: string;
  atIso: string;
  kind: ConductorKind; by: ConductorBy;
  action: string | null; checkPattern: string | null;
  label: string;
  confidence: number;
  /** 1位と2位の種類が違い点が近い（決定5: flash に聞ける所） */
  hesitant: boolean;
  /** なぜ（日本語・短く） */
  why: string;
  reader: ReaderId | "flash";
  /** 選ばなかった上位の候補（3つまで） */
  alternatives: ConductorCandidate[];
  /** 片付け（閉じる・保留・直しの確かめ）＝書き込みはしない */
  housekeeping: Housekeeping[];
  /** 当てたオススメ（1〜5） */
  appliedRecommendations: Array<1 | 2 | 3 | 4 | 5>;
  /** 審査の事情（flash に聞かない・生成は Claude だけ） */
  claudeOnly: boolean;
  /** スタッフしか分からない事（返信の下書きに書かず AIX で送る） */
  staffOnly: boolean;
};

// ───────── スタッフしか分からない事（AIX で送る・P0 4b744a33） ─────────
const STAFF_ONLY_ACTIONS = new Set(["property_check_result", "estimate_sheet", "property_check"]);
export function isStaffOnlyAction(action: string | null | undefined, checkPattern?: string | null): boolean {
  if (!action) return false;
  if (STAFF_ONLY_ACTIONS.has(action)) return true;
  return !!checkPattern && /^mgmt_/.test(checkPattern);
}
/** 中身が手元にある（スタッフが確かめなくても送れる）物件の AIX */
const PROPERTY_SEND_AIX = new Set(["property_send", "property_recommendation", "property_send_new_arrival", "property_send_widen"]);

function candidateForAix(action: string | null, checkPattern: string | null, base: Omit<ConductorCandidate, "kind" | "by" | "action" | "checkPattern">): ConductorCandidate {
  if (isStaffOnlyAction(action, checkPattern)) return { ...base, kind: "ask_staff", by: "aix", action, checkPattern };
  if (action && PROPERTY_SEND_AIX.has(action)) return { ...base, kind: "send", by: "aix", action, checkPattern };
  if (action) return { ...base, kind: "send", by: "aix", action, checkPattern };
  return { ...base, kind: "todo", by: "staff", action: null, checkPattern };
}

// ───────── 分野の読み手 ─────────
export type ReaderCtx = { hub: CustomerHub; contradictions: ReadonlyArray<HubContradiction>; input: HubInput; nowMs: number; pausedPickup: boolean };
type Reader = { id: ReaderId; read: (c: ReaderCtx) => ConductorCandidate[] };

/** お客様の番（未返信）→ ブレインが返す。送れる物件が揃ったピックアップの約束があれば物件の AIX */
const turnReader: Reader = {
  id: "turn",
  read({ hub, pausedPickup, input, nowMs }) {
    if (hub.actor.who !== "brain" || !/お客様の番/.test(hub.actor.why)) return [];
    // 最後のお客様の連投がお礼・了承だけ → 返さなくてよい事が多い（やることリストと同じ見分け）
    const msgs = [...input.state.messages].sort((a, b) => ms(b.createdAt) - ms(a.createdAt));
    const turn: string[] = [];
    for (const m of msgs) { if (m.sender !== "customer") break; turn.push(String(m.text ?? "")); }
    const turnAt = ms(msgs[0]?.createdAt);
    if (turn.length && turn.every((t) => isCloserOnly(t))) return [{ kind: "wait", by: "none", action: null, checkPattern: null, label: "お礼・了承だけ（返さなくてよい）", score: 15, certainty: 0.6, reader: "turn", why: "お客様の発言がお礼・了承だけ" }];
    // 3日以上返していないお客様の番は、もう返す時を過ぎた事が多い（点を下げる）
    const stale = Number.isFinite(turnAt) && nowMs - turnAt > 3 * DAY;
    if (stale) return [{ kind: "todo", by: "staff", action: null, checkPattern: null, label: "3日以上返していないお客様の番（まだ返すか確かめる）", score: 40, certainty: 0.5, reader: "turn", why: "お客様の発言に3日以上返していない" }];
    const ready = !pausedPickup && hub.nextActions.some((a) => a.source === "pickup_ready");
    if (ready) return [{ kind: "send", by: "aix", action: "property_send", checkPattern: null, label: "お客様の番・送れる物件が揃った（ピックアップの約束）", score: 92, certainty: 0.85, reader: "turn", why: "お客様の番で、約束したピックアップの物件が手元に揃っている", dueAt: hub.actor.dueAt }];
    return [{ kind: "send", by: "brain", action: null, checkPattern: null, label: "お客様の番（未返信）→ ブレインが返す", score: 90, certainty: 0.9, reader: "turn", why: "お客様の発言にまだ返していない", dueAt: hub.actor.dueAt }];
  },
};

/** 開いた約束（約束の並び・連絡日・【必ず】）→ 果たす AIX。期限が近い・過ぎた物ほど先 */
const promiseReader: Reader = {
  id: "promise",
  read({ hub, nowMs, pausedPickup }) {
    const out: ConductorCandidate[] = [];
    for (const p of hub.promises) {
      if (p.source === "tracker" || p.source === "request") continue; // 文の約束・依頼の話題は並び（queue）と重なる＝並びの方で数える
      if (p.watch || p.deferred) continue;
      if (p.kind === "pickup" && pausedPickup) continue; // 決定3
      const due = ms(p.dueAt);
      const left = Number.isFinite(due) ? due - nowMs : Infinity;
      // 期限を3日以上過ぎた約束は、スタッフがやめた事が多い（試し 10/21: 毎日の点検で過ぎた約束の AIX は24時間で 0 件動いた）→ 送るでなく「まだ要るか確かめる」
      if (p.overdue && Number.isFinite(due) && nowMs - due > ABANDON_MS) {
        out.push({ kind: "todo", by: "staff", action: null, checkPattern: null, label: `期限を3日過ぎた約束（まだ要るか確かめる）: ${p.label}`, score: 45, certainty: 0.55, reader: "promise", why: "期限を3日以上過ぎて果たしていない約束", dueAt: p.dueAt });
        continue;
      }
      // カレンダーの【必ず】は約束した日がある＝その日の前日までは待つ（試し 10/21: 期限前の【必ず】を送るは24時間で動かず）
      if (p.source === "calendar" && !p.overdue && left > DAY) {
        out.push({ kind: "wait", by: "none", action: null, checkPattern: null, label: `約束の日まで待つ（${p.label}）`, score: 25, certainty: 0.7, reader: "promise", why: "約束した日がまだ先", dueAt: p.dueAt });
        continue;
      }
      const urgency = p.overdue ? 80 : left <= DAY ? 70 : left <= 2 * DAY ? 60 : 50;
      const base = { label: `約束: ${p.label}`, score: urgency, certainty: p.action ? 0.85 : 0.6, reader: "promise" as const, why: `${p.overdue ? "期限を過ぎた" : "開いている"}約束（${p.source === "contact" ? "連絡日" : p.kind}）`, dueAt: p.dueAt };
      if (p.source === "contact") { out.push({ ...base, kind: "send", by: "brain", action: p.action, checkPattern: null, label: `連絡日の連絡（${p.label}）` }); continue; }
      if (p.kind === "pickup") {
        // ピックアップは物件が揃うまで送れない（揃ったら pickupReader）。揃っていない間は待つ
        if (!hub.properties.pickupReady) out.push({ ...base, kind: "wait", by: "none", action: null, checkPattern: null, score: 20, certainty: 0.7, why: "ピックアップの約束・物件がまだ揃っていない" });
        continue;
      }
      out.push(candidateForAix(p.action, p.pickerKey ?? p.checkPattern, base));
    }
    return out;
  },
};

/** 要対応（aix_action_items pending）→ その AIX */
const aixItemReader: Reader = {
  id: "aix_item",
  read({ input, nowMs }) {
    const out: ConductorCandidate[] = [];
    for (const i of input.aixItems) {
      if (i.status !== "pending" || ms(i.created_at) > nowMs) continue;
      const age = nowMs - ms(i.created_at);
      if (age > DAY + ABANDON_MS) {
        out.push({ kind: "todo", by: "staff", action: null, checkPattern: null, label: `4日以上残る要対応（まだ要るか確かめる）: ${i.action}`, score: 45, certainty: 0.55, reader: "aix_item", why: "要対応が4日以上開いたまま" });
        continue;
      }
      const score = age > DAY ? 75 : 62;
      out.push(candidateForAix(i.action, i.check_pattern, { label: `要対応 ${i.action}${i.check_pattern ? `/${i.check_pattern}` : ""}`, score, certainty: 0.8, reader: "aix_item", why: `要対応が${age > DAY ? "24時間以上" : ""}開いている`, dueAt: new Date(ms(i.created_at) + DAY).toISOString() }));
    }
    return out;
  },
};

/** 予定: 今日の内覧（まだ）→ やることリスト */
const scheduleReader: Reader = {
  id: "schedule",
  read({ hub, nowMs }) {
    const today = new Date(nowMs + 9 * H).toISOString().slice(0, 10);
    const v = hub.schedule.find((x) => x.kind === "viewing" && !x.done && new Date(ms(x.at) + 9 * H).toISOString().slice(0, 10) === today);
    return v ? [{ kind: "todo", by: "staff", action: null, checkPattern: null, label: "今日の内覧", score: 78, certainty: 0.85, reader: "schedule", why: "今日が内覧の日", dueAt: v.at }] : [];
  },
};

/** 送れる物件が揃った（お客様の番でない時） */
const pickupReader: Reader = {
  id: "pickup",
  read({ hub, pausedPickup }) {
    if (pausedPickup || !hub.properties.pickupReady) return [];
    const promised = hub.promises.some((p) => p.source === "queue" && p.kind === "pickup");
    const watching = hub.flags.searching?.reason === "watch_promised";
    if (!promised && !watching) return [];
    return [{ kind: "send", by: "aix", action: watching && !promised ? "property_recommendation" : "property_send", checkPattern: null, label: watching && !promised ? "新着待ちの物件が揃った" : "ピックアップの物件が揃った",
      score: 72, certainty: 0.8, reader: "pickup", why: watching && !promised ? "新着を送る約束・送れる物件がある" : "ピックアップの約束・送れる物件がある" }];
  },
};

/** 食い違い（決定1・2・4）と連絡日の過ぎ */
const contradictionReader: Reader = {
  id: "contradiction",
  read({ contradictions }) {
    const out: ConductorCandidate[] = [];
    for (const c of contradictions) {
      if (c.type === "status_vs_stage" || c.type === "reapply_still_post_apply") out.push({ kind: "ask_staff", by: "staff", action: null, checkPattern: null, label: "状態（status）を確かめる", score: 35, certainty: 0.55, reader: "contradiction", why: `状態と一次事実の段階が違う（${c.detail}）` });
      if (c.type === "calendar_viewing_vs_state") out.push({ kind: "todo", by: "staff", action: null, checkPattern: null, label: "内覧の記録をカレンダーに合わせる", score: 38, certainty: 0.6, reader: "contradiction", why: `カレンダーと記録の内覧が違う（${c.detail}）` });
      if (c.type === "contact_overdue") out.push({ kind: "send", by: "brain", action: null, checkPattern: null, label: "連絡日を過ぎた・こちらから連絡", score: 74, certainty: 0.8, reader: "contradiction", why: "連絡日を過ぎてこちらから連絡していない" });
    }
    return out;
  },
};

/** 申込までの地図の次の一手（他に何も無い時の下支え）・音信不通の追客 */
const routeReader: Reader = {
  id: "route",
  read({ hub }) {
    const out: ConductorCandidate[] = [];
    // 音信不通の追客は追客の流れ（followup）に任せる＝ここでは待つの下（試し 10/21: 毎日の点検で「追客を送る」は24時間で一度も動いていなかった）
    if (hub.where.branch === "silent") out.push({ kind: "send", by: "brain", action: null, checkPattern: null, label: "音信不通の追客（追客の流れ）", score: 5, certainty: 0.4, reader: "route", why: "お客様から7日以上反応が無い" });
    // 地図の次の一手はお客様の番でブレインが使う物（ここでは「待つ」の下支え）
    out.push({ kind: "wait", by: "none", action: null, checkPattern: null, label: hub.where.next ? `お客様の反応待ち（次は ${hub.where.next.label}）` : "お客様の反応待ち", score: 10, certainty: 0.7, reader: "route", why: "開いている約束・要対応・お客様の番が無い" });
    return out;
  },
};

export const CONDUCTOR_READERS: readonly Reader[] = [turnReader, promiseReader, aixItemReader, scheduleReader, pickupReader, contradictionReader, routeReader];

// ───────── 司令塔 ─────────
/** 迷いの線: 1位と2位の点の差がこれ未満で種類が違えば迷い */
export const HESITATE_GAP = 8;
/** 迷いの時に聞く flash（任意）。候補の札と段階だけを受け取り、選んだ候補の番号を返す（-1／null＝決めない） */
export type ConductorTieBreaker = (q: { stageLabel: string | null; candidates: Array<{ i: number; kind: ConductorKind; label: string; score: number }> }) => number | null;

function housekeepingOf(contradictions: ReadonlyArray<HubContradiction>): Housekeeping[] {
  const out: Housekeeping[] = [];
  for (const c of contradictions) {
    if (c.type === "aix_item_open_promise_done") out.push({ type: "close_item", detail: c.detail, decision: 2 });
    else if (c.type === "calendar_open_promise_done") out.push({ type: "close_calendar", detail: c.detail, decision: 2 });
    else if (c.type === "pickup_promise_vs_viewing") out.push({ type: "pause_pickup", detail: c.detail, decision: 3 });
    else if (c.type === "status_vs_stage" || c.type === "reapply_still_post_apply") out.push({ type: "fix_status", detail: c.detail, decision: 1 });
    else if (c.type === "calendar_viewing_vs_state") out.push({ type: "fix_viewing_record", detail: c.detail, decision: 4 });
  }
  return out;
}

/** flash に渡す札。約束の読み手の札はカレンダーの題・約束の物（自由な文・名前や物件名が入り得る）→ 種類・ボタン・期限だけの札に置き換える */
export function flashLabelOf(c: ConductorCandidate, nowMs: number): string {
  if (c.reader !== "promise") return c.label;
  const due = ms(c.dueAt);
  const when = !Number.isFinite(due) ? "" : due < nowMs ? "（期限過ぎ）" : due - nowMs <= DAY ? "（期限1日以内）" : "（期限まだ先）";
  return `約束${c.action ? ` AIX ${c.action}${c.checkPattern ? `/${c.checkPattern}` : ""}` : ""}${when}`;
}

export function conductCustomer(hub: CustomerHub, contradictions: ReadonlyArray<HubContradiction>, input: HubInput, o: { tieBreaker?: ConductorTieBreaker | null } = {}): ConductorDecision {
  const nowMs = input.nowMs;
  const housekeeping = housekeepingOf(contradictions);
  const applied = new Set<1 | 2 | 3 | 4 | 5>(housekeeping.map((h) => h.decision));
  const pausedPickup = housekeeping.some((h) => h.type === "pause_pickup");
  const claudeOnly = hub.flags.claudeOnly;
  const base = { conversationId: hub.conversationId, atIso: hub.atIso, housekeeping, claudeOnly };

  // 見送り・成約・申込以降 → 待つ（申込以降は管理ツール側の流れ。片付けは出す＝決定2）
  const stage = hub.where.stage;
  const postApply = hub.where.isPostApply || stage === "applying";
  if (stage === "dropped" || stage === "won" || postApply) {
    for (const c of contradictions) if (c.type === "open_after_closed") { housekeeping.push({ type: "close_item", detail: c.detail, decision: 2 }); applied.add(2); }
    return { ...base, kind: "wait", by: "none", action: null, checkPattern: null, label: postApply ? "申込以降（管理ツールの流れ）" : "見送り・成約", confidence: 0.9, hesitant: false,
      why: postApply ? "申込以降はつなぎのブレインの対象外" : "見送り・成約で動く物が無い", reader: "closed", alternatives: [], appliedRecommendations: [...applied].sort(), staffOnly: false };
  }

  const ctx: ReaderCtx = { hub, contradictions, input, nowMs, pausedPickup };
  const cands = CONDUCTOR_READERS.flatMap((r) => { try { return r.read(ctx); } catch { return []; } });
  // 同じ AIX の候補（約束と要対応が同じ物）は点の高い方だけ
  const seen = new Map<string, ConductorCandidate>();
  for (const c of cands) {
    const k = `${c.kind}|${c.action ?? ""}|${c.checkPattern ?? ""}|${c.action || c.kind === "send" ? "" : c.label}`;
    const prev = seen.get(k);
    if (!prev || c.score > prev.score) seen.set(k, prev ? { ...c, certainty: Math.min(1, Math.max(c.certainty, prev.certainty) + 0.05) } : c);
  }
  const ranked = [...seen.values()].sort((a, b) => b.score - a.score || b.certainty - a.certainty);
  let top = ranked[0];
  const second = ranked.find((c) => c !== top && c.kind !== top.kind && c.kind !== "wait");
  const gap = second ? top.score - second.score : Infinity;
  const hesitant = !!second && top.kind !== "wait" && gap < HESITATE_GAP;
  let reader: ReaderId | "flash" = top.reader;
  let flashPicked = false;
  if (hesitant) {
    applied.add(5);
    if (o.tieBreaker && !claudeOnly) {
      const pool = ranked.filter((c) => c.kind !== "wait").slice(0, 4);
      try {
        const i = o.tieBreaker({ stageLabel: hub.where.stageLabel, candidates: pool.map((c, i) => ({ i, kind: c.kind, label: flashLabelOf(c, nowMs), score: c.score })) });
        if (typeof i === "number" && i >= 0 && i < pool.length) { top = pool[i]; reader = "flash"; flashPicked = true; }
      } catch { /* 点の順のまま */ }
    }
  }
  const margin = Number.isFinite(gap) ? Math.min(1, gap / 20) : 1;
  const confidence = Math.round(Math.min(0.97, top.certainty * (0.6 + 0.4 * margin) + (flashPicked ? 0.05 : 0)) * 100) / 100;
  const staffOnly = isStaffOnlyAction(top.action, top.checkPattern);
  const whyParts = [top.why];
  if (hesitant) whyParts.push(flashPicked ? `迷い（${second!.label} と点が近い）→ flash が選んだ` : `迷い（${second!.label} と点が近い）→ 点の順`);
  if (pausedPickup) whyParts.push("内覧が決まったのでピックアップは保留");
  if (staffOnly) whyParts.push("スタッフしか分からない事＝AIX で送る（下書きに書かない）");
  if (claudeOnly) whyParts.push("審査の事情あり（生成は Claude だけ）");
  return {
    ...base, kind: top.kind, by: top.by, action: top.action, checkPattern: top.checkPattern, label: top.label, confidence, hesitant, why: whyParts.join("・"),
    reader, alternatives: ranked.filter((c) => c !== top).slice(0, 3), appliedRecommendations: [...applied].sort(), staffOnly,
  };
}

// ───────── 配る先（消費する物） ─────────
/** LINE のブレインの材料（1〜2行・伏せる）。送るだけの「お客様の番・返信」は何も足さない（今のブレインと同じ） */
/**
 * ブレインの材料に出す AIX（無ければ null）。
 *   1位が AIX → そのまま。1位が返信 → 2位以下の AIX は「開いている要対応（aix_item）で、物件を送る AIX でない物」だけ「返信の後に残る一手」として出す。
 *   2位以下のスタッフしか分からない事（物件確認の結果・見積 等）は一手として出さず、下書きに書かない旨だけ（protectOnly）。
 *   2026-10-21 試し（お客様の番 300）: 残る一手を全部出すと、スタッフが返信だけで済ませた番の 34% に AIX を勧めていた。
 *     約束由来の残る一手はスタッフが押したのが 13 件中 1 件（期限過ぎは 7 件中 0）・物件確認の結果／物件送付は 17 件中 2 件。
 *     開いた要対応（内覧の誘い・待ち合わせ・申込の後押し 等）は 15 件中 12 件で当たった → これだけ残す（ブレインを不要な AIX に寄せない）
 */
export type ConductorNoteAix = { action: string; checkPattern: string | null; label: string; kind: ConductorKind; first: boolean; protectOnly: boolean };
export function conductorNoteAix(d: ConductorDecision): ConductorNoteAix | null {
  if (d.action) return { action: d.action, checkPattern: d.checkPattern, label: d.label, kind: d.kind, first: true, protectOnly: false };
  const c = d.alternatives.find((x) => x.action && (x.kind === "ask_staff" || x.kind === "send"));
  if (!c || !c.action) return null;
  if (isStaffOnlyAction(c.action, c.checkPattern)) return { action: c.action, checkPattern: c.checkPattern, label: c.label, kind: c.kind, first: false, protectOnly: true };
  if (c.reader !== "aix_item" || PROPERTY_SEND_AIX.has(c.action)) return null;
  return { action: c.action, checkPattern: c.checkPattern, label: c.label, kind: c.kind, first: false, protectOnly: false };
}

export function renderConductorBrainNote(d: ConductorDecision, customerName?: string | null): string {
  const m = (t: string) => maskPII(t, [customerName ?? null]).replace(/\s+/g, " ").slice(0, 80);
  const lines: string[] = [];
  // お客様の番（返信）が1位の時、2位以下は絞って渡す（conductorNoteAix）
  const aix = conductorNoteAix(d);
  if (aix?.protectOnly) {
    lines.push(`・スタッフしか分からない事（${m(aix.label)}）がまだ開いている。返信の下書きに答えを書かない（返信の形・一手はこの行で変えない）`);
  } else if (aix) {
    const btn = `AIX【${aix.action}${aix.checkPattern ? `/${aix.checkPattern}` : ""}】`;
    const when = aix.first ? "次の一手は" : "返信の後に残る一手は";
    lines.push(isStaffOnlyAction(aix.action, aix.checkPattern)
      ? `・${when} ${btn}（${m(aix.label)}）。スタッフしか分からない事なので、返信の下書きに答えを書かない（自信 ${d.confidence}）`
      : `・${when} ${btn}（${m(aix.label)}・自信 ${d.confidence}）`);
  }
  if (d.housekeeping.some((h) => h.type === "pause_pickup")) lines.push("・内覧が決まったので、ピックアップの約束は内覧の結果まで保留（物件を追加で送ると言わない）");
  return lines.length ? `\n【つなぎの司令塔】\n${lines.join("\n")}` : "";
}

/** やることリストの迷う所の順（同じ組で点の差が gap 未満の並びを、司令塔の急ぎで並べ直す・足し引きしない） */
export const CONDUCTOR_KIND_URGENCY: Record<ConductorKind, number> = { ask_staff: 3, send: 2, todo: 1, wait: 0 };
export function conductorTodoOrder(decisions: ReadonlyMap<string, ConductorDecision>, gap = 5) {
  const urgency = (id: string) => { const d = decisions.get(id); return d ? CONDUCTOR_KIND_URGENCY[d.kind] * 10 + d.confidence * 5 : -1; };
  return <T extends { conversationId: string; group: number; score: number }>(ordered: T[]): T[] => {
    const out = [...ordered];
    // 隣どうしの入れ替えだけ（同じ組・点の差が gap 未満・司令塔の急ぎが上）。何度か回して落ち着かせる
    for (let pass = 0; pass < out.length; pass++) {
      let moved = false;
      for (let i = 0; i + 1 < out.length; i++) {
        const a = out[i], b = out[i + 1];
        if (a.group !== b.group || Math.abs(a.score - b.score) >= gap) continue;
        if (urgency(b.conversationId) > urgency(a.conversationId)) { out[i] = b; out[i + 1] = a; moved = true; }
      }
      if (!moved) break;
    }
    return out;
  };
}

/** 見張りのまとめに足す数（例の文なし） */
export type ConductorCounts = { conversations: number; byKind: Record<ConductorKind, number>; hesitant: number; staffOnly: number; housekeeping: Record<Housekeeping["type"], number>; avgConfidence: number };
export function countDecisions(ds: ReadonlyArray<ConductorDecision>): ConductorCounts {
  const byKind: Record<ConductorKind, number> = { send: 0, ask_staff: 0, todo: 0, wait: 0 };
  const hk: Record<Housekeeping["type"], number> = { close_item: 0, close_calendar: 0, pause_pickup: 0, fix_status: 0, fix_viewing_record: 0 };
  let conf = 0;
  for (const d of ds) { byKind[d.kind]++; conf += d.confidence; for (const h of d.housekeeping) hk[h.type]++; }
  return { conversations: ds.length, byKind, hesitant: ds.filter((d) => d.hesitant).length, staffOnly: ds.filter((d) => d.staffOnly).length, housekeeping: hk, avgConfidence: ds.length ? Math.round((conf / ds.length) * 100) / 100 : 0 };
}

/** 表示（伏せる） */
export function renderConductorDecision(d: ConductorDecision, customerName?: string | null): string {
  const m = (t: string) => maskPII(t, [customerName ?? null]).replace(/\s+/g, " ").slice(0, 90);
  const L = [`■ ${d.conversationId.slice(0, 8)} @${d.atIso.slice(0, 16)} → ${CONDUCTOR_KIND_JA[d.kind]}${d.action ? ` AIX【${d.action}${d.checkPattern ? `/${d.checkPattern}` : ""}】` : ""}（${d.by}・自信 ${d.confidence}${d.hesitant ? "・迷い" : ""}）`,
    `  なぜ: ${m(d.why)}`];
  if (d.alternatives.length) L.push(`  他の候補: ${d.alternatives.map((c) => `${CONDUCTOR_KIND_JA[c.kind]}${c.action ? `/${c.action}` : ""}(${c.score})`).join("・")}`);
  if (d.housekeeping.length) L.push(`  片付け: ${d.housekeeping.map((h) => `${h.type}(決定${h.decision})`).join("・")}`);
  return L.join("\n");
}

/** flash に渡す文（候補の札と段階だけ・お客様の文と名前は入れない） */
export function tieBreakPrompt(q: Parameters<ConductorTieBreaker>[0]): { system: string; user: string } {
  return {
    system: "あなたは賃貸仲介の司令塔です。お客様1人の次の一手の候補から、今いちばん先にやるべき1つを選びます。お客様を待たせない・期限を守る・スタッフしか分からない事はスタッフに確かめる、の順で考えます。JSON {\"i\": 番号, \"why\": \"20字以内\"} だけを返します。",
    user: `段階: ${q.stageLabel ?? "不明"}\n候補:\n${q.candidates.map((c) => `${c.i}: [${CONDUCTOR_KIND_JA[c.kind]}] ${c.label.replace(/[0-9０-９]{3,}/g, "#")}（点 ${c.score}）`).join("\n")}`,
  };
}
export function parseTieBreak(text: string, n: number): number | null {
  const m = String(text ?? "").match(/"i"\s*:\s*(\d+)/);
  if (!m) return null;
  const i = Number(m[1]);
  return Number.isInteger(i) && i >= 0 && i < n ? i : null;
}
