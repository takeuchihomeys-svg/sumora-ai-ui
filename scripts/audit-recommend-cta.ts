// AIX【物件オススメ】1件・新着1件の締め（内覧誘導／申込誘導／ご査収／その他）を実送信で数える（読み取りのみ）
// 実行: npx tsx --env-file=.env.local scripts/audit-recommend-cta.ts [DAYS=365] [SHOW=8]
import { createClient } from "@supabase/supabase-js";
import { setRecommendClosing, appealFromPickup, resolveRecommendCta, readClosingKind, readCustomerReaction, type RecommendCtaKind } from "../app/lib/recommend-cta";

const sb = createClient(process.env.NEXT_PUBLIC_SUPABASE_URL ?? "", process.env.SUPABASE_SERVICE_ROLE_KEY ?? process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY ?? "");
const DAYS = Number(process.env.DAYS ?? 365);
const SHOW = Number(process.env.SHOW ?? 8);
const YUMA = "dd34f5b0-03bf-4dfb-a598-a4d18ebb8df7";
const since = new Date(Date.now() - DAYS * 86400_000).toISOString();
const pct = (a: number, b: number) => (b ? `${((a / b) * 100).toFixed(1)}%` : "—");
const mask = (s: string) => s.replace(/[ぁ-んァ-ヶー一-龥A-Za-z]{1,8}(?:さん|様|さま)/g, "〈お客様〉");
const WON = ["closed_won", "applying", "screening", "application", "contract", "approved"];

async function all<T>(build: (a: number, b: number) => PromiseLike<{ data: unknown; error: { message: string } | null }>): Promise<T[]> {
  const out: T[] = [];
  for (let p = 0; p < 60; p++) {
    const { data, error } = await build(p * 1000, p * 1000 + 999);
    if (error) { console.error(error.message); break; }
    const r = (data ?? []) as T[]; out.push(...r); if (r.length < 1000) break;
  }
  return out;
}

export type Closing = "viewing" | "apply" | "receipt" | "other_close" | "none";
const VIEWING = /ご案内させて(?:頂|いただ)|ご内覧|内覧(?:の|に|を|ご|可能|出来|できま)|お日にち|見学/;
const APPLY = /お申込|申込|抑え|押さえ|確保/;
const RECEIPT = /ご査収/;
const SOFT = /ごゆっくり(?:ご)?(?:確認|検討|覧)|ご確認ください|ご検討ください|お手隙/;
/** 最後の段落（空行で区切る）を読んで締めの形を決める */
export function readClosing(text: string): Closing {
  const paras = text.split(/\n\s*\n/).map((p) => p.trim()).filter(Boolean);
  const last = paras[paras.length - 1] ?? "";
  if (APPLY.test(last)) return "apply";
  if (VIEWING.test(last)) return "viewing";
  if (RECEIPT.test(last)) return "receipt";
  if (SOFT.test(last)) return "other_close";
  return "none";
}

type Msg = { id: string; conversation_id: string; text: string | null; created_at: string };
async function main() {
  // ① ai_reply_examples の物件オススメ（実送信＝sent_reply）
  const ex = (await all<{ conversation_id: string | null; aix_action: string | null; sent_reply: string | null; ai_draft: string | null; created_at: string }>((a, b) =>
    sb.from("ai_reply_examples").select("conversation_id, aix_action, sent_reply, ai_draft, created_at")
      .like("aix_action", "property_recommendation%").gte("created_at", since).order("created_at", { ascending: false }).range(a, b)))
    .filter((r) => r.conversation_id !== YUMA && (r.sent_reply ?? "").trim() && !/^\s*(\[AIX誘導中\]|__SHOWN__|\[返信不要\])\s*$/.test(r.sent_reply ?? ""));
  console.log(`ai_reply_examples 物件オススメ: ${ex.length}件`);
  const ids = [...new Set(ex.map((r) => r.conversation_id).filter((x): x is string => !!x))];
  const status = new Map<string, string>();
  for (let i = 0; i < ids.length; i += 200) {
    const { data } = await sb.from("conversations").select("id, status").in("id", ids.slice(i, i + 200));
    for (const c of (data ?? []) as Array<{ id: string; status: string | null }>) status.set(c.id, c.status ?? "");
  }
  const roomCount = (t: string) => new Set([...t.matchAll(/(?:^|\n)[\s　]*[🌟【]?[\s　]*[^\n]{2,40}?[\s　]+(\d{2,4})号?室?/gu)].map((m) => m[1])).size;
  const rows = ex.map((r) => ({ ...r, t: r.sent_reply as string, n: roomCount(r.sent_reply as string), won: WON.includes(status.get(r.conversation_id ?? "") ?? "") }));
  const cnt = (list: typeof rows) => {
    const c: Record<Closing, number> = { viewing: 0, apply: 0, receipt: 0, other_close: 0, none: 0 };
    for (const r of list) c[readClosing(r.t)]++;
    return `n=${list.length}  内覧${c.viewing}(${pct(c.viewing, list.length)}) 申込${c.apply}(${pct(c.apply, list.length)}) ご査収${c.receipt}(${pct(c.receipt, list.length)}) ほか締め${c.other_close}(${pct(c.other_close, list.length)}) 締めなし${c.none}(${pct(c.none, list.length)})`;
  };
  console.log("全体        ", cnt(rows));
  console.log("1件(部屋≤1) ", cnt(rows.filter((r) => r.n <= 1)));
  console.log("2件以上     ", cnt(rows.filter((r) => r.n >= 2)));
  console.log("1件・成約側 ", cnt(rows.filter((r) => r.n <= 1 && r.won)));
  console.log("1件・成約外 ", cnt(rows.filter((r) => r.n <= 1 && !r.won)));
  // 締めの最後の1文の形（上位）
  const forms = new Map<string, number>();
  for (const r of rows.filter((x) => x.n <= 1)) {
    const last = r.t.split(/\n\s*\n/).map((p) => p.trim()).filter(Boolean).pop() ?? "";
    const k = mask(last).replace(/\s+/g, "").slice(0, 70); forms.set(k, (forms.get(k) ?? 0) + 1);
  }
  console.log("\n1件の最後の段落（上位）");
  for (const [k, n] of [...forms].sort((a, b) => b[1] - a[1]).slice(0, 25)) console.log(String(n).padStart(4), k);
  await crossTab(rows.filter((r) => r.n <= 1));
  outputAudit(rows.filter((r) => r.n <= 1));
  await appealOnPickups();
  void SHOW;
}

// ── 締めの形（全文で見る・見積書同封の段落が最後に来る通があるため）──
type Form = "内覧誘導" | "申込誘導" | "ご査収" | "誘導なし";
const NOTVIEW = /退去予定|解約予定|以降(?:に|で)?ご内覧可能|退去後/;
export function readForm(t: string): Form {
  if (/お気に召され[^\n]{0,30}(?:申込|抑え|押さえ)|申込(?:み)?(?:し|で)[^\n]{0,8}(?:抑え|押さえ)/.test(t)) return "申込誘導";
  if (/お気に召され[^\n]{0,40}(?:ご案内|ご内覧)|ご都合よろしいお日にち/.test(t)) return "内覧誘導";
  if (/ご査収/.test(t)) return "ご査収";
  return "誘導なし";
}
type Row2 = { conversation_id: string | null; t: string; won: boolean; created_at: string };
async function crossTab(list: Row2[]) {
  const head = (t: string) => { const m = t.match(/(?:^|\n)[\s　]*[🌟【]?[\s　]*([^\n【】🌟]{2,40}?)[\s　]+(\d{2,4})号?室?/u); return m ? { name: m[1].trim(), room: m[2] } : null; };
  const forms: Form[] = ["内覧誘導", "申込誘導", "ご査収", "誘導なし"];
  const tab = (label: string, l: Array<{ t: string }>) => {
    const c = Object.fromEntries(forms.map((f) => [f, 0])) as Record<Form, number>;
    for (const r of l) c[readForm(r.t)]++;
    console.log(label.padEnd(26), `n=${String(l.length).padStart(3)}`, forms.map((f) => `${f}${String(c[f]).padStart(3)}(${pct(c[f], l.length)})`).join(" "));
  };
  console.log("\n=== 全文で見た締めの形（1件）===");
  tab("全体", list);
  tab("退去予定あり", list.filter((r) => NOTVIEW.test(r.t)));
  tab("退去予定なし", list.filter((r) => !NOTVIEW.test(r.t)));
  tab("成約側", list.filter((r) => r.won));
  tab("成約外", list.filter((r) => !r.won));
  tab("成約側・退去予定なし", list.filter((r) => r.won && !NOTVIEW.test(r.t)));
  // 採点（property_pickups）に結ぶ
  const withScore: Array<{ t: string; verdict: string | null; score: number | null; codes: string[]; won: boolean }> = [];
  const convs = [...new Set(list.map((r) => r.conversation_id).filter((x): x is string => !!x))];
  type PK = { conversation_id: string; property_name: string | null; room_no: string | null; verdict: string | null; score: number | null; reason_codes: string[] | null; created_at: string };
  const pk = new Map<string, PK[]>();
  for (let i = 0; i < convs.length; i += 100) {
    const d = await all<PK>((a, b) =>
      sb.from("property_pickups").select("conversation_id, property_name, room_no, verdict, score, reason_codes, created_at").in("conversation_id", convs.slice(i, i + 100)).range(a, b));
    for (const x of d) { const a = pk.get(x.conversation_id) ?? []; a.push(x); pk.set(x.conversation_id, a); }
  }
  const norm = (s: string) => s.normalize("NFKC").replace(/\s+/g, "").toLowerCase();
  for (const r of list) {
    const h = head(r.t); if (!h || !r.conversation_id) continue;
    const c = (pk.get(r.conversation_id) ?? []).filter((x) => x.room_no && x.room_no.replace(/^0+/, "") === h.room.replace(/^0+/, "") && x.property_name && (norm(x.property_name).includes(norm(h.name).slice(0, 6)) || norm(h.name).includes(norm(x.property_name).slice(0, 6))));
    if (!c.length) continue;
    const best = c.sort((a, b) => Math.abs(+new Date(a.created_at) - +new Date(r.created_at)) - Math.abs(+new Date(b.created_at) - +new Date(r.created_at)))[0];
    withScore.push({ t: r.t, verdict: best.verdict, score: best.score, codes: best.reason_codes ?? [], won: r.won });
  }
  console.log(`\n=== 採点に結べた ${withScore.length}件 ===`);
  const vs = [...new Set(withScore.map((x) => x.verdict ?? "null"))];
  for (const v of vs) tab(`verdict=${v}`, withScore.filter((x) => (x.verdict ?? "null") === v));
  const bands: Array<[string, (n: number) => boolean]> = [["score<50", (n) => n < 50], ["50-69", (n) => n >= 50 && n < 70], ["70-84", (n) => n >= 70 && n < 85], ["85+", (n) => n >= 85]];
  for (const [l, f] of bands) tab(l, withScore.filter((x) => x.score != null && f(x.score)));
  tab("退去予定なし・85+", withScore.filter((x) => x.score != null && x.score >= 85 && !NOTVIEW.test(x.t)));
  tab("退去予定なし・<70", withScore.filter((x) => x.score != null && x.score < 70 && !NOTVIEW.test(x.t)));
  const cc = new Map<string, number>(); for (const x of withScore) for (const c of x.codes) cc.set(c, (cc.get(c) ?? 0) + 1);
  console.log("reason_codes上位", [...cc].sort((a, b) => b[1] - a[1]).slice(0, 12).join(" "));
}
main();

// ── 出口の全件監査: 実送信の本文に3つの締めを当てて、何が変わるかを見る（誤削除0の確認）──
function outputAudit(list: Row2[]) {
  console.log("\n=== 出口の全件監査（実送信1件 " + list.length + "通に、3つの締めをそれぞれ当てる）===");
  // 2026-10-01: 行で比べる（最後の段落が「退去予定の一文⏎締め」の2行の時、締めの行だけを差し替える＝段落で比べると段落ごと落ちたように見える）
  const paras = (t: string) => t.split(/\n/).map((p) => p.trim()).filter(Boolean);
  for (const kind of ["viewing", "apply", "receipt"] as RecommendCtaKind[]) {
    let same = 0, replaced = 0, added = 0, skipped = 0, lost = 0;
    const replacedForms = new Map<string, number>();
    const lostExamples: string[] = [];
    for (const r of list) {
      const out = setRecommendClosing(r.t, kind);
      if (out.applied.some((a) => a.startsWith("skip"))) { skipped++; continue; }
      if (out.applied.length === 0) { same++; continue; }
      const before = paras(r.t), after = paras(out.text);
      // 落ちた段落（元にあって後に無い）が、締めの定型だけの段落以外にあれば誤削除
      const gone = before.filter((p) => !after.includes(p));
      const bad = gone.filter((p) => readClosingKind(p) === null);
      if (bad.length) { lost++; if (lostExamples.length < 5) lostExamples.push(mask(bad.join(" / ")).slice(0, 100)); }
      if (out.applied[0].startsWith("closing:added")) added++;
      else { replaced++; for (const g of gone) { const k = mask(g).replace(/\s+/g, "").slice(0, 50); replacedForms.set(k, (replacedForms.get(k) ?? 0) + 1); } }
    }
    console.log(`  →${kind.padEnd(8)} 変化なし${same} 差し替え${replaced} 足した${added} 建築中で除外${skipped} ／ 誤削除（定型以外の段落が落ちた）${lost}`);
    if (kind === "receipt") { console.log("    差し替えで落ちた段落の形（上位）"); for (const [k, n] of [...replacedForms].sort((a, b) => b[1] - a[1]).slice(0, 14)) console.log("     ", String(n).padStart(4), k); }
    for (const e of lostExamples) console.log("    ⚠ 誤削除:", e);
  }
  console.log("\n  実物（前 → 後・末尾2段落）");
  const shown = { viewing: 0, apply: 0, receipt: 0 } as Record<RecommendCtaKind, number>;
  for (const r of list.filter((x) => !/建築中/.test(x.t))) {
    const notv = NOTVIEW.test(r.t);
    for (const kind of ["viewing", "apply", "receipt"] as RecommendCtaKind[]) {
      if (kind === "apply" && !notv) continue;
      if (kind === "viewing" && notv) continue;
      if (shown[kind] >= 5) continue;
      const out = setRecommendClosing(r.t, kind);
      if (!out.applied.length) continue;
      shown[kind]++;
      const tail = (t: string) => paras(t).slice(-2).join(" ¦ ");
      console.log(`   [${kind}${notv ? "・退去予定" : ""}] 前: ${mask(tail(r.t)).slice(0, 140)}\n            後: ${mask(tail(out.text)).slice(0, 140)}`);
    }
  }
}

// ── 採点（property_pickups）で 刺さる/刺さらない がどう分かれるか ──
async function appealOnPickups() {
  type P = { id: number; verdict: string | null; reason_codes: string[] | null; sent_at: string | null; score: number | null; conversation_id: string | null };
  const d = await all<P>((a, b) => sb.from("property_pickups").select("id, verdict, reason_codes, sent_at, score, conversation_id").range(a, b));
  const cnt = (l: P[]) => {
    const c = { strong: 0, weak: 0, none: 0 }; const why = new Map<string, number>();
    for (const r of l) { const x = appealFromPickup(r); if (!x) c.none++; else { c[x.appeal]++; if (x.appeal === "weak") { const k = x.why.startsWith("外れ寄り") ? "外れ寄り:" + x.why.split(":")[1].split(",")[0] : x.why; why.set(k, (why.get(k) ?? 0) + 1); } } }
    return { c, why };
  };
  console.log("\n=== 採点（property_pickups）での刺さり具合の分かれ方 ===");
  for (const [label, l] of [["全行", d], ["送った行", d.filter((x) => x.sent_at)], ["pass", d.filter((x) => x.verdict === "pass")]] as const) {
    const { c, why } = cnt(l as P[]);
    console.log(`  ${label} n=${l.length}: 刺さる${c.strong}(${pct(c.strong, l.length)}) 刺さらない${c.weak}(${pct(c.weak, l.length)}) 読めない${c.none}`);
    if (label === "送った行") console.log("    刺さらない理由の上位:", [...why].sort((a, b) => b[1] - a[1]).slice(0, 12).map(([k, n]) => k + "=" + n).join(" "));
  }
  const sent = d.filter((x) => x.sent_at);
  for (const nv of [false, true]) {
    const k = { viewing: 0, apply: 0, receipt: 0 };
    for (const r of sent) k[resolveRecommendCta({ pickup: r, notViewable: nv }).kind]++;
    console.log(`  送った ${sent.length}行 × 退去予定=${nv}: 内覧${k.viewing} 申込${k.apply} ご査収${k.receipt}`);
  }

  // 当たり外れ: 送った後72時間以内のお客様の最初の発言（返信したか・前向きか）を、刺さる/刺さらないで比べる
  console.log("\n  送った行のその後（送って72時間以内のお客様の最初の発言）");
  const stat = { strong: { n: 0, replied: 0, positive: 0, hold: 0 }, weak: { n: 0, replied: 0, positive: 0, hold: 0 } };
  for (const r of sent) {
    const a = appealFromPickup(r); if (!a || !r.conversation_id || !r.sent_at) continue;
    const t0 = new Date(r.sent_at).getTime();
    const { data } = await sb.from("messages").select("sender, text, created_at").eq("conversation_id", r.conversation_id).gte("created_at", new Date(t0 - 3 * 86400_000).toISOString()).lte("created_at", new Date(t0 + 72 * 3600_000).toISOString()).order("created_at", { ascending: true });
    const ms = (data ?? []) as Array<{ sender: string; text: string | null; created_at: string }>;
    const after = ms.filter((m) => m.sender === "customer" && new Date(m.created_at).getTime() > t0 && (m.text ?? "").trim());
    const st = stat[a.appeal]; st.n++;
    if (after.length === 0) continue;
    st.replied++;
    const before = ms.filter((m) => new Date(m.created_at).getTime() <= t0);
    const rc = readCustomerReaction([...before.slice(-3), after[0]] as never);
    if (rc?.kind === "positive") st.positive++;
    if (rc?.kind && ["concern", "condition_change", "decline"].includes(rc.kind)) st.hold++;
  }
  for (const k of ["strong", "weak"] as const) console.log(`   ${k === "strong" ? "刺さる  " : "刺さらない"} n=${stat[k].n}: 返信あり${stat[k].replied}(${pct(stat[k].replied, stat[k].n)}) 前向き${stat[k].positive}(${pct(stat[k].positive, stat[k].n)}) 懸念・条件変更・断り${stat[k].hold}(${pct(stat[k].hold, stat[k].n)})`);
}
