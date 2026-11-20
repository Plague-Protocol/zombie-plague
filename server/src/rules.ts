// The rules this server replays by (server/src/rules-id.ts): stamped in at build time (npm run build), worked out from the
// source under tsx and in tests.
import { fileURLToPath } from 'node:url';
import { rulesId } from './rules-id.ts';

declare const __RULES__: string | undefined;
export const RULES: string = typeof __RULES__ === 'string' ? __RULES__ : rulesId(fileURLToPath(new URL('../../core', import.meta.url)));
