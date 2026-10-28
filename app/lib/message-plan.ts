// app/lib/message-plan.ts — ブレインの「1通の計画」（純関数・DB/LLM なし）
//
// 2026-10-28 竹内さんの決定（設計知見 P1）:
//   ①「1通の部品どうしのぶつかりは、ブレインがお客様の文の背景の意味を読み、そこから優先順位と1通全体のまとめを決める」
//   ②「ブレインの1通の計画は、ぶつかる部品を人間のように判断する —『ここでは入れない』と外す・必要なら2通に分ける」
//   10/13 の決定（約束を1通に詰めない・優先順位で順に・要件ごとに2通）と同じ線。
// 今まで: 優先順位の段（brain-priority.ts の priorities）は答える順と扱いだけで、部品ごとの「何を・いつ・誰が・前に送った事との関係・入れるか」を
//   持っていなかった。その後で言葉の網の注記（募集状況確認の4ステップ・18時以降は明日一番・催促のお詫び 等）が書く役に直接差し込まれ、
//   ブレインの地図に勝っていた（てん・咲・愛実・勇気）。
// 形: ブレインの出力に message_plan（背景の意味・部品ごとの計画・通ごとの割り振り）を足す。部品は priorities の rank で結ぶ。
//   書く役は1通目（返信）に入る部品だけを順に書き、今は入れない・別の通の部品は書かない（renderMessagePlanNote）。
// スイッチ: BRAIN_MESSAGE_PLAN=on（既定 off＝今と1文字も変わらない）。優先順位の段（BRAIN_PRIORITY_STEP）が on の時だけ効く。
// テスト: app/lib/__tests__/message-plan.test.ts

type Env = Record<string, string | undefined>;
const envOf = (): Env => (typeof process !== "undefined" ? process.env : {});

export function messagePlanOn(env: Env = envOf()): boolean {
  if ((env.BRAIN_PRIORITY_STEP ?? "").trim().toLowerCase() === "off") return false;
  return (env.BRAIN_MESSAGE_PLAN ?? "").trim().toLowerCase() === "on";
}

// ── 型（作業員1の WRITER_BRAIN_ORDER と共有する形） ─────────────────────────────
export const PLAN_WHEN = ["now", "next_business_day", "after_check", "new_arrival", "closed", "later_turn"] as const;
export const PLAN_WHO = ["reply", "aix", "phone"] as const;
export const PLAN_RELATION = ["new", "reaction_to_sent", "continues_promise", "already_sent", "already_answered"] as const;
export const PLAN_INCLUDE = ["in", "omit", "split"] as const;
export const PLAN_OMIT_REASON = ["conflict", "closed", "later_turn", "already_said"] as const;
export type PlanWhen = typeof PLAN_WHEN[number];
export type PlanWho = typeof PLAN_WHO[number];
export type PlanRelation = typeof PLAN_RELATION[number];
export type PlanInclude = typeof PLAN_INCLUDE[number];
export type PlanOmitReason = typeof PLAN_OMIT_REASON[number];
/** 部品（priorities の rank と同じ番号で結ぶ） */
export type PlanPart = {
  rank: number;
  meaning: string;          // その部品の意味（お客様の文の背景から・40字）
  when: PlanWhen;           // いつ: 今この通で／営業時間外なので明日確かめる／確かめてから／新着待ち／もう締まっている／後の番
  who: PlanWho;             // 誰が: 返信の本文／スタッフが AIX で／電話で
  relation: PlanRelation;   // 前にこちらが送った事との関係
  ref: string | null;       // 関係する送った物・約束（30字）
  include: PlanInclude;     // この1通に入れる／今は入れない／別の通に分ける
  omitReason: PlanOmitReason | null;
  msg: number;              // 何通目か（1から・include=in は 1。split は 2 以上）
};
export type PlanMessage = { no: number; who: PlanWho; aix: string | null; ranks: number[]; why: string };
export type MessagePlan = { background: string; parts: PlanPart[]; messages: PlanMessage[] };

// ── ① 静的な system に入れる決め方（キャッシュの前置き・on の時だけ） ─────────────────
export const BRAIN_MESSAGE_PLAN_RULES = `【1通の計画（message_plan）— 部品どうしのぶつかりを人のスタッフのように決める（竹内さんの決定 10/28）】
priorities を決めた後、1通全体をどう組むかを決めて message_plan に書く。
  ① background: お客様の今の文の背景の意味（なぜ今これを言ったか・こちらが送った何への反応か・何を一番望んでいるか）を1文で。部品の取捨はここから決める。
  ② parts: priorities の項目ごとに（rank で結ぶ）:
     meaning＝その部品の意味／when＝now（この通で）・next_business_day（管理会社しか答えられない確認・交渉で、営業時間外なので明日確かめる）・after_check（確かめてから）・new_arrival（今の条件は出し切った＝新着が出次第）・closed（もう決まった・もう答えた）・later_turn（後の番で）
     who＝reply（返信の本文）・aix（スタッフだけが知る事を AIX で）・phone（電話で打ち合わせる）／relation＝new・reaction_to_sent（こちらが送った物への反応）・continues_promise（前の約束の続き）・already_sent・already_answered ＋ ref（関係する送った物・約束）
     include＝in（この1通に入れる）・omit（今は入れない）・split（別の通に分ける）／omit_reason＝conflict（ぶつかる）・closed（締まっている）・later_turn（後の番で）・already_said（もう言った）／msg＝何通目か
  ③ messages: 通ごとに {no, who, aix, ranks, why}。1通目は今の返信（または AIX）。
決め方（人の当たり前）:
  - 同じ流れの事は1通にまとめる（例: 物件のピックアップの約束と、同じ連投で送ってきた物件の募集状況の確認＝同じ物件探しの流れ→1通）。
  - 手段が違う事は通を分け、要件ごとに順番をつける（例: 日にちが決まった内覧の待ち合わせ場所＝AIX と、審査の相談＝電話 → 2通。優先の高い方が1通目）。約束を1通に詰め込まない。
  - もう決まった・もう答えた・もう言った事は omit（蒸し返さない・同じ受けを重ねない）。ぶつかる部品（例: 新着待ちで締めた番に新しいピックアップの約束）は片方を omit にして理由を書く。
  - 営業時間外の「明日確かめる」は管理会社しか答えられない確認・交渉の部品だけ（業者のサイトで分かる空き・募集状況は next_business_day にしない）。
  - 前の日に言った「明日」「本日」は今日から見て言い直す（日をまたいだら、その日の事として扱う）。
  - 決まった言い回しの型（確認の約束の型・お詫びの型）はあなたの計画の後で書く役が使う物。型があるから入れるのではなく、この計画で入れる部品にだけ使う。`;

export const BRAIN_MESSAGE_PLAN_FIELD = `"message_plan": {"background": "お客様の文の背景の意味（60字以内）", "parts": [{"rank": "priorities の rank", "meaning": "部品の意味（40字以内）", "when": "now|next_business_day|after_check|new_arrival|closed|later_turn", "who": "reply|aix|phone", "relation": "new|reaction_to_sent|continues_promise|already_sent|already_answered", "ref": "関係する送った物・約束（30字以内）か null", "include": "in|omit|split", "omit_reason": "include=omit の時だけ conflict|closed|later_turn|already_said・他は null", "msg": "何通目か（1から）"}], "messages": [{"no": 1, "who": "reply|aix|phone", "aix": "who=aix の時の AIX のキー・他は null", "ranks": ["この通に入れる rank"], "why": "この通の役目（30字以内）"}]}`;

// ── ② 出力を整える ────────────────────────────────────────────────────────
const clip = (v: unknown, n: number): string => String(v ?? "").replace(/\s+/g, " ").trim().slice(0, n);
const nullish = (v: unknown) => v == null || String(v).trim() === "" || String(v).trim() === "null";
const pick = <T extends string>(v: unknown, list: readonly T[], dflt: T): T => ((list as readonly string[]).includes(String(v)) ? (String(v) as T) : dflt);

/** ブレインの message_plan を整える（型の外れた値は既定に・部品は最大8・通は最大3）。無ければ null */
export function normalizeMessagePlan(raw: unknown, normAix: (k: string | null) => string | null = (k) => k): MessagePlan | null {
  if (!raw || typeof raw !== "object") return null;
  const o = raw as Record<string, unknown>;
  const parts: PlanPart[] = [];
  if (Array.isArray(o.parts)) {
    for (const x of o.parts) {
      if (!x || typeof x !== "object") continue;
      const p = x as Record<string, unknown>;
      const rank = Number(p.rank);
      if (!Number.isFinite(rank) || rank < 1) continue;
      const include = pick(p.include, PLAN_INCLUDE, "in");
      const msg = Number(p.msg);
      parts.push({
        rank, meaning: clip(p.meaning, 50), when: pick(p.when, PLAN_WHEN, "now"), who: pick(p.who, PLAN_WHO, "reply"),
        relation: pick(p.relation, PLAN_RELATION, "new"), ref: nullish(p.ref) ? null : clip(p.ref, 40), include,
        omitReason: include === "omit" ? pick(p.omit_reason ?? p.omitReason, PLAN_OMIT_REASON, "conflict") : null,
        msg: include === "split" ? (Number.isFinite(msg) && msg >= 2 ? Math.min(3, Math.floor(msg)) : 2) : 1,
      });
    }
  }
  const messages: PlanMessage[] = [];
  if (Array.isArray(o.messages)) {
    for (const x of o.messages) {
      if (!x || typeof x !== "object") continue;
      const m = x as Record<string, unknown>;
      const no = Number(m.no);
      const who = pick(m.who, PLAN_WHO, "reply");
      messages.push({
        no: Number.isFinite(no) && no >= 1 ? Math.floor(no) : messages.length + 1, who,
        aix: who === "aix" && !nullish(m.aix) ? normAix(clip(m.aix, 60)) : null,
        ranks: Array.isArray(m.ranks) ? m.ranks.map(Number).filter((n) => Number.isFinite(n) && n >= 1) : [],
        why: clip(m.why, 40),
      });
    }
  }
  const background = clip(o.background, 80);
  if (!background && !parts.length && !messages.length) return null;
  return { background, parts: parts.sort((a, b) => a.rank - b.rank).slice(0, 8), messages: messages.sort((a, b) => a.no - b.no).slice(0, 3) };
}

/** 部品が別の通・今は入れない＝今の返信に書かない */
export function partOutOfThisMessage(p: PlanPart | undefined): boolean {
  return !!p && (p.include === "omit" || p.include === "split" || p.who === "phone" || (p.who === "aix" && p.include !== "in"));
}
/** 計画に「明日確かめる」部品があるか（書く役の営業時間外の注記を残すかの判断に使う） */
export function planHasNextBusinessDay(plan: MessagePlan | null | undefined): boolean {
  return !!plan?.parts.some((p) => p.when === "next_business_day" && p.include === "in");
}

// ── ③ 書く役への材料 ──────────────────────────────────────────────────────
const WHEN_JA: Record<PlanWhen, string> = { now: "今この通で", next_business_day: "営業時間外のため明日確かめる", after_check: "確かめてから", new_arrival: "新着が出次第", closed: "もう締まっている", later_turn: "後の番で" };
const WHO_JA: Record<PlanWho, string> = { reply: "返信", aix: "AIX", phone: "電話" };
const REL_JA: Record<PlanRelation, string> = { new: "", reaction_to_sent: "こちらが送った物への反応", continues_promise: "前の約束の続き", already_sent: "もう送った", already_answered: "もう答えた" };
const OMIT_JA: Record<PlanOmitReason, string> = { conflict: "ぶつかる", closed: "締まっている", later_turn: "後の番で", already_said: "もう言った" };

/**
 * 本質の帯に入れる「1通の計画」の行（priorities の行の代わり）。priorities の項目に部品の計画を重ねる。
 *   items は brain-priority の PriorityItem（rank・kind・quote・item・handling・aix）
 */
export function renderMessagePlanNote(items: ReadonlyArray<{ rank: number; kind: string; item: string; quote: string | null; handling: string; aix: string | null; reason: string }>, plan: MessagePlan | null | undefined): string {
  if (!plan || !items.length) return "";
  const byRank = new Map(plan.parts.map((p) => [p.rank, p]));
  const L = ["- この番の1通の計画（ブレインがお客様の文の背景から決めた・この計画が下の決まった型・網の注記より先。1通目に入る部品だけをこの順に書く・今は入れない部品と別の通の部品は書かない）:"];
  if (plan.background) L.push(`  背景: ${plan.background}`);
  const inThis: string[] = [], out: string[] = [];
  for (const it of items) {
    const p = byRank.get(it.rank);
    const what = it.kind === "asked" && it.quote ? `「${it.quote}」` : it.item;
    const rel = p && p.relation !== "new" ? `（${REL_JA[p.relation]}${p.ref ? `: ${p.ref}` : ""}）` : "";
    if (it.handling === "skip" || it.handling === "later") { out.push(`  × ${what}${rel} → 書かない（${it.handling === "later" ? "後の番で" : "触れない"}）`); continue; }
    if (p && p.include === "omit") { out.push(`  × ${what}${rel} → 今は入れない（${OMIT_JA[p.omitReason ?? "conflict"]}）${p.meaning ? ` ／ ${p.meaning}` : ""}`); continue; }
    if (p && (p.include === "split" || p.who === "phone")) { out.push(`  → ${what}${rel} → ${p.msg}通目（${WHO_JA[p.who]}）で送る＝この返信には書かない${p.meaning ? ` ／ ${p.meaning}` : ""}`); continue; }
    const when = p ? WHEN_JA[p.when] : "今この通で";
    const how = it.handling === "aix" ? `AIX で送る（本文で中身を答えない${it.aix ? `・AIX ${it.aix}` : ""}）` : it.handling === "confirm" ? `約束する（${when}）` : `答える（${when}）`;
    inThis.push(`  ${inThis.length + 1}. ${it.kind === "asked" ? "聞かれた事" : "伝える事"}: ${what}${rel} → ${how}${p?.meaning ? ` ／ 意味: ${p.meaning}` : ""}`);
  }
  if (inThis.length) { L.push("  この返信に入れる（この順）:"); L.push(...inThis); }
  if (out.length) { L.push("  この返信に書かない:"); L.push(...out); }
  if (plan.messages.length > 1) L.push(`  通の割り振り: ${plan.messages.map((m) => `${m.no}通目=${WHO_JA[m.who]}${m.aix ? `【${m.aix}】` : ""}${m.why ? `（${m.why}）` : ""}`).join(" → ")}`);
  if (!planHasNextBusinessDay(plan)) L.push("  「本日営業時間外の為明日」「明日一番で」は書かない（計画に明日確かめる部品が無い）。");
  return L.join("\n");
}

// ── ④ priorities とそろえる・2通目の受け口（作業員1と合わせた形・10/28） ─────────────────
/**
 * 誰が（who）は priorities の handling から写す（決める所は handling の1つ＝二重にしない）:
 *   handling=aix → aix（AIX のキーが phone_call なら phone）／それ以外 → reply。
 *   handling=skip・later の部品は include=omit（理由: later は later_turn・skip は already_said）にそろえる。
 */
export function alignPlanWithPriorities(plan: MessagePlan | null, items: ReadonlyArray<{ rank: number; handling: string; aix: string | null }>): MessagePlan | null {
  if (!plan) return null;
  const byRank = new Map(items.map((it) => [it.rank, it]));
  const parts = plan.parts.filter((p) => byRank.has(p.rank)).map((p): PlanPart => {
    const it = byRank.get(p.rank)!;
    const who: PlanWho = it.handling === "aix" ? (it.aix === "phone_call" ? "phone" : "aix") : "reply";
    if (it.handling === "skip" || it.handling === "later") return { ...p, who, include: "omit", omitReason: it.handling === "later" ? "later_turn" : (p.omitReason ?? "already_said"), msg: 1 };
    return { ...p, who };
  });
  return { ...plan, parts };
}

/** 2通目（messages の no=2 と、その ranks の include=split の部品）。無ければ null（generate-reply の SECOND_MSG が受ける） */
export function secondMessageFromPlan(plan: MessagePlan | null | undefined): { no: number; who: PlanWho; aix: string | null; parts: PlanPart[]; why: string } | null {
  if (!plan) return null;
  const m = plan.messages.find((x) => x.no === 2);
  if (!m) return null;
  const ranks = new Set(m.ranks);
  const parts = plan.parts.filter((p) => p.include === "split" && (ranks.size ? ranks.has(p.rank) : p.msg === 2));
  if (!parts.length && !m.aix) return null;
  return { no: 2, who: m.who, aix: m.aix, parts, why: m.why };
}
