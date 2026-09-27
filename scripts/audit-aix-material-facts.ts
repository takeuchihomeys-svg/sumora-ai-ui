// AIX の文と資料の事実の突き合わせ（app/lib/aix-material-facts.ts）を、実送信の過去分に当てて前後を目で読む（読み取りのみ）。
// 2026-09-27 竹内さん「重い順から治す」:
//   A. 物件ピックアップの文の地域 × 送った物件の区（sent_properties → sent_image_properties.facts の駅 → 区／ピックアップの location.ward）
//   B. 物件オススメの「即入居」× 資料の入居時期（送った資料の画像の読み取り image_details／ピックアップの pdf_text）
//   C. 物件確認した（募集中）の文 × 状態（aix_generate_log.conditions_snapshot の prop_statuses・sent_property_count）
//      ＋ 物件確認した の「即入居」（根拠なし）
// 実行: npx tsx --env-file=.env.local scripts/audit-aix-material-facts.ts [--days=90] [--show=all]
import { createClient } from "@supabase/supabase-js";
import { wardOfStation } from "../app/lib/osaka-geo";
import {
  findPickupAreaConflict, wardsInPickupLine, wardOfPickupRow, shortWard, moveInFactOfPickup, findMoveInClaimConflict,
  findCheckStatusContradiction, findCheckResultMoveInClaim, sanitizeSentPropertyCount, IMMEDIATE_MOVE_IN_RE,
} from "../app/lib/aix-material-facts";

const sb = createClient(process.env.NEXT_PUBLIC_SUPABASE_URL ?? "", process.env.SUPABASE_SERVICE_ROLE_KEY ?? process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY ?? "");
const YUMA = "dd34f5b0-03bf-4dfb-a598-a4d18ebb8df7";
const arg = (k: string, d = "") => (process.argv.find((a) => a.startsWith(`--${k}=`)) ?? `--${k}=${d}`).split("=").slice(1).join("=");
const DAYS = Number(arg("days", "90"));
const SHOW_ALL = arg("show") === "all";
const since = new Date(Date.now() - DAYS * 86400000).toISOString();
const tag = (c: string) => (c === YUMA ? "YUMA" : c.slice(0, 8));

async function all<T>(build: (from: number, to: number) => PromiseLike<{ data: T[] | null; error: { message: string } | null }>): Promise<T[]> {
  const out: T[] = [];
  for (let p = 0; p < 50; p++) {
    const { data, error } = await build(p * 1000, p * 1000 + 999);
    if (error) { console.error(error.message); break; }
    out.push(...(data ?? []));
    if ((data ?? []).length < 1000) break;
  }
  return out;
}

type Usage = { conversation_id: string; aix_type: string; check_pattern: string | null; generated_text: string | null; created_at: string; sent_at: string | null; prop_statuses: string[] | null; property_names: string[] | null };

async function main() {
  const usage = await all<Usage>((f, t) => sb.from("aix_usage_logs").select("conversation_id, aix_type, check_pattern, generated_text, created_at, sent_at, prop_statuses, property_names")
    .gte("created_at", since).not("generated_text", "is", null).order("created_at", { ascending: false }).range(f, t));
  console.log(`実送信（aix_usage_logs・${DAYS}日）${usage.length}通`);

  // ── A. 物件ピックアップの地域 ─────────────────────────────────────
  const sends = usage.filter((u) => u.aix_type === "property_send");
  let a = { total: 0, textWard: 0, judged: 0, notice: 0, partial: 0 };
  const aShow: string[] = [];
  for (const u of sends) {
    a.total++;
    const text = u.generated_text ?? "";
    const written = wardsInPickupLine(text);
    if (written.length) a.textWard++;
    if (!written.length && !SHOW_ALL) continue;
    const at = Date.parse(u.sent_at ?? u.created_at);
    const { data: sp } = await sb.from("sent_properties").select("property_name, image_url, pickup_id, delivery, sent_at")
      .eq("conversation_id", u.conversation_id).gte("sent_at", new Date(at - 10 * 60000).toISOString()).lte("sent_at", new Date(at + 3 * 60000).toISOString());
    const rows = ((sp ?? []) as Array<{ property_name: string | null; image_url: string | null; pickup_id: number | null; delivery: string | null }>).filter((r) => r.delivery !== "line_group");
    if (rows.length === 0) continue;
    const wards: Array<string | null> = [];
    const pickIds = rows.map((r) => r.pickup_id).filter((x): x is number => !!x);
    const picks = new Map<number, { location: { ward?: string } | null; pdf_text: string | null }>();
    if (pickIds.length) {
      const { data: pk } = await sb.from("property_pickups").select("id, location, pdf_text").in("id", pickIds);
      for (const p of (pk ?? []) as Array<{ id: number; location: { ward?: string } | null; pdf_text: string | null }>) picks.set(p.id, p);
    }
    const imgs = rows.map((r) => r.image_url).filter((x): x is string => !!x);
    const facts = new Map<string, { station?: string } | null>();
    for (let i = 0; i < imgs.length; i += 20) {
      const { data: si } = await sb.from("sent_image_properties").select("image_url, facts").in("image_url", imgs.slice(i, i + 20));
      for (const s of (si ?? []) as Array<{ image_url: string; facts: { station?: string } | null }>) facts.set(s.image_url, s.facts);
    }
    for (const r of rows) {
      const p = r.pickup_id ? picks.get(r.pickup_id) : undefined;
      const w = p ? wardOfPickupRow(p) : null;
      const st = r.image_url ? facts.get(r.image_url)?.station : undefined;
      wards.push(w ?? (st ? wardOfStation(st) : null));
    }
    const known = wards.filter(Boolean) as string[];
    if (known.length === 0) continue;
    if (written.length) a.judged++;
    const n = findPickupAreaConflict(text, wards);
    const outside = known.filter((w) => !written.includes(w)).length;
    if (n) a.notice++; else if (written.length && outside > 0) a.partial++;
    if (n || SHOW_ALL || (written.length && outside > 0)) {
      aShow.push(`${n ? "⚠" : outside > 0 && written.length ? "△" : "○"} ${tag(u.conversation_id)} ${(u.sent_at ?? u.created_at).slice(0, 16)} 文の区=[${written.map(shortWard).join("・")}] 送った物件の区=[${known.map(shortWard).join("・")}]（${known.length}/${rows.length}件）\n     ${text.split("\n").find((l) => /ピックアップ|募集に/.test(l))?.slice(0, 110) ?? ""}${n ? `\n     注意: ${n}` : ""}`);
    }
  }
  console.log(`\n■ A. 物件ピックアップの地域: 送信 ${a.total}通・文に区 ${a.textWard}通・物件の区も分かる ${a.judged}通 → 注意 ${a.notice}通（1件も入っていない）／一部だけ外 ${a.partial}通（注意なし）`);
  aShow.forEach((s) => console.log("  " + s));

  // ── B. 物件オススメの即入居 ───────────────────────────────────────
  const recs = usage.filter((u) => u.aix_type === "property_recommendation");
  let b = { total: 0, imm: 0, withFact: 0, notice: 0, factButNoClaim: 0 };
  const bShow: string[] = [];
  for (const u of recs) {
    b.total++;
    const text = u.generated_text ?? "";
    const claims = IMMEDIATE_MOVE_IN_RE.test(text);
    if (claims) b.imm++;
    const at = Date.parse(u.sent_at ?? u.created_at);
    const { data: im } = await sb.from("messages").select("image_url").eq("conversation_id", u.conversation_id).eq("sender", "staff").not("image_url", "is", null)
      .gte("created_at", new Date(at - 5 * 60000).toISOString()).lte("created_at", new Date(at + 60000).toISOString()).order("created_at", { ascending: false }).limit(3);
    const urls = ((im ?? []) as Array<{ image_url: string }>).map((m) => m.image_url);
    let fact = null as ReturnType<typeof moveInFactOfPickup>;
    if (urls.length) {
      const { data: det } = await sb.from("image_details").select("kind, lines").in("image_url", urls);
      const d = ((det ?? []) as Array<{ kind: string; lines: string[] }>).find((x) => x.kind === "property");
      if (d) fact = moveInFactOfPickup({ image_lines: d.lines });
      // ピックアップの資料（YUMA）
      if (!fact) {
        const { data: sp } = await sb.from("sent_properties").select("pickup_id").in("image_url", urls).not("pickup_id", "is", null).limit(1);
        const pid = (sp ?? [])[0]?.pickup_id as number | undefined;
        if (pid) { const { data: pk } = await sb.from("property_pickups").select("pdf_text, terms, image_lines").eq("id", pid).maybeSingle(); if (pk) fact = moveInFactOfPickup(pk as never); }
      }
    }
    if (!fact) continue;
    b.withFact++;
    const n = findMoveInClaimConflict(text, fact);
    if (n) b.notice++;
    if (claims || SHOW_ALL) bShow.push(`${n ? "⚠" : "○"} ${tag(u.conversation_id)} ${(u.sent_at ?? u.created_at).slice(0, 16)} 資料: ${fact.lines.join("／")}（即入居=${fact.immediate}）\n     文: ${text.split("\n").find((l) => IMMEDIATE_MOVE_IN_RE.test(l))?.slice(0, 110) ?? "（即入居なし）"}`);
  }
  // YUMA の物件オススメの生成（送らなかった回も）
  const gens = await all<{ conversation_id: string; action_type: string; generated_text: string | null; created_at: string; check_pattern: string | null; conditions_snapshot: Record<string, unknown> | null }>((f, t) =>
    sb.from("aix_generate_log").select("conversation_id, action_type, generated_text, created_at, check_pattern, conditions_snapshot").gte("created_at", since).order("created_at", { ascending: false }).range(f, t));
  console.log(`\n■ B. 物件オススメの即入居: 送信 ${b.total}通・即入居を書いた ${b.imm}通・資料の入居時期が分かる ${b.withFact}通 → 注意 ${b.notice}通`);
  bShow.forEach((s) => console.log("  " + s));

  // ── C. 物件確認した（募集中）の状態の反転 ─────────────────────────
  const checks = gens.filter((g) => g.action_type === "property_check_result" && g.check_pattern === "available");
  let c = { total: 0, withStatus: 0, hold: 0, badCount: 0, imm: 0 };
  const cShow: string[] = [];
  for (const g of checks) {
    c.total++;
    const snap = g.conditions_snapshot ?? {};
    const statuses = Array.isArray(snap.prop_statuses) ? (snap.prop_statuses as string[]) : null;
    const rawSent = snap.sent_property_count;
    const sent = sanitizeSentPropertyCount(rawSent);
    if (rawSent != null && sent === null) c.badCount++;
    const pc = typeof snap.property_count === "number" ? (snap.property_count as number) : (statuses?.length ?? 1);
    const ended = sent !== null && sent > pc ? sent - pc : 0;
    const text = g.generated_text ?? "";
    const im = findCheckResultMoveInClaim(text, []);
    if (im) { c.imm++; cShow.push(`即 ${tag(g.conversation_id)} ${g.created_at.slice(0, 16)} ${im}`); }
    if (!statuses) continue;
    c.withStatus++;
    const names = Array.isArray(snap.property_names) ? (snap.property_names as string[]) : null;
    const h = findCheckStatusContradiction(text, { pattern: "available", statuses, propertyCount: pc, endedCount: ended, propertyNames: names });
    if (h) c.hold++;
    if (h || SHOW_ALL) cShow.push(`${h ? "⛔" : "○"} ${tag(g.conversation_id)} ${g.created_at.slice(0, 16)} 状態=${statuses.join(",")} 件数=${pc} 送られた=${String(rawSent)}→${sent}\n     ${text.replace(/\n/g, " / ").slice(0, 220)}${h ? `\n     止める: ${h}` : ""}`);
  }
  // 実送信（状態の記録は無いが、確認結果=募集中の通）: 残り件数の行以外で「募集していない」を書いた通
  const sentChecks = usage.filter((u) => u.aix_type === "property_check_result" && u.check_pattern === "available");
  let cs = { total: sentChecks.length, withStatus: 0, hold: 0, imm: 0 };
  const csShow: string[] = [];
  for (const u of sentChecks) {
    const text = u.generated_text ?? "";
    // 状態は aix_usage_logs.prop_statuses（M1）。送られた物件数は記録に無いので「残りあり」のゆるい形で当てる（ここで止まる通＝誤って止める候補）
    if (findCheckResultMoveInClaim(text, [])) cs.imm++;
    if (!Array.isArray(u.prop_statuses) || u.prop_statuses.length === 0) continue;
    cs.withStatus++;
    const h = findCheckStatusContradiction(text, { pattern: "available", statuses: u.prop_statuses, propertyCount: u.prop_statuses.length, endedCount: null, propertyNames: u.property_names });
    if (h) { cs.hold++; csShow.push(`${tag(u.conversation_id)} ${(u.sent_at ?? u.created_at).slice(0, 16)} ${h}\n     ${text.replace(/\n/g, " / ").slice(0, 220)}`); }
    if (findCheckResultMoveInClaim(text, [])) cs.imm++;
  }
  console.log(`\n■ C. 物件確認した（募集中）: 生成 ${c.total}通・状態の記録あり ${c.withStatus}通 → 止める ${c.hold}通／送られた物件数が範囲外 ${c.badCount}通／即入居（根拠なし） ${c.imm}通`);
  console.log(`   実送信 ${cs.total}通・状態の記録あり ${cs.withStatus}通（残りありの形で当てる）→ 止める ${cs.hold}通／即入居 ${cs.imm}通`);
  cShow.forEach((s) => console.log("  " + s));
  csShow.forEach((s) => console.log("  [実送信] " + s));
}
main().catch((e) => { console.error(e); process.exit(1); });
