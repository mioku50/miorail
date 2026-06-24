import { ReactNode } from 'react';
import { Link, useRoute } from 'wouter';

export function Layout({ children }: { children: ReactNode }) {
  const [isHome] = useRoute('/');
  const [isChat] = useRoute('/chat');

  return (
    <div className="min-h-screen bg-slate-50 text-slate-900 flex flex-col">
      <header className="bg-white shadow-sm border-b px-6 py-3 flex items-center justify-between">
        <h1 className="text-xl font-bold bg-clip-text text-transparent bg-gradient-to-r from-blue-600 to-indigo-600">
          MioAgent
        </h1>
        <nav className="flex gap-4">
          <Link href="/">
            <a className={`px-3 py-1 rounded-md transition-colors ${isHome ? 'bg-blue-50 text-blue-700 font-medium' : 'text-slate-600 hover:bg-slate-100'}`}>Dashboard</a>
          </Link>
          <Link href="/chat">
            <a className={`px-3 py-1 rounded-md transition-colors ${isChat ? 'bg-blue-50 text-blue-700 font-medium' : 'text-slate-600 hover:bg-slate-100'}`}>Chat</a>
          </Link>
        </nav>
      </header>
      <main className="flex-1 container mx-auto">
        {children}
      </main>
    </div>
  );
}
