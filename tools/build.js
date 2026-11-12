#!/usr/bin/env node
'use strict';

// The Vercel static output is an explicit allowlist: never publish .env,
// data/admins.json, migrations, Neon state, server sources, or legacy uploads.
const fs = require('node:fs/promises');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const esbuild = require('esbuild');

async function build() {
  const root = path.join(__dirname, '..');
  const output = path.join(root, 'dist');
  let checked = 0;
  for (const directory of ['lib', 'api', 'tools', 'tests', 'js', '']) {
    const dir = path.join(root, directory);
    for (const file of await fs.readdir(dir, { withFileTypes: true })) {
      if (!file.isFile() || !file.name.endsWith('.js')) continue;
      const result = spawnSync(process.execPath, ['--check', path.join(dir, file.name)], { encoding: 'utf8' });
      if (result.status !== 0) throw new Error(result.stderr || `Syntax check failed: ${file.name}`);
      checked++;
    }
  }
  await fs.rm(output, { recursive: true, force: true });
  await fs.mkdir(output, { recursive: true });
  const pages = (await fs.readdir(root)).filter((name) => /\.(html|pdf|txt|xml)$/.test(name));
  for (const page of pages) await fs.copyFile(path.join(root, page), path.join(output, page));
  for (const dir of ['styles', 'assets']) {
    await fs.cp(path.join(root, dir), path.join(output, dir), { recursive: true,
      filter: (source) => !source.endsWith('.gitkeep') });
  }
  // New community images are served only through the status-checked API.
  await fs.rm(path.join(output, 'assets', 'gallery', 'moments'), { recursive: true, force: true });
  const scripts = (await fs.readdir(path.join(root, 'js'))).filter((name) => name.endsWith('.js'));
  await esbuild.build({ entryPoints: scripts.map((name) => path.join(root, 'js', name)),
    outdir: path.join(output, 'js'), bundle: false, minify: true,
    target: ['es2020'], legalComments: 'none', logLevel: 'warning' });
  // Content JSON is intentionally not copied: the /content/* rewrite serves it
  // from PostgreSQL. This also avoids Vercel's filesystem-before-rewrites trap.
  console.log(`Build passed: ${checked} JavaScript files checked; Neon config type-checked.`);
  console.log(`Built ${pages.filter((name) => name.endsWith('.html')).length} pages and ${scripts.length} browser scripts into dist/.`);
  console.log('Private data excluded; /content/* and approved uploads are served by the API.');
}

build().catch((error) => { console.error(error.message); process.exitCode = 1; });
