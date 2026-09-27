// app/lib/search-condition-drift.ts（純関数・依存なし・画面とサーバーで共用できる）
// 検索の点検: 「実際に画面に入った値（読み戻し）」と「お客様の登録の条件（検索を始めた時の写し）」の食い違いを見る。
//
// 2026-09-27 竹内（YUMA の実検索・点検 22）: 条件を変えた直後のブレインの検索が古い条件で入力された
//   （登録＝浪速区・天王寺区／1K・1DK・1LDK／8万／築20年 → 入った値＝西区・大正区・天王寺区・浪速区／1K・1DK／7.5万／築30年）。
//   今までの点検は「入れようとした値 ↔ 入った値」の家賃と更新日しか見ておらず、入れようとした値そのものが古い時に気づけなかった。
//   → 登録の条件と、入った値（読み戻しが無い欄は入れようとした値）を比べる。
//
// 線の引き方（誤検知を増やさない）:
//   ・その回だけの上書き（customer_snapshot._search_override＝AIXツールのメモの検索の指示）で変えた項目は比べない
//   ・広げての回（is_wide）は決まりの幅（家賃 +5千円（10万以下）/+1万円・築 +5年・難波の3区・同じ部屋数の DK）を許す。
//     is_wide が分からない（null）時はピンポイントと広げての両方を許す
//   ・リアプロの選択肢は切り上げ（家賃・築年は nearestUp）なので、選択肢に切り上げた値も同じと見る
//   ・区: 希望エリアが全部「〇〇区／〇〇市」の書き方の時だけ「余分な区」を言う（駅名・町名が混ざると区に直せないので欠けだけ見る）
//   ・間取り: 「以上」「〜」の書き方は範囲に広がるので「余分」は言わない（欠けだけ）。SLDK は置き換える決まりなので比べない
//   ・こだわり: 検索の画面に入れるのはペット相談・敷金礼金なしだけ（バストイレ別・オートロック等は検索では絞らず、ピックアップの判定で見る）。
//     登録にあるのに検索に入っていない時だけ言う（写しに無い欄の書き込みで逆向きを誤って言わない）
// 重さ: 狭い（欲しい物件が漏れる）＝ bad／広い・混ざった ＝ warn。3項目以上が同時にずれた時は「古い条件で検索したおそれ」（bad）を1つ足す。

export type DriftSeverity = "warn" | "bad";
export type DriftField = "ward" | "floor_plan" | "rent" | "age" | "walk" | "pet" | "shikirei";
export type DriftKind = "missing" | "extra" | "lower" | "higher" | "not_filled";

export type DriftItem = {
  field: DriftField;
  kind: DriftKind;
  severity: DriftSeverity;
  title: string;
  detail: string;
  /** 比べた値がどこから来たか（form＝画面の読み戻し／intended＝入れようとした値） */
  source: "form" | "intended";
};

export type DriftInput = {
  site?: string | null;
  is_wide?: boolean | null;
  customer?: Record<string, unknown> | null;
  intended?: Record<string, unknown> | null;
  form?: Record<string, unknown> | null;
};

export type DriftResult = { items: DriftItem[]; stale: boolean };

// ── 静的な表（検索の画面の選択肢・大阪市の区のコード）──
/** リアプロの家賃の選択肢（page-script.js RENT_OPTS と同じ） */
export const REALPRO_RENT_OPTS = [20000, 25000, 30000, 35000, 40000, 45000, 50000, 55000, 60000, 65000, 70000, 75000, 80000, 85000, 90000, 95000, 100000, 110000, 120000, 130000, 140000, 150000, 160000, 170000, 180000, 190000, 200000, 250000, 300000, 350000, 400000, 450000, 500000, 600000, 700000, 800000, 900000, 1000000];
/** リアプロの築年の選択肢（page-script.js AGE_OPTS と同じ） */
export const REALPRO_AGE_OPTS = [1, 3, 5, 7, 10, 15, 20, 25, 30, 35, 40, 45, 50];
/** 市区のコード → 名前（resolution-core.js WARD_CODE_MAP の大阪市・堺市の区） */
export const WARD_CODE_NAMES: Record<string, string> = {
  "27102": "大阪市都島区", "27103": "大阪市福島区", "27104": "大阪市此花区", "27106": "大阪市西区", "27107": "大阪市港区", "27108": "大阪市大正区",
  "27109": "大阪市天王寺区", "27111": "大阪市浪速区", "27113": "大阪市西淀川区", "27114": "大阪市東淀川区", "27115": "大阪市東成区", "27116": "大阪市生野区",
  "27117": "大阪市旭区", "27118": "大阪市城東区", "27119": "大阪市阿倍野区", "27120": "大阪市住吉区", "27121": "大阪市東住吉区", "27122": "大阪市西成区",
  "27123": "大阪市淀川区", "27124": "大阪市鶴見区", "27125": "大阪市住之江区", "27126": "大阪市平野区", "27127": "大阪市北区", "27128": "大阪市中央区",
  "27141": "堺市堺区", "27142": "堺市中区", "27143": "堺市東区", "27144": "堺市西区", "27145": "堺市南区", "27146": "堺市北区", "27147": "堺市美原区",
};
const OSAKA_WARDS = new Set(Object.values(WARD_CODE_NAMES).filter((w) => w.startsWith("大阪市")).map((w) => w.replace(/^大阪市/, "")));
/** 広げての難波の3区（popup.js NAMBA_CLUSTER_WARDS） */
const NAMBA_CLUSTER = ["大阪市中央区", "大阪市浪速区", "大阪市西区"];

const PET_RE = /ペット|pet|犬|猫|ねこ|豆柴|マメ柴|柴犬|小型犬|中型犬|大型犬|動物飼育|動物可/i;
const SHIKIREI_RE = /敷礼なし|敷金礼金なし|敷金礼金0|敷金0礼金0|敷0礼0/;

// ── 小さな道具 ──
function nfkc(s: unknown): string { return String(s ?? "").normalize("NFKC"); }
function uniq<T>(xs: T[]): T[] { return Array.from(new Set(xs)); }

/** 金額 → 円（"80000"・"8万"・8・80000）。-1・空・読めない → null */
export function toYen(raw: unknown): number | null {
  if (raw == null) return null;
  if (typeof raw === "number") { if (!Number.isFinite(raw) || raw <= 0) return null; return raw < 1000 ? Math.round(raw * 10000) : raw; }
  const s = nfkc(raw).replace(/,/g, "").trim();
  if (!s || s === "-1") return null;
  const m = s.match(/(\d+(?:\.\d+)?)/);
  if (!m) return null;
  const n = Number(m[1]);
  if (!Number.isFinite(n) || n <= 0) return null;
  if (/万/.test(s) || n < 1000) return Math.round(n * 10000);
  return n;
}
function toInt(raw: unknown): number | null {
  if (raw == null) return null;
  if (typeof raw === "number") return Number.isFinite(raw) && raw > 0 ? Math.round(raw) : null;
  const s = nfkc(raw).trim();
  if (!s || s === "-1") return null;
  const m = s.match(/\d+/);
  return m && Number(m[0]) > 0 ? Number(m[0]) : null;
}
function nearestUp(opts: number[], v: number): number {
  for (const o of opts) if (o >= v) return o;
  return opts[opts.length - 1];
}
const man = (y: number) => `${(y / 10000).toFixed(y % 1000 === 0 ? (y % 10000 === 0 ? 0 : 1) : 2).replace(/\.0+$/, "")}万`;

/** 区の名前を揃える（「浪速区」→「大阪市浪速区」・「大阪府大阪市西区」→「大阪市西区」） */
export function normWard(s: string): string | null {
  const t = nfkc(s).replace(/\s+/g, "").replace(/^大阪府/, "");
  const m = t.match(/^(大阪市|堺市)?(.+?区)$/);
  if (m) {
    if (m[1]) return `${m[1]}${m[2]}`;
    return OSAKA_WARDS.has(m[2]) ? `大阪市${m[2]}` : null;
  }
  if (/^.+市$/.test(t)) return t;
  return null;
}

/** 希望エリア → 区の一覧と「全部が区・市の書き方か」 */
export function customerWards(desiredArea: unknown): { wards: string[]; allWards: boolean } {
  const toks = nfkc(desiredArea).split(/[、,，・\/／\s]+/).map((x) => x.trim()).filter(Boolean);
  const wards: string[] = [];
  let allWards = toks.length > 0;
  for (const t of toks) {
    const w = normWard(t);
    if (w) { if (!wards.includes(w)) wards.push(w); } else allWards = false;
  }
  return { wards, allWards };
}

/** 間取りの札（1K・1LDK…）。ワンルーム＝1R。範囲の書き方（以上・〜）か */
export function planSet(text: unknown): { plans: string[]; ranged: boolean } {
  const s = nfkc(text).toUpperCase();
  const plans: string[] = [];
  if (/ワンルーム/.test(s)) plans.push("1R");
  const re = /(\d)\s*(SLDK|LDK|SDK|SK|DK|K|R)(?![A-Z])/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(s))) { const t = `${m[1]}${m[2]}`; if (!plans.includes(t)) plans.push(t); }
  return { plans, ranged: /以上|[〜～~]/.test(s) };
}

function formWards(form: Record<string, unknown> | null | undefined): string[] | null {
  const w = form?.wards;
  if (!Array.isArray(w)) return null;
  return uniq(w.map((x) => normWard(String(x))).filter((x): x is string => !!x));
}
function intendedWards(i: Record<string, unknown> | null | undefined): string[] | null {
  if (!i) return null;
  const codes = Array.isArray(i.city_codes) ? i.city_codes.map(String) : [];
  const names = Array.isArray(i.ward_names) ? i.ward_names.map(String) : [];
  if (!codes.length && !names.length) return null;
  const out: string[] = [];
  for (const c of codes) { const n = WARD_CODE_NAMES[c]; if (!n) return null; if (!out.includes(n)) out.push(n); } // 知らないコードがある時は比べない
  for (const n of names) { const w = normWard(n); if (w && !out.includes(w)) out.push(w); }
  return out;
}

/**
 * 入った値（読み戻し・無ければ入れようとした値）と登録の条件の食い違いを並べる（純関数）
 */
export function conditionDrift(a: DriftInput): DriftResult {
  const items: DriftItem[] = [];
  const c = a.customer ?? null;
  if (!c) return { items, stale: false };
  const i = a.intended ?? null;
  const form = a.form ?? null;
  const site = String(a.site ?? "").toLowerCase();
  const realpro = site === "realpro" || site === "realnetpro";
  const wide = a.is_wide; // true / false / null（分からない）
  const ov = (c._search_override && typeof c._search_override === "object") ? c._search_override as Record<string, unknown> : {};
  const add = (field: DriftField, kind: DriftKind, severity: DriftSeverity, title: string, detail: string, source: "form" | "intended") =>
    items.push({ field, kind, severity, title, detail: detail.slice(0, 300), source });

  // ── 区（地域で入れた回だけ）──
  if (ov.location == null) {
    const fw = formWards(form);
    const iw = intendedWards(i);
    const byStation = (Array.isArray(form?.stations) && (form?.stations as unknown[]).length > 0) || i?.area_mode === "station";
    const actual = fw && fw.length ? fw : iw;
    const src: "form" | "intended" = fw && fw.length ? "form" : "intended";
    const { wards, allWards } = customerWards(c.desired_area);
    if (actual && actual.length && wards.length && !byStation) {
      const missing = wards.filter((w) => !actual.includes(w));
      const allowed = new Set(wards);
      if (wide !== false && wards.some((w) => NAMBA_CLUSTER.includes(w))) NAMBA_CLUSTER.forEach((w) => allowed.add(w));
      const extra = actual.filter((w) => !allowed.has(w));
      const short = (xs: string[]) => xs.map((w) => w.replace(/^大阪市/, "")).join("・");
      if (missing.length) add("ward", "missing", "bad", `希望の区（${short(missing)}）が入っていない`, `登録=${short(wards)}・入った=${short(actual)}`, src);
      if (extra.length && allWards) add("ward", "extra", "warn", `希望にない区（${short(extra)}）が混ざった`, `登録=${short(wards)}・入った=${short(actual)}${wide ? "（広げての決まりの区は除いた）" : ""}`, src);
    }
  }

  // ── 間取り ──
  if (ov.floor_plan == null) {
    const cp = planSet(c.floor_plan ?? c.layout);
    const fl = Array.isArray(form?.layouts) ? (form?.layouts as unknown[]).map(String) : null;
    const fp = fl ? planSet(fl.join(" ")).plans : null;
    const usable = fl && fl.length > 0 && fp && fp.length > 0; // 読み戻しが間取りの形で読めた時だけ（itandi は id なので読めない）
    const actual = usable ? fp! : (i?.floor_plan ? planSet(i.floor_plan).plans : null);
    const src: "form" | "intended" = usable ? "form" : "intended";
    const want = cp.plans.filter((p) => !/SLDK$/.test(p));
    if (actual && actual.length && want.length) {
      const missing = want.filter((p) => !actual.includes(p));
      const wideOk = (p: string) => wide !== false && /^\dDK$/.test(p) && want.includes(p.replace(/DK$/, "LDK"));
      const extra = cp.ranged ? [] : actual.filter((p) => !want.includes(p) && !/SLDK$/.test(p) && !wideOk(p));
      if (missing.length) add("floor_plan", "missing", "bad", `希望の間取り（${missing.join("・")}）が入っていない`, `登録=${c.floor_plan ?? c.layout}・入った=${actual.join("・")}`, src);
      if (extra.length) add("floor_plan", "extra", "warn", `希望にない間取り（${extra.join("・")}）が入った`, `登録=${c.floor_plan ?? c.layout}・入った=${actual.join("・")}`, src);
    }
  }

  // ── 家賃の上限 ──
  if (ov.rent_max == null) {
    const cy = toYen(c.rent_max ?? c.max_rent);
    const formHas = !!form && "rent_max" in form;
    const fy = formHas ? toYen(form!.rent_max) : null;
    const iy = toYen(i?.rent_max);
    const actual = formHas ? fy : iy;
    const src: "form" | "intended" = formHas ? "form" : "intended";
    if (cy != null) {
      const addWide = cy <= 100000 ? 5000 : 10000;
      const cands = wide === true ? [cy + addWide] : wide === false ? [cy] : [cy, cy + addWide];
      const exp = realpro ? cands.map((v) => nearestUp(REALPRO_RENT_OPTS, v)) : cands;
      const lo = Math.min(...exp), hi = Math.max(...exp);
      if (actual == null) {
        // 入れようとした値にも無い時は CONDITION_MISREAD（賃料の条件が検索に入っていない）が言う
        if (formHas) add("rent", "not_filled", "bad", "家賃の上限が入っていない", `登録=${man(cy)}・入った=なし`, src);
      } else if (actual < lo - 1) {
        add("rent", "lower", "bad", "家賃の上限が登録より低い", `登録=${man(cy)}${wide ? "（広げて）" : ""}・入った=${man(actual)}`, src);
      } else if (actual > hi + (realpro ? 1 : 3000)) {
        add("rent", "higher", "warn", "家賃の上限が登録より高い", `登録=${man(cy)}${wide ? "（広げて）" : ""}・入った=${man(actual)}`, src);
      }
    }
  }

  // ── 築年数 ──
  if (ov.building_age == null) {
    const ca = toInt(c.building_age);
    const formHas = !!form && "age" in form;
    const actual = formHas ? toInt(form!.age) : toInt(i?.building_age);
    const src: "form" | "intended" = formHas ? "form" : "intended";
    if (ca != null) {
      const cands = wide === true ? [ca + 5] : wide === false ? [ca] : [ca, ca + 5];
      const exp = realpro ? cands.map((v) => nearestUp(REALPRO_AGE_OPTS, v)) : cands;
      const lo = Math.min(...exp), hi = Math.max(...exp);
      if (actual == null) {
        if (formHas) add("age", "not_filled", "warn", "築年数が入っていない", `登録=${ca}年以内・入った=指定なし`, src);
      } else if (actual < lo) {
        add("age", "lower", "bad", "築年数が登録より狭い", `登録=${ca}年以内${wide ? "（広げて）" : ""}・入った=${actual}年以内`, src);
      } else if (actual > hi) {
        add("age", "higher", "warn", "築年数が登録より広い", `登録=${ca}年以内${wide ? "（広げて）" : ""}・入った=${actual}年以内`, src);
      }
    }
  }

  // ── 徒歩 ──
  if (ov.walk_minutes == null) {
    const cw = toInt(c.walk_minutes);
    const formHas = !!form && "walk" in form;
    const actual = formHas ? toInt(form!.walk) : toInt(i?.walk_minutes);
    const src: "form" | "intended" = formHas ? "form" : "intended";
    if (cw != null) {
      if (actual == null) {
        if (formHas) add("walk", "not_filled", "warn", "徒歩の条件が入っていない", `登録=${cw}分・入った=指定なし`, src);
      } else if (actual < cw) {
        add("walk", "lower", "bad", "徒歩の条件が登録より狭い", `登録=${cw}分・入った=${actual}分`, src);
      } else if (actual > cw) {
        add("walk", "higher", "warn", "徒歩の条件が登録より広い", `登録=${cw}分・入った=${actual}分`, src);
      }
    }
  }

  // ── こだわり（検索の画面に入れる物だけ）──
  if (i) {
    const text = `${nfkc(c.preferences)} ${nfkc(c.ng_points)}`;
    if (ov.pet == null && (c.pet === true || c.pet === "true" || PET_RE.test(text)) && i.pet_ok === false) {
      add("pet", "missing", "warn", "ペット相談が検索に入っていない", `登録のこだわり=${nfkc(c.preferences).slice(0, 60) || "pet"}`, "intended");
    }
    if (SHIKIREI_RE.test(text) && i.shikirei_free === false) {
      add("shikirei", "missing", "warn", "敷金礼金なしが検索に入っていない", `登録のこだわり=${nfkc(c.preferences).slice(0, 60)}`, "intended");
    }
  }

  const fields = uniq(items.map((x) => x.field));
  return { items, stale: fields.length >= 3 };
}
