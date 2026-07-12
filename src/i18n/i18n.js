(function (root) {
  "use strict";

  const DEFAULT_LANGUAGE = "en";
  const SUPPORTED_LANGUAGES = new Set(["en", "ru"]);
  const STORAGE_KEY = "webgl-example-language";
  const catalogs = root.I18nCatalogs || {};
  let language = resolveInitialLanguage();

  function resolveInitialLanguage() {
    const queryLanguage = new URLSearchParams(root.location && root.location.search || "").get("lang");

    if (SUPPORTED_LANGUAGES.has(queryLanguage)) {
      return queryLanguage;
    }

    try {
      const storedLanguage = root.localStorage && root.localStorage.getItem(STORAGE_KEY);

      if (SUPPORTED_LANGUAGES.has(storedLanguage)) {
        return storedLanguage;
      }
    } catch (error) {
      // Storage may be unavailable in privacy-restricted contexts.
    }

    return DEFAULT_LANGUAGE;
  }

  function t(key, parameters) {
    const selected = catalogs[language] || {};
    const fallback = catalogs[DEFAULT_LANGUAGE] || {};
    const template = selected[key] === undefined ? fallback[key] : selected[key];
    const text = template === undefined ? key : String(template);

    return text.replace(/\{([a-zA-Z0-9_]+)\}/g, (match, name) => (
      parameters && parameters[name] !== undefined ? String(parameters[name]) : match
    ));
  }

  function applyTranslations(container) {
    const scope = container || document;

    for (const element of scope.querySelectorAll("[data-i18n]")) {
      element.textContent = t(element.dataset.i18n);
    }

    for (const [attribute, dataName] of [
      ["title", "i18nTitle"],
      ["aria-label", "i18nAriaLabel"],
      ["placeholder", "i18nPlaceholder"],
    ]) {
      for (const element of scope.querySelectorAll(`[data-${camelToKebab(dataName)}]`)) {
        element.setAttribute(attribute, t(element.dataset[dataName]));
      }
    }

    document.documentElement.lang = language;
    const selector = document.getElementById("language-select");

    if (selector) {
      selector.value = language;
      selector.setAttribute("aria-label", t("common.language"));
    }
  }

  function camelToKebab(value) {
    return value.replace(/[A-Z]/g, (letter) => `-${letter.toLowerCase()}`);
  }

  function setLanguage(nextLanguage) {
    if (!SUPPORTED_LANGUAGES.has(nextLanguage) || nextLanguage === language) {
      return;
    }

    language = nextLanguage;

    try {
      if (root.localStorage) {
        root.localStorage.setItem(STORAGE_KEY, language);
      }
    } catch (error) {
      // The selected language still applies for the current page.
    }

    applyTranslations();
    root.dispatchEvent(new CustomEvent("languagechange", { detail: { language } }));
  }

  function createLanguageSwitcher() {
    if (!document.body.hasAttribute("data-language-switcher") || document.getElementById("language-select")) {
      return;
    }

    const label = document.createElement("label");
    const select = document.createElement("select");

    label.className = "language-switcher";
    select.id = "language-select";
    select.innerHTML = '<option value="en">EN</option><option value="ru">RU</option>';
    select.value = language;
    select.setAttribute("aria-label", t("common.language"));
    select.addEventListener("change", () => setLanguage(select.value));
    label.append(select);
    document.body.append(label);
  }

  function formatNumber(value, options) {
    return new Intl.NumberFormat(language === "ru" ? "ru-RU" : "en-US", options).format(value);
  }

  root.I18n = {
    applyTranslations,
    formatNumber,
    getLanguage: () => language,
    setLanguage,
    t,
  };

  createLanguageSwitcher();
  applyTranslations();
})(typeof self !== "undefined" ? self : globalThis);
