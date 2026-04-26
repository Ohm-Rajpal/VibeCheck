import { sharedReferenceProbe } from './types';

export function callSharedReferenceProbe(): string {
  return sharedReferenceProbe('from-probe-caller');
}
