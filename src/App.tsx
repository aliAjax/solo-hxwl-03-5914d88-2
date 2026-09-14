import "./styles.css";
import { RigProvider } from "./useRig";
import { TopBar } from "./components/TopBar";
import { Banner } from "./components/Banner";
import { ChannelCard } from "./components/ChannelCard";
import { InterlockPanel } from "./components/InterlockPanel";
import { EventStream } from "./components/EventStream";
import { TestPanel } from "./components/TestPanel";
import { CHANNEL_ORDER } from "./channels";

export default function App() {
  return (
    <RigProvider>
      <div className="app">
        <TopBar />
        <Banner />
        <div className="grid">
          {CHANNEL_ORDER.map((id) => (
            <ChannelCard key={id} id={id} />
          ))}
        </div>
        <div className="grid-2">
          <InterlockPanel />
          <EventStream />
        </div>
        <TestPanel />
      </div>
    </RigProvider>
  );
}
