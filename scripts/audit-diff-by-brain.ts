// 生成した文とスタッフが実際に送った文のギャップを、今日学んだ軸で切り直す（読み取りのみ）
// 2026-09-23 竹内「学んだこと踏まえて、生成した文と実際にスタッフが送った文のギャップをLINEから学習する。
//   またブレインに必要な部分やブレインの弱い部分見つかれば共有する」
//
// 既存の scripts/audit-deleted-lines.ts は「削られた行」を頻度順に出す道具。
// ここはそれと重ならないよう、**今日測って分かった軸**で差分を切る:
//   ① AIX の型（応える型 / こちらから型・aix-scene-stats の実測）別に、スタッフがどれだけ直しているか
//   ② お客様が何時間で返してきたか（熱の高さ）別
//   ③ 成約側の会話かどうか
//   ④ ブレインの判断（tier・action・方向の有無）別 ← ここが「ブレインの弱い部分」
//   ⑤ 直しが大きい組み合わせで、実際に何を足し・何を消しているか（実物を読む）
//
// 実行: npx tsx --env-file=.env.local scripts/audit-diff-by-brain.ts [DAYS=120] [SHOW=8]
import { createClient } from "@supabase/supabase-js";
import { AIX_SCENE_STATS } from "../app/lib/aix-scene-stats";

const sb = createClient(process.env.NEXT_PUBLIC_SUPABASE_URL ?? "", process.env.SUPABASE_SERVICE_ROLE_KEY ?? process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY ?? "");
type Row = {
  created_at: string; conversation_id: string | null; customer_message: string | null;
  ai_draft: string | null; sent_reply: string | null; was_ai_used: boolean | null;
  ai_similarity: number | null; aix_action: string | null; reply_context_snapshot: Record<string, unknown> | null;
};
type Msg = { conversation_id: string; sender: string | null; text: string | null; created_at: string };
type Aix = { conversation_id: string; aix_type: string | null; created_at: string };
const WON = new Set(["closed_won", "contract", "approved", "screening", "applying"]);
const pct = (a: number, b: number) => (b === 0 ? "—" : `${((a / b) * 100).toFixed(1)}%`);
const avg = (a: number[]) => (a.length === 0 ? 0 : a.reduce((x, y) => x + y, 0) / a.length);
/** 印（本当の書き直しではない）を除く。設計知見「質の指標を出す時はこの印を除く」 */
const MARK = /^\s*(\[AIX誘導中\]|__SHOWN__|（AI返信の生成に失敗しました）|\[返信不要\])\s*$/;
/** 言い回しだけを比べる（数字・物件名・人名を潰す） */
const norm = (s: string) => s.replace(/[0-9０-９]+/g, "N").replace(/[ァ-ヶー]{3,}/g, "カ").replace(/\s+/g, "").trim();

async function page<T>(table: string, cols: string, since: string): Promise<T[]> {
  const out: T[] = [];
  for (let p = 0; p < 80; p++) {
    const { data, error } = await sb.from(table).select(cols).gte("created_at", since).order("created_at").range(p * 1000, p * 1000 + 999);
    if (error) { console.error(`${table}: ${error.message}`); break; }
    const r = (data ?? []) as T[]; out.push(...r); if (r.length < 1000) break;
  }
  return out;
}

async function main() {
  const days = Number(process.env.DAYS ?? 120);
  const SHOW = Number(process.env.SHOW ?? 8);
  const since = new Date(Date.now() - days * 86400_000).toISOString();
  const rows = await page<Row>("ai_reply_examples", "created_at, conversation_id, customer_message, ai_draft, sent_reply, was_ai_used, ai_similarity, aix_action, reply_context_snapshot", since);
  const msgs = await page<Msg>("messages", "conversation_id, sender, text, created_at", since);
  const aix = await page<Aix>("aix_usage_logs", "conversation_id, aix_type, created_at", since);
  const { data: convData } = await sb.from("conversations").select("id, status").limit(5000);
  const statusOf = new Map(((convData ?? []) as Array<{ id: string; status: string | null }>).map((c) => [c.id, (c.status ?? "").trim()]));
  const byConv = new Map<string, Msg[]>();
  for (const m of msgs) { if (!byConv.has(m.conversation_id)) byConv.set(m.conversation_id, []); byConv.get(m.conversation_id)!.push(m); }
  const aixBy = new Map<string, Aix[]>();
  for (const a of aix) { if (!aixBy.has(a.conversation_id)) aixBy.set(a.conversation_id, []); aixBy.get(a.conversation_id)!.push(a); }

  type Case = {
    used: boolean; sim: number | null; draft: string; sent: string; won: boolean;
    prevAix: string | null; mode: string; replyH: number | null;
    tier: string; action: string; hasDir: boolean;
  };
  const cases: Case[] = [];
  for (const r of rows) {
    const draft = (r.ai_draft ?? "").trim(), sent = (r.sent_reply ?? "").trim();
    if (!draft || !sent || MARK.test(draft) || MARK.test(sent)) continue;
    const conv = r.conversation_id ?? "";
    const seq = byConv.get(conv) ?? [];
    // お客様の発言（この例の元）とその直前のこちらの送信を探す
    const head = (r.customer_message ?? "").replace(/\s+/g, " ").trim().slice(0, 24);
    let replyH: number | null = null, prevAix: string | null = null;
    if (head.length >= 4) {
      for (let i = seq.length - 1; i >= 0; i--) {
        if (seq[i].sender !== "customer") continue;
        if (!(seq[i].text ?? "").replace(/\s+/g, " ").trim().startsWith(head)) continue;
        for (let j = i - 1; j >= 0; j--) {
          if (seq[j].sender === "customer") continue;
          replyH = (Date.parse(seq[i].created_at) - Date.parse(seq[j].created_at)) / 3600_000;
          prevAix = (aixBy.get(conv) ?? []).find((a) => Math.abs(Date.parse(a.created_at) - Date.parse(seq[j].created_at)) <= 3 * 60_000)?.aix_type ?? null;
          break;
        }
        break;
      }
    }
    const snap = (r.reply_context_snapshot ?? {}) as Record<string, unknown>;
    cases.push({
      used: r.was_ai_used === true, sim: r.ai_similarity, draft, sent,
      won: WON.has(statusOf.get(conv) ?? ""),
      prevAix, mode: prevAix ? (AIX_SCENE_STATS[prevAix]?.mode ?? "—") : "手打ち",
      replyH,
      tier: String(snap.tier ?? "—"),
      action: String(r.aix_action ?? snap.rawAction ?? "—"),
      hasDir: !!String(snap.brainReplyDirection ?? "").trim(),
    });
  }
  console.log(`直近${days}日: 生成と実送信が両方ある例 ${cases.length}件\n`);

  const line = (name: string, xs: Case[]) => {
    if (xs.length < 12) return "";
    const sims = xs.map((x) => x.sim).filter((v): v is number => typeof v === "number");
    return `   ${name.padEnd(28)} ${String(xs.length).padStart(5)}件 ／ そのまま送信 ${pct(xs.filter((x) => x.used).length, xs.length).padStart(7)} ／ 似ている度 ${avg(sims).toFixed(3)}`;
  };

  console.log(`① 直前に送った AIX の型別（今日の実測: 応える型は成約に近い）`);
  for (const m of ["応える", "こちらから", "手打ち", "—"]) {
    const s = line(`${m}型`, cases.filter((x) => x.mode === m)); if (s) console.log(s);
  }

  console.log(`\n② お客様が何時間で返してきたか（熱の高さ）`);
  const bands: Array<[string, (h: number) => boolean]> = [
    ["15分以内", (h) => h <= 0.25], ["15分〜1時間", (h) => h > 0.25 && h <= 1],
    ["1〜6時間", (h) => h > 1 && h <= 6], ["6〜24時間", (h) => h > 6 && h <= 24], ["1日以上", (h) => h > 24],
  ];
  for (const [n, f] of bands) {
    const s = line(n, cases.filter((x) => x.replyH !== null && f(x.replyH))); if (s) console.log(s);
  }

  console.log(`\n③ 成約側かどうか`);
  console.log(line("成約側", cases.filter((x) => x.won)));
  console.log(line("それ以外", cases.filter((x) => !x.won)));

  console.log(`\n④ ブレインの判断別（ここが弱い部分を探す所）`);
  for (const t of ["T1", "T2", "T3", "—"]) { const s = line(`tier=${t}`, cases.filter((x) => x.tier === t)); if (s) console.log(s); }
  console.log(line("ブレインの方向あり", cases.filter((x) => x.hasDir)));
  console.log(line("ブレインの方向なし", cases.filter((x) => !x.hasDir)));
  const acts = [...new Set(cases.map((x) => x.action))].sort((a, b) => cases.filter((x) => x.action === b).length - cases.filter((x) => x.action === a).length);
  for (const a of acts.slice(0, 8)) { const s = line(`action=${a}`, cases.filter((x) => x.action === a)); if (s) console.log(s); }

  // ⑤ 「そのまま送信率が低い＝質が悪い」とは限らない。直しの**大きさ**と下書きの長さで見分ける。
  //   質が悪いなら「大きく書き直し・別の文」が多いはず。個別調整なら「少し直した」が多いはず。
  console.log(`\n⑤ 直しの大きさの分布（そのまま送信率が低い理由が「質」か「個別調整」かを見分ける）`);
  const band = (sim: number | null) =>
    sim === null ? "不明" : sim >= 0.95 ? "ほぼ同じ" : sim >= 0.80 ? "少し直した" : sim >= 0.60 ? "半分書き直し" : sim >= 0.35 ? "大きく書き直し" : "別の文";
  const BANDS = ["ほぼ同じ", "少し直した", "半分書き直し", "大きく書き直し", "別の文"];
  const dist = (name: string, xs: Case[]) => {
    if (xs.length < 30) return;
    const withSim = xs.filter((x) => typeof x.sim === "number");
    const cells = BANDS.map((b) => `${b} ${pct(withSim.filter((x) => band(x.sim) === b).length, withSim.length).padStart(6)}`);
    const lens = xs.map((x) => x.draft.length);
    console.log(`   ${name.padEnd(22)} ${String(withSim.length).padStart(4)}件 ／ ${cells.join(" ／ ")} ／ 下書きの長さ中央値 ${lens.sort((a, b) => a - b)[Math.floor(lens.length / 2)]}字`);
  };
  dist("通常返信（AIXなし）", cases.filter((x) => x.action === "—"));
  for (const a of acts.filter((x) => x !== "—").slice(0, 6)) dist(a, cases.filter((x) => x.action === a));

  console.log(`\n⑥ 一番直されている組み合わせで、何を足し・何を消しているか`);
  // 直し率が高い群を選ぶ（件数が足りる物のうち そのまま送信率が最低）
  const groups: Array<{ name: string; xs: Case[] }> = [
    ...["応える", "こちらから", "手打ち"].map((m) => ({ name: `${m}型`, xs: cases.filter((x) => x.mode === m) })),
    ...["T1", "T2", "T3"].map((t) => ({ name: `tier=${t}`, xs: cases.filter((x) => x.tier === t) })),
    { name: "方向なし", xs: cases.filter((x) => !x.hasDir) },
  ].filter((g) => g.xs.length >= 30);
  // GROUP で対象を指定できる（例: GROUP=action=property_check_result_available）
  const want = (process.env.GROUP ?? "").trim();
  if (want.startsWith("action=")) {
    const a = want.slice("action=".length);
    groups.push({ name: want, xs: cases.filter((x) => x.action === a) });
  }
  const worst = want
    ? groups.find((g) => g.name === want) ?? null
    : groups.sort((a, b) =>
      (a.xs.filter((x) => x.used).length / a.xs.length) - (b.xs.filter((x) => x.used).length / b.xs.length))[0];
  if (worst) {
    console.log(`   対象: ${worst.name}（${worst.xs.length}件・そのまま送信 ${pct(worst.xs.filter((x) => x.used).length, worst.xs.length)}）`);
    const del = new Map<string, { n: number; ex: string }>();
    const add = new Map<string, { n: number; ex: string }>();
    for (const c of worst.xs.filter((x) => !x.used)) {
      const d = new Set(c.draft.split("\n").map((l) => norm(l)).filter((l) => l.length >= 6));
      const s = new Set(c.sent.split("\n").map((l) => norm(l)).filter((l) => l.length >= 6));
      for (const l of c.draft.split("\n")) { const k = norm(l); if (k.length >= 6 && !s.has(k)) { const cur = del.get(k) ?? { n: 0, ex: l.trim() }; del.set(k, { n: cur.n + 1, ex: cur.ex }); } }
      for (const l of c.sent.split("\n")) { const k = norm(l); if (k.length >= 6 && !d.has(k)) { const cur = add.get(k) ?? { n: 0, ex: l.trim() }; add.set(k, { n: cur.n + 1, ex: cur.ex }); } }
    }
    console.log(`\n   【AI が書いたのにスタッフが消した行（上位${SHOW}）】`);
    for (const [, v] of [...del].sort((a, b) => b[1].n - a[1].n).slice(0, SHOW)) console.log(`     ${String(v.n).padStart(3)}回  ${v.ex.slice(0, 66)}`);
    console.log(`\n   【AI が書かずスタッフが足した行（上位${SHOW}）】`);
    for (const [, v] of [...add].sort((a, b) => b[1].n - a[1].n).slice(0, SHOW)) console.log(`     ${String(v.n).padStart(3)}回  ${v.ex.slice(0, 66)}`);
  }
}
main().catch((e) => { console.error(e); process.exit(1); });
