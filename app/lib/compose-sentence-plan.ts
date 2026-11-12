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
// スイッチ: COMPOSE_SENTENCE_PLAN（2026-11-12 統括役: 既定 on・6問の前後比べで pathWorse 0・essenceWorse 0・確かな悪化 0（w10-csp-maj6-p2・maj6c）。戻す =off）。
// テスト: npx tsx app/lib/__tests__/compose-sentence-plan.test.ts
import type { SentenceRole } from "./takeuchi-anatomy-roles";
import { ROLE_LABEL } from "./takeuchi-anatomy-roles";
import { ABOUT_VALUES, ABOUT_JA, type RequestAbout } from "./request-ledger";
import { takeuchiHowFor } from "./compose-how-table";
import { POINT_METHODS, TRUST_METHODS, type PointMethod, type TrustMethod, type PushStrength } from "./takeuchi-seven-read";

type Env = Record<string, string | undefined>;
const envOf = (): Env => (typeof process !== "undefined" ? process.env : {});
export function composeSentencePlanOn(env: Env = envOf()): boolean {
  return (env.COMPOSE_SENTENCE_PLAN ?? "").trim().toLowerCase() !== "off";
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
/** answer＝ブレインが決めた答えの中身（asks[].answer）・when/whose＝いつの事・誰の事（既定の now・customer 以外だけ） */
export type UnderstandingItem = { what: string | null; about: RequestAbout | null; property: string | null; part: string | null; route: Route | null; role: SentenceRole | null; answer?: string | null; when?: string | null; whose?: string | null };
/** 一通の読み（KB d0b25520・ee7ddf07）。src＝どの材料から読んだか（記録・表に使う） */
export type TurnUnderstanding = {
  main: UnderstandingItem | null;
  subs: UnderstandingItem[];
  situation: string | null;
  mainPoint: string | null;
  src: { main: "turn_read" | "turn_contract" | "intent" | null; subs: "turn_read" | "turn_contract" | null };
  /** 作業員14 の turn_focus: 主に対してこの番でする事・後で答える/触れない従・話題ごとの並び（turn_topics） */
  mainMove: string | null; later: string[]; topics: string[];
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
    // 2026-11-12 受け渡しの漏れ（竹内さん「細分化された判断が文の構成に届くように」）: 答えの中身・いつ・誰の事も運ぶ
    answer: str(g(o, "answer"), 60), when: (() => { const w = str(g(o, "when"), 20); return w && w !== "now" ? w : null; })(), whose: (() => { const w = str(g(o, "whose"), 20); return w && w !== "customer" ? w : null; })(),
  };
  if (!it.role && typeof o.intent === "string" && INTENT_ROLE[o.intent]) it.role = INTENT_ROLE[o.intent];
  return it.what || it.about || it.property || it.part || it.role ? it : null;
}

/** ブレインのメタから一通の読みを取り出す（作業員14 の主と従 → 無ければ turn_contract の asks → 無ければ turn_read の意図）。無い欄は null */
export function readTurnUnderstanding(meta: unknown): TurnUnderstanding {
  const m = obj(meta) ?? {};
  const tr = obj(m.turn_read);
  const tc = obj(m.turn_contract);
  const out: TurnUnderstanding = { main: null, subs: [], situation: str(tc?.situation, 80), mainPoint: str(m.main_point, 80), src: { main: null, subs: null }, mainMove: null, later: [], topics: [] };
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
    out.subs = asks.filter((_, k) => k !== li).map((a) => itemOf(a)).filter((x): x is UnderstandingItem => !!x && x.route !== "aix").slice(0, 8);
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
  // 2026-11-12 作業員14 の組み合わせた理解（meta.turn_focus・TURN_READ_FOCUS）: 主の役目とこの番でする事・従の扱い（後で答える・触れないは行にしない）
  const tf = obj(m.turn_focus);
  const tfMain = obj(tf?.main), tfSub = obj(tf?.sub);
  if (tfMain) {
    const r = typeof tfMain.intent === "string" ? INTENT_ROLE[tfMain.intent] : undefined;
    const move = str(tfMain.move, 30);
    if (!out.main) { out.main = { what: str(tfMain.intent, 30), about: null, property: str(m.current_property, 40), part: null, route: null, role: r ?? null }; out.src.main = "turn_read"; }
    else if (r && out.main.route !== "aix") out.main.role = r;
    if (move) out.mainMove = move;
  }
  if (tfSub) {
    const mv = str(tfSub.move, 10);
    const what = join([str(tfSub.about, 20), str(tfSub.intent, 30)], "・");
    if (mv === "後で答える" || mv === "触れない") out.later.push(`${what}（${mv}）`);
    else if (what) out.subs.push({ what, about: null, property: null, part: `${what}${mv === "一言添える" ? "（一言だけ）" : ""}`, route: "reply", role: (typeof tfSub.intent === "string" ? INTENT_ROLE[tfSub.intent] : undefined) ?? "answer" });
  }
  // 話題ごと（meta.turn_topics・TURN_READ_TOPICS）: 従の話題も従の行に・前の話の持ち出し（ref）は結び付けて答える
  const tps = Array.isArray(m.turn_topics) ? (m.turn_topics as unknown[]).map((x) => obj(x)).filter((x): x is Record<string, unknown> => !!x) : [];
  for (const tp of tps) {
    const q = str(tp.quote, 30); const ref = str(tp.ref, 40);
    out.topics.push(`${tp.role === "主" ? "主" : "従"}: ${q ?? str(tp.about, 20) ?? "?"}${ref ? `（前の話: ${ref}）` : ""}`);
  }
  // 2026-11-12 turn_read の2番目の意図も従に（主と違う役目になる時だけ）
  const i2 = typeof tr?.intent2 === "string" ? INTENT_ROLE[tr.intent2] : undefined;
  if (i2 && out.main && i2 !== out.main.role && !out.subs.some((x) => x.role === i2)) out.subs.push({ what: str(tr!.intent2, 40), about: null, property: null, part: null, route: null, role: i2 });
  return out;
}

// ── ①b 番の文脈（設計図の上に置く「受け取った読み」・2026-11-12 竹内さん「細分化された判断が文の構成に届くように」） ─────────────
/** 潜在の4欄の入れ子（作業員5 の LatentFour: trigger{kind,text}・part{property,point}・feeling{what,strength}・want・fact）も平らな形も同じ形に */
function flatLatent(lt: Record<string, unknown>): LatentFour {
  const t = g(lt, "trigger", "why", "cause"), p = g(lt, "part", "object"), fe = g(lt, "feeling", "mood");
  const to = obj(t), po = obj(p), fo = obj(fe);
  return {
    trigger: to ? str(to.text, 40) : str(t, 40),
    part: po ? join([str(po.property, 30), str(po.point, 30)], "の ") : str(p, 40),
    feeling: fo ? str(fo.what, 40) : str(fe, 40),
    strength: fo ? str(fo.strength, 10) : str(g(lt, "strength", "degree"), 10),
    want: str(g(lt, "want", "wants", "goal"), 40),
  };
}
/** 作業員14 の潜在の4欄（KB d72ad06b: きっかけ・何の部分・どんな気持ちと強さ・本当はどうしたいか）。鍵は turn_read.latent か latent_read */
export type LatentFour = { trigger: string | null; part: string | null; feeling: string | null; strength: string | null; want: string | null };
export type ComposeContext = {
  situation: string | null; background: string | null; focus: string | null; timeline: string | null; goal: string | null;
  three: { surface: string | null; worry: string | null; relief: string | null } | null;
  lead: { kind: string; answer: string } | null;
  latent4: LatentFour | null;
  mood: { base: string; object: string | null; degree: string | null } | null;
  feeling: string | null;
  omitted: string[]; skipped: string | null; nextIntent: string | null;
  latentIntent: string | null; concern: string | null; appealTiming: string | null; hesitancy: string | null;
  emotion: string | null; mindset: string | null; stance: string | null; dirLead: string | null;
  later: string[]; topics: string[];
  /** 2026-11-12 作業員4（OUR_SIDE_TO_COMPOSE）: こちら側の状態（開いている約束・直前の AIX・送った物件・退去予定・確かめ済みの事実）の行。道は決まった後の文の材料だけ */
  ourSide?: string[];
};
export function readComposeContext(meta: unknown, extra: { nextIntent?: string | null } = {}): ComposeContext {
  const m = obj(meta) ?? {};
  const tc = obj(m.turn_contract), tr = obj(m.turn_read), mp = obj(m.message_plan), cf = obj(m.conductor_focus), tl = obj(m.three_layer), pa = obj(m.plan_ahead), sr = obj(m.seven_read) ?? obj(m.takeuchi_seven);
  const lt = obj(g(tr, "latent")) ?? obj(m.latent_read);
  const latent4: LatentFour | null = lt ? flatLatent(lt) : null;
  const ld = obj(g(tr, "lead"));
  const md = obj(g(tr, "mood"));
  const parts = Array.isArray(mp?.parts) ? (mp!.parts as unknown[]).map((p) => obj(p)).filter((p): p is Record<string, unknown> => !!p) : [];
  return {
    situation: str(tc?.situation, 80),
    background: str(tc?.background, 100) ?? str(mp?.background, 80),
    focus: cf && typeof cf.focus === "string" ? join([cf.focus, str(cf.why, 40)], "＝") : null,
    timeline: str(m.future_timeline, 30),
    goal: str(pa?.goal, 40),
    three: tl && (str(tl.surface) || str(tl.worry) || str(tl.relief)) ? { surface: str(tl.surface, 40), worry: str(tl.worry, 50), relief: str(tl.relief, 50) } : null,
    lead: ld && typeof ld.kind === "string" && typeof ld.answer === "string" ? { kind: ld.kind, answer: ld.answer } : null,
    latent4: latent4 && Object.values(latent4).some(Boolean) ? latent4 : null,
    mood: md && typeof md.base === "string" ? { base: md.base, object: str(md.object, 20), degree: str(md.degree, 6) } : null,
    feeling: str(tr?.feeling, 30) ?? str(tc?.feeling, 30),
    omitted: parts.filter((p) => p.include === "omit").map((p) => str(p.meaning, 40)).filter((x): x is string => !!x).slice(0, 3),
    skipped: str(g(obj(sr?.point), "skipped"), 50),
    nextIntent: str(extra.nextIntent, 30),
    latentIntent: str(m.latent_intent, 60),
    concern: (() => { const cc = obj(m.customer_concern); return cc ? join([str(cc.topic, 20), str(cc.object, 30)], "・") : null; })(),
    appealTiming: (() => { const at = obj(m.appeal_timing); return at && typeof at.kind === "string" ? join([`${at.kind}/${String(at.level ?? "")}`, str(at.reason, 50)], "＝") : null; })(),
    hesitancy: str(m.hesitancy_pattern, 20),
    emotion: str(m.customer_emotion, 30),
    later: readTurnUnderstanding(m).later ?? [], topics: readTurnUnderstanding(m).topics ?? [],
    ourSide: typeof m.our_side_note === "string" ? m.our_side_note.split("\n").map((x) => x.trim()).filter(Boolean).slice(0, 8) : [],
    dirLead: (() => { const d = leadFromDirection(m.reply_direction); return d && d !== "none" ? LEAD_TO_JA[d] : null; })(),
    mindset: (() => { const cm = obj(m.customer_mindset); if (!cm || typeof cm.state !== "string") return null; const ax = obj(cm.anxiety); return join([cm.state, ax ? join([str(ax.target, 20), str(ax.direction, 6)], "・") : null, str(cm.hesitation, 20)], "／"); })(),
    stance: join([str(m.engagement_stance, 6), str(m.purchase_signal_level, 6) ? `買う合図 ${str(m.purchase_signal_level, 6)}` : null], "・"),
  };
}
/** 文脈の行（あれば）。材料の無い行は出さない */
export function composeContextLines(c: ComposeContext): string[] {
  const L: string[] = [];
  const st = join([c.situation ? `今の状況: ${c.situation}` : null, c.background ? `背景: ${c.background}` : null, c.timeline ? `時期: ${c.timeline}` : null], "／");
  if (st) L.push(`- ${st}`);
  if (c.focus) L.push(`- 統括の重点: ${c.focus}`);
  if (c.three) L.push(`- 表の問い→奥の心配→安心の条件: ${[c.three.surface, c.three.worry, c.three.relief].map((x) => x ?? "－").join(" → ")}`);
  if (c.latent4) L.push(`- 潜在: ${join([c.latent4.trigger ? `きっかけ ${c.latent4.trigger}` : null, c.latent4.part ? `何の部分 ${c.latent4.part}` : null, c.latent4.feeling ? `気持ち ${c.latent4.feeling}${c.latent4.strength ? `（${c.latent4.strength}）` : ""}` : null, c.latent4.want ? `本当はしたい事 ${c.latent4.want}` : null], "・")}`);
  const fe = join([c.mood ? join([c.mood.base, c.mood.object, c.mood.degree], "・") : null, c.feeling, c.mindset, c.emotion], "／");
  if (fe) L.push(`- 気持ち: ${fe}`);
  const li = join([c.latentIntent ? `送ってきた動機 ${c.latentIntent}` : null, c.concern ? `気にしている事 ${c.concern}` : null, c.hesitancy ? `迷いの型 ${c.hesitancy}` : null], "・");
  if (li) L.push(`- ${li}`);
  if (c.appealTiming) L.push(`- 訴求のタイミング（ブレイン）: ${c.appealTiming}`);
  if (c.dirLead) L.push(`- 方向の文の誘導先（ブレイン）: ${c.dirLead}`);
  if (c.stance) L.push(`- 押す・待つ（ブレイン）: ${c.stance}`);
  if (c.lead) L.push(`- 直前のこちらの誘導（${c.lead.kind}）への答え: ${c.lead.answer}${c.lead.answer === "応じた" ? "＝同じ誘導を繰り返さず一段進める" : ""}`);
  const nx = join([c.goal ? `目指す事 ${c.goal}` : null, c.nextIntent ? `次にしてほしい事 ${c.nextIntent}` : null], "・");
  if (nx) L.push(`- ${nx}`);
  if (c.topics.length) L.push(`- 話題（出てきた順）: ${c.topics.join("／")}`);
  if (c.ourSide?.length) L.push("- こちら側の状態（もう送った・伝えた事。食い違わない・同じ事を繰り返さない・道は決まっている）:", ...c.ourSide.map((x) => `  ${x}`));
  const om = [...c.omitted, ...c.later, ...(c.skipped ? [c.skipped] : [])];
  if (om.length) L.push(`- 今回は入れない・後に回す: ${om.join("／")}`);
  return L;
}


/** 気持ちの型（turn_read.mood.base・customer-mindset の12種）→ 潜在意識の種類（不安の型だけ。刺さっている・普通の依頼は潜在の心配にしない） */
const MOOD_LATENT: Record<string, LatentKind> = { 審査の不安: "審査", 先に取られる不安: "先に取られる", 安くしたい: "費用", 急いでいる: "入居日・時期", "不満・離れかけ": "対応・信頼" };
// 2026-11-12 作業員5 の外れの束（q072: concern「時期:埋まる」を費用・時期に読んだ）: 先に取られるを先に・騒音治安も住み心地
const CONCERN_LATENT: Array<[RegExp, LatentKind]> = [[/埋ま|先に|取られ|逃/, "先に取られる"], [/審査|保証/, "審査"], [/虫|騒音|周り|環境|治安|日当|音/, "住み心地・周り"], [/費用|家賃|初期|お金|高/, "費用"], [/入居|時期|退去|いつ/, "入居日・時期"], [/内覧|内見/, "内覧できない"]];

/**
 * ブレインの方向の文（reply_direction）の言葉 → 誘導先（2026-11-12 作業員5 の外れの束・統括役の対応表: 答える→answer_only／ピックアップ…お送り→keep／
 *   伺う・お送り頂ければ→ask_send／抑え→apply）。ブレインが書いた方向を写すだけ（決め直さない）。決まった型の文（「お客様に聞かれた事に答える返信にする」）の
 *   頭は答えるだけとして読む。順: 抑え → 見積 → 関係を続ける・探す → 送ってもらう・伺う → 内覧へ → 答える
 */
const DIR_LEAD: Array<[RegExp, LeadToV]> = [
  [/抑え|押さえ|お申込(?:み)?(?:へ|を|で|し)|申込(?:へ|を勧|で抑)/, "apply"],
  [/見積/, "estimate"],
  [/ピックアップ|新着|探し(?:を)?(?:続|再開)|再開|関係を(?:切らず|つな|続)|全力で/, "keep"],
  [/伺う|伺い|お送り頂け|送ってもら|教えて(?:頂|いただ|もら)|お聞かせ|聞く|ヒアリング/, "ask_send"],
  [/内覧(?:に|へ|を)(?:誘|勧|ご案内)|ご案内(?:する|を)|内見(?:に|を)誘/, "viewing"],
  [/答え|伝え|説明|正直に/, "answer_only"],
];
export function leadFromDirection(dir: unknown): LeadToV | null {
  const t = typeof dir === "string" ? dir.replace(/頼まれていない[^。]*?(?:足さない|書かない)/g, "") : "";
  if (!t.trim()) return null;
  return DIR_LEAD.find(([re]) => re.test(t))?.[1] ?? null;
}
/** 潜在の種類 → 竹内さんが先回りに使った事実の型（作業員5 の latent4-types-198: 型に入る156通の多い順・弱い参考） */
export const LATENT_FACT_TYPES: Partial<Record<LatentKind, string>> = {
  費用: "最大限割引・御見積／敷金礼金なし・フリーレント／分割（カード）",
  先に取られる: "抑えてから内覧・申込で抑える／キャンセル料の線",
  審査: "保証会社（通りやすい・別の保証会社）",
  物件が見つからない: "ピックアップ・新着",
  内覧できない: "抑えてから内覧・申込で抑える",
};

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
    // 2026-11-12 受け渡しの漏れ: 訴求のタイミングの理由（appeal_timing.reason）も押す・待つの理由として運ぶ（強さは決めない）
    if (!out.push && at && typeof at.reason === "string" && (kind === "viewing" || kind === "apply" || level === "avoid")) { out.push = { push: level === "must" || level === "suggest", strength: null, reason: str(at.reason, 50) }; out.src.push = "material"; }
  }
  if (!out.leadTo) { const d = leadFromDirection(m.reply_direction); if (d) { out.leadTo = d; out.src.leadTo = "material"; } }
  if (!out.latentCover) {
    // 2026-11-12 作業員14 の潜在の4欄（KB d72ad06b）・3段の奥の心配（three_layer.worry）を先に
    const tr0 = obj(m.turn_read);
    const lt = obj(g(tr0, "latent")) ?? obj(m.latent_read);
    const ltf = lt ? flatLatent(lt) : null;
    const ltWhat = ltf ? join([ltf.part, ltf.feeling], "で ") : null;
    const tlWorry = str(obj(m.three_layer)?.worry, 50);
    const w0 = ltWhat ?? tlWorry;
    if (w0) { out.latentCover = { kind: latentKindOf(w0), what: w0, how: str(obj(m.three_layer)?.relief, 50) ? `安心の条件: ${str(obj(m.three_layer)?.relief, 50)}` : null }; out.src.latentCover = "material"; }
  }
  if (!out.latentCover) {
    const tr = obj(m.turn_read); const mood = obj(tr?.mood);
    // 2026-11-12: ブレインの customer_concern（何を気にしているか）を気持ちの型より先に（作業員5 の外れの束 q072・q064）
    const cc = obj(m.customer_concern);
    const ccText = cc ? join([str(cc.topic, 20), str(cc.object, 30)], ":") : null;
    const kind = (ccText ? CONCERN_LATENT.find(([re]) => re.test(ccText))?.[1] : undefined)
      ?? (typeof mood?.base === "string" ? MOOD_LATENT[mood.base] : undefined);
    const what = str(m.latent_intent, 60) ?? ccText ?? (kind ? str(tr?.feeling, 40) : null);
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
/** how＝設計図が使った押さえ方・信頼の作り方（src: 番の材料 turn／場面の傾向表 table・tableKey＝引いた表の行） */
export type SentencePlan = { rows: PlanRow[]; aixMain: boolean; empty: string[]; ctx?: ComposeContext | null; how?: { key: KeyHow[]; trust: TrustHow[]; src: "turn" | "table" | null; tableKey?: string | null } };

const join = (xs: Array<string | null | undefined>, sep = "・") => { const v = xs.filter((x): x is string => !!x && !!x.trim()); return v.length ? v.join(sep) : null; };
const partOf = (it: UnderstandingItem | null): string | null => {
  if (!it) return null;
  const about = it.about && it.about !== "other" ? ABOUT_JA[it.about] : null;
  const base = join([it.property, about, it.part, it.part ? null : it.what && !it.property ? it.what : null], "の ");
  return join([base, it.answer ? `答え: ${it.answer}` : null, it.when ? `いつ: ${it.when}` : null, it.whose ? `誰の事: ${it.whose}` : null], "／");
};
const LEAD_ROLE: Partial<Record<LeadToV, SentenceRole>> = { viewing: "viewing", apply: "apply", estimate: "estimate", ask_send: "ask_send", keep: "keep" };

/** 理解（一通の読み＋7つの欄）→ 1文ずつの設計図。主を先・従は後。材料の無い欄は行にしない（empty に名前を残す） */
/** 理解（一通の読み＋7つの欄）→ 1文ずつの設計図。主を先・従は後。材料の無い欄は行にしない（empty に名前を残す） */
export function buildSentencePlan(u: TurnUnderstanding, s: SevenFields, o: { scene?: string | null; ctx?: ComposeContext | null } = {}): SentencePlan {
  const ctx = o.ctx ?? null;
  const rows: PlanRow[] = [];
  const empty: string[] = [];
  const aixMain = u.main?.route === "aix";
  const leadRole = s.leadTo ? LEAD_ROLE[s.leadTo] ?? null : null;
  // 次へ: つなぎ → 誘導先 → 前の誘導に応じた番は一段進める → 潜在の本当はしたい事 → 次にしてほしい事（構成の意図）→ 目指す事（次の数手）
  const nextJa = s.bridge?.what ?? (s.bridge?.role ? ROLE_LABEL[s.bridge.role] : null) ?? (s.leadTo && s.leadTo !== "none" ? LEAD_TO_JA[s.leadTo] : null)
    ?? (ctx?.lead?.answer === "応じた" ? `${ctx.lead.kind}を一段進める` : null) ?? (ctx?.latent4?.want ? `本当はしたい事: ${ctx.latent4.want}` : null) ?? ctx?.nextIntent ?? (ctx?.goal ? `目指す事: ${ctx.goal}` : null);
  const appealText = s.appeal ? `訴求: ${join([s.appeal.property ?? u.main?.property ?? null, s.appeal.what ?? join(s.appeal.points)], "の ")}${s.appeal.how ? `（${s.appeal.how}）` : ""}` : null;
  const worryHow: TrustHow[] = ["preempt", "fact"];
  // 2026-11-12 案B: 番の材料に「どうやって」が無い時だけ、場面×誘導先の竹内さんの傾向表（compose-how-table・198通）で埋める。行は増やさない
  const mainRole0 = u.main?.role ?? null;
  const leadKey = s.leadTo ?? (mainRole0 === "keep" ? "keep" : mainRole0 === "viewing" ? "viewing" : mainRole0 === "apply" ? "apply" : mainRole0 === "estimate" ? "estimate" : mainRole0 === "answer" ? "answer_only" : null);
  const tbl = !s.keyHow.length || !s.trustHow.length ? takeuchiHowFor(o.scene ?? null, leadKey) : null;
  // 先に受ける（accept_first）は受けの文の型＝受けが主の番だけ主の行に置く（受け・挨拶・締めは今まで通り）
  const keyHowEff: KeyHow[] = s.keyHow.length ? s.keyHow : (tbl?.key ?? []).filter((k) => mainRole0 === "uke" || k !== "accept_first");
  const trustTbl: TrustHow[] = s.trustHow.length ? [] : (tbl?.trust ?? []);
  // 主: 一通の読みの主（AIX の番の主は返信では受けるだけ＝行にしない）
  const mainRole = u.main?.role ?? null;
  if (u.main && mainRole && !aixMain) {
    rows.push({ rank: "main", role: mainRole, part: join([partOf(u.main), s.keyPoint ? `要点: ${s.keyPoint}` : null, u.mainMove ? `この番でする事: ${u.mainMove}` : null], "／"), how: join(keyHowEff.map((k) => KEY_HOW_JA[k])), next: nextJa, from: u.src.main ?? "?" });
  } else empty.push(aixMain ? "主（AIX の番＝返信は受けるだけ）" : "主");
  // 従①: 脇の心配（潜在意識のカバー）＝主の答えの後。具体の中身と先回りに使う事実をそのまま渡す
  const lc = s.latentCover;
  if (lc && (lc.kind || lc.what)) {
    const factType = !lc.fact && lc.kind ? LATENT_FACT_TYPES[lc.kind] ?? null : null;
    const how = join([lc.how ?? null, ...s.trustHow.filter((t) => worryHow.includes(t)).map((t) => TRUST_HOW_JA[t]), factType ? `先回りの事実の型（竹内さん）: ${factType}` : null]);
    rows.push({ rank: "sub", role: "worry", part: join([lc.what ?? lc.kind, lc.fact ? `使う事実: ${lc.fact}` : null], "／"), how, next: null, from: s.src.latentCover ?? "?" });
  } else empty.push("潜在意識のカバー");
  // 従②: 同じ一通の別の依頼（主と同じ役目でも別の部分）
  for (const it of u.subs) {
    const role = it.role ?? roleOfRoute(it.route);
    if (!role) continue;
    // 主と同じ役目・同じ事の依頼は1つの文にまとめる（竹内さん q208「お送り頂きました5件の募集状況確認させて頂きます」）
    // 2026-11-12 まとめても中身（物件・答え）は落とさない＝主の行に足す（受け渡しの漏れ q064）
    if (u.main && role === mainRole && it.about === u.main.about) { const mr0 = rows.find((r) => r.rank === "main"); const add = partOf({ ...it, about: null }); if (mr0 && add) mr0.part = join([mr0.part, `＋ ${add}`], "／"); continue; }
    { const same = rows.find((r) => r.rank === "sub" && r.role === role && r.from === (u.src.subs ?? "?") && !!it.about && !!r.part?.includes(ABOUT_JA[it.about])); if (same) { const add = partOf({ ...it, about: null }); if (add) same.part = join([same.part, `＋ ${add}`], "／"); continue; } }
    rows.push({ rank: "sub", role, part: partOf(it), how: null, next: null, from: u.src.subs ?? "?" });
  }
  // 従③: 信頼の作り方（先回り・事実の裏付けは心配の行で使った）
  const hasWorry = rows.some((r) => r.role === "worry");
  const trustRest = s.trustHow.filter((t) => !(hasWorry && worryHow.includes(t)));
  if (trustRest.length) rows.push({ rank: "sub", role: "trust", part: appealText && !leadRole ? appealText : null, how: join(trustRest.map((t) => TRUST_HOW_JA[t])), next: null, from: s.src.trustHow ?? "?" });
  else if (!s.trustHow.length && !trustTbl.length) empty.push("信頼の作り方");
  // 従④: 次の一歩（誘導先）。訴求はここに付ける（竹内さんの文の G: 推しは導く先の役目）。押す強さと理由（作業員5 の push）も
  const pushHow = s.push ? (s.push.push ? `押す強さ: ${({ strong: "強（推奨・抑えましょうまで）", mid: "中（如何でしょうか・時間枠）", weak: "弱（お気に召されましたら）" } as const)[s.push.strength ?? "weak"]}${s.push.reason ? `・理由: ${s.push.reason}` : ""}` : `押さない（待つ）${s.push.reason ? `・理由: ${s.push.reason}` : ""}`) : null;
  if (leadRole && leadRole !== mainRole) {
    rows.push({ rank: "sub", role: leadRole, part: appealText, how: pushHow, next: null, from: s.src.leadTo ?? "?" });
  } else if (!s.leadTo) empty.push("誘導先");
  if (appealText && !leadRole && !trustRest.length) rows.push({ rank: "sub", role: "trust", part: appealText, how: null, next: null, from: s.src.appeal ?? "?" });
  if (!s.appeal) empty.push("訴求");
  if (!keyHowEff.length) empty.push("要点の押さえ方");
  if (!s.bridge) empty.push("次へのつなぎ");
  // 表の信頼の作り方は主の行の「どうやって」に添える（新しい文は作らない）。サポートの姿勢は継続・信頼の行がある番だけ（了承・検討の番に全力サポートを足させない）
  const mr = rows.find((r) => r.rank === "main");
  const trustAdd = trustTbl.filter((t) => t !== "support" || rows.some((r) => r.role === "keep" || r.role === "trust"));
  if (mr && trustAdd.length) mr.how = join([mr.how, `信頼: ${trustAdd.map((t) => TRUST_HOW_JA[t]).join("・")}`], "／");
  const howSrc = s.keyHow.length || s.trustHow.length ? "turn" : tbl ? "table" : null;
  return { rows, aixMain, empty, how: { key: keyHowEff, trust: s.trustHow.length ? s.trustHow : trustAdd, src: howSrc, tableKey: tbl?.keyUsed ?? null }, ctx };
}


/** 書き手への注記（1文ずつ）。主の行が無ければ空文字（今まで通り）。言い回しの例文は入れない（創作の文を誘わない） */
export function sentencePlanNote(p: SentencePlan): string {
  if (!p.rows.some((r) => r.rank === "main")) return "";
  const L = ["【✍️ 文の設計図（1文ずつ・文の統括）】主を先に、従はその後に。1行＝1〜2文。受け・挨拶・締めは今まで通り。"];
  // 2026-11-12 竹内さん「細分化された判断が文の構成に届くように」: 文の統括が受け取ったブレインの読みを設計図の上に（材料の無い行は出さない）
  const cl = p.ctx ? composeContextLines(p.ctx) : [];
  if (cl.length) L.push("（受け取ったブレインの読み）", ...cl, "（1文ずつ）");
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
    要点の押さえ方: { got: s.keyHow.length > 0 || !!p.how?.key.length, inPlan: !!main?.how && !!p.how?.key.some((k) => main.how!.includes(KEY_HOW_JA[k])) },
    信頼の作り方: { got: s.trustHow.length > 0 || !!p.how?.trust.length, inPlan: p.rows.some((r) => !!r.how && (p.how?.trust ?? s.trustHow).some((t) => r.how!.includes(TRUST_HOW_JA[t]))) },
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
    appeal: s.appeal?.points ?? [], latent: s.latentCover?.kind ?? null, keyHow: s.keyHow.length ? s.keyHow : p.how?.key ?? [], trustHow: s.trustHow.length ? s.trustHow : p.how?.trust ?? [],
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

// ── ⑥ 受け渡しの漏れ（2026-11-12 竹内さん「細分化された判断が文の構成に届くように・ボトルネックをなくす」） ─────────────
/** 文の統括に届くべきブレインの欄。carried="plan"＝この設計図の注記に出す／"other"＝別の注記が運ぶ（重ねない・どこが運ぶかを書く） */
export type HandoffField = { key: string; label: string; carried: "plan" | "other"; by?: string; values: (m: Record<string, unknown>) => string[] };
const sv = (v: unknown, n = 60): string[] => { const x = str(v, n); return x ? [x] : []; };
const asksOf = (m: Record<string, unknown>) => { const tc = obj(m.turn_contract); return Array.isArray(tc?.asks) ? (tc!.asks as unknown[]).map((a) => obj(a)).filter((a): a is Record<string, unknown> => !!a) : []; };
export const HANDOFF_FIELDS: readonly HandoffField[] = [
  { key: "turn_contract.situation", label: "今の状況", carried: "plan", values: (m) => sv(obj(m.turn_contract)?.situation, 80) },
  { key: "turn_contract.background", label: "背景", carried: "plan", values: (m) => sv(obj(m.turn_contract)?.background, 100) },
  { key: "turn_contract.asks.property", label: "何の物件", carried: "plan", values: (m) => asksOf(m).filter((a) => a.route !== "aix").flatMap((a) => sv(a.property, 40)) },
  { key: "turn_contract.asks.about", label: "何の事", carried: "plan", values: (m) => asksOf(m).filter((a) => a.route !== "aix").map((a) => aboutOf(a.about)).filter((x): x is RequestAbout => !!x && x !== "other").map((x) => ABOUT_JA[x]) },
  { key: "turn_contract.asks.answer", label: "答えの中身", carried: "plan", values: (m) => asksOf(m).filter((a) => a.route !== "aix").flatMap((a) => sv(a.answer, 60)) },
  { key: "turn_contract.must_not", label: "言ってはいけない事", carried: "other", by: "本質の帯（renderTurnContractNote）", values: () => [] },
  { key: "key_topics・avoid_topics・reply_direction・customer_questions", label: "要点の候補・避ける話・方向の文・質問", carried: "other", by: "本質の帯・ブレインの方向の行（generate-reply の tpoGuidanceNote）", values: () => [] },
  { key: "priorities・message_plan.messages", label: "要件の順・通の割り振り", carried: "other", by: "文の統括の重点（reply-compose-conductor）・構成のブレイン（compose-blueprint の requirements）", values: () => [] },
  { key: "message_plan.background", label: "背景（1通の計画）", carried: "plan", values: (m) => (str(obj(m.turn_contract)?.background) ? [] : sv(obj(m.message_plan)?.background, 80)) },
  { key: "message_plan.parts(omit)", label: "今回入れない", carried: "plan", values: (m) => { const mp = obj(m.message_plan); return Array.isArray(mp?.parts) ? (mp!.parts as unknown[]).map((p) => obj(p)).filter((p) => p?.include === "omit").flatMap((p) => sv(p!.meaning, 40)).slice(0, 3) : []; } },
  { key: "turn_read.target", label: "対象（物件・部分）", carried: "plan", values: (m) => { const t = obj(obj(m.turn_read)?.target); return [...sv(t?.property, 40), ...sv(t?.detail, 40)]; } },
  { key: "turn_read.lead", label: "前の誘導への答え", carried: "plan", values: (m) => { const l = obj(obj(m.turn_read)?.lead); return l && typeof l.answer === "string" ? [l.answer] : []; } },
  { key: "turn_read.feeling", label: "気持ちの中身", carried: "plan", values: (m) => sv(obj(m.turn_read)?.feeling, 30) },
  { key: "turn_read.mood", label: "気持ちの型・何に・強さ", carried: "plan", values: (m) => { const md = obj(obj(m.turn_read)?.mood); return md ? [...sv(md.base, 20), ...sv(md.object, 20)] : []; } },
  { key: "turn_read.latent", label: "潜在の4欄（きっかけ・部分・気持ち・したい事）", carried: "plan", values: (m) => { const lt = obj(obj(m.turn_read)?.latent); if (!lt) return []; const f = flatLatent(lt); return [f.trigger, f.part, f.feeling, f.want].filter((x): x is string => !!x); } },
  { key: "latent_read", label: "潜在の4欄（ブレインの本番の番・案A）", carried: "plan", values: (m) => { const lt = obj(m.latent_read); if (!lt || obj(obj(m.turn_read)?.latent)) return []; const f = flatLatent(lt); return [f.trigger, f.part, f.feeling, f.want].filter((x): x is string => !!x); } },
  { key: "turn_read.main/subs", label: "主と従", carried: "plan", values: (m) => { const tr = obj(m.turn_read); const xs = [obj(tr?.main), ...((Array.isArray(tr?.subs) ? tr!.subs : []) as unknown[]).map((x) => obj(x))]; return xs.flatMap((x) => [...sv(x?.part, 40), ...sv(x?.property, 40)]); } },
  { key: "turn_focus", label: "組み合わせた理解（主にする事・従の扱い）", carried: "plan", values: (m) => { const t = obj(m.turn_focus); return t ? [...sv(obj(t.main)?.move, 30), ...sv(obj(t.sub)?.intent, 30)] : []; } },
  { key: "turn_topics", label: "話題ごと（言葉・前の話）", carried: "plan", values: (m) => (Array.isArray(m.turn_topics) ? (m.turn_topics as unknown[]).map((x) => obj(x)).flatMap((x) => [...sv(x?.quote, 30), ...sv(x?.ref, 40)]) : []) },
  { key: "main_point", label: "要点", carried: "plan", values: (m) => sv(m.main_point, 80) },
  { key: "three_layer", label: "表の問い・奥の心配・安心の条件", carried: "plan", values: (m) => { const t = obj(m.three_layer); return t ? [...sv(t.surface, 40), ...sv(t.worry, 50), ...sv(t.relief, 50)] : []; } },
  { key: "latent_intent", label: "送ってきた動機", carried: "plan", values: (m) => sv(m.latent_intent, 60) },
  { key: "customer_concern", label: "気にしている事", carried: "plan", values: (m) => { const c = obj(m.customer_concern); return c ? [...sv(c.topic, 20), ...sv(c.object, 30)] : []; } },
  { key: "appeal_timing", label: "訴求のタイミング", carried: "plan", values: (m) => { const a = obj(m.appeal_timing); return a ? [...sv(a.reason, 50)] : []; } },
  { key: "conductor_focus", label: "統括の重点", carried: "plan", values: (m) => { const c = obj(m.conductor_focus); return c ? sv(c.focus, 20) : []; } },
  { key: "plan_ahead.goal", label: "目指す事", carried: "plan", values: (m) => sv(obj(m.plan_ahead)?.goal, 40) },
  { key: "future_timeline", label: "時期", carried: "plan", values: (m) => sv(m.future_timeline, 30) },
  { key: "hesitancy_pattern", label: "迷いの型", carried: "plan", values: (m) => sv(m.hesitancy_pattern, 20) },
  { key: "seven_read", label: "竹内さんの7つの欄", carried: "plan", values: (m) => { const r = obj(m.seven_read) ?? obj(m.takeuchi_seven); if (!r) return []; return [...sv(obj(r.point)?.what, 80), ...sv(obj(r.bridge)?.what, 60), ...sv(obj(r.appeal)?.point, 60), ...sv(obj(r.latent)?.what, 60), ...sv(obj(r.latent)?.fact, 60), ...sv(obj(r.point)?.skipped, 50), ...sv(obj(r.push)?.reason, 50)]; } },
  { key: "current_property", label: "話題の中心の物件", carried: "plan", values: (m) => (asksOf(m).some((a) => a.route !== "aix" && str(a.property)) || str(obj(obj(m.turn_read)?.target)?.property) ? [] : asksOf(m).some((a) => a.route !== "aix") ? sv(m.current_property, 40) : []) },
  { key: "customer_emotion", label: "気持ち（ブレインの一言）", carried: "plan", values: (m) => sv(m.customer_emotion, 30) },
  // 2026-11-12 作業員4: こちら側の状態（OUR_SIDE_TO_COMPOSE）
  { key: "our_side_note", label: "こちら側の状態（約束・直前の AIX・退去予定・確かめ済みの事実）", carried: "plan", values: (m) => (typeof m.our_side_note === "string" ? m.our_side_note.split("\n").map((x) => x.trim()).filter(Boolean).slice(0, 8) : []) },
  { key: "customer_mindset", label: "気持ちの状態・不安の対象", carried: "plan", values: (m) => { const cm = obj(m.customer_mindset); return cm ? sv(cm.state, 20) : []; } },
  { key: "engagement_stance・purchase_signal_level", label: "押す・待つ・買う合図", carried: "plan", values: (m) => [...sv(m.engagement_stance, 6), ...sv(m.purchase_signal_level, 6)] },
  { key: "reply_direction(誘導先)", label: "方向の文の誘導先", carried: "plan", values: (m) => { const d = leadFromDirection(m.reply_direction); return d && d !== "none" ? [LEAD_TO_JA[d]] : []; } },
  { key: "compose.intent.next", label: "次にしてほしい事（構成の意図）", carried: "plan", values: () => [] },
  { key: "turn_aims", label: "この番の目的・次の2〜3番の狙い・入れる仕込み", carried: "other", by: "受け渡し（conductor-handoff の handoffNote・TURN_AIMS_AFTER）", values: () => [] },
];

/**
 * ブレインの出力の全部の欄（brain-core.ts の SuggestedAixMeta）→ 文の側の受け口。新しい欄を足したらここに行が無いとテストが落ちる
 *   （app/lib/__tests__/compose-sentence-plan.test.ts「ブレインの欄は全部、文の側の受け口が決まっている」）。2026-11-12 竹内さん「文生成の部分もブレインの進化にともなってちゃんとできるように」
 *   plan＝文の統括の設計図が運ぶ（HANDOFF_FIELDS に行がある）／other＝別の注記・役が運ぶ（by に書く）／none＝文に関係しない（判断・AIX・記録・内部の受け渡し）
 */
export const BRAIN_FIELD_ROUTE: Readonly<Record<string, "plan" | "other" | "none">> = {
  // 文の統括の設計図が運ぶ
  turn_contract: "plan", turn_read: "plan", turn_focus: "plan", turn_topics: "plan", seven_read: "plan", latent_read: "plan", main_point: "plan", three_layer: "plan", latent_intent: "plan", customer_concern: "plan", appeal_timing: "plan",
  conductor_focus: "plan", plan_ahead: "plan", future_timeline: "plan", hesitancy_pattern: "plan", message_plan: "plan", current_property: "plan",
  customer_emotion: "plan", customer_mindset: "plan", our_side_note: "plan", engagement_stance: "plan", purchase_signal_level: "plan", reply_direction: "plan",
  // 2026-11-12 作業員7: この番の目的・中期の狙い・仕込み（BRAIN_TURN_AIMS・TURN_AIMS_AFTER）は受け渡し（conductor-handoff の decided）が運ぶ
  turn_aims: "other",
  // 2026-11-12 統括役: 作業員17 の判断の根拠のメモ（BRAIN_JUDGE_BASIS・既定 off）は物差しと記録のための欄＝文の統括には渡さない（作業員10 の受け口は feat/compose-1105 で別に入る）
  judge_basis: "other",
  // 別の注記・役が運ぶ（本質の帯・方向・姿勢・締め・2通・AIX）
  key_topics: "other", avoid_topics: "other", customer_questions: "other", priorities: "other", reply_mode: "other", two_stage: "other", reply_opener: "other",
  recommended_tone: "other", urgency_appropriate: "other", closing_strategy: "other", payment_timing: "other", far_move_in: "other", property_state: "other",
  action_ledger: "other", request_status: "other", winning_pattern: "other", repeated_concern: "other", condition_change_type: "other", condition_change_scope: "other",
  checkpoint_stage: "other", customer_intent: "other", two_choice_mode: "other", two_choice_reply_kind: "other", two_choice_reply_hint: "other", two_choice_preferred: "other",
  reply_direction_label: "other", current_properties: "other", send_sequence: "other", send_sequence_reply_count: "other", after_aix_template: "other", template_hint: "other",
  first_reply: "other", rent_market: "other", pending_pickup: "other", pickup_ready: "other", material_missing: "other", customer_stage_now: "other",
  // 文に関係しない（判断・AIX・記録・内部の受け渡し）
  action: "none", input_key: "none", note: "none", source: "none", enforcement_level: "none", check_pattern: "none", next_steps: "none", two_choice_aix: "none",
  two_choice_check_pattern: "none", aix_consult: "none", aix_desk: "none", aix_recheck: "none", material_read_misses: "none", material_gaps: "none", last_turn_review: "none", alt_actions: "none",
  parallel_search: "none", property_search_params: "none", aix_llm: "none", deep_check: "none", fast_slow: "none", need: "none", plan_ahead_at: "none",
  material_conflicts: "none", flow_signals: "none", decisions_1103: "none", near_opinion: "none", conductor_roles: "none", conductor_meta: "none", conductor_intake: "none",
  brain_depth: "none", deep_recheck_digest: "none", conductor_todos: "none", priority_step: "none", llm_raw: "none", checkpoint_stage_llm: "none", analyzed_msg_ts: "none",
  last_aix_history: "none", aix_suppressed_by_accept_rate: "none", signal_aix_ran: "none", signal_aix_result: "none", decision_source: "none", decision_source_no_aix: "none",
  demoted_overrides: "none", first_contact_pickup: "none", dropped_direction: "none", scene_evidence: "none", reason: "none", human_type_label: "none",
};
const nz = (t: string) => t.normalize("NFKC").replace(/\s+/g, "");
/** ブレインに値があるのに設計図の注記に出ない欄（AIX の主の番・注記が空の番は数えない） */
export function handoffLeaks(meta: unknown, note: string): Array<{ key: string; label: string; missing: string[] }> {
  const m = obj(meta) ?? {};
  if (!note.trim()) return [];
  const n = nz(note);
  const out: Array<{ key: string; label: string; missing: string[] }> = [];
  for (const fd of HANDOFF_FIELDS) {
    if (fd.carried !== "plan") continue;
    const missing = fd.values(m).filter((v) => !n.includes(nz(v)));
    if (missing.length) out.push({ key: fd.key, label: fd.label, missing });
  }
  return out;
}
