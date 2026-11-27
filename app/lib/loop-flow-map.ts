/**
 * お客さん1人ぶんの流れの地図（正本）— 2.8.319 の後の土台強化（失敗の道・2.8.320）
 *
 * なぜ作ったか（竹内さん 2026-11-27「なんで改善する際に前提や流れを理解せずに変更したのか。
 *   根本的な部分を理解すれば④の分かれ目だと理解できる。今後改善する際、根本的な部分を理解して改善できるように
 *   仕組みをつくる。土台を強化する」）。
 *
 * 起きた事: 「全部送付済み／次頁も／0件でもリセットして次のお客さんへ」を手順書に足す時、入れ物（文字の一列・
 *   next が1つ）に合わせて ⑤⑥⑦⑧ と通し番号で書き足した。中身は「④で押す物が無い時の分かれ道」だった。
 *
 * 2.8.320 で足したこと: 正常な流れだけでは、実際に止まった所（リセットが押せない・読み直せない・裏が起き直す・
 *   タブが見えない）を表せなかった。失敗の道を「分かれ道（branch）」として親の手にぶら下げ、
 *   割り込み（interrupt）は「どの段でも起きうる回復の決まり」として別に持つ。
 *
 * この地図の約束:
 *   1. 形は3つ: step（順に行う手）／branch（ある手の場合分け・順に行う手ではない）／join（合流点）。
 *   2. 手順書の一覧の手（④から先）はこの地図から作る（手で書き足さない）。
 *   3. どの分かれ道も客完了（join）に合流し、客完了はリセット（reset_front）へ戻る（「リセットからの流れは同じ」）。
 *      失敗の道（分かれ道）は、もう1回押す・従来の外し・次のお客さんへ飛ばす、のどれかで次の手へ戻る。
 *   4. 各ノードは拡張のコードに実在する目印（evidence）と、点検に残る印（audit）を持つ。無い物は試験が止める。
 *   5. 流れを変える時は、先にこの地図を直す（コードや手順書の文より先に）。道具: scripts/change-premise.ts。
 *
 * 試験: app/lib/__tests__/loop-flow-map.test.ts（形・合流・実在・手順書との一致・失敗の道・割り込み・悪い地図の自己点検）
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
  /** 点検（search_audits.steps）に残る印。search-audit.js の KEEP_STEP／RULE_STEP に落ちない物だけ */
  audit: string[];
  /** 補足（例: 最初のお客さんはリセットしない） */
  note?: string;
};

/**
 * 割り込み: どの段でも起きうる回復の決まり（流れの途中に分岐として置かない）。
 *   resume = 起きた後どこから続けるか。必ず「止まった段へ戻る」か「次のお客さんへ飛ばす」。
 */
export type FlowInterrupt = {
  id: string;
  label: string;
  /** どの段で起きうるか */
  applies: string;
  /** 起きた後の動き */
  resume: string;
  evidence: { file: string; token: string };
  audit: string[];
  /** 実測（いつ・どの回で見えたか） */
  seen: string;
};

/** 一覧の手の番号（①〜は ①②③＝並べ替え。④から先をこの地図が作る） */
const CIRCLED = ["", "①", "②", "③", "④", "⑤", "⑥", "⑦", "⑧", "⑨"];

export const LIST_PRESS_FIRST_NO = 4;

export const LOOP_FLOW_NODES: ReadonlyArray<FlowNode> = [
  // ── 1人ぶんの終わりから次の客へ ─────────────────────────────
  {
    id: "reset_front",
    kind: "step",
    label: "押す前にリアプロのタブを確かめ、背面なら前に出す",
    next: ["reset"],
    evidence: { file: "background.js", token: "_bringRealproTabFront(_tab, _ridFront" },
    audit: ["reset_vis", "reset_front"],
    note: "2.8.320: 背面のタブではリセットの押す処理（タイマー）が遅れて押されなかった（#1666）。見え方の印を残す",
  },
  {
    id: "reset",
    kind: "step",
    label: "リセットを押す（送付のあと1回）",
    next: ["api_reload", "b_reset_late", "b_reset_retry", "b_reset_fallback"],
    evidence: { file: "background.js", token: "_postSendResetRealpro" },
    audit: ["reset_press", "reset_settled"],
    note: "最初のお客さんと前客リセット済みの客は入れる前に押さない（first_customer_no_reset）",
  },
  {
    id: "api_reload",
    kind: "step",
    label: "次客の条件をAPIから読み直す",
    next: ["fill", "b_api_skip"],
    evidence: { file: "background.js", token: "_refreshCustomerBeforeSearch" },
    audit: ["customer_api_reload"],
    note: "読めなければ古い条件では検索せずこの客を飛ばす（2.8.318）",
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
    /** ③の文の末尾に、この文をそのまま載せる（手で要約しない。checkListPlaybookStrength が見張る） */
    playbook: "押した時点で並べ替えは完了。ページが読み直されて待ちが消えても、読み直した一覧ではもう一度並べ替えず④物件取得へ進む。パネルは「物件取得最中」（「並べ替え最中」のままにしない）",
    next: ["list_press", "b_zero"],
    evidence: { file: "bulk-dl.js", token: "_sortByAdLikeHuman" },
    audit: ["dl:sort_done", "dl:sort_pressed"],
    note: "2.8.322 #1668: 高→低のあと sort_lag_grace で終わり、sort_done も物件取得も無かった。完了の文は③に載せる",
  },
  {
    id: "list_press",
    kind: "step",
    label: "印刷用PDFを押す（④）",
    playbook: "並べ替え後に印刷用PDFを押す（物件取得・1件ずつ）。並べ替え完了（高→低を押したあとの読み直し）を把握してから押す",
    next: ["list_press", "customer_done", "b_all_sent_next", "b_all_sent_last"],
    evidence: { file: "bulk-dl.js", token: "_startAutoPressRun" },
    audit: ["dl:list_flow_grasp"],
  },
  // ── 分かれ道（順に行う手ではない）─────────────────────────────
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
    id: "b_reset_late",
    kind: "branch",
    label: "押す返事が遅れた→押した跡があれば先へ",
    parent: "reset",
    when: "押す処理の返事が時間切れ（press_timeout）だったが、読み直しで押した跡（reset_pressed）が見つかった",
    playbook: "返事が遅れても押した跡があれば押したとして先へ進む（もう1回押さない・従来の外しへ行かない・2.8.315）",
    next: ["api_reload"],
    evidence: { file: "background.js", token: "押した（遅れて・返事は" },
    audit: ["reset_press", "reset_press_late_check"],
  },
  {
    id: "b_reset_retry",
    kind: "branch",
    label: "押せず→もう1回押す",
    parent: "reset",
    when: "押す処理が押せず（返事なし・押した跡なし）、押した跡もまだ無い",
    playbook: "押せなかったら、もう1回押す（reset_retry・押す前の見え方を残す）",
    next: ["api_reload"],
    evidence: { file: "background.js", token: "reset_retry" },
    audit: ["reset_retry"],
  },
  {
    id: "b_reset_fallback",
    kind: "branch",
    label: "リセットが押せない・空にならない→従来の1つずつ外し",
    parent: "reset",
    when: "もう1回押しても押せない、または押しても空にならない（最後の保険）",
    playbook: "最後の保険として、従来の1つずつ外しへ（reset_fallback・外す前後は残りを名前付きで確かめる）",
    next: ["api_reload"],
    evidence: { file: "background.js", token: "reset_not_pressed:" },
    audit: ["reset_stuck_shot", "reset_stuck_grasp"],
  },
  {
    id: "b_api_skip",
    kind: "branch",
    label: "条件を読み直せない→このお客さんを飛ばして次へ",
    parent: "api_reload",
    when: "API から3回読んでも読めない、または読み直した一覧にそのお客さんが居ない",
    playbook: "読めなければ古い条件では検索せず、このお客さんを飛ばして理由を残し、次のお客さんへ（2.8.318・customer_api_reload）",
    next: ["api_reload"],
    evidence: { file: "background.js", token: "AXLX_API_RELOAD_FAILED" },
    audit: ["customer_api_reload"],
    note: "飛ばした客は客完了を通らない（前客の送付後のリセットは済んでいる）。次の客の読み直しへ進む",
  },
  // ── 合流 ──────────────────────────────────────────────────
  {
    id: "customer_done",
    kind: "join",
    label: "客完了→リセットして次のお客さんへ",
    playbook:
      "リセットを押して次のお客さんへ。リセットからの流れは同じ（リセット→30〜34秒待つ→空とみなす→次客の条件をAPIから読み直して入れる→検索）",
    next: ["reset_front"],
    evidence: { file: "bulk-dl.js", token: "_sendBatchDone" },
    audit: ["post_send_clear", "handoff_loop"],
    note: "最後のお客さんは完了を待たせず裏でリセットして終わる",
  },
];

/**
 * 割り込み（どの段でも起きうる回復）。流れの途中の分岐にはしない（どの段から来ても同じ回復をするため）。
 *   実測の回は search_audits の #id。
 */
export const LOOP_INTERRUPTS: ReadonlyArray<FlowInterrupt> = [
  {
    id: "i_sw_restart",
    label: "拡張の裏（サービスワーカー）が起き直した",
    applies: "どの段でも",
    resume: "開いていた回を戻し、止まった段から続ける（前の段の記録は消えない）",
    evidence: { file: "background.js", token: "sw_restart_restored" },
    audit: ["sw_restart_restored"],
    seen: "#1659 #1663 #1666（並べ替え・検索・リセットの途中）",
  },
  {
    id: "i_tab_reload",
    label: "ページの入力の仕組みが応答しない",
    applies: "入力・検索・並べ替えの段",
    resume: "同じ検索画面を読み直して、同じ段から続ける（トップへ戻さない）",
    evidence: { file: "background.js", token: "tab_reload" },
    audit: ["tab_reload"],
    seen: "#1661 #1666",
  },
  {
    id: "i_tab_hidden_stall",
    label: "タブが見えないまま進捗が止まる",
    applies: "押す・入れる・待つの段（背面のタブ）",
    resume: "ウィンドウを元の大きさに戻して前に出し、同じ段へ（戻せなければ理由を残して先へ）",
    evidence: { file: "background.js", token: "tab_hidden_stall" },
    audit: ["tab_hidden_stall"],
    seen: "#1661（180・240・310秒の見張り）",
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
 *   ・branch は 親（step）・条件（when）・手順書の文・行き先を持つ。親は step
 *   ・どの branch からも 客完了（join）に着き、客完了から reset_front→reset に戻る（リセットからの流れは同じ）
 *   ・最初の手から全部に着ける（行き止まり・孤立が無い）
 *   ・join は 1つだけ
 *   ・割り込みは目印と点検の印を持つ（interrupts は別に検査: checkInterrupts）
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
    if (!n.audit.length) out.push(`${n.id} に点検の印（audit）が無い＝何が起きたか残らない`);
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
  // 分かれ道は勝手に別の手へ飛ばない。出てよいのは 客完了（合流）・親の手（もう一度）・次のお客さんの読み直し（api_reload）だけ
  for (const b of nodes.filter((n) => n.kind === "branch")) {
    for (const x of b.next) {
      const ok = (join && x === join.id) || x === b.parent || x === "api_reload";
      if (!ok) out.push(`${b.id} の行き先 ${x} は許されない（分かれ道は客完了・親の手・次のお客さんの読み直しへだけ出る）`);
    }
  }
  if (join) {
    if (!join.next.length || !join.next.every((x) => flowNode(x, nodes)?.kind === "step")) {
      out.push(`${join.id}（客完了）の次は step（リセット）でなければならない`);
    }
    if (!join.next.includes("reset_front")) out.push(`${join.id}（客完了）の次はリセット（reset_front）でなければならない（リセットからの流れは同じ）`);
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

/** 割り込みの形の点検（目印・点検の印・回復の決まりが在るか） */
export function checkInterrupts(list: ReadonlyArray<FlowInterrupt> = LOOP_INTERRUPTS): string[] {
  const out: string[] = [];
  const ids = new Set<string>();
  for (const i of list) {
    if (ids.has(i.id)) out.push(`割り込みの id が重なっている: ${i.id}`);
    ids.add(i.id);
    if (!i.evidence || !i.evidence.file || !i.evidence.token) out.push(`${i.id} にコードの目印（evidence）が無い`);
    if (!i.audit.length) out.push(`${i.id} に点検の印（audit）が無い`);
    if (!i.resume || !i.resume.trim()) out.push(`${i.id} に起きた後の動き（resume）が無い`);
    if (!i.applies || !i.applies.trim()) out.push(`${i.id} にどの段で起きるか（applies）が無い`);
  }
  return out;
}

/**
 * 手順書の一覧の手のうち ④から先（④・④の場合分け・⑤客完了）を、地図から作る。
 *   ・④ の文に「押す物が無い時は下の『④の1〜n』＝④の場合分け。順に行う手ではない」を自動で入れる
 *   ・branch は「④の k（④の場合分け）」。通し番号は付けない
 *   ・join は次の通し番号（⑤）
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

/**
 * 改善した中身が、手順書の手に載っているか（2026-11-27 竹内さん「改善する際、手順書の部分を細かく徹底的に強化」）。
 *   決まりを1行足すだけでは足りない。③は地図の「並べ替えは完了」の文をそのまま含む。
 *   ④は地図の「物件取得」の文をそのまま含む。どちらかを手順書から消すと、ここが止める。
 */
export function checkListPlaybookStrength(
  steps: readonly string[],
  nodes: ReadonlyArray<FlowNode> = LOOP_FLOW_NODES,
): string[] {
  const out: string[] = [];
  const sort = flowNode("sort", nodes);
  const press = flowNode("list_press", nodes);
  const s3 = steps.find((s) => s.startsWith("③"));
  const s4 = steps.find((s) => s.startsWith("④") && !s.startsWith("④の"));
  if (!sort?.playbook) out.push("sort に手順書の完了の文（playbook）が無い");
  else if (!s3 || !s3.includes(sort.playbook)) out.push("③に地図の「並べ替えは完了」の文が無い（コードだけ直して手順書が古いまま）");
  if (!press?.playbook) out.push("list_press に手順書の文（playbook）が無い");
  else if (!s4 || !s4.includes(press.playbook)) out.push("④に地図の物件取得の文が無い（コードだけ直して手順書が古いまま）");
  if (s3 && !/高→低/.test(s3)) out.push("③に高→低が無い");
  if (s4 && !/順に行う手ではない/.test(s4)) out.push("④が、場合分けは順に行う手ではない、と言っていない");
  const blob = steps.join("\n");
  for (const w of ["並べ替えは完了", "読み直した一覧", "④物件取得", "物件取得最中", "並べ替え最中"]) {
    if (!blob.includes(w)) out.push(`手順書の一覧に「${w}」が無い`);
  }
  return out;
}
