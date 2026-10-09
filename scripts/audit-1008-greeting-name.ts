// scripts/audit-1008-greeting-name.ts — 竹内さんの決定（2026-10-08）②挨拶 ③1文字の名前 を実送信に当てて目で読む（読むだけ・LLM なし）
//   A. 挨拶: 人の手打ち（AIX を除く・テストの会話を除く）を「その日最初のこちらの会話文か」で分け、書き手ごとに「お世話になっております」の有無を数える
//   B. 画面の直し（refreshDraftGreetingForNow ensureDaily）を人の手打ちに「その送信の時刻で開いた下書き」として当てる → 変わる通（足す・外す）を数えて例を出す
//      （決定で変える向きなので「誤削除」ではなく、決定と人の送信の食い違いの数。壊れた文＝名前だけの行・空行の残り が出ないかを目で読む）
//   C. 1文字の名前: 会話の表示名で 旧の呼び名の決定（normalizeDisplayName）が "" → 新で1文字になる会話と、スタッフ（人）が実際に呼んだ名前
// 実行: npx tsx --env-file=.env.local scripts/audit-1008-greeting-name.ts [--days=120] [--show=25]
import { createClient } from "@supabase/supabase-js";
import { isTestConversation } from "../app/lib/test-conversations";
import { refreshDraftGreetingForNow } from "../app/lib/time-greeting";
import { staffTalkedToday } from "../app/lib/daily-greeting";
import { normalizeDisplayName, oneCharCallName } from "../app/lib/validate-reply";
import { staffCalledName } from "../app/lib/aix-staff-called-name";

const sb = createClient(process.env.NEXT_PUBLIC_SUPABASE_URL ?? "", process.env.SUPABASE_SERVICE_ROLE_KEY ?? process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY ?? "");
const arg = (k: string, d: string) => (process.argv.find((a) => a.startsWith(`--${k}=`)) ?? `--${k}=${d}`).split("=")[1];
const DAYS = Number(arg("days", "120"));
const SHOW = Number(arg("show", "25"));
const one = (t: string | null | undefined, n = 100) => (t ?? "").replace(/\d{2,4}-?\d{3,4}-?\d{3,4}/g, "***").replace(/\n/g, "⏎").slice(0, n);
const OSEWA = (t: string) => /お世話になっております/.test(t.split("\n").filter((l) => l.trim()).slice(0, 2).join("\n").slice(0, 60));
const MATERIAL = /^\s*(?:【|🌟|[①-⑳]\s*【|\[(?:画像|動画|スタンプ|ファイル|通話リクエスト)\]|https?:\/\/|（室内イメージ）)/u;
type Row = { id: string; conversation_id: string; sender: string; created_at: string; text: string | null; is_aix_generated: boolean | null; staff_writer: string | null };

(async () => {
  const since = new Date(Date.now() - (DAYS + 2) * 86_400_000).toISOString();
  const all: Row[] = [];
  for (let f = 0; ; f += 1000) {
    const { data, error } = await sb.from("messages").select("id, conversation_id, sender, created_at, text, is_aix_generated, staff_writer")
      .gte("created_at", since).order("created_at").order("id").range(f, f + 999);
    if (error) throw error;
    all.push(...((data ?? []) as Row[]));
    if ((data ?? []).length < 1000) break;
  }
  const byConv = new Map<string, Row[]>();
  for (const m of all) { if (isTestConversation(m.conversation_id)) continue; (byConv.get(m.conversation_id) ?? byConv.set(m.conversation_id, []).get(m.conversation_id)!).push(m); }
  const evalSince = Date.now() - DAYS * 86_400_000;

  // A・B
  const a = new Map<string, { first: number; firstOsewa: number; later: number; laterOsewa: number }>();
  const add: string[] = [], rem: string[] = [];
  const bCount = new Map<string, { add: number; rem: number; n: number }>();
  const broken: string[] = [];
  for (const [, msgs] of byConv) {
    msgs.forEach((m, i) => {
      if (m.sender !== "staff" || m.is_aix_generated || !m.text?.trim() || MATERIAL.test(m.text)) return;
      const at = Date.parse(m.created_at);
      if (at < evalSince) return;
      const w = m.staff_writer ?? "記録なし";
      const prev = msgs.slice(0, i).map((x) => ({ sender: x.sender, text: x.text, rawCreatedAt: x.created_at }));
      const talked = staffTalkedToday(prev, at);
      const s = a.get(w) ?? { first: 0, firstOsewa: 0, later: 0, laterOsewa: 0 };
      if (talked) { s.later++; if (OSEWA(m.text)) s.laterOsewa++; } else { s.first++; if (OSEWA(m.text)) s.firstOsewa++; }
      a.set(w, s);
      const r = refreshDraftGreetingForNow(m.text, { messages: prev, name: "", now: at, ensureDaily: true });
      const b = bCount.get(w) ?? { add: 0, rem: 0, n: 0 }; b.n++;
      if (r.text !== m.text) {
        const isAdd = r.fixes.some((f) => f.includes("足した"));
        if (isAdd) { b.add++; if (w === "takeuchi" && add.length < SHOW) add.push(`前: ${one(m.text)}\n     後: ${one(r.text)}`); }
        else { b.rem++; if (w === "takeuchi" && rem.length < SHOW) rem.push(`前: ${one(m.text)}\n     後: ${one(r.text)}`); }
        if (!r.text.trim() || /^\s*\n/.test(r.text) || /^[^\n]{1,15}さん\s*$/m.test(r.text.split("\n")[0])) broken.push(`${w} 前: ${one(m.text)}\n     後: ${one(r.text)}`);
      }
      bCount.set(w, b);
    });
  }
  console.log(`== A. 人の手打ち（${DAYS}日・資料文を除く）: その日最初の会話文か × 「お世話になっております」`);
  for (const [w, s] of a) console.log(`  ${w.padEnd(9)} 最初 ${s.first}通中 ${s.firstOsewa}（${Math.round((100 * s.firstOsewa) / Math.max(1, s.first))}%）／2通目以降 ${s.later}通中 ${s.laterOsewa}（${Math.round((100 * s.laterOsewa) / Math.max(1, s.later))}%）`);
  console.log(`\n== B. 画面の直し（必ず付ける・2回目以降は外す）を人の手打ちに当てた時に変わる通`);
  for (const [w, b] of bCount) console.log(`  ${w.padEnd(9)} ${b.n}通中 足す ${b.add}／外す ${b.rem}`);
  console.log(`  壊れた形（空・名前だけの行）: ${broken.length}`);
  for (const x of broken.slice(0, 20)) console.log("   ", x);
  console.log(`\n-- 竹内さんの送信で「足す」例`); for (const x of add) console.log("   ", x);
  console.log(`\n-- 竹内さんの送信で「外す」例`); for (const x of rem) console.log("   ", x);

  // C
  const convs: Array<{ id: string; customer_name: string | null }> = [];
  for (let f = 0; ; f += 1000) {
    const { data, error } = await sb.from("conversations").select("id, customer_name").range(f, f + 999);
    if (error) throw error;
    convs.push(...((data ?? []) as typeof convs));
    if ((data ?? []).length < 1000) break;
  }
  const hits: string[] = [];
  let agree = 0, differ = 0, noCall = 0;
  for (const c of convs) {
    if (isTestConversation(c.id)) continue;
    const off = (() => { process.env.ONE_CHAR_CALL_NAME = "off"; const v = normalizeDisplayName(c.customer_name); delete process.env.ONE_CHAR_CALL_NAME; return v; })();
    const now = normalizeDisplayName(c.customer_name);
    if (off || !now) continue;
    const { data: ms } = await sb.from("messages").select("sender, text, is_aix_generated").eq("conversation_id", c.id).eq("sender", "staff").order("created_at", { ascending: false }).limit(150);
    const human = ((ms ?? []) as Array<{ sender: string; text: string | null; is_aix_generated: boolean | null }>).filter((m) => !m.is_aix_generated).map((m) => ({ sender: "staff", text: m.text ?? "" }));
    const called = staffCalledName(human);
    const headCalls = human.filter((m) => new RegExp(`^[\\s「]*${now.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}さん`).test(m.text)).length;
    if (!called && headCalls === 0) noCall++; else if (called === now || headCalls > 0) agree++; else differ++;
    hits.push(`  表示名「${c.customer_name}」→ 新「${now}さん」（旧 呼ばない）・スタッフ（人）が冒頭で「${now}さん」と呼んだ ${headCalls}通・2回以上呼んだ名前「${called || "なし"}」 ${c.id.slice(0, 8)}`);
  }
  console.log(`\n== C. 1文字の名前: 旧は呼ばない→新で呼ぶ会話 ${hits.length}（スタッフも同じ名前で呼んでいる ${agree}／別の名前 ${differ}／スタッフの呼びかけなし ${noCall}）`);
  for (const h of hits) console.log(h);
  void oneCharCallName;
})().catch((e) => { console.error(e); process.exitCode = 1; });
