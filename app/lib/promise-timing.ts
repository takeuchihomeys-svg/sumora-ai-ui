// app/lib/promise-timing.ts
// 物件ピックアップの約束（こちらの「お部屋お送りします」の宣言）が「いつやる約束か」を文から決める（純関数・DB 依存なし）。
//
// 2026-10-01 竹内（和樹事例）「『引き続き新着で…お送り』という約束は『新着が出たら送る』約束として扱う形、これはLINEみていてもそうなっている。
//   このように法則性見つけたらもっと質よくなる」:
//   9/30 11:08「引き続き新着でオススメできるお部屋ピックアップしお送りさせていただきます」→ カレンダー id 951
//   【必ず】物件ピックアップ送付【今日中】。翌日お客様が SUUMO の物件を送ってきた時も赤帯の一番上に出ていた。
//   旧: 「新着が出次第」（次第）だけを外の出来事待ちとして約束にしなかった（行を作らない）。それ以外の約束は全部【今日中】。
//
// ■ 実送信で引いた線（scripts/audit-pickup-promise-timing.ts・2026-04〜10/01 の180日・手で書いた約束 979件・読み取りのみ）
//   「同じ日・お客様が何か言う前にこちらから送った」＝その日のうちにやる約束として果たされた割合で分けた（数字は監査の出力のまま）。
//     今日の語（本日中・今から・後ほど）     17件  同じ日にこちらから 35%・中央値 5.0時間
//     条件つき（エリア・家賃・間取り・新たに） 439件 同じ日にこちらから 18%・中央値 7.8時間・3日以内 81%
//     新着が出次第（次第）                   133件 同じ日にこちらから  8%・中央値 42.4時間・次の送付が新着 32%
//     引き続き＋探し（ピックアップ・お送りの語なし）26件 8%・中央値 30.9時間
//     引き続き＋新着（和樹の形）               8件 25%・中央値 55.0時間・30日送付なし 38%・次の送付が新着 60%
//     随時 10件 20%・中央値 19.6時間／出ましたら 4件 0%・中央値 216時間
//     お客様待ち（教えて頂ければ）            15件  0%・30日送付なし 87%
//     時期待ち（お引越し時期が近づいたら）      3件  0%
//   → 「新着」「次第」「随時」「出ましたら」「日々確認」と、引き続き＋新着・引き続き＋探し は、こちらの作業で今日決まる約束ではなく
//     新着（外の出来事）待ち。条件を言い直してのピックアップ（新たに・〜周辺全域から・〜万円以内）は従来どおり今日中。
//   ⚠ 「新着で〇〇さんにオススメできるお部屋ピックアップさせていただきます」（引き続き・次第なし）は 20件で同じ日にこちらから 25%・中央値 20時間と
//     どちらとも言えない＝今日中のまま（取り違えるなら今日中の方が漏れない）。「新着物件併せて」（今日のピックアップに新着も入れる）も今日中。
//   この関数でまとめた後（GROUP=1）: today 740件 同じ日にこちらから 16%・中央値 8.6時間・次の送付が新着 14%／
//     new_arrival 214件 9%・中央値 28.9時間・次の送付が新着 29%（うち サポートの宣言「お部屋探しご担当させて頂きます」等 43件）／
//     after_customer 18件 0%・30日送付なし 72%／when_period 3件／date 4件
//   ※「送付の締め（前後15分に物件送付）」の約束は物件送付の直後の言い添え（4〜10%）。同じ日の割合には数えない（次の送付は15分より後だけ）
//
// 入口か出口か: カレンダーの行の要件・印・置く日だけを変える（約束は消さない・完了にしない・送った本文は変えない）。

export type PickupPromiseTiming =
  /** 今日のうちにやる（従来の【今日中】） */
  | "today"
  /** 日付の語（明日・週明け・曜日）。置く日は promiseStartAt（明日は翌日の午前） */
  | "date"
  /** 新着（外の出来事）が出たら送る。期日なし */
  | "new_arrival"
  /** お客様がご条件・情報を送ってくれたら（お客様の番） */
  | "after_customer"
  /** お引越しの時期が近づいたら */
  | "when_period";

/** 期日の無い待ちの約束（カレンダーの見出しの印・赤帯で「必ず N日」にしない） */
export const WAIT_TIMINGS: ReadonlySet<PickupPromiseTiming> = new Set(["new_arrival", "after_customer", "when_period"]);

const WHEN_PERIOD_RE = /時期[^。！!\n]{0,6}(?:来|近づ)|月に入りましたら|頃になりましたら/;
const AFTER_CUSTOMER_RE = /(?:教えて|お聞かせ|お送り|ご連絡)(?:いただ|頂)(?:ければ|けますと|けましたら|き次第)/;
const TODAY_WORD_RE = /本日中|今日中|後ほど|のちほど|今から|この後/;
const DATE_WORD_RE = /明日|明朝|明後日|週明け|来週|[月火水木金土日]曜/;
/** 外の出来事待ち（新着・募集が出次第／「で次第」の打ち間違い 隼斗 ev526）。promise-calendar の旧 EXTERNAL_WAIT_RE と同じ線＋随時・出ましたら・日々確認 */
const NEW_ARRIVAL_RE = /(?:新着|募集|出|見つかり)(?:が)?(?:出|で)?次第|新着[^\n。]{0,20}(?:出|で)次第|随時|(?:出|出て(?:き)?|新しく出|募集に出)(?:まし)?たら|日々確認/;
const CONTINUE_RE = /引き続き|継続/;
/** 物件を送る作業の語（これがあれば「探し続ける」だけの宣言ではない） */
const PICKUP_VERB_RE = /ピックアップ|お送り|送付|ご紹介|ご提案/;
/** お部屋探しのサポートの宣言（担当の挨拶・「全力でサポート」）。物件を送る作業の語が無い時だけ */
const SUPPORT_ONLY_RE = /サポート|ご担当|担当させて/;

/**
 * 約束の文 → いつやる約束か。
 * 優先: 時期待ち > お客様待ち > 今日の語 > 日付の語 > 新着待ち > 今日（既定）
 */
export function classifyPickupPromiseTiming(sentence: string | null | undefined): { timing: PickupPromiseTiming; reason: string } {
  const s = (sentence ?? "").trim();
  if (WHEN_PERIOD_RE.test(s)) return { timing: "when_period", reason: "時期の語" };
  if (AFTER_CUSTOMER_RE.test(s)) return { timing: "after_customer", reason: "お客様が先" };
  if (TODAY_WORD_RE.test(s)) return { timing: "today", reason: "今日の語" };
  if (DATE_WORD_RE.test(s)) return { timing: "date", reason: "日付の語" };
  if (NEW_ARRIVAL_RE.test(s)) return { timing: "new_arrival", reason: "新着・次第・随時" };
  if (CONTINUE_RE.test(s) && /新着/.test(s)) return { timing: "new_arrival", reason: "引き続き＋新着" };
  if (CONTINUE_RE.test(s) && !PICKUP_VERB_RE.test(s)) return { timing: "new_arrival", reason: "引き続き探す" };
  if (SUPPORT_ONLY_RE.test(s) && !PICKUP_VERB_RE.test(s)) return { timing: "new_arrival", reason: "サポートの宣言" };
  return { timing: "today", reason: "既定" };
}

/** カレンダーの見出し（【必ず】の後ろ）と印。待ちの約束は【今日中】を付けない */
export const PICKUP_TIMING_LABEL: Record<PickupPromiseTiming, { label: string; mark: string }> = {
  today: { label: "物件ピックアップ送付", mark: "" },
  date: { label: "物件ピックアップ送付", mark: "" },
  new_arrival: { label: "新着が出たら物件送付", mark: "【新着待ち】" },
  after_customer: { label: "ご条件を頂いたら物件送付", mark: "【お客様待ち】" },
  when_period: { label: "お引越し時期が近づいたら物件送付", mark: "【時期待ち】" },
};

/** 待ちの印（見出しの末尾）。この印のある約束は期日が無い＝「必ず N日」・期限切れに数えない */
export const WAIT_MARKS: readonly string[] = ["【新着待ち】", "【お客様待ち】", "【時期待ち】"];

/** notes の1行目が待ちの約束か */
export function isWaitPromiseNotes(notes: string | null | undefined): boolean {
  const head = ((notes ?? "").trimStart().split("\n")[0] ?? "");
  return WAIT_MARKS.some((m) => head.includes(m));
}

/** 赤帯・一覧に出す短い呼び名（「新着が出たら送る」等）。待ちでなければ null */
export function waitPromiseBadge(notes: string | null | undefined): string | null {
  const head = ((notes ?? "").trimStart().split("\n")[0] ?? "");
  if (head.includes("【新着待ち】")) return "新着が出たら送る";
  if (head.includes("【お客様待ち】")) return "ご条件を頂いたら送る";
  if (head.includes("【時期待ち】")) return "時期が来たら送る";
  return null;
}
