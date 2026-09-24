// app/lib/sheet-prompt.ts（純関数・依存なし）
// 「🔍 画像で分析」で DeepSeek に渡す固定の前置き（型ごと）と、返事の読み方。
//
// 2026-09-24 竹内「2つの型を使ってプロンプトキャッシュを効かせる（型ごとの固定の前置き＝どこに何があるかの説明＋見本。先頭に置き、毎回同じにする）」
//
// 実測（2026-09-24・deepseek-flash・llm_usage_logs action=pickup_image_analysis_exp の16回）:
//   - DeepSeek の前置きキャッシュ（64トークン単位）は先頭の文だけでなく画像の中身まで効く。後ろの物件画像だけ変えても先頭一致で命中した
//   - 型に関係なく同じ部分（役割・返す形・間違えやすい所）を最初に置き、型ごとの説明を後ろに置くと、リアプロと itandi で共通部分を共有できる
//     （決まりの文を途中に足すと命中はその手前までに縮んだ）→ COMMON_HEAD → 型の説明 → 画像 の順。**並べ替えない・日時やお客様ごとの値を入れない**
//   - 見本は画像にしない（見本画像はキャッシュに乗るが読みの質は上がらず、推論が増えた 4.0〜4.8k）。
//     誤りを直したのは「間違えやすい所」の決まり3行と、先に根拠を40字以内で書かせる see 欄だった（itandi の壁付けキッチンを「対面」と誤る→直った）
//   - 推論は切る（thinking disabled）: 1件 約0.02円・1.1〜1.6秒（推論 low は 0.35〜0.6円・18〜32秒で質も上がらなかった。
//     low は居室2つの図を「単室」と誤った）。推論あり／なしで送る形が変わり先頭から一致しないので、どちらかに固定する
//   - 希望（お客様ごと）はここに入れない: 画像から読むのは物件の事実だけ（物件ごとに保存して使い回す）。希望との照合は文字だけで行う
//   - 帖数・図の中の㎡は読ませる（2026-09-24 以前は「数字は書かせない」だったが、今回はお客様向けの文ではなく
//     「読んだ図がこの部屋の物か」を文字層と突き合わせる材料にする。本文・画面の点には使わない）
import type { CropMode } from "./sheet-layout";

/** 前置きを変えたら上げる（保存した読み取りを使い回すかの鍵にも使う） */
export const SHEET_PROMPT_VERSION = "sheet-v8";
/** 推論なしの出力は実測 120〜171 トークン。崩れた時の読み直し（推論 low）だけ大きく取る */
export const SHEET_READ_MAX_TOKENS = 600;
export const SHEET_RETRY_MAX_TOKENS = 12000;

/** 型に関係なく同じ部分（先頭・キャッシュを型の間で共有する） */
export const SHEET_COMMON_HEAD = `あなたは賃貸物件の資料（マイソク）の画像を読む係です。画像に見える事実だけを、次の JSON 1つで返してください（説明文・コードブロック不要）。
{"see":"","fp_ok":true,"other_unit":false,"madori":"","rooms":[{"name":"","jo":null}],"area_sqm":null,"type_label":"","kitchen":{"placement":"不明","stove":"不明","burners":null},"water":{"bath_toilet":"不明","washbasin":"不明","laundry":"不明"},"living_bedroom":"不明","storage":{"wic":"不明","labels":[],"closets":null,"shoes":"不明"},"balcony":"不明","note":""}
- see: 先に、どこを見て判断したかを40字以内で書く（例「中央の間取り図。玄関→廊下→洋室、キッチンは廊下の壁沿い」）
- fp_ok: 画像の中に間取り図があり、読めたら true。写真・外観・地図だけ／「画像情報なし」／小さくて読めない時は false
- other_unit: 間取り図に別の部屋番号・別の物件名・複数の間取り（A・B タイプを並べた図）がある時は true
- madori: 間取り図から「1R」「1K」「1DK」「1LDK」「2LDK」の形で（S・納戸は書かない）。分からなければ ""
- rooms: 居室・納戸と LDK/DK/K の名前と帖数（図に「洋6.1」「LDK11.9帖」「≒6.0J」「納戸2.4帖」とあれば jo に数）。帖数が見えなければ jo は null
- area_sqm: 図の中に面積（例「Cタイプ 68.84㎡」）が書いてあれば数。無ければ null ／ type_label: 図の中のタイプ名（例「Cタイプ」）。無ければ ""
- kitchen.placement: "対面"（シンクの前がリビング側を向く・カウンター）／"壁付け"（壁や廊下に沿う）／"独立"（扉で仕切られた台所）／"不明"
- kitchen.stove: "IH"／"ガス"／"不明"。burners: 口数（図や記号で分かる時だけ・無ければ null）
- water.bath_toilet: "別"（浴室とトイレが別の部屋）／"同室"（3点ユニット・同じ部屋）／"不明"
- water.washbasin: "独立"（浴室の外に洗面台）／"浴室内"／"不明" ／ water.laundry: "室内"／"屋外"（バルコニー等）／"不明"（洗濯機の記号）
- living_bedroom: 居室どうし・LDK と洋室の関係。"単室"（居室が1つだけ）／"隣接"（壁や扉で隣り合う）／"続き間"（引き戸で続く）／"廊下を挟む"／"不明"
- storage.wic: "あり"（WIC・W.I.C・WCL・ウォークイン・納戸）／"なし"／"不明"。シューズ用（SIC・シューズWIC）は wic に入れず shoes に。labels・closets: 下の決まり
- storage.shoes: シューズボックス・下足入・SIC が "あり"／"なし"／"不明" ／ balcony: "あり"／"なし"／"不明"
間違えやすい所（必ず守る）:
- 「対面」は、シンクの前（作業する人の向こう側）が LDK の居間側に開いている時だけ。廊下や壁に沿って置かれていれば「壁付け」。迷えば「不明」
- 居室が壁で接していても、洋室の扉が廊下側にあれば「廊下を挟む」。扉が LDK 側に開いていれば「隣接」、引き戸で LDK と続けば「続き間」
- LDK/DK と洋室の間の仕切りに引き戸（壁の切れ目に細い線が並ぶ）や扉の弧があれば、その洋室は LDK/DK とつながっている（「廊下を挟む」にしない）
- 居室が2つ以上見えるのに「単室」にしない。LDK/DK/K 以外の居室（洋室・和室・Bedroom・ROOM）が1つだけなら「単室」
- 1K・1R の廊下や玄関横の小さなキッチン（流しとコンロの記号・「K」）は「壁付け」。LDK の中でも、流しとコンロが部屋の端の壁に沿って並び、
  居間との間にカウンター・腰壁の線が無ければ「壁付け」
- キッチンが居室と壁・扉で仕切られず同じ部屋の中にあれば madori は「1R」（廊下・扉で分かれていれば「1K」）
- 浴槽と便器が1つの四角の中にある（「浴室WC」「浴室・WC」と1つの部屋に続けて書く）のは3点ユニット＝bath_toilet「同室」・washbasin「浴室内」。
  パウダールーム・洗面所に便器と洗面台があっても、浴槽（UB・浴室・Bath）が線で仕切られた別の四角なら bath_toilet「別」・washbasin「独立」
- storage.labels: 収納の区画に書かれた字を、区画1つにつき1つ、図のとおりに全部書く（例 ["CL","物入","WIC","下足入","MB"]）。
  Closet・Storage・クローゼット・物入・押入・収・WIC・下駄箱・MB・PS も書く。同じ区画の中の「ハンガーパイプ」「棚」は別に書かない。無ければ []
- storage.closets: labels のうち下駄箱（SB・SCL・Shoes・シューズ・下足入）・MB・PS を除いた数（WIC も1つ）
- 窓の外の細長い区画（バルコニー・ベランダ・バル）は balcony「あり」。そこに「洗」の四角があれば laundry「屋外」
- 見えない・書いていない事は必ず「不明」か null（推測で埋めない）
`;

/** 型ごとの説明（どこに何があるか）。キーは切り出しの形 */
export const SHEET_TYPE_SECTIONS: Record<"realpro_floor" | "itandi_area" | "itandi_pdf" | "page", string> = {
  realpro_floor: `この画像は「リアプロ（RealNetPro）の資料」の中央にある間取り図だけを切り出した物です。
- 資料は横長で、左に表・右上に外観と室内写真・中央に間取り図・右に地図・下に特記事項がある形。この画像はそのうち間取り図の枠だけ
- 枠の端に隣の地図・写真・表の線が1〜2px 入る事がある（読まない）
- 間取り図の中の「洋」「LD」「K」の横の数が帖数。「≒6.1J」「6.1帖」も帖数
画像:`,
  // 2026-09-25: 画像1＝左上の枠だけ（画素で罫線を見つけた範囲）、画像2＝上の帯と右の表を縦に並べた物（sheet-layout.planSheetCrop）
  itandi_area: `この資料は「itandi の資料」の画像です。画像は2枚あります。
- 画像1: 資料の左上の枠（多くは間取り図。外観写真・「画像情報なし」の事もある）。枠が見つからない資料では左側の写真の範囲全体
- 画像2: 上に資料の一番上の帯（物件名と「〇〇 号室」）、その下に右側の表（所在地・賃料・間取り・専有面積・設備・備考）
- 間取りの項目（fp_ok・madori・rooms・kitchen・water・living_bedroom・storage・balcony）は画像1の間取り図で答える。室内写真・外観は使わない
- 画像1に間取り図が無ければ fp_ok=false にし、間取りの項目は「不明」か null
- 帖数は図の数字をそのまま写す（6.3 を 6 に丸めない・「≒6.2J」「6.2帖」「洋8」も帖数・読めなければ null）。種類の書いていない居室は name「居室」
- water.bath_toilet は図を先に見る。浴室と WC・トイレが線で仕切られた別々の四角なら、隣り合っていても "別"（この時だけは設備欄より図を優先）。
  図で分からない時は設備欄で決める（「バス・トイレ別」→"別"、「3点ユニット」「バス・トイレ一緒」→"同室"）
- water.washbasin: 浴室の外に洗面台・「洗面」の区画があれば "独立"。洗面台が浴室と同じ四角の中・または浴室の外に洗面台が見当たらなければ "浴室内"。
  図で分からなければ設備欄の「独立洗面台」「洗髪洗面化粧台」「シャンプードレッサー」で "独立"
  見本: 「玄関→K→洋室。浴室と WC は別の四角で、洗面台の記号・洗面の区画はどこにも無い」→ bath_toilet 別・washbasin 浴室内 ／
  「和室2つと K・トイレだけで浴室が無い」→ bath_toilet 不明・washbasin 浴室内（浴室の外に洗面台が無い）
- water.laundry: 図の「洗」「洗濯機」の四角が室内にあれば "室内"。図に無ければ設備欄の「室内洗濯機置場」で "室内"
- balcony: 図にバルコニー・ベランダの区画があるか、設備欄に「バルコニー」があれば "あり"
- storage.wic: 図の「WIC」「W.I.C」「ウォークイン」の字、または設備欄の「ウォークインクローゼット」で "あり"。どちらにも無く間取り図が読めたら "なし"（納戸・S・シューズインクローゼットは WIC に数えない）
- 洋室が2つ以上の時: LDK/DK と扉・引き戸で直接つながる洋室が1つでもあれば living_bedroom は "隣接"（全部の洋室が廊下・ホールから入る時だけ "廊下を挟む"）
  見本: 「DK の下に洋室。間の仕切りが引き戸」→ 隣接 ／ 「LDK の右の洋室6帖は引き戸で LDK に開き、洋室4.5帖は廊下から入る」→ 隣接 ／
  「洋室2つはどちらもホールから入り、LDK とは壁だけで接する」→ 廊下を挟む
- kitchen: 設備欄に「カウンターキッチン」「対面キッチン」があれば、図のキッチンの前（作業する人の向こう側）が LDK の居間側に開いていないかよく確かめる
- この型では JSON の最後に次の2つも入れる:
  "band":{"name":"","room":""} … 画像2の一番上の帯の物件名と号室。「サンキライフ白遙 207 号室」→ name「サンキライフ白遙」・room「207」。
  name には号室の番号・「複数あり」・「号室」を入れない。字は帯のとおり1字ずつ写す（「仮称」を「假称」にしない・★・Ⅶ などの記号も写す）
  "table":{"rent":null,"madori":"","sqm":null,"equip":""} … 画像2の表の「賃料」（73,000円 → 73000）・「間取り」欄・「専有面積」の数・「設備」欄の文（そのまま・150字まで）
画像:`,
  // 2026-09-24 夜: itandi の PDF（文字層あり＝物件名・賃料・面積・設備は文字で持っている）。実物 18件で、左上の枠が間取り図でない資料が
  //   3件（外観2・枠の下に小さな絵1）あり、その時の間取り図は2つ目のマスにあった → 画像1＝左上の枠、画像2＝ほかのマスをまとめた物
  itandi_pdf: `この資料は「itandi の資料」の PDF です。画像は1枚か2枚あります。
- 画像1: 資料の左上の枠（多くは間取り図）。画像2（ある時だけ）: その右と下のマス（外観・室内写真・地図。たまに間取り図）
- 間取り図は画像1を先に見る。画像1が外観・室内の写真・空白で間取り図が無ければ、画像2のマスから間取り図を探して答える。どちらにも無ければ fp_ok=false
- 室内写真・外観は間取りの判断に使わない（間取り図だけで答える）。表の文字は読まない（別に文字で持っている）
- 図は小さい事がある。帖数は図の数字をそのまま写す（6.3 を 6 に丸めない・「≒6.2J」「6.2帖」も帖数・読めなければ null）。種類の書いていない居室は name「居室」。英語の図（Bedroom・Kitchen・Bath room・Toilet・Closet・Balcony・Wash）もある
- water.bath_toilet: "同室" は浴槽と便器が仕切りの線の無い1つの四角の中にある時だけ（3点ユニット）。浴室と WC・Toilet が線で仕切られた別々の四角なら、隣り合っていても "別"
- water.washbasin: 浴室の外に洗面台・「洗面」「Wash」の区画があれば "独立"。洗面台が浴室と同じ四角の中にあれば "浴室内"
- water.laundry: 図の「洗」「洗濯機」「W」の四角が室内にあれば "室内"、バルコニーにあれば "屋外"
- storage.wic: 図に「WIC」「W.I.C」「ウォークイン」の字があれば "あり"。無く間取り図が読めたら "なし"（納戸・S・シューズ用は数えない）
- 洋室が2つ以上の時: LDK/DK と扉・引き戸で直接つながる洋室が1つでもあれば living_bedroom は "隣接"（全部の洋室が廊下・ホールから入る時だけ "廊下を挟む"）
画像:`,
  page: `この画像は物件資料の1ページ全体です（型が分からない、または標準の位置に間取り図が無かった資料）。
- 間取り図を探して、その図から答える。表の文字は読まない（別に文字で持っている）
- 間取り図が2つ以上ある・別の部屋番号の図が混ざる時は other_unit=true
画像:`,
};

export function sectionKeyFor(mode: CropMode): keyof typeof SHEET_TYPE_SECTIONS {
  return mode === "floor" ? "realpro_floor" : mode === "image_area" ? "itandi_area" : mode === "itandi_pdf" ? "itandi_pdf" : "page";
}

/** 固定の前置き（共通 → 型ごと）。毎回一字一句同じ */
export function sheetPromptPrefix(mode: CropMode): string {
  return `${SHEET_COMMON_HEAD}\n${SHEET_TYPE_SECTIONS[sectionKeyFor(mode)]}`;
}

/**
 * DeepSeek に渡す content（前置きの文 → 切り出した画像）。画像は data URL か https。
 * extraUrl は2枚目（itandi の右の表）。前置きの後ろに並べる（前置きは型ごとに一字一句同じ＝キャッシュの先頭一致）
 */
export function buildSheetReadContent(mode: CropMode, imageUrl: string, extraUrl?: string | null): Array<Record<string, unknown>> {
  return [
    { type: "text", text: sheetPromptPrefix(mode) },
    { type: "image_url", image_url: { url: imageUrl } },
    ...(extraUrl ? [{ type: "image_url", image_url: { url: extraUrl } }] : []),
  ];
}

// ── 返事 ─────────────────────────────────────────────────────────────
export type Tri = "あり" | "なし" | "不明";
export type SheetImageFacts = {
  see: string;
  fp_ok: boolean;
  other_unit: boolean;
  madori: string;
  rooms: Array<{ name: string; jo: number | null }>;
  area_sqm: number | null;
  type_label: string;
  kitchen: { placement: "対面" | "壁付け" | "独立" | "不明"; stove: "IH" | "ガス" | "不明"; burners: number | null };
  water: { bath_toilet: "別" | "同室" | "不明"; washbasin: "独立" | "浴室内" | "不明"; laundry: "室内" | "屋外" | "不明" };
  living_bedroom: "単室" | "隣接" | "続き間" | "廊下を挟む" | "不明";
  /** labels: 読んだ収納の区画の字（closets は labels から決まった手順で数える・2026-09-25） */
  storage: { wic: Tri; closets: number | null; shoes: Tri; labels?: string[] };
  balcony: Tri;
  note: string;
  /**
   * itandi（画像だけ・文字層が無い）の上の帯と右の表から読んだ物。突き合わせ（物件名・号室・賃料・面積・間取り）と鍵（unit_key）、
   * 設備の文（希望の照合）に使う。リアプロ等は文字層があるので無い（undefined）
   */
  sheet?: { name: string; room: string; rent: number | null; madori: string; sqm: number | null; equip: string } | null;
};

const pick = <T extends string>(v: unknown, allowed: readonly T[], dflt: T): T => {
  const s = String(v ?? "").trim();
  return (allowed as readonly string[]).includes(s) ? (s as T) : dflt;
};
const numOrNull = (v: unknown, min: number, max: number): number | null => {
  if (v == null || v === "") return null;
  // 2026-09-24 反証: 数字以外を全部消してからつなぐと「洋室1 6.1帖」→ 16.1・全角「６．１」→ 空になった。
  //   全角を半角にし、㎡（NFKC で m2）の 2 を外してから、最後の数を取る
  const n = typeof v === "number" ? v : (() => {
    const all = String(v).normalize("NFKC").replace(/m2|m²/gi, "").match(/\d+(?:\.\d+)?/g);
    return all ? parseFloat(all[all.length - 1]) : NaN;
  })();
  return Number.isFinite(n) && n >= min && n <= max ? Math.round(n * 100) / 100 : null;
};
const str = (v: unknown, max = 80) => String(v ?? "").replace(/\s+/g, " ").trim().slice(0, max);

/** 返事の JSON を読む。崩れた返事・選択肢に無い値は「不明」に倒す。JSON が無ければ null */
export function parseSheetImageFacts(text: string): SheetImageFacts | null {
  const raw = String(text ?? "").trim();
  const block = raw.match(/```(?:json)?\s*([\s\S]*?)\s*```/);
  const body = (block ? block[1] : raw).trim();
  const jsonStr = body.startsWith("{") ? body : (body.match(/\{[\s\S]*\}/)?.[0] ?? "");
  if (!jsonStr) return null;
  let o: Record<string, unknown>;
  try { o = JSON.parse(jsonStr) as Record<string, unknown>; } catch { return null; }
  if (!o || typeof o !== "object") return null;
  const k = (o.kitchen ?? {}) as Record<string, unknown>;
  const w = (o.water ?? {}) as Record<string, unknown>;
  const s = (o.storage ?? {}) as Record<string, unknown>;
  const madori = normMadori(o.madori);
  const b = (o.band ?? null) as Record<string, unknown> | null;
  const tb = (o.table ?? null) as Record<string, unknown> | null;
  const sheet = b || tb ? {
    name: str(b?.name, 60),
    // 号室は数字（全角も）だけ。「複数あり」等は空
    room: (String(b?.room ?? "").normalize("NFKC").match(/\d{1,5}/) ?? [""])[0],
    rent: yenOrNull(tb?.rent),
    madori: normMadori(tb?.madori),
    sqm: numOrNull(tb?.sqm, 5, 400),
    equip: str(tb?.equip, 200),
  } : null;
  const rooms = (Array.isArray(o.rooms) ? o.rooms : []).slice(0, 8).map((r) => {
    const rr = (r ?? {}) as Record<string, unknown>;
    return { name: str(rr.name, 12), jo: numOrNull(rr.jo, 1, 60) };
  }).filter((r) => r.name || r.jo != null);
  const out: SheetImageFacts = {
    see: str(o.see, 80),
    fp_ok: o.fp_ok === true || o.fp_ok === "true",
    other_unit: o.other_unit === true || o.other_unit === "true",
    madori,
    rooms,
    area_sqm: numOrNull(o.area_sqm, 5, 400),
    type_label: str(o.type_label, 20),
    kitchen: {
      placement: pick(k.placement, ["対面", "壁付け", "独立", "不明"] as const, "不明"),
      stove: pick(k.stove, ["IH", "ガス", "不明"] as const, "不明"),
      burners: numOrNull(k.burners, 1, 5),
    },
    water: {
      bath_toilet: pick(w.bath_toilet, ["別", "同室", "不明"] as const, "不明"),
      washbasin: pick(w.washbasin, ["独立", "浴室内", "不明"] as const, "不明"),
      laundry: pick(w.laundry, ["室内", "屋外", "不明"] as const, "不明"),
    },
    living_bedroom: pick(o.living_bedroom, ["単室", "隣接", "続き間", "廊下を挟む", "不明"] as const, "不明"),
    storage: {
      wic: pick(s.wic, ["あり", "なし", "不明"] as const, "不明"),
      closets: closetsOf(s.labels, numOrNull(s.closets, 0, 10)),
      shoes: pick(s.shoes, ["あり", "なし", "不明"] as const, "不明"),
      ...(Array.isArray(s.labels) ? { labels: (s.labels as unknown[]).map((l) => str(l, 16)).filter(Boolean).slice(0, 12) } : {}),
    },
    balcony: pick(o.balcony, ["あり", "なし", "不明"] as const, "不明"),
    note: str(o.note, 80),
    ...(sheet ? { sheet } : {}),
  };
  return sheet ? settleItandiFacts(out) : out;
}

/**
 * itandi の読み取りを、資料の設備欄の語で決まった手順で整える（画像だけの資料＝表から読んだ設備欄・PDF＝文字層の設備・備考）。
 * 2026-09-24 夜 正解表（itandi 22件）: モデルは図に WIC の字が無くても「不明」と返した（r1 4/22・r2 15/22）。
 *   - 設備欄に「ウォークインクローゼット」「WIC」（シューズ用を除く）→ "あり"
 *   - 間取り図が読めて（fp_ok）、図にも設備欄にも WIC が無い → "なし"（22件中 WIC ありの2件は図か設備欄に必ず字があった）
 * 2026-09-25 正解表（画像 25・PDF 18）: 図が小さい・細かい資料で水回りを「不明」や逆に読んだ（058・007・PDF 54/56/66）。
 *   設備欄の語がはっきりしている時は、43件で正解と1件も食い違わなかった → その時だけ設備欄で決める:
 *   - 「バス・トイレ一緒」「3点ユニット」だけ → bath_toilet 同室（独立洗面の語が無ければ washbasin 浴室内）／「バス・トイレ別」だけ → 別
 *     ⚠ 両方ある（022「バス・トイレ別, バス・トイレ一緒」・正解は別）時は図の読みのまま
 *   - 「独立洗面台」「洗髪洗面化粧台」「シャンプードレッサー」→ washbasin 独立 ／「室内洗濯機置場」→ laundry 室内
 *   - 「バルコニー」「ベランダ」→ balcony あり（「不明」の時だけ。ルーフバルコニー等で「なし」を覆さない）
 */
export function settleByEquipText(f: SheetImageFacts, equipText: string | null | undefined): SheetImageFacts {
  const all = String(equipText ?? "").normalize("NFKC");
  const eq = all.replace(/シューズ\s*(?:イン|WIC|ウォークイン)\s*(?:クローゼット|クローク)?/gi, "");
  let wic = f.storage.wic;
  if (/ウォーク\s*イン|WIC|W\.I\.C/i.test(eq)) wic = "あり";
  else if (wic === "不明" && f.fp_ok) wic = "なし";
  const w = { ...f.water };
  const sep = /バス\s*[・･/]?\s*トイレ\s*別|BT\s*別/i.test(all);
  const unit = /3\s*点\s*ユニット|バス\s*[・･/]?\s*トイレ\s*(?:一緒|同室)/.test(all);
  const indep = /独立洗面|洗髪洗面|シャンプードレッサー/.test(all);
  if (unit && !sep) { w.bath_toilet = "同室"; if (!indep) w.washbasin = "浴室内"; }
  else if (sep && !unit) w.bath_toilet = "別";
  if (indep) w.washbasin = "独立";
  if (/室内\s*洗濯機?\s*置/.test(all)) w.laundry = "室内";
  const balcony = f.balcony === "不明" && /バルコニー|ベランダ/.test(all) ? "あり" : f.balcony;
  const same = wic === f.storage.wic && balcony === f.balcony && JSON.stringify(w) === JSON.stringify(f.water);
  return same ? f : { ...f, water: w, balcony, storage: { ...f.storage, wic } };
}

/** itandi の PDF（文字層あり）: 文字層の設備・備考の文（sheet-facts.parseSheetText の features）で整える */
export function settleItandiPdfFacts(f: SheetImageFacts, equipText: string | null | undefined): SheetImageFacts {
  return settleByEquipText(f, equipText);
}

/** itandi の画像だけの資料: 表から読んだ設備欄で整える */
export function settleItandiFacts(f: SheetImageFacts): SheetImageFacts {
  return f.sheet ? settleByEquipText(f, f.sheet.equip) : f;
}

/**
 * 収納の数を、読んだ区画の字（labels）から決まった手順で数える。labels が無い返事はモデルの数のまま。
 * 2026-09-25 正解表（43件）: モデルに数だけ答えさせると、下足入・Shoes・MB・棚まで数える／WIC を数えない、が前置きの言い回しで行ったり来たりした
 *   （収納 75%→86%→68%）。字を並べさせ、数えない物（下駄箱・MB・PS・棚・ハンガーパイプ・冷蔵庫・洗濯機置場・給湯器）はここで除く
 */
export const NOT_CLOSET_LABEL = /シューズ|shoe|下足|下駄|げた|^S\.?B$|^S\.?C\.?L$|^S\.?I\.?C$|^MB$|^PS$|メーター|棚|shelf|ハンガー|パイプ|冷蔵|^冷$|洗|^W$|給湯|water|heater|^R$/i;
function closetsOf(labels: unknown, fallback: number | null): number | null {
  if (!Array.isArray(labels)) return fallback;
  const ls = labels.map((l) => String(l ?? "").normalize("NFKC").replace(/\s+/g, "").trim()).filter(Boolean).slice(0, 12);
  if (!ls.length) return fallback;
  return ls.filter((l) => CLOSET_LABEL.test(l) && !NOT_CLOSET_LABEL.test(l)).length;
}
/**
 * 数える収納の字（2026-09-25 t4: 除く字だけだと「Sniff」「洗面所」のような収納でない字まで数えた → 数える字の一覧に当たる物だけ）。
 * 納戸は部屋（S）なので数えない（正解表 038「押入・物入（納戸は別）」）
 * 反証 2026-09-25（リアプロ pk_34〜45）: リアプロの図は「Clo.」「Clo」「クローク」と書き、一覧に無く収納 0 になった → 足した
 */
export const CLOSET_LABEL = /^C\.?L\.?$|^Cl\.?$|^Clo\.?$|closet|storage|クロー?ゼット|クロゼット|クローク|物入|^入$|押入|収納|^収$|W\.?I\.?C|WCL|ウォーク/i;

/** 間取りの表記（全角・ワンルーム・S 付き）を「1K」「2LDK」の形に。形にならなければ "" */
function normMadori(v: unknown): string {
  const raw = str(v, 10).toUpperCase().replace(/ワンルーム/g, "1R").replace(/[Ａ-Ｚ０-９]/g, (c) => String.fromCharCode(c.charCodeAt(0) - 0xfee0));
  return /^[1-9](?:R|K|DK|LDK|SLDK|SK|SDK)$/.test(raw) ? raw.replace(/^([1-9])S(?=.)/, "$1") : "";
}

/** 円の額（「73,000円」「7.3万円」「73000」）。千円〜100万円の外は null */
function yenOrNull(v: unknown): number | null {
  if (v == null || v === "") return null;
  if (typeof v === "number") return Number.isFinite(v) && v >= 1000 && v <= 1_000_000 ? Math.round(v) : null;
  const s = String(v).normalize("NFKC").replace(/[,\s]/g, "");
  const man = s.match(/(\d+(?:\.\d+)?)万/);
  const n = man ? Math.round(parseFloat(man[1]) * 10000) : parseInt((s.match(/\d+/) ?? [""])[0], 10);
  return Number.isFinite(n) && n >= 1000 && n <= 1_000_000 ? n : null;
}

// ── 希望の照合（文字だけ・決まった手順で決まらなかった希望だけ） ────────────────────
// 2026-09-24 竹内「読んだ結果を物件ごとに保存し、2回目以降は画像を読み直さない（希望との照合は文字だけ）」
//   決まった手順（sheet-facts.matchWantsWithFacts）で ok/ng を出せない会話由来の希望（「洋室が小さそう」等）だけ、
//   保存した事実（JSON）と希望を文字で1回聞く（推論なし）。見込み: 入力 約500・出力 約150、1件 約0.01円
export const WANTS_JUDGE_HEAD = `あなたは賃貸物件の事実（JSON）とお客様の希望を照らす係です。事実に書いてある事だけで判断し、次の JSON だけを返してください（説明文不要）。
{"checks":[{"id":"W1","result":"ok","why":""}]}
- 希望の番号ごとに1つずつ。result は "ok"（事実で希望どおりと確かめられる）／"ng"（事実で希望に反すると確かめられる。NG の項目ならその物がある＝ng）／"unknown"（事実からは分からない）
- why は事実のどの欄で確かめたかを20字以内（例「rooms: 洋室6.1帖」）
- 事実に無い事・「不明」の欄は必ず "unknown"（推測で ok/ng にしない）。広さの感じ方は帖数と専有面積で判断してよい
`;

export function buildWantsJudgePrompt(factsJson: string, wantsText: string): string {
  return `${WANTS_JUDGE_HEAD}\n物件の事実:\n${factsJson}\n\nお客様の希望（【出どころ・NG・必須】）:\n${wantsText}`;
}

