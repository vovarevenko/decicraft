/**
 * Mesh worker entry (module worker). Reads the shared world memory and answers mesh jobs; the protocol
 * and the job logic live in meshJob.ts.
 */
import { workerSelf } from '../../core/workerScope';
import { MeshJobRunner, handleMeshMessage, type MeshWorkerRequest } from './meshJob';

const runner = new MeshJobRunner();

workerSelf.onmessage = (ev: MessageEvent) => {
  handleMeshMessage(runner, ev.data as MeshWorkerRequest, (response, transfer) => workerSelf.postMessage(response, transfer));
};
