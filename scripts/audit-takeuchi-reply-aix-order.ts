// scripts/audit-takeuchi-reply-aix-order.ts — 竹内さん本人の「返信と AIX の組み合わせと順番」を場面×AIX の種類×間隔で数える（読むだけ・LLM なし）
//   2026-11-12 作業員7（竹内さん「返信と AIX の組み合わせと順番も、なぜこのようにしているのか細分化して理解できるように」）。
//   型: 返信→AIX（RA）／AIX→返信（AR）／AIX→AIX（AA・違う種類）／返信→返信（RR）／返信→AIX→返信（RAR）／2段＝約束の返信→後で AIX（1時間〜3日後・次のお客様の通の前でも後でも）
//   間隔: 秒（〜60秒）・分（〜60分）・時間（〜24時間）・翌日以降（〜72時間）。AIX の種類は AIX の文の頭の言葉で読む（aix_usage_logs と結ばない＝読むだけ・軽く）。
//   営業時間（JST 9〜22）は流さない。申込の書類以降は外す。名前・番号は伏せる。
//   実行: npx tsx --env-file=<鍵のある .env> scripts/audit-takeuchi-reply-aix-order.ts [--days=120] [--out=<json>]
import { createClient } from "@supabase/supabase-js";
import { writeFileSync } from "node:fs";

const arg = (k: string, d = "") => process.argv.find((a) => a.startsWith(`--${k}=`))?.slice(k.length + 3) ?? d;
const DAYS = Number(arg("days", "120")) || 120;
const sb = createClient(process.env.NEXT_PUBLIC_SUPABASE_URL!, process.env.SUPABASE_SERVICE_ROLE_KEY!);
const jstHour = new Date(Date.now() + 9 * 3600_000).getUTCHours();
if (jstHour >= 9 && jstHour < 22 && !process.argv.includes("--force-hours")) { console.error("営業時間（JST 9〜22時）は流さない"); process.exit(1); }

type M = { sender: string; text: string | null; created_at: string; is_aix_generated: boolean | null; staff_writer: string | null };
const MASK = (t: string) => t.replace(/[\p{Script=Han}\p{Script=Katakana}A-Za-z]{1,12}(?:さん|様)/gu, "〇〇さん").replace(/\d{2,4}-?\d{2,4}-?\d{3,4}/g, "〈番号〉").replace(/https?:\/\/\S+/g, "〈URL〉");
const POST_APPLY_RE = /申込(?:み)?(?:用)?フォーマット|お申込に必要なご情報|ご本人確認書類として|審査(?:結果|が通|通過しました)|ご契約(?:書|手続)/;
const IMG_RE = /^\s*\[(?:画像|動画|スタンプ|ファイル)\]\s*$/;
const PROMISE_RE = /確認させて頂|確認させていただ|確認出来次第|お調べ|ピックアップ(?:し|して)?(?:お送り|させ)|作成しお送り|ご用意させ|お送りさせて頂きます/;

function sceneOf(cust: string, firstContact: boolean): string {
  if (firstContact) return "T11 初回";
  if (/申し?込(?:み)?(?:たい|します|させ)|抑えて|審査/.test(cust)) return "T9 決める合図・審査";
  if (/https?:\/\/|\[画像\]|SUUMO|ホームズ/.test(cust)) return "T4 物件が届いた";
  if (/内[覧見]|見学|案内/.test(cust)) return "T7 内覧";
  if (/初期費用|費用|見積|いくら|割引|安く/.test(cust)) return "T8 費用";
  if (/検討|考え(?:させ|ます)|相談して|また連絡/.test(cust)) return "T6 検討";
  if (/(?:エリア|家賃|間取り|築|駅|条件|希望)/.test(cust) && !/[?？]/.test(cust)) return "T1 条件";
  if (/[?？]|ですか|ますか|でしょうか/.test(cust)) return "T2/T3 質問";
  if (/ありがと|了解|承知|お願いします|わかりました|かしこまり/.test(cust)) return "T5 お礼・了承";
  return "その他";
}
/** AIX の種類（文の頭の言葉で読む） */
function aixKind(t: string): string {
  if (/ご希望のお部屋探しご条件|①ご入居時期|ご条件をお送り/.test(t)) return "条件ヒアリング";
  if (/御見積書|初期費用：|初期費用:/.test(t)) return "見積書";
  if (/募集中|募集終了|お申込が入|空室|退去予定/.test(t)) return "物件確認した";
  if (/待ち合わせ|現地エントランス|集合/.test(t)) return "待ち合わせ";
  if (/ご内覧|内覧日|候補日|ご都合よろしいお日にち/.test(t)) return "内覧調整";
  if (/オススメ|おすすめ/.test(t)) return "物件オススメ";
  if (/ピックアップ|物件一覧|お部屋一覧/.test(t)) return "物件ピックアップ";
  if (/保証会社/.test(t)) return "保証会社";
  if (/お電話|電話/.test(t)) return "電話";
  return "その他";
}
const gapBucket = (ms: number) => (ms <= 60_000 ? "秒" : ms <= 60 * 60_000 ? "分" : ms <= 24 * 3600_000 ? "時間" : "翌日以降");
/** 返信の中身（返信に書いた物） */
function replyParts(t: string): string[] {
  const o: string[] = [];
  if (/はじめまして|担当させて頂きます/.test(t)) o.push("挨拶");
  if (/かしこまりました|ありがとうございます|承知/.test(t)) o.push("受け");
  if (PROMISE_RE.test(t)) o.push("約束");
  if (/となります|可能です|御座います|ございます|円|帖|徒歩/.test(t)) o.push("答え・事実");
  if (/[?？]|でしょうか|如何/.test(t)) o.push("質問・誘い");
  if (/ご内覧|ご案内|お申込|抑え/.test(t)) o.push("内覧・申込の線");
  if (/ご入力|お送り頂(?:き|け)ますと|お手隙の際/.test(t)) o.push("AIX への案内");
  return o.length ? o : ["その他"];
}

async function main() {
  const since = new Date(Date.now() - DAYS * 86400_000).toISOString();
  const convs = new Set<string>();
  for (let from = 0; ; from += 1000) {
    const { data, error } = await sb.from("messages").select("conversation_id").eq("staff_writer", "takeuchi").gte("created_at", since).range(from, from + 999);
    if (error) throw error;
    for (const r of data ?? []) convs.add(r.conversation_id as string);
    if (!data || data.length < 1000) break;
  }
  type Row = { scene: string; pattern: string; kinds: string[]; gap: string; reply: string[]; ex: string };
  const rows: Row[] = [];
  for (const cid of convs) {
    const { data, error } = await sb.from("messages").select("sender, text, created_at, is_aix_generated, staff_writer").eq("conversation_id", cid).gte("created_at", since).order("created_at", { ascending: true }).limit(3000);
    if (error) throw error;
    const ms = (data ?? []) as M[];
    let seenStaff = false;
    for (let i = 0; i < ms.length; i++) {
      if (ms[i].sender !== "customer") { seenStaff = true; continue; }
      if (i + 1 < ms.length && ms[i + 1].sender === "customer") continue;
      let j = i; const cust: string[] = [];
      while (j >= 0 && ms[j].sender === "customer") { cust.unshift(String(ms[j].text ?? "")); j--; }
      const t0 = Date.parse(ms[i].created_at);
      // この番の送信（次のお客様の通まで・60分以内）
      const after: M[] = [];
      let k = i + 1;
      for (; k < ms.length && ms[k].sender !== "customer" && Date.parse(ms[k].created_at) - t0 <= 60 * 60_000; k++) if (!IMG_RE.test(String(ms[k].text ?? "")) || ms[k].is_aix_generated) after.push(ms[k]);
      if (!after.length) continue;
      if (!after.some((m) => m.staff_writer === "takeuchi" && !m.is_aix_generated)) continue;
      if (after.some((m) => m.staff_writer === "employee")) continue;
      if (after.some((m) => POST_APPLY_RE.test(String(m.text ?? ""))) || cust.some((c) => POST_APPLY_RE.test(c))) continue;
      // 並び（AIX の続き＝60秒以内の AIX はまとめる）
      const seq: Array<{ k: "R" | "A"; at: number; text: string }> = [];
      for (const m of after) {
        const kk = m.is_aix_generated ? "A" : "R"; const at = Date.parse(m.created_at); const prev = seq[seq.length - 1];
        if (prev && prev.k === "A" && kk === "A" && at - prev.at <= 60_000) { prev.text += "\n" + String(m.text ?? ""); prev.at = at; continue; }
        seq.push({ k: kk, at, text: String(m.text ?? "") });
      }
      let pattern = seq.map((s) => s.k).join("");
      const kinds = seq.filter((s) => s.k === "A").map((s) => aixKind(s.text));
      let gap = seq.length >= 2 ? gapBucket(seq[1].at - seq[0].at) : "-";
      // 2段: この番は返信だけで約束を含み、後（1時間〜3日・次の番をまたいでも）で AIX
      if (!pattern.includes("A") && seq.some((s) => s.k === "R" && PROMISE_RE.test(s.text))) {
        const lastAt = seq[seq.length - 1].at;
        const later = ms.slice(k).find((m) => m.is_aix_generated && Date.parse(m.created_at) - lastAt <= 72 * 3600_000 && !IMG_RE.test(String(m.text ?? "")));
        if (later) { pattern = `2段(${pattern}→A)`; kinds.push(aixKind(String(later.text ?? ""))); gap = gapBucket(Date.parse(later.created_at) - lastAt); }
      }
      const firstR = seq.find((s) => s.k === "R");
      rows.push({ scene: sceneOf(cust.join("\n"), !seenStaff), pattern, kinds, gap, reply: replyParts(firstR?.text ?? ""),
        ex: seq.map((s) => `${s.k}:${MASK(s.k === "A" ? `【${aixKind(s.text)}】` : s.text).replace(/\s+/g, " ").slice(0, 40)}`).join(" → ") });
      seenStaff = true;
    }
  }
  console.log(`竹内さんの番 ${rows.length}（${DAYS}日・従業員の混ざる番と申込以降は外した）`);
  const cnt = (xs: string[]) => Object.entries(xs.reduce<Record<string, number>>((o, x) => ((o[x] = (o[x] ?? 0) + 1), o), {})).sort((a, b) => b[1] - a[1]);
  console.log("\n# 組の型（全体）"); for (const [p, n] of cnt(rows.map((r) => r.pattern)).slice(0, 12)) console.log(`  ${p}: ${n}`);
  const scenes = [...new Set(rows.map((r) => r.scene))];
  for (const s of scenes.sort()) {
    const rs = rows.filter((r) => r.scene === s);
    console.log(`\n## ${s}（番 ${rs.length}）`);
    for (const [p, n] of cnt(rs.map((r) => r.pattern)).slice(0, 6)) {
      const ps = rs.filter((r) => r.pattern === p);
      const kinds = cnt(ps.flatMap((r) => r.kinds)).slice(0, 3).map(([kk, c]) => `${kk}${c}`).join("・");
      const gaps = cnt(ps.map((r) => r.gap)).map(([g, c]) => `${g}${c}`).join("・");
      const reply = cnt(ps.map((r) => r.reply.join("+"))).slice(0, 2).map(([x, c]) => `${x} ${c}`).join("／");
      console.log(`  ${p}: ${n}（${Math.round((100 * n) / rs.length)}%）｜AIX ${kinds || "-"}｜間隔 ${gaps}｜返信の中身 ${reply}`);
      for (const r of ps.slice(0, 2)) console.log(`     例 ${r.ex}`);
    }
  }
  if (arg("out")) writeFileSync(arg("out"), JSON.stringify(rows, null, 1));
}
main().catch((e) => { console.error(e); process.exit(1); });
