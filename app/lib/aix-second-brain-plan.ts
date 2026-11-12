// app/lib/aix-second-brain-plan.ts — AIX の2通目（物件ピックアップ・物件オススメ）に、細分化したブレインの読みから「1文目の型・推す軸・障壁を下げる文・締め」を決めて渡す（純関数・既定 off）
//
// 2026-11-12 作業員5（竹内さん 11/12「AIX の文の2通目の AIX テンプレートの部分の質が悪いので、実際の竹内のように改善する。特に物件ピックアップと物件オススメ。
//   細分化されたブレインと連携したら状況に応じてより良い文が送れる」）。竹内さんの実際の2通目 48組と AI の文を並べた読み（exam-cache/anatomy-seven/aix-second-analysis.md）から:
//     欠けの多い順 締め 15・状況の一言 11・推す軸が広さでない 9・宣言と理由を分けない 9・希望とのずれ 7・新着の取り違え 6・キャンペーン 5・審査の1文 2・唯一の事実 2
//   ここは「どの欄をどう渡すか」の配線の案だけ。決まり（feedback_aix_improvement_flow）: AIX の文の改善は aix_feature_suggestions を通す＝この計画を文の指示に入れるのは竹内さんの承認の後。
//   既定 off（AIX_SECOND_BRAIN_PLAN=on の時だけ計画を作る）。route（aix-template-generate）には繋いでいない。
// テスト: app/lib/__tests__/aix-second-brain-plan.test.ts
import type { LatentKey } from "./takeuchi-exemplar";

export type SecondPlanInput = {
  /** 送った件数（ピックアップの束の数・1＝1件だけ） */
  sentCount: number;
  /** 募集に出てからの日数（新着かどうか・無ければ null） */
  listedDaysAgo: number | null;
  /** 物件の状況: 退去予定・完成前（内覧まだ）・空室 */
  roomState: "vacating" | "under_construction" | "vacant" | null;
  /** 退去・完成の時期の言葉（「今月末」「12月」）。資料にある時だけ */
  roomStateWhen?: string | null;
  /** 希望とのずれ（登録の条件から外れる所・資料と条件で決まった計算） */
  wishGaps: Array<{ field: "rent" | "area_m2" | "age" | "station" | "room_size"; text: string }>;
  /** キャンペーン（資料の文字そのまま: 礼金0円・フリーレント1ヶ月 等） */
  campaigns: string[];
  /** 広さ（帖・㎡）の推せる言葉（資料から: リビング13帖・洋室12.3帖・40.52㎡ 等） */
  sizeWords: string[];
  /** 1部屋のみ・ご条件でこれだけ（資料・検索の結果の事実） */
  onlyOne: boolean;
  /** 保証会社が独立系か */
  independentGuarantor: boolean;
  /** ブレインの読み: 気持ち（ms の1つ目）・潜在の型・刺さっている点（mg.pt）・内覧の予定（日付の言葉） */
  brain: { mood: string | null; latent: LatentKey | null; hitPoint: string | null; viewingPlanned: string | null; hurry: boolean };
  /** お客様が言った希望の言葉（そのまま・1つ） */
  customerWish?: string | null;
  /** 前に刺さった物件の名前（似ている時だけ） */
  similarTo?: string | null;
  /** 2026-11-12 作業員4（OUR_SIDE_TO_COMPOSE）: こちら側の状態の行（meta.our_side_note・文の材料だけ・道は変えない） */
  ourSide?: string[] | null;
};
export type SecondPlan = {
  opening: "pick_from_sent" | "new_listing" | "not_viewable_yet" | "wish_gap" | "similar" | "customer_wish" | "plain";
  openingNote: string;
  axis: string[];
  barrier: string[];
  closing: "apply" | "viewing_together" | "viewing" | "receipt";
  closingNote: string;
  /** 竹内さんの型の決まり（文の指示に入れる時の短い言葉） */
  rules: string[];
  /** こちら側の状態の行（入力のまま・最大6） */
  ourSide?: string[];
};

export function aixSecondBrainPlanOn(env: Record<string, string | undefined> = typeof process !== "undefined" ? process.env : {}): boolean {
  return (env.AIX_SECOND_BRAIN_PLAN ?? "").trim().toLowerCase() === "on";
}

/** 新着＝募集に出て 7日以内（竹内さんが「新着で…募集に出ました」と書いた番の線・取り違え 6組の直し） */
export const NEW_LISTING_DAYS = 7;

export function planAixSecond(x: SecondPlanInput, env?: Record<string, string | undefined>): SecondPlan | null {
  if (!aixSecondBrainPlanOn(env)) return null;
  const isNew = x.listedDaysAgo != null && x.listedDaysAgo <= NEW_LISTING_DAYS;
  const when = x.roomStateWhen ? `${x.roomStateWhen}` : "";
  // 1文目（状況で選ぶ）
  let opening: SecondPlan["opening"] = "plain", openingNote = "「〇〇さんこちらのお部屋如何でしょうか！！」";
  if (x.roomState === "under_construction") { opening = "not_viewable_yet"; openingNote = `「${when || "〇月"}完成予定の為ご内覧まだ出来ませんがこちらのお部屋〇〇さんにかなりオススメ出来るご条件となります！！」`; }
  else if (x.wishGaps.length) { opening = "wish_gap"; openingNote = `「${x.wishGaps[0].text}となりますが／超えてしまいますが、〇〇以外かなりオススメ出来るご条件のお部屋となります！！」（ずれを先に正直に1つだけ）`; }
  else if (x.sentCount >= 2) { opening = "pick_from_sent"; openingNote = "「お送りさせて頂きましたお部屋の中でも特に〇〇が特にオススメ出来るお部屋となります！！」（宣言だけ・理由は次の文）"; }
  else if (isNew) { opening = "new_listing"; openingNote = `「${x.roomState === "vacating" ? `${when || "退去予定"}で` : ""}1件新着で〇〇さんにオススメ出来るお部屋が募集に出ました！！」`; }
  else if (x.similarTo) { opening = "similar"; openingNote = `「${x.similarTo}と類似の条件のお部屋となり」`; }
  else if (x.customerWish) { opening = "customer_wish"; openingNote = `「${x.customerWish}のお部屋が募集に出ました！！」（お客様の言葉そのまま）`; }
  // 推す軸（広さを先に・刺さっている点・階は使わない）
  const axis = [...x.sizeWords.slice(0, 2)];
  if (x.brain.hitPoint && !axis.some((a) => a.includes(x.brain.hitPoint!))) axis.unshift(x.brain.hitPoint);
  // 障壁を下げる文
  const barrier: string[] = [];
  for (const c of x.campaigns.slice(0, 1)) barrier.push(`「現在${c}のキャンペーン中の為…」`);
  if (x.brain.latent === "screening" && x.independentGuarantor) barrier.push("「保証会社も独立系の為審査基準緩く、審査通過する可能性十分にございます！！」");
  // 締め（刺さり具合×物件の状況）
  const hit = /刺さっている|内覧したい|急いでいる/.test(x.brain.mood ?? "") || x.brain.hurry;
  let closing: SecondPlan["closing"] = "receipt", closingNote = "「お手隙の際にご査収ください😌！！」";
  if (x.brain.viewingPlanned) { closing = "viewing_together"; closingNote = `「お気に召されましたらこちらのお部屋も併せて${x.brain.viewingPlanned}ご案内させて頂きます！！」`; }
  else if (x.onlyOne && hit) { closing = "apply"; closingNote = "「1部屋のみの募集となりますのでお気に召されましたらお申込しお部屋抑えさせて頂きます！！」"; }
  else if (x.roomState === "under_construction" || (hit && (isNew || x.roomState === "vacating") && x.brain.latent === "taken")) { closing = "apply"; closingNote = "「お気に召されましたらお申込しお部屋抑えさせて頂きます！！」"; }
  else if (hit && x.roomState !== "vacating") { closing = "viewing"; closingNote = "「お気に召されましたらご都合よろしいお日にちにお部屋ご案内させて頂きます！！お気軽にお申し付けください😌！！」（ご査収を重ねない）"; }
  const rules = [
    "1文目は宣言だけ（理由は次の文）・「・」で5つ以上を詰めず2〜3個ずつ文を分ける",
    "推す軸は広さ（帖・㎡）を先に・階は推しの理由にしない",
    ...(opening !== "new_listing" ? ["新着ではないので「新着」と書かない"] : []),
    ...(opening !== "wish_gap" ? ["ずれでない時に「最寄り駅〇〇駅となりますが」を付けない"] : []),
  ];
  return { opening, openingNote, axis, barrier, closing, closingNote, rules, ...(x.ourSide?.length ? { ourSide: x.ourSide.slice(0, 6) } : {}) };
}

/** 文を作る所に渡す注記（計画が無ければ null） */
export function secondPlanNote(p: SecondPlan | null): string | null {
  if (!p) return null;
  return [
    "【2通目の組み立て（竹内さんの型・ブレインの読みから）】",
    `1文目: ${p.openingNote}`,
    p.axis.length ? `推す軸: ${p.axis.join("・")}` : "",
    p.barrier.length ? `障壁を下げる文: ${p.barrier.join(" ")}` : "",
    `締め: ${p.closingNote}`,
    ...p.rules.map((r) => `・${r}`),
    ...(p.ourSide?.length ? ["こちら側の状態（もう送った・伝えた事と食い違わない）:", ...p.ourSide.map((x) => `  ${x}`)] : []),
  ].filter(Boolean).join("\n");
}
