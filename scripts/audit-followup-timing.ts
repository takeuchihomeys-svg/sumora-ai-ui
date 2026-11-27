// scripts/audit-followup-timing.ts — #805 の続き: 返事が途絶えた後、何日たって・どんな一手で追うと戻りやすかったか（読むだけ・LLM なし・2026-11-28 作業員A）
//   入力: audit-route-progress-takeuchi.ts --json の照らし（会話と申込前の期間）。会話ごとにお客様とこちらの通を読む（会話の数だけの読み＝夜に回す）。
//   1つの「途絶え」: こちらの通の後、お客様の返事が無いまま 24時間以上たち、こちらがもう一度送った（追い）。
//     日数＝最後のこちらの通から追いまで／戻った＝追いの後 72時間以内にお客様が返事した／申込まで＝その会話が申込に届いた（照らしの reached）
//   追いの一手は文の形で分ける（決まった計算）: AIX（物件の文など）・新着の物件／状況の伺い／内覧の誘い／見積・費用／挨拶だけ／その他。本文は出さない。
//   「間が延びた」（お客様の返事が 24時間以上おくれた・前の間の3倍）の番も同じ表で数える（延びた後の次のこちらの一手と、その後の返事）。
//   実行: npx tsx --env-file=.env.local scripts/audit-followup-timing.ts --json=<照らし> [--out=<json>]
import { readFileSync, writeFileSync } from "node:fs";
import { createClient } from "@supabase/supabase-js";

const arg = (k: string) => process.argv.find((a) => a.startsWith(`--${k}=`))?.slice(k.length + 3) ?? null;
const sb = createClient(process.env.NEXT_PUBLIC_SUPABASE_URL ?? "", process.env.SUPABASE_SERVICE_ROLE_KEY || process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY || "", { auth: { persistSession: false } });
type Row = { conv: string; at: string; reached?: boolean; writer?: string | null };
type Msg = { sender: string; text: string | null; created_at: string; is_aix_generated: boolean | null; staff_writer: string | null };

export const DAY_BINS: Array<[string, number, number]> = [["1〜2日", 1, 3], ["3〜4日", 3, 5], ["5〜7日", 5, 8], ["8〜14日", 8, 15], ["15日〜", 15, 1e9]];
export function binOf(days: number): string | null { return DAY_BINS.find(([, a, b]) => days >= a && days < b)?.[0] ?? null; }
export function moveOf(m: { text: string | null; is_aix_generated: boolean | null }): string {
  const t = String(m.text ?? "");
  if (m.is_aix_generated) return /新着|ピックアップ|オススメ|お部屋/.test(t) ? "AIX:物件" : "AIX:その他";
  if (/新着|新しく(?:募集|出)|ピックアップ|オススメ(?:の|できる)?お部屋/.test(t)) return "新着の物件";
  if (/内覧|内見|ご案内/.test(t)) return "内覧の誘い";
  if (/見積|初期費用|お見積/.test(t)) return "見積・費用";
  if (/いかがでしょうか|ご検討|ご状況|その後|お変わり|お部屋探しの状況|進捗/.test(t)) return "状況の伺い";
  if (t.replace(/\s/g, "").length <= 25) return "挨拶だけ";
  return "その他";
}

/** 2026-11-28 統括役の頼み: 途絶えの前のこちらの通が約束（確認・見積・ピックアップしてお送り 等）なら、次の通は「約束を果たす」＝本当の追い（返事を促す）と分けて数える */
export const PROMISE_BEFORE_RE = /(?:確認|お調べ|お問い合わせ|交渉|ピックアップ|お探し|作成|お送り)(?:させて(?:頂|いただ)き|いたし|致し)ます|(?:確認|分かり|わかり)次第|ご連絡させて(?:頂|いただ)きます|お待ちください/;

(async () => {
  const rows = JSON.parse(readFileSync(arg("json") ?? "", "utf8")) as Row[];
  const byConv = new Map<string, { from: number; to: number; reached: boolean }>();
  for (const r of rows) {
    const t = Date.parse(r.at); const c = byConv.get(r.conv) ?? { from: t, to: t, reached: false };
    c.from = Math.min(c.from, t); c.to = Math.max(c.to, t); c.reached = c.reached || !!r.reached; byConv.set(r.conv, c);
  }
  type Cell = { n: number; back: number; reached: number };
  const tab: Record<string, Record<string, Record<string, Cell>>> = { all: {}, takeuchi: {} };
  const lateTab: Record<string, Record<string, Record<string, Cell>>> = { all: {}, takeuchi: {} };
  const add = (t: Record<string, Record<string, Cell>>, bin: string, mv: string, back: boolean, reached: boolean) => {
    const c = ((t[bin] ??= {})[mv] ??= { n: 0, back: 0, reached: 0 }); c.n++; if (back) c.back++; if (reached) c.reached++;
  };
  let convs = 0, episodes = 0;
  const kindTab: Record<string, Record<string, Record<string, Cell>>> = { "約束を果たす": {}, "本当の追い": {} };
  const kindTabT: Record<string, Record<string, Record<string, Cell>>> = { "約束を果たす": {}, "本当の追い": {} };
  for (const [conv, w] of byConv) {
    const { data } = await sb.from("messages").select("sender, text, created_at, is_aix_generated, staff_writer").like("conversation_id", `${conv}%`) // 照らしの json の conv は頭8字
      .gte("created_at", new Date(w.from - 14 * 86_400_000).toISOString()).lte("created_at", new Date(w.to + 21 * 86_400_000).toISOString())
      .order("created_at", { ascending: true }).limit(2000);
    const ms = (data ?? []) as Msg[]; if (!ms.length) continue; convs++;
    for (let i = 0; i < ms.length - 1; i++) {
      const a = ms[i], b = ms[i + 1];
      // 途絶えの後の追い: こちら→（お客様なし）→こちら、間が24時間以上
      if (a.sender === "staff" && b.sender === "staff") {
        const gapD = (Date.parse(b.created_at) - Date.parse(a.created_at)) / 86_400_000;
        const bin = gapD >= 1 ? binOf(gapD) : null; if (!bin) continue;
        if (Date.parse(b.created_at) > w.to + 14 * 86_400_000) continue; // 申込以降の期間（照らしの外）は数えない
        const nextCust = ms.slice(i + 2).find((m) => m.sender === "customer");
        const back = !!nextCust && Date.parse(nextCust.created_at) - Date.parse(b.created_at) <= 72 * 3600_000;
        const mv = moveOf(b); episodes++;
        add(tab.all, bin, mv, back, w.reached);
        const kind = PROMISE_BEFORE_RE.test(String(a.text ?? "")) ? "約束を果たす" : "本当の追い";
        add(kindTab[kind], bin, mv, back, w.reached);
        if (b.staff_writer === "takeuchi") add(kindTabT[kind], bin, mv, back, w.reached);
        if (b.staff_writer === "takeuchi") add(tab.takeuchi, bin, mv, back, w.reached);
      }
      // 間が延びた: こちら→お客様の返事が24時間以上後。その後のこちらの次の一手と、72時間以内のお客様の返事
      if (a.sender === "staff" && b.sender === "customer") {
        const lateD = (Date.parse(b.created_at) - Date.parse(a.created_at)) / 86_400_000;
        if (lateD < 1) continue;
        const ours = ms.slice(i + 2).find((m) => m.sender === "staff"); if (!ours) continue;
        const after = ms.slice(ms.indexOf(ours) + 1).find((m) => m.sender === "customer");
        const back = !!after && Date.parse(after.created_at) - Date.parse(ours.created_at) <= 72 * 3600_000;
        const bin = binOf(lateD) ?? "1〜2日";
        const c1 = ((lateTab.all[bin] ??= {})[moveOf(ours)] ??= { n: 0, back: 0, reached: 0 }); c1.n++; if (back) c1.back++; if (w.reached) c1.reached++;
        if (ours.staff_writer === "takeuchi") { const c2 = ((lateTab.takeuchi[bin] ??= {})[moveOf(ours)] ??= { n: 0, back: 0, reached: 0 }); c2.n++; if (back) c2.back++; if (w.reached) c2.reached++; }
      }
    }
  }
  const pct = (a: number, b: number) => (b ? `${Math.round((a / b) * 100)}%` : "—");
  const show = (title: string, t: Record<string, Record<string, Cell>>) => {
    console.log(`\n## ${title}`);
    for (const [bin] of DAY_BINS) {
      const r = t[bin]; if (!r) continue;
      const cells = Object.entries(r).sort((x, y) => y[1].n - x[1].n).map(([mv, c]) => `${mv} ${c.back}/${c.n}（${pct(c.back, c.n)}）`);
      const n = Object.values(r).reduce((s, c) => s + c.n, 0), bk = Object.values(r).reduce((s, c) => s + c.back, 0);
      console.log(`- ${bin}: 計 ${bk}/${n}（${pct(bk, n)}）｜${cells.join("・")}`);
    }
  };
  console.log(`### 途絶えの後の追い（会話 ${convs}・追い ${episodes}・戻った＝追いの後72時間以内にお客様の返事）`);
  show("全員の追い（日数＝最後のこちらの通から追いまで）", tab.all);
  show("全員・前の通が約束＝約束を果たす通", kindTab["約束を果たす"]);
  show("全員・前の通が約束でない＝本当の追い", kindTab["本当の追い"]);
  show("竹内さん本人・約束を果たす通", kindTabT["約束を果たす"]);
  show("竹内さん本人・本当の追い", kindTabT["本当の追い"]);
  show("竹内さん本人の追い", tab.takeuchi);
  show("間が延びた後（お客様の返事のおくれの日数）のこちらの次の一手 → 72時間以内の返事・全員", lateTab.all);
  show("同・竹内さん本人", lateTab.takeuchi);
  const out = arg("out"); if (out) writeFileSync(out, JSON.stringify({ at: new Date().toISOString(), convs, episodes, tab, lateTab, kindTab, kindTabT }, null, 1));
})().catch((e) => { console.error(e); process.exit(1); });
