import { useUiStore } from '../lib/state';

// Reads from the zustand toast store (no prop drilling). bg-ink/text-bg inverts
// with the theme so the toast stays high-contrast in both dark and light.
export function Toaster() {
  const toast = useUiStore((s) => s.toast);
  const dismiss = useUiStore((s) => s.dismissToast);
  if (!toast) return null;
  return (
    <div
      onClick={() => dismiss(toast.id)}
      className="fixed bottom-[22px] left-1/2 -translate-x-1/2 bg-ink text-bg px-[18px] py-[12px] rounded-[12px] text-[13px] font-medium flex items-center gap-[9px] z-[60] shadow-lg cursor-pointer"
    >
      <span className="w-[9px] h-[9px] rounded-full bg-ok"></span>
      {toast.message}
    </div>
  );
}
