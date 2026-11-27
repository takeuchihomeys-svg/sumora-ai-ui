/**
 * お客さん1人ぶんの流れの地図（正本）— 2.8.319 の後の土台強化
 *
 * なぜ作ったか（竹内さん 2026-11-27「なんで改善する際に今回のように前提や流れを理解せずに変更したのか。
 *   根本的な部分を理解すれば④の分かれ目だと理解できる。今後改善する際、根本的な部分を理解して改善できるように
 *   仕組みをつくる。土台を強化する」）。
 *
 * 起きた事: 「全部送付済み／次頁も全部送付済み／0件でもリセットして次のお客さんへ」を手順書に足す時、
 *   既存の入れ物（PLAYBOOK_LIST_AD_SORT_STEPS＝文字の一列・PlaybookFlowPhase.next＝次は1つだけ）の形に合わせて
 *   ⑤⑥⑦⑧と通し番号で書き足した。でも中身は「④（印刷用PDFを押す）で押す物が無い時の分かれ道」で、
 *   順に行う手ではない。入れ物が「分かれ道」を表せなかったので、形を確かめずに一列に入れてしまった。
 *   しかも試験は自分が書いた文言があるかだけを見ていたので、紛らわしくても通った。
 *
 * この地図の約束:
 *   1. 流れの「形」を3つに分けて持つ: step（順に行う手）／branch（ある手の場合分け・順に行う手ではない）／join（合流点）。
 *   2. 手順書の一覧の手（④の場合分け・⑤）はこの地図から作る（手で書き足さない）。番号は step と join だけに付き、
 *      branch は「④の1」のように親の手にぶら下がる。分かれ道を一列に並べることが出来ない。
 *   3. 全ての分かれ道は客完了（customer_done）に合流し、客完了は必ずリセット（reset）へ戻る
 *      （竹内さん「リセットからの流れは同じ」）。合流しない分かれ道は試験が止める。
 *   4. 各ノードは拡張のコードに実在する目印（evidence）と、点検に残る印（audit）を持つ。無い物は試験が止める。
 *   5. 流れを変える時は、先にこの地図を直す（コードや手順書の文より先）。手順は `scripts/change-premise.ts` が出す。
 *
 * 試験: app/lib/__tests__/loop-flow-map.test.ts（形・合流・実在・手順書との一致・悪い地図を止める自己点検）
 */

export type FlowKind = "step" | "branch" | "join";

export type FlowNode = {
  id: string;
  kind: FlowKind;
  /** 短い名前（地図の表示用） */
  label: string;
  /** 手順書に出す文（branch／join／一覧の手の④だけ。他は手順書の別の所にある） */
  playbook?: string;
  /** branch の条件（「どんな時にこの道へ行くか」） */
  when?: string;
  /** branch が属する step の id（branch だけ） */
  parent?: string;
  /** 次に行く所（分かれ道・繰り返しは複数） */
  next: string[];
  /** 拡張のコードに実在する目印 */
  evidence: { file: string; token: string };
  /** 点検（search_audits.steps）に残る印。KEEP_STEP／RULE_STEP に落ちない物だけ */
  audit: string[];
  /** 補足（例: 最初のお客さんはリセットしない） */
  note?: string;
};

/** 一覧の手の番号（①〜は ①②③＝並べ替え。④から先をこの地図が作る） */
const CIRCLED = ["", "①", "②", "③", "④", "⑤", "⑥", "⑦", "⑧", "⑨"];

export const LIST_PRESS_FIRST_NO = 4;

export const LOOP_FLOW_NODES: ReadonlyArray<FlowNode> = [
  {
    id: "reset",
    kind: "step",
    label: "リセットを押す（送付のあと1回）",
    next: ["api_reload"],
    evidence: { file: "background.js", token: "_postSendResetRealpro" },
    audit: ["reset_press", "reset_settled"],
    note: "最初のお客さんと前客リセット済みの客は入れる前に押さない（first_customer_no_reset）",
  },
  {
    id: "api_reload",
    kind: "step",
    label: "次客の条件をAPIから読み直す",
    next: ["fill"],
    evidence: { file: "background.js", token: "_refreshCustomerBeforeSearch" },
    audit: ["customer_api_reload"],
    note: "読めなければ古い条件では検索せずこの客を飛ばす（2.8.318）＝飛ばした客は客完了を通らず次の客の reset へ",
  },
  {
    id: "fill",
    kind: "step",
    label: "条件を入れる",
    next: ["search"],
    evidence: { file: "page-script.js", token: "fill_done" },
    audit: ["fill_done"],
  },
  {
    id: "search",
    kind: "step",
    label: "検索を押す（9〜12秒見直してから）",
    next: ["sort"],
    evidence: { file: "page-script.js", token: "search_review_wait" },
    audit: ["dl:search_press_wait"],
  },
  {
    id: "sort",
    kind: "step",
    label: "並べ替え（AD→高→低・①〜③）",
    next: ["list_press", "b_zero"],
    evidence: { file: "bulk-dl.js", token: "_sortByAdLikeHuman" },
    audit: ["dl:sort_done"],
    note: "並べ替えのあと、行があれば④へ・結果が0件なら④の3へ",
  },
  {
    id: "list_press",
    kind: "step",
    label: "印刷用PDFを押す（④）",
    playbook: "並べ替え後に印刷用PDFを押す",
    // 押したあと: 次のページがあれば次へ（同じ④を繰り返す）・無ければ客完了。押す物が無い頁は④の1・④の2
    next: ["list_press", "customer_done", "b_all_sent_next", "b_all_sent_last"],
    evidence: { file: "bulk-dl.js", token: "_startAutoPressRun" },
    audit: ["dl:list_flow_grasp"],
  },
  {
    id: "b_all_sent_next",
    kind: "branch",
    label: "この頁が全部送付済み→次へ",
    parent: "list_press",
    when: "この頁の行が全部「送付済み」（押せる行が0）で、次のページがある",
    playbook: "この頁の行が全部「送付済み」なら、印刷用PDFは押さず「次へ」で次のページへ移る（止まらない・all_sent_page）",
    next: ["list_press"],
    evidence: { file: "bulk-dl.js", token: "all_sent_page" },
    audit: ["dl:all_sent_page"],
  },
  {
    id: "b_all_sent_last",
    kind: "branch",
    label: "次頁も全部送付済み／最後まで→客完了",
    parent: "list_press",
    when: "次のページも全部送付済み。最後のページまで全部送付済みで、次のページが無い",
    playbook: "次のページも全部送付済みなら、また「次へ」。最後のページまで全部送付済みなら新しい物件なしとして客完了（all_sent_done）",
    next: ["customer_done"],
    evidence: { file: "bulk-dl.js", token: "all_sent_done" },
    audit: ["dl:all_sent_done"],
  },
  {
    id: "b_zero",
    kind: "branch",
    label: "検索結果0件→客完了",
    parent: "list_press",
    when: "検索結果が0件（0棟0戸・印刷用PDFも0・3回続けて読めた）",
    playbook: "検索結果が0件（0棟0戸）の時も、行が出るのを待ち続けず客完了にする（zero_count0_finish）",
    next: ["customer_done"],
    evidence: { file: "bulk-dl.js", token: "zero_count0_finish" },
    audit: ["dl:zero_count0_finish"],
  },
  {
    id: "customer_done",
    kind: "join",
    label: "客完了→リセットして次のお客さんへ",
    playbook:
      "リセットを押して次のお客さんへ。リセットからの流れは同じ（リセット→30〜34秒待つ→空とみなす→次客の条件をAPIから読み直して入れる→検索）",
    next: ["reset"],
    evidence: { file: "bulk-dl.js", token: "_sendBatchDone" },
    audit: ["post_send_clear", "handoff_loop"],
    note: "最後のお客さんは完了を待たせず裏でリセットして終わる",
  },
];

export function flowNode(id: string, nodes: ReadonlyArray<FlowNode> = LOOP_FLOW_NODES): FlowNode | undefined {
  return nodes.find((n) => n.id === id);
}

/** 親の手にぶら下がる分かれ道（地図の並び順） */
export function branchesOf(parentId: string, nodes: ReadonlyArray<FlowNode> = LOOP_FLOW_NODES): FlowNode[] {
  return nodes.filter((n) => n.kind === "branch" && n.parent === parentId);
}

/** from から next をたどって to に着けるか */
export function canReach(from: string, to: string, nodes: ReadonlyArray<FlowNode> = LOOP_FLOW_NODES): boolean {
  const seen = new Set<string>();
  const stack = [from];
  while (stack.length) {
    const id = stack.pop() as string;
    if (id === to) return true;
    if (seen.has(id)) continue;
    seen.add(id);
    const n = flowNode(id, nodes);
    if (n) for (const x of n.next) stack.push(x);
  }
  return false;
}

/**
 * 地図の形の点検（悪い地図を止める）。問題があれば文の一覧を返す（空なら良い）。
 *   ・id が重ならない／next の行き先が実在する
 *   ・branch は 親（step）・条件（when）・行き先を持つ。親は step で、親の next から外れた道ではない
 *   ・どの branch からも 客完了（join）に着き、客完了から reset に戻る（リセットからの流れは同じ）
 *   ・reset から全部に着ける（行き止まり・孤立が無い）
 *   ・join は 1つだけ（客の終わり方が何通りも出来ない）
 */
export function checkFlowMap(nodes: ReadonlyArray<FlowNode> = LOOP_FLOW_NODES): string[] {
  const out: string[] = [];
  const ids = new Set<string>();
  for (const n of nodes) {
    if (ids.has(n.id)) out.push(`id が重なっている: ${n.id}`);
    ids.add(n.id);
  }
  for (const n of nodes) {
    for (const x of n.next) if (!ids.has(x)) out.push(`${n.id} の next が実在しない: ${x}`);
    if (!n.evidence || !n.evidence.file || !n.evidence.token) out.push(`${n.id} にコードの目印（evidence）が無い`);
    if (n.kind === "branch") {
      if (!n.parent) { out.push(`${n.id}（branch）に親の手（parent）が無い＝一列の手に見えてしまう`); continue; }
      const p = flowNode(n.parent, nodes);
      if (!p) out.push(`${n.id} の親 ${n.parent} が実在しない`);
      else if (p.kind !== "step") out.push(`${n.id} の親 ${n.parent} は step ではない`);
      if (!n.when || !n.when.trim()) out.push(`${n.id}（branch）に条件（when）が無い`);
      if (!n.playbook || !n.playbook.trim()) out.push(`${n.id}（branch）に手順書の文（playbook）が無い`);
      if (!n.next.length) out.push(`${n.id}（branch）の行き先（next）が無い`);
    } else if (n.parent) {
      out.push(`${n.id} は branch ではないのに parent がある`);
    }
  }
  const joins = nodes.filter((n) => n.kind === "join");
  if (joins.length !== 1) out.push(`join（合流点＝客完了）は1つだけ。今は ${joins.length}`);
  const join = joins[0];
  const first = nodes.find((n) => n.kind === "step");
  if (join) {
    if (!join.next.length || !join.next.every((x) => flowNode(x, nodes)?.kind === "step")) {
      out.push(`${join.id}（客完了）の次は step（リセット）でなければならない`);
    }
    for (const b of nodes.filter((n) => n.kind === "branch")) {
      if (!canReach(b.id, join.id, nodes)) out.push(`${b.id}（分かれ道）が客完了に合流しない＝リセットして次のお客さんへ行けない`);
    }
    if (first && !canReach(join.id, first.id, nodes)) out.push(`客完了から最初の手（${first.id}）へ戻れない＝ループにならない`);
  }
  if (first) {
    for (const n of nodes) if (!canReach(first.id, n.id, nodes)) out.push(`${n.id} に ${first.id} から着けない（孤立）`);
  }
  return out;
}

/**
 * 手順書の一覧の手のうち ④から先（④・④の場合分け・⑤客完了）を、地図から作る。
 *   ・④ の文に「押す物が無い時は下の『④の1〜n』＝④の場合分け。順に行う手ではない」を自動で入れる
 *   ・branch は「④の k（④の場合分け）」。通し番号は付けない
 *   ・join は次の通し番号（⑤）。文の中の「④の1〜n」も枝の数から作る
 */
export function renderListPressSteps(
  nodes: ReadonlyArray<FlowNode> = LOOP_FLOW_NODES,
  firstNo: number = LIST_PRESS_FIRST_NO,
): string[] {
  const press = nodes.find((n) => n.id === "list_press");
  if (!press) throw new Error("list_press が地図に無い");
  const no = CIRCLED[firstNo] || String(firstNo);
  const brs = branchesOf(press.id, nodes);
  const range = brs.length ? `${no}の1〜${brs.length}` : "";
  const steps: string[] = [];
  steps.push(
    `${no}${press.playbook}` +
      (brs.length
        ? `（押せる行＝送付済みでない行がある時。押す物が無い時は下の「${range}」＝${no}の場合分け。順に行う手ではない）`
        : ""),
  );
  brs.forEach((b, i) => steps.push(`${no}の${i + 1}（${no}の場合分け）${b.playbook}`));
  const join = nodes.find((n) => n.kind === "join");
  if (join && join.playbook) {
    const jno = CIRCLED[firstNo + 1] || String(firstNo + 1);
    steps.push(`${jno}客完了（${brs.length ? `${no}で送り終えた・${range}のどれでも` : `${no}で送り終えた`}）→${join.playbook}`);
  }
  return steps;
}
