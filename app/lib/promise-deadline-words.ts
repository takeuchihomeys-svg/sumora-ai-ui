// app/lib/promise-deadline-words.ts — 約束の文の「いつまでに」の言葉の表（純関数・DB/LLM なし）。約束の種類 × 相手（管理会社か自社か）× 時刻 × 曜日・祝日 → 言う期日の言葉
//
// 2026-11-12 作業員19（統括役「約束の期日の言葉の表」・作業員24 の洗い出し・根C の一部）。TIME_FACTS と同じ作業ツリー・同じ切替（TIME_FACTS=on・既定 off）の下に置く。
//   台帳の穴「夜の確認に『本日営業時間外の為、明日』が付かない」（writer:mgmt-confirm-night-no-tomorrow・brain:night-mgmt-confirm-goes-aix）を、同じ表から埋める。
// 置き方: これは「期日の言葉の事実の表」。ブレイン・書き手が約束の文に期日を入れる時の候補と、入れてよい確かさ（high／mid／low）と根拠を返す。何を送るか・返信か AIX かは決めない（P0 9eb6aa9c）。
//   分からない時は期日を言い切らず「確認出来次第」「出来次第」に倒す（竹内さん・統括役 11/12）。
//
// ■ 根拠にした実送信の数（読み取りのみ・数字は各ファイルの監査の出力のまま）
//   ・ピックアップの約束（app/lib/promise-timing.ts・180日・手で書いた約束 979件）: 同じ日にこちらから送ったのは 16〜18%（今日の語 35%・条件つき 18%・新着が出次第 8%）・中央値 8.6時間（条件つき 7.8時間・新着 28.9時間）。
//        ＝竹内さんは「本日中に」と期日を言い切る約束をほとんど書かない（条件つき 439件は期日の語なし）。期日を言い切ると果たせない約束になる。
//   ・約束の種類ごとの果たすまで（app/lib/promise-tracker.ts PROMISE_STATS）: 物件探し 82.9%・中央値 9.6時間／確認 70.8%・5.7時間（90%で116時間）／見積書 92.2%・2.5時間／交渉 77.1%・11.5時間／ご連絡 55.9%・52.5時間。
//   ・夜の約束（KB 5fe999f8・11/04）: 竹内さん本人の18時以降の「募集状況確認させて頂きます」23通のうち営業時間の一言は4通だけ（18〜19時台 12通中0・20時台以降 11通中4）→ 募集状況の確認は21時より前は「確認出来次第ご連絡」・21時以降は明日の約束でよい。設備の確認・交渉・管理会社への問い合わせは18時の線。
//   ・夜の管理会社への確認（KB 9fd703f4・10/26 の竹内さんの形）: 「本日管理会社営業時間外の為明日交渉／確認させて頂き、確認出来次第ご連絡させて頂きます」。お休みの日は「本日管理会社がお休みのため、営業開始次第一番に確認（交渉）させて頂きます」（brain-core の指示文の型）。
//   ・出し切った後の継続（KB）: 「ピックアップ出来次第」と「新着で募集に出次第」は別の約束。
//   ・曜日・祝日の管理会社の営業: 土日祝は休みの扱い（final-check の旧の扱い・time-facts.ts の MGMT_CLOSED_WEEKDAYS）。実際の LINE の数えは scripts/audit-mgmt-hours.ts（22時以降）の結果で直す＝直るまでは土日祝の管理会社の約束は「営業開始次第」に倒す。
// ■ 本日中に を言ってよい線（唯一の例外）: 見積書（果たすまで中央値 2.5時間・92%）・自社の作業・平日・16時前。同じ日に果たした割合はまだ数えていない＝確かさ mid。ピックアップ・確認・交渉には「本日中に」を出さない。
// ■ 〇時頃 は、スタッフが時刻を入力した時（staffGivenHour）だけ。表から作らない（根拠の数が無い）。
// テスト: app/lib/__tests__/promise-deadline-words.test.ts
import { computeTimeFacts } from "./time-facts";

export type DeadlineWord = "本日中に" | "明日一番に" | "〇時頃" | "確認出来次第" | "出来次第" | "新着で募集に出次第" | "営業開始次第";
/** 約束の種類。pickup=条件の言い直し・初回のピックアップ／new_arrival=出し切った後の継続（新着待ち）／check_vacancy=募集状況の確認（ポータル・業者サイトで確かめられる）／check_mgmt=管理会社にしか答えられない確認（設備・入居・駐車場・鍵 等）／negotiate=交渉／estimate=御見積書 */
export type PromiseWhenKind = "pickup" | "new_arrival" | "check_vacancy" | "check_mgmt" | "negotiate" | "estimate";
export type Confidence = "high" | "mid" | "low";
export type DeadlineChoice = {
  word: DeadlineWord;
  /** 約束の文の頭に付ける一言（無ければ null）。夜・休みの管理会社の約束にだけ付く */
  prefix: string | null;
  /** そのまま使える約束の文の骨格（物件名・条件は書き手が入れる） */
  phrase: string;
  confidence: Confidence;
  basis: string[];
};

/** promise-tracker.ts の種類 → ここの種類（名前を揃える入口）。対応が無い物は null（期日の言葉は決めない） */
export function fromTrackerKind(k: string | null | undefined, opts: { mgmtOnly?: boolean; online?: boolean } = {}): PromiseWhenKind | null {
  switch (k) {
    case "物件探し": case "条件つきの提案": return "pickup";
    case "見積書": return "estimate";
    case "交渉": return "negotiate";
    case "確認": return opts.online === false || opts.mgmtOnly ? "check_mgmt" : "check_vacancy";
    default: return null;
  }
}

export type DeadlineInput = {
  kind: PromiseWhenKind;
  nowMs?: number;
  /** テストの時計を効かせたい時 */
  hour?: number;
  /** スタッフが入力した時刻（〇時頃を言ってよい唯一の入口） */
  staffGivenHour?: number | null;
  /** お客様が「今日中に」と頼んだか（本日中にの例外の条件ではなく、頼まれていない約束はしない側の見張りに使う） */
  customerAskedToday?: boolean;
};

const COMPANY_CLOSE_HOUR = 21;
const MGMT_NIGHT_PREFIX = "本日管理会社営業時間外の為、";
const MGMT_REST_PREFIX = "本日管理会社がお休みのため、";
const VERB: Record<PromiseWhenKind, string> = { pickup: "ピックアップ", new_arrival: "新着", check_vacancy: "募集状況を確認", check_mgmt: "確認", negotiate: "交渉", estimate: "御見積書を作成" };

export function chooseDeadlineWord(i: DeadlineInput): DeadlineChoice {
  const nowMs = i.nowMs ?? Date.now();
  const f = computeTimeFacts({ nowMs, hour: i.hour });
  const hour = f.now.hour;
  const basis: string[] = [];

  // 時刻をスタッフが入れた時だけ「〇時頃」
  if (typeof i.staffGivenHour === "number" && i.staffGivenHour >= 0 && i.staffGivenHour <= 23) {
    return { word: "〇時頃", prefix: null, phrase: `${i.staffGivenHour}時頃までに${VERB[i.kind]}してご連絡させて頂きます`, confidence: "mid", basis: ["スタッフが時刻を入力した時だけ〇時頃を言う（表からは作らない）"] };
  }

  if (i.kind === "new_arrival") {
    return { word: "新着で募集に出次第", prefix: null, phrase: "新着で募集に出次第お送りさせて頂きます", confidence: "high", basis: ["出し切った後の継続は『新着で募集に出次第』（『ピックアップ出来次第』とは別の約束）", "新着待ちの約束は同じ日に果たす割合 9%・中央値 28.9時間（promise-timing）＝期日を言わない"] };
  }

  if (i.kind === "pickup") {
    return { word: "出来次第", prefix: null, phrase: "ご条件に合ったお部屋をピックアップ出来次第お送りさせて頂きます", confidence: "high", basis: ["ピックアップの約束を同じ日に果たしたのは 16〜18%・中央値 8.6時間（promise-timing）＝『本日中に』と言い切らない", "条件つき 439件は期日の語なしで送っている（竹内さんの形）"] };
  }

  if (i.kind === "estimate") {
    // 自社の作業・平日・16時前だけ本日中に
    const ok = !f.now.weekend && !f.now.holiday && hour < 16 && f.companyOpen;
    if (ok) return { word: "本日中に", prefix: null, phrase: "御見積書を本日中にお送りさせて頂きます", confidence: "mid", basis: ["見積書は果たすまで中央値 2.5時間・92%（PROMISE_STATS）", "同じ日に果たした割合は未計測＝確かさ mid・平日・自社の作業・16時前だけ", "お客様が頼んでいない時は期日を足さない（頼まれていない約束をしない）"] };
    return { word: "出来次第", prefix: null, phrase: "最大限割引させて頂いた御見積書を作成出来次第お送りさせて頂きます", confidence: "high", basis: ["16時以降・土日祝は『本日中に』と言い切らず『出来次第』（自社の作業は19時まで・final-check TIME_INVALID と同じ向き）"] };
  }

  if (i.kind === "check_vacancy") {
    // 募集状況は弊社の営業時間中ならいつでもできる（KB 5d9e56b5・5fe999f8）
    if (hour < COMPANY_CLOSE_HOUR) {
      return { word: "確認出来次第", prefix: null, phrase: "募集状況を確認させて頂き、確認出来次第ご連絡させて頂きます", confidence: f.now.weekend || f.now.holiday ? "mid" : "high", basis: ["募集状況の確認は21時より前は営業時間の終了を付けず『確認出来次第ご連絡』（KB 5fe999f8・18時以降23通中4通だけが一言）", ...(f.now.weekend || f.now.holiday ? ["土日祝の募集状況の確認は決定に書かれていない＝確かさ mid（audit-mgmt-hours.ts の結果で直す）"] : [])] };
    }
    return { word: "明日一番に", prefix: null, phrase: "明日一番に募集状況を確認させて頂き、確認出来次第ご連絡させて頂きます", confidence: "high", basis: ["21時以降は今まで通り明日の約束でよい（KB 5fe999f8 ②）"] };
  }

  // check_mgmt・negotiate: 管理会社の営業時間に左右される（18時の線）
  basis.push("設備の確認・管理会社への問い合わせ・交渉は管理会社の営業時間（平日 9〜18時・土日祝は休みの扱い）の線（KB 5fe999f8 ③・9fd703f4）");
  const verb = VERB[i.kind];
  if (f.mgmtOpen) {
    return { word: "確認出来次第", prefix: null, phrase: `管理会社に${verb}させて頂き、確認出来次第ご連絡させて頂きます`, confidence: "high", basis: [...basis, `${i.kind === "negotiate" ? "交渉" : "確認"}の約束は果たすまで中央値 ${i.kind === "negotiate" ? "11.5" : "5.7"}時間（PROMISE_STATS）＝『本日中に』と言い切らない`] };
  }
  const next = f.mgmtNextOpen;
  const todayClosed = f.now.weekend || !!f.now.holiday;
  const prefix = todayClosed ? MGMT_REST_PREFIX : MGMT_NIGHT_PREFIX;
  if (next?.sameDay) {
    return { word: "営業開始次第", prefix: null, phrase: `営業開始次第一番に${verb}させて頂き、確認出来次第ご連絡させて頂きます`, confidence: "high", basis: [...basis, "今は営業前（9時より前）"] };
  }
  const tomorrow = !!next && Date.parse(next.day.ymd) - Date.parse(f.now.ymd) === 86_400_000;
  if (tomorrow) {
    return { word: "明日一番に", prefix, phrase: `${prefix}明日${verb}させて頂き、確認出来次第ご連絡させて頂きます`, confidence: todayClosed ? "mid" : "high", basis: [...basis, todayClosed ? "土日祝（管理会社は休みの扱い）の翌日が営業日＝確かさ mid（audit-mgmt-hours.ts で確かめる）" : "夜（18時以降）の約束の形＝竹内さんの 10/26 の文（KB 9fd703f4）", "台帳の穴 writer:mgmt-confirm-night-no-tomorrow を塞ぐ"] };
  }
  return { word: "営業開始次第", prefix, phrase: `${prefix}営業開始次第一番に${verb}させて頂き、確認出来次第ご連絡させて頂きます`, confidence: "mid", basis: [...basis, "翌営業日が明日でない（金曜の夜・土日祝）＝『明日』と言い切らず『営業開始次第』・実際の線は audit-mgmt-hours.ts で確かめる"] };
}

/** 表の全体（種類×場面）をテスト・資料に出すための一覧。nowMs を渡した各場面の言葉 */
export const DEADLINE_TABLE_SCENES: ReadonlyArray<{ label: string; iso: string }> = [
  { label: "平日 午前 10時", iso: "2026-11-12T10:00:00+09:00" },
  { label: "平日 夕方 17時（木）", iso: "2026-11-12T17:00:00+09:00" },
  { label: "平日 夜 18:30（木）", iso: "2026-11-12T18:30:00+09:00" },
  { label: "平日 夜 21:10（木）", iso: "2026-11-12T21:10:00+09:00" },
  { label: "金曜 夜 20:00", iso: "2026-11-13T20:00:00+09:00" },
  { label: "土曜 昼", iso: "2026-11-14T12:00:00+09:00" },
  { label: "祝日 昼（11/23）", iso: "2026-11-23T12:00:00+09:00" },
  { label: "朝 7時（木）", iso: "2026-11-12T07:00:00+09:00" },
];

/**
 * 作業員7 の next-move-detail.ts の When（at: now／next_turn／hours／next_day・dueLabel）に名前を揃える入口（w7-seq b6107d2f の型）。
 *   at: 本日中に・〇時頃・確認出来次第・出来次第＝hours（数時間のうち）／明日一番に・夜や休みの営業開始次第＝next_day（翌営業日）／朝9時前の営業開始次第＝hours／新着で募集に出次第＝next_turn（外の出来事待ち・時間でなく次の番）。
 *   dueLabel＝期日の言葉そのもの（頭に付ける一言があれば前に付ける）。時間の線を作業員7 の側で持たず、ここの表を1か所の元にする。
 */
export function toNextMoveWhen(c: DeadlineChoice): { at: "now" | "next_turn" | "hours" | "next_day"; dueLabel: string } {
  const label = `${c.prefix ?? ""}${c.word}`;
  switch (c.word) {
    case "明日一番に": return { at: "next_day", dueLabel: label };
    case "営業開始次第": return { at: c.prefix ? "next_day" : "hours", dueLabel: label };
    case "新着で募集に出次第": return { at: "next_turn", dueLabel: label };
    default: return { at: "hours", dueLabel: label };
  }
}

// ─── ブレインの約束の材料に事実として足す（PROMISE_DEADLINE_WORDS=on・既定 off）───
export function promiseDeadlineWordsEnabled(env: Record<string, string | undefined> = typeof process !== "undefined" ? process.env : {}): boolean {
  return String(env.PROMISE_DEADLINE_WORDS ?? "").trim().toLowerCase() === "on";
}
const KIND_JA: Record<PromiseWhenKind, string> = { pickup: "ピックアップ", new_arrival: "新着待ち", check_vacancy: "募集状況の確認", check_mgmt: "管理会社への確認", negotiate: "交渉", estimate: "御見積書" };
/**
 * 今の時刻での、約束の種類ごとの期日の言葉（事実の表の1行）。ブレインの約束の材料に足す。道の言葉は入れない（決めるのはブレイン）。
 * 確かさが high でない行には（確かさ mid）を付ける。本日中にの線は見積書だけ・他は期日を言い切らない根拠を1語で添える。
 */
export function promiseDeadlineWordsLine(o: { nowMs?: number; hour?: number } = {}): string {
  const kinds: PromiseWhenKind[] = ["pickup", "new_arrival", "check_vacancy", "check_mgmt", "negotiate", "estimate"];
  const parts = kinds.map((k) => {
    const c = chooseDeadlineWord({ kind: k, nowMs: o.nowMs, hour: o.hour });
    return `${KIND_JA[k]}＝${c.prefix ?? ""}${c.word}${c.confidence === "high" ? "" : `（確かさ ${c.confidence}）`}`;
  });
  return `\n【約束の期日の言葉（今の時刻・実送信の数から作った表・日本時間）】${parts.join("／")}（『本日中に』は御見積書の平日16時前だけ・他は期日を言い切らない＝ピックアップは同じ日に果たしたのが16〜18%）\n`;
}
