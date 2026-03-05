import React, { useState, useEffect, useCallback, useRef } from 'react';
import {
  fetchCalibrationConfig, updateCalibrationConfig,
  resetCalibrationConfig, recalculateAllScores,
  fetchAdminStats, fetchOsmStatus, refreshOsmAll,
  fetchStoreSummary, clearAllStores, importStoresCsv,
} from '../api';
import type { CalibrationConfig } from '../types';

interface Props { onClose: () => void; }

interface StoreSummary {
  formats: { format: string; total: string; open: string; planned: string; closed: string }[];
  total: number;
}

interface ImportResult {
  inserted?: number;
  skipped?: number;
  validation_errors?: string[];
  error?: string;
}

const FORMAT_COLORS: Record<string, string> = {
  'Despensa Familiar': '#16a34a',
  'Maxi Despensa':     '#2563eb',
  'Walmart':           '#0891b2',
  'Paiz':              '#7c3aed',
  'Other':             '#6b7280',
};

const AdminPanel: React.FC<Props> = ({ onClose }) => {
  const [config,        setConfig]        = useState<CalibrationConfig | null>(null);
  const [stats,         setStats]         = useState<any>(null);
  const [osmStatus,     setOsm]           = useState<any>(null);
  const [storeSummary,  setStoreSummary]  = useState<StoreSummary | null>(null);
  const [saving,        setSaving]        = useState(false);
  const [importing,     setImporting]     = useState(false);
  const [importResult,  setImportResult]  = useState<ImportResult | null>(null);
  const [msg,           setMsg]           = useState('');
  const [tab,           setTab]           = useState<'weights' | 'thresholds' | 'stores' | 'system'>('weights');
  const fileInputRef = useRef<HTMLInputElement>(null);

  const load = useCallback(async () => {
    try {
      const [c, s, o, ss] = await Promise.all([
        fetchCalibrationConfig(),
        fetchAdminStats(),
        fetchOsmStatus().catch(() => null),
        fetchStoreSummary().catch(() => null),
      ]);
      setConfig(c); setStats(s); setOsm(o); setStoreSummary(ss);
    } catch {
      setMsg('Error cargando configuración');
    }
  }, []);

  useEffect(() => { load(); }, [load]);

  const handleSave = async () => {
    if (!config) return;
    setSaving(true);
    try {
      await updateCalibrationConfig(config);
      setMsg('✅ Guardado correctamente');
    } catch (e: any) {
      setMsg(`❌ ${e.response?.data?.error ?? 'Error al guardar'}`);
    } finally {
      setSaving(false);
    }
  };

  const handleReset = async () => {
    if (!confirm('¿Restaurar pesos calibrados (real-data-v2)?')) return;
    try {
      const { config: c } = await resetCalibrationConfig();
      setConfig(c);
      setMsg('✅ Restaurado a real-data-v2');
    } catch { setMsg('❌ Error'); }
  };

  const handleRecalculate = async () => {
    try {
      setMsg('⏳ Recalculando (puede tardar ~60s)…');
      await recalculateAllScores();
      setMsg('✅ Recálculo iniciado');
    } catch { setMsg('❌ Error'); }
  };

  const handleOsmRefresh = async () => {
    try {
      setMsg('⏳ Actualizando datos OSM (~2 min)…');
      await refreshOsmAll();
      setMsg('✅ Actualización OSM iniciada');
    } catch { setMsg('❌ Error'); }
  };

  const handleImport = async (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (!file) return;
    setImporting(true);
    setImportResult(null);
    try {
      const result = await importStoresCsv(file);
      setImportResult(result);
      await load();
    } catch (e: any) {
      setImportResult({ error: e.response?.data?.error ?? 'Error al importar' });
    } finally {
      setImporting(false);
      if (fileInputRef.current) fileInputRef.current.value = '';
    }
  };

  const handleClearStores = async () => {
    const count = storeSummary?.total ?? stats?.store_count ?? '?';
    if (!confirm(`¿Eliminar las ${count} tiendas actuales? Esta acción no se puede deshacer.\n\nUsa esta opción antes de importar tu red real.`)) return;
    try {
      const res = await clearAllStores();
      setMsg(`✅ ${res.deleted} tiendas eliminadas`);
      setImportResult(null);
      await load();
    } catch { setMsg('❌ Error al eliminar tiendas'); }
  };

  if (!config) {
    return (
      <div className="fixed inset-0 bg-black/50 z-[2000] flex items-center justify-center">
        <div className="bg-white dark:bg-gray-800 rounded-xl p-8">Cargando…</div>
      </div>
    );
  }

  const totalWeight = (
    config.weight_population + config.weight_mobility + config.weight_commercial +
    config.weight_competition + config.weight_socioeconomic
  );
  const weightOk = Math.abs(totalWeight - 1.0) < 0.01;

  // Labels without hardcoded percentages — the slider shows the live value
  const WEIGHTS: { key: keyof CalibrationConfig; label: string; color: string }[] = [
    { key: 'weight_population',    label: 'Población',          color: '#3b82f6' },
    { key: 'weight_mobility',      label: 'Movilidad',          color: '#8b5cf6' },
    { key: 'weight_commercial',    label: 'Densidad Comercial', color: '#f97316' },
    { key: 'weight_competition',   label: 'Competencia',        color: '#14b8a6' },
    { key: 'weight_socioeconomic', label: 'Socioeconómico',     color: '#ec4899' },
  ];

  return (
    <div className="fixed inset-0 bg-black/50 z-[2000] flex items-center justify-center p-4">
      <div className="bg-white dark:bg-gray-800 rounded-xl shadow-2xl w-full max-w-xl max-h-[90vh]
                      flex flex-col overflow-hidden">
        {/* Header */}
        <div className="flex items-center justify-between px-5 py-4 border-b border-gray-200 dark:border-gray-700">
          <div>
            <h2 className="text-lg font-bold text-gray-800 dark:text-gray-100">Panel de Calibración</h2>
            <p className="text-xs text-gray-400">Ajuste de pesos, umbrales y datos de tiendas</p>
          </div>
          <button onClick={onClose} className="text-gray-400 hover:text-gray-600 text-2xl leading-none">×</button>
        </div>

        {/* Tabs */}
        <div className="flex border-b border-gray-200 dark:border-gray-700 overflow-x-auto">
          {([
            ['weights',    'Pesos'],
            ['thresholds', 'Umbrales'],
            ['stores',     'Tiendas'],
            ['system',     'Sistema'],
          ] as const).map(([t, label]) => (
            <button key={t} onClick={() => setTab(t)}
              className={`px-4 py-2.5 text-sm font-medium border-b-2 whitespace-nowrap transition-colors ${
                tab === t
                  ? 'border-brand-600 text-brand-600'
                  : 'border-transparent text-gray-500 hover:text-gray-700 dark:text-gray-400'
              }`}>
              {label}
            </button>
          ))}
        </div>

        {/* Content */}
        <div className="flex-1 overflow-y-auto p-5">

          {/* ── Weights tab ── */}
          {tab === 'weights' && (
            <div className="space-y-5">
              <div className={`text-xs px-3 py-1.5 rounded-full text-center font-medium ${
                weightOk ? 'bg-green-100 text-green-700' : 'bg-red-100 text-red-700'
              }`}>
                Suma de pesos: {(totalWeight * 100).toFixed(0)}% {weightOk ? '✓' : '— debe ser 100%'}
              </div>

              {WEIGHTS.map(({ key, label, color }) => (
                <div key={key}>
                  <div className="flex justify-between text-sm mb-1.5">
                    <span className="font-medium text-gray-700 dark:text-gray-300">{label}</span>
                    <span className="font-bold tabular-nums" style={{ color }}>
                      {((config[key] as number) * 100).toFixed(0)}%
                    </span>
                  </div>
                  <input
                    type="range" min={0} max={0.6} step={0.01}
                    value={config[key] as number}
                    onChange={e => setConfig({ ...config, [key]: Number(e.target.value) })}
                    className="w-full h-2"
                    style={{ accentColor: color }}
                  />
                </div>
              ))}

              <p className="text-xs text-gray-400">
                Valores por defecto (real-data-v2): Población 28%, Movilidad 22%, Comercial 22%, Competencia 15%, Socioeconómico 13%
              </p>
            </div>
          )}

          {/* ── Thresholds tab ── */}
          {tab === 'thresholds' && (
            <div className="space-y-5">
              <div>
                <label className="block text-sm font-medium text-gray-700 dark:text-gray-300 mb-1">
                  Umbral Despensa Familiar (personas)
                </label>
                <div className="flex items-center gap-3">
                  <input
                    type="number" min={5000} max={100000} step={1000}
                    value={config.despensa_familiar_min_pop}
                    onChange={e => setConfig({ ...config, despensa_familiar_min_pop: Number(e.target.value) })}
                    className="flex-1 border border-gray-300 dark:border-gray-600 rounded-lg px-3 py-2 text-sm
                               bg-white dark:bg-gray-700 text-gray-800 dark:text-gray-200"
                  />
                  <span className="text-sm text-gray-400">{(config.despensa_familiar_min_pop / 1000).toFixed(0)}k</span>
                </div>
              </div>

              <div>
                <label className="block text-sm font-medium text-gray-700 dark:text-gray-300 mb-1">
                  Umbral Maxi Despensa (personas)
                </label>
                <div className="flex items-center gap-3">
                  <input
                    type="number" min={10000} max={200000} step={5000}
                    value={config.maxi_despensa_min_pop}
                    onChange={e => setConfig({ ...config, maxi_despensa_min_pop: Number(e.target.value) })}
                    className="flex-1 border border-gray-300 dark:border-gray-600 rounded-lg px-3 py-2 text-sm
                               bg-white dark:bg-gray-700 text-gray-800 dark:text-gray-200"
                  />
                  <span className="text-sm text-gray-400">{(config.maxi_despensa_min_pop / 1000).toFixed(0)}k</span>
                </div>
              </div>

              <div>
                <label className="block text-sm font-medium text-gray-700 dark:text-gray-300 mb-1.5">
                  Override movilidad → Maxi Despensa ({(config.mobility_override_threshold * 100).toFixed(0)}%)
                </label>
                <input
                  type="range" min={0.5} max={1.0} step={0.05}
                  value={config.mobility_override_threshold}
                  onChange={e => setConfig({ ...config, mobility_override_threshold: Number(e.target.value) })}
                  className="w-full h-2 accent-purple-600"
                />
                <p className="text-xs text-gray-400 mt-1">
                  Si movilidad ≥ este umbral, se recomienda Maxi aunque la población sea menor
                </p>
              </div>

              <div>
                <label className="block text-sm font-medium text-gray-700 dark:text-gray-300 mb-1.5">
                  Override comercio → Maxi Despensa ({(config.commercial_override_threshold * 100).toFixed(0)}%)
                </label>
                <input
                  type="range" min={0.5} max={1.0} step={0.05}
                  value={config.commercial_override_threshold}
                  onChange={e => setConfig({ ...config, commercial_override_threshold: Number(e.target.value) })}
                  className="w-full h-2 accent-orange-600"
                />
              </div>
            </div>
          )}

          {/* ── Stores tab ── */}
          {tab === 'stores' && (
            <div className="space-y-5">

              {/* Format breakdown */}
              {storeSummary && storeSummary.formats.length > 0 ? (
                <div>
                  <p className="text-xs font-medium text-gray-500 uppercase tracking-wide mb-2">
                    Red actual — {storeSummary.total} tiendas
                  </p>
                  <div className="grid grid-cols-2 gap-2">
                    {storeSummary.formats.map(f => (
                      <div key={f.format}
                           className="rounded-lg p-3 border-l-4"
                           style={{ borderColor: FORMAT_COLORS[f.format] ?? '#6b7280',
                                    backgroundColor: `${FORMAT_COLORS[f.format] ?? '#6b7280'}12` }}>
                        <div className="text-xl font-bold text-gray-800 dark:text-gray-100">{f.total}</div>
                        <div className="text-xs font-medium text-gray-600 dark:text-gray-300">{f.format}</div>
                        <div className="text-xs text-gray-400">
                          {f.open} abiertas · {f.planned} planificadas
                        </div>
                      </div>
                    ))}
                  </div>
                </div>
              ) : (
                <div className="text-sm text-gray-400 text-center py-4">
                  No hay tiendas en la base de datos
                </div>
              )}

              {/* CSV Import */}
              <div className="border border-dashed border-gray-300 dark:border-gray-600 rounded-lg p-4 space-y-3">
                <p className="text-sm font-medium text-gray-700 dark:text-gray-300">
                  Importar tiendas desde CSV
                </p>
                <div className="text-xs text-gray-500 bg-gray-50 dark:bg-gray-700/50 rounded p-2 font-mono leading-relaxed">
                  <div className="font-semibold text-gray-600 dark:text-gray-400 mb-1">Columnas requeridas:</div>
                  store_name, format, lat, lng<br/>
                  <div className="font-semibold text-gray-600 dark:text-gray-400 mt-1 mb-1">Columnas opcionales:</div>
                  status, department, municipio, open_date, notes<br/>
                  <div className="font-semibold text-gray-600 dark:text-gray-400 mt-1 mb-1">Formatos válidos:</div>
                  Despensa Familiar · Maxi Despensa · Walmart · Paiz
                </div>
                <label className={`flex items-center justify-center gap-2 w-full py-2 px-4 rounded-lg border
                                  text-sm font-medium cursor-pointer transition-colors
                                  ${importing
                                    ? 'bg-gray-100 text-gray-400 border-gray-200 cursor-not-allowed'
                                    : 'bg-brand-50 hover:bg-brand-100 text-brand-700 border-brand-300 dark:bg-brand-900/20 dark:text-brand-400 dark:border-brand-700'
                                  }`}>
                  {importing ? '⏳ Importando…' : '📂 Seleccionar archivo CSV'}
                  <input
                    ref={fileInputRef}
                    type="file" accept=".csv" className="hidden"
                    onChange={handleImport} disabled={importing}
                  />
                </label>

                {importResult && (
                  <div className={`text-sm p-3 rounded-lg ${
                    importResult.error
                      ? 'bg-red-50 dark:bg-red-900/20 text-red-700 dark:text-red-400'
                      : 'bg-green-50 dark:bg-green-900/20 text-green-700 dark:text-green-400'
                  }`}>
                    {importResult.error ? (
                      <>❌ {importResult.error}</>
                    ) : (
                      <>
                        ✅ {importResult.inserted} tiendas importadas
                        {(importResult.skipped ?? 0) > 0 && `, ${importResult.skipped} omitidas`}
                        {(importResult.validation_errors?.length ?? 0) > 0 && (
                          <ul className="mt-1 text-xs opacity-80 list-disc list-inside">
                            {importResult.validation_errors!.slice(0, 5).map((e, i) => <li key={i}>{e}</li>)}
                            {importResult.validation_errors!.length > 5 && (
                              <li>…y {importResult.validation_errors!.length - 5} más</li>
                            )}
                          </ul>
                        )}
                      </>
                    )}
                  </div>
                )}
              </div>

              {/* Clear stores — danger zone */}
              <div className="border-t border-gray-200 dark:border-gray-700 pt-4">
                <p className="text-xs text-gray-500 mb-2">
                  Para cargar tu red real desde cero, elimina primero las tiendas de ejemplo.
                  Esta acción no puede deshacerse.
                </p>
                <button
                  onClick={handleClearStores}
                  className="w-full py-2 rounded-lg bg-red-600 hover:bg-red-700 text-white text-sm font-medium transition-colors"
                >
                  Eliminar todas las tiendas ({storeSummary?.total ?? stats?.store_count ?? 0})
                </button>
              </div>
            </div>
          )}

          {/* ── System tab ── */}
          {tab === 'system' && (
            <div className="space-y-4">
              {stats && (
                <div className="grid grid-cols-2 gap-3">
                  {[
                    ['Municipios',         stats.municipio_count],
                    ['Nuestras tiendas',   stats.store_count],
                    ['Tiendas abiertas',   stats.open_stores],
                    ['Competidores',       stats.competitor_count],
                    ['Cadenas comp.',      stats.competitor_chains],
                    ['Registros de score', stats.score_records],
                    ['POIs en caché',      stats.poi_count],
                  ].map(([label, val]) => (
                    <div key={label as string}
                         className="bg-gray-50 dark:bg-gray-700/50 rounded-lg p-3">
                      <div className="text-lg font-bold text-gray-800 dark:text-gray-100">
                        {Number(val).toLocaleString()}
                      </div>
                      <div className="text-xs text-gray-500">{label}</div>
                    </div>
                  ))}
                </div>
              )}

              {osmStatus && (
                <div className="text-xs text-gray-500 border border-gray-200 dark:border-gray-700 rounded-lg p-3">
                  <div className="font-medium text-gray-700 dark:text-gray-300 mb-1">Estado OSM</div>
                  <div>{osmStatus.total_pois?.toLocaleString() ?? 0} POIs en caché</div>
                  {osmStatus.recent_refreshes?.[0] && (
                    <div className="mt-1 text-gray-400">
                      Última actualización: {new Date(osmStatus.recent_refreshes[0].executed_at).toLocaleString()}
                    </div>
                  )}
                </div>
              )}

              <button
                onClick={handleRecalculate}
                className="w-full py-2 px-4 rounded-lg bg-brand-600 hover:bg-brand-700 text-white text-sm font-medium transition-colors"
              >
                Recalcular todos los scores
              </button>

              <button
                onClick={handleOsmRefresh}
                className="w-full py-2 px-4 rounded-lg bg-purple-600 hover:bg-purple-700 text-white text-sm font-medium transition-colors"
              >
                Actualizar datos OSM (2 min)
              </button>
            </div>
          )}
        </div>

        {/* Footer */}
        {msg && (
          <div className="px-5 py-2 text-sm text-center text-gray-600 dark:text-gray-400 border-t border-gray-200 dark:border-gray-700">
            {msg}
          </div>
        )}
        {(tab === 'weights' || tab === 'thresholds') && (
          <div className="flex gap-2 px-5 py-3 border-t border-gray-200 dark:border-gray-700">
            <button
              onClick={handleReset}
              className="flex-1 py-2 rounded-lg border border-gray-300 dark:border-gray-600 text-sm text-gray-600 dark:text-gray-400 hover:bg-gray-50 dark:hover:bg-gray-700 transition-colors"
            >
              Restaurar defaults
            </button>
            <button
              onClick={handleSave}
              disabled={saving || !weightOk}
              className="flex-1 py-2 rounded-lg bg-brand-600 hover:bg-brand-700 text-white text-sm font-medium transition-colors disabled:opacity-50"
            >
              {saving ? 'Guardando…' : 'Guardar'}
            </button>
          </div>
        )}
      </div>
    </div>
  );
};

export default AdminPanel;
