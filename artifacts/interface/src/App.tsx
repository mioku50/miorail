import { Route, Switch } from "wouter";

const Home = () => <div className="p-4"><h1 className="text-2xl font-bold">MioAgent Dashboard</h1><p>Welcome to the agent interface.</p></div>;
const NotFound = () => <div className="p-4">404 - Not Found</div>;

function App() {
  return (
    <div className="min-h-screen bg-slate-50 text-slate-900">
      <header className="bg-white shadow-sm border-b p-4">
        <h2 className="text-xl font-semibold">MioAgent</h2>
      </header>
      <main className="container mx-auto p-4">
        <Switch>
          <Route path="/" component={Home} />
          <Route component={NotFound} />
        </Switch>
      </main>
    </div>
  )
}

export default App
