import type { ReactNode } from "react";
import { Sidebar } from "./Sidebar";
import { ClipboardBar } from "@/components/clipboard/ClipboardBar";

export function AppShell({ children }: { children: ReactNode }) {
  return (
    <div className="flex h-screen w-screen flex-col bg-bg text-fg">
      <div className="flex min-h-0 flex-1">
        <Sidebar />
        <main className="flex-1 overflow-y-auto">
          <div className="mx-auto max-w-7xl px-8 py-6">{children}</div>
        </main>
      </div>
      <ClipboardBar />
    </div>
  );
}
