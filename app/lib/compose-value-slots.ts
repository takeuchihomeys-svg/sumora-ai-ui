// app/lib/compose-value-slots.ts — 文の統括: 役目×場面→出す値の欄・順位・出さない値（COMPOSE_VALUE_SLOTS）と返信の締めの決め表（COMPOSE_CLOSING_TABLE）
//   純関数・DB/fetch 無し・どちらも既定 off（作業員10・2026-11-12 統括役の指示＝作業員24 の洗い出しの根A と締め）
//
// ■ 何を直すか
//   書き手は「何を言うか（役目）」は設計図で受け取るが、「どの値を・どの順で・何個ずつ」出すかと「どう締めるか」は毎回 LLM 任せだった。
//   → 値は材料から決まった計算で埋めて渡す（文は写さない・手本の文をそのまま渡さない）。締めは実送信を数えた表で決める。
//
// ■ 数え（費用0・手元の 198番 roles-r1/seven-all198 ＋ problems.json の実送信の返信 1,098通・営業時間中なので DB は読まない）
//   訴求の行 288（オススメ・魅力・ゆとり・抑え 等の行で値が1つ以上）:
//     値の数 1:133・2:83・3:57・4:13・5:2 ＝ 3個まで 95%（→ 1文 2〜3個まで・それより多ければ文を分ける）
//     最初に来る値 敷礼なし 60・築年/新築 50・初期費用 49・設備 29・駅 29・広さ 24・家賃 14・保証会社 12・退去予定 12・階 7
//     前後の対 敷礼なし>初期費用 64・築>設備 22・駅>設備 18・広さ>設備 15・築>敷礼 13 ＝ 敷礼の直後に「初期費用を抑えて」・設備は後ろ
//     階 16行のうち推す理由（「〜階のため」）にしたのは 1 ＝ 階は推しの理由にしない（作業員10 の uptakePlan の「階は軸にしない」と同じ）
//   答え・約束の文 139: 答え×「〜となります」37・答え×「可能です」7・答え×弊社 5・約束×「確認させて頂きます」25
//     ＝ 出所で書き方を固定: 資料（K9）＝「〜となります」・会社の事実（K8）＝「弊社では〜」「〜させて頂いております」・
//        要確認（K1/K2 スタッフだけが知る）＝言い切らず「確認させて頂きます」・知識（一般）＝「基本的に〜」
//   申込の文 23: 抑える理由の事実（審査 6・1部屋 4・キャンセル料 4・埋まる 3・退去予定 1・内覧前 1）がある 13/23
//     ＝ 材料に事実が無いのに強く押した番は少ない → 事実が無ければ強さを door（お気に召されましたら）に倒す
//   返信の締め（物件・見積を送っていない返信 717通・最後の3行の誘い＋最後の1行の結び）:
//     誘い無し＋結び無し 366・誘い無し＋何卒 134・内覧の誘い 152（うち結び無し＝誘いの文で終わる 78・お気軽に 41・何卒 19）・
//     申込の誘い 39・お気軽に だけ 21・ご査収 は送った物がある時だけ（送った文 0 通の返信では 0）
//     198番の文の数×結び: 1〜2文 何卒 6/34・3〜4文 33/119・5文以上 22/45 ＝ 長い返信ほど何卒
//     直前の役目×結び: 障壁を下げる→お気軽に 5/16・受けだけ→何卒 5/9 お気軽に 4/9・申込の誘い→結び無し 9/13（役目では決まらない＝表に使わない）
//     何卒の手がかり: 初回（ご連絡頂き）11/18・全力サポート 13/22・お客様が問いを書いた番 16/80（＝答えの番は結び無し）
//     表を 198番に当てた中の値（scripts/audit-closing-table.ts）: 誘い 75%（いつも無し 72%）・結び 61%（いつも無し 56%）＝結びは弱い。見ていない番で確かめる
//   既にある決まり（変えない・この表はその上に数えを足しただけ）:
//     feedback_recommend_cta_by_appeal（刺さる→内覧の誘い／退去予定→ご査収が基本・申込は入居が近い・急ぐ・かなり刺さる時だけ（10/29 No.34）／そこまで→ご査収）
//     feedback_reply_wording_1008（何卒は締めの型・「検討します」は誘わず閉じる）・next-move-types の strengthCeiling（刺さっていない時は内覧に誘わない）
//
// ■ 名前: 行き先・強さは next-move-types（NEXT_DEST・NEXT_STRENGTH）、情報の出所は作業員21 の info-kind（K8 会社の事実・K9 資料・K10 物件の記録・K11 会話の事実・K1/K2 スタッフだけが知る）に揃える

import type { NextDest, NextStrength } from "./next-move-types";
import { toNextDest, strengthFromSeven } from "./next-move-types";
import { readOurSendUptake, elementCuesOf } from "./compose-order-table";
import type { SentencePlan, SevenFields } from "./compose-sentence-plan";

type Env = Record<string, string | undefined>;
const envOf = (): Env => (typeof process !== "undefined" ? process.env : {});
export function composeValueSlotsOn(env: Env = envOf()): boolean {
  return (env.COMPOSE_VALUE_SLOTS ?? "").trim().toLowerCase() === "on";
}
export function composeClosingTableOn(env: Env = envOf()): boolean {
  return (env.COMPOSE_CLOSING_TABLE ?? "").trim().toLowerCase() === "on";
}

// ─── ① 値の欄 ─────────────────────────────────────────────────────────────

export const VALUE_KINDS = ["shikirei", "cost", "new", "equip", "walk", "area", "rent", "net", "guar", "vacate", "floor"] as const;
export type ValueKind = typeof VALUE_KINDS[number];
export const VALUE_KIND_JA: Record<ValueKind, string> = {
  shikirei: "敷金礼金", cost: "初期費用", new: "築年・新築", equip: "設備", walk: "駅からの距離", area: "広さ（帖・㎡）",
  rent: "家賃管理費込", net: "インターネット無料", guar: "保証会社・審査", vacate: "現況・退去予定", floor: "階",
};
/** 竹内さんの訴求の行の「最初に来る値」の多い順（288行）。お客様の一番のこだわりの値はこれより前に出す */
export const VALUE_ORDER_BASE: ValueKind[] = ["shikirei", "cost", "new", "equip", "walk", "area", "rent", "guar", "vacate", "net"];
/** 1文に入れる値の数の上限（3個まで 95%） */
export const VALUES_PER_SENTENCE = 3;

const num = (s: string) => Number(s.replace(/[,，]/g, ""));
const yen = (n: number) => `${n.toLocaleString("ja-JP")}円`;
/** 材料の文字から値を決まった計算で読む（読めない値は入れない・文は写さない） */
export function readValues(materialText: string): Partial<Record<ValueKind, string>> {
  const t = String(materialText ?? "").normalize("NFKC");
  const out: Partial<Record<ValueKind, string>> = {};
  const incl = t.match(/家賃(?:管理費|共益費)込み?\s*[:：]?\s*(\d[\d,]*)\s*円/);
  const rent = t.match(/(?:家賃|賃料)\s*[:：]?\s*(\d[\d,]*(?:\.\d+)?)\s*(万円|万|円)/);
  const adm = t.match(/(?:管理費|共益費)\s*[:：]?\s*(\d[\d,]*)\s*円/);
  if (incl) out.rent = `家賃管理費込${yen(num(incl[1]))}`;
  else if (rent) {
    const r = rent[2].startsWith("万") ? Math.round(Number(rent[1]) * 10000) : num(rent[1]);
    const a = adm ? num(adm[1]) : 0;
    if (r >= 15000 && r <= 1_000_000) out.rent = adm ? `家賃管理費込${yen(r + a)}` : `家賃${yen(r)}`;
  }
  const areas = [...t.matchAll(/(リビング|LDK|洋室|和室|DK)?\s*(\d+(?:\.\d+)?)\s*(帖|畳)/g)].slice(0, 2).map((m) => `${m[1] ?? ""}${m[2]}帖`);
  const sqm = t.match(/(\d+(?:\.\d+)?)\s*(?:㎡|m²|m2|平米)/);
  if (areas.length || sqm) out.area = [...areas, sqm ? `${sqm[1]}㎡` : null].filter(Boolean).join("・");
  if (/敷金\s*[:：]?\s*(?:なし|無し|0|-)[^\n]{0,6}礼金\s*[:：]?\s*(?:なし|無し|0|-)|敷礼(?:なし|0)|敷金礼金(?:なし|無し|0)/.test(t)) out.shikirei = "敷金礼金なし";
  const built = t.match(/(20\d\d|19\d\d)\s*年\s*(\d{1,2})?\s*月?\s*築/);
  if (/新築/.test(t)) out.new = "新築";
  else if (built) out.new = `${built[1]}年${built[2] ? `${built[2]}月` : ""}築`;
  const walk = t.match(/([^\s、。・\n]{1,10}駅)?\s*徒歩\s*(\d{1,2})\s*分/);
  if (walk) out.walk = `${walk[1] ?? "駅"}徒歩${walk[2]}分`;
  const eq = ["オートロック", "宅配ボックス", "独立洗面台", "バス・トイレ別", "ウォークインクローゼット", "カウンターキッチン", "浴室乾燥機", "追い焚き", "防犯カメラ", "2口コンロ", "システムキッチン"]
    .filter((w) => t.includes(w) || (w === "バス・トイレ別" && /バストイレ別|BT別/.test(t)) || (w === "独立洗面台" && /独立洗面/.test(t)));
  if (eq.length) out.equip = eq.slice(0, 3).join("・");
  if (/インターネット(?:無料|使用料無料)|ネット無料/.test(t)) out.net = "インターネット無料";
  const g = t.match(/保証会社\s*[:：]?\s*([^\s、。\n（(]{2,14})/);
  if (g) out.guar = `保証会社${g[1]}`;
  const vac = t.match(/(\d{1,2}月(?:\d{1,2}日|上旬|中旬|下旬|末)?)\s*退去予定/);
  if (vac) out.vacate = `${vac[1]}退去予定`;
  else if (/現況\s*[:：]?\s*空室|空室/.test(t)) out.vacate = "現況空室";
  const fl = t.match(/(\d{1,2})\s*階(?!建)/);
  if (fl) out.floor = `${fl[1]}階`;
  return out;
}

/** お客様の一番のこだわり（言葉）→ 値の欄。決まった語だけ・読めなければ null */
export function topConditionKind(text: string): ValueKind | null {
  const t = String(text ?? "");
  const order: Array<[ValueKind, RegExp]> = [
    ["rent", /家賃|予算|安い|安く|抑えたい/], ["cost", /初期費用|費用/], ["shikirei", /敷金|礼金|敷礼/], ["area", /広さ|広い|広め|帖|畳|㎡|間取/],
    ["walk", /駅近|駅から|徒歩|駅チカ/], ["new", /新築|築浅|築年|綺麗/], ["equip", /オートロック|宅配|独立洗面|バス・?トイレ別|ウォークイン|カウンターキッチン|追い焚き|設備/],
    ["net", /ネット|wifi|Wi-?Fi/i], ["guar", /審査|保証/],
  ];
  const hit = order.map(([k, re]) => [k, t.search(re)] as const).filter(([, i]) => i >= 0).sort((a, b) => a[1] - b[1]);
  return hit.length ? hit[0][0] : null;
}

export type ValueSlotPlan = {
  role: "appeal" | "answer" | "apply";
  /** 出す値（順に）。訴求の時だけ */
  values: Array<{ kind: ValueKind; value: string }>;
  /** 文の分け方（値を 3個ずつ） */
  sentences: Array<Array<{ kind: ValueKind; value: string }>>;
  omit: Array<{ kind: ValueKind; why: string }>;
  /** 答えの出所と書き方（答えの時だけ） */
  source?: AnswerSource | null;
  /** 申込の誘いの強さ（申込の時だけ） */
  strength?: NextStrength | null;
  restrainFacts?: string[];
  why: string;
};

/** 訴求: お客様の一番こだわる値 → 竹内さんの並び（敷礼→初期費用→築→設備→駅→広さ→家賃…）。階は推しの理由にしない */
export function appealValuePlan(o: { materialText: string; topText?: string | null; already?: ReadonlyArray<ValueKind> }): ValueSlotPlan {
  const v = readValues(o.materialText);
  const top = topConditionKind(o.topText ?? "");
  const omit: ValueSlotPlan["omit"] = [];
  if (v.floor) omit.push({ kind: "floor", why: "階は推しの理由にしない（竹内さん 16行中 1）" });
  for (const k of o.already ?? []) if (v[k]) omit.push({ kind: k, why: "前の文・前の送信で言った値は繰り返さない" });
  const skip = new Set<ValueKind>(["floor", ...(o.already ?? [])]);
  const order = [...(top && !skip.has(top) ? [top] : []), ...VALUE_ORDER_BASE.filter((k) => k !== top)];
  // 敷礼なしの直後は初期費用（64 対）＝ 敷礼なしがあって初期費用の値が無い時は「初期費用を抑えて」の形で続ける（値は作らない）
  const values = order.filter((k) => !skip.has(k) && v[k]).map((k) => ({ kind: k, value: v[k]! }));
  const sentences: ValueSlotPlan["sentences"] = [];
  for (let i = 0; i < values.length && sentences.length < 2; i += VALUES_PER_SENTENCE) sentences.push(values.slice(i, i + VALUES_PER_SENTENCE));
  return { role: "appeal", values: sentences.flat(), sentences, omit, why: top ? `お客様の一番のこだわり（${VALUE_KIND_JA[top]}）を先に` : "竹内さんの並び（敷礼→初期費用→築→設備→駅→広さ→家賃）" };
}

// 答えの出所（作業員21 の info-kind に揃える）
export type AnswerSource = "material" | "company_fact" | "record" | "conversation" | "general" | "staff_only";
export const ANSWER_SOURCE_FORM: Record<AnswerSource, { kind: string; form: string }> = {
  material: { kind: "K9 資料", form: "資料の値をそのまま「〜となります！！」で言い切る（答え×となります 37）" },
  company_fact: { kind: "K8 会社の事実", form: "「弊社では〜」「〜させて頂いております」で会社の決まりとして言う（答え×弊社 5）" },
  record: { kind: "K10 物件の記録", form: "記録にある事だけを「〜となります」で言う（無い事は言わない）" },
  conversation: { kind: "K11 会話の事実", form: "お客様が言った事を受けて言う（言っていない事を足さない）" },
  general: { kind: "知識（一般）", form: "「基本的に〜」で一般の話として言い、この物件の事として言い切らない" },
  staff_only: { kind: "K1/K2 スタッフだけが知る", form: "結果を言い切らず「確認させて頂きます」で約束にする（約束×確認させて頂きます 25）" },
};
/** ブレインの turn_contract.asks[].basis・route から出所を決める（決まった対応だけ） */
export function answerSourceOf(ask: { basis?: unknown; route?: unknown } | null | undefined): AnswerSource | null {
  if (!ask) return null;
  if (ask.route === "promise") return "staff_only";
  switch (ask.basis) {
    case "material": return "material";
    case "company_fact": return "company_fact";
    case "conversation": return "conversation";
    case "general": return "general";
    default: return null;
  }
}

/** 申込の誘いを抑える理由の事実（材料から決まった語だけ）。無ければ強さを door に倒す */
export const RESTRAIN_FACTS: Array<[string, RegExp]> = [
  ["1部屋のみ", /1部屋のみ|残り1部屋|一部屋のみ/], ["キャンセル料", /キャンセル料/], ["内覧が先になる", /内覧(?:前|より先)|先にお申込|退去予定|ご内覧(?:可能|出来)[^\n]{0,8}(?:以降|から)/],
  ["埋まりそう", /お問い合わせ(?:多|が多)|申込(?:が)?入りそう|埋ま/], ["審査", /審査(?:通過|基準|が緩)|独立系/],
];
export function applyStrengthFromFacts(materialText: string, strength: NextStrength | null): { strength: NextStrength; facts: string[]; why: string } {
  const facts = RESTRAIN_FACTS.filter(([, re]) => re.test(String(materialText ?? ""))).map(([k]) => k);
  const s = strength ?? "invite";
  if (facts.length) return { strength: s, facts, why: `抑える理由の事実あり（${facts.join("・")}）` };
  const weak: NextStrength = s === "strong" || s === "invite" || s === "together" ? "door" : s;
  return { strength: weak, facts, why: "材料に抑える理由の事実が無い＝弱に倒す（申込の文 23 のうち事実あり 13）" };
}

export function valueSlotsNote(p: { appeal?: ValueSlotPlan | null; source?: AnswerSource | null; apply?: { strength: NextStrength; facts: string[]; why: string } | null }, env?: Env): string {
  if (!composeValueSlotsOn(env)) return "";
  const out: string[] = [];
  if (p.appeal && p.appeal.values.length) {
    const ss = p.appeal.sentences.map((s, i) => `${i + 1}文目: ${s.map((x) => x.value).join("・")}`).join("／");
    out.push(`- 推す値（${p.appeal.why}・1文に2〜3個まで）: ${ss}`);
    if (p.appeal.omit.length) out.push(`- 推す値に入れない: ${p.appeal.omit.map((o) => `${VALUE_KIND_JA[o.kind]}（${o.why}）`).join("・")}`);
  }
  if (p.source) out.push(`- 答えの書き方（出所 ${ANSWER_SOURCE_FORM[p.source].kind}）: ${ANSWER_SOURCE_FORM[p.source].form}`);
  if (p.apply) out.push(p.apply.facts.length ? `- 申込の誘い: 抑える理由の事実（${p.apply.facts.join("・")}）を添えて誘ってよい` : `- 申込の誘い: ${p.apply.why}。「お気に召されましたら」までにする`);
  return out.join("\n");
}

// ─── ② 締めの決め表 ───────────────────────────────────────────────────────

export type Invite = "viewing" | "apply" | "none";
export type SignOff = "nanitozo" | "receipt" | "kigaru" | "none";
export const INVITE_JA: Record<Invite, string> = { viewing: "内覧の誘い（お気に召されましたらご都合よろしいお日にちにご案内させて頂きます）", apply: "申込の誘い（お気に召されましたらお申込しお部屋抑えさせて頂きます）", none: "誘い無し" };
export const SIGN_JA: Record<SignOff, string> = { nanitozo: "何卒よろしくお願い致します", receipt: "お手隙の際にご査収ください", kigaru: "お気軽にお申し付けください", none: "結び無し（最後の文で終える）" };
export type Hook = "hooked" | "neutral" | "not_hooked" | null;
export type ClosingInput = {
  scene: string | null;
  dest: NextDest | null;
  strength: NextStrength | null;
  hook: Hook;
  /** 物件の状況: 内覧できる／退去予定（まだ見られない）／物件の話でない */
  propertyState: "viewable" | "vacating" | "none";
  /** この番で物件・見積書・写真を送る（ご査収はこの時だけ） */
  sentThisTurn: boolean;
  /** お客様が「検討します」と言った */
  considering: boolean;
  /** 入居が近い・急いでいる・申込の合図（退去予定でも申込に誘ってよい） */
  urgent: boolean;
  sentenceCount: number;
  /** 初回の返信（ご連絡頂きありがとうございます の番） */
  firstContact?: boolean;
  /** 今日（JST）のこちらの返信の何通目か（AIX・物件の送付は数えない）。分かる時だけ。11/12 夜の数え（problems の会話 485通）:
   *  何卒は その日1通目 40%・2通目 24%・3通目 20%・4通目以降 18%／問いへの答えで2通目以降は 8/138＝何卒は「その日最初の長い返信」の印。
   *  線「その日1通目かつ5文以上→何卒・他は結び無し」で 329/485（68%）・何卒にした 29 のうち 18（いつも無し 65%・前の線 67%） */
  nthToday?: number | null;
  /** お客様が問いを書いた番 */
  customerAsked?: boolean;
  /** 締めの直前の役目 */
  lastRole?: string | null;
};
export type ClosingDecision = { invite: Invite; sign: SignOff; why: string[] };

/** 締めの決め表（上から順に当てる・数えは頭の注記） */
export function decideClosing(c: ClosingInput): ClosingDecision {
  const why: string[] = [];
  let invite: Invite = "none";
  if (c.considering) why.push("検討します＝誘わず閉じる（10/08 竹内さん）");
  else if (c.hook === "not_hooked") why.push("刺さっていない＝内覧に誘わない（strengthCeiling）");
  else if (c.dest === "apply" && c.strength !== "none" && c.strength !== "door") { invite = "apply"; why.push("行き先が申込・強さが案内以上"); }
  else if (c.propertyState === "vacating" && (c.dest === "viewing" || c.dest === "apply")) {
    if (c.urgent || c.hook === "hooked" && c.strength === "strong") { invite = "apply"; why.push("退去予定で入居が近い・かなり刺さる＝申込の誘い（10/29 No.34）"); }
    else why.push("退去予定はご査収が基本（竹内さん 30通: ご査収 70%・申込 17%）");
  } else if (c.dest === "viewing" && c.strength !== "none") { invite = "viewing"; why.push("行き先が内覧（返信の内覧の誘い 152通）"); }
  let sign: SignOff;
  if (c.sentThisTurn && invite === "none") { sign = "receipt"; why.push("この番に送った物がある＝ご査収"); }
  else if (invite !== "none") { sign = "none"; why.push("誘いの文で終える（内覧の誘いの後 結び無し 78/152・申込の誘いの後 9/13）"); }
  else if (c.considering) { sign = "kigaru"; why.push("検討します＝お気軽に"); }
  else if (c.nthToday != null ? c.firstContact || (c.nthToday === 1 && c.sentenceCount >= 5) : c.firstContact || (c.sentenceCount >= 5 && !c.customerAsked)) { sign = "nanitozo"; why.push(c.nthToday != null ? "初回・その日最初の長い返信＝何卒（その日1通目かつ5文以上 18/29）" : "初回・長い返信＝何卒（初回 11/18・5文以上 22/45・問いへの答えの番は 16/80 なので外す）"); }
  else { sign = "none"; why.push("短い答えは結び無し（4文以下 何卒 39/153）"); }
  return { invite, sign, why };
}
export function closingNote(d: ClosingDecision | null, env?: Env): string {
  if (!composeClosingTableOn(env) || !d) return "";
  return `- 締め: ${INVITE_JA[d.invite]} → ${SIGN_JA[d.sign]}（${d.why.join("・")}）`;
}
export function closingDigest(d: ClosingDecision | null): string {
  return d ? `締め=${d.invite}+${d.sign}` : "締め=-";
}

// ─── 文の統括から1回で呼ぶ口（route は1行で呼ぶだけ） ─────────────────────────

const objOf = (v: unknown): Record<string, unknown> | null => (v && typeof v === "object" && !Array.isArray(v) ? (v as Record<string, unknown>) : null);
export function hookOf(meta: unknown): Hook {
  const parts = readOurSendUptake(meta);
  if (!parts.length) return null;
  if (parts.some((p) => p.hook === "hooked")) return "hooked";
  if (parts.every((p) => p.hook === "not_hooked")) return "not_hooked";
  return "neutral";
}
export function composeSlotsAndClosing(o: { plan: SentencePlan; s7: SevenFields; meta: unknown; scene: string | null; customerText: string; materialText: string; sentThisTurn?: boolean; firstContact?: boolean; nthToday?: number | null }, env?: Env): { note: string; digest: string } {
  const roles = o.plan.rows.map((r) => r.role);
  const dest = toNextDest(o.s7.leadTo ?? null, "lead_to");
  const strength = strengthFromSeven(o.s7.push ? { push: o.s7.push.push, strength: o.s7.push.strength } : null);
  const cues = elementCuesOf(o.meta);
  const tc = objOf(objOf(o.meta)?.turn_contract);
  const asks = Array.isArray(tc?.asks) ? (tc!.asks as unknown[]).map(objOf) : [];
  const leadAsk = asks[typeof tc?.lead_with === "number" ? (tc.lead_with as number) : 0] ?? null;
  const appeal = o.s7.appeal ? appealValuePlan({ materialText: o.materialText, topText: [o.customerText, o.s7.appeal.what ?? ""].join("\n") }) : null;
  const source = roles.includes("answer") || roles.includes("promise") ? answerSourceOf(leadAsk as { basis?: unknown; route?: unknown } | null) : null;
  const apply = dest === "apply" || roles.includes("apply") ? applyStrengthFromFacts(o.materialText, strength) : null;
  const propertyState: ClosingInput["propertyState"] = cues.notViewable || /退去予定/.test(o.materialText) ? "vacating" : o.s7.appeal?.property || appeal?.values.length ? "viewable" : "none";
  const closing = decideClosing({
    scene: o.scene, dest, strength: apply ? apply.strength : strength, hook: hookOf(o.meta), propertyState, sentThisTurn: !!o.sentThisTurn,
    considering: /検討/.test(o.customerText), urgent: cues.kinds.includes("K15") || /急ぎ|すぐにでも|早め|今週中|来週中/.test(o.customerText),
    sentenceCount: o.plan.rows.length, firstContact: !!o.firstContact, nthToday: o.nthToday ?? null, customerAsked: /[?？]|ですか|ますか/.test(o.customerText), lastRole: [...roles].reverse().find((r) => r !== "close") ?? null,
  });
  const note = [valueSlotsNote({ appeal, source, apply }, env), closingNote(closing, env)].filter(Boolean).join("\n");
  const digest = `値=${appeal?.values.map((v) => v.kind).join(">") || "-"}${source ? `｜出所=${source}` : ""}${apply ? `｜申込=${apply.strength}` : ""}｜${closingDigest(closing)}`;
  return { note, digest };
}

/** 締めの決め → compose-blueprint の COMPOSE_CLOSING の名前（誘いがあれば誘いの札・無ければ結びの札） */
export function toComposeClosing(d: ClosingDecision): "nanitozo" | "receipt" | "kigaru" | "viewing_cta" | "apply_cta" | "none" {
  return d.invite === "viewing" ? "viewing_cta" : d.invite === "apply" ? "apply_cta" : d.sign;
}
