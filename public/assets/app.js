/**
 * Progressive enhancement: instant theme switching (persisted to
 * localStorage, mirrored to the cookie the server reads) and floating
 * tooltips for elements carrying a data-tip attribute.
 *
 * Every page works without this script; it only upgrades the experience.
 */
(() => {
  const root = document.documentElement;
  const fallbackTheme = "midnight";
  const themeStorageKey = "aa-theme";
  const themeCookieName = "aa-theme";
  const themeCookieMaxAge = 60 * 60 * 24 * 365;

  root.classList.add("js-enabled");

  const themeSelect = () => {
    const select = document.getElementById("theme-select");
    return select instanceof HTMLSelectElement ? select : null;
  };

  // The server-rendered picker is the source of truth for which themes
  // exist; reading it here avoids maintaining a second list. The script is
  // deferred, so the select is already in the DOM when this runs.
  const knownThemes = (() => {
    const select = themeSelect();
    return select ? Array.from(select.options, (option) => option.value) : [fallbackTheme];
  })();

  const isTheme = (theme) => knownThemes.includes(theme);
  const normalizeTheme = (theme) => (isTheme(theme) ? theme : fallbackTheme);

  const storedTheme = () => {
    try {
      const theme = localStorage.getItem(themeStorageKey);
      return isTheme(theme) ? theme : null;
    } catch (_) {
      return null;
    }
  };

  const persistTheme = (theme) => {
    try {
      localStorage.setItem(themeStorageKey, theme);
    } catch (_) {}

    document.cookie = `${themeCookieName}=${encodeURIComponent(
      theme,
    )}; Path=/; Max-Age=${themeCookieMaxAge}; SameSite=Lax`;
  };

  const applyTheme = (theme, persist = false) => {
    const next = normalizeTheme(theme);
    root.dataset.theme = next;

    const select = themeSelect();
    if (select) select.value = next;

    if (persist) persistTheme(next);
    return next;
  };

  // Apply the stored theme immediately (before DOMContentLoaded) to avoid a
  // flash; re-persisting also keeps the cookie in sync with localStorage.
  const initialTheme = storedTheme() ?? root.dataset.theme ?? fallbackTheme;
  applyTheme(initialTheme, storedTheme() != null);

  const ready = (callback) => {
    if (document.readyState === "loading") {
      document.addEventListener("DOMContentLoaded", callback, { once: true });
    } else {
      callback();
    }
  };

  ready(() => {
    initThemePicker();
    initTooltips();
  });

  function initThemePicker() {
    const select = themeSelect();
    if (!select) return;

    applyTheme(storedTheme() ?? root.dataset.theme ?? fallbackTheme);
    select.addEventListener("change", () => applyTheme(select.value, true));
  }

  function initTooltips() {
    const triggers = Array.from(
      document.querySelectorAll(".tooltip[data-tip], .chart-entry[data-tip]"),
    );
    if (triggers.length === 0) return;

    const bubble = document.createElement("div");
    bubble.className = "floating-tooltip";
    bubble.setAttribute("role", "tooltip");
    bubble.hidden = true;
    document.body.appendChild(bubble);

    let active = null;

    const position = () => {
      if (!active) return;

      const rect = active.getBoundingClientRect();
      const bubbleRect = bubble.getBoundingClientRect();
      const margin = 8;
      const gap = 10;
      let left = rect.left + rect.width / 2 - bubbleRect.width / 2;
      const maxLeft = Math.max(margin, window.innerWidth - bubbleRect.width - margin);
      left = Math.max(margin, Math.min(left, maxLeft));

      const above = rect.top - bubbleRect.height - gap;
      const below = rect.bottom + gap;
      const fitsAbove = above >= margin;
      const fitsBelow = below + bubbleRect.height <= window.innerHeight - margin;
      const useBelow = !fitsAbove && (fitsBelow || rect.top < window.innerHeight - rect.bottom);
      const placement = useBelow ? "below" : "above";
      let top = useBelow ? below : above;
      const maxTop = Math.max(margin, window.innerHeight - bubbleRect.height - margin);
      top = Math.max(margin, Math.min(top, maxTop));

      const arrowLeft = Math.max(
        10,
        Math.min(rect.left + rect.width / 2 - left, bubbleRect.width - 10),
      );
      bubble.dataset.placement = placement;
      bubble.style.left = `${left}px`;
      bubble.style.top = `${top}px`;
      bubble.style.setProperty("--arrow-left", `${arrowLeft}px`);
    };

    const show = (target) => {
      const text = target.getAttribute("data-tip");
      if (!text) return;

      active = target;
      bubble.textContent = text;
      bubble.hidden = false;
      bubble.classList.remove("visible");
      position();
      requestAnimationFrame(() => bubble.classList.add("visible"));
    };

    const hide = () => {
      active = null;
      bubble.classList.remove("visible");
      window.setTimeout(() => {
        if (!active) bubble.hidden = true;
      }, 120);
    };

    for (const trigger of triggers) {
      // Kill the native title/<title> fallbacks so they do not double up
      // with the floating bubble.
      trigger.removeAttribute("title");
      for (const child of Array.from(trigger.children)) {
        if (child.tagName.toLowerCase() === "title") child.remove();
      }

      trigger.addEventListener("mouseenter", () => show(trigger));
      trigger.addEventListener("focus", () => show(trigger));
      trigger.addEventListener("mouseleave", hide);
      trigger.addEventListener("blur", hide);
      trigger.addEventListener("mousemove", position);
    }

    window.addEventListener("scroll", position, true);
    window.addEventListener("resize", position);
    window.visualViewport?.addEventListener("resize", position);
    window.addEventListener("keydown", (event) => {
      if (event.key === "Escape") hide();
    });
  }
})();
