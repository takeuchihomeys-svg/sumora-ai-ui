// app/lib/decided-subfields.ts — 決めた事の「下の欄」×文の役目の対応表（下書き・純関数・作業員22・2026-11-13）
//
// 竹内さん 11/13（統括役経由）「届き方の表の欄を、細かく文を組み立てられるように細分化して強化する」。
//   各欄を下の欄に分け、どの下の欄が文のどの役目（頭・押さえ・信頼・潜在の一文・つなぎ・締め・AIX の1通目と2通目）に使われるかを1つの表に。
//   書き手には、役目ごとに必要な下の欄だけを渡す形にする（配線は後・既定 off）。
// 名前を合わせる相手: 作業員10（書く側の値の欄・形の欄）・作業員16（潜在の5段 latent_five）・作業員5（重点の下の種類 focus_sub）。この表は4人で1つ（直す時はここだけ）。
//   文の役目の名前は、作業員23 の compose-elements（bridge・press）と作業員10 の7つの欄（keyPoint・bridge・latentCover・trustHow・push）に寄せた仮の名前。
// 状態（now）: ok＝今の meta に値の欄がある／text＝文だけで型の欄が無い／none＝欄が無い（作る所の持ち主を書く）
export const SENTENCE_ROLES_FOR_SUB = ["head", "press", "trust", "latent", "bridge", "close", "aix1", "aix2"] as const;
export type SubRole = typeof SENTENCE_ROLES_FOR_SUB[number];
export const SUB_ROLE_JA: Record<SubRole, string> = {
  head: "頭（主の一文・一番先に応える事）", press: "押さえ（答え・事実で押さえる）", trust: "信頼（根拠・確かさ・こちらが動いた事）", latent: "潜在の一文（言っていない気がかりへ）",
  bridge: "つなぎ（次へ）", close: "締め", aix1: "AIX の1通目", aix2: "AIX の2通目",
};
/** 8役目 → 作業員10 の文の統括の文の役目（takeuchi-anatomy-roles の SentenceRole 13種が正）。aix1・aix2 は文の統括の設計図の外（AIX の書き手） */
export const SUB_ROLE_TO_SENTENCE_ROLES: Readonly<Record<SubRole, readonly string[]>> = {
  head: ["uke", "greet"], press: ["answer"], trust: ["trust"], latent: ["worry"], bridge: ["viewing", "apply", "estimate", "ask_send", "keep"], close: ["close"], aix1: [], aix2: [],
};
/** 役目ごとに受け取る値の欄（作業員10 の型名・2026-11-13 作業員10 から） */
export const SUB_ROLE_WRITER_SLOTS: Readonly<Record<SubRole, string>> = {
  head: "HeadWord（compose-head.ts）", press: "SevenFields.keyPoint・keyHow（PointMethod）・AnswerSource（compose-value-slots.ts）・ComposeFact（compose-asks-facts.ts）",
  trust: "TrustMethod（takeuchi-seven-read.ts）・compose-phrase-catalog.trustFor", latent: "SevenFields.latentCover {kind, what, fact, how}（LATENT_KINDS・LATENT_SUBKINDS）",
  bridge: "SevenFields.leadTo（LeadToV）・NextDest・NextStrength・applyStrengthFromFacts", close: "ClosingDecision（compose-value-slots.decideClosing・COMPOSE_CLOSING）", aix1: "AIX の統括の受け渡し（DECIDED_TO_AIX）", aix2: "2通目の材料（second-message-materials・DECIDED_TO_AIX）",
};
type M = Record<string, unknown>;
const obj = (v: unknown): M | null => (v && typeof v === "object" && !Array.isArray(v) ? (v as M) : null);
const arr = (v: unknown): unknown[] => (Array.isArray(v) ? v : []);
const s = (v: unknown, n = 40): string | null => (typeof v === "string" && v.trim() ? v.trim().slice(0, n) : null);
const asks = (m: M) => arr(obj(m.turn_contract)?.asks).map(obj).filter((a): a is M => !!a && !!s(a.quote));
import { factCertaintyOf, askPartsOf } from "./compose-decided";
import { checkResultReadyOf } from "./answer-source";
/** 近い番の意見の1行（conductor-near-opinion.nearOpinionLine）を型・一手・なぜに分ける */
export function nearParts(line: unknown): { type: string | null; move: string | null; why: string | null } {
  const t = typeof line === "string" ? line : "";
  if (!t) return { type: null, move: null, why: null };
  const why = t.match(/(\d+)件のうち (\d+)件（(\d+)%）/);
  return { type: t.match(/一番近い番: ([^。／]{1,40})/)?.[1] ?? null, move: t.match(/最初の一手は ([^。・\s]{1,30})/)?.[1] ?? null, why: why ? `近い番 ${why[1]}件中 ${why[2]}件（${why[3]}%）が同じ一手` : null };
}
const factAsk = (m: M) => asks(m).find((a) => ["company_fact", "material", "conversation", "general"].includes(String(a.basis)) && s(a.answer));

export type SubField = {
  field: string; sub: string; label: string;
  roles: SubRole[];
  now: "ok" | "text" | "none";
  /** どこから（meta の鍵）・無い時は作る所の持ち主 */
  from: string;
  /** 値（実物で数える・個人の値は返さず種類か有無だけ） */
  value: (m: M) => string | null;
};
export const SUB_FIELDS: readonly SubField[] = [
  // 重点と理由（作業員5）
  { field: "focus", sub: "focus.kind", label: "重点の種類", roles: ["bridge", "head"], now: "ok", from: "conductor_focus.focus", value: (m) => s(obj(m.conductor_focus)?.focus, 16) },
  { field: "focus", sub: "focus.sub", label: "重点の下の種類（focus_sub）", roles: ["bridge", "latent"], now: "none", from: "作業員5 CONDUCTOR_FOCUS_SUB（conductor_focus.focus_sub）", value: (m) => s(obj(m.conductor_focus)?.focus_sub, 16) },
  { field: "focus", sub: "focus.why", label: "理由の事実", roles: ["trust"], now: "text", from: "conductor_focus.why（文）", value: (m) => (s(obj(m.conductor_focus)?.why) ? "有" : null) },
  { field: "focus", sub: "focus.first", label: "この番で一番先に応える事", roles: ["head"], now: "ok", from: "turn_contract.lead_with（★先に）", value: (m) => { const lw = obj(m.turn_contract)?.lead_with; return typeof lw === "number" || typeof lw === "string" ? "有" : null; } },
  // 答えに使う事実
  { field: "fact", sub: "fact.value", label: "値", roles: ["press", "aix2"], now: "ok", from: "turn_contract.asks[].answer", value: (m) => (factAsk(m) ? "有" : null) },
  { field: "fact", sub: "fact.source", label: "出所（聞かれた事ごと: answer-source の7つ＝資料の値・物件の記録・会話・会社の事実・一般・スタッフだけ（管理会社／代表／電話）・確かめた結果）", roles: ["press", "trust"], now: "ok", from: "compose-decided.askPartsOf（turn_contract.asks[].basis・route）", value: (m) => { const p = askPartsOf(asks(m), { checkResultReady: checkResultReadyOf(m) }); return p.length ? p.map((x) => x.source.kind).join(",") : null; } },
  { field: "fact", sub: "fact.certainty", label: "確かさ（言い切れる／基本的に／確認が要る）", roles: ["press", "trust"], now: "ok", from: "compose-decided.certaintyOf（basis・route・確かめた結果・79cf95c8 の基本的に）", value: (m) => { const a = asks(m)[0]; return a ? factCertaintyOf(a, { checkResultReady: checkResultReadyOf(m) }) : null; } },
  { field: "fact", sub: "fact.for_ask", label: "どの依頼への答えか（聞かれた事ごとに 今言える部分／確認が要る部分）", roles: ["press"], now: "ok", from: "compose-decided.askPartsOf（1通に複数の問い＝依頼ごと・答えの文を確かめる約束で分ける）", value: (m) => { const p = askPartsOf(asks(m), { checkResultReady: checkResultReadyOf(m) }); return p.length ? `${p.length}件（今言える ${p.filter((x) => x.now).length}・確認が要る ${p.filter((x) => x.check).length}）` : null; } },
  // 潜在の気持ち（作業員16 の5段）
  { field: "latent", sub: "latent.object", label: "何について", roles: ["latent"], now: "none", from: "作業員16 latent_five.object（未 push）／今は latent_read.part（BRAIN_SEVEN_FIELDS 既定 off）", value: (m) => (obj(obj(m.latent_five)?.object) || obj(obj(m.latent_read)?.part) ? "有" : null) },
  { field: "latent", sub: "latent.concern", label: "何を気にしている（下の種類 LATENT_SUBKINDS）", roles: ["latent"], now: "text", from: "latent_five.concern／今は customer_mindset.anxiety.target（12種の向き）", value: (m) => s(obj(obj(m.customer_mindset)?.anxiety)?.target, 12) },
  { field: "latent", sub: "latent.reason", label: "なぜ", roles: ["latent", "trust"], now: "none", from: "latent_five.reason（竹内さんが応えた段で少ない）", value: (m) => (s(obj(obj(m.latent_five)?.reason)?.text) ? "有" : null) },
  { field: "latent", sub: "latent.expect", label: "この依頼での想定", roles: ["latent", "press", "bridge"], now: "none", from: "latent_five.expect", value: (m) => (s(obj(obj(m.latent_five)?.expect)?.text) ? "有" : null) },
  { field: "latent", sub: "latent.feeling", label: "気持ちと強さ", roles: ["latent"], now: "text", from: "latent_five.feeling（kind×strength）／今は customer_mindset.state", value: (m) => s(obj(m.customer_mindset)?.state, 12) },
  { field: "latent", sub: "latent.src", label: "出所（言葉か推測か）", roles: ["latent"], now: "none", from: "latent_five の各段の src（guess は言い切らない）", value: () => null },
  // 近い番の意見
  { field: "near", sub: "near.type", label: "どの番の型か", roles: ["trust"], now: "text", from: "near_opinion の「一番近い番」（nearParts）", value: (m) => (nearParts(m.near_opinion).type ? "有" : null) },
  { field: "near", sub: "near.move", label: "竹内さんがその時した一手", roles: ["bridge", "aix1"], now: "text", from: "near_opinion の「最初の一手」（nearParts）", value: (m) => nearParts(m.near_opinion).move },
  { field: "near", sub: "near.why", label: "なぜ似ているか", roles: ["trust"], now: "text", from: "near_opinion の「N件のうち M件（P%）」（nearParts・近い番の数と同じ一手の割合）", value: (m) => nearParts(m.near_opinion).why },
  // こちら側の状態
  { field: "our_side", sub: "our.sent", label: "送った物件と順番", roles: ["head", "aix2"], now: "ok", from: "action_ledger.facts.propertiesSentCount（順番は our_side_note の文・OUR_SIDE_TO_COMPOSE 既定 off）", value: (m) => { const n = obj(obj(m.action_ledger)?.facts)?.propertiesSentCount; return typeof n === "number" ? String(n) : null; } },
  { field: "our_side", sub: "our.open_promise", label: "開いている約束と期日", roles: ["head", "trust", "aix2"], now: "ok", from: "action_ledger.facts.pickupPromisedUnfulfilled（期日の欄は無い）", value: (m) => (obj(obj(m.action_ledger)?.facts)?.pickupPromisedUnfulfilled === true ? "有" : null) },
  { field: "our_side", sub: "our.checked", label: "確かめ済みの事実", roles: ["press", "trust"], now: "text", from: "our_side_note（文・既定 off）", value: (m) => (s(m.our_side_note) ? "有" : null) },
  { field: "our_side", sub: "our.viewing", label: "決まった内覧", roles: ["close"], now: "ok", from: "checkpoint_stage・action_ledger（viewingAppointment は帳面）", value: (m) => s(m.checkpoint_stage, 12) },
  // 刺さった所（作業員16 our_send_uptake）
  { field: "hooked", sub: "hook.property", label: "物件", roles: ["press", "aix2"], now: "ok", from: "our_send_uptake[].part（BRAIN_OUR_SEND_UPTAKE 既定 off）", value: (m) => (arr(m.our_send_uptake).some((u) => obj(u)?.hook === "hooked") ? "有" : null) },
  { field: "hooked", sub: "hook.point", label: "どの点（家賃・駅・設備・間取り…）", roles: ["press", "bridge", "aix2"], now: "ok", from: "our_send_uptake[].point（HOOK_POINTS）", value: (m) => s(obj(arr(m.our_send_uptake).find((u) => obj(u)?.hook === "hooked"))?.point, 12) },
  { field: "hooked", sub: "hook.degree", label: "強さ", roles: ["bridge", "close"], now: "ok", from: "our_send_uptake[].degree（curious・strong・decide）", value: (m) => s(obj(arr(m.our_send_uptake).find((u) => obj(u)?.hook === "hooked"))?.degree, 10) },
  { field: "hooked", sub: "hook.cue", label: "手がかりの言葉", roles: ["head"], now: "ok", from: "our_send_uptake[].cue", value: (m) => (s(obj(arr(m.our_send_uptake).find((u) => obj(u)?.hook === "hooked"))?.cue) ? "有" : null) },
  // 優先度（作業員16 の場面×状態の優先度の表・priority-table.ts・PRIORITY_TABLE 既定 off＝check_order.priority が無い間は値なし）
  { field: "priority", sub: "priority.first", label: "一番先に応える要件（Priority の名前）", roles: ["head", "press"], now: "ok", from: "check_order.priority.first（priority-table.priorityTableRecord）", value: (m) => s(obj(obj(m.check_order)?.priority)?.first, 16) },
  { field: "priority", sub: "priority.why", label: "なぜ先か（札 PRIORITY_WHY＝決め手・問い・疑問・不安・受け・言える部分・果たし・約束）", roles: ["head", "trust"], now: "ok", from: "check_order.priority.why_tag", value: (m) => s(obj(obj(m.check_order)?.priority)?.why_tag, 16) },
  { field: "priority", sub: "priority.why_order", label: "主の行の順の理由（設計図の why_order＝V2WhyOrder）", roles: ["head", "press", "latent"], now: "ok", from: "check_order.priority.why_order（PRIORITY_WHY_TO_V2）", value: (m) => s(obj(obj(m.check_order)?.priority)?.why_order, 16) },
  { field: "priority", sub: "priority.now", label: "今の番の出す物と答えの出所（this_turn・answer_source）", roles: ["press", "aix1"], now: "ok", from: "check_order.priority.this_turn・answer_source（brain-now-later の名前）", value: (m) => { const p = obj(obj(m.check_order)?.priority); return p && s(p.this_turn) ? `${p.this_turn}/${s(p.answer_source) ?? "-"}` : null; } },
  { field: "priority", sub: "priority.defer", label: "後に回す依頼の数（後の通・AIX へ）", roles: ["bridge", "close", "aix2"], now: "ok", from: "check_order.priority.deferred（行の order.deferred の数）", value: (m) => { const n = obj(obj(m.check_order)?.priority)?.deferred; return typeof n === "number" ? String(n) : null; } },
  { field: "priority", sub: "priority.combo", label: "返信と AIX の組と順番（SendCombo）", roles: ["aix1", "aix2"], now: "ok", from: "check_order.priority.combo（send-combo-table の名前）", value: (m) => s(obj(obj(m.check_order)?.priority)?.combo, 24) },
  { field: "priority", sub: "priority.avoid", label: "やらない事（触れない話題・繰り返さない条件）", roles: ["press", "close"], now: "ok", from: "check_order.priority.avoid（数）＋priority-table の行の avoid（文）", value: (m) => { const n = obj(obj(m.check_order)?.priority)?.avoid; return typeof n === "number" ? String(n) : null; } },
  // 目的と中期（作業員7）
  { field: "aim", sub: "aim.turn", label: "この番の目的", roles: ["close", "aix1"], now: "ok", from: "turn_aims.turnAim（BRAIN_TURN_AIMS・TURN_AIMS_AFTER 既定 off）／judge_basis.purpose", value: (m) => s(obj(m.turn_aims)?.turnAim, 20) ?? s(obj(m.judge_basis)?.purpose, 16) },
  { field: "aim", sub: "aim.mid", label: "次の2〜3番でどこへ", roles: ["bridge", "aix2"], now: "ok", from: "turn_aims.midAim／judge_next.dest", value: (m) => s(obj(m.turn_aims)?.midAim, 20) ?? s(obj(m.judge_next)?.dest, 16) },
  { field: "aim", sub: "aim.to_apply", label: "申込までの残り", roles: ["bridge"], now: "ok", from: "作業員1 の info-fill-map（申込までの地図の今の駅・足りない情報の数）＝統括の指示書の入力（CONDUCTOR_BRIEF=shadow で作る）", value: (m) => { const i = obj(obj(m.conductor_brief_inputs)?.info); if (!i) return null; const cells = arr(i.cells).map(obj); return `${s(i.node, 20) ?? "?"}・残り${cells.filter((c) => c && c.state !== "known").length}`; } },
  { field: "aim", sub: "aim.plant", label: "仕込み", roles: ["bridge"], now: "ok", from: "turn_aims.plant（next-move-detail の PlantFact）", value: (m) => (s(obj(m.turn_aims)?.plant) ? "有" : null) },
];
/** 役目ごとに渡す下の欄（書き手には役目ごとに要る物だけ） */
export function subsForRole(role: SubRole): string[] { return SUB_FIELDS.filter((x) => x.roles.includes(role)).map((x) => x.sub); }
/** 実物の1番で、下の欄ごとの値の有無（個人の値は返さない） */
export function subValuesOf(m: M): Record<string, string | null> { return Object.fromEntries(SUB_FIELDS.map((x) => [x.sub, x.value(m)])); }
