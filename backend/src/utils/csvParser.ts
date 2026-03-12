import { parse } from 'csv-parse';
import { Readable } from 'stream';

export interface StoreRow {
  store_name: string;
  format: string;
  lat: string;
  lng: string;
  status?: string;
  department?: string;
  municipio?: string;
  open_date?: string;
  notes?: string;
}

export interface ParseResult {
  rows: StoreRow[];
  errors: string[];
}

const REQUIRED_COLUMNS = ['store_name', 'format', 'lat', 'lng'];
const VALID_FORMATS = ['Despensa Familiar', 'Maxi Despensa', 'Walmart', 'Paiz', 'Other', 'Full Potential'];
const VALID_STATUSES = ['open', 'planned', 'closed', 'under_construction'];

// Maps common column name variants → canonical name (shared by both parsers)
const COLUMN_ALIASES: Record<string, string> = {
  name: 'store_name',
  nombre: 'store_name',
  store: 'store_name',
  tienda: 'store_name',
  formato: 'format',
  latitude: 'lat',
  latitud: 'lat',
  longitude: 'lng',
  longitud: 'lng',
  lon: 'lng',
  long: 'lng',
  // competitor aliases
  competitor: 'comp_name',
  competidor: 'comp_name',
  cadena: 'chain',
  zone: 'zona',
  neighborhood: 'zona',
  barrio: 'zona',
  colonia: 'zona',
  sector: 'zona',
};

/** Detect delimiter from the first line — handles Excel semicolon exports */
function detectDelimiter(buffer: Buffer): string {
  const firstLine = buffer.toString('utf8').split(/\r?\n/)[0] ?? '';
  return firstLine.includes(';') ? ';' : ',';
}

function normalizeRecord(record: Record<string, string>): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [key, value] of Object.entries(record)) {
    const normalized = key.trim().toLowerCase().replace(/\s+/g, '_');
    const canonical = COLUMN_ALIASES[normalized] ?? normalized;
    out[canonical] = value;
  }
  return out;
}

export async function parseStoreCSV(buffer: Buffer): Promise<ParseResult> {
  return new Promise((resolve) => {
    const rows: StoreRow[] = [];
    const errors: string[] = [];

    // Strip BOM first so delimiter detection works on the actual content
    const input = buffer[0] === 0xEF && buffer[1] === 0xBB && buffer[2] === 0xBF
      ? buffer.subarray(3)
      : buffer;

    const parser = parse({
      columns: true,
      skip_empty_lines: true,
      trim: true,
      relax_column_count: true,
      delimiter: detectDelimiter(input),
    });

    let rowIndex = 1;
    let headersValidated = false;

    parser.on('readable', () => {
      let record: Record<string, string>;
      while ((record = parser.read()) !== null) {
        record = normalizeRecord(record);
        // Validate headers on first record
        if (!headersValidated) {
          const keys = Object.keys(record);
          const missing = REQUIRED_COLUMNS.filter(c => !keys.includes(c));
          if (missing.length > 0) {
            errors.push(`Missing required columns: ${missing.join(', ')}`);
            parser.destroy();
            resolve({ rows: [], errors });
            return;
          }
          headersValidated = true;
        }

        rowIndex++;
        const rowErrors: string[] = [];

        // Validate format
        if (!VALID_FORMATS.includes(record.format)) {
          rowErrors.push(`invalid format "${record.format}"`);
        }

        // Validate coordinates
        const lat = parseFloat(record.lat);
        const lng = parseFloat(record.lng);
        if (isNaN(lat) || lat < 13 || lat > 18) {
          rowErrors.push(`invalid lat "${record.lat}" (must be 13–18)`);
        }
        if (isNaN(lng) || lng < -93 || lng > -88) {
          rowErrors.push(`invalid lng "${record.lng}" (must be -93 to -88)`);
        }

        // Validate status if present
        if (record.status && !VALID_STATUSES.includes(record.status)) {
          rowErrors.push(`invalid status "${record.status}"`);
        }

        if (rowErrors.length > 0) {
          errors.push(`Row ${rowIndex} (${record.store_name}): ${rowErrors.join('; ')}`);
        } else {
          rows.push(record as unknown as StoreRow);
        }
      }
    });

    parser.on('error', (err) => {
      errors.push(`CSV parse error: ${err.message}`);
      resolve({ rows, errors });
    });

    parser.on('end', () => {
      resolve({ rows, errors });
    });

    Readable.from(input).pipe(parser);
  });
}

export interface CompetitorRow {
  comp_name: string;
  chain: string;
  lat: string;
  lng: string;
  address?: string;
  municipio?: string;
  zona?: string;
  department?: string;
  notes?: string;
}

export interface CompetitorParseResult {
  rows: CompetitorRow[];
  errors: string[];
}

const COMPETITOR_REQUIRED = ['comp_name', 'chain', 'lat', 'lng'];

export async function parseCompetitorCSV(buffer: Buffer): Promise<CompetitorParseResult> {
  return new Promise((resolve) => {
    const rows: CompetitorRow[] = [];
    const errors: string[] = [];

    const input = buffer[0] === 0xEF && buffer[1] === 0xBB && buffer[2] === 0xBF
      ? buffer.subarray(3)
      : buffer;

    const parser = parse({
      columns: true,
      skip_empty_lines: true,
      trim: true,
      relax_column_count: true,
      delimiter: detectDelimiter(input),
    });

    let rowIndex = 1;
    let headersValidated = false;

    parser.on('readable', () => {
      let record: Record<string, string>;
      while ((record = parser.read()) !== null) {
        record = normalizeRecord(record);

        if (!headersValidated) {
          const keys = Object.keys(record);
          const missing = COMPETITOR_REQUIRED.filter(c => !keys.includes(c));
          if (missing.length > 0) {
            errors.push(`Missing required columns: ${missing.join(', ')}`);
            parser.destroy();
            resolve({ rows: [], errors });
            return;
          }
          headersValidated = true;
        }

        rowIndex++;
        const rowErrors: string[] = [];

        const lat = parseFloat(record.lat);
        const lng = parseFloat(record.lng);
        if (isNaN(lat) || lat < 13 || lat > 18) {
          rowErrors.push(`invalid lat "${record.lat}" (must be 13–18)`);
        }
        if (isNaN(lng) || lng < -93 || lng > -88) {
          rowErrors.push(`invalid lng "${record.lng}" (must be -93 to -88)`);
        }
        if (!record.chain) {
          rowErrors.push('chain is required');
        }

        if (rowErrors.length > 0) {
          errors.push(`Row ${rowIndex} (${record.comp_name ?? '?'}): ${rowErrors.join('; ')}`);
        } else {
          rows.push(record as unknown as CompetitorRow);
        }
      }
    });

    parser.on('error', (err) => {
      errors.push(`CSV parse error: ${err.message}`);
      resolve({ rows, errors });
    });

    parser.on('end', () => {
      resolve({ rows, errors });
    });

    Readable.from(input).pipe(parser);
  });
}
