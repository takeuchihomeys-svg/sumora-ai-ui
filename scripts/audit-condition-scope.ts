// scripts/audit-condition-scope.ts
// 実行: npx tsx --env-file=.env.local scripts/audit-condition-scope.ts [--days=180] [--show=40]
//
// 2026-09-30 竹内「一時調整でその一回限定して行うか、そもそもの条件自体を変えるのかの判断の部分も強化する」。
// 過去のお客様の条件の言い直しに、旧の決め方（2026-09-27 版・この下に写し）と新の決め方（condition-change-scope.ts）を当て、
// その後のスタッフの動き（labelScopeOutcome: 人の手直し・メモの一時調整・返事の言い方）を正解として当たりを比べる。
//   ブレインの欄は過去の分が残っていないので「文の語 → 既定」の決定論の層だけを比べる（ブレインは迷う時だけ）。
//   読み取りのみ。出力は会話の文を含むので共有しない。
import { createClient } from "@supabase/supabase-js";
import { resolveConditionChangeScope, labelScopeOutcome, scoreScopeDecisions, hasRegisteredConditions, type ScopeOutcome, type HistoryRowLite } from "../app/lib/condition-change-scope";
import { floorMinInText } from "../app/lib/search-override";

const url = process.env.NEXT_PUBLIC_SUPABASE_URL ?? "";
const key = process.env.SUPABASE_SERVICE_ROLE_KEY ?? process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY ?? "";
if (!url || !key) { console.error("環境変数が読めません（NEXT_PUBLIC_SUPABASE_URL / KEY）"); process.exit(1); }
const sb = createClient(url, key);
const arg = (k: string, d: string) => (process.argv.find((a) => a.startsWith(`--${k}=`)) ?? `--${k}=${d}`).split("=")[1];
const days = Number(arg("days", "180"));
const show = Number(arg("show", "40"));
const since = new Date(Date.now() - days * 86400_000).toISOString();

// ── 旧の決め方（2026-09-27 版の写し・比べるためだけ） ──
const OLD_TMP = [
  /今回(?:だけ|のみ|限り|に限って|に限り)/, /一時的に?/, /(?:試しに|ためしに|お試しで)/,
  /参考(?:まで|程度|として|に)(?:に)?(?!\s?(?:致|いた|させ|なり|します|なる))[^。!?！？]{0,12}?(?:見|知り|教え|送|聞)/,
  /比較(?:したい|のため|用に?|して(?:み|見)|で)/, /ついでに/, /念の(?:ため|為)/,
  /(?:にした|だった|とした|になった|上げた|広げた)場合(?:の|で|は)?(?:物件|お部屋|部屋|もの|とこ)?(?:も|って|は)?\s?(?:見|知り|教え|送|あり|あれ|どう|気にな)/,
  /(?:にした|だった)ら(?:どんな|どう|いくら|ありま|あるか)/,
];
const OLD_PERM = [/条件(?:を|の)?(?:変更|変え|切り替え|切替|見直)/, /(?:に|へ)(?:変更|切り替え|切替)/, /(?:やっぱり|やっぱ|やはり)/, /(?:ではなく|じゃなくて|じゃなく|ではなくて)/, /(?:で|を)探して(?:ます|います|る|いきたい|行きたい|おります)/, /(?:希望|条件)が変わ/, /今後は/];
function oldResolve(text: string): { scope: string; by: string } {
  const t = text.normalize("NFKC").replace(/\s+/g, " ");
  const neg = /今回は(?:見送|大丈夫|結構|遠慮|やめ|なし|いい)/.test(t) && !/今回(?:だけ|のみ|限り)/.test(t);
  if (!neg && OLD_TMP.some((r) => r.test(t))) return { scope: "temporary", by: "text_temporary" };
  if (OLD_PERM.some((r) => r.test(t))) return { scope: "permanent", by: "text_permanent" };
  return { scope: "permanent", by: "default" };
}

// 条件の言い直しらしい文（監査の入口・広め）
const COND = /(万|LDK|DK|[1-9]\s*K(?![a-z])|[1-9]\s*R(?![a-z])|ワンルーム|区|駅|徒歩|築|階|平米|㎡|帖|畳|家賃|エリア|間取り|広さ|ペット|オートロック|バストイレ)/i;
const ASK = /(探し|探して|見たい|見て|送って|ありますか|ないですか|ありませんか|変え|変更|広げ|でも(?:いい|良い|大丈夫|OK|可|構)|がいい|が良い|希望|お願い|じゃなく|ではなく|やっぱ|やはり|一旦|いったん|とりあえず|ひとまず|今回|今後|これから|次から|以降)/;
const FORMAL = /[①②③④⑤⑥⑦⑧]|【ご入居の時期】|ご希望のお部屋探しご条件/;

type Msg = { id: string; conversation_id: string; text: string; created_at: string };
async function all<T>(build: (a: number, b: number) => PromiseLike<{ data: T[] | null; error: { message: string } | null }>): Promise<T[]> {
  const out: T[] = [];
  for (let from = 0; ; from += 1000) {
    const { data, error } = await build(from, from + 999);
    if (error) throw new Error(error.message);
    out.push(...(data ?? []));
    if (!data || data.length < 1000) break;
  }
  return out;
}

async function main() {
  const msgs = await all<Msg>((a, b) => sb.from("messages").select("id, conversation_id, text, created_at").eq("sender", "customer").gte("created_at", since).not("text", "is", null).order("created_at", { ascending: true }).range(a, b));
  const cands = msgs.filter((m) => { const t = String(m.text).normalize("NFKC"); return t.length >= 4 && t.length <= 300 && COND.test(t) && ASK.test(t) && !/https?:\/\//.test(t) && !FORMAL.test(t); });
  const convIds = [...new Set(cands.map((m) => m.conversation_id))];
  const convs = new Map<string, string | null>();
  for (let i = 0; i < convIds.length; i += 200) {
    const { data } = await sb.from("conversations").select("id, property_customer_id").in("id", convIds.slice(i, i + 200));
    for (const c of data ?? []) convs.set(c.id as string, (c.property_customer_id as string | null) ?? null);
  }
  const pcIds = [...new Set([...convs.values()].filter((x): x is string => !!x))];
  const pcs = new Map<string, Record<string, unknown>>();
  for (let i = 0; i < pcIds.length; i += 200) {
    const { data } = await sb.from("property_customers").select("id, created_at, desired_area, floor_plan, rent_max").in("id", pcIds.slice(i, i + 200));
    for (const p of data ?? []) pcs.set(p.id as string, p as Record<string, unknown>);
  }
  const hist = await all<HistoryRowLite & { property_customer_id: string; source_message_id: string | null }>((a, b) => sb.from("property_condition_history").select("property_customer_id, changed_field, old_value, new_value, created_at, source_message_id").gte("created_at", since).range(a, b));
  const cmds = await all<{ created_at: string; customer_ids: string[] | null; payload: Record<string, unknown> | null }>((a, b) => sb.from("automation_commands").select("created_at, customer_ids, payload").gte("created_at", since).range(a, b));
  const staffByConv = new Map<string, Array<{ text: string | null; created_at: string }>>();
  for (const cid of convIds) {
    const rows = await all<{ text: string | null; created_at: string }>((a, b) => sb.from("messages").select("text, created_at").eq("conversation_id", cid).eq("sender", "staff").gte("created_at", since).order("created_at", { ascending: true }).range(a, b));
    staffByConv.set(cid, rows);
  }

  type Row = { m: Msg; truth: ScopeOutcome; ev: string; oldS: string; oldBy: string; newS: string; newBy: string; newEv: string | null; floor: number | null };
  const rows: Row[] = [];
  for (const m of cands) {
    const pcId = convs.get(m.conversation_id) ?? null;
    const pc = pcId ? pcs.get(pcId) ?? null : null;
    const t0 = Date.parse(m.created_at);
    const lab = labelScopeOutcome(m.created_at, {
      history: pcId ? hist.filter((h) => h.property_customer_id === pcId) : [],
      overrideAt: pcId ? cmds.filter((c) => (c.customer_ids ?? []).includes(pcId) && c.payload?.source === "web_brain" && c.payload?.search_override).map((c) => c.created_at) : [],
      staffTexts: staffByConv.get(m.conversation_id) ?? [],
    });
    // 登録の条件がその時あったか（近似: お客様の行がこの発言より1時間以上前からあり、今条件が入っている）
    const regBefore = pc && Date.parse(String(pc.created_at)) < t0 - 3600_000 && hasRegisteredConditions(pc) ? pc : {};
    const o = oldResolve(m.text);
    const n = resolveConditionChangeScope({ text: m.text, brainScope: null, registered: regBefore });
    rows.push({ m, truth: lab.truth, ev: lab.evidence, oldS: o.scope, oldBy: o.by, newS: n.scope, newBy: n.by, newEv: n.evidence, floor: floorMinInText(m.text) });
  }

  const fmt = (s: ReturnType<typeof scoreScopeDecisions>) => `当たり ${s.hit}/${s.n}（${s.n ? (100 * s.hit / s.n).toFixed(1) : "-"}%）・今回だけなのに登録を直す（出口の誤り）${s.wrongPermanent}・切り替えなのに今回だけ（入口の誤り）${s.wrongTemporary}`;
  const oldScore = scoreScopeDecisions(rows.map((r) => ({ scope: r.oldS, by: r.oldBy, truth: r.truth })));
  const newScore = scoreScopeDecisions(rows.map((r) => ({ scope: r.newS, by: r.newBy, truth: r.truth })));
  const truthCount = rows.reduce((a, r) => { a[r.truth] = (a[r.truth] ?? 0) + 1; return a; }, {} as Record<string, number>);
  console.log(`\n=== お客様の発言 ${msgs.length}件（${days}日）→ 条件の言い直しらしい文 ${cands.length}件 ===`);
  console.log(`正解（スタッフの動き）: ${JSON.stringify(truthCount)}`);
  console.log(`旧: ${fmt(oldScore)}`);
  console.log(`新: ${fmt(newScore)}`);
  console.log(`新の規則ごと: ${JSON.stringify(newScore.byRule)}`);
  const diff = rows.filter((r) => r.oldS !== r.newS);
  console.log(`\n--- 旧と新で答えが変わった文 ${diff.length}件（目で読む） ---`);
  for (const r of diff.slice(0, show)) console.log(`[${r.m.created_at.slice(0, 10)} ${r.m.conversation_id.slice(0, 8)}] 旧=${r.oldS} 新=${r.newS}(${r.newBy}「${r.newEv}」) 正解=${r.truth}（${r.ev}）\n   ${r.m.text.replace(/\n/g, " / ").slice(0, 140)}`);
  const wrongP = rows.filter((r) => r.truth === "temporary" && r.newS === "permanent");
  console.log(`\n--- 新で「今回だけ」を切り替えにした文（出口の誤り・0 が目標）${wrongP.length}件 ---`);
  for (const r of wrongP.slice(0, show)) console.log(`[${r.m.created_at.slice(0, 10)} ${r.m.conversation_id.slice(0, 8)}] 新=${r.newBy} 正解=${r.ev}\n   ${r.m.text.replace(/\n/g, " / ").slice(0, 140)}`);
  const tmp = rows.filter((r) => r.newS === "temporary");
  console.log(`\n--- 新で今回だけにした文 ${tmp.length}件（目で読む） ---`);
  for (const r of tmp.slice(0, show)) console.log(`[${r.m.created_at.slice(0, 10)} ${r.m.conversation_id.slice(0, 8)}] ${r.newBy}「${r.newEv}」 正解=${r.truth}（${r.ev}）\n   ${r.m.text.replace(/\n/g, " / ").slice(0, 140)}`);
  const fl = rows.filter((r) => r.floor != null);
  console.log(`\n--- 階の言い方（floorMinInText）${fl.length}件 ---`);
  for (const r of fl.slice(0, show)) console.log(`  階=${r.floor} ${r.m.text.replace(/\n/g, " / ").slice(0, 120)}`);
}
main().catch((e) => { console.error(e); process.exit(1); });
