// app/lib/viewing-guide-text.ts
// AIX【内覧誘導】の本文を物件ごとの状態（空室／退去予定）から組み立てる（純関数・DB 依存なし）。
//
// 2026-09-19 竹内（はる事例）「退去予定日もいれて、内覧誘導する。2枚目が実際に送った文となる。
//   退去予定日よみこめるか、入力して会話を合わせるで文が生成されるようにする」
//
// 【旧の穴】
//   ・空室／退去予定の判定が **propList.length <= 1 && image?.base64** の時だけ動く作りで、
//     画面（内覧誘導ピッカー）は analyze に画像を渡していない＝**一度も判定が走っていなかった**
//   ・status が**全物件で1つ**しか持てず、「1件は空室・1件は退去予定」を書き分けられない
//   ・退去予定の文が `${vacateDate}以降にご案内可能` ＝ **退去日そのものを解禁日**にしていた
//     （正しくは翌日。黄金ルール「内覧できるのは翌日以降」／viewableFromVacancyDate が既にある）
//
// 【実送信（はる 2026-09-19 15:56・スタッフが手で書いた文）＝この骨組みをそのまま使う】
//   よろしければ一度ご内覧如何でしょうか😊！！
//
//   The Peak Osaka Bay 202号室は空室ですので、はるさんご都合よろしいお日にちにお部屋ご案内させて頂きます！！
//
//   エスリード弁天町パークプレイスにつきましては退去予定のお部屋となりますので10月1日以降ご内覧可能です😌！！
//
// 事実（物件名・号室・退去予定日）はスタッフの入力だけ。言い回しはこの決まった文。判断（空室か退去予定か）は
// 「退去予定日が入っているか」で決まる決定論にする（設計知見「事実は入力・言い回しは決まった文・判断は決定論」）。

import { viewableFromVacancyDate, vacancyDateLabel } from "./vacating-notice";

export type ViewingGuideProperty = {
  name: string;
  roomNumber?: string | null;
  /** 退去予定日（「9月30日」「9月末」等）。空なら空室扱い */
  vacateDate?: string | null;
};

/** 「The Peak Osaka Bay 202号室」／号室が無ければ物件名だけ */
export function propertyLabel(p: ViewingGuideProperty): string {
  const name = (p.name ?? "").trim();
  const room = (p.roomNumber ?? "").trim();
  if (!name) return "";
  return room ? `${name} ${room.replace(/号室$/, "")}号室` : name;
}

/** 敬称（既に さん／様 が付いていれば足さない・空なら「お客様」） */
function withHonorific(customerName: string | null | undefined): string {
  const n = (customerName ?? "").trim();
  if (!n) return "お客様";
  return /(さん|様)$/.test(n) ? n : `${n}さん`;
}

const OPENING = "よろしければ一度ご内覧如何でしょうか😊！！";

export type ViewingGuideResult = {
  text: string;
  /** 退去予定の物件があるか（画面の表示用） */
  hasVacating: boolean;
  /** 退去日が入っているのに読めなかった物件名（スタッフに直してもらう） */
  unreadable: string[];
};

/**
 * 内覧誘導の本文。空室の物件と退去予定の物件を**段落で分けて**書く（実送信の形）。
 * 退去予定日が読めない物件は本文に混ぜず、unreadable で返して画面で知らせる（曖昧な日付を送らない）。
 */
export function buildViewingGuideText(
  props: ReadonlyArray<ViewingGuideProperty>,
  customerName: string | null | undefined,
  nowMs: number = Date.now(),
): ViewingGuideResult {
  const name = withHonorific(customerName);
  const valid = props.filter((p) => (p.name ?? "").trim());
  const available: string[] = [];
  const vacating: Array<{ label: string; from: string; vac: string }> = [];
  const unreadable: string[] = [];

  for (const p of valid) {
    const label = propertyLabel(p);
    const vac = (p.vacateDate ?? "").trim();
    if (!vac) { available.push(label); continue; }
    const from = viewableFromVacancyDate(vac, nowMs);
    if (!from) { unreadable.push(label); continue; }
    vacating.push({ label, from, vac });
  }

  const paras: string[] = [OPENING];

  if (available.length > 0) {
    // 実送信:「The Peak Osaka Bay 202号室は空室ですので、はるさんご都合よろしいお日にちにお部屋ご案内させて頂きます！！」
    paras.push(`${available.join("と")}は空室ですので、${name}ご都合よろしいお日にちにお部屋ご案内させて頂きます！！`);
  }

  for (const v of vacating) {
    // 実送信:「エスリード弁天町パークプレイスにつきましては退去予定のお部屋となりますので10月1日以降ご内覧可能です😌！！」
    paras.push(`${v.label}につきましては${vacancyDateLabel(v.vac)}退去予定のお部屋となりますので${v.from}以降ご内覧可能です😌！！`);
  }

  // 物件が1つも無い時は日程だけ聞く（従来の形）
  if (available.length === 0 && vacating.length === 0) {
    paras.push(`${name}ご都合よろしいお日にちにご案内させて頂きます😊！！`);
  }

  return { text: paras.join("\n\n"), hasVacating: vacating.length > 0, unreadable };
}
