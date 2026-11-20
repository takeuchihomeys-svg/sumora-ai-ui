// scripts/audit-image-understanding.ts — 画像の把握の表（memory/image_understanding_map.md）の数を出す（読むだけ・LLM なし・費用0）
//
// 2026-11-21 作業員G（竹内さん 11/21「画像の把握の部分を、打ち合わせした時のように細かく行う」・土台 → 細分化 → 状況ごとの重要）
//   ① お客様の画像: 種類ごとの枚数と、読めている欄の割合（物件名・号室・家賃・管理費・間取り・面積・駅・徒歩・築年・見積の内訳）
//   ② こちらが送った画像: 役目（image_details.kind）・物件の結び付け（sent_image_properties）・中身の読み（facts）の割合
//   ③ 状況ごとの重要: お客様の画像の番（連投の束）ごとに、店（竹内さん・スタッフ）が最初に何を返したか（AIX の種類・返信の型）と、
//      その番のブレインの判断（brain_decision_logs.suggested_action・null＝返信）を、画像の種類ごとに数える
//   出すのは数だけ（お客様の文・名前・画像の中身は出さない）。⚠ 9〜22時は回さない（全件読み）。
//   使い方: npx tsx --env-file=<.env.local> scripts/audit-image-understanding.ts [--days=180] [--out=<json>] [--part=1,2,3]
import { createClient } from "@supabase/supabase-js";
import { writeFileSync } from "node:fs";
import { isTestConversation } from "../app/lib/test-conversations";
import { savedImageKind, imageKindGroup, stripImageLabel, type ImageKind } from "../app/lib/image-label";
import { factsFromPropertyText } from "../app/lib/customer-sent-property";
import { extractScreenshotProperty } from "../app/lib/own-property-match";
import { estimateFactsFromTranscript } from "../app/lib/customer-image-link";

const arg = (k: string, d: string) => process.argv.find((a) => a.startsWith(`--${k}=`))?.slice(k.length + 3) ?? d;
const DAYS = Number(arg("days", "180")), OUT = arg("out", "");
const PARTS = new Set(arg("part", "1,2,3").split(","));
const sb = createClient(process.env.NEXT_PUBLIC_SUPABASE_URL ?? "", process.env.SUPABASE_SERVICE_ROLE_KEY ?? "");
const since = new Date(Date.now() - DAYS * 86_400_000).toISOString();
const hour = new Date().getHours();
if (hour >= 9 && hour < 22 && !process.argv.includes("--force")) { console.error("9〜22時は全件読みをしない（--force で強行）"); process.exit(1); }

async function pageAll<T>(build: (from: number) => PromiseLike<{ data: unknown; error: { message: string } | null }>): Promise<T[]> {
  const out: T[] = [];
  for (let i = 0; ; i += 1000) {
    const { data, error } = await build(i);
    if (error) throw new Error(error.message);
    const rows = (data ?? []) as T[];
    out.push(...rows);
    if (rows.length < 1000) break;
  }
  return out;
}
const pct = (a: number, b: number) => (b ? `${((a / b) * 100).toFixed(1)}%` : "-");
type Img = { id: string; conversation_id: string; created_at: string; image_type: string | null; text: string };
const kindOf = (r: Img): string => {
  const t = r.text ?? "";
  if (/^\s*\[画像\]\s*$/.test(t)) return "unread";
  const k = savedImageKind(t);
  if (k) return k;
  if (/^\s*\[画像\]\s*(本人確認書類|収入証明書|申込書|[^\n]{0,12}書類)\s*$/.test(t)) return "document";
  return "no_label";
};
const report: Record<string, unknown> = { days: DAYS, at: new Date().toISOString() };

async function main() {
  const imgs = (await pageAll<Img>((i) => sb.from("messages").select("id, conversation_id, created_at, image_type, text").eq("sender", "customer").gte("created_at", since).like("text", "[画像]%").order("created_at").range(i, i + 999)))
    .filter((r) => !isTestConversation(r.conversation_id));

  // ── ① お客様の画像 ──
  if (PARTS.has("1")) {
    const byKind: Record<string, number> = {};
    const fields: Record<string, Record<string, number>> = {};
    const est = { n: 0, parsed: 0, own: 0, other: 0, total: 0, items2: 0 };
    for (const r of imgs) {
      const k = kindOf(r);
      byKind[k] = (byKind[k] ?? 0) + 1;
      const g = (k in { property_material: 1, property_screen: 1, property_ad: 1, property_photo: 1 }) ? "property" : null;
      const body = stripImageLabel((r.text ?? "").replace(/^\s*\[画像\]\s*/, ""));
      if (g) {
        const f = factsFromPropertyText(body);
        const sp = extractScreenshotProperty(r.text);
        process.env.OWN_PROPERTY_PORTAL_TITLE = "on";
        const spOn = extractScreenshotProperty(r.text);
        delete process.env.OWN_PROPERTY_PORTAL_TITLE;
        const row = (fields[k] ??= { n: 0, name: 0, name_portal_on: 0, room: 0, rent: 0, admin: 0, madori: 0, area: 0, station: 0, walk: 0, age: 0 });
        row.n++;
        if (sp?.name || f.name) row.name++;
        if (spOn?.name || f.name) row.name_portal_on++;
        if (sp?.room || spOn?.room) row.room++;
        if (f.rentYen != null) row.rent++;
        if (f.adminYen != null) row.admin++;
        if (f.madori) row.madori++;
        if (f.areaSqm != null) row.area++;
        if (f.station) row.station++;
        if (f.walk != null) row.walk++;
        if (f.ageYears != null) row.age++;
      }
      if (k === "estimate") {
        est.n++;
        const e = estimateFactsFromTranscript(body);
        if (e) { est.parsed++; if (e.company === "own") est.own++; else est.other++; if (e.items.total != null) est.total++; if (Object.keys(e.items).length >= 2) est.items2++; }
      }
    }
    report.customer = { images: imgs.length, byKind, fields, estimate: est };
    console.log(`\n=== ① お客様の画像 ${imgs.length}枚（${DAYS}日）===`);
    for (const [k, v] of Object.entries(byKind).sort((a, b) => b[1] - a[1])) console.log(`  ${k.padEnd(20)} ${v}`);
    console.log("  物件の画像の欄（読めた割合）:");
    for (const [k, r] of Object.entries(fields)) console.log(`    ${k} ${r.n}枚: 名前 ${pct(r.name, r.n)}（ポータルの見出し on ${pct(r.name_portal_on, r.n)}）・号室 ${pct(r.room, r.n)}・家賃 ${pct(r.rent, r.n)}・管理費 ${pct(r.admin, r.n)}・間取り ${pct(r.madori, r.n)}・面積 ${pct(r.area, r.n)}・駅 ${pct(r.station, r.n)}・徒歩 ${pct(r.walk, r.n)}・築年 ${pct(r.age, r.n)}`);
    console.log(`  見積書 ${est.n}枚: 内訳が取れた ${est.parsed}（弊社 ${est.own}・他社 ${est.other}）・総額 ${est.total}`);
  }

  // ── ② こちらが送った画像 ──
  if (PARTS.has("2")) {
    const sentImgs = (await pageAll<{ conversation_id: string; image_url: string | null; created_at: string; is_aix_generated: boolean | null }>((i) => sb.from("messages").select("conversation_id, image_url, created_at, is_aix_generated").neq("sender", "customer").gte("created_at", since).not("image_url", "is", null).order("created_at").range(i, i + 999)))
      .filter((r) => !isTestConversation(r.conversation_id) && r.image_url);
    const urls = new Set(sentImgs.map((r) => r.image_url!));
    const det = await pageAll<{ image_url: string; kind: string | null }>((i) => sb.from("image_details").select("image_url, kind").gte("read_at", since).range(i, i + 999));
    const sip = await pageAll<{ image_url: string; property_name: string | null; room_no: string | null; facts: Record<string, unknown> | null; source: string | null }>((i) => sb.from("sent_image_properties").select("image_url, property_name, room_no, facts, source").gte("created_at", since).range(i, i + 999));
    const detBy = new Map(det.map((d) => [d.image_url, d.kind ?? "?"]));
    const sipBy = new Map(sip.map((d) => [d.image_url, d]));
    const kinds: Record<string, number> = {};
    let withProp = 0, withRoom = 0, withFacts = 0, neither = 0, neitherAix = 0;
    const factKeys: Record<string, number> = {};
    for (const u of urls) {
      const k = detBy.get(u); const s = sipBy.get(u);
      kinds[k ?? "(役目なし)"] = (kinds[k ?? "(役目なし)"] ?? 0) + 1;
      if (s?.property_name) withProp++;
      if (s?.room_no && s.room_no !== "null") withRoom++;
      if (s?.facts && Object.keys(s.facts).length) { withFacts++; for (const fk of Object.keys(s.facts)) if (s.facts[fk] != null && s.facts[fk] !== "") factKeys[fk] = (factKeys[fk] ?? 0) + 1; }
      if (!k && !s) { neither++; if (sentImgs.find((r) => r.image_url === u)?.is_aix_generated) neitherAix++; }
    }
    report.ours = { images: urls.size, kinds, withProp, withRoom, withFacts, factKeys, neither, neitherAix };
    console.log(`\n=== ② こちらが送った画像 ${urls.size}枚（${DAYS}日）===`);
    console.log(`  役目（image_details.kind）: ${Object.entries(kinds).sort((a, b) => b[1] - a[1]).map(([k, v]) => `${k} ${v}`).join("・")}`);
    console.log(`  物件の結び付け（sent_image_properties）: 物件名 ${withProp}（${pct(withProp, urls.size)}）・号室 ${withRoom}・中身の読み facts ${withFacts}`);
    console.log(`  facts の欄: ${Object.entries(factKeys).sort((a, b) => b[1] - a[1]).map(([k, v]) => `${k} ${v}`).join("・")}`);
    console.log(`  役目も物件も無い ${neither}（うち AIX ${neitherAix}）`);
  }

  // ── ③ 状況ごとの重要: 画像の番 → 店の最初の返し・ブレインの判断 ──
  if (PARTS.has("3")) {
    const convs = [...new Set(imgs.map((r) => r.conversation_id))];
    type S = { conversation_id: string; created_at: string; text: string | null; staff_writer: string | null; is_aix_generated: boolean | null; sender: string };
    type A = { conversation_id: string; aix_type: string | null; created_at: string; sent_at: string | null };
    type B = { conversation_id: string; created_at: string; suggested_action: string | null; digest: { dir?: string; ds?: string } | null };
    const staff: S[] = [], aix: A[] = [], brain: B[] = [], cust: Array<{ conversation_id: string; created_at: string }> = [];
    for (let i = 0; i < convs.length; i += 40) {
      const ch = convs.slice(i, i + 40);
      staff.push(...await pageAll<S>((f) => sb.from("messages").select("conversation_id, created_at, text, staff_writer, is_aix_generated, sender").in("conversation_id", ch).neq("sender", "customer").gte("created_at", since).order("created_at").range(f, f + 999)));
      cust.push(...await pageAll<{ conversation_id: string; created_at: string }>((f) => sb.from("messages").select("conversation_id, created_at").in("conversation_id", ch).eq("sender", "customer").gte("created_at", since).order("created_at").range(f, f + 999)));
      aix.push(...await pageAll<A>((f) => sb.from("aix_usage_logs").select("conversation_id, aix_type, created_at, sent_at").in("conversation_id", ch).gte("created_at", since).range(f, f + 999)));
      brain.push(...await pageAll<B>((f) => sb.from("brain_decision_logs").select("conversation_id, created_at, suggested_action, digest").in("conversation_id", ch).eq("source", "brain_core").gte("created_at", since).range(f, f + 999)));
    }
    const by = <T extends { conversation_id: string }>(xs: T[]) => { const m = new Map<string, T[]>(); for (const x of xs) { const a = m.get(x.conversation_id) ?? []; a.push(x); m.set(x.conversation_id, a); } return m; };
    const staffBy = by(staff), aixBy = by(aix), brainBy = by(brain), custBy = by(cust), imgBy = by(imgs);
    const KIND_PRI = ["estimate", "property_material", "property_screen", "property_ad", "property_photo", "document", "contract_document", "unknown", "no_label", "unread"];
    const replyClass = (t: string): string => {
      if (/募集状況.{0,6}確認|空室.{0,4}確認|確認(?:させて|致し|いた)/.test(t)) return "返信:物件確認の約束";
      if (/見積/.test(t)) return "返信:見積の約束・案内";
      if (/内覧|ご案内|内見/.test(t)) return "返信:内覧";
      if (/申込|お申し込み/.test(t)) return "返信:申込";
      return "返信:その他";
    };
    type Row = { n: number; staff: Record<string, number>; take: Record<string, number>; brain: Record<string, number>; match: number; matchTake: number; nTake: number; withBrain: number };
    const tab: Record<string, Row> = {};
    let turns = 0;
    for (const [cid, list] of imgBy) {
      const cs = (custBy.get(cid) ?? []).map((m) => Date.parse(m.created_at)).sort((a, b) => a - b);
      const ss = (staffBy.get(cid) ?? []).sort((a, b) => a.created_at.localeCompare(b.created_at));
      // 連投の束: 画像から、次の店の通までのお客様の通
      const seen = new Set<number>();
      for (const im of list) {
        const t0 = Date.parse(im.created_at);
        const firstStaff = ss.find((s) => Date.parse(s.created_at) > t0);
        const key = firstStaff ? Date.parse(firstStaff.created_at) : -1;
        if (seen.has(key)) continue; // 同じ番の2枚目以降
        seen.add(key);
        const burst = list.filter((x) => Date.parse(x.created_at) >= t0 && (key < 0 || Date.parse(x.created_at) < key));
        const kinds = burst.map((b) => kindOf(b));
        const kind = KIND_PRI.find((k) => kinds.includes(k)) ?? kinds[0] ?? "?";
        const lastCust = Math.max(...cs.filter((c) => c >= t0 && (key < 0 || c < key)), t0);
        if (!firstStaff || key - lastCust > 12 * 3_600_000) continue; // 12時間以内に返していない番は数えない
        turns++;
        // 店の最初の返し: AIX（その時刻の前後2分の aix_usage_logs）か返信の型
        const ax = (aixBy.get(cid) ?? []).find((a) => Math.abs(Date.parse(a.sent_at ?? a.created_at) - key) <= 120_000);
        const staffAct = firstStaff.is_aix_generated && ax?.aix_type ? `AIX:${ax.aix_type}` : ax?.aix_type && !firstStaff.text ? `AIX:${ax.aix_type}` : replyClass(firstStaff.text ?? "");
        // ブレイン: 最後のお客様の通から店の返しまでの間の最後の判断
        const br = (brainBy.get(cid) ?? []).filter((b) => { const x = Date.parse(b.created_at); return x >= lastCust - 60_000 && x <= key; }).sort((a, b) => a.created_at.localeCompare(b.created_at)).pop();
        // ⚠ suggested_action は「後で送る AIX」も入る（2段: 今は約束の返信 → 確かめた後で AIX【物件確認した】）。
        //   digest.dir が「〜約束する返信にする」・初回の守り（ds=guard:first_contact）の番は、今の番の出力は返信として数える（11/21 作業員G: 60日の SNS・写真の番で
        //   suggested_action=物件確認した の番を読むと、初回の守り・dir「募集状況を確認すると約束する返信」の番が半分ほどあり、それは外れではなかった）
        const nowReply = !!br && (/約束する返信|返信にする/.test(br.digest?.dir ?? "") || /first_contact/.test(br.digest?.ds ?? ""));
        const brainAct = br ? (br.suggested_action && !nowReply ? `AIX:${br.suggested_action}` : nowReply && br.suggested_action ? `返信（後で AIX:${br.suggested_action}）` : "返信") : null;
        const row = (tab[kind] ??= { n: 0, staff: {}, take: {}, brain: {}, match: 0, matchTake: 0, nTake: 0, withBrain: 0 });
        row.n++;
        row.staff[staffAct] = (row.staff[staffAct] ?? 0) + 1;
        const isTake = firstStaff.staff_writer === "takeuchi";
        if (isTake) { row.nTake++; row.take[staffAct] = (row.take[staffAct] ?? 0) + 1; }
        if (brainAct) {
          row.withBrain++;
          row.brain[brainAct] = (row.brain[brainAct] ?? 0) + 1;
          const same = brainAct === staffAct || (brainAct.startsWith("返信") && staffAct.startsWith("返信:"));
          if (same) { row.match++; if (isTake) row.matchTake++; }
        }
      }
    }
    report.turns = { turns, byKind: tab };
    console.log(`\n=== ③ 画像の番 ${turns}（店が12時間以内に返した番）===`);
    const top = (o: Record<string, number>) => Object.entries(o).sort((a, b) => b[1] - a[1]).slice(0, 5).map(([k, v]) => `${k} ${v}`).join("・");
    for (const [k, r] of Object.entries(tab).sort((a, b) => b[1].n - a[1].n)) {
      console.log(`  【${k}】${r.n}番（竹内さん ${r.nTake}）・ブレインの判断あり ${r.withBrain}・一致 ${r.match}（${pct(r.match, r.withBrain)}）・竹内さんとの一致 ${r.matchTake}`);
      console.log(`     店: ${top(r.staff)}`);
      if (r.nTake) console.log(`     竹内さん: ${top(r.take)}`);
      if (r.withBrain) console.log(`     ブレイン: ${top(r.brain)}`);
    }
  }
  if (OUT) writeFileSync(OUT, JSON.stringify(report, null, 1));
}
main().catch((e) => { console.error(e); process.exit(1); });
