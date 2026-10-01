// app/lib/hearing-form.ts
import { analyzeSumoraForm } from "./condition-format";
import { occupantsFromTexts } from "./co-resident";
// AIX【条件ヒアリング】のフォーム本体を決定論で組み立てる（純関数・DB 依存なし）。
//
// 2026-10-02 竹内さんの決定「お客さんからもらっている条件は項目のところにいれるとお客さん入力しやすい」
//   「ヒアリングのフォーマットはそのまま（項目を落とさずに）送る」:
//   旧（aix/action と AixModal の buildHearingFormText）は「条件の文字に key が入っていれば既知」として**項目を消し**、
//   番号を詰め直していた（例: YUMA 8/24「①ご入居時期 ②ご希望築年数 ③初期費用ご予算 ④その他」の4項目だけ）。
//   お客様には何が分かっていて何が足りないのかが見えず、分かっていた条件（エリア・家賃・間取り）がフォームから消える＝情報が落ちる。
//
// 【実物（scripts/audit-pickup-conditions-complete.ts の前段・365日のスタッフの送信 70通）】
//   形の 8 割以上が下の 8 項目そのまま（41通）。項目を落とした送信は旧ロジックの4項目（2通）と手打ちの7項目（1通）だけ。
//   **人が既知の条件を書き入れた実物**が1通ある（c167c5f1 7/23・スタッフ）:
//     ③ご希望間取り　1LDK
//     ⑤ご希望エリア・最寄り駅　難波付近
//   → 項目名の後ろに**全角の空白1つ**で値を書く。お客様も同じ形（「②ご希望家賃（管理費込み）　8-10万」）で返してくる。
//   この形を既定にする（全 8 項目を必ず出し、分かっている所だけ値を入れる）。
//
// 値の出所は property_customers の列（1か所: HearingKnown）。条件の文字（画面の formatConditions「エリア: …」／
// ブレインの「顧客条件: エリア: … / 間取り: …」）しか無い時は parseConditionText で同じ形に直す。
// 推測で埋めない（無い項目は空欄のまま＝お客様が書く所）。

/** 8 項目（実送信の 41/70 通の文言そのまま・順番も）。label は送る文字、key は内部の名前 */
export const HEARING_FORM_ITEMS = [
  { key: "move_in",      label: "ご入居時期" },
  { key: "rent",         label: "ご希望家賃（管理費込み）" },
  { key: "floor_plan",   label: "ご希望間取り" },
  { key: "building_age", label: "ご希望築年数" },
  { key: "area",         label: "ご希望エリア・最寄り駅" },
  { key: "walk",         label: "駅からの徒歩分数" },
  { key: "initial_cost", label: "初期費用ご予算" },
  { key: "other",        label: "その他こだわり条件（ペット・保証人・駐車場等）" },
  // 2026-10-02 竹内さん「入居人数を足す」: 申込へのフォーマットの単独／同居あり（同居人記入欄）を決めるため。
  //   ①〜⑧の番号と文言は変えずに最後に ⑨ として足す（返ってきたフォームの読み取り・条件の文の「①〜⑧」の言及・手本と食い違わない）。
  //   文言はスタッフの項目の形（「ご入居時期」と同じ「ご入居〜」）。お客様の実物にも「⑥入居予定人数 ⇒1人」がある
  { key: "occupants",    label: "ご入居人数" },
] as const;

export type HearingItemKey = typeof HEARING_FORM_ITEMS[number]["key"];

/** フォームに書き入れる既知の値（property_customers の列の形） */
export type HearingKnown = {
  move_in_time?: string | null;
  rent_min?: number | null;
  rent_max?: number | null;
  floor_plan?: string | null;
  building_age?: number | null;
  desired_area?: string | null;
  commute_station?: string | null;
  commute_minutes?: number | null;
  walk_minutes?: number | null;
  initial_cost_limit?: number | null;
  preferences?: string | null;
  other_requests?: string | null;
  ng_points?: string | null;
  pet?: boolean | null;
  /** 入居人数（property_customers.occupants・2026-10-02） */
  occupants?: number | null;
};

const CIRCLE = ["①", "②", "③", "④", "⑤", "⑥", "⑦", "⑧", "⑨"];
const SEP = "　"; // 全角の空白（人の実物の形）

const s = (v: unknown): string => (v === null || v === undefined ? "" : String(v).replace(/\s+/g, " ").trim());
/** 円 → 「7万円」「7.5万円」 */
function man(yen: number | null | undefined): string {
  if (!yen || !Number.isFinite(yen) || yen <= 0) return "";
  const v = yen / 10000;
  return `${Number.isInteger(v) ? v : Math.round(v * 10) / 10}万円`;
}

/** 項目ごとの書き入れる値（無い項目は ""） */
export function hearingValues(k: HearingKnown | null | undefined): Record<HearingItemKey, string> {
  const out: Record<HearingItemKey, string> = { move_in: "", rent: "", floor_plan: "", building_age: "", area: "", walk: "", initial_cost: "", other: "", occupants: "" };
  if (!k) return out;
  out.move_in = s(k.move_in_time);
  const lo = man(k.rent_min), hi = man(k.rent_max);
  out.rent = lo && hi ? `${lo}〜${hi}` : hi ? `〜${hi}` : lo ? `${lo}〜` : "";
  out.floor_plan = s(k.floor_plan);
  out.building_age = k.building_age && k.building_age > 0 ? `${k.building_age}年以内` : "";
  const area = s(k.desired_area);
  const commute = s(k.commute_station) ? `${s(k.commute_station)}まで${k.commute_minutes ? `${k.commute_minutes}分` : ""}` : "";
  out.area = [area, commute && !area.includes(s(k.commute_station)) ? commute : ""].filter(Boolean).join("・");
  out.walk = k.walk_minutes && k.walk_minutes > 0 ? `${k.walk_minutes}分以内` : "";
  out.initial_cost = man(k.initial_cost_limit) ? `${man(k.initial_cost_limit)}以内` : "";
  // その他: 希望・その他の要望・NG を「・」でつなぐ（同じ語の重複は落とす）。ペット（列）は語に無い時だけ足す
  const parts: string[] = [];
  const push = (t: string) => {
    for (const p of t.split(/[・、,，\n]/).map((x) => x.trim()).filter(Boolean)) {
      if (!parts.some((q) => q === p || q.includes(p))) parts.push(p);
    }
  };
  push(s(k.preferences));
  push(s(k.other_requests));
  const ng = s(k.ng_points);
  if (ng) push(/NG|不可|なし|無し/.test(ng) ? ng : `${ng}NG`);
  if (k.pet === true && !parts.some((p) => /ペット/.test(p))) parts.push("ペット可");
  out.other = parts.join("・");
  out.occupants = k.occupants && k.occupants > 0 ? `${k.occupants}名` : "";
  return out;
}

/** お客様の呼び名（「あさみさん」形式。さん・様が無ければ付ける） */
function honorific(name: string | null | undefined): string {
  const n = s(name);
  if (!n) return "";
  return /(さん|様)$/.test(n) ? n : `${n}さん`;
}

/**
 * 条件ヒアリングのフォーム本体（8 項目を必ず全部・分かっている所は全角の空白の後に値）。
 * 例: 「（恵人さんご希望のお部屋探しご条件）\n①ご入居時期\n②ご希望家賃（管理費込み）\n③ご希望間取り　1LDK …」
 */
export function buildHearingForm(customerName: string | null | undefined, known: HearingKnown | null | undefined): string {
  const v = hearingValues(known);
  const lines = HEARING_FORM_ITEMS.map((it, i) => `${CIRCLE[i]}${it.label}${v[it.key] ? `${SEP}${v[it.key]}` : ""}`);
  return `（${honorific(customerName)}ご希望のお部屋探しご条件）\n${lines.join("\n")}`;
}

/** 書き入れた項目の数（画面の表示・監査用） */
export function prefilledCount(known: HearingKnown | null | undefined): number {
  return Object.values(hearingValues(known)).filter(Boolean).length;
}

/**
 * 条件の文字（画面の formatConditions「エリア: 難波\n家賃: 〜7万円以内」／ブレインの「顧客条件: エリア: … / 間取り: …」）を HearingKnown に直す。
 * 列が直接読めない画面（AixModal の初期表示）と、会話が顧客に紐付いていない時の文字のメモに使う。
 * 「追加条件」（AI が見つけた未反映の変更の控え）は書き入れない（確定していないため）。
 */
export function parseConditionText(text: string | null | undefined): HearingKnown {
  const out: HearingKnown = {};
  const raw = s(text) ? String(text) : "";
  if (!raw) return out;
  const body = raw.includes("顧客条件:") ? raw.slice(raw.indexOf("顧客条件:") + "顧客条件:".length) : raw;
  const segs = body.split(/\n|\s\/\s/).map((x) => x.trim()).filter(Boolean);
  const num = (t: string): number | null => {
    const m = t.match(/([0-9]+(?:\.[0-9]+)?)/);
    return m ? Number(m[1]) : null;
  };
  const manToYen = (t: string): number | null => {
    const m = t.match(/([0-9]+(?:\.[0-9]+)?)\s*万/);
    if (m) return Math.round(Number(m[1]) * 10000);
    const y = t.replace(/[,，]/g, "").match(/([0-9]{4,})\s*円?/);
    return y ? Number(y[1]) : null;
  };
  for (const seg of segs) {
    const m = seg.match(/^([^:：]{1,8})[:：]\s*(.*)$/);
    if (!m) continue;
    const key = m[1].trim(), val = m[2].trim();
    if (!val) continue;
    switch (key) {
      case "エリア": out.desired_area = val; break;
      case "間取り": out.floor_plan = val; break;
      case "入居": out.move_in_time = val; break;
      case "家賃": {
        // 「7万円〜10万円以内」「〜10万円以内」「7万円〜」
        const [a, b] = val.split(/[〜~ー-]/);
        if (b !== undefined) { out.rent_min = a ? manToYen(a) : null; out.rent_max = b ? manToYen(b) : null; }
        else out.rent_max = manToYen(val);
        break;
      }
      case "家賃上限": out.rent_max = manToYen(val); break;
      case "家賃下限": out.rent_min = manToYen(val); break;
      case "駅徒歩": out.walk_minutes = num(val); break;
      case "築年数": out.building_age = num(val); break;
      case "初期費用":
      case "初期費用上限": out.initial_cost_limit = manToYen(val); break;
      case "希望": out.preferences = val; break;
      case "NG":
      case "NG条件": out.ng_points = val; break;
      case "その他":
      case "その他要望": out.other_requests = val; break;
      case "通勤先": {
        const mm = val.match(/^(.*?)(?:（([0-9]+)分以内）)?$/);
        out.commute_station = mm?.[1] ?? val;
        out.commute_minutes = mm?.[2] ? Number(mm[2]) : null;
        break;
      }
      case "ペット": out.pet = /可/.test(val) && !/不可/.test(val); break;
      case "入居人数": { const n = Number((val.normalize("NFKC").match(/[0-9]+/) ?? [""])[0]); out.occupants = n > 0 && n <= 9 ? n : null; break; }
      default: break;
    }
  }
  return out;
}

// ── 物件ピックアップに必要な条件がそろったか（2026-10-02 竹内さん「物件ピックアップは条件がそろってから」）──
// 実データ（scripts/audit-pickup-conditions-complete.ts・180日・スタッフの最初の物件ピックアップ 212会話）:
//   その時点で条件の行があった 172 のうち エリア（または通勤先）97%・家賃上限 98%・間取り 86%・入居時期 86%・駅徒歩 67%・
//   初期費用 46%・築年数 40%。エリア＋家賃の両方 166/172（97%）。4つ全部（エリア・家賃・間取り・入居）は 129/172（75%）で、
//   間取り・入居が無いままスタッフが送った最初のピックアップが 4 件に 1 件ある → **必須はエリアと家賃の2つ**（間取り・入居まで要ると実際の送り方の 25% を止める）。
//   条件の行が無い・欠けている項目は、お客様の発言（フォームの記入は analyzeSumoraForm・それ以外は粗い線）でも探す
//   （行の作成・紐付けが遅れた形を止めない向き）。この線で最初のピックアップ 212 のうち「そろった」200（94%）・「足りない」12。
//   足りない 12 を目で読むと、9 は AIX の外で物件を送った後（「上の2つ」「全て拝見…ほかの物件は」・内覧の後）か
//   お客様が持ち込んだ物件の話（画像＋「初期費用しりたい」・「プレジオ系列は」）＝ブレイン側の「まだ物件を1件も送っていない」の条件と
//   物件ピックアップだけに当てる（物件オススメ・物件確認は対象外）ことで外れる。残り 3 は家賃が分からないまま送った（「場所より安さで」等）。
//   逆に、スタッフが条件ヒアリングを送った時点（92会話）は「足りない」48（52%・何も読めない 35）＝そろっていない時の形。
export type PickupReadiness = {
  ready: boolean;
  /** 足りない項目（ヒアリングで聞く所）。ready の時は空 */
  missing: Array<"area" | "rent">;
  /** どこから判断したか */
  source: "customer_row" | "customer_text" | "none";
};

const AREA_TEXT_RE = /区|市内|[^\s]{1,8}市|駅|線|沿い|エリア|周辺|付近|辺り|あたり|梅田|難波|なんば|心斎橋|天王寺|本町|京橋|堀江|福島|中津|天満|谷町|江坂|十三|新大阪|上本町|北浜|[一-龠]{1,5}(?:橋|町|筋)/;
// 「6〜8」「7~8.5」「14以下」（フォームの家賃欄・単位なしの書き方）も家賃に数える。時刻・日付（「14:30〜」「10日まで」）は外す
const RENT_TEXT_RE = /[0-9０-９.．]+\s*万|[0-9,，]{5,}\s*円|家賃[^\n]{0,6}[0-9０-９]|(?:^|[^0-9:：/])[0-9]{1,2}(?:\.[0-9])?\s*[〜~ー-]\s*[0-9]{1,2}(?:\.[0-9])?(?![0-9:：時分日月])|(?:^|[^0-9:：/])[0-9]{1,2}(?:\.[0-9])?\s*(?:以下|以内)/;

/** お客様の発言（とフォームの記入）でエリア・家賃に触れているか（粗い線・そろったかの判定の補い） */
function itemsFromText(texts: ReadonlyArray<string>): { area: boolean; rent: boolean } {
  let area = false, rent = false;
  for (const t of texts) {
    const f = analyzeSumoraForm(t);
    if (f.labelCount >= 3) { area = area || f.filled.includes("area"); rent = rent || f.filled.includes("rent"); continue; }
    area = area || AREA_TEXT_RE.test(t);
    rent = rent || RENT_TEXT_RE.test(t);
  }
  return { area, rent };
}

/**
 * 物件ピックアップに必要な条件（エリア＋家賃）がそろっているか。
 * 顧客の行に無い項目はお客様の発言でも探す（行の作成・反映が遅れた形を止めない向き）。
 * @param known 顧客の行（property_customers）。紐付いていなければ null
 * @param customerTexts お客様の発言
 */
export function pickupConditionsReady(known: HearingKnown | null | undefined, customerTexts: ReadonlyArray<string> = []): PickupReadiness {
  const rowArea = !!known && (!!s(known.desired_area) || !!s(known.commute_station));
  const rowRent = !!known && ((known.rent_max ?? 0) > 0 || (known.rent_min ?? 0) > 0);
  const txt = rowArea && rowRent ? { area: true, rent: true } : itemsFromText(customerTexts.filter((t) => !!t && t.trim() !== ""));
  const missing: Array<"area" | "rent"> = [];
  if (!rowArea && !txt.area) missing.push("area");
  if (!rowRent && !txt.rent) missing.push("rent");
  const usedText = (!rowArea && txt.area) || (!rowRent && txt.rent);
  const source: PickupReadiness["source"] = usedText ? "customer_text" : known ? "customer_row" : customerTexts.some((t) => t && t.trim()) ? "customer_text" : "none";
  return { ready: missing.length === 0, missing, source };
}

// ── 顧客の行が無い時の書き入れ（お客様の発言から・2026-10-02）──
// 条件ヒアリングを送る時点の 68%（92会話のうち 63）は顧客の行がまだ無い（scripts/audit-pickup-conditions-complete.ts）。
// その時もお客様が既に言った事（「難波周辺でワンルーム」）はフォームに入れる（竹内さん「もらっている条件は項目に入れる」）。
// 語はお客様の言葉のまま切り出すだけ（言い換えない・推測しない）。読めない項目は空欄。行がある時は行が先（mergeHearingKnown）。
const PLAN_RE = /(?:[1-4１-４]\s*(?:S?LDK|DK|K|R)(?:\s*(?:以上|〜|~))?|ワンルーム)/i;
const RENT_RE = /(?:家賃|予算)?[^。\n、]{0,4}?([0-9０-９]+(?:\.[0-9])?)\s*万(?:円)?\s*(以内|以下|まで|前後|程度|くらい|ぐらい)?/;
const MOVE_RE = /([0-9０-９]{1,2}月(?:頃|ごろ|中|末|上旬|中旬|下旬|初旬|前半|後半)?|年内|すぐ|即入居|いつでも|未定)(?:に|で|の|まで)?(?:入居|引っ越|引越|住)/;
const AREA_RE = /([一-龠ァ-ヶーA-Za-z・]{2,12})(?:駅)?(?:周辺|付近|近辺|エリア|あたり|辺り|沿線|市内)/;

export function hearingKnownFromCustomerTexts(texts: ReadonlyArray<string | null | undefined>): HearingKnown {
  const out: HearingKnown = {};
  // 入居人数は数が書いてある時だけ（「二人入居」「大人2 子ども1」「⑨ご入居人数 2名」・co-resident.occupantsFromText）
  const occ = occupantsFromTexts(texts);
  if (occ) out.occupants = occ.count;
  // 新しい発言を優先（言い直し）
  for (const raw of [...texts].reverse()) {
    const t = String(raw ?? "").normalize("NFKC");
    if (!t.trim() || /^\s*\[画像\]/.test(t) || /https?:\/\//.test(t)) continue;
    const f = analyzeSumoraForm(t);
    if (f.labelCount >= 3) continue; // 記入済みのフォームは webhook が顧客の行に入れる（ここでは読まない）
    if (!out.floor_plan) { const m = t.match(PLAN_RE); if (m) out.floor_plan = m[0].replace(/\s+/g, ""); }
    if (!out.rent_max) { const m = t.match(RENT_RE); if (m && /家賃|予算|万円?(?:以内|以下|まで)/.test(m[0])) out.rent_max = Math.round(Number(m[1]) * 10000); }
    // 文ごとに見る。特定のお部屋の話（「〇〇というマンションの空き」「〇月に入居することは可能ですか」）は条件ではないので読まない
    //   （監査 scripts/audit-hearing-prefill.ts: ヒアリングの時点 58会話で書き入れ 10・うち2件がこの形だった）
    for (const sen of t.split(/\n|(?<=[。！!？?])/)) {
      if (/マンション|物件名|空き|空いて|という|可能ですか|できますか|出来ますか/.test(sen)) continue;
      if (!out.move_in_time) { const m = sen.match(MOVE_RE); if (m) out.move_in_time = m[1]; }
      if (!out.desired_area) { const m = sen.match(AREA_RE); if (m && !/お部屋|物件|条件|希望|全体|ワンルーム/.test(m[1])) out.desired_area = m[0].replace(/(?:あたり|辺り)$/, "周辺"); }
    }
  }
  return out;
}

/** 顧客の行（先）＋発言から読んだ値（空欄だけ埋める） */
export function mergeHearingKnown(primary: HearingKnown | null | undefined, fallback: HearingKnown | null | undefined): HearingKnown {
  const out: HearingKnown = { ...(fallback ?? {}) };
  for (const [k, v] of Object.entries(primary ?? {})) if (v !== null && v !== undefined && String(v).trim() !== "") (out as Record<string, unknown>)[k] = v;
  return out;
}
