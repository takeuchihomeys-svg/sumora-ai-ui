// app/lib/search-override.ts
// AIXツールのメモ欄の「検索の指示」→ 拡張の「一時調整」の上書き（この回だけ）に直す（純関数・DB も fetch も無し・画面からも使える）。
//
// 2026-09-27 竹内「ここ（AIXツールのメモ欄）に条件を送ったら、それに連動して検索されるようにする。
//   例えば『大正駅で検索する』なら駅は大正駅だけで検索、『1LDKで検索する』なら1LDKで検索。拡張ツールの一時調整の部分で合わせる形。
//   こちらからの文を DeepSeek の物件検索 AI が要約して、拡張ツールに渡す形。ゆくゆくは拡張ツールの AIX モードで使えるようにしていく」
//
// 流れ（1か所＝将来の AIX モードも同じ関数と /api/search-override を使う）:
//   1. looksLikeSearchInstruction … 決定論のきっかけ語（検索・探して・広げて・ピンポイント 等）。無ければ DeepSeek を呼ばない＝ふつうのメモ
//   2. DeepSeek（search-override-server.ts）が SEARCH_OVERRIDE_SYSTEM_PROMPT の形の JSON を返す（固定の前置きが先頭＝キャッシュ）
//      読めなかった時は parseDeterministic（決定論）で代わりに読む
//   3. validateOverride … **文に書いてある物だけ**を残す（駅は文の中の駅・間取りは文の中の間取り・金額は文の中の数字）。
//      書かれていない条件は null＝お客様の登録の条件のまま。あいまい・読めない所は unclear に出して勝手に決めない
//   4. overrideLine … 検索する前にメモ欄の下に出す1行（「🔍 大正駅だけ・1LDK・家賃は登録のまま（〜7.5万）・リアプロ・ピンポイント で検索します」）
//   5. sanitizeSearchOverride … /api/automation/trigger が payload.search_override に入れる前の関所（形・範囲・知っている駅/区だけ）
//   駅・区・路線の読み（osaka-geo の大きな表を使う物）は search-override-read.ts（サーバー用）。このファイルは画面からも import する（軽い物だけ）
//   拡張は chrome-extension/search-override.js（self.AxlxSearchOverride）が同じ形を読み、その回だけお客様の条件に重ねる
//   （お客様の登録の条件・拡張に保存した一時調整は書き換えない）。
//
// サイトごとの駅名・路線名の表記（リアプロ／itandi／レインズ）はここでは作らない。お客様の希望エリアと同じ書き方（「大正」「御堂筋線」「大阪市大正区」）で渡し、
//   拡張の既存の対応表（STATION_LINE_MAP → 各サイトの表）が直す（メモリ feedback_site_naming_separation）。

export const SEARCH_OVERRIDE_ACTION = "search_override";
/** 固定の前置きを変えたら上げる（llm_usage_logs の sysHead で版を分ける） */
export const SEARCH_OVERRIDE_PROMPT_VERSION = "search-override-v1";

export type OverrideSite = "realnetpro" | "itandi" | "reins";
export const OVERRIDE_SITES: readonly OverrideSite[] = ["realnetpro", "itandi", "reins"];

/** その回だけの上書き（拡張の一時調整の欄と同じ粒度）。null の欄＝お客様の登録の条件のまま */
export type SearchOverride = {
  v: 1;
  /** 場所。only＝この場所だけ（登録の場所を置き換える）・add＝登録の場所に足す */
  location: { mode: "only" | "add"; stations: string[]; lines: string[]; areas: string[] } | null;
  /** 間取り（"1LDK" / "1LDK以上" / "1K〜1LDK" / "1K・1LDK"）。拡張の page-script がこの形を読む */
  floor_plan: string | null;
  /** 家賃（円） */
  rent_max: number | null;
  rent_min: number | null;
  walk_minutes: number | null;
  building_age: number | null;
  /** 面積（㎡） */
  area_min: number | null;
  area_max: number | null;
  /** ペット相談（true だけ。外す指示は扱わない） */
  pet: true | null;
  site: OverrideSite | null;
  /** true＝広げて／false＝ピンポイント／null＝指定なし */
  is_wide: boolean | null;
};

/** お客様の登録の条件（DeepSeek に渡すのはこの欄だけ＝名前・電話・会話は入れない） */
export type RegisteredConditions = {
  desired_area?: string | null;
  area_mode?: string | null;
  rent_max?: number | null;
  rent_min?: number | null;
  floor_plan?: string | null;
  walk_minutes?: number | null;
  building_age?: number | null;
  floor_area_min?: number | null;
  floor_area_max?: number | null;
  pet?: boolean | null;
};

export type OverrideSummary = {
  /** 検索の指示か（false＝ふつうのメモ・何も出さない） */
  is_search: boolean;
  override: SearchOverride | null;
  /** 読めない・あいまいで入れなかった所（画面に出す） */
  unclear: string[];
  /** DeepSeek が言ったが文に無かった・形が違ったので落とした物（点検用） */
  dropped: string[];
  /** DeepSeek の読みか（false＝決定論だけ） */
  ai: boolean;
};

// ─────────────────────────── 1. きっかけ語 ───────────────────────────

/** 検索の指示らしい語（命令・依頼の形）。「検索した」「送った」のような報告だけの文は入れない */
const TRIGGER_RE = /(検索|探して|探す|探そ|さがして|さがす|サーチ|調べて|で出して|を出して|出し直|広げて|広げる|広げた(?:い|ら)|広めに|広く(?:して|探)|絞って|絞る|ピンポイント|で見て|物件出し|条件(?:を)?(?:入れて|変えて))/;
/** 「西区で1Kか1DK、6万から7万で」のように、きっかけ語が無くても条件（間取り・万・徒歩・築）を並べて「で」で終わる短い文 */
const COND_ONLY_RE = /(?:[1-9]\s*(?:LDK|DK|K|R|L)|\d\s*万|徒歩\s*\d|築\s*\d)[\s\S]*(?:で|でお願い|でおねがい)[。!！]?$/i;
/** 過去・完了の報告（「大正駅で検索した」「検索済み」）。命令の語が一緒に無ければ指示ではない */
const REPORT_ONLY_RE = /(検索|探)(?:し|済)(?:た|ました|み|済み)(?![いら])/;
const IMPERATIVE_RE = /(して|する|しよう|お願い|おねがい|頼む|たのむ|ください|下さい|やって|かけて|回して|まわして|出して|広げて|絞って)/;
/** サイトの名前だけの短い指示（「itandi で」「レインズにして」） */
const SITE_ONLY_RE = /^(?:リアプロ|レアプロ|itandi|イタンジ|いたんじ|レインズ|reins)(?:で|にして|でお願い|でおねがい)[。!！]?$/i;

/** メモの文が検索の指示らしいか（決定論・DeepSeek を呼ぶかの入口） */
export function looksLikeSearchInstruction(text: string | null | undefined): boolean {
  const t = normText(text);
  if (!t || t.length > 200) return false;
  if (SITE_ONLY_RE.test(t)) return true;
  if (t.length <= 60 && COND_ONLY_RE.test(t)) return true;
  if (!TRIGGER_RE.test(t)) return false;
  if (REPORT_ONLY_RE.test(t) && !IMPERATIVE_RE.test(t.replace(REPORT_ONLY_RE, ""))) return false;
  return true;
}

export function normText(text: string | null | undefined): string {
  return String(text ?? "").normalize("NFKC").replace(/[\s　]+/g, "").trim();
}

/** DeepSeek に渡す前にメモから電話・メールらしい所を伏せる（メモは社内の文だが念のため） */
export function maskMemoPii(text: string): string {
  return String(text ?? "")
    .replace(/[\w.+-]+@[\w-]+\.[\w.-]+/g, "＊＊＊")
    .replace(/\d[\d\-‐－ー ]{8,}\d/g, "＊＊＊")
    .slice(0, 200);
}

// ─────────────────────────── 2. DeepSeek の前置き（固定） ───────────────────────────

/** 固定の前置き（毎回一字一句同じ＝前置きキャッシュが当たる。変えたら SEARCH_OVERRIDE_PROMPT_VERSION も上げる） */
export const SEARCH_OVERRIDE_SYSTEM_PROMPT = `あなたは不動産の物件検索ツールの「一時調整」係です。スタッフが社内のメモ欄に書いた1文を読み、
(1) 物件検索の指示かどうか、(2) 指示なら「この回の検索だけ上書きする条件」を JSON で返します。お客様には届かない社内の文です。

【決まり】
- 文に書いてある条件だけを入れる。書かれていない条件は null（＝お客様の登録の条件のまま）。登録の条件を写さない。
- 推測で駅・地域・路線・間取り・金額を作らない。あいまい・読めない所は unclear に短い日本語で書き、その値は null。
- 「〇〇駅で」「〇〇駅だけ」「〇〇で検索」→ location.mode="only"、stations に駅名（「駅」は付けない）。「〇〇駅も」「〇〇を追加」「〇〇も足して」→ mode="add"。
- 区・市（大正区・吹田市）は areas、路線（御堂筋線・環状線・阪急京都線）は lines。場所の指示が無ければ location は null。
- 「〇〇以外」「〇〇は外して」のような除外は扱えない → unclear に書き、location は null。
- 通勤の目的地（「梅田まで一本」「梅田駅まで30分」）は検索の駅ではない → unclear に書く。
- 間取りは "1LDK"・"1LDK以上"・"1K〜1LDK"・"1K・1LDK" のどれかの形。
- 家賃は万円（rent_max_man・rent_min_man）。「家賃を1万上げて」のような差分は、登録の上限に足した値にする。
- 徒歩は分、築年数は年、面積は㎡（area_min・area_max）。
- 「広げて」「広く」「広めに」が検索全体にかかる時だけ scope="wide"。「ピンポイント」「絞って」は scope="pinpoint"。
  家賃・広さなど1つの条件を広げる意味（「家賃8万まで広げて」）なら、その条件の値だけ変えて scope は null。
- サイト: リアプロ→"realnetpro"、itandi・イタンジ→"itandi"、レインズ→"reins"。書かれていなければ null。
- ペット可の指示だけ pet=true（外す指示は unclear）。
- 過去の報告（「大正駅で検索した」「送った」）・検索と関係ないメモは is_search=false（ほかは全部 null・空）。

【答え方】JSON だけを返す（前後に文を付けない）:
{"is_search":true,"location":{"mode":"only","stations":[],"lines":[],"areas":[]},"floor_plan":null,"rent_max_man":null,"rent_min_man":null,"walk_minutes":null,"building_age":null,"area_min":null,"area_max":null,"pet":null,"site":null,"scope":null,"unclear":[]}`;

const man = (yen: number | null | undefined): string | null => {
  const n = Number(yen);
  if (!Number.isFinite(n) || n <= 0) return null;
  return `${Math.round(n / 1000) / 10}万`;
};

/** 登録の条件を1行ずつ（DeepSeek の材料・画面の「登録のまま」にも使う） */
export function registeredLines(reg: RegisteredConditions | null | undefined): string[] {
  const r = reg ?? {};
  const out: string[] = [];
  out.push(`エリア: ${String(r.desired_area ?? "").trim().slice(0, 80) || "なし"}${r.area_mode ? `（${r.area_mode === "station" ? "駅" : r.area_mode === "ward" ? "地域" : r.area_mode === "both" ? "駅と地域" : "自動"}）` : ""}`);
  out.push(`家賃: ${man(r.rent_min) ? `${man(r.rent_min)}〜` : "〜"}${man(r.rent_max) ?? "上限なし"}`);
  out.push(`間取り: ${String(r.floor_plan ?? "").trim().slice(0, 40) || "指定なし"}`);
  out.push(`徒歩: ${r.walk_minutes ? `${r.walk_minutes}分` : "指定なし"}`);
  out.push(`築年数: ${r.building_age ? `${r.building_age}年` : "指定なし"}`);
  if (r.floor_area_min || r.floor_area_max) out.push(`面積: ${r.floor_area_min ?? ""}〜${r.floor_area_max ?? ""}㎡`);
  if (r.pet === true) out.push("ペット: 相談可を希望");
  return out;
}

/** その回の材料（後ろ＝毎回変わる所）。個人情報は入れない（登録の条件の欄とメモだけ） */
export function buildUserContent(memo: string, reg: RegisteredConditions | null | undefined): string {
  return `【お客様の登録の条件（参考・写さない）】\n${registeredLines(reg).join("\n")}\n\n【メモ】\n${maskMemoPii(memo)}`;
}

/** DeepSeek の答え（JSON）を読む。読めない形は null（読み直しの合図） */
export function parseModelJson(text: string): Record<string, unknown> | null {
  const s = String(text ?? "").trim().replace(/^```(?:json)?\s*/i, "").replace(/```\s*$/, "");
  const a = s.indexOf("{"), b = s.lastIndexOf("}");
  if (a < 0 || b <= a) return null;
  try {
    const o = JSON.parse(s.slice(a, b + 1)) as unknown;
    if (!o || typeof o !== "object" || Array.isArray(o)) return null;
    if (typeof (o as { is_search?: unknown }).is_search !== "boolean") return null;
    return o as Record<string, unknown>;
  } catch { return null; }
}

// ─────────────────────────── 画面の1行 ───────────────────────────

/** 上書きが1つも無い（＝登録の条件のまま検索する） */
export function isEmptyOverride(ov: SearchOverride | null | undefined): boolean {
  if (!ov) return true;
  return !ov.location && !ov.floor_plan && ov.rent_max == null && ov.rent_min == null && ov.walk_minutes == null && ov.building_age == null
    && ov.area_min == null && ov.area_max == null && ov.pet == null;
}


export function siteLabelJa(site: OverrideSite): string {
  return site === "itandi" ? "itandi" : site === "reins" ? "レインズ（条件を入れるだけ）" : "リアプロ";
}

/**
 * 検索する前に出す1行。例「🔍 大正駅だけ・1LDK・家賃は登録のまま（〜7.5万）・リアプロ・ピンポイント で検索します」
 *   site / isWide は画面で選び直せる（無ければ override の値 → リアプロ・ピンポイント）
 */
export function overrideLine(ov: SearchOverride | null, reg: RegisteredConditions | null | undefined, opts: { site?: OverrideSite | null; isWide?: boolean | null } = {}): string {
  const r = reg ?? {};
  const parts: string[] = [];
  const loc = ov?.location ?? null;
  if (loc) {
    const names = [...loc.stations.map((s) => `${s}駅`), ...loc.lines.map((l) => `${l}沿い`), ...loc.areas.map((a) => a.replace(/^大阪市/, ""))];
    parts.push(loc.mode === "add" ? `${names.join("・")}を足して` : `${names.join("・")}だけ`);
  } else {
    const a = String(r.desired_area ?? "").trim();
    parts.push(`場所は登録のまま${a ? `（${a.length > 18 ? `${a.slice(0, 18)}…` : a}）` : ""}`);
  }
  if (ov?.floor_plan) parts.push(ov.floor_plan);
  else parts.push(`間取りは登録のまま${r.floor_plan ? `（${String(r.floor_plan).slice(0, 14)}）` : ""}`);
  if (ov && (ov.rent_max != null || ov.rent_min != null)) {
    const hiYen = ov.rent_max ?? r.rent_max ?? null;
    const loYen = ov.rent_min ?? r.rent_min ?? null;
    // 下限が上限以上なら下限は使われない（拡張の readAdjRentMin と同じ）→ 出さない
    const lo = loYen && (!hiYen || Number(loYen) < Number(hiYen)) ? man(loYen) : null;
    const hi = hiYen ? man(hiYen) : null;
    parts.push(`家賃${lo ? `${lo}〜` : "〜"}${hi ?? "上限なし"}`);
  } else {
    const hi = man(r.rent_max);
    const lo = r.rent_min && (!r.rent_max || Number(r.rent_min) < Number(r.rent_max)) ? man(r.rent_min) : null;
    parts.push(`家賃は登録のまま${hi || lo ? `（${lo ? `${lo}〜` : "〜"}${hi ?? ""}）` : ""}`);
  }
  if (ov?.walk_minutes != null) parts.push(`徒歩${ov.walk_minutes}分`);
  if (ov?.building_age != null) parts.push(`築${ov.building_age}年以内`);
  if (ov?.area_min != null && ov?.area_max != null) parts.push(`${ov.area_min}〜${ov.area_max}㎡`);
  else if (ov?.area_min != null) parts.push(`${ov.area_min}㎡以上`);
  else if (ov?.area_max != null) parts.push(`${ov.area_max}㎡まで`);
  if (ov?.pet) parts.push("ペット相談");
  const site = opts.site ?? ov?.site ?? "realnetpro";
  const wide = opts.isWide ?? ov?.is_wide ?? false;
  parts.push(siteLabelJa(site));
  parts.push(wide ? "広げて" : "ピンポイント");
  return `🔍 ${parts.join("・")} で検索します`;
}


// ─────────────────────────── 判定にも渡す（案A・2026-09-27） ───────────────────────────
// 竹内さんの決定（2026-09-27）「案Aでおこなう」: メモの上書きで検索した回は、判定（点数・👑・画像で分析の対象・カード）も
//   その回の上書きで行う（例 登録が 1K のお客様を 1LDK で検索した回は、1LDK を「合っている」扱い）。
//   上書きした項目だけ・書いていない項目は登録のまま（要約の決まりと同じ）。重ね方は search-override-judge.ts（純関数1つ）。
//   ここは画面からも使う軽い物だけ（ラベル・物差しの鍵・行の形の読み取り）。

/** property_pickups.search_override の形（その回をどの上書きで検索・判定したか）。無い行＝登録の条件で判定 */
export type PickupSearchOverride = {
  /** 上書きを積んだ automation_commands の id（拡張が merge-pdfs に search_command_id で渡す） */
  command_id: string | null;
  override: SearchOverride;
};

/** 行の search_override を読む（形が違う・上書きが空なら null）。画面・サーバーの両方で同じ読み方 */
export function readPickupSearchOverride(x: unknown): PickupSearchOverride | null {
  if (!x || typeof x !== "object" || Array.isArray(x)) return null;
  const o = x as { command_id?: unknown; override?: unknown };
  const ov = o.override as SearchOverride | null | undefined;
  if (!ov || typeof ov !== "object" || Array.isArray(ov) || ov.v !== 1 || isEmptyOverride(ov)) return null;
  return { command_id: typeof o.command_id === "string" ? o.command_id : null, override: ov };
}

/**
 * 判定の物差しの鍵（同じ鍵の行どうしだけ点を比べてよい）。"" ＝登録の条件。
 *   判定に効く欄だけで作る（サイト・広げて は判定を変えないので入れない＝同じ条件をリアプロと itandi で検索しても同じ物差し）
 */
export function overrideRulerKey(x: unknown): string {
  const p = readPickupSearchOverride(x);
  if (!p) return "";
  const ov = p.override;
  const loc = ov.location ? `${ov.location.mode}:${[...ov.location.stations].sort().join(",")}|${[...ov.location.lines].sort().join(",")}|${[...ov.location.areas].sort().join(",")}` : "";
  return JSON.stringify([loc, ov.floor_plan ?? "", ov.rent_max ?? "", ov.rent_min ?? "", ov.walk_minutes ?? "", ov.building_age ?? "", ov.area_min ?? "", ov.area_max ?? "", ov.pet ? 1 : ""]);
}

/** 上書きした項目だけの短い説明（例「大正駅だけ・1LDK・家賃〜8万」）。画面の1行と判定の記録に使う */
export function overrideShortLabel(ov: SearchOverride | null | undefined): string {
  if (!ov) return "";
  const parts: string[] = [];
  const loc = ov.location;
  if (loc) {
    const names = [...loc.stations.map((s) => `${s}駅`), ...loc.lines.map((l) => `${l}沿い`), ...loc.areas.map((a) => a.replace(/^大阪市/, ""))];
    if (names.length) parts.push(loc.mode === "add" ? `${names.join("・")}を足して` : `${names.join("・")}だけ`);
  }
  if (ov.floor_plan) parts.push(ov.floor_plan);
  if (ov.rent_max != null || ov.rent_min != null) {
    const lo = man(ov.rent_min), hi = man(ov.rent_max);
    parts.push(`家賃${lo ? `${lo}〜` : "〜"}${hi ?? ""}`);
  }
  if (ov.walk_minutes != null) parts.push(`徒歩${ov.walk_minutes}分`);
  if (ov.building_age != null) parts.push(`築${ov.building_age}年以内`);
  if (ov.area_min != null && ov.area_max != null) parts.push(`${ov.area_min}〜${ov.area_max}㎡`);
  else if (ov.area_min != null) parts.push(`${ov.area_min}㎡以上`);
  else if (ov.area_max != null) parts.push(`${ov.area_max}㎡まで`);
  if (ov.pet) parts.push("ペット相談");
  return parts.join("・");
}

/** カードの1行（「この回はメモの条件（大正駅だけ・1LDK）で判定」）。上書きの無い回は "" */
export function overrideJudgeLine(x: unknown): string {
  const p = readPickupSearchOverride(x);
  if (!p) return "";
  const label = overrideShortLabel(p.override);
  return label ? `この回はメモの条件（${label}）で判定・書いていない条件は登録のまま` : "";
}
