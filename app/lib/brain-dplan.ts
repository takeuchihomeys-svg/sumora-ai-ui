// app/lib/brain-dplan.ts — D案の核（本番の形）: 分野ごとの読み手（flash）→ 指揮官（核・今と同じモデル）が材料を選んで今と同じ JSON を出す（純関数・DB/LLM なし）
//
// 2026-10-22 竹内さんの決定:
//   P0 c0884407「安いモデルは研究者の発想で組む — パーツに分けて読み、つなぎと優先順位をブレインで強くして最後に生成する」
//   P1 2804f1de「flash の部分は flash の考え方・Claude の部分は Claude の考え方・つなぎを強く」
//   P1 8c00271d「原則の優先を核と司令塔へ前倒し・D案の時は決まった処理の上書きを止めて核を勝たせる・試験で今の本番以上なら切り替え」
//   P1 cf9ada24「材料を場面で削る。どの材料を削るかは指揮官（司令塔のブレイン）が判断する」・66a7d371「毎回の分析は Claude のまま（削る方を先に）」
//   P1 4f027a6b「AIX は LINE のブレイン（統括）が管轄」＝返信か AIX か・どのボタン×ピッカーかはここ（核）で決める
// 形: ①読み手 6人（flash・伏せた材料だけ・判断はしない）が分野ごとに短く読む ②核（今の brain_fresh と同じモデル・同じ system・同じ出力の形）は
//   読み手の下ごしらえ＋削らない材料＋会話履歴（元の文）を見て判断する。読み手が読んだ大きい材料は目次だけにし、要る時は核が呼び戻す（need_materials・1回だけ）。
//   読み手が失敗した・「全部要る」と言った材料は削らない（安全側）。
// 個人情報（311b379e③・023ec7bd）: 申込以降・時刻の線のある会話・申込フォーム・個人の書類の画像・2番手で申込中・本文に個人の値 → 読み手を使わず今の形のまま。
// スイッチ: BRAIN_D_PLAN=on（既定 off＝今のまま1文字も変わらない）。

export type Env = Record<string, string | undefined>;

/** BRAIN_D_PLAN（既定 off） */
export function dPlanOn(env: Env = typeof process !== "undefined" ? process.env : {}): boolean {
  const v = (env.BRAIN_D_PLAN ?? "").trim().toLowerCase();
  return v === "on" || v === "1" || v === "true";
}

// ── 個人情報の入口（番ごと1回） ─────────────────────────────────────────
export type DPlanGateInput = {
  /** 会話 ID（無い番は時刻の線を読めない＝通さない・3周目 fail-closed） */
  conversationId?: string | null;
  postApply: boolean;
  /** 時刻の線の印（all＝全部渡してよい。cut／blocked／masked／null は渡さない） */
  cutoffKind: string | null;
  applicationForm: boolean;
  personalImage: boolean;
  parallelSecond: boolean;
  /** 読み手に渡す全部（伏せた後） */
  readerText: string;
  /** 本文に個人の値が残っていないかの網（alt-pii-gate.altPiiSignal を渡す） */
  piiSignal: (t: string) => string | null;
};
export function dPlanGate(p: DPlanGateInput): { ok: boolean; reason: string | null } {
  if (!String(p.conversationId ?? "").trim()) return { ok: false, reason: "会話 ID なし" };
  if (p.postApply) return { ok: false, reason: "申込以降の番" };
  if (p.cutoffKind !== "all") return { ok: false, reason: `時刻の線（${p.cutoffKind ?? "印なし"}）` };
  if (p.applicationForm) return { ok: false, reason: "申込フォーム" };
  if (p.personalImage) return { ok: false, reason: "個人の書類の画像" };
  if (p.parallelSecond) return { ok: false, reason: "2番手で申込中" };
  const sig = p.piiSignal(p.readerText);
  if (sig) return { ok: false, reason: `個人の値（${sig}）` };
  return { ok: true, reason: null };
}

// ── 材料（今回の発言の層の素の入力の部品・並びは brain-core と同じ） ─────────────
export const MATERIAL_KEYS = [
  "aixCatalog", "actionRules", "templates", "status", "cond", "sentProps", "propertySearch", "viewings", "tasks", "scheduled", "examples", "timing",
  "companyFacts", "sendReplyTiming", "flags", "aixHistory", "ledger", "promise", "seeMore", "customerState", "parallelSearch", "applyRoute",
  "applyReadiness", "appealTiming", "sceneEvidence", "judgeExamples", "routeType", "rag",
] as const;
export type MaterialKey = typeof MATERIAL_KEYS[number];
export type Materials = Partial<Record<MaterialKey, string>>;

export const MATERIAL_JA: Record<MaterialKey, string> = {
  aixCatalog: "AIX のボタン一覧", actionRules: "動きの決まり", templates: "テンプレートの候補", status: "状態", cond: "条件", sentProps: "送った物件",
  propertySearch: "物件の探し", viewings: "内覧", tasks: "やること", scheduled: "予定の送信", examples: "手本", timing: "時刻・間隔",
  companyFacts: "会社の事実", sendReplyTiming: "送る時刻", flags: "印", aixHistory: "AIX の履歴", ledger: "行動台帳", promise: "約束",
  seeMore: "他も見たい", customerState: "お客様の状態", parallelSearch: "並行の探し", applyRoute: "申込までの地図", applyReadiness: "申込の近さ",
  appealTiming: "訴求の時", sceneEvidence: "場面の証拠", judgeExamples: "判断の手本", routeType: "道の型", rag: "ナレッジ",
};

// ── 読み手（flash）── 短い1つの仕事・はっきりした出す形・大事な事は最後・判断はさせない ──────────
export const READER_KEYS = ["state", "promise", "props", "dates", "aixfacts", "intent", "aixpick"] as const;
export type ReaderKey = typeof READER_KEYS[number];

export type ReaderDef = {
  ja: string;
  /** 読む材料（会話履歴と今回の連投はいつも渡す） */
  reads: MaterialKey[];
  /** 読めた時に核の入力から外す（目次だけにする）材料 */
  trims: MaterialKey[];
  /** 仕事（1つだけ） */
  task: string;
};
export const READERS: Record<ReaderKey, ReaderDef> = {
  state: {
    ja: "お客様の状態", reads: ["customerState", "cond", "status"], trims: ["customerState"],
    task: "お客様の今の状態を読む: 探している条件（場所・賃料・間取り・入居の時期）／今どの段階か（探し中・物件を見ている・内覧の前後・申込の前）／気にしている事・不安・こだわり／お客様が知っている事と知らない事・誤解していそうな事／お客様の状態の材料にある大事な事実（変わった条件・断った物件・気に入った物件）。",
  },
  promise: {
    ja: "約束・台帳", reads: ["ledger", "aixHistory", "tasks", "promise", "scheduled"], trims: ["ledger", "aixHistory", "tasks"],
    task: "こちらの約束と済んだ事を読む: まだ果たしていないこちらの約束（何を・いつ言ったか）／もう答えた事・もう送った物（御見積書・物件・確認の結果・日程）＝繰り返さない事／最後にこちらが送った物と、その後お客様が何と返したか。",
  },
  props: {
    ja: "物件", reads: ["sentProps", "propertySearch", "customerState"], trims: ["sentProps", "propertySearch"],
    task: "物件を読む: 今回の連投が指している物件（名前のまま・決まらない時は候補を全部と「決まらない」）／送った物件の一覧の要点（名前・賃料・送った日・お客様の反応）／今回の依頼に答える資料の事実があるか（資料にある事は事実をそのまま・資料に無い事は「資料に無い」）。",
  },
  dates: {
    ja: "日付・内覧", reads: ["viewings", "timing", "scheduled"], trims: [],
    task: "日付を読む: 今回の連投と直前のやり取りに出た日付・時刻と、それが何の日か（内覧・入居・引越し・申込・連絡・支払い）を流れから読む（内覧の調整中に出た日は内覧の日）／内覧の予定・済み・調整中の状態／お客様が待っている連絡の日。",
  },
  aixfacts: {
    ja: "答えの出どころ", reads: ["rag", "companyFacts", "templates", "examples", "sentProps"], trims: ["rag", "templates", "examples"],
    task: "今回の依頼ごとに、答えの出どころを読む: 会社の事実・ナレッジ・資料・一般的な不動産の知識で答えられる（答えの事実を短く）／スタッフしか知らない・管理会社に確かめないと分からない（空き状況・見積の金額・確認の結果・交渉・内覧の確定・入居可能日）。ナレッジ・手本の中で今回に効く物は要点を短く写す。",
  },
  aixpick: {
    // 2026-10-22 2周目: AIX のボタン一覧（場面の読みが弱い番は全部の細目＝平均 4.5k字・素の入力の最大）を核には名前と値だけにし、候補の細目だけ全文で渡す
    ja: "AIX の候補", reads: ["aixCatalog"], trims: ["aixCatalog"],
    task: "AIX のボタン一覧から、今回の連投に関係しそうなボタン×ピッカーの候補を最大6つ挙げる。1行に1つ「ボタンのキー/ピッカーの値: 理由（短く）」の形で、キーと値は一覧の英字のまま（例 property_check_result/mgmt_parking: 駐車場の空きを聞いた）。返信で答えられそうでも、関係するボタンは挙げる（使うかは別の係が決める）。迷う物は多めに挙げる。",
  },
  intent: {
    ja: "依頼と抜け", reads: [], trims: [],
    task: "今回の連投の依頼・質問・気持ちを全部読む: 1つずつ元の文のまま引用し、何を知りたい・してほしいのか（言葉の裏の本当の狙い）を短く／お礼・謝り・不安などの受け止める事／主語・指す物が抜けていて決まらない所／直前のこちらの送信への返事かどうか。",
  },
};

// ── 3周目（10/23 査読の再試験で悪化: 道 12→10・依頼 12→8）: 返信で答えられる証拠を核から消さない ───────────
/**
 * 核から絶対に外さない材料。返信か AIX かの証拠（送った物件・物件の探し・ナレッジ・行動台帳・AIX の履歴・やること・お客様の状態・会社の事実・約束 等）。
 *   2周目は読み手が読めた時に 8〜9個を目次だけにしていた（素の入力 −40%）＝「送った物で答えられる」の証拠が消え、見積書の AIX に寄った（q156・q160）。
 *   外してよいのは AIX のボタン一覧の「場面の外のピッカーの細目」だけ（compactCatalogByScene）
 */
export const NEVER_TRIM: ReadonlySet<MaterialKey> = new Set<MaterialKey>(MATERIAL_KEYS.filter((k) => k !== "aixCatalog"));
/**
 * 回す読み手（BRAIN_D_PLAN_READERS・既定 intent だけ）。"none" で読み手なし（AIX の一覧の縮め＋呼び戻しだけ）。
 *   state/promise/props/aixfacts の材料は外さない＝要約は重ねるだけ（aixfacts の「見積の金額はスタッフだけ」は見積書への偏りの元）。
 *   aixpick は一覧を場面で縮める（候補で縮めない＝偏らせない）ので既定から外す
 */
export function dPlanReaders(env: Env = typeof process !== "undefined" ? process.env : {}): ReaderKey[] {
  const raw = String(env.BRAIN_D_PLAN_READERS ?? "").trim().toLowerCase();
  if (!raw) return ["intent"];
  if (raw === "none" || raw === "off") return [];
  const out: ReaderKey[] = [];
  for (const x of raw.split(",").map((t) => t.trim())) if ((READER_KEYS as readonly string[]).includes(x) && !out.includes(x as ReaderKey)) out.push(x as ReaderKey);
  return out;
}

export const READER_HEAD = `あなたは不動産の賃貸仲介（スモラ）の LINE を「1つの分野だけ読む係」です。読む分野は【あなたの仕事】の1つだけ。
決まり:
1. 判断しない。返信するか・確認の約束にするか・AIX で送るか・何と返すかは書かない（別の係が全部を見て決める）。
2. 材料に書いてある事だけ。無い事は「無い」「分からない」。推測で埋めない・作らない。
3. お客様の言葉は「」で元の文のまま引用する（言い換えない）。
4. 伏せ字（（名前）・（電話番号）等）は伏せ字のまま。
5. 短く。1行80字まで・最大8行。大事な物から順に。
6. 材料が多くて8行に収まらない・削ると判断を誤る大事な物が残る時だけ keep_full を true。
出力は JSON だけ: {"points":["…","…"],"keep_full":false}`;

/** 読み手の system（共通の頭＋仕事）。並びは変わらない物が前（DeepSeek の先頭一致キャッシュ） */
export function readerSystem(k: ReaderKey): string {
  return `${READER_HEAD}\n\n【あなたの仕事】${READERS[k].ja}\n${READERS[k].task}`;
}

/** 読み手の user（材料→会話履歴→今回の連投を最後に）。材料・履歴・連投は伏せた後の物を渡す */
export function readerUser(k: ReaderKey, m: Materials, historyText: string, turnText: string): string {
  const parts: string[] = [];
  for (const key of READERS[k].reads) {
    const t = (m[key] ?? "").trim();
    if (t) parts.push(`【材料: ${MATERIAL_JA[key]}】\n${t}`);
  }
  parts.push(`【会話履歴（古い→新しい・最後が今回）】\n${clipHistory(historyText, k === "intent" ? 2500 : 4000)}`);
  parts.push(`【今回の連投（お客様のまだ返していない発言）】\n${turnText.trim() || "（文字なし）"}`);
  parts.push(`【あなたの仕事（もう一度）】${READERS[k].ja}。JSON だけ: {"points":[…],"keep_full":false}`);
  return parts.join("\n\n");
}

/** 会話履歴は新しい方を残す（頭を切る） */
export function clipHistory(h: string, max: number): string {
  const s = String(h ?? "");
  if (s.length <= max) return s;
  const cut = s.slice(s.length - max);
  const nl = cut.indexOf("\n");
  return `（前は省略）\n${nl >= 0 && nl < 200 ? cut.slice(nl + 1) : cut}`;
}

export type ReaderOut = { points: string[]; keepFull: boolean };
/** 読み手の答えを読む（崩れていれば null） */
export function parseReaderOut(text: string): ReaderOut | null {
  const s = String(text ?? "");
  const a = s.indexOf("{"), b = s.lastIndexOf("}");
  if (a < 0 || b <= a) return null;
  let o: unknown;
  try { o = JSON.parse(s.slice(a, b + 1)); } catch { return null; }
  if (!o || typeof o !== "object") return null;
  const pts = (o as { points?: unknown }).points;
  if (!Array.isArray(pts)) return null;
  const points = pts.map((x) => String(x ?? "").replace(/\s+/g, " ").trim()).filter(Boolean).slice(0, 8).map((x) => Array.from(x).slice(0, 120).join(""));
  const kf = (o as { keep_full?: unknown }).keep_full;
  return { points, keepFull: kf === true || kf === "true" };
}

export type ReaderResult = { key: ReaderKey; ok: boolean; out: ReaderOut | null; error: string | null; ms: number; usd: number; inTok: number; outTok: number; cacheHit: number };

/** 外す材料（読めた読み手の trims。読めなかった・keep_full の読み手の材料は外さない。他の読み手が要ると言った材料も外さない） */
export function trimmedKeys(results: ReadonlyArray<ReaderResult>, m: Materials, minChars = 120): MaterialKey[] {
  const keep = new Set<MaterialKey>();
  for (const r of results) if (!r.ok || r.out?.keepFull) for (const k of READERS[r.key].trims) keep.add(k);
  const out: MaterialKey[] = [];
  for (const r of results) {
    if (!r.ok || r.out?.keepFull) continue;
    for (const k of READERS[r.key].trims) {
      if (keep.has(k) || out.includes(k) || NEVER_TRIM.has(k)) continue;
      if ((m[k] ?? "").length < minChars) continue; // 小さい物は外しても得が無い
      out.push(k);
    }
  }
  return out;
}

/** 核に渡す下ごしらえ（読み手の答え）＋削った材料の目次＋核の決まり */
export function digestBlock(results: ReadonlyArray<ReaderResult>, trimmed: ReadonlyArray<MaterialKey>, m: Materials): string {
  const lines: string[] = ["", "【D案: 分野ごとの読み手（下ごしらえ）— 判断はしていない要約。会話履歴（元の文）と食い違えば履歴が正しい】"];
  for (const r of results) {
    if (!r.ok || !r.out || !r.out.points.length) continue;
    lines.push(`■ ${READERS[r.key].ja}`);
    for (const p of r.out.points) lines.push(`- ${p}`);
  }
  if (trimmed.length) {
    lines.push("", "【縮めた材料の目次（上の材料は縮めた形。道を決めるのに元の全文が要る時だけ need_materials で呼び戻す）】");
    for (const k of trimmed) lines.push(`- ${k}: ${MATERIAL_JA[k]}（全文 ${(m[k] ?? "").length}字）`);
  }
  lines.push("", CORE_RULES);
  return `${lines.join("\n")}\n`;
}

/** 核（指揮官）への決まり: 原則の優先の前倒し（8c00271d①）・材料の呼び戻し（cf9ada24） */
export const CORE_RULES = `【D案の核（指揮官）の決まり】
- あなたが最後に決める（返信か・確認の約束か・AIX か・どのボタン×ピッカーか・何を先に答えるか）。読み手の下ごしらえは参考で、食い違えば会話履歴と材料の元の文に戻る。
- 原則の優先順位: 1 正直（嘘・推測で書かない）→ 2 確認の約束（物件ごとに違う事・スタッフしか知らない事）→ 3 一つ一つに答える → 4 即答 → 5 気持ち → 6 次の一手 → 7 形。
  ただし一般的な事・資料や会社の事実・送った物で答えられる事まで確認の約束や AIX にしない（AIX と確認の約束はスタッフしか知らない事・確かめないと分からない事だけ）。
- 縮めた材料の目次の全文が無いと道を決められない時だけ、いつもの JSON の代わりに {"need_materials":["目次の名前",…]} だけを返す（最大3つ・1回だけ）。足りていればいつもの JSON をそのまま返す。`;

/** 核の1回目が材料の呼び戻しか（いつもの JSON でない）。呼び戻せる名前だけ・最大3つ */
export function parseNeedMaterials(o: Record<string, unknown> | null, trimmed: ReadonlyArray<MaterialKey>): MaterialKey[] {
  if (!o) return [];
  const v = o.need_materials;
  if (!Array.isArray(v) || !v.length) return [];
  if (String(o.reply_direction ?? "").trim() || o.turn_contract) return []; // いつもの JSON も出ている＝そちらを使う
  const out: MaterialKey[] = [];
  for (const x of v) {
    const k = String(x ?? "").trim() as MaterialKey;
    if (trimmed.includes(k) && !out.includes(k)) out.push(k);
  }
  return out.slice(0, 3);
}

/** 呼び戻した材料のブロック（2回目の最後に足す） */
export function recalledBlock(keys: ReadonlyArray<MaterialKey>, m: Materials): string {
  const parts = keys.map((k) => `【呼び戻した材料: ${k}（${MATERIAL_JA[k]}）】\n${(m[k] ?? "").trim()}`);
  return `${parts.join("\n\n")}\n\n上の材料を足した。need_materials はもう使えない。いつもの JSON（全部の欄）を返す。`;
}

/**
 * 核に渡す素の入力（今の customerSpecificText と同じ並び・削った材料を外し、下ごしらえを会話履歴の前に置く）。
 *   historyTail は「\n\n会話履歴（…）:\n<履歴>」の形（brain-core の今の文字のまま）
 */
export function buildCoreUserText(m: Materials, trimmed: ReadonlyArray<MaterialKey>, digest: string, historyTail: string, replace: Materials = {}): string {
  const body = MATERIAL_KEYS.map((k) => (trimmed.includes(k) ? replace[k] ?? "" : m[k] ?? "")).join("");
  return `${body}${digest}${historyTail}`;
}

// ── 核を勝たせる（8c00271d②）: 2段の約束の上書きを核の turn_contract で決める ───────────────
/**
 * D案の時、2段の約束（物件・確認・見積の AIX → 約束の返信）を当てるか。核の turn_contract に依頼があり、核が約束（route=promise）を1つも言っていなければ
 *   当てない（核の道のまま）。依頼が無い・核も約束と言っている時は今まで通り（安全側）。
 *   返り値 replyOnly: 核が AIX も約束も言わず閉じる番でもない（＝答える返信）→ AIX を外して返信
 */
export function coreOverTwoStage(raw: unknown): { demote: boolean; replyOnly: boolean } {
  if (!raw || typeof raw !== "object") return { demote: false, replyOnly: false };
  const r = raw as { asks?: unknown; close_only?: unknown };
  const asks = Array.isArray(r.asks) ? (r.asks as Array<Record<string, unknown>>) : [];
  if (!asks.length) return { demote: false, replyOnly: false };
  if (asks.some((a) => a?.route === "promise")) return { demote: false, replyOnly: false };
  const close = r.close_only === true || r.close_only === "true";
  const anyAix = asks.some((a) => a?.route === "aix");
  return { demote: true, replyOnly: !anyAix && !close };
}

// ── 費用の見込み（記録だけ） ───────────────────────────────────────────
/** Claude（今の核のモデル）で払う素の入力の見込み（字→トークンは実測の比で）。記録の比べ用 */
export function estimateCoreSavings(fullChars: number, sentChars: number, tokPerChar: number, inUsdPerM = 2): { savedTok: number; savedUsd: number } {
  const savedTok = Math.max(0, Math.round((fullChars - sentChars) * tokPerChar));
  return { savedTok, savedUsd: (savedTok * inUsdPerM) / 1e6 };
}

// ── AIX のボタン一覧の縮め（2周目） ───────────────────────────────────────
/** 一覧に出てくる値（ボタンのキー・ピッカーの値）を読み手の答えから拾う */
export function catalogPicks(catalog: string, points: ReadonlyArray<string>): string[] {
  const known = new Set<string>();
  for (const m of catalog.matchAll(/^- ([a-z_]+)【/gm)) known.add(m[1]);
  for (const m of catalog.matchAll(/（([a-z_:]+)）/g)) known.add(m[1]);
  const out: string[] = [];
  for (const p of points) for (const m of p.matchAll(/[a-z][a-z_:]*[a-z_]/g)) {
    const tok = m[0];
    if (known.has(tok) && !out.includes(tok)) out.push(tok);
    // 「after:apply」の形の値も、前の部分（after）だけの値も拾う
    for (const part of tok.split(":")) if (known.has(part) && !out.includes(part)) out.push(part);
  }
  return out;
}
/**
 * 核に渡す縮めた一覧: 決め方（①〜⑤）と見出しはそのまま・ボタンとピッカーは名前と値だけ・読み手の候補（picks）に当たるボタン／ピッカーの行は全文。
 *   「誰に確認したか」「結果のピッカー」は短く大事なので全文のまま。場面の外のボタンの1行もそのまま
 */
export function compactCatalog(catalog: string, picks: ReadonlyArray<string>): string {
  const pick = new Set(picks);
  const out: string[] = [];
  let entered = false, btnPicked = false;
  for (const line of String(catalog ?? "").split("\n")) {
    const b = /^- ([a-z_]+)(【[^】]*】)/.exec(line);
    if (b) {
      entered = true;
      btnPicked = pick.has(b[1]);
      out.push(btnPicked || /^- 今の場面の外/.test(line) ? line : `- ${b[1]}${b[2]}`);
      continue;
    }
    if (!entered || /^- /.test(line)) { out.push(line); continue; }
    const pk = /^(\s+・.*?（([a-z_:]+)）)/.exec(line);
    if (pk) { out.push(pick.has(pk[2]) ? line : pk[1]); continue; }
    if (/^\s+・(?:結果のピッカー|誰に確認したか)/.test(line) || btnPicked) { out.push(line); continue; }
    // その他の細目（押された実績 等）は候補のボタンの時だけ
  }
  return `${out.join("\n")}\n（D案: 細目の説明は読み手が候補に挙げた物だけ全文。他は名前と値だけ＝全文が要る時は need_materials の aixCatalog）\n`;
}

// ── 3周目: AIX のボタン一覧は「場面」で縮める（読み手の候補で縮めない＝候補への偏りを作らない） ─────────────────────
/** 場面の読みが弱くて全部のピッカーの細目を出した一覧か（それ以外の一覧は既に場面で絞ってある＝縮めない） */
export function isUncertainFullCatalog(catalog: string): boolean {
  return /【AIX のボタン×ピッカー（場面の読みが弱いので全部）/.test(String(catalog ?? ""));
}
/**
 * 核に渡す縮めた一覧（3周目）:
 *   - 決め方（①〜⑤）・見出し・全部のボタンの行（送る情報・線・使う時）はそのまま
 *   - 今の場面のボタン（sceneButtons）はピッカーの細目まで全文
 *   - 場面の外のボタンのピッカーは「名前（値）」だけ。ただし返信か AIX かの決まり（「返信」を含む｜の句）・押された実績・結果のピッカー・誰に確認したかは残す
 */
export function compactCatalogByScene(catalog: string, sceneButtons: ReadonlyArray<string>): string {
  const scene = new Set(sceneButtons);
  const out: string[] = [];
  let entered = false, inScene = false;
  for (const line of String(catalog ?? "").split("\n")) {
    const b = /^- ([a-z_]+)【/.exec(line);
    if (b) { entered = true; inScene = scene.has(b[1]); out.push(line); continue; }
    if (!entered || /^- /.test(line) || inScene) { out.push(line); continue; }
    if (/^\s+・(?:結果のピッカー|誰に確認したか|押された実績)/.test(line)) { out.push(line); continue; }
    const pk = /^(\s+・.*?（[a-z_:]+）)[:：]?(.*)$/.exec(line);
    if (pk) {
      const reply = pk[2].split("｜").slice(1).filter((x) => /返信/.test(x));
      out.push(reply.length ? `${pk[1]}｜${reply.join("｜")}` : pk[1]);
      continue;
    }
    out.push(line);
  }
  return `${out.join("\n")}\n（D案: 今の場面の外のボタンのピッカーは名前と値（と返信の決まり）だけ＝細目の全文が要る時は need_materials の aixCatalog）\n`;
}
/** 核が選んだ AIX のボタンが、細目を縮めたボタンか（＝細目を見ずに選んだ食い違い → 一覧の全文を足して読み直す） */
export function pickedCompressedButton(aix: unknown, sceneButtons: ReadonlyArray<string>, catalog: string): boolean {
  const a = String(aix ?? "").trim();
  if (!/^[a-z_]+$/.test(a)) return false;
  if (sceneButtons.includes(a)) return false;
  return new RegExp(`^- ${a}【`, "m").test(String(catalog ?? ""));
}
