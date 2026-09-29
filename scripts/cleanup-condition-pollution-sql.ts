// scripts/cleanup-condition-pollution-sql.ts — 条件の欄に混ざった物件の話・書類の語の「掃除の表と SQL」を作る（読むだけ・DB は書かない）
// 実行: npx tsx --env-file=.env.local scripts/cleanup-condition-pollution-sql.ts > cleanup.txt
//
// 2026-09-30 竹内（黒明様の事例）の掃除。流すのは竹内さんの確認の後（親が流す）。
//   - 根拠は condition-grounding.groundAreaTokens（お客様の条件の発言・条件の原文に根拠が無く、物件の話・書類・物件のスクショの中にだけある語）
//   - 画面・拡張の編集で入った語は人の判断なので外す（履歴の source が screen_edit、または古い履歴で直前 90 秒にお客様の発言が無い行が足した語）
//   - 「確実」: 地名の形でない語（4階のお部屋・建物名）・申込の書類の中だけ・住所（番地）の語
//     「要確認」: お客様が持ち込んだ物件（URL・物件のスクショ）の地域だけにある語（興味の地域の可能性がある）
//   - SQL は md5(今の値) で今の値が変わっていない時だけ動く形・履歴に理由を残す形。個人情報（住所）を SQL に書かない
import { createClient } from "@supabase/supabase-js";
import { groundAreaTokens } from "../app/lib/condition-grounding";
import { splitAreaTokens, areaTokenCore, inquiryShapesOf, decideAreaMode } from "../app/lib/condition-source-gate";
import { isKnownStation } from "../app/lib/osaka-geo";
import { createHash } from "crypto";

const sb = createClient(process.env.NEXT_PUBLIC_SUPABASE_URL ?? "", process.env.SUPABASE_SERVICE_ROLE_KEY ?? process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY ?? "");
const YUMA_PC = "509cd061-60cc-49a9-8c5a-4f356c4a5f88";
const YUMA_CONV = "dd34f5b0-03bf-4dfb-a598-a4d18ebb8df7";
const nf = (s: unknown) => String(s ?? "").normalize("NFKC");
const md5 = (s: string) => createHash("md5").update(s, "utf8").digest("hex");
const sq = (s: string) => `'${s.replace(/'/g, "''")}'`;
const mask = (s: string) => s.replace(/[0-9]/g, "＊");
const ADDRESS_RE = /[0-9]+-[0-9]+|丁目|番地|[0-9]{2,}$/;
/** その他の欄から外す狭い形（1件の物件の話・依頼）: 号室・N階の方/お部屋・建物名・仮押さえ・内見/内覧の希望・募集中か・住んでいる物件・新着の連絡の依頼 */
const EXIT_OR_RE = /号室|(?:[0-9]+|[一二三四五六七八九十]+)階の(?:方|お部屋|部屋|物件)|抑えつつ|仮押さえ|内見希望|内覧予定物件|募集中の物件かどうか|に住んでいる|新着でオススメ物件があればご連絡|レオンコンフォート|メロディハイム|プレジオ/;
const NOT_PLACE_RE = /(?:[0-9]+|[一二三四五六七八九十]+)階|号室|部屋|物件/;

async function all<T>(q: (a: number, b: number) => PromiseLike<{ data: T[] | null; error: { message: string } | null }>): Promise<T[]> {
  const out: T[] = [];
  for (let a = 0; ; a += 1000) { const { data, error } = await q(a, a + 999); if (error) throw new Error(error.message); out.push(...(data ?? [])); if (!data || data.length < 1000) break; }
  return out;
}

async function main() {
  const pcs = await all<{ id: string; desired_area: string | null; raw_format_text: string | null; area_mode: string | null; status: string | null; other_requests: string | null }>((a, b) =>
    sb.from("property_customers").select("id, desired_area, raw_format_text, area_mode, status, other_requests").neq("id", YUMA_PC).range(a, b));
  const convs = await all<{ id: string; property_customer_id: string | null; status: string | null }>((a, b) => sb.from("conversations").select("id, property_customer_id, status").not("property_customer_id", "is", null).range(a, b));
  const convOf = new Map<string, { ids: string[]; status: string | null }>();
  for (const c of convs) if (c.id !== YUMA_CONV) { const x = convOf.get(c.property_customer_id!) ?? { ids: [], status: c.status }; x.ids.push(c.id); convOf.set(c.property_customer_id!, x); }
  const hist = await all<{ property_customer_id: string; changed_field: string; old_value: string | null; new_value: string | null; source_message_id: string | null; created_at: string }>((a, b) =>
    sb.from("property_condition_history").select("property_customer_id, changed_field, old_value, new_value, source_message_id, created_at").eq("changed_field", "desired_area").range(a, b));
  const histBy = new Map<string, typeof hist>();
  for (const h of hist) histBy.set(h.property_customer_id, [...(histBy.get(h.property_customer_id) ?? []), h]);

  const rowsSure: string[] = [], rowsCheck: string[] = [], sqlSure: string[] = [], sqlCheck: string[] = [];
  for (const pc of pcs) {
    const conv = convOf.get(pc.id);
    const ids = conv?.ids ?? [];
    const msgs = ids.length ? await all<{ id: string; text: string | null; created_at: string }>((a, b) => sb.from("messages").select("id, text, created_at").in("conversation_id", ids).eq("sender", "customer").order("created_at").range(a, b)) : [];
    const h = histBy.get(pc.id) ?? [];
    const g = groundAreaTokens({ desiredArea: pc.desired_area, rawFormatText: pc.raw_format_text, customerMessages: msgs, history: h });
    // 画面・拡張の編集で入った語（履歴の source が screen_edit、または古い履歴で直前 90 秒にお客様の発言が無い行が足した語）は人の判断＝外す
    const byScreen = (core: string) => h.some((r) => {
      const added = splitAreaTokens(r.new_value).some((x) => areaTokenCore(x) === core) && !splitAreaTokens(r.old_value).some((x) => areaTokenCore(x) === core);
      if (!added) return false;
      if (/screen_edit/.test(r.source_message_id ?? "")) return true;
      if (r.source_message_id) return false;
      const at = Date.parse(r.created_at);
      return !msgs.some((m) => Date.parse(m.created_at) <= at && at - Date.parse(m.created_at) < 90_000);
    });
    const sure: string[] = [], check: string[] = [];
    for (const x of g) {
      if (x.grounded || byScreen(x.core)) continue;
      const notPlace = NOT_PLACE_RE.test(nf(x.token)) || inquiryShapesOf(x.token).includes("建物名（ブランド）");
      if (notPlace || (x.via === "inquiry_only" && (x.kind === "apply_form" || ADDRESS_RE.test(nf(x.token))))) sure.push(x.token);
      else if (x.via === "inquiry_only") check.push(x.token);
    }
    // その他の欄の物件の話・依頼だけの節
    const orClauses = String(pc.other_requests ?? "").split(/[・\n]/).map((s) => s.trim()).filter(Boolean);
    // その他の欄は**出口**（今ある値を消す）なので、入口の関所（inquiryShapesOf・依頼だけの節）ではなく、目で見て確かめた狭い形だけで外す。
    //   節（・／改行）の中を「。」「、」で分け、当たった小節だけ外す（「初期費用20万に抑えたい。仮押さえ希望」→「初期費用20万に抑えたい」）
    //   入口の形で消すと「出来るだけ抑えたい、エアコン完備」「防音の部屋またはタワマンの低層階があれば教えていただきたい」を誤って消した（目視で止めた）
    const orDrop: string[] = [];
    const orClausesNew = orClauses.map((c) => {
      const subs = c.split(/(?<=[。、,，])/).map((x) => x.trim()).filter(Boolean);
      const keep = subs.filter((x) => { const hit = EXIT_OR_RE.test(nf(x).replace(/[。、,]$/, "")); if (hit) orDrop.push(x.replace(/[。、,]$/, "")); return !hit; });
      return keep.join("").replace(/^[。、,\s]+|[。、,]$/g, "");
    }).filter(Boolean);
    if (!sure.length && !check.length && !orDrop.length) continue;
    const cur = pc.desired_area ?? "";
    const make = (drop: string[]) => {
      // 外す語が無い時は希望エリアも area_mode も触らない（区切りの書き換え・モードの付け直しをしない）
      if (!drop.length) return { newArea: cur, mode: (pc.area_mode ?? "auto") as "station" | "ward" | "auto" };
      const keep = splitAreaTokens(cur).filter((t) => !drop.includes(t));
      const newArea = keep.join("・");
      const mode = decideAreaMode(keep.map((t) => areaTokenCore(t)), (t) => isKnownStation(t));
      return { newArea, mode };
    };
    const reasonOf = (drop: string[]) => drop.map((t) => { const x = g.find((y) => y.token === t)!; return `${mask(t)}←${x.via === "inquiry_only" ? x.kind : "地名でない"}`; }).join("／");
    const line = (drop: string[], label: string) => {
      const { newArea, mode } = make(drop);
      return `| ${pc.id.slice(0, 8)} | ${conv?.status ?? pc.status ?? "?"} | ${mask(cur).slice(0, 60)} | ${drop.length ? mask(newArea).slice(0, 60) : "（変えない）"}${drop.length && mode !== "auto" && mode !== pc.area_mode ? `（area_mode ${pc.area_mode}→${mode}）` : ""} | ${label}: ${reasonOf(drop) || "—"}${orDrop.length ? ` ／その他から外す節: ${orDrop.map((c) => mask(c).slice(0, 40)).join("／")}` : ""} |`;
    };
    const sql = (drop: string[], orKeep: string[] | null, why: string) => {
      const { newArea, mode } = make(drop);
      const sets: string[] = [];
      if (drop.length) sets.push(`desired_area = ${sq(newArea)}`);
      if (drop.length && mode !== "auto" && mode !== pc.area_mode) sets.push(`area_mode = '${mode}'`);
      if (orKeep) sets.push(`other_requests = ${orKeep.length ? sq(orKeep.join("・")) : "NULL"}`);
      sets.push("condition_summary = NULL", "condition_summary_hash = NULL", "updated_at = now()");
      // 確かめ（2026-09-30）: その他の欄も今の値から作った値で上書きするので、その他の欄の md5 でも止める（生成から実行までに P4 等が足した節を消さない）
      const guard = `md5(coalesce(desired_area,'')) = '${md5(cur)}'${orKeep ? ` AND md5(coalesce(other_requests,'')) = '${md5(pc.other_requests ?? "")}'` : ""}`;
      const histRows = drop.length ? [`SELECT id, 'desired_area', desired_area, ${sq(newArea)}, 'cleanup:condition-source-gate 2026-09-30 ${why}' FROM property_customers WHERE id = '${pc.id}' AND ${guard}`] : [];
      if (orKeep) histRows.push(`SELECT id, 'other_requests', other_requests, ${orKeep.length ? sq(orKeep.join("・")) : "NULL"}, 'cleanup:condition-source-gate 2026-09-30 物件の話・依頼の節' FROM property_customers WHERE id = '${pc.id}' AND ${guard}`);
      return `-- ${pc.id.slice(0, 8)}: ${reasonOf(drop)}${orKeep ? ` ／その他から外す節: ${orDrop.map(mask).join("／")}` : ""}\nWITH h AS (\n  INSERT INTO property_condition_history (property_customer_id, changed_field, old_value, new_value, source_message_id)\n  ${histRows.join("\n  UNION ALL ")}\n  RETURNING property_customer_id\n)\nUPDATE property_customers SET ${sets.join(", ")}\nWHERE id IN (SELECT property_customer_id FROM h) AND ${guard};`;
    };
    const orKeep = orDrop.length ? orClausesNew : null;
    if (sure.length || orDrop.length) { rowsSure.push(line(sure, "確実")); sqlSure.push(sql(sure, orKeep, "物件の話・書類の中だけの語")); }
    if (check.length) { rowsCheck.push(line([...sure, ...check], "要確認")); sqlCheck.push(sql([...sure, ...check], orKeep, "持ち込み物件の地域だけにある語")); }
  }
  console.log("## 確実（地名でない語・書類の中だけ・住所・その他の欄の物件の話）");
  console.log("| お客様 | 会話の段階 | 今の希望エリア | 直した希望エリア | 外す語←根拠 |\n|---|---|---|---|---|");
  for (const r of rowsSure) console.log(r);
  console.log("\n## 要確認（お客様が持ち込んだ物件の地域だけにある語。興味の地域の可能性がある）");
  console.log("| お客様 | 会話の段階 | 今の希望エリア | 直した希望エリア | 外す語←根拠 |\n|---|---|---|---|---|");
  for (const r of rowsCheck) console.log(r);
  console.log("\n## SQL（確実）\n```sql"); for (const s of sqlSure) console.log(s + "\n"); console.log("```");
  console.log("\n## SQL（要確認・確実の分も含む）\n```sql"); for (const s of sqlCheck) console.log(s + "\n"); console.log("```");
}
main().catch((e) => { console.error(e); process.exit(1); });
