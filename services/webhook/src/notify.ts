export interface Notifier {
  send(text: string): Promise<void>;
}

export const noopNotifier: Notifier = {
  async send() {
    /* no slack configured */
  },
};

export function slackNotifier(url: string, fetchImpl: typeof fetch = fetch): Notifier {
  return {
    async send(text) {
      try {
        await fetchImpl(url, {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ text }),
        });
      } catch (err) {
        process.stderr.write(
          `[webhook.notify] slack post failed: ${(err as Error).message ?? String(err)}\n`,
        );
      }
    },
  };
}
