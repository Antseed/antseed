import { Footer, Header } from './components/Chrome';
import { XWelcome } from './components/XWelcome';
import { useNetwork } from './lib/model';
import { useRoute } from './lib/router';
import { Home } from './pages/Home';
import { Profile } from './pages/Profile';

export function App() {
  const route = useRoute();
  const network = useNetwork();
  const net = network.data;

  return (
    <>
      <Header route={route} />
      <main>
        {network.isError && !net && (
          <div className="wrap" style={{ paddingTop: 24 }}>
            <div className="notice bad">Couldn't reach Antscan or Base just now. Retrying every minute; numbers will appear as soon as they load.</div>
          </div>
        )}
        {route === 'home' && <Home net={net} />}
        {route === 'profile' && <Profile net={net} />}
      </main>
      <Footer asOfBlock={net?.asOfBlock} />
      <XWelcome net={net} />
    </>
  );
}
