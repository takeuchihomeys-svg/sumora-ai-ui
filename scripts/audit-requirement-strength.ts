// scripts/audit-requirement-strength.ts
// 実行: npx tsx --env-file=.env.local scripts/audit-requirement-strength.ts [--days=180] [--show=20]
//
// 2026-10-06 ⑫ 竹内さん（ゆいと 10月後半入居）「10月入居っていう希望が今回の場合は絶対となる…状況によって決めきるようにする」
// 本番で測る:
//   ① 要望が「絶対」のお客様は何人か（入居時期・ペット・家賃の上限・エリア）— お客様の発言だけから読む（requirement-strength.readRequirementStrengths）
//   ② 絶対の要望に合わない物件をいくつ送っていたか（送った時点までの発言で絶対と読めた人の、送ったピックアップの札 MOVE_IN_LATE 等）＝今の抜けの量
//   ③ 新しい判定（strengthCodes）で外す候補になる送付のうち、その後に内覧・申込・見積で進んだ物（＝誤って NG にした）を目で読む
//   ④ スタッフが送った物件の判定（旧→新）: 通す／保留／外す候補の数
// 読み取りのみ。出力は会話の文を含むので共有しない。
import { createClient } from "@supabase/supabase-js";
import { readRequirementStrengths, strengthCodes, type RequirementKey } from "../app/lib/requirement-strength";
import { DROP_REASON_CODES, HOLD_REASON_CODES } from "../app/lib/property-brain";

const sb = createClient(process.env.NEXT_PUBLIC_SUPABASE_URL ?? "", process.env.SUPABASE_SERVICE_ROLE_KEY ?? process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY ?? "");
const arg = (k: string, d: string) => (process.argv.find((a) => a.startsWith(`--${k}=`)) ?? `--${k}=${d}`).split("=")[1];
const days = Number(arg("days", "180"));
const show = Number(arg("show", "20"));
const since = new Date(Date.now() - days * 86400_000).toISOString();

async function pageAll<T>(q: (a: number, b: number) => PromiseLike<{ data: T[] | null; error: { message: string } | null }>): Promise<T[]> {
  const out: T[] = [];
  for (let p = 0; ; p++) { const { data, error } = await q(p * 1000, p * 1000 + 999); if (error) throw new Error(error.message); if (!data?.length) break; out.push(...data); if (data.length < 1000) break; }
  return out;
}

async function main() {
  const msgs = await pageAll<{ conversation_id: string; sender: string; text: string | null; created_at: string }>((a, b) => sb.from("messages").select("conversation_id, sender, text, created_at").gte("created_at", since).order("created_at").range(a, b));
  const convs = await pageAll<{ id: string; customer_name: string | null; property_customer_id: string | null; is_post_apply: boolean | null }>((a, b) => sb.from("conversations").select("id, customer_name, property_customer_id, is_post_apply").range(a, b));
  const sent = await pageAll<{ conversation_id: string | null; property_customer_id: string | null; property_name: string | null; room_no: string | null; sent_at: string; pickup_id: number | null }>((a, b) => sb.from("sent_properties").select("conversation_id, property_customer_id, property_name, room_no, sent_at, pickup_id").gte("sent_at", since).not("pickup_id", "is", null).range(a, b));
  const byConv = new Map<string, typeof msgs>();
  for (const m of msgs) byConv.set(m.conversation_id, [...(byConv.get(m.conversation_id) ?? []), m]);
  const convOfPc = new Map(convs.filter((c) => c.property_customer_id).map((c) => [String(c.property_customer_id), c]));

  // ① 絶対のお客様
  const mustCount: Record<RequirementKey, number> = { move_in: 0, pet: 0, rent_max: 0, area: 0 };
  const anyCount: Record<RequirementKey, number> = { move_in: 0, pet: 0, rent_max: 0, area: 0 };
  const examples: string[] = [];
  for (const c of convs) {
    const cm = (byConv.get(c.id) ?? []).filter((m) => m.sender === "customer");
    if (!cm.length) continue;
    const s = readRequirementStrengths(cm.map((m) => ({ text: m.text, at: m.created_at })));
    for (const k of Object.keys(s) as RequirementKey[]) { anyCount[k]++; if (s[k]?.strength === "must") { mustCount[k]++; if (examples.length < 400) examples.push(`${k} ${c.customer_name ?? ""} | ${s[k]?.evidence}`); } }
  }
  console.log(`=== ① 要望の強さ（${days}日・お客様の発言から）===`);
  for (const k of Object.keys(mustCount) as RequirementKey[]) console.log(`  ${k}: 強さが読めた ${anyCount[k]}人・うち絶対 ${mustCount[k]}人`);
  for (const k of ["move_in", "pet", "rent_max", "area"]) { console.log(`  --- ${k} の絶対の例`); for (const e of examples.filter((x) => x.startsWith(k + " ")).slice(0, show)) console.log("    " + e); }

  // ②③④ 送った物件
  const ids = [...new Set(sent.map((s) => s.pickup_id).filter((x): x is number => x != null))];
  const pk = new Map<number, { verdict: string | null; reason_codes: string[] | null; property_name: string | null }>();
  for (let i = 0; i < ids.length; i += 200) {
    const { data } = await sb.from("property_pickups").select("id, verdict, reason_codes, property_name").in("id", ids.slice(i, i + 200));
    for (const r of (data ?? []) as Array<{ id: number; verdict: string | null; reason_codes: string[] | null; property_name: string | null }>) pk.set(r.id, r);
  }
  const tally = { sentToMust: 0, late: 0, unknown: 0, ok: 0, beforeVerdict: {} as Record<string, number>, afterVerdict: {} as Record<string, number> };
  const newDrops: string[] = [];
  for (const s of sent) {
    const p = s.pickup_id != null ? pk.get(s.pickup_id) : null;
    if (!p) continue;
    const conv = s.conversation_id ? convs.find((c) => c.id === s.conversation_id) : s.property_customer_id ? convOfPc.get(s.property_customer_id) : undefined;
    if (!conv || conv.is_post_apply) continue;
    const before = (byConv.get(conv.id) ?? []).filter((m) => m.sender === "customer" && m.created_at < s.sent_at);
    const st = readRequirementStrengths(before.map((m) => ({ text: m.text, at: m.created_at })));
    const codes = p.reason_codes ?? [];
    const add = strengthCodes(codes, st);
    const afterCodes = [...codes, ...add];
    const after = afterCodes.some((c) => DROP_REASON_CODES.has(c)) ? "drop" : afterCodes.some((c) => HOLD_REASON_CODES.has(c) || /^(?:IMAGE|EQUIP|CONDITION)_.*_NG$/.test(c)) ? "hold" : (p.verdict ?? "-");
    tally.beforeVerdict[p.verdict ?? "-"] = (tally.beforeVerdict[p.verdict ?? "-"] ?? 0) + 1;
    tally.afterVerdict[after] = (tally.afterVerdict[after] ?? 0) + 1;
    if (st.move_in?.strength === "must") {
      tally.sentToMust++;
      if (codes.includes("MOVE_IN_LATE")) tally.late++; else if (codes.includes("MOVE_IN_UNKNOWN")) tally.unknown++; else if (codes.includes("MOVE_IN_OK")) tally.ok++;
    }
    if (add.some((c) => DROP_REASON_CODES.has(c))) {
      // その後この物件で進んだか（名前が後の発言に出る・内覧／申込／見積の語）
      const later = (byConv.get(conv.id) ?? []).filter((m) => m.created_at > s.sent_at);
      const nm = String(s.property_name ?? "").replace(/[★☆]/g, "").slice(0, 6);
      const progressed = later.some((m) => nm && String(m.text ?? "").includes(nm) && /内覧|内見|申込|お申込み|見積|待ち合わせ/.test(String(m.text ?? "")));
      newDrops.push(`${s.sent_at.slice(0, 10)} ${conv.customer_name} ${s.property_name} ${s.room_no ?? ""} ${add.join(",")} 進んだ=${progressed ? "Y" : "-"} | 絶対: ${Object.entries(st).filter(([, v]) => v?.strength === "must").map(([k, v]) => `${k}「${v?.evidence.slice(0, 40)}」`).join(" ")}`);
    }
  }
  console.log(`\n=== ② 入居時期が絶対のお客様に送った物件 ${tally.sentToMust}件: 遅い ${tally.late}・分からない ${tally.unknown}・間に合う ${tally.ok} ===`);
  console.log(`=== ④ スタッフが送った物件の判定: 旧 ${JSON.stringify(tally.beforeVerdict)} → 新 ${JSON.stringify(tally.afterVerdict)} ===`);
  console.log(`=== ③ 新しく外す候補になる送付 ${newDrops.length}件（進んだ=Y は誤って NG の疑い・目で読む）===`);
  for (const x of newDrops.slice(0, show * 2)) console.log("    " + x);
}
main().catch((e) => { console.error(e); process.exit(1); });
