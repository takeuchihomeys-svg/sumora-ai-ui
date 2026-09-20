// 挨拶行「お世話になっております」をスタッフはいつ付けるか（読み取りのみ）
//
// 2026-09-20 竹内「はいやかしこまりましたの使い分け」→ 測ると締めと名前は実送信どおりで、
//   残るズレは**挨拶行**（お世話 → なし 94件 / お世話 → 名前 92件 ＝ 186件）だった。
//
// 設計知見「冒頭は『挨拶行』と『開口語』の二層で、根拠が異なる」:
//   挨拶行（お世話になっております／はじめまして／謝罪／夜間）は**接触の事実**
//   （当日送信済みか・初回か・催促か・時刻）だけで決める。
//   → その「接触の事実」ごとに、スタッフが実際に何を置くかを数える。
import { createClient } from "@supabase/supabase-js";

const sb = createClient(process.env.NEXT_PUBLIC_SUPABASE_URL ?? "", process.env.SUPABASE_SERVICE_ROLE_KEY ?? process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY ?? "");
const jstDay = (iso: string) => new Date(new Date(iso).getTime() + 9 * 3600_000).toISOString().slice(0, 10);
const jstHour = (iso: string) => new Date(new Date(iso).getTime() + 9 * 3600_000).getUTCHours();

/** 冒頭に何を置いたか */
function head(t: string, name: string): "お世話" | "はじめまして" | "名前のみ" | "名前+お世話" | "開口語" | "本題" {
  const lines = t.split("\n").map((x) => x.trim()).filter(Boolean);
  const first = lines[0] ?? "";
  const two = lines.slice(0, 2).join(" ");
  const hasName = !!name && first.includes(`${name}さん`);
  if (/はじめまして/.test(two)) return "はじめまして";
  if (hasName && /お世話になっております/.test(two)) return "名前+お世話";
  if (/^お世話になっております/.test(first)) return "お世話";
  if (hasName && /^[^\n]{0,14}さん[、,]?\s*$/.test(first)) return "名前のみ";
  if (hasName) return "名前のみ";
  if (/^(?:はい|かしこまりました|承知)/.test(first)) return "開口語";
  return "本題";
}

async function main() {
  const days = Number(process.env.DAYS ?? 120);
  const since = new Date(Date.now() - days * 86400_000).toISOString();
  const msgs: Array<{ conversation_id: string; sender: string; text: string | null; created_at: string }> = [];
  for (let p = 0; p < 28; p++) {
    const { data } = await sb.from("messages").select("conversation_id, sender, text, created_at")
      .gte("created_at", since).order("created_at", { ascending: true }).range(p * 1000, p * 1000 + 999);
    const r = (data ?? []) as typeof msgs;
    if (r.length === 0) break;
    msgs.push(...r);
    if (r.length < 1000) break;
  }
  const { data: convs } = await sb.from("conversations").select("id, customer_name").limit(6000);
  const nameOf = new Map<string, string>();
  for (const c of ((convs ?? []) as Array<{ id: string; customer_name: string | null }>)) {
    nameOf.set(c.id, (c.customer_name ?? "").replace(/[\s　]/g, ""));
  }
  const byConv = new Map<string, typeof msgs>();
  for (const m of msgs) {
    if (!byConv.has(m.conversation_id)) byConv.set(m.conversation_id, []);
    byConv.get(m.conversation_id)!.push(m);
  }

  // 接触の事実ごとに、冒頭に何を置いたかを数える
  type Key = "当日はじめて・返信" | "当日はじめて・こちらから" | "当日2通目以降・返信" | "当日2通目以降・こちらから";
  const table = new Map<Key, Map<string, number>>();
  const add = (k: Key, h: string) => {
    if (!table.has(k)) table.set(k, new Map());
    const m = table.get(k)!;
    m.set(h, (m.get(h) ?? 0) + 1);
  };
  let total = 0;
  for (const [cid, list] of byConv) {
    const name = nameOf.get(cid) ?? "";
    const sentToday = new Set<string>();
    for (let i = 0; i < list.length; i++) {
      const m = list[i];
      if (m.sender !== "staff" || !m.text) continue;
      if (/^\[(画像|動画|スタンプ|通話|ファイル)/.test(m.text) || m.text.trim().length < 6) continue;
      const day = jstDay(m.created_at);
      const firstToday = !sentToday.has(day);
      sentToday.add(day);
      // 直前がお客様の発言なら「返信」、スタッフ or 何も無ければ「こちらから」
      const prev = list.slice(0, i).reverse().find((x) => x.text && !/^\[/.test(x.text));
      const isReply = prev?.sender === "customer";
      const k: Key = firstToday
        ? (isReply ? "当日はじめて・返信" : "当日はじめて・こちらから")
        : (isReply ? "当日2通目以降・返信" : "当日2通目以降・こちらから");
      add(k, head(m.text, name));
      total++;
    }
  }
  console.log(`=== 直近${days}日 スタッフの送信（文字・6字以上）${total}通 ===`);
  console.log(`   冒頭に何を置いたか（設計知見「挨拶行は接触の事実だけで決める」の検証）\n`);
  const order: Key[] = ["当日はじめて・返信", "当日はじめて・こちらから", "当日2通目以降・返信", "当日2通目以降・こちらから"];
  for (const k of order) {
    const m = table.get(k);
    if (!m) continue;
    const n = [...m.values()].reduce((a, b) => a + b, 0);
    console.log(`── ${k}（${n}通）`);
    for (const [h, c] of [...m.entries()].sort((a, b) => b[1] - a[1])) {
      console.log(`     ${String(c).padStart(5)}通 (${((c / n) * 100).toFixed(1)}%)  ${h}`);
    }
    console.log("");
  }

  // 「当日はじめて」の中で何が「お世話になっております」を分けるのか。
  // greeting.ts の standard は「長い返信・重要な連絡・結果報告は固定」と言っている。
  // → ①本文の長さ ②前回スタッフ送信からの空白 で実際に分かれるかを測る。
  type Bucket = { n: number; greet: number };
  const byLen = new Map<string, Bucket>();
  const byGap = new Map<string, Bucket>();
  const lenLabel = (n: number) => n < 40 ? "① 〜40字" : n < 80 ? "② 40〜80字" : n < 150 ? "③ 80〜150字" : n < 300 ? "④ 150〜300字" : "⑤ 300字〜";
  const gapLabel = (h: number) => !Number.isFinite(h) ? "（前がない）" : h < 1 ? "① 1時間未満" : h < 6 ? "② 1〜6時間" : h < 24 ? "③ 6〜24時間" : h < 72 ? "④ 1〜3日" : "⑤ 3日以上";
  const bump = (m: Map<string, Bucket>, k: string, g: boolean) => {
    if (!m.has(k)) m.set(k, { n: 0, greet: 0 });
    const b = m.get(k)!; b.n++; if (g) b.greet++;
  };
  for (const [cid, list] of byConv) {
    const name = nameOf.get(cid) ?? "";
    const sentToday = new Set<string>();
    let lastStaffMs = NaN;
    for (let i = 0; i < list.length; i++) {
      const m = list[i];
      if (m.sender !== "staff" || !m.text) continue;
      const ms = new Date(m.created_at).getTime();
      const prevStaffMs = lastStaffMs;
      lastStaffMs = ms;
      if (/^\[/.test(m.text) || m.text.trim().length < 6) continue;
      const day = jstDay(m.created_at);
      const firstToday = !sentToday.has(day);
      sentToday.add(day);
      if (!firstToday) continue;
      const h = head(m.text, name);
      if (h === "はじめまして") continue; // 初回は別の挨拶行
      const greeted = h === "お世話" || h === "名前+お世話";
      bump(byLen, lenLabel(m.text.length), greeted);
      bump(byGap, gapLabel((ms - prevStaffMs) / 3600_000), greeted);
    }
  }
  const show = (title: string, m: Map<string, Bucket>) => {
    console.log(`\n── ${title}`);
    for (const [k, b] of [...m.entries()].sort()) {
      console.log(`     ${k.padEnd(14)} ${String(b.greet).padStart(4)}/${String(b.n).padStart(4)}通 = ${((b.greet / b.n) * 100).toFixed(1)}%`);
    }
  };
  console.log(`\n=== 「当日はじめて」の中で「お世話になっております」を付けた率 ===`);
  show(`本文の長さ別（greeting.ts の「長い返信は固定」の検証）`, byLen);
  show(`前回スタッフ送信からの空白別（設計知見「接触の事実」の検証）`, byGap);

  // 夜（21〜5時）だけ別に見る
  const night = new Map<string, number>();
  let nightN = 0;
  for (const [cid, list] of byConv) {
    const name = nameOf.get(cid) ?? "";
    for (const m of list) {
      if (m.sender !== "staff" || !m.text || m.text.trim().length < 6) continue;
      const h = jstHour(m.created_at);
      if (h >= 21 || h < 5) { night.set(head(m.text, name), (night.get(head(m.text, name)) ?? 0) + 1); nightN++; }
    }
  }
  console.log(`── 参考: 夜（21〜5時）の送信 ${nightN}通`);
  for (const [h, c] of [...night.entries()].sort((a, b) => b[1] - a[1])) {
    console.log(`     ${String(c).padStart(5)}通 (${((c / nightN) * 100).toFixed(1)}%)  ${h}`);
  }
}
main().catch((e) => { console.error(e); process.exit(1); });
