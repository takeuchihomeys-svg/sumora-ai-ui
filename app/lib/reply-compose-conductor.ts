// app/lib/reply-compose-conductor.ts — 返信の文の統括（純関数・DB/LLM なし）
//
// 2026-11-05 作業員9。竹内さんの決定 KB P1 26bfdcbf「返信の文を作る所の統括も、ブレインの統括と同じ質の高い構造にする」:
//   ① 読む（統括の重点・組み合わせ＝この通が担う事・場面・前の流れ）→ ② この通の重点を1つ決める →
//   ③ 役を順番に（構成のブレイン → 書き手 → 確かめ）→ ④ 確かめで食い違えば統括に1回だけ戻す（黙って書き換えない）→
//   ⑤ 下書きは統括のまとめ1つ・digest に重点・設計図・確かめ → ⑥ 物差しは2つ（竹内さんとの一致・原則の揃い方）
//   上の決まり: P0 575a7cd5（重点を先に決める）・子 0dbfbc97（順番の表）・P1 e3760345（6つの型）・P0 04ca13be（文の解剖を物差しに）・
//   P0 8e0d6f80（書き方の基準は竹内さん）・P1 d33e3daf（潜在意識「満足のいく家」→サポートの姿勢の約束）
//
// ■ 物差し（2026-11-05 作業員9 が DB で数えた・読むだけ）
//   竹内さん本人の番（直近14日・line_reply）127件: 下書きあり 80 → そのまま 43・少し直した 13・大きく直した 24。
//   大きく直した 24通の原因: AIX の番を返信にした 4／材料が届いていない 3／場面・決まりの読み違い 17
//     （営業時間の一言 3・継続の約束が抜けた 5・了承の番に重ねた 5・復唱や期日 2・約束の種類 2・二度言い 2）。
//   継続の約束（「新着で…出次第」「ご満足頂く…見つかるまで…サポート」）を竹内さんが入れた割合（takeuchi_compose_examples 1,211通）:
//     条件の番（AIX の後でない）106/180＝59%（過半数）・了承 6/65＝9%・検討 5/43・物件を送ってきた 8/115。
//     ＝了承・検討の番に決まりで足すと誤る。添えた12通は言葉では見分けられず（2通だけ「また新着で」と頼まれた）、
//       前の流れ（物件を送った後のお礼・募集終了や申込が入っていた報告の了承）で決まっていた → 統括の重点と前の流れで決める（統括役 11/05 案A）。
//   同じ日の全力サポートは1回まで（KB P2 1d07b3df）。
//
// スイッチ: COMPOSE_CONDUCTOR=on（既定 off＝今と1文字も変わらない）。
// テスト: npx tsx app/lib/__tests__/reply-compose-conductor.test.ts
import { planFromMeta, type TwoMessagePlan, type PlannedMessage, type Duty } from "./two-message-plan";
import { relationKeep } from "./conductor-focus";

type Env = Record<string, string | undefined>;
const envOf = (): Env => (typeof process !== "undefined" ? process.env : {});

export function composeConductorOn(env: Env = envOf()): boolean {
  return (env.COMPOSE_CONDUCTOR ?? "").trim().toLowerCase() === "on";
}

// ── ① 読む ─────────────────────────────────────────────────────────────
/** 統括の重点（作業員5 conductor-focus.ts の FOCUS_KINDS と同じ値）。keepPromise は案A の「継続の約束を添える」の印（来れば従う） */
export type ConductorFocusIn = { focus: string; why?: string | null; keepPromise?: boolean | null };
export type ComposeInputs = { focus: ConductorFocusIn | null; plan: TwoMessagePlan | null; replyMsg: PlannedMessage | null; read: string[] };

/** ブレインのメタ（last_brain_meta・suggested_aix_meta）から、文の統括が読む物だけを取り出す。無い物は null（今まで通り） */
export function readComposeInputs(meta: unknown): ComposeInputs {
  const m = (meta && typeof meta === "object" ? meta : {}) as Record<string, unknown>;
  const read: string[] = [];
  const cf = m.conductor_focus as Record<string, unknown> | null | undefined;
  const focus = cf && typeof cf.focus === "string" && cf.focus
    ? { focus: cf.focus, why: typeof cf.why === "string" ? cf.why : null, keepPromise: typeof cf.keep_promise === "boolean" ? cf.keep_promise : typeof cf.keepPromise === "boolean" ? cf.keepPromise : null }
    : null;
  if (focus) read.push("重点");
  let plan: TwoMessagePlan | null = null;
  try { plan = planFromMeta(m); } catch { plan = null; }
  if (plan) read.push("組み合わせ");
  const replyMsg = plan?.messages.find((x) => x.slot === "reply") ?? null;
  return { focus, plan, replyMsg, read };
}

// ── ② この通の重点 ───────────────────────────────────────────────────────
export type MessageFocusKey = "answer" | "promise" | "ease" | "close" | "propose" | "relation_ack" | "relation_keep";
export const MESSAGE_FOCUS_JA: Record<MessageFocusKey, string> = {
  answer: "聞かれた事に正直に答える", promise: "約束する（確かめる・作る・探す）", ease: "不安を消す", close: "決めに行く（内覧・申込）",
  propose: "物件を出す", relation_ack: "受けて締める（中身を足さない）", relation_keep: "受けて関係を続ける（継続の約束を添える）",
};
/** 竹内さんが下書きから消した型（14日の24通）＝書かない事の札。作業員5 の解剖の omitted の札名と同じ並び */
export type OmitKind = "hours" | "restate_conditions" | "restate_viewing" | "cost_assert" | "double_apology" | "apply_promise" | "deadline_promise";
export const OMIT_JA: Record<OmitKind, string> = {
  hours: "営業時間の一言", restate_conditions: "条件の全部の復唱", restate_viewing: "内覧の詳細の復唱", cost_assert: "費用・割引・日割の言い切り",
  double_apology: "二重の謝罪", apply_promise: "根拠の無い申込の約束", deadline_promise: "期日の約束（明日中 等）",
};
export type PrevStaffKind = "property_sent" | "ended_report" | "promise_open" | "other" | null;
export type MessageFocus = {
  key: MessageFocusKey; why: string; source: "conductor" | "plan" | "scene";
  duties: Duty[];
  /** 継続の約束を添える（relation_keep・条件の番の約束） */
  keep: boolean;
  omit: OmitKind[];
};

export type FocusInput = {
  inputs: ComposeInputs;
  scene: string | null;
  /** お客様の連投が了承・お礼だけ */
  ackOnly: boolean;
  prevStaff: PrevStaffKind;
  /** お客様が新着・他の物件を頼んだ */
  customerAskedNew: boolean;
  /** 今日すでに継続の約束（全力サポート・新着で出次第）をこちらが言った */
  keepSaidToday: boolean;
  /** 近い竹内さんの番で継続の約束を添えた割合（無ければ null） */
  nearKeepShare?: number | null;
};

const FOCUS_MAP: Record<string, MessageFocusKey> = {
  answer: "answer", promise_make: "promise", promise_keep: "promise", ease: "ease", close: "close", propose: "propose", relation: "relation_ack",
};

/** 案A の線: 継続の約束を添えるか（条件の番は既定で添える・了承と検討は前の流れか頼まれた時だけ・同じ日は1回まで） */
// 2026-11-06 作業員5 の relationKeep（conductor-focus.ts・統括役の決め）に寄せる＝1つの正。了承・検討の番は「お客様が新着を頼んだ」か
//   「近い竹内さんの番の過半数（anatomy.keep）」の時だけ添える。「直前に物件を送った・募集終了の報告」は候補だけ（試験 q164 で竹内さんは添えていなかった）
export function keepPromiseLine(i: FocusInput): { keep: boolean; why: string } {
  if (i.keepSaidToday) return { keep: false, why: "今日すでに継続の約束を言った（同じ日は1回まで）" };
  const k = i.inputs.focus?.keepPromise;
  if (typeof k === "boolean") return { keep: k, why: k ? "統括が継続の約束を添えると決めた" : "統括が添えないと決めた" };
  const keep = relationKeep({ scene: i.scene, customerAskedNew: i.customerAskedNew, nearKeepShare: i.nearKeepShare ?? null, keptToday: i.keepSaidToday,
    lastStaffSentOrEnded: i.prevStaff === "property_sent" || i.prevStaff === "ended_report", openPromise: i.prevStaff === "promise_open" });
  if (!keep) return { keep: false, why: i.scene === "ack" || i.scene === "considering" ? "了承・検討の番の既定（竹内さんは9〜12%）" : "" };
  return { keep: true, why: i.scene === "conditions" ? "条件の番（竹内さんは59%で添える）" : i.customerAskedNew ? "お客様が新着を頼んだ" : `近い竹内さんの番の${Math.round((i.nearKeepShare ?? 0) * 100)}%が添えた` };
}

/** この通の重点を1つ決める。統括の重点があればそれ（決め直さない）→ 組み合わせのこの通の受け持ち → 場面 の順 */
export function decideMessageFocus(i: FocusInput): MessageFocus {
  const duties: Duty[] = i.inputs.replyMsg?.duties ?? [];
  let key: MessageFocusKey; let why: string; let source: MessageFocus["source"];
  const cf = i.inputs.focus;
  if (cf && FOCUS_MAP[cf.focus]) { key = FOCUS_MAP[cf.focus]; why = cf.why || `統括の重点 ${cf.focus}`; source = "conductor"; }
  else if (duties.length) {
    key = duties.includes("answer") ? "answer" : duties.includes("appeal") ? "close" : i.ackOnly ? "relation_ack" : "promise";
    why = `この通の受け持ち（${duties.join("・")}）`; source = "plan";
  } else {
    key = i.scene === "ack" || i.scene === "considering" || i.ackOnly ? "relation_ack"
      : i.scene === "question" || i.scene === "cost" ? "answer"
      : i.scene === "conditions" || i.scene === "property_share" ? "promise"
      : i.scene === "viewing" || i.scene === "apply" ? "close" : "answer";
    why = `場面（${i.scene ?? "不明"}）`; source = "scene";
  }
  const kl = keepPromiseLine(i);
  let keep = false;
  if (key === "relation_ack" && kl.keep) { key = "relation_keep"; keep = true; why = `${why}／${kl.why}`; }
  else if (key === "promise" && i.scene === "conditions" && kl.keep) { keep = true; why = `${why}／${kl.why}`; }
  const omit: OmitKind[] = ["double_apology"];
  if (key === "relation_ack" || key === "relation_keep" || i.ackOnly) omit.push("restate_viewing", "restate_conditions", "cost_assert", "deadline_promise");
  if (key !== "close") omit.push("apply_promise");
  return { key, why: why.slice(0, 120), source, duties, keep, omit: [...new Set(omit)] };
}

/** 書き手への注記（設計図の上に置く1ブロック）。言い回しは竹内さんの実送信の形だけ（創作の文を入れない） */
export function messageFocusNote(mf: MessageFocus, o: { name?: string | null } = {}): string {
  const nm = (o.name ?? "").trim() ? `${o.name!.trim()}さん` : "";
  const L = [`【✍️ この通の重点（文の統括）】${MESSAGE_FOCUS_JA[mf.key]}（理由: ${mf.why}）`];
  if (mf.duties.length) L.push(`- この通が担う事: ${mf.duties.map((d) => ({ answer: "答える", trust: "信頼", appeal: "訴求" }[d])).join("・")}`);
  if (mf.key === "answer") L.push("- 聞かれた事の答えを最初の中身の文に置く（確認の約束に逃げない・材料に無い事は言い切らない）");
  if (mf.keep) L.push(`- この通の中身（約束・答え）はそのまま書き、その後・締めの前に継続の約束を1文だけ足す（中身を継続の約束に置き換えない・中身を省かない）。形は竹内さんの実送信: 「引き続き新着で${nm}にオススメ出来るお部屋募集に出次第お送りさせて頂きます！！」か「${nm || "〇〇さん"}がご満足頂くお部屋が見つかるまで全力でサポートさせて頂きます！！」のどちらか1つ）`);
  if (mf.key === "relation_ack") L.push("- 受けて締める。新しい中身（約束・説明・誘い）を足さない");
  if (mf.omit.length) L.push(`- 書かない事: ${mf.omit.map((k) => OMIT_JA[k]).join("・")}`);
  return L.join("\n");
}

// ── ③ 順番 ──────────────────────────────────────────────────────────────
/** 文の役の順番（順番の表 0dbfbc97 の 3番目と4番目）。後の役は前の役の決めた事を決め直さない */
export function composeOrder(mf: MessageFocus, o: { blueprint: boolean }): string[] {
  return [o.blueprint ? "compose" : null, mf.keep ? "writer(継続の約束を1つ)" : "writer", "verify"].filter((x): x is string => !!x);
}

// ── ④ 確かめ → 統括に1回だけ戻す ───────────────────────────────────────────
const KEEP_RE = /新着で.{0,25}出次第|ご満足.{0,15}見つかるまで/;
const OMIT_RE: Record<OmitKind, (t: string) => boolean> = {
  hours: (t) => /管理会社の営業時間が終了|営業時間外の為|明日一番で/.test(t),
  restate_conditions: (t) => (t.match(/・/g) ?? []).length >= 4 && /ご条件|ピックアップ/.test(t),
  restate_viewing: (t) => /\d{1,2}[/月]\d{1,2}日?[^\n]{0,30}(?:現地|エントランス|号室)|お気をつけてお越し/.test(t),
  cost_assert: (t) => /日割(?:家賃)?のみ|割引は(?:現時点で)?最大限|別途かかるのは/.test(t),
  double_apology: (t) => (t.match(/申し訳(?:御座|ござ)いません/g) ?? []).length >= 2,
  apply_promise: (t) => t.split(/\n|(?<=[！!。])/).some((s) => /お申し?込み?し(?:て)?お部屋(?:を)?[抑押]さ?え/.test(s) && !/お気に召されましたら|ご希望でしたら|よろしければ|できるか/.test(s)),
  deadline_promise: (t) => /明日中に|本日中に/.test(t),
};
export function detectOmitKinds(text: string): OmitKind[] {
  const t = String(text ?? "");
  return (Object.keys(OMIT_RE) as OmitKind[]).filter((k) => OMIT_RE[k](t));
}
export const hasKeepPromise = (text: string) => KEEP_RE.test(String(text ?? ""));

export type VerifyMiss = { kind: "keep_absent" | OmitKind; detail: string };
/** 下書きが重点どおりか（決定論・本文は変えない）。外れは統括に戻す材料 */
export function verifyDraft(draft: string, mf: MessageFocus): VerifyMiss[] {
  const out: VerifyMiss[] = [];
  if (mf.keep && !hasKeepPromise(draft)) out.push({ kind: "keep_absent", detail: "継続の約束が無い" });
  for (const k of detectOmitKinds(draft)) if (mf.omit.includes(k)) out.push({ kind: k, detail: `書かない事が入っている: ${OMIT_JA[k]}` });
  return out;
}
/** 統括に1回だけ戻すか。2回目は戻さない（元のまま・記録だけ）。黙って書き換えない */
export function sendBackDecision(misses: ReadonlyArray<VerifyMiss>, o: { alreadySentBack: boolean }): { action: "keep" | "send_back" | "keep_after_once"; reasons: string[] } {
  if (!misses.length) return { action: "keep", reasons: [] };
  const reasons = misses.map((m) => m.kind);
  return { action: o.alreadySentBack ? "keep_after_once" : "send_back", reasons };
}
/** 戻す時に統括（書き直しの1回）へ渡す注記。指摘の所だけ直す */
export function sendBackNote(misses: ReadonlyArray<VerifyMiss>, mf: MessageFocus): string {
  if (!misses.length) return "";
  return [`【文の統括から差し戻し（1回だけ）】重点「${MESSAGE_FOCUS_JA[mf.key]}」に合わせて、指摘の所だけ直した返信本文を1つ出す（説明は書かない）。`, ...misses.map((m) => `- ${m.detail}`)].join("\n");
}

// ── ⑤ digest ─────────────────────────────────────────────────────────────
export function composeConductorDigest(o: { mf: MessageFocus; read: string[]; order: string[]; misses: ReadonlyArray<VerifyMiss>; action: string }): string {
  return `重点=${o.mf.key}(${o.mf.source})｜読んだ=${o.read.join("・") || "なし"}｜順=${o.order.join(">")}｜継続=${o.mf.keep ? "添える" : "-"}｜確かめ=${o.misses.length ? o.misses.map((m) => m.kind).join("・") : "ok"}｜${o.action}`;
}

// ── ⑥ 物差し（竹内さんとの一致・原則の揃い方）────────────────────────────────
const norm = (s: string) => String(s ?? "").replace(/[\s😊😌🌟✨！!。、]/gu, "");
export function bigramSim(a: string, b: string): number {
  const g = (s: string) => { const x = norm(s); const m = new Map<string, number>(); for (let i = 0; i < x.length - 1; i++) { const k = x.slice(i, i + 2); m.set(k, (m.get(k) ?? 0) + 1); } return m; };
  const A = g(a), B = g(b); let inter = 0, na = 0, nb = 0;
  for (const v of A.values()) na += v; for (const v of B.values()) nb += v;
  for (const [k, v] of A) inter += Math.min(v, B.get(k) ?? 0);
  return na + nb ? (2 * inter) / (na + nb) : 1;
}
export type TakeuchiScore = {
  sim: number;
  /** 解剖の一番の要点の語（漢字・カタカナ2字以上）が下書きに半分以上あるか（解剖が無ければ null） */
  mainPointHit: boolean | null;
  /** 原則の揃い方: 下書きにあって竹内さんの文に無い「書かない事」の型 */
  extraKinds: OmitKind[];
  /** 竹内さんが継続の約束を入れたのに下書きに無い（逆は数えない） */
  keepMissed: boolean;
  /** 解剖の skipped_types（作業員5・竹内さんが書かなかった型）のうち、下書きに入っている物（解剖が無ければ []） */
  skippedButWritten: OmitKind[];
};
const OMIT_KINDS = Object.keys(OMIT_JA) as OmitKind[];
export function scoreAgainstTakeuchi(o: { draft: string; sent: string; mainPoint?: string | null; skippedTypes?: ReadonlyArray<string> | null }): TakeuchiScore {
  const sent = detectOmitKinds(o.sent);
  const extraKinds = detectOmitKinds(o.draft).filter((k) => !sent.includes(k));
  let mainPointHit: boolean | null = null;
  if (o.mainPoint) {
    const words = [...new Set(o.mainPoint.match(/[一-龯ァ-ヶー]{2,}/gu) ?? [])];
    mainPointHit = words.length ? words.filter((w) => o.draft.includes(w)).length * 2 >= words.length : null;
  }
  const inDraft = detectOmitKinds(o.draft);
  const skippedButWritten = (o.skippedTypes ?? []).filter((k): k is OmitKind => (OMIT_KINDS as string[]).includes(k) && inDraft.includes(k as OmitKind));
  return { sim: Math.round(bigramSim(o.draft, o.sent) * 100) / 100, mainPointHit, extraKinds, keepMissed: hasKeepPromise(o.sent) && !hasKeepPromise(o.draft), skippedButWritten };
}

// ── 前の流れの読み（route から呼ぶ・決定論）─────────────────────────────────────
/** 直前のこちらの送信の種類（物件を送った・募集終了や申込の報告・開いている約束） */
export function prevStaffKindOf(lastStaffText: string | null | undefined): PrevStaffKind {
  const t = String(lastStaffText ?? "");
  if (!t.trim()) return null;
  if (/先に(?:お)?申込み?が?(?:入|はい)って|募集終了|募集が終了|お申込みが入っておりました/.test(t)) return "ended_report";
  if (/お部屋(?:を)?お送りさせて(?:頂|いただ)きました|ピックアップさせて(?:頂|いただ)きました|オススメ出来るお部屋が募集に出ました|🔺|📍/.test(t)) return "property_sent";
  if (/確認させて(?:頂|いただ)きます|お送りさせて(?:頂|いただ)きます|作成しお送り/.test(t)) return "promise_open";
  return "other";
}
export const customerAskedNewOf = (t: string) => /新着|新しい物件|他(?:の|にも)(?:物件|お部屋)|また(?:良い|いい)(?:物件|お部屋)/.test(String(t ?? ""));

// ── route から呼ぶ1つの口（①〜③をまとめる・決定論）────────────────────────────
// 注: restate_conditions の網は竹内さんの送信 1,211通で 60通（5%・ほぼ条件の番）に当たる＝条件の番には使わない（了承・関係の番の「書かない事」だけ）。
//     他の型は 0〜9通（0〜0.7%）＝確かめ（記録）に使える。本文は書き換えない（出口の決定論ではない）。
export type ConductorRecent = { sender: string; text: string | null | undefined; createdAt?: string | null };
export function buildComposeConductor(o: {
  meta: unknown; scene: string | null; customerText: string; ackOnly: boolean; recent: ReadonlyArray<ConductorRecent>; name?: string | null; nowMs: number; blueprint: boolean; nearKeepShare?: number | null;
}): { mf: MessageFocus; note: string; read: string[]; order: string[] } {
  const inputs = readComposeInputs(o.meta);
  const staff = o.recent.filter((m) => m.sender === "staff" && (m.text ?? "").trim());
  const lastStaff = staff[staff.length - 1]?.text ?? null;
  const day = (ms: number) => Math.floor((ms + 9 * 3600_000) / 86_400_000);
  const today = day(o.nowMs);
  const keepSaidToday = staff.some((m) => m.createdAt && Number.isFinite(Date.parse(m.createdAt)) && day(Date.parse(m.createdAt)) === today && hasKeepPromise(m.text ?? ""));
  const mf = decideMessageFocus({ inputs, scene: o.scene, ackOnly: o.ackOnly, prevStaff: prevStaffKindOf(lastStaff), customerAskedNew: customerAskedNewOf(o.customerText), keepSaidToday, nearKeepShare: o.nearKeepShare ?? null });
  return { mf, note: messageFocusNote(mf, { name: o.name ?? null }), read: inputs.read, order: composeOrder(mf, { blueprint: o.blueprint }) };
}
