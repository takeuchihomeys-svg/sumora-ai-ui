// scripts/audit-property-capture.ts
// 実行: npx tsx --env-file=.env.local scripts/audit-property-capture.ts [--days=30]
//
// 2026-09-20 竹内「物件把握できていないのかな？ ブレインにもれがあるのか。
//   もし送った画像の部分読み取ってないなら deepseek の V4.1 で読み取るのはどうか？」
//
// ブレインが物件を知る経路がどこで落ちているかを**段階で**数える:
//   1. スタッフが物件を送った（本文に物件名がある／画像だけ）
//   2. 本文から物件名を取れるか（extractPropertyLabels＝行動台帳・AIX が使う）
//   3. sent_properties に記録されているか（ブレインの【送付済みの物件】ブロック）
//   4. ブレイン自身の current_property に入っているか
// あわせて画像の送り手と OCR 済みの割合を数える（お客様の画像は webhook で Vision 済み・
// スタッフの画像は送信側なので webhook を通らない）。
// 読み取りのみ。
import { createClient } from "@supabase/supabase-js";
import { extractPropertyLabels } from "../app/lib/action-ledger";
const sb = createClient(process.env.NEXT_PUBLIC_SUPABASE_URL ?? "", process.env.SUPABASE_SERVICE_ROLE_KEY ?? process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY ?? "");
const DAYS = Number((process.argv.find((a) => a.startsWith("--days=")) ?? "--days=30").split("=")[1]);

/** スタッフが物件を送った形（実送信の主流） */
const SENT_RE = [
  { label: "🌟物件名", re: /🌟\s*[^\s\n]{2,}/ },
  { label: "【物件名 N号室】", re: /【[^】]{2,40}[0-9０-９]{2,4}号室】/ },
  { label: "物件名 N号室（【】なし）", re: /[^\s\n、。]{2,30}\s*[0-9０-９]{2,4}号室/ },
];

async function main() {
  const since = new Date(Date.now() - DAYS * 86_400_000).toISOString();

  // ── ① 画像の送り手と OCR 済みの割合 ──
  const imgs: Array<{ sender: string; text: string | null }> = [];
  for (let page = 0; ; page++) {
    const { data } = await sb.from("messages").select("sender, text")
      .not("image_url", "is", null).gte("created_at", since)
      .order("id", { ascending: true }).range(page * 1000, page * 1000 + 999);
    const r = (data ?? []) as Array<{ sender: string; text: string | null }>;
    if (r.length === 0) break;
    imgs.push(...r);
    if (r.length < 1000) break;
  }
  const bare = (t: string | null) => /^\s*(?:\[(?:画像|動画|ファイル)\]\s*)+$/.test(t ?? "");
  const cust = imgs.filter((m) => m.sender === "customer");
  const staff = imgs.filter((m) => m.sender !== "customer");
  console.log(`=== 直近${DAYS}日の画像つきメッセージ ${imgs.length}件 ===`);
  console.log(`  お客様が送った  ${String(cust.length).padStart(4)}件 … 中身が文字になっている ${cust.filter((m) => !bare(m.text)).length}件 (${Math.round(100 * cust.filter((m) => !bare(m.text)).length / Math.max(cust.length, 1))}%)`);
  console.log(`  スタッフが送った ${String(staff.length).padStart(4)}件 … 中身が文字になっている ${staff.filter((m) => !bare(m.text)).length}件 (${Math.round(100 * staff.filter((m) => !bare(m.text)).length / Math.max(staff.length, 1))}%)`);
  console.log(`  ※ お客様の画像だけ line-webhook で Vision に通る（スタッフの画像は送信側なので通らない）\n`);

  // ── ② 物件送付の把握（会話ごと） ──
  const { data: convs } = await sb.from("conversations")
    .select("id, customer_name, status, updated_at, suggested_aix_meta")
    .gte("updated_at", since).order("updated_at", { ascending: false }).limit(400);
  const list = (convs ?? []) as Array<Record<string, unknown>>;

  let nSent = 0, nLabelOk = 0, nSpOk = 0, nCurOk = 0;
  const shapeHit: Record<string, number> = {};
  const noLabel: Array<{ name: string; sample: string }> = [];
  const noSp: Array<{ name: string; labels: string }> = [];

  for (const c of list) {
    const { data: msgs } = await sb.from("messages")
      .select("sender, text, image_url").eq("conversation_id", c.id as string)
      .order("created_at", { ascending: false }).limit(80);
    const ms = (msgs ?? []) as Array<{ sender: string; text: string | null; image_url: string | null }>;
    const staffTexts = ms.filter((m) => m.sender !== "customer").map((m) => m.text ?? "");
    const joined = staffTexts.join("\n");
    const hitShape = SENT_RE.find((s) => s.re.test(joined));
    if (!hitShape) continue;                       // 物件を送っていない会話は数えない
    nSent++;
    shapeHit[hitShape.label] = (shapeHit[hitShape.label] ?? 0) + 1;

    const labels = extractPropertyLabels(joined);
    if (labels.length > 0) nLabelOk++;
    else noLabel.push({ name: String(c.customer_name), sample: (joined.match(hitShape.re)?.[0] ?? "").slice(0, 40) });

    const { count } = await sb.from("sent_properties")
      .select("id", { count: "exact", head: true }).eq("conversation_id", c.id as string);
    if ((count ?? 0) > 0) nSpOk++;
    else noSp.push({ name: String(c.customer_name), labels: labels.slice(0, 2).join("・") });

    const meta = c.suggested_aix_meta as Record<string, unknown> | null;
    if (String(meta?.current_property ?? "").trim()) nCurOk++;
  }

  const pct = (n: number) => `${Math.round((100 * n) / Math.max(nSent, 1))}%`;
  console.log(`=== 物件を送っている会話 ${nSent}件 の把握の段階 ===`);
  console.log(`  本文の形: ${Object.entries(shapeHit).map(([k, v]) => `${k} ${v}件`).join(" / ")}`);
  console.log(`  ② 本文から物件名を取れた（extractPropertyLabels）  ${String(nLabelOk).padStart(3)}件 (${pct(nLabelOk)})`);
  console.log(`  ③ sent_properties に記録あり                      ${String(nSpOk).padStart(3)}件 (${pct(nSpOk)})`);
  console.log(`  ④ ブレインの current_property に入っている          ${String(nCurOk).padStart(3)}件 (${pct(nCurOk)})`);

  console.log(`\n--- ② で取れなかった会話（本文に物件名があるのに拾えない）${noLabel.length}件 ---`);
  for (const x of noLabel.slice(0, 12)) console.log(`  ${x.name.padEnd(14)} 本文の物件らしき所: ${JSON.stringify(x.sample)}`);
  console.log(`\n--- ③ sent_properties が空の会話 ${noSp.length}件（先頭12）---`);
  for (const x of noSp.slice(0, 12)) console.log(`  ${x.name.padEnd(14)} 本文からは取れている: ${x.labels || "（取れない）"}`);
}
main().catch((e) => { console.error(e); process.exit(1); });
