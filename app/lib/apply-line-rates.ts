// app/lib/apply-line-rates.ts
// 「申込の一文」（お申込みでお部屋を抑える等）を AIX の段階ごとに**添えるかどうか**の材料を、実送信の率で渡す（純関数・DB 依存なし）。
//
// 2026-09-23 竹内「順に改善する。実際の成約データや直近のLINEを参考にずれをなくすように」
//   前段の監査（scripts/audit-brain-funnel.ts ④・scripts/audit-recommend-apply-line.ts）:
//   AI は物件オススメで申込の一文を書きすぎ、見積書・物件確認した では書けていない（スタッフの型と逆）。
//
// 【実測（AIX【物件オススメ】・ai_draft と sent_reply が両方ある 267件・2026-08〜09）】
//   ・申込の語: 実送信 6.0%（16/267）／ AI 18.0%（48/267）。AI が書いた48件のうちスタッフが消した 35件（72.9%）。
//     AI が書かなかった219件でスタッフが自分から足したのは 3件（1.4%）＝「人が自分から選ばない形」
//   ・「お申込みから審査・ご契約・入居まで通常2週間程度…」の行（旧 buildMoveInDeadlineNote が「添えること」と必須にしていた）:
//     AI 15件→残4・消11（73.3%）。messages（スタッフ送信・365日）でこの行は4通だけで、**スタッフが自分の言葉で書いたのは0通**＝創作文
//   ・「ご希望の〇月入居に対応可能」型: 実送信 4.5%／AI 10.9%（29件→残12・消17）・スタッフが足したのは0件
//   ・状況で割った線（申込の語・実送信）: 退去予定 9.3%（4/43）／即入居 1.6%（1/61）／見積書同封 1.4%（1/69）／
//     成約側 13.2%（5/38）／空室かつ入居希望日あり 7.3%（8/110）／空室かつ入居希望日なし 3.5%
//     → **過半数に届く状況は一つもない**（必須にできる状況は無い）。ほぼ0は「見積書同封」「即入居」の2つ
//   ・退去予定の通の締め（実送信）: 申込誘導 9.3%／内覧誘導 11.6%／誘導なし 79.1%。
//     recommend-closing の「申込34件 vs 内覧9件」は「締めに誘導がある時」の条件付きの率
//
// 【線の引き方（設計知見「実送信で線を引く」）】
//   必須にしてよいのは過半数が守っている形だけ／禁止は実送信ほぼ0の形だけ／20%未満の帯は率を渡して選ばせる。
//   ここは全部 20%未満 → **入口（指示）で率を渡し、既定は「書かない」・書くなら退去予定の締めに限る**。
//
// 【出口（本文の書き換え）は入れない】
//   実送信に 16件（6.0%）正当な用例があり、誤削除0にできない。申込の一文を落とす出口は作らない
//   （検出器 detectRecommendApplyLine はログ・監査で効き具合を測るためだけに使う）。
//
// 【今回触らない物（第2段で判断）】
//   静的 MOVE_IN_TIMING_RULE「ご希望の〇月入居に対応可能」と記載する（実送信4.5%）と
//   recommendation-frame の「CTAは内覧誘導または申込誘導（中〜強）」は、静的ブロック（キャッシュを割る）と
//   両経路の冒頭フレームに絡むので触らない。この動的ノートの効きを2週間測ってから決める。

/** 率の出所を1か所に（監査スクリプトの再実行で更新する） */
export const RECOMMEND_APPLY_LINE_STATS = {
  measuredAt: "2026-09-23",
  /** ai_draft と sent_reply が両方ある物件オススメの件数 */
  n: 267,
  /** 実送信に申込の一文がある */
  sent: { n: 16, pct: 6.0 },
  /** AI の下書きに申込の一文がある */
  ai: { n: 48, pct: 18.0 },
  /** AI が書いた48件のうちスタッフが消した */
  aiRemoved: { n: 35, pct: 72.9 },
  /** AI が書かなかった219件のうちスタッフが自分から足した */
  staffAdded: { n: 3, of: 219, pct: 1.4 },
  /** 状況で割った実送信率（申込の語） */
  bySituation: {
    vacating: { n: 4, of: 43, pct: 9.3 },
    immediateMoveIn: { n: 1, of: 61, pct: 1.6 },
    withEstimate: { n: 1, of: 69, pct: 1.4 },
    won: { n: 5, of: 38, pct: 13.2 },
    vacantWithWish: { n: 8, of: 110, pct: 7.3 },
    vacantNoWish: { pct: 3.5 },
    vacantAll: { pct: 4.7 },
  },
  /** 「お申込みから審査・ご契約・入居まで通常2週間」の行。実送信に残ったのは4通（1.5%・うち2通は成約側）・スタッフが自分から書いたのは0 */
  twoWeeksLine: { ai: 15, aiRemoved: 11, sentRemained: 4, sentPct: 1.5, staffSelfWritten: 0 },
  /** 「ご希望の〇月入居に対応可能」型 */
  moveInOkForm: { sentPct: 4.5, ai: 29, aiRemoved: 17, staffAdded: 0 },
  /** 退去予定の通の締めの形（実送信） */
  vacatingClosing: { applyPct: 9.3, viewingPct: 11.6, nonePct: 79.1 },
  /** 締めに誘導がある時だけの数（recommend-closing の根拠） */
  vacatingClosingWhenCta: { apply: 34, viewing: 9 },
} as const;

/**
 * 段階ごとの「申込の一文」の率（実送信／AI）。
 * 物件オススメ以外は**率を渡すだけ**で必須にしない（見積書 20.0%・物件確認した 31.8% はどちらも過半数に届かない）。
 * 出所: scripts/audit-brain-funnel.ts ④（365日・成約側＝申込以降まで進んだ会話）
 */
export const APPLY_LINE_STAGE_RATES = {
  property_recommendation: { label: "物件オススメ", n: 267, sentPct: 6.0, aiPct: 18.0, scope: "全体" },
  estimate_sheet: { label: "見積書", n: 40, sentPct: 20.0, aiPct: 7.5, scope: "成約側" },
  property_check_result: { label: "物件確認した", n: 22, sentPct: 31.8, aiPct: 18.2, scope: "成約側" },
} as const;
export type ApplyLineStage = keyof typeof APPLY_LINE_STAGE_RATES;

/** 「即入居」の希望（希望条件・追加情報から読む）。物件側の「空室のため即入居可能」ではなくお客様側の急ぎ */
const IMMEDIATE_MOVE_IN_RE = /即入居|すぐ(?:に|にでも)?(?:入居|引越|引っ越|住み)|入居(?:希望日?|時期)?\s*[:：]\s*(?:すぐ|即|早め|なるべく早|至急|急ぎ)/;

export function detectImmediateMoveInWish(text: string | null | undefined): boolean {
  return IMMEDIATE_MOVE_IN_RE.test(text ?? "");
}

const S = RECOMMEND_APPLY_LINE_STATS;

/**
 * 物件オススメの動的 system ブロックに入れる「申込の一文」の材料。
 * ⚠ 「添えること」「必ず」の形にしない（必須にできる状況が無い）。禁止文を全文で引用しない（LLM に写させない）。
 */
export function buildRecommendApplyLineNote(o: {
  /** まだご内覧頂けない（退去予定・解禁日が明日以降）。ブレインの判断 */
  notViewable: boolean;
  /** 内覧解禁日の表記（「10月1日」） */
  viewableFrom?: string | null;
  /** 御見積書を同封する通 */
  hasEstimate: boolean;
  /** お客様が即入居を希望している */
  immediateMoveIn: boolean;
  /** お客様の入居希望時期の表記（「11月入居希望」）。無ければ null */
  moveInWish: string | null;
  /** 審査期間（14日）を引いた余裕日数。間に合わない・分からない時は null */
  marginDays: number | null;
}): string {
  const lines: string[] = [];
  lines.push(`【申込の一文と入居時期 — 実送信の率（${S.measuredAt}・物件オススメ${S.n}件）】`);
  lines.push(
    `・物件オススメの段階で申込の一文（お申込みでお部屋を抑える等）を添えるのは実送信${S.sent.pct}%。` +
    `AIが書いた${S.ai.n}件のうち${S.aiRemoved.n}件をスタッフが消し、AIが書かない時にスタッフが自分から足したのは${S.staffAdded.pct}% → 基本は書かない。` +
    `申込の一文はスタッフが見積書・物件確認した の段階で添える（成約側 ${APPLY_LINE_STAGE_RATES.estimate_sheet.sentPct}〜${APPLY_LINE_STAGE_RATES.property_check_result.sentPct}%）。`,
  );
  // 反証者の指摘（2026-09-23）で「0通」を率の形に直した: 実送信には残った形が4通（1.5%）あり「実送信に無い形」と読ませない
  lines.push(
    `・審査期間を根拠にした申込の一文（申込から審査・契約・入居まで何週間で対応できる、の形）は実送信${S.twoWeeksLine.sentPct}%` +
    `（AIが書いた${S.twoWeeksLine.ai}件のうち残${S.twoWeeksLine.sentRemained}・消${S.twoWeeksLine.aiRemoved}・スタッフが自分から書いたのは${S.twoWeeksLine.staffSelfWritten}） → 書かない。` +
    `入居時期に触れるなら物件側の事実（空室・入居可能時期）だけ。`,
  );
  if (o.hasEstimate) {
    lines.push(`・この通は御見積書を同封する → 見積書同封の通で申込の一文は ${S.bySituation.withEstimate.n}/${S.bySituation.withEstimate.of} → 書かない（申込の誘導は見積書のAIX側）。`);
  }
  // ⚠ immediateMoveIn の行は出さない（反証者の指摘）: 1/61 は本文に「空室のため即入居可能」がある通（物件側）を数えた率で、
  //   この旗は customer_conditions（お客様側）を見る＝出所が違う。同じ268件で条件側の即入居希望は3件だけ。既定の「書かない」に任せる
  if (o.notViewable) {
    lines.push(
      `・このお部屋は退去予定でまだご内覧頂けない${o.viewableFrom ? `（${o.viewableFrom}以降にご内覧可能）` : ""} → 締めに誘導を入れるなら内覧誘導ではなく申込誘導（誘導がある通では申込${S.vacatingClosingWhenCta.apply}件 vs 内覧${S.vacatingClosingWhenCta.viewing}件）。` +
      `ただし締めの誘導自体は必須ではない（退去予定の通で誘導なし${S.vacatingClosing.nonePct}%）。`,
    );
  } else {
    lines.push(`・このお部屋は今ご内覧頂ける → 空室の通で申込の一文は実送信${S.bySituation.vacantAll.pct}% → 書かない。`);
  }
  if (o.moveInWish && o.marginDays !== null && o.marginDays >= 0) {
    lines.push(
      `・お客様の入居希望時期「${o.moveInWish}」までは審査期間を引いて${o.marginDays}日の余裕がある → 対応可能と断言してよいが必須ではない` +
      `（「〇月入居に対応可能」型は実送信${S.moveInOkForm.sentPct}%・スタッフが自分から足したのは${S.moveInOkForm.staffAdded}件）。書く場合は「${o.moveInWish}」の表記のまま。`,
    );
  }
  // 反証者の指摘（2026-09-23）: 同じリクエストに訴求シナリオの「CTAは内覧誘導または申込誘導（中〜強）」や
  //   購買シグナル peak の「申込直結CTA」も届くので、どちらが優先かを1行で決める（計測が衝突で濁らないように）。
  //   スタッフの指定＞ブレインの購買シグナル peak＞この率。それ以外の一般的な CTA 指示よりはこの率が優先
  lines.push(
    `・優先: スタッフが申込誘導を指定した時、またはブレインの購買シグナルが peak の時はそちらに従う。` +
    `それ以外で訴求シナリオ等の一般的な「申込CTA」の指示と食い違う時は、この実送信の率のとおり書かない。`,
  );
  return lines.join("\n");
}

/**
 * 見積書・物件確認した の側に渡す率だけのノート（必須にしない）。
 * 今回は率を渡す形を用意するだけで、呼び出しは物件オススメの入口だけ（第2段で見積書・物件確認に足す）。
 */
export function buildApplyLineStageRateNote(stage: ApplyLineStage): string {
  const r = APPLY_LINE_STAGE_RATES[stage];
  return `【申込の一文 — 実送信の率（${r.label}・${r.scope}${r.n}件）】実送信${r.sentPct}%／AI${r.aiPct}%。` +
    (r.sentPct < 50 ? "過半数ではないので添えるかは場面で選ぶ（必須ではない）。" : "");
}

/** 「お申込みから審査・ご契約…2週間」の行 */
const TWO_WEEKS_LINE_RE = /お申込(?:み)?から審査・ご契約|審査・ご契約・入居まで/;
/** 申込の誘導（CTA）。scripts/audit-recommend-apply-line.ts の APPLY_CTA と同じ */
const APPLY_CTA_RE = /お気に召され[^\n]{0,24}お?申込|お?申込(?:み)?(?:で|し|して)?[^\n]{0,12}(?:抑え|押さえ|確保)|お申込(?:み)?(?:是非|ぜひ|いかが|ご検討|も可能|でお部屋)|お申込(?:み)?から(?:審査|最短)|申込(?:後|から)最短|お申込(?:み)?手続き/;
/** 申込状況の報告（1番手・2番手）。CTA ではない */
const APPLY_STATUS_RE = /[1１]番手|[2２]番手|申込(?:み)?が入って|お申込あり|申込済/;

export type RecommendApplyLineKind = "two_weeks" | "apply_cta" | "apply_status";

/**
 * 本文に申込の一文があるかを分類する（ログ・監査用）。
 * ⚠ 出口では使わない（実送信に 6.0% 正当な用例があり誤削除0にできない）。
 */
export function detectRecommendApplyLine(text: string | null | undefined): { kind: RecommendApplyLineKind | null; sentence: string | null } {
  // 「！！」の連続の途中で切らない（(?![。！!]) で連続の終わりだけを区切りにする）
  const sentences = (text ?? "").split(/(?<=[。！!\n])(?![。！!])/).map((s) => s.trim()).filter(Boolean);
  const find = (re: RegExp) => sentences.find((s) => re.test(s)) ?? null;
  const tw = find(TWO_WEEKS_LINE_RE);
  if (tw) return { kind: "two_weeks", sentence: tw };
  const cta = find(APPLY_CTA_RE);
  if (cta) return { kind: "apply_cta", sentence: cta };
  const st = find(APPLY_STATUS_RE);
  if (st) return { kind: "apply_status", sentence: st };
  return { kind: null, sentence: null };
}
