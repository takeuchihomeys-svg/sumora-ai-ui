// scripts/audit-r9s2-aix-cases.ts — 9巡目 段2（AIX の振り分けの写し 137本の無効）の前後を AIX の文で測るための「番」を本番から作る（読むだけ・LLM なし）
//
// 2026-10-08 竹内「測ってちゃんと行う。AIX の所」。正解＝竹内さんが送った AIX の通（messages.staff_writer='takeuchi'・is_aix_generated）。
//   押下（aix_usage_logs）→ その時の生成（aix_generate_log の最後の版）→ 実際に送った通 を組にし、押下の前の会話（申込の書類の手前で切る・名前は YUMA・maskPII）と
//   押下の記録（check_pattern・send_mode・app_sub_mode・物件名・状態・会話を合わせる）から aix/action の本文を作る。
//   記録に無い入力（内覧の候補日・待ち合わせの住所・見積書の物件名と額）は**送った通から**読む（＝スタッフが入れた値の近似。前後で同じ材料）。
//   段2が効くのは LLM の経路だけ（固定テンプレの経路は DB ルールを読まない）＝ LLM の経路になる本文だけを作る。
//   物件オススメ（aix/action）は画像を読む経路（DeepSeek は文字だけ）なので、文字だけで作る aix-template-generate の番（✨この会話に合った文）を別に作る。
// 実行: npx tsx --env-file=.env.local scripts/audit-r9s2-aix-cases.ts [--since=2026-09-01] [--per=12] [--out=scripts/.replay-out/r9s2-aix-cases.json]
import { createClient } from "@supabase/supabase-js";
import { writeFileSync } from "node:fs";
import { isTestConversation } from "../app/lib/test-conversations";
import { cutBeforeApplicationMaterial, applicationMaterialReason, piiValueSignal } from "../app/lib/test-pii-guard";
import { maskPII } from "../app/lib/pii-mask";
import { dice, coreOf } from "../app/lib/text-diff-types";

const sb = createClient(process.env.NEXT_PUBLIC_SUPABASE_URL ?? "", process.env.SUPABASE_SERVICE_ROLE_KEY ?? process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY ?? "");
const arg = (k: string, d = "") => process.argv.find((a) => a.startsWith(`--${k}=`))?.slice(k.length + 3) ?? d;
const SINCE = arg("since", "2026-09-01T00:00:00Z");
const PER = Number(arg("per", "12"));
const OUT = arg("out", "scripts/.replay-out/r9s2-aix-cases.json");
const ms = (s: string) => Date.parse(s);

type Press = { id: string; conversation_id: string; aix_type: string; check_pattern: string | null; send_mode: string | null; app_sub_mode: string | null; created_at: string; conversation_match: boolean | null; property_names: string[] | null; prop_statuses: string[] | null; send_keyword: string | null; estimate_sent: boolean | null };
type Msg = { id: string; conversation_id: string; sender: string; text: string | null; image_url: string | null; created_at: string; is_aix_generated: boolean | null; staff_writer: string | null };
type Gen = { conversation_id: string; action_type: string; generated_text: string | null; generated_at: string; status: string | null; conditions_snapshot: Record<string, unknown> | null };

export type Case = {
  id: string; action: string; route: "aix/action" | "aix-template-generate"; src: string; at: string;
  body: Record<string, unknown>;
  /** 竹内さんが送った通（比べる正解・伏せ済み） */
  sent: string;
  /** その時の生成（本番・伏せ済み・参考） */
  genThen: string | null;
  /** 入力に入っている文字（作り事の点検の元・伏せ済み） */
  inputText: string;
};

// 名前を YUMA に・他の個人の値を伏せる
function makeMasker(names: string[]) {
  const ns = [...new Set(names.map((s) => s.trim()).filter((s) => s.length >= 2 && s !== "YUMA"))].sort((a, b) => b.length - a.length);
  return (t: string) => {
    let r = String(t ?? "");
    for (const n of ns) r = r.split(n).join("YUMA");
    r = maskPII(r).replace(/お客様さん/g, "YUMAさん");
    return r.replace(/https?:\/\/\S+/g, "〈URL〉").replace(/0\d{1,3}-?\d{2,4}-?\d{3,4}/g, "〈電話〉");
  };
}

async function readAll<T>(q: (f: number, t: number) => PromiseLike<{ data: unknown; error: { message: string } | null }>): Promise<T[]> {
  const out: T[] = []; for (let i = 0; i < 200_000; i += 1000) { const r = await q(i, i + 999); if (r.error) throw new Error(r.error.message); const d = (r.data ?? []) as T[]; out.push(...d); if (d.length < 1000) break; } return out;
}

// 送った通から読む入力（スタッフが入れた値の近似）
const DATE_LINE = /(\d{1,2}\s*[\/月]\s*\d{1,2}|\d{1,2}日|[月火水木金土日]曜)[^\n]{0,40}(\d{1,2}[:：]\d{2}|\d{1,2}時)/;
function calendarFromSent(s: string): string {
  return s.split("\n").map((l) => l.trim()).filter((l) => DATE_LINE.test(l)).slice(0, 6).join("\n");
}
function estimateFromSent(s: string): { property_name: string; room_number: string; total: number; discount: number } | null {
  const pm = s.match(/【([^】]{2,40})】/);
  if (!pm) return null;
  const nm = pm[1].trim();
  const rm = nm.match(/^(.*?)[\s　]*(\d{2,4}[A-Za-z]?)号?室?$/);
  const tot = s.match(/初期費用[：:]\s*([\d,]+)円/);
  const dis = s.match(/([\d,]+)円割引/);
  return { property_name: rm ? rm[1].trim() : nm, room_number: rm ? rm[2] : "", total: tot ? Number(tot[1].replace(/,/g, "")) : 0, discount: dis ? Number(dis[1].replace(/,/g, "")) : 0 };
}

(async () => {
  const ACTIONS = ["property_check_result", "viewing_invite", "property_recommendation", "estimate_sheet", "property_send", "application_push", "meeting_place"];
  const [presses, gens] = await Promise.all([
    readAll<Press>((f, t) => sb.from("aix_usage_logs").select("id, conversation_id, aix_type, check_pattern, send_mode, app_sub_mode, created_at, conversation_match, property_names, prop_statuses, send_keyword, estimate_sent").in("aix_type", ACTIONS).gte("created_at", SINCE).order("created_at").range(f, t)),
    readAll<Gen>((f, t) => sb.from("aix_generate_log").select("conversation_id, action_type, generated_text, generated_at, status, conditions_snapshot").in("action_type", ACTIONS).gte("generated_at", SINCE).not("generated_text", "is", null).order("generated_at").range(f, t)),
  ]);
  const convIds = [...new Set(presses.map((p) => p.conversation_id).concat(gens.map((g) => g.conversation_id)))].filter((c) => !isTestConversation(c));
  const convs = new Map<string, { customer_name: string | null; status: string | null }>();
  for (let i = 0; i < convIds.length; i += 200) {
    const { data } = await sb.from("conversations").select("id, customer_name, status").in("id", convIds.slice(i, i + 200));
    for (const c of (data ?? []) as Array<{ id: string; customer_name: string | null; status: string | null }>) convs.set(c.id, c);
  }
  const msgCache = new Map<string, Msg[]>();
  async function msgsOf(conv: string): Promise<Msg[]> {
    if (!msgCache.has(conv)) msgCache.set(conv, await readAll<Msg>((f, t) => sb.from("messages").select("id, conversation_id, sender, text, image_url, created_at, is_aix_generated, staff_writer").eq("conversation_id", conv).order("created_at").range(f, t)));
    return msgCache.get(conv)!;
  }
  // 申込を始めた会話（申込フォーマット・申込の確認を押した後）は対象外
  const appliedAt = new Map<string, number>();
  for (const p of presses) if (p.aix_type === "application_push" && (p.app_sub_mode === "format" || p.app_sub_mode === "confirm")) { const t = ms(p.created_at); if (!appliedAt.has(p.conversation_id) || t < appliedAt.get(p.conversation_id)!) appliedAt.set(p.conversation_id, t); }

  const cases: Case[] = [];
  const stats: Record<string, Record<string, number>> = {};
  const bump = (a: string, k: string) => { stats[a] ??= {}; stats[a][k] = (stats[a][k] ?? 0) + 1; };

  async function contextBefore(conv: string, before: number, names: string[]) {
    const all = (await msgsOf(conv)).filter((m) => ms(m.created_at) < before - 1000);
    const cut = cutBeforeApplicationMaterial(all);
    if (cut.cutAt !== null) return null; // 押下の前に書類が出ている会話は使わない（申込以降）
    const mask = makeMasker(names);
    const last = cut.kept.slice(-15).map((m) => ({ sender: m.sender === "customer" ? "customer" : "staff", text: m.image_url && !(m.text ?? "").trim() ? "[画像]" : mask(m.text ?? ""), createdAt: m.created_at, rawCreatedAt: m.created_at, isAix: !!m.is_aix_generated }));
    if (last.some((m) => applicationMaterialReason(m.text) || piiValueSignal(m.text))) return null;
    return { recent: last, mask };
  }
  function staffCallNames(ms_: Msg[]): string[] {
    const out = new Set<string>();
    for (const m of ms_) if (m.sender !== "customer") { const mm = (m.text ?? "").match(/^([^\s\n、。！!]{1,8})さん/); if (mm) out.add(mm[1]); }
    return [...out];
  }

  // ── aix/action の番 ──
  const want: Record<string, (p: Press) => boolean> = {
    property_check_result: (p) => p.conversation_match === true,           // 会話を合わせる（LLM・固定の結果は文の中）
    viewing_invite: (p) => p.conversation_match === true,
    property_send: () => true,                                             // 通常も会話を合わせるも LLM
    estimate_sheet: () => true,                                            // 2通目（カバーレター）が LLM
    application_push: (p) => p.conversation_match === true && p.app_sub_mode !== "format",
    meeting_place: () => true,                                             // 本番は固定が主 → 会話を合わせるで LLM の経路を測る
  };
  const perAction: Record<string, number> = {};
  for (const p of [...presses].reverse()) { // 新しい順
    if (!want[p.aix_type]) continue;
    if (isTestConversation(p.conversation_id)) continue;
    if ((perAction[p.aix_type] ?? 0) >= PER) continue;
    const pt = ms(p.created_at);
    if (appliedAt.has(p.conversation_id) && appliedAt.get(p.conversation_id)! <= pt && p.aix_type !== "application_push") { bump(p.aix_type, "申込以降"); continue; }
    if (!want[p.aix_type](p)) { bump(p.aix_type, "LLM の経路でない"); continue; }
    const all = await msgsOf(p.conversation_id);
    const near = all.filter((m) => m.sender !== "customer" && m.is_aix_generated && ms(m.created_at) >= pt - 15 * 60_000 && ms(m.created_at) <= pt + 20 * 60_000 && (m.text ?? "").trim().length >= 10);
    if (!near.length) { bump(p.aix_type, "送った通なし"); continue; }
    const g = gens.filter((x) => x.conversation_id === p.conversation_id && x.action_type === p.aix_type && ms(x.generated_at) <= pt + 60_000 && ms(x.generated_at) >= pt - 60 * 60_000 && (x.conditions_snapshot?.source ?? "") !== "aix-template-generate").pop();
    const genText = String(g?.generated_text ?? "").trim();
    let sentMsg: Msg | undefined;
    if (p.aix_type === "estimate_sheet") {
      // 2通目（カバーレター）: 見積書の1通目の後10分以内のスタッフの文の通（手で直して送ると is_aix_generated が付かない）
      const first = near.find((m) => /初期費用[：:]/.test(m.text ?? ""));
      if (!first || /^[①②③]/.test((first.text ?? "").trim())) { bump(p.aix_type, "1通目なし・複数件（読み取りが要る）"); continue; }
      sentMsg = all.find((m) => m.sender !== "customer" && ms(m.created_at) > ms(first.created_at) && ms(m.created_at) <= ms(first.created_at) + 10 * 60_000 && !m.image_url && (m.text ?? "").trim().length >= 8 && !/初期費用[：:]/.test(m.text ?? ""));
      if (sentMsg && all.some((m) => m.sender === "customer" && ms(m.created_at) > ms(first.created_at) && ms(m.created_at) < ms(sentMsg!.created_at))) sentMsg = undefined; // お客様の発言を挟んだ物は2通目でない
      if (!sentMsg) { bump(p.aix_type, "2通目なし（カバーレターを送っていない）"); continue; }
    } else {
      sentMsg = genText ? near.map((m) => ({ m, s: dice(coreOf(genText), coreOf(m.text ?? "")) })).sort((a, b) => b.s - a.s)[0]?.m : near[0];
    }
    if (!sentMsg) { bump(p.aix_type, "送った通なし"); continue; }
    if (sentMsg.staff_writer !== "takeuchi") { bump(p.aix_type, `書き手=${sentMsg.staff_writer ?? "不明"}`); continue; }
    const conv = convs.get(p.conversation_id);
    const names = [conv?.customer_name ?? "", ...staffCallNames(all)];
    // 会話は AIX の通（送った塊の最初）・生成・押下のどれより前で切る（送った文そのものを材料に入れない）
    const blockStart = Math.min(pt, g ? ms(g.generated_at) : pt, ...near.map((m) => ms(m.created_at)), ms(sentMsg.created_at));
    const ctx = await contextBefore(p.conversation_id, blockStart, names);
    if (!ctx) { bump(p.aix_type, "書類・個人の値"); continue; }
    // 物件の住所は個人の値でない（maskPII が「住所」の札の値を伏せる → 待ち合わせだけ元に戻す）
    const propAddr = ((sentMsg.text ?? "").match(/住所[:：]\s*([^\n]+)/)?.[1] ?? "").trim();
    let sent = ctx.mask(sentMsg.text ?? "");
    if (p.aix_type === "meeting_place" && propAddr) sent = sent.replace(/(住所[:：]\s*)\[回答済み・非表示\]/, `$1${propAddr}`);
    const body: Record<string, unknown> = { action: p.aix_type, account: "sumora", conversation_id: "YUMA", customer_name: "YUMA", recent_messages: ctx.recent };
    const pn = (p.property_names ?? []).filter(Boolean);
    if (p.aix_type === "property_check_result") {
      Object.assign(body, { conversation_match: true, check_pattern: p.check_pattern ?? "available", ...(pn.length ? { property_names: pn, property_count: pn.length } : {}), ...(p.prop_statuses?.length ? { prop_statuses: p.prop_statuses } : {}) });
      // 管理会社に確認した（mgmt_*・退去日 等）はスタッフが確認した結果の入力が要る → 送った通の本文（呼びかけ・締めを除く）を入力の近似にする
      if (/^(mgmt_|vacate_date|nearby_parking)/.test(String(p.check_pattern ?? ""))) {
        const core = sent.split("\n").map((l) => l.trim()).filter((l) => l && !/^YUMAさん(お世話になっております)?[！!]*$/.test(l) && !/お手隙の際|ご確認(よろしく)?お願い|ご査収/.test(l)).join("\n");
        body.extra_input = core;
      }
    } else if (p.aix_type === "viewing_invite") {
      const cal = calendarFromSent(sent);
      Object.assign(body, { conversation_match: true, ...(cal ? { calendar_info: cal } : {}), ...(pn[0] ? { property_name: pn[0] } : {}) });
    } else if (p.aix_type === "property_send") {
      const imgs = all.filter((m) => m.sender !== "customer" && m.image_url && ms(m.created_at) >= pt - 15 * 60_000 && ms(m.created_at) <= pt + 20 * 60_000).map((m) => m.image_url!).slice(0, 10);
      Object.assign(body, { send_mode: p.send_mode ?? "simple", ...(p.conversation_match ? { conversation_match: true } : {}), ...(p.send_keyword ? { keyword: ctx.mask(p.send_keyword) } : {}), ...(imgs.length ? { image_urls: imgs, property_count: imgs.length } : {}) });
    } else if (p.aix_type === "estimate_sheet") {
      const first = near.find((m) => /初期費用[：:]/.test(m.text ?? ""));
      const est = first ? estimateFromSent(first.text ?? "") : null;
      if (!est) { bump(p.aix_type, "見積書の1通目が読めない"); continue; }
      Object.assign(body, { parsed_estimate: est, image_url: "https://example.invalid/estimate.png" });
    } else if (p.aix_type === "application_push") {
      Object.assign(body, { conversation_match: true, app_sub_mode: p.app_sub_mode ?? "push", ...(pn[0] ? { property_name: pn[0] } : {}) });
    } else if (p.aix_type === "meeting_place") {
      const addr = propAddr;
      if (!addr || !/\d/.test(addr)) { bump(p.aix_type, "住所が読めない"); continue; }
      const d = sent.match(/\d{1,2}\s*[\/月]\s*\d{1,2}\s*日?[^\n]{0,20}?\d{1,2}[:：]\d{2}/);
      Object.assign(body, { conversation_match: true, meeting_property_name: pn[0] ?? "", meeting_property_address: addr, ...(d ? { meeting_date: d[0] } : {}) });
    }
    const inputText = [...ctx.recent.map((m) => m.text), JSON.stringify({ ...body, recent_messages: undefined })].join("\n");
    cases.push({ id: `${p.aix_type}:${p.id.slice(0, 8)}`, action: p.aix_type, route: "aix/action", src: p.id, at: p.created_at, body, sent, genThen: genText ? ctx.mask(genText) : null, inputText });
    perAction[p.aix_type] = (perAction[p.aix_type] ?? 0) + 1;
    bump(p.aix_type, "採用");
  }

  // ── 物件オススメ（aix/action・画像を読む経路＝最後の Claude だけで流す）──
  let nVis = 0;
  for (const p of [...presses].reverse()) {
    if (nVis >= 4) break;
    if (p.aix_type !== "property_recommendation" || isTestConversation(p.conversation_id)) continue;
    const pt = ms(p.created_at);
    if (appliedAt.has(p.conversation_id) && appliedAt.get(p.conversation_id)! <= pt) continue;
    const g = gens.filter((x) => x.conversation_id === p.conversation_id && x.action_type === p.aix_type && ms(x.generated_at) <= pt + 60_000 && ms(x.generated_at) >= pt - 60 * 60_000 && (x.conditions_snapshot?.source ?? "") !== "aix-template-generate").pop();
    if (!g?.generated_text) continue;
    const all = await msgsOf(p.conversation_id);
    const near = all.filter((m) => m.sender !== "customer" && m.is_aix_generated && ms(m.created_at) >= pt - 15 * 60_000 && ms(m.created_at) <= pt + 20 * 60_000);
    const img = near.find((m) => m.image_url)?.image_url;
    const best = near.filter((m) => (m.text ?? "").trim().length >= 10 && !m.image_url).map((m) => ({ m, s: dice(coreOf(g.generated_text ?? ""), coreOf(m.text ?? "")) })).sort((a, b) => b.s - a.s)[0];
    if (!img || !best || best.s < 0.25 || best.m.staff_writer !== "takeuchi") continue;
    const conv = convs.get(p.conversation_id);
    const blockStart = Math.min(pt, ms(g.generated_at), ...near.map((m) => ms(m.created_at)));
    const ctx = await contextBefore(p.conversation_id, blockStart, [conv?.customer_name ?? "", ...staffCallNames(all)]);
    if (!ctx) continue;
    const body = { action: "property_recommendation", account: "sumora", conversation_id: "YUMA", customer_name: "YUMA", recent_messages: ctx.recent, image_url: img, ...(p.send_mode === "new_arrival" ? { is_new_arrival: true } : {}) };
    cases.push({ id: `rec-vision:${p.id.slice(0, 8)}`, action: "property_recommendation", route: "aix/action", src: p.id, at: p.created_at, body, sent: ctx.mask(best.m.text ?? ""), genThen: ctx.mask(g.generated_text), inputText: ctx.recent.map((m) => m.text).join("\n") });
    nVis++; bump("rec-vision", "採用");
  }

  // ── aix-template-generate の番（物件オススメ・文字だけの経路）──
  let nTpl = 0;
  for (const g of [...gens].reverse()) {
    if (nTpl >= PER) break;
    if (g.action_type !== "property_recommendation" || g.status !== "used" || (g.conditions_snapshot?.source ?? "") !== "aix-template-generate") continue;
    if (isTestConversation(g.conversation_id)) continue;
    const gt = ms(g.generated_at);
    if (appliedAt.has(g.conversation_id) && appliedAt.get(g.conversation_id)! <= gt) continue;
    const all = await msgsOf(g.conversation_id);
    const near = all.filter((m) => m.sender !== "customer" && ms(m.created_at) >= gt && ms(m.created_at) <= gt + 30 * 60_000 && (m.text ?? "").trim().length >= 10);
    const best = near.map((m) => ({ m, s: dice(coreOf(g.generated_text ?? ""), coreOf(m.text ?? "")) })).sort((a, b) => b.s - a.s)[0];
    if (!best || best.s < 0.25) { bump("rec-template", "送った通なし"); continue; }
    if (best.m.staff_writer !== "takeuchi") { bump("rec-template", `書き手=${best.m.staff_writer ?? "不明"}`); continue; }
    const conv = convs.get(g.conversation_id);
    const ctx = await contextBefore(g.conversation_id, gt, [conv?.customer_name ?? "", ...staffCallNames(all)]);
    if (!ctx) { bump("rec-template", "書類・個人の値"); continue; }
    const cs = g.conditions_snapshot ?? {};
    const body = { actionType: "property_recommendation", actionCategory: String(cs.action_category ?? "物件オススメ【AIX】"), conversationId: "YUMA", customerName: "YUMA", conversationState: String(cs.conversation_state ?? "proposing"), recentMessages: ctx.recent, ...(cs.pickup_type ? { pickupType: String(cs.pickup_type) } : {}) };
    cases.push({ id: `rec-template:${g.generated_at.slice(0, 16)}`, action: "property_recommendation", route: "aix-template-generate", src: `${g.conversation_id.slice(0, 8)}@${g.generated_at}`, at: g.generated_at, body, sent: ctx.mask(best.m.text ?? ""), genThen: ctx.mask(g.generated_text ?? ""), inputText: ctx.recent.map((m) => m.text).join("\n") });
    nTpl++; bump("rec-template", "採用");
  }

  writeFileSync(OUT, JSON.stringify({ since: SINCE, made: new Date().toISOString(), cases }, null, 1));
  console.log(`番 ${cases.length} → ${OUT}`);
  for (const [a, s] of Object.entries(stats)) console.log(`  ${a}: ${Object.entries(s).map(([k, v]) => `${k} ${v}`).join("・")}`);
})().catch((e) => { console.error(e); process.exit(1); });
