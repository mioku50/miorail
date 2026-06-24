import { Route, Switch } from "wouter";
import { Layout } from "./components/Layout";
import { Chat } from "./pages/Chat";
import { Actions } from "./pages/Actions";
import { Settings } from "./pages/Settings";
import { Workflows } from "./pages/Workflows";

import { Home } from "./pages/Home";
const NotFound = () => <div className="p-6 text-red-500 font-medium">404 - Not Found</div>;

function App() {
  return (
    <Layout>
      <Switch>
        <Route path="/" component={Home} />
        <Route path="/chat" component={Chat} />
        <Route path="/actions" component={Actions} />
        <Route path="/workflows" component={Workflows} />
        <Route path="/settings" component={Settings} />
        <Route component={NotFound} />
      </Switch>
    </Layout>
  )
}

export default App
