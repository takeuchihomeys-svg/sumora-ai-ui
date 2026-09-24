// app/lib/image-wants.ts
// 「画像（物件資料）で確かめられる希望」を、条件欄・お客様の会話・物件オススメの訴求点から集めて番号付きの一覧にする（純関数・DB 依存なし）。
//
// 2026-09-24 竹内「お客さんの希望条件からより細かくオススメの物件を判断できるか。希望条件や NG 条件の細かい部分も画像から判断できているか。
//   画像からしか分からない事の部分を会話から読み取って抜けている部分を入れておく。物件オススメで訴求している部分なども見れば分かる」
//
// 実測（scripts/peek-wants-sources.ts・2026-09-24）:
//   - 条件欄に画像系の希望がある物件顧客 134/299
//   - お客様の発言（30日）で画像系の語を含む 51通・28会話。条件欄に無い物がある:
//     「リビングと寝室兼書斎の生活空間を分けたい」「洋室が小さそう、もう少し余裕を」「風呂場の手洗い無し・風呂トイレ別」
//   - 物件オススメの訴求点（selling_points）で画像で判断する物: 広い間取り×73・角部屋×59・日当たり良好×23・バストイレ別×20
// 設計（設計知見「入口は厳しく」「画像は書いてある時だけ」）:
//   - 集めるのは「資料（1ページ目）を見れば確かめられる」話題だけ（水回り・キッチン・部屋の配置・収納・広さ・日当たり/向き/角部屋・階・
//     ペット・設備）。家賃・エリア・駅は画像で決めない（混ぜると「分からない」が増えて点が薄まる）
//   - 会話は「欲しい／嫌」の言い方がある文だけ（質問や物件の貼り付け＝[画像] の OCR は入れない）。お客様の名前・電話は伏せる
//   - NG・[必須] は印を付けて、判定で重く扱う（NG[必須] に当たったら点を大きく下げる）
export type WantSource = "条件" | "会話" | "訴求" | "メモ";
export type ImageWant = { id: string; source: WantSource; text: string; topics: string[]; ng: boolean; must: boolean };

export const IMAGE_TOPICS: Array<{ key: string; label: string; re: RegExp }> = [
  { key: "water", label: "水回り", re: /水回り|水まわり|バス.?トイレ|風呂|浴室|お風呂|トイレ|独立洗面|洗面|手洗い|追い焚き|追焚|浴室乾燥|洗濯機|室内干し|脱衣/ },
  { key: "kitchen", label: "キッチン", re: /キッチン|台所|対面|カウンター|IH|ガスコンロ|コンロ|[2二3三]口|自炊|料理/ },
  { key: "layout", label: "部屋の配置", re: /リビング|寝室|書斎|洋室|和室|続き間|仕切|分けたい|分かれ|別々|空間|間取り図|部屋の配置|独立した/ },
  { key: "storage", label: "収納", re: /収納|WIC|ウォークイン|ｳｫｰｸｲﾝ|クローゼット|クロゼット|納戸|押入|物置|シューズ/ },
  { key: "size", label: "広さ", re: /広い|広め|広さ|余裕|狭い|狭く|小さ|大きめ|ゆったり|帖|畳/ },
  { key: "light", label: "日当たり・向き", re: /日当たり|日あたり|南向き|東向き|西向き|北向き|角部屋|窓|明るい|採光/ },
  { key: "floor", label: "階", re: /[2２二]階以上|1階|一階|１階|高層|上の階|低層|最上階/ },
  { key: "pet", label: "ペット", re: /ペット|犬|猫|ねこ|いぬ|小型犬/ },
  { key: "equip", label: "設備", re: /オートロック|宅配|ネット無料|インターネット|エアコン|モニター付|防犯|エレベーター|バルコニー|ベランダ|ロフト|駐輪|駐車場/ },
];

/** 欲しい／嫌 の言い方（会話の文を拾う入口。質問だけの文は拾わない） */
const DESIRE_RE = /たい|がいい|が良い|がええ|希望|欲しい|ほしい|嬉しい|うれしい|嫌|いや|NG|ng|無し|なし|いらない|要らない|不要|小さ|狭|余裕|広め|こだわ|絶対|必須|できれば|出来れば|優先|気になる|避けたい|お願い|別で|別が|付き|付いて|あると|がある/;
/** 物件の貼り付け（お客様がポータルの画面を送ってきた OCR）＝希望ではない */
const PASTE_RE = /^\s*\[画像\]|間取り[:：]\s*\d|広さ[:：]|築年(?:数|月)[:：]|管理費\s*\d|万円\/管理費/;

export function topicsOf(text: string): string[] {
  return IMAGE_TOPICS.filter((t) => t.re.test(text)).map((t) => t.key);
}

/**
 * 先頭の箇条書きの印（「・」「①」「1.」「2)」）を外す。
 * 2026-09-24 YUMA: 数字を丸ごと外していたので、条件欄の「1階NG」が「階NG」になり希望から落ちていた
 *   → 数字は後ろに「.」「)」「、」が付く番号の時だけ外す
 */
function clean(s: string): string {
  return s.replace(/\s+/g, " ").replace(/^(?:[・\-－\s①-⑳、,]+|[0-9０-９]{1,2}[.．)）、,](?![0-9０-９])\s*)+/, "").trim();
}

/**
 * 1つの設備の名前の中の「・」（割らない）。2026-09-24 夜: 「バス・トイレ別」が「バス」「トイレ別」の2つの希望に割れていた
 * （「トイレ別」だけが残り、「バス」は話題に当たらず消える・浴室とトイレの話が1つにならない）
 */
const KEEP_DOT_RE = /(バス|風呂|お風呂|浴室)[・･](トイレ)|(洗面)[・･](脱衣)|(キッチン)[・･](ダイニング)/g;
const DOT_MARK = "\u0000";
export function splitClauses(s: string): string[] {
  const kept = String(s ?? "").replace(KEEP_DOT_RE, (m) => m.replace(/[・･]/, DOT_MARK));
  return kept.split(/[\n。、,，／/]|・(?=[^・]{2,})/).map((x) => clean(x.split(DOT_MARK).join("・"))).filter((x) => x.length >= 2 && x.length <= 60);
}

/**
 * 会話の文を割る（改行・句点・！？）。フォームの回答（「【その他こだわりご要望】⇒白基調、お風呂トイレ別、…」）は
 * 見出しを外して「、」で1項目ずつにする。答えが空の見出し（「【希望の広さ・間取り】⇒」）は捨てる
 */
function splitSentences(s: string): string[] {
  const out: string[] = [];
  for (const line of String(s ?? "").split(/[\n。！？!?]/)) {
    const m = line.match(/^\s*[【\[（(]?[^】\]）)]{0,20}[】\]）)]?\s*(?:⇒|→|：|:)\s*(.*)$/);
    if (m) {
      for (const p of m[1].split(/[、,，／/]/)) { const c = clean(p); if (c.length >= 2 && c.length <= 60) out.push(c); }
      continue;
    }
    const c = clean(line);
    if (c.length >= 4 && c.length <= 80) out.push(c);
  }
  return out;
}
/** フォームの回答の1項目（見出しの後ろ）は「欲しい」の言い方が無くても希望として扱う */
const FORM_LINE_RE = /[】\]）)]\s*(?:⇒|→)|^\s*[①-⑳]/;

export type ImageWantsInput = {
  conditions?: { preferences?: string | null; ng_points?: string | null; other_requests?: string | null; additional_conditions?: string | null; pet?: unknown } | null;
  /** お客様の発言（新しい順でも古い順でもよい・中で新しい順に並べ直す） */
  customerMessages?: Array<{ text: string | null; created_at?: string | null }>;
  /** 物件オススメ・ピックアップでスタッフが訴求した点（property_selection_patterns.selling_points） */
  sellingPoints?: string[];
  staffNote?: string | null;
  /** 伏せる名前（お客様の表示名・登録名） */
  maskNames?: Array<string | null | undefined>;
  /** 伏せる関数（pii-mask の maskPII を渡す。テストでは素通し） */
  mask?: (text: string, names?: Array<string | null | undefined>) => string;
};

/** 画像で確かめられる希望の一覧（W1, W2…）。重複（同じ文）は最初の1つだけ */
export function extractImageWants(input: ImageWantsInput, opts?: { maxChat?: number; maxTotal?: number }): ImageWant[] {
  const out: ImageWant[] = [];
  const seen = new Set<string>();
  const norm = (s: string) => s.replace(/[\s　・、。!！?？]/g, "").toLowerCase();
  const push = (source: WantSource, text: string, ng: boolean) => {
    const topics = topicsOf(text);
    if (!topics.length) return;
    const key = norm(text.replace(/\[?必須\]?/g, ""));
    if (!key || seen.has(key)) return;
    seen.add(key);
    const must = /必須|絶対/.test(text);
    out.push({ id: "", source, text: text.slice(0, 60), topics, ng, must });
  };
  const c = input.conditions ?? null;
  if (c) {
    for (const s of splitClauses(String(c.preferences ?? ""))) push("条件", s, false);
    for (const s of splitClauses(String(c.other_requests ?? ""))) push("条件", s, false);
    for (const s of splitClauses(String(c.additional_conditions ?? ""))) push("条件", s, false);
    for (const s of splitClauses(String(c.ng_points ?? ""))) push("条件", s, true);
  }
  const mask = input.mask ?? ((t: string) => t);
  const msgs = (input.customerMessages ?? []).filter((m) => m.text && !PASTE_RE.test(m.text))
    .slice().sort((a, z) => String(z.created_at ?? "").localeCompare(String(a.created_at ?? "")));
  let chat = 0;
  for (const m of msgs) {
    const isForm = FORM_LINE_RE.test(m.text as string);
    for (const s of splitSentences(m.text as string)) {
      if (chat >= (opts?.maxChat ?? 8)) break;
      if (!isForm && !DESIRE_RE.test(s)) continue;
      const before = out.length;
      const ng = /嫌|いや|NG|ng|いらない|要らない|不要|避けたい|小さ|狭/.test(s) && !/広め|余裕/.test(s) ? true : false;
      push("会話", mask(s, input.maskNames), ng);
      if (out.length > before) chat++;
    }
  }
  const sp = new Map<string, number>();
  for (const p of input.sellingPoints ?? []) if (p) sp.set(p, (sp.get(p) ?? 0) + 1);
  for (const [p] of [...sp.entries()].sort((a, z) => z[1] - a[1])) push("訴求", p, false);
  if (input.staffNote) for (const s of splitClauses(input.staffNote)) push("メモ", s, false);
  return out.slice(0, opts?.maxTotal ?? 16).map((w, i) => ({ ...w, id: `W${i + 1}` }));
}

/** DeepSeek に渡す希望の一覧（番号・出どころ・NG/必須の印） */
export function wantsToText(wants: ImageWant[]): string {
  if (!wants.length) return "";
  return wants.map((w) => `${w.id}【${w.source}${w.ng ? "・NG" : ""}${w.must ? "・必須" : ""}】${w.text}`).join("\n");
}

export type WantCheck = { id: string; result: "ok" | "ng" | "unknown"; why: string };

/**
 * 点（0〜100）を決定論で出す: 判定できた項目（ok/ng）のうち ok の割合。NG・必須の項目は2倍の重み。
 * 必須（または NG 条件）に ng が1つでもあれば 20 点を上限にする。判定できた項目が無ければ null
 * （モデルの「match」は揺れるので使わない。2026-09-24 YUMA で同じ画像の点が 50→75 と揺れた）
 */
export function scoreChecks(wants: ImageWant[], checks: WantCheck[]): number | null {
  return scoreChecksDetail(wants, checks).score;
}

/**
 * 点の内訳。raw は上限をかける前の点（必須 NG で全件が 20 点に並んだ時の順位付けに使う。
 * 2026-09-24 YUMA: 3件とも「ペット相談」で 20 点に並び、同点を順位で決めて一番合わない物件が「一番」になった）
 */
export function scoreChecksDetail(wants: ImageWant[], checks: WantCheck[]): { score: number | null; raw: number | null; mustFail: boolean } {
  const byId = new Map(wants.map((w) => [w.id, w]));
  let ok = 0, total = 0, mustFail = false;
  for (const c of checks) {
    const w = byId.get(c.id);
    if (!w || c.result === "unknown") continue;
    const weight = w.ng || w.must ? 2 : 1;
    total += weight;
    if (c.result === "ok") ok += weight;
    else if (w.must || (w.ng && w.source === "条件")) mustFail = true;
  }
  if (total === 0) return { score: null, raw: null, mustFail: false };
  const s = Math.round((ok / total) * 100);
  return { score: mustFail ? Math.min(20, s) : s, raw: s, mustFail };
}

// ── 同じ話題の希望をまとめる／画像で分析を勧めるか ─────────────────────────────────
// 2026-09-24 竹内「画像で分析が推奨される条件のお客さん（WIC 等）は画像読み取りを推奨なので、画像読み取りボタンをだすかたちとする」
//   実例（2026-09-24）: 希望が W1 条件「ペット可の物件があれば」・W2 会話「もしあればペット可の物件」・W3 訴求「ペット可」で
//   同じ事が3重に数えられ、資料の「ペット相談」のアイコン1つで 100 点になっていた（10件中9件は文字抜けで未判定）。
//   → 「同じ設備・同じ向き（NG か）」の希望は1つにまとめる。話題（topics）は粗い（水回りにバストイレ別も独立洗面も入る）ので、
//     まとめる鍵は下の細かい設備（FEATURES）。どの設備にも当たらない希望はまとめない（誤って消さない側）。

/** 希望の細かい設備。strong = 画像（間取り図）で確かめるのが確実な物（表の文字だけでは分からない事が多い） */
export const WANT_FEATURES: Array<{ key: string; label: string; re: RegExp; strong: boolean }> = [
  // シューズ用（SIC・シューズWIC）は WIC に数えない（設計知見「WIC はシューズ用を分ける」）
  { key: "wic", label: "WIC", re: /(?<!シューズ\s*)(?:WIC|W\.I\.C|ウォークイン|ｳｫｰｸｲﾝ|ウォークスルー|WCL)/i, strong: true },
  { key: "shoes_ic", label: "シューズWIC", re: /シューズ\s*(?:WIC|ウォークイン|ｸﾛｰｸ|クローク)|(?<![A-Za-z])SIC(?![A-Za-z])|シューズクローク/i, strong: false },
  { key: "storage", label: "収納", re: /収納|クローゼット|クロゼット|納戸|押入|物置/, strong: true },
  { key: "counter_kitchen", label: "対面キッチン", re: /対面|カウンターキッチン|カウンター式/, strong: true },
  { key: "separate_kitchen", label: "独立キッチン", re: /独立(?:した)?キッチン|キッチン(?:が|は)?(?:独立|分かれ|別)/, strong: true },
  { key: "burners", label: "コンロ口数", re: /[2二3三]口/, strong: false },
  { key: "bath_toilet", label: "バストイレ別", re: /バス.?トイレ|風呂.?トイレ|トイレ.?別|[3三]点ユニット/, strong: true },
  { key: "washbasin", label: "独立洗面", re: /独立洗面|洗面台|洗面所|脱衣/, strong: true },
  { key: "laundry_in", label: "室内洗濯機置場", re: /洗濯機/, strong: true },
  { key: "layout", label: "部屋の配置", re: /寝室|書斎|続き間|仕切|分けたい|分かれ|別々|生活空間|部屋の配置|独立した(?:部屋|洋室)|リビングと/, strong: true },
  { key: "pet", label: "ペット", re: /ペット|犬|猫|ねこ|いぬ/, strong: false },
  { key: "autolock", label: "オートロック", re: /オートロック/, strong: false },
  { key: "net_free", label: "ネット無料", re: /ネット(?:使用料)?(?:無料|不要)|インターネット(?:無料|込)|Wi-?Fi無料/i, strong: false },
  { key: "delivery_box", label: "宅配ボックス", re: /宅配/, strong: false },
  { key: "sunlight", label: "日当たり・向き", re: /日当たり|日あたり|[南東西北]向き|採光/, strong: false },
  { key: "corner", label: "角部屋", re: /角部屋/, strong: false },
  { key: "floor2", label: "2階以上", re: /[2２二]階以上|1階(?:は|が)?(?:NG|嫌|不可|避け|以外)|高層|上の階/, strong: false },
  { key: "loft", label: "ロフト", re: /ロフト/, strong: false },
  { key: "balcony", label: "バルコニー", re: /バルコニー|ベランダ/, strong: false },
];

/** 希望の文に当たる細かい設備（キーの並び） */
export function wantFeatures(text: string): string[] {
  return WANT_FEATURES.filter((f) => f.re.test(text)).map((f) => f.key);
}

const SOURCE_PRIORITY: Record<WantSource, number> = { "条件": 0, "会話": 1, "訴求": 2, "メモ": 3 };

/**
 * 同じ設備・同じ向き（ng）の希望を1つにまとめる。代表は出どころ「条件＞会話＞訴求＞メモ」の順、must は OR。
 * 設備が1つも当たらない希望はまとめない。番号（W1…）は振り直す
 */
export function dedupeWantsByTopic(wants: ImageWant[]): ImageWant[] {
  const out: ImageWant[] = [];
  const byKey = new Map<string, number>();
  const order = wants.map((w, i) => ({ w, i })).sort((a, z) => (SOURCE_PRIORITY[a.w.source] - SOURCE_PRIORITY[z.w.source]) || (a.i - z.i));
  const kept: Array<{ w: ImageWant; i: number }> = [];
  for (const { w, i } of order) {
    const f = wantFeatures(w.text);
    const key = f.length ? `${f.slice().sort().join("+")}|${w.ng ? "ng" : "ok"}` : "";
    if (key && byKey.has(key)) {
      const k = kept[byKey.get(key) as number];
      if (w.must && !k.w.must) k.w = { ...k.w, must: true };
      continue;
    }
    if (key) byKey.set(key, kept.length);
    kept.push({ w: { ...w }, i });
  }
  // 元の並び（条件 → 会話 → 訴求 の出てきた順）に戻して番号を振り直す
  for (const k of kept.sort((a, z) => a.i - z.i)) out.push(k.w);
  return out.map((w, i) => ({ ...w, id: `W${i + 1}` }));
}

export type ImageAnalysisNeed = { level: "recommended" | "optional" | "none"; topics: string[]; labels: string[] };

/**
 * 画像で分析を勧めるか（決定論・DeepSeek は呼ばない）。
 *   recommended: 画像（間取り図）で確かめるのが確実な希望（WIC・収納・対面/独立キッチン・バストイレ別・独立洗面・室内洗濯機置場・部屋の配置）が1つ以上
 *   optional:    ペット・設備・日当たり・階など、資料の文字やアイコンで分かる事が多い希望だけ
 *   none:        希望なし
 */
export function imageAnalysisNeed(wants: ImageWant[]): ImageAnalysisNeed {
  if (!wants.length) return { level: "none", topics: [], labels: [] };
  const labels: string[] = [];
  const topics = new Set<string>();
  for (const w of wants) {
    for (const key of wantFeatures(w.text)) {
      const f = WANT_FEATURES.find((x) => x.key === key);
      if (!f?.strong) continue;
      // 「収納」は WIC と重なる時は WIC だけ出す
      if (key === "storage" && wantFeatures(w.text).includes("wic")) continue;
      const label = key === "layout" ? layoutLabel(w.text) : f.label;
      if (!labels.includes(label)) labels.push(label);
      for (const t of w.topics) topics.add(t);
    }
  }
  return labels.length ? { level: "recommended", topics: [...topics], labels: labels.slice(0, 4) } : { level: "optional", topics: [], labels: [] };
}

/** 部屋の配置の希望は短い言葉にする（「リビングと寝室兼書斎の生活空間を分けたい」→「リビングと寝室を分けたい」は作らず、先頭を短く切る） */
function layoutLabel(text: string): string {
  const s = text.replace(/\s+/g, "").replace(/[。、]$/, "");
  return s.length <= 14 ? s : `${s.slice(0, 13)}…`;
}
