import { create } from 'zustand';

// Global UI state shared across views (replaces prop-drilled showToast + activeTab).
// Data stays in TanStack Query hooks; this is only for ephemeral UI state.
export interface ToastState {
  id: number;
  message: string;
}

export interface UiState {
  toast: ToastState | null;
  showToast: (message: string) => void;
  dismissToast: (id: number) => void;
  paletteOpen: boolean;
  setPaletteOpen: (open: boolean) => void;
  togglePalette: () => void;
  // Action Inbox filter persists across navigation.
  inboxFilter: string;
  setInboxFilter: (filter: string) => void;
  // Scroll-to-action focus (set by deep-links / "View in Action Inbox"). Avoids
  // remounting the main view when focusing an action that's already rendered.
  focusActionId: string | null;
  focusAction: (id: string) => void;
  clearFocus: () => void;
}

let nextToastId = 0;

export const useUiStore = create<UiState>((set) => ({
  toast: null,
  showToast: (message) => {
    const id = ++nextToastId;
    set({ toast: { id, message } });
    window.setTimeout(() => {
      set((state) => (state.toast?.id === id ? { toast: null } : {}));
    }, 3200);
  },
  dismissToast: (id) => set((state) => (state.toast?.id === id ? { toast: null } : {})),
  paletteOpen: false,
  setPaletteOpen: (open) => set({ paletteOpen: open }),
  togglePalette: () => set((state) => ({ paletteOpen: !state.paletteOpen })),
  inboxFilter: 'all',
  setInboxFilter: (filter) => set({ inboxFilter: filter }),
  focusActionId: null,
  focusAction: (id) => set({ focusActionId: id }),
  clearFocus: () => set({ focusActionId: null }),
}));

export function resetTenantUiState(): void {
  useUiStore.setState({
    toast: null,
    paletteOpen: false,
    inboxFilter: 'all',
    focusActionId: null,
  });
}
