// app/lib/property-told.ts（純関数・DB/LLM なし）
// 今の番の物件について「こちらがもう伝えた事」と「募集状況の鮮度」を、送った時の文から決まった処理で拾う（ブレインの材料・費用0）。
//
// 2026-10-16 竹内悠馬（10/16 の画面の事例 c・d・g）「お客様がどの物件のことを、どんな背景・意図で言っているかを読む」:
//   (c) 数分前にこちらが送った2件（「こちらの2件初期費用2,980円＋前家賃でご入居出来るお部屋…ご都合よろしいお日にちにご案内」）の1件を引用して
//       「こちらの物件気になります」→ 正解は内覧の誘導。ブレインは物件は分かっていたのに「募集状況を確認し最大限割引の御見積書を作成してお送りする約束」にした
//       （本番 brain_decision_logs 10/15 10:56）。台帳の文には「10/15 19:54 こちらが資料を送った」しか無く、送った時に初期費用まで伝えた事・
//       送った時点で募集中（こちらが探して送った）事が材料に無かった＝持ち込みの物件と同じ扱い（2段の確認＋見積）に倒れた。
//   (g) 4日前に御見積書を送った物件の「最終的なお支払い金額」→ 正解は送った御見積書で内訳を答える AIX【初期費用について】。ブレインは見積を作る約束にした。
//   60日の本番（読むだけ）: こちらが3日以内に送った物件を引用した「気になります」の次の AIX は 見積書 3・内覧日調整 3・その他（返信）4＝費用を伝えたかで分かれる。
// 決め: 決めるのはブレイン（道は決めない）。材料の1〜3行（伝え済み・募集状況の鮮度・目安）を台帳の ▶ の物件の下に足す。戻す PROPERTY_TOLD_NOTE=off

export function propertyToldEnabled(env: Record<string, string | undefined> = process.env): boolean {
  return (env.PROPERTY_TOLD_NOTE ?? "").trim().toLowerCase() !== "off";
}

export type ToldMsg = { sender: string; text: string | null; created_at: string; image_url?: string | null };
export type ToldEvent = { at: string; kind: string; text?: string };
export type RoomTold = {
  /** こちらが最後に送った（資料・オススメ）時刻 */
  lastSentAt: string | null;
  /** 送った時の文で初期費用を伝えた（文の抜き出し・30字） */
  cost: { at: string; quote: string } | null;
  /** 送った時の文でご案内（内覧）に誘った */
  viewingInvited: boolean;
  /** 御見積書を送った（最後）・金額の短い文 */
  estimate: { at: string; text: string | null } | null;
  /** 送った後に募集終了・申込が入ったと分かった */
  endedAfterSent: boolean;
};

const COST_TOLD_RE = /初期費用|前家賃|御見積|見積書/;
const VIEWING_INVITE_RE = /ご案内|ご内覧|内覧/;
const IMAGE_RE = /^\s*\[(?:画像|動画)\]\s*$/;
const ms = (s: string) => Date.parse(s);

function sentenceWith(text: string, re: RegExp): string {
  const ss = text.split(/[\n。！!]+/).map((x) => x.trim()).filter((x) => re.test(x));
  const s = ss.find((x) => /[0-9０-９]/.test(x)) ?? ss[0] ?? "";
  return Array.from(s).slice(0, 30).join("");
}

/**
 * room の出来事（sent / recommended / estimate / check_*）と会話の通から、伝え済みを拾う。
 * 送った時の文＝送った出来事の10秒前〜4分後のこちらの文（画像以外）。同じ束で複数の物件を送った文（「こちらの2件…」）は全部の物件に当てる。
 */
export function roomToldOf(events: ReadonlyArray<ToldEvent>, msgs: ReadonlyArray<ToldMsg>): RoomTold {
  const sends = events.filter((e) => e.kind === "sent" || e.kind === "recommended");
  const lastSent = sends.length ? sends.reduce((a, b) => (ms(b.at) > ms(a.at) ? b : a)) : null;
  let cost: RoomTold["cost"] = null;
  let viewingInvited = false;
  for (const s of sends) {
    const t0 = ms(s.at);
    for (const m of msgs) {
      if (m.sender !== "staff" || !m.text || IMAGE_RE.test(m.text)) continue;
      const t = ms(m.created_at);
      if (t < t0 - 10_000 || t > t0 + 4 * 60_000) continue;
      if (COST_TOLD_RE.test(m.text) && (!cost || t > ms(cost.at))) cost = { at: m.created_at, quote: sentenceWith(m.text, COST_TOLD_RE) };
      if (VIEWING_INVITE_RE.test(m.text)) viewingInvited = true;
    }
  }
  const est = events.filter((e) => e.kind === "estimate").at(-1);
  const endedAfterSent = !!lastSent && events.some((e) => (e.kind === "check_ended") && ms(e.at) > ms(lastSent.at));
  return { lastSentAt: lastSent?.at ?? null, cost, viewingInvited, estimate: est ? { at: est.at, text: est.text ?? null } : null, endedAfterSent };
}

/** 材料の行（▶ の物件の下）。topic は今の番の話題（property-thread の PtTopic）。jst は時刻の短い書き方 */
/** 前向きな反応（質問ではない）。2026-10-16 gate1（q150）: 「202は子ども不可ですか」（質問）にも内覧の目安を出していた → 質問の番には出さない */
const LIKE_RE = /気にな|いい(?:です|な|ね|感じ)|良い|良さ|素敵|好き|ここ(?:が|で|に)|見てみたい|見に行きたい|内覧|内見/;
const QUESTION_RE = /[?？]|ですか|ますか|でしょうか|かな|可能|できますか|出来ますか/;
export function isPositiveReaction(text: string | null | undefined): boolean { const t = String(text ?? ""); return LIKE_RE.test(t) && !QUESTION_RE.test(t); }
export function roomToldLines(i: { told: RoomTold; origin: "ours" | "customer" | null | undefined; topic: string; turnAt: string; jst: (iso: string) => string; customerText?: string | null }): string[] {
  const { told, origin } = i;
  const L: string[] = [];
  const parts: string[] = [];
  if (told.cost) parts.push(`初期費用（${i.jst(told.cost.at)}「${told.cost.quote}」）`);
  if (told.estimate) parts.push(`御見積書（${i.jst(told.estimate.at)}${told.estimate.text ? `・${told.estimate.text}` : ""}）`);
  if (told.viewingInvited) parts.push("ご案内（内覧）の誘い");
  if (parts.length) L.push(`  ・このお部屋でもう伝えた事（送った時のこちらの文から）: ${parts.join("・")}`);
  const hoursSinceSent = told.lastSentAt ? (ms(i.turnAt) - ms(told.lastSentAt)) / 3600_000 : null;
  const freshOurs = origin === "ours" && hoursSinceSent !== null && hoursSinceSent >= 0 && hoursSinceSent <= 72 && !told.endedAfterSent;
  if (freshOurs) L.push(`  ・募集状況: こちらが探して送ったお部屋（${i.jst(told.lastSentAt!)}・送った時点で募集中・${hoursSinceSent! < 1 ? "1時間以内" : `${Math.round(hoursSinceSent!)}時間前`}）`);
  // 目安（決めるのはブレイン）。こちらの物件で、費用の質問・前向きな反応・内覧・詳細の番だけ
  const costKnown = !!told.cost || !!told.estimate;
  if (i.topic === "cost" && told.estimate) {
    L.push("  → 目安: 御見積書は送り済み＝金額・内訳・最終のお支払いの質問は、送った御見積書で答える AIX【初期費用について】（route=aix・aix=cost_breakdown。作り直す約束・確認の約束にしない）");
  } else if (freshOurs && (i.topic === "like" || i.topic === "viewing" || isPositiveReaction(i.customerText))) {
    L.push(costKnown
      ? "  → 目安: 初期費用まで伝え済み・送った時点で募集中＝前向きな反応の次は内覧の日程（route=aix・aix=viewing_invite＝AIX【内覧日調整】・このお部屋だけ・約束の返信にしない・「内覧をご希望か」を確かめる返信にしない＝竹内さんは意向を聞き直さず日程を送る）。募集状況の確認・御見積書を作る約束にしない（お客様が他の事を聞いていればそれに答える）"
      : "  → 目安: 送った時点で募集中・費用はまだ＝前向きな反応の次は御見積書（route=aix・aix=estimate_sheet）か内覧の日程（aix=viewing_invite）。募集状況の確認の約束にしない");
  }
  return L;
}
