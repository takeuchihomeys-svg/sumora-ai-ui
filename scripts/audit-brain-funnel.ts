// ブレインは「申込までの順番」を分かっていて、ゴールに向かって誘導しているか（読み取りのみ）
//
// 2026-09-23 竹内「契約とか申込とか内覧とか見積とかの違いや場面について理解しているのかな
//   どんな順番で申込まで誘導できるかも／ブレインはちゃんとゴールに向かってやっているのか長期的な思考も持って」
//
// 【測り方】4つの物差しで、成約データ（申込以降まで進んだ会話）とブレインの記録を突き合わせる。
//   ① 成約会話で AIX が押される順番（初出の平均順位）→ プロンプトの「黄金フロー」と合っているか
//   ② ブレインの次の一手（brain_decision_logs.suggested_action）と、スタッフが実際に押した AIX の段階差
//   ③ DB の conversations.status と、ブレイン自身の段階（brain_strategy.checkpoint_stage）のずれ
//   ④ 段階ごとの締め（申込へ／内覧へ）を、実送信と AI の下書きで比べる（全体と成約側）
//
// 実行: npx tsx --env-file=.env.local scripts/audit-brain-funnel.ts [DAYS=365]
import { createClient } from "@supabase/supabase-js";

const sb = createClient(process.env.NEXT_PUBLIC_SUPABASE_URL ?? "", process.env.SUPABASE_SERVICE_ROLE_KEY ?? process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY ?? "");
const pct = (a: number, b: number) => (b === 0 ? "—" : `${((a / b) * 100).toFixed(1)}%`);

/** 成約側＝申込以降まで進んだ会話 */
const WON_STATUSES = ["closed_won", "applying", "screening", "application", "contract", "approved"];
/** 黄金フローの段階（brain-core.ts の「成約の典型順」と同じ並び。物件確認はデータ上は中に入るので 2 に置く） */
const STAGE_OF: Record<string, number> = {
  condition_hearing: 0, property_search: 0,
  property_send: 1, property_recommendation: 1,
  acknowledge_check: 2, property_check_result: 2,
  estimate_sheet: 3, cost_explain: 3, cost_breakdown: 3, guarantor_info: 3,
  viewing_invite: 4, meeting_place: 5, greeting_viewing: 5,
  application_push: 6,
};
const STATUS_STAGE: Record<string, number> = {
  first_reply: 0, hearing: 0, condition_hearing: 0, property_search: 0,
  proposing: 1, property_recommendation: 1, availability_check: 1, estimate_request: 1,
  viewing: 2, applying: 3, application: 3, screening: 3, contract: 4, approved: 4,
};
const BRAIN_STAGE: Record<string, number> = { hearing: 0, proposing: 1, viewing: 2, applying: 3, contract: 4 };

async function all<T>(build: (from: number, to: number) => PromiseLike<{ data: unknown; error: { message: string } | null }>): Promise<T[]> {
  const out: T[] = [];
  for (let p = 0; p < 40; p++) {
    const { data, error } = await build(p * 1000, p * 1000 + 999);
    if (error) { console.error(error.message); break; }
    const r = (data ?? []) as T[]; out.push(...r); if (r.length < 1000) break;
  }
  return out;
}

async function main() {
  const days = Number(process.env.DAYS ?? 365);
  const since = new Date(Date.now() - days * 86400_000).toISOString();

  const convs = await all<{ id: string; status: string | null; brain_strategy: Record<string, unknown> | null; applying_text_received: boolean | null; applying_image_received: boolean | null }>(
    (a, b) => sb.from("conversations").select("id, status, brain_strategy, applying_text_received, applying_image_received").range(a, b));
  const wonIds = new Set(convs.filter((c) => WON_STATUSES.includes(c.status ?? "")).map((c) => c.id));

  // ── ① 成約会話で AIX が押される順番 ─────────────────────────
  console.log(`=== ① 成約側（申込以降まで進んだ ${wonIds.size} 会話）で AIX が初めて押される順番 ===`);
  const aix = await all<{ conversation_id: string; aix_type: string | null; created_at: string }>(
    (a, b) => sb.from("aix_usage_logs").select("conversation_id, aix_type, created_at").gte("created_at", since).order("created_at").range(a, b));
  const firstByConv = new Map<string, Map<string, number>>();
  for (const l of aix) {
    if (!wonIds.has(l.conversation_id) || !l.aix_type) continue;
    const m = firstByConv.get(l.conversation_id) ?? new Map<string, number>();
    if (!m.has(l.aix_type)) m.set(l.aix_type, new Date(l.created_at).getTime());
    firstByConv.set(l.conversation_id, m);
  }
  const rankSum = new Map<string, { sum: number; n: number }>();
  for (const m of firstByConv.values()) {
    const ordered = [...m].sort((x, y) => x[1] - y[1]);
    ordered.forEach(([t], i) => { const r = rankSum.get(t) ?? { sum: 0, n: 0 }; r.sum += i + 1; r.n++; rankSum.set(t, r); });
  }
  for (const [t, r] of [...rankSum].sort((x, y) => x[1].sum / x[1].n - y[1].sum / y[1].n)) {
    if (r.n < 2) continue;
    console.log(`   ${t.padEnd(26)} 平均 ${(r.sum / r.n).toFixed(2)} 番目（${r.n}会話・${pct(r.n, firstByConv.size)}）`);
  }
  console.log(`   ⚠ プロンプトの黄金フローは 条件→物件送付→オススメ→見積→内覧→待合せ→申込 で、物件確認は「割り込み」扱い。実データでは物件確認が成約側の大半で 3番目付近に入る`);

  // ── ② ブレインの次の一手 vs スタッフの AIX ───────────────────
  console.log(`\n=== ② ブレインの次の一手（brain_decision_logs）と、スタッフが実際に押した AIX の段階差 ===`);
  const logs = await all<{ suggested_action: string | null; actual_aix_type: string | null; conversation_status: string | null; analyzed_msg_ts: string | null; actual_at: string | null }>(
    (a, b) => sb.from("brain_decision_logs").select("suggested_action, actual_aix_type, conversation_status, analyzed_msg_ts, actual_at").gte("created_at", since).not("actual_aix_type", "is", null).range(a, b));
  const kinds = new Map<string, { n: number; lags: number[] }>();
  for (const l of logs) {
    const s = (l.suggested_action ?? "").trim(), a = l.actual_aix_type ?? "";
    const rs = STAGE_OF[s], ra = STAGE_OF[a];
    const kind = !s ? "提案なし" : rs === undefined || ra === undefined ? "順番の外" : rs === ra ? "同じ段階" : rs < ra ? "ブレインが後ろ（前の段階を提案）" : "ブレインが先（次の段階を提案）";
    const k = kinds.get(kind) ?? { n: 0, lags: [] }; k.n++;
    if (l.analyzed_msg_ts && l.actual_at) k.lags.push((new Date(l.actual_at).getTime() - new Date(l.analyzed_msg_ts).getTime()) / 3600_000);
    kinds.set(kind, k);
  }
  const med = (a: number[]) => a.slice().sort((x, y) => x - y)[Math.floor(a.length / 2)] ?? 0;
  for (const [k, v] of [...kinds].sort((x, y) => y[1].n - x[1].n)) {
    console.log(`   ${k.padEnd(28)} ${String(v.n).padStart(4)}件（${pct(v.n, logs.length)}）／ 分析からAIX押下までの中央値 ${med(v.lags).toFixed(1)}時間`);
  }
  console.log(`   ⚠ 「後ろ」の実物: お客様「空室状況を確認してほしい」→ ブレイン「確認します（acknowledge_check）」→ スタッフは確認を済ませてから【物件確認した】を押す。`);
  console.log(`      ブレインは返信の時点の判断・記録は次に押した AIX との比較なので、これは判断違いではなく測り方の差`);
  const early = logs.filter((l) => ["first_reply", "hearing", "condition_hearing", "property_search"].includes(l.conversation_status ?? ""));
  const earlyNone = early.filter((l) => !(l.suggested_action ?? "").trim()).length;
  console.log(`   最初の段階（first_reply/hearing/condition_hearing/property_search）${early.length}件のうち、ブレインが AIX を出していない ${earlyNone}件（${pct(earlyNone, early.length)}）`);

  // ── ③ DB の status とブレインの段階 ──────────────────────────
  console.log(`\n=== ③ DB の conversations.status と、ブレイン自身の段階（brain_strategy.checkpoint_stage）===`);
  const withStrat = convs.filter((c) => c.brain_strategy && !(c.status ?? "").startsWith("closed"));
  const cmp = new Map<string, number>();
  const lagging: typeof convs = [];
  for (const c of withStrat) {
    const rs = STATUS_STAGE[c.status ?? ""], rb = BRAIN_STAGE[String(c.brain_strategy?.checkpoint_stage ?? "")];
    const k = rs === undefined || rb === undefined ? "不明" : rs === rb ? "一致" : rs < rb ? "DBの status がブレインより後ろ" : "DBの status がブレインより先";
    cmp.set(k, (cmp.get(k) ?? 0) + 1);
    if (rs !== undefined && rb !== undefined && rs < rb) lagging.push(c);
  }
  for (const [k, n] of [...cmp].sort((x, y) => y[1] - x[1])) console.log(`   ${k.padEnd(28)} ${String(n).padStart(4)}件（${pct(n, withStrat.length)}）`);
  const flagT = lagging.filter((c) => c.applying_text_received).length, flagI = lagging.filter((c) => c.applying_image_received).length;
  console.log(`   後ろの ${lagging.length}件: applying_text_received=true ${flagT}件 ／ applying_image_received=true ${flagI}件`);
  console.log(`   ⚠ status→applying の自動昇格（line-webhook tryPromoteToApplying）はテキストと画像の両方の旗が要る。画像の旗が立たず止まっている`);
  console.log(`      影響: ブレインへ渡す「現在のステータス: 物件提案中…内覧提案はしない」・段階一致の実例・DRAFT_SKIP_STATUSES（申込以降は下書きしない）が古い status を見る`);

  // ── ④ 段階ごとの締め（申込へ／内覧へ） ─────────────────────────
  console.log(`\n=== ④ 段階ごとの締め — 実送信 vs AI の下書き（申込へ／内覧へ の語が入る率）===`);
  const ex = await all<{ conversation_id: string | null; aix_action: string | null; ai_draft: string | null; sent_reply: string | null }>(
    (a, b) => sb.from("ai_reply_examples").select("conversation_id, aix_action, ai_draft, sent_reply").gte("created_at", since).range(a, b));
  const MARK = /^\s*(\[AIX誘導中\]|__SHOWN__|\[返信不要\])\s*$/;
  const usable = ex.filter((e) => (e.ai_draft ?? "").trim() && (e.sent_reply ?? "").trim() && !MARK.test(e.ai_draft ?? ""));
  const kindOf = (a: string | null) => a ? a.split("_").slice(0, 2).join("_") : "通常返信";
  const APPLY = /お申込|申込/, VIEW = /ご案内|内覧|ご内覧/;
  for (const won of [false, true]) {
    console.log(`   【${won ? "成約側" : "全体"}】`);
    const rows = usable.filter((e) => wonIds.has(e.conversation_id ?? "") === won);
    const byKind = new Map<string, typeof rows>();
    for (const r of rows) { const k = kindOf(r.aix_action); const a = byKind.get(k) ?? []; a.push(r); byKind.set(k, a); }
    for (const [k, list] of [...byKind].sort((x, y) => y[1].length - x[1].length)) {
      if (list.length < 15) continue;
      const sa = list.filter((r) => APPLY.test(r.sent_reply ?? "")).length, aa = list.filter((r) => APPLY.test(r.ai_draft ?? "")).length;
      const sv = list.filter((r) => VIEW.test(r.sent_reply ?? "")).length, av = list.filter((r) => VIEW.test(r.ai_draft ?? "")).length;
      const flag = Math.abs(aa - sa) / list.length >= 0.1 ? (aa > sa ? "  ← AI が申込を書きすぎ" : "  ← AI が申込を書けていない") : "";
      console.log(`      ${k.padEnd(24)} ${String(list.length).padStart(4)}件  申込: 実送信 ${pct(sa, list.length).padStart(6)} ／ AI ${pct(aa, list.length).padStart(6)}   内覧: 実送信 ${pct(sv, list.length).padStart(6)} ／ AI ${pct(av, list.length).padStart(6)}${flag}`);
    }
  }
  const rec = usable.filter((e) => (e.aix_action ?? "").startsWith("property_recommendation"));
  const recAi = rec.filter((r) => APPLY.test(r.ai_draft ?? "")), recRemoved = recAi.filter((r) => !APPLY.test(r.sent_reply ?? "")).length;
  const line = rec.filter((r) => /お申込みから審査・ご契約/.test(r.ai_draft ?? "")), lineRemoved = line.filter((r) => !/お申込みから審査・ご契約/.test(r.sent_reply ?? "")).length;
  console.log(`   物件オススメで AI が申込を書いた ${recAi.length}件のうちスタッフが消した ${recRemoved}件（${pct(recRemoved, recAi.length)}）`);
  console.log(`   うち「お申込みから審査・ご契約・入居まで通常2週間」の行（aix/action buildMoveInDeadlineNote「添えること」）: AI ${line.length}件 → 消された ${lineRemoved}件（${pct(lineRemoved, line.length)}）`);
}
main().catch((e) => { console.error(e); process.exit(1); });
