// scripts/recover-line-from-screening.ts — DB が止まっていた時間に届いて、こちら（sumora-ai-ui）に入らなかったお客様の LINE を、
//   screening-admin の DB（中継が同じ本文を送っている別の Supabase）から取り戻す（作業員M・2026-11-21・竹内さん「返信が来ているのにツールに反映されない」）。
//   screening-admin のコードには触らない。screening-admin の DB は読むだけ。こちらの DB へは --apply の時だけ書く（既定は数えるだけ）。
//   突き合わせ: screening-admin の messages（sender=customer・その時間の物）の line_message_id（無ければ message_id）が、こちらの messages に無い物＝取りこぼし。
//     会話の id は両方で同じ（sync-from-screening が screening-admin の conversations.id をそのまま使う）。こちらに会話が無い物は作らずに数えるだけ（--apply でも）。
//   書き込み: messages に sender=customer・text・line_message_id・created_at（screening-admin の時刻のまま）。一覧の最後の文は、こちらの会話がそれより古い時だけ直す。
//   本文は画面に出さない（会話の id の頭8字と数だけ）。申込以降の会話も同じに取り戻す（取りこぼしを埋めるだけで、判断はしない）。
//   要る環境変数: SCREENING_ADMIN_SUPABASE_URL と SCREENING_ADMIN_SUPABASE_SERVICE_ROLE_KEY（無ければ SCREENING_ADMIN_SUPABASE_ANON_KEY）・こちらの NEXT_PUBLIC_SUPABASE_URL と SUPABASE_SERVICE_ROLE_KEY
//   実行: npx tsx --env-file=<鍵のある .env> scripts/recover-line-from-screening.ts [--from=2026-11-19T10:58:00Z --to=2026-11-20T01:24:00Z]…（窓は何組でも）[--apply]
//     既定の窓: 11/18 13:12〜18:15 JST・11/19 19:58〜11/20 10:24 JST（DB が止まっていた時間・前後に15分の余白）
import { createClient } from "@supabase/supabase-js";

const argv = process.argv.slice(2);
const args = (k: string) => argv.filter((a) => a.startsWith(`--${k}=`)).map((a) => a.slice(k.length + 3));
const apply = argv.includes("--apply");
const jst = (s: string) => new Date(s.replace(" ", "T") + "+09:00");
const pad = 15 * 60_000;
const DEFAULT_WINDOWS: Array<[Date, Date]> = [
  [jst("2026-11-18 13:12"), jst("2026-11-18 18:15")],
  [jst("2026-11-19 19:58"), jst("2026-11-20 10:24")],
].map(([a, b]) => [new Date(a.getTime() - pad), new Date(b.getTime() + pad)] as [Date, Date]);
const froms = args("from"), tos = args("to");
const windows: Array<[Date, Date]> = froms.length ? froms.map((f, i) => [new Date(f), new Date(tos[i] ?? new Date().toISOString())]) : DEFAULT_WINDOWS;

const sUrl = process.env.SCREENING_ADMIN_SUPABASE_URL ?? "";
const sKey = process.env.SCREENING_ADMIN_SUPABASE_SERVICE_ROLE_KEY ?? process.env.SCREENING_ADMIN_SUPABASE_ANON_KEY ?? "";
if (!sUrl || !sKey) { console.error("SCREENING_ADMIN_SUPABASE_URL と SCREENING_ADMIN_SUPABASE_SERVICE_ROLE_KEY（か ANON_KEY）が要る"); process.exit(1); }
const screening = createClient(sUrl, sKey);
const ours = createClient(process.env.NEXT_PUBLIC_SUPABASE_URL ?? "", process.env.SUPABASE_SERVICE_ROLE_KEY ?? "");

type SMsg = { id: string; conversation_id: string; sender: string; text: string | null; created_at: string; line_message_id?: string | null; message_id?: string | null; image_url?: string | null };

async function main() {
  const missing: SMsg[] = [];
  let seen = 0;
  for (const [a, b] of windows) {
    for (let i = 0; ; i += 1000) {
      const { data, error } = await screening.from("messages").select("*").eq("sender", "customer")
        .gte("created_at", a.toISOString()).lte("created_at", b.toISOString()).order("created_at", { ascending: true }).range(i, i + 999);
      if (error) throw new Error(`screening-admin の messages を読めない: ${error.message}`);
      const rows = (data ?? []) as SMsg[];
      seen += rows.length;
      const ids = rows.map((r) => r.line_message_id || r.message_id).filter((x): x is string => !!x);
      const have = new Set<string>();
      for (let j = 0; j < ids.length; j += 200) {
        const { data: got, error: e2 } = await ours.from("messages").select("line_message_id").in("line_message_id", ids.slice(j, j + 200));
        if (e2) throw new Error(`こちらの messages を読めない: ${e2.message}`);
        for (const g of got ?? []) if (g.line_message_id) have.add(String(g.line_message_id));
      }
      for (const r of rows) { const k = r.line_message_id || r.message_id; if (k && !have.has(k)) missing.push(r); }
      if (rows.length < 1000) break;
    }
  }
  const byConv = new Map<string, SMsg[]>();
  for (const m of missing) byConv.set(m.conversation_id, [...(byConv.get(m.conversation_id) ?? []), m]);
  const convIds = [...byConv.keys()];
  const known = new Set<string>();
  for (let j = 0; j < convIds.length; j += 200) {
    const { data } = await ours.from("conversations").select("id").in("id", convIds.slice(j, j + 200));
    for (const c of data ?? []) known.add(String(c.id));
  }
  console.log(`# 取りこぼし（screening-admin のお客様の通 ${seen}・こちらに無い ${missing.length}・会話 ${byConv.size}・こちらに会話が無い ${convIds.filter((c) => !known.has(c)).length}）${apply ? "" : "（数えるだけ・--apply で書く）"}`);
  for (const [cid, list] of byConv) console.log(`- ${cid.slice(0, 8)}${known.has(cid) ? "" : "（こちらに会話なし・飛ばす）"}: ${list.length}通（${list[0].created_at.slice(5, 16)}〜${list[list.length - 1].created_at.slice(5, 16)}）`);
  if (!apply) return;
  let ins = 0;
  for (const [cid, list] of byConv) {
    if (!known.has(cid)) continue;
    for (const m of list) {
      const lmid = m.line_message_id || m.message_id || null;
      const { error } = await ours.from("messages").insert({ conversation_id: cid, sender: "customer", text: m.text ?? "", line_message_id: lmid, created_at: m.created_at, ...(m.image_url ? { image_url: m.image_url } : {}) });
      if (error && error.code !== "23505") { console.error(`- ${cid.slice(0, 8)}: 入れられない ${error.message}`); continue; }
      if (!error) ins++;
    }
    const last = list[list.length - 1];
    await ours.from("conversations").update({ last_message: last.text ?? "", last_sender: "customer", updated_at: last.created_at, is_flagged: true }).eq("id", cid).lt("updated_at", last.created_at);
  }
  console.log(`入れた ${ins}通（重なりは line_message_id の一意で飛ばした）`);
}
main().catch((e) => { console.error(e instanceof Error ? e.message : e); process.exit(1); });
