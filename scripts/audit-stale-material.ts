// scripts/audit-stale-material.ts — 「前に送った物件をお客様が後から聞いてきた」番を数える（読むだけ・LLM なし）
//
// 2026-10-15 竹内さん（10/14）「物件を送った時は最新なので大丈夫だが、お客さんから1週間以上前に送った物件について言われた場合は、
//   募集状況を念のために確認する形の方が正確。ただ複雑になる可能性があるので最善の案で練るように」
// 数える物（60日・テスト/社内の会話を除く）:
//   お客様の発言が「こちらが送った/オススメした物件」を引用・名指しして（property-thread の customer_ask・推定は除く）、
//   空き・内覧・申込・初期費用（＋割引）を聞いた番。その物件の資料の新しさ＝それより前の 送った・オススメした・物件確認（募集中/退去予定/別の部屋）の一番新しい時刻。
//   古さ（日）の段ごとに: スタッフ（竹内さん）がどう答えたか（物件確認した の AIX／確認の約束／そのまま答えた）・
//   後で募集が終わっていたか（物件確認の結果＝募集終了・スタッフの文の「募集終了・申込が入った・埋まった」）・
//   確かめる順 ①同じ部屋の売上サポの行が3日以内にあったか ②送った時に SUUMO の URL があったか。
// 実行: npx tsx --env-file=.env.local scripts/audit-stale-material.ts [--days=60] [--show=10] [--line=7]
import { createClient } from "@supabase/supabase-js";

const sb = createClient(process.env.NEXT_PUBLIC_SUPABASE_URL ?? "", process.env.SUPABASE_SERVICE_ROLE_KEY ?? process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY ?? "");
const arg = (k: string, d = "") => (process.argv.find((a) => a.startsWith(`--${k}=`)) ?? `--${k}=${d}`).split("=").slice(1).join("=");
const DAY = 86400_000;
const ms = (s: string) => Date.parse(s);
const one = (s: string | null | undefined, n = 70) => String(s ?? "").replace(/\s*\n\s*/g, " / ").slice(0, n);

type Msg = { sender: string; text: string | null; created_at: string; line_message_id: string | null; quoted_message_id: string | null; image_url: string | null; is_aix_generated: boolean | null };
type Aix = { created_at: string; sent_at: string | null; aix_type: string | null; check_pattern: string | null; property_names: string[] | null; prop_statuses: string[] | null; estimate_sent: boolean | null; generated_text: string | null };

const APPLY_RE = /申込|申し込|申込み|お申込/;
const PROMISE_RE = /(?:募集状況|空き状況|空室状況|空室|空き|募集|状況)[^\n。]{0,20}確認(?:させて|致し|いたし|し)|確認(?:させて|致し|いたし)[^\n。]{0,20}(?:ます|次第)/;
const END_RE = /募集(?:が)?終了|募集停止|申込(?:み)?(?:が)?(?:入|はい)|申し込み(?:が)?入|埋まって|成約(?:済|して)|決まってしま|他の方で決ま|募集(?:が)?(?:止|なく)/;

async function pageAll<T>(q: (from: number, to: number) => PromiseLike<{ data: T[] | null; error: { message: string } | null }>, max = 20000): Promise<T[]> {
  const out: T[] = [];
  for (let i = 0; i < max; i += 1000) {
    const { data, error } = await q(i, i + 999);
    if (error) throw new Error(error.message);
    out.push(...(data ?? []));
    if (!data || data.length < 1000) break;
  }
  return out;
}

async function main() {
  const { resolvePropertyThreads } = await import("../app/lib/property-thread");
  const { staleMaterialOf } = await import("../app/lib/stale-material");
  const { propertyLabelsForImages } = await import("../app/lib/quoted-context");
  const { splitPropertyName, buildingKeyOf } = await import("../app/lib/customer-state");
  const { isTestConversation, STAFF_INTERNAL_CONVERSATION_IDS } = await import("../app/lib/test-conversations");
  const days = Number(arg("days", "60")), show = Number(arg("show", "10")), line = Number(arg("line", "7"));
  const now = Date.now(), since = new Date(now - days * DAY).toISOString();

  // 会話: この期間にお客様の発言がある物
  const custRows = await pageAll<{ conversation_id: string }>((a, b) => sb.from("messages").select("conversation_id").eq("sender", "customer").gte("created_at", since).range(a, b), 200000);
  const convs = [...new Set(custRows.map((r) => r.conversation_id))].filter((id) => id && !isTestConversation(id) && !STAFF_INTERNAL_CONVERSATION_IDS.includes(id));

  // 売上サポの行（同じ部屋が拡張の検索で出ていたか）
  const pick = await pageAll<{ property_name: string | null; room_no: string | null; created_at: string }>((a, b) => sb.from("property_pickups").select("property_name, room_no, created_at")
    .gte("created_at", new Date(now - (days + 5) * DAY).toISOString()).order("created_at").range(a, b), 200000);
  const pickIdx = new Map<string, number[]>();
  for (const p of pick) {
    const ref = splitPropertyName(p.property_name, p.room_no);
    if (!ref?.room) continue;
    const k = `${ref.buildingKey}#${ref.room}`;
    (pickIdx.get(k) ?? pickIdx.set(k, []).get(k)!).push(ms(p.created_at));
  }

  type Row = {
    conv: string; at: string; room: string; topic: string; ageDays: number; freshKind: string; checkedBetween: boolean;
    resp: "aix_check" | "promise" | "direct" | "none"; ended: "ended" | "open" | "unknown"; pickup3d: boolean; suumo: boolean;
    cust: string; staff: string; mark: boolean;
  };
  const rows: Row[] = [];
  const unattributed: Array<{ conv: string; at: string; ageDays: number; text: string }> = [];
  let convDone = 0;
  for (const conv of convs) {
    convDone++;
    const msgsDesc = await pageAll<Msg>((a, b) => sb.from("messages").select("sender, text, created_at, line_message_id, quoted_message_id, image_url, is_aix_generated")
      .eq("conversation_id", conv).order("created_at", { ascending: false }).range(a, b), 4000);
    const msgs = msgsDesc.reverse();
    if (!msgs.some((m) => m.sender === "customer" && ms(m.created_at) >= ms(since))) continue;
    const [aixR, estR, recR] = await Promise.all([
      sb.from("aix_usage_logs").select("created_at, sent_at, aix_type, check_pattern, property_names, prop_statuses, estimate_sent, generated_text").eq("conversation_id", conv).not("sent_at", "is", null).order("created_at").limit(1000),
      sb.from("estimate_records").select("created_at, property_name, room_no, discount_yen, initial_cost_yen").eq("conversation_id", conv).limit(500),
      sb.from("recommendation_snapshots").select("sent_at, star_name, star_room, star_text").eq("conversation_id", conv).limit(200),
    ]);
    const aix = (aixR.data ?? []) as Aix[];
    const urls = [...new Set(msgs.filter((m) => m.sender === "staff" && m.image_url).map((m) => m.image_url as string))];
    const imageLabels = new Map<string, string>();
    for (let i = 0; i < urls.length; i += 40) for (const [k, v] of await propertyLabelsForImages(conv, urls.slice(i, i + 40))) imageLabels.set(k, v);
    const s = resolvePropertyThreads({ messages: msgs, imageLabels, aix, estimates: estR.data ?? [], recommendations: recR.data ?? [] });
    const byAt = new Map<string, Msg>();
    for (const m of msgs) if (m.sender === "customer") byAt.set(m.created_at, m);

    for (const r of s.rooms) {
      if (r.origin !== "ours") continue;
      let lastKept = -Infinity;
      for (const e of r.events) {
        if (e.kind !== "customer_ask" || e.by === "inferred" || ms(e.at) < ms(since)) continue;
        const full = String(byAt.get(e.at)?.text ?? e.text ?? "");
        const topic = APPLY_RE.test(full) && !/申込金|申込書/.test(full) ? "apply" : e.topic ?? "other";
        if (!["vacancy", "viewing", "cost", "discount", "apply"].includes(topic)) continue;
        // 内覧のキャンセル・費用でない「いくら」（水道代の上限等）は聞いている事でない
        if (/キャンセル/.test(full)) continue;
        if (topic === "cost" && !/初期費用|見積|総額|費用/.test(full)) continue;
        if (ms(e.at) - lastKept < 2 * 3600_000) continue; // 同じ部屋の続けての発言は1番
        lastKept = ms(e.at);
        const before = r.events.filter((x) => ms(x.at) < ms(e.at));
        const sends = before.filter((x) => x.kind === "sent" || x.kind === "recommended");
        if (!sends.length) continue;
        const fresh = before.filter((x) => x.kind === "sent" || x.kind === "recommended" || x.kind === "check_available" || x.kind === "check_vacating" || x.kind === "check_alternative");
        const last = fresh[fresh.length - 1];
        const lastSend = sends[sends.length - 1];
        const ageDays = (ms(e.at) - ms(last.at)) / DAY;
        // スタッフの答え: 発言の後、次のお客様の発言（スタッフが一度答えた後）までのスタッフの文・48時間以内の物件確認の AIX
        const t0 = ms(e.at);
        const after = msgs.filter((m) => ms(m.created_at) > t0 && ms(m.created_at) <= t0 + 48 * 3600_000);
        const block: Msg[] = []; let seenStaff = false;
        for (const m of after) { if (m.sender === "staff") { seenStaff = true; block.push(m); } else if (m.sender === "customer" && seenStaff) break; }
        const staffText = block.filter((m) => m.text && !m.image_url && !/^\s*\[画像\]/.test(m.text)).map((m) => m.text).join("\n");
        const aixCheck = aix.some((a) => a.aix_type === "property_check_result" && ms(a.sent_at ?? a.created_at) > t0 && ms(a.sent_at ?? a.created_at) <= t0 + 48 * 3600_000)
          || r.events.some((x) => x.kind.startsWith("check_") && ms(x.at) > t0 && ms(x.at) <= t0 + 48 * 3600_000);
        const resp: Row["resp"] = aixCheck ? "aix_check" : PROMISE_RE.test(staffText) ? "promise" : staffText.trim() || block.length ? "direct" : "none";
        // 後で募集が終わっていたか（14日以内）
        const later = r.events.filter((x) => ms(x.at) > t0 && ms(x.at) <= t0 + 14 * DAY);
        const named14 = msgs.filter((m) => m.sender === "staff" && m.text && ms(m.created_at) > t0 && ms(m.created_at) <= t0 + 14 * DAY && buildingKeyOf(m.text).includes(r.ref.buildingKey) && r.ref.buildingKey.length >= 3);
        const ended: Row["ended"] = later.some((x) => x.kind === "check_ended") || END_RE.test(staffText) || named14.some((m) => END_RE.test(String(m.text))) ? "ended"
          : later.some((x) => x.kind === "check_available" || x.kind === "check_vacating") ? "open" : "unknown";
        const pk = r.ref.room ? (pickIdx.get(`${r.ref.buildingKey}#${r.ref.room}`) ?? []) : [];
        const pickup3d = pk.some((p) => p <= t0 && p >= t0 - 3 * DAY);
        const suumo = msgs.some((m) => m.sender === "staff" && /suumo\.jp/i.test(m.text ?? "") && ms(m.created_at) <= t0
          && (buildingKeyOf(m.text).includes(r.ref.buildingKey) || Math.abs(ms(m.created_at) - ms(lastSend.at)) < 10 * 60_000));
        rows.push({ conv: conv.slice(0, 8), at: e.at, room: r.ref.display, topic, ageDays, freshKind: last.kind, checkedBetween: last !== lastSend, resp, ended, pickup3d, suumo, mark: !!staleMaterialOf(r, e.at, full, e.topic ?? "other"), cust: one(full), staff: one(staffText || (aixCheck ? "（AIX 物件確認した）" : "")) });
      }
    }
    // 名指し・引用の無い空きの質問（「まだ空いてますか」）で、こちらが最後に物件を送ったのが line 日以上前の番（どの物件かは台帳で決まらない＝下限の外の数）
    const attributed = new Set(s.rooms.flatMap((r) => r.events.filter((e) => e.kind === "customer_ask").map((e) => e.at)));
    const sendTimes = s.rooms.filter((r) => r.origin === "ours").flatMap((r) => r.events.filter((e) => e.kind === "sent" || e.kind === "recommended").map((e) => ms(e.at))).sort((a, b) => a - b);
    for (const m of msgs) {
      if (m.sender !== "customer" || ms(m.created_at) < ms(since) || attributed.has(m.created_at) || m.image_url) continue;
      const tx = String(m.text ?? "");
      if (!/まだ(?:空|あり|募集)|空いて|空き(?:は|あり)|埋まっ|募集(?:中|して)/.test(tx) || /\[画像\]|https?:/.test(tx)) continue;
      const prev = sendTimes.filter((t) => t < ms(m.created_at));
      if (!prev.length) continue;
      const t1 = ms(m.created_at);
      const st = msgs.filter((x) => x.sender === "staff" && x.text && !x.image_url && ms(x.created_at) > t1 && ms(x.created_at) <= t1 + 24 * 3600_000).map((x) => x.text).join("\n");
      const chk = aix.some((a) => a.aix_type === "property_check_result" && ms(a.sent_at ?? a.created_at) > t1 && ms(a.sent_at ?? a.created_at) <= t1 + 48 * 3600_000);
      unattributed.push({ conv: conv.slice(0, 8), at: m.created_at, ageDays: (t1 - prev[prev.length - 1]) / DAY, text: `${one(tx, 40)} → ${chk ? "AIX物件確認" : PROMISE_RE.test(st) ? "確認の約束" : "その他"}${END_RE.test(st) ? "・終了" : ""}` });
    }
    if (convDone % 50 === 0) console.error(`… ${convDone}/${convs.length}`);
  }

  const buckets: Array<[string, (d: number) => boolean]> = [["0〜3日", (d) => d < 3], ["3〜7日", (d) => d >= 3 && d < 7], ["7〜14日", (d) => d >= 7 && d < 14], ["14〜30日", (d) => d >= 14 && d < 30], ["30日〜", (d) => d >= 30]];
  const pct = (a: number, b: number) => (b ? `${Math.round((a / b) * 100)}%` : "-");
  console.log(`\n直近${days}日 会話 ${convs.length}・こちらが送った物件を引用/名指しで聞いた番（空き・内覧・申込・初期費用・割引） ${rows.length}`);
  console.log("古さ\t番\t物件確認AIX\t確認の約束\tそのまま答え\t答えなし\t後で終了\t後で募集中\t不明\t売上サポ3日内\tSUUMO URL");
  for (const [name, f] of buckets) {
    const b = rows.filter((r) => f(r.ageDays));
    const c = (k: keyof Row, v: unknown) => b.filter((r) => r[k] === v).length;
    const conf = c("resp", "aix_check") + c("resp", "promise");
    console.log(`${name}\t${b.length}\t${c("resp", "aix_check")}\t${c("resp", "promise")}\t${c("resp", "direct")}\t${c("resp", "none")}\t${c("ended", "ended")}\t${c("ended", "open")}\t${c("ended", "unknown")}\t${b.filter((r) => r.pickup3d).length}\t${b.filter((r) => r.suumo).length}\t（確認した ${pct(conf, b.length)}）`);
  }
  const marked = rows.filter((r) => r.mark);
  console.log(`\n「資料が古い」の印（app/lib/stale-material.ts・今の線）が出る番 ${marked.length}: 竹内さんが確認した ${marked.filter((r) => r.resp === "aix_check" || r.resp === "promise").length}・そのまま答えた ${marked.filter((r) => r.resp === "direct" || r.resp === "none").length}・後で終了 ${marked.filter((r) => r.ended === "ended").length}`);
  const stale = rows.filter((r) => r.ageDays >= line);
  console.log(`\n${line}日以上: ${stale.length}番 話題別: ${["vacancy", "viewing", "apply", "cost", "discount"].map((t) => `${t} ${stale.filter((r) => r.topic === t).length}`).join("・")}`);
  console.log(`  確認した（AIX/約束）× 後で終了: ${stale.filter((r) => r.resp !== "direct" && r.resp !== "none" && r.ended === "ended").length}／そのまま答えた × 後で終了: ${stale.filter((r) => (r.resp === "direct" || r.resp === "none") && r.ended === "ended").length}`);
  console.log(`  間に物件確認があった（資料の日より新しい確認）: ${stale.filter((r) => r.checkedBetween).length}`);
  for (const [lab, f] of [["そのまま答えた", (r: Row) => r.resp === "direct" || r.resp === "none"], ["確認した", (r: Row) => r.resp === "aix_check" || r.resp === "promise"]] as const) {
    console.log(`\n--- ${line}日以上・${lab}（${show}件まで）`);
    for (const r of stale.filter(f).slice(0, show)) console.log(`${r.conv} ${r.at.slice(0, 16)} ${r.room}（${r.ageDays.toFixed(1)}日・${r.topic}・後=${r.ended}${r.pickup3d ? "・売上サポ" : ""}） 客: ${r.cust}\n    スタッフ: ${r.staff}`);
  }
  const ua = unattributed.filter((u) => u.ageDays >= line);
  console.log(`\n名指し・引用の無い空きの質問 ${unattributed.length}番（最後に送ってから${line}日以上 ${ua.length}）`);
  for (const u of ua.slice(0, show)) console.log(`  ${u.conv} ${u.at.slice(0, 16)}（最後の送付から${u.ageDays.toFixed(1)}日） ${u.text}`);
  const all = rows.filter((r) => r.ended === "ended");
  console.log(`\n--- 後で終了と分かった番（全段・${show}件まで）`);
  for (const r of all.slice(0, show)) console.log(`${r.conv} ${r.at.slice(0, 16)} ${r.room}（${r.ageDays.toFixed(1)}日・${r.topic}・答え=${r.resp}） 客: ${r.cust}\n    スタッフ: ${r.staff}`);
}
main().catch((e) => { console.error(e); process.exitCode = 1; });
