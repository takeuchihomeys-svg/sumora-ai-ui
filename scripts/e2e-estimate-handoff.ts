// scripts/e2e-estimate-handoff.ts
// 見積書の引き継ぎを本物の画面で通す（ヘッドレスの Chrome を CDP で動かす・追加の依存なし）。YUMA だけを使い、終わったら元に戻す。
//
// 2026-10-01 竹内「まだ確かめ切れていない事の3点強化する」→ ②実際の画面での確認
//   LINE のカード「🧾 見積書を作る」→ /estimate?conv= → お部屋・資料のセット → 自動の AI 読み取り → 割引の目安 →
//   「AIX【見積書送る】にセットして LINE へ」→ AixModal に見積書の画像が入っている、までを見る。
//
// 前提: 開発サーバ（BASE）が INTERNAL_API_SECRET と NEXT_PUBLIC_INTERNAL_API_SECRET を**同じ使い捨ての値**で起動していること
//   （.env.local には書かない・起動コマンドにだけ付ける。値はこのスクリプトに渡さない＝画面が自分で付ける）。
//   ローカルには BLOB_READ_WRITE_TOKEN が無いので、戻るボタンの「Blob に置く」は失敗する（本番だけ）。
//   その時は既存の Blob の画像（YUMA の売上サポの資料）で戻りの URL を作り、LINE 側のセットだけを確かめる。
// 書くもの: YUMA の messages（場面2通）と conversations.suggested_aix_meta（見積書送る）。終わったら消す・元に戻す。
//
// 実行: BASE=http://localhost:3291 npx tsx --env-file=.env.local scripts/e2e-estimate-handoff.ts
import { createClient } from "@supabase/supabase-js";
import { spawn } from "child_process";
import { mkdtempSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";

const sb = createClient(process.env.NEXT_PUBLIC_SUPABASE_URL ?? "", process.env.SUPABASE_SERVICE_ROLE_KEY ?? process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY ?? "");
const YUMA = "dd34f5b0-03bf-4dfb-a598-a4d18ebb8df7";
const BASE = process.env.BASE ?? "http://localhost:3291";
const CHROME = process.env.CHROME ?? "C:/Program Files/Google/Chrome/Application/chrome.exe";
const PORT = 9333;
let inserted: string[] = [];
let prevMeta: unknown = undefined;
let prevConv: Record<string, unknown> | null = null;
const results: Array<[string, boolean, string]> = [];
const check = (name: string, ok: boolean, detail = "") => { results.push([name, ok, detail]); console.log(`${ok ? "✓" : "✗"} ${name}${detail ? `  … ${detail}` : ""}`); };
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

class Cdp {
  private ws!: WebSocket; private id = 0; private pending = new Map<number, (v: unknown) => void>();
  async open(url: string) {
    this.ws = new WebSocket(url);
    await new Promise<void>((res, rej) => { this.ws.onopen = () => res(); this.ws.onerror = (e) => rej(e); });
    this.ws.onmessage = (ev) => { const m = JSON.parse(String(ev.data)); if (m.id && this.pending.has(m.id)) { this.pending.get(m.id)!(m); this.pending.delete(m.id); } };
  }
  send(method: string, params: Record<string, unknown> = {}): Promise<{ result?: { result?: { value?: unknown } } }> {
    const id = ++this.id;
    return new Promise((res) => { this.pending.set(id, res as (v: unknown) => void); this.ws.send(JSON.stringify({ id, method, params })); });
  }
  async eval<T = unknown>(expr: string): Promise<T> {
    const r = await this.send("Runtime.evaluate", { expression: expr, awaitPromise: true, returnByValue: true });
    return r.result?.result?.value as T;
  }
  async waitFor(expr: string, ms: number, label: string): Promise<boolean> {
    const t0 = Date.now();
    while (Date.now() - t0 < ms) { if (await this.eval<boolean>(`!!(${expr})`)) return true; await sleep(1000); }
    console.log(`  （待ち切れず: ${label}）`);
    return false;
  }
  close() { try { this.ws.close(); } catch { /* 無視 */ } }
}
const textHas = (s: string) => `document.body && document.body.innerText.includes(${JSON.stringify(s)})`;

async function main() {
  // ── YUMA に場面を入れる（🌟 の1件＋お客様の依頼）・ブレインの判断を「見積書送る」にする（画面の入口を出すため。ブレインそのものは別のテスト）
  const { data: conv } = await sb.from("conversations").select("suggested_aix_meta, last_sender, last_message, updated_at, ai_draft").eq("id", YUMA).maybeSingle();
  prevMeta = (conv as { suggested_aix_meta?: unknown } | null)?.suggested_aix_meta ?? null;
  prevConv = conv as Record<string, unknown> | null;
  const now = Date.now();
  const rows = [
    { conversation_id: YUMA, sender: "staff", is_aix_generated: true, text: "🌟プレサンス梅田北ザ・ライブ 305号室\n\n築浅で梅田へも出やすい、YUMAさんにかなりオススメ出来るお部屋となります！！", created_at: new Date(now - 8 * 60_000).toISOString() },
    { conversation_id: YUMA, sender: "customer", is_aix_generated: false, text: "初期費用はいくら位になりますかね", created_at: new Date(now - 4 * 60_000).toISOString() },
  ];
  const ins = await sb.from("messages").insert(rows).select("id");
  if (ins.error) throw new Error(ins.error.message);
  inserted = (ins.data ?? []).map((r: { id: string }) => r.id);
  // 画面のカードは「今のお客様の発言を見た判断」だけ出す（aix-button-view.isBrainAixFresh の analyzed_msg_ts・reply_mode=aix）
  await sb.from("conversations").update({ suggested_aix_meta: {
    action: "estimate_sheet", reply_mode: "aix", analyzed_msg_ts: rows[1].created_at,
    note: "E2E テスト（見積書の引き継ぎ）", source: "brain", decision_source: "e2e",
  }, last_sender: "customer", last_message: rows[1].text, updated_at: rows[1].created_at,
    // 下書きがあると画面が開いた時の下書きの先行生成（generate-draft-bg-async＝ブレインが判断を書き直す）を走らせない
    ai_draft: "（E2E テスト中の下書き）" }).eq("id", YUMA);

  // ── Chrome
  const dir = mkdtempSync(join(tmpdir(), "e2e-est-"));
  const chrome = spawn(CHROME, ["--headless=new", `--remote-debugging-port=${PORT}`, `--user-data-dir=${dir}`, "--window-size=430,900", "--no-first-run", "about:blank"], { stdio: "ignore" });
  let cdp: Cdp | null = null;
  try {
    let wsUrl = "";
    for (let i = 0; i < 30 && !wsUrl; i++) {
      try { const list = await (await fetch(`http://127.0.0.1:${PORT}/json`)).json() as Array<{ type: string; webSocketDebuggerUrl: string }>; wsUrl = list.find((x) => x.type === "page")?.webSocketDebuggerUrl ?? ""; } catch { /* 起動待ち */ }
      if (!wsUrl) await sleep(500);
    }
    cdp = new Cdp(); await cdp.open(wsUrl);
    await cdp.send("Page.enable"); await cdp.send("Runtime.enable");

    // ① LINE の会話 → カードの入口
    await cdp.send("Page.navigate", { url: `${BASE}/?conv=${YUMA}` });
    let cardOk = await cdp.waitFor(`[...document.querySelectorAll('a')].some(a => a.textContent.includes('見積書を作る（見積書ツールへ'))`, 180_000, "カードの入口");
    if (!cardOk) {
      // 同じ時間に別の作業の YUMA のブレインが判断を書き直すことがある（2026-10-01 に2回）→ 今の判断を見て、置き直して1回だけ読み直す
      const { data: now2 } = await sb.from("conversations").select("suggested_aix_meta").eq("id", YUMA).maybeSingle();
      console.log("  今の判断:", JSON.stringify((now2 as { suggested_aix_meta?: unknown } | null)?.suggested_aix_meta ?? null).slice(0, 160));
      await sb.from("conversations").update({ suggested_aix_meta: { action: "estimate_sheet", reply_mode: "aix", analyzed_msg_ts: rows[1].created_at, note: "E2E テスト（見積書の引き継ぎ）", source: "brain", decision_source: "e2e" } }).eq("id", YUMA);
      await cdp.send("Page.navigate", { url: `${BASE}/?conv=${YUMA}` });
      cardOk = await cdp.waitFor(`[...document.querySelectorAll('a')].some(a => a.textContent.includes('見積書を作る（見積書ツールへ'))`, 120_000, "カードの入口（2回目）");
    }
    const href = await cdp.eval<string>(`([...document.querySelectorAll('a')].find(a => a.textContent.includes('見積書を作る（見積書ツールへ'))||{}).getAttribute?.('href') || ''`);
    check("LINE の見積書の帯（ブレイン: 見積書送る）に「🧾 見積書を作る」", cardOk && href === `/estimate?conv=${YUMA}`, href);
    if (!cardOk) {
      const txt = (await cdp.eval<string>(`document.body.innerText`)) ?? "";
      const hits = [...txt.matchAll(/.{0,60}(?:見積書|AIX|初期費用はいくら).{0,60}/g)].map((m) => m[0].replace(/\s+/g, " ")).slice(-10);
      console.log("  画面の「見積書・AIX」の周り:\n   " + hits.join("\n   "));
      const btns = await cdp.eval<string[]>(`[...document.querySelectorAll("button,a")].map(b => b.textContent.trim()).filter(t => /見積|AIX/.test(t)).slice(0, 30)`);
      console.log("  ボタン:", (btns ?? []).join(" | "));
    }

    // ② 見積書の画面（監視の板・お部屋・自動の読み取り）
    await cdp.send("Page.navigate", { url: `${BASE}${href || `/estimate?conv=${YUMA}`}` });
    const panel = await cdp.waitFor(textHas("🛰 監視"), 120_000, "監視の板");
    check("見積書の画面に監視の板", panel);
    const room = await cdp.waitFor(textHas("プレサンス梅田北ザ・ライブ"), 60_000, "お部屋");
    const src = await cdp.eval<boolean>(textHas("出所: 直近にこちらがオススメしたお部屋"));
    check("お部屋がセット（プレサンス梅田北ザ・ライブ・出所 🌟）", room && src);
    const ad = await cdp.eval<boolean>(`/AD 1ヶ月|AD [0-9.]+ヶ月/.test(document.body.innerText)`);
    check("AD が見える（スタッフだけ）", ad);
    const review = await cdp.waitFor(textHas("費用プレビュー"), 240_000, "自動の読み取り→確認・調整");
    check("開いたら AI 読み取りまで自動で進んだ（確認・調整の画面）", review);
    const badges = await cdp.eval<string[]>(`[...document.querySelectorAll('span')].filter(s => s.textContent.startsWith('自動:')).map(s => s.textContent)`);
    check("自動で入れた欄の札（自動: 出所）", (badges ?? []).length > 0, (badges ?? []).slice(0, 4).join(" / "));
    const custName = await cdp.eval<boolean>(textHas("YUMA様"));
    check("お客様名が入っている", custName);
    const sug = await cdp.eval<string>(`(document.body.innerText.match(/目安 [0-9,]+円（[^）]*）/)||[''])[0]`);
    check("割引の目安が出ている", !!sug, sug);
    await cdp.eval(`([...document.querySelectorAll('button')].find(b => b.textContent.trim() === '目安を入れる')||{click(){}}).click()`);
    await sleep(800);
    const profit = await cdp.eval<string>(`(document.body.innerText.match(/AD [0-9,]+円 − 割引 [0-9,]+円 ＝ 利益 [-0-9,]+円/)||[''])[0]`);
    check("目安を入れると AD − 割引 ＝ 利益 が出る", /割引 [1-9]/.test(profit), profit);
    const imgHasAd = await cdp.eval<boolean>(`(() => { const d = [...document.querySelectorAll('div')].find(x => x.style && x.style.left === '-9999px'); return !!d && /AD|利益/.test(d.innerText); })()`);
    check("見積書の画像（印刷用）に AD・利益は出ない", !imgHasAd);

    // ③ 戻る（Blob に置く → ローカルは BLOB_READ_WRITE_TOKEN が無いので失敗する想定）
    await cdp.eval(`([...document.querySelectorAll('button')].find(b => b.textContent.includes('にセットして LINE へ'))||{click(){}}).click()`);
    for (let i = 0; i < 40; i++) { await sleep(1000); const st = await cdp.eval<string>(`location.href + "|" + document.body.innerText.includes("画像を作って LINE に戻っています")`); if (st.includes("est_img=") || st.endsWith("false")) break; }
    const loc = await cdp.eval<string>(`location.href`);
    const returnedViaBlob = loc.includes("est_img=");
    const errMsg = await cdp.eval<string>(`[...document.querySelectorAll('div')].filter(d => String(d.className).includes('bg-red-50')).map(d => d.textContent).join(' / ')`);
    check("戻るボタン（Blob に置いて LINE へ）", returnedViaBlob || !!errMsg, returnedViaBlob ? "Blob に置けた" : `ローカルでは失敗（${errMsg.slice(0, 60)}）`);

    // ④ LINE 側: 戻りの URL で AixModal に見積書の画像が入るか（Blob は既存の画像で代用）
    let imgUrl = returnedViaBlob ? new URL(loc).searchParams.get("est_img") ?? "" : "";
    if (!imgUrl) {
      const { data: pk } = await sb.from("property_pickups").select("page_image_url").eq("conversation_id", YUMA).not("page_image_url", "is", null).order("created_at", { ascending: false }).limit(1);
      imgUrl = (pk?.[0] as { page_image_url?: string } | undefined)?.page_image_url ?? "";
    }
    await cdp.send("Page.navigate", { url: `${BASE}/?conv=${YUMA}&est_img=${encodeURIComponent(imgUrl)}&est_aix=estimate_sheet` });
    const modal = await cdp.waitFor(`document.querySelector('img[alt="選択画像"]')`, 180_000, "AixModal の見積書画像");
    check("LINE に戻ると AIX【見積書送る】に見積書の画像がセットされて開く", modal, imgUrl ? `画像 ${imgUrl.slice(0, 60)}…` : "画像なし");
    const cleaned = await cdp.eval<string>(`location.search`);
    check("戻りの URL は会話だけに戻す（est_img を消す）", !cleaned.includes("est_img"), cleaned);

    // ⑤ 同封の場面: 物件オススメの ③見積書 にセットされるか
    await cdp.send("Page.navigate", { url: `${BASE}/?conv=${YUMA}&est_img=${encodeURIComponent(imgUrl)}&est_aix=property_recommendation` });
    const rec = await cdp.waitFor(`document.querySelector('img[alt="見積書"]')`, 180_000, "物件オススメの③見積書");
    check("同封の場面: AIX【物件オススメ】の ③見積書 に画像がセットされて開く", rec);
  } finally {
    cdp?.close();
    try { chrome.kill(); } catch { /* 無視 */ }
  }
}

main()
  .catch((e) => { console.error(e); process.exitCode = 1; })
  .finally(async () => {
    if (inserted.length) await sb.from("messages").delete().in("id", inserted);
    if (prevMeta !== undefined) await sb.from("conversations").update({ suggested_aix_meta: prevMeta, ...(prevConv ? { last_sender: prevConv.last_sender, last_message: prevConv.last_message, updated_at: prevConv.updated_at, ai_draft: prevConv.ai_draft } : {}) }).eq("id", YUMA);
    console.log(`\n${results.filter((r) => r[1]).length}/${results.length} 通過（YUMA の場面は消して判断を元に戻した）`);
    setTimeout(() => process.exit(process.exitCode ?? 0), 500);
  });
