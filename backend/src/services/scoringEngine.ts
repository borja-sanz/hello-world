/**
 * Composite Opportunity Score Engine
 *
 * Calculates a 0–100 score for any point or municipio using five weighted
 * factor groups. Weights are loaded from calibration_config and can be
 * adjusted live by admins.
 */

import { pool } from '../db';

// ─── Types ────────────────────────────────────────────────────────────────────

export interface CalibrationConfig {
  weight_population: number;
  weight_mobility: number;
  weight_commercial: number;
  weight_competition: number;
  weight_socioeconomic: number;
  despensa_familiar_min_pop: number;
  maxi_despensa_min_pop: number;
  mobility_override_threshold: number;
  commercial_override_threshold: number;
}

export interface FactorScores {
  population: number;
  mobility: number;
  commercial: number;
  competition: number;
  socioeconomic: number;
}

export interface TradeAreaRing {
  radius_km: number;
  population: number;
  our_store_count: number;
  competitor_count: number;
  our_stores: { name: string; format: string; dist_km: number }[];
  competitors: { name: string; chain: string; dist_km: number }[];
  saturation_index: number;
}

export interface OpportunityScore {
  score: number;
  factors: FactorScores;
  recommendation: 'GO' | 'CAUTION' | 'NO-GO';
  suggested_format: string | null;
  reasoning: string;
}

export interface TradeAreaAnalysis extends OpportunityScore {
  center: { lat: number; lng: number };
  municipio_name: string | null;
  municipio_population: number | null;
  rings: TradeAreaRing[];
}

// ─── Utilities ────────────────────────────────────────────────────────────────

function clamp(v: number, lo = 0, hi = 100): number {
  return Math.max(lo, Math.min(hi, v));
}

/** Piecewise linear interpolation for score normalization */
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

// ─── Config loader ────────────────────────────────────────────────────────────

export async function loadCalibrationConfig(): Promise<CalibrationConfig> {
  const result = await pool.query(
    `SELECT weight_population, weight_mobility, weight_commercial,
            weight_competition, weight_socioeconomic,
            despensa_familiar_min_pop, maxi_despensa_min_pop,
            mobility_override_threshold, commercial_override_threshold
     FROM calibration_config WHERE is_active = true ORDER BY id DESC LIMIT 1`
  );
  if (result.rows.length === 0) {
    // Safe defaults if DB row missing (matches real-data-v2 calibration)
    return {
      weight_population: 0.28, weight_mobility: 0.22, weight_commercial: 0.22,
      weight_competition: 0.15, weight_socioeconomic: 0.13,
      despensa_familiar_min_pop: 24000, maxi_despensa_min_pop: 55000,
      mobility_override_threshold: 0.80, commercial_override_threshold: 0.85,
    };
  }
  const r = result.rows[0];
  return {
    weight_population: parseFloat(r.weight_population),
    weight_mobility: parseFloat(r.weight_mobility),
    weight_commercial: parseFloat(r.weight_commercial),
    weight_competition: parseFloat(r.weight_competition),
    weight_socioeconomic: parseFloat(r.weight_socioeconomic),
    despensa_familiar_min_pop: parseInt(r.despensa_familiar_min_pop),
    maxi_despensa_min_pop: parseInt(r.maxi_despensa_min_pop),
    mobility_override_threshold: parseFloat(r.mobility_override_threshold),
    commercial_override_threshold: parseFloat(r.commercial_override_threshold),
  };
}

// ─── Factor calculators ───────────────────────────────────────────────────────

/**
 * POPULATION SCORE (0–100)
 * Uses piecewise linear normalization calibrated to Guatemala's distribution.
 * Breakpoints anchor the thresholds from the business rules.
 */
function scorePopulation(
  population: number,
  pop3km: number,
  pop10km: number,
  config: CalibrationConfig
): number {
  // Use the largest population signal we have
  const effectivePop = Math.max(population, pop3km, pop10km);
  return clamp(piecewise(effectivePop, [
    [0,                                   0],
    [5_000,                              10],
    [15_000,                             25],
    [config.despensa_familiar_min_pop,   40],
    [40_000,                             52],
    [config.maxi_despensa_min_pop,       65],
    [100_000,                            80],
    [300_000,                            92],
    [1_100_000,                         100],
  ]));
}

/**
 * Department-level population density (persons/km²).
 * Source: INE Guatemala Censo 2018 population + SEGEPLAN department areas.
 * Used as a foot-traffic / mobility proxy: denser departments have more
 * commercial movement even in municipios without detailed OSM road data.
 */
const DEPT_DENSITY: Record<string, number> = {
  'Guatemala':       1475,  // 3,322,000 pop / 2,253 km²
  'Sacatepéquez':     779,  //   362,000 /   465 km²
  'Totonicapán':      458,  //   486,000 / 1,061 km²
  'Sololá':           449,  //   476,000 / 1,061 km²
  'Quetzaltenango':   433,  //   846,000 / 1,951 km²
  'Chimaltenango':    339,  //   671,000 / 1,979 km²
  'San Marcos':       294,  // 1,115,000 / 3,791 km²
  'Suchitepéquez':    237,  //   594,000 / 2,510 km²
  'Escuintla':        164,  //   720,000 / 4,384 km²
  'Jalapa':           164,  //   338,000 / 2,063 km²
  'Chiquimula':       168,  //   400,000 / 2,376 km²
  'Huehuetenango':    165,  // 1,225,000 / 7,403 km²
  'Retalhuleu':       178,  //   330,000 / 1,858 km²
  'Jutiapa':          153,  //   494,000 / 3,219 km²
  'Alta Verapaz':     141,  // 1,222,000 / 8,686 km²
  'Santa Rosa':       131,  //   388,000 / 2,955 km²
  'Quiché':           126,  // 1,053,000 / 8,378 km²
  'El Progreso':       93,  //   179,000 / 1,922 km²
  'Baja Verapaz':      90,  //   282,000 / 3,124 km²
  'Zacapa':            88,  //   237,000 / 2,690 km²
  'Izabal':            51,  //   459,000 / 9,038 km²
  'Petén':             19,  //   684,000 / 35,854 km²
};

/**
 * MOBILITY SCORE (0–100)
 * Primary: OSM road/transit POI count from poi_cache within 10 km.
 * Secondary: population density — actual (population/area_km2) when area data
 *   is available, otherwise falls back to the department-level average from
 *   DEPT_DENSITY (INE 2018 / SEGEPLAN). Using actual density gives much better
 *   intra-department differentiation (Guatemala City ≈ 4,800/km² vs. rural
 *   Guatemala department municipios ≈ 200–600/km²).
 * Fallback: urban flag + commercial presence.
 */
async function scoreMobility(
  lat: number,
  lng: number,
  isUrban: boolean,
  department: string | null,
  municipioPop: number,
  areaKm2: number | null
): Promise<number> {
  // 1. OSM road/transit POIs
  const poiResult = await pool.query(
    `SELECT COUNT(*) AS cnt
     FROM poi_cache
     WHERE poi_type IN ('highway_primary','highway_secondary','highway_trunk',
                        'bus_stop','bus_station','fuel')
       AND ST_DWithin(
         geometry::geography,
         ST_SetSRID(ST_MakePoint($2, $1), 4326)::geography,
         10000
       )`,
    [lat, lng]
  );
  const poiCount = parseInt(poiResult.rows[0]?.cnt ?? '0');

  let score: number;
  if (poiCount > 0) {
    score = clamp(piecewise(poiCount, [
      [0,   isUrban ? 40 : 20],
      [5,   55],
      [15,  70],
      [30,  85],
      [50,  95],
      [100, 100],
    ]));
  } else {
    // Fallback: store/competitor presence implies road access
    const storeResult = await pool.query(
      `SELECT COUNT(*) AS cnt FROM (
         SELECT geometry FROM stores      WHERE ST_DWithin(geometry::geography, ST_SetSRID(ST_MakePoint($2,$1),4326)::geography, 10000)
         UNION ALL
         SELECT geometry FROM competitors WHERE ST_DWithin(geometry::geography, ST_SetSRID(ST_MakePoint($2,$1),4326)::geography, 10000)
       ) combined`,
      [lat, lng]
    );
    const storeCount = parseInt(storeResult.rows[0]?.cnt ?? '0');
    score = clamp((isUrban ? 55 : 30) + Math.min(storeCount * 3, 30));
  }

  // 2. Density bonus — use actual municipio density when area_km2 is seeded,
  //    otherwise fall back to the department-level average from INE 2018.
  const deptAvg = department ? (DEPT_DENSITY[department] ?? 0) : 0;
  const density = (areaKm2 != null && areaKm2 > 0 && municipioPop > 0)
    ? municipioPop / areaKm2
    : deptAvg;

  const densityBonus = clamp(piecewise(density, [
    [0,    0],
    [50,   3],
    [150,  8],
    [300, 13],
    [500, 18],
    [800, 22],
    [1500, 25],
    [3000, 28],  // dense urban cores (e.g. Guatemala City: ~4,800/km²)
    [5000, 30],
  ]));

  return clamp(score + densityBonus);
}

/**
 * COMMERCIAL DENSITY SCORE (0–100)
 * Primary: bank/pharmacy/market/hardware/ATM POIs within 5km.
 * ATMs are included because Banrural, BI, and BAC ATMs are densely mapped in
 * OSM for Guatemala and are strong indicators of formal economic activity.
 * Fallback: competitor count (any formal commerce signals purchasing power).
 */
async function scoreCommercial(lat: number, lng: number): Promise<number> {
  // Count commercial POIs in cache
  const poiResult = await pool.query(
    `SELECT COUNT(*) AS cnt
     FROM poi_cache
     WHERE poi_type IN ('bank','pharmacy','marketplace','market',
                        'hardware','fuel','supermarket','money_transfer','atm')
       AND ST_DWithin(
         geometry::geography,
         ST_SetSRID(ST_MakePoint($2, $1), 4326)::geography,
         5000
       )`,
    [lat, lng]
  );
  const poiCount = parseInt(poiResult.rows[0]?.cnt ?? '0');

  if (poiCount > 0) {
    return clamp(piecewise(poiCount, [
      [0,   0],
      [2,  20],
      [5,  40],
      [10, 60],
      [20, 80],
      [40, 95],
      [80, 100],
    ]));
  }

  // Fallback: competitors within 5km as commercial activity signal
  const compResult = await pool.query(
    `SELECT COUNT(*) AS cnt FROM competitors
     WHERE ST_DWithin(
       geometry::geography,
       ST_SetSRID(ST_MakePoint($2, $1), 4326)::geography,
       5000
     )`,
    [lat, lng]
  );
  const compCount = parseInt(compResult.rows[0]?.cnt ?? '0');
  return clamp(piecewise(compCount, [
    [0,  20],
    [1,  40],
    [3,  60],
    [5,  75],
    [8,  85],
    [15, 90],
  ]));
}

/**
 * Maps a competitor chain name to a format-size weight.
 * Large-format chains suppress demand more than small independents.
 *   2.0 — hypermarket / large supermarket (Walmart, Paiz, La Torre, Super 24)
 *   1.3 — medium supermarket (La Bodegona, Dispensa del Hogar, Suma, Super del Barrio)
 *   0.7 — small / informal (tiendas, mini-supers, unknown chains)
 */
function competitorWeight(chain: string): number {
  const n = chain.toLowerCase();
  if (/walmart|paiz|la torre|super 24|econosuper|supermercados gi|hipermercado/.test(n)) return 2.0;
  if (/bodegona|dispensa del hogar|del hogar|super del barrio|suma\b|selectos|maxi/.test(n)) return 1.3;
  return 0.7;
}

/**
 * COMPETITION SCORE (0–100)
 *
 * Cannibalization (own stores):
 *   Smooth exponential decay — impact = 42 × e^(−dist/4).
 *   At 0 km: −42 | 2 km: −25 | 5 km: −13 | 10 km: −6 | 20 km: −2
 *   Far uncovered areas (>25 km, no own store) receive a +15 bonus.
 *
 * External competition (format-weighted):
 *   Effective competitor count = Σ competitorWeight(chain).
 *   Proven demand at moderate levels; saturation penalty above threshold.
 */
async function scoreCompetition(lat: number, lng: number): Promise<number> {
  let score = 50;

  // ── Own-store cannibalization ────────────────────────────────────────────
  const ourResult = await pool.query(
    `SELECT format,
            ST_Distance(geometry::geography,
              ST_SetSRID(ST_MakePoint($2,$1),4326)::geography) / 1000 AS dist_km
     FROM stores
     WHERE geometry IS NOT NULL
       AND format IN ('Despensa Familiar','Maxi Despensa','Walmart','Paiz')
     ORDER BY geometry <-> ST_SetSRID(ST_MakePoint($2,$1),4326)
     LIMIT 1`,
    [lat, lng]
  );

  if (ourResult.rows.length > 0) {
    const dist = parseFloat(ourResult.rows[0].dist_km);
    // Smooth exponential decay: full penalty up close, fades with distance
    const penalty = Math.round(42 * Math.exp(-dist / 4));
    score -= penalty;
  } else {
    score += 15; // no existing coverage = genuine opportunity
  }

  // ── Format-weighted external competition ─────────────────────────────────
  const compResult = await pool.query(
    `SELECT chain FROM competitors
     WHERE geometry IS NOT NULL
       AND chain NOT IN ('Despensa Familiar','Maxi Despensa','Walmart','Paiz')
       AND ST_DWithin(
         geometry::geography,
         ST_SetSRID(ST_MakePoint($2,$1),4326)::geography,
         5000
       )`,
    [lat, lng]
  );

  // Sum weighted effective competitor count
  const effectiveCount = compResult.rows.reduce(
    (sum: number, row: { chain: string }) => sum + competitorWeight(row.chain),
    0
  );

  if (effectiveCount === 0)         score += 5;   // possible gap — neutral
  else if (effectiveCount <= 1.5)   score += 20;  // 1–2 small: proven demand
  else if (effectiveCount <= 3.5)   score += 12;  // moderate competition
  else if (effectiveCount <= 6)     score += 5;   // competitive but viable
  else if (effectiveCount <= 10)    score -= 8;   // crowded market
  else                              score -= 18;  // saturated

  return clamp(score);
}

/**
 * SOCIOECONOMIC SCORE (0–100)
 *
 * When real data is available (seeded from INE ENCOVI 2014 + Banguat 2020):
 *   - Purchasing power  = (1 − poverty_index) × 75   [0–75]
 *     Source: INE Guatemala ENCOVI 2014 department poverty rates
 *   - Remittance bonus  = remittance_index × 15       [0–15]
 *     Source: Banco de Guatemala remittance distribution 2020
 *   - Amenity signal    = OSM schools/hospitals nearby [0–10]
 *     (infrastructure density correlates with purchasing power)
 *
 * Fallback (no real data): OSM social-infrastructure POI count, urban flag.
 */
async function scoreSocioeconomic(
  lat: number,
  lng: number,
  isUrban: boolean,
  povertyIndex: number | null,
  remittanceIndex: number | null
): Promise<number> {
  const geo = `ST_SetSRID(ST_MakePoint($2, $1), 4326)::geography`;

  // Run both POI queries in parallel for efficiency
  const [poiResult, ldsResult] = await Promise.all([
    // OSM social infrastructure: schools, hospitals, churches within 5km.
    // Used as quality-of-life amenity bonus (real data) or primary proxy (fallback).
    pool.query(
      `SELECT COUNT(*) AS cnt FROM poi_cache
       WHERE poi_type IN ('school','university','hospital','clinic',
                          'health_centre','place_of_worship','pharmacy')
         AND ST_DWithin(geometry::geography, ${geo}, 5000)`,
      [lat, lng]
    ),
    // LDS church presence: The Church of Jesus Christ of Latter-day Saints builds
    // permanent meetinghouses (~$500k+ investment) only after professional demographic
    // analysis confirms sufficient D/C-segment household density and growth trajectory.
    // A meetinghouse within 5km is third-party validation that this community has
    // crossed the critical mass threshold for Despensa Familiar's core market.
    // Signal is binary — presence matters, count within range doesn't compound.
    pool.query(
      `SELECT COUNT(*) AS cnt FROM poi_cache
       WHERE poi_type = 'lds_church'
         AND ST_DWithin(geometry::geography, ${geo}, 5000)`,
      [lat, lng]
    ),
  ]);

  const poiCnt  = parseInt(poiResult.rows[0]?.cnt ?? '0');
  const ldsBonus = parseInt(ldsResult.rows[0]?.cnt ?? '0') > 0 ? 4 : 0;

  if (povertyIndex !== null) {
    // ── Real data path ────────────────────────────────────────────────────────
    // Purchasing power: lower poverty = higher disposable income
    const purchasingPower = (1 - povertyIndex) * 75;

    // Remittance bonus: even high-poverty areas can have strong purchasing power
    // if a large share of households receive remittances (e.g. Huehuetenango)
    const remittanceBonus = (remittanceIndex ?? 0) * 15;

    // Small amenity quality-of-life bonus from OSM infrastructure
    const amenityBonus = clamp(piecewise(poiCnt, [
      [0,  0], [3, 3], [8, 6], [20, 10],
    ]));

    return clamp(purchasingPower + remittanceBonus + amenityBonus + ldsBonus);
  }

  // ── Fallback: POI-proxy path ─────────────────────────────────────────────
  if (poiCnt > 0) {
    return clamp(piecewise(poiCnt, [
      [0,  20], [3, 40], [8, 60], [15, 75], [30, 90], [60, 100],
    ]) + ldsBonus);
  }
  return clamp((isUrban ? 55 : 35) + ldsBonus);
}

// ─── Format recommendation ────────────────────────────────────────────────────

function recommendFormat(
  pop: number,
  factors: FactorScores,
  config: CalibrationConfig
): { format: string | null; reasoning: string } {
  const mobilityPct  = factors.mobility  / 100;
  const commercialPct = factors.commercial / 100;

  const reasons: string[] = [];

  if (pop >= config.maxi_despensa_min_pop) {
    reasons.push(`population ${pop.toLocaleString()} exceeds Maxi Despensa threshold (${config.maxi_despensa_min_pop.toLocaleString()})`);
    return { format: 'Maxi Despensa', reasoning: reasons.join('; ') };
  }

  if (pop >= config.despensa_familiar_min_pop) {
    // Overrides toward Maxi Despensa
    if (mobilityPct >= config.mobility_override_threshold) {
      reasons.push(`high mobility score (${factors.mobility.toFixed(0)}) expands effective trade area`);
      return { format: 'Maxi Despensa', reasoning: reasons.join('; ') };
    }
    if (commercialPct >= config.commercial_override_threshold) {
      reasons.push(`high commercial density (${factors.commercial.toFixed(0)}) signals strong purchasing power`);
      return { format: 'Maxi Despensa', reasoning: reasons.join('; ') };
    }
    // Socioeconomic override: very low poverty + adequate population supports
    // the larger format even below the Maxi Despensa population threshold.
    // Threshold: socioeconomic score ≥ 75 (poverty ≤ ~17%) + pop ≥ 40,000.
    const socioPct = factors.socioeconomic / 100;
    if (socioPct >= 0.75 && pop >= 40_000) {
      reasons.push(`strong purchasing power (socioeconomic score ${factors.socioeconomic.toFixed(0)}) supports Maxi format`);
      return { format: 'Maxi Despensa', reasoning: reasons.join('; ') };
    }
    reasons.push(`population ${pop.toLocaleString()} in Despensa Familiar range`);
    return { format: 'Despensa Familiar', reasoning: reasons.join('; ') };
  }

  // Below DF threshold — mobility override only
  if (mobilityPct >= config.mobility_override_threshold && pop >= 15_000) {
    reasons.push(`below population threshold but high mobility compensates`);
    return { format: 'Despensa Familiar', reasoning: reasons.join('; ') };
  }

  reasons.push(`population ${pop.toLocaleString()} below minimum threshold (${config.despensa_familiar_min_pop.toLocaleString()})`);
  return { format: null, reasoning: reasons.join('; ') };
}

// ─── Main scoring function ────────────────────────────────────────────────────

export async function scorePoint(
  lat: number,
  lng: number,
  config?: CalibrationConfig
): Promise<OpportunityScore & { municipio_id?: number; municipio_name?: string }> {
  const cfg = config ?? await loadCalibrationConfig();

  // Find nearest/containing municipio — include socioeconomic + area data
  const municipioResult = await pool.query(
    `SELECT id, name, department, population, is_urban, poverty_index, remittance_index, area_km2
     FROM municipios
     WHERE centroid IS NOT NULL
     ORDER BY centroid <-> ST_SetSRID(ST_MakePoint($2, $1), 4326)
     LIMIT 1`,
    [lat, lng]
  );
  const municipio = municipioResult.rows[0];
  const pop             = parseInt(municipio?.population ?? '0');
  const isUrban         = municipio?.is_urban ?? false;
  const department      = municipio?.department ?? null;
  const povertyIndex    = municipio?.poverty_index    != null ? parseFloat(municipio.poverty_index)    : null;
  const remittanceIndex = municipio?.remittance_index != null ? parseFloat(municipio.remittance_index) : null;
  const areaKm2         = municipio?.area_km2         != null ? parseFloat(municipio.area_km2)         : null;

  // Population within rings
  const pop3Result = await pool.query(
    `SELECT COALESCE(SUM(population),0) AS total FROM municipios
     WHERE population IS NOT NULL AND centroid IS NOT NULL
       AND ST_DWithin(centroid::geography, ST_SetSRID(ST_MakePoint($2,$1),4326)::geography, 3000)`,
    [lat, lng]
  );
  const pop10Result = await pool.query(
    `SELECT COALESCE(SUM(population),0) AS total FROM municipios
     WHERE population IS NOT NULL AND centroid IS NOT NULL
       AND ST_DWithin(centroid::geography, ST_SetSRID(ST_MakePoint($2,$1),4326)::geography, 10000)`,
    [lat, lng]
  );
  const pop3km  = parseInt(pop3Result.rows[0]?.total ?? '0');
  const pop10km = parseInt(pop10Result.rows[0]?.total ?? '0');

  // Calculate all factor scores
  const [mobilityScore, commercialScore, competitionScore, socioScore] =
    await Promise.all([
      scoreMobility(lat, lng, isUrban, department, pop, areaKm2),
      scoreCommercial(lat, lng),
      scoreCompetition(lat, lng),
      scoreSocioeconomic(lat, lng, isUrban, povertyIndex, remittanceIndex),
    ]);

  const popScore = scorePopulation(pop, pop3km, pop10km, cfg);

  const factors: FactorScores = {
    population:    popScore,
    mobility:      mobilityScore,
    commercial:    commercialScore,
    competition:   competitionScore,
    socioeconomic: socioScore,
  };

  // Weighted composite score
  const score = clamp(
    factors.population    * cfg.weight_population +
    factors.mobility      * cfg.weight_mobility +
    factors.commercial    * cfg.weight_commercial +
    factors.competition   * cfg.weight_competition +
    factors.socioeconomic * cfg.weight_socioeconomic
  );

  // Recommendation
  const recommendation: 'GO' | 'CAUTION' | 'NO-GO' =
    score >= 80 ? 'GO' :
    score >= 40 ? 'CAUTION' :
                  'NO-GO';

  const effectivePop = Math.max(pop, pop10km);
  const { format, reasoning } = recommendFormat(effectivePop, factors, cfg);

  return {
    score: Math.round(score * 10) / 10,
    factors,
    recommendation,
    suggested_format: format,
    reasoning,
    municipio_id:   municipio?.id,
    municipio_name: municipio ? `${municipio.name}, ${municipio.department}` : undefined,
  };
}

// ─── Trade area analysis ──────────────────────────────────────────────────────

async function buildRing(
  lat: number, lng: number, radiusKm: number
): Promise<TradeAreaRing> {
  const [popResult, ourResult, compResult] = await Promise.all([
    pool.query(
      `SELECT COALESCE(SUM(population),0) AS total FROM municipios
       WHERE population IS NOT NULL AND centroid IS NOT NULL
         AND ST_DWithin(centroid::geography, ST_SetSRID(ST_MakePoint($2,$1),4326)::geography, $3)`,
      [lat, lng, radiusKm * 1000]
    ),
    pool.query(
      `SELECT name, format,
              ROUND(ST_Distance(geometry::geography,ST_SetSRID(ST_MakePoint($2,$1),4326)::geography)/1000) AS dist_km
       FROM stores WHERE geometry IS NOT NULL
         AND ST_DWithin(geometry::geography,ST_SetSRID(ST_MakePoint($2,$1),4326)::geography,$3)
       ORDER BY dist_km`,
      [lat, lng, radiusKm * 1000]
    ),
    pool.query(
      `SELECT name, chain,
              ROUND(ST_Distance(geometry::geography,ST_SetSRID(ST_MakePoint($2,$1),4326)::geography)/1000) AS dist_km
       FROM competitors WHERE geometry IS NOT NULL
         AND ST_DWithin(geometry::geography,ST_SetSRID(ST_MakePoint($2,$1),4326)::geography,$3)
       ORDER BY dist_km`,
      [lat, lng, radiusKm * 1000]
    ),
  ]);

  const pop          = parseInt(popResult.rows[0]?.total ?? '0');
  const totalStores  = ourResult.rows.length + compResult.rows.length;
  // Saturation: how many stores per DF-threshold population unit
  const saturation   = pop > 0 ? Math.round((totalStores / (pop / 24_000)) * 100) / 100 : 0;

  return {
    radius_km:       radiusKm,
    population:      pop,
    our_store_count: ourResult.rows.length,
    competitor_count: compResult.rows.length,
    our_stores:      ourResult.rows,
    competitors:     compResult.rows,
    saturation_index: saturation,
  };
}

export async function analyzeTradeArea(
  lat: number,
  lng: number
): Promise<TradeAreaAnalysis> {
  const [cfg, score, ring3, ring5, ring10] = await Promise.all([
    loadCalibrationConfig(),
    scorePoint(lat, lng),
    buildRing(lat, lng, 3),
    buildRing(lat, lng, 5),
    buildRing(lat, lng, 10),
  ]);

  // Re-score using the already-loaded config to avoid double DB hit
  const refined = await scorePoint(lat, lng, cfg);

  return {
    ...refined,
    center: { lat, lng },
    municipio_name:       refined.municipio_name ?? null,
    municipio_population: ring10.population,
    rings: [ring3, ring5, ring10],
  };
}

// ─── Batch scoring ────────────────────────────────────────────────────────────

export async function scoreAllMunicipios(): Promise<number> {
  const cfg = await loadCalibrationConfig();
  const municipios = await pool.query(
    `SELECT id, lat, lng, population, is_urban FROM municipios WHERE lat IS NOT NULL AND lng IS NOT NULL`
  );

  let count = 0;
  for (const m of municipios.rows) {
    try {
      const result = await scorePoint(parseFloat(m.lat), parseFloat(m.lng), cfg);

      await pool.query(
        `INSERT INTO opportunity_scores
           (municipio_id, score, pop_score, mobility_score, commercial_score,
            competition_score, socioeconomic_score, recommendation, suggested_format,
            reasoning, weight_population, weight_mobility, weight_commercial,
            weight_competition, weight_socioeconomic, config_snapshot)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16)`,
        [
          m.id, result.score,
          result.factors.population, result.factors.mobility,
          result.factors.commercial, result.factors.competition,
          result.factors.socioeconomic,
          result.recommendation, result.suggested_format, result.reasoning,
          cfg.weight_population, cfg.weight_mobility, cfg.weight_commercial,
          cfg.weight_competition, cfg.weight_socioeconomic,
          JSON.stringify(cfg),
        ]
      );
      count++;
    } catch (_) {
      // skip individual failures
    }
  }
  return count;
}
