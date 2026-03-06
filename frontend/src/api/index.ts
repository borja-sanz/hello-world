import axios from 'axios';
import type {
  Store, Competitor, Municipio, OpportunityScore, SettlementScore,
  TradeAreaAnalysis, CalibrationConfig, NtlSettlementsResponse, PoiCluster,
} from '../types';

// In production (Render), VITE_API_URL is set to '' so requests go to
// the same domain. In development it falls back to localhost:4000.
const api = axios.create({
  baseURL: import.meta.env.VITE_API_URL ?? 'http://localhost:4000',
  timeout: 30_000,
});

// ─── Stores ───────────────────────────────────────────────────────────────────

export const fetchStores = async (params?: {
  format?: string; status?: string;
}): Promise<Store[]> => {
  const { data } = await api.get('/api/stores', { params });
  return data.stores;
};

export const fetchStoresGeoJSON = async () => {
  const { data } = await api.get('/api/stores/geojson');
  return data;
};

export const createStore = async (body: Partial<Store>) => {
  const { data } = await api.post('/api/stores', body);
  return data;
};

export const importStoresCsv = async (file: File) => {
  const form = new FormData();
  form.append('file', file);
  const { data } = await api.post('/api/stores/import', form);
  return data;
};

export const importCompetitorsCsv = async (file: File) => {
  const form = new FormData();
  form.append('file', file);
  const { data } = await api.post('/api/competitors/import', form);
  return data;
};

export const fetchStoreSummary = async () => {
  const { data } = await api.get('/api/admin/stores/summary');
  return data as { formats: { format: string; total: string; open: string; planned: string; closed: string }[]; total: number };
};

export const clearAllStores = async () => {
  const { data } = await api.delete('/api/admin/stores/all', { data: { confirm: 'BORRAR' } });
  return data as { deleted: number };
};

export const clearAllCompetitors = async () => {
  const { data } = await api.delete('/api/admin/competitors/all', { data: { confirm: 'BORRAR' } });
  return data as { deleted: number };
};

export const reclaimOwnStores = async () => {
  const { data } = await api.post('/api/admin/reclaim-own-stores');
  return data as { moved: number; message: string };
};

export const fixStoreFormats = async () => {
  const { data } = await api.post('/api/admin/fix-store-formats');
  return data as { fixed: number; message: string; stores: { id: number; name: string; format: string }[] };
};

export const seedGuatemalaZones = async () => {
  const { data } = await api.post('/api/admin/seed-guatemala-zones');
  return data as { inserted: number; message: string };
};

export const refreshNtlSettlements = async () => {
  const { data } = await api.post('/api/admin/refresh-ntl-settlements');
  return data as { inserted: number; total: number; source: string; message: string };
};

export const tagStorePerformance = async (
  id: number, performance: string
) => {
  const { data } = await api.patch(`/api/stores/${id}/performance`, { performance });
  return data as Store;
};

// ─── Competitors ──────────────────────────────────────────────────────────────

export const fetchCompetitors = async (): Promise<Competitor[]> => {
  const { data } = await api.get('/api/competitors');
  return data.competitors;
};

export const fetchCompetitorsGeoJSON = async () => {
  const { data } = await api.get('/api/competitors/geojson');
  return data;
};

export const fetchCompetitorChains = async (): Promise<{ chain: string; count: number }[]> => {
  const { data } = await api.get('/api/competitors/chains');
  return data;
};

// ─── Municipios ───────────────────────────────────────────────────────────────

export const fetchMunicipios = async (): Promise<Municipio[]> => {
  const { data } = await api.get('/api/municipios');
  return data.municipios;
};

export const fetchMunicipiosGeoJSON = async () => {
  const { data } = await api.get('/api/municipios/geojson');
  return data;
};

export const fetchSettlementOpportunities = async (params?: {
  limit?: number; min_pop?: number;
}): Promise<{ count: number; settlements: SettlementScore[] }> => {
  const { data } = await api.get('/api/scoring/settlements', { params });
  return data;
};

// ─── Scoring ──────────────────────────────────────────────────────────────────

export const fetchOpportunities = async (params?: {
  limit?: number; min_score?: number; min_population?: number;
}): Promise<{ opportunities: OpportunityScore[]; cached: boolean }> => {
  const { data } = await api.get('/api/scoring/municipios', { params });
  return data;
};

export const fetchBlueOceanOpportunities = async (params?: {
  min_population?: number; min_nearest_store_km?: number; limit?: number;
}): Promise<{ opportunities: OpportunityScore[]; count: number }> => {
  const { data } = await api.get('/api/scoring/blue-ocean', { params });
  return data;
};

export const scorePoint = async (lat: number, lng: number) => {
  const { data } = await api.post('/api/scoring/point', { lat, lng });
  return data;
};

export const analyzeTradeArea = async (
  lat: number, lng: number
): Promise<TradeAreaAnalysis> => {
  const { data } = await api.post('/api/scoring/trade-area', { lat, lng });
  return data;
};

export const calculateAllScores = async () => {
  const { data } = await api.post('/api/scoring/calculate-all');
  return data;
};

// ─── Admin / Calibration ──────────────────────────────────────────────────────

export const fetchCalibrationConfig = async (): Promise<CalibrationConfig> => {
  const { data } = await api.get('/api/admin/config');
  return data;
};

export const updateCalibrationConfig = async (config: Partial<CalibrationConfig>) => {
  const { data } = await api.put('/api/admin/config', config);
  return data;
};

export const resetCalibrationConfig = async () => {
  const { data } = await api.post('/api/admin/config/reset');
  return data;
};

export const recalculateAllScores = async () => {
  const { data } = await api.post('/api/admin/recalculate');
  return data;
};

export const fetchAdminStats = async () => {
  const { data } = await api.get('/api/admin/stats');
  return data;
};

// ─── Google Places ────────────────────────────────────────────────────────────

export const fetchGooglePlacesChains = async () => {
  const { data } = await api.get('/api/admin/google-places/chains');
  return data as { chains: { chain: string; query: string }[] };
};

export const syncAllGooglePlacesCompetitors = async (apiKey: string) => {
  const { data } = await api.post('/api/admin/google-places/sync', { api_key: apiKey });
  return data as { message: string; status: string };
};

export const syncGooglePlacesChain = async (apiKey: string, chain: string) => {
  const { data } = await api.post('/api/admin/google-places/sync-chain', { api_key: apiKey, chain });
  return data as { chain: string; found: number; inserted: number; skipped: number; error?: string };
};

// ─── NTL (Nighttime Lights) ───────────────────────────────────────────────────

export const fetchNtlSettlements = async (
  municipio_id: number
): Promise<NtlSettlementsResponse> => {
  const { data } = await api.get('/api/ntl/settlements', { params: { municipio_id } });
  return data;
};

export const fetchNtlSettlementsTop = async (limit = 50): Promise<NtlSettlementsResponse> => {
  const { data } = await api.get('/api/ntl/settlements/top', { params: { limit } });
  return data;
};

export const fetchSubMunicipioScores = async (
  municipioId: number, params?: { limit?: number; min_pop?: number }
): Promise<{ municipio_id: number; count: number; settlements: import('../types').NtlSettlement[] }> => {
  const { data } = await api.get(`/api/scoring/sub-municipio/${municipioId}`, { params });
  return data;
};

export const fetchPoiClusters = async (
  municipioId: number
): Promise<{ municipio_id: number; count: number; clusters: PoiCluster[] }> => {
  const { data } = await api.get(`/api/scoring/poi-clusters/${municipioId}`);
  return data;
};

// ─── Google Places POIs ───────────────────────────────────────────────────────

export const fetchPoiStatus = async () => {
  const { data } = await api.get('/api/pois/status');
  return data as {
    total: number;
    by_type: Record<string, number>;
    drive_time_coverage: number;
    recent_refreshes: { query_type: string; records_fetched: number; executed_at: string }[];
  };
};

export const refreshGooglePois = async (apiKey: string) => {
  const { data } = await api.post('/api/pois/refresh/pois', { api_key: apiKey });
  return data as { message: string };
};

export const refreshMercados = async (apiKey: string) => {
  const { data } = await api.post('/api/pois/refresh/mercados', { api_key: apiKey });
  return data as { message: string };
};

export const refreshDriveTimes = async (apiKey: string) => {
  const { data } = await api.post('/api/pois/refresh/drive-times', { api_key: apiKey });
  return data as { message: string };
};

export const refreshAllGooglePois = async (apiKey: string) => {
  const { data } = await api.post('/api/pois/refresh/all', { api_key: apiKey });
  return data as { message: string };
};

// ─── OSM (kept for backward-compat; UI now uses /api/pois) ───────────────────

export const fetchOsmStatus = async () => {
  const { data } = await api.get('/api/osm/status');
  return data;
};

export const refreshOsmAll = async () => {
  const { data } = await api.post('/api/osm/refresh/all');
  return data;
};

export default api;
