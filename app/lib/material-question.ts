// material-question.ts — お客様の質問が「物件資料に書いてある事」（間取り・水回りの配置・広さ・階・向き・収納・キッチン）かの網と、
//   物件検索ブレインの読み取り（property_sheet_facts・image_details・売上サポの行・その場の間取り図の読み）を材料の文にする（純関数・DB/LLM なし）
//
// 2026-10-14 竹内さん（区切り3）「物件資料に書いてある事を聞かれたら、資料を物件検索ブレイン（AIX ツールの所）で解析して答える」
//   実物 055d4212（会話 22b2511e・10/09 20:21）: 「ここって洗面台とトイレ一緒な感じですか？」← 直前に送ったエステムコート難波IVアトリ（画像だけ）
//     竹内さんの実送信「こちらのお部屋ですが洗面台とトイレが同じ間取りであるアメリカンセパレートの間取りとなります！！」（間取り図を見て即答）
//     下書きは「洗面台とトイレの配置確認させて頂きます」（確認の約束）＝材料が届いていない（設備の網 equipment-question は水回りの『配置』を拾わない・
//     送った資料の読み取り image_details は「洗面台（独立）・バス・トイレ別」までで、洗面台がトイレと同じ空間かは図を見ないと分からない）
// 決まり（P0 9eb6aa9c ブレイン基準）:
//   ・ここは「候補を拾う網」と「材料の文」だけ。返信で答えるか・確認の約束にするかはブレインが材料を読んで決める（turn_contract の route）
//   ・資料に無い・読めない事は「分からない」と書く＝ブレインは確認の約束（2段）を選べる
//   ・設備の有無（equipment-question）・契約条件（contract-terms）・入居時期（procedure）は今まで通りそれぞれの材料。ここは配置・広さ・階・向き・収納・キッチンの形
// 戻す: MATERIAL_ANSWER=off（材料を作らない）／MATERIAL_ANSWER_READ=off（その場の図の読みだけ止める）

export type MaterialTopic = "water_layout" | "room_layout" | "size" | "floor" | "direction" | "storage" | "kitchen";

export const MATERIAL_TOPIC_LABEL: Record<MaterialTopic, string> = {
  water_layout: "水回りの配置（浴室・トイレ・洗面台）", room_layout: "間取り", size: "広さ（帖・㎡）", floor: "階", direction: "向き・日当たり",
  storage: "収納", kitchen: "キッチンの形",
};

export function materialAnswerEnabled(env: Record<string, string | undefined> = typeof process !== "undefined" ? process.env : {}): boolean {
  return (env.MATERIAL_ANSWER ?? "").toLowerCase() !== "off";
}
export function materialAnswerReadEnabled(env: Record<string, string | undefined> = typeof process !== "undefined" ? process.env : {}): boolean {
  return materialAnswerEnabled(env) && (env.MATERIAL_ANSWER_READ ?? "").toLowerCase() !== "off";
}

const TOPIC_RES: Array<[MaterialTopic, RegExp]> = [
  ["water_layout", /(?:洗面(?:台|所)?|トイレ|お手洗い|お?風呂|浴室|バスルーム|脱衣所).{0,10}(?:一緒|同じ|別|分かれ|わかれ|独立|セパレート|ユニット|配置|並び)|ユニットバス|セパレート|[3３三]点(?:式|ユニット)|バス(?:・|と)?トイレ(?:は|が|って)?(?:別|一緒|同じ)/],
  ["room_layout", /間取り|部屋の(?:形|作り|つくり)|ロフト|何部屋|部屋数|(?:リビング|寝室|洋室|和室).{0,6}(?:別|分かれ|続き|仕切)|仕切り|引き戸/],
  ["size", /何帖|何畳|帖数|畳数|広さ|平米|㎡|何平|専有面積|(?:リビング|洋室|部屋|LDK|DK|キッチン).{0,6}(?:広|狭|帖|畳)/],
  ["floor", /何階|階数|所在階|最上階|(?:[0-9０-９一二三四五六七八九十]+)階(?:です|でしょう|ですか|なん)|上の階|下の階|角部屋/],
  ["direction", /向き|方角|南向|北向|東向|西向|日当たり|陽当たり|日当り/],
  ["storage", /収納|クローゼット|押入|押し入れ|ウォークイン|物置/],
  ["kitchen", /キッチン.{0,6}(?:対面|カウンター|壁|形|広|狭|作業|どんな)|対面キッチン|カウンターキッチン|台所.{0,6}(?:広|狭|どんな)/],
];

const QUESTION_RE = /[?？]|ですか|ますか|でしょうか|ますでしょう|ありますか|あります？|(?:な|の)(?:感じ|ん)(?:です|でしょう)?か|ですよね|ますよね|どう(?:です|なって|でしょう)|どんな|知りたい|教えて(?:ください|下さい|頂け|いただけ|ほしい|欲しい)/;
/** 探す条件・希望の文（「〜な部屋ありますか」「〜がいい」）は質問ではない */
const NOT_Q_RE = /(?:部屋|物件|ところ|とこ|マンション|アパート)(?:で|は|って|が|も)?(?:ありますか|あります？|ない(?:です|でしょう)?か|ありませんか|紹介)|探して|探せ|ピックアップ|がいい|が良い|希望|なくても|でも(?:いい|良い|大丈夫)|条件/;
const CONDITION_FORM_RE = /【ご希望|ご希望のお部屋|お部屋お探し中|①【|⑧【/;

export type MaterialQuestion = { topics: MaterialTopic[]; sentences: string[] };

/** 網（決定論）: 資料に書いてある事の質問の候補。当たらなければ null（材料も作らない） */
export function detectMaterialQuestion(text: string | null | undefined): MaterialQuestion | null {
  const t = String(text ?? "");
  if (!t.trim() || CONDITION_FORM_RE.test(t)) return null;
  const topics = new Set<MaterialTopic>();
  const sentences: string[] = [];
  // 連投は通（MSG_SEP の U+2063）ごとに見る。画像の通（お客様が送ったポータルの画面の書き起こし＝「間取り図」「収納」の語が並ぶ）は丸ごと外す
  const units = t.split("\u2063").map((u) => u.trim()).filter((u) => u && !/^\[(?:画像|動画|スタンプ|ファイル)\]/.test(u));
  for (const s of units.join("\n").normalize("NFKC").split(/(?<=[。！!？?\n])/).map((x) => x.trim()).filter(Boolean)) {
    if (/^\s*\[(?:画像|動画|スタンプ|ファイル)\]/.test(s)) continue;
    if (!QUESTION_RE.test(s) || NOT_Q_RE.test(s)) continue;
    const hit = TOPIC_RES.filter(([, re]) => re.test(s)).map(([k]) => k);
    if (!hit.length) continue;
    hit.forEach((h) => topics.add(h));
    sentences.push(s);
  }
  return topics.size ? { topics: [...topics], sentences } : null;
}

/** 図を見ないと分からない話題（その場の間取り図の読みを掛ける候補） */
export const PLAN_READ_TOPICS: ReadonlySet<MaterialTopic> = new Set(["water_layout", "room_layout", "size", "storage", "kitchen"]);

// ── その場の間取り図の読み（material-answer-server が DeepSeek に渡す・保存して使い回す） ─────────────────
// 2026-10-14 キッチンの形（壁付け・対面・独立）と向きは、図・資料に字で書いてある時だけ（設計知見 1e9fb6be・aa5280ce: 図の形から「対面キッチン」と推し量って誤った）。
//   水回りの配置は竹内さんの決定どおり図の囲みから読んでよい。版を上げて保存済みの読み（v3）は読み直す。戻す MATERIAL_PLAN_TEXT_ONLY=off（v3 の指示）
const MATERIAL_PLAN_TEXT_ONLY = (typeof process === "undefined" ? "" : (process.env.MATERIAL_PLAN_TEXT_ONLY ?? "")).trim().toLowerCase() !== "off";
export const MATERIAL_PLAN_PROMPT_VERSION = MATERIAL_PLAN_TEXT_ONLY ? "material-plan-v4" : "material-plan-v3";
export const MATERIAL_PLAN_MAX_TOKENS = 500;
export const MATERIAL_PLAN_PROMPT = `あなたは日本の賃貸物件の資料（マイソク・間取り図）を読む係です。日本の不動産資料を日本語の漢字（日本の字形・新字体）で書き写してください（中国の字形は使わない）。
次の JSON 1つだけで返してください（説明文・コードブロック不要）。図や文字から分からない項目は "不明"（数は null）。推測で埋めないこと。
水回りは間取り図の部屋の囲みで決める: 便器の記号と洗面台の記号が同じ囲み（パウダールーム・サニタリー・洗面室）の中なら washbasin は "トイレと同じ空間"（アメリカンセパレート）。
浴室（バスルーム・UB）が別の囲みなら bath_toilet は "別"。設備欄の「洗面台（独立）」は浴室と別という意味で使われる事があるので、図の囲みを優先する。
${MATERIAL_PLAN_TEXT_ONLY ? `kitchen と direction は、資料に字で書いてある時だけ書く（「対面キッチン」「カウンターキッチン」「壁付けキッチン」「独立キッチン」「南向き」「向き: 南」「バルコニー: 南」等）。図の形・コンロの位置・方位記号の向きから推し量らない。字が無ければ "不明"。
` : ""}{"bath_toilet":"別|同室|不明","washbasin":"独立した洗面所|脱衣所|浴室内|トイレと同じ空間|不明","laundry":"室内|屋外|不明","madori":"1K 等","rooms":[{"name":"洋室","jo":6.0}],"kitchen":"壁付け|対面|独立|不明","storage":"クローゼット等の記載（無ければ空）","balcony":"あり|なし|不明","floor":null,"direction":"南 等|不明","note":"図で読めた水回りの並び（例: トイレと洗面台が同じ空間・浴室は別）を30字まで"}`;

export type MaterialPlanRead = {
  bath_toilet: "別" | "同室" | "不明";
  washbasin: "独立した洗面所" | "脱衣所" | "浴室内" | "トイレと同じ空間" | "不明";
  laundry: "室内" | "屋外" | "不明";
  madori: string; rooms: Array<{ name: string; jo: number | null }>;
  kitchen: "壁付け" | "対面" | "独立" | "不明"; storage: string; balcony: "あり" | "なし" | "不明";
  floor: number | null; direction: string; note: string;
};

const pick = <T extends string>(v: unknown, allowed: readonly T[], d: T): T => { const s = String(v ?? "").trim(); return (allowed as readonly string[]).includes(s) ? (s as T) : d; };

export function parseMaterialPlanRead(text: string, fix: (s: string) => string = (s) => s): MaterialPlanRead | null {
  const m = String(text ?? "").match(/\{[\s\S]*\}/);
  if (!m) return null;
  let o: Record<string, unknown>;
  try { o = JSON.parse(m[0]) as Record<string, unknown>; } catch { return null; }
  const str = (v: unknown, n: number) => fix(String(v ?? "").trim()).slice(0, n);
  const rooms = Array.isArray(o.rooms) ? (o.rooms as Array<Record<string, unknown>>).slice(0, 8).map((r) => ({ name: str(r?.name, 12), jo: typeof r?.jo === "number" && r.jo > 1 && r.jo < 60 ? r.jo : null })).filter((r) => r.name) : [];
  const floor = typeof o.floor === "number" && o.floor >= 1 && o.floor <= 80 ? Math.round(o.floor) : null;
  const out: MaterialPlanRead = {
    bath_toilet: pick(o.bath_toilet, ["別", "同室", "不明"] as const, "不明"),
    washbasin: pick(o.washbasin, ["独立した洗面所", "脱衣所", "浴室内", "トイレと同じ空間", "不明"] as const, "不明"),
    laundry: pick(o.laundry, ["室内", "屋外", "不明"] as const, "不明"),
    madori: str(o.madori, 12), rooms,
    kitchen: pick(o.kitchen, ["壁付け", "対面", "独立", "不明"] as const, "不明"),
    storage: str(o.storage, 40), balcony: pick(o.balcony, ["あり", "なし", "不明"] as const, "不明"),
    floor, direction: str(o.direction, 6) === "不明" ? "" : str(o.direction, 6), note: str(o.note, 40),
  };
  const known = out.bath_toilet !== "不明" || out.washbasin !== "不明" || !!out.madori || rooms.length > 0 || out.kitchen !== "不明";
  return known ? out : null;
}

/** 間取り図の読みを文の行に（「不明」は書かない） */
export function planReadLines(r: MaterialPlanRead): string[] {
  const L: string[] = [];
  const water: string[] = [];
  if (r.bath_toilet === "別") water.push("浴室とトイレは別");
  if (r.bath_toilet === "同室") water.push("浴室とトイレは同じ空間（3点ユニット）");
  if (r.washbasin === "トイレと同じ空間") water.push("洗面台はトイレと同じ空間（アメリカンセパレート）");
  else if (r.washbasin === "浴室内") water.push("洗面台は浴室の中");
  else if (r.washbasin === "脱衣所") water.push("洗面台は脱衣所");
  else if (r.washbasin === "独立した洗面所") water.push("洗面所は独立");
  if (r.laundry !== "不明") water.push(`洗濯機置場は${r.laundry}`);
  if (water.length) L.push(`水回り: ${water.join("・")}`);
  if (r.note) L.push(`図の読み: ${r.note}`);
  const lay: string[] = [];
  if (r.madori) lay.push(r.madori);
  const rooms = r.rooms.filter((x) => x.jo != null).map((x) => `${x.name}${x.jo}帖`);
  if (rooms.length) lay.push(rooms.join("・"));
  if (r.kitchen !== "不明") lay.push(`キッチン${r.kitchen}`);
  if (lay.length) L.push(`間取り: ${lay.join("・")}`);
  if (r.storage) L.push(`収納: ${r.storage}`);
  if (r.balcony !== "不明") L.push(`バルコニー: ${r.balcony}`);
  // 階は図から読まない（建物の階数「地上13階」を部屋の階と読んだ・055d4212／Alivis新町 8階→9階）＝資料の書き写しの「所在階」を使う
  if (r.direction) L.push(`向き: ${r.direction}`);
  return L;
}

export type MaterialPropertyFacts = {
  name: string; roomNo: string | null; by: string;
  /** 資料の文字（送った資料の書き写し image_details.lines・売上サポの行の設備欄など） */
  textLines: string[];
  /** 図の読み（保存した読み・その場の読み） */
  planLines: string[];
  sources: string[];
};

/** 材料の文（ブレイン・返信の生成に同じ物を渡す） */
export function buildMaterialAnswerNote(q: MaterialQuestion, props: ReadonlyArray<MaterialPropertyFacts>): string {
  if (!props.length) return "";
  const L: string[] = [];
  L.push(`【📄 お客様が聞いた事の物件資料の読み取り（物件検索ブレインの読み取り・聞かれた事: ${q.topics.map((t) => MATERIAL_TOPIC_LABEL[t]).join("・")}）】`);
  for (const p of props) {
    L.push(`▶ ${p.name}${p.roomNo ? ` ${p.roomNo}` : ""}（${p.by}）`);
    const lines = [...p.planLines, ...p.textLines].filter(Boolean);
    if (!lines.length) { L.push("  ・資料の読み取りなし（この物件の資料からは分からない）"); continue; }
    for (const l of lines.slice(0, 14)) L.push(`  ・${l}`);
  }
  L.push("決まり: お客様が聞いた事が上の読み取りに書いてあれば、確認の約束にせず返信の本文で資料のとおりに答える（言い切るのは書いてある事だけ・言い方は竹内さんの実送信の形「こちらのお部屋ですが〜となります！！」）。");
  L.push("上に無い・「分からない」の時は「確認させて頂きます」の約束にする（結果は AIX）。設備の有無の言い切り（コンロ等）・空き・入居日・金額は別の決まりのまま。");
  return L.join("\n");
}
