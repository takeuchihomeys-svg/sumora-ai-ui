// 2026-09-25 竹内「3日前の画像は消されるように。保存期間が終了しましたと出る感じで（実際の LINE のように）」— 純関数のテスト
// 実行: npx tsx app/lib/__tests__/pickup-retention.test.ts
import { pickupRetention, withPickupRetention, isPickupBlobUrl, planPickupPurge, rowsToMarkExpired, PICKUP_RETENTION_HOURS } from "../pickup-retention";

let passed = 0, failed = 0;
function t(name: string, ok: boolean, extra?: unknown) {
  if (ok) { passed++; console.log(`✅ ${name}`); } else { failed++; console.log(`❌ ${name}`, extra ?? ""); }
}

const H = 3600_000;
const NOW = Date.parse("2026-09-28T12:00:00Z");
const ago = (h: number) => new Date(NOW - h * H).toISOString();
const BLOB = "https://abc123.public.blob.vercel-storage.com";
const SUPA = "https://wfwsmwxakhyxobytszoq.supabase.co/storage/v1/object/public/property-images/aix/conv/1_trim.jpg";

// ── 期限の判定 ──
{
  const s = pickupRetention({ created_at: ago(71) }, NOW);
  t("71時間前は期限内・あと1時間で警告", !s.expired && s.hours_left === 1 && s.warn, s);
  const s2 = pickupRetention({ created_at: ago(72) }, NOW);
  t("72時間ちょうどで期限切れ", s2.expired && s2.hours_left === 0 && !s2.warn, s2);
  const s3 = pickupRetention({ created_at: ago(1) }, NOW);
  t("届いて1時間は警告なし（残り71時間）", !s3.expired && s3.hours_left === 71 && !s3.warn, s3);
  const s4 = pickupRetention({ created_at: ago(60) }, NOW);
  t("残り12時間で警告が出る", !s4.expired && s4.hours_left === 12 && s4.warn, s4);
  const s5 = pickupRetention({ created_at: ago(1), expired_at: ago(0) }, NOW);
  t("消した印（expired_at）があれば時間に関係なく期限切れ", s5.expired, s5);
  const s6 = pickupRetention({ created_at: "壊れた値" }, NOW);
  t("created_at が読めない行は隠さない", !s6.expired && s6.expires_at == null, s6);
  t("保存期間は 72時間", PICKUP_RETENTION_HOURS === 72);
}

// ── 画面に返す行 ──
{
  const row = { id: 1, created_at: ago(80), pdf_blob_url: `${BLOB}/pickups/a_1_1.pdf`, page_image_url: `${BLOB}/pickups/a_1_1_p1.png`, agent_image_url: `${BLOB}/pickups/a_1_1_p2.png`, trim_image_url: null, summary_text: "説明文" };
  const r = withPickupRetention(row, NOW);
  t("期限切れの行は画像・資料の URL を空にする", r.expired && r.pdf_blob_url === null && r.page_image_url === null && r.agent_image_url === null, r);
  t("期限切れでも説明文は残す", r.summary_text === "説明文");
  const fresh = withPickupRetention({ ...row, created_at: ago(2) }, NOW);
  t("期限内の行は URL をそのまま返す", !fresh.expired && fresh.page_image_url === row.page_image_url && fresh.expiry_hours_left === 70, fresh);
  const onlySome = withPickupRetention({ id: 2, created_at: ago(90), trim_image_url: "x" } as { id: number; created_at: string; trim_image_url: string | null }, NOW);
  t("無い列を足さない（渡した列だけ空にする）", onlySome.trim_image_url === null && !("pdf_blob_url" in onlySome), onlySome);
}

// ── 置き場の判定 ──
{
  t("Blob の pickups/ は消してよい", isPickupBlobUrl(`${BLOB}/pickups/%E7%89%A9_1_1_p1.png`));
  t("Blob の pickups/trim/ も消してよい", isPickupBlobUrl(`${BLOB}/pickups/trim/a_9_1.jpg`));
  t("Blob の直下（LINE グループに貼った結合 PDF）は消さない", !isPickupBlobUrl(`${BLOB}/%E7%89%A9%E4%BB%B6%E3%81%BE%E3%81%A8%E3%82%81_1.pdf`));
  t("Supabase の property-images（LINE で送った画像の置き場）は消さない", !isPickupBlobUrl(SUPA));
  t("別のホストの pickups/ は消さない", !isPickupBlobUrl("https://example.com/pickups/a.png"));
  t("http は消さない", !isPickupBlobUrl(`http://abc.public.blob.vercel-storage.com/pickups/a.png`));
  t("壊れた URL・空は消さない", !isPickupBlobUrl("not a url") && !isPickupBlobUrl(null) && !isPickupBlobUrl(""));
}

// ── 消す対象の選び方 ──
{
  const sentTrim = `${BLOB}/pickups/trim/b_12_1.jpg`;
  const rows = [
    // 期限切れ・未送信 → 3つとも消す
    { id: 10, created_at: ago(73), status: "pending", pdf_blob_url: `${BLOB}/pickups/a_1_1.pdf`, page_image_url: `${BLOB}/pickups/a_1_1_p1.png`, agent_image_url: `${BLOB}/pickups/a_1_1_p2.png`, trim_image_url: null },
    // 期限切れ・送信済み（YUMA の実例: 送った画像が Supabase の property-images を指す）→ 列は空にするがファイルは消さない
    { id: 11, created_at: ago(100), status: "sent", pdf_blob_url: `${BLOB}/pickups/a_2_1.pdf`, page_image_url: SUPA, agent_image_url: SUPA, trim_image_url: SUPA },
    // 期限切れ・トリミングが LINE の messages に直接使われた（旧い直接送信の名残）→ その1つは消さない
    { id: 12, created_at: ago(90), status: "sent", pdf_blob_url: `${BLOB}/pickups/b_12.pdf`, page_image_url: null, agent_image_url: null, trim_image_url: sentTrim },
    // 期限内 → 選ばない
    { id: 13, created_at: ago(10), status: "pending", pdf_blob_url: `${BLOB}/pickups/c_1.pdf`, page_image_url: null, agent_image_url: null, trim_image_url: null },
    // 既に印がある → 選ばない
    { id: 14, created_at: ago(200), expired_at: ago(100), status: "pending", pdf_blob_url: `${BLOB}/pickups/d_1.pdf` },
    // created_at が壊れている → 選ばない
    { id: 15, created_at: "", status: "pending", pdf_blob_url: `${BLOB}/pickups/e_1.pdf` },
    // 期限切れだが、まだ期限内の行（id 13）と同じ PDF を指している → 消さない
    { id: 16, created_at: ago(80), status: "pending", pdf_blob_url: `${BLOB}/pickups/c_1.pdf` },
  ];
  const protectedUrls = new Set([SUPA, sentTrim, `${BLOB}/pickups/c_1.pdf`]);
  const plan = planPickupPurge({ rows, protectedUrls, nowMs: NOW });
  const ids = plan.rows.map((r) => r.id);
  t("期限切れで印の無い行だけ選ぶ（10・11・12・16）", JSON.stringify(ids) === JSON.stringify([10, 11, 12, 16]), ids);
  t("送った画像（messages・sent_properties が指す URL）を消す物に入れない", !plan.deleteUrls.includes(sentTrim) && !plan.deleteUrls.includes(SUPA), plan.deleteUrls);
  t("期限内の行が使っている Blob を消す物に入れない", !plan.deleteUrls.includes(`${BLOB}/pickups/c_1.pdf`), plan.deleteUrls);
  t("未送信の期限切れ行は PDF・p1・p2 を消す", plan.rows.find((r) => r.id === 10)!.deleteUrls.length === 3);
  t("送信済みの行でも pickups/ の PDF（送っていない物）は消す", JSON.stringify(plan.rows.find((r) => r.id === 11)!.deleteUrls) === JSON.stringify([`${BLOB}/pickups/a_2_1.pdf`]));
  t("残した理由を数える（送った・別の置き場）", plan.keptCount.used_elsewhere === 5 && plan.keptCount.not_pickup_blob === 0, plan.keptCount);
  t("消す物に重複が無い", new Set(plan.deleteUrls).size === plan.deleteUrls.length);

  // 一部の削除に失敗 → その行は印を付けず次の回にやり直す
  const deleted = new Set(plan.deleteUrls.filter((u) => !u.endsWith("a_1_1_p2.png")));
  const mark = rowsToMarkExpired(plan, deleted);
  t("削除に失敗した物がある行は印を付けない（次の回にやり直す）", !mark.includes(10) && mark.includes(11) && mark.includes(12) && mark.includes(16), mark);
  t("消す物が無い行（全部送った画像）も印は付ける", rowsToMarkExpired(planPickupPurge({ rows: [rows[1]], protectedUrls: new Set([SUPA, `${BLOB}/pickups/a_2_1.pdf`]), nowMs: NOW }), new Set()).includes(11));
}

console.log(`\n${passed} passed, ${failed} failed`);
if (failed > 0) process.exit(1);
