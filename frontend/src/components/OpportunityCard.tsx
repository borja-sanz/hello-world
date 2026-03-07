import React from 'react';
import ScoreBadge from './ScoreBadge';
import type { OpportunityScore } from '../types';

interface Props {
  opp:   OpportunityScore;
  rank:  number;
  onClick: (opp: OpportunityScore) => void;
}

const BAR_COLORS: Record<string, string> = {
  population:    'bg-blue-500',
  mobility:      'bg-purple-500',
  commercial:    'bg-orange-500',
  competition:   'bg-teal-500',
  socioeconomic: 'bg-pink-500',
};

const FACTOR_LABELS: Record<string, string> = {
  population:    'Población',
  mobility:      'Accesibilidad',
  commercial:    'Comercio',
  competition:   'Competencia',
  socioeconomic: 'Socioeconómico',
};

const FACTOR_WEIGHTS: Record<string, string> = {
  population:    '28%',
  mobility:      '22%',
  commercial:    '22%',
  competition:   '15%',
  socioeconomic: '13%',
};

const OpportunityCard: React.FC<Props> = ({ opp, rank, onClick }) => {
  // Blue ocean: high competition score (few competitors + no own store nearby) + no close own store
  const isBlueOcean = opp.competition_score >= 60 &&
    (opp.nearest_store_km === null || opp.nearest_store_km >= 15);

  const factors = [
    { key: 'population',    val: opp.pop_score },
    { key: 'mobility',      val: opp.mobility_score },
    { key: 'commercial',    val: opp.commercial_score },
    { key: 'competition',   val: opp.competition_score },
    { key: 'socioeconomic', val: opp.socioeconomic_score },
  ];

  return (
    <button
      onClick={() => onClick(opp)}
      className="w-full text-left p-3 rounded-lg border border-gray-200 dark:border-gray-700
                 bg-white dark:bg-gray-800 hover:border-brand-400 hover:bg-brand-50
                 dark:hover:bg-gray-750 transition-colors group"
    >
      {/* Header row */}
      <div className="flex items-start justify-between gap-2 mb-2">
        <div className="flex items-center gap-2 min-w-0">
          <span className="text-xs font-bold text-gray-400 dark:text-gray-500 w-5 flex-shrink-0">
            #{rank}
          </span>
          <div className="min-w-0">
            <div className="flex items-center gap-1.5 flex-wrap">
              <span className="text-sm font-semibold text-gray-800 dark:text-gray-100 truncate">
                {opp.municipio_name}
              </span>
              {isBlueOcean && (
                <span className="text-[9px] font-bold bg-cyan-100 dark:bg-cyan-900/40
                                 text-cyan-700 dark:text-cyan-300 px-1.5 py-0.5 rounded-full
                                 whitespace-nowrap flex-shrink-0">
                  🌊 VIRGEN
                </span>
              )}
            </div>
            <div className="text-xs text-gray-400 dark:text-gray-500">
              {opp.department}
            </div>
          </div>
        </div>
        <ScoreBadge score={opp.score} recommendation={opp.recommendation} size="sm" />
      </div>

      {/* Quick stats */}
      <div className="flex gap-3 text-xs text-gray-500 dark:text-gray-400 mb-2">
        <span>👥 {(opp.population ?? 0).toLocaleString()}</span>
        {opp.suggested_format && (
          <span className="text-brand-600 dark:text-brand-400 font-medium truncate">
            {opp.suggested_format === 'Maxi Despensa' ? '🏬' : '🏪'} {opp.suggested_format}
          </span>
        )}
        {opp.nearest_store_km !== null && (
          <span>📍 {opp.nearest_store_km}km</span>
        )}
      </div>

      {/* Factor score bars */}
      <div className="space-y-0.5">
        {factors.map(({ key, val }) => (
          <div key={key} className="flex items-center gap-1.5">
            <span className="text-[10px] text-gray-400 dark:text-gray-500 w-20 flex-shrink-0">
              {FACTOR_LABELS[key]} <span className="opacity-60">({FACTOR_WEIGHTS[key]})</span>
            </span>
            <div className="flex-1 bg-gray-100 dark:bg-gray-700 rounded-full h-1.5 overflow-hidden">
              <div
                className={`h-full rounded-full ${BAR_COLORS[key]} transition-all`}
                style={{ width: `${Math.round(val)}%` }}
              />
            </div>
            <span className="text-[10px] text-gray-500 dark:text-gray-400 w-6 text-right">
              {Math.round(val)}
            </span>
          </div>
        ))}
      </div>
    </button>
  );
};

export default OpportunityCard;
