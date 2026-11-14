// scripts/audit-customer-images.ts — 読むだけ・LLM なし（2026-11-15 作業員H・竹内さん「お客さんが送ってきたのが物件や見積書と分かれば…」）
//   お客様の画像（直近 N 日・[画像] 始まり）を、見出し・前後の通（こちらの前の通・お客様の後の一言）と一緒に読む。
//   --label: 見出しの網（IMAGE_LABEL_1115）を今の保存の本文に当て直し、種類が変わる物を全部出す（見積書・物件の画像に誤って当たっていないかを目で読む）
//   --link : 結び付け（customer-image-link・CUSTOMER_IMAGE_LINK）を、その会話のこちらが送った物件（sent_properties・sent_image_properties）と照らして並べる
//   使い方: npx tsx --env-file=<.env.local> scripts/audit-customer-images.ts [--days=14] [--out=<json>] [--label] [--link]
import { createClient } from "@supabase/supabase-js";
import { writeFileSync } from "node:fs";
import { isTestConversation } from "../app/lib/test-conversations";

const arg = (k: string, d: string) => process.argv.find((a) => a.startsWith(`--${k}=`))?.slice(k.length + 3) ?? d;
const DAYS = Number(arg("days", "14")), OUT = arg("out", "");
const sb = createClient(process.env.NEXT_PUBLIC_SUPABASE_URL ?? "", process.env.SUPABASE_SERVICE_ROLE_KEY ?? "");
const mask = (s: string) => s.replace(/0\d{1,4}-?\d{1,4}-?\d{3,4}/g, "＜番号＞").replace(/[\w.+-]+@[\w-]+\.[\w.]+/g, "＜メール＞");
type M = { sender: string; at: string; text: string; aix: boolean };
export type AuditImage = { id: string; conversation_id: string; created_at: string; image_type: string | null; text: string; before: M[]; after: M[] };

async function main() {
  const since = new Date(Date.now() - DAYS * 86_400_000).toISOString();
  const rows: Array<{ id: string; conversation_id: string; created_at: string; image_type: string | null; text: string }> = [];
  for (let i = 0; ; i += 1000) {
    const { data, error } = await sb.from("messages").select("id, conversation_id, created_at, image_type, text").eq("sender", "customer").gte("created_at", since).like("text", "[画像]%").order("created_at").range(i, i + 999);
    if (error) throw new Error(error.message);
    rows.push(...((data ?? []) as typeof rows)); if ((data ?? []).length < 1000) break;
  }
  const imgs = rows.filter((r) => !isTestConversation(r.conversation_id));
  if (process.argv.includes("--label")) {
    process.env.IMAGE_LABEL_1115 = "on";
    const { classifyCustomerImage, savedImageKind, stripImageLabel, maskEstimateAddressee } = await import("../app/lib/image-label");
    let changed = 0, masked = 0, withHead = 0;
    for (const r of imgs) {
      const before = savedImageKind(r.text);
      if (!before || !r.text.includes("\n")) continue; // 種類だけの書類・見出しの無い昔の行・書き起こしを残していない行
      withHead++;
      const body = stripImageLabel(r.text.replace(/^\s*\[画像\]\s*/, ""));
      const after = classifyCustomerImage(r.image_type, body);
      if (after !== before) { changed++; console.log(`変わる ${r.conversation_id.slice(0, 8)} ${r.created_at.slice(0, 16)} ${r.image_type} ${before} → ${after}｜${mask(body).replace(/\s+/g, " ").slice(0, 50)}`); }
      if (after === "estimate" && maskEstimateAddressee(body) !== body) masked++;
    }
    console.log(`見出しのある画像 ${withHead}・種類が変わる ${changed}・見積書で宛名を伏せる ${masked}`);
    return;
  }
  const out: AuditImage[] = [];
  for (const r of imgs) {
    const t = Date.parse(r.created_at);
    const { data: b } = await sb.from("messages").select("sender, created_at, text, is_aix_generated").eq("conversation_id", r.conversation_id).lt("created_at", r.created_at).order("created_at", { ascending: false }).limit(6);
    const { data: a } = await sb.from("messages").select("sender, created_at, text, is_aix_generated").eq("conversation_id", r.conversation_id).gt("created_at", r.created_at).lte("created_at", new Date(t + 20 * 60_000).toISOString()).order("created_at").limit(6);
    const fm = (m: Record<string, unknown>): M => ({ sender: String(m.sender), at: String(m.created_at), text: mask(String(m.text ?? "")).slice(0, 400), aix: !!m.is_aix_generated });
    out.push({ ...r, text: mask(r.text), before: ((b ?? []) as Array<Record<string, unknown>>).reverse().map(fm), after: ((a ?? []) as Array<Record<string, unknown>>).map(fm) });
  }
  if (OUT) writeFileSync(OUT, JSON.stringify(out, null, 1));
  if (process.argv.includes("--link")) {
    const { linkCustomerImage, buildImageLinkBlock } = await import("../app/lib/customer-image-link");
    const tally = new Map<string, Map<string, number>>();
    const sentOf = new Map<string, Array<{ name: string; room: string | null; sentAt: string | null; rent: number | null }>>();
    for (const r of out) {
      if (!sentOf.has(r.conversation_id)) {
        const [{ data: sp }, { data: sip }] = await Promise.all([
          sb.from("sent_properties").select("property_name, room_no, sent_at, rent").eq("conversation_id", r.conversation_id).limit(300),
          sb.from("sent_image_properties").select("property_name, room_no, created_at").eq("conversation_id", r.conversation_id).limit(300),
        ]);
        sentOf.set(r.conversation_id, [
          ...((sp ?? []) as Array<{ property_name: string | null; room_no: string | null; sent_at: string | null; rent: number | null }>).map((x) => ({ name: x.property_name ?? "", room: x.room_no, sentAt: x.sent_at, rent: x.rent })),
          ...((sip ?? []) as Array<{ property_name: string | null; room_no: string | null; created_at: string }>).map((x) => ({ name: x.property_name ?? "", room: x.room_no, sentAt: x.created_at, rent: null })),
        ].filter((s) => s.name));
      }
      const words = r.after.filter((m) => m.sender === "customer" && !/^\[画像\]/.test(m.text)).map((m) => m.text).join(" ");
      const l = linkCustomerImage({ text: r.text, imageType: r.image_type, at: r.created_at, customerWords: words, sent: sentOf.get(r.conversation_id) ?? [] });
      // スタッフの最初の一手（24時間以内・書き手・AIX の種類）＝型ごとに竹内さんの実送信を数える
      const { data: fs } = await sb.from("messages").select("created_at, staff_writer, is_aix_generated, text").eq("conversation_id", r.conversation_id).neq("sender", "customer").gt("created_at", r.created_at).lte("created_at", new Date(Date.parse(r.created_at) + 86_400_000).toISOString()).order("created_at").limit(1);
      const f = ((fs ?? []) as Array<{ created_at: string; staff_writer: string | null; is_aix_generated: boolean; text: string | null }>)[0];
      let move = "なし";
      if (f) {
        if (f.is_aix_generated) {
          const { data: ax } = await sb.from("aix_usage_logs").select("aix_type, check_pattern, created_at").eq("conversation_id", r.conversation_id).gte("created_at", new Date(Date.parse(f.created_at) - 10 * 60_000).toISOString()).lte("created_at", new Date(Date.parse(f.created_at) + 2 * 60_000).toISOString()).limit(1);
          const a = ((ax ?? []) as Array<{ aix_type: string; check_pattern: string | null }>)[0];
          move = `AIX:${a?.aix_type ?? "?"}${a?.check_pattern ? `/${a.check_pattern}` : ""}`;
        } else move = /確認(?:させて|致し|いたし)|ご連絡させて|お送りさせて頂きます/.test(f.text ?? "") ? "返信（約束）" : "返信";
      }
      const key = `${l.kind}|${l.kind.startsWith("property") ? l.relation : "-"}|${l.asks.length ? l.asks.join("+") : l.words ? "words" : "none"}`;
      const row = tally.get(key) ?? new Map<string, number>(); const mk = `${f?.staff_writer ?? "?"}:${move}`; row.set(mk, (row.get(mk) ?? 0) + 1); tally.set(key, row);
      console.log(`\n${r.conversation_id.slice(0, 8)} ${r.created_at.slice(5, 16)} 送った物件 ${(sentOf.get(r.conversation_id) ?? []).length}件 → スタッフの最初の一手 ${f?.staff_writer ?? "?"}:${move}\n${buildImageLinkBlock([l]).split("\n")[1]}`);
    }
    console.log("\n=== 型ごとのスタッフの最初の一手（書き手:一手 回数）===");
    for (const [k, m] of [...tally].sort()) console.log(`${k}\t${[...m].map(([a, b]) => `${a} ${b}`).join("・")}`);
  }
  console.log(`お客様の画像 ${out.length} 枚`);
}
main().catch((e) => { console.error(e); process.exitCode = 1; });
