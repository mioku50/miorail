/** A frame while the session or the next screen is still arriving. It fades in
 * only if that takes longer than a moment (`appear-late`). */
export function AppLoading() {
  return (
    <main className="min-h-screen flex items-center justify-center p-6 bg-bg text-ink" role="status" aria-live="polite" aria-busy="true">
      <section className="text-center appear-late">
        <h1 className="text-lg font-semibold">Loading Miorail…</h1>
        <p className="mt-2 text-sm text-muted">If this takes longer, reload this page.</p>
        <button type="button" className="mt-4 rounded-lg border border-line px-4 py-2 text-sm" onClick={() => window.location.reload()}>
          Reload page
        </button>
      </section>
    </main>
  );
}
