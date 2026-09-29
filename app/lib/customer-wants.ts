// app/lib/customer-wants.ts（純関数・DB なし）
// お客様の細かい要望を「項目」（種類＝設備／NG／その他・名前・出所の文）として1つ1つ持つ。
//
// 2026-09-29 竹内「拡張の検索条件には入らないけど加点条件として、その他の項目で1つ1つまとめる（ガスコンロ・カウンターキッチン・
//   リビング○帖以上・初期費用○円以内 等）。お客さんから条件が送られた時に要望としてその他に入れておく。AIXツールのお客さんの条件に
//   反映する部分で抜けが無いか見て、1つ1つ分かりやすく。設備系は設備のところにまとめる。抜けがないように調査して行う」
//
// 決まり（設計知見「同じ希望を2か所で読む時は片方の読み取りを正にする」）:
//   - 項目は property_customers の文の欄（preferences＝こだわり／設備・ng_points＝NG・other_requests＝その他・additional_conditions の「希望:」）
//     から**決定論で毎回作る**（JSON の写しを別の列に持たない＝スタッフが欄を直せば項目も変わる・ずれない）。
//   - 設備の項目は listing-equipment.parseEquipmentWants を正にする（採点の EQUIP_* と同じ読み取り）。
//     その他の項目（洋室・リビングの帖数・初期費用・築浅・駅近・家賃安め・広さ・入居の条件）は property-brain／room-jo の同じ関数で読む。
//   - どの決まりにも当たらない節は「その他（自由）」として残す（消さない・採点には効いていない事が分かるように scoring=null）。
//   - 書く側（P4・正式フォーマット）は routeConditionText で節ごとに 設備→preferences／NG→ng_points／それ以外→other_requests に振り分ける。
import {
  parseEquipmentWants, wantLabel, type WantField, type CustomerConditionsLike,
} from "./listing-equipment";
import { topicsOf, wantFeatures } from "./image-wants";
import { roomJoWantOf } from "./room-jo";
import {
  detectWantsLowInitialCost, detectAgeText, detectConditionWants, sqmFromText, WALK_TEXT_RE, isRentCheapClause, type CustomerLike,
} from "./property-brain";
import { CONDITION_LABELS } from "./listing-terms";

export type WantKind = "設備" | "NG" | "その他";
export type WantItem = {
  kind: WantKind;
  /** 安定した鍵（equip:<EquipKey>・other:<名前>・free:<文>） */
  key: string;
  /** 画面の名前（「カウンターキッチン」「リビング8帖以上」「初期費用15万円以内」） */
  label: string;
  strong: boolean;
  soft: boolean;
  /** 出所の文（お客様の欄の節そのまま・列なら「列: …」） */
  source: string;
  field: WantField | "column";
  /** 採点の札の家族（EQUIP_COUNTER_KITCHEN・ROOM_JO・LDK_JO・INITIAL_COST・ZERO_ZERO…）。null＝採点には効いていない */
  scoring: string | null;
  /** 画像で確かめる対象になるか（image-wants の話題に当たる） */
  image: boolean;
  /** 拡張の検索の入力に効くか（ペット・バス・トイレ別(ITANDI)・構造・㎡・敷礼0） */
  search: boolean;
  /** 条件ではないメモ・お客様の事情（採点・検索に効かせる物ではない） */
  note?: boolean;
  /** 家賃・間取り・エリア等の「列」で採点する条件の自由文（列に入っていれば効く） */
  elsewhere?: boolean;
};

export type WantsCustomerLike = CustomerConditionsLike & CustomerLike & { structure_types?: string | null; building_age?: number | null; walk_minutes?: number | null };

const NG_WORD_RE = /NG|ｎｇ|不可|嫌|いや|避け|ダメ|だめ|無理|×|以外/i;
const SHIKIREI_SEARCH_RE = /敷礼なし|敷金礼金なし|敷金礼金0|敷金0礼金0|敷0礼0/;
// 「位内」は「以内」の打ち間違い（実物: 「初期費用30万位内で他に収納が多くて…」「初期費用10万位内は厳しいでしょうか」）
const INITIAL_COST_YEN_RE = /初期費用\s*(?:は|を)?\s*(\d{1,3}(?:\.\d)?)\s*万(?:円)?\s*(?:以内|以下|まで|くらい|位内|程度|前後)/;
/** この物件の値引きの相談（上限ではない）。実物: 「ここ初期費用7万まで行けませんか?」 */
const COST_NEGOTIATION_RE = /ここ|こちら|この(?:物件|部屋|お部屋)|行けません|いけません|なりません|できません|出来ません|できないでしょうか|出来ないでしょうか|交渉|値下げ|下がりません/;

/**
 * お客様の発言の「初期費用10万以下で探して欲しい」「初期費用は10万円前後を希望」→ 円（決定論・1〜100万円）。
 * 2026-09-29 監査: 発言で初期費用の上限を言ったお客様 9人の列（initial_cost_limit）が空だった（P4 の読み取りが落とした）
 *   → P4 で LLM が初期費用上限を返さなかった時だけこれで埋める（列が入れば INITIAL_COST_* の採点・項目の「採点外」が消える）。
 *   この物件の値引きの相談の文（COST_NEGOTIATION_RE）は上限ではないので読まない。1通に複数ある時は最後の値（言い直し）
 */
export function initialCostLimitFromText(text: string | null | undefined): number | null {
  let out: number | null = null;
  for (const s of String(text ?? "").normalize("NFKC").split(/[\n。!?]/)) {
    const m = s.match(INITIAL_COST_YEN_RE);
    if (!m || COST_NEGOTIATION_RE.test(s)) continue;
    const man = Number(m[1]);
    if (man >= 1 && man <= 100) out = Math.round(man * 10000);
  }
  return out;
}
const LDK_LABEL = (jo: number, approx: boolean) => `リビング${jo}帖${approx ? "程度" : "以上"}`;

const norm = (s: string) => String(s ?? "").normalize("NFKC").replace(/[\s　・、。,，!！?？]/g, "").toLowerCase();

/** additional_conditions の記録（「[9/11 12:02|format] …」）から「希望:」「こだわり:」の部分だけ（listing-equipment の additionalToText と同じ線） */
export function additionalHopes(s: string | null | undefined): string {
  const out: string[] = [];
  for (const seg of String(s ?? "").normalize("NFKC").split(/\s\/\s|\n/)) {
    const t = seg.replace(/【[^】]*】/g, "").replace(/\[(?!必須)[^\]]*\]/g, "").trim();
    if (!t || /^(?:#|-|\*)|読み取り|画面の種類|物件を検索して/.test(t)) continue;
    for (const m of t.matchAll(/(?:希望|こだわり)[:：]\s*([^/]+?)(?=\s(?:エリア|間取り|家賃|徒歩|入居|その他|通勤|築年)[:：]|$)/g)) out.push(m[1]);
  }
  return out.join("、");
}

/** 「バス・トイレ別」の「・」は割らない（image-wants.splitClauses と同じ） */
const KEEP_DOT_RE = /(バス|風呂|お風呂|浴室|トイレ)[・･](トイレ|バス|風呂|お風呂|浴室)|(洗面)[・･](脱衣)|(キッチン)[・･](ダイニング)/g;
const DOT = "\u0000";
export function splitWantText(s: string | null | undefined): string[] {
  const kept = String(s ?? "").normalize("NFKC").replace(KEEP_DOT_RE, (m) => m.replace(/[・･]/, DOT));
  return kept.split(/[\n。、,，/／]|・(?=[^・]{1,})/)
    .map((x) => x.split(DOT).join("・").replace(/^\s*(?:[①-⑳]|[0-9]{1,2}[.)）、]|[-・*]+)\s*/, "").trim())
    .filter((x) => x.length >= 1);
}

function strengthOf(text: string): { strong: boolean; soft: boolean } {
  return { strong: /必須|絶対|マスト|\[必須\]/.test(text), soft: /できれば|出来れば|あれば|あったら|嬉しい|うれしい|理想|なるべく|できたら|出来たら/.test(text) };
}

const yenLabel = (yen: number) => (yen % 10000 === 0 ? `${yen / 10000}万円` : `${(yen / 10000).toFixed(1)}万円`);

/**
 * お客様の要望を項目にする（決定論）。並びは 設備 → NG → その他（出てきた順）。同じ鍵は最初の1つ。
 */
export function itemizeWants(c: WantsCustomerLike | null | undefined): WantItem[] {
  if (!c) return [];
  const out: WantItem[] = [];
  const seen = new Set<string>();
  const push = (w: WantItem) => { if (seen.has(w.key)) return; seen.add(w.key); out.push(w); };
  const covered: string[] = [];
  const cover = (s: string) => { const n = norm(s); if (n) covered.push(n); };
  const isCovered = (clause: string) => { const n = norm(clause); return !!n && covered.some((x) => x === n || x.includes(n) || n.includes(x)); };

  // ⓪ 行ごとの除外エリア（「梅香、大開、…、野田1丁目以外の地域」）。地名の並びを1つずつの項目にせず、行を1つの NG（エリア）にする
  for (const line of [c.preferences, c.other_requests].map((s) => String(s ?? "").normalize("NFKC")).join("\n").split("\n")) {
    const t = line.trim();
    if (!/(?:以外|除く|NG|不可)(?:の)?(?:地域|エリア|場所)?\s*$/.test(t) || !/[、,，]/.test(t)) continue;
    push({ kind: "NG", key: `area_ng:${norm(t)}`, label: t.length > 30 ? `${t.slice(0, 29)}…` : t, strong: false, soft: false, source: t, field: "preferences", scoring: "AREA_EXCLUDED（列 exclusion_areas）", image: false, search: false, elsewhere: true });
    for (const cl of splitWantText(t)) cover(cl);
  }

  // ① 設備（listing-equipment の読み取りを正にする）
  const eq = parseEquipmentWants(c);
  for (const w of eq.wants) {
    const ngKind = w.mode === "ng" || w.field === "ng_points" || (NG_WORD_RE.test(w.text) && (w.key === "floor2" || w.key === "floor" || w.key === "structure" || w.key === "bath_toilet"));
    const KEY = String(w.key).toUpperCase() + (w.mode === "ng" ? "_NOT" : "");
    push({
      kind: ngKind ? "NG" : "設備",
      key: `equip:${w.key}${w.mode === "ng" ? ":ng" : ""}`,
      label: ngKind && w.mode === "must" && !/NG$/.test(wantLabel(w)) ? `${w.text.slice(0, 16)} → ${wantLabel(w)}` : wantLabel(w),
      strong: w.strong, soft: w.soft, source: w.text, field: w.field,
      scoring: w.key === "pet" ? "EQUIP_PET／PET_NG" : `EQUIP_${KEY}`,
      image: wantFeatures(w.text).length > 0 || topicsOf(w.text).length > 0,
      search: w.key === "pet" || w.key === "bath_toilet" || w.key === "structure",
    });
    cover(w.text);
  }

  // ② その他（決定論の項目）
  const texts = [c.preferences, c.other_requests, additionalHopes(c.additional_conditions)];
  const free = texts.map((s) => String(s ?? "")).join("\n");
  const clauses = splitWantText(free);
  // 洋室の帖数（room-jo）
  const jo = roomJoWantOf([...texts, c.floor_plan, c.layout], "洋");
  if (jo) { push({ kind: "その他", key: "other:room_jo", label: `洋室${jo.jo}帖${jo.approx ? "程度" : "以上"}`, ...strengthOf(jo.text), soft: jo.soft, source: jo.text, field: "preferences", scoring: "ROOM_JO", image: true, search: false }); cover(jo.text); }
  // リビングの帖数（LDK_JO・2026-09-29 に札を足した）
  const ldk = roomJoWantOf([...texts, c.floor_plan, c.layout], "LDK");
  if (ldk) { push({ kind: "その他", key: "other:ldk_jo", label: LDK_LABEL(ldk.jo, ldk.approx), ...strengthOf(ldk.text), soft: ldk.soft, source: ldk.text, field: "preferences", scoring: "LDK_JO", image: true, search: false }); cover(ldk.text); }
  // 初期費用（列 → 文の「初期費用15万円以内」→ 抑えたい）
  const lim = typeof c.initial_cost_limit === "number" && c.initial_cost_limit > 0 ? c.initial_cost_limit : null;
  if (lim != null) push({ kind: "その他", key: "other:initial_cost_limit", label: `初期費用${yenLabel(lim)}以内`, strong: false, soft: false, source: `列: 初期費用上限 ${lim.toLocaleString()}円`, field: "column", scoring: "INITIAL_COST", image: false, search: false });
  for (const cl of clauses) {
    const m = cl.match(INITIAL_COST_YEN_RE);
    if (!m) continue;
    // 列に入っていない時は採点に効かない（INITIAL_COST_* は列 initial_cost_limit を読む）→ scoring null で「抜け」が見える
    push({ kind: "その他", key: "other:initial_cost_text", label: `初期費用${m[1]}万円以内`, ...strengthOf(cl), source: cl, field: "other_requests", scoring: lim != null ? "INITIAL_COST" : null, image: false, search: false });
    cover(cl);
  }
  if (detectWantsLowInitialCost({ ...c, initial_cost_limit: null })) {
    const cl = clauses.find((x) => /敷|礼|初期費用|ゼロゼロ|フリーレント/.test(x)) ?? "初期費用を抑えたい";
    push({ kind: "その他", key: "other:low_initial_cost", label: /敷|礼|ゼロゼロ/.test(cl) ? "敷礼0（初期費用を抑えたい）" : "初期費用を抑えたい", ...strengthOf(cl), source: cl, field: "other_requests", scoring: "ZERO_ZERO", image: false, search: SHIKIREI_SEARCH_RE.test(`${c.preferences ?? ""} ${c.ng_points ?? ""} ${c.other_requests ?? ""}`) });
    cover(cl);
  }
  // 築浅・新築・築N年以内（列が空の時だけ採点に効く）
  const age = detectAgeText(c);
  if (age) {
    const cl = clauses.find((x) => x.includes(age.word)) ?? age.word;
    const col = typeof c.building_age === "number" && c.building_age > 0;
    push({ kind: "その他", key: "other:age_text", label: age.word === "新築" || age.word === "築浅" ? age.word : `築${age.years}年以内`, ...strengthOf(cl), source: cl, field: "other_requests", scoring: col ? "BUILDING_AGE（列）" : "BUILDING_AGE_TEXT", image: false, search: col });
    cover(cl);
  }
  // 駅近・徒歩N分以内（文）
  const walkCl = clauses.find((x) => WALK_TEXT_RE.test(x));
  if (walkCl) {
    const n = walkCl.match(/徒歩\s*(\d{1,2})\s*分/);
    const col = typeof c.walk_minutes === "number" && c.walk_minutes > 0;
    push({ kind: "その他", key: "other:walk_text", label: n ? `駅徒歩${n[1]}分以内` : "駅近", ...strengthOf(walkCl), source: walkCl, field: "other_requests", scoring: col ? "WALK（列）" : "WALK_TEXT", image: false, search: col });
    cover(walkCl);
  }
  // 家賃は安め
  const cheapCl = clauses.find((x) => isRentCheapClause(x));
  if (cheapCl) { push({ kind: "その他", key: "other:rent_cheap", label: "家賃は安め", ...strengthOf(cheapCl), source: cheapCl, field: "other_requests", scoring: "RENT_CHEAP", image: false, search: false }); cover(cheapCl); }
  // 広さ（列が空で文に「25平米以上」）
  if (!(typeof c.floor_area_min === "number" && c.floor_area_min > 0)) {
    const sqm = sqmFromText(c);
    if (sqm != null) {
      const cl = clauses.find((x) => /平米|㎡|m2/i.test(x)) ?? `${sqm}㎡以上`;
      push({ kind: "その他", key: "other:sqm_text", label: `${sqm}㎡以上`, ...strengthOf(cl), source: cl, field: "preferences", scoring: "SQM", image: false, search: true });
      cover(cl);
    }
  }
  // 入居の条件（楽器・法人・二人入居…）。二人入居は設備の two_person と二重にしない
  for (const k of detectConditionWants(c)) {
    if (k === "twoPerson" && seen.has("equip:two_person")) continue;
    const label = CONDITION_LABELS[k];
    const cl = clauses.find((x) => x.includes(label) || new RegExp(label.slice(0, 2)).test(x)) ?? label;
    push({ kind: "その他", key: `other:cond_${k}`, label: `${label}（入居の条件）`, ...strengthOf(cl), source: cl, field: "other_requests", scoring: `CONDITION_${k.replace(/([A-Z])/g, "_$1").toUpperCase()}`, image: false, search: false });
    cover(cl);
  }

  // ③ 決まりに当たらなかった節（消さない・採点に効いていない事が分かるように）
  const freeItem = (t: { text: string; field: WantField }, kind: WantKind, extra: Partial<WantItem>) => {
    if (isCovered(t.text)) return;
    const topics = topicsOf(t.text);
    // 収納・クローゼットは設備欄には無いが、画像で分析（IMAGE_STORAGE_*）が判定に足す＝採点には効く
    const imageScoring = /収納|クローゼット|クロゼット|ウォークイン|押入|納戸/.test(t.text) ? "IMAGE_STORAGE（画像で分析）" : null;
    push({ kind, key: `free:${norm(t.text)}`, label: t.text.length > 24 ? `${t.text.slice(0, 23)}…` : t.text, ...strengthOf(t.text), source: t.text, field: t.field, scoring: imageScoring, image: topics.length > 0, search: false, ...extra });
  };
  for (const t of eq.uncovered) freeItem(t, t.field === "ng_points" ? "NG" : "その他", {});
  for (const t of eq.handledElsewhere) freeItem(t, t.field === "ng_points" ? "NG" : "その他", { elsewhere: true, scoring: elsewhereFamily(t.text) });
  for (const t of eq.other) freeItem(t, t.field === "ng_points" ? "NG" : "その他", { note: true });

  const order: Record<WantKind, number> = { "設備": 0, "NG": 1, "その他": 2 };
  return out.map((w, i) => ({ w, i })).sort((a, z) => order[a.w.kind] - order[z.w.kind] || a.i - z.i).map((x) => x.w);
}

/** 家賃・間取り・エリア等の「列」で採点する自由文の家族（列に値が入っていれば採点は効く） */
function elsewhereFamily(text: string): string | null {
  const s = text.normalize("NFKC");
  if (/初期費用|敷金|礼金|敷礼|フリーレント/.test(s)) return "INITIAL_COST（列）";
  if (/家賃|賃料|管理費|共益費|万円?/.test(s)) return "RENT（列）";
  if (/築/.test(s)) return "BUILDING_AGE（列）";
  if (/徒歩|駅近/.test(s)) return "WALK（列）";
  if (/駅|沿線|エリア|丁目|以外の地域|通勤|電車/.test(s)) return "AREA（列）";
  if (/間取り|[1-5]\s*(?:S?LDK|DK|K|R)(?![a-z])|ワンルーム/i.test(s)) return "FLOOR_PLAN（列）";
  if (/平米|㎡|m2/i.test(s)) return "SQM（列）";
  if (/入居/.test(s)) return "MOVE_IN（列）";
  if (/審査|保証会社|ブラック|滞納|破産|任意整理/.test(s)) return null;
  return null;
}

// ───────────────────────── 書く側の振り分け ─────────────────────────

export type RoutedConditionText = { preferences: string | null; ng_points: string | null; other_requests: string | null };

/** 1つの節の種類（設備→preferences／NG→ng_points／それ以外→other_requests）。ng_points の節は動かさない */
export function kindOfClause(clause: string, field: "preferences" | "ng_points" | "other_requests"): WantKind {
  const s = clause.normalize("NFKC").trim();
  if (!s) return "その他";
  if (field === "ng_points") return "NG";
  const w = parseEquipmentWants({ [field]: s } as CustomerConditionsLike).wants;
  // 「1階NG」「木造NG」「ロフトNG」「ユニットバス不可」＝NG の欄。「木造以外」「アパート以外」も NG の言い方
  // 「木造でもいい」「鶴見区以外も検討可能」「ユニットバスでもOK」は受け入れの話（NG ではない）
  if (w.some((x) => x.mode === "ng") || (NG_WORD_RE.test(s) && !/(?:でも|も)\s*(?:OK|可能|可|大丈夫|いい|良い|よい|検討|構わない|かまわない|アリ|あり)/i.test(s))) return "NG";
  if (w.length) return "設備";
  return "その他";
}

/**
 * 読み取った条件の文（LLM の出力）を、節ごとに 設備／NG／その他 の欄へ振り分ける。
 *   - 節の区切りは 「・」「、」「,」「。」「/」「改行」（「バス・トイレ別」は割らない）
 *   - 同じ節は1つ（重複を除く）・並びは元のまま。空の欄は null
 *   - ng_points の節はそのまま NG（「角部屋希望」が NG 欄に来た時も動かさない＝人が直す）
 */
export function routeConditionText(parsed: Partial<Record<"preferences" | "ng_points" | "other_requests", string | null | undefined>>): RoutedConditionText {
  const buckets: Record<WantKind, string[]> = { "設備": [], "NG": [], "その他": [] };
  const seen = new Set<string>();
  for (const field of ["preferences", "ng_points", "other_requests"] as const) {
    for (const cl of splitWantText(parsed[field])) {
      if (/^(?:特になし|なし|無し|ー|-|null)$/i.test(cl)) continue;
      const k = norm(cl);
      if (!k || seen.has(k)) continue;
      seen.add(k);
      buckets[kindOfClause(cl, field)].push(cl);
    }
  }
  const join = (a: string[]) => (a.length ? a.join("・") : null);
  return { preferences: join(buckets["設備"]), ng_points: join(buckets["NG"]), other_requests: join(buckets["その他"]) };
}

/** 振り分けで欄の中身が変わるか（既存の自由文の移行の案・監査で使う） */
export function routeChanges(existing: Partial<Record<"preferences" | "ng_points" | "other_requests", string | null | undefined>>): Array<{ from: string; to: string; clause: string }> {
  const out: Array<{ from: string; to: string; clause: string }> = [];
  const toField: Record<WantKind, string> = { "設備": "preferences", "NG": "ng_points", "その他": "other_requests" };
  for (const field of ["preferences", "ng_points", "other_requests"] as const) {
    for (const cl of splitWantText(existing[field])) {
      if (/^(?:特になし|なし|無し|ー|-)$/.test(cl)) continue;
      const to = toField[kindOfClause(cl, field)];
      if (to !== field) out.push({ from: field, to, clause: cl });
    }
  }
  return out;
}

/**
 * 正式フォーマットの「【その他ご要望あれば】⇒…」「⑧【その他こだわりご要望】⇒…」の行の値（決定論）。
 * 2026-09-29 監査: 「8【その他ご要望あれば】⇒ 1階の物件希望、保証人不要、バストイレ別、…」が条件の欄に1つも入っていない人がいた
 *   （LLM の読み取りが落とした）→ 読み取りの後ろで、この行を other_requests に足してから振り分ける（重複は routeConditionText が除く）
 */
export function formOtherWants(text: string | null | undefined): string | null {
  const out: string[] = [];
  for (const line of String(text ?? "").normalize("NFKC").split("\n")) {
    const b = line.indexOf("】");
    const head = b >= 0 ? line.slice(0, b + 1) : (line.match(/^(.*?)[⇒→=:]/)?.[1] ?? "");
    if (!/その他(?:ご要望|こだわり|の?要望)/.test(head)) continue;
    const v = (b >= 0 ? line.slice(b + 1) : line.replace(/^(.*?)[⇒→=:]/, "")).replace(/^[\s⇒→=:]+/, "").trim();
    if (v && !/^(?:特になし|なし|無し|ー|-)$/.test(v)) out.push(v);
  }
  return out.length ? out.join("・") : null;
}

// ───────────────────────── 監査で拾う要望の語 ─────────────────────────

/** 監査（scripts/audit-wants-itemized.ts）で数える要望の語。key は項目の鍵の前方（equip:… / other:…）。search＝拡張の検索の入力に効く */
export const AUDIT_WANT_WORDS: ReadonlyArray<{ word: string; re: RegExp; key: string; kind: WantKind; search: boolean }> = [
  { word: "ガスコンロ", re: /ガスコンロ/, key: "equip:gas_stove", kind: "設備", search: false },
  { word: "IH", re: /(?<![A-Za-z])IH/i, key: "equip:ih", kind: "設備", search: false },
  { word: "コンロ2口以上", re: /(?:[2-9２-９]|二|三)口/, key: "equip:burner2", kind: "設備", search: false },
  { word: "カウンター/対面キッチン", re: /カウンターキッチン|対面(?:式)?(?:キッチン)?/, key: "equip:counter_kitchen", kind: "設備", search: false },
  { word: "システムキッチン", re: /システムキッチン/, key: "equip:system_kitchen", kind: "設備", search: false },
  { word: "独立洗面", re: /独立洗面|洗面(?:所|台)?(?:が|は)?(?:独立|別)/, key: "equip:washbasin", kind: "設備", search: false },
  { word: "バス・トイレ別", re: /バス.?トイレ|風呂.?トイレ|トイレ.?別|セパレート/, key: "equip:bath_toilet", kind: "設備", search: true },
  { word: "追い焚き", re: /追い?[焚炊]/, key: "equip:reheating", kind: "設備", search: false },
  { word: "浴室乾燥", re: /浴室(?:換気)?乾燥|浴室暖房/, key: "equip:bath_dryer", kind: "設備", search: false },
  { word: "温水洗浄便座", re: /温水洗浄|ウォシュレット|シャワートイレ/, key: "equip:washlet", kind: "設備", search: false },
  { word: "宅配BOX", re: /宅配/, key: "equip:delivery_box", kind: "設備", search: false },
  { word: "オートロック", re: /オートロック/, key: "equip:autolock", kind: "設備", search: false },
  { word: "ネット無料", re: /ネット(?:使用料)?(?:無料|込|不要)|Wi-?Fi|無料(?:インター)?ネット/i, key: "equip:net_free", kind: "設備", search: false },
  { word: "エレベーター", re: /エレベータ|(?<![A-Za-z])EV(?![A-Za-z])/i, key: "equip:elevator", kind: "設備", search: false },
  { word: "エアコン", re: /エアコン/, key: "equip:aircon", kind: "設備", search: false },
  { word: "室内洗濯機置場", re: /室内洗濯|洗濯機/, key: "equip:laundry_in", kind: "設備", search: false },
  { word: "WIC", re: /(?<!シューズ)(?:ウォークイン|WIC|W\.I\.C)/i, key: "equip:walk_in_closet", kind: "設備", search: false },
  { word: "ロフト", re: /ロフト/, key: "equip:loft", kind: "設備", search: false },
  { word: "バルコニー", re: /バルコニー|ベランダ/, key: "equip:balcony", kind: "設備", search: false },
  { word: "駐車場", re: /駐車/, key: "equip:parking", kind: "設備", search: false },
  { word: "駐輪場", re: /駐輪|自転車置|バイク置/, key: "equip:bike_parking", kind: "設備", search: false },
  { word: "ペット", re: /ペット|小型犬|猫/, key: "equip:pet", kind: "設備", search: true },
  { word: "楽器", re: /楽器|ピアノ|ギター/, key: "other:cond_instrument", kind: "その他", search: false },
  { word: "2階以上/1階NG", re: /[2２二]階以上|[1１一]階(?:は|が)?(?:NG|不可|嫌|以外|×)/, key: "equip:floor2", kind: "NG", search: false },
  { word: "角部屋", re: /角部屋|角住戸/, key: "equip:corner", kind: "設備", search: false },
  { word: "南向き", re: /南向き|南側/, key: "equip:south", kind: "設備", search: false },
  { word: "最上階", re: /最上階/, key: "equip:top_floor", kind: "設備", search: false },
  { word: "木造NG/構造", re: /木造|鉄筋|鉄骨|(?<![A-Za-z])S?RC(?![A-Za-z])/, key: "equip:structure", kind: "NG", search: true },
  { word: "二人入居", re: /二人入居|2人入居|同棲(?!相手)|二人暮らし|2人暮らし/, key: "equip:two_person", kind: "設備", search: false },
  { word: "保証人不要", re: /保証人(?:不要|なし|無し|無)/, key: "equip:no_guarantor", kind: "設備", search: false },
  { word: "リビング○帖以上", re: /(?:リビング|LDK|LD|DK)\s*(?:は|が)?\s*\d{1,2}(?:\.\d)?\s*(?:帖|畳)/i, key: "other:ldk_jo", kind: "その他", search: false },
  { word: "洋室○帖以上", re: /(?<!(?:リビング|LDK|LD|DK)\s*)(?<![\d.])\d{1,2}(?:\.\d)?\s*(?:帖|畳)\s*(?:以上|〜|~|から|程度|前後|くらい|ぐらい|の部屋)/, key: "other:room_jo", kind: "その他", search: false },
  { word: "初期費用○円以内", re: INITIAL_COST_YEN_RE, key: "other:initial_cost", kind: "その他", search: false },
  { word: "敷礼0/初期費用を抑えたい", re: /敷金礼金|敷礼|ゼロゼロ|フリーレント|初期費用.{0,14}(?:抑え|おさえ|安く|少な|なし|無し|0円|ゼロ|かからない|安い)/, key: "other:low_initial_cost", kind: "その他", search: true },
  { word: "築○年以内/築浅/新築", re: /築\s*\d{1,2}\s*年\s*(?:以内|まで|未満|以下)|築浅|新築/, key: "other:age_text", kind: "その他", search: false },
  { word: "駅近/徒歩○分以内", re: WALK_TEXT_RE, key: "other:walk_text", kind: "その他", search: false },
  { word: "収納", re: /収納|クローゼット|押入|納戸/, key: "free:", kind: "その他", search: false },
  { word: "即入居", re: /即入居|すぐ(?:に)?(?:入居|住め)|なるべく早く/, key: "column:move_in_time", kind: "その他", search: false },
];
