// Print the rules' fingerprint as a JS string literal, for esbuild's --define (see package.json's build).
import { fileURLToPath } from 'node:url';
import { rulesId } from '../src/rules-id.ts';

process.stdout.write(JSON.stringify(rulesId(fileURLToPath(new URL('../../core', import.meta.url)))));
