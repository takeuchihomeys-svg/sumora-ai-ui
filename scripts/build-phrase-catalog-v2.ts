// scripts/build-phrase-catalog-v2.ts — 竹内さんの言い回しの表の2版（app/lib/compose-phrase-catalog-data-v2.ts）を、竹内さん本人の LINE の送信から作る
//   2026-11-15 作業員I（竹内さん 11/15「言い回しも具体的に細かく学ぶ・ちゃんと竹内の LINE から学習する」・設計図 feeling_conductor_linkage_1115 追記3）
//   1版（build-phrase-catalog.ts）は竹内さんの返信 198番（DeepSeek の3回読みの役目）だけ。2版は本番の送信から:
//     - messages.staff_writer=takeuchi・staff_writer_confidence=sure の送信だけ（直近 --days=120）。名乗りが竹内さん以外の番（「〇〇と申します」）は外す
//     - 申込以降（turn-application-gate＝その送信の時刻で引く）・グループ（line_source_type が user でない・グループ名）・テストの会話は外す
//     - AIX の定型の通（is_aix_generated）は返信の言い回しと分けて数える（PHRASE_AIX_TEMPLATE_TABLE）。AIX の直後（10分以内・間にお客様の通なし）の手打ちは「AIX の後の2通目」
//     - 手打ちの続けての送信（3分以内・間にお客様の通なし）は1つの返信にまとめる。場面は直前のお客様の通から resolveReplyScene（generate-reply と同じ決定論）
//     - 文の役目は phrase-role-rules（決まった語）。roles-r1 で測った精度が 0.6 未満・数が 5 未満の役目は「役目不明」として数える
//   出力は札・骨（頭の言い方・終わりの言い方）・数と割合だけ（本文・お客様の発言・名前は入れない）。数が --few=10 未満の組は few:true の印
// 実行（営業時間の外・DB は読むだけ）: npx tsx --env-file=<サーバーの鍵の .env> scripts/build-phrase-catalog-v2.ts [--days=120] [--report=<比べの md>] [--dry]
import { createClient } from "@supabase/supabase-js";
import { readFileSync, writeFileSync, existsSync } from "node:fs";
import { resolve } from "node:path";
import { splitSentences, type SentenceRole } from "../app/lib/takeuchi-anatomy-roles";
import { ruleRoleOf, answerSentencesOf, ANSWER_MATCH_MIN, mainRoleOf, openerOf, keigoOf, strengthOf, formOf, selfNameOf } from "../app/lib/phrase-role-rules";
import { trustOfText, endingOf, trustSubsOfText } from "../app/lib/compose-phrase-catalog";
import { resolveReplyScene } from "../app/lib/reply-scene";
import { isGroupConversationName } from "../app/lib/line-target";
import { loadTurnApplicationRecords } from "../app/lib/turn-application-gate-server";
import { turnApplicationReason } from "../app/lib/turn-application-gate";
import * as V1 from "../app/lib/compose-phrase-catalog-data";

const ROOT = resolve(__dirname, "..");
const arg = (k: string, d = "") => (process.argv.find((a) => a.startsWith(`--${k}=`)) ?? `=${d}`).split("=").slice(1).join("=");
const DAYS = Number(arg("days", "120")) || 120, FEW = Number(arg("few", "10")) || 10, DRY = process.argv.includes("--dry");
const R1 = arg("r1", resolve(ROOT, "../../exam-cache/anatomy-roles/roles-r1.json"));
const TEST_CONVS = new Set(["dd34f5b0-03bf-4dfb-a598-a4d18ebb8df7"]);
type Msg = { id: string; conversation_id: string; sender: string; text: string | null; created_at: string; is_aix_generated: boolean | null; staff_writer: string | null; staff_writer_confidence: string | null };

async function pageAll<T>(q: (from: number, to: number) => PromiseLike<{ data: T[] | null; error: { message: string } | null }>): Promise<T[]> {
  const out: T[] = [];
  for (let from = 0; ; from += 1000) { const { data, error } = await q(from, from + 999); if (error) throw new Error(error.message); out.push(...(data ?? [])); if (!data || data.length < 1000) break; }
  return out;
}

// ─── 役目の精度（roles-r1 の3回読みの多数に当てる） ───
function measurePrecision(): Record<string, { n: number; precision: number }> {
  if (!existsSync(R1)) return {};
  const r = JSON.parse(readFileSync(R1, "utf8")) as Array<{ customer?: string | null; sentences: string[]; roles: Array<{ i: number; role: string | null }> }>;
  const c = new Map<string, { n: number; hit: number }>();
  for (const x of r) for (const y of x.roles) { if (!y.role) continue; const g = ruleRoleOf(x.sentences[y.i - 1] ?? ""); if (!g || g === "answer") continue; const t = c.get(g) ?? { n: 0, hit: 0 }; t.n++; if (g === y.role) t.hit++; c.set(g, t); }
  // answer は語だけでなく直前のお客様の問いと突き合わせて読む（answerSentencesOf）。精度が ANSWER_MATCH_MIN 未満なら役目不明のまま
  { const t = { n: 0, hit: 0 }; for (const x of r) { const a = answerSentencesOf(x.sentences, x.customer ?? null); for (const i of a.keys()) { const y = x.roles.find((z) => z.i === i + 1); if (!y?.role) continue; t.n++; if (y.role === "answer") t.hit++; } } c.set("answer", t); }
  return Object.fromEntries([...c.entries()].map(([k, t]) => [k, { n: t.n, precision: Math.round((t.hit / t.n) * 100) / 100 }]));
}

(async () => {
  const sb = createClient(process.env.NEXT_PUBLIC_SUPABASE_URL!, process.env.SUPABASE_SERVICE_ROLE_KEY!);
  const since = new Date(Date.now() - DAYS * 86400_000).toISOString();
  const prec = measurePrecision();
  const trusted = new Set(Object.entries(prec).filter(([, p]) => p.n >= 5 && p.precision >= (p === prec.answer ? ANSWER_MATCH_MIN : 0.6)).map(([k]) => k));
  // 1) 竹内さんの送信のある会話
  const tk = await pageAll<Msg>((f, t) => sb.from("messages").select("id, conversation_id, sender, text, created_at, is_aix_generated, staff_writer, staff_writer_confidence").eq("staff_writer", "takeuchi").eq("staff_writer_confidence", "sure").gte("created_at", since).order("created_at").range(f, t));
  const convIds = [...new Set(tk.map((m) => m.conversation_id))];
  const convs = new Map<string, { customer_name: string | null; line_source_type: string | null }>();
  for (let i = 0; i < convIds.length; i += 200) { const { data, error } = await sb.from("conversations").select("id, customer_name, line_source_type").in("id", convIds.slice(i, i + 200)); if (error) throw new Error(error.message); for (const c of data ?? []) convs.set(c.id as string, c as never); }
  const okConv = convIds.filter((id) => { const c = convs.get(id); return !!c && !TEST_CONVS.has(id) && !/YUMA/i.test(c.customer_name ?? "") && (!c.line_source_type || c.line_source_type === "user") && !isGroupConversationName(c.customer_name); });
  // 2) その会話の窓の中の全部の通（場面・AIX の後・まとめに使う）と申込の記録
  const all = new Map<string, Msg[]>();
  for (let i = 0; i < okConv.length; i += 50) {
    const ms = await pageAll<Msg>((f, t) => sb.from("messages").select("id, conversation_id, sender, text, created_at, is_aix_generated, staff_writer, staff_writer_confidence").in("conversation_id", okConv.slice(i, i + 50)).gte("created_at", since).order("created_at").range(f, t));
    for (const m of ms) { const a = all.get(m.conversation_id) ?? []; a.push(m); all.set(m.conversation_id, a); }
  }
  const recs = new Map<string, Awaited<ReturnType<typeof loadTurnApplicationRecords>>>();
  for (const id of okConv) recs.set(id, await loadTurnApplicationRecords(sb as never, id));

  // 3) 返信（手打ちのまとまり）と AIX の通を集める
  type Reply = { scene: string; sentences: string[]; text: string; afterAix: boolean; customer: string };
  const replies: Reply[] = [];
  const aixMsgs: Array<{ scene: string; text: string }> = [];
  const cnt = { msgs: 0, gated: 0, otherName: 0, aix: 0, replies: 0, afterAix: 0, noText: 0 };
  for (const id of okConv) {
    const ms = all.get(id) ?? [];
    let lastCustomer = "", lastCustomerAt = "", lastAixAt = 0, cur: (Reply & { lastAt: number; skip: boolean }) | null = null;
    const flush = () => { if (cur && !cur.skip && cur.sentences.length) { replies.push(cur); cnt.replies++; if (cur.afterAix) cnt.afterAix++; } cur = null; };
    for (const m of ms) {
      const at = Date.parse(m.created_at);
      if (m.sender === "customer") { flush(); if (lastCustomerAt && at - Date.parse(lastCustomerAt) > 30 * 60_000) lastCustomer = ""; lastCustomer = `${lastCustomer}\n${m.text ?? ""}`.slice(-1500); lastCustomerAt = m.created_at; continue; }
      const isTk = m.staff_writer === "takeuchi" && m.staff_writer_confidence === "sure";
      if (m.is_aix_generated) { lastAixAt = at; if (isTk && m.text?.trim()) { cnt.msgs++; if (turnApplicationReason(recs.get(id), m.created_at)) { cnt.gated++; continue; } cnt.aix++; aixMsgs.push({ scene: resolveReplyScene({ customerText: lastCustomer }).scene, text: m.text }); } continue; }
      if (!isTk) { flush(); continue; }
      if (!m.text?.trim()) { cnt.noText++; continue; }
      cnt.msgs++;
      if (turnApplicationReason(recs.get(id), m.created_at)) { cnt.gated++; flush(); continue; }
      const nm = selfNameOf(m.text);
      const skip = !!nm && !/竹内/.test(nm);
      if (skip) cnt.otherName++;
      if (cur && at - cur.lastAt <= 3 * 60_000) { cur.sentences.push(...splitSentences(m.text)); cur.text += `\n${m.text}`; cur.lastAt = at; cur.skip = cur.skip || skip; continue; }
      flush();
      cur = { scene: resolveReplyScene({ customerText: lastCustomer }).scene, customer: lastCustomer, sentences: splitSentences(m.text), text: m.text, afterAix: lastAixAt > 0 && at - lastAixAt <= 10 * 60_000, lastAt: at, skip };
    }
    flush();
  }

  // 4) 数える
  type Tab = Map<string, { n: number; m: Map<string, number> }>;
  const bump = (tab: Tab, k: string, vals: string[]) => { const t = tab.get(k) ?? { n: 0, m: new Map<string, number>() }; t.n++; for (const v of vals) t.m.set(v, (t.m.get(v) ?? 0) + 1); tab.set(k, t); };
  const answerTab: Tab = new Map();
  const emojiOther = new Map<string, Map<string, number>>();
  const trust: Tab = new Map(), trustSub: Tab = new Map(), ends: Tab = new Map(), openers: Tab = new Map(), keigo: Tab = new Map(), sceneRole: Tab = new Map(), subTab: Tab = new Map();
  const lens = new Map<string, number[]>(), emos = new Map<string, { counts: number[]; kinds: Map<string, number> }>();
  const strength = new Map<string, { bangPerSentence: number[]; emojiOk: number[]; emojiOther: number }>();
  const form = new Map<string, { lines: number[]; blank: number; brackets: number; bullets: number; n: number }>();
  const rowsTab = new Map<string, { n: number; has: Map<string, number>; pos: Map<string, number[]> }>();
  const V2_OF: Record<string, string> = { greet: "head", uke: "head", answer: "press", promise: "press", trust: "trust", barrier: "trust", worry: "latent", viewing: "bridge", apply: "bridge", estimate: "bridge", ask_send: "bridge", keep: "close", close: "close" };
  let sentencesAll = 0, unknownAll = 0;
  for (const r of replies) {
    const ans = trusted.has("answer") ? answerSentencesOf(r.sentences, r.customer) : new Map<number, { topic: string | null; source: string }>();
    const roles = r.sentences.map((s, i) => { if (ans.has(i)) return "answer" as SentenceRole; const g = ruleRoleOf(s); return g && g !== "answer" && trusted.has(g) ? g : null; });
    if (r.afterAix === false) for (const a of ans.values()) for (const k of [r.scene, "*"]) bump(answerTab, k, [`topic.${a.topic ?? "不明"}`, `source.${a.source}`]);
    sentencesAll += roles.length; unknownAll += roles.filter((x) => !x).length;
    const main = mainRoleOf(roles);
    const grp = r.afterAix ? "after_aix" : "reply";
    const keys = (k: string) => [`${r.scene}|${k}`, `*|${k}`];
    // 1版と同じ形の表（書き手に渡す所）は返信（AIX の後の2通目でない）だけで数える。AIX の後の2通目は after_aix の段（頭・敬語・強さ・形・場面×役目）で別に
    // 主の役目が answer の返信は1版と同じ形の表に入れない（answer の行は1版のまま＝11/15 の物差しで 2版の answer の行に替えると設計図の行 v2 の信頼が 20/44→10/44 に下がった）
    if (main && main !== "answer" && grp === "reply") {
      for (const k of keys(main)) { const a = lens.get(k) ?? []; a.push(r.sentences.length); lens.set(k, a); }
      for (const k of keys(main)) { bump(trust, k, trustOfText(r.text)); bump(trustSub, k, trustSubsOfText(r.text)); }
      const rs = new Set(roles.filter(Boolean) as SentenceRole[]); const last = r.sentences[r.sentences.length - 1] ?? ""; const subs: string[] = [];
      for (const b of ["viewing", "apply", "estimate", "ask_send"]) if (rs.has(b as SentenceRole)) subs.push(`bridge.${b}`);
      if (rs.has("answer")) subs.push("press.answer"); if (rs.has("promise")) subs.push("press.promise"); if (rs.has("keep")) subs.push("close.keep_promise");
      if (/何卒|よろしくお願い|お気軽に/.test(last)) subs.push("close.fixed");
      for (const k of keys(main)) bump(subTab, k, subs);
      const present = new Map<string, number>();
      roles.forEach((x, idx) => { if (!x) return; const v2 = V2_OF[x]; if (!v2 || present.has(v2)) return; present.set(v2, roles.length > 1 ? idx / (roles.length - 1) : 0); });
      for (const k of keys(main)) { const t = rowsTab.get(k) ?? { n: 0, has: new Map<string, number>(), pos: new Map<string, number[]>() }; t.n++; for (const [v2, pos] of present) { t.has.set(v2, (t.has.get(v2) ?? 0) + 1); const ps = t.pos.get(v2) ?? []; ps.push(pos); t.pos.set(v2, ps); } rowsTab.set(k, t); }
    }
    bump(sceneRole, `${grp}|${r.scene}`, [...new Set(roles.map((x) => x ?? "unknown"))]); bump(sceneRole, `${grp}|*`, [...new Set(roles.map((x) => x ?? "unknown"))]);
    r.sentences.forEach((s, i) => {
      const role = roles[i] ?? "unknown";
      if (grp === "reply") { const e = endingOf(s); for (const k of keys(role)) bump(ends, k, e ? [e] : []); }
      const o = openerOf(s); for (const k of [`${grp}|${role}`, `${grp}|*`]) bump(openers, k, o ? [o] : []);
      for (const k of [`${grp}|${role}`, `${grp}|*`]) bump(keigo, k, keigoOf(s));
    });
    const st = strengthOf(r.text), fm = formOf(r.text);
    // 許されない絵文字（😊😌🌟✨ 以外）の種類×場面（竹内さんに確かめる材料・決まりは変えない）
    for (const e of r.text.match(/\p{Extended_Pictographic}/gu) ?? []) if (!["😊", "😌", "🌟", "✨"].includes(e)) for (const k of [`${grp}|${r.scene}`, `${grp}|*`]) { const m = emojiOther.get(k) ?? new Map<string, number>(); m.set(e, (m.get(e) ?? 0) + 1); emojiOther.set(k, m); }
    for (const k of [`${grp}|${r.scene}`, `${grp}|*`]) {
      const a = strength.get(k) ?? { bangPerSentence: [], emojiOk: [], emojiOther: 0 }; a.bangPerSentence.push(Math.round((st.bangPairs / Math.max(1, r.sentences.length)) * 100) / 100); a.emojiOk.push(Object.values(st.emojiOk).reduce((x, y) => x + y, 0)); a.emojiOther += st.emojiOther; strength.set(k, a);
      const f = form.get(k) ?? { lines: [], blank: 0, brackets: 0, bullets: 0, n: 0 }; f.n++; f.lines.push(fm.lines); if (fm.blankLines) f.blank++; if (fm.brackets) f.brackets++; if (fm.bullets) f.bullets++; form.set(k, f);
    }
    if (grp === "reply") for (const k of [r.scene, "*"]) { const e = emos.get(k) ?? { counts: [] as number[], kinds: new Map<string, number>() }; const ok = Object.entries(st.emojiOk); e.counts.push(ok.reduce((x, [, c]) => x + c, 0)); for (const [x, c] of ok) e.kinds.set(x, (e.kinds.get(x) ?? 0) + c); emos.set(k, e); }
  }
  const aixTab = new Map<string, { n: number; lines: number[]; bang: number[]; emojiOk: number[]; brackets: number; keigo: Map<string, number> }>();
  for (const a of aixMsgs) for (const k of [a.scene, "*"]) {
    const t = aixTab.get(k) ?? { n: 0, lines: [], bang: [], emojiOk: [], brackets: 0, keigo: new Map<string, number>() }; t.n++;
    const st = strengthOf(a.text), fm = formOf(a.text); t.lines.push(fm.lines); t.bang.push(st.bangPairs); t.emojiOk.push(Object.values(st.emojiOk).reduce((x, y) => x + y, 0)); if (fm.brackets) t.brackets++;
    for (const g of keigoOf(a.text)) t.keigo.set(g, (t.keigo.get(g) ?? 0) + 1); aixTab.set(k, t);
  }

  // 5) 表にする（1版と同じ形＋新しい段）
  const r2 = (x: number) => Math.round(x * 100) / 100;
  const q = (a: number[], p: number) => { const b = [...a].sort((x, y) => x - y); return b.length ? b[Math.min(b.length - 1, Math.floor(p * (b.length - 1) + 0.5))] : 0; };
  type Shares = Array<[string, number]>;
  const sharesOf = (m: Map<string, number>, n: number, max: number, minC = 1): Shares => [...m.entries()].sort((a, b) => b[1] - a[1]).filter(([, c]) => c >= minC).slice(0, max).map(([x, c]) => [x, r2(c / n)]);
  const few = (n: number) => (n < FEW ? { few: true } : {});
  const tabOut = (tab: Tab, max: number, minN = 2, minC = 1) => Object.fromEntries([...tab.keys()].sort().filter((k) => tab.get(k)!.n >= minN).map((k) => { const t = tab.get(k)!; return [k, { n: t.n, shares: sharesOf(t.m, t.n, max, minC), ...few(t.n) }]; }));
  const trustOut = tabOut(trust, 4), trustSubOut = tabOut(trustSub, 8), subOut = tabOut(subTab, 12);
  const endOut = Object.fromEntries([...ends.keys()].sort().filter((k) => ends.get(k)!.n >= 4).map((k) => { const t = ends.get(k)!; return [k, { n: t.n, top: sharesOf(t.m, t.n, 3, 2), ...few(t.n) }]; }).filter(([, v]) => (v as { top: Shares }).top.length));
  const lenOut = Object.fromEntries([...lens.keys()].sort().filter((k) => lens.get(k)!.length >= 3).map((k) => { const a = lens.get(k)!; return [k, { n: a.length, median: q(a, 0.5), p25: q(a, 0.25), p75: q(a, 0.75), ...few(a.length) }]; }));
  const emoOut = Object.fromEntries([...emos.keys()].sort().map((k) => { const e = emos.get(k)!; return [k, { n: e.counts.length, median: q(e.counts, 0.5), p75: q(e.counts, 0.75), kinds: [...e.kinds.entries()].sort((a, b) => b[1] - a[1]).slice(0, 4), ...few(e.counts.length) }]; }));
  const rowsOut = Object.fromEntries([...rowsTab.keys()].sort().filter((k) => rowsTab.get(k)!.n >= 2).map((k) => { const t = rowsTab.get(k)!; return [k, { n: t.n, roles: [...t.has.entries()].map(([v2, c]) => { const ps = t.pos.get(v2) ?? []; return [v2, r2(c / t.n), r2(ps.reduce((a, b) => a + b, 0) / Math.max(1, ps.length))]; }).sort((a, b) => (a[2] as number) - (b[2] as number)), ...few(t.n) }]; }));
  const openerOut = tabOut(openers, 5, 3, 2), keigoOut = tabOut(keigo, 7, 3), sceneRoleOut = tabOut(sceneRole, 14, 2);
  const strengthOut = Object.fromEntries([...strength.keys()].sort().map((k) => { const a = strength.get(k)!; return [k, { n: a.bangPerSentence.length, bangPerSentenceMedian: q(a.bangPerSentence, 0.5), emojiOkMedian: q(a.emojiOk, 0.5), emojiOkP75: q(a.emojiOk, 0.75), emojiOther: a.emojiOther, ...few(a.bangPerSentence.length) }]; }));
  const formOut = Object.fromEntries([...form.keys()].sort().map((k) => { const f = form.get(k)!; return [k, { n: f.n, linesMedian: q(f.lines, 0.5), linesP75: q(f.lines, 0.75), blankLines: r2(f.blank / f.n), brackets: r2(f.brackets / f.n), bullets: r2(f.bullets / f.n), ...few(f.n) }]; }));
  const aixOut = Object.fromEntries([...aixTab.keys()].sort().map((k) => { const t = aixTab.get(k)!; return [k, { n: t.n, linesMedian: q(t.lines, 0.5), bangMedian: q(t.bang, 0.5), emojiOkMedian: q(t.emojiOk, 0.5), brackets: r2(t.brackets / t.n), keigo: sharesOf(t.keigo, t.n, 7), ...few(t.n) }]; }));
  const answerOut = tabOut(answerTab, 16, 2);
  const meta = { built: new Date(Date.now() + 9 * 3600_000).toISOString().slice(0, 10), days: DAYS, few: FEW, conversations: okConv.length, ...cnt, sentences: sentencesAll, unknownSentences: unknownAll, rolePrecision: prec, trustedRoles: [...trusted].sort() };
  const J = JSON.stringify;
  const body = `// app/lib/compose-phrase-catalog-data-v2.ts — scripts/build-phrase-catalog-v2.ts が作る（手で直さない）。竹内さん本人の LINE の送信（staff_writer=takeuchi・sure・直近 ${DAYS}日）から・札と骨と割合だけ（本文・名前なし）
//   返信 ${cnt.replies}（うち AIX の後の2通目 ${cnt.afterAix}）・AIX の定型の通 ${cnt.aix}（別の表）・申込以降で外した ${cnt.gated}・名乗りが別の人で外した ${cnt.otherName}・会話 ${okConv.length}・文 ${sentencesAll}（役目不明 ${unknownAll}）
//   使うのは COMPOSE_PHRASE_CATALOG_V2=on の時だけ（既定 off・compose-phrase-catalog-tables.ts）
export const PHRASE_V2_META = ${J(meta)};
export const PHRASE_CATALOG_BUILT = ${J(meta.built)};
export const PHRASE_TRUST_TABLE: Record<string, { n: number; shares: Array<[string, number]>; few?: boolean }> = ${J(trustOut)};
export const PHRASE_ENDING_TABLE: Record<string, { n: number; top: Array<[string, number]>; few?: boolean }> = ${J(endOut)};
export const PHRASE_LENGTH_TABLE: Record<string, { n: number; median: number; p25: number; p75: number; few?: boolean }> = ${J(lenOut)};
export const PHRASE_TRUST_SUB_TABLE: Record<string, { n: number; shares: Array<[string, number]>; few?: boolean }> = ${J(trustSubOut)};
export const PHRASE_SUB_TABLE: Record<string, { n: number; shares: Array<[string, number]>; few?: boolean }> = ${J(subOut)};
export const PHRASE_ROWS_TABLE: Record<string, { n: number; roles: Array<[string, number, number]>; few?: boolean }> = ${J(rowsOut)};
export const PHRASE_EMOJI_TABLE: Record<string, { n: number; median: number; p75: number; kinds: Array<[string, number]>; few?: boolean }> = ${J(emoOut)};
/** 役目ごとの頭の言い方（reply|役目・after_aix|役目） */
export const PHRASE_OPENER_TABLE: Record<string, { n: number; shares: Array<[string, number]>; few?: boolean }> = ${J(openerOut)};
/** 役目ごとの敬語の段（頂き・致します・させて頂きます・如何・何卒・御座います・幸いです の出る割合） */
export const PHRASE_KEIGO_TABLE: Record<string, { n: number; shares: Array<[string, number]>; few?: boolean }> = ${J(keigoOut)};
/** 場面×役目の選び（その場面の返信に役目が入る割合・unknown＝役目不明の文がある割合） */
export const PHRASE_SCENE_ROLE_TABLE: Record<string, { n: number; shares: Array<[string, number]>; few?: boolean }> = ${J(sceneRoleOut)};
/** 強さ（1文あたりの「！！」の中央値・許される絵文字の数・許されない絵文字の合計） */
export const PHRASE_STRENGTH_TABLE: Record<string, { n: number; bangPerSentenceMedian: number; emojiOkMedian: number; emojiOkP75: number; emojiOther: number; few?: boolean }> = ${J(strengthOut)};
/** 長さと形（行数・空行・【】・箇条書きの割合） */
export const PHRASE_FORM_TABLE: Record<string, { n: number; linesMedian: number; linesP75: number; blankLines: number; brackets: number; bullets: number; few?: boolean }> = ${J(formOut)};
/** 答え（お客様の問いと突き合わせた文）: 話題（topic.*）と出所（source.company_fact／material／needs_check）の割合 */
export const PHRASE_ANSWER_TABLE: Record<string, { n: number; shares: Array<[string, number]>; few?: boolean }> = ${J(answerOut)};
/** 許されない絵文字（😊😌🌟✨ 以外）の種類×場面の回数（返信と AIX の後の2通目。竹内さんに確かめる材料） */
export const PHRASE_EMOJI_OTHER_TABLE: Record<string, Array<[string, number]>> = ${J(Object.fromEntries([...emojiOther.keys()].sort().map((k) => [k, [...emojiOther.get(k)!.entries()].sort((a, b) => b[1] - a[1])])))};
/** AIX の定型の通（返信の言い回しと分けて数える） */
export const PHRASE_AIX_TEMPLATE_TABLE: Record<string, { n: number; linesMedian: number; bangMedian: number; emojiOkMedian: number; brackets: number; keigo: Array<[string, number]>; few?: boolean }> = ${J(aixOut)};
`;
  if (!DRY) writeFileSync(resolve(ROOT, "app/lib/compose-phrase-catalog-data-v2.ts"), body);
  console.log(JSON.stringify(meta));

  // 6) 1版との比べ（共通の鍵で）
  const rep: string[] = [`# 言い回しの表 1版（roles-r1 198番）と2版（竹内さんの LINE ${DAYS}日）の比べ（${meta.built}）`, "", `- 2版: 会話 ${okConv.length}・返信 ${cnt.replies}（AIX の後の2通目 ${cnt.afterAix}）・AIX の定型 ${cnt.aix}・文 ${sentencesAll}（役目不明 ${unknownAll}・${Math.round((unknownAll / Math.max(1, sentencesAll)) * 100)}%）`, `- 外した: 申込以降 ${cnt.gated}・名乗りが別の人 ${cnt.otherName}・文字なし ${cnt.noText}`, `- 役目の精度（roles-r1 の多数に当てた・0.6 未満と5未満は役目不明）: ${Object.entries(prec).map(([k, p]) => `${k} ${p.precision}（${p.n}）`).join("・")}`, ""];
  const v1e = V1.PHRASE_ENDING_TABLE as Record<string, { n: number; top: Shares }>, v2e = endOut as Record<string, { n: number; top: Shares }>;
  rep.push("## 文の終わりの言い方（役目ごと・全場面）", "| 役目 | 1版 n | 1版 1位 | 2版 n | 2版 1位 | 2版 2位 |", "|---|---|---|---|---|---|");
  for (const k of [...new Set([...Object.keys(v1e), ...Object.keys(v2e)])].filter((k) => k.startsWith("*|")).sort()) { const a = v1e[k], b = v2e[k]; rep.push(`| ${k.slice(2)} | ${a?.n ?? "-"} | ${a?.top[0] ? `${a.top[0][0]} ${a.top[0][1]}` : "-"} | ${b?.n ?? "-"} | ${b?.top[0] ? `${b.top[0][0]} ${b.top[0][1]}` : "-"} | ${b?.top[1] ? `${b.top[1][0]} ${b.top[1][1]}` : "-"} |`); }
  const v1l = V1.PHRASE_LENGTH_TABLE as Record<string, { n: number; median: number }>, v2l = lenOut as Record<string, { n: number; median: number; few?: boolean }>;
  rep.push("", "## 長さ（主の役目ごとの文の数の中央値）", "| 主の役目 | 1版 n | 1版 | 2版 n | 2版 |", "|---|---|---|---|---|");
  for (const k of [...new Set([...Object.keys(v1l), ...Object.keys(v2l)])].filter((k) => k.startsWith("*|")).sort()) { const a = v1l[k], b = v2l[k]; rep.push(`| ${k.slice(2)} | ${a?.n ?? "-"} | ${a?.median ?? "-"} | ${b?.n ?? "-"}${b?.few ? "（少ない）" : ""} | ${b?.median ?? "-"} |`); }
  const v1t = V1.PHRASE_TRUST_TABLE as Record<string, { n: number; shares: Shares }>, v2t = trustOut as Record<string, { n: number; shares: Shares }>;
  rep.push("", "## 信頼の作り方（主の役目ごと・上位2つ）", "| 主の役目 | 1版 | 2版 |", "|---|---|---|");
  for (const k of [...new Set([...Object.keys(v1t), ...Object.keys(v2t)])].filter((k) => k.startsWith("*|")).sort()) { const f = (r?: { n: number; shares: Shares }) => (r ? `${r.n}番: ${r.shares.slice(0, 2).map(([x, s]) => `${x} ${s}`).join("・")}` : "-"); rep.push(`| ${k.slice(2)} | ${f(v1t[k])} | ${f(v2t[k])} |`); }
  const v1m = V1.PHRASE_EMOJI_TABLE as Record<string, { n: number; median: number; kinds: Shares }>;
  rep.push("", "## 絵文字（場面ごと・1通の中央値）", "| 場面 | 1版 | 2版 |", "|---|---|---|");
  for (const k of [...new Set([...Object.keys(v1m), ...Object.keys(emoOut)])].sort()) { const a = v1m[k], b = (emoOut as Record<string, { n: number; median: number; kinds: Shares }>)[k]; rep.push(`| ${k} | ${a ? `${a.n}番 ${a.median}（${a.kinds.map(([x]) => x).join("")}）` : "-"} | ${b ? `${b.n}番 ${b.median}（${b.kinds.map(([x]) => x).join("")}）` : "-"} |`); }
  rep.push("", "## 2版だけの段", "- 強さ・形・敬語・頭の言い方・場面×役目・AIX の定型は 1版に無い（PHRASE_STRENGTH_TABLE・PHRASE_FORM_TABLE・PHRASE_KEIGO_TABLE・PHRASE_OPENER_TABLE・PHRASE_SCENE_ROLE_TABLE・PHRASE_AIX_TEMPLATE_TABLE）");
  for (const k of ["reply|*", "after_aix|*"]) { const s = (strengthOut as Record<string, { n: number; bangPerSentenceMedian: number; emojiOkMedian: number; emojiOther: number }>)[k], f = (formOut as Record<string, { n: number; linesMedian: number; brackets: number; bullets: number; blankLines: number }>)[k], g = (keigoOut as Record<string, { n: number; shares: Shares }>)[k]; if (s && f) rep.push(`- ${k}: ${s.n}通・1文の「！！」中央値 ${s.bangPerSentenceMedian}・許される絵文字 中央値 ${s.emojiOkMedian}・許されない絵文字の合計 ${s.emojiOther}・行数 中央値 ${f.linesMedian}・空行 ${f.blankLines}・【】 ${f.brackets}・箇条書き ${f.bullets}${g ? `・敬語（文ごと）${g.shares.map(([x, v]) => `${x} ${v}`).join("・")}` : ""}`); }
  const ax = (aixOut as Record<string, { n: number; linesMedian: number; bangMedian: number; brackets: number }>)["*"]; if (ax) rep.push(`- AIX の定型: ${ax.n}通・行数 中央値 ${ax.linesMedian}・「！！」中央値 ${ax.bangMedian}・【】 ${ax.brackets}`);
  const rp = arg("report"); if (rp) writeFileSync(rp, rep.join("\n")); else console.log(rep.join("\n"));
})().catch((e) => { console.error(e instanceof Error ? e.message : e); process.exit(1); });
