// scripts/audit-draft-gap-by-scene.ts — 2巡目（10/07）: AI の下書き と スタッフが実際に送った文 の誤差を型で数える（読むだけ・LLM なし）
// 実行: npx tsx --env-file=.env.local scripts/audit-draft-gap-by-scene.ts [--days=45] [--out=<json>]
import { createClient } from "@supabase/supabase-js";
import { writeFileSync } from "node:fs";
import { classifyEdit, bigramSim, editCore } from "../app/lib/edit-diff";
import { staffActsOf } from "../app/lib/customer-sim-shadow";
import { isTestConversation } from "../app/lib/test-conversations";

const arg = (k: string, d: string) => process.argv.find((a) => a.startsWith(`--${k}=`))?.slice(k.length + 3) ?? d;
const DAYS = Number(arg("days", "45"));
const OUT = arg("out", "");
const sb = createClient(process.env.NEXT_PUBLIC_SUPABASE_URL!, process.env.SUPABASE_SERVICE_ROLE_KEY ?? process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY!);

type Row = { id: string; conversation_id: string; created_at: string; customer_message: string | null; ai_draft: string | null; sent_reply: string | null; snap: Record<string, unknown> | null };

function units(s: string): string[] {
  const out: string[] = [];
  for (const line of String(s ?? "").split(/\n+/)) {
    for (const p of line.split(/(?<=[!！]{2}|。)(?=[^!！。\s])/u)) { if (editCore(p).length >= 2) out.push(p.trim()); }
  }
  return out;
}

/** 文の役割（型）— 消した文・足した文を分ける */
const ROLE: Array<[string, RegExp]> = [
  ["作業メモ・名残", /\[AIX|【AIX|finalCheck|\*\*|^[\\"{}\[\]]|現状の会話|理解しました|FINAL_CHECK/],
  ["呼びかけだけ", /^[^。！!\s]{1,14}(?:さん|様)[、,]?$/],
  ["冒頭語（お待たせ等）", /お待たせ|お疲れ様/],
  ["伴走の宣言", /見つかるまで|全力で|サポートさせて|尽力|最善の|出来る限り/],
  ["安心させる言い切り", /ご安心|大丈夫です|問題(?:ござい|御座い|あり)ません|安心です/],
  ["挨拶・名乗り", /お世話になっております|はじめまして|担当の|と申します|こんにちは|こんばんは|おはようございます/],
  ["お礼の受け", /^(?:[^。！!]{0,12}さん)?[、,]?\s*(?:ご連絡|ご返信|ご確認|お返事|ご丁寧)?[^。！!]{0,8}ありがとうございます/],
  ["了承の受け", /^(?:[^。！!]{0,12}さん)?[、,]?\s*(?:かしこまりました|承知(?:致し|いたし|し)?ました|了解|はい[！!、])/],
  ["共感・相づち", /そうなんですね|ですよね|大変|お気持ち|嬉しい|良かった|よかった|楽しみ/],
  ["謝罪", /申し訳|すみません|失礼/],
  ["条件の復唱", /ご希望|ご条件|条件で|エリア|間取り|家賃|駅徒歩|以内/],
  ["確認の約束", /確認(?:させて|致し|いたし|して|し(?:ご連絡|次第|て)|出来次第)|お調べ|問い合わせ|問合せ|交渉させて/],
  ["探す・送る約束", /ピックアップ|お探し|探して|お送り(?:させて|致し|いたし|します)|ご紹介させて|ご提案させて/],
  ["内覧の誘い・日程", /内覧|ご案内|お日にち|日程|ご都合/],
  ["申込の誘い", /お申込|申込|抑え|押さえ|先行/],
  ["費用・金額", /初期費用|円|万|割引|見積/],
  ["物件の事実", /築|㎡|階|号室|徒歩|設備|ペット|オートロック|バストイレ|駐車|募集/],
  ["締め（よろしく）", /よろしくお願い|何卒|ご検討|お手隙|ご査収|お気軽に|いつでも|お待ちしております|ご連絡ください|お申し付け/],
  ["質問（聞き返し）", /[?？]|でしょうか|ますか$|ませんか|お聞かせ|教えて/],
];
const roleOf = (s: string) => ROLE.find(([, re]) => re.test(s.normalize("NFKC")))?.[0] ?? "その他";

/** AI の癖（人の手打ちに少ない言い回し・1巡目と 744c35dc の監査から） */
const AIISH: Array<[string, RegExp]> = [
  ["にてご案内可能です", /にて(?:ご案内|ご紹介|ご提案)可能/],
  ["ご都合よろしいお日にち御座いますでしょうか", /ご都合(?:の)?(?:よろしい|宜しい)(?:お日にち|日)[^。]{0,8}(?:御座|ござ)いますでしょうか/],
  ["させて頂きます×3以上", /(?:させて(?:頂|いただ)き[\s\S]*?){3,}/],
  ["かと存じます", /かと存じ/],
  ["幸いです", /幸いです/],
  ["ご安心ください", /ご安心/],
  ["お気軽に", /お気軽に/],
  ["何卒", /何卒/],
  ["恐れ入りますが", /恐れ入りますが|恐縮/],
  ["〜となっております", /となっております/],
];

const nSent = (s: string) => units(s).length;

async function main() {
  const since = new Date(Date.now() - DAYS * 86_400_000).toISOString();
  const rows: Row[] = [];
  for (let i = 0; ; i += 1000) {
    const { data, error } = await sb.from("ai_reply_examples")
      .select("id, conversation_id, created_at, customer_message, ai_draft, sent_reply, snap:reply_context_snapshot")
      .eq("entry_source", "line_reply").gte("created_at", since).not("ai_draft", "is", null).not("sent_reply", "is", null)
      .order("created_at").range(i, i + 999);
    if (error) throw new Error(error.message);
    rows.push(...((data ?? []) as Row[]));
    if ((data ?? []).length < 1000) break;
  }
  const SINCE_SNAP = arg("from", "");
  const use = rows.filter((r) => !SINCE_SNAP || r.created_at >= SINCE_SNAP).filter((r) => !isTestConversation(r.conversation_id) && (r.ai_draft ?? "").trim().length > 5 && (r.sent_reply ?? "").trim().length > 1 && !/^__[A-Z_]+__$/.test((r.ai_draft ?? "").trim()));
  console.log(`読む: ${since.slice(0, 10)} 以降 ${rows.length} 行・使う ${use.length}`);

  const per: Array<Record<string, unknown>> = [];
  const scene = new Map<string, { n: number; untouched: number; sim: number; aiS: number; hS: number; aiC: number; hC: number }>();
  const delRole = new Map<string, number>(), addRole = new Map<string, number>(), repRole = new Map<string, number>();
  const delRoleScene = new Map<string, Map<string, number>>();
  const aiish = new Map<string, [number, number]>();
  const delSamples = new Map<string, string[]>(), addSamples = new Map<string, string[]>();
  const actMissing = new Map<string, number>(), actExtra = new Map<string, number>();
  let untouched = 0, longer = 0, shorter = 0;
  for (const r of use) {
    const d = r.ai_draft!.trim(), s = r.sent_reply!.trim();
    const e = classifyEdit(d, s);
    const snap = (r.snap ?? {}) as Record<string, unknown>;
    const tpo = String(snap.tpo_label ?? "（記録なし）");
    const act = String(snap.effectiveAction ?? snap.rawAction ?? "");
    const sc = scene.get(tpo) ?? { n: 0, untouched: 0, sim: 0, aiS: 0, hS: 0, aiC: 0, hC: 0 };
    sc.n++; if (e.amount === "none" || e.amount === "tiny") sc.untouched++;
    sc.sim += e.sim; sc.aiS += nSent(d); sc.hS += nSent(s); sc.aiC += editCore(d).length; sc.hC += editCore(s).length;
    scene.set(tpo, sc);
    if (e.amount === "none" || e.amount === "tiny") untouched++;
    if (editCore(s).length > editCore(d).length * 1.3) longer++;
    if (editCore(s).length < editCore(d).length * 0.7) shorter++;
    // 行の対応
    const du = units(d), su = units(s);
    const usedS = new Set<number>();
    const deleted: string[] = [], rephrased: Array<[string, string]> = [], added: string[] = [];
    for (const x of du) {
      let best = -1, bs = 0;
      su.forEach((y, j) => { const v = editCore(x) === editCore(y) ? 1 : bigramSim(editCore(x), editCore(y)); if (v > bs) { bs = v; best = j; } });
      const contained = su.some((y) => editCore(y).includes(editCore(x)));
      if (bs >= 0.999 || contained) { if (best >= 0) usedS.add(best); continue; }
      if (bs >= 0.4) { rephrased.push([x, su[best]]); usedS.add(best); } else deleted.push(x);
    }
    su.forEach((y, j) => { if (usedS.has(j)) return; if (!du.some((x) => bigramSim(editCore(x), editCore(y)) >= 0.4 || editCore(x).includes(editCore(y)))) added.push(y); });
    if (e.amount !== "none" && e.amount !== "tiny") {
      for (const x of deleted) { const k = roleOf(x); delRole.set(k, (delRole.get(k) ?? 0) + 1); const m = delRoleScene.get(tpo) ?? new Map(); m.set(k, (m.get(k) ?? 0) + 1); delRoleScene.set(tpo, m); const a = delSamples.get(k) ?? []; if (a.length < 400) a.push(x); delSamples.set(k, a); }
      for (const y of added) { const k = roleOf(y); addRole.set(k, (addRole.get(k) ?? 0) + 1); const a = addSamples.get(k) ?? []; if (a.length < 400) a.push(y); addSamples.set(k, a); }
      for (const [x] of rephrased) { const k = roleOf(x); repRole.set(k, (repRole.get(k) ?? 0) + 1); }
    }
    for (const [k, re] of AIISH) { const v = aiish.get(k) ?? [0, 0]; if (re.test(d)) v[0]++; if (re.test(s)) v[1]++; aiish.set(k, v); }
    const A = staffActsOf(d), B = staffActsOf(s);
    for (const x of B) if (!A.has(x)) actMissing.set(x, (actMissing.get(x) ?? 0) + 1);
    for (const x of A) if (!B.has(x)) actExtra.set(x, (actExtra.get(x) ?? 0) + 1);
    per.push({ id: r.id, conv: r.conversation_id, at: r.created_at, tpo, act, amount: e.amount, sim: Math.round(e.sim * 100) / 100, kinds: e.kinds, aiS: du.length, hS: su.length, deleted, added, rephrased, cust: (r.customer_message ?? "").slice(0, 300), draft: d, sent: s,
      dir: String(snap.effectiveReplyDirection ?? snap.brainReplyDirection ?? "").slice(0, 300), closer: (snap.closer as { kind?: string } | undefined)?.kind ?? null, sub: (snap.substance as { kinds?: string[] } | undefined)?.kinds ?? null });
  }
  const pct = (a: number, b: number) => `${b ? Math.round((a / b) * 1000) / 10 : 0}%`;
  console.log(`\nそのまま（none/tiny）: ${untouched}/${use.length} ${pct(untouched, use.length)}・人が3割以上長く ${pct(longer, use.length)}・3割以上短く ${pct(shorter, use.length)}`);
  console.log(`\n■ 場面（tpo_label）ごと: 件数・そのまま率・似ている度・文の数 AI/人・文字 AI/人`);
  for (const [k, v] of [...scene.entries()].sort((a, b) => b[1].n - a[1].n)) {
    if (v.n < 4) continue;
    console.log(`  ${k.padEnd(28)} ${String(v.n).padStart(4)}  ${pct(v.untouched, v.n).padStart(6)}  sim ${(v.sim / v.n).toFixed(2)}  文 ${(v.aiS / v.n).toFixed(1)}/${(v.hS / v.n).toFixed(1)}  字 ${Math.round(v.aiC / v.n)}/${Math.round(v.hC / v.n)}`);
  }
  const top = (m: Map<string, number>) => [...m.entries()].sort((a, b) => b[1] - a[1]);
  const tot = (m: Map<string, number>) => [...m.values()].reduce((a, b) => a + b, 0);
  console.log(`\n■ 消した文の役割（手直しした番だけ・計 ${tot(delRole)}）`); for (const [k, v] of top(delRole)) console.log(`  ${k.padEnd(14)} ${v} (${pct(v, tot(delRole))})`);
  console.log(`\n■ 足した文の役割（計 ${tot(addRole)}）`); for (const [k, v] of top(addRole)) console.log(`  ${k.padEnd(14)} ${v} (${pct(v, tot(addRole))})`);
  console.log(`\n■ 言い換えた文の役割（計 ${tot(repRole)}）`); for (const [k, v] of top(repRole)) console.log(`  ${k.padEnd(14)} ${v}`);
  console.log(`\n■ 行為: スタッフだけ（AI が落とした）`); for (const [k, v] of top(actMissing)) console.log(`  ${k} ${v}`);
  console.log(`■ 行為: AI だけ（スタッフが消した）`); for (const [k, v] of top(actExtra)) console.log(`  ${k} ${v}`);
  console.log(`\n■ AI の癖（下書きに出た番／送った文に出た番）`); for (const [k, [a, b]] of aiish) console.log(`  ${k.padEnd(30)} ${a} / ${b}`);
  if (OUT) { writeFileSync(OUT, JSON.stringify({ per, delSamples: Object.fromEntries(delSamples), addSamples: Object.fromEntries(addSamples), delRoleScene: Object.fromEntries([...delRoleScene].map(([k, m]) => [k, Object.fromEntries(m)])) }, null, 1)); console.log(`\n書き出し: ${OUT}`); }
}
main().catch((e) => { console.error(e); process.exit(1); });
