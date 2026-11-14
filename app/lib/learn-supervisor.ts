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

/**
 * 2026-11-14 竹内さん「所在地での検索の動かし方や、物件の取得、次のページへの移動の仕方で
 *   統括が弱い部分の学習を強化する」「これらの思考や考え方は統括の部分で重要な考え方にする」:
 *   場面の名前（日本語）と、場面ごとの手順の読み上げを**統括の言葉**として使う。
 */
import { SCENE_JA, describeSceneFlow, findWeakScenes, type SceneFlow } from "./learn-flow-steps";
export { SCENE_JA };

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
   * 2026-11-14 竹内さん「足りていない部分や弱い部分はきょうかするようにする」:
   *   **同じ画面が続いている**記録（`same_runs`）。多ければ**撮影の仕組みが壊れている**疑い。
   */
  same_runs?: { n: number; max_same: number } | null;
  /**
   * 2026-11-14 竹内さん「画像のメモリも重ければ容量小さくする。統括がこのような部分もはんだんできるようにする」:
   *   **写真の容量と枚数**。1枚が大きすぎる・合計が重すぎる時に言えるようにする。
   */
  shot_bytes?: { n: number; total_bytes: number; max_bytes: number } | null;
  /**
   * 2026-11-14 竹内さん
   *   「時間でみたらよい最大７分の録画なので順番に見れば理解できる」
   *   「所在地での検索の動かし方や、物件の取得、次のページへの移動の仕方で統括が弱い部分の学習を強化する」
   *   「これらの思考や考え方は統括の部分で重要な考え方にする。そして強化する」
   *
   *   **場面ごとの手順**（`app/lib/learn-flow-steps.ts` の `learnSceneFlows` の結果）。
   *   ⚠ 写真が1枚も取れていなくても学べる材料（`search_audits.filled.ops` に人の順番が残っている）。
   *     実測: 7日で 56件中32件に押した順番があり、所在地17回・条件18回・駅14回・検索18回・物件16回。
   */
  scene_flows?: Array<{
    scene: import("./learn-flow-steps").FlowScene;
    runs: number;
    ops: number;
    raw_ops?: number;
    steps: string[];
    variants: number;
    gap_ms: number | null;
  }> | null;
  /** 手本が1件も無い場面の数（「学べていない」と言うため） */
  scene_missing?: number;
  /** 手本が無い場面の名前（日本語・読点区切り） */
  scene_missing_names?: string;
  /** 止まった回が一番多い場面（`search_audits` の status が finished でない回の最後の場面） */
  stopped_scene?: string | null;
  /**
   * 2026-11-14 竹内さん「また今日強化されたら『強化した』と統括に保存しておくようにする」:
   *   **今日なにを強化したか**（`learn_improvements` の集計）。
   *   ⚠ 判断の材料ではなく**実績**（点は上げない・効いたかは数字で確かめる）。
   */
  improvements?: { total: number; by_area: Array<{ area: string; n: number }> } | null;
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
    /**
     * 2026-11-14 竹内さん「必要な部分を統括が判断して学習すれば強化される」:
     *   **統括が決めた「次に学ぶ事」**（優先順・費用つき）。
     *   `supervisor-do` がこれを読んで上から実行する（竹内さんが毎回指図しなくてよい形）。
     *   ⚠ `photo_learn` は1枚ごとに費用がかかるので `limit` を必ず付ける。
     */
    learning_tasks?: Array<{ kind: string; what: string; why: string; cost: string; limit?: number }>;
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
  } else if (withOps > 0 && rows > 0 && withOps / rows < 0.1) {    actions.push({
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
  /**
   * 2026-11-14 竹内さん「足りていない部分や弱い部分はきょうかするようにする」:
   *   **同じ画面が続いている**＝撮影の仕組みが壊れている疑い（学びが増えない一番の原因）。
   */
  const sr = inp.same_runs && typeof inp.same_runs === "object" ? inp.same_runs : null;
  if (sr && num(sr.max_same) >= 5) {
    actions.push({
      priority: 0,
      what: "同じ画面の写真が続いている（撮影がおかしい）",
      why: `同じ画像が最大 ${num(sr.max_same)}枚続いた（${num(sr.n)}回）`,
      how: "撮る前にリアプロのタブを前に出しているか確かめる（別のタブを撮っている疑い）／画面が本当に止まっていないか見る",
    });
  }
  /**
   * 2026-11-14 竹内さん「画像のメモリも重ければ容量小さくする」:
   *   **1枚が大きすぎる**／**合計が重すぎる**時に、容量を落とすよう言う。
   *   ⚠ 1枚 200KB 超は重い（今は 11KB なので問題ない＝基準を超えた時だけ言う）。
   */
  const sb = inp.shot_bytes && typeof inp.shot_bytes === "object" ? inp.shot_bytes : null;
  if (sb && num(sb.n) > 0) {
    const maxKb = Math.round(num(sb.max_bytes) / 1024);
    const totalMb = Math.round((num(sb.total_bytes) / (1024 * 1024)) * 10) / 10;
    if (maxKb > 200) {
      actions.push({
        priority: 1,
        what: "写真1枚が重い",
        why: `1枚 ${maxKb}KB（目安 200KB 以下）`,
        how: "撮る時の長辺と品質を下げる（`SHOT_SEND_SIDE` / `SHOT_SEND_Q`）",
      });
    } else if (totalMb > 50) {
      actions.push({
        priority: 2,
        what: "写真の合計が重い",
        why: `合計 ${totalMb}MB（${num(sb.n)}枚）`,
        how: "残す枚数を減らす／古い写真を消す",
      });
    }
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
      /** 2026-11-14: 同じ画面の続き・写真の容量 */
      sameRuns: sr,
      shotBytes: sb,
      /**
       * 2026-11-14 竹内さん「所在地での検索の動かし方や、物件の取得、次のページへの移動の仕方で
       *   統括が弱い部分の学習を強化する」「これらの思考や考え方は統括の部分で重要な考え方にする」:
       *   **場面ごとの手順**を統括の議題・根拠に使う。
       */
      scene_flows: Array.isArray(inp.scene_flows) ? (inp.scene_flows as SceneFlow[]) : null,
      scene_missing: num(inp.scene_missing),
      scene_missing_names: typeof inp.scene_missing_names === "string" ? inp.scene_missing_names : "",
      stopped_scene: typeof inp.stopped_scene === "string" ? inp.stopped_scene : null,
      /** 2026-11-14 竹内さん「強化したら統括に保存しておく」: 今日の強化の実績（点は上げない） */
      improvements: inp.improvements && typeof inp.improvements === "object"
        ? { total: num(inp.improvements.total), by_area: Array.isArray(inp.improvements.by_area) ? inp.improvements.by_area : [] }
        : null,
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
  /** 2026-11-14: 同じ画面が続いた記録 / 写真の容量 */
  sameRuns?: { n: number; max_same: number } | null;
  shotBytes?: { n: number; total_bytes: number; max_bytes: number } | null;
  /** 写真がある記録の数（写真の割合を実データから出すため） */
  shotRows?: number;
  /**
   * 2026-11-14 竹内さん「所在地での検索の動かし方や、物件の取得、次のページへの移動の仕方で
   *   統括が弱い部分の学習を強化する」「これらの思考や考え方は統括の部分で重要な考え方にする」:
   *   **場面ごとの手順**（人が実際に押した順）と、手本が無い場面・止まった場面。
   */
  scene_flows?: SceneFlow[] | null;
  scene_missing?: number;
  scene_missing_names?: string;
  stopped_scene?: string | null;
  /** 2026-11-14: 今日の強化の実績（点は上げない・根拠に出すだけ） */
  improvements?: { total: number; by_area: Array<{ area: string; n: number }> } | null;
}): SupervisorAdvice["meeting"] {
  const num = (v: unknown): number => {
    const n = typeof v === "number" ? v : Number(v);
    return Number.isFinite(n) && n > 0 ? n : 0;
  };
  const who = m.site === "all" ? "全体" : m.site;
  const today: string[] = [];
  const agenda: SupervisorAdvice["meeting"]["agenda"] = [];
  /** 2026-11-14: 統括が決めた「次に学ぶ事」（`supervisor-do` が上から実行する） */
  let learning_tasks: Array<{ kind: string; what: string; why: string; cost: string; limit?: number }> = [];
  const questions: SupervisorAdvice["meeting"]["questions"] = [];
  const evidence: SupervisorAdvice["meeting"]["evidence"] = [];

  // ── 根拠（数字）──
  evidence.push({ label: "結論", value: `${HEAD[m.verdict]}（材料 ${m.coverage}/100・弱い所 ${m.weakN}件）` });
  /**
   * 2026-11-14 竹内さん「また今日強化されたら『強化した』と統括に保存しておくようにする」:
   *   **今日なにを強化したか**を統括が言えるようにする（根拠に出す）。
   *   ⚠ これは判断の材料ではなく**実績の記録**。数が増えても材料の点は上げない
   *     （「直したから賢くなった」と自動で決めない・効いたかは数字で確かめる）。
   */
  if (m.improvements && m.improvements.total > 0) {
    const by = m.improvements.by_area.map((x) => `${x.area} ${x.n}`).join("・");
    evidence.push({ label: "今日の強化", value: `${m.improvements.total}件（${by}）` });
  }
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
   * 2026-11-14 竹内さん
   *   「時間でみたらよい最大７分の録画なので順番に見れば理解できる」
   *   「所在地での検索の動かし方や、物件の取得、次のページへの移動の仕方で統括が弱い部分の学習を強化する」
   *   「これらの思考や考え方は統括の部分で重要な考え方にする。そして強化する」
   *
   *   → **場面ごとの手順**（`search_audits.filled.ops` の人の実測）を根拠に出す。
   *     ⚠ これは統括の**中心の考え方**にする:
   *       ① 手順は「場面」に分けて持つ（所在地・条件・検索・物件の取得・次のページ）
   *       ② 人の実測を手本にする（機械の動きは混ぜない）
   *       ③ **手本が無い場面**は「学べていない」と言う（できない事をできると言わない）
   *       ④ 順番が毎回違う場面は「迷い」と見て、決まりにする提案をする
   */
  const flows = Array.isArray(m.scene_flows) ? m.scene_flows : null;
  if (flows && flows.length) {
    for (const f of flows.slice(0, 6)) {
      evidence.push({ label: `場面: ${SCENE_JA[f.scene]}`, value: describeSceneFlow(f).replace(`${SCENE_JA[f.scene]}: `, "") });
    }
  }
  if (typeof m.scene_missing === "number" && m.scene_missing > 0) {
    evidence.push({ label: "手本が無い場面", value: `${m.scene_missing}場面（${String(m.scene_missing_names ?? "").trim() || "－"}）` });
  }
  if (typeof m.stopped_scene === "string" && m.stopped_scene) {
    evidence.push({ label: "止まった回が多い場面", value: m.stopped_scene });
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
  /**
   * 2026-11-14 竹内さん「画像のメモリも重ければ容量小さくする。統括がこのような部分もはんだんできるようにする」:
   *   写真の容量と、同じ画面が続いた回数を根拠に出す。
   */
  if (m.shotBytes && num(m.shotBytes.n) > 0) {
    const maxKb = Math.round(num(m.shotBytes.max_bytes) / 1024);
    const totalMb = Math.round((num(m.shotBytes.total_bytes) / (1024 * 1024)) * 10) / 10;
    evidence.push({ label: "写真", value: `${num(m.shotBytes.n)}枚・1枚 最大${maxKb}KB・合計 ${totalMb}MB` });
  }
  if (m.sameRuns && num(m.sameRuns.max_same) > 0) {
    evidence.push({ label: "同じ画面の続き", value: `最大 ${num(m.sameRuns.max_same)}枚（${num(m.sameRuns.n)}回）` });
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
    /**
     * 2026-11-14 竹内さん「ちゃんと判断できるようになっているか」:
     *   ⚠ `opens`（押したら何が開くか）が `parts` に入っていなかったので、
     *     `delta` が `opens` だけ動いた時に**「前回から」が出なかった**（実測: opens -13 なのに黙っていた）。
     *   → 5つ全部を出す（記録・順番・場所・開き方・弱い所）。
     */
    if (d.opens) parts.push(`開き方${d.opens > 0 ? "+" : ""}${d.opens}`);
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
   * 2026-11-14 竹内さん
   *   「所在地での検索の動かし方や、物件の取得、次のページへの移動の仕方で統括が弱い部分の学習を強化する」
   *   「これらの思考や考え方は統括の部分で重要な考え方にする。そして強化する」
   *
   *   → **場面ごと**に手本があるかを見る。手本が無い場面があれば、それが一番の弱い所
   *     （できない事を「学べている」と言わない）。
   *   ⚠ 優先度は高め（1）だが「止まっている」（0）より後ろ。止まるのを直さないと手本が増えない。
   */
  /**
   * 2026-11-14 竹内さん
   *   「所在地での検索の動かし方や、物件の取得、次のページへの移動の仕方で統括が弱い部分の学習を強化する」
   *   「これらの思考や考え方は統括の部分で重要な考え方にする。そして強化する」
   *
   *   → **場面ごと**に手本があるかを見る。手本が無い場面があれば、それが一番の弱い所。
   *
   *   ⚠ 2026-11-14 テストで発覚: 優先度2に置いたら、既存の議題（優先度0〜1が4件）に
   *     押し出されて**画面から消えていた**（`agenda.slice(0, 6)`・`questions.slice(0, 4)`）。
   *     「順番が毎回違う＝迷い」は**実際に人が迷っている**という一番確かな材料なので、
   *     手本が無い場面と同じ優先度1にする。
   */
  {
    const sf = Array.isArray(m.scene_flows) ? (m.scene_flows as SceneFlow[]) : [];
    /**
     * ⚠ 場面の材料が**1件も無い**時は「手本が無い」と言わない（分からないだけ）。
     *   `search_audits` に押した順番が入っていないと全場面が no_example になり、
     *   実際には人がやっているのに「学べていない」と言ってしまう（テストで発覚）。
     *   → **1場面でも手本がある時だけ**、無い場面を名指しする。
     */
    const weakScenes = sf.length ? findWeakScenes(sf) : [];
    const missing = weakScenes.filter((w) => w.kind === "no_example");
    const unstable = weakScenes.filter((w) => w.kind === "unstable");
    if (missing.length) {
      const names = missing.map((w) => SCENE_JA[w.scene]);
      agenda.push({
        priority: 1,
        topic: "手本が無い場面がある（そこは学べていない）",
        why: `${names.join("・")}の手本がありません（人がまだ1回もやっていない／記録できていない）`,
        decide: "その場面を人が1回やる（記録の経路も同時に確かめる）／今のままでよいか",
      });
      questions.push({
        q: `${names.join("・")}の手本が1件もありません。どれから増やしますか？`,
        options: [
          // 無い場面を全部出す（多い時は3つまで）＝竹内さんが選べる
          ...names.slice(0, 3).map((n, i) => `${n}を人が1回やる${i === 0 ? "（推奨）" : ""}`),
          "記録の経路（操作がDBに届くか）を先に直す",
          "今のままでよい",
        ],
        why: "手本が無い場面は自動にできません（推測で動かすと現場が壊れる）",
      });
    }
    if (unstable.length) {
      const u = unstable[0];
      agenda.push({
        priority: 1,
        topic: `${SCENE_JA[u.scene]}の順番が毎回違う（迷いの疑い）`,
        why: u.why,
        decide: `${u.next}／今のままでよいか`,
      });
      questions.push({
        q: `${SCENE_JA[u.scene]}の順番が毎回違います。決まりにしますか？`,
        options: [
          `一番多い順番を決まりにする（推奨）`,
          "人がもう数回やってから決める",
          "今のままでよい",
        ],
        why: "順番が毎回違う＝迷っている疑い。決まりにすると自動でも同じ順で動ける",
      });
    }
  }
  /**
   * 2026-11-14 竹内さん「所在地での検索の動かし方…弱い部分の学習を強化する」:
   *   **実際に止まった場面**（`abandoned` の最後の場面）が分かっていれば、それを名指しする。
   *   ⚠ 「完走率が低い」だけより**どこで止まるか**が分かる方が直せる。
   */
  if (typeof m.stopped_scene === "string" && m.stopped_scene) {
    agenda.push({
      priority: 1,
      topic: `止まる回が多いのは「${m.stopped_scene}」`,
      why: `途中で止まった回の最後の場面は ${m.stopped_scene} が一番多い`,
      decide: `${m.stopped_scene}の動かし方を直す（手本と違う所を探す）／今のままでよいか`,
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
  /**
   * 2026-11-14 竹内さん「必要な部分を統括が判断して学習すれば強化される」:
   *   統括が**自分で「次に何を学ぶか」を決める**（竹内さんが毎回指図しなくてよい形）。
   *
   *   ⚠ 決める材料は**実データだけ**:
   *     ・写真はあるのに `shot_learn` が0件 → **写真から読む**（弱い所の写真だけ・費用は1枚ごと）
   *     ・手本が無い場面がある → **人が1回やる**（推測で動かさない）
   *     ・止まる場面がある → **その場面の手本と違う所を探す**
   *   ⚠ 費用がかかる物（Vision）は**枚数の上限**を必ず付ける。
   *   → 判断を `learning_tasks` として残す（`supervisor-do` が上から実行できる）。
   */
  {
    const tasks: Array<{ kind: string; what: string; why: string; cost: string; limit?: number }> = [];
    const shotPct = m.shotRows != null && m.rows > 0 ? Math.round((m.shotRows / m.rows) * 100) : null;
    const opsPct = m.rows > 0 ? Math.round((m.withOps / Math.max(1, m.rows)) * 100) : 0;
    /**
     * ① 写真から読む（一番効く・写真はもう撮れている）。
     *   ⚠ 「写真がある割合」と「学べている割合」の**差が大きい時だけ**（差が小さい時に走らせても意味がない）。
     */
    if (shotPct != null && shotPct >= 50 && opsPct < 60) {
      tasks.push({
        kind: "photo_learn",
        what: "弱い所の写真から、欄の種類（プルダウン／入力／チェック）を読む",
        why: `写真は${shotPct}%あるのに、操作が付いているのは${opsPct}%（写真から読む処理が一度も走っていない・実測 shot_learn 0件）`,
        cost: "1枚ごとに Vision の費用（上限あり）",
        limit: 20,
      });
    }
    /** ② 手本が無い場面（推測で動かさない） */
    if (typeof m.scene_missing === "number" && m.scene_missing > 0) {
      tasks.push({
        kind: "need_human",
        what: `${String(m.scene_missing_names || "").trim() || "手本が無い場面"}を人が1回やる`,
        why: "手本が無い場面は自動にできない（推測で動かすと現場が壊れる）",
        cost: "無料（人の手間だけ）",
      });
    }
    /** ③ 止まる場面（一番現場に効く） */
    if (typeof m.stopped_scene === "string" && m.stopped_scene) {
      tasks.push({
        kind: "fix_scene",
        what: `「${m.stopped_scene}」で止まる原因を、手本と比べて探す`,
        why: `途中で止まった回の最後の場面は「${m.stopped_scene}」が一番多い`,
        cost: "無料",
      });
    }
    /** ④ 録画の経路（操作が届いていない） */
    if (m.rows > 0 && m.withOps / m.rows < 0.3 && (!shotPct || shotPct < 50)) {
      tasks.push({
        kind: "fix_record",
        what: "録画の記録（押した操作）がDBに届くようにする",
        why: `記録 ${m.rows}件のうち操作が付いているのは ${m.withOps}件（${opsPct}%）`,
        cost: "無料",
      });
    }
    /**
     * ⚠ 優先順位: 無料で効く物を先に・お金がかかる物は後ろ。
     *   （竹内さんが「費用をかけてよい」と言った時だけ写真を読む、という順番にする）
     */
    const rank: Record<string, number> = { fix_scene: 0, need_human: 1, fix_record: 2, photo_learn: 3 };
    tasks.sort((a, b) => (rank[a.kind] ?? 9) - (rank[b.kind] ?? 9));
    if (tasks.length) {
      agenda.push({
        priority: 1,
        topic: "次に学ぶ事（統括が決めた順）",
        why: tasks.map((t, i) => `${i + 1}. ${t.what}（${t.cost}）`).join(" / "),
        decide: tasks[0].kind === "photo_learn"
          ? "写真から読む（費用がかかる）／無料の物を先にやるか"
          : `${tasks[0].what} から進めるか`,
      });
    }
    /**
     * ⚠ 課題そのものは**会議の結果に載せる**（議題の文だけだと、実行する側が
     *   「何を・どの順で・いくらで」を取り出せない）。`supervisor-do` がこれを読んで実行する。
     */
    learning_tasks = tasks;
  }

  // ── 竹内さんに聞く事 ──
  if (m.rows > 0 && m.withOps / m.rows < 0.3) {
    const opsPct = Math.round((m.withOps / Math.max(1, m.rows)) * 100);
    /**
     * ⚠ 写真の割合は**実データ**から出す（旧は「99%」を決め打ちしていた）。
     *   写真がある記録の数が渡されていればそれを使い、無ければ「写真はほとんど撮れている」とだけ言う。
     */
    const shotPct = m.shotRows != null && m.rows > 0 ? Math.round((m.shotRows / m.rows) * 100) : null;
    /**
     * 2026-11-14 竹内さん「必要な部分を統括が判断して学習すれば強化される」:
     *   ⚠ 旧の選択肢は「まず録画の経路を直す」「写真から読む仕組みを先に作る」だった。
     *     だが**写真から読む仕組みはもう作った**（`shot_learn_server`。作ってあるのに
     *     呼ぶ所が0箇所だったのを繋いだ）。だから選択肢が古い。
     *   → 統括が**自分で判断して走らせられる**形にする:
     *     「弱い所の写真だけ読む（費用は1枚ごと）」を第一の選択肢にする。
     *     `photo_learn` を action に載せ、`supervisor-do` がそのまま実行できるようにする。
     */
    questions.push({
      q: shotPct != null
        ? `写真は${shotPct}%撮れているのに、そこから学べているのは${opsPct}%だけです。弱い所の写真だけ読みますか？`
        : `写真から学べているのは${opsPct}%だけです。弱い所の写真だけ読みますか？`,
      options: ["弱い所の写真だけ読む（推奨・1枚ごとに費用）", "まず録画の経路を直す", "今のままでよい"],
      why: "写真は撮れているのに、写真から欄の種類を読む処理が一度も走っていない（実測0件）",
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
  return { today, agenda: agenda.slice(0, 6), questions: questions.slice(0, 4), evidence, learning_tasks };
}

function num(v: unknown): number {
  const n = typeof v === "number" ? v : Number(v);
  return Number.isFinite(n) && n > 0 ? n : 0;
}
