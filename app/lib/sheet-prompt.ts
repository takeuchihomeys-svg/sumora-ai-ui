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
export const SHEET_PROMPT_VERSION = "sheet-v1";
/** 推論なしの出力は実測 120〜171 トークン。崩れた時の読み直し（推論 low）だけ大きく取る */
export const SHEET_READ_MAX_TOKENS = 600;
export const SHEET_RETRY_MAX_TOKENS = 12000;

/** 型に関係なく同じ部分（先頭・キャッシュを型の間で共有する） */
export const SHEET_COMMON_HEAD = `あなたは賃貸物件の資料（マイソク）の画像を読む係です。画像に見える事実だけを、次の JSON 1つで返してください（説明文・コードブロック不要）。
{"see":"","fp_ok":true,"other_unit":false,"madori":"","rooms":[{"name":"","jo":null}],"area_sqm":null,"type_label":"","kitchen":{"placement":"不明","stove":"不明","burners":null},"water":{"bath_toilet":"不明","washbasin":"不明","laundry":"不明"},"living_bedroom":"不明","storage":{"wic":"不明","closets":null,"shoes":"不明"},"balcony":"不明","note":""}
- see: 先に、どこを見て判断したかを40字以内で書く（例「中央の間取り図。玄関→廊下→洋室、キッチンは廊下の壁沿い」）
- fp_ok: 画像の中に間取り図があり、読めたら true。写真・外観・地図だけ／「画像情報なし」／小さくて読めない時は false
- other_unit: 間取り図に別の部屋番号・別の物件名・複数の間取り（A・B タイプを並べた図）がある時は true
- madori: 間取り図から「1R」「1K」「1DK」「1LDK」「2LDK」の形で（S・納戸は書かない）。分からなければ ""
- rooms: 居室と LDK/DK/K の名前と帖数（図に「洋6.1」「LDK11.9帖」「≒6.0J」とあれば jo に数）。帖数が見えなければ jo は null
- area_sqm: 図の中に面積（例「Cタイプ 68.84㎡」）が書いてあれば数。無ければ null ／ type_label: 図の中のタイプ名（例「Cタイプ」）。無ければ ""
- kitchen.placement: "対面"（シンクの前がリビング側を向く・カウンター）／"壁付け"（壁や廊下に沿う）／"独立"（扉で仕切られた台所）／"不明"
- kitchen.stove: "IH"／"ガス"／"不明"。burners: 口数（図や記号で分かる時だけ・無ければ null）
- water.bath_toilet: "別"（浴室とトイレが別の部屋）／"同室"（3点ユニット・同じ部屋）／"不明"
- water.washbasin: "独立"（浴室の外に洗面台）／"浴室内"／"不明" ／ water.laundry: "室内"／"屋外"（バルコニー等）／"不明"（洗濯機の記号）
- living_bedroom: 居室どうし・LDK と洋室の関係。"単室"（居室が1つだけ）／"隣接"（壁や扉で隣り合う）／"続き間"（引き戸で続く）／"廊下を挟む"／"不明"
- storage.wic: "あり"（WIC・W.I.C・WCL・ウォークイン・納戸）／"なし"／"不明"。シューズ用（SIC・シューズWIC）は wic に入れず shoes に。closets: 居室の収納（CL・物入）の数
- storage.shoes: シューズボックス・下足入・SIC が "あり"／"なし"／"不明" ／ balcony: "あり"／"なし"／"不明"
間違えやすい所（必ず守る）:
- 「対面」は、シンクの前（作業する人の向こう側）が LDK の居間側に開いている時だけ。廊下や壁に沿って置かれていれば「壁付け」。迷えば「不明」
- 居室が壁で接していても、洋室の扉が廊下側にあれば「廊下を挟む」。扉が LDK 側に開いていれば「隣接」、引き戸で LDK と続けば「続き間」
- 居室が2つ以上見えるのに「単室」にしない。見えない・書いていない事は必ず「不明」か null（推測で埋めない）
`;

/** 型ごとの説明（どこに何があるか）。キーは切り出しの形 */
export const SHEET_TYPE_SECTIONS: Record<"realpro_floor" | "itandi_area" | "page", string> = {
  realpro_floor: `この画像は「リアプロ（RealNetPro）の資料」の中央にある間取り図だけを切り出した物です。
- 資料は横長で、左に表・右上に外観と室内写真・中央に間取り図・右に地図・下に特記事項がある形。この画像はそのうち間取り図の枠だけ
- 枠の端に隣の地図・写真・表の線が1〜2px 入る事がある（読まない）
- 間取り図の中の「洋」「LD」「K」の横の数が帖数。「≒6.1J」「6.1帖」も帖数
画像:`,
  itandi_area: `この画像は「itandi の資料」の左半分（間取り図と室内写真の範囲）を切り出した物です。
- 資料は横長で、左上に間取り図・その下と中央に室内写真・右半分に表（所在地・賃料・設備・備考）・上に物件名と号室がある形。この画像は表を除いた画像の範囲
- 最初の枠が外観写真だったり、「画像情報なし」で間取り図が無い資料もある（その時は fp_ok=false）
- 室内写真は間取りの判断には使わない（間取り図だけで答える）
画像:`,
  page: `この画像は物件資料の1ページ全体です（型が分からない、または標準の位置に間取り図が無かった資料）。
- 間取り図を探して、その図から答える。表の文字は読まない（別に文字で持っている）
- 間取り図が2つ以上ある・別の部屋番号の図が混ざる時は other_unit=true
画像:`,
};

export function sectionKeyFor(mode: CropMode): keyof typeof SHEET_TYPE_SECTIONS {
  return mode === "floor" ? "realpro_floor" : mode === "image_area" ? "itandi_area" : "page";
}

/** 固定の前置き（共通 → 型ごと）。毎回一字一句同じ */
export function sheetPromptPrefix(mode: CropMode): string {
  return `${SHEET_COMMON_HEAD}\n${SHEET_TYPE_SECTIONS[sectionKeyFor(mode)]}`;
}

/** DeepSeek に渡す content（前置きの文 → 切り出した画像）。画像は data URL か https */
export function buildSheetReadContent(mode: CropMode, imageUrl: string): Array<Record<string, unknown>> {
  return [
    { type: "text", text: sheetPromptPrefix(mode) },
    { type: "image_url", image_url: { url: imageUrl } },
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
  storage: { wic: Tri; closets: number | null; shoes: Tri };
  balcony: Tri;
  note: string;
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
  const madoriRaw = str(o.madori, 10).toUpperCase().replace(/ワンルーム/g, "1R").replace(/[Ａ-Ｚ０-９]/g, (c) => String.fromCharCode(c.charCodeAt(0) - 0xfee0));
  const madori = /^[1-9](?:R|K|DK|LDK|SLDK|SK|SDK)$/.test(madoriRaw) ? madoriRaw.replace(/^([1-9])S(?=.)/, "$1") : "";
  const rooms = (Array.isArray(o.rooms) ? o.rooms : []).slice(0, 8).map((r) => {
    const rr = (r ?? {}) as Record<string, unknown>;
    return { name: str(rr.name, 12), jo: numOrNull(rr.jo, 1, 60) };
  }).filter((r) => r.name || r.jo != null);
  return {
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
      closets: numOrNull(s.closets, 0, 10),
      shoes: pick(s.shoes, ["あり", "なし", "不明"] as const, "不明"),
    },
    balcony: pick(o.balcony, ["あり", "なし", "不明"] as const, "不明"),
    note: str(o.note, 80),
  };
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

