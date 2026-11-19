// scripts/build-hook-ledger.ts — 「こちらが物件・提案を送った → お客様の反応 → 竹内さん・スタッフの次の一手」の組の台帳（読むだけ・LLM なし・費用0・作業員16・2026-11-12）
//   竹内さん 11/12「ここの部分細かく細分化して強化していく。足りない部分あれば土台をつくっていく」（送った部分の刺さりの読みと、そこからの次の一手）。
//   純関数: app/lib/our-send-uptake.ts（部分・刺さり）・app/lib/next-move-types.ts（nextMoveFromText＝返信の文からの次の一手の網・198通で 151/198）。
//   決まり: JST 22〜9 時だけ動く（営業時間は DB の重い読みをしない）。DB は1日ずつの範囲（messages の created_at）と、会話ごとの件数を絞った索引の読みだけ。
//           申込の門（turn-application-gate）と申込の書類の語で外す・名前と物件名は伏せる・外部の API に渡さない・出力は exam-cache/hook-ledger/ の手元の json と md だけ。
// 実行: npx tsx --env-file=<.env> scripts/build-hook-ledger.ts [--days=90] [--per-day=200] [--per-conv=3] [--out-dir=<exam-cache/hook-ledger>]
//       数え直しだけ: npx tsx scripts/build-hook-ledger.ts --recount=<ledger の json>（DB を読まない・いつでも可）
import { readFileSync, writeFileSync, mkdirSync, existsSync } from "node:fs";
import { join } from "node:path";
import { splitOurSend, readUptake, type HookPoint, type HookDegree } from "../app/lib/our-send-uptake";
import { nextMoveFromText, NEXT_DEST_LABEL, type NextMove } from "../app/lib/next-move-types";

const arg = (k: string, d = "") => process.argv.find((a) => a.startsWith(`--${k}=`))?.slice(k.length + 3) ?? d;
const CACHE = join(__dirname, "..", "..", "..", "exam-cache");
const OUT_DIR = arg("out-dir", join(CACHE, "hook-ledger"));

export type HookCombo = "mixed" | "ask_other" | "taken_worry" | "comparing" | "plain";
export type LedgerRow = {
  conv: string; sentAt: string; customerAt: string;
  send: string; customer: string; reply: string; replyIsAix: boolean;
  hook: "hooked" | "neutral" | "not_hooked"; points: HookPoint[]; notPoints: HookPoint[]; degree: HookDegree | null; combos: HookCombo[];
  move: NextMove;
};

const PROPERTY_SEND_RE = /号室|🌟|（オススメポイント）/;
const APPLY_DOC = /本人確認|免許証|保険証|マイナンバー|生年月日|年収|源泉|勤務先の電話|緊急連絡先の|申込書|申込フォーマット/;
const ASK_OTHER_RE = /他に|ほかに|他にも|別の(?:物件|お部屋)|他の(?:物件|候補|お部屋)/;
const TAKEN_RE = /取られ|埋ま(?:る|っ)|無くな|なくな|先に申込/;
const COMPARE_RE = /比べ|迷っ|どっち|どちら|他にもっと|悩ん/;

/** 送った文から物件名を拾う（🌟の行・「〇〇 502号室」の〇〇）。同じ組の3つの文の全部で伏せる */
export function propertyNamesOf(...texts: string[]): string[] {
  const names = new Set<string>();
  for (const t of texts) {
    for (const m of String(t ?? "").matchAll(/🌟\s*([^\n]{2,40}?)\s*[0-9０-９A-Za-z]{0,5}号?室?(?:\n|$)/g)) names.add(m[1].trim());
    for (const m of String(t ?? "").matchAll(/([A-Za-zＡ-Ｚａ-ｚァ-ヶー一-龠・ⅠⅡⅢ.\s]{3,30}?)\s?[0-9０-９A-Za-z]{1,5}号室/g)) names.add(m[1].trim());
  }
  return [...names].filter((n) => n.length >= 3 && !/お部屋|こちら|物件/.test(n)).sort((a, b) => b.length - a.length);
}
export function maskLedgerText(s: string, maskPII: (t: string) => string, propertyNames: readonly string[] = []): string {
  let out = String(s ?? "");
  for (const n of propertyNames) out = out.split(n).join("〈物件〉");
  return maskPII(out)
    .replace(/[^\s　「」『』（）()！!。、・\n]{1,8}(?:さん|様)/g, "YUMAさん")
    .replace(/🌟[^\n]{1,40}/g, "🌟〈物件〉")
    .replace(/[^\s　「」『』（）()！!。、・\n]{2,30}?\s?[0-9０-９A-Za-z]{1,5}号室/g, "〈物件〉号室")
    .replace(/https?:\/\/\S+/g, "〈URL〉");
}

export function classifyRow(send: string, customer: string, reply: string): Pick<LedgerRow, "hook" | "points" | "notPoints" | "degree" | "combos" | "move"> {
  const ups = readUptake(splitOurSend(send), customer);
  const hooks = ups.map((u) => u.hook).filter((h): h is NonNullable<typeof h> => !!h);
  const hooked = hooks.filter((h) => h.kind === "hooked");
  const not = hooks.filter((h) => h.kind === "not_hooked");
  const points = [...new Set(ups.filter((u) => u.uptake === "answered").flatMap((u) => u.part.points))] as HookPoint[];
  const notPoints = [...new Set(not.map((h) => h.reason).filter((x): x is HookPoint => !!x))];
  const rank = { curious: 1, strong: 2, decide: 3 } as const;
  const degree = hooked.reduce<HookDegree | null>((a, h) => (h.degree && (!a || rank[h.degree] > rank[a]) ? h.degree : a), null);
  const combos: HookCombo[] = [];
  if (hooked.length && notPoints.length) combos.push("mixed");
  if (ASK_OTHER_RE.test(customer)) combos.push("ask_other");
  if (TAKEN_RE.test(customer)) combos.push("taken_worry");
  if (COMPARE_RE.test(customer)) combos.push("comparing");
  if (!combos.length) combos.push("plain");
  const hook = hooked.length ? "hooked" : notPoints.length ? "not_hooked" : "neutral";
  return { hook, points, notPoints, degree, combos, move: nextMoveFromText(reply) };
}

/** 型ごとの数え（刺さり×点×強さ×組み合わせ → 次の一手） */
export function aggregate(rows: readonly LedgerRow[]): Array<{ key: string; n: number; small: boolean; moves: Array<[string, number]>; example: string }> {
  const m = new Map<string, { n: number; moves: Map<string, number>; ex: string }>();
  for (const r of rows) {
    const pt = r.hook === "not_hooked" ? `外:${r.notPoints.join("+") || "?"}` : r.points.slice(0, 2).join("+") || "点不明";
    const key = `${r.hook}|${pt}|${r.degree ?? "-"}|${r.combos.join("+")}`;
    const e = m.get(key) ?? { n: 0, moves: new Map(), ex: "" };
    e.n++;
    const mk = `${NEXT_DEST_LABEL[r.move.dest]}×${r.move.strength}×${r.move.timing}`;
    e.moves.set(mk, (e.moves.get(mk) ?? 0) + 1);
    if (!e.ex) e.ex = `客「${r.customer.replace(/\s+/g, " ").slice(0, 50)}」→「${r.reply.replace(/\s+/g, "").slice(0, 60)}」`;
    m.set(key, e);
  }
  return [...m.entries()].map(([key, e]) => ({ key, n: e.n, small: e.n < 5, moves: [...e.moves.entries()].sort((a, b) => b[1] - a[1]), example: e.ex })).sort((a, b) => b.n - a.n);
}

function report(rows: readonly LedgerRow[]): string {
  const ag = aggregate(rows);
  const lines = [`# 刺さりと次の一手の台帳（${rows.length}組・刺さり×点×強さ×組み合わせ）`, "", "| 型 | 通 | 少 | 次の一手（多い順） | 例（伏せ済み） |", "|---|---|---|---|---|"];
  for (const a of ag) lines.push(`| ${a.key} | ${a.n} | ${a.small ? "△5未満" : ""} | ${a.moves.slice(0, 3).map(([k, v]) => `${k} ${v}`).join("／")} | ${a.example.replace(/\|/g, "／")} |`);
  return lines.join("\n");
}

async function build(): Promise<LedgerRow[]> {
  const h = new Date(Date.now() + 9 * 3600_000).getUTCHours();
  if (h >= 9 && h < 22) { console.error(`今は JST ${h} 時＝営業時間。22〜9時に流す（DB の範囲の読みのため）`); process.exit(2); }
  const { createClient } = await import("@supabase/supabase-js");
  const { loadTurnApplicationRecords } = await import("../app/lib/turn-application-gate-server");
  const { turnApplicationReason } = await import("../app/lib/turn-application-gate");
  const { applicationMaterialReason } = await import("../app/lib/test-pii-guard");
  const { maskPII } = await import("../app/lib/pii-mask");
  const sb = createClient(process.env.NEXT_PUBLIC_SUPABASE_URL ?? "", process.env.SUPABASE_SERVICE_ROLE_KEY ?? "", { auth: { persistSession: false } });
  const days = Number(arg("days", "90")), perDay = Number(arg("per-day", "200")), perConv = Number(arg("per-conv", "3"));
  type Msg = { id: string; conversation_id: string; created_at: string; sender: string; text: string | null; is_aix_generated: boolean | null };
  const sends = new Map<string, Msg[]>();
  for (let d = 0; d < days; d++) {
    const to = new Date(Date.now() - d * 86400_000), from = new Date(to.getTime() - 86400_000);
    const { data, error } = await sb.from("messages").select("id, conversation_id, created_at, sender, text, is_aix_generated")
      .neq("sender", "customer").gte("created_at", from.toISOString()).lt("created_at", to.toISOString()).ilike("text", "%号室%").order("created_at", { ascending: false }).limit(perDay);
    if (error) { console.warn(`日 ${d}: ${error.message}`); continue; }
    for (const m of (data ?? []) as Msg[]) { const a = sends.get(m.conversation_id) ?? []; if (a.length < perConv * 4) a.push(m); sends.set(m.conversation_id, a); }
    await new Promise((r) => setTimeout(r, 120));
  }
  const rows: LedgerRow[] = [];
  let gated = 0, noReply = 0;
  for (const [conv, list] of sends) {
    const rec = await loadTurnApplicationRecords(sb, conv);
    // 同じ会話で10分以内に続いた送信は1つの塊（最後の送信の後を見る）。新しい順から perConv 塊
    const sorted = [...list].sort((a, b) => a.created_at.localeCompare(b.created_at));
    const bursts: Msg[][] = [];
    for (const m of sorted) { const last = bursts[bursts.length - 1]; if (last && Date.parse(m.created_at) - Date.parse(last[last.length - 1].created_at) < 600_000) last.push(m); else bursts.push([m]); }
    for (const b of bursts.slice(-perConv)) {
      const end = b[b.length - 1].created_at;
      const { data } = await sb.from("messages").select("id, conversation_id, created_at, sender, text, is_aix_generated").eq("conversation_id", conv).gt("created_at", end).order("created_at", { ascending: true }).limit(12);
      const after = (data ?? []) as Msg[];
      let i = 0; while (i < after.length && after[i].sender !== "customer") i++; // 塊の後の送信の続き（画像・URL）を飛ばす
      const cust: Msg[] = []; while (i < after.length && after[i].sender === "customer") cust.push(after[i++]);
      const rep: Msg[] = []; while (i < after.length && after[i].sender !== "customer") rep.push(after[i++]);
      if (!cust.length || !rep.length || Date.parse(cust[0].created_at) - Date.parse(end) > 3 * 86400_000) { noReply++; continue; }
      const send = b.map((x) => x.text ?? "").join("\n"), customer = cust.map((x) => x.text ?? "").join("\n"), reply = rep.map((x) => x.text ?? "").join("\n");
      if (!PROPERTY_SEND_RE.test(send) || turnApplicationReason(rec, cust[0].created_at) || [send, customer, reply].some((t) => APPLY_DOC.test(t) || applicationMaterialReason(t))) { gated++; continue; }
      const names = propertyNamesOf(send, customer, reply);
      const mk = (t: string) => maskLedgerText(t, (x) => maskPII(x), names).slice(0, 1200);
      const ms = mk(send), mc = mk(customer), mr = mk(reply);
      rows.push({ conv: conv.slice(0, 8), sentAt: end, customerAt: cust[0].created_at, send: ms, customer: mc, reply: mr, replyIsAix: rep.some((x) => !!x.is_aix_generated), ...classifyRow(ms, mc, mr) });
    }
    await new Promise((r) => setTimeout(r, 80));
  }
  console.log(`会話 ${sends.size}・組 ${rows.length}・申込の門で外した ${gated}・反応か返信が無い ${noReply}`);
  return rows;
}

if (require.main === module) (async () => {
  let rows: LedgerRow[];
  const recount = arg("recount");
  if (recount) rows = (JSON.parse(readFileSync(recount, "utf8")) as LedgerRow[]).map((r) => ({ ...r, ...classifyRow(r.send, r.customer, r.reply) }));
  else rows = await build();
  if (!existsSync(OUT_DIR)) mkdirSync(OUT_DIR, { recursive: true });
  const stamp = new Date().toISOString().slice(0, 10);
  if (!recount) writeFileSync(join(OUT_DIR, `hook-ledger-${stamp}.json`), JSON.stringify(rows, null, 1));
  const md = report(rows);
  writeFileSync(join(OUT_DIR, `hook-ledger-${stamp}.md`), md);
  console.log(md.split("\n").slice(0, 40).join("\n"));
})().catch((e) => { console.error(e); process.exit(1); });
