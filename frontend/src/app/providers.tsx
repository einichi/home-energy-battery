import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useReducer,
  useState,
} from "react";
import type { Dispatch, ReactNode } from "react";
import { commandReducer } from "../api/commands";
import type { CommandAction, CommandState } from "../api/commands";
import { EnergyStatusProvider } from "../hooks/useEnergyStatus";
import { I18nProvider } from "../i18n";

export type ThemePreference = "light" | "dark" | "system";
type ThemeContextValue = {
  preference: ThemePreference;
  setPreference: (preference: ThemePreference) => void;
};

const ThemeContext = createContext<ThemeContextValue | null>(null);
const CommandContext = createContext<{ state: CommandState; dispatch: Dispatch<CommandAction> } | null>(null);

function initialTheme(): ThemePreference {
  const stored = localStorage.getItem("home-energy-theme");
  return stored === "light" || stored === "dark" || stored === "system" ? stored : "system";
}

function ThemeProvider({ children }: { children: ReactNode }) {
  const [preference, setPreferenceState] = useState<ThemePreference>(initialTheme);
  const setPreference = useCallback((next: ThemePreference) => {
    localStorage.setItem("home-energy-theme", next);
    setPreferenceState(next);
  }, []);

  useEffect(() => {
    const media = window.matchMedia("(prefers-color-scheme: dark)");
    const apply = () => {
      const resolved = preference === "system" ? (media.matches ? "dark" : "light") : preference;
      document.documentElement.dataset.theme = resolved;
      document.documentElement.style.colorScheme = resolved;
      document.querySelector<HTMLMetaElement>('meta[name="theme-color"]')
        ?.setAttribute("content", resolved === "dark" ? "#101716" : "#f4f6f5");
    };
    apply();
    media.addEventListener("change", apply);
    return () => media.removeEventListener("change", apply);
  }, [preference]);

  const value = useMemo(() => ({ preference, setPreference }), [preference, setPreference]);
  return <ThemeContext.Provider value={value}>{children}</ThemeContext.Provider>;
}

function CommandProvider({ children }: { children: ReactNode }) {
  const [state, dispatch] = useReducer(commandReducer, { phase: "idle" });
  const value = useMemo(() => ({ state, dispatch }), [state]);
  return <CommandContext.Provider value={value}>{children}</CommandContext.Provider>;
}

export function useTheme() {
  const value = useContext(ThemeContext);
  if (!value) throw new Error("useTheme must be used inside AppProviders");
  return value;
}

export function useCommandLifecycle() {
  const value = useContext(CommandContext);
  if (!value) throw new Error("useCommandLifecycle must be used inside AppProviders");
  return value;
}

export function AppProviders({ children }: { children: ReactNode }) {
  return (
    <ThemeProvider>
      <CommandProvider>
        <EnergyStatusProvider><I18nProvider>{children}</I18nProvider></EnergyStatusProvider>
      </CommandProvider>
    </ThemeProvider>
  );
}
