// scripts/yuma-coverage-matrix.ts
// 2026-10-02 竹内さん「テストの会話でaixの待ち合わせ場所で待ち合わせ決めるパターンがはいっていない。ほかにも抜けている会話あるからちゃんと色んなパターンでおこなう」:
//   YUMA の再生の場面（scripts/replay-scenarios.json と scripts/.replay-out/scen-*.json・flows-*.json）が、
//   AIX のボタン × ピッカー／場面（app/lib/aix-pickers.ts の AIX_PICKERS）と、返信で答える場面（流れの段・横の場面）をどれだけ覆っているかの表。
//   読むだけ・LLM なし。覆っていないマスが出たら、その場面を本番の会話から掘って足す（scripts/replay-scenarios-mine.ts）。
//   スタッフが押した AIX の場面（申込の場面・まとめの種類・内覧の種類・1件オススメの種類・見積書の件数）は aix_usage_logs の
//   app_sub_mode／send_mode／picker_choices。古い場面のファイルには無いので、会話と時刻で引いて補う（結果は .replay-out/coverage-cache.json に残す）。
// 実行: npx tsx --env-file=.env.local scripts/yuma-coverage-matrix.ts [--files=a.json,b.json] [--no-db]
import { createClient } from "@supabase/supabase-js";
import { readFileSync, writeFileSync, existsSync, readdirSync } from "node:fs";
import { AIX_PICKERS } from "../app/lib/aix-pickers";

type StaffAix = { aix: string; cp?: string | null; sm?: string | null; pc?: Record<string, unknown> | null };
type Scen = { id: string; stage: string; src: string; staff: { aix: StaffAix[] }; expect: { accept: string[] } };
const sb = createClient(process.env.NEXT_PUBLIC_SUPABASE_URL ?? "", process.env.SUPABASE_SERVICE_ROLE_KEY ?? process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY ?? "");
const arg = (k: string) => process.argv.find((a) => a.startsWith(`--${k}=`))?.slice(k.length + 3);
const NO_DB = process.argv.includes("--no-db");
const OUT = "scripts/.replay-out";
const files = (arg("files")?.split(",") ?? ["scripts/replay-scenarios.json", ...readdirSync(OUT).filter((f) => /^(scen|flows)-(r|cov|meet).*\.json$/.test(f)).map((f) => `${OUT}/${f}`)]).filter((f) => existsSync(f));

// ── 表のマス（コードから作る）──
type Cell = { key: string; group: string; label: string; match: (a: StaffAix) => boolean };
const opt = (aix: string, key: string) => AIX_PICKERS[aix]?.pickers.find((p) => p.key === key)?.options ?? [];
const pcv = (a: StaffAix, k: string) => (a.pc && typeof a.pc === "object" ? String((a.pc as Record<string, unknown>)[k] ?? "") : "");
const cells: Cell[] = [];
const add = (group: string, label: string, aix: string, f?: (a: StaffAix) => boolean) => cells.push({ key: `${aix}:${label}`, group, label, match: (a) => a.aix === aix && (!f || f(a)) });
add("流れ", "条件ヒアリング", "condition_hearing");
for (const o of opt("property_send", "send_mode")) add("物件ピックアップした", o.label, "property_send", (a) => (a.sm ?? pcv(a, "send_mode") ?? "") === o.value || (o.value === "normal" && !a.sm && !pcv(a, "send_mode")));
for (const o of opt("property_recommendation", "pickup_type")) add("1件オススメ", o.label, "property_recommendation", (a) => pcv(a, "pickup_type") === o.value);
for (const o of opt("property_check_result", "check_pattern")) add("物件確認した／確認した", o.label, "property_check_result", (a) => a.cp === o.value);
for (const o of opt("estimate_sheet", "estimate_count")) add("見積書送る", o.label, "estimate_sheet", (a) => pcv(a, "estimate_count") === o.value || (o.value === "single" && !pcv(a, "estimate_count")));
for (const o of opt("viewing_invite", "viewing_mode")) add("内覧調整", o.label, "viewing_invite", (a) => pcv(a, "viewing_mode") === o.value || (o.value === "通常" && !pcv(a, "viewing_mode")));
add("待ち合わせ", "待ち合わせ（時間あり）", "meeting_place", (a) => pcv(a, "has_time") !== "false");
add("待ち合わせ", "待ち合わせ（時間なし）", "meeting_place", (a) => pcv(a, "has_time") === "false");
for (const o of opt("application_push", "app_sub_mode")) add("申込へ", o.label, "application_push", (a) => (a.sm ?? pcv(a, "app_sub_mode")) === o.value);
for (const lt of ["single", "shared"]) for (const gk of ["emergency", "guarantor"]) add("申込へ", `フォーマット（${lt === "single" ? "単独" : "同居あり"}・${gk === "emergency" ? "緊急連絡先" : "連帯保証人"}）`, "application_push", (a) => (a.sm ?? pcv(a, "app_sub_mode")) === "format" && pcv(a, "living_type") === lt && pcv(a, "guarantor_kind") === gk);
for (const o of opt("followup_revive", "followup_sub_mode")) add("追客", o.label, "followup_revive", (a) => pcv(a, "followup_sub_mode") === o.value);
for (const o of opt("cost_explain", "cost_explain_mode")) add("初期費用を説明", o.label, "cost_explain", (a) => pcv(a, "cost_explain_mode") === o.value);
add("横の AIX", "初期費用について", "cost_breakdown");
add("横の AIX", "保証会社について", "guarantor_info");
add("横の AIX", "電話をかける", "phone_call");
add("横の AIX", "電話終了後", "phone_followup");
add("横の AIX", "全力サポート", "zenryoku_support");
// 返信で答える場面（スタッフは手打ち）: 場面の段 × 返信
const REPLY_STAGES: Array<[string, string]> = [["first_contact", "初回の挨拶"], ["thanks", "お礼・相づちだけ"], ["decline_wait", "断り・保留・止まった"], ["conditions", "条件の言い直し（約束の返信）"], ["more_props", "他の物件の依頼（約束の返信）"], ["url_inquiry", "持ち込み物件（約束の返信）"], ["vacancy", "空き確認（約束の返信）"], ["cost", "費用の質問（返信）"], ["procedure", "手続き・期間の質問"], ["documents", "書類の質問"], ["rent_included", "家賃込みか"], ["phone", "電話の時間"], ["viewing", "内覧の話（返信）"], ["meeting_date", "日時の確定（返信）"], ["pet_parking", "ペット・審査"], ["equipment", "設備・周辺"], ["apply", "申込の意思（返信）"], ["other", "その他"]];

// ── 場面を読む ──
const scens: Array<Scen & { file: string }> = [];
for (const f of files) { try { for (const s of (JSON.parse(readFileSync(f, "utf8")) as { scenarios: Scen[] }).scenarios) scens.push({ ...s, file: f }); } catch { /* 壊れたファイルは飛ばす */ } }

// ── 古い場面のスタッフの押下に、ピッカーの場面を補う（会話の頭8字＋時刻で aix_usage_logs を引く）──
const CACHE = `${OUT}/coverage-cache.json`;
const cache: Record<string, { sm: string | null; pc: Record<string, unknown> | null }> = existsSync(CACHE) ? JSON.parse(readFileSync(CACHE, "utf8")) : {};
const NEED_SM = new Set(["property_send", "property_recommendation", "estimate_sheet", "viewing_invite", "meeting_place", "application_push", "followup_revive", "cost_explain"]);
(async () => {
  if (!NO_DB) {
    for (const s of scens) {
      const [cid8, at] = s.src.split(" ");
      for (const a of s.staff.aix) {
        if (a.sm !== undefined || !NEED_SM.has(a.aix)) continue;
        const k = `${cid8}|${at}|${a.aix}`;
        if (!(k in cache)) {
          const from = new Date(Date.parse(`${at}:00Z`) - 60_000).toISOString(), to = new Date(Date.parse(`${at}:00Z`) + 12 * 3600_000).toISOString();
          const { data } = await sb.from("aix_usage_logs").select("conversation_id, app_sub_mode, send_mode, picker_choices, created_at").eq("aix_type", a.aix).gte("created_at", from).lte("created_at", to).order("created_at").limit(50);
          const hit = (data ?? []).find((r) => String(r.conversation_id).startsWith(cid8));
          cache[k] = { sm: (hit?.app_sub_mode ?? hit?.send_mode ?? null) as string | null, pc: (hit?.picker_choices ?? null) as Record<string, unknown> | null };
        }
        a.sm = cache[k].sm; a.pc = cache[k].pc;
      }
    }
    writeFileSync(CACHE, JSON.stringify(cache));
  }
  // ── 数える ──
  const covered = new Map<string, string[]>();
  for (const c of cells) covered.set(c.key, []);
  for (const s of scens) for (const a of s.staff.aix) for (const c of cells) if (c.match(a)) covered.get(c.key)!.push(s.id);
  const replyCov = new Map<string, string[]>();
  for (const [st] of REPLY_STAGES) replyCov.set(st, scens.filter((s) => s.stage === st && s.expect.accept.includes("reply")).map((s) => s.id));
  const total = cells.length + REPLY_STAGES.length;
  const done = [...covered.values()].filter((v) => v.length).length + [...replyCov.values()].filter((v) => v.length).length;
  console.log(`網羅の表: 場面のファイル ${files.length}・場面 ${scens.length}・マス ${total}・覆っている ${done}（${Math.round((done / total) * 100)}%）`);
  let g = "";
  for (const c of cells) { if (c.group !== g) { g = c.group; console.log(`【${g}】`); } const v = covered.get(c.key)!; console.log(`  ${v.length ? "○" : "×"} ${c.label}${v.length ? `（${v.length}: ${v.slice(0, 2).join(",")}）` : ""}`); }
  console.log("【返信で答える場面】");
  for (const [st, label] of REPLY_STAGES) { const v = replyCov.get(st)!; console.log(`  ${v.length ? "○" : "×"} ${label}${v.length ? `（${v.length}）` : ""}`); }
  const missing = [...cells.filter((c) => !covered.get(c.key)!.length).map((c) => `${c.group}/${c.label}`), ...REPLY_STAGES.filter(([st]) => !replyCov.get(st)!.length).map(([, l]) => `返信/${l}`)];
  console.log(`\n覆っていないマス ${missing.length}: ${missing.join("・")}`);
  // ── --keys-out=<file>: 覆っていない AIX のマスを本番の押下から探し、その押下の前のお客様の番を場面の鍵にする（replay-scenarios-mine.ts --pick に渡す）──
  //   本番で押された事が無いマス（電話終了後 等）は「本番で押下なし」と出す＝場面を作れない（作り話の場面は入れない）
  const keysOut = arg("keys-out");
  if (keysOut && !NO_DB) {
    const since = new Date(Date.now() - Number(arg("days") ?? "200") * 86_400_000).toISOString();
    const keys: Array<[number, string, string, string, { aix: string; cp: string | null; sm: string | null; pc: Record<string, unknown> | null }]> = [];
    for (const c of cells.filter((x) => !covered.get(x.key)!.length)) {
      const aix = c.key.split(":")[0];
      const { data } = await sb.from("aix_usage_logs").select("conversation_id, aix_type, check_pattern, app_sub_mode, send_mode, picker_choices, created_at").eq("aix_type", aix).gte("created_at", since).order("created_at", { ascending: false }).limit(1000);
      const hits = (data ?? []).filter((r) => r.conversation_id !== "dd34f5b0-03bf-4dfb-a598-a4d18ebb8df7" && c.match({ aix, cp: r.check_pattern, sm: r.app_sub_mode ?? r.send_mode ?? null, pc: r.picker_choices }));
      const convs = new Set<string>(); let got = 0;
      for (const h of hits) {
        if (got >= 2 || convs.has(h.conversation_id)) continue;
        const { data: ms } = await sb.from("messages").select("sender, created_at").eq("conversation_id", h.conversation_id).lte("created_at", h.created_at).order("created_at", { ascending: false }).limit(30);
        const list = (ms ?? []) as Array<{ sender: string; created_at: string }>;
        const lastCust = list.findIndex((m) => m.sender === "customer");
        if (lastCust < 0) continue;
        let head = lastCust; while (head + 1 < list.length && list[head + 1].sender === "customer") head++;
        keys.push([0, "other", h.conversation_id, list[head].created_at, { aix, cp: h.check_pattern ?? null, sm: h.app_sub_mode ?? h.send_mode ?? null, pc: h.picker_choices ?? null }]); convs.add(h.conversation_id); got++;
      }
      console.log(`  ${c.group}/${c.label}: 本番の押下 ${hits.length}${hits.length ? `・場面の鍵 ${got}` : "（本番で押下なし＝場面を作れない）"}`);
    }
    writeFileSync(keysOut, JSON.stringify(keys));
    console.log(`場面の鍵 ${keys.length} → ${keysOut}（npx tsx --env-file=.env.local scripts/replay-scenarios-mine.ts --days=200 --per=1 --pick=${keysOut} --pick-out=…）`);
  }
})();
