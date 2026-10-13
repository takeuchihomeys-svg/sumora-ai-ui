// app/lib/check-result-status-lines.ts
// AIX【物件確認した】（物件あった）の文を、物件ごとのピッカー（空室／退去予定／申込あり／別の部屋）と食い違わない形にする（純関数）。
//
// 2026-10-13 竹内さん（会話「未桜」10/09）: ピッカーで「申込あり」を入れたのに、会話を合わせるの文が
//   「レジュールアッシュ難波MINAMIの募集状況確認させて頂きました！！／現在募集中のお部屋となっております😊／…御見積書同封…」で、
//   申込の説明が抜けていた（スタッフが「現在1番手でお申込が入っており、2番手以降でお申込可能となります！！」に直して送った）。
//   「物件ごとに付けているピッカーの事も理解して文を生成する必要がある」。
//
// 直近30日の物件確認した（物件あった）でピッカーに 申込あり／退去予定／別の部屋 が入った下書き 15通のうち、ピッカーと文が食い違ったのは4通:
//   ・申込あり なのに番手・お申込みの説明が無い 1通（未桜・会話を合わせる）
//   ・別の部屋 なのに「別の」が無い 3通（1件の決まった文に別の部屋の分岐が無く「〇〇現在募集中となります」になっていた）
//     スタッフの直し:「レジュールアッシュPREMIUM TWIN II 別のお部屋ですが206号室現在募集中となります！！」
//                    「レジュールアッシュ北大阪 GRAND STAGE 別号室が206号室現在募集中となります！！」
//
// 言い回しは実送信（365日・スタッフの行）で数えた一番多い形:
//   申込あり（1件）: 「現在お申込みが入っており、2番手でのお申込みが可能となっております！！」10通（物件確認の結果の言い方で最多）
//   別の部屋（1件）: 「{建物} 別のお部屋ですが{号室}現在募集中となります！！」（ザ・コッチ神戸・レジュールアッシュ PREMIUM TWIN II・別号室が の形 計3通）
// 直し方は「足すだけ」（語は消さない＝誤削除 0）。食い違いが残る時は出口（findCheckStatusContradiction）が止めて人に見せる。

import { buildApplicationNote, isApplied } from "./application-status-note";

/** 申込・番手を言っているか（aix-material-facts の APPLIED_RE と同じ範囲＋「お申込みが入っ」の言い方） */
export const CHECK_APPLIED_TALK_RE = /[1１一]番手|[2２二]番手|申込(?:み)?(?:が|は)?(?:入って|入り|はいって|あり|済)|お申込みが入っ|お申し込みが入っ/;
/** 別の部屋を言っているか */
export const CHECK_ALT_TALK_RE = /別の?(?:お)?部屋|別号室/;

/** 申込あり1件の時に足す1文（実送信で最多の形） */
export const APPLIED_SINGLE_LINE = "現在お申込みが入っており、2番手でのお申込みが可能となっております！！";

/** 「建物 205号室」→ { building, room }（号室が無ければ room は空） */
export function splitBuildingRoom(name: string): { building: string; room: string } {
  const s = String(name ?? "").trim();
  const m = s.match(/^(.*?)[\s　]*([0-9０-９]{1,4}[A-Za-z]?\s*号室?)$/);
  if (!m || !m[1].trim()) return { building: s, room: "" };
  const room = /号室$/.test(m[2]) ? m[2].replace(/\s+/g, "") : `${m[2].replace(/\s+/g, "").replace(/号$/, "")}号室`;
  return { building: m[1].trim(), room };
}

/** 1件の決まった文の「別の部屋」の1行（スタッフの直しの形） */
export function alternativeSingleLine(name: string): string {
  const { building, room } = splitBuildingRoom(name);
  if (building && room) return `${building} 別のお部屋ですが${room}現在募集中となります！！`;
  return `${(name ?? "").trim()} 別のお部屋ですが現在募集中となります！！`.trim();
}

export type CheckStatusInput = {
  statuses: ReadonlyArray<string | null | undefined>;
  names: ReadonlyArray<string | null | undefined>;
  propertyCount: number;
};

/**
 * ピッカーの「申込あり」が文に出ていない時だけ、申込の説明を足す（足すだけ・消さない）。
 * 入れる場所: 「募集中」を言った行の直後 →（無ければ「募集状況」の行の直後） → 無ければ御見積書の行の前 → 無ければ末尾。
 */
export function ensureAppliedTalk(text: string, o: CheckStatusInput): { text: string; added: boolean } {
  const body = String(text ?? "");
  const n = Math.max(1, o.propertyCount);
  const props = Array.from({ length: n }, (_, i) => ({ name: String(o.names[i] ?? "").trim(), status: String(o.statuses[i] ?? "available") }));
  if (!props.some((p) => isApplied(p.status))) return { text: body, added: false };
  if (CHECK_APPLIED_TALK_RE.test(body)) return { text: body, added: false };
  const note = n === 1 ? APPLIED_SINGLE_LINE : buildApplicationNote(props);
  if (!note) return { text: body, added: false };
  const lines = body.split("\n");
  let at = lines.findIndex((l) => /募集中/.test(l));
  if (at < 0) at = lines.findIndex((l) => /募集状況/.test(l));
  if (at >= 0) {
    lines.splice(at + 1, 0, note);
  } else {
    at = lines.findIndex((l) => /御見積書|ご査収/.test(l));
    if (at >= 0) lines.splice(at, 0, note, "");
    else lines.push(note);
  }
  return { text: lines.join("\n"), added: true };
}

/** ピッカーと文の食い違い（出口で止める・数える用）。無ければ null */
export function findPickerTalkMismatch(text: string, o: CheckStatusInput): string | null {
  const body = String(text ?? "");
  const n = Math.max(1, o.propertyCount);
  const st = Array.from({ length: n }, (_, i) => String(o.statuses[i] ?? "available"));
  if (st.some(isApplied) && !CHECK_APPLIED_TALK_RE.test(body)) return "「申込あり」にした物件があるのに、文にお申込み（番手）の説明がありません";
  if (st.includes("alternative") && !CHECK_ALT_TALK_RE.test(body)) return "「別の部屋」にした物件があるのに、文に別のお部屋の説明がありません";
  if (st.includes("vacating") && !/退去予定/.test(body)) return "「退去予定」にした物件があるのに、文に退去予定がありません";
  return null;
}

/** 会話を合わせるの確認結果の1行（物件ごとのピッカーから・全部が申込ありなら「募集中」とだけ書かせない） */
export function cmAvailableResultDesc(statuses: ReadonlyArray<string | null | undefined>, propertyCount: number): string {
  const st = Array.from({ length: Math.max(1, propertyCount) }, (_, i) => String(statuses[i] ?? "available"));
  const base = "募集中（入居時期は確認結果に無い。入居可能日の入力が無ければ「即入居」等の入居時期は書かない）";
  if (st.every(isApplied)) {
    return "募集は出ているが、既に1番手のお申込みが入っている（申込あり）→「現在募集中のお部屋」とだけ書かず、2番手でのお申込みとなる事を必ず書く";
  }
  if (st.some(isApplied)) return `${base}。ただし「申込あり」の物件は2番手でのお申込みとなる事を物件名で名指しして書く`;
  return base;
}
