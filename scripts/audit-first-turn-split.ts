// scripts/audit-first-turn-split.ts — お客様が物件（画像・URL）を送ってきた番で、竹内さん（staff_writer=takeuchi）の最初の返しの型を数える（読むだけ・LLM なし）
//   2026-10-13 竹内さん（いしのまさや）「要件に合わせて文を分けて送る」「まとめ方は実際の LINE を見れば分かる」:
//   ①何通に分けたか ②約束の順番（通をまたいで）③2通目の書き出し ④件数の言い方 ⑤物件名か「お送り頂きました物件」か（SNS・TikTok の画像の時）
//   型ごと: 初回に物件の画像＋条件フォーム／物件を複数／確認と探す依頼が重なった番
// 実行: npx tsx --env-file=.env.local scripts/audit-first-turn-split.ts [--days=150] [--writer=takeuchi|all] [--show=form|multi|both|sns]
import { createClient } from "@supabase/supabase-js";
import { isTestConversation } from "../app/lib/test-conversations";
import { promisesInStaffText, PROMISE_KIND_JA, type PromiseKind } from "../app/lib/promise-queue";
import { splitRequests } from "../app/lib/request-ledger";
const arg = (k: string, d: string) => process.argv.find((a) => a.startsWith(`--${k}=`))?.slice(k.length + 3) ?? d;
const DAYS = Number(arg("days", "150")); const WRITER = arg("writer", "takeuchi"); const SHOW = arg("show", "");
const sb = createClient(process.env.NEXT_PUBLIC_SUPABASE_URL!, process.env.SUPABASE_SERVICE_ROLE_KEY ?? process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY!);
type M = { conversation_id: string; sender: string; created_at: string; text: string | null; is_aix_generated: boolean | null; staff_writer: string | null };
const FORM_RE = /①|【ご入居の時期】|ご希望の家賃|希望の広さ|ご希望のエリア/;
const SNS_RE = /【物件の画面（SNS・広告）】|TikTok|tiktok|投稿|sumora___/;
const COUNT_RE = /([0-9０-９]+|[一二三四五六七八九十])\s*(?:件|部屋|物件)/;
const GENERIC_RE = /お送り(?:頂|いただ)きました(?:物件|お部屋|[0-9０-９一二三四五]+(?:件|部屋))|送っていただいた物件|TikTokの物件|動画の(?:物件|お部屋)/;
async function main() {
  const since = new Date(Date.now() - DAYS * 86_400_000).toISOString();
  const msgs: M[] = [];
  const q = (i: number) => sb.from("messages").select("conversation_id, sender, created_at, text, is_aix_generated, staff_writer").gte("created_at", since).order("created_at").order("id").range(i, i + 999);
  for (let i = 0; i < 1_000_000; i += 1000) {
    let r = await q(i);
    for (let t = 0; t < 3 && r.error; t++) { await new Promise((z) => setTimeout(z, 3000)); r = await q(i); }
    if (r.error) throw new Error(r.error.message);
    msgs.push(...((r.data ?? []) as M[])); if ((r.data ?? []).length < 1000) break;
  }
  const by = new Map<string, M[]>(); for (const m of msgs) { if (isTestConversation(m.conversation_id)) continue; (by.get(m.conversation_id) ?? by.set(m.conversation_id, []).get(m.conversation_id)!).push(m); }
  type Row = { cid: string; at: string; first: boolean; form: boolean; props: number; sns: boolean; askPickup: boolean; out: string[]; kinds: PromiseKind[][]; };
  const rows: Row[] = [];
  for (const [cid, list] of by) {
    for (let i = 0; i < list.length; i++) {
      if (list[i].sender !== "customer" || (i > 0 && list[i - 1].sender === "customer")) continue;
      let j = i; while (j < list.length && list[j].sender === "customer") j++;
      if (j >= list.length) continue;
      const bundle = list.slice(i, j).map((m) => String(m.text ?? ""));
      const propMsgs = bundle.filter((t) => /https?:\/\//.test(t) || (/^\s*\[画像\]/.test(t) && !/【物件以外/.test(t)));
      if (!propMsgs.length) continue;
      const out: M[] = [];
      for (let k = j; k < list.length && list[k].sender !== "customer"; k++) {
        if (list[k].is_aix_generated) break;
        if (out.length && Date.parse(list[k].created_at) - Date.parse(out[out.length - 1].created_at) > 180_000) break;
        if (!/^\[(?:画像|スタンプ|動画)/.test((list[k].text ?? "").trim())) out.push(list[k]);
      }
      if (!out.length || (WRITER !== "all" && out[0].staff_writer !== WRITER)) continue;
      const first = !list.slice(0, i).some((m) => m.sender !== "customer");
      const its = splitRequests(bundle, list[i].created_at);
      rows.push({
        cid, at: list[i].created_at, first, form: bundle.some((t) => FORM_RE.test(t)), props: propMsgs.length, sns: propMsgs.some((t) => SNS_RE.test(t)),
        askPickup: its.some((x) => x.topic === "pickup") || bundle.some((t) => FORM_RE.test(t)) || bundle.some((t) => /良い物件|いい物件|他にも|他の物件|探して/.test(t)),
        out: out.map((m) => String(m.text ?? "")), kinds: out.map((m) => [...new Set(promisesInStaffText(m.text, m.created_at).map((p) => p.kind))]),
      });
    }
  }
  const order = (r: Row) => { const seen: PromiseKind[] = []; for (const ks of r.kinds) for (const k of ks) if (!seen.includes(k)) seen.push(k); return seen.map((k) => PROMISE_KIND_JA[k]).join("→") || "約束なし"; };
  const table = (name: string, rs: Row[]) => {
    const n: Record<number, number> = {}; for (const r of rs) n[r.out.length] = (n[r.out.length] ?? 0) + 1;
    const ord: Record<string, number> = {}; for (const r of rs) ord[order(r)] = (ord[order(r)] ?? 0) + 1;
    const both = rs.filter((r) => r.kinds.flat().includes("check") && r.kinds.flat().includes("pickup"));
    const bothSplit = both.filter((r) => r.out.length >= 2 && r.kinds.findIndex((k) => k.includes("check")) !== r.kinds.findIndex((k) => k.includes("pickup")));
    const opener2: Record<string, number> = {}; for (const r of rs) if (r.out[1]) { const o = r.out[1].trim().slice(0, 6); opener2[o] = (opener2[o] ?? 0) + 1; }
    const multi = rs.filter((r) => r.props >= 2);
    console.log(`\n■ ${name}: ${rs.length}番`);
    console.log(`  通の数: ${Object.entries(n).map(([k, v]) => `${k}通 ${v}`).join("・")}`);
    console.log(`  約束の順（通をまたいで）: ${Object.entries(ord).sort((a, b) => b[1] - a[1]).map(([k, v]) => `${k} ${v}`).join("／")}`);
    console.log(`  確認とピックアップの両方を約束 ${both.length}（別の通に分けた ${bothSplit.length}・確認が先 ${both.filter((r) => { const a = r.kinds.findIndex((k) => k.includes("check")), b = r.kinds.findIndex((k) => k.includes("pickup")); return a < b || (a === b && /確認[\s\S]*ピックアップ|募集状況[\s\S]*(?:探|ピックアップ)/.test(r.out[a] ?? "")); }).length}）`);
    console.log(`  2通目の書き出し: ${Object.entries(opener2).sort((a, b) => b[1] - a[1]).map(([k, v]) => `「${k}」${v}`).join("・") || "-"}`);
    console.log(`  物件2件以上 ${multi.length}: 件数を言った ${multi.filter((r) => COUNT_RE.test(r.out.join("\n"))).length}・「お送り頂きました物件」等の総称 ${multi.filter((r) => GENERIC_RE.test(r.out.join("\n"))).length}`);
    const sns = rs.filter((r) => r.sns);
    console.log(`  SNS・TikTok の画像 ${sns.length}: 総称で言った ${sns.filter((r) => GENERIC_RE.test(r.out.join("\n"))).length}`);
  };
  console.log(`== ${DAYS}日・書き手 ${WRITER}・お客様が物件（画像・URL）を送った番 ${rows.length}`);
  table("全部", rows);
  table("初回に物件＋条件フォーム", rows.filter((r) => r.first && r.form));
  table("初回に物件（フォームなし）", rows.filter((r) => r.first && !r.form));
  table("物件を複数", rows.filter((r) => r.props >= 2));
  table("確認と探す依頼が重なった（探す・他にも・フォーム）", rows.filter((r) => r.askPickup));
  const pick = SHOW === "form" ? rows.filter((r) => r.first && r.form) : SHOW === "multi" ? rows.filter((r) => r.props >= 2) : SHOW === "both" ? rows.filter((r) => r.askPickup) : SHOW === "sns" ? rows.filter((r) => r.sns) : [];
  for (const r of pick.slice(0, 40)) console.log(`\n${r.cid.slice(0, 6)} ${r.at.slice(5, 16)} 初回=${r.first} フォーム=${r.form} 物件${r.props} SNS=${r.sns} 順=${order(r)}\n${r.out.map((t, n) => `    [${n + 1}] ${t.replace(/\s+/g, " ").slice(0, 260)}`).join("\n")}`);
}
main().catch((e) => { console.error(e); process.exit(1); });
