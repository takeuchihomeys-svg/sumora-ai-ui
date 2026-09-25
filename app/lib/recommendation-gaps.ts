// app/lib/recommendation-gaps.ts
// 🌟（AIX 物件オススメ）の1回を「お客様が求めている点」「スタッフが訴求した点」「ブレインの点が高かった物件」で並べ、
// 食い違い（ギャップ）を出す純関数（DB・ネットに触れない）。
//
// 2026-09-25 竹内「候補の記憶を太くする。会話を見たりオススメしている部分を見ればギャップが分かる」
//   正解は「スタッフが選んで送った事実」（memory feedback_property_selection_label）。お客様の返信の有無は使わない。
//
// ■ 決めたこと
//   ・話題（タグ）の語彙は1つ（TOPICS）。🌟の本文（訴求）・お客様の条件と発言（希望）・候補の値（事実）の三方を同じ語彙で見る。
//     三方で別々の言い方をすると「同じ話をしているのに食い違い」に見える。
//   ・事実（候補の値）で決められる話題だけ factTopics で ○ を付ける（敷礼0・駅近・築浅・広さ・階・設備の語・家賃）。
//     値が無い（null）は ○ でも × でもない＝「ブレインに見えていない」（blind）として別に数える。
//   ・お客様の発言は「欲しい／嫌」の文だけでなく全文に当てる（質問「審査は大丈夫ですか」も関心として数える）。
//     お客様が貼った物件の文（URL・長文の物件情報）は落とす。

import { toHalf, type CandidateFacts } from "./candidate-facts";

export type TopicKey =
  | "zero_deposit" | "low_initial" | "free_rent" | "rent" | "station_near" | "commute" | "new_build" | "spacious" | "layout"
  | "bath_toilet" | "washbasin" | "laundry_in" | "autolock" | "delivery_box" | "security" | "floor2" | "pet" | "parking"
  | "sunny" | "kitchen" | "bath_dryer" | "reheating" | "internet" | "storage" | "corner" | "move_in" | "screening"
  | "furnished" | "surroundings" | "quiet";

type Topic = { key: TopicKey; label: string; appeal: RegExp | null; want: RegExp | null };

/**
 * 話題の語彙。appeal = 🌟の本文での言い方、want = お客様の条件の自由文・発言での言い方。
 * 実物の🌟の本文（2026-09-24〜25）と条件欄の言い方から作った。
 */
export const TOPICS: Topic[] = [
  { key: "zero_deposit", label: "敷礼0", appeal: /敷金礼金(?:共に|とも)?(?:なし|0|ゼロ|無し)|敷礼(?:なし|0|ゼロ)|礼金敷金(?:なし|0)|敷金・礼金(?:なし|0)|ゼロゼロ/, want: /敷金?礼金?.{0,4}(?:なし|0|ゼロ|無し|かからない)|敷礼|ゼロゼロ|礼金なし/ },
  { key: "low_initial", label: "初期費用", appeal: /初期費用/, want: /初期費用|初期.{0,3}(?:安|抑)|費用.{0,4}(?:抑え|安く)|なるべく安/ },
  { key: "free_rent", label: "フリーレント", appeal: /フリーレント/, want: /フリーレント/ },
  { key: "rent", label: "家賃", appeal: /家賃|管理費込|月額|賃料/, want: /家賃.{0,6}(?:以内|まで|以下|抑え|安)|予算/ },
  { key: "station_near", label: "駅近", appeal: /駅近|駅(?:から)?徒歩\s*\d|徒歩\s*\d{1,2}\s*分/, want: /駅近|駅から近|駅(?:から)?徒歩|徒歩\s*\d{1,2}\s*分(?:以内)?/ },
  { key: "commute", label: "通勤・アクセス", appeal: /通勤|通学|アクセス|一本|乗り換え|乗換/, want: /通勤|通学|職場|会社|勤務先|一本で|乗り換え|乗換|アクセス/ },
  { key: "new_build", label: "築浅・新築", appeal: /新築|築浅|築\s*\d{1,2}\s*年|リノベ|綺麗|きれい|キレイ/, want: /新築|築浅|築\s*\d{1,2}\s*年|綺麗|きれい|キレイ|リノベ|古(?:い|すぎ)/ },
  { key: "spacious", label: "広さ", appeal: /\d+(?:\.\d+)?\s*帖|\d+(?:\.\d+)?\s*㎡|広[いさめ々]|ゆとり|ゆったり/, want: /広[いさめ]|\d+\s*㎡|\d+\s*帖|ゆとり|狭い(?:の|は)|手狭/ },
  { key: "layout", label: "間取り", appeal: /2部屋|部屋を分け|分かれ|[1-9]S?L?DK/, want: /部屋を分け|寝室(?:と|を)|[1-9]S?L?DK(?:以上|がいい|希望)|リビング/ },
  { key: "bath_toilet", label: "バス・トイレ別", appeal: /バス(?:・)?トイレ別|バストイレ別|風呂トイレ別/, want: /バス(?:・)?トイレ別|バストイレ別|風呂(?:と)?トイレ(?:が)?別|ユニットバス(?:は|NG|嫌)|3点ユニット/ },
  { key: "washbasin", label: "独立洗面台", appeal: /独立洗面/, want: /独立洗面|洗面台/ },
  { key: "laundry_in", label: "室内洗濯機置場", appeal: /室内洗濯機/, want: /室内洗濯機|洗濯機(?:置き場)?.{0,4}(?:室内|中)|ベランダ.{0,4}洗濯機/ },
  { key: "autolock", label: "オートロック", appeal: /オートロック/, want: /オートロック/ },
  { key: "delivery_box", label: "宅配ボックス", appeal: /宅配(?:BOX|ボックス|box)/i, want: /宅配(?:BOX|ボックス|box)/i },
  { key: "security", label: "セキュリティ", appeal: /セキュリティ|防犯|スマートロック|モニター付/, want: /セキュリティ|防犯|女性(?:の)?一人|治安/ },
  { key: "floor2", label: "2階以上", appeal: /[2-9２-９]\s*階|高層|上層|最上階|眺望/, want: /[2-9２-９]\s*階以上|1階(?:は|が)?(?:NG|不可|嫌|避け|なし)|高層/ },
  { key: "pet", label: "ペット", appeal: /ペット/, want: /ペット|犬|猫|小型犬/ },
  { key: "parking", label: "駐車場", appeal: /駐車場/, want: /駐車場|車を|車が/ },
  { key: "sunny", label: "日当たり", appeal: /日当たり|陽当たり|南向き|採光|明るい/, want: /日当たり|陽当たり|南向き|明るい/ },
  { key: "kitchen", label: "キッチン", appeal: /キッチン|[2二]口コンロ|コンロ[2二]口|自炊/, want: /キッチン|[2二]口コンロ|コンロ|自炊|料理/ },
  { key: "bath_dryer", label: "浴室乾燥機", appeal: /浴室(?:換気)?乾燥/, want: /浴室(?:換気)?乾燥/ },
  { key: "reheating", label: "追い焚き", appeal: /追(?:い)?焚|追炊/, want: /追(?:い)?焚|追炊/ },
  { key: "internet", label: "ネット無料", appeal: /ネット(?:使用料)?無料|Wi-?Fi/i, want: /ネット|Wi-?Fi|光回線/i },
  { key: "storage", label: "収納", appeal: /収納|クローゼット|ウォークイン|WIC/i, want: /収納|クローゼット|ウォークイン|WIC/i },
  { key: "corner", label: "角部屋", appeal: /角部屋/, want: /角部屋/ },
  { key: "move_in", label: "入居時期", appeal: /即入居|空室のため|入居可能|すぐ(?:に)?(?:ご)?入居/, want: /入居(?:時期|日|希望)|引っ越し(?:日|時期)|月(?:中|末|上旬|中旬|下旬)まで|すぐ(?:に)?(?:入居|引っ越)|急ぎ/ },
  { key: "screening", label: "審査", appeal: /審査|保証会社/, want: /審査|保証会社|保証人|ブラック|滞納|自己破産|無職|収入/ },
  { key: "furnished", label: "家具家電", appeal: /家具(?:・)?家電/, want: /家具(?:・)?家電/ },
  { key: "surroundings", label: "周辺環境", appeal: /スーパー|コンビニ|商店街|飲食店|生活(?:し)?(?:やす|環境)|公園/, want: /スーパー|コンビニ|商店街|買い物|周辺環境|公園/ },
  { key: "quiet", label: "静かさ", appeal: /静か|防音|閑静|RC造|鉄筋/, want: /静か|防音|騒音|音(?:が)?(?:気|うるさ)|閑静|RC|鉄筋/ },
];
export const TOPIC_LABEL: Record<TopicKey, string> = Object.fromEntries(TOPICS.map((t) => [t.key, t.label])) as Record<TopicKey, string>;

/** 🌟の本文の1行目 → 物件名と号室（「🌟グランコート 201号室」「🌟パレス城北 401」） */
export function starHeadOf(text: string | null | undefined): { name: string; room: string | null } | null {
  const first = String(text ?? "").split("\n")[0] ?? "";
  if (!/^\s*🌟/u.test(first)) return null;
  const head = first.replace(/^\s*🌟\s*/u, "").trim();
  if (!head) return null;
  const h = toHalf(head);
  const m = h.match(/^(.*?)[\s]*([A-Za-z]?-?\d{1,4})\s*号室?\s*$/) ?? h.match(/^(.*\S)\s+([A-Za-z]?\d{2,4})$/);
  if (m && m[1].trim()) return { name: m[1].trim(), room: m[2].replace(/^0+(?=\d)/, "") };
  return { name: h, room: null };
}

/** 🌟の本文 → 訴求した話題（1行目の物件名は見ない） */
export function appealTopics(text: string | null | undefined): TopicKey[] {
  const body = toHalf(String(text ?? "").split("\n").slice(1).join("\n"));
  return TOPICS.filter((t) => t.appeal && t.appeal.test(body)).map((t) => t.key);
}

/** お客様の発言のうち、希望の材料にしない物（URL・貼った物件の長文・空） */
export function isUsableCustomerText(t: string | null | undefined): boolean {
  const s = String(t ?? "").trim();
  if (!s) return false;
  if (/https?:\/\//.test(s)) return false;
  // 貼った物件情報（賃料・間取り・所在地が並ぶ長文）
  if (s.length > 200 && /(?:賃料|家賃)/.test(s) && /(?:所在地|間取り|専有面積)/.test(s)) return false;
  return true;
}

export type CustomerWantInput = {
  conditions?: {
    rent_max?: number | null; max_rent?: number | null; floor_plan?: string | null; walk_minutes?: number | null; building_age?: number | null;
    initial_cost_limit?: number | null; pet?: boolean | null; move_in_time?: string | null; floor_area_min?: number | null;
    preferences?: string | null; ng_points?: string | null; other_requests?: string | null; additional_conditions?: string | null; raw_format_text?: string | null;
  } | null;
  /** お客様の発言（新しい順でも古い順でもよい） */
  messages?: string[] | null;
};

export type WantHit = { key: TopicKey; from: "conditions" | "free_text" | "messages" };

/** お客様が求めている話題（条件欄の構造化・自由文・発言）。同じ話題は最初に見つかった出どころだけ */
export function customerWants(input: CustomerWantInput): WantHit[] {
  const out: WantHit[] = [];
  const add = (key: TopicKey, from: WantHit["from"]) => { if (!out.some((w) => w.key === key)) out.push({ key, from }); };
  const c = input.conditions ?? {};
  if (c.initial_cost_limit != null && c.initial_cost_limit > 0) add("low_initial", "conditions");
  if (c.pet === true) add("pet", "conditions");
  if (c.walk_minutes != null && c.walk_minutes > 0) add("station_near", "conditions");
  if (c.building_age != null && c.building_age > 0) add("new_build", "conditions");
  if (c.floor_area_min != null && c.floor_area_min > 0) add("spacious", "conditions");
  if (c.move_in_time && !/未定|特になし|いつでも/.test(c.move_in_time)) add("move_in", "conditions");
  const free = toHalf([c.preferences, c.ng_points, c.other_requests, c.additional_conditions, c.raw_format_text].filter(Boolean).join("\n"));
  for (const t of TOPICS) if (t.want && t.want.test(free)) add(t.key, "free_text");
  const msgs = toHalf((input.messages ?? []).filter(isUsableCustomerText).join("\n"));
  for (const t of TOPICS) if (t.want && t.want.test(msgs)) add(t.key, "messages");
  return out;
}

export type FactProfile = { rentMax?: number | null; walkMax?: number | null; ageMax?: number | null; sqmMin?: number | null };

const EQUIP_TOPIC: Record<string, TopicKey> = {
  "オートロック": "autolock", "宅配ボックス": "delivery_box", "バス・トイレ別": "bath_toilet", "独立洗面台": "washbasin",
  "室内洗濯機置場": "laundry_in", "追い焚き": "reheating", "浴室乾燥機": "bath_dryer", "システムキッチン": "kitchen", "対面キッチン": "kitchen",
  "2口コンロ": "kitchen", "ネット無料": "internet", "角部屋": "corner", "南向き": "sunny", "ペット相談": "pet", "駐車場": "parking",
  "ウォークインクローゼット": "storage", "家具家電付き": "furnished", "スマートロック": "security", "モニター付インターホン": "security",
};

/**
 * 候補の値で決められる話題: yes（満たす）/ no（満たさない）/ 無い話題は blind（値が無くて分からない）。
 * 設備は「語がある＝yes」だけ（語が無いのは『無い』ではない＝blind のまま）
 */
export function factTopics(c: CandidateFacts, p: FactProfile = {}): { yes: TopicKey[]; no: TopicKey[] } {
  const yes: TopicKey[] = [], no: TopicKey[] = [];
  const put = (k: TopicKey, v: boolean | null) => { if (v === true) yes.push(k); else if (v === false) no.push(k); };
  const dep = c.deposit_months, key = c.key_money_months;
  put("zero_deposit", dep != null && key != null ? dep === 0 && key === 0 : (dep != null && dep > 0) || (key != null && key > 0) ? false : null);
  const walk = c.walk_minutes;
  put("station_near", walk == null ? null : walk <= (p.walkMax && p.walkMax > 0 ? p.walkMax : 7));
  const age = c.building_age;
  put("new_build", age == null ? null : age <= (p.ageMax && p.ageMax > 0 ? p.ageMax : 10));
  const sqm = c.area_sqm;
  if (sqm != null && p.sqmMin && p.sqmMin > 0) put("spacious", sqm >= p.sqmMin);
  if (c.floor != null) put("floor2", c.floor >= 2);
  if (c.rent != null && p.rentMax && p.rentMax > 0) put("rent", c.rent + (c.admin_fee_yen ?? 0) <= p.rentMax);
  for (const e of c.equipment ?? []) { const k = EQUIP_TOPIC[e]; if (k && !yes.includes(k)) yes.push(k); }
  return { yes, no };
}

export type RoundCandidate = { facts: CandidateFacts; isStar: boolean; score: number | null };
export type RoundGap = {
  wants: WantHit[];
  appeals: TopicKey[];
  /** お客様が求めたのに🌟で訴求していない話題 */
  wantedNotAppealed: TopicKey[];
  /** 🌟で訴求したがお客様の希望に無い話題（スタッフが見つけた良さ） */
  appealedNotWanted: TopicKey[];
  /** 訴求した話題のうち、🌟の物件の値でブレインに見えている物・見えていない物 */
  appealSeen: TopicKey[];
  appealBlind: TopicKey[];
  /** ブレインの点（無ければ null） */
  starScore: number | null;
  topScore: number | null;
  /** 🌟の順位（同点は平均）・候補数 */
  starPos: number | null;
  n: number;
  /** ブレインの一番（🌟以外で🌟より点が高い物の先頭）と🌟の、事実で分かれた話題 */
  top: { name: string; score: number; starOnly: TopicKey[]; topOnly: TopicKey[] } | null;
};

/** 1回分のギャップ */
export function compareRound(input: { starText: string; wants: WantHit[]; candidates: RoundCandidate[]; profile?: FactProfile }): RoundGap {
  const appeals = appealTopics(input.starText);
  const wantKeys = input.wants.map((w) => w.key);
  const star = input.candidates.find((c) => c.isStar) ?? null;
  const starFacts = star ? factTopics(star.facts, input.profile) : { yes: [], no: [] };
  const seen = new Set<TopicKey>([...starFacts.yes, ...starFacts.no]);
  // 事実で決められない話題（通勤・審査・周辺環境・入居時期…）は「見えていない」に数えない（候補の値の話ではない）
  const FACTUAL: TopicKey[] = ["zero_deposit", "station_near", "new_build", "spacious", "floor2", "rent", ...Object.values(EQUIP_TOPIC)];
  const appealFactual = appeals.filter((a) => FACTUAL.includes(a));
  const scored = input.candidates.filter((c) => c.score != null);
  let starPos: number | null = null, top: RoundGap["top"] = null;
  const topScore = scored.length ? Math.max(...scored.map((c) => c.score as number)) : null;
  if (star && star.score != null && scored.length >= 2) {
    const others = scored.filter((c) => c !== star);
    const gt = others.filter((c) => (c.score as number) > (star.score as number)).length;
    const eq = others.filter((c) => c.score === star.score).length;
    starPos = 1 + gt + eq / 2;
    const best = [...others].sort((a, b) => (b.score as number) - (a.score as number))[0];
    if (best && (best.score as number) > (star.score as number)) {
      const tf = factTopics(best.facts, input.profile);
      top = {
        name: String(best.facts.name ?? ""),
        score: best.score as number,
        starOnly: starFacts.yes.filter((k) => !tf.yes.includes(k)),
        topOnly: tf.yes.filter((k) => !starFacts.yes.includes(k)),
      };
    }
  }
  return {
    wants: input.wants,
    appeals,
    wantedNotAppealed: wantKeys.filter((k) => !appeals.includes(k)),
    appealedNotWanted: appeals.filter((k) => !wantKeys.includes(k)),
    appealSeen: appealFactual.filter((k) => seen.has(k)),
    appealBlind: appealFactual.filter((k) => !seen.has(k)),
    starScore: star?.score ?? null,
    topScore,
    starPos,
    n: input.candidates.length,
    top,
  };
}

/** 画面・報告に出す前に、お客様の呼び名（「〇〇さん」）と電話番号らしい数字を伏せる */
export function maskPersonal(text: string | null | undefined): string {
  return String(text ?? "")
    .replace(/[^\s、。！!？?・「」]{1,10}(?:さん|様|さま|くん|ちゃん)/g, "〇〇さん")
    .replace(/0\d{1,4}[-‐ー]?\d{1,4}[-‐ー]?\d{3,4}/g, "***");
}
