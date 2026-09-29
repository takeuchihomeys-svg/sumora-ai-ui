// app/lib/rent-raise.ts — お客様の「家賃を上げて」を登録の家賃上限に決定論で反映する（純関数）
//
// 2026-09-27 竹内「こういうの来たら AIX モードだと家賃を上げて物件検索する形になっているか。
//   今回のお客さん家賃10万までなので12万円まで上げる」（野口さん「もう少し家賃あげて、他の部屋もいただけたら、ありがたいです!」）
//
// 実物で起きていた事（会話 95019eb8・2026-09-27 20:06）:
//   ①P4（line-webhook の条件抽出・Haiku）が、スタッフの直前の文「家賃78,000円・管理費10,000円（合計88,000円）」を
//     「今より家賃を上げた物件」の下限と読み、rent_min=88000 を入れた（上限 10万は変わらず）。
//   ②ブレインは rent_change・AIX【物件ピックアップした】を出し、AIX モードの検索（source=aix）を積んだが、
//     payload に上書きは無く登録の条件のまま＝8.8万〜10万で検索する形だった（上限は上がっていない・狭まっていた）。
//   ③条件ブレイン（runConditionBrain・Sonnet）の「相対的変更は +1〜2万」も LLM 任せで、この回は上げなかった。
//
// 決まり（竹内さん）:
//   - お客様が家賃を上げてと頼んだら、家賃の上限を上げる。お客様が金額を言えばその金額
//     （「11万まで上げても」＝11万・「1万上げて」＝+1万）。金額が無い時の上げ幅は家賃の帯で変える（RENT_RAISE_RULE・下）。
//     2026-09-27 竹内「家賃が高いほど率を上げる。7万 → 8万台／10万 → 11.5万／15万 → 18万」（旧は一律 +2万）。
//   - 家賃の下限は、お客様がはっきり下限を言った時だけ入れる（「8万以上」「8万〜10万」「下限」）。
//
// 置き場所: 登録の条件（property_customers.rent_max）を上げる。search_override（その回だけ）にしない理由は
//   ①これはスタッフのメモの一時の指示でなくお客様の希望そのものの変更（以後の自動便・点検の物差しも同じ値であるべき）
//   ②拡張は search_override を web_brain の回にしか重ねない（AIX の回 source=aix は登録の条件を読む）
//   ③竹内さん自身も同じ場面で登録の上限を手で上げていた（11:29 100000→125000）。
//
// 二重に上げない: 相対の上げ（金額なし・「1万上げて」）は P4（webhook・ブレインより先に走る）だけが行う。
//   ブレインの条件の橋（generate-draft-bg-async）と条件ブレイン（property-brain-core）は、相対の上げの番では家賃に触らない。

// ── 金額の無い「家賃を上げて」の上げ幅（1か所の表・学習で直す時はここだけ）──────────────────────
// 2026-09-27 竹内「家賃が高いほど率を上げる。7万 → 8万台／10万 → 11.5万／15万 → 18万」「この決まりはまた詳細を学習していったらいける」
//   式: 上げた後 = 5千円単位に丸める( 今の上限 + max(最低の幅, 今の上限 × 率(今の上限)) )
//   率: 10万以下 15%・10万〜15万 は 15%→20% をまっすぐつなぐ・15万以上 20%（点の間は連続）
//   最低の幅 1万（安い帯で 15% だと 5万→5.75万＝検索の欄の刻みでほぼ変わらない）
//   丸め: 5千円単位の近い方（ちょうど真ん中は上へ）。丸めても今の上限より上がらない時は1刻み上げる
//   例の3点: 7万 → 8万（8.05万→8万・8万台）／10万 → 11.5万／15万 → 18万（テストで固定）
//   学習: scripts/audit-rent-raise-bands.ts がスタッフが実際に上げた幅（条件の履歴）とこの表の値を並べる。直す時は rates の点を動かす
export const RENT_RAISE_RULE: {
  /** 率の点（家賃の上限 → 率）。点の間はまっすぐつなぐ・端より外は端の率 */
  rates: ReadonlyArray<{ atYen: number; rate: number }>;
  minDeltaYen: number;
  roundYen: number;
} = {
  rates: [
    { atYen: 100000, rate: 0.15 },
    { atYen: 150000, rate: 0.20 },
  ],
  minDeltaYen: 10000,
  roundYen: 5000,
};

/** 今の上限での上げる率（点の間はまっすぐつなぐ） */
export function rentRaiseRate(currentMax: number, rule = RENT_RAISE_RULE): number {
  const pts = [...rule.rates].sort((a, b) => a.atYen - b.atYen);
  if (!pts.length) return 0;
  if (currentMax <= pts[0].atYen) return pts[0].rate;
  for (let i = 1; i < pts.length; i++) {
    const a = pts[i - 1], b = pts[i];
    if (currentMax <= b.atYen) return a.rate + (b.rate - a.rate) * (currentMax - a.atYen) / (b.atYen - a.atYen);
  }
  return pts[pts.length - 1].rate;
}

/** 金額の無い「家賃を上げて」の上げた後の上限（円） */
export function defaultRaisedRentMax(currentMax: number, rule = RENT_RAISE_RULE): number {
  const delta = Math.max(rule.minDeltaYen, currentMax * rentRaiseRate(currentMax, rule));
  const step = rule.roundYen;
  let v = Math.floor((currentMax + delta) / step + 0.5 + 1e-9) * step;
  if (v <= currentMax) v = (Math.floor(currentMax / step) + 1) * step;
  return v;
}

/** @deprecated 2026-09-27 帯の決まり（RENT_RAISE_RULE）に変えた。旧の一律の幅（記録のため残す・計算には使わない） */
export const DEFAULT_RENT_RAISE_YEN = 20000;

export type RentRaiseRequest =
  | { kind: "absolute"; toYen: number; evidence: string }
  | { kind: "delta"; deltaYen: number; evidence: string }
  | { kind: "default"; evidence: string };

const norm = (s: string) => String(s ?? "").normalize("NFKC").replace(/,/g, "");

// 家賃の話か（初期費用・保証料・敷金礼金だけの話は外す）
const RENT_WORD_RE = /家賃|賃料|予算|月々|月額/;
const NON_RENT_MONEY_RE = /初期費用|保証料|敷金|礼金|仲介手数料|火災保険|更新料/;

// 上げてよい・上げて、の言い方（依頼・許可）
const RAISE_RE = new RegExp([
  "(?:上げ|あげ)(?:て|ても|たい|ます|よう)",
  "上限(?:を)?(?:上げ|あげ|引き上げ)",
  "(?:上が|あが)(?:って)?も(?:いい|いー|良|よ|大丈夫|ok|構わ|かまわ|平気)",
  "高く(?:て)?も(?:いい|いー|良|よ|大丈夫|ok|構わ|かまわ|平気|\\d)",
  "高め(?:でも|で(?:いい|大丈夫|ok))",
  "アップ(?:して|しても|でも|で(?:いい|大丈夫|ok))",
  "増やして|引き上げ",
  // 「予算は12万でも大丈夫」（上がらない金額なら computeRaisedRentMax が null＝何もしない）
  "\\d\\s*万\\s*円?\\s*(?:くらい|ぐらい|程度|前後|位)?\\s*(?:まで)?でも(?:いい|いー|良|よ|大丈夫|ok|構わ|かまわ|平気)",
].join("|"), "i");

// 上げの話でも、依頼・許可でない物（断る・心配）。
//   「家賃って上がりますか」「上がる感じですか」は RAISE_RE に当たらない（上がる＝結果の話・依頼の形でない）ので、質問の語はここに入れない
//   （「もう少し家賃上げて良いので、新大阪、東三国でありそうですか？」は依頼＝実物 d8691e41）
const NOT_RAISE_RE = /厳し|きびし|無理|難し|むずかし|たくない|られない|上げれない|あげれない|上げない|あげない|ずに|ないで|気にな|心配|しまう|しまっ|値下げ|下げ/;

function clauses(text: string): string[] {
  return norm(text).split(/[。\n!！?？]+/).map((s) => s.trim()).filter(Boolean);
}

/** 「11万」「11.5万」「9万5千」「95000円」 → 円 */
function yenOf(num: string, unit: string, sen?: string): number | null {
  const v = Number(num);
  if (!Number.isFinite(v)) return null;
  if (unit === "万") return Math.round((v + (sen ? Number(sen) / 10 : 0)) * 10000);
  if (unit === "千") return Math.round(v * 1000);
  if (unit === "円") return Math.round(v);
  return null;
}

/**
 * お客様の文が「家賃を上げて（上げてよい）」の依頼か。違えば null。
 * 金額: 「11万まで」「12万でも」＝absolute（上げた後の上限）・「1万上げて」「5千円アップ」＝delta・金額なし＝default（帯の決まり RENT_RAISE_RULE）
 */
export function detectRentRaiseRequest(text: string): RentRaiseRequest | null {
  // 特定のお部屋の交渉（「二匹で交渉してほしいです / 少し家賃上がってもいーので」実物 533b20d0）は検索の上限の話でない
  if (/交渉/.test(norm(text))) return null;
  for (const c of clauses(text)) {
    const lc = c.toLowerCase();
    // 家賃の語が無い節は外す（「初期費用少し高くても大丈夫です」「保証料がもう少し高く」「徒歩の上限を上げて」）
    if (!RENT_WORD_RE.test(c)) continue;
    // 「初期費用の予算を上げても」＝家賃でない
    if (NON_RENT_MONEY_RE.test(c) && !/家賃|賃料|月々|月額/.test(c)) continue;
    const m = lc.match(RAISE_RE);
    if (!m) continue;
    if (NOT_RAISE_RE.test(c)) continue;
    // 差分: 「1万上げて」「5千円アップ」「2万ほど上げても」
    const d = c.match(/(\d+(?:\.\d+)?)\s*(万|千)\s*円?\s*(?:ほど|くらい|ぐらい|程度|位)?\s*(?:上げ|あげ|アップ|プラス|増や|高く)/);
    if (d) {
      const y = yenOf(d[1], d[2]);
      if (y && y > 0 && y <= 100000) return { kind: "delta", deltaYen: y, evidence: c };
    }
    // 上げた後の上限: 「11万まで」「12万でも」「9万5千円以内」「上限を11万に」
    const a = c.match(/(\d+(?:\.\d+)?)\s*(万)(?:\s*(\d)\s*千)?\s*円?\s*(?:くらい|ぐらい|程度|前後|位)?\s*(?:まで|以内|以下|でも|なら|に(?:上げ|あげ|して)|が上限)/)
      ?? c.match(/(\d{5,6})\s*(円)\s*(?:くらい|ぐらい|程度|前後|位)?\s*(?:まで|以内|以下|でも|なら)/);
    if (a) {
      const y = a[2] === "万" ? yenOf(a[1], "万", a[3]) : yenOf(a[1], "円");
      if (y && y >= 20000 && y <= 1000000) return { kind: "absolute", toYen: y, evidence: c };
    }
    return { kind: "default", evidence: c };
  }
  return null;
}

/** 上げた後の上限（上げられない＝登録の上限が無い相対の上げ・上がらない金額 → null） */
export function computeRaisedRentMax(currentMax: number | null | undefined, req: RentRaiseRequest): number | null {
  const cur = typeof currentMax === "number" && currentMax > 0 ? currentMax : null;
  if (req.kind === "absolute") return cur !== null && req.toYen <= cur ? null : req.toYen;
  if (cur === null) return null;
  return req.kind === "delta" ? cur + req.deltaYen : defaultRaisedRentMax(cur);
}

/** お客様が家賃の下限をはっきり言ったか（「8万以上」「8万〜10万」「8万から」「下限」「最低」） */
export function statesRentMin(text: string): boolean {
  const t = norm(text);
  if (/下限|最低(?:でも)?\s*\d/.test(t)) return true;
  return /\d+(?:\.\d+)?\s*万(?:\s*\d\s*千)?\s*円?\s*(?:以上|から|〜|~|～|-|ー(?=\s*\d))/.test(t)
    || /\d{5,6}\s*円\s*(?:以上|から|〜|~|～)/.test(t);
}

export type RentGuardResult = {
  /** 家賃の欄を直した抽出結果（元の物は変えない） */
  extracted: Record<string, unknown>;
  raise: RentRaiseRequest | null;
  /** 何をしたか（ログ・監査用） */
  notes: string[];
};

/**
 * 条件の抽出（LLM）の結果に家賃の決まりを当てる。
 * mode "p4"     … 相対の上げもここで上限に足す（ブレインより先に1回だけ走る webhook の P4）
 * mode "follow" … ブレインの条件の橋・条件ブレイン: 相対の上げの番は家賃に触らない（P4 が済ませている＝二重に上げない）
 */
export function applyRentGuards(
  text: string,
  current: { rent_max?: number | null; rent_min?: number | null } | null | undefined,
  extracted: Record<string, unknown>,
  mode: "p4" | "follow",
): RentGuardResult {
  const out: Record<string, unknown> = { ...extracted };
  const notes: string[] = [];
  const minStated = statesRentMin(text);
  if (out.rent_min !== undefined && out.rent_min !== null && !minStated) {
    notes.push(`rent_min ${String(out.rent_min)} を外した（お客様が下限を言っていない）`);
    delete out.rent_min;
  }
  const raise = detectRentRaiseRequest(text);
  if (raise) {
    const curMax = current?.rent_max ?? null;
    if (mode === "follow" && raise.kind !== "absolute") {
      if (out.rent_max !== undefined) notes.push(`rent_max ${String(out.rent_max)} を外した（相対の上げは P4 が反映）`);
      delete out.rent_max;
    } else {
      const next = computeRaisedRentMax(curMax, raise);
      if (next !== null) {
        if (out.rent_max !== next) notes.push(`rent_max ${curMax ?? "なし"} → ${next}（${raise.kind === "absolute" ? "お客様の金額" : raise.kind === "delta" ? `+${raise.deltaYen}` : "帯の決まり"}）`);
        out.rent_max = next;
      } else if (typeof out.rent_max === "number" && typeof curMax === "number" && out.rent_max < curMax) {
        notes.push(`rent_max ${out.rent_max} を外した（上げての依頼で上限が下がる）`);
        delete out.rent_max;
      }
    }
  }
  return { extracted: out, raise, notes };
}

// ── 洋室の広さ「7畳以上」→ 面積の下限（検索に効く列 floor_area_min）──────────────────────
// 2026-09-27 竹内（未桜さん「大国町エリアで1Kでできたら7畳以上の部屋で探してます」）: 自動反映が preferences に文字で入れるだけで、
//   検索（拡張の parseAreaMin は ㎡ だけ読む）にも効かず、前からの floor_area_min=25 がそのまま残っていた（25㎡は 7帖の 1K の多くを落とす）。
//   リアプロ・ITANDI の検索欄は専有面積（㎡）なので、洋室の帖数を面積の下限に直して入れる。
//   換算: 洋室 N帖 × 1.62㎡ ＋ キッチン・水回り・玄関 約8㎡（7帖→19㎡・8帖→20㎡・6帖→17㎡）。
//   広め（落とさない側）に倒す: 洋室の帖数そのものの判定はピックアップの判定側（資料の文字・間取り図）で行う。

/** お客様の文の「洋室 N畳/帖 以上」（LDK・DK・リビングの帖数は除く）。無ければ null */
export function roomJoMinInText(text: string): number | null {
  const t = norm(text);
  for (const m of t.matchAll(/(\d{1,2}(?:\.\d)?)\s*(?:畳|帖|j(?![a-z]))\s*\)?\s*(?:くらい|ぐらい|程度|位)?\s*(以上|〜|~|～|から|は(?:欲しい|ほしい|あれば|必要)|あれば|が(?:理想|いい|良い|希望))/gi)) {
    const before = t.slice(Math.max(0, (m.index ?? 0) - 6), m.index ?? 0);
    if (/(?:S?LDK|DK|リビング|ダイニング|キッチン|K)\s*[:：]?\s*$/i.test(before)) continue;
    const v = Number(m[1]);
    if (v >= 3 && v <= 30) return v;
  }
  return null;
}

/** 1部屋の間取り（1R・1K）だけか。洋室の帖数から専有面積を決められるのはこの時だけ（1LDK・2DK は洋室の帖数と面積が結びつかない） */
export function isSingleRoomPlan(plan: string | null | undefined): boolean {
  const t = norm(String(plan ?? "")).toUpperCase().replace(/ワンルーム|ワンケー/g, (m) => (m === "ワンルーム" ? "1R" : "1K"));
  if (!/1\s*[KR](?![A-Z])/.test(t)) return false;
  return !/[2-9]\s*(?:S?LDK|DK|K|R)|LDK|DK|SK/.test(t);
}

/** 洋室 N帖 → 専有面積の下限（㎡） */
export function joToFloorAreaMin(jo: number): number {
  return Math.floor(jo * 1.62) + 8;
}

/** 面積をはっきり ㎡ で言ったか（「25㎡以上」「30平米」） */
function statesSqm(text: string): boolean {
  return /\d+(?:\.\d+)?\s*(?:㎡|平米|m2|m²|平方メートル)/i.test(norm(text));
}

/**
 * お客様の文の「洋室 N帖以上」→ 面積の下限（㎡）。㎡ を言った時・1R/1K でない時（登録か抽出の間取り・文に LDK/DK/2K 等）は null。
 * 帖→㎡ を 1R・1K に限る理由（監査 2026-09-27）: 1LDK・2LDK のお客様の「洋室4畳以上」「5帖」を 14〜16㎡ にすると
 *   35〜45㎡ の下限を壊す（はるかさん 35㎡・はぎさちさん 45㎡）
 */
export function floorAreaMinFromJo(text: string, plan: string | null | undefined): { jo: number; sqm: number } | null {
  const jo = roomJoMinInText(text);
  if (jo === null || statesSqm(text)) return null;
  if (!isSingleRoomPlan(plan)) return null;
  if (/(?:S?LDK|DK)(?![a-z])|[2-9]\s*K(?![a-z])/i.test(norm(text))) return null;
  return { jo, sqm: joToFloorAreaMin(jo) };
}

/**
 * 条件の抽出（LLM）の結果に、家賃と広さの決まりを当てる（入口: P4・フォームの読み取り・ブレインの橋・条件ブレイン）。
 * 広さ: お客様が「N畳/帖以上」を言い、㎡ を言っていない時は floor_area_min を帖数からの換算にする（言い直し＝前の値を置き換える）
 */
export function applyConditionGuards(
  text: string,
  current: { rent_max?: number | null; rent_min?: number | null; floor_area_min?: number | null; floor_plan?: string | null } | null | undefined,
  extracted: Record<string, unknown>,
  mode: "p4" | "follow",
): RentGuardResult {
  const r = applyRentGuards(text, current, extracted, mode);
  const plan = (typeof r.extracted.floor_plan === "string" && r.extracted.floor_plan) ? r.extracted.floor_plan : (current?.floor_plan ?? "");
  const fa = floorAreaMinFromJo(text, plan);
  if (fa) {
    if (r.extracted.floor_area_min !== fa.sqm) r.notes.push(`floor_area_min ${current?.floor_area_min ?? "なし"} → ${fa.sqm}（洋室${fa.jo}帖以上）`);
    r.extracted.floor_area_min = fa.sqm;
  }
  return r;
}
