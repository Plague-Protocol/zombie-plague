// Replays the stored fixtures in whatever JavaScript engine runs it and prints the fingerprints next to the
// ones recorded in Node. Bundle it and run it in another engine (see docs/PHASE2-BUILD-PLAN.md, W0):
//   npx rolldown tools/engine-check.ts --format iife --platform neutral -o /tmp/engine-check.js
//   /System/Library/Frameworks/JavaScriptCore.framework/Versions/A/Helpers/jsc /tmp/engine-check.js
import { hashState, replay, replayRoom, type NightLog, type RoomLog } from '../src/core/replay';
import { setContent, type Content } from '../src/core/content';
import fixtures from '../tests/fixtures/replay-v1.json';
import content from '../public/content/tasks.json';

declare const print: (s: string) => void;
setContent(content as unknown as Content);
const f = fixtures as unknown as { night: { log: NightLog; hash: string }; room: { log: RoomLog; hash: string } };
const night = hashState(replay(f.night.log)), room = hashState(replayRoom(f.room.log));
print(`night ${night} (recorded ${f.night.hash}) ${night === f.night.hash ? 'MATCH' : 'DIFFERENT'}`);
print(`room  ${room} (recorded ${f.room.hash}) ${room === f.room.hash ? 'MATCH' : 'DIFFERENT'}`);
