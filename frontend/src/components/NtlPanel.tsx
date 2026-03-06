/**
 * NtlPanel — Sub-municipio nighttime lights drill-down
 *
 * Shown in the sidebar when a municipio opportunity card is clicked.
 * Lists VIIRS-derived settlement clusters ranked by estimated population,
 * and explains the estimation formula so users understand the methodology.
 *
 * Population formula (INE Guatemala Censo 2018):
 *   estimated_pop = ROUND(radiance_ntl × 180 × 4.2)
 *   where 180 = households per nW/cm²/sr (calibration constant)
 *         4.2 = avg household size (INE Censo 2018)
 */
import React, { useState } from 'react';
import type { NtlSettlementsResponse, NtlSettlement } from '../types';

interface Props {
  data:     NtlSettlementsResponse;
  loading:  boolean;
  onClose:  () => void;
  onSettlementClick: (s: NtlSettlement) => void;
}

/** Radiance → glow color: dark orange at low radiance, bright yellow-white at high */
function radianceColor(radiance: number): string {
  if (radiance >= 100) return '#fff9c4';  // bright white-yellow
  if (radiance >= 50)  return '#fde047';  // yellow
  if (radiance >= 20)  return '#f59e0b';  // amber
  if (radiance >= 8)   return '#d97706';  // dark amber
  return '#92400e';                        // dark brown (dim)
}

/** Relative bar width: 0–100% based on max estimated_pop in the list */
function barWidth(pop: number, maxPop: number): number {
  return maxPop > 0 ? Math.round((pop / maxPop) * 100) : 0;
}

const NtlPanel: React.FC<Props> = ({ data, loading, onClose, onSettlementClick }) => {
  const [showFormula, setShowFormula] = useState(false);

  const settlements = data?.settlements ?? [];
  const maxPop = Math.max(...settlements.map(s => s.estimated_pop ?? 0), 1);

  return (
    <div className="border-t border-yellow-200 dark:border-yellow-900 bg-yellow-50 dark:bg-gray-800/60 flex-shrink-0">
      {/* Header */}
      <div className="flex items-center justify-between px-3 py-2">
        <div className="flex items-center gap-1.5">
          <span className="text-base leading-none">🌙</span>
          <div>
            <div className="text-xs font-semibold text-yellow-800 dark:text-yellow-300">
              Luces Nocturnas VIIRS
            </div>
            <div className="text-[10px] text-yellow-600 dark:text-yellow-500">
              {data?.municipio_name ?? '—'} · {settlements.length} asentamientos
            </div>
          </div>
        </div>
        <div className="flex items-center gap-1.5">
          <button
            onClick={() => setShowFormula(f => !f)}
            className="text-[10px] text-yellow-600 dark:text-yellow-400 hover:underline"
            title="Ver fórmula de estimación"
          >
            ƒ fórmula
          </button>
          <button
            onClick={onClose}
            className="text-gray-400 hover:text-gray-600 dark:hover:text-gray-300 text-sm leading-none"
            title="Cerrar"
          >
            ×
          </button>
        </div>
      </div>

      {/* Formula explanation */}
      {showFormula && (
        <div className="mx-3 mb-2 p-2 bg-yellow-100 dark:bg-gray-700 rounded text-[10px] text-yellow-900 dark:text-yellow-200 space-y-0.5">
          <div className="font-semibold mb-1">Estimación de población</div>
          <div className="font-mono">
            pob_est = ROUND(radiancia × {data?.calibration?.calib_k ?? 180} × {data?.calibration?.household_size ?? 4.2})
          </div>
          <div className="mt-1 text-yellow-700 dark:text-yellow-400">
            {data?.calibration?.calib_k ?? 180} hogares/unidad (constante de calibración)<br />
            {data?.calibration?.household_size ?? 4.2} personas/hogar (INE Censo 2018)<br />
            Radiancia: VIIRS DNB compuesto anual (nW/cm²/sr)
          </div>
          <div className="mt-1 text-yellow-600 dark:text-yellow-500 italic">
            Datos sintéticos — reemplazar con GeoTIFF VNP46A4 real para precisión.
          </div>
        </div>
      )}

      {/* Loading */}
      {loading && (
        <div className="px-3 py-4 text-center">
          <div className="w-4 h-4 border-2 border-yellow-500 border-t-transparent rounded-full animate-spin mx-auto" />
        </div>
      )}

      {/* Settlement list */}
      {!loading && settlements.length === 0 && (
        <div className="px-3 pb-3 text-xs text-gray-400 text-center">
          Sin datos de luces nocturnas para este municipio
        </div>
      )}

      {!loading && settlements.length > 0 && (
        <div className="px-3 pb-2 space-y-1 max-h-52 overflow-y-auto scrollbar-thin">
          {settlements.map((s, i) => {
            const pop = s.estimated_pop ?? 0;
            const color = radianceColor(s.radiance_ntl);
            return (
              <button
                key={s.id}
                onClick={() => onSettlementClick(s)}
                className="w-full text-left rounded px-2 py-1.5 hover:bg-yellow-100 dark:hover:bg-gray-700 transition-colors group"
              >
                <div className="flex items-center gap-2">
                  {/* Rank + glow dot */}
                  <span className="text-[10px] text-gray-400 w-3 text-right flex-shrink-0">
                    {i + 1}
                  </span>
                  <div
                    className="w-2.5 h-2.5 rounded-full flex-shrink-0 ring-1 ring-white/30"
                    style={{ backgroundColor: color, boxShadow: `0 0 4px 1px ${color}80` }}
                  />
                  <div className="flex-1 min-w-0">
                    <div className="text-xs font-medium text-gray-800 dark:text-gray-200 truncate">
                      {s.name}
                    </div>
                    {/* Population bar */}
                    <div className="mt-0.5 h-1 bg-gray-200 dark:bg-gray-600 rounded-full overflow-hidden">
                      <div
                        className="h-full rounded-full transition-all"
                        style={{ width: `${barWidth(pop, maxPop)}%`, backgroundColor: color }}
                      />
                    </div>
                  </div>
                  <div className="text-right flex-shrink-0 ml-1">
                    <div className="text-[10px] font-semibold text-gray-700 dark:text-gray-300">
                      {pop > 0 ? `~${pop.toLocaleString()}` : '—'}
                    </div>
                    <div className="text-[9px] text-gray-400">
                      {s.radiance_ntl.toFixed(1)} nW
                    </div>
                  </div>
                </div>
              </button>
            );
          })}
        </div>
      )}

      {/* Footer: source note */}
      <div className="px-3 pb-2 pt-0.5 text-[9px] text-gray-400 dark:text-gray-500 border-t border-yellow-100 dark:border-gray-700">
        Fuente: {settlements[0]?.ntl_source === 'synthetic' ? 'Datos sintéticos (VIIRS simulado)' : 'VIIRS DNB 2023'} ·
        Radio de búsqueda: {data?.radius_km} km
      </div>
    </div>
  );
};

export default NtlPanel;
