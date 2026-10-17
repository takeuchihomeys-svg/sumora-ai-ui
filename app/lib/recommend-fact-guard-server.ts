// app/lib/recommend-fact-guard-server.ts — recommend-fact-guard の材料（駅の表・所在地の市区）を読む（読むだけ）
import type { SupabaseClient } from "@supabase/supabase-js";
import { STATION_LINES, wardOfStation, normStation, wardOfAddress } from "@/app/lib/osaka-geo";
import { claimsInFirstMessage, type StationGeo, type LedgerFacts } from "@/app/lib/recommend-fact-guard";

/** 1通目に書いた駅だけ、駅の表（station_map の市区・路線＋osaka-geo の路線）を引く */
export async function loadStationGeo(sb: SupabaseClient, message: string): Promise<Record<string, StationGeo>> {
  const stations = [...new Set(claimsInFirstMessage(message).filter((c) => c.kind === "station").map((c) => (c as { station: string }).station))].slice(0, 6);
  const out: Record<string, StationGeo> = {};
  if (stations.length === 0) return out;
  const tokens = [...new Set(stations.flatMap((s) => [s, `${s}駅`]))];
  let rows: Array<{ token: string; ward: string | null; realpro_lines: unknown; itandi_lines: unknown; reins_line: string | null }> = [];
  try {
    const { data } = await sb.from("station_map").select("token, ward, realpro_lines, itandi_lines, reins_line").in("token", tokens);
    rows = (data ?? []) as typeof rows;
  } catch { /* 表が読めなければ osaka-geo だけ */ }
  for (const s of stations) {
    const r = rows.find((x) => x.token === s || x.token === `${s}駅`);
    const arr = (v: unknown) => (Array.isArray(v) ? v.map(String) : []);
    const lines = [...new Set([...(r ? [...arr(r.realpro_lines), ...arr(r.itandi_lines), ...(r.reins_line ? [r.reins_line] : [])] : []), ...(STATION_LINES.get(normStation(s)) ?? [])])];
    const ward = (r?.ward && r.ward.trim()) || wardOfStation(s) || null;
    out[s] = { ward, lines };
  }
  return out;
}

/** 所在地の市区（台帳の所在地 → osaka-geo の市区の読み） */
export function addressWardOf(facts: LedgerFacts | null, materialText?: string | null): string | null {
  return wardOfAddress(facts?.address ?? null) ?? (materialText ? wardOfAddress((materialText.match(/(?:所在地|住所)[\s:：]*([^\n]{4,60})/) ?? [])[1] ?? null) : null);
}
