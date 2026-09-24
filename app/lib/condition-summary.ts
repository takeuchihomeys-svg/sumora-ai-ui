// app/lib/condition-summary.ts（純関数・DB 依存なし。サーバー専用の部品から使う＝area-want の駅の表を引くので画面から import しない）
// お客様の条件（列＋自由文）を「必須／NG／できれば」と種類・値の構造に要約する。スタッフ向け（売上サポの「条件の要約: …」）。お客様には出さない。
//
// 2026-09-25 竹内「文章の部分も要約できるようにする」:
//   ① 決定論で読める物は決定論（家賃・間取り・広さ・徒歩・築年・入居時期・エリア・通勤・設備 parseEquipmentWants・入居の条件）
//   ② 決定論で読めない節（設備のキーに当たらない部屋の条件・別の所で見ると振ったが誰も照らしていない節・エリアの読めない語）だけを
//      DeepSeek（deepseek-flash・推論なし・固定の前置きを先頭）で要約する（condition-summary-server.ts）
//   ③ 自由文のハッシュを鍵に保存し、文が変わらない限り呼ばない（property_customers.condition_summary / condition_summary_hash）
//   2026-09-25 竹内「喫煙とかは不要」: 喫煙・家具家電は照らさず、照らせない条件にも出さない
import { parseEquipmentWants, EQUIP_LABELS, type EquipKey, type EquipmentWants } from "./listing-equipment";
import { CONDITION_LABELS } from "./listing-terms";
import { buildCustomerProfile, type CustomerLike, type CustomerProfile } from "./property-brain";
import { parseAreaWant, parseCommuteWants, type AreaWant, type CommuteWant } from "./area-want";
import { stationsInText, wardsInText } from "./osaka-geo";

export const CONDITION_SUMMARY_VERSION = "cs1";

export type SummaryCustomer = CustomerLike & {
  customer_name?: string | null;
  desired_area?: string | null;
  commute_station?: string | null;
  commute_minutes?: number | null;
};

export type SummaryItem = {
  /** 家賃・間取り・広さ・徒歩・築年・入居・エリア・通勤・設備・入居者・費用・部屋・内装・周辺環境・審査・その他 */
  kind: string;
  mode: "must" | "ng" | "soft" | "info";
  label: string;
  /** 決定論か DeepSeek か */
  by: "rule" | "ai";
};

export type ConditionSummary = {
  v: string;
  items: SummaryItem[];
  /** 決定論で読めなかった節（DeepSeek に渡す候補・照らせない条件） */
  unread: string[];
  /** 別の所で見ると振った節のうち、どの判定も照らしていない物 */
  unchecked: string[];
  area: AreaWant;
  commute: CommuteWant[];
  profile: CustomerProfile;
  equipment: EquipmentWants;
};

/** 不要と言われた条件（喫煙・家具家電）は照らさず、照らせない条件にも出さない（竹内 2026-09-25） */
export const SKIP_CLAUSE_RE = /喫煙|タバコ|たばこ|禁煙|家具|家電/;

/** 決定論で照らしている種類の言葉（別の所で見ると振った節のうち、これに当たる物は「照らしている」） */
const COVERED_ELSEWHERE_RE = /家賃|賃料|[0-9０-９.]+\s*万|円|初期費用|費用|敷金|礼金|敷礼|更新料|フリーレント|築|新築|新し|徒歩|分以内|間取り|[1-5１-５]\s*(?:S?LDK|DK|K|R)(?![a-z])|ワンルーム|平米|㎡|m2|入居(?:時期|日)|契約|法人|楽器|学生|外国|単身|二人|2人|同棲|ルームシェア|子供|子ども|ペット|管理費|共益費|保証人不要/;
/** 照らしていない種類（資料で決まらない・判定に無い） */
const UNCHECKABLE_KIND: Array<[RegExp, string]> = [
  [/綺麗|きれい|キレイ|清潔|内装|リノベ|リフォーム|白|基調|おしゃれ|デザイナーズ/, "内装"],
  [/治安|静か|閑静|環境|スーパー|コンビニ|学区|保育園|幼稚園|病院|公園|繁華街|飲み屋|線路|大通り|周辺/, "周辺環境"],
  [/審査|保証会社|ブラック|滞納|破産|任意整理|債務整理|信用情報|無職|生活保護|夜職|水商売|年金/, "審査"],
  [/駅|沿線|エリア|丁目|付近|近く|近い|電車|通勤|職場/, "立地"],
];

/** 自由文（ハッシュの元・DeepSeek に渡す材料の元）。自動の記録行は外す */
export function conditionFreeText(c: SummaryCustomer): string {
  const add = String(c.additional_conditions ?? "").split("\n").map((l) => l.replace(/^\s*\[[^\]]*\]\s*/, "")).filter((l) => l && !/物件を検索してください|読み取り結果|画面の種類/.test(l)).join("\n");
  return [c.preferences, c.other_requests, c.ng_points, add, c.desired_area].map((s) => String(s ?? "").trim()).filter(Boolean).join("\n");
}

const man = (v: number) => (v >= 10_000 ? `${Math.round(v / 1000) / 10}万` : `${v}円`);
const shortWard = (w: string) => w.replace(/^大阪市/, "");

/** 決定論の要約 */
export function buildConditionSummary(c: SummaryCustomer, opts: { today?: Date | string } = {}): ConditionSummary {
  const profile = buildCustomerProfile(c, [], [], null, { today: opts.today });
  const eq = parseEquipmentWants(c);
  const freeForArea = [c.preferences, c.other_requests].filter(Boolean).join("\n");
  const area = parseAreaWant(c.desired_area, freeForArea);
  const commute = parseCommuteWants(c);
  const items: SummaryItem[] = [];
  const push = (kind: string, mode: SummaryItem["mode"], label: string) => { if (label && !items.some((x) => x.kind === kind && x.label === label)) items.push({ kind, mode, label, by: "rule" }); };

  // 家賃
  if (profile.rentMax != null || profile.rentMin != null) {
    push("家賃", "must", profile.rentMin != null && profile.rentMax != null ? `${man(profile.rentMin)}〜${man(profile.rentMax)}` : profile.rentMax != null ? `${man(profile.rentMax)}まで` : `${man(profile.rentMin as number)}以上`);
  }
  // 間取り
  // 列の「（1DKも可）」は下の「できれば」に出すので本命の言い方から外す
  if (!profile.floorPlanWant.any) push("間取り", "must", profile.floorPlanWant.raw.replace(/[（(][^）)]*(?:も可|でも|厳しければ|なければ)[^）)]*[）)]/g, "").replace(/\s+/g, " ").trim().slice(0, 20));
  if (profile.floorPlanAlt?.plans.length) push("間取り", "soft", `${profile.floorPlanAlt.plans.join("・")}も可`);
  if (profile.sqmMin != null) push("広さ", "must", `${profile.sqmMin}㎡以上`);
  if (profile.walkMax != null) push("徒歩", "must", `${profile.walkMax}分以内`);
  if (profile.buildingAgeMax != null) push("築年", "must", `${profile.buildingAgeMax}年以内`);
  else if (profile.ageTextMax) push("築年", "soft", `${profile.ageTextMax.word}（${profile.ageTextMax.years}年以内の目安）`);
  if (profile.moveInWant && profile.moveInWant.label && profile.moveInWant.kind !== "none") push("入居", profile.moveInWant.kind === "by" || profile.moveInWant.kind === "asap" ? "must" : "info", profile.moveInWant.label);
  if (profile.wantsLowInitialCost) push("費用", "soft", profile.initialCostLimit != null ? `初期費用${man(profile.initialCostLimit)}まで` : "初期費用を抑えたい");
  else if (profile.initialCostLimit != null) push("費用", "must", `初期費用${man(profile.initialCostLimit)}まで`);
  // エリア
  const areaParts: string[] = [
    ...area.stations.slice(0, 6).map((s) => s.station + (s.radiusKm && s.radiusKm !== 2 ? `（${s.radiusKm}km）` : "")),
    ...area.wards.slice(0, 6).map(shortWard),
    ...area.lines.slice(0, 3).map((l) => l.word),
    ...area.places.map((p) => p.name.replace(/（.*$/, "")),
    ...area.regions.map((r) => r.name),
  ];
  const moreSt = area.stations.length > 6 ? `ほか${area.stations.length - 6}駅` : "";
  if (areaParts.length) push("エリア", "must", areaParts.join("・") + (moreSt ? `・${moreSt}` : ""));
  if (area.exclude.stations.length || area.exclude.wards.length) push("エリア", "ng", [...area.exclude.stations, ...area.exclude.wards.map(shortWard)].join("・") + "以外");
  for (const d of area.directions) push("エリア", "must", d.label ?? `${d.anchor}より${({ north: "北", south: "南", east: "東", west: "西" } as const)[d.dir]}`);
  for (const w of commute.slice(0, 3)) push("通勤", w.minutes != null ? "must" : "soft", w.minutes != null ? `${w.target}まで${w.minutes}分` : `${w.target}へ出やすい`);
  // 設備（must / ng / できれば）
  for (const w of eq.wants) {
    const label = EQUIP_LABELS[w.key as EquipKey] ?? String(w.key);
    const floor = w.key === "floor" ? (w.minFloor != null ? `${w.minFloor}階以上` : w.maxFloor != null ? `${w.maxFloor}階以下` : "階") : null;
    push("設備", w.mode === "ng" ? "ng" : w.soft ? "soft" : "must", (floor ?? label) + (w.strong ? "［必須］" : ""));
  }
  for (const k of profile.conditionWants ?? []) push("入居者", "info", CONDITION_LABELS[k]);

  // 読めなかった節
  const unread: string[] = [];
  for (const u of eq.uncovered) if (!SKIP_CLAUSE_RE.test(u.text)) unread.push(u.text);
  const unchecked: string[] = [];
  const areaNames = new Set([...area.stations.map((s) => s.station), ...area.exclude.stations, ...commute.map((c) => c.target)]);
  const areaWards = new Set([...area.wards, ...area.exclude.wards]);
  for (const h of eq.handledElsewhere) {
    if (SKIP_CLAUSE_RE.test(h.text)) continue;
    if (COVERED_ELSEWHERE_RE.test(h.text)) continue;
    // エリア・通勤で読めた駅・区が入っている節（「梅田まで電車で30分程度」「◯◯駅周辺」）は照らしている
    if (stationsInText(h.text).some((s) => areaNames.has(s.station)) || wardsInText(h.text).some((w) => areaWards.has(w.ward))) continue;
    unchecked.push(h.text);
  }
  for (const u of area.unread) if (!SKIP_CLAUSE_RE.test(u)) unread.push(`エリア: ${u}`);
  return { v: CONDITION_SUMMARY_VERSION, items, unread: [...new Set(unread)].slice(0, 20), unchecked: [...new Set(unchecked)].slice(0, 20), area, commute, profile, equipment: eq };
}

/** 照らせない条件（読めない節＋別の所で見ると振ったが照らしていない節）。種類の目印を付ける */
export function uncheckableLabels(s: Pick<ConditionSummary, "unread" | "unchecked">, ai?: SummaryItem[] | null): string[] {
  const out: string[] = [];
  const all = [...s.unread, ...s.unchecked];
  for (const t of all) {
    const kind = UNCHECKABLE_KIND.find(([re]) => re.test(t))?.[1] ?? null;
    out.push(kind && !t.startsWith("エリア:") ? `${kind}: ${t}` : t);
  }
  // DeepSeek の要約があれば、その短い言い方に置き換える（同じ数だけ）
  if (ai && ai.length) return ai.filter((x) => x.mode !== "info").map((x) => `${x.kind}: ${x.label}${x.mode === "ng" ? "（NG）" : x.mode === "soft" ? "（できれば）" : ""}`).slice(0, 12);
  return out.slice(0, 12);
}

/** 画面の1行（「条件の要約: 家賃6〜8万・間取り 1LDK（1DKも可）・…」）。項目が多い時は種類ごとに先頭だけ */
export function formatSummaryLine(items: SummaryItem[]): string {
  const order = ["家賃", "間取り", "広さ", "エリア", "通勤", "徒歩", "築年", "入居", "費用", "設備", "入居者", "部屋", "内装", "周辺環境", "審査", "立地", "その他"];
  const byKind = new Map<string, SummaryItem[]>();
  for (const it of items) byKind.set(it.kind, [...(byKind.get(it.kind) ?? []), it]);
  const parts: string[] = [];
  for (const k of [...order, ...[...byKind.keys()].filter((x) => !order.includes(x))]) {
    const xs = byKind.get(k);
    if (!xs?.length) continue;
    const must = xs.filter((x) => x.mode === "must" || x.mode === "info").map((x) => x.label);
    const ng = xs.filter((x) => x.mode === "ng").map((x) => x.label);
    const soft = xs.filter((x) => x.mode === "soft").map((x) => x.label);
    const seg = [must.join("・"), ng.length ? `NG ${ng.join("・")}` : "", soft.length ? `できれば ${soft.join("・")}` : ""].filter(Boolean).join("／");
    parts.push(`${k} ${seg}`);
  }
  return parts.join("｜");
}

// ───────────────────────── DeepSeek（読めない節だけ） ─────────────────────────

/**
 * 固定の前置き（毎回一字一句同じ＝DeepSeek の前置きキャッシュが効く）。お客様の文は後ろの user にだけ入れる。
 * 変えたら CONDITION_SUMMARY_VERSION を上げる（保存した要約を作り直す）
 */
export const SUMMARY_SYSTEM_PROMPT = [
  "あなたは賃貸の仲介スタッフの補助です。お客様がお部屋探しの条件欄に書いた文の断片を、スタッフが一目で読める短い条件に要約します。",
  "返すのは JSON だけ: {\"items\":[{\"i\":番号,\"kind\":種類,\"mode\":\"must|ng|soft|info\",\"label\":\"短い言い方\"}]}",
  "種類は次のどれか1つ: 部屋 / 内装 / 設備 / 周辺環境 / 立地 / 審査 / 入居者 / 費用 / その他",
  "mode: must＝必ず欲しい・ng＝避けたい・soft＝できれば・info＝お客様の事情（条件ではない）",
  "label は 20 字以内。文に書いてある事だけを短くする（書いていない事を足さない・推測しない・物件名や人名を入れない）。",
  "条件でない断片（挨拶・やり取り・メモ）は items に入れない。1つの断片から条件が2つ出る時は2つに分ける。",
  "例: 「白基調のお部屋が良い」→ {\"i\":1,\"kind\":\"内装\",\"mode\":\"soft\",\"label\":\"白基調の内装\"}",
  "例: 「治安が悪くなく帰る手段が多い地域」→ {\"i\":2,\"kind\":\"周辺環境\",\"mode\":\"must\",\"label\":\"治安が良い\"}, {\"i\":2,\"kind\":\"立地\",\"mode\":\"must\",\"label\":\"帰りの交通手段が多い\"}",
].join("\n");

/** user に入れる文（番号付きの断片）。名前・電話・メール・番地は呼ぶ側で伏せてから渡す */
export function buildSummaryUserText(clauses: string[]): string {
  return clauses.map((c, i) => `${i + 1}. ${c.replace(/\s+/g, " ").slice(0, 120)}`).join("\n");
}

const AI_KINDS = new Set(["部屋", "内装", "設備", "周辺環境", "立地", "審査", "入居者", "費用", "その他"]);
/** DeepSeek の答え → 要約の項目（形が崩れていれば空） */
export function parseSummaryResponse(text: string, n: number): SummaryItem[] {
  try {
    const body = String(text ?? "").match(/\{[\s\S]*\}/)?.[0] ?? "";
    const o = JSON.parse(body) as { items?: Array<Record<string, unknown>> };
    const out: SummaryItem[] = [];
    for (const x of o.items ?? []) {
      const i = Number(x.i);
      const kind = String(x.kind ?? "").trim();
      const mode = String(x.mode ?? "").trim();
      const label = String(x.label ?? "").replace(/\s+/g, " ").trim().slice(0, 24);
      if (!(i >= 1 && i <= n) || !AI_KINDS.has(kind) || !["must", "ng", "soft", "info"].includes(mode) || !label) continue;
      if (SKIP_CLAUSE_RE.test(label)) continue;
      out.push({ kind, mode: mode as SummaryItem["mode"], label, by: "ai" });
    }
    return out;
  } catch { return []; }
}

/** 番地・電話・メールを伏せる（名前は呼ぶ側で maskPII） */
export function maskClause(s: string): string {
  return String(s ?? "")
    .replace(/[\w.+-]+@[\w-]+\.[\w.-]+/g, "＊")
    .replace(/0\d{1,4}-?\d{1,4}-?\d{3,4}/g, "＊")
    .replace(/\d+\s*丁目[\d\-ー－]*|\d+-\d+(?:-\d+)?|\d+番地?\d*号?/g, "＊");
}
