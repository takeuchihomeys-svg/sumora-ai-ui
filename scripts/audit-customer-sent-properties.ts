// scripts/audit-customer-sent-properties.ts — お客様が送った画像・物件 URL の仕分けと、物件検索ブレインへの転送の前後（読むだけ・LLM 0回・DB は書かない）
// 2026-10-14 竹内さん「お客さんから送られてきた物件の画像や物件 URL はスコアリングの基準をつくるのに有効…お客さん毎の AIX ツールに転送」
//
// 実行: npx tsx --env-file=.env.local scripts/audit-customer-sent-properties.ts [--days=180] [--sample=5]
//   1. お客様の画像が受け取った時点でどう仕分けられているか（見出し・書類の名前・読み取り前）
//   2. 物件の流れへの線（customerImagePropertyGate）: 通る／個人情報で落とす／物件以外／読み取り前
//      ・見出しが物件なのに個人情報の指紋が当たる行（線が無ければ物件の流れに入っていた数）
//      ・【種類不明】のうち個人情報の語が当たる行（会話本文に書き起こしが残っている数）
//      ・お客様の画像の URL が DeepSeek の読み取りの表（sent_image_properties・image_details）にある数（0 であること）
//   3. 物件の値が取れた画像・URL と、物件顧客に紐づいた会話（🌟 に渡せる）の数・見本
import { createClient } from "@supabase/supabase-js";
import { imageTextForDeepSeekRead, customerImagePropertyGate, factsFromPropertyText, collectCustomerSentProperties, customerSentPropertyBlock, propertyUrlsIn, factsFromShareText, factsLabel } from "@/app/lib/customer-sent-property";
import { savedImageKind, stripImageLabel, IMAGE_KIND_LABEL } from "@/app/lib/image-label";
import { savedPersonalDocumentLabel } from "@/app/lib/personal-document-guard";
import { ID_DOCUMENT_TEXT, isIdDocument, imageTextForSave } from "@/app/lib/id-document-guard";
import { personalDocumentName } from "@/app/lib/personal-document-guard";

const sb = createClient(process.env.NEXT_PUBLIC_SUPABASE_URL ?? "", process.env.SUPABASE_SERVICE_ROLE_KEY ?? process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY ?? "");
const arg = (k: string, d = "") => (process.argv.find((a) => a.startsWith(`--${k}=`)) ?? `--${k}=${d}`).split("=").slice(1).join("=");
const days = Number(arg("days", "180"));
const sample = Number(arg("sample", "5"));
const since = new Date(Date.now() - days * 86400_000).toISOString();
type Row = { id: string; conversation_id: string; created_at: string; text: string | null; image_type: string | null; image_url: string | null; sender: string };
const PERSONAL_WORD_RE = /生年月日|保険者番号|被保険者|記号\s*番号|口座番号|マイナンバー|個人番号|本籍|勤務先|年収|旅券番号|在留|免許証番号|印鑑登録|続柄/;

async function pageAll<T>(build: (a: number, b: number) => PromiseLike<{ data: T[] | null; error: { message: string } | null }>): Promise<T[]> {
  const out: T[] = [];
  for (let from = 0; ; from += 1000) {
    const { data, error } = await build(from, from + 999);
    if (error) throw new Error(error.message);
    out.push(...(data ?? []));
    if (!data || data.length < 1000) break;
  }
  return out;
}
const inc = (m: Map<string, number>, k: string) => m.set(k, (m.get(k) ?? 0) + 1);
const clip = (s: string, n = 90) => s.replace(/\s+/g, " ").slice(0, n);

async function main() {
  const imgs = await pageAll<Row>((a, b) => sb.from("messages").select("id, conversation_id, created_at, text, image_type, image_url, sender")
    .eq("sender", "customer").like("text", "[画像]%").gte("created_at", since).order("created_at").range(a, b));
  const urlRows = await pageAll<Row>((a, b) => sb.from("messages").select("id, conversation_id, created_at, text, image_type, image_url, sender")
    .eq("sender", "customer").like("text", "%http%").gte("created_at", since).order("created_at").range(a, b));
  console.log(`=== お客様の画像 ${imgs.length}件・URL つき発言 ${urlRows.length}件（${days}日・${since.slice(0, 10)}〜） ===\n`);

  // 1. 受け取った時点の仕分け
  const recv = new Map<string, number>();
  for (const r of imgs) {
    const t = (r.text ?? "").trim();
    const k = t === "[画像]" ? "読み取り前・失敗（[画像]）" : t === ID_DOCUMENT_TEXT ? "本人確認書類（種類だけ）" : savedPersonalDocumentLabel(t) ? `書類（種類だけ）:${savedPersonalDocumentLabel(t)}` : savedImageKind(t) ? `見出し:${IMAGE_KIND_LABEL[savedImageKind(t)!]}` : `見出しなし（昔の行・type=${r.image_type ?? "NULL"}）`;
    inc(recv, k);
  }
  console.log("1. 受け取った時点の仕分け（messages.text の形）");
  for (const [k, n] of [...recv].sort((a, b) => b[1] - a[1])) console.log(`   ${String(n).padStart(5)}  ${k}`);

  // 2. 物件の流れへの線
  const gate = new Map<string, number>();
  const headerPropertyButPersonal: Row[] = [];
  const unknownPersonalLike: Row[] = [];
  const passed: Row[] = [];
  for (const r of imgs) {
    const g = customerImagePropertyGate(r.text, r.image_type);
    inc(gate, g.ok ? `通る（${IMAGE_KIND_LABEL[g.kind]}）` : `落とす:${g.reason}`);
    if (g.ok) passed.push(r);
    const t = (r.text ?? "").trim();
    const k = savedImageKind(t);
    const body = t.replace(/^\[画像\]\s*/, "");
    const personalHit = isIdDocument(null, body) || !!personalDocumentName(null, body) || PERSONAL_WORD_RE.test(body.normalize("NFKC"));
    if (k && ["property_material", "property_screen", "property_ad", "property_photo"].includes(k) && personalHit) headerPropertyButPersonal.push(r);
    if (k === "unknown" && personalHit) unknownPersonalLike.push(r);
  }
  console.log("\n2. 物件の流れへの線（customerImagePropertyGate）");
  for (const [k, n] of [...gate].sort((a, b) => b[1] - a[1])) console.log(`   ${String(n).padStart(5)}  ${k}`);
  console.log(`   見出しは物件なのに個人情報の指紋が当たる行（線で落とす）: ${headerPropertyButPersonal.length}`);
  for (const r of headerPropertyButPersonal.slice(0, sample)) console.log(`     - ${r.id.slice(0, 8)} ${r.created_at.slice(0, 10)} 「${clip(r.text ?? "", 60)}」`);
  console.log(`   【種類不明】で個人情報の語が当たる行（会話本文に書き起こしが残っている）: ${unknownPersonalLike.length}`);
  for (const r of unknownPersonalLike.slice(0, sample)) console.log(`     - ${r.id.slice(0, 8)} ${r.created_at.slice(0, 10)} 語=${(r.text ?? "").normalize("NFKC").match(PERSONAL_WORD_RE)?.[0] ?? "指紋"}`);
  // 受け取りの線（IMAGE_PERSONAL_HINT_DROP）: 今の書き方で保存し直すと「個人情報の載った画像」（書き起こしなし）になる行
  const becomePersonal = new Map<string, number>();
  for (const r of imgs) {
    const t = (r.text ?? "").trim();
    if (t === "[画像]" || t === ID_DOCUMENT_TEXT || savedPersonalDocumentLabel(t)) continue;
    const prevKind = savedImageKind(t);
    const body = stripImageLabel(t.replace(/^\[画像\]\s*/, ""));
    const after = imageTextForSave(r.image_type, body);
    if (savedImageKind(after) === "personal_unknown") inc(becomePersonal, prevKind ? IMAGE_KIND_LABEL[prevKind] : `見出しなし type=${r.image_type ?? "NULL"}`);
  }
  console.log(`   受け取りの線で書き起こしを捨てるようになる行（今の書き方で保存し直した時）: ${[...becomePersonal.values()].reduce((a, b) => a + b, 0)}（${[...becomePersonal].map(([k, n]) => `${k}:${n}`).join(" ") || "なし"}）`);
  // 毎週の好みの読み（pref_read_customer・DeepSeek）に渡る画像の行: 書き起こしごと（旧）／線を通した形（新）
  let prefOld = 0, prefNew = 0, prefOldPersonal = 0, prefNewPersonal = 0;
  for (const r of imgs) {
    const t = (r.text ?? "").trim();
    const body = (s: string) => s.replace(/^\[画像\]\s*(?:【[^】\n]+】)?/, "").trim();
    const hasPersonal = (s: string) => isIdDocument(null, body(s)) || !!personalDocumentName(null, body(s)) || PERSONAL_WORD_RE.test(body(s).normalize("NFKC"));
    const after = imageTextForDeepSeekRead(t, r.image_type);
    const transcriptOld = body(t).length > 0 && t !== ID_DOCUMENT_TEXT && !savedPersonalDocumentLabel(t);
    if (transcriptOld) prefOld++;
    if (transcriptOld && hasPersonal(t)) prefOldPersonal++;
    if (after.includes("\n")) prefNew++;
    if (hasPersonal(after) && after !== t) prefNewPersonal++;
  }
  console.log(`   毎週の好みの読みに渡る画像の書き起こし: 旧 ${prefOld}行（個人情報の語・指紋つき ${prefOldPersonal}）→ 新 全文 ${prefNew}行・個人情報 ${prefNewPersonal}（物件の画像は値だけの1行）`);
  const passedPersonal = passed.filter((r) => { const b = (r.text ?? "").replace(/^\[画像\]\s*/, ""); return isIdDocument(r.image_type, b) || !!personalDocumentName(r.image_type, b) || PERSONAL_WORD_RE.test(b.normalize("NFKC")); });
  console.log(`   ★ 線を通った画像のうち個人情報の指紋・語が当たる物: ${passedPersonal.length}（0 であること）`);

  // お客様の画像が DeepSeek の読み取りの表にあるか
  const urls = imgs.map((r) => r.image_url).filter((u): u is string => !!u);
  let inSip = 0, inDet = 0;
  const sipKinds = new Map<string, number>();
  for (let i = 0; i < urls.length; i += 150) {
    const chunk = urls.slice(i, i + 150);
    const [{ data: s1 }, { data: s2 }] = await Promise.all([
      sb.from("sent_image_properties").select("image_url").in("image_url", chunk),
      sb.from("image_details").select("image_url").in("image_url", chunk),
    ]);
    const set1 = new Set(((s1 ?? []) as Array<{ image_url: string }>).map((x) => x.image_url));
    inSip += set1.size; inDet += (s2 ?? []).length;
    for (const r of imgs) if (r.image_url && set1.has(r.image_url)) inc(sipKinds, savedImageKind(r.text) ?? r.image_type ?? "?");
  }
  console.log(`   お客様の画像の URL が DeepSeek の読み取りの表にある数: sent_image_properties ${inSip} ／ image_details ${inDet}${sipKinds.size ? `（${[...sipKinds].map(([k, n]) => `${k}:${n}`).join(" ")}）` : ""}`);

  // 3. 物件の値・転送できる会話
  let withFacts = 0;
  const factCount = new Map<string, number>();
  for (const r of passed) {
    const g = customerImagePropertyGate(r.text, r.image_type);
    if (!g.ok) continue;
    const f = factsFromPropertyText(g.body);
    const any = f.name || f.rentYen != null || f.madori || f.areaSqm != null || f.station;
    if (any) withFacts++;
    for (const [k, v] of Object.entries(f)) if (v != null) inc(factCount, k);
  }
  console.log(`\n3. 物件の値が取れた画像: ${withFacts} / 通った ${passed.length}（値ごと: ${[...factCount].map(([k, n]) => `${k} ${n}`).join("・")}）`);
  let urlProp = 0, urlFacts = 0;
  for (const r of urlRows) {
    const us = propertyUrlsIn(r.text);
    if (!us.length) continue;
    urlProp++;
    const f = factsFromShareText(r.text ?? "");
    if (f.name || f.rentYen != null || f.madori || f.station) urlFacts++;
  }
  console.log(`   物件の URL を含む発言: ${urlProp}（共有文から値が取れた ${urlFacts}・SUUMO のページは転送の時に最大2件読む）`);

  // 会話ごと
  const convIds = [...new Set([...passed, ...urlRows.filter((r) => propertyUrlsIn(r.text).length)].map((r) => r.conversation_id))];
  const linked = new Map<string, string>();
  for (let i = 0; i < convIds.length; i += 200) {
    const { data } = await sb.from("conversations").select("id, property_customer_id").in("id", convIds.slice(i, i + 200));
    for (const c of (data ?? []) as Array<{ id: string; property_customer_id: string | null }>) if (c.property_customer_id) linked.set(c.id, c.property_customer_id);
  }
  console.log(`   物件を送ってきた会話 ${convIds.length}・うち物件顧客に紐づく（🌟 に渡せる） ${linked.size}`);

  // 見本（紐づいた会話の材料のブロック）
  let shown = 0, totalItems = 0, convWithItems = 0;
  for (const cid of [...linked.keys()]) {
    const { data } = await sb.from("messages").select("sender, text, image_type, created_at").eq("conversation_id", cid).gte("created_at", since).order("created_at").limit(600);
    const r = collectCustomerSentProperties((data ?? []) as Array<{ sender: string; text: string; image_type: string | null; created_at: string }>);
    if (r.items.length) { convWithItems++; totalItems += r.items.length; }
    if (r.items.length && shown < sample) {
      shown++;
      console.log(`\n   ── 見本 ${cid.slice(0, 8)}（画像 ${r.stats.images}・通る ${r.stats.propertyImages}・個人情報で落とす ${r.stats.personal}・URL ${r.stats.urls}）`);
      console.log((customerSentPropertyBlock(r.items) ?? "").split("\n").map((l) => "     " + l).join("\n"));
    }
  }
  console.log(`\n   転送される物件（材料のブロックに入る・会話ごと最大6件）: ${totalItems}件 / ${convWithItems}会話（紐づいた ${linked.size} 会話のうち）`);
  void factsLabel;
}
main().catch((e) => { console.error(e); process.exit(1); });
