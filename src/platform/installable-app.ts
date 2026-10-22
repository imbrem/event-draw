interface InstallPrompt extends Event {
  prompt(): Promise<void>;
}

/** Browser installation/update lifecycle; no knowledge of notebook schema or tools. */
export class InstallableApp {
  private events = new AbortController();
  private registration?: ServiceWorkerRegistration;
  private prompt?: InstallPrompt;
  constructor(
    root: HTMLElement,
    hooks: { canReload(): boolean; prepare(): Promise<void>; error(error: unknown): void },
  ) {
    root.innerHTML = `<h2>Install Event Draw</h2>
      <p>On iPad: open in Safari, tap Share → Add to Home Screen, enable Open as Web App if shown, then launch the Home Screen icon. It fills the screen in portrait and landscape.</p>
      <p>Save SQLite before moving between Safari and the installed app: browsers may give them separate local storage. Keep regular exports of important notebooks.</p>
      <button id="install-app" hidden>Install app</button><button id="update-app" hidden>Save & update app</button>
      <p id="offline-status" role="status">Offline installation is available in the production build over HTTPS or localhost.</p>`;
    const install = root.querySelector<HTMLButtonElement>('#install-app')!,
      update = root.querySelector<HTMLButtonElement>('#update-app')!,
      status = root.querySelector('#offline-status')!;
    const listener = { signal: this.events.signal };
    window.addEventListener(
      'beforeinstallprompt',
      (event) => {
        event.preventDefault();
        this.prompt = event as InstallPrompt;
        install.hidden = false;
      },
      listener,
    );
    window.addEventListener(
      'appinstalled',
      () => {
        install.hidden = true;
        this.prompt = undefined;
      },
      listener,
    );
    install.onclick = () => {
      void this.prompt
        ?.prompt()
        .then(() => {
          install.hidden = true;
        })
        .catch(hooks.error);
    };
    update.onclick = () => {
      void (async () => {
        if (!hooks.canReload())
          throw new Error('Finish the current drawing or file operation before updating.');
        update.disabled = true;
        try {
          await hooks.prepare();
          const worker = this.registration?.waiting;
          if (!worker) {
            location.reload();
            return;
          }
          navigator.serviceWorker.addEventListener('controllerchange', () => location.reload(), {
            once: true,
          });
          worker.postMessage('activate-update');
        } catch (error) {
          update.disabled = false;
          throw error;
        }
      })().catch(hooks.error);
    };
    if (import.meta.env.PROD && 'serviceWorker' in navigator && isSecureContext) {
      status.textContent = 'Preparing offline app…';
      void navigator.serviceWorker
        .register(import.meta.env.BASE_URL + 'sw.js', {
          scope: import.meta.env.BASE_URL,
          updateViaCache: 'none',
        })
        .then((registration) => {
          if (this.events.signal.aborted) return;
          this.registration = registration;
          const report = () => {
            update.hidden = !registration.waiting;
            status.textContent = registration.waiting
              ? 'Update ready. Save & update when you finish writing.'
              : registration.active
                ? 'App ready offline. Notebook files stay on this device.'
                : 'Preparing offline app…';
          };
          const watch = () => registration.installing?.addEventListener('statechange', report, listener);
          registration.addEventListener('updatefound', watch, listener);
          watch();
          report();
        })
        .catch(() => {
          status.textContent =
            'Offline setup unavailable. The app still works online; export important notebooks.';
        });
    }
  }
  close() {
    this.events.abort();
  }
}
