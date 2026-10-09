import type {ExtensionAPI} from '@earendil-works/pi-coding-agent';

export default function (pi: ExtensionAPI) {
  pi.on('session_start', (_event, ctx) => {
    if (ctx.mode !== 'tui') {
      return;
    }
    // This is a launcher hint, not verification of sandbox enforcement.
    ctx.ui.setStatus(
      'sandbox',
      process.env.NONO_CAP_FILE
        ? ctx.ui.theme.fg('dim', 'Sandbox ✔')
        : undefined,
    );
  });
}
