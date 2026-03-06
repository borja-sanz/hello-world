export interface Store {
  id: number;
  name: string;
  format: 'Despensa Familiar' | 'Maxi Despensa' | 'Walmart' | 'Paiz' | 'Other';
  chain: string | null;
  lat: number;
  lng: number;
  status: 'open' | 'planned' | 'closed' | 'under_construction';
  department: string | null;
  municipio: string | null;
  performance: 'success' | 'on-plan' | 'underperforming' | null;
}

export interface Competitor {
  id: number;
  name: string;
  chain: string;
  lat: number;
  lng: number;
  verified: boolean;
  source: string;
}

export interface Municipio {
  id: number;
  name: string;
  department: string;
  population: number | null;
  lat: number;
  lng: number;
  is_urban: boolean;
  centroid_geojson?: object;
}

export interface FactorScores {
  population: number;
  mobility: number;
  commercial: number;
  competition: number;
  socioeconomic: number;
}

export interface OpportunityScore {
  municipio_id: number;
  municipio_name: string;
  department: string;
  population: number | null;
  score: number;
  pop_score: number;
  mobility_score: number;
  commercial_score: number;
  competition_score: number;
  socioeconomic_score: number;
  recommendation: 'GO' | 'CAUTION' | 'NO-GO';
  suggested_format: string | null;
  reasoning: string;
  nearest_store_km: number | null;
  centroid?: { lat: number; lng: number };
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

export interface TradeAreaAnalysis {
  center: { lat: number; lng: number };
  municipio_name: string | null;
  municipio_population: number | null;
  score: number;
  factors: FactorScores;
  recommendation: 'GO' | 'CAUTION' | 'NO-GO';
  suggested_format: string | null;
  reasoning: string;
  rings: TradeAreaRing[];
}

export interface LayerState {
  stores: boolean;
  competitors: boolean;
  opportunities: boolean;
  heatmap: boolean;
}

export interface FilterState {
  minPopulation: number;
  minScore: number;
  storeFormat: string;
  showOnlyGo: boolean;
  blueOcean: boolean;
}

export interface NtlSettlement {
  id: number;
  name: string;
  lat: number;
  lng: number;
  radiance_ntl: number;
  estimated_pop: number | null;
  area_km2: number | null;
  ntl_source: string;
  municipio_id: number | null;
  municipio_name?: string;
  department?: string;
  dist_from_center_km?: number;
  // Enriched by sub-municipio scoring endpoint when available
  score?: number;
  recommendation?: 'GO' | 'CAUTION' | 'NO-GO';
  suggested_format?: string | null;
  factors?: { population: number; mobility: number; commercial: number; competition: number; socioeconomic: number };
}

export interface NtlSettlementsResponse {
  municipio_id: number;
  municipio_name: string;
  radius_km: number;
  count: number;
  calibration: {
    calib_k: number;
    household_size: number;
    formula: string;
    note: string;
  };
  settlements: NtlSettlement[];
}

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
