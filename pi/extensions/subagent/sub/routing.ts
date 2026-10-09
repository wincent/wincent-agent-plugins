import type {
  ExtensionAPI,
  ExtensionContext,
} from '@earendil-works/pi-coding-agent';

import type {Bus} from '../bus/bus.js';

export interface SubRoutingOptions {
  bus: Bus;
  getCtx: () => ExtensionContext | undefined;
  onCancel: (reason: string) => void;
}

export function installSubRouting(
  pi: ExtensionAPI,
  options: SubRoutingOptions,
): () => void {
  const {bus, getCtx, onCancel} = options;
  return bus.subscribe((env) => {
    if (env.from !== 'main' || bus.isClosed) {
      return;
    }
    if (env.type === 'cancel') {
      onCancel(env.payload.reason);
    } else if (env.type === 'steer') {
      if (!getCtx()) {
        process.stderr.write(
          '[subagent sub] steer received before session startup\n',
        );
        return;
      }
      // deliverAs also works while idle; no isIdle/check-then-send race.
      // Pi reports asynchronous delivery failures as extension errors.
      pi.sendUserMessage(`[main steer] ${env.payload.text}`, {
        deliverAs: 'steer',
      });
    }
  });
}
