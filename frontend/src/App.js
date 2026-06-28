import MorseDecoder from "@/components/MorseDecoder";
import { Toaster } from "@/components/ui/sonner";
import "@/App.css";

export default function App() {
  return (
    <>
      <MorseDecoder />
      <Toaster
        position="bottom-right"
        toastOptions={{
          style: {
            background: "#0A0A0A",
            color: "#00FF66",
            border: "1px solid #1A3324",
            borderRadius: 0,
            fontFamily: "JetBrains Mono, monospace",
            fontSize: 12,
            letterSpacing: "0.1em",
          },
        }}
      />
    </>
  );
}
