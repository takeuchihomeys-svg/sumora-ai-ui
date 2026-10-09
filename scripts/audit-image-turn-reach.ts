// scripts/audit-image-turn-reach.ts — お客様の画像の番で、竹内さんの返事が画像の中身に依っていたか・その時ブレインと下書きに中身が届いていたか（読み取りのみ・LLM なし・$0）
//
// 2026-10-09 竹内「Claude Code にあってツールに無い力 2. 画像を見る」の「まず量る」。
//   前提の確かめ: お客様の画像は line-webhook が Vision（Claude Haiku）で書き起こして messages.text="[画像] 【見出し】\n<書き起こし>" に保存し、
//   brain-core（history）・generate-reply（IMAGE_TEXT_LABEL）にそのまま渡っている。ここでは「本当に届いていたか」「届いても使えていたか」を番ごとに数える。
//
// 正解: 竹内さん（messages.staff_writer='takeuchi'）の次の返事（次のお客様の発言まで・24h）。
// 画像の中身の語: 書き起こしの物件名（extractScreenshotProperty）・4字以上のカタカナ/英字の語・家賃（〇.〇万）・間取り（1LDK 等）・駅名（〇〇駅）。
// 「返事が画像に依っていた」= 返事（本文＋AIX の property_names）に画像の語があり、その語が番のお客様の文字の発言・番の前の30通の文字に無い。
// ブレイン: brain_decision_logs.digest（prop・q・dir）／下書き: line_watch_turns.draft_* → 無ければ ai_reply_examples.ai_draft。
// 申込の書類が出た会話はその手前で切る。テスト・社内の会話は外す。
//
// 実行: npx tsx --env-file=.env.local scripts/audit-image-turn-reach.ts [--days=60] [--examples=4] [--json=scripts/.replay-out/image-turn-reach.json]
import { createClient } from "@supabase/supabase-js";
import { writeFileSync } from "node:fs";

const sb = createClient(process.env.NEXT_PUBLIC_SUPABASE_URL ?? "", process.env.SUPABASE_SERVICE_ROLE_KEY ?? process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY ?? "");
const arg = (k: string, d = "") => (process.argv.find((a) => a.startsWith(`--${k}=`)) ?? `--${k}=${d}`).split("=").slice(1).join("=");
const one = (s: string, n = 120) => String(s ?? "").replace(/\s*\n\s*/g, " / ").slice(0, n);
const ms = (s: string | null | undefined) => (s ? Date.parse(s) : NaN);
const nf = (s: string | null | undefined) => String(s ?? "").normalize("NFKC");

type Msg = { id: string; conversation_id: string; sender: string; text: string | null; image_url: string | null; image_type: string | null; created_at: string; is_aix_generated: boolean | null; staff_writer: string | null };
type Aix = { conversation_id: string; created_at: string; sent_at: string | null; aix_type: string | null; property_names: string[] | null };

async function pageAll<T>(q: (from: number, to: number) => PromiseLike<{ data: T[] | null; error: { message: string } | null }>): Promise<T[]> {
  const out: T[] = [];
  for (let from = 0; ; from += 1000) {
    const { data, error } = await q(from, from + 999);
    if (error) throw new Error(error.message);
    out.push(...(data ?? []));
    if (!data || data.length < 1000) break;
  }
  return out;
}

// 画像の書き起こしによく出る汎用の語（物件を指さない）
const GENERIC = new Set(["マンション", "アパート", "オートロック", "フローリング", "エアコン", "インターネット", "システムキッチン", "バストイレ", "バルコニー", "クローゼット", "エレベーター", "シューズボックス", "ウォークイン", "モニター", "インターホン", "ガスコンロ", "ペット", "キャンペーン", "スーモ", "ホームズ", "アットホーム", "チャット", "ダウンロード", "アプリ", "ページ", "メッセージ", "タイプ", "ワンルーム", "コンビニ", "スーパー", "ドラッグストア", "セキュリティ", "リノベーション", "デザイナーズ", "フリーレント", "ルームシェア", "ロフト", "カード", "クレジット", "サービス", "プラン", "スマホ", "ホーム", "レンタル", "リビング", "キッチン", "トイレ", "シャワー", "バス", "LINE", "SUUMO", "HOME", "HOMES", "http", "https", "www", "com", "TikTok", "Instagram", "YouTube", "Google"]);

function imageTokens(body: string, extract: (t: string) => { name: string; room: string | null } | null, raw: string): { names: string[]; rents: string[]; layouts: string[]; stations: string[] } {
  const t = nf(body);
  const names = new Set<string>();
  const sp = extract(raw);
  if (sp?.name) names.add(nf(sp.name).replace(/\s+/g, ""));
  for (const m of t.matchAll(/[ァ-ヶー・]{4,}|[A-Za-z][A-Za-z'’\-]{3,}/g)) {
    const w = m[0].replace(/^・|・$/g, "");
    if (w.length < 4 || GENERIC.has(w) || [...GENERIC].some((g) => g.length >= 4 && w === g)) continue;
    names.add(w);
  }
  const rents = [...new Set([...t.matchAll(/([0-9]{1,2}\.[0-9]{1,2})\s*万/g)].map((m) => m[1]))];
  const layouts = [...new Set([...t.matchAll(/\b([1-4])\s*(SLDK|LDK|DK|K|SK)\b/g)].map((m) => `${m[1]}${m[2]}`))];
  const stations = [...new Set([...t.matchAll(/「?([一-龥ァ-ヶー]{2,8})」?\s*駅/g)].map((m) => m[1]).filter((s) => !/^(最寄|各|主要|徒歩|沿線)$/.test(s)))];
  return { names: [...names], rents, layouts, stations };
}

async function main() {
  const days = Number(arg("days", "60"));
  const nEx = Number(arg("examples", "4"));
  const jsonOut = arg("json", "");
  const since = new Date(Date.now() - days * 86400000).toISOString();
  const ctxSince = new Date(Date.now() - (days + 20) * 86400000).toISOString();
  const { isTestConversation } = await import("../app/lib/test-conversations");
  const { cutBeforeApplicationMaterial } = await import("../app/lib/test-pii-guard");
  const { extractScreenshotProperty } = await import("../app/lib/own-property-match");
  const { customerImageGroup, stripImageLabel, savedImageKind } = await import("../app/lib/image-label");

  const tk = await pageAll<{ conversation_id: string }>((a, b) => sb.from("messages").select("conversation_id").eq("staff_writer", "takeuchi").gte("created_at", since).range(a, b));
  const convIds = [...new Set(tk.map((r) => r.conversation_id))].filter((id) => !isTestConversation(id));
  console.error(`会話 ${convIds.length}`);

  const rows: Array<Record<string, unknown>> = [];
  let turnsAll = 0, imgTurns = 0, takeuchiImgTurns = 0;
  for (const cid of convIds) {
    const [msgs, aix, wt, bd, ex] = await Promise.all([
      pageAll<Msg>((a, b) => sb.from("messages").select("id, conversation_id, sender, text, image_url, image_type, created_at, is_aix_generated, staff_writer").eq("conversation_id", cid).gte("created_at", ctxSince).order("created_at").range(a, b)),
      pageAll<Aix>((a, b) => sb.from("aix_usage_logs").select("conversation_id, created_at, sent_at, aix_type, property_names").eq("conversation_id", cid).gte("created_at", ctxSince).range(a, b)),
      pageAll<{ customer_turn_at: string; draft_first: string | null; draft_last: string | null }>((a, b) => sb.from("line_watch_turns").select("customer_turn_at, draft_first, draft_last").eq("conversation_id", cid).gte("customer_turn_at", since).range(a, b)),
      pageAll<{ created_at: string; analyzed_msg_ts: string | null; digest: Record<string, unknown> | null; suggested_action: string | null }>((a, b) => sb.from("brain_decision_logs").select("created_at, analyzed_msg_ts, digest, suggested_action").eq("conversation_id", cid).gte("created_at", since).range(a, b)),
      pageAll<{ ai_draft: string | null; sent_at: string | null }>((a, b) => sb.from("ai_reply_examples").select("ai_draft, sent_at").eq("conversation_id", cid).gte("created_at", since).not("ai_draft", "is", null).range(a, b)),
    ]);
    const { kept } = cutBeforeApplicationMaterial(msgs);
    const M = kept as Msg[];
    for (let i = 0; i < M.length; i++) {
      if (M[i].sender !== "customer" || (i > 0 && M[i - 1].sender === "customer")) continue;
      let j = i; while (j + 1 < M.length && M[j + 1].sender === "customer") j++;
      const turn = M.slice(i, j + 1);
      const tStart = ms(turn[0].created_at), tEnd = ms(turn.at(-1)!.created_at);
      i = j;
      if (tStart < ms(since)) continue;
      turnsAll++;
      const imgs = turn.filter((m) => /^\s*\[画像\]/.test(m.text ?? ""));
      if (!imgs.length) continue;
      imgTurns++;
      let k = j + 1; const reply: Msg[] = [];
      while (k < M.length && M[k].sender !== "customer" && ms(M[k].created_at) - tEnd < 86400000) { reply.push(M[k]); k++; }
      if (!reply.length) continue;
      const firstText = reply.find((m) => m.text && !/^\s*\[画像\]/.test(m.text));
      if (!firstText || firstText.staff_writer !== "takeuchi") continue;
      takeuchiImgTurns++;

      // 画像の種類と中身
      const groups = imgs.map((m) => (m.text === "[画像]" ? "未読み取り" : customerImageGroup(m.text, m.image_type) ?? "不明"));
      const bodies = imgs.filter((m) => m.text !== "[画像]").map((m) => ({ raw: m.text ?? "", body: stripImageLabel(nf(m.text).replace(/^\s*\[画像\]\s*/, "")) }));
      const tok = { names: new Set<string>(), rents: new Set<string>(), layouts: new Set<string>(), stations: new Set<string>() };
      for (const b of bodies) {
        if (/本人確認書類|収入証明書|住民票|申込書/.test(b.body.slice(0, 20))) continue;
        const x = imageTokens(b.body, extractScreenshotProperty, b.raw);
        x.names.forEach((v) => tok.names.add(v)); x.rents.forEach((v) => tok.rents.add(v)); x.layouts.forEach((v) => tok.layouts.add(v)); x.stations.forEach((v) => tok.stations.add(v));
      }
      const custWords = nf(turn.filter((m) => !/^\s*\[(?:画像|動画|スタンプ|ファイル)/.test(m.text ?? "")).map((m) => m.text ?? "").join("\n"));
      const prior = nf(M.slice(Math.max(0, i - 30), i).filter((m) => !/^\s*\[(?:画像|動画|スタンプ|ファイル)/.test(m.text ?? "")).map((m) => m.text ?? "").join("\n"));
      const replyEnd = ms(reply.at(-1)!.created_at);
      const replyAix = aix.filter((a) => { const t = ms(a.sent_at ?? a.created_at); return t >= tEnd - 1000 && t <= replyEnd + 60000; });
      const replyText = nf(reply.map((m) => m.text ?? "").join("\n") + "\n" + replyAix.flatMap((a) => a.property_names ?? []).join("\n"));
      const hit = (v: string) => replyText.replace(/\s+/g, "").includes(v.replace(/\s+/g, ""));
      const usedNames = [...tok.names].filter(hit);
      const usedRents = [...tok.rents].filter(hit);
      const usedLayouts = [...tok.layouts].filter(hit);
      const usedStations = [...tok.stations].filter(hit);
      const used = [...usedNames, ...usedRents.map((r) => `${r}万`), ...usedLayouts, ...usedStations.map((s) => `${s}駅`)];
      const fromImageOnly = used.filter((u) => !custWords.replace(/\s+/g, "").includes(u.replace(/万|駅/g, "").replace(/\s+/g, "")));
      const newFromImage = fromImageOnly.filter((u) => !prior.replace(/\s+/g, "").includes(u.replace(/万|駅/g, "").replace(/\s+/g, "")));

      // ブレイン・下書き
      const brain = bd.filter((b) => b.analyzed_msg_ts && ms(b.analyzed_msg_ts) >= tStart - 1000 && ms(b.analyzed_msg_ts) <= tEnd + 1000 && ms(b.created_at) <= ms(reply[0].created_at) + 60000)
        .sort((a, b) => ms(b.created_at) - ms(a.created_at))[0] ?? null;
      const brainBefore = bd.filter((b) => ms(b.created_at) >= tEnd - 5000 && ms(b.created_at) <= ms(reply[0].created_at) + 60000).length;
      const dg = (brain?.digest ?? {}) as Record<string, unknown>;
      const bText = nf([dg.prop, ...(Array.isArray(dg.q) ? dg.q : []), dg.dir].filter(Boolean).join(" ｜ "));
      const w = wt.find((x) => ms(x.customer_turn_at) >= tStart - 60000 && ms(x.customer_turn_at) <= tEnd + 60000);
      const pick = (x: unknown) => { const v = String(x ?? ""); return /^__\w+__$/.test(v.trim()) ? "" : v; };
      let draft = w ? pick(w.draft_last) || pick(w.draft_first) : "";
      if (!draft) {
        const e = ex.find((x) => x.sent_at && Math.abs(ms(x.sent_at) - ms(reply[0].created_at)) < 15 * 60000 && x.ai_draft && !/^__\w+__$/.test(x.ai_draft.trim()));
        if (e) draft = e.ai_draft ?? "";
      }
      const dN = nf(draft).replace(/\s+/g, "");
      const bN = bText.replace(/\s+/g, "");
      const inBrain = newFromImage.filter((u) => bN.includes(u.replace(/万|駅/g, "").replace(/\s+/g, "")));
      const inDraft = newFromImage.filter((u) => dN.includes(u.replace(/万|駅/g, "").replace(/\s+/g, "")));
      const truthAix = replyAix.map((a) => a.aix_type).filter(Boolean) as string[];
      const brainAix = (dg.aix as string | null | undefined) ?? brain?.suggested_action ?? null;
      const aixMatch = !brain ? null : truthAix.length ? (brainAix ? truthAix.includes(brainAix) : false) : !brainAix;
      rows.push({
        cid, at: turn[0].created_at, groups, nImg: imgs.length, rawOnly: imgs.filter((m) => m.text === "[画像]").length,
        bodyLen: bodies.reduce((s, b) => s + b.body.length, 0), used, fromImageOnly, newFromImage, inBrain, inDraft,
        brain: !!brain, brainRuns: brainBefore, brainAix, truthAix, aixMatch, hasDraft: !!draft,
        cust: one(custWords, 80), reply: one(reply.map((m) => m.text ?? "").join(" / "), 140), brainText: one(bText, 140), draft: one(draft, 140),
      });
    }
  }

  const pct = (a: number, b: number) => (b ? `${((100 * a) / b).toFixed(0)}%` : "-");
  console.log(`\n=== お客様の画像の番（${days}日・竹内さんが返した番）===`);
  console.log(`お客様の番 ${turnsAll} ／ 画像を含む番 ${imgTurns} ／ うち竹内さんの返事 ${takeuchiImgTurns}`);
  const byGroup = new Map<string, number>();
  for (const r of rows) for (const g of new Set(r.groups as string[])) byGroup.set(g, (byGroup.get(g) ?? 0) + 1);
  console.log(`画像の種類（番の数・重なりあり）: ${[...byGroup].map(([k, v]) => `${k} ${v}`).join("・")}`);
  const raw = rows.filter((r) => (r.rawOnly as number) > 0);
  console.log(`読み取りの無い画像（[画像] だけ）を含む番: ${raw.length}`);
  const dep = rows.filter((r) => (r.fromImageOnly as string[]).length > 0);
  const depNew = rows.filter((r) => (r.newFromImage as string[]).length > 0);
  console.log(`\n返事が画像の中身に依っていた番（画像の語が返事にある・お客様の文字に無い）: ${dep.length} ／ ${rows.length}（${pct(dep.length, rows.length)}）`);
  console.log(`  うち番の前30通の文字にも無い（画像だけが出所）: ${depNew.length}`);
  const wb = depNew.filter((r) => r.brain);
  const wd = depNew.filter((r) => r.hasDraft);
  console.log(`  その番のブレイン（digest あり）: ${wb.length} → 画像の語が判断に出た ${wb.filter((r) => (r.inBrain as string[]).length).length}`);
  console.log(`  その番の下書き: ${wd.length} → 画像の語が下書きに出た ${wd.filter((r) => (r.inDraft as string[]).length).length}`);
  const am = depNew.filter((r) => r.aixMatch != null);
  console.log(`  ブレインの AIX の道が竹内さんと同じ: ${am.filter((r) => r.aixMatch).length} ／ ${am.length}`);
  const amAll = rows.filter((r) => r.aixMatch != null);
  console.log(`（参考）画像の番全体でブレインの AIX の道が同じ: ${amAll.filter((r) => r.aixMatch).length} ／ ${amAll.length}`);
  console.log(`画像の番の書き起こしの長さ（番の合計）: 平均 ${(rows.reduce((s, r) => s + (r.bodyLen as number), 0) / Math.max(1, rows.length)).toFixed(0)} 字`);

  const showEx = (title: string, list: Array<Record<string, unknown>>) => {
    console.log(`\n■ ${title}（${list.length}）`);
    for (const r of list.slice(0, nEx)) {
      console.log(`- ${String(r.cid).slice(0, 8)} ${String(r.at).slice(0, 16)} [${(r.groups as string[]).join(",")}] 画像の語=${(r.newFromImage as string[]).join("・")}`);
      console.log(`    お客様: ${r.cust}\n    竹内: ${r.reply}\n    ブレイン(${r.brainAix ?? "なし"}/正 ${(r.truthAix as string[]).join(",") || "なし"}): ${r.brainText}\n    下書き: ${r.draft}`);
    }
  };
  showEx("画像だけが出所・ブレインに画像の語が出ていない", depNew.filter((r) => r.brain && !(r.inBrain as string[]).length));
  showEx("画像だけが出所・下書きに画像の語が出ていない", depNew.filter((r) => r.hasDraft && !(r.inDraft as string[]).length));
  showEx("画像だけが出所・ブレインの AIX の道が違う", depNew.filter((r) => r.aixMatch === false));
  if (jsonOut) { writeFileSync(jsonOut, JSON.stringify(rows, null, 1)); console.log(`\n→ ${jsonOut}`); }
}
main().catch((e) => { console.error(e); process.exit(1); });
