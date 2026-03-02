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
    osm_id          BIGINT,
    verified        BOOLEAN DEFAULT FALSE,
    source          VARCHAR(50) DEFAULT 'osm' CHECK (source IN ('osm', 'manual', 'import')),
    address         TEXT,
    municipio       VARCHAR(100),
    department      VARCHAR(100),
    notes           TEXT,
    created_at      TIMESTAMPTZ DEFAULT NOW(),
    updated_at      TIMESTAMPTZ DEFAULT NOW()
);

CREATE OR REPLACE FUNCTION update_competitor_geometry()
RETURNS TRIGGER AS $$
BEGIN
    NEW.geometry = ST_SetSRID(ST_MakePoint(NEW.lng, NEW.lat), 4326);
    NEW.updated_at = NOW();
    RETURN NEW;
END;
$$ LANGUAGE plpgsql;

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
    name            VARCHAR(255),
    poi_type        VARCHAR(100) NOT NULL,
    lat             DECIMAL(10, 7) NOT NULL,
    lng             DECIMAL(10, 7) NOT NULL,
    geometry        GEOMETRY(Point, 4326),
    tags            JSONB,
    municipio_id    INTEGER REFERENCES municipios(id),
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
    weight_population   DECIMAL(4, 2) DEFAULT 0.30,
    weight_mobility     DECIMAL(4, 2) DEFAULT 0.25,
    weight_commercial   DECIMAL(4, 2) DEFAULT 0.25,
    weight_competition  DECIMAL(4, 2) DEFAULT 0.15,
    weight_socioeconomic DECIMAL(4, 2) DEFAULT 0.05,
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
    name                        VARCHAR(100) DEFAULT 'default',
    -- Factor weights (must sum to 1.0)
    weight_population           DECIMAL(4, 2) DEFAULT 0.30,
    weight_mobility             DECIMAL(4, 2) DEFAULT 0.25,
    weight_commercial           DECIMAL(4, 2) DEFAULT 0.25,
    weight_competition          DECIMAL(4, 2) DEFAULT 0.15,
    weight_socioeconomic        DECIMAL(4, 2) DEFAULT 0.05,
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

-- Insert default calibration config
INSERT INTO calibration_config (name) VALUES ('default')
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
