"use strict";

const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const english = require("../src/i18n/en.js");
const russian = require("../src/i18n/ru.js");

const USER_PAGES = [
  "index.html",
  "block-palette.html",
  "bpal-viewer.html",
  "cube.html",
  "cube-bpal-sampler.html",
];
const LOCALIZED_SCRIPTS = [
  "src/pages/block-palette-page.js",
  "src/pages/bpal-viewer-page.js",
  "src/pages/cube-page.js",
  "src/pages/cube-bpal-sampler-page.js",
];

test("keeps English and Russian translation catalogs in sync", () => {
  assert.deepEqual(Object.keys(russian).sort(), Object.keys(english).sort());
});

test("defines every translation key referenced by user pages", () => {
  const root = path.resolve(__dirname, "..");
  const missing = [];

  for (const fileName of USER_PAGES) {
    const html = fs.readFileSync(path.join(root, fileName), "utf8");
    const matches = html.matchAll(/data-i18n(?:-[a-z-]+)?="([^"]+)"/g);

    assert.match(html, /<html lang="en">/, `${fileName} must default to English`);

    for (const match of matches) {
      if (english[match[1]] === undefined) {
        missing.push(`${fileName}: ${match[1]}`);
      }
    }
  }

  assert.deepEqual(missing, []);
});

test("shows the language selector only on the home page", () => {
  const root = path.resolve(__dirname, "..");
  const pagesWithSwitcher = USER_PAGES.filter((fileName) => (
    fs.readFileSync(path.join(root, fileName), "utf8").includes("data-language-switcher")
  ));

  assert.deepEqual(pagesWithSwitcher, ["index.html"]);
});

test("links the description prompt to the GitHub README", () => {
  const root = path.resolve(__dirname, "..");
  const html = fs.readFileSync(path.join(root, "index.html"), "utf8");
  const header = html.match(/<header class="home-header">([\s\S]*?)<\/header>/)[1];
  const navigation = html.match(/<nav class="demo-links"[\s\S]*?<\/nav>/)[0];

  assert.match(
    header,
    /<span class="read-description"><span data-i18n="home\.readDescriptionPrefix">Read the<\/span> <a href="https:\/\/github\.com\/Witali\/block-palette-compression\/blob\/main\/README\.md" data-i18n="home\.readDescriptionLink">description<\/a>\.<\/span>/,
  );
  assert.doesNotMatch(navigation, /github\.com\/Witali\/block-palette-compression/);
});

test("cache-busts home styles and translation catalogs", () => {
  const root = path.resolve(__dirname, "..");
  const html = fs.readFileSync(path.join(root, "index.html"), "utf8");

  assert.match(html, /href="\.\/home\.css\?v=[^"]+"/);
  assert.match(html, /src="\.\/src\/i18n\/en\.js\?v=[^"]+"/);
  assert.match(html, /src="\.\/src\/i18n\/ru\.js\?v=[^"]+"/);
});

test("defines every translation key referenced by localized page scripts", () => {
  const root = path.resolve(__dirname, "..");
  const missing = [];

  for (const fileName of LOCALIZED_SCRIPTS) {
    const source = fs.readFileSync(path.join(root, fileName), "utf8");
    const matches = source.matchAll(/\bt\(\s*["']([^"']+)["']/g);

    for (const match of matches) {
      if (english[match[1]] === undefined) {
        missing.push(`${fileName}: ${match[1]}`);
      }
    }
  }

  assert.deepEqual(missing, []);
});

function test(name, callback) {
  try {
    callback();
    console.log(`ok - ${name}`);
  } catch (error) {
    console.error(`not ok - ${name}`);
    throw error;
  }
}
