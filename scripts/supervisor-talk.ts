/**
 * 統括と会話する（2026-11-14 竹内さん「ここでの俺との会話は統括とはなせるように」）
 *
 *   `npx tsx --env-file=.env.local scripts/supervisor-talk.ts`
 *     → 統括が**今の判断を話す**（議題・根拠・竹内さんへの質問）
 *
 *   `npx tsx --env-file=.env.local scripts/supervisor-talk.ts "質問"`
 *     → 質問に**DBの実データを見て**答える
 *
 *   `--scope=realpro` / `--scope=itandi` でサイト別
 *   `--history=10` で推移も話す
 *
 * ⚠ 統括は**DBの数字しか根拠にしない**（推測は「推測」と言う）。
 *   決められない事は「竹内さんに聞く」として questions に出す。
 */
import { recentSupervisorLogs } from "../app/lib/learn-supervisor-db";

const BASE = process.env.AUDIT_BASE || "https://sumora-ai-ui.vercel.app";

type Adv = {
  verdict?: string;
  headline?: string;
  score?: { coverage?: number; weak?: number; delta?: { rows: number; next: number; points: number; opens: number; weak: number } | null };
  actions?: Array<{ priority: number; what: string; why?: string; how?: string; name?: string }>;
  block?: string | null;
  /** 統括が自分の判断を点検した結果 */
  self_check?: { ok?: boolean; issues?: string[]; capped_by?: string | null };
  meeting?: {
    today?: string[];
    agenda?: Array<{ priority: number; topic: string; why: string; decide: string }>;
    questions?: Array<{ q: string; options?: string[]; why: string }>;
    evidence?: Array<{ label: string; value: string; guessed?: boolean }>;
  };
};

const args = process.argv.slice(2);
const scopeArg = (args.find((a) => a.startsWith("--scope=")) || "").replace("--scope=", "") || "all";
const histArg = Number((args.find((a) => a.startsWith("--history=")) || "").replace("--history=", "")) || 0;
const question = args.filter((a) => !a.startsWith("--")).join(" ").trim();

function line(s = "") { console.log(s); }
function hr() { console.log("─".repeat(66)); }

async function fetchAdv(scope: string): Promise<{ adv: Adv | null; bundle: Record<string, unknown> | null; err?: string }> {
  try {
    const r = await fetch(BASE + "/api/human-learn-profile?fresh=1&scope=" + encodeURIComponent(scope), { cache: "no-store" });
    if (!r.ok) return { adv: null, bundle: null, err: "http_" + r.status };
    const j = (await r.json()) as Record<string, unknown>;
    const b = (j.bundle ?? null) as Record<string, unknown> | null;
    if (!b) return { adv: null, bundle: null, err: "束がありません" };
    if (scope === "all") return { adv: (b.supervisor as Adv) || null, bundle: b };
    const bySite = (b.supervisor_by_site ?? {}) as Record<string, Adv>;
    return { adv: bySite[scope] || null, bundle: b };
  } catch (e) {
    return { adv: null, bundle: null, err: String((e as Error).message || e) };
  }
}

/** 統括の話（判断・議題・根拠・質問） */
function speak(scope: string, adv: Adv, bundle: Record<string, unknown>) {
  const who = scope === "all" ? "全体" : scope;
  const m = adv.meeting || {};
  const sc = (adv as Record<string, unknown>).self_check as { ok?: boolean; issues?: string[]; capped_by?: string | null } | undefined;
  hr();
  line(`【統括】${who}`);
  hr();

  /**
   * 2026-11-14 竹内さん「矛盾の部分なんで統括が整理したらよい」:
   *   **矛盾があれば最初に言う**（結論より先に）。都合よく隠さない。
   */
  if (sc && Array.isArray(sc.issues) && sc.issues.length) {
    line();
    line("■ ⚠ 自分の判断の矛盾（先に言います）");
    for (const s of sc.issues) line("  ・" + s);
    if (sc.capped_by) line("  → 整理: " + sc.capped_by);
    line();
  }

  line();
  line("■ 今日の結論");
  for (const t of (m.today && m.today.length ? m.today : [String(adv.headline || "")])) line("  " + t);
  if (adv.block) { line(); line("  ⚠ " + adv.block); }

  line();
  line("■ 根拠（DBの実データ）");
  const ev = m.evidence || [];
  if (ev.length) {
    for (const e of ev) line(`  ・${e.label}: ${e.value}${e.guessed ? "  ← 推測" : ""}`);
  }
  /**
   * ⚠ 本番の束がまだ新しい形（meeting）で作られていない場合がある。
   *   → その時は**束の数字から自分で根拠を作る**（「根拠がありません」で終わらせない）。
   */
  const src0 = (bundle.source ?? {}) as Record<string, unknown>;
  const rows0 = Number(src0.rows) || 0;
  const withOps0 = Number(src0.with_ops) || 0;
  const sc0 = (adv.score ?? {}) as { coverage?: number; weak?: number };
  if (!ev.length) {
    line(`  ・結論: ${String(adv.headline || "-")}（材料 ${sc0.coverage ?? 0}/100・弱い所 ${sc0.weak ?? 0}件）`);
    line(`  ・記録: ${rows0}件（操作の並びが付いている ${withOps0}件）`);
  }
  // 束から拾える物も出す（統括の判断に無い数字）
  const src = (bundle.source ?? {}) as Record<string, unknown>;
  const withOps = Number(src.with_ops);
  const rows = Number(src.rows);
  if (Number.isFinite(withOps) && Number.isFinite(rows) && rows > 0) {
    line(`  ・操作の並びが付いている記録: ${withOps} / ${rows}（${Math.round((withOps / rows) * 100)}%）`);
  }
  const shots = (bundle.shots ?? {}) as Record<string, unknown>;
  if (shots.total != null) line(`  ・写真: ${String(shots.total)}枚（操作つき ${String(shots.with_ops)}枚）`);

  line();
  line("■ 議題（決めたい事）");
  const ag = m.agenda || [];
  /**
   * ⚠ 本番の束がまだ meeting を持っていない時は、**数字から議題を作る**
   *   （「決める事はありません」と言ってしまうと、本当の穴を見落とす）。
   */
  if (!ag.length) {
    const rows1 = Number(((bundle.source ?? {}) as Record<string, unknown>).rows) || 0;
    const withOps1 = Number(((bundle.source ?? {}) as Record<string, unknown>).with_ops) || 0;
    const pct1 = rows1 ? Math.round((withOps1 / rows1) * 100) : 0;
    let said = false;
    if (rows1 > 0 && pct1 < 30) {
      line("  ・写真は撮れているのに、操作が付いていない");
      line(`      なぜ: 記録 ${rows1}件のうち、操作の並びが付いているのは ${withOps1}件（${pct1}%）`);
      line("      決める事: 操作を付ける仕組みを直す（録画の経路）／このままでよいか");
      said = true;
    }
    if (!said) line("  ・追加で決める事はありません");
  }
  for (const a of ag) {
    line(`  ・${a.topic}`);
    if (a.why) line(`      なぜ: ${a.why}`);
    if (a.decide) line(`      決める事: ${a.decide}`);
  }

  line();
  line("■ 竹内さんに聞きたい事");
  const qs = m.questions || [];
  if (!qs.length) line("  ・いまはありません");
  for (const q of qs) {
    line(`  ・${q.q}`);
    if (q.why) line(`      なぜ聞くか: ${q.why}`);
    if (Array.isArray(q.options) && q.options.length) line(`      選択肢: ${q.options.join(" / ")}`);
  }

  line();
  line("■ 次にやる事（私がやる順）");
  const acts = adv.actions || [];
  if (!acts.length) line("  ・追加で強化する所は無し（このまま録画を続ける）");
  for (const a of acts.slice(0, 6)) {
    line(`  ${a.priority}. ${a.what}${a.name ? `（${a.name}）` : ""}`);
    if (a.how) line(`      → ${a.how}`);
  }
  hr();
}

/** 質問に答える（DBの数字だけを根拠にする） */
function answer(q: string, scope: string, adv: Adv, bundle: Record<string, unknown>) {
  const who = scope === "all" ? "全体" : scope;
  const s = adv.score || {};
  const m = adv.meeting || {};
  const src = (bundle.source ?? {}) as Record<string, unknown>;
  const rows = Number(src.rows) || 0;
  const withOps = Number(src.with_ops) || 0;
  const pct = rows ? Math.round((withOps / rows) * 100) : 0;
  const t = q.toLowerCase();

  hr();
  line(`【統括】${who}`);
  line(`  ご質問: ${q}`);
  hr();

  const say = (s2: string) => line("  " + s2);

  // ① 学べているか
  if (/学べ|できてる|できている|強化|反映/.test(q)) {
    say(`結論: ${String(adv.headline || "")}`);
    say(`材料の揃い ${s.coverage ?? 0}/100・弱い所 ${s.weak ?? 0}件・記録 ${rows}件`);
    say(`記録のうち操作の並びが付いているのは ${withOps}件（${pct}%）`);
    if (rows > 0 && pct < 30) {
      say("");
      say("⚠ ここが一番の穴です。写真は撮れているのに、そこから学べている量が少ない。");
      say("  → 「写真から学ぶ」を先に直すべきか、録画の経路を直すべきか、決めてもらう必要があります。");
    }
    return;
  }
  // ② なぜ点数が高い／低い
  if (/なぜ|なんで|理由|点数|スコア|coverage/.test(q) || /85|28/.test(q)) {
    say(`材料の揃いの内訳（配点）:`);
    const ev = m.evidence || [];
    for (const e of ev) if (!e.guessed) say(`  ・${e.label}: ${e.value}`);
    say("");
    say("配点: 押す順番25点・押す場所25点・開き方15点・画面の手順15点・材料つき記録20点");
    if (rows > 0 && pct < 30) say(`⚠ 材料つき記録が ${pct}% なのに満点に近い → 配点の重みが実態に合っていない可能性があります`);
    return;
  }
  // ③ 次に何を
  if (/次|なにを|何を|優先|やる/.test(q)) {
    const acts = adv.actions || [];
    if (!acts.length) say("追加で強化する所は無し（このまま録画を続ける）");
    for (const a of acts.slice(0, 5)) say(`${a.priority}. ${a.what}${a.name ? `（${a.name}）` : ""} → ${a.how || ""}`);
    return;
  }
  // ④ サイト別
  if (/itandi|リアプロ|realpro|サイト/.test(t)) {
    say("サイト別の判断は --scope=realpro / --scope=itandi で聞いてください。");
    say("（サイトごとに手順が違うので、混ぜて判断しません）");
    return;
  }
  // ⑤ 危ないか
  if (/危|止め|だめ|大丈夫|安全/.test(q)) {
    /**
     * 2026-11-14 竹内さん「並び替えが失敗して印刷用PDFを押す前に止まっていた。押さない設計が現場を止めていた」
     *   → ⚠ **統括の答えが矛盾して見えた**（実測）:
     *       「いまのところ、自動に渡して危ない状態ではありません。」
     *       「結論: まだ学べていません（自動に渡すと危ない）」
     *     原因: **2つは別の軸**なのに続けて出していた。
     *       ・`block`    … 危険だから**止める**理由（本当に危ない時だけ入る）
     *       ・`verdict`  … 学びが足りるか（ready / almost / not_yet / unsafe）
     *     「止めてはいない」と「まだ学べていない」は両立する（止めないが渡すのは早い）。
     *   → **軸を分けて言う**（混ぜない・矛盾に見せない）。
     */
    const blocked = !!adv.block;
    const verdict = String(adv.verdict || "");
    say(blocked
      ? `⚠ 自動を止めています: ${adv.block}`
      : "自動は止めていません（危ない状態ではない）。");
    say(`ただし、学びの結論は「${String(adv.headline || verdict)}」です。`);
    if (!blocked && (verdict === "not_yet" || verdict === "almost")) {
      say("※「止めていない」と「渡してよい」は別です。止めないのは現場を止めないためで、自動に渡すのはまだ早い、という意味です。");
    }
    return;
  }
  // ⑥ 前回から
  if (/前回|推移|比べ|変わった|伸び/.test(q)) {
    const d = s.delta;
    if (!d) say("前回の記録がまだありません（これから溜まります）");
    else {
      say(`記録 ${d.rows >= 0 ? "+" : ""}${d.rows}・順番 ${d.next >= 0 ? "+" : ""}${d.next}・場所 ${d.points >= 0 ? "+" : ""}${d.points}・開き方 ${d.opens >= 0 ? "+" : ""}${d.opens}・弱い所 ${d.weak >= 0 ? "+" : ""}${d.weak}`);
    }
    say("※ 履歴は --history=10 で見られます（DBに毎回残しています）");
    return;
  }
  // ⑦ 打ち合わせ
  if (/打ち合わせ|会議|話|議題/.test(q)) {
    speak(scope, adv, bundle);
    return;
  }
  // ⑧ それ以外 → 判断の材料をそのまま見せる
  say("その問いには決まった答えを持っていません。いま分かっている事を出します:");
  say(`結論: ${String(adv.headline || "")}（材料 ${s.coverage ?? 0}/100・弱い所 ${s.weak ?? 0}件）`);
  const ag = m.agenda || [];
  if (ag.length) {
    say("");
    say("いま決めたい事:");
    for (const a of ag.slice(0, 3)) say(`  ・${a.topic}`);
  }
}

void (async () => {
  const { adv, bundle, err } = await fetchAdv(scopeArg);
  if (err || !adv || !bundle) {
    line(`統括の判断を取れませんでした: ${err || "判断がまだありません"}`);
    line("（学習の束がまだ作られていない可能性があります。`/api/human-learn-profile?fresh=1` を確認してください）");
    process.exitCode = 1;
    return;
  }
  if (question) answer(question, scopeArg, adv, bundle);
  else speak(scopeArg, adv, bundle);

  if (histArg > 0) {
    const h = await recentSupervisorLogs(scopeArg, histArg);
    line();
    line(`■ これまでの判断（${scopeArg}・新しい順 ${h.rows.length}件）`);
    if (h.error) line("  取れませんでした: " + h.error);
    else if (!h.rows.length) line("  まだ履歴がありません（次の判断から溜まります）");
    else {
      for (const r of h.rows) {
        const at = String(r.created_at || "").slice(0, 16).replace("T", " ");
        line(`  ${at}  ${String(r.verdict)}  材料${String(r.coverage)}/100  弱い所${String(r.weak_n)}件  記録${String(r.rows)}件（操作${String(r.with_ops)}）`);
      }
    }
  }
})();
