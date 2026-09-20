// 「スタッフが締めを送る → お客様が短いお礼・了承だけ返す」その後、スタッフは何をしているか（読み取りのみ）
//
// 2026-09-21 竹内「生成した文は送った内容と同じ内容を再度送っていた形となるので、これを防ぐ」
//
// YUMA テスト（scripts/yuma-repeat-test.ts）で、この場面の生成が
//   ・直前の締めの焼き直し（2/6）
//   ・場面と関係ない文（「お電話大丈夫です！！」3/6・ブレインの phone_call が本文に出た）
// になった。**直す前に、実際のスタッフがこの場面で何をしているか**を測る。
//
// 設計知見「実送信で線を引く」「必須にしてよいのは過半数が守っている形だけ」に従う。
//   もしスタッフの過半数が**返信していない**なら、直すべきは文の中身ではなく「下書きを出すかどうか」。
//
// 実行: npx tsx --env-file=.env.local scripts/audit-after-ack.ts
import { createClient } from "@supabase/supabase-js";
import { predicateOf, splitClauses } from "../app/lib/phrase-shape";
import { extractConcreteFacts } from "../app/lib/previous-send-note";

const sb = createClient(process.env.NEXT_PUBLIC_SUPABASE_URL ?? "", process.env.SUPABASE_SERVICE_ROLE_KEY ?? process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY ?? "");

async function page(table: string, select: string, order: string, days: number | null) {
  const out: Array<Record<string, unknown>> = [];
  for (let p = 0; p < 30; p++) {
    let q = sb.from(table).select(select).order(order, { ascending: false }).range(p * 1000, p * 1000 + 999);
    if (days) q = q.gte(order, new Date(Date.now() - days * 86400_000).toISOString());
    const { data, error } = await q;
    if (error) { console.log(`   ⚠ ${table}: ${error.message}`); break; }
    const r = (data ?? []) as unknown as Array<Record<string, unknown>>;
    if (r.length === 0) break;
    out.push(...r);
    if (r.length < 1000) break;
  }
  return out;
}

/** お客様の「短いお礼・了承だけ」（中身が無い返事） */
const SHORT_ACK_RE = /^(?:[はハ]い|うん|りょ|了解|承知|わかりました|分かりました|かしこまりました|ありがとう(?:ございます|ございました)?|あざす|OK|ok|オッケー|よろしくお願いします|宜しくお願いします|お願いします)?[\s！!。、😊😌🙇🙏👍✨💦🥹😭❤️]*$/;
function isShortAck(t: string): boolean {
  const s = t.trim();
  if (!s || s.length > 30) return false;
  if (/[?？]/.test(s)) return false;
  return SHORT_ACK_RE.test(s.replace(/\s+/g, ""));
}

/** スタッフの「締め」（次の作業の宣言が無く、締めの言い回しで終わる送信） */
const CLOSING_RE = /(?:お気軽に(?:ご連絡|ご質問|お申し付け)|何卒(?:よろしく|宜しく)お願い|ご返答お待ちして|ご連絡お待ちして|ごゆっくりご検討|ご査収ください)/;
/** 次にこちらがやる事の宣言（これが有る間は「締め」ではなく約束の途中） */
const PROMISE_RE = /(?:ピックアップ|お探し|探させて|確認(?:して|させて|致します)|お調べ|ご連絡させて頂きます|お送りさせて頂きます|作成(?:して|させて))/;

const mask = (s: string) => s.replace(/[^\s、。！!？?]{1,12}(?:さん|様|さま)/g, "〈お客様〉").replace(/\n/g, " ／ ");

async function main() {
  const days = Number(process.env.DAYS ?? 180);
  const msgs = await page("messages", "conversation_id, sender, text, created_at", "created_at", days);
  console.log(`=== 材料: messages ${msgs.length}件（直近${days}日）===`);

  // 会話のステータス（段階で返信率が割れるなら、その条件で「下書きを出さない」線が引ける）
  const convs = await page("conversations", "id, status", "created_at", null);
  const statusOf = new Map<string, string>();
  for (const c of convs) statusOf.set(String(c.id), String(c.status ?? "(null)"));

  const byConv = new Map<string, Array<{ sender: string; text: string; at: number }>>();
  for (const m of msgs) {
    const cid = String(m.conversation_id ?? ""); const t = String(m.text ?? "").trim();
    if (!cid || !t) continue;
    if (!byConv.has(cid)) byConv.set(cid, []);
    byConv.get(cid)!.push({ sender: String(m.sender ?? ""), text: t, at: new Date(String(m.created_at)).getTime() });
  }
  for (const a of byConv.values()) a.sort((x, y) => x.at - y.at);

  // 場面: staff（締め・約束なし） → customer（短い了承） を見つけ、その後スタッフが何をしたか
  let scenes = 0, replied = 0, silent = 0;
  // 直前送信に「足せる具体」（日程・時刻・物件名）が有る／無いで分けて数える。
  //   竹内さんのスクショの場面は**具体が0**（締めだけ）。そこで返信率が下がるなら、
  //   その条件の時だけ「下書きを出さない」線が引ける（設計知見「率をプロンプトで釣らず条件で分ける」）。
  const split = { 具体あり: { n: 0, replied: 0 }, 具体なし: { n: 0, replied: 0 } };
  const byStatus = new Map<string, { n: number; replied: number }>();
  const byHour = new Map<number, { n: number; replied: number }>();
  const HOURS = 24;
  const nextTexts: string[] = [];
  const predCount = new Map<string, number>();
  const samples: string[] = [];
  const now = Date.now();

  for (const [cid, arr] of byConv) {
    for (let i = 0; i < arr.length - 1; i++) {
      if (arr[i].sender !== "staff") continue;
      if (!CLOSING_RE.test(arr[i].text)) continue;
      if (PROMISE_RE.test(arr[i].text)) continue;          // 約束の途中は対象外（復唱してよい場面）
      const c = arr[i + 1];
      if (c.sender !== "customer" || !isShortAck(c.text)) continue;
      // その後24時間の猶予が無い（まだ返せる）場面は数えない
      if (now - c.at < HOURS * 3600_000) continue;
      scenes++;
      const next = arr[i + 2];
      const staffReplied = !!next && next.sender === "staff" && next.at - c.at < HOURS * 3600_000;
      const bucket = extractConcreteFacts(arr[i].text).length > 0 ? split.具体あり : split.具体なし;
      bucket.n++; if (staffReplied) bucket.replied++;
      const st = statusOf.get(cid) ?? "(不明)";
      const sb = byStatus.get(st) ?? { n: 0, replied: 0 }; sb.n++; if (staffReplied) sb.replied++; byStatus.set(st, sb);
      const h = new Date(c.at + 9 * 3600_000).getUTCHours();   // JST の時
      const hb = byHour.get(h) ?? { n: 0, replied: 0 }; hb.n++; if (staffReplied) hb.replied++; byHour.set(h, hb);
      if (!staffReplied) { silent++; continue; }
      replied++;
      nextTexts.push(next.text);
      for (const cl of splitClauses(next.text)) {
        const p = predicateOf(cl, 8); if (p && p.length >= 4) predCount.set(p, (predCount.get(p) ?? 0) + 1);
      }
      if (samples.length < 12) samples.push(`     締め: ${mask(arr[i].text).slice(0, 80)}\n     客  : ${c.text}\n     次  : ${mask(next.text).slice(0, 110)}`);
    }
  }

  console.log(`\n=== ① この場面でスタッフは返信しているか（24時間以内）===`);
  console.log(`   場面 ${scenes}件`);
  console.log(`   返信した   ${replied}件 (${scenes ? (replied / scenes * 100).toFixed(1) : "-"}%)`);
  console.log(`   返信しない ${silent}件 (${scenes ? (silent / scenes * 100).toFixed(1) : "-"}%)  ← 過半数ならこの場面の正解は「下書きを出さない」`);

  console.log(`\n=== ①-2 直前送信に「足せる具体」が有るかで分ける ===`);
  for (const [k, v] of Object.entries(split)) {
    console.log(`   ${k.padEnd(6)} 場面 ${String(v.n).padStart(3)}件 / 返信した ${String(v.replied).padStart(3)}件 (${v.n ? (v.replied / v.n * 100).toFixed(1) : "-"}%)`);
  }

  console.log(`\n=== ①-3 会話のステータス別（どれかで割れれば、その条件で下書きを出さない線が引ける）===`);
  for (const [k, v] of [...byStatus.entries()].sort((a, b) => b[1].n - a[1].n)) {
    if (v.n < 5) continue;
    console.log(`   ${k.padEnd(14)} 場面 ${String(v.n).padStart(3)}件 / 返信した ${String(v.replied).padStart(3)}件 (${(v.replied / v.n * 100).toFixed(1)}%)`);
  }
  console.log(`\n=== ①-4 お客様の返しが来た時刻（JST）別 ===`);
  for (const [h, v] of [...byHour.entries()].sort((a, b) => a[0] - b[0])) {
    if (v.n < 5) continue;
    console.log(`   ${String(h).padStart(2)}時台  場面 ${String(v.n).padStart(3)}件 / 返信した ${String(v.replied).padStart(3)}件 (${(v.replied / v.n * 100).toFixed(1)}%)`);
  }

  console.log(`\n=== ② 返信した時の長さ ===`);
  if (nextTexts.length) {
    const lens = nextTexts.map((t) => t.replace(/\s/g, "").length).sort((a, b) => a - b);
    const q = (p: number) => lens[Math.floor(lens.length * p)] ?? 0;
    console.log(`   文字数 中央値 ${q(0.5)} / 下位25% ${q(0.25)} / 上位25% ${q(0.75)} / 最大 ${lens[lens.length - 1]}`);
    const lines = nextTexts.map((t) => t.split("\n").filter((l) => l.trim()).length).sort((a, b) => a - b);
    console.log(`   行数   中央値 ${lines[Math.floor(lines.length * 0.5)]}`);
  }

  console.log(`\n=== ③ 返信した時によく使う言い回し（述部・上位20）===`);
  for (const [p, n] of [...predCount.entries()].sort((a, b) => b[1] - a[1]).slice(0, 20)) {
    console.log(`   ${String(n).padStart(4)}件  ${p}`);
  }

  console.log(`\n=== ④ 実物（12件）===`);
  for (const s of samples) { console.log(`${"─".repeat(76)}`); console.log(s); }

  console.log(`\n=== ⑤ 「お電話大丈夫です」は実送信に何件あるか（YUMAテストで出た文）===`);
  const staffAll = msgs.filter((m) => String(m.sender) === "staff").map((m) => String(m.text ?? ""));
  for (const re of [/お電話大丈夫/, /お電話(?:させて|致し|します)/, /お電話(?:で|にて)/]) {
    console.log(`   ${String(staffAll.filter((t) => re.test(t)).length).padStart(5)}件  ${re}`);
  }
}
main().catch((e) => { console.error(e); process.exit(1); });
