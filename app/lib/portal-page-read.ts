// app/lib/portal-page-read.ts — お客様が送ってきたポータル（SUUMO）の URL のページを読み、物件名・家賃・間取り・駅を取る（LLM なし・決定論の HTML の読み）
//
// 2026-10-14 竹内さん「お客様が SUUMO 等のポータルの URL・スクショを送ってきた時に、中身を読む仕組みが既にあるか確かめ…読めていない所をつなぐ」
//   数えた（scripts/audit-portal-listing.ts・120日のお客様の発言）: SUUMO の共有文（物件名つき）202・athome 9・物件名の無い共有文 33・スクショ 103・**URL だけ 211**
//     URL だけの 211 はどこでも読んでいなかった（ページを開かない）。ホストは suumo.jp 147・homes 39・smocca 12・athome 7・eheya 5 他。
//   SUUMO のページ（試しに12件・並べずに1件ずつ）: 読めた 3（「ジュネーゼグラン難波ミラージュ」「レオンコンフォート大手通」・名前の無い jnc の掲載 1）・
//     404（掲載終了）4・取れない（続けて開くと断られる）5 → 1回の画面で開くのは最大3件・同じ URL は 1時間覚える
//   読み方（SUUMO の形）: <title>「【SUUMO】建物名（提供の会社）／所在地／駅の賃貸…」／<span class="property_view_note-emphasis">6.9万円</span>／
//     「管理費・共益費: 6000円」／表の 間取り・専有面積・階・駅徒歩。名前の無い掲載（jnc）は title が「1LDK/3階/37.26m2／…」で始まる＝名前にしない。
//   404 は「掲載が終わっている」印（募集終了の可能性・確かめる材料）。
// ⚠ ここで取った値は画面の候補（AIX の物件名の候補・押すと入る）だけに使い、先入れ・本文の数字には使わない（ページは古い・別の部屋の掲載もある）
// 戻す: PORTAL_PAGE_READ=off ／ 画面 NEXT_PUBLIC_PORTAL_PAGE_READ=off

export function portalPageReadEnabled(env: Record<string, string | undefined> = process.env): boolean {
  return (env.PORTAL_PAGE_READ ?? env.NEXT_PUBLIC_PORTAL_PAGE_READ ?? "").trim().toLowerCase() !== "off";
}

export type PortalPage = {
  url: string;
  site: "suumo" | "other";
  status: "ok" | "expired" | "failed" | "unsupported";
  name: string | null;
  floor: number | null;
  rentYen: number | null;
  adminYen: number | null;
  madori: string | null;
  areaSqm: number | null;
  station: string | null;
  walk: number | null;
  address: string | null;
};

const decode = (s: string) => s.replace(/&nbsp;/g, " ").replace(/&amp;/g, "&").replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&quot;/g, "\"").replace(/&#39;/g, "'").replace(/<[^>]+>/g, "").replace(/\s+/g, " ").trim();

/** 物件のページか（SUUMO の賃貸の1件のページ） */
export function portalSiteOf(url: string): PortalPage["site"] | null {
  try {
    const u = new URL(url);
    if (/(^|\.)suumo\.jp$/.test(u.hostname) && /\/chintai\/(?:bc_|jnc_)/.test(u.pathname)) return "suumo";
    return /suumo\.jp|homes\.co\.jp|athome\.co\.jp|smocca\.jp|eheya\.net|chintai\.net|canary-app|nifty\.com|door\.ac/.test(u.hostname) ? "other" : null;
  } catch { return null; }
}

/** SUUMO のページの HTML から読む（純関数） */
export function parseSuumoPage(url: string, html: string, httpStatus = 200): PortalPage {
  const base: PortalPage = { url, site: "suumo", status: "ok", name: null, floor: null, rentYen: null, adminYen: null, madori: null, areaSqm: null, station: null, walk: null, address: null };
  if (httpStatus === 404 || /<title>\s*エラー/.test(html)) return { ...base, status: "expired" };
  if (httpStatus !== 200) return { ...base, status: "failed" };
  // title の区切り「／」は NFKC の前に分ける（NFKC は「／」を「/」にし、名前の中の「/」と見分けられなくなる）
  const titleRaw = decode((html.match(/<title>([\s\S]*?)<\/title>/) ?? [])[1] ?? "").replace(/^【SUUMO】\s*/, "");
  const parts = titleRaw.split("／").map((s) => s.normalize("NFKC").trim());
  const head = parts[0] ?? "";
  // 名前の無い掲載（「1LDK/3階/37.26m2」）は名前にしない。提供の会社の括弧は外す
  if (head && !/^\d?\s*(?:SLDK|LDK|SDK|DK|K|R|ワンルーム)\s*\//i.test(head)) base.name = head.replace(/\s*\((?:[^()]|\([^)]*\))*提供\)\s*$/, "").trim() || null;
  if (parts[1] && /[都道府県]/.test(parts[1])) base.address = parts[1];
  // 2つの形: 名前の無い掲載（表 th/td・note-emphasis）／建物の掲載（property_data-title/body・main-emphasis・detail-text）
  const field = (label: string) => decode(
    (html.match(new RegExp(`<th[^>]*>\\s*${label}\\s*</th>\\s*<td[^>]*>([\\s\\S]*?)</td>`)) ?? [])[1]
    ?? (html.match(new RegExp(`property_data-title">\\s*${label}\\s*</div>\\s*<div class="property_data-body">([\\s\\S]*?)</div>`)) ?? [])[1] ?? "",
  ).normalize("NFKC");
  const rentRaw = (html.match(/property_view_(?:note|main)-emphasis">([^<]*)</) ?? [])[1] ?? "";
  const rent = decode(rentRaw).normalize("NFKC").match(/(\d+(?:\.\d+)?)\s*万円/);
  if (rent) base.rentYen = Math.round(Number(rent[1]) * 10000);
  const adm = decode((html.match(/管理費・共益費:([^<]*)</) ?? [])[1] ?? "").normalize("NFKC") || field("管理費・共益費");
  if (adm) base.adminYen = /^\s*-\s*$/.test(adm) ? 0 : (Number((adm.match(/(\d[\d,]*)\s*円/) ?? [])[1]?.replace(/,/g, "")) || null);
  const md = field("間取り"); if (/^\d?\s*(?:SLDK|LDK|SDK|DK|K|R)$|ワンルーム/i.test(md)) base.madori = md === "ワンルーム" ? "1R" : md.toUpperCase().replace(/\s/g, "");
  const ar = field("専有面積").match(/(\d+(?:\.\d+)?)\s*m/); if (ar) base.areaSqm = Number(ar[1]);
  const fl = field("階").match(/(\d+)\s*階/); if (fl) base.floor = Number(fl[1]);
  const acc = decode(
    (html.match(/<th[^>]*>\s*駅徒歩\s*<\/th>\s*<td[^>]*>\s*<div[^>]*>([^<]*)<\/div>/) ?? [])[1]
    ?? (html.match(/property_view_detail-text">([^<]*歩\s*[0-9０-９]+\s*分[^<]*)</) ?? [])[1] ?? "",
  ).normalize("NFKC");
  const am = acc.match(/\/\s*([^\s/]+?)駅?\s*歩\s*(\d+)\s*分/); if (am) { base.station = am[1].replace(/駅$/, "").replace(/^JR/, ""); base.walk = Number(am[2]); }
  return base;
}

function isSuumoHost(url: string): boolean {
  try { const u = new URL(url); return (u.protocol === "https:" || u.protocol === "http:") && /(^|\.)suumo\.jp$/.test(u.hostname) && !u.port; } catch { return false; }
}

const CACHE_MS = 60 * 60_000;
const cache = new Map<string, { at: number; v: PortalPage }>();
/** ページを開いて読む（SUUMO だけ・失敗しても投げない・1時間覚える） */
export async function readPortalPage(url: string, opts: { timeoutMs?: number } = {}): Promise<PortalPage> {
  const site = portalSiteOf(url);
  const empty: PortalPage = { url, site: site ?? "other", status: "unsupported", name: null, floor: null, rentYen: null, adminYen: null, madori: null, areaSqm: null, station: null, walk: null, address: null };
  if (site !== "suumo" || !portalPageReadEnabled()) return empty;
  const hit = cache.get(url);
  if (hit && Date.now() - hit.at < CACHE_MS) return hit.v;
  try {
    // fix(review): リダイレクトは手で追い、行き先も suumo.jp の時だけ開く（任意の URL をサーバーから開かない＝SSRF の線）
    const signal = AbortSignal.timeout(opts.timeoutMs ?? 8000);
    let cur = url;
    let r: Response | null = null;
    for (let hop = 0; hop < 4; hop++) {
      if (!isSuumoHost(cur)) return { ...empty, site: "suumo", status: "failed" };
      r = await fetch(cur, {
        headers: { "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120 Safari/537.36", "Accept-Language": "ja" },
        redirect: "manual", signal,
      });
      const loc = r.status >= 300 && r.status < 400 ? r.headers.get("location") : null;
      if (!loc) break;
      cur = new URL(loc, cur).toString();
      r = null;
    }
    if (!r) return { ...empty, site: "suumo", status: "failed" };
    const html = r.status === 200 ? await r.text() : "";
    const v = parseSuumoPage(url, html, r.status);
    if (v.status !== "failed") { if (cache.size > 500) cache.clear(); cache.set(url, { at: Date.now(), v }); }
    return v;
  } catch {
    return { ...empty, site: "suumo", status: "failed" };
  }
}

/** 発言の中のポータルの URL（SUUMO の1件のページ） */
export function portalUrlsIn(text: string | null | undefined): string[] {
  return [...String(text ?? "").matchAll(/https?:\/\/[^\s）)」』]+/g)].map((m) => m[0]).filter((u) => portalSiteOf(u) === "suumo");
}
