// scripts/verify-sent-image-read-yuma.ts — YUMA で AIX の物件送付・オススメを通し、送った画像の読み取りが「1枚1回・推論なし」か・
//   売上サポの行に結べた物は画像を読まないか・送るまでの時間・費用・保存された行を確かめる
//
// 2026-09-29 竹内「更に節約できないか」（送る側の画像の読み取りの無駄）:
//   画面（AixModal）と同じ形で動かす: 画像を property-images/aix/<会話>/<時刻>_<乱数>.jpeg に**再アップロード**（URL が売上サポの行と一致しない）→
//   /api/aix/action で生成（物件ピックアップ＝property_send / 物件オススメ＝property_recommendation）→ /api/send-line-message（origin=aix）で送る →
//   送った後（after）の読み取りを llm_usage_logs・image_details・sent_image_properties で見る。
//   場面: ① 売上サポの行の資料（行 ID は渡さない＝物件名・号室で結ぶ経路）② 売上サポの行に無い物件の資料（画像を読む経路）
//        ③ 物件オススメで①の資料（行 ID を渡す＝生成の時の先写しの経路）
//   ⚠ 会話は YUMA だけ（竹内さん本人のテスト用）。書いた行（image_details・sent_image_properties・sent_properties・messages）は最後に片付ける。
//   ローカル（LINE の鍵なし）は LOCAL_SIM_SKIP_LINE_PUSH=1 の開発サーバで送信を飛ばして after だけ動かす。本番に向ける時は LINE に本当に届く。
//
// 実行（ローカル）: VERIFY_BASE_URL=http://localhost:3217 VERIFY_INTERNAL_SECRET=<開発サーバの INTERNAL_API_SECRET> \
//         npx tsx --env-file=.env.local scripts/verify-sent-image-read-yuma.ts [--cases=1,2,3] [--keep]
// 実行（手元・送信の口なし）: VERIFY_BASE_URL=http://localhost:3217 npx tsx --env-file=.env.local scripts/verify-sent-image-read-yuma.ts --direct
// 実行（本番・デプロイ後）: VERIFY_BASE_URL=https://sumora-ai-ui.vercel.app VERIFY_INTERNAL_SECRET=<本番の INTERNAL_API_SECRET> … 同じ
import { supabase as sb } from "../app/lib/supabase";

const BASE = process.env.VERIFY_BASE_URL ?? "http://localhost:3217";
const SECRET = process.env.VERIFY_INTERNAL_SECRET ?? "";
const CONV = "dd34f5b0-03bf-4dfb-a598-a4d18ebb8df7"; // YUMA
const arg = (k: string, d = "") => (process.argv.find((a) => a.startsWith(`--${k}=`)) ?? `--${k}=${d}`).split("=").slice(1).join("=");
const CASES = arg("cases", "1,2,3").split(",").map(Number);
const KEEP = process.argv.includes("--keep");
// --direct: 送信の口（send-line-message・認証が要る）を通さず、送った後（after）と同じ2つ（recordSentImageProperty・ensureImageDetail）をこの場で並べて動かす。
//   手元に LINE の鍵も開発サーバの鍵も無い時の確かめ（LINE には届かない）。生成（/api/aix/action）は VERIFY_BASE_URL のまま
const DIRECT = process.argv.includes("--direct");
const IMAGE_ACTIONS = ["property_image_read", "property_image_detail", "property_image_transcribe", "property_text_detail"];
const OTHER_URL = arg("other", "");   // ② に使う資料の画像を指定する（既定は別の会話で最近送った資料）

async function reupload(srcUrl: string, idx: number): Promise<string> {
  const res = await fetch(srcUrl, { signal: AbortSignal.timeout(30_000) });
  if (!res.ok) throw new Error(`画像が取れない HTTP ${res.status}`);
  const buf = new Uint8Array(await res.arrayBuffer());
  const ext = /\.png(\?|$)/i.test(srcUrl) ? "png" : "jpeg";
  const path = `aix/${CONV}/${Date.now()}_${idx}_${Math.random().toString(36).slice(2, 7)}.${ext}`;
  const { error } = await sb.storage.from("property-images").upload(path, buf, { upsert: false, contentType: ext === "png" ? "image/png" : "image/jpeg" });
  if (error) throw new Error(`アップロード失敗: ${error.message}`);
  return sb.storage.from("property-images").getPublicUrl(path).data.publicUrl;
}

async function post(path: string, body: unknown, auth = false): Promise<{ status: number; json: Record<string, unknown>; ms: number }> {
  const t0 = Date.now();
  const res = await fetch(`${BASE}${path}`, {
    method: "POST",
    headers: { "Content-Type": "application/json", ...(auth ? { Authorization: `Bearer ${SECRET}` } : {}) },
    body: JSON.stringify(body), signal: AbortSignal.timeout(240_000),
  });
  const text = await res.text();
  let json: Record<string, unknown> = {};
  try { json = JSON.parse(text); } catch { json = { raw: text.slice(0, 300) }; }
  return { status: res.status, json, ms: Date.now() - t0 };
}

type Case = { no: number; label: string; action: "property_send" | "property_recommendation"; src: string; pickupId: number | null; passPickupId: boolean };

async function main() {
  if (!SECRET && !DIRECT) { console.error("VERIFY_INTERNAL_SECRET が無い（送信の口は認証が要る）"); process.exit(1); }
  const { data: conv } = await sb.from("conversations").select("line_user_id, account, customer_name").eq("id", CONV).single();
  const c = conv as { line_user_id: string; account: string | null; customer_name: string | null };
  // ①③: YUMA の売上サポの行（文字層あり・資料の画像あり）
  const { data: pk } = await sb.from("property_pickups").select("id, property_name, room_no, trim_image_url, pdf_text, image_lines, created_at")
    .eq("conversation_id", CONV).not("trim_image_url", "is", null).not("room_no", "is", null).order("created_at", { ascending: false }).limit(5);
  const pick = ((pk ?? []) as Array<{ id: number; property_name: string; room_no: string; trim_image_url: string; pdf_text: string | null }>)[0];
  // ②: 売上サポの行に無い物件の資料（別の会話で送った実物の資料を YUMA に再アップロード）
  const { data: other } = await sb.from("sent_image_properties").select("image_url, property_name, room_no")
    .neq("conversation_id", CONV).neq("source", "vision").like("image_url", "%property-images/aix/%").order("created_at", { ascending: false }).limit(1);
  const otherImg = OTHER_URL ? { image_url: OTHER_URL, property_name: "（指定の資料）", room_no: null as string | null } : ((other ?? []) as Array<{ image_url: string; property_name: string; room_no: string | null }>)[0];
  if (!pick || !otherImg) { console.error("材料が無い", !!pick, !!otherImg); process.exit(1); }
  console.log(`── 生成先: ${BASE}  会話: YUMA\n   ①③ 売上サポの行 #${pick.id} ${pick.property_name} ${pick.room_no}\n   ② 行に無い物件 ${otherImg.property_name} ${otherImg.room_no ?? ""}\n`);

  const cases: Case[] = [
    { no: 1, label: "① 物件ピックアップ・売上サポの資料（行 ID なし＝物件名・号室で結ぶ）", action: "property_send", src: pick.trim_image_url, pickupId: pick.id, passPickupId: false },
    { no: 2, label: "② 物件ピックアップ・売上サポに無い物件の資料（画像を読む）", action: "property_send", src: otherImg.image_url, pickupId: null, passPickupId: false },
    { no: 3, label: "③ 物件オススメ・売上サポの資料（行 ID あり＝生成の時に先写し）", action: "property_recommendation", src: pick.trim_image_url, pickupId: pick.id, passPickupId: true },
  ].filter((x) => CASES.includes(x.no)) as Case[];

  const written: string[] = [];
  const startIso = new Date().toISOString();
  for (const cs of cases) {
    console.log(`═══ ${cs.label} ═══`);
    const url = await reupload(cs.src, cs.no);
    written.push(url);
    const t0 = Date.now();
    const t0Iso = new Date().toISOString();
    const genBody: Record<string, unknown> = { action: cs.action, account: c.account ?? "sumora", conversation_id: CONV, customer_name: c.customer_name ?? "YUMA" };
    if (cs.action === "property_send") genBody.image_urls = [url]; else genBody.image_url = url;
    if (cs.passPickupId && cs.pickupId) genBody.pickup_ids = [cs.pickupId];
    const gen = await post("/api/aix/action", genBody);
    const text = String(gen.json.message_text ?? "");
    console.log(`  生成 HTTP ${gen.status}・${(gen.ms / 1000).toFixed(1)}秒${text ? "" : `  ${JSON.stringify(gen.json).slice(0, 200)}`}`);
    if (text) console.log(text.split("\n").slice(0, 6).map((l) => `    │ ${l}`).join("\n"));
    const send = DIRECT ? await (async () => {
      const t1 = Date.now();
      const [{ recordSentImageProperty }, { ensureImageDetail }] = await Promise.all([import("../app/lib/sent-image-record"), import("../app/lib/image-detail-store")]);
      await Promise.all([recordSentImageProperty({ imageUrl: url, conversationId: CONV, source: `aix:${cs.action}` }), ensureImageDetail(url, CONV)]);
      return { status: 200, json: {} as Record<string, unknown>, ms: Date.now() - t1 };
    })() : await post("/api/send-line-message", { line_user_id: c.line_user_id, account: c.account ?? "sumora", conversation_id: CONV, image_urls: [url], message: text || undefined, origin: "aix", aix_type: cs.action }, true);
    console.log(`  ${DIRECT ? "送った後の読み取り（直接）" : "送信"} HTTP ${send.status}・${(send.ms / 1000).toFixed(1)}秒（生成から ${((Date.now() - t0) / 1000).toFixed(1)}秒）${send.status === 200 ? "" : ` ${JSON.stringify(send.json).slice(0, 200)}`}`);
    // after の読み取りを待つ（画像の条件の読み取りは最大 60秒）
    type DetailRow = { kind: string; lines: string[]; model: string | null; read_at: string };
    type SipRow = { property_name: string; room_no: string | null; source: string | null; facts: unknown };
    let detail = null as DetailRow | null;
    let sip = null as SipRow | null;
    for (let i = 0; i < 30 && !(detail && sip); i++) {
      await new Promise((r) => setTimeout(r, 3000));
      if (!detail) { const { data } = await sb.from("image_details").select("kind, lines, model, read_at").eq("image_url", url).maybeSingle(); detail = data as DetailRow | null; }
      if (!sip) { const { data } = await sb.from("sent_image_properties").select("property_name, room_no, source, facts").eq("image_url", url).maybeSingle(); sip = data as SipRow | null; }
    }
    const doneSec = ((Date.now() - t0) / 1000).toFixed(1);
    await new Promise((r) => setTimeout(r, 4000));   // 費用の記録（非同期）を待つ
    const { data: logs } = await sb.from("llm_usage_logs").select("action, model, input_uncached, cache_read, output_tokens, duration_ms, max_tokens, env, created_at")
      .gte("created_at", t0Iso).in("action", [...IMAGE_ACTIONS, cs.action]).order("created_at", { ascending: true });
    console.log(`  送った後の記録（生成から ${doneSec}秒まで）:`);
    console.log(`    どの物件: ${sip ? `${sip.property_name} ${sip.room_no ?? ""}（source=${sip.source}・値 ${sip.facts ? "あり" : "なし"}）` : "（まだ無い）"}`);
    console.log(`    条件の行: ${detail ? `${detail.lines.length}行・出所 ${detail.model}` : "（まだ無い）"}`);
    for (const l of detail?.lines ?? []) console.log(`      ・${l}`);
    console.log(`    llm_usage_logs（この場面の時間の分・他の作業の行が混ざる事がある）:`);
    for (const r of (logs ?? []) as Array<Record<string, unknown>>) console.log(`      ${String(r.created_at).slice(11, 19)} ${r.action} ${r.model} 入力 ${r.input_uncached}+命中${r.cache_read} 出力 ${r.output_tokens} ${r.duration_ms}ms 上限 ${r.max_tokens ?? "-"} env=${r.env}`);
    console.log("");
  }

  // 片付け（書いた行を消す）
  if (!KEEP) {
    const del = async (table: string, col = "image_url") => { const { error, count } = await sb.from(table).delete({ count: "exact" }).in(col, written); return error ? `⚠ ${error.message}` : `${count ?? 0}行`; };
    const r1 = await del("image_details"); const r2 = await del("sent_image_properties");
    const { error: e3, count: c3 } = await sb.from("sent_properties").delete({ count: "exact" }).eq("conversation_id", CONV).in("image_url", written);
    const { error: e4, count: c4 } = await sb.from("messages").delete({ count: "exact" }).eq("conversation_id", CONV).in("image_url", written);
    console.log(`── 片付け: image_details ${r1}・sent_image_properties ${r2}・sent_properties ${e3 ? e3.message : `${c4 === null ? "" : ""}${c3 ?? 0}行`}・messages ${e4 ? e4.message : `${c4 ?? 0}行`}`);
    const { data: items } = await sb.from("aix_action_items").select("id, status, created_at").eq("conversation_id", CONV).gte("created_at", startIso);
    console.log(`── この間に YUMA で作られた AIX要対応: ${(items ?? []).length}件${(items ?? []).length ? `（${JSON.stringify(items).slice(0, 200)}）` : ""}`);
  }
}
main().catch((e) => { console.error(e); process.exit(1); });
