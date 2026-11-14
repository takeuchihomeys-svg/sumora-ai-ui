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
  /** 写真がある記録の数（写真の割合を実データから出す） */
  shot_rows?: number;
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
      how: "写真と操作を結ぶ道（タブの取り違え・輪の長さ）を点検する",
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
  let verdict: SupervisorVerdict;
  if (withOps === 0 && rows > 0) verdict = "not_yet";   // 材料ゼロは「これから」段階（危ないの一歩手前）
  else if (block) verdict = "unsafe";
  else if (coverage >= 65 && weakN <= 5) verdict = "ready";
  else if (coverage >= 40) verdict = "almost";
  else verdict = "not_yet";

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
    meeting: buildMeeting({
      site, verdict, coverage, rows, next, points, opens, screens, sequence,
      withOps, weakN, block, actions, delta,
      /** 推測で埋めた開き方の数（実測ではない物） */
      guessedOpens: num((input as unknown as Record<string, unknown>).guessed_opens),
      siteCounts: inp.site_counts || {},
      modeCounts: inp.mode_counts || {},
      shotRows: num((input as unknown as Record<string, unknown>).shot_rows),
    }),
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
  /** 写真がある記録の数（写真の割合を実データから出すため） */
  shotRows?: number;
}): SupervisorAdvice["meeting"] {
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
