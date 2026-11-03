import { fileURLToPath } from "node:url";

/**
 * Every stylesheet and script the dashboard loads, and which tier may fetch each
 *
 * An allow-list served by name, rather than a static mount over views/dashboard/: that
 * directory also holds the templates, and a mount would serve them as text. In the order the
 * page loads them - Chart.js, then core, because every file after them reads what they define;
 * main.js last, because it drives the tabs the others register. Chart.js is served out of its
 * package, a runtime dependency the deployment already carries, rather than copied in beside
 * the page's own files.
 */
export const DASHBOARD_ASSETS = Object.freeze({
  'core.css': { file: 'views/dashboard/core.css', operator: false },
  'ops.css': { file: 'views/dashboard/ops.css', operator: true },
  'mine.css': { file: 'views/dashboard/mine.css', operator: false },
  'collective.css': { file: 'views/dashboard/collective.css', operator: false },
  'chart.js': { file: 'node_modules/chart.js/dist/chart.umd.min.js', operator: false },
  'core.js': { file: 'views/dashboard/core.js', operator: false },
  'ops.js': { file: 'views/dashboard/ops.js', operator: true },
  'mine.js': { file: 'views/dashboard/mine.js', operator: false },
  'collective.js': { file: 'views/dashboard/collective.js', operator: false },
  'main.js': { file: 'views/dashboard/main.js', operator: false },
});

/**
 * What one tier's page links, in load order: the only list the template iterates
 * @param {boolean} operator - The operator tier gets the Operations tab's two files as well
 * @returns {{styles: Array<string>, scripts: Array<string>}} Asset names
 */
export const assetsFor = (operator) => {
  const names = Object.keys(DASHBOARD_ASSETS).filter((name) => operator || !DASHBOARD_ASSETS[name].operator);

  return {
    styles: names.filter((name) => name.endsWith('.css')),
    scripts: names.filter((name) => name.endsWith('.js')),
  };
};

/**
 * Serve one of them, behind the page's own gate
 *
 * A reader asking for the Operations tab's files gets exactly what a name nobody serves gets:
 * next('route'), and the app's plain 404. Neither says the file exists.
 *
 * no-cache rather than no-store: revalidated on every load, so a deploy is picked up at once,
 * and private, because what is behind this gate is not for a shared cache.
 */
export function handleGetDashboardAsset(req, res, next) {
  const asset = Object.hasOwn(DASHBOARD_ASSETS, req.params.name) ? DASHBOARD_ASSETS[req.params.name] : null;

  if (!asset || (asset.operator && !req.isOperator)) {
    next('route');
    return;
  }

  res.set('Cache-Control', 'private, no-cache');
  res.sendFile(fileURLToPath(new URL(`../../${asset.file}`, import.meta.url)));
}
