// scripts/audit-sheet-vacancy-vs-staff-sends.ts — スタッフが実際にお客様へ送った退去予定日と、送った資料の画像の読み取り（image_details の行）を物件ごとに比べる（読むだけ・LLM なし・$0）
//
// 2026-10-13 竹内「退去予定日がどこに書いていて空室がどこに書いているか…資料の読み取る箇所を間違えていた部分等も、正確に読み取る場所が分かるように」の物差し。
//   正解: スタッフ（竹内さん・従業員）の送った文の「〇月〇日退去予定」「〇月末退去」「退去予定(10/31)」（同じ会話・同じ建物の資料を送った後〜14日）。
//   資料の値: image_details.lines（kind=property）を ①今の読み口 vacancyDateFromMaterial（ブレインの内覧の答えが使う）②行の種類（現況・退去予定・入居可能日）ごとの日付 で見る。
//   ⚠ スタッフは管理会社に確認した後の日付を書く事がある（資料より新しい）＝食い違いの全部が読み違いではない。食い違いは1件ずつ画像で確かめる（--show）。
// 実行: npx tsx --env-file=.env.local scripts/audit-sheet-vacancy-vs-staff-sends.ts [--days=90] [--show=20] [--json=out.json] [--impl=old|new]
import { createClient } from "@supabase/supabase-js";
import { writeFileSync } from "node:fs";
const sb = createClient(process.env.NEXT_PUBLIC_SUPABASE_URL ?? "", process.env.SUPABASE_SERVICE_ROLE_KEY ?? process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY ?? "");
const arg = (k: string, d: string) => (process.argv.find((a) => a.startsWith(`--${k}=`)) ?? `--${k}=${d}`).split("=").slice(1).join("=");

const nf = (s: string) => String(s ?? "").normalize("NFKC");
/** スタッフの文の退去予定日（M/D・M/末・M/上旬…）。日付が退去の語に付いている物だけ */
export function staffVacateKeys(text: string): string[] {
  const s = nf(text).replace(/20\d{2}\s*[年/.-]\s*(?=\d{1,2}\s*[月/])/g, "");
  const out = new Set<string>();
  const D = String.raw`(\d{1,2})\s*(?:月|/)\s*(\d{1,2}\s*日?|末|上旬|中旬|下旬)`;
  const res = [
    new RegExp(`${D}\\s*(?:に|頃|ごろ|付)?\\s*(?:で)?\\s*(?:ご)?(?:退去|退室|解約|空き予定|空予定)`, "g"),
    new RegExp(`(?:退去予定日?|解約予定日?|退去日)\\s*(?:は|が|[:：]|[（(])?\\s*${D}`, "g"),
  ];
  for (const re of res) for (const m of s.matchAll(re)) {
    const mo = Number(m[1]); const d = m[2].replace(/\s|日/g, "");
    if (mo < 1 || mo > 12) continue;
    if (/^\d+$/.test(d) && (Number(d) < 1 || Number(d) > 31)) continue;
    out.add(`${mo}/${/^\d+$/.test(d) ? Number(d) : d}`);
  }
  return [...out];
}
/** 行・文の中の日付（M/D・M/末・M/旬） */
export function dateKeys(t: string): string[] {
  const s = nf(t).replace(/20\d{2}\s*[年/.-]\s*(?=\d{1,2}\s*[月/.-])/g, "");
  const out = new Set<string>();
  for (const m of s.matchAll(/(?<![\d/])(\d{1,2})\s*[月/.-]\s*(\d{1,2})\s*日?(?![\d])/g)) { const mo = +m[1], d = +m[2]; if (mo >= 1 && mo <= 12 && d >= 1 && d <= 31) out.add(`${mo}/${d}`); }
  for (const m of s.matchAll(/(?<![\d/])(\d{1,2})\s*[月/]\s*(上旬|中旬|下旬|末|上|中|下)/g)) { const p = m[2].length === 1 ? m[2] + "旬" : m[2]; out.add(`${+m[1]}/${p === "下旬" ? "下旬" : p}`); }
  return [...out];
}
/** 「10/31」と「10/末」・「10/下旬」は近い（同じ月の同じ幅） */
export function near(a: string, b: string): boolean {
  if (a === b) return true;
  const [am, ad] = a.split("/"), [bm, bd] = b.split("/");
  if (am !== bm) return false;
  const band = (d: string): [number, number] => (/上/.test(d) ? [1, 10] : /中/.test(d) ? [11, 20] : /下|末/.test(d) ? [21, 31] : [Number(d), Number(d)]);
  const [a1, a2] = band(ad), [b1, b2] = band(bd);
  // 「末」と「31」・「30」は同じ扱い。幅どうしは重なれば近い
  return a1 <= b2 && b1 <= a2;
}
const mdKey = (s: string | null) => { if (!s) return null; const m = nf(s).match(/(\d{1,2})月(\d{1,2}日|末)/); return m ? `${+m[1]}/${m[2] === "末" ? "末" : parseInt(m[2], 10)}` : null; };

type Pair = {
  conv: string; at: string; property: string; staff: string[]; staffLine: string;
  sheet: string[]; consumer: string | null; vacLineKeys: string[]; moveInKeys: string[]; statusVal: string; image: string; factsVac: string | null; model: string;
  verdict: string;
};

async function main() {
  const days = Number(arg("days", "90")), show = Number(arg("show", "20"));
  const impl = arg("impl", "new");
  const vcf = await import("../app/lib/viewing-check-first");
  const consumerFn = impl === "old" && (vcf as Record<string, unknown>).vacancyDateFromMaterialLegacy
    ? (vcf as unknown as { vacancyDateFromMaterialLegacy: (l: string[]) => string | null }).vacancyDateFromMaterialLegacy
    : vcf.vacancyDateFromMaterial;
  const { buildingKeyOf, normalizeRoomNo } = await import("../app/lib/customer-state");
  const { isTestConversation } = await import("../app/lib/test-conversations");
  const since = new Date(Date.now() - days * 86400_000).toISOString();
  const msgs: Array<{ conversation_id: string; text: string; created_at: string }> = [];
  for (let f = 0; ; f += 1000) {
    const { data, error } = await sb.from("messages").select("conversation_id, text, created_at").eq("sender", "staff").gte("created_at", since).like("text", "%退去%").range(f, f + 999);
    if (error) throw new Error(error.message);
    msgs.push(...((data ?? []) as typeof msgs));
    if (!data || data.length < 1000) break;
  }
  const withDate = msgs.filter((m) => !isTestConversation(m.conversation_id) && staffVacateKeys(m.text).length > 0);
  const convs = [...new Set(withDate.map((m) => m.conversation_id))];
  type Sip = { image_url: string; conversation_id: string; property_name: string | null; room_no: string | null; created_at: string; facts: { vacancy_date?: string | null; status?: string | null } | null };
  const sips: Sip[] = [];
  for (let i = 0; i < convs.length; i += 30) {
    const { data } = await sb.from("sent_image_properties").select("image_url, conversation_id, property_name, room_no, created_at, facts").in("conversation_id", convs.slice(i, i + 30));
    sips.push(...((data ?? []) as Sip[]));
  }
  const urls = [...new Set(sips.map((s) => s.image_url))];
  const det = new Map<string, { lines: string[]; model: string }>();
  for (let i = 0; i < urls.length; i += 40) {
    const { data } = await sb.from("image_details").select("image_url, kind, lines, model").in("image_url", urls.slice(i, i + 40));
    for (const d of (data ?? []) as Array<{ image_url: string; kind: string; lines: unknown; model: string }>) {
      if (d.kind === "property" && Array.isArray(d.lines) && d.lines.length) det.set(d.image_url, { lines: (d.lines as unknown[]).map(String), model: d.model });
    }
  }
  const pairs: Pair[] = [];
  const seen = new Set<string>();
  for (const m of withDate) {
    const t = nf(m.text);
    const key = buildingKeyOf(t);
    const at = Date.parse(m.created_at);
    const cand = sips.filter((s) => s.conversation_id === m.conversation_id && s.property_name && Date.parse(s.created_at) <= at + 3600_000 && Date.parse(s.created_at) >= at - 14 * 86400_000);
    // 文の段落（🌟・空行）ごとに、建物名が入っていて退去の日付がある段落
    const blocks = t.split(/\n\s*\n|(?=🌟)/).filter((b) => staffVacateKeys(b).length);
    const useBlocks = blocks.length ? blocks : [t];
    for (const b of useBlocks) {
      const bk = buildingKeyOf(b);
      let hits = cand.filter((s) => { const k = buildingKeyOf(s.property_name); return k.length >= 4 && bk.includes(k); });
      if (!hits.length && useBlocks.length === 1) {
        // 段落に名前が無い時: 文全体に名前が1つだけ
        const names = [...new Set(cand.filter((s) => { const k = buildingKeyOf(s.property_name); return k.length >= 4 && key.includes(k); }).map((s) => buildingKeyOf(s.property_name)))];
        if (names.length === 1) hits = cand.filter((s) => buildingKeyOf(s.property_name) === names[0]);
      }
      if (!hits.length) continue;
      const roomInText = [...b.matchAll(/(\d{2,4}[A-Za-z]?)\s*号/g)].map((x) => normalizeRoomNo(x[1])).filter(Boolean) as string[];
      if (roomInText.length) { const hr = hits.filter((s) => !normalizeRoomNo(s.room_no) || roomInText.includes(normalizeRoomNo(s.room_no) as string)); if (hr.length) hits = hr; }
      // 一番新しい（文より前の）資料の読み
      hits.sort((a, c) => Date.parse(c.created_at) - Date.parse(a.created_at));
      const withDet = hits.find((s) => det.has(s.image_url));
      const sig = `${m.conversation_id}|${buildingKeyOf(hits[0].property_name)}|${staffVacateKeys(b).join(",")}`;
      if (seen.has(sig)) continue; seen.add(sig);
      const staff = staffVacateKeys(b);
      const staffLine = b.split("\n").find((x) => staffVacateKeys(x).length) ?? b.slice(0, 80);
      if (!withDet) { pairs.push({ conv: m.conversation_id, at: m.created_at, property: `${hits[0].property_name} ${hits[0].room_no ?? ""}`, staff, staffLine, sheet: [], consumer: null, vacLineKeys: [], moveInKeys: [], statusVal: "", image: hits[0].image_url, factsVac: hits[0].facts?.vacancy_date ?? null, model: "", verdict: "資料の読み取りなし" }); continue; }
      const d = det.get(withDet.image_url)!;
      const vacLines = d.lines.filter((l) => /^(現況|退去予定|入居可能日)/.test(nf(l)));
      const consumer = mdKey(consumerFn(d.lines));
      const vacLineKeys = d.lines.filter((l) => /^退去予定/.test(nf(l))).flatMap(dateKeys);
      const moveInKeys = d.lines.filter((l) => /^入居可能日/.test(nf(l))).flatMap(dateKeys);
      const statusVal = (d.lines.find((l) => /^現況/.test(nf(l))) ?? "").replace(/^現況\s*[:：]\s*/, "");
      const ok = (k: string | null) => !!k && staff.some((s) => near(s, k));
      let verdict: string;
      if (consumer && ok(consumer)) verdict = "一致";
      else if (consumer && moveInKeys.some((k) => near(k, consumer))) verdict = "誤り:入居可能日を退去予定日に";
      else if (consumer) verdict = "食い違い:別の日付";
      else if (vacLineKeys.some((k) => ok(k)) || dateKeys(statusVal).some((k) => ok(k))) verdict = "資料に旬だけ（日付にしない）";
      else if (/空室|空き$|空家|即入/.test(statusVal) && !/予定/.test(statusVal)) verdict = "資料は空室（スタッフは退去予定）";
      else if (moveInKeys.length) verdict = "退去日なし・入居可能日だけ";
      else verdict = "資料に退去日なし";
      pairs.push({ conv: m.conversation_id, at: m.created_at, property: `${withDet.property_name} ${withDet.room_no ?? ""}`, staff, staffLine, sheet: vacLines, consumer, vacLineKeys, moveInKeys, statusVal, image: withDet.image_url, factsVac: withDet.facts?.vacancy_date ?? null, model: d.model, verdict });
    }
  }
  const by = new Map<string, number>();
  for (const p of pairs) by.set(p.verdict, (by.get(p.verdict) ?? 0) + 1);
  const factsOk = pairs.filter((p) => p.factsVac).length, factsHit = pairs.filter((p) => p.factsVac && p.staff.some((s) => near(s, mdKey(p.factsVac) ?? "x"))).length;
  console.log(`スタッフの送った退去予定日（${days}日・staff ${msgs.length}通中 日付つき ${withDate.length}）× 送った資料の読み取り: 組 ${pairs.length}（impl=${impl}）`);
  for (const [k, v] of [...by.entries()].sort((a, b) => b[1] - a[1])) console.log(`  ${k}: ${v}`);
  console.log(`  （参考）sent_image_properties.facts.vacancy_date あり ${factsOk}・スタッフと同じ ${factsHit}`);
  for (const p of pairs.filter((x) => x.verdict !== "一致" && x.verdict !== "資料の読み取りなし").slice(0, show)) {
    console.log(`\n- [${p.verdict}] ${p.conv.slice(0, 8)} ${p.at.slice(0, 10)} ${p.property}\n    スタッフ「${p.staffLine.trim().slice(0, 90)}」\n    資料の行（${p.model}）: ${p.sheet.join(" ／ ")}\n    読み口=${p.consumer ?? "なし"} facts=${p.factsVac ?? "なし"}\n    ${p.image}`);
  }
  const out = arg("json", "");
  if (out) writeFileSync(out, JSON.stringify(pairs, null, 1));
}
main().catch((e) => { console.error(e); process.exit(1); });
