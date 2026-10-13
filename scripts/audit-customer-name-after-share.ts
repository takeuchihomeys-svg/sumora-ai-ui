// scripts/audit-customer-name-after-share.ts — 持ち込み（URL・画像・動画）の後にお客様が「名前だけ」を送った番を数え、
//   customerNamedAfterShare（app/lib/customer-property-names.ts）が正しく結べるか・誤って別の物件に結ぶ事が無いかを確かめる（読み取りのみ・LLM なし・$0）
//
// 2026-10-13 竹内（未桜）「動画の URL が送られてきたけど、それが物件の URL で『レジュールアッシュ難波MINAMI』と把握できていない」
//
// 正解: こちらの次の返事（72時間以内のスタッフの本文・AIX の property_names / 本文）がその名前（建物の鍵）で受けたか。
//   受けた＝正しく結べた／受けていない＝目で読む（誤り候補）。
// 取りこぼし: 持ち込みの後 72 時間以内のお客様の短い1行（40字以下）で、検出しなかったが、こちらの次の返事にその発言のカタカナ・英字の語（4字以上）が出た物。
//
// 実行: npx tsx --env-file=.env.local scripts/audit-customer-name-after-share.ts [--days=60] [--show=40]
import { createClient } from "@supabase/supabase-js";

const sb = createClient(process.env.NEXT_PUBLIC_SUPABASE_URL ?? "", process.env.SUPABASE_SERVICE_ROLE_KEY ?? process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY ?? "");
const arg = (k: string, d = "") => (process.argv.find((a) => a.startsWith(`--${k}=`)) ?? `--${k}=${d}`).split("=").slice(1).join("=");
const one = (s: string | null | undefined, n = 90) => String(s ?? "").replace(/\s*\n\s*/g, " / ").slice(0, n);
const ms = (s: string | null | undefined) => (s ? Date.parse(s) : NaN);

type Msg = { conversation_id: string; sender: string; text: string | null; image_url: string | null; created_at: string; is_aix_generated: boolean | null };
type Aix = { conversation_id: string; created_at: string; aix_type: string | null; property_names: string[] | null; generated_text: string | null };

async function pageAll<T>(q: (from: number, to: number) => PromiseLike<{ data: T[] | null; error: { message: string } | null }>): Promise<T[]> {
  const out: T[] = [];
  for (let from = 0; ; from += 1000) {
    const { data, error } = await q(from, from + 999);
    if (error) throw new Error(error.message);
    out.push(...(data ?? []));
    if (!data || data.length < 1000) break;
  }
  return out;
}

/** --promise: こちらの手打ちの確認の約束から取った物件名（【必ず】の行の（）に入る名前）を全部出す＝目で読む */
async function promiseNames() {
  const days = Number(arg("days", "60"));
  const since = new Date(Date.now() - days * 86400_000).toISOString();
  const { classifyStaffTextFacts } = await import("../app/lib/action-ledger");
  const { isTestConversation } = await import("../app/lib/test-conversations");
  const rows = await pageAll<{ conversation_id: string; text: string | null; created_at: string }>((a, b) => sb.from("messages").select("conversation_id, text, created_at").eq("sender", "staff").eq("is_aix_generated", false).gte("created_at", since).ilike("text", "%確認%").range(a, b));
  let promises = 0, named = 0;
  const out: string[] = [];
  for (const r of rows) {
    if (isTestConversation(r.conversation_id)) continue;
    const es = classifyStaffTextFacts(r.text ?? "", r.created_at).filter((e) => e.kind === "confirmation_promised");
    if (!es.length) continue;
    promises++;
    const n = es.find((e) => e.detail.propertyName)?.detail.propertyName;
    if (n) { named++; out.push(`${r.conversation_id.slice(0, 8)} ${r.created_at.slice(5, 16)} 名前「${n}」（要件 ${es[0].detail.object ?? "-"}） ← ${one(r.text, 110)}`); }
  }
  console.log(`手打ちの確認の約束 ${promises} 通・物件名を取れた ${named} 通（${days}日）`);
  for (const l of out) console.log("  " + l);
}

async function main() {
  if (process.argv.includes("--promise")) return promiseNames();
  const days = Number(arg("days", "60"));
  const show = Number(arg("show", "40"));
  const since = new Date(Date.now() - days * 86400_000).toISOString();
  const ctxSince = new Date(Date.now() - (days + 3) * 86400_000).toISOString();
  const { isTestConversation } = await import("../app/lib/test-conversations");
  const { customerNamedAfterShare, nameOnlyMessage } = await import("../app/lib/customer-property-names");
  const { buildingKeyOf } = await import("../app/lib/customer-state");

  const shares = await pageAll<{ conversation_id: string }>((a, b) => sb.from("messages").select("conversation_id").eq("sender", "customer").gte("created_at", since)
    .or("text.ilike.%http%,text.ilike.[画像]%,text.ilike.[動画]%,image_url.not.is.null").range(a, b));
  const convIds = [...new Set(shares.map((r) => r.conversation_id))].filter((id) => !isTestConversation(id));
  console.log(`持ち込みのある会話 ${convIds.length}（${days}日）`);

  let detected = 0, confirmed = 0, notConfirmed = 0, missed = 0;
  const confirmedRows: string[] = [], notRows: string[] = [], missedRows: string[] = [];
  const BATCH = 8;
  for (let i = 0; i < convIds.length; i += BATCH) {
    await Promise.all(convIds.slice(i, i + BATCH).map(async (cid) => {
      const [msgs, aix] = await Promise.all([
        pageAll<Msg>((a, b) => sb.from("messages").select("conversation_id, sender, text, image_url, created_at, is_aix_generated").eq("conversation_id", cid).gte("created_at", ctxSince).order("created_at").range(a, b)),
        pageAll<Aix>((a, b) => sb.from("aix_usage_logs").select("conversation_id, created_at, aix_type, property_names, generated_text").eq("conversation_id", cid).gte("created_at", ctxSince).range(a, b)),
      ]);
      const ordered = msgs.map((m) => ({ ...m, text: m.text ?? (m.image_url ? "[画像]" : "") }));
      const staffAfter = (at: string, hours: number) => {
        const t0 = ms(at), t1 = t0 + hours * 3600_000;
        const texts = ordered.filter((m) => m.sender === "staff" && ms(m.created_at) > t0 && ms(m.created_at) <= t1).map((m) => m.text ?? "");
        const ax = aix.filter((a) => ms(a.created_at) > t0 && ms(a.created_at) <= t1).flatMap((a) => [...(a.property_names ?? []), a.generated_text ?? ""]);
        return [...texts, ...ax];
      };
      const cands = customerNamedAfterShare(ordered.map((m) => ({ sender: m.sender, text: m.text, createdAt: m.created_at })));
      const candAt = new Set<string>();
      for (const c of cands) {
        if (!c.at || ms(c.at) < ms(since)) continue;
        candAt.add(c.at);
        detected++;
        const key = buildingKeyOf(c.name);
        const k5 = key.slice(0, Math.min(5, key.length));
        const after = staffAfter(c.at, 72);
        const hit = after.some((s) => { const sk = buildingKeyOf(s); return sk.includes(key) || (k5.length >= 4 && sk.includes(k5)); });
        const nextStaff = ordered.filter((m) => m.sender === "staff" && ms(m.created_at) > ms(c.at!) && (m.text ?? "").trim() && !/^\s*\[画像\]\s*$/.test(m.text ?? "")).slice(0, 2).map((m) => m.text).join(" ｜ ");
        const nextAix = aix.filter((a) => ms(a.created_at) > ms(c.at!) && ms(a.created_at) - ms(c.at!) <= 72 * 3600_000).map((a) => `${a.aix_type}:${(a.property_names ?? []).join("・")}`).join(" ");
        const row = `${cid.slice(0, 8)} ${c.at.slice(5, 16)} 名前「${c.label}」 起点 ${c.sharedAt?.slice(5, 16)} ${c.url ? one(c.url, 40) : "(画像)"}\n     次のこちら: ${one(nextStaff, 140)}${nextAix ? `\n     AIX: ${one(nextAix, 120)}` : ""}`;
        if (hit) { confirmed++; confirmedRows.push(row); } else { notConfirmed++; notRows.push(row); }
      }
      // 取りこぼし候補
      let shareT = NaN;
      for (const m of ordered) {
        if (m.sender !== "customer") continue;
        const t = m.text ?? "";
        if (/https?:\/\/|^\s*\[(?:画像|動画)\]/.test(t)) { shareT = ms(m.created_at); continue; }
        if (!Number.isFinite(shareT) || ms(m.created_at) - shareT > 72 * 3600_000 || ms(m.created_at) < ms(since)) continue;
        if (candAt.has(m.created_at) || t.length > 40 || t.includes("\n") || nameOnlyMessage(t)) continue;
        const words = (t.normalize("NFKC").match(/[ァ-ヶー]{4,}|[A-Za-z]{4,}/g) ?? []);
        if (!words.length) continue;
        const nextStaff = ordered.filter((x) => x.sender === "staff" && ms(x.created_at) > ms(m.created_at) && ms(x.created_at) - ms(m.created_at) <= 24 * 3600_000).slice(0, 2).map((x) => (x.text ?? "").normalize("NFKC")).join(" ");
        if (words.some((w) => nextStaff.includes(w))) { missed++; missedRows.push(`${cid.slice(0, 8)} ${m.created_at.slice(5, 16)} 「${one(t, 40)}」 → こちら: ${one(nextStaff, 80)}`); }
      }
    }));
  }
  console.log(`\n検出（持ち込みの後の名前だけ）: ${detected}\n  こちらがその名前で受けた: ${confirmed}\n  受けていない（目で読む）: ${notConfirmed}\n取りこぼし候補（検出しなかったが、こちらが同じ語で受けた）: ${missed}`);
  console.log(`\n── 受けた（${confirmedRows.length}）──`); for (const r of confirmedRows.slice(0, show)) console.log("  " + r);
  console.log(`\n── 受けていない（${notRows.length}）──`); for (const r of notRows.slice(0, show)) console.log("  " + r);
  console.log(`\n── 取りこぼし候補（${missedRows.length}）──`); for (const r of missedRows.slice(0, show)) console.log("  " + r);
}
main().catch((e) => { console.error(e); process.exit(1); });
