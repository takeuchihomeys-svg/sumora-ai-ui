// AIX の2通目（AIXテンプレート）の型 — 成約データと直近の実送信（読み取りのみ）
//
// 2026-09-20 竹内「設計知見と協力して実際の成約データや直近の文のようになっているか確認」
//
// 設計知見「生成文が『実際に送っている文か』は、実送信の型を数字にして突き合わせる」。
//   生成を良い／悪いで判断する前に、**成約した会話の2通目**と**直近30日の2通目**で
//   要素ごとの出現率を出し、比較の基準を作る。
import { createClient } from "@supabase/supabase-js";

const sb = createClient(process.env.NEXT_PUBLIC_SUPABASE_URL ?? "", process.env.SUPABASE_SERVICE_ROLE_KEY ?? process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY ?? "");

/** 2通目の型（生成と突き合わせる要素） */
export const SECOND_ELEMENTS: Array<{ key: string; re: RegExp }> = [
  { key: "① 名前呼びかけ（〇〇さん）", re: /さん/ },
  { key: "② 挨拶（お世話に／お待たせ）", re: /お世話になっております|お待たせ(?:致|いた)?しました/ },
  { key: "③ 物件名・号室・🌟", re: /[0-9０-９]{2,4}号室|🌟/ },
  { key: "④ 条件の復唱（万・LDK・築・徒歩）", re: /[0-9０-９]{1,3}[\.．]?[0-9０-９]{0,2}万|[0-9０-９]{1,2}[LDKSldks]{1,4}|築[0-9０-９]{1,2}|徒歩[0-9０-９]{1,2}/ },
  { key: "⑤ 箇条書き（・2行以上）", re: /^[・･][^\n]*\n[\s\S]*^[・･]/m },
  { key: "⑥ オススメの一言（特に／かなり）", re: /特に[^\n。！!]{0,20}(?:オススメ|おすすめ)|かなり[^\n。！!]{0,12}(?:オススメ|おすすめ)/ },
  { key: "⑦ 内覧の誘導", re: /ご案内(?:させて(?:頂|いただ)き|いたし|致し)ます|ご内覧(?:頂|いただ)け/ },
  { key: "⑧ 申込の誘導", re: /お?申(?:し)?込[^\n。！!]{0,14}(?:押さえ|抑え|完了|進め)/ },
  { key: "⑨ お気に召されましたら", re: /お気に召され/ },
  { key: "⑩ 気軽に言ってもらう締め", re: /お気軽|お申し付け|いつでも(?:ご連絡|お知らせ)/ },
  { key: "⑪ ご査収", re: /ご査収/ },
  { key: "⑫ 何卒よろしく", re: /何卒(?:よろしく|宜しく)/ },
  { key: "⑬ 全力でサポート", re: /全力でサポート/ },
  { key: "⑭ ごゆっくりご検討", re: /ごゆっくりご(?:検討|確認|相談)/ },
  { key: "⑮ 絵文字（😊😌🙇🌟）", re: /😊|😌|🙇|🌟/ },
  { key: "⑯ ！！（二重）", re: /！！/ },
];

async function page(table: string, select: string, order: string, days: number): Promise<Array<Record<string, unknown>>> {
  const out: Array<Record<string, unknown>> = [];
  for (let p = 0; p < 16; p++) {
    const { data, error } = await sb.from(table).select(select)
      .gte(order, new Date(Date.now() - days * 86400_000).toISOString())
      .order(order, { ascending: false }).range(p * 1000, p * 1000 + 999);
    if (error) { console.log(`   ⚠ ${table}: ${error.message}`); break; }
    const r = (data ?? []) as unknown as Array<Record<string, unknown>>;
    if (r.length === 0) break;
    out.push(...r);
    if (r.length < 1000) break;
  }
  return out;
}
const q = (a: number[], p: number) => (a.length ? [...a].sort((x, y) => x - y)[Math.max(0, Math.min(a.length - 1, Math.floor(a.length * p)))] : NaN);
const lines = (s: string) => s.split("\n").filter((x) => x.trim()).length;

async function main() {
  const days = Number(process.env.DAYS ?? 180);
  const logs = await page("aix_usage_logs", "conversation_id, aix_type, sent_at, created_at", "created_at", days);
  const convIds = [...new Set(logs.map((l) => String(l.conversation_id ?? "")).filter(Boolean))];

  const msgs: Array<{ conversation_id: string; sender: string; text: string | null; created_at: string }> = [];
  for (let i = 0; i < convIds.length; i += 20) {
    const chunk = convIds.slice(i, i + 20);
    for (let p = 0; p < 12; p++) {
      const { data } = await sb.from("messages").select("conversation_id, sender, text, created_at")
        .in("conversation_id", chunk).eq("sender", "staff")
        .gte("created_at", new Date(Date.now() - days * 86400_000).toISOString())
        .order("created_at", { ascending: false }).range(p * 1000, p * 1000 + 999);
      const r = (data ?? []) as typeof msgs;
      if (r.length === 0) break;
      msgs.push(...r);
      if (r.length < 1000) break;
    }
  }
  const byConv = new Map<string, typeof msgs>();
  for (const m of msgs) {
    if (!byConv.has(m.conversation_id)) byConv.set(m.conversation_id, []);
    byConv.get(m.conversation_id)!.push(m);
  }
  for (const [, l] of byConv) l.sort((a, b) => Date.parse(a.created_at) - Date.parse(b.created_at));

  const { data: won } = await sb.from("conversations").select("id").eq("status", "closed_won").limit(3000);
  const wonIds = new Set(((won ?? []) as Array<{ id: string }>).map((r) => r.id));

  type S = { aix: string; text: string; at: number; won: boolean };
  const seconds: S[] = [];
  for (const l of logs) {
    const c = String(l.conversation_id ?? "");
    const t = Date.parse(String(l.sent_at ?? l.created_at));
    const list = (byConv.get(c) ?? []).filter((m) => (m.text ?? "").length > 15 && !/^\[/.test(m.text ?? ""));
    const first = list.find((m) => Math.abs(Date.parse(m.created_at) - t) <= 5 * 60_000);
    if (!first) continue;
    const ft = Date.parse(first.created_at);
    const second = list.find((m) => Date.parse(m.created_at) > ft && Date.parse(m.created_at) <= ft + 30 * 60_000);
    if (!second) continue;
    seconds.push({ aix: String(l.aix_type ?? "?"), text: String(second.text), at: Date.parse(second.created_at), whatever: 0, won: wonIds.has(c) } as unknown as S);
  }

  const recent30 = seconds.filter((s) => s.at >= Date.now() - 30 * 86400_000);
  const wonOnes = seconds.filter((s) => s.won);
  console.log(`=== AIX の2通目の型（直近${days}日 ${seconds.length}通 ／ 直近30日 ${recent30.length}通 ／ 成約した会話 ${wonOnes.length}通）===\n`);

  const show = (label: string, set: S[]) => {
    if (set.length === 0) return;
    const ls = set.map((s) => s.text.length);
    const ln = set.map((s) => lines(s.text));
    console.log(`── ${label}（${set.length}通）長さ 中央値 ${q(ls, 0.5)}字（75% ${q(ls, 0.75)}）・${q(ln, 0.5)}行`);
  };
  show("全体", seconds); show("直近30日", recent30); show("成約した会話", wonOnes);

  console.log(`\n   ${"要素".padEnd(32)} 全体    直近30日  成約`);
  for (const e of SECOND_ELEMENTS) {
    const p = (set: S[]) => (set.length ? `${((set.filter((s) => e.re.test(s.text)).length / set.length) * 100).toFixed(1)}%` : "-");
    console.log(`   ${e.key.padEnd(32)} ${p(seconds).padStart(6)}  ${p(recent30).padStart(6)}  ${p(wonOnes).padStart(6)}`);
  }

  // AIX 種類別（物件系だけ・生成の比較対象）
  console.log(`\n── AIX 種類別の型（主要4種・全体）`);
  for (const ty of ["property_recommendation", "property_send", "estimate_sheet", "property_check_result"]) {
    const set = seconds.filter((s) => s.aix === ty);
    if (set.length < 10) continue;
    const ls = set.map((s) => s.text.length);
    console.log(`\n   【${ty}】${set.length}通・中央値 ${q(ls, 0.5)}字・${q(set.map((s) => lines(s.text)), 0.5)}行`);
    for (const e of SECOND_ELEMENTS) {
      const n = set.filter((s) => e.re.test(s.text)).length;
      const pc = (n / set.length) * 100;
      if (pc < 5) continue;
      console.log(`     ${e.key.padEnd(32)} ${pc.toFixed(1)}%`);
    }
  }

  // 成約した会話の実物
  console.log(`\n── 成約した会話の2通目（8通・目で読む）`);
  for (const s of wonOnes.slice(0, 8)) {
    console.log(`     [${s.aix}] (${s.text.length}字) ${s.text.replace(/\n/g, " ／ ").slice(0, 130)}`);
  }
}
main().catch((e) => { console.error(e); process.exit(1); });
