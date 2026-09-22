// 「こちらが送ってから、お客様がどう返すか」を実データで学ぶ（読み取りのみ）
// 2026-09-23 竹内「実際の成約データや直近のLINEもみて、送信の時間にたいしてどのように返信しているかも学べば
//   さらに質が良くなる。その返信や送信のバランスがより分かるから。返信したのとAIXも掛け合わせたらより鮮明になる」
//
// 設計知見「材料を足す前に、その材料は当たるのかを測る」「必須にしてよいのは過半数が守っている形だけ」に従い、
//   まず分布を出す。ブレインに渡すのはこの表と「今この会話は分布のどこにいるか」の2つだけにする
//   （promise-tracker の PROMISE_STATS と同じ作り）。
//
// 測ること:
//   ① 送信の種類（AIXの種類 / 手打ち）別: 返信率と返信までの時間（中央値・75%・90%）
//   ② 成約した会話としていない会話で、返信の速さ・送信のバランスが違うか
//   ③ 送った時間帯（JST）別の返信率と返信までの時間
//   ④ 返事が無い時、こちらが次に送るまでの時間（＝追いかけの実測）
//   ⑤ 会話あたりの こちら:お客様 の通数比
//
// 実行: npx tsx --env-file=.env.local scripts/audit-reply-timing.ts [DAYS=180]
import { createClient } from "@supabase/supabase-js";

const sb = createClient(process.env.NEXT_PUBLIC_SUPABASE_URL ?? "", process.env.SUPABASE_SERVICE_ROLE_KEY ?? process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY ?? "");
type Msg = { conversation_id: string; sender: string | null; text: string | null; created_at: string; is_aix_generated: boolean | null };
type Aix = { conversation_id: string; aix_type: string | null; created_at: string };
type Conv = { id: string; status: string | null };
const pct = (a: number, b: number) => (b === 0 ? "—" : `${((a / b) * 100).toFixed(1)}%`);
const q = (a: number[], p: number) => { const s = a.slice().sort((x, y) => x - y); return s[Math.min(s.length - 1, Math.floor(s.length * p))] ?? 0; };
const hStr = (h: number) => (h >= 48 ? `${(h / 24).toFixed(1)}日` : h < 1 ? `${Math.round(h * 60)}分` : `${h.toFixed(1)}時間`);
const jstHour = (iso: string) => new Date(Date.parse(iso) + 9 * 3600_000).getUTCHours();
/** 成約（申込以降まで進んだ会話）。ここまで来た会話を「うまくいった側」として比べる */
const WON = new Set(["closed_won", "contract", "approved", "screening", "applying"]);

async function page<T>(table: string, cols: string, since?: string): Promise<T[]> {
  const out: T[] = [];
  for (let p = 0; p < 80; p++) {
    let qb = sb.from(table).select(cols).order("created_at").range(p * 1000, p * 1000 + 999);
    if (since) qb = qb.gte("created_at", since);
    const { data, error } = await qb;
    if (error) { console.error(`${table}: ${error.message}`); break; }
    const r = (data ?? []) as T[]; out.push(...r); if (r.length < 1000) break;
  }
  return out;
}

async function main() {
  const days = Number(process.env.DAYS ?? 180);
  const since = new Date(Date.now() - days * 86400_000).toISOString();
  const msgs = await page<Msg>("messages", "conversation_id, sender, text, created_at, is_aix_generated", since);
  const aix = await page<Aix>("aix_usage_logs", "conversation_id, aix_type, created_at", since);
  const { data: convData } = await sb.from("conversations").select("id, status").limit(5000);
  const convs = (convData ?? []) as Conv[];
  const statusOf = new Map(convs.map((c) => [c.id, (c.status ?? "").trim()]));
  console.log(`直近${days}日: メッセージ ${msgs.length}通 ／ AIX ${aix.length}件 ／ 会話 ${convs.length}件`);
  console.log(`成約側とみなす状態: ${[...WON].join(" / ")}\n`);

  const byConv = new Map<string, Msg[]>();
  for (const m of msgs) { if (!byConv.has(m.conversation_id)) byConv.set(m.conversation_id, []); byConv.get(m.conversation_id)!.push(m); }
  const aixAt = new Map<string, Array<{ type: string; t: number }>>();
  for (const a of aix) {
    if (!aixAt.has(a.conversation_id)) aixAt.set(a.conversation_id, []);
    aixAt.get(a.conversation_id)!.push({ type: a.aix_type ?? "?", t: Date.parse(a.created_at) });
  }
  /** この送信は AIX か（送信時刻の ±3分に押下があれば紐付ける。classifyLastStaffTurn と同じ窓） */
  const aixTypeFor = (conv: string, t: number): string | null => {
    const hit = (aixAt.get(conv) ?? []).find((a) => Math.abs(a.t - t) <= 3 * 60_000);
    return hit ? hit.type : null;
  };

  /** こちらの送信1通ごとに「次にお客様が返したか・何時間後か」を作る */
  type Send = { conv: string; t: number; kind: string; won: boolean; hour: number; replyH: number | null; nextStaffH: number | null };
  const sends: Send[] = [];
  for (const [conv, list] of byConv) {
    const seq = list.filter((m) => (m.text ?? "").trim());
    const won = WON.has(statusOf.get(conv) ?? "");
    for (let i = 0; i < seq.length; i++) {
      if (seq[i].sender === "customer") continue;
      // 連投はまとめる（最後の1通を「送信」とみなす。30分以内の続きは同じ塊）
      const t = Date.parse(seq[i].created_at);
      const nextIsStaffBurst = i + 1 < seq.length && seq[i + 1].sender !== "customer"
        && Date.parse(seq[i + 1].created_at) - t < 30 * 60_000;
      if (nextIsStaffBurst) continue;
      const nextCust = seq.slice(i + 1).find((m) => m.sender === "customer");
      const nextStaff = seq.slice(i + 1).find((m) => m.sender !== "customer");
      const replyH = nextCust ? (Date.parse(nextCust.created_at) - t) / 3600_000 : null;
      const nextStaffH = nextStaff ? (Date.parse(nextStaff.created_at) - t) / 3600_000 : null;
      const at = aixTypeFor(conv, t);
      sends.push({ conv, t, kind: at ?? (seq[i].is_aix_generated ? "AIX(種別不明)" : "手打ち"), won, hour: jstHour(seq[i].created_at), replyH, nextStaffH });
    }
  }
  console.log(`こちらの送信（連投をまとめた後）${sends.length}通\n`);

  const row = (name: string, xs: Send[]) => {
    const rep = xs.map((x) => x.replyH).filter((v): v is number => v !== null);
    const within1 = rep.filter((h) => h <= 1).length, within24 = rep.filter((h) => h <= 24).length;
    return `   ${name.padEnd(26)} ${String(xs.length).padStart(5)}通 ／ 返信あり ${pct(rep.length, xs.length).padStart(6)} ／ 1時間以内 ${pct(within1, xs.length).padStart(6)} ／ 24時間以内 ${pct(within24, xs.length).padStart(6)} ／ 中央値 ${hStr(q(rep, 0.5)).padStart(7)} ／ 75% ${hStr(q(rep, 0.75)).padStart(7)} ／ 90% ${hStr(q(rep, 0.9))}`;
  };

  console.log(`① 送信の種類別（AIXの種類 / 手打ち）`);
  const kinds = [...new Set(sends.map((x) => x.kind))].sort((a, b) => sends.filter((x) => x.kind === b).length - sends.filter((x) => x.kind === a).length);
  for (const k of kinds) { const xs = sends.filter((x) => x.kind === k); if (xs.length >= 20) console.log(row(k, xs)); }

  console.log(`\n② 成約側（申込以降まで進んだ会話）と、それ以外`);
  console.log(row("成約側", sends.filter((x) => x.won)));
  console.log(row("それ以外", sends.filter((x) => !x.won)));

  console.log(`\n③ 送った時間帯（JST）別`);
  const bands: Array<[string, (h: number) => boolean]> = [
    ["早朝 5-8時", (h) => h >= 5 && h < 9], ["午前 9-11時", (h) => h >= 9 && h < 12],
    ["昼 12-14時", (h) => h >= 12 && h < 15], ["午後 15-17時", (h) => h >= 15 && h < 18],
    ["夜 18-20時", (h) => h >= 18 && h < 21], ["深夜 21-24時", (h) => h >= 21],
    ["未明 0-4時", (h) => h < 5],
  ];
  for (const [name, f] of bands) { const xs = sends.filter((x) => f(x.hour)); if (xs.length >= 20) console.log(row(name, xs)); }

  console.log(`\n④ 返事が無い時、こちらが次に送るまで（追いかけの実測）`);
  const noReply = sends.filter((x) => x.replyH === null || (x.nextStaffH !== null && x.nextStaffH < (x.replyH ?? Infinity)));
  const chase = noReply.map((x) => x.nextStaffH).filter((v): v is number => v !== null);
  console.log(`   返事より先にこちらが送った ${chase.length}回 ／ 中央値 ${hStr(q(chase, 0.5))} ／ 25% ${hStr(q(chase, 0.25))} ／ 75% ${hStr(q(chase, 0.75))} ／ 90% ${hStr(q(chase, 0.9))}`);
  const chaseWon = noReply.filter((x) => x.won).map((x) => x.nextStaffH).filter((v): v is number => v !== null);
  const chaseOther = noReply.filter((x) => !x.won).map((x) => x.nextStaffH).filter((v): v is number => v !== null);
  console.log(`   成約側 ${chaseWon.length}回・中央値 ${hStr(q(chaseWon, 0.5))} ／ それ以外 ${chaseOther.length}回・中央値 ${hStr(q(chaseOther, 0.5))}`);

  console.log(`\n⑤ 会話あたりの通数のバランス（こちら : お客様）`);
  const ratios: Array<{ won: boolean; staff: number; cust: number }> = [];
  for (const [conv, list] of byConv) {
    const staff = list.filter((m) => m.sender !== "customer").length;
    const cust = list.filter((m) => m.sender === "customer").length;
    if (staff + cust < 6) continue;
    ratios.push({ won: WON.has(statusOf.get(conv) ?? ""), staff, cust });
  }
  const show = (name: string, xs: typeof ratios) => {
    const r = xs.map((x) => x.staff / Math.max(x.cust, 1));
    console.log(`   ${name.padEnd(10)} ${String(xs.length).padStart(4)}会話 ／ こちら中央値 ${q(xs.map((x) => x.staff), 0.5)}通 ／ お客様中央値 ${q(xs.map((x) => x.cust), 0.5)}通 ／ 比の中央値 ${q(r, 0.5).toFixed(2)}`);
  };
  show("成約側", ratios.filter((x) => x.won));
  show("それ以外", ratios.filter((x) => !x.won));
}
main().catch((e) => { console.error(e); process.exit(1); });
