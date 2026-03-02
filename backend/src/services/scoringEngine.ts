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
    // Safe defaults if DB row missing
    return {
      weight_population: 0.30, weight_mobility: 0.25, weight_commercial: 0.25,
      weight_competition: 0.15, weight_socioeconomic: 0.05,
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
 * MOBILITY SCORE (0–100)
 * Primary: POI count from poi_cache (roads, bus stops, fuel stations).
 * Fallback: urban flag + competitor presence as road-access proxy.
 */
async function scoreMobility(
  lat: number,
  lng: number,
  isUrban: boolean
): Promise<number> {
  let score = isUrban ? 55 : 30; // urban base

  // Count road-related POIs in cache within 10km
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

  if (poiCount > 0) {
    // Have real data: normalize against 50 POIs = full mobility score
    score = clamp(piecewise(poiCount, [
      [0,   isUrban ? 40 : 20],
      [5,   55],
      [15,  70],
      [30,  85],
      [50,  95],
      [100, 100],
    ]));
  } else {
    // Fallback: count any stores/competitors within 10km (implies road access)
    const storeResult = await pool.query(
      `SELECT COUNT(*) AS cnt FROM (
         SELECT geometry FROM stores   WHERE ST_DWithin(geometry::geography, ST_SetSRID(ST_MakePoint($2,$1),4326)::geography, 10000)
         UNION ALL
         SELECT geometry FROM competitors WHERE ST_DWithin(geometry::geography, ST_SetSRID(ST_MakePoint($2,$1),4326)::geography, 10000)
       ) combined`,
      [lat, lng]
    );
    const storeCount = parseInt(storeResult.rows[0]?.cnt ?? '0');
    score = clamp(score + Math.min(storeCount * 3, 30));
  }

  return score;
}

/**
 * COMMERCIAL DENSITY SCORE (0–100)
 * Primary: bank/pharmacy/market/hardware POIs within 5km.
 * Fallback: competitor count (any formal commerce signals purchasing power).
 */
async function scoreCommercial(lat: number, lng: number): Promise<number> {
  // Count commercial POIs in cache
  const poiResult = await pool.query(
    `SELECT COUNT(*) AS cnt
     FROM poi_cache
     WHERE poi_type IN ('bank','pharmacy','marketplace','market',
                        'hardware','fuel','supermarket')
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
 * COMPETITION SCORE (0–100)
 * Nuanced: close to our stores = cannibalization risk = bad.
 * Moderate competitors = proven market = good.
 * Many competitors = saturated = bad.
 */
async function scoreCompetition(lat: number, lng: number): Promise<number> {
  let score = 50;

  // Distance to nearest Despensa Familiar / Maxi Despensa (our own stores)
  const ourResult = await pool.query(
    `SELECT format,
            ROUND(ST_Distance(geometry::geography,
              ST_SetSRID(ST_MakePoint($2,$1),4326)::geography)/1000) AS dist_km
     FROM stores
     WHERE geometry IS NOT NULL
       AND format IN ('Despensa Familiar','Maxi Despensa','Walmart','Paiz')
     ORDER BY geometry <-> ST_SetSRID(ST_MakePoint($2,$1),4326)
     LIMIT 1`,
    [lat, lng]
  );

  if (ourResult.rows.length > 0) {
    const dist = parseFloat(ourResult.rows[0].dist_km);
    if (dist < 2)       score -= 40;  // direct cannibalization
    else if (dist < 5)  score -= 20;  // some overlap
    else if (dist < 10) score -= 5;   // minor overlap
    else if (dist > 20) score += 10;  // underserved area
  } else {
    score += 15; // no existing coverage = opportunity
  }

  // Competitor count within 5km (proven demand signal)
  const compResult = await pool.query(
    `SELECT COUNT(*) AS cnt FROM competitors
     WHERE geometry IS NOT NULL
       AND chain NOT IN ('Despensa Familiar','Maxi Despensa','Walmart','Paiz')
       AND ST_DWithin(
         geometry::geography,
         ST_SetSRID(ST_MakePoint($2,$1),4326)::geography,
         5000
       )`,
    [lat, lng]
  );
  const compCount = parseInt(compResult.rows[0]?.cnt ?? '0');

  if (compCount === 0)       score += 5;   // neutral – could be gap or no demand
  else if (compCount <= 2)   score += 20;  // proven demand, manageable competition
  else if (compCount <= 5)   score += 10;  // active market
  else if (compCount <= 10)  score -= 5;   // competitive
  else                       score -= 15;  // saturated

  return clamp(score);
}

/**
 * SOCIOECONOMIC SCORE (0–100)
 * Primary: schools, health centers, churches within 5km.
 * Fallback: urban classification.
 */
async function scoreSocioeconomic(
  lat: number,
  lng: number,
  isUrban: boolean
): Promise<number> {
  const poiResult = await pool.query(
    `SELECT COUNT(*) AS cnt
     FROM poi_cache
     WHERE poi_type IN ('school','university','hospital','clinic',
                        'health_centre','place_of_worship','pharmacy')
       AND ST_DWithin(
         geometry::geography,
         ST_SetSRID(ST_MakePoint($2, $1), 4326)::geography,
         5000
       )`,
    [lat, lng]
  );
  const cnt = parseInt(poiResult.rows[0]?.cnt ?? '0');

  if (cnt > 0) {
    return clamp(piecewise(cnt, [
      [0,  20],
      [3,  40],
      [8,  60],
      [15, 75],
      [30, 90],
      [60, 100],
    ]));
  }

  return isUrban ? 55 : 35; // fallback
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

  // Find nearest/containing municipio
  const municipioResult = await pool.query(
    `SELECT id, name, department, population, is_urban
     FROM municipios
     WHERE centroid IS NOT NULL
     ORDER BY centroid <-> ST_SetSRID(ST_MakePoint($2, $1), 4326)
     LIMIT 1`,
    [lat, lng]
  );
  const municipio = municipioResult.rows[0];
  const pop = parseInt(municipio?.population ?? '0');
  const isUrban = municipio?.is_urban ?? false;

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
      scoreMobility(lat, lng, isUrban),
      scoreCommercial(lat, lng),
      scoreCompetition(lat, lng),
      scoreSocioeconomic(lat, lng, isUrban),
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
