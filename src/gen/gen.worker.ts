/**
 * World generation worker. OWNER: agent "worldgen".
 * 'init' builds the terrain, the world plan and the feature index once; every 'tile' request then
 * generates one tile into the reused 8 MB buffer and transfers the chunk arrays and height maps back.
 */
import { workerSelf } from '../core/workerScope';
import { tileTransferables, type GenRequest, type GenResponse } from './nature/protocol';
import { TileGenerator } from './nature/tileGenerator';

let generator: TileGenerator | null = null;

const reply = (msg: GenResponse, transfer: Transferable[] = []): void => workerSelf.postMessage(msg, transfer);

const describe = (e: unknown): string => (e instanceof Error ? `${e.message}\n${e.stack ?? ''}` : String(e));

workerSelf.onmessage = (ev: MessageEvent<GenRequest>) => {
  const msg = ev.data;
  if (msg.type === 'init') {
    try {
      generator = new TileGenerator(msg.seed);
      reply({ type: 'ready' });
    } catch (e) {
      reply({ type: 'error', message: `init: ${describe(e)}` });
    }
    return;
  }
  try {
    if (!generator) throw new Error('tile requested before init');
    const result = generator.generate(msg.tx, msg.tz);
    reply({ type: 'tile', ...result }, tileTransferables(result));
  } catch (e) {
    reply({ type: 'error', message: describe(e), tx: msg.tx, tz: msg.tz });
  }
};
