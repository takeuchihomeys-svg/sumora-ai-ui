// app/lib/pending-check-answered.ts — 確認中のタスク（line_tasks の property_check が pending）でも、こちらが文で結果を答えていれば「確認中」と扱わない
// 2026-11-27 作業員A（台帳 #829・竹内さんの決定 KB 212e2945「回答済み物件を未回答と表現することは禁止・履歴照合が必須」08/30・統括役の頼み）
//   抜け: AIX を使わずスタッフが文で「管理会社に確認しましたところ〜」と答えると、line_tasks は pending のまま残る。
//     generate-reply は activeTaskTypes に property_check があると【募集状況確認中★最重要】のヒントを足し、「確認出来次第ご連絡」を書かせる＝答えたのに未回答の文になる。
//   ここ: pending の確認タスクの作成より後に、こちらの文に「済んだ形の結果」があるかを決まった計算で見る（LLM なし・純関数）。
//     あれば、その会話の property_check を「確認中」から外す（ヒント・確認の文脈・最終チェックが同じ扱いになる）。
//   線（おかしな文の手順の⑤: 入口は厳しくてよい・誤検出0でなければ入れない）:
//     ・済んだ形だけ（〜しましたところ・〜とのことです・募集終了・申込が入って）。約束・途中の形（確認中・次第・回答待ち・折り返し・確認いたします）が同じ通にあれば数えない
//     ・タスクの作成時刻より後のこちらの通だけ。時刻が読めない通は数えない
//     ・お客様の通は数えない（お客様の「確認しました」はこちらの答えではない）
//   スイッチ PENDING_CHECK_ANSWERED_GUARD（既定 off・段階で読む）。印は generate-reply の見張りの記録 tag "gen:pending-check-answered"
//   監査: scripts/audit-pending-check-answered.ts（過去の実送信で、外した後にスタッフがまだ確認の約束をしていた番＝誤検出を数える）

export type PcaMessage = { sender: string; text: string; createdAt?: string | null; isAix?: boolean };

/** 済んだ形の結果（管理会社に確かめた結果をこちらが伝えた） */
export const PCA_DONE_RE = new RegExp([
  "管理会社(?:様)?(?:に|へ)?(?:確認|問い?合わ?せ|お問い?合わ?せ)(?:を)?(?:し|致し|いたし|させて(?:頂|いただ)き)ました(?:ところ|結果)",
  "(?:募集|お部屋の募集)(?:が|は)?(?:終了|停止)(?:して|となって|となり|致し|しており|しました)",
  "(?:申込|お申込|申し込み|お申し込み)(?:み)?(?:が)?(?:入って|入りまして|入ってしまい|入っている|入っており)",
  "(?:とのこと|との事)(?:です|でした|で御座います|でございます)",
  "との(?:ご)?回答(?:を|が|で)",
].join("|"));

/** 途中・約束の形（同じ通にあれば済んだ形と見ない） */
export const PCA_PENDING_RE = /確認中|確認(?:させて(?:頂|いただ)いて|して|致して|いたして)おります|お休み|定休日|不在|確認が(?:取れて|とれて)(?:おりません|いません|いない)|分かり次第|わかり次第|出社次第|改めて(?:ご連絡|確認|お伝え)|(?:ご返事|ご返答|ご連絡)(?:いた|致)します|確認(?:出来|でき|が取れ|がとれ)次第|次第(?:ご連絡|ご報告|お伝え)|回答待ち|返事待ち|返答待ち|折り返し|確認(?:して|いたし|致し|させて(?:頂|いただ)き)ま(?:す|すね)(?:[！!。😊\s]|$)|お時間(?:を)?(?:頂|いただ)/;

export type PcaVerdict = { answered: boolean; at: string | null; by: "text" | "aix" | null };

/** 確認のタスクの作成時刻より後に、こちらが済んだ形で結果を伝えた通があるか（最初の1通の時刻） */
export function pendingCheckAnsweredByStaff(i: { taskCreatedAt: string | null | undefined; messages: ReadonlyArray<PcaMessage> }): PcaVerdict {
  const t0 = Date.parse(String(i.taskCreatedAt ?? ""));
  if (!Number.isFinite(t0)) return { answered: false, at: null, by: null };
  // 一番新しい状態で決める: 済んだ形の通の後に、こちらが途中・約束の形を送っていたら（別の依頼の約束・担当者が休み 等）答え済みに戻さない
  let v: PcaVerdict = { answered: false, at: null, by: null };
  for (const m of i.messages) {
    if (m.sender !== "staff") continue;
    const t = Date.parse(String(m.createdAt ?? ""));
    if (!Number.isFinite(t) || t <= t0) continue;
    const text = String(m.text ?? "");
    if (PCA_PENDING_RE.test(text)) { v = { answered: false, at: null, by: null }; continue; }
    if (!v.answered && PCA_DONE_RE.test(text)) v = { answered: true, at: m.createdAt ?? null, by: m.isAix ? "aix" : "text" };
  }
  return v;
}

/** 会話の pending の確認タスクのうち、どれか1つでもまだ答えていなければ「確認中」のまま（全部答え済みの時だけ外す） */
export function allPendingChecksAnswered(tasks: ReadonlyArray<{ created_at: string | null }>, messages: ReadonlyArray<PcaMessage>): { all: boolean; verdicts: PcaVerdict[] } {
  const verdicts = tasks.map((t) => pendingCheckAnsweredByStaff({ taskCreatedAt: t.created_at, messages }));
  return { all: verdicts.length > 0 && verdicts.every((v) => v.answered), verdicts };
}

/** 確認中の扱いから property_check を外した activeTaskTypes（外さない時は同じ配列） */
export function dropAnsweredCheck(activeTaskTypes: string[], all: boolean): string[] {
  return all ? activeTaskTypes.filter((t) => t !== "property_check") : activeTaskTypes;
}
