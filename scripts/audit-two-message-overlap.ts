// scripts/audit-two-message-overlap.ts — 2通に分けた番で、2通の中身が重なっている割合と型を数える（読むだけ・LLM なし・DB に書かない）
//
// 2026-11-21 作業員K2（竹内さん「2通で同じ事を言うのも、ちゃんと改善されるか」・統括役の頼み）。
//   番＝お客様の発言の後、次のお客様の発言までに、こちら（スタッフ・AIX）が文を2通以上続けて送った所（画像・資料だけの通は除く・10分以内に続いた通）。
//   組の種類: 返信＋返信（返信を2通に分けた）／AIX＋返信（AIX の通の後に手打ち・または逆）／AIX＋AIX。
//   重なりの型（2通の両方に出た物）:
//     物件 … 同じ物件名（【〜】・🌟〜・〜号室の前の名前）
//     推す点 … 同じ訴求の話題（appeal-record.appealPointsOf: 敷礼0・駅近・広さ・設備 等）
//     締め … 同じ締めの誘い（内覧のご案内／お申込み・抑え／ご査収）
//     約束 … 同じ約束（確認させて頂きます・お送りさせて頂きます・ご連絡させて頂きます）
//     挨拶 … 両方に挨拶（お世話になっております・ありがとうございます）
//     同じ文 … 文字の3字の重なりが 0.6 以上の文が両方にある
//   書き手: 2通目の staff_writer（takeuchi＝竹内さん本人／それ以外）。AI の下書きをスタッフが送った文も「スタッフ」に入る（送った文の数え）。
//   出力: 組の種類×書き手ごとの「重なりのある番の割合」と型の内訳・伏せた短い抜き出し（--show）。名前・番号は出さない（物件名は出さない・型だけ）。
// 実行: npx tsx --env-file=<鍵のある .env> scripts/audit-two-message-overlap.ts [--days=14] [--show=0] [--out=<json>]
import { writeFileSync } from "node:fs";
import { createClient } from "@supabase/supabase-js";
import { appealPointsOf } from "../app/lib/appeal-record";
import { isTestConversation } from "../app/lib/test-conversations";
import { isMaterialOnlyText } from "../app/lib/daily-greeting";
import { maskPII } from "../app/lib/pii-mask";

const sb = createClient(process.env.NEXT_PUBLIC_SUPABASE_URL ?? "", process.env.SUPABASE_SERVICE_ROLE_KEY ?? "");
const arg = (k: string, d: string) => process.argv.find((a) => a.startsWith(`--${k}=`))?.slice(k.length + 3) ?? d;
const DAYS = Number(arg("days", "14"));
const SHOW = Number(arg("show", "0"));
const OUT = arg("out", "");
const since = new Date(Date.now() - DAYS * 86400_000).toISOString();
const GAP_MS = 10 * 60_000;

type Msg = { conversation_id: string; sender: string; text: string | null; image_url: string | null; created_at: string; is_aix_generated: boolean | null; staff_writer: string | null };

const PROPS = (t: string) => {
  const s = new Set<string>();
  for (const m of t.matchAll(/【([^】\n]{2,30})】|🌟([^\n！!。、]{2,30}?)(?:\s*[0-9０-９A-Za-z-]{1,5}号室|\s|$)/g)) { const n = (m[1] ?? m[2] ?? "").replace(/\s*[0-9０-９A-Za-z-]{1,5}号室$/, "").replace(/\s+/g, "").trim(); if (n.length >= 2 && !/円|割引|初期費用/.test(n)) s.add(n); }
  for (const m of t.matchAll(/([ァ-ヴーA-Za-z0-9一-龥・]{3,20})\s*[0-9０-９]{2,4}号室/g)) s.add(m[1].replace(/\s+/g, ""));
  return s;
};
const CLOSE = (t: string) => { const s = new Set<string>(); if (/ご案内させて|ご内覧|内覧/.test(t)) s.add("内覧"); if (/お申込|抑えさせて|押さえ/.test(t)) s.add("申込"); if (/ご査収/.test(t)) s.add("ご査収"); return s; };
const PROMISE = (t: string) => { const s = new Set<string>(); if (/確認(?:させて|致し|いたし)/.test(t)) s.add("確認"); if (/(?:お送り|ピックアップ)(?:させて|致し|いたし)/.test(t)) s.add("お送り"); if (/ご連絡(?:させて|致し|いたし)/.test(t)) s.add("ご連絡"); return s; };
const GREET = (t: string) => /お世話になっております|ありがとうございます|ありがとうございました/.test(t);
const sents = (t: string) => t.normalize("NFKC").split(/(?<=[。！!？?\n])/).map((s) => s.replace(/[\s😊😌🌟✨！!。、]/g, "")).filter((s) => s.length >= 8);
const tri = (s: string) => { const o = new Set<string>(); for (let i = 0; i + 3 <= s.length; i++) o.add(s.slice(i, i + 3)); return o; };
const jac = (a: Set<string>, b: Set<string>) => { let n = 0; for (const x of a) if (b.has(x)) n++; return n / Math.max(1, a.size + b.size - n); };
const inter = <T,>(a: Set<T>, b: Set<T>) => [...a].filter((x) => b.has(x));

async function main() {
  const msgs: Msg[] = [];
  for (let f = 0; ; f += 1000) {
    const { data, error } = await sb.from("messages").select("conversation_id, sender, text, image_url, created_at, is_aix_generated, staff_writer").gte("created_at", since).order("conversation_id").order("created_at").range(f, f + 999);
    if (error) throw new Error(error.message);
    msgs.push(...((data ?? []) as Msg[]));
    if ((data ?? []).length < 1000) break;
  }
  const byConv = new Map<string, Msg[]>();
  for (const m of msgs) { if (isTestConversation(m.conversation_id)) continue; (byConv.get(m.conversation_id) ?? byConv.set(m.conversation_id, []).get(m.conversation_id)!).push(m); }
  type Row = { kind: string; writer: string; types: string[]; a: string; b: string; detail: string[] };
  const rows: Row[] = [];
  for (const list of byConv.values()) {
    // 申込の書類以降は数えない（フォーマットの通が出たら会話の残りを外す）
    const cut = list.findIndex((m) => m.sender !== "customer" && /【お申込者様記入欄】/.test(m.text ?? ""));
    const L = cut >= 0 ? list.slice(0, cut) : list;
    let run: Msg[] = [];
    const flush = () => {
      const texts = run.filter((m) => !m.image_url && (m.text ?? "").trim().length > 8 && !isMaterialOnlyText(m.text));
      for (let i = 0; i + 1 < texts.length; i++) {
        const a = texts[i], b = texts[i + 1];
        if (Date.parse(b.created_at) - Date.parse(a.created_at) > GAP_MS) continue;
        const ta = a.text ?? "", tb = b.text ?? "";
        const kind = `${a.is_aix_generated ? "AIX" : "返信"}＋${b.is_aix_generated ? "AIX" : "返信"}`;
        const types: string[] = [], detail: string[] = [];
        if (inter(PROPS(ta), PROPS(tb)).length) types.push("物件");
        { const x = inter(new Set(appealPointsOf(ta)), new Set(appealPointsOf(tb))); if (x.length) { types.push("推す点"); detail.push(`推す点=${x.join("/")}`); } }
        { const x = inter(CLOSE(ta), CLOSE(tb)); if (x.length) { types.push("締め"); detail.push(`締め=${x.join("/")}`); } }
        { const x = inter(PROMISE(ta), PROMISE(tb)); if (x.length) { types.push("約束"); detail.push(`約束=${x.join("/")}`); } }
        if (GREET(ta) && GREET(tb)) types.push("挨拶");
        const sa = sents(ta).map(tri), sbb = sents(tb).map(tri);
        { const A = sents(ta), B = sents(tb); for (let i = 0; i < sa.length; i++) for (let j = 0; j < sbb.length; j++) if (jac(sa[i], sbb[j]) >= 0.6 && !types.includes("同じ文")) { types.push("同じ文"); detail.push(`同じ文=「${maskPII(A[i]).slice(0, 40)}」≒「${maskPII(B[j]).slice(0, 40)}」`); } }
        const writer = b.is_aix_generated ? "AIX" : b.staff_writer === "takeuchi" ? "竹内さん" : "スタッフ";
        rows.push({ kind, writer, types, a: ta, b: tb, detail });
      }
      run = [];
    };
    for (const m of L) { if (m.sender === "customer") flush(); else run.push(m); }
    flush();
  }
  const groups = new Map<string, Row[]>();
  for (const r of rows) { const k = `${r.kind}｜2通目=${r.writer}`; (groups.get(k) ?? groups.set(k, []).get(k)!).push(r); }
  console.log(`=== ${DAYS}日・2通続けた組 ${rows.length}（テストの会話・申込の書類以降を除く・10分以内）`);
  const TYPES = ["物件", "推す点", "締め", "約束", "挨拶", "同じ文"];
  const summary: Record<string, unknown> = {};
  for (const [k, rs] of [...groups.entries()].sort((a, b) => b[1].length - a[1].length)) {
    const any = rs.filter((r) => r.types.some((t) => t !== "物件")).length; // 同じ物件を両方で名指すのは普通（物件の資料の後の文）＝重なりの割合からは外す
    const by = Object.fromEntries(TYPES.map((t) => [t, rs.filter((r) => r.types.includes(t)).length]));
    summary[k] = { n: rs.length, overlap: any, by };
    console.log(`${k}: ${rs.length}組・重なり（物件を除く型が1つ以上）${any}（${Math.round((any / rs.length) * 100)}%）｜${TYPES.map((t) => `${t} ${by[t]}`).join("・")}`);
  }
  if (SHOW) for (const [k, rs] of groups) { console.log(`\n--- ${k}（重なりのある組・伏せた抜き出し）`); for (const r of rs.filter((x) => x.types.some((t) => t !== "物件")).slice(0, SHOW)) console.log(`[${r.detail.join("｜")}]\n  1通目: ${maskPII(r.a).replace(/\s+/g, " ").slice(0, 120)}\n  2通目: ${maskPII(r.b).replace(/\s+/g, " ").slice(0, 120)}`); }
  if (OUT) writeFileSync(OUT, JSON.stringify({ days: DAYS, made: new Date().toISOString(), summary }, null, 1));
}
main().catch((e) => { console.error(e); process.exit(1); });
