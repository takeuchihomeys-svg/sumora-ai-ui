// audit-style-promise.ts の2段目（読み取りのみ）: 絵文字の行の役割・約束の種類ごとの AI とスタッフのずれ・果たすまでの日数
// 2026-09-22 竹内「①かしこまりました・何卒 ②絵文字 ③約束 を会話や成約データから分析して場面改善する」
// 実行: npx tsx --env-file=.env.local scripts/audit-style-promise-detail.ts
import { createClient } from "@supabase/supabase-js";
import { isShortAckOnly } from "../app/lib/previous-send-note";
import { isConditionFormMessage } from "../app/lib/reply-context";

const sb = createClient(process.env.NEXT_PUBLIC_SUPABASE_URL ?? "", process.env.SUPABASE_SERVICE_ROLE_KEY ?? process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY ?? "");
async function page(table: string, select: string, order: string, days: number | null) {
  const out: Array<Record<string, unknown>> = [];
  for (let p = 0; p < 60; p++) {
    let q = sb.from(table).select(select).order(order, { ascending: false }).range(p * 1000, p * 1000 + 999);
    if (days) q = q.gte(order, new Date(Date.now() - days * 86400_000).toISOString());
    const { data, error } = await q;
    if (error) { console.log(`   ⚠ ${table}: ${error.message}`); break; }
    const r = (data ?? []) as unknown as Array<Record<string, unknown>>;
    if (r.length === 0) break; out.push(...r); if (r.length < 1000) break;
  }
  return out;
}
const pct = (a: number, b: number) => (b ? `${((a / b) * 100).toFixed(1)}%` : "-");
const EMOJI_RE = /\p{Extended_Pictographic}/gu;
const ec = (t: string) => (t.match(EMOJI_RE) ?? []).length;
const NANISOTSU_RE = /何卒よろしくお願い(?:致|いた)します/;
const KASHIKO_RE = /かしこまりました/;
const PROMISE_RE = /(?:確認|ご連絡|連絡|お送り|送付|ピックアップ|お探し|探させ|交渉|作成|手配|ご案内|お調べ|調べ|抑え|押さえ|お伝え)[^\n。！!]{0,14}(?:させて(?:頂|いただ)きます|致します|いたします|します)(?!でしょうか)/;
const promises = (t: string) => t.split(/\n|(?<=[！!。])/).map((s) => s.trim()).filter((s) => PROMISE_RE.test(s) && !/(?:致しました|させて(?:頂|いただ)きました|しました)/.test(s));
function kind(s: string): string {
  if (/交渉/.test(s)) return "交渉";
  if (/ピックアップ|お探し|探させ|新着/.test(s)) return "物件探し";
  if (/見積/.test(s)) return "見積書";
  if (/お気に召され|よろしければ/.test(s) && /ご案内|抑え|押さえ|申込/.test(s)) return "条件つきの提案（お気に召されましたら〜）";
  if (/確認/.test(s)) return "確認";
  if (/ご案内|内覧/.test(s)) return "内覧・ご案内";
  if (/抑え|押さえ|申込/.test(s)) return "申込・押さえる";
  if (/お送り|送付/.test(s)) return "資料の送付";
  if (/ご連絡|連絡|お伝え/.test(s)) return "ご連絡";
  return "その他";
}
function sceneOf(t: string): string {
  t = (t ?? "").trim();
  if (!t) return "（不明）";
  if (isConditionFormMessage(t)) return "条件フォーム受領";
  if (/^\s*\[画像\]|https?:\/\//.test(t) && t.replace(/https?:\/\/\S+|\[画像\][^\n]*/g, "").trim().length <= 15) return "物件の画像・URLだけ";
  if (/見送|やめ|キャンセル|他で決め|白紙|辞退/.test(t)) return "断り・キャンセル";
  if (/内覧|内見|見学/.test(t)) return "内覧の話";
  if (/申込|申し込|審査|契約|書類|身分証/.test(t)) return "申込・審査・書類";
  if (/[?？]|ですか|でしょうか|いくら|どれくらい|どのくらい/.test(t)) return "質問";
  if (/(?:^|\n)[^\n]{0,40}(?:万|円|LDK|DK|駅|徒歩|ペット|駐車場|築|階)/.test(t) && t.length <= 120) return "条件提示";
  if (isShortAckOnly(t)) return "短い了承・お礼";
  if (/検討|考え|相談し|持ち帰|後で|出先|仕事中/.test(t)) return "検討中・一時保留";
  return "その他";
}
function lineRole(l: string, i: number, n: number): string {
  if (/^(?:[^\n]{0,15}さん)?(?:お世話になっております|はじめまして|かしこまりました|はい|承知|ありがとうございます)/.test(l) && i === 0) return "1行目の挨拶・開口語";
  if (/申し訳|すみません|失礼/.test(l)) return "お詫び";
  if (/[0-9０-９,，]+円|[0-9０-９]+万/.test(l)) return "金額";
  if (/[0-9０-９]{1,2}[\/／月][0-9０-９]{1,2}|[0-9０-９]{1,2}[:：時]/.test(l)) return "日時";
  if (/大阪府|兵庫県|市|区[^\n]{0,6}[0-9０-９]|住所|エントランス|待ち合わせ/.test(l)) return "住所・待ち合わせ";
  if (/https?:\/\//.test(l)) return "URL";
  if (NANISOTSU_RE.test(l)) return "何卒の締め";
  if (/お気軽に|ご査収/.test(l)) return "締め（お気軽に・ご査収）";
  if (PROMISE_RE.test(l)) return "約束・行動宣言";
  if (/ありがとう/.test(l)) return "お礼";
  if (/(?:ます|です|となります|おります)[！!]*$/.test(l)) return "説明・報告";
  return i === n - 1 ? "最終行（その他）" : "その他";
}

async function main() {
  // ── 絵文字: 行の役割別（直近180日のスタッフ手打ち） ──
  const staff = await page("messages", "text, sender, is_aix_generated, created_at", "created_at", 180);
  const lines = new Map<string, { n: number; e: number }>();
  for (const m of staff) {
    if (m.sender !== "staff" || m.is_aix_generated) continue;
    const t = String(m.text ?? ""); if (!t || /^\s*\[画像\]/.test(t)) continue;
    const ls = t.split("\n").map((x) => x.trim()).filter(Boolean);
    ls.forEach((l, i) => { const r = lineRole(l, i, ls.length); const b = lines.get(r) ?? { n: 0, e: 0 }; b.n++; if (ec(l) > 0) b.e++; lines.set(r, b); });
  }
  console.log(`=== ② 絵文字: 行の役割ごとの付く率（スタッフ手打ち・直近180日） ===`);
  for (const [r, b] of [...lines.entries()].sort((a, c) => c[1].n - a[1].n)) console.log(`   ${r.padEnd(24)} ${String(b.n).padStart(6)}行  ${pct(b.e, b.n)}`);

  // ── AI とスタッフのずれ（ai_reply_examples） ──
  const ex = await page("ai_reply_examples", "customer_message, ai_draft, sent_reply, created_at", "created_at", 120);
  const pairs = ex.filter((r) => String(r.ai_draft ?? "").trim() && String(r.sent_reply ?? "").trim() && !/^\s*\[画像\]/.test(String(r.sent_reply)));
  console.log(`\n=== AI 下書き → 実送信 ${pairs.length}組 ===`);
  // 約束: 種類ごとに AI だけ／スタッフだけ
  const pk = new Map<string, { ai: number; st: number; both: number }>();
  for (const r of pairs) {
    const a = new Set(promises(String(r.ai_draft)).map(kind)), s = new Set(promises(String(r.sent_reply)).map(kind));
    for (const k of new Set([...a, ...s])) { const b = pk.get(k) ?? { ai: 0, st: 0, both: 0 }; if (a.has(k) && s.has(k)) b.both++; else if (a.has(k)) b.ai++; else b.st++; pk.set(k, b); }
  }
  console.log(`\n③ 約束の種類      AI だけ(消された)  スタッフだけ(書けていない)  両方`);
  for (const [k, b] of [...pk.entries()].sort((x, y) => (y[1].ai + y[1].st) - (x[1].ai + x[1].st))) console.log(`   ${k.padEnd(24)} ${String(b.ai).padStart(5)}   ${String(b.st).padStart(5)}   ${b.both}`);
  // 1通の約束の数
  const nAi = pairs.map((r) => promises(String(r.ai_draft)).length), nSt = pairs.map((r) => promises(String(r.sent_reply)).length);
  const dist = (a: number[]) => [0, 1, 2, 3].map((k) => `${k}${k === 3 ? "+" : ""}件 ${pct(a.filter((x) => (k === 3 ? x >= 3 : x === k)).length, a.length)}`).join(" ／ ");
  console.log(`   1通の約束の数  AI: ${dist(nAi)}\n                 実送信: ${dist(nSt)}`);
  // 消された約束の実例
  const mask = (s: string) => s.replace(/[^\s、。！!？?]{1,12}(?:さん|様)/g, "〈お客様〉").replace(/\n/g, " ／ ");
  console.log(`\n   【スタッフが消した約束の実例（AI に有り・実送信に同じ種類が無い）】`);
  let shown = 0;
  for (const r of pairs) {
    if (shown >= 16) break;
    const s = new Set(promises(String(r.sent_reply)).map(kind));
    const cut = promises(String(r.ai_draft)).filter((x) => !s.has(kind(x)));
    if (cut.length) { shown++; console.log(`   [${sceneOf(String(r.customer_message ?? ""))}] 客: ${mask(String(r.customer_message ?? "")).slice(0, 50)}\n      消: ${mask(cut.join(" "))}\n      送: ${mask(String(r.sent_reply)).slice(0, 110)}`); }
  }
  // ① 何卒・かしこまりました: 場面 × AI/スタッフ
  console.log(`\n=== ① 場面ごとの AI と実送信の率（同じ組で比べる） ===`);
  const sc = new Map<string, { n: number; aN: number; sN: number; aK: number; sK: number; aE: number; sE: number; aE2: number; sE2: number }>();
  for (const r of pairs) {
    const s = sceneOf(String(r.customer_message ?? "")); const a = String(r.ai_draft), t = String(r.sent_reply);
    const b = sc.get(s) ?? { n: 0, aN: 0, sN: 0, aK: 0, sK: 0, aE: 0, sE: 0, aE2: 0, sE2: 0 };
    b.n++; if (NANISOTSU_RE.test(a)) b.aN++; if (NANISOTSU_RE.test(t)) b.sN++; if (KASHIKO_RE.test(a)) b.aK++; if (KASHIKO_RE.test(t)) b.sK++;
    if (ec(a) > 0) b.aE++; if (ec(t) > 0) b.sE++; if (ec(a) >= 2) b.aE2++; if (ec(t) >= 2) b.sE2++;
    sc.set(s, b);
  }
  console.log(`   場面               組数   何卒 AI→実送信     かしこまりました AI→実送信   絵文字あり AI→実送信   絵文字2個以上 AI→実送信`);
  for (const [s, b] of [...sc.entries()].sort((x, y) => y[1].n - x[1].n)) if (b.n >= 15) console.log(`   ${s.padEnd(16)} ${String(b.n).padStart(5)}   ${pct(b.aN, b.n).padStart(6)}→${pct(b.sN, b.n).padEnd(8)}  ${pct(b.aK, b.n).padStart(6)}→${pct(b.sK, b.n).padEnd(10)}  ${pct(b.aE, b.n).padStart(6)}→${pct(b.sE, b.n).padEnd(8)}  ${pct(b.aE2, b.n).padStart(6)}→${pct(b.sE2, b.n)}`);

  // ③ 約束の後の催促（絞った言い回し）と果たすまでの日数
  console.log(`\n=== ③ 約束 → 果たすまで・催促（直近180日・会話の流れで見る） ===`);
  type M = { sender: string; text: string; at: number };
  const byConv = new Map<string, M[]>();
  const all = await page("messages", "conversation_id, sender, text, created_at, is_aix_generated", "created_at", 180);
  for (const m of all) { const cid = String(m.conversation_id); if (!byConv.has(cid)) byConv.set(cid, []); byConv.get(cid)!.push({ sender: String(m.sender), text: String(m.text ?? ""), at: new Date(String(m.created_at)).getTime() }); }
  const NUDGE_RE = /その後(?:いかが|どう)|どうなりました|どうでしょうか[?？]?$|まだ(?:でしょうか|ですか|ですかね)|(?:連絡|返信|返事)(?:まだ|待って|お待ち)|進捗/;
  const days: Record<string, number[]> = {}; const nudge: Record<string, { n: number; nudged: number }> = {};
  for (const arr of byConv.values()) {
    arr.sort((a, b) => a.at - b.at);
    arr.forEach((m, i) => {
      if (m.sender !== "staff") return;
      for (const p of promises(m.text)) {
        const k = kind(p); if (!/確認|物件探し|資料の送付|見積書|ご連絡|交渉/.test(k)) continue;
        const nb = nudge[k] ?? { n: 0, nudged: 0 }; nb.n++;
        // 次の「こちらの発言で果たした形跡」までの日数・その間のお客様の催促
        let done = -1; let nudged = false;
        for (let j = i + 1; j < arr.length && arr[j].at - m.at <= 14 * 86400_000; j++) {
          if (arr[j].sender === "customer" && NUDGE_RE.test(arr[j].text.trim())) nudged = true;
          if (arr[j].sender === "staff" && (/確認(?:させて(?:頂|いただ)きました|致しました|しました)|確認しましたところ|募集中|募集終了|\[画像\]|ご査収|お送りさせて(?:頂|いただ)きました|交渉(?:させて(?:頂|いただ)きました|の結果|したところ)/.test(arr[j].text))) { done = (arr[j].at - m.at) / 3600_000; break; }
        }
        if (nudged) nb.nudged++; nudge[k] = nb;
        (days[k] ??= []).push(done);
      }
    });
  }
  console.log(`   種類          約束   果たした  中央値(時間)  90%(時間)  お客様の催促`);
  for (const k of Object.keys(days)) {
    const d = days[k]; const ok = d.filter((x) => x >= 0).sort((a, b) => a - b);
    console.log(`   ${k.padEnd(12)} ${String(d.length).padStart(5)}   ${pct(ok.length, d.length).padStart(6)}   ${(ok[Math.floor(ok.length / 2)] ?? 0).toFixed(1).padStart(8)}   ${(ok[Math.floor(ok.length * 0.9)] ?? 0).toFixed(1).padStart(8)}   ${pct(nudge[k].nudged, nudge[k].n)}`);
  }
}
main().catch((e) => { console.error(e); process.exit(1); });
