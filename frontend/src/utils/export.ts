import type { OpportunityScore } from '../types';

/** Download a string as a file */
function download(content: string, filename: string, mimeType: string): void {
  const blob = new Blob([content], { type: mimeType });
  const url  = URL.createObjectURL(blob);
  const a    = document.createElement('a');
  a.href     = url;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  document.body.removeChild(a);
  URL.revokeObjectURL(url);
}

/** Export opportunities as CSV */
export function exportOpportunitiesCsv(opportunities: OpportunityScore[]): void {
  const header = [
    'Rank', 'Municipio', 'Departamento', 'Población', 'Score', 'Recomendación',
    'Formato Sugerido', 'Score Población', 'Score Accesibilidad', 'Score Comercio',
    'Score Competencia', 'Score Socioeconómico', 'Tienda más cercana (km)', 'Razonamiento',
  ].join(',');

  const rows = opportunities.map((o, i) => [
    i + 1,
    `"${o.municipio_name}"`,
    `"${o.department}"`,
    o.population ?? 0,
    o.score.toFixed(1),
    o.recommendation,
    `"${o.suggested_format ?? ''}"`,
    o.pop_score?.toFixed(1)          ?? '',
    o.mobility_score?.toFixed(1)     ?? '',
    o.commercial_score?.toFixed(1)   ?? '',
    o.competition_score?.toFixed(1)  ?? '',
    o.socioeconomic_score?.toFixed(1) ?? '',
    o.nearest_store_km ?? '',
    `"${o.reasoning?.replace(/"/g, '""') ?? ''}"`,
  ].join(','));

  const csv = [header, ...rows].join('\n');
  const date = new Date().toISOString().split('T')[0];
  download(csv, `georetail-oportunidades-${date}.csv`, 'text/csv;charset=utf-8;');
}

/** Export opportunities as simple HTML report (printable) */
export function exportOpportunitiesReport(opportunities: OpportunityScore[]): void {
  const rows = opportunities
    .slice(0, 20)
    .map((o, i) => {
      const barColor = o.recommendation === 'GO' ? '#16a34a' :
                       o.recommendation === 'CAUTION' ? '#ca8a04' : '#dc2626';
      return `
        <tr style="border-bottom:1px solid #e5e7eb">
          <td style="padding:8px 12px;font-weight:600">#${i + 1}</td>
          <td style="padding:8px 12px">
            <div style="font-weight:600">${o.municipio_name}</div>
            <div style="font-size:11px;color:#6b7280">${o.department}</div>
          </td>
          <td style="padding:8px 12px;text-align:right">${(o.population ?? 0).toLocaleString()}</td>
          <td style="padding:8px 12px;text-align:center">
            <span style="background:${barColor}20;color:${barColor};
                         border:1px solid ${barColor}40;border-radius:9999px;
                         padding:2px 10px;font-weight:600;font-size:13px">
              ${o.score.toFixed(0)} — ${o.recommendation}
            </span>
          </td>
          <td style="padding:8px 12px">${o.suggested_format ?? '—'}</td>
          <td style="padding:8px 12px;font-size:11px;color:#6b7280;max-width:200px">${o.reasoning ?? ''}</td>
        </tr>`;
    }).join('');

  const html = `<!DOCTYPE html>
<html lang="es">
<head>
  <meta charset="UTF-8"/>
  <title>GeoRetail Guatemala — Reporte de Oportunidades</title>
  <style>
    body { font-family: system-ui, sans-serif; margin: 32px; color: #111827; }
    h1   { color: #15803d; margin-bottom: 4px; }
    p    { color: #6b7280; margin-top: 0; }
    table{ width:100%; border-collapse:collapse; font-size:13px; margin-top:16px; }
    th   { background:#f9fafb; padding:8px 12px; text-align:left; border-bottom:2px solid #e5e7eb; }
    @media print { body { margin: 16px; } }
  </style>
</head>
<body>
  <h1>GeoRetail Guatemala</h1>
  <p>Reporte de Oportunidades — Generado el ${new Date().toLocaleDateString('es-GT')}</p>
  <table>
    <thead>
      <tr>
        <th>#</th><th>Municipio</th><th>Población</th>
        <th>Score</th><th>Formato</th><th>Razonamiento</th>
      </tr>
    </thead>
    <tbody>${rows}</tbody>
  </table>
</body>
</html>`;

  download(html, `georetail-reporte-${new Date().toISOString().split('T')[0]}.html`, 'text/html;charset=utf-8;');
}
