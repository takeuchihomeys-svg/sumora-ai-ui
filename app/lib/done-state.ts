// app/lib/done-state.ts
// ─────────────────────────────────────────────────────────────────────────────
// 「済んだ事・もう言った約束・今こちらを待っている事」を返信生成の入口で1回だけ決める純関数（DB・LLM 依存なし）
//
// 2026-09-26 竹内「ここの部分改善する根本的に」（3つの穴）:
//   (1) 約束の言い直し — 20分前に「確認出来次第ご連絡」と約束した後の相槌に、同じ約束をもう一度書く
//   (2) 前に送った物の中身を知らない — 確認済みの物件を「確認します」と書く
//   (3) お客様の返事を、こちらの問い・提案への答えとして読めない — 日時が決まった後の「よろしく」に日程調整の文を書く
//
// 診断（直近60日・下書き×実送信 846組・読むだけ）で分かった共通の根:
//   ・材料（台帳の「約束済み・送付済み・報告済み」）は届いていたのに、書き方を決める決定論
//     （gratitudeActionHint・promiseEchoNote・「短い了承（復唱）」の場面ラベル・内覧日程確定後シンプル締め）が
//     直前のこちらの文を正規表現で読み直して「約束を復唱せよ」「ご都合よろしいお日にちに」と命じていた
//   ・「直前のこちら」の数え方が3つあり、時刻で区切らない塊は 6時間以上前の約束を 3.8% で抱える
//   ・isFollowUp（こちらの連投の途中）では台帳の注記が全部空になる
//   ・内覧の状態（まだ提案中か・もう決まったか）を返信生成が1か所で持っていない（判定が履歴の各発言の1行目しか見ていなかった）
//
// ここに置く物は全部「入口」（材料・指示の選び方）。本文を書き換える出口は1つも置かない:
//   同じ種類の約束を書いた下書きの そのまま送信 は 送る52%・探す40%・連絡33%・確認21%（スタッフが残す方が多い）で、
//   出口で消すと誤削除が出る（誤削除0を示せない）。止めた判断は各関数のコメントに残す。
// ─────────────────────────────────────────────────────────────────────────────
import { STAFF_PICKUP_DECL_RE } from "./reply-context";
import { appointmentLabel, type ActionLedger, type LedgerFacts } from "./action-ledger";
import type { ViewingThreadVerdict } from "./viewing-thread";
import { jstParts } from "./jst-date";

const HOUR = 3600_000;
const nfkc = (s: string | null | undefined) => (s ?? "").normalize("NFKC");
const SENTENCE_SPLIT_RE = /\n|(?<=[。！!？?])(?![。！!？?])/;

// ═════════════════════════════════════════════════════════════════════════════
// ① 「直前のこちら」を1つの読み方にする（時刻で区切る）
// ═════════════════════════════════════════════════════════════════════════════
/**
 * 直前のこちらの塊（お客様の発言までの連続するこちらの発言）から、塊の一番新しい発言より `gapHours` 以上前の発言を外す。
 *
 * 実測（直近60日・お客様が返した直前の塊 2,006件）: 塊が6時間超にまたがる 8.0%・6時間以上前の約束を含む 3.8%。
 *   YUMA では数日前の「駐車場の空き状況の確認」が今日の AIX 物件送付と同じ塊に入り、promiseEchoNote が古い約束を復唱させた。
 *   6時間は「その日の続きか」の線（設計知見: スタッフの発言同士の関係は その日はじめての会話文か 1本に畳まれる。
 *   6〜12時間空いても同じ日なら挨拶率は変わらない＝6時間より前は『直前』ではなく『前の話』）。
 * 時刻の無い行は外さない（読めない物を消さない）。塊が1通だけの時は何も外さない。
 */
export type TimedLine = { sender: "staff" | "customer"; text: string; t: number | null };
export type StaffBlock = { text: string | undefined; kept: number; dropped: number; droppedTexts: string[] };
export const STAFF_BLOCK_GAP_HOURS = 6;

export function latestStaffBlock(lines: readonly TimedLine[], gapHours = STAFF_BLOCK_GAP_HOURS): StaffBlock {
  let end = lines.length - 1;
  while (end >= 0 && lines[end].sender === "customer") end--;
  if (end < 0) return { text: undefined, kept: 0, dropped: 0, droppedTexts: [] };
  let start = end;
  while (start - 1 >= 0 && lines[start - 1].sender === "staff") start--;
  const block = lines.slice(start, end + 1);
  const times = block.map((l) => l.t).filter((t): t is number => typeof t === "number" && Number.isFinite(t));
  const newest = times.length ? Math.max(...times) : null;
  const keep = block.filter((l) => newest === null || l.t === null || !Number.isFinite(l.t) || newest - l.t <= gapHours * HOUR);
  const drop = block.filter((l) => !keep.includes(l));
  return { text: keep.map((l) => l.text).join("\n"), kept: keep.length, dropped: drop.length, droppedTexts: drop.map((l) => l.text) };
}

// ═════════════════════════════════════════════════════════════════════════════
// ② 待ちの形の約束（穴1: 約束の言い直し）
// ═════════════════════════════════════════════════════════════════════════════
/**
 * 「確認出来次第ご連絡」「審査の進捗あり次第ご連絡」「見積書を作成出来次第お送り」「明日ご連絡」のように、
 * 確認・連絡・見積の約束を**待ちの形（〜次第・日付）で言い終えた**文。
 *
 * 実送信の線（直近90日・確認・連絡・見積の約束 → お客様の短い了承 → こちらの次の手打ち・グループと YUMA を除く）:
 *   直前が待ちの形・初回の挨拶文ではない 71場面 → 手打ちで返した17件のうち言い直しは3件（17.6%。うち2件は「明日」「月曜日」の新しい具体付き）
 *     ＝ 手打ちの82%・場面の96%が約束を書かず受けだけ。→ 受けだけを必須にしてよい（過半数が守っている形）
 *   同じ約束が初回の挨拶文の中 → 2/2 で言い直す（線の外）
 *   確認・連絡の約束が宣言だけ（次第なし） → 5/8 で言い直す（線の外。ここは当てない）
 *   探す・送る・撮影の約束 → 52.6〜65.8% で言い直す（線の外。ピックアップの枝は触らない）
 */
export type WaitFormKind = "確認" | "連絡" | "見積";
export type WaitFormPromise = { kind: WaitFormKind; sentence: string };

/** 初回の挨拶文（「はじめまして」「〜と申します」）。この後の了承にはスタッフも約束を言い直す（2/2）ので当てない */
export const FIRST_GREETING_TEXT_RE = /はじめまして|初めまして|と申します/;
/** 探す・送る・撮影の約束（線の外）。物件を送る約束は「出次第お送り」の形でも待ちの形として扱わない */
const OUT_OF_LINE_RE = /ピックアップ|お探し|撮影|写真|動画|(?:お部屋|物件)[^\n。！!]{0,20}(?:お送り|送らせ)|出次第/;
/** お客様の行動が先に要る条件付き（「お送り頂き次第確認させて頂きます」）は約束ではない（action-ledger CONDITIONAL_PROMISE_RE と同じ考え） */
const CUSTOMER_FIRST_RE = /(?:頂け|いただけ)(?:ましたら|たら|れば|次第)|(?:頂|いただ)き次第|お送り(?:頂|いただ)(?:き|け)|ご連絡(?:ください|下さい)/;
const OUR_REPORT_VERB = "(?:ご連絡|ご報告|お伝え)(?:させて(?:頂|いただ)き|いたし|致し|し)ます";
const WAIT_CONFIRM_RE = /(?:確認|お調べ|問い合わせ|交渉)[^\n。！!]{0,8}(?:出来|でき)次第|(?:確認|お調べ|問い合わせ)(?:させて(?:頂|いただ)き|し)(?:次第|ましたら)/;
const WAIT_ESTIMATE_RE = /見積[^\n。！!]{0,24}(?:出来|でき|作成し|ご用意し)次第|(?:作成|ご用意)(?:出来|でき)次第[^\n。！!]{0,12}(?:お送り|送らせ)/;
const WAIT_CONTACT_RE = new RegExp(`(?:次第|(?:あり|入り|分かり|わかり|出)ましたら|ありましたら)[^\\n。！!]{0,16}${OUR_REPORT_VERB}`);
const DATED_CONTACT_RE = new RegExp(`(?:明日|明後日|本日中|今日中|週明け|[0-9]{1,2}\\s*[\\/月]\\s*[0-9]{1,2}|[0-9]{1,2}日|[月火水木金土日]曜)[^\\n。！!]{0,24}${OUR_REPORT_VERB}`);

export function findWaitFormPromises(text: string | null | undefined): WaitFormPromise[] {
  const t = nfkc(text).trim();
  if (!t || FIRST_GREETING_TEXT_RE.test(t)) return [];
  const out: WaitFormPromise[] = [];
  for (const raw of t.split(SENTENCE_SPLIT_RE)) {
    const s = raw.trim();
    if (!s || STAFF_PICKUP_DECL_RE.test(s) || OUT_OF_LINE_RE.test(s) || CUSTOMER_FIRST_RE.test(s)) continue;
    if (/見積/.test(s) && WAIT_ESTIMATE_RE.test(s)) out.push({ kind: "見積", sentence: s });
    else if (WAIT_CONFIRM_RE.test(s)) out.push({ kind: "確認", sentence: s });
    else if (WAIT_CONTACT_RE.test(s) || DATED_CONTACT_RE.test(s)) out.push({ kind: "連絡", sentence: s });
  }
  return out;
}

/**
 * 待ちの形の約束の文を外した残り（約束を復唱させる決定論はこの残りを読む）。
 * 例: 「管理会社に確認出来次第ご連絡させて頂きます！！」だけの直前 → 残りは空＝復唱の材料が無い＝受けだけ
 *     「ピックアップ出来次第お送り＋確認出来次第ご連絡」→ 残りにピックアップが残る（ピックアップの復唱はスタッフの多数の形なので残す）
 */
export function withoutWaitFormPromises(text: string | null | undefined): { text: string; removed: WaitFormPromise[] } {
  const src = text ?? "";
  const removed = findWaitFormPromises(src);
  if (removed.length === 0) return { text: src, removed };
  const drop = new Set(removed.map((r) => r.sentence));
  const kept = nfkc(src).split(SENTENCE_SPLIT_RE).filter((s) => !drop.has(s.trim()));
  return { text: kept.join("\n").replace(/\n{2,}/g, "\n").trim(), removed };
}

/** 短い了承への受けだけの一文（感謝返しの既定と同じ実文。待ちの形の約束を言い終えた後の手打ちの形） */
export const WAIT_FORM_ACK_HINT = "「気になる点等出てきましたらいつでもお気軽にご連絡ください！！」（直前の約束「〜次第ご連絡」は伝え済み。同じ約束・「ご査収」を書き直さない。新しい具体（日付・時刻）が言える時だけ1文で足す）";

// ═════════════════════════════════════════════════════════════════════════════
// ③ 内覧の状態（穴3: 決まった内覧への「よろしく」に日程調整の文）
// ═════════════════════════════════════════════════════════════════════════════
/**
 * 内覧が「決まっている」か（待ち合わせを案内済み／こちらの提案した日時をお客様が受諾）。
 *   ・台帳の viewingAppointment（待ち合わせの案内・今日以降・内覧後のお礼の前）
 *   ・viewing-thread の scheduled（打診の後にこちらの待ち合わせ・お客様の受諾）
 * 旧: 「内覧日程確定後シンプル締め」は履歴の各発言の**1行目**しか見ず、決まった内覧への了承44組で3組しか発火しなかった
 *     （AIX 待ち合わせは1行目が「かしこまりました！！」で、日時・住所の行が見えない）。
 *     1行目の不具合だけ直して全文を見ると提案中にも27組発火して逆効果（提案中はスタッフも「ご都合よろしいお日にち」を使う）
 *     → 状態は viewing-thread と台帳の2つの判定に寄せる（ここ1か所）
 */
export type ViewingScheduled = { scheduled: boolean; source: "meeting_place" | "customer_accepted" | "staff_meeting_text" | null; label: string | null };
/**
 * 日時を1つだけ出して都合を聞いた打診（「9/7(月)16:00より、ご都合如何でしょうか」）への、発言全体が短い受諾（「はい！大丈夫です！」）。
 * viewing-thread の CUSTOMER_SLOT_ACCEPT_RE は「はい[、。]」しか許さず「はい！大丈夫です！」を受諾に読めない。
 * ⚠ viewing-thread の方は AIX【物件確認した】の会話を合わせる（新しい日時を落とす縛り）も読むので変えない。返信生成の側だけで読む
 *   （実物: d3a56a97 下書き「お気に召されましたらご都合よろしいお日にちにご案内」→ 実送信「明日 9/7 16:00〜よりオンライン内見させて頂きます」）
 */
/** 候補の枠「9/7(月) 16:00〜18:00」の始まりだけ（「16:00より」の打診に解析器が補った終わりの時刻を渡さない） */
export function slotStartLabel(label: string): string {
  return label.replace(/\s*[〜~～]\s*[0-9]{1,2}:[0-9]{2}\s*$/, "〜");
}
const SINGLE_SLOT_ACCEPT_RE = /大丈夫|お願い|OK|伺います|行けます|向かいます|承知|かしこまり|了解/i;
/**
 * お客様の今回の発言が、こちらの候補への受諾ではなく逆提案・都合の相談（「申し訳ございませんが平日ですと18:30以降しか間に合わず」）。
 * 2026-09-26 反証レビュー: viewing-thread の受諾の正規表現は行の中の「〜可能」「お願い」に当たり、逆提案も scheduled にした（2ae0d94e）。
 */
//   ⚠ 「？」は外さない（3d9b67d7「内見当日は現地集合になりますか？／9/9の15時からお願いします！」は正しい受諾）
const CUSTOMER_COUNTER_RE = /しか(?:間に合|空い|行け|無理)|間に合わ|難し|厳し|以降でしたら|別の(?:日|お日にち|時間)|他の(?:日|時間)|ずらし/;
/** 当日の待ち合わせで、始まりから この分数を過ぎたら「これからの内覧」として扱わない（内覧中・内覧後の了承に「本日何卒」を渡さない） */
export const SAME_DAY_PASSED_MIN = 60;
export function resolveViewingScheduled(input: {
  appointment: LedgerFacts["viewingAppointment"];
  viewingDone: LedgerFacts["viewingDone"];
  thread: ViewingThreadVerdict | null;
  /** お客様の今回の発言（候補1つの打診への短い受諾を読む時だけ使う） */
  customerText?: string | null;
  /** 当日の待ち合わせの時刻が過ぎたかを見る基準（既定 Date.now()） */
  nowMs?: number;
}): ViewingScheduled {
  const none: ViewingScheduled = { scheduled: false, source: null, label: null };
  if (input.viewingDone) return none;
  // 2026-09-26 反証レビュー（直近60日の待ち合わせ由来82組を目で読んだ）: 当日の内覧が終わった後の了承（実送信は「本日お時間頂きありがとうございました」）
  //   4組にも「決まっている」を渡していた（ae3ffecb・2ae0d94e・9280fa49・719c1854 型）。台帳の「内覧後のお礼」はこちらが送るまで立たないので、
  //   当日で始まりから60分を過ぎた待ち合わせは「決まっている」にしない（旧の扱いに戻すだけ・台帳の【決まっている内覧】は変えない）
  if (input.appointment && sameDayAppointmentPassed(input.appointment, input.nowMs ?? Date.now())) return none;
  if (input.appointment) return { scheduled: true, source: "meeting_place", label: appointmentLabel(input.appointment) };
  const th = input.thread;
  if (th && th.kind === "proposed_waiting_reply" && th.slots.length === 1 && /如何|いかが|ご都合/.test(th.proposalText)
    && isWholeShortAck(input.customerText) && SINGLE_SLOT_ACCEPT_RE.test(nfkc(input.customerText))) {
    return { scheduled: true, source: "customer_accepted", label: slotStartLabel(th.slots[0]) };
  }
  // 2026-09-26 反証レビュー（viewing-thread の scheduled 16組を目で読んだ）:
  //   候補の日時が無い「打診」（定型「お気に召されましたらご都合よろしいお日にちにご案内」・費用の説明の「最安値のお日にち」）への
  //   「わかりました／お願いします」「こちらはやめときます」「今日はありがとうございました」まで scheduled になっていた（10組中ほぼ全部が誤り）。
  //   候補の日時を出した打診だけを「決まった」に数える（候補ありの6組は5組が正しい。残る1組は逆提案＝CUSTOMER_COUNTER_RE で外す）
  if (th && th.kind === "scheduled" && th.slots.length > 0 && !CUSTOMER_COUNTER_RE.test(nfkc(input.customerText))) {
    const accepted = th.reason.startsWith("customer_accepted");
    return {
      scheduled: true,
      source: accepted ? "customer_accepted" : "staff_meeting_text",
      // 候補が1つの時だけ日時を言える（2つ以上の提案への「大丈夫です」はどれか決められない＝日時を作らない）
      label: th.slots.length === 1 ? slotStartLabel(th.slots[0]) : null,
    };
  }
  return none;
}

/** 当日の待ち合わせで、始まりの時刻から SAME_DAY_PASSED_MIN 分を過ぎたか（時刻が読めない・当日でない時は false） */
export function sameDayAppointmentPassed(a: NonNullable<LedgerFacts["viewingAppointment"]>, nowMs: number): boolean {
  if (a.day !== "today" || !a.time) return false;
  const m = a.time.match(/^([0-9]{1,2}):([0-9]{2})$/);
  if (!m) return false;
  const p = jstParts(nowMs);
  return p.hour * 60 + p.minute > Number(m[1]) * 60 + Number(m[2]) + SAME_DAY_PASSED_MIN;
}

/**
 * 発言全体が短い了承だけか（「はい！大丈夫です！」「よろしくお願いします」「わかりました！大丈夫です🙆」）。
 * 旧判定は行単位（/m）で、苦情の長文の1行にも当たった（scheduled×短い了承の36組中1件の誤り）。
 */
const WHOLE_ACK_UNIT_RE = /^(?:はい|了解|承知|かしこまり|わかりました|分かりました|大丈夫です|お願いします|よろしくお願い|宜しくお願い|ありがとう|OK|おっけー|オッケー)[^\n]{0,14}$/i;
const ACK_RESCHEDULE_RE = /別日|別の日|変更|ずらし|都合(?:が)?悪|難しく|延期|キャンセル|遅れ|早め|[?？]/;
export function isWholeShortAck(text: string | null | undefined): boolean {
  // 複数通は MSG_SEP（"\n⁣\n"）でつながって来る。区切りの見えない文字は落として通ごとに見る
  const units = nfkc(text).replace(/⁣/g, "").split("\n").map((s) => s.replace(/\[スタンプ\]/g, "").trim()).filter(Boolean);
  if (units.length === 0 || units.length > 3) return false;
  const core = units.join("").replace(/[\p{Extended_Pictographic}‍️]/gu, "");
  if (Array.from(core).length > 40 || ACK_RESCHEDULE_RE.test(core)) return false;
  return units.every((u) => WHOLE_ACK_UNIT_RE.test(u.replace(/[\p{Extended_Pictographic}‍️]/gu, "").trim()));
}

/**
 * 決まっている内覧の注記（dynamicBlock・毎回変わる値なのでキャッシュの前置きには入れない）。
 * 静的な前置き（GENERATION_SYSTEM・PHASE_GUIDE・meetingPlaceGateNote）の「内覧に触れる場合は〜のみ許可」「詳細はご連絡のみ」は
 * この見出し【🗓 内覧は決まっている】がある時は使わない、と静的側に1回だけ書いてある（書くなと書けを別の場所から渡さないため、
 * 静的な許可文の側がこの見出しを見る形にした）。
 */
export const VIEWING_SCHEDULED_HEADING = "【🗓 内覧は決まっている】";
export function buildViewingScheduledNote(v: ViewingScheduled): string {
  if (!v.scheduled) return "";
  const when = v.label ? `（${v.label}）` : "";
  const how = v.source === "customer_accepted"
    // 2026-09-26 YUMA の前後比較（S5）: 待ち合わせはまだ案内していないのに「現地エントランスにてお待ち合わせできますでしょうか」を作った（3回中1回）。
    //   待ち合わせの場所・集合は AIX【待ち合わせ】で送る事なので、日時だけを言うと渡す
    ? "お客様は、こちらが提案した日時を受けてくれた（今回の発言がその返事）。待ち合わせの場所（エントランス・集合場所）はまだ案内していないので書かない（AIX【待ち合わせ】で送る）。"
    : "待ち合わせは案内済み。";
  return `\n${VIEWING_SCHEDULED_HEADING}${when}${how}「ご都合よろしいお日にちに」「内覧の詳細については（改めて）ご連絡」は書かない（決まった事を未定に戻す）。内覧に触れる時は決まっている日時をそのまま言う。短い了承には「はい😊！！」＋「（本日／明日／〇日）何卒よろしくお願い致します！！」で受ける。`;
}

/** 決まっている内覧の「時」（「13:00」「16時」「15時半」→ 13・16・15）。validate-reply の待ち合わせの復唱の免除で、文の時刻がこの中にある時だけ通す */
export function viewingHoursOf(text: string | null | undefined): number[] {
  const out = new Set<number>();
  for (const m of nfkc(text).matchAll(/([0-9]{1,2})\s*(?::[0-9]{2}|時)/g)) { const h = Number(m[1]); if (h >= 6 && h <= 23) out.add(h); }
  return [...out];
}

/** 決まった内覧への短い了承の締め（「本日／明日／9/27 何卒よろしくお願い致します！！」）。日付が読めない時は日付を書かない */
export function viewingAckLine(appointment: LedgerFacts["viewingAppointment"]): string {
  const a = appointment;
  const day = !a ? "" : a.day === "today" ? "本日" : a.day === "tomorrow" ? "明日" : a.day === "later" && a.dateMD ? a.dateMD : "";
  return `${day}何卒よろしくお願い致します！！`;
}

// ═════════════════════════════════════════════════════════════════════════════
// ④ 連投の途中（isFollowUp）の「済んだ事」（穴2）
// ═════════════════════════════════════════════════════════════════════════════
/**
 * isFollowUp の時、台帳の注記（buildLedgerNote）・往復文脈・前回送信の注記は全部空になる（連投の続きに往復の規則を当てないため）。
 * その結果「募集中と報告した2分後に募集状況を確認します」「物件を送っている最中にピックアップ出来次第お送り」が出た（60日4件）。
 * 連投の途中でも変わらない「済んだ事」の確定行だけを渡す（物件名は書かない＝竹内方針2・件数と種類だけ）。
 */
export function buildFollowUpDoneNote(ledger: ActionLedger | null): string {
  if (!ledger) return "";
  const f = ledger.facts;
  const done: string[] = [];
  if (f.propertiesSentCount > 0) done.push(`物件${f.propertiesSentCount}件送付済み`);
  if (f.estimateSent) done.push("御見積書送付済み");
  if (f.recentDone.vacancyCheck || f.recentDone.mgmtCheck) done.push(`確認結果を報告済み${f.confirmationReportDetail ? `（${f.confirmationReportDetail}）` : ""}`);
  if (f.viewingAppointment) done.push(`内覧の待ち合わせ案内済み（${appointmentLabel(f.viewingAppointment)}）`);
  const open: string[] = [];
  if (f.pickupPromisedUnfulfilled) open.push("ピックアップ");
  if (f.estimatePromisedUnfulfilled) open.push("御見積書の作成");
  if (f.confirmationPromisedUnfulfilled) open.push(`${f.confirmationPromisedObject ?? ""}確認`);
  if (done.length === 0 && open.length === 0) return "";
  return `\n【📒 済んだ事（連投の途中でも変わらない確定事実）】${done.length ? done.join("／") : "送付・報告の記録なし"}${open.length ? `。約束済み（まだ果たしていない）: ${open.join("・")}` : ""}。→ 済んだ事を「これから行います」と書かない。約束済みの事をもう一度約束しない。`;
}

/**
 * 連投の途中で、お客様の最後の発言より後に AIX を送っている（＝その発言にはもう AIX で答えた）。
 * route.ts の aixDone の解除条件（新しい URL・再確認の依頼・新しいピックアップの依頼・日程の受諾）は、お客様の発言を読み直して
 * 「新しい依頼だから再宣言は正当」と外すが、答え終えた発言を読み直すと「確認済み・送付済み」の禁止まで外れていた（a61cac0b・19ca0a6d 型）。
 */
export function customerAnsweredByAix(
  isFollowUp: boolean,
  lastCustomerAt: string | null | undefined,
  aixRows: ReadonlyArray<{ sent_at?: string | null; created_at: string | null }>,
  nowMs: number = Date.now(),
): boolean {
  if (!isFollowUp) return false;
  const c = Date.parse(lastCustomerAt ?? "");
  if (!Number.isFinite(c)) return false;
  // 2026-09-26 反証レビュー: 予約送信の AIX は sent_at が未来（まだ送っていない）。送っていない AIX で「答え終えた」にしない
  return aixRows.some((r) => { const t = Date.parse(r.sent_at ?? r.created_at ?? ""); return Number.isFinite(t) && t > c && t <= nowMs; });
}
