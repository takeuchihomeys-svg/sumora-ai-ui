// app/lib/search-result-split.ts — 物件を探す番の AIX を「物件あった場合｜物件なかった場合」の左右に分けて並べる（純関数・画面とサーバーの共用・依存なし）
//
// 2026-10-13 竹内さん（会話「KAORI」の画面: 締めた後に AIX【全力サポート】（上・橙）と【物件ピックアップ】（下・緑）が縦に2つ）:
//   「左右にボタンを分ける。物件あった場合と物件なかった場合と上に小さく記載。複数あった場合が物件ピックアップ、1件の場合が物件オススメ、
//    物件なかった場合が全力サポートとなる。そうすれば分かりやすいしスタッフも押しやすい」
//   「物件あった場合のところは横並びではなくて縦並びにする」「レイアウトもスマホで使いやすいようにする」
//    物件あった場合            │ 物件なかった場合
//    [物件ピックアップ（複数）] │ [AIX 全力サポート]
//    [物件オススメ（1件）]      │
//   背景: 新着があるかどうかは探したスタッフにしか分からない（P0 4b744a33 スタッフだけが知る事は AIX）→ ブレインがどちらかに決め打ちせず、
//   3つを分かりやすく並べてスタッフが検索の結果で押す。
//
// ブレイン基準（P0 9eb6aa9c・P1 0593a0aa）: 出す・出さないはブレインの判断だけで決める＝ブレインの一手（action）が物件を探す番の AIX
//   （物件ピックアップした・物件オススメ・物件を探す・全力サポート）の時。語・件数・出し切りの印で画面が独自に決めない。
//   2択（AIX か返信か two_choice_mode）は別のカードのまま。
// サーバー側（brain-core）: 出し切りの印で一手を【全力サポート】に書き換えていた所（search-exhausted.applySearchExhausted）は、
//   この左右の形が出る時は書き換えずに、一手をブレインの物件の AIX のままにして【全力サポート】を2つ目に並べる（applySearchSplit）。
// 戻す: 画面 NEXT_PUBLIC_SEARCH_SPLIT_CHOICE=off（今まで通りの縦並び）／サーバー SEARCH_SPLIT_CHOICE=off（出し切りで全力サポートに書き換える旧の動き）
// テスト: app/lib/__tests__/search-result-split.test.ts

/** 物件を探す番の AIX（ブレインの一手がこのどれかなら左右の形） */
export const SPLIT_TRIGGER_AIX: ReadonlySet<string> = new Set(["property_send", "property_recommendation", "property_search", "zenryoku_support"]);
/** 左右の形に並べる3つ（これ以外の2つ目の AIX は下に今まで通り並べる） */
export const SPLIT_OWN_AIX: ReadonlySet<string> = new Set(["property_send", "property_recommendation", "zenryoku_support", "property_search"]);

export type SplitButton = {
  action: "property_send" | "property_recommendation" | "zenryoku_support";
  /** ボタンの1行目（大きい字） */
  label: string;
  /** ボタンの2行目（小さい字・どの時に押すか） */
  sub: string;
  /** ブレインの一手と同じボタンか（並びも色も変えない。記録・テスト用） */
  isBrain: boolean;
};

export type SearchSplitView = {
  /** 左の見出し */
  foundHeading: string;
  /** 右の見出し */
  notFoundHeading: string;
  /** 左（縦並び）: 物件ピックアップ（複数）・物件オススメ（1件） */
  found: [SplitButton, SplitButton];
  /** 右: 全力サポート。ブレインが全力サポートを候補にした番（一手が全力サポートか、2つ目に入れた）だけ。新規の番は null（左だけ） */
  notFound: SplitButton | null;
  /** 左右の3つ以外の2つ目の AIX（下に今まで通り並べる） */
  others: string[];
};

export function searchSplitViewEnabled(off?: boolean): boolean {
  return !off;
}

export function searchSplitServerEnabled(env: Record<string, string | undefined> = typeof process !== "undefined" ? process.env : {}): boolean {
  return (env.SEARCH_SPLIT_CHOICE ?? "").trim().toLowerCase() !== "off";
}

/** ブレインの一手が物件を探す番か（左右の形を出すか）。2択（AIX か返信か）の判断は別のカード */
export function isSearchSplitTurn(o: { brainAction: string | null | undefined; twoChoiceMode?: boolean | null; off?: boolean }): boolean {
  if (!searchSplitViewEnabled(o.off)) return false;
  if (o.twoChoiceMode) return false;
  return !!o.brainAction && SPLIT_TRIGGER_AIX.has(o.brainAction);
}

/**
 * 画面のブレインのカードを左右の形で出すなら、その中身。出さない番は null（今まで通りの縦並び）。
 *   ボタンの順と色は一手に関係なく固定（左上＝物件ピックアップ・左下＝物件オススメ・右＝全力サポート）。押し間違えないよう位置を毎回同じにする。
 */
export function searchSplitView(o: { brainAction: string | null | undefined; altActions?: ReadonlyArray<string> | null; twoChoiceMode?: boolean | null; off?: boolean }): SearchSplitView | null {
  if (!isSearchSplitTurn(o)) return null;
  const a = o.brainAction ?? "";
  const others = (o.altActions ?? []).filter((x, i, arr) => x !== a && !SPLIT_OWN_AIX.has(x) && arr.indexOf(x) === i);
  // 2026-10-13 竹内さんの決定（B）「新規のときには使わない。新着物件のところや、他に物件あるのかの部分で使う」:
  //   右（全力サポート）はブレインが候補にした時だけ（一手が全力サポート・2つ目に全力サポート）。画面は語・件数で決めない
  const right = zenryokuShown({ brainAction: a, altActions: o.altActions });
  return {
    foundHeading: "物件あった場合",
    notFoundHeading: "物件なかった場合",
    found: [
      { action: "property_send", label: "AIX 物件ピックアップ", sub: "複数あった時", isBrain: a === "property_send" || a === "property_search" },
      { action: "property_recommendation", label: "AIX 物件オススメ", sub: "1件の時", isBrain: a === "property_recommendation" },
    ],
    notFound: right ? { action: "zenryoku_support", label: "AIX 全力サポート", sub: "新着が出次第お送り", isBrain: a === "zenryoku_support" } : null,
    others,
  };
}

/** 右（全力サポート）を出すか＝ブレインが全力サポートを候補にしたか（一手か2つ目） */
export function zenryokuShown(o: { brainAction: string | null | undefined; altActions?: ReadonlyArray<string> | null }): boolean {
  return o.brainAction === "zenryoku_support" || (o.altActions ?? []).includes("zenryoku_support");
}

/** 左右の形の番のブレインのメモに付ける一文（決め打ちしない言い方）。右が無い番（新規）は全力サポートに触れない */
export const SEARCH_SPLIT_NOTE = "（検索の結果で押す: 物件あった場合＝複数は AIX【物件ピックアップ】・1件は AIX【物件オススメ】／物件なかった場合＝AIX【全力サポート】）";
export const SEARCH_SPLIT_NOTE_LEFT = "（検索の結果で押す: 複数あった時は AIX【物件ピックアップ】・1件の時は AIX【物件オススメ】）";
export function searchSplitNote(o: { brainAction: string | null | undefined; altActions?: ReadonlyArray<string> | null }): string {
  return zenryokuShown(o) ? SEARCH_SPLIT_NOTE : SEARCH_SPLIT_NOTE_LEFT;
}
/** 出し切りの印がある時に足す一文（前に送った物件の印がある＝新着が無ければ右。決め打ちはしない） */
export const SEARCH_SPLIT_EXHAUSTED_NOTE = "（前に今の条件の物件を送っている＝新着が見つからなければ右の AIX【全力サポート】）";
/** 返信（ピックアップの約束）を AIX の番に移した時の返信の方向（AIX の番なので下書きは作らないが、記録・本質の材料に残す） */
export const SEARCH_SPLIT_DIRECTION = "検索の結果で決める番: 送れる物件があれば物件の AIX（複数＝物件ピックアップ・1件＝物件オススメ）、今の条件に合うお部屋が無ければ AIX【全力サポート】（新着が出次第お送りする約束）";

/**
 * 2026-10-13 レビュー（重要2・P0「判断はすべてブレイン基準」）: 出し切りの印と左右の形をブレインの材料にする1行（LLM の前・印が無ければ空）。
 *   答え（返信か AIX か・どの AIX か）は書かない。印（いつ・どの文・明示の印か送付だけか）と、AIX にした時に画面がどう並べるか（事実）だけ。
 */
export function splitMaterialLine(r: { exhausted: boolean; markerAt: string | null; strength?: "strong" | "weak" | null; markerText?: string | null }): string {
  if (!r.markerAt) return "";
  const q = Array.from(String(r.markerText ?? "").replace(/\s+/g, " ")).slice(0, 40).join("");
  const when = r.markerAt.slice(0, 16).replace("T", " ");
  const screen = "物件を求められた番で AIX にした時、画面は左に「物件あった場合＝AIX【物件ピックアップ】（複数）・AIX【物件オススメ】（1件）」を並べ、あなたが zenryoku_candidate=true にした時だけ右に「物件なかった場合＝AIX【全力サポート】」も並べる。どれを押すかは探したスタッフが検索の結果で決める";
  if (r.exhausted && r.strength === "strong") {
    return `【出し切りの材料】${when}（UTC）にこちらが今の条件の物件を出し切ったと言った印${q ? `（「${q}」）` : "（AIX【全力サポート】）"}があり、その後お客様は条件を広げていない。${screen}。返信にするか AIX にするかは、お客様の今の言葉と会話からあなたが決める`;
  }
  return `【出し切りの材料】${when}（UTC）に物件を送った・送付を報告した${q ? `（「${q}」）` : "（AIX の物件の送付）"}。1回送っただけで、今の条件を出し切ったと言った印（「全てピックアップさせて頂きました」・新着待ちの約束・AIX【全力サポート】）は無い。${screen}。返信にするか AIX にするかは、お客様の今の言葉と会話からあなたが決める`;
}

/**
 * 2026-10-13 レビュー（重要2・P0）: ブレイン（または2段の規則）が返信を選んだ出し切りの番を、規則で AIX の番に移すか。
 *   明示の印（strong）の時だけ gate()（override-demote の search_exhausted 族・BRAIN_DEMOTE_SEARCH_EXHAUSTED=on で記録だけ＝false）に任せる。
 *   送付だけの印（weak）は移さず record()（食い違いの記録）だけ。
 *   strong を残す理由: 出し切り7問の試験（DeepSeek）で、材料だけ（BRAIN_DEMOTE_SEARCH_EXHAUSTED=on）だと道 7→2・材料＋strong だけ移す形でも 7→3
 *   （2段のピックアップの約束に戻る。実送信は新着待ち）。
 * 10/13（試験の分解）: その約束の多く（4/5）は LLM 自身は物件の AIX を選び、2段の規則（two_stage_promise）が約束の返信に書き換えた番だった。
 *   llmAixIsProperty＝LLM が最初に物件の AIX を選んでいた → ブレイン自身の答えに戻す（規則の上書きを外すだけ・食い違いの記録は要らない）。
 */
/**
 * 10/13 レビュー（重要）: LLM の物件の AIX に戻してよい番か＝2段の規則（two_stage…pickup）が約束の返信に書き換えた番だけ。
 *   条件の言い直しへの返信（replyCondTurn）は、別の規則（お客様が先に送ってくる番・送った物件の契約条件の質問・お客様の情報待ち・
 *   入居がだいぶ先・初回の聞き取りを続ける番 等）が物件の AIX を消した判断なので戻さない（強い印なら gate・送付だけなら記録だけ）
 */
export function llmAixRestorable(o: { twoStagePickup: boolean; llmAix: string | null | undefined }): boolean {
  return o.twoStagePickup && !!o.llmAix && ["property_send", "property_recommendation", "property_search"].includes(o.llmAix);
}

export function splitReplyToAix(o: { strength: "strong" | "weak" | null; llmAixIsProperty?: boolean; gate: () => boolean; record: () => void }): boolean {
  if (o.llmAixIsProperty) return true;
  if (o.strength === "strong") return o.gate();
  o.record();
  return false;
}

/**
 * brain-core の出し切りの所に当てる（applySearchExhausted の代わり）。
 *   出し切りの印がある番で、ブレインの一手が物件の AIX → 一手はそのまま・【全力サポート】を2つ目に足す（書き換えない）。
 *   ブレインが返信（2段のピックアップの約束・条件の言い直しへの返信）にしていた番で、splitReplyToAix が true の時だけ → AIX の番にし、
 *     一手は LLM が最初に選んだ物件の AIX（無ければ物件ピックアップ）・【全力サポート】を2つ目（旧はここで一手を【全力サポート】に決め打ちしていた）。
 *   申込以降・出し切りでない・SEARCH_SPLIT_CHOICE=off は何もしない（呼ぶ側が旧の applySearchExhausted を使う）。
 */
export function applySearchSplit(o: {
  finalAix: string | null;
  /** ブレインが返信にしていた番（2段の pickup の約束・条件の言い直しへの返信） */
  fromReply: boolean;
  /** LLM が最初に選んだ AIX（決定論の規則で変わる前・llm_raw.action） */
  llmAix?: string | null;
  altActions: string[] | undefined;
  exhausted: boolean;
  postApply: boolean;
  /** ブレインが全力サポートを候補にしたか（LLM の zenryoku_candidate）。false なら右（全力サポート）を足さない（10/13 竹内さんの決定 B） */
  zenryokuCandidate?: boolean;
  env?: Record<string, string | undefined>;
}): { applies: boolean; finalAix: string | null; altActions: string[] | undefined; toAix: boolean } {
  const keep = { applies: false, finalAix: o.finalAix, altActions: o.altActions, toAix: false };
  if (!searchSplitServerEnabled(o.env) || o.postApply || !o.exhausted) return keep;
  const PROP = ["property_send", "property_recommendation", "property_search"];
  let finalAix = o.finalAix;
  let toAix = false;
  if (o.fromReply && !finalAix) {
    finalAix = o.llmAix && PROP.includes(o.llmAix) ? o.llmAix : "property_send";
    toAix = true;
  }
  if (!finalAix || !PROP.includes(finalAix)) return keep;
  const alts = [...(o.altActions ?? []).filter((x) => x !== finalAix && x !== "zenryoku_support"), ...(o.zenryokuCandidate ? ["zenryoku_support"] : [])];
  return { applies: true, finalAix, altActions: alts, toAix };
}

/**
 * 2026-10-13 竹内さんの決定（B）: ブレインが全力サポートを候補にするための材料（LLM の前・答えは書かない）と、出力の項目の説明。
 *   材料は事実だけ: 前に物件を送ったか（件数・最後の時刻）・出し切りの印・お客様の今の発言がほかの物件／新着を聞いているか（語の網＝候補を拾うだけ）。
 */
// 10/13 レビュー: 「他の物件／他のお部屋／他にも物件・お部屋（がありますか）／他（に）まだありますか／新着」に寄せる。
//   「他に質問はありません」（他に＋別の語）・「このお部屋まだありますか」（1件の募集状況の確認・他が無い）は拾わない
export const OTHER_PROPERTY_ASK_RE = /(?:他|ほか)の(?:物件|お部屋|部屋)|(?:他|ほか)に(?:も)?(?:(?:いい|良い|おすすめの|オススメの)?(?:物件|お部屋|部屋))|(?:他|ほか)(?:に|は)?(?:も)?(?:まだ)?(?:あり|ある|ない|無い)(?:ます|ません|です)?(?:か|\?|？)|新着/;
/**
 * 全力サポートを候補にするかの材料を渡す番か（物件を探す番になりうる時だけ・決定論の網＝候補を拾うだけ）。
 *   条件の場面（もっと探して・条件の変更）／場面の証拠の候補が物件の AIX か全力サポート／お客様が他の物件・新着を聞いた／今送れる候補がある
 */
export function zenryokuCandidateTurn(o: { scene: string | null | undefined; sceneCandidate: string | null | undefined; customerText: string; pickupReady: boolean | null | undefined }): boolean {
  if (o.scene === "conditions") return true;
  if (o.sceneCandidate && (SPLIT_TRIGGER_AIX.has(o.sceneCandidate))) return true;
  if (OTHER_PROPERTY_ASK_RE.test((o.customerText ?? "").normalize("NFKC"))) return true;
  return o.pickupReady === true;
}
export function zenryokuCandidateMaterial(o: { sentPropertyCount: number; lastSentAt: string | null; exhaustLine: string; customerText: string; pickupReady?: boolean | null }): string {
  const asked = OTHER_PROPERTY_ASK_RE.test((o.customerText ?? "").normalize("NFKC"));
  const ready = o.pickupReady === true ? "今送れる物件の候補（売上サポのピックアップ）がある。" : o.pickupReady === false ? "今送れる物件の候補（売上サポのピックアップ）は無い（探してみないと分からない）。" : "";
  const sent = o.sentPropertyCount > 0
    ? `前に物件を送っている（${o.sentPropertyCount}件・最後 ${(o.lastSentAt ?? "").slice(0, 10) || "日付不明"}）`
    : "まだ物件を送っていない（新規）";
  return `\n【全力サポートを候補にするかの材料】${sent}。お客様の今の発言がほかの物件・新着を聞いている: ${asked ? "はい" : "いいえ"}。${ready}${o.exhaustLine ? `${o.exhaustLine}。` : ""}` +
    `物件の AIX（物件ピックアップ・物件オススメ）か全力サポートを選ぶ番では、出力 JSON に "zenryoku_candidate"（true/false）を足す。` +
    `true にするのは、探しても今の条件に合うお部屋が無い事もあり得る番（前に送った物件の後の新着の確認・お客様が「他にありますか」と聞いた番 等）。` +
    `新規（まだ物件を送っていない・初めて探す番）は false（竹内さん: 新規のときには使わない）。true の時、画面は左に物件の AIX・右に AIX【全力サポート】を並べ、スタッフが検索の結果で押す。`;
}
