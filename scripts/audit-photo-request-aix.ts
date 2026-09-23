// 「室内の写真が欲しい」の検出（app/lib/room-photo-request.ts）を実送信365日に当てて、目で読む監査（読み取りのみ）
//
// 2026-09-23 竹内「室内の写真が欲しいといわれたら AIX の物件確認したの室内写真確認したのピッカーから送る形。
//   ちゃんとここはブレインで判断できるように」
//
// 【見る物】
//   A. 広い候補（写真・画像・動画・URL・内装・室内 の語を含むお客様の発言・[画像] 始まりを除く）を全部並べ、
//      検出が当たった／外れた を印にして**全部読む**（誤当たり・取りこぼしを目で確かめる）
//   B. 当たった通ごとに、その後72時間でスタッフが実際に何をしたか（AIX interior_photo／室内イメージURL・画像／撮影の宣言／
//      物件固有の理由／根拠なしの断定／その他）を分ける＝多数派の線
//   C. brain_decision_logs で、当たった通の直後の判断に interior_photo が出ていたか（届いていない穴の大きさ）
//
// 実行: npx tsx --env-file=.env.local scripts/audit-photo-request-aix.ts [DAYS=365] [SHOW=all|hit|miss]
import { createClient } from "@supabase/supabase-js";
import { isRoomPhotoRequest, roomPhotoRequestSentence } from "../app/lib/room-photo-request";

const sb = createClient(process.env.NEXT_PUBLIC_SUPABASE_URL ?? "", process.env.SUPABASE_SERVICE_ROLE_KEY ?? process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY ?? "");
type Msg = { id: string; conversation_id: string; sender: string; text: string | null; created_at: string; is_aix_generated: boolean | null; image_url: string | null };
type Aix = { conversation_id: string; aix_type: string | null; check_pattern: string | null; created_at: string };
type Dec = { conversation_id: string; suggested_action: string | null; suggested_check_pattern: string | null; analyzed_msg_ts: string | null; created_at: string; scene_evidence: Record<string, unknown> | null };

async function all<T>(q: (a: number, b: number) => PromiseLike<{ data: unknown; error: { message: string } | null }>): Promise<T[]> {
  const out: T[] = [];
  for (let p = 0; p < 200; p++) {
    const { data, error } = await q(p * 1000, p * 1000 + 999);
    if (error) { console.error(error.message); break; }
    const r = (data ?? []) as T[]; out.push(...r); if (r.length < 1000) break;
  }
  return out;
}
const BROAD_RE = /写真|画像|動画|イメージ|フォト|ＵＲＬ|URL|url|リンク|内装|室内|雰囲気/i;
const one = (s: string | null | undefined, n = 110) => String(s ?? "").replace(/\s+/g, " ").trim().slice(0, n);
const jst = (iso: string) => new Date(new Date(iso).getTime() + 9 * 3600_000).toISOString().slice(5, 16).replace("T", " ");

function classifyStaff(texts: string[], hasImage: boolean, aixInterior: boolean): string {
  const t = texts.join("\n");
  if (aixInterior) return "AIX室内写真";
  if (/室内イメージ|https?:\/\//.test(t)) return "URL/室内イメージ";
  if (hasImage) return "画像添付";
  if (/建築中|建設中|工事中|完成|竣工|退去(?:前|まで|後)|入居中|居住中|お住まい中|募集前|エリア外/.test(t) && /写真|画像|動画|撮影/.test(t)) return "理由付き";
  if (/(?:写真|画像|動画)[^\n。]{0,20}(?:ご用意|用意)(?:が|は)?(?:出来|でき)て(?:い|お)(?:ない|りません|いません|らず)|(?:写真|画像|動画)(?:は|が|も)(?:現在|今|まだ)?(?:ございません|ありません|無い|ない)(?!場合|時|際|なら)/.test(t)) return "⚠根拠なし断定";
  if (/撮影|撮って|撮り/.test(t)) return "撮影して送る";
  if (!texts.length && !hasImage) return "返信なし";
  return "その他";
}

async function main() {
  const days = Number(process.env.DAYS ?? 365);
  const show = (process.env.SHOW ?? "all").toLowerCase();
  const since = new Date(Date.now() - days * 86400_000).toISOString();
  const msgs = await all<Msg>((a, b) => sb.from("messages").select("id, conversation_id, sender, text, created_at, is_aix_generated, image_url").gte("created_at", since).order("created_at").range(a, b));
  const aix = await all<Aix>((a, b) => sb.from("aix_usage_logs").select("conversation_id, aix_type, check_pattern, created_at").gte("created_at", since).order("created_at").range(a, b));
  const decs = await all<Dec>((a, b) => sb.from("brain_decision_logs").select("conversation_id, suggested_action, suggested_check_pattern, analyzed_msg_ts, created_at, scene_evidence").gte("created_at", since).order("created_at").range(a, b));
  const byConv = new Map<string, Msg[]>();
  for (const m of msgs) { const arr = byConv.get(m.conversation_id) ?? []; arr.push(m); byConv.set(m.conversation_id, arr); }
  console.log(`直近${days}日: messages ${msgs.length}通（${byConv.size}会話）／aix_usage_logs ${aix.length}／brain_decision_logs ${decs.length}\n`);

  // A. 広い候補
  const cands = msgs.filter((m) => m.sender === "customer" && m.text && !/^\s*\[(?:画像|動画|スタンプ|ファイル)\]/.test(m.text) && BROAD_RE.test(m.text));
  const hits = cands.filter((m) => isRoomPhotoRequest(m.text));
  console.log(`A. 広い候補 ${cands.length}通（${new Set(cands.map((m) => m.conversation_id)).size}会話）→ 検出 ${hits.length}通（${new Set(hits.map((m) => m.conversation_id)).size}会話）\n`);
  const kinds = new Map<string, number>();
  const rows: string[] = [];
  let noReason = 0, interiorSuggested = 0, decided = 0;
  for (const m of cands) {
    const hit = isRoomPhotoRequest(m.text);
    if (show === "hit" && !hit) continue;
    if (show === "miss" && hit) continue;
    const conv = byConv.get(m.conversation_id) ?? [];
    const t0 = new Date(m.created_at).getTime();
    const sentBefore = conv.filter((x) => x.sender !== "customer" && new Date(x.created_at).getTime() < t0 && (/https?:\/\/|🌟|号室/.test(x.text ?? "") || !!x.image_url)).length;
    // 次のお客様発言までのスタッフの返し（最大72h）
    const after = conv.filter((x) => new Date(x.created_at).getTime() > t0 && new Date(x.created_at).getTime() - t0 < 72 * 3600_000);
    const staffTexts: string[] = []; let hasImg = false;
    for (const x of after) {
      if (x.sender === "customer") { if (staffTexts.length || hasImg) break; else continue; }
      if (x.image_url || /^\s*\[画像\]/.test(x.text ?? "")) hasImg = true;
      if (x.text && !/^\s*\[画像\]/.test(x.text)) staffTexts.push(x.text);
      if (staffTexts.length >= 3) break;
    }
    const aixInterior = aix.some((a) => a.conversation_id === m.conversation_id && a.check_pattern === "interior_photo" && new Date(a.created_at).getTime() > t0 && new Date(a.created_at).getTime() - t0 < 72 * 3600_000);
    const aixNext = aix.filter((a) => a.conversation_id === m.conversation_id && new Date(a.created_at).getTime() > t0 && new Date(a.created_at).getTime() - t0 < 72 * 3600_000).slice(0, 2).map((a) => `${a.aix_type}${a.check_pattern ? `(${a.check_pattern})` : ""}`).join(",");
    const dec = decs.filter((d) => d.conversation_id === m.conversation_id && new Date(d.created_at).getTime() >= t0 && new Date(d.created_at).getTime() - t0 < 24 * 3600_000).slice(0, 1)[0];
    const decText = dec ? `${dec.suggested_action ?? "null"}${dec.suggested_check_pattern ? `(${dec.suggested_check_pattern})` : ""}` : "-";
    const kind = classifyStaff(staffTexts, hasImg, aixInterior);
    if (hit) {
      kinds.set(kind, (kinds.get(kind) ?? 0) + 1);
      if (kind === "⚠根拠なし断定") noReason++;
      if (dec) { decided++; if (dec.suggested_check_pattern === "interior_photo") interiorSuggested++; }
    }
    rows.push([
      `${hit ? "●" : "・"} ${m.conversation_id.slice(0, 8)} ${jst(m.created_at)} 送付${sentBefore}`,
      `   客: ${one(m.text, 120)}`,
      hit ? `   当たった文: ${one(roomPhotoRequestSentence(m.text), 60)}` : "",
      `   店(${kind}): ${one(staffTexts[0], 100) || (hasImg ? "[画像]" : "（返信なし）")}`,
      `   AIX次: ${aixNext || "-"} ／ ブレイン: ${decText}`,
    ].filter(Boolean).join("\n"));
  }
  console.log(rows.join("\n\n"));
  console.log(`\n\nB. 検出 ${hits.length}通のスタッフの返し（72h以内・最初の返し）`);
  for (const [k, n] of [...kinds.entries()].sort((a, b) => b[1] - a[1])) console.log(`   ${k.padEnd(14)} ${String(n).padStart(4)} ／ ${((n / Math.max(1, hits.length)) * 100).toFixed(1)}%`);
  console.log(`   ⚠ 根拠なし断定: ${noReason}`);
  console.log(`\nC. 検出直後（24h）のブレインの判断あり ${decided} ／ うち interior_photo を提案 ${interiorSuggested}`);
  console.log(`   aix_usage_logs の interior_photo 押下（期間内）: ${aix.filter((a) => a.check_pattern === "interior_photo").length}`);
}
main().catch((e) => { console.error(e); process.exit(1); });
