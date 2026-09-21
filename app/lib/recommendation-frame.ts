// app/lib/recommendation-frame.ts
// AIX【物件オススメ】の「冒頭フレーム」を事実から決める（純関数・DB 依存なし）。
//
// 2026-09-21 竹内「AIXテンプレートでの言い回し、複数物件送った中では
//   『お送りさせて頂きましたお部屋の中でも〜』の言い回しを使ったり、新着物件なら新着物件の言い回しを使う。
//   別のスタッフが送ってる質の悪い言い回しもあるから、そこも含めて改善する。直近の会話をみて。」
//
// ■ なぜここに出したか（2026-09-21）
//   この判定は aix-template-generate（テンプレートを整える経路）の中にしか無く、
//   **AIX ボタン本体（aix/action）では1つも効いていなかった**。
//   実測（scripts/audit-recommendation-frame.ts・直近90日）:
//     AIX【物件オススメ】の生成ログ 693件のうち、シナリオが決まっているのは **74件（10.7%）**。
//     残る 89.3% は「複数送ったか」「新着か」を見ずに書かれていた。
//   設計知見「出口の配線は経路ごとに確かめる — 同じAIXでもテンプレート0%・本体57%になっていた」と
//   まったく同じ構造（今回は逆に、テンプレートにだけ有って本体に無い）。
//   → 判定・ガイド・禁止表現・検査を**1か所**にまとめ、両方の経路が同じ物を見る（四者同名）。
//
// ■ 設計思想（元のコメントをそのまま持ってくる）
//   AIX の文面の「冒頭フレーム」は事実の宣言である（＝送った/送っていない・新着である/ない・
//   条件を広げた/広げていない）。したがって冒頭フレームは検証可能な事実
//   （送付ログの件数・種別・鮮度、直前の空室確認結果、スタッフのピッカー選択）から
//   **ルールベースで確定**させ、LLM には「そのフレームの中でどう書くか（文体・訴求点）」だけを任せる。
//   事実に反する冒頭（1件しか送っていないのに「これまでお送りした中でも」）は
//   顧客からの信頼を最も損なう事故であり、シナリオごとに
//   「使ってよい冒頭」と「絶対に使わない冒頭（リテラル文字列）」の両方を明示する。

export type RecommendationScenario = "compare" | "new_listing" | "alternative" | "followup_single" | "first";

/** 訴求シナリオ判定の材料となる「この会話の物件送付事実」（今回送信分は含めない） */
export type PropertySendFacts = {
  /** 今回のAIX送信より「前」に物件を送付した回数 */
  priorSentPropertyCount: number;
  /** うち「まとめ送付」（property_send＝複数物件を一度に送るAIX）の回数 */
  priorBulkSendCount: number;
  /** うち「1件送付」（property_recommendation＝1件だけ送るAIX）の回数 */
  priorSingleSendCount: number;
  /** 直近の物件送付からの経過時間（時間）。送付実績なしは null */
  hoursSinceLastSend: number | null;
  /**
   * ブレインが知っている「この会話でお送りした**物件の件数**」。
   * ⚠ priorSentPropertyCount は AIX の送付**回数**なので、まとめ送付1回で5件送っても 1 にしかならない。
   *   比較の言い方（お送りした中でも）が使えるかは件数で決まるので、ブレインの件数があればそちらが正
   *   （設計知見「同じ事実に数え方が2つあると、後から足した方だけが新しくなる」）。
   */
  brainSentPropertyCount?: number | null;
};

// 「お送りした中でも」は“複数の中から選んだ”という事実の宣言。1週間以上前の送付を
// 「中でも」で引き合いに出すのは文脈が切れており、お客様側の記憶とも合わない。
export const COMPARE_FRAME_STALE_HOURS = 24 * 7;

/**
 * 「お送りした中でも〜」（比較選択フレーム）を事実として使ってよいかを判定する。
 * 竹内の判断軸: 送った物件が1件のみなら“中でも”ではなく「新着/新たな1件」として紹介するのが正。
 *  - まとめ送付（property_send）が1回でもあれば複数物件を送っている＝比較可能
 *  - 1件送付（property_recommendation）だけの場合は2回以上でようやく「複数送った」と言える
 */
export function canUseCompareFrame(f: PropertySendFacts): boolean {
  // ブレインが物件の件数を知っていればそれで決める。知らない時だけ AIX ログの種別から推定する
  if (typeof f.brainSentPropertyCount === "number") {
    if (f.brainSentPropertyCount < 2) return false;
  } else if (f.priorBulkSendCount === 0 && f.priorSingleSendCount < 2) return false;
  if (f.hoursSinceLastSend !== null && f.hoursSinceLastSend > COMPARE_FRAME_STALE_HOURS) return false;
  return true;
}

export function resolveRecommendationScenario(args: {
  actionType: string | null | undefined;
  pickupType: string | null | undefined;
  checkPattern: string | null | undefined;
  facts: PropertySendFacts;
}): RecommendationScenario | null {
  if (args.actionType !== "property_recommendation") return null;
  const f = args.facts;
  // 送付実績の有無もブレインの件数が正（手打ちで送った物件は AIX ログに残らない）
  const hasPrior = typeof f.brainSentPropertyCount === "number"
    ? f.brainSentPropertyCount > 0
    : f.priorSentPropertyCount > 0;
  // 比較フレームが使えないときの受け皿（送付実績があるなら「初回」も嘘になるため追加提案型へ）
  const nonCompareFallback: RecommendationScenario = hasPrior ? "followup_single" : "first";
  // ① フロントのピッカー選択が最優先（スタッフが明示的に選んだシナリオ）
  if (args.pickupType === "代替ピックアップ") return "alternative";
  // 新着は「新たに募集に出た1件」の宣言。過去の送付実績の有無に関係なく新着フレームが正
  if (args.pickupType === "新着1件" || args.pickupType === "新着まとめ") return "new_listing";
  if (args.pickupType === "新規ピックアップ" || args.pickupType === "初回まとめ") return nonCompareFallback;
  if (args.pickupType === "条件広げピックアップ" || args.pickupType === "条件広げまとめ") return nonCompareFallback;
  // 「探したが空室なし → 1件あった」＝比較型でも新着型でもない
  if (args.pickupType === "現状伝えて1件") return nonCompareFallback;
  // 「継続ピックアップ」＝送付済みの中から1件を推す意図。比較できる実体がなければ降格する
  if (args.pickupType === "継続ピックアップ" || args.pickupType === "継続まとめ") {
    return canUseCompareFrame(f) ? "compare" : nonCompareFallback;
  }
  // ② ピッカー情報なし: 直前の空室確認結果から推定（募集なし/別の部屋なら代替提案の文脈）
  if (args.checkPattern === "unavailable" || args.checkPattern === "alternative") return "alternative";
  // ③ 物件送付実績から推定（比較表現は「複数送った」事実がある場合のみ許可）
  if (!hasPrior) return "first";
  return canUseCompareFrame(f) ? "compare" : "followup_single";
}

export const RECOMMENDATION_SCENARIO_LABELS: Record<RecommendationScenario, string> = {
  compare: "比較選択型（送付済みの複数物件の中から1件を推す）",
  new_listing: "新着型（新たに募集に出た1件を単独で案内する）",
  alternative: "代替新規提案型（指定物件が募集なし→代わりの1件を新規提案）",
  followup_single: "追加提案型（送付実績はあるが比較できる複数はない→新たな1件として提案）",
  first: "初回提案型（初めての1件提案）",
};

// ─── 冒頭フレーム検出（実例フィルタ・生成後ガードで共用する単一ソース）──────────
/** 「既に送った複数物件の中から選んだ」ことを宣言する言い回し */
export const COMPARE_FRAME_RE = /(お送り|ご紹介|送らせて|送付|お渡し)[^。！\n]{0,20}(中でも|中から)/;
/** 「新たに募集が出た」ことを宣言する言い回し */
export const NEW_LISTING_FRAME_RE = /(新着で|新着物件|募集に出ました|募集にでました|募集でました|募集が出ました)/;

export const COMPARE_FRAME_FORBIDDEN = [
  "これまでお送りさせて頂いたお部屋の中でも",
  "お送りさせて頂きましたお部屋の中でも",
  "お送りした中でも",
  "ご紹介したお部屋の中でも",
  "〜の中から選ばせて頂いた",
];
export const NEW_LISTING_FRAME_FORBIDDEN = [
  "新着で1件オススメ出来るお部屋が募集に出ました",
  "新着で〜が募集に出ました",
  "新着物件",
];

/** シナリオごとの「絶対に使ってはいけない冒頭表現」（プロンプトへリテラルで明示する） */
export const RECOMMENDATION_FORBIDDEN_OPENINGS: Record<RecommendationScenario, string[]> = {
  compare: NEW_LISTING_FRAME_FORBIDDEN,
  new_listing: COMPARE_FRAME_FORBIDDEN,
  alternative: [...COMPARE_FRAME_FORBIDDEN, ...NEW_LISTING_FRAME_FORBIDDEN],
  followup_single: [...COMPARE_FRAME_FORBIDDEN, ...NEW_LISTING_FRAME_FORBIDDEN],
  first: [...COMPARE_FRAME_FORBIDDEN, ...NEW_LISTING_FRAME_FORBIDDEN],
};

export const RECOMMENDATION_SCENARIO_GUIDES: Record<RecommendationScenario, string> = {
  compare: `【シナリオ: 比較選択型】既にお送りした複数物件の中から1件を特に推す文脈。
・送付済みリストとの相対比較で「この1件が頭抜けている」特別感を演出する（冒頭の具体的な言い回しは⭐実例の文体から学んで多様に書くこと）
・CTAは内覧誘導または申込誘導（中程度の強度）
・🚫「新着で〜募集に出ました」等、新たに募集が出たことを宣言する表現は使わない（既送付物件からの選定であり新着の宣言は事実と異なる）
・ただし会話履歴に「複数物件を送った形跡」が見当たらない場合は比較表現は使わないこと`,
  new_listing: `【シナリオ: 新着型】新たに募集に出た物件を1件だけ単独でご案内する文脈。過去に何件お送りしていても、この1件は「新しく募集に出た1件」として紹介する。
・冒頭は「新着で1件（お客様の実名）さんにオススメ出来るお部屋が募集に出ました！！」のように“新たに募集が出た1件である”ことを宣言する（名前は実名に置き換える。言い回しは⭐実例の文体から学んで多様に書くこと）
・🚫「これまでお送りさせて頂いたお部屋の中でも」「お送りした中でも」「〜の中から」等、既送付物件の中から絞り込んだことを前提にする比較表現は絶対禁止（今回は新着1件の紹介であり比較対象が存在しない）
・新着＝早く動いた方がよいという鮮度をCTAに乗せてよい（煽りにならない範囲で）
・CTAは内覧誘導または申込誘導（中〜強）`,
  alternative: `【シナリオ: 代替新規提案型】お客様が指定/希望された物件が募集終了（空室なし）だったため、代わりの1件を新規にご提案する文脈。
・🚫「お送りさせて頂きましたお部屋の中でも」「〜の中から」等、複数物件の送付済みを前提にした比較・絞り込み表現は絶対禁止（事実と異なる訴求になる）
・🚫 新着だと確認できていないため「新着で」「募集に出ました」と断定しない
・前置きせず即物件紹介に入る（冒頭の具体的な言い回しは⭐実例の文体から学んで多様に書くこと）
・適合性訴求を全面に出す（希望物件が叶わなかった穴を埋める提案であることを意識）
・締めは強めの申込CTA（希望物件を逃した直後のため、良い代替は早く押さえるご提案が合理的）`,
  followup_single: `【シナリオ: 追加提案型】これまでにも物件をお送りしているが、今回は「送った中から選ぶ」文脈ではなく、新たに1件をご提案する文脈（送付済みが実質1件のみ等で比較対象が存在しない）。
・🚫「お送りした中でも」「これまでお送りさせて頂いたお部屋の中でも」等、複数送付済みの中から絞り込んだ体の表現は絶対禁止（比較できるだけの複数を送っていないため事実と異なる）
・🚫 新着だと確認できていないため「新着で」「募集に出ました」と断定しない
・「追加でお探しした1件」「改めてご提案する1件」として希望条件との適合を前面に出す（冒頭の言い回しは⭐実例の文体から学んで多様に書くこと）
・CTAは内覧誘導寄りの中程度`,
  first: `【シナリオ: 初回提案型】まだ物件をお送りしていないお客様への初めての1件提案。
・🚫「お送りした中でも」「先日の物件」等、既送付を前提にした表現は絶対禁止
・🚫 新着だと確認できていないため「新着で」「募集に出ました」と断定しない
・希望条件との適合を紹介する（冒頭の具体的な言い回しは⭐実例の文体から学んで多様に書くこと）
・CTAは内覧誘導寄りの軽め〜中程度（まず反応を見る）`,
};

/**
 * 生成文がシナリオの冒頭フレームに違反していないか。違反していれば理由の文字列。
 * ⚠ 判定材料は事実のみ（LLM 推論に依存しない）。生成・再生成・監査が同じこの関数を使う。
 */
export function detectFrameViolation(text: string, scenario: RecommendationScenario | null): string | null {
  if (!scenario || !text) return null;
  if (scenario !== "compare" && COMPARE_FRAME_RE.test(text)) {
    return "既送付物件の中から選んだ体の比較表現（「お送りした中でも」等）— この会話では複数物件を送った事実がない";
  }
  if (scenario === "compare" && NEW_LISTING_FRAME_RE.test(text)) {
    return "新たに募集が出たと断定する表現（「新着で」「募集に出ました」等）— 今回は既送付物件からの選定";
  }
  return null;
}

/**
 * その実例を few-shot に入れてよいか（シナリオと冒頭フレームが矛盾しないか）。
 *
 * ⚠ 設計知見「実例（⭐固定シード）の偏りがフレーム選択をLLMに引き起こす」:
 *   ⭐実例の大半が「お送りさせて頂きましたお部屋の中でも〜」で始まるため、
 *   新着型・初回提案型でもモデルがその冒頭をそのまま引き写す（実例によるフレーム汚染）。
 *   プロンプトでシナリオを正しく指示しても、**具体的な実例の文体がプロンプト指示を上回る**。
 */
export function isExampleFrameCompatible(text: string | null | undefined, scenario: RecommendationScenario | null): boolean {
  if (!scenario || !text) return true;
  const hasCompare = COMPARE_FRAME_RE.test(text);
  const hasNewListing = NEW_LISTING_FRAME_RE.test(text);
  if (scenario === "compare") return !hasNewListing;
  if (scenario === "new_listing") return !hasCompare;
  return !hasCompare && !hasNewListing; // alternative / followup_single / first
}

/** 生成に渡す1ブロック（シナリオのガイド＋絶対に使わない冒頭）。シナリオが無ければ空文字 */
export function buildScenarioNote(scenario: RecommendationScenario | null): string {
  if (!scenario) return "";
  return `\n\n【訴求シナリオ（冒頭フレームは事実から確定済み・必ず守る）】\n`
    + `${RECOMMENDATION_SCENARIO_GUIDES[scenario]}\n`
    + `🚫 この通で絶対に使わない冒頭: ${RECOMMENDATION_FORBIDDEN_OPENINGS[scenario].map((p) => `「${p}」`).join(" / ")}`;
}
