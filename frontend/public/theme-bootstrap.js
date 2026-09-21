// Resolve the theme before first paint so mobile browsers color their address
// bar from the active app theme instead of the light fallback.
(() => {
  let preference = "system";
  try {
    const stored = localStorage.getItem("home-energy-theme");
    if (stored === "light" || stored === "dark" || stored === "system") preference = stored;
  } catch {
    // Storage can be unavailable in private browsing; use the OS theme.
  }
  const resolved = preference === "system"
    ? (matchMedia("(prefers-color-scheme: dark)").matches ? "dark" : "light")
    : preference;
  document.documentElement.dataset.theme = resolved;
  document.documentElement.style.colorScheme = resolved;
  document.querySelector('meta[name="theme-color"]')
    ?.setAttribute("content", resolved === "dark" ? "#101716" : "#f4f6f5");
})();
