(function () {
  var root = document.documentElement;
  var toggle = document.getElementById("theme-toggle");
  var storageKey = "ohfog-theme";

  function storedTheme() {
    try {
      var value = localStorage.getItem(storageKey);
      return value === "light" || value === "dark" ? value : "auto";
    } catch (error) {
      return "auto";
    }
  }

  function setStoredTheme(theme) {
    try {
      if (theme === "auto") {
        localStorage.removeItem(storageKey);
      } else {
        localStorage.setItem(storageKey, theme);
      }
    } catch (error) {
      return;
    }
  }

  function applyTheme(theme) {
    root.dataset.theme = theme;

    if (!toggle) {
      return;
    }

    var label = theme === "auto" ? "system" : theme;
    toggle.textContent = "theme: " + label;
    toggle.setAttribute("aria-pressed", theme === "auto" ? "false" : "true");
    toggle.setAttribute("aria-label", "Theme: " + label + ". Activate to change theme.");
  }

  function nextTheme(theme) {
    if (theme === "auto") {
      return "light";
    }

    if (theme === "light") {
      return "dark";
    }

    return "auto";
  }

  applyTheme(storedTheme());

  if (toggle) {
    toggle.addEventListener("click", function () {
      var theme = nextTheme(root.dataset.theme || "auto");
      setStoredTheme(theme);
      applyTheme(theme);
    });
  }
})();
