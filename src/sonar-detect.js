const fs = require('fs');
const path = require('path');

// Auto-discovers a SonarQube project key (and, if present, host URL) from
// files already in the repo — so setting up automatic/CI scanning needs at
// most a secret token, never a project key copy-pasted by hand. Checked in
// order of how common each is in real repos; first match wins.
//
// A token is deliberately never read from any of these files — SonarQube
// tokens aren't meant to live in version control, so that always stays a
// manual (CLI flag / CI secret / Integrations UI) input.
function parseProperties(text) {
  const result = {};
  for (const rawLine of text.split(/\r?\n/)) {
    const line = rawLine.trim();
    if (!line || line.startsWith('#') || line.startsWith('!')) continue;
    const eq = line.indexOf('=');
    if (eq === -1) continue;
    result[line.slice(0, eq).trim()] = line.slice(eq + 1).trim();
  }
  return result;
}

function fromSonarProjectProperties(dir) {
  const file = path.join(dir, 'sonar-project.properties');
  if (!fs.existsSync(file)) return null;
  try {
    const props = parseProperties(fs.readFileSync(file, 'utf8'));
    if (!props['sonar.projectKey']) return null;
    return { projectKey: props['sonar.projectKey'], hostUrl: props['sonar.host.url'] || null };
  } catch {
    return null;
  }
}

// Best-effort regex extraction (no XML/Groovy/Kotlin parser dependency) —
// good enough for the common single-line `<sonar.projectKey>x</sonar.projectKey>`
// (Maven, via sonar-maven-plugin properties) or
// `property "sonar.projectKey", "x"` (Gradle) forms.
function fromPomXml(dir) {
  const file = path.join(dir, 'pom.xml');
  if (!fs.existsSync(file)) return null;
  try {
    const xml = fs.readFileSync(file, 'utf8');
    const keyMatch = xml.match(/<sonar\.projectKey>([^<]+)<\/sonar\.projectKey>/);
    if (!keyMatch) return null;
    const urlMatch = xml.match(/<sonar\.host\.url>([^<]+)<\/sonar\.host\.url>/);
    return { projectKey: keyMatch[1].trim(), hostUrl: urlMatch ? urlMatch[1].trim() : null };
  } catch {
    return null;
  }
}

function fromGradleFile(dir, filename) {
  const file = path.join(dir, filename);
  if (!fs.existsSync(file)) return null;
  try {
    const text = fs.readFileSync(file, 'utf8');
    const keyMatch = text.match(/["']sonar\.projectKey["']\s*,\s*["']([^"']+)["']/);
    if (!keyMatch) return null;
    const urlMatch = text.match(/["']sonar\.host\.url["']\s*,\s*["']([^"']+)["']/);
    return { projectKey: keyMatch[1].trim(), hostUrl: urlMatch ? urlMatch[1].trim() : null };
  } catch {
    return null;
  }
}

function detectSonarConfig(cwd = process.cwd()) {
  return (
    fromSonarProjectProperties(cwd) ||
    fromPomXml(cwd) ||
    fromGradleFile(cwd, 'build.gradle') ||
    fromGradleFile(cwd, 'build.gradle.kts') ||
    null
  );
}

module.exports = { detectSonarConfig };
