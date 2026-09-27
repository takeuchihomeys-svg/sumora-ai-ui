// お客様の発言で webhook が物件確認のタスク（line_tasks property_check）を作る線を、実送信で引く（読み取りのみ・LLM は呼ばない・本文はマスク）。
// 2026-09-27（お客様役のテストで「内覧したいです」だけで物件確認のタスクが作られた）。決まり: 物件確認はお客様から依頼があった時だけ
//   （memory feedback_property_check_on_request・判定は customerRequestedPropertyCheck）。
// 数える物: 語の一覧（PROPERTY_CHECK_KEYWORDS 等）に当たったお客様の発言ごとに
//   ・語の種類（内覧・見学だけ／物件確認・空室・初期費用）
//   ・customerRequestedPropertyCheck（/api/line-tasks と同じ判定・直前20通）の結果
//   ・次にスタッフが送った AIX（72時間以内の最初の1つ）: 物件確認した／内覧へ（viewing_invite）／待ち合わせ／見積書送る／他／無し
// 実行: npx tsx --env-file=.env.local scripts/audit-property-check-task.ts   （DAYS=120・SHOW=12）
import { createClient } from "@supabase/supabase-js";
import { detectTaskTypeByKeywords, decideAutoTask } from "../app/lib/property-check-task";

const sb = createClient(process.env.NEXT_PUBLIC_SUPABASE_URL!, (process.env.SUPABASE_SERVICE_ROLE_KEY ?? process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY)!);
const YUMA = "dd34f5b0-03bf-4dfb-a598-a4d18ebb8df7";
const DAYS = Number(process.env.DAYS ?? 120);
const SHOW = Number(process.env.SHOW ?? 12);
const since = new Date(Date.now() - DAYS * 86400e3).toISOString();
// eslint-disable-next-line @typescript-eslint/no-explicit-any
async function page(table: string, cols: string, s: string | null, tcol = "created_at"): Promise<any[]> {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const out: any[] = [];
  for (let p = 0; p < 400; p++) {
    let q = sb.from(table).select(cols).order(tcol).range(p * 1000, p * 1000 + 999);
    if (s) q = q.gte(tcol, s);
    const { data, error } = await q; if (error) { console.error(table, error.message); break; }
    out.push(...(data ?? [])); if ((data ?? []).length < 1000) break;
  }
  return out;
}
const mask = (s: string) => s.replace(/0\d{1,4}-?\d{1,4}-?\d{3,4}/g, "[電話]").replace(/https?:\/\/\S+/g, "[URL]").replace(/[^\s、。！!？?「」（）()\n:：]{1,8}(さん|様)/g, "〇〇$1").replace(/\s+/g, " ");
const VIEW_ONLY_RE = /内覧|見学/;
const OTHER_RE = /物件確認|初期費用確認|初期費用を確認|空室確認|確認(?:してほしい|してください|お願い|をお願い|できますか)/;
const nextKind = (t: string | undefined) => !t ? "なし" : t.startsWith("property_check_result") ? "物件確認した" : t === "viewing_invite" ? "内覧へ" : t === "meeting_place" ? "待ち合わせ" : t === "estimate_sheet" ? "見積書送る" : t === "acknowledge_check" ? "確認します" : "他:" + t;

async function main() {
  const convs = await page("conversations", "id, line_source_type", null);
  const ok = new Set<string>(convs.filter((c) => c.id !== YUMA && c.line_source_type !== "group").map((c) => c.id));
  const msgs = (await page("messages", "conversation_id, sender, text, created_at", since)).filter((m) => ok.has(m.conversation_id));
  const aix = (await page("aix_usage_logs", "conversation_id, aix_type, check_pattern, sent_at", since)).filter((a) => a.sent_at && ok.has(a.conversation_id));
  const byConv = new Map<string, typeof msgs>(); for (const m of msgs) { const a = byConv.get(m.conversation_id) ?? []; a.push(m); byConv.set(m.conversation_id, a); }
  const aixBy = new Map<string, typeof aix>(); for (const a of aix) { const x = aixBy.get(a.conversation_id) ?? []; x.push(a); aixBy.set(a.conversation_id, x); }
  type Cell = { n: number; next: Record<string, number>; ex: string[] };
  const table: Record<string, Cell> = {};
  const add = (k: string, nk: string, ex: string) => { const c = (table[k] ??= { n: 0, next: {}, ex: [] }); c.n++; c.next[nk] = (c.next[nk] ?? 0) + 1; if (c.ex.length < SHOW) c.ex.push(`[${nk}] ${ex}`); };
  for (const [cid, list] of byConv) {
    for (let i = 0; i < list.length; i++) {
      const m = list[i];
      if (m.sender !== "customer" || !m.text) continue;
      if (detectTaskTypeByKeywords(m.text) !== "property_check") continue;
      const recent = list.slice(Math.max(0, i - 19), i + 1).map((x) => ({ sender: x.sender, text: x.text }));
      const gate = decideAutoTask(m.text, recent) === "property_check";
      const kind = OTHER_RE.test(m.text) ? "確認・空室・費用の語" : VIEW_ONLY_RE.test(m.text) ? "内覧・見学の語だけ" : "他";
      const t0 = Date.parse(m.created_at);
      const nx = (aixBy.get(cid) ?? []).find((a) => { const t = Date.parse(a.sent_at); return t > t0 && t - t0 <= 72 * 3600e3; });
      add(`${kind}｜判定=${gate ? "作る" : "作らない"}`, nextKind(nx?.aix_type), `${m.created_at.slice(0, 10)} ${cid.slice(0, 8)} 「${mask(m.text).slice(0, 70)}」`);
    }
  }
  for (const k of Object.keys(table).sort()) {
    const c = table[k];
    console.log(`\n■ ${k}  ${c.n}件  次の AIX: ${Object.entries(c.next).sort((a, b) => b[1] - a[1]).map(([a, b]) => `${a} ${b}`).join("・")}`);
    c.ex.forEach((e) => console.log("   " + e));
  }
}
main();
