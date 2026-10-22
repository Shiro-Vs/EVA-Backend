import { writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { buildOpenApi } from './openapi.js';

const out = resolve(import.meta.dirname, '..', '..', 'openapi.json');
writeFileSync(out, JSON.stringify(buildOpenApi(), null, 2) + '\n');
console.log('openapi.json actualizado:', out);
