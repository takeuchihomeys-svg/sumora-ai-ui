// app/lib/parallel-search.ts
// 「主の一手＋並行でほかも探す」の場面を決定論で決める（純関数・DB 依存なし）。四者同名の元:
//   ブレインのプロンプト（buildParallelSearchBrainNote）・ブレインの出力の後処理（resolveParallelSearchOutput）・
//   返信生成の材料（buildParallelSearchReplyNote）・最終チェックの免除（final-check runProposalChecks が brainStrategy.parallel_search を見る）。
//
// 2026-09-26 竹内「内覧終了して別の物件に切り替えるなら切り替える・その物件も候補にしてほかも探す／申込して部屋抑えながらほかも探す
//   ／いつまで1つの物件にとらわれないようになっているか。弱いなら強化」
// 実データ（scripts/audit-switch-scenes.ts・180日・設計知見「1つの物件へのとらわれは…1手しか出せない」）:
//   スタッフは同じターンで『今のお部屋を進める（申込・見積・確認）』と『ほかも探す』を両方する回が 18〜35%
//   （内覧後に別の物件 33%・申込後に他も見る 31%・沈黙から戻る 34%・紹介できない物件の後 55%）。ブレインは45件中 両方0。
//   内覧後のお礼（180日 49通）: 申込の一文 28・引き続き探す 25・両方 8（成約した会話の5通は 申込の一文3・引き続き探す4・両方2）。
//   → 過半数ではないので**決まりにしない**（必須にしない）。場面を材料として渡し、並行で探すかはブレインが決める。
// 2026-09-26 反証（scripts/audit-customer-state.ts CS-5・直近60日の全ターンを「その時点の状況」で）: 内覧後・申込中の**全部の**ターンでは
//   スタッフが同じターンで両方したのは 7%・5%（場面の外 9%）で、大半は今のお部屋を進めるだけ（45%・39%）だった。
//   → 内覧後・申込中・しばらくぶりは、お客様の連投に**ほかのお部屋に目を向けるきっかけ**（hasParallelTrigger）がある時だけ場面にする。
//     それでも両方は 11%・7%（しばらくぶり＋きっかけ 38%・8件）で、進めるだけが 6割 → 材料にはこの実数をそのまま書き、ブレインが既定で false に倒れるようにする
//     AIX（主の一手）は今まで通り1つ。並行で探す時は 2つ目の AIX（alt_actions）に物件ピックアップを並べる＝既存の「探す約束の時に物件オススメも並べる」を広げた形。
import type { CustomerState } from "./customer-state";

export type ParallelSearchScene = "after_viewing" | "applying" | "rank_waiting" | "returned_after_silence";
export const PARALLEL_SEARCH_SCENE_LABEL: Record<ParallelSearchScene, string> = {
  after_viewing: "内覧後", applying: "申込中（お部屋を抑えている）", rank_waiting: "番手待ち（2番手以降・繰り上がり待ち）", returned_after_silence: "しばらくぶりに戻ってきた",
};
/** 場面ごとのスタッフの動き（CS-5・直近60日・同じターンで。n が小さい物は参考） */
const SCENE_BOTH_RATE: Record<ParallelSearchScene, string> = {
  after_viewing: "両方 11%・探すだけ 18%・今のお部屋を進めるだけ 61%（56ターン）",
  applying: "両方 7%・今のお部屋を進めるだけ 63%（60ターン）",
  rank_waiting: "両方 0%・探すだけ 20%・進めるだけ 60%（10ターン・参考）",
  returned_after_silence: "両方 38%・進めるだけ 63%（8ターン・参考）",
};

export type ParallelSearchContext = {
  scene: ParallelSearchScene | null;
  /** 場面の根拠（日本語の一言） */
  evidence: string | null;
  /** 並行で探す場面ではない理由（成約・見送り・お客様が探すのをやめると言った） */
  blockedBy: string | null;
};

/** スタッフの「2番手・繰り上がり待ち」の言葉（「1番手でお申込み可能」は含めない） */
export const RANK_WAITING_RE = /[2-9２-９二三]番手|繰り上が/;
/** お客様が「ほかはもう探さなくてよい」と言った */
export const STOP_SEARCH_RE = /(?:他|ほか)(?:の(?:お部屋|物件))?(?:は|も)?(?:もう)?(?:大丈夫|結構|いらない|要らない|探さなくて)|探さなくて(?:大丈夫|いい|良い)|(?:ここ|こちら)(?:に|で)(?:決め|決まり)(?:ました|ます)/;

const DAY = 86_400_000;

export function resolveParallelSearchScene(input: {
  state: Pick<CustomerState, "stage" | "viewings"> | null;
  /** まだスタッフが応えていないお客様の連投 */
  customerTurnText: string;
  /** 前のお客様のターンより後〜今回までのこちらの本文（72時間以内） */
  recentStaffTexts: string[];
  /** 今回のお客様のターンの直前の発言（どちらでも）からの日数。分からなければ null */
  silenceDays: number | null;
  nowMs?: number;
}): ParallelSearchContext {
  const s = input.state;
  const none = (blockedBy: string | null = null): ParallelSearchContext => ({ scene: null, evidence: null, blockedBy });
  if (!s) return none();
  if (s.stage === "won") return none("成約");
  if (s.stage === "dropped") return none("見送り・他社決定");
  if (s.stage === "first" || s.stage === "searching") return none(); // まだ主のお部屋が無い（探すのが主の一手）
  if (STOP_SEARCH_RE.test(input.customerTurnText.normalize("NFKC"))) return none("お客様がこのお部屋に決めた・ほかは探さなくてよいと言った");
  const now = input.nowMs ?? Date.now();
  if (input.recentStaffTexts.some((t) => RANK_WAITING_RE.test((t ?? "").normalize("NFKC")) && !/1番手/.test(t ?? ""))) {
    return { scene: "rank_waiting", evidence: "こちらが2番手・繰り上がり待ちを伝えた後", blockedBy: null };
  }
  // 内覧後・申込中・しばらくぶりは、お客様のきっかけ（別の物件・URL/画像・探す・条件・迷い・比べる）がある時だけ（上の反証）
  const trigger = hasParallelTrigger(input.customerTurnText);
  if (!trigger) return none();
  if (s.stage === "applying" || s.stage === "apply_prep") return { scene: "applying", evidence: s.stage === "applying" ? "申込・審査中" : "申込の準備中（フォームあり）", blockedBy: null };
  const recentDone = s.viewings.filter((v) => v.status === "done" && Date.parse(`${v.ymd}T12:00:00+09:00`) >= now - 14 * DAY);
  if (s.stage === "viewed" || recentDone.length) {
    const v = recentDone.at(-1);
    return { scene: "after_viewing", evidence: v ? `${Number(v.ymd.slice(5, 7))}/${Number(v.ymd.slice(8, 10))}${v.name ? ` ${v.name}` : ""}の内覧の後` : "内覧の後", blockedBy: null };
  }
  if (input.silenceDays != null && input.silenceDays >= 7) return { scene: "returned_after_silence", evidence: `${Math.floor(input.silenceDays)}日ぶり`, blockedBy: null };
  return none();
}

/**
 * ブレインに渡す材料（毎回変わる所）。場面が無ければ空文字。
 * 決まりにしない: 「並行で探せ」とは書かず、場面の事実とスタッフの実績を渡し、出すかどうかを JSON の項目で答えさせる
 */
export function buildParallelSearchBrainNote(ctx: ParallelSearchContext): string {
  if (!ctx.scene) return "";
  return `\n【並行で探すかの判断（場面の材料・決定論）】場面: ${PARALLEL_SEARCH_SCENE_LABEL[ctx.scene]}（${ctx.evidence ?? ""}）。` +
    `お客様の発言に、ほかのお部屋に目を向けるきっかけ（別の物件・探す・条件・迷い）がある。この場面のスタッフの動き: ${SCENE_BOTH_RATE[ctx.scene]}＝多くは今のお部屋を進めるだけで、両方は少数。` +
    `AIX（aix）は今まで通り主の一手を1つだけ選ぶ。そのうえで、ほかのお部屋も並行して探すのがこのお客様に良いかを判断し、出力 JSON に "parallel_search"（true/false）と "parallel_search_reason"（20字以内）を足す。` +
    `既定は false。お客様がほかのお部屋も見たい・今のお部屋に引っかかり（条件・費用・立地）があって迷っている時だけ true。今のお部屋に気持ちが固まっている・ほかは要らないと言った・手続きの連絡だけの時は false。`;
}

export type ParallelSearchOutput = { on: boolean; reason: string | null; scene: ParallelSearchScene | null };

/** 探す AIX（主の一手がすでに探す物なら並行の印は要らない） */
export const SEARCH_AIX = new Set(["property_send", "property_recommendation"]);

/**
 * ブレインの出力（parallel_search / parallel_search_reason）の後処理。場面の外では出さない（場面を決定論で絞る）。
 * 主の一手がすでに物件の送付なら並行は付けない。付けた時は 2つ目の AIX に物件ピックアップを並べる（重複は足さない）
 */
export function resolveParallelSearchOutput(
  ctx: ParallelSearchContext,
  llm: { parallel_search?: unknown; parallel_search_reason?: unknown },
  mainAix: string | null,
  altActions: string[] | undefined,
): { parallel: ParallelSearchOutput | undefined; altActions: string[] | undefined } {
  if (!ctx.scene) return { parallel: undefined, altActions };
  const on = llm.parallel_search === true && !(mainAix && SEARCH_AIX.has(mainAix));
  const reason = typeof llm.parallel_search_reason === "string" && llm.parallel_search_reason.trim() ? llm.parallel_search_reason.trim().slice(0, 40) : null;
  const parallel: ParallelSearchOutput = { on, reason, scene: ctx.scene };
  if (!on) return { parallel, altActions };
  const alts = [...(altActions ?? [])];
  if (!alts.some((a) => SEARCH_AIX.has(a))) alts.push("property_send");
  return { parallel, altActions: alts };
}

/**
 * 返信生成に渡す材料（許可であって指示ではない）。言い回しは実送信から（2026-09-26 測定: 内覧後のお礼 180日49通の「引き続き」の行で一番多いのは
 *   「引き続き新着でおすすめできる物件が出次第ご連絡させて頂きます！（！）」6通・「…お送りさせて頂きます」4通。成約した会話の内覧後のお礼5通は 申込の一文3・引き続き探す4・両方2）。
 * 「〇〇の1文を添えろ」型にしない（feedback_no_invented_phrases）: 添えてよい・添えなくてもよい、と書く
 */
export function buildParallelSearchReplyNote(p: ParallelSearchOutput | null | undefined): string {
  if (!p?.on) return "";
  return `\n【並行で探す（ブレインの判断・材料）】${p.scene ? PARALLEL_SEARCH_SCENE_LABEL[p.scene] : ""}の場面で、ブレインは今のお部屋を進めながら、ほかのお部屋も並行して探すと判断した${p.reason ? `（${p.reason}）` : ""}。` +
    `本文の最後に、引き続き探す一文を添えてもよい（添えなくてもよい）。実送信（内覧後のお礼）で一番多い形は「引き続き新着でおすすめできる物件が出次第ご連絡させて頂きます！！」（「お送りさせて頂きます」も同じ意味で使われる）。` +
    `今のお部屋の話（申込・見積・内覧・確認）が主で、探す一文は添える形にする（今のお部屋をやめる書き方にしない）。`;
}

/** メッセージ（新しい順）から場面の材料を作る: まだ応えていないお客様の連投・その直前のこちらの連投（72時間以内）・連投の前の間（日数） */
export function parallelSearchInputsFromMessages(newestFirst: ReadonlyArray<{ sender: string; text: string | null; created_at: string }>): { customerTurnText: string; recentStaffTexts: string[]; silenceDays: number | null } {
  const turn: string[] = [];
  let i = 0;
  let t0: number | null = null;
  for (; i < newestFirst.length && newestFirst[i].sender === "customer"; i++) {
    turn.unshift(newestFirst[i].text ?? "");
    const t = Date.parse(newestFirst[i].created_at);
    if (Number.isFinite(t)) t0 = t;
  }
  const before = newestFirst[i];
  const silenceDays = t0 != null && before && Number.isFinite(Date.parse(before.created_at)) ? (t0 - Date.parse(before.created_at)) / DAY : null;
  const staff: string[] = [];
  const ref = t0 ?? (newestFirst[0] ? Date.parse(newestFirst[0].created_at) : NaN);
  for (let j = i; j < newestFirst.length && newestFirst[j].sender !== "customer"; j++) {
    const t = Date.parse(newestFirst[j].created_at);
    if (Number.isFinite(ref) && Number.isFinite(t) && ref - t > 72 * 3600_000) break;
    staff.push(newestFirst[j].text ?? "");
  }
  return { customerTurnText: turn.join("\n"), recentStaffTexts: staff, silenceDays };
}

/**
 * お客様の連投に、ほかのお部屋にも目を向けるきっかけがあるか（別の物件・物件の URL や画像・探す・条件の見直し・迷い・比べる）。
 * 2026-09-26 反証（scripts/audit-customer-state.ts CS-5・60日の全ターンをその時点の状況で）: 内覧後・申込中の**全部の**ターンでは、
 *   スタッフが同じターンで両方した割合は 8%・5%（場面の外 10% より低い）で、大半は今のお部屋を進めるだけだった。
 *   調査2 の 31〜33% は「内覧後に別の物件の話が出た」「申込後に他の物件も見る」＝お客様のきっかけがある回だけの数字 → きっかけがある時だけ場面にする
 */
export const PARALLEL_TRIGGER_RE = /(?:別の|他の|ほかの|違う|もう一(?:つ|件)の)(?:物件|お部屋|部屋|マンション)|(?:他|ほか)(?:にも|も)[^。\n]{0,8}(?:ある|あり|見|探|気にな|紹介|送)|引き続き|並行して|(?:予算|家賃|上限|エリア|間取り|条件|入居)[^。\n]{0,12}(?:変|上げ|下げ|広げ|緩|追加|見直|でも(?:大丈夫|いい|良い|可))|迷って|悩んで|迷い|悩み|考え(?:させ|たい|ます|中)|検討(?:させ|したい|します|中)|比較|比べ|https?:\/\/|\[画像\]/;
export function hasParallelTrigger(customerTurnText: string): boolean {
  return PARALLEL_TRIGGER_RE.test((customerTurnText ?? "").normalize("NFKC"));
}
