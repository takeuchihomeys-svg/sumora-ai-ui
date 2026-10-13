// audit-redeclare-gates.ts — 出口の再宣言ゲート（見積作成宣言の繰り返し・空室確認の再宣言）が「人の文」を消すかを、旧の旗と新の旗（redeclare-gate.ts）で比べる
// 2026-10-14 区切り2（竹内さん「出口のゲートはブレイン基準ではないのが原因」）。scratchpad nonbrain/src/sim-gates.ts の写し＋新しい旗。読むだけ・LLM なし。
//   スタッフの手打ちの実送信（AIX の本文を除く）に generate-reply と同じ旗を立てて enforceAixGates に通し、消える／置き換わる文を数える。
//   文の型: 未来の約束（〜させて頂きます）・結果の報告（〜させて頂きました・〜とのこと・〜したところ）
//   新の旗の材料: aix_usage_logs.property_names（物件ごと）・brain_decision_logs.digest（prop＝今の物件・aix・tc＝本質の数・dir）
//   ⚠ ブレインの本質の中身（asks の topic）は digest に無い → 免除(a) は「本質に約束か AIX がある（tc の p/a>0）×方向の文に見積／確認の語」で近づける
// 実行: npx tsx --env-file=<.env.local> scripts/audit-redeclare-gates.ts [--days=30] [--out=<json・個人情報あり＝リポジトリに置かない>]
import { createClient } from "@supabase/supabase-js";
import { writeFileSync } from "node:fs";
import { enforceAixGates, GROUND_SEP } from "../app/lib/validate-reply";
import { CUSTOMER_ESTIMATE_REQUEST_RE, CUSTOMER_PROPERTY_REF_RE, CUSTOMER_COST_QUESTION_RE, STAFF_ESTIMATE_PROMISE_RE } from "../app/lib/line-reply-prompts";
import { FORM_LABEL_RE } from "../app/lib/reply-context";
import { estimateRedeclareArmed, vacancyRedeclareArmed, logMatchesCurrent, ESTIMATE_REDECLARE_WINDOW_MS } from "../app/lib/redeclare-gate";
import { isTestConversation } from "../app/lib/test-conversations";

const sb = createClient(process.env.NEXT_PUBLIC_SUPABASE_URL!, (process.env.SUPABASE_SERVICE_ROLE_KEY || process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY)!);
async function fetchAll(q: (from: number, to: number) => any): Promise<any[]> {
  const out: any[] = [];
  for (let from = 0; ; from += 1000) { const { data, error } = await q(from, from + 999); if (error) throw error; out.push(...(data ?? [])); if (!data || data.length < 1000) break; }
  return out;
}
const arg = (k: string, d: string) => (process.argv.find((a) => a.startsWith(`--${k}=`)) ?? `--${k}=${d}`).slice(k.length + 3);
const DAYS = Number(arg("days", "30"));
const OUT = arg("out", "");
const RULES = new Set(["見積作成宣言の繰り返し", "空室確認の再宣言"]);
// 結果の報告か: 文の最後の述語が過去・報告（〜ました・〜ております・〜とのこと）。「お送り頂きましたお部屋の…確認させて頂きます」は未来
const isReport = (s: string) => {
  const t = s.replace(/[😊😌🌟✨！!。\s]+$/u, "");
  const fut = Math.max(t.lastIndexOf("ます"), t.lastIndexOf("次第"));
  const pastAt = Math.max(...["ました", "ております", "とのこと", "ところ"].map((w) => t.lastIndexOf(w)));
  return pastAt >= 0 && (fut < 0 || pastAt > fut || t.slice(fut, fut + 3) === "ました");
};

(async () => {
  const since = new Date(Date.now() - DAYS * 864e5).toISOString();
  const sends = (await fetchAll((f, t) => sb.from("messages").select("id, conversation_id, text, created_at, staff_writer, is_aix_generated").eq("sender", "staff").gte("created_at", since).range(f, t)))
    .filter((m) => !isTestConversation(m.conversation_id) && !m.is_aix_generated && (m.text ?? "").length > 4 && !/^\[(画像|動画|スタンプ)\]/.test(m.text));
  const cids = [...new Set(sends.map((m) => m.conversation_id))];
  const msgs = new Map<string, any[]>(), aix = new Map<string, any[]>(), brain = new Map<string, any[]>();
  const push = (m: Map<string, any[]>, k: string, v: any) => (m.get(k) ?? m.set(k, []).get(k)!).push(v);
  for (let i = 0; i < cids.length; i += 40) {
    const part = cids.slice(i, i + 40);
    const since2 = new Date(Date.now() - (DAYS + 10) * 864e5).toISOString();
    const [m, a, b] = await Promise.all([
      fetchAll((f, t) => sb.from("messages").select("conversation_id, sender, text, created_at").in("conversation_id", part).gte("created_at", since2).order("created_at").range(f, t)),
      fetchAll((f, t) => sb.from("aix_usage_logs").select("conversation_id, aix_type, check_pattern, created_at, estimate_sent, property_names").in("conversation_id", part).range(f, t)),
      fetchAll((f, t) => sb.from("brain_decision_logs").select("conversation_id, created_at, digest").in("conversation_id", part).gte("created_at", since2).order("created_at").range(f, t)),
    ]);
    for (const x of m) push(msgs, x.conversation_id, x);
    for (const x of a) push(aix, x.conversation_id, x);
    for (const x of b) push(brain, x.conversation_id, x);
  }
  type Row = { rule: string; kind: "future" | "report"; writer: string };
  const tally = (rows: Row[]) => {
    const t: Record<string, number> = {};
    for (const r of rows) { const k = `${r.rule}|${r.kind}`; t[k] = (t[k] ?? 0) + 1; if (r.writer === "takeuchi") t[`${k}|竹内`] = (t[`${k}|竹内`] ?? 0) + 1; }
    return t;
  };
  const oldRows: Row[] = [], newRows: Row[] = [], out: any[] = [];
  let armOld = { est: 0, vac: 0 }, armNew = { est: 0, vac: 0 };
  for (const s of sends) {
    const at = Date.parse(s.created_at);
    const all = (msgs.get(s.conversation_id) ?? []).filter((m) => Date.parse(m.created_at) < at - 500);
    const li = all.map((m) => m.sender).lastIndexOf("staff");
    const lastStaff = li >= 0 ? all[li].text ?? "" : "";
    const cust = all.slice(li + 1).filter((m) => m.sender === "customer").map((m) => m.text ?? "").join("\n");
    const logs = (aix.get(s.conversation_id) ?? []).filter((l) => Date.parse(l.created_at) < at - 500);
    // 旧の旗（route と同じ）
    let alreadySent = logs.some((l) => l.aix_type === "estimate_sheet" || l.estimate_sent);
    const priceAsk = /[¥￥]?[0-9０-９][0-9０-９,，.．]{2,}[\s　]*円/.test(cust);
    const asksCost = CUSTOMER_COST_QUESTION_RE.test(cust.replace(FORM_LABEL_RE, " "));
    const newPropCost = CUSTOMER_PROPERTY_REF_RE.test(cust) && asksCost;
    if (alreadySent && (CUSTOMER_ESTIMATE_REQUEST_RE.test(cust) || priceAsk || newPropCost)) alreadySent = false;
    const staffPromised = !newPropCost && !!lastStaff && STAFF_ESTIMATE_PROMISE_RE.test(lastStaff);
    const estimatePromised = alreadySent || staffPromised;
    const fresh = logs.filter((l) => at - Date.parse(l.created_at) <= 72 * 3600e3);
    const hasNewRef = /https?:\/\/|suumo|homes\.co|athome|chintai|goodrooms|\[画像\]/i.test(cust);
    const recheck = /(まだ|再度|改めて)[^\n]{0,8}(空い|募集|ある|残って)|空い(て|ており)ます(か|でしょうか)|(確認|問い合わせ)(して|し)[^\n]{0,6}(ください|下さい|もらえ|頂け|いただけ|ほしい|欲しい)/.test(cust);
    const vacDone = !(hasNewRef || recheck) && fresh.some((l) => l.aix_type === "property_check_result" || (l.check_pattern ?? "").startsWith("mgmt_"));
    // 新の旗
    const b = (brain.get(s.conversation_id) ?? []).filter((x) => Date.parse(x.created_at) <= at).pop();
    const dg = b?.digest ?? {};
    const props = dg.prop ? [String(dg.prop)] : [];
    const rlogs = logs.map((l) => ({ aix_type: l.aix_type, created_at: l.created_at, property_names: l.property_names, estimate_sent: l.estimate_sent, check_pattern: l.check_pattern }));
    const eg = estimateRedeclareArmed({ legacy: estimatePromised, logs: rlogs, now: at, currentProperties: props, costAsk: asksCost || priceAsk || CUSTOMER_ESTIMATE_REQUEST_RE.test(cust), staffPromisedEstimate: staffPromised });
    const vg = vacancyRedeclareArmed({ legacy: vacDone, logs: rlogs, now: at, currentProperties: props });
    const tc = String(dg.tc ?? ""); const pa = /p[1-9]|a[1-9]/.test(tc); const dir = String(dg.dir ?? ""); const ba = String(dg.aix ?? "");
    const keepE = /^estimate_sheet/.test(ba) || (pa && /見積|初期費用/.test(dir));
    const keepV = /^property_check_result|^acknowledge_check/.test(ba) || (pa && /募集|空室|空き|確認/.test(dir));
    const sentSame = rlogs.some((l) => (l.aix_type === "estimate_sheet" || l.estimate_sent) && at - Date.parse(l.created_at) <= ESTIMATE_REDECLARE_WINDOW_MS && logMatchesCurrent(l.property_names, props));
    if (estimatePromised) armOld.est++; if (vacDone) armOld.vac++; if (eg.armed) armNew.est++; if (vg.armed) armNew.vac++;
    const base = { estimatePromised, aixVacancyDone: vacDone, customerMessage: cust, lastStaffMsg: lastStaff, groundText: all.slice(-25).map((x) => x.text ?? "").join(GROUND_SEP) };
    const prevEnv = process.env.REDECLARE_GATE_BRAIN;
    process.env.REDECLARE_GATE_BRAIN = "off";
    const rOld = enforceAixGates(s.text, base);
    process.env.REDECLARE_GATE_BRAIN = prevEnv ?? "";
    const rNew = enforceAixGates(s.text, { ...base, estimateRedeclareArmed: eg.armed, estimateSentSameProperty: sentSame, estimateSentNames: [...new Set(rlogs.filter((l) => (l.aix_type === "estimate_sheet" || l.estimate_sent) && at - Date.parse(l.created_at) <= ESTIMATE_REDECLARE_WINDOW_MS).flatMap((l) => l.property_names ?? []))], estimateDoublePromise: eg.reason === "staff_promised", vacancyRedeclareArmed: vg.armed, brainKeepEstimate: keepE, brainKeepVacancy: keepV });
    const pick = (r: typeof rOld) => r.edits.filter((e) => RULES.has(e.rule)).map((e) => ({ rule: e.rule, kind: (isReport(e.before) ? "report" : "future") as Row["kind"], writer: s.staff_writer ?? "?", before: e.before.trim() }));
    const o = pick(rOld), n = pick(rNew);
    oldRows.push(...o); newRows.push(...n);
    if (o.length || n.length) out.push({ conv: s.conversation_id, at: s.created_at, writer: s.staff_writer, est: eg, vac: vg, keepE, keepV, old: o.map((x) => x.before.slice(0, 80)), new: n.map((x) => x.before.slice(0, 80)) });
  }
  console.log(`${DAYS}日 スタッフの手打ち ${sends.length}（竹内 ${sends.filter((s) => s.staff_writer === "takeuchi").length}）`);
  console.log(`旗が立つ番: 旧 見積 ${armOld.est}・空室 ${armOld.vac} → 新 見積 ${armNew.est}・空室 ${armNew.vac}`);
  console.log("人の文を消した（規則|型[|竹内]）: 旧", JSON.stringify(tally(oldRows)));
  console.log("                               新", JSON.stringify(tally(newRows)));
  console.log("新でも残る文（見本）:"); for (const r of newRows.slice(0, 12)) console.log(`  ${r.rule}｜${r.kind}｜${r.writer}｜${(r as any).before.slice(0, 70).replace(/\n/g, " ")}`);
  if (OUT) writeFileSync(OUT, JSON.stringify(out, null, 1));
})();
