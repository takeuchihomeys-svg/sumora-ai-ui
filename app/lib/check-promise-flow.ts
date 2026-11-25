// app/lib/check-promise-flow.ts — お客様が送ってきた物件の確認の約束の流れ（竹内さんの4つの決め 11/25 朝・台帳 #688・決まった計算・LLM なし）
// 2026-11-25 作業員A（統括役の頼み）: 主の数の割れ「前24時間にお客様が物件を送ってきた」（竹内さん本人 n49・返信が先 23／物件確認した 18）を竹内さんに4問で決めて頂いた（4問とも推奨のとおり）:
//   ① 確認の約束の後、お客様がお礼・了承だけ → 返信は送らず、確認の結果が揃ったら【物件確認した】（後で果たす約束）
//   ② 確認の約束の後、お客様が別の問いを足した → まず問いに返信・確認の結果は後で【物件確認した】
//   ③ 物件を送ってきて、まだ確認の約束をしていない → まず「確認させて頂きます」の返信・結果が手元にある時だけすぐ【物件確認した】
//   ④ 確認の約束の後、お客様が了承に一言足した → 足した所に返信・結果が揃ったら【物件確認した】
//   場面は AIX の札（aix-state-card の checkFlow）と同じ欄で見分ける。ブレインへは材料の1行（答えの規則でなく竹内さんの決め）として渡す。
//   スイッチ BRAIN_CHECK_PROMISE_FLOW: 既定 off（材料に入れない・札の欄は計算する）／on（ブレインの材料に1行）
import { isAckOnlyTurn } from "./ack-topic-scope";
import { classifyCustomerBurst } from "./customer-reaction-predict";

export type CheckFlowScene = "ack_wait" | "question_after_promise" | "brought_no_promise" | "ack_plus";
export type CheckFlow = {
  /** 当たった場面（当たらない時 null） */ scene: CheckFlowScene | null;
  /** 前24時間にお客様が物件（URL・ポータルの画面・画像）を送ってきた */ brought24h: boolean;
  /** 今の連投にお客様が物件を送ってきた */ broughtNow: boolean;
  /** 今の連投より前の24時間に、こちらが確認の約束をした（手打ちの文） */ checkPromised: boolean;
  /** その約束の後に【物件確認した】を送った */ resultSent: boolean;
};
type Msg = { sender: string; text: string | null; createdAt: string; isAix?: boolean };
type Aix = { aix_type?: string | null; sent_at?: string | null; created_at?: string | null };

/** 確認の約束の語（scripts/lib/combo-of-moves の PREV_PROMISE_OF の物件確認した と同じ網＝主の数の数え方とそろえる） */
export const CHECK_PROMISE_RE = /募集状況(?:を)?確認|空き(?:状況)?(?:を)?確認|確認させて頂きます|確認出来次第|確認でき次第/;
/** お客様が物件を送ってきた印（metric-map の BROUGHT_SHAPE_RE と同じ網） */
export const BROUGHT_RE = /https?:\/\/|物件名|^\[画像\]/;

export function brainCheckPromiseFlowOn(env: Record<string, string | undefined> = typeof process !== "undefined" ? process.env : {}): boolean {
  return (env.BRAIN_CHECK_PROMISE_FLOW ?? "").trim().toLowerCase() === "on";
}

/** 場面（純関数）。messages は古い順でも新しい順でもよい・now より後は見ない */
export function checkPromiseFlowOf(messages: ReadonlyArray<Msg>, aixRows: ReadonlyArray<Aix>, now: number): CheckFlow {
  const ms = messages.filter((m) => Date.parse(m.createdAt) <= now).sort((a, b) => Date.parse(a.createdAt) - Date.parse(b.createdAt));
  let k = ms.length - 1;
  while (k >= 0 && ms[k].sender === "customer") k--;
  const burst = ms.slice(k + 1);
  const empty: CheckFlow = { scene: null, brought24h: false, broughtNow: false, checkPromised: false, resultSent: false };
  if (!burst.length) return empty;
  const burstAt = Date.parse(burst[0].createdAt);
  const brought = (m: Msg) => m.sender === "customer" && BROUGHT_RE.test(String(m.text ?? ""));
  const brought24h = ms.some((m) => brought(m) && now - Date.parse(m.createdAt) <= 86_400_000);
  const broughtNow = burst.some(brought);
  const promises = ms.filter((m) => m.sender !== "customer" && !m.isAix && Date.parse(m.createdAt) < burstAt && burstAt - Date.parse(m.createdAt) <= 86_400_000 && CHECK_PROMISE_RE.test(String(m.text ?? "")));
  const promiseAt = promises.length ? Date.parse(promises[promises.length - 1].createdAt) : null;
  const resultSent = promiseAt !== null && aixRows.some((a) => String(a.aix_type ?? "") === "property_check_result" && (() => { const t = Date.parse(String(a.sent_at ?? a.created_at ?? "")); return Number.isFinite(t) && t > promiseAt && t <= now; })());
  const out: CheckFlow = { scene: null, brought24h, broughtNow, checkPromised: promiseAt !== null, resultSent };
  if (!brought24h) return out;
  const texts = burst.map((m) => String(m.text ?? ""));
  const txt = texts.join("\n");
  const open = promiseAt !== null && !resultSent;
  if (open && !broughtNow) {
    if (isAckOnlyTurn(txt)) return { ...out, scene: "ack_wait" };
    const cat = classifyCustomerBurst(texts);
    if (cat === "question") return { ...out, scene: "question_after_promise" };
    if (!/[?？]|ですか|ますか|でしょうか/.test(txt) && txt.length <= 80 && /ありがと|よろしく|宜しく|わかりました|分かりました|了解|承知|かしこまり|お願い/.test(txt)) return { ...out, scene: "ack_plus" };
    return out;
  }
  if (broughtNow && promiseAt === null) return { ...out, scene: "brought_no_promise" };
  return out;
}

const LINE: Record<CheckFlowScene, string> = {
  ack_wait: "お客様が送ってきた物件の確認を約束済み・まだ結果を送っていない・今のお客様の通はお礼・了承だけ → この番は返信を書かず、確認の結果が揃ったら AIX【物件確認した】（property_check_result）で結果を送る（後で果たす約束・aix の欄は property_check_result）",
  question_after_promise: "お客様が送ってきた物件の確認を約束済み・まだ結果を送っていない・今のお客様の通に別の問いがある → まずその問いに返信で答え、確認の結果は後で AIX【物件確認した】（この番の道は返信）",
  brought_no_promise: "お客様が今の通で物件を送ってきた・まだ確認の約束をしていない → まず「お送り頂きました物件の募集状況確認させて頂きます」の約束の返信（結果が手元にある時だけすぐ AIX【物件確認した】）",
  ack_plus: "お客様が送ってきた物件の確認を約束済み・まだ結果を送っていない・今のお客様の通は了承に一言足した → 足した所に返信し、確認の結果が揃ったら AIX【物件確認した】（この番の道は返信）",
};
/** ブレインの材料の1行（当たらない時は ""）。答えの規則ではなく竹内さんの決め（11/25）として渡す */
export function checkPromiseFlowLine(f: CheckFlow | null): string {
  if (!f?.scene) return "";
  return `【お客様が送ってきた物件の確認の流れ（竹内さんの決め 11/25・場面 ${f.scene}）】${LINE[f.scene]}`;
}
