// 売上サポ「📤 AIXで送る」→ sent_properties の記録（経路 pickup・共有と送付の区別・拡張のバッジ API・ブレインの注入文）を
// YUMA（竹内さんのテスト会話）の範囲だけで確かめる。LINE には送らない・LLM も呼ばない（画像の読み取りは既読の経路を通る）。
// 最後にテスト行を全部片付け、始める前の控えと比べて差が0であることを出す。
// 実行: npx tsx --env-file=.env.local scripts/test-pickup-sent-yuma.ts
import { NextRequest } from "next/server";
import { supabase } from "@/app/lib/supabase";
import { POST as pickupSendPOST } from "@/app/api/property-pickups/send/route";
import { GET as dupGET } from "@/app/api/check-property-duplicate/route";
import { recordSentImageProperty } from "@/app/lib/sent-image-record";
import { buildSentProps, buildSentPropsText } from "@/app/lib/sent-props-text";
import { jstMD } from "@/app/lib/jst-date";

// ルートはこのプロセスの中で直接呼ぶので、.env.local に内部の鍵が無ければこの実行だけの使い捨ての値を置く（外には出ない）
if (!process.env.INTERNAL_API_SECRET) process.env.INTERNAL_API_SECRET = `local-test-${Math.random().toString(36).slice(2)}`;
const YUMA = "dd34f5b0-03bf-4dfb-a598-a4d18ebb8df7";
const TS = Date.now();
const BATCH = `yuma-test-${TS}`;
const URL_PREFIX = `https://example.invalid/yuma-test-${TS}`;
const img = (s: string) => `${URL_PREFIX}-${s}.jpg`;

let pass = 0, fail = 0;
function t(name: string, ok: boolean, detail?: unknown) {
  if (ok) { pass++; console.log(`  ✓ ${name}`); }
  else { fail++; console.log(`  ✗ ${name}${detail !== undefined ? `\n      ${JSON.stringify(detail).slice(0, 800)}` : ""}`); }
}

async function markSent(batch: string, ids: number[], imageUrls: string[]) {
  const req = new NextRequest("http://localhost/api/property-pickups/send", {
    method: "POST",
    headers: { "Content-Type": "application/json", Authorization: `Bearer ${process.env.INTERNAL_API_SECRET ?? ""}` },
    body: JSON.stringify({ batch_id: batch, item_ids: ids, action: "mark_sent", sent_by: "yuma-test", image_urls: imageUrls }),
  });
  const res = await pickupSendPOST(req);
  return res.json() as Promise<{ ok: boolean; marked?: number; recorded?: { inserted: number; updated: number; images: number; skipped: string[]; error?: string } | null }>;
}

async function snapshot() {
  const [sp, sip] = await Promise.all([
    supabase.from("sent_properties").select("id").eq("conversation_id", YUMA),
    supabase.from("sent_image_properties").select("image_url").eq("conversation_id", YUMA),
  ]);
  return { sp: new Set(((sp.data ?? []) as Array<{ id: string }>).map((r) => r.id)), sip: new Set(((sip.data ?? []) as Array<{ image_url: string }>).map((r) => r.image_url)) };
}

async function insertPickup(batch: string, rank: number, name: string, room: string | null, pageImg: string, pcid: string | null, ad: number | null) {
  const { data, error } = await supabase.from("property_pickups").insert({
    batch_id: batch, rank, property_name: name, room_no: room, summary_text: `${name}（YUMA テスト）`, page_image_url: pageImg,
    conversation_id: YUMA, property_customer_id: pcid, status: "pending", ad_yen: ad,
  }).select("id").single();
  if (error) throw new Error(`pickup insert: ${error.message}`);
  return (data as { id: number }).id;
}

async function main() {
  const { data: conv } = await supabase.from("conversations").select("property_customer_id").eq("id", YUMA).maybeSingle();
  const pcid = (conv as { property_customer_id: string | null } | null)?.property_customer_id ?? null;
  let lastSentBefore: string | null = null;
  if (pcid) {
    const { data: pc } = await supabase.from("property_customers").select("last_property_sent_at").eq("id", pcid).maybeSingle();
    lastSentBefore = (pc as { last_property_sent_at: string | null } | null)?.last_property_sent_at ?? null;
  }
  const before = await snapshot();
  console.log(`0) 控え: YUMA sent_properties ${before.sp.size}行 / sent_image_properties ${before.sip.size}行 / 物件顧客の紐付け=${pcid ? "あり" : "なし"}`);

  // ブレインの注入文（変更前の形を控える: 1本で20件・印は sent_image_properties のオススメだけ）
  const oldText = async () => {
    const q = supabase.from("sent_properties").select("property_name, room_no, sent_at, rent")
      .or(pcid ? `property_customer_id.eq.${pcid},conversation_id.eq.${YUMA}` : `conversation_id.eq.${YUMA}`)
      .order("sent_at", { ascending: false }).limit(20);
    const { data } = await q;
    const rows = (data ?? []) as Array<{ property_name: string; room_no: string; sent_at: string; rent: number | null }>;
    return `【すでに送付済みの物件（${rows.length}件）】\n` + rows.map((p) => `- ${p.property_name} ${p.room_no}（${jstMD(p.sent_at)}送付${p.rent != null ? `・家賃${p.rent.toLocaleString()}円` : ""}）`).join("\n");
  };
  const newText = async () => {
    const linkOr = pcid ? `property_customer_id.eq.${pcid},conversation_id.eq.${YUMA}` : `conversation_id.eq.${YUMA}`;
    const [c, s, i] = await Promise.all([
      supabase.from("sent_properties").select("property_name, room_no, sent_at, rent, recruitment_status, applicant_rank, customer_reaction, source, channel, delivery, pickup_id")
        .or(linkOr).or("source.is.null,source.neq.line_group").order("sent_at", { ascending: false }).limit(20),
      supabase.from("sent_properties").select("property_name, room_no, sent_at, rent").or(linkOr).eq("source", "line_group").order("sent_at", { ascending: false }).limit(8),
      supabase.from("sent_image_properties").select("property_name, room_no, created_at, source, channel").eq("conversation_id", YUMA).order("created_at", { ascending: false }).limit(20),
    ]);
    if (c.error) console.log("  ⚠ 送付の引き方でエラー:", c.error.message);
    return buildSentPropsText(buildSentProps({ customerRows: c.data ?? [], imageRows: i.data ?? [], sharedRows: s.data ?? [] }));
  };

  const testSpIds: string[] = [];
  try {
    // 1) テスト行
    const id1 = await insertPickup(BATCH, 1, "YUMAテスト荘", "101", img("page-1"), pcid, 50000);
    const id2 = await insertPickup(BATCH, 2, "YUMAテスト第二ハイツ", "0203", img("page-2"), pcid, null);
    const { data: lg, error: lgErr } = await supabase.from("sent_properties").insert({
      conversation_id: YUMA, property_customer_id: pcid, property_name: "YUMAテスト荘", room_no: "", source: "line_group", delivery: "shared", channel: "extension_group",
      sent_at: new Date(Date.now() - 60 * 60 * 1000).toISOString(),
    }).select("id").single();
    if (lgErr) throw new Error(`line_group insert: ${lgErr.message}`);
    testSpIds.push((lg as { id: string }).id);
    console.log(`1) テスト行: pickup #${id1} #${id2}・line_group 1行`);

    // 2) mark_sent（画像2件）
    const r2 = await markSent(BATCH, [id1, id2], [img("sent-1"), img("sent-2")]);
    console.log("2) mark_sent:", JSON.stringify(r2));
    const { data: rows2 } = await supabase.from("sent_properties").select("id, property_name, room_no, image_url, source, delivery, channel, pickup_id, ad_yen, property_url").in("pickup_id", [id1, id2]).order("pickup_id");
    const a = (rows2 ?? [])[0] as Record<string, unknown> | undefined, b = (rows2 ?? [])[1] as Record<string, unknown> | undefined;
    t("pickup_id 付きの2行", (rows2 ?? []).length === 2, rows2);
    t("source=aix:property_send・delivery=customer・channel=pickup", !!a && !!b && [a, b].every((r) => r.source === "aix:property_send" && r.delivery === "customer" && r.channel === "pickup"), rows2);
    t("image_url が位置どおり", a?.image_url === img("sent-1") && b?.image_url === img("sent-2"), rows2);
    t("ad_yen=50000・room_no='203'・property_url=NULL", a?.ad_yen === 50000 && b?.room_no === "203" && a?.property_url === null && b?.property_url === null, rows2);
    const { data: lgAfter } = await supabase.from("sent_properties").select("source, delivery, pickup_id").eq("id", testSpIds[0]).single();
    t("line_group の行は変わらない", (lgAfter as { source: string; pickup_id: number | null }).source === "line_group" && (lgAfter as { pickup_id: number | null }).pickup_id === null, lgAfter);
    const { data: sip2 } = await supabase.from("sent_image_properties").select("image_url, property_name, source, channel").in("image_url", [img("sent-1"), img("sent-2")]);
    t("sent_image_properties に2行（channel=pickup）", (sip2 ?? []).length === 2 && (sip2 ?? []).every((r) => (r as { channel: string }).channel === "pickup"), sip2);
    const { data: pk2 } = await supabase.from("property_pickups").select("id, status").in("id", [id1, id2]);
    t("property_pickups の status が sent", (pk2 ?? []).every((r) => (r as { status: string }).status === "sent"), pk2);
    for (const r of (rows2 ?? []) as Array<{ id: string }>) testSpIds.push(r.id);

    // 3) 冪等
    const r3 = await markSent(BATCH, [id1, id2], [img("sent-1"), img("sent-2")]);
    const { count: c3 } = await supabase.from("sent_properties").select("id", { count: "exact", head: true }).in("pickup_id", [id1, id2]);
    t("もう一度呼んでも新しい行0（already×2）", c3 === 2 && r3.recorded?.inserted === 0 && (r3.recorded?.skipped ?? []).filter((s) => s.endsWith(":already")).length === 2, r3);

    // 4) 画像の読み取りと二重にならない（既読の経路・DeepSeek を呼ばない）
    const r4 = await recordSentImageProperty({ imageUrl: img("sent-1"), conversationId: YUMA, source: "aix:property_send" });
    console.log("4) recordSentImageProperty:", JSON.stringify(r4));
    t("read=reused（DeepSeek を呼ばない）", r4.read === "reused", r4);
    t("sentProperties=duplicate_skipped", String(r4.sentProperties).startsWith("duplicate_skipped"), r4);
    const { data: sip4 } = await supabase.from("sent_image_properties").select("property_name, source, channel").eq("image_url", img("sent-1")).single();
    t("sent_image_properties の名前が上書きされていない", (sip4 as { property_name: string }).property_name === "YUMAテスト荘", sip4);
    const { count: c4 } = await supabase.from("sent_properties").select("id", { count: "exact", head: true }).eq("conversation_id", YUMA).like("image_url", `${URL_PREFIX}%`);
    t("sent_properties の画像つき行は2のまま", c4 === 2, c4);

    // 5) 合流（読み取りが先に書いた vision の行に update）
    const BATCH2 = `${BATCH}-b`;
    const { data: v5, error: v5e } = await supabase.from("sent_properties").insert({
      conversation_id: YUMA, property_customer_id: pcid, property_name: "YUMAテスト荘参番館", room_no: "", image_url: img("sent-3"), source: "vision", delivery: "customer",
    }).select("id").single();
    if (v5e) throw new Error(`vision insert: ${v5e.message}`);
    const v5id = (v5 as { id: string }).id; testSpIds.push(v5id);
    const id3 = await insertPickup(BATCH2, 1, "YUMAテスト荘参番館", null, img("page-3"), pcid, 30000);
    const { count: c5a } = await supabase.from("sent_properties").select("id", { count: "exact", head: true }).eq("conversation_id", YUMA);
    const r5 = await markSent(BATCH2, [id3], [img("sent-3")]);
    const { count: c5b } = await supabase.from("sent_properties").select("id", { count: "exact", head: true }).eq("conversation_id", YUMA);
    const { data: v5after } = await supabase.from("sent_properties").select("source, channel, pickup_id, delivery, ad_yen").eq("id", v5id).single();
    console.log("5) mark_sent（合流）:", JSON.stringify(r5.recorded), JSON.stringify(v5after));
    t("insert ではなく update（行数が増えない）", r5.recorded?.updated === 1 && r5.recorded?.inserted === 0 && c5a === c5b, { r5, c5a, c5b });
    t("pickup_id・channel=pickup・source=aix:property_send が付く", (v5after as { pickup_id: number }).pickup_id === id3 && (v5after as { channel: string }).channel === "pickup" && (v5after as { source: string }).source === "aix:property_send", v5after);

    // 6) 数が合わない
    const BATCH3 = `${BATCH}-c`;
    const id4 = await insertPickup(BATCH3, 1, "YUMAテスト第四荘", "401", img("page-4"), pcid, null);
    const id5 = await insertPickup(BATCH3, 2, "YUMAテスト第五荘", "501", img("page-5"), pcid, null);
    const r6 = await markSent(BATCH3, [id4, id5], [img("sent-4")]);
    const { count: c6 } = await supabase.from("sent_properties").select("id", { count: "exact", head: true }).in("pickup_id", [id4, id5]);
    t("画像の数が合わない → 何も書かない（image_count_mismatch）", c6 === 0 && (r6.recorded?.skipped ?? []).every((s) => s.endsWith("image_count_mismatch")), r6);

    // 7) 拡張の API
    const listRes = await (await dupGET(new NextRequest(`http://localhost/api/check-property-duplicate?conversation_id=${YUMA}`))).json() as { list: Array<Record<string, unknown>> };
    const mine = listRes.list.filter((r) => String(r.property_name ?? "").startsWith("YUMAテスト"));
    console.log("7) list（テスト行）:", JSON.stringify(mine.map((r) => ({ n: r.property_name, room: r.room_no, kind: r.kind, name_key: r.name_key, room_key: r.room_key }))));
    t("list の各要素に kind・name_key・room_key", mine.length >= 4 && mine.every((r) => "kind" in r && "name_key" in r && "room_key" in r));
    t("ピックアップの行は kind=pickup・共有の行は kind=shared", mine.some((r) => r.kind === "pickup") && mine.some((r) => r.kind === "shared"));
    t("古いキー（property_name, room_no, sent_at）も残る", mine.every((r) => "property_name" in r && "room_no" in r && "sent_at" in r));
    const one = await (await dupGET(new NextRequest(`http://localhost/api/check-property-duplicate?conversation_id=${YUMA}&property_name=${encodeURIComponent("YUMAテスト荘")}&room_no=101`))).json() as { is_duplicate: boolean; best_kind: string | null; duplicates: Array<Record<string, unknown>> };
    console.log("7) 個別照合:", JSON.stringify(one));
    t("is_duplicate=true・best_kind=pickup（共有の行にも当たるがピックアップが勝つ）", one.is_duplicate === true && one.best_kind === "pickup", one);

    // 8) ブレインの注入文（前後を目で読む）
    console.log("\n8) ブレインの注入文 ── 変更前（1本で20件・共有も送付も同じ扱い）──");
    console.log(await oldText());
    console.log("\n── 変更後 ──");
    const nt = await newText();
    console.log(nt);
    t("📤ピックアップで送付の印", nt.includes("YUMAテスト荘 101（") && nt.includes("📤ピックアップで送付"));
    t("共有のみの見出し", nt.includes("▼グループに共有のみ") || !nt.includes("グループに共有のみ・お客様には未送付") /* 同名の送付があれば共有側は重複除けで消える */);
  } finally {
    // 9) 片付け
    const { data: pks } = await supabase.from("property_pickups").select("id").like("batch_id", `${BATCH}%`);
    const pkIds = ((pks ?? []) as Array<{ id: number }>).map((r) => r.id);
    if (pkIds.length) await supabase.from("sent_properties").delete().in("pickup_id", pkIds);
    await supabase.from("sent_properties").delete().like("image_url", `${URL_PREFIX}%`);
    if (testSpIds.length) await supabase.from("sent_properties").delete().in("id", testSpIds);
    await supabase.from("sent_image_properties").delete().like("image_url", `${URL_PREFIX}%`);
    await supabase.from("property_pickups").delete().like("batch_id", `${BATCH}%`);
    if (pcid) await supabase.from("property_customers").update({ last_property_sent_at: lastSentBefore }).eq("id", pcid);
    const after = await snapshot();
    const diffSp = [...after.sp].filter((x) => !before.sp.has(x)).length + [...before.sp].filter((x) => !after.sp.has(x)).length;
    const diffSip = [...after.sip].filter((x) => !before.sip.has(x)).length + [...before.sip].filter((x) => !after.sip.has(x)).length;
    const { count: leftPk } = await supabase.from("property_pickups").select("id", { count: "exact", head: true }).like("batch_id", `${BATCH}%`);
    console.log(`\n9) 片付け: sent_properties の差 ${diffSp} / sent_image_properties の差 ${diffSip} / 残った pickup ${leftPk ?? 0} / last_property_sent_at を戻した=${pcid ? "はい" : "対象なし"}`);
    t("片付け後、控えとの差が0", diffSp === 0 && diffSip === 0 && (leftPk ?? 0) === 0);
    console.log(`\n${pass} passed, ${fail} failed`);
    if (fail) process.exitCode = 1;
  }
}
main().catch((e) => { console.error(e); process.exit(1); });
