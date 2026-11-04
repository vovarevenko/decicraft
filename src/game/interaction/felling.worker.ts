/**
 * Felling worker entry (module worker): holds a read-only view of the shared world and answers the detach and land
 * jobs of the felling client (felling.ts); the protocol and the jobs live in fellingJob.ts. OWNER: agent "interaction".
 */
import { workerSelf } from '../../core/workerScope';
import { handleFellingMessage, type FellingRequest, type FellingState } from './fellingJob';

const state: FellingState = { world: null };

workerSelf.onmessage = (ev: MessageEvent) => {
  handleFellingMessage(state, ev.data as FellingRequest, (reply, transfer) => workerSelf.postMessage(reply, transfer));
};
