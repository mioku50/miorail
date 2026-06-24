import { Route, Switch } from "wouter";
import { Layout } from "./components/Layout";
import { Chat } from "./pages/Chat";
import { Actions } from "./pages/Actions";

const Home = () => <div className="p-6"><h2 className="text-2xl font-bold mb-4">Dashboard</h2><p className="text-slate-600">Welcome to the MioAgent interface.</p></div>;
const NotFound = () => <div className="p-6 text-red-500 font-medium">404 - Not Found</div>;

function App() {
  return (
    <Layout>
      <Switch>
        <Route path="/" component={Home} />
        <Route path="/chat" component={Chat} />
        <Route path="/actions" component={Actions} />
        <Route component={NotFound} />
      </Switch>
    </Layout>
  )
}

export default App
