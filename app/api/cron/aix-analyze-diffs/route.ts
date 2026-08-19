// DEPRECATED 2026-08-20: analyze-diffs Step6（brainContext活用版）と二重分析していたため廃止
// aix_action差分分析はanalyze-diffs cronのStep6で実施
export const runtime = 'nodejs';
export async function POST(): Promise<Response> {
  return Response.json({ skipped: true, reason: 'deprecated: use analyze-diffs step6' });
}
