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

function clean(s: string): string {
  return s.replace(/\s+/g, " ").replace(/^[・\-－\s①-⑳0-9０-９.．、,)）]+/, "").trim();
}

/** 条件欄の文を句に割る（「、」「・」「／」「改行」「。」） */
function splitClauses(s: string): string[] {
  return String(s ?? "").split(/[\n。、,，／/]|・(?=[^・]{2,})/).map(clean).filter((x) => x.length >= 2 && x.length <= 60);
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
