/**
 * Site Selection Service — Stage 2
 *
 * Given a Municipio ID, returns the top-5 optimal store locations within it.
 * Candidates are drawn from three sources (VIIRS NTL settlements, POI nuclei,
 * competitor gap clusters) and ranked by a micro-score that fuses:
 *   - NTL Luminosity      (0.30) — radiance as purchasing-power proxy
 *   - Commercial Gravity  (0.30) — weighted POI score / commercial activity
 *   - Gap Quality         (0.20) — whitespace from own stores + competitor density
 *   - Population Catchment(0.15) — NTL-derived 3 km population (not municipio-level)
 *   - Socioeconomic       (0.05) — municipio-level baseline from existing engine
 *
 * The existing Oportunidades (Stage 1) scoring is NOT modified.
 */

import { pool } from '../db';
import { scorePoint, loadCalibrationConfig } from './scoringEngine';

// ─── Public Types ─────────────────────────────────────────────────────────────

export interface SiteCandidate {
  rank: number;
  lat: number;
  lng: number;
  micro_score: number;
  source: 'viirs' | 'poi_nucleus' | 'comp_gap';
  source_id: string;
  factors: {
    ntl_luminosity: number;
    commercial_gravity: number;
    gap_quality: number;
    pop_catchment: number;
    socioeconomic: number;
  };
  supporting_data: {
    radiance_ntl: number | null;
    ntl_pop_3km: number;
    nearest_own_store_km: number | null;
    competitor_count_3km: number;
    road_accessible: boolean;
  };
  recommendation: 'GO' | 'CAUTION' | 'NO-GO';
  format_suggestion: 'Despensa Familiar' | 'Maxi Despensa' | null;
  reasoning: string;
}

export interface ConstraintSummary {
  candidates_generated: number;
  eliminated_own_store: number;
  surviving: number;
}

export interface SiteSelectionResult {
  municipio_id: number;
  municipio_name: string;
  department: string;
  candidate_count: number;
  top_candidate: SiteCandidate | null;
  alternatives: SiteCandidate[];
  constraints_applied: ConstraintSummary;
  generated_at: string;
}

// ─── Internal Types ───────────────────────────────────────────────────────────

interface RawCandidate {
  cid: string;
  source: 'viirs' | 'poi_nucleus' | 'comp_gap';
  lat: number;
  lng: number;
  radiance_ntl: number | null;
  weighted_poi_score: number | null;
  nearest_own_store_km: number | null;
  competitor_count_3km: number | null;
}

type ScoredResult =
  | { status: 'ok'; candidate: SiteCandidate }
  | { status: 'eliminated'; reason: 'own_store' }
  | { status: 'error' };

// ─── Utilities ────────────────────────────────────────────────────────────────

function clamp(v: number, lo = 0, hi = 100): number {
  return Math.max(lo, Math.min(hi, v));
}

function piecewise(x: number, pts: [number, number][]): number {
  const s = [...pts].sort((a, b) => a[0] - b[0]);
  if (x <= s[0][0]) return s[0][1];
  if (x >= s[s.length - 1][0]) return s[s.length - 1][1];
  for (let i = 0; i < s.length - 1; i++) {
    const [x0, y0] = s[i];
    const [x1, y1] = s[i + 1];
    if (x >= x0 && x <= x1) return y0 + ((x - x0) / (x1 - x0)) * (y1 - y0);
  }
  return 0;
}

// ─── Candidate Generation ─────────────────────────────────────────────────────

async function generateCandidates(
  municipioId: number,
  munName: string,
  department: string,
  centroidLat: number,
  centroidLng: number,
  areaKm2: number,
): Promise<RawCandidate[]> {
  const [viirs, nuclei, gaps] = await Promise.all([
    pool.query(
      `SELECT id::text AS cid, lat::float, lng::float,
              radiance_ntl::float, NULL::float AS weighted_poi_score,
              NULL::float AS nearest_own_store_km, NULL::int AS competitor_count_3km
       FROM ntl_settlements WHERE municipio_id = $1`,
      [municipioId],
    ),
    pool.query(
      `SELECT id::text AS cid, lat::float, lng::float,
              COALESCE(radiance_ntl, 0)::float AS radiance_ntl,
              weighted_score::float AS weighted_poi_score,
              nearest_own_store_km::float,
              competitor_count_3km::int
       FROM poi_nuclei
       WHERE municipio_name = $1 AND department = $2`,
      [munName, department],
    ),
    pool.query(
      `SELECT cluster_id::text AS cid, lat::float, lng::float,
              NULL::float AS radiance_ntl,
              nearby_poi_score::float AS weighted_poi_score,
              nearest_own_store_km::float,
              NULL::int AS competitor_count_3km
       FROM competitor_gaps
       WHERE municipio_id = $1`,
      [municipioId],
    ).catch(() => ({ rows: [] as any[] })),  // competitor_gaps may not exist yet
  ]);

  const sourcePriority: Record<string, number> = { poi_nucleus: 3, viirs: 2, comp_gap: 1 };

  const all: RawCandidate[] = [
    ...viirs.rows.map(r => ({ cid: r.cid, source: 'viirs' as const, lat: r.lat, lng: r.lng, radiance_ntl: r.radiance_ntl, weighted_poi_score: null, nearest_own_store_km: null, competitor_count_3km: null })),
    ...nuclei.rows.map(r => ({ cid: r.cid, source: 'poi_nucleus' as const, lat: r.lat, lng: r.lng, radiance_ntl: r.radiance_ntl, weighted_poi_score: r.weighted_poi_score, nearest_own_store_km: r.nearest_own_store_km, competitor_count_3km: r.competitor_count_3km })),
    ...gaps.rows.map(r => ({ cid: r.cid, source: 'comp_gap' as const, lat: r.lat, lng: r.lng, radiance_ntl: null, weighted_poi_score: r.weighted_poi_score, nearest_own_store_km: r.nearest_own_store_km, competitor_count_3km: null })),
  ];

  // Deduplicate: within 500 m, keep the highest-priority source
  const deduped: RawCandidate[] = [];
  for (const c of all.sort((a, b) => sourcePriority[b.source] - sourcePriority[a.source])) {
    const near = deduped.find(d => {
      const dlat = (d.lat - c.lat) * 111_000;
      const dlng = (d.lng - c.lng) * 111_000 * Math.cos(c.lat * Math.PI / 180);
      return Math.sqrt(dlat * dlat + dlng * dlng) < 500;
    });
    if (!near) deduped.push(c);
  }

  return deduped;
}

// ─── Score a Single Candidate ─────────────────────────────────────────────────

async function scoreCandidate(c: RawCandidate, cfg: any): Promise<ScoredResult> {
  try {
    const [sp, popRow, ownStoreRow, roadRow, compRow] = await Promise.all([
      scorePoint(c.lat, c.lng, cfg),

      pool.query<{ pop: string }>(
        `SELECT COALESCE(SUM(estimated_pop), 0)::int AS pop
         FROM ntl_settlements
         WHERE ST_DWithin(
           geometry::geography,
           ST_SetSRID(ST_MakePoint($2, $1), 4326)::geography,
           3000
         )`,
        [c.lat, c.lng],
      ),

      pool.query<{ km: string }>(
        `SELECT ROUND(MIN(ST_Distance(
           geometry::geography,
           ST_SetSRID(ST_MakePoint($2, $1), 4326)::geography
         )) / 1000)::float AS km
         FROM stores
         WHERE geometry IS NOT NULL AND status = 'open'`,
        [c.lat, c.lng],
      ),

      pool.query(
        `SELECT 1 FROM poi_cache
         WHERE poi_type IN ('highway_primary','highway_secondary','fuel','bus_station','bus_stop')
           AND geometry IS NOT NULL
           AND ST_DWithin(
             geometry::geography,
             ST_SetSRID(ST_MakePoint($2, $1), 4326)::geography,
             2000
           )
         LIMIT 1`,
        [c.lat, c.lng],
      ),

      // Only query competitors if count not already known from poi_nuclei
      c.competitor_count_3km == null
        ? pool.query<{ cnt: string }>(
            `SELECT COUNT(*)::int AS cnt FROM competitors
             WHERE geometry IS NOT NULL
               AND ST_DWithin(
                 geometry::geography,
                 ST_SetSRID(ST_MakePoint($2, $1), 4326)::geography,
                 3000
               )`,
            [c.lat, c.lng],
          )
        : Promise.resolve({ rows: [{ cnt: String(c.competitor_count_3km) }] }),
    ]);

    const ntl_pop_3km          = parseInt(String(popRow.rows[0].pop)) || 0;
    const nearest_own_store_km = ownStoreRow.rows[0]?.km != null ? parseFloat(String(ownStoreRow.rows[0].km)) : null;
    const road_accessible      = roadRow.rows.length > 0;
    const competitor_count_3km = parseInt(String(compRow.rows[0]?.cnt ?? '0')) || 0;

    // Hard filter: own store within 3 km
    if (nearest_own_store_km != null && nearest_own_store_km < 3) {
      return { status: 'eliminated', reason: 'own_store' };
    }

    // ── Sub-scores ────────────────────────────────────────────────────────────

    // 1. NTL Luminosity (0–100)
    const radiance      = c.radiance_ntl ?? 0;
    const ntl_luminosity = clamp(piecewise(radiance, [
      [0, 0], [1, 20], [5, 40], [10, 60], [20, 75], [50, 90], [100, 100],
    ]));

    // 2. Commercial Gravity (0–100)
    let commercial_gravity: number;
    if (c.source === 'poi_nucleus' && c.weighted_poi_score != null) {
      commercial_gravity = clamp(piecewise(c.weighted_poi_score, [
        [0, 0], [3, 20], [8, 40], [15, 60], [30, 80], [60, 95], [120, 100],
      ]));
    } else if (c.source === 'comp_gap' && c.weighted_poi_score != null) {
      commercial_gravity = clamp((c.weighted_poi_score / 30) * 100);
    } else {
      commercial_gravity = sp.factors.commercial;
    }

    // 3. Gap Quality (0–100)
    const ownGap = nearest_own_store_km != null
      ? piecewise(nearest_own_store_km, [[0, 0], [3, 30], [7, 70], [15, 90], [30, 100]])
      : 50;
    const compBonus = competitor_count_3km === 0 ? 0
      : competitor_count_3km <= 2 ? 20
      : competitor_count_3km <= 5 ? 15
      : 5;
    const gap_quality = clamp(ownGap + compBonus);

    // 4. Population Catchment (0–100)
    const pop_catchment = clamp(piecewise(ntl_pop_3km, [
      [0, 0], [3000, 20], [8000, 40], [15000, 60], [30000, 80], [60000, 100],
    ]));

    // 5. Socioeconomic — municipio-level baseline (identical for all candidates in same municipio)
    const socioeconomic = sp.factors.socioeconomic;

    // Composite
    let micro_score = clamp(
      ntl_luminosity     * 0.30 +
      commercial_gravity * 0.30 +
      gap_quality        * 0.20 +
      pop_catchment      * 0.15 +
      socioeconomic      * 0.05,
    );

    // Retail void multiplier: no store/competitor within 15 km + population present
    const isVoid = (nearest_own_store_km == null || nearest_own_store_km >= 15) && competitor_count_3km === 0;
    if (isVoid && ntl_pop_3km >= 5000) {
      micro_score = clamp(micro_score * 1.15);
    }

    const recommendation: 'GO' | 'CAUTION' | 'NO-GO' =
      micro_score >= 60 ? 'GO' : micro_score >= 35 ? 'CAUTION' : 'NO-GO';

    const format_suggestion: 'Despensa Familiar' | 'Maxi Despensa' | null =
      micro_score < 35 ? null : ntl_pop_3km >= 15000 ? 'Maxi Despensa' : 'Despensa Familiar';

    const reasoning = [
      `NTL: ${ntl_luminosity.toFixed(0)}/100 (rad. ${radiance.toFixed(1)})`,
      `Comercial: ${commercial_gravity.toFixed(0)}/100`,
      `Brecha: ${gap_quality.toFixed(0)}/100`,
      `Pob. 3 km: ${ntl_pop_3km.toLocaleString()}`,
      nearest_own_store_km != null ? `Tienda más cercana: ${nearest_own_store_km.toFixed(1)} km` : '',
    ].filter(Boolean).join(' · ');

    return {
      status: 'ok',
      candidate: {
        rank: 0,
        lat: c.lat,
        lng: c.lng,
        micro_score: Math.round(micro_score * 10) / 10,
        source: c.source,
        source_id: c.cid,
        factors: { ntl_luminosity, commercial_gravity, gap_quality, pop_catchment, socioeconomic },
        supporting_data: { radiance_ntl: c.radiance_ntl, ntl_pop_3km, nearest_own_store_km, competitor_count_3km, road_accessible },
        recommendation,
        format_suggestion,
        reasoning,
      },
    };
  } catch {
    return { status: 'error' };
  }
}

// ─── Main Export ──────────────────────────────────────────────────────────────

export async function selectSite(municipioId: number): Promise<SiteSelectionResult> {
  const mRow = await pool.query(
    `SELECT name, department,
            COALESCE(ST_Y(centroid::geometry), lat)::float AS centroid_lat,
            COALESCE(ST_X(centroid::geometry), lng)::float AS centroid_lng,
            COALESCE(area_km2, 100)::float                 AS area_km2
     FROM municipios WHERE id = $1`,
    [municipioId],
  );
  if (mRow.rows.length === 0) throw new Error(`Municipio ${municipioId} not found`);
  const m = mRow.rows[0];

  const rawCandidates = await generateCandidates(
    municipioId, m.name, m.department,
    m.centroid_lat, m.centroid_lng, m.area_km2,
  );

  const cfg = await loadCalibrationConfig();

  // Score all candidates in parallel
  const results = await Promise.all(rawCandidates.map(c => scoreCandidate(c, cfg)));

  const eliminated_own_store = results.filter(r => r.status === 'eliminated').length;
  const okResults = results
    .filter((r): r is { status: 'ok'; candidate: SiteCandidate } => r.status === 'ok')
    .map(r => r.candidate);

  okResults.sort((a, b) => b.micro_score - a.micro_score);

  const top5: SiteCandidate[] = okResults.slice(0, 5).map((c, i) => ({ ...c, rank: i + 1 }));

  return {
    municipio_id:    municipioId,
    municipio_name:  m.name,
    department:      m.department,
    candidate_count: top5.length,
    top_candidate:   top5[0] ?? null,
    alternatives:    top5.slice(1),
    constraints_applied: {
      candidates_generated: rawCandidates.length,
      eliminated_own_store,
      surviving: okResults.length,
    },
    generated_at: new Date().toISOString(),
  };
}
