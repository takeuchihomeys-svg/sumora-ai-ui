// app/lib/compose-sentence-plan.ts — 文の統括が「理解した事」を1文ずつの設計図に書き出す（純関数・DB/LLM なし）
//
// 2026-11-11 作業員10（竹内さんの決定 KB P1 c3673fba「文の構成をする統括の部分も細かく細部までこだわる。細かくちゃんと理解できているように」・親 P0 575a7cd5）。
//   ① 受け取る: 一通の読み（何の物件・何の事・どの部分・今の状況・要点・最善・主と従＝KB d0b25520・ee7ddf07）と
//      竹内さんの7つの欄（押さえた要点・次へのつなぎ・誘導先・訴求・潜在意識のカバー・要点の押さえ方・信頼の作り方＝KB 1f5bd301）
//   ② 1文ずつの設計図: 役目（13種＝takeuchi-anatomy-roles の SENTENCE_ROLES・KB e94d6d27）・どの部分の何を書くか・どうやって・次に何へつなぐか・主か従か
//   ③ 順番は主を先、従は後（誘いへの答えの確定 → 脇の心配への答え → 次の一歩）
//   ④ 材料の無い欄は空のまま（作り話で埋めない＝行を作らない・書き手にも「作らない」と渡す）
//   ⑤ 物差し（scripts/audit-compose-understanding.ts）: 設計図の欄が竹内さんの同じ番の文の欄と合うか（書き上がった文だけで採点しない）
//
// 受け口（まだ無い欄は空で動く）:
//   - 作業員14 の一通の読み（主と従）: meta.turn_read.main / meta.turn_read.subs（または sub）＝ {what, about, property, part, route, intent}
//   - 作業員5 の竹内さんの7つの欄: meta.takeuchi_fields（または meta.compose_fields）＝
//       {key_point, bridge, lead_to, appeal:{property, points[]}, latent_cover:{kind, what}, key_how[], trust_how[]}（camelCase も読む）
//   - 今ある材料（無い時の代わり）: turn_contract（situation・asks[].about/property/route/quote・lead_with）・turn_read（target・intent・mood・feeling）・
//       main_point・latent_intent・customer_concern・appeal_timing・current_property
// スイッチ: COMPOSE_SENTENCE_PLAN=on（既定 off＝今と1文字も変わらない）。
// テスト: npx tsx app/lib/__tests__/compose-sentence-plan.test.ts
import type { SentenceRole } from "./takeuchi-anatomy-roles";
import { ROLE_LABEL } from "./takeuchi-anatomy-roles";
import { ABOUT_VALUES, ABOUT_JA, type RequestAbout } from "./request-ledger";
import { POINT_METHODS, TRUST_METHODS, type PointMethod, type TrustMethod, type PushStrength } from "./takeuchi-seven-read";

type Env = Record<string, string | undefined>;
const envOf = (): Env => (typeof process !== "undefined" ? process.env : {});
export function composeSentencePlanOn(env: Env = envOf()): boolean {
  return (env.COMPOSE_SENTENCE_PLAN ?? "").trim().toLowerCase() === "on";
}

// ── 欄の値（竹内さんの7つの欄の細かい型・KB 1f5bd301 の例から） ─────────────────────
export const LEAD_TOS = ["viewing", "apply", "estimate", "ask_send", "keep", "answer_only", "none"] as const;
export type LeadToV = typeof LEAD_TOS[number];
export const LEAD_TO_JA: Record<LeadToV, string> = { viewing: "内覧", apply: "申込・抑える", estimate: "見積", ask_send: "物件を送ってもらう", keep: "新着・関係をつなぐ", answer_only: "答えて終わり", none: "無し" };
export const APPEAL_POINTS = ["家賃", "広さ・間取り", "駅・場所", "新しさ", "設備", "初期費用", "空き・入居", "条件の合い方"] as const;
export type AppealPoint = typeof APPEAL_POINTS[number];
export const LATENT_KINDS = ["審査", "先に取られる", "費用", "入居日・時期", "住み心地・周り", "物件が見つからない", "内覧できない", "対応・信頼", "事情の変化"] as const;
export type LatentKind = typeof LATENT_KINDS[number];
// 要点の押さえ方・信頼の作り方の札は作業員5 の takeuchi-seven-read.ts（POINT_METHODS・TRUST_METHODS・main 48fb22ed）が正（同じ値を使う）
export const KEY_HOWS = POINT_METHODS;
export type KeyHow = PointMethod;
export const KEY_HOW_JA: Record<KeyHow, string> = {
  conclusion_first: "結論を先に", assert: "言い切る", numbers: "数字・日付・期限で示す", name_property: "物件名・号室で名指し", echo_words: "お客様の言葉・条件を拾う",
  one_change: "変わった1点だけ言う", weak_first: "弱点を先に認めて強みを言う", answer_by_thing: "物（物件・見積）で答える", reason_fact: "理由を物件の事実で言う", accept_first: "先に受ける",
};
export const TRUST_HOWS = TRUST_METHODS;
export type TrustHow = TrustMethod;
export const TRUST_HOW_JA: Record<TrustHow, string> = {
  support: "サポートの姿勢", effort: "こちらの手間を見せる", fact: "事実の裏付け", preempt: "先回り", deadline: "期限を切る", kept_promise: "前の約束・依頼を覚えている",
  options: "選択肢を残す", their_side: "お客様の立場の言葉", honest_weak: "弱点を正直に言う", meet: "会う機会を作る", flexible: "都合に合わせる",
};
export type { PushStrength };
/** 推した点の言葉 → 訴求の点（作業員5 の appeal.point は自由文なので型に寄せる・物差しで使う） */
const APPEAL_RE: Array<[RegExp, AppealPoint]> = [[/家賃|賃料|管理費込|万円/, "家賃"], [/広|帖|㎡|間取|LDK|1K|1DK/, "広さ・間取り"], [/駅|徒歩|立地|エリア/, "駅・場所"], [/築|新築|綺麗|リノベ|新しい/, "新しさ"], [/設備|オートロック|バス|トイレ|洗面|換気|宅配|ペット|駐車/, "設備"], [/初期|敷金|礼金|割引|フリーレント|費用/, "初期費用"], [/空き|入居|退去|募集|1部屋/, "空き・入居"], [/条件|ご希望|ピッタリ|好条件/, "条件の合い方"]];
export function appealPointsOf(text: string | null | undefined): AppealPoint[] { const t = String(text ?? ""); return APPEAL_RE.filter(([re]) => re.test(t)).map(([, k]) => k); }
/** 具体の潜在（自由文）→ 種類（物差しで使う・設計図には具体の文をそのまま渡す） */
const LATENT_RE: Array<[RegExp, LatentKind]> = [[/審査|保証|名義|収入|落ち/, "審査"], [/埋ま|先に|取られ|逃す|他の方/, "先に取られる"], [/内覧|内見|見られ/, "内覧できない"], [/虫|騒音|周り|環境|治安|換気|日当/, "住み心地・周り"], [/他社|おとり|オトリ|信用|対応|気まず/, "対応・信頼"], [/別れ|転勤|勤務|事情|一人/, "事情の変化"], [/入居|時期|退去|いつ|年末|間に合/, "入居日・時期"], [/費用|お金|高|払|初期|家賃/, "費用"], [/見つから|合う部屋|無い/, "物件が見つからない"]];
export function latentKindOf(text: string | null | undefined): LatentKind | null { const t = String(text ?? ""); return LATENT_RE.find(([re]) => re.test(t))?.[1] ?? null; }
const ROLES13: readonly SentenceRole[] = ["greet", "uke", "answer", "worry", "trust", "barrier", "viewing", "apply", "estimate", "ask_send", "keep", "promise", "close"];
const isRole = (v: unknown): v is SentenceRole => typeof v === "string" && (ROLES13 as readonly string[]).includes(v);

// ── ① 受け取る ──────────────────────────────────────────────────────────────
export type Route = "reply" | "promise" | "aix";
export type UnderstandingItem = { what: string | null; about: RequestAbout | null; property: string | null; part: string | null; route: Route | null; role: SentenceRole | null };
/** 一通の読み（KB d0b25520・ee7ddf07）。src＝どの材料から読んだか（記録・表に使う） */
export type TurnUnderstanding = {
  main: UnderstandingItem | null;
  subs: UnderstandingItem[];
  situation: string | null;
  mainPoint: string | null;
  src: { main: "turn_read" | "turn_contract" | "intent" | null; subs: "turn_read" | "turn_contract" | null };
};
/** 竹内さんの7つの欄（KB 1f5bd301）。src＝takeuchi_fields（作業員5）か今ある材料か */
export type SevenFields = {
  keyPoint: string | null;
  bridge: { role: SentenceRole | null; what: string | null } | null;
  leadTo: LeadToV | null;
  appeal: { property: string | null; points: AppealPoint[]; what?: string | null; how?: string | null } | null;
  latentCover: { kind: LatentKind | null; what: string | null; fact?: string | null; how?: string | null } | null;
  keyHow: KeyHow[];
  trustHow: TrustHow[];
  /** 押す／待つ（作業員5 の push・強く押すのは『物件の残り×決める合図』が重なった番だけ） */
  push: { push: boolean; strength: PushStrength | null; reason: string | null } | null;
  src: Partial<Record<"keyPoint" | "bridge" | "leadTo" | "appeal" | "latentCover" | "keyHow" | "trustHow" | "push", "takeuchi_fields" | "seven_read" | "material">>;
};

const obj = (v: unknown): Record<string, unknown> | null => (v && typeof v === "object" && !Array.isArray(v) ? (v as Record<string, unknown>) : null);
const str = (v: unknown, n = 60): string | null => {
  if (typeof v !== "string") return null;
  const t = v.replace(/\s+/g, " ").trim();
  if (!t || /^(null|none|なし|無し|-)$/i.test(t)) return null;
  return Array.from(t).slice(0, n).join("");
};
const pick = <T extends string>(list: readonly T[], v: unknown): T | null => (typeof v === "string" && (list as readonly string[]).includes(v.trim()) ? (v.trim() as T) : null);
const picks = <T extends string>(list: readonly T[], v: unknown): T[] => [...new Set((Array.isArray(v) ? v : typeof v === "string" ? v.split(/[,、・/|]/) : []).map((x) => pick(list, x)).filter((x): x is T => !!x))];
const aboutOf = (v: unknown): RequestAbout | null => pick(ABOUT_VALUES as readonly RequestAbout[], v);
const routeOf = (v: unknown): Route | null => (v === "reply" || v === "promise" || v === "aix" ? v : null);
const g = (o: Record<string, unknown> | null, ...ks: string[]): unknown => { if (!o) return undefined; for (const k of ks) if (o[k] !== undefined && o[k] !== null) return o[k]; return undefined; };

/** turn_read の意図（作業員14 TURN_INTENTS）→ 主の文の役目（意図がそのまま役目になる物だけ） */
const INTENT_ROLE: Record<string, SentenceRole> = {
  "内覧したい": "viewing", "申込したい・抑えたい": "apply", "お礼・了承": "uke", "検討する・保留・相談": "uke",
  "条件を伝える・言い直す": "keep", "もっと良い部屋・別の物件も見たい": "keep", "もっと広い部屋": "keep",
  "断り・他で決めた": "uke", "気に入った・感想": "viewing",
};
/** 道 → 主の文の役目（返信の本文が担う物。aix は返信では受けるだけ＝役目なし） */
const roleOfRoute = (r: Route | null): SentenceRole | null => (r === "reply" ? "answer" : r === "promise" ? "promise" : null);

/**
 * 何の事 × 道 → 役目（竹内さんの文の役目の定義に合わせる・物差し 24番で外れた形から 11/11）:
 *   探す条件の番の約束（ピックアップしてお送り）は「確かめる約束」ではなく keep（竹内さん q206・q207・q214）／
 *   送った物件への反応（検討します・拝見します）に返信で答える番は、中身の答えではなく受け（q022・q025・q109）。
 *   「気になります・いいですね」の反応だけ内覧へ（q055）＝ここは候補の網（turn_read の意図が来ればそちらが先）
 */
const INTEREST_RE = /気になり|気に入|いいですね|良いですね|素敵|ここ(?:に|が)(?:し|いい)/;
function roleOfItem(about: RequestAbout | null, route: Route | null, quote: string | null): SentenceRole | null {
  if (about === "search_condition" && (route === "reply" || route === "promise")) return "keep";
  if (about === "reaction_to_sent" && route === "reply") return INTEREST_RE.test(quote ?? "") ? "viewing" : "uke";
  return roleOfRoute(route);
}
function itemOf(o: Record<string, unknown> | null): UnderstandingItem | null {
  if (!o) return null;
  const route = routeOf(g(o, "route"));
  const about = aboutOf(g(o, "about"));
  const what = str(g(o, "what", "quote", "topic", "answer"), 80);
  const it: UnderstandingItem = {
    what, about, property: str(g(o, "property"), 40),
    part: str(g(o, "part", "detail"), 40), route, role: isRole(g(o, "role")) ? (g(o, "role") as SentenceRole) : roleOfItem(about, route, str(g(o, "quote"), 120) ?? what),
  };
  if (!it.role && typeof o.intent === "string" && INTENT_ROLE[o.intent]) it.role = INTENT_ROLE[o.intent];
  return it.what || it.about || it.property || it.part || it.role ? it : null;
}

/** ブレインのメタから一通の読みを取り出す（作業員14 の主と従 → 無ければ turn_contract の asks → 無ければ turn_read の意図）。無い欄は null */
export function readTurnUnderstanding(meta: unknown): TurnUnderstanding {
  const m = obj(meta) ?? {};
  const tr = obj(m.turn_read);
  const tc = obj(m.turn_contract);
  const out: TurnUnderstanding = { main: null, subs: [], situation: str(tc?.situation, 80), mainPoint: str(m.main_point, 80), src: { main: null, subs: null } };
  // 作業員14 の主と従（来れば従う・決め直さない）
  const trMain = itemOf(obj(g(tr, "main")));
  if (trMain) {
    out.main = trMain; out.src.main = "turn_read";
    const subs = g(tr, "subs", "sub");
    const arr = Array.isArray(subs) ? subs : subs ? [subs] : [];
    out.subs = arr.map((x) => itemOf(obj(x))).filter((x): x is UnderstandingItem => !!x).slice(0, 3);
    if (out.subs.length) out.src.subs = "turn_read";
  }
  // 今ある材料: turn_contract の asks（lead_with が主・残りが従）
  const asks = Array.isArray(tc?.asks) ? (tc!.asks as unknown[]).map((a) => obj(a)).filter((a): a is Record<string, unknown> => !!a) : [];
  if (!out.main && asks.length) {
    const li = typeof tc?.lead_with === "number" && tc.lead_with >= 0 && tc.lead_with < asks.length ? tc.lead_with : 0;
    out.main = itemOf(asks[li]); if (out.main) out.src.main = "turn_contract";
    out.subs = asks.filter((_, k) => k !== li).map((a) => itemOf(a)).filter((x): x is UnderstandingItem => !!x && x.route !== "aix").slice(0, 3);
    if (out.subs.length) out.src.subs = "turn_contract";
  }
  // 今ある材料: turn_read の対象・意図（TURN_READ=on の時だけある）
  const tgt = obj(g(tr, "target"));
  if (out.main) {
    if (!out.main.property) out.main.property = str(g(tgt, "property"), 40) ?? str(m.current_property, 40);
    if (!out.main.part) out.main.part = str(g(tgt, "detail"), 40);
    if (!out.main.role && typeof tr?.intent === "string" && INTENT_ROLE[tr.intent]) out.main.role = INTENT_ROLE[tr.intent];
  } else if (typeof tr?.intent === "string") {
    const role = INTENT_ROLE[tr.intent] ?? null;
    out.main = { what: str(tr.intent, 40), about: null, property: str(g(tgt, "property"), 40) ?? str(m.current_property, 40), part: str(g(tgt, "detail"), 40), route: null, role };
    out.src.main = "intent";
  } else if (tc?.close_only === true) {
    out.main = { what: null, about: null, property: null, part: null, route: null, role: "uke" };
    out.src.main = "turn_contract";
  }
  return out;
}

/** 気持ちの型（turn_read.mood.base・customer-mindset の12種）→ 潜在意識の種類（不安の型だけ。刺さっている・普通の依頼は潜在の心配にしない） */
const MOOD_LATENT: Record<string, LatentKind> = { 審査の不安: "審査", 先に取られる不安: "先に取られる", 安くしたい: "費用", 急いでいる: "入居日・時期", "不満・離れかけ": "対応・信頼" };
const CONCERN_LATENT: Array<[RegExp, LatentKind]> = [[/審査|保証/, "審査"], [/費用|家賃|初期|お金|高/, "費用"], [/入居|時期|退去|いつ/, "入居日・時期"], [/虫|騒音|周り|環境|治安|日当/, "住み心地・周り"], [/埋ま|先に|取られ/, "先に取られる"], [/内覧|内見/, "内覧できない"]];

/** 竹内さんの7つの欄（作業員5 の takeuchi_fields が来れば従う → 無い欄は今ある材料 → それも無ければ空） */
export function readSevenFields(meta: unknown): SevenFields {
  const m = obj(meta) ?? {};
  const out: SevenFields = { keyPoint: null, bridge: null, leadTo: null, appeal: null, latentCover: null, keyHow: [], trustHow: [], push: null, src: {} };
  // 作業員5 の SevenRead（takeuchi-seven-read.ts の形: point{what,how,skipped}・bridge{what,how}・lead・appeal{property,point,how}・
  //   latent{what,fact,how}・point_how[]・trust_how[]・push{push,strength,reason}）。鍵は seven_read / takeuchi_seven
  const sr = obj(m.seven_read) ?? obj(m.takeuchi_seven);
  if (sr) {
    const S = "seven_read" as const;
    const pt = obj(sr.point);
    out.keyPoint = str(g(pt, "what"), 80); if (out.keyPoint) out.src.keyPoint = S;
    const br = obj(sr.bridge);
    if (br && str(br.what)) { out.bridge = { role: isRole(br.role) ? br.role : null, what: join([str(br.what, 60), str(br.how, 40) ? `（${str(br.how, 40)}）` : null], "") }; out.src.bridge = S; }
    out.leadTo = pick(LEAD_TOS, sr.lead); if (out.leadTo) out.src.leadTo = S;
    const ap = obj(sr.appeal);
    if (ap && str(ap.point)) { const pts = appealPointsOf(String(ap.point)); out.appeal = { property: str(ap.property, 40), points: pts, what: str(ap.point, 60), how: str(ap.how, 40) }; out.src.appeal = S; }
    const lt = obj(sr.latent);
    if (lt && str(lt.what)) { out.latentCover = { kind: latentKindOf(String(lt.what)), what: str(lt.what, 60), fact: str(lt.fact, 60), how: str(lt.how, 40) }; out.src.latentCover = S; }
    out.keyHow = picks(KEY_HOWS, sr.point_how); if (out.keyHow.length) out.src.keyHow = S;
    out.trustHow = picks(TRUST_HOWS, sr.trust_how); if (out.trustHow.length) out.src.trustHow = S;
    const pu = obj(sr.push);
    if (pu) { out.push = { push: pu.push === true, strength: pu.strength === "strong" || pu.strength === "mid" || pu.strength === "weak" ? pu.strength : null, reason: str(pu.reason, 60) }; out.src.push = S; }
  }
  const tf = obj(m.takeuchi_fields) ?? obj(m.compose_fields);
  if (tf && !sr) {
    out.keyPoint = str(g(tf, "key_point", "keyPoint"), 80); if (out.keyPoint) out.src.keyPoint = "takeuchi_fields";
    const br = g(tf, "bridge");
    const bro = obj(br);
    if (bro || typeof br === "string") {
      out.bridge = bro ? { role: isRole(bro.role) ? bro.role : null, what: str(g(bro, "what", "part"), 60) } : { role: isRole(br) ? (br as SentenceRole) : null, what: isRole(br) ? null : str(br, 60) };
      if (!out.bridge.role && !out.bridge.what) out.bridge = null; else out.src.bridge = "takeuchi_fields";
    }
    out.leadTo = pick(LEAD_TOS, g(tf, "lead_to", "leadTo")); if (out.leadTo) out.src.leadTo = "takeuchi_fields";
    const ap = obj(g(tf, "appeal"));
    if (ap) { const pts = picks(APPEAL_POINTS, ap.points); if (pts.length) { out.appeal = { property: str(ap.property, 40), points: pts }; out.src.appeal = "takeuchi_fields"; } }
    const lc = obj(g(tf, "latent_cover", "latentCover"));
    if (lc) { const k = pick(LATENT_KINDS, lc.kind); const w = str(g(lc, "what", "concrete"), 60); if (k || w) { out.latentCover = { kind: k, what: w }; out.src.latentCover = "takeuchi_fields"; } }
    out.keyHow = picks(KEY_HOWS, g(tf, "key_how", "keyHow")); if (out.keyHow.length) out.src.keyHow = "takeuchi_fields";
    out.trustHow = picks(TRUST_HOWS, g(tf, "trust_how", "trustHow")); if (out.trustHow.length) out.src.trustHow = "takeuchi_fields";
  }
  // 今ある材料（ブレインの判断・読み）。言い回しの型（keyHow・trustHow）は今の材料に無い＝空のまま
  if (!out.keyPoint) { const k = str(m.main_point, 80); if (k) { out.keyPoint = k; out.src.keyPoint = "material"; } }
  if (!out.leadTo) {
    const at = obj(m.appeal_timing);
    const kind = at?.kind; const level = at?.level;
    if ((kind === "viewing" || kind === "apply") && (level === "must" || level === "suggest")) { out.leadTo = kind; out.src.leadTo = "material"; }
  }
  if (!out.latentCover) {
    const tr = obj(m.turn_read); const mood = obj(tr?.mood);
    const kind = (typeof mood?.base === "string" ? MOOD_LATENT[mood.base] : undefined)
      ?? (() => { const cc = obj(m.customer_concern); const t = `${cc?.topic ?? ""}${cc?.object ?? ""}`; return t ? CONCERN_LATENT.find(([re]) => re.test(t))?.[1] : undefined; })();
    const what = str(m.latent_intent, 60) ?? (kind ? str(tr?.feeling, 40) : null);
    const k2 = kind ?? latentKindOf(what);
    if (k2) { out.latentCover = { kind: k2, what }; out.src.latentCover = "material"; }
  }
  return out;
}

// ── ② 1文ずつの設計図 ─────────────────────────────────────────────────────────
export type PlanRow = {
  rank: "main" | "sub";
  role: SentenceRole;
  /** どの部分の何を書くか（物件のどの点・どの事実）。材料に無ければ null（書き手は作らない） */
  part: string | null;
  /** どうやって（言い切る・数字・名指し・手間を見せる 等）。無ければ null */
  how: string | null;
  /** 次に何へつなぐか。無ければ null */
  next: string | null;
  /** どの材料から（記録） */
  from: string;
};
export type SentencePlan = { rows: PlanRow[]; aixMain: boolean; empty: string[] };

const join = (xs: Array<string | null | undefined>, sep = "・") => { const v = xs.filter((x): x is string => !!x && !!x.trim()); return v.length ? v.join(sep) : null; };
const partOf = (it: UnderstandingItem | null): string | null => {
  if (!it) return null;
  const about = it.about && it.about !== "other" ? ABOUT_JA[it.about] : null;
  return join([it.property, it.part ?? about, it.part ? null : it.what && !it.property ? it.what : null], "の ");
};
const LEAD_ROLE: Partial<Record<LeadToV, SentenceRole>> = { viewing: "viewing", apply: "apply", estimate: "estimate", ask_send: "ask_send", keep: "keep" };

/** 理解（一通の読み＋7つの欄）→ 1文ずつの設計図。主を先・従は後。材料の無い欄は行にしない（empty に名前を残す） */
/** 理解（一通の読み＋7つの欄）→ 1文ずつの設計図。主を先・従は後。材料の無い欄は行にしない（empty に名前を残す） */
export function buildSentencePlan(u: TurnUnderstanding, s: SevenFields): SentencePlan {
  const rows: PlanRow[] = [];
  const empty: string[] = [];
  const aixMain = u.main?.route === "aix";
  const leadRole = s.leadTo ? LEAD_ROLE[s.leadTo] ?? null : null;
  const nextJa = s.bridge?.what ?? (s.bridge?.role ? ROLE_LABEL[s.bridge.role] : null) ?? (s.leadTo && s.leadTo !== "none" ? LEAD_TO_JA[s.leadTo] : null);
  const appealText = s.appeal ? `訴求: ${join([s.appeal.property ?? u.main?.property ?? null, s.appeal.what ?? join(s.appeal.points)], "の ")}${s.appeal.how ? `（${s.appeal.how}）` : ""}` : null;
  const worryHow: TrustHow[] = ["preempt", "fact"];
  // 主: 一通の読みの主（AIX の番の主は返信では受けるだけ＝行にしない）
  const mainRole = u.main?.role ?? null;
  if (u.main && mainRole && !aixMain) {
    rows.push({ rank: "main", role: mainRole, part: join([partOf(u.main), s.keyPoint && s.keyPoint !== u.main.what ? `要点: ${s.keyPoint}` : null], "／"), how: join(s.keyHow.map((k) => KEY_HOW_JA[k])), next: nextJa, from: u.src.main ?? "?" });
  } else empty.push(aixMain ? "主（AIX の番＝返信は受けるだけ）" : "主");
  // 従①: 脇の心配（潜在意識のカバー）＝主の答えの後。具体の中身と先回りに使う事実をそのまま渡す
  const lc = s.latentCover;
  if (lc && (lc.kind || lc.what)) {
    const how = join([lc.how ?? null, ...s.trustHow.filter((t) => worryHow.includes(t)).map((t) => TRUST_HOW_JA[t])]);
    rows.push({ rank: "sub", role: "worry", part: join([lc.what ?? lc.kind, lc.fact ? `使う事実: ${lc.fact}` : null], "／"), how, next: null, from: s.src.latentCover ?? "?" });
  } else empty.push("潜在意識のカバー");
  // 従②: 同じ一通の別の依頼（主と同じ役目でも別の部分）
  for (const it of u.subs) {
    const role = it.role ?? roleOfRoute(it.route);
    if (!role) continue;
    // 主と同じ役目・同じ事の依頼は1つの文にまとめる（竹内さん q208「お送り頂きました5件の募集状況確認させて頂きます」）
    if (u.main && role === mainRole && it.about === u.main.about) continue;
    if (rows.some((r) => r.rank === "sub" && r.role === role && r.from === (u.src.subs ?? "?") && it.about && r.part?.includes(ABOUT_JA[it.about]))) continue;
    rows.push({ rank: "sub", role, part: partOf(it), how: null, next: null, from: u.src.subs ?? "?" });
  }
  // 従③: 信頼の作り方（先回り・事実の裏付けは心配の行で使った）
  const hasWorry = rows.some((r) => r.role === "worry");
  const trustRest = s.trustHow.filter((t) => !(hasWorry && worryHow.includes(t)));
  if (trustRest.length) rows.push({ rank: "sub", role: "trust", part: appealText && !leadRole ? appealText : null, how: join(trustRest.map((t) => TRUST_HOW_JA[t])), next: null, from: s.src.trustHow ?? "?" });
  else if (!s.trustHow.length) empty.push("信頼の作り方");
  // 従④: 次の一歩（誘導先）。訴求はここに付ける（竹内さんの文の G: 推しは導く先の役目）。押す強さと理由（作業員5 の push）も
  const pushHow = s.push ? (s.push.push ? `押す強さ: ${({ strong: "強（推奨・抑えましょうまで）", mid: "中（如何でしょうか・時間枠）", weak: "弱（お気に召されましたら）" } as const)[s.push.strength ?? "weak"]}${s.push.reason ? `・理由: ${s.push.reason}` : ""}` : `押さない（待つ）${s.push.reason ? `・理由: ${s.push.reason}` : ""}`) : null;
  if (leadRole && leadRole !== mainRole) {
    rows.push({ rank: "sub", role: leadRole, part: appealText, how: pushHow, next: null, from: s.src.leadTo ?? "?" });
  } else if (!s.leadTo) empty.push("誘導先");
  if (appealText && !leadRole && !trustRest.length) rows.push({ rank: "sub", role: "trust", part: appealText, how: null, next: null, from: s.src.appeal ?? "?" });
  if (!s.appeal) empty.push("訴求");
  if (!s.keyHow.length) empty.push("要点の押さえ方");
  if (!s.bridge) empty.push("次へのつなぎ");
  return { rows, aixMain, empty };
}


/** 書き手への注記（1文ずつ）。主の行が無ければ空文字（今まで通り）。言い回しの例文は入れない（創作の文を誘わない） */
export function sentencePlanNote(p: SentencePlan): string {
  if (!p.rows.some((r) => r.rank === "main")) return "";
  const L = ["【✍️ 文の設計図（1文ずつ・文の統括）】主を先に、従はその後に。1行＝1〜2文。受け・挨拶・締めは今まで通り。"];
  p.rows.forEach((r, k) => {
    const bits = [r.part ? `何を: ${r.part}` : "何を: （材料に無い＝中身を作らない）", r.how ? `どうやって: ${r.how}` : null, r.next ? `次へ: ${r.next}` : null].filter(Boolean);
    L.push(`${k + 1}. 【${r.rank === "main" ? "主" : "従"}】${ROLE_LABEL[r.role]}｜${bits.join("｜")}`);
  });
  // 2026-11-11 統括役（試験 w10-csp-on2 の q145）: 「設計図に無い役目は足さない」の行は外した（答えを狭めた疑い）。
  //   代わりに、主が確かめる約束の時は、確かめる中身の事実（最短・可否・日付・金額）を言い切らせない（材料に無い事実は書かない）
  const mainRow = p.rows.find((r) => r.rank === "main");
  if (mainRow?.role === "promise") L.push("- 主は確かめる約束: 確かめる中身（最短の日・できる/できない・日付・金額）を本文で言い切らない（「難しい」「〜となります」と先に答えない）。材料（会話・資料・会社の事実）にある事だけ書く。");
  else L.push("- 材料（会話・資料・会社の事実）に無い事実・数字は書かない。");
  return L.join("\n");
}

/** digest の1行（主の役目・従の役目・空の欄） */
export function sentencePlanDigest(p: SentencePlan): string {
  const main = p.rows.find((r) => r.rank === "main");
  return `主=${main ? `${main.role}(${main.from})` : p.aixMain ? "aix" : "-"}｜従=${p.rows.filter((r) => r.rank === "sub").map((r) => r.role).join(",") || "-"}｜空=${p.empty.length}`.slice(0, 160);
}

// ── 欄の受け取りの表（物差しと報告で使う） ─────────────────────────────────────
export const UNDERSTANDING_FIELDS = ["何の物件", "何の事", "どの部分", "今の状況", "要点", "最善（道）", "主", "従", "押さえた要点", "次へのつなぎ", "誘導先", "訴求", "潜在意識のカバー", "要点の押さえ方", "信頼の作り方"] as const;
export type UnderstandingField = typeof UNDERSTANDING_FIELDS[number];
/** 欄ごとに「受け取った（材料にある）」「設計図に出た」か */
export function understandingCoverage(u: TurnUnderstanding, s: SevenFields, p: SentencePlan): Record<UnderstandingField, { got: boolean; inPlan: boolean }> {
  const main = p.rows.find((r) => r.rank === "main");
  const has = (x: unknown) => x !== null && x !== undefined && !(Array.isArray(x) && !x.length);
  const inMain = (x: string | null | undefined) => !!x && !!main?.part?.includes(x);
  return {
    何の物件: { got: has(u.main?.property), inPlan: inMain(u.main?.property) },
    何の事: { got: has(u.main?.about), inPlan: !!u.main?.about && !!main?.part?.includes(ABOUT_JA[u.main.about]) },
    どの部分: { got: has(u.main?.part), inPlan: inMain(u.main?.part) },
    今の状況: { got: has(u.situation), inPlan: false },
    要点: { got: has(u.mainPoint) || has(s.keyPoint), inPlan: !!main?.part?.includes("要点:") },
    "最善（道）": { got: has(u.main?.route), inPlan: !!main || p.aixMain },
    主: { got: has(u.main), inPlan: !!main },
    従: { got: u.subs.length > 0, inPlan: p.rows.some((r) => r.rank === "sub" && r.from === (u.src.subs ?? "-")) },
    押さえた要点: { got: has(s.keyPoint), inPlan: !!main?.part?.includes("要点:") },
    次へのつなぎ: { got: has(s.bridge), inPlan: !!main?.next && !!s.bridge },
    誘導先: { got: has(s.leadTo), inPlan: !!main?.next || p.rows.some((r) => r.rank === "sub" && !!s.leadTo && r.role === LEAD_ROLE[s.leadTo]) },
    訴求: { got: has(s.appeal), inPlan: p.rows.some((r) => !!r.part?.startsWith("訴求:")) },
    潜在意識のカバー: { got: has(s.latentCover), inPlan: p.rows.some((r) => r.role === "worry") },
    要点の押さえ方: { got: s.keyHow.length > 0, inPlan: !!main?.how },
    信頼の作り方: { got: s.trustHow.length > 0, inPlan: p.rows.some((r) => !!r.how && s.trustHow.some((t) => r.how!.includes(TRUST_HOW_JA[t]))) },
  };
}

// ── ⑤ 物差し: 設計図の欄 × 竹内さんの同じ番の文の欄 ──────────────────────────────────
/** 竹内さんの1通の欄（人が付けた正解・scripts/compose-understanding/gold-*.json） */
export type TakeuchiGold = {
  id: string;
  roles: SentenceRole[];
  mainRole: SentenceRole;
  property: string | null; about: RequestAbout | null; part: string | null;
  leadTo: LeadToV; bridgeRole: SentenceRole | null;
  appeal: AppealPoint[]; latent: LatentKind | null; latentWhat?: string | null;
  keyHow: KeyHow[]; trustHow: TrustHow[];
};
/** 設計図（または今の文の統括）から比べる欄だけ取り出した形 */
export type PlanFields = {
  roles: SentenceRole[]; mainRole: SentenceRole | null;
  property: string | null; about: RequestAbout | null; part: string | null;
  leadTo: LeadToV | null; bridgeRole: SentenceRole | null;
  appeal: AppealPoint[]; latent: LatentKind | null; keyHow: KeyHow[]; trustHow: TrustHow[];
};
export function planFieldsOf(u: TurnUnderstanding, s: SevenFields, p: SentencePlan): PlanFields {
  const main = p.rows.find((r) => r.rank === "main");
  const lead = s.leadTo ? LEAD_ROLE[s.leadTo] ?? null : null;
  return {
    roles: p.rows.map((r) => r.role), mainRole: main?.role ?? (p.aixMain ? null : u.main?.role ?? null),
    property: u.main?.property ?? null, about: u.main?.about ?? null, part: u.main?.part ?? null,
    leadTo: s.leadTo, bridgeRole: s.bridge?.role ?? lead,
    appeal: s.appeal?.points ?? [], latent: s.latentCover?.kind ?? null, keyHow: s.keyHow, trustHow: s.trustHow,
  };
}
const words = (t: string | null | undefined) => [...new Set(String(t ?? "").normalize("NFKC").match(/[一-龯ァ-ヶーA-Za-z0-9]{2,}/gu) ?? [])];
/** 物件・部分の当たり（語の半分以上が重なる・どちらも無い時は both_empty） */
function textHit(gold: string | null, plan: string | null): "hit" | "miss" | "both_empty" | "extra" {
  if (!gold && !plan) return "both_empty";
  if (!gold) return "extra";
  if (!plan) return "miss";
  const a = words(gold), b = words(plan).join(" ");
  if (!a.length) return "miss";
  return a.filter((w) => b.includes(w) || plan.normalize("NFKC").includes(w)).length * 2 >= a.length ? "hit" : "miss";
}
const catHit = <T>(gold: T | null, plan: T | null): "hit" | "miss" | "both_empty" | "extra" => (gold == null && plan == null ? "both_empty" : gold == null ? "extra" : plan == null ? "miss" : gold === plan ? "hit" : "miss");
const setHit = <T>(gold: T[], plan: T[]): "hit" | "miss" | "both_empty" | "extra" => (!gold.length && !plan.length ? "both_empty" : !gold.length ? "extra" : !plan.length ? "miss" : gold.some((x) => plan.includes(x)) ? "hit" : "miss");
export const SCORE_FIELDS = ["主の役目", "役目の組み合わせ", "主→従の順", "何の物件", "何の事", "どの部分", "誘導先", "次へのつなぎ", "訴求", "潜在意識のカバー", "要点の押さえ方", "信頼の作り方"] as const;
export type ScoreField = typeof SCORE_FIELDS[number];
export type FieldHit = "hit" | "miss" | "both_empty" | "extra";
const SOFT = new Set<SentenceRole>(["greet", "uke", "close"]);
const core = (xs: SentenceRole[]) => { const o: SentenceRole[] = []; for (const x of xs) if (!SOFT.has(x) && !o.includes(x)) o.push(x); return o; };
/** 1つの番の欄ごとの当たり。役目の組み合わせ＝挨拶・受け・締めを除いた役目の集合が同じ／主→従の順＝主の役目が竹内さんの中身の文の最初と同じか（受けが主の番は両方受けなら当たり） */
export function scoreFields(gold: TakeuchiGold, plan: PlanFields): Record<ScoreField, FieldHit> {
  const gc = core(gold.roles), pc = core(plan.roles);
  const sameSet = gc.length === pc.length && gc.every((x) => pc.includes(x));
  const goldFirst = SOFT.has(gold.mainRole) ? gold.mainRole : gc[0] ?? gold.mainRole;
  const planFirst = plan.mainRole && SOFT.has(plan.mainRole) ? plan.mainRole : pc[0] ?? plan.mainRole;
  return {
    主の役目: catHit(gold.mainRole, plan.mainRole),
    役目の組み合わせ: !gc.length && !pc.length ? "both_empty" : !pc.length ? "miss" : sameSet ? "hit" : "miss",
    "主→従の順": catHit(goldFirst, planFirst ?? null),
    何の物件: textHit(gold.property, plan.property),
    何の事: catHit(gold.about, plan.about),
    どの部分: textHit(gold.part, plan.part),
    誘導先: catHit(gold.leadTo === "none" ? null : gold.leadTo, plan.leadTo === "none" ? null : plan.leadTo),
    次へのつなぎ: catHit(gold.bridgeRole, plan.bridgeRole),
    訴求: setHit(gold.appeal, plan.appeal),
    潜在意識のカバー: catHit(gold.latent, plan.latent),
    要点の押さえ方: setHit(gold.keyHow, plan.keyHow),
    信頼の作り方: setHit(gold.trustHow, plan.trustHow),
  };
}
/** 欄ごとの集計: 竹内さんに値がある番のうち当たった数（主の指標）・値が無いのに設計図が埋めた数（作り話の目安） */
export function tallyFields(rows: ReadonlyArray<Record<ScoreField, FieldHit>>): Record<ScoreField, { goldHas: number; hit: number; extra: number; bothEmpty: number }> {
  const out = {} as Record<ScoreField, { goldHas: number; hit: number; extra: number; bothEmpty: number }>;
  for (const f of SCORE_FIELDS) {
    const xs = rows.map((r) => r[f]);
    out[f] = { goldHas: xs.filter((x) => x === "hit" || x === "miss").length, hit: xs.filter((x) => x === "hit").length, extra: xs.filter((x) => x === "extra").length, bothEmpty: xs.filter((x) => x === "both_empty").length };
  }
  return out;
}
