/**
 * Master seed runner — runs all seed scripts in order
 * Usage: npm run seed
 */

import { execSync } from 'child_process';
import * as path from 'path';

const scripts = [
  { name: 'municipios',   file: './seedMunicipios.ts' },
  { name: 'competitors',  file: './seedCompetitors.ts' },
];

function run(scriptPath: string, label: string): void {
  console.log(`\n${'='.repeat(60)}`);
  console.log(`Seeding: ${label}`);
  console.log('='.repeat(60));

  const absPath = path.resolve(__dirname, scriptPath);
  execSync(`ts-node ${absPath}`, {
    stdio: 'inherit',
    env: { ...process.env },
  });
}

(async () => {
  const target = process.argv[2];

  if (target) {
    const script = scripts.find(s => s.name === target);
    if (!script) {
      console.error(`Unknown seed target: ${target}`);
      console.error(`Available: ${scripts.map(s => s.name).join(', ')}`);
      process.exit(1);
    }
    run(script.file, script.name);
  } else {
    for (const script of scripts) {
      run(script.file, script.name);
    }
  }

  console.log('\nAll seeds complete');
  process.exit(0);
})();
