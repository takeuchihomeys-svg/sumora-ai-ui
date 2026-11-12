// app/lib/check-order-guide.ts — 選ばれた型の「確認の順番となぜ」をブレインに材料として渡す（純関数・作業員16・2026-11-12）
//
// 竹内さん 11/12「順序をブレインの統括が理解できているか」（KB P1 d030d496・親 P0 575a7cd5）。
//   作業員22 の check-order-wire は、ブレインが書き終えた後の meta から型を選んで記録するだけ（CHECK_ORDER_TABLE=shadow）。
//   ここは次の段: ブレインを呼ぶ前に、今の一通の場面と台帳の事実から型の候補を選び、その型の「確かめる順と理由」だけを材料の1行で渡す。
// 決まり（道を引っぱる事が4回起きた: q406・q057・q065・q022）:
//   - 渡すのは確かめる順（CheckStep のうち道より前の段＝read_ask・hypothesize・our_last_send・staff_only・fact_answer・now_vs_later）と理由だけ。
//   - 返信か AIX か・次の一手・押す・申込・内覧・誘導の言葉は入れない（テストで全部の型の文を確かめる）。
//   - 置き場所は now_vs_later と同じ事実の段（材料の1行・ユーザー側の材料＝プロンプトキャッシュの静的な部分は変えない）。
//   - 型の選びは決まった計算の網（P0 9eb6aa9c）。ブレインは材料として読み、合わなければ従わない（決め直しはしない）。
// スイッチ: CHECK_ORDER_GUIDE（既定 off＝何も足さない）。

import { CHECK_ORDER_TYPES, pickCheckOrder, type CheckOrderCues, type CheckStep } from "./check-order";

type Env = Record<string, string | undefined>;
export function checkOrderGuideOn(env: Env = typeof process !== "undefined" ? process.env : {}): boolean {
  return String(env.CHECK_ORDER_GUIDE ?? "").trim().toLowerCase() === "on";
}

/** 確かめる段の言い方（道より前の段だけ。route・focus・aim・roles は渡さない＝null） */
export const CHECK_STEP_GUIDE: Record<CheckStep, string | null> = {
  read_ask: "お客様の今の一通で何を言われたか・聞かれたか",
  hypothesize: "言葉だけで決まらない時は、読みの候補を2〜3立てる",
  our_last_send: "こちらが前に約束した事・直前に送った物（開いている約束・送った物件・御見積書・日時）で読みを確かめる",
  staff_only: "聞かれた事が、スタッフが管理会社などに確かめないと分からない事か",
  fact_answer: "会話・物件の資料・会社の事実に答えがあるか",
  now_vs_later: "今この場で届けられる物があるか（送れる物件・確認の結果・御見積書）",
  route: null, focus: null, aim: null, roles: null,
};

/** 型ごとの「なぜこの順で確かめるか」（check-order の why から、道・次の一手の言葉を外して書き直した物） */
export const GUIDE_WHY: Record<string, { label: string; why: string }> = {
  T1_conditions_first: { label: "条件を言われた番", why: "前の条件・送った物との差を見ないと、変更か追加か・ずっとか今回だけかが決まらない" },
  T2_question_fact: { label: "会社・資料で答えられる問いの番", why: "答えが手元にある事を、確かめる事として扱うと、分かっていない担当に見える" },
  T3_question_staff_only: { label: "スタッフが確かめないと分からない問いの番", why: "確かめる前に言い切ると作り話になる。まず手元の資料に答えが無い事を確かめる" },
  T4_property_shared: { label: "お客様が物件を送ってきた番", why: "何のために送ったか（空き・費用・条件の参考）は言葉に無い。同じ一通の言葉と前の流れで読みを決める" },
  T5_ack_hypothesis: { label: "お礼・了承だけの番", why: "了承の中身は言葉に無く、こちらの直前の送信で決まる。開いている約束が複数ならどれへの了承かを確かめる" },
  T6_considering: { label: "検討します・また連絡しますの番", why: "前に送った物と、お客様が自分から言った合図（今日中に決める・埋まるかも）があるかだけを確かめる" },
  T7_viewing: { label: "日時・可否を聞かれた番", why: "いまどの段階か（候補日・日にち決定・待ち合わせ）を前の送信で確かめてから、聞かれた可否に答えを探す" },
  T8_cost: { label: "費用を聞かれた番", why: "対象の物件が決まっているか・会社の事実で答えられるかで、答えの出所が変わる" },
  T9_apply_signal: { label: "お部屋を決めたいと言われた番", why: "どの物件か・その物件の空きが確かめ済みかを、前の送信と記録で確かめる" },
  T10_result_ready: { label: "前に確かめると言った事の結果が手元にある番", why: "開いている約束の結果を先に確かめる。結果がある事を見落とすと、約束を忘れたように見える" },
  T11_first_contact_hearing: { label: "初めての連絡の番", why: "言われた事情（人数・審査の不安・再来）を先に読む。読まずに定型で始めると信頼が作れない" },
  T12_hooked_comparing_taken: { label: "送った物件に刺さっていて、比べたい・取られる不安が混ざる番", why: "刺さった点・比べたい迷い・取られる不安の3つを分けて読み、会社の事実（保証会社の審査通過までの扱い）に答えがあるかを確かめる" },
};
/** 道を引っぱる言葉（渡す文に入れない） */
export const GUIDE_FORBIDDEN_RE = /AIX|返信|申込|内覧|ご案内|押す|押さえ|抑え|次の一手|誘導|背中|勧め|オススメ|お送りする|約束の返信/;

/** ブレインを呼ぶ前に分かる事だけからの手がかり（場面・お客様の一通・台帳の事実）。網＝ブレインの決めではない */
export type PreBrainInput = {
  scene: string | null;
  customerText: string;
  hasImageOrUrl?: boolean;
  pickupPromisedUnfulfilled?: boolean;
  confirmationPromisedUnfulfilled?: boolean;
  estimatePromisedUnfulfilled?: boolean;
  pickupReady?: boolean | null;
  firstContact?: boolean;
};
const ACK_RE = /^(?:はい|了解|承知|わかりました|分かりました|かしこまり|ありがとうございます|よろしくお願い|お願いします)[^?？]{0,30}$/;
export function preBrainCues(i: PreBrainInput): CheckOrderCues {
  const t = String(i.customerText ?? "").trim();
  const q = /[?？]|ですか|ますか|でしょうか|できますか/.test(t);
  const scene = i.scene ?? "";
  return {
    firstContact: !!i.firstContact,
    ackOnly: scene === "ack" || (ACK_RE.test(t) && !q),
    hasQuestion: q || scene === "question",
    pendingPromise: !!(i.pickupPromisedUnfulfilled || i.confirmationPromisedUnfulfilled || i.estimatePromisedUnfulfilled),
    resultReady: i.pickupReady === true && !!i.pickupPromisedUnfulfilled,
    customerSentProperty: scene === "property_share" || (!!i.hasImageOrUrl && /号室|階|〈URL〉|https?:|suumo|homes/i.test(t)),
    conditionStated: scene === "conditions",
    applySignal: scene === "apply",
    considering: scene === "considering" || /検討|考えさせ|また連絡/.test(t),
    topic: scene === "viewing" ? "viewing" : scene === "cost" ? "cost" : q ? "other" : null,
    hooked: /気に入|いいですね|良いですね|綺麗|ピッタリ|ぴったり|理想/.test(t),
    takenWorry: /取られ|埋ま(?:る|っ)|無くな|なくな/.test(t),
  };
}

export type CheckOrderGuide = { type: string; label: string; steps: CheckStep[]; text: string };
/** 先頭の型の確かめる順と理由（道より前の段だけ）。型が無ければ null */
export function checkOrderGuideFor(cues: CheckOrderCues): CheckOrderGuide | null {
  const top = pickCheckOrder(cues)[0];
  if (!top) return null;
  const t = CHECK_ORDER_TYPES.find((x) => x.id === top.id);
  const g = GUIDE_WHY[top.id];
  if (!t || !g) return null;
  const routeAt = t.check.indexOf("route");
  const before = (routeAt >= 0 ? t.check.slice(0, routeAt) : t.check).filter((s) => CHECK_STEP_GUIDE[s]);
  const steps: CheckStep[] = before.includes("now_vs_later") ? before : [...before, "now_vs_later"];
  const nums = "①②③④⑤⑥⑦";
  const text = `【確かめる順番（材料・竹内さんの型「${g.label}」）】この一通は次の順で確かめる: ${steps.map((s, i) => `${nums[i]}${CHECK_STEP_GUIDE[s]}`).join(" ")}。なぜ: ${g.why}。（型は場面と記録からの目安。合わない時はこの順にこだわらない）`;
  return { type: top.id, label: g.label, steps, text };
}
