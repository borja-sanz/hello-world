-- ============================================================
-- GeoRetail Guatemala — Database Initialization
-- Requires PostGIS extension
-- ============================================================

CREATE EXTENSION IF NOT EXISTS postgis;
CREATE EXTENSION IF NOT EXISTS postgis_topology;

-- ============================================================
-- STORES: Our own store locations
-- ============================================================
CREATE TABLE IF NOT EXISTS stores (
    id              SERIAL PRIMARY KEY,
    name            VARCHAR(255) NOT NULL,
    format          VARCHAR(50) NOT NULL CHECK (format IN ('Despensa Familiar', 'Maxi Despensa', 'Walmart', 'Paiz', 'Other')),
    chain           VARCHAR(100),
    lat             DECIMAL(10, 7) NOT NULL,
    lng             DECIMAL(10, 7) NOT NULL,
    geometry        GEOMETRY(Point, 4326),
    status          VARCHAR(50) DEFAULT 'open' CHECK (status IN ('open', 'planned', 'closed', 'under_construction')),
    open_date       DATE,
    address         TEXT,
    department      VARCHAR(100),
    municipio       VARCHAR(100),
    notes           TEXT,
    performance     VARCHAR(50) CHECK (performance IN ('success', 'on-plan', 'underperforming', NULL)),
    created_at      TIMESTAMPTZ DEFAULT NOW(),
    updated_at      TIMESTAMPTZ DEFAULT NOW()
);

-- Auto-populate geometry from lat/lng
CREATE OR REPLACE FUNCTION update_store_geometry()
RETURNS TRIGGER AS $$
BEGIN
    NEW.geometry = ST_SetSRID(ST_MakePoint(NEW.lng, NEW.lat), 4326);
    NEW.updated_at = NOW();
    RETURN NEW;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS stores_geometry_trigger ON stores;
CREATE TRIGGER stores_geometry_trigger
    BEFORE INSERT OR UPDATE ON stores
    FOR EACH ROW EXECUTE FUNCTION update_store_geometry();

-- ============================================================
-- MUNICIPIOS: Administrative divisions with population data
-- ============================================================
CREATE TABLE IF NOT EXISTS municipios (
    id              SERIAL PRIMARY KEY,
    name            VARCHAR(255) NOT NULL,
    department      VARCHAR(100) NOT NULL,
    code            VARCHAR(20) UNIQUE,
    population      INTEGER,
    population_year INTEGER DEFAULT 2018,
    area_km2        DECIMAL(10, 2),
    lat             DECIMAL(10, 7),
    lng             DECIMAL(10, 7),
    geometry        GEOMETRY(MultiPolygon, 4326),
    centroid        GEOMETRY(Point, 4326),
    is_urban        BOOLEAN DEFAULT FALSE,
    remittance_index DECIMAL(5, 2),
    poverty_index   DECIMAL(5, 2),
    created_at      TIMESTAMPTZ DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS municipios_geometry_idx ON municipios USING GIST (geometry);
CREATE INDEX IF NOT EXISTS municipios_centroid_idx ON municipios USING GIST (centroid);

-- ============================================================
-- COMPETITORS: Competitor store locations
-- ============================================================
CREATE TABLE IF NOT EXISTS competitors (
    id              SERIAL PRIMARY KEY,
    name            VARCHAR(255),
    chain           VARCHAR(100) NOT NULL,
    lat             DECIMAL(10, 7) NOT NULL,
    lng             DECIMAL(10, 7) NOT NULL,
    geometry        GEOMETRY(Point, 4326),
    osm_id          BIGINT UNIQUE,
    verified        BOOLEAN DEFAULT FALSE,
    source          VARCHAR(50) DEFAULT 'osm' CHECK (source IN ('osm', 'manual', 'import', 'google_places')),
    address         TEXT,
    municipio       VARCHAR(100),
    zona            VARCHAR(100),
    department      VARCHAR(100),
    notes           TEXT,
    created_at      TIMESTAMPTZ DEFAULT NOW(),
    updated_at      TIMESTAMPTZ DEFAULT NOW()
);

-- Add zona to existing databases (safe to run on fresh DBs too)
ALTER TABLE competitors ADD COLUMN IF NOT EXISTS zona VARCHAR(100);

CREATE OR REPLACE FUNCTION update_competitor_geometry()
RETURNS TRIGGER AS $$
BEGIN
    NEW.geometry = ST_SetSRID(ST_MakePoint(NEW.lng, NEW.lat), 4326);
    NEW.updated_at = NOW();
    RETURN NEW;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS competitors_geometry_trigger ON competitors;
CREATE TRIGGER competitors_geometry_trigger
    BEFORE INSERT OR UPDATE ON competitors
    FOR EACH ROW EXECUTE FUNCTION update_competitor_geometry();

CREATE INDEX IF NOT EXISTS competitors_geometry_idx ON competitors USING GIST (geometry);

-- ============================================================
-- POI_CACHE: Cached OpenStreetMap POI data
-- ============================================================
CREATE TABLE IF NOT EXISTS poi_cache (
    id              SERIAL PRIMARY KEY,
    osm_id          BIGINT,
    osm_type        VARCHAR(10),
    UNIQUE (osm_id, osm_type),
    name            VARCHAR(255),
    poi_type        VARCHAR(100) NOT NULL,
    lat             DECIMAL(10, 7) NOT NULL,
    lng             DECIMAL(10, 7) NOT NULL,
    geometry        GEOMETRY(Point, 4326),
    tags            JSONB,
    municipio_id    INTEGER REFERENCES municipios(id),
    source          VARCHAR(30) DEFAULT 'osm',
    fetched_at      TIMESTAMPTZ DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS poi_cache_geometry_idx ON poi_cache USING GIST (geometry);
CREATE INDEX IF NOT EXISTS poi_cache_type_idx ON poi_cache (poi_type);

-- ============================================================
-- OPPORTUNITY_SCORES: Computed composite scores per municipio
-- ============================================================
CREATE TABLE IF NOT EXISTS opportunity_scores (
    id                  SERIAL PRIMARY KEY,
    municipio_id        INTEGER NOT NULL REFERENCES municipios(id),
    score               DECIMAL(5, 2) NOT NULL CHECK (score BETWEEN 0 AND 100),
    -- Factor scores (0–100 each)
    pop_score           DECIMAL(5, 2),
    mobility_score      DECIMAL(5, 2),
    commercial_score    DECIMAL(5, 2),
    competition_score   DECIMAL(5, 2),
    socioeconomic_score DECIMAL(5, 2),
    -- Factor weights used (for audit trail)
    weight_population   DECIMAL(4, 2) DEFAULT 0.28,
    weight_mobility     DECIMAL(4, 2) DEFAULT 0.22,
    weight_commercial   DECIMAL(4, 2) DEFAULT 0.22,
    weight_competition  DECIMAL(4, 2) DEFAULT 0.15,
    weight_socioeconomic DECIMAL(4, 2) DEFAULT 0.13,
    -- Recommendation
    recommendation      VARCHAR(20) CHECK (recommendation IN ('GO', 'CAUTION', 'NO-GO')),
    suggested_format    VARCHAR(50),
    reasoning           TEXT,
    -- Meta
    calculated_at       TIMESTAMPTZ DEFAULT NOW(),
    config_snapshot     JSONB  -- stores the calibration config used
);

CREATE INDEX IF NOT EXISTS opp_scores_municipio_idx ON opportunity_scores (municipio_id);
CREATE INDEX IF NOT EXISTS opp_scores_score_idx ON opportunity_scores (score DESC);

-- View: latest score per municipio
CREATE OR REPLACE VIEW latest_opportunity_scores AS
SELECT DISTINCT ON (municipio_id)
    os.*,
    m.name AS municipio_name,
    m.department,
    m.population,
    ST_AsGeoJSON(m.centroid)::jsonb AS centroid_geojson
FROM opportunity_scores os
JOIN municipios m ON m.id = os.municipio_id
ORDER BY municipio_id, calculated_at DESC;

-- ============================================================
-- CALIBRATION_CONFIG: Admin-adjustable scoring weights
-- ============================================================
CREATE TABLE IF NOT EXISTS calibration_config (
    id                          SERIAL PRIMARY KEY,
    name                        VARCHAR(100) DEFAULT 'real-data-v2',
    -- Factor weights (must sum to 1.0)
    -- Calibrated for real government data: INE ENCOVI poverty + Banguat remittances
    -- drive socioeconomic at the municipio level, justifying a higher weight.
    weight_population           DECIMAL(4, 2) DEFAULT 0.28,
    weight_mobility             DECIMAL(4, 2) DEFAULT 0.22,
    weight_commercial           DECIMAL(4, 2) DEFAULT 0.22,
    weight_competition          DECIMAL(4, 2) DEFAULT 0.15,
    weight_socioeconomic        DECIMAL(4, 2) DEFAULT 0.13,
    -- Population thresholds per format
    despensa_familiar_min_pop   INTEGER DEFAULT 24000,
    maxi_despensa_min_pop       INTEGER DEFAULT 55000,
    -- Override conditions
    mobility_override_threshold DECIMAL(4, 2) DEFAULT 0.80,
    commercial_override_threshold DECIMAL(4, 2) DEFAULT 0.85,
    is_active                   BOOLEAN DEFAULT TRUE,
    created_at                  TIMESTAMPTZ DEFAULT NOW(),
    updated_at                  TIMESTAMPTZ DEFAULT NOW()
);

-- Insert default calibration config (weights tuned for real government data sources)
INSERT INTO calibration_config (name) VALUES ('real-data-v2')
ON CONFLICT DO NOTHING;

-- ============================================================
-- OSM_REFRESH_LOG: Track when OSM data was last pulled
-- ============================================================
CREATE TABLE IF NOT EXISTS osm_refresh_log (
    id          SERIAL PRIMARY KEY,
    query_type  VARCHAR(100) NOT NULL,
    records_fetched INTEGER,
    duration_ms INTEGER,
    status      VARCHAR(20) DEFAULT 'success',
    error_msg   TEXT,
    executed_at TIMESTAMPTZ DEFAULT NOW()
);

-- ============================================================
-- Indexes on geometry columns for stores
-- ============================================================
CREATE INDEX IF NOT EXISTS stores_geometry_idx ON stores USING GIST (geometry);
CREATE INDEX IF NOT EXISTS stores_format_idx ON stores (format);
CREATE INDEX IF NOT EXISTS stores_status_idx ON stores (status);

COMMENT ON TABLE stores IS 'Our own store locations (Despensa Familiar, Maxi Despensa, Walmart, Paiz)';
COMMENT ON TABLE municipios IS 'Guatemala administrative municipio boundaries with population data';
COMMENT ON TABLE competitors IS 'Competitor supermarket locations (Super del Barrio, Suma, La Bodegona, etc.)';
COMMENT ON TABLE opportunity_scores IS 'Computed composite opportunity scores per municipio';
COMMENT ON TABLE calibration_config IS 'Admin-adjustable scoring weights and thresholds';

-- ============================================================
-- NTL_SETTLEMENTS: Sub-municipio lit settlements from VIIRS nighttime lights
-- Source: VIIRS DNB annual composite (synthetic seed; replace with real VIIRS GeoTIFF extract)
--
-- Population estimate formula (INE Guatemala Censo 2018):
--   estimated_pop = ROUND(radiance_ntl x ntl_calib_k x ntl_household_size)
--   where ntl_calib_k      = 180 (households per nW/cm2/sr unit)
--         ntl_household_size = 4.2 (avg persons per household, INE 2018)
--   -> estimated_pop ~ ROUND(radiance_ntl x 756)
-- ============================================================
CREATE TABLE IF NOT EXISTS ntl_settlements (
    id              SERIAL PRIMARY KEY,
    name            VARCHAR(255) NOT NULL,
    municipio_id    INTEGER REFERENCES municipios(id) ON DELETE SET NULL,
    lat             DECIMAL(10, 7) NOT NULL,
    lng             DECIMAL(10, 7) NOT NULL,
    geometry        GEOMETRY(Point, 4326),
    radiance_ntl    DECIMAL(8, 3) NOT NULL CHECK (radiance_ntl >= 0),
    estimated_pop   INTEGER,
    area_km2        DECIMAL(8, 3),
    ntl_source      VARCHAR(50) DEFAULT 'synthetic',
    created_at      TIMESTAMPTZ DEFAULT NOW()
);

CREATE OR REPLACE FUNCTION update_ntl_settlement_geometry()
RETURNS TRIGGER AS $$
BEGIN
    NEW.geometry = ST_SetSRID(ST_MakePoint(NEW.lng, NEW.lat), 4326);
    RETURN NEW;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS ntl_settlements_geometry_trigger ON ntl_settlements;
CREATE TRIGGER ntl_settlements_geometry_trigger
    BEFORE INSERT OR UPDATE ON ntl_settlements
    FOR EACH ROW EXECUTE FUNCTION update_ntl_settlement_geometry();

CREATE INDEX IF NOT EXISTS ntl_settlements_geometry_idx  ON ntl_settlements USING GIST (geometry);
CREATE INDEX IF NOT EXISTS ntl_settlements_municipio_idx ON ntl_settlements (municipio_id);
CREATE INDEX IF NOT EXISTS ntl_settlements_radiance_idx  ON ntl_settlements (radiance_ntl DESC);

COMMENT ON TABLE ntl_settlements IS 'Sub-municipio lit settlement clusters from VIIRS DNB nighttime lights. estimated_pop = ROUND(radiance_ntl x 756) using INE 2018 household size (4.2) x calibration constant (180 hh/unit).';

-- ============================================================
-- SCHEMA MIGRATIONS (idempotent ALTER TABLE additions)
-- ============================================================

-- Allow 'google_places' as a valid source for competitors (Google Places sync)
ALTER TABLE competitors
  DROP CONSTRAINT IF EXISTS competitors_source_check;
ALTER TABLE competitors
  ADD CONSTRAINT competitors_source_check
    CHECK (source IN ('osm', 'manual', 'import', 'google_places'));

-- Google Places POI source tracking on poi_cache
ALTER TABLE poi_cache
  ADD COLUMN IF NOT EXISTS source VARCHAR(30) DEFAULT 'osm';

-- Google Distance Matrix drive time from each municipio centroid to Guatemala City
ALTER TABLE municipios
  ADD COLUMN IF NOT EXISTS drive_time_capital_min INTEGER;

CREATE INDEX IF NOT EXISTS municipios_drive_time_idx ON municipios (drive_time_capital_min)
  WHERE drive_time_capital_min IS NOT NULL;

COMMENT ON COLUMN municipios.drive_time_capital_min IS
  'Estimated drive time in minutes from this municipio centroid to Guatemala City (14.6349,-90.5069) via Google Distance Matrix API.';

COMMENT ON COLUMN poi_cache.source IS
  'Data source: ''osm'' (OpenStreetMap/Overpass), ''google_places'' (Google Places API).';

-- ============================================================
-- MUNICIPIO_ISOCHRONES: Drive-time polygons from Mapbox API
--
-- Pre-computed isochrone polygons for each Guatemala municipio
-- centroid. Used by the scoring engine to replace straight-line
-- ST_DWithin radius queries with drive-time polygon queries.
--
-- Profile: mapbox/driving
-- Contours: 15 / 30 / 45 minutes
-- One Mapbox request returns all 3 contours per municipio.
-- 334 municipios × 1 request = 334 API calls (free tier: 75k/month).
-- ============================================================
CREATE TABLE IF NOT EXISTS municipio_isochrones (
    id               SERIAL PRIMARY KEY,
    municipio_id     INTEGER NOT NULL REFERENCES municipios(id) ON DELETE CASCADE,

    -- Travel profile and contour duration
    profile          VARCHAR(50) NOT NULL DEFAULT 'mapbox/driving',
    contour_minutes  INTEGER NOT NULL CHECK (contour_minutes IN (15, 30, 45)),

    -- The isochrone polygon (Mapbox returns GeoJSON — stored as GEOMETRY for fast ST_Intersects)
    geometry         GEOMETRY(MultiPolygon, 4326) NOT NULL,

    -- Source metadata
    mapbox_model     VARCHAR(50),
    fetched_at       TIMESTAMPTZ DEFAULT NOW(),

    -- Bounding box columns for fast bbox pre-filter before ST_Intersects
    bbox_west        DECIMAL(10, 7),
    bbox_east        DECIMAL(10, 7),
    bbox_south       DECIMAL(10, 7),
    bbox_north       DECIMAL(10, 7),

    UNIQUE (municipio_id, profile, contour_minutes)
);

-- Primary spatial index (used by ST_Intersects in scoring queries)
CREATE INDEX IF NOT EXISTS municipio_isochrones_geometry_idx
    ON municipio_isochrones USING GIST (geometry);

-- Lookup index: find all isochrones for a given municipio quickly
CREATE INDEX IF NOT EXISTS municipio_isochrones_municipio_idx
    ON municipio_isochrones (municipio_id);

-- Compound index: profile + contour for the exact query shape used in scoring
CREATE INDEX IF NOT EXISTS municipio_isochrones_profile_contour_idx
    ON municipio_isochrones (profile, contour_minutes);

COMMENT ON TABLE municipio_isochrones IS
  'Drive-time isochrone polygons fetched from Mapbox Isochrone API for each '
  'Guatemala municipio centroid. Used by the scoring engine to replace straight-'
  'line ST_DWithin radius queries with drive-time polygon queries. '
  'Profile: mapbox/driving. Contours: 15/30/45 minutes.';
