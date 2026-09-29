// app/lib/__tests__/extension-snapshots.test.ts
// 拡張の「今の画面」と心拍の決まり（extension-snapshots.ts・純関数）のテスト。
// 実行: npx tsx app/lib/__tests__/extension-snapshots.test.ts
//
// 2026-09-29 竹内「ブレインのAIX検索モードが隼斗さんで止まってしまっている。なぜ固まっているのか」
//   「拡張ツールでひらいているページの画面をみて判断できる事もできるのか？」
//   9/29 16:32 の午後の便（f36ea311）の見送りは v2.5.38 より前の拡張だった → 版で見分ける（claimExtVersion・deviceView.outdated）
import {
  validateResultBody, sanitizeHeartbeat, parseStateHeader, pendingRequestsFor, planSnapshotPurge, blobPathFor, blobPutOptions,
  deviceView, versionAtLeast, claimExtVersion, claimInstallId, isMissingColumnError, IMAGE_MAX_BYTES, SNAPSHOT_MAX_IMAGES, REQUEST_TTL_MS,
  TOTAL_IMAGE_MAX_BYTES, TRIGGERS,
} from "../extension-snapshots";
import { classifyError } from "../search-audit-check";

let passed = 0, failed = 0;
function t(name: string, ok: boolean, extra?: unknown) {
  if (ok) { passed++; console.log(`  OK  ${name}`); } else { failed++; console.log(`  NG  ${name}${extra !== undefined ? `\n      ${JSON.stringify(extra).slice(0, 600)}` : ""}`); }
}
const NOW = Date.UTC(2026, 8, 29, 7, 32, 0);
const ID = "3f2b9c1e-8a7d-4c21-9f00-1234567890ab";
const jpeg = (n: number) => { const b = Buffer.alloc(n, 0x11); b[0] = 0xff; b[1] = 0xd8; b[2] = 0xff; return b.toString("base64"); };
const png = () => Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0]).toString("base64");
const base = { action: "result", install_id: ID, trigger: "stall", ext_version: "2.5.40", mode: "brain_aix" };

console.log("■ 撮った物の形（写真は3枚・1枚1.2MB・JPEG/PNG の中身を確かめる）");
{
  const ok1 = validateResultBody({ ...base, images: [{ site: "realpro", content_type: "image/jpeg", b64: jpeg(2000) }], tabs: [{ site: "realpro", image_index: 0 }], log_tail: [{ t: NOW, l: "log", m: "x".repeat(900) }] });
  t("正しい形は通る", ok1.ok);
  if (ok1.ok) {
    t("写真は Buffer になる", ok1.value.images[0].bytes.length === 2000 && ok1.value.images[0].contentType === "image/jpeg");
    t("ログの1行は300字まで", (ok1.value.log_tail[0].m ?? "").length === 300);
    t("版・モードが残る", ok1.value.ext_version === "2.5.40" && ok1.value.mode === "brain_aix");
  }
  t("4枚は通さない", !validateResultBody({ ...base, images: Array.from({ length: SNAPSHOT_MAX_IMAGES + 1 }, () => ({ site: "realpro", content_type: "image/jpeg", b64: jpeg(10) })) }).ok);
  t("1枚が1.2MB を超えたら通さない", !validateResultBody({ ...base, images: [{ site: "realpro", content_type: "image/jpeg", b64: jpeg(IMAGE_MAX_BYTES + 10) }] }).ok);
  t("合計が大きすぎたら通さない（1.1MB×3＝3.3MB は 3.0MB を超える）", !validateResultBody({ ...base, images: [0, 1, 2].map(() => ({ site: "itandi", content_type: "image/jpeg", b64: jpeg(1_100_000) })) }).ok);
  t("GIF は通さない", !validateResultBody({ ...base, images: [{ site: "realpro", content_type: "image/gif", b64: jpeg(10) }] }).ok);
  t("中身が JPEG でないのに image/jpeg は通さない", !validateResultBody({ ...base, images: [{ site: "realpro", content_type: "image/jpeg", b64: png() }] }).ok);
  t("PNG は PNG の中身なら通る", validateResultBody({ ...base, images: [{ site: "reins", content_type: "image/png", b64: png() }] }).ok);
  t("base64 でない文字は通さない", !validateResultBody({ ...base, images: [{ site: "realpro", content_type: "image/jpeg", b64: "<script>" }] }).ok);
  t("install_id が無ければ通さない", !validateResultBody({ ...base, install_id: "x" }).ok);
  t("知らない trigger は通さない", !validateResultBody({ ...base, trigger: "whatever" }).ok);
  const odd = validateResultBody({ ...base, ext_version: "2.5.40; DROP", mode: "god", request_id: -3, images: [{ site: "evil", content_type: "image/jpeg", b64: jpeg(10) }] });
  t("変な値は落とす（版・モード・request_id・サイト）", odd.ok && odd.value.ext_version === null && odd.value.mode === null && odd.value.request_id === null && odd.value.images[0].site === "other");
}

console.log("■ Blob（推測できない名前・public の置き場）");
{
  const o = blobPutOptions("image/jpeg");
  t("addRandomSuffix は true（2.x は既定 false）", o.addRandomSuffix === true && o.access === "public");
  t("置き場所は ext-snapshots/日付/時刻_PC_サイト", blobPathFor(ID, "realpro", "image/jpeg", NOW) === "ext-snapshots/20260929/163200_3f2b9c1e_realpro.jpg", blobPathFor(ID, "realpro", "image/jpeg", NOW));
  t("PNG は .png", blobPathFor(ID, "itandi", "image/png", NOW).endsWith("_itandi.png"));
}

console.log("■ 心拍（x-snap-state）");
{
  const h = parseStateHeader(encodeURIComponent(JSON.stringify({ ext_version: "2.5.40", mode: "brain_aix", batch_running: true, batch_command_id: "f36ea311", last_progress_at: NOW - 60000, waiting_for: "x".repeat(500), can_capture: true })));
  const row = sanitizeHeartbeat(ID, h, NOW);
  t("1行になる", !!row && row.ext_version === "2.5.40" && row.mode === "brain_aix" && row.batch_running && row.can_capture && row.batch_command_id === "f36ea311");
  t("時刻は ISO・待っている物は120字", !!row && row.last_progress_at === new Date(NOW - 60000).toISOString() && (row.waiting_for ?? "").length === 120 && row.last_seen_at === new Date(NOW).toISOString());
  t("壊れたヘッダーは {}", JSON.stringify(parseStateHeader("%E0%A4%A")) === "{}" && JSON.stringify(parseStateHeader(null)) === "{}" && JSON.stringify(parseStateHeader(encodeURIComponent("[1,2]"))) === "{}");
  t("install_id が変なら null", sanitizeHeartbeat("../../etc", {}, NOW) === null);
  t("変なモード・版は null", (() => { const r = sanitizeHeartbeat(ID, { mode: "root", ext_version: "latest", batch_running: "yes" }, NOW); return !!r && r.mode === null && r.ext_version === null && r.batch_running === false; })());
}

console.log("■ 頼まれ（10分以内・この PC がまだ答えていない物だけ）");
{
  const reqs = [
    { id: 1, created_at: new Date(NOW - 11 * 60 * 1000).toISOString(), install_id: null },  // 古い
    { id: 2, created_at: new Date(NOW - 5 * 60 * 1000).toISOString(), install_id: null },   // 答えた
    { id: 3, created_at: new Date(NOW - 3 * 60 * 1000).toISOString(), install_id: "other-pc-0001" }, // 別の PC 宛て
    { id: 4, created_at: new Date(NOW - 2 * 60 * 1000).toISOString(), install_id: null },
    { id: 5, created_at: new Date(NOW - 1 * 60 * 1000).toISOString(), install_id: ID },
  ];
  const answered = [{ request_id: 2, install_id: ID }, { request_id: 4, install_id: "other-pc-0001" }];
  t("この PC の分: 4（別の PC が答えても自分はまだ）", JSON.stringify(pendingRequestsFor(reqs, answered, ID, NOW)) === "[4]", pendingRequestsFor(reqs, answered, ID, NOW));
  t("max=3 なら 4,5", JSON.stringify(pendingRequestsFor(reqs, answered, ID, NOW, 3)) === "[4,5]");
  t("10分ちょうどはまだ答える・過ぎたら答えない", pendingRequestsFor([{ id: 9, created_at: new Date(NOW - REQUEST_TTL_MS).toISOString(), install_id: null }], [], ID, NOW).length === 1
    && pendingRequestsFor([{ id: 9, created_at: new Date(NOW - REQUEST_TTL_MS - 1).toISOString(), install_id: null }], [], ID, NOW).length === 0);
}

console.log("■ 14日の消し込み");
{
  const rows = [
    { id: 1, created_at: new Date(NOW - 15 * 86400000).toISOString(), tabs: [{ image_url: "https://x.public.blob.vercel-storage.com/a.jpg" }, { image_url: null }, { image_url: "javascript:alert(1)" }] },
    { id: 2, created_at: new Date(NOW - 13 * 86400000).toISOString(), tabs: [{ image_url: "https://x.public.blob.vercel-storage.com/b.jpg" }] },
    { id: 3, created_at: new Date(NOW - 20 * 86400000).toISOString(), tabs: null },
  ];
  const p = planSnapshotPurge(rows, NOW);
  t("14日を過ぎた行だけ（写真の無い頼まれの行も）", JSON.stringify(p.ids) === "[1,3]");
  t("消す写真は https の URL だけ", JSON.stringify(p.urls) === JSON.stringify(["https://x.public.blob.vercel-storage.com/a.jpg"]));
}

console.log("■ 版（再読み込み漏れの見分け）— 9/29 の件");
{
  t("2.5.37 は 2.5.38 より古い", !versionAtLeast("2.5.37", "2.5.38"));
  t("2.5.40 ≥ 2.5.38・2.5.100 ≥ 2.5.40（数で比べる）", versionAtLeast("2.5.40", "2.5.38") && versionAtLeast("2.5.100", "2.5.40"));
  const d = sanitizeHeartbeat(ID, { ext_version: "2.5.37" }, NOW - 5 * 60 * 1000)!;
  const v = deviceView(d, "2.5.40", NOW);
  t("古い版の PC は outdated（赤）・心拍5分前は応答なし", v.outdated && v.stale && v.seen_ago_sec === 300);
  t("今の版は outdated でない", !deviceView(sanitizeHeartbeat(ID, { ext_version: "2.5.40" }, NOW)!, "2.5.40", NOW).outdated);
  t("pending の x-ext-version", claimExtVersion(" 2.5.40 ") === "2.5.40" && claimExtVersion("") === null && claimExtVersion("2.5.40<script>") === null);
  t("pending の x-ext-install", claimInstallId(ID) === ID && claimInstallId("a") === null && claimInstallId(null) === null);
  t("列がまだ無い error の見分け（migrate-schema の前でも claim を止めない）",
    isMissingColumnError({ code: "PGRST204", message: "Could not find the 'picked_ext_version' column of 'automation_commands' in the schema cache" })
    && isMissingColumnError({ code: "42703", message: 'column "picked_ext_version" does not exist' })
    && !isMissingColumnError({ code: "23505", message: "duplicate key" }) && !isMissingColumnError(null));
}

console.log("■ 検索の点検: 見張りの時間切れ（拡張 v2.5.40）の種類");
{
  t("見張りの時間切れ → pass_deadline", classifyError("見張りの時間切れ（21分）: 隼斗さん・リアプロ・待っていた物=…") === "pass_deadline");
  t("ストップは stopped のまま", classifyError("__BATCH_STOPPED__") === "stopped");
  t("fill-done は fill_timeout のまま", classifyError("リアプロ 検索完了シグナル（fill-done）が90秒以内に届きませんでした。") === "fill_timeout");
}

console.log("■ 拡張（snapshot-core.js）とサーバーの上限が同じ");
{
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const SC = require("../../../chrome-extension/snapshot-core.js") as { IMAGE_MAX_BYTES: number; TOTAL_IMAGE_MAX_BYTES: number; TRIGGERS: string[]; heartbeatState: (o: unknown) => Record<string, unknown> };
  t("1枚の上限", SC.IMAGE_MAX_BYTES === IMAGE_MAX_BYTES);
  t("合計の上限", SC.TOTAL_IMAGE_MAX_BYTES === TOTAL_IMAGE_MAX_BYTES);
  t("きっかけの名前", JSON.stringify(SC.TRIGGERS) === JSON.stringify(TRIGGERS));
  const hb = SC.heartbeatState({ extVersion: "2.5.40", mode: "brain_aix", batchRunning: true, canCapture: true });
  const row = sanitizeHeartbeat(ID, hb, NOW);
  t("拡張の心拍をそのまま読める", !!row && row.ext_version === "2.5.40" && row.mode === "brain_aix" && row.batch_running && row.can_capture);
}

console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);
