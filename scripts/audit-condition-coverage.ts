// scripts/audit-condition-coverage.ts — お客様の条件の「種類ごとに、物件のどこで照らしているか／どこでも照らしていない（漏れ）」の全件監査（DB は読むだけ）
// 実行: npx tsx --env-file=.env.local scripts/audit-condition-coverage.ts [--examples] [--json]
//   --examples: 漏れの種類ごとに条件の文の例（最大5・30字まで）を出す
//   --json:     種類ごとの件数を JSON でも出す
//
// 2026-09-24 竹内「YUMA でテストお願い。ほかにもれないか」（HONOKA さんの件: 宅配BOX・エレベーターが条件欄にあるのに物件の照合で見ていなかった）
//   → 設備以外にも「条件欄にあるのに、物件の判定・🌟・売上サポの表示・画像で分析で見ていない条件」が無いかを種類ごとに数える。
//
// 照らす所（本番と同じ関数をそのまま当てる。LLM は呼ばない）:
//   検索 S … 拡張がポータルの検索画面に入れる条件（popup.js / *-page-script.js。列だけ見る・手動の案内は「案内」）
//   判定 J … app/lib/property-brain.ts buildCustomerProfile → judgeProperty（家賃・敷礼・間取り・徒歩・築年・ペット・画像の希望）
//   設備 E … app/lib/listing-equipment.ts parseEquipmentWants → matchEquipment（売上サポの「条件:」の行と EQUIP_* の札）
//   🌟  R … chrome-extension/popup.js buildCustomerConditionsString（🌟 の順位付け buildRankPrompt に渡る文。下に写しがある）
//   画像 I … app/lib/image-wants.ts extractImageWants（🔍 画像で分析の希望。ここでは条件欄だけ・会話は入れない）
// 漏れ = 条件欄にあるのに J・E・R・I のどれにも届いていない（検索 S だけは「検索では絞った」として別に数える）
//
// このファイルの KINDS は scripts/yuma-condition-leak-test.ts も使う（種類の一覧を1か所に置く）。
import { createClient } from "@supabase/supabase-js";
import {
  buildCustomerProfile, normalizeFloorPlanWant, matchFloorPlan, normalizeFloorPlanToken,
  type CustomerLike, type CustomerProfile,
} from "../app/lib/property-brain";
import { parseEquipmentWants, type EquipmentWants } from "../app/lib/listing-equipment";
import { extractImageWants, type ImageWant } from "../app/lib/image-wants";

// ───────────────────────── 🌟 に渡る条件の文（拡張の写し） ─────────────────────────

/**
 * chrome-extension/popup.js buildCustomerConditionsString の写し（2026-09-24 時点・v2.5.16）。
 * 拡張を直したらここも直す（🌟 の順位付けに渡る条件はこの文だけ。preferences・ng_points・入居時期・初期費用は入らない）
 */
export function buildCustomerConditionsString(c: Record<string, unknown> | null): string | null {
  if (!c) return null;
  const parts: string[] = [];
  const rentMax = Number(c.rent_max || c.max_rent || 0);
  if (rentMax) parts.push("予算" + (rentMax >= 10000 ? Math.round(rentMax / 10000) + "万円" : rentMax + "円") + "以内");
  const layout = c.floor_plan || c.layout;
  if (layout) parts.push(String(layout) + "希望");
  if (c.walk_minutes) parts.push("徒歩" + c.walk_minutes + "分以内");
  if (c.building_age) parts.push("築" + c.building_age + "年以内");
  const areaMin = c.floor_area_min || c.area_min || c.min_area;
  if (areaMin) parts.push(areaMin + "㎡以上");
  if (c.pet === true) parts.push("ペット可");
  else if (c.pet === false) parts.push("ペット不可");
  const area = c.desired_area || c.area;
  if (area) parts.push("エリア:" + area);
  return parts.length > 0 ? parts.join("・") : null;
}

// ───────────────────────── 1人分の材料 ─────────────────────────

export type CustomerRow = CustomerLike & {
  id?: string;
  customer_name?: string | null;
  desired_area?: string | null;
  move_in_time?: string | null;
  floor_area_min?: number | null;
  floor_area_max?: number | null;
  commute_station?: string | null;
  commute_minutes?: number | null;
  structure_types?: string | null;
  raw_format_text?: string | null;
  area_mode?: string | null;
};

export type Ctx = {
  c: CustomerRow;
  /** 条件欄の自由文（preferences・other_requests・additional_conditions の希望・ng_points） */
  text: string;
  /** NG 欄を除いた自由文 */
  wantText: string;
  /** 条件フォームの原文（登録時に列へ分けた元） */
  form: string;
  profile: CustomerProfile;
  eq: EquipmentWants;
  eqKeys: Set<string>;
  iw: ImageWant[];
  rank: string | null;
};

/** additional_conditions の自動の記録行（「正式条件フォーマット受信 → 物件を検索してください」）を外す */
function cleanAdditional(s: string | null | undefined): string {
  return String(s ?? "").split("\n").map((l) => l.replace(/^\s*\[[^\]]*\]\s*/, "")).filter((l) => l && !/物件を検索してください|読み取り結果|画面の種類/.test(l)).join("\n");
}

export function buildCtx(c: CustomerRow): Ctx {
  const add = cleanAdditional(c.additional_conditions);
  const wantText = [c.preferences, c.other_requests, add].map((s) => String(s ?? "")).filter(Boolean).join("\n");
  const text = [wantText, String(c.ng_points ?? "")].filter(Boolean).join("\n");
  const eq = parseEquipmentWants(c);
  return {
    c, text, wantText, form: String(c.raw_format_text ?? ""),
    profile: buildCustomerProfile(c),
    eq, eqKeys: new Set(eq.wants.map((w) => String(w.key))),
    iw: extractImageWants({ conditions: c }),
    rank: buildCustomerConditionsString(c as Record<string, unknown>),
  };
}

// ───────────────────────── 種類の一覧 ─────────────────────────

export type Where = "S" | "J" | "E" | "R" | "I";
export type Kind = {
  id: string;
  label: string;
  /** その人にこの種類の条件があるか（根拠の文。無ければ null） */
  present: (x: Ctx) => string | null;
  /** 照らしているか（その人の材料で本当に届くかを見る） */
  S?: (x: Ctx) => boolean;
  J?: (x: Ctx) => boolean;
  E?: (x: Ctx) => boolean;
  R?: (x: Ctx) => boolean;
  I?: (x: Ctx) => boolean;
  /** 判定の札（property_pickups.reason_codes）でこの種類に当たる物 */
  codeRe?: RegExp;
  /** 設備の照合（equipment.match[].key）でこの種類に当たる物 */
  equipKeys?: string[];
  /** 画像で分析の希望の文でこの種類に当たる物 */
  wantRe?: RegExp;
  /** 物件側の材料（資料の欄） */
  sheet: string;
  /** 物件側で照らせるか */
  readable: "実装あり" | "文字層にある（未実装）" | "一部の資料だけ" | "資料に無い";
};

/** 例の文から電話番号・郵便番号・番地を伏せる（報告に個人情報を出さない） */
export const safe = (s: string) => s.replace(/0\d{1,4}-?\d{1,4}-?\d{3,4}|\d{3}-\d{4}|\d+丁目[\d\-ー－]*|\d+-\d+(?:-\d+)?/g, "＊");
const has = (re: RegExp, s: string) => { const m = s.match(re); return m ? m[0] : null; };
const num = (v: unknown) => (typeof v === "number" && Number.isFinite(v) && v > 0 ? v : null);
const eqAny = (x: Ctx, keys: string[]) => keys.some((k) => x.eqKeys.has(k));
const iwAny = (x: Ctx, re: RegExp) => x.iw.some((w) => re.test(w.text));

/** 自由文・フォームの間取りの語のうち、列（floor_plan）の希望に入っていない物 */
export function floorPlanTextOnly(x: Ctx): string[] {
  const colWant = normalizeFloorPlanWant(x.c.floor_plan ?? x.c.layout);
  const formPlan = x.form.split("\n").filter((l) => /間取|広さ/.test(l)).join("\n");
  const toks = [...normalizeFloorPlanWant(x.wantText).plans, ...normalizeFloorPlanWant(formPlan).plans];
  const out: string[] = [];
  for (const t of toks) {
    const n = normalizeFloorPlanToken(t);
    if (!n || out.includes(n)) continue;
    if (!colWant.any && matchFloorPlan(colWant, n) === "match") continue;
    out.push(n);
  }
  return out;
}

const INSTRUMENT_RE = /楽器|ピアノ|ギター|ドラム|バイオリン|電子ピアノ|防音|DTM/;
const MOVE_IN_TEXT_RE = /即入居|すぐ(?:に)?入居|入居(?:時期|日|希望日)|[0-9０-９]{1,2}月(?:上旬|中旬|下旬|末|頃|中|から|まで|に)?(?:入居|引[っ越]?越)/;
const SCREEN_RE = /審査|ブラック|滞納|破産|任意整理|自己破産|債務整理|信用情報|クレジット(?:カード)?(?:が|を)?(?:作れ|持って)|無職|生活保護|保証会社/;
const STATUS_RE = /学生|大学生|専門学生|留学生|外国(?:籍|人)|国籍|法人(?:契約)?|社宅|事務所(?:利用|使用)?|SOHO|高齢|シニア|年金|女性限定|男性|女性専用|水商売|夜職|フリーランス|個人事業/;
const SMOKE_RE = /喫煙|タバコ|たばこ|禁煙/;
const TERM_RE = /定期借家|短期(?:契約|解約)?|マンスリー|契約期間/;
const RENEW_RE = /更新料/;
const FREERENT_RE = /フリーレント/;
/** 初期費用の「希望」の言い方（「初期費用も教えてほしい」「まだ考えていない」は希望ではないので数えない） */
const INITIAL_WANT_RE = /初期費用.{0,10}(?:抑|おさえ|安|少な|なし|無し|0円|ゼロ|以内|まで|激安|限度|前家賃|かからな)/;
const ZEROZERO_RE = /敷金礼金|敷礼|ゼロゼロ|敷金.{0,3}礼金|礼金(?:なし|無し|0|ゼロ)|敷金(?:なし|無し|0|ゼロ)/;
const ADMIN_RE = /管理費(?:込|含|こみ)|共益費(?:込|含|こみ)|管理費.{0,6}(?:込み|含めて|込で)|総額(?:で)?[0-9０-９.]+万/;
const SURROUND_RE = /スーパー|コンビニ|治安|静か|閑静|環境|学区|保育園|幼稚園|病院|公園|繁華街|飲み屋|線路|大通り/;
const FURN_RE = /家具(?:付|家電)|家電付|家具・家電/;
const NEWBUILD_RE = /新築|築浅|築[0-9０-９]{1,2}年|築年数|新しめ|新しい物件|リノベ|リフォーム/;
const STRUCT_RE = /RC|SRC|鉄筋|鉄骨|木造|軽量鉄骨|構造/;
const DIRECTION_RE = /[南東西北]向き|日当たり|日あたり|陽当たり|採光/;
const BIKE_RE = /バイク|原付|スクーター|自転車|駐輪/;
const TWO_RE = /二人入居|2人入居|２人入居|同棲|カップル|夫婦|ルームシェア|二人暮らし|2人暮らし|家族/;
const COMMUTE_RE = /通勤|通学|職場|勤務先|会社まで|乗り換え|乗換|まで(?:電車で?)?(?:1本)?\s*[0-9０-９]{1,2}(?:〜[0-9０-９]{1,2})?分|から電車[0-9０-９]{1,2}分|最終電車/;
const CLEAN_RE = /綺麗|きれい|キレイ|清潔|内装/;
const AREA_TEXT_RE = /より(?:北|南|東|西)|寄り|付近|あたり|沿線|方面|エリア(?:\[必須\])?$|以外の地域|丁目|避けたいエリア|エリアを広げ|エリアで探/;
const STATION_NEAR_RE = /駅近|駅に近|駅から近|駅(?:が|から)?(?:もう少し)?近い|駅チカ/;
const AREA_MULTI_SPLIT = /[・、,，/／]|または|or/;

export const KINDS: Kind[] = [
  {
    id: "rent_max", label: "家賃上限", present: (x) => (num(x.c.rent_max) ?? num(x.c.max_rent)) ? `rent_max=${x.c.rent_max ?? x.c.max_rent}` : null,
    S: () => true, J: (x) => x.profile.rentMax != null, R: (x) => /予算/.test(x.rank ?? ""),
    codeRe: /^RENT_(OK|SLIGHTLY_OVER|OVER_110|OVER_130|ABOVE_USUAL|UNKNOWN)$/, sheet: "賃料・管理費（説明文・文字層）", readable: "実装あり",
  },
  {
    id: "rent_max_unreliable", label: "家賃上限が入力誤りで使えない（上限<下限・3万未満）", present: (x) => x.profile.notes.includes("RENT_MAX_UNRELIABLE") ? `rent_max=${x.c.rent_max} rent_min=${x.c.rent_min}` : null,
    S: () => true, R: (x) => /予算/.test(x.rank ?? ""), codeRe: /^RENT_MAX_UNRELIABLE$/, sheet: "賃料", readable: "実装あり",
  },
  {
    id: "rent_min", label: "家賃下限", present: (x) => num(x.c.rent_min) ? `rent_min=${x.c.rent_min}` : null,
    S: () => true, sheet: "賃料", readable: "実装あり",
  },
  {
    id: "admin_fee", label: "管理費込みの予算（総額）", present: (x) => has(ADMIN_RE, x.text),
    J: (x) => x.profile.rentMax != null /* judgeProperty は常に 賃料＋管理費 で比べる */, sheet: "管理費・共益費", readable: "実装あり",
    codeRe: /^RENT_/,
  },
  {
    id: "initial_cost", label: "初期費用の上限・抑えたい", present: (x) => num(x.c.initial_cost_limit) ? `initial_cost_limit=${x.c.initial_cost_limit}` : has(INITIAL_WANT_RE, x.text),
    J: (x) => x.profile.wantsLowInitialCost || x.profile.initialCostLimit != null, codeRe: /^(ZERO_ZERO_MATCH|INITIAL_COST_NOT_ZERO|INITIAL_COST_OVER_LIMIT)$/,
    sheet: "敷金・礼金（説明文・文字層）。鍵交換・保証料・保険は文字層にあるが未計算", readable: "実装あり",
  },
  {
    id: "zero_zero", label: "敷礼ゼロ", present: (x) => has(ZEROZERO_RE, x.text),
    S: () => false /* ポータルの「敷礼なし」は手動のチェック */, J: (x) => x.profile.wantsLowInitialCost, codeRe: /^(ZERO_ZERO_MATCH|INITIAL_COST_NOT_ZERO)$/,
    sheet: "敷金・礼金", readable: "実装あり",
  },
  {
    id: "free_rent", label: "フリーレント", present: (x) => has(FREERENT_RE, x.text),
    // 2026-09-25: 資料の表（listing-terms）のフリーレントを判定に（FREE_RENT_MATCH +3・記載なしは FREE_RENT_UNLISTED 0点）
    J: (x) => !!x.profile.mentions?.freeRent, codeRe: /^FREE_RENT/,
    sheet: "備考・条件・特記事項（「フリーレント1ヶ月」）", readable: "実装あり",
  },
  {
    id: "area", label: "エリア（駅・区・路線）", present: (x) => x.c.desired_area ? `desired_area(${String(x.c.desired_area).split(AREA_MULTI_SPLIT).filter(Boolean).length}か所)` : null,
    S: () => true, R: (x) => /エリア:/.test(x.rank ?? ""), codeRe: /^(AREA_|STATION_)/,
    sheet: "所在地・交通（listing-text の access は読めている）", readable: "文字層にある（未実装）",
  },
  {
    id: "area_multi", label: "エリアが複数（広げた検索で外れた駅が混ざり得る）", present: (x) => (String(x.c.desired_area ?? "").split(AREA_MULTI_SPLIT).filter((s) => s.trim()).length >= 2 ? String(x.c.desired_area).slice(0, 30) : null),
    S: () => true, R: (x) => /エリア:/.test(x.rank ?? ""), codeRe: /^(AREA_|STATION_)/, sheet: "所在地・交通", readable: "文字層にある（未実装）",
  },
  {
    id: "area_text", label: "エリアの自由文（◯◯より北・寄り・付近・沿線・◯◯以外）", present: (x) => has(AREA_TEXT_RE, x.text),
    codeRe: /^(AREA_|STATION_)/, sheet: "所在地・交通", readable: "文字層にある（未実装）",
  },
  {
    id: "station_near", label: "駅近の自由文（徒歩の列が空）", present: (x) => (!num(x.c.walk_minutes) ? has(STATION_NEAR_RE, x.text) : null),
    codeRe: /^WALK_/, sheet: "交通（徒歩）", readable: "実装あり",
  },
  {
    id: "clean", label: "綺麗・内装（リノベ・水回り綺麗）", present: (x) => has(CLEAN_RE, x.text),
    I: (x) => iwAny(x, CLEAN_RE), wantRe: CLEAN_RE, sheet: "備考（リノベーション済・室内リフォーム）・写真", readable: "一部の資料だけ",
  },
  {
    id: "commute", label: "通勤・通学（駅まで◯分）", present: (x) => x.c.commute_station ? `commute_station(${x.c.commute_minutes ?? "?"}分)` : has(COMMUTE_RE, x.text),
    S: () => false /* 拡張は「電車で◯分以内」を手動の案内に出すだけ */, codeRe: /COMMUTE/, sheet: "交通（駅名）＋路線図（transit_graph）", readable: "文字層にある（未実装）",
  },
  {
    id: "walk", label: "駅徒歩", present: (x) => num(x.c.walk_minutes) ? `walk=${x.c.walk_minutes}` : null,
    S: () => true, J: (x) => x.profile.walkMax != null, R: (x) => /徒歩/.test(x.rank ?? ""), codeRe: /^WALK_/, sheet: "交通（徒歩）", readable: "実装あり",
  },
  {
    id: "floor_plan", label: "間取り（列）", present: (x) => (x.c.floor_plan ?? x.c.layout) ? String(x.c.floor_plan ?? x.c.layout).slice(0, 20) : null,
    S: () => true, J: (x) => !x.profile.floorPlanWant.any, R: (x) => /希望/.test(x.rank ?? ""), codeRe: /^FLOOR_PLAN_/, sheet: "間取り", readable: "実装あり",
  },
  {
    id: "floor_plan_text_only", label: "間取りが自由文・フォームにだけある（列に入っていない 例: 1DKも可）", present: (x) => { const t = floorPlanTextOnly(x); return t.length ? t.join("/") : null; },
    J: () => false /* judgeProperty は floor_plan 列だけ読む */, I: () => false, codeRe: /^FLOOR_PLAN_/, sheet: "間取り", readable: "実装あり",
  },
  {
    id: "floor_plan_unparsed", label: "間取りの列が読めない（「広め」「2部屋」等で型が無い）", present: (x) => { const v = x.c.floor_plan ?? x.c.layout; return v && normalizeFloorPlanWant(v).any && !/希望なし|特になし|なし|こだわらない|何でも/.test(v) ? String(v).slice(0, 20) : null; },
    S: () => true, R: (x) => /希望/.test(x.rank ?? ""), codeRe: /^FLOOR_PLAN_/, sheet: "間取り", readable: "実装あり",
  },
  {
    id: "area_sqm", label: "広さ（㎡以上）", present: (x) => num(x.c.floor_area_min) ? `floor_area_min=${x.c.floor_area_min}` : has(/[0-9０-９]{2}\s*(?:平米|㎡|m2|ｍ２)/, x.text) ?? (normalizeFloorPlanWant(x.c.floor_plan).sqmMin ? `floor_plan に ${normalizeFloorPlanWant(x.c.floor_plan).sqmMin}㎡以上` : null),
    S: () => true, J: () => false /* FloorPlanWant.sqmMin は読むが matchFloorPlan で使っていない・PropertyFacts に面積が無い */,
    R: (x) => /㎡以上/.test(x.rank ?? ""), I: (x) => iwAny(x, /平米|㎡|広/), codeRe: /^(AREA_SQM|SQM_)/, sheet: "専有面積（説明文「21.09㎡」・文字層）", readable: "文字層にある（未実装）",
  },
  {
    id: "area_wide_text", label: "広さの自由文（広め・ゆったり・◯帖以上）", present: (x) => has(/広め|広い|ゆったり|余裕|[0-9０-９]{1,2}(?:帖|畳)以上/, x.wantText),
    I: (x) => iwAny(x, /広|ゆったり|余裕|帖|畳/), wantRe: /広|ゆったり|余裕|帖|畳/, sheet: "専有面積・帖数（間取タイプの括弧）", readable: "一部の資料だけ",
  },
  {
    id: "building_age", label: "築年（列）", present: (x) => num(x.c.building_age) ? `building_age=${x.c.building_age}` : null,
    S: () => true, J: (x) => x.profile.buildingAgeMax != null, R: (x) => /築/.test(x.rank ?? ""), codeRe: /^BUILDING_AGE_/, sheet: "築年", readable: "実装あり",
  },
  {
    id: "new_build_text", label: "築浅・新築の自由文（築年の列が空）", present: (x) => (!num(x.c.building_age) ? has(NEWBUILD_RE, x.text) : null),
    codeRe: /^BUILDING_AGE_/, sheet: "築年（資料の表から読めるが、自由文の「築浅」を年数の希望にしていない）", readable: "文字層にある（未実装）",
  },
  {
    id: "move_in", label: "入居時期", present: (x) => (x.c.move_in_time && !/未定|特になし|なし|いつでも/.test(x.c.move_in_time) ? String(x.c.move_in_time).slice(0, 20) : has(MOVE_IN_TEXT_RE, x.text)),
    // 2026-09-25: move-in-want（希望日）× listing-terms（入れる一番早い日）→ MOVE_IN_OK/LATE/UNKNOWN（希望が目安・未定なら札なし）
    S: () => false, J: (x) => x.profile.moveInWant?.kind === "by" || x.profile.moveInWant?.kind === "asap", codeRe: /^MOVE_IN_/,
    sheet: "現況/入居時期（リアプロ「空室 / 即入」）・入居可能時期（itandi「2026年11月下旬」「相談」）", readable: "実装あり",
  },
  {
    id: "floor", label: "階（1階NG・2階以上・高層）", present: (x) => (eqAny(x, ["floor", "floor2", "top_floor"]) ? "階の希望" : has(/[0-9０-９一二三]階|高層|低層|最上階/, x.text)),
    E: (x) => eqAny(x, ["floor", "floor2", "top_floor"]), J: (x) => eqAny(x, ["floor", "floor2", "top_floor"]) || x.profile.imageWants.includes("floor_2_plus"),
    I: (x) => iwAny(x, /階|高層|低層/), codeRe: /^EQUIP_(FLOOR|FLOOR2|TOP_FLOOR)_|^IMAGE_FLOOR_2_PLUS/, equipKeys: ["floor", "floor2", "top_floor"], wantRe: /階|高層/,
    sheet: "所在階（itandi）・号室名（N階部分）・号室", readable: "実装あり",
  },
  {
    id: "direction", label: "向き・日当たり", present: (x) => has(DIRECTION_RE, x.text),
    E: (x) => eqAny(x, ["south"]), J: (x) => eqAny(x, ["south"]) || x.profile.imageWants.includes("south_facing"), I: (x) => iwAny(x, DIRECTION_RE),
    codeRe: /^EQUIP_SOUTH_|^IMAGE_SOUTH/, equipKeys: ["south"], wantRe: DIRECTION_RE, sheet: "主要採光面（itandi）・開口部方位（リアプロ）", readable: "実装あり",
  },
  {
    id: "structure", label: "構造（RC・木造NG・鉄骨）", present: (x) => x.c.structure_types ? `structure_types=${x.c.structure_types}` : has(STRUCT_RE, x.text),
    S: (x) => !!x.c.structure_types, E: (x) => eqAny(x, ["rc", "not_wood"]), J: (x) => eqAny(x, ["rc", "not_wood"]),
    codeRe: /^EQUIP_(RC|NOT_WOOD)_/, equipKeys: ["rc", "not_wood"], sheet: "構造・建築構造", readable: "実装あり",
  },
  {
    id: "pet", label: "ペット", present: (x) => (x.c.pet === true ? "pet=true" : has(/ペット|犬|猫|ねこ|いぬ/, x.text.replace(/ペット(?:飼育)?(?:は|が)?(?:なし|無し|無|いない|いません|飼っていない)/g, ""))),
    S: (x) => x.c.pet === true, E: (x) => eqAny(x, ["pet"]), J: (x) => x.profile.pet || eqAny(x, ["pet"]), R: (x) => /ペット/.test(x.rank ?? ""), I: (x) => iwAny(x, /ペット|犬|猫/),
    codeRe: /^PET_NG$|^EQUIP_PET_/, equipKeys: ["pet"], wantRe: /ペット|犬|猫/, sheet: "条件・設備（ペット相談・ペット可・ペット不可）", readable: "実装あり",
  },
  {
    id: "equipment", label: "設備（オートロック・宅配BOX・EV・バストイレ別 等）", present: (x) => {
      const ks = [...x.eqKeys].filter((k) => !["floor", "floor2", "top_floor", "south", "rc", "not_wood", "pet", "two_person", "no_guarantor", "parking", "bike_parking"].includes(k));
      return ks.length ? ks.join(",") : null;
    },
    E: () => true, J: () => true, I: (x) => x.iw.length > 0, codeRe: /^EQUIP_(?!FLOOR|FLOOR2|TOP_FLOOR|SOUTH|RC|NOT_WOOD|PET|TWO_PERSON|NO_GUARANTOR|PARKING|BIKE_PARKING)/, sheet: "設備・備考・条件", readable: "実装あり",
  },
  {
    id: "equipment_uncovered", label: "部屋の条件だが設備のキーに当たらない（照らせない条件）", present: (x) => (x.eq.uncovered.length ? x.eq.uncovered.map((u) => u.text.slice(0, 15)).join("/") : null),
    I: (x) => x.eq.uncovered.some((u) => x.iw.some((w) => w.text.includes(u.text.slice(0, 6)))), sheet: "設備・備考・間取り図", readable: "一部の資料だけ",
  },
  {
    id: "parking", label: "駐車場", present: (x) => (eqAny(x, ["parking"]) ? "駐車場" : null),
    E: (x) => eqAny(x, ["parking"]), J: (x) => eqAny(x, ["parking"]), codeRe: /^EQUIP_PARKING_/, equipKeys: ["parking"], sheet: "駐車場（空きなし・空きあり）", readable: "実装あり",
  },
  {
    id: "bike", label: "バイク・自転車置場", present: (x) => has(BIKE_RE, x.text),
    E: (x) => eqAny(x, ["bike_parking"]), J: (x) => eqAny(x, ["bike_parking"]), codeRe: /^EQUIP_BIKE_PARKING_/, equipKeys: ["bike_parking"], sheet: "設備（駐輪場・バイク置場）", readable: "実装あり",
  },
  {
    id: "two_person", label: "二人入居・同棲・ルームシェア・家族", present: (x) => has(TWO_RE, x.text),
    E: (x) => eqAny(x, ["two_person"]), J: (x) => eqAny(x, ["two_person"]) || !!x.profile.conditionWants?.some((k) => k === "twoPerson" || k === "roomShare" || k === "children"),
    codeRe: /^EQUIP_TWO_PERSON_|^CONDITION_(TWO_PERSON|ROOM_SHARE|CHILDREN)_/, equipKeys: ["two_person"],
    sheet: "設備・条件（二人入居可・単身限定）", readable: "実装あり",
  },
  {
    id: "instrument", label: "楽器・防音", present: (x) => has(INSTRUMENT_RE, x.text),
    J: (x) => !!x.profile.conditionWants?.includes("instrument"), codeRe: /^CONDITION_INSTRUMENT_/, sheet: "条件・備考（楽器不可・楽器相談）", readable: "実装あり",
  },
  {
    id: "guarantor", label: "保証人・審査・保証会社", present: (x) => has(SCREEN_RE, x.text) ?? (eqAny(x, ["no_guarantor"]) ? "保証人不要" : null),
    E: (x) => eqAny(x, ["no_guarantor"]), J: (x) => eqAny(x, ["no_guarantor"]), codeRe: /^EQUIP_NO_GUARANTOR_|GUARANT/, equipKeys: ["no_guarantor"],
    sheet: "保証会社（itandi「利用必須 , 全保連」）・条件（保証人不要）。審査の通りやすさは資料に無い", readable: "一部の資料だけ",
  },
  {
    id: "status", label: "学生・外国籍・法人・事務所利用・生活保護・高齢・性別", present: (x) => has(STATUS_RE, x.text),
    J: (x) => !!x.profile.conditionWants?.some((k) => ["corporate", "foreigner", "student", "office", "singleOnly"].includes(k)),
    codeRe: /^CONDITION_(CORPORATE|FOREIGNER|STUDENT|OFFICE|SINGLE)_/, sheet: "条件・設備（外国籍可・法人契約可・事務所使用不可・学生限定）", readable: "実装あり",
  },
  {
    id: "smoking", label: "喫煙", present: (x) => has(SMOKE_RE, x.text), codeRe: /SMOK/, sheet: "条件・備考（禁煙）", readable: "一部の資料だけ",
  },
  {
    id: "term", label: "定期借家NG・短期契約", present: (x) => has(TERM_RE, x.text), J: (x) => !!x.profile.mentions?.contract, codeRe: /^CONTRACT_/,
    sheet: "契約期間（普通借家／定期借家）・短期解約違約金（違約金は未実装）", readable: "実装あり",
  },
  {
    id: "renewal", label: "更新料", present: (x) => has(RENEW_RE, x.text), J: (x) => !!x.profile.mentions?.renewal, codeRe: /^RENEWAL_FEE_/, sheet: "更新料（札と根拠の表示だけ・点は0）", readable: "実装あり",
  },
  {
    id: "furniture", label: "家具家電付き", present: (x) => has(FURN_RE, x.text), I: (x) => iwAny(x, /家具|家電/), sheet: "設備（冷蔵庫・照明器具 等）", readable: "一部の資料だけ",
  },
  {
    id: "surroundings", label: "周辺環境（スーパー・治安・静か・学区）", present: (x) => has(SURROUND_RE, x.text), sheet: "資料に無い（地図・周辺情報）", readable: "資料に無い",
  },
];

// ───────────────────────── 集計 ─────────────────────────

export type KindCount = { id: string; label: string; present: number; S: number; J: number; E: number; R: number; I: number; leak: number; searchOnly: number; examples: string[]; sheet: string; readable: string };

export function covered(k: Kind, x: Ctx): Record<Where, boolean> {
  return { S: !!k.S?.(x), J: !!k.J?.(x), E: !!k.E?.(x), R: !!k.R?.(x), I: !!k.I?.(x) };
}

export function countKinds(rows: CustomerRow[]): KindCount[] {
  const out: KindCount[] = KINDS.map((k) => ({ id: k.id, label: k.label, present: 0, S: 0, J: 0, E: 0, R: 0, I: 0, leak: 0, searchOnly: 0, examples: [], sheet: k.sheet, readable: k.readable }));
  for (const c of rows) {
    const x = buildCtx(c);
    KINDS.forEach((k, i) => {
      const ev = k.present(x);
      if (!ev) return;
      const o = out[i];
      o.present++;
      const cv = covered(k, x);
      for (const w of ["S", "J", "E", "R", "I"] as Where[]) if (cv[w]) o[w]++;
      if (!cv.J && !cv.E && !cv.R && !cv.I) {
        o.leak++;
        if (cv.S) o.searchOnly++;
        if (o.examples.length < 5) o.examples.push(safe(ev).slice(0, 30));
      }
    });
  }
  return out;
}

/** 設備の照合が「別の所で見る」とした節（handledElsewhere）のうち、実際はどこでも照らしていない種類 */
export function elsewhereButNowhere(rows: CustomerRow[]): Array<{ kind: string; clauses: number; people: number; examples: string[] }> {
  const agg = new Map<string, { clauses: number; people: Set<string>; examples: string[] }>();
  rows.forEach((c, idx) => {
    const x = buildCtx(c);
    for (const h of x.eq.handledElsewhere) {
      // 種類は節の文だけで決める（列の値で決めると「綺麗ならば大丈夫」が入居時期の列に引かれる）
      const one: Ctx = { ...x, c: { id: c.id } as CustomerRow, text: h.text, wantText: h.text, form: "", eqKeys: new Set<string>() };
      const hitKind = KINDS.find((k) => !["rent_max", "rent_min", "floor_plan", "building_age", "walk", "area", "rent_max_unreliable", "equipment", "equipment_uncovered", "floor_plan_unparsed"].includes(k.id) && k.present(one));
      const kid = hitKind?.id ?? "(その他)";
      const isCovered = hitKind ? (() => { const cv = covered(hitKind, x); return cv.J || cv.E || cv.R || cv.I; })() : false;
      if (isCovered) continue;
      const a = agg.get(kid) ?? { clauses: 0, people: new Set<string>(), examples: [] };
      a.clauses++;
      a.people.add(String(c.id ?? idx));
      if (a.examples.length < 4) a.examples.push(safe(h.text).slice(0, 25));
      agg.set(kid, a);
    }
  });
  return [...agg.entries()].map(([kind, a]) => ({ kind, clauses: a.clauses, people: a.people.size, examples: a.examples })).sort((a, b) => b.people - a.people);
}

// ───────────────────────── 実行 ─────────────────────────

const COLS = "id, customer_name, status, rent_max, max_rent, rent_min, floor_plan, layout, walk_minutes, building_age, initial_cost_limit, preferences, ng_points, other_requests, additional_conditions, pet, desired_area, move_in_time, floor_area_min, floor_area_max, commute_station, commute_minutes, structure_types, raw_format_text, area_mode";
/** テスト用の顧客（YUMA・テスト）は数えない */
export const TEST_NAME_RE = /YUMA|ＹＵＭＡ|テスト|TEST|test/;

async function main() {
  const url = process.env.NEXT_PUBLIC_SUPABASE_URL ?? "";
  const key = process.env.SUPABASE_SERVICE_ROLE_KEY ?? process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY ?? "";
  const sb = createClient(url, key);
  const all: CustomerRow[] = [];
  for (let from = 0; ; from += 1000) {
    const { data, error } = await sb.from("property_customers").select(COLS).range(from, from + 999);
    if (error) { console.error(error.message); process.exit(1); }
    all.push(...((data ?? []) as CustomerRow[]));
    if (!data || data.length < 1000) break;
  }
  const rows = all.filter((r) => !TEST_NAME_RE.test(String(r.customer_name ?? "")));
  console.log(`=== 条件の種類ごとの照らし方（property_customers ${rows.length}人・テスト ${all.length - rows.length}人を除く） ===`);
  console.log("S=検索（ポータル） J=判定の札 E=設備の照合 R=🌟に渡る条件 I=画像で分析の希望 ／ 漏れ=J・E・R・I のどれにも届かない（うち検索だけ=S は通った）\n");
  const counts = countKinds(rows);
  console.log(["種類", "人数", "S", "J", "E", "R", "I", "漏れ", "(検索だけ)", "物件側で"].join("\t"));
  for (const k of counts) {
    console.log([k.label, k.present, k.S, k.J, k.E, k.R, k.I, k.leak, k.searchOnly, k.readable].join("\t"));
  }

  console.log("\n■ 漏れの大きい順（漏れ人数 > 0）");
  for (const k of [...counts].filter((k) => k.leak > 0).sort((a, b) => b.leak - a.leak)) {
    console.log(`  ${String(k.leak).padStart(3)}人 ${k.label}（条件がある ${k.present}人・検索では絞った ${k.searchOnly}人）— 物件側: ${k.sheet}【${k.readable}】`);
    if (process.argv.includes("--examples")) for (const e of k.examples) console.log(`        例: ${e}`);
  }

  console.log("\n■ 設備の照合が「別の所（property-brain）で見る」と振り分けた節のうち、実際はどこでも照らしていない物");
  for (const e of elsewhereButNowhere(rows)) {
    console.log(`  ${e.kind}: ${e.people}人・${e.clauses}節` + (process.argv.includes("--examples") ? `  例: ${e.examples.join(" ／ ")}` : ""));
  }

  // エリアが上書きで消えた人（property_condition_history の desired_area の変更で、前の地名が新しい値に残っていない）
  const { data: hist, error: hErr } = await sb.from("property_condition_history").select("property_customer_id, changed_field, old_value, new_value, changed_at:created_at").eq("changed_field", "desired_area").limit(5000);
  if (hErr) console.log(`\n■ エリアの履歴: 読めない（${hErr.message}）`);
  else {
    const ids = new Set(rows.map((r) => r.id));
    const lost = new Map<string, number>();
    let changes = 0;
    for (const h of (hist ?? []) as Array<{ property_customer_id: string; old_value: string | null; new_value: string | null }>) {
      if (!ids.has(h.property_customer_id)) continue;
      changes++;
      const olds = String(h.old_value ?? "").split(/[・、,，/／\s]+/).map((s) => s.replace(/駅$/, "").trim()).filter((s) => s.length >= 2);
      const nv = String(h.new_value ?? "");
      const dropped = olds.filter((o) => !nv.includes(o));
      if (olds.length && dropped.length) lost.set(h.property_customer_id, (lost.get(h.property_customer_id) ?? 0) + 1);
    }
    console.log(`\n■ エリアの変更（property_condition_history・desired_area）: ${changes}回 ／ 前の地名が新しい値から消えた変更がある人 ${lost.size}人（${[...lost.values()].reduce((a, b) => a + b, 0)}回）`);
    console.log("   ※ お客様が「◯◯はやめて」と言った除外（EXCLUDE）と、正式フォーム・REPLACE の上書きを履歴では分けられない（上限の数）");
  }

  // 入居時期の中身（急ぎ・時期の指定・目安）
  const mv = { urgent: 0, specific: 0, vague: 0 };
  for (const r of rows) {
    const v = String(r.move_in_time ?? "").normalize("NFKC");
    if (!v || /未定|特になし|^なし$|いつでも/.test(v)) continue;
    if (/即|すぐ|最短|今月|今週|早め|早く|急ぎ|なるべく早/.test(v)) mv.urgent++;
    else if (/\d{1,2}\s*[月/]|\d{1,2}日|来月|再来月|年内|年明け|春|夏|秋|冬/.test(v)) mv.specific++;
    else mv.vague++;
  }
  console.log(`\n■ 入居時期の列の中身: 急ぎ（即入居・すぐ・最短）${mv.urgent}人 ／ 時期の指定（◯月・◯日・来月）${mv.specific}人 ／ 目安（◯ヶ月後くらい 等）${mv.vague}人`);

  // 条件フォームの原文にあるのに列に入っていない間取り
  const fpForm = rows.filter((r) => { const x = buildCtx(r); return floorPlanTextOnly({ ...x, wantText: "" }).length > 0; }).length;
  console.log(`\n■ 間取り: 条件フォームの原文にだけある型（列 floor_plan の希望に入っていない）がある人 ${fpForm}人（自由文を含めると上の「間取りが自由文・フォームにだけある」）`);

  if (process.argv.includes("--json")) console.log(JSON.stringify(counts.map(({ examples: _e, ...k }) => k)));
}

if (/audit-condition-coverage\.ts$/.test(process.argv[1] ?? "")) main().catch((e) => { console.error(e); process.exit(1); });
