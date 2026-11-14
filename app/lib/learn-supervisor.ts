// app/lib/learn-supervisor.ts
//
// 2026-11-14 竹内さん「学習の統括の部分判断できるようにちゃんと強化していく。必要ならテーブルを作るなどして強化していく」
//
// なぜ要るか:
//   今までの `learn_plan` は「弱い所の一覧」を返すだけで、**判断**をしていなかった。
//     「写真と記録で種類が違う」が13件並ぶ → どれから直すのか・今の学びは使えるのか・
//     自動検索に渡してよいのかが分からない。
//   → 統括が**判断**する形にする:
//     ① 今の学びは **使えるか**（使える／まだ早い／危ない）＝ 1つの結論
//     ② **次にやる事**を優先順位つきで（どの欄から・なぜ・どう直すか）
//     ③ **サイトごと**（リアプロ／itandi）に分けて判断（性質が違うため）
//     ④ 前回と比べて**良くなったか悪くなったか**（数字で）
//
// ⚠ この関数は**判断だけ**をする（DBに書かない・サイトを触らない）。純関数。

/** 判断に使う材料（学習の束から作る） */
export type SupervisorInput = {
  /** 元にした記録の数と期間 */
  rows: number;
  /** 押す順番が学べた通り数 */
  next: number;
  /** 押す位置が学べた要素数 */
  points: number;
  /** 開き方が学べた要素数 */
  opens: number;
  /** 画面ごとの手順が学べた種類数 */
  screens: number;
  /** 一連の動きの手数 */
  sequence: number;
  /** 操作の間（中央値 ms） */
  gap_ms: number | null;
  /** 弱い所（種類・名前） */
  weak: ReadonlyArray<{ kind: string; name: string; why?: string }>;
  /** モード別の記録数（normal / staff / aix …） */
  mode_counts?: Record<string, number>;
  /** サイト別の記録数（realpro / itandi） */
  site_counts?: Record<string, number>;
  /** 材料（操作の並び）がある記録の数 */
  with_ops?: number;
  /** 前回の判断（比較用・無ければ null） */
  prev?: {
    at: string | null;
    rows: number;
    next: number;
    points: number;
    opens: number;
    weak: number;
  } | null;
  /** サイト（この判断がどのサイトの物か・all なら全体） */
  site?: string;
  /**
   * 2026-11-14 竹内さん「打ち合わせは絶対にここの統括が話をしてくるようにする」:
   *   「押したら何が開くか」のうち**推測**で埋めた数（実測ではない）。
   *   ⚠ 推測を実測と同じ重さで点数に入れると、学べていないのに高得点になる。
   */
  guessed_opens?: number;
  /** 2026-11-14: 写真がある記録の数（写真の割合を実データから出す） */
  shot_rows?: number;
  /**
   * 2026-11-14 竹内さん「通常モードでの学習で自動モード改善するように」
   *   「統括がちゃんと学習にの指示だし把握できるように細かい部分まで徹底する」:
   *   **人が押した操作**と**拡張が押した操作**の数。
   *   ⚠ 自動検索の改善に使えるのは**人の手本**だけ（機械の動きを学ぶと自分の癖を強める）。
   */
  human_ops?: number;
  auto_ops?: number;
  /**
   * 2026-11-14 竹内さん「データベースと統括もちゃんと関連しなきゃいけない」:
   *   **実際の検索の結果**（`search_audits` の集計）。これが無いと統括は現場の現実を知らない
   *   （実測: 60回中56回が途中で止まっていたのに「渡してよい」と言っていた）。
   */
  audits?: {
    runs: number;
    finished: number;
    abandoned: number;
    finish_rate: number;
    /** 止まった場所（日本語・多い順） */
    stalled_at?: Array<{ stage: string; n: number }>;
    causes?: Array<{ cause: string; n: number }>;
    bad?: number;
    top_problem?: string | null;
    advice?: string | null;
  } | null;
  /**
   * 2026-11-14 竹内さん「統括側に足りていない部分があれば強化する形とする」:
   *   **指示（自動便・一括検索）が詰まっていないか**（`automation_commands` の集計）。
   *   ⚠ これを入れないと、統括は「検索は止まっていない」と言いながら
   *     **指示が溜まったまま／失敗したまま**という現場の詰まりを見落とす。
   */
  commands?: {
    /** 期間内の指示の数 */
    total: number;
    /** 終わった数 */
    done: number;
    /** 失敗した数 */
    failed: number;
    /** まだ拾われていない（pending） */
    pending: number;
    /** 実行中（running） */
    running: number;
    /** 失敗の理由（多い順） */
    errors?: Array<{ error: string; n: number }>;
    /** 一番の問題を1文で */
    top_problem?: string | null;
    /** 「自動/AIXモードのPCが無かった」で終わった数（運用の問題・処理ではない） */
    mode_absent?: { aix_absent: number; brain_absent: number } | null;
  } | null;
};

export type SupervisorVerdict = "ready" | "almost" | "not_yet" | "unsafe";

/** 結論の日本語（1か所だけで持つ） */
const HEAD: Record<SupervisorVerdict, string> = {
  ready: "学べています（自動検索に渡してよい）",
  almost: "もう少しで使えます（一部は自動に渡しています）",
  not_yet: "まだ学べていません（自動に渡すと危ない）",
  unsafe: "危ない（自動に渡さない方がよい）",
};

export type SupervisorAdvice = {
  /** ① 結論（1つ） */
  verdict: SupervisorVerdict;
  /** 人が読む1行の結論 */
  headline: string;
  /** ② 次にやる事（優先順位つき・最大8件） */
  actions: Array<{ priority: number; what: string; why: string; how: string; name?: string }>;
  /** ③ 数で見た状態 */
  score: {
    /** 学びの材料がどれだけ揃っているか（0〜100） */
    coverage: number;
    /** 弱い所の数（少ないほど良い） */
    weak: number;
    /** 前回より良くなったか（+良くなった / -悪くなった / 0同じ / null比べられない） */
    delta: { rows: number; next: number; points: number; opens: number; weak: number } | null;
  };
  /** ④ 止めるべき理由（危ない時だけ・無ければ null） */
  block: string | null;
  /** ⑤ 人が読む行（画面・報告用） */
  lines: string[];
  /**
   * 2026-11-14 竹内さん「打ち合わせは絶対にここの統括が話をしてくるようにする」:
   *   **打ち合わせで統括自身が話す内容**（議題・根拠・竹内さんへの質問）。
   *   ⚠ ただの数字の列ではなく「**何を決めたいか**」を出す。
   *   ・today     … 今日の結論（1〜3行）
   *   ・agenda    … 議題（決めたい事・相談したい事）優先順位つき
   *   ・questions … 竹内さんに聞く事（統括だけでは決められない）
   *   ・evidence  … 根拠（数字・実測。推測は「推測」と明記）
   */
  meeting: {
    /** 今日の結論（そのまま読み上げられる形） */
    today: string[];
    /** 議題（優先順位つき） */
    agenda: Array<{ priority: number; topic: string; why: string; decide: string }>;
    /** 竹内さんに聞く事（判断を委ねる） */
    questions: Array<{ q: string; options?: string[]; why: string }>;
  /** 根拠（数字。推測は guessed:true） */
  evidence: Array<{ label: string; value: string; guessed?: boolean }>;
  };
  /**
   * 2026-11-14 竹内さん「矛盾の部分なんで統括が整理したらよい」:
   *   **統括が自分の判断を点検した結果**（矛盾が無いか）。
   *   ⚠ 矛盾があれば `ok:false` と `issues` に理由を出す。会話では先にこれを言う。
   */
  self_check: {
    ok: boolean;
    /** 見つけた矛盾（人が読める形） */
    issues: string[];
    /** 上限をかけた理由（あれば） */
    capped_by: string | null;
  };
};

/** 弱い所の種類ごとに「どう直すか」 */
const FIX: Record<string, { what: string; how: string; priority: number }> = {
  photo_vs_record: {
    what: "記録と写真で欄の種類が違う",
    how: "実際の画面を見て、その欄が select（プルダウン）か input（入力）かを確かめる。`shot_learn` を写真から読み直す",
    priority: 1,
  },
  kind_conflict_in_photo: {
    what: "同じ欄が写真の中で違う種類に見えた",
    how: "2枚以上の写真で同じ欄を読み、多い方を採る（1枚だけで決めない）",
    priority: 2,
  },
  kind_unknown: {
    what: "欄の種類が分からない",
    how: "名前から推す（`room_layout_id[]`→チェック、`rental_cost2`→プルダウン、`required_time`→入力）",
    priority: 3,
  },
  pressed_disabled: {
    what: "押せない（グレー）物を押そうとした",
    how: "押す前に「押せるか」を見る（`disabled` / `pointer-events:none` / グレーの見た目）",
    priority: 1,
  },
};

/**
 * 統括の判断（純関数）。
 *   ① 今の学びが**使えるか**を1つに決める
 *   ② **次にやる事**を優先順位で並べる
 *   ③ 数字で良し悪しを出す
 */
export function superviseLearn(input: SupervisorInput): SupervisorAdvice {
  const inp = input || ({} as SupervisorInput);
  const site = String(inp.site || "all");
  const rows = num(inp.rows);
  const next = num(inp.next);
  const points = num(inp.points);
  const opens = num(inp.opens);
  const screens = num(inp.screens);
  const sequence = num(inp.sequence);
  const withOps = num(inp.with_ops);
  const weakList = Array.isArray(inp.weak) ? inp.weak : [];
  const weakN = weakList.length;

  /**
   * 材料の揃い具合（0〜100）。何が「学べた」と言えるかの目安:
   *   ・押す順番 10通り以上 … 25点
   *   ・押す場所 20個以上 … 25点
   *   ・開き方 5個以上 … 15点
   *   ・画面ごとの手順 2種類以上 … 15点
   *   ・材料（操作の並び）がある記録が 50件以上 … 20点
   */
  let coverage = 0;
  if (next >= 10) coverage += 25; else if (next >= 5) coverage += 15; else if (next >= 1) coverage += 8;
  if (points >= 20) coverage += 25; else if (points >= 10) coverage += 15; else if (points >= 1) coverage += 8;
  if (opens >= 5) coverage += 15; else if (opens >= 1) coverage += 8;
  if (screens >= 2) coverage += 15; else if (screens >= 1) coverage += 8;
  if (withOps >= 50) coverage += 20; else if (withOps >= 10) coverage += 12; else if (withOps >= 1) coverage += 5;

  const actions: SupervisorAdvice["actions"] = [];
  const seen = new Set<string>();

  // ── ② 次にやる事 ──
  for (const w of weakList) {
    if (!w || !w.name) continue;
    const key = String(w.kind) + "|" + String(w.name);
    if (seen.has(key)) continue;
    seen.add(key);
    const f = FIX[String(w.kind)] || { what: "学びが弱い", how: "記録を増やしてもう一度学ぶ", priority: 9 };
    actions.push({
      priority: f.priority,
      what: f.what,
      why: String(w.why || ""),
      how: f.how,
      name: String(w.name),
    });
  }

  /**
   * 材料が足りない時の「次にやる事」。
   *   ⚠ 「弱い所」だけを見ていると、**そもそも記録が無い**事に気づけない（実測: 自動が0件のまま
   *     「追加で強化する所は無し」と言っていた）。
   */
  if (withOps === 0 && rows > 0) {
    actions.push({
      priority: 0,
      what: "写真に操作が付いていない（材料ゼロ）",
      why: `${rows}件の記録があるのに、操作の並びが付いた記録が0件`,
      how: "録画の時に `shot_ops` が空。`axlx_rec_ops` を見て「届いていない／輪が空」を切り分ける",
    });
  } else if (withOps > 0 && rows > 0 && withOps / rows < 0.1) {
    actions.push({
      priority: 1,
      what: "操作が付く記録が少なすぎる",
      why: `${rows}件中 ${withOps}件だけ（1割未満）`,
      /**
       * 2026-11-14: ⚠ 旧は「写真と操作を結ぶ道を点検する」とだけ書いていたので、
       *   `shot_learn` を埋め直す（`/api/learn-fill-shot`）を実行しても**直らなかった**。
       *   `shot_learn` は写真から読んだ種類、`shot_ops` は**録画の時に拡張が送る操作の並び**で**別物**。
       *   → **何が足りないか**を名指しし、**どこを見るか**を具体的に書く。
       */
      how: "`shot_ops`（録画の時の操作の並び）が届いていない。`axlx_rec_ops` の `why`（ring_empty / no_answer）を見て、拡張側の記録の経路を直す。※ `shot_learn` を埋めても増えない（別物）",
    });
  }
  const mc = inp.mode_counts || {};
  const aixRows = num(mc.aix);
  if (aixRows === 0) {
    actions.push({
      priority: 2,
      what: "AIX（自動）の記録が無い",
      why: "自動モードの動きがDBに届いていない",
      how: "自動モードで1回検索して録画し、`mode_counts` に aix が出るか確かめる",
    });
  }
  const scount = inp.site_counts || {};
  const siteKeys = Object.keys(scount);
  if (siteKeys.length === 1 && site === "all") {
    actions.push({
      priority: 3,
      what: `${siteKeys[0]} だけで、もう片方のサイトの記録が無い`,
      why: `記録があるのは ${siteKeys.join("・")} だけ`,
      how: "もう片方のサイトでも1回検索して録画する（サイトごとに性質が違うため）",
    });
  }
  if (sequence === 0 && next > 0) {
    actions.push({
      priority: 4,
      what: "一連の動き（手順の鎖）が作れていない",
      why: `押す順番は ${next}通りあるのに、一連の型が0手`,
      how: "録画を続けて、同じ日の同じ並びを2回以上作る",
    });
  }

  actions.sort((a, b) => a.priority - b.priority);

  // ── ④ 危ない（止める）判断 ──
  /**
   * ⚠ **場所（区・駅）が入らないまま検索する**のが一番危ない（お客様に無関係な物件が飛ぶ）。
   *   ただし「止める」は実際の検索の判断（page-script）が持つ。ここでは**警告**として出す。
   *   ⚠ 材料がゼロ（`withOps === 0`）の時は「押す場所0」は**当然**（まだ何も学べていない）なので、
   *     `unsafe` ではなく `not_yet`（これから学ぶ段階）にする。
   */
  const block =
    points === 0 && rows > 0 && withOps > 0
      ? "押す場所が1つも学べていない（区・駅を押せない恐れ）"
      : null;

  // ── ① 結論 ──
  /**
   * 2026-11-14 竹内さん「矛盾の部分なんで統括が整理したらよい。統括がちゃんと整理して会話できるようにする」:
   *
   *   ⚠ **統括自身が矛盾していた**（本番の実測）:
   *     結論=「学べています（自動検索に渡してよい）」材料85点
   *     同時に 議題=「写真は撮れているのに、操作が付いていない（7%）」
   *   → 配点は「材料つき記録が50件以上で満点20点」なので **4121件中303件（7%）でも満点**になり、
   *     85点に届いて `ready` を出していた。**中身が薄いのに「渡してよい」と言っていた**。
   *
   *   → 結論を出す前に**材料の割合で上限をかける**（統括が自分で整理する）:
   *     ・材料ゼロ … not_yet（今まで通り）
   *     ・材料つき記録が 30% 未満 … **ready にしない**（最大 almost）
   *   ⚠ `unsafe` は上限で緩めない（危ない物は危ないまま）。
   */
  const opsRatio = rows > 0 ? withOps / rows : 0;
  /**
   * 2026-11-14 竹内さん「通常モードでの学習で自動モード改善するように」:
   *   **人の手本**がどれだけあるか。
   *   ⚠ 自動検索を良くするには**人が実際にやった動き**が要る。
   *     機械の動き（拡張が押した物）を学ぶと**自分の癖を強める**だけ。
   */
  const humanOps = num((input as unknown as Record<string, unknown>).human_ops);
  const autoOps = num((input as unknown as Record<string, unknown>).auto_ops);
  const byTotal = humanOps + autoOps;
  const humanShare = byTotal > 0 ? humanOps / byTotal : null;
  /**
   * 2026-11-14 竹内さん「統括側に足りていない部分があれば強化する形とする」:
   *   **指示が詰まっていないか**も判断材料にする（`automation_commands`）。
   *   ⚠ 検索は動いていても、**指示が拾われないまま／失敗したまま**なら現場は詰まっている。
   */
  const cm = inp.commands && typeof inp.commands === "object" ? inp.commands : null;
  const cmdTotal = num(cm?.total);
  const cmdStale = cm?.top_problem ? String(cm.top_problem) : null;
  const capByRatio: SupervisorVerdict | null =
    rows > 0 && withOps === 0 ? "not_yet"
      : rows > 0 && opsRatio < 0.3 ? "almost"
        : null;

  /**
   * 2026-11-14 竹内さん「データベースと統括もちゃんと関連しなきゃいけない」:
   *   **実際の検索の完走率**でも上限をかける（人の動きを学べていても、実際の検索が止まるなら渡せない）。
   *   ⚠ 実測: 60回中56回が途中で止まっていた（完走率 7%）。
   *     これを知らないまま `ready` を出していたのが一番の問題だった。
   */
  const au = inp.audits && typeof inp.audits === "object" ? inp.audits : null;
  const auditRuns = num(au?.runs);
  const auditRate = auditRuns > 0 ? num(au?.finish_rate) : null;
  const capByAudit: SupervisorVerdict | null =
    auditRuns === 0 ? null
      : auditRate == null ? null
        : auditRate < 50 ? "not_yet"     // 半分も完走しない＝自動に渡せない
          : auditRate < 90 ? "almost"     // たまに止まる＝まだ「渡してよい」とは言えない
            : null;
  /**
   * 2026-11-14 竹内さん「通常モードでの学習で自動モード改善するように」:
   *   **人の手本が少なすぎる**時は「渡してよい」にしない。
   *   ⚠ 実測: `by`（人/機械）を記録していなかったので、機械の動きまで手本にしていた。
   *   → 人の手本が 3割未満なら最大 almost（自動を良くする材料が足りない）。
   */
  const capByHuman: SupervisorVerdict | null =
    byTotal === 0 ? null                    // まだ `by` が無い（旧記録）→ 制限しない
      : humanShare == null ? null
        : humanShare < 0.3 ? "almost"
          : null;

  let verdict: SupervisorVerdict;
  if (withOps === 0 && rows > 0) verdict = "not_yet";   // 材料ゼロは「これから」段階（危ないの一歩手前）
  else if (block) verdict = "unsafe";
  else if (coverage >= 65 && weakN <= 5) verdict = "ready";
  else if (coverage >= 40) verdict = "almost";
  else verdict = "not_yet";

  if (capByRatio && verdict !== "unsafe") {
    const rank: Record<SupervisorVerdict, number> = { unsafe: 3, ready: 2, almost: 1, not_yet: 0 };
    if (rank[verdict] > rank[capByRatio]) verdict = capByRatio;
  }
  if (capByAudit && verdict !== "unsafe") {
    const rank: Record<SupervisorVerdict, number> = { unsafe: 3, ready: 2, almost: 1, not_yet: 0 };
    if (rank[verdict] > rank[capByAudit]) verdict = capByAudit;
  }
  if (capByHuman && verdict !== "unsafe") {
    const rank: Record<SupervisorVerdict, number> = { unsafe: 3, ready: 2, almost: 1, not_yet: 0 };
    if (rank[verdict] > rank[capByHuman]) verdict = capByHuman;
  }
  /** 上限が効いたか（点検・会話で「なぜ ready でないか」を言えるように） */
  const cappedParts: string[] = [];
  if (capByRatio && rank2(verdict) <= rank2(capByRatio)) {
    cappedParts.push(`材料つき記録が ${Math.round(opsRatio * 100)}%（${withOps}/${rows}）なので「渡してよい」にはしない`);
  }
  if (capByAudit && rank2(verdict) <= rank2(capByAudit)) {
    cappedParts.push(`実際の検索の完走率が ${auditRate}%（${num(au?.finished)}/${auditRuns}回）なので「渡してよい」にはしない`);
  }
  if (capByHuman && rank2(verdict) <= rank2(capByHuman)) {
    cappedParts.push(`人の手本が ${Math.round((humanShare ?? 0) * 100)}%（人${humanOps}/機械${autoOps}回）なので「渡してよい」にはしない`);
  }
  const cappedBy: string | null = cappedParts.length ? cappedParts.join(" ／ ") : null;

  // ── ③ 前回との比較 ──
  const prev = inp.prev && typeof inp.prev === "object" ? inp.prev : null;
  const delta = prev
    ? {
      rows: rows - num(prev.rows),
      next: next - num(prev.next),
      points: points - num(prev.points),
      opens: opens - num(prev.opens),
      weak: weakN - num(prev.weak),
    }
    : null;

  // ── ⑤ 人が読む行 ──
  const lines: string[] = [];
  lines.push(`【統括】${site === "all" ? "全体" : site}: ${HEAD[verdict]}`);
  lines.push(`  材料の揃い: ${coverage}/100（順番${next}通り・場所${points}個・開き方${opens}個・画面${screens}種類・一連${sequence}手）`);
  lines.push(`  弱い所: ${weakN}件`);
  if (block) lines.push(`  ⚠ ${block}`);
  if (delta) {
    const up = (v: number, label: string) => {
      if (v > 0) return `${label}+${v}`;
      if (v < 0) return `${label}${v}`;
      return `${label}±0`;
    };
    lines.push(`  前回から: ${up(delta.rows, "記録")}・${up(delta.next, "順番")}・${up(delta.points, "場所")}・${up(delta.opens, "開き方")}・${up(delta.weak, "弱い所")}`);
  }
  if (actions.length) {
    lines.push("  次にやる事:");
    for (const a of actions.slice(0, 5)) {
      lines.push(`    ・${a.what}${a.name ? `（${a.name}）` : ""} … ${a.how}`);
    }
  } else {
    lines.push("  次にやる事: 追加で強化する所は無し（このまま録画を続ける）");
  }

  return {
    verdict,
    headline: HEAD[verdict],
    actions: actions.slice(0, 8),
    score: { coverage, weak: weakN, delta },
    block,
    lines,
    self_check: selfCheck({
      verdict, coverage, weakN, rows, withOps, opsRatio, cappedBy, block,
      guessedOpens: num((input as unknown as Record<string, unknown>).guessed_opens), opens,
      audits: au ? { runs: num(au.runs), finished: num(au.finished), finish_rate: num(au.finish_rate), stalled_at: au.stalled_at } : null,
    }),
    meeting: buildMeeting({
      site, verdict, coverage, rows, next, points, opens, screens, sequence,
      withOps, weakN, block, actions, delta,
      /** 推測で埋めた開き方の数（実測ではない物） */
      guessedOpens: num((input as unknown as Record<string, unknown>).guessed_opens),
      siteCounts: inp.site_counts || {},
      modeCounts: inp.mode_counts || {},
      shotRows: num((input as unknown as Record<string, unknown>).shot_rows),
      /** 2026-11-14: 実際の検索の結果も議題に使う */
      audits: au,
      /** 2026-11-14: 現場への指示の詰まりも議題に使う */
      commands: cm,
      /** 2026-11-14: 人の手本と機械の動き */
      humanOps,
      autoOps,
    }),
  };
}

/** 結論の強さの順（上限をかける時に使う） */
function rank2(v: SupervisorVerdict): number {
  return v === "unsafe" ? 3 : v === "ready" ? 2 : v === "almost" ? 1 : 0;
}

/**
 * 2026-11-14 竹内さん「矛盾の部分なんで統括が整理したらよい。統括がちゃんと整理して会話できるようにする」:
 *   **統括が自分の判断を点検する**（純関数）。
 *
 *   ⚠ 実際に起きた矛盾:
 *     結論=「学べています（自動検索に渡してよい）」＋材料85点
 *     同時に 議題=「操作が付いているのは303/4121件（7%）」
 *   → 「渡してよい」と言いながら「材料が7%」は**矛盾**。人が読むと信用を失う。
 *
 *   点検する事:
 *     ① `ready` なのに材料の割合が低い（30%未満）
 *     ② `ready` なのに弱い所が5件より多い
 *     ③ 点数が高い（65以上）のに材料の割合が低い（**点数の意味が薄い**）
 *     ④ 開き方が全部推測なのに点数に入っている
 *     ⑤ `unsafe` なのに「次にやる事」が無い（何をすればよいか分からない）
 */
function selfCheck(m: {
  verdict: SupervisorVerdict;
  coverage: number;
  weakN: number;
  rows: number;
  withOps: number;
  opsRatio: number;
  cappedBy: string | null;
  block: string | null;
  guessedOpens: number;
  opens: number;
  /** 2026-11-14: 実際の検索の結果（完走率が低いのに「渡してよい」を防ぐ） */
  audits?: { runs: number; finished: number; finish_rate: number; stalled_at?: Array<{ stage: string; n: number }> } | null;
}): { ok: boolean; issues: string[]; capped_by: string | null } {
  const issues: string[] = [];
  const pct = Math.round((m.opsRatio || 0) * 100);

  if (m.rows > 0 && m.opsRatio < 0.3) {
    if (m.verdict === "ready") {
      issues.push(`「渡してよい」と言っていますが、材料つき記録は ${m.withOps}/${m.rows}（${pct}%）だけです`);
    }
    if (m.coverage >= 65) {
      issues.push(`材料 ${m.coverage}点は高すぎます（材料つき記録が${pct}%しかないので、点数の意味が薄い）`);
    }
  }
  if (m.verdict === "ready" && m.weakN > 5) {
    issues.push(`「渡してよい」と言っていますが、弱い所が ${m.weakN}件あります`);
  }
  if (m.opens > 0 && m.guessedOpens >= m.opens && m.coverage >= 65) {
    issues.push(`「押したら何が開くか」${m.opens}個が全部推測なのに、材料 ${m.coverage}点に数えています`);
  }
  if (m.verdict === "unsafe" && !m.block) {
    issues.push("「危ない」と言っていますが、理由（block）がありません");
  }
  /**
   * 2026-11-14 竹内さん「データベースと統括もちゃんと関連しなきゃいけない」:
   *   **実際の検索の完走率**が低いのに「渡してよい」と言っていたら矛盾。
   *   ⚠ これが今まで見えていなかった一番の問題（実測: 完走率7%で `ready` を出していた）。
   */
  const ar = m.audits && num(m.audits.runs) > 0 ? num(m.audits.finish_rate) : null;
  if (ar != null && ar < 90) {
    const top = Array.isArray(m.audits?.stalled_at) && m.audits!.stalled_at!.length ? m.audits!.stalled_at![0] : null;
    if (m.verdict === "ready") {
      issues.push(`「渡してよい」と言っていますが、実際の検索は ${m.audits!.finished}/${m.audits!.runs}回しか完走していません（完走率 ${ar}%）`);
    }
    if (ar < 50) {
      issues.push(`実際の検索が半分も完走していません（${ar}%）${top ? `。一番止まるのは「${top.stage}」（${top.n}回）` : ""}`);
    }
  }

  return {
    ok: issues.length === 0,
    issues,
    capped_by: m.cappedBy,
  };
}

/**
 * 2026-11-14 竹内さん「打ち合わせは絶対にここの統括が話をしてくるようにする」:
 *   **統括が打ち合わせで話す内容**を作る（純関数）。
 *   ⚠ 「数字を並べる」のではなく、**決めたい事・聞きたい事**を出す。
 */
function buildMeeting(m: {
  site: string; verdict: SupervisorVerdict; coverage: number;
  rows: number; next: number; points: number; opens: number; screens: number; sequence: number;
  withOps: number; weakN: number; block: string | null;
  actions: SupervisorAdvice["actions"];
  delta: SupervisorAdvice["score"]["delta"];
  guessedOpens: number;
  siteCounts: Record<string, number>;
  modeCounts: Record<string, number>;
  /** 2026-11-14: 実際の検索の結果も議題に使う */
  audits?: SupervisorInput["audits"];
  /** 2026-11-14: 現場への指示の詰まりも議題に使う */
  commands?: SupervisorInput["commands"];
  /** 2026-11-14: 人の手本と機械の動きの数（人の割合で判断を制限する） */
  humanOps?: number;
  autoOps?: number;
  /** 写真がある記録の数（写真の割合を実データから出すため） */
  shotRows?: number;
}): SupervisorAdvice["meeting"] {
  const num = (v: unknown): number => {
    const n = typeof v === "number" ? v : Number(v);
    return Number.isFinite(n) && n > 0 ? n : 0;
  };
  const who = m.site === "all" ? "全体" : m.site;
  const today: string[] = [];
  const agenda: SupervisorAdvice["meeting"]["agenda"] = [];
  const questions: SupervisorAdvice["meeting"]["questions"] = [];
  const evidence: SupervisorAdvice["meeting"]["evidence"] = [];

  // ── 根拠（数字）──
  evidence.push({ label: "結論", value: `${HEAD[m.verdict]}（材料 ${m.coverage}/100・弱い所 ${m.weakN}件）` });
  evidence.push({ label: "記録", value: `${m.rows}件（うち操作が付いている ${m.withOps}件）` });
  evidence.push({ label: "押す順番", value: `${m.next}通り` });
  evidence.push({ label: "押す場所", value: `${m.points}個` });
  if (m.opens > 0) {
    evidence.push({
      label: "押したら何が開くか",
      value: `${m.opens}個（うち推測 ${m.guessedOpens}個・実測 ${Math.max(0, m.opens - m.guessedOpens)}個）`,
      guessed: m.guessedOpens >= m.opens,
    });
  }
  evidence.push({ label: "画面ごとの手順", value: `${m.screens}種類` });
  evidence.push({ label: "一連の動き", value: `${m.sequence}手` });
  /**
   * 2026-11-14 竹内さん「データベースと統括もちゃんと関連しなきゃいけない」:
   *   **実際の検索の結果**を根拠に出す（これが無いと現場の現実を無視した判断になる）。
   */
  if (m.audits && num(m.audits.runs) > 0) {
    evidence.push({
      label: "実際の検索",
      value: `${m.audits.runs}回中 完走${m.audits.finished}回（完走率 ${m.audits.finish_rate}%）・途中で止まった ${m.audits.abandoned}回`,
    });
    if (Array.isArray(m.audits.stalled_at) && m.audits.stalled_at.length) {
      evidence.push({ label: "止まりやすい場所", value: m.audits.stalled_at.slice(0, 3).map((x) => `${x.stage}（${x.n}回）`).join("・") });
    }
  }
  /**
   * 2026-11-14 竹内さん「統括側に足りていない部分があれば強化する形とする」:
   *   **指示（自動便・一括検索）の詰まり**も根拠に出す。
   */
  if (m.commands && num(m.commands.total) > 0) {
    evidence.push({
      label: "現場への指示",
      value: `${m.commands.total}件（完了${m.commands.done}・失敗${m.commands.failed}・待ち${m.commands.pending}・実行中${m.commands.running}）`,
    });
  }
  /**
   * 2026-11-14 竹内さん「通常モードでの学習で自動モード改善するように」:
   *   **人の手本と機械の動き**を分けて根拠に出す（自動を良くする材料は人の動き）。
   */
  if (typeof m.humanOps === "number" || typeof m.autoOps === "number") {
    const h = num(m.humanOps), a = num(m.autoOps), t = h + a;
    if (t > 0) {
      evidence.push({
        label: "手本にできる動き",
        value: `人の操作 ${h}回 / 機械の操作 ${a}回（人の割合 ${Math.round((h / t) * 100)}%）`,
      });
    }
  }
  const sc = Object.entries(m.siteCounts).filter(([k]) => k && k !== "(空)");
  if (sc.length) evidence.push({ label: "サイト別の記録", value: sc.map(([k, v]) => `${k} ${v}件`).join("・") });
  const mc = Object.entries(m.modeCounts);
  if (mc.length) evidence.push({ label: "モード別の記録", value: mc.map(([k, v]) => `${k} ${v}件`).join("・") });

  // ── 今日の結論（読み上げられる形）──
  today.push(`【${who}】${HEAD[m.verdict]}`);
  today.push(`材料 ${m.coverage}点／弱い所 ${m.weakN}件／記録 ${m.rows}件（操作が付いているのは ${m.withOps}件）`);
  if (m.delta) {
    const d = m.delta;
    const parts: string[] = [];
    if (d.rows) parts.push(`記録${d.rows > 0 ? "+" : ""}${d.rows}`);
    if (d.next) parts.push(`順番${d.next > 0 ? "+" : ""}${d.next}`);
    if (d.points) parts.push(`場所${d.points > 0 ? "+" : ""}${d.points}`);
    if (d.weak) parts.push(`弱い所${d.weak > 0 ? "+" : ""}${d.weak}`);
    if (parts.length) today.push(`前回から: ${parts.join("・")}`);
  }

  // ── 議題（決めたい事）──
  /**
   * 2026-11-14 竹内さん「統括側に足りていない部分があれば強化する形とする」:
   *   **指示が詰まっている**のも議題（検索が動いていても現場は止まる）。
   */
  if (m.commands && num(m.commands.total) > 0 && m.commands.top_problem) {    const ma = m.commands.mode_absent;
    const absent = ma ? num(ma.aix_absent) + num(ma.brain_absent) : 0;
    agenda.push({
      priority: 0,
      topic: absent > 0 ? "自動/AIXモードになっていない時間が長い（指示が届かない）" : "現場への指示が詰まっている",
      why: String(m.commands.top_problem),
      /**
       * 2026-11-14 竹内さん「ここも調べる」→ 実測:
       *   ⚠ 失敗の **187件が「AIXモードのPCが3時間なかった」**。指示の処理は壊れていない。
       *   → **直す所を間違えない**ように、運用（モードを保つ）と処理（コード）を分けて言う。
       */
      decide: absent > 0
        ? "拡張を自動/AIXモードのままにしておく（PCを閉じない・モードを戻さない）／指示の期限を延ばすか"
        : "指示が拾われるようにする／失敗の理由を直す",
    });
    questions.push({
      q: absent > 0
        ? `指示の失敗 ${absent}件は「自動/AIXモードのPCが3時間なかった」ためです。どちらを直しますか？`
        : `現場への指示: ${m.commands.top_problem} どれから直しますか？`,
      options: absent > 0
        ? ["モードを保つ運用を直す（推奨）", "指示の期限を延ばす", "今のままでよい"]
        : ["拾われていない指示から（推奨）", "失敗の理由から", "今のままでよい"],
      why: absent > 0
        ? "指示の処理は壊れていない。拡張がモードになっていない時間が長いのが原因"
        : "検索が動いていても、指示が届かなければ物件が出ない",
    });
  }
  /**
   * 2026-11-14 竹内さん「データベースと統括もちゃんと関連しなきゃいけない」:
   *   **一番大事な議題は「実際の検索が止まっている」**（人の動きを学べていても意味がない）。
   *   ⚠ 実測: 60回中56回が途中で止まっていた。
   */
  if (m.audits && num(m.audits.runs) > 0 && num(m.audits.finish_rate) < 90) {    const top = Array.isArray(m.audits.stalled_at) && m.audits.stalled_at.length ? m.audits.stalled_at[0] : null;
    agenda.push({
      priority: 0,
      topic: "実際の検索が途中で止まっている",
      why: `${m.audits.runs}回中 完走は ${m.audits.finished}回だけ（完走率 ${m.audits.finish_rate}%）${top ? `。一番多いのは「${top.stage}」で止まる（${top.n}回）` : ""}`,
      decide: top ? `「${top.stage}」を直す／このままでよいか` : "止まる原因を調べる",
      ...(m.audits.advice ? { why: `${m.audits.runs}回中 完走は ${m.audits.finished}回だけ（完走率 ${m.audits.finish_rate}%）。${top ? `一番多いのは「${top.stage}」（${top.n}回）。` : ""}${m.audits.advice}` } : {}),
    });
    questions.push({
      q: `実際の検索が ${m.audits.runs}回中 ${m.audits.finished}回しか完走していません（完走率 ${m.audits.finish_rate}%）。どれから直しますか？`,
      options: top ? [`「${top.stage}」から直す（推奨）`, "別の所から直す", "今のままでよい"] : ["止まる原因を調べる（推奨）", "今のままでよい"],
      why: "人の動きを学べていても、実際の検索が止まるなら自動には渡せない",
    });
  }

  /**
   * ⚠ 一番大事な議題は「**材料が足りない**」事。数字が良くても中身が薄い事がある。
   */
  if (m.humanOps != null || m.autoOps != null) {
    const h = num(m.humanOps), a = num(m.autoOps), t = h + a;
    if (t > 0 && h / t < 0.3) {
      agenda.push({
        priority: 1,
        topic: "人の手本が少ない（自動を良くする材料が足りない）",
        why: `手本にできる人の操作が ${h}回、機械の操作が ${a}回（人の割合 ${Math.round((h / t) * 100)}%）`,
        /**
         * 2026-11-14 竹内さん「通常モードでの学習で自動モード改善するように」:
         *   ⚠ 機械の動きを学んでも**自分の癖を強める**だけ。自動を良くするのは人の手本。
         */
        decide: "通常モードで人が実際に検索して録画する（自動モードの動きは手本にしない）",
      });
      questions.push({
        q: `自動を良くする「人の手本」が ${Math.round((h / t) * 100)}% しかありません（人${h}回/機械${a}回）。どうしますか？`,
        options: ["通常モードで人が検索して録画を増やす（推奨）", "機械の動きも半分の重さで学ぶ", "今のままでよい"],
        why: "機械の動きを手本にすると、自動の癖を強めてしまう",
      });
    }
  }
  /**
   * ⚠ 一番大事な議題は「**材料が足りない**」事。数字が良くても中身が薄い事がある。
   */
  if (m.rows > 0 && m.withOps / m.rows < 0.3) {
    agenda.push({
      priority: 0,
      topic: "写真は撮れているのに、操作が付いていない",
      why: `記録 ${m.rows}件のうち、操作の並びが付いているのは ${m.withOps}件（${Math.round((m.withOps / m.rows) * 100)}%）`,
      decide: "操作を付ける仕組みを直す（録画の経路）／このままでよいか",
    });
  }
  if (m.opens > 0 && m.guessedOpens >= m.opens) {
    agenda.push({
      priority: 1,
      topic: "「押したら何が開くか」が全部推測",
      why: `実測が0で、名前から推測した ${m.guessedOpens}個だけ`,
      decide: "推測を点数に入れるか／実測が入るまで点を下げるか",
    });
  }
  if (m.block) {
    agenda.push({ priority: 0, topic: "自動に渡すと危ない状態", why: m.block, decide: "自動を止めるか、警告だけで続けるか" });
  }
  const siteKeys = Object.keys(m.siteCounts).filter((k) => k && k !== "(空)");
  if (siteKeys.length === 1 && m.site === "all") {
    agenda.push({
      priority: 2,
      topic: `片方のサイト（${siteKeys[0]}）しか記録が無い`,
      why: `${siteKeys[0]} だけ。もう片方は運用されていない`,
      decide: "もう片方も運用するか／片方だけでよいか",
    });
  }
  if (m.coverage >= 65 && m.weakN > 5) {
    agenda.push({
      priority: 3,
      topic: "点数は高いのに弱い所が多い",
      why: `材料 ${m.coverage}点なのに弱い所 ${m.weakN}件`,
      decide: "点数の配点を見直すか／弱い所を先に潰すか",
    });
  }
  for (const a of m.actions.slice(0, 3)) {
    if (agenda.length >= 5) break;
    agenda.push({
      priority: 4,
      topic: a.what + (a.name ? `（${a.name}）` : ""),
      why: a.why || "",
      decide: a.how,
    });
  }

  // ── 竹内さんに聞く事 ──
  if (m.rows > 0 && m.withOps / m.rows < 0.3) {
    const opsPct = Math.round((m.withOps / Math.max(1, m.rows)) * 100);
    /**
     * ⚠ 写真の割合は**実データ**から出す（旧は「99%」を決め打ちしていた）。
     *   写真がある記録の数が渡されていればそれを使い、無ければ「写真はほとんど撮れている」とだけ言う。
     */
    const shotPct = m.shotRows != null && m.rows > 0 ? Math.round((m.shotRows / m.rows) * 100) : null;
    questions.push({
      q: shotPct != null
        ? `写真は${shotPct}%撮れているのに、そこから学べているのは${opsPct}%だけです。この差をどう扱いますか？`
        : `写真から学べているのは${opsPct}%だけです。この差をどう扱いますか？`,
      options: ["まず録画の経路を直す（推奨）", "写真から読む仕組みを先に作る", "今のままでよい"],
      why: "材料が無いまま点数だけ上がると、『学べている』と誤解する",
    });
  }
  if (m.opens > 0 && m.guessedOpens >= m.opens) {
    questions.push({
      q: "「押したら何が開くか」が全部推測です。点数に入れてよいですか？",
      options: ["実測だけを点にする（推奨）", "推測も半分の点にする", "推測でも今のままでよい"],
      why: "推測を実測と同じ重さにすると、実際には学べていないのに高得点になる",
    });
  }
  if (siteKeys.length === 1 && m.site === "all") {
    questions.push({
      q: `${siteKeys[0]} だけで、もう片方のサイトの記録がありません。どうしますか？`,
      options: ["もう片方も運用する", "片方だけを対象にする（推奨）", "様子を見る"],
      why: "サイトごとに手順が違うので、片方の学びをもう片方で使うと誤適用になる",
    });
  }
  if (!questions.length && m.actions.length) {
    questions.push({
      q: "次に直すのは「" + m.actions[0].what + "」でよいですか？",
      options: ["それで進める（推奨）", "別の物を先に"],
      why: m.actions[0].why || "",
    });
  }

  agenda.sort((a, b) => a.priority - b.priority);
  return { today, agenda: agenda.slice(0, 6), questions: questions.slice(0, 4), evidence };
}

function num(v: unknown): number {
  const n = typeof v === "number" ? v : Number(v);
  return Number.isFinite(n) && n > 0 ? n : 0;
}
