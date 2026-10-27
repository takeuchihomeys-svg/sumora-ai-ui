// app/lib/staff-todo-two-line.ts — 【やることリスト】の1行を「分かりやすいタイトル＋2行目＝次にスタッフがする事」にする（純関数・DB も LLM もなし）
//
// 2026-10-28 竹内さん「次にすべきことの指示を入れる。分かりやすいタイトルと、2行目は明確に次にスタッフが行うことを入れる。スタッフが分かりやすく動けるように」
//   1行目: 番号＋何の仕事か（短い言葉）＋（期限）（経過）
//   2行目: 次にする事。決まった形の指示（staff-todo-instruction・ボタン→ピッカー→何を入れる）がある時はそれ、
//          無い時だけお客様の要約の「次にする事」（property_customers.ai_summary_json.next_action）、それも無ければ今までの「やる事」。
//   切替 TODO_TWO_LINE=on の時だけ（既定 off＝今まで通りの1行）。
// テスト: app/lib/__tests__/staff-todo-two-line.test.ts

export function todoTwoLineEnabled(env: Record<string, string | undefined> = typeof process !== "undefined" ? process.env : {}): boolean {
  return (env.TODO_TWO_LINE ?? "").trim().toLowerCase() === "on";
}

/** 何の仕事か（1行目の短い言葉）。AIX の種類ごと */
const ACTION_TITLE: Record<string, string> = {
  property_send: "物件を探して送る",
  property_recommendation: "オススメの物件を送る",
  property_check_result: "確認の結果をお伝えする",
  estimate_sheet: "御見積書を送る",
  viewing_invite: "内覧の日程を決める",
  meeting_place: "待ち合わせ場所を送る",
  greeting_viewing: "内覧前のご挨拶",
  condition_hearing: "ご条件を伺う",
  application_push: "お申込みのご案内",
  followup_revive: "追客のご連絡",
  acknowledge_check: "確認するとお伝えする",
  cost_explain: "初期費用の仕組みのご説明",
  cost_breakdown: "初期費用の内訳のご説明",
  phone_call: "お電話する",
  phone_followup: "お電話の内容を送る",
  guarantor_info: "保証会社のご案内",
  zenryoku_support: "全力サポートのお伝え",
  property_search: "お部屋を探す",
};

export type TwoLineItem = {
  source: string; action: string | null; kindLabel: string; task: string; instruction?: string | null;
};

/** 1行目のタイトル（番号・期限は呼び手が付ける） */
export function todoItemTitle(it: TwoLineItem): string {
  if (it.source === "unanswered") return "返信する";
  if (it.source === "viewing") return "内覧";
  if (it.source === "target_new_arrival") return "新着の物件確認";
  const base = (it.action && ACTION_TITLE[it.action]) || it.kindLabel.replace(/^AIX【|】$/g, "");
  return it.source === "promise" ? `${base}（お約束）` : base;
}

/** 要約の「次にする事」を2行目に使える形に（空・長すぎる物は短く） */
export function cleanNextAction(s: string | null | undefined, max = 60): string | null {
  const t = String(s ?? "").replace(/\s+/g, " ").trim();
  if (!t) return null;
  return t.length > max ? `${t.slice(0, max - 1)}…` : t;
}

/** 2行目＝次にする事（決まった形の指示 → 要約の次にする事 → 今までのやる事） */
export function todoItemNextStep(it: TwoLineItem, nextAction?: string | null): string {
  if (it.instruction) return it.instruction;
  const na = it.source === "viewing" || it.source === "target_new_arrival" ? null : cleanNextAction(nextAction);
  if (na) return na;
  return `${it.kindLabel}：${it.task}`;
}
