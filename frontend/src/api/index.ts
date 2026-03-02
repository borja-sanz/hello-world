import axios from 'axios';
import type {
  Store, Competitor, Municipio, OpportunityScore,
  TradeAreaAnalysis, CalibrationConfig,
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

// ─── Municipios ───────────────────────────────────────────────────────────────

export const fetchMunicipios = async (): Promise<Municipio[]> => {
  const { data } = await api.get('/api/municipios');
  return data.municipios;
};

export const fetchMunicipiosGeoJSON = async () => {
  const { data } = await api.get('/api/municipios/geojson');
  return data;
};

// ─── Scoring ──────────────────────────────────────────────────────────────────

export const fetchOpportunities = async (params?: {
  limit?: number; min_score?: number; min_population?: number;
}): Promise<{ opportunities: OpportunityScore[]; cached: boolean }> => {
  const { data } = await api.get('/api/scoring/municipios', { params });
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

// ─── OSM ─────────────────────────────────────────────────────────────────────

export const fetchOsmStatus = async () => {
  const { data } = await api.get('/api/osm/status');
  return data;
};

export const refreshOsmAll = async () => {
  const { data } = await api.post('/api/osm/refresh/all');
  return data;
};

export default api;
