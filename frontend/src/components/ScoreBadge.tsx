import React from 'react';

interface Props {
  score: number;
  recommendation: 'GO' | 'CAUTION' | 'NO-GO';
  size?: 'sm' | 'md' | 'lg';
}

const COLORS = {
  GO:      { bg: 'bg-green-100 dark:bg-green-900/40',  text: 'text-green-700 dark:text-green-300',  border: 'border-green-300 dark:border-green-700' },
  CAUTION: { bg: 'bg-yellow-100 dark:bg-yellow-900/40', text: 'text-yellow-700 dark:text-yellow-300', border: 'border-yellow-300 dark:border-yellow-700' },
  'NO-GO': { bg: 'bg-red-100 dark:bg-red-900/40',     text: 'text-red-700 dark:text-red-300',      border: 'border-red-300 dark:border-red-700' },
};

const ScoreBadge: React.FC<Props> = ({ score, recommendation, size = 'md' }) => {
  const c = COLORS[recommendation];
  const sizeClasses = {
    sm:  'text-xs px-1.5 py-0.5',
    md:  'text-sm px-2 py-1',
    lg:  'text-base px-3 py-1.5 font-bold',
  }[size];

  return (
    <div className={`inline-flex items-center gap-1.5 rounded-full border ${c.bg} ${c.text} ${c.border} ${sizeClasses} font-medium`}>
      <span>{score.toFixed(0)}</span>
      <span className="opacity-60">/100</span>
      <span className="text-xs opacity-80">{recommendation}</span>
    </div>
  );
};

export default ScoreBadge;
