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
const VALID_FORMATS = ['Despensa Familiar', 'Maxi Despensa', 'Walmart', 'Paiz', 'Other'];
const VALID_STATUSES = ['open', 'planned', 'closed', 'under_construction'];

export async function parseStoreCSV(buffer: Buffer): Promise<ParseResult> {
  return new Promise((resolve) => {
    const rows: StoreRow[] = [];
    const errors: string[] = [];

    const parser = parse({
      columns: true,
      skip_empty_lines: true,
      trim: true,
      relax_column_count: true,
    });

    let rowIndex = 1;
    let headersValidated = false;

    parser.on('readable', () => {
      let record: Record<string, string>;
      while ((record = parser.read()) !== null) {
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

    Readable.from(buffer).pipe(parser);
  });
}
